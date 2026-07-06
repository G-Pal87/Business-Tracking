// Cash Flow Analytics Dashboard — track liquidity
import { el, buildMultiSelect, button, fmtDate, attachSortFilter, openModal } from '../core/ui.js';
import * as charts from '../core/charts.js';
import { STREAMS, OWNERS, COST_CATEGORIES } from '../core/config.js';
import {
  formatEUR, toEUR, byId,
  listActive, listActivePayments, isCapEx, resolveExpenseFields, companyPropIds
} from '../core/data.js';
import {
  createFilterState, getCurrentPeriodRange, getComparisonRange,
  getMonthKeysForRange, makeMatchers, buildFilterBar, buildComparisonLine
} from './analytics-filters.js?v=20260519';
import { mkSectionLabel, mkSummaryBox, mkModalTable, mkSummaryGrid, mkVarianceBadge, mkEmptyState, mkKpiCard, mkCmpGrid, expStream, safePct, fmtK, mkInsightsBanner } from './analytics-helpers.js';

// ── Filter state ──────────────────────────────────────────────────────────────
let gF = createFilterState();
let gScope = 'company'; // 'company' | 'all'

const CHART_IDS = ['cf-cumulative-line', 'cf-month-bar', 'cf-net-donut', 'cf-net-month-bar', 'cf-prop-hbar', 'cf-stream-bar'];
const MONTH_LABELS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

let _cfSortCol = -1, _cfSortDir = 1;

// ── Module export ─────────────────────────────────────────────────────────────
export default {
  id:    'analytics-cashflow',
  label: 'Cash Flow',
  icon:  '💹',
  render(container) { container.appendChild(buildView()); },
  refresh() { rebuildView(); },
  destroy() { CHART_IDS.forEach(id => charts.destroy(id)); }
};

// ── Data aggregation ──────────────────────────────────────────────────────────
function getData(start, end) {
  const { mStream, mOwner, mProperty, mClient } = makeMatchers(gF);

  // Expense stream uses expStream() fallback — custom to avoid null rejection
  const mExpStream = e => !gF.streams.size || gF.streams.has(expStream(e));

  // Invoice owner with client-owner fallback
  const mInvOwner = inv => {
    if (!gF.owners.size) return true;
    let ow = inv.owner;
    if (!ow && inv.clientId) ow = byId('clients', inv.clientId)?.owner;
    ow = ow || 'both';
    return ow === 'both' || gF.owners.has(ow);
  };

  const inRange = d => !!d && d >= start && d <= end;
  const coPropIds = companyPropIds();
  const isCoRec = gScope === 'all'
    ? () => true
    : r => !r.propertyId || coPropIds.has(r.propertyId);

  const payments = listActivePayments().filter(p =>
    p.status === 'paid' && inRange(p.date) && mStream(p) && mOwner(p) && mProperty(p) && isCoRec(p)
  );
  const invoices = listActive('invoices').filter(i =>
    i.status === 'paid' && inRange(i.issueDate || i.date) && mStream(i) && mInvOwner(i) && mClient(i)
  );

  const allExp    = listActive('expenses');
  const opExpenses  = allExp.filter(e => !isCapEx(e) && inRange(e.date) && mExpStream(e) && mOwner(e) && mProperty(e) && isCoRec(e));
  const capExpenses = allExp.filter(e =>  isCapEx(e) && inRange(e.date) && mExpStream(e) && mOwner(e) && mProperty(e) && isCoRec(e));
  const expenses = [...opExpenses, ...capExpenses];

  const sum = arr => arr.reduce((s, x) => s + toEUR(x.amount ?? x.total, x.currency, x.date ?? x.issueDate), 0);
  const cashIn       = payments.reduce((s, p) => s + toEUR(p.amount, p.currency, p.date), 0)
                     + invoices.reduce((s, i) => s + toEUR(i.total, i.currency, i.issueDate), 0);
  const opExCashOut  = sum(opExpenses);
  const investCashOut = sum(capExpenses);
  const cashOut      = opExCashOut + investCashOut;
  const opCashFlow   = cashIn - opExCashOut;
  const net          = cashIn - cashOut;

  // Months with any cash activity (for avg monthly net)
  const activeMonths = new Set();
  payments   .forEach(p => { const mk = p.date?.slice(0, 7);              if (mk) activeMonths.add(mk); });
  invoices   .forEach(i => { const mk = (i.issueDate || '').slice(0, 7); if (mk) activeMonths.add(mk); });
  opExpenses .forEach(e => { const mk = e.date?.slice(0, 7);              if (mk) activeMonths.add(mk); });
  capExpenses.forEach(e => { const mk = e.date?.slice(0, 7);              if (mk) activeMonths.add(mk); });
  const activeMonthCount = activeMonths.size;
  const avgMonthlyNet    = activeMonthCount > 0 ? net / activeMonthCount : 0;

  return {
    payments, invoices, opExpenses, capExpenses, expenses,
    cashIn, opExCashOut, investCashOut, cashOut, opCashFlow, net,
    avgMonthlyNet, activeMonthCount
  };
}

// ── Rebuild ───────────────────────────────────────────────────────────────────
function rebuildView() {
  CHART_IDS.forEach(id => charts.destroy(id));
  const c = document.getElementById('content');
  if (!c) return;
  c.innerHTML = '';
  c.appendChild(buildView());
}

