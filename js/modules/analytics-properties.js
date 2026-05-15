// Property Performance Analytics Dashboard
import { el, buildMultiSelect, button, fmtDate, drillDownModal, attachSortFilter } from '../core/ui.js';
import * as charts from '../core/charts.js';
import { STREAMS, OWNERS, PROPERTY_STREAMS, PROPERTY_STATUSES } from '../core/config.js';
import {
  formatEUR, toEUR, byId,
  listActive, listActivePayments, isCapEx,
  simplePropertyROI, annualizedPropertyROI, cashOnCashPropertyROI
} from '../core/data.js';
import { createFilterState, getCurrentPeriodRange, getComparisonRange, getMonthKeysForRange, makeMatchers, buildFilterBar, buildComparisonLine } from './analytics-filters.js';

// ── Filter state ──────────────────────────────────────────────────────────────
let gF = createFilterState();
let gStatusFilter = new Set(); // 'active' | 'renovation' | 'vacant' | 'sold'

const MONTH_LABELS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const CHART_IDS    = ['prop-profit-hbar', 'prop-month-bar', 'prop-rev-donut', 'prop-value-hbar', 'prop-value-owner-donut', 'prop-value-stream-donut', 'prop-acq-bar', 'prop-growth-line', 'prop-capital-line'];

