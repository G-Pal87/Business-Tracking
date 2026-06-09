// Global state store with subscribe pattern
const listeners = new Set();

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
    syncNow: null
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

// Invalidate the cached active-record list(s). Pass a collection name to clear
// just that one, or omit to clear all. Used by mutators that bypass markDirty
// (e.g. github sync adopting remote records).
export function invalidateActiveCache(collection) {
  if (collection) state._activeCache.delete(collection);
  else state._activeCache.clear();
}

export function setDb(db) {
  state.db = { ...initialData, ...db };
  if (!state.db.settings) state.db.settings = initialData.settings;
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
  notify('data-loaded');
}

export function markDirty() {
  state.dirty = true;
  state._activeCache.clear();
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
