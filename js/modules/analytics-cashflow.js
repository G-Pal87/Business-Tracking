// Cash Flow Analytics Dashboard — track liquidity
import { el, select, fmtDate, drillDownModal, attachSortFilter } from '../core/ui.js';
import * as charts from '../core/charts.js';
import { STREAMS, OWNERS } from '../core/config.js';
import {
  availableYears, formatEUR, toEUR, byId,
  listActive, listActivePayments, listActiveProperties, listActiveClients
} from '../core/data.js';

// ── Filter state ──────────────────────────────────────────────────────────────
let gFilters = {
  year:        String(new Date().getFullYear()),
  months:      new Set(),
  streams:     new Set(),
  propertyIds: new Set(),
  clientIds:   new Set(),
  owners:      new Set(),
  dateFrom:    '',
  dateTo:      ''
};

const MONTH_LABELS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const CHART_IDS    = ['cf-cumulative-line', 'cf-month-bar', 'cf-net-donut', 'cf-net-month-bar', 'cf-prop-hbar', 'cf-stream-bar'];

// ── Module export ─────────────────────────────────────────────────────────────
export default {
  id:    'analytics-cashflow',
  label: 'Cash Flow',
  icon:  '≈',
  render(container) { container.appendChild(buildView()); },
  refresh() { rebuildView(); },
  destroy() { CHART_IDS.forEach(id => charts.destroy(id)); }
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function expStream(e) {
  if (e.stream) return e.stream;
  if (e.propertyId) {
    const p = byId('properties', e.propertyId);
    if (p?.type === 'short_term') return 'short_term_rental';
    if (p?.type === 'long_term')  return 'long_term_rental';
  }
  return 'other';
}

// ── Filtering ─────────────────────────────────────────────────────────────────
function matchDate(row) {
  const d = row.date || row.issueDate || '';
  if (gFilters.year && gFilters.year !== 'all' && !d.startsWith(gFilters.year)) return false;
  if (gFilters.months.size > 0 && !gFilters.months.has(d.slice(5, 7))) return false;
  if (gFilters.dateFrom && d < gFilters.dateFrom) return false;
  if (gFilters.dateTo   && d > gFilters.dateTo)   return false;
  return true;
}
function matchStream(row) {
  return gFilters.streams.size === 0 || !row.stream || gFilters.streams.has(row.stream);
}
function matchExpStream(e) {
  return gFilters.streams.size === 0 || gFilters.streams.has(expStream(e));
}
function matchOwner(row) {
  if (gFilters.owners.size === 0) return true;
  const owner = byId('properties', row.propertyId)?.owner || 'both';
  return owner === 'both' || gFilters.owners.has(owner);
}
function matchInvOwner(inv) {
  if (gFilters.owners.size === 0) return true;
  const owner = byId('clients', inv.clientId)?.owner || 'both';
  return owner === 'both' || gFilters.owners.has(owner);
}
function matchProperty(row) {
  return gFilters.propertyIds.size === 0 || !row.propertyId || gFilters.propertyIds.has(row.propertyId);
}
function matchClient(inv) {
  return gFilters.clientIds.size === 0 || !inv.clientId || gFilters.clientIds.has(inv.clientId);
}

// ── Data aggregation ──────────────────────────────────────────────────────────
function getData() {
  const payments = listActivePayments().filter(p =>
    p.status === 'paid' && matchDate(p) && matchStream(p) && matchOwner(p) && matchProperty(p)
  );
  const invoices = listActive('invoices').filter(i =>
    i.status === 'paid' &&
    matchDate({ date: i.issueDate }) &&
    matchStream(i) &&
    matchInvOwner(i) &&
    matchClient(i)
  );
  const expenses = listActive('expenses').filter(e =>
    matchDate(e) && matchExpStream(e) && matchOwner(e) && matchProperty(e)
  );

  const cashIn  = payments.reduce((s, p) => s + toEUR(p.amount, p.currency, p.date), 0)
                + invoices.reduce((s, i) => s + toEUR(i.total, i.currency, i.issueDate), 0);
  const cashOut = expenses.reduce((s, e) => s + toEUR(e.amount, e.currency, e.date), 0);

  return { payments, invoices, expenses, cashIn, cashOut, net: cashIn - cashOut };
}

// ── Inline insights ───────────────────────────────────────────────────────────
function buildInsightsBanner(insights) {
  if (!insights.length) return null;
  const wrap = el('div', { style: 'display:flex;flex-direction:column;gap:8px;margin-bottom:16px' });
  const STYLES = {
    danger:  { bg: 'rgba(239,68,68,0.08)',  border: '#ef4444', icon: '⚠' },
    warning: { bg: 'rgba(245,158,11,0.08)', border: '#f59e0b', icon: '⚡' },
    info:    { bg: 'rgba(99,102,241,0.08)', border: '#6366f1', icon: 'ℹ' }
  };
  for (const { level, text } of insights) {
    const s = STYLES[level] || STYLES.info;
    wrap.appendChild(el('div', {
      style: `display:flex;align-items:flex-start;gap:10px;padding:10px 14px;background:${s.bg};border-left:3px solid ${s.border};border-radius:0 var(--radius-sm) var(--radius-sm) 0;font-size:13px`
    },
      el('span', { style: `color:${s.border};flex-shrink:0` }, s.icon),
      el('span', { style: 'color:var(--text);line-height:1.4' }, text)
    ));
  }
  return wrap;
}

function computeCashFlowInsights({ payments, invoices, expenses, cashIn, cashOut, net }) {
  const items = [];
  if (cashIn === 0 && cashOut === 0) {
    items.push({ level: 'info', text: 'No cash flow data for the selected period.' });
    return items;
  }
  if (net < 0) {
    items.push({ level: 'danger', text: `Net cash flow is ${formatEUR(net)} — more cash is flowing out than in for this period.` });
  }
  const burnRate = cashIn > 0 ? (cashOut / cashIn) * 100 : null;
  if (burnRate !== null && burnRate > 90 && net >= 0) {
    items.push({ level: 'warning', text: `Cash burn rate is ${burnRate.toFixed(0)}% — expenses consume nearly all incoming cash. Buffer is very thin.` });
  }
  // Per-month analysis: count negative months
  const monthMap = new Map();
  const addMk = (mk, inAmt, outAmt) => {
    if (!monthMap.has(mk)) monthMap.set(mk, { in: 0, out: 0 });
    monthMap.get(mk).in  += inAmt;
    monthMap.get(mk).out += outAmt;
  };
  payments.forEach(p => { const mk = p.date?.slice(0, 7); if (mk) addMk(mk, toEUR(p.amount, p.currency, p.date), 0); });
  invoices.forEach(i => { const mk = (i.issueDate || '').slice(0, 7); if (mk) addMk(mk, toEUR(i.total, i.currency, i.issueDate), 0); });
  expenses.forEach(e => { const mk = e.date?.slice(0, 7); if (mk) addMk(mk, 0, toEUR(e.amount, e.currency, e.date)); });
  const months   = [...monthMap.values()];
  const negCount = months.filter(m => m.in - m.out < 0).length;
  if (months.length > 1 && negCount > Math.floor(months.length / 2)) {
    items.push({ level: 'warning', text: `${negCount} of ${months.length} months have negative cash flow — deficit months are the majority.` });
  }
  return items;
}

// ── Rebuild ───────────────────────────────────────────────────────────────────
function rebuildView() {
  CHART_IDS.forEach(id => charts.destroy(id));
  const c = document.getElementById('content');
  if (!c) return;
  c.innerHTML = '';
  c.appendChild(buildView());
}

// ── Row builder — shared between the table and all drill-down modals ──────────
function buildCashFlowRows(payments, invoices, expenses) {
  const rows = [];
  payments.forEach(p => {
    const prop = byId('properties', p.propertyId);
    rows.push({
      date:      p.date,
      _cashIn:   true,
      _eur:      toEUR(p.amount, p.currency, p.date),
      type:      'Cash In',
      stream:    STREAMS[p.stream]?.short || p.stream || '—',
      entity:    prop?.name || p.source || '—',
      owner:     OWNERS[prop?.owner] || prop?.owner || '—',
      amountEUR: formatEUR(toEUR(p.amount, p.currency, p.date))
    });
  });
  invoices.forEach(i => {
    const client = byId('clients', i.clientId);
    rows.push({
      date:      i.issueDate,
      _cashIn:   true,
      _eur:      toEUR(i.total, i.currency, i.issueDate),
      type:      'Cash In',
      stream:    STREAMS[i.stream]?.short || i.stream || '—',
      entity:    client?.name || '—',
      owner:     OWNERS[client?.owner] || client?.owner || '—',
      amountEUR: formatEUR(toEUR(i.total, i.currency, i.issueDate))
    });
  });
  expenses.forEach(e => {
    const prop = byId('properties', e.propertyId);
    rows.push({
      date:      e.date,
      _cashIn:   false,
      _eur:      toEUR(e.amount, e.currency, e.date),
      type:      'Cash Out',
      stream:    STREAMS[expStream(e)]?.short || expStream(e) || '—',
      entity:    prop?.name || '—',
      owner:     OWNERS[prop?.owner] || prop?.owner || '—',
      amountEUR: formatEUR(toEUR(e.amount, e.currency, e.date))
    });
  });
  return rows.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

const CF_DRILL_COLS = [
  { key: 'date',      label: 'Date',       format: v => fmtDate(v) },
  { key: 'type',      label: 'Type'        },
  { key: 'stream',    label: 'Stream'      },
  { key: 'entity',    label: 'Entity'      },
  { key: 'owner',     label: 'Owner'       },
  { key: 'amountEUR', label: 'Amount EUR',  right: true }
];

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
    el('h2', { style: 'margin:0 0 4px;font-size:20px;font-weight:700' }, 'Cash Flow Analytics'),
    el('p',  { style: 'margin:0;font-size:13px;color:var(--text-muted)' },
      'Track liquidity — Cash In (paid payments + invoices) vs Cash Out (expenses)')
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
    Object.entries(STREAMS).map(([k, v]) => ({ value: k, label: v.label, color: v.color })),
    gFilters.streams, 'All Streams', rebuildView
  ));
  filterBar.appendChild(buildMultiSelect(
    listActiveProperties().map(p => ({ value: p.id, label: p.name })),
    gFilters.propertyIds, 'All Properties', rebuildView
  ));
  filterBar.appendChild(buildMultiSelect(
    listActiveClients().map(c => ({ value: c.id, label: c.name })),
    gFilters.clientIds, 'All Clients', rebuildView
  ));
  filterBar.appendChild(buildMultiSelect(
    Object.entries(OWNERS).map(([k, v]) => ({ value: k, label: v })),
    gFilters.owners, 'All Owners', rebuildView
  ));

  // Date range inputs (from / to)
  const dateFromIn = el('input', { type: 'date', class: 'select', style: 'min-width:0;width:130px', value: gFilters.dateFrom, title: 'From date' });
  const dateToIn   = el('input', { type: 'date', class: 'select', style: 'min-width:0;width:130px', value: gFilters.dateTo,   title: 'To date'   });
  dateFromIn.onchange = () => { gFilters.dateFrom = dateFromIn.value; rebuildView(); };
  dateToIn.onchange   = () => { gFilters.dateTo   = dateToIn.value;   rebuildView(); };
  filterBar.appendChild(el('span', { style: 'font-size:12px;color:var(--text-muted);align-self:center' }, 'From:'));
  filterBar.appendChild(dateFromIn);
  filterBar.appendChild(el('span', { style: 'font-size:12px;color:var(--text-muted);align-self:center' }, 'To:'));
  filterBar.appendChild(dateToIn);

  wrap.appendChild(filterBar);

  // Data
  const data = getData();
  const { payments, invoices, expenses, cashIn, cashOut, net } = data;

  // Avg monthly net (over months with any transaction)
  const months = getMonthKeys();
  const monthsWithData = months.filter(m =>
    payments .some(p => p.date?.slice(0, 7) === m.key) ||
    invoices .some(i => (i.issueDate || '').slice(0, 7) === m.key) ||
    expenses .some(e => e.date?.slice(0, 7) === m.key)
  );
  const avgMonthlyNet = monthsWithData.length ? net / monthsWithData.length : 0;

  // ── KPI row ────────────────────────────────────────────────────────────────
  const kpiRow = el('div', { class: 'grid grid-4 mb-16' });
  kpiRow.appendChild(kpiCard(
    'Cash In', formatEUR(cashIn), 'success',
    () => drillDownModal('Cash In — All',
      buildCashFlowRows(payments, invoices, []),
      CF_DRILL_COLS)
  ));
  kpiRow.appendChild(kpiCard(
    'Cash Out', formatEUR(cashOut), '',
    () => drillDownModal('Cash Out — All Expenses',
      buildCashFlowRows([], [], expenses),
      CF_DRILL_COLS)
  ));
  kpiRow.appendChild(kpiCard(
    'Net Cash Flow', formatEUR(net),
    net >= 0 ? 'success' : 'danger',
    () => drillDownModal('Net Cash Flow — All Transactions',
      buildCashFlowRows(payments, invoices, expenses),
      CF_DRILL_COLS)
  ));
  kpiRow.appendChild(kpiCard(
    'Avg Monthly Net', formatEUR(avgMonthlyNet),
    avgMonthlyNet >= 0 ? '' : 'warning',
    () => {
      const rows = months.map(m => {
        const mIn  = payments.filter(p => p.date?.slice(0, 7) === m.key).reduce((s, p) => s + toEUR(p.amount, p.currency, p.date), 0)
                   + invoices.filter(i => (i.issueDate || '').slice(0, 7) === m.key).reduce((s, i) => s + toEUR(i.total, i.currency, i.issueDate), 0);
        const mOut = expenses.filter(e => e.date?.slice(0, 7) === m.key).reduce((s, e) => s + toEUR(e.amount, e.currency, e.date), 0);
        const mNet = mIn - mOut;
        return { month: m.label, cashIn: formatEUR(mIn), cashOut: formatEUR(mOut), net: formatEUR(mNet) };
      }).filter(r => r.cashIn !== formatEUR(0) || r.cashOut !== formatEUR(0));
      drillDownModal('Monthly Net Cash Flow', rows, [
        { key: 'month',   label: 'Month'     },
        { key: 'cashIn',  label: 'Cash In',   right: true },
        { key: 'cashOut', label: 'Cash Out',  right: true },
        { key: 'net',     label: 'Net',       right: true }
      ]);
    }
  ));
  wrap.appendChild(kpiRow);

  // Inline insights
  const cfInsights = computeCashFlowInsights(data);
  const cfBanner = buildInsightsBanner(cfInsights);
  if (cfBanner) wrap.appendChild(cfBanner);

  // ── Chart row 1: Cumulative line (full width, tall) ────────────────────────
  wrap.appendChild(el('div', { class: 'card mb-16' },
    el('div', { class: 'card-header' },
      el('div', { class: 'card-title' }, 'Cumulative Net Cash Flow'),
      el('div', { style: 'font-size:12px;color:var(--text-muted)' }, 'Click a point for that month\'s transactions')
    ),
    el('div', { class: 'chart-wrap tall' }, el('canvas', { id: 'cf-cumulative-line' }))
  ));

  // ── Chart row 2: Grouped bar (2/3) + Net donut (1/3) ──────────────────────
  const row2 = el('div', { style: 'display:grid;grid-template-columns:2fr 1fr;gap:16px;margin-bottom:16px' });
  row2.appendChild(el('div', { class: 'card' },
    el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'Monthly Cash In vs Cash Out')),
    el('div', { class: 'chart-wrap tall' }, el('canvas', { id: 'cf-month-bar' }))
  ));
  row2.appendChild(el('div', { class: 'card' },
    el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'Net Cash by Stream')),
    el('div', { class: 'chart-wrap tall' }, el('canvas', { id: 'cf-net-donut' }))
  ));
  wrap.appendChild(row2);

  // ── Chart row 3: Monthly Net Cash Flow bar (full width) ───────────────────
  wrap.appendChild(el('div', { class: 'card mb-16' },
    el('div', { class: 'card-header' },
      el('div', { class: 'card-title' }, 'Monthly Net Cash Flow'),
      el('div', { style: 'font-size:12px;color:var(--text-muted)' }, 'Green = surplus · Red = deficit · Click for transactions')
    ),
    el('div', { class: 'chart-wrap tall' }, el('canvas', { id: 'cf-net-month-bar' }))
  ));

  // ── Chart row 4: Property breakdown + Stream breakdown ────────────────────
  const row4 = el('div', { class: 'grid grid-2 mb-16' });
  row4.appendChild(el('div', { class: 'card' },
    el('div', { class: 'card-header' },
      el('div', { class: 'card-title' }, 'Cash Flow by Property'),
      el('div', { style: 'font-size:12px;color:var(--text-muted)' }, '● Green = In · Red = Out · Click for breakdown')
    ),
    el('div', { class: 'chart-wrap tall' }, el('canvas', { id: 'cf-prop-hbar' }))
  ));
  row4.appendChild(el('div', { class: 'card' },
    el('div', { class: 'card-header' },
      el('div', { class: 'card-title' }, 'Cash Flow by Stream'),
      el('div', { style: 'font-size:12px;color:var(--text-muted)' }, '● Green = In · Red = Out · Click for breakdown')
    ),
    el('div', { class: 'chart-wrap tall' }, el('canvas', { id: 'cf-stream-bar' }))
  ));
  wrap.appendChild(row4);

  // ── Cash flow table ────────────────────────────────────────────────────────
  const tableCard = el('div', { class: 'card' });
  tableCard.appendChild(el('div', { class: 'card-header' },
    el('div', { class: 'card-title' }, 'Transactions'),
    el('div', { style: 'display:flex;gap:12px;font-size:11px;color:var(--text-muted);align-items:center' },
      el('span', { style: 'display:flex;align-items:center;gap:4px' },
        el('span', { style: 'width:10px;height:10px;border-left:3px solid #10b981;display:inline-block' }),
        'Cash In'
      ),
      el('span', { style: 'display:flex;align-items:center;gap:4px' },
        el('span', { style: 'width:10px;height:10px;border-left:3px solid #ef4444;display:inline-block' }),
        'Cash Out'
      )
    )
  ));
  buildCashFlowTable(tableCard, data);
  wrap.appendChild(tableCard);

  setTimeout(() => {
    renderCumulativeLine(data);
    renderMonthBar(data);
    renderNetStreamDonut(data);
    renderNetMonthBar(data);
    renderPropHBar(data);
    renderStreamBar(data);
  }, 0);

  return wrap;
}

