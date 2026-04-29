// Executive Analytics Dashboard
import { el, select, fmtDate, drillDownModal, attachSortFilter } from '../core/ui.js';
import * as charts from '../core/charts.js';
import { STREAMS, OWNERS } from '../core/config.js';
import {
  availableYears, formatEUR, toEUR, byId,
  listActive, listActivePayments, listActiveClients,
  isCapEx, drillRevRows, drillExpRows
} from '../core/data.js';

// ── Module-local filter state ────────────────────────────────────────────────
let gFilters = {
  year:        String(new Date().getFullYear()),
  months:      new Set(),   // empty = all
  streams:     new Set(),   // empty = all
  owners:      new Set(),   // empty = all
  propertyIds: new Set(),   // empty = all
  clientIds:   new Set()    // empty = all
};

const MONTH_LABELS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const CHART_IDS    = ['exec-bar', 'exec-donut', 'exec-hbar'];

// ── Module definition ────────────────────────────────────────────────────────
export default {
  id:    'analytics',
  label: 'Executive',
  icon:  'A',
  render(container) { container.appendChild(buildView()); },
  refresh() { rebuildView(); },
  destroy() { CHART_IDS.forEach(id => charts.destroy(id)); }
};

// ── Filter helpers ───────────────────────────────────────────────────────────
function matchDate(row) {
  const d = row.date || row.issueDate || '';
  if (gFilters.year && gFilters.year !== 'all' && !d.startsWith(gFilters.year)) return false;
  if (gFilters.months.size > 0 && !gFilters.months.has(d.slice(5, 7))) return false;
  return true;
}
function matchStream(row) {
  return gFilters.streams.size === 0 || !row.stream || gFilters.streams.has(row.stream);
}
function matchOwner(row) {
  if (gFilters.owners.size === 0) return true;
  if (!row.propertyId) return true;
  const owner = byId('properties', row.propertyId)?.owner || 'both';
  return owner === 'both' || gFilters.owners.has(owner);
}
function matchProperty(row) {
  return gFilters.propertyIds.size === 0 || !row.propertyId || gFilters.propertyIds.has(row.propertyId);
}
function matchClient(row) {
  return gFilters.clientIds.size === 0 || !row.clientId || gFilters.clientIds.has(row.clientId);
}

function getData() {
  const payments = listActivePayments().filter(p =>
    p.status === 'paid' && matchDate(p) && matchStream(p) && matchOwner(p) && matchProperty(p)
  );
  const invoices = listActive('invoices').filter(i =>
    i.status === 'paid' &&
    matchDate({ date: i.issueDate }) &&
    matchStream(i) &&
    matchClient(i)
  );
  const opExpenses = listActive('expenses').filter(e =>
    !isCapEx(e) && matchDate(e) && matchStream(e) && matchOwner(e) && matchProperty(e)
  );
  const renoExpenses = listActive('expenses').filter(e =>
    isCapEx(e) && matchDate(e) && matchOwner(e) && matchProperty(e)
  );
  const rev  = payments.reduce((s, p) => s + toEUR(p.amount, p.currency, p.date), 0)
             + invoices.reduce((s, i) => s + toEUR(i.total,  i.currency, i.issueDate), 0);
  const exp  = opExpenses.reduce((s, e) => s + toEUR(e.amount, e.currency, e.date), 0);
  const reno = renoExpenses.reduce((s, e) => s + toEUR(e.amount, e.currency, e.date), 0);
  return { payments, invoices, opExpenses, renoExpenses, rev, exp, reno, net: rev - exp };
}

// ── Rebuild helper (used by filter callbacks) ─────────────────────────────────
function rebuildView() {
  CHART_IDS.forEach(id => charts.destroy(id));
  const c = document.getElementById('content');
  if (!c) return;
  c.innerHTML = '';
  c.appendChild(buildView());
}

// ── Multi-select dropdown ────────────────────────────────────────────────────
// items: [{ value, label, css? }]
// filterSet: the Set in gFilters to mutate
function buildMultiSelect(items, filterSet, allLabel, onRefresh) {
  const wrapper = el('div', { style: 'position:relative' });

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

  const chks = items.map(({ value, label, css }) => {
    const chk     = el('input', { type: 'checkbox' });
    chk.dataset.value = value;
    chk.checked   = filterSet.size === 0 || filterSet.has(value);
    const content = css ? el('span', { class: `badge ${css}` }, label) : el('span', {}, label);
    menu.appendChild(el('label', {
      style: 'display:flex;align-items:center;gap:8px;padding:6px 12px;cursor:pointer;font-size:13px'
    }, chk, content));
    return chk;
  });

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

  allChk.checked = filterSet.size === 0;
  allChk.onchange = () => {
    chks.forEach(c => { c.checked = allChk.checked; });
    allChk.indeterminate = false;
    sync();
    onRefresh();
  };
  chks.forEach(chk => { chk.onchange = () => { sync(); onRefresh(); }; });

  trigger.onclick = e => {
    e.stopPropagation();
    menu.style.display = menu.style.display === 'none' ? '' : 'none';
  };
  menu.onclick = e => e.stopPropagation();
  document.addEventListener('click', () => { menu.style.display = 'none'; });

  wrapper.appendChild(trigger);
  wrapper.appendChild(menu);
  sync();
  return wrapper;
}

