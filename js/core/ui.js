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

  const close = () => {
    overlay.classList.remove('open');
    setTimeout(() => { overlay.innerHTML = ''; if (onClose) onClose(); }, 200);
  };
  closeBtn.onclick = close;
  overlay.onclick = e => { if (e.target === overlay) close(); };
  document.addEventListener('keydown', escHandler);
  function escHandler(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', escHandler); }
  }
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
  for (const row of rows) {
    const tr = el('tr');
    for (const col of columns) {
      const raw = row[col.key];
      const display = col.format ? col.format(raw, row) : (raw ?? '—');
      const cell = el('td', { class: col.right ? 'right num' : '' });
      if (display instanceof Node) cell.appendChild(display);
      else cell.appendChild(document.createTextNode(String(display ?? '—')));
      tr.appendChild(cell);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  const tw = el('div', { class: 'table-wrap' });
  tw.appendChild(table);
  const meta = el('div', { style: 'font-size:12px;color:var(--text-muted);margin-bottom:12px' },
    `${rows.length} record${rows.length !== 1 ? 's' : ''}`);
  const body = el('div');
  body.appendChild(meta);
  body.appendChild(tw);
  openModal({ title, body, large: true });
}

export function confirmDialog(message, { title = 'Confirm', okLabel = 'OK', danger = false } = {}) {
  return new Promise(resolve => {
    const okBtn = el('button', { class: 'btn ' + (danger ? 'danger' : 'primary') }, okLabel);
    const cancelBtn = el('button', { class: 'btn' }, 'Cancel');
    const { close } = openModal({
      title,
      body: el('div', {}, message),
      footer: [cancelBtn, okBtn]
    });
    okBtn.onclick = () => { close(); resolve(true); };
    cancelBtn.onclick = () => { close(); resolve(false); };
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