// ── Chart 1: Line — Cumulative Net Cash Flow ──────────────────────────────────
function renderCumulativeLine({ payments, invoices, expenses }) {
  const months = getMonthKeys();
  if (!months.length) return;

  const netByMonth = new Map();
  months.forEach(m => netByMonth.set(m.key, 0));

  payments .forEach(p => { const mk = p.date?.slice(0, 7);         if (netByMonth.has(mk)) netByMonth.set(mk, netByMonth.get(mk) + toEUR(p.amount, p.currency, p.date)); });
  invoices .forEach(i => { const mk = (i.issueDate || '').slice(0, 7); if (netByMonth.has(mk)) netByMonth.set(mk, netByMonth.get(mk) + toEUR(i.total, i.currency, i.issueDate)); });
  expenses .forEach(e => { const mk = e.date?.slice(0, 7);         if (netByMonth.has(mk)) netByMonth.set(mk, netByMonth.get(mk) - toEUR(e.amount, e.currency, e.date)); });

  let cumulative = 0;
  const cumData = months.map(m => { cumulative += netByMonth.get(m.key) || 0; return Math.round(cumulative); });

  if (cumData.every(v => v === 0)) return;

  charts.line('cf-cumulative-line', {
    labels: months.map(m => m.label),
    datasets: [{
      label:                'Cumulative Net (EUR)',
      data:                 cumData,
      borderColor:          '#6366f1',
      backgroundColor:      'rgba(99,102,241,0.08)',
      pointBackgroundColor: cumData.map(v => v >= 0 ? '#10b981' : '#ef4444'),
      pointBorderColor:     cumData.map(v => v >= 0 ? '#10b981' : '#ef4444'),
      pointRadius:          4,
      pointHoverRadius:     6
    }],
    onClickItem: (label, idx) => {
      const mk   = months[idx]?.key;
      if (!mk) return;
      const mPay = payments .filter(p => p.date?.slice(0, 7) === mk);
      const mInv = invoices .filter(i => (i.issueDate || '').slice(0, 7) === mk);
      const mExp = expenses .filter(e => e.date?.slice(0, 7) === mk);
      drillDownModal(`${label} — Transactions`, buildCashFlowRows(mPay, mInv, mExp), CF_DRILL_COLS);
    }
  });
}