// ── Module export ─────────────────────────────────────────────────────────────
export default {
  id:    'analytics-properties',
  label: 'Properties',
  icon:  'P',
  render(container) { container.appendChild(buildView()); },
  refresh() { rebuildView(); },
  destroy() { CHART_IDS.forEach(id => charts.destroy(id)); }
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function propStream(p) {
  if (p.type === 'short_term') return 'short_term_rental';
  if (p.type === 'long_term')  return 'long_term_rental';
  return 'other';
}

function safePct(cur, cmp) {
  if (cmp == null || !isFinite(cmp) || cmp === 0) return null;
  return (cur - cmp) / Math.abs(cmp) * 100;
}

// ── Data aggregation ──────────────────────────────────────────────────────────
function getData(start, end) {
  const { mOwner } = makeMatchers(gF);

  // Custom matchers for property objects (p.id / p.type, not p.propertyId / p.stream)
  const mPropStream = p => !gF.streams.size || gF.streams.has(propStream(p));
  const mPropId     = p => !gF.propertyIds.size || gF.propertyIds.has(p.id);
  const mStatus     = p => !gStatusFilter.size || gStatusFilter.has(p.status || 'active');

  const allProps = listActive('properties').filter(p =>
    mOwner(p) && mPropStream(p) && mPropId(p) && mStatus(p)
  );
  const propIds = new Set(allProps.map(p => p.id));

  const matchDate = row => {
    const mk = (row.date || '').slice(0, 7);
    return mk >= start && mk <= end;
  };

  const payments    = listActivePayments().filter(p =>
    p.status === 'paid' && matchDate(p) && propIds.has(p.propertyId)
  );
  const opExpenses  = listActive('expenses').filter(e =>
    !isCapEx(e) && matchDate(e) && propIds.has(e.propertyId)
  );
  const capExpenses = listActive('expenses').filter(e =>
    isCapEx(e) && matchDate(e) && propIds.has(e.propertyId)
  );
  // All-time CapEx is never filtered by current period date range
  const allCapExpenses = listActive('expenses').filter(e => isCapEx(e));

  const propData = allProps.map(prop => {
    const propPay   = payments   .filter(p => p.propertyId === prop.id);
    const propOpEx  = opExpenses .filter(e => e.propertyId === prop.id);
    const propCapEx = capExpenses.filter(e => e.propertyId === prop.id);
    const rev   = propPay  .reduce((s, p) => s + toEUR(p.amount, p.currency, p.date), 0);
    const opEx  = propOpEx .reduce((s, e) => s + toEUR(e.amount, e.currency, e.date), 0);
    const capEx = propCapEx.reduce((s, e) => s + toEUR(e.amount, e.currency, e.date), 0);

    const allTimeCapEx  = allCapExpenses
      .filter(e => e.propertyId === prop.id)
      .reduce((s, e) => s + toEUR(e.amount, e.currency, e.date), 0);
    const purchaseEUR   = prop.purchasePrice
      ? toEUR(prop.purchasePrice, prop.currency, prop.purchaseDate) : 0;
    const totalInvested = purchaseEUR + allTimeCapEx;

    const netIncome     = rev - opEx;
    const simpleROI     = simplePropertyROI(prop.id,     { netIncome, totalInvested });
    const annualizedROI = annualizedPropertyROI(prop.id, { netIncome, totalInvested });
    const cashOnCashROI = cashOnCashPropertyROI(prop.id, { annualCashFlow: netIncome });

    return {
      prop, rev, opEx, capEx, allTimeCapEx, purchaseEUR, totalInvested,
      profit: rev - opEx,
      net:    rev - opEx - capEx,
      simpleROI, annualizedROI, cashOnCashROI,
      propPayments:    propPay,
      propOpExpenses:  propOpEx,
      propCapExpenses: propCapEx
    };
  });

  const totals = propData.reduce((s, d) => ({
    rev:           s.rev           + d.rev,
    opEx:          s.opEx          + d.opEx,
    capEx:         s.capEx         + d.capEx,
    profit:        s.profit        + d.profit,
    net:           s.net           + d.net,
    purchaseValue: s.purchaseValue + d.purchaseEUR,
    totalInvested: s.totalInvested + d.totalInvested,
    allTimeCapEx:  s.allTimeCapEx  + d.allTimeCapEx
  }), { rev: 0, opEx: 0, capEx: 0, profit: 0, net: 0, purchaseValue: 0, totalInvested: 0, allTimeCapEx: 0 });

  const roiItems = propData.filter(d => d.simpleROI !== null);
  const avgROI   = roiItems.length > 0
    ? roiItems.reduce((s, d) => s + d.simpleROI, 0) / roiItems.length : null;

  const ranked = [...propData]
    .filter(d => d.rev > 0 || d.opEx > 0)
    .sort((a, b) => {
      if (a.simpleROI !== null && b.simpleROI !== null) return b.simpleROI - a.simpleROI;
      if (a.simpleROI !== null) return -1;
      if (b.simpleROI !== null) return 1;
      return b.profit - a.profit;
    });
  const best  = ranked.length > 0 ? ranked[0] : null;
  const worst = ranked.length > 1 ? ranked[ranked.length - 1] : null;

  return { allProps, propData, payments, opExpenses, capExpenses, totals, avgROI, best, worst };
}

// ── Rebuild ───────────────────────────────────────────────────────────────────
function rebuildView() {
  CHART_IDS.forEach(id => charts.destroy(id));
  const c = document.getElementById('content');
  if (!c) return;
  c.innerHTML = '';
  c.appendChild(buildView());
}

// ── Drill-down row builders ───────────────────────────────────────────────────
function toRevDrillRows(payments) {
  return payments.map(p => ({
    date:     p.date,
    property: byId('properties', p.propertyId)?.name || '—',
    type:     p.type || '—',
    stream:   STREAMS[p.stream]?.short || p.stream || '—',
    status:   p.status || '—',
    eur:      toEUR(p.amount, p.currency, p.date)
  })).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

function toExpDrillRows(expenses) {
  return expenses.map(e => ({
    date:     e.date,
    property: byId('properties', e.propertyId)?.name || '—',
    type:     isCapEx(e) ? 'CapEx' : 'OpEx',
    category: e.category || '—',
    eur:      toEUR(e.amount, e.currency, e.date)
  })).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

const REV_DRILL_COLS = [
  { key: 'date',     label: 'Date',     format: v => fmtDate(v) },
  { key: 'property', label: 'Property' },
  { key: 'type',     label: 'Type'     },
  { key: 'stream',   label: 'Stream'   },
  { key: 'status',   label: 'Status'   },
  { key: 'eur',      label: 'EUR',      right: true, format: v => formatEUR(v) }
];

const EXP_DRILL_COLS = [
  { key: 'date',     label: 'Date',     format: v => fmtDate(v) },
  { key: 'property', label: 'Property' },
  { key: 'type',     label: 'Type'     },
  { key: 'category', label: 'Category' },
  { key: 'eur',      label: 'EUR',      right: true, format: v => formatEUR(v) }
];

const MIXED_DRILL_COLS = [
  { key: 'date',     label: 'Date',     format: v => fmtDate(v) },
  { key: 'kind',     label: 'Kind'     },
  { key: 'property', label: 'Property' },
  { key: 'category', label: 'Category' },
  { key: 'status',   label: 'Status'   },
  { key: 'eur',      label: 'EUR',      right: true, format: v => formatEUR(v) }
];

// ── Investment drill helpers ───────────────────────────────────────────────────
function toPropValueRows(propData) {
  return propData.map(d => ({
    name:     d.prop.name,
    stream:   STREAMS[propStream(d.prop)]?.short || propStream(d.prop),
    owner:    OWNERS[d.prop.owner] || d.prop.owner || '—',
    pdate:    d.prop.purchaseDate || '—',
    purchase: d.purchaseEUR,
    reno:     d.allTimeCapEx,
    invested: d.totalInvested
  })).sort((a, b) => b.invested - a.invested);
}
const PROP_VALUE_COLS = [
  { key: 'name',     label: 'Property'        },
  { key: 'stream',   label: 'Stream'          },
  { key: 'owner',    label: 'Owner'           },
  { key: 'pdate',    label: 'Purchase Date',   format: v => fmtDate(v) },
  { key: 'purchase', label: 'Purchase (EUR)',  right: true, format: v => formatEUR(v) },
  { key: 'reno',     label: 'All-Time CapEx',  right: true, format: v => formatEUR(v) },
  { key: 'invested', label: 'Total Invested',  right: true, format: v => formatEUR(v) }
];

function toROIDrillRows(propData) {
  return propData.map(d => ({
    name:     d.prop.name,
    rev:      d.rev,
    expenses: d.opEx,
    net:      d.profit,
    invested: d.totalInvested,
    roi:      d.simpleROI,
    annRoi:   d.annualizedROI,
    cocRoi:   d.cashOnCashROI
  })).sort((a, b) => (b.roi ?? -Infinity) - (a.roi ?? -Infinity));
}
const ROI_DRILL_COLS = [
  { key: 'name',     label: 'Property'                                           },
  { key: 'rev',      label: 'Revenue',    right: true, format: v => formatEUR(v) },
  { key: 'expenses', label: 'Expenses',   right: true, format: v => formatEUR(v) },
  { key: 'net',      label: 'Op. Profit', right: true, format: v => formatEUR(v) },
  { key: 'invested', label: 'Invested',   right: true, format: v => formatEUR(v) },
  { key: 'roi',      label: 'Simple ROI', right: true, format: v => v != null ? v.toFixed(1) + '%' : '—' },
  { key: 'annRoi',   label: 'Ann. ROI',   right: true, format: v => v != null ? v.toFixed(1) + '%' : '—' },
  { key: 'cocRoi',   label: 'CoC ROI',    right: true, format: v => v != null ? v.toFixed(1) + '%' : '—' }
];

function mixedRows(pays, exps) {
  return [
    ...toRevDrillRows(pays) .map(r => ({ ...r, kind: 'Revenue', category: '—' })),
    ...toExpDrillRows(exps) .map(r => ({ ...r, kind: r.type,   status:   '—' }))
  ].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

// ── Acquisition & growth data ─────────────────────────────────────────────────
function formatMonthKey(mk) {
  const [year, mm] = mk.split('-');
  return `${MONTH_LABELS[parseInt(mm, 10) - 1]} ${year}`;
}

function getAcquisitionData(allProps) {
  const propIds    = new Set(allProps.map(p => p.id));
  const allCapEx   = listActive('expenses').filter(e => isCapEx(e) && propIds.has(e.propertyId));
  const withDate   = allProps.filter(p => p.purchaseDate);
  const withoutDate = allProps.filter(p => !p.purchaseDate);

  const bucketMap = new Map();
  withDate.forEach(p => {
    const mk = p.purchaseDate.slice(0, 7);
    if (!bucketMap.has(mk)) bucketMap.set(mk, { count: 0, props: [] });
    const b = bucketMap.get(mk);
    b.count++;
    b.props.push(p);
  });

  const capitalMap = new Map();
  withDate.forEach(p => {
    const mk = p.purchaseDate.slice(0, 7);
    if (!capitalMap.has(mk)) capitalMap.set(mk, { purchaseEUR: 0, capExEUR: 0, capExItems: [] });
    capitalMap.get(mk).purchaseEUR += p.purchasePrice
      ? toEUR(p.purchasePrice, p.currency, p.purchaseDate) : 0;
  });
  allCapEx.forEach(e => {
    if (!e.date) return;
    const mk = e.date.slice(0, 7);
    if (!capitalMap.has(mk)) capitalMap.set(mk, { purchaseEUR: 0, capExEUR: 0, capExItems: [] });
    const c = capitalMap.get(mk);
    c.capExEUR += toEUR(e.amount, e.currency, e.date);
    c.capExItems.push(e);
  });

  const allMonths = [...new Set([...bucketMap.keys(), ...capitalMap.keys()])].sort();

  let cumCount = 0, cumCapital = 0;
  const timeline = allMonths.map(mk => {
    const b = bucketMap.get(mk);
    const c = capitalMap.get(mk) || { purchaseEUR: 0, capExEUR: 0, capExItems: [] };
    cumCount   += b ? b.count : 0;
    cumCapital += c.purchaseEUR + c.capExEUR;
    return {
      mk,
      label:       formatMonthKey(mk),
      count:       b ? b.count : 0,
      cumCount,
      capital:     c.purchaseEUR + c.capExEUR,
      cumCapital,
      props:       b ? b.props : [],
      capExItems:  c.capExItems
    };
  });

  return { timeline, withoutDate };
}

function toPropAcqRows(props) {
  return props.map(p => ({
    name:   p.name,
    stream: STREAMS[propStream(p)]?.short || propStream(p),
    owner:  OWNERS[p.owner] || p.owner || '—',
    city:   p.city || '—',
    pdate:  p.purchaseDate || '—',
    price:  p.purchasePrice ? toEUR(p.purchasePrice, p.currency, p.purchaseDate) : 0
  })).sort((a, b) => (a.pdate || '').localeCompare(b.pdate || ''));
}
const PROP_ACQ_COLS = [
  { key: 'name',   label: 'Property'                                            },
  { key: 'stream', label: 'Stream'                                              },
  { key: 'owner',  label: 'Owner'                                               },
  { key: 'city',   label: 'City'                                                },
  { key: 'pdate',  label: 'Purchase Date', format: v => fmtDate(v)              },
  { key: 'price',  label: 'Price (EUR)',   right: true, format: v => formatEUR(v) }
];

function toCapitalDrillRows(monthProps, capExItems) {
  const purchaseRows = monthProps.map(p => ({
    date:    p.purchaseDate || '—',
    type:    'Purchase',
    name:    p.name,
    detail:  p.city || '—',
    eur:     p.purchasePrice ? toEUR(p.purchasePrice, p.currency, p.purchaseDate) : 0
  }));
  const capExRows = capExItems.map(e => ({
    date:    e.date || '—',
    type:    'CapEx',
    name:    byId('properties', e.propertyId)?.name || '—',
    detail:  e.category || '—',
    eur:     toEUR(e.amount, e.currency, e.date)
  }));
  return [...purchaseRows, ...capExRows].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}
const CAPITAL_DRILL_COLS = [
  { key: 'date',   label: 'Date',     format: v => fmtDate(v)               },
  { key: 'type',   label: 'Type'                                             },
  { key: 'name',   label: 'Property'                                         },
  { key: 'detail', label: 'Detail'                                           },
  { key: 'eur',    label: 'EUR',      right: true, format: v => formatEUR(v) }
];

// ── Mortgage estimation ───────────────────────────────────────────────────────
function computeMortgageEstimate(prop) {
  const principalRaw = prop.mortgageAmount  || 0;
  if (!principalRaw) {
    return { financed: false, principalEUR: 0, remaining: 0, yearsLeft: null, paidOff: false, monthlyDebt: 0, dtvRatio: null };
  }

  const cur        = prop.currency    || 'EUR';
  const rateDate   = prop.purchaseDate || null;
  const principalEUR = toEUR(principalRaw,          cur, rateDate);
  const monthlyEUR   = toEUR(prop.mortgageMonthly || 0, cur, rateDate);
  const purchaseEUR  = prop.purchasePrice ? toEUR(prop.purchasePrice, cur, rateDate) : 0;
  const r            = (prop.mortgageRate || 0) / 100 / 12;

  let remaining = principalEUR;
  let yearsLeft = null;
  let paidOff   = false;

  if (rateDate && monthlyEUR > 0) {
    const msSince = Date.now() - new Date(rateDate).getTime();
    const n       = Math.max(0, Math.round(msSince / (30.4375 * 24 * 3600 * 1000)));

    if (r > 0) {
      const f = Math.pow(1 + r, n);
      remaining = principalEUR * f - monthlyEUR * (f - 1) / r;
    } else {
      remaining = principalEUR - monthlyEUR * n;
    }
    remaining = Math.max(0, remaining);
    paidOff   = remaining <= 0;

    if (!paidOff) {
      if (r > 0) {
        const arg = 1 - (remaining * r / monthlyEUR);
        yearsLeft = arg > 0 ? (-Math.log(arg) / Math.log(1 + r)) / 12 : null;
      } else {
        yearsLeft = remaining / monthlyEUR / 12;
      }
    } else {
      yearsLeft = 0;
    }
  }

  return {
    financed:     true,
    principalEUR,
    remaining,
    yearsLeft,
    paidOff,
    monthlyDebt:  monthlyEUR,
    dtvRatio:     purchaseEUR > 0 ? (remaining / purchaseEUR) * 100 : null
  };
}

// ── Financing data aggregation ────────────────────────────────────────────────
function getFinancingData(allProps) {
  const finData    = allProps.map(prop => ({ prop, ...computeMortgageEstimate(prop) }));
  const withMortgage = finData.filter(d => d.financed);
  const activeDebt   = finData.filter(d => d.financed && !d.paidOff);

  const totalDebt    = withMortgage.reduce((s, d) => s + d.remaining,   0);
  const totalMonthly = activeDebt  .reduce((s, d) => s + d.monthlyDebt, 0);
  const totalValue   = allProps.reduce((s, p) =>
    s + (p.purchasePrice ? toEUR(p.purchasePrice, p.currency, p.purchaseDate) : 0), 0);

  const yearsItems   = activeDebt.filter(d => d.yearsLeft != null);
  const avgYearsLeft = yearsItems.length > 0
    ? yearsItems.reduce((s, d) => s + d.yearsLeft, 0) / yearsItems.length : null;

  return {
    finData,
    totals: {
      totalDebt,
      totalMonthly,
      leverageRatio: totalValue > 0 ? (totalDebt / totalValue) * 100 : null,
      avgYearsLeft,
      nFinanced: withMortgage.length,
      nActive:   activeDebt.length,
      nPaidOff:  allProps.length - withMortgage.length
    }
  };
}

function toFinancingDrillRows(finData) {
  return [...finData].sort((a, b) => b.remaining - a.remaining).map(d => ({
    name:      d.prop.name,
    owner:     OWNERS[d.prop.owner] || d.prop.owner || '—',
    stream:    STREAMS[propStream(d.prop)]?.short || propStream(d.prop),
    principal: d.principalEUR || 0,
    remaining: d.remaining    || 0,
    monthly:   d.monthlyDebt  || 0,
    yearsLeft: d.yearsLeft,
    dtv:       d.dtvRatio,
    status:    d.paidOff ? 'Paid Off' : d.financed ? 'Active' : 'None'
  }));
}
const FINANCING_DRILL_COLS = [
  { key: 'name',      label: 'Property'                                                      },
  { key: 'owner',     label: 'Owner'                                                         },
  { key: 'stream',    label: 'Stream'                                                        },
  { key: 'principal', label: 'Orig. Loan', right: true, format: v => formatEUR(v)            },
  { key: 'remaining', label: 'Remaining',  right: true, format: v => formatEUR(v)            },
  { key: 'monthly',   label: 'Monthly',    right: true, format: v => v ? formatEUR(v) : '—'  },
  { key: 'yearsLeft', label: 'Yrs Left',   right: true, format: v => v != null ? v.toFixed(1) : '—' },
  { key: 'dtv',       label: 'DTV %',      right: true, format: v => v != null ? v.toFixed(0) + '%' : '—' },
  { key: 'status',    label: 'Status'                                                        }
];

function toMortgageDetailRows(d) {
  if (!d.financed) {
    return [
      { metric: 'Property', value: d.prop.name },
      { metric: 'Mortgage',  value: 'None — cash purchase or no mortgage data entered' }
    ];
  }
  return [
    { metric: 'Property',               value: d.prop.name                                         },
    { metric: 'Original Loan (EUR)',     value: formatEUR(d.principalEUR)                           },
    { metric: 'Monthly Payment (EUR)',   value: d.monthlyDebt ? formatEUR(d.monthlyDebt) : '—'      },
    { metric: 'Interest Rate',           value: d.prop.mortgageRate ? d.prop.mortgageRate + '%' : '—' },
    { metric: 'Purchase Date',           value: d.prop.purchaseDate ? fmtDate(d.prop.purchaseDate) : '—' },
    { metric: 'Est. Remaining Balance',  value: formatEUR(d.remaining)                              },
    { metric: 'Est. Years to Payoff',    value: d.yearsLeft != null ? d.yearsLeft.toFixed(1) + ' years' : 'N/A (missing payment data)' },
    { metric: 'Debt-to-Value Ratio',     value: d.dtvRatio != null ? d.dtvRatio.toFixed(1) + '%' : '—' },
    { metric: 'Status',                  value: d.paidOff ? '✓ Paid Off' : 'Active'                }
  ];
}
const MORTGAGE_DETAIL_COLS = [
  { key: 'metric', label: 'Metric' },
  { key: 'value',  label: 'Value'  }
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

// ── Insights ──────────────────────────────────────────────────────────────────
function computePropertyInsights({ totals, propData, avgROI, best, worst }) {
  const signals = [];
  if (totals.rev === 0 && totals.opEx === 0) {
    signals.push({
      severity: 'Note',
      title: 'NO ACTIVITY',
      text: 'No revenue or expenses recorded for the selected period and filters.',
      inspect: null
    });
    return signals;
  }

  if (totals.profit < 0) {
    signals.push({
      severity: 'At Risk',
      title: 'OPERATING LOSS',
      text: `Portfolio is operating at a loss: ${formatEUR(totals.profit)} operating profit for the period.`,
      inspect: 'Operating Profit'
    });
  }

  if (totals.rev > 0 && totals.opEx / totals.rev > 0.80) {
    const pct = Math.round(totals.opEx / totals.rev * 100);
    signals.push({
      severity: 'Watch',
      title: 'HIGH EXPENSE RATIO',
      text: `Operating expenses are ${pct}% of revenue — high overhead. Review recurring costs.`,
      inspect: 'Operating Expenses'
    });
  }

  if (avgROI !== null && avgROI < 0) {
    signals.push({
      severity: 'At Risk',
      title: 'NEGATIVE ROI',
      text: `Portfolio average Simple ROI is ${avgROI.toFixed(1)}% — net losses exceed invested capital.`,
      inspect: 'ROI Overview'
    });
  } else if (worst && avgROI !== null && worst.simpleROI !== null && worst.simpleROI < avgROI - 15) {
    signals.push({
      severity: 'Watch',
      title: 'UNDERPERFORMER',
      text: `"${worst.prop.name}" has ROI of ${worst.simpleROI.toFixed(1)}% vs portfolio avg ${avgROI.toFixed(1)}% — lagging by more than 15 pp.`,
      inspect: worst.prop.name
    });
  }

  if (totals.net < 0 && totals.capEx > 0) {
    signals.push({
      severity: 'Note',
      title: 'CAPEX DRAG',
      text: `Net income after CapEx is ${formatEUR(totals.net)}. This may reflect an active renovation period.`,
      inspect: 'Property CapEx'
    });
  }

  if (best && worst && best !== worst) {
    const spread = (best.simpleROI ?? 0) - (worst.simpleROI ?? 0);
    if (spread > 20) {
      signals.push({
        severity: 'Note',
        title: 'ROI SPREAD',
        text: `${spread.toFixed(0)} pp spread between best ("${best.prop.name}") and weakest ("${worst.prop.name}") performer. Review allocation.`,
        inspect: 'Property Comparison'
      });
    }
  }

  return signals;
}

function buildInsightsBanner(signals) {
  if (!signals.length) return null;
  const SEV_COLOR = { 'At Risk': '#ef4444', 'Watch': '#f59e0b', 'Note': '#6366f1' };
  const SEV_BG    = { 'At Risk': 'rgba(239,68,68,0.06)', 'Watch': 'rgba(245,158,11,0.06)', 'Note': 'rgba(99,102,241,0.06)' };

  const card = el('div', { class: 'card mb-16' });
  card.appendChild(el('div', { class: 'card-header' },
    el('div', { class: 'card-title' }, 'Property Insights')
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
    el('h2', { style: 'margin:0 0 4px;font-size:20px;font-weight:700' }, 'Property Performance'),
    el('p',  { style: 'margin:0;font-size:13px;color:var(--text-muted)' },
      'Revenue, expenses, and profitability evaluated per property')
  ));

  // Shared filter bar
  const filterBarEl = buildFilterBar(gF, {
    showOwner: true, showStream: true, showProperty: true, showClient: false,
    storagePrefix: 'prop'
  }, newState => {
    if (newState) Object.assign(gF, newState);
    rebuildView();
  });
  wrap.appendChild(filterBarEl);

  // Local property status filter
  const statusWrap = el('div', { style: 'display:flex;align-items:center;gap:8px;margin-bottom:16px;flex-wrap:wrap' });
  statusWrap.appendChild(el('span', { style: 'font-size:12px;color:var(--text-muted)' }, 'Status:'));
  const statusOpts = Object.entries(PROPERTY_STATUSES).map(([k, v]) => ({ value: k, label: v.label }));
  const statusMS = buildMultiSelect(statusOpts, gStatusFilter, 'All Statuses', rebuildView, 'prop_status');
  statusWrap.appendChild(statusMS);
  wrap.appendChild(statusWrap);

  // Date ranges
  const curRange = getCurrentPeriodRange(gF);
  const cmpRange = getComparisonRange(gF, curRange);
  const { start, end } = curRange;

  const curData = getData(start, end);
  const cmpData = cmpRange ? getData(cmpRange.start, cmpRange.end) : null;

  const { allProps, propData, payments, opExpenses, capExpenses, totals, avgROI, best, worst } = curData;

  // Comparison line
  const compLine = buildComparisonLine(curRange, cmpRange);
  if (compLine) wrap.appendChild(compLine);

  // ── Section 1: Portfolio Units ─────────────────────────────────────────────
  const activeCount = allProps.filter(p => (p.status || 'active') === 'active').length;
  const invKpiRow = el('div', { class: 'grid grid-4 mb-16' });
  invKpiRow.appendChild(kpiCard({
    label: 'Portfolio Units',
    value: String(allProps.length),
    onClick: () => drillDownModal('Portfolio Properties', toPropValueRows(propData), PROP_VALUE_COLS)
  }));
  invKpiRow.appendChild(kpiCard({
    label: 'Active Properties',
    value: String(activeCount),
    subtitle: allProps.length > activeCount ? `${allProps.length - activeCount} other status` : null,
    onClick: () => drillDownModal('Portfolio Properties', toPropValueRows(propData), PROP_VALUE_COLS)
  }));
  invKpiRow.appendChild(kpiCard({
    label: 'Portfolio Book Value',
    value: formatEUR(totals.purchaseValue),
    subtitle: 'Purchase prices only',
    onClick: () => drillDownModal('Portfolio Book Value', toPropValueRows(propData), PROP_VALUE_COLS)
  }));
  invKpiRow.appendChild(kpiCard({
    label: 'Total Invested',
    value: formatEUR(totals.totalInvested),
    subtitle: 'Purchase + all-time CapEx',
    onClick: () => drillDownModal('Total Invested Capital', toPropValueRows(propData), PROP_VALUE_COLS)
  }));
  wrap.appendChild(invKpiRow);

  // ── Section 2: Period Performance ─────────────────────────────────────────
  const deltaRev    = safePct(totals.rev,    cmpData?.totals.rev);
  const deltaOpEx   = safePct(totals.opEx,   cmpData?.totals.opEx);
  const deltaProfit = safePct(totals.profit, cmpData?.totals.profit);
  const deltaCapEx  = safePct(totals.capEx,  cmpData?.totals.capEx);

  const kpiRow = el('div', { class: 'grid grid-4 mb-16' });
  kpiRow.appendChild(kpiCard({
    label:      'Rental Revenue',
    value:      formatEUR(totals.rev),
    delta:      deltaRev,
    onClick:    () => drillDownModal('Revenue — All Properties', toRevDrillRows(payments), REV_DRILL_COLS)
  }));
  kpiRow.appendChild(kpiCard({
    label:       'Operating Expenses',
    value:       formatEUR(totals.opEx),
    delta:       deltaOpEx,
    invertDelta: true,
    onClick:     () => drillDownModal('Operating Expenses — All Properties', toExpDrillRows(opExpenses), EXP_DRILL_COLS)
  }));
  kpiRow.appendChild(kpiCard({
    label:   'Operating Profit',
    value:   formatEUR(totals.profit),
    variant: totals.profit >= 0 ? 'success' : 'danger',
    delta:   deltaProfit,
    onClick: () => drillDownModal('Operating Profit Breakdown', mixedRows(payments, opExpenses), MIXED_DRILL_COLS)
  }));
  kpiRow.appendChild(kpiCard({
    label:       'Property CapEx',
    value:       formatEUR(totals.capEx),
    variant:     totals.capEx > 0 ? 'warning' : '',
    delta:       deltaCapEx,
    invertDelta: true,
    onClick:     () => drillDownModal('Property CapEx — All Properties', toExpDrillRows(capExpenses), EXP_DRILL_COLS)
  }));
  wrap.appendChild(kpiRow);

  // Property insights
  const signals = computePropertyInsights(curData);
  const banner  = buildInsightsBanner(signals);
  if (banner) wrap.appendChild(banner);

  // ── Chart row 1: profit hbar (2/3) + revenue donut (1/3) ──────────────────
  const row1 = el('div', { style: 'display:grid;grid-template-columns:2fr 1fr;gap:16px;margin-bottom:16px' });
  row1.appendChild(el('div', { class: 'card' },
    el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'Operating Profit by Property')),
    el('div', { class: 'chart-wrap tall' }, el('canvas', { id: 'prop-profit-hbar' }))
  ));
  row1.appendChild(el('div', { class: 'card' },
    el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'Revenue Share')),
    el('div', { class: 'chart-wrap tall' }, el('canvas', { id: 'prop-rev-donut' }))
  ));
  wrap.appendChild(row1);

  // ── Chart row 2: monthly grouped bar ──────────────────────────────────────
  wrap.appendChild(el('div', { class: 'card mb-16' },
    el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'Monthly Revenue vs Operating Expenses')),
    el('div', { class: 'chart-wrap' }, el('canvas', { id: 'prop-month-bar' }))
  ));

  // ── Total investment breakdown ─────────────────────────────────────────────
  wrap.appendChild(el('div', { class: 'card mb-16' },
    el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'Total Investment by Property (Purchase + All-Time CapEx)')),
    el('div', { class: 'chart-wrap tall' }, el('canvas', { id: 'prop-value-hbar' }))
  ));
  const valueRow = el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px' });
  valueRow.appendChild(el('div', { class: 'card' },
    el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'Invested Capital by Owner')),
    el('div', { class: 'chart-wrap' }, el('canvas', { id: 'prop-value-owner-donut' }))
  ));
  valueRow.appendChild(el('div', { class: 'card' },
    el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'Invested Capital by Stream')),
    el('div', { class: 'chart-wrap' }, el('canvas', { id: 'prop-value-stream-donut' }))
  ));
  wrap.appendChild(valueRow);

  // ── Property comparison ────────────────────────────────────────────────────
  const compSection = buildComparisonSection({ propData, avgROI, best, worst });
  if (compSection) wrap.appendChild(compSection);

  // ── Property summary table ─────────────────────────────────────────────────
  const tableCard = el('div', { class: 'card' });
  tableCard.appendChild(el('div', { class: 'card-header' },
    el('div', { class: 'card-title' }, 'Property Summary'),
    el('div', { style: 'font-size:12px;color:var(--text-muted)' }, 'Click a row for transactions')
  ));
  buildSummaryTable(tableCard, propData);
  wrap.appendChild(tableCard);

  // ── Portfolio Acquisition & Growth ─────────────────────────────────────────
  const acqData = getAcquisitionData(allProps);

  wrap.appendChild(el('div', { style: 'margin:28px 0 12px' },
    el('h3', { style: 'margin:0 0 4px;font-size:16px;font-weight:700' }, 'Portfolio Acquisition & Growth'),
    el('p',  { style: 'margin:0;font-size:12px;color:var(--text-muted)' },
      'Based on purchase dates. Property / Stream / Owner / Status filters apply; Current Period and Comparison Period filters do not.' +
      (acqData.withoutDate.length ? ` ${acqData.withoutDate.length} propert${acqData.withoutDate.length > 1 ? 'ies' : 'y'} excluded (no purchase date).` : '')
    )
  ));

  wrap.appendChild(el('div', { class: 'card mb-16' },
    el('div', { class: 'card-header' },
      el('div', { class: 'card-title' }, 'Acquisitions per Month'),
      el('div', { style: 'font-size:12px;color:var(--text-muted)' }, 'Click a bar to see properties acquired')
    ),
    el('div', { class: 'chart-wrap' }, el('canvas', { id: 'prop-acq-bar' }))
  ));

  const acqGrowthRow = el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px' });
  acqGrowthRow.appendChild(el('div', { class: 'card' },
    el('div', { class: 'card-header' },
      el('div', { class: 'card-title' }, 'Cumulative Portfolio Growth'),
      el('div', { style: 'font-size:12px;color:var(--text-muted)' }, 'Click a point to see portfolio at that date')
    ),
    el('div', { class: 'chart-wrap' }, el('canvas', { id: 'prop-growth-line' }))
  ));
  acqGrowthRow.appendChild(el('div', { class: 'card' },
    el('div', { class: 'card-header' },
      el('div', { class: 'card-title' }, 'Cumulative Capital Deployed'),
      el('div', { style: 'font-size:12px;color:var(--text-muted)' }, 'Purchase prices + All-Time CapEx')
    ),
    el('div', { class: 'chart-wrap' }, el('canvas', { id: 'prop-capital-line' }))
  ));
  wrap.appendChild(acqGrowthRow);

  // ── Financing & Payoff ─────────────────────────────────────────────────────
  wrap.appendChild(buildFinancingSection(getFinancingData(allProps)));

  const monthKeys = getMonthKeysForRange(start, end);
  setTimeout(() => {
    renderProfitHBar(curData);
    renderRevDonut(curData);
    renderMonthBar(curData, monthKeys);
    renderValueHBar(curData);
    renderValueOwnerDonut(curData);
    renderValueStreamDonut(curData);
    renderAcqBar(acqData);
    renderGrowthLine(acqData);
    renderCapitalLine(acqData);
  }, 0);

  return wrap;
}

