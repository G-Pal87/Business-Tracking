// Application bootstrap - registers modules and loads data
import { state, subscribe, setDb, markDirty } from './core/state.js';
import { autoPurgeOldDeleted } from './core/data.js';
import * as github from './core/github.js';
import * as router from './core/router.js';
import { toast } from './core/ui.js';
import { requireAuth, clearSession } from './core/auth.js';
import { startPresence } from './core/presence.js';

const VERSION = window._appV || '20260702';

async function boot() {
  const [
    { default: properties },
    { default: payments },
    { default: expenses },
    { default: reconciliation },
    { default: forecast },
    { default: analytics },
    { default: analyticsRevenue },
    { default: analyticsExpenses },
    { default: analyticsProperties },
    { default: analyticsServices },
    { default: analyticsCashflow },
    { default: analyticsForecast },

    { default: analyticsOwner },
    { default: analyticsPersonal },
    { default: analyticsTax },
    { default: clients },
    { default: invoices },
    { default: timeOff },
    { default: settings },
    { default: vendors },
    { default: users },
    { default: inventory },
    { default: tenants },
    { default: dividends },
    { default: companyStructure },
    { default: strRates },
    { default: analyticsStr }
  ] = await Promise.all([
    import(`./modules/properties.js?v=${VERSION}`),
    import(`./modules/payments.js?v=${VERSION}`),
    import(`./modules/expenses.js?v=${VERSION}`),
    import(`./modules/reconciliation.js?v=${VERSION}`),
    import(`./modules/forecast.js?v=${VERSION}`),
    import(`./modules/analytics.js?v=${VERSION}`),
    import(`./modules/analytics-revenue.js?v=${VERSION}`),
    import(`./modules/analytics-expenses.js?v=${VERSION}`),
    import(`./modules/analytics-properties.js?v=${VERSION}`),
    import(`./modules/analytics-services.js?v=${VERSION}`),
    import(`./modules/analytics-cashflow.js?v=${VERSION}`),
    import(`./modules/analytics-forecast.js?v=${VERSION}`),

    import(`./modules/analytics-owner.js?v=${VERSION}`),
    import(`./modules/analytics-personal.js?v=${VERSION}`),
    import(`./modules/analytics-tax.js?v=${VERSION}`),
    import(`./modules/clients.js?v=${VERSION}`),
    import(`./modules/invoices.js?v=${VERSION}`),
    import(`./modules/time-off.js?v=${VERSION}`),
    import(`./modules/settings.js?v=${VERSION}`),
    import(`./modules/vendors.js?v=${VERSION}`),
    import(`./modules/users.js?v=${VERSION}`),
    import(`./modules/inventory.js?v=${VERSION}`),
    import(`./modules/tenants.js?v=${VERSION}`),
    import(`./modules/dividends.js?v=${VERSION}`),
    import(`./modules/company-structure.js?v=${VERSION}`),
    import(`./modules/str-rates.js?v=${VERSION}`),
    import(`./modules/analytics-str.js?v=${VERSION}`)
  ]);

  const MODULES = [
    properties, payments, strRates, expenses, dividends, tenants, vendors, inventory, companyStructure,
    reconciliation, forecast, analytics, analyticsRevenue, analyticsExpenses, analyticsProperties, analyticsServices, analyticsCashflow, analyticsForecast, analyticsOwner, analyticsPersonal, analyticsTax, analyticsStr, clients, invoices, timeOff, settings, users
  ];

  MODULES.forEach(router.registerModule);
  buildSidebar(MODULES);
  initMobileNav();

  github.loadConfig();

  let loaded = false;
  let needAutoSave = false;
  let initialSyncDone = false;
  let pendingSaveBeforeSync = false;

  // ── Phase 0: bootstrap from URL hash setup link (works for any hosting setup)
  // Admin generates this link via Settings → GitHub Storage → "Copy Setup Link"
  // and shares it with new users once. Format: #/setup?owner=…&repo=…&branch=…
  {
    const hash = window.location.hash;
    if (hash.includes('/setup?') || hash.startsWith('#setup?')) {
      try {
        const qs = hash.slice(hash.indexOf('?') + 1);
        const p  = new URLSearchParams(qs);
        if (p.get('owner')) {
          // Always override — setup link is the authoritative source
          state.github.owner  = p.get('owner');
          state.github.repo   = p.get('repo')   || '';
          state.github.branch = p.get('branch') || 'main';
          state.github.dbPath = p.get('path')   || 'data/db.json';
          if (p.get('token')) state.github.token = p.get('token');
          // Save to localStorage so subsequent loads don't need the link again
          github.saveConfig({
            owner:  state.github.owner,
            repo:   state.github.repo,
            branch: state.github.branch,
            dbPath: state.github.dbPath,
            token:  state.github.token
          });
          // Remove setup params from the URL bar
          history.replaceState(null, '', window.location.pathname + window.location.search);
        }
      } catch { /* ignore malformed hash */ }
    }
  }

  // ── Phase 1: load from local cache instantly (< 1 ms if localStorage is warm)
  const localCache = await github.fetchLocalDb();
  // Deep-clone before setDb() shares its array references with state.db.
  // migrateDb() mutates those shared objects (stamps updatedAt = now), which
  // would make every stale local record look newer than remote during Phase 4 merge.
  const localSnapshot = localCache ? structuredClone(localCache) : null;
  if (localCache) {
    setDb(localCache);
    github.applyDbConfig(localCache.appConfig?.github);
    loaded = true;
  }

  // ── Phase 1.5: if still no GitHub owner/repo, try bootstrap config file
  // (written by the admin when they first save Settings → GitHub Storage)
  if (!state.github.owner) {
    try {
      const res = await fetch('data/github-config.json', { cache: 'no-store' });
      if (res.ok) {
        const cfg = await res.json();
        if (cfg.owner) {
          if (!state.github.owner)  state.github.owner  = cfg.owner;
          if (!state.github.repo)   state.github.repo   = cfg.repo   || '';
          if (!state.github.branch) state.github.branch = cfg.branch || 'main';
          if (!state.github.dbPath) state.github.dbPath = cfg.path   || 'data/db.json';
        }
      }
    } catch { /* ignore */ }
  }

  // ── Phase 2: if no local cache, block on GitHub once (first-ever load)
  if (!loaded && state.github.owner && state.github.repo) {
    try {
      const remoteDb = await github.fetchDb();
      remoteDb._syncedAt = Date.now();
      setDb(remoteDb);
      github.applyDbConfig(remoteDb.appConfig?.github);
      github.saveLocalCache(remoteDb);
      loaded = true;
      initialSyncDone = true;
      updateSyncStatus('online', `Connected: ${state.github.owner}/${state.github.repo}`);
    } catch (e) {
      console.warn('GitHub load failed, no local cache available', e);
      state.github.lastSyncError = normalizeNetworkError(e.message);
      initialSyncDone = true; // unblock saves — GitHub is unreachable, not a sync issue
    }
  }

  if (!loaded) {
    setDb({});
    if (state.github.owner && state.github.repo) {
      updateSyncStatus('offline', 'GitHub unreachable — no local data available');
    } else {
      updateSyncStatus('offline', 'Offline — configure GitHub in Settings');
    }
  } else if (!state.github.connected) {
    // Loaded from local cache — show a "syncing" hint until background fetch completes
    if (state.github.owner && state.github.repo) {
      updateSyncStatus('syncing', 'Pulling from GitHub…');
    } else {
      updateSyncStatus('offline', 'Local only — configure GitHub in Settings');
    }
  }

  // ── Phase 3: auth + render — runs immediately when local cache was available
  await requireAuth();
  buildUserFooter();

  router.init(document.getElementById('content'));

  // ── Phase 4: multi-user presence (Operations + System views only)
  if (state.github.token) startPresence();

  let pushTimer = null;
  let saveFailCount = 0;
  let pushPending = false; // true while doSave is queued or running
  let ratesFeedTimer = null; // debounce for auto-publishing the STR daily-rate feeds

  // After a real data push, re-publish the STR daily-rate feeds. Debounced so a
  // burst of edits results in a single publish; the publisher itself only
  // uploads feeds whose rates actually changed, so unrelated edits are no-ops.
  const scheduleRatesFeedPublish = () => {
    clearTimeout(ratesFeedTimer);
    ratesFeedTimer = setTimeout(() => {
      ratesFeedTimer = null;
      import(`./modules/str-rates.js?v=${VERSION}`)
        .then(m => m.autoPublishRatesFeeds?.())
        .catch(() => { /* best-effort; never block sync */ });
    }, 1000);
  };

  const doSave = async () => {
    if (!initialSyncDone) {
      pendingSaveBeforeSync = true;
      updateSyncStatus('syncing', 'Waiting for pull before pushing…');
      return;
    }
    pushPending = true;
    clearTimeout(pushTimer);
    pushTimer = null;
    state.saving = true;
    document.body.classList.add('app-saving');
    let hadNewChanges = false;
    try {
      updateSyncStatus('syncing', 'Pushing to GitHub…');
      await github.pushDb('Auto-sync from app');
      hadNewChanges = state.dirty; // true if markDirty() fired during the push
      state.dirty = false;
      saveFailCount = 0;
      state.github.lastSyncError = null;
      scheduleRatesFeedPublish(); // keep the public daily-rate feeds current
      if (!hadNewChanges) {
        updateSyncStatus('online', `Pushed to GitHub at ${new Date().toLocaleTimeString()}`);
      }
    } catch (e) {
      saveFailCount++;
      state.github.lastSyncError = normalizeNetworkError(e.message);
      if (e.name === 'ConflictError') {
        clearTimeout(pushTimer);
        pushTimer = null;
        updateSyncStatus('offline', 'Push conflict — refresh required', true);
        const cols = [...new Set((e.conflicts || []).map(c => c.collection))];
        const detail = cols.length ? ` Affected: ${cols.join(', ')}.` : '';
        toast(
          `Another user modified the same data.${detail} Refresh the page to load the latest — your unsaved changes may need to be re-entered.`,
          'danger',
          15000
        );
      } else {
        updateSyncStatus('offline', 'Push failed — changes saved locally only', true);
        if (saveFailCount === 1) {
          toast('Save failed: ' + e.message, 'danger', 6000);
        }
      }
      throw e;
    } finally {
      state.saving = false;
      pushPending = false;
      document.body.classList.remove('app-saving');
    }

    // Changes arrived during the push — do one more push immediately instead
    // of waiting for the subscriber's 1.5 s timer to fire again.
    if (hadNewChanges && state.github.token && state.github.owner && state.github.repo) {
      doSave().catch(() => {});
    }
  };

  state.github.syncNow = doSave;

  // ── Live convergence: re-pull others' changes when it's safe to do so ───────
  // A full re-pull replaces the local view with everyone's latest. We only do it
  // when there is nothing to lose: no unsaved/dirty edits, no push in flight, the
  // tab is visible, and no modal/form is open (so we never yank the UI out from
  // under the user). When the user IS dirty, the imminent push already fetches +
  // 3-way-merges the current remote, so their changes converge safely there.
  let resyncing = false;
  const backgroundResync = async () => {
    if (resyncing) return;
    if (!initialSyncDone) return;
    if (!state.github.token || !state.github.owner || !state.github.repo) return;
    if (state.dirty || pushPending || state.saving || pendingSaveBeforeSync) return;
    if (typeof document !== 'undefined' && document.hidden) return;
    if (document.querySelector('.modal-overlay.open')) return; // don't disrupt an open form/dialog
    resyncing = true;
    try {
      const remoteDb = await github.fetchDb();          // also refreshes sha + remoteDb base
      // Re-check after the await — the user may have started editing meanwhile.
      if (state.dirty || pushPending || state.saving || document.querySelector('.modal-overlay.open')) return;
      // resyncDb: pure last-writer-wins by updatedAt — no 3-way base.
      // This prevents CDN-stale responses from overwriting locally-held records
      // that were saved more recently. If local.updatedAt > remote.updatedAt,
      // local wins regardless of whether the base (remoteDb) is fresh or stale.
      const synced = github.resyncDb(remoteDb, state.db);
      synced._syncedAt = Date.now();
      setDb(synced);                                    // triggers data-loaded → view refresh
      github.saveLocalCache(synced);
      updateSyncStatus('online', `Synced ${new Date().toLocaleTimeString()}`);
    } catch { /* offline / transient — keep working from current state */ }
    finally { resyncing = false; }
  };

  // Reconnecting: push pending offline edits (which merge against fresh remote),
  // otherwise pull everyone else's changes.
  window.addEventListener('online', () => {
    if (state.dirty || pendingSaveBeforeSync) { if (!pushPending) doSave().catch(() => {}); }
    else backgroundResync();
  });
  // Returning to the tab — surface anything that changed while it was hidden.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) backgroundResync(); });
  // Steady-state polling so long-lived sessions converge on multi-user edits.
  setInterval(backgroundResync, 60000);

  const retryBtn = document.getElementById('sync-retry');
  if (retryBtn) {
    retryBtn.onclick = () => {
      if (state.github.token && state.github.owner && state.github.repo) {
        if (!pushPending) {
          clearTimeout(pushTimer);
          pushTimer = null;
          doSave().catch(() => {});
        }
      } else {
        location.hash = 'settings';
      }
    };
  }

  subscribe(evt => {
    if (evt === 'cache-quota-exceeded') {
      updateSyncStatus('offline', 'Local cache full — purge deleted records in Settings → Data', true);
    }
    if (evt === 'dirty') {
      github.saveLocalCache(state.db);
      if (state.github.token && state.github.owner && state.github.repo) {
        if (!initialSyncDone) {
          // Initial remote sync not yet complete — queue the save for when it finishes
          pendingSaveBeforeSync = true;
          updateSyncStatus('syncing', 'Waiting for pull before pushing…');
        } else if (!pushPending) {
          // No push in flight — start the debounce timer.
          updateSyncStatus('syncing', 'Changes pending — pushing soon…');
          clearTimeout(pushTimer);
          pushTimer = setTimeout(() => { pushTimer = null; doSave().catch(() => {}); }, 300);
        }
        // If pushPending, the in-flight push will detect state.dirty and re-push
        // automatically — no need to schedule another timer.
      } else {
        updateSyncStatus('offline', 'Unsaved — connect GitHub in Settings');
      }
    }
  });

  // ── Phase 4: background GitHub sync (only when we served from local cache)
  // Runs after router.init so setDb() triggers a live refresh of the current view.
  // If Phase 4 won't run (no local cache, or GitHub not configured), unblock saves now
  if (!(loaded && localCache && state.github.owner && state.github.repo)) {
    initialSyncDone = true;
    // No Phase 4 — migrate immediately on whatever data we have
    migrateDb();
  }

  if (loaded && localCache && state.github.owner && state.github.repo) {
    (async () => {
      try {
        const remoteDb = await github.fetchDb();
        const merged = github.mergeLocalPending(remoteDb, localSnapshot);
        merged._syncedAt = Date.now(); // stamp pull time so next merge knows what's a real offline edit
        setDb(merged);                              // triggers data-loaded → view refresh
        github.applyDbConfig(merged.appConfig?.github);
        github.saveLocalCache(merged);
        updateSyncStatus('online', `Connected: ${state.github.owner}/${state.github.repo}`);
        initialSyncDone = true;
        // Discard any dirty flag that came from migrateDb() running on the stale
        // local cache before this point — that data has now been replaced by the
        // authoritative remote merge, so there is nothing to push back.
        pendingSaveBeforeSync = false;
        // Migrate the authoritative merged data. If any record truly lacks metadata
        // (e.g. a remote record pre-dating this feature), markDirty() fires now that
        // initialSyncDone=true and the normal 1.5s debounce pushes it cleanly.
        migrateDb();
        // If local had genuinely newer records that won the merge, push them now.
        if (merged._hasLocalChanges && state.github.token && !pushPending) {
          doSave().catch(() => {});
        }
      } catch (e) {
        console.warn('Background GitHub sync failed', e);
        state.github.lastSyncError = normalizeNetworkError(e.message);
        state.github.usingCache = true;
        updateSyncStatus('offline', 'Using local cache — GitHub is currently unavailable');
        pendingSaveBeforeSync = false; // GitHub unreachable — can't push anyway
        initialSyncDone = true;
        migrateDb(); // migrate local cache data for this session
      }
    })();
  }
}