// ── Chart 2: Grouped bar — Month × (Cash In, Cash Out) ───────────────────────
function renderMonthBar({ payments, invoices, expenses }) {
  const months = getMonthKeys();
  if (!months.length) return;

  const inByMonth  = new Map();
  const outByMonth = new Map();
  months.forEach(m => { inByMonth.set(m.key, 0); outByMonth.set(m.key, 0); });

  payments .forEach(p => { const mk = p.date?.slice(0, 7);         if (inByMonth.has(mk))  inByMonth .set(mk, inByMonth .get(mk) + toEUR(p.amount, p.currency, p.date)); });
  invoices .forEach(i => { const mk = (i.issueDate || '').slice(0, 7); if (inByMonth.has(mk))  inByMonth .set(mk, inByMonth .get(mk) + toEUR(i.total, i.currency, i.issueDate)); });
  expenses .forEach(e => { const mk = e.date?.slice(0, 7);         if (outByMonth.has(mk)) outByMonth.set(mk, outByMonth.get(mk) + toEUR(e.amount, e.currency, e.date)); });

  if (!months.some(m => inByMonth.get(m.key) > 0 || outByMonth.get(m.key) > 0)) return;

  charts.bar('cf-month-bar', {
    labels: months.map(m => m.label),
    datasets: [
      {
        label:           'Cash In',
        data:            months.map(m => Math.round(inByMonth.get(m.key) || 0)),
        backgroundColor: 'rgba(16,185,129,0.8)'
      },
      {
        label:           'Cash Out',
        data:            months.map(m => Math.round(outByMonth.get(m.key) || 0)),
        backgroundColor: 'rgba(239,68,68,0.8)'
      }
    ],
    stacked: false,
    onClickItem: (label, idx, dsIdx) => {
      const mk   = months[idx]?.key;
      if (!mk) return;
      const mPay = payments.filter(p => p.date?.slice(0, 7) === mk);
      const mInv = invoices.filter(i => (i.issueDate || '').slice(0, 7) === mk);
      const mExp = expenses.filter(e => e.date?.slice(0, 7) === mk);
      const isCashIn = dsIdx === 0;
      drillDownModal(
        `${label} — ${isCashIn ? 'Cash In' : 'Cash Out'}`,
        buildCashFlowRows(isCashIn ? mPay : [], isCashIn ? mInv : [], isCashIn ? [] : mExp),
        CF_DRILL_COLS
      );
    }
  });
}

