// Multi-user presence tracking via data/presence.json in GitHub
// Shows a conflict banner when two users are on the same editable view.
//
// Every file on the presence branch (presence.json, session-history.json,
// session-signal.json) is stored as an encrypted {"enc":1,…} envelope under
// the app data key: the repository is public, and these files name users,
// roles, devices and login times. Nothing is written while the key isn't
// unlocked on this device (so a device without the key doesn't show up in
// "who's online"), and a plaintext file left by an older app version is read
// once and then rewritten encrypted.
//
// Rewriting a file does not remove its earlier plaintext versions from the
// branch's git history; only deleting and recreating the branch does that.
import { state } from './state.js';
import {
  isUnlocked, hasWrappedKeyConfigured, ENVELOPE_FORMAT_VERSION, supportsCompression,
  encryptJsonToEnvelope, decryptEnvelopeToJson, isEncryptedEnvelope
} from './crypto.js';
// Every request goes through ghFetch's deadline: a presence read or write
// that stalls (e.g. a mobile network switch) used to never settle, which
// blocked writeQueue — and with it every later presence write — until reload.
import { ghFetch } from './github.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const PRESENCE_PATH  = 'data/presence.json';
// Presence is ephemeral, high-churn data — keep it on a dedicated orphan branch
// so its constant commits never touch main's history and never compete with
// db.json pushes for the same ref. See: orphan branch created via commit-tree.
const PRESENCE_BRANCH = 'presence';
// Generic on purpose: commit messages are public and permanent.
const COMMIT_MESSAGE = 'Sync';

// Write cadence. Each write is a commit on a public branch and counts against
// GitHub's content-write limit, which db.json saves share, so the local tick
// only writes when something changed or an entry is about to go stale.
const TICK_MS             = 60 * 1000;      // local check (no network unless a write is due)
const PRESENCE_REFRESH_MS = 4 * 60 * 1000;  // re-stamp own view entry this often
const STALE_MS            = 7 * 60 * 1000;  // entry expires after this long without a refresh
const POLL_MS             = 60 * 1000;      // conflict + disconnect-signal check (ETag-conditional)
const HIDE_CLEAR_DELAY_MS = 60 * 1000;      // a briefly hidden tab keeps its entry
const THROTTLE_MS         = 5 * 60 * 1000;  // don't re-notify same user+view within 5 min
// Device registry (Settings → Active Devices) is a longer-lived record than
// view presence above — it answers "what devices exist" even when their tab
// isn't open right now, not just "who's on this page today". A device row is
// rewritten when something about it changes, or once its lastSeen is
// DEVICE_REFRESH_MS old; Settings treats a device as online for
// DEVICE_ONLINE_MS, which must stay above DEVICE_REFRESH_MS + TICK_MS.
const DEVICE_REFRESH_MS = 4 * 60 * 1000;
export const DEVICE_ONLINE_MS = 7 * 60 * 1000;
const DEVICES_STALE_MS    = 30 * 24 * 60 * 60 * 1000; // prune a device unseen for 30 days
const KILL_TTL_MS         = 7 * 24 * 60 * 60 * 1000;  // prune a per-device kill signal after 7 days

// Login/logout audit log — a separate file from presence.json since this one
// only grows on discrete events (login/logout/kill), never on the heartbeat,
// and is capped rather than pruned by age so a quiet team doesn't lose its
// whole history, an active one doesn't grow the file forever.
const SESSION_HISTORY_PATH = 'data/session-history.json';
const HISTORY_MAX_EVENTS   = 500;
// Failed logins happen before the key is unlocked, so they can't be written
// right away. They wait in localStorage (without any username: people often
// type their password into the username field) and are appended with the
// next event this device writes while unlocked, usually the login that follows.
const PENDING_EVENTS_LS_KEY = 'bt_pending_session_events';
const PENDING_EVENTS_MAX    = 20;

