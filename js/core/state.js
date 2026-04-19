// Global state store with subscribe pattern
const listeners = new Set();

const initialData = {
  properties: [],
  payments: [],
  expenses: [],
  tenants: [],
  clients: [],
  services: [],
  invoices: [],
  settings: {
    masterCurrency: 'EUR',
    fxRates: { HUF_EUR: 0.0025 },
    defaultTaxRate: 0,
    business: { name: '', email: '', address: '', vatNumber: '', iban: '', bic: '' },
    team: [],
    invoiceCounters: { you: 0, rita: 0 }
  }
};

export const state = {
  db: structuredClone(initialData),
  github: { token: '', owner: '', repo: '', branch: 'main', sha: null, connected: false },
  ui: { currentRoute: 'dashboard', filters: { year: 'all', stream: 'all', owner: 'all' } },
  dirty: false
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
  if (!state.db.settings.fxRates) state.db.settings.fxRates = { HUF_EUR: 0.0025 };
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