// ── Chart 3: Donut — Net Cash by Stream ──────────────────────────────────────
// Slice size = |net| per stream; green = positive, red = net-negative stream.
function renderNetStreamDonut({ payments, invoices, expenses }) {
  const netMap = new Map();

  const add = (sk, v) => netMap.set(sk, (netMap.get(sk) || 0) + v);
  payments .forEach(p => add(p.stream || 'other',  toEUR(p.amount, p.currency, p.date)));
  invoices .forEach(i => add(i.stream || 'other',  toEUR(i.total, i.currency, i.issueDate)));
  expenses .forEach(e => add(expStream(e),         -toEUR(e.amount, e.currency, e.date)));

  const entries = [...netMap.entries()].filter(([, v]) => v !== 0)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  if (!entries.length) return;

  charts.doughnut('cf-net-donut', {
    labels: entries.map(([k, v]) => (STREAMS[k]?.short || k) + (v < 0 ? ' ▼' : '')),
    data:   entries.map(([, v]) => Math.abs(Math.round(v))),
    colors: entries.map(([, v]) => v >= 0 ? 'rgba(16,185,129,0.85)' : 'rgba(239,68,68,0.85)'),
    onClickItem: (_label, idx) => {
      const [sk] = entries[idx];
      const sPay = payments.filter(p => (p.stream || 'other') === sk);
      const sInv = invoices.filter(i => (i.stream || 'other') === sk);
      const sExp = expenses.filter(e => expStream(e) === sk);
      drillDownModal(
        `Cash Flow — ${STREAMS[sk]?.label || sk}`,
        buildCashFlowRows(sPay, sInv, sExp),
        CF_DRILL_COLS
      );
    }
  });
}