// ── KPI card (matches reports.js .kpi pattern, adds hover ring) ───────────────
function kpiCard(label, value, variant, onClick) {
  const card = el('div', {
    class: 'kpi' + (variant ? ' ' + variant : ''),
    style: 'cursor:pointer;transition:box-shadow 120ms',
    title: 'Click for breakdown'
  });
  card.addEventListener('mouseenter', () => { card.style.boxShadow = '0 0 0 2px var(--accent)'; });
  card.addEventListener('mouseleave', () => { card.style.boxShadow = ''; });
  card.onclick = onClick;
  card.appendChild(el('div', { class: 'kpi-label' }, label));
  card.appendChild(el('div', { class: 'kpi-value' }, value));
  card.appendChild(el('div', { class: 'kpi-accent-bar' }));
  return card;
}

// ── Drill-down column sets ────────────────────────────────────────────────────
const REV_COLS = [
  { key: 'date',   label: 'Date',   format: v => fmtDate(v) },
  { key: 'type',   label: 'Type'   },
  { key: 'source', label: 'Entity' },
  { key: 'ref',    label: 'Ref'    },
  { key: 'eur',    label: 'EUR',    right: true, format: v => formatEUR(v) }
];
const EXP_COLS = [
  { key: 'date',        label: 'Date',        format: v => fmtDate(v) },
  { key: 'source',      label: 'Property'     },
  { key: 'category',    label: 'Category'     },
  { key: 'description', label: 'Description'  },
  { key: 'eur',         label: 'EUR',          right: true, format: v => formatEUR(v) }
];
const MIXED_COLS = [
  { key: 'date',   label: 'Date',   format: v => fmtDate(v) },
  { key: 'kind',   label: 'Kind'   },
  { key: 'source', label: 'Entity / Source' },
  { key: 'eur',    label: 'EUR',    right: true, format: v => formatEUR(v) }
];

