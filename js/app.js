// Application bootstrap - registers modules and loads data
import { state, subscribe, setDb } from './core/state.js';
import * as github from './core/github.js';
import * as router from './core/router.js';
import { toast } from './core/ui.js';

import dashboard from './modules/dashboard.js';
import properties from './modules/properties.js';
import payments from './modules/payments.js';
import expenses from './modules/expenses.js';
import reports from './modules/reports.js';
import forecast from './modules/forecast.js';
import clients from './modules/clients.js';
import invoices from './modules/invoices.js';
import insights from './modules/insights.js';
import settings from './modules/settings.js';
import vendors from './modules/vendors.js';

const MODULES = [
  dashboard, properties, payments, expenses, vendors,
  reports, forecast, clients, invoices, insights, settings
];

async function boot() {
  // Register modules
  MODULES.forEach(router.registerModule);
  buildSidebar();

  // Load GitHub config
  github.loadConfig();

  // Initial data load - try GitHub first, fall back to local db.json, then localStorage
  let loaded = false;
  if (state.github.owner && state.github.repo) {
    try {
      const db = await github.fetchDb();
      setDb(db);
      github.saveLocalCache(db);
      loaded = true;
      updateSyncStatus('online', `Connected: ${state.github.owner}/${state.github.repo}`);
    } catch (e) {
      console.warn('GitHub load failed, falling back', e);
      updateSyncStatus('offline', 'GitHub unreachable - using cache');
    }
  }
  if (!loaded) {
    try {
      const db = await github.fetchLocalDb();
      if (db) { setDb(db); loaded = true; }
    } catch (e) { console.warn(e); }
  }
  if (!loaded) {
    setDb({});
    updateSyncStatus('offline', 'Offline - configure GitHub in Settings');
  } else if (!state.github.connected) {
    updateSyncStatus('offline', 'Local only - connect GitHub in Settings');
  }

  // Init router
  router.init(document.getElementById('content'));

  // Auto-push on dirty if connected
  let pushTimer = null;
  subscribe(evt => {
    if (evt === 'dirty') {
      github.saveLocalCache(state.db);
      if (state.github.token && state.github.owner && state.github.repo) {
        clearTimeout(pushTimer);
        pushTimer = setTimeout(async () => {
          try {
            updateSyncStatus('syncing', 'Syncing to GitHub...');
            await github.pushDb(state.db, 'Auto-sync from app');
            state.dirty = false;
            updateSyncStatus('online', `Synced ${new Date().toLocaleTimeString()}`);
          } catch (e) {
            updateSyncStatus('offline', 'Sync failed - ' + e.message);
            toast('Sync failed: ' + e.message, 'danger', 4000);
          }
        }, 1500);
      } else {
        updateSyncStatus('offline', 'Unsaved - connect GitHub');
      }
    }
  });
}

function buildSidebar() {
  const navGroups = [
    { title: 'Overview', items: ['dashboard', 'insights'] },
    { title: 'Real Estate', items: ['properties', 'payments', 'expenses', 'vendors'] },
    { title: 'Analysis', items: ['reports', 'forecast'] },
    { title: 'Business Services', items: ['clients', 'invoices'] },
    { title: 'System', items: ['settings'] }
  ];
  const nav = document.getElementById('nav');
  nav.innerHTML = '';
  const modules = new Map();
  MODULES.forEach(m => modules.set(m.id, m));

  for (const group of navGroups) {
    const section = document.createElement('div');
    section.className = 'nav-section';
    section.textContent = group.title;
    nav.appendChild(section);
    const list = document.createElement('div');
    list.className = 'nav';
    for (const id of group.items) {
      const mod = modules.get(id);
      if (!mod) continue;
      const item = document.createElement('div');
      item.className = 'nav-item';
      item.dataset.route = id;
      item.innerHTML = `<span class="nav-item-icon">${mod.icon || ''}</span><span>${mod.label}</span>`;
      item.onclick = () => router.navigate(id);
      list.appendChild(item);
    }
    nav.appendChild(list);
  }
}

function updateSyncStatus(state, message) {
  const dot = document.getElementById('sync-dot');
  const text = document.getElementById('sync-text');
  if (dot) dot.className = 'sync-dot ' + state;
  if (text) text.textContent = message;
}

// Boot when DOM ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
