// Property Performance Analytics Dashboard
import { el, select, fmtDate, drillDownModal, attachSortFilter } from '../core/ui.js';
import * as charts from '../core/charts.js';
import { STREAMS, OWNERS, PROPERTY_STREAMS } from '../core/config.js';
import {
  availableYears, formatEUR, toEUR, byId,
  listActive, listActivePayments, listActiveProperties,
  isCapEx
} from '../core/data.js';

// ── Filter state ──────────────────────────────────────────────────────────────
let gFilters = {
  year:        String(new Date().getFullYear()),
  months:      new Set(),
  propertyIds: new Set(),
  streams:     new Set(),
  owners:      new Set()
};

const MONTH_LABELS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const CHART_IDS    = ['prop-profit-hbar', 'prop-month-bar', 'prop-rev-donut'];

// ── Module export ─────────────────────────────────────────────────────────────
export default {
  id:    'analytics-properties',
  label: 'Properties',
  icon:  'P',
  render(container) { container.appendChild(buildView()); },
  refresh() { rebuildView(); },
  destroy() { CHART_IDS.forEach(id => charts.destroy(id)); }
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function propStream(p) {
  if (p.type === 'short_term') return 'short_term_rental';
  if (p.type === 'long_term')  return 'long_term_rental';
  return 'other';
}

// ── Filtering ─────────────────────────────────────────────────────────────────
function matchDate(row) {
  const d = row.date || '';
  if (gFilters.year && gFilters.year !== 'all' && !d.startsWith(gFilters.year)) return false;
  if (gFilters.months.size > 0 && !gFilters.months.has(d.slice(5, 7))) return false;
  return true;
}
function matchOwner(prop) {
  if (gFilters.owners.size === 0) return true;
  return prop.owner === 'both' || gFilters.owners.has(prop.owner);
}
function matchPropStream(prop) {
  if (gFilters.streams.size === 0) return true;
  return gFilters.streams.has(propStream(prop));
}
function matchPropId(prop) {
  return gFilters.propertyIds.size === 0 || gFilters.propertyIds.has(prop.id);
}

// ── Data aggregation ──────────────────────────────────────────────────────────
function getData() {
  const allProps = listActiveProperties().filter(p =>
    matchOwner(p) && matchPropStream(p) && matchPropId(p)
  );
  const propIds = new Set(allProps.map(p => p.id));

  const payments    = listActivePayments().filter(p =>
    p.status === 'paid' && matchDate(p) && propIds.has(p.propertyId)
  );
  const opExpenses  = listActive('expenses').filter(e =>
    !isCapEx(e) && matchDate(e) && propIds.has(e.propertyId)
  );
  const capExpenses = listActive('expenses').filter(e =>
    isCapEx(e) && matchDate(e) && propIds.has(e.propertyId)
  );

  const propData = allProps.map(prop => {
    const propPay   = payments   .filter(p => p.propertyId === prop.id);
    const propOpEx  = opExpenses .filter(e => e.propertyId === prop.id);
    const propCapEx = capExpenses.filter(e => e.propertyId === prop.id);
    const rev   = propPay  .reduce((s, p) => s + toEUR(p.amount, p.currency, p.date), 0);
    const opEx  = propOpEx .reduce((s, e) => s + toEUR(e.amount, e.currency, e.date), 0);
    const capEx = propCapEx.reduce((s, e) => s + toEUR(e.amount, e.currency, e.date), 0);
    return {
      prop, rev, opEx, capEx,
      profit: rev - opEx,
      net:    rev - opEx - capEx,
      propPayments:    propPay,
      propOpExpenses:  propOpEx,
      propCapExpenses: propCapEx
    };
  });

  const totals = propData.reduce((s, d) => ({
    rev:    s.rev    + d.rev,
    opEx:   s.opEx   + d.opEx,
    capEx:  s.capEx  + d.capEx,
    profit: s.profit + d.profit,
    net:    s.net    + d.net
  }), { rev: 0, opEx: 0, capEx: 0, profit: 0, net: 0 });

  return { allProps, propData, payments, opExpenses, capExpenses, totals };
}

// ── Rebuild ───────────────────────────────────────────────────────────────────
function rebuildView() {
  CHART_IDS.forEach(id => charts.destroy(id));
  const c = document.getElementById('content');
  if (!c) return;
  c.innerHTML = '';
  c.appendChild(buildView());
}

// ── Drill-down row builders ───────────────────────────────────────────────────
function toRevDrillRows(payments) {
  return payments.map(p => ({
    date:     p.date,
    property: byId('properties', p.propertyId)?.name || '—',
    type:     p.type || '—',
    stream:   STREAMS[p.stream]?.short || p.stream || '—',
    status:   p.status || '—',
    eur:      toEUR(p.amount, p.currency, p.date)
  })).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

function toExpDrillRows(expenses) {
  return expenses.map(e => ({
    date:     e.date,
    property: byId('properties', e.propertyId)?.name || '—',
    type:     isCapEx(e) ? 'CapEx' : 'OpEx',
    category: e.category || '—',
    eur:      toEUR(e.amount, e.currency, e.date)
  })).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

const REV_DRILL_COLS = [
  { key: 'date',     label: 'Date',     format: v => fmtDate(v) },
  { key: 'property', label: 'Property' },
  { key: 'type',     label: 'Type'     },
  { key: 'stream',   label: 'Stream'   },
  { key: 'status',   label: 'Status'   },
  { key: 'eur',      label: 'EUR',      right: true, format: v => formatEUR(v) }
];

const EXP_DRILL_COLS = [
  { key: 'date',     label: 'Date',     format: v => fmtDate(v) },
  { key: 'property', label: 'Property' },
  { key: 'type',     label: 'Type'     },
  { key: 'category', label: 'Category' },
  { key: 'eur',      label: 'EUR',      right: true, format: v => formatEUR(v) }
];

const MIXED_DRILL_COLS = [
  { key: 'date',     label: 'Date',     format: v => fmtDate(v) },
  { key: 'kind',     label: 'Kind'     },
  { key: 'property', label: 'Property' },
  { key: 'category', label: 'Category' },
  { key: 'status',   label: 'Status'   },
  { key: 'eur',      label: 'EUR',      right: true, format: v => formatEUR(v) }
];

function mixedRows(pays, exps) {
  return [
    ...toRevDrillRows(pays) .map(r => ({ ...r, kind: 'Revenue', category: '—' })),
    ...toExpDrillRows(exps) .map(r => ({ ...r, kind: r.type,   status:   '—' }))
  ].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

// ── Multi-select dropdown ─────────────────────────────────────────────────────
function buildMultiSelect(items, filterSet, allLabel, onRefresh) {
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

  const chks = items.map(({ value, label, color }) => {
    const chk = el('input', { type: 'checkbox' });
    chk.dataset.value = value;
    chk.checked = filterSet.size === 0 || filterSet.has(value);
    const dot     = color ? el('span', { style: `display:inline-block;width:8px;height:8px;border-radius:50%;background:${color};flex-shrink:0` }) : null;
    const content = el('span', { style: 'display:flex;align-items:center;gap:6px' }, ...(dot ? [dot] : []), el('span', {}, label));
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
    sync(); onRefresh();
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

// ── KPI card ──────────────────────────────────────────────────────────────────
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

// ── Month key helper ──────────────────────────────────────────────────────────
function getMonthKeys() {
  const year = gFilters.year !== 'all' ? gFilters.year : String(new Date().getFullYear());
  return MONTH_LABELS.map((label, i) => {
    const mm = String(i + 1).padStart(2, '0');
    return { label, key: `${year}-${mm}`, mm };
  }).filter(m => gFilters.months.size === 0 || gFilters.months.has(m.mm));
}

// ── Main view ─────────────────────────────────────────────────────────────────
function buildView() {
  const wrap = el('div', { class: 'view active' });

  // Header
  wrap.appendChild(el('div', { style: 'margin-bottom:16px' },
    el('h2', { style: 'margin:0 0 4px;font-size:20px;font-weight:700' }, 'Property Performance'),
    el('p',  { style: 'margin:0;font-size:13px;color:var(--text-muted)' },
      'Revenue, expenses, and profitability evaluated per property')
  ));

  // Filter bar
  const years   = availableYears();
  const yearSel = select(
    [{ value: 'all', label: 'All Years' }, ...years.map(y => ({ value: y, label: y }))],
    gFilters.year
  );
  yearSel.onchange = () => { gFilters.year = yearSel.value; rebuildView(); };

  const filterBar = el('div', { class: 'flex gap-8 mb-16', style: 'flex-wrap:wrap;align-items:center' });
  filterBar.appendChild(el('span', { style: 'font-size:12px;color:var(--text-muted);align-self:center' }, 'Filters:'));
  filterBar.appendChild(yearSel);
  filterBar.appendChild(buildMultiSelect(
    MONTH_LABELS.map((m, i) => ({ value: String(i + 1).padStart(2, '0'), label: m })),
    gFilters.months, 'All Months', rebuildView
  ));
  filterBar.appendChild(buildMultiSelect(
    listActiveProperties().map(p => ({ value: p.id, label: p.name })),
    gFilters.propertyIds, 'All Properties', rebuildView
  ));
  filterBar.appendChild(buildMultiSelect(
    PROPERTY_STREAMS.map(k => ({ value: k, label: STREAMS[k].label, color: STREAMS[k].color })),
    gFilters.streams, 'All Streams', rebuildView
  ));
  filterBar.appendChild(buildMultiSelect(
    Object.entries(OWNERS).map(([k, v]) => ({ value: k, label: v })),
    gFilters.owners, 'All Owners', rebuildView
  ));
  wrap.appendChild(filterBar);

  // Data
  const data = getData();
  const { propData, payments, opExpenses, capExpenses, totals } = data;

  // ── KPI row ────────────────────────────────────────────────────────────────
  const kpiRow = el('div', { class: 'grid grid-4 mb-16' });
  kpiRow.appendChild(kpiCard(
    'Total Revenue', formatEUR(totals.rev), '',
    () => drillDownModal('Revenue — All Properties', toRevDrillRows(payments), REV_DRILL_COLS)
  ));
  kpiRow.appendChild(kpiCard(
    'Operating Expenses', formatEUR(totals.opEx), '',
    () => drillDownModal('Operating Expenses — All Properties', toExpDrillRows(opExpenses), EXP_DRILL_COLS)
  ));
  kpiRow.appendChild(kpiCard(
    'Operating Profit', formatEUR(totals.profit),
    totals.profit >= 0 ? 'success' : 'danger',
    () => drillDownModal('Operating Profit Breakdown',
      mixedRows(payments, opExpenses),
      MIXED_DRILL_COLS
    )
  ));
  kpiRow.appendChild(kpiCard(
    'Renovation CapEx', formatEUR(totals.capEx),
    totals.capEx > 0 ? 'warning' : '',
    () => drillDownModal('Renovation CapEx — All Properties', toExpDrillRows(capExpenses), EXP_DRILL_COLS)
  ));
  wrap.appendChild(kpiRow);

  // ── Chart row 1: profit hbar (2/3) + revenue donut (1/3) ──────────────────
  const row1 = el('div', { style: 'display:grid;grid-template-columns:2fr 1fr;gap:16px;margin-bottom:16px' });
  row1.appendChild(el('div', { class: 'card' },
    el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'Operating Profit by Property')),
    el('div', { class: 'chart-wrap tall' }, el('canvas', { id: 'prop-profit-hbar' }))
  ));
  row1.appendChild(el('div', { class: 'card' },
    el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'Revenue Share')),
    el('div', { class: 'chart-wrap tall' }, el('canvas', { id: 'prop-rev-donut' }))
  ));
  wrap.appendChild(row1);

  // ── Chart row 2: monthly grouped bar (full width) ─────────────────────────
  wrap.appendChild(el('div', { class: 'card mb-16' },
    el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'Monthly Revenue vs Operating Expenses')),
    el('div', { class: 'chart-wrap' }, el('canvas', { id: 'prop-month-bar' }))
  ));

  // ── Summary table ──────────────────────────────────────────────────────────
  const tableCard = el('div', { class: 'card' });
  tableCard.appendChild(el('div', { class: 'card-header' },
    el('div', { class: 'card-title' }, 'Property Summary'),
    el('div', { style: 'font-size:12px;color:var(--text-muted)' }, 'Click a row for transactions')
  ));
  buildSummaryTable(tableCard, propData);
  wrap.appendChild(tableCard);

  setTimeout(() => {
    renderProfitHBar(data);
    renderRevDonut(data);
    renderMonthBar(data);
  }, 0);

  return wrap;
}

// ── Chart 1: Horizontal bar — Property × Operating Profit ────────────────────
function renderProfitHBar({ propData }) {
  const sorted = [...propData].sort((a, b) => b.profit - a.profit);
  if (!sorted.length) return;

  charts.bar('prop-profit-hbar', {
    labels: sorted.map(d => d.prop.name),
    datasets: [{
      label:           'Operating Profit (EUR)',
      data:            sorted.map(d => Math.round(d.profit)),
      backgroundColor: sorted.map(d => d.profit >= 0 ? 'rgba(16,185,129,0.8)' : 'rgba(239,68,68,0.8)')
    }],
    horizontal: true,
    onClickItem: (_label, idx) => {
      const d = sorted[idx];
      drillDownModal(
        `${d.prop.name} — Operating Profit`,
        mixedRows(d.propPayments, d.propOpExpenses),
        MIXED_DRILL_COLS
      );
    }
  });
}

// ── Chart 2: Grouped bar — Month × (Revenue, Expenses) ───────────────────────
function renderMonthBar({ payments, opExpenses }) {
  const months = getMonthKeys();
  if (!months.length) return;

  const revByMonth = new Map();
  const expByMonth = new Map();
  payments  .forEach(p => { const mk = p.date?.slice(0, 7); if (mk) revByMonth.set(mk, (revByMonth.get(mk) || 0) + toEUR(p.amount, p.currency, p.date)); });
  opExpenses.forEach(e => { const mk = e.date?.slice(0, 7); if (mk) expByMonth.set(mk, (expByMonth.get(mk) || 0) + toEUR(e.amount, e.currency, e.date)); });

  if (!months.some(m => revByMonth.has(m.key) || expByMonth.has(m.key))) return;

  charts.bar('prop-month-bar', {
    labels: months.map(m => m.label),
    datasets: [
      {
        label:           'Revenue',
        data:            months.map(m => Math.round(revByMonth.get(m.key) || 0)),
        backgroundColor: 'rgba(99,102,241,0.8)'
      },
      {
        label:           'Expenses (OpEx)',
        data:            months.map(m => Math.round(expByMonth.get(m.key) || 0)),
        backgroundColor: 'rgba(239,68,68,0.8)'
      }
    ],
    stacked: false,
    onClickItem: (label, idx) => {
      const mk   = months[idx]?.key;
      if (!mk) return;
      const mPay = payments  .filter(p => p.date?.slice(0, 7) === mk);
      const mExp = opExpenses.filter(e => e.date?.slice(0, 7) === mk);
      drillDownModal(`${label} — Revenue & Expenses`, mixedRows(mPay, mExp), MIXED_DRILL_COLS);
    }
  });
}

// ── Chart 3: Donut — Revenue share per property ───────────────────────────────
function renderRevDonut({ propData }) {
  const withRev = propData.filter(d => d.rev > 0);
  if (!withRev.length) return;

  const PALETTE = ['#6366f1','#8b5cf6','#14b8a6','#f59e0b','#ec4899','#3b82f6','#10b981','#ef4444','#06b6d4','#84cc16'];
  charts.doughnut('prop-rev-donut', {
    labels: withRev.map(d => d.prop.name),
    data:   withRev.map(d => Math.round(d.rev)),
    colors: withRev.map((_, i) => PALETTE[i % PALETTE.length]),
    onClickItem: (_label, idx) => {
      const d = withRev[idx];
      drillDownModal(`Revenue — ${d.prop.name}`, toRevDrillRows(d.propPayments), REV_DRILL_COLS);
    }
  });
}

// ── Summary table — one row per property ──────────────────────────────────────
function buildSummaryTable(container, propData) {
  if (propData.length === 0) {
    container.appendChild(el('div', { class: 'empty' }, 'No properties match the selected filters'));
    return;
  }

  const COLS = [
    { key: 'name',   label: 'Property'  },
    { key: 'stream', label: 'Stream'    },
    { key: 'rev',    label: 'Revenue',   right: true, fmt: formatEUR },
    { key: 'opEx',   label: 'Expenses',  right: true, fmt: formatEUR },
    { key: 'profit', label: 'Profit',    right: true, fmt: formatEUR, colored: true },
    { key: 'capEx',  label: 'CapEx',     right: true, fmt: formatEUR },
    { key: 'net',    label: 'Net',       right: true, fmt: formatEUR, colored: true }
  ];

  const sorted = [...propData].sort((a, b) => b.profit - a.profit);

  const table = el('table', { class: 'table' });
  const htr   = el('tr');
  COLS.forEach(col => htr.appendChild(el('th', { class: col.right ? 'right' : '' }, col.label)));
  table.appendChild(el('thead', {}, htr));

  const tbody = el('tbody');
  for (const d of sorted) {
    const sm = STREAMS[propStream(d.prop)];
    const tr = el('tr', { style: 'cursor:pointer', title: 'Click for transactions' });
    tr.onclick = () => drillDownModal(
      `${d.prop.name} — All Transactions`,
      mixedRows(d.propPayments, [...d.propOpExpenses, ...d.propCapExpenses]),
      MIXED_DRILL_COLS
    );
    COLS.forEach(col => {
      const td = el('td', { class: col.right ? 'right num' : '' });
      if (col.key === 'name') {
        td.textContent = d.prop.name;
      } else if (col.key === 'stream') {
        td.appendChild(el('span', { class: `badge ${sm?.css || ''}` }, sm?.short || propStream(d.prop)));
      } else if (col.colored) {
        const v = d[col.key];
        td.style.color = v >= 0 ? 'var(--success)' : 'var(--danger)';
        td.textContent = col.fmt(v);
      } else {
        td.textContent = col.fmt(d[col.key]);
      }
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);

  const tableWrap = el('div', { class: 'table-wrap' });
  tableWrap.appendChild(table);
  container.appendChild(tableWrap);
  attachSortFilter(tableWrap);
}
