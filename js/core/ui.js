// UI utilities: modals, toasts, confirm, forms
import { addDaysYmd, parseYmd } from './dates.js';
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') node.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

export function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ========== Modal ==========
let modalOverlay = null;
let _activeModal = null; // { onClose, escHandler, isDirty } for whichever modal is currently open, if any
// A closing modal clears the overlay 200 ms later (after the fade). Kept here
// so a modal opened inside that window cancels the clean-up instead of being
// wiped by it; the closed modal's onClose then runs straight away.
let _pendingClose = null; // { timer, onClose }

function flushPendingClose() {
  if (!_pendingClose) return;
  const { timer, onClose } = _pendingClose;
  _pendingClose = null;
  clearTimeout(timer);
  if (onClose) onClose();
}

function scheduleOverlayClear(overlay, onClose) {
  flushPendingClose();
  const pending = { onClose, timer: null };
  pending.timer = setTimeout(() => {
    if (_pendingClose !== pending) return;
    _pendingClose = null;
    overlay.innerHTML = '';
    if (onClose) onClose();
    document.dispatchEvent(new CustomEvent('bt:modal-closed'));
  }, 200);
  _pendingClose = pending;
}

// Inputs that don't count as unsaved form edits (filter boxes and the like).
function countsAsEdit(target) {
  if (!(target instanceof Element)) return false;
  if (target.closest('[data-no-dirty]')) return false;
  if (target.matches('input[type=search]')) return false;
  return target.matches('input, textarea, select, [contenteditable]');
}

// True while an open modal holds edits the user typed and hasn't saved.
export function hasUnsavedModalEdits() {
  return !!_activeModal?.isDirty?.();
}

function ensureOverlay() {
  if (!modalOverlay) {
    modalOverlay = document.getElementById('modal-overlay');
    if (!modalOverlay) {
      modalOverlay = el('div', { id: 'modal-overlay', class: 'modal-overlay' });
      document.body.appendChild(modalOverlay);
    }
  }
  return modalOverlay;
}

export function openModal({ title, body, footer, large = false, onClose } = {}) {
  const overlay = ensureOverlay();
  // A modal already open when a new one is requested (e.g. a rapid
  // double-click on a confirm-gated delete) gets force-closed first \u2014 firing
  // its onClose so any pending confirmDialog promise resolves as `false`
  // instead of hanging forever, which used to happen because the innerHTML
  // reset below silently wiped its buttons out from under it without ever
  // invoking its close().
  if (_activeModal) {
    document.removeEventListener('keydown', _activeModal.escHandler);
    // Its own close() must not act on the overlay once this modal owns it.
    _activeModal.markClosed?.();
    const prevOnClose = _activeModal.onClose;
    _activeModal = null;
    if (prevOnClose) prevOnClose();
  }
  // A modal that is still fading out must not clear this one 200 ms from now.
  flushPendingClose();
  overlay.innerHTML = '';
  const modal = el('div', { class: 'modal' + (large ? ' lg' : '') });
  const closeBtn = el('button', { class: 'modal-close', title: 'Close' }, '\u00d7');
  const header = el('div', { class: 'modal-header' },
    el('div', { class: 'modal-title' }, title || ''),
    closeBtn
  );
  const bodyEl = el('div', { class: 'modal-body' });
  if (typeof body === 'string') bodyEl.appendChild(document.createTextNode(body));
  else if (body instanceof Node) bodyEl.appendChild(body);

  modal.appendChild(header);
  modal.appendChild(bodyEl);
  if (footer) {
    const footerEl = el('div', { class: 'modal-footer' });
    if (Array.isArray(footer)) footer.forEach(b => footerEl.appendChild(b));
    else if (footer instanceof Node) footerEl.appendChild(footer);
    modal.appendChild(footerEl);
  }
  overlay.appendChild(modal);
  // Skipped if the modal was closed (or replaced) before the next frame, so
  // an emptied overlay is never left open over the page.
  requestAnimationFrame(() => { if (!closed) overlay.classList.add('open'); });

  // Unsaved-edit tracking: any user input in a form field marks the modal
  // dirty (programmatic value changes don't fire these events). Only the
  // user-dismiss paths below (×, Escape, backdrop) ask before discarding;
  // the returned close() — used by Save/Cancel buttons — never does.
  let dirty = false;
  const markEdited = e => { if (countsAsEdit(e.target)) dirty = true; };
  modal.addEventListener('input', markEdited);
  modal.addEventListener('change', markEdited);

  let closed = false;
  let discardBar = null;
  const hideDiscardBar = () => { discardBar?.remove(); discardBar = null; };
  const requestClose = () => {
    if (closed) return;
    if (!dirty) { close(); return; }
    if (discardBar) return;
    const keepBtn = el('button', { class: 'btn', type: 'button' }, 'Keep editing');
    const discardBtn = el('button', { class: 'btn danger', type: 'button' }, 'Discard');
    keepBtn.onclick = hideDiscardBar;
    discardBtn.onclick = () => { hideDiscardBar(); close(); };
    discardBar = el('div', {
      role: 'alertdialog',
      style: 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 16px;border-bottom:1px solid var(--border);background:var(--bg-elev-2);font-size:13px'
    }, el('span', { style: 'flex:1' }, 'Discard your unsaved changes?'), keepBtn, discardBtn);
    header.after(discardBar);
    keepBtn.focus();
  };

  function escHandler(e) {
    if (e.key !== 'Escape') return;
    if (discardBar) hideDiscardBar(); else requestClose();
  }
  const close = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', escHandler);
    if (_activeModal && _activeModal.escHandler === escHandler) _activeModal = null;
    overlay.classList.remove('open');
    scheduleOverlayClear(overlay, onClose);
  };
  closeBtn.onclick = requestClose;
  // Only a click that both starts and ends on the backdrop closes the modal:
  // selecting text in an input and releasing over the backdrop used to close it.
  let downOnBackdrop = false;
  overlay.onmousedown = e => { downOnBackdrop = e.target === overlay; };
  overlay.onclick = e => {
    const fromBackdrop = downOnBackdrop && e.target === overlay;
    downOnBackdrop = false;
    if (fromBackdrop) requestClose();
  };
  document.addEventListener('keydown', escHandler);
  _activeModal = { onClose, escHandler, isDirty: () => dirty && !closed, markClosed: () => { closed = true; } };
  return { modal, close, body: bodyEl };
}