// ── Chart 4: Bar — Monthly Net Cash Flow ─────────────────────────────────────
function renderNetMonthBar({ payments, invoices, expenses }) {
  const months = getMonthKeys();
  if (!months.length) return;

  const netByMonth = new Map();
  months.forEach(m => netByMonth.set(m.key, 0));

  payments .forEach(p => { const mk = p.date?.slice(0, 7);             if (netByMonth.has(mk)) netByMonth.set(mk, netByMonth.get(mk) + toEUR(p.amount,  p.currency,  p.date)); });
  invoices .forEach(i => { const mk = (i.issueDate || '').slice(0, 7); if (netByMonth.has(mk)) netByMonth.set(mk, netByMonth.get(mk) + toEUR(i.total,   i.currency,  i.issueDate)); });
  expenses .forEach(e => { const mk = e.date?.slice(0, 7);             if (netByMonth.has(mk)) netByMonth.set(mk, netByMonth.get(mk) - toEUR(e.amount,  e.currency,  e.date)); });

  const netData = months.map(m => Math.round(netByMonth.get(m.key) || 0));
  if (netData.every(v => v === 0)) return;

  charts.bar('cf-net-month-bar', {
    labels: months.map(m => m.label),
    datasets: [{
      label:           'Net Cash Flow (EUR)',
      data:            netData,
      backgroundColor: netData.map(v => v >= 0 ? 'rgba(16,185,129,0.8)' : 'rgba(239,68,68,0.8)')
    }],
    stacked: false,
    onClickItem: (_label, idx) => {
      const mk = months[idx]?.key;
      if (!mk) return;
      const mPay = payments.filter(p => p.date?.slice(0, 7) === mk);
      const mInv = invoices.filter(i => (i.issueDate || '').slice(0, 7) === mk);
      const mExp = expenses.filter(e => e.date?.slice(0, 7) === mk);
      drillDownModal(
        `Net Cash Flow — ${months[idx].label}`,
        buildCashFlowRows(mPay, mInv, mExp),
        CF_DRILL_COLS
      );
    }
  });
}

