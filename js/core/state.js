// Global state store with subscribe pattern
const listeners = new Set();

const DEVICE_ID_KEY = 'bt_device_id';

// One stable id per browser, generated once and reused across reloads — falls
// back to a fresh id (not persisted) if localStorage is unavailable (private
// browsing, quota, etc.) rather than failing the whole app over this.
function getOrCreateDeviceId() {
  try {
    let id = localStorage.getItem(DEVICE_ID_KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(DEVICE_ID_KEY, id);
    }
    return id;
  } catch {
    return crypto.randomUUID();
  }
}

const initialData = {
  properties: [],
  payments: [],
  expenses: [],
  vendors: [],
  inventory: [],
  strCalendars: [],
  tenants: [],
  clients: [],
  services: [],
  invoices: [],
  timeOff: [],
  people: [],
  users: [],
  settings: {
    masterCurrency: 'EUR',
    fxRates: { yearRates: {} },
    defaultTaxRate: 0,
    business: { name: '', email: '', address: '', vatNumber: '', iban: '', bic: '' },
    team: [],
    engagements: [],
    dividendSettings: []
  },
  appConfig: {
    github: { owner: '', repo: '', branch: 'main', path: 'data/db.json', token: '' }
  }
};

export const state = {
  db: structuredClone(initialData),
  _ix: new Map(),
  // Cache of active (non-deleted) records per collection. Populated lazily by
  // listActive() and invalidated whenever a collection mutates (markDirty) or
  // the whole db is replaced (setDb). Safe to share references: no caller
  // mutates a listActive() return in place (all .sort/.splice/.push operate on
  // .filter()-derived or locally-built arrays).
  _activeCache: new Map(),
  github: {
    token: '', owner: '', repo: '', branch: 'main', dbPath: 'data/db.json',
    sha: null, connected: false, remoteDb: null,
    lastPullOk:  false,
    lastPushOk:  false,
    usingCache:  false,
    lastSyncError: null,
    lastPulledAt:  null,
    lastPushedAt:  null,
    syncNow: null,
    // Identifies this browser for the remote-disconnect feature (Settings →
    // "Disconnect other sessions") and the Active Devices registry. Persisted in
    // localStorage so reloading/reopening the same browser updates its existing
    // device-registry row instead of adding a new one every time — a reload
    // still can't be tricked into ignoring a stale kill/disconnect signal aimed
    // at an earlier load, because that check compares the signal's timestamp
    // against connectedAt (always Date.now() at this load), not sessionId.
    sessionId: getOrCreateDeviceId(),
    connectedAt: Date.now(),
    disconnected: false
  },
  ui: { currentRoute: 'analytics', filters: { year: 'all', stream: 'all', owner: 'all' } },
  session: null,
  dirty: false,
  saving: false
};

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// ── Notification batching ──────────────────────────────────────────────────
// Bulk operations (CSV import, multi-row delete) call markDirty()/notify() once
// per record. runBatch() suspends fan-out and re-emits each distinct event once
// at the end, collapsing thousands of save/refresh schedules into one. Supports
// nesting and async work (await-able fn). markDirty's cache invalidation still
// runs per call, so derived data stays correct inside the batch.
let _notifyDepth = 0;
let _batchedEvents = null;

export function notify(event = 'change') {
  if (_notifyDepth > 0) { _batchedEvents.add(event); return; }
  listeners.forEach(fn => { try { fn(event); } catch (e) { console.error(e); } });
}

export function runBatch(fn) {
  if (_notifyDepth === 0) _batchedEvents = new Set();
  _notifyDepth++;
  const finish = () => {
    _notifyDepth--;
    if (_notifyDepth === 0) {
      const events = _batchedEvents;
      _batchedEvents = null;
      events.forEach(ev => notify(ev));
    }
  };
  let result;
  try {
    result = fn();
  } catch (e) {
    finish();
    throw e;
  }
  if (result && typeof result.then === 'function') {
    return result.finally(finish);
  }
  finish();
  return result;
}