export function closeModal() {
  const o = document.getElementById('modal-overlay');
  // Drop the tracked Escape-key listener so it doesn't leak (and so the next
  // openModal() call doesn't try to force-close a modal that was already
  // closed through this path instead of its own close()).
  let onClose = null;
  const hadActive = !!_activeModal;
  if (_activeModal) {
    document.removeEventListener('keydown', _activeModal.escHandler);
    _activeModal.markClosed?.();
    onClose = _activeModal.onClose;
    _activeModal = null;
  }
  // No modal open and none fading out: nothing to clear (router calls this
  // on every navigation).
  if (!hadActive && !_pendingClose && !(o && o.classList.contains('open'))) return;
  if (o) { o.classList.remove('open'); scheduleOverlayClear(o, onClose); }
}

export function drillDownModal(title, rows, columns) {
  const table = el('table', { class: 'table' });
  const headRow = el('tr');
  // col.tip is an optional hover tooltip describing what the column means —
  // opt-in per column definition, every existing caller is unaffected.
  for (const col of columns) headRow.appendChild(el('th', {
    class: col.right ? 'right' : '',
    title: col.tip || '',
    style: col.tip ? 'cursor:help' : ''
  }, col.label));
  table.appendChild(el('thead', {}, headRow));
  const tbody = el('tbody');
  if (!rows.length) {
    const tr = el('tr');
    tr.appendChild(el('td', { colspan: String(columns.length), style: 'text-align:center;padding:24px;color:var(--text-muted)' }, 'No records'));
    tbody.appendChild(tr);
  }

  const buildRow = (row) => {
    const tr = el('tr');
    for (const col of columns) {
      const raw = row[col.key];
      const display = col.format ? col.format(raw, row) : (raw ?? '—');
      const cell = el('td', { class: col.right ? 'right num' : '' });
      if (display instanceof Node) cell.appendChild(display);
      else cell.appendChild(document.createTextNode(String(display ?? '—')));
      tr.appendChild(cell);
    }
    return tr;
  };

  // Render in pages so a drill-down with thousands of records doesn't freeze the
  // UI building one DOM node per cell synchronously. All rows remain reachable
  // via "Show more". Each page is appended in a single DocumentFragment.
  const PAGE = 200;
  let shown = 0;
  const renderPage = () => {
    const frag = document.createDocumentFragment();
    const end = Math.min(shown + PAGE, rows.length);
    for (let i = shown; i < end; i++) frag.appendChild(buildRow(rows[i]));
    tbody.appendChild(frag);
    shown = end;
  };
  renderPage();

  table.appendChild(tbody);
  const tw = el('div', { class: 'table-wrap' });
  tw.appendChild(table);
  const meta = el('div', { style: 'font-size:12px;color:var(--text-muted);margin-bottom:12px' },
    `${rows.length} record${rows.length !== 1 ? 's' : ''}`);
  const body = el('div');
  body.appendChild(meta);
  body.appendChild(tw);
  if (rows.length > PAGE) {
    const moreBtn = el('button', { class: 'btn', style: 'margin-top:12px' });
    const updateLabel = () => { moreBtn.textContent = `Show more (${shown} of ${rows.length})`; };
    updateLabel();
    moreBtn.onclick = () => {
      renderPage();
      updateLabel();
      if (shown >= rows.length) moreBtn.remove();
    };
    body.appendChild(moreBtn);
  }
  openModal({ title, body, large: true });
}