// ── Row builder — shared between table and all drill-down modals ──────────────
// _type: 'in' | 'opex' | 'capex'
function buildCashFlowRows(payments, invoices, opExpenses, capExpenses) {
  const rows = [];
  payments.forEach(p => {
    const prop = byId('properties', p.propertyId);
    rows.push({
      date:        p.date,
      _type:       'in',
      _eur:        toEUR(p.amount, p.currency, p.date),
      source:      'Payment',
      type:        'Cash In',
      stream:      STREAMS[p.stream]?.short || p.stream || '—',
      entity:      prop?.name || p.source || '—',
      owner:       OWNERS[prop?.owner] || prop?.owner || '—',
      description: '—',
      amountEUR:   formatEUR(toEUR(p.amount, p.currency, p.date))
    });
  });
  invoices.forEach(i => {
    const client = byId('clients', i.clientId);
    rows.push({
      date:        i.issueDate || i.date,
      _type:       'in',
      _eur:        toEUR(i.total, i.currency, i.issueDate),
      source:      'Invoice',
      type:        'Cash In',
      stream:      STREAMS[i.stream]?.short || i.stream || '—',
      entity:      client?.name || '—',
      owner:       OWNERS[i.owner || client?.owner] || i.owner || client?.owner || '—',
      description: '—',
      amountEUR:   formatEUR(toEUR(i.total, i.currency, i.issueDate))
    });
  });
  opExpenses.forEach(e => {
    const prop = byId('properties', e.propertyId);
    rows.push({
      date:        e.date,
      _type:       'opex',
      _eur:        toEUR(e.amount, e.currency, e.date),
      source:      'Expense',
      type:        'Operating Cash Out',
      stream:      STREAMS[expStream(e)]?.short || expStream(e) || '—',
      entity:      prop?.name || e.vendorId && byId('vendors', e.vendorId)?.name || '—',
      owner:       OWNERS[prop?.owner] || prop?.owner || '—',
      description: e.description || e.category || '—',
      amountEUR:   formatEUR(toEUR(e.amount, e.currency, e.date))
    });
  });
  capExpenses.forEach(e => {
    const prop = byId('properties', e.propertyId);
    rows.push({
      date:        e.date,
      _type:       'capex',
      _eur:        toEUR(e.amount, e.currency, e.date),
      source:      'Expense',
      type:        'Investment Cash Out',
      stream:      STREAMS[expStream(e)]?.short || expStream(e) || '—',
      entity:      prop?.name || e.vendorId && byId('vendors', e.vendorId)?.name || '—',
      owner:       OWNERS[prop?.owner] || prop?.owner || '—',
      description: e.description || e.category || '—',
      amountEUR:   formatEUR(toEUR(e.amount, e.currency, e.date))
    });
  });
  return rows.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

const CF_DRILL_COLS = [
  { key: 'date',        label: 'Date',        format: v => fmtDate(v) },
  { key: 'source',      label: 'Source'                               },
  { key: 'type',        label: 'Type'                                 },
  { key: 'stream',      label: 'Stream'                               },
  { key: 'entity',      label: 'Entity'                               },
  { key: 'owner',       label: 'Owner'                                },
  { key: 'description', label: 'Description'                          },
  { key: 'amountEUR',   label: 'Amount EUR',  right: true             }
];

// ── Cash Flow Insights ────────────────────────────────────────────────────────
function computeCashFlowInsights(curData, cmpData, cmpRange) {
  const { payments, invoices, opExpenses, capExpenses, cashIn, opExCashOut, investCashOut, cashOut, opCashFlow, net } = curData;
  const signals = [];

  if (cashIn === 0 && cashOut === 0) {
    signals.push({
      severity: 'Note',
      title: 'NO CASH FLOW DATA',
      text: 'No cash flow data for the selected period and filters.',
      inspect: null
    });
    return signals;
  }

  // Negative operating cash flow
  if (opCashFlow < 0) {
    signals.push({
      severity: 'At Risk',
      title: 'NEGATIVE OPERATING CASH FLOW',
      text: `Operating cash flow is ${formatEUR(opCashFlow)} — operating expenses exceed cash in before CapEx.`,
      inspect: 'Transactions',
      onClick: () => openOperatingCashFlowModal(curData)
    });
  }

  // Negative net cash flow (only if op was positive, so we don't double-flag)
  if (net < 0 && opCashFlow >= 0) {
    signals.push({
      severity: 'Watch',
      title: 'NEGATIVE NET CASH FLOW',
      text: `Net cash flow is ${formatEUR(net)} after investment spend. Operating cash flow is positive.`,
      inspect: 'Transactions',
      onClick: () => openNetCashFlowModal(curData, cmpData, cmpRange)
    });
  } else if (net < 0 && opCashFlow < 0) {
    // Both negative — already flagged op, just add note on net
  }

  // Investment pressure
  if (cashOut > 0 && investCashOut > 0) {
    const investPct = investCashOut / cashOut * 100;
    if (investPct > 40) {
      signals.push({
        severity: 'Watch',
        title: 'INVESTMENT PRESSURE',
        text: `Investment cash out (CapEx) is ${investPct.toFixed(0)}% of total cash out — significant capital deployment.`,
        inspect: 'Investment Cash Out',
        onClick: () => openInvestmentCashOutModal(curData)
      });
    }
  }

  // Thin cash buffer
  if (cashIn > 0) {
    const burnRate = cashOut / cashIn * 100;
    if (burnRate > 90 && net >= 0) {
      signals.push({
        severity: 'Watch',
        title: 'THIN CASH BUFFER',
        text: `Cash out consumes ${burnRate.toFixed(0)}% of cash in. Buffer is very thin.`,
        inspect: 'Monthly Cash In vs Cash Out',
        onClick: () => openNetCashFlowModal(curData, cmpData, cmpRange)
      });
    }
  }

  // Negative months count
  const monthMap = new Map();
  const addMk = (mk, inAmt, outAmt) => {
    if (!mk) return;
    const c = monthMap.get(mk) || { in: 0, out: 0 };
    c.in  += inAmt;
    c.out += outAmt;
    monthMap.set(mk, c);
  };
  payments   .forEach(p => addMk(p.date?.slice(0, 7),              toEUR(p.amount, p.currency, p.date), 0));
  invoices   .forEach(i => addMk((i.issueDate || '').slice(0, 7),  toEUR(i.total, i.currency, i.issueDate), 0));
  opExpenses .forEach(e => addMk(e.date?.slice(0, 7),              0, toEUR(e.amount, e.currency, e.date)));
  capExpenses.forEach(e => addMk(e.date?.slice(0, 7),              0, toEUR(e.amount, e.currency, e.date)));
  const allMonths = [...monthMap.values()];
  const negCount  = allMonths.filter(m => m.in - m.out < 0).length;
  if (allMonths.length > 1 && negCount >= Math.ceil(allMonths.length / 2)) {
    signals.push({
      severity: negCount === allMonths.length ? 'At Risk' : 'Watch',
      title: 'NEGATIVE MONTHS',
      text: `${negCount} of ${allMonths.length} months have negative net cash flow.`,
      inspect: 'Monthly Net Cash Flow',
      onClick: () => openNetCashFlowModal(curData, cmpData, cmpRange)
    });
  }

  if (signals.length === 0) {
    signals.push({
      severity: 'Note',
      title: 'HEALTHY',
      text: 'No major cash flow risks detected for the selected period.',
      inspect: null
    });
  }

  return signals;
}

// ── Cash Seasonality Heatmap ──────────────────────────────────────────────────
function buildCashSeasonalityHeatmap() {
  // Build net cash flow heatmap across ALL available years (not just filtered period)
  const { mStream, mOwner, mProperty, mClient } = makeMatchers(gF);
  const mExpStream = e => !gF.streams.size || gF.streams.has(expStream(e));
  const mInvOwner = inv => {
    if (!gF.owners.size) return true;
    let ow = inv.owner;
    if (!ow && inv.clientId) ow = byId('clients', inv.clientId)?.owner;
    ow = ow || 'both';
    return ow === 'both' || gF.owners.has(ow);
  };

  // For the heatmap we pull ALL data (no date filter) so all years are visible
  const allPays = listActivePayments().filter(p => p.status === 'paid' && mStream(p) && mOwner(p) && mProperty(p));
  const allInvs = listActive('invoices').filter(i => i.status === 'paid' && mStream(i) && mInvOwner(i) && mClient(i));
  const allOpEx = listActive('expenses').filter(e => !isCapEx(e) && mExpStream(e) && mOwner(e) && mProperty(e));
  const allCapEx = listActive('expenses').filter(e => isCapEx(e) && mExpStream(e) && mOwner(e) && mProperty(e));

  const allYears = [...new Set([
    ...allPays .map(p => p.date?.slice(0, 4)),
    ...allInvs .map(i => (i.issueDate || '').slice(0, 4)),
    ...allOpEx .map(e => e.date?.slice(0, 4)),
    ...allCapEx.map(e => e.date?.slice(0, 4))
  ].filter(Boolean))].sort();
  if (!allYears.length) return null;

  const grid = new Map(); // key: 'YYYY-MM' → net EUR
  allPays .forEach(p => { const k = p.date?.slice(0, 7);              if (k) grid.set(k, (grid.get(k) || 0) + toEUR(p.amount, p.currency, p.date)); });
  allInvs .forEach(i => { const k = (i.issueDate || '').slice(0, 7); if (k) grid.set(k, (grid.get(k) || 0) + toEUR(i.total, i.currency, i.issueDate)); });
  allOpEx .forEach(e => { const k = e.date?.slice(0, 7);              if (k) grid.set(k, (grid.get(k) || 0) - toEUR(e.amount, e.currency, e.date)); });
  allCapEx.forEach(e => { const k = e.date?.slice(0, 7);              if (k) grid.set(k, (grid.get(k) || 0) - toEUR(e.amount, e.currency, e.date)); });

  const allVals = [...grid.values()];
  const maxAbs = Math.max(...allVals.map(Math.abs), 1);

  const wrap = el('div', { class: 'card mb-16', style: 'overflow-x:auto' });
  wrap.appendChild(el('div', { class: 'card-header' },
    el('div', { class: 'card-title' }, 'Cash Seasonality'),
    el('div', { style: 'font-size:12px;color:var(--text-muted)' }, 'Net cash flow by month · Green = surplus · Red = deficit · Click for detail')
  ));

  const table = el('table', { id: 'cf-seasonality-heatmap', style: 'border-collapse:collapse;width:100%;font-size:12px' });
  const htr = el('tr');
  htr.appendChild(el('th', { style: 'text-align:left;padding:4px 8px;color:var(--text-muted);white-space:nowrap' }, 'Year'));
  MONTH_LABELS.forEach(ml => htr.appendChild(el('th', { style: 'padding:4px 6px;text-align:right;color:var(--text-muted)' }, ml)));
  table.appendChild(el('thead', {}, htr));

  const tbody = el('tbody');
  allYears.forEach(y => {
    const tr = el('tr');
    tr.appendChild(el('td', { style: 'padding:4px 8px;font-weight:600;color:var(--text-muted);white-space:nowrap' }, y));
    MONTH_LABELS.forEach((_, mi) => {
      const mm  = String(mi + 1).padStart(2, '0');
      const key = `${y}-${mm}`;
      const v   = grid.get(key) || 0;
      const isPos = v >= 0;
      const alpha = v !== 0 ? Math.max(0.08, Math.abs(v) / maxAbs * 0.75) : 0;
      const bgColor = v > 0
        ? `rgba(16,185,129,${alpha.toFixed(2)})`
        : v < 0
          ? `rgba(239,68,68,${alpha.toFixed(2)})`
          : 'transparent';

      const td = el('td', {
        style: `padding:4px 6px;text-align:right;background:${bgColor};border-radius:3px;cursor:${v !== 0 ? 'pointer' : 'default'}`,
        title: v !== 0 ? `${MONTH_LABELS[mi]} ${y}: ${formatEUR(v)}` : ''
      });

      if (v !== 0) {
        td.appendChild(el('span', { style: `color:${isPos ? '#10b981' : '#ef4444'};font-weight:${Math.abs(v) / maxAbs > 0.4 ? '600' : '400'}` }, fmtK(Math.abs(v))));
        const capturedKey = key;
        td.onclick = () => {
          // Drill into this month's transactions
          const mPay = allPays .filter(p => p.date?.slice(0, 7) === capturedKey);
          const mInv = allInvs .filter(i => (i.issueDate || '').slice(0, 7) === capturedKey);
          const mOp  = allOpEx .filter(e => e.date?.slice(0, 7) === capturedKey);
          const mCap = allCapEx.filter(e => e.date?.slice(0, 7) === capturedKey);
          const mIn     = mPay.reduce((s, p) => s + toEUR(p.amount, p.currency, p.date), 0)
                        + mInv.reduce((s, i) => s + toEUR(i.total, i.currency, i.issueDate), 0);
          const mOpOut  = mOp .reduce((s, e) => s + toEUR(e.amount, e.currency, e.date), 0);
          const mCapOut = mCap.reduce((s, e) => s + toEUR(e.amount, e.currency, e.date), 0);
          const mNet = mIn - mOpOut - mCapOut;

          const body = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });
          const summaryGrid = el('div', { style: 'display:grid;grid-template-columns:repeat(4,1fr);gap:10px' });
          summaryGrid.appendChild(mkSummaryBox('Cash In', formatEUR(mIn), `${mPay.length + mInv.length} items`));
          summaryGrid.appendChild(mkSummaryBox('Op. Cash Out', formatEUR(mOpOut), `${mOp.length} expenses`));
          summaryGrid.appendChild(mkSummaryBox('Invest. Cash Out', formatEUR(mCapOut), `${mCap.length} items`));
          summaryGrid.appendChild(mkSummaryBox('Net Cash Flow', formatEUR(mNet), mNet >= 0 ? 'Surplus' : 'Deficit'));
          body.appendChild(summaryGrid);

          // Stream breakdown
          const streamMap = new Map();
          const addS = (sk, inV, opV, capV) => {
            const c = streamMap.get(sk) || { in: 0, opOut: 0, capOut: 0 };
            c.in += inV; c.opOut += opV; c.capOut += capV;
            streamMap.set(sk, c);
          };
          mPay.forEach(p => addS(p.stream || 'other', toEUR(p.amount, p.currency, p.date), 0, 0));
          mInv.forEach(i => addS(i.stream || 'other', toEUR(i.total, i.currency, i.issueDate), 0, 0));
          mOp .forEach(e => addS(expStream(e), 0, toEUR(e.amount, e.currency, e.date), 0));
          mCap.forEach(e => addS(expStream(e), 0, 0, toEUR(e.amount, e.currency, e.date)));
          const streamEntries = [...streamMap.entries()].sort((a, b) => (b[1].in - b[1].opOut - b[1].capOut) - (a[1].in - a[1].opOut - a[1].capOut));
          if (streamEntries.length > 0) {
            const streamSection = el('div');
            streamSection.appendChild(mkSectionLabel('Breakdown by Stream'));
            streamSection.appendChild(mkModalTable(
              ['Stream', 'Cash In', 'Op. Out', 'Invest. Out', 'Net'],
              streamEntries.map(([sk, d]) => [STREAMS[sk]?.label || sk, formatEUR(d.in), formatEUR(d.opOut), formatEUR(d.capOut), formatEUR(d.in - d.opOut - d.capOut)])
            ));
            body.appendChild(streamSection);
          }

          openModal({ title: `${MONTH_LABELS[mi]} ${y} — Cash Flow`, body, large: true });
        };
      } else {
        td.appendChild(el('span', { style: 'color:var(--text-muted);opacity:0.4' }, '—'));
      }
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

// ── Shared KPI modal openers — reused by both KPI cards and Cash Flow Insights ─
function openOperatingCashFlowModal({ payments, invoices, opExpenses, cashIn, opExCashOut, opCashFlow }) {
  const body = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });

  const summaryGrid = el('div', { style: 'display:grid;grid-template-columns:repeat(3,1fr);gap:10px' });
  summaryGrid.appendChild(mkSummaryBox('Cash In', formatEUR(cashIn), `${payments.length + invoices.length} items`));
  summaryGrid.appendChild(mkSummaryBox('Op. Cash Out', formatEUR(opExCashOut), `${opExpenses.length} expenses`));
  summaryGrid.appendChild(mkSummaryBox('Operating CF', formatEUR(opCashFlow), opCashFlow >= 0 ? 'Surplus' : 'Deficit'));
  body.appendChild(summaryGrid);

  const monthMap = new Map();
  const addM = (mk, inV, outV) => {
    if (!mk) return;
    const c = monthMap.get(mk) || { in: 0, out: 0 };
    c.in += inV; c.out += outV;
    monthMap.set(mk, c);
  };
  payments   .forEach(p => addM(p.date?.slice(0, 7), toEUR(p.amount, p.currency, p.date), 0));
  invoices   .forEach(i => addM((i.issueDate || '').slice(0, 7), toEUR(i.total, i.currency, i.issueDate), 0));
  opExpenses .forEach(e => addM(e.date?.slice(0, 7), 0, toEUR(e.amount, e.currency, e.date)));
  const monthEntries = [...monthMap.entries()].sort(([a], [b]) => a.localeCompare(b));
  const monthSection = el('div');
  monthSection.appendChild(mkSectionLabel('Monthly Breakdown'));
  monthSection.appendChild(mkModalTable(
    ['Month', 'Cash In', 'Op. Out', 'Net CF'],
    monthEntries.map(([mk, d]) => [mk, formatEUR(d.in), formatEUR(d.out), formatEUR(d.in - d.out)])
  ));
  body.appendChild(monthSection);

  const streamMap = new Map();
  payments   .forEach(p => { const k = STREAMS[p.stream]?.label || p.stream || 'Other'; const c = streamMap.get(k) || { in: 0, out: 0 }; c.in  += toEUR(p.amount, p.currency, p.date);  streamMap.set(k, c); });
  invoices   .forEach(i => { const k = STREAMS[i.stream]?.label || i.stream || 'Other'; const c = streamMap.get(k) || { in: 0, out: 0 }; c.in  += toEUR(i.total, i.currency, i.issueDate); streamMap.set(k, c); });
  opExpenses .forEach(e => { const k = STREAMS[expStream(e)]?.label || expStream(e) || 'Other'; const c = streamMap.get(k) || { in: 0, out: 0 }; c.out += toEUR(e.amount, e.currency, e.date); streamMap.set(k, c); });
  const streamEntries = [...streamMap.entries()].sort((a, b) => (b[1].in - b[1].out) - (a[1].in - a[1].out));
  const streamSection = el('div');
  streamSection.appendChild(mkSectionLabel('Breakdown by Stream'));
  streamSection.appendChild(mkModalTable(
    ['Stream', 'Cash In', 'Op. Out', 'Net CF'],
    streamEntries.map(([k, d]) => [k, formatEUR(d.in), formatEUR(d.out), formatEUR(d.in - d.out)])
  ));
  body.appendChild(streamSection);

  openModal({ title: 'Operating Cash Flow — Breakdown', body, large: true });
}

function openInvestmentCashOutModal({ capExpenses, investCashOut, cashOut }) {
  const body = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });

  const avg = capExpenses.length > 0 ? investCashOut / capExpenses.length : 0;
  const summaryGrid = el('div', { style: 'display:grid;grid-template-columns:repeat(3,1fr);gap:10px' });
  summaryGrid.appendChild(mkSummaryBox('Total CapEx Out', formatEUR(investCashOut), `${capExpenses.length} items`));
  summaryGrid.appendChild(mkSummaryBox('Avg per Item', formatEUR(avg), 'per investment expense'));
  const pctOfOut = cashOut > 0 ? (investCashOut / cashOut * 100).toFixed(1) + '%' : '—';
  summaryGrid.appendChild(mkSummaryBox('% of Total Cash Out', pctOfOut, `vs ${formatEUR(cashOut)} total`));
  body.appendChild(summaryGrid);

  const propMap = new Map();
  capExpenses.forEach(e => {
    const name = e.propertyId ? (byId('properties', e.propertyId)?.name || e.propertyId) : 'No Property';
    propMap.set(name, (propMap.get(name) || 0) + toEUR(e.amount, e.currency, e.date));
  });
  const propEntries = [...propMap.entries()].sort((a, b) => b[1] - a[1]);
  const propSection = el('div');
  propSection.appendChild(mkSectionLabel('Breakdown by Property'));
  propSection.appendChild(mkModalTable(
    ['Property', 'Amount', '% of CapEx'],
    propEntries.map(([k, v]) => [k, formatEUR(v), investCashOut > 0 ? (v / investCashOut * 100).toFixed(1) + '%' : '—'])
  ));
  body.appendChild(propSection);

  const catMap = new Map();
  capExpenses.forEach(e => {
    const key = resolveExpenseFields(e).costCategory;
    const cat = COST_CATEGORIES[key]?.label || key || 'Uncategorized';
    catMap.set(cat, (catMap.get(cat) || 0) + toEUR(e.amount, e.currency, e.date));
  });
  const catEntries = [...catMap.entries()].sort((a, b) => b[1] - a[1]);
  const catSection = el('div');
  catSection.appendChild(mkSectionLabel('Breakdown by Category'));
  catSection.appendChild(mkModalTable(
    ['Category', 'Amount', '% of CapEx'],
    catEntries.map(([k, v]) => [k, formatEUR(v), investCashOut > 0 ? (v / investCashOut * 100).toFixed(1) + '%' : '—'])
  ));
  body.appendChild(catSection);

  openModal({ title: 'Investment Cash Out — Breakdown', body, large: true });
}

