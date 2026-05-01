// Global state store with subscribe pattern
const listeners = new Set();

const initialData = {
  properties: [],
  payments: [],
  expenses: [],
  vendors: [],
  inventory: [],
  tenants: [],
  clients: [],
  services: [],
  invoices: [],
  users: [],
  settings: {
    masterCurrency: 'EUR',
    fxRates: { yearRates: {} },
    defaultTaxRate: 0,
    business: { name: '', email: '', address: '', vatNumber: '', iban: '', bic: '' },
    team: []
  }
};

export const state = {
  db: structuredClone(initialData),
  github: {
    token: '', owner: '', repo: '', branch: 'main',
    sha: null, connected: false, remoteDb: null,
    // fine-grained sync tracking
    lastPullOk:  false,
    lastPushOk:  false,
    usingCache:  false,
    lastSyncError: null,
    lastPulledAt:  null,
    lastPushedAt:  null,
    syncNow: null        // async fn set by app.js boot()
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

export function notify(event = 'change') {
  listeners.forEach(fn => { try { fn(event); } catch (e) { console.error(e); } });
}

export function setDb(db) {
  state.db = { ...initialData, ...db };
  if (!state.db.settings) state.db.settings = initialData.settings;
  if (!state.db.settings.fxRates) state.db.settings.fxRates = { yearRates: {} };
  if (!state.db.settings.fxRates.yearRates) state.db.settings.fxRates.yearRates = {};
  if (!state.db.users) state.db.users = [];
  state.dirty = false;
  notify('data-loaded');
}

export function markDirty() {
  state.dirty = true;
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