// ── Chart 5: Horizontal grouped bar — Cash Flow by Property ──────────────────
function renderPropHBar({ payments, expenses }) {
  const propInMap  = new Map();
  const propOutMap = new Map();
  const propNames  = new Map();

  const regName = (pid) => {
    if (!propNames.has(pid)) propNames.set(pid, byId('properties', pid)?.name || pid);
  };

  payments.forEach(p => {
    if (!p.propertyId) return;
    regName(p.propertyId);
    propInMap.set(p.propertyId, (propInMap.get(p.propertyId) || 0) + toEUR(p.amount, p.currency, p.date));
  });
  expenses.forEach(e => {
    if (!e.propertyId) return;
    regName(e.propertyId);
    propOutMap.set(e.propertyId, (propOutMap.get(e.propertyId) || 0) + toEUR(e.amount, e.currency, e.date));
  });

  const allPids = [...new Set([...propInMap.keys(), ...propOutMap.keys()])];
  if (!allPids.length) return;

  allPids.sort((a, b) =>
    ((propInMap.get(b) || 0) + (propOutMap.get(b) || 0)) -
    ((propInMap.get(a) || 0) + (propOutMap.get(a) || 0))
  );

  const labels  = allPids.map(pid => propNames.get(pid) || pid);
  const inData  = allPids.map(pid => Math.round(propInMap.get(pid)  || 0));
  const outData = allPids.map(pid => Math.round(propOutMap.get(pid) || 0));

  charts.bar('cf-prop-hbar', {
    labels,
    datasets: [
      { label: 'Cash In',  data: inData,  backgroundColor: 'rgba(16,185,129,0.8)' },
      { label: 'Cash Out', data: outData, backgroundColor: 'rgba(239,68,68,0.8)'  }
    ],
    horizontal: true,
    stacked: false,
    onClickItem: (_label, idx, dsIdx) => {
      const pid  = allPids[idx];
      const name = propNames.get(pid) || pid;
      const pPay = payments.filter(p => p.propertyId === pid);
      const pExp = expenses.filter(e => e.propertyId === pid);
      const isCashIn = dsIdx === 0;
      drillDownModal(
        `${name} — ${isCashIn ? 'Cash In' : 'Cash Out'}`,
        buildCashFlowRows(isCashIn ? pPay : [], [], isCashIn ? [] : pExp),
        CF_DRILL_COLS
      );
    }
  });
}

