// UI utilities: modals, toasts, confirm, forms
import { addDaysYmd, parseYmd } from './dates.js';
import { downloadCsv } from './csv.js';
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
  const table = el('table', { class: 'table dd-table' });
  const headRow = el('tr');
  // col.tip is an optional hover tooltip describing what the column means —
  // opt-in per column definition, every existing caller is unaffected.
  const thEls = columns.map(col => el('th', {
    class: col.right ? 'right' : '',
    title: col.tip || '',
    style: col.tip ? 'cursor:help' : ''
  }, col.label));
  thEls.forEach(th => headRow.appendChild(th));
  table.appendChild(el('thead', {}, headRow));
  const tbody = el('tbody');
  if (!rows.length) {
    const tr = el('tr');
    tr.appendChild(el('td', { colspan: String(columns.length), style: 'text-align:center;padding:24px;color:var(--text-muted)' }, 'No records'));
    tbody.appendChild(tr);
  }

  const displayOf = (row, col) => {
    const raw = row[col.key];
    return col.format ? col.format(raw, row) : (raw ?? '—');
  };
  const buildRow = (row) => {
    const tr = el('tr');
    if (row && row._total) tr.classList.add('dd-total');
    for (const col of columns) {
      const display = displayOf(row, col);
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
  // `order` is the current display order (indices into rows) — re-sorting
  // replaces it and starts the paging over.
  const PAGE = 200;
  let order = rows.map((_, i) => i);
  let shown = 0;
  const renderPage = () => {
    const frag = document.createDocumentFragment();
    const end = Math.min(shown + PAGE, order.length);
    for (let i = shown; i < end; i++) frag.appendChild(buildRow(rows[order[i]]));
    tbody.appendChild(frag);
    shown = end;
  };
  renderPage();

  table.appendChild(tbody);
  const tw = el('div', { class: 'table-wrap dd-scroll' });
  tw.appendChild(table);
  const meta = el('div', { class: 'dd-meta', style: 'font-size:12px;color:var(--text-muted)' },
    `${rows.length} record${rows.length !== 1 ? 's' : ''}`);
  const toolbar = el('div', { class: 'dd-toolbar' }, meta);
  const body = el('div', { class: 'dd-body' });
  body.appendChild(toolbar);
  body.appendChild(tw);
  let moreBtn = null;
  const updateMore = () => {
    if (order.length <= shown) { moreBtn?.remove(); return; }
    if (!moreBtn) {
      moreBtn = el('button', { class: 'btn', type: 'button', style: 'margin-top:12px' });
      moreBtn.onclick = () => { renderPage(); updateMore(); };
    }
    moreBtn.textContent = `Show more (${shown} of ${order.length})`;
    if (!moreBtn.isConnected) body.appendChild(moreBtn);
  };
  updateMore();

  if (rows.length) {
    // Each cell's raw value + displayed text, computed only when a sort or an
    // export first needs it (formatting every cell up front would undo the
    // paging above for big drill-downs).
    const cellCache = new Array(rows.length);
    const cellsOf = i => cellCache[i] || (cellCache[i] = columns.map(col => {
      const row = rows[i];
      return { raw: row?.[col.key], text: breakdownCellText(displayOf(row, col)) };
    }));
    const tools = attachBreakdownTools({
      columns: columns.map(c => ({ label: String(c.label ?? ''), tip: c.tip || '' })),
      count: rows.length,
      cellsOf,
      flagged: i => !!(rows[i] && (rows[i]._total || rows[i]._summary)),
      thEls,
      render: next => {
        order = next;
        tbody.textContent = '';
        shown = 0;
        renderPage();
        updateMore();
      },
      getTitle: () => breakdownTitleText(title)
    });
    toolbar.appendChild(tools.menu);
  }
  openModal({ title, body, large: true });
}

// ========== Breakdown tables: sort + export ==========
// Shared by drillDownModal above and analytics-helpers' mkModalTable, so every
// breakdown pop-up gets the same sortable headers and CSV / Excel download.
// The helpers below the DOM part are pure (exported via _breakdownInternals
// for the node tests).

// First-column text of a summary row that stays pinned at the bottom.
const SUMMARY_LEAD = /^\s*(?:(?:grand |sub-?)?totals?|average|avg)\b|^\s*[=÷Σ]/i;
// '', '—', '–', '-' (and runs of them): "no value".
const DASH_ONLY = /^[\s—–‒−-]*$/;
const ISO_DATE = /^\d{4}-\d{2}(-\d{2})?([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z?)?$/;
const MONTH_WORD = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?(?=\s|,|$)/i;

function breakdownCellText(v) {
  if (v == null) return '';
  if (typeof Node !== 'undefined' && v instanceof Node) return (v.textContent || '').replace(/\s+/g, ' ').trim();
  return String(v).replace(/\s+/g, ' ').trim();
}

function breakdownTitleText(title) {
  if (typeof Node !== 'undefined' && title instanceof Node) return breakdownCellText(title);
  return title == null ? '' : String(title);
}

// "€1,234.56", "−€12", "(1,234)", "45.2%", "1.5x", "HUF 12,000", "€1.2k" →
// { n, dec, mult, pct }; anything that isn't a single figure → null.
function parseDisplayFigure(s) {
  let t = String(s ?? '').trim();
  if (!t || DASH_ONLY.test(t)) return null;
  let neg = false;
  t = t.replace(/−/g, '-');
  if (/^\(.*\)$/.test(t)) { neg = true; t = t.slice(1, -1).trim(); }
  t = t.replace(/^[A-Z]{3}\s+/, '').replace(/\s+([A-Z]{3}|Ft)$/, '');
  t = t.replace(/[€$£¥₺₽₹\s  ,]/g, '');
  const pct = /%$/.test(t);
  t = t.replace(/(%|x|×)$/i, '');
  let mult = 1;
  const suf = /([kKmM])$/.exec(t);
  if (suf) { mult = /k/i.test(suf[1]) ? 1e3 : 1e6; t = t.slice(0, -1); }
  t = t.replace(/^\+/, '');
  // A sign written before the currency symbol ("-€12") has already lost the
  // symbol above; one written after it ("€-12") is the same text now.
  if (!/^-?(\d+(\.\d*)?|\.\d+)$/.test(t)) return null;
  const dec = (t.split('.')[1] || '').length;
  let n = Number(t) * mult;
  if (neg) n = -n;
  return { n, dec, mult, pct };
}

export function parseDisplayNumber(s) {
  const f = parseDisplayFigure(s);
  return f ? f.n : null;
}

// The number a cell stands for. The raw value wins when the displayed figure
// is just a rounding of it (exports keep full precision); when the column's
// formatter converted it (another currency, a scaled unit) the displayed
// figure is what the column means, so that one is used.
function breakdownNumber(raw, text) {
  const hasRaw = typeof raw === 'number' && Number.isFinite(raw);
  const f = parseDisplayFigure(text);
  if (!hasRaw) return f ? f.n : null;
  if (!f) return raw;
  const tol = 0.5 * Math.pow(10, -f.dec) * f.mult + 1e-9;
  if (Math.abs(f.n - raw) <= tol) return raw;
  if (Math.abs(Math.abs(f.n) - Math.abs(raw)) <= tol) return Math.sign(f.n || 1) * Math.abs(raw);
  if (f.pct && Math.abs(f.n - raw * 100) <= tol) return raw * 100;
  return f.n;
}

function parseDisplayDate(s) {
  if (!MONTH_WORD.test(s) || !/\b\d{4}\b/.test(s)) return null;
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Sort key for one cell: null (no value — always last), or { t, v } where
// t orders the kinds (0 number, 1 date as ISO text, 2 text).
export function breakdownSortKey(raw, text) {
  const rawText = typeof raw === 'string' ? raw.trim() : '';
  if (DASH_ONLY.test(text) && !rawText) return null;
  if (raw instanceof Date && !isNaN(raw)) return { t: 1, v: raw.toISOString() };
  if (rawText && ISO_DATE.test(rawText)) return { t: 1, v: rawText };
  const s = DASH_ONLY.test(text) ? rawText : text;
  const n = breakdownNumber(raw, s);
  if (n != null) return { t: 0, v: n };
  const d = parseDisplayDate(s);
  if (d) return { t: 1, v: d };
  return { t: 2, v: s };
}

let _collator = null;
export function compareSortKeys(a, b, dir = 'asc') {
  if (a == null || b == null) return a == null ? (b == null ? 0 : 1) : -1;
  let c = a.t - b.t;
  if (!c) {
    if (a.t === 2) {
      _collator = _collator || new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
      c = _collator.compare(a.v, b.v);
    } else c = a.v < b.v ? -1 : a.v > b.v ? 1 : 0;
  }
  return dir === 'desc' ? -c : c;
}

// Value written to the CSV / Excel file for one cell: a number for anything
// numeric (raw value, not the formatted text), the ISO date for raw dates,
// otherwise the text shown; '' for an empty / "—" cell.
export function breakdownExportValue(raw, text) {
  const rawText = typeof raw === 'string' ? raw.trim() : '';
  if (DASH_ONLY.test(text) && !rawText) return '';
  if (rawText && ISO_DATE.test(rawText)) return rawText;
  const s = DASH_ONLY.test(text) ? rawText : text;
  const n = breakdownNumber(raw, s);
  if (n != null) return Number(n.toPrecision(12));
  return s;
}

// A summary row by its cell texts: the first cell starts with Total /
// Average / "=" / "÷", or one of the next two cells is a lone "=" / "÷"
// operator ("Est. Annual Revenue | = | €85,675").
export function isSummaryTexts(texts) {
  if (SUMMARY_LEAD.test(texts[0] || '')) return true;
  return texts.slice(1, 3).some(t => /^\s*[=÷]\s*$/.test(t || ''));
}

// Trailing summary rows stay pinned at the bottom: returns the index the
// pinned run starts at (count when there is none). Never pins every row.
export function summaryStart(count, isSummary) {
  let i = count;
  while (i > 1 && isSummary(i - 1)) i--;
  return i;
}

// Indices in display order: the sortable rows sorted (stable — ties keep the
// original order), then the pinned summary rows as given.
export function breakdownOrder(count, pinStart, keyOf, dir) {
  const idx = [];
  for (let i = 0; i < pinStart; i++) idx.push(i);
  if (dir) {
    const keys = idx.map(keyOf);
    idx.sort((a, b) => compareSortKeys(keys[a], keys[b], dir) || a - b);
  }
  for (let i = pinStart; i < count; i++) idx.push(i);
  return idx;
}

// Portable file name from the pop-up title: plain ASCII (browsers fall back
// to "download" for some characters), "—" → "-", "€" → "EUR", accents dropped.
export function breakdownFilename(title, ext) {
  const base = String(title || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u2010-\u2015\u2212]/g, '-').replace(/€/g, 'EUR').replace(/£/g, 'GBP').replace(/\$/g, 'USD')
    .replace(/[÷]/g, '-').replace(/[^A-Za-z0-9 _.,()&+#'-]+/g, ' ')
    .replace(/\s+/g, ' ').trim().replace(/^[. -]+|[. -]+$/g, '').slice(0, 100) || 'breakdown';
  return `${base}.${ext}`;
}

// ── Minimal .xlsx writer (one sheet, stored ZIP — no library needed) ────────
let _crcTable = null;
function crc32(bytes) {
  if (!_crcTable) {
    _crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      _crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = _crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zipStore(files) {
  const enc = new TextEncoder();
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const parts = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const data = typeof f.data === 'string' ? enc.encode(f.data) : f.data;
    const crc = crc32(data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
    lh.setUint16(8, 0, true); lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true);
    lh.setUint32(14, crc, true); lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true);
    lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
    parts.push(new Uint8Array(lh.buffer), name, data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true);
    ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true); ch.setUint16(12, dosTime, true);
    ch.setUint16(14, dosDate, true); ch.setUint32(16, crc, true); ch.setUint32(20, data.length, true);
    ch.setUint32(24, data.length, true); ch.setUint16(28, name.length, true);
    ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const cdSize = central.reduce((s, p) => s + p.length, 0);
  const eo = new DataView(new ArrayBuffer(22));
  eo.setUint32(0, 0x06054b50, true); eo.setUint16(8, files.length, true); eo.setUint16(10, files.length, true);
  eo.setUint32(12, cdSize, true); eo.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(eo.buffer)];
  const out = new Uint8Array(all.reduce((s, p) => s + p.length, 0));
  let pos = 0;
  for (const p of all) { out.set(p, pos); pos += p.length; }
  return out;
}

const xmlEsc = s => String(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '')
  .replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const colRef = n => { let s = ''; n++; while (n) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };

// rows[0] is the header row; boldRows holds indices (into rows) to embolden.
export function buildXlsx(sheetName, rows, boldRows = new Set()) {
  const ncol = rows.reduce((m, r) => Math.max(m, r.length), 0);
  // Columns holding any fractional number get a #,##0.00 format throughout.
  const money = Array.from({ length: ncol }, (_, c) => rows.some((r, ri) => ri > 0 && typeof r[c] === 'number' && !Number.isInteger(r[c])));
  const widths = Array.from({ length: ncol }, (_, c) => Math.min(60, Math.max(8, ...rows.map(r => String(r[c] ?? '').length + 2))));
  const isoDay = /^(\d{4})-(\d{2})-(\d{2})$/;
  const sheetRows = rows.map((r, ri) => {
    const bold = ri === 0 || boldRows.has(ri);
    const cells = r.map((v, ci) => {
      const ref = colRef(ci) + (ri + 1);
      if (v === '' || v == null) return bold ? `<c r="${ref}" s="1"/>` : '';
      if (typeof v === 'number' && Number.isFinite(v)) {
        const s = money[ci] ? (bold ? 4 : 3) : (bold ? 1 : 0);
        return `<c r="${ref}"${s ? ` s="${s}"` : ''}><v>${v}</v></c>`;
      }
      const m = ri > 0 && typeof v === 'string' && isoDay.exec(v);
      if (m) {
        const serial = (Date.UTC(+m[1], +m[2] - 1, +m[3]) - Date.UTC(1899, 11, 30)) / 86400000;
        if (Number.isFinite(serial) && serial > 0) return `<c r="${ref}" s="${bold ? 5 : 2}"><v>${serial}</v></c>`;
      }
      return `<c r="${ref}" t="inlineStr"${bold ? ' s="1"' : ''}><is><t xml:space="preserve">${xmlEsc(v)}</t></is></c>`;
    }).join('');
    return `<row r="${ri + 1}">${cells}</row>`;
  }).join('');
  const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const RNS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  const sheet = `${head}<worksheet xmlns="${NS}"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` +
    (ncol ? `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` : '') +
    `<sheetData>${sheetRows}</sheetData></worksheet>`;
  const name = (String(sheetName || 'Sheet1').replace(/[\[\]:*?/\\]/g, ' ').trim().slice(0, 31)) || 'Sheet1';
  const styles = `${head}<styleSheet xmlns="${NS}"><numFmts count="2"><numFmt numFmtId="164" formatCode="#,##0.00"/><numFmt numFmtId="165" formatCode="yyyy-mm-dd"/></numFmts>` +
    '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
    '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="6">' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
    '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
    '<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
    '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
    '<xf numFmtId="164" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>' +
    '<xf numFmtId="165" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>' +
    '</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
  return zipStore([
    { name: '[Content_Types].xml', data: `${head}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>` },
    { name: '_rels/.rels', data: `${head}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${RNS}/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: 'xl/workbook.xml', data: `${head}<workbook xmlns="${NS}" xmlns:r="${RNS}"><sheets><sheet name="${xmlEsc(name)}" sheetId="1" r:id="rId1"/></sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: `${head}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${RNS}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${RNS}/styles" Target="styles.xml"/></Relationships>` },
    { name: 'xl/styles.xml', data: styles },
    { name: 'xl/worksheets/sheet1.xml', data: sheet }
  ]);
}

function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

const DL_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg>';

// "Download ▾" button with a two-item menu (CSV / Excel). Escape and arrow
// keys work inside the menu; Escape there closes only the menu, not the modal.
function mkDownloadMenu(onPick, { compact = false } = {}) {
  const wrap = el('div', { class: 'dd-dl' + (compact ? ' dd-dl-compact' : '') });
  const btn = el('button', {
    type: 'button', class: 'btn sm dd-dl-btn', 'aria-haspopup': 'menu', 'aria-expanded': 'false',
    title: 'Download this table (CSV or Excel)', 'aria-label': 'Download this table'
  });
  btn.innerHTML = DL_ICON + '<span class="dd-dl-label">Download</span>';
  const menu = el('div', { class: 'dd-dl-menu', role: 'menu', hidden: true });
  let onDoc = null;
  const close = (focusBtn) => {
    if (menu.hidden) return;
    menu.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    if (onDoc) { document.removeEventListener('pointerdown', onDoc, true); onDoc = null; }
    if (focusBtn) btn.focus();
  };
  const items = [['csv', 'CSV', '.csv'], ['xlsx', 'Excel', '.xlsx']].map(([fmt, label, ext]) => {
    const b = el('button', { type: 'button', role: 'menuitem', class: 'dd-dl-item', 'data-fmt': fmt },
      el('span', {}, label), el('span', { class: 'dd-dl-ext' }, ext));
    b.onclick = () => { close(true); onPick(fmt); };
    return b;
  });
  items.forEach(b => menu.appendChild(b));
  const open = () => {
    menu.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    onDoc = e => { if (!wrap.contains(e.target)) close(false); };
    document.addEventListener('pointerdown', onDoc, true);
    items[0].focus();
  };
  btn.onclick = () => (menu.hidden ? open() : close(true));
  wrap.addEventListener('keydown', e => {
    if (menu.hidden) {
      if (e.target === btn && (e.key === 'ArrowDown')) { e.preventDefault(); open(); }
      return;
    }
    const at = items.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); items[(at + 1) % items.length].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(at - 1 + items.length) % items.length].focus(); }
    else if (e.key === 'Tab') close(false);
  });
  wrap.appendChild(btn);
  wrap.appendChild(menu);
  return wrap;
}