function openNetCashFlowModal(curData, cmpData, cmpRange) {
  const { payments, invoices, opExpenses, capExpenses, cashIn, opExCashOut, investCashOut, opCashFlow, net } = curData;
  const body = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });

  if (cmpData) {
    body.appendChild(mkCmpGrid([
      { label: 'Cash In (Revenue)', curVal: formatEUR(cashIn),       cmpVal: formatEUR(cmpData.cashIn)       },
      { label: 'OpEx',              curVal: formatEUR(opExCashOut),   cmpVal: formatEUR(cmpData.opExCashOut)   },
      { label: 'CapEx',             curVal: formatEUR(investCashOut), cmpVal: formatEUR(cmpData.investCashOut) },
      { label: 'Net Cash Flow',     curVal: formatEUR(net),           cmpVal: formatEUR(cmpData.net)           },
    ], 'Current Period', cmpRange?.label || ''));
  } else {
    const summaryGrid = el('div', { style: 'display:grid;grid-template-columns:repeat(3,1fr);gap:10px' });
    summaryGrid.appendChild(mkSummaryBox('Operating CF', formatEUR(opCashFlow), `In ${formatEUR(cashIn)} − OpEx ${formatEUR(opExCashOut)}`));
    summaryGrid.appendChild(mkSummaryBox('Investment Out', formatEUR(investCashOut), `${capExpenses.length} CapEx items`));
    summaryGrid.appendChild(mkSummaryBox('Net Cash Flow', formatEUR(net), net >= 0 ? 'Surplus' : 'Deficit'));
    body.appendChild(summaryGrid);
  }

  const monthMap = new Map();
  const addM = (mk, inV, opV, capV) => {
    if (!mk) return;
    const c = monthMap.get(mk) || { in: 0, opOut: 0, capOut: 0 };
    c.in += inV; c.opOut += opV; c.capOut += capV;
    monthMap.set(mk, c);
  };
  payments   .forEach(p => addM(p.date?.slice(0, 7), toEUR(p.amount, p.currency, p.date), 0, 0));
  invoices   .forEach(i => addM((i.issueDate || '').slice(0, 7), toEUR(i.total, i.currency, i.issueDate), 0, 0));
  opExpenses .forEach(e => addM(e.date?.slice(0, 7), 0, toEUR(e.amount, e.currency, e.date), 0));
  capExpenses.forEach(e => addM(e.date?.slice(0, 7), 0, 0, toEUR(e.amount, e.currency, e.date)));
  const monthEntries = [...monthMap.entries()].sort(([a], [b]) => a.localeCompare(b));
  const monthSection = el('div');
  monthSection.appendChild(mkSectionLabel('Monthly Breakdown'));
  monthSection.appendChild(mkModalTable(
    ['Month', 'Cash In', 'Op. Out', 'Invest. Out', 'Net CF'],
    monthEntries.map(([mk, d]) => [mk, formatEUR(d.in), formatEUR(d.opOut), formatEUR(d.capOut), formatEUR(d.in - d.opOut - d.capOut)])
  ));
  body.appendChild(monthSection);

  const propMap = new Map();
  const addP = (name, inV, opV, capV) => {
    const c = propMap.get(name) || { in: 0, opOut: 0, capOut: 0 };
    c.in += inV; c.opOut += opV; c.capOut += capV;
    propMap.set(name, c);
  };
  payments   .forEach(p => { const n = p.propertyId ? (byId('properties', p.propertyId)?.name || p.propertyId) : 'No Property'; addP(n, toEUR(p.amount, p.currency, p.date), 0, 0); });
  opExpenses .forEach(e => { const n = e.propertyId ? (byId('properties', e.propertyId)?.name || e.propertyId) : 'No Property'; addP(n, 0, toEUR(e.amount, e.currency, e.date), 0); });
  capExpenses.forEach(e => { const n = e.propertyId ? (byId('properties', e.propertyId)?.name || e.propertyId) : 'No Property'; addP(n, 0, 0, toEUR(e.amount, e.currency, e.date)); });
  const propEntries = [...propMap.entries()].sort((a, b) => (b[1].in - b[1].opOut - b[1].capOut) - (a[1].in - a[1].opOut - a[1].capOut));
  const propSection = el('div');
  propSection.appendChild(mkSectionLabel('Breakdown by Property'));
  propSection.appendChild(mkModalTable(
    ['Property', 'Cash In', 'Op. Out', 'Invest. Out', 'Net CF'],
    propEntries.map(([k, d]) => [k, formatEUR(d.in), formatEUR(d.opOut), formatEUR(d.capOut), formatEUR(d.in - d.opOut - d.capOut)])
  ));
  body.appendChild(propSection);

  openModal({ title: 'Net Cash Flow — Breakdown', body, large: true });
}