// ── Chart 1: Horizontal bar — Property × Operating Profit ────────────────────
function renderProfitHBar({ propData }) {
  const sorted = [...propData].sort((a, b) => b.profit - a.profit);
  if (!sorted.length) return;

  charts.bar('prop-profit-hbar', {
    labels: sorted.map(d => d.prop.name),
    datasets: [{
      label:           'Operating Profit (EUR)',
      data:            sorted.map(d => Math.round(d.profit)),
      backgroundColor: sorted.map(d => d.profit >= 0 ? 'rgba(16,185,129,0.8)' : 'rgba(239,68,68,0.8)')
    }],
    horizontal: true,
    onClickItem: (_label, idx) => {
      const d = sorted[idx];
      drillDownModal(
        `${d.prop.name} — Operating Profit`,
        mixedRows(d.propPayments, d.propOpExpenses),
        MIXED_DRILL_COLS
      );
    }
  });
}

// ── Chart 2: Grouped bar — Month × (Revenue, Expenses) ───────────────────────
function renderMonthBar({ payments, opExpenses }, monthKeys) {
  if (!monthKeys.length) return;

  const revByMonth = new Map();
  const expByMonth = new Map();
  payments  .forEach(p => { const mk = p.date?.slice(0, 7); if (mk) revByMonth.set(mk, (revByMonth.get(mk) || 0) + toEUR(p.amount, p.currency, p.date)); });
  opExpenses.forEach(e => { const mk = e.date?.slice(0, 7); if (mk) expByMonth.set(mk, (expByMonth.get(mk) || 0) + toEUR(e.amount, e.currency, e.date)); });

  if (!monthKeys.some(m => revByMonth.has(m.key) || expByMonth.has(m.key))) return;

  charts.bar('prop-month-bar', {
    labels: monthKeys.map(m => m.label),
    datasets: [
      {
        label:           'Revenue',
        data:            monthKeys.map(m => Math.round(revByMonth.get(m.key) || 0)),
        backgroundColor: 'rgba(99,102,241,0.8)'
      },
      {
        label:           'Operating Expenses',
        data:            monthKeys.map(m => Math.round(expByMonth.get(m.key) || 0)),
        backgroundColor: 'rgba(239,68,68,0.8)'
      }
    ],
    stacked: false,
    onClickItem: (label, idx) => {
      const mk   = monthKeys[idx]?.key;
      if (!mk) return;
      const mPay = payments  .filter(p => p.date?.slice(0, 7) === mk);
      const mExp = opExpenses.filter(e => e.date?.slice(0, 7) === mk);
      drillDownModal(`${label} — Revenue & Expenses`, mixedRows(mPay, mExp), MIXED_DRILL_COLS);
    }
  });
}

