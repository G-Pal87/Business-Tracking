// Property Performance Analytics Dashboard
import { el, buildMultiSelect, button, fmtDate, drillDownModal, attachSortFilter } from '../core/ui.js';
import * as charts from '../core/charts.js';
import { STREAMS, OWNERS, PROPERTY_STREAMS } from '../core/config.js';
import {
  availableYears, formatEUR, toEUR, byId,
  listActive, listActivePayments, listActiveProperties,
  isCapEx,
  simplePropertyROI, annualizedPropertyROI, cashOnCashPropertyROI
} from '../core/data.js';

// ── Filter state ──────────────────────────────────────────────────────────────
let gFilters = {
  years:       new Set([String(new Date().getFullYear())]),
  months:      new Set(),
  propertyIds: new Set(),
  streams:     new Set(),
  owners:      new Set()
};

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

// ── Filtering ─────────────────────────────────────────────────────────────────
function matchDate(row) {
  const d = row.date || '';
  if (gFilters.years.size > 0 && !gFilters.years.has(d.slice(0, 4))) return false;
  if (gFilters.months.size > 0 && !gFilters.months.has(d.slice(5, 7))) return false;
  return true;
}
function matchOwner(prop) {
  if (gFilters.owners.size === 0) return true;
  return prop.owner === 'both' || gFilters.owners.has(prop.owner);
}
function matchPropStream(prop) {
  if (gFilters.streams.size === 0) return true;
  return gFilters.streams.has(propStream(prop));
}
function matchPropId(prop) {
  return gFilters.propertyIds.size === 0 || gFilters.propertyIds.has(prop.id);
}

// ── Data aggregation ──────────────────────────────────────────────────────────
function getData() {
  const allProps = listActiveProperties().filter(p =>
    matchOwner(p) && matchPropStream(p) && matchPropId(p)
  );
  const propIds = new Set(allProps.map(p => p.id));

  const payments    = listActivePayments().filter(p =>
    p.status === 'paid' && matchDate(p) && propIds.has(p.propertyId)
  );
  const opExpenses  = listActive('expenses').filter(e =>
    !isCapEx(e) && matchDate(e) && propIds.has(e.propertyId)
  );
  const capExpenses = listActive('expenses').filter(e =>
    isCapEx(e) && matchDate(e) && propIds.has(e.propertyId)
  );
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

  const active = [...propData]
    .filter(d => d.rev > 0 || d.opEx > 0)
    .sort((a, b) => {
      if (a.simpleROI !== null && b.simpleROI !== null) return b.simpleROI - a.simpleROI;
      if (a.simpleROI !== null) return -1;
      if (b.simpleROI !== null) return 1;
      return b.profit - a.profit;
    });
  const best  = active.length > 0 ? active[0] : null;
  const worst = active.length > 1 ? active[active.length - 1] : null;

  return { allProps, propData, payments, opExpenses, capExpenses, totals, avgROI, best, worst };
}

