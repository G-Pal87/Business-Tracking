// Hash-based router + module registry
import { state, setRoute, subscribe } from './state.js';

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

function onHashChange() {
  const id = (location.hash || '#analytics').slice(1);
  const mod = modules.get(id) || modules.get('analytics');
  if (!mod) return;

  if (currentModule && currentModule.destroy) {
    try { currentModule.destroy(); } catch (e) { console.error(e); }
  }
  container.innerHTML = '';
  currentModule = mod;
  setRoute(mod.id);
  try {
    mod.render(container, state);
  } catch (e) {
    console.error('render error', e);
    container.innerHTML = `<div class="empty"><div class="empty-icon">!</div>Error rendering module: ${e.message}</div>`;
  }

  // nav highlight
  document.querySelectorAll('.nav-item').forEach(n => {
    n.classList.toggle('active', n.dataset.route === mod.id);
  });
  // header title
  document.getElementById('header-title').textContent = mod.label || mod.id;
}