// ── Chart 3: Donut — Revenue share per property ───────────────────────────────
function renderRevDonut({ propData }) {
  const withRev = propData.filter(d => d.rev > 0);
  if (!withRev.length) return;

  const PALETTE = ['#6366f1','#8b5cf6','#14b8a6','#f59e0b','#ec4899','#3b82f6','#10b981','#ef4444','#06b6d4','#84cc16'];
  charts.doughnut('prop-rev-donut', {
    labels: withRev.map(d => d.prop.name),
    data:   withRev.map(d => Math.round(d.rev)),
    colors: withRev.map((_, i) => PALETTE[i % PALETTE.length]),
    onClickItem: (_label, idx) => {
      const d = withRev[idx];
      drillDownModal(`Revenue — ${d.prop.name}`, toRevDrillRows(d.propPayments), REV_DRILL_COLS);
    }
  });
}

// ── Chart 4: Stacked hbar — Total investment by property ─────────────────────
function renderValueHBar({ propData }) {
  const sorted = [...propData]
    .filter(d => d.totalInvested > 0)
    .sort((a, b) => b.totalInvested - a.totalInvested);
  if (!sorted.length) return;

  charts.bar('prop-value-hbar', {
    labels: sorted.map(d => d.prop.name),
    datasets: [
      {
        label:           'Purchase Price',
        data:            sorted.map(d => Math.round(d.purchaseEUR)),
        backgroundColor: 'rgba(99,102,241,0.8)'
      },
      {
        label:           'All-Time CapEx',
        data:            sorted.map(d => Math.round(d.allTimeCapEx)),
        backgroundColor: 'rgba(245,158,11,0.8)'
      }
    ],
    stacked:    true,
    horizontal: true,
    onClickItem: (_label, idx) => {
      const d = sorted[idx];
      drillDownModal(`Investment — ${d.prop.name}`, toPropValueRows([d]), PROP_VALUE_COLS);
    }
  });
}

