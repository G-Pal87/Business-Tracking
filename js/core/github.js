// GitHub API layer — direct calls from the frontend using a PAT stored in db.json.
import { state } from './state.js';

const DB_LS_KEY  = 'bt_db_cache';
const CFG_LS_KEY = 'bt_github_config';

let pushQueue = Promise.resolve();

// ── Config ───────────────────────────────────────────────────────────────────

export function loadConfig() {
  try {
    const cfg = JSON.parse(localStorage.getItem(CFG_LS_KEY) || '{}');
    state.github.owner  = cfg.owner  || '';
    state.github.repo   = cfg.repo   || '';
    state.github.branch = cfg.branch || 'main';
    state.github.dbPath = cfg.path   || 'data/db.json';
    state.github.token  = cfg.token  || '';
  } catch { /* ignore */ }
}

// Called after db.json is loaded — overrides state.github with db.appConfig.github
// and caches the result to localStorage for next-load bootstrap.
export function applyDbConfig(ghCfg) {
  if (!ghCfg) return;
  if (ghCfg.owner)  state.github.owner  = ghCfg.owner;
  if (ghCfg.repo)   state.github.repo   = ghCfg.repo;
  if (ghCfg.branch) state.github.branch = ghCfg.branch;
  if (ghCfg.path)   state.github.dbPath = ghCfg.path;
  if (ghCfg.token)  state.github.token  = ghCfg.token;
  try {
    localStorage.setItem(CFG_LS_KEY, JSON.stringify({
      owner:  state.github.owner,
      repo:   state.github.repo,
      branch: state.github.branch,
      path:   state.github.dbPath,
      token:  state.github.token
    }));
  } catch { /* ignore */ }
}

export function saveConfig({ owner, repo, branch, dbPath, token }) {
  state.github.owner  = owner  || '';
  state.github.repo   = repo   || '';
  state.github.branch = branch || 'main';
  state.github.dbPath = dbPath || 'data/db.json';
  if (token !== undefined) state.github.token = token || '';
  try {
    localStorage.setItem(CFG_LS_KEY, JSON.stringify({
      owner:  state.github.owner,
      repo:   state.github.repo,
      branch: state.github.branch,
      path:   state.github.dbPath,
      token:  state.github.token
    }));
  } catch { /* ignore */ }
}

export function clearConfig() {
  state.github.token         = '';
  state.github.owner         = '';
  state.github.repo          = '';
  state.github.branch        = 'main';
  state.github.dbPath        = 'data/db.json';
  state.github.sha           = null;
  state.github.connected     = false;
  state.github.remoteDb      = null;
  state.github.lastPullOk    = false;
  state.github.lastPushOk    = false;
  state.github.usingCache    = false;
  state.github.lastSyncError = null;
  state.github.lastPulledAt  = null;
  state.github.lastPushedAt  = null;
  state.github.syncNow       = null;
  try { localStorage.removeItem(CFG_LS_KEY); } catch { /* ignore */ }
}

// ── Fetch db.json ─────────────────────────────────────────────────────────────

function b64decode(str) {
  return decodeURIComponent(escape(atob(str.replace(/\s/g, ''))));
}

function b64encode(str) {
  return btoa(unescape(encodeURIComponent(str)));
}

function safeParseDb(content) {
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('GitHub returned empty content for db.json');
  }
  try { return JSON.parse(content); }
  catch (e) { throw new Error(`db.json contains invalid JSON: ${e.message}`); }
}

