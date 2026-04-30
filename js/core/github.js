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
    token: '',
    owner: '',
    repo: '',
    branch: 'main',
    sha: null,
    connected: false,
    remoteDb: null
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

// Files > 1 MB: Contents API returns encoding "none" and empty content.
// Fall back to the raw download URL (authenticated) in that case.
async function getFileContent(meta) {
  if (!meta.content || meta.encoding === 'none') {
    if (!meta.download_url) {
      throw new Error('GitHub returned no content and no download_url for db.json');
    }
    const res = await fetch(meta.download_url, { headers: headers(), cache: 'no-store' });
    if (!res.ok) throw new Error(`GitHub raw fetch failed: ${res.status}`);
    return res.text();
  }
  return b64decode(meta.content);
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

  const url = `${GH}/repos/${owner}/${repo}/contents/${FILE_PATH}?ref=${branch || 'main'}`;
  const res = await fetch(url, { headers: headers() });

  if (!res.ok) {
    if (res.status === 404) {
      throw new Error('db.json not found in repo. Make sure data/db.json exists.');
    }

    throw new Error(`GitHub API error ${res.status}: ${res.statusText}`);
  }

  const json = await res.json();

  state.github.sha = json.sha;
  state.github.connected = true;

  const content = await getFileContent(json);
  const parsed = safeParseDb(content);

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

export async function pushDb(db, message = 'Update data') {
  pushQueue = pushQueue
    .catch(() => null)
    .then(() => doPushDb(db, message));

  return pushQueue;
}

async function doPushDb(db, message = 'Update data') {
  const { owner, repo, branch } = state.github;

  if (!owner || !repo) {
    throw new Error('GitHub repo not configured');
  }

  if (!state.github.token) {
    throw new Error('GitHub token required to save');
  }

  const url = `${GH}/repos/${owner}/${repo}/contents/${FILE_PATH}`;
  const snapshot = structuredClone(db);
  const base = state.github.remoteDb ? structuredClone(state.github.remoteDb) : null;

  let lastError = null;

  for (let attemptNo = 1; attemptNo <= 5; attemptNo++) {
    const getRes = await fetch(
      `${url}?ref=${branch || 'main'}&t=${Date.now()}`,
      {
        headers: headers(),
        cache: 'no-store'
      }
    );

    if (!getRes.ok) {
      throw new Error(`GitHub fetch failed: ${getRes.status}`);
    }

    const getMeta = await getRes.json();
    const freshDb = safeParseDb(await getFileContent(getMeta));
    const merged = mergeDb(freshDb, snapshot, base);

    const putRes = await fetch(url, {
      method: 'PUT',
      headers: {
        ...headers(),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        message,
        content: b64encode(JSON.stringify(merged, null, 2)),
        branch: branch || 'main',
        sha: getMeta.sha
      })
    });

    if (putRes.status === 409 && attemptNo < 5) {
      lastError = await putRes.text();
      await new Promise(resolve => setTimeout(resolve, 500 * attemptNo));
      continue;
    }

    if (!putRes.ok) {
      const errTxt = await putRes.text();
      throw new Error(`GitHub push failed: ${putRes.status} ${errTxt}`);
    }

    const json = await putRes.json();

    state.github.sha = json.content.sha;
    state.github.remoteDb = structuredClone(merged);

    // Replace state.db in-place so it exactly matches what was pushed.
    // Remove keys absent from merged, then overwrite everything else.
    for (const col of Object.keys(state.db)) {
      if (!(col in merged)) delete state.db[col];
    }
    Object.assign(state.db, merged);

    saveLocalCache(merged);

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
