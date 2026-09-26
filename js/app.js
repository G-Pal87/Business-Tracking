// Application bootstrap - registers modules and loads data
import { state, subscribe, setDb, markDirty } from './core/state.js';
import { autoPurgeOldDeleted, listActive } from './core/data.js';
import * as github from './core/github.js';
import * as router from './core/router.js';
import { toast, confirmDialog } from './core/ui.js';
import { requireAuth, clearSession } from './core/auth.js';
import { hasWrappedKeyConfigured, isUnlocked } from './core/crypto.js';
import { startPresence, recordSessionEvent } from './core/presence.js';

const VERSION = window._appV || '20260702c';

// Route manifest — what the sidebar and router need before a module's code
// has loaded. Module code is imported on first navigation (core/router.js
// loadRoute) and the rest are prefetched at idle after the first screen, so
// boot no longer downloads and evaluates all ~26 views up front.
// id/label/icon MUST mirror each module's own `export default { id, label,
// icon }` (the header title switches to the module's label once it loads).
// Adding a module: add a row here and its id to a nav group in buildSidebar().
const ROUTES = [
  { id: 'properties',           label: 'Properties',        icon: '🏠', file: 'properties.js' },
  { id: 'payments',             label: 'Property Payments', icon: '💳', file: 'payments.js' },
  { id: 'str-rates',            label: 'STR Daily Rates',   icon: '🛏️', file: 'str-rates.js' },
  { id: 'expenses',             label: 'Expenses',          icon: '💸', file: 'expenses.js' },
  { id: 'dividends',            label: 'Dividends',         icon: '💰', file: 'dividends.js' },
  { id: 'tenants',              label: 'Tenants',           icon: '👥', file: 'tenants.js' },
  { id: 'vendors',              label: 'Vendors',           icon: '🔧', file: 'vendors.js' },
  { id: 'inventory',            label: 'Inventory',         icon: '📦', file: 'inventory.js' },
  { id: 'company-structure',    label: 'Company Structure', icon: '🏢', file: 'company-structure.js' },
  { id: 'reconciliation',       label: 'Reconciliation',    icon: '⚖️', file: 'reconciliation.js' },
  { id: 'forecast',             label: 'Forecast',          icon: '🔭', file: 'forecast.js' },
  { id: 'analytics',            label: 'Executive',         icon: '📊', file: 'analytics.js' },
  { id: 'analytics-revenue',    label: 'Revenue',           icon: '📈', file: 'analytics-revenue.js' },
  { id: 'analytics-expenses',   label: 'Expenses',          icon: '📉', file: 'analytics-expenses.js' },
  { id: 'analytics-properties', label: 'Properties',        icon: '🏘️', file: 'analytics-properties.js' },
  { id: 'analytics-cashflow',   label: 'Cash Flow',         icon: '💹', file: 'analytics-cashflow.js' },
  { id: 'analytics-forecast',   label: 'Forecast',          icon: '🔮', file: 'analytics-forecast.js' },
  { id: 'analytics-owner',      label: 'Partners',          icon: '👤', file: 'analytics-owner.js' },
  { id: 'analytics-personal',   label: 'Personal Income',   icon: '💼', file: 'analytics-personal.js' },
  { id: 'analytics-tax',        label: 'Tax',               icon: '🏛️', file: 'analytics-tax.js' },
  { id: 'analytics-str',        label: 'STR Performance',   icon: '🏖️', file: 'analytics-str.js' },
  { id: 'clients',              label: 'Clients',           icon: '🤝', file: 'clients.js' },
  { id: 'invoices',             label: 'Invoices',          icon: '🧾', file: 'invoices.js' },
  { id: 'time-off',             label: 'Time Off',          icon: '\u{1F334}', file: 'time-off.js' },
  { id: 'settings',             label: 'Settings',          icon: '⚙️', file: 'settings.js' },
  { id: 'users',                label: 'Users',             icon: '👤', file: 'users.js' }
];
// Same URL for every importer (router, sidebar badge, rates-feed publisher)
// so they all share one module instance.
const moduleUrl = file => `./modules/${file}?v=${VERSION}`;
const importStrRates = () => import(moduleUrl('str-rates.js'));