function mixedRows(revPays, revInvs, expItems) {
  return [
    ...drillRevRows(revPays, revInvs).map(r => ({
      date: r.date, kind: 'Revenue',
      source: r.source + (r.ref ? ' · ' + r.ref : ''), eur: r.eur
    })),
    ...drillExpRows(expItems).map(r => ({
      date: r.date, kind: 'Expense',
      source: (r.source ? r.source + ' · ' : '') + r.category, eur: r.eur
    }))
  ].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

// ── Main view builder ─────────────────────────────────────────────────────────
function buildView() {
  const wrap = el('div', { class: 'view active' });

  // Page header
  wrap.appendChild(el('div', { style: 'margin-bottom:16px' },
    el('h2', { style: 'margin:0 0 4px;font-size:20px;font-weight:700' }, 'Executive Analytics'),
    el('p',  { style: 'margin:0;font-size:13px;color:var(--text-muted)' },
      'Consolidated overview — revenue, expenses and cash flow')
  ));

  // Filter bar
  const years  = availableYears();
  const yearSel = select(
    [{ value: 'all', label: 'All Years' }, ...years.map(y => ({ value: y, label: y }))],
    gFilters.year
  );
  yearSel.onchange = () => { gFilters.year = yearSel.value; rebuildView(); };

  const filterBar = el('div', {
    class: 'flex gap-8 mb-16',
    style: 'flex-wrap:wrap;align-items:center'
  });
  filterBar.appendChild(
    el('span', { style: 'font-size:12px;color:var(--text-muted);align-self:center' }, 'Filters:')
  );
  filterBar.appendChild(yearSel);
  filterBar.appendChild(buildMultiSelect(
    MONTH_LABELS.map((m, i) => ({ value: String(i + 1).padStart(2, '0'), label: m })),
    gFilters.months, 'All Months', rebuildView
  ));
  filterBar.appendChild(buildMultiSelect(
    Object.entries(STREAMS).map(([k, v]) => ({ value: k, label: v.label, css: v.css })),
    gFilters.streams, 'All Streams', rebuildView
  ));
  filterBar.appendChild(buildMultiSelect(
    Object.entries(OWNERS).map(([k, v]) => ({ value: k, label: v })),
    gFilters.owners, 'All Owners', rebuildView
  ));
  filterBar.appendChild(buildMultiSelect(
    listActive('properties').map(p => ({ value: p.id, label: p.name })),
    gFilters.propertyIds, 'All Properties', rebuildView
  ));
  filterBar.appendChild(buildMultiSelect(
    listActiveClients().map(c => ({ value: c.id, label: c.name })),
    gFilters.clientIds, 'All Clients', rebuildView
  ));
  wrap.appendChild(filterBar);

  // Data
  const data = getData();
  const { payments, invoices, opExpenses, renoExpenses, rev, exp, reno, net } = data;
  const netCash = net - reno;

  // ── KPI row (5 cards) ──────────────────────────────────────────────────────
  const kpiRow = el('div', { class: 'grid grid-4 mb-16', style: 'grid-template-columns:repeat(5,1fr)' });

  kpiRow.appendChild(kpiCard(
    'Revenue', formatEUR(rev),
    rev >= 0 ? '' : 'danger',
    () => drillDownModal('Revenue Breakdown', drillRevRows(payments, invoices), REV_COLS)
  ));
  kpiRow.appendChild(kpiCard(
    'Operating Expenses', formatEUR(exp),
    '',
    () => drillDownModal('Operating Expenses', drillExpRows(opExpenses), EXP_COLS)
  ));
  kpiRow.appendChild(kpiCard(
    'Operating Profit', formatEUR(net),
    net >= 0 ? 'success' : 'danger',
    () => drillDownModal(
      'Operating Profit Breakdown',
      mixedRows(payments, invoices, opExpenses),
      MIXED_COLS
    )
  ));
  kpiRow.appendChild(kpiCard(
    'Renovation CapEx', formatEUR(reno),
    'warning',
    () => drillDownModal('Renovation CapEx', drillExpRows(renoExpenses), EXP_COLS)
  ));
  kpiRow.appendChild(kpiCard(
    'Net Cash Flow', formatEUR(netCash),
    netCash >= 0 ? 'success' : 'danger',
    () => drillDownModal(
      'Net Cash Flow Breakdown',
      mixedRows(payments, invoices, [...opExpenses, ...renoExpenses]),
      MIXED_COLS
    )
  ));
  wrap.appendChild(kpiRow);

  // ── Charts row 1: Grouped bar (2/3) + Donut (1/3) ─────────────────────────
  const chartsRow1 = el('div', {
    style: 'display:grid;grid-template-columns:2fr 1fr;gap:16px;margin-bottom:16px'
  });

  chartsRow1.appendChild(
    el('div', { class: 'card' },
      el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'Monthly Overview (Revenue / OpEx / CapEx)')),
      el('div', { class: 'chart-wrap tall' }, el('canvas', { id: 'exec-bar' }))
    )
  );
  chartsRow1.appendChild(
    el('div', { class: 'card' },
      el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'Revenue by Stream')),
      el('div', { class: 'chart-wrap tall' }, el('canvas', { id: 'exec-donut' }))
    )
  );
  wrap.appendChild(chartsRow1);

  // ── Chart row 2: Horizontal bar — Top contributors ─────────────────────────
  wrap.appendChild(
    el('div', { class: 'card mb-16' },
      el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'Top Contributors (Properties & Clients)')),
      el('div', { class: 'chart-wrap tall' }, el('canvas', { id: 'exec-hbar' }))
    )
  );

  // ── Transactions table ─────────────────────────────────────────────────────
  const txCard = el('div', { class: 'card' });
  txCard.appendChild(
    el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'Transactions'))
  );
  buildTransactionTable(txCard, data);
  wrap.appendChild(txCard);

  // ── Render charts after view is in live DOM ────────────────────────────────
  setTimeout(() => {
    renderMonthlyBar(data);
    renderStreamDonut(data);
    renderContribBar(data);
  }, 0);

  return wrap;
}

// ── Chart 1: Grouped bar — Month × (Revenue, OpEx, CapEx) ────────────────────
function getMonthKeys() {
  const year = gFilters.year !== 'all' ? gFilters.year : String(new Date().getFullYear());
  return MONTH_LABELS.map((label, i) => {
    const mm  = String(i + 1).padStart(2, '0');
    const key = `${year}-${mm}`;
    return { label, key, mm };
  }).filter(m => gFilters.months.size === 0 || gFilters.months.has(m.mm));
}

