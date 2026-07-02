// Analysis Forecast Dashboard — forecast vs actual performance reporting
import { el, fmtDate, drillDownModal, openModal, toast, input, formRow, button } from '../core/ui.js';
import * as charts from '../core/charts.js';
import { STREAMS } from '../core/config.js';
import {
  formatEUR, toEUR, byId,
  listActive, listActivePayments,
  isCapEx, drillRevRows, drillExpRows,
  sumPaymentsEUR, sumInvoicesEUR, sumExpensesEUR,
  softDelete, upsert, newId, companyPropIds, generatePaymentSchedule
} from '../core/data.js';
import { markDirty } from '../core/state.js';
import {
  createFilterState, getCurrentPeriodRange, getComparisonRange,
  getMonthKeysForRange, makeMatchers, resolveStream,
  buildFilterBar, buildComparisonLine
} from './analytics-filters.js?v=20260519';
import { mkSectionLabel, mkSummaryBox, mkModalTable, mkSummaryGrid, mkVarianceBadge, mkEmptyState, mkKpiCard, safePct } from './analytics-helpers.js';

// ── Constants ─────────────────────────────────────────────────────────────────
const CHART_IDS = [
  'anf-fc-actual', 'anf-fc-var-pct', 'anf-net-compare',
  'anf-stream-rev', 'anf-stream-compare', 'anf-prop-compare',
  'anf-pending-pipeline', 'anf-pending-by-prop',
  'anf-accuracy-trend'
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
const EXP_MO_COLS = [
  { key: 'month',  label: 'Month' },
  { key: 'fcExp',  label: 'Forecast OpEx', right: true },
  { key: 'actExp', label: 'Actual OpEx',   right: true },
  { key: 'varStr', label: 'Variance',      right: true },
  { key: 'pctStr', label: 'Var %',         right: true }
];
const NET_MO_COLS = [
  { key: 'month',  label: 'Month' },
  { key: 'actRev', label: 'Actual Revenue', right: true },
  { key: 'actExp', label: 'Actual OpEx',    right: true },
  { key: 'actNet', label: 'Actual Net',     right: true },
  { key: 'fcNet',  label: 'Forecast Net',   right: true },
  { key: 'varStr', label: 'Variance',       right: true }
];

// ── Filter state ──────────────────────────────────────────────────────────────
let gF = createFilterState();
let gScope = 'company'; // 'company' | 'all'

// ── Module export ─────────────────────────────────────────────────────────────
export default {
  id: 'analytics-forecast', label: 'Forecast', icon: '🔮',
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

// ── Property forecast filter predicate ────────────────────────────────────────
// Shared by buildFcMaps / computeStreamBreakdown / computePropertyBreakdown so
// a property's eligibility for the current owner/stream/property/scope filters
// is decided in exactly one place.
function propMatchesForecastFilters(prop) {
  if (!prop) return false;
  if (gF.propertyIds.size > 0 && !gF.propertyIds.has(prop.id)) return false;
  if (gScope !== 'all' && (prop.channel || 'company') !== 'company') return false;
  if (gF.streams.size > 0) {
    const s = prop.type === 'short_term' ? 'short_term_rental'
            : prop.type === 'long_term'  ? 'long_term_rental' : null;
    if (!s || !gF.streams.has(s)) return false;
  }
  if (gF.owners.size > 0) {
    const ow = prop.owner || 'both';
    if (ow !== 'both' && !gF.owners.has(ow)) return false;
  }
  return true;
}

// ── Long-term rent-schedule fallback ──────────────────────────────────────────
// Mirrors getForecastVsActual() in core/data.js: a long-term property with no
// manual monthly forecast entry still projects revenue from its lease/rent
// schedule, so Operations → Forecast and Analytics → Forecast agree. Cached
// per (propertyId, year) since generatePaymentSchedule() rebuilds the full
// lease schedule and is called repeatedly across the three functions below.
let _ltRentCache = new Map();
function getLtRentByMonth(propertyId, year) {
  const cacheKey = propertyId + ':' + year;
  if (_ltRentCache.has(cacheKey)) return _ltRentCache.get(cacheKey);
  const prop = byId('properties', propertyId);
  let map = null;
  if (prop?.type === 'long_term') {
    map = {};
    for (const entry of generatePaymentSchedule(prop)) {
      if (entry.monthKey?.startsWith(String(year))) {
        map[entry.monthKey] = toEUR(entry.amount, entry.currency, year);
      }
    }
  }
  _ltRentCache.set(cacheKey, map);
  return map;
}

// Resolves a property forecast's revenue for one month: a manual entry wins;
// otherwise long-term properties fall back to their lease-schedule projection.
function resolvePropertyMonthRevenue(propertyId, year, mk, md) {
  const entries = Array.isArray(md?.entries) ? md.entries : [];
  const manual = entries.length > 0
    ? entries.reduce((s, e) => s + (Number(e.amount) || 0), 0)
    : Number(md?.revenue) || 0;
  if (manual > 0) return manual;
  const ltMap = getLtRentByMonth(propertyId, year);
  return ltMap ? (ltMap[mk] || 0) : 0;
}

// ── Forecast map builder (filtered, multi-year) ───────────────────────────────
// Returns:
//   fcMonthlyRev    Map<"YYYY-MM",        EUR>  — total portfolio forecast revenue per month
//   fcPropMonthlyRev Map<"YYYY-MM_propId", EUR>  — per-property forecast revenue per month
//   fcMonthlyExp    Map<"YYYY-MM",        EUR>  — total forecast expenses per month
function buildFcMaps(startY, endY) {
  const fcMonthlyRev     = new Map();
  const fcPropMonthlyRev = new Map();
  const fcMonthlyExp     = new Map();
  const allFcs = listActive('forecasts');
  const fcByEntityYear = new Map(allFcs.map(fc => [fc.entityId + ':' + fc.year, fc]));

  for (let y = startY; y <= endY; y++) {
    // Property forecasts — long-term properties are walked month-by-month so a
    // lease schedule can fill in months with no manual entry (and properties
    // with no forecast record at all still get a lease-derived projection).
    // Short-term properties have no schedule fallback, so they're skipped
    // entirely when no forecast record exists.
    listActive('properties').forEach(prop => {
      if (!propMatchesForecastFilters(prop)) return;
      const fc = fcByEntityYear.get(prop.id + ':' + y);

      if (prop.type === 'long_term') {
        for (let m = 1; m <= 12; m++) {
          const mk = `${y}-${String(m).padStart(2, '0')}`;
          const md = fc?.months?.[mk];
          const rev = resolvePropertyMonthRevenue(prop.id, y, mk, md);
          if (rev > 0) {
            fcMonthlyRev.set(mk, (fcMonthlyRev.get(mk) || 0) + rev);
            const propKey = mk + '_' + prop.id;
            fcPropMonthlyRev.set(propKey, (fcPropMonthlyRev.get(propKey) || 0) + rev);
          }
          const exp = Number(md?.expenses) || 0;
          if (exp > 0) fcMonthlyExp.set(mk, (fcMonthlyExp.get(mk) || 0) + exp);
        }
      } else if (fc) {
        Object.entries(fc.months || {}).forEach(([mk, md]) => {
          const entries = Array.isArray(md.entries) ? md.entries : [];
          const rev = entries.length > 0
            ? entries.reduce((s, e) => s + (Number(e.amount) || 0), 0)
            : Number(md.revenue) || 0;
          if (rev > 0) {
            fcMonthlyRev.set(mk, (fcMonthlyRev.get(mk) || 0) + rev);
            const propKey = mk + '_' + prop.id;
            fcPropMonthlyRev.set(propKey, (fcPropMonthlyRev.get(propKey) || 0) + rev);
          }
          const exp = Number(md.expenses) || 0;
          if (exp > 0) fcMonthlyExp.set(mk, (fcMonthlyExp.get(mk) || 0) + exp);
        });
      }
    });

    // Service forecasts (customer_success, marketing_services) — unaffected
    // by the property scope/owner filters.
    allFcs.filter(fc => fc.year === y && fc.type === 'service').forEach(fc => {
      if (gF.streams.size > 0 && !gF.streams.has(fc.entityId)) return;
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
  return { fcMonthlyRev, fcPropMonthlyRev, fcMonthlyExp };
}

// ── Core data calculation ─────────────────────────────────────────────────────
function calculateDashboardData(range) {
  if (!range) return null;
  const { mStream, mOwner, mProperty, mClient } = makeMatchers(gF);
  const coPropIds = companyPropIds();
  const isCoRec = gScope === 'all'
    ? () => true
    : r => !r.propertyId || coPropIds.has(r.propertyId);
  const inRange = d => d && d >= range.start && d <= range.end;

  const actPayments = listActivePayments().filter(p =>
    p.status === 'paid' && inRange(p.date) && mStream(p) && mOwner(p) && mProperty(p) && isCoRec(p)
  );
  const actInvoices = listActive('invoices').filter(i =>
    i.status === 'paid' && inRange(i.issueDate) && mStream(i) && mOwner(i) && mClient(i)
  );
  const allExpenses = listActive('expenses').filter(e => inRange(e.date) && mOwner(e) && mProperty(e) && isCoRec(e));
  const actOpExpenses  = allExpenses.filter(e => !isCapEx(e) && mStream(e));
  const actCapExpenses = allExpenses.filter(e => isCapEx(e) && mStream(e));

  const actualRev    = sumPaymentsEUR(actPayments) + sumInvoicesEUR(actInvoices);
  const actualExp    = sumExpensesEUR(actOpExpenses);
  const actualCapEx  = sumExpensesEUR(actCapExpenses);
  const actualNet    = actualRev - actualExp;

  const { keys: months } = getMonthKeysForRange(range.start, range.end);
  const startY = parseInt(range.start.slice(0, 4));
  const endY   = parseInt(range.end.slice(0, 4));
  const { fcMonthlyRev, fcPropMonthlyRev, fcMonthlyExp } = buildFcMaps(startY, endY);

  let forecastRev = 0, forecastExp = 0;
  months.forEach(m => {
    forecastRev += fcMonthlyRev.get(m.key) || 0;
    forecastExp += fcMonthlyExp.get(m.key) || 0;
  });
  const forecastNet = forecastRev - forecastExp;
  const variance    = actualRev - forecastRev;
  const variancePct = safeVariancePct(actualRev, forecastRev);

  // Pending pipeline — period scoped by airbnbCheckIn (fallback: date) — used for KPI, table, insights
  const pendingReservations = listActivePayments().filter(p => {
    if (p.source !== 'airbnb' || p.status !== 'pending') return false;
    const checkDate = p.airbnbCheckIn || p.date;
    if (!checkDate || checkDate < range.start || checkDate > range.end) return false;
    if (gF.propertyIds.size > 0 && !gF.propertyIds.has(p.propertyId)) return false;
    if (gF.streams.size > 0 && !gF.streams.has('short_term_rental')) return false;
    if (gF.owners.size > 0 && p.propertyId) {
      const prop = byId('properties', p.propertyId);
      const ow = prop?.owner || 'both';
      if (ow !== 'both' && !gF.owners.has(ow)) return false;
    }
    return isCoRec(p);
  });
  const pendingPipeline = pendingReservations.reduce(
    (s, p) => s + toEUR(p.amount, p.currency || 'EUR', p.airbnbCheckIn || p.date), 0
  );

  // All entity-filtered pending — not date-clamped, used for forward-looking charts
  const allPendingReservations = listActivePayments().filter(p => {
    if (p.source !== 'airbnb' || p.status !== 'pending') return false;
    if (gF.propertyIds.size > 0 && !gF.propertyIds.has(p.propertyId)) return false;
    if (gF.streams.size > 0 && !gF.streams.has('short_term_rental')) return false;
    if (gF.owners.size > 0 && p.propertyId) {
      const prop = byId('properties', p.propertyId);
      const ow = prop?.owner || 'both';
      if (ow !== 'both' && !gF.owners.has(ow)) return false;
    }
    return isCoRec(p);
  });

  // Pre-group payments/invoices/expenses by month key for efficiency
  const paysByMk = new Map(), invsByMk = new Map(), expsByMk = new Map(), capexByMk = new Map();
  actPayments.forEach(p => { const mk = (p.date || '').slice(0,7); paysByMk.set(mk, [...(paysByMk.get(mk)||[]), p]); });
  actInvoices.forEach(i => { const mk = (i.issueDate||'').slice(0,7); invsByMk.set(mk, [...(invsByMk.get(mk)||[]), i]); });
  actOpExpenses.forEach(e => { const mk = (e.date||'').slice(0,7); expsByMk.set(mk, [...(expsByMk.get(mk)||[]), e]); });
  actCapExpenses.forEach(e => { const mk = (e.date||'').slice(0,7); capexByMk.set(mk, [...(capexByMk.get(mk)||[]), e]); });

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
      payments: mPays, invoices: mInvs, expenses: mExps,
      capexExpenses: capexByMk.get(mk) || []
    };
  });

  // MAPE — mean absolute percentage error over months with a forecast value
  const mapeValidMonths = monthlyBreakdown.filter(m => m.fcRev > 0);
  let mape = null;
  if (mapeValidMonths.length > 0) {
    const sumAbsPct = mapeValidMonths.reduce((s, m) => s + Math.abs(m.actRev - m.fcRev) / m.fcRev, 0);
    mape = (sumAbsPct / mapeValidMonths.length) * 100;
  }

  const streamBreakdown   = computeStreamBreakdown(actPayments, actInvoices, months);
  const propertyBreakdown = computePropertyBreakdown(actPayments, months, pendingReservations);

  return {
    actualRev, actualExp, actualCapEx, actualNet,
    forecastRev, forecastExp, forecastNet,
    variance, variancePct,
    pendingPipeline, pendingReservations, allPendingReservations,
    actPayments, actInvoices, actOpExpenses, actCapExpenses,
    months, fcMonthlyRev, fcPropMonthlyRev, fcMonthlyExp,
    monthlyBreakdown, streamBreakdown, propertyBreakdown,
    mape, mapeMonthCount: mapeValidMonths.length
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

  const fcByEntityYear = new Map(listActive('forecasts').map(fc => [fc.entityId + ':' + fc.year, fc]));

  const fcByStream = new Map();

  // Property-type forecasts (with the long-term lease-schedule fallback).
  listActive('properties').forEach(prop => {
    if (!propMatchesForecastFilters(prop)) return;
    const stream = prop.type === 'short_term' ? 'short_term_rental'
                 : prop.type === 'long_term'  ? 'long_term_rental' : null;
    if (!stream) return;
    months.forEach(m => {
      const mk = m.key;
      const y  = parseInt(mk.slice(0, 4));
      const fc = fcByEntityYear.get(prop.id + ':' + y);
      let val;
      if (prop.type === 'long_term') {
        val = resolvePropertyMonthRevenue(prop.id, y, mk, fc?.months?.[mk]);
      } else {
        const md = fc?.months?.[mk];
        if (!md) return;
        const entries = Array.isArray(md.entries) ? md.entries : [];
        val = entries.length > 0 ? entries.reduce((s, e) => s + (Number(e.amount) || 0), 0) : Number(md.revenue) || 0;
      }
      if (val > 0) fcByStream.set(stream, (fcByStream.get(stream) || 0) + val);
    });
  });

  // Service-type forecasts (customer_success, marketing_services).
  listActive('forecasts').filter(fc => fc.type === 'service').forEach(fc => {
    if (gF.streams.size > 0 && !gF.streams.has(fc.entityId)) return;
    months.forEach(m => {
      const mk = m.key;
      if (parseInt(mk.slice(0, 4)) !== fc.year) return;
      const md = fc.months?.[mk];
      if (!md) return;
      const entries = Array.isArray(md.entries) ? md.entries : [];
      const val = entries.length > 0
        ? entries.reduce((s, e) => s + (Number(e.amount) || 0), 0)
        : Number(md.revenue) || 0;
      if (val > 0) fcByStream.set(fc.entityId, (fcByStream.get(fc.entityId) || 0) + val);
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

  const fcByEntityYear = new Map(
    listActive('forecasts').filter(fc => fc.type === 'property').map(fc => [fc.entityId + ':' + fc.year, fc])
  );

  const fcByProp = new Map();
  listActive('properties').forEach(prop => {
    if (!propMatchesForecastFilters(prop)) return;
    months.forEach(m => {
      const mk = m.key;
      const y  = parseInt(mk.slice(0, 4));
      const fc = fcByEntityYear.get(prop.id + ':' + y);
      let val;
      if (prop.type === 'long_term') {
        val = resolvePropertyMonthRevenue(prop.id, y, mk, fc?.months?.[mk]);
      } else {
        const md = fc?.months?.[mk];
        if (!md) return;
        const entries = Array.isArray(md.entries) ? md.entries : [];
        val = entries.length > 0 ? entries.reduce((s, e) => s + (Number(e.amount) || 0), 0) : Number(md.revenue) || 0;
      }
      if (val > 0) fcByProp.set(prop.id, (fcByProp.get(prop.id) || 0) + val);
    });
  });

  const pendingByProp = new Map();
  pendingReservations.forEach(p => {
    if (!p.propertyId) return;
    pendingByProp.set(p.propertyId, (pendingByProp.get(p.propertyId) || 0) + toEUR(p.amount, p.currency || 'EUR', p.airbnbCheckIn || p.date));
  });

  // Include properties with actual revenue, forecast revenue, or pending pipeline
  const allPropIds = new Set([...actByProp.keys(), ...fcByProp.keys(), ...pendingByProp.keys()]);
  return [...allPropIds].map(propId => {
    const prop = byId('properties', propId);
    const act  = actByProp.get(propId)     || 0;
    const fc   = fcByProp.get(propId)      || 0;
    const pend = pendingByProp.get(propId) || 0;
    return { propId, label: prop?.name || propId, actRev: act, fcRev: fc, variance: act - fc, variancePct: safeVariancePct(act, fc), pending: pend };
  }).sort((a, b) => b.actRev - a.actRev);
}

// ── Drill row helpers ─────────────────────────────────────────────────────────
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

function expMoDrillRows(monthlyBreakdown) {
  return monthlyBreakdown
    .filter(m => m.fcExp > 0 || m.actExp > 0)
    .map(m => ({
      month:  m.label,
      fcExp:  formatEUR(m.fcExp),
      actExp: formatEUR(m.actExp),
      varStr: fmtVar(m.actExp, m.fcExp),
      pctStr: fmtVarPct(m.actExp, m.fcExp)
    }));
}

function netMoDrillRows(monthlyBreakdown) {
  return monthlyBreakdown
    .filter(m => m.actRev > 0 || m.actExp > 0 || m.fcNet !== 0 || m.actNet !== 0)
    .map(m => ({
      month:  m.label,
      actRev: formatEUR(m.actRev),
      actExp: formatEUR(m.actExp),
      actNet: formatEUR(m.actNet),
      fcNet:  formatEUR(m.fcNet),
      varStr: fmtVar(m.actNet, m.fcNet)
    }));
}

// ── KPI grid ──────────────────────────────────────────────────────────────────
function buildKpiGrid(data, cmpData, cmpRange) {
  const {
    actualRev, actualExp, actualCapEx, actualNet,
    forecastRev, forecastExp, forecastNet,
    variance, pendingPipeline, pendingReservations,
    actPayments, actInvoices, actOpExpenses, actCapExpenses,
    monthlyBreakdown, mape, mapeMonthCount
  } = data;
  const cmpLabel = cmpRange?.label || '';

  const grid = el('div', {
    class: 'mb-16',
    style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px'
  });

  const varVariant = variance > 0 ? 'success' : variance < 0 ? 'danger' : '';

  // 1. Forecast Revenue
  grid.appendChild(mkKpiCard({
    label: 'Forecast Revenue',
    value: forecastRev > 0 ? formatEUR(forecastRev) : '—',
    onClick: () => drillDownModal('Monthly Forecast', monthDrillRows(monthlyBreakdown), MO_COLS),
    delta: cmpData ? safePct(forecastRev, cmpData.forecastRev) : null,
    invertDelta: false, compLabel: cmpLabel,
    compValue: cmpData ? formatEUR(cmpData.forecastRev) : undefined,
  }));

  // 2. Actual Revenue
  grid.appendChild(mkKpiCard({
    label: 'Actual Revenue',
    value: formatEUR(actualRev),
    onClick: () => {
      const body = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });

      // Stream summary boxes
      const streamBoxes = el('div', { style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:8px' });
      const streamGroups = {};
      actPayments.forEach(p => {
        const key = resolveStream(p) || 'other';
        streamGroups[key] = (streamGroups[key] || 0) + toEUR(p.amount, p.currency, p.date);
      });
      actInvoices.forEach(i => {
        const key = resolveStream(i) || 'other';
        streamGroups[key] = (streamGroups[key] || 0) + toEUR(i.total || i.amount, i.currency, i.issueDate || i.date);
      });
      const streamLabels = { customer_success: 'Customer Success', marketing_services: 'Marketing Services', short_term_rental: 'Short-Term Rental', long_term_rental: 'Long-Term Rental', other: 'Other' };
      Object.entries(streamGroups).filter(([, v]) => v > 0).forEach(([key, val]) => {
        const pct = actualRev > 0 ? ((val / actualRev) * 100).toFixed(0) + '% of total' : null;
        streamBoxes.appendChild(mkSummaryBox(streamLabels[key] || key, formatEUR(val), pct));
      });

      if (streamBoxes.children.length > 0) {
        body.appendChild(mkSectionLabel('By Stream'));
        body.appendChild(streamBoxes);
      }

      // Client / property breakdown table
      const clientMap = new Map();
      actPayments.forEach(p => {
        const propName = byId('properties', p.propertyId)?.name || '—';
        clientMap.set(propName, (clientMap.get(propName) || 0) + toEUR(p.amount, p.currency, p.date));
      });
      actInvoices.forEach(i => {
        const clientName = byId('clients', i.clientId)?.name || byId('clients', i.clientId)?.company || i.clientId || '—';
        clientMap.set(clientName, (clientMap.get(clientName) || 0) + toEUR(i.total || i.amount, i.currency, i.issueDate || i.date));
      });
      const clientRows = [...clientMap.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([name, val]) => [name, formatEUR(val)]);
      if (clientRows.length > 0) {
        body.appendChild(mkSectionLabel('By Client / Property'));
        body.appendChild(mkModalTable(['Client / Property', 'Amount'], clientRows));
      }

      openModal({ title: 'Actual Revenue Breakdown', body, large: true });
    },
    delta: cmpData ? safePct(actualRev, cmpData.actualRev) : null,
    invertDelta: false, compLabel: cmpLabel,
    compValue: cmpData ? formatEUR(cmpData.actualRev) : undefined,
  }));

  // 3. Forecast Variance
  grid.appendChild(mkKpiCard({
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
  grid.appendChild(mkKpiCard({
    label: 'Forecast Variance %',
    value: varPctStr,
    variant: varVariant,
    onClick: () => drillDownModal('Monthly Forecast', monthDrillRows(monthlyBreakdown), MO_COLS),
    delta: null, compLabel: ''
  }));

  // 5. Forecast OpEx — drilldown shows forecast vs actual expense breakdown
  grid.appendChild(mkKpiCard({
    label: 'Forecast OpEx',
    subtitle: 'Excl. CapEx',
    value: forecastExp > 0 ? formatEUR(forecastExp) : '—',
    onClick: () => drillDownModal('Forecast vs Actual OpEx', expMoDrillRows(monthlyBreakdown), EXP_MO_COLS),
    delta: cmpData ? safePct(forecastExp, cmpData.forecastExp) : null,
    invertDelta: true, compLabel: cmpLabel,
    compValue: cmpData ? formatEUR(cmpData.forecastExp) : undefined,
  }));

  // 6. Actual OpEx
  grid.appendChild(mkKpiCard({
    label: 'Actual OpEx',
    subtitle: 'Excl. CapEx',
    value: formatEUR(actualExp),
    onClick: () => {
      const body = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });

      // Category summary boxes
      const catMap = new Map();
      actOpExpenses.forEach(e => {
        const cat = e.category || 'Uncategorised';
        catMap.set(cat, (catMap.get(cat) || 0) + toEUR(e.amount, e.currency, e.date));
      });
      const catEntries = [...catMap.entries()].sort((a, b) => b[1] - a[1]);
      if (catEntries.length > 0) {
        const catBoxes = el('div', { style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:8px' });
        catEntries.slice(0, 6).forEach(([cat, val]) => {
          const pct = actualExp > 0 ? ((val / actualExp) * 100).toFixed(0) + '% of total' : null;
          catBoxes.appendChild(mkSummaryBox(cat, formatEUR(val), pct));
        });
        body.appendChild(mkSectionLabel('By Category'));
        body.appendChild(catBoxes);
        const hidden = catEntries.length - 6;
        if (hidden > 0) {
          body.appendChild(el('div', {
            style: 'font-size:11px;color:var(--text-muted);margin-top:8px;text-align:center'
          }, `+ ${hidden} more categor${hidden === 1 ? 'y' : 'ies'} not shown`));
        }
      }

      // Property breakdown table
      const propMap = new Map();
      actOpExpenses.forEach(e => {
        const propName = e.propertyId ? (byId('properties', e.propertyId)?.name || e.propertyId) : (e.source || '—');
        propMap.set(propName, (propMap.get(propName) || 0) + toEUR(e.amount, e.currency, e.date));
      });
      const propRows = [...propMap.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([name, val]) => [name, formatEUR(val)]);
      if (propRows.length > 0) {
        body.appendChild(mkSectionLabel('By Property'));
        body.appendChild(mkModalTable(['Property', 'Amount'], propRows));
      }

      openModal({ title: 'Actual OpEx Breakdown', body, large: true });
    },
    delta: cmpData ? safePct(actualExp, cmpData.actualExp) : null,
    invertDelta: true, compLabel: cmpLabel,
    compValue: cmpData ? formatEUR(cmpData.actualExp) : undefined,
  }));

  // 7. Forecast Net
  grid.appendChild(mkKpiCard({
    label: 'Forecast Net',
    value: forecastNet !== 0 || forecastRev > 0 ? formatEUR(forecastNet) : '—',
    variant: forecastNet >= 0 ? 'success' : 'danger',
    onClick: () => drillDownModal('Monthly Forecast', monthDrillRows(monthlyBreakdown), MO_COLS),
    delta: cmpData ? safePct(forecastNet, cmpData.forecastNet) : null,
    invertDelta: false, compLabel: cmpLabel,
    compValue: cmpData ? formatEUR(cmpData.forecastNet) : undefined,
  }));

  // 8. Actual Net — drilldown shows monthly net breakdown vs forecast
  grid.appendChild(mkKpiCard({
    label: 'Actual Net',
    value: formatEUR(actualNet),
    variant: actualNet >= 0 ? 'success' : 'danger',
    onClick: () => drillDownModal('Actual Net Breakdown', netMoDrillRows(monthlyBreakdown), NET_MO_COLS),
    delta: cmpData ? safePct(actualNet, cmpData.actualNet) : null,
    invertDelta: false, compLabel: cmpLabel,
    compValue: cmpData ? formatEUR(cmpData.actualNet) : undefined,
  }));

  // 9. Pending Pipeline — period scoped
  grid.appendChild(mkKpiCard({
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
    invertDelta: false, compLabel: cmpLabel,
    compValue: cmpData ? formatEUR(cmpData.pendingPipeline) : undefined,
  }));

  // 10. CapEx Budget vs Actual — forecast model has no CapEx field; show actuals with explanatory subtitle
  grid.appendChild(mkKpiCard({
    label: 'Actual CapEx',
    subtitle: 'No CapEx forecast data',
    value: actualCapEx > 0 ? formatEUR(actualCapEx) : '—',
    variant: actualCapEx > 0 ? 'warning' : '',
    onClick: () => {
      const body = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });

      // Summary box
      const summaryBoxes = el('div', { style: 'display:grid;grid-template-columns:repeat(2,1fr);gap:8px' });
      summaryBoxes.appendChild(mkSummaryBox('Total CapEx', formatEUR(actualCapEx)));
      summaryBoxes.appendChild(mkSummaryBox('Transactions', String(actCapExpenses.length)));
      body.appendChild(mkSectionLabel('CapEx Summary'));
      body.appendChild(summaryBoxes);

      // Note about forecast availability
      const note = el('div', { style: 'padding:8px 12px;border-radius:4px;background:rgba(245,158,11,0.06);border-left:3px solid #f59e0b;font-size:12px;color:var(--text-muted)' },
        'CapEx forecast is not yet modelled in the forecast data. Only actual CapEx is shown here as a reference number alongside other forecast KPIs.'
      );
      body.appendChild(note);

      // Per-property breakdown
      const propMap = new Map();
      actCapExpenses.forEach(e => {
        const propName = e.propertyId ? (byId('properties', e.propertyId)?.name || e.propertyId) : (e.source || '—');
        propMap.set(propName, (propMap.get(propName) || 0) + toEUR(e.amount, e.currency, e.date));
      });
      const propRows = [...propMap.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([name, val]) => [name, formatEUR(val)]);
      if (propRows.length > 0) {
        body.appendChild(mkSectionLabel('By Property'));
        body.appendChild(mkModalTable(['Property', 'CapEx Amount'], propRows));
      }

      // Detailed transaction rows
      if (actCapExpenses.length > 0) {
        const txRows = actCapExpenses
          .slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''))
          .map(e => [
            fmtDate(e.date),
            e.propertyId ? (byId('properties', e.propertyId)?.name || e.propertyId) : (e.source || '—'),
            e.category || '—',
            e.description || '—',
            formatEUR(toEUR(e.amount, e.currency, e.date))
          ]);
        body.appendChild(mkSectionLabel('Transactions'));
        body.appendChild(mkModalTable(['Date', 'Property', 'Category', 'Description', 'Amount'], txRows));
      }

      openModal({ title: 'CapEx Actual Breakdown', body, large: true });
    },
    delta: cmpData ? safePct(actualCapEx, cmpData.actualCapEx) : null,
    invertDelta: true, compLabel: cmpLabel
  }));

  // 11. Forecast Accuracy (MAPE)
  const mapeVariant = mape === null ? '' : mape < 10 ? 'success' : mape < 25 ? 'warning' : 'danger';
  const mapeValue   = mape === null ? '—' : mape.toFixed(1) + '%';
  const mapeSubtitle = mapeMonthCount > 0 ? `avg error over ${mapeMonthCount} month${mapeMonthCount !== 1 ? 's' : ''}` : 'no forecast months';
  grid.appendChild(mkKpiCard({
    label: 'Forecast Accuracy (MAPE)',
    subtitle: mapeSubtitle,
    value: mapeValue,
    variant: mapeVariant,
    onClick: () => {
      const mapeRows = monthlyBreakdown
        .filter(m => m.fcRev > 0)
        .map(m => {
          const absErr = Math.abs(m.actRev - m.fcRev);
          const pctErr = (absErr / m.fcRev) * 100;
          return { month: m.label, fcRev: formatEUR(m.fcRev), actRev: formatEUR(m.actRev), absErr: formatEUR(absErr), pctErr: pctErr.toFixed(1) + '%', _pctErr: pctErr };
        })
        .sort((a, b) => b._pctErr - a._pctErr);

      const body = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });

      const summaryBoxes = el('div', { style: 'display:grid;grid-template-columns:repeat(3,1fr);gap:8px' });
      summaryBoxes.appendChild(mkSummaryBox('MAPE', mapeValue, 'lower is better'));
      summaryBoxes.appendChild(mkSummaryBox('Months Measured', String(mapeMonthCount)));
      if (mape !== null) {
        const accuracy = Math.max(0, 100 - mape).toFixed(1) + '%';
        summaryBoxes.appendChild(mkSummaryBox('Avg Accuracy', accuracy, 'of forecast'));
      }
      body.appendChild(mkSectionLabel('Accuracy Summary'));
      body.appendChild(summaryBoxes);

      if (mapeRows.length > 0) {
        body.appendChild(mkSectionLabel('Per-Month Error (worst first)'));
        body.appendChild(mkModalTable(
          ['Month', 'Forecast', 'Actual', 'Abs Error', '% Error'],
          mapeRows.map(r => [r.month, r.fcRev, r.actRev, r.absErr, r.pctErr])
        ));
      } else {
        body.appendChild(el('div', { style: 'font-size:13px;color:var(--text-muted)' }, 'No months with forecast data in the selected period.'));
      }

      openModal({ title: 'Forecast Accuracy Detail (MAPE)', body, large: true });
    },
    delta: null, compLabel: ''
  }));

  return grid;
}

// ── Forecast Performance Insights ─────────────────────────────────────────────
function buildForecastInsights(data, cmpData) {
  const { actualRev, forecastRev, variancePct, pendingPipeline,
          streamBreakdown, propertyBreakdown } = data;

  const signals = [];

  // Forecast gap / missing forecast / forecast without actuals
  if (forecastRev > 0 && actualRev > 0 && variancePct !== null) {
    if (variancePct < -25) {
      signals.push({
        title: 'Forecast Gap',
        text: `Actual revenue is ${Math.abs(variancePct).toFixed(0)}% below forecast (${fmtVar(actualRev, forecastRev)} variance).`,
        severity: 'At Risk',
        inspect: 'Monthly Forecast Breakdown'
      });
    } else if (variancePct < -10) {
      signals.push({
        title: 'Forecast Gap',
        text: `Actual revenue is ${Math.abs(variancePct).toFixed(0)}% below forecast (${fmtVar(actualRev, forecastRev)} variance).`,
        severity: 'Watch',
        inspect: 'Monthly Forecast Breakdown'
      });
    }
  } else if (actualRev > 0 && forecastRev === 0) {
    signals.push({
      title: 'Missing Forecast',
      text: `Actual revenue of ${formatEUR(actualRev)} exists but no forecast was set for the selected period.`,
      severity: 'Watch',
      inspect: 'Monthly Forecast Breakdown'
    });
  } else if (forecastRev > 0 && actualRev === 0) {
    signals.push({
      title: 'Forecast Without Actuals',
      text: `Forecast revenue of ${formatEUR(forecastRev)} exists but no actual revenue has been recorded yet.`,
      severity: 'Watch',
      inspect: 'Stream Breakdown'
    });
  }

  // Worst negative stream variance
  if (streamBreakdown.length > 0) {
    const worst = streamBreakdown
      .filter(s => s.variance < 0 && s.fcRev > 0)
      .sort((a, b) => a.variance - b.variance)[0];
    if (worst && Math.abs(worst.variance) > 500) {
      const pct = worst.variancePct !== null ? ` (${Math.abs(worst.variancePct).toFixed(0)}% gap)` : '';
      signals.push({
        title: 'Stream Variance',
        text: `${worst.label} is ${formatEUR(Math.abs(worst.variance))} below forecast${pct}.`,
        severity: 'Watch',
        inspect: 'Stream Breakdown'
      });
    }
  }

  // Worst negative property variance
  if (propertyBreakdown.length > 0) {
    const worst = propertyBreakdown
      .filter(p => p.variance < 0 && p.fcRev > 0)
      .sort((a, b) => a.variance - b.variance)[0];
    if (worst && Math.abs(worst.variance) > 500) {
      signals.push({
        title: 'Property Variance',
        text: `${worst.label} is the largest negative variance (${formatEUR(Math.abs(worst.variance))} below forecast).`,
        severity: 'Watch',
        inspect: 'Property Breakdown'
      });
    }
  }

  // Pending pipeline visibility
  if (pendingPipeline > 0) {
    signals.push({
      title: 'Pending Pipeline',
      text: `${formatEUR(pendingPipeline)} in pending Airbnb reservations for the selected period.`,
      severity: 'info',
      inspect: 'Pending Airbnb Reservations'
    });
  }

  const section = el('div', { class: 'card mb-16' });
  section.appendChild(el('div', { class: 'card-header' },
    el('div', { class: 'card-title' }, 'Forecast Performance Insights')
  ));
  const body = el('div', { style: 'padding:0 16px 16px' });

  if (signals.length === 0) {
    body.appendChild(el('div', { style: 'font-size:13px;color:var(--text-muted)' },
      `No major forecast risks detected for the selected period. Forecast: ${forecastRev > 0 ? formatEUR(forecastRev) : '—'}, Actual: ${formatEUR(actualRev)}.`
    ));
    section.appendChild(body);
    return section;
  }

  const SEV_COLOR = { 'At Risk': '#ef4444', Watch: '#f59e0b', info: '#3b82f6' };
  const SEV_BG    = { 'At Risk': 'rgba(239,68,68,0.06)', Watch: 'rgba(245,158,11,0.06)', info: 'rgba(59,130,246,0.06)' };
  const row = el('div', { style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px' });

  for (const sig of signals) {
    const color = SEV_COLOR[sig.severity] || '#6b7280';
    const bg    = SEV_BG[sig.severity]    || 'transparent';
    const block = el('div', { style: `padding:10px 12px;border-radius:4px;border-left:3px solid ${color};background:${bg}` });
    const titleRow = el('div', { style: 'display:flex;align-items:center;justify-content:space-between;margin-bottom:4px' });
    titleRow.appendChild(el('span', { style: 'font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-muted)' }, sig.title));
    if (sig.severity !== 'info') {
      titleRow.appendChild(el('span', { style: `font-size:10px;font-weight:700;padding:1px 6px;border-radius:10px;color:${color};border:1px solid ${color}` }, sig.severity));
    }
    block.appendChild(titleRow);
    block.appendChild(el('p', { style: 'margin:0 0 5px;font-size:12px;line-height:1.5;color:var(--text)' }, sig.text));
    block.appendChild(el('div', { style: 'font-size:11px;color:var(--text-muted)' }, `→ Inspect: ${sig.inspect}`));
    row.appendChild(block);
  }

  body.appendChild(row);
  section.appendChild(body);
  return section;
}

// ── Forecast Data Quality ─────────────────────────────────────────────────────
function buildDataQualityWarnings() {
  const allFcs = listActive('forecasts');
  const warnings = [];

  // Property forecasts referencing non-existent properties
  const orphans = allFcs.filter(fc => fc.type === 'property' && !byId('properties', fc.entityId));
  if (orphans.length > 0) {
    const ids = [...new Set(orphans.map(f => f.entityId))].slice(0, 5).join(', ');
    warnings.push({
      title: 'Orphan Property Forecasts',
      text: `${orphans.length} forecast record${orphans.length > 1 ? 's' : ''} reference propert${orphans.length > 1 ? 'ies' : 'y'} that no longer exist. Affected IDs: ${ids}${orphans.length > 5 ? ', …' : ''}`,
      action: { label: 'Clean Up', fn: () => {
        if (!confirm(`Remove ${orphans.length} orphan forecast record${orphans.length > 1 ? 's' : ''}? This cannot be undone.`)) return;
        orphans.forEach(fc => softDelete('forecasts', fc.id));
        rebuildView();
      }}
    });
  }

  // Records with no monthly data
  const noMonths = allFcs.filter(fc => !fc.months || Object.keys(fc.months).length === 0);
  if (noMonths.length > 0) {
    warnings.push({
      title: 'Empty Forecast Records',
      text: `${noMonths.length} forecast record${noMonths.length > 1 ? 's' : ''} have no monthly data and will not appear in any forecast totals.`
    });
  }

  if (warnings.length === 0) return null;

  const section = el('div', { class: 'card mb-16', style: 'border-left:4px solid #f59e0b' });
  section.appendChild(el('div', { class: 'card-header' },
    el('div', { class: 'card-title' }, 'Forecast Data Quality')
  ));
  const body = el('div', { style: 'padding:0 16px 12px;display:flex;flex-direction:column;gap:10px' });
  for (const w of warnings) {
    const wRow = el('div', { style: 'display:flex;gap:8px;align-items:flex-start' });
    wRow.appendChild(el('span', { style: 'flex-shrink:0;color:#f59e0b;font-weight:700;font-size:13px' }, '⚠'));
    const txt = el('div', { style: 'flex:1' });
    txt.appendChild(el('div', { style: 'font-size:12px;font-weight:600;color:var(--text);margin-bottom:2px' }, w.title));
    txt.appendChild(el('div', { style: 'font-size:12px;color:var(--text-muted)' }, w.text));
    wRow.appendChild(txt);
    if (w.action) {
      const btn = el('button', { style: 'flex-shrink:0;font-size:11px;padding:3px 10px;border:1px solid #f59e0b;border-radius:4px;background:none;color:#f59e0b;cursor:pointer;white-space:nowrap' }, w.action.label);
      btn.onclick = w.action.fn;
      wRow.appendChild(btn);
    }
    body.appendChild(wRow);
  }
  section.appendChild(body);
  return section;
}

// ── Chart section builder ─────────────────────────────────────────────────────
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

function cardSection(title, content) {
  const card = el('div', { class: 'card mb-16' });
  const body = el('div', { style: 'padding:0 16px 16px' });
  body.appendChild(content);

  const header = el('div', {
    class: 'card-header',
    style: 'cursor:pointer;user-select:none;display:flex;align-items:center;justify-content:space-between'
  });
  header.appendChild(el('div', { class: 'card-title' }, title));
  const chevron = el('span', { style: 'font-size:11px;color:var(--text-muted);display:inline-block;transition:transform 200ms' }, '▼');
  header.appendChild(chevron);

  let collapsed = false;
  header.onclick = () => {
    collapsed = !collapsed;
    body.style.display = collapsed ? 'none' : '';
    chevron.style.transform = collapsed ? 'rotate(-90deg)' : '';
  };

  card.appendChild(header);
  card.appendChild(body);
  return card;
}

// ── Breakdown tables ──────────────────────────────────────────────────────────
function buildMonthlyTable(data) {
  const filtered = data.monthlyBreakdown
    .filter(m => m.fcRev > 0 || m.actRev > 0 || m.fcExp > 0 || m.actExp > 0);
  if (!filtered.length) {
    return el('p', { style: 'color:var(--text-muted);padding:12px 0;margin:0' }, 'No forecast data found for the selected period.');
  }
  const headers = [
    { label: 'Month' },
    { label: 'Fc Revenue',  right: true },
    { label: 'Actual Rev',  right: true },
    { label: 'Variance',    right: true },
    { label: 'Var %',       right: true },
    { label: 'Fc OpEx',     right: true },
    { label: 'Actual OpEx', right: true },
    { label: 'Fc Net',      right: true },
    { label: 'Actual Net',  right: true }
  ];
  const rows = filtered.map(m => [
    m.label,
    formatEUR(m.fcRev),
    formatEUR(m.actRev),
    fmtVar(m.actRev, m.fcRev),
    fmtVarPct(m.actRev, m.fcRev),
    formatEUR(m.fcExp),
    formatEUR(m.actExp),
    formatEUR(m.fcNet),
    formatEUR(m.actNet)
  ]);
  return mkModalTable(headers, rows);
}

function buildStreamTable(data) {
  if (!data.streamBreakdown.length) {
    return el('p', { style: 'color:var(--text-muted);padding:12px 0;margin:0' }, 'No stream data available.');
  }
  const headers = [
    { label: 'Stream' },
    { label: 'Forecast', right: true },
    { label: 'Actual',   right: true },
    { label: 'Variance', right: true },
    { label: 'Var %',    right: true }
  ];
  const rows = data.streamBreakdown.map(s => [
    s.label,
    formatEUR(s.fcRev),
    formatEUR(s.actRev),
    fmtVar(s.actRev, s.fcRev),
    fmtVarPct(s.actRev, s.fcRev)
  ]);
  return mkModalTable(headers, rows);
}

function buildPropertyTable(data) {
  if (!data.propertyBreakdown.length) {
    return el('p', { style: 'color:var(--text-muted);padding:12px 0;margin:0' }, 'No property data available.');
  }
  const hasPending = data.propertyBreakdown.some(r => r.pending > 0);

  // Build table manually so we can add Edit buttons per row
  const table = el('table', { class: 'table' });
  const htr = el('tr');
  ['Property', 'Forecast', 'Actual', 'Variance', 'Var %', ...(hasPending ? ['Pending'] : []), ''].forEach((lbl, i) => {
    const isRight = i > 0 && i < (hasPending ? 6 : 5);
    htr.appendChild(el('th', { class: isRight ? 'right' : '' }, lbl));
  });
  table.appendChild(el('thead', {}, htr));

  const tbody = el('tbody');
  data.propertyBreakdown.forEach(r => {
    const tr = el('tr');
    [
      r.label,
      formatEUR(r.fcRev),
      formatEUR(r.actRev),
      fmtVar(r.actRev, r.fcRev),
      fmtVarPct(r.actRev, r.fcRev),
      ...(hasPending ? [r.pending > 0 ? formatEUR(r.pending) : '—'] : [])
    ].forEach((val, i) => {
      const isRight = i > 0;
      tr.appendChild(el('td', { class: isRight ? 'right num' : '' }, String(val)));
    });

    // Edit button cell
    const editTd = el('td', { style: 'text-align:center;padding:4px 8px' });
    const editBtn = el('button', {
      class: 'btn',
      style: 'font-size:11px;padding:2px 8px;line-height:1.4',
      title: `Edit forecast for ${r.label}`
    }, 'Edit');
    editBtn.onclick = () => openForecastEditModal(r, data);
    editTd.appendChild(editBtn);
    tr.appendChild(editTd);
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);

  const wrap = el('div', { class: 'table-wrap' });
  wrap.appendChild(table);
  return wrap;
}

// Open a modal to quick-edit a property's forecast targets for the active year
function openForecastEditModal(propRow, data) {
  const curRange  = getCurrentPeriodRange(gF);
  const year      = parseInt((curRange?.start || '').slice(0, 4)) || new Date().getFullYear();

  // Find existing forecast record for this property + year
  const allFcs    = listActive('forecasts');
  const existing  = allFcs.find(fc => fc.type === 'property' && fc.entityId === propRow.propId && fc.year === year);

  // Compute current annual revenue + expense totals from months
  let curFcRev = 0, curFcExp = 0;
  if (existing?.months) {
    Object.values(existing.months).forEach(md => {
      const entries = Array.isArray(md.entries) ? md.entries : [];
      curFcRev += entries.length > 0 ? entries.reduce((s, e) => s + (Number(e.amount) || 0), 0) : Number(md.revenue) || 0;
      curFcExp += Number(md.expenses) || 0;
    });
  }

  // Inputs
  const revInput = input({ type: 'number', value: String(Math.round(curFcRev)), min: '0', step: '1', style: 'width:100%' });
  const expInput = input({ type: 'number', value: String(Math.round(curFcExp)), min: '0', step: '1', style: 'width:100%' });

  const saveBtn = button('Save', {
    variant: 'primary',
    onClick: () => {
      const newRev = Number(revInput.value) || 0;
      const newExp = Number(expInput.value) || 0;
      const monthlyRev = Math.round(newRev / 12);
      const monthlyExp = Math.round(newExp / 12);

      // Build months object distributing evenly across all 12 months
      const months = {};
      for (let m = 1; m <= 12; m++) {
        const mk = `${year}-${String(m).padStart(2, '0')}`;
        months[mk] = { revenue: monthlyRev, expenses: monthlyExp };
      }

      const record = existing
        ? { ...existing, months }
        : { id: newId('fc'), type: 'property', entityId: propRow.propId, year, months };

      upsert('forecasts', record);
      markDirty();
      rebuildView();
      toast(`Forecast for ${propRow.label} updated`, 'success');
    }
  });

  const body = el('div', { style: 'display:flex;flex-direction:column;gap:12px' });
  body.appendChild(el('div', { style: 'font-size:12px;color:var(--text-muted);margin-bottom:4px' },
    `Editing annual forecast for ${year}. Revenue and expenses will be distributed evenly across all 12 months.`
  ));
  body.appendChild(formRow(`Revenue Target (€) — ${year}`, revInput));
  body.appendChild(formRow(`Expense Target (€) — ${year}`, expInput));
  body.appendChild(el('div', { style: 'display:flex;justify-content:flex-end;margin-top:8px' }, saveBtn));

  openModal({ title: `Edit Forecast — ${propRow.label}`, body });
}

function buildPendingTable(data) {
  if (!data.pendingReservations.length) {
    return el('p', { style: 'color:var(--text-muted);padding:12px 0;margin:0' }, 'No pending Airbnb reservations found for the selected period.');
  }
  const headers = [
    { label: 'Property' },
    { label: 'Confirmation' },
    { label: 'Guest' },
    { label: 'Check-in' },
    { label: 'Check-out' },
    { label: 'Nights',  right: true },
    { label: 'Amount',  right: true }
  ];
  const rows = data.pendingReservations
    .map(p => ({
      prop:     byId('properties', p.propertyId)?.name || '—',
      code:     p.confirmationCode || p.airbnbRef || '—',
      guest:    (p.notes || '').split(' · ')[0] || '—',
      checkIn:  p.airbnbCheckIn || '—',
      checkOut: p.airbnbCheckOut || '—',
      nights:   String(p.airbnbNights || '—'),
      amount:   formatEUR(toEUR(p.amount, p.currency || 'EUR', p.airbnbCheckIn || p.date))
    }))
    .sort((a, b) => (a.checkIn || '').localeCompare(b.checkIn || ''))
    .map(r => [r.prop, r.code, r.guest, r.checkIn, r.checkOut, r.nights, r.amount]);
  return mkModalTable(headers, rows);
}

// ── Chart rendering ───────────────────────────────────────────────────────────
function renderCharts(data) {
  const { months, fcMonthlyRev, fcMonthlyExp,
          streamBreakdown, propertyBreakdown } = data;

  const labels = months.map(m => m.label);

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
        const body = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });

        // Actual vs Budget summary
        const summaryBoxes = el('div', { style: 'display:grid;grid-template-columns:repeat(3,1fr);gap:8px' });
        summaryBoxes.appendChild(mkSummaryBox('Actual Revenue', formatEUR(m.actRev)));
        summaryBoxes.appendChild(mkSummaryBox('Budget (Forecast)', formatEUR(m.fcRev)));
        summaryBoxes.appendChild(mkSummaryBox('Variance', fmtVar(m.actRev, m.fcRev), fmtVarPct(m.actRev, m.fcRev)));
        body.appendChild(mkSectionLabel('Actual vs Budget'));
        body.appendChild(summaryBoxes);

        // Stream breakdown for this month
        const streamMap = new Map();
        m.payments.forEach(p => {
          const s = resolveStream(p) || 'other';
          streamMap.set(s, (streamMap.get(s) || 0) + toEUR(p.amount, p.currency, p.date));
        });
        m.invoices.forEach(i => {
          const s = resolveStream(i) || 'other';
          streamMap.set(s, (streamMap.get(s) || 0) + toEUR(i.total || i.amount, i.currency, i.issueDate || i.date));
        });
        const streamRows = [...streamMap.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([key, val]) => [STREAMS[key]?.label || key, formatEUR(val)]);
        if (streamRows.length > 0) {
          body.appendChild(mkSectionLabel('Breakdown by Stream'));
          body.appendChild(mkModalTable(['Stream', 'Actual Revenue'], streamRows));
        }

        openModal({ title: `${m.label} — Revenue Detail`, body, large: true });
      }
    });
  }

  // 2. Forecast Variance % — render whenever forecast or actual data exists (zero variance is meaningful)
  if (fcRevData.some(v => v > 0) || revData.some(v => v > 0)) {
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
        const body = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });

        // Variance detail summary
        const summaryBoxes = el('div', { style: 'display:grid;grid-template-columns:repeat(3,1fr);gap:8px' });
        summaryBoxes.appendChild(mkSummaryBox('Actual Revenue', formatEUR(m.actRev)));
        summaryBoxes.appendChild(mkSummaryBox('Budget (Forecast)', formatEUR(m.fcRev)));
        summaryBoxes.appendChild(mkSummaryBox('Variance', fmtVar(m.actRev, m.fcRev), fmtVarPct(m.actRev, m.fcRev)));
        body.appendChild(mkSectionLabel('Variance Detail'));
        body.appendChild(summaryBoxes);

        // Stream breakdown for this month
        const streamMap = new Map();
        m.payments.forEach(p => {
          const s = resolveStream(p) || 'other';
          streamMap.set(s, (streamMap.get(s) || 0) + toEUR(p.amount, p.currency, p.date));
        });
        m.invoices.forEach(i => {
          const s = resolveStream(i) || 'other';
          streamMap.set(s, (streamMap.get(s) || 0) + toEUR(i.total || i.amount, i.currency, i.issueDate || i.date));
        });
        const streamRows = [...streamMap.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([key, val]) => [STREAMS[key]?.label || key, formatEUR(val)]);
        if (streamRows.length > 0) {
          body.appendChild(mkSectionLabel('Breakdown by Stream'));
          body.appendChild(mkModalTable(['Stream', 'Actual Revenue'], streamRows));
        }

        openModal({ title: `${m.label} — Variance Detail`, body, large: true });
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
      ],
      onClickItem: (_lbl, idx) => {
        const m = data.monthlyBreakdown[idx];
        if (!m) return;
        const body = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });

        // Revenue, expenses, net for actual and forecast
        const summaryBoxes = el('div', { style: 'display:grid;grid-template-columns:repeat(3,1fr);gap:8px' });
        summaryBoxes.appendChild(mkSummaryBox('Actual Revenue',  formatEUR(m.actRev)));
        summaryBoxes.appendChild(mkSummaryBox('Actual OpEx',     formatEUR(m.actExp)));
        summaryBoxes.appendChild(mkSummaryBox('Actual Net',      formatEUR(m.actNet), m.actNet >= 0 ? 'positive' : 'negative'));
        body.appendChild(mkSectionLabel('Actual'));
        body.appendChild(summaryBoxes);

        const fcBoxes = el('div', { style: 'display:grid;grid-template-columns:repeat(3,1fr);gap:8px' });
        fcBoxes.appendChild(mkSummaryBox('Forecast Revenue', formatEUR(m.fcRev)));
        fcBoxes.appendChild(mkSummaryBox('Forecast OpEx',    formatEUR(m.fcExp)));
        fcBoxes.appendChild(mkSummaryBox('Forecast Net',     formatEUR(m.fcNet), fmtVar(m.actNet, m.fcNet) + ' vs forecast'));
        body.appendChild(mkSectionLabel('Forecast'));
        body.appendChild(fcBoxes);

        openModal({ title: `${m.label} — Net Comparison`, body, large: true });
      }
    });
  }

  // 4. Forecast Revenue by Stream (doughnut)
  const fcStreams = streamBreakdown.filter(s => s.fcRev > 0);
  if (fcStreams.length > 0) {
    charts.doughnut('anf-stream-rev', {
      labels: fcStreams.map(s => s.label),
      data:   fcStreams.map(s => Math.round(s.fcRev)),
      colors: fcStreams.map(s => STREAMS[s.key]?.color || '#6366f1'),
      onClickItem: (_lbl, idx) => {
        const s = fcStreams[idx];
        if (!s) return;
        const body = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });

        // Forecast vs actual summary for this stream
        const summaryBoxes = el('div', { style: 'display:grid;grid-template-columns:repeat(3,1fr);gap:8px' });
        summaryBoxes.appendChild(mkSummaryBox('Forecast Revenue', formatEUR(s.fcRev)));
        summaryBoxes.appendChild(mkSummaryBox('Actual Revenue',   formatEUR(s.actRev)));
        summaryBoxes.appendChild(mkSummaryBox('Variance',         fmtVar(s.actRev, s.fcRev), fmtVarPct(s.actRev, s.fcRev)));
        body.appendChild(mkSectionLabel('Forecast vs Actual'));
        body.appendChild(summaryBoxes);

        // Payments for this stream in the current period
        const streamPayments = data.actPayments.filter(p => (resolveStream(p) || 'other') === s.key);
        const streamInvoices = data.actInvoices.filter(i => (resolveStream(i) || 'other') === s.key);

        if (streamPayments.length > 0) {
          const payRows = streamPayments
            .slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''))
            .map(p => [fmtDate(p.date), byId('properties', p.propertyId)?.name || '—', p.confirmationCode || p.airbnbRef || '—', formatEUR(toEUR(p.amount, p.currency, p.date))]);
          body.appendChild(mkSectionLabel('Payments'));
          body.appendChild(mkModalTable(['Date', 'Property', 'Reference', 'Amount'], payRows));
        }

        if (streamInvoices.length > 0) {
          const invRows = streamInvoices
            .slice().sort((a, b) => (b.issueDate || '').localeCompare(a.issueDate || ''))
            .map(i => [fmtDate(i.issueDate), byId('clients', i.clientId)?.name || i.clientId || '—', i.ref || i.number || '—', formatEUR(toEUR(i.total || i.amount, i.currency, i.issueDate))]);
          body.appendChild(mkSectionLabel('Invoices'));
          body.appendChild(mkModalTable(['Date', 'Client', 'Reference', 'Amount'], invRows));
        }

        openModal({ title: `${s.label} — Stream Detail`, body, large: true });
      }
    });
  }

  // 5. Actual vs Forecast by Stream
  if (streamBreakdown.length > 0) {
    charts.bar('anf-stream-compare', {
      labels: streamBreakdown.map(s => s.label),
      datasets: [
        { label: 'Actual',   data: streamBreakdown.map(s => Math.round(s.actRev)), backgroundColor: '#10b981' },
        { label: 'Forecast', data: streamBreakdown.map(s => Math.round(s.fcRev)),  backgroundColor: '#6366f1' }
      ],
      onClickItem: (_lbl, idx) => {
        const s = streamBreakdown[idx];
        if (!s) return;
        const body = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });

        // Actual vs Budget summary
        const summaryBoxes = el('div', { style: 'display:grid;grid-template-columns:repeat(3,1fr);gap:8px' });
        summaryBoxes.appendChild(mkSummaryBox('Actual Revenue', formatEUR(s.actRev)));
        summaryBoxes.appendChild(mkSummaryBox('Budget (Forecast)', formatEUR(s.fcRev)));
        summaryBoxes.appendChild(mkSummaryBox('Variance', fmtVar(s.actRev, s.fcRev), fmtVarPct(s.actRev, s.fcRev)));
        body.appendChild(mkSectionLabel('Actual vs Budget'));
        body.appendChild(summaryBoxes);

        // Monthly trend for this stream
        const monthlyRows = data.monthlyBreakdown.map(m => {
          let mAct = 0;
          m.payments.forEach(p => { if ((resolveStream(p) || 'other') === s.key) mAct += toEUR(p.amount, p.currency, p.date); });
          m.invoices.forEach(i => { if ((resolveStream(i) || 'other') === s.key) mAct += toEUR(i.total || i.amount, i.currency, i.issueDate || i.date); });
          return [m.label, formatEUR(mAct)];
        }).filter(([, val]) => val !== formatEUR(0));
        if (monthlyRows.length > 0) {
          body.appendChild(mkSectionLabel('Monthly Trend'));
          body.appendChild(mkModalTable(['Month', 'Actual Revenue'], monthlyRows));
        }

        openModal({ title: `${s.label} — Stream Detail`, body, large: true });
      }
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
      horizontal: true,
      onClickItem: (_lbl, idx) => {
        const prop = topProps[idx];
        if (!prop) return;
        const body = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });

        // Actual vs Budget summary
        const summaryBoxes = el('div', { style: 'display:grid;grid-template-columns:repeat(3,1fr);gap:8px' });
        summaryBoxes.appendChild(mkSummaryBox('Actual Revenue', formatEUR(prop.actRev)));
        summaryBoxes.appendChild(mkSummaryBox('Budget (Forecast)', formatEUR(prop.fcRev)));
        summaryBoxes.appendChild(mkSummaryBox('Variance', fmtVar(prop.actRev, prop.fcRev), fmtVarPct(prop.actRev, prop.fcRev)));
        body.appendChild(mkSectionLabel('Actual vs Budget'));
        body.appendChild(summaryBoxes);

        // Monthly revenue breakdown for this property
        const monthlyRows = data.monthlyBreakdown.map(m => {
          const mAct = m.payments
            .filter(p => p.propertyId === prop.propId)
            .reduce((s, p) => s + toEUR(p.amount, p.currency, p.date), 0);
          const mFc = data.fcPropMonthlyRev.get(m.key + '_' + prop.propId) || 0;
          return [m.label, formatEUR(mAct), formatEUR(mFc || 0), fmtVar(mAct, mFc || 0)];
        }).filter(([, act]) => act !== formatEUR(0));
        if (monthlyRows.length > 0) {
          body.appendChild(mkSectionLabel('Monthly Revenue Breakdown'));
          body.appendChild(mkModalTable(['Month', 'Actual', 'Forecast', 'Variance'], monthlyRows));
        }

        openModal({ title: `${prop.label} — Property Detail`, body, large: true });
      }
    });
  }

  // 7. Pending Pipeline by Check-in Month — all entity-filtered pending (forward-looking)
  const pendingMap = new Map();
  data.allPendingReservations.forEach(p => {
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
      datasets: [{ label: 'Pending', data: sortedPendingKeys.map(mk => Math.round(pendingMap.get(mk) || 0)), backgroundColor: '#3b82f6' }],
      onClickItem: (_lbl, idx) => {
        const mk = sortedPendingKeys[idx];
        if (!mk) return;
        const monthPending = data.allPendingReservations.filter(p => (p.airbnbCheckIn || p.date || '').slice(0, 7) === mk);
        const [y, m] = mk.split('-');
        const monthLabel = `${ML9[parseInt(m) - 1]} ${y}`;
        const body = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });

        const total = monthPending.reduce((s, p) => s + toEUR(p.amount, p.currency || 'EUR', p.airbnbCheckIn || p.date), 0);
        const summaryBoxes = el('div', { style: 'display:grid;grid-template-columns:repeat(2,1fr);gap:8px' });
        summaryBoxes.appendChild(mkSummaryBox('Total Pending', formatEUR(total)));
        summaryBoxes.appendChild(mkSummaryBox('Reservations', String(monthPending.length)));
        body.appendChild(mkSectionLabel('Pipeline Summary'));
        body.appendChild(summaryBoxes);

        const pendingRows = monthPending
          .sort((a, b) => (a.airbnbCheckIn || '').localeCompare(b.airbnbCheckIn || ''))
          .map(p => [
            byId('properties', p.propertyId)?.name || '—',
            p.confirmationCode || p.airbnbRef || '—',
            p.airbnbCheckIn || '—',
            String(p.airbnbNights || '—'),
            formatEUR(toEUR(p.amount, p.currency || 'EUR', p.airbnbCheckIn || p.date))
          ]);
        if (pendingRows.length > 0) {
          body.appendChild(mkSectionLabel('Pending Invoices'));
          body.appendChild(mkModalTable(['Property', 'Confirmation', 'Check-in', 'Nights', 'Amount'], pendingRows));
        }

        openModal({ title: `Pending Pipeline — ${monthLabel}`, body, large: true });
      }
    });
  }

  // 8. Pending by Property — all entity-filtered pending (forward-looking)
  const propPendingMap = new Map(); // propId -> { label, total, reservations[] }
  data.allPendingReservations.forEach(p => {
    if (!p.propertyId) return;
    const label = byId('properties', p.propertyId)?.name || p.propertyId;
    const entry = propPendingMap.get(p.propertyId) || { label, total: 0, reservations: [] };
    entry.total += toEUR(p.amount, p.currency || 'EUR', p.airbnbCheckIn || p.date);
    entry.reservations.push(p);
    propPendingMap.set(p.propertyId, entry);
  });
  const propPendingEntries = [...propPendingMap.entries()].sort((a, b) => b[1].total - a[1].total);
  if (propPendingEntries.length > 0) {
    charts.bar('anf-pending-by-prop', {
      labels: propPendingEntries.map(([, e]) => e.label),
      datasets: [{ label: 'Pending Pipeline', data: propPendingEntries.map(([, e]) => Math.round(e.total)), backgroundColor: '#3b82f6' }],
      horizontal: true,
      onClickItem: (_lbl, idx) => {
        const [, entry] = propPendingEntries[idx];
        if (!entry) return;
        const body = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });

        const summaryBoxes = el('div', { style: 'display:grid;grid-template-columns:repeat(2,1fr);gap:8px' });
        summaryBoxes.appendChild(mkSummaryBox('Total Pending', formatEUR(entry.total)));
        summaryBoxes.appendChild(mkSummaryBox('Reservations', String(entry.reservations.length)));
        body.appendChild(mkSectionLabel('Pipeline Summary'));
        body.appendChild(summaryBoxes);

        const pendingRows = entry.reservations
          .sort((a, b) => (a.airbnbCheckIn || '').localeCompare(b.airbnbCheckIn || ''))
          .map(p => [
            p.confirmationCode || p.airbnbRef || '—',
            p.airbnbCheckIn || '—',
            p.airbnbCheckOut || '—',
            String(p.airbnbNights || '—'),
            formatEUR(toEUR(p.amount, p.currency || 'EUR', p.airbnbCheckIn || p.date))
          ]);
        if (pendingRows.length > 0) {
          body.appendChild(mkSectionLabel('Pending Invoices'));
          body.appendChild(mkModalTable(['Confirmation', 'Check-in', 'Check-out', 'Nights', 'Amount'], pendingRows));
        }

        openModal({ title: `${entry.label} — Pending Pipeline`, body, large: true });
      }
    });
  }

  // 9. Forecast Accuracy Trend — line chart of per-month absolute % error
  const accuracyTrendMonths = data.monthlyBreakdown.filter(m => m.fcRev > 0);
  if (accuracyTrendMonths.length > 0) {
    const accLabels = accuracyTrendMonths.map(m => m.label);
    const accData   = accuracyTrendMonths.map(m => {
      const pct = (Math.abs(m.actRev - m.fcRev) / m.fcRev) * 100;
      return Math.round(pct * 10) / 10;
    });

    // Reference lines at 10% (good), 20% (80% target), and 25% (poor) as constant-value datasets
    const goodLine   = accuracyTrendMonths.map(() => 10);
    const targetLine = accuracyTrendMonths.map(() => 20);
    const poorLine   = accuracyTrendMonths.map(() => 25);

    charts.line('anf-accuracy-trend', {
      labels: accLabels,
      datasets: [
        {
          label: 'Error %',
          data: accData,
          borderColor: '#6366f1',
          backgroundColor: 'rgba(99,102,241,0.08)',
          fill: true,
          tension: 0.3
        },
        {
          label: 'Good threshold (10%)',
          data: goodLine,
          borderColor: '#10b981',
          borderDash: [6, 3],
          borderWidth: 1.5,
          backgroundColor: 'transparent',
          pointRadius: 0,
          fill: false
        },
        {
          label: '80% Accuracy Target (20% error)',
          data: targetLine,
          borderColor: 'rgba(245,158,11,0.5)',
          borderDash: [4, 4],
          borderWidth: 1,
          backgroundColor: 'transparent',
          pointRadius: 0,
          fill: false
        },
        {
          label: 'Poor threshold (25%)',
          data: poorLine,
          borderColor: '#ef4444',
          borderDash: [6, 3],
          borderWidth: 1.5,
          backgroundColor: 'transparent',
          pointRadius: 0,
          fill: false
        }
      ],
      onClickItem: (_lbl, idx) => {
        const m = accuracyTrendMonths[idx];
        if (!m) return;
        const body = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });

        const absErr = Math.abs(m.actRev - m.fcRev);
        const pctErr = m.fcRev > 0 ? (absErr / m.fcRev) * 100 : null;

        const summaryBoxes = el('div', { style: 'display:grid;grid-template-columns:repeat(3,1fr);gap:8px' });
        summaryBoxes.appendChild(mkSummaryBox('Forecast', formatEUR(m.fcRev)));
        summaryBoxes.appendChild(mkSummaryBox('Actual', formatEUR(m.actRev)));
        summaryBoxes.appendChild(mkSummaryBox('Abs Error', formatEUR(absErr), pctErr !== null ? pctErr.toFixed(1) + '% error' : ''));
        body.appendChild(mkSectionLabel(`${m.label} — Accuracy Detail`));
        body.appendChild(summaryBoxes);

        // Stream breakdown for this month
        const streamMap = new Map();
        m.payments.forEach(p => {
          const s = resolveStream(p) || 'other';
          streamMap.set(s, (streamMap.get(s) || 0) + toEUR(p.amount, p.currency, p.date));
        });
        m.invoices.forEach(i => {
          const s = resolveStream(i) || 'other';
          streamMap.set(s, (streamMap.get(s) || 0) + toEUR(i.total || i.amount, i.currency, i.issueDate || i.date));
        });
        const streamRows = [...streamMap.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([key, val]) => [STREAMS[key]?.label || key, formatEUR(val)]);
        if (streamRows.length > 0) {
          body.appendChild(mkSectionLabel('Actual Revenue by Stream'));
          body.appendChild(mkModalTable(['Stream', 'Actual Revenue'], streamRows));
        }

        openModal({ title: `${m.label} — Forecast Accuracy`, body, large: true });
      }
    });
  }
}

