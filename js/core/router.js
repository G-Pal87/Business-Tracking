// Hash-based router + module registry
import { state, setRoute, subscribe } from './state.js';
import * as charts from './charts.js';

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
      try { currentModule.refresh(state); } catch (e) { console.error(e); }
    }
    if (evt === 'filter-change' && currentModule && currentModule.refresh) {
      try { currentModule.refresh(state); } catch (e) { console.error(e); }
    }
  });
  onHashChange();
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
  container.innerHTML = '';
  currentModule = mod;
  setRoute(mod.id);
  try {
    mod.render(container, state);
  } catch (e) {
    console.error('render error', e);
    container.innerHTML = `<div class="empty"><div class="empty-icon">!</div>Error rendering module: ${e.message}</div>`;
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