function renderMonthlyBar({ payments, invoices, opExpenses, renoExpenses }) {
  const months = getMonthKeys();
  if (!months.length) return;

  const revMap = new Map(), expMap = new Map(), renoMap = new Map();
  payments.forEach(p => {
    const mk = p.date?.slice(0, 7);
    if (mk) revMap.set(mk, (revMap.get(mk) || 0) + toEUR(p.amount, p.currency, p.date));
  });
  invoices.forEach(i => {
    const mk = (i.issueDate || '').slice(0, 7);
    if (mk) revMap.set(mk, (revMap.get(mk) || 0) + toEUR(i.total, i.currency, i.issueDate));
  });
  opExpenses.forEach(e => {
    const mk = e.date?.slice(0, 7);
    if (mk) expMap.set(mk, (expMap.get(mk) || 0) + toEUR(e.amount, e.currency, e.date));
  });
  renoExpenses.forEach(e => {
    const mk = e.date?.slice(0, 7);
    if (mk) renoMap.set(mk, (renoMap.get(mk) || 0) + toEUR(e.amount, e.currency, e.date));
  });

  charts.bar('exec-bar', {
    labels: months.map(m => m.label),
    datasets: [
      { label: 'Revenue', data: months.map(m => Math.round(revMap.get(m.key)  || 0)), backgroundColor: '#10b981' },
      { label: 'OpEx',    data: months.map(m => Math.round(expMap.get(m.key)  || 0)), backgroundColor: '#ef4444' },
      { label: 'CapEx',   data: months.map(m => Math.round(renoMap.get(m.key) || 0)), backgroundColor: '#f59e0b' }
    ],
    onClickItem: (label, idx, dsIdx) => {
      const mk    = months[idx]?.key;
      if (!mk) return;
      const mPay  = payments.filter(p => p.date?.slice(0, 7) === mk);
      const mInv  = invoices.filter(i => (i.issueDate || '').slice(0, 7) === mk);
      const mOpEx = opExpenses.filter(e => e.date?.slice(0, 7) === mk);
      const mReno = renoExpenses.filter(e => e.date?.slice(0, 7) === mk);
      const titles = ['Revenue', 'OpEx', 'CapEx'];
      if (dsIdx === 0) {
        drillDownModal(`${label} — Revenue`, drillRevRows(mPay, mInv), REV_COLS);
      } else if (dsIdx === 1) {
        drillDownModal(`${label} — OpEx`, drillExpRows(mOpEx), EXP_COLS);
      } else {
        drillDownModal(`${label} — CapEx`, drillExpRows(mReno), EXP_COLS);
      }
    }
  });
}

// ── Chart 2: Donut — Revenue by Stream ───────────────────────────────────────
function renderStreamDonut({ payments, invoices }) {
  const streamMap = new Map();
  payments.forEach(p => {
    const s = p.stream || 'other';
    streamMap.set(s, (streamMap.get(s) || 0) + toEUR(p.amount, p.currency, p.date));
  });
  invoices.forEach(i => {
    const s = i.stream || 'other';
    streamMap.set(s, (streamMap.get(s) || 0) + toEUR(i.total, i.currency, i.issueDate));
  });

  const entries    = [...streamMap.entries()].filter(([, v]) => v > 0);
  const streamKeys = entries.map(([k]) => k);
  if (!entries.length) return;

  charts.doughnut('exec-donut', {
    labels: entries.map(([k]) => STREAMS[k]?.label || k),
    data:   entries.map(([, v]) => Math.round(v)),
    colors: entries.map(([k]) => STREAMS[k]?.color || '#8b93b0'),
    onClickItem: (label, idx) => {
      const sk = streamKeys[idx];
      drillDownModal(
        `Revenue — ${label}`,
        drillRevRows(
          payments.filter(p => (p.stream || 'other') === sk),
          invoices.filter(i => (i.stream || 'other') === sk)
        ),
        REV_COLS
      );
    }
  });
}