// ── Main view ─────────────────────────────────────────────────────────────────
function buildView() {
  const wrap = el('div', { class: 'view active' });

  // Header
  wrap.appendChild(el('div', { style: 'margin-bottom:16px' },
    el('h2', { style: 'margin:0 0 4px;font-size:20px;font-weight:700' }, 'Cash Flow Analytics'),
    el('p',  { style: 'margin:0;font-size:13px;color:var(--text-muted)' },
      'Liquidity — Cash In (paid payments + invoices) vs Operating and Investment cash out')
  ));

  // Shared filter bar
  const filterBarEl = buildFilterBar(gF, {
    showOwner: true, showStream: true, showProperty: true, showClient: true,
    storagePrefix: 'cf', channelScope: gScope === 'all' ? null : 'company'
  }, newState => {
    if (newState) Object.assign(gF, newState);
    rebuildView();
  });
  wrap.appendChild(filterBarEl);

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

  // Date ranges
  const curRange = getCurrentPeriodRange(gF);
  const cmpRange = getComparisonRange(gF, curRange);
  const { start, end } = curRange;

  const curData = getData(start, end);
  const cmpData = cmpRange ? getData(cmpRange.start, cmpRange.end) : null;

  const {
    payments, invoices, opExpenses, capExpenses, expenses,
    cashIn, opExCashOut, investCashOut, cashOut, opCashFlow, net, avgMonthlyNet
  } = curData;

  // Comparison line
  const compLine = buildComparisonLine(curRange, cmpRange);
  if (compLine) wrap.appendChild(compLine);

  // Deltas (only when comparison is available and safe)
  const deltaCashIn    = safePct(cashIn,        cmpData?.cashIn);
  const deltaOpEx      = safePct(opExCashOut,   cmpData?.opExCashOut);
  const deltaOpCF      = safePct(opCashFlow,    cmpData?.opCashFlow);
  const deltaInvest    = safePct(investCashOut, cmpData?.investCashOut);
  const deltaNet       = safePct(net,           cmpData?.net);
  const deltaAvgNet    = safePct(avgMonthlyNet, cmpData?.avgMonthlyNet);

  // ── KPI row 1: Cash In, Operating Cash Out, Operating Cash Flow ───────────
  const kpiRow1 = el('div', { style: 'display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px;margin-bottom:16px' });
  kpiRow1.appendChild(mkKpiCard({
    label:     'Cash In',
    value:     formatEUR(cashIn),
    variant:   'success',
    delta:     deltaCashIn,
    compLabel: cmpRange?.label,
    compValue: cmpData ? formatEUR(cmpData.cashIn) : undefined,
    onClick:   () => {
      // Summary: Payments vs Invoices totals
      const totalPay = payments.reduce((s, p) => s + toEUR(p.amount, p.currency, p.date), 0);
      const totalInv = invoices.reduce((s, i) => s + toEUR(i.total, i.currency, i.issueDate), 0);
      const body = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });

      // Summary boxes
      const summaryGrid = el('div', { style: 'display:grid;grid-template-columns:repeat(3,1fr);gap:10px' });
      summaryGrid.appendChild(mkSummaryBox('Total Cash In', formatEUR(cashIn), `${payments.length + invoices.length} items`));
      summaryGrid.appendChild(mkSummaryBox('From Payments', formatEUR(totalPay), `${payments.length} payments`));
      summaryGrid.appendChild(mkSummaryBox('From Invoices', formatEUR(totalInv), `${invoices.length} invoices`));
      body.appendChild(summaryGrid);

      // Breakdown by stream
      const streamMap = new Map();
      payments.forEach(p => { const k = STREAMS[p.stream]?.label || p.stream || 'Other'; streamMap.set(k, (streamMap.get(k) || 0) + toEUR(p.amount, p.currency, p.date)); });
      invoices.forEach(i => { const k = STREAMS[i.stream]?.label || i.stream || 'Other'; streamMap.set(k, (streamMap.get(k) || 0) + toEUR(i.total, i.currency, i.issueDate)); });
      const streamEntries = [...streamMap.entries()].sort((a, b) => b[1] - a[1]);

      const streamSection = el('div');
      streamSection.appendChild(mkSectionLabel('Breakdown by Stream'));
      streamSection.appendChild(mkModalTable(
        ['Stream', 'Amount', '% of Total'],
        streamEntries.map(([k, v]) => [k, formatEUR(v), cashIn > 0 ? (v / cashIn * 100).toFixed(1) + '%' : '—'])
      ));
      body.appendChild(streamSection);

      openModal({ title: 'Cash In — Breakdown', body, large: true });
    }
  }));
  kpiRow1.appendChild(mkKpiCard({
    label:       'Operating Cash Out',
    value:       formatEUR(opExCashOut),
    subtitle:    'OpEx cash out',
    delta:       deltaOpEx,
    invertDelta: true,
    compLabel:   cmpRange?.label,
    compValue:   cmpData ? formatEUR(cmpData.opExCashOut) : undefined,
    onClick:     () => {
      const body = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });

      // Summary boxes: total, count, avg per item
      const avg = opExpenses.length > 0 ? opExCashOut / opExpenses.length : 0;
      const summaryGrid = el('div', { style: 'display:grid;grid-template-columns:repeat(3,1fr);gap:10px' });
      summaryGrid.appendChild(mkSummaryBox('Total OpEx Out', formatEUR(opExCashOut), `${opExpenses.length} expenses`));
      summaryGrid.appendChild(mkSummaryBox('Avg per Item', formatEUR(avg), 'per expense'));
      // Largest single expense
      const largest = opExpenses.reduce((max, e) => {
        const v = toEUR(e.amount, e.currency, e.date);
        return v > max.v ? { v, e } : max;
      }, { v: 0, e: null });
      summaryGrid.appendChild(mkSummaryBox('Largest Item', largest.e ? formatEUR(largest.v) : '—', largest.e?.description || largest.e?.category || ''));
      body.appendChild(summaryGrid);

      // Breakdown by category
      const catMap = new Map();
      opExpenses.forEach(e => {
        const key   = resolveExpenseFields(e).costCategory;
        const label = COST_CATEGORIES[key]?.label || key || 'Uncategorized';
        catMap.set(label, (catMap.get(label) || 0) + toEUR(e.amount, e.currency, e.date));
      });
      const catEntries = [...catMap.entries()].sort((a, b) => b[1] - a[1]);
      const catSection = el('div');
      catSection.appendChild(mkSectionLabel('Breakdown by Category'));
      catSection.appendChild(mkModalTable(
        ['Category', 'Amount', '% of Total'],
        catEntries.map(([k, v]) => [k, formatEUR(v), opExCashOut > 0 ? (v / opExCashOut * 100).toFixed(1) + '%' : '—'])
      ));
      body.appendChild(catSection);

      // Breakdown by property
      const propMap = new Map();
      opExpenses.forEach(e => {
        const name = e.propertyId ? (byId('properties', e.propertyId)?.name || e.propertyId) : 'No Property';
        propMap.set(name, (propMap.get(name) || 0) + toEUR(e.amount, e.currency, e.date));
      });
      const propEntries = [...propMap.entries()].sort((a, b) => b[1] - a[1]);
      const propSection = el('div');
      propSection.appendChild(mkSectionLabel('Breakdown by Property'));
      propSection.appendChild(mkModalTable(
        ['Property', 'Amount', '% of Total'],
        propEntries.map(([k, v]) => [k, formatEUR(v), opExCashOut > 0 ? (v / opExCashOut * 100).toFixed(1) + '%' : '—'])
      ));
      body.appendChild(propSection);

      openModal({ title: 'Operating Cash Out — Breakdown', body, large: true });
    }
  }));
  kpiRow1.appendChild(mkKpiCard({
    label:     'Operating Cash Flow',
    value:     formatEUR(opCashFlow),
    variant:   opCashFlow >= 0 ? 'success' : 'danger',
    delta:     deltaOpCF,
    compLabel: cmpRange?.label,
    compValue: cmpData ? formatEUR(cmpData.opCashFlow) : undefined,
    onClick:   () => openOperatingCashFlowModal(curData)
  }));
  wrap.appendChild(kpiRow1);

  // ── KPI row 2: Investment Cash Out, Net Cash Flow, Avg Monthly Net ─────────
  const kpiRow2 = el('div', { style: 'display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px;margin-bottom:16px' });
  kpiRow2.appendChild(mkKpiCard({
    label:       'Investment Cash Out',
    value:       formatEUR(investCashOut),
    variant:     investCashOut > 0 ? 'warning' : '',
    subtitle:    'CapEx cash out',
    delta:       deltaInvest,
    invertDelta: true,
    compLabel:   cmpRange?.label,
    compValue:   cmpData ? formatEUR(cmpData.investCashOut) : undefined,
    onClick:     () => openInvestmentCashOutModal(curData)
  }));
  kpiRow2.appendChild(mkKpiCard({
    label:     'Net Cash Flow',
    value:     formatEUR(net),
    variant:   net >= 0 ? 'success' : 'danger',
    subtitle:  'After OpEx and CapEx',
    delta:     deltaNet,
    compLabel: cmpRange?.label,
    compValue: cmpData ? formatEUR(cmpData.net) : undefined,
    onClick:   () => openNetCashFlowModal(curData, cmpData, cmpRange)
  }));
  kpiRow2.appendChild(mkKpiCard({
    label:     'Avg Monthly Net',
    value:     formatEUR(avgMonthlyNet),
    variant:   avgMonthlyNet >= 0 ? '' : 'warning',
    delta:     deltaAvgNet,
    compLabel: cmpRange?.label,
    compValue: cmpData ? formatEUR(cmpData.avgMonthlyNet) : undefined,
    onClick:   () => {
      const monthMap = new Map();
      const addMk = (mk, inAmt, opOut, capOut) => {
        if (!mk) return;
        const c = monthMap.get(mk) || { in: 0, opOut: 0, capOut: 0 };
        c.in += inAmt; c.opOut += opOut; c.capOut += capOut;
        monthMap.set(mk, c);
      };
      payments   .forEach(p => addMk(p.date?.slice(0, 7),              toEUR(p.amount, p.currency, p.date), 0, 0));
      invoices   .forEach(i => addMk((i.issueDate || '').slice(0, 7),  toEUR(i.total, i.currency, i.issueDate), 0, 0));
      opExpenses .forEach(e => addMk(e.date?.slice(0, 7),              0, toEUR(e.amount, e.currency, e.date), 0));
      capExpenses.forEach(e => addMk(e.date?.slice(0, 7),              0, 0, toEUR(e.amount, e.currency, e.date)));
      const monthEntries = [...monthMap.entries()].sort(([a], [b]) => a.localeCompare(b));
      const monthCount = monthEntries.length;
      const totalNet = monthEntries.reduce((s, [, d]) => s + d.in - d.opOut - d.capOut, 0);
      const posMonths = monthEntries.filter(([, d]) => d.in - d.opOut - d.capOut >= 0).length;

      const body = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });

      // Summary boxes
      const summaryGrid = el('div', { style: 'display:grid;grid-template-columns:repeat(3,1fr);gap:10px' });
      summaryGrid.appendChild(mkSummaryBox('Avg Monthly Net', formatEUR(avgMonthlyNet), `over ${monthCount} active month${monthCount !== 1 ? 's' : ''}`));
      summaryGrid.appendChild(mkSummaryBox('Positive Months', `${posMonths} / ${monthCount}`, posMonths === monthCount ? 'All surplus' : posMonths === 0 ? 'All deficit' : 'Mixed'));
      summaryGrid.appendChild(mkSummaryBox('Total Net', formatEUR(totalNet), 'across all months'));
      body.appendChild(summaryGrid);

      // Monthly table
      const monthSection = el('div');
      monthSection.appendChild(mkSectionLabel('Monthly Net Cash Flow'));
      monthSection.appendChild(mkModalTable(
        ['Month', 'Cash In', 'Op. Out', 'Invest. Out', 'Net'],
        monthEntries.map(([mk, d]) => [mk, formatEUR(d.in), formatEUR(d.opOut), formatEUR(d.capOut), formatEUR(d.in - d.opOut - d.capOut)])
      ));
      body.appendChild(monthSection);

      openModal({ title: 'Avg Monthly Net — Breakdown', body, large: true });
    }
  }));
  wrap.appendChild(kpiRow2);

  // ── KPI row 3: Net Coverage Days, Invoice Collection Lag ─────────────────
  const kpiRow3 = el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px' });

  // Net Coverage Days: (periodNetCashFlow / avgMonthlyOpEx) × 30
  {
    // Build monthly net to find cumulative running balance
    const netByMk = new Map();
    payments   .forEach(p => { const mk = p.date?.slice(0, 7);              if (mk) netByMk.set(mk, (netByMk.get(mk) || 0) + toEUR(p.amount, p.currency, p.date)); });
    invoices   .forEach(i => { const mk = (i.issueDate || '').slice(0, 7); if (mk) netByMk.set(mk, (netByMk.get(mk) || 0) + toEUR(i.total, i.currency, i.issueDate)); });
    opExpenses .forEach(e => { const mk = e.date?.slice(0, 7);              if (mk) netByMk.set(mk, (netByMk.get(mk) || 0) - toEUR(e.amount, e.currency, e.date)); });
    capExpenses.forEach(e => { const mk = e.date?.slice(0, 7);              if (mk) netByMk.set(mk, (netByMk.get(mk) || 0) - toEUR(e.amount, e.currency, e.date)); });

    const sortedMks = [...netByMk.keys()].sort();
    let running = 0;
    const monthlyPositions = sortedMks.map(mk => { running += netByMk.get(mk); return { mk, balance: running }; });
    const isNegativeBalance = running < 0;
    const avgMonthlyOpex = curData.activeMonthCount > 0 ? opExCashOut / curData.activeMonthCount : 0;
    // When period net is negative, coverage is 0 — do not clamp silently, surface it as danger
    const daysOnHand = isNegativeBalance ? 0 : (avgMonthlyOpex > 0 ? Math.round(running / avgMonthlyOpex * 30) : null);

    const dohVariant = isNegativeBalance ? 'danger' : (daysOnHand === null ? '' : daysOnHand >= 90 ? 'success' : daysOnHand >= 30 ? 'warning' : 'danger');
    kpiRow3.appendChild(mkKpiCard({
      label:    'Net Coverage Days',
      value:    isNegativeBalance ? '0 days' : (daysOnHand !== null ? `${daysOnHand} days` : 'N/A'),
      subtitle: isNegativeBalance ? 'Negative period net — cash shortfall' : 'Period net ÷ avg monthly OpEx',
      variant:  dohVariant,
      onClick:  () => {
        const body = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });

        // Summary boxes
        const summaryGrid = el('div', { style: 'display:grid;grid-template-columns:repeat(3,1fr);gap:10px' });
        summaryGrid.appendChild(mkSummaryBox('Cumulative Cash Balance', formatEUR(running), running >= 0 ? 'net positive' : 'net shortfall'));
        summaryGrid.appendChild(mkSummaryBox('Avg Monthly OpEx', formatEUR(avgMonthlyOpex), `${curData.activeMonthCount} active month${curData.activeMonthCount !== 1 ? 's' : ''}`));
        summaryGrid.appendChild(mkSummaryBox('Net Coverage Days', isNegativeBalance ? '0 days (shortfall)' : (daysOnHand !== null ? `${daysOnHand} days` : 'N/A'), '(Period Net ÷ Avg Monthly OpEx) × 30'));
        body.appendChild(summaryGrid);

        // Formula explanation
        const formulaBox = el('div', { style: 'padding:10px 12px;border-radius:6px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);font-size:12px;color:var(--text-muted);line-height:1.6' });
        formulaBox.appendChild(el('strong', { style: 'color:var(--text)' }, 'Note: '));
        formulaBox.appendChild(document.createTextNode('Measures how many days of operating expenses are covered by this period\'s net cash flow. Not a cash balance or runway metric.'));
        body.appendChild(formulaBox);

        // Monthly cash position table
        if (monthlyPositions.length > 0) {
          const posSection = el('div');
          posSection.appendChild(mkSectionLabel('Monthly Cash Position'));
          let cum = 0;
          const tableRows = sortedMks.map(mk => {
            const net = netByMk.get(mk);
            cum += net;
            const opMk = opExpenses.filter(e => e.date?.slice(0, 7) === mk).reduce((s, e) => s + toEUR(e.amount, e.currency, e.date), 0);
            return [mk, formatEUR(net >= 0 ? net : 0), formatEUR(net < 0 ? Math.abs(net) : 0), formatEUR(opMk), formatEUR(cum)];
          });
          posSection.appendChild(mkModalTable(
            ['Month', 'Net In', 'Net Out', 'OpEx Out', 'Running Balance'],
            tableRows
          ));
          body.appendChild(posSection);
        }

        openModal({ title: 'Net Coverage Days — Breakdown', body, large: true });
      }
    }));
  }

  // Invoice Collection Lag: (Outstanding service invoices ÷ Total service invoiced) × 30 (DSO proxy)
  {
    const { mStream: mStreamCCC, mOwner: mOwnerCCC, mClient: mClientCCC } = makeMatchers(gF);
    const inRange = d => !!d && d >= start && d <= end;
    const allInvoices = listActive('invoices').filter(i => inRange(i.issueDate || i.date) && mStreamCCC(i) && mOwnerCCC(i) && mClientCCC(i));
    const svcInvoiced = allInvoices.reduce((s, i) => s + toEUR(i.total, i.currency, i.issueDate), 0);
    const outstandingSvc = allInvoices.filter(i => !['paid', 'cancelled', 'void', 'draft'].includes(i.status))
      .reduce((s, i) => s + toEUR(i.total, i.currency, i.issueDate), 0);
    const ccc = svcInvoiced > 0 ? Math.round(outstandingSvc / svcInvoiced * 30) : null;

    const cccVariant = ccc === null ? '' : ccc <= 15 ? 'success' : ccc <= 30 ? 'warning' : 'danger';
    kpiRow3.appendChild(mkKpiCard({
      label:    'Invoice Collection Lag',
      value:    ccc !== null ? `${ccc} days` : 'N/A',
      subtitle: 'Outstanding ÷ Invoiced × 30 (proxy)',
      variant:  cccVariant,
      onClick:  () => {
        const body = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });

        // Summary boxes
        const summaryGrid = el('div', { style: 'display:grid;grid-template-columns:repeat(3,1fr);gap:10px' });
        const paidSvc = allInvoices.filter(i => i.status === 'paid').reduce((s, i) => s + toEUR(i.total, i.currency, i.issueDate), 0);
        summaryGrid.appendChild(mkSummaryBox('Total Service Invoiced', formatEUR(svcInvoiced), `${allInvoices.length} invoice${allInvoices.length !== 1 ? 's' : ''}`));
        summaryGrid.appendChild(mkSummaryBox('Outstanding Service', formatEUR(outstandingSvc), `${allInvoices.filter(i => !['paid','cancelled','void'].includes(i.status)).length} unpaid`));
        summaryGrid.appendChild(mkSummaryBox('Collection Lag (proxy)', ccc !== null ? `${ccc} days` : 'N/A', '(Outstanding ÷ Invoiced) × 30'));
        body.appendChild(summaryGrid);

        // Formula explanation
        const formulaBox = el('div', { style: 'padding:10px 12px;border-radius:6px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);font-size:12px;color:var(--text-muted);line-height:1.6' });
        formulaBox.appendChild(el('strong', { style: 'color:var(--text)' }, 'Note: '));
        formulaBox.appendChild(document.createTextNode('Estimates the average days service invoices remain unpaid. A simplified DSO proxy — true CCC requires expense payable timing.'));
        body.appendChild(formulaBox);

        // Monthly breakdown
        const monthMap2 = new Map();
        allInvoices.forEach(i => {
          const mk = (i.issueDate || '').slice(0, 7);
          if (!mk) return;
          const c = monthMap2.get(mk) || { invoiced: 0, outstanding: 0, paid: 0 };
          const v = toEUR(i.total, i.currency, i.issueDate);
          c.invoiced += v;
          if (['paid','cancelled','void'].includes(i.status)) c.paid += v;
          else c.outstanding += v;
          monthMap2.set(mk, c);
        });
        const monthEntries2 = [...monthMap2.entries()].sort(([a], [b]) => a.localeCompare(b));
        if (monthEntries2.length > 0) {
          const monthSection = el('div');
          monthSection.appendChild(mkSectionLabel('Monthly Breakdown'));
          monthSection.appendChild(mkModalTable(
            ['Month', 'Total Invoiced', 'Paid', 'Outstanding', 'Lag (days)'],
            monthEntries2.map(([mk, d]) => [
              mk,
              formatEUR(d.invoiced),
              formatEUR(d.paid),
              formatEUR(d.outstanding),
              d.invoiced > 0 ? Math.round(d.outstanding / d.invoiced * 30) + ' days' : '—'
            ])
          ));
          body.appendChild(monthSection);
        }

        openModal({ title: 'Invoice Collection Lag — Breakdown', body, large: true });
      }
    }));
  }

  wrap.appendChild(kpiRow3);

  // ── KPI row 4: Cash Runway Projection + Working Capital ───────────────────
  const kpiRow4 = el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px' });

  // Cash Runway
  {
    const avgMonthlyOpEx = curData.activeMonthCount > 0 ? opExCashOut / curData.activeMonthCount : 0;
    const runwayMonths   = avgMonthlyOpEx > 0 ? net / avgMonthlyOpEx : null;
    const runwayVariant  = runwayMonths === null ? '' : runwayMonths < 0 ? 'danger' : runwayMonths < 3 ? 'danger' : runwayMonths < 6 ? 'warning' : 'success';
    const runwayValue    = runwayMonths === null ? 'N/A' : runwayMonths < 0 ? 'Negative' : `${runwayMonths.toFixed(1)} mo`;

    kpiRow4.appendChild(mkKpiCard({
      label:    'Cash Runway',
      value:    runwayValue,
      subtitle: 'Period net ÷ avg monthly OpEx',
      variant:  runwayVariant,
      onClick:  () => {
        const body = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });

        const summaryGrid = el('div', { style: 'display:grid;grid-template-columns:repeat(3,1fr);gap:10px' });
        summaryGrid.appendChild(mkSummaryBox('Avg Monthly OpEx', formatEUR(avgMonthlyOpEx), `${curData.activeMonthCount} active month${curData.activeMonthCount !== 1 ? 's' : ''}`));
        summaryGrid.appendChild(mkSummaryBox('Avg Monthly Net', formatEUR(avgMonthlyNet), net >= 0 ? 'surplus' : 'deficit'));
        summaryGrid.appendChild(mkSummaryBox('Runway', runwayValue, runwayMonths !== null && runwayMonths >= 0 ? 'months of OpEx covered' : 'negative period net'));
        body.appendChild(summaryGrid);

        const runwayMonthMap = new Map();
        const addRunwayM = (mk, inV, opV, capV) => {
          if (!mk) return;
          const c = runwayMonthMap.get(mk) || { in: 0, opOut: 0, capOut: 0 };
          c.in += inV; c.opOut += opV; c.capOut += capV;
          runwayMonthMap.set(mk, c);
        };
        payments   .forEach(p => addRunwayM(p.date?.slice(0, 7), toEUR(p.amount, p.currency, p.date), 0, 0));
        invoices   .forEach(i => addRunwayM((i.issueDate || '').slice(0, 7), toEUR(i.total, i.currency, i.issueDate), 0, 0));
        opExpenses .forEach(e => addRunwayM(e.date?.slice(0, 7), 0, toEUR(e.amount, e.currency, e.date), 0));
        capExpenses.forEach(e => addRunwayM(e.date?.slice(0, 7), 0, 0, toEUR(e.amount, e.currency, e.date)));
        const runwaySortedMks = [...runwayMonthMap.keys()].sort();
        let cumBurn = 0, cumBalance = 0;
        const runwayTrendRows = runwaySortedMks.map(mk => {
          const d = runwayMonthMap.get(mk);
          cumBurn += d.opOut;
          cumBalance += d.in - d.opOut - d.capOut;
          const runwayAtPoint = avgMonthlyOpEx > 0 ? cumBalance / avgMonthlyOpEx : null;
          return [
            mk,
            formatEUR(d.opOut),
            formatEUR(cumBurn),
            runwayAtPoint === null ? 'N/A' : runwayAtPoint < 0 ? 'Negative' : `${runwayAtPoint.toFixed(1)} mo`
          ];
        });

        body.appendChild(mkSectionLabel('Monthly Runway Trend'));
        body.appendChild(mkModalTable(
          ['Month', 'Op. Expenses', 'Cumulative Burn', 'Remaining Runway'],
          runwayTrendRows
        ));

        const noteBox = el('div', { style: 'padding:10px 12px;border-radius:6px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);font-size:12px;color:var(--text-muted);line-height:1.6' });
        noteBox.appendChild(el('strong', { style: 'color:var(--text)' }, 'Note: '));
        noteBox.appendChild(document.createTextNode('This is a period-level indicator, not a balance-sheet cash position. It shows how many months of operating expenses are covered by this period\'s net cash flow.'));
        body.appendChild(noteBox);

        openModal({ title: 'Cash Runway Projection', body, large: true });
      }
    }));
  }

  // Working Capital
  {
    const inRangeWC = d => !!d && d >= start && d <= end;
    const { mStream: mStreamWC, mOwner: mOwnerWC, mClient: mClientWC } = makeMatchers(gF);
    const outstandingInvoices = listActive('invoices').filter(i =>
      ['sent', 'overdue'].includes(i.status) && inRangeWC(i.issueDate || i.date) &&
      mStreamWC(i) && mOwnerWC(i) && mClientWC(i)
    );
    const receivables    = outstandingInvoices.reduce((s, i) => s + toEUR(i.total, i.currency, i.issueDate), 0);
    const payables       = 0; // AP tracking not enabled
    const workingCapital = receivables - payables;

    kpiRow4.appendChild(mkKpiCard({
      label:    'Working Capital',
      value:    formatEUR(workingCapital),
      subtitle: 'Receivables − Payables',
      variant:  workingCapital > 0 ? 'success' : workingCapital < 0 ? 'danger' : '',
      onClick:  () => {
        const body = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });

        const summaryGrid = el('div', { style: 'display:grid;grid-template-columns:repeat(3,1fr);gap:10px' });
        summaryGrid.appendChild(mkSummaryBox('Receivables', formatEUR(receivables), `${outstandingInvoices.length} outstanding invoice${outstandingInvoices.length !== 1 ? 's' : ''}`));
        summaryGrid.appendChild(mkSummaryBox('Payables', formatEUR(payables), 'not tracked'));
        summaryGrid.appendChild(mkSummaryBox('Working Capital', formatEUR(workingCapital), workingCapital >= 0 ? 'net positive' : 'net negative'));
        body.appendChild(summaryGrid);

        if (outstandingInvoices.length > 0) {
          const sorted = [...outstandingInvoices].sort((a, b) => toEUR(b.total, b.currency, b.issueDate) - toEUR(a.total, a.currency, a.issueDate));
          body.appendChild(mkSectionLabel('Outstanding Invoices'));
          body.appendChild(mkModalTable(
            ['Client', 'Issue Date', 'Due Date', 'Status', 'Amount'],
            sorted.map(i => [
              byId('clients', i.clientId)?.name || i.clientId || '—',
              fmtDate(i.issueDate || i.date),
              fmtDate(i.dueDate) || '—',
              i.status || '—',
              formatEUR(toEUR(i.total, i.currency, i.issueDate))
            ])
          ));
        } else {
          body.appendChild(mkEmptyState('No outstanding invoices in the selected period.'));
        }

        const noteBox = el('div', { style: 'padding:10px 12px;border-radius:6px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);font-size:12px;color:var(--text-muted);line-height:1.6' });
        noteBox.appendChild(el('strong', { style: 'color:var(--text)' }, 'Note: '));
        noteBox.appendChild(document.createTextNode('Payables tracking not currently enabled — expenses are recorded when paid. Only receivables (outstanding invoices) are tracked.'));
        body.appendChild(noteBox);

        openModal({ title: 'Working Capital — Breakdown', body, large: true });
      }
    }));
  }

  wrap.appendChild(kpiRow4);

  // ── Cash Flow Insights ─────────────────────────────────────────────────────
  wrap.appendChild(mkInsightsBanner(computeCashFlowInsights(curData, cmpData, cmpRange), 'Cash Flow Insights'));

  // ── Cash Movement Trends ───────────────────────────────────────────────────
  wrap.appendChild(el('div', { style: 'margin:8px 0 12px' },
    el('h3', { style: 'margin:0;font-size:14px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px' }, 'Cash Movement Trends')
  ));

  wrap.appendChild(el('div', { class: 'card mb-16' },
    el('div', { class: 'card-header' },
      el('div', { class: 'card-title' }, 'Cumulative Net Cash Flow'),
      el('div', { style: 'font-size:12px;color:var(--text-muted)' }, 'Click a point for that month\'s transactions')
    ),
    el('div', { class: 'chart-wrap tall' }, el('canvas', { id: 'cf-cumulative-line' }))
  ));

  const row2 = el('div', { style: 'display:grid;grid-template-columns:2fr 1fr;gap:16px;margin-bottom:16px' });
  row2.appendChild(el('div', { class: 'card' },
    el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'Monthly Cash In vs Cash Out')),
    el('div', { class: 'chart-wrap tall' }, el('canvas', { id: 'cf-month-bar' }))
  ));
  row2.appendChild(el('div', { class: 'card' },
    el('div', { class: 'card-header' },
      el('div', { class: 'card-title' }, 'Net Cash Flow Split'),
      el('div', { style: 'font-size:12px;color:var(--text-muted)' }, 'Cash In vs OpEx vs CapEx · Click for detail')
    ),
    el('div', { class: 'chart-wrap tall' }, el('canvas', { id: 'cf-net-donut' }))
  ));
  wrap.appendChild(row2);

  wrap.appendChild(el('div', { class: 'card mb-16' },
    el('div', { class: 'card-header' },
      el('div', { class: 'card-title' }, 'Monthly Net Cash Flow'),
      el('div', { style: 'font-size:12px;color:var(--text-muted)' }, 'Green = surplus · Red = deficit · Click for transactions')
    ),
    el('div', { class: 'chart-wrap tall' }, el('canvas', { id: 'cf-net-month-bar' }))
  ));

  // ── Cash Flow by Stream and Property ──────────────────────────────────────
  wrap.appendChild(el('div', { style: 'margin:8px 0 12px' },
    el('h3', { style: 'margin:0;font-size:14px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px' }, 'Cash Flow by Stream and Property')
  ));

  const row4 = el('div', { class: 'grid grid-2 mb-16' });
  row4.appendChild(el('div', { class: 'card' },
    el('div', { class: 'card-header' },
      el('div', { class: 'card-title' }, 'Cash Flow by Property'),
      el('div', { style: 'font-size:12px;color:var(--text-muted)' }, 'Click for breakdown')
    ),
    el('div', { class: 'chart-wrap tall' }, el('canvas', { id: 'cf-prop-hbar' }))
  ));
  row4.appendChild(el('div', { class: 'card' },
    el('div', { class: 'card-header' },
      el('div', { class: 'card-title' }, 'Cash Flow by Stream'),
      el('div', { style: 'font-size:12px;color:var(--text-muted)' }, 'Click for breakdown')
    ),
    el('div', { class: 'chart-wrap tall' }, el('canvas', { id: 'cf-stream-bar' }))
  ));
  wrap.appendChild(row4);

  // ── Cash Seasonality Heatmap ───────────────────────────────────────────────
  const heatmap = buildCashSeasonalityHeatmap();
  if (heatmap) wrap.appendChild(heatmap);

  // ── Transactions ───────────────────────────────────────────────────────────
  const tableCard = el('div', { class: 'card' });
  const cfTableHeader = el('div', { class: 'card-header', style: 'cursor:pointer;user-select:none;display:flex;align-items:center;justify-content:space-between' });
  const cfHeaderLeft = el('div', { style: 'display:flex;align-items:center;gap:16px' });
  cfHeaderLeft.appendChild(el('div', { class: 'card-title' }, 'Transactions'));
  cfHeaderLeft.appendChild(el('div', { style: 'display:flex;gap:12px;font-size:11px;color:var(--text-muted);align-items:center' },
    el('span', { style: 'display:flex;align-items:center;gap:4px' },
      el('span', { style: 'width:10px;height:10px;border-left:3px solid #10b981;display:inline-block' }), 'Cash In'
    ),
    el('span', { style: 'display:flex;align-items:center;gap:4px' },
      el('span', { style: 'width:10px;height:10px;border-left:3px solid #ef4444;display:inline-block' }), 'Op. Out'
    ),
    el('span', { style: 'display:flex;align-items:center;gap:4px' },
      el('span', { style: 'width:10px;height:10px;border-left:3px solid #b91c1c;display:inline-block' }), 'Invest. Out'
    )
  ));
  cfTableHeader.appendChild(cfHeaderLeft);
  const cfChevron = el('span', { style: 'font-size:11px;color:var(--text-muted);display:inline-block;transition:transform 200ms' }, '▼');
  cfTableHeader.appendChild(cfChevron);
  tableCard.appendChild(cfTableHeader);
  const cfTableBody = el('div');
  buildCashFlowTable(cfTableBody, curData);
  tableCard.appendChild(cfTableBody);
  let cfCollapsed = false;
  cfTableHeader.onclick = () => {
    cfCollapsed = !cfCollapsed;
    cfTableBody.style.display = cfCollapsed ? 'none' : '';
    cfChevron.style.transform = cfCollapsed ? 'rotate(-90deg)' : '';
  };
  wrap.appendChild(tableCard);

  const { keys: monthKeys } = getMonthKeysForRange(start, end);
  setTimeout(() => {
    renderCumulativeLine(curData, monthKeys);
    renderMonthBar(curData, monthKeys);
    renderNetStreamDonut(curData);
    renderNetMonthBar(curData, monthKeys);
    renderPropHBar(curData);
    renderStreamBar(curData);
  }, 0);

  return wrap;
}

