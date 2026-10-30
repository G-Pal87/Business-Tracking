// Property Performance Analytics Dashboard
import { el, buildMultiSelect, button, fmtDate, today, drillDownModal, attachSortFilter, openModal } from '../core/ui.js';
import { buildAttentionCard } from './attention.js';
import * as charts from '../core/charts.js';
import { STREAMS, OWNERS, PROPERTY_STREAMS, PROPERTY_STATUSES } from '../core/config.js';
import {
  formatEUR, formatMoney, toEUR, byId, getPersonName, getTenantDisplayStatus,
  listActive, listActivePayments, paymentsOfProperty, isCapEx, generatePaymentSchedule,
  simplePropertyROI, annualizedPropertyROI, cashOnCashPropertyROI, propertyValueMetrics, propertyValuations
} from '../core/data.js';
import { todayYmd, diffDaysYmd, addDaysYmd } from '../core/dates.js';
import { openDetail as openPropertyDetail } from './properties.js';
import { createFilterState, getCurrentPeriodRange, getComparisonRange, getMonthKeysForRange, makeMatchers, buildFilterBar, buildComparisonLine } from './analytics-filters.js';
import { mkSectionLabel, mkSummaryBox, mkModalTable, mkSummaryGrid, mkVarianceBadge, mkEmptyState, mkKpiCard, mkInsightsBanner, mkDashboardTabs, loadDashboardTab, memoView, safePct, mkTh, mkExplainButton, mkDrillValue, periodDays, DAYS_PER_YEAR, ownerShare } from './analytics-helpers.js';

// ── Filter state ──────────────────────────────────────────────────────────────
let gF = createFilterState();
let gScope = 'company'; // 'company' | 'all'
let gStatusFilter = new Set(); // 'active' | 'renovation' | 'vacant' | 'sold'
let gMvInterval = 'year'; // market value charts: 'year' (31 Dec) | 'half' (30 Jun + 31 Dec)