// ── Chart 5: Donut — Invested capital by owner ────────────────────────────────
function renderValueOwnerDonut({ propData }) {
  const byOwner = new Map();
  propData.forEach(d => {
    if (d.totalInvested <= 0) return;
    const label = OWNERS[d.prop.owner] || d.prop.owner || 'Unknown';
    byOwner.set(label, (byOwner.get(label) || 0) + d.totalInvested);
  });
  const entries = [...byOwner.entries()];
  if (!entries.length) return;

  const PALETTE = ['#6366f1', '#14b8a6', '#f59e0b', '#ec4899', '#3b82f6'];
  charts.doughnut('prop-value-owner-donut', {
    labels: entries.map(([k]) => k),
    data:   entries.map(([, v]) => Math.round(v)),
    colors: entries.map((_, i) => PALETTE[i % PALETTE.length]),
    onClickItem: (_label, idx) => {
      const [ownerLabel] = entries[idx];
      const ownProps = propData.filter(d =>
        (OWNERS[d.prop.owner] || d.prop.owner || 'Unknown') === ownerLabel
      );
      drillDownModal(`Invested Capital — ${ownerLabel}`, toPropValueRows(ownProps), PROP_VALUE_COLS);
    }
  });
}

// ── Chart 6: Donut — Invested capital by stream ───────────────────────────────
function renderValueStreamDonut({ propData }) {
  const byStream = new Map();
  propData.forEach(d => {
    if (d.totalInvested <= 0) return;
    const sk    = propStream(d.prop);
    const label = STREAMS[sk]?.short || sk;
    byStream.set(label, (byStream.get(label) || 0) + d.totalInvested);
  });
  const entries = [...byStream.entries()];
  if (!entries.length) return;

  const PALETTE = ['#6366f1', '#14b8a6', '#f59e0b', '#ec4899'];
  charts.doughnut('prop-value-stream-donut', {
    labels: entries.map(([k]) => k),
    data:   entries.map(([, v]) => Math.round(v)),
    colors: entries.map((_, i) => PALETTE[i % PALETTE.length]),
    onClickItem: (_label, idx) => {
      const [streamLabel] = entries[idx];
      const ownProps = propData.filter(d =>
        (STREAMS[propStream(d.prop)]?.short || propStream(d.prop)) === streamLabel
      );
      drillDownModal(`Invested Capital — ${streamLabel}`, toPropValueRows(ownProps), PROP_VALUE_COLS);
    }
  });
}

