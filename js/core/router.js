// Hash-based router + module registry
import { state, setRoute, subscribe } from './state.js';
import * as charts from './charts.js';
import { closeModal, hasUnsavedModalEdits, toast } from './ui.js';

const modules = new Map();
let currentModule = null;
let container = null;

export function registerModule(mod) {
  modules.set(mod.id, mod);
}

export function getModules() {
  return [...modules.values()];
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
  const mod = modules.get(id) || modules.get('analytics');
  if (!mod) return;
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
  currentModule = mod;
  setRoute(mod.id);
  try {
    mod.render(container, state);
  } catch (e) {
    console.error('render error', e);
    container.innerHTML = '<div class="empty"><div class="empty-icon">!</div><span></span></div>';
    container.querySelector('span').textContent = `Error rendering module: ${e.message}`;
  }
  // Every render() today is synchronous, so this never actually fires — it's
  // a guard against a future module doing async work before appending to
  // `container`, where a second rapid navigation could otherwise interleave
  // its output with this one's.
  if (myToken !== _navToken) return;

  // nav highlight
  document.querySelectorAll('.nav-item').forEach(n => {
    n.classList.toggle('active', n.dataset.route === mod.id);
  });
  // header title
  document.getElementById('header-title').textContent = mod.label || mod.id;
}