// ── Valid filter options (leave-one-out faceting) ─────────────────────────────
function getValidOpts() {
  const allProps = listActiveProperties();
  const pays     = listActivePayments().filter(p => p.status === 'paid');
  const exps     = listActive('expenses');
  const vY = new Set(), vSt = new Set(), vPi = new Set(), vOw = new Set();
  const psk = p => p.type === 'short_term' ? 'short_term_rental' : p.type === 'long_term' ? 'long_term_rental' : 'other';
  const yrOk = yr => !gFilters.years.size       || gFilters.years.has(yr);
  const stOk = st => !gFilters.streams.size     || gFilters.streams.has(st);
  const owOk = ow => !gFilters.owners.size      || ow === 'both' || gFilters.owners.has(ow);
  const piOk = pi => !gFilters.propertyIds.size || gFilters.propertyIds.has(pi);
  const addOw = ow => { if (ow === 'both') { vOw.add('you'); vOw.add('rita'); vOw.add('both'); } else if (ow) vOw.add(ow); };
  for (const p of allProps) {
    const st = psk(p), ow = p.owner || 'both', pi = p.id;
    if (stOk(st) && owOk(ow)) vPi.add(pi);
    if (piOk(pi) && owOk(ow)) vSt.add(st);
    if (piOk(pi) && stOk(st)) addOw(ow);
  }
  const scanDate = (date, propId) => {
    if (!propId) return;
    const prop = byId('properties', propId);
    if (!prop) return;
    const yr = (date || '').slice(0, 4);
    if (yr && stOk(psk(prop)) && owOk(prop.owner || 'both') && piOk(propId)) vY.add(yr);
  };
  pays.forEach(p => scanDate(p.date, p.propertyId));
  exps.forEach(e => scanDate(e.date, e.propertyId));
  return { vY, vSt, vPi, vOw };
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
  { key: 'reno',     label: 'All-time CapEx',  right: true, format: v => formatEUR(v) },
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
  { key: 'net',      label: 'Net Profit', right: true, format: v => formatEUR(v) },
  { key: 'invested', label: 'Invested',   right: true, format: v => formatEUR(v) },
  { key: 'roi',      label: 'ROI %',      right: true, format: v => v != null ? v.toFixed(1) + '%' : '—' },
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

// Accepts the already-filtered allProps list from getData() to avoid re-filtering.
// Ignores gFilters.year / gFilters.months — acquisition is always plotted across all time.
function getAcquisitionData(allProps) {
  const propIds    = new Set(allProps.map(p => p.id));
  const allCapEx   = listActive('expenses').filter(e => isCapEx(e) && propIds.has(e.propertyId));
  const withDate   = allProps.filter(p => p.purchaseDate);
  const withoutDate = allProps.filter(p => !p.purchaseDate);

  // Build per-month buckets for acquisitions
  const bucketMap = new Map(); // 'YYYY-MM' → { count, props[] }
  withDate.forEach(p => {
    const mk = p.purchaseDate.slice(0, 7);
    if (!bucketMap.has(mk)) bucketMap.set(mk, { count: 0, props: [] });
    const b = bucketMap.get(mk);
    b.count++;
    b.props.push(p);
  });

  // Capital events map: purchase prices + CapEx per month
  const capitalMap = new Map(); // 'YYYY-MM' → { purchaseEUR, capExEUR, capExItems[] }
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

  // All months in chronological order (union of both maps)
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
      props:       b ? b.props : [],      // properties acquired this month
      capExItems:  c.capExItems           // CapEx expenses this month
    };
  });

  return { timeline, withoutDate };
}

// Drill-down: properties acquired in a given period
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

// Drill-down: capital events (purchases + CapEx) for a given month
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
// Uses standard amortization: B = P(1+r)^n − PMT·((1+r)^n − 1)/r
// Falls back to simple subtraction when rate = 0.
// Returns null for yearsLeft / dtvRatio when inputs are insufficient.
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
  const r            = (prop.mortgageRate || 0) / 100 / 12; // monthly rate

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

// Drill-down rows for KPI modals
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

// Per-property amortization detail for row click modal
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

// ── Inline insights ───────────────────────────────────────────────────────────
function buildInsightsBanner(insights) {
  if (!insights.length) return null;
  const wrap = el('div', { style: 'display:flex;flex-direction:column;gap:8px;margin-bottom:16px' });
  const STYLES = {
    danger:  { bg: 'rgba(239,68,68,0.08)',  border: '#ef4444', icon: '⚠' },
    warning: { bg: 'rgba(245,158,11,0.08)', border: '#f59e0b', icon: '⚡' },
    info:    { bg: 'rgba(99,102,241,0.08)', border: '#6366f1', icon: 'ℹ' }
  };
  for (const { level, text } of insights) {
    const s = STYLES[level] || STYLES.info;
    wrap.appendChild(el('div', {
      style: `display:flex;align-items:flex-start;gap:10px;padding:10px 14px;background:${s.bg};border-left:3px solid ${s.border};border-radius:0 var(--radius-sm) var(--radius-sm) 0;font-size:13px`
    },
      el('span', { style: `color:${s.border};flex-shrink:0` }, s.icon),
      el('span', { style: 'color:var(--text);line-height:1.4' }, text)
    ));
  }
  return wrap;
}

