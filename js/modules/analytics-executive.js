// Executive Summary Analytics Dashboard — morning-briefing single-glance overview
import { el, openModal } from '../core/ui.js';
import * as charts from '../core/charts.js';
import {
  formatEUR, toEUR, byId,
  listActive, listActivePayments, isCapEx
} from '../core/data.js';
import {
  createFilterState, getCurrentPeriodRange, getComparisonRange,
  getMonthKeysForRange, makeMatchers, buildFilterBar, buildComparisonLine
} from './analytics-filters.js?v=20260519';
import {
  mkSectionLabel, mkSummaryBox, mkSummaryGrid, mkModalTable, mkVarianceBadge, mkEmptyState
} from './analytics-helpers.js';

// ── Constants ─────────────────────────────────────────────────────────────────
const CHART_IDS = ['exec-rev-exp-bar', 'exec-mix-donut', 'exec-net-line'];

// ── Module-level state ────────────────────────────────────────────────────────
let gF = createFilterState();

// ── Module export ─────────────────────────────────────────────────────────────
export default {
  id: 'analytics-executive',
  label: 'Executive',
  icon: '◈',
  render(container) { container.appendChild(buildView()); },
  refresh() { rebuildView(); },
  destroy() { CHART_IDS.forEach(id => charts.destroy(id)); }
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function safePct(cur, cmp) {
  if (cmp == null || !isFinite(cmp) || cmp === 0) return null;
  const v = (cur - cmp) / Math.abs(cmp) * 100;
  return isFinite(v) ? v : null;
}

const fmtK = v =>
  v >= 10000 ? `€${(v / 1000).toFixed(0)}k`
  : v >= 1000 ? `€${(v / 1000).toFixed(1)}k`
  : formatEUR(v, { maxFrac: 0 });

// ── Data aggregation ──────────────────────────────────────────────────────────
function getData(start, end) {
  const inRange = d => !!d && d >= start && d <= end;
  const { mStream, mOwner, mProperty, mClient } = makeMatchers(gF);

  // Paid rental income
  const payments = listActivePayments().filter(p =>
    p.status === 'paid' && inRange(p.date) && mStream(p) && mOwner(p) && mProperty(p)
  );

  // Paid service invoices
  const invoices = listActive('invoices').filter(i =>
    i.status === 'paid' && inRange(i.issueDate) && mStream(i) && mOwner(i) && mClient(i)
  );

  // Pending payments (pipeline)
  const pendingPayments = listActivePayments().filter(p =>
    p.status === 'pending' && inRange(p.date) && mStream(p) && mOwner(p) && mProperty(p)
  );

  // Outstanding invoices (not paid, not cancelled/void)
  const outstandingInvoices = listActive('invoices').filter(i =>
    !['paid', 'cancelled', 'void'].includes(i.status) &&
    inRange(i.issueDate) && mStream(i) && mOwner(i) && mClient(i)
  );

  // Overdue invoices
  const today = new Date().toISOString().slice(0, 10);
  const overdueInvoices = outstandingInvoices.filter(i =>
    i.dueDate && i.dueDate < today
  );

  // Expenses: split OpEx / CapEx
  const allExp    = listActive('expenses');
  const opExpenses  = allExp.filter(e => !isCapEx(e) && inRange(e.date) && mOwner(e) && mProperty(e));
  const capExpenses = allExp.filter(e =>  isCapEx(e) && inRange(e.date) && mOwner(e) && mProperty(e));

  // Revenue totals
  const propRev  = payments.reduce((s, p) => s + toEUR(p.amount, p.currency, p.date), 0);
  const svcRev   = invoices.reduce((s, i) => s + toEUR(i.total, i.currency, i.issueDate), 0);
  const totalRev = propRev + svcRev;

  // Expense totals
  const opEx  = opExpenses.reduce((s, e) => s + toEUR(e.amount, e.currency, e.date), 0);
  const capEx = capExpenses.reduce((s, e) => s + toEUR(e.amount, e.currency, e.date), 0);
  const totalExp = opEx + capEx;

  // Derived
  const netOpProfit = totalRev - opEx;
  const cashPos     = totalRev - totalExp;
  const pipeline    = pendingPayments.reduce((s, p) => s + toEUR(p.amount, p.currency, p.date), 0);

  // Collection rate: paid invoices / (paid + outstanding)
  const paidInvTotal = svcRev;
  const outTotal     = outstandingInvoices.reduce((s, i) => s + toEUR(i.total, i.currency, i.issueDate), 0);
  const invoicedTotal = paidInvTotal + outTotal;
  const collectionRate = invoicedTotal > 0 ? (paidInvTotal / invoicedTotal) * 100 : null;

  // Expense ratio
  const expenseRatio = totalRev > 0 ? (opEx / totalRev) * 100 : null;

  // Top contributors
  const contribMap = new Map();
  payments.forEach(p => {
    const id   = p.propertyId;
    const name = byId('properties', id)?.name || 'Unknown Property';
    const eur  = toEUR(p.amount, p.currency, p.date);
    const e    = contribMap.get('p:' + id) || { name, eur: 0, type: 'Property' };
    e.eur += eur;
    contribMap.set('p:' + id, e);
  });
  invoices.forEach(i => {
    const id   = i.clientId;
    const name = byId('clients', id)?.name || 'Unknown Client';
    const eur  = toEUR(i.total, i.currency, i.issueDate);
    const e    = contribMap.get('c:' + id) || { name, eur: 0, type: 'Client' };
    e.eur += eur;
    contribMap.set('c:' + id, e);
  });
  const topContribs = [...contribMap.values()].sort((a, b) => b.eur - a.eur);

  // Overdue totals
  const overdueCount = overdueInvoices.length;
  const overdueEur   = overdueInvoices.reduce((s, i) => s + toEUR(i.total, i.currency, i.issueDate), 0);

  // Revenue by stream
  const streamMap = new Map();
  payments.forEach(p => { const s = p.stream || 'other'; streamMap.set(s, (streamMap.get(s) || 0) + toEUR(p.amount, p.currency, p.date)); });
  invoices.forEach(i => { const s = i.stream || 'other'; streamMap.set(s, (streamMap.get(s) || 0) + toEUR(i.total, i.currency, i.issueDate)); });

  return {
    payments, invoices, pendingPayments, outstandingInvoices, overdueInvoices,
    opExpenses, capExpenses,
    propRev, svcRev, totalRev,
    opEx, capEx, totalExp,
    netOpProfit, cashPos, pipeline,
    collectionRate, expenseRatio,
    topContribs, streamMap,
    overdueCount, overdueEur,
    paidInvTotal, outTotal, invoicedTotal
  };
}

// ── KPI card builder ──────────────────────────────────────────────────────────
function kpiCard({ label, value, subtitle, delta, deltaIsPp, invertDelta, compLabel, variant, onClick }) {
  const card = el('div', {
    class: 'kpi' + (variant ? ' ' + variant : ''),
    style: onClick ? 'cursor:pointer;transition:box-shadow 120ms' : '',
    title: onClick ? 'Click for breakdown' : ''
  });
  if (onClick) {
    card.addEventListener('mouseenter', () => { card.style.boxShadow = '0 0 0 2px var(--accent)'; });
    card.addEventListener('mouseleave', () => { card.style.boxShadow = ''; });
    card.onclick = onClick;
  }

  card.appendChild(el('div', { class: 'kpi-label' }, label));
  card.appendChild(el('div', { class: 'kpi-value' }, value));

  if (delta !== null && delta !== undefined && isFinite(delta)) {
    const trend = el('div', { class: 'kpi-trend' });
    const sign  = delta > 0 ? '+' : '';
    const disp  = deltaIsPp ? `${sign}${delta.toFixed(1)} pp` : `${sign}${delta.toFixed(1)}%`;
    const cls   = delta === 0 ? '' : delta > 0 ? (invertDelta ? 'down' : 'up') : (invertDelta ? 'up' : 'down');
    trend.appendChild(el('span', { class: cls }, disp));
    if (compLabel) trend.appendChild(document.createTextNode(` vs ${compLabel}`));
    card.appendChild(trend);
  }
  if (subtitle) card.appendChild(el('div', { style: 'font-size:11px;color:var(--text-muted);margin-top:2px' }, subtitle));
  card.appendChild(el('div', { class: 'kpi-accent-bar' }));
  return card;
}

// ── Composite KPI card (wider, with breakdown lines) ─────────────────────────
function compositeKpiCard({ label, value, subtitle, delta, deltaIsPp, compLabel, variant, onClick, lines }) {
  const card = el('div', {
    class: 'kpi' + (variant ? ' ' + variant : ''),
    style: onClick ? 'cursor:pointer;transition:box-shadow 120ms' : '',
    title: onClick ? 'Click for breakdown' : ''
  });
  if (onClick) {
    card.addEventListener('mouseenter', () => { card.style.boxShadow = '0 0 0 2px var(--accent)'; });
    card.addEventListener('mouseleave', () => { card.style.boxShadow = ''; });
    card.onclick = onClick;
  }

  card.appendChild(el('div', { class: 'kpi-label' }, label));
  card.appendChild(el('div', { class: 'kpi-value' }, value));

  if (delta !== null && delta !== undefined && isFinite(delta)) {
    const trend = el('div', { class: 'kpi-trend' });
    const sign  = delta > 0 ? '+' : '';
    const disp  = deltaIsPp ? `${sign}${delta.toFixed(1)} pp` : `${sign}${delta.toFixed(1)}%`;
    const cls   = delta === 0 ? '' : delta > 0 ? 'up' : 'down';
    trend.appendChild(el('span', { class: cls }, disp));
    if (compLabel) trend.appendChild(document.createTextNode(` vs ${compLabel}`));
    card.appendChild(trend);
  }

  if (lines?.length) {
    card.appendChild(el('div', { style: 'margin:8px 0 6px;border-top:1px solid rgba(255,255,255,0.06)' }));
    for (const ln of lines) {
      const row = el('div', { style: 'display:flex;justify-content:space-between;align-items:flex-start;gap:6px;font-size:11px;padding:2px 4px;margin:0 -4px;border-radius:3px' });
      row.appendChild(el('span', { style: 'color:var(--text-muted);flex-shrink:0' }, ln.label));
      const right = el('span', { style: 'color:var(--text);font-weight:500;min-width:0;word-break:break-word;text-align:right' },
        ln.value + (ln.pct !== undefined ? ` (${ln.pct})` : '')
      );
      row.appendChild(right);
      if (ln.onClick) {
        row.style.cursor = 'pointer';
        row.addEventListener('mouseenter', () => { row.style.background = 'rgba(255,255,255,0.05)'; });
        row.addEventListener('mouseleave', () => { row.style.background = ''; });
        row.onclick = e => { e.stopPropagation(); ln.onClick(); };
      }
      card.appendChild(row);
    }
  }

  if (subtitle) card.appendChild(el('div', { style: 'font-size:11px;color:var(--text-muted);margin-top:2px' }, subtitle));
  card.appendChild(el('div', { class: 'kpi-accent-bar' }));
  return card;
}

// ── KPI Grid ──────────────────────────────────────────────────────────────────
function buildKpiGrid(cur, cmp, cmpRange) {
  const {
    totalRev, netOpProfit, cashPos, pipeline,
    collectionRate, expenseRatio, topContribs,
    overdueCount, overdueEur,
    opEx, propRev, svcRev, streamMap
  } = cur;

  const cl = cmpRange?.label || '';
  const pct = (num, den) => den > 0 ? (num / den * 100).toFixed(0) + '%' : '—';

  // Comparison deltas
  const dRev     = cmp ? safePct(totalRev,    cmp.totalRev)    : null;
  const dProfit  = cmp ? safePct(netOpProfit, cmp.netOpProfit) : null;
  const dCash    = cmp ? safePct(cashPos,     cmp.cashPos)     : null;
  const dCollect = cmp ? (collectionRate != null && cmp.collectionRate != null
    ? collectionRate - cmp.collectionRate : null) : null;
  const dExpR    = cmp ? (expenseRatio != null && cmp.expenseRatio != null
    ? expenseRatio - cmp.expenseRatio : null) : null;

  // Overdue modal
  const overdrueDrill = () => {
    const body = el('div');
    if (!cur.overdueInvoices.length) {
      body.appendChild(mkEmptyState('No overdue invoices for this period.'));
    } else {
      body.appendChild(mkSummaryGrid([
        { label: 'Overdue Count',  value: String(overdueCount) },
        { label: 'Overdue Amount', value: formatEUR(overdueEur) }
      ]));
      body.appendChild(mkSectionLabel('Overdue Invoices'));
      const rows = cur.overdueInvoices.map(i => [
        i.issueDate || '—',
        byId('clients', i.clientId)?.name || '—',
        i.dueDate || '—',
        formatEUR(toEUR(i.total, i.currency, i.issueDate))
      ]);
      body.appendChild(mkModalTable(['Issued', 'Client', 'Due', 'Amount'], rows));
    }
    openModal({ title: 'Overdue Invoices', body, large: false });
  };

  // Total Revenue drill
  const revDrill = () => {
    const body = el('div');
    body.appendChild(mkSummaryGrid([
      { label: 'Rental Income',   value: formatEUR(propRev), sub: pct(propRev, totalRev) + ' of total' },
      { label: 'Service Income',  value: formatEUR(svcRev),  sub: pct(svcRev,  totalRev) + ' of total' }
    ]));
    body.appendChild(mkSectionLabel('Revenue by Stream'));
    const streamLabels = {
      short_term_rental:  'Short-term Rental',
      long_term_rental:   'Long-term Rental',
      customer_success:   'Customer Success',
      marketing_services: 'Marketing Services',
    };
    const streamRows = [...streamMap.entries()]
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => [
        streamLabels[k] || k,
        formatEUR(v),
        pct(v, totalRev)
      ]);
    if (streamRows.length) {
      body.appendChild(mkModalTable(['Stream', 'Revenue', '% of Total'], streamRows));
    } else {
      body.appendChild(mkEmptyState('No stream data available.'));
    }
    openModal({ title: `Total Revenue — ${formatEUR(totalRev)}`, body, large: true });
  };

  // P&L drill (cash position)
  const cashDrill = () => {
    const body = el('div');
    body.appendChild(mkSummaryGrid([
      { label: 'Total Revenue',   value: formatEUR(totalRev) },
      { label: 'OpEx',            value: formatEUR(cur.opEx),    sub: 'Operating expenses' },
      { label: 'CapEx',           value: formatEUR(cur.capEx),   sub: 'Capital expenses' },
      { label: 'Net Cash Flow',   value: formatEUR(cashPos),     sub: cashPos >= 0 ? 'Positive' : 'Negative' }
    ], 2));
    openModal({ title: 'Cash Position Breakdown', body, large: false });
  };

  // Top contributors drill
  const contribDrill = () => {
    const body = el('div');
    if (!topContribs.length) {
      body.appendChild(mkEmptyState('No revenue contributors found.'));
    } else {
      const rows = topContribs.slice(0, 10).map((c, i) => [
        `#${i + 1}`,
        c.name,
        c.type,
        formatEUR(c.eur),
        pct(c.eur, totalRev)
      ]);
      body.appendChild(mkModalTable(['#', 'Name', 'Type', 'Revenue', 'Share'], rows));
    }
    openModal({ title: 'Top Revenue Contributors', body, large: true });
  };

  const grid = el('div', { style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px;margin-bottom:16px' });

  // ── Row 1: Revenue & Profit ────────────────────────────────────────────────

  // 1. Total Revenue
  grid.appendChild(kpiCard({
    label:    'Total Revenue',
    value:    formatEUR(totalRev),
    subtitle: `Rental ${pct(propRev, totalRev)} · Service ${pct(svcRev, totalRev)}`,
    delta:    dRev,
    compLabel: cl,
    onClick:  revDrill
  }));

  // 2. Net Operating Profit
  {
    const margin = totalRev > 0 ? (netOpProfit / totalRev * 100) : null;
    const variant = netOpProfit < 0 ? 'danger' : netOpProfit < totalRev * 0.1 ? 'warning' : '';
    grid.appendChild(kpiCard({
      label:    'Net Operating Profit',
      value:    formatEUR(netOpProfit),
      subtitle: margin !== null ? `Margin: ${margin.toFixed(1)}%` : 'No revenue',
      delta:    dProfit,
      compLabel: cl,
      variant,
      onClick: () => {
        const body = el('div');
        body.appendChild(mkSummaryGrid([
          { label: 'Revenue',         value: formatEUR(totalRev) },
          { label: 'OpEx',            value: formatEUR(opEx) },
          { label: 'Net Op. Profit',  value: formatEUR(netOpProfit), sub: margin !== null ? `${margin.toFixed(1)}% margin` : '' }
        ], 1));
        openModal({ title: 'Net Operating Profit', body, large: false });
      }
    }));
  }

  // 3. Cash Position
  {
    const variant = cashPos < 0 ? 'danger' : cashPos < totalRev * 0.05 ? 'warning' : '';
    grid.appendChild(kpiCard({
      label:    'Cash Position',
      value:    formatEUR(cashPos),
      subtitle: `Net Cash Flow (Rev − All Exp)`,
      delta:    dCash,
      compLabel: cl,
      variant,
      onClick:  cashDrill
    }));
  }

  // 4. Pending Pipeline
  grid.appendChild(kpiCard({
    label:    'Pending Pipeline',
    value:    formatEUR(pipeline),
    subtitle: `${cur.pendingPayments.length} pending payment${cur.pendingPayments.length !== 1 ? 's' : ''}`,
    variant:  'info',
    onClick: () => {
      const body = el('div');
      if (!cur.pendingPayments.length) {
        body.appendChild(mkEmptyState('No pending payments in this period.'));
      } else {
        const rows = cur.pendingPayments
          .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
          .map(p => [
            p.date || '—',
            byId('properties', p.propertyId)?.name || '—',
            formatEUR(toEUR(p.amount, p.currency, p.date))
          ]);
        body.appendChild(mkModalTable(['Date', 'Property', 'Amount'], rows));
      }
      openModal({ title: `Pending Pipeline — ${formatEUR(pipeline)}`, body, large: false });
    }
  }));

  // ── Row 2: Operations Health ───────────────────────────────────────────────

  // 5. Collection Rate
  {
    let variant = '';
    if (collectionRate !== null) {
      variant = collectionRate < 60 ? 'danger' : collectionRate < 80 ? 'warning' : 'success';
    }
    grid.appendChild(kpiCard({
      label:    'Collection Rate',
      value:    collectionRate !== null ? `${collectionRate.toFixed(1)}%` : '—',
      subtitle: cur.invoicedTotal > 0 ? `${formatEUR(cur.paidInvTotal)} paid of ${formatEUR(cur.invoicedTotal)} invoiced` : 'No invoices',
      delta:    dCollect,
      deltaIsPp: true,
      compLabel: cl,
      variant,
      onClick: () => {
        const body = el('div');
        body.appendChild(mkSummaryGrid([
          { label: 'Paid',        value: formatEUR(cur.paidInvTotal) },
          { label: 'Outstanding', value: formatEUR(cur.outTotal) },
          { label: 'Invoiced',    value: formatEUR(cur.invoicedTotal) },
          { label: 'Rate',        value: collectionRate !== null ? `${collectionRate.toFixed(1)}%` : '—' }
        ]));
        openModal({ title: 'Collection Rate', body, large: false });
      }
    }));
  }

  // 6. Expense Ratio
  {
    let variant = '';
    if (expenseRatio !== null) {
      variant = expenseRatio > 80 ? 'danger' : expenseRatio > 60 ? 'warning' : 'success';
    }
    grid.appendChild(kpiCard({
      label:    'Expense Ratio',
      value:    expenseRatio !== null ? `${expenseRatio.toFixed(1)}%` : '—',
      subtitle: `OpEx ÷ Revenue`,
      delta:    dExpR,
      deltaIsPp: true,
      invertDelta: true,
      compLabel: cl,
      variant,
      onClick: () => {
        const body = el('div');
        body.appendChild(mkSummaryGrid([
          { label: 'Total Revenue', value: formatEUR(totalRev) },
          { label: 'OpEx',          value: formatEUR(opEx) },
          { label: 'CapEx',         value: formatEUR(cur.capEx) },
          { label: 'Expense Ratio', value: expenseRatio !== null ? `${expenseRatio.toFixed(1)}%` : '—' }
        ]));
        openModal({ title: 'Expense Ratio', body, large: false });
      }
    }));
  }

  // 7. Top Revenue Source (composite)
  {
    const top3 = topContribs.slice(0, 3);
    grid.appendChild(compositeKpiCard({
      label:  'Top Revenue Source',
      value:  topContribs[0]?.name || '—',
      subtitle: topContribs[0] ? `${pct(topContribs[0].eur, totalRev)} of total revenue` : 'No data',
      onClick: contribDrill,
      lines: top3.map((c, i) => ({
        label: `#${i + 1} ${c.type}`,
        value: c.name,
        pct:   pct(c.eur, totalRev)
      }))
    }));
  }

  // 8. Overdue Invoices
  {
    const variant = overdueCount > 0 ? 'danger' : 'success';
    grid.appendChild(kpiCard({
      label:    'Overdue Invoices',
      value:    overdueCount > 0 ? formatEUR(overdueEur) : '€0',
      subtitle: overdueCount > 0 ? `${overdueCount} invoice${overdueCount !== 1 ? 's' : ''} overdue` : 'All clear',
      variant,
      onClick:  overdrueDrill
    }));
  }

  return grid;
}

// ── Insights Banner ───────────────────────────────────────────────────────────
function buildInsights(cur, cmp, cmpRange, start, end) {
  const { totalRev, expenseRatio, overdueCount, overdueEur } = cur;

  const section = el('div', { class: 'card mb-16' });
  section.appendChild(el('div', { class: 'card-header' },
    el('div', { class: 'card-title' }, 'Executive Insights')
  ));
  const body = el('div', { style: 'padding:0 16px 16px' });

  const insights = [];

  // 1. Revenue vs prior period
  if (cmp && cmpRange) {
    const delta = safePct(totalRev, cmp.totalRev);
    if (delta !== null) {
      const sign = delta > 0 ? '+' : '';
      const icon = delta > 5 ? '📈' : delta < -5 ? '📉' : '➡️';
      const color = delta > 0 ? 'var(--success, #22c55e)' : delta < 0 ? 'var(--danger, #ef4444)' : 'var(--text-muted)';
      const bg    = delta > 0 ? 'rgba(34,197,94,0.06)' : delta < 0 ? 'rgba(239,68,68,0.06)' : 'rgba(255,255,255,0.04)';
      insights.push({ icon, color, bg,
        title: 'Revenue vs Prior Period',
        body: `Revenue ${sign}${delta.toFixed(1)}% vs ${cmpRange.label} — ${formatEUR(cmp.totalRev)} → ${formatEUR(totalRev)}.`
      });
    }
  }

  // 2. Expense Ratio trend
  if (expenseRatio !== null) {
    const trend = cmp?.expenseRatio != null
      ? expenseRatio - cmp.expenseRatio
      : null;
    const color = expenseRatio > 80 ? 'var(--danger, #ef4444)' : expenseRatio > 60 ? 'var(--warning, #f59e0b)' : 'var(--success, #22c55e)';
    const bg    = expenseRatio > 80 ? 'rgba(239,68,68,0.06)' : expenseRatio > 60 ? 'rgba(245,158,11,0.06)' : 'rgba(34,197,94,0.06)';
    const icon  = expenseRatio > 80 ? '🔴' : expenseRatio > 60 ? '🟡' : '🟢';
    let trendStr = '';
    if (trend !== null) {
      const improving = trend < 0;
      trendStr = ` ${improving ? '(improving)' : '(worsening)'} by ${Math.abs(trend).toFixed(1)} pp vs ${cmpRange?.label || 'prior period'}.`;
    }
    insights.push({ icon, color, bg,
      title: 'Expense Ratio',
      body: `OpEx is ${expenseRatio.toFixed(1)}% of revenue.${trendStr} ${expenseRatio > 80 ? 'High expense burden — review costs.' : expenseRatio > 60 ? 'Moderate expenses — monitor trend.' : 'Healthy expense level.'}`
    });
  }

  // 3. Overdue alert
  if (overdueCount > 0) {
    insights.push({
      icon:  '⚠️',
      color: 'var(--danger, #ef4444)',
      bg:    'rgba(239,68,68,0.06)',
      title: 'Overdue Invoices',
      body:  `${overdueCount} overdue invoice${overdueCount !== 1 ? 's' : ''} totalling ${formatEUR(overdueEur)}. Follow up with clients to improve cash flow.`
    });
  } else if (cur.outTotal > 0) {
    insights.push({
      icon:  '✅',
      color: 'var(--success, #22c55e)',
      bg:    'rgba(34,197,94,0.06)',
      title: 'Overdue Status',
      body:  `No overdue invoices. ${formatEUR(cur.outTotal)} outstanding invoices are all within due dates.`
    });
  }

  // 4. Forecast accuracy (if forecast data exists)
  {
    const allForecasts = listActive('forecasts');
    const year = new Date(start).getFullYear();
    const relevantFc = allForecasts.find(fc => fc.year === year);
    if (relevantFc) {
      const fcRevTarget = relevantFc.yearTarget || 0;
      if (fcRevTarget > 0) {
        const accuracy = (cur.totalRev / fcRevTarget) * 100;
        const icon  = accuracy >= 90 ? '🎯' : accuracy >= 70 ? '📊' : '❗';
        const color = accuracy >= 90 ? 'var(--success, #22c55e)' : accuracy >= 70 ? 'var(--warning, #f59e0b)' : 'var(--danger, #ef4444)';
        const bg    = accuracy >= 90 ? 'rgba(34,197,94,0.06)' : accuracy >= 70 ? 'rgba(245,158,11,0.06)' : 'rgba(239,68,68,0.06)';
        insights.push({ icon, color, bg,
          title: 'Forecast Accuracy',
          body:  `Revenue is at ${accuracy.toFixed(0)}% of the ${year} annual target (${formatEUR(cur.totalRev)} of ${formatEUR(fcRevTarget)}).`
        });
      }
    }
  }

  if (!insights.length) {
    body.appendChild(el('div', { style: 'font-size:13px;color:var(--text-muted)' },
      'No major insights for this period. Adjust the filter to see more data.'));
    section.appendChild(body);
    return section;
  }

  const grid = el('div', { style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px' });

  for (const ins of insights) {
    const block = el('div', {
      style: `padding:10px 12px;border-radius:4px;border-left:3px solid ${ins.color};background:${ins.bg}`
    });
    const titleRow = el('div', { style: 'display:flex;align-items:center;gap:6px;margin-bottom:4px' });
    titleRow.appendChild(el('span', { style: 'font-size:14px' }, ins.icon));
    titleRow.appendChild(el('span', { style: 'font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-muted)' }, ins.title));
    block.appendChild(titleRow);
    block.appendChild(el('p', { style: 'margin:0;font-size:12px;line-height:1.5;color:var(--text)' }, ins.body));
    grid.appendChild(block);
  }

  body.appendChild(grid);
  section.appendChild(body);
  return section;
}

// ── Chart: Revenue vs Expenses Monthly Bar ────────────────────────────────────
function renderRevExpBar(cur, months) {
  const { payments, invoices, opExpenses, capExpenses } = cur;

  const revData = months.map(m => {
    const p = payments.filter(x => x.date?.slice(0, 7) === m.key).reduce((s, x) => s + toEUR(x.amount, x.currency, x.date), 0);
    const i = invoices.filter(x => (x.issueDate || '').slice(0, 7) === m.key).reduce((s, x) => s + toEUR(x.total, x.currency, x.issueDate), 0);
    return Math.round(p + i);
  });

  const expData = months.map(m => {
    const opE  = opExpenses.filter(e => (e.date || '').slice(0, 7) === m.key).reduce((s, e) => s + toEUR(e.amount, e.currency, e.date), 0);
    const capE = capExpenses.filter(e => (e.date || '').slice(0, 7) === m.key).reduce((s, e) => s + toEUR(e.amount, e.currency, e.date), 0);
    return Math.round(opE + capE);
  });

  if (!revData.some(v => v > 0) && !expData.some(v => v > 0)) return;

  charts.bar('exec-rev-exp-bar', {
    labels: months.map(m => m.label),
    datasets: [
      { label: 'Revenue',   data: revData, backgroundColor: 'rgba(16,185,129,0.75)' },
      { label: 'Expenses',  data: expData, backgroundColor: 'rgba(239,68,68,0.65)'  }
    ],
    stacked: false,
    onClickItem: (_label, idx) => {
      const mk = months[idx]?.key;
      if (!mk) return;
      const mRev = revData[idx] || 0;
      const mOpEx = Math.round(opExpenses.filter(e => (e.date || '').slice(0, 7) === mk).reduce((s, e) => s + toEUR(e.amount, e.currency, e.date), 0));
      const mCapEx = Math.round(capExpenses.filter(e => (e.date || '').slice(0, 7) === mk).reduce((s, e) => s + toEUR(e.amount, e.currency, e.date), 0));
      const mNet  = mRev - mOpEx - mCapEx;
      const body  = el('div');
      body.appendChild(mkSummaryGrid([
        { label: 'Revenue',   value: formatEUR(mRev) },
        { label: 'OpEx',      value: formatEUR(mOpEx) },
        { label: 'CapEx',     value: formatEUR(mCapEx) },
        { label: 'Net',       value: formatEUR(mNet), sub: mNet >= 0 ? 'Profitable' : 'Loss' }
      ]));
      openModal({ title: `${months[idx].label} — P&L Summary`, body, large: false });
    }
  });
}

// ── Chart: Business Mix Donut ─────────────────────────────────────────────────
function renderMixDonut(cur) {
  const { streamMap } = cur;
  const STREAM_LABELS = {
    short_term_rental:  'STR',
    long_term_rental:   'LTR',
    customer_success:   'Customer Success',
    marketing_services: 'Marketing',
    other:              'Other'
  };
  const STREAM_COLORS = {
    short_term_rental:  '#6366f1',
    long_term_rental:   '#10b981',
    customer_success:   '#f59e0b',
    marketing_services: '#ec4899',
    other:              '#8b93b0'
  };

  const entries = [...streamMap.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return;

  charts.doughnut('exec-mix-donut', {
    labels: entries.map(([k]) => STREAM_LABELS[k] || k),
    data:   entries.map(([, v]) => Math.round(v)),
    colors: entries.map(([k]) => STREAM_COLORS[k] || '#8b93b0')
  });
}

// ── Chart: Net Cash Flow Trend Line ──────────────────────────────────────────
function renderNetLine(cur, months) {
  const { payments, invoices, opExpenses, capExpenses } = cur;

  const netData = months.map(m => {
    const rev = payments.filter(x => x.date?.slice(0, 7) === m.key).reduce((s, x) => s + toEUR(x.amount, x.currency, x.date), 0)
              + invoices.filter(x => (x.issueDate || '').slice(0, 7) === m.key).reduce((s, x) => s + toEUR(x.total, x.currency, x.issueDate), 0);
    const exp = opExpenses.filter(e => (e.date || '').slice(0, 7) === m.key).reduce((s, e) => s + toEUR(e.amount, e.currency, e.date), 0)
              + capExpenses.filter(e => (e.date || '').slice(0, 7) === m.key).reduce((s, e) => s + toEUR(e.amount, e.currency, e.date), 0);
    return Math.round(rev - exp);
  });

  if (!netData.some(v => v !== 0)) return;

  // Determine color: green if positive trend, red if mostly negative
  const positiveMonths = netData.filter(v => v > 0).length;
  const lineColor = positiveMonths >= netData.length / 2 ? '#10b981' : '#ef4444';

  charts.line('exec-net-line', {
    labels: months.map(m => m.label),
    datasets: [{
      label: 'Net Cash Flow',
      data: netData,
      borderColor: lineColor,
      backgroundColor: positiveMonths >= netData.length / 2
        ? 'rgba(16,185,129,0.08)'
        : 'rgba(239,68,68,0.08)',
      fill: true
    }],
    onClickItem: (_label, idx) => {
      const mk = months[idx]?.key;
      if (!mk) return;
      const mNet = netData[idx];
      const body = el('div');
      body.appendChild(mkSummaryGrid([
        { label: 'Month',         value: months[idx].label },
        { label: 'Net Cash Flow', value: formatEUR(mNet), sub: mNet >= 0 ? 'Positive' : 'Negative' }
      ], 1));
      openModal({ title: `${months[idx].label} — Net Cash Flow`, body, large: false });
    }
  });
}

// ── Rebuild ───────────────────────────────────────────────────────────────────
function rebuildView() {
  CHART_IDS.forEach(id => charts.destroy(id));
  const c = document.getElementById('content');
  if (!c) return;
  c.innerHTML = '';
  c.appendChild(buildView());
}

// ── Main view ─────────────────────────────────────────────────────────────────
function buildView() {
  const wrap = el('div', { class: 'view active' });

  // Header
  wrap.appendChild(el('div', { style: 'margin-bottom:16px' },
    el('h2', { style: 'margin:0 0 4px;font-size:20px;font-weight:700' }, 'Executive Summary'),
    el('p',  { style: 'margin:0;font-size:13px;color:var(--text-muted)' }, 'Morning briefing · All business lines at a glance')
  ));

  // Filter bar (owner + period only)
  wrap.appendChild(buildFilterBar(
    gF,
    { showOwner: true, showStream: false, showProperty: false, storagePrefix: 'ana_exec_sum' },
    newGF => { if (newGF) gF = newGF; rebuildView(); }
  ));

  const curRange = getCurrentPeriodRange(gF);
  const cmpRange = getComparisonRange(gF, curRange);
  const curData  = getData(curRange.start, curRange.end);
  const cmpData  = cmpRange ? getData(cmpRange.start, cmpRange.end) : null;

  wrap.appendChild(buildComparisonLine(curRange, cmpRange));

  // KPI Grid (2 rows of 4)
  wrap.appendChild(buildKpiGrid(curData, cmpData, cmpRange));

  // Insights Banner
  wrap.appendChild(buildInsights(curData, cmpData, cmpRange, curRange.start, curRange.end));

  const { keys: months } = getMonthKeysForRange(curRange.start, curRange.end);

  // ── Chart row 1: Revenue vs Expenses Bar + Business Mix Donut ────────────
  const row1 = el('div', { class: 'grid grid-2 mb-16' });

  row1.appendChild(el('div', { class: 'card' },
    el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'Revenue vs Expenses (Monthly)')),
    el('div', { class: 'chart-wrap tall' }, el('canvas', { id: 'exec-rev-exp-bar' }))
  ));

  {
    const donutCard = el('div', { class: 'card' });
    const btnToggle = el('button', {
      style: 'background:none;border:1px solid var(--border);border-radius:4px;color:var(--text-muted);font-size:11px;cursor:pointer;padding:2px 6px;line-height:1'
    }, '%');
    btnToggle.onclick = () => {
      const showing = charts.toggleDoughnutPct('exec-mix-donut');
      btnToggle.textContent = showing ? '€' : '%';
    };
    donutCard.appendChild(el('div', {
      class: 'card-header',
      style: 'display:flex;align-items:center;justify-content:space-between'
    },
      el('div', { class: 'card-title' }, 'Revenue by Business Line'),
      btnToggle
    ));
    donutCard.appendChild(el('div', { class: 'chart-wrap tall' }, el('canvas', { id: 'exec-mix-donut' })));
    row1.appendChild(donutCard);
  }

  wrap.appendChild(row1);

  // ── Chart row 2: Net Cash Flow Line (full width) ──────────────────────────
  wrap.appendChild(el('div', { class: 'card mb-16' },
    el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'Net Cash Flow Trend')),
    el('div', { class: 'chart-wrap tall' }, el('canvas', { id: 'exec-net-line' }))
  ));

  // Render charts after DOM is ready
  setTimeout(() => {
    renderRevExpBar(curData, months);
    renderMixDonut(curData);
    renderNetLine(curData, months);
  }, 0);

  return wrap;
}