// ── Chart 1: Line — Cumulative Net Cash Flow ──────────────────────────────────
function renderCumulativeLine({ payments, invoices, opExpenses, capExpenses }, monthKeys) {
  if (!monthKeys.length) return;

  const netByMonth = new Map();
  monthKeys.forEach(m => netByMonth.set(m.key, 0));

  payments   .forEach(p => { const mk = p.date?.slice(0, 7);              if (netByMonth.has(mk)) netByMonth.set(mk, netByMonth.get(mk) + toEUR(p.amount, p.currency, p.date)); });
  invoices   .forEach(i => { const mk = (i.issueDate || '').slice(0, 7); if (netByMonth.has(mk)) netByMonth.set(mk, netByMonth.get(mk) + toEUR(i.total, i.currency, i.issueDate)); });
  opExpenses .forEach(e => { const mk = e.date?.slice(0, 7);              if (netByMonth.has(mk)) netByMonth.set(mk, netByMonth.get(mk) - toEUR(e.amount, e.currency, e.date)); });
  capExpenses.forEach(e => { const mk = e.date?.slice(0, 7);              if (netByMonth.has(mk)) netByMonth.set(mk, netByMonth.get(mk) - toEUR(e.amount, e.currency, e.date)); });

  let cumulative = 0;
  const cumData = monthKeys.map(m => { cumulative += netByMonth.get(m.key) || 0; return Math.round(cumulative); });

  if (cumData.every(v => v === 0)) return;

  charts.line('cf-cumulative-line', {
    labels: monthKeys.map(m => m.label),
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
      const mk = monthKeys[idx]?.key;
      if (!mk) return;
      const mPay = payments   .filter(p => p.date?.slice(0, 7) === mk);
      const mInv = invoices   .filter(i => (i.issueDate || '').slice(0, 7) === mk);
      const mOp  = opExpenses .filter(e => e.date?.slice(0, 7) === mk);
      const mCap = capExpenses.filter(e => e.date?.slice(0, 7) === mk);
      const mIn  = mPay.reduce((s, p) => s + toEUR(p.amount, p.currency, p.date), 0)
                 + mInv.reduce((s, i) => s + toEUR(i.total, i.currency, i.issueDate), 0);
      const mOpOut  = mOp.reduce((s, e) => s + toEUR(e.amount, e.currency, e.date), 0);
      const mCapOut = mCap.reduce((s, e) => s + toEUR(e.amount, e.currency, e.date), 0);
      const mNet = mIn - mOpOut - mCapOut;
      const cumBalance = cumData[idx];

      const body = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });
      const summaryGrid = el('div', { style: 'display:grid;grid-template-columns:repeat(5,1fr);gap:10px' });
      summaryGrid.appendChild(mkSummaryBox('Cash In', formatEUR(mIn), `${mPay.length + mInv.length} items`));
      summaryGrid.appendChild(mkSummaryBox('Op. Cash Out', formatEUR(mOpOut), `${mOp.length} expenses`));
      summaryGrid.appendChild(mkSummaryBox('Invest. Cash Out', formatEUR(mCapOut), `${mCap.length} items`));
      summaryGrid.appendChild(mkSummaryBox('Net', formatEUR(mNet), mNet >= 0 ? 'Surplus' : 'Deficit'));
      summaryGrid.appendChild(mkSummaryBox('Cumulative Balance', formatEUR(cumBalance), `through ${label}`));
      body.appendChild(summaryGrid);

      // Stream breakdown for this month
      const streamMap = new Map();
      mPay.forEach(p => { const k = STREAMS[p.stream]?.label || p.stream || 'Other'; const c = streamMap.get(k) || { in: 0, opOut: 0, capOut: 0 }; c.in += toEUR(p.amount, p.currency, p.date); streamMap.set(k, c); });
      mInv.forEach(i => { const k = STREAMS[i.stream]?.label || i.stream || 'Other'; const c = streamMap.get(k) || { in: 0, opOut: 0, capOut: 0 }; c.in += toEUR(i.total, i.currency, i.issueDate); streamMap.set(k, c); });
      mOp .forEach(e => { const k = STREAMS[expStream(e)]?.label || expStream(e) || 'Other'; const c = streamMap.get(k) || { in: 0, opOut: 0, capOut: 0 }; c.opOut += toEUR(e.amount, e.currency, e.date); streamMap.set(k, c); });
      mCap.forEach(e => { const k = STREAMS[expStream(e)]?.label || expStream(e) || 'Other'; const c = streamMap.get(k) || { in: 0, opOut: 0, capOut: 0 }; c.capOut += toEUR(e.amount, e.currency, e.date); streamMap.set(k, c); });
      const streamEntries = [...streamMap.entries()].sort((a, b) => (b[1].in - b[1].opOut - b[1].capOut) - (a[1].in - a[1].opOut - a[1].capOut));
      const streamSection = el('div');
      streamSection.appendChild(mkSectionLabel('Breakdown by Stream'));
      streamSection.appendChild(mkModalTable(
        ['Stream', 'Cash In', 'Op. Out', 'Invest. Out', 'Net'],
        streamEntries.map(([k, d]) => [k, formatEUR(d.in), formatEUR(d.opOut), formatEUR(d.capOut), formatEUR(d.in - d.opOut - d.capOut)])
      ));
      body.appendChild(streamSection);

      openModal({ title: `Cumulative CF — ${label}`, body, large: true });
    }
  });
}