export function confirmDialog(message, { title = 'Confirm', okLabel = 'OK', danger = false } = {}) {
  return new Promise(resolve => {
    let resolved = false;
    const settle = val => { if (!resolved) { resolved = true; resolve(val); } };
    const okBtn = el('button', { class: 'btn ' + (danger ? 'danger' : 'primary') }, okLabel);
    const cancelBtn = el('button', { class: 'btn' }, 'Cancel');
    const { close } = openModal({
      title,
      body: el('div', {}, message),
      footer: [cancelBtn, okBtn],
      onClose: () => settle(false)
    });
    okBtn.onclick = () => { close(); settle(true); };
    cancelBtn.onclick = () => { close(); settle(false); };
  });
}

// Two-step delete confirmation. First dialog asks the standard "delete X?" question;
// second asks for explicit final confirmation. Returns true only if both are accepted.
// Pass `label` as a short description of what's being deleted (e.g. "INV-001" or "3 invoices").
export async function confirmDeleteTwice(label) {
  const first = await confirmDialog(`Delete ${label}? This cannot be undone.`, { danger: true, okLabel: 'Delete' });
  if (!first) return false;
  // Wait for the first modal's close animation to fully complete (openModal clears
  // overlay.innerHTML after 200ms) before opening the second dialog, otherwise that
  // delayed cleanup fires mid-second-dialog and auto-dismisses it.
  await new Promise(r => setTimeout(r, 250));
  return confirmDialog(`Permanently delete ${label}? This is your final confirmation — the record will be gone.`, {
    title: 'Final confirmation', danger: true, okLabel: 'Yes, delete permanently'
  });
}

// ========== Toast ==========
export function toast(message, type = 'info', duration = 3000) {
  let wrap = document.getElementById('toasts');
  if (!wrap) {
    wrap = el('div', { id: 'toasts' });
    document.body.appendChild(wrap);
  }
  const t = el('div', { class: `toast ${type}` },
    el('div', { class: 'toast-icon' }, ({ success: '\u2713', danger: '\u2717', warning: '!', info: 'i' }[type] || 'i')),
    el('div', {}, message)
  );
  wrap.appendChild(t);
  setTimeout(() => {
    t.style.opacity = '0';
    t.style.transition = 'opacity 160ms ease';
    setTimeout(() => t.remove(), 200);
  }, duration);
}

// ========== Form helpers ==========
export function formRow(label, input, hint) {
  return el('div', { class: 'form-row' },
    label ? el('label', { class: 'form-label' }, label) : null,
    input,
    hint ? el('div', { class: 'fx-hint' }, hint) : null
  );
}

export function input(opts = {}) {
  const i = el('input', { class: 'input', ...opts });
  return i;
}

export function select(opts = [], current = '', attrs = {}) {
  const s = el('select', { class: 'select', ...attrs });
  const sel = Array.isArray(current) ? current.map(String) : [String(current)];
  for (const o of opts) {
    const val = typeof o === 'string' ? o : o.value;
    const label = typeof o === 'string' ? o : o.label;
    const option = el('option', { value: val }, label);
    if (sel.includes(String(val))) option.selected = true;
    s.appendChild(option);
  }
  return s;
}

