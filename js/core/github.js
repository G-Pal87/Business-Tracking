// GitHub API layer - read/write db.json to a GitHub repo
import { state } from './state.js';

const GH = 'https://api.github.com';
const FILE_PATH = 'data/db.json';
const LS_KEY = 'bt_github_config';
const DB_LS_KEY = 'bt_db_cache';

let pushQueue = Promise.resolve();

export function loadConfig() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const cfg = JSON.parse(raw);
      if (cfg.token) cfg.token = cfg.token.trim();
      Object.assign(state.github, cfg);
    }
  } catch (e) {
    console.warn('loadConfig', e);
  }
}

export function saveConfig({ token, owner, repo, branch }) {
  state.github.token = token || '';
  state.github.owner = owner || '';
  state.github.repo = repo || '';
  state.github.branch = branch || 'main';

  localStorage.setItem(
    LS_KEY,
    JSON.stringify({
      token: state.github.token,
      owner: state.github.owner,
      repo: state.github.repo,
      branch: state.github.branch
    })
  );
}

export function clearConfig() {
  localStorage.removeItem(LS_KEY);
  state.github = {
    token: '', owner: '', repo: '', branch: 'main',
    sha: null, connected: false, remoteDb: null,
    lastPullOk: false, lastPushOk: false, usingCache: false,
    lastSyncError: null, lastPulledAt: null, lastPushedAt: null,
    syncNow: null
  };
}

function headers() {
  const h = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  };

  if (state.github.token) {
    h.Authorization = `Bearer ${state.github.token}`;
  }

  return h;
}

function b64encode(str) {
  return btoa(unescape(encodeURIComponent(str)));
}

function b64decode(str) {
  return decodeURIComponent(escape(atob(str.replace(/\s/g, ''))));
}

// Validate and parse db.json content — throws a clear error instead of
// letting JSON.parse produce "Unexpected end of JSON input" on empty input.
function safeParseDb(content) {
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('GitHub returned empty content for db.json');
  }
  try {
    return JSON.parse(content);
  } catch (e) {
    throw new Error(`db.json contains invalid JSON: ${e.message}`);
  }
}

export async function fetchDb() {
  const { owner, repo, branch } = state.github;

  if (!owner || !repo) {
    throw new Error('GitHub repo not configured');
  }

  const br = branch || 'main';
  const apiUrl = `${GH}/repos/${owner}/${repo}/contents/${FILE_PATH}?ref=${br}`;

  let res;
  let apiOk = false;

  try {
    res = await fetch(apiUrl, { headers: headers() });
    apiOk = true;
  } catch {
    // fetch() threw — most likely a CORS preflight failure caused by the GitHub API
    // redirecting to raw.githubusercontent.com while carrying custom headers
    // (X-GitHub-Api-Version triggers a preflight that raw.githubusercontent.com rejects).
    // Fall through to the no-auth raw fallback below.
  }

  if (apiOk) {
    if (!res.ok) {
      if (res.status === 404) {
        throw new Error('db.json not found in repo. Make sure data/db.json exists.');
      }
      if (res.status === 401 || res.status === 403) {
        throw new Error(`GitHub auth failed (${res.status}) — check your token in Settings`);
      }
      throw new Error(`GitHub API error ${res.status}: ${res.statusText}`);
    }

    const json = await res.json();

    state.github.sha = json.sha;
    state.github.connected  = true;
    state.github.lastPullOk = true;
    state.github.usingCache = false;
    state.github.lastPulledAt  = Date.now();
    state.github.lastSyncError = null;

    if (json.content && json.encoding === 'base64') {
      // Normal path: file ≤ 1 MB, content is inline base64.
      const parsed = safeParseDb(b64decode(json.content));
      state.github.remoteDb = structuredClone(parsed);
      return parsed;
    }

    // Content not inline (file > 1 MB or API omitted it).
    // Fetch download_url WITHOUT auth headers — raw.githubusercontent.com does not
    // support Authorization or X-GitHub-Api-Version through CORS preflight.
    const downloadUrl = json.download_url ||
      `https://raw.githubusercontent.com/${owner}/${repo}/${br}/${FILE_PATH}`;
    try {
      const rawRes = await fetch(downloadUrl, { cache: 'no-store' }); // no auth headers
      if (!rawRes.ok) throw new Error(`HTTP ${rawRes.status}`);
      const parsed = safeParseDb(await rawRes.text());
      state.github.remoteDb = structuredClone(parsed);
      return parsed;
    } catch (err) {
      throw new Error(`Cannot download db.json content: ${err.message}`);
    }
  }

  // API fetch failed entirely (CORS or network). For public repos, try fetching
  // the raw file directly without any auth headers, which avoids the CORS preflight.
  const rawFallbackUrl =
    `https://raw.githubusercontent.com/${owner}/${repo}/${br}/${FILE_PATH}`;
  let rawRes;
  try {
    rawRes = await fetch(rawFallbackUrl, { cache: 'no-store' }); // no auth headers
  } catch {
    throw new Error('Cannot reach GitHub — check your internet connection');
  }

  if (!rawRes.ok) {
    // raw.githubusercontent.com returned an error — could be private repo or bad config.
    throw new Error(
      `Cannot load db.json (API CORS error, raw fallback ${rawRes.status}) — ` +
      `verify your GitHub token and that the repo is accessible`
    );
  }

  // SHA unavailable without the API response; doPushDb always refreshes it before PUT.
  const parsed = safeParseDb(await rawRes.text());
  state.github.connected  = true;
  state.github.lastPullOk = true;
  state.github.usingCache = false;
  state.github.lastPulledAt  = Date.now();
  state.github.lastSyncError = null;
  state.github.remoteDb = structuredClone(parsed);
  return parsed;
}

