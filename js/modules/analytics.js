// Executive Analytics Dashboard
import { el, buildMultiSelect, button, fmtDate, drillDownModal } from '../core/ui.js';
import * as charts from '../core/charts.js';
import { STREAMS, OWNERS, COST_CATEGORIES, EXPENSE_CATEGORIES } from '../core/config.js';
import {
  availableYears, formatEUR, toEUR, byId,
  listActive, listActivePayments,
  isCapEx, drillRevRows, drillExpRows,
  forecastedRevenueEUR, forecastMonthlyEUR,
  sumPaymentsEUR, sumInvoicesEUR, sumExpensesEUR
} from '../core/data.js';

// ── Constants ────────────────────────────────────────────────────────────────
const MONTH_LABELS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

const ALL_CHART_IDS = [
  'exec-trend-rev','exec-trend-profit','exec-trend-cashflow',
  'exec-kd-rev-stream','exec-kd-exp-cat',
  'exec-fc-actual','exec-fc-var-pct','exec-opex-capex',
  'exec-rev-vs-profit','exec-rev-conc','exec-cashflow-wfall',
  'exec-inv-breakdown','exec-outstanding-aging',
  'exec-margin-trend','exec-rev-growth'
];

const SELECT_STYLE = 'background:var(--bg-elev-1);border:1px solid var(--border);border-radius:var(--radius-sm);padding:6px 10px;font-size:12px;color:var(--text);cursor:pointer';

// ── Filter State ─────────────────────────────────────────────────────────────
let gF = {
  period:       'ytd',
  customYear:   String(new Date().getFullYear()),
  customMonths: new Set(),
  owners:       new Set(),
  streams:      new Set(),
  properties:   new Set(),
  compareTo:    'prev-year',
  cmpStart:     '',
  cmpEnd:       '',
};

// ── Module export ────────────────────────────────────────────────────────────
export default {
  id: 'analytics', label: 'Executive', icon: 'A',
  render(container) { container.appendChild(buildView()); },
  refresh() { rebuildView(); },
  destroy() { ALL_CHART_IDS.forEach(id => charts.destroy(id)); }
};