// ── Property comparison section ───────────────────────────────────────────────
function buildComparisonSection({ propData, avgROI, best, worst }) {
  if (!best) return null;
  const section = el('div', { class: 'card mb-16' });
  section.appendChild(el('div', { class: 'card-header' },
    el('div', { class: 'card-title' }, 'Property Comparison'),
    el('div', { style: 'font-size:12px;color:var(--text-muted)' }, 'Click tiles for transactions')
  ));
  const grid = el('div', { style: 'display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;padding:16px' });
  grid.appendChild(comparisonTile('Best Performer', best, 'var(--success)'));
  grid.appendChild(portfolioAvgTile(propData, avgROI));
  if (worst && worst !== best) {
    grid.appendChild(comparisonTile('Weakest Performer', worst, 'var(--danger)'));
  }
  section.appendChild(grid);
  return section;
}

function comparisonTile(title, d, accentColor) {
  const costRatio = d.rev > 0 ? (d.opEx / d.rev * 100) : null;
  const tile = el('div', {
    style: `background:var(--bg-elev-1);border-radius:var(--radius-sm);padding:14px;border-left:3px solid ${accentColor};cursor:pointer`,
    title: 'Click for transactions'
  });
  tile.onclick = () => drillDownModal(
    `${d.prop.name} — All Transactions`,
    mixedRows(d.propPayments, [...d.propOpExpenses, ...d.propCapExpenses]),
    MIXED_DRILL_COLS
  );
  tile.appendChild(el('div', { style: 'font-size:11px;color:var(--text-muted);margin-bottom:4px;text-transform:uppercase;letter-spacing:0.5px' }, title));
  tile.appendChild(el('div', { style: 'font-size:15px;font-weight:700;margin-bottom:8px;color:var(--text)' }, d.prop.name));
  [
    ['Revenue',        formatEUR(d.rev)],
    ['Expenses',       formatEUR(d.opEx)],
    ['Operating Profit', formatEUR(d.profit)],
    ['Simple ROI',     d.simpleROI != null ? d.simpleROI.toFixed(1) + '%' : '—'],
    ['Cost Ratio',     costRatio != null ? costRatio.toFixed(0) + '%' : '—']
  ].forEach(([label, value]) => {
    tile.appendChild(el('div', { style: 'display:flex;justify-content:space-between;font-size:12px;padding:2px 0;border-bottom:1px solid var(--border)' },
      el('span', { style: 'color:var(--text-muted)' }, label),
      el('span', { style: 'font-weight:600' }, value)
    ));
  });
  return tile;
}

