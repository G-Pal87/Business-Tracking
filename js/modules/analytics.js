// Executive Analytics Dashboard
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
  getMonthKeysForRange, makeMatchers, buildFilterBar, buildComparisonLine
} from './analytics-filters.js';

// ── Constants ────────────────────────────────────────────────────────────────
const ALL_CHART_IDS = [
  'exec-trend-rev', 'exec-trend-profit', 'exec-rev-vs-profit',
  'exec-rev-growth', 'exec-kd-rev-stream', 'exec-rev-conc',
  'exec-opex-capex', 'exec-outstanding-aging'
];

// ── Property helpers ─────────────────────────────────────────────────────────
function propStream(p) {
  return p.type === 'short_term' ? 'short_term_rental'
       : p.type === 'long_term'  ? 'long_term_rental'
       : null;
}

function propTypeLabel(type) {
  return type === 'short_term' ? 'Short-term'
       : type === 'long_term'  ? 'Long-term'
       : type || '—';
}

function applyPropertyFilters(props) {
  return props.filter(p => {
    if (gF.owners.size > 0) {
      const ow = p.owner || 'both';
      if (ow !== 'both' && !gF.owners.has(ow)) return false;
    }
    if (gF.streams.size > 0) {
      const s = propStream(p);
      if (!s || !gF.streams.has(s)) return false;
    }
    if (gF.propertyIds.size > 0 && !gF.propertyIds.has(p.id)) return false;
    return true;
  });
}

// ── Filtered forecast map builder ────────────────────────────────────────────
// Returns Map<YYYY-MM, EUR> for forecast revenue, respecting gF filters.
// Mirrors the logic in analytics-forecast.js buildFcMaps() — kept in sync.
function buildFilteredFcMap(startY, endY) {
  const fcMonthlyRev = new Map();
  const allFcs = listActive('forecasts');
  for (let y = startY; y <= endY; y++) {
    allFcs.filter(fc => fc.year === y).forEach(fc => {
      if (gF.propertyIds.size > 0 && fc.type === 'property' && !gF.propertyIds.has(fc.entityId)) return;
      if (gF.streams.size > 0) {
        const stream = fc.type === 'service' ? fc.entityId : propStream(byId('properties', fc.entityId));
        if (!stream || !gF.streams.has(stream)) return;
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
      });
    });
  }
  return fcMonthlyRev;
}