// ── Chart 2: Grouped bar — Month × (Cash In, Op Cash Out, Invest Cash Out) ────
function renderMonthBar({ payments, invoices, opExpenses, capExpenses }, monthKeys) {
  if (!monthKeys.length) return;

  const inMap  = new Map();
  const opMap  = new Map();
  const capMap = new Map();
  monthKeys.forEach(m => { inMap.set(m.key, 0); opMap.set(m.key, 0); capMap.set(m.key, 0); });

  payments   .forEach(p => { const mk = p.date?.slice(0, 7);              if (inMap .has(mk)) inMap .set(mk, inMap .get(mk) + toEUR(p.amount, p.currency, p.date)); });
  invoices   .forEach(i => { const mk = (i.issueDate || '').slice(0, 7); if (inMap .has(mk)) inMap .set(mk, inMap .get(mk) + toEUR(i.total, i.currency, i.issueDate)); });
  opExpenses .forEach(e => { const mk = e.date?.slice(0, 7);              if (opMap .has(mk)) opMap .set(mk, opMap .get(mk) + toEUR(e.amount, e.currency, e.date)); });
  capExpenses.forEach(e => { const mk = e.date?.slice(0, 7);              if (capMap.has(mk)) capMap.set(mk, capMap.get(mk) + toEUR(e.amount, e.currency, e.date)); });

  const hasData = monthKeys.some(m => inMap.get(m.key) > 0 || opMap.get(m.key) > 0 || capMap.get(m.key) > 0);
  if (!hasData) return;

  charts.bar('cf-month-bar', {
    labels: monthKeys.map(m => m.label),
    datasets: [
      { label: 'Cash In',             data: monthKeys.map(m => Math.round(inMap .get(m.key) || 0)), backgroundColor: 'rgba(16,185,129,0.8)' },
      { label: 'Operating Cash Out',  data: monthKeys.map(m => Math.round(opMap .get(m.key) || 0)), backgroundColor: 'rgba(239,68,68,0.8)'  },
      { label: 'Investment Cash Out', data: monthKeys.map(m => Math.round(capMap.get(m.key) || 0)), backgroundColor: 'rgba(185,28,28,0.8)'  }
    ],
    stacked: false,
    onClickItem: (label, idx, dsIdx) => {
      const mk = monthKeys[idx]?.key;
      if (!mk) return;
      const mPay = payments   .filter(p => p.date?.slice(0, 7) === mk);
      const mInv = invoices   .filter(i => (i.issueDate || '').slice(0, 7) === mk);
      const mOp  = opExpenses .filter(e => e.date?.slice(0, 7) === mk);
      const mCap = capExpenses.filter(e => e.date?.slice(0, 7) === mk);
      const dsLabel = dsIdx === 0 ? 'Cash In' : dsIdx === 1 ? 'Operating Cash Out' : 'Investment Cash Out';
      const items = dsIdx === 0 ? [...mPay, ...mInv] : dsIdx === 1 ? mOp : mCap;
      const totalAmt = items.reduce((s, x) => s + toEUR(x.amount ?? x.total, x.currency, x.date ?? x.issueDate), 0);

      const body = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });
      const summaryGrid = el('div', { style: 'display:grid;grid-template-columns:repeat(2,1fr);gap:10px' });
      summaryGrid.appendChild(mkSummaryBox(dsLabel, formatEUR(totalAmt), `${items.length} items`));
      summaryGrid.appendChild(mkSummaryBox('Month', label, mk));
      body.appendChild(summaryGrid);

      if (dsIdx === 0) {
        // Cash In: breakdown by source type then by stream
        const payTotal = mPay.reduce((s, p) => s + toEUR(p.amount, p.currency, p.date), 0);
        const invTotal = mInv.reduce((s, i) => s + toEUR(i.total, i.currency, i.issueDate), 0);
        const srcSection = el('div');
        srcSection.appendChild(mkSectionLabel('By Source Type'));
        srcSection.appendChild(mkModalTable(
          ['Source', 'Amount', 'Count'],
          [['Payments', formatEUR(payTotal), mPay.length], ['Invoices', formatEUR(invTotal), mInv.length]]
        ));
        body.appendChild(srcSection);
      } else {
        // OpEx or CapEx: breakdown by category
        const catMap = new Map();
        items.forEach(e => { const cat = e.category || 'Uncategorized'; catMap.set(cat, (catMap.get(cat) || 0) + toEUR(e.amount, e.currency, e.date)); });
        const catEntries = [...catMap.entries()].sort((a, b) => b[1] - a[1]);
        const catSection = el('div');
        catSection.appendChild(mkSectionLabel('By Category'));
        catSection.appendChild(mkModalTable(
          ['Category', 'Amount', '% of Total'],
          catEntries.map(([k, v]) => [k, formatEUR(v), totalAmt > 0 ? (v / totalAmt * 100).toFixed(1) + '%' : '—'])
        ));
        body.appendChild(catSection);
      }

      openModal({ title: `${label} — ${dsLabel}`, body, large: true });
    }
  });
}

