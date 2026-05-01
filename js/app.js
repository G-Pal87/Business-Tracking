// Application bootstrap - registers modules and loads data
import { state, subscribe, setDb } from './core/state.js';
import * as github from './core/github.js';
import * as router from './core/router.js';
import { toast } from './core/ui.js';
import { requireAuth, clearSession } from './core/auth.js';

const VERSION = window._appV || '20260422b';

async function boot() {
  const [
    { default: properties },
    { default: payments },
    { default: expenses },
    { default: reports },
    { default: forecast },
    { default: analytics },
    { default: analyticsRevenue },
    { default: analyticsExpenses },
    { default: analyticsProperties },
    { default: analyticsServices },
    { default: analyticsCashflow },
    { default: clients },
    { default: invoices },
    { default: settings },
    { default: vendors },
    { default: users },
    { default: inventory },
    { default: tenants }
  ] = await Promise.all([
    import(`./modules/properties.js?v=${VERSION}`),
    import(`./modules/payments.js?v=${VERSION}`),
    import(`./modules/expenses.js?v=${VERSION}`),
    import(`./modules/reports.js?v=${VERSION}`),
    import(`./modules/forecast.js?v=${VERSION}`),
    import(`./modules/analytics.js?v=${VERSION}`),
    import(`./modules/analytics-revenue.js?v=${VERSION}`),
    import(`./modules/analytics-expenses.js?v=${VERSION}`),
    import(`./modules/analytics-properties.js?v=${VERSION}`),
    import(`./modules/analytics-services.js?v=${VERSION}`),
    import(`./modules/analytics-cashflow.js?v=${VERSION}`),
    import(`./modules/clients.js?v=${VERSION}`),
    import(`./modules/invoices.js?v=${VERSION}`),
    import(`./modules/settings.js?v=${VERSION}`),
    import(`./modules/vendors.js?v=${VERSION}`),
    import(`./modules/users.js?v=${VERSION}`),
    import(`./modules/inventory.js?v=${VERSION}`),
    import(`./modules/tenants.js?v=${VERSION}`)
  ]);

  const MODULES = [
    properties, payments, expenses, tenants, vendors, inventory,
    reports, forecast, analytics, analyticsRevenue, analyticsExpenses, analyticsProperties, analyticsServices, analyticsCashflow, clients, invoices, settings, users
  ];

  MODULES.forEach(router.registerModule);
  buildSidebar(MODULES);
  initMobileNav();

  github.loadConfig();

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

  await requireAuth();
  buildUserFooter();

  router.init(document.getElementById('content'));

  let pushTimer = null;
  let pendingDirty = false;
  let saveFailCount = 0;

  const doSave = async () => {
    if (state.saving) return;
    state.saving = true;
    pendingDirty = false;
    document.body.classList.add('app-saving');
    try {
      updateSyncStatus('syncing', 'Saving…');
      await github.pushDb(state.db, 'Auto-sync from app');
      state.dirty = false;
      saveFailCount = 0;
      updateSyncStatus('online', `Saved ${new Date().toLocaleTimeString()}`);
    } catch (e) {
      saveFailCount++;
      if (e.name === 'ConflictError') {
        pendingDirty = false;
        clearTimeout(pushTimer);
        updateSyncStatus('offline', 'Conflict — refresh required');
        toast(
          'Another user modified the same data. Refresh the page to load the latest version before saving your changes.',
          'danger',
          10000
        );
      } else {
        updateSyncStatus('offline', 'Save failed — ' + e.message);
        // Only show the toast on the first failure; status bar stays updated on subsequent ones
        if (saveFailCount === 1) {
          toast('Save failed: ' + e.message, 'danger', 6000);
        }
      }
    } finally {
      state.saving = false;
      document.body.classList.remove('app-saving');
      // If changes arrived while the save was in-flight, do one follow-up save
      if (pendingDirty) {
        pendingDirty = false;
        pushTimer = setTimeout(doSave, 300);
      }
    }
  };

  subscribe(evt => {
    if (evt === 'dirty') {
      github.saveLocalCache(state.db);
      if (state.github.token && state.github.owner && state.github.repo) {
        if (state.saving) {
          // Save in progress — flag for a follow-up save once it finishes
          pendingDirty = true;
        } else {
          // Debounce: reset the timer on every change so rapid edits
          // collapse into a single network request
          clearTimeout(pushTimer);
          pushTimer = setTimeout(doSave, 1500);
        }
      } else {
        updateSyncStatus('offline', 'Unsaved — connect GitHub in Settings');
      }
    }
  });
}

function buildUserFooter() {
  const footer = document.querySelector('.sidebar-footer');
  if (!footer || !state.session) return;
  const existing = document.getElementById('user-footer');
  if (existing) existing.remove();
  const wrap = document.createElement('div');
  wrap.id = 'user-footer';
  wrap.style.cssText = 'padding:10px 16px 0;border-top:1px solid var(--border);margin-top:8px';
  const nameEl = document.createElement('div');
  nameEl.style.cssText = 'font-size:12px;font-weight:600;color:var(--text);margin-bottom:2px';
  nameEl.textContent = state.session.name || state.session.username;
  const roleEl = document.createElement('div');
  roleEl.style.cssText = 'font-size:11px;color:var(--text-muted);margin-bottom:8px';
  roleEl.textContent = state.session.role;
  const logoutBtn = document.createElement('button');
  logoutBtn.className = 'btn';
  logoutBtn.style.cssText = 'width:100%;font-size:11px;padding:4px 8px';
  logoutBtn.textContent = 'Sign Out';
  logoutBtn.onclick = () => { clearSession(); location.reload(); };
  wrap.appendChild(nameEl);
  wrap.appendChild(roleEl);
  wrap.appendChild(logoutBtn);
  footer.insertBefore(wrap, footer.firstChild);
}

function buildSidebar(MODULES) {
  const navGroups = [
    { title: 'Analysis', items: ['analytics', 'analytics-revenue', 'analytics-expenses', 'analytics-properties', 'analytics-services', 'analytics-cashflow'] },
    { title: 'Operations', items: ['properties', 'payments', 'expenses', 'tenants', 'vendors', 'inventory', 'clients', 'invoices', 'forecast'] },
    { title: 'Reports', items: ['reports'] },
    { title: 'System', items: ['settings', 'users'] }
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

function initMobileNav() {
  const btn      = document.getElementById('mobile-menu-btn');
  const backdrop = document.getElementById('mobile-backdrop');
  const nav      = document.getElementById('nav');

  const open  = () => document.body.classList.add('nav-open');
  const close = () => document.body.classList.remove('nav-open');

  btn?.addEventListener('click', () => {
    document.body.classList.toggle('nav-open');
  });
  backdrop?.addEventListener('click', close);
  nav?.addEventListener('click', close);
}

function updateSyncStatus(state, message) {
  const dot = document.getElementById('sync-dot');
  const text = document.getElementById('sync-text');
  if (dot) dot.className = 'sync-dot ' + state;
  if (text) text.textContent = message;
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
