// Cash Flow Analytics Dashboard — track liquidity
import { el, buildMultiSelect, button, fmtDate, drillDownModal, attachSortFilter } from '../core/ui.js';
import * as charts from '../core/charts.js';
import { STREAMS, OWNERS } from '../core/config.js';
import {
  formatEUR, toEUR, byId,
  listActive, listActivePayments, isCapEx
} from '../core/data.js';
import {
  createFilterState, getCurrentPeriodRange, getComparisonRange,
  getMonthKeysForRange, makeMatchers, buildFilterBar, buildComparisonLine
} from './analytics-filters.js';

// ── Filter state ──────────────────────────────────────────────────────────────
let gF = createFilterState();

const CHART_IDS = ['cf-cumulative-line', 'cf-month-bar', 'cf-net-donut', 'cf-net-month-bar', 'cf-prop-hbar', 'cf-stream-bar'];

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

function safePct(cur, cmp) {
  if (cmp == null || !isFinite(cmp) || cmp === 0) return null;
  return (cur - cmp) / Math.abs(cmp) * 100;
}

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

  const payments = listActivePayments().filter(p =>
    p.status === 'paid' && inRange(p.date) && mStream(p) && mOwner(p) && mProperty(p)
  );
  const invoices = listActive('invoices').filter(i =>
    i.status === 'paid' && inRange(i.issueDate || i.date) && mStream(i) && mInvOwner(i) && mClient(i)
  );

  const allExp    = listActive('expenses');
  const opExpenses  = allExp.filter(e => !isCapEx(e) && inRange(e.date) && mExpStream(e) && mOwner(e) && mProperty(e));
  const capExpenses = allExp.filter(e =>  isCapEx(e) && inRange(e.date) && mExpStream(e) && mOwner(e) && mProperty(e));
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

// ── KPI card ──────────────────────────────────────────────────────────────────
function kpiCard(labelOrOpts, value, variant, onClick) {
  let label, subtitle, delta, deltaIsPp, invertDelta, compLabel;
  if (typeof labelOrOpts === 'object' && labelOrOpts !== null) {
    ({ label, value, subtitle, delta, deltaIsPp, invertDelta, compLabel, variant, onClick } = labelOrOpts);
  } else {
    label = labelOrOpts;
  }

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

  if (delta !== null && delta !== undefined && isFinite(delta)) {
    const up     = invertDelta ? delta < 0 : delta >= 0;
    const sign   = delta >= 0 ? '+' : '';
    const suffix = deltaIsPp ? ' pp' : '%';
    const trendEl = el('div', { class: 'kpi-trend ' + (up ? 'up' : 'down') });
    trendEl.appendChild(el('span', { class: 'kpi-arrow' }, up ? '▲' : '▼'));
    trendEl.append(` ${sign}${delta.toFixed(1)}${suffix}`);
    if (compLabel) trendEl.appendChild(el('span', { class: 'kpi-comp-label' }, ` vs ${compLabel}`));
    card.appendChild(trendEl);
  }

  if (subtitle) {
    card.appendChild(el('div', { style: 'font-size:11px;color:var(--text-muted);margin-top:2px' }, subtitle));
  }

  card.appendChild(el('div', { class: 'kpi-accent-bar' }));
  return card;
}

