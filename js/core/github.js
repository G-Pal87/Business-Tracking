// GitHub API layer - read/write db.json to a GitHub repo
import { state } from './state.js';

const GH = 'https://api.github.com';
const FILE_PATH = 'data/db.json';
const LS_KEY = 'bt_github_config';
const DB_LS_KEY = 'bt_db_cache';

export function loadConfig() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const cfg = JSON.parse(raw);
      Object.assign(state.github, cfg);
    }
  } catch (e) { console.warn('loadConfig', e); }
}

export function saveConfig({ token, owner, repo, branch }) {
  state.github.token = token || '';
  state.github.owner = owner || '';
  state.github.repo = repo || '';
  state.github.branch = branch || 'main';
  localStorage.setItem(LS_KEY, JSON.stringify({
    token: state.github.token,
    owner: state.github.owner,
    repo: state.github.repo,
    branch: state.github.branch
  }));
}

export function clearConfig() {
  localStorage.removeItem(LS_KEY);
  state.github = { token: '', owner: '', repo: '', branch: 'main', sha: null, connected: false, remoteDb: null };
}

function headers() {
  const h = {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  };
  if (state.github.token) h['Authorization'] = `Bearer ${state.github.token}`;
  return h;
}

// Base64 helpers that handle Unicode
function b64encode(str) {
  return btoa(unescape(encodeURIComponent(str)));
}
function b64decode(str) {
  return decodeURIComponent(escape(atob(str.replace(/\s/g, ''))));
}

export async function fetchDb() {
  const { owner, repo, branch } = state.github;
  if (!owner || !repo) throw new Error('GitHub repo not configured');
  const url = `${GH}/repos/${owner}/${repo}/contents/${FILE_PATH}?ref=${branch || 'main'}`;
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) {
    if (res.status === 404) throw new Error('db.json not found in repo. Make sure data/db.json exists.');
    throw new Error(`GitHub API error ${res.status}: ${res.statusText}`);
  }
  const json = await res.json();
  state.github.sha = json.sha;
  state.github.connected = true;
  const content = b64decode(json.content);
  const parsed = JSON.parse(content);
  state.github.remoteDb = structuredClone(parsed);
  return parsed;
}

// Three-way merge by stable id: local adds/edits win; remote-only adds preserved;
// items deleted locally (present in lastSynced but absent in local) are removed.
function mergeDb(freshRemote, localCurrent, lastSynced) {
  const result = {};
  const cols = new Set([...Object.keys(freshRemote), ...Object.keys(localCurrent)]);
  for (const col of cols) {
    const fresh = freshRemote[col];
    const local = localCurrent[col];
    const base  = lastSynced ? lastSynced[col] : undefined;
    if (!Array.isArray(local) || !Array.isArray(fresh)) {
      // Non-array field (e.g. settings object): local wins
      result[col] = local !== undefined ? local : fresh;
      continue;
    }
    const baseIds  = new Set((Array.isArray(base) ? base : []).map(x => x.id));
    const localMap = new Map(local.map(x => [x.id, x]));
    // Start from remote state, then apply local changes on top
    const merged   = new Map(fresh.map(x => [x.id, x]));
    for (const item of local) merged.set(item.id, item);
    // Drop items deleted locally (were in base, missing from local)
    for (const id of baseIds) { if (!localMap.has(id)) merged.delete(id); }
    result[col] = [...merged.values()];
  }
  return result;
}

export async function pushDb(db, message = 'Update data') {
  const { owner, repo, branch } = state.github;
  if (!owner || !repo) throw new Error('GitHub repo not configured');
  if (!state.github.token) throw new Error('GitHub token required to save');

  const url      = `${GH}/repos/${owner}/${repo}/contents/${FILE_PATH}`;
  // Snapshot local state now so async operations see a stable view
  const snapshot = structuredClone(db);
  const base     = state.github.remoteDb;

  const attempt = async () => {
    const getRes = await fetch(`${url}?ref=${branch || 'main'}`, { headers: headers() });
    if (!getRes.ok) throw new Error(`GitHub fetch failed: ${getRes.status}`);
    const getMeta = await getRes.json();
    const freshDb = JSON.parse(b64decode(getMeta.content));
    const merged  = mergeDb(freshDb, snapshot, base);
    const putRes  = await fetch(url, {
      method: 'PUT',
      headers: { ...headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message,
        content: b64encode(JSON.stringify(merged, null, 2)),
        branch: branch || 'main',
        sha: getMeta.sha
      })
    });
    return { putRes, merged };
  };

  // Retry up to 3 times on 409 (concurrent-write SHA race) with back-off
  let result = await attempt();
  if (result.putRes.status === 409) {
    await new Promise(r => setTimeout(r, 600));
    result = await attempt();
  }
  if (result.putRes.status === 409) {
    await new Promise(r => setTimeout(r, 1200));
    result = await attempt();
  }

  const { putRes, merged } = result;
  if (!putRes.ok) {
    const errTxt = await putRes.text();
    throw new Error(`GitHub push failed: ${putRes.status} ${errTxt}`);
  }
  const json = await putRes.json();
  state.github.sha      = json.content.sha;
  state.github.remoteDb = structuredClone(merged);
  // Merge remote-only additions into live state without clobbering
  // edits the user made while this push was in-flight
  for (const col of Object.keys(merged)) {
    if (Array.isArray(merged[col]) && Array.isArray(state.db[col])) {
      const liveIds = new Set(state.db[col].map(x => x.id));
      for (const item of merged[col]) {
        if (!liveIds.has(item.id)) state.db[col].push(item);
      }
    }
  }
  return json;
}

// Fallback: localStorage + static fetch for initial data
export async function fetchLocalDb() {
  const cached = localStorage.getItem(DB_LS_KEY);
  if (cached) {
    try { return JSON.parse(cached); } catch (e) { /* corrupt cache, fall through */ }
  }
  try {
    const res = await fetch('data/db.json', { cache: 'no-store' });
    if (res.ok) return await res.json();
  } catch (e) { /* ignore */ }
  return null;
}

export function saveLocalCache(db) {
  try { localStorage.setItem(DB_LS_KEY, JSON.stringify(db)); } catch (e) { console.warn(e); }
}

// Derive owner/repo/branch from the local .git directory (works when served from project root)
export async function resolveGitRemote() {
  try {
    const [headRes, cfgRes] = await Promise.all([
      fetch('.git/HEAD',   { cache: 'no-store' }),
      fetch('.git/config', { cache: 'no-store' })
    ]);
    if (!headRes.ok || !cfgRes.ok) return null;

    const head = await headRes.text();
    const cfg  = await cfgRes.text();

    const branchMatch = head.match(/^ref:\s*refs\/heads\/(.+)/m);
    const branch = branchMatch ? branchMatch[1].trim() : 'main';

    const urlMatch = cfg.match(/url\s*=\s*(.+)/);
    if (!urlMatch) return null;

    // Extract last two path segments as owner/repo (handles HTTPS, SSH, and proxy URLs)
    const pathMatch = urlMatch[1].trim().replace(/\.git$/, '').match(/[/:]([^/:]+)\/([^/:]+)$/);
    if (!pathMatch) return null;

    return { owner: pathMatch[1], repo: pathMatch[2], branch };
  } catch (e) {
    return null;
  }
}