// ── Drill-down column definitions ────────────────────────────────────────────
const REV_COLS = [
  { key: 'date',   label: 'Date',        format: v => fmtDate(v) },
  { key: 'type',   label: 'Type' },
  { key: 'source', label: 'Entity' },
  { key: 'ref',    label: 'Ref' },
  { key: 'eur',    label: 'EUR', right: true, format: v => formatEUR(v) }
];
const EXP_COLS = [
  { key: 'date',        label: 'Date',        format: v => fmtDate(v) },
  { key: 'source',      label: 'Property' },
  { key: 'category',    label: 'Category' },
  { key: 'description', label: 'Description' },
  { key: 'eur',         label: 'EUR', right: true, format: v => formatEUR(v) }
];
const MIXED_COLS = [
  { key: 'date',   label: 'Date',           format: v => fmtDate(v) },
  { key: 'kind',   label: 'Kind' },
  { key: 'source', label: 'Entity / Source' },
  { key: 'eur',    label: 'EUR', right: true, format: v => formatEUR(v) }
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

// ── Period range calculation ─────────────────────────────────────────────────
function getCurrentPeriodRange() {
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const y = now.getFullYear();
  const m = now.getMonth(); // 0-based
  const d = now.getDate();

  if (gF.period === 'ytd') {
    return { start: `${y}-01-01`, end: todayStr, label: `YTD ${y}`, isIncomplete: true };
  }
  if (gF.period === 'this-month') {
    const start = `${y}-${String(m+1).padStart(2,'0')}-01`;
    const lastDay = new Date(y, m+1, 0).getDate();
    return {
      start, end: todayStr,
      label: MONTH_LABELS[m] + ' ' + y,
      isIncomplete: d < lastDay
    };
  }
  if (gF.period === 'this-quarter') {
    const qStart = Math.floor(m / 3) * 3;
    const start = `${y}-${String(qStart+1).padStart(2,'0')}-01`;
    return { start, end: todayStr, label: `Q${Math.floor(m/3)+1} ${y}`, isIncomplete: true };
  }
  if (gF.period === 'this-year') {
    const end = `${y}-12-31`;
    return { start: `${y}-01-01`, end, label: String(y), isIncomplete: todayStr < end };
  }
  if (gF.period === 'last-year') {
    const ly = y - 1;
    return { start: `${ly}-01-01`, end: `${ly}-12-31`, label: String(ly), isIncomplete: false };
  }
  if (gF.period === 'all') {
    return { start: '2000-01-01', end: todayStr, label: 'All Time', isIncomplete: false };
  }
  if (gF.period === 'custom') {
    const cy = gF.customYear;
    if (gF.customMonths.size === 0) {
      return { start: `${cy}-01-01`, end: `${cy}-12-31`, label: cy, isIncomplete: false };
    }
    const sorted = [...gF.customMonths].map(Number).sort((a,b)=>a-b);
    const firstM = sorted[0];
    const lastM  = sorted[sorted.length - 1];
    const start  = `${cy}-${String(firstM).padStart(2,'0')}-01`;
    const lastDay = new Date(Number(cy), lastM, 0).getDate();
    const end    = `${cy}-${String(lastM).padStart(2,'0')}-${String(lastDay).padStart(2,'0')}`;
    const mNames = sorted.map(m2 => MONTH_LABELS[m2-1]).join(', ');
    return { start, end, label: `${mNames} ${cy}`, isIncomplete: false };
  }
  return { start: `${y}-01-01`, end: todayStr, label: `YTD ${y}`, isIncomplete: true };
}

// ── Comparison range ─────────────────────────────────────────────────────────
function getComparisonRange(cur) {
  if (gF.compareTo === 'none') return null;

  const shiftYMD = (dateStr, dy, dm, dd) => {
    const d = new Date(dateStr);
    d.setFullYear(d.getFullYear() + dy, d.getMonth() + dm, d.getDate() + dd);
    return d.toISOString().slice(0, 10);
  };
  const addYears = (dateStr, n) => {
    const d = new Date(dateStr);
    d.setFullYear(d.getFullYear() + n);
    return d.toISOString().slice(0, 10);
  };

  if (gF.compareTo === 'prev-period') {
    const startD = new Date(cur.start);
    const endD   = new Date(cur.end);
    const durMs  = endD - startD;
    const durDays = Math.round(durMs / 86400000);
    const newEnd  = new Date(startD - 86400000);
    const newStart = new Date(newEnd - durMs);
    const fmt = d => d.toISOString().slice(0, 10);
    return { start: fmt(newStart), end: fmt(newEnd), label: 'Prev Period' };
  }
  if (gF.compareTo === 'last-month') {
    const now = new Date();
    const ly = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
    const lm = now.getMonth() === 0 ? 12 : now.getMonth();
    const start = `${ly}-${String(lm).padStart(2,'0')}-01`;
    const lastDay = new Date(ly, lm, 0).getDate();
    const end = `${ly}-${String(lm).padStart(2,'0')}-${String(lastDay).padStart(2,'0')}`;
    return { start, end, label: MONTH_LABELS[lm-1] + ' ' + ly };
  }
  if (gF.compareTo === 'last-quarter') {
    const now = new Date();
    const curQ = Math.floor(now.getMonth() / 3);
    const prevQ = curQ === 0 ? 3 : curQ - 1;
    const prevY = curQ === 0 ? now.getFullYear() - 1 : now.getFullYear();
    const qStartM = prevQ * 3 + 1;
    const qEndM = qStartM + 2;
    const start = `${prevY}-${String(qStartM).padStart(2,'0')}-01`;
    const lastDay = new Date(prevY, qEndM, 0).getDate();
    const end = `${prevY}-${String(qEndM).padStart(2,'0')}-${String(lastDay).padStart(2,'0')}`;
    return { start, end, label: `Q${prevQ+1} ${prevY}` };
  }
  if (gF.compareTo === 'same-period-last-year') {
    return {
      start: addYears(cur.start, -1),
      end:   addYears(cur.end, -1),
      label: 'Same Period Last Year'
    };
  }
  if (gF.compareTo === 'prev-year') {
    if (cur.isIncomplete) {
      return {
        start: addYears(cur.start, -1),
        end:   addYears(cur.end, -1),
        label: 'Prev Year'
      };
    } else {
      const curY = new Date(cur.start).getFullYear();
      const py = curY - 1;
      return { start: `${py}-01-01`, end: `${py}-12-31`, label: String(py) };
    }
  }
  if (gF.compareTo === 'custom-compare') {
    if (!gF.cmpStart || !gF.cmpEnd) return null;
    return { start: gF.cmpStart, end: gF.cmpEnd, label: `${gF.cmpStart} – ${gF.cmpEnd}` };
  }
  return null;
}

// ── Virtual property acquisitions ────────────────────────────────────────────
function getVirtualAcquisitions() {
  return listActive('properties')
    .filter(p => p.purchasePrice > 0 && p.purchaseDate)
    .filter(p => {
      if (gF.owners.size > 0) {
        const ow = p.owner || 'both';
        if (ow !== 'both' && !gF.owners.has(ow)) return false;
        if (ow === 'both') { /* both = include always when any owner selected */ }
      }
      if (gF.properties.size > 0 && !gF.properties.has(p.id)) return false;
      return true;
    })
    .map(p => ({
      _virtual: true,
      _acquisitionOf: p.id,
      id: `__acq_${p.id}`,
      propertyId: p.id,
      date: p.purchaseDate,
      amount: p.purchasePrice,
      currency: p.currency || 'EUR',
      costCategory: 'acquisition',
      accountingType: 'capex',
      description: `Property acquisition: ${p.name}`,
      _name: p.name
    }));
}

// ── Data getter (range-based) ────────────────────────────────────────────────
function getDataInRange(start, end) {
  const inRange = (date) => date && date >= start && date <= end;

  const matchOwner = (row) => {
    if (gF.owners.size === 0) return true;
    if (!row.propertyId) return true;
    const prop = byId('properties', row.propertyId);
    const ow = prop?.owner || 'both';
    if (ow === 'both') return true;
    return gF.owners.has(ow);
  };
  const matchStream = (row) => {
    if (gF.streams.size === 0) return true;
    if (!row.stream) return true;
    return gF.streams.has(row.stream);
  };
  const matchProperty = (row) => {
    if (gF.properties.size === 0) return true;
    if (!row.propertyId) return true;
    return gF.properties.has(row.propertyId);
  };

  const payments = listActivePayments().filter(p =>
    p.status === 'paid' && inRange(p.date) &&
    matchStream(p) && matchOwner(p) && matchProperty(p)
  );
  const invoices = listActive('invoices').filter(i =>
    i.status === 'paid' && inRange(i.issueDate) &&
    matchStream(i) && matchOwner(i) && matchProperty(i)
  );
  const allExpenses = listActive('expenses').filter(e =>
    inRange(e.date) && matchOwner(e) && matchProperty(e)
  );
  const opExpenses  = allExpenses.filter(e => !isCapEx(e) && matchStream(e));
  const capExExpenses = allExpenses.filter(e => isCapEx(e));

  const allAcq = getVirtualAcquisitions();
  const acquisitions = allAcq.filter(a => inRange(a.date));

  return { payments, invoices, opExpenses, capExExpenses, acquisitions };
}

// ── Metrics calculator ───────────────────────────────────────────────────────
function calcMetrics(data, periodYear = null) {
  const { payments, invoices, opExpenses, capExExpenses, acquisitions } = data;

  const rev         = sumPaymentsEUR(payments) + sumInvoicesEUR(invoices);
  const opEx        = sumExpensesEUR(opExpenses);
  const capExFromExp = sumExpensesEUR(capExExpenses);
  const capExFromAcq = acquisitions.reduce((s, a) => s + toEUR(a.amount, a.currency, a.date), 0);
  const capEx       = capExFromExp + capExFromAcq;
  const opProfit    = rev - opEx;
  const opMargin    = rev > 0 ? (opProfit / rev) * 100 : null;
  const netCash     = opProfit - capEx;

  // Outstanding = all currently open invoices (not range-limited), stream/owner/property filtered
  const outstanding = listActive('invoices').filter(i => {
    if (i.status !== 'sent' && i.status !== 'overdue') return false;
    if (gF.streams.size > 0 && i.stream && !gF.streams.has(i.stream)) return false;
    if (gF.owners.size > 0) {
      const prop = i.propertyId ? byId('properties', i.propertyId) : null;
      const ow = prop?.owner || i.owner || 'both';
      if (ow !== 'both' && !gF.owners.has(ow)) return false;
    }
    if (gF.properties.size > 0 && i.propertyId && !gF.properties.has(i.propertyId)) return false;
    return true;
  });
  const outstandingTotal = sumInvoicesEUR(outstanding);

  let fcRev = null;
  if (periodYear) {
    const raw = forecastedRevenueEUR(periodYear);
    if (raw > 0) fcRev = raw;
  }

  return {
    rev, opEx, capExFromExp, capExFromAcq, capEx,
    opProfit, opMargin, netCash,
    outstanding, outstandingTotal, fcRev,
    payments, invoices, opExpenses, capExExpenses, acquisitions
  };
}

// ── Safe math ────────────────────────────────────────────────────────────────
function safePct(current, prev) {
  if (prev === null || prev === undefined || !isFinite(prev) || prev === 0) return null;
  const pct = ((current - prev) / Math.abs(prev)) * 100;
  if (!isFinite(pct)) return null;
  return pct;
}

function safePp(current, prev) {
  if (current === null || prev === null || current === undefined || prev === undefined) return null;
  if (!isFinite(current) || !isFinite(prev)) return null;
  return current - prev;
}

// ── Period year helper ───────────────────────────────────────────────────────
function getPeriodYear(curRange) {
  const sy = curRange.start.slice(0, 4);
  const ey = curRange.end.slice(0, 4);
  return sy === ey ? sy : null;
}

// ── Rebuild ──────────────────────────────────────────────────────────────────
function rebuildView() {
  ALL_CHART_IDS.forEach(id => charts.destroy(id));
  const c = document.getElementById('content');
  if (!c) return;
  c.innerHTML = '';
  c.appendChild(buildView());
}

// ── Filter bar ───────────────────────────────────────────────────────────────
function makeSelect(options, value, onChange) {
  const s = el('select', { style: SELECT_STYLE });
  options.forEach(([val, label]) => s.appendChild(el('option', { value: val }, label)));
  s.value = value;
  s.addEventListener('change', () => onChange(s.value));
  return s;
}

function buildFilterBar() {
  const bar = el('div', { class: 'flex gap-8 mb-16', style: 'flex-wrap:wrap;align-items:center' });

  // Period select
  const periodSel = makeSelect([
    ['ytd',          'YTD'],
    ['this-month',   'This Month'],
    ['this-quarter', 'This Quarter'],
    ['this-year',    'Full Year'],
    ['last-year',    'Last Year'],
    ['all',          'All Time'],
    ['custom',       'Custom'],
  ], gF.period, v => { gF.period = v; rebuildView(); });
  bar.appendChild(periodSel);

  // Custom year (only when custom)
  if (gF.period === 'custom') {
    const years = availableYears();
    const yearSel = makeSelect(
      (years.length ? years : [String(new Date().getFullYear())]).map(y => [y, y]),
      gF.customYear,
      v => { gF.customYear = v; rebuildView(); }
    );
    bar.appendChild(yearSel);

    // Month multi-select
    const monthItems = MONTH_LABELS.map((label, i) => ({
      value: String(i + 1).padStart(2, '0'), label
    }));
    const monthMS = buildMultiSelect(monthItems, gF.customMonths, 'All Months', rebuildView, 'ana_exec_months');
    bar.appendChild(monthMS);
  }

  // Owner multi-select
  const ownerItems = Object.entries(OWNERS).map(([k, v]) => ({ value: k, label: v }));
  bar.appendChild(buildMultiSelect(ownerItems, gF.owners, 'All Owners', rebuildView, 'ana_exec_owners'));

  // Stream multi-select
  const streamItems = Object.entries(STREAMS).map(([k, v]) => ({ value: k, label: v.label, css: v.css }));
  bar.appendChild(buildMultiSelect(streamItems, gF.streams, 'All Streams', rebuildView, 'ana_exec_streams'));

  // Property multi-select
  const propItems = listActive('properties').map(p => ({ value: p.id, label: p.name }));
  bar.appendChild(buildMultiSelect(propItems, gF.properties, 'All Properties', rebuildView, 'ana_exec_props'));

  // Compare select
  const cmpSel = makeSelect([
    ['none',                  'No Comparison'],
    ['prev-period',           'Previous Period'],
    ['last-month',            'Last Month'],
    ['last-quarter',          'Last Quarter'],
    ['same-period-last-year', 'Same Period Last Year'],
    ['prev-year',             'Previous Year'],
    ['custom-compare',        'Custom'],
  ], gF.compareTo, v => { gF.compareTo = v; rebuildView(); });
  bar.appendChild(cmpSel);

  // Custom compare date inputs
  if (gF.compareTo === 'custom-compare') {
    const fromIn = el('input', {
      type: 'date', value: gF.cmpStart, style: SELECT_STYLE, title: 'Compare from'
    });
    fromIn.addEventListener('change', () => { gF.cmpStart = fromIn.value; rebuildView(); });
    bar.appendChild(fromIn);

    const toIn = el('input', {
      type: 'date', value: gF.cmpEnd, style: SELECT_STYLE, title: 'Compare to'
    });
    toIn.addEventListener('change', () => { gF.cmpEnd = toIn.value; rebuildView(); });
    bar.appendChild(toIn);
  }

  // Reset
  bar.appendChild(button('Reset', {
    variant: 'sm ghost',
    onClick: () => {
      gF = {
        period: 'ytd',
        customYear: String(new Date().getFullYear()),
        customMonths: new Set(),
        owners: new Set(),
        streams: new Set(),
        properties: new Set(),
        compareTo: 'prev-year',
        cmpStart: '',
        cmpEnd: '',
      };
      rebuildView();
    }
  }));

  return bar;
}

// ── KPI card builder ──────────────────────────────────────────────────────────
function kpiCard({ label, value, variant, onClick, delta, deltaIsPercent, deltaIsPp, invertDelta, compLabel }) {
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

  // Trend row
  const trendDiv = el('div', { class: 'kpi-trend' });
  if (delta === null || delta === undefined || !isFinite(delta)) {
    trendDiv.appendChild(el('span', { style: 'color:var(--text-muted);font-size:11px' }, 'N/A'));
    if (compLabel) trendDiv.appendChild(document.createTextNode(` vs ${compLabel}`));
  } else {
    const sign = delta > 0 ? '+' : '';
    let display;
    if (deltaIsPp) {
      display = `${sign}${delta.toFixed(1)} pp`;
    } else {
      display = `${sign}${delta.toFixed(1)}%`;
    }
    // Positive-is-good: up=good if !invertDelta; up=bad if invertDelta
    let cls = '';
    if (delta > 0) cls = invertDelta ? 'down' : 'up';
    else if (delta < 0) cls = invertDelta ? 'up' : 'down';
    trendDiv.appendChild(el('span', { class: cls }, display));
    if (compLabel) trendDiv.appendChild(document.createTextNode(` vs ${compLabel}`));
  }
  card.appendChild(trendDiv);
  card.appendChild(el('div', { class: 'kpi-accent-bar' }));
  return card;
}

// ── 8 KPI cards ──────────────────────────────────────────────────────────────
function buildKpiGrid(curMetrics, cmpMetrics, cmpRange) {
  const { rev, opEx, capEx, opProfit, opMargin, netCash, outstandingTotal, fcRev,
          payments, invoices, opExpenses, capExExpenses, acquisitions, outstanding } = curMetrics;
  const cmpLabel = cmpRange?.label || '';

  const grid = el('div', {
    class: 'mb-16',
    style: 'display:grid;grid-template-columns:repeat(8,1fr);gap:12px'
  });

  // 1. Revenue
  grid.appendChild(kpiCard({
    label: 'Revenue', value: formatEUR(rev),
    variant: '',
    onClick: () => drillDownModal('Revenue Breakdown', drillRevRows(payments, invoices), REV_COLS),
    delta: cmpMetrics ? safePct(rev, cmpMetrics.rev) : null,
    invertDelta: false, compLabel: cmpLabel
  }));

  // 2. Forecast Revenue
  let fcDelta = null, fcDeltaLabel = cmpLabel;
  if (cmpMetrics?.fcRev != null && fcRev != null) {
    fcDelta = safePct(fcRev, cmpMetrics.fcRev);
  } else if (fcRev != null) {
    fcDelta = safePct(rev, fcRev);
    fcDeltaLabel = 'forecast';
  }
  grid.appendChild(kpiCard({
    label: 'Forecast Revenue', value: fcRev != null ? formatEUR(fcRev) : '—',
    variant: '',
    onClick: () => drillDownModal('Revenue Breakdown', drillRevRows(payments, invoices), REV_COLS),
    delta: fcDelta, invertDelta: false, compLabel: fcDeltaLabel
  }));

  // 3. Operating Expenses
  grid.appendChild(kpiCard({
    label: 'Operating Expenses', value: formatEUR(opEx),
    variant: '',
    onClick: () => drillDownModal('Operating Expenses', drillExpRows(opExpenses), EXP_COLS),
    delta: cmpMetrics ? safePct(opEx, cmpMetrics.opEx) : null,
    invertDelta: true, compLabel: cmpLabel
  }));

  // 4. Operating Profit
  grid.appendChild(kpiCard({
    label: 'Operating Profit', value: formatEUR(opProfit),
    variant: opProfit >= 0 ? 'success' : 'danger',
    onClick: () => drillDownModal('Operating Profit', mixedRows(payments, invoices, opExpenses), MIXED_COLS),
    delta: cmpMetrics ? safePct(opProfit, cmpMetrics.opProfit) : null,
    invertDelta: false, compLabel: cmpLabel
  }));

  // 5. Operating Margin
  grid.appendChild(kpiCard({
    label: 'Operating Margin %',
    value: opMargin != null ? `${opMargin.toFixed(1)}%` : '—',
    variant: '',
    onClick: () => drillDownModal('Operating Profit', mixedRows(payments, invoices, opExpenses), MIXED_COLS),
    delta: (cmpMetrics && opMargin != null) ? safePp(opMargin, cmpMetrics.opMargin) : null,
    deltaIsPp: true, invertDelta: false, compLabel: cmpLabel
  }));

  // 6. CapEx
  const capExDrillRows = [
    ...drillExpRows(capExExpenses),
    ...acquisitions.map(a => ({
      date: a.date, source: a._name || '',
      category: 'Acquisition', description: a.description,
      eur: toEUR(a.amount, a.currency, a.date)
    }))
  ].sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  grid.appendChild(kpiCard({
    label: 'Investments / CapEx', value: formatEUR(capEx),
    variant: '',
    onClick: () => drillDownModal('Investments / CapEx', capExDrillRows, EXP_COLS),
    delta: (cmpMetrics && (capEx > 0 || cmpMetrics.capEx > 0)) ? safePct(capEx, cmpMetrics.capEx) : null,
    invertDelta: false, compLabel: cmpLabel
  }));

  // 7. Net Cash Flow
  grid.appendChild(kpiCard({
    label: 'Net Cash Flow', value: formatEUR(netCash),
    variant: netCash >= 0 ? 'success' : 'danger',
    onClick: () => drillDownModal('Cash Flow', mixedRows(payments, invoices, [...opExpenses, ...capExExpenses]), MIXED_COLS),
    delta: cmpMetrics ? safePct(netCash, cmpMetrics.netCash) : null,
    invertDelta: false, compLabel: cmpLabel
  }));

  // 8. Outstanding
  grid.appendChild(kpiCard({
    label: 'Outstanding', value: formatEUR(outstandingTotal),
    variant: outstandingTotal > 0 ? 'warning' : '',
    onClick: () => drillDownModal('Outstanding Invoices', drillRevRows([], outstanding), REV_COLS),
    delta: cmpMetrics ? safePct(outstandingTotal, cmpMetrics.outstandingTotal) : null,
    invertDelta: true, compLabel: cmpLabel
  }));

  return grid;
}

// ── Chart section builder helpers ────────────────────────────────────────────
function makeChartSection(title, panels) {
  const card = el('div', { class: 'card mb-16' });
  card.appendChild(el('div', { class: 'card-header' },
    el('div', { class: 'card-title' }, title)
  ));
  const grid = el('div', {
    style: 'display:grid;grid-template-columns:repeat(3,1fr);gap:16px;padding:0 16px 16px'
  });
  for (const [panelTitle, canvasId] of panels) {
    const panel = el('div');
    panel.appendChild(el('div', { class: 'kpi-label', style: 'margin-bottom:8px' }, panelTitle));
    panel.appendChild(el('div', { class: 'chart-wrap' }, el('canvas', { id: canvasId })));
    grid.appendChild(panel);
  }
  card.appendChild(grid);
  return card;
}

// ── Month key generation ─────────────────────────────────────────────────────
function getMonthKeysForRange(start, end) {
  const startY = parseInt(start.slice(0,4));
  const startM = parseInt(start.slice(5,7));
  const endY   = parseInt(end.slice(0,4));
  const endM   = parseInt(end.slice(5,7));
  const isSingleYear = startY === endY;
  const keys = [];
  let y = startY, m = startM;
  while (y < endY || (y === endY && m <= endM)) {
    const mm = String(m).padStart(2,'0');
    const key = `${y}-${mm}`;
    const label = isSingleYear ? MONTH_LABELS[m-1] : `${MONTH_LABELS[m-1]} '${String(y).slice(2)}`;
    keys.push({ key, label, y: String(y), m });
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return { keys, isSingleYear };
}

// ── Monthly data aggregation ─────────────────────────────────────────────────
function buildMonthlyMaps(data) {
  const revMap = new Map();
  const opExMap = new Map();
  const capExMap = new Map();

  data.payments.forEach(p => {
    const mk = p.date?.slice(0,7);
    if (mk) revMap.set(mk, (revMap.get(mk) || 0) + toEUR(p.amount, p.currency, p.date));
  });
  data.invoices.forEach(i => {
    const mk = (i.issueDate || '').slice(0,7);
    if (mk) revMap.set(mk, (revMap.get(mk) || 0) + toEUR(i.total, i.currency, i.issueDate));
  });
  data.opExpenses.forEach(e => {
    const mk = e.date?.slice(0,7);
    if (mk) opExMap.set(mk, (opExMap.get(mk) || 0) + toEUR(e.amount, e.currency, e.date));
  });
  data.capExExpenses.forEach(e => {
    const mk = e.date?.slice(0,7);
    if (mk) capExMap.set(mk, (capExMap.get(mk) || 0) + toEUR(e.amount, e.currency, e.date));
  });
  data.acquisitions.forEach(a => {
    const mk = a.date?.slice(0,7);
    if (mk) capExMap.set(mk, (capExMap.get(mk) || 0) + toEUR(a.amount, a.currency, a.date));
  });
  return { revMap, opExMap, capExMap };
}

// ── All chart renderers ───────────────────────────────────────────────────────
function renderAllCharts(curData, curMetrics, cmpData, cmpMetrics, curRange, cmpRange) {
  const { keys: months, isSingleYear } = getMonthKeysForRange(curRange.start, curRange.end);
  if (!months.length) return;

  const labels = months.map(m => m.label);
  const { revMap, opExMap, capExMap } = buildMonthlyMaps(curData);

  const revData    = months.map(m => Math.round(revMap.get(m.key)   || 0));
  const opExData   = months.map(m => Math.round(opExMap.get(m.key)  || 0));
  const capExData  = months.map(m => Math.round(capExMap.get(m.key) || 0));
  const profData   = months.map((m, i) => revData[i] - opExData[i]);
  const cashData   = months.map((m, i) => profData[i] - capExData[i]);
  const marginData = months.map((m, i) => revData[i] > 0 ? (profData[i] / revData[i]) * 100 : null);

  // Comparison monthly maps
  let cmpRevMap = new Map(), cmpOpExMap = new Map(), cmpCapExMap = new Map();
  let cmpRevArr = null, cmpProfArr = null, cmpCashArr = null, cmpMarginArr = null;
  if (cmpData && cmpRange) {
    const cm = buildMonthlyMaps(cmpData);
    cmpRevMap = cm.revMap; cmpOpExMap = cm.opExMap; cmpCapExMap = cm.capExMap;
    const { keys: cmpMonths } = getMonthKeysForRange(cmpRange.start, cmpRange.end);
    // Align to current period positions
    cmpRevArr    = months.map((_, i) => Math.round(cmpRevMap.get(cmpMonths[i]?.key) || 0));
    const cmpOpEx = months.map((_, i) => Math.round(cmpOpExMap.get(cmpMonths[i]?.key) || 0));
    cmpProfArr   = months.map((_, i) => cmpRevArr[i] - cmpOpEx[i]);
    const cmpCap  = months.map((_, i) => Math.round(cmpCapExMap.get(cmpMonths[i]?.key) || 0));
    cmpCashArr   = months.map((_, i) => cmpProfArr[i] - cmpCap[i]);
    cmpMarginArr = months.map((_, i) => cmpRevArr[i] > 0 ? (cmpProfArr[i] / cmpRevArr[i]) * 100 : null);
  }

  // Forecast monthly map
  let fcMap = null;
  const periodYear = getPeriodYear(curRange);
  if (periodYear && isSingleYear) {
    const raw = forecastMonthlyEUR(periodYear);
    if (raw.size > 0) fcMap = raw;
  }

  // ── Section 1: Business Trends ───────────────────────────────────────────
  // exec-trend-rev
  {
    const datasets = [{
      label: 'Revenue', data: revData,
      borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,0.08)', fill: true
    }];
    if (fcMap) {
      const fcArr = months.map(m => Math.round(fcMap.get(m.key) || 0));
      if (fcArr.some(v => v > 0)) {
        datasets.push({ label: 'Forecast', data: fcArr, borderColor: '#6366f1', backgroundColor: 'transparent', borderDash: [4,4], fill: false });
      }
    }
    if (cmpRevArr) {
      datasets.push({ label: `Rev (${cmpRange.label})`, data: cmpRevArr, borderColor: '#6b7280', backgroundColor: 'transparent', borderDash: [4,4], fill: false });
    }
    if (datasets[0].data.some(v => v > 0) || datasets.length > 1) {
      charts.line('exec-trend-rev', {
        labels, datasets,
        onClickItem: (label, idx) => {
          const mk = months[idx]?.key;
          if (!mk) return;
          drillDownModal(`${months[idx].label} — Revenue`,
            drillRevRows(curData.payments.filter(p => p.date?.slice(0,7) === mk),
                         curData.invoices.filter(i => (i.issueDate||'').slice(0,7) === mk)),
            REV_COLS);
        }
      });
    }
  }

  // exec-trend-profit
  {
    const datasets = [{
      label: 'Op. Profit', data: profData,
      borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,0.08)', fill: true
    }];
    if (cmpProfArr) {
      datasets.push({ label: `Profit (${cmpRange.label})`, data: cmpProfArr, borderColor: '#6b7280', backgroundColor: 'transparent', borderDash: [4,4], fill: false });
    }
    if (datasets[0].data.some(v => v !== 0)) {
      charts.line('exec-trend-profit', {
        labels, datasets,
        onClickItem: (label, idx) => {
          const mk = months[idx]?.key;
          if (!mk) return;
          drillDownModal(`${months[idx].label} — Operating Profit`,
            mixedRows(curData.payments.filter(p => p.date?.slice(0,7) === mk),
                      curData.invoices.filter(i => (i.issueDate||'').slice(0,7) === mk),
                      curData.opExpenses.filter(e => e.date?.slice(0,7) === mk)),
            MIXED_COLS);
        }
      });
    }
  }

  // exec-trend-cashflow
  {
    const datasets = [{
      label: 'Net Cash Flow', data: cashData,
      borderColor: '#f59e0b', backgroundColor: 'rgba(245,158,11,0.08)', fill: true
    }];
    if (cmpCashArr) {
      datasets.push({ label: `Cash (${cmpRange.label})`, data: cmpCashArr, borderColor: '#6b7280', backgroundColor: 'transparent', borderDash: [4,4], fill: false });
    }
    if (datasets[0].data.some(v => v !== 0)) {
      charts.line('exec-trend-cashflow', {
        labels, datasets,
        onClickItem: (label, idx) => {
          const mk = months[idx]?.key;
          if (!mk) return;
          drillDownModal(`${months[idx].label} — Cash Flow`,
            mixedRows(curData.payments.filter(p => p.date?.slice(0,7) === mk),
                      curData.invoices.filter(i => (i.issueDate||'').slice(0,7) === mk),
                      [...curData.opExpenses, ...curData.capExExpenses].filter(e => e.date?.slice(0,7) === mk)),
            MIXED_COLS);
        }
      });
    }
  }

  // ── Section 2: Forecast & Margins ───────────────────────────────────────
  // exec-fc-actual
  if (fcMap && isSingleYear) {
    const fcArr = months.map(m => Math.round(fcMap.get(m.key) || 0));
    if (fcArr.some(v => v > 0) || revData.some(v => v > 0)) {
      charts.line('exec-fc-actual', {
        labels,
        datasets: [
          { label: 'Actual', data: revData, borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,0.08)', fill: true },
          { label: 'Forecast', data: fcArr, borderColor: '#6366f1', backgroundColor: 'transparent', borderDash: [4,4], fill: false }
        ]
      });
    }
  }

  // exec-fc-var-pct
  if (fcMap && isSingleYear) {
    const fcArr = months.map(m => fcMap.get(m.key) || 0);
    const varData  = months.map((m, i) => {
      const fc = fcArr[i];
      if (!fc) return null;
      const pct = ((revData[i] - fc) / Math.abs(fc)) * 100;
      return isFinite(pct) ? Math.round(pct * 10) / 10 : null;
    });
    if (varData.some(v => v !== null)) {
      charts.bar('exec-fc-var-pct', {
        labels,
        datasets: [{
          label: 'Forecast Variance %',
          data: varData.map(v => v ?? 0),
          backgroundColor: varData.map(v => v === null ? '#6b7280' : v >= 0 ? '#10b981' : '#ef4444')
        }]
      });
    }
  }

  // exec-margin-trend
  {
    const datasets = [{
      label: 'Op. Margin %', data: marginData,
      borderColor: '#8b5cf6', backgroundColor: 'transparent', fill: false
    }];
    if (cmpMarginArr) {
      datasets.push({ label: `Margin (${cmpRange.label})`, data: cmpMarginArr, borderColor: '#6b7280', backgroundColor: 'transparent', borderDash: [4,4], fill: false });
    }
    if (marginData.some(v => v !== null)) {
      charts.line('exec-margin-trend', { labels, datasets });
    }
  }

  // ── Section 3: Growth & Mix ──────────────────────────────────────────────
  // exec-rev-growth (YoY monthly growth %)
  {
    // Build all-time revenue map (no date filter, but stream/owner/property filtered)
    const allRevMap = new Map();
    listActivePayments().filter(p => {
      if (p.status !== 'paid') return false;
      if (gF.streams.size > 0 && p.stream && !gF.streams.has(p.stream)) return false;
      if (gF.owners.size > 0 && p.propertyId) {
        const prop = byId('properties', p.propertyId);
        const ow = prop?.owner || 'both';
        if (ow !== 'both' && !gF.owners.has(ow)) return false;
      }
      if (gF.properties.size > 0 && p.propertyId && !gF.properties.has(p.propertyId)) return false;
      return true;
    }).forEach(p => {
      const mk = p.date?.slice(0,7);
      if (mk) allRevMap.set(mk, (allRevMap.get(mk) || 0) + toEUR(p.amount, p.currency, p.date));
    });
    listActive('invoices').filter(i => {
      if (i.status !== 'paid') return false;
      if (gF.streams.size > 0 && i.stream && !gF.streams.has(i.stream)) return false;
      if (gF.owners.size > 0 && i.propertyId) {
        const prop = byId('properties', i.propertyId);
        const ow = prop?.owner || 'both';
        if (ow !== 'both' && !gF.owners.has(ow)) return false;
      }
      if (gF.properties.size > 0 && i.propertyId && !gF.properties.has(i.propertyId)) return false;
      return true;
    }).forEach(i => {
      const mk = (i.issueDate || '').slice(0,7);
      if (mk) allRevMap.set(mk, (allRevMap.get(mk) || 0) + toEUR(i.total, i.currency, i.issueDate));
    });

    const growthData = months.map(m => {
      const curRev = allRevMap.get(m.key) || 0;
      const prevKey = `${String(parseInt(m.key.slice(0,4)) - 1)}-${m.key.slice(5,7)}`;
      const prevRev = allRevMap.get(prevKey);
      if (prevRev === undefined || prevRev === null) return null;
      if (prevRev === 0) return null;
      const g = ((curRev - prevRev) / Math.abs(prevRev)) * 100;
      return isFinite(g) ? Math.round(g * 10) / 10 : null;
    });

    if (growthData.some(v => v !== null)) {
      charts.bar('exec-rev-growth', {
        labels,
        datasets: [{
          label: 'YoY Revenue Growth %',
          data: growthData.map(v => v ?? 0),
          backgroundColor: growthData.map(v => v === null ? '#6b7280' : v >= 0 ? '#10b981' : '#ef4444')
        }]
      });
    }
  }

  // exec-opex-capex (stacked bar)
  if (opExData.some(v => v > 0) || capExData.some(v => v > 0)) {
    charts.bar('exec-opex-capex', {
      labels,
      stacked: true,
      datasets: [
        { label: 'OpEx', data: opExData, backgroundColor: '#ef4444' },
        { label: 'CapEx', data: capExData, backgroundColor: '#f59e0b' }
      ]
    });
  }

  // exec-rev-vs-profit (grouped bar)
  if (revData.some(v => v > 0) || profData.some(v => v !== 0)) {
    charts.bar('exec-rev-vs-profit', {
      labels,
      datasets: [
        { label: 'Revenue', data: revData, backgroundColor: '#10b981' },
        { label: 'Op. Profit', data: profData, backgroundColor: '#3b82f6' }
      ]
    });
  }

  // ── Section 4: Composition ───────────────────────────────────────────────
  // exec-kd-rev-stream
  {
    const revByStream = new Map();
    const streamPays = new Map();
    const streamInvs = new Map();
    curData.payments.forEach(p => {
      const s = p.stream || 'other';
      revByStream.set(s, (revByStream.get(s) || 0) + toEUR(p.amount, p.currency, p.date));
      if (!streamPays.has(s)) streamPays.set(s, []);
      streamPays.get(s).push(p);
    });
    curData.invoices.forEach(i => {
      const s = i.stream || 'other';
      revByStream.set(s, (revByStream.get(s) || 0) + toEUR(i.total, i.currency, i.issueDate));
      if (!streamInvs.has(s)) streamInvs.set(s, []);
      streamInvs.get(s).push(i);
    });
    const entries = [...revByStream.entries()].filter(([,v]) => v > 0);
    if (entries.length) {
      charts.doughnut('exec-kd-rev-stream', {
        labels: entries.map(([k]) => STREAMS[k]?.label || k),
        data:   entries.map(([,v]) => Math.round(v)),
        colors: entries.map(([k]) => STREAMS[k]?.color || '#8b93b0'),
        onClickItem: (label, idx) => {
          const [sk] = entries[idx];
          drillDownModal(`Revenue — ${label}`,
            drillRevRows(streamPays.get(sk) || [], streamInvs.get(sk) || []),
            REV_COLS);
        }
      });
    }
  }

  // exec-rev-conc (top entities by revenue)
  {
    const entityMap = new Map();
    curData.payments.forEach(p => {
      const prop = p.propertyId ? byId('properties', p.propertyId) : null;
      const key = p.propertyId || 'unknown';
      const name = prop?.name || p.propertyId || 'Unknown';
      const e = entityMap.get(key) || { name, pays: [], invs: [], rev: 0 };
      e.rev += toEUR(p.amount, p.currency, p.date);
      e.pays.push(p);
      entityMap.set(key, e);
    });
    curData.invoices.forEach(i => {
      const client = i.clientId ? byId('clients', i.clientId) : null;
      const key = i.clientId || 'unknown';
      const name = client?.name || i.clientId || 'Unknown';
      const e = entityMap.get(key) || { name, pays: [], invs: [], rev: 0 };
      e.rev += toEUR(i.total, i.currency, i.issueDate);
      e.invs.push(i);
      entityMap.set(key, e);
    });
    const sorted = [...entityMap.values()].sort((a,b) => b.rev - a.rev);
    const top5 = sorted.slice(0, 5);
    const other = sorted.slice(5).reduce((s,e) => s + e.rev, 0);
    const dLabels = top5.map(e => e.name);
    const dData   = top5.map(e => Math.round(e.rev));
    const dColors = ['#8b5cf6','#10b981','#3b82f6','#f59e0b','#ec4899'];
    if (other > 0) { dLabels.push('Other'); dData.push(Math.round(other)); dColors.push('#8b93b0'); }
    if (dData.some(v => v > 0)) {
      charts.doughnut('exec-rev-conc', {
        labels: dLabels, data: dData, colors: dColors,
        onClickItem: (label, idx) => {
          if (idx < top5.length) {
            const entity = top5[idx];
            drillDownModal(`Revenue — ${label}`, drillRevRows(entity.pays, entity.invs), REV_COLS);
          }
        }
      });
    }
  }

  // exec-inv-breakdown
  {
    const catMap = new Map();
    curData.capExExpenses.forEach(e => {
      const cat = e.costCategory || 'other';
      const entry = catMap.get(cat) || { items: [], total: 0 };
      entry.total += toEUR(e.amount, e.currency, e.date);
      entry.items.push(e);
      catMap.set(cat, entry);
    });
    // Acquisitions as group
    if (curData.acquisitions.length > 0) {
      const total = curData.acquisitions.reduce((s,a) => s + toEUR(a.amount, a.currency, a.date), 0);
      catMap.set('__acq__', { items: curData.acquisitions, total, _isAcq: true });
    }
    const entries = [...catMap.entries()].filter(([,v]) => v.total > 0);
    if (entries.length) {
      charts.doughnut('exec-inv-breakdown', {
        labels: entries.map(([k, v]) => v._isAcq ? 'Acquisitions' : (COST_CATEGORIES[k]?.label || k)),
        data:   entries.map(([,v]) => Math.round(v.total)),
        colors: entries.map(([k, v]) => v._isAcq ? '#6366f1' : (COST_CATEGORIES[k]?.color || '#8b93b0')),
        onClickItem: (label, idx) => {
          const [, entry] = entries[idx];
          if (entry._isAcq) {
            const rows = entry.items.map(a => ({
              date: a.date, source: a._name || '', category: 'Acquisition',
              description: a.description, eur: toEUR(a.amount, a.currency, a.date)
            }));
            drillDownModal(`Investments — Acquisitions`, rows, EXP_COLS);
          } else {
            drillDownModal(`Investments — ${label}`, drillExpRows(entry.items), EXP_COLS);
          }
        }
      });
    }
  }

  // ── Section 5: Outstanding & Cash ────────────────────────────────────────
  // exec-outstanding-aging
  {
    const todayStr = new Date().toISOString().slice(0, 10);
    const buckets = [0, 0, 0, 0];
    curMetrics.outstanding.forEach(i => {
      const days = Math.floor((Date.now() - new Date(i.issueDate).getTime()) / 86400000);
      const eur  = toEUR(i.total, i.currency, i.issueDate);
      if (days <= 30) buckets[0] += eur;
      else if (days <= 60) buckets[1] += eur;
      else if (days <= 90) buckets[2] += eur;
      else buckets[3] += eur;
    });
    if (buckets.some(v => v > 0)) {
      charts.bar('exec-outstanding-aging', {
        labels: ['Current (0-30d)', '31-60 days', '61-90 days', '90+ days'],
        horizontal: true,
        datasets: [{
          label: 'Outstanding',
          data: buckets.map(v => Math.round(v)),
          backgroundColor: ['#3b82f6','#f59e0b','#f59e0b','#ef4444']
        }]
      });
    }
  }

  // exec-cashflow-wfall (waterfall simulation)
  {
    const { rev: cRev, opEx: cOpEx, capEx: cCapEx, netCash: cNet } = curMetrics;
    if (cRev > 0 || cOpEx > 0 || cCapEx > 0) {
      charts.bar('exec-cashflow-wfall', {
        labels: ['Revenue', 'OpEx', 'Investments', 'Net Cash Flow'],
        datasets: [{
          label: 'Amount',
          data: [Math.round(cRev), Math.round(-cOpEx), Math.round(-cCapEx), Math.round(cNet)],
          backgroundColor: ['#10b981', '#ef4444', '#f59e0b', cNet >= 0 ? '#3b82f6' : '#ef4444']
        }]
      });
    }
  }

  // exec-kd-exp-cat
  {
    const catMap = new Map();
    const catItems = new Map();
    [...curData.opExpenses, ...curData.capExExpenses].forEach(e => {
      const cat = e.costCategory || e.category || 'other';
      catMap.set(cat, (catMap.get(cat) || 0) + toEUR(e.amount, e.currency, e.date));
      if (!catItems.has(cat)) catItems.set(cat, []);
      catItems.get(cat).push(e);
    });
    const entries = [...catMap.entries()].filter(([,v]) => v > 0).sort((a,b) => b[1]-a[1]);
    if (entries.length) {
      charts.doughnut('exec-kd-exp-cat', {
        labels: entries.map(([k]) => COST_CATEGORIES[k]?.label || EXPENSE_CATEGORIES[k]?.label || k),
        data:   entries.map(([,v]) => Math.round(v)),
        colors: entries.map(([k]) => COST_CATEGORIES[k]?.color || EXPENSE_CATEGORIES[k]?.color || '#8b93b0'),
        onClickItem: (label, idx) => {
          const [cat] = entries[idx];
          drillDownModal(`Expenses — ${label}`, drillExpRows(catItems.get(cat) || []), EXP_COLS);
        }
      });
    }
  }
}

