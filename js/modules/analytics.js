// Executive Analytics Dashboard — morning-briefing single-glance overview
import { el, openModal } from '../core/ui.js';
import * as charts from '../core/charts.js';
import {
  formatEUR, toEUR, byId,
  listActive, listActivePayments, isCapEx, companyPropIds
} from '../core/data.js';
import {
  createFilterState, getCurrentPeriodRange, getComparisonRange,
  getMonthKeysForRange, makeMatchers, buildFilterBar, buildComparisonLine
} from './analytics-filters.js?v=20260519';
import {
  mkSectionLabel, mkSummaryBox, mkSummaryGrid, mkModalTable, mkVarianceBadge, mkEmptyState, mkKpiCard, mkCmpGrid,
  safePct, fmtK
} from './analytics-helpers.js';

// ── Constants ─────────────────────────────────────────────────────────────────
const CHART_IDS = ['exec-rev-exp-bar', 'exec-mix-donut', 'exec-net-line'];

// ── Module-level state ────────────────────────────────────────────────────────
let gF = createFilterState();
let gScope = 'company'; // 'company' | 'all'

// ── Module export ─────────────────────────────────────────────────────────────
export default {
  id: 'analytics',
  label: 'Executive',
  icon: '📊',
  render(container) { container.appendChild(buildView()); },
  refresh() { rebuildView(); },
  destroy() { CHART_IDS.forEach(id => charts.destroy(id)); }
};

// ── Data aggregation ──────────────────────────────────────────────────────────
function getData(start, end) {
  const inRange = d => !!d && d >= start && d <= end;
  const { mStream, mOwner, mProperty, mClient } = makeMatchers(gF);
  const coPropIds = companyPropIds();
  const isCoRec = gScope === 'all'
    ? () => true
    : r => !r.propertyId || coPropIds.has(r.propertyId);

  // Paid rental income
  const payments = listActivePayments().filter(p =>
    p.status === 'paid' && inRange(p.date) && mStream(p) && mOwner(p) && mProperty(p) && isCoRec(p)
  );

  // Paid service invoices
  const invoices = listActive('invoices').filter(i =>
    i.status === 'paid' && inRange(i.issueDate) && mStream(i) && mOwner(i) && mClient(i)
  );

  // Pending payments (pipeline)
  const pendingPayments = listActivePayments().filter(p =>
    p.status === 'pending' && inRange(p.date) && mStream(p) && mOwner(p) && mProperty(p) && isCoRec(p)
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
  const opExpenses  = allExp.filter(e => !isCapEx(e) && inRange(e.date) && mOwner(e) && mProperty(e) && isCoRec(e));
  const capExpenses = allExp.filter(e =>  isCapEx(e) && inRange(e.date) && mOwner(e) && mProperty(e) && isCoRec(e));

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

  // Burn coverage: how many months of OpEx does this period's net cash cover?
  const startD = new Date(start), endD = new Date(end);
  const periodMonths = Math.max(1, (endD.getFullYear() - startD.getFullYear()) * 12 + endD.getMonth() - startD.getMonth() + 1);
  const avgMonthlyOpEx  = opEx / periodMonths;
  const burnCoverage    = avgMonthlyOpEx > 0 ? cashPos / avgMonthlyOpEx : null;

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
    burnCoverage, avgMonthlyOpEx, periodMonths,
    topContribs, streamMap,
    overdueCount, overdueEur,
    paidInvTotal, outTotal, invoicedTotal
  };
}

