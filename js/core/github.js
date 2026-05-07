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
  try {
    // Strip embedded PDF data before caching — prevents QuotaExceededError.
    // Invoices imported after the migration store only pdfPath, but older records
    // may still have pdfData until the one-time migration runs.
    const safe = { ...db };
    if (Array.isArray(safe.invoices)) {
      safe.invoices = safe.invoices.map(({ pdfData, ...rest }) => rest);
    }
    localStorage.setItem(DB_LS_KEY, JSON.stringify(safe));
  }
  catch (e) { console.warn('saveLocalCache:', e); }
}

// ── File storage (invoice PDFs, etc.) ────────────────────────────────────────

/**
 * Upload or replace a file in the GitHub repo.
 * @param {string} path       - repo-relative path, e.g. "invoices/inv_abc.pdf"
 * @param {string} b64Content - base64-encoded file content (no data-URL prefix)
 * @param {string} message    - commit message
 * @returns {Promise<{sha: string}>}
 */
export async function uploadGithubFile(path, b64Content, message = 'Upload file') {
  const { owner, repo, branch, token } = state.github;
  if (!owner || !repo || !token) throw new Error('GitHub not configured — add owner/repo/token in Settings');

  // Normalise path: strip any accidental leading slash so files always land
  // inside their intended folder, not the repo root.
  const cleanPath = path.replace(/^\/+/, '');

  const headers = {
    'Accept':        'application/vnd.github+json',
    'Authorization': `token ${token}`,
    'Content-Type':  'application/json'
  };
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${cleanPath}`;

  // Check if the file already exists so we can include its SHA (required for
  // updates). A 404 here means the file doesn't exist yet — that is expected
  // for new files and handled by omitting the sha field from the PUT body.
  // GitHub creates parent directories automatically, so a missing folder is
  // never an error here.
  let existingSha = null;
  try {
    const check = await fetch(`${apiUrl}?ref=${encodeURIComponent(branch || 'main')}`, { headers, cache: 'no-store' });
    if (check.ok) {
      const d = await check.json();
      existingSha = d.sha;
    }
    // 404 → file does not exist yet; proceed to create without sha
  } catch { /* network error during existence check — proceed anyway */ }

  const body = { message, content: b64Content, branch: branch || 'main' };
  if (existingSha) body.sha = existingSha;

  const res = await fetch(apiUrl, { method: 'PUT', headers, body: JSON.stringify(body) });
  if (!res.ok) {
    let errBody = '';
    try { errBody = await res.text(); } catch { /* ignore */ }
    console.error(`GitHub file upload failed (${res.status}) for path "${cleanPath}":`, errBody);
    if (res.status === 401 || res.status === 403) throw new Error('Token lacks write access');
    if (res.status === 404) throw new Error(`Repository or branch not found (404). Check owner/repo/branch settings. Path: ${cleanPath}`);
    throw new Error(`File upload failed (${res.status}): ${errBody}`);
  }
  const data = await res.json();
  return { sha: data.content.sha };
}

/**
 * List files directly inside a folder in the GitHub repo.
 * Returns an empty array if the folder does not exist (404).
 * Subdirectories are excluded; only immediate file children are returned.
 * @param {string} folderPath - repo-relative path, e.g. "invoices"
 * @returns {Promise<Array<{name: string, path: string, sha: string, size: number}>>}
 */
export async function listGithubFolder(folderPath) {
  const { owner, repo, branch, token } = state.github;
  if (!owner || !repo) throw new Error('GitHub not configured');

  const headers = { 'Accept': 'application/vnd.github+json' };
  if (token) headers['Authorization'] = `token ${token}`;

  const cleanPath = folderPath.replace(/^\/+|\/+$/g, '');
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/${cleanPath}?ref=${encodeURIComponent(branch || 'main')}`,
    { headers, cache: 'no-store' }
  );
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`Folder listing failed (${res.status})`);
  const data = await res.json();
  return Array.isArray(data) ? data.filter(f => f.type === 'file') : [];
}

/**
 * Fetch metadata + base64 content of a file from the GitHub repo.
 * @param {string} path - repo-relative path
 * @returns {Promise<{content: string, sha: string, download_url: string}>}
 */
export async function fetchGithubFile(path) {
  const { owner, repo, branch, token } = state.github;
  if (!owner || !repo) throw new Error('GitHub not configured');

  const headers = { 'Accept': 'application/vnd.github+json' };
  if (token) headers['Authorization'] = `token ${token}`;

  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(branch || 'main')}`,
    { headers, cache: 'no-store' }
  );
  if (!res.ok) {
    if (res.status === 404) throw new Error('File not found in repository');
    if (res.status === 401 || res.status === 403) throw new Error('GitHub auth failed — check your token');
    throw new Error(`File fetch failed (${res.status})`);
  }
  return res.json(); // { content (b64), sha, download_url, ... }
}

/**
 * Delete a file from the GitHub repo.
 * Silently succeeds if the file is already gone (404).
 * @param {string} path    - repo-relative path
 * @param {string} sha     - blob SHA (from a prior fetchGithubFile call); if unknown pass null and we'll look it up
 * @param {string} message - commit message
 */
export async function deleteGithubFile(path, sha = null, message = 'Delete file') {
  const { owner, repo, branch, token } = state.github;
  if (!owner || !repo || !token) throw new Error('GitHub not configured');

  const headers = {
    'Accept':        'application/vnd.github+json',
    'Authorization': `token ${token}`,
    'Content-Type':  'application/json'
  };
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;

  // Resolve SHA if caller didn't provide one
  if (!sha) {
    try {
      const check = await fetch(`${apiUrl}?ref=${encodeURIComponent(branch || 'main')}`, { headers, cache: 'no-store' });
      if (!check.ok) return; // already gone
      const d = await check.json();
      sha = d.sha;
    } catch { return; }
  }

  const res = await fetch(apiUrl, {
    method:  'DELETE',
    headers,
    body:    JSON.stringify({ message, sha, branch: branch || 'main' })
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`File delete failed (${res.status})`);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