// ── Performance Insights ─────────────────────────────────────────────────────
function buildPerformanceInsights(curData, curMetrics) {
  const section = el('div', { class: 'card mb-16' });
  section.appendChild(el('div', { class: 'card-header' },
    el('div', { class: 'card-title' }, 'Performance Insights')
  ));
  const body = el('div', { style: 'padding:0 16px 16px;font-size:13px;line-height:1.8' });

  // Build entity map for revenue concentration
  const entityMap = new Map();
  curData.payments.forEach(p => {
    const prop = p.propertyId ? byId('properties', p.propertyId) : null;
    const key = p.propertyId || 'unknown';
    const e = entityMap.get(key) || { name: prop?.name || key, type: 'property', rev: 0, pays: [], invs: [] };
    e.rev += toEUR(p.amount, p.currency, p.date);
    e.pays.push(p);
    entityMap.set(key, e);
  });
  curData.invoices.forEach(i => {
    const client = i.clientId ? byId('clients', i.clientId) : null;
    const key = i.clientId || 'unknown-client';
    const e = entityMap.get(key) || { name: client?.name || key, type: 'client', rev: 0, pays: [], invs: [] };
    e.rev += toEUR(i.total, i.currency, i.issueDate);
    e.invs.push(i);
    entityMap.set(key, e);
  });
  const entities = [...entityMap.values()].sort((a,b) => b.rev - a.rev);

  // Build expense by category map
  const expByCat = new Map();
  [...curData.opExpenses, ...curData.capExExpenses].forEach(e => {
    const cat = e.costCategory || e.category || 'other';
    const entry = expByCat.get(cat) || { exp: 0, items: [] };
    entry.exp += toEUR(e.amount, e.currency, e.date);
    entry.items.push(e);
    expByCat.set(cat, entry);
  });
  const topExpCat = [...expByCat.entries()].sort((a,b) => b[1].exp - a[1].exp)[0];

  if (!entities.length && !topExpCat) {
    body.appendChild(el('div', { style: 'color:var(--text-muted)' }, 'No insights available for the selected period.'));
    section.appendChild(body);
    return section;
  }

  const row = el('div', { style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px' });

  const makeBlock = (label, lines) => {
    const block = el('div');
    block.appendChild(el('div', {
      style: 'font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:var(--text-muted);margin-bottom:6px'
    }, label));
    lines.forEach(({ text, onClick }) => {
      const p2 = el('p', { style: 'margin:0' }, text);
      if (onClick) { p2.style.cursor = 'pointer'; p2.title = 'Click for breakdown'; p2.onclick = onClick; }
      block.appendChild(p2);
    });
    return block;
  };

  // Revenue concentration
  const topEntities = entities.slice(0, 2);
  if (topEntities.length) {
    const lines = topEntities.map((e, i) => ({
      text: `${i === 0 ? 'Top' : 'Second'}: ${e.name} (${formatEUR(e.rev)})`,
      onClick: () => drillDownModal(`${e.name} — Revenue`, drillRevRows(e.pays, e.invs), REV_COLS)
    }));
    row.appendChild(makeBlock('Revenue concentration', lines));
  }

  // Cost concentration
  if (topExpCat) {
    const [ck, cd] = topExpCat;
    const catLabel = COST_CATEGORIES[ck]?.label || EXPENSE_CATEGORIES[ck]?.label || ck;
    row.appendChild(makeBlock('Cost concentration', [{
      text: `Main cost driver: ${catLabel} (${formatEUR(cd.exp)})`,
      onClick: () => drillDownModal(`Expenses — ${catLabel}`, drillExpRows(cd.items), EXP_COLS)
    }]));
  }

  // Risk signal
  if (topEntities[0]) {
    const e = topEntities[0];
    row.appendChild(makeBlock('Risk signal', [{
      text: `High dependency on a single contributor (${e.name})`,
      onClick: () => drillDownModal(`${e.name} — Revenue`, drillRevRows(e.pays, e.invs), REV_COLS)
    }]));
  }

  // Investment signal
  const capExCat = [...expByCat.entries()]
    .filter(([k]) => {
      const l = (COST_CATEGORIES[k]?.label || EXPENSE_CATEGORIES[k]?.label || '').toLowerCase();
      return l.includes('capex') || l.includes('renovation') || k === 'capex' || k === 'renovation';
    })
    .sort((a,b) => b[1].exp - a[1].exp)[0];
  if (capExCat) {
    const [ck, cd] = capExCat;
    const catLabel = COST_CATEGORIES[ck]?.label || EXPENSE_CATEGORIES[ck]?.label || ck;
    row.appendChild(makeBlock('Investment signal', [{
      text: `High CapEx driven by ${catLabel} (${formatEUR(cd.exp)})`,
      onClick: () => drillDownModal(`Expenses — ${catLabel}`, drillExpRows(cd.items), EXP_COLS)
    }]));
  }

  body.appendChild(row);
  section.appendChild(body);
  return section;
}

// ── Main view builder ────────────────────────────────────────────────────────
function buildView() {
  const wrap = el('div', { class: 'view active' });

  // Page header
  wrap.appendChild(el('div', { style: 'margin-bottom:16px' },
    el('h2', { style: 'margin:0 0 4px;font-size:20px;font-weight:700' }, 'Executive Dashboard'),
    el('p', { style: 'margin:0;font-size:13px;color:var(--text-muted)' },
      'Consolidated overview — revenue, expenses and cash flow')
  ));

  // Filter bar
  wrap.appendChild(buildFilterBar());

  // Compute ranges
  const curRange = getCurrentPeriodRange();
  const cmpRange = getComparisonRange(curRange);
  const periodYear = getPeriodYear(curRange);

  // Fetch data
  const curData = getDataInRange(curRange.start, curRange.end);
  const curMetrics = calcMetrics(curData, periodYear);

  let cmpData = null, cmpMetrics = null;
  if (cmpRange) {
    const cmpPeriodYear = cmpRange.start.slice(0,4) === cmpRange.end.slice(0,4)
      ? cmpRange.start.slice(0,4) : null;
    cmpData = getDataInRange(cmpRange.start, cmpRange.end);
    cmpMetrics = calcMetrics(cmpData, cmpPeriodYear);
  }

  // KPI grid
  wrap.appendChild(buildKpiGrid(curMetrics, cmpMetrics, cmpRange));

  // Chart sections
  wrap.appendChild(makeChartSection('Business Trends', [
    ['Revenue',        'exec-trend-rev'],
    ['Operating Profit', 'exec-trend-profit'],
    ['Net Cash Flow',  'exec-trend-cashflow'],
  ]));

  wrap.appendChild(makeChartSection('Forecast & Margins', [
    ['Actual vs Forecast',  'exec-fc-actual'],
    ['Forecast Variance %', 'exec-fc-var-pct'],
    ['Operating Margin %',  'exec-margin-trend'],
  ]));

  wrap.appendChild(makeChartSection('Growth & Mix', [
    ['YoY Revenue Growth %', 'exec-rev-growth'],
    ['OpEx vs CapEx',        'exec-opex-capex'],
    ['Revenue vs Profit',    'exec-rev-vs-profit'],
  ]));

  wrap.appendChild(makeChartSection('Composition', [
    ['Revenue by Stream',     'exec-kd-rev-stream'],
    ['Revenue Concentration', 'exec-rev-conc'],
    ['Investment Breakdown',  'exec-inv-breakdown'],
  ]));

  wrap.appendChild(makeChartSection('Outstanding & Cash', [
    ['Outstanding Aging',  'exec-outstanding-aging'],
    ['Cash Flow Waterfall', 'exec-cashflow-wfall'],
    ['Expenses by Category','exec-kd-exp-cat'],
  ]));

  // Performance Insights
  wrap.appendChild(buildPerformanceInsights(curData, curMetrics));

  // Render all charts async
  setTimeout(() => {
    renderAllCharts(curData, curMetrics, cmpData, cmpMetrics, curRange, cmpRange);
  }, 0);

  return wrap;
}