const SIGNAL_PATH = 'data/session-signal.json';
// session-signal.json only exists once someone has issued a disconnect/kill.
// Until then every 60s poll was a 404, and a 404 (unlike a 304) counts
// against the rate limit all tabs share. After a 404 the poll skips the
// file for this long. Only the poll uses this; read-modify-writes always
// read fresh, and this tab's own signal write clears it.
// Kept short: this is the path a disconnect-all / kill-device takes to reach
// an open tab, so it must not add more than a poll or so of delay.
const SIGNAL_MISSING_RECHECK_MS = 90 * 1000;
let signalMissingAt = 0;
// Once per page load, a device that can write creates the file (an empty,
// encrypted doc) when a poll finds it missing — every later poll by every tab
// is then a free 304 instead of a rate-limited 404 (see ensureSignalFile).
let signalCreateTried = false;

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
let tickTimer       = null;
let hideTimer       = null;
let banner          = null;
let navTimer        = null;
let lastWrittenView = null;   // view our entry currently holds (null = no entry)
let lastPresenceWriteAt   = 0;
let lastDeviceWriteAt     = 0;
let lastDeviceFingerprint = null;
const notified      = new Map(); // `${user}:${view}` → timestamp

// ── Public ────────────────────────────────────────────────────────────────────

export function startPresence() {
  window.addEventListener('hashchange', onHashChange);

  // Clear own entry when the tab stays hidden for a while or is closed. A
  // quick tab switch used to cost two commits (clear + re-announce).
  document.addEventListener('visibilitychange', () => {
    clearTimeout(hideTimer);
    hideTimer = null;
    if (document.hidden) {
      hideTimer = setTimeout(() => { hideTimer = null; if (document.hidden) clearOwnPresence(); }, HIDE_CLEAR_DELAY_MS);
    } else {
      onHashChange(); // re-announce if the entry was cleared meanwhile
    }
  });
  window.addEventListener('pagehide', clearOwnPresence);

  setTimeout(() => {
    onHashChange();
    schedulePoll();
    tick();
    tickTimer = setInterval(tick, TICK_MS);
  }, 3000);
}

// ── GitHub I/O (encrypted JSON files on the presence branch) ─────────────────

function ghContext() {
  const { owner, repo, token } = state.github;
  if (!owner || !repo || !token) return null;
  return { owner, repo, token };
}

function contentsUrl(ctx, path) {
  const enc = path.split('/').map(encodeURIComponent).join('/');
  return `https://api.github.com/repos/${ctx.owner}/${ctx.repo}/contents/${enc}`;
}