// ── Chart 3: Donut — Net Cash Flow by Category (Cash In / OpEx / CapEx) ─────────
function renderNetStreamDonut({ payments, invoices, opExpenses, capExpenses }) {
  const totalCashIn      = payments.reduce((s, p) => s + toEUR(p.amount, p.currency, p.date), 0)
                         + invoices.reduce((s, i) => s + toEUR(i.total, i.currency, i.issueDate), 0);
  const totalOpCashOut   = opExpenses.reduce((s, e) => s + toEUR(e.amount, e.currency, e.date), 0);
  const totalInvCashOut  = capExpenses.reduce((s, e) => s + toEUR(e.amount, e.currency, e.date), 0);

  if (totalCashIn === 0 && totalOpCashOut === 0 && totalInvCashOut === 0) return;

  // Build three slices: Cash In, Op Cash Out, Invest Cash Out
  const sliceLabels = ['Cash In', 'Op Cash Out', 'Invest Cash Out'];
  const sliceData   = [Math.round(totalCashIn), Math.round(totalOpCashOut), Math.round(totalInvCashOut)];
  const sliceColors = ['rgba(16,185,129,0.85)', 'rgba(239,68,68,0.85)', 'rgba(185,28,28,0.85)'];

  // Remove zero slices
  const filtered = sliceLabels
    .map((lbl, i) => ({ lbl, val: sliceData[i], color: sliceColors[i], idx: i }))
    .filter(s => s.val > 0);

  if (!filtered.length) return;

  charts.doughnut('cf-net-donut', {
    labels: filtered.map(s => s.lbl),
    data:   filtered.map(s => s.val),
    colors: filtered.map(s => s.color),
    onClickItem: (_label, clickIdx) => {
      const slice = filtered[clickIdx];
      if (!slice) return;

      const body = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });

      if (slice.idx === 0) {
        // Cash In: payments + invoices top 10 by amount
        const allIn = [
          ...payments.map(p => ({
            date: p.date,
            entity: byId('properties', p.propertyId)?.name || p.source || '—',
            description: 'Payment',
            _eur: toEUR(p.amount, p.currency, p.date)
          })),
          ...invoices.map(i => ({
            date: i.issueDate || i.date,
            entity: byId('clients', i.clientId)?.name || '—',
            description: 'Invoice',
            _eur: toEUR(i.total, i.currency, i.issueDate)
          }))
        ].sort((a, b) => b._eur - a._eur).slice(0, 10);

        const summaryGrid = el('div', { style: 'display:grid;grid-template-columns:repeat(2,1fr);gap:10px' });
        summaryGrid.appendChild(mkSummaryBox('Total Cash In', formatEUR(totalCashIn), `${payments.length + invoices.length} items`));
        summaryGrid.appendChild(mkSummaryBox('Top 10 shown', `${Math.min(10, payments.length + invoices.length)} of ${payments.length + invoices.length}`, 'by amount'));
        body.appendChild(summaryGrid);

        body.appendChild(mkSectionLabel('Top Cash In Records'));
        body.appendChild(mkModalTable(
          ['Date', 'Entity / Description', 'Type', 'Amount'],
          allIn.map(r => [fmtDate(r.date), r.entity, r.description, formatEUR(r._eur)])
        ));

      } else if (slice.idx === 1) {
        // Op Cash Out: opExpenses top 10
        const sorted = [...opExpenses]
          .sort((a, b) => toEUR(b.amount, b.currency, b.date) - toEUR(a.amount, a.currency, a.date))
          .slice(0, 10);

        const summaryGrid = el('div', { style: 'display:grid;grid-template-columns:repeat(2,1fr);gap:10px' });
        summaryGrid.appendChild(mkSummaryBox('Total OpEx Out', formatEUR(totalOpCashOut), `${opExpenses.length} expenses`));
        summaryGrid.appendChild(mkSummaryBox('Top 10 shown', `${Math.min(10, opExpenses.length)} of ${opExpenses.length}`, 'by amount'));
        body.appendChild(summaryGrid);

        body.appendChild(mkSectionLabel('Top Operating Expenses'));
        body.appendChild(mkModalTable(
          ['Date', 'Entity / Property', 'Description', 'Amount'],
          sorted.map(e => [
            fmtDate(e.date),
            e.propertyId ? (byId('properties', e.propertyId)?.name || e.propertyId) : (e.vendorId ? (byId('vendors', e.vendorId)?.name || e.vendorId) : '—'),
            e.description || e.category || '—',
            formatEUR(toEUR(e.amount, e.currency, e.date))
          ])
        ));

      } else {
        // Investment Cash Out: capExpenses top 10
        const sorted = [...capExpenses]
          .sort((a, b) => toEUR(b.amount, b.currency, b.date) - toEUR(a.amount, a.currency, a.date))
          .slice(0, 10);

        const summaryGrid = el('div', { style: 'display:grid;grid-template-columns:repeat(2,1fr);gap:10px' });
        summaryGrid.appendChild(mkSummaryBox('Total Invest. Out', formatEUR(totalInvCashOut), `${capExpenses.length} items`));
        summaryGrid.appendChild(mkSummaryBox('Top 10 shown', `${Math.min(10, capExpenses.length)} of ${capExpenses.length}`, 'by amount'));
        body.appendChild(summaryGrid);

        body.appendChild(mkSectionLabel('Top Investment Expenses'));
        body.appendChild(mkModalTable(
          ['Date', 'Entity / Property', 'Description', 'Amount'],
          sorted.map(e => [
            fmtDate(e.date),
            e.propertyId ? (byId('properties', e.propertyId)?.name || e.propertyId) : (e.vendorId ? (byId('vendors', e.vendorId)?.name || e.vendorId) : '—'),
            e.description || e.category || '—',
            formatEUR(toEUR(e.amount, e.currency, e.date))
          ])
        ));
      }

      openModal({ title: `${slice.lbl} — Breakdown`, body, large: true });
    }
  });
}

// ── Chart 4: Bar — Monthly Net Cash Flow ─────────────────────────────────────
function renderNetMonthBar({ payments, invoices, opExpenses, capExpenses }, monthKeys) {
  if (!monthKeys.length) return;

  const netByMonth = new Map();
  monthKeys.forEach(m => netByMonth.set(m.key, 0));

  payments   .forEach(p => { const mk = p.date?.slice(0, 7);              if (netByMonth.has(mk)) netByMonth.set(mk, netByMonth.get(mk) + toEUR(p.amount,  p.currency,  p.date)); });
  invoices   .forEach(i => { const mk = (i.issueDate || '').slice(0, 7); if (netByMonth.has(mk)) netByMonth.set(mk, netByMonth.get(mk) + toEUR(i.total,   i.currency,  i.issueDate)); });
  opExpenses .forEach(e => { const mk = e.date?.slice(0, 7);              if (netByMonth.has(mk)) netByMonth.set(mk, netByMonth.get(mk) - toEUR(e.amount,  e.currency,  e.date)); });
  capExpenses.forEach(e => { const mk = e.date?.slice(0, 7);              if (netByMonth.has(mk)) netByMonth.set(mk, netByMonth.get(mk) - toEUR(e.amount,  e.currency,  e.date)); });

  const netData = monthKeys.map(m => Math.round(netByMonth.get(m.key) || 0));
  if (netData.every(v => v === 0)) return;

  charts.bar('cf-net-month-bar', {
    labels: monthKeys.map(m => m.label),
    datasets: [{
      label:           'Net Cash Flow (EUR)',
      data:            netData,
      backgroundColor: netData.map(v => v >= 0 ? 'rgba(16,185,129,0.8)' : 'rgba(239,68,68,0.8)')
    }],
    stacked: false,
    onClickItem: (_label, idx) => {
      const mk = monthKeys[idx]?.key;
      if (!mk) return;
      const mLabel = monthKeys[idx].label;
      const mPay = payments   .filter(p => p.date?.slice(0, 7) === mk);
      const mInv = invoices   .filter(i => (i.issueDate || '').slice(0, 7) === mk);
      const mOp  = opExpenses .filter(e => e.date?.slice(0, 7) === mk);
      const mCap = capExpenses.filter(e => e.date?.slice(0, 7) === mk);
      const mIn     = mPay.reduce((s, p) => s + toEUR(p.amount, p.currency, p.date), 0)
                    + mInv.reduce((s, i) => s + toEUR(i.total, i.currency, i.issueDate), 0);
      const mOpOut  = mOp.reduce((s, e) => s + toEUR(e.amount, e.currency, e.date), 0);
      const mCapOut = mCap.reduce((s, e) => s + toEUR(e.amount, e.currency, e.date), 0);
      const mNet = mIn - mOpOut - mCapOut;

      const body = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });
      const summaryGrid = el('div', { style: 'display:grid;grid-template-columns:repeat(4,1fr);gap:10px' });
      summaryGrid.appendChild(mkSummaryBox('Cash In', formatEUR(mIn), `${mPay.length + mInv.length} items`));
      summaryGrid.appendChild(mkSummaryBox('Op. Cash Out', formatEUR(mOpOut), `${mOp.length} expenses`));
      summaryGrid.appendChild(mkSummaryBox('Invest. Out', formatEUR(mCapOut), `${mCap.length} items`));
      summaryGrid.appendChild(mkSummaryBox('Net CF', formatEUR(mNet), mNet >= 0 ? 'Surplus' : 'Deficit'));
      body.appendChild(summaryGrid);

      // Property breakdown for this month
      const propMap = new Map();
      const addP = (name, inV, opV, capV) => {
        const c = propMap.get(name) || { in: 0, opOut: 0, capOut: 0 };
        c.in += inV; c.opOut += opV; c.capOut += capV;
        propMap.set(name, c);
      };
      mPay.forEach(p => { const n = p.propertyId ? (byId('properties', p.propertyId)?.name || p.propertyId) : 'No Property'; addP(n, toEUR(p.amount, p.currency, p.date), 0, 0); });
      mOp .forEach(e => { const n = e.propertyId ? (byId('properties', e.propertyId)?.name || e.propertyId) : 'No Property'; addP(n, 0, toEUR(e.amount, e.currency, e.date), 0); });
      mCap.forEach(e => { const n = e.propertyId ? (byId('properties', e.propertyId)?.name || e.propertyId) : 'No Property'; addP(n, 0, 0, toEUR(e.amount, e.currency, e.date)); });
      const propEntries = [...propMap.entries()].sort((a, b) => (b[1].in - b[1].opOut - b[1].capOut) - (a[1].in - a[1].opOut - a[1].capOut));
      if (propEntries.length > 0) {
        const propSection = el('div');
        propSection.appendChild(mkSectionLabel('By Property'));
        propSection.appendChild(mkModalTable(
          ['Property', 'Cash In', 'Op. Out', 'Invest. Out', 'Net'],
          propEntries.map(([k, d]) => [k, formatEUR(d.in), formatEUR(d.opOut), formatEUR(d.capOut), formatEUR(d.in - d.opOut - d.capOut)])
        ));
        body.appendChild(propSection);
      }

      openModal({ title: `Net Cash Flow — ${mLabel}`, body, large: true });
    }
  });
}

