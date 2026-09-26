// Hash-based router + module registry
import { state, setRoute, subscribe } from './state.js';
import * as charts from './charts.js';
import { closeModal, hasUnsavedModalEdits, toast } from './ui.js';

// Route registry. Each entry is a lightweight descriptor — { id, label, icon,
// load } — whose module code is imported on first navigation (see
// loadRoute), so boot doesn't have to download and evaluate every view
// before the first screen. A fully-loaded module object (one with render())
// may also be registered directly and is used as-is.
const modules = new Map();
let currentModule = null;
let container = null;

export function registerModule(desc) {
  modules.set(desc.id, desc);
}

export function getModules() {
  return [...modules.values()];
}

// Resolves to the route's module object ({ id, label, render, refresh,
// destroy }), importing it once. A failed import isn't cached, so the next
// navigation retries it.
export function loadRoute(id) {
  const desc = modules.get(id);
  if (!desc) return Promise.reject(new Error(`Unknown route: ${id}`));
  if (typeof desc.render === 'function') return Promise.resolve(desc);
  if (desc.module) return Promise.resolve(desc.module);
  if (!desc._loading) {
    desc._loading = Promise.resolve()
      .then(() => desc.load())
      .then(m => {
        const mod = m?.default || m;
        if (!mod || typeof mod.render !== 'function') throw new Error(`Module "${id}" has no render()`);
        if (mod.id !== id) console.warn(`[router] route "${id}" loaded module "${mod.id}"`);
        desc.module = mod;
        return mod;
      })
      .catch(err => { desc._loading = null; throw err; });
  }
  return desc._loading;
}

function loadedModule(desc) {
  return typeof desc.render === 'function' ? desc : (desc.module || null);
}

// Imports every not-yet-loaded route in the background, one at a time and
// only while the browser is idle, so later navigations render instantly
// without competing with the first screen for the network/CPU.
export function prefetchAll() {
  const queue = [...modules.values()].filter(d => !loadedModule(d));
  const idle = cb => (window.requestIdleCallback
    ? window.requestIdleCallback(cb, { timeout: 3000 })
    : setTimeout(cb, 200));
  const next = () => {
    const d = queue.shift();
    if (!d) return;
    loadRoute(d.id).catch(() => { /* retried on navigation */ }).finally(() => idle(next));
  };
  idle(next);
}

export function init(el) {
  container = el;
  window.addEventListener('hashchange', onHashChange);
  subscribe(evt => {
    if (evt === 'data-loaded' && currentModule && currentModule.refresh) {
      // A refresh rebuilds the view with innerHTML = '', which would wipe
      // whatever the user is typing (the background sync fires this when
      // another device saved). Hold it until they're done.
      if (editingInProgress()) { schedulePendingRefresh(); return; }
      refreshCurrent();
    }
    if (evt === 'filter-change' && currentModule && currentModule.refresh) {
      refreshCurrent();
    }
  });
  container.addEventListener('focusout', () => { if (pendingRefresh) schedulePendingRefresh(); });
  document.addEventListener('bt:modal-closed', () => { if (pendingRefresh) schedulePendingRefresh(); });
  document.addEventListener('pointerdown', () => { pointerDown = true; }, true);
  const pointerUp = () => { pointerDown = false; if (pendingRefresh) schedulePendingRefresh(); };
  document.addEventListener('pointerup', pointerUp, true);
  document.addEventListener('pointercancel', pointerUp, true);
  onHashChange();
}

// ── Deferred refresh while editing ────────────────────────────────────────────
let pendingRefresh = false;
let pendingTimer = null;
let pointerDown = false;

const EDITABLE = 'textarea, select, [contenteditable]:not([contenteditable="false"]), '
  + 'input:not([type=button]):not([type=submit]):not([type=reset]):not([type=checkbox]):not([type=radio]):not([type=file]):not([type=range]):not([type=color])';

function editingInProgress() {
  const a = document.activeElement;
  if (a && container && container.contains(a) && a.matches?.(EDITABLE)) return true;
  return hasUnsavedModalEdits();
}