// ── Cash Flow Insights ────────────────────────────────────────────────────────
function computeCashFlowInsights({ payments, invoices, opExpenses, capExpenses, cashIn, opExCashOut, investCashOut, cashOut, opCashFlow, net }) {
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
      inspect: 'Transactions'
    });
  }

  // Negative net cash flow (only if op was positive, so we don't double-flag)
  if (net < 0 && opCashFlow >= 0) {
    signals.push({
      severity: 'Watch',
      title: 'NEGATIVE NET CASH FLOW',
      text: `Net cash flow is ${formatEUR(net)} after investment spend. Operating cash flow is positive.`,
      inspect: 'Transactions'
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
        inspect: 'Investment Cash Out'
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
        inspect: 'Monthly Cash In vs Cash Out'
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
      inspect: 'Monthly Net Cash Flow'
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

function buildInsightsBanner(signals) {
  const SEV_COLOR = { 'At Risk': '#ef4444', 'Watch': '#f59e0b', 'Note': '#6366f1' };
  const SEV_BG    = { 'At Risk': 'rgba(239,68,68,0.06)', 'Watch': 'rgba(245,158,11,0.06)', 'Note': 'rgba(99,102,241,0.06)' };

  const card = el('div', { class: 'card mb-16' });
  card.appendChild(el('div', { class: 'card-header' },
    el('div', { class: 'card-title' }, 'Cash Flow Insights')
  ));

  const grid = el('div', { style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px;padding:16px' });

  for (const sig of signals) {
    const color = SEV_COLOR[sig.severity] || SEV_COLOR['Note'];
    const bg    = SEV_BG[sig.severity]    || SEV_BG['Note'];
    const block = el('div', {
      style: `background:${bg};border-left:3px solid ${color};border-radius:0 var(--radius-sm) var(--radius-sm) 0;padding:12px 14px`
    });

    const titleRow = el('div', { style: 'display:flex;align-items:center;justify-content:space-between;margin-bottom:6px' });
    titleRow.appendChild(el('span', { style: `font-size:11px;font-weight:700;letter-spacing:0.5px;color:${color}` }, sig.title));
    titleRow.appendChild(el('span', { style: `font-size:10px;font-weight:600;padding:2px 6px;border-radius:3px;background:${color};color:#fff` }, sig.severity));
    block.appendChild(titleRow);

    block.appendChild(el('p', { style: 'margin:0 0 6px;font-size:12px;color:var(--text);line-height:1.4' }, sig.text));

    if (sig.inspect) {
      block.appendChild(el('div', { style: `font-size:11px;color:${color};font-weight:600` }, `→ Inspect: ${sig.inspect}`));
    }

    grid.appendChild(block);
  }

  card.appendChild(grid);
  return card;
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
    storagePrefix: 'cf'
  }, newState => {
    if (newState) Object.assign(gF, newState);
    rebuildView();
  });
  wrap.appendChild(filterBarEl);

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
  kpiRow1.appendChild(kpiCard({
    label:     'Cash In',
    value:     formatEUR(cashIn),
    variant:   'success',
    delta:     deltaCashIn,
    compLabel: cmpRange?.label,
    onClick:   () => drillDownModal('Cash In — All', buildCashFlowRows(payments, invoices, [], []), CF_DRILL_COLS)
  }));
  kpiRow1.appendChild(kpiCard({
    label:       'Operating Cash Out',
    value:       formatEUR(opExCashOut),
    subtitle:    'OpEx cash out',
    delta:       deltaOpEx,
    invertDelta: true,
    compLabel:   cmpRange?.label,
    onClick:     () => drillDownModal('Operating Cash Out', buildCashFlowRows([], [], opExpenses, []), CF_DRILL_COLS)
  }));
  kpiRow1.appendChild(kpiCard({
    label:     'Operating Cash Flow',
    value:     formatEUR(opCashFlow),
    variant:   opCashFlow >= 0 ? 'success' : 'danger',
    delta:     deltaOpCF,
    compLabel: cmpRange?.label,
    onClick:   () => drillDownModal('Operating Cash Flow', buildCashFlowRows(payments, invoices, opExpenses, []), CF_DRILL_COLS)
  }));
  wrap.appendChild(kpiRow1);

  // ── KPI row 2: Investment Cash Out, Net Cash Flow, Avg Monthly Net ─────────
  const kpiRow2 = el('div', { style: 'display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px;margin-bottom:16px' });
  kpiRow2.appendChild(kpiCard({
    label:       'Investment Cash Out',
    value:       formatEUR(investCashOut),
    variant:     investCashOut > 0 ? 'warning' : '',
    subtitle:    'CapEx cash out',
    delta:       deltaInvest,
    invertDelta: true,
    compLabel:   cmpRange?.label,
    onClick:     () => drillDownModal('Investment Cash Out', buildCashFlowRows([], [], [], capExpenses), CF_DRILL_COLS)
  }));
  kpiRow2.appendChild(kpiCard({
    label:     'Net Cash Flow',
    value:     formatEUR(net),
    variant:   net >= 0 ? 'success' : 'danger',
    subtitle:  'After OpEx and CapEx',
    delta:     deltaNet,
    compLabel: cmpRange?.label,
    onClick:   () => drillDownModal('Net Cash Flow — All Transactions', buildCashFlowRows(payments, invoices, opExpenses, capExpenses), CF_DRILL_COLS)
  }));
  kpiRow2.appendChild(kpiCard({
    label:     'Avg Monthly Net',
    value:     formatEUR(avgMonthlyNet),
    variant:   avgMonthlyNet >= 0 ? '' : 'warning',
    delta:     deltaAvgNet,
    compLabel: cmpRange?.label,
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
      const rows = [...monthMap.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([mk, d]) => ({
        month:  mk,
        cashIn: formatEUR(d.in),
        opOut:  formatEUR(d.opOut),
        capOut: formatEUR(d.capOut),
        net:    formatEUR(d.in - d.opOut - d.capOut)
      }));
      drillDownModal('Monthly Net Cash Flow', rows, [
        { key: 'month',  label: 'Month'        },
        { key: 'cashIn', label: 'Cash In',      right: true },
        { key: 'opOut',  label: 'Op. Out',      right: true },
        { key: 'capOut', label: 'Invest. Out',  right: true },
        { key: 'net',    label: 'Net',          right: true }
      ]);
    }
  }));
  wrap.appendChild(kpiRow2);

  // ── Cash Flow Insights ─────────────────────────────────────────────────────
  wrap.appendChild(buildInsightsBanner(computeCashFlowInsights(curData)));

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
    el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'Net Cash by Stream')),
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
      drillDownModal(`${label} — Transactions`, buildCashFlowRows(mPay, mInv, mOp, mCap), CF_DRILL_COLS);
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
      const [pay, inv, op, cap] = dsIdx === 0 ? [mPay, mInv, [], []] : dsIdx === 1 ? [[], [], mOp, []] : [[], [], [], mCap];
      drillDownModal(`${label} — ${dsIdx === 0 ? 'Cash In' : dsIdx === 1 ? 'Operating Cash Out' : 'Investment Cash Out'}`,
        buildCashFlowRows(pay, inv, op, cap), CF_DRILL_COLS);
    }
  });
}