// ── Executive decision thresholds (deterministic, adjust here) ───────────────
const EXEC_T = {
  collectionRate: { healthy: 90, watch: 75 },  // % — below watch = At Risk
  opMargin:       { healthy: 20, watch: 5  },  // % — below watch = At Risk; negative = At Risk
  expenseRatio:   { watch: 50, atRisk: 75  },  // % — above atRisk = At Risk; above watch = Watch
  revConc:        { watch: 40, atRisk: 60  },  // % top-source share — above atRisk = At Risk
};

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
const PROP_COLS = [
  { key: 'name',    label: 'Property' },
  { key: 'type',    label: 'Type' },
  { key: 'status',  label: 'Status' },
  { key: 'owner',   label: 'Owner' },
  { key: 'city',    label: 'City' },
  { key: 'country', label: 'Country' },
  { key: 'eur',     label: 'Purchase Value EUR', right: true, format: v => v > 0 ? formatEUR(v) : '—' }
];
const PORTVAL_COLS = [
  { key: 'name',      label: 'Property' },
  { key: 'type',      label: 'Type' },
  { key: 'status',    label: 'Status' },
  { key: 'owner',     label: 'Owner' },
  { key: 'purchDate', label: 'Purchase Date', format: v => fmtDate(v) },
  { key: 'price',     label: 'Purchase Price', right: true, format: v => v > 0 ? formatEUR(v) : '—' },
  { key: 'currency',  label: 'Currency' },
  { key: 'eur',       label: 'EUR Value', right: true, format: v => v > 0 ? formatEUR(v) : '—' }
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

// ── Filtered active properties (respects gF filters) ────────────────────────
function getFilteredProperties() {
  return applyPropertyFilters(listActive('properties').filter(p => p.status === 'active'));
}

// ── Virtual property acquisitions ────────────────────────────────────────────
function getVirtualAcquisitions() {
  return applyPropertyFilters(listActive('properties').filter(p => p.purchasePrice > 0 && p.purchaseDate))
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

  // Pending pipeline — scoped to selected period via airbnbCheckIn (fallback: date)
  const pendingReservations = listActivePayments().filter(p => {
    if (p.source !== 'airbnb' || p.status !== 'pending') return false;
    const checkDate = p.airbnbCheckIn || p.date;
    if (range && (!checkDate || checkDate < range.start || checkDate > range.end)) return false;
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

  // Forecast: filtered forecast revenue for the selected period and active filters.
  let fcRev = null;
  let fcMonthlyRev = null; // retained for KPI drilldown and chart overlay
  if (range) {
    const startY = parseInt(range.start.slice(0, 4));
    const endY   = parseInt(range.end.slice(0, 4));
    fcMonthlyRev = buildFilteredFcMap(startY, endY);
    const { keys: months } = getMonthKeysForRange(range.start, range.end);
    const total = months.reduce((s, m) => s + (fcMonthlyRev.get(m.key) || 0), 0);
    if (total > 0) fcRev = total;
  }

  const filteredProperties = getFilteredProperties();
  const portfolioValueEUR = filteredProperties.reduce((s, p) =>
    s + (p.purchasePrice > 0 ? toEUR(p.purchasePrice, p.currency || 'EUR', p.purchaseDate) : 0), 0);

  return {
    rev, opEx, capExFromExp, capExFromAcq, capEx,
    opProfit, opMargin, netCash, expenseRatio,
    collectionRate,
    pendingReservations, pendingPipeline,
    outstanding, outstandingTotal, fcRev, fcMonthlyRev,
    payments, invoices, opExpenses, capExExpenses, acquisitions,
    filteredProperties, portfolioValueEUR
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

// ── Rebuild ──────────────────────────────────────────────────────────────────
function rebuildView() {
  ALL_CHART_IDS.forEach(id => charts.destroy(id));
  const c = document.getElementById('content');
  if (!c) return;
  c.innerHTML = '';
  c.appendChild(buildView());
}


// ── Executive Health Snapshot ─────────────────────────────────────────────────
function buildHealthSnapshot(curMetrics, cmpMetrics, curRange) {
  const { rev, opProfit, opMargin, netCash, collectionRate, expenseRatio,
          fcRev, outstandingTotal, outstanding, filteredProperties, portfolioValueEUR } = curMetrics;

  const issues = []; // { severity: 'watch'|'risk', text, inspect }

  // Revenue growth vs comparison
  const revGrowth = cmpMetrics ? safePct(rev, cmpMetrics.rev) : null;
  if (revGrowth !== null && revGrowth < -10) {
    issues.push({ severity: 'watch', text: `Revenue down ${Math.abs(revGrowth).toFixed(0)}% vs comparison period`, inspect: 'Revenue Dashboard' });
  }

  // Operating margin
  if (opMargin !== null) {
    if (opMargin < 0) {
      issues.push({ severity: 'risk', text: `Operating margin is negative (${opMargin.toFixed(1)}%)`, inspect: 'Expenses Dashboard' });
    } else if (opMargin < EXEC_T.opMargin.watch) {
      issues.push({ severity: 'watch', text: `Operating margin is low (${opMargin.toFixed(1)}%)`, inspect: 'Expenses Dashboard' });
    }
  }

  // Net cash flow
  if (netCash < 0) {
    issues.push({ severity: 'risk', text: `Net cash flow negative (${formatEUR(netCash)})`, inspect: 'Cash Flow Dashboard' });
  }

  // Expense ratio
  if (expenseRatio !== null) {
    if (expenseRatio > EXEC_T.expenseRatio.atRisk) {
      issues.push({ severity: 'risk', text: `Expense ratio high (${expenseRatio.toFixed(1)}% — OpEx/Revenue)`, inspect: 'Expenses Dashboard' });
    } else if (expenseRatio > EXEC_T.expenseRatio.watch) {
      issues.push({ severity: 'watch', text: `Expense ratio elevated (${expenseRatio.toFixed(1)}% — OpEx/Revenue)`, inspect: 'Expenses Dashboard' });
    }
  }

  // Collection rate
  if (collectionRate !== null) {
    if (collectionRate < EXEC_T.collectionRate.watch) {
      issues.push({ severity: 'risk', text: `Collection rate low (${collectionRate.toFixed(1)}%)`, inspect: 'Services Dashboard' });
    } else if (collectionRate < EXEC_T.collectionRate.healthy) {
      issues.push({ severity: 'watch', text: `Collection rate below target (${collectionRate.toFixed(1)}%)`, inspect: 'Services Dashboard' });
    }
  }

  // Outstanding — overdue check then ratio-based watch
  const overdueCount = outstanding.filter(i => {
    const days = Math.floor((Date.now() - new Date(i.issueDate).getTime()) / 86400000);
    return days > 60;
  }).length;
  if (overdueCount > 0) {
    issues.push({ severity: 'risk', text: `${overdueCount} invoice${overdueCount > 1 ? 's' : ''} overdue 60+ days (${formatEUR(outstandingTotal)} total outstanding)`, inspect: 'Services Dashboard' });
  } else if (outstandingTotal > 0) {
    if (rev > 0) {
      const outRatio = (outstandingTotal / rev) * 100;
      if (outRatio >= 50) {
        issues.push({ severity: 'risk', text: `Outstanding is ${outRatio.toFixed(0)}% of revenue (${formatEUR(outstandingTotal)})`, inspect: 'Services Dashboard' });
      } else if (outRatio >= 25) {
        issues.push({ severity: 'watch', text: `Outstanding is ${outRatio.toFixed(0)}% of revenue (${formatEUR(outstandingTotal)})`, inspect: 'Services Dashboard' });
      }
    } else if (outstandingTotal > 5000) {
      issues.push({ severity: 'watch', text: `${formatEUR(outstandingTotal)} in unpaid invoices (no revenue in period)`, inspect: 'Services Dashboard' });
    }
  }

  // Forecast gap
  if (fcRev != null && fcRev > 0 && rev < fcRev * 0.85) {
    const pct = ((rev / fcRev) * 100).toFixed(0);
    issues.push({ severity: 'watch', text: `Revenue at ${pct}% of forecast (${formatEUR(fcRev - rev)} gap)`, inspect: 'Forecast Dashboard' });
  }

  // Overall score
  const hasRisk  = issues.some(i => i.severity === 'risk');
  const hasWatch = issues.some(i => i.severity === 'watch');
  const score    = hasRisk ? 'At Risk' : hasWatch ? 'Watch' : 'Healthy';
  const SCORE_COLOR = { Healthy: '#10b981', Watch: '#f59e0b', 'At Risk': '#ef4444' };
  const SCORE_BG    = { Healthy: 'rgba(16,185,129,0.06)', Watch: 'rgba(245,158,11,0.06)', 'At Risk': 'rgba(239,68,68,0.06)' };

  // Executive summary sentence
  let summary;
  if (score === 'Healthy') {
    const parts = [];
    if (revGrowth !== null && revGrowth > 0) parts.push(`revenue up ${revGrowth.toFixed(0)}%`);
    if (opMargin !== null && opMargin >= EXEC_T.opMargin.healthy) parts.push('margins healthy');
    if (collectionRate !== null && collectionRate >= EXEC_T.collectionRate.healthy) parts.push('collections on track');
    if (netCash >= 0) parts.push('cash flow positive');
    summary = parts.length > 0
      ? parts.join(', ').replace(/^./, c => c.toUpperCase()) + '.'
      : 'All key metrics within healthy ranges.';
  } else {
    const topIssue = issues.find(i => i.severity === 'risk') || issues[0];
    const rest = issues.length - 1;
    summary = topIssue.text.charAt(0).toUpperCase() + topIssue.text.slice(1) +
      (rest > 0 ? `, plus ${rest} other item${rest > 1 ? 's' : ''} need attention.` : '.');
  }

  // Build card
  const card = el('div', {
    class: 'card mb-16',
    style: `border-left:4px solid ${SCORE_COLOR[score]};background:${SCORE_BG[score]}`
  });
  const header = el('div', { class: 'card-header', style: 'padding-bottom:8px' });
  const titleRow = el('div', { style: 'display:flex;align-items:center;gap:12px;flex-wrap:wrap' });
  titleRow.appendChild(el('div', { class: 'card-title' }, 'Executive Health Snapshot'));
  titleRow.appendChild(el('span', {
    style: `display:inline-flex;align-items:center;padding:2px 10px;border-radius:20px;font-size:11px;font-weight:700;color:${SCORE_COLOR[score]};border:1px solid ${SCORE_COLOR[score]}`
  }, score));
  header.appendChild(titleRow);
  header.appendChild(el('p', { style: 'margin:6px 0 0;font-size:13px;color:var(--text-muted)' }, summary));

  // Portfolio context line
  const propCount = filteredProperties.length;
  if (propCount > 0) {
    const pvLine = `Portfolio: ${propCount} active propert${propCount === 1 ? 'y' : 'ies'}` +
      ((portfolioValueEUR || 0) > 0 ? `, approx. ${formatEUR(portfolioValueEUR)} book value.` : '.');
    header.appendChild(el('p', { style: 'margin:3px 0 0;font-size:12px;color:var(--text-muted)' }, pvLine));
  }

  card.appendChild(header);

  const top3 = issues.slice(0, 3);
  if (top3.length > 0) {
    const body = el('div', { style: 'padding:0 16px 12px;display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:8px' });
    for (const item of top3) {
      const sColor = item.severity === 'risk' ? '#ef4444' : '#f59e0b';
      const row = el('div', {
        style: `display:flex;align-items:flex-start;gap:8px;padding:8px 10px;border-radius:6px;background:var(--bg-elev-1);border:1px solid var(--border)`
      });
      row.appendChild(el('span', { style: `flex-shrink:0;width:8px;height:8px;border-radius:50%;background:${sColor};margin-top:4px` }));
      const txt = el('div');
      txt.appendChild(el('div', { style: 'font-size:12px;color:var(--text);line-height:1.4' }, item.text));
      txt.appendChild(el('div', { style: 'font-size:11px;color:var(--text-muted);margin-top:2px' }, `→ ${item.inspect}`));
      row.appendChild(txt);
      body.appendChild(row);
    }
    card.appendChild(body);
  }

  return card;
}

// ── KPI card builder ──────────────────────────────────────────────────────────
function kpiCard({ label, subtitle, value, variant, onClick, delta, deltaIsPercent, deltaIsPp, invertDelta, compLabel }) {
  const card = el('div', {
    class: 'kpi' + (variant ? ' ' + variant : ''),
    style: 'cursor:pointer;transition:box-shadow 120ms',
    title: 'Click for breakdown'
  });
  card.addEventListener('mouseenter', () => { card.style.boxShadow = '0 0 0 2px var(--accent)'; });
  card.addEventListener('mouseleave', () => { card.style.boxShadow = ''; });
  card.onclick = onClick;

  card.appendChild(el('div', { class: 'kpi-label' }, label));
  if (subtitle) card.appendChild(el('div', { style: 'font-size:10px;color:var(--text-muted);margin-top:-2px;margin-bottom:2px' }, subtitle));
  card.appendChild(el('div', { class: 'kpi-value' }, value));

  // Trend row — only rendered when there is meaningful content
  const hasValidDelta = delta !== null && delta !== undefined && isFinite(delta);
  const hasContext    = !!compLabel;
  if (hasValidDelta || hasContext) {
    const trendDiv = el('div', { class: 'kpi-trend' });
    if (!hasValidDelta) {
      // Show context label only (e.g. "Selected period")
      trendDiv.appendChild(el('span', { style: 'color:var(--text-muted);font-size:11px' }, compLabel));
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
  }
  card.appendChild(el('div', { class: 'kpi-accent-bar' }));
  return card;
}

// ── KPI cards ─────────────────────────────────────────────────────────────────
function buildKpiGrid(curMetrics, cmpMetrics, curRange, cmpRange) {
  const { rev, capEx, opProfit, opMargin, netCash, outstandingTotal, fcRev, fcMonthlyRev,
          expenseRatio, collectionRate, pendingPipeline,
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

  // 2. Forecast Revenue — uses filtered forecast data matching active filters
  const fcDelta = (fcRev != null && fcRev > 0) ? safePct(rev, fcRev) : null;
  // Build monthly actual revenue map for drilldown comparison
  const actualRevMap = new Map();
  payments.forEach(p => { const mk = p.date?.slice(0,7); if (mk) actualRevMap.set(mk, (actualRevMap.get(mk) || 0) + toEUR(p.amount, p.currency, p.date)); });
  invoices.forEach(i => { const mk = (i.issueDate||'').slice(0,7); if (mk) actualRevMap.set(mk, (actualRevMap.get(mk) || 0) + toEUR(i.total, i.currency, i.issueDate)); });
  grid.appendChild(kpiCard({
    label: 'Forecast Revenue',
    subtitle: 'Forecast for selected period',
    value: fcRev != null ? formatEUR(fcRev) : '—',
    onClick: () => {
      const { keys: fcMonths } = getMonthKeysForRange(curRange.start, curRange.end);
      const fcMap = fcMonthlyRev || new Map();
      const fcRows = fcMonths
        .filter(m => (fcMap.get(m.key) || 0) > 0 || (actualRevMap.get(m.key) || 0) > 0)
        .map(m => {
          const fc  = fcMap.get(m.key) || 0;
          const act = actualRevMap.get(m.key) || 0;
          const vari = act - fc;
          const varPct = fc === 0 ? null : ((act - fc) / Math.abs(fc)) * 100;
          return {
            month: m.label, fc, act, vari,
            varPctStr: fc === 0
              ? (act > 0 ? 'N/A' : '—')
              : (varPct >= 0 ? '+' : '') + varPct.toFixed(1) + '%'
          };
        });
      drillDownModal('Forecast Revenue — Actual vs Forecast', fcRows, [
        { key: 'month', label: 'Month' },
        { key: 'fc',   label: 'Forecast',   right: true, format: v => formatEUR(v) },
        { key: 'act',  label: 'Actual',     right: true, format: v => formatEUR(v) },
        { key: 'vari', label: 'Variance',   right: true, format: v => (v >= 0 ? '+' : '') + formatEUR(v) },
        { key: 'varPctStr', label: 'Var %', right: true }
      ]);
    },
    delta: fcDelta, invertDelta: false,
    compLabel: fcDelta !== null ? 'actual revenue' : '',
  }));

  // 3. Operating Profit
  grid.appendChild(kpiCard({
    label: 'Operating Profit',
    value: formatEUR(opProfit),
    variant: opProfit < 0 ? 'danger' :
      (opMargin !== null && opMargin >= EXEC_T.opMargin.healthy) ? 'success' : '',
    onClick: () => drillDownModal('Operating Profit', mixedRows(payments, invoices, opExpenses), MIXED_COLS),
    delta: cmpMetrics ? safePct(opProfit, cmpMetrics.opProfit) : null,
    invertDelta: false, compLabel: cmpLabel
  }));

  // 4. Operating Margin
  grid.appendChild(kpiCard({
    label: 'Operating Margin',
    subtitle: 'Op Profit / Revenue',
    value: opMargin != null ? `${opMargin.toFixed(1)}%` : '—',
    variant: opMargin === null ? '' :
      opMargin >= EXEC_T.opMargin.healthy ? 'success' :
      opMargin >= EXEC_T.opMargin.watch   ? 'warning' : 'danger',
    onClick: () => drillDownModal('Operating Profit', mixedRows(payments, invoices, opExpenses), MIXED_COLS),
    delta: (cmpMetrics && opMargin != null) ? safePp(opMargin, cmpMetrics.opMargin) : null,
    deltaIsPp: true, invertDelta: false, compLabel: cmpLabel
  }));

  // 5. Net Cash Flow
  grid.appendChild(kpiCard({
    label: 'Net Cash Flow',
    subtitle: 'Revenue minus OpEx and CapEx',
    value: formatEUR(netCash),
    variant: netCash >= 0 ? 'success' : 'danger',
    onClick: () => drillDownModal('Cash Flow', mixedRows(payments, invoices, [...opExpenses, ...capExExpenses], acquisitions), MIXED_COLS),
    delta: cmpMetrics ? safePct(netCash, cmpMetrics.netCash) : null,
    invertDelta: false, compLabel: cmpLabel
  }));

  // 6. Outstanding — current open invoices, no comparison delta (not range-limited)
  grid.appendChild(kpiCard({
    label: 'Outstanding',
    subtitle: 'Unpaid service invoices',
    value: formatEUR(outstandingTotal),
    variant: outstandingTotal > 0 ? 'warning' : '',
    onClick: () => drillDownModal('Outstanding Invoices', drillRevRows([], outstanding), REV_COLS),
    delta: null, compLabel: ''
  }));

  // 7. Collection Rate
  grid.appendChild(kpiCard({
    label: 'Collection Rate',
    subtitle: 'Paid invoices / total invoiced',
    value: collectionRate != null ? `${collectionRate.toFixed(1)}%` : '—',
    variant: collectionRate === null ? '' :
      collectionRate >= EXEC_T.collectionRate.healthy ? 'success' :
      collectionRate >= EXEC_T.collectionRate.watch   ? 'warning' : 'danger',
    onClick: () => drillDownModal('Collected Invoices', drillRevRows([], invoices), REV_COLS),
    delta: (cmpMetrics && collectionRate != null && cmpMetrics.collectionRate != null)
      ? safePp(collectionRate, cmpMetrics.collectionRate) : null,
    deltaIsPp: true, invertDelta: false, compLabel: cmpLabel
  }));

  // 8. Expense Ratio
  grid.appendChild(kpiCard({
    label: 'Expense Ratio',
    subtitle: 'OpEx / Revenue',
    value: expenseRatio != null ? `${expenseRatio.toFixed(1)}%` : '—',
    variant: expenseRatio === null ? '' :
      expenseRatio < EXEC_T.expenseRatio.watch  ? 'success' :
      expenseRatio < EXEC_T.expenseRatio.atRisk ? 'warning' : 'danger',
    onClick: () => drillDownModal('Operating Expenses', drillExpRows(opExpenses), EXP_COLS),
    delta: (cmpMetrics && expenseRatio != null) ? safePp(expenseRatio, cmpMetrics.expenseRatio) : null,
    deltaIsPp: true, invertDelta: true, compLabel: cmpLabel
  }));

  // 9. Pending Pipeline
  grid.appendChild(kpiCard({
    label: 'Pending Pipeline',
    subtitle: 'Pending Airbnb reservations',
    value: formatEUR(pendingPipeline),
    variant: pendingPipeline > 0 ? 'info' : '',
    onClick: () => {
      const cols = [
        { key: 'date',     label: 'Check-in', format: v => v ? v.slice(0,10) : '—' },
        { key: 'property', label: 'Property' },
        { key: 'nights',   label: 'Nights', right: true },
        { key: 'eur',      label: 'Amount', right: true, format: v => formatEUR(v) }
      ];
      const rows = curMetrics.pendingReservations.map(p => ({
        date:     p.airbnbCheckIn || p.date,
        property: byId('properties', p.propertyId)?.name || '—',
        nights:   p.airbnbNights || 0,
        eur:      toEUR(p.amount, p.currency || 'EUR', p.airbnbCheckIn || p.date)
      })).sort((a, b) => (a.date || '').localeCompare(b.date || ''));
      drillDownModal('Pending Pipeline — Airbnb Reservations', rows, cols);
    },
    delta: null, compLabel: curRange.label || ''
  }));

  // 10. Properties
  const { filteredProperties, portfolioValueEUR } = curMetrics;
  grid.appendChild(kpiCard({
    label: 'Properties',
    subtitle: 'Active portfolio units',
    value: String(filteredProperties.length),
    onClick: () => drillDownModal('Portfolio — Properties',
      filteredProperties.map(p => ({
        name:    p.name || '—',
        type:    propTypeLabel(p.type),
        status:  p.status || '—',
        owner:   p.owner || 'both',
        city:    p.city || '—',
        country: p.country || '—',
        eur:     p.purchasePrice > 0 ? toEUR(p.purchasePrice, p.currency || 'EUR', p.purchaseDate) : 0
      })),
      PROP_COLS),
    delta: null, compLabel: ''
  }));

  // 11. Portfolio Value
  grid.appendChild(kpiCard({
    label: 'Portfolio Value',
    subtitle: 'Purchase value / book value',
    value: portfolioValueEUR > 0 ? formatEUR(portfolioValueEUR) : '—',
    onClick: () => drillDownModal('Portfolio Value',
      filteredProperties
        .filter(p => p.purchasePrice > 0)
        .map(p => ({
          name:      p.name || '—',
          type:      propTypeLabel(p.type),
          status:    p.status || '—',
          owner:     p.owner || 'both',
          purchDate: p.purchaseDate || '—',
          price:     p.purchasePrice,
          currency:  p.currency || 'EUR',
          eur:       toEUR(p.purchasePrice, p.currency || 'EUR', p.purchaseDate)
        }))
        .sort((a, b) => (b.eur || 0) - (a.eur || 0)),
      PORTVAL_COLS),
    delta: null, compLabel: ''
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
  const { keys: months } = getMonthKeysForRange(curRange.start, curRange.end);
  if (!months.length) return;

  const labels = months.map(m => m.label);
  const { revMap, opExMap, capExMap } = buildMonthlyMaps(curData);

  const revData  = months.map(m => Math.round(revMap.get(m.key)  || 0));
  const opExData = months.map(m => Math.round(opExMap.get(m.key) || 0));
  const capExData= months.map(m => Math.round(capExMap.get(m.key)|| 0));
  const profData = months.map((m, i) => revData[i] - opExData[i]);

  // Comparison monthly maps
  let cmpRevArr = null, cmpProfArr = null;
  if (cmpData && cmpRange) {
    const cm = buildMonthlyMaps(cmpData);
    const { keys: cmpMonths } = getMonthKeysForRange(cmpRange.start, cmpRange.end);
    cmpRevArr  = months.map((_, i) => Math.round(cm.revMap.get(cmpMonths[i]?.key) || 0));
    const cmpOpEx = months.map((_, i) => Math.round(cm.opExMap.get(cmpMonths[i]?.key) || 0));
    cmpProfArr = months.map((_, i) => cmpRevArr[i] - cmpOpEx[i]);
  }

  // Forecast monthly map — filtered, matches active Executive filters
  const fcMap = curMetrics.fcMonthlyRev && curMetrics.fcMonthlyRev.size > 0
    ? curMetrics.fcMonthlyRev : null;

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

  // ── Section 2: Growth & Mix ──────────────────────────────────────────────
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

  // ── Section 3: Outstanding & Cash ────────────────────────────────────────
  // exec-outstanding-aging
  {
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

}

// ── Executive Insights ────────────────────────────────────────────────────────
function buildPerformanceInsights(curData, curMetrics, cmpMetrics, curRange) {
  const section = el('div', { class: 'card mb-16' });
  section.appendChild(el('div', { class: 'card-header' },
    el('div', { class: 'card-title' }, 'Executive Insights')
  ));
  const body = el('div', { style: 'padding:0 16px 16px' });

  const signals = []; // { title, text, severity: 'At Risk'|'Watch', inspect, onClick }

  // Revenue concentration
  const entityMap = new Map();
  curData.payments.forEach(p => {
    const prop = p.propertyId ? byId('properties', p.propertyId) : null;
    const key = p.propertyId || 'unknown';
    const e = entityMap.get(key) || { name: prop?.name || key, rev: 0, pays: [], invs: [] };
    e.rev += toEUR(p.amount, p.currency, p.date);
    e.pays.push(p);
    entityMap.set(key, e);
  });
  curData.invoices.forEach(i => {
    const client = i.clientId ? byId('clients', i.clientId) : null;
    const key = i.clientId || 'unknown-client';
    const e = entityMap.get(key) || { name: client?.name || key, rev: 0, pays: [], invs: [] };
    e.rev += toEUR(i.total, i.currency, i.issueDate);
    e.invs.push(i);
    entityMap.set(key, e);
  });
  const entities = [...entityMap.values()].sort((a,b) => b.rev - a.rev);
  const totalRev = entities.reduce((s, e) => s + e.rev, 0);
  if (entities.length > 0 && totalRev > 0) {
    const top = entities[0];
    const topPct = (top.rev / totalRev) * 100;
    if (topPct >= EXEC_T.revConc.atRisk) {
      signals.push({
        title: 'Revenue Concentration Risk',
        text: `Top revenue source (${top.name}) contributes ${topPct.toFixed(0)}% of revenue — high dependency on a single source.`,
        severity: 'At Risk',
        inspect: 'Revenue Dashboard',
        onClick: () => drillDownModal(`${top.name} — Revenue`, drillRevRows(top.pays, top.invs), REV_COLS)
      });
    } else if (topPct >= EXEC_T.revConc.watch) {
      signals.push({
        title: 'Revenue Concentration',
        text: `${top.name} contributes ${topPct.toFixed(0)}% of revenue (${formatEUR(top.rev)}).`,
        severity: 'Watch',
        inspect: 'Revenue Dashboard',
        onClick: () => drillDownModal(`${top.name} — Revenue`, drillRevRows(top.pays, top.invs), REV_COLS)
      });
    }
  }

  // Cost pressure
  if (curMetrics.expenseRatio != null && curMetrics.expenseRatio > EXEC_T.expenseRatio.watch) {
    signals.push({
      title: 'Cost Pressure',
      text: `Expense ratio is ${curMetrics.expenseRatio.toFixed(1)}% (OpEx/Revenue).${curMetrics.expenseRatio > EXEC_T.expenseRatio.atRisk ? ' Costs are consuming most of revenue.' : ' Costs are elevated.'}`,
      severity: curMetrics.expenseRatio > EXEC_T.expenseRatio.atRisk ? 'At Risk' : 'Watch',
      inspect: 'Expenses Dashboard',
      onClick: () => drillDownModal('Operating Expenses', drillExpRows(curData.opExpenses), EXP_COLS)
    });
  }

  // Outstanding risk — overdue then ratio-based
  if (curMetrics.outstandingTotal > 0) {
    const overdueCount = curMetrics.outstanding.filter(i => {
      const days = Math.floor((Date.now() - new Date(i.issueDate).getTime()) / 86400000);
      return days > 60;
    }).length;
    const onClickOutstanding = () => drillDownModal('Outstanding Invoices', drillRevRows([], curMetrics.outstanding), REV_COLS);
    if (overdueCount > 0) {
      signals.push({
        title: 'Outstanding Risk',
        text: `${overdueCount} invoice${overdueCount > 1 ? 's' : ''} overdue 60+ days. Total outstanding: ${formatEUR(curMetrics.outstandingTotal)}.`,
        severity: 'At Risk',
        inspect: 'Services Dashboard',
        onClick: onClickOutstanding
      });
    } else if (curMetrics.rev > 0) {
      const outRatio = (curMetrics.outstandingTotal / curMetrics.rev) * 100;
      if (outRatio >= 50) {
        signals.push({ title: 'Outstanding Risk', text: `Outstanding invoices are ${outRatio.toFixed(0)}% of revenue (${formatEUR(curMetrics.outstandingTotal)}).`, severity: 'At Risk', inspect: 'Services Dashboard', onClick: onClickOutstanding });
      } else if (outRatio >= 25) {
        signals.push({ title: 'Outstanding Invoices', text: `Outstanding invoices are ${outRatio.toFixed(0)}% of revenue (${formatEUR(curMetrics.outstandingTotal)}).`, severity: 'Watch', inspect: 'Services Dashboard', onClick: onClickOutstanding });
      }
    } else if (curMetrics.outstandingTotal > 5000) {
      signals.push({ title: 'Outstanding Invoices', text: `${formatEUR(curMetrics.outstandingTotal)} in unpaid invoices awaiting collection.`, severity: 'Watch', inspect: 'Services Dashboard', onClick: onClickOutstanding });
    }
  }

  // Forecast gap
  if (curMetrics.fcRev != null && curMetrics.fcRev > 0 && curMetrics.rev < curMetrics.fcRev * 0.9) {
    const pct = ((curMetrics.rev / curMetrics.fcRev) * 100).toFixed(0);
    const gap = curMetrics.fcRev - curMetrics.rev;
    signals.push({
      title: 'Forecast Gap',
      text: `Actual revenue is below forecast for the selected period (${pct}% of forecast achieved, ${formatEUR(gap)} gap).`,
      severity: curMetrics.rev < curMetrics.fcRev * 0.75 ? 'At Risk' : 'Watch',
      inspect: 'Forecast Dashboard'
    });
  }

  // Cash flow warning
  if (curMetrics.netCash < 0) {
    signals.push({
      title: 'Cash Flow Warning',
      text: `Net cash flow is ${formatEUR(curMetrics.netCash)} for the selected period.`,
      severity: 'At Risk',
      inspect: 'Cash Flow Dashboard',
      onClick: () => drillDownModal('Cash Flow',
        mixedRows(curData.payments, curData.invoices, [...curData.opExpenses, ...curData.capExExpenses], curData.acquisitions),
        MIXED_COLS)
    });
  }

  // Investment Pressure (CapEx relative to revenue)
  const capExAmt = curMetrics.capEx;
  if (capExAmt > 0) {
    const capExDrillRows = [
      ...drillExpRows(curData.capExExpenses),
      ...curData.acquisitions.map(a => ({
        date: a.date, source: a._name || '',
        category: 'Acquisition', description: a.description,
        eur: toEUR(a.amount, a.currency, a.date)
      }))
    ].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    const openCapEx = () => drillDownModal('Investments / CapEx', capExDrillRows, EXP_COLS);

    if (curMetrics.rev > 0) {
      const capExRatio = (capExAmt / curMetrics.rev) * 100;
      if (capExRatio > 100) {
        signals.push({
          title: 'Investment Pressure',
          text: `CapEx is ${capExRatio.toFixed(0)}% of revenue (${formatEUR(capExAmt)}) — investments exceed revenue for the period. Monitor cash position closely.`,
          severity: 'At Risk',
          inspect: 'Cash Flow Dashboard',
          onClick: openCapEx
        });
      } else if (capExRatio > 50) {
        signals.push({
          title: 'Investment Pressure',
          text: `CapEx is ${capExRatio.toFixed(0)}% of revenue (${formatEUR(capExAmt)}) — significant investment activity relative to revenue.`,
          severity: 'Watch',
          inspect: 'Cash Flow Dashboard',
          onClick: openCapEx
        });
      }
    } else if (capExAmt > 10000) {
      signals.push({
        title: 'Investment Pressure',
        text: `${formatEUR(capExAmt)} in CapEx and investments recorded with no revenue in this period.`,
        severity: 'Watch',
        inspect: 'Cash Flow Dashboard',
        onClick: openCapEx
      });
    }
  }

  // Margin declining vs comparison
  if (cmpMetrics && curMetrics.opMargin != null && cmpMetrics.opMargin != null) {
    const drop = cmpMetrics.opMargin - curMetrics.opMargin;
    if (drop > 10) {
      signals.push({
        title: 'Margin Declining',
        text: `Operating margin dropped ${drop.toFixed(1)} pp vs comparison period (now ${curMetrics.opMargin.toFixed(1)}%).`,
        severity: drop > 20 ? 'At Risk' : 'Watch',
        inspect: 'Expenses Dashboard'
      });
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────
  if (signals.length === 0) {
    body.appendChild(el('div', { style: 'font-size:13px;color:var(--text-muted)' },
      `No major executive risks detected for the selected period. Revenue: ${formatEUR(curMetrics.rev)}, margin: ${curMetrics.opMargin != null ? curMetrics.opMargin.toFixed(1) + '%' : '—'}.`
    ));
    section.appendChild(body);
    return section;
  }

  const SEV_COLOR = { 'At Risk': '#ef4444', 'Watch': '#f59e0b' };
  const SEV_BG    = { 'At Risk': 'rgba(239,68,68,0.06)', 'Watch': 'rgba(245,158,11,0.06)' };
  const row = el('div', { style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px' });

  for (const sig of signals) {
    const block = el('div', {
      style: `padding:10px 12px;border-radius:4px;border-left:3px solid ${SEV_COLOR[sig.severity] || '#6b7280'};background:${SEV_BG[sig.severity] || 'transparent'}`
    });
    const titleRow = el('div', { style: 'display:flex;align-items:center;justify-content:space-between;margin-bottom:4px' });
    titleRow.appendChild(el('span', {
      style: 'font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-muted)'
    }, sig.title));
    titleRow.appendChild(el('span', {
      style: `font-size:10px;font-weight:700;padding:1px 6px;border-radius:10px;color:${SEV_COLOR[sig.severity]};border:1px solid ${SEV_COLOR[sig.severity]}`
    }, sig.severity));
    block.appendChild(titleRow);
    const p2 = el('p', { style: 'margin:0 0 5px;font-size:12px;line-height:1.5;color:var(--text)' }, sig.text);
    if (sig.onClick) { p2.style.cursor = 'pointer'; p2.title = 'Click for breakdown'; p2.onclick = sig.onClick; }
    block.appendChild(p2);
    block.appendChild(el('div', { style: 'font-size:11px;color:var(--text-muted)' }, `→ Inspect: ${sig.inspect}`));
    row.appendChild(block);
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
      'Strategic control tower — health, performance and risk at a glance')
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

  // Section 1: Executive Health Snapshot
  wrap.appendChild(buildHealthSnapshot(curMetrics, cmpMetrics, curRange));

  // Section 2: Core KPI Cards
  wrap.appendChild(buildKpiGrid(curMetrics, cmpMetrics, curRange, cmpRange));

  // Section 3: Performance Trends
  wrap.appendChild(makeChartSection('Performance Trends', [
    ['Revenue Trend',          'exec-trend-rev'],
    ['Operating Profit Trend', 'exec-trend-profit'],
    ['Revenue vs Profit',      'exec-rev-vs-profit'],
  ]));

  // Section 4: Risk and Control
  wrap.appendChild(makeChartSection('Risk and Control', [
    ['YoY Revenue Growth',    'exec-rev-growth'],
    ['Revenue by Stream',     'exec-kd-rev-stream', { isDoughnut: true }],
    ['Revenue Concentration', 'exec-rev-conc',      { isDoughnut: true }],
  ]));

  wrap.appendChild(makeChartSection('Cost and Collections', [
    ['OpEx vs CapEx',     'exec-opex-capex'],
    ['Outstanding Aging', 'exec-outstanding-aging'],
  ]));

  // Section 5: Executive Insights
  wrap.appendChild(buildPerformanceInsights(curData, curMetrics, cmpMetrics, curRange));

  // Render all charts async
  setTimeout(() => {
    renderAllCharts(curData, curMetrics, cmpData, cmpMetrics, curRange, cmpRange);
  }, 0);

  return wrap;
}
