// Executive Analytics Dashboard
import { el, fmtDate, drillDownModal } from '../core/ui.js';
import * as charts from '../core/charts.js';
import { STREAMS, OWNERS, COST_CATEGORIES, EXPENSE_CATEGORIES } from '../core/config.js';
import {
  formatEUR, toEUR, byId,
  listActive, listActivePayments,
  isCapEx, drillRevRows, drillExpRows,
  forecastMonthlyEUR,
  sumPaymentsEUR, sumInvoicesEUR, sumExpensesEUR
} from '../core/data.js';
import {
  createFilterState, getCurrentPeriodRange, getComparisonRange,
  getMonthKeysForRange, makeMatchers, buildFilterBar, buildComparisonLine
} from './analytics-filters.js';

// ── Constants ────────────────────────────────────────────────────────────────
const ALL_CHART_IDS = [
  'exec-trend-rev','exec-trend-profit','exec-rev-per-prop',
  'exec-kd-rev-stream','exec-kd-exp-cat',
  'exec-fc-actual','exec-fc-var-pct','exec-opex-capex',
  'exec-rev-vs-profit','exec-rev-conc','exec-pending-pipeline',
  'exec-inv-breakdown','exec-outstanding-aging',
  'exec-booking-activity','exec-rev-growth'
];

// ── Filter State ─────────────────────────────────────────────────────────────
let gF = createFilterState();

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

