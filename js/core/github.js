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
  const { owner, repo, branch, sha } = state.github;
  if (!owner || !repo) throw new Error('GitHub repo not configured');
  if (!state.github.token) throw new Error('GitHub token required to save');

  const url = `${GH}/repos/${owner}/${repo}/contents/${FILE_PATH}`;
  const body = {
    message,
    content: b64encode(JSON.stringify(db, null, 2)),
    branch: branch || 'main'
  };
  if (sha) body.sha = sha;

  const res = await fetch(url, {
    method: 'PUT',
    headers: { ...headers(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
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
  try {
    const res = await fetch('data/db.json', { cache: 'no-store' });
    if (res.ok) return await res.json();
  } catch (e) { /* ignore */ }
  const cached = localStorage.getItem(DB_LS_KEY);
  if (cached) return JSON.parse(cached);
  return null;
}

export function saveLocalCache(db) {
  try { localStorage.setItem(DB_LS_KEY, JSON.stringify(db)); } catch (e) { console.warn(e); }
}