// ── KPI Grid ──────────────────────────────────────────────────────────────────
function buildKpiGrid(cur, cmp, cmpRange) {
  const {
    totalRev, netOpProfit, cashPos, pipeline,
    collectionRate, expenseRatio, topContribs,
    overdueCount, overdueEur,
    opEx, propRev, svcRev, streamMap,
    burnCoverage, avgMonthlyOpEx, periodMonths
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
  const overdueDrill = () => {
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
    if (cmp) {
      body.appendChild(mkCmpGrid([
        { label: 'Total Revenue',  curVal: formatEUR(totalRev), cmpVal: formatEUR(cmp.totalRev) },
        { label: 'Rental Income',  curVal: formatEUR(propRev),  cmpVal: formatEUR(cmp.propRev)  },
        { label: 'Service Income', curVal: formatEUR(svcRev),   cmpVal: formatEUR(cmp.svcRev)   },
      ], 'Current Period', cl));
    } else {
      body.appendChild(mkSummaryGrid([
        { label: 'Rental Income',   value: formatEUR(propRev), sub: pct(propRev, totalRev) + ' of total' },
        { label: 'Service Income',  value: formatEUR(svcRev),  sub: pct(svcRev,  totalRev) + ' of total' }
      ]));
    }
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
    if (cmp) {
      body.appendChild(mkCmpGrid([
        { label: 'Total Revenue', curVal: formatEUR(totalRev),  cmpVal: formatEUR(cmp.totalRev)  },
        { label: 'OpEx',          curVal: formatEUR(cur.opEx),  cmpVal: formatEUR(cmp.opEx)       },
        { label: 'CapEx',         curVal: formatEUR(cur.capEx), cmpVal: formatEUR(cmp.capEx)      },
        { label: 'Net Cash Flow', curVal: formatEUR(cashPos),   cmpVal: formatEUR(cmp.cashPos)    },
      ], 'Current Period', cl));
    } else {
      body.appendChild(mkSummaryGrid([
        { label: 'Total Revenue',   value: formatEUR(totalRev) },
        { label: 'OpEx',            value: formatEUR(cur.opEx),    sub: 'Operating expenses' },
        { label: 'CapEx',           value: formatEUR(cur.capEx),   sub: 'Capital expenses' },
        { label: 'Net Cash Flow',   value: formatEUR(cashPos),     sub: cashPos >= 0 ? 'Positive' : 'Negative' }
      ], 2));
    }
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
  grid.appendChild(mkKpiCard({
    label:    'Total Revenue',
    value:    formatEUR(totalRev),
    subtitle: `Rental ${pct(propRev, totalRev)} · Service ${pct(svcRev, totalRev)}`,
    delta:    dRev,
    compLabel: cl,
    compValue: cmp ? formatEUR(cmp.totalRev) : undefined,
    onClick:  revDrill
  }));

  // 2. Net Operating Profit
  {
    const margin = totalRev > 0 ? (netOpProfit / totalRev * 100) : null;
    const variant = netOpProfit < 0 ? 'danger' : netOpProfit < totalRev * 0.1 ? 'warning' : '';
    grid.appendChild(mkKpiCard({
      label:    'Net Operating Profit',
      value:    formatEUR(netOpProfit),
      subtitle: margin !== null ? `Margin: ${margin.toFixed(1)}%` : 'No revenue',
      delta:    dProfit,
      compLabel: cl,
      compValue: cmp ? formatEUR(cmp.netOpProfit) : undefined,
      variant,
      onClick: () => {
        const body = el('div');
        if (cmp) {
          body.appendChild(mkCmpGrid([
            { label: 'Revenue',        curVal: formatEUR(totalRev),    cmpVal: formatEUR(cmp.totalRev)    },
            { label: 'OpEx',           curVal: formatEUR(opEx),        cmpVal: formatEUR(cmp.opEx)         },
            { label: 'Net Op. Profit', curVal: formatEUR(netOpProfit), cmpVal: formatEUR(cmp.netOpProfit)  },
          ], 'Current Period', cl));
        } else {
          body.appendChild(mkSummaryGrid([
            { label: 'Revenue',         value: formatEUR(totalRev) },
            { label: 'OpEx',            value: formatEUR(opEx) },
            { label: 'Net Op. Profit',  value: formatEUR(netOpProfit), sub: margin !== null ? `${margin.toFixed(1)}% margin` : '' }
          ], 1));
        }
        openModal({ title: 'Net Operating Profit', body, large: false });
      }
    }));
  }

  // 3. Cash Position
  {
    const variant = cashPos < 0 ? 'danger' : cashPos < totalRev * 0.05 ? 'warning' : '';
    grid.appendChild(mkKpiCard({
      label:    'Period Net Cash',
      value:    formatEUR(cashPos),
      subtitle: `Revenue minus all expenses`,
      delta:    dCash,
      compLabel: cl,
      compValue: cmp ? formatEUR(cmp.cashPos) : undefined,
      variant,
      onClick:  cashDrill
    }));
  }

  // 4. Burn Coverage
  {
    const months = burnCoverage !== null ? Math.round(burnCoverage * 10) / 10 : null;
    const variant = burnCoverage === null ? '' : burnCoverage < 1 ? 'danger' : burnCoverage < 3 ? 'warning' : 'success';
    const cmpBC = cmp && cmp.avgMonthlyOpEx > 0 ? cmp.cashPos / cmp.avgMonthlyOpEx : null;
    const dBC   = months !== null && cmpBC !== null ? months - cmpBC : null;
    grid.appendChild(mkKpiCard({
      label:    'Burn Coverage',
      value:    months !== null ? `${months.toFixed(1)} mo` : '—',
      subtitle: 'Period net ÷ avg monthly OpEx',
      delta: dBC,
      deltaIsPp: true,
      compLabel: cl,
      compValue: cmp && cmpBC !== null ? `${cmpBC.toFixed(1)} mo` : undefined,
      variant,
      onClick: () => {
        const body = el('div');
        if (cmp) {
          const cmpMonths = cmpBC !== null ? `${cmpBC.toFixed(1)} months` : '—';
          body.appendChild(mkCmpGrid([
            { label: 'Period Net Cash',   curVal: formatEUR(cashPos),        cmpVal: formatEUR(cmp.cashPos)        },
            { label: 'Avg Monthly OpEx',  curVal: formatEUR(avgMonthlyOpEx),  cmpVal: formatEUR(cmp.avgMonthlyOpEx) },
            { label: 'Burn Coverage',     curVal: months !== null ? `${months.toFixed(1)} months` : '—', cmpVal: cmpMonths },
          ], 'Current Period', cl));
        } else {
          body.appendChild(mkSummaryGrid([
            { label: 'Period Net Cash',    value: formatEUR(cashPos),       sub: cashPos >= 0 ? 'Positive' : 'Negative' },
            { label: 'Avg Monthly OpEx',  value: formatEUR(avgMonthlyOpEx), sub: `over ${periodMonths} month${periodMonths !== 1 ? 's' : ''}` },
            { label: 'Burn Coverage',      value: months !== null ? `${months.toFixed(1)} months` : '—', sub: months !== null && months < 3 ? 'Low — review spending' : null }
          ], 1));
        }
        body.appendChild(el('div', {
          style: 'font-size:11px;color:var(--text-muted);margin-top:10px;line-height:1.6;padding:8px 10px;border-radius:6px;background:rgba(255,255,255,0.03)'
        }, 'Measures how many months of operating expenses are covered by this period\'s net cash flow. Uses period-level data — not a balance-sheet cash runway figure.'));
        openModal({ title: 'Burn Coverage — Breakdown', body, large: false });
      }
    }));
  }

  // 5. Pending Pipeline
  grid.appendChild(mkKpiCard({
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
    grid.appendChild(mkKpiCard({
      label:    'Invoice Collection Rate',
      value:    collectionRate !== null ? `${collectionRate.toFixed(1)}%` : '—',
      subtitle: cur.invoicedTotal > 0 ? `${formatEUR(cur.paidInvTotal)} paid of ${formatEUR(cur.invoicedTotal)} invoiced` : 'No invoices',
      delta:    dCollect,
      deltaIsPp: true,
      compLabel: cl,
      compValue: cmp && cmp.collectionRate != null ? `${cmp.collectionRate.toFixed(1)}%` : undefined,
      variant,
      onClick: () => {
        const body = el('div');
        if (cmp) {
          body.appendChild(mkCmpGrid([
            { label: 'Paid',        curVal: formatEUR(cur.paidInvTotal), cmpVal: formatEUR(cmp.paidInvTotal) },
            { label: 'Outstanding', curVal: formatEUR(cur.outTotal),     cmpVal: formatEUR(cmp.outTotal)     },
            { label: 'Rate',        curVal: collectionRate != null ? `${collectionRate.toFixed(1)}%` : '—',
                                    cmpVal: cmp.collectionRate != null ? `${cmp.collectionRate.toFixed(1)}%` : '—' },
          ], 'Current Period', cl));
        } else {
          body.appendChild(mkSummaryGrid([
            { label: 'Paid',        value: formatEUR(cur.paidInvTotal) },
            { label: 'Outstanding', value: formatEUR(cur.outTotal) },
            { label: 'Invoiced',    value: formatEUR(cur.invoicedTotal) },
            { label: 'Rate',        value: collectionRate !== null ? `${collectionRate.toFixed(1)}%` : '—' }
          ]));
        }
        openModal({ title: 'Invoice Collection Rate', body, large: false });
      }
    }));
  }

  // 6. Expense Ratio
  {
    let variant = '';
    if (expenseRatio !== null) {
      variant = expenseRatio > 80 ? 'danger' : expenseRatio > 60 ? 'warning' : 'success';
    }
    grid.appendChild(mkKpiCard({
      label:    'Expense Ratio',
      value:    expenseRatio !== null ? `${expenseRatio.toFixed(1)}%` : '—',
      subtitle: `OpEx ÷ Revenue`,
      delta:    dExpR,
      deltaIsPp: true,
      invertDelta: true,
      compLabel: cl,
      compValue: cmp && cmp.expenseRatio != null ? `${cmp.expenseRatio.toFixed(1)}%` : undefined,
      variant,
      onClick: () => {
        const body = el('div');
        if (cmp) {
          body.appendChild(mkCmpGrid([
            { label: 'Total Revenue', curVal: formatEUR(totalRev),  cmpVal: formatEUR(cmp.totalRev)  },
            { label: 'OpEx',          curVal: formatEUR(opEx),      cmpVal: formatEUR(cmp.opEx)       },
            { label: 'Expense Ratio', curVal: expenseRatio != null ? `${expenseRatio.toFixed(1)}%` : '—',
                                      cmpVal: cmp.expenseRatio != null ? `${cmp.expenseRatio.toFixed(1)}%` : '—' },
          ], 'Current Period', cl));
        } else {
          body.appendChild(mkSummaryGrid([
            { label: 'Total Revenue', value: formatEUR(totalRev) },
            { label: 'OpEx',          value: formatEUR(opEx) },
            { label: 'CapEx',         value: formatEUR(cur.capEx) },
            { label: 'Expense Ratio', value: expenseRatio !== null ? `${expenseRatio.toFixed(1)}%` : '—' }
          ]));
        }
        openModal({ title: 'Expense Ratio', body, large: false });
      }
    }));
  }

  // 7. Top Revenue Source (composite)
  {
    const top3 = topContribs.slice(0, 3);
    grid.appendChild(mkKpiCard({
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
    grid.appendChild(mkKpiCard({
      label:    'Overdue Invoices',
      value:    overdueCount > 0 ? formatEUR(overdueEur) : '€0',
      subtitle: overdueCount > 0 ? `${overdueCount} invoice${overdueCount !== 1 ? 's' : ''} overdue` : 'All clear',
      variant,
      onClick:  overdueDrill
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
    const year = new Date(start).getFullYear();
    const fcRevTarget = listActive('forecasts')
      .filter(fc => fc.year === year)
      .reduce((sum, fc) => sum + (Number(fc.yearTarget?.revenue) || 0), 0);
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
      const mPays = cur.payments.filter(p => p.date?.slice(0,7) === mk);
      const mInvs = cur.invoices.filter(i => (i.issueDate||'').slice(0,7) === mk);
      const mOpEx2 = cur.opExpenses.filter(e => (e.date||'').slice(0,7) === mk);
      const mCapEx2 = cur.capExpenses.filter(e => (e.date||'').slice(0,7) === mk);
      if (mPays.length || mInvs.length) {
        body.appendChild(mkSectionLabel('Revenue Records'));
        body.appendChild(mkModalTable(['Date','Entity','Type','Amount'],
          [...mPays.map(p => [p.date||'—', byId('properties',p.propertyId)?.name||'—', 'Payment', formatEUR(toEUR(p.amount,p.currency,p.date))]),
           ...mInvs.map(i => [i.issueDate||'—', byId('clients',i.clientId)?.name||'—', 'Invoice', formatEUR(toEUR(i.total,i.currency,i.issueDate))])]
          .sort((a,b) => a[0].localeCompare(b[0]))
        ));
      }
      if (mOpEx2.length || mCapEx2.length) {
        body.appendChild(mkSectionLabel('Expense Records'));
        body.appendChild(mkModalTable(['Date','Description','Type','Amount'],
          [...mOpEx2.map(e => [e.date||'—', e.description||e.notes||'—', 'OpEx', formatEUR(toEUR(e.amount,e.currency,e.date))]),
           ...mCapEx2.map(e => [e.date||'—', e.description||e.notes||'—', 'CapEx', formatEUR(toEUR(e.amount,e.currency,e.date))])]
          .sort((a,b) => a[0].localeCompare(b[0]))
        ));
      }
      openModal({ title: `${months[idx].label} — P&L Summary`, body, large: true });
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

  const totalRevMix = entries.reduce((s, [, v]) => s + v, 0);

  charts.doughnut('exec-mix-donut', {
    labels: entries.map(([k]) => STREAM_LABELS[k] || k),
    data:   entries.map(([, v]) => Math.round(v)),
    colors: entries.map(([k]) => STREAM_COLORS[k] || '#8b93b0'),
    onClickItem: (label, index) => {
      const [streamKey, streamTotal] = entries[index];
      const streamLabel = STREAM_LABELS[streamKey] || streamKey;
      const body = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });
      body.appendChild(mkSummaryGrid([
        { label: 'Stream',   value: streamLabel },
        { label: 'Revenue',  value: formatEUR(streamTotal) },
        { label: '% of Mix', value: totalRevMix > 0 ? (streamTotal / totalRevMix * 100).toFixed(1) + '%' : '—' }
      ], 3));
      const pays = cur.payments.filter(p => (p.stream || 'other') === streamKey);
      const invs = cur.invoices.filter(i => (i.stream || 'other') === streamKey);
      if (pays.length) {
        body.appendChild(mkSectionLabel('Payments'));
        body.appendChild(mkModalTable(['Date','Property','Amount'],
          pays.sort((a,b) => (b.date||'').localeCompare(a.date||'')).slice(0,8)
              .map(p => [p.date||'—', byId('properties',p.propertyId)?.name||'—', formatEUR(toEUR(p.amount,p.currency,p.date))])
        ));
      }
      if (invs.length) {
        body.appendChild(mkSectionLabel('Invoices'));
        body.appendChild(mkModalTable(['Date','Client','Amount'],
          invs.sort((a,b) => (b.issueDate||'').localeCompare(a.issueDate||'')).slice(0,8)
              .map(i => [i.issueDate||'—', byId('clients',i.clientId)?.name||'—', formatEUR(toEUR(i.total,i.currency,i.issueDate))])
        ));
      }
      if (!pays.length && !invs.length) body.appendChild(mkEmptyState('No records for this stream.'));
      openModal({ title: `${streamLabel} — Revenue Detail`, body, large: true });
    }
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
    { showOwner: true, showStream: false, showProperty: false, storagePrefix: 'ana_exec_sum', channelScope: gScope === 'all' ? null : 'company' },
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
  const curData  = getData(curRange.start, curRange.end);
  const cmpData  = cmpRange ? getData(cmpRange.start, cmpRange.end) : null;

  wrap.appendChild(buildComparisonLine(curRange, cmpRange));

  {
    const now = new Date();
    const periodStart = new Date(curRange.start);
    const periodEnd   = new Date(curRange.end);
    const isCurrentYear = periodStart.getFullYear() === now.getFullYear() && periodEnd >= now;
    if (isCurrentYear && periodStart.getMonth() === 0) {
      const monthN = now.getMonth() + 1;
      wrap.appendChild(el('div', {
        style: 'font-size:11px;color:var(--text-muted);margin-bottom:12px;padding:6px 10px;background:rgba(255,255,255,0.03);border-radius:4px;display:inline-block'
      }, `Year to date — month ${monthN} of 12 · ${now.getFullYear()}`));
    }
  }

  // KPI Grid (2 rows of 4)
  wrap.appendChild(buildKpiGrid(curData, cmpData, cmpRange));

  // Insights Banner
  wrap.appendChild(buildInsights(curData, cmpData, cmpRange, curRange.start, curRange.end));

  const { keys: months } = getMonthKeysForRange(curRange.start, curRange.end);

  // Chart row 1: Revenue vs Expenses Bar + Business Mix Donut
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

  // Chart row 2: Net Cash Flow Line (full width)
  wrap.appendChild(el('div', { class: 'card mb-16' },
    el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'Net Cash Flow Trend')),
    el('div', { class: 'chart-wrap tall' }, el('canvas', { id: 'exec-net-line' }))
  ));

  setTimeout(() => {
    renderRevExpBar(curData, months);
    renderMixDonut(curData);
    renderNetLine(curData, months);
  }, 0);

  return wrap;
}