export function selVals(sel) {
  const vals = [...sel.selectedOptions].map(o => o.value);
  return vals.length === 0 ? null : vals;
}

export function textarea(opts = {}) {
  return el('textarea', { class: 'textarea', ...opts });
}

export function button(label, opts = {}) {
  const cls = 'btn ' + (opts.variant || '');
  const b = el('button', { class: cls, type: opts.type || 'button' }, label);
  if (opts.onClick) b.onclick = opts.onClick;
  return b;
}

// ========== Date helpers ==========
// Local calendar date, NOT `new Date().toISOString().slice(0,10)` — that
// reads the UTC calendar date, which for any positive-UTC-offset viewer
// (e.g. Cyprus, UTC+2/+3) is a day BEHIND the real local date for the first
// few hours after local midnight, silently shifting every "today"-anchored
// range/deadline/comparison in the app during that window.
export function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Pure calendar arithmetic (see core/dates.js) — the previous version parsed
// as UTC but added days in local time, so across a DST change it returned the
// wrong day (e.g. addDays('2026-03-29', 1) → '2026-03-29' in Cyprus).
export function addDays(dateStr, days) {
  return addDaysYmd(dateStr, days);
}

// toLocaleDateString() builds a fresh Intl.DateTimeFormat on every call —
// measurable when a table formats thousands of dates. Reuse one per option set.
const _dtfCache = new Map();
function dateFormatter(locale, opts) {
  const key = locale + '|' + JSON.stringify(opts);
  let f = _dtfCache.get(key);
  if (!f) { f = new Intl.DateTimeFormat(locale, opts); _dtfCache.set(key, f); }
  return f;
}
const FMT_DATE_UTC   = { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' };
const FMT_DATE_LOCAL = { year: 'numeric', month: 'short', day: 'numeric' };

export function fmtDate(dateStr) {
  if (!dateStr) return '';
  try {
    // A bare YYYY-MM-DD is formatted as that calendar day (UTC midnight read
    // back in UTC), independent of the viewer's timezone.
    if (typeof dateStr === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      return dateFormatter('en-US', FMT_DATE_UTC).format(parseYmd(dateStr));
    }
    const d = new Date(dateStr);
    if (isNaN(d)) return 'Invalid Date'; // what toLocaleDateString() returned (format() throws)
    return dateFormatter('en-US', FMT_DATE_LOCAL).format(d);
  } catch { return dateStr; }
}

export function monthLabel(yyyymm) {
  try {
    const [y, m] = yyyymm.split('-');
    return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
  } catch { return yyyymm; }
}

// ========== Table sort + filter ==========
const SORT_TYPE_RANK = { n: 0, d: 1, s: 2 };
const SORT_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

// pageSize (optional): show at most this many matching rows, with a
// "Show more" button for the rest. Paging is applied after sort + search, so
// both still cover every row; paged-out rows get the `sf-paged-out` class
// (display:none via CSS) rather than style.display, so listeners of
// 'sf:filter' that count/sum rows with style.display !== 'none' keep seeing
// every matching row.
// Returns { refresh } — re-applies sort/search/paging, for callers that
// append rows into an already-attached <tbody> (not seen by the observer).
export function attachSortFilter(tableWrap, { placeholder = 'Filter rows…', initialCol = -1, initialDir = 1, initialSearch = '', onSortChange = null, onSearchChange = null, pageSize = 0 } = {}) {
  let sortCol = initialCol, sortDir = initialDir, searchTerm = initialSearch.toLowerCase();
  let shown = pageSize;

  const searchWrap = el('div', { style: 'display:flex;justify-content:flex-end;margin-bottom:8px' });
  const searchInput = el('input', { type: 'search', class: 'input', placeholder, value: initialSearch, style: 'max-width:220px;font-size:13px' });
  searchWrap.appendChild(searchInput);
  tableWrap.parentNode.insertBefore(searchWrap, tableWrap);

  let moreWrap = null, moreBtn = null;
  if (pageSize > 0) {
    moreBtn = el('button', { class: 'btn sm ghost', type: 'button' });
    moreWrap = el('div', { class: 'sf-more', style: 'display:none' }, moreBtn);
    tableWrap.parentNode.insertBefore(moreWrap, tableWrap.nextSibling);
    moreBtn.addEventListener('click', () => { shown += pageSize; applyFilter(); });
  }

  // Matches whole-string date-like text (anchored) so a month name only
  // counts as a date when it's actually shaped like one — e.g. "Aug 7, 2026"
  // (fmtDate's format) or "Aug 26" (monthLabel's format) — and NOT when a
  // month name merely appears inside ordinary text such as "May Street
  // Villa" or "March 2024 rent" (trailing/leading words break the anchor).
  const DATE_LIKE_RE = /^(?:(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s*\d{2,4}|\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?,?\s*\d{2,4}|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{2,4})$/i;

  const parseCell = txt => {
    // Placeholders ("—", "-", "N/A", blank) are their own type and always
    // sort last, whichever the direction.
    if (!txt || /^[—–-]+$/.test(txt) || /^n\/?a$/i.test(txt)) return { t: 'e', v: 0 };
    if (/^\d{4}-\d{2}/.test(txt) || DATE_LIKE_RE.test(txt.trim())) {
      const time = new Date(txt).getTime();
      if (!isNaN(time)) return { t: 'd', v: time };
    }
    // Only treat as numeric when the cell is a plain number, currency amount,
    // or percentage (e.g. "€1,500", "HUF 50,000", "7.0%", "-4.5%") — not when
    // text merely contains digits (e.g. "Danko u. 38 -2" would otherwise sort
    // as 38, not alphabetically). Stripping '%' matters: without it, "9.0%"
    // sorted as a *string* lands after "10.0%"/"20.0%" (lexicographic '9' >
    // '1'), so any percentage column (ROI, Cost %, Var % etc.) sorted in
    // visibly wrong order instead of numerically.
    const clean = txt.replace(/^[A-Z]{2,3}\s*/, '').replace(/[€£$¥₿%,\s]/g, '');
    const n = parseFloat(clean);
    if (!isNaN(n) && clean !== '' && /^-?[\d.]+$/.test(clean)) return { t: 'n', v: n };
    return { t: 's', v: txt };
  };

  // Lower-cased text per row, computed once and reused by every keystroke's
  // filter pass. Any change to the rows' content (a re-render, an inline
  // edit swapping a row's cells) drops the whole cache via textObs; row
  // re-ordering by applySort doesn't change any text and is ignored.
  let rowText = new WeakMap();
  const textOf = tr => {
    let t = rowText.get(tr);
    if (t === undefined) { t = tr.textContent.toLowerCase(); rowText.set(tr, t); }
    return t;
  };
  const textObs = new MutationObserver(() => { rowText = new WeakMap(); });
  const TEXT_OBS_OPTS = { childList: true, subtree: true, characterData: true };
  textObs.observe(tableWrap, TEXT_OBS_OPTS);

  // obs is declared below; applySort references it via closure — safe because
  // applySort is only ever called after obs is initialised.
  let obs;

  const applySort = () => {
    if (sortCol < 0) return;
    const tbody = tableWrap.querySelector('tbody');
    if (!tbody || tbody.querySelector('.row-editing')) return;
    // Disconnect while re-ordering rows to prevent MutationObserver from
    // triggering enhance() → applySort() in an infinite loop.
    obs?.disconnect();
    // Parse each row's sort key once (not twice per comparison), then order
    // by type first — numbers, dates, text, placeholders — so a column that
    // mixes them sorts the same way every time.
    const getText = cell => (cell?.dataset?.sort ?? cell?.textContent ?? '').trim();
    const keyed = [...tbody.querySelectorAll('tr')].map(r => ({ r, k: parseCell(getText(r.cells[sortCol])) }));
    keyed.sort((a, b) => {
      const ak = a.k, bk = b.k;
      if (ak.t !== bk.t) {
        if (ak.t === 'e' || bk.t === 'e') return ak.t === 'e' ? 1 : -1;
        return (SORT_TYPE_RANK[ak.t] - SORT_TYPE_RANK[bk.t]) * sortDir;
      }
      if (ak.t === 'e') return 0;
      if (ak.t === 's') return SORT_COLLATOR.compare(ak.v, bk.v) * sortDir;
      return (ak.v - bk.v) * sortDir;
    });
    // Content changes queued before this point still invalidate the cache;
    // the re-ordering's own records below are discarded.
    if (textObs.takeRecords().length) rowText = new WeakMap();
    keyed.forEach(({ r }) => tbody.appendChild(r));
    textObs.takeRecords();
    obs?.observe(tableWrap, { childList: true });
  };

  const applyFilter = () => {
    const tbody = tableWrap.querySelector('tbody');
    if (!tbody) { if (moreWrap) moreWrap.style.display = 'none'; return; }
    let matched = 0;
    for (const tr of tbody.querySelectorAll('tr')) {
      const match = !searchTerm || textOf(tr).includes(searchTerm);
      tr.style.display = match ? '' : 'none';
      if (pageSize > 0) {
        if (match) matched++;
        tr.classList.toggle('sf-paged-out', match && matched > shown);
      }
    }
    if (moreWrap) {
      const rest = matched - shown;
      moreWrap.style.display = rest > 0 ? '' : 'none';
      if (rest > 0) moreBtn.textContent = `Show ${Math.min(rest, pageSize)} more (${rest} not shown)`;
    }
    tableWrap.dispatchEvent(new CustomEvent('sf:filter'));
  };

  const updateArrows = ths => {
    ths.forEach((th, i) => {
      const arr = th.querySelector('.sf-arr');
      if (!arr) return;
      arr.textContent = sortCol === i ? (sortDir > 0 ? ' ▲' : ' ▼') : ' ⇅';
      arr.style.opacity = sortCol === i ? '1' : '0.4';
    });
  };

  const enhance = () => {
    const table = tableWrap.querySelector('table');
    if (!table) { if (moreWrap) moreWrap.style.display = 'none'; return; }
    const ths = [...table.querySelectorAll('thead th')];
    ths.forEach((th, i) => {
      if (!th.textContent.trim() || th.dataset.sfOk) return;
      th.dataset.sfOk = '1';
      th.style.cursor = 'pointer';
      th.style.userSelect = 'none';
      const arr = el('span', { class: 'sf-arr', style: 'margin-left:4px;opacity:0.4;font-size:10px' }, ' ⇅');
      th.appendChild(arr);
      th.addEventListener('click', () => {
        if (sortCol === i) sortDir *= -1; else { sortCol = i; sortDir = 1; }
        onSortChange?.(sortCol, sortDir);
        applySort();
        applyFilter();
        updateArrows([...tableWrap.querySelector('table').querySelectorAll('thead th')]);
      });
    });
    applySort();
    applyFilter();
    updateArrows(ths);
  };

  // The search box filters on a short debounce — each pass touches every
  // row, so running it per keystroke made typing lag on big tables.
  let searchTimer;
  searchInput.addEventListener('input', () => {
    searchTerm = searchInput.value.toLowerCase();
    onSearchChange?.(searchInput.value);
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { shown = pageSize; applyFilter(); }, 150);
  });

  let debounce;
  obs = new MutationObserver(() => { clearTimeout(debounce); debounce = setTimeout(enhance, 0); });
  obs.observe(tableWrap, { childList: true });
  enhance();
  return { refresh: enhance };
}

// ── Detach clean-up ───────────────────────────────────────────────────────────
// Runs `cleanup` once `node` has been attached to the document and then
// removed from it — for document-level listeners a widget adds, which would
// otherwise outlive the widget when a module rebuilds its DOM. One shared
// observer serves every watched node.
const _detachWatchers = new Set();
let _detachObserver = null;

const DETACH_NEVER_ATTACHED_MS = 60 * 1000;

function checkDetached() {
  const now = Date.now();
  for (const w of _detachWatchers) {
    if (w.node.isConnected) { w.attached = true; continue; }
    // Built but not inserted yet; one never inserted is dropped after a while.
    if (!w.attached && now - w.born < DETACH_NEVER_ATTACHED_MS) continue;
    _detachWatchers.delete(w);
    try { w.cleanup(); } catch (e) { console.error(e); }
  }
  if (_detachWatchers.size === 0 && _detachObserver) { _detachObserver.disconnect(); _detachObserver = null; }
}

export function whenDetached(node, cleanup) {
  _detachWatchers.add({ node, cleanup, attached: node.isConnected, born: Date.now() });
  if (!_detachObserver && typeof MutationObserver === 'function' && document.body) {
    _detachObserver = new MutationObserver(checkDetached);
    _detachObserver.observe(document.body, { childList: true, subtree: true });
  }
}

// ── Shared multi-select dropdown ──────────────────────────────────────────────
// items:      [{ value, label, css?, color? }]
// filterSet:  a Set that is mutated to hold selected values (empty = all)
// onRefresh:  called once when the menu closes after a change was made
// storageKey: optional localStorage key for filter persistence
//
// The returned element has a .reset() method that restores the "show all" state.
// Sentinel stashed inside filterSet to mean "the user explicitly unchecked
// every option" (show NOTHING), as distinct from an empty Set meaning "no
// filter has ever been applied" (show all) — the convention every caller of
// this widget relies on. It can never collide with a real item value (those
// come from app data — ids, enum keys, years, etc.) and callers' existing
// `filterSet.has(realValue)` checks simply never match it, so an "explicit
// none" filterSet correctly excludes every real row without requiring any
// caller-side changes.
const MS_NONE_SENTINEL = '\u0000__ms_none__';

export function buildMultiSelect(initialItems, filterSet, allLabel, onRefresh, storageKey = null) {
  // ── Restore persisted state into the Set before building the UI ────────────
  if (storageKey) {
    try {
      const raw = localStorage.getItem(`btf:${storageKey}`);
      if (raw !== null) {
        const vals = JSON.parse(raw);
        filterSet.clear();
        if (Array.isArray(vals)) vals.forEach(v => filterSet.add(v));
      }
    } catch { /* ignore corrupt data */ }
  }

  const wrapper   = el('div', { style: 'position:relative' });
  const trigLabel = el('span');
  const trigger   = el('div', {
    class: 'select',
    style: 'cursor:pointer;display:flex;align-items:center;gap:6px;width:auto;min-width:130px;user-select:none'
  }, trigLabel);

  const menu = el('div', {
    // 'ms-menu' + 'open' (toggled below) let background-sync code (see
    // app.js backgroundResync) detect an open filter dropdown the same way
    // it already detects an open modal, so a periodic refresh doesn't
    // rebuild this widget — and silently close it — out from under the user.
    class: 'ms-menu',
    style: [
      'display:none;position:absolute;top:calc(100% + 4px);left:0;z-index:300',
      'background:var(--bg-elev-2);border:1px solid var(--border)',
      'border-radius:var(--radius-sm);min-width:190px',
      'box-shadow:0 4px 16px rgba(0,0,0,0.35);padding:4px 0;max-height:260px;overflow-y:auto'
    ].join(';')
  });

  const allChk = el('input', { type: 'checkbox' });
  menu.appendChild(el('label', {
    style: 'display:flex;align-items:center;gap:8px;padding:6px 12px;cursor:pointer;border-bottom:1px solid var(--border);font-size:13px'
  }, allChk, el('span', {}, allLabel)));

  // items and chks are mutable so setItems() can swap them out
  let items = [];
  let chks  = [];

  // Reflects current checkbox state into the trigger label / "All" checkbox
  // WITHOUT touching filterSet. Used when rebuilding rows for a narrower
  // (leave-one-out faceted) item list, where "every visible row is checked"
  // must NOT be reinterpreted as "no filter" — that reading would silently
  // erase an explicit selection (e.g. narrowing Properties to one item can
  // narrow the Streams options down to just the one that item belongs to,
  // and since that lone option is checked, n === chks.length there too — but
  // the user's real, explicit "just this stream" choice must survive).
  const refreshUI = () => {
    const sel = chks.filter(c => c.checked);
    const n   = sel.length;
    allChk.checked       = n === chks.length;
    allChk.indeterminate = n > 0 && n < chks.length;
    trigLabel.textContent =
      n === chks.length ? allLabel
      : n === 0 ? 'None selected'
      : n === 1 ? (items.find(i => i.value === sel[0].dataset.value)?.label || '')
      : `${n} selected`;
  };

  // Recomputes filterSet from checkbox state — only call this from a real
  // user interaction (checkbox/"All"/"only" click), never from buildRows().
  const sync = () => {
    refreshUI();
    const sel = chks.filter(c => c.checked);
    filterSet.clear();
    if (chks.length > 0 && sel.length === 0) {
      // Every box explicitly unchecked by the user — must filter out
      // everything, not fall back to "no filter" just because the Set is
      // conventionally empty-means-all. The sentinel keeps the Set non-empty
      // (so callers' `.size` checks see an active filter) while never
      // matching any real value (so `.has(realValue)` is always false).
      filterSet.add(MS_NONE_SENTINEL);
    } else if (sel.length > 0 && sel.length < chks.length) {
      sel.forEach(c => filterSet.add(c.dataset.value));
    }
  };

  // Builds (or rebuilds) the item rows in the menu
  const buildRows = (newItems) => {
    while (menu.children.length > 1) menu.removeChild(menu.lastChild);
    // Prune selections that no longer exist in the new item set (but keep
    // the "explicit none" sentinel — it isn't, and never should be, one of
    // the real item values being pruned here).
    const newVals = new Set(newItems.map(i => i.value));
    for (const v of [...filterSet]) { if (v !== MS_NONE_SENTINEL && !newVals.has(v)) filterSet.delete(v); }
    items = newItems;
    chks  = newItems.map(({ value, label, css, color }) => {
      const chk         = el('input', { type: 'checkbox' });
      chk.dataset.value = value;
      chk.checked       = filterSet.size === 0 || filterSet.has(value);
      let content;
      if (css) {
        content = el('span', { class: `badge ${css}` }, label);
      } else if (color) {
        const dot = el('span', { style: `display:inline-block;width:8px;height:8px;border-radius:50%;background:${color};flex-shrink:0` });
        content = el('span', { style: 'display:flex;align-items:center;gap:6px' }, dot, el('span', {}, label));
      } else {
        content = el('span', {}, label);
      }
      // "only" isolates this single row — without it, clicking a row that's
      // already checked (the default "show all" state has every row checked)
      // unchecks it instead of narrowing the filter to just it, which reads as
      // "select just this one" but actually does the opposite.
      const onlyBtn = el('span', {
        style: 'margin-left:auto;padding-left:8px;font-size:11px;color:var(--text-muted);text-decoration:underline;flex-shrink:0'
      }, 'only');
      onlyBtn.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        chks.forEach(c => { c.checked = (c === chk); });
        sync();
      });
      menu.appendChild(el('label', {
        style: 'display:flex;align-items:center;gap:8px;padding:6px 12px;cursor:pointer;font-size:13px'
      }, chk, content, onlyBtn));
      chk.onchange = () => sync();
      return chk;
    });
    refreshUI();
  };

  const persist = () => {
    if (!storageKey) return;
    try { localStorage.setItem(`btf:${storageKey}`, JSON.stringify([...filterSet])); }
    catch { /* quota exceeded — ignore */ }
  };

  const closeMenu = () => {
    if (!wrapper.isConnected) { document.removeEventListener('click', closeMenu); return; }
    if (menu.style.display === 'none') return;
    menu.style.display = 'none';
    menu.classList.remove('open');
    persist();
    onRefresh();
  };

  allChk.checked  = filterSet.size === 0;
  allChk.onchange = () => { chks.forEach(c => { c.checked = allChk.checked; }); allChk.indeterminate = false; sync(); };
  trigger.onclick = e => {
    e.stopPropagation();
    if (menu.style.display === 'none') { menu.style.display = ''; menu.classList.add('open'); }
    else closeMenu();
  };
  menu.onclick    = e => e.stopPropagation();
  document.addEventListener('click', closeMenu);
  // Modules rebuild their DOM wholesale (innerHTML = '') on every refresh —
  // including the ~60s background sync poll — so a fresh widget attaches a
  // new listener above on every cycle. closeMenu's own self-removal only
  // runs on the NEXT document click, so on an idle tab with no clicks these
  // pile up indefinitely, each one holding this whole widget's DOM alive via
  // its closure. Detect removal proactively instead of waiting for a click.
  whenDetached(wrapper, () => document.removeEventListener('click', closeMenu));

  wrapper.appendChild(trigger);
  wrapper.appendChild(menu);
  buildRows(initialItems);

  // ── Public reset method — restores "show all" without triggering onRefresh ─
  wrapper.reset = () => {
    chks.forEach(c => { c.checked = true; });
    allChk.checked = true;
    allChk.indeterminate = false;
    sync();
    persist();
  };

  // ── Swap in a new option list (prunes stale selections, updates UI) ─────────
  wrapper.setItems = buildRows;

  return wrapper;
}
