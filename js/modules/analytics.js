// Executive Analytics Dashboard — morning-briefing single-glance overview
import { el, fmtDate, drillDownModal, openModal } from '../core/ui.js';
import * as charts from '../core/charts.js';
import {
  formatEUR, toEUR, byId,
  listActive, listActivePayments, isCapEx, companyPropIds, isCompanyRecord,
  drillRevRows, drillExpRows, drillNetRows, drillRevRowsPnL, drillNetRowsPnL
} from '../core/data.js';
import {
  createFilterState, getCurrentPeriodRange, getComparisonRange,
  getMonthKeysForRange, makeMatchers, buildFilterBar, buildComparisonLine
} from './analytics-filters.js?v=20260519';
import {
  mkSectionLabel, mkSummaryBox, mkSummaryGrid, mkModalTable, mkVarianceBadge, mkEmptyState, mkKpiCard, mkCmpGrid,
  safePct, fmtK, mkDrillValue
} from './analytics-helpers.js';

// ── Constants ─────────────────────────────────────────────────────────────────
const CHART_IDS = ['exec-rev-exp-bar', 'exec-mix-donut', 'exec-net-line'];

const REV_COLS = [
  { key: 'date',   label: 'Date',   format: v => fmtDate(v), tip: 'Date the payment or invoice was recorded.' },
  { key: 'type',   label: 'Type', tip: 'Record type (payment or invoice).' },
  { key: 'source', label: 'Entity', tip: 'Property or client the revenue is attributed to.' },
  { key: 'ref',    label: 'Ref', tip: 'Reference or confirmation number for the transaction.' },
  { key: 'eur',    label: 'EUR', right: true, format: v => formatEUR(v), tip: 'Amount converted to EUR at the transaction date.' }
];
const EXP_COLS = [
  { key: 'date',        label: 'Date',        format: v => fmtDate(v), tip: 'Date the expense was recorded.' },
  { key: 'source',      label: 'Property', tip: 'Property the expense is attributed to.' },
  { key: 'category',    label: 'Category', tip: 'Expense category (e.g. maintenance, utilities).' },
  { key: 'description', label: 'Description', tip: 'Free-text description of the expense.' },
  { key: 'eur',         label: 'EUR', right: true, format: v => formatEUR(v), tip: 'Amount converted to EUR at the expense date.' }
];
const NET_COLS = [
  { key: 'date',   label: 'Date',   format: v => fmtDate(v), tip: 'Date of the underlying revenue or expense record.' },
  { key: 'kind',   label: 'Kind', tip: 'Whether this row is Revenue or an Expense.' },
  { key: 'source', label: 'Source', tip: 'Entity/property and category this row is attributed to.' },
  { key: 'eur',    label: 'EUR', right: true, format: v => formatEUR(v), tip: 'Amount converted to EUR.' }
];

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
    : r => isCompanyRecord(r, coPropIds);

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

  // Revenue totals. P&L figures (Total Revenue, Net Operating Profit, Expense Ratio) use
  // subtotal (VAT-exclusive) — VAT collected on invoices isn't the company's revenue, it's
  // money held for the tax authority. Cash-purpose figures (Cash Position, Collection Rate)
  // keep the VAT-inclusive total since VAT collected is real cash in hand until remitted.
  const propRev      = payments.reduce((s, p) => s + toEUR(p.amount, p.currency, p.date), 0);
  const svcRev       = invoices.reduce((s, i) => s + toEUR(i.subtotal ?? i.total, i.currency, i.issueDate), 0);
  const svcRevCash   = invoices.reduce((s, i) => s + toEUR(i.total, i.currency, i.issueDate), 0);
  const totalRev     = propRev + svcRev;
  const totalRevCash = propRev + svcRevCash;

  // Expense totals
  const opEx  = opExpenses.reduce((s, e) => s + toEUR(e.amount, e.currency, e.date), 0);
  const capEx = capExpenses.reduce((s, e) => s + toEUR(e.amount, e.currency, e.date), 0);
  const totalExp = opEx + capEx;

  // Derived
  const netOpProfit = totalRev - opEx;
  const cashPos     = totalRevCash - totalExp;
  const pipeline    = pendingPayments.reduce((s, p) => s + toEUR(p.amount, p.currency, p.date), 0);

  // Burn coverage: how many months of OpEx does this period's net cash cover?
  const startD = new Date(start), endD = new Date(end);
  const periodMonths = Math.max(1, (endD.getFullYear() - startD.getFullYear()) * 12 + endD.getMonth() - startD.getMonth() + 1);
  const avgMonthlyOpEx  = opEx / periodMonths;
  const burnCoverage    = avgMonthlyOpEx > 0 ? cashPos / avgMonthlyOpEx : null;

  // Collection rate: paid invoices / (paid + outstanding) — cash-based, VAT-inclusive
  const paidInvTotal = svcRevCash;
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
    const eur  = toEUR(i.subtotal ?? i.total, i.currency, i.issueDate);
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
  invoices.forEach(i => { const s = i.stream || 'other'; streamMap.set(s, (streamMap.get(s) || 0) + toEUR(i.subtotal ?? i.total, i.currency, i.issueDate)); });

  return {
    payments, invoices, pendingPayments, outstandingInvoices, overdueInvoices,
    opExpenses, capExpenses,
    propRev, svcRev, svcRevCash, totalRev, totalRevCash,
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
    totalRev, totalRevCash, netOpProfit, cashPos, pipeline,
    collectionRate,
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

  // Overdue modal
  const overdueDrill = () => {
    const body = el('div');
    if (!cur.overdueInvoices.length) {
      body.appendChild(mkEmptyState('No overdue invoices for this period.'));
    } else {
      if (cmp) {
        body.appendChild(mkCmpGrid([
          { label: 'Overdue Count',
            curVal: String(overdueCount),
            cmpVal: String(cmp.overdueCount) },
          { label: 'Overdue Amount',
            curVal: mkDrillValue(formatEUR(overdueEur), () => drillDownModal('Overdue Invoices', drillRevRows([], cur.overdueInvoices), REV_COLS)),
            cmpVal: mkDrillValue(formatEUR(cmp.overdueEur), () => drillDownModal(`Overdue Invoices — ${cl}`, drillRevRows([], cmp.overdueInvoices), REV_COLS)),
            explain: {
              title: 'Overdue Amount',
              formula: 'Sum of outstanding invoices whose due date is before today.',
              inputs: [
                { label: 'Overdue Count',  value: String(overdueCount) },
                { label: 'Overdue Amount', value: formatEUR(overdueEur) }
              ],
              source: 'analytics.js:66-68,127 getData()',
              note: 'Cancelled/void invoices are excluded from the outstanding pool before the overdue check runs.'
            }
          }
        ], 'Current Period', cl));
      } else {
        body.appendChild(mkSummaryGrid([
          { label: 'Overdue Count',  value: String(overdueCount) },
          { label: 'Overdue Amount', value: formatEUR(overdueEur),
            explain: {
              title: 'Overdue Amount',
              formula: 'Sum of outstanding invoices whose due date is before today.',
              inputs: [
                { label: 'Overdue Count',  value: String(overdueCount) },
                { label: 'Overdue Amount', value: formatEUR(overdueEur) }
              ],
              source: 'analytics.js:66-68,127 getData()',
              note: 'Cancelled/void invoices are excluded from the outstanding pool before the overdue check runs.'
            }
          }
        ]));
      }
      body.appendChild(mkSectionLabel('Overdue Invoices'));
      const rows = cur.overdueInvoices.map(i => [
        i.issueDate || '—',
        byId('clients', i.clientId)?.name || '—',
        i.dueDate || '—',
        formatEUR(toEUR(i.total, i.currency, i.issueDate))
      ]);
      body.appendChild(mkModalTable([
        { label: 'Issued', tip: 'Invoice issue date.' },
        { label: 'Client',  tip: 'Client the invoice was billed to.' },
        { label: 'Due',     tip: 'Invoice due date.' },
        { label: 'Amount',  right: true, tip: 'Invoice total in EUR.' }
      ], rows));
    }
    openModal({ title: 'Overdue Invoices', body, large: false });
  };

  // Total Revenue drill
  const revDrill = () => {
    const body = el('div');
    if (cmp) {
      body.appendChild(mkCmpGrid([
        { label: 'Total Revenue',  curVal: formatEUR(totalRev), cmpVal: formatEUR(cmp.totalRev) },
        { label: 'Rental Income',
          curVal: mkDrillValue(formatEUR(propRev), () => drillDownModal('Rental Income', drillRevRows(cur.payments, []), REV_COLS)),
          cmpVal: mkDrillValue(formatEUR(cmp.propRev), () => drillDownModal(`Rental Income — ${cl}`, drillRevRows(cmp.payments, []), REV_COLS)) },
        { label: 'Service Income',
          curVal: mkDrillValue(formatEUR(svcRev), () => drillDownModal('Service Income', drillRevRowsPnL([], cur.invoices), REV_COLS)),
          cmpVal: mkDrillValue(formatEUR(cmp.svcRev), () => drillDownModal(`Service Income — ${cl}`, drillRevRowsPnL([], cmp.invoices), REV_COLS)) },
      ], 'Current Period', cl));
    } else {
      body.appendChild(mkSummaryGrid([
        { label: 'Rental Income',
          value: mkDrillValue(formatEUR(propRev), () => drillDownModal('Rental Income', drillRevRows(cur.payments, []), REV_COLS)),
          sub: pct(propRev, totalRev) + ' of total',
          explain: {
            title: 'Rental Income',
            formula: 'Sum of paid rental payments (status:\'paid\'), dated within the selected period.',
            inputs: [
              { label: 'Rental Income',  value: formatEUR(propRev) },
              { label: 'Total Revenue',  value: formatEUR(totalRev) },
              { label: '% of Total',     value: pct(propRev, totalRev) }
            ],
            source: 'analytics.js:76 getData()'
          }
        },
        { label: 'Service Income',
          value: mkDrillValue(formatEUR(svcRev), () => drillDownModal('Service Income', drillRevRowsPnL([], cur.invoices), REV_COLS)),
          sub: pct(svcRev,  totalRev) + ' of total',
          explain: {
            title: 'Service Income',
            formula: 'Sum of paid service invoices (status:\'paid\'), dated by issue date within the selected period.',
            inputs: [
              { label: 'Service Income', value: formatEUR(svcRev) },
              { label: 'Total Revenue',  value: formatEUR(totalRev) },
              { label: '% of Total',     value: pct(svcRev, totalRev) }
            ],
            source: 'analytics.js:77 getData()'
          }
        }
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
        mkDrillValue(formatEUR(v), () => openStreamRevenueModal(k, v, totalRev, cur)),
        pct(v, totalRev)
      ]);
    if (streamRows.length) {
      body.appendChild(mkModalTable([
        { label: 'Stream',     tip: 'Business line the revenue was earned through.' },
        { label: 'Revenue',    right: true, tip: 'Sum of paid rental payments and paid invoices attributed to this stream, in the selected period.' },
        { label: '% of Total', right: true, tip: 'This stream\'s revenue as a percentage of total revenue for the period.' }
      ], streamRows));
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
        { label: 'Total Revenue',
          curVal: mkDrillValue(formatEUR(totalRevCash), () => drillDownModal('Total Revenue', drillRevRows(cur.payments, cur.invoices), REV_COLS)),
          cmpVal: mkDrillValue(formatEUR(cmp.totalRevCash), () => drillDownModal(`Total Revenue — ${cl}`, drillRevRows(cmp.payments, cmp.invoices), REV_COLS)) },
        { label: 'OpEx',
          curVal: mkDrillValue(formatEUR(cur.opEx), () => drillDownModal('Operating Expenses', drillExpRows(cur.opExpenses), EXP_COLS)),
          cmpVal: mkDrillValue(formatEUR(cmp.opEx), () => drillDownModal(`Operating Expenses — ${cl}`, drillExpRows(cmp.opExpenses), EXP_COLS)) },
        { label: 'CapEx',
          curVal: mkDrillValue(formatEUR(cur.capEx), () => drillDownModal('Capital Expenses', drillExpRows(cur.capExpenses), EXP_COLS)),
          cmpVal: mkDrillValue(formatEUR(cmp.capEx), () => drillDownModal(`Capital Expenses — ${cl}`, drillExpRows(cmp.capExpenses), EXP_COLS)) },
        { label: 'Net Cash Flow',
          curVal: mkDrillValue(formatEUR(cashPos), () => drillDownModal('Net Cash Flow', drillNetRows(cur.payments, cur.invoices, [...cur.opExpenses, ...cur.capExpenses]), NET_COLS)),
          cmpVal: mkDrillValue(formatEUR(cmp.cashPos), () => drillDownModal(`Net Cash Flow — ${cl}`, drillNetRows(cmp.payments, cmp.invoices, [...cmp.opExpenses, ...cmp.capExpenses]), NET_COLS)) },
      ], 'Current Period', cl));
    } else {
      body.appendChild(mkSummaryGrid([
        { label: 'Total Revenue',
          value: mkDrillValue(formatEUR(totalRevCash), () => drillDownModal('Total Revenue', drillRevRows(cur.payments, cur.invoices), REV_COLS)) },
        { label: 'OpEx',
          value: mkDrillValue(formatEUR(cur.opEx), () => drillDownModal('Operating Expenses', drillExpRows(cur.opExpenses), EXP_COLS)),
          sub: 'Operating expenses' },
        { label: 'CapEx',
          value: mkDrillValue(formatEUR(cur.capEx), () => drillDownModal('Capital Expenses', drillExpRows(cur.capExpenses), EXP_COLS)),
          sub: 'Capital expenses' },
        { label: 'Net Cash Flow',
          value: mkDrillValue(formatEUR(cashPos), () => drillDownModal('Net Cash Flow', drillNetRows(cur.payments, cur.invoices, [...cur.opExpenses, ...cur.capExpenses]), NET_COLS)),
          sub: cashPos >= 0 ? 'Positive' : 'Negative',
          explain: {
            title: 'Net Cash Flow',
            formula: 'Total Revenue − (OpEx + CapEx).',
            inputs: [
              { label: 'Total Revenue',  value: formatEUR(totalRevCash) },
              { label: 'OpEx',           value: formatEUR(cur.opEx) },
              { label: 'CapEx',          value: formatEUR(cur.capEx) },
              { label: 'Net Cash Flow',  value: formatEUR(cashPos) }
            ],
            source: 'analytics.js:83,87 getData()',
            note: 'Unlike Net Operating Profit, this also subtracts CapEx — so a heavy renovation month can turn a profitable period cash-negative.'
          }
        }
      ], 2));
    }
    openModal({ title: 'Cash Position Breakdown', body, large: false });
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
    onClick:  revDrill,
    explain: {
      title: 'Total Revenue',
      formula: 'Rental Income + Service Income (paid only, within the selected period).',
      inputs: [
        { label: 'Rental Income',  value: formatEUR(propRev) },
        { label: 'Service Income', value: formatEUR(svcRev) },
        { label: 'Total Revenue',  value: formatEUR(totalRev) }
      ],
      source: 'analytics.js:76-78 getData()',
      note: 'Only status:\'paid\' payments and invoices count; pending payments and outstanding invoices are excluded.'
    }
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
            { label: 'Revenue',
              curVal: mkDrillValue(formatEUR(totalRev), () => drillDownModal('Revenue', drillRevRowsPnL(cur.payments, cur.invoices), REV_COLS)),
              cmpVal: mkDrillValue(formatEUR(cmp.totalRev), () => drillDownModal(`Revenue — ${cl}`, drillRevRowsPnL(cmp.payments, cmp.invoices), REV_COLS)) },
            { label: 'OpEx',
              curVal: mkDrillValue(formatEUR(opEx), () => drillDownModal('Operating Expenses', drillExpRows(cur.opExpenses), EXP_COLS)),
              cmpVal: mkDrillValue(formatEUR(cmp.opEx), () => drillDownModal(`Operating Expenses — ${cl}`, drillExpRows(cmp.opExpenses), EXP_COLS)) },
            { label: 'Net Op. Profit',
              curVal: mkDrillValue(formatEUR(netOpProfit), () => drillDownModal('Net Operating Profit', drillNetRowsPnL(cur.payments, cur.invoices, cur.opExpenses), NET_COLS)),
              cmpVal: mkDrillValue(formatEUR(cmp.netOpProfit), () => drillDownModal(`Net Operating Profit — ${cl}`, drillNetRowsPnL(cmp.payments, cmp.invoices, cmp.opExpenses), NET_COLS)) },
          ], 'Current Period', cl));
        } else {
          body.appendChild(mkSummaryGrid([
            { label: 'Revenue',
              value: mkDrillValue(formatEUR(totalRev), () => drillDownModal('Revenue', drillRevRowsPnL(cur.payments, cur.invoices), REV_COLS)) },
            { label: 'OpEx',
              value: mkDrillValue(formatEUR(opEx), () => drillDownModal('Operating Expenses', drillExpRows(cur.opExpenses), EXP_COLS)) },
            { label: 'Net Op. Profit',
              value: mkDrillValue(formatEUR(netOpProfit), () => drillDownModal('Net Operating Profit', drillNetRowsPnL(cur.payments, cur.invoices, cur.opExpenses), NET_COLS)),
              sub: margin !== null ? `${margin.toFixed(1)}% margin` : '',
              explain: {
                title: 'Net Operating Profit',
                formula: 'Total Revenue − OpEx. CapEx is not subtracted.',
                inputs: [
                  { label: 'Revenue', value: formatEUR(totalRev) },
                  { label: 'OpEx',    value: formatEUR(opEx) },
                  { label: 'Net Operating Profit', value: formatEUR(netOpProfit) }
                ],
                source: 'analytics.js:86 getData()',
                note: margin !== null ? 'Margin shown is Net Operating Profit ÷ Total Revenue.' : undefined
              }
            }
          ], 1));
        }
        openModal({ title: 'Net Operating Profit', body, large: false });
      },
      explain: {
        title: 'Net Operating Profit',
        formula: 'Total Revenue − Operating Expenses (OpEx). CapEx is excluded.',
        inputs: [
          { label: 'Total Revenue', value: formatEUR(totalRev) },
          { label: 'OpEx',          value: formatEUR(opEx) },
          { label: 'Net Operating Profit', value: formatEUR(netOpProfit) }
        ],
        source: 'analytics.js:86 getData()',
        note: margin !== null ? `Margin (${margin.toFixed(1)}%) is Net Operating Profit ÷ Total Revenue.` : 'No revenue this period, so margin is not shown.'
      }
    }));
  }

  // 3. Cash Position
  {
    const variant = cashPos < 0 ? 'danger' : cashPos < totalRevCash * 0.05 ? 'warning' : '';
    grid.appendChild(mkKpiCard({
      label:    'Period Net Cash',
      value:    formatEUR(cashPos),
      subtitle: `Revenue minus all expenses`,
      delta:    dCash,
      compLabel: cl,
      compValue: cmp ? formatEUR(cmp.cashPos) : undefined,
      variant,
      onClick:  cashDrill,
      explain: {
        title: 'Period Net Cash',
        formula: 'Total Revenue − Total Expenses (OpEx + CapEx).',
        inputs: [
          { label: 'Total Revenue',   value: formatEUR(totalRevCash) },
          { label: 'Total Expenses',  value: formatEUR(cur.totalExp) },
          { label: 'Period Net Cash', value: formatEUR(cashPos) }
        ],
        source: 'analytics.js:87 getData()',
        note: 'Unlike Net Operating Profit, this also subtracts CapEx.'
      }
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
            { label: 'Period Net Cash',
              curVal: mkDrillValue(formatEUR(cashPos), () => drillDownModal('Period Net Cash', drillNetRows(cur.payments, cur.invoices, [...cur.opExpenses, ...cur.capExpenses]), NET_COLS)),
              cmpVal: mkDrillValue(formatEUR(cmp.cashPos), () => drillDownModal(`Period Net Cash — ${cl}`, drillNetRows(cmp.payments, cmp.invoices, [...cmp.opExpenses, ...cmp.capExpenses]), NET_COLS)) },
            { label: 'Avg Monthly OpEx',
              curVal: mkDrillValue(formatEUR(avgMonthlyOpEx), () => drillDownModal('Operating Expenses', drillExpRows(cur.opExpenses), EXP_COLS)),
              cmpVal: mkDrillValue(formatEUR(cmp.avgMonthlyOpEx), () => drillDownModal(`Operating Expenses — ${cl}`, drillExpRows(cmp.opExpenses), EXP_COLS)) },
            { label: 'Burn Coverage',     curVal: months !== null ? `${months.toFixed(1)} months` : '—', cmpVal: cmpMonths },
          ], 'Current Period', cl));
        } else {
          body.appendChild(mkSummaryGrid([
            { label: 'Period Net Cash',
              value: mkDrillValue(formatEUR(cashPos), () => drillDownModal('Period Net Cash', drillNetRows(cur.payments, cur.invoices, [...cur.opExpenses, ...cur.capExpenses]), NET_COLS)),
              sub: cashPos >= 0 ? 'Positive' : 'Negative' },
            { label: 'Avg Monthly OpEx',
              value: mkDrillValue(formatEUR(avgMonthlyOpEx), () => drillDownModal('Operating Expenses', drillExpRows(cur.opExpenses), EXP_COLS)),
              sub: `over ${periodMonths} month${periodMonths !== 1 ? 's' : ''}`,
              explain: {
                title: 'Avg Monthly OpEx',
                formula: 'OpEx ÷ number of months in the selected period.',
                inputs: [
                  { label: 'OpEx',          value: formatEUR(opEx) },
                  { label: 'Period Length', value: `${periodMonths} month${periodMonths !== 1 ? 's' : ''}` },
                  { label: 'Avg Monthly OpEx', value: formatEUR(avgMonthlyOpEx) }
                ],
                source: 'analytics.js:92-93 getData()'
              }
            },
            { label: 'Burn Coverage',      value: months !== null ? `${months.toFixed(1)} months` : '—', sub: months !== null && months < 3 ? 'Low — review spending' : null,
              explain: {
                title: 'Burn Coverage',
                formula: 'Period Net Cash ÷ Avg Monthly OpEx.',
                inputs: [
                  { label: 'Period Net Cash',   value: formatEUR(cashPos) },
                  { label: 'Avg Monthly OpEx',  value: formatEUR(avgMonthlyOpEx) },
                  { label: 'Burn Coverage',     value: months !== null ? `${months.toFixed(1)} months` : '—' }
                ],
                source: 'analytics.js:94 getData()',
                note: 'Uses this period\'s own OpEx run-rate — not a balance-sheet cash runway figure.'
              }
            }
          ], 1));
        }
        body.appendChild(el('div', {
          style: 'font-size:11px;color:var(--text-muted);margin-top:10px;line-height:1.6;padding:8px 10px;border-radius:6px;background:rgba(255,255,255,0.03)'
        }, 'Measures how many months of operating expenses are covered by this period\'s net cash flow. Uses period-level data — not a balance-sheet cash runway figure.'));
        openModal({ title: 'Burn Coverage — Breakdown', body, large: false });
      },
      explain: {
        title: 'Burn Coverage',
        formula: 'Period Net Cash ÷ Avg Monthly OpEx.',
        inputs: [
          { label: 'Period Net Cash',   value: formatEUR(cashPos) },
          { label: 'Avg Monthly OpEx',  value: formatEUR(avgMonthlyOpEx) },
          { label: 'Period Length',     value: `${periodMonths} month${periodMonths !== 1 ? 's' : ''}` },
          { label: 'Burn Coverage',     value: months !== null ? `${months.toFixed(1)} mo` : '—' }
        ],
        source: 'analytics.js:93-94 getData()',
        note: 'Uses this period\'s own OpEx run-rate — not a balance-sheet cash runway figure.'
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
        const today = new Date().toISOString().slice(0, 10);
        let pastDueAmt = 0, pastDueCount = 0, upcomingAmt = 0, upcomingCount = 0;
        const pastDuePayments = [], upcomingPayments = [];
        cur.pendingPayments.forEach(p => {
          const amt = toEUR(p.amount, p.currency, p.date);
          if (p.date && p.date < today) { pastDueAmt += amt; pastDueCount++; pastDuePayments.push(p); }
          else { upcomingAmt += amt; upcomingCount++; upcomingPayments.push(p); }
        });
        if (cmp) {
          let cmpPastDueAmt = 0, cmpUpcomingAmt = 0;
          const cmpPastDuePayments = [], cmpUpcomingPayments = [];
          cmp.pendingPayments.forEach(p => {
            const amt = toEUR(p.amount, p.currency, p.date);
            if (p.date && p.date < today) { cmpPastDueAmt += amt; cmpPastDuePayments.push(p); }
            else { cmpUpcomingAmt += amt; cmpUpcomingPayments.push(p); }
          });
          body.appendChild(mkCmpGrid([
            { label: 'Total Pending', curVal: formatEUR(pipeline), cmpVal: formatEUR(cmp.pipeline) },
            { label: 'Past Expected Date',
              curVal: mkDrillValue(formatEUR(pastDueAmt), () => drillDownModal('Past Expected Date — Pending Payments', drillRevRows(pastDuePayments, []), REV_COLS)),
              cmpVal: mkDrillValue(formatEUR(cmpPastDueAmt), () => drillDownModal(`Past Expected Date — Pending Payments — ${cl}`, drillRevRows(cmpPastDuePayments, []), REV_COLS)) },
            { label: 'Upcoming',
              curVal: mkDrillValue(formatEUR(upcomingAmt), () => drillDownModal('Upcoming — Pending Payments', drillRevRows(upcomingPayments, []), REV_COLS)),
              cmpVal: mkDrillValue(formatEUR(cmpUpcomingAmt), () => drillDownModal(`Upcoming — Pending Payments — ${cl}`, drillRevRows(cmpUpcomingPayments, []), REV_COLS)) },
          ], 'Current Period', cl));
        } else {
          body.appendChild(mkSummaryGrid([
            { label: 'Total Pending', value: formatEUR(pipeline), sub: `${cur.pendingPayments.length} payment${cur.pendingPayments.length !== 1 ? 's' : ''}`,
              explain: {
                title: 'Total Pending',
                formula: 'Sum of payment amounts with status "pending", dated within the selected period.',
                inputs: [
                  { label: 'Pending payments', value: String(cur.pendingPayments.length) },
                  { label: 'Total Pending',    value: formatEUR(pipeline) }
                ],
                source: 'analytics.js:54,88 getData()',
                note: 'Not yet collected — excluded from Total Revenue and Net Cash figures.'
              }
            },
            { label: 'Past Expected Date',
              value: mkDrillValue(formatEUR(pastDueAmt), () => drillDownModal('Past Expected Date — Pending Payments', drillRevRows(pastDuePayments, []), REV_COLS)),
              sub: `${pastDueCount} payment${pastDueCount !== 1 ? 's' : ''}`,
              explain: {
                title: 'Past Expected Date',
                formula: 'Of the pending payments, those whose expected date is before today.',
                inputs: [
                  { label: 'Past-due payments', value: String(pastDueCount) },
                  { label: 'Past-due amount',   value: formatEUR(pastDueAmt) }
                ],
                source: 'analytics.js — buildKpiGrid() Pending Pipeline onClick handler'
              }
            },
            { label: 'Upcoming',
              value: mkDrillValue(formatEUR(upcomingAmt), () => drillDownModal('Upcoming — Pending Payments', drillRevRows(upcomingPayments, []), REV_COLS)),
              sub: `${upcomingCount} payment${upcomingCount !== 1 ? 's' : ''}`,
              explain: {
                title: 'Upcoming',
                formula: 'Of the pending payments, those whose expected date is today or later (or has no date).',
                inputs: [
                  { label: 'Upcoming payments', value: String(upcomingCount) },
                  { label: 'Upcoming amount',   value: formatEUR(upcomingAmt) }
                ],
                source: 'analytics.js — buildKpiGrid() Pending Pipeline onClick handler'
              }
            }
          ], 3));
        }
        body.appendChild(mkSectionLabel('Pending Payments'));
        const rows = cur.pendingPayments
          .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
          .map(p => [
            p.date || '—',
            byId('properties', p.propertyId)?.name || '—',
            formatEUR(toEUR(p.amount, p.currency, p.date))
          ]);
        body.appendChild(mkModalTable([
          { label: 'Date',     tip: 'Expected payment date.' },
          { label: 'Property', tip: 'Property the pending payment is linked to.' },
          { label: 'Amount',   right: true, tip: 'Pending payment amount in EUR.' }
        ], rows));
      }
      openModal({ title: `Pending Pipeline — ${formatEUR(pipeline)}`, body, large: false });
    },
    explain: {
      title: 'Pending Pipeline',
      formula: 'Sum of payment amounts with status "pending", dated within the selected period.',
      inputs: [
        { label: 'Pending payments', value: String(cur.pendingPayments.length) },
        { label: 'Pending Pipeline', value: formatEUR(pipeline) }
      ],
      source: 'analytics.js:54,88 getData()',
      note: 'Not yet collected — excluded from Total Revenue and Net Cash figures.'
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
            { label: 'Paid',
              curVal: mkDrillValue(formatEUR(cur.paidInvTotal), () => drillDownModal('Paid Invoices', drillRevRows([], cur.invoices), REV_COLS)),
              cmpVal: mkDrillValue(formatEUR(cmp.paidInvTotal), () => drillDownModal(`Paid Invoices — ${cl}`, drillRevRows([], cmp.invoices), REV_COLS)) },
            { label: 'Outstanding',
              curVal: mkDrillValue(formatEUR(cur.outTotal), () => drillDownModal('Outstanding Invoices', drillRevRows([], cur.outstandingInvoices), REV_COLS)),
              cmpVal: mkDrillValue(formatEUR(cmp.outTotal), () => drillDownModal(`Outstanding Invoices — ${cl}`, drillRevRows([], cmp.outstandingInvoices), REV_COLS)) },
            { label: 'Rate',        curVal: collectionRate != null ? `${collectionRate.toFixed(1)}%` : '—',
                                    cmpVal: cmp.collectionRate != null ? `${cmp.collectionRate.toFixed(1)}%` : '—' },
          ], 'Current Period', cl));
        } else {
          body.appendChild(mkSummaryGrid([
            { label: 'Paid',
              value: mkDrillValue(formatEUR(cur.paidInvTotal), () => drillDownModal('Paid Invoices', drillRevRows([], cur.invoices), REV_COLS)) },
            { label: 'Outstanding',
              value: mkDrillValue(formatEUR(cur.outTotal), () => drillDownModal('Outstanding Invoices', drillRevRows([], cur.outstandingInvoices), REV_COLS)) },
            { label: 'Invoiced',
              value: mkDrillValue(formatEUR(cur.invoicedTotal), () => drillDownModal('All Invoices (Paid + Outstanding)', drillRevRows([], [...cur.invoices, ...cur.outstandingInvoices]), REV_COLS)),
              explain: {
                title: 'Invoiced',
                formula: 'Paid Invoice Total + Outstanding Invoice Total.',
                inputs: [
                  { label: 'Paid',     value: formatEUR(cur.paidInvTotal) },
                  { label: 'Outstanding', value: formatEUR(cur.outTotal) },
                  { label: 'Invoiced', value: formatEUR(cur.invoicedTotal) }
                ],
                source: 'analytics.js:97-99 getData()'
              }
            },
            { label: 'Rate',        value: collectionRate !== null ? `${collectionRate.toFixed(1)}%` : '—',
              explain: {
                title: 'Invoice Collection Rate',
                formula: 'Paid Invoice Total ÷ (Paid + Outstanding Invoice Total) × 100.',
                inputs: [
                  { label: 'Paid',       value: formatEUR(cur.paidInvTotal) },
                  { label: 'Invoiced',   value: formatEUR(cur.invoicedTotal) },
                  { label: 'Rate',       value: collectionRate !== null ? `${collectionRate.toFixed(1)}%` : '—' }
                ],
                source: 'analytics.js:96-100 getData()',
                note: 'Outstanding excludes cancelled/void invoices.'
              }
            }
          ]));
        }
        openModal({ title: 'Invoice Collection Rate', body, large: false });
      },
      explain: {
        title: 'Invoice Collection Rate',
        formula: 'Paid Invoice Total ÷ (Paid + Outstanding Invoice Total) × 100.',
        inputs: [
          { label: 'Paid',        value: formatEUR(cur.paidInvTotal) },
          { label: 'Outstanding', value: formatEUR(cur.outTotal) },
          { label: 'Collection Rate', value: collectionRate !== null ? `${collectionRate.toFixed(1)}%` : '—' }
        ],
        source: 'analytics.js:96-100 getData()',
        note: 'Outstanding excludes cancelled/void invoices.'
      }
    }));
  }

  // 6. Overdue Invoices
  {
    const variant = overdueCount > 0 ? 'danger' : 'success';
    grid.appendChild(mkKpiCard({
      label:    'Overdue Invoices',
      value:    overdueCount > 0 ? formatEUR(overdueEur) : '€0',
      subtitle: overdueCount > 0 ? `${overdueCount} invoice${overdueCount !== 1 ? 's' : ''} overdue` : 'All clear',
      variant,
      onClick:  overdueDrill,
      explain: {
        title: 'Overdue Invoices',
        formula: 'Sum of outstanding invoices whose due date is before today.',
        inputs: [
          { label: 'Overdue Count',  value: String(overdueCount) },
          { label: 'Overdue Amount', value: formatEUR(overdueEur) }
        ],
        source: 'analytics.js:64-68,126-127 getData()',
        note: 'Cancelled/void invoices are excluded from the outstanding pool before the overdue check runs.'
      }
    }));
  }

  return grid;
}