// ── Chart 6: Horizontal grouped bar — Cash Flow by Stream ────────────────────
function renderStreamBar({ payments, invoices, expenses }) {
  const streamInMap  = new Map();
  const streamOutMap = new Map();

  payments .forEach(p => { const k = p.stream || 'other'; streamInMap .set(k, (streamInMap .get(k) || 0) + toEUR(p.amount, p.currency, p.date)); });
  invoices .forEach(i => { const k = i.stream || 'other'; streamInMap .set(k, (streamInMap .get(k) || 0) + toEUR(i.total, i.currency, i.issueDate)); });
  expenses .forEach(e => { const k = expStream(e);         streamOutMap.set(k, (streamOutMap.get(k) || 0) + toEUR(e.amount, e.currency, e.date)); });

  const allKeys = [...new Set([...streamInMap.keys(), ...streamOutMap.keys()])];
  if (!allKeys.length) return;

  allKeys.sort((a, b) =>
    ((streamInMap.get(b) || 0) + (streamOutMap.get(b) || 0)) -
    ((streamInMap.get(a) || 0) + (streamOutMap.get(a) || 0))
  );

  const labels  = allKeys.map(k => STREAMS[k]?.label || k);
  const inData  = allKeys.map(k => Math.round(streamInMap.get(k)  || 0));
  const outData = allKeys.map(k => Math.round(streamOutMap.get(k) || 0));

  charts.bar('cf-stream-bar', {
    labels,
    datasets: [
      { label: 'Cash In',  data: inData,  backgroundColor: 'rgba(16,185,129,0.8)' },
      { label: 'Cash Out', data: outData, backgroundColor: 'rgba(239,68,68,0.8)'  }
    ],
    horizontal: true,
    stacked: false,
    onClickItem: (_label, idx, dsIdx) => {
      const sk   = allKeys[idx];
      const sPay = payments.filter(p => (p.stream || 'other') === sk);
      const sInv = invoices.filter(i => (i.stream || 'other') === sk);
      const sExp = expenses.filter(e => expStream(e) === sk);
      const isCashIn = dsIdx === 0;
      drillDownModal(
        `${STREAMS[sk]?.label || sk} — ${isCashIn ? 'Cash In' : 'Cash Out'}`,
        buildCashFlowRows(isCashIn ? sPay : [], isCashIn ? sInv : [], isCashIn ? [] : sExp),
        CF_DRILL_COLS
      );
    }
  });
}