// ── Chart 3: Donut — Net Cash by Stream ──────────────────────────────────────
function renderNetStreamDonut({ payments, invoices, opExpenses, capExpenses }) {
  const netMap = new Map();
  const add = (sk, v) => netMap.set(sk, (netMap.get(sk) || 0) + v);

  payments   .forEach(p => add(p.stream || 'other',  toEUR(p.amount, p.currency, p.date)));
  invoices   .forEach(i => add(i.stream || 'other',  toEUR(i.total, i.currency, i.issueDate)));
  opExpenses .forEach(e => add(expStream(e),         -toEUR(e.amount, e.currency, e.date)));
  capExpenses.forEach(e => add(expStream(e),         -toEUR(e.amount, e.currency, e.date)));

  const entries = [...netMap.entries()].filter(([, v]) => v !== 0)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  if (!entries.length) return;

  charts.doughnut('cf-net-donut', {
    labels: entries.map(([k, v]) => (STREAMS[k]?.short || k) + (v < 0 ? ' ▼' : '')),
    data:   entries.map(([, v]) => Math.abs(Math.round(v))),
    colors: entries.map(([, v]) => v >= 0 ? 'rgba(16,185,129,0.85)' : 'rgba(239,68,68,0.85)'),
    onClickItem: (_label, idx) => {
      const [sk] = entries[idx];
      const sPay = payments   .filter(p => (p.stream || 'other') === sk);
      const sInv = invoices   .filter(i => (i.stream || 'other') === sk);
      const sOp  = opExpenses .filter(e => expStream(e) === sk);
      const sCap = capExpenses.filter(e => expStream(e) === sk);
      drillDownModal(`Cash Flow — ${STREAMS[sk]?.label || sk}`, buildCashFlowRows(sPay, sInv, sOp, sCap), CF_DRILL_COLS);
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
      const mPay = payments   .filter(p => p.date?.slice(0, 7) === mk);
      const mInv = invoices   .filter(i => (i.issueDate || '').slice(0, 7) === mk);
      const mOp  = opExpenses .filter(e => e.date?.slice(0, 7) === mk);
      const mCap = capExpenses.filter(e => e.date?.slice(0, 7) === mk);
      drillDownModal(`Net Cash Flow — ${monthKeys[idx].label}`, buildCashFlowRows(mPay, mInv, mOp, mCap), CF_DRILL_COLS);
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
      const [pay, op, cap] = dsIdx === 0 ? [pPay, [], []] : dsIdx === 1 ? [[], pOp, []] : [[], [], pCap];
      drillDownModal(`${name} — ${dsIdx === 0 ? 'Cash In' : dsIdx === 1 ? 'Operating Cash Out' : 'Investment Cash Out'}`,
        buildCashFlowRows(pay, [], op, cap), CF_DRILL_COLS);
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
      const sk   = allKeys[idx];
      const sPay = payments   .filter(p => (p.stream || 'other') === sk);
      const sInv = invoices   .filter(i => (i.stream || 'other') === sk);
      const sOp  = opExpenses .filter(e => expStream(e) === sk);
      const sCap = capExpenses.filter(e => expStream(e) === sk);
      const [pay, inv, op, cap] = dsIdx === 0 ? [sPay, sInv, [], []] : dsIdx === 1 ? [[], [], sOp, []] : [[], [], [], sCap];
      drillDownModal(`${STREAMS[sk]?.label || sk} — ${dsIdx === 0 ? 'Cash In' : dsIdx === 1 ? 'Operating Cash Out' : 'Investment Cash Out'}`,
        buildCashFlowRows(pay, inv, op, cap), CF_DRILL_COLS);
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
  attachSortFilter(tableWrap);

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
