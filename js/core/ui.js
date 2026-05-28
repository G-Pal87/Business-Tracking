// UI utilities: modals, toasts, confirm, forms
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') node.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k === 'html') node.innerHTML = v;
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
  overlay.innerHTML = '';
  const modal = el('div', { class: 'modal' + (large ? ' lg' : '') });
  const closeBtn = el('button', { class: 'modal-close', title: 'Close' }, '\u00d7');
  const header = el('div', { class: 'modal-header' },
    el('div', { class: 'modal-title' }, title || ''),
    closeBtn
  );
  const bodyEl = el('div', { class: 'modal-body' });
  if (typeof body === 'string') bodyEl.innerHTML = body;
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
  requestAnimationFrame(() => overlay.classList.add('open'));

  function escHandler(e) {
    if (e.key === 'Escape') close();
  }
  const close = () => {
    document.removeEventListener('keydown', escHandler);
    overlay.classList.remove('open');
    setTimeout(() => { overlay.innerHTML = ''; if (onClose) onClose(); }, 200);
  };
  closeBtn.onclick = close;
  overlay.onclick = e => { if (e.target === overlay) close(); };
  document.addEventListener('keydown', escHandler);
  return { modal, close, body: bodyEl };
}

export function closeModal() {
  const o = document.getElementById('modal-overlay');
  if (o) { o.classList.remove('open'); setTimeout(() => { o.innerHTML = ''; }, 200); }
}

export function drillDownModal(title, rows, columns) {
  const table = el('table', { class: 'table' });
  const headRow = el('tr');
  for (const col of columns) headRow.appendChild(el('th', { class: col.right ? 'right' : '' }, col.label));
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
export function today() { return new Date().toISOString().slice(0, 10); }

export function addDays(dateStr, days) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

export function fmtDate(dateStr) {
  if (!dateStr) return '';
  try {
    return new Date(dateStr).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  } catch { return dateStr; }
}

export function monthLabel(yyyymm) {
  try {
    const [y, m] = yyyymm.split('-');
    return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
  } catch { return yyyymm; }
}

// ========== Table sort + filter ==========
export function attachSortFilter(tableWrap, { placeholder = 'Filter rows…', initialCol = -1, initialDir = 1, onSortChange = null } = {}) {
  let sortCol = initialCol, sortDir = initialDir, searchTerm = '';

  const searchWrap = el('div', { style: 'display:flex;justify-content:flex-end;margin-bottom:8px' });
  const searchInput = el('input', { type: 'search', class: 'input', placeholder, style: 'max-width:220px;font-size:13px' });
  searchWrap.appendChild(searchInput);
  tableWrap.parentNode.insertBefore(searchWrap, tableWrap);

  const parseCell = txt => {
    if ((/^\d{4}-\d{2}/.test(txt) || (/[a-zA-Z]/.test(txt) && txt.length >= 6)) && !isNaN(new Date(txt)))
      return { t: 'd', v: new Date(txt).getTime() };
    // Only treat as numeric when the cell is a plain number or currency amount
    // (e.g. "€1,500", "HUF 50,000") — not when text merely contains digits
    // (e.g. "Danko u. 38 -2" would otherwise sort as 38, not alphabetically).
    const clean = txt.replace(/^[A-Z]{2,3}\s*/, '').replace(/[€£$¥₿,\s]/g, '');
    const n = parseFloat(clean);
    if (!isNaN(n) && clean !== '' && /^-?[\d.]+$/.test(clean)) return { t: 'n', v: n };
    return { t: 's', v: txt };
  };

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
    const rows = [...tbody.querySelectorAll('tr')];
    rows.sort((a, b) => {
      const getText = cell => cell?.dataset?.sort ?? cell?.textContent?.trim() ?? '';
      const ap = parseCell(getText(a.cells[sortCol]));
      const bp = parseCell(getText(b.cells[sortCol]));
      if (ap.t === bp.t && ap.t !== 's') return (ap.v - bp.v) * sortDir;
      return String(ap.v).localeCompare(String(bp.v)) * sortDir;
    });
    rows.forEach(r => tbody.appendChild(r));
    obs?.observe(tableWrap, { childList: true });
  };

  const applyFilter = () => {
    const tbody = tableWrap.querySelector('tbody');
    if (!tbody) return;
    [...tbody.querySelectorAll('tr')].forEach(tr => {
      tr.style.display = !searchTerm || tr.textContent.toLowerCase().includes(searchTerm) ? '' : 'none';
    });
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
    if (!table) return;
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

  searchInput.addEventListener('input', () => {
    searchTerm = searchInput.value.toLowerCase();
    applyFilter();
  });

  let debounce;
  obs = new MutationObserver(() => { clearTimeout(debounce); debounce = setTimeout(enhance, 0); });
  obs.observe(tableWrap, { childList: true });
  enhance();
}

// ── Shared multi-select dropdown ──────────────────────────────────────────────
// items:      [{ value, label, css?, color? }]
// filterSet:  a Set that is mutated to hold selected values (empty = all)
// onRefresh:  called once when the menu closes after a change was made
// storageKey: optional localStorage key for filter persistence
//
// The returned element has a .reset() method that restores the "show all" state.
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

  const sync = () => {
    const sel = chks.filter(c => c.checked);
    const n   = sel.length;
    allChk.checked       = n === chks.length;
    allChk.indeterminate = n > 0 && n < chks.length;
    trigLabel.textContent =
      n === chks.length || n === 0 ? allLabel
      : n === 1 ? (items.find(i => i.value === sel[0].dataset.value)?.label || '')
      : `${n} selected`;
    filterSet.clear();
    if (n > 0 && n < chks.length) sel.forEach(c => filterSet.add(c.dataset.value));
  };

  // Builds (or rebuilds) the item rows in the menu
  const buildRows = (newItems) => {
    while (menu.children.length > 1) menu.removeChild(menu.lastChild);
    // Prune selections that no longer exist in the new item set
    const newVals = new Set(newItems.map(i => i.value));
    for (const v of [...filterSet]) { if (!newVals.has(v)) filterSet.delete(v); }
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
      menu.appendChild(el('label', {
        style: 'display:flex;align-items:center;gap:8px;padding:6px 12px;cursor:pointer;font-size:13px'
      }, chk, content));
      chk.onchange = () => sync();
      return chk;
    });
    sync();
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
    persist();
    onRefresh();
  };

  allChk.checked  = filterSet.size === 0;
  allChk.onchange = () => { chks.forEach(c => { c.checked = allChk.checked; }); allChk.indeterminate = false; sync(); };
  trigger.onclick = e => { e.stopPropagation(); menu.style.display === 'none' ? (menu.style.display = '') : closeMenu(); };
  menu.onclick    = e => e.stopPropagation();
  document.addEventListener('click', closeMenu);

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