function computePropertyInsights({ totals, propData, avgROI, best, worst }) {
  const items = [];
  if (totals.rev === 0 && totals.opEx === 0) {
    items.push({ level: 'info', text: 'No revenue or expenses recorded for the selected period and filters.' });
    return items;
  }
  if (totals.profit < 0) {
    items.push({ level: 'danger', text: `Portfolio is operating at a loss: ${formatEUR(totals.profit)} net operating profit for the period.` });
  }
  if (totals.rev > 0 && totals.opEx / totals.rev > 0.80) {
    const pct = Math.round(totals.opEx / totals.rev * 100);
    items.push({ level: 'warning', text: `Operating expense ratio is ${pct}% — high relative to revenue. Consider reviewing recurring costs.` });
  }
  if (avgROI !== null && avgROI < 0) {
    items.push({ level: 'danger', text: `Portfolio average ROI is negative (${avgROI.toFixed(1)}%). Net losses exceed investment value.` });
  } else if (worst && avgROI !== null && worst.simpleROI !== null && worst.simpleROI < avgROI - 15) {
    items.push({ level: 'warning', text: `"${worst.prop.name}" has ROI of ${worst.simpleROI.toFixed(1)}% vs portfolio average ${avgROI.toFixed(1)}% — underperforming by more than 15 pp.` });
  }
  if (totals.net < 0 && totals.capEx > 0) {
    items.push({ level: 'info', text: `Net income is negative after CapEx (${formatEUR(totals.net)}). This may reflect an active renovation period.` });
  }
  return items;
}



// ── KPI card ──────────────────────────────────────────────────────────────────
function kpiCard(label, value, variant, onClick) {
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
  card.appendChild(el('div', { class: 'kpi-accent-bar' }));
  return card;
}

