// GitHub API layer — all calls are proxied through the backend server.
// The PAT is stored server-side only; the browser never sees it.
import { state } from './state.js';

const DB_LS_KEY = 'bt_db_cache';

let pushQueue = Promise.resolve();

// ── Config ───────────────────────────────────────────────────────────────────

export async function loadConfig() {
  try {
    const res = await fetch('/api/github/config');
    if (res.ok) {
      const cfg = await res.json();
      state.github.owner          = cfg.owner  || '';
      state.github.repo           = cfg.repo   || '';
      state.github.branch         = cfg.branch || 'main';
      state.github.dbPath         = cfg.dbPath || 'data/db.json';
      state.github.tokenConfigured = !!cfg.tokenConfigured;
    }
  } catch (e) {
    console.warn('loadConfig', e);
  }
}

// Save GitHub config to the server (admin only — requires credentials).
// adminCreds: { username, passwordHash }  (passwordHash = SHA-256 hex of password)
export async function saveConfig({ owner, repo, branch, dbPath, token, adminCreds }) {
  const headers = { 'Content-Type': 'application/json' };
  if (adminCreds?.username && adminCreds?.passwordHash) {
    headers['Authorization'] = 'Bearer ' +
      btoa(JSON.stringify({ username: adminCreds.username, passwordHash: adminCreds.passwordHash }));
  }

  const res = await fetch('/api/github/config', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      owner:  owner  || '',
      repo:   repo   || '',
      branch: branch || 'main',
      dbPath: dbPath || 'data/db.json',
      ...(token ? { token } : {})
    })
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Config save failed (${res.status})`);
  }

  const cfg = await res.json();
  state.github.owner           = cfg.owner;
  state.github.repo            = cfg.repo;
  state.github.branch          = cfg.branch;
  state.github.dbPath          = cfg.dbPath;
  state.github.tokenConfigured = cfg.tokenConfigured;
  return cfg;
}

export function clearConfig() {
  // Reset in-memory state. The server config is managed via POST /api/github/config.
  state.github.owner           = '';
  state.github.repo            = '';
  state.github.branch          = 'main';
  state.github.dbPath          = 'data/db.json';
  state.github.tokenConfigured = false;
  state.github.sha             = null;
  state.github.connected       = false;
  state.github.remoteDb        = null;
  state.github.lastPullOk      = false;
  state.github.lastPushOk      = false;
  state.github.usingCache      = false;
  state.github.lastSyncError   = null;
  state.github.lastPulledAt    = null;
  state.github.lastPushedAt    = null;
  state.github.syncNow         = null;
}

export async function testConnection(adminCreds) {
  const headers = {};
  if (adminCreds?.username && adminCreds?.passwordHash) {
    headers['Authorization'] = 'Bearer ' +
      btoa(JSON.stringify({ username: adminCreds.username, passwordHash: adminCreds.passwordHash }));
  }
  const res = await fetch('/api/github/test', { method: 'POST', headers });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Test failed (${res.status})`);
  return body;
}

// ── Fetch db.json ─────────────────────────────────────────────────────────────

// Decode base64 returned by GET /api/db (server re-encodes large files too)
function b64decode(str) {
  return decodeURIComponent(escape(atob(str.replace(/\s/g, ''))));
}

function b64encode(str) {
  return btoa(unescape(encodeURIComponent(str)));
}

function safeParseDb(content) {
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('Server returned empty content for db.json');
  }
  try { return JSON.parse(content); }
  catch (e) { throw new Error(`db.json contains invalid JSON: ${e.message}`); }
}

export async function fetchDb() {
  let res;
  try { res = await fetch('/api/db', { cache: 'no-store' }); }
  catch { throw new Error('Cannot reach server — is it running?'); }

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    if (res.status === 503) throw new Error('GitHub not configured on server — set it up in admin settings');
    if (res.status === 404) throw new Error('db.json not found in repo. Create data/db.json first.');
    if (res.status === 401) throw new Error(err.error || 'GitHub auth failed — update token in admin settings');
    throw new Error(err.error || `GitHub fetch failed (${res.status})`);
  }

  const { sha, content } = await res.json();
  const parsed = safeParseDb(b64decode(content));

  state.github.sha          = sha;
  state.github.connected    = true;
  state.github.lastPullOk   = true;
  state.github.usingCache   = false;
  state.github.lastPulledAt = Date.now();
  state.github.lastSyncError = null;
  state.github.remoteDb     = structuredClone(parsed);
  return parsed;
}

// ── Push db.json ──────────────────────────────────────────────────────────────

export async function pushDb(message = 'Update data') {
  pushQueue = pushQueue.catch(() => null).then(() => doPushDb(message));
  return pushQueue;
}