// ── Chart 5: Horizontal grouped bar — Cash Flow by Property ──────────────────
function renderPropHBar({ payments, opExpenses, capExpenses }) {
  const propInMap  = new Map();
  const propOpMap  = new Map();
  const propCapMap = new Map();
  const propNames  = new Map();

  const regName = pid => { if (!propNames.has(pid)) propNames.set(pid, byId('properties', pid)?.name || pid); };

  payments   .forEach(p => { if (!p.propertyId) return; regName(p.propertyId); propInMap .set(p.propertyId, (propInMap .get(p.propertyId) || 0) + toEUR(p.amount, p.currency, p.date)); });
  opExpenses .forEach(e => { if (!e.propertyId) return; regName(e.propertyId); propOpMap .set(e.propertyId, (propOpMap .get(e.propertyId) || 0) + toEUR(e.amount, e.currency, e.date)); });
  capExpenses.forEach(e => { if (!e.propertyId) return; regName(e.propertyId); propCapMap.set(e.propertyId, (propCapMap.get(e.propertyId) || 0) + toEUR(e.amount, e.currency, e.date)); });

  const allPids = [...new Set([...propInMap.keys(), ...propOpMap.keys(), ...propCapMap.keys()])];
  if (!allPids.length) return;

  allPids.sort((a, b) =>
    ((propInMap.get(b) || 0) + (propOpMap.get(b) || 0) + (propCapMap.get(b) || 0)) -
    ((propInMap.get(a) || 0) + (propOpMap.get(a) || 0) + (propCapMap.get(a) || 0))
  );

  charts.bar('cf-prop-hbar', {
    labels: allPids.map(pid => propNames.get(pid) || pid),
    datasets: [
      { label: 'Cash In',             data: allPids.map(pid => Math.round(propInMap .get(pid) || 0)), backgroundColor: 'rgba(16,185,129,0.8)' },
      { label: 'Operating Cash Out',  data: allPids.map(pid => Math.round(propOpMap .get(pid) || 0)), backgroundColor: 'rgba(239,68,68,0.8)'  },
      { label: 'Investment Cash Out', data: allPids.map(pid => Math.round(propCapMap.get(pid) || 0)), backgroundColor: 'rgba(185,28,28,0.8)'  }
    ],
    horizontal: true,
    stacked: false,
    onClickItem: (_label, idx, dsIdx) => {
      const pid  = allPids[idx];
      const name = propNames.get(pid) || pid;
      const pPay = payments   .filter(p => p.propertyId === pid);
      const pOp  = opExpenses .filter(e => e.propertyId === pid);
      const pCap = capExpenses.filter(e => e.propertyId === pid);
      const dsLabel = dsIdx === 0 ? 'Cash In' : dsIdx === 1 ? 'Operating Cash Out' : 'Investment Cash Out';
      const pIn     = pPay.reduce((s, p) => s + toEUR(p.amount, p.currency, p.date), 0);
      const pOpOut  = pOp .reduce((s, e) => s + toEUR(e.amount, e.currency, e.date), 0);
      const pCapOut = pCap.reduce((s, e) => s + toEUR(e.amount, e.currency, e.date), 0);
      const pNet = pIn - pOpOut - pCapOut;

      const body = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });
      const summaryGrid = el('div', { style: 'display:grid;grid-template-columns:repeat(4,1fr);gap:10px' });
      summaryGrid.appendChild(mkSummaryBox('Cash In', formatEUR(pIn), `${pPay.length} payments`));
      summaryGrid.appendChild(mkSummaryBox('Op. Cash Out', formatEUR(pOpOut), `${pOp.length} expenses`));
      summaryGrid.appendChild(mkSummaryBox('Invest. Out', formatEUR(pCapOut), `${pCap.length} items`));
      summaryGrid.appendChild(mkSummaryBox('Net CF', formatEUR(pNet), pNet >= 0 ? 'Surplus' : 'Deficit'));
      body.appendChild(summaryGrid);

      // Focused dataset section based on what was clicked
      if (dsIdx === 0 && pPay.length > 0) {
        // Cash In: breakdown by stream
        const streamMap = new Map();
        pPay.forEach(p => { const k = STREAMS[p.stream]?.label || p.stream || 'Other'; streamMap.set(k, (streamMap.get(k) || 0) + toEUR(p.amount, p.currency, p.date)); });
        const streamEntries = [...streamMap.entries()].sort((a, b) => b[1] - a[1]);
        const streamSection = el('div');
        streamSection.appendChild(mkSectionLabel('Cash In by Stream'));
        streamSection.appendChild(mkModalTable(
          ['Stream', 'Amount', '% of In'],
          streamEntries.map(([k, v]) => [k, formatEUR(v), pIn > 0 ? (v / pIn * 100).toFixed(1) + '%' : '—'])
        ));
        body.appendChild(streamSection);
      } else if (dsIdx !== 0) {
        // OpEx or CapEx: category breakdown
        const items = dsIdx === 1 ? pOp : pCap;
        const total = dsIdx === 1 ? pOpOut : pCapOut;
        const catMap = new Map();
        items.forEach(e => { const cat = e.category || 'Uncategorized'; catMap.set(cat, (catMap.get(cat) || 0) + toEUR(e.amount, e.currency, e.date)); });
        const catEntries = [...catMap.entries()].sort((a, b) => b[1] - a[1]);
        const catSection = el('div');
        catSection.appendChild(mkSectionLabel(`${dsLabel} by Category`));
        catSection.appendChild(mkModalTable(
          ['Category', 'Amount', '% of Total'],
          catEntries.map(([k, v]) => [k, formatEUR(v), total > 0 ? (v / total * 100).toFixed(1) + '%' : '—'])
        ));
        body.appendChild(catSection);
      }

      openModal({ title: `${name} — ${dsLabel}`, body, large: true });
    }
  });
}

// ── Chart 6: Horizontal grouped bar — Cash Flow by Stream ────────────────────
function renderStreamBar({ payments, invoices, opExpenses, capExpenses }) {
  const streamInMap  = new Map();
  const streamOpMap  = new Map();
  const streamCapMap = new Map();

  payments   .forEach(p => { const k = p.stream || 'other'; streamInMap .set(k, (streamInMap .get(k) || 0) + toEUR(p.amount, p.currency, p.date)); });
  invoices   .forEach(i => { const k = i.stream || 'other'; streamInMap .set(k, (streamInMap .get(k) || 0) + toEUR(i.total, i.currency, i.issueDate)); });
  opExpenses .forEach(e => { const k = expStream(e);         streamOpMap .set(k, (streamOpMap .get(k) || 0) + toEUR(e.amount, e.currency, e.date)); });
  capExpenses.forEach(e => { const k = expStream(e);         streamCapMap.set(k, (streamCapMap.get(k) || 0) + toEUR(e.amount, e.currency, e.date)); });

  const allKeys = [...new Set([...streamInMap.keys(), ...streamOpMap.keys(), ...streamCapMap.keys()])];
  if (!allKeys.length) return;

  allKeys.sort((a, b) =>
    ((streamInMap.get(b) || 0) + (streamOpMap.get(b) || 0) + (streamCapMap.get(b) || 0)) -
    ((streamInMap.get(a) || 0) + (streamOpMap.get(a) || 0) + (streamCapMap.get(a) || 0))
  );

  charts.bar('cf-stream-bar', {
    labels: allKeys.map(k => STREAMS[k]?.label || k),
    datasets: [
      { label: 'Cash In',             data: allKeys.map(k => Math.round(streamInMap .get(k) || 0)), backgroundColor: 'rgba(16,185,129,0.8)' },
      { label: 'Operating Cash Out',  data: allKeys.map(k => Math.round(streamOpMap .get(k) || 0)), backgroundColor: 'rgba(239,68,68,0.8)'  },
      { label: 'Investment Cash Out', data: allKeys.map(k => Math.round(streamCapMap.get(k) || 0)), backgroundColor: 'rgba(185,28,28,0.8)'  }
    ],
    horizontal: true,
    stacked: false,
    onClickItem: (_label, idx, dsIdx) => {
      const sk = allKeys[idx];
      const streamLabel = STREAMS[sk]?.label || sk;
      const dsLabel = dsIdx === 0 ? 'Cash In' : dsIdx === 1 ? 'Operating Cash Out' : 'Investment Cash Out';
      const sPay = payments   .filter(p => (p.stream || 'other') === sk);
      const sInv = invoices   .filter(i => (i.stream || 'other') === sk);
      const sOp  = opExpenses .filter(e => expStream(e) === sk);
      const sCap = capExpenses.filter(e => expStream(e) === sk);
      const sIn     = sPay.reduce((s, p) => s + toEUR(p.amount, p.currency, p.date), 0)
                    + sInv.reduce((s, i) => s + toEUR(i.total, i.currency, i.issueDate), 0);
      const sOpOut  = sOp.reduce((s, e) => s + toEUR(e.amount, e.currency, e.date), 0);
      const sCapOut = sCap.reduce((s, e) => s + toEUR(e.amount, e.currency, e.date), 0);
      const sNet = sIn - sOpOut - sCapOut;

      const body = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });
      const summaryGrid = el('div', { style: 'display:grid;grid-template-columns:repeat(4,1fr);gap:10px' });
      summaryGrid.appendChild(mkSummaryBox('Cash In', formatEUR(sIn), `${sPay.length + sInv.length} items`));
      summaryGrid.appendChild(mkSummaryBox('Op. Cash Out', formatEUR(sOpOut), `${sOp.length} expenses`));
      summaryGrid.appendChild(mkSummaryBox('Invest. Out', formatEUR(sCapOut), `${sCap.length} items`));
      summaryGrid.appendChild(mkSummaryBox('Net CF', formatEUR(sNet), sNet >= 0 ? 'Surplus' : 'Deficit'));
      body.appendChild(summaryGrid);

      // Monthly breakdown for this stream
      const monthMap = new Map();
      const addM = (mk, inV, opV, capV) => {
        if (!mk) return;
        const c = monthMap.get(mk) || { in: 0, opOut: 0, capOut: 0 };
        c.in += inV; c.opOut += opV; c.capOut += capV;
        monthMap.set(mk, c);
      };
      sPay.forEach(p => addM(p.date?.slice(0, 7), toEUR(p.amount, p.currency, p.date), 0, 0));
      sInv.forEach(i => addM((i.issueDate || '').slice(0, 7), toEUR(i.total, i.currency, i.issueDate), 0, 0));
      sOp .forEach(e => addM(e.date?.slice(0, 7), 0, toEUR(e.amount, e.currency, e.date), 0));
      sCap.forEach(e => addM(e.date?.slice(0, 7), 0, 0, toEUR(e.amount, e.currency, e.date)));
      const monthEntries = [...monthMap.entries()].sort(([a], [b]) => a.localeCompare(b));
      if (monthEntries.length > 0) {
        const monthSection = el('div');
        monthSection.appendChild(mkSectionLabel('Monthly Breakdown'));
        monthSection.appendChild(mkModalTable(
          ['Month', 'Cash In', 'Op. Out', 'Invest. Out', 'Net'],
          monthEntries.map(([mk, d]) => [mk, formatEUR(d.in), formatEUR(d.opOut), formatEUR(d.capOut), formatEUR(d.in - d.opOut - d.capOut)])
        ));
        body.appendChild(monthSection);
      }

      // Focused dataset: category breakdown for OpEx/CapEx clicks
      if (dsIdx !== 0) {
        const items = dsIdx === 1 ? sOp : sCap;
        const total = dsIdx === 1 ? sOpOut : sCapOut;
        const catMap = new Map();
        items.forEach(e => { const cat = e.category || 'Uncategorized'; catMap.set(cat, (catMap.get(cat) || 0) + toEUR(e.amount, e.currency, e.date)); });
        const catEntries = [...catMap.entries()].sort((a, b) => b[1] - a[1]);
        if (catEntries.length > 0) {
          const catSection = el('div');
          catSection.appendChild(mkSectionLabel(`${dsLabel} by Category`));
          catSection.appendChild(mkModalTable(
            ['Category', 'Amount', '% of Total'],
            catEntries.map(([k, v]) => [k, formatEUR(v), total > 0 ? (v / total * 100).toFixed(1) + '%' : '—'])
          ));
          body.appendChild(catSection);
        }
      }

      openModal({ title: `${streamLabel} — ${dsLabel}`, body, large: true });
    }
  });
}

// ── Cash flow table ───────────────────────────────────────────────────────────
function buildCashFlowTable(container, { payments, invoices, opExpenses, capExpenses }) {
  const TABLE_COLS = [
    { key: 'date',        label: 'Date'                   },
    { key: 'source',      label: 'Source'                 },
    { key: 'type',        label: 'Type',      badge: true },
    { key: 'stream',      label: 'Stream'                 },
    { key: 'entity',      label: 'Entity'                 },
    { key: 'owner',       label: 'Owner'                  },
    { key: 'description', label: 'Description'            },
    { key: 'amountEUR',   label: 'Amount EUR', right: true }
  ];

  const rows = buildCashFlowRows(payments, invoices, opExpenses, capExpenses);

  // Border and badge colors by type
  const BORDER = { in: '#10b981', opex: '#ef4444', capex: '#b91c1c' };
  const BADGE_BG = {
    in:    'background:rgba(16,185,129,0.15);color:#10b981',
    opex:  'background:rgba(239,68,68,0.12);color:#ef4444',
    capex: 'background:rgba(185,28,28,0.12);color:#b91c1c'
  };

  const table = el('table', { class: 'table' });
  const htr   = el('tr');
  TABLE_COLS.forEach(col => htr.appendChild(el('th', { class: col.right ? 'right' : '' }, col.label)));
  table.appendChild(el('thead', {}, htr));

  const tbody = el('tbody');
  for (const r of rows) {
    const tr = el('tr', { style: `border-left:3px solid ${BORDER[r._type] || '#6366f1'}` });
    TABLE_COLS.forEach(col => {
      const td = el('td', { class: col.right ? 'right num' : '' });
      if (col.badge) {
        td.appendChild(el('span', {
          style: `font-size:10px;font-weight:600;padding:2px 6px;border-radius:3px;letter-spacing:0.04em;${BADGE_BG[r._type] || ''}`
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
  attachSortFilter(tableWrap, { initialCol: _cfSortCol, initialDir: _cfSortDir, onSortChange: (c, d) => { _cfSortCol = c; _cfSortDir = d; } });

  const totalIn  = rows.filter(r => r._type === 'in')   .reduce((s, r) => s + r._eur, 0);
  const totalOp  = rows.filter(r => r._type === 'opex') .reduce((s, r) => s + r._eur, 0);
  const totalCap = rows.filter(r => r._type === 'capex').reduce((s, r) => s + r._eur, 0);
  container.appendChild(el('div', {
    style: 'display:flex;justify-content:space-between;margin-top:8px;font-size:13px;flex-wrap:wrap;gap:8px'
  },
    el('span', { style: 'color:var(--text-muted)' }, `${rows.length} record(s)`),
    el('span', { style: 'display:flex;gap:16px;flex-wrap:wrap' },
      el('span', { style: 'color:#10b981' }, `In: ${formatEUR(totalIn)}`),
      el('span', { style: 'color:#ef4444' }, `Op Out: ${formatEUR(totalOp)}`),
      el('span', { style: 'color:#b91c1c' }, `Invest Out: ${formatEUR(totalCap)}`),
      el('strong', { class: 'num', style: totalIn - totalOp - totalCap >= 0 ? 'color:var(--success)' : 'color:var(--danger)' },
        `Net: ${formatEUR(totalIn - totalOp - totalCap)}`)
    )
  ));
}