// Share of a property counted under the Owner filter: all of it with no owner
// (or every partner) selected; half of a shared ('both') property when one
// partner is selected, so the partners' figures add up to the portfolio
// instead of counting a shared property twice. Ratios (yield, ROI, gain %)
// are unaffected — both sides scale together.
function ownerWeight(prop) {
  if (!gF.owners.size) return 1;
  let w = 0;
  for (const o of gF.owners) w += ownerShare(prop?.owner || 'both', o);
  return Math.min(1, w);
}
const scaleBy = (obj, w, keys) => {
  if (w === 1 || !obj) return obj;
  const o = { ...obj };
  for (const k of keys) if (typeof o[k] === 'number') o[k] *= w;
  return o;
};
const MV_MONEY = ['valueEUR', 'purchaseEUR', 'capexEUR', 'investedEUR', 'gainEUR', 'netIncomeEUR', 'totalReturnEUR'];
const MORT_MONEY = ['principalEUR', 'remaining', 'monthlyDebt'];
// Value-type figures (units, market value, mortgage) are read as of the end of
// the selected period — today for a period that hasn't ended.
const asOfDate = range => (range?.end && range.end < todayYmd() ? range.end : todayYmd());
// Charts on the value tabs run over the selected period; "All Time" (null)
// keeps the whole history from the first purchase.
const windowFrom = range => (gF.period === 'all' ? null : range?.start || null);
const monthsBetween = (a, b) => (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + Number(b.slice(5, 7)) - Number(a.slice(5, 7)) + 1;
const monthEnd = ym => `${ym}-${String(new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0)).getUTCDate()).padStart(2, '0')}`;
const nextYm = ym => { const y = Number(ym.slice(0, 4)), m = Number(ym.slice(5, 7)); return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`; };
const ymLabel = ym => `${MONTH_LABELS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;

const MONTH_LABELS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const CHART_IDS    = ['prop-profit-hbar', 'prop-month-bar', 'prop-single-trend', 'prop-mv-line', 'prop-mv-by-prop', 'prop-invested-donut', 'prop-acq-bar'];

// Dashboard tabs; `scope` tells which filters apply to the tab's figures.
const PROP_TABS = [
  { id: 'overview',    label: 'Overview',          scope: 'Headline figures and alerts. Revenue, profit, yield and vacancy cover the selected period; market value and equity are as of its end (today for a current period); lease alerts look 90 days ahead from today. A shared property counts at 50% when one owner is selected.' },
  { id: 'performance', label: 'Performance',       scope: 'Everything on this tab follows the period and comparison filters.' },
  { id: 'value',       label: 'Portfolio & Value', scope: 'The portfolio as of the end of the selected period (today for a current period): units, purchase price, market value, gain and equity; the charts run up to that date. All filters apply. A shared property counts at 50% when one owner is selected.' },
  { id: 'financing',   label: 'Financing',         scope: 'Mortgage balances estimated as of the end of the selected period (today for a current period). All filters apply. A shared property counts at 50% when one owner is selected.' }
];
const PROP_TAB_KEY = 'btf:prop_dash_tab';
let gTab = loadDashboardTab(PROP_TAB_KEY, PROP_TABS);
let gInvestedSplit = 'owner'; // invested-capital donut: 'owner' | 'stream'

let _finSortCol = -1, _finSortDir = 1, _finSearch = '';
let _sumSortCol = -1, _sumSortDir = 1, _sumSearch = '';

// ── Module export ─────────────────────────────────────────────────────────────
export default {
  id:    'analytics-properties',
  label: 'Properties',
  icon:  '🏘️',
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

// ── Data aggregation ──────────────────────────────────────────────────────────
function getData(start, end, isIncomplete = false) {
  const { mOwner } = makeMatchers(gF);

  // Custom matchers for property objects (p.id / p.type, not p.propertyId / p.stream)
  const mPropStream = p => !gF.streams.size || gF.streams.has(propStream(p));
  const mPropId     = p => !gF.propertyIds.size || gF.propertyIds.has(p.id);
  const mStatus     = p => !gStatusFilter.size || gStatusFilter.has(p.status || 'active');

  const allProps = listActive('properties').filter(p =>
    mOwner(p) && mPropStream(p) && mPropId(p) && mStatus(p) &&
    (gScope === 'all' || (p.channel || 'company') === 'company')
  );
  const propIds = new Set(allProps.map(p => p.id));
  const wById = new Map(allProps.map(p => [p.id, ownerWeight(p)]));
  const share = r => { const w = wById.get(r.propertyId) ?? 1; return w === 1 ? r : { ...r, amount: (Number(r.amount) || 0) * w, _share: w }; };

  // Compare full dates, not month keys — comparing a 7-char "YYYY-MM" key
  // against the 10-char "YYYY-MM-DD" start/end boundaries meant a record
  // dated exactly in the period's start month always failed the `>= start`
  // check (a prefix string sorts before the longer string it's a prefix
  // of), silently dropping that entire month from every KPI/chart here.
  const matchDate = row => {
    const d = row.date || '';
    return d >= start && d <= end;
  };

  const payments    = listActivePayments().filter(p =>
    p.status === 'paid' && matchDate(p) && propIds.has(p.propertyId) &&
    (gScope === 'all' || !p.personal)
  ).map(share);
  // Same Company-scope rule as payments: a record individually flagged
  // `personal` is excluded unless the Scope is "All".
  const opExpenses  = listActive('expenses').filter(e =>
    !isCapEx(e) && matchDate(e) && propIds.has(e.propertyId) &&
    (gScope === 'all' || !e.personal)
  ).map(share);
  const capExpenses = listActive('expenses').filter(e =>
    isCapEx(e) && matchDate(e) && propIds.has(e.propertyId) &&
    (gScope === 'all' || !e.personal)
  ).map(share);
  // All-time CapEx is never filtered by current period date range
  const allCapExpenses = listActive('expenses').filter(e => isCapEx(e) && propIds.has(e.propertyId)).map(share);

  // Pre-build propertyId → records maps — eliminates O(n²) .filter() inside the property loop
  const payByProp     = new Map();
  const opExByProp    = new Map();
  const capExByProp   = new Map();
  const allCapExByProp = new Map();
  for (const p of payments)      { const a = payByProp.get(p.propertyId)      || []; a.push(p); payByProp.set(p.propertyId, a); }
  for (const e of opExpenses)    { const a = opExByProp.get(e.propertyId)     || []; a.push(e); opExByProp.set(e.propertyId, a); }
  for (const e of capExpenses)   { const a = capExByProp.get(e.propertyId)    || []; a.push(e); capExByProp.set(e.propertyId, a); }
  for (const e of allCapExpenses) { const a = allCapExByProp.get(e.propertyId) || []; a.push(e); allCapExByProp.set(e.propertyId, a); }

  // Lifetime (all-time, not period-scoped) operating net per property — the
  // input Annualized ROI needs: annualizedPropertyROI() divides a LIFETIME
  // return by years owned, so feeding it the period's already-annualized net
  // divided it by time twice.
  const lifetimeNetByProp = new Map();
  for (const p of listActivePayments()) {
    if (p.status !== 'paid' || !propIds.has(p.propertyId) || (gScope !== 'all' && p.personal)) continue;
    lifetimeNetByProp.set(p.propertyId, (lifetimeNetByProp.get(p.propertyId) || 0) + toEUR(p.amount, p.currency, p.date) * wById.get(p.propertyId));
  }
  for (const e of listActive('expenses')) {
    if (isCapEx(e) || !propIds.has(e.propertyId) || (gScope !== 'all' && e.personal)) continue;
    lifetimeNetByProp.set(e.propertyId, (lifetimeNetByProp.get(e.propertyId) || 0) - toEUR(e.amount, e.currency, e.date) * wById.get(e.propertyId));
  }

  // A period that hasn't started yet has no actual transactions at all, so
  // there's nothing to annualize/project from past performance — instead
  // "Expected Rev (booked)" sums what's already known: STR bookings already
  // on the books (typically 'pending' Airbnb reservations) and LT rent from
  // active leases, for each month in range.
  const isFuturePeriod = start > today();

  const propData = allProps.map(prop => {
    const propPay   = payByProp.get(prop.id)    || [];
    const propOpEx  = opExByProp.get(prop.id)   || [];
    const propCapEx = capExByProp.get(prop.id)  || [];
    const rev   = propPay  .reduce((s, p) => s + toEUR(p.amount, p.currency, p.date), 0);
    const opEx  = propOpEx .reduce((s, e) => s + toEUR(e.amount, e.currency, e.date), 0);
    const capEx = propCapEx.reduce((s, e) => s + toEUR(e.amount, e.currency, e.date), 0);

    const allTimeCapEx  = (allCapExByProp.get(prop.id) || [])
      .reduce((s, e) => s + toEUR(e.amount, e.currency, e.date), 0);
    const w = wById.get(prop.id);
    const purchaseEUR   = prop.purchasePrice
      ? toEUR(prop.purchasePrice, prop.currency, prop.purchaseDate) * w : 0;
    const totalInvested = purchaseEUR + allTimeCapEx;

    const netIncome     = rev - opEx;
    // simplePropertyROI / annualizedPropertyROI / cashOnCashPropertyROI are all
    // documented as ANNUAL metrics, but netIncome above is scoped to the current
    // filter period (e.g. YTD is always a partial year). Annualize it the same
    // way the Rental Yield KPI does (see annualizeForProperty) before feeding it
    // in, so a partial period doesn't masquerade as a full year of underperformance.
    // annualizedPropertyROI instead divides a LIFETIME return by years owned
    // (average annual return per year of ownership), so it gets the
    // property's all-time operating net, not this period's annualized one.
    const annualNetIncome = annualizeForProperty(prop, netIncome, { start, end, isIncomplete });
    const simpleROI     = simplePropertyROI(prop.id,     { netIncome: annualNetIncome, totalInvested });
    const annualizedROI = annualizedPropertyROI(prop.id, { netIncome: lifetimeNetByProp.get(prop.id) || 0, totalInvested });
    // Cash-on-cash compares with the whole property's cash invested, so it
    // takes the whole property's cash flow (undo the owner share).
    const cashOnCashROI = cashOnCashPropertyROI(prop.id, { annualCashFlow: w > 0 ? annualNetIncome / w : 0 });

    // Run-Rate ROI (formerly "Potential ROI"): the same full-year run-rate
    // projection Simple ROI already shows for a *completed* period, but
    // forced through for an *in-progress* one (YTD, this-month, etc.) too,
    // where Simple ROI instead intentionally shows the raw actual-so-far
    // figure. Null (not shown) for a completed period, since Simple ROI
    // already is this number there. Still reflects any real vacancy/downtime
    // that happened so far — it projects what ACTUALLY occurred, unlike
    // Steady-State Yield below, which is a fully-let hypothetical.
    const runRateROI = isIncomplete
      ? simplePropertyROI(prop.id, {
          netIncome: annualizeForProperty(prop, netIncome, { start, end, isIncomplete }, { force: true }),
          totalInvested
        })
      : null;

    // Steady-State Yield: what this property would yield if let at its
    // CURRENT contracted rent for a full, uninterrupted year — ignores
    // actual vacancy/downtime this year entirely (unlike Run-Rate ROI, which
    // is anchored to real performance so far). Long-term only: short-term
    // properties have no single fixed contracted rate to project from, since
    // nightly rate × occupancy varies booking to booking.
    const rentEUR = currentContractedAnnualRentEUR(prop);
    const steadyStateAnnualEUR = rentEUR === null ? null : rentEUR * w;
    const steadyStateYield = (steadyStateAnnualEUR !== null && totalInvested > 0)
      ? (steadyStateAnnualEUR / totalInvested) * 100
      : null;

    const expectedBookedEUR = isFuturePeriod ? computeExpectedBookedEUR(prop, start, end) * w : null;

    return {
      prop, share: w, rev, opEx, capEx, allTimeCapEx, purchaseEUR, totalInvested,
      netIncome,
      profit: rev - opEx,
      net:    rev - opEx - capEx,
      simpleROI, annualizedROI, cashOnCashROI, runRateROI, steadyStateYield, expectedBookedEUR,
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

// Sums what's already booked/scheduled for a property over [start, end] —
// used only for a genuinely future period (see isFuturePeriod above), where
// there's no actual performance to annualize/project from. STR: every active
// payment record already on the books in range (mostly 'pending' Airbnb
// reservations — deliberately not restricted to a single status, so a stay
// that's already been paid early still counts). LT: the rent schedule for
// the months in range (same source as reconciliation).
function computeExpectedBookedEUR(prop, start, end) {
  if (prop.type === 'long_term') {
    // The rent schedule (rent in force each month, part months prorated,
    // vacancies and sale date applied) — same source as reconciliation.
    const sMk = start.slice(0, 7), eMk = end.slice(0, 7);
    return generatePaymentSchedule(prop)
      .filter(e => e.monthKey >= sMk && e.monthKey <= eMk)
      .reduce((s, e) => s + toEUR(e.amount, e.currency, `${e.monthKey}-01`), 0);
  }
  // Materialized rows are frozen copies of bookings already paid — skip them
  // so a paid stay isn't counted twice.
  return paymentsOfProperty(prop.id)
    .filter(p => p.date >= start && p.date <= end && p.status !== 'materialized')
    .reduce((s, p) => s + toEUR(p.amount, p.currency, p.date), 0);
}

// Current contracted rent, annualized — the input to Steady-State Yield.
// Long-term only: finds whichever tenant's lease covers today (mirrors the
// "earlier lease wins" month-lookup computeExpectedBookedEUR uses above).
// Returns null for a short-term property (no fixed contracted rate) or a
// currently-vacant long-term one (nothing to project from).
function currentContractedAnnualRentEUR(prop) {
  if (prop.type !== 'long_term') return null;
  const now = today();
  const tenant = listActive('tenants').find(t => {
    if (t.propertyId !== prop.id || !t.monthlyRent) return false;
    const ls = t.leaseStartDate || null;
    const le = t.leaseEndDate   || null;
    return (!ls || now >= ls) && (!le || now <= le);
  });
  if (!tenant) return null;
  return toEUR(tenant.monthlyRent, tenant.currency || 'EUR', now) * 12;
}

// ── Operational metrics helpers ───────────────────────────────────────────────

// Annualizes a raw figure (revenue, net income) for ONE property, capping the
// denominator at that property's own ownership span (purchaseDate..soldDate)
// intersected with the selected range — never the portfolio-wide range
// itself. Without this cap, selecting "All Time" divides a property's real
// revenue by however many months the OLDEST property in the whole portfolio
// has existed, deflating every other property's "annualized" figure well
// below its true run-rate. For an incomplete period (YTD, this-month, etc. —
// still accumulating, see getCurrentPeriodRange's isIncomplete flag), returns
// the raw actual figure unprojected instead, since scaling partial-year data
// up to a full year isn't what "year to date" should show.
function annualizeForProperty(prop, rawValue, range, { force = false } = {}) {
  // force=true skips the incomplete-period passthrough — used by Potential
  // ROI, which deliberately wants the run-rate projection even mid-period.
  if (range.isIncomplete && !force) return rawValue;
  const ownedStart = (prop.purchaseDate && prop.purchaseDate > range.start) ? prop.purchaseDate : range.start;
  const ownedEnd = (prop.soldDate && prop.soldDate < range.end) ? prop.soldDate : range.end;
  if (ownedStart > ownedEnd) return 0;
  // Day-based: counting calendar months touched made e.g. "Last 30 Days"
  // (spanning 2 months) annualize ×6 instead of ×~12.
  const ownedDays = periodDays(ownedStart, ownedEnd);
  return ownedDays > 0 ? rawValue / ownedDays * DAYS_PER_YEAR : 0;
}

/**
 * Compute operational KPI data for the selected period.
 * Returns: { rentalYield, vacancy }
 */
function getOperationalData({ propData, payments, start, end, isIncomplete }) {
  // ── Rental Yield ─────────────────────────────────────────────────────────
  // Annualize revenue per property (see annualizeForProperty) rather than by
  // a single portfolio-wide period length.
  const yieldRange = { start, end, isIncomplete };
  const yieldData = propData
    .filter(d => d.purchaseEUR > 0)
    .map(d => {
      const annualRev = annualizeForProperty(d.prop, d.rev, yieldRange);
      return {
        name:      shareName(d.prop, ownerWeight(d.prop)),
        annualRev,
        purchase:  d.purchaseEUR,
        yieldPct:  (d.purchaseEUR > 0) ? (annualRev / d.purchaseEUR) * 100 : null
      };
    });

  // Include every property with a purchase price in the average, even ones
  // earning ~0 that period (e.g. mid-renovation) — matches Net Yield's
  // inclusion rule below, so a renovation-heavy period correctly pulls the
  // average down instead of that property being silently dropped from it.
  // Use the Status filter to exclude renovation/vacant properties on purpose.
  const avgYield = yieldData.length > 0
    ? yieldData.reduce((s, y) => s + y.yieldPct, 0) / yieldData.length : null;

  // ── Vacancy: property-months with zero revenue ────────────────────────────
  const monthKeys = [];
  const [sy, sm] = start.split('-').map(Number);
  const [ey, em] = end.split('-').map(Number);
  let cy = sy, cm = sm;
  while (cy < ey || (cy === ey && cm <= em)) {
    monthKeys.push(`${cy}-${String(cm).padStart(2, '0')}`);
    cm++;
    if (cm > 12) { cm = 1; cy++; }
  }

  // Build a Set of "propertyId|YYYY-MM" with revenue in one pass, then test
  // membership per property/month — replaces an O(props × months × payments)
  // nested scan with O(payments + props × months).
  const revKeys = new Set();
  for (const p of payments) {
    if (p.propertyId && p.date) revKeys.add(p.propertyId + '|' + p.date.slice(0, 7));
  }
  const vacancyDetails = [];
  for (const d of propData) {
    for (const mk of monthKeys) {
      if (!revKeys.has(d.prop.id + '|' + mk)) {
        vacancyDetails.push({ property: d.prop.name, month: mk });
      }
    }
  }

  // (The former STR occupancy/ADR block was removed: its results were never
  // rendered, and its day count parsed a full date as `start + '-01'`,
  // which is an Invalid Date.)
  return {
    rentalYield: { avg: avgYield, perProp: yieldData },
    vacancy:   { details: vacancyDetails, count: vacancyDetails.length }
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
// Drill-table name, marking a shared property counted at its owner share.
const shareName = (prop, w) => w < 1 ? `${prop.name} (${Math.round(w * 100)}% share)` : prop.name;

function toPropValueRows(propData) {
  return propData.map(d => ({
    name:     shareName(d.prop, ownerWeight(d.prop)),
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
    name:     shareName(d.prop, ownerWeight(d.prop)),
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
  { key: 'name',     label: 'Property' },
  { key: 'rev',      label: 'Revenue',    right: true, format: v => formatEUR(v), tip: 'Sum of paid payments in the selected period.' },
  { key: 'expenses', label: 'Expenses',   right: true, format: v => formatEUR(v), tip: 'Operating expenses (excludes CapEx) in the selected period.' },
  { key: 'net',      label: 'Op. Profit', right: true, format: v => formatEUR(v), tip: 'Revenue minus Expenses.' },
  { key: 'invested', label: 'Invested',   right: true, format: v => formatEUR(v), tip: 'Purchase price plus all-time renovation/CapEx spend.' },
  { key: 'roi',      label: 'Simple ROI', right: true, format: v => v != null ? v.toFixed(1) + '%' : '—', tip: 'Net income ÷ total invested × 100 for the selected period.' },
  { key: 'annRoi',   label: 'Ann. ROI',   right: true, format: v => v != null ? v.toFixed(1) + '%' : '—', tip: 'Simple ROI divided by years owned since purchase.' },
  { key: 'cocRoi',   label: 'CoC ROI',    right: true, format: v => v != null ? v.toFixed(1) + '%' : '—', tip: 'Annual net income ÷ actual cash invested (purchase price minus mortgage).' }
];

function mixedRows(pays, exps) {
  return [
    ...toRevDrillRows(pays) .map(r => ({ ...r, kind: 'Revenue', category: '—' })),
    ...toExpDrillRows(exps) .map(r => ({ ...r, kind: r.type,   status:   '—' }))
  ].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

function formatMonthKey(mk) {
  const [year, mm] = mk.split('-');
  return `${MONTH_LABELS[parseInt(mm, 10) - 1]} ${year}`;
}

// ── Mortgage estimation ───────────────────────────────────────────────────────
function computeMortgageEstimate(prop, asOf = todayYmd()) {
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
    const msSince = Math.max(0, new Date(asOf).getTime() - new Date(rateDate).getTime());
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
// ── CapEx Impact — Revenue Before vs After ────────────────────────────────────
const CAPEX_WINDOW_MAX_DAYS = 183; // ≈ 6 months
function buildCapExImpactSection({ propData, curRange }) {
  // Only properties that had CapEx in the current period
  const capExProps = propData.filter(d => d.propCapExpenses.length > 0);
  if (capExProps.length === 0) return null;

  const rows = capExProps.map(d => {
    const capExTotal = d.capEx;
    const curRev     = d.rev;
    const curNet     = d.profit;

    // Find earliest CapEx date in this period — use it as "renovation start"
    const sortedCapEx = [...d.propCapExpenses].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    const firstCapExDate = sortedCapEx[0]?.date;

    // Equal before/after windows around the first CapEx date: the "after"
    // window runs from the first CapEx date to the period end (or today, if
    // earlier), capped at CAPEX_WINDOW_MAX_DAYS; the "before" window is the
    // same number of days immediately preceding it. (It used to compare the
    // whole period's revenue — incl. pre-CapEx months — with a fixed 6-month
    // lookback, so the two sides covered different lengths of time.)
    let preRev = null, postRev = null, windowDays = 0;
    let prePayments = [];
    let postPayments = [];
    if (firstCapExDate) {
      const todayStr = todayYmd();
      const effEnd   = curRange.end < todayStr ? curRange.end : todayStr;
      windowDays     = Math.min(CAPEX_WINDOW_MAX_DAYS, Math.max(1, periodDays(firstCapExDate, effEnd)));
      const preStart  = addDaysYmd(firstCapExDate, -windowDays);
      const postEnd   = addDaysYmd(firstCapExDate, windowDays - 1);
      const propPaid  = paymentsOfProperty(d.prop.id).filter(p =>
        p.status === 'paid' && (gScope === 'all' || !p.personal));
      prePayments  = propPaid.filter(p => p.date >= preStart && p.date < firstCapExDate);
      postPayments = propPaid.filter(p => p.date >= firstCapExDate && p.date <= postEnd);
      preRev  = prePayments.reduce((s, p) => s + toEUR(p.amount, p.currency, p.date), 0);
      postRev = postPayments.reduce((s, p) => s + toEUR(p.amount, p.currency, p.date), 0);
    }

    const revChange = preRev !== null && preRev > 0
      ? ((postRev - preRev) / preRev * 100).toFixed(1)
      : null;

    return {
      name:      shareName(d.prop, ownerWeight(d.prop)),
      capEx:     capExTotal,
      preRev,
      postRev,
      windowDays,
      curRev,
      curNet,
      revChange,
      firstDate:    firstCapExDate || null,
      capExItems:   sortedCapEx,
      prePayments,
      postPayments
    };
  });

  const section = el('div', { class: 'card mb-16' });
  section.appendChild(el('div', { class: 'card-header' },
    el('div', { class: 'card-title' }, `CapEx Impact — ${curRange.label}`),
    el('div', { style: 'font-size:12px;color:var(--text-muted)' }, 'Properties with CapEx this period · click a row for payment detail')
  ));

  const body = el('div', { style: 'padding:0 16px 16px' });

  const COLS = ['Property', 'CapEx Spent', 'Rev Before (window)', 'Rev After (window)', 'Rev Change', 'Period Net'];
  const table = el('table', { class: 'table' });
  const htr   = el('tr');
  COLS.forEach((h, i) => htr.appendChild(el('th', { class: i > 0 ? 'right' : '' }, h)));
  table.appendChild(el('thead', {}, htr));

  const tbody = el('tbody');
  rows.forEach(r => {
    const changeStr = r.revChange !== null
      ? (parseFloat(r.revChange) >= 0 ? '+' : '') + r.revChange + `% (${r.windowDays}d vs ${r.windowDays}d)`
      : '—';
    const tr = el('tr', { style: 'cursor:pointer', title: 'Click for payment detail' });
    tr.onclick = () => openCapExImpactModal(r);
    [r.name, formatEUR(r.capEx), r.preRev !== null ? formatEUR(r.preRev) : '—', r.postRev !== null ? formatEUR(r.postRev) : '—', changeStr, formatEUR(r.curNet)]
      .forEach((val, i) => {
        const td = el('td', { class: i > 0 ? 'right num' : '', style: i === 5 ? 'font-weight:700' : '' }, val);
        tr.appendChild(td);
      });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);

  const tableWrap = el('div', { class: 'table-wrap' });
  tableWrap.appendChild(table);
  body.appendChild(tableWrap);

  body.appendChild(el('div', { style: 'font-size:11px;color:var(--text-muted);margin-top:8px' },
    'Rev Before / After: paid rental payments in equal windows immediately before and from the first CapEx date (window = first CapEx → period end or today, max 183 days) · Period Net: this period’s revenue − OpEx'
  ));

  section.appendChild(body);
  return section;
}

function openCapExImpactModal(r) {
  const body = el('div');
  const sgrid = el('div', { style: 'display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:20px' });
  sgrid.appendChild(mkSummaryBox('CapEx Spent', formatEUR(r.capEx), r.firstDate ? `First CapEx: ${fmtDate(r.firstDate)}` : null));
  sgrid.appendChild(mkSummaryBox(`Revenue Before (${r.windowDays}d)`, r.preRev !== null ? formatEUR(r.preRev) : '—', null));
  sgrid.appendChild(mkSummaryBox(`Revenue After (${r.windowDays}d)`, r.postRev !== null ? formatEUR(r.postRev) : '—', null));
  body.appendChild(sgrid);

  const PAY_HEADERS = [{ label: 'Date' }, { label: 'Type' }, { label: 'Stream' }, { label: 'EUR', right: true }];
  const paymentRows = pays => [...pays]
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
    .map(p => [fmtDate(p.date), p.type || '—', STREAMS[p.stream]?.short || p.stream || '—', formatEUR(toEUR(p.amount, p.currency, p.date))]);

  body.appendChild(mkSectionLabel(`Payments Before CapEx (${r.windowDays} days)`));
  body.appendChild(r.prePayments.length
    ? mkModalTable(PAY_HEADERS, paymentRows(r.prePayments))
    : mkEmptyState(`No payments recorded in the ${r.windowDays} days before the CapEx event.`));

  body.appendChild(el('div', { style: 'margin-top:20px' }));
  body.appendChild(mkSectionLabel(`Payments After CapEx (${r.windowDays} days)`));
  body.appendChild(r.postPayments.length
    ? mkModalTable(PAY_HEADERS, paymentRows(r.postPayments))
    : mkEmptyState(`No payments recorded in the ${r.windowDays} days from the CapEx event.`));

  if (r.capExItems.length) {
    body.appendChild(el('div', { style: 'margin-top:20px' }));
    body.appendChild(mkSectionLabel('CapEx Events'));
    body.appendChild(mkModalTable(
      [{ label: 'Date' }, { label: 'Category' }, { label: 'Amount', right: true }],
      r.capExItems.map(e => [fmtDate(e.date), e.category || '—', formatEUR(toEUR(e.amount, e.currency, e.date))])
    ));
  }

  openModal({ title: `${r.name} — CapEx Impact`, body, large: true });
}

// Owner-share mortgage figures as of `asOf` (balance, payment and principal
// scale with the share; DTV and years left don't).
function mortgageFor(prop, asOf) {
  return scaleBy(computeMortgageEstimate(prop, asOf), ownerWeight(prop), MORT_MONEY);
}

function getFinancingData(allProps, asOf = todayYmd()) {
  const held = allProps.filter(p => !p.purchaseDate || p.purchaseDate <= asOf);
  const finData    = held.map(prop => ({ prop, ...mortgageFor(prop, asOf) }));
  const withMortgage = finData.filter(d => d.financed);
  const activeDebt   = finData.filter(d => d.financed && !d.paidOff);

  const totalDebt    = withMortgage.reduce((s, d) => s + d.remaining,   0);
  const totalMonthly = activeDebt  .reduce((s, d) => s + d.monthlyDebt, 0);
  const totalValue   = held.reduce((s, p) =>
    s + (p.purchasePrice ? toEUR(p.purchasePrice, p.currency, p.purchaseDate) * ownerWeight(p) : 0), 0);

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
      nPaidOff:  held.length - withMortgage.length
    }
  };
}

function toFinancingDrillRows(finData) {
  return [...finData].sort((a, b) => b.remaining - a.remaining).map(d => ({
    name:      shareName(d.prop, ownerWeight(d.prop)),
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

// ── Shared KPI/insight modal builders ─────────────────────────────────────────
// Extracted so the Property Insights banner can open the same modals as the
// KPI cards and the Operating Profit chart instead of duplicating their bodies.
function openOperatingProfitModal({ totals, propData, cmpTotals, cmpPropData, cmpLabel }) {
  const body = el('div');
  const sgrid = el('div', { style: 'display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:20px' });
  sgrid.appendChild(mkSummaryBox('Revenue', formatEUR(totals.rev), null));
  sgrid.appendChild(mkSummaryBox('Operating Expenses', formatEUR(totals.opEx), null));
  sgrid.appendChild(mkSummaryBox('Operating Profit', formatEUR(totals.profit), totals.rev > 0 ? `Margin: ${(totals.profit / totals.rev * 100).toFixed(0)}%` : null));
  body.appendChild(sgrid);
  const sorted = [...propData].filter(d => d.rev > 0 || d.opEx > 0).sort((a, b) => b.profit - a.profit);
  if (sorted.length) {
    body.appendChild(mkSectionLabel('P&L by Property'));
    body.appendChild(mkModalTable(
      ['Property', 'Revenue', 'OpEx', 'Profit', 'Margin'],
      sorted.map(d => [d.prop.name, formatEUR(d.rev), formatEUR(d.opEx), formatEUR(d.profit), d.rev > 0 ? (d.profit / d.rev * 100).toFixed(0) + '%' : '—'])
    ));
  }
  if (cmpPropData && cmpTotals) {
    const cmpSorted = [...cmpPropData].filter(d => d.rev > 0 || d.opEx > 0).sort((a, b) => b.profit - a.profit);
    if (cmpSorted.length) {
      body.appendChild(el('div', { style: 'margin-top:20px' }));
      body.appendChild(mkSectionLabel(`P&L by Property — ${cmpLabel}`));
      body.appendChild(mkModalTable(
        ['Property', 'Revenue', 'OpEx', 'Profit', 'Margin'],
        cmpSorted.map(d => [d.prop.name, formatEUR(d.rev), formatEUR(d.opEx), formatEUR(d.profit), d.rev > 0 ? (d.profit / d.rev * 100).toFixed(0) + '%' : '—'])
      ));
    }
  }
  openModal({ title: `Operating Profit — ${formatEUR(totals.profit)}`, body, large: true });
}

function openOperatingExpensesModal({ totals, opExpenses, cmpTotals, cmpOpExpenses, cmpLabel }) {
  const body = el('div');
  const catMap = new Map();
  opExpenses.forEach(e => { const c = e.category || '—'; catMap.set(c, (catMap.get(c) || 0) + toEUR(e.amount, e.currency, e.date)); });
  const cats = [...catMap.entries()].sort((a, b) => b[1] - a[1]);
  if (cats.length) {
    body.appendChild(mkSectionLabel('By Category'));
    body.appendChild(mkModalTable(
      ['Category', 'Amount', '% of OpEx'],
      cats.map(([c, v]) => [c, formatEUR(v), totals.opEx > 0 ? (v / totals.opEx * 100).toFixed(1) + '%' : '—'])
    ));
  }
  const propOpMap = new Map();
  opExpenses.forEach(e => { if (!e.propertyId) return; const n = byId('properties', e.propertyId)?.name || 'Unknown'; const x = propOpMap.get(e.propertyId) || { n, v: 0 }; x.v += toEUR(e.amount, e.currency, e.date); propOpMap.set(e.propertyId, x); });
  const props = [...propOpMap.values()].sort((a, b) => b.v - a.v);
  if (props.length) {
    body.appendChild(el('div', { style: 'margin-top:20px' }));
    body.appendChild(mkSectionLabel('By Property'));
    body.appendChild(mkModalTable(
      ['Property', 'Amount', '% of OpEx'],
      props.map(p => [p.n, formatEUR(p.v), totals.opEx > 0 ? (p.v / totals.opEx * 100).toFixed(1) + '%' : '—'])
    ));
  }
  if (cmpOpExpenses && cmpTotals) {
    const cmpCatMap = new Map();
    cmpOpExpenses.forEach(e => { const c = e.category || '—'; cmpCatMap.set(c, (cmpCatMap.get(c) || 0) + toEUR(e.amount, e.currency, e.date)); });
    const cmpCats = [...cmpCatMap.entries()].sort((a, b) => b[1] - a[1]);
    if (cmpCats.length) {
      body.appendChild(el('div', { style: 'margin-top:20px' }));
      body.appendChild(mkSectionLabel(`By Category — ${cmpLabel}`));
      body.appendChild(mkModalTable(
        ['Category', 'Amount', '% of OpEx'],
        cmpCats.map(([c, v]) => [c, formatEUR(v), cmpTotals.opEx > 0 ? (v / cmpTotals.opEx * 100).toFixed(1) + '%' : '—'])
      ));
    }
    const cmpPropOpMap = new Map();
    cmpOpExpenses.forEach(e => { if (!e.propertyId) return; const n = byId('properties', e.propertyId)?.name || 'Unknown'; const x = cmpPropOpMap.get(e.propertyId) || { n, v: 0 }; x.v += toEUR(e.amount, e.currency, e.date); cmpPropOpMap.set(e.propertyId, x); });
    const cmpProps = [...cmpPropOpMap.values()].sort((a, b) => b.v - a.v);
    if (cmpProps.length) {
      body.appendChild(el('div', { style: 'margin-top:20px' }));
      body.appendChild(mkSectionLabel(`By Property — ${cmpLabel}`));
      body.appendChild(mkModalTable(
        ['Property', 'Amount', '% of OpEx'],
        cmpProps.map(p => [p.n, formatEUR(p.v), cmpTotals.opEx > 0 ? (p.v / cmpTotals.opEx * 100).toFixed(1) + '%' : '—'])
      ));
    }
  }
  openModal({ title: `Operating Expenses — ${formatEUR(totals.opEx)}`, body, large: true });
}

function openPropertyCapExModal({ totals, capExpenses, cmpTotals, cmpCapExpenses, cmpLabel }) {
  const body = el('div');
  const propCapMap = new Map();
  capExpenses.forEach(e => { if (!e.propertyId) return; const n = byId('properties', e.propertyId)?.name || 'Unknown'; const x = propCapMap.get(e.propertyId) || { n, v: 0, cnt: 0 }; x.v += toEUR(e.amount, e.currency, e.date); x.cnt++; propCapMap.set(e.propertyId, x); });
  const props = [...propCapMap.values()].sort((a, b) => b.v - a.v);
  if (props.length) {
    body.appendChild(mkSectionLabel('CapEx by Property'));
    body.appendChild(mkModalTable(
      ['Property', 'Records', 'Amount', '% of Total'],
      props.map(p => [p.n, String(p.cnt), formatEUR(p.v), totals.capEx > 0 ? (p.v / totals.capEx * 100).toFixed(1) + '%' : '—'])
    ));
  }
  const catMap = new Map();
  capExpenses.forEach(e => { const c = e.category || '—'; catMap.set(c, (catMap.get(c) || 0) + toEUR(e.amount, e.currency, e.date)); });
  const cats = [...catMap.entries()].sort((a, b) => b[1] - a[1]);
  if (cats.length) {
    body.appendChild(el('div', { style: 'margin-top:20px' }));
    body.appendChild(mkSectionLabel('By Category'));
    body.appendChild(mkModalTable(
      [{ label: 'Category' }, { label: 'Amount', right: true }, { label: '% of Total', right: true, muted: true }],
      cats.map(([c, v]) => [c, formatEUR(v), totals.capEx > 0 ? (v / totals.capEx * 100).toFixed(1) + '%' : '—'])
    ));
  }
  if (cmpCapExpenses && cmpTotals) {
    const cmpPropCapMap = new Map();
    cmpCapExpenses.forEach(e => { if (!e.propertyId) return; const n = byId('properties', e.propertyId)?.name || 'Unknown'; const x = cmpPropCapMap.get(e.propertyId) || { n, v: 0, cnt: 0 }; x.v += toEUR(e.amount, e.currency, e.date); x.cnt++; cmpPropCapMap.set(e.propertyId, x); });
    const cmpProps = [...cmpPropCapMap.values()].sort((a, b) => b.v - a.v);
    if (cmpProps.length) {
      body.appendChild(el('div', { style: 'margin-top:20px' }));
      body.appendChild(mkSectionLabel(`CapEx by Property — ${cmpLabel}`));
      body.appendChild(mkModalTable(
        ['Property', 'Records', 'Amount', '% of Total'],
        cmpProps.map(p => [p.n, String(p.cnt), formatEUR(p.v), cmpTotals.capEx > 0 ? (p.v / cmpTotals.capEx * 100).toFixed(1) + '%' : '—'])
      ));
    }
    const cmpCatMap = new Map();
    cmpCapExpenses.forEach(e => { const c = e.category || '—'; cmpCatMap.set(c, (cmpCatMap.get(c) || 0) + toEUR(e.amount, e.currency, e.date)); });
    const cmpCats = [...cmpCatMap.entries()].sort((a, b) => b[1] - a[1]);
    if (cmpCats.length) {
      body.appendChild(el('div', { style: 'margin-top:20px' }));
      body.appendChild(mkSectionLabel(`By Category — ${cmpLabel}`));
      body.appendChild(mkModalTable(
        [{ label: 'Category' }, { label: 'Amount', right: true }, { label: '% of Total', right: true, muted: true }],
        cmpCats.map(([c, v]) => [c, formatEUR(v), cmpTotals.capEx > 0 ? (v / cmpTotals.capEx * 100).toFixed(1) + '%' : '—'])
      ));
    }
  }
  openModal({ title: `Property CapEx — ${formatEUR(totals.capEx)}`, body, large: true });
}

// ── Compact property summary (row-click on the Property Summary table) ────────
function openPropertySummaryModal(d) {
  const prop   = d.prop;
  const status = prop.status || 'active';
  const body   = el('div');

  const statusNotes = {
    renovation: '🔨 This property is currently under renovation — figures reflect any activity during the selected period.',
    vacant:     '⬜ This property is currently vacant — figures reflect any activity during the selected period.',
    sold:       '✓ This property has been sold — figures reflect activity up to the sale.'
  };
  if (statusNotes[status]) {
    body.appendChild(el('div', {
      style: 'margin-bottom:16px;padding:8px 12px;background:#fef3c7;border:1px solid #f59e0b;border-radius:6px;font-size:12px;color:#92400e'
    }, statusNotes[status]));
  }

  const perfBoxes = [
    {
      label: 'Revenue',
      value: mkDrillValue(formatEUR(d.rev), () =>
        drillDownModal(`${prop.name} — Revenue`, toRevDrillRows(d.propPayments), REV_DRILL_COLS)),
      explain: {
        title: 'Revenue', formula: 'Sum of paid payments for this property, dated within the selected period.',
        inputs: [
          { label: 'Payments counted', value: String(d.propPayments.length) },
          { label: 'Total', value: formatEUR(d.rev) }
        ],
        source: 'analytics-properties.js getData() — `rev` (payByProp reduce)',
        note: 'Only status:\'paid\' payments count — pending/materialized rows are excluded so nothing is double-counted.'
      }
    },
    { label: 'Operating Expenses',
      value: mkDrillValue(formatEUR(d.opEx), () =>
        drillDownModal(`${prop.name} — Operating Expenses`, toExpDrillRows(d.propOpExpenses), EXP_DRILL_COLS)),
      sub: d.rev > 0 ? `${(d.opEx / d.rev * 100).toFixed(0)}% of revenue` : null,
      explain: {
        title: 'Operating Expenses', formula: 'Sum of expenses in the selected period, excluding CapEx/renovation.',
        inputs: [{ label: 'Total', value: formatEUR(d.opEx) }],
        source: 'analytics-properties.js getData() — `opEx` (opExByProp reduce)'
      }
    },
    { label: 'Operating Profit',
      value: mkDrillValue(formatEUR(d.profit), () =>
        drillDownModal(`${prop.name} — Operating Profit`, mixedRows(d.propPayments, d.propOpExpenses), MIXED_DRILL_COLS)),
      sub: d.rev > 0 ? `Margin ${(d.profit / d.rev * 100).toFixed(0)}%` : null,
      explain: {
        title: 'Operating Profit', formula: 'Revenue − Operating Expenses',
        inputs: [{ label: 'Revenue', value: formatEUR(d.rev) }, { label: 'Operating Expenses', value: formatEUR(d.opEx) }],
        source: 'analytics-properties.js getData() — `profit: rev - opEx`'
      }
    },
    { label: 'CapEx (period)',
      value: mkDrillValue(formatEUR(d.capEx), () =>
        drillDownModal(`${prop.name} — CapEx (period)`, toExpDrillRows(d.propCapExpenses), EXP_DRILL_COLS))
    },
    { label: 'Net (after CapEx)',
      value: mkDrillValue(formatEUR(d.net), () =>
        drillDownModal(`${prop.name} — Net (after CapEx)`, mixedRows(d.propPayments, [...d.propOpExpenses, ...d.propCapExpenses]), MIXED_DRILL_COLS)),
      explain: {
        title: 'Net (after CapEx)', formula: 'Revenue − Operating Expenses − CapEx',
        inputs: [{ label: 'Revenue', value: formatEUR(d.rev) }, { label: 'Operating Expenses', value: formatEUR(d.opEx) }, { label: 'CapEx (period)', value: formatEUR(d.capEx) }],
        source: 'analytics-properties.js getData() — `net: rev - opEx - capEx`'
      }
    },
    { label: 'All-time CapEx',
      value: mkDrillValue(formatEUR(d.allTimeCapEx), () =>
        drillDownModal(`${prop.name} — All-time CapEx`, toExpDrillRows(listActive('expenses').filter(e => isCapEx(e) && e.propertyId === prop.id)), EXP_DRILL_COLS))
    }
  ];
  if (d.expectedBookedEUR !== null) {
    perfBoxes.push({
      label: 'Expected Rev (booked)', value: formatEUR(d.expectedBookedEUR), sub: 'Booked so far for this future period',
      explain: {
        title: 'Expected Rev (booked)',
        formula: prop.type === 'long_term'
          ? 'Sum of active-lease monthlyRent, once per month covered by the selected future period.'
          : 'Sum of every payment already on the books (any status) whose date falls in the selected future period — mostly pending Airbnb reservations.',
        inputs: [{ label: 'Total', value: formatEUR(d.expectedBookedEUR) }],
        source: 'analytics-properties.js computeExpectedBookedEUR()',
        note: 'This is what\'s already booked/scheduled, not a full-period forecast — a future month with nothing booked yet will show near-zero.'
      }
    });
  }
  body.appendChild(mkSectionLabel('Performance'));
  body.appendChild(mkSummaryGrid(perfBoxes, 3));

  const roiBoxes = [];
  if (d.simpleROI !== null) roiBoxes.push({
    label: 'Simple ROI', value: d.simpleROI.toFixed(1) + '%',
    explain: {
      title: 'Simple ROI', formula: 'Net Income ÷ Total Invested × 100',
      inputs: [
        { label: 'Net Income (period, possibly annualized)', value: formatEUR(d.netIncome) },
        { label: 'Total Invested', value: formatEUR(d.totalInvested) }
      ],
      source: 'core/data.js simplePropertyROI()',
      note: 'For an in-progress period (e.g. YTD) this uses the raw actual-so-far net income, unprojected — see Run-Rate ROI for a full-year run-rate instead.'
    }
  });
  if (d.runRateROI !== null) roiBoxes.push({
    label: 'Run-Rate ROI', value: d.runRateROI.toFixed(1) + '%', sub: 'Full-year run-rate (actual so far)',
    explain: {
      title: 'Run-Rate ROI', formula: '(Net Income so far ÷ months elapsed × 12) ÷ Total Invested × 100',
      inputs: [{ label: 'Total Invested', value: formatEUR(d.totalInvested) }],
      source: 'analytics-properties.js annualizeForProperty(..., {force:true}) → simplePropertyROI()',
      note: 'Only shown for an in-progress period. Projects ACTUAL performance so far to a full year — still reflects any real vacancy/downtime this year. See Steady-State Yield for a fully-let hypothetical instead. Relies on purchaseDate being accurate, since the projection is anchored to it.'
    }
  });
  if (d.steadyStateYield !== null) roiBoxes.push({
    label: 'Steady-State Yield', value: d.steadyStateYield.toFixed(1) + '%', sub: 'If fully let all year, at today\'s rent',
    explain: {
      title: 'Steady-State Yield', formula: 'Current Contracted Monthly Rent × 12 ÷ Total Invested × 100',
      inputs: [{ label: 'Total Invested', value: formatEUR(d.totalInvested) }],
      source: 'analytics-properties.js currentContractedAnnualRentEUR() → active tenant\'s monthlyRent',
      note: 'A hypothetical: what this property would yield if let at its CURRENT rent for a full, uninterrupted year — ignores any actual vacancy/downtime this year, unlike Run-Rate ROI. Long-term rentals only; short-term/Airbnb properties have no single fixed contracted rate to project from.'
    }
  });
  if (d.annualizedROI !== null) roiBoxes.push({
    label: 'Annualized ROI', value: d.annualizedROI.toFixed(1) + '%',
    explain: {
      title: 'Annualized ROI', formula: 'Simple ROI ÷ years owned since purchase',
      inputs: [{ label: 'Simple ROI', value: d.simpleROI != null ? d.simpleROI.toFixed(1) + '%' : '—' }, { label: 'Purchase Date', value: prop.purchaseDate || '—' }],
      source: 'core/data.js annualizedPropertyROI()',
      note: 'Average annual return per year of ownership — not the same as this year\'s return.'
    }
  });
  if (d.cashOnCashROI !== null) roiBoxes.push({
    label: 'Cash-on-Cash ROI', value: d.cashOnCashROI.toFixed(1) + '%',
    explain: {
      title: 'Cash-on-Cash ROI', formula: 'Annual Net Income ÷ (Purchase Price − Mortgage Amount) × 100',
      inputs: [{ label: 'Net Income', value: formatEUR(d.netIncome) }, { label: 'Purchase Price', value: formatEUR(d.purchaseEUR) }],
      source: 'core/data.js cashOnCashPropertyROI()',
      note: 'Isolates return on actual cash/equity invested rather than the full purchase price. Null for a cash purchase with no mortgage data.'
    }
  });
  if (roiBoxes.length) {
    body.appendChild(mkSectionLabel('Return on Investment'));
    body.appendChild(mkSummaryGrid(roiBoxes, roiBoxes.length));
  }

  body.appendChild(mkSectionLabel('Investment'));
  body.appendChild(mkSummaryGrid([
    { label: 'Purchase Price', value: formatEUR(d.purchaseEUR) },
    { label: 'Total Invested', value: formatEUR(d.totalInvested), sub: 'Purchase price + all-time CapEx',
      explain: {
        title: 'Total Invested', formula: 'Purchase Price + all-time renovation/CapEx spend',
        inputs: [{ label: 'Purchase Price', value: formatEUR(d.purchaseEUR) }, { label: 'All-time CapEx', value: formatEUR(d.allTimeCapEx) }],
        source: 'analytics-properties.js getData() — `totalInvested: purchaseEUR + allTimeCapEx`',
        note: 'All-time CapEx is never filtered by the selected period — it always reflects every renovation expense ever recorded for this property.'
      }
    }
  ], 2));

  const mort = mortgageFor(prop);
  if (mort.financed) {
    body.appendChild(mkSectionLabel('Financing'));
    body.appendChild(mkSummaryGrid([
      { label: 'Outstanding Balance', value: formatEUR(mort.remaining), sub: mort.dtvRatio != null ? `${mort.dtvRatio.toFixed(0)}% of purchase price` : null },
      { label: 'Monthly Payment',     value: formatEUR(mort.monthlyDebt) },
      { label: 'Est. Payoff',         value: mort.paidOff ? 'Paid off' : (mort.yearsLeft != null ? `${mort.yearsLeft.toFixed(1)} yrs left` : '—') }
    ], 3));
  }

  const catMap = new Map();
  [...d.propOpExpenses, ...d.propCapExpenses].forEach(e => {
    const c = e.category || '—';
    catMap.set(c, (catMap.get(c) || 0) + toEUR(e.amount, e.currency, e.date));
  });
  const cats = [...catMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (cats.length) {
    const totalExp = d.opEx + d.capEx;
    body.appendChild(mkSectionLabel('Top Expense Categories'));
    body.appendChild(mkModalTable(
      [{ label: 'Category' }, { label: 'Amount', right: true }, { label: '% of Expenses', right: true, muted: true }],
      cats.map(([c, v]) => [c, formatEUR(v), totalExp > 0 ? (v / totalExp * 100).toFixed(1) + '%' : '—'])
    ));
  }

  const txCount = d.propPayments.length + d.propOpExpenses.length + d.propCapExpenses.length;
  const footer = el('div', { style: 'margin-top:16px;padding-top:12px;border-top:1px solid rgba(255,255,255,0.08);display:flex;justify-content:space-between;align-items:center' });
  footer.appendChild(el('div', { style: 'font-size:12px;color:var(--text-muted)' }, `${txCount} transaction${txCount === 1 ? '' : 's'} in the selected period`));
  const link = el('a', { style: 'font-size:12px;cursor:pointer;color:var(--accent)' }, 'View all transactions →');
  link.onclick = () => {
    const rows = mixedRows(d.propPayments, [...d.propOpExpenses, ...d.propCapExpenses]);
    drillDownModal(`${prop.name} — All Transactions`, rows, MIXED_DRILL_COLS);
  };
  footer.appendChild(link);
  body.appendChild(footer);

  openModal({ title: `${prop.name} — Summary`, body, large: true });
}

function openPropertyPLModal(d) {
  const body = el('div');
  const sgrid = el('div', { style: 'display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:20px' });
  sgrid.appendChild(mkSummaryBox('Revenue', formatEUR(d.rev), null));
  sgrid.appendChild(mkSummaryBox('Operating Expenses', formatEUR(d.opEx), null));
  sgrid.appendChild(mkSummaryBox('Operating Profit', formatEUR(d.profit), d.rev > 0 ? `Margin: ${(d.profit / d.rev * 100).toFixed(0)}%` : null));
  body.appendChild(sgrid);
  const catMap = new Map();
  d.propOpExpenses.forEach(e => { const c = e.category || '—'; catMap.set(c, (catMap.get(c) || 0) + toEUR(e.amount, e.currency, e.date)); });
  const cats = [...catMap.entries()].sort((a, b) => b[1] - a[1]);
  if (cats.length) {
    body.appendChild(mkSectionLabel('OpEx by Category'));
    body.appendChild(mkModalTable(
      [{ label: 'Category' }, { label: 'Amount', right: true }, { label: '% of OpEx', right: true, muted: true }],
      cats.map(([c, v]) => [c, formatEUR(v), d.opEx > 0 ? (v / d.opEx * 100).toFixed(1) + '%' : '—'])
    ));
  }
  if (d.capEx > 0) {
    body.appendChild(el('div', { style: 'margin-top:16px' }));
    body.appendChild(mkSectionLabel(`CapEx — ${formatEUR(d.capEx)}`));
    body.appendChild(mkModalTable(
      [{ label: 'Date', muted: true }, { label: 'Category' }, { label: 'Amount', right: true }],
      [...d.propCapExpenses].sort((a, b) => (b.date || '').localeCompare(a.date || '')).map(e => [fmtDate(e.date), e.category || '—', formatEUR(toEUR(e.amount, e.currency, e.date))])
    ));
  }
  openModal({ title: `${d.prop.name} — Property P&L`, body, large: true });
}

// ── Insights ──────────────────────────────────────────────────────────────────
function computePropertyInsights({ totals, propData, opExpenses, capExpenses, avgROI, best, worst }) {
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
      inspect: 'Operating Profit',
      onClick: () => openOperatingProfitModal({ totals, propData })
    });
  }

  if (totals.rev > 0 && totals.opEx / totals.rev > 0.80) {
    const pct = Math.round(totals.opEx / totals.rev * 100);
    signals.push({
      severity: 'Watch',
      title: 'HIGH EXPENSE RATIO',
      text: `Operating expenses are ${pct}% of revenue — high overhead. Review recurring costs.`,
      inspect: 'Operating Expenses',
      onClick: () => openOperatingExpensesModal({ totals, opExpenses })
    });
  }

  if (avgROI !== null && avgROI < 0) {
    signals.push({
      severity: 'At Risk',
      title: 'NEGATIVE ROI',
      text: `Portfolio average Simple ROI is ${avgROI.toFixed(1)}% — net losses exceed invested capital.`,
      inspect: 'ROI Overview',
      onClick: () => drillDownModal('Portfolio ROI Overview', toROIDrillRows(propData), ROI_DRILL_COLS)
    });
  } else if (worst && avgROI !== null && worst.simpleROI !== null && worst.simpleROI < avgROI - 15) {
    signals.push({
      severity: 'Watch',
      title: 'UNDERPERFORMER',
      text: `"${worst.prop.name}" has ROI of ${worst.simpleROI.toFixed(1)}% vs portfolio avg ${avgROI.toFixed(1)}% — lagging by more than 15 pp.`,
      inspect: worst.prop.name,
      onClick: () => openPropertyPLModal(worst)
    });
  }

  if (totals.net < 0 && totals.capEx > 0) {
    signals.push({
      severity: 'Note',
      title: 'CAPEX DRAG',
      text: `Net income after CapEx is ${formatEUR(totals.net)}. This may reflect an active renovation period.`,
      inspect: 'Property CapEx',
      onClick: () => openPropertyCapExModal({ totals, capExpenses })
    });
  }

  if (best && worst && best !== worst) {
    const spread = (best.simpleROI ?? 0) - (worst.simpleROI ?? 0);
    signals.push({
      severity: spread > 20 ? 'Watch' : 'Note',
      title: 'BEST & WEAKEST',
      text: `Best: "${best.prop.name}" (ROI ${best.simpleROI != null ? best.simpleROI.toFixed(1) + '%' : '—'}) · Weakest: "${worst.prop.name}" (ROI ${worst.simpleROI != null ? worst.simpleROI.toFixed(1) + '%' : '—'})${avgROI != null ? ` · portfolio avg ${avgROI.toFixed(1)}%` : ''}${spread > 20 ? ` — a ${spread.toFixed(0)} pp spread, review allocation.` : '.'}`,
      inspect: 'Property Comparison',
      onClick: () => drillDownModal('Property Comparison — Best vs Weakest', toROIDrillRows([best, worst]), ROI_DRILL_COLS)
    });
  }

  return signals;
}

// ── Property Lifecycle Timeline ────────────────────────────────────────────────
// Consolidated Gantt-style history per property — purchase date, renovation
// periods, and tenant occupancy — all on one shared date axis. Mirrors the
// per-property Gantt bar mechanics in properties.js's buildTenantTimelineCard,
// generalized to one row per property (instead of one row per tenant of a
// single property) with purchase/sold markers and renovation bands added.

// Greedy interval-scheduling lane assignment so overlapping tenants (e.g. a
// multi-room property with concurrent leases) stack instead of visually
// colliding. Dates are ISO "YYYY-MM-DD" strings, which sort lexically in
// chronological order, so no ms parsing is needed here.
function assignLanes(items, getStart, getEnd) {
  const laneEnds = [];
  return items.map(item => {
    const s = getStart(item), e = getEnd(item);
    let lane = laneEnds.findIndex(end => end <= s);
    if (lane === -1) { lane = laneEnds.length; laneEnds.push(e); }
    else laneEnds[lane] = e;
    return lane;
  });
}

// Compact "Xy Ym" / "Xm" span label between two ISO date strings, for the
// click-through info popups below.
function durationLabel(startStr, endStr) {
  const start = new Date(`${startStr}T00:00:00Z`);
  const end   = new Date(`${endStr}T00:00:00Z`);
  let months = (end.getUTCFullYear() - start.getUTCFullYear()) * 12 + (end.getUTCMonth() - start.getUTCMonth());
  if (end.getUTCDate() < start.getUTCDate()) months--;
  months = Math.max(0, months);
  const years = Math.floor(months / 12);
  const rem = months % 12;
  if (years && rem) return `${years}y ${rem}m`;
  if (years) return `${years}y`;
  return `${rem}m`;
}

// Compact click-through popup for a single bar/marker/band on the timeline —
// a small label/value grid rather than a full drill-down table, since the
// point of clicking a bar is a quick fact-check, not another dashboard.
function openTimelineInfoModal(title, fields) {
  const body = el('div');
  body.appendChild(mkSummaryGrid(
    fields.filter(([, v]) => v !== undefined).map(([label, value]) => ({ label, value: value || '—' })),
    2
  ));
  openModal({ title, body });
}

// `win` ({ from, to }) clips the timeline to the selected period: only
// properties held in it, only leases/renovations/vacancies overlapping it,
// and purchase/sale markers only when they fall inside it. Without it the
// whole history is shown.
function buildPropertyLifecycleTimeline(propData, win = null) {
  const LABEL_W = 200;
  const todayStr = today();
  const tenantEnd = t => t.leaseEndDate || t.terminationDate || todayStr;
  const renoEnd   = r => r.endDate || todayStr;
  const vacEnd    = v => v.endDate || todayStr;
  const overlaps = (s, e) => !win || ((s || '') <= win.to && (e || '9999-12-31') >= win.from);

  const rows = propData
    .filter(d => d.prop.purchaseDate && overlaps(d.prop.purchaseDate, d.prop.status === 'sold' ? d.prop.soldDate : null))
    .map(d => ({
      prop: d.prop,
      tenants: listActive('tenants')
        .filter(t => t.propertyId === d.prop.id && t.leaseStartDate && t.status !== 'prospective' && overlaps(t.leaseStartDate, tenantEnd(t)))
        .sort((a, b) => (a.leaseStartDate || '').localeCompare(b.leaseStartDate || '')),
      renovations: [...(d.prop.renovationPeriods || [])].filter(r => overlaps(r.startDate, renoEnd(r))).sort((a, b) => (a.startDate || '').localeCompare(b.startDate || '')),
      vacancies: [...(d.prop.vacantPeriods || [])].filter(v => overlaps(v.startDate, vacEnd(v))).sort((a, b) => (a.startDate || '').localeCompare(b.startDate || ''))
    }))
    .sort((a, b) => (a.prop.purchaseDate || '').localeCompare(b.prop.purchaseDate || ''));

  if (rows.length === 0) return null;

  // Shared axis across every row: earliest purchase/lease/renovation/vacancy
  // start to the latest lease/renovation/vacancy/sold end (or today, for
  // anything ongoing).
  let axisStart = rows[0].prop.purchaseDate;
  let axisEnd = todayStr;
  for (const r of rows) {
    if (r.prop.purchaseDate < axisStart) axisStart = r.prop.purchaseDate;
    for (const t of r.tenants) {
      if (t.leaseStartDate < axisStart) axisStart = t.leaseStartDate;
      const e = tenantEnd(t);
      if (e > axisEnd) axisEnd = e;
    }
    for (const rp of r.renovations) {
      if (rp.startDate && rp.startDate < axisStart) axisStart = rp.startDate;
      const e = renoEnd(rp);
      if (e > axisEnd) axisEnd = e;
    }
    for (const vp of r.vacancies) {
      if (vp.startDate && vp.startDate < axisStart) axisStart = vp.startDate;
      const e = vacEnd(vp);
      if (e > axisEnd) axisEnd = e;
    }
    if (r.prop.status === 'sold' && r.prop.soldDate && r.prop.soldDate > axisEnd) axisEnd = r.prop.soldDate;
  }
  if (win) { axisStart = win.from; axisEnd = win.to; }
  const onAxis = d => !!d && d >= axisStart && d <= axisEnd;

  const parseD = s => new Date(`${s}T00:00:00Z`).getTime();
  const startMs = parseD(axisStart);
  const span = Math.max(parseD(axisEnd) - startMs, 86400000);
  const pct = s => Math.min(100, Math.max(0, ((parseD(s) - startMs) / span) * 100));

  const card = el('div', { class: 'card mb-16' });
  const swatch = color => el('span', { style: `display:inline-block;width:9px;height:9px;border-radius:2px;background:${color};margin-right:5px;vertical-align:middle` });
  card.appendChild(el('div', { class: 'card-header' },
    el('div', { class: 'card-title' }, `Property Lifecycle Timeline (${rows.length})`),
    el('div', { class: 'flex gap-16', style: 'font-size:11px;color:var(--text-muted);flex-wrap:wrap' },
      el('span', {}, swatch('var(--info)'), 'Purchased'),
      el('span', {}, swatch('var(--warning)'), 'Renovation'),
      el('span', {}, swatch('var(--text-dim)'), 'Vacant'),
      el('span', {}, swatch('var(--success)'), 'Current tenant'),
      el('span', {}, swatch('var(--warning)'), 'Terminating'),
      el('span', {}, swatch('var(--accent)'), 'Past tenant'),
      el('span', {}, swatch('var(--danger)'), 'Sold')
    )
  ));
  card.appendChild(el('div', { style: 'padding:4px 16px 4px;font-size:11px;color:var(--text-muted)' },
    'Click a property name for full details · click any bar or marker for a quick summary'
  ));

  const scroller = el('div', { style: 'max-height:560px;overflow-y:auto;padding:8px 16px 16px' });

  // ── Axis header: edge dates + internal year gridline labels ──
  const headerTrack = el('div', { style: 'flex:1;position:relative;height:18px;font-size:11px;color:var(--text-muted)' });
  headerTrack.appendChild(el('span', { style: 'position:absolute;left:0' }, fmtDate(axisStart)));
  headerTrack.appendChild(el('span', { style: 'position:absolute;right:0' }, axisEnd === todayStr ? 'Today' : fmtDate(axisEnd)));
  const startYear = new Date(`${axisStart}T00:00:00Z`).getUTCFullYear();
  const endYear = new Date(`${axisEnd}T00:00:00Z`).getUTCFullYear();
  const yearMarks = [];
  for (let y = startYear + 1; y <= endYear; y++) {
    const p = pct(`${y}-01-01`);
    if (p <= 2 || p >= 98) continue;
    yearMarks.push(p);
    headerTrack.appendChild(el('span', { style: `position:absolute;left:${p}%;transform:translateX(-50%)` }, String(y)));
  }
  scroller.appendChild(el('div', { style: 'display:flex' }, el('div', { style: `width:${LABEL_W}px;flex-shrink:0` }), headerTrack));

  // ── Rows + gridline overlay ──
  const rowsWrap = el('div', { style: 'position:relative;margin-top:4px' });
  const overlay = el('div', { style: `position:absolute;left:${LABEL_W}px;right:0;top:0;bottom:0;pointer-events:none` });
  for (const p of yearMarks) {
    overlay.appendChild(el('div', { style: `position:absolute;left:${p}%;top:0;bottom:0;width:1px;background:var(--border)` }));
  }
  rowsWrap.appendChild(overlay);

  const LANE_H = 18, LANE_GAP = 4;
  for (const { prop, tenants, renovations, vacancies } of rows) {
    const lanes = assignLanes(tenants, t => t.leaseStartDate, tenantEnd);
    const laneCount = Math.max(1, lanes.length ? Math.max(...lanes) + 1 : 1);
    const trackH = laneCount * LANE_H + (laneCount - 1) * LANE_GAP;

    const row = el('div', { style: `display:flex;align-items:flex-start;min-height:${Math.max(40, trackH + 16)}px;border-bottom:1px solid var(--border);padding:8px 0` });
    const label = el('div', { style: `width:${LABEL_W}px;flex-shrink:0;padding-right:10px;cursor:pointer` },
      el('div', { style: 'font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis' }, prop.name),
      el('div', { class: 'muted', style: 'font-size:11px' }, `Purchased ${fmtDate(prop.purchaseDate)}`)
    );
    label.onclick = () => openPropertyDetail(prop.id);
    row.appendChild(label);

    const track = el('div', { style: `flex:1;position:relative;height:${trackH}px` });

    for (const vp of vacancies) {
      const left = pct(vp.startDate);
      const width = Math.max(0.8, pct(vacEnd(vp)) - left);
      const band = el('div', {
        style: `position:absolute;left:${left}%;width:${width}%;top:0;bottom:0;cursor:pointer;background:repeating-linear-gradient(90deg,rgba(139,147,176,0.16),rgba(139,147,176,0.16) 3px,transparent 3px,transparent 7px);border-left:2px dashed var(--text-dim);border-right:2px dashed var(--text-dim)`
      });
      const endLabel = vp.endDate ? fmtDate(vp.endDate) : 'Ongoing';
      band.title = `Vacant · ${fmtDate(vp.startDate)} – ${endLabel}` + (vp.notes ? ` · ${vp.notes}` : '');
      band.onclick = () => openTimelineInfoModal(`${prop.name} — Vacant`, [
        ['Start', fmtDate(vp.startDate)],
        ['End', endLabel],
        ['Duration', durationLabel(vp.startDate, vacEnd(vp))],
        ['Notes', vp.notes]
      ]);
      track.appendChild(band);
    }

    for (const rp of renovations) {
      const left = pct(rp.startDate);
      const width = Math.max(0.8, pct(renoEnd(rp)) - left);
      const band = el('div', {
        style: `position:absolute;left:${left}%;width:${width}%;top:0;bottom:0;cursor:pointer;background:repeating-linear-gradient(45deg,var(--warning-soft),var(--warning-soft) 4px,transparent 4px,transparent 8px);border-left:2px solid var(--warning);border-right:2px solid var(--warning)`
      });
      const endLabel = rp.endDate ? fmtDate(rp.endDate) : 'Ongoing';
      band.title = `Renovation · ${fmtDate(rp.startDate)} – ${endLabel}` + (rp.notes ? ` · ${rp.notes}` : '');
      band.onclick = () => openTimelineInfoModal(`${prop.name} — Renovation`, [
        ['Start', fmtDate(rp.startDate)],
        ['End', endLabel],
        ['Duration', durationLabel(rp.startDate, renoEnd(rp))],
        ['Notes', rp.notes]
      ]);
      track.appendChild(band);
    }

    const buyLeft = pct(prop.purchaseDate);
    const buyEndForOwnership = prop.status === 'sold' && prop.soldDate ? prop.soldDate : todayStr;
    const onBuyClick = () => openTimelineInfoModal(`${prop.name} — Purchased`, [
      ['Purchase Date', fmtDate(prop.purchaseDate)],
      ['Purchase Price', prop.purchasePrice ? formatMoney(prop.purchasePrice, prop.currency, { maxFrac: 0 }) : null],
      ['Owner', getPersonName(prop.owner || 'both')],
      ['Status', PROPERTY_STATUSES[prop.status]?.label || prop.status],
      [prop.status === 'sold' ? 'Held For' : 'Owned For', durationLabel(prop.purchaseDate, buyEndForOwnership)]
    ]);
    const buyMarker = el('div', { style: `position:absolute;left:${buyLeft}%;top:0;bottom:0;width:2px;cursor:pointer;background:var(--info);transform:translateX(-1px)${onAxis(prop.purchaseDate) ? '' : ';display:none'}` });
    buyMarker.title = `Purchased ${fmtDate(prop.purchaseDate)}` + (prop.purchasePrice ? ` · ${formatMoney(prop.purchasePrice, prop.currency, { maxFrac: 0 })}` : '');
    buyMarker.onclick = onBuyClick;
    track.appendChild(buyMarker);
    const buyDot = el('div', { style: `position:absolute;left:${buyLeft}%;top:-2px;width:8px;height:8px;border-radius:50%;cursor:pointer;background:var(--info);transform:translateX(-3px);box-shadow:var(--shadow-sm)${onAxis(prop.purchaseDate) ? '' : ';display:none'}` });
    buyDot.title = buyMarker.title;
    buyDot.onclick = onBuyClick;
    track.appendChild(buyDot);

    if (prop.status === 'sold' && onAxis(prop.soldDate)) {
      const soldLeft = pct(prop.soldDate);
      const onSoldClick = () => openTimelineInfoModal(`${prop.name} — Sold`, [
        ['Sold Date', fmtDate(prop.soldDate)],
        ['Purchase Date', fmtDate(prop.purchaseDate)],
        ['Held For', durationLabel(prop.purchaseDate, prop.soldDate)]
      ]);
      const soldMarker = el('div', { style: `position:absolute;left:${soldLeft}%;top:0;bottom:0;width:2px;cursor:pointer;background:var(--danger);transform:translateX(-1px)` });
      soldMarker.title = `Sold ${fmtDate(prop.soldDate)}`;
      soldMarker.onclick = onSoldClick;
      track.appendChild(soldMarker);
      const soldDot = el('div', { style: `position:absolute;left:${soldLeft}%;top:-2px;width:8px;height:8px;border-radius:50%;cursor:pointer;background:var(--danger);transform:translateX(-3px);box-shadow:var(--shadow-sm)` });
      soldDot.title = soldMarker.title;
      soldDot.onclick = onSoldClick;
      track.appendChild(soldDot);
    }

    tenants.forEach((t, i) => {
      const dispStatus = getTenantDisplayStatus(t);
      const isCurrent = dispStatus === 'active';
      const isTerminating = dispStatus === 'terminating';
      const hasEnd = !!(t.leaseEndDate || t.terminationDate);
      const endStr = tenantEnd(t);
      const endLabel = hasEnd ? fmtDate(endStr) : 'Present';
      const left = pct(t.leaseStartDate);
      const width = Math.max(0.8, pct(endStr) - left);
      const barColor = isCurrent ? 'var(--success)' : isTerminating ? 'var(--warning)' : 'var(--accent)';
      const statusLabel = isCurrent ? 'Current tenant' : isTerminating ? 'Terminating' : 'Past tenant';
      const bar = el('div', {
        style: `position:absolute;left:${left}%;width:${width}%;top:${lanes[i] * (LANE_H + LANE_GAP)}px;height:${LANE_H}px;border-radius:4px;cursor:pointer;background:${barColor};box-shadow:var(--shadow-sm)`
      });
      bar.title = `${t.name} · ${fmtDate(t.leaseStartDate)} – ${endLabel}` +
        (t.monthlyRent ? ` · ${formatMoney(t.monthlyRent, t.currency, { maxFrac: 0 })}/mo` : '');
      bar.onclick = () => openTimelineInfoModal(`${t.name} — Tenant`, [
        ['Property', prop.name],
        ['Status', statusLabel],
        ['Lease Start', fmtDate(t.leaseStartDate)],
        ['Lease End', endLabel],
        ['Duration', durationLabel(t.leaseStartDate, endStr)],
        ['Monthly Rent', t.monthlyRent ? formatMoney(t.monthlyRent, t.currency, { maxFrac: 0 }) : null],
        ['Notes', t.notes]
      ]);
      track.appendChild(bar);
    });

    row.appendChild(track);
    rowsWrap.appendChild(row);
  }
  scroller.appendChild(rowsWrap);
  card.appendChild(scroller);
  return card;
}

// (STR Occupancy Heatmap moved to the STR Performance dashboard — analytics-str.js)

// ── Status badge helper ───────────────────────────────────────────────────────
function buildStatusBadge(status) {
  const MAP = {
    renovation: { label: '🔨 Renovation', css: 'warning' },
    vacant:     { label: '⬜ Vacant',     css: ''        },
    sold:       { label: '✓ Sold',        css: 'danger'  }
  };
  const def = MAP[status];
  if (!def) return null;
  return el('span', { class: `badge ${def.css}`, style: 'font-size:10px' }, def.label);
}

// ── Main view ─────────────────────────────────────────────────────────────────
function buildView() {
  const wrap = el('div', { class: 'view active' });

  // Header
  wrap.appendChild(el('div', { style: 'margin-bottom:16px' },
    el('h2', { style: 'margin:0 0 4px;font-size:20px;font-weight:700' }, 'Property Performance'),
    el('p',  { style: 'margin:0;font-size:13px;color:var(--text-muted)' },
      'Revenue, expenses, and profitability evaluated per property · Rental income only — see Services for invoice revenue')
  ));

  // Shared filter bar
  const filterBarEl = buildFilterBar(gF, {
    showOwner: true, showStream: true, showProperty: true, showClient: false,
    storagePrefix: 'prop', channelScope: gScope === 'all' ? null : 'company'
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

  // Everything below that doesn't depend on the tab is memoised (see
  // memoView): switching tabs only rebuilds the DOM. Recomputed on any data
  // edit, filter/scope/status change or new day.
  const viewDeps = { gF, gScope, gStatusFilter, curRange, cmpRange };
  const base = memoView('analytics-properties', viewDeps, () => {
    const cur = getData(start, end, curRange.isIncomplete);
    const cmp = cmpRange ? getData(cmpRange.start, cmpRange.end, cmpRange.isIncomplete) : null;
    const op  = getOperationalData({ propData: cur.propData, payments: cur.payments, start, end, isIncomplete: curRange.isIncomplete });
    const fin = getFinancingData(cur.allProps, asOfDate(curRange));
    return { curData: cur, cmpData: cmp, opData: op, finData: fin, insights: computePropertyInsights(cur) };
  });
  const { curData, cmpData } = base;

  const { allProps, propData, payments, opExpenses, capExpenses, totals, avgROI, best, worst } = curData;

  // Comparison line (shown on the period-based tabs only)
  const compLine = buildComparisonLine(curRange, cmpRange);

  // ── Portfolio units (Portfolio & Value tab) ───────────────────────────────
  // Properties held at the end of the selected period (bought by then, not
  // yet sold). A shared one is one unit; only its amounts are halved.
  const asOf = asOfDate(curRange);
  const heldAt = p => (!p.purchaseDate || p.purchaseDate <= asOf) && !(p.status === 'sold' && p.soldDate && p.soldDate <= asOf);
  const heldData = propData.filter(d => heldAt(d.prop));
  const sharedHeld = heldData.filter(d => d.share < 1).length;
  const unitsCard = mkKpiCard({
    label: 'Portfolio Units',
    value: String(heldData.length),
    subtitle: `held on ${fmtDate(asOf)}${sharedHeld ? ` · ${sharedHeld} shared (amounts at 50%)` : ''}`,
    onClick: () => drillDownModal('Portfolio Properties', [...toPropValueRows(heldData)].sort((a, b) => a.name.localeCompare(b.name)), PROP_VALUE_COLS)
  });

  // ── Section 2: Period Performance ─────────────────────────────────────────
  const deltaRev    = safePct(totals.rev,    cmpData?.totals.rev);
  const deltaOpEx   = safePct(totals.opEx,   cmpData?.totals.opEx);
  const deltaProfit = safePct(totals.profit, cmpData?.totals.profit);
  const deltaCapEx  = safePct(totals.capEx,  cmpData?.totals.capEx);

  const kpiRow = el('div', { class: 'grid grid-4 mb-16' });
  const revCard = kpiRow.appendChild(mkKpiCard({
    label:   'Rental Revenue',
    value:   formatEUR(totals.rev),
    delta:      deltaRev,
    compLabel:  cmpRange?.label,
    compValue:  cmpData ? formatEUR(cmpData.totals.rev) : undefined,
    onClick: () => {
      const body = el('div');
      const sorted = [...propData].filter(d => d.rev > 0).sort((a, b) => b.rev - a.rev);
      if (sorted.length) {
        body.appendChild(mkSectionLabel('Revenue by Property'));
        body.appendChild(mkModalTable(
          ['Property', 'Revenue', '% of Total'],
          sorted.map(d => [d.prop.name, formatEUR(d.rev), totals.rev > 0 ? (d.rev / totals.rev * 100).toFixed(1) + '%' : '—'])
        ));
      }
      if (cmpData) {
        const cmpSorted = [...cmpData.propData].filter(d => d.rev > 0).sort((a, b) => b.rev - a.rev);
        if (cmpSorted.length) {
          body.appendChild(el('div', { style: 'margin-top:20px' }));
          body.appendChild(mkSectionLabel(`Revenue by Property — ${cmpRange.label}`));
          body.appendChild(mkModalTable(
            ['Property', 'Revenue', '% of Total'],
            cmpSorted.map(d => [d.prop.name, formatEUR(d.rev), cmpData.totals.rev > 0 ? (d.rev / cmpData.totals.rev * 100).toFixed(1) + '%' : '—'])
          ));
        }
      }
      openModal({ title: `Rental Revenue — ${formatEUR(totals.rev)}`, body, large: true });
    }
  }));
  kpiRow.appendChild(mkKpiCard({
    label:       'Operating Expenses',
    value:       formatEUR(totals.opEx),
    delta:       deltaOpEx,
    invertDelta: true,
    compLabel:   cmpRange?.label,
    compValue:   cmpData ? formatEUR(cmpData.totals.opEx) : undefined,
    onClick:     () => openOperatingExpensesModal({ totals, opExpenses, cmpTotals: cmpData?.totals, cmpOpExpenses: cmpData?.opExpenses, cmpLabel: cmpRange?.label })
  }));
  const profitCard = kpiRow.appendChild(mkKpiCard({
    label:   'Operating Profit',
    value:   formatEUR(totals.profit),
    variant:    totals.profit >= 0 ? 'success' : 'danger',
    delta:      deltaProfit,
    compLabel:  cmpRange?.label,
    compValue:  cmpData ? formatEUR(cmpData.totals.profit) : undefined,
    onClick: () => openOperatingProfitModal({ totals, propData, cmpTotals: cmpData?.totals, cmpPropData: cmpData?.propData, cmpLabel: cmpRange?.label })
  }));
  kpiRow.appendChild(mkKpiCard({
    label:       'Property CapEx',
    value:       formatEUR(totals.capEx),
    variant:     totals.capEx > 0 ? 'warning' : '',
    delta:       deltaCapEx,
    invertDelta: true,
    compLabel:   cmpRange?.label,
    compValue:   cmpData ? formatEUR(cmpData.totals.capEx) : undefined,
    onClick:     () => openPropertyCapExModal({ totals, capExpenses, cmpTotals: cmpData?.totals, cmpCapExpenses: cmpData?.capExpenses, cmpLabel: cmpRange?.label })
  }));

  // ── Section 3: Operational KPIs ───────────────────────────────────────────
  const opData  = base.opData;
  const opKpiRow = el('div', { class: 'grid grid-4 mb-16' });

  // Occupancy Rate and Avg Nightly Rate (ADR) KPIs intentionally live only in
  // the STR Performance dashboard — Property Performance is portfolio/financial.

  // 1. Rental Yield (gross + net)
  const ryData = opData.rentalYield;
  // Compute net yield: netIncome / totalInvested * 100, averaged across props with totalInvested > 0.
  // annualizeForProperty caps each property's own denominator at its ownership span (see its comment
  // for why — otherwise "All Time" divides every property's revenue by however long the OLDEST
  // property in the portfolio has existed) and returns the raw actual figure, unprojected, for an
  // incomplete period like YTD rather than scaling partial-year data up to a full year.
  const netYieldItems = propData.filter(d => d.totalInvested > 0);
  const yieldLabel = curRange.isIncomplete ? 'Actual' : 'Annualized';
  const avgNetYield = netYieldItems.length > 0
    ? netYieldItems.reduce((sum, d) => {
        const annualNet = annualizeForProperty(d.prop, d.netIncome, curRange);
        return sum + (d.totalInvested > 0 ? (annualNet / d.totalInvested) * 100 : 0);
      }, 0) / netYieldItems.length
    : null;
  const yieldCard = opKpiRow.appendChild(mkKpiCard({
    label:   'Rental Yield',
    value:   ryData.avg !== null ? ryData.avg.toFixed(1) + '%' : '—',
    subtitle: avgNetYield !== null
      ? `Gross avg · Net: ${avgNetYield.toFixed(1)}% (${yieldLabel.toLowerCase()})`
      : `${yieldLabel} · portfolio avg`,
    variant: ryData.avg !== null ? (ryData.avg >= 5 ? 'success' : ryData.avg >= 3 ? 'warning' : 'danger') : '',
    onClick: () => {
      const body = el('div');
      if (ryData.perProp.length === 0) {
        body.appendChild(el('p', { style: 'color:var(--text-muted);font-size:13px' },
          'No properties have a purchase price recorded. Enter purchase prices to calculate rental yield.'
        ));
      } else {
        const sgrid = el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:20px' });
        sgrid.appendChild(mkSummaryBox('Gross Yield (avg)', ryData.avg !== null ? ryData.avg.toFixed(1) + '%' : '—', `${yieldLabel} revenue ÷ purchase price`));
        sgrid.appendChild(mkSummaryBox('Net Yield (avg)', avgNetYield !== null ? avgNetYield.toFixed(1) + '%' : '—', `${yieldLabel} net income ÷ total invested`));
        body.appendChild(sgrid);
        body.appendChild(mkSectionLabel('Per Property — Gross vs Net Yield'));
        // Build per-property net yield
        const perPropWithNet = [...ryData.perProp].map(y => {
          const pd = propData.find(d => d.prop.name === y.name);
          let netYieldPct = null;
          if (pd && pd.totalInvested > 0) {
            const annualNet = annualizeForProperty(pd.prop, pd.netIncome, curRange);
            netYieldPct = (annualNet / pd.totalInvested) * 100;
          }
          return { ...y, netYieldPct };
        }).sort((a, b) => (b.yieldPct ?? -Infinity) - (a.yieldPct ?? -Infinity));
        body.appendChild(mkModalTable(
          [{ label: 'Property' }, { label: curRange.isIncomplete ? 'Revenue (actual)' : 'Annual Rev (est.)', right: true }, { label: 'Purchase Price', right: true }, { label: 'Gross Yield', right: true }, { label: 'Net Yield', right: true }],
          perPropWithNet.map(y => [
            y.name,
            formatEUR(y.annualRev),
            formatEUR(y.purchase),
            y.yieldPct !== null ? y.yieldPct.toFixed(1) + '%' : '—',
            y.netYieldPct !== null ? y.netYieldPct.toFixed(1) + '%' : '—'
          ])
        ));
      }
      openModal({ title: 'Rental Yield by Property', body, large: true });
    }
  }));

  // 2. Vacancy / Dead Months
  const vacData = opData.vacancy;
  const vacancyCard = opKpiRow.appendChild(mkKpiCard({
    label:   'Vacancy / Dead Months',
    value:   `${vacData.count} property-month${vacData.count !== 1 ? 's' : ''}`,
    subtitle: vacData.count > 0 ? 'Months with zero revenue' : 'No zero-revenue months',
    variant: vacData.count === 0 ? 'success' : vacData.count <= 2 ? 'warning' : 'danger',
    onClick: () => {
      const body = el('div');
      if (vacData.count === 0) {
        body.appendChild(el('p', { style: 'color:var(--text-muted);font-size:13px' },
          'All properties had revenue in every month of the selected period.'
        ));
      } else {
        body.appendChild(mkSectionLabel('Zero-Revenue Property-Months'));
        body.appendChild(mkModalTable(
          [{ label: 'Property' }, { label: 'Month' }],
          [...vacData.details]
            .sort((a, b) => a.month.localeCompare(b.month) || a.property.localeCompare(b.property))
            .map(v => [v.property, formatMonthKey(v.month)])
        ));
      }
      openModal({ title: `Vacancy — ${vacData.count} Dead Property-Month${vacData.count !== 1 ? 's' : ''}`, body, large: true });
    }
  }));


  // Property insights (Overview tab), plus mortgages ending within a year
  const finData = base.finData;
  const signals = [...base.insights]; // copy: the memoised list is shared
  for (const d of finData.finData) {
    if (!d.financed || d.paidOff || d.yearsLeft == null || d.yearsLeft > 1) continue;
    signals.push({
      severity: 'Note',
      title: 'MORTGAGE ENDING',
      text: `"${d.prop.name}" mortgage is estimated to be paid off within ${Math.max(1, Math.round(d.yearsLeft * 12))} month(s).`,
      inspect: 'Financing',
      onClick: () => drillDownModal('Mortgage Details', toMortgageDetailRows(d), MORTGAGE_DETAIL_COLS)
    });
  }
  const banner = mkInsightsBanner(signals, 'Property Insights');

  // ── Tabs ───────────────────────────────────────────────────────────────────
  // One tab is built per render (switching rebuilds the view), so each chart
  // canvas exists once and tiles built above can be placed on any tab.
  wrap.appendChild(mkDashboardTabs(PROP_TABS, gTab, id => { gTab = id; rebuildView(); }, PROP_TAB_KEY));

  const { keys: monthKeys } = getMonthKeysForRange(start, end);
  const renders = [];

  if (gTab === 'overview') {
    if (compLine) wrap.appendChild(compLine);
    // Overview shows only today's figures — no timeline.
    // One value tile (equity underneath) beside the period figures; the full
    // value breakdown lives on the Portfolio & Value tab.
    const mvData = memoView('analytics-properties:mv-now', viewDeps, () => getMarketValueData(allProps, { timeline: false, asOf }));
    wrap.appendChild(el('div', { style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:16px' },
      buildOverviewValueCard(mvData), revCard, profitCard, yieldCard, vacancyCard));
    if (banner) wrap.appendChild(banner);
    // Needs attention (uncollected rent, empty / idle / renovation flats,
    // leases ending, data to check) — as of today, for the filtered properties.
    wrap.appendChild(buildAttentionCard(allProps, { weight: ownerWeight, onChange: rebuildView }));
  }

  if (gTab === 'performance') {
    if (compLine) wrap.appendChild(compLine);
    wrap.appendChild(kpiRow);
    wrap.appendChild(opKpiRow);
    wrap.appendChild(el('div', { class: 'card mb-16' },
      el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'Operating Profit by Property')),
      el('div', { class: 'chart-wrap tall' }, el('canvas', { id: 'prop-profit-hbar' }))
    ));
    wrap.appendChild(el('div', { class: 'card mb-16' },
      el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'Monthly Revenue vs Operating Expenses')),
      el('div', { class: 'chart-wrap tall' }, el('canvas', { id: 'prop-month-bar' }))
    ));
    wrap.appendChild(el('div', { class: 'card mb-16' },
      el('div', { class: 'card-header' },
        el('div', { class: 'card-title' }, 'Per-Property Monthly P&L Trend'),
        el('div', { style: 'font-size:12px;color:var(--text-muted)' }, 'Top 5 by revenue · Click a point for that month\'s breakdown')
      ),
      el('div', { class: 'chart-wrap tall' }, el('canvas', { id: 'prop-single-trend' }))
    ));
    const tableCard = el('div', { class: 'card mb-16' });
    tableCard.appendChild(el('div', { class: 'card-header' },
      el('div', { class: 'card-title' }, 'Property Summary'),
      el('div', { style: 'font-size:12px;color:var(--text-muted)' }, 'Click a row for every return measure and a full breakdown')
    ));
    buildSummaryTable(tableCard, propData, curRange);
    wrap.appendChild(tableCard);
    const capExImpactSection = buildCapExImpactSection({ propData, curRange });
    if (capExImpactSection) wrap.appendChild(capExImpactSection);
    renders.push(() => renderProfitHBar(curData), () => renderMonthBar(curData, monthKeys), () => renderSingleTrend(curData, monthKeys));
  }

  if (gTab === 'value') {
    const mvData = memoView('analytics-properties:mv-full', { ...viewDeps, gMvInterval }, () => getMarketValueData(allProps, { asOf, from: windowFrom(curRange) }));
    // KPI cards lead the tab: portfolio units + the four market value tiles in one row.
    wrap.appendChild(el('div', { style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin-bottom:16px' },
      unitsCard, ...buildMarketValueKpis(mvData, { purchase: true }).children));
    wrap.appendChild(buildMarketValueSection(mvData, { kpis: false }));
    wrap.appendChild(el('div', { class: 'mb-16' }, buildInvestedSplitCard()));
    wrap.appendChild(el('div', { class: 'mb-16' }, buildAcquisitionsCard(propData, asOf, windowFrom(curRange))));
    const lifecycleTimeline = buildPropertyLifecycleTimeline(propData, windowFrom(curRange) ? { from: windowFrom(curRange), to: asOf } : null);
    if (lifecycleTimeline) wrap.appendChild(lifecycleTimeline);
    renders.push(() => renderMarketValueLine(mvData), () => renderMarketValueByProp(mvData), () => renderInvestedSplitDonut({ propData: heldData }), () => renderAcquisitionsBar(propData, asOf, windowFrom(curRange)));
  }

  if (gTab === 'financing') {
    wrap.appendChild(buildFinancingSection(finData));
  }

  setTimeout(() => renders.forEach(fn => fn()), 0);
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
    onClickItem: (_label, idx) => openPropertyPLModal(sorted[idx])
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
      const mk = monthKeys[idx]?.key;
      if (!mk) return;
      const mPay = payments.filter(p => p.date?.slice(0, 7) === mk);
      const mExp = opExpenses.filter(e => e.date?.slice(0, 7) === mk);
      const mRev = mPay.reduce((s, p) => s + toEUR(p.amount, p.currency, p.date), 0);
      const mOpEx = mExp.reduce((s, e) => s + toEUR(e.amount, e.currency, e.date), 0);
      const body = el('div');
      const sgrid = el('div', { style: 'display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:20px' });
      sgrid.appendChild(mkSummaryBox('Revenue', formatEUR(mRev), null));
      sgrid.appendChild(mkSummaryBox('Operating Expenses', formatEUR(mOpEx), null));
      sgrid.appendChild(mkSummaryBox('Operating Profit', formatEUR(mRev - mOpEx), mRev > 0 ? `Margin: ${((mRev - mOpEx) / mRev * 100).toFixed(0)}%` : null));
      body.appendChild(sgrid);
      const propMap = new Map();
      mPay.forEach(p => { const n = byId('properties', p.propertyId)?.name || 'Unknown'; const x = propMap.get(p.propertyId) || { n, rev: 0, opEx: 0 }; x.rev += toEUR(p.amount, p.currency, p.date); propMap.set(p.propertyId, x); });
      mExp.forEach(e => { if (!e.propertyId) return; const n = byId('properties', e.propertyId)?.name || 'Unknown'; const x = propMap.get(e.propertyId) || { n, rev: 0, opEx: 0 }; x.opEx += toEUR(e.amount, e.currency, e.date); propMap.set(e.propertyId, x); });
      const props = [...propMap.values()].sort((a, b) => (b.rev - b.opEx) - (a.rev - a.opEx));
      if (props.length) {
        body.appendChild(mkSectionLabel('By Property'));
        body.appendChild(mkModalTable(
          [{ label: 'Property' }, { label: 'Revenue', right: true }, { label: 'OpEx', right: true }, { label: 'Profit', right: true }],
          props.map(p => [p.n, formatEUR(p.rev), formatEUR(p.opEx), formatEUR(p.rev - p.opEx)])
        ));
      }
      openModal({ title: `${label} — P&L Summary`, body, large: true });
    }
  });
}

// ── Market value & appreciation ───────────────────────────────────────────────
// Built on the recorded valuation history (property.valuations; see
// propertyValueAt in core/data.js): the latest valuation on/before a date,
// else the purchase price. Property / Stream / Owner / Status / Scope filters
// apply; the period filters don't — values are point-in-time.
// `timeline: false` skips the per-year points (only the Value tab charts them).
function getMarketValueData(allProps, { timeline: withTimeline = true, asOf = todayYmd(), from = null } = {}) {
  const now = asOf;
  const excludePersonal = gScope !== 'all';
  const metricsAt = (prop, date) => scaleBy(propertyValueMetrics(prop, date, { excludePersonal }), ownerWeight(prop), MV_MONEY);
  const current = allProps
    .map(prop => ({ prop, m: metricsAt(prop, now), valuations: propertyValuations(prop).length }))
    .filter(r => r.m);
  const sum = (rows, k) => rows.reduce((s, r) => s + (r.m[k] || 0), 0);
  const totals = {
    value:       sum(current, 'valueEUR'),
    purchase:    sum(current, 'purchaseEUR'),
    invested:    sum(current, 'investedEUR'),
    gain:        sum(current, 'gainEUR'),
    netIncome:   sum(current, 'netIncomeEUR'),
    totalReturn: sum(current, 'totalReturnEUR'),
    mortgage:    current.reduce((s, r) => s + mortgageFor(r.prop, now).remaining, 0),
    valued:      current.filter(r => r.valuations > 0).length
  };
  totals.equity = totals.value - totals.mortgage;

  // Year-on-year change like for like: only properties held both now and a
  // year earlier, so a purchase in between doesn't read as appreciation.
  const yearAgo = `${Number(now.slice(0, 4)) - 1}${now.slice(4)}`;
  let valueYearAgo = 0, valueSameNow = 0;
  for (const r of current) {
    const then = metricsAt(r.prop, yearAgo);
    if (!then) continue;
    valueYearAgo += then.valueEUR;
    valueSameNow += r.m.valueEUR;
  }
  if (!withTimeline) return { current, totals, valueYearAgo, valueSameNow, timeline: [] };

  // Points over the selected period: month ends (with the opening value the
  // day before it starts) for a period of up to two years, otherwise year
  // ends (or half-year ends) from the first purchase / period start; plus the
  // as-of date itself.
  const firstBuy = allProps.map(p => p.purchaseDate).filter(Boolean).sort()[0] || now;
  const start = from && from > firstBuy ? from : firstBuy;
  const monthly = !!from && monthsBetween(start, now) <= 24;
  const points = [];
  if (monthly) {
    const opening = addDaysYmd(start, -1);
    if (opening >= firstBuy) points.push({ label: `Start (${fmtDate(opening)})`, date: opening });
    for (let ym = start.slice(0, 7); monthEnd(ym) < now; ym = nextYm(ym)) points.push({ label: ymLabel(ym), date: monthEnd(ym) });
  } else {
    for (let y = Number(start.slice(0, 4)); y <= Number(now.slice(0, 4)); y++) {
      if (gMvInterval === 'half' && `${y}-06-30` < now && `${y}-06-30` >= start) points.push({ label: `Jun ${y}`, date: `${y}-06-30` });
      if (`${y}-12-31` < now && `${y}-12-31` >= start) points.push({ label: gMvInterval === 'half' ? `Dec ${y}` : String(y), date: `${y}-12-31` });
    }
  }
  points.push({ label: now === todayYmd() ? `Today (${now.slice(0, 4)})` : fmtDate(now), date: now });
  const timeline = points.map(pt => {
    const rows = allProps
      .map(prop => ({ prop, m: metricsAt(prop, pt.date) }))
      .filter(r => r.m);
    return { ...pt, rows, value: rows.reduce((s, r) => s + r.m.valueEUR, 0), invested: rows.reduce((s, r) => s + r.m.investedEUR, 0) };
  });

  return { current, totals, valueYearAgo, valueSameNow, timeline, monthly };
}

const MV_COLS = [
  { key: 'name',     label: 'Property' },
  { key: 'purchase', label: 'Purchase',       right: true, format: v => formatEUR(v) },
  { key: 'invested', label: 'Invested',       right: true, format: v => formatEUR(v), tip: 'Purchase + CapEx' },
  { key: 'value',    label: 'Market Value',   right: true, format: v => formatEUR(v) },
  { key: 'asOf',     label: 'Valued On',      format: v => v ? fmtDate(v) : '—' },
  { key: 'gain',     label: 'Unrealised Gain', right: true, format: v => formatEUR(v), tip: 'Market value − purchase − CapEx' },
  { key: 'gainPct',  label: 'Gain %',         right: true, format: v => v == null ? '—' : `${v.toFixed(1)}%` },
  { key: 'cagr',     label: 'Avg Yearly Growth', right: true, format: v => v == null ? '—' : `${v.toFixed(1)}%`, tip: 'Market value vs purchase price, per year owned' },
  { key: 'totalRet', label: 'Total Return %', right: true, format: v => v == null ? '—' : `${v.toFixed(1)}%`, tip: '(Unrealised gain + lifetime net rental income) / invested' }
];
function toMarketValueRows(rows) {
  return rows.map(({ prop, m }) => ({
    name: shareName(prop, ownerWeight(prop)), purchase: m.purchaseEUR, invested: m.investedEUR, value: m.valueEUR,
    asOf: m.isPurchaseValue ? '' : m.valueDate, gain: m.gainEUR, gainPct: m.gainPct, cagr: m.cagrPct, totalRet: m.totalReturnPct
  })).sort((a, b) => b.value - a.value);
}

function buildMarketValueSection(mv, { kpis = true } = {}) {
  const { current, totals, monthly } = mv;
  const section = el('div', {});
  section.appendChild(el('div', { style: 'margin:28px 0 12px' },
    el('h3', { style: 'margin:0 0 4px;font-size:16px;font-weight:700' }, 'Market Value & Appreciation'),
    el('p',  { style: 'margin:0;font-size:12px;color:var(--text-muted)' },
      `From the valuations recorded on each property (Properties → property → Market Value History); a property without one counts at its purchase price. ` +
      `${totals.valued} of ${current.length} held propert${current.length === 1 ? 'y has' : 'ies have'} a recorded valuation. ` +
      'All filters apply: the charts run over the selected period, the figures are as of its end.')
  ));

  // Chart interval toggle (same pill style as the Scope toggle)
  const intervalBar = el('div', { style: 'display:flex;align-items:center;gap:8px;margin-bottom:12px' });
  intervalBar.appendChild(el('span', { style: 'font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text-muted)' }, 'Chart points'));
  for (const [val, label] of [['year', 'Yearly'], ['half', 'Half-yearly']]) {
    const isActive = gMvInterval === val;
    const btn = el('button', {
      style: [
        'padding:4px 14px;border-radius:14px;border:1px solid;font-size:12px;cursor:pointer;transition:all 120ms',
        isActive
          ? 'border-color:var(--accent);background:var(--accent);color:#fff;font-weight:600'
          : 'border-color:var(--border);background:transparent;color:var(--text-muted)'
      ].join(';')
    }, label);
    btn.onclick = () => { if (gMvInterval !== val) { gMvInterval = val; rebuildView(); } };
    intervalBar.appendChild(btn);
  }
  // Monthly points for a short period; the interval choice applies to longer ones.
  if (!monthly) section.appendChild(intervalBar);

  if (kpis) section.appendChild(buildMarketValueKpis(mv));
  const rows = toMarketValueRows(current);

  const chartRow = el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px' });
  chartRow.appendChild(el('div', { class: 'card' },
    el('div', { class: 'card-header' },
      el('div', { class: 'card-title' }, 'Portfolio Value vs Invested'),
      el('div', { style: 'font-size:12px;color:var(--text-muted)' }, `${monthly ? 'Month-end values' : gMvInterval === 'half' ? '30 Jun & 31 Dec values' : 'Year-end values'} · click a point for the breakdown`)
    ),
    el('div', { class: 'chart-wrap' }, el('canvas', { id: 'prop-mv-line' }))
  ));
  chartRow.appendChild(el('div', { class: 'card' },
    el('div', { class: 'card-header' },
      el('div', { class: 'card-title' }, 'Market Value by Property'),
      el('div', { style: 'font-size:12px;color:var(--text-muted)' }, gMvInterval === 'half' ? '30 Jun & 31 Dec values' : 'Year-end values')
    ),
    el('div', { class: 'chart-wrap' }, el('canvas', { id: 'prop-mv-by-prop' }))
  ));
  section.appendChild(chartRow);

  if (rows.length) {
    const card = el('div', { class: 'card mb-16' });
    card.appendChild(el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'Value by Property')));
    const tw = el('div', { class: 'table-wrap' });
    tw.appendChild(mkModalTable(
      MV_COLS.map(c => ({ label: c.label, right: !!c.right, tip: c.tip })),
      rows.map(r => MV_COLS.map(c => c.format ? c.format(r[c.key]) : r[c.key]))
    ));
    card.appendChild(tw);
    section.appendChild(card);
  }
  return section;
}

// Overview's single value tile: market value vs a year ago, equity beneath.
function buildOverviewValueCard({ current, totals, valueYearAgo, valueSameNow }) {
  return mkKpiCard({
    label: 'Portfolio Market Value',
    value: formatEUR(totals.value),
    subtitle: totals.mortgage > 0 ? `Equity ${formatEUR(totals.equity)} after est. mortgage` : `Equity ${formatEUR(totals.equity)} · no mortgage`,
    delta: valueYearAgo > 0 ? safePct(valueSameNow, valueYearAgo) : null,
    compLabel: '1 year earlier (same properties)',
    compValue: valueYearAgo > 0 ? formatEUR(valueYearAgo) : undefined,
    onClick: () => drillDownModal('Portfolio Market Value', toMarketValueRows(current), MV_COLS),
    explain: { formula: 'Σ latest valuation on/before the end of the period (else purchase price); equity = value − estimated remaining mortgage', note: 'The change compares the same properties a year earlier, so purchases don\'t count as growth. Purchase price, gain and total return are on the Portfolio & Value tab.' }
  });
}

// The market value tiles (Portfolio & Value tab);
// `purchase` adds a Total Purchase Price tile first.
function buildMarketValueKpis({ current, totals, valueYearAgo, valueSameNow }, { purchase = false } = {}) {
  const pct = (a, b) => b > 0 ? (a / b) * 100 : null;
  const fmtPct = v => v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
  const rows = toMarketValueRows(current);
  const open = title => () => drillDownModal(title, rows, MV_COLS);

  const kpis = el('div', { class: 'grid grid-4 mb-16' });
  if (purchase) kpis.appendChild(mkKpiCard({
    label: 'Total Purchase Price',
    value: formatEUR(totals.purchase),
    subtitle: `${formatEUR(totals.invested)} incl. CapEx · value ${fmtPct(pct(totals.value - totals.purchase, totals.purchase))}`,
    onClick: open('Total Purchase Price'),
    explain: { formula: 'Σ purchase price of the properties held today', note: 'Each converted to EUR at the rate on its purchase date. "incl. CapEx" adds all-time renovation spend; "value" is the market value change vs purchase.' }
  }));
  kpis.appendChild(mkKpiCard({
    label: 'Portfolio Market Value',
    value: formatEUR(totals.value),
    delta: valueYearAgo > 0 ? safePct(valueSameNow, valueYearAgo) : null,
    compLabel: '1 year earlier (same properties)',
    compValue: valueYearAgo > 0 ? formatEUR(valueYearAgo) : undefined,
    onClick: open('Portfolio Market Value'),
    explain: { formula: 'Σ latest valuation on/before the end of the period (else purchase price)', note: 'The change compares the same properties a year earlier, so purchases don\'t count as growth. Sold properties drop out after their sale date.' }
  }));
  kpis.appendChild(mkKpiCard({
    label: 'Unrealised Gain',
    value: formatEUR(totals.gain),
    subtitle: `${fmtPct(pct(totals.gain, totals.invested))} vs ${formatEUR(totals.invested)} invested`,
    onClick: open('Unrealised Gain'),
    explain: { formula: 'Market value − purchase price − all-time CapEx', note: 'CapEx is subtracted so renovation spending is not counted as appreciation.' }
  }));
  kpis.appendChild(mkKpiCard({
    label: 'Total Return',
    value: formatEUR(totals.totalReturn),
    subtitle: `${fmtPct(pct(totals.totalReturn, totals.invested))} · gain ${formatEUR(totals.gain)} + income ${formatEUR(totals.netIncome)}`,
    onClick: open('Total Return'),
    explain: { formula: 'Unrealised gain + lifetime net rental income (paid revenue − operating expenses)', note: 'Shown separately — the existing ROI figures are unchanged and still exclude appreciation.' }
  }));
  kpis.appendChild(mkKpiCard({
    label: 'Equity',
    value: formatEUR(totals.equity),
    subtitle: totals.mortgage > 0 ? `Value − ${formatEUR(totals.mortgage)} est. mortgage` : 'No mortgage balance',
    onClick: open('Equity'),
    explain: { formula: 'Market value − estimated remaining mortgage', note: 'Mortgage balance is estimated from the amount, monthly payment and rate on each property (same estimate as Financing & Payoff).' }
  }));
  return kpis;
}

// ── Invested capital split (one donut, Owner / Stream switch) ─────────────────
function buildInvestedSplitCard() {
  const toggle = el('div', { class: 'flex gap-8' });
  for (const [val, label] of [['owner', 'By owner'], ['stream', 'By stream']]) {
    const isActive = gInvestedSplit === val;
    const btn = el('button', {
      type: 'button',
      style: [
        'padding:3px 12px;border-radius:14px;border:1px solid;font-size:12px;cursor:pointer',
        isActive
          ? 'border-color:var(--accent);background:var(--accent);color:#fff;font-weight:600'
          : 'border-color:var(--border);background:transparent;color:var(--text-muted)'
      ].join(';')
    }, label);
    btn.onclick = () => { if (gInvestedSplit !== val) { gInvestedSplit = val; rebuildView(); } };
    toggle.appendChild(btn);
  }
  return el('div', { class: 'card' },
    el('div', { class: 'card-header' },
      el('div', { class: 'card-title' }, 'Invested Capital Split (Purchase + All-Time CapEx)'),
      toggle
    ),
    el('div', { class: 'chart-wrap' }, el('canvas', { id: 'prop-invested-donut' }))
  );
}

function renderInvestedSplitDonut({ propData }) {
  const keyOf = d => gInvestedSplit === 'owner'
    ? (OWNERS[d.prop.owner] || d.prop.owner || 'Unknown')
    : (STREAMS[propStream(d.prop)]?.short || propStream(d.prop));
  const groups = new Map();
  propData.forEach(d => {
    if (d.totalInvested <= 0) return;
    groups.set(keyOf(d), (groups.get(keyOf(d)) || 0) + d.totalInvested);
  });
  const entries = [...groups.entries()];
  if (!entries.length) return;

  const PALETTE = ['#6366f1', '#14b8a6', '#f59e0b', '#ec4899', '#3b82f6'];
  charts.doughnut('prop-invested-donut', {
    labels: entries.map(([k]) => k),
    data:   entries.map(([, v]) => Math.round(v)),
    colors: entries.map((_, i) => PALETTE[i % PALETTE.length]),
    onClickItem: (_label, idx) => {
      const [groupLabel] = entries[idx];
      drillDownModal(`Invested Capital — ${groupLabel}`, toPropValueRows(propData.filter(d => keyOf(d) === groupLabel)), PROP_VALUE_COLS);
    }
  });
}

// ── Acquisitions over time ────────────────────────────────────────────────────
// Purchase spend per purchase year (EUR at each purchase-date rate) with the
// number of properties held at each year end (today for the current year) on
// a second axis. Only the dashboard's filters narrow it; a property without a
// purchase date can't be placed and is left out.
function acquisitionsByYear(propData, asOf = todayYmd(), from = null) {
  const now = asOf;
  const isDated = d => /^\d{4}-\d{2}-\d{2}/.test(d.prop.purchaseDate || '');
  const owned = propData.filter(d => isDated(d) && d.prop.purchaseDate <= now);
  if (!owned.length) return null;
  const firstBuy = owned.map(d => d.prop.purchaseDate).sort()[0];
  const start = from && from > firstBuy ? from : firstBuy;
  // Months for a period of up to two years, otherwise years.
  const monthly = !!from && monthsBetween(start, now) <= 24;
  const buckets = [];
  if (monthly) {
    for (let ym = start.slice(0, 7); ym <= now.slice(0, 7); ym = nextYm(ym)) buckets.push({ key: ym, label: ymLabel(ym), end: monthEnd(ym) < now ? monthEnd(ym) : now });
  } else {
    for (let y = Number(start.slice(0, 4)); y <= Number(now.slice(0, 4)); y++) buckets.push({ key: String(y), label: String(y), end: `${y}-12-31` < now ? `${y}-12-31` : now });
  }
  const inWindow = d => d.prop.purchaseDate >= start;
  const dated = owned.filter(inWindow);
  const spend = buckets.map(b => dated.filter(d => d.prop.purchaseDate.startsWith(b.key)).reduce((s, d) => s + d.purchaseEUR, 0));
  const held = buckets.map(b => owned.filter(d => d.prop.purchaseDate <= b.end && !(d.prop.status === 'sold' && d.prop.soldDate && d.prop.soldDate <= b.end)).length);
  return { buckets, monthly, spend, held, dated, undated: propData.filter(d => !isDated(d)).length };
}

const ACQ_COLS = [
  { key: 'name',     label: 'Property' },
  { key: 'owner',    label: 'Owner' },
  { key: 'stream',   label: 'Stream' },
  { key: 'pdate',    label: 'Purchase Date', format: v => fmtDate(v) },
  { key: 'purchase', label: 'Purchase (EUR)', right: true, format: v => formatEUR(v) },
  { key: 'value',    label: 'Current Value (EUR)', right: true, format: (v, r) => r.sold ? `Sold ${fmtDate(r.sold)}` : formatEUR(v), tip: 'Latest valuation on/before today, else the purchase price' }
];

function buildAcquisitionsCard(propData, asOf, from) {
  const acq = acquisitionsByYear(propData, asOf, from);
  const note = acq
    ? `Purchase spend per ${acq.monthly ? 'month' : 'year'} (EUR at each purchase-date rate) and properties held at each ${acq.monthly ? 'month' : 'year'} end · click a bar for its purchases${acq.undated ? ` · ${acq.undated} without a purchase date left out` : ''}`
    : 'No property with a purchase date matches the filters.';
  return el('div', { class: 'card' },
    el('div', { class: 'card-header' },
      el('div', {},
        el('div', { class: 'card-title' }, 'Acquisitions over Time'),
        el('div', { style: 'font-size:12px;color:var(--text-muted)' }, note))
    ),
    acq ? el('div', { class: 'chart-wrap' }, el('canvas', { id: 'prop-acq-bar' })) : null
  );
}

function renderAcquisitionsBar(propData, asOf, from) {
  const acq = acquisitionsByYear(propData, asOf, from);
  if (!acq) return;
  const now = asOf;
  charts.bar('prop-acq-bar', {
    labels: acq.buckets.map(b => b.label),
    datasets: [{ label: 'Purchase spend (EUR)', data: acq.spend.map(v => Math.round(v)), backgroundColor: '#6366f1' }],
    overlayLine: { label: 'Properties held', data: acq.held, color: '#e4e8f1', stepped: false },
    onClickItem: (label, idx) => {
      const bought = acq.dated.filter(d => d.prop.purchaseDate.startsWith(acq.buckets[idx].key));
      if (!bought.length) return;
      const rows = bought.sort((a, b) => a.prop.purchaseDate.localeCompare(b.prop.purchaseDate)).map(d => {
        const sold = d.prop.status === 'sold' && d.prop.soldDate && d.prop.soldDate <= now ? d.prop.soldDate : '';
        return {
          name: shareName(d.prop, ownerWeight(d.prop)),
          owner: OWNERS[d.prop.owner] || d.prop.owner || '—',
          stream: STREAMS[propStream(d.prop)]?.short || propStream(d.prop),
          pdate: d.prop.purchaseDate,
          purchase: d.purchaseEUR,
          value: sold ? null : ((propertyValueMetrics(d.prop, now, { excludePersonal: gScope !== 'all' })?.valueEUR ?? d.purchaseEUR / (d.share || 1)) * d.share),
          sold
        };
      });
      drillDownModal(`Acquisitions — ${label}`, rows, ACQ_COLS);
    }
  });
}

function renderMarketValueLine({ timeline }) {
  if (!timeline.some(t => t.value > 0)) return;
  charts.line('prop-mv-line', {
    labels: timeline.map(t => t.label),
    datasets: [
      { label: 'Market Value (EUR)', data: timeline.map(t => Math.round(t.value)), borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,0.1)', tension: 0 },
      { label: 'Invested (EUR)',     data: timeline.map(t => Math.round(t.invested)), borderColor: '#f59e0b', backgroundColor: 'rgba(245,158,11,0.05)', fill: false, tension: 0, borderDash: [5, 4] }
    ],
    onClickItem: (_label, idx) => {
      const t = timeline[idx];
      if (t?.rows.length) drillDownModal(`Portfolio Value — ${t.label}`, toMarketValueRows(t.rows), MV_COLS);
    }
  });
}

function renderMarketValueByProp({ timeline, current }) {
  // Every property with history in range — held ones first, then any sold since
  const seen = new Map();
  for (const r of current) seen.set(r.prop.id, r.prop);
  for (const t of timeline) for (const r of t.rows) if (!seen.has(r.prop.id)) seen.set(r.prop.id, r.prop);
  const all = [...seen.values()];
  if (!all.length) return;
  const PALETTE = ['#6366f1','#8b5cf6','#14b8a6','#f59e0b','#ec4899','#3b82f6','#10b981','#ef4444','#06b6d4','#84cc16'];
  charts.line('prop-mv-by-prop', {
    labels: timeline.map(t => t.label),
    datasets: all.map((prop, i) => ({
      label: prop.name,
      data: timeline.map(t => { const r = t.rows.find(x => x.prop.id === prop.id); return r ? Math.round(r.m.valueEUR) : null; }),
      borderColor: PALETTE[i % PALETTE.length],
      backgroundColor: 'transparent',
      fill: false,
      tension: 0,
      spanGaps: false
    }))
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
  kpiRow.appendChild(mkKpiCard({
    label: 'Total Outstanding Debt', value: formatEUR(t.totalDebt),
    onClick: () => drillDownModal('Debt by Property', toFinancingDrillRows(finData.finData), FINANCING_DRILL_COLS)
  }));
  kpiRow.appendChild(mkKpiCard({
    label: 'Leverage Ratio',
    value: t.leverageRatio != null ? t.leverageRatio.toFixed(1) + '%' : '—',
    variant: t.leverageRatio != null && t.leverageRatio > 60 ? 'danger' : t.leverageRatio != null && t.leverageRatio > 30 ? 'warning' : undefined,
    onClick: () => drillDownModal('Portfolio Leverage', toFinancingDrillRows(finData.finData), FINANCING_DRILL_COLS)
  }));
  kpiRow.appendChild(mkKpiCard({
    label: 'Monthly Debt Burden', value: formatEUR(t.totalMonthly),
    onClick: () => drillDownModal('Active Mortgages', toFinancingDrillRows(active), FINANCING_DRILL_COLS)
  }));
  kpiRow.appendChild(mkKpiCard({
    label: 'Avg Years to Payoff',
    value: t.avgYearsLeft != null ? t.avgYearsLeft.toFixed(1) + ' yrs' : '—',
    onClick: () => drillDownModal('Years to Payoff', toFinancingDrillRows(active), FINANCING_DRILL_COLS)
  }));
  section.appendChild(kpiRow);

  const statsWrap = el('div', { style: 'display:flex;gap:12px;flex-wrap:wrap;margin-bottom:16px' });
  [
    [String(t.nFinanced), 'Mortgaged Properties', `${t.nActive} active · ${t.nFinanced - t.nActive} paid off`, finData.finData.filter(d => d.financed)],
    [String(t.nPaidOff),  'No Mortgage',          'Cash purchase or fully paid',                                finData.finData.filter(d => !d.financed)]
  ].forEach(([count, label, sub, bucket]) => {
    const box = el('div', {
      class: 'card',
      style: 'flex:1;min-width:160px;padding:12px 16px;cursor:pointer',
      title: 'Click to see properties'
    },
      el('div', { style: 'font-size:22px;font-weight:700;line-height:1;margin-bottom:2px' }, count),
      el('div', { style: 'font-size:12px;font-weight:600' }, label),
      el('div', { style: 'font-size:11px;color:var(--text-muted);margin-top:2px' }, sub)
    );
    box.onclick = () => drillDownModal(label, toFinancingDrillRows(bucket), FINANCING_DRILL_COLS);
    statsWrap.appendChild(box);
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
  attachSortFilter(tableWrap, { initialCol: _finSortCol, initialDir: _finSortDir, initialSearch: _finSearch, onSortChange: (c, d) => { _finSortCol = c; _finSortDir = d; }, onSearchChange: v => { _finSearch = v; } });
}

// ── Chart: Per-property Monthly P&L Trend ────────────────────────────────────
function renderSingleTrend({ propData, payments, opExpenses }, monthKeys) {
  if (!monthKeys.length || !propData.length) return;

  // Top 5 by revenue
  const TOP_N   = 5;
  const topData = [...propData]
    .filter(d => d.rev > 0 || d.opEx > 0)
    .sort((a, b) => b.rev - a.rev)
    .slice(0, TOP_N);

  if (!topData.length) return;

  const PALETTE = ['#6366f1', '#14b8a6', '#f59e0b', '#ec4899', '#3b82f6'];

  // Build per-property per-month net profit
  const datasets = topData.map((d, i) => {
    const revByMonth = new Map();
    const expByMonth = new Map();
    // d.propPayments / d.propOpExpenses are this property's slice of the
    // same payments/opExpenses (pre-grouped in getData) — no re-filtering.
    d.propPayments  .forEach(p => { const mk = p.date?.slice(0, 7); if (mk) revByMonth.set(mk, (revByMonth.get(mk) || 0) + toEUR(p.amount, p.currency, p.date)); });
    d.propOpExpenses.forEach(e => { const mk = e.date?.slice(0, 7); if (mk) expByMonth.set(mk, (expByMonth.get(mk) || 0) + toEUR(e.amount, e.currency, e.date)); });

    const color = PALETTE[i % PALETTE.length];
    return {
      label:           d.prop.name,
      data:            monthKeys.map(m => {
        const rev  = revByMonth.get(m.key) || 0;
        const opEx = expByMonth.get(m.key) || 0;
        return Math.round(rev - opEx);
      }),
      borderColor:     color,
      backgroundColor: color + '22',
      fill:            false,
      tension:         0.3
    };
  });

  charts.line('prop-single-trend', {
    labels:   monthKeys.map(m => m.label),
    datasets,
    onClickItem: (_label, idx) => {
      const mk = monthKeys[idx]?.key;
      if (!mk) return;
      const body = el('div');
      const allRevByProp  = new Map();
      const allOpExByProp = new Map();
      payments   .filter(p => p.date?.slice(0, 7) === mk).forEach(p => { const n = byId('properties', p.propertyId)?.name || 'Unknown'; allRevByProp .set(n, (allRevByProp .get(n) || 0) + toEUR(p.amount,   p.currency, p.date)); });
      opExpenses .filter(e => e.date?.slice(0, 7) === mk).forEach(e => { if (!e.propertyId) return; const n = byId('properties', e.propertyId)?.name || 'Unknown'; allOpExByProp.set(n, (allOpExByProp.get(n) || 0) + toEUR(e.amount, e.currency, e.date)); });

      const propNames = new Set([...allRevByProp.keys(), ...allOpExByProp.keys()]);
      const rows = [...propNames].map(n => {
        const rev  = allRevByProp .get(n) || 0;
        const opEx = allOpExByProp.get(n) || 0;
        return { name: n, rev, opEx, net: rev - opEx };
      }).sort((a, b) => b.net - a.net);

      const mRev   = rows.reduce((s, r) => s + r.rev,  0);
      const mOpEx  = rows.reduce((s, r) => s + r.opEx, 0);
      const sgrid  = el('div', { style: 'display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:20px' });
      sgrid.appendChild(mkSummaryBox('Revenue',        formatEUR(mRev),  null));
      sgrid.appendChild(mkSummaryBox('Operating Exp.', formatEUR(mOpEx), null));
      sgrid.appendChild(mkSummaryBox('Net Profit',     formatEUR(mRev - mOpEx), mRev > 0 ? `Margin: ${((mRev - mOpEx) / mRev * 100).toFixed(0)}%` : null));
      body.appendChild(sgrid);

      if (rows.length) {
        body.appendChild(mkSectionLabel('All Properties'));
        body.appendChild(mkModalTable(
          [{ label: 'Property' }, { label: 'Revenue', right: true }, { label: 'OpEx', right: true }, { label: 'Net', right: true }],
          rows.map(r => [r.name, formatEUR(r.rev), formatEUR(r.opEx), formatEUR(r.net)])
        ));
      }
      openModal({ title: `${formatMonthKey(mk)} — Property P&L Breakdown`, body, large: true });
    }
  });
}

// ── Summary table — one row per property ──────────────────────────────────────
function buildSummaryTable(container, propData, curRange) {
  if (propData.length === 0) {
    container.appendChild(el('div', { class: 'empty' }, 'No properties match the selected filters'));
    return;
  }

  // Net Yield and Annualized ROI are the table's return measures; Simple,
  // Run-Rate and Cash-on-Cash ROI and Steady-State Yield are in the row's
  // summary (openPropertySummaryModal).
  const hasAnnROI        = propData.some(d => d.annualizedROI   !== null);
  const hasExpectedBooked = propData.some(d => d.expectedBookedEUR !== null);

  const COLS = [
    { key: 'name',      label: 'Property',          tip: 'Property name. Click a row for a full breakdown of these figures.' },
    { key: 'stream',    label: 'Stream',             tip: 'Short-term (Airbnb-style nightly rental) or long-term (leased) rental.' },
    { key: 'owner',     label: 'Owner',              tip: 'Which owner this property is attributed to.' },
    { key: 'status',    label: 'Status',             tip: 'Active, renovation, vacant, or sold — affects how figures for this period should be read.' },
    { key: 'rev',       label: 'Revenue',            right: true, fmt: formatEUR, tip: 'Sum of paid payments for this property in the selected period.' },
    ...(hasExpectedBooked ? [{ key: 'expectedBookedEUR', label: 'Expected Rev (booked)', right: true, fmt: v => v != null ? formatEUR(v) : '—', tip: 'Only shown for a future period. What’s already booked/scheduled — pending Airbnb reservations, or active-lease rent — not a full prediction.' }] : []),
    { key: 'opEx',      label: 'Operating Exp.',     right: true, fmt: formatEUR, tip: 'Non-capital expenses (excludes renovation/CapEx) in the selected period.' },
    { key: 'profit',    label: 'Op. Profit',         right: true, fmt: formatEUR, colored: true, tip: 'Revenue minus Operating Expenses.' },
    { key: 'capEx',     label: 'CapEx',              right: true, fmt: formatEUR, tip: 'Capital/renovation expenses in the selected period.' },
    { key: 'net',       label: 'Net (after CapEx)',  right: true, fmt: formatEUR, colored: true, tip: 'Revenue minus Operating Expenses minus CapEx for the selected period.' },
    { key: 'costRatio', label: 'Cost %',             right: true, fmt: v => v != null ? v.toFixed(0) + '%' : '—', tip: 'Operating Expenses as a percentage of Revenue.' },
    { key: 'netYield',  label: 'Net Yield',          right: true, colored: true, fmt: v => v != null ? v.toFixed(1) + '%' : '—', tip: 'Net income for the period (annualized for a full past period, actual so far for an in-progress one) ÷ total invested — same basis as the Rental Yield tile.' },
    ...(hasAnnROI       ? [{ key: 'annualizedROI', label: 'Ann. ROI',         right: true, colored: true, fmt: v => v != null ? v.toFixed(1) + '%' : '—', tip: 'Simple ROI divided by years owned since purchase — average annual return per year of ownership (lifetime average, not this year\'s figure).' }] : [])
  ];

  const sorted = [...propData]
    .map(d => ({
      ...d,
      costRatio: d.rev > 0 ? (d.opEx / d.rev) * 100 : null,
      netYield: d.totalInvested > 0 ? (annualizeForProperty(d.prop, d.netIncome, curRange) / d.totalInvested) * 100 : null
    }))
    .sort((a, b) => b.profit - a.profit);

  const table = el('table', { class: 'table' });
  const htr   = el('tr');
  COLS.forEach(col => htr.appendChild(mkTh(col)));
  table.appendChild(el('thead', {}, htr));

  const tbody = el('tbody');
  for (const d of sorted) {
    const sm = STREAMS[propStream(d.prop)];
    const propStatus = d.prop.status || 'active';
    const tr = el('tr', { style: 'cursor:pointer', title: 'Click for property summary' });
    tr.onclick = () => openPropertySummaryModal(d);
    COLS.forEach(col => {
      const td = el('td', { class: col.right ? 'right num' : '' });
      if (col.key === 'name') {
        td.textContent = d.prop.name;
        if (propStatus !== 'active') {
          const badge = buildStatusBadge(propStatus);
          if (badge) { td.appendChild(document.createTextNode(' ')); td.appendChild(badge); }
        }
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
  attachSortFilter(tableWrap, { initialCol: _sumSortCol, initialDir: _sumSortDir, initialSearch: _sumSearch, onSortChange: (c, d) => { _sumSortCol = c; _sumSortDir = d; }, onSearchChange: v => { _sumSearch = v; } });
}
