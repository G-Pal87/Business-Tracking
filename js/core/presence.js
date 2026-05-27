// Multi-user presence tracking via data/presence.json in GitHub
// Shows a conflict banner when two users are on the same editable view.
import { state } from './state.js';
import { uploadGithubFile } from './github.js';

const PRESENCE_PATH  = 'data/presence.json';
const STALE_MS       = 2 * 60 * 1000;   // entry expires after 2 min of inactivity
const HEARTBEAT_MS   = 50 * 1000;       // refresh own entry every 50 s while active
const POLL_MS        = 30 * 1000;       // conflict check interval
const THROTTLE_MS    = 5 * 60 * 1000;  // don't re-notify same user+view within 5 min

// Operations + System nav groups (read-write views where conflicts matter)
const TRACKED = new Set([
  'properties', 'payments', 'expenses', 'tenants', 'vendors',
  'inventory', 'clients', 'invoices', 'forecast', 'settings', 'users'
]);

const LABELS = {
  properties: 'Properties', payments: 'Payments', expenses: 'Expenses',
  tenants: 'Tenants', vendors: 'Vendors', inventory: 'Inventory',
  clients: 'Clients', invoices: 'Invoices', forecast: 'Forecast',
  settings: 'Settings', users: 'Users'
};

let pollTimer       = null;
let heartbeatTimer  = null;
let banner          = null;
let navTimer        = null;
let lastWrittenView = null;
const notified      = new Map(); // `${user}:${view}` → timestamp

// ── Public ────────────────────────────────────────────────────────────────────

export function startPresence() {
  window.addEventListener('hashchange', onHashChange);

  // Clear own entry when the tab is hidden or closed
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) clearOwnPresence();
    else { lastWrittenView = null; onHashChange(); } // re-announce on return
  });
  window.addEventListener('pagehide', clearOwnPresence);

  setTimeout(() => {
    onHashChange();
    schedulePoll();
    scheduleHeartbeat();
  }, 3000);
}

// ── Heartbeat ─────────────────────────────────────────────────────────────────

function scheduleHeartbeat() {
  heartbeatTimer = setInterval(heartbeat, HEARTBEAT_MS);
}

async function heartbeat() {
  if (document.hidden) return;
  const view = currentView();
  if (!TRACKED.has(view)) return;
  const username = state.session?.username;
  const { owner, repo, token } = state.github;
  if (!username || !owner || !repo || !token) return;
  // Only refresh timestamp — don't change anything else
  try {
    const { entries = {} } = await readPresence();
    if (entries[username]?.view === view) {
      entries[username].t = Date.now();
      await writePresence(entries);
    }
  } catch { /* best-effort */ }
}

// ── Clear own presence on tab close / hide ────────────────────────────────────

async function clearOwnPresence() {
  const username = state.session?.username;
  const { owner, repo, token } = state.github;
  if (!username || !owner || !repo || !token) return;
  lastWrittenView = null;
  try {
    const { entries = {} } = await readPresence();
    if (entries[username]) {
      delete entries[username];
      await writePresence(entries);
    }
  } catch { /* best-effort */ }
}

// ── Navigation hook ───────────────────────────────────────────────────────────

function onHashChange() {
  clearTimeout(navTimer);
  navTimer = setTimeout(handleNavigate, 2000);
}

async function handleNavigate() {
  navTimer = null;
  const view = currentView();
  if (!TRACKED.has(view)) return;
  if (view === lastWrittenView) return;
  const username = state.session?.username;
  const { owner, repo, token } = state.github;
  if (!username || !owner || !repo || !token) return;

  try {
    const { entries = {} } = await readPresence();
    entries[username] = { view, t: Date.now(), name: state.session?.name || username };
    await writePresence(entries);
    lastWrittenView = view;
  } catch { /* best-effort */ }
}

// ── Polling ───────────────────────────────────────────────────────────────────

function schedulePoll() {
  poll();
  pollTimer = setInterval(poll, POLL_MS);
}

async function poll() {
  const view = currentView();
  if (!TRACKED.has(view)) return;
  const username = state.session?.username;
  const { owner, repo, token } = state.github;
  if (!username || !owner || !repo || !token) return;

  const now = Date.now();
  for (const [key, ts] of notified) {
    if (now - ts > THROTTLE_MS) notified.delete(key);
  }

  try {
    const { entries = {} } = await readPresence();
    for (const [user, entry] of Object.entries(entries)) {
      if (user === username) continue;
      if (!entry.view || !entry.t) continue;
      if (now - entry.t > STALE_MS) continue;
      if (entry.view !== view) continue;
      const key = `${user}:${view}`;
      if (now - (notified.get(key) || 0) < THROTTLE_MS) continue;
      notified.set(key, now);
      showBanner(entry.name || user, LABELS[view] || view);
      break;
    }
  } catch { /* silent */ }
}

// ── GitHub I/O ────────────────────────────────────────────────────────────────

async function readPresence() {
  const { owner, repo, branch, token } = state.github;
  const headers = { 'Accept': 'application/vnd.github+json' };
  if (token) headers['Authorization'] = `token ${token}`;
  const enc = PRESENCE_PATH.split('/').map(encodeURIComponent).join('/');
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/${enc}?ref=${encodeURIComponent(branch || 'main')}`,
    { headers, cache: 'no-store' }
  );
  if (res.status === 404) return { entries: {} };
  if (!res.ok) throw new Error(`Presence read failed (${res.status})`);
  const file  = await res.json();
  const bytes = Uint8Array.from(atob(file.content.replace(/\s/g, '')), c => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function writePresence(entries) {
  const json = JSON.stringify({ entries }, null, 2);
  const b64  = btoa(unescape(encodeURIComponent(json)));
  await uploadGithubFile(PRESENCE_PATH, b64, 'Presence update');
}

// ── Banner ────────────────────────────────────────────────────────────────────

function showBanner(otherName, viewLabel) {
  banner?.remove();

  const b = document.createElement('div');
  b.id = 'presence-banner';
  b.style.cssText = [
    'background:var(--warning,#f59e0b)',
    'border-bottom:2px solid #d97706',
    'color:#1a1a1a',
    'padding:10px 16px',
    'display:flex',
    'align-items:center',
    'justify-content:space-between',
    'gap:12px',
    'font-size:13px',
    'font-weight:600'
  ].join(';');

  const msg = document.createElement('span');
  msg.textContent = `⚠️  ${otherName} is also viewing ${viewLabel} — edits may conflict`;
  b.appendChild(msg);

  const btn = document.createElement('button');
  btn.textContent = '✕';
  btn.style.cssText = 'background:none;border:none;cursor:pointer;font-size:16px;padding:2px 6px;color:#1a1a1a;flex-shrink:0';
  btn.onclick = () => { b.remove(); banner = null; };
  b.appendChild(btn);

  const content = document.getElementById('content');
  const main    = document.getElementById('main');
  if (content && main) main.insertBefore(b, content);
  else document.body.prepend(b);

  banner = b;
  setTimeout(() => { if (banner === b) { b.remove(); banner = null; } }, 30000);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function currentView() {
  return (location.hash || '#analytics').slice(1);
}
