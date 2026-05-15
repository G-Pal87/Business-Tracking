// Analysis Forecast Dashboard — forecast vs actual performance reporting
import { el, fmtDate, drillDownModal } from '../core/ui.js';
import * as charts from '../core/charts.js';
import { STREAMS } from '../core/config.js';
import {
  formatEUR, toEUR, byId,
  listActive, listActivePayments,
  isCapEx, drillRevRows, drillExpRows,
  sumPaymentsEUR, sumInvoicesEUR, sumExpensesEUR
} from '../core/data.js';
import {
  createFilterState, getCurrentPeriodRange, getComparisonRange,
  getMonthKeysForRange, makeMatchers, resolveStream,
  buildFilterBar, buildComparisonLine
} from './analytics-filters.js';

// ── Constants ─────────────────────────────────────────────────────────────────
const CHART_IDS = [
  'anf-fc-actual', 'anf-fc-var-pct', 'anf-net-compare',
  'anf-stream-rev', 'anf-stream-compare', 'anf-prop-compare',
  'anf-pending-pipeline', 'anf-pending-by-prop'
];

const REV_COLS = [
  { key: 'date',   label: 'Date',   format: v => fmtDate(v) },
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

// ── Filter state ──────────────────────────────────────────────────────────────
let gF = createFilterState();

// ── Module export ─────────────────────────────────────────────────────────────
export default {
  id: 'analytics-forecast', label: 'Forecast', icon: '◈',
  render(container) { container.appendChild(buildView()); },
  refresh() { rebuildView(); },
  destroy() { CHART_IDS.forEach(id => charts.destroy(id)); }
};

// ── View lifecycle ────────────────────────────────────────────────────────────
function rebuildView() {
  CHART_IDS.forEach(id => charts.destroy(id));
  const c = document.getElementById('content');
  if (!c) return;
  c.innerHTML = '';
  c.appendChild(buildView());
}

// ── Safe variance helpers ─────────────────────────────────────────────────────
function safeVariancePct(actual, forecast) {
  if (!isFinite(actual) || !isFinite(forecast)) return null;
  if (forecast === 0 && actual === 0) return 0;
  if (forecast === 0) return null;
  const p = ((actual - forecast) / Math.abs(forecast)) * 100;
  return isFinite(p) ? p : null;
}

function fmtVarPct(actual, forecast) {
  const p = safeVariancePct(actual, forecast);
  if (p === null) return actual > 0 ? 'N/A' : '—';
  return (p >= 0 ? '+' : '') + p.toFixed(1) + '%';
}

function fmtVar(actual, forecast) {
  const v = actual - forecast;
  return (v >= 0 ? '+' : '') + formatEUR(v);
}

function safePct(cur, prev) {
  if (!isFinite(prev) || prev === 0) return null;
  const p = ((cur - prev) / Math.abs(prev)) * 100;
  return isFinite(p) ? p : null;
}

// ── Forecast stream resolver ──────────────────────────────────────────────────
function resolveFcStream(fc) {
  if (fc.type === 'service') return fc.entityId;
  const p = byId('properties', fc.entityId);
  if (!p) return null;
  return p.type === 'short_term' ? 'short_term_rental'
       : p.type === 'long_term'  ? 'long_term_rental' : null;
}

// ── Forecast map builder (filtered, multi-year) ───────────────────────────────
// Returns Map<YYYY-MM, EUR> for revenue and expenses, respecting gF filters.
function buildFcMaps(startY, endY) {
  const fcMonthlyRev = new Map();
  const fcMonthlyExp = new Map();
  const allFcs = listActive('forecasts');

  for (let y = startY; y <= endY; y++) {
    allFcs.filter(fc => fc.year === y).forEach(fc => {
      if (gF.propertyIds.size > 0 && fc.type === 'property' && !gF.propertyIds.has(fc.entityId)) return;
      if (gF.streams.size > 0) {
        const s = resolveFcStream(fc);
        if (!s || !gF.streams.has(s)) return;
      }
      if (gF.owners.size > 0 && fc.type === 'property') {
        const prop = byId('properties', fc.entityId);
        const ow = prop?.owner || 'both';
        if (ow !== 'both' && !gF.owners.has(ow)) return;
      }
      Object.entries(fc.months || {}).forEach(([mk, md]) => {
        const entries = Array.isArray(md.entries) ? md.entries : [];
        const rev = entries.length > 0
          ? entries.reduce((s, e) => s + (Number(e.amount) || 0), 0)
          : Number(md.revenue) || 0;
        if (rev > 0) fcMonthlyRev.set(mk, (fcMonthlyRev.get(mk) || 0) + rev);
        const exp = Number(md.expenses) || 0;
        if (exp > 0) fcMonthlyExp.set(mk, (fcMonthlyExp.get(mk) || 0) + exp);
      });
    });
  }
  return { fcMonthlyRev, fcMonthlyExp };
}

// ── Core data calculation ─────────────────────────────────────────────────────
function calculateDashboardData(range) {
  if (!range) return null;
  const { mStream, mOwner, mProperty, mClient } = makeMatchers(gF);
  const inRange = d => d && d >= range.start && d <= range.end;

  const actPayments = listActivePayments().filter(p =>
    p.status === 'paid' && inRange(p.date) && mStream(p) && mOwner(p) && mProperty(p)
  );
  const actInvoices = listActive('invoices').filter(i =>
    i.status === 'paid' && inRange(i.issueDate) && mStream(i) && mOwner(i) && mProperty(i) && mClient(i)
  );
  const allExpenses = listActive('expenses').filter(e => inRange(e.date) && mOwner(e) && mProperty(e));
  const actOpExpenses = allExpenses.filter(e => !isCapEx(e) && mStream(e));

  const actualRev = sumPaymentsEUR(actPayments) + sumInvoicesEUR(actInvoices);
  const actualExp = sumExpensesEUR(actOpExpenses);
  const actualNet = actualRev - actualExp;

  const { keys: months } = getMonthKeysForRange(range.start, range.end);
  const startY = parseInt(range.start.slice(0, 4));
  const endY   = parseInt(range.end.slice(0, 4));
  const { fcMonthlyRev, fcMonthlyExp } = buildFcMaps(startY, endY);

  let forecastRev = 0, forecastExp = 0;
  months.forEach(m => {
    forecastRev += fcMonthlyRev.get(m.key) || 0;
    forecastExp += fcMonthlyExp.get(m.key) || 0;
  });
  const forecastNet = forecastRev - forecastExp;
  const variance    = actualRev - forecastRev;
  const variancePct = safeVariancePct(actualRev, forecastRev);

  // Pending pipeline — not range-limited, entity-filtered
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
  const pendingPipeline = pendingReservations.reduce(
    (s, p) => s + toEUR(p.amount, p.currency || 'EUR', p.airbnbCheckIn || p.date), 0
  );

  // Pre-group payments/invoices/expenses by month key for efficiency
  const paysByMk = new Map(), invsByMk = new Map(), expsByMk = new Map();
  actPayments.forEach(p => { const mk = (p.date || '').slice(0,7); paysByMk.set(mk, [...(paysByMk.get(mk)||[]), p]); });
  actInvoices.forEach(i => { const mk = (i.issueDate||'').slice(0,7); invsByMk.set(mk, [...(invsByMk.get(mk)||[]), i]); });
  actOpExpenses.forEach(e => { const mk = (e.date||'').slice(0,7); expsByMk.set(mk, [...(expsByMk.get(mk)||[]), e]); });

  const monthlyBreakdown = months.map(m => {
    const mk = m.key;
    const mPays = paysByMk.get(mk) || [];
    const mInvs = invsByMk.get(mk) || [];
    const mExps = expsByMk.get(mk) || [];
    const mActRev = sumPaymentsEUR(mPays) + sumInvoicesEUR(mInvs);
    const mActExp = sumExpensesEUR(mExps);
    const mFcRev  = fcMonthlyRev.get(mk) || 0;
    const mFcExp  = fcMonthlyExp.get(mk) || 0;
    return {
      label: m.label, key: mk,
      fcRev: mFcRev, actRev: mActRev,
      variance: mActRev - mFcRev, variancePct: safeVariancePct(mActRev, mFcRev),
      fcExp: mFcExp, actExp: mActExp,
      fcNet: mFcRev - mFcExp, actNet: mActRev - mActExp,
      payments: mPays, invoices: mInvs, expenses: mExps
    };
  });

  const streamBreakdown  = computeStreamBreakdown(actPayments, actInvoices, months);
  const propertyBreakdown = computePropertyBreakdown(actPayments, months, pendingReservations);

  return {
    actualRev, actualExp, actualNet,
    forecastRev, forecastExp, forecastNet,
    variance, variancePct,
    pendingPipeline, pendingReservations,
    actPayments, actInvoices, actOpExpenses,
    months, fcMonthlyRev, fcMonthlyExp,
    monthlyBreakdown, streamBreakdown, propertyBreakdown
  };
}

function computeStreamBreakdown(actPayments, actInvoices, months) {
  const actByStream = new Map();
  actPayments.forEach(p => {
    const s = resolveStream(p) || 'other';
    actByStream.set(s, (actByStream.get(s) || 0) + toEUR(p.amount, p.currency, p.date));
  });
  actInvoices.forEach(i => {
    const s = resolveStream(i) || 'other';
    actByStream.set(s, (actByStream.get(s) || 0) + toEUR(i.total || i.amount, i.currency, i.issueDate || i.date));
  });

  // Pre-group forecasts by year
  const fcsByYear = new Map();
  listActive('forecasts').forEach(fc => {
    const arr = fcsByYear.get(fc.year) || [];
    arr.push(fc);
    fcsByYear.set(fc.year, arr);
  });

  const fcByStream = new Map();
  months.forEach(m => {
    const mk = m.key;
    const fcYear = parseInt(mk.slice(0, 4));
    (fcsByYear.get(fcYear) || []).forEach(fc => {
      if (gF.propertyIds.size > 0 && fc.type === 'property' && !gF.propertyIds.has(fc.entityId)) return;
      const stream = resolveFcStream(fc);
      if (!stream) return;
      if (gF.streams.size > 0 && !gF.streams.has(stream)) return;
      const md = fc.months?.[mk];
      if (!md) return;
      const entries = Array.isArray(md.entries) ? md.entries : [];
      const val = entries.length > 0
        ? entries.reduce((s, e) => s + (Number(e.amount) || 0), 0)
        : Number(md.revenue) || 0;
      if (val > 0) fcByStream.set(stream, (fcByStream.get(stream) || 0) + val);
    });
  });

  const allStreams = new Set([...actByStream.keys(), ...fcByStream.keys()]);
  return [...allStreams].map(s => {
    const act = actByStream.get(s) || 0;
    const fc  = fcByStream.get(s)  || 0;
    return { key: s, label: STREAMS[s]?.label || s, actRev: act, fcRev: fc, variance: act - fc, variancePct: safeVariancePct(act, fc) };
  }).sort((a, b) => b.actRev - a.actRev);
}

function computePropertyBreakdown(actPayments, months, pendingReservations) {
  const actByProp = new Map();
  actPayments.forEach(p => {
    if (!p.propertyId) return;
    actByProp.set(p.propertyId, (actByProp.get(p.propertyId) || 0) + toEUR(p.amount, p.currency, p.date));
  });

  const fcsByYear = new Map();
  listActive('forecasts').filter(fc => fc.type === 'property').forEach(fc => {
    const arr = fcsByYear.get(fc.year) || [];
    arr.push(fc);
    fcsByYear.set(fc.year, arr);
  });

  const fcByProp = new Map();
  months.forEach(m => {
    const mk = m.key;
    const fcYear = parseInt(mk.slice(0, 4));
    (fcsByYear.get(fcYear) || []).forEach(fc => {
      if (gF.propertyIds.size > 0 && !gF.propertyIds.has(fc.entityId)) return;
      if (gF.owners.size > 0) {
        const p = byId('properties', fc.entityId);
        const ow = p?.owner || 'both';
        if (ow !== 'both' && !gF.owners.has(ow)) return;
      }
      if (gF.streams.size > 0) {
        const s = resolveFcStream(fc);
        if (!s || !gF.streams.has(s)) return;
      }
      const md = fc.months?.[mk];
      if (!md) return;
      const entries = Array.isArray(md.entries) ? md.entries : [];
      const val = entries.length > 0
        ? entries.reduce((s, e) => s + (Number(e.amount) || 0), 0)
        : Number(md.revenue) || 0;
      if (val > 0) fcByProp.set(fc.entityId, (fcByProp.get(fc.entityId) || 0) + val);
    });
  });

  const pendingByProp = new Map();
  pendingReservations.forEach(p => {
    if (!p.propertyId) return;
    pendingByProp.set(p.propertyId, (pendingByProp.get(p.propertyId) || 0) + toEUR(p.amount, p.currency || 'EUR', p.airbnbCheckIn || p.date));
  });

  const allPropIds = new Set([...actByProp.keys(), ...fcByProp.keys()]);
  return [...allPropIds].map(propId => {
    const prop = byId('properties', propId);
    const act  = actByProp.get(propId) || 0;
    const fc   = fcByProp.get(propId)  || 0;
    return { propId, label: prop?.name || propId, actRev: act, fcRev: fc, variance: act - fc, variancePct: safeVariancePct(act, fc), pending: pendingByProp.get(propId) || 0 };
  }).sort((a, b) => b.actRev - a.actRev);
}

// ── KPI card ──────────────────────────────────────────────────────────────────
function kpiCard({ label, value, variant, onClick, delta, deltaIsPp, invertDelta, compLabel }) {
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
  const trendDiv = el('div', { class: 'kpi-trend' });
  if (delta === null || delta === undefined || !isFinite(delta)) {
    trendDiv.appendChild(el('span', { style: 'color:var(--text-muted);font-size:11px' }, 'N/A'));
    if (compLabel) trendDiv.appendChild(document.createTextNode(` vs ${compLabel}`));
  } else {
    const sign = delta > 0 ? '+' : '';
    const display = deltaIsPp ? `${sign}${delta.toFixed(1)} pp` : `${sign}${delta.toFixed(1)}%`;
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

// ── Drill columns for monthly modal ──────────────────────────────────────────
const MO_COLS = [
  { key: 'month', label: 'Month' },
  { key: 'fcRev', label: 'Forecast',  right: true },
  { key: 'actRev',label: 'Actual',    right: true },
  { key: 'var',   label: 'Variance',  right: true },
  { key: 'pct',   label: 'Var %',     right: true }
];
function monthDrillRows(monthlyBreakdown) {
  return monthlyBreakdown
    .filter(m => m.fcRev > 0 || m.actRev > 0)
    .map(m => ({
      month:  m.label,
      fcRev:  formatEUR(m.fcRev),
      actRev: formatEUR(m.actRev),
      var:    fmtVar(m.actRev, m.fcRev),
      pct:    fmtVarPct(m.actRev, m.fcRev)
    }));
}

// ── KPI grid ──────────────────────────────────────────────────────────────────
function buildKpiGrid(data, cmpData, cmpRange) {
  const {
    actualRev, actualExp, actualNet,
    forecastRev, forecastExp, forecastNet,
    variance, pendingPipeline, pendingReservations,
    actPayments, actInvoices, actOpExpenses, monthlyBreakdown
  } = data;
  const cmpLabel = cmpRange?.label || '';

  const grid = el('div', {
    class: 'mb-16',
    style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px'
  });

  const varVariant = variance > 0 ? 'success' : variance < 0 ? 'danger' : '';

  // 1. Forecast Revenue
  grid.appendChild(kpiCard({
    label: 'Forecast Revenue',
    value: forecastRev > 0 ? formatEUR(forecastRev) : '—',
    onClick: () => drillDownModal('Monthly Forecast', monthDrillRows(monthlyBreakdown), MO_COLS),
    delta: cmpData ? safePct(forecastRev, cmpData.forecastRev) : null,
    invertDelta: false, compLabel: cmpLabel
  }));

  // 2. Actual Revenue
  grid.appendChild(kpiCard({
    label: 'Actual Revenue',
    value: formatEUR(actualRev),
    onClick: () => drillDownModal('Actual Revenue', drillRevRows(actPayments, actInvoices), REV_COLS),
    delta: cmpData ? safePct(actualRev, cmpData.actualRev) : null,
    invertDelta: false, compLabel: cmpLabel
  }));

  // 3. Forecast Variance
  grid.appendChild(kpiCard({
    label: 'Forecast Variance',
    value: forecastRev > 0 ? fmtVar(actualRev, forecastRev) : '—',
    variant: varVariant,
    onClick: () => drillDownModal('Monthly Forecast', monthDrillRows(monthlyBreakdown), MO_COLS),
    delta: null, compLabel: ''
  }));

  // 4. Forecast Variance %
  const varPctStr = forecastRev > 0
    ? fmtVarPct(actualRev, forecastRev)
    : (actualRev > 0 ? 'No forecast' : '—');
  grid.appendChild(kpiCard({
    label: 'Forecast Variance %',
    value: varPctStr,
    variant: varVariant,
    onClick: () => drillDownModal('Monthly Forecast', monthDrillRows(monthlyBreakdown), MO_COLS),
    delta: null, compLabel: ''
  }));

  // 5. Forecast Expenses
  grid.appendChild(kpiCard({
    label: 'Forecast Expenses',
    value: forecastExp > 0 ? formatEUR(forecastExp) : '—',
    onClick: () => drillDownModal('Actual Expenses', drillExpRows(actOpExpenses), EXP_COLS),
    delta: cmpData ? safePct(forecastExp, cmpData.forecastExp) : null,
    invertDelta: true, compLabel: cmpLabel
  }));

  // 6. Actual Expenses
  grid.appendChild(kpiCard({
    label: 'Actual Expenses',
    value: formatEUR(actualExp),
    onClick: () => drillDownModal('Actual Expenses', drillExpRows(actOpExpenses), EXP_COLS),
    delta: cmpData ? safePct(actualExp, cmpData.actualExp) : null,
    invertDelta: true, compLabel: cmpLabel
  }));

  // 7. Forecast Net
  grid.appendChild(kpiCard({
    label: 'Forecast Net',
    value: forecastNet !== 0 || forecastRev > 0 ? formatEUR(forecastNet) : '—',
    variant: forecastNet >= 0 ? 'success' : 'danger',
    onClick: () => drillDownModal('Monthly Forecast', monthDrillRows(monthlyBreakdown), MO_COLS),
    delta: cmpData ? safePct(forecastNet, cmpData.forecastNet) : null,
    invertDelta: false, compLabel: cmpLabel
  }));

  // 8. Actual Net
  grid.appendChild(kpiCard({
    label: 'Actual Net',
    value: formatEUR(actualNet),
    variant: actualNet >= 0 ? 'success' : 'danger',
    onClick: () => drillDownModal('Actual Revenue', drillRevRows(actPayments, actInvoices), REV_COLS),
    delta: cmpData ? safePct(actualNet, cmpData.actualNet) : null,
    invertDelta: false, compLabel: cmpLabel
  }));

  // 9. Pending Pipeline
  grid.appendChild(kpiCard({
    label: 'Pending Pipeline',
    value: pendingPipeline > 0 ? formatEUR(pendingPipeline) : '—',
    variant: pendingPipeline > 0 ? 'info' : '',
    onClick: () => {
      const rows = pendingReservations.map(p => ({
        prop:    byId('properties', p.propertyId)?.name || '—',
        code:    p.confirmationCode || p.airbnbRef || '—',
        guest:   (p.notes || '').split(' · ')[0] || '—',
        checkIn: p.airbnbCheckIn || '—',
        nights:  String(p.airbnbNights || '—'),
        eur:     toEUR(p.amount, p.currency || 'EUR', p.airbnbCheckIn || p.date)
      })).sort((a, b) => (a.checkIn || '').localeCompare(b.checkIn || ''));
      drillDownModal('Pending Pipeline', rows, [
        { key: 'prop',    label: 'Property' },
        { key: 'code',    label: 'Confirmation' },
        { key: 'guest',   label: 'Guest' },
        { key: 'checkIn', label: 'Check-in' },
        { key: 'nights',  label: 'Nights',  right: true },
        { key: 'eur',     label: 'Amount',  right: true, format: v => formatEUR(v) }
      ]);
    },
    delta: cmpData ? safePct(pendingPipeline, cmpData.pendingPipeline) : null,
    invertDelta: false, compLabel: cmpLabel
  }));

  return grid;
}

// ── Chart section builder (matches Executive Dashboard pattern) ───────────────
function makeChartSection(title, panels) {
  const card = el('div', { class: 'card mb-16' });
  card.appendChild(el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, title)));
  const grid = el('div', { style: 'display:grid;grid-template-columns:repeat(3,1fr);gap:16px;padding:0 16px 16px' });
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

// ── Table helpers ─────────────────────────────────────────────────────────────
function makeTable(cols, rows, emptyMsg) {
  if (!rows.length) {
    return el('p', { style: 'color:var(--text-muted);padding:12px 0;margin:0' }, emptyMsg || 'No data.');
  }
  const tbl = el('table', { class: 'table', style: 'width:100%' });
  const thead = el('thead');
  const hr = el('tr');
  cols.forEach(c => hr.appendChild(el('th', { class: c.right ? 'right' : '' }, c.label)));
  thead.appendChild(hr);
  tbl.appendChild(thead);
  const tbody = el('tbody');
  rows.forEach(row => {
    const tr = el('tr');
    cols.forEach(c => {
      const val = row[c.key];
      const disp = c.format ? c.format(val) : (val === null || val === undefined ? '—' : String(val));
      tr.appendChild(el('td', { class: c.right ? 'right' : '' }, disp));
    });
    tbody.appendChild(tr);
  });
  tbl.appendChild(tbody);
  return tbl;
}

function cardSection(title, content) {
  const card = el('div', { class: 'card mb-16' });
  card.appendChild(el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, title)));
  const body = el('div', { style: 'padding:0 16px 16px' });
  body.appendChild(content);
  card.appendChild(body);
  return card;
}