// Makes a rendered table sortable by its header cells and builds its
// Download menu. The caller owns the rows' DOM: `render(order)` gets the row
// indices in display order and redraws the body.
//   columns  [{ label, tip }]       cellsOf(i) → [{ raw, text }] per column
//   flagged(i) → true for a caller-marked total/summary row
//   thEls    the header cells (same order as columns)
//   getTitle() → text used for the file name
export function attachBreakdownTools({ columns, count, cellsOf, flagged = () => false, thEls = [], render, getTitle, compact = false, sortable = true }) {
  const pinStart = summaryStart(count, i => flagged(i) || isSummaryTexts(cellsOf(i).map(c => c.text || '')));
  let sortCol = -1;
  let sortDir = null;
  const keyCache = new Map();
  const keysFor = ci => {
    if (!keyCache.has(ci)) {
      const ks = [];
      for (let i = 0; i < pinStart; i++) { const c = cellsOf(i)[ci] || {}; ks.push(breakdownSortKey(c.raw, c.text || '')); }
      keyCache.set(ci, ks);
    }
    return keyCache.get(ci);
  };
  const currentOrder = () => sortDir ? breakdownOrder(count, pinStart, i => keysFor(sortCol)[i], sortDir) : breakdownOrder(count, pinStart, null, null);

  if (sortable && pinStart >= 2) {
    thEls.forEach((th, ci) => {
      if (!th || !columns[ci]) return;
      const label = columns[ci].label;
      const b = el('button', {
        type: 'button', class: 'dd-sort',
        title: (columns[ci].tip ? columns[ci].tip + '\n' : '') + 'Sort by ' + label
      });
      while (th.firstChild) b.appendChild(th.firstChild);
      th.appendChild(b);
      th.classList.add('dd-sortable');
      b.onclick = () => {
        if (sortCol !== ci) { sortCol = ci; sortDir = 'asc'; }
        else if (sortDir === 'asc') sortDir = 'desc';
        else { sortCol = -1; sortDir = null; }
        thEls.forEach((h, hi) => {
          if (!h) return;
          if (hi === sortCol) h.setAttribute('aria-sort', sortDir === 'asc' ? 'ascending' : 'descending');
          else h.removeAttribute('aria-sort');
        });
        render(currentOrder());
      };
    });
  }

  const exportRows = () => {
    const order = currentOrder();
    // "= Net" / "+ Long-term": the operator marker is dropped in files — a
    // spreadsheet would read a leading = or + as a formula.
    const plain = v => typeof v === 'string' ? v.replace(/^[=+]\s+/, '') : v;
    const out = [columns.map(c => plain(c.label))];
    const bold = new Set();
    order.forEach((i, pos) => {
      out.push(columns.map((_, ci) => { const c = cellsOf(i)[ci] || {}; return plain(breakdownExportValue(c.raw, c.text || '')); }));
      if (i >= pinStart || flagged(i)) bold.add(pos + 1);
    });
    return { rows: out, bold };
  };
  const onPick = fmt => {
    try {
      const title = (getTitle && getTitle()) || 'breakdown';
      const { rows, bold } = exportRows();
      if (fmt === 'xlsx') {
        downloadBlob(breakdownFilename(title, 'xlsx'), new Blob([buildXlsx(title, rows, bold)],
          { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
      } else {
        downloadCsv(breakdownFilename(title, 'csv'), rows);
      }
    } catch (e) {
      console.warn('Breakdown export failed', e);
      toast('Download failed', 'danger');
    }
  };
  return { menu: mkDownloadMenu(onPick, { compact }), pinStart, exportRows };
}

export const _breakdownInternals = { parseDisplayFigure, breakdownNumber, parseDisplayDate, crc32, zipStore, SUMMARY_LEAD };

export function confirmDialog(message, { title = 'Confirm', okLabel = 'OK', danger = false } = {}) {
  return new Promise(resolve => {
    let resolved = false;
    const settle = val => { if (!resolved) { resolved = true; resolve(val); } };
    const okBtn = el('button', { class: 'btn ' + (danger ? 'danger' : 'primary') }, okLabel);
    const cancelBtn = el('button', { class: 'btn' }, 'Cancel');
    const { close } = openModal({
      title,
      body: el('div', { style: 'white-space:pre-line' }, message),
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

// fmtDate output per input string — tables format the same few hundred dates
// over and over on every re-render. Bounded: dropped wholesale past 5000.
const _fmtDateMemo = new Map();
const FMT_DATE_MEMO_MAX = 5000;

export function fmtDate(dateStr) {
  if (!dateStr) return '';
  // Only strings are memoized (Date objects/numbers go straight through). A
  // non-YYYY-MM-DD string is parsed in local time, so its output depends on
  // the viewer's timezone — which doesn't change within a page load.
  if (typeof dateStr !== 'string') return _fmtDate(dateStr);
  let out = _fmtDateMemo.get(dateStr);
  if (out === undefined) {
    if (_fmtDateMemo.size >= FMT_DATE_MEMO_MAX) _fmtDateMemo.clear();
    out = _fmtDate(dateStr);
    _fmtDateMemo.set(dateStr, out);
  }
  return out;
}

function _fmtDate(dateStr) {
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

// Matches whole-string date-like text (anchored) so a month name only
// counts as a date when it's actually shaped like one — e.g. "Aug 7, 2026"
// (fmtDate's format) or "Aug 26" (monthLabel's format) — and NOT when a
// month name merely appears inside ordinary text such as "May Street
// Villa" or "March 2024 rent" (trailing/leading words break the anchor).
const DATE_LIKE_RE = /^(?:(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s*\d{2,4}|\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?,?\s*\d{2,4}|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{2,4})$/i;

function parseCell(txt) {
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
}

// Sort comparator over parseCell() keys: numbers, dates, text, placeholders
// (placeholders always last, whichever the direction).
function compareCellKeys(ak, bk, sortDir) {
  if (ak.t !== bk.t) {
    if (ak.t === 'e' || bk.t === 'e') return ak.t === 'e' ? 1 : -1;
    return (SORT_TYPE_RANK[ak.t] - SORT_TYPE_RANK[bk.t]) * sortDir;
  }
  if (ak.t === 'e') return 0;
  if (ak.t === 's') return SORT_COLLATOR.compare(ak.v, bk.v) * sortDir;
  return (ak.v - bk.v) * sortDir;
}

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
    keyed.sort((a, b) => compareCellKeys(a.k, b.k, sortDir));
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

// ========== Data-level table paging ==========
// attachSortFilter's semantics for big read-only tables, without building a
// <tr> per record: sort and search run on the row OBJECTS and only the
// visible page (+ "Show more") is turned into DOM. Callers keep totals,
// footers and exports computed from their full `rows` array.
//
//   tableWrap  a .table-wrap holding a <table> with its <thead> (the <tbody>
//              is created/managed here).
//   rows       the row objects, in their initial (pre-sort) order.
//   cells(row) the text of each <td> exactly as rendered (td.textContent),
//              in column order — sort keys come from cells(row)[col].trim()
//              (parsed like attachSortFilter's cell text) and search matches
//              cells(row).join('') lower-cased, i.e. the row's textContent.
//   renderRow(row) builds the row's <tr> (cached per row object).
//   onFilter(matched) optional: called after every sort/search pass with
//              every matching row (all pages), in display order. The
//              tableWrap also gets an 'sf:filter' event whose detail.rows is
//              the same array.
//   initialShown / onShownChange(n) optional: how many matching rows are
//              rendered to start with (default pageSize) and a callback on
//              every change ("Show more", reset to pageSize by a search), so
//              a caller that rebuilds the table (e.g. after an inline edit)
//              can keep the rows the user had already paged in.
// Sorting re-orders the current order stably, like the DOM version (which
// re-appends the rows it finds in the <tbody>), so ties keep the previous
// sort's order. Returns { refresh }.
export function attachDataTable(tableWrap, { rows, cells, renderRow, placeholder = 'Filter rows…', initialCol = -1, initialDir = 1, initialSearch = '', onSortChange = null, onSearchChange = null, onFilter = null, pageSize = 200, initialShown = 0, onShownChange = null } = {}) {
  let sortCol = initialCol, sortDir = initialDir, searchTerm = initialSearch.toLowerCase();
  let shown = initialShown > pageSize ? initialShown : pageSize;
  let order = rows.slice();
  let matched = order;

  const searchWrap = el('div', { style: 'display:flex;justify-content:flex-end;margin-bottom:8px' });
  const searchInput = el('input', { type: 'search', class: 'input', placeholder, value: initialSearch, style: 'max-width:220px;font-size:13px' });
  searchWrap.appendChild(searchInput);
  tableWrap.parentNode.insertBefore(searchWrap, tableWrap);

  const moreBtn = el('button', { class: 'btn sm ghost', type: 'button' });
  const moreWrap = el('div', { class: 'sf-more', style: 'display:none' }, moreBtn);
  tableWrap.parentNode.insertBefore(moreWrap, tableWrap.nextSibling);

  const table = tableWrap.querySelector('table');
  let tbody = table.querySelector('tbody');
  if (!tbody) { tbody = el('tbody'); table.appendChild(tbody); }

  const cellCache = new WeakMap();
  const cellsOf = r => { let c = cellCache.get(r); if (!c) { c = cells(r).map(v => String(v ?? '')); cellCache.set(r, c); } return c; };
  const textCache = new WeakMap();
  const textOf = r => { let t = textCache.get(r); if (t === undefined) { t = cellsOf(r).join('').toLowerCase(); textCache.set(r, t); } return t; };
  const keyCache = new Map(); // col → WeakMap(row → parsed key)
  const keyOf = (r, col) => {
    let m = keyCache.get(col);
    if (!m) { m = new WeakMap(); keyCache.set(col, m); }
    let k = m.get(r);
    if (!k) { k = parseCell((cellsOf(r)[col] ?? '').trim()); m.set(r, k); }
    return k;
  };
  const trCache = new WeakMap();
  const trOf = r => { let tr = trCache.get(r); if (!tr) { tr = renderRow(r); trCache.set(r, tr); } return tr; };

  let rendered = 0;
  const renderUpTo = n => {
    const frag = document.createDocumentFragment();
    const end = Math.min(n, matched.length);
    for (let i = rendered; i < end; i++) frag.appendChild(trOf(matched[i]));
    tbody.appendChild(frag);
    rendered = end;
    const rest = matched.length - rendered;
    moreWrap.style.display = rest > 0 ? '' : 'none';
    if (rest > 0) moreBtn.textContent = `Show ${Math.min(rest, pageSize)} more (${rest} not shown)`;
  };

  const applySort = () => {
    if (sortCol < 0) return;
    const keyed = order.map(r => ({ r, k: keyOf(r, sortCol) }));
    keyed.sort((a, b) => compareCellKeys(a.k, b.k, sortDir));
    order = keyed.map(x => x.r);
  };

  const applyFilter = () => {
    matched = searchTerm ? order.filter(r => textOf(r).includes(searchTerm)) : order;
    tbody.textContent = '';
    rendered = 0;
    renderUpTo(shown);
    onFilter?.(matched);
    tableWrap.dispatchEvent(new CustomEvent('sf:filter', { detail: { rows: matched } }));
  };

  moreBtn.addEventListener('click', () => { shown += pageSize; onShownChange?.(shown); renderUpTo(shown); });

  const ths = [...table.querySelectorAll('thead th')];
  const updateArrows = () => {
    ths.forEach((th, i) => {
      const arr = th.querySelector('.sf-arr');
      if (!arr) return;
      arr.textContent = sortCol === i ? (sortDir > 0 ? ' ▲' : ' ▼') : ' ⇅';
      arr.style.opacity = sortCol === i ? '1' : '0.4';
    });
  };
  ths.forEach((th, i) => {
    if (!th.textContent.trim() || th.dataset.sfOk) return;
    th.dataset.sfOk = '1';
    th.style.cursor = 'pointer';
    th.style.userSelect = 'none';
    th.appendChild(el('span', { class: 'sf-arr', style: 'margin-left:4px;opacity:0.4;font-size:10px' }, ' ⇅'));
    th.addEventListener('click', () => {
      if (sortCol === i) sortDir *= -1; else { sortCol = i; sortDir = 1; }
      onSortChange?.(sortCol, sortDir);
      applySort();
      applyFilter();
      updateArrows();
    });
  });

  let searchTimer;
  searchInput.addEventListener('input', () => {
    searchTerm = searchInput.value.toLowerCase();
    onSearchChange?.(searchInput.value);
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { shown = pageSize; onShownChange?.(shown); applyFilter(); }, 150);
  });

  const refresh = () => { applySort(); applyFilter(); updateArrows(); };
  refresh();
  return { refresh };
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

// Search box for a list page's filter row (cards with no table search of
// their own). onInput gets the trimmed lower-case term, debounced.
export function searchBox({ value = '', placeholder = 'Search…', onInput }) {
  const inp = el('input', { type: 'search', class: 'input', placeholder, value, style: 'max-width:220px;font-size:13px' });
  let t;
  inp.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => onInput(inp.value.trim().toLowerCase()), 150); });
  return inp;
}
// True when every word of `term` appears in one of `fields` (case-insensitive).
export function matchesSearch(term, ...fields) {
  if (!term) return true;
  const hay = fields.filter(v => v !== null && v !== undefined).join(' ').toLowerCase();
  return term.split(/\s+/).every(w => hay.includes(w));
}

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

  // Search box: narrows the visible rows by label as you type ("All" then
  // acts on the visible rows only).
  const msSearch = el('input', { type: 'search', class: 'input', placeholder: 'Search…', style: 'width:100%;font-size:12px;padding:4px 8px' });
  const searchRow = el('div', { style: 'padding:4px 8px 6px;position:sticky;top:-4px;background:var(--bg-elev-2);z-index:1' }, msSearch);
  menu.appendChild(searchRow);
  const allChk = el('input', { type: 'checkbox' });
  menu.appendChild(el('label', {
    style: 'display:flex;align-items:center;gap:8px;padding:6px 12px;cursor:pointer;border-bottom:1px solid var(--border);font-size:13px'
  }, allChk, el('span', {}, allLabel)));
  const MS_FIXED_ROWS = 2; // search + "All"
  const rowOf = chk => chk.closest('label');
  const visibleChks = () => chks.filter(c => rowOf(c)?.style.display !== 'none');
  const applySearch = () => {
    const q = msSearch.value.trim().toLowerCase();
    chks.forEach((c, i) => { const row = rowOf(c); if (row) row.style.display = !q || String(items[i]?.label ?? '').toLowerCase().includes(q) ? 'flex' : 'none'; });
  };
  msSearch.addEventListener('input', applySearch);
  msSearch.addEventListener('keydown', e => { if (e.key === 'Escape') { msSearch.value = ''; applySearch(); } });

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
    while (menu.children.length > MS_FIXED_ROWS) menu.removeChild(menu.lastChild);
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
    applySearch();
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
  allChk.onchange = () => {
    // With a search active, "All" checks / unchecks just the matching rows.
    const target = msSearch.value.trim() ? visibleChks() : chks;
    target.forEach(c => { c.checked = allChk.checked; });
    allChk.indeterminate = false;
    sync();
  };
  trigger.onclick = e => {
    e.stopPropagation();
    if (menu.style.display === 'none') {
      menu.style.display = ''; menu.classList.add('open');
      msSearch.value = ''; applySearch();
      // Focus the search box only where there is something to search.
      // Not on touch screens: the keyboard would cover the list.
      if (chks.length > 6 && !globalThis.matchMedia?.('(pointer: coarse)').matches) msSearch.focus();
    }
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