function mixedRows(revPays, revInvs, expItems, acqItems = []) {
  return [
    ...drillRevRows(revPays, revInvs).map(r => ({
      date: r.date, kind: 'Revenue',
      source: r.source + (r.ref ? ' · ' + r.ref : ''), eur: r.eur
    })),
    ...drillExpRows(expItems).map(r => ({
      date: r.date, kind: 'Expense',
      source: (r.source ? r.source + ' · ' : '') + r.category, eur: r.eur
    })),
    ...acqItems.map(a => ({
      date: a.date, kind: 'CapEx',
      source: (a._name || '') + ' · Property Acquisition',
      eur: toEUR(a.amount, a.currency, a.date)
    }))
  ].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

// ── Virtual property acquisitions ────────────────────────────────────────────
function getVirtualAcquisitions() {
  return listActive('properties')
    .filter(p => p.purchasePrice > 0 && p.purchaseDate)
    .filter(p => {
      if (gF.owners.size > 0) {
        const ow = p.owner || 'both';
        if (ow !== 'both' && !gF.owners.has(ow)) return false;
      }
      if (gF.streams.size > 0) {
        const stream = p.type === 'short_term' ? 'short_term_rental'
                     : p.type === 'long_term'  ? 'long_term_rental'
                     : null;
        if (!stream || !gF.streams.has(stream)) return false;
      }
      if (gF.propertyIds.size > 0 && !gF.propertyIds.has(p.id)) return false;
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
  const { mStream, mOwner, mProperty } = makeMatchers(gF);

  const payments = listActivePayments().filter(p =>
    p.status === 'paid' && inRange(p.date) &&
    mStream(p) && mOwner(p) && mProperty(p)
  );
  const invoices = listActive('invoices').filter(i =>
    i.status === 'paid' && inRange(i.issueDate) &&
    mStream(i) && mOwner(i) && mProperty(i)
  );
  const allExpenses = listActive('expenses').filter(e =>
    inRange(e.date) && mOwner(e) && mProperty(e)
  );
  const opExpenses    = allExpenses.filter(e => !isCapEx(e) && mStream(e));
  const capExExpenses = allExpenses.filter(e =>  isCapEx(e) && mStream(e));

  const allAcq = getVirtualAcquisitions();
  const acquisitions = allAcq.filter(a => inRange(a.date));

  return { payments, invoices, opExpenses, capExExpenses, acquisitions };
}

// ── Metrics calculator ───────────────────────────────────────────────────────
function calcMetrics(data, range = null) {
  const { payments, invoices, opExpenses, capExExpenses, acquisitions } = data;

  const rev         = sumPaymentsEUR(payments) + sumInvoicesEUR(invoices);
  const opEx        = sumExpensesEUR(opExpenses);
  const capExFromExp = sumExpensesEUR(capExExpenses);
  const capExFromAcq = acquisitions.reduce((s, a) => s + toEUR(a.amount, a.currency, a.date), 0);
  const capEx       = capExFromExp + capExFromAcq;
  const opProfit    = rev - opEx;
  const opMargin    = rev > 0 ? (opProfit / rev) * 100 : null;
  const netCash      = opProfit - capEx;
  const expenseRatio = rev > 0 ? (opEx / rev) * 100 : null;

  // Airbnb booking stats (paid reservations in range)
  const airbnbRes = payments.filter(p => p.source === 'airbnb' && (p.airbnbType || '').toLowerCase() === 'reservation');
  const nightsBooked = airbnbRes.reduce((s, p) => s + (p.airbnbNights || 0), 0);
  const airbnbRevEUR = airbnbRes.reduce((s, p) => s + toEUR(p.amount, p.currency, p.date), 0);
  const avgBookingValue = airbnbRes.length > 0 ? airbnbRevEUR / airbnbRes.length : null;

  // Collection rate: paid invoices / all invoices (any status) issued in range
  let collectionRate = null;
  if (range) {
    const { mStream, mOwner, mProperty } = makeMatchers(gF);
    const allRangeInvs = listActive('invoices').filter(i =>
      (i.issueDate || '') >= range.start && (i.issueDate || '') <= range.end &&
      mStream(i) && mOwner(i) && mProperty(i)
    );
    const totalInvoiced = allRangeInvs.reduce((s, i) => s + toEUR(i.total, i.currency, i.issueDate), 0);
    if (totalInvoiced > 0) collectionRate = (sumInvoicesEUR(invoices) / totalInvoiced) * 100;
  }

  // Pending pipeline (all pending Airbnb reservations, not range-limited)
  const pendingReservations = listActivePayments().filter(p => {
    if (p.source !== 'airbnb' || p.status !== 'pending') return false;
    if (gF.propertyIds.size > 0 && !gF.propertyIds.has(p.propertyId)) return false;
    if (gF.streams.size > 0 && !gF.streams.has('short_term_rental')) return false;
    if (gF.owners.size > 0 && p.propertyId) {
      const prop = byId('properties', p.propertyId);
      const ow = prop?.owner || 'both';
      if (ow !== 'both' && !gF.owners.has(ow)) return false;
    }
    return true;
  });
  const pendingPipeline = pendingReservations.reduce((s, p) => s + toEUR(p.amount, p.currency || 'EUR', p.airbnbCheckIn || p.date), 0);

  // Outstanding = all currently open invoices (not range-limited), stream/owner/property filtered
  const outstanding = listActive('invoices').filter(i => {
    if (i.status !== 'sent' && i.status !== 'overdue') return false;
    if (gF.streams.size > 0 && i.stream && !gF.streams.has(i.stream)) return false;
    if (gF.owners.size > 0) {
      const prop = i.propertyId ? byId('properties', i.propertyId) : null;
      const ow = prop?.owner || i.owner || 'both';
      if (ow !== 'both' && !gF.owners.has(ow)) return false;
    }
    if (gF.propertyIds.size > 0 && i.propertyId && !gF.propertyIds.has(i.propertyId)) return false;
    return true;
  });
  const outstandingTotal = sumInvoicesEUR(outstanding);

  // Forecast: sum only the months that fall within this period's range so that
  // a "Jan 2026" filter shows only the January forecast, not the full year.
  let fcRev = null;
  if (range) {
    const startY = range.start.slice(0, 4);
    const endY   = range.end.slice(0, 4);
    if (startY === endY) {
      const fcMonthly = forecastMonthlyEUR(startY);
      if (fcMonthly.size > 0) {
        const { keys: months } = getMonthKeysForRange(range.start, range.end);
        const sum = months.reduce((s, m) => s + (fcMonthly.get(m.key) || 0), 0);
        if (sum > 0) fcRev = sum;
      }
    }
  }

  return {
    rev, opEx, capExFromExp, capExFromAcq, capEx,
    opProfit, opMargin, netCash, expenseRatio,
    nightsBooked, avgBookingValue, collectionRate,
    pendingReservations, pendingPipeline,
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

// ── KPI cards ─────────────────────────────────────────────────────────────────
function buildKpiGrid(curMetrics, cmpMetrics, cmpRange) {
  const { rev, opEx, capEx, opProfit, opMargin, netCash, outstandingTotal, fcRev,
          expenseRatio, nightsBooked, avgBookingValue, collectionRate, pendingPipeline,
          payments, invoices, opExpenses, capExExpenses, acquisitions, outstanding } = curMetrics;
  const cmpLabel = cmpRange?.label || '';

  const grid = el('div', {
    class: 'mb-16',
    style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px'
  });

  // 1. Revenue
  grid.appendChild(kpiCard({
    label: 'Revenue', value: formatEUR(rev),
    onClick: () => drillDownModal('Revenue Breakdown', drillRevRows(payments, invoices), REV_COLS),
    delta: cmpMetrics ? safePct(rev, cmpMetrics.rev) : null,
    invertDelta: false, compLabel: cmpLabel
  }));

  // 2. Forecast Revenue
  const fcDelta = (fcRev != null && fcRev > 0) ? safePct(rev, fcRev) : null;
  grid.appendChild(kpiCard({
    label: 'Forecast Revenue', value: fcRev != null ? formatEUR(fcRev) : '—',
    onClick: () => drillDownModal('Revenue Breakdown', drillRevRows(payments, invoices), REV_COLS),
    delta: fcDelta, invertDelta: false,
    compLabel: fcDelta !== null ? 'actual revenue' : '',
  }));

  // 3. Operating Expenses
  grid.appendChild(kpiCard({
    label: 'Operating Expenses', value: formatEUR(opEx),
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
    onClick: () => drillDownModal('Operating Profit', mixedRows(payments, invoices, opExpenses), MIXED_COLS),
    delta: (cmpMetrics && opMargin != null) ? safePp(opMargin, cmpMetrics.opMargin) : null,
    deltaIsPp: true, invertDelta: false, compLabel: cmpLabel
  }));

  // 6. Expense Ratio
  grid.appendChild(kpiCard({
    label: 'Expense Ratio',
    value: expenseRatio != null ? `${expenseRatio.toFixed(1)}%` : '—',
    onClick: () => drillDownModal('Operating Expenses', drillExpRows(opExpenses), EXP_COLS),
    delta: (cmpMetrics && expenseRatio != null) ? safePp(expenseRatio, cmpMetrics.expenseRatio) : null,
    deltaIsPp: true, invertDelta: true, compLabel: cmpLabel
  }));

  // 7. CapEx
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
    onClick: () => drillDownModal('Investments / CapEx', capExDrillRows, EXP_COLS),
    delta: (cmpMetrics && (capEx > 0 || cmpMetrics.capEx > 0)) ? safePct(capEx, cmpMetrics.capEx) : null,
    invertDelta: false, compLabel: cmpLabel
  }));

  // 8. Net Cash Flow
  grid.appendChild(kpiCard({
    label: 'Net Cash Flow', value: formatEUR(netCash),
    variant: netCash >= 0 ? 'success' : 'danger',
    onClick: () => drillDownModal('Cash Flow', mixedRows(payments, invoices, [...opExpenses, ...capExExpenses], acquisitions), MIXED_COLS),
    delta: cmpMetrics ? safePct(netCash, cmpMetrics.netCash) : null,
    invertDelta: false, compLabel: cmpLabel
  }));

  // 9. Outstanding
  grid.appendChild(kpiCard({
    label: 'Outstanding', value: formatEUR(outstandingTotal),
    variant: outstandingTotal > 0 ? 'warning' : '',
    onClick: () => drillDownModal('Outstanding Invoices', drillRevRows([], outstanding), REV_COLS),
    delta: cmpMetrics ? safePct(outstandingTotal, cmpMetrics.outstandingTotal) : null,
    invertDelta: true, compLabel: cmpLabel
  }));

  // 10. Pending Pipeline
  grid.appendChild(kpiCard({
    label: 'Pending Pipeline', value: formatEUR(pendingPipeline),
    variant: pendingPipeline > 0 ? 'info' : '',
    onClick: () => {
      const cols = [
        { key: 'date', label: 'Check-in', format: v => v ? v.slice(0,10) : '—' },
        { key: 'guest', label: 'Guest' },
        { key: 'nights', label: 'Nights', right: true },
        { key: 'eur', label: 'Amount', right: true, format: v => formatEUR(v) }
      ];
      const rows = curMetrics.pendingReservations.map(p => ({
        date: p.airbnbCheckIn || p.date,
        guest: (p.notes || '').split(' · ')[0] || '—',
        nights: p.airbnbNights || 0,
        eur: toEUR(p.amount, p.currency || 'EUR', p.airbnbCheckIn || p.date)
      })).sort((a, b) => (a.date || '').localeCompare(b.date || ''));
      drillDownModal('Pending Pipeline — Upcoming Reservations', rows, cols);
    },
    delta: null, compLabel: ''
  }));

  // 11. Nights Booked
  grid.appendChild(kpiCard({
    label: 'Nights Booked', value: nightsBooked > 0 ? String(nightsBooked) : '—',
    onClick: () => {
      const res = payments.filter(p => p.source === 'airbnb' && (p.airbnbType || '').toLowerCase() === 'reservation');
      drillDownModal('Nights Booked', drillRevRows(res, []), REV_COLS);
    },
    delta: cmpMetrics && nightsBooked > 0 ? safePct(nightsBooked, cmpMetrics.nightsBooked) : null,
    invertDelta: false, compLabel: cmpLabel
  }));

  // 12. Avg Booking Value
  grid.appendChild(kpiCard({
    label: 'Avg Booking Value', value: avgBookingValue != null ? formatEUR(avgBookingValue) : '—',
    onClick: () => {
      const res = payments.filter(p => p.source === 'airbnb' && (p.airbnbType || '').toLowerCase() === 'reservation');
      drillDownModal('Airbnb Reservations', drillRevRows(res, []), REV_COLS);
    },
    delta: (cmpMetrics && avgBookingValue != null && cmpMetrics.avgBookingValue != null)
      ? safePct(avgBookingValue, cmpMetrics.avgBookingValue) : null,
    invertDelta: false, compLabel: cmpLabel
  }));

  // 13. Collection Rate
  grid.appendChild(kpiCard({
    label: 'Collection Rate', value: collectionRate != null ? `${collectionRate.toFixed(1)}%` : '—',
    variant: collectionRate != null ? (collectionRate >= 90 ? 'success' : collectionRate >= 70 ? '' : 'warning') : '',
    onClick: () => drillDownModal('Collected Invoices', drillRevRows([], invoices), REV_COLS),
    delta: (cmpMetrics && collectionRate != null && cmpMetrics.collectionRate != null)
      ? safePp(collectionRate, cmpMetrics.collectionRate) : null,
    deltaIsPp: true, invertDelta: false, compLabel: cmpLabel
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
  for (const [panelTitle, canvasId, opts] of panels) {
    const panel = el('div');
    const labelRow = el('div', { style: 'display:flex;align-items:center;justify-content:space-between;margin-bottom:8px' },
      el('div', { class: 'kpi-label' }, panelTitle)
    );
    if (opts?.isDoughnut) {
      const btn = el('button', { style: 'background:none;border:1px solid var(--border);border-radius:4px;color:var(--text-muted);font-size:11px;cursor:pointer;padding:2px 6px;line-height:1' }, '%');
      btn.onclick = () => { const sp = charts.toggleDoughnutPct(canvasId); btn.textContent = sp ? '€' : '%'; };
      labelRow.appendChild(btn);
    }
    panel.appendChild(labelRow);
    panel.appendChild(el('div', { class: 'chart-wrap' }, el('canvas', { id: canvasId })));
    grid.appendChild(panel);
  }
  card.appendChild(grid);
  return card;
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

  // exec-rev-per-prop (Revenue per Property — horizontal bar)
  {
    const propMap = new Map();
    curData.payments.forEach(p => {
      const prop = byId('properties', p.propertyId);
      const key = p.propertyId || 'unknown';
      if (!propMap.has(key)) propMap.set(key, { name: prop?.name || 'Unknown', rev: 0, pays: [] });
      const e = propMap.get(key);
      e.rev += toEUR(p.amount, p.currency, p.date);
      e.pays.push(p);
    });
    const propEntries = [...propMap.values()].sort((a, b) => b.rev - a.rev);
    if (propEntries.length) {
      const propColors = ['#10b981','#3b82f6','#8b5cf6','#f59e0b','#ec4899','#14b8a6','#ef4444','#6366f1'];
      charts.bar('exec-rev-per-prop', {
        labels: propEntries.map(e => e.name),
        horizontal: true,
        datasets: [{ label: 'Revenue', data: propEntries.map(e => Math.round(e.rev)), backgroundColor: propEntries.map((_, i) => propColors[i % propColors.length]) }],
        onClickItem: (_label, idx) => {
          const entity = propEntries[idx];
          drillDownModal(`Revenue — ${entity.name}`, drillRevRows(entity.pays, []), REV_COLS);
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
        ],
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
        }],
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

  // exec-booking-activity (Nights Booked per Month)
  {
    const bookingMap = new Map();
    curData.payments.filter(p => p.source === 'airbnb' && (p.airbnbType || '').toLowerCase() === 'reservation').forEach(p => {
      const mk = p.date?.slice(0, 7);
      if (!mk) return;
      const e = bookingMap.get(mk) || { nights: 0, pays: [] };
      e.nights += p.airbnbNights || 0;
      e.pays.push(p);
      bookingMap.set(mk, e);
    });
    const bookingData = months.map(m => bookingMap.get(m.key)?.nights || 0);
    if (bookingData.some(v => v > 0)) {
      charts.bar('exec-booking-activity', {
        labels,
        datasets: [{ label: 'Nights Booked', data: bookingData, backgroundColor: '#8b5cf6' }],
        onClickItem: (_label, idx) => {
          const mk = months[idx]?.key;
          const entry = bookingMap.get(mk);
          if (!entry?.pays.length) return;
          drillDownModal(`${months[idx].label} — Bookings`, drillRevRows(entry.pays, []), REV_COLS);
        }
      });
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
      if (gF.propertyIds.size > 0 && p.propertyId && !gF.propertyIds.has(p.propertyId)) return false;
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
      if (gF.propertyIds.size > 0 && i.propertyId && !gF.propertyIds.has(i.propertyId)) return false;
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
        }],
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

  // exec-opex-capex (stacked bar)
  if (opExData.some(v => v > 0) || capExData.some(v => v > 0)) {
    charts.bar('exec-opex-capex', {
      labels,
      stacked: true,
      datasets: [
        { label: 'OpEx', data: opExData, backgroundColor: '#ef4444' },
        { label: 'CapEx', data: capExData, backgroundColor: '#f59e0b' }
      ],
      onClickItem: (label, idx, dsIdx) => {
        const mk = months[idx]?.key;
        if (!mk) return;
        const mLabel = months[idx].label;
        if (dsIdx === 1) {
          const mCapEx = curData.capExExpenses.filter(e => e.date?.slice(0,7) === mk);
          const mAcq   = curData.acquisitions.filter(a => a.date?.slice(0,7) === mk);
          const rows   = [
            ...drillExpRows(mCapEx),
            ...mAcq.map(a => ({ date: a.date, source: a._name || '', category: 'Acquisition', description: a.description, eur: toEUR(a.amount, a.currency, a.date) }))
          ].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
          drillDownModal(`${mLabel} — CapEx`, rows, EXP_COLS);
        } else {
          drillDownModal(`${mLabel} — OpEx`,
            drillExpRows(curData.opExpenses.filter(e => e.date?.slice(0,7) === mk)),
            EXP_COLS);
        }
      }
    });
  }

  // exec-rev-vs-profit (grouped bar)
  if (revData.some(v => v > 0) || profData.some(v => v !== 0)) {
    charts.bar('exec-rev-vs-profit', {
      labels,
      datasets: [
        { label: 'Revenue', data: revData, backgroundColor: '#10b981' },
        { label: 'Op. Profit', data: profData, backgroundColor: '#3b82f6' }
      ],
      onClickItem: (label, idx, dsIdx) => {
        const mk = months[idx]?.key;
        if (!mk) return;
        const mLabel = months[idx].label;
        if (dsIdx === 0) {
          drillDownModal(`${mLabel} — Revenue`,
            drillRevRows(curData.payments.filter(p => p.date?.slice(0,7) === mk),
                         curData.invoices.filter(i => (i.issueDate||'').slice(0,7) === mk)),
            REV_COLS);
        } else {
          drillDownModal(`${mLabel} — Operating Profit`,
            mixedRows(curData.payments.filter(p => p.date?.slice(0,7) === mk),
                      curData.invoices.filter(i => (i.issueDate||'').slice(0,7) === mk),
                      curData.opExpenses.filter(e => e.date?.slice(0,7) === mk)),
            MIXED_COLS);
        }
      }
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
      const agingRanges = [[0,30],[31,60],[61,90],[91,Infinity]];
      const agingLabels = ['Current (0-30d)', '31-60 days', '61-90 days', '90+ days'];
      charts.bar('exec-outstanding-aging', {
        labels: agingLabels,
        horizontal: true,
        datasets: [{
          label: 'Outstanding',
          data: buckets.map(v => Math.round(v)),
          backgroundColor: ['#3b82f6','#f59e0b','#f59e0b','#ef4444']
        }],
        onClickItem: (label, idx) => {
          const [minDays, maxDays] = agingRanges[idx];
          const filtered = curMetrics.outstanding.filter(i => {
            const days = Math.floor((Date.now() - new Date(i.issueDate).getTime()) / 86400000);
            return days >= minDays && days <= maxDays;
          });
          drillDownModal(`Outstanding — ${agingLabels[idx]}`, drillRevRows([], filtered), REV_COLS);
        }
      });
    }
  }

  // exec-pending-pipeline (upcoming pending reservations by check-in month)
  {
    const todayMk = new Date().toISOString().slice(0, 7);
    const futureMonths = [];
    const fd = new Date();
    const MONTH_NAMES_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    for (let i = 0; i < 9; i++) {
      futureMonths.push({
        key: `${fd.getFullYear()}-${String(fd.getMonth() + 1).padStart(2, '0')}`,
        label: `${MONTH_NAMES_SHORT[fd.getMonth()]} ${fd.getFullYear()}`
      });
      fd.setMonth(fd.getMonth() + 1);
    }
    const pipeMap = new Map();
    curMetrics.pendingReservations.forEach(p => {
      const mk = (p.airbnbCheckIn || p.date || '').slice(0, 7);
      if (!mk) return;
      const e = pipeMap.get(mk) || { total: 0, pays: [] };
      e.total += toEUR(p.amount, p.currency || 'EUR', p.airbnbCheckIn || p.date);
      e.pays.push(p);
      pipeMap.set(mk, e);
    });
    const pipeData = futureMonths.map(m => Math.round(pipeMap.get(m.key)?.total || 0));
    if (pipeData.some(v => v > 0)) {
      charts.bar('exec-pending-pipeline', {
        labels: futureMonths.map(m => m.label),
        datasets: [{ label: 'Pending Revenue', data: pipeData, backgroundColor: '#6366f1' }],
        onClickItem: (_label, idx) => {
          const entry = pipeMap.get(futureMonths[idx].key);
          if (!entry?.pays.length) return;
          drillDownModal(`Pending Pipeline — ${futureMonths[idx].label}`, drillRevRows(entry.pays, []), REV_COLS);
        }
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
  wrap.appendChild(buildFilterBar(gF, { showOwner: true, showStream: true, showProperty: true, storagePrefix: 'ana_exec' }, (newGF) => { if (newGF) gF = newGF; rebuildView(); }));

  // Compute ranges
  const curRange = getCurrentPeriodRange(gF);
  const cmpRange = getComparisonRange(gF, curRange);
  wrap.appendChild(buildComparisonLine(curRange, cmpRange));

  // Fetch data
  const curData = getDataInRange(curRange.start, curRange.end);
  const curMetrics = calcMetrics(curData, curRange);

  let cmpData = null, cmpMetrics = null;
  if (cmpRange) {
    cmpData = getDataInRange(cmpRange.start, cmpRange.end);
    cmpMetrics = calcMetrics(cmpData, cmpRange);
  }

  // KPI grid
  wrap.appendChild(buildKpiGrid(curMetrics, cmpMetrics, cmpRange));

  // Chart sections
  wrap.appendChild(makeChartSection('Business Trends', [
    ['Revenue',            'exec-trend-rev'],
    ['Operating Profit',   'exec-trend-profit'],
    ['Revenue per Property', 'exec-rev-per-prop'],
  ]));

  wrap.appendChild(makeChartSection('Forecast & Margins', [
    ['Actual vs Forecast',  'exec-fc-actual'],
    ['Forecast Variance %', 'exec-fc-var-pct'],
    ['Booking Activity (Nights)', 'exec-booking-activity'],
  ]));

  wrap.appendChild(makeChartSection('Growth & Mix', [
    ['YoY Revenue Growth %', 'exec-rev-growth'],
    ['OpEx vs CapEx',        'exec-opex-capex'],
    ['Revenue vs Profit',    'exec-rev-vs-profit'],
  ]));

  wrap.appendChild(makeChartSection('Composition', [
    ['Revenue by Stream',     'exec-kd-rev-stream', { isDoughnut: true }],
    ['Revenue Concentration', 'exec-rev-conc',      { isDoughnut: true }],
    ['Investment Breakdown',  'exec-inv-breakdown', { isDoughnut: true }],
  ]));

  wrap.appendChild(makeChartSection('Outstanding & Cash', [
    ['Outstanding Aging',     'exec-outstanding-aging'],
    ['Pending Pipeline',      'exec-pending-pipeline'],
    ['Expenses by Category',  'exec-kd-exp-cat', { isDoughnut: true }],
  ]));

  // Performance Insights
  wrap.appendChild(buildPerformanceInsights(curData, curMetrics));

  // Render all charts async
  setTimeout(() => {
    renderAllCharts(curData, curMetrics, cmpData, cmpMetrics, curRange, cmpRange);
  }, 0);

  return wrap;
}
