// Multi-user presence tracking via data/presence.json in GitHub
// Shows a conflict banner when two users are on the same editable view.
import { state } from './state.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const PRESENCE_PATH  = 'data/presence.json';
// Presence is ephemeral, high-churn data — keep it on a dedicated orphan branch
// so its constant commits never touch main's history and never compete with
// db.json pushes for the same ref. See: orphan branch created via commit-tree.
const PRESENCE_BRANCH = 'presence';
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

async function heartbeat(isRetry = false) {
  if (document.hidden) return;
  const view = currentView();
  if (!TRACKED.has(view)) return;
  const username = state.session?.username;
  const { owner, repo, token } = state.github;
  if (!username || !owner || !repo || !token) return;
  // Only refresh timestamp — and only if a write is actually needed.
  const ok = await updatePresence(entries => {
    if (entries[username]?.view !== view) return false; // nothing to refresh
    entries[username].t = Date.now();
    return true;
  });
  // A failed heartbeat used to wait the full 50s before trying again, during
  // which this user's own entry could go stale (2 min) while they're still
  // actively editing — silently hiding a real conflict from everyone else.
  // One bounded retry closes most of that gap without hammering the API if
  // it stays down (falls back to the normal cadence after this one attempt).
  if (!ok && !isRetry) {
    setTimeout(() => heartbeat(true), 8000);
  }
}

// ── Clear own presence on tab close / hide ────────────────────────────────────

async function clearOwnPresence() {
  const username = state.session?.username;
  const { owner, repo, token } = state.github;
  if (!username || !owner || !repo || !token) return;
  lastWrittenView = null;
  await updatePresence(entries => {
    if (!entries[username]) return false; // already absent
    delete entries[username];
    return true;
  });
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

  const ok = await updatePresence(entries => {
    entries[username] = { view, t: Date.now(), name: state.session?.name || username };
    return true;
  });
  if (ok) lastWrittenView = view;
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
    // Collect every currently-conflicting viewer instead of stopping at the
    // first match — with 3+ people on the same view, the others used to
    // never be mentioned at all.
    const conflicting = [];
    for (const [user, entry] of Object.entries(entries)) {
      if (user === username) continue;
      if (!entry.view || !entry.t) continue;
      if (now - entry.t > STALE_MS) continue;
      if (entry.view !== view) continue;
      const key = `${user}:${view}`;
      if (now - (notified.get(key) || 0) < THROTTLE_MS) continue;
      notified.set(key, now);
      conflicting.push(entry.name || user);
    }
    if (conflicting.length > 0) showBanner(conflicting, LABELS[view] || view);
  } catch { /* silent */ }
}

// ── GitHub I/O ────────────────────────────────────────────────────────────────

async function readPresence() {
  const { owner, repo, token } = state.github;
  const headers = { 'Accept': 'application/vnd.github+json' };
  if (token) headers['Authorization'] = `token ${token}`;
  const enc = PRESENCE_PATH.split('/').map(encodeURIComponent).join('/');
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/${enc}?ref=${encodeURIComponent(PRESENCE_BRANCH)}`,
    { headers, cache: 'no-store' }
  );
  if (res.status === 404) return { entries: {} };
  if (!res.ok) throw new Error(`Presence read failed (${res.status})`);
  const file  = await res.json();
  const bytes = Uint8Array.from(atob(file.content.replace(/\s/g, '')), c => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

// Conflict-tolerant read-modify-write for presence.json.
// `mutator(entries)` applies this client's change to the freshest entries and
// returns true if a write is needed. On a 409 (another tab/user wrote between
// our GET and PUT) we re-read and re-apply rather than silently losing the
// update — this is what was producing the swallowed 409s and lost presence.
async function updatePresence(mutator, attempts = 4) {
  const { owner, repo, token } = state.github;
  if (!owner || !repo || !token) return false;
  const enc    = PRESENCE_PATH.split('/').map(encodeURIComponent).join('/');
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${enc}`;
  const headers = {
    'Accept': 'application/vnd.github+json',
    'Authorization': `token ${token}`,
    'Content-Type': 'application/json'
  };

  for (let i = 0; i < attempts; i++) {
    // Re-read the latest sha + entries on every attempt so a retry merges
    // against the newest remote state instead of clobbering it.
    let sha = null, entries = {};
    try {
      const getRes = await fetch(
        `${apiUrl}?ref=${encodeURIComponent(PRESENCE_BRANCH)}`,
        { headers: { ...headers, 'If-None-Match': `"${Date.now()}"` }, cache: 'no-store' }
      );
      if (getRes.ok) {
        const d = await getRes.json();
        sha = d.sha;
        if (d.content) {
          const bytes = Uint8Array.from(atob(d.content.replace(/\s/g, '')), c => c.charCodeAt(0));
          entries = (JSON.parse(new TextDecoder().decode(bytes)).entries) || {};
        }
      } else if (getRes.status !== 404) {
        return false; // auth/other error — give up quietly
      }
    } catch { return false; } // offline — best-effort

    if (!mutator(entries)) return true; // nothing to write

    const json = JSON.stringify({ entries }, null, 2);
    const body = {
      message: 'Presence update',
      content: btoa(unescape(encodeURIComponent(json))),
      branch:  PRESENCE_BRANCH,
      ...(sha ? { sha } : {})
    };
    try {
      const put = await fetch(apiUrl, { method: 'PUT', headers, body: JSON.stringify(body) });
      if (put.ok) return true;
      if (put.status === 409 && i < attempts - 1) { await sleep(150 + Math.random() * 150); continue; }
      return false; // exhausted or non-recoverable — drop silently
    } catch { return false; }
  }
  return false;
}

// ── Banner ────────────────────────────────────────────────────────────────────

function showBanner(otherNames, viewLabel) {
  banner?.remove();

  const names = Array.isArray(otherNames) ? otherNames : [otherNames];
  const namesText = names.length === 1 ? names[0]
    : names.length === 2 ? `${names[0]} and ${names[1]}`
    : `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
  const verb = names.length === 1 ? 'is' : 'are';

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
  msg.textContent = `⚠️  ${namesText} ${verb} also viewing ${viewLabel} — edits may conflict`;
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