// ── Main view builder ─────────────────────────────────────────────────────────
function buildView() {
  _ltRentCache = new Map(); // drop any stale lease-schedule projections from a prior render
  const wrap = el('div', { class: 'view active' });

  wrap.appendChild(el('div', { style: 'margin-bottom:16px' },
    el('h2', { style: 'margin:0 0 4px;font-size:20px;font-weight:700' }, 'Forecast Analysis'),
    el('p', { style: 'margin:0;font-size:13px;color:var(--text-muted)' },
      'Forecast vs actual performance, variance analysis, and pipeline visibility.')
  ));

  // TODO: re-enable showClient once service forecast entries support clientId
  wrap.appendChild(buildFilterBar(
    gF,
    { showOwner: true, showStream: true, showProperty: true, storagePrefix: 'ana_fc', channelScope: gScope === 'all' ? null : 'company' },
    newGF => { if (newGF) gF = newGF; rebuildView(); }
  ));

  // Scope toggle (Company only / All incl. personal)
  const scopeBar = el('div', { style: 'display:flex;align-items:center;gap:8px;margin-bottom:12px' });
  scopeBar.appendChild(el('span', { style: 'font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text-muted)' }, 'Scope'));
  for (const [val, label] of [['company', 'Company only'], ['all', 'All (incl. personal)']]) {
    const isActive = gScope === val;
    const btn = el('button', {
      style: [
        'padding:4px 14px;border-radius:14px;border:1px solid;font-size:12px;cursor:pointer;transition:all 120ms',
        isActive
          ? 'border-color:var(--accent);background:var(--accent);color:#fff;font-weight:600'
          : 'border-color:var(--border);background:transparent;color:var(--text-muted)'
      ].join(';')
    }, label);
    btn.onclick = () => { if (gScope !== val) { gScope = val; rebuildView(); } };
    scopeBar.appendChild(btn);
  }
  wrap.appendChild(scopeBar);

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
  wrap.appendChild(buildForecastInsights(data, cmpData));

  const dqSection = buildDataQualityWarnings();
  if (dqSection) wrap.appendChild(dqSection);

  if (!hasAnyData) {
    const emptyCard = el('div', { class: 'card mb-16' });
    const emptyBody = el('div', { style: 'padding:48px 32px;text-align:center;display:flex;flex-direction:column;align-items:center;gap:16px' });
    emptyBody.appendChild(el('div', { style: 'font-size:40px;opacity:0.25;line-height:1' }, '◈'));
    emptyBody.appendChild(el('div', { style: 'font-size:16px;font-weight:600;color:var(--text)' }, 'No Forecast or Actual Data'));
    emptyBody.appendChild(el('div', { style: 'font-size:13px;color:var(--text-muted);max-width:420px;line-height:1.6' },
      'No forecast or actual revenue data was found for the selected period and filters. Set up forecasts in the Forecast section to enable this comparison.'
    ));
    const goToFcBtn = el('button', {
      class: 'btn',
      style: 'margin-top:8px',
      onclick: () => {
        const nav = document.querySelector('[data-view="forecast"], [data-module="forecast"], a[href="#forecast"]');
        if (nav) nav.click();
      }
    }, 'Go to Forecast Section');
    emptyBody.appendChild(goToFcBtn);
    emptyCard.appendChild(emptyBody);
    wrap.appendChild(emptyCard);
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

  wrap.appendChild(makeChartSection('Forecast Accuracy', [
    ['Forecast Accuracy Trend', 'anf-accuracy-trend']
  ]));

  wrap.appendChild(cardSection('Monthly Forecast Breakdown', buildMonthlyTable(data)));
  wrap.appendChild(cardSection('Stream Breakdown',            buildStreamTable(data)));
  wrap.appendChild(cardSection('Property Breakdown',          buildPropertyTable(data)));
  wrap.appendChild(cardSection('Pending Airbnb Reservations', buildPendingTable(data)));
  wrap.appendChild(buildWhatIfCard(data));

  setTimeout(() => renderCharts(data), 0);

  return wrap;
}

// ── What-If Analysis ──────────────────────────────────────────────────────────
function buildWhatIfCard(data) {
  const { actualRev, actualExp, actualNet } = data;

  const card = el('div', { class: 'card mb-16' });
  card.appendChild(el('div', { class: 'card-header' },
    el('div', { class: 'card-title' }, 'What-If Analysis'),
    el('div', { style: 'font-size:12px;color:var(--text-muted)' }, 'Revenue sensitivity — not saved')
  ));

  const body = el('div', { style: 'padding:16px' });

  // Slider row
  const sliderLabel = el('div', { style: 'font-size:13px;margin-bottom:8px;color:var(--text)' }, 'Revenue change scenario: 0%');
  const slider = el('input', {
    type:  'range',
    min:   '-30',
    max:   '30',
    value: '0',
    step:  '1',
    style: 'width:100%;accent-color:#6366f1;cursor:pointer'
  });
  body.appendChild(sliderLabel);
  body.appendChild(slider);

  // Range labels
  body.appendChild(el('div', { style: 'display:flex;justify-content:space-between;font-size:11px;color:var(--text-muted);margin-top:2px;margin-bottom:16px' },
    el('span', {}, '−30%'),
    el('span', {}, '0%'),
    el('span', {}, '+30%')
  ));

  // Output summary box
  const summaryBox = el('div', {
    style: 'display:grid;grid-template-columns:repeat(3,1fr);gap:12px;padding:14px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:6px'
  });

  const makeResultLine = (label, valEl) => {
    const wrap = el('div', { style: 'display:flex;flex-direction:column;gap:2px' });
    wrap.appendChild(el('div', { style: 'font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.05em' }, label));
    wrap.appendChild(valEl);
    return wrap;
  };

  const adjRevEl  = el('div', { style: 'font-size:16px;font-weight:700;color:var(--text)' }, formatEUR(actualRev));
  const adjNetEl  = el('div', { style: 'font-size:16px;font-weight:700' }, formatEUR(actualNet));
  const adjDeltaEl = el('div', { style: 'font-size:13px;color:var(--text-muted)' }, '0% change');

  summaryBox.appendChild(makeResultLine('Adjusted Revenue', adjRevEl));
  summaryBox.appendChild(makeResultLine('Adjusted Net', adjNetEl));
  summaryBox.appendChild(makeResultLine('Revenue Impact', adjDeltaEl));
  body.appendChild(summaryBox);

  // Note
  body.appendChild(el('div', { style: 'margin-top:12px;font-size:11px;color:var(--text-muted);font-style:italic' },
    'This is a sensitivity analysis only — not saved to forecast data. Adjusts actual revenue by the selected percentage and recalculates net.'
  ));

  // Slider event
  slider.oninput = () => {
    const pct     = Number(slider.value);
    const adjRev  = actualRev * (1 + pct / 100);
    const adjNet  = adjRev - actualExp;
    const delta   = adjRev - actualRev;

    sliderLabel.textContent = `Revenue change scenario: ${pct >= 0 ? '+' : ''}${pct}%`;
    adjRevEl.textContent    = formatEUR(adjRev);
    adjNetEl.textContent    = formatEUR(adjNet);
    adjNetEl.style.color    = adjNet >= 0 ? '#10b981' : '#ef4444';
    adjDeltaEl.textContent  = `${pct >= 0 ? '+' : ''}${formatEUR(delta)}`;
    adjDeltaEl.style.color  = delta >= 0 ? '#10b981' : '#ef4444';
  };

  card.appendChild(body);
  return card;
}