function mergeDb(freshRemote, localCurrent, lastSynced) {
  const result = {};
  const conflicts = [];
  const cols = new Set([
    ...Object.keys(freshRemote || {}),
    ...Object.keys(localCurrent || {})
  ]);

  for (const col of cols) {
    const fresh = freshRemote[col];
    const local = localCurrent[col];
    const base = lastSynced ? lastSynced[col] : undefined;

    if (!Array.isArray(local) || !Array.isArray(fresh)) {
      result[col] = local !== undefined ? local : fresh;
      continue;
    }

    const baseMap = new Map((Array.isArray(base) ? base : []).map(x => [x.id, x]));
    const localMap = new Map(local.map(x => [x.id, x]));
    const merged = new Map(fresh.map(x => [x.id, x]));

    for (const item of local) {
      const remoteItem = merged.get(item.id);
      const baseItem = baseMap.get(item.id);
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
    err.name = 'ConflictError';
    err.conflicts = conflicts;
    throw err;
  }

  return result;
}

export async function pushDb(message = 'Update data') {
  pushQueue = pushQueue
    .catch(() => null)
    .then(() => doPushDb(message));

  return pushQueue;
}

async function doPushDb(message = 'Update data') {
  const { owner, repo, branch } = state.github;

  if (!owner || !repo) {
    throw new Error('GitHub repo not configured');
  }

  if (!state.github.token) {
    throw new Error('GitHub token required to save');
  }

  const url = `${GH}/repos/${owner}/${repo}/contents/${FILE_PATH}`;
  const snapshot = structuredClone(state.db);
  const base = state.github.remoteDb ? structuredClone(state.github.remoteDb) : null;

  let lastError = null;

  for (let attemptNo = 1; attemptNo <= 5; attemptNo++) {
    let getRes;
    try {
      getRes = await fetch(
        `${url}?ref=${branch || 'main'}&t=${Date.now()}`,
        { headers: headers(), cache: 'no-store' }
      );
    } catch {
      if (attemptNo < 5) {
        await new Promise(resolve => setTimeout(resolve, 500 * attemptNo));
        continue;
      }
      throw new Error('Cannot reach GitHub — check your internet connection');
    }

    if (!getRes.ok) {
      if (getRes.status === 401 || getRes.status === 403) {
        throw new Error(`GitHub auth failed (${getRes.status}) — check your token in Settings`);
      }
      throw new Error(`GitHub fetch failed: ${getRes.status}`);
    }

    const getMeta = await getRes.json();
    let freshDb;
    if (getMeta.content && getMeta.encoding === 'base64') {
      freshDb = safeParseDb(b64decode(getMeta.content));
    } else {
      // File > 1 MB: content not inline. Fetch download_url WITHOUT auth headers —
      // raw.githubusercontent.com rejects CORS preflight for custom headers.
      const rawUrl = getMeta.download_url ||
        `https://raw.githubusercontent.com/${owner}/${repo}/${branch || 'main'}/${FILE_PATH}`;
      const rawContentRes = await fetch(rawUrl, { cache: 'no-store' }); // no auth headers
      if (!rawContentRes.ok) throw new Error(`Failed to read db.json: ${rawContentRes.status}`);
      freshDb = safeParseDb(await rawContentRes.text());
    }
    const merged = mergeDb(freshDb, snapshot, base);

    let putRes;
    try {
      putRes = await fetch(url, {
        method: 'PUT',
        headers: { ...headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message,
          content: b64encode(JSON.stringify(merged, null, 2)),
          branch: branch || 'main',
          sha: getMeta.sha
        })
      });
    } catch {
      if (attemptNo < 5) {
        await new Promise(resolve => setTimeout(resolve, 500 * attemptNo));
        continue;
      }
      throw new Error('Cannot reach GitHub — check your internet connection');
    }

    if (putRes.status === 409 && attemptNo < 5) {
      lastError = await putRes.text();
      await new Promise(resolve => setTimeout(resolve, 500 * attemptNo));
      continue;
    }

    if (!putRes.ok) {
      if (putRes.status === 401 || putRes.status === 403) {
        throw new Error(`GitHub token is invalid or expired (${putRes.status}) — update your token in Settings`);
      }
      const errTxt = await putRes.text();
      throw new Error(`GitHub push failed: ${putRes.status} ${errTxt}`);
    }

    const json = await putRes.json();

    state.github.sha = json.content.sha;
    state.github.remoteDb      = structuredClone(merged);
    state.github.lastPushOk    = true;
    state.github.lastPushedAt  = Date.now();
    state.github.lastSyncError = null;
    state.github.connected     = true;
    state.github.usingCache    = false;

    // Do NOT overwrite state.db with merged — state.db is the live source of
    // truth and may have accumulated more changes during the network round-trip.
    // Overwriting would silently erase those in-flight mutations, causing the
    // next queued push to snapshot and re-push stale data (the deletion bug).
    //
    // Instead, only adopt items that exist in merged but are absent locally
    // (remote-only additions from another user). Local versions always win.
    //
    // Exception: if an item was in the snapshot but is now gone from state.db,
    // the user permanently deleted it DURING this push. Never re-add those,
    // or the permanent delete gets silently undone by the post-push sync.
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

    return json;
  }

  throw new Error(`GitHub push failed after retries: ${lastError || '409 conflict'}`);
}