// ── Insights Banner ───────────────────────────────────────────────────────────
function buildInsights(cur, cmp, cmpRange, start, end) {
  const { totalRev, expenseRatio, overdueCount, overdueEur } = cur;
  const cl = cmpRange?.label || '';

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
        body: `Revenue ${sign}${delta.toFixed(1)}% vs ${cmpRange.label} — ${formatEUR(cmp.totalRev)} → ${formatEUR(totalRev)}.`,
        onClick: () => {
          const body = el('div');
          body.appendChild(mkCmpGrid([
            { label: 'Total Revenue',
              curVal: mkDrillValue(formatEUR(totalRev), () => drillDownModal('Total Revenue', drillRevRowsPnL(cur.payments, cur.invoices), REV_COLS)),
              cmpVal: mkDrillValue(formatEUR(cmp.totalRev), () => drillDownModal(`Total Revenue — ${cl}`, drillRevRowsPnL(cmp.payments, cmp.invoices), REV_COLS)) }
          ], 'Current Period', cl));
          body.appendChild(el('div', { style: 'font-size:12px;color:var(--text-muted);margin-top:-8px' }, `Change: ${sign}${delta.toFixed(1)}% vs ${cl}`));
          openModal({ title: 'Revenue vs Prior Period', body });
        }
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
      body: `OpEx is ${expenseRatio.toFixed(1)}% of revenue.${trendStr} ${expenseRatio > 80 ? 'High expense burden — review costs.' : expenseRatio > 60 ? 'Moderate expenses — monitor trend.' : 'Healthy expense level.'}`,
      onClick: () => {
        const body = el('div');
        if (cmp && trend !== null) {
          body.appendChild(mkCmpGrid([
            { label: 'Operating Expenses',
              curVal: mkDrillValue(formatEUR(cur.opEx), () => drillDownModal('Operating Expenses', drillExpRows(cur.opExpenses), EXP_COLS)),
              cmpVal: mkDrillValue(formatEUR(cmp.opEx), () => drillDownModal(`Operating Expenses — ${cl}`, drillExpRows(cmp.opExpenses), EXP_COLS)) },
            { label: 'Revenue', curVal: formatEUR(totalRev), cmpVal: formatEUR(cmp.totalRev) },
            { label: 'Expense Ratio', curVal: `${expenseRatio.toFixed(1)}%`, cmpVal: `${cmp.expenseRatio.toFixed(1)}%` }
          ], 'Current Period', cl));
        } else {
          body.appendChild(mkSummaryGrid([
            { label: 'Operating Expenses', value: mkDrillValue(formatEUR(cur.opEx), () => drillDownModal('Operating Expenses', drillExpRows(cur.opExpenses), EXP_COLS)) },
            { label: 'Revenue',            value: formatEUR(totalRev) },
            { label: 'Expense Ratio',      value: `${expenseRatio.toFixed(1)}%` }
          ], 3));
        }
        openModal({ title: 'Expense Ratio', body });
      }
    });
  }

  // 3. Overdue alert
  if (overdueCount > 0) {
    insights.push({
      icon:  '⚠️',
      color: 'var(--danger, #ef4444)',
      bg:    'rgba(239,68,68,0.06)',
      title: 'Overdue Invoices',
      body:  `${overdueCount} overdue invoice${overdueCount !== 1 ? 's' : ''} totalling ${formatEUR(overdueEur)}. Follow up with clients to improve cash flow.`,
      onClick: () => drillDownModal('Overdue Invoices', drillRevRows([], cur.overdueInvoices), REV_COLS)
    });
  } else if (cur.outTotal > 0) {
    insights.push({
      icon:  '✅',
      color: 'var(--success, #22c55e)',
      bg:    'rgba(34,197,94,0.06)',
      title: 'Overdue Status',
      body:  `No overdue invoices. ${formatEUR(cur.outTotal)} outstanding invoices are all within due dates.`,
      onClick: () => drillDownModal('Outstanding Invoices', drillRevRows([], cur.outstandingInvoices), REV_COLS)
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
        body:  `Revenue is at ${accuracy.toFixed(0)}% of the ${year} annual target (${formatEUR(cur.totalRev)} of ${formatEUR(fcRevTarget)}).`,
        onClick: () => {
          const body = el('div');
          body.appendChild(mkSummaryGrid([
            { label: 'Annual Target', value: formatEUR(fcRevTarget) },
            { label: 'Actual Revenue', value: mkDrillValue(formatEUR(cur.totalRev), () => drillDownModal('Actual Revenue', drillRevRowsPnL(cur.payments, cur.invoices), REV_COLS)) },
            { label: 'Accuracy',       value: `${accuracy.toFixed(0)}%` }
          ], 3));
          openModal({ title: `Forecast Accuracy — ${year}`, body });
        }
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
      style: `padding:10px 12px;border-radius:4px;border-left:3px solid ${ins.color};background:${ins.bg}` +
             (ins.onClick ? ';cursor:pointer' : '')
    });
    if (ins.onClick) { block.title = 'Click for breakdown'; block.onclick = ins.onClick; }
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
      const mPays = cur.payments.filter(p => p.date?.slice(0,7) === mk);
      const mInvs = cur.invoices.filter(i => (i.issueDate||'').slice(0,7) === mk);
      const mOpEx2 = cur.opExpenses.filter(e => (e.date||'').slice(0,7) === mk);
      const mCapEx2 = cur.capExpenses.filter(e => (e.date||'').slice(0,7) === mk);
      body.appendChild(mkSummaryGrid([
        { label: 'Revenue',   value: mkDrillValue(formatEUR(mRev), () => drillDownModal(`${months[idx].label} — Revenue`, drillRevRows(mPays, mInvs), REV_COLS)) },
        { label: 'OpEx',      value: mkDrillValue(formatEUR(mOpEx), () => drillDownModal(`${months[idx].label} — Operating Expenses`, drillExpRows(mOpEx2), EXP_COLS)) },
        { label: 'CapEx',     value: mkDrillValue(formatEUR(mCapEx), () => drillDownModal(`${months[idx].label} — Capital Expenses`, drillExpRows(mCapEx2), EXP_COLS)) },
        { label: 'Net',       value: mkDrillValue(formatEUR(mNet), () => drillDownModal(`${months[idx].label} — Net`, drillNetRows(mPays, mInvs, [...mOpEx2, ...mCapEx2]), NET_COLS)), sub: mNet >= 0 ? 'Profitable' : 'Loss',
          explain: {
            title: 'Net (month)',
            formula: 'Monthly Revenue − Monthly OpEx − Monthly CapEx.',
            inputs: [
              { label: 'Revenue', value: formatEUR(mRev) },
              { label: 'OpEx',    value: formatEUR(mOpEx) },
              { label: 'CapEx',   value: formatEUR(mCapEx) },
              { label: 'Net',     value: formatEUR(mNet) }
            ],
            source: 'analytics.js — renderRevExpBar() onClickItem'
          }
        }
      ]));

      if (mPays.length || mInvs.length) {
        const streamMap2 = new Map();
        mPays.forEach(p => {
          const key = STREAM_LABELS[p.stream || 'other'] || p.stream || 'Other';
          streamMap2.set(key, (streamMap2.get(key) || 0) + toEUR(p.amount, p.currency, p.date));
        });
        mInvs.forEach(i => {
          const key = STREAM_LABELS[i.stream || 'other'] || i.stream || 'Other';
          streamMap2.set(key, (streamMap2.get(key) || 0) + toEUR(i.total, i.currency, i.issueDate));
        });
        body.appendChild(mkSectionLabel('Revenue by Stream'));
        body.appendChild(mkModalTable([
          { label: 'Stream', tip: 'Business line label.' },
          { label: 'Amount', right: true, tip: 'Revenue from this stream in the selected month.' }
        ],
          [...streamMap2.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, formatEUR(v)])
        ));
      }
      if (mOpEx2.length || mCapEx2.length) {
        const catMap = new Map();
        [...mOpEx2, ...mCapEx2].forEach(e => {
          const key = e.category || 'Uncategorized';
          catMap.set(key, (catMap.get(key) || 0) + toEUR(e.amount, e.currency, e.date));
        });
        body.appendChild(mkSectionLabel('Expenses by Category'));
        body.appendChild(mkModalTable([
          { label: 'Category', tip: 'Expense category (OpEx and CapEx combined).' },
          { label: 'Amount',   right: true, tip: 'Total expense amount in this category for the selected month.' }
        ],
          [...catMap.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, formatEUR(v)])
        ));
      }

      if (mPays.length || mInvs.length || mOpEx2.length || mCapEx2.length) {
        const footer = el('div', { style: 'margin-top:16px;padding-top:12px;border-top:1px solid rgba(255,255,255,0.08);display:flex;justify-content:flex-end' });
        const link = el('a', { style: 'font-size:12px;cursor:pointer;color:var(--accent)' }, 'View all records →');
        link.onclick = () => {
          const rawBody = el('div');
          if (mPays.length || mInvs.length) {
            rawBody.appendChild(mkSectionLabel('Revenue Records'));
            rawBody.appendChild(mkModalTable([
              { label: 'Date',   tip: 'Payment or invoice date.' },
              { label: 'Entity', tip: 'Property (for payments) or client (for invoices).' },
              { label: 'Type',   tip: 'Whether this record is a rental payment or a service invoice.' },
              { label: 'Amount', right: true, tip: 'Record amount in EUR.' }
            ],
              [...mPays.map(p => [p.date||'—', byId('properties',p.propertyId)?.name||'—', 'Payment', formatEUR(toEUR(p.amount,p.currency,p.date))]),
               ...mInvs.map(i => [i.issueDate||'—', byId('clients',i.clientId)?.name||'—', 'Invoice', formatEUR(toEUR(i.total,i.currency,i.issueDate))])]
              .sort((a,b) => a[0].localeCompare(b[0]))
            ));
          }
          if (mOpEx2.length || mCapEx2.length) {
            rawBody.appendChild(mkSectionLabel('Expense Records'));
            rawBody.appendChild(mkModalTable([
              { label: 'Date',        tip: 'Expense date.' },
              { label: 'Description', tip: 'Expense description or notes.' },
              { label: 'Type',        tip: 'Whether this is an operating expense (OpEx) or capital expense (CapEx).' },
              { label: 'Amount',      right: true, tip: 'Expense amount in EUR.' }
            ],
              [...mOpEx2.map(e => [e.date||'—', e.description||e.notes||'—', 'OpEx', formatEUR(toEUR(e.amount,e.currency,e.date))]),
               ...mCapEx2.map(e => [e.date||'—', e.description||e.notes||'—', 'CapEx', formatEUR(toEUR(e.amount,e.currency,e.date))])]
              .sort((a,b) => a[0].localeCompare(b[0]))
            ));
          }
          openModal({ title: `${months[idx].label} — All Records`, body: rawBody, large: true });
        };
        footer.appendChild(link);
        body.appendChild(footer);
      }

      openModal({ title: `${months[idx].label} — P&L Summary`, body, large: true });
    }
  });
}