// ── Chart 3: Horizontal bar — Top contributors ────────────────────────────────
function renderContribBar({ payments, invoices }) {
  const map = new Map();

  payments.forEach(p => {
    const name = byId('properties', p.propertyId)?.name || 'Unknown';
    const cur  = map.get(name) || { eur: 0, type: 'property', id: p.propertyId };
    map.set(name, { ...cur, eur: cur.eur + toEUR(p.amount, p.currency, p.date) });
  });
  invoices.forEach(i => {
    const name = byId('clients', i.clientId)?.name || 'Unknown';
    const cur  = map.get(name) || { eur: 0, type: 'client', id: i.clientId };
    map.set(name, { ...cur, eur: cur.eur + toEUR(i.total, i.currency, i.issueDate) });
  });

  const sorted     = [...map.entries()].sort((a, b) => b[1].eur - a[1].eur).slice(0, 10);
  const entityMeta = sorted.map(([, m]) => m);
  if (!sorted.length) return;

  charts.bar('exec-hbar', {
    labels: sorted.map(([name]) => name),
    datasets: [{
      label:           'Revenue (EUR)',
      data:            sorted.map(([, m]) => Math.round(m.eur)),
      backgroundColor: sorted.map((_, i) => `hsla(${(210 + i * 28) % 360}, 65%, 55%, 0.85)`)
    }],
    horizontal: true,
    onClickItem: (label, idx) => {
      const meta = entityMeta[idx];
      const rows = meta.type === 'property'
        ? drillRevRows(payments.filter(p => p.propertyId === meta.id), [])
        : drillRevRows([], invoices.filter(i => i.clientId === meta.id));
      drillDownModal(`Revenue — ${label}`, rows, REV_COLS);
    }
  });
}

// ── Transactions table ────────────────────────────────────────────────────────
function buildTransactionTable(container, { payments, invoices, opExpenses, renoExpenses }) {
  const rows = [];

  for (const p of payments) {
    const prop = byId('properties', p.propertyId);
    rows.push({
      _date:     p.date,
      _eur:      toEUR(p.amount, p.currency, p.date),
      date:      fmtDate(p.date),
      type:      'Payment',
      stream:    STREAMS[p.stream]?.short || p.stream || '—',
      entity:    prop?.name || '—',
      owner:     OWNERS[prop?.owner] || prop?.owner || '—',
      category:  p.type || '—',
      status:    p.status || '—',
      amountEUR: formatEUR(toEUR(p.amount, p.currency, p.date))
    });
  }
  for (const i of invoices) {
    const client = byId('clients', i.clientId);
    rows.push({
      _date:     i.issueDate,
      _eur:      toEUR(i.total, i.currency, i.issueDate),
      date:      fmtDate(i.issueDate),
      type:      'Invoice',
      stream:    STREAMS[i.stream]?.short || i.stream || '—',
      entity:    client?.name || '—',
      owner:     '—',
      category:  'Invoice',
      status:    i.status || '—',
      amountEUR: formatEUR(toEUR(i.total, i.currency, i.issueDate))
    });
  }
  for (const e of [...opExpenses, ...renoExpenses]) {
    const prop   = byId('properties', e.propertyId);
    const eurAmt = toEUR(e.amount, e.currency, e.date);
    rows.push({
      _date:     e.date,
      _eur:      -eurAmt,
      date:      fmtDate(e.date),
      type:      isCapEx(e) ? 'CapEx' : 'OpEx',
      stream:    STREAMS[e.stream]?.short || '—',
      entity:    prop?.name || '—',
      owner:     OWNERS[prop?.owner] || prop?.owner || '—',
      category:  e.category || e.costCategory || '—',
      status:    'recorded',
      amountEUR: formatEUR(eurAmt)
    });
  }

  rows.sort((a, b) => (b._date || '').localeCompare(a._date || ''));

  const TX_COLS = [
    { key: 'date',      label: 'Date'        },
    { key: 'type',      label: 'Type'        },
    { key: 'stream',    label: 'Stream'      },
    { key: 'entity',    label: 'Entity'      },
    { key: 'owner',     label: 'Owner'       },
    { key: 'category',  label: 'Category'    },
    { key: 'status',    label: 'Status'      },
    { key: 'amountEUR', label: 'Amount EUR', right: true }
  ];

  const table = el('table', { class: 'table' });
  const htr   = el('tr');
  TX_COLS.forEach(col => htr.appendChild(el('th', { class: col.right ? 'right' : '' }, col.label)));
  table.appendChild(el('thead', {}, htr));

  const tbody = el('tbody');
  for (const r of rows) {
    const tr = el('tr');
    TX_COLS.forEach(col => {
      tr.appendChild(el('td', { class: col.right ? 'right num' : '' }, r[col.key] ?? '—'));
    });
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);

  const tableWrap = el('div', { class: 'table-wrap' });
  tableWrap.appendChild(table);
  container.appendChild(tableWrap);  // must be appended before attachSortFilter
  attachSortFilter(tableWrap);

  const netTotal = rows.reduce((s, r) => s + (r._eur || 0), 0);
  container.appendChild(el('div', {
    style: 'display:flex;justify-content:space-between;margin-top:8px;font-size:13px'
  },
    el('span', { style: 'color:var(--text-muted)' }, `${rows.length} record(s)`),
    el('strong', { class: 'num' }, `Net: ${formatEUR(netTotal)}`)
  ));
}