// ── Cash flow table ───────────────────────────────────────────────────────────
// Columns: date, type, stream, entity, owner, amountEUR
// Cash In rows get a green left-border; Cash Out rows get a red left-border.
function buildCashFlowTable(container, { payments, invoices, expenses }) {
  const TABLE_COLS = [
    { key: 'date',      label: 'Date'      },
    { key: 'type',      label: 'Type',      badge: true },
    { key: 'stream',    label: 'Stream'    },
    { key: 'entity',    label: 'Entity'    },
    { key: 'owner',     label: 'Owner'     },
    { key: 'amountEUR', label: 'Amount EUR', right: true }
  ];

  const rows = buildCashFlowRows(payments, invoices, expenses);

  const table = el('table', { class: 'table' });
  const htr   = el('tr');
  TABLE_COLS.forEach(col => htr.appendChild(el('th', { class: col.right ? 'right' : '' }, col.label)));
  table.appendChild(el('thead', {}, htr));

  const tbody = el('tbody');
  for (const r of rows) {
    const borderColor = r._cashIn ? '#10b981' : '#ef4444';
    const tr = el('tr', { style: `border-left:3px solid ${borderColor}` });
    TABLE_COLS.forEach(col => {
      const td = el('td', { class: col.right ? 'right num' : '' });
      if (col.badge) {
        td.appendChild(el('span', {
          style: `font-size:10px;font-weight:600;padding:2px 6px;border-radius:3px;letter-spacing:0.04em;` +
                 (r._cashIn
                   ? 'background:rgba(16,185,129,0.15);color:#10b981'
                   : 'background:rgba(239,68,68,0.12);color:#ef4444')
        }, r.type));
      } else if (col.key === 'date') {
        td.textContent = fmtDate(r.date);
      } else {
        td.textContent = r[col.key] ?? '—';
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

  const totalIn  = rows.filter(r =>  r._cashIn).reduce((s, r) => s + r._eur, 0);
  const totalOut = rows.filter(r => !r._cashIn).reduce((s, r) => s + r._eur, 0);
  container.appendChild(el('div', {
    style: 'display:flex;justify-content:space-between;margin-top:8px;font-size:13px'
  },
    el('span', { style: 'color:var(--text-muted)' }, `${rows.length} record(s)`),
    el('span', { style: 'display:flex;gap:16px' },
      el('span', { style: 'color:#10b981' }, `In: ${formatEUR(totalIn)}`),
      el('span', { style: 'color:#ef4444' }, `Out: ${formatEUR(totalOut)}`),
      el('strong', { class: 'num', style: totalIn - totalOut >= 0 ? 'color:var(--success)' : 'color:var(--danger)' },
        `Net: ${formatEUR(totalIn - totalOut)}`)
    )
  ));
}