// ── Chart: Business Mix Donut ─────────────────────────────────────────────────
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

// Revenue drill-down for one stream — shared by the per-stream KPI card row
// and the "Business Mix" donut's click handler so both surfaces open the
// identical detail view.
function openStreamRevenueModal(streamKey, streamTotal, totalRevMix, cur, cmp, cmpLabel) {
  const streamLabel = STREAM_LABELS[streamKey] || streamKey;
  const body = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });
  const pays = cur.payments.filter(p => (p.stream || 'other') === streamKey);
  const invs = cur.invoices.filter(i => (i.stream || 'other') === streamKey);
  if (cmp) {
    const cmpPays = cmp.payments.filter(p => (p.stream || 'other') === streamKey);
    const cmpInvs = cmp.invoices.filter(i => (i.stream || 'other') === streamKey);
    const cmpTotal = cmp.streamMap.get(streamKey) || 0;
    body.appendChild(mkCmpGrid([
      { label: 'Stream', curVal: streamLabel, cmpVal: streamLabel },
      { label: 'Revenue',
        curVal: mkDrillValue(formatEUR(streamTotal), () => drillDownModal(`${streamLabel} — Revenue`, drillRevRowsPnL(pays, invs), REV_COLS)),
        cmpVal: mkDrillValue(formatEUR(cmpTotal), () => drillDownModal(`${streamLabel} — Revenue — ${cmpLabel}`, drillRevRowsPnL(cmpPays, cmpInvs), REV_COLS)),
        explain: {
          title: `${streamLabel} Revenue`,
          formula: 'Sum of paid payments + paid invoices tagged with this stream, within the selected period.',
          inputs: [
            { label: 'Stream',  value: streamLabel },
            { label: 'Revenue', value: formatEUR(streamTotal) }
          ],
          source: 'analytics.js:130-132 getData() (streamMap)'
        }
      },
      { label: '% of Mix',
        curVal: totalRevMix > 0 ? (streamTotal / totalRevMix * 100).toFixed(1) + '%' : '—',
        cmpVal: cmp.totalRev > 0 ? (cmpTotal / cmp.totalRev * 100).toFixed(1) + '%' : '—',
        explain: {
          title: '% of Mix',
          formula: 'This stream\'s revenue ÷ total revenue across all streams × 100.',
          inputs: [
            { label: 'Stream Revenue', value: formatEUR(streamTotal) },
            { label: 'Total Revenue (all streams)', value: formatEUR(totalRevMix) }
          ],
          source: 'analytics.js — openStreamRevenueModal()'
        }
      }
    ], 'Current Period', cmpLabel));
  } else {
    body.appendChild(mkSummaryGrid([
      { label: 'Stream',   value: streamLabel },
      { label: 'Revenue',
        value: mkDrillValue(formatEUR(streamTotal), () => drillDownModal(`${streamLabel} — Revenue`, drillRevRowsPnL(pays, invs), REV_COLS)),
        explain: {
          title: `${streamLabel} Revenue`,
          formula: 'Sum of paid payments + paid invoices tagged with this stream, within the selected period.',
          inputs: [
            { label: 'Stream',  value: streamLabel },
            { label: 'Revenue', value: formatEUR(streamTotal) }
          ],
          source: 'analytics.js:130-132 getData() (streamMap)'
        }
      },
      { label: '% of Mix', value: totalRevMix > 0 ? (streamTotal / totalRevMix * 100).toFixed(1) + '%' : '—',
        explain: {
          title: '% of Mix',
          formula: 'This stream\'s revenue ÷ total revenue across all streams × 100.',
          inputs: [
            { label: 'Stream Revenue', value: formatEUR(streamTotal) },
            { label: 'Total Revenue (all streams)', value: formatEUR(totalRevMix) }
          ],
          source: 'analytics.js — openStreamRevenueModal()'
        }
      }
    ], 3));
  }
  if (pays.length) {
    body.appendChild(mkSectionLabel('Payments'));
    body.appendChild(mkModalTable([
      { label: 'Date',     tip: 'Payment date.' },
      { label: 'Property', tip: 'Property the payment is linked to.' },
      { label: 'Amount',   right: true, tip: 'Payment amount in EUR.' }
    ],
      pays.sort((a,b) => (b.date||'').localeCompare(a.date||'')).slice(0,8)
          .map(p => [p.date||'—', byId('properties',p.propertyId)?.name||'—', formatEUR(toEUR(p.amount,p.currency,p.date))])
    ));
  }
  if (invs.length) {
    body.appendChild(mkSectionLabel('Invoices'));
    body.appendChild(mkModalTable([
      { label: 'Date',   tip: 'Invoice issue date.' },
      { label: 'Client', tip: 'Client the invoice was billed to.' },
      { label: 'Amount', right: true, tip: 'Invoice total in EUR.' }
    ],
      invs.sort((a,b) => (b.issueDate||'').localeCompare(a.issueDate||'')).slice(0,8)
          .map(i => [i.issueDate||'—', byId('clients',i.clientId)?.name||'—', formatEUR(toEUR(i.subtotal ?? i.total,i.currency,i.issueDate))])
    ));
  }
  if (!pays.length && !invs.length) body.appendChild(mkEmptyState('No records for this stream.'));
  openModal({ title: `${streamLabel} — Revenue Detail`, body, large: true });
}