function portfolioAvgTile(propData, avgROI) {
  const n         = propData.length;
  const avgRev    = n > 0 ? propData.reduce((s, d) => s + d.rev,    0) / n : 0;
  const avgOpEx   = n > 0 ? propData.reduce((s, d) => s + d.opEx,   0) / n : 0;
  const avgProfit = n > 0 ? propData.reduce((s, d) => s + d.profit, 0) / n : 0;
  const avgCostRatio = avgRev > 0 ? (avgOpEx / avgRev * 100) : null;
  const tile = el('div', {
    style: 'background:var(--bg-elev-1);border-radius:var(--radius-sm);padding:14px;border-left:3px solid var(--accent);cursor:pointer',
    title: 'Click for ROI overview'
  });
  tile.onclick = () => drillDownModal('Portfolio ROI Overview', toROIDrillRows(propData), ROI_DRILL_COLS);
  tile.appendChild(el('div', { style: 'font-size:11px;color:var(--text-muted);margin-bottom:4px;text-transform:uppercase;letter-spacing:0.5px' }, 'Portfolio Average'));
  tile.appendChild(el('div', { style: 'font-size:15px;font-weight:700;margin-bottom:8px;color:var(--text)' },
    `${n} Propert${n === 1 ? 'y' : 'ies'}`
  ));
  [
    ['Avg Revenue',     formatEUR(avgRev)],
    ['Avg Expenses',    formatEUR(avgOpEx)],
    ['Avg Op. Profit',  formatEUR(avgProfit)],
    ['Avg Simple ROI',  avgROI != null ? avgROI.toFixed(1) + '%' : '—'],
    ['Avg Cost Ratio',  avgCostRatio != null ? avgCostRatio.toFixed(0) + '%' : '—']
  ].forEach(([label, value]) => {
    tile.appendChild(el('div', { style: 'display:flex;justify-content:space-between;font-size:12px;padding:2px 0;border-bottom:1px solid var(--border)' },
      el('span', { style: 'color:var(--text-muted)' }, label),
      el('span', { style: 'font-weight:600' }, value)
    ));
  });
  return tile;
}

// ── Chart 7: Bar — Acquisitions per month ────────────────────────────────────
function renderAcqBar({ timeline }) {
  const active = timeline.filter(t => t.count > 0);
  if (!active.length) return;

  charts.bar('prop-acq-bar', {
    labels: active.map(t => t.label),
    datasets: [{
      label:           'Properties Acquired',
      data:            active.map(t => t.count),
      backgroundColor: 'rgba(99,102,241,0.8)'
    }],
    onClickItem: (_label, idx) => {
      const t = active[idx];
      drillDownModal(`Acquisitions — ${t.label}`, toPropAcqRows(t.props), PROP_ACQ_COLS);
    }
  });
}

// ── Chart 8: Line — Cumulative portfolio growth ───────────────────────────────
function renderGrowthLine({ timeline }) {
  if (!timeline.length) return;

  charts.line('prop-growth-line', {
    labels: timeline.map(t => t.label),
    datasets: [{
      label:           'Total Properties',
      data:            timeline.map(t => t.cumCount),
      borderColor:     '#6366f1',
      backgroundColor: 'rgba(99,102,241,0.1)',
      fill:            true
    }],
    onClickItem: (_label, idx) => {
      const propsUpTo = timeline.slice(0, idx + 1).flatMap(t => t.props);
      drillDownModal(`Portfolio as of ${timeline[idx].label}`, toPropAcqRows(propsUpTo), PROP_ACQ_COLS);
    }
  });
}

// ── Chart 9: Line — Cumulative capital deployed ───────────────────────────────
function renderCapitalLine({ timeline }) {
  if (!timeline.length) return;

  charts.line('prop-capital-line', {
    labels: timeline.map(t => t.label),
    datasets: [{
      label:           'Capital Deployed (EUR)',
      data:            timeline.map(t => Math.round(t.cumCapital)),
      borderColor:     '#f59e0b',
      backgroundColor: 'rgba(245,158,11,0.1)',
      fill:            true
    }],
    onClickItem: (_label, idx) => {
      const t = timeline[idx];
      if (!t.capital) return;
      drillDownModal(
        `Capital Events — ${t.label}`,
        toCapitalDrillRows(t.props, t.capExItems),
        CAPITAL_DRILL_COLS
      );
    }
  });
}

// ── Financing & Payoff section ────────────────────────────────────────────────
function buildFinancingSection(finData) {
  const t        = finData.totals;
  const active   = finData.finData.filter(d => d.financed && !d.paidOff);
  const section  = el('div', {});

  section.appendChild(el('div', { style: 'margin:28px 0 12px' },
    el('h3', { style: 'margin:0 0 4px;font-size:16px;font-weight:700' }, 'Financing & Payoff'),
    el('p',  { style: 'margin:0;font-size:12px;color:var(--text-muted)' },
      'Estimated mortgage positions using amortization formula. Values are approximations; ' +
      'requires Mortgage Amount, Monthly Payment, and Rate to be set on each property.'
    )
  ));

  const kpiRow = el('div', { class: 'grid grid-4 mb-16' });
  kpiRow.appendChild(kpiCard(
    'Total Outstanding Debt', formatEUR(t.totalDebt), '',
    () => drillDownModal('Debt by Property', toFinancingDrillRows(finData.finData), FINANCING_DRILL_COLS)
  ));
  kpiRow.appendChild(kpiCard(
    'Leverage Ratio',
    t.leverageRatio != null ? t.leverageRatio.toFixed(1) + '%' : '—',
    t.leverageRatio != null && t.leverageRatio > 60 ? 'danger' : t.leverageRatio != null && t.leverageRatio > 30 ? 'warning' : '',
    () => drillDownModal('Portfolio Leverage', toFinancingDrillRows(finData.finData), FINANCING_DRILL_COLS)
  ));
  kpiRow.appendChild(kpiCard(
    'Monthly Debt Burden', formatEUR(t.totalMonthly), '',
    () => drillDownModal('Active Mortgages', toFinancingDrillRows(active), FINANCING_DRILL_COLS)
  ));
  kpiRow.appendChild(kpiCard(
    'Avg Years to Payoff',
    t.avgYearsLeft != null ? t.avgYearsLeft.toFixed(1) + ' yrs' : '—', '',
    () => drillDownModal('Years to Payoff', toFinancingDrillRows(active), FINANCING_DRILL_COLS)
  ));
  section.appendChild(kpiRow);

  const statsWrap = el('div', { style: 'display:flex;gap:12px;flex-wrap:wrap;margin-bottom:16px' });
  [
    [String(t.nFinanced), 'Mortgaged Properties', `${t.nActive} active · ${t.nFinanced - t.nActive} paid off`],
    [String(t.nPaidOff),  'No Mortgage',          'Cash purchase or fully paid']
  ].forEach(([count, label, sub]) => {
    statsWrap.appendChild(el('div', {
      class: 'card',
      style: 'flex:1;min-width:160px;padding:12px 16px'
    },
      el('div', { style: 'font-size:22px;font-weight:700;line-height:1;margin-bottom:2px' }, count),
      el('div', { style: 'font-size:12px;font-weight:600' }, label),
      el('div', { style: 'font-size:11px;color:var(--text-muted);margin-top:2px' }, sub)
    ));
  });
  section.appendChild(statsWrap);

  const card = el('div', { class: 'card' });
  card.appendChild(el('div', { class: 'card-header' },
    el('div', { class: 'card-title' }, 'Property Financing Details'),
    el('div', { style: 'font-size:12px;color:var(--text-muted)' }, 'Click a row for mortgage breakdown')
  ));
  buildFinancingTable(card, finData.finData);
  section.appendChild(card);

  return section;
}

