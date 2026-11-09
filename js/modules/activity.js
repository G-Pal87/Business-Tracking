// Activity Log: who changed what and when, across every record (route
// 'activity'), plus the per-record "History" popup the edit forms open
// (historyButton / openRecordHistory). Entries are written centrally by
// core/data.js (upsert / softDelete / restore) into state.db.activityLog.
import { state, subscribe } from '../core/state.js';
import { el, button, input, select, fmtDate, toast } from '../core/ui.js';
import { activityEntries, byId, formatMoney } from '../core/data.js';
import { navigate } from '../core/router.js';

const PAGE = 100;

// collection → [singular noun, plural noun, route, opener]
const COLL = {
  payments:          ['Payment', 'payments', 'payments', async (id) => { const m = await import('./payments.js'); m.openPaymentForm(byId('payments', id)); }],
  expenses:          ['Expense', 'expenses', 'expenses', async (id) => { const m = await import('./expenses.js'); m.openExpenseForm(id); }],
  properties:        ['Property', 'properties', 'properties', async (id) => { const m = await import('./properties.js'); m.openDetail(id); }],
  tenants:           ['Tenant', 'tenants', 'tenants'],
  invoices:          ['Invoice', 'invoices', 'invoices', async (id) => { const m = await import('./invoices.js'); m.openBuilder(byId('invoices', id)); }],
  clients:           ['Client', 'clients', 'clients', async (id) => { const m = await import('./clients.js'); m.openDetail(id); }],
  vendors:           ['Vendor', 'vendors', 'vendors'],
  inventory:         ['Inventory item', 'inventory items', 'inventory'],
  dividends:         ['Dividend', 'dividends', 'dividends'],
  electricityCycles: ['Electricity cycle', 'electricity cycles', 'electricity'],
  timeOff:           ['Time off', 'time-off entries', 'time-off'],
  forecasts:         ['Forecast', 'forecasts', 'forecast'],
  people:            ['Person', 'people', 'company-structure'],
  services:          ['Service', 'services', 'clients'],
  users:             ['User', 'users', 'users'],
  strCalendars:      ['Calendar', 'calendars', 'str-rates'],
  strRateTargets:    ['Rate target', 'rate targets', 'str-rates'],
  reservationExpenseRules: ['Expense rule', 'expense rules', 'expenses']
};
const VERB = { create: 'added', update: 'edited', delete: 'deleted', restore: 'restored' };
const MONEY_FIELDS = new Set(['amount', 'total', 'subtotal', 'vat', 'vatAmount', 'monthlyRent', 'rent', 'deposit', 'depositAmount',
  'price', 'purchasePrice', 'marketValue', 'invoiceAmount', 'cleaningFee', 'fee', 'fees', 'value', 'netAmount', 'grossAmount', 'hostFee', 'serviceFee']);
const REF_FIELDS = {
  propertyId: 'properties', tenantId: 'tenants', vendorId: 'vendors', collectedByVendorId: 'vendors', clientId: 'clients',
  personId: 'people', serviceId: 'services', inventoryItemId: 'inventory', linkedExpenseId: 'expenses', linkedPaymentId: 'payments'
};
const FIELD_LABEL = { propertyId: 'property', tenantId: 'tenant', vendorId: 'vendor', collectedByVendorId: 'collected by', clientId: 'client',
  personId: 'person', serviceId: 'service', inventoryItemId: 'inventory item', linkedExpenseId: 'linked expense', linkedPaymentId: 'linked payment' };

const nounOf = c => COLL[c]?.[0] || humanize(c);
const pluralOf = c => COLL[c]?.[1] || humanize(c);