// Per-stream KPI card row — one card per stream with revenue this period, so
// the business mix is visible at a glance instead of only through the donut
// chart further down the page.
function buildStreamKpiRow(cur, cmp, cmpRange) {
  const entries = [...cur.streamMap.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return null;
  const totalRevMix = entries.reduce((s, [, v]) => s + v, 0);
  const cmpLabel = cmpRange?.label;

  const grid = el('div', {
    class: 'mb-16',
    style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px'
  });
  for (const [streamKey, streamTotal] of entries) {
    const cmpTotal = cmp ? (cmp.streamMap.get(streamKey) || 0) : null;
    grid.appendChild(mkKpiCard({
      label:     STREAM_LABELS[streamKey] || streamKey,
      value:     formatEUR(streamTotal),
      subtitle:  totalRevMix > 0 ? `${(streamTotal / totalRevMix * 100).toFixed(0)}% of revenue mix` : null,
      delta:     cmp ? safePct(streamTotal, cmpTotal) : null,
      compLabel: cmpLabel,
      compValue: cmp ? formatEUR(cmpTotal ?? 0) : undefined,
      onClick:   () => openStreamRevenueModal(streamKey, streamTotal, totalRevMix, cur, cmp, cmpLabel),
      explain: {
        title: `${STREAM_LABELS[streamKey] || streamKey} Revenue`,
        formula: 'Sum of paid payments + paid invoices tagged with this stream, within the selected period.',
        inputs: [
          { label: 'Stream Revenue', value: formatEUR(streamTotal) },
          { label: 'Total Revenue (all streams)', value: formatEUR(totalRevMix) },
          { label: '% of Mix', value: totalRevMix > 0 ? `${(streamTotal / totalRevMix * 100).toFixed(0)}%` : '—' }
        ],
        source: 'analytics.js:130-132 getData() (streamMap)'
      }
    }));
  }
  return el('div', {}, mkSectionLabel('Revenue by Stream'), grid);
}

function renderMixDonut(cur) {
  const { streamMap } = cur;
  const entries = [...streamMap.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return;

  const totalRevMix = entries.reduce((s, [, v]) => s + v, 0);

  charts.doughnut('exec-mix-donut', {
    labels: entries.map(([k]) => STREAM_LABELS[k] || k),
    data:   entries.map(([, v]) => Math.round(v)),
    colors: entries.map(([k]) => STREAM_COLORS[k] || '#8b93b0'),
    onClickItem: (label, index) => {
      const [streamKey, streamTotal] = entries[index];
      openStreamRevenueModal(streamKey, streamTotal, totalRevMix, cur);
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
      const mPays = payments.filter(p => p.date?.slice(0, 7) === mk);
      const mInvs = invoices.filter(i => (i.issueDate || '').slice(0, 7) === mk);
      const mOpEx = opExpenses.filter(e => (e.date || '').slice(0, 7) === mk);
      const mCapEx = capExpenses.filter(e => (e.date || '').slice(0, 7) === mk);
      body.appendChild(mkSummaryGrid([
        { label: 'Month',         value: months[idx].label },
        { label: 'Net Cash Flow',
          value: mkDrillValue(formatEUR(mNet), () => drillDownModal(`${months[idx].label} — Net Cash Flow`, drillNetRows(mPays, mInvs, [...mOpEx, ...mCapEx]), NET_COLS)),
          sub: mNet >= 0 ? 'Positive' : 'Negative',
          explain: {
            title: 'Net Cash Flow (month)',
            formula: 'Monthly (paid payments + paid invoices) − Monthly (OpEx + CapEx).',
            inputs: [{ label: 'Net Cash Flow', value: formatEUR(mNet) }],
            source: 'analytics.js — renderNetLine() netData'
          }
        }
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

  const streamKpiRow = buildStreamKpiRow(curData, cmpData, cmpRange);
  if (streamKpiRow) wrap.appendChild(streamKpiRow);

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
    donutCard.appendChild(el('div', { class: 'card-header' },
      el('div', { class: 'card-title' }, 'Revenue by Business Line')
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