// ── Breakdown tables ──────────────────────────────────────────────────────────
function buildMonthlyTable(data) {
  const rows = data.monthlyBreakdown
    .filter(m => m.fcRev > 0 || m.actRev > 0 || m.fcExp > 0 || m.actExp > 0)
    .map(m => ({
      label:   m.label,
      fcRev:   formatEUR(m.fcRev),
      actRev:  formatEUR(m.actRev),
      varStr:  fmtVar(m.actRev, m.fcRev),
      pctStr:  fmtVarPct(m.actRev, m.fcRev),
      fcExp:   formatEUR(m.fcExp),
      actExp:  formatEUR(m.actExp),
      fcNet:   formatEUR(m.fcNet),
      actNet:  formatEUR(m.actNet)
    }));
  const cols = [
    { key: 'label',  label: 'Month' },
    { key: 'fcRev',  label: 'Fc Revenue',  right: true },
    { key: 'actRev', label: 'Actual Rev',  right: true },
    { key: 'varStr', label: 'Variance',    right: true },
    { key: 'pctStr', label: 'Var %',       right: true },
    { key: 'fcExp',  label: 'Fc Expenses', right: true },
    { key: 'actExp', label: 'Actual Exp',  right: true },
    { key: 'fcNet',  label: 'Fc Net',      right: true },
    { key: 'actNet', label: 'Actual Net',  right: true }
  ];
  return makeTable(cols, rows, 'No forecast data found for the selected period.');
}