async function doPushDb(message = 'Update data') {
  const { owner, repo } = state.github;
  if (!owner || !repo) throw new Error('GitHub not configured');
  if (!state.github.tokenConfigured) throw new Error('GitHub token not configured — set it in admin settings');

  const snapshot = structuredClone(state.db);
  const base     = state.github.remoteDb ? structuredClone(state.github.remoteDb) : null;
  let   lastError = null;

  for (let attempt = 1; attempt <= 5; attempt++) {
    // GET current SHA + content
    let getRes;
    try { getRes = await fetch('/api/db', { cache: 'no-store' }); }
    catch {
      if (attempt < 5) { await sleep(500 * attempt); continue; }
      throw new Error('Cannot reach server');
    }

    if (!getRes.ok) {
      const err = await getRes.json().catch(() => ({}));
      if (getRes.status === 401) throw new Error(err.error || 'GitHub auth failed — update token in admin settings');
      throw new Error(err.error || `Server fetch failed (${getRes.status})`);
    }

    const { sha, content } = await getRes.json();
    const freshDb = safeParseDb(b64decode(content));
    const merged  = mergeDb(freshDb, snapshot, base);

    // PUT merged content
    let putRes;
    try {
      putRes = await fetch('/api/db', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: b64encode(JSON.stringify(merged, null, 2)),
          message,
          sha
        })
      });
    } catch {
      if (attempt < 5) { await sleep(500 * attempt); continue; }
      throw new Error('Cannot reach server');
    }

    if (putRes.status === 409 && attempt < 5) {
      lastError = 'SHA conflict';
      await sleep(500 * attempt);
      continue;
    }

    if (!putRes.ok) {
      const err = await putRes.json().catch(() => ({}));
      if (putRes.status === 401) throw new Error('Token lacks write access — update in admin settings');
      throw new Error(err.error || `Push failed (${putRes.status})`);
    }

    const { sha: newSha } = await putRes.json();

    state.github.sha          = newSha;
    state.github.remoteDb     = structuredClone(merged);
    state.github.lastPushOk   = true;
    state.github.lastPushedAt = Date.now();
    state.github.lastSyncError = null;
    state.github.connected    = true;
    state.github.usingCache   = false;

    // Adopt remote-only additions, but never re-add items permanently deleted
    // during this push (items that were in snapshot but are now gone from state.db).
    const permanentlyDeletedDuringPush = new Set();
    for (const [col, items] of Object.entries(snapshot)) {
      if (!Array.isArray(items)) continue;
      const currentIds = new Set((state.db[col] || []).map(x => x.id));
      for (const item of items) {
        if (!currentIds.has(item.id)) permanentlyDeletedDuringPush.add(`${col}:${item.id}`);
      }
    }

    for (const [col, items] of Object.entries(merged)) {
      if (!Array.isArray(items) || !Array.isArray(state.db[col])) continue;
      const localIds = new Set(state.db[col].map(x => x.id));
      for (const item of items) {
        if (!localIds.has(item.id) && !permanentlyDeletedDuringPush.has(`${col}:${item.id}`)) {
          state.db[col].push(item);
        }
      }
    }

    saveLocalCache(state.db);
    return { sha: newSha };
  }

  throw new Error(`Push failed after retries: ${lastError || 'conflict'}`);
}

// ── Three-way merge ───────────────────────────────────────────────────────────

function mergeDb(freshRemote, localCurrent, lastSynced) {
  const result    = {};
  const conflicts = [];
  const cols = new Set([
    ...Object.keys(freshRemote  || {}),
    ...Object.keys(localCurrent || {})
  ]);

  for (const col of cols) {
    const fresh = freshRemote[col];
    const local = localCurrent[col];
    const base  = lastSynced ? lastSynced[col] : undefined;

    if (!Array.isArray(local) || !Array.isArray(fresh)) {
      result[col] = local !== undefined ? local : fresh;
      continue;
    }

    const baseMap  = new Map((Array.isArray(base) ? base : []).map(x => [x.id, x]));
    const localMap = new Map(local.map(x => [x.id, x]));
    const merged   = new Map(fresh.map(x => [x.id, x]));

    for (const item of local) {
      const remoteItem = merged.get(item.id);
      const baseItem   = baseMap.get(item.id);
      if (
        remoteItem && baseItem &&
        item.updatedAt && remoteItem.updatedAt && baseItem.updatedAt &&
        item.updatedAt !== baseItem.updatedAt &&
        remoteItem.updatedAt !== baseItem.updatedAt
      ) {
        conflicts.push({ collection: col, id: item.id });
        continue;
      }
      merged.set(item.id, item);
    }

    for (const id of baseMap.keys()) {
      if (!localMap.has(id)) merged.delete(id);
    }

    result[col] = [...merged.values()];
  }

  if (conflicts.length > 0) {
    const err = new Error('Concurrent edit conflict — another user modified the same records');
    err.name      = 'ConflictError';
    err.conflicts = conflicts;
    throw err;
  }

  return result;
}

// ── Local cache ───────────────────────────────────────────────────────────────

export async function fetchLocalDb() {
  const cached = localStorage.getItem(DB_LS_KEY);
  if (cached) {
    try { return JSON.parse(cached); } catch { /* corrupt, fall through */ }
  }
  try {
    const res = await fetch('data/db.json', { cache: 'no-store' });
    if (res.ok) return await res.json();
  } catch { /* ignore */ }
  return null;
}

export function mergeLocalPending(remoteDb, localCache) {
  const cols    = new Set([...Object.keys(remoteDb || {}), ...Object.keys(localCache || {})]);
  let   changed = false;
  const result  = {};

  for (const col of cols) {
    const remote = remoteDb[col];
    const local  = localCache[col];

    if (!Array.isArray(remote) || !Array.isArray(local)) {
      result[col] = remote !== undefined ? remote : local;
      continue;
    }

    const merged = new Map(remote.map(x => [x.id, x]));
    for (const item of local) {
      if (!merged.has(item.id)) { merged.set(item.id, item); changed = true; }
    }
    result[col] = [...merged.values()];
  }

  return changed ? result : remoteDb;
}

export function saveLocalCache(db) {
  try { localStorage.setItem(DB_LS_KEY, JSON.stringify(db)); }
  catch (e) { console.warn(e); }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
