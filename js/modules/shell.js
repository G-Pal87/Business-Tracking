// App shell extras, mounted once after sign-in (js/app.js):
//  • Global search — header button, Ctrl/⌘+K or "/" — across properties,
//    tenants, clients, vendors, invoices, payments, expenses and pages.
//  • Quick add — a floating "+" on phones (a header "+" on wider screens) for
//    Expense / Payment / Invoice / Receipt photo, reusing each page's own form.
//
// Nothing here writes data: every record is created or edited through the
// owning module's exported form opener, so validation, encryption and sync
// stay exactly where they are.
import { state, subscribe } from '../core/state.js';
import * as router from '../core/router.js';
import { el, toast, hasUnsavedModalEdits, fmtDate } from '../core/ui.js';
import { listActive, byId, derivedCache, formatMoney } from '../core/data.js';
import { EXPENSE_CATEGORIES } from '../core/config.js';

let mounted = false;
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || '');

const ICON_SEARCH = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>';
const ICON_PLUS = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';

const EDITABLE = 'input:not([type=button]):not([type=submit]):not([type=checkbox]):not([type=radio]):not([type=file]):not([type=range]), textarea, select, [contenteditable]:not([contenteditable="false"])';
const isEditable = n => !!(n && n.matches && n.matches(EDITABLE));
const modalOpen = () => !!document.querySelector('.modal-overlay.open');

// ── Module access ────────────────────────────────────────────────────────────
// Loaded through the router's own descriptor so we get the SAME module
// instance (same ?v= URL) as the page itself — never a second copy.
function hasRoute(id) { return router.getModules().some(d => d.id === id); }
async function loadNs(id) {
  const desc = router.getModules().find(d => d.id === id);
  if (!desc || typeof desc.load !== 'function') return null;
  try { return await desc.load(); } catch (e) { console.warn('[shell] load', id, e); return null; }
}
const nsCache = new Map();
function preload(ids) { for (const id of ids) if (!nsCache.has(id) && hasRoute(id)) nsCache.set(id, loadNs(id)); }
function ns(id) { if (!nsCache.has(id)) nsCache.set(id, loadNs(id)); return nsCache.get(id); }

// Navigates and resolves once the route has rendered (or after a timeout).
function goTo(id) {
  return new Promise(resolve => {
    if (state.ui.currentRoute === id && location.hash === `#${id}`) {
      // Re-render so a stale page (and any open modal) is reset, same as a nav click.
      router.navigate(id);
      return requestAnimationFrame(() => resolve(true));
    }
    let done = false;
    const finish = ok => { if (done) return; done = true; unsub(); clearTimeout(t); requestAnimationFrame(() => resolve(ok)); };
    const unsub = subscribe(evt => { if (evt === 'route-change' && state.ui.currentRoute === id) finish(true); });
    const t = setTimeout(() => finish(state.ui.currentRoute === id), 8000);
    router.navigate(id);
  });
}

// Fills the page's own search box (first type=search in #content, or the one
// whose placeholder mentions `hint`) and fires its input handler.
function prefillPageSearch(term, hint) {
  const tryFill = () => {
    const boxes = [...document.querySelectorAll('#content input[type=search]')];
    const box = (hint && boxes.find(b => (b.placeholder || '').toLowerCase().includes(hint))) || boxes[0];
    if (!box) return false;
    box.value = term;
    box.dispatchEvent(new Event('input', { bubbles: true }));
    box.scrollIntoView?.({ block: 'nearest' });
    return true;
  };
  // Some pages render their table a frame or two after render().
  let tries = 0;
  const tick = () => { if (!tryFill() && ++tries < 20) setTimeout(tick, 60); };
  tick();
}

// ── Search index ─────────────────────────────────────────────────────────────
const COLLECTIONS = ['properties', 'tenants', 'clients', 'vendors', 'invoices', 'payments', 'expenses'];
const indexCache = derivedCache(COLLECTIONS);