function buildStreamTable(data) {
  const rows = data.streamBreakdown.map(s => ({
    label:  s.label,
    fcRev:  formatEUR(s.fcRev),
    actRev: formatEUR(s.actRev),
    varStr: fmtVar(s.actRev, s.fcRev),
    pctStr: fmtVarPct(s.actRev, s.fcRev)
  }));
  const cols = [
    { key: 'label',  label: 'Stream' },
    { key: 'fcRev',  label: 'Forecast', right: true },
    { key: 'actRev', label: 'Actual',   right: true },
    { key: 'varStr', label: 'Variance', right: true },
    { key: 'pctStr', label: 'Var %',    right: true }
  ];
  return makeTable(cols, rows, 'No stream data available.');
}

function buildPropertyTable(data) {
  const hasPending = data.propertyBreakdown.some(r => r.pending > 0);
  const rows = data.propertyBreakdown.map(r => ({
    label:   r.label,
    fcRev:   formatEUR(r.fcRev),
    actRev:  formatEUR(r.actRev),
    varStr:  fmtVar(r.actRev, r.fcRev),
    pctStr:  fmtVarPct(r.actRev, r.fcRev),
    pending: r.pending > 0 ? formatEUR(r.pending) : '—'
  }));
  const cols = [
    { key: 'label',  label: 'Property' },
    { key: 'fcRev',  label: 'Forecast', right: true },
    { key: 'actRev', label: 'Actual',   right: true },
    { key: 'varStr', label: 'Variance', right: true },
    { key: 'pctStr', label: 'Var %',    right: true },
    ...(hasPending ? [{ key: 'pending', label: 'Pending', right: true }] : [])
  ];
  return makeTable(cols, rows, 'No property data available.');
}