function humanize(key) {
  return String(key || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').toLowerCase().trim();
}
export function fieldLabel(field) { return FIELD_LABEL[field] || humanize(field); }

export function formatChangeValue(field, v, cur) {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'number') return MONEY_FIELDS.has(field) ? formatMoney(v, cur || 'EUR', { minFrac: 0 }) : String(v);
  const s = String(v);
  if (REF_FIELDS[field]) {
    const r = byId(REF_FIELDS[field], s);
    if (r) return String(r.name || r.title || r.description || s);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return fmtDate(s);
  return s;
}

function changeText(c, cur) {
  if (c.hidden) return `${fieldLabel(c.field)} changed`;
  return `${fieldLabel(c.field)} ${formatChangeValue(c.field, c.from, cur)} → ${formatChangeValue(c.field, c.to, cur)}`;
}

// "Anna edited Payment 12 Mar · €900: amount €850 → €900 (+2 more)" — the
// one-line summary (plain text; the list renders the same parts as nodes).
export function entrySentence(e) {
  const verb = VERB[e.action] || e.action;
  let s = `${e.by || 'someone'} ${verb} ${needsNoun(e) ? nounOf(e.collection) + ' ' : ''}${e.label || e.recordId}`;
  if (e.action === 'update') s += summaryTail(e);
  return s;
}
function summaryTail(e) {
  const ch = e.changes || [];
  if (!ch.length) return '';
  const first = changeText(ch[0], e.cur);
  return `: ${first}${ch.length > 1 ? ` (+${ch.length - 1} more)` : ''}`;
}
// Label already starts with the noun ("Payment 12 Mar…") → don't repeat it.
function needsNoun(e) {
  const noun = nounOf(e.collection).toLowerCase();
  return !String(e.label || '').toLowerCase().startsWith(noun.split(' ')[0]);
}

function localDay(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function timeOf(iso) {
  const d = new Date(iso);
  return isNaN(d) ? '' : d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}
function dayHeading(day) {
  const t = localDay(new Date().toISOString());
  const y = localDay(new Date(Date.now() - 864e5).toISOString());
  if (day === t) return 'Today';
  if (day === y) return 'Yesterday';
  const d = new Date(`${day}T12:00:00`);
  return isNaN(d) ? day : d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}
function fullStamp(iso) {
  const d = new Date(iso);
  return isNaN(d) ? '' : d.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}

function visibleEntries(filter = {}) {
  const isAdmin = state.session?.role === 'admin';
  return activityEntries(filter).filter(e => isAdmin || e.collection !== 'users');
}

function recordIsActive(collection, id) {
  const r = byId(collection, id);
  return !!r && !r.deletedAt;
}

// Navigate to the record's page and open it there when that page can.
export function openRecord(collection, id) {
  const meta = COLL[collection];
  if (!meta) return;
  const active = recordIsActive(collection, id);
  if (!byId(collection, id)) toast('This record no longer exists', 'warning');
  else if (!active) toast('This record is deleted — restore it from Settings → Data (Trash)', 'info', 4000);
  navigate(meta[2]);
  if (active && meta[3]) {
    // The router closes any modal while it swaps the view: open afterwards.
    setTimeout(() => { meta[3](id).catch(err => console.warn('[activity] open record failed', err)); }, 450);
  }
}

// ── One entry ────────────────────────────────────────────────────────────────
function changesTable(e) {
  const t = el('div', { class: 'act-changes' });
  for (const c of e.changes || []) {
    t.appendChild(el('div', { class: 'act-change' },
      el('span', { class: 'act-field' }, fieldLabel(c.field)),
      c.hidden
        ? el('span', { class: 'act-vals' }, el('span', { class: 'act-muted' }, 'changed (value hidden)'))
        : el('span', { class: 'act-vals' },
            el('span', { class: 'act-from' }, formatChangeValue(c.field, c.from, e.cur)),
            el('span', { class: 'act-arrow' }, ' → '),
            el('span', { class: 'act-to' }, formatChangeValue(c.field, c.to, e.cur)))
    ));
  }
  return t;
}

function entryRow(e, { showLink = true, showBy = true, showDate = false } = {}) {
  const row = el('div', { class: `act-entry act-${e.action}` });
  const hasDetail = (e.changes || []).length > 0;
  const verb = VERB[e.action] || e.action;
  const labelText = `${needsNoun(e) ? nounOf(e.collection) + ' ' : ''}${e.label || e.recordId}`;
  const canOpen = showLink && COLL[e.collection] && byId(e.collection, e.recordId);
  const labelNode = canOpen
    ? el('a', { href: `#${COLL[e.collection][2]}`, class: 'act-link', onClick: ev => { ev.preventDefault(); ev.stopPropagation(); openRecord(e.collection, e.recordId); } }, labelText)
    : el('span', { class: 'act-label' }, labelText);
  const line = el('div', { class: 'act-line' },
    showBy ? el('strong', { class: 'act-by' }, e.by || 'someone') : null,
    showBy ? ' ' : null,
    el('span', { class: 'act-verb' }, verb), ' ', labelNode,
    e.action === 'update' && hasDetail ? el('span', { class: 'act-summary' }, summaryTail(e)) : null,
    e.action === 'update' && !hasDetail ? el('span', { class: 'act-muted' }, ' (details not recorded)') : null
  );
  const when = el('time', { class: 'act-time', datetime: e.at, title: fullStamp(e.at) }, showDate ? fullStamp(e.at) : timeOf(e.at));
  const badge = el('span', { class: `act-badge act-badge-${e.action}`, title: verb }, verb);
  const head = el('div', { class: 'act-head' }, badge, line, when);
  row.appendChild(head);
  if (hasDetail && (e.changes.length > 1 || String(summaryTail(e)).length > 70)) {
    const toggle = el('button', { class: 'act-toggle', type: 'button', 'aria-expanded': 'false', title: 'Show all changes' }, `${e.changes.length} change${e.changes.length === 1 ? '' : 's'} ▾`);
    let detail = null;
    toggle.onclick = ev => {
      ev.stopPropagation();
      const open = toggle.getAttribute('aria-expanded') !== 'true';
      toggle.setAttribute('aria-expanded', String(open));
      toggle.textContent = `${e.changes.length} change${e.changes.length === 1 ? '' : 's'} ${open ? '▴' : '▾'}`;
      if (open) { detail = changesTable(e); row.appendChild(detail); }
      else { detail?.remove(); detail = null; }
      row.classList.toggle('open', open);
    };
    head.appendChild(toggle);
  }
  return row;
}

// Consecutive entries by the same person, same action and collection within a
// few seconds (a CSV import, a bulk delete) collapse into one expandable row.
function groupRuns(list) {
  const out = [];
  for (const e of list) {
    const last = out[out.length - 1];
    const t = Date.parse(e.at) || 0;
    if (last && last.by === e.by && last.action === e.action && last.collection === e.collection && Math.abs(last.tLast - t) <= 3000) {
      last.items.push(e); last.tLast = t;
    } else out.push({ by: e.by, action: e.action, collection: e.collection, tLast: t, items: [e] });
  }
  return out;
}

function groupRow(g, opts) {
  const n = g.items.length;
  const verb = VERB[g.action] || g.action;
  const box = el('div', { class: `act-entry act-group act-${g.action}` });
  const toggle = el('button', { class: 'act-toggle', type: 'button', 'aria-expanded': 'false' }, `Show ${n} ▾`);
  const head = el('div', { class: 'act-head' },
    el('span', { class: `act-badge act-badge-${g.action}` }, verb),
    el('div', { class: 'act-line' }, el('strong', { class: 'act-by' }, g.by || 'someone'), ' ', el('span', { class: 'act-verb' }, verb), ' ',
      el('span', { class: 'act-label' }, `${n} ${pluralOf(g.collection)}`)),
    el('time', { class: 'act-time', datetime: g.items[0].at, title: fullStamp(g.items[0].at) }, timeOf(g.items[0].at)),
    toggle);
  box.appendChild(head);
  let inner = null;
  toggle.onclick = () => {
    const open = toggle.getAttribute('aria-expanded') !== 'true';
    toggle.setAttribute('aria-expanded', String(open));
    toggle.textContent = open ? 'Hide ▴' : `Show ${n} ▾`;
    if (open) {
      inner = el('div', { class: 'act-group-items' });
      g.items.slice(0, 500).forEach(e => inner.appendChild(entryRow(e, { ...opts, showBy: false })));
      if (n > 500) inner.appendChild(el('div', { class: 'act-muted act-pad' }, `…and ${n - 500} more`));
      box.appendChild(inner);
    } else { inner?.remove(); inner = null; }
  };
  return box;
}

// ── Per-record History popup (opened from inside an edit modal) ─────────────
// Its own small layer above the modal overlay: ui.openModal() keeps one modal
// at a time, and replacing the edit form would throw away unsaved input.
let _pop = null;
// Never outlives the form it was opened from, nor the page.
subscribe(evt => { if (evt === 'route-change') closeHistory(); });
if (typeof document !== 'undefined' && document.addEventListener) document.addEventListener('bt:modal-closed', () => closeHistory());
function closeHistory() {
  if (!_pop) return;
  window.removeEventListener('keydown', _pop.onKey, true);
  _pop.node.remove();
  _pop = null;
}

export function openRecordHistory(collection, recordId, title) {
  closeHistory();
  const entries = visibleEntries({ collection, recordId });
  const rec = byId(collection, recordId);
  const panel = el('div', { class: 'act-pop', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Change history' });
  const closeBtn = el('button', { class: 'modal-close', type: 'button', title: 'Close' }, '×');
  closeBtn.onclick = closeHistory;
  panel.appendChild(el('div', { class: 'act-pop-head' },
    el('div', {},
      el('div', { class: 'act-pop-title' }, 'History'),
      el('div', { class: 'act-pop-sub' }, title || (entries[0]?.label) || (rec ? `${nounOf(collection)} ${rec.name || ''}` : nounOf(collection)))),
    closeBtn));
  const body = el('div', { class: 'act-pop-body' });
  if (!entries.length) {
    body.appendChild(el('div', { class: 'act-empty' }, 'No changes recorded for this record yet.',
      el('div', { class: 'act-muted' }, rec?.createdAt ? `Created ${fullStamp(new Date(rec.createdAt).toISOString())}${rec.createdBy ? ' by ' + rec.createdBy : ''} — before change history was switched on.` : '')));
  } else {
    for (const e of entries) body.appendChild(entryRow(e, { showLink: false, showDate: true }));
  }
  panel.appendChild(body);
  const overlay = el('div', { class: 'act-pop-overlay' }, panel);
  overlay.addEventListener('mousedown', ev => { if (ev.target === overlay) overlay._down = true; });
  overlay.addEventListener('click', ev => { if (ev.target === overlay && overlay._down) closeHistory(); overlay._down = false; });
  // Capture phase on window: Escape closes only this popup, never the edit
  // form underneath (whose own Escape handler sits on document).
  const onKey = ev => { if (ev.key === 'Escape') { ev.stopPropagation(); ev.preventDefault(); closeHistory(); } };
  window.addEventListener('keydown', onKey, true);
  document.body.appendChild(overlay);
  _pop = { node: overlay, onKey };
  closeBtn.focus();
}

// A "History" button for an edit form's footer, or null for a new record.
// `record` may be the record object or its id.
export function historyButton(collection, record) {
  const id = typeof record === 'string' ? record : record?.id;
  if (!id) return null;
  const n = visibleEntries({ collection, recordId: id }).length;
  const b = button(n ? `History (${n})` : 'History', { variant: 'ghost act-hist-btn' });
  b.title = 'Who changed this record, what and when';
  b.onclick = ev => { ev.preventDefault(); openRecordHistory(collection, id); };
  return b;
}

// ── Activity Log page ────────────────────────────────────────────────────────
const _f = { collection: '', by: '', from: '', to: '', q: '' };
let _shown = PAGE;
let _filtersOpen = false;
let _container = null;
let _unsub = null;

function matches(e, f, q) {
  if (f.collection && e.collection !== f.collection) return false;
  if (f.by && e.by !== f.by) return false;
  if (f.from || f.to) {
    const d = localDay(e.at);
    if (f.from && d < f.from) return false;
    if (f.to && d > f.to) return false;
  }
  if (q) {
    const hay = [e.by, e.label, nounOf(e.collection), VERB[e.action], e.recordId,
      ...(e.changes || []).flatMap(c => [fieldLabel(c.field), c.hidden ? '' : formatChangeValue(c.field, c.from, e.cur), c.hidden ? '' : formatChangeValue(c.field, c.to, e.cur)])
    ].join(' ').toLowerCase();
    if (!q.split(/\s+/).every(w => hay.includes(w))) return false;
  }
  return true;
}

function build() {
  const wrap = el('div', { class: 'view active act-view' });
  const all = visibleEntries();
  const people = [...new Set(all.map(e => e.by).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const colls = [...new Set(all.map(e => e.collection))].sort((a, b) => nounOf(a).localeCompare(nounOf(b)));

  const listCard = el('div', { class: 'act-list' });
  const countEl = el('span', { class: 'act-count' });

  const collS = select([{ value: '', label: 'All records' }, ...colls.map(c => ({ value: c, label: humanize(pluralOf(c)).replace(/^./, m => m.toUpperCase()) }))], _f.collection, { 'aria-label': 'Record type' });
  const byS = select([{ value: '', label: 'Everyone' }, ...people.map(p => ({ value: p, label: p }))], _f.by, { 'aria-label': 'Person' });
  const fromI = input({ type: 'date', value: _f.from, 'aria-label': 'From date', title: 'From' });
  const toI = input({ type: 'date', value: _f.to, 'aria-label': 'To date', title: 'To' });
  const qI = input({ type: 'search', value: _f.q, placeholder: 'Search changes…', 'aria-label': 'Search' });
  const clearBtn = button('Clear', { variant: 'sm ghost' });

  const filters = el('div', { class: 'act-filters' + (_filtersOpen ? ' open' : '') },
    el('label', { class: 'act-fl' }, el('span', {}, 'Record'), collS),
    el('label', { class: 'act-fl' }, el('span', {}, 'Person'), byS),
    el('label', { class: 'act-fl' }, el('span', {}, 'From'), fromI),
    el('label', { class: 'act-fl' }, el('span', {}, 'To'), toI),
    el('label', { class: 'act-fl act-fl-q' }, el('span', {}, 'Search'), qI),
    el('div', { class: 'act-fl act-fl-btn' }, clearBtn));
  const activeCount = () => ['collection', 'by', 'from', 'to', 'q'].filter(k => _f[k]).length;
  const filterToggle = button('Filters', { variant: 'sm act-filter-toggle' });
  const syncToggle = () => {
    const n = activeCount();
    filterToggle.textContent = n ? `Filters (${n})` : 'Filters';
    filterToggle.setAttribute('aria-expanded', String(_filtersOpen));
  };
  filterToggle.onclick = () => { _filtersOpen = !_filtersOpen; filters.classList.toggle('open', _filtersOpen); syncToggle(); };

  wrap.appendChild(el('div', { class: 'act-top' },
    el('div', { class: 'act-intro' }, 'Every add, edit, delete and restore — who did it and when. ', countEl),
    filterToggle));
  wrap.appendChild(filters);
  wrap.appendChild(listCard);

  const render = () => {
    const q = _f.q.trim().toLowerCase();
    const rows = all.filter(e => matches(e, _f, q));
    countEl.textContent = rows.length === all.length ? `${all.length} entr${all.length === 1 ? 'y' : 'ies'}` : `${rows.length} of ${all.length} entries`;
    syncToggle();
    listCard.innerHTML = '';
    if (!all.length) {
      listCard.appendChild(el('div', { class: 'empty' }, el('div', { class: 'empty-icon' }, '🕘'),
        'No changes recorded yet. Edits made from now on will appear here.'));
      return;
    }
    if (!rows.length) { listCard.appendChild(el('div', { class: 'empty' }, 'No entries match these filters.')); return; }
    // Group first, then page by groups: a 300-row import stays one row.
    const groups = groupRuns(rows);
    const rowsOf = g => (g.items.length >= 3 ? 1 : g.items.length); // a grouped run renders as one row
    let n = 0, shownGroups = 0;
    while (shownGroups < groups.length && n < _shown) n += rowsOf(groups[shownGroups++]);
    const page = groups.slice(0, shownGroups);
    const remaining = groups.slice(shownGroups).reduce((s, g) => s + g.items.length, 0);
    let day = null, dayBox = null;
    for (const g of page) {
      const d = localDay(g.items[0].at);
      if (d !== day) {
        day = d;
        dayBox = el('div', { class: 'act-day' }, el('div', { class: 'act-day-head' }, dayHeading(d)));
        listCard.appendChild(dayBox);
      }
      dayBox.appendChild(g.items.length >= 3 ? groupRow(g, {}) : el('div', { class: 'act-run' }, ...g.items.map(e => entryRow(e))));
    }
    if (remaining > 0) {
      listCard.appendChild(el('div', { class: 'act-more' },
        button(`Show more (${remaining} older)`, { onClick: () => { _shown += PAGE * 2; render(); } })));
    }
  };

  const set = (k, v) => { _f[k] = v; _shown = PAGE; render(); };
  collS.onchange = () => set('collection', collS.value);
  byS.onchange = () => set('by', byS.value);
  fromI.onchange = () => set('from', fromI.value);
  toI.onchange = () => set('to', toI.value);
  let qt = null;
  qI.oninput = () => { clearTimeout(qt); qt = setTimeout(() => set('q', qI.value), 150); };
  clearBtn.onclick = () => {
    Object.assign(_f, { collection: '', by: '', from: '', to: '', q: '' });
    collS.value = ''; byS.value = ''; fromI.value = ''; toI.value = ''; qI.value = '';
    _shown = PAGE; render();
  };
  render();
  return wrap;
}

function rerender() {
  if (!_container || !_container.isConnected) return;
  _container.innerHTML = '';
  _container.appendChild(build());
}

export default {
  id: 'activity',
  label: 'Activity Log',
  icon: '🕘',
  render(container) {
    _container = container;
    _shown = PAGE;
    container.appendChild(build());
    // Local edits don't announce 'data-loaded'; refresh on the batched
    // 'dirty' signal too, unless the user is typing in the filters.
    _unsub?.();
    let t = null;
    _unsub = subscribe(evt => {
      if (evt !== 'dirty') return;
      clearTimeout(t);
      t = setTimeout(() => { if (!_container?.contains(document.activeElement)) rerender(); }, 300);
    });
  },
  refresh() { rerender(); },
  destroy() { _unsub?.(); _unsub = null; _container = null; closeHistory(); }
};