function b64ToUtf8(b64) {
  const binary = atob(String(b64 || '').replace(/\s/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function utf8ToB64(text) {
  return btoa(unescape(encodeURIComponent(text)));
}

// Last good response per file, keyed by repo + path. Its ETag goes back as a
// real If-None-Match, so an unchanged file costs a 304, which GitHub doesn't
// count against the rate limit. The old code sent a random value instead.
const _etagCache = new Map();
// Files already found in plaintext this page load (rewritten encrypted once).
const _migrated = new Set();

// Reads one presence-branch file. Resolves to { sha, data, legacy }: data is
// null when the file doesn't exist; legacy means it was still plaintext.
// Throws when GitHub isn't configured or reachable, when the key isn't
// unlocked (nothing on this branch can be read without it), or when
// decryption fails.
async function readBranchJson(path) {
  const ctx = ghContext();
  if (!ctx) throw new Error('GitHub not configured');
  if (!isUnlocked()) throw new Error('Encryption key not unlocked');
  const cacheKey = `${ctx.owner}/${ctx.repo}/${path}`;
  const cached = _etagCache.get(cacheKey);
  const headers = { 'Accept': 'application/vnd.github+json', 'Authorization': `token ${ctx.token}` };
  if (cached?.etag) headers['If-None-Match'] = cached.etag;
  const res = await ghFetch(`${contentsUrl(ctx, path)}?ref=${encodeURIComponent(PRESENCE_BRANCH)}`, { headers, cache: 'no-store' });
  if (res.status === 304 && cached) {
    return { sha: cached.sha, data: structuredClone(cached.data), legacy: cached.legacy };
  }
  if (res.status === 404) { _etagCache.delete(cacheKey); return { sha: null, data: null, legacy: false }; }
  if (!res.ok) throw new Error(`Presence read failed (${res.status})`);
  const file = await res.json();
  const parsed = file.content ? JSON.parse(b64ToUtf8(file.content)) : null;
  let data = null, legacy = false;
  if (isEncryptedEnvelope(parsed)) data = await decryptEnvelopeToJson(parsed);
  else if (parsed && typeof parsed === 'object') { data = parsed; legacy = true; }
  const etag = res.headers.get('ETag');
  if (etag) _etagCache.set(cacheKey, { etag, sha: file.sha, data: structuredClone(data), legacy });
  else _etagCache.delete(cacheKey);
  if (legacy && !_migrated.has(cacheKey)) {
    _migrated.add(cacheKey);
    // Rewrite it encrypted in the background: the mutator changes nothing,
    // and doUpdateBranchJson writes anyway because the file is plaintext.
    updateBranchJson(path, () => false).catch(() => {});
  }
  return { sha: file.sha, data, legacy };
}

// Encrypts `data` and writes it. Refuses ({ ok: false }) when the key isn't
// unlocked; there is no plaintext fallback.
async function writeBranchJson(path, data, sha) {
  const ctx = ghContext();
  if (!ctx || !isUnlocked()) return { ok: false, status: 0 };
  let env;
  try { env = await encryptJsonToEnvelope(data); } catch { return { ok: false, status: 0 }; }
  const body = {
    message: COMMIT_MESSAGE,
    content: utf8ToB64(JSON.stringify(env)),
    branch:  PRESENCE_BRANCH,
    ...(sha ? { sha } : {})
  };
  try {
    const put = await ghFetch(contentsUrl(ctx, path), {
      method: 'PUT',
      headers: { 'Accept': 'application/vnd.github+json', 'Authorization': `token ${ctx.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    return { ok: put.ok, status: put.status };
  } catch { return { ok: false, status: 0 }; }
}

// Empty shape of each file, and the clean-up applied to it on every read and write.
const FILE_SHAPES = {
  [PRESENCE_PATH]: {
    empty: () => ({ entries: {}, devices: {} }),
    normalize: d => ({ entries: d?.entries || {}, devices: d?.devices || {} })
  },
  [SESSION_HISTORY_PATH]: {
    empty: () => ({ events: [] }),
    normalize: d => ({ events: sanitizeEvents(Array.isArray(d?.events) ? d.events : []) })
  },
  [SIGNAL_PATH]: {
    empty: () => ({}),
    normalize: d => (d && typeof d === 'object' ? d : {})
  }
};

// Serializes every read-modify-write on the presence branch. Timers,
// navigation, logins and admin actions can fire moments apart; without this
// queue a device's own writes would SHA-conflict against each other, not
// just against another device.
let writeQueue = Promise.resolve();

// `onlyIfMissing`: create the file only if it doesn't exist (an existing
// file, whatever its content, is left alone and counts as success).
function updateBranchJson(path, mutator, { attempts = 4, evenIfDisconnected = false, onlyIfMissing = false } = {}) {
  const result = writeQueue.catch(() => null).then(() => doUpdateBranchJson(path, mutator, attempts, evenIfDisconnected, onlyIfMissing));
  writeQueue = result;
  return result;
}

// Conflict-tolerant read-modify-write. `mutator(doc)` applies this client's
// change to the freshest doc and returns true if a write is needed. On a 409
// (another tab/user wrote between our GET and PUT) we re-read and re-apply
// rather than silently losing the update.
async function doUpdateBranchJson(path, mutator, attempts, evenIfDisconnected, onlyIfMissing = false) {
  // A remotely-disconnected tab stops all GitHub writes.
  if (state.github.disconnected && !evenIfDisconnected) return false;
  if (!ghContext() || !isUnlocked()) return false;
  const shape = FILE_SHAPES[path];
  for (let i = 0; i < attempts; i++) {
    // Re-read the latest sha + doc on every attempt so a retry merges
    // against the newest remote state instead of clobbering it.
    let current;
    try { current = await readBranchJson(path); }
    catch { return false; } // offline, auth error or undecryptable: never overwrite blind
    if (onlyIfMissing && current.sha) return true; // exists (someone else created it) — nothing to do
    const doc = shape.normalize(current.data || shape.empty());
    if (!mutator(doc) && !current.legacy) return true; // nothing to write
    const { ok, status } = await writeBranchJson(path, shape.normalize(doc), current.sha);
    if (ok) return true;
    // 409: another write landed between our GET and PUT. A 422 on a create
    // (PUT without sha) means the same thing for a file that didn't exist yet
    // — someone created it meanwhile ("sha wasn't supplied"). Either way,
    // re-read and re-apply rather than dropping this client's change.
    if ((status === 409 || (status === 422 && !current.sha)) && i < attempts - 1) { await sleep(150 + Math.random() * 150); continue; }
    return false; // exhausted or non-recoverable — drop silently
  }
  return false;
}

function canWrite() {
  return !!state.session?.username && !!ghContext() && isUnlocked() && !state.github.disconnected;
}

// ── Heartbeat (own view entry + device row) ──────────────────────────────────

async function tick() {
  if (document.hidden || !canWrite()) return;
  const view = currentView();
  const now = Date.now();
  const presenceDue = TRACKED.has(view) && lastWrittenView === view && now - lastPresenceWriteAt >= PRESENCE_REFRESH_MS;
  if (!presenceDue && !deviceWriteDue(now)) return;
  await writeOwnState({ view: presenceDue ? view : null });
}

function deviceWriteDue(now = Date.now()) {
  return deviceFingerprint() !== lastDeviceFingerprint || now - lastDeviceWriteAt >= DEVICE_REFRESH_MS;
}

// One read-modify-write for both halves of presence.json: the view entry
// (when `view` is set) and this device's registry row (when due).
async function writeOwnState({ view = null } = {}) {
  const username = state.session?.username;
  if (!username) return false;
  const now = Date.now();
  const writeDevice = deviceWriteDue(now);
  const sessionId = state.github.sessionId;
  const row = deviceRow();
  const ok = await updateBranchJson(PRESENCE_PATH, doc => {
    let changed = false;
    if (view) {
      doc.entries[username] = { view, t: Date.now(), name: state.session?.name || username };
      changed = true;
    }
    if (writeDevice) {
      const cutoff = Date.now() - DEVICES_STALE_MS;
      for (const [id, d] of Object.entries(doc.devices)) {
        if ((d.lastSeen || 0) < cutoff) delete doc.devices[id];
      }
      doc.devices[sessionId] = { ...row, lastSeen: Date.now() };
      changed = true;
    }
    return changed;
  });
  if (ok) {
    if (view) { lastWrittenView = view; lastPresenceWriteAt = now; }
    if (writeDevice) { lastDeviceWriteAt = now; lastDeviceFingerprint = JSON.stringify(row); }
  }
  return ok;
}

// ── Clear own presence on tab close / hide ────────────────────────────────────

async function clearOwnPresence() {
  const username = state.session?.username;
  if (!canWrite()) return;
  if (lastWrittenView === null) return; // no entry of ours to clear
  lastWrittenView = null;
  await updateBranchJson(PRESENCE_PATH, doc => {
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
  // Leaving the tracked views drops our entry rather than letting it linger
  // (entries now go stale only after STALE_MS) and raise false conflicts.
  if (!TRACKED.has(view)) { if (lastWrittenView !== null) await clearOwnPresence(); return; }
  if (view === lastWrittenView) return;
  if (!canWrite()) return;
  await writeOwnState({ view });
}

// ── Polling ───────────────────────────────────────────────────────────────────

function schedulePoll() {
  poll();
  pollTimer = setInterval(poll, POLL_MS);
}

async function poll() {
  if (document.hidden) return;
  await checkDisconnectSignal(); // regardless of view — a kicked session must stop everywhere, not just tracked pages

  const view = currentView();
  if (!TRACKED.has(view)) return;
  const username = state.session?.username;
  if (!username || !ghContext() || !isUnlocked()) return;

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

async function readPresence() {
  const { data } = await readBranchJson(PRESENCE_PATH);
  return FILE_SHAPES[PRESENCE_PATH].normalize(data);
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

// This device's registry row, minus lastSeen. Reported whichever view is
// open (unlike the view entry, which only exists on TRACKED views): a device
// sitting on the Dashboard should still show up as online.
function deviceRow() {
  return {
    username:      state.session?.username || null,
    name:          state.session?.name || state.session?.username || 'Unknown',
    role:          state.session?.role || null,
    device:        deviceLabel(),
    deviceType:    deviceType(),
    hasKey:        isUnlocked(),
    keyConfigured: hasWrappedKeyConfigured(),
    // Which db.json envelope format this app version can read, and whether
    // the browser can decompress — Settings checks these before an admin
    // switches on compressed saving.
    envFormat:     ENVELOPE_FORMAT_VERSION,
    canCompress:   supportsCompression(),
    connectedAt:   state.github.connectedAt
  };
}

function deviceFingerprint() {
  return JSON.stringify(deviceRow());
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
  return updateBranchJson(PRESENCE_PATH, doc => {
    if (!doc.devices?.[targetSessionId]) return false;
    delete doc.devices[targetSessionId];
    return true;
  });
}

// Bulk counterpart for multi-select delete — one read-modify-write instead of
// one round trip per device.
export async function removeDevices(targetSessionIds) {
  return updateBranchJson(PRESENCE_PATH, doc => {
    let changed = false;
    for (const id of targetSessionIds) {
      if (doc.devices?.[id]) { delete doc.devices[id]; changed = true; }
    }
    return changed;
  });
}

// ── Login/logout history (Settings → Active Devices) ───────────────────────

// Failed-login events never carry the attempted username (it can be a real
// account name or a mistyped password). Also applied to events already in a
// legacy file when it is rewritten.
function sanitizeEvents(events) {
  return events.map(ev => {
    if (!ev || ev.type !== 'failed_login') return ev;
    return { ...ev, username: null, name: null };
  });
}

function readPendingEvents() {
  try {
    const list = JSON.parse(localStorage.getItem(PENDING_EVENTS_LS_KEY) || '[]');
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}

function writePendingEvents(list) {
  try {
    if (list.length) localStorage.setItem(PENDING_EVENTS_LS_KEY, JSON.stringify(list.slice(-PENDING_EVENTS_MAX)));
    else localStorage.removeItem(PENDING_EVENTS_LS_KEY);
  } catch { /* storage unavailable — the event is simply not recorded */ }
}

export async function recordSessionEvent(type, extra = {}) {
  return recordEvent(type, extra, false);
}

async function recordEvent(type, extra, evenIfDisconnected) {
  const base = { type, sessionId: state.github.sessionId, device: deviceLabel(), deviceType: deviceType(), at: Date.now() };
  // A failed login keeps no username or name (the caller's extra is ignored).
  const event = type === 'failed_login'
    ? { ...base, username: null, name: null }
    : {
        ...base,
        username: state.session?.username || null,
        name:     state.session?.name || state.session?.username || 'Unknown',
        ...extra
      };
  if (!ghContext() || !isUnlocked()) {
    // Can't encrypt yet. Failed logins wait for the next unlocked write;
    // other events without the key are not recorded.
    if (type === 'failed_login') writePendingEvents([...readPendingEvents(), event]);
    return false;
  }
  const pending = readPendingEvents();
  const ok = await updateBranchJson(SESSION_HISTORY_PATH, doc => {
    doc.events.push(...pending, event);
    if (doc.events.length > HISTORY_MAX_EVENTS) doc.events = doc.events.slice(doc.events.length - HISTORY_MAX_EVENTS);
    return true;
  }, { evenIfDisconnected });
  // Drop only what was written; a failed login queued meanwhile stays.
  if (ok && pending.length) writePendingEvents(readPendingEvents().slice(pending.length));
  return ok;
}

export async function listSessionHistory() {
  try {
    const { data } = await readBranchJson(SESSION_HISTORY_PATH);
    return FILE_SHAPES[SESSION_HISTORY_PATH].normalize(data).events;
  } catch { return []; }
}

// Wipes the login/logout audit log (read-modify-write, so an event recorded
// moments ago by another login/logout isn't lost to a stale sha).
export async function clearSessionHistory() {
  if (!ghContext() || !isUnlocked()) return false;
  return updateBranchJson(SESSION_HISTORY_PATH, doc => {
    if (!doc.events.length) return false;
    doc.events = [];
    return true;
  });
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
// A convenience, not a security control. Static hosting has no channel to
// push a signal into another open tab; the poll every session already runs
// is the only way one browser can learn anything about another. A
// disconnected tab stops pushing to GitHub until it reloads (so a stale tab
// can't keep reverting someone else's saves), but a reload gets past it, and
// the device keeps its token, key and cached data. Anyone holding the token
// and the key can also write this file. Real revocation means rotating the
// GitHub token and the encryption key.
let disconnectBanner = null;

export async function requestDisconnectOtherSessions() {
  if (!ghContext() || !isUnlocked()) return false;
  signalMissingAt = 0;
  return updateBranchJson(SIGNAL_PATH, doc => {
    doc.disconnectAt    = Date.now();
    doc.exceptSessionId = state.github.sessionId; // the issuing tab must not disconnect itself
    doc.issuedBy        = state.session?.name || state.session?.username || 'someone';
    return true;
  });
}

// Targeted counterpart to requestDisconnectOtherSessions() — disconnects one
// specific device (Settings → Active Devices → Kill Session) instead of
// everyone. Same mechanism, just addressed to a single sessionId rather than
// "everyone but me".
export async function killDevice(targetSessionId) {
  if (!ghContext() || !isUnlocked()) return false;
  signalMissingAt = 0;
  return updateBranchJson(SIGNAL_PATH, doc => {
    doc.kills = doc.kills || {};
    const cutoff = Date.now() - KILL_TTL_MS;
    for (const [id, k] of Object.entries(doc.kills)) {
      if ((k.at || 0) < cutoff) delete doc.kills[id];
    }
    doc.kills[targetSessionId] = { at: Date.now(), by: state.session?.name || state.session?.username || 'someone' };
    return true;
  });
}

async function checkDisconnectSignal() {
  if (state.github.disconnected) return; // already applied — no need to keep checking
  if (!ghContext() || !isUnlocked()) return;
  if (signalMissingAt && Date.now() - signalMissingAt < SIGNAL_MISSING_RECHECK_MS) return;
  try {
    const { sha, data: signal } = await readBranchJson(SIGNAL_PATH);
    signalMissingAt = sha ? 0 : Date.now(); // sha null = file doesn't exist (404)
    if (!sha) ensureSignalFile();
    if (!signal) return; // no disconnect ever issued

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

// Creates session-signal.json as an empty doc through the same serialized,
// encrypted read-modify-write as a disconnect/kill (so it can't race this
// tab's own signal writes, and never writes plaintext). onlyIfMissing: if
// anyone created it in the meantime — including with a real signal — it is
// left untouched; a create that loses that race (409/422) re-reads and stops.
function ensureSignalFile() {
  if (signalCreateTried || !canWrite()) return;
  signalCreateTried = true;
  updateBranchJson(SIGNAL_PATH, () => true, { onlyIfMissing: true })
    .then(ok => { if (ok) signalMissingAt = 0; })
    .catch(() => {});
}

function applyDisconnect(issuedBy) {
  state.github.disconnected = true;
  clearInterval(tickTimer);
  clearInterval(pollTimer);
  clearTimeout(hideTimer);
  // The one write a disconnected tab still makes: its own audit-log entry.
  recordEvent('disconnected', { by: issuedBy }, true).catch(() => {});
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