// ── Per-collection data revisions ──────────────────────────────────────────
// Derived-data caches (data.js derivedCache) stamp themselves with the
// revision of each collection they read, so an edit to one collection only
// invalidates the caches that read it. One global, monotonic sequence:
// a scoped bump (markDirty('payments'), invalidateActiveCache('payments'))
// records the new value for that collection only; an unscoped bump
// (markDirty(), invalidateActiveCache(), setDb) records it in _revAll, which
// every collection — and 'settings', which only ever moves with an unscoped
// bump — inherits. So anything that doesn't name exactly one collection keeps
// the old "every cache is dropped" behaviour.
let _revSeq = 0;
state._rev = new Map();   // collection → seq of its last scoped bump
state._revAll = 0;        // seq of the last unscoped bump
state._editSeqSeen = 0;   // editSeq as of the last markDirty/setDb (see dataRev)

function bumpRev(collection) {
  const seq = ++_revSeq;
  if (typeof collection === 'string' && collection) state._rev.set(collection, seq);
  else state._revAll = seq;
}

// Current revision of `collection` ('settings' for the settings object).
// Changes whenever that collection may have changed. Safety net: editSeq
// moved without going through markDirty (a direct state.editSeq bump
// elsewhere) → treated as an unscoped edit.
export function dataRev(collection) {
  if ((state.editSeq || 0) !== state._editSeqSeen) {
    state._editSeqSeen = state.editSeq || 0;
    bumpRev();
  }
  const own = state._rev.get(collection) || 0;
  return own > state._revAll ? own : state._revAll;
}

// Invalidate the cached active-record list(s). Pass a collection name to clear
// just that one, or omit to clear all. Used by mutators that bypass markDirty
// (e.g. github sync adopting remote records).
export function invalidateActiveCache(collection) {
  if (collection) state._activeCache.delete(collection);
  else state._activeCache.clear();
  bumpRev(collection);
}

export function setDb(db) {
  // Fresh defaults each time — spreading initialData directly shared its
  // nested arrays/objects (e.g. `settings`, empty collections) with state.db,
  // so later in-place mutations silently changed the defaults themselves.
  const defaults = structuredClone(initialData);
  state.db = { ...defaults, ...db };
  if (!state.db.settings) state.db.settings = defaults.settings;
  if (!state.db.settings.fxRates) state.db.settings.fxRates = { yearRates: {} };
  if (!state.db.settings.fxRates.yearRates) state.db.settings.fxRates.yearRates = {};
  if (!state.db.users) state.db.users = [];
  if (!state.db.people) state.db.people = [];
  if (!state.db.timeOff) state.db.timeOff = [];
  if (!state.db.settings.dividendSettings) state.db.settings.dividendSettings = [];
  if (!state.db.settings.engagements) state.db.settings.engagements = [];
  state._ix = new Map();
  for (const [key, val] of Object.entries(state.db)) {
    if (Array.isArray(val)) {
      state._ix.set(key, new Map(val.map(item => [item.id, item])));
    }
  }
  state._activeCache = new Map();
  state.dirty = false;
  state.editSeq = 0;
  state._editSeqSeen = 0;
  state._rev = new Map();
  bumpRev();
  notify('data-loaded');
}

// editSeq increments on every edit and never resets while the app is open — it lets
// a push distinguish "an edit landed after my snapshot was taken" (compare against
// the value captured at snapshot time) from the single boolean `dirty`, which stays
// true across an entire push attempt so the tab-close warning keeps working correctly
// if that push fails.
//
// `collection` (optional): the one collection this edit touched — only its
// cached active list and the derived caches that read it are dropped. Omit it
// (or pass anything but a string) whenever the edit touched more than one
// collection, a plain field such as settings, or you aren't sure: every cached
// list and every derived cache is dropped, as before.
export function markDirty(collection) {
  state.dirty = true;
  // A direct editSeq bump nobody paired with markDirty (the safety net in
  // dataRev) must not be swallowed by this call's _editSeqSeen update.
  if ((state.editSeq || 0) !== state._editSeqSeen) bumpRev();
  state.editSeq = (state.editSeq || 0) + 1;
  state._editSeqSeen = state.editSeq;
  if (typeof collection === 'string' && collection) state._activeCache.delete(collection);
  else state._activeCache.clear();
  bumpRev(collection);
  notify('dirty');
}

export function markClean() {
  state.dirty = false;
  notify('clean');
}

export function setFilter(key, value) {
  state.ui.filters[key] = value;
  notify('filter-change');
}

export function setRoute(route) {
  state.ui.currentRoute = route;
  notify('route-change');
}
