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
  state.github = { token: '', owner: '', repo: '', branch: 'main', sha: null, connected: false };
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
  return JSON.parse(content);
}

export async function pushDb(db, message = 'Update data') {
  const { owner, repo, branch } = state.github;
  if (!owner || !repo) throw new Error('GitHub repo not configured');
  if (!state.github.token) throw new Error('GitHub token required to save');

  const url = `${GH}/repos/${owner}/${repo}/contents/${FILE_PATH}`;
  const encoded = b64encode(JSON.stringify(db, null, 2));

  const tryPut = async (sha) => {
    const body = { message, content: encoded, branch: branch || 'main' };
    if (sha) body.sha = sha;
    return fetch(url, {
      method: 'PUT',
      headers: { ...headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  };

  let res = await tryPut(state.github.sha);

  // 409 = SHA mismatch (stale cache). Refresh the SHA and retry once.
  if (res.status === 409) {
    const fresh = await fetch(`${url}?ref=${branch || 'main'}`, { headers: headers() });
    if (fresh.ok) {
      const meta = await fresh.json();
      state.github.sha = meta.sha;
      res = await tryPut(state.github.sha);
    }
  }

  if (!res.ok) {
    const errTxt = await res.text();
    throw new Error(`GitHub push failed: ${res.status} ${errTxt}`);
  }
  const json = await res.json();
  state.github.sha = json.content.sha;
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