async function boot() {
  const MODULES = ROUTES.map(r => ({ id: r.id, label: r.label, icon: r.icon, load: () => import(moduleUrl(r.file)) }));
  MODULES.forEach(router.registerModule);
  // Start downloading the landing route's code now, in parallel with the
  // data load / sign-in below, so it's usually ready by router.init().
  {
    const first = (location.hash || '#analytics').slice(1);
    router.loadRoute(MODULES.some(m => m.id === first) ? first : 'analytics').catch(() => {});
  }
  buildSidebar(MODULES);
  initMobileNav();

  github.loadConfig();

  let loaded = false;
  let needAutoSave = false;
  let initialSyncDone = false;
  let pendingSaveBeforeSync = false;
  // Set when unpushed edits from a pending-edits journal were applied during
  // load (see github.applyPendingJournals) — pushed once saving is wired up.
  let pushAfterBoot = false;
  // Last db.json sha whose content this tab has fully reconciled (resync or
  // push) — lets the 60s poll skip all work when nothing changed.
  let lastAppliedSha = null;

  // Confirmatory re-pull after a first-ever load (see Phase 2). Only replaces
  // data when there is provably nothing local to lose.
  const isBusy = () => state.dirty || state.saving || pendingSaveBeforeSync ||
    !!document.querySelector('.modal-overlay.open, .ms-menu.open');
  const confirmRepull = async () => {
    if (state.github.disconnected || isBusy()) return;
    const prevBase = state.github.remoteDb;
    const confirmDb = await github.fetchDb();
    // Restore the base only if nothing (e.g. a push) replaced it meanwhile —
    // otherwise this would move it backwards past that push.
    const fetchedBase = state.github.remoteDb;
    const restoreBase = () => { if (state.github.remoteDb === fetchedBase) state.github.remoteDb = prevBase; };
    if (isBusy()) { restoreBase(); return; }
    const reconciled = github.mergeLocalPending(confirmDb, structuredClone(state.db));
    const hasLocal = reconciled._hasLocalChanges;
    delete reconciled._hasLocalChanges;
    // Anything "local" here is most likely a record the first (possibly
    // stale) read missed — leave reconciliation to the next push's 3-way
    // merge instead.
    if (hasLocal) { restoreBase(); return; }
    reconciled._syncedAt = Date.now();
    if (github.deepEqual({ ...reconciled, _syncedAt: 0, _syncedPlain: 0 }, { ...state.db, _syncedAt: 0, _syncedPlain: 0 })) {
      state.db._syncedAt = reconciled._syncedAt;
      state.db._syncedPlain = reconciled._syncedPlain;
      return;
    }
    setDb(reconciled);
    github.saveLocalCache(reconciled);
  };

  // ── Phase 0: bootstrap from URL hash setup link (works for any hosting setup)
  // Admin generates this link via Settings → GitHub Storage → "Copy Setup Link"
  // and shares it with new users once. Format: #/setup?owner=…&repo=…&branch=…
  {
    const hash = window.location.hash;
    if (hash.includes('/setup?') || hash.startsWith('#setup?')) {
      try {
        const qs = hash.slice(hash.indexOf('?') + 1);
        const p  = new URLSearchParams(qs);
        // A setup link replaces this browser's GitHub settings (and token).
        // Ask first when it would change an existing setup — a crafted link
        // could otherwise point the app at someone else's repo, or swap the
        // token, just by being opened.
        const differs = state.github.owner && (
          state.github.owner !== p.get('owner') || state.github.repo !== (p.get('repo') || '') ||
          (p.get('token') && state.github.token && p.get('token') !== state.github.token));
        const accepted = !differs || await confirmDialog(
          `This link changes where this browser saves data: ${p.get('owner')}/${p.get('repo') || ''} instead of ${state.github.owner}/${state.github.repo}${p.get('token') ? ', with a different GitHub token' : ''}. Only continue if you trust whoever sent it.`,
          { title: 'Apply setup link?', danger: true, okLabel: 'Apply link' });
        if (p.get('owner') && accepted) {
          // Setup link is the authoritative source
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
        }
        // Remove setup params (and the token) from the URL bar either way
        history.replaceState(null, '', window.location.pathname + window.location.search);
      } catch { /* ignore malformed hash */ }
    }
  }

  // ── Phase 1: load from local cache instantly (< 1 ms if localStorage is warm)
  let localCache = await github.fetchLocalDb();
  // Deep-clone before setDb() shares its array references with state.db.
  // migrateDb() mutates those shared objects (stamps updatedAt = now), which
  // would make every stale local record look newer than remote during Phase 4 merge.
  let localSnapshot = localCache ? structuredClone(localCache) : null;
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
  const initialPull = async () => {
    updateSyncStatus('syncing', 'Pulling from GitHub…');
    try {
      const remoteDb = await github.fetchDb();
      remoteDb._syncedAt = Date.now();
      remoteDb._syncedPlain = github.plainFieldsOf(remoteDb);
      // Unpushed edits kept in pending-edits journals (e.g. the full cache
      // didn't fit in localStorage) — re-apply them on top and push.
      if (isUnlocked() && await github.applyPendingJournals(remoteDb)) pushAfterBoot = true;
      setDb(remoteDb);
      github.applyDbConfig(remoteDb.appConfig?.github);
      github.saveLocalCache(remoteDb);
      loaded = true;
      initialSyncDone = true;
      if (!pushAfterBoot) lastAppliedSha = state.github.lastFetchedSha;
      updateSyncStatus('online', `Connected: ${state.github.owner}/${state.github.repo}`);
      // GitHub's Contents API can occasionally serve a read that lags a few
      // seconds behind the very latest commit — documented eventual-consistency
      // behavior on their end, confirmed elsewhere in this file (see mergeDb's
      // "232 records reading a remote updatedAt from over an hour earlier"
      // comment). Every OTHER pull path in this app has a follow-up check for
      // exactly this (backgroundResync's _staleFetch, Phase 4's own merge below)
      // — this was the one exception: a brand-new device's very first load had
      // nothing to catch it, so a lagging read here just silently became the
      // permanent view with no self-correction, looking like the save was lost.
      // A confirmatory re-pull moments later, merged the same way Phase 4
      // already does, catches up if the first read was stale. The lag isn't a
      // fixed duration though — a single retry at a fixed delay can itself
      // land inside the lag window, which is exactly why "log out, log back
      // in" could still show stale data while a later manual refresh
      // (naturally further past the write) did not. Retrying several times
      // over a longer window self-heals regardless of how long that
      // particular lag turns out to be, instead of requiring the user to
      // notice and refresh by hand.
      //
      // Each re-pull merges against the CURRENT state.db (not the first-load
      // snapshot) and is skipped entirely while anything is unsaved or being
      // pushed, or a form is open — it used to setDb() unconditionally, which
      // silently discarded anything the user had entered in those first
      // seconds (and reset editSeq under an in-flight push).
      for (const delay of [3000, 8000, 20000]) {
        setTimeout(() => { confirmRepull().catch(() => {}); }, delay);
      }
    } catch (e) {
      console.warn('GitHub load failed, no local cache available', e);
      if (e.code === 'NO_ENC_KEY') state.github.needsEncKey = true;
      state.github.lastSyncError = normalizeNetworkError(e.message);
      initialSyncDone = true; // unblock saves — GitHub is unreachable, not a sync issue
    }
  };

  // The local cache is encrypted: on a device with a key, nothing can be read
  // (cache or GitHub) until sign-in unlocks it. requireAuth() then calls this.
  const loadAfterUnlock = async () => {
    if (loaded) return;
    const cached = await github.openPendingEncryptedCache();
    if (cached) {
      localCache = cached;
      localSnapshot = structuredClone(cached);
      setDb(cached);
      github.applyDbConfig(cached.appConfig?.github);
      loaded = true;
      return;
    }
    if (state.github.owner && state.github.repo) await initialPull();
    if (!loaded) throw new Error(state.github.lastSyncError || 'Could not load data — check your connection and try again.');
  };
  const unlockFirst = !loaded && hasWrappedKeyConfigured() && !isUnlocked();

  if (!loaded && !unlockFirst && state.github.owner && state.github.repo) await initialPull();

  if (!loaded) {
    setDb({});
    if (unlockFirst) {
      updateSyncStatus('syncing', 'Sign in to load your data');
    } else if (state.github.owner && state.github.repo) {
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

  // The subscribe() 'data-loaded' hook below is registered after this point,
  // so it can't catch the setDb() calls above — refresh explicitly now that
  // real data (if any) has landed.
  scheduleStrGapBadge();

  // ── Phase 3: auth + render — runs immediately when local cache was available
  await requireAuth({ loadAfterUnlock });
  // requireAuth() may have retried and successfully loaded real data along the
  // way (e.g. this device needed the encryption key, entered via the bootstrap
  // unlock screen) — but that retry lives in auth.js and never touches this
  // sidebar status, so without this it stays stuck showing Phase 2's earlier
  // failure ("GitHub unreachable") even though the data actually loaded fine.
  if (state.github.connected) {
    updateSyncStatus('online', `Connected: ${state.github.owner}/${state.github.repo}`);
  }
  buildUserFooter();

  router.init(document.getElementById('content'));
  // Warm the remaining views' code at idle so later navigation stays instant.
  router.prefetchAll();

  // ── Phase 4: multi-user presence (Operations + System views only)
  if (state.github.token) startPresence();

  let pushTimer = null;
  let saveFailCount = 0;
  let lastFailToastAt = 0;
  const FAIL_TOAST_INTERVAL_MS = 2 * 60 * 1000; // re-remind at most every 2 min while sync stays broken
  let pushPending = false; // true while doSave is queued or running
  let retryTimer = null;    // automatic retry after a failed push (see doSave)
  let ratesFeedTimer = null; // debounce for auto-publishing the STR daily-rate feeds
  // Edits are batched: a push starts this long after the LAST edit (and at
  // the latest MAX_PUSH_WAIT_MS after the first unpushed one), instead of
  // after every edit — each push is a full commit of the encrypted db.json,
  // so a burst of edits used to become a burst of multi-100KB commits. Every
  // edit still reaches the local cache within ~0.5s (see the 'dirty'
  // handler), and hiding/backgrounding the tab (visibilitychange — the reliable signal
  // on mobile), pagehide and beforeunload all flush the pending push at once.
  const PUSH_DEBOUNCE_MS = 10000;
  const MAX_PUSH_WAIT_MS = 60000;
  let firstPendingAt = 0;
  const schedulePush = () => {
    if (!firstPendingAt) firstPendingAt = Date.now();
    const wait = Math.max(0, Math.min(PUSH_DEBOUNCE_MS, firstPendingAt + MAX_PUSH_WAIT_MS - Date.now()));
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => { pushTimer = null; doSave().catch(() => {}); }, wait);
  };

  // Starts the batched push now instead of waiting out the debounce — for a
  // tab that is being hidden/closed and may never get to run the timer.
  const flushPendingPush = () => {
    if (pushTimer && !pushPending) { clearTimeout(pushTimer); pushTimer = null; doSave().catch(() => {}); }
  };

  // Warn before closing/navigating away with edits that haven't been
  // confirmed-pushed to GitHub yet — without this, an edit made in the last
  // moment before closing the tab could be lost silently (the push is
  // debounced PUSH_DEBOUNCE_MS, the local-cache write 500ms).
  window.addEventListener('beforeunload', e => {
    flushPendingPush();
    // Force the debounced local-cache write to happen NOW. Without this, a
    // refresh/close inside its 500ms window abandons the write entirely —
    // the warning below doesn't block a user who dismisses it (and many
    // browsers skip the prompt outright without recent interaction), so the
    // flush must not depend on the warning actually stopping anything.
    github.flushLocalCache();
    if (state.dirty) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  // After a real data push, re-publish the STR daily-rate feeds. Debounced so a
  // burst of edits results in a single publish; the publisher itself only
  // uploads feeds whose rates actually changed, so unrelated edits are no-ops.
  const scheduleRatesFeedPublish = () => {
    clearTimeout(ratesFeedTimer);
    ratesFeedTimer = setTimeout(() => {
      ratesFeedTimer = null;
      importStrRates()
        .then(m => m.autoPublishRatesFeeds?.())
        .catch(() => { /* best-effort; never block sync */ });
    }, 1000);
  };

  const doSave = async () => {
    // Kicked by Settings → "Disconnect other sessions" from elsewhere. This
    // tab must not push again — it's exactly what let a stale, pre-fix session
    // keep reverting someone else's saves; local edits still exist, they just
    // wait for the user to reload rather than fight over data/db.json.
    if (state.github.disconnected) {
      updateSyncStatus('offline', 'Disconnected remotely — reload to resync', true);
      return;
    }
    if (!initialSyncDone) {
      pendingSaveBeforeSync = true;
      updateSyncStatus('syncing', 'Waiting for pull before pushing…');
      return;
    }
    pushPending = true;
    clearTimeout(pushTimer);
    pushTimer = null;
    firstPendingAt = 0;
    state.saving = true;
    document.body.classList.add('app-saving');
    let hadNewChanges = false;
    try {
      updateSyncStatus('syncing', 'Pushing to GitHub…');
      const result = await github.pushDb('Auto-sync from app');
      // state.dirty alone can't tell "still true from the edit that triggered this
      // push" apart from "a new edit landed mid-push" — it's only ever set true,
      // never touched again until here, so it reads true after every push regardless.
      // Comparing editSeq against the value pushDb captured at snapshot time detects
      // genuinely new edits instead, so an unrelated push no longer re-triggers itself.
      hadNewChanges = state.editSeq !== result.editSeqAtSnapshot;
      state.dirty = hadNewChanges;
      lastAppliedSha = state.github.sha;
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
        // Full per-record detail so a real conflict can be diagnosed straight from
        // the console — copy/paste this table if reporting the issue.
        console.error('[BT] Sync conflict — conflicting records:', e.conflicts);
        if (typeof console.table === 'function' && (e.conflicts || []).length) console.table(e.conflicts);
        // Reloading resolves this by keeping whichever side has the later
        // timestamp — it does not re-check for the conflict. If the other
        // side's edit happens to be newer, reloading can silently discard
        // yours with no further warning, so say that plainly rather than
        // implying "refresh" is a clean, lossless fix.
        const actorMsg = describeConflictActors(e.conflicts);
        toast(
          `${actorMsg}${detail} Reloading will keep whichever edit was made more recently — it won't ask you to choose. ` +
          `Check before reloading if you want to make sure your change isn't the one that gets dropped.`,
          'danger',
          20000
        );
      } else {
        updateSyncStatus('offline', e.code === 'KEY_MISMATCH'
          ? 'Encryption key changed elsewhere — paste the new key in Settings → Encryption'
          : e.code === 'NEWER_FORMAT' ? 'App updated — reload the page to keep saving'
          : e.code === 'UNSUPPORTED_BROWSER' ? 'Browser too old to read the data — update it'
          : e.code === 'PLAINTEXT_REMOTE' ? 'db.json on GitHub was changed outside the app — not saving'
          : 'Push failed — changes saved locally only', true);
        // Retry on its own with backoff. A transient failure (5xx, rate limit,
        // dropped connection) used to leave the edit stranded until the next
        // edit, an 'online' event or a manual Retry click — and while dirty,
        // backgroundResync also stands down, so the tab stopped converging.
        // Key problems can't fix themselves by retrying, so skip those.
        if (!['NO_ENC_KEY', 'KEY_MISMATCH', 'NEWER_FORMAT', 'UNSUPPORTED_BROWSER', 'PLAINTEXT_REMOTE'].includes(e.code)) {
          clearTimeout(retryTimer);
          const delay = Math.min(120000, 5000 * 2 ** Math.min(5, saveFailCount - 1));
          retryTimer = setTimeout(() => {
            retryTimer = null;
            if (state.dirty && !pushPending && !state.github.disconnected) doSave().catch(() => {});
          }, delay);
        }
        // Re-remind periodically instead of only once ever — a persistently
        // broken sync (expired token, revoked access) previously announced
        // itself exactly once and then went silent for the rest of the
        // session, with only a small sidebar dot indicating anything was wrong.
        const now = Date.now();
        if (saveFailCount === 1 || now - lastFailToastAt > FAIL_TOAST_INTERVAL_MS) {
          lastFailToastAt = now;
          toast('Save failed: ' + e.message + ' — changes are only saved to this browser until this is fixed.', 'danger', 8000);
        }
      }
      throw e;
    } finally {
      state.saving = false;
      pushPending = false;
      document.body.classList.remove('app-saving');
    }

    // Changes arrived during the push — schedule the next batch.
    if (hadNewChanges && state.github.token && state.github.owner && state.github.repo) {
      schedulePush();
    }
  };

  state.github.syncNow = doSave;

  // ── Live convergence: re-pull others' changes when it's safe to do so ───────
  // A full re-pull replaces the local view with everyone's latest. We only do it
  // when there is nothing to lose: no unsaved/dirty edits, no push in flight, the
  // tab is visible, and no modal/form is open (so we never yank the UI out from
  // under the user). When the user IS dirty, the imminent push already fetches +
  // 3-way-merges the current remote, so their changes converge safely there.
  // Cheap check for "did this poll actually bring back different data" — lets
  // backgroundResync skip the setDb()/data-loaded rebuild (which tears down
  // whatever dashboard is currently open) when the remote is unchanged, which
  // is the common case for a 60s steady-state poll.
  // Order-insensitive for object keys (github.deepEqual) — JSON.stringify
  // compared key order too, so a merge that rebuilt a record with its keys in
  // a different order read as "changed" and forced a full re-render.
  function sameDbContent(a, b) {
    try { return github.deepEqual({ ...a, _syncedAt: 0, _syncedPlain: 0 }, { ...b, _syncedAt: 0, _syncedPlain: 0 }); }
    catch { return false; } // be conservative — treat as changed on any comparison failure
  }

  let resyncing = false;
  const backgroundResync = async () => {
    if (state.github.disconnected) return; // kicked — no further GitHub activity from this tab
    if (resyncing) return;
    if (!initialSyncDone) return;
    if (!state.github.token || !state.github.owner || !state.github.repo) return;
    if (state.dirty || pushPending || state.saving || pendingSaveBeforeSync) return;
    if (typeof document !== 'undefined' && document.hidden) return;
    // Open (asleep) for longer than tombstones are kept: records deleted
    // elsewhere in the meantime may no longer carry a tombstone, and this
    // tab would push them back. A reload re-derives everything safely.
    if (state.github.lastPulledAt && Date.now() - state.github.lastPulledAt > 20 * 24 * 60 * 60 * 1000) {
      await github.flushLocalCache();
      location.reload();
      return;
    }
    // Don't disrupt an open form/dialog, or an open filter dropdown — a full
    // view refresh rebuilds buildMultiSelect() widgets from scratch, which
    // would silently collapse whichever one the user has open (see ui.js
    // buildMultiSelect's 'ms-menu open' class).
    if (document.querySelector('.modal-overlay.open, .ms-menu.open')) return;
    resyncing = true;
    // fetchDb() advances the merge base (remoteDb). If we then bail out
    // without applying the fetched data to state.db, the base would be AHEAD
    // of state.db — and the next push would read other users' changes as
    // "only local changed" and silently revert them. Restore it on bail-out.
    const prevBase = state.github.remoteDb;
    try {
      const remoteDb = await github.fetchDb({ conditional: true }); // also refreshes sha + remoteDb base
      const fetchedBase = state.github.remoteDb;
      // Re-check after the await — the user may have started editing meanwhile.
      // Restore the base only if nothing (e.g. a push) replaced it meanwhile.
      if (state.dirty || pushPending || state.saving || document.querySelector('.modal-overlay.open, .ms-menu.open')) {
        if (state.github.remoteDb === fetchedBase) state.github.remoteDb = prevBase;
        return;
      }
      // Same db.json as the last one this tab reconciled — nothing to do
      // (skips the whole-database diff every 60s on an idle tab).
      if (state.github.lastFetchedSha && state.github.lastFetchedSha === lastAppliedSha) {
        updateSyncStatus('online', `Synced ${new Date().toLocaleTimeString()}`);
        return;
      }
      // resyncDb: pure last-writer-wins by updatedAt — no 3-way base.
      // This prevents CDN-stale responses from overwriting locally-held records
      // that were saved more recently. If local.updatedAt > remote.updatedAt,
      // local wins regardless of whether the base (remoteDb) is fresh or stale.
      const synced = github.resyncDb(remoteDb, state.db);
      // resyncDb flags _staleFetch when this fetch turned out to be missing
      // something local already had (e.g. a just-imported record GitHub's read
      // path hasn't caught up to yet). In that case do NOT advance _syncedAt to
      // now — that would mark those records "confirmed synced" when this fetch
      // never actually saw them, and the next reload's mergeLocalPending would
      // then read that false confirmation as "remote deleted this" and drop it.
      // Carrying the old marker forward keeps them looking genuinely unsynced
      // until a push actually confirms them.
      const staleFetch = synced._staleFetch;
      delete synced._staleFetch; // never persist this transient flag
      synced._syncedAt = staleFetch ? (state.db._syncedAt ?? null) : Date.now();

      if (!staleFetch) lastAppliedSha = state.github.lastFetchedSha;
      if (!staleFetch && sameDbContent(synced, state.db)) {
        // Remote matches what's already on screen — just advance the
        // confirmed-synced marker, skip the rebuild entirely.
        state.db._syncedAt = synced._syncedAt;
        github.saveLocalCache(state.db);
        updateSyncStatus('online', `Synced ${new Date().toLocaleTimeString()}`);
        return;
      }

      setDb(synced);                                    // triggers data-loaded → view refresh
      github.saveLocalCache(synced);
      updateSyncStatus('online', `Synced ${new Date().toLocaleTimeString()}`);
      // A stale fetch means local has something this push cycle should confirm
      // properly — nudge a real push rather than leaving it to the next edit.
      if (staleFetch && state.github.token && !pushPending) schedulePush();
    } catch (e) {
      // offline / transient — keep working from current state
      if (e?.code === 'KEY_MISMATCH') updateSyncStatus('offline', 'Encryption key changed elsewhere — paste the new key in Settings → Encryption', true);
      else if (e?.code === 'NEWER_FORMAT') updateSyncStatus('offline', 'App updated — reload the page to keep saving', true);
      else if (e?.code === 'UNSUPPORTED_BROWSER') updateSyncStatus('offline', 'Browser too old to read the data — update it', true);
      else if (e?.code === 'PLAINTEXT_REMOTE') {
        updateSyncStatus('offline', 'db.json on GitHub was changed outside the app — not loading it', true);
        toast(e.message, 'danger', 15000);
      }
    }
    finally { resyncing = false; }
  };

  // Reconnecting: push pending offline edits (which merge against fresh remote),
  // otherwise pull everyone else's changes.
  window.addEventListener('online', () => {
    if (state.dirty || pendingSaveBeforeSync) { if (!pushPending) doSave().catch(() => {}); }
    else backgroundResync();
  });
  // Returning to the tab — surface anything that changed while it was hidden.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      github.flushLocalCache(); // tab backgrounded/closing — beforeunload alone isn't reliable (esp. mobile)
      // Don't leave a batch waiting on a tab that may never come back.
      flushPendingPush();
    }
    else backgroundResync();
  });
  window.addEventListener('pagehide', () => { github.flushLocalCache(); flushPendingPush(); });
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
    // Coalesced + deferred to idle time: the count scans every STR
    // property's calendar, and 'dirty' fires on every single edit.
    if (evt === 'data-loaded' || evt === 'dirty') {
      scheduleStrGapBadge();
    }
    if (evt === 'dirty') {
      github.saveLocalCache(state.db);
      if (state.github.token && state.github.owner && state.github.repo) {
        if (!initialSyncDone) {
          // Initial remote sync not yet complete — queue the save for when it finishes
          pendingSaveBeforeSync = true;
          updateSyncStatus('syncing', 'Waiting for pull before pushing…');
        } else if (!pushPending) {
          // No push in flight — (re)start the batching timer.
          updateSyncStatus('syncing', 'Changes pending — pushing soon…');
          schedulePush();
        }
        // If pushPending, the in-flight push will detect state.dirty and re-push
        // automatically — no need to schedule another timer.
      } else {
        updateSyncStatus('offline', 'Unsaved — connect GitHub in Settings');
      }
    }
  });

  // Unpushed edits recovered from a journal during the initial pull.
  if (pushAfterBoot && initialSyncDone && state.github.token) {
    pushAfterBoot = false;
    state.dirty = true;
    state.editSeq = (state.editSeq || 0) + 1;
    doSave().catch(() => {});
  }

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
        // Merge against the CURRENT state.db, not the pre-login snapshot:
        // anything the user entered while this fetch was in flight (it can
        // take seconds, or minutes when rate-limited) lives only in state.db
        // and used to be silently discarded by the setDb() below. migrateDb()
        // hasn't run yet at this point (it runs after this merge), so state.db
        // carries no metadata backfill that could masquerade as a local edit —
        // which was the original reason for merging against the snapshot.
        const merged = github.mergeLocalPending(remoteDb, structuredClone(state.db));
        // Read-and-strip the merge's flag rather than leaving it on the object —
        // setDb + the next push would otherwise persist it into the repo's db.json.
        let hasLocalChanges = merged._hasLocalChanges;
        delete merged._hasLocalChanges;
        // Unpushed edits from pending-edits journals (another tab's, or this
        // one's from before the reload) that the cache didn't carry.
        if (isUnlocked() && await github.applyPendingJournals(merged)) hasLocalChanges = true;
        // Advance the sync marker to "now" ONLY when the merge kept nothing local.
        // When unpushed local records survived the merge (hasLocalChanges), they are
        // NOT on remote yet — stamping Date.now() here would make them compare as
        // older than the marker, so if the follow-up push below fails, the NEXT
        // reload's mergeLocalPending would judge them already-synced and silently
        // drop them (refresh twice during a sync outage → data loss). Keep the old
        // marker instead; the successful push stamps the real value itself.
        merged._syncedAt = hasLocalChanges ? (state.db._syncedAt ?? localSnapshot?._syncedAt ?? null) : Date.now();
        setDb(merged);                              // triggers data-loaded → view refresh
        if (!hasLocalChanges) lastAppliedSha = state.github.lastFetchedSha;
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
        // If local had genuinely newer records that won the merge (including
        // edits made while this sync was in flight), push them now.
        if (hasLocalChanges && state.github.token && !pushPending) {
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
      // Repair records saved without an id — "+ New Invoice" from a client's
      // page used to create invoices with id undefined (each overwriting the
      // previous one). A record without an id can't be edited, synced or
      // deleted reliably; give it one (and re-stamp it so it syncs).
      if (!item.id) {
        // Deterministic, content-derived id: every device repairing the same
        // record picks the SAME id, so they converge instead of each pushing
        // its own random-id copy (a duplicate invoice double-counts revenue).
        // The re-stamp below is then an identical change on both sides,
        // which mergeDb's same-content check absorbs.
        const { updatedAt: _u, updatedBy: _b, ...content } = item;
        item.id = `${col === 'invoices' ? 'inv' : col.slice(0, 3)}_legacy_${stableHash(JSON.stringify(content))}`;
        item.updatedAt = item.createdAt || 1;
        state._ix?.get(col)?.delete(undefined);
        state._ix?.get(col)?.set(item.id, item);
        changed = true;
      }
      if (!item.createdAt) { item.createdAt = now; changed = true; }
      if (!item.createdBy) { item.createdBy = actor; changed = true; }
      if (!item.updatedAt) { item.updatedAt = now; changed = true; }
      if (!item.updatedBy) { item.updatedBy = actor; changed = true; }
    }
  }

  // Lease-termination payments used to be stored as type 'rental', which
  // made the rent schedule treat them as that month's rent (hiding a real
  // unpaid final month). Re-type the ones tenants.js generated — identified
  // precisely by the notes it wrote — to the dedicated types.
  for (const p of (state.db.payments || [])) {
    if (p.type !== 'rental' || p.source !== 'manual' || p.stream !== 'long_term_rental' || typeof p.notes !== 'string') continue;
    const newType = p.notes.startsWith('Deposit withheld — lease termination') ? 'deposit_withheld'
      : p.notes.startsWith('Additional payment — lease termination') ? 'termination_fee' : null;
    if (newType) { p.type = newType; p.updatedAt = now; p.updatedBy = actor; changed = true; }
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

// Small deterministic string hash (FNV-1a, two rounds) → 16 hex chars.
function stableHash(str) {
  let h1 = 0x811c9dc5, h2 = 0x01000193 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
    h2 = Math.imul(h2 ^ c, 2246822519) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
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
  logoutBtn.onclick = async () => {
    // Signing out wipes the local cache — the only copy of anything not yet
    // pushed. Try to push first, and if that doesn't clear it, ask.
    if (state.dirty || state.saving) {
      logoutBtn.disabled = true;
      logoutBtn.textContent = 'Saving…';
      if (state.github.syncNow) { try { await state.github.syncNow(); } catch { /* handled below */ } }
      logoutBtn.disabled = false;
      logoutBtn.textContent = 'Sign Out';
      if (state.dirty) {
        const ok = await confirmDialog(
          'Some changes have not been saved to GitHub yet (see the sync status in the sidebar). Signing out now permanently discards them from this browser. Sign out anyway?',
          { title: 'Unsaved changes', danger: true, okLabel: 'Sign out anyway' }
        );
        if (!ok) return;
      }
    }
    // Recorded before clearSession() wipes state.session — reload() below
    // would otherwise abort this fetch mid-flight if fired afterward.
    await recordSessionEvent('logout').catch(() => {});
    clearSession();
    // Also stops any queued/in-flight cache write from re-creating the cache
    // right after it's cleared (beforeunload flushes pending writes).
    github.disableLocalCache();
    github.clearCachedDb();
    state.dirty = false; // already confirmed above — don't prompt again on reload
    location.reload();
  };
  wrap.appendChild(nameEl);
  wrap.appendChild(roleEl);
  wrap.appendChild(logoutBtn);
  footer.insertBefore(wrap, footer.firstChild);
}

function buildSidebar(MODULES) {
  const navGroups = [
    { title: 'Analysis', items: ['analytics', 'analytics-revenue', 'analytics-expenses', 'analytics-properties', 'analytics-str', 'analytics-cashflow', 'reconciliation', 'analytics-forecast', 'analytics-owner', 'analytics-personal', 'analytics-tax'] },
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
      if (id === 'str-rates') {
        const badge = document.createElement('span');
        badge.id = 'nav-str-gap-badge';
        badge.className = 'nav-item-badge danger';
        badge.style.display = 'none';
        item.appendChild(badge);
      }
      list.appendChild(item);
    }
    nav.appendChild(list);
  }
}