export async function fetchDb() {
  const { owner, repo, branch, dbPath, token } = state.github;
  if (!owner || !repo) throw new Error('GitHub not configured');

  const headers = { 'Accept': 'application/vnd.github+json' };
  if (token) headers['Authorization'] = `token ${token}`;

  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${dbPath}?ref=${encodeURIComponent(branch || 'main')}`;
  let res;
  try { res = await fetch(url, { headers, cache: 'no-store' }); }
  catch { throw new Error('Cannot reach GitHub — check your internet connection'); }

  if (!res.ok) {
    if (res.status === 404) throw new Error('db.json not found in repo. Create data/db.json first.');
    if (res.status === 401) throw new Error('GitHub auth failed — check your token');
    if (res.status === 403) throw new Error('GitHub access denied — check token permissions');
    throw new Error(`GitHub fetch failed (${res.status})`);
  }

  const data = await res.json();
  const { sha, content, download_url } = data;

  let parsed;
  if (content) {
    parsed = safeParseDb(b64decode(content));
  } else if (download_url) {
    const raw = await fetch(download_url).then(r => {
      if (!r.ok) throw new Error(`Download failed (${r.status})`);
      return r.text();
    });
    parsed = safeParseDb(raw);
  } else {
    throw new Error('GitHub returned no content');
  }

  state.github.sha           = sha;
  state.github.connected     = true;
  state.github.lastPullOk    = true;
  state.github.usingCache    = false;
  state.github.lastPulledAt  = Date.now();
  state.github.lastSyncError = null;
  state.github.remoteDb      = structuredClone(parsed);
  return parsed;
}

// ── Push db.json ──────────────────────────────────────────────────────────────

export async function pushDb(message = 'Update data') {
  pushQueue = pushQueue.catch(() => null).then(() => doPushDb(message));
  return pushQueue;
}

async function doPushDb(message = 'Update data') {
  const { owner, repo, branch, dbPath, token } = state.github;
  if (!owner || !repo) throw new Error('GitHub not configured');
  if (!token) throw new Error('GitHub token not configured — add it in Settings');

  const apiBase  = `https://api.github.com/repos/${owner}/${repo}/contents/${dbPath}`;
  const ghHeaders = {
    'Accept':        'application/vnd.github+json',
    'Authorization': `token ${token}`,
    'Content-Type':  'application/json'
  };

  const snapshot = structuredClone(state.db);
  const base     = state.github.remoteDb ? structuredClone(state.github.remoteDb) : null;
  let   lastError = null;

  for (let attempt = 1; attempt <= 5; attempt++) {
    // GET current SHA + content
    let getRes;
    try {
      getRes = await fetch(`${apiBase}?ref=${encodeURIComponent(branch || 'main')}`, {
        headers: ghHeaders, cache: 'no-store'
      });
    } catch {
      if (attempt < 5) { await sleep(500 * attempt); continue; }
      throw new Error('Cannot reach GitHub');
    }

    if (!getRes.ok) {
      if (getRes.status === 401 || getRes.status === 403) throw new Error('GitHub auth failed — check your token');
      throw new Error(`GitHub fetch failed (${getRes.status})`);
    }

    const getData = await getRes.json();
    const { sha } = getData;
    let freshDb;
    if (getData.content) {
      freshDb = safeParseDb(b64decode(getData.content));
    } else if (getData.download_url) {
      const raw = await fetch(getData.download_url).then(r => {
        if (!r.ok) throw new Error(`Download failed (${r.status})`);
        return r.text();
      });
      freshDb = safeParseDb(raw);
    } else {
      throw new Error('GitHub returned no content for db.json');
    }
    const merged  = mergeDb(freshDb, snapshot, base);

    // PUT merged content
    let putRes;
    try {
      putRes = await fetch(apiBase, {
        method: 'PUT',
        headers: ghHeaders,
        body: JSON.stringify({
          message,
          content: b64encode(JSON.stringify(merged, null, 2)),
          branch:  branch || 'main',
          sha
        })
      });
    } catch {
      if (attempt < 5) { await sleep(500 * attempt); continue; }
      throw new Error('Cannot reach GitHub');
    }

    if (putRes.status === 409 && attempt < 5) {
      lastError = 'SHA conflict';
      await sleep(500 * attempt);
      continue;
    }

    if (!putRes.ok) {
      if (putRes.status === 401 || putRes.status === 403) throw new Error('Token lacks write access');
      throw new Error(`Push failed (${putRes.status})`);
    }

    const newSha = (await putRes.json()).content.sha;

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
  const cols   = new Set([...Object.keys(remoteDb || {}), ...Object.keys(localCache || {})]);
  const result = {};

  for (const col of cols) {
    const remote = remoteDb[col];
    const local  = localCache[col];

    if (!Array.isArray(remote) || !Array.isArray(local)) {
      // Non-array fields (settings, appConfig): local is the authoritative version
      // because it holds the user's latest changes. Remote wins only when local has no value.
      result[col] = local !== undefined ? local : remote;
      continue;
    }

    // Seed from local — it holds all recent user actions (soft-deletes, edits, permanent deletes).
    const merged = new Map(local.map(x => [x.id, x]));

    // Add remote-only items that are still active (created on another device).
    // Skip remote soft-deleted records: if they're absent from local the user permanently deleted them.
    for (const item of remote) {
      if (!merged.has(item.id) && !item.deletedAt) {
        merged.set(item.id, item);
      }
    }

    result[col] = [...merged.values()];
  }

  return result;
}

export function saveLocalCache(db) {
  try { localStorage.setItem(DB_LS_KEY, JSON.stringify(db)); }
  catch (e) { console.warn(e); }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