// ── Month key helper ──────────────────────────────────────────────────────────
function getMonthKeys() {
  const selectedYears = gFilters.years.size > 0 ? [...gFilters.years].sort() : availableYears();
  if (selectedYears.length === 1) {
    const year = selectedYears[0];
    return MONTH_LABELS.map((label, i) => {
      const mm = String(i + 1).padStart(2, '0');
      return { label, key: `${year}-${mm}`, mm };
    }).filter(m => gFilters.months.size === 0 || gFilters.months.has(m.mm));
  }
  const keys = [];
  for (const year of selectedYears) {
    MONTH_LABELS.forEach((label, i) => {
      const mm = String(i + 1).padStart(2, '0');
      if (gFilters.months.size === 0 || gFilters.months.has(mm)) {
        keys.push({ label: `${label} '${year.slice(2)}`, key: `${year}-${mm}`, mm });
      }
    });
  }
  return keys;
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

  // Filter bar
  const opts = getValidOpts();
  const trim = (set, valid) => { if (valid.size) for (const v of [...set]) if (!valid.has(v)) set.delete(v); };
  trim(gFilters.years, opts.vY); trim(gFilters.streams, opts.vSt);
  trim(gFilters.propertyIds, opts.vPi); trim(gFilters.owners, opts.vOw);
  const yearMS   = buildMultiSelect(availableYears().filter(y => !opts.vY.size || opts.vY.has(y)).map(y => ({ value: y, label: y })), gFilters.years, 'All Years', rebuildView, 'prop_years');
  const monthMS  = buildMultiSelect(MONTH_LABELS.map((m, i) => ({ value: String(i + 1).padStart(2, '0'), label: m })), gFilters.months, 'All Months', rebuildView, 'prop_months');
  const propMS   = buildMultiSelect(listActiveProperties().filter(p => !opts.vPi.size || opts.vPi.has(p.id)).map(p => ({ value: p.id, label: p.name })), gFilters.propertyIds, 'All Properties', rebuildView, 'prop_props');
  const streamMS = buildMultiSelect(PROPERTY_STREAMS.filter(k => !opts.vSt.size || opts.vSt.has(k)).map(k => ({ value: k, label: STREAMS[k].label, color: STREAMS[k].color })), gFilters.streams, 'All Streams', rebuildView, 'prop_streams');
  const ownerMS  = buildMultiSelect(Object.entries(OWNERS).filter(([k]) => !opts.vOw.size || opts.vOw.has(k)).map(([k, v]) => ({ value: k, label: v })), gFilters.owners, 'All Owners', rebuildView, 'prop_owners');

  const filterBar = el('div', { class: 'flex gap-8 mb-16', style: 'flex-wrap:wrap;align-items:center' });
  filterBar.appendChild(el('span', { style: 'font-size:12px;color:var(--text-muted);align-self:center' }, 'Filters:'));
  filterBar.appendChild(yearMS);
  filterBar.appendChild(monthMS);
  filterBar.appendChild(propMS);
  filterBar.appendChild(streamMS);
  filterBar.appendChild(ownerMS);
  filterBar.appendChild(button('Reset Filters', { variant: 'sm ghost', onClick: () => { yearMS.reset(); monthMS.reset(); propMS.reset(); streamMS.reset(); ownerMS.reset(); rebuildView(); } }));
  wrap.appendChild(filterBar);

  // Data
  const data = getData();
  const { allProps, propData, payments, opExpenses, capExpenses, totals, avgROI, best, worst } = data;

  // ── Investment KPI row ─────────────────────────────────────────────────────
  const invKpiRow = el('div', { class: 'grid grid-4 mb-16' });
  invKpiRow.appendChild(kpiCard(
    'Total Properties', String(allProps.length), '',
    () => drillDownModal('Portfolio Properties', toPropValueRows(propData), PROP_VALUE_COLS)
  ));
  invKpiRow.appendChild(kpiCard(
    'Portfolio Value', formatEUR(totals.purchaseValue), '',
    () => drillDownModal('Portfolio Value by Property', toPropValueRows(propData), PROP_VALUE_COLS)
  ));
  invKpiRow.appendChild(kpiCard(
    'Total Invested', formatEUR(totals.totalInvested), '',
    () => drillDownModal('Total Invested Capital', toPropValueRows(propData), PROP_VALUE_COLS)
  ));
  invKpiRow.appendChild(kpiCard(
    'Average ROI', avgROI != null ? avgROI.toFixed(1) + '%' : '—',
    avgROI != null ? (avgROI >= 0 ? 'success' : 'danger') : '',
    () => drillDownModal('Property ROI Overview', toROIDrillRows(propData), ROI_DRILL_COLS)
  ));
  wrap.appendChild(invKpiRow);

  // ── Period KPI row ─────────────────────────────────────────────────────────
  const kpiRow = el('div', { class: 'grid grid-4 mb-16' });
  kpiRow.appendChild(kpiCard(
    'Total Revenue', formatEUR(totals.rev), '',
    () => drillDownModal('Revenue — All Properties', toRevDrillRows(payments), REV_DRILL_COLS)
  ));
  kpiRow.appendChild(kpiCard(
    'Operating Expenses', formatEUR(totals.opEx), '',
    () => drillDownModal('Operating Expenses — All Properties', toExpDrillRows(opExpenses), EXP_DRILL_COLS)
  ));
  kpiRow.appendChild(kpiCard(
    'Operating Profit', formatEUR(totals.profit),
    totals.profit >= 0 ? 'success' : 'danger',
    () => drillDownModal('Operating Profit Breakdown',
      mixedRows(payments, opExpenses),
      MIXED_DRILL_COLS
    )
  ));
  kpiRow.appendChild(kpiCard(
    'Renovation CapEx', formatEUR(totals.capEx),
    totals.capEx > 0 ? 'warning' : '',
    () => drillDownModal('Renovation CapEx — All Properties', toExpDrillRows(capExpenses), EXP_DRILL_COLS)
  ));
  wrap.appendChild(kpiRow);

  // Inline insights
  const propInsights = computePropertyInsights(data);
  const propBanner = buildInsightsBanner(propInsights);
  if (propBanner) wrap.appendChild(propBanner);

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

  // ── Chart row 2: monthly grouped bar (full width) ─────────────────────────
  wrap.appendChild(el('div', { class: 'card mb-16' },
    el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'Monthly Revenue vs Operating Expenses')),
    el('div', { class: 'chart-wrap' }, el('canvas', { id: 'prop-month-bar' }))
  ));

  // ── Portfolio value breakdown ──────────────────────────────────────────────
  wrap.appendChild(el('div', { class: 'card mb-16' },
    el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'Investment by Property (Purchase + Renovation CapEx)')),
    el('div', { class: 'chart-wrap tall' }, el('canvas', { id: 'prop-value-hbar' }))
  ));
  const valueRow = el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px' });
  valueRow.appendChild(el('div', { class: 'card' },
    el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'Portfolio Value by Owner')),
    el('div', { class: 'chart-wrap' }, el('canvas', { id: 'prop-value-owner-donut' }))
  ));
  valueRow.appendChild(el('div', { class: 'card' },
    el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'Portfolio Value by Stream')),
    el('div', { class: 'chart-wrap' }, el('canvas', { id: 'prop-value-stream-donut' }))
  ));
  wrap.appendChild(valueRow);

  // ── Property comparison ────────────────────────────────────────────────────
  const compSection = buildComparisonSection({ propData, avgROI, best, worst });
  if (compSection) wrap.appendChild(compSection);

  // ── Summary table ──────────────────────────────────────────────────────────
  const tableCard = el('div', { class: 'card' });
  tableCard.appendChild(el('div', { class: 'card-header' },
    el('div', { class: 'card-title' }, 'Property Summary'),
    el('div', { style: 'font-size:12px;color:var(--text-muted)' }, 'Click a row for transactions')
  ));
  buildSummaryTable(tableCard, propData);
  wrap.appendChild(tableCard);

  // ── Acquisition & Growth ───────────────────────────────────────────────────
  const acqData = getAcquisitionData(allProps);

  wrap.appendChild(el('div', { style: 'margin:28px 0 12px' },
    el('h3', { style: 'margin:0 0 4px;font-size:16px;font-weight:700' }, 'Portfolio Acquisition & Growth'),
    el('p',  { style: 'margin:0;font-size:12px;color:var(--text-muted)' },
      'Based on purchase dates. Property / Stream / Owner filters apply; Year / Month filter does not.' +
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
      el('div', { style: 'font-size:12px;color:var(--text-muted)' }, 'Purchase prices + Renovation CapEx')
    ),
    el('div', { class: 'chart-wrap' }, el('canvas', { id: 'prop-capital-line' }))
  ));
  wrap.appendChild(acqGrowthRow);

  // ── Financing & Payoff ─────────────────────────────────────────────────────
  wrap.appendChild(buildFinancingSection(getFinancingData(allProps)));

  setTimeout(() => {
    renderProfitHBar(data);
    renderRevDonut(data);
    renderMonthBar(data);
    renderValueHBar(data);
    renderValueOwnerDonut(data);
    renderValueStreamDonut(data);
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
function renderMonthBar({ payments, opExpenses }) {
  const months = getMonthKeys();
  if (!months.length) return;

  const revByMonth = new Map();
  const expByMonth = new Map();
  payments  .forEach(p => { const mk = p.date?.slice(0, 7); if (mk) revByMonth.set(mk, (revByMonth.get(mk) || 0) + toEUR(p.amount, p.currency, p.date)); });
  opExpenses.forEach(e => { const mk = e.date?.slice(0, 7); if (mk) expByMonth.set(mk, (expByMonth.get(mk) || 0) + toEUR(e.amount, e.currency, e.date)); });

  if (!months.some(m => revByMonth.has(m.key) || expByMonth.has(m.key))) return;

  charts.bar('prop-month-bar', {
    labels: months.map(m => m.label),
    datasets: [
      {
        label:           'Revenue',
        data:            months.map(m => Math.round(revByMonth.get(m.key) || 0)),
        backgroundColor: 'rgba(99,102,241,0.8)'
      },
      {
        label:           'Expenses (OpEx)',
        data:            months.map(m => Math.round(expByMonth.get(m.key) || 0)),
        backgroundColor: 'rgba(239,68,68,0.8)'
      }
    ],
    stacked: false,
    onClickItem: (label, idx) => {
      const mk   = months[idx]?.key;
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

// ── Chart 4: Stacked hbar — Investment by property ────────────────────────────
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
        label:           'Renovation CapEx',
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

// ── Chart 5: Donut — Portfolio value by owner ─────────────────────────────────
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
      drillDownModal(`Portfolio Value — ${ownerLabel}`, toPropValueRows(ownProps), PROP_VALUE_COLS);
    }
  });
}

// ── Chart 6: Donut — Portfolio value by stream ────────────────────────────────
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
      drillDownModal(`Portfolio Value — ${streamLabel}`, toPropValueRows(ownProps), PROP_VALUE_COLS);
    }
  });
}