function refreshCurrent() {
  pendingRefresh = false;
  clearTimeout(pendingTimer);
  pendingTimer = null;
  if (!currentModule?.refresh) return;
  try { currentModule.refresh(state); } catch (e) { console.error(e); }
}

// Re-checks shortly after focus leaves a field. The delay, and waiting for
// the pointer to come up, let a click on "Save" land before the view is
// rebuilt under it (focus moves on mousedown, the click fires on mouseup).
function schedulePendingRefresh() {
  pendingRefresh = true;
  clearTimeout(pendingTimer);
  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    if (!pendingRefresh || pointerDown || editingInProgress()) return;
    if (document.querySelector('.modal-overlay.open')) return; // applied when it closes
    refreshCurrent();
    toast('Updated from another device', 'info', 2500);
  }, 400);
}

export function navigate(id) {
  if (location.hash !== `#${id}`) location.hash = id;
  else onHashChange();
}

let _navToken = 0;

function onHashChange() {
  const id = (location.hash || '#analytics').slice(1);
  const desc = modules.get(id) || modules.get('analytics');
  if (!desc) return;
  if (!modules.has(id) && location.hash && location.hash !== '#analytics') {
    // Unknown route falling back to analytics — keep the address bar
    // consistent with what's actually shown instead of silently disagreeing
    // with it. replaceState doesn't fire another hashchange, so this is safe.
    history.replaceState(null, '', location.pathname + location.search + '#analytics');
  }

  const myToken = ++_navToken;

  if (currentModule && currentModule.destroy) {
    try { currentModule.destroy(); } catch (e) { console.error(e); }
  }
  // No module is "current" until the new one has rendered — a data-loaded /
  // filter-change arriving while its code is still downloading must not
  // refresh() the module that was just destroyed. The new one renders with
  // the latest state anyway.
  currentModule = null;
  // Destroy any Chart.js instances before their canvases are removed below.
  // Centralized here so a module with an incomplete destroy() can't leak charts.
  try { charts.destroyAll(); } catch (e) { console.error(e); }
  // A modal lives on document.body, outside `container` — navigating away
  // while one is open used to leave it visually stuck on top of the new
  // page (blocking clicks via its overlay) along with its keydown listener,
  // holding closures over the now-destroyed module's stale form state.
  try { closeModal(); } catch (e) { console.error(e); }
  container.innerHTML = '';
  // A fresh render shows the latest data; nothing left to apply.
  pendingRefresh = false;
  clearTimeout(pendingTimer);
  pendingTimer = null;

  // Highlight + title straight away (from the descriptor), so the click
  // registers even while the module's code is still loading.
  highlight(desc.id, desc.label || desc.id);

  const mod = loadedModule(desc);
  if (mod) { renderRoute(mod); return; }

  container.innerHTML = '<div class="empty route-loading">Loading…</div>';
  loadRoute(desc.id).then(loaded => {
    // A later navigation superseded this one while the code downloaded.
    if (myToken !== _navToken) return;
    container.innerHTML = '';
    renderRoute(loaded);
  }, err => {
    if (myToken !== _navToken) return;
    console.error('module load error', err);
    container.innerHTML = '<div class="empty"><div class="empty-icon">!</div><span></span><div style="margin-top:12px"><button class="btn sm">Retry</button></div></div>';
    container.querySelector('span').textContent = `Could not load this page: ${err.message}`;
    container.querySelector('button').onclick = () => onHashChange();
  });
}

function renderRoute(mod) {
  currentModule = mod;
  setRoute(mod.id);
  try {
    mod.render(container, state);
  } catch (e) {
    console.error('render error', e);
    container.innerHTML = '<div class="empty"><div class="empty-icon">!</div><span></span></div>';
    container.querySelector('span').textContent = `Error rendering module: ${e.message}`;
  }
  highlight(mod.id, mod.label || mod.id);
}

function highlight(id, label) {
  // nav highlight
  document.querySelectorAll('.nav-item').forEach(n => {
    n.classList.toggle('active', n.dataset.route === id);
  });
  // header title
  document.getElementById('header-title').textContent = label;
}