function buildFinancingTable(container, finData) {
  if (!finData.length) {
    container.appendChild(el('div', { class: 'empty' }, 'No properties match the selected filters'));
    return;
  }

  const COLS = [
    { key: 'name',      label: 'Property'   },
    { key: 'stream',    label: 'Stream'     },
    { key: 'owner',     label: 'Owner'      },
    { key: 'principal', label: 'Orig. Loan', right: true },
    { key: 'remaining', label: 'Remaining',  right: true },
    { key: 'monthly',   label: 'Monthly',    right: true },
    { key: 'rate',      label: 'Rate',        right: true },
    { key: 'yearsLeft', label: 'Yrs Left',   right: true },
    { key: 'dtv',       label: 'DTV %',       right: true },
    { key: 'status',    label: 'Status'      }
  ];

  const sorted = [...finData].sort((a, b) => b.remaining - a.remaining);

  const table = el('table', { class: 'table' });
  const htr   = el('tr');
  COLS.forEach(col => htr.appendChild(el('th', { class: col.right ? 'right' : '' }, col.label)));
  table.appendChild(el('thead', {}, htr));

  const tbody = el('tbody');
  for (const d of sorted) {
    const sm = STREAMS[propStream(d.prop)];
    const tr = el('tr', { style: 'cursor:pointer', title: 'Click for mortgage breakdown' });
    tr.onclick = () => drillDownModal(
      `${d.prop.name} — Mortgage Breakdown`,
      toMortgageDetailRows(d),
      MORTGAGE_DETAIL_COLS
    );
    COLS.forEach(col => {
      const td = el('td', { class: col.right ? 'right num' : '' });
      switch (col.key) {
        case 'name':
          td.textContent = d.prop.name;
          break;
        case 'stream':
          td.appendChild(el('span', { class: `badge ${sm?.css || ''}` }, sm?.short || propStream(d.prop)));
          break;
        case 'owner':
          td.textContent = OWNERS[d.prop.owner] || d.prop.owner || '—';
          break;
        case 'principal':
          td.textContent = d.financed ? formatEUR(d.principalEUR) : '—';
          break;
        case 'remaining':
          if (!d.financed) { td.textContent = '—'; break; }
          td.textContent = formatEUR(d.remaining);
          td.style.color = d.paidOff ? 'var(--success)' : '';
          break;
        case 'monthly':
          td.textContent = d.monthlyDebt ? formatEUR(d.monthlyDebt) : '—';
          break;
        case 'rate':
          td.textContent = d.prop.mortgageRate ? d.prop.mortgageRate + '%' : '—';
          break;
        case 'yearsLeft':
          if (!d.financed || d.paidOff) { td.textContent = d.paidOff ? '0' : '—'; break; }
          td.textContent = d.yearsLeft != null ? d.yearsLeft.toFixed(1) : 'N/A';
          if (d.yearsLeft != null && d.yearsLeft < 2) td.style.color = 'var(--success)';
          break;
        case 'dtv':
          td.textContent = d.dtvRatio != null ? d.dtvRatio.toFixed(0) + '%' : '—';
          if (d.dtvRatio != null && d.dtvRatio > 70) td.style.color = 'var(--danger)';
          break;
        case 'status': {
          const lbl = d.paidOff ? 'Paid Off' : d.financed ? 'Active' : 'None';
          const css = d.paidOff ? 'success' : d.financed ? 'warning' : '';
          td.appendChild(el('span', { class: `badge ${css}` }, lbl));
          break;
        }
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
}

// ── Summary table — one row per property ──────────────────────────────────────
function buildSummaryTable(container, propData) {
  if (propData.length === 0) {
    container.appendChild(el('div', { class: 'empty' }, 'No properties match the selected filters'));
    return;
  }

  const hasSimpleROI = propData.some(d => d.simpleROI      !== null);
  const hasAnnROI    = propData.some(d => d.annualizedROI   !== null);
  const hasCoCROI    = propData.some(d => d.cashOnCashROI   !== null);

  const COLS = [
    { key: 'name',      label: 'Property'          },
    { key: 'stream',    label: 'Stream'            },
    { key: 'owner',     label: 'Owner'             },
    { key: 'status',    label: 'Status'            },
    { key: 'rev',       label: 'Revenue',           right: true, fmt: formatEUR },
    { key: 'opEx',      label: 'Operating Exp.',    right: true, fmt: formatEUR },
    { key: 'profit',    label: 'Op. Profit',        right: true, fmt: formatEUR, colored: true },
    { key: 'capEx',     label: 'CapEx',             right: true, fmt: formatEUR },
    { key: 'net',       label: 'Net (after CapEx)', right: true, fmt: formatEUR, colored: true },
    { key: 'costRatio', label: 'Cost %',            right: true, fmt: v => v != null ? v.toFixed(0) + '%' : '—' },
    ...(hasSimpleROI ? [{ key: 'simpleROI',    label: 'Simple ROI', right: true, colored: true, fmt: v => v != null ? v.toFixed(1) + '%' : '—' }] : []),
    ...(hasAnnROI    ? [{ key: 'annualizedROI', label: 'Ann. ROI',  right: true, colored: true, fmt: v => v != null ? v.toFixed(1) + '%' : '—' }] : []),
    ...(hasCoCROI    ? [{ key: 'cashOnCashROI', label: 'CoC ROI',   right: true, colored: true, fmt: v => v != null ? v.toFixed(1) + '%' : '—' }] : [])
  ];

  const sorted = [...propData]
    .map(d => ({ ...d, costRatio: d.rev > 0 ? (d.opEx / d.rev) * 100 : null }))
    .sort((a, b) => b.profit - a.profit);

  const table = el('table', { class: 'table' });
  const htr   = el('tr');
  COLS.forEach(col => htr.appendChild(el('th', { class: col.right ? 'right' : '' }, col.label)));
  table.appendChild(el('thead', {}, htr));

  const tbody = el('tbody');
  for (const d of sorted) {
    const sm = STREAMS[propStream(d.prop)];
    const tr = el('tr', { style: 'cursor:pointer', title: 'Click for transactions' });
    tr.onclick = () => drillDownModal(
      `${d.prop.name} — All Transactions`,
      mixedRows(d.propPayments, [...d.propOpExpenses, ...d.propCapExpenses]),
      MIXED_DRILL_COLS
    );
    COLS.forEach(col => {
      const td = el('td', { class: col.right ? 'right num' : '' });
      if (col.key === 'name') {
        td.textContent = d.prop.name;
      } else if (col.key === 'stream') {
        td.appendChild(el('span', { class: `badge ${sm?.css || ''}` }, sm?.short || propStream(d.prop)));
      } else if (col.key === 'owner') {
        td.textContent = OWNERS[d.prop.owner] || d.prop.owner || '—';
      } else if (col.key === 'status') {
        const st  = d.prop.status || 'active';
        const def = PROPERTY_STATUSES[st] || { label: st, css: '' };
        td.appendChild(el('span', { class: `badge ${def.css}` }, def.label));
      } else if (col.colored) {
        const v = d[col.key];
        if (v != null) td.style.color = v >= 0 ? 'var(--success)' : 'var(--danger)';
        td.textContent = col.fmt(v);
      } else {
        td.textContent = col.fmt(d[col.key]);
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
}