const amountStr = a => {
  const n = Number(a);
  if (!Number.isFinite(n) || n === 0) return '';
  const abs = Math.abs(n);
  return `${abs} ${abs.toFixed(2)} ${abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};
const lc = (...xs) => xs.filter(x => x !== null && x !== undefined && x !== '').join(' ').toLowerCase();

const GROUPS = [
  { key: 'pages', label: 'Pages' },
  { key: 'properties', label: 'Properties', route: 'properties', hint: '' },
  { key: 'tenants', label: 'Tenants', route: 'tenants', hint: 'filter' },
  { key: 'clients', label: 'Clients', route: 'clients', hint: 'search' },
  { key: 'vendors', label: 'Vendors', route: 'vendors', hint: 'vendor' },
  { key: 'invoices', label: 'Invoices', route: 'invoices', hint: 'filter' },
  { key: 'payments', label: 'Payments', route: 'payments', hint: 'payment' },
  { key: 'expenses', label: 'Expenses', route: 'expenses', hint: 'expense' },
];

function buildIndex() {
  const propName = id => byId('properties', id)?.name || '';
  const out = {};
  out.properties = listActive('properties').map(p => ({ id: p.id, title: p.name || '(unnamed property)', hay: lc(p.name, p.address, p.city, p.country, p.notes) }));
  out.tenants = listActive('tenants').map(t => ({ id: t.id, title: t.name || '(unnamed tenant)', hay: lc(t.name, t.email, t.phone, propName(t.propertyId)) }));
  out.clients = listActive('clients').map(c => ({ id: c.id, title: c.name || '(unnamed client)', hay: lc(c.name, c.company, c.email, c.contactName, c.vatNumber, c.billingCode) }));
  out.vendors = listActive('vendors').map(v => ({ id: v.id, title: v.name || '(unnamed vendor)', hay: lc(v.name, v.company, v.email, v.phone, v.role) }));
  out.invoices = listActive('invoices').map(i => {
    const client = byId('clients', i.clientId)?.name || '';
    return { id: i.id, title: `Invoice ${i.number || i.id}${client ? ' — ' + client : ''}`, date: i.issueDate || '', hay: lc('#' + (i.number || ''), i.number, client, i.status, amountStr(i.total), i.notes) };
  });
  out.payments = listActive('payments').map(p => {
    const tenant = p.tenantId ? byId('tenants', p.tenantId)?.name : '';
    const guest = p.guestName || tenant || '';
    return { id: p.id, title: guest || propName(p.propertyId) || 'Payment', date: p.date || '', hay: lc(p.guestName, tenant, p.confirmationCode, p.airbnbRef, amountStr(p.amount), p.notes, propName(p.propertyId)) };
  });
  out.expenses = listActive('expenses').map(e => {
    const vendor = (e.vendorId && byId('vendors', e.vendorId)?.name) || e.vendor || '';
    const cat = EXPENSE_CATEGORIES[e.category]?.label || e.category || '';
    return { id: e.id, title: e.description || cat || 'Expense', date: e.date || '', hay: lc(e.description, vendor, cat, amountStr(e.amount), propName(e.propertyId)) };
  });
  return out;
}
function getIndex() {
  const m = indexCache();
  let idx = m.get('idx');
  if (!idx) { idx = buildIndex(); m.set('idx', idx); }
  return idx;
}

// Second line of a result — computed only for rows actually shown.
function subtitle(group, id) {
  const r = byId(group, id);
  if (!r) return '';
  const prop = id2 => byId('properties', id2)?.name || '';
  const bits = [];
  switch (group) {
    case 'properties': bits.push([r.city, r.country].filter(Boolean).join(', ')); break;
    case 'tenants': bits.push(prop(r.propertyId), r.email || r.phone); break;
    case 'clients': bits.push(r.company, r.email); break;
    case 'vendors': bits.push(r.company, r.phone || r.email); break;
    case 'invoices': bits.push(r.issueDate ? fmtDate(r.issueDate) : '', formatMoney(r.total, r.currency), r.status); break;
    case 'payments': bits.push((r.guestName || r.tenantId) ? prop(r.propertyId) : '', r.date ? fmtDate(r.date) : '', formatMoney(r.amount, r.currency), r.confirmationCode || r.airbnbRef); break;
    case 'expenses': bits.push(prop(r.propertyId) || 'Company', r.date ? fmtDate(r.date) : '', formatMoney(r.amount, r.currency), (r.vendorId && byId('vendors', r.vendorId)?.name) || r.vendor); break;
  }
  return bits.filter(Boolean).join(' · ');
}

const PER_GROUP = 8;
export function searchAll(query) {
  const words = String(query || '').toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!words.length) return { words, groups: [] };
  const idx = getIndex();
  const groups = [];
  const pages = router.getModules().filter(d => words.every(w => lc(d.label, d.id).includes(w)))
    .slice(0, PER_GROUP).map(d => ({ id: d.id, title: d.label || d.id }));
  if (pages.length) groups.push({ ...GROUPS[0], items: pages, total: pages.length });
  for (const g of GROUPS.slice(1)) {
    if (!hasRoute(g.route)) continue;
    const list = idx[g.key] || [];
    const hits = [];
    for (const it of list) {
      let ok = true;
      for (const w of words) if (!it.hay.includes(w)) { ok = false; break; }
      if (!ok) continue;
      const t = it.title.toLowerCase();
      const score = t.startsWith(words[0]) ? 0 : t.includes(words[0]) ? 1 : 2;
      hits.push({ it, score });
    }
    if (!hits.length) continue;
    hits.sort((a, b) => a.score - b.score || (b.it.date || '').localeCompare(a.it.date || ''));
    groups.push({ ...g, items: hits.slice(0, PER_GROUP).map(h => h.it), total: hits.length });
  }
  return { words, groups };
}

// Text with every query word wrapped in <mark> — built as DOM nodes, never HTML.
function highlighted(text, words) {
  const frag = document.createDocumentFragment();
  const s = String(text || '');
  if (!words.length) { frag.append(s); return frag; }
  const low = s.toLowerCase();
  const marks = new Array(s.length).fill(false);
  for (const w of words) {
    let i = low.indexOf(w);
    while (i !== -1) { for (let k = i; k < i + w.length; k++) marks[k] = true; i = low.indexOf(w, i + w.length); }
  }
  let i = 0;
  while (i < s.length) {
    let j = i;
    while (j < s.length && marks[j] === marks[i]) j++;
    const part = s.slice(i, j);
    frag.append(marks[i] ? el('mark', {}, part) : part);
    i = j;
  }
  return frag;
}

// ── Opening a result ─────────────────────────────────────────────────────────
async function openResult(group, id, query) {
  if (group === 'pages') { await goTo(id); return; }
  const g = GROUPS.find(x => x.key === group);
  if (!g) return;
  await goTo(g.route);
  if (id === '__all__') { prefillPageSearch(query, g.hint); return; }
  const rec = byId(group, id);
  const m = await ns(g.route);
  try {
    if (group === 'properties' && m?.openDetail) return m.openDetail(id);
    if (group === 'clients' && m?.openDetail) return m.openDetail(id);
    if (group === 'invoices' && m?.openPreview) return m.openPreview(id);
    if (group === 'payments' && m?.openPaymentForm && rec) return m.openPaymentForm(rec);
    if (group === 'expenses' && m?.openExpenseForm) return m.openExpenseForm(id);
  } catch (e) { console.error('[shell] open', e); }
  // No exported opener (tenants, vendors): filter the page to that record.
  prefillPageSearch(rec?.name || query, g.hint);
}

// ── Search overlay ───────────────────────────────────────────────────────────
let searchEl = null, inputEl = null, listEl = null, lastFocus = null;
let activeIdx = -1, rows = [], debounceT = null;

function buildSearch() {
  inputEl = el('input', {
    type: 'search', class: 'gs-input', placeholder: 'Search properties, tenants, invoices, payments…',
    autocomplete: 'off', spellcheck: 'false', role: 'combobox', 'aria-expanded': 'true',
    'aria-controls': 'gs-results', 'aria-autocomplete': 'list', 'aria-label': 'Search everything', enterkeyhint: 'go'
  });
  const closeBtn = el('button', { class: 'gs-close', type: 'button', 'aria-label': 'Close search' }, 'Cancel');
  listEl = el('div', { class: 'gs-results', id: 'gs-results', role: 'listbox' });
  const foot = el('div', { class: 'gs-foot' },
    el('span', {}, el('kbd', {}, '↑'), el('kbd', {}, '↓'), ' navigate'),
    el('span', {}, el('kbd', {}, 'Enter'), ' open'),
    el('span', {}, el('kbd', {}, 'Esc'), ' close'));
  const panel = el('div', { class: 'gs-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Search' },
    el('div', { class: 'gs-bar' }, el('span', { class: 'gs-icon' }), inputEl, closeBtn), listEl, foot);
  panel.querySelector('.gs-icon').innerHTML = ICON_SEARCH;
  searchEl = el('div', { class: 'gs-overlay', hidden: '' }, panel);
  searchEl.addEventListener('mousedown', e => { if (e.target === searchEl) closeSearch(); });
  closeBtn.addEventListener('click', closeSearch);
  inputEl.addEventListener('input', () => { clearTimeout(debounceT); debounceT = setTimeout(renderResults, 90); });
  inputEl.addEventListener('keydown', onSearchKey);
  document.body.appendChild(searchEl);
}

function onSearchKey(e) {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (debounceT) { clearTimeout(debounceT); debounceT = null; renderResults(); }
    if (!rows.length) return;
    setActive((activeIdx + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (debounceT) { clearTimeout(debounceT); debounceT = null; renderResults(); }
    if (rows[activeIdx]) choose(rows[activeIdx]);
  } else if (e.key === 'Escape') {
    e.preventDefault(); e.stopPropagation();
    closeSearch();
  }
}

function setActive(i) {
  rows[activeIdx]?.node.classList.remove('active');
  rows[activeIdx]?.node.setAttribute('aria-selected', 'false');
  activeIdx = i;
  const r = rows[i];
  if (!r) { inputEl.removeAttribute('aria-activedescendant'); return; }
  r.node.classList.add('active');
  r.node.setAttribute('aria-selected', 'true');
  inputEl.setAttribute('aria-activedescendant', r.node.id);
  r.node.scrollIntoView({ block: 'nearest' });
}

function renderResults() {
  debounceT = null;
  const q = inputEl.value;
  listEl.textContent = '';
  rows = []; activeIdx = -1;
  if (!q.trim()) {
    listEl.appendChild(el('div', { class: 'gs-empty' }, 'Type a name, invoice number, confirmation code or amount.'));
    return;
  }
  let res;
  try { res = searchAll(q); } catch (e) { console.error('[shell] search', e); res = { words: [], groups: [] }; }
  if (!res.groups.length) {
    listEl.appendChild(el('div', { class: 'gs-empty' }, `No matches for "${q.trim()}"`));
    return;
  }
  for (const g of res.groups) {
    const sec = el('div', { class: 'gs-group', role: 'group', 'aria-label': g.label });
    sec.appendChild(el('div', { class: 'gs-group-title' }, g.label, g.total > g.items.length ? el('span', { class: 'gs-count' }, String(g.total)) : ''));
    for (const it of g.items) {
      const sub = g.key === 'pages' ? 'Go to page' : subtitle(g.key, it.id);
      const node = el('div', { class: 'gs-row', role: 'option', id: `gs-opt-${rows.length}`, 'aria-selected': 'false' },
        el('div', { class: 'gs-title' }, highlighted(it.title, res.words)),
        sub ? el('div', { class: 'gs-sub' }, highlighted(sub, res.words)) : '');
      const row = { group: g.key, id: it.id, node };
      node.addEventListener('click', () => choose(row));
      node.addEventListener('mousemove', () => { if (rows[activeIdx] !== row) setActive(rows.indexOf(row)); });
      rows.push(row);
      sec.appendChild(node);
    }
    if (g.total > g.items.length && g.route) {
      const node = el('div', { class: 'gs-row gs-more', role: 'option', id: `gs-opt-${rows.length}`, 'aria-selected': 'false' },
        el('div', { class: 'gs-title' }, `See all ${g.total} in ${g.label} →`));
      const row = { group: g.key, id: '__all__', node };
      node.addEventListener('click', () => choose(row));
      node.addEventListener('mousemove', () => { if (rows[activeIdx] !== row) setActive(rows.indexOf(row)); });
      rows.push(row);
      sec.appendChild(node);
    }
    listEl.appendChild(sec);
  }
  setActive(0);
}

function choose(row) {
  const q = inputEl.value.trim();
  closeSearch(false);
  openResult(row.group, row.id, q).catch(e => { console.error(e); toast('Could not open: ' + e.message, 'danger'); });
}

export function openSearch() {
  if (!mounted) return;
  if (hasUnsavedModalEdits()) { toast('Save or close the open form first', 'info', 2500); return; }
  if (!searchEl) buildSearch();
  if (!searchEl.hidden) { inputEl.focus(); inputEl.select(); return; }
  lastFocus = document.activeElement;
  closeQuickMenu();
  searchEl.hidden = false;
  document.body.classList.add('gs-open');
  inputEl.focus();
  inputEl.select();
  // Build the index right away (off the keystroke path) for a first-result-instant feel.
  renderResults();
  setTimeout(() => { try { getIndex(); } catch (e) { /* no data yet */ } }, 0);
}

export function closeSearch(restoreFocus = true) {
  if (!searchEl || searchEl.hidden) return;
  clearTimeout(debounceT); debounceT = null;
  searchEl.hidden = true;
  document.body.classList.remove('gs-open');
  if (restoreFocus && lastFocus && document.contains(lastFocus)) lastFocus.focus?.();
  lastFocus = null;
}

// ── Quick add ────────────────────────────────────────────────────────────────
let fab = null, qaMenu = null, qaAnchor = null, cameraInput = null;
const QA_ITEMS = [
  { key: 'expense', label: 'Expense', route: 'expenses', icon: '−' },
  { key: 'payment', label: 'Payment', route: 'payments', icon: '+' },
  { key: 'invoice', label: 'Invoice', route: 'invoices', icon: '#' },
  { key: 'receipt', label: 'Receipt photo', route: 'expenses', icon: '◉' },
];

function buildQuickMenu() {
  qaMenu = el('div', { class: 'qa-menu', role: 'menu', hidden: '', 'aria-label': 'Quick add' });
  for (const it of QA_ITEMS) {
    if (!hasRoute(it.route)) continue;
    const b = el('button', { class: 'qa-item', type: 'button', role: 'menuitem', 'data-qa': it.key },
      el('span', { class: 'qa-ico', 'aria-hidden': 'true' }, it.icon), el('span', {}, it.label));
    b.addEventListener('click', () => { closeQuickMenu(); quickAdd(it.key); });
    qaMenu.appendChild(b);
  }
  qaMenu.addEventListener('keydown', e => {
    const items = [...qaMenu.querySelectorAll('.qa-item')];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeQuickMenu(); qaAnchor?.focus(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
  });
  document.body.appendChild(qaMenu);
  // One persistent picker so .click() runs straight inside the tap (iOS needs that).
  cameraInput = el('input', { type: 'file', accept: 'image/*', capture: 'environment', class: 'qa-camera', tabindex: '-1', 'aria-hidden': 'true' });
  cameraInput.addEventListener('change', () => {
    const f = cameraInput.files?.[0];
    if (f) receiptToExpense(f);
    cameraInput.value = '';
  });
  document.body.appendChild(cameraInput);
}

function openQuickMenu(anchor) {
  if (!qaMenu) buildQuickMenu();
  preload(['expenses', 'payments', 'invoices']);
  qaAnchor = anchor;
  qaMenu.hidden = false;
  qaMenu.classList.toggle('from-fab', anchor === fab);
  if (anchor !== fab) {
    const r = anchor.getBoundingClientRect();
    qaMenu.style.top = `${Math.round(r.bottom + 6)}px`;
    qaMenu.style.right = `${Math.max(8, Math.round(window.innerWidth - r.right))}px`;
  } else { qaMenu.style.top = ''; qaMenu.style.right = ''; }
  anchor.setAttribute('aria-expanded', 'true');
  document.body.classList.add('qa-open');
  qaMenu.querySelector('.qa-item')?.focus({ preventScroll: true });
}
function closeQuickMenu() {
  if (!qaMenu || qaMenu.hidden) return;
  qaMenu.hidden = true;
  qaAnchor?.setAttribute('aria-expanded', 'false');
  document.body.classList.remove('qa-open');
}
function toggleQuickMenu(anchor) {
  if (qaMenu && !qaMenu.hidden && qaAnchor === anchor) closeQuickMenu(); else openQuickMenu(anchor);
}

async function quickAdd(key) {
  if (key === 'receipt') {
    // Must stay synchronous — the camera only opens from a direct tap.
    cameraInput.click();
    return;
  }
  if (hasUnsavedModalEdits()) { toast('Save or close the open form first', 'info', 2500); return; }
  const route = { expense: 'expenses', payment: 'payments', invoice: 'invoices' }[key];
  const m = await ns(route);
  try {
    if (key === 'expense' && m?.openExpenseForm) return m.openExpenseForm({});
    if (key === 'payment' && m?.openPaymentForm) return m.openPaymentForm(null);
    if (key === 'invoice' && m?.openBuilder) return m.openBuilder(null);
  } catch (e) { console.error('[shell] quick add', e); }
  // Fallback: the page's own "+ Add …" button.
  await goTo(route);
  const btn = [...document.querySelectorAll('#content button')].find(b => /^\+\s*(Add|New)\b/.test(b.textContent.trim()));
  if (btn) btn.click(); else toast('Could not open the form', 'warning');
}

// Opens a new expense and hands the photo to its own "Attach Receipt" input,
// so it goes through the same preparation (resize, metadata strip) and upload.
async function receiptToExpense(file) {
  if (hasUnsavedModalEdits()) { toast('Save or close the open form first', 'info', 2500); return; }
  const m = await ns('expenses');
  if (!m?.openExpenseForm) { toast('Expenses are not available', 'warning'); return; }
  m.openExpenseForm({});
  const modal = document.querySelector('#modal-overlay .modal');
  const fi = modal?.querySelector('input[type=file]');
  if (!fi) { toast('Open an expense and use "Attach Receipt"', 'warning'); return; }
  try {
    const dt = new DataTransfer();
    dt.items.add(file);
    fi.files = dt.files;
    fi.dispatchEvent(new Event('change', { bubbles: true }));
    toast('Receipt attached — fill in the amount and save', 'success', 3500);
  } catch (e) {
    // Very old browsers can't assign files — let the user pick it in the form.
    fi.setAttribute('accept', 'image/*');
    fi.setAttribute('capture', 'environment');
    toast('Tap "Attach Receipt" to add the photo', 'info', 4000);
  }
}

// ── FAB visibility: hide while a modal, the nav drawer or the keyboard is up ──
function watchFabVisibility() {
  const update = () => {
    const vv = window.visualViewport;
    const kb = (vv && window.innerHeight - vv.height > 150) || (isEditable(document.activeElement) && window.matchMedia('(max-width: 640px)').matches);
    document.body.classList.toggle('qa-kb', !!kb);
    document.body.classList.toggle('qa-modal', modalOpen());
  };
  window.visualViewport?.addEventListener('resize', update);
  document.addEventListener('focusin', update);
  document.addEventListener('focusout', () => setTimeout(update, 50));
  const overlay = document.getElementById('modal-overlay');
  if (overlay) new MutationObserver(update).observe(overlay, { attributes: true, attributeFilter: ['class'] });
  // ui.js may (re)create the overlay lazily; catch that too.
  new MutationObserver(muts => {
    for (const m of muts) for (const n of m.addedNodes) if (n.id === 'modal-overlay') new MutationObserver(update).observe(n, { attributes: true, attributeFilter: ['class'] });
  }).observe(document.body, { childList: true });
  update();
}

// ── Keyboard shortcuts ───────────────────────────────────────────────────────
function onGlobalKey(e) {
  if ((e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) {
    e.preventDefault();
    if (searchEl && !searchEl.hidden) closeSearch(); else openSearch();
    return;
  }
  if (e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey && !isEditable(e.target) && !modalOpen() && !(searchEl && !searchEl.hidden)) {
    e.preventDefault();
    openSearch();
    return;
  }
  if (e.key === 'Escape' && qaMenu && !qaMenu.hidden) closeQuickMenu();
}

// ── Mount ────────────────────────────────────────────────────────────────────
export function mountShell() {
  if (mounted) return;
  const header = document.getElementById('header');
  if (!header || !document.body) return;
  mounted = true;

  const searchBtn = el('button', { class: 'gs-trigger', type: 'button', 'aria-label': 'Search (Ctrl+K)', title: `Search (${isMac ? '⌘' : 'Ctrl+'}K or /)` });
  searchBtn.innerHTML = ICON_SEARCH;
  searchBtn.append(el('span', { class: 'gs-trigger-label' }, 'Search…'), el('kbd', { class: 'gs-trigger-kbd' }, isMac ? '⌘K' : 'Ctrl K'));
  searchBtn.addEventListener('click', openSearch);

  const addBtn = el('button', { class: 'qa-header-btn', type: 'button', 'aria-label': 'Quick add', 'aria-haspopup': 'menu', 'aria-expanded': 'false', title: 'Quick add' });
  addBtn.innerHTML = ICON_PLUS;
  addBtn.addEventListener('click', e => { e.stopPropagation(); toggleQuickMenu(addBtn); });

  const wrap = el('div', { class: 'shell-actions' }, searchBtn, addBtn);
  header.appendChild(wrap);

  fab = el('button', { class: 'qa-fab', type: 'button', 'aria-label': 'Quick add', 'aria-haspopup': 'menu', 'aria-expanded': 'false' });
  fab.innerHTML = ICON_PLUS;
  fab.addEventListener('click', e => { e.stopPropagation(); toggleQuickMenu(fab); });
  document.body.appendChild(fab);
  document.body.classList.add('has-qa-fab');

  document.addEventListener('keydown', onGlobalKey);
  document.addEventListener('click', e => {
    if (qaMenu && !qaMenu.hidden && !qaMenu.contains(e.target)) closeQuickMenu();
  });
  window.addEventListener('hashchange', () => { closeQuickMenu(); });
  window.addEventListener('resize', () => closeQuickMenu());
  watchFabVisibility();
}
