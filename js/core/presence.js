// Multi-user presence tracking via data/presence.json in GitHub
// Shows a conflict banner when two users are on the same editable view.
import { state } from './state.js';
import { isUnlocked, hasWrappedKeyConfigured } from './crypto.js';

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
// Device registry (Settings → Active Devices) is a longer-lived record than
// view presence above — it answers "what devices exist / have the key" even
// when their tab isn't open right now, not just "who's on this page today".
const DEVICE_HEARTBEAT_MS = HEARTBEAT_MS;
const DEVICES_STALE_MS    = 30 * 24 * 60 * 60 * 1000; // prune a device unseen for 30 days
const KILL_TTL_MS         = 7 * 24 * 60 * 60 * 1000;  // prune a per-device kill signal after 7 days

// Login/logout audit log — a separate file from presence.json since this one
// only grows on discrete events (login/logout/kill), never on the 50s
// heartbeat, and is capped rather than pruned by age so a quiet team doesn't
// lose its whole history, an active one doesn't grow the file forever.
const SESSION_HISTORY_PATH = 'data/session-history.json';
const HISTORY_MAX_EVENTS   = 500;

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
let deviceTimer     = null;
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
    scheduleDeviceReport();
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
  const ok = await updatePresence(doc => {
    if (doc.entries[username]?.view !== view) return false; // nothing to refresh
    doc.entries[username].t = Date.now();
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
  await updatePresence(doc => {
    if (!doc.entries[username]) return false; // already absent
    delete doc.entries[username];
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

  const ok = await updatePresence(doc => {
    doc.entries[username] = { view, t: Date.now(), name: state.session?.name || username };
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
  await checkDisconnectSignal(); // regardless of view — a kicked session must stop everywhere, not just tracked pages

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
  if (res.status === 404) return { entries: {}, devices: {} };
  if (!res.ok) throw new Error(`Presence read failed (${res.status})`);
  const file  = await res.json();
  const bytes = Uint8Array.from(atob(file.content.replace(/\s/g, '')), c => c.charCodeAt(0));
  const parsed = JSON.parse(new TextDecoder().decode(bytes));
  return { entries: parsed.entries || {}, devices: parsed.devices || {} };
}

// Conflict-tolerant read-modify-write for presence.json.
// `mutator(doc)` applies this client's change to the freshest {entries,
// devices} doc and returns true if a write is needed. On a 409 (another
// tab/user wrote between our GET and PUT) we re-read and re-apply rather
// than silently losing the update — this is what was producing the
// swallowed 409s and lost presence.
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
    // Re-read the latest sha + doc on every attempt so a retry merges
    // against the newest remote state instead of clobbering it.
    let sha = null, doc = { entries: {}, devices: {} };
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
          const parsed = JSON.parse(new TextDecoder().decode(bytes));
          doc = { entries: parsed.entries || {}, devices: parsed.devices || {} };
        }
      } else if (getRes.status !== 404) {
        return false; // auth/other error — give up quietly
      }
    } catch { return false; } // offline — best-effort

    if (!mutator(doc)) return true; // nothing to write

    const json = JSON.stringify(doc, null, 2);
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

// ── Device registry (Settings → Active Devices) ────────────────────────────

function deviceLabel() {
  const ua = navigator.userAgent || '';
  let browser = 'Browser';
  if (/Edg\//.test(ua)) browser = 'Edge';
  else if (/OPR\//.test(ua)) browser = 'Opera';
  else if (/Chrome\//.test(ua)) browser = 'Chrome';
  else if (/Firefox\//.test(ua)) browser = 'Firefox';
  else if (/Safari\//.test(ua)) browser = 'Safari';
  return `${browser} on ${osLabel()}`;
}

function osLabel() {
  const ua = navigator.userAgent || '';
  if (/Windows/.test(ua)) return 'Windows';
  if (/Mac OS X/.test(ua)) return /iPad|Macintosh.*Mobile/.test(ua) ? 'iPadOS' : 'macOS';
  if (/Android/.test(ua)) return 'Android';
  if (/iPhone|iPad|iPod/.test(ua)) return 'iOS';
  if (/Linux/.test(ua)) return 'Linux';
  return 'Unknown OS';
}

// Coarse category only (mobile / tablet / desktop) — no device model, no
// hardware identifiers, nothing that singles out a specific physical unit.
function deviceType() {
  const ua = navigator.userAgent || '';
  if (/iPad/.test(ua) || (/Android/.test(ua) && !/Mobile/.test(ua))) return 'tablet';
  if (/Mobi|iPhone|iPod/.test(ua)) return 'mobile';
  return 'desktop';
}

function scheduleDeviceReport() {
  reportDevice();
  deviceTimer = setInterval(reportDevice, DEVICE_HEARTBEAT_MS);
}

// Reports this session into the shared registry regardless of which view is
// open (unlike the conflict-detection heartbeat above, which only runs on
// TRACKED views) — a device just sitting on the Dashboard should still show
// up as online and shouldn't drop out of the list just because it's not
// editing anything.
async function reportDevice() {
  const { owner, repo, token } = state.github;
  if (!owner || !repo || !token) return;
  const sessionId = state.github.sessionId;
  await updatePresence(doc => {
    const cutoff = Date.now() - DEVICES_STALE_MS;
    for (const [id, d] of Object.entries(doc.devices)) {
      if ((d.lastSeen || 0) < cutoff) delete doc.devices[id];
    }
    doc.devices[sessionId] = {
      username:      state.session?.username || null,
      name:          state.session?.name || state.session?.username || 'Unknown',
      role:          state.session?.role || null,
      device:        deviceLabel(),
      deviceType:    deviceType(),
      hasKey:        isUnlocked(),
      keyConfigured: hasWrappedKeyConfigured(),
      connectedAt:   state.github.connectedAt,
      lastSeen:      Date.now()
    };
    return true;
  });
}

// Settings → Active Devices reads this to render the list.
export async function listDevices() {
  try {
    const { devices } = await readPresence();
    return devices;
  } catch { return {}; }
}

// Deletes one row from the device registry — for an offline device, where
// "Kill Session" (a live-tab signal) has nothing to reach. Unlike killDevice(),
// this doesn't touch session-signal.json: there's no tab left to disconnect,
// just a stale row to clear out.
export async function removeDevice(targetSessionId) {
  return updatePresence(doc => {
    if (!doc.devices?.[targetSessionId]) return false;
    delete doc.devices[targetSessionId];
    return true;
  });
}

// ── Login/logout history (Settings → Active Devices) ───────────────────────
// Appends one event per login/logout/kill — not the read-modify-write-with-
// retry treatment presence.json gets, since a lost event here (rare 409 on
// two logins landing in the same instant) is a cosmetic gap in a log, not a
// stuck banner or state.

export async function recordSessionEvent(type, extra = {}) {
  const { owner, repo, token } = state.github;
  if (!owner || !repo || !token) return false;
  const headers = {
    'Accept':        'application/vnd.github+json',
    'Authorization': `token ${token}`,
    'Content-Type':  'application/json'
  };
  const enc    = SESSION_HISTORY_PATH.split('/').map(encodeURIComponent).join('/');
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${enc}`;

  let sha = null, events = [];
  try {
    const get = await fetch(`${apiUrl}?ref=${encodeURIComponent(PRESENCE_BRANCH)}`, { headers, cache: 'no-store' });
    if (get.ok) {
      const d = await get.json();
      sha = d.sha;
      const bytes = Uint8Array.from(atob(d.content.replace(/\s/g, '')), c => c.charCodeAt(0));
      events = JSON.parse(new TextDecoder().decode(bytes)).events || [];
    }
  } catch { /* file doesn't exist yet — create it */ }

  events.push({
    type, // 'login' | 'logout' | 'disconnected'
    sessionId: state.github.sessionId,
    username:  state.session?.username || null,
    name:      state.session?.name || state.session?.username || 'Unknown',
    device:    deviceLabel(),
    deviceType: deviceType(),
    at:        Date.now(),
    ...extra
  });
  if (events.length > HISTORY_MAX_EVENTS) events = events.slice(events.length - HISTORY_MAX_EVENTS);

  const body = {
    message: `Session ${type}`,
    content: btoa(unescape(encodeURIComponent(JSON.stringify({ events }, null, 2)))),
    branch:  PRESENCE_BRANCH,
    ...(sha ? { sha } : {})
  };
  try {
    const put = await fetch(apiUrl, { method: 'PUT', headers, body: JSON.stringify(body) });
    return put.ok;
  } catch { return false; }
}

export async function listSessionHistory() {
  const { owner, repo, token } = state.github;
  if (!owner || !repo || !token) return [];
  const headers = { 'Accept': 'application/vnd.github+json', 'Authorization': `token ${token}` };
  const enc = SESSION_HISTORY_PATH.split('/').map(encodeURIComponent).join('/');
  try {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/${enc}?ref=${encodeURIComponent(PRESENCE_BRANCH)}`,
      { headers, cache: 'no-store' }
    );
    if (!res.ok) return [];
    const d = await res.json();
    const bytes = Uint8Array.from(atob(d.content.replace(/\s/g, '')), c => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)).events || [];
  } catch { return []; }
}

// Wipes the login/logout audit log. Re-reads the current sha immediately before
// writing (rather than trusting a sha from an earlier listSessionHistory() call)
// so this doesn't clobber an event recorded moments ago by another login/logout.
export async function clearSessionHistory() {
  const { owner, repo, token } = state.github;
  if (!owner || !repo || !token) return false;
  const headers = {
    'Accept':        'application/vnd.github+json',
    'Authorization': `token ${token}`,
    'Content-Type':  'application/json'
  };
  const enc    = SESSION_HISTORY_PATH.split('/').map(encodeURIComponent).join('/');
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${enc}`;

  let sha = null;
  try {
    const get = await fetch(`${apiUrl}?ref=${encodeURIComponent(PRESENCE_BRANCH)}`, { headers, cache: 'no-store' });
    if (get.ok) sha = (await get.json()).sha;
    else if (get.status !== 404) return false;
  } catch { return false; }
  if (!sha) return true; // already empty/nonexistent

  const body = {
    message: 'Clear session history',
    content: btoa(unescape(encodeURIComponent(JSON.stringify({ events: [] }, null, 2)))),
    branch:  PRESENCE_BRANCH,
    sha
  };
  try {
    const put = await fetch(apiUrl, { method: 'PUT', headers, body: JSON.stringify(body) });
    return put.ok;
  } catch { return false; }
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

// ── Remote session-kill (Settings → "Disconnect other sessions") ─────────────
// Static hosting has no channel to push a signal into another open tab — the
// 30s poll every session already runs is the only way one browser can learn
// anything about another. A disconnected session stops pushing to GitHub (so
// it can't keep reverting someone else's saves the way a stale tab running
// pre-fix code was doing) but never touches its own local data or forces a
// reload — the user chooses when, so nothing of theirs gets discarded.
const SIGNAL_PATH = 'data/session-signal.json';
let disconnectBanner = null;

// Reads the current session-signal doc (broad signal + per-device kills),
// tolerating a missing file. Shared by both writers below so neither one
// clobbers the other's half of the file.
async function readSignalDoc(headers, apiUrl) {
  try {
    const get = await fetch(`${apiUrl}?ref=${encodeURIComponent(PRESENCE_BRANCH)}`, { headers, cache: 'no-store' });
    if (get.ok) {
      const d = await get.json();
      const bytes = Uint8Array.from(atob(d.content.replace(/\s/g, '')), c => c.charCodeAt(0));
      return { sha: d.sha, doc: JSON.parse(new TextDecoder().decode(bytes)) };
    }
  } catch { /* file doesn't exist yet — create it */ }
  return { sha: null, doc: {} };
}

export async function requestDisconnectOtherSessions() {
  const { owner, repo, token } = state.github;
  if (!owner || !repo || !token) return false;
  const headers = {
    'Accept':        'application/vnd.github+json',
    'Authorization': `token ${token}`,
    'Content-Type':  'application/json'
  };
  const enc    = SIGNAL_PATH.split('/').map(encodeURIComponent).join('/');
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${enc}`;

  const { sha, doc } = await readSignalDoc(headers, apiUrl);
  doc.disconnectAt    = Date.now();
  doc.exceptSessionId = state.github.sessionId; // the issuing tab must not disconnect itself
  doc.issuedBy         = state.session?.name || state.session?.username || 'someone';

  const body = {
    message: 'Disconnect other sessions',
    content: btoa(unescape(encodeURIComponent(JSON.stringify(doc, null, 2)))),
    branch:  PRESENCE_BRANCH,
    ...(sha ? { sha } : {})
  };
  try {
    const put = await fetch(apiUrl, { method: 'PUT', headers, body: JSON.stringify(body) });
    return put.ok;
  } catch { return false; }
}

// Targeted counterpart to requestDisconnectOtherSessions() — disconnects one
// specific device (Settings → Active Devices → Kill Session) instead of
// everyone. Same mechanism (a signal every session polls for every 30s),
// just addressed to a single sessionId rather than "everyone but me".
export async function killDevice(targetSessionId) {
  const { owner, repo, token } = state.github;
  if (!owner || !repo || !token) return false;
  const headers = {
    'Accept':        'application/vnd.github+json',
    'Authorization': `token ${token}`,
    'Content-Type':  'application/json'
  };
  const enc    = SIGNAL_PATH.split('/').map(encodeURIComponent).join('/');
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${enc}`;

  const { sha, doc } = await readSignalDoc(headers, apiUrl);
  doc.kills = doc.kills || {};
  const cutoff = Date.now() - KILL_TTL_MS;
  for (const [id, k] of Object.entries(doc.kills)) {
    if ((k.at || 0) < cutoff) delete doc.kills[id];
  }
  doc.kills[targetSessionId] = { at: Date.now(), by: state.session?.name || state.session?.username || 'someone' };

  const body = {
    message: 'Disconnect device',
    content: btoa(unescape(encodeURIComponent(JSON.stringify(doc, null, 2)))),
    branch:  PRESENCE_BRANCH,
    ...(sha ? { sha } : {})
  };
  try {
    const put = await fetch(apiUrl, { method: 'PUT', headers, body: JSON.stringify(body) });
    return put.ok;
  } catch { return false; }
}

async function checkDisconnectSignal() {
  if (state.github.disconnected) return; // already applied — no need to keep checking
  const { owner, repo, token } = state.github;
  if (!owner || !repo || !token) return;
  const headers = { 'Accept': 'application/vnd.github+json', 'Authorization': `token ${token}` };
  const enc = SIGNAL_PATH.split('/').map(encodeURIComponent).join('/');
  try {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/${enc}?ref=${encodeURIComponent(PRESENCE_BRANCH)}`,
      { headers, cache: 'no-store' }
    );
    if (!res.ok) return; // 404 = no disconnect ever issued
    const d = await res.json();
    const bytes  = Uint8Array.from(atob(d.content.replace(/\s/g, '')), c => c.charCodeAt(0));
    const signal = JSON.parse(new TextDecoder().decode(bytes));

    const targeted = signal.kills?.[state.github.sessionId];
    if (targeted && targeted.at > state.github.connectedAt) {
      applyDisconnect(targeted.by);
      return;
    }

    if (!signal.disconnectAt) return;
    if (signal.exceptSessionId === state.github.sessionId) return; // this tab issued it
    if (signal.disconnectAt <= state.github.connectedAt) return;   // predates this session — a fresh reload after an old signal, ignore
    applyDisconnect(signal.issuedBy);
  } catch { /* offline — check again next poll */ }
}

function applyDisconnect(issuedBy) {
  state.github.disconnected = true;
  clearTimeout(heartbeatTimer);
  clearTimeout(pollTimer);
  clearTimeout(deviceTimer);
  recordSessionEvent('disconnected', { by: issuedBy }).catch(() => {});
  showDisconnectBanner(issuedBy);
}

function showDisconnectBanner(issuedBy) {
  disconnectBanner?.remove();
  const b = document.createElement('div');
  b.id = 'session-disconnect-banner';
  b.style.cssText = [
    'background:var(--danger,#ef4444)', 'color:#fff', 'padding:10px 16px',
    'display:flex', 'align-items:center', 'justify-content:space-between',
    'gap:12px', 'font-size:13px', 'font-weight:600'
  ].join(';');

  const msg = document.createElement('span');
  msg.textContent = `⚠️ This session was disconnected remotely by ${issuedBy} — your edits are safe on this device but won't sync until you reload.`;
  b.appendChild(msg);

  const btn = document.createElement('button');
  btn.textContent = 'Reload now';
  btn.style.cssText = 'background:#fff;color:#991b1b;border:none;border-radius:4px;padding:4px 10px;cursor:pointer;font-weight:700;flex-shrink:0';
  btn.onclick = () => location.reload();
  b.appendChild(btn);

  const content = document.getElementById('content');
  const main    = document.getElementById('main');
  if (content && main) main.insertBefore(b, content);
  else document.body.prepend(b);

  disconnectBanner = b;
  // No auto-dismiss — unlike the conflict banner, this one means saving is
  // actually disabled, so it must stay until the user reloads.
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function currentView() {
  return (location.hash || '#analytics').slice(1);
}