// Reflects how many reserved-on-Airbnb nights across all STR properties have
// no matching payment and no reason assigned yet — the sidebar-level cue that
// something needs a look in STR Daily Rates, without having to open it first.
// The count lives in str-rates.js, imported on demand (the same instance the
// router loads). Runs at most once per idle period however many edits land.
let _gapBadgePending = false;
function scheduleStrGapBadge() {
  if (_gapBadgePending || !document.getElementById('nav-str-gap-badge')) return;
  _gapBadgePending = true;
  const run = () => {
    importStrRates().then(m => {
      // Cleared before counting: an edit from here on schedules a fresh
      // pass, while anything earlier is already reflected in this one.
      _gapBadgePending = false;
      updateStrGapBadge(m.countUnresolvedGapNights);
    }, err => {
      _gapBadgePending = false;
      console.warn('STR gap badge: could not load str-rates.js', err);
    });
  };
  if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(run, { timeout: 2000 });
  else setTimeout(run, 500);
}

function updateStrGapBadge(countUnresolvedGapNights) {
  const badge = document.getElementById('nav-str-gap-badge');
  if (!badge || typeof countUnresolvedGapNights !== 'function') return;
  let count = 0;
  try { count = countUnresolvedGapNights(); } catch (e) { console.error(e); }
  badge.textContent = String(count);
  badge.style.display = count > 0 ? '' : 'none';
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

// The conflict message used to always say "Another user modified the same
// data" — but the underlying check is purely timestamp-based (see mergeDb in
// core/github.js) and has no idea whether the "other" edit actually came from
// a different person. The single most common real-world trigger is the SAME
// account open in a second tab/browser/device, whose local copy went stale
// the moment this account's other session pushed — which reads to the user
// as "no one else is logged in" even though it's technically true here.
// e.conflicts already carries remoteUpdatedBy per record, so use it to say
// what actually happened instead of guessing.
function describeConflictActors(conflicts) {
  const me = state.session?.username;
  const nameFor = username => {
    if (!username) return null;
    if (username === me) return 'you';
    return listActive('users').find(u => u.username === username)?.name || username;
  };
  const others = new Set();
  let anySelf = false, anyUnknown = false;
  for (const c of conflicts || []) {
    if (!c.remoteUpdatedBy) { anyUnknown = true; continue; }
    if (c.remoteUpdatedBy === me) anySelf = true;
    else others.add(nameFor(c.remoteUpdatedBy));
  }
  if (others.size === 0 && anySelf && !anyUnknown) {
    return 'This looks like it was edited from another tab, browser, or device you\'re also logged into — not someone else.';
  }
  if (others.size > 0) {
    const names = [...others];
    const list = names.length === 1 ? names[0]
      : names.length === 2 ? `${names[0]} and ${names[1]}`
      : `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
    return `${list} modified the same data.`;
  }
  return 'Another user modified the same data.';
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