// Backfills createdAt/createdBy/updatedAt/updatedBy on records that pre-date
// the metadata stamping introduced in upsert(). Only fills missing fields;
// never overwrites existing values or modifies business data.
function migrateDb() {
  const COLLECTIONS = [
    'payments', 'expenses', 'invoices', 'properties', 'tenants',
    'vendors', 'clients', 'services', 'inventory', 'forecasts', 'timeOff'
  ];
  const now = Date.now();
  const actor = state.session?.username || 'system';
  let changed = false;

  for (const col of COLLECTIONS) {
    const arr = state.db[col];
    if (!Array.isArray(arr)) continue;
    for (const item of arr) {
      if (!item.createdAt) { item.createdAt = now; changed = true; }
      if (!item.createdBy) { item.createdBy = actor; changed = true; }
      if (!item.updatedAt) { item.updatedAt = now; changed = true; }
      if (!item.updatedBy) { item.updatedBy = actor; changed = true; }
    }
  }

  // Seed default people from legacy OWNERS if no people exist
  if (!state.db.people || state.db.people.length === 0) {
    if (!state.db.people) state.db.people = [];
    state.db.people.push(
      { id: 'ppl_giorgos', name: 'Giorgos', role: 'director', sharePercent: 100, phone: '', email: '', active: true, legacyKey: 'you',  createdAt: now, createdBy: 'system', updatedAt: now, updatedBy: 'system' },
      { id: 'ppl_rita',    name: 'Rita',    role: 'director', sharePercent: 0,   phone: '', email: '', active: true, legacyKey: 'rita', createdAt: now, createdBy: 'system', updatedAt: now, updatedBy: 'system' }
    );
    changed = true;
  }
  if (!state.db.settings.dividendSettings) {
    state.db.settings.dividendSettings = [];
    changed = true;
  }

  if (changed) markDirty();

  // Reclaim space from long-deleted records (kept >5 days), preserving any
  // still referenced by an active record. Runs once per load on authoritative
  // data; the resulting markDirty() schedules a normal debounced push.
  try {
    const purged = autoPurgeOldDeleted({ maxAgeDays: 5 });
    if (purged > 0) console.info(`[BT] Auto-purged ${purged} record(s) deleted over 5 days ago`);
  } catch (e) { console.warn('autoPurgeOldDeleted failed', e); }
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
    { title: 'Analysis', items: ['analytics', 'analytics-revenue', 'analytics-expenses', 'analytics-properties', 'analytics-str', 'analytics-services', 'analytics-cashflow', 'reconciliation', 'analytics-forecast', 'analytics-owner', 'analytics-personal', 'analytics-tax'] },
    { title: 'Operations', items: ['properties', 'payments', 'str-rates', 'expenses', 'dividends', 'tenants', 'vendors', 'inventory', 'company-structure', 'clients', 'invoices', 'time-off', 'forecast'] },
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

function normalizeNetworkError(msg) {
  if (!msg || msg === 'Failed to fetch' || msg.startsWith('NetworkError') || msg.startsWith('Load failed')) {
    return 'Cannot reach GitHub — check your internet connection';
  }
  return msg;
}

function updateSyncStatus(dotState, message, showRetry = false) {
  const dot = document.getElementById('sync-dot');
  const text = document.getElementById('sync-text');
  const retry = document.getElementById('sync-retry');
  if (dot)   dot.className = 'sync-dot ' + dotState;
  if (text)  text.textContent = message;
  if (retry) retry.style.display = showRetry ? '' : 'none';
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