// ── Property comparison section ───────────────────────────────────────────────
function buildComparisonSection({ propData, avgROI, best, worst }) {
  if (!best) return null;
  const section = el('div', { class: 'card mb-16' });
  section.appendChild(el('div', { class: 'card-header' },
    el('div', { class: 'card-title' }, 'Portfolio Comparison'),
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
    ['Revenue',    formatEUR(d.rev)],
    ['Expenses',   formatEUR(d.opEx)],
    ['Net Profit', formatEUR(d.profit)],
    ['ROI',        d.simpleROI != null ? d.simpleROI.toFixed(1) + '%' : '—'],
    ['Cost Ratio', costRatio != null ? costRatio.toFixed(0) + '%' : '—']
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
    ['Avg Revenue',    formatEUR(avgRev)],
    ['Avg Expenses',   formatEUR(avgOpEx)],
    ['Avg Net Profit', formatEUR(avgProfit)],
    ['Avg ROI',        avgROI != null ? avgROI.toFixed(1) + '%' : '—'],
    ['Avg Cost Ratio', avgCostRatio != null ? avgCostRatio.toFixed(0) + '%' : '—']
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

  // KPIs
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

  // Count summary
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

  // Table
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
    { key: 'name',      label: 'Property'   },
    { key: 'stream',    label: 'Stream'     },
    { key: 'owner',     label: 'Owner'      },
    { key: 'rev',       label: 'Revenue',    right: true, fmt: formatEUR },
    { key: 'opEx',      label: 'Expenses',   right: true, fmt: formatEUR },
    { key: 'profit',    label: 'Net Profit', right: true, fmt: formatEUR, colored: true },
    { key: 'capEx',     label: 'Reno CapEx', right: true, fmt: formatEUR },
    { key: 'net',       label: 'Net (all)',  right: true, fmt: formatEUR, colored: true },
    { key: 'costRatio', label: 'Cost %',     right: true, fmt: v => v != null ? v.toFixed(0) + '%' : '—' },
    ...(hasSimpleROI ? [{ key: 'simpleROI',    label: 'ROI %',    right: true, colored: true, fmt: v => v != null ? v.toFixed(1) + '%' : '—' }] : []),
    ...(hasAnnROI    ? [{ key: 'annualizedROI', label: 'Ann. ROI', right: true, colored: true, fmt: v => v != null ? v.toFixed(1) + '%' : '—' }] : []),
    ...(hasCoCROI    ? [{ key: 'cashOnCashROI', label: 'CoC ROI',  right: true, colored: true, fmt: v => v != null ? v.toFixed(1) + '%' : '—' }] : [])
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