function buildPendingTable(data) {
  const rows = data.pendingReservations.map(p => ({
    prop:     byId('properties', p.propertyId)?.name || '—',
    code:     p.confirmationCode || p.airbnbRef || '—',
    guest:    (p.notes || '').split(' · ')[0] || '—',
    checkIn:  p.airbnbCheckIn || '—',
    checkOut: p.airbnbCheckOut || '—',
    nights:   String(p.airbnbNights || '—'),
    amount:   formatEUR(toEUR(p.amount, p.currency || 'EUR', p.airbnbCheckIn || p.date))
  })).sort((a, b) => (a.checkIn || '').localeCompare(b.checkIn || ''));
  const cols = [
    { key: 'prop',     label: 'Property' },
    { key: 'code',     label: 'Confirmation' },
    { key: 'guest',    label: 'Guest' },
    { key: 'checkIn',  label: 'Check-in' },
    { key: 'checkOut', label: 'Check-out' },
    { key: 'nights',   label: 'Nights',  right: true },
    { key: 'amount',   label: 'Amount',  right: true }
  ];
  return makeTable(cols, rows, 'No pending Airbnb reservations found.');
}

// ── Chart rendering ───────────────────────────────────────────────────────────
function renderCharts(data) {
  const { months, fcMonthlyRev, fcMonthlyExp,
          actPayments, actInvoices, actOpExpenses,
          streamBreakdown, propertyBreakdown, pendingReservations } = data;

  const labels = months.map(m => m.label);

  // Build per-month arrays
  const revData    = data.monthlyBreakdown.map(m => Math.round(m.actRev));
  const fcRevData  = months.map(m => Math.round(fcMonthlyRev.get(m.key) || 0));
  const expData    = data.monthlyBreakdown.map(m => Math.round(m.actExp));
  const fcExpData  = months.map(m => Math.round(fcMonthlyExp.get(m.key) || 0));
  const netData    = data.monthlyBreakdown.map(m => Math.round(m.actNet));
  const fcNetData  = months.map((_, i) => fcRevData[i] - fcExpData[i]);
  const varPctData = data.monthlyBreakdown.map(m => {
    const p = safeVariancePct(m.actRev, m.fcRev);
    return p !== null ? Math.round(p * 10) / 10 : 0;
  });

  // 1. Actual vs Forecast Revenue
  if (fcRevData.some(v => v > 0) || revData.some(v => v > 0)) {
    charts.line('anf-fc-actual', {
      labels,
      datasets: [
        { label: 'Actual',   data: revData,   borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,0.08)', fill: true },
        { label: 'Forecast', data: fcRevData, borderColor: '#6366f1', backgroundColor: 'transparent', borderDash: [4,4], fill: false }
      ],
      onClickItem: (_lbl, idx) => {
        const m = data.monthlyBreakdown[idx];
        if (!m) return;
        drillDownModal(`${m.label} — Revenue`, drillRevRows(m.payments, m.invoices), REV_COLS);
      }
    });
  }

  // 2. Forecast Variance %
  if (varPctData.some(v => v !== 0)) {
    charts.bar('anf-fc-var-pct', {
      labels,
      datasets: [{
        label: 'Variance %',
        data: varPctData,
        backgroundColor: varPctData.map(v => v >= 0 ? 'rgba(16,185,129,0.7)' : 'rgba(239,68,68,0.7)')
      }],
      onClickItem: (_lbl, idx) => {
        const m = data.monthlyBreakdown[idx];
        if (!m) return;
        drillDownModal(`${m.label} — Revenue`, drillRevRows(m.payments, m.invoices), REV_COLS);
      }
    });
  }

  // 3. Forecast Net vs Actual Net
  if (fcNetData.some(v => v !== 0) || netData.some(v => v !== 0)) {
    charts.line('anf-net-compare', {
      labels,
      datasets: [
        { label: 'Actual Net',   data: netData,   borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,0.08)', fill: true },
        { label: 'Forecast Net', data: fcNetData, borderColor: '#6366f1', backgroundColor: 'transparent', borderDash: [4,4], fill: false }
      ]
    });
  }

  // 4. Forecast Revenue by Stream (doughnut)
  const fcStreams = streamBreakdown.filter(s => s.fcRev > 0);
  if (fcStreams.length > 0) {
    charts.doughnut('anf-stream-rev', {
      labels: fcStreams.map(s => s.label),
      data:   fcStreams.map(s => Math.round(s.fcRev)),
      colors: fcStreams.map(s => STREAMS[s.key]?.color || '#6366f1')
    });
  }

  // 5. Actual vs Forecast by Stream
  if (streamBreakdown.length > 0) {
    charts.bar('anf-stream-compare', {
      labels: streamBreakdown.map(s => s.label),
      datasets: [
        { label: 'Actual',   data: streamBreakdown.map(s => Math.round(s.actRev)), backgroundColor: '#10b981' },
        { label: 'Forecast', data: streamBreakdown.map(s => Math.round(s.fcRev)),  backgroundColor: '#6366f1' }
      ]
    });
  }

  // 6. Actual vs Forecast by Property (horizontal, top 10)
  const topProps = propertyBreakdown.slice(0, 10);
  if (topProps.length > 0) {
    charts.bar('anf-prop-compare', {
      labels: topProps.map(p => p.label),
      datasets: [
        { label: 'Actual',   data: topProps.map(p => Math.round(p.actRev)), backgroundColor: '#10b981' },
        { label: 'Forecast', data: topProps.map(p => Math.round(p.fcRev)),  backgroundColor: '#6366f1' }
      ],
      horizontal: true
    });
  }

  // 7. Pending Pipeline by Check-in Month
  const pendingMap = new Map();
  pendingReservations.forEach(p => {
    const mk = (p.airbnbCheckIn || p.date || '').slice(0, 7);
    if (!mk) return;
    pendingMap.set(mk, (pendingMap.get(mk) || 0) + toEUR(p.amount, p.currency || 'EUR', p.airbnbCheckIn || p.date));
  });
  const ML9 = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const sortedPendingKeys = [...pendingMap.keys()].sort();
  if (sortedPendingKeys.length > 0) {
    charts.bar('anf-pending-pipeline', {
      labels: sortedPendingKeys.map(mk => {
        const [y, m] = mk.split('-');
        return `${ML9[parseInt(m) - 1]} '${y.slice(2)}`;
      }),
      datasets: [{ label: 'Pending', data: sortedPendingKeys.map(mk => Math.round(pendingMap.get(mk) || 0)), backgroundColor: '#3b82f6' }]
    });
  }

  // 8. Pending by Property (horizontal bar)
  const propPending = propertyBreakdown.filter(p => p.pending > 0);
  if (propPending.length > 0) {
    charts.bar('anf-pending-by-prop', {
      labels: propPending.map(p => p.label),
      datasets: [{ label: 'Pending Pipeline', data: propPending.map(p => Math.round(p.pending)), backgroundColor: '#3b82f6' }],
      horizontal: true
    });
  }
}