export async function fetchLocalDb() {
  const cached = localStorage.getItem(DB_LS_KEY);

  if (cached) {
    try {
      return JSON.parse(cached);
    } catch (e) {
      // corrupt cache, fall through
    }
  }

  try {
    const res = await fetch('data/db.json', { cache: 'no-store' });

    if (res.ok) {
      return await res.json();
    }
  } catch (e) {
    // ignore
  }

  return null;
}

export function mergeLocalPending(remoteDb, localCache) {
  const cols = new Set([
    ...Object.keys(remoteDb || {}),
    ...Object.keys(localCache || {})
  ]);
  let changed = false;
  const result = {};

  for (const col of cols) {
    const remote = remoteDb[col];
    const local = localCache[col];

    if (!Array.isArray(remote) || !Array.isArray(local)) {
      result[col] = remote !== undefined ? remote : local;
      continue;
    }

    const merged = new Map(remote.map(x => [x.id, x]));
    for (const item of local) {
      if (!merged.has(item.id)) {
        merged.set(item.id, item);
        changed = true;
      }
    }
    result[col] = [...merged.values()];
  }

  return changed ? result : remoteDb;
}

export function saveLocalCache(db) {
  try {
    localStorage.setItem(DB_LS_KEY, JSON.stringify(db));
  } catch (e) {
    console.warn(e);
  }
}

export async function resolveGitRemote() {
  try {
    const [headRes, cfgRes] = await Promise.all([
      fetch('.git/HEAD', { cache: 'no-store' }),
      fetch('.git/config', { cache: 'no-store' })
    ]);

    if (!headRes.ok || !cfgRes.ok) {
      return null;
    }

    const head = await headRes.text();
    const cfg = await cfgRes.text();

    const branchMatch = head.match(/^ref:\s*refs\/heads\/(.+)/m);
    const branch = branchMatch ? branchMatch[1].trim() : 'main';

    const urlMatch = cfg.match(/url\s*=\s*(.+)/);

    if (!urlMatch) {
      return null;
    }

    const pathMatch = urlMatch[1]
      .trim()
      .replace(/\.git$/, '')
      .match(/[/:]([^/:]+)\/([^/:]+)$/);

    if (!pathMatch) {
      return null;
    }

    return {
      owner: pathMatch[1],
      repo: pathMatch[2],
      branch
    };
  } catch (e) {
    return null;
  }
}