// ── Main view builder ─────────────────────────────────────────────────────────
function buildView() {
  const wrap = el('div', { class: 'view active' });

  wrap.appendChild(el('div', { style: 'margin-bottom:16px' },
    el('h2', { style: 'margin:0 0 4px;font-size:20px;font-weight:700' }, 'Forecast Analysis'),
    el('p', { style: 'margin:0;font-size:13px;color:var(--text-muted)' },
      'Forecast vs actual performance, variance analysis, and pipeline visibility.')
  ));

  wrap.appendChild(buildFilterBar(
    gF,
    { showOwner: true, showStream: true, showProperty: true, showClient: true, storagePrefix: 'ana_fc' },
    newGF => { if (newGF) gF = newGF; rebuildView(); }
  ));

  const curRange = getCurrentPeriodRange(gF);
  const cmpRange = getComparisonRange(gF, curRange);
  wrap.appendChild(buildComparisonLine(curRange, cmpRange));

  const data    = calculateDashboardData(curRange);
  const cmpData = cmpRange ? calculateDashboardData(cmpRange) : null;

  if (!data) {
    wrap.appendChild(el('p', { style: 'color:var(--text-muted)' }, 'Unable to compute forecast data for the selected period.'));
    return wrap;
  }

  const hasAnyData = data.forecastRev > 0 || data.actualRev > 0 || data.pendingPipeline > 0;

  wrap.appendChild(buildKpiGrid(data, cmpData, cmpRange));

  if (!hasAnyData) {
    wrap.appendChild(el('div', { class: 'card mb-16', style: 'padding:32px;text-align:center;color:var(--text-muted)' },
      'No forecast or actual data found for the selected period and filters.'
    ));
    return wrap;
  }

  wrap.appendChild(makeChartSection('Forecast Performance', [
    ['Actual vs Forecast Revenue', 'anf-fc-actual'],
    ['Forecast Variance %',        'anf-fc-var-pct'],
    ['Forecast Net vs Actual Net', 'anf-net-compare']
  ]));

  wrap.appendChild(makeChartSection('Revenue Breakdown', [
    ['Forecast Revenue by Stream',    'anf-stream-rev',     { isDoughnut: true }],
    ['Actual vs Forecast by Stream',  'anf-stream-compare'],
    ['Actual vs Forecast by Property','anf-prop-compare']
  ]));

  wrap.appendChild(makeChartSection('Pending Pipeline', [
    ['Pending Pipeline by Month', 'anf-pending-pipeline'],
    ['Pending by Property',       'anf-pending-by-prop']
  ]));

  wrap.appendChild(cardSection('Monthly Forecast Breakdown', buildMonthlyTable(data)));
  wrap.appendChild(cardSection('Stream Breakdown',           buildStreamTable(data)));
  wrap.appendChild(cardSection('Property Breakdown',         buildPropertyTable(data)));
  wrap.appendChild(cardSection('Pending Airbnb Reservations', buildPendingTable(data)));

  setTimeout(() => renderCharts(data), 0);

  return wrap;
}
