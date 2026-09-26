// STR Performance Dashboard — portfolio summary, property spotlight, forward pipeline
import { el, openModal, fmtDate, drillDownModal } from '../core/ui.js';
import * as charts from '../core/charts.js';
import { state } from '../core/state.js';
import { formatEUR, toEUR, listActive, listActivePayments, byId, isReservationNight, companyPropIds, isCompanyRecord } from '../core/data.js';
import { todayYmd, addDaysYmd, parseYmd, utcYmd, diffDaysYmd } from '../core/dates.js';
import { isOwnerBlockSummary } from '../core/ical.js';
import {
  createFilterState, getCurrentPeriodRange, getComparisonRange,
  getMonthKeysForRange, makeMatchers, buildFilterBar, buildComparisonLine
} from './analytics-filters.js';
import {
  mkKpiCard, mkSummaryGrid, mkSummaryBox, mkModalTable, mkSectionLabel,
  mkEmptyState, mkVarianceBadge, mkProgressBar, fmtK, safePct, mkTh, mkDrillValue,
  mkCmpGrid
} from './analytics-helpers.js';

// ── Constants ─────────────────────────────────────────────────────────────────
const CHART_IDS = ['str-rev-trend', 'str-spotlight-adr', 'str-spotlight-occ'];
const PROP_COLORS = ['#6366f1','#14b8a6','#f59e0b','#ec4899','#22c55e'];

// Reused drill-down column shapes (same fields already used by the file's
// existing drillDownModal calls — heatmap/month-revenue/month-spotlight footers).
// A payment's amount in EUR at its own date (HUF-safe). Amounts are signed —
// Airbnb adjustment rows may be negative — and are summed as-is.
const payEUR = p => toEUR(p.amount, p.currency, p.date);
const AMOUNT_COL = { key: 'amount', label: 'Amount', right: true, tip: 'Paid amount for this record, in EUR.', format: (_v, row) => formatEUR(payEUR(row)) };

const BOOKING_COLS = [
  { key: 'date', label: 'Date', tip: 'Payment date.', format: v => fmtDate(v) },
  { key: 'airbnbNights', label: 'Nights', right: true, tip: 'Nights booked on this payment record.', format: v => v != null ? String(v) : '—' },
  AMOUNT_COL
];
const BOOKING_COLS_WITH_PROPERTY = [
  { key: 'date', label: 'Date', tip: 'Payment date.', format: v => fmtDate(v) },
  { key: 'propertyId', label: 'Property', tip: 'Property this booking is attributed to.', format: v => shortName(byId('properties', v)?.name || '—') },
  { key: 'airbnbNights', label: 'Nights', right: true, tip: 'Nights booked on this payment record.', format: v => v != null ? String(v) : '—' },
  AMOUNT_COL
];

// ── State ─────────────────────────────────────────────────────────────────────
let gF = createFilterState({ period: 'this-year', compareTo: 'prev-year' });
let gScope = 'company'; // 'company' | 'all' — same Scope rule as the other dashboards
let gSpotlightPropId = null;

// ── Module export ─────────────────────────────────────────────────────────────
export default {
  id: 'analytics-str',
  label: 'STR Performance',
  icon: '🏖️',
  render(container) { container.appendChild(buildView()); },
  refresh() { rebuildView(); },
  destroy() { CHART_IDS.forEach(id => charts.destroy(id)); }
};

// ── Data helpers ──────────────────────────────────────────────────────────────
// All short-term properties (unfiltered — used to build filter options).
function allStrProps() {
  return listActive('properties').filter(p => p.type === 'short_term');
}
// Short-term properties passing the active owner / property dimension filters.
// Everything downstream (portfolio, pipeline, spotlight) builds on this, so the
// filters flow through the whole dashboard.
// Company scope keeps only company-channel properties (channel unset =
// company), like the other dashboards' Scope toggle.
function getStrProps() {
  const { mOwner } = makeMatchers(gF);
  return allStrProps().filter(p =>
    mOwner(p) && (!gF.propertyIds.size || gF.propertyIds.has(p.id)) &&
    (gScope === 'all' || (p.channel || 'company') === 'company')
  );
}

// Paid STR payments inside an inclusive [start,end] date range, restricted to
// the supplied property ids and the Scope (company scope drops payments
// flagged `personal` — isCompanyRecord(), same matcher as the other dashboards).
function getPaymentsInRange(start, end, propIds) {
  const coPropIds = gScope === 'all' ? null : companyPropIds();
  return listActivePayments().filter(p =>
    p.stream === 'short_term_rental' &&
    p.status === 'paid' &&
    (p.date || '') >= start && (p.date || '') <= end &&
    p.propertyId && propIds.has(p.propertyId) &&
    (!coPropIds || isCompanyRecord(p, coPropIds))
  );
}

// ── Per-render caches ─────────────────────────────────────────────────────────
// Paid STR payments grouped by property, plus lazily-built per-property
// occupancy sets and ADR suggesters — rebuilt only when the data changes
// (state.db identity / state.editSeq / the memoized payments array), instead
// of rescanning every payment once per property per helper on every render.
let _strCache = null;
function strCache() {
  const pays = listActivePayments();
  if (_strCache && _strCache.db === state.db && _strCache.seq === state.editSeq && _strCache.pays === pays) return _strCache;
  const paidByProp = new Map();
  for (const p of pays) {
    if (p.stream !== 'short_term_rental' || p.status !== 'paid' || !p.propertyId) continue;
    let arr = paidByProp.get(p.propertyId);
    if (!arr) { arr = []; paidByProp.set(p.propertyId, arr); }
    arr.push(p);
  }
  _strCache = { db: state.db, seq: state.editSeq, pays, paidByProp, occ: new Map(), adr: new Map() };
  return _strCache;
}
// All paid STR payments of one property (unscoped — physical stays).
function paidStrPays(propId) {
  return strCache().paidByProp.get(propId) || [];
}

// Calls fn(ymd) for every night in [from, toExcl) — pure calendar arithmetic
// on 'YYYY-MM-DD' strings (check-in inclusive, check-out exclusive), so the
// same stay lands on the same days whatever the viewer's timezone.
function eachNight(from, toExcl, fn) {
  if (!from || !toExcl) return;
  const d = parseYmd(from), e = parseYmd(toExcl);
  while (d < e) { fn(utcYmd(d)); d.setUTCDate(d.getUTCDate() + 1); }
}

function getTargetADR(propertyId, monthKey) {
  const targets = state.db.strRateTargets || [];
  return targets.find(t => t.propertyId === propertyId && t.month === monthKey) || null;
}

function getCalendar(propertyId) {
  return (state.db.strCalendars || []).find(c => c.propertyId === propertyId) || null;
}

function daysInMonth(year, monthIdx) {
  return new Date(year, monthIdx + 1, 0).getDate();
}

// Nights actually sold for a payment record — 0 for Airbnb payout adjustments
// (Resolution Adjustment, Resolution Payout, Cancellation Fee, Adjustment),
// which repeat the same check-in/check-out as their originating Reservation
// and would otherwise double-count nights and skew ADR wherever summed.
// Off-platform stays have no airbnbNights — derive them from the stay dates.
function stayDates(p) {
  return { ci: p.airbnbCheckIn || p.checkIn || '', co: p.airbnbCheckOut || p.checkOut || '' };
}
function bookedNights(p) {
  if (!isReservationNight(p)) return 0;
  if (p.airbnbNights) return p.airbnbNights;
  const { ci, co } = stayDates(p);
  return ci && co && co > ci ? diffDaysYmd(ci, co) : 0;
}
// Nights of a booking that fall inside `range` ({ start, end } inclusive),
// by STAY date — a 28 Aug → 5 Sep stay paid out in August is 4 nights in
// August and 4 in September, matching how occupancy counts it. A record with
// no stay dates falls back to its payout date. No range → all its nights.
function nightsInRange(p, range) {
  const n = bookedNights(p);
  if (!range || n === 0) return n;
  const { ci, co } = stayDates(p);
  if (!(ci && co && co > ci)) return (p.date || '') >= range.start && (p.date || '') <= range.end ? n : 0;
  const from = ci > range.start ? ci : range.start;
  const toExcl = co < addDaysYmd(range.end, 1) ? co : addDaysYmd(range.end, 1);
  return toExcl > from ? diffDaysYmd(from, toExcl) : 0;
}
// Per-night revenue: the recorded average nightly rate, else payout ÷ nights.
function nightlyRate(p) {
  if (p.avgNightlyRate) return p.avgNightlyRate;
  const n = bookedNights(p);
  return n > 0 ? (Number(p.amount) || 0) / n : 0;
}
function sumNights(payments, range = null) {
  return payments.reduce((s, p) => s + nightsInRange(p, range), 0);
}
function sumNightRevenue(payments, range = null) {
  return payments.reduce((s, p) => s + toEUR(nightlyRate(p) * nightsInRange(p, range), p.currency, p.date), 0);
}
// Paid STR bookings whose STAY overlaps [start, end] (or, without stay dates,
// whose payout date does) — the set nights and ADR are counted from, while
// revenue stays on the payout date (getPaymentsInRange).
function getStayPaymentsInRange(start, end, propIds) {
  const coPropIds = gScope === 'all' ? null : companyPropIds();
  return listActivePayments().filter(p => {
    if (p.stream !== 'short_term_rental' || p.status !== 'paid' || !p.propertyId || !propIds.has(p.propertyId)) return false;
    if (coPropIds && !isCompanyRecord(p, coPropIds)) return false;
    const { ci, co } = stayDates(p);
    if (ci && co && co > ci) return ci <= end && co > start;
    return (p.date || '') >= start && (p.date || '') <= end;
  });
}

// Split iCal blocks into { reserved, owner } date sets (each [start,end) → nights).
function buildBlockDateSets(blocks) {
  const reserved = new Set(), owner = new Set();
  for (const b of blocks || []) {
    if (!b.start || !b.end) continue;
    const target = isOwnerBlockSummary(b.summary) ? owner : reserved;
    eachNight(b.start, b.end, ds => target.add(ds));
  }
  return { reserved, owner };
}

// Booked nights from paid bookings' check-in → check-out (covers off-platform
// sales recorded as payments, and past stays the Airbnb iCal no longer carries).
function buildBookedDateSet(propId) {
  const set = new Set();
  paidStrPays(propId).forEach(p => {
    // Payout adjustments (Cancellation Fee, Resolution…) repeat their
    // reservation's dates — same exclusion as bookedNights(), so a cancelled
    // stay's fee row can't mark its nights occupied.
    if (!isReservationNight(p)) return;
    const ci = p.airbnbCheckIn || p.checkIn, co = p.airbnbCheckOut || p.checkOut;
    eachNight(ci, co, ds => set.add(ds));
  });
  return set;
}

// Occupancy sets for a property:
//   occupiedSet  — booked (payments) ∪ "Reserved" iCal nights (revenue nights)
//   ownerBlockSet — manually-closed nights, EXCLUDED from available (you can't
//                   sell a day you closed). A payment on such a day wins (it
//                   becomes occupied), so off-platform sales count normally.
// Cached per property (see strCache) while the data and the calendar's blocks
// array are unchanged. Callers must treat the returned sets as read-only.
const NO_BLOCKS = Object.freeze([]);
function buildOccupancySets(propId, blocks) {
  if (!blocks || !blocks.length) blocks = NO_BLOCKS; // stable cache key for "no calendar"
  const c = strCache();
  const hit = c.occ.get(propId);
  if (hit && hit.blocks === blocks) return hit.sets;
  const { reserved, owner } = buildBlockDateSets(blocks);
  const occupiedSet = buildBookedDateSet(propId);
  for (const d of reserved) occupiedSet.add(d);
  const sets = { occupiedSet, ownerBlockSet: owner };
  c.occ.set(propId, { blocks, sets });
  return sets;
}

// Iterate each day in [start,end] inclusive. Occupancy = occupied ÷ available,
// where available excludes owner-blocked days that weren't sold. Returns counts,
// per-month tallies, and (if rateFn given) published-rate revenue over occupied days.
function rangeOccupancy(occupiedSet, ownerBlockSet, start, end, rateFn) {
  let totalDays = 0, available = 0, occupied = 0, blocked = 0, rev = 0;
  const occByMonth = new Map(), availByMonth = new Map();
  eachNight(start, addDaysYmd(end, 1), ds => {
    const mk = ds.slice(0, 7);
    totalDays++;
    const isOcc     = occupiedSet.has(ds);
    const isUnavail = !isOcc && ownerBlockSet.has(ds); // payment/reservation wins
    if (isUnavail) { blocked++; }
    else { available++; availByMonth.set(mk, (availByMonth.get(mk) || 0) + 1); }
    if (isOcc) {
      occupied++;
      occByMonth.set(mk, (occByMonth.get(mk) || 0) + 1);
      if (rateFn) rev += rateFn(ds, false);
    }
  });
  return { totalDays, available, occupied, blocked, occByMonth, availByMonth, rev };
}

// Historic achieved-ADR suggester for a property — same priority as the daily-
// rate feed: same calendar day across prior years → same month → overall average.
function buildAdrSuggester(propId) {
  const cache = strCache().adr;
  if (cache.has(propId)) return cache.get(propId);
  const byMonthDay = new Map(), byMonth = new Map(), all = [];
  paidStrPays(propId).forEach(p => {
    // Exclude Airbnb payout adjustments (Resolution Adjustment, Cancellation Fee,
    // etc.) — they repeat the same check-in/check-out/nights as their originating
    // Reservation but carry a much smaller amount, which would pollute the
    // historic per-night rate buckets with a tiny, unrelated rate.
    if (!isReservationNight(p)) return;
    const rawRate = p.avgNightExclCleaning != null ? p.avgNightExclCleaning
                  : (p.avgNightlyRate != null ? p.avgNightlyRate : null);
    if (rawRate == null || rawRate <= 0) return;
    const rate = toEUR(rawRate, p.currency, p.date); // EUR, like every figure on this page
    const ci = p.airbnbCheckIn || p.checkIn, co = p.airbnbCheckOut || p.checkOut;
    eachNight(ci, co, ds => {
      const md = ds.slice(5), mo = ds.slice(5, 7);
      (byMonthDay.get(md) || byMonthDay.set(md, []).get(md)).push(rate);
      (byMonth.get(mo)    || byMonth.set(mo, []).get(mo)).push(rate);
      all.push(rate);
    });
  });
  const avg = a => a.reduce((s, r) => s + r, 0) / a.length;
  const overall = all.length ? avg(all) : null;
  const fn = (date) => {
    const md = byMonthDay.get(date.slice(5));   if (md && md.length) return avg(md);
    const mo = byMonth.get(date.slice(5, 7));   if (mo && mo.length) return avg(mo);
    return overall;
  };
  cache.set(propId, fn);
  return fn;
}

// Published nightly rate for a property on a date — mirrors the daily-rate feed:
// confirmed target ADR (optionally after promo discount) when set, otherwise the
// historic suggestion. Keeps dashboard revenue tied to the rates we actually push
// instead of zeroing months that have no confirmed target.
function makeRateForNight(propId) {
  const globalDisc = state.db.settings?.airbnb?.globalDiscountPct ?? 0;
  const suggest = buildAdrSuggester(propId);  // already EUR
  const ccy = byId('properties', propId)?.currency || 'EUR'; // targets are set in the property's currency
  return (date, applyDiscount) => {
    const t = getTargetADR(propId, date.slice(0, 7));
    if (t) {
      const disc = (t.discountPct != null ? t.discountPct : globalDisc) / 100;
      return toEUR((t.targetADR || 0) * (applyDiscount ? (1 - disc) : 1), ccy, date);
    }
    return suggest(date) || 0;
  };
}

// ── Portfolio-level data ──────────────────────────────────────────────────────
function getPortfolioData(curRange, cmpRange) {
  const props    = getStrProps();
  const propIds  = new Set(props.map(p => p.id));
  const payments = getPaymentsInRange(curRange.start, curRange.end, propIds);
  const monthKeys = getMonthKeysForRange(curRange.start, curRange.end).keys;
  const keyIndex = new Map(monthKeys.map((k, i) => [k.key, i]));

  // Revenue per property
  const revByProp = new Map();
  props.forEach(p => revByProp.set(p.id, 0));
  payments.forEach(p => {
    if (p.propertyId) revByProp.set(p.propertyId, (revByProp.get(p.propertyId) || 0) + payEUR(p));
  });
  const totalRev = [...revByProp.values()].reduce((s, v) => s + v, 0);

  // Revenue by month-key (for trend chart) — one object per month in the range.
  const revByMonth = monthKeys.map(() => ({}));
  payments.forEach(p => {
    const mk  = (p.date || '').slice(0, 7);
    const idx = keyIndex.get(mk);
    if (idx != null && p.propertyId) {
      revByMonth[idx][p.propertyId] = (revByMonth[idx][p.propertyId] || 0) + payEUR(p);
    }
  });

  // Nights sold & ADR by STAY date (the same basis as occupancy): bookings
  // whose stay overlaps the range, counting only the nights inside it.
  const nightRange = { start: curRange.start, end: curRange.end };
  const stayPays = getStayPaymentsInRange(curRange.start, curRange.end, propIds);
  let totalNights = 0;
  let nightsWithADR = 0;
  let adrSum = 0;
  stayPays.forEach(p => {
    const n = nightsInRange(p, nightRange);
    totalNights += n;
    const rate = nightlyRate(p);
    if (n > 0 && rate) { adrSum += toEUR(rate * n, p.currency, p.date); nightsWithADR += n; }
  });
  const avgADR = nightsWithADR > 0 ? adrSum / nightsWithADR : 0;

  // Occupancy: blocked nights from iCal vs total days, range-accurate (the range
  // may start / end mid-month). Keep a per-month blocked tally for the target calc.
  const occByProp = new Map();
  const targetRevByProp = new Map();
  const occByMonth = new Map(), availByMonth = new Map();
  let targetRev = 0;
  props.forEach(p => {
    const cal = getCalendar(p.id);
    const { occupiedSet, ownerBlockSet } = buildOccupancySets(p.id, cal?.blocks || []);
    const rateForNight = makeRateForNight(p.id);
    // Expected ("target") revenue values each occupied night at the published
    // rate (confirmed target if set, else historic suggestion) — no more €0 for
    // properties/months without a confirmed target.
    const { available, occupied, blocked, rev, occByMonth: propOccByMonth, availByMonth: propAvailByMonth } =
      rangeOccupancy(occupiedSet, ownerBlockSet, curRange.start, curRange.end, rateForNight);
    occByProp.set(p.id, { occupied, available, blocked, open: Math.max(0, available - occupied), pct: available > 0 ? occupied / available * 100 : 0 });
    targetRevByProp.set(p.id, rev);
    targetRev += rev;
    for (const [mk, n] of propOccByMonth) occByMonth.set(mk, (occByMonth.get(mk) || 0) + n);
    for (const [mk, n] of propAvailByMonth) availByMonth.set(mk, (availByMonth.get(mk) || 0) + n);
  });
  const totalAvail = [...occByProp.values()].reduce((s, v) => s + v.available, 0);
  const totalOcc   = [...occByProp.values()].reduce((s, v) => s + v.occupied, 0);
  const avgOcc = totalAvail > 0 ? totalOcc / totalAvail * 100 : 0;

  // Comparison range for KPI deltas — same active prop ids. Null when off.
  // cmpPayments is retained (not just reduced to scalars) so drill-downs can
  // show the comparison period's actual records, mirroring `payments` above.
  let prevRev = null, prevNights = null, cmpPayments = null, cmpStayPays = null, cmpNightRange = null;
  if (cmpRange) {
    cmpPayments = getPaymentsInRange(cmpRange.start, cmpRange.end, propIds);
    prevRev = cmpPayments.reduce((s, p) => s + payEUR(p), 0);
    cmpNightRange = { start: cmpRange.start, end: cmpRange.end };
    cmpStayPays = getStayPaymentsInRange(cmpRange.start, cmpRange.end, propIds);
    prevNights = sumNights(cmpStayPays, cmpNightRange);
  }

  return {
    payments, props, revByProp, totalRev, revByMonth, monthKeys, keyIndex,
    stayPays, nightRange, cmpStayPays, cmpNightRange,
    targetRevByProp,
    totalNights, avgADR, avgOcc, occByProp, targetRev,
    occByMonth, availByMonth,
    prevRev, prevNights, cmpPayments,
    rangeLabel: curRange.label,
    cmpLabel: cmpRange ? cmpRange.label : null,
    hasCmp: !!cmpRange
  };
}

// ── Property spotlight data ───────────────────────────────────────────────────
function getSpotlightData(propId, curRange) {
  const payments = getPaymentsInRange(curRange.start, curRange.end, new Set([propId]));
  const cal = getCalendar(propId);
  const { occupiedSet, ownerBlockSet } = buildOccupancySets(propId, cal?.blocks || []);
  const monthKeys = getMonthKeysForRange(curRange.start, curRange.end).keys;
  // Target revenue uses the same historic-fallback-aware published rate
  // (makeRateForNight) as getPortfolioData — confirmed target ADR when set,
  // otherwise the historic suggestion — so the Spotlight's "Target Revenue"
  // agrees with the Portfolio view for the same property/months instead of
  // silently reading 0 for months without a confirmed strRateTargets entry.
  const rateForNight = makeRateForNight(propId);
  const { occByMonth, availByMonth, rev: targetRev } =
    rangeOccupancy(occupiedSet, ownerBlockSet, curRange.start, curRange.end, rateForNight);

  // Nights / ADR by stay date (clipped to each month ∩ range); revenue by payout date.
  const stayPays = getStayPaymentsInRange(curRange.start, curRange.end, new Set([propId]));
  const months = monthKeys.map(k => {
    const mk       = k.key;
    const target   = getTargetADR(propId, mk);
    const paysInMo = payments.filter(p => (p.date || '').startsWith(mk));
    const rev      = paysInMo.reduce((s, p) => s + payEUR(p), 0);
    const moEnd    = `${mk}-${String(daysInMonth(+mk.slice(0, 4), +mk.slice(5, 7) - 1)).padStart(2, '0')}`;
    const moRange  = { start: `${mk}-01` > curRange.start ? `${mk}-01` : curRange.start, end: moEnd < curRange.end ? moEnd : curRange.end };
    const nights   = sumNights(stayPays, moRange);
    const adr      = nights > 0 ? sumNightRevenue(stayPays, moRange) / nights : 0;
    const occupied  = occByMonth.get(mk) || 0;    // occupied nights in range
    const available = availByMonth.get(mk) || 0;  // available nights in range (excl. owner-blocks)
    const occ       = available > 0 ? occupied / available * 100 : 0;
    // Target ADR is entered in the property's currency; shown next to the EUR achieved ADR.
    const targetEUR = target?.targetADR ? toEUR(target.targetADR, byId('properties', propId)?.currency || 'EUR', `${mk}-01`) : null;
    return { mk, label: k.label, target: targetEUR || null, rev, nights, adr, occupied, available, occ };
  });

  const totalRev    = months.reduce((s, m) => s + m.rev, 0);
  const totalNights = months.reduce((s, m) => s + m.nights, 0);
  const avgADR      = totalNights > 0 ? months.reduce((s, m) => s + m.adr * m.nights, 0) / totalNights : 0;

  return { months, totalRev, totalNights, avgADR, targetRev };
}

// ── Forward pipeline (next 90 days) ──────────────────────────────────────────
function getForwardPipeline() {
  // Local calendar dates as 'YYYY-MM-DD' — the old local-midnight Date +
  // toISOString() labelled every night one day early for a UTC+ viewer.
  const today = todayYmd();
  const end90 = addDaysYmd(today, 90); // exclusive

  const props = getStrProps();
  const results = [];

  props.forEach(prop => {
    const cal = getCalendar(prop.id);
    // Only real guest reservations count as "locked" — owner-blocked/personal-use
    // closures earn nothing and must not be valued as booked revenue (mirrors
    // buildBlockDateSets' reserved/owner split elsewhere in this file).
    const blocks = (cal?.blocks || []).filter(b => {
      if (!b.start || !b.end) return false;
      if (isOwnerBlockSummary(b.summary)) return false;
      return b.end > today && b.start < end90;
    });

    let lockedNights = 0;
    let lockedRevMin = 0; // booked nights × published rate (after promo discount)
    let openNights   = 0;
    let potRevMax    = 0; // open nights × published rate (full)

    // Value every night in the next 90 days at the published rate (confirmed
    // target if set, otherwise the historic suggestion) — same as the feed.
    // Also group consecutive same-type nights into date-range segments (with
    // the revenue-derived avg published rate) so the totals are auditable.
    const rateForNight = makeRateForNight(prop.id);
    const segments = [];
    let cur = null;
    eachNight(today, end90, ds => {
      const isBlocked = blocks.some(b => ds >= b.start && ds < b.end);
      const rate = isBlocked ? rateForNight(ds, true) : rateForNight(ds, false);
      if (isBlocked) {
        lockedNights++;
        lockedRevMin += rate;
      } else {
        openNights++;
        potRevMax += rate;
      }
      const type = isBlocked ? 'locked' : 'open';
      if (cur && cur.type === type) {
        cur.end = ds; cur.nights++; cur.rev += rate;
      } else {
        if (cur) segments.push(cur);
        cur = { type, start: ds, end: ds, nights: 1, rev: rate };
      }
    });
    if (cur) segments.push(cur);

    results.push({
      propId: prop.id,
      propName: prop.name,
      lockedNights,
      lockedRevMin,
      openNights,
      potRevMax,
      segments
    });
  });

  return results;
}

// ── Rebuild ───────────────────────────────────────────────────────────────────
let _container = null;

// Swap the whole view root for a fresh one (buildView() creates a new root
// each time — appending it into the old root nested one level deeper per
// filter change) and destroy the charts first so they are re-created cleanly.
function rebuildView() {
  const old = _container;
  if (!old) return;
  CHART_IDS.forEach(id => charts.destroy(id));
  old.replaceWith(buildView());
}

// ── Main view builder ─────────────────────────────────────────────────────────
function buildView() {
  _container = el('div', { class: 'view-content' });
  // Lock the stream to short-term so the shared filter bar only offers STR
  // properties/owners (re-applied each build so Reset can't widen it).
  gF.streams = new Set(['short_term_rental']);
  const curRange = getCurrentPeriodRange(gF);
  const cmpRange = getComparisonRange(gF, curRange);
  const data = getPortfolioData(curRange, cmpRange);

  // ── Page header
  const header = el('div', { style: 'display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;margin-bottom:20px' });
  const titleWrap = el('div');
  titleWrap.appendChild(el('h2', { style: 'margin:0;font-size:20px;font-weight:700' }, 'STR Performance'));
  titleWrap.appendChild(el('p', { style: 'margin:2px 0 0;font-size:13px;color:var(--text-muted)' },
    `${data.props.length} short-term rental propert${data.props.length !== 1 ? 'ies' : 'y'} · ${data.payments.length} bookings`
  ));
  header.appendChild(titleWrap);
  _container.appendChild(header);

  // Shared filter bar (range/period + comparison + owner + property). Stream is
  // off because STR is a single stream.
  const filterBar = buildFilterBar(gF, {
    showOwner: true, showStream: false, showProperty: true, showClient: false,
    storagePrefix: 'str', channelScope: gScope === 'all' ? null : 'company'
  }, (newState) => { if (newState) Object.assign(gF, newState); rebuildView(); });
  _container.appendChild(filterBar);

  // Scope toggle (Company only / All incl. personal) — same as the other dashboards.
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
  _container.appendChild(scopeBar);

  // Comparison line — reuses the shared helper.
  _container.appendChild(buildComparisonLine(curRange, cmpRange));

  if (!data.props.length) {
    _container.appendChild(mkEmptyState('No short-term rental properties found.'));
    return _container;
  }

  // ── Section 1: Portfolio KPI row
  _container.appendChild(buildPortfolioKpis(data));

  // ── Section 2: Revenue trend + Occupancy side-by-side
  const twoCol = el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px' });
  twoCol.appendChild(buildRevTrendCard(data));
  twoCol.appendChild(buildOccupancyCard(data, curRange));
  _container.appendChild(twoCol);

  // ── Section 2b: Occupancy heatmap (property × month)
  _container.appendChild(buildStrOccupancyHeatmap(data));

  // ── Section 3: Property comparison table
  _container.appendChild(buildComparisonTable(data, curRange));

  // ── Section 4: Property spotlight
  _container.appendChild(buildSpotlightSection(data.props, curRange));

  // ── Section 5: Forward pipeline
  _container.appendChild(buildForwardPipelineCard());

  return _container;
}

// ── Portfolio KPI row ─────────────────────────────────────────────────────────
function buildPortfolioKpis(data) {
  const { totalRev, prevRev, totalNights, prevNights, avgADR, avgOcc, targetRev, payments, props, rangeLabel, cmpLabel, occByProp } = data;
  const vsTarget = targetRev > 0 ? (totalRev / targetRev) * 100 : null;
  const propCount = props.length;
  const hasCmp = !!cmpLabel;

  const grid = el('div', {
    style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px;margin-bottom:16px'
  });

  // 1. Total Revenue
  grid.appendChild(mkKpiCard({
    label: 'Total Revenue',
    value: formatEUR(totalRev),
    subtitle: `${rangeLabel} · ${payments.length} bookings`,
    delta: hasCmp && prevRev != null ? safePct(totalRev, prevRev) : undefined,
    compLabel: hasCmp ? cmpLabel : undefined,
    compValue: hasCmp && prevRev > 0 ? formatEUR(prevRev) : undefined,
    onClick: () => openRevenueModal(data),
    explain: {
      title: 'Total Revenue', formula: 'Sum of paid STR payments\' amount, across all filtered properties, dated within the selected period.',
      inputs: [
        { label: 'Bookings counted', value: String(payments.length) },
        { label: 'Properties', value: String(propCount) },
        { label: 'Total', value: formatEUR(totalRev) }
      ],
      source: 'analytics-str.js:234 getPortfolioData()',
      note: 'Only status:\'paid\' payments count — pending/materialized rows are excluded.'
    }
  }));

  // 2. Nights Sold
  grid.appendChild(mkKpiCard({
    label: 'Nights Sold',
    value: totalNights.toLocaleString(),
    subtitle: `${propCount} propert${propCount !== 1 ? 'ies' : 'y'}`,
    delta: hasCmp && prevNights != null ? safePct(totalNights, prevNights) : undefined,
    compLabel: hasCmp ? cmpLabel : undefined,
    onClick: () => openNightsModal(data),
    explain: {
      title: 'Nights Sold', formula: 'Nights of paid STR stays that fall inside the selected period, by stay date (a stay spanning two months is split across them).',
      inputs: [{ label: 'Total nights', value: totalNights.toLocaleString() }],
      source: 'analytics-str.js:96 bookedNights() → analytics-str.js:247 getPortfolioData()',
      note: 'bookedNights() returns 0 for Airbnb payout adjustments (Resolution Adjustment, Cancellation Fee, etc.) since they repeat the check-in/check-out of their originating Reservation — counting them would double-count nights.'
    }
  }));

  // 3. Avg ADR (achieved)
  grid.appendChild(mkKpiCard({
    label: 'Avg ADR (Achieved)',
    value: avgADR > 0 ? formatEUR(avgADR, { maxFrac: 0 }) : '—',
    subtitle: 'Avg nightly rate across bookings',
    onClick: () => openADRModal(data),
    explain: {
      title: 'Avg ADR (Achieved)', formula: 'Σ(nightly rate × nights in period) over paid stays ÷ nights with a rate. Nightly rate = avgNightlyRate, else payout ÷ nights.',
      inputs: [
        { label: 'Nights with a rate', value: totalNights.toLocaleString() },
        { label: 'Avg ADR', value: avgADR > 0 ? formatEUR(avgADR) : '—' }
      ],
      source: 'analytics-str.js:255 getPortfolioData()',
      note: 'Payments with no avgNightlyRate, or 0 nights (payout adjustments), contribute neither to the numerator nor the denominator.'
    }
  }));

  // 4. Avg Occupancy
  grid.appendChild(mkKpiCard({
    label: 'Avg Occupancy',
    value: avgOcc > 0 ? avgOcc.toFixed(1) + '%' : '—',
    subtitle: 'Booked + blocked nights ÷ days',
    variant: avgOcc >= 70 ? 'success' : avgOcc >= 40 ? undefined : 'warning',
    onClick: () => openOccModal(data),
    explain: {
      title: 'Avg Occupancy', formula: 'Total occupied nights ÷ total available nights × 100, summed across all filtered properties.',
      inputs: [
        { label: 'Occupied nights', value: [...occByProp.values()].reduce((s, v) => s + v.occupied, 0).toLocaleString() },
        { label: 'Available nights', value: [...occByProp.values()].reduce((s, v) => s + v.available, 0).toLocaleString() }
      ],
      source: 'analytics-str.js:280 getPortfolioData() (per-property via rangeOccupancy():147)',
      note: 'Occupied = sold or Airbnb-"Reserved" nights. Available excludes owner-blocked days that were never sold — you can\'t sell a day you closed, so it shouldn\'t drag occupancy down.'
    }
  }));

  // 5. Revenue vs Target
  if (targetRev > 0) {
    grid.appendChild(mkKpiCard({
      label: 'Revenue vs Target',
      value: vsTarget != null ? vsTarget.toFixed(1) + '%' : '—',
      subtitle: `Target: ${formatEUR(targetRev, { maxFrac: 0 })}`,
      variant: vsTarget != null && vsTarget >= 90 ? 'success' : vsTarget != null && vsTarget < 70 ? 'danger' : undefined,
      onClick: () => openTargetModal(data),
      explain: {
        title: 'Revenue vs Target', formula: 'Actual Revenue ÷ Target Revenue × 100.',
        inputs: [
          { label: 'Actual Revenue', value: formatEUR(totalRev) },
          { label: 'Target Revenue', value: formatEUR(targetRev) }
        ],
        source: 'analytics-str.js:480 buildPortfolioKpis() (targetRev from getPortfolioData():262-277)',
        note: 'Target Revenue values every occupied night at its published rate — the confirmed strRateTargets ADR when set, otherwise the historic-suggestion rate (makeRateForNight():207) — so months without a confirmed target still get a target instead of reading €0.'
      }
    }));
  }

  return grid;
}

// ── Revenue trend chart card ──────────────────────────────────────────────────
function buildRevTrendCard(data) {
  const { revByMonth, props, monthKeys } = data;
  const card = el('div', { class: 'card' });
  card.appendChild(el('div', { class: 'card-header' },
    el('div', { class: 'card-title' }, 'Monthly Revenue')
  ));
  const body = el('div', { style: 'padding:0 16px 16px' });
  const wrap = el('div', { class: 'chart-wrap', style: 'height:220px' });
  wrap.appendChild(el('canvas', { id: 'str-rev-trend' }));
  body.appendChild(wrap);
  card.appendChild(body);

  // Render chart after DOM insertion
  requestAnimationFrame(() => {
    charts.bar('str-rev-trend', {
      labels: monthKeys.map(k => k.label),
      stacked: true,
      showTotals: true,
      datasets: props.map((p, i) => ({
        label: shortName(p.name),
        data: revByMonth.map(mo => mo[p.id] || 0),
        backgroundColor: PROP_COLORS[i % PROP_COLORS.length] + 'cc'
      })),
      onClickItem: (label, idx) => openMonthRevenueModal(idx, data)
    });
  });
  return card;
}

// ── Occupancy chart card ──────────────────────────────────────────────────────
function buildOccupancyCard(data, curRange) {
  const { occByProp, props } = data;
  const card = el('div', { class: 'card' });
  card.appendChild(el('div', { class: 'card-header' },
    el('div', { class: 'card-title' }, 'Occupancy Rate by Property'),
    el('div', { style: 'font-size:11px;color:var(--text-muted)' }, 'Rate = Occupied ÷ Available')
  ));
  const body = el('div', { style: 'padding:0 16px 16px' });

  // Terminology legend so the three night types are unambiguous.
  body.appendChild(el('div', { style: 'display:flex;flex-wrap:wrap;gap:12px;font-size:11px;color:var(--text-muted);padding:8px 0 4px' },
    el('span', {}, '● Occupied — sold or reserved (earns revenue)'),
    el('span', {}, '○ Open — available but unsold'),
    el('span', {}, '▦ Blocked — owner-closed, off-market (no revenue, excluded from rate)')
  ));

  // Mini occupancy bars
  const list = el('div', { style: 'display:flex;flex-direction:column;gap:10px;padding:8px 0' });
  props.forEach((p, i) => {
    const occ = occByProp.get(p.id) || { pct: 0, occupied: 0, available: 0, open: 0, blocked: 0 };
    const row = el('div', { style: 'cursor:pointer', title: 'Click for property detail' });
    row.onclick = () => openPropertyRangeModal(p.id, curRange);
    const labelRow = el('div', { style: 'display:flex;justify-content:space-between;margin-bottom:4px' });
    labelRow.appendChild(el('span', { style: 'font-size:12px;color:var(--text)' }, shortName(p.name)));
    labelRow.appendChild(el('span', { style: 'font-size:12px;font-weight:600;color:var(--text)' },
      occ.pct.toFixed(1) + '%'
    ));
    row.appendChild(labelRow);
    row.appendChild(mkProgressBar(occ.pct, PROP_COLORS[i % PROP_COLORS.length]));
    const sub = el('div', { style: 'font-size:11px;color:var(--text-muted);margin-top:3px' },
      `${occ.occupied} occupied · ${occ.open} open · ${occ.blocked} blocked`
    );
    row.appendChild(sub);
    list.appendChild(row);
  });
  body.appendChild(list);
  card.appendChild(body);
  return card;
}

// ── Occupancy heatmap (property × month, booked nights) ───────────────────────
function buildStrOccupancyHeatmap(data) {
  const { props, payments, monthKeys } = data;
  const card = el('div', { class: 'card', style: 'margin-bottom:16px' });
  card.appendChild(el('div', { class: 'card-header' },
    el('div', { class: 'card-title' }, 'Occupancy Heatmap'),
    el('div', { style: 'font-size:12px;color:var(--text-muted)' }, 'Occupied ÷ available nights per month (stay dates)')
  ));
  if (!props.length) { card.appendChild(mkEmptyState('No short-term rental properties found.')); return card; }

  const body = el('div', { style: 'padding:0 16px 16px;overflow-x:auto' });
  const table = el('table', { class: 'table', style: 'min-width:600px' });
  const htr = el('tr');
  htr.appendChild(mkTh({ label: 'Property', tip: 'Property name.' }));
  monthKeys.forEach(k => htr.appendChild(mkTh({
    label: k.label, right: true,
    tip: 'Occupied ÷ available nights in this month, by stay date — the same calculation as the cell\'s detail and the Occupancy KPI (color-coded: green ≥70%, amber ≥40%, red below).'
  })));
  table.appendChild(el('thead', {}, htr));

  // Payments grouped once by property|month (for the bookings footer), instead
  // of filtering the whole period's payments for every cell.
  const paysByPropMonth = new Map();
  for (const pay of payments) {
    const key = `${pay.propertyId}|${(pay.date || '').slice(0, 7)}`;
    let arr = paysByPropMonth.get(key);
    if (!arr) { arr = []; paysByPropMonth.set(key, arr); }
    arr.push(pay);
  }

  let anyNights = false;
  const tbody = el('tbody');
  for (const p of props) {
    const tr = el('tr');
    tr.appendChild(el('td', { style: 'white-space:nowrap;font-weight:600' }, shortName(p.name)));
    const cal = getCalendar(p.id);
    const { occupiedSet, ownerBlockSet } = buildOccupancySets(p.id, cal?.blocks || []);
    monthKeys.forEach(k => {
      const mk = k.key;
      const monthPays = paysByPropMonth.get(`${p.id}|${mk}`) || [];
      const dim = daysInMonth(+k.y, k.m - 1);
      const monthStart = `${mk}-01`;
      const monthEnd   = `${mk}-${String(dim).padStart(2, '0')}`;
      // Same stay-date calculation as this cell's detail modal and the
      // Occupancy KPI: occupied ÷ available (owner-blocked, unsold nights
      // excluded) — not payout-dated nights ÷ calendar days.
      const occ = rangeOccupancy(occupiedSet, ownerBlockSet, monthStart, monthEnd);
      const pct = occ.available > 0 ? occ.occupied / occ.available * 100 : 0;
      if (occ.occupied > 0) anyNights = true;
      const hasData = occ.occupied > 0 || monthPays.length > 0;
      const td = el('td', { class: 'right', style: 'cursor:pointer' });
      if (!hasData || occ.available === 0) {
        td.textContent = hasData ? '—' : '';
        td.style.color = 'var(--text-muted)';
      } else {
        td.textContent = pct.toFixed(0) + '%';
        td.style.color = pct >= 70 ? 'var(--success)' : pct >= 40 ? '#f59e0b' : 'var(--danger)';
      }
      if (hasData) {
        td.title = 'Click for occupancy detail';
        td.onclick = () => {
          const monthOpen = Math.max(0, occ.available - occ.occupied);
          const monthPct  = occ.available > 0 ? occ.occupied / occ.available * 100 : 0;

          const mb = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });
          mb.appendChild(mkSectionLabel(`${shortName(p.name)} — ${k.label}`));
          mb.appendChild(mkSummaryGrid([
            { label: 'Occupied', value: occ.occupied.toString() },
            { label: 'Open', value: monthOpen.toString() },
            { label: 'Blocked', value: occ.blocked.toString() },
            { label: 'Occupancy %', value: occ.available > 0 ? monthPct.toFixed(1) + '%' : '—',
              explain: {
                title: 'Occupancy %', formula: 'Occupied nights ÷ Available nights × 100, for this property and month.',
                inputs: [
                  { label: 'Occupied', value: occ.occupied.toString() },
                  { label: 'Available', value: occ.available.toString() }
                ],
                source: 'analytics-str.js buildStrOccupancyHeatmap() (rangeOccupancy())',
                note: 'Available excludes owner-blocked nights that were never sold — a payment/reservation on an owner-blocked day still counts as occupied.'
              }
            }
          ], 4));
          const payFooter = el('div', { style: 'display:flex;justify-content:space-between;align-items:center;padding-top:4px' });
          payFooter.appendChild(el('div', { style: 'font-size:12px;color:var(--text-muted)' },
            `${monthPays.length} payment${monthPays.length === 1 ? '' : 's'} this month`));
          const payLink = el('a', { style: 'font-size:12px;cursor:pointer;color:var(--accent)' }, 'View all bookings →');
          payLink.onclick = () => {
            drillDownModal(`${shortName(p.name)} — ${k.label} Bookings`,
              [...monthPays].sort((a, b) => (a.date || '').localeCompare(b.date || '')),
              [
                { key: 'date', label: 'Date', tip: 'Payment date.', format: v => fmtDate(v) },
                { key: 'airbnbNights', label: 'Nights', right: true, tip: 'Nights booked on this payment record.', format: v => v != null ? String(v) : '—' },
                AMOUNT_COL
              ]
            );
          };
          payFooter.appendChild(payLink);
          mb.appendChild(payFooter);
          openModal({ title: `Occupancy — ${shortName(p.name)} · ${k.label}`, body: mb, large: true });
        };
      }
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  const tw = el('div', { class: 'table-wrap' }); tw.appendChild(table); body.appendChild(tw);
  if (!anyNights) {
    body.appendChild(el('div', {
      style: 'margin-top:10px;padding:10px 12px;background:#fef3c7;border:1px solid #f59e0b;border-radius:6px;font-size:12px;color:#92400e'
    }, '⚠ Occupancy data requires booking check-in/check-out dates or an iCal calendar. Import an Airbnb CSV in the Payments section or connect the property\'s iCal feed.'));
  }
  card.appendChild(body);
  return card;
}

// ── Property comparison table ─────────────────────────────────────────────────
function buildComparisonTable(data, curRange) {
  const { props, revByProp, occByProp, payments, totalRev } = data;
  const card = el('div', { class: 'card', style: 'margin-bottom:16px' });
  card.appendChild(el('div', { class: 'card-header' },
    el('div', { class: 'card-title' }, 'STR Property Comparison (Occupancy & ADR)')
  ));
  const body = el('div', { style: 'padding:0 16px 16px;overflow-x:auto' });

  const rows = props.map((p, i) => {
    const rev   = revByProp.get(p.id) || 0;
    const occ   = occByProp.get(p.id) || { pct: 0 };
    const pPays = payments.filter(pay => pay.propertyId === p.id);
    const sPays = data.stayPays.filter(pay => pay.propertyId === p.id); // nights/ADR by stay date
    const nights = sumNights(sPays, data.nightRange);
    const adr   = nights > 0 ? sumNightRevenue(sPays, data.nightRange) / nights : 0;
    const revPct = totalRev > 0 ? rev / totalRev * 100 : 0;

    const nameCell = el('td', { style: 'padding:8px;font-size:12px;color:var(--text)' });
    const dot = el('span', {
      style: `display:inline-block;width:8px;height:8px;border-radius:50%;background:${PROP_COLORS[i % PROP_COLORS.length]};margin-right:6px;flex-shrink:0`
    });
    nameCell.appendChild(dot);
    nameCell.appendChild(document.createTextNode(shortName(p.name)));

    const revBar = el('td', { style: 'padding:8px;min-width:120px' });
    const barWrap = el('div', { style: 'display:flex;align-items:center;gap:6px' });
    barWrap.appendChild(mkProgressBar(revPct, PROP_COLORS[i % PROP_COLORS.length]));
    barWrap.appendChild(el('span', { style: 'font-size:11px;color:var(--text-muted);white-space:nowrap' }, formatEUR(rev, { maxFrac: 0 })));
    revBar.appendChild(barWrap);

    const tr = el('tr', {
      style: `cursor:pointer;${i % 2 === 1 ? 'background:rgba(255,255,255,0.02)' : ''}`,
      title: 'Click for property detail'
    },
      nameCell,
      revBar,
      mkTd(nights > 0 ? nights.toString() : '—'),
      mkTd(adr > 0 ? formatEUR(adr, { maxFrac: 0 }) : '—'),
      mkTd(occ.pct.toFixed(1) + '%'),
      mkTd(pPays.length.toString())
    );
    tr.onclick = () => openPropertyRangeModal(p.id, curRange);
    return tr;
  });

  const thead = el('thead');
  const hrow = el('tr');
  [
    { label: 'Property', tip: 'Property name; colored dot matches the Monthly Revenue chart series.' },
    { label: 'Revenue', right: true, tip: 'Sum of paid STR payments for this property in the selected period.' },
    { label: 'Nights', right: true, tip: 'Nights sold in the selected period (excludes Airbnb payout adjustments, which would double-count nights).' },
    { label: 'Avg ADR', right: true, tip: 'Revenue ÷ nights across this property\'s bookings.' },
    { label: 'Occupancy', right: true, tip: 'Occupied nights ÷ available nights (excludes owner-blocked days) for the selected period.' },
    { label: 'Bookings', right: true, tip: 'Number of paid payment records for this property in the period.' }
  ].forEach((h, hi) => {
    const th = mkTh(h);
    th.style.cssText = `padding:6px 8px;text-align:${hi === 0 ? 'left' : 'right'};font-size:11px;color:var(--text-muted);border-bottom:1px solid rgba(255,255,255,0.08);white-space:nowrap${h.tip ? ';cursor:help' : ''}`;
    hrow.appendChild(th);
  });
  thead.appendChild(hrow);

  const tbody = el('tbody');
  rows.forEach(r => tbody.appendChild(r));

  const table = el('table', { style: 'width:100%;border-collapse:collapse;font-size:12px' });
  table.appendChild(thead);
  table.appendChild(tbody);
  body.appendChild(table);
  card.appendChild(body);
  return card;
}

function mkTd(text) {
  return el('td', { style: 'padding:8px;text-align:right;font-size:12px;color:var(--text)' }, text);
}

// ── Property spotlight section ────────────────────────────────────────────────
function buildSpotlightSection(props, curRange) {
  // Reset the spotlight if its property was filtered out (or none chosen yet).
  if (props.length && !props.some(p => p.id === gSpotlightPropId)) gSpotlightPropId = props[0].id;

  const wrap = el('div', { style: 'margin-bottom:16px' });
  const sectionHeader = el('div', { style: 'display:flex;align-items:center;gap:12px;margin-bottom:12px' });
  sectionHeader.appendChild(el('div', { style: 'font-size:15px;font-weight:700;color:var(--text)' }, 'Property Spotlight'));

  const sel = el('select', {
    style: 'background:var(--bg-elev-1);border:1px solid var(--border);border-radius:var(--radius-sm);padding:5px 10px;font-size:12px;color:var(--text);cursor:pointer'
  });
  props.forEach(p => {
    const o = el('option', { value: p.id }, shortName(p.name));
    if (p.id === gSpotlightPropId) o.selected = true;
    sel.appendChild(o);
  });
  sel.addEventListener('change', () => {
    gSpotlightPropId = sel.value;
    const existing = document.getElementById('str-spotlight-content');
    if (existing) {
      const newContent = buildSpotlightContent(gSpotlightPropId, curRange);
      newContent.id = 'str-spotlight-content';
      existing.replaceWith(newContent);
    }
  });
  sectionHeader.appendChild(sel);
  wrap.appendChild(sectionHeader);

  const content = buildSpotlightContent(gSpotlightPropId, curRange);
  content.id = 'str-spotlight-content';
  wrap.appendChild(content);
  return wrap;
}

function buildSpotlightContent(propId, curRange) {
  if (!propId) return el('div');
  const data = getSpotlightData(propId, curRange);
  const { months, totalRev, totalNights, avgADR, targetRev } = data;

  const wrap = el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:16px' });

  // ADR chart: Achieved vs Target
  const adrCard = el('div', { class: 'card' });
  adrCard.appendChild(el('div', { class: 'card-header' },
    el('div', { class: 'card-title' }, 'ADR: Achieved vs Target')
  ));
  const adrBody = el('div', { style: 'padding:0 16px 16px' });
  const adrWrap = el('div', { class: 'chart-wrap', style: 'height:200px' });
  adrWrap.appendChild(el('canvas', { id: 'str-spotlight-adr' }));
  adrBody.appendChild(adrWrap);

  // Summary row below chart
  const adrSummary = el('div', { style: 'display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:12px' });
  adrSummary.appendChild(mkSummaryBox('Total Revenue', formatEUR(totalRev, { maxFrac: 0 }), curRange.label, {
    title: 'Total Revenue', formula: 'Sum of this property\'s month.rev across the selected range (each month.rev = sum of its paid payments\' amount).',
    inputs: [{ label: 'Total Revenue', value: formatEUR(totalRev, { maxFrac: 0 }) }],
    source: 'analytics-str.js:320,329 getSpotlightData()'
  }));
  adrSummary.appendChild(mkSummaryBox('Target Revenue', targetRev > 0 ? formatEUR(targetRev, { maxFrac: 0 }) : '—', 'at published rate', {
    title: 'Target Revenue', formula: 'Sum, over every occupied night in the range, of that night\'s published rate (confirmed strRateTargets ADR when set, otherwise the historic-suggestion rate).',
    inputs: [{ label: 'Target Revenue', value: targetRev > 0 ? formatEUR(targetRev, { maxFrac: 0 }) : '—' }],
    source: 'analytics-str.js:307-314 getSpotlightData() (makeRateForNight():207)'
  }));
  adrSummary.appendChild(mkSummaryBox('Avg ADR', avgADR > 0 ? formatEUR(avgADR, { maxFrac: 0 }) : '—', 'from bookings', {
    title: 'Avg ADR', formula: 'Revenue-weighted average of each month\'s ADR: Σ(month.adr × month.nights) ÷ total nights.',
    inputs: [{ label: 'Total nights', value: totalNights.toString() }, { label: 'Avg ADR', value: avgADR > 0 ? formatEUR(avgADR) : '—' }],
    source: 'analytics-str.js:331 getSpotlightData()'
  }));
  adrBody.appendChild(adrSummary);
  adrCard.appendChild(adrBody);

  // Occupancy by month chart
  const occCard = el('div', { class: 'card' });
  occCard.appendChild(el('div', { class: 'card-header' },
    el('div', { class: 'card-title' }, 'Monthly Occupancy %')
  ));
  const occBody = el('div', { style: 'padding:0 16px 16px' });
  const occWrap = el('div', { class: 'chart-wrap', style: 'height:200px' });
  occWrap.appendChild(el('canvas', { id: 'str-spotlight-occ' }));
  occBody.appendChild(occWrap);

  const occSummary = el('div', { style: 'display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:12px' });
  occSummary.appendChild(mkSummaryBox('Nights Sold', totalNights.toString(), 'from bookings', {
    title: 'Nights Sold', formula: 'Sum of bookedNights(payment) over this property\'s paid bookings in the range.',
    inputs: [{ label: 'Nights Sold', value: totalNights.toString() }],
    source: 'analytics-str.js:96 bookedNights() → analytics-str.js:321,330 getSpotlightData()',
    note: 'Airbnb payout adjustments (Resolution Adjustment, Cancellation Fee, etc.) contribute 0 nights so they don\'t double-count.'
  }));
  const occupiedTotal = months.reduce((s, m) => s + m.occupied, 0);
  const availTotal    = months.reduce((s, m) => s + m.available, 0);
  const periodOcc = availTotal > 0 ? (occupiedTotal / availTotal * 100).toFixed(1) + '%' : '—';
  occSummary.appendChild(mkSummaryBox('Period Occupancy', periodOcc, 'occupied ÷ available', {
    title: 'Period Occupancy', formula: 'Total occupied nights ÷ total available nights × 100, across the selected range.',
    inputs: [{ label: 'Occupied', value: occupiedTotal.toString() }, { label: 'Available', value: availTotal.toString() }],
    source: 'analytics-str.js:906-908 buildSpotlightContent() (rangeOccupancy():147)',
    note: 'Available excludes owner-blocked nights never sold.'
  }));
  const bookings = getPaymentsInRange(curRange.start, curRange.end, new Set([propId])).length;
  occSummary.appendChild(mkSummaryBox('Bookings', bookings.toString(), curRange.label));
  occBody.appendChild(occSummary);
  occCard.appendChild(occBody);

  wrap.appendChild(adrCard);
  wrap.appendChild(occCard);

  // Render charts after DOM
  requestAnimationFrame(() => {
    charts.destroy('str-spotlight-adr');
    charts.destroy('str-spotlight-occ');

    const hasTarget = months.some(m => m.target != null);
    const adrDatasets = [
      {
        label: 'Achieved ADR',
        data: months.map(m => m.adr > 0 ? m.adr : null),
        backgroundColor: '#6366f1aa',
        borderColor: '#6366f1',
        type: 'bar'
      }
    ];
    if (hasTarget) {
      adrDatasets.push({
        label: 'Target ADR',
        data: months.map(m => m.target),
        borderColor: '#f59e0b',
        backgroundColor: 'transparent',
        type: 'line',
        borderWidth: 2,
        pointRadius: 3,
        tension: 0.3,
        fill: false
      });
    }
    charts.bar('str-spotlight-adr', {
      labels: months.map(m => m.label),
      datasets: adrDatasets,
      onClickItem: (label, idx) => openMonthSpotlightModal(idx, propId, months, curRange)
    });

    charts.bar('str-spotlight-occ', {
      formatValue: v => v.toFixed(0) + '%', // a percentage chart — not "€"
      labels: months.map(m => m.label),
      datasets: [{
        label: 'Occupancy %',
        data: months.map(m => m.occ),
        backgroundColor: months.map(m =>
          m.occ >= 70 ? '#22c55ecc' : m.occ >= 40 ? '#6366f1cc' : '#f59e0bcc'
        )
      }],
      onClickItem: (label, idx) => openMonthSpotlightModal(idx, propId, months, curRange)
    });
  });

  return wrap;
}

// ── Forward pipeline card ─────────────────────────────────────────────────────
function buildForwardPipelineCard() {
  const pipeline = getForwardPipeline();
  const card = el('div', { class: 'card', style: 'margin-bottom:16px' });
  card.appendChild(el('div', { class: 'card-header' },
    el('div', { class: 'card-title' }, 'Forward Pipeline — Next 90 Days'),
    el('div', { class: 'card-subtitle' }, todayYmd() + ' → ' + addDaysYmd(todayYmd(), 90))
  ));
  const body = el('div', { style: 'padding:0 16px 16px' });

  const totalLocked = pipeline.reduce((s, r) => s + r.lockedNights, 0);
  const totalLockedRev = pipeline.reduce((s, r) => s + r.lockedRevMin, 0);
  const totalOpen = pipeline.reduce((s, r) => s + r.openNights, 0);
  const totalPot  = pipeline.reduce((s, r) => s + r.potRevMax, 0);

  // Summary row — Locked Revenue / Revenue Potential drill into the underlying
  // date-range segments so the totals are auditable.
  const sumGrid = el('div', { style: 'display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:12px' });
  sumGrid.appendChild(mkSummaryBox('Locked Nights',
    mkDrillValue(totalLocked.toString(), () =>
      openPipelineDetailModal(pipeline, { type: 'locked', title: 'Forward Pipeline — Locked Nights (Next 90 Days)' })),
    'confirmed bookings', {
    title: 'Locked Nights', formula: 'Count of the next 90 days that fall inside a real guest reservation (owner-blocks excluded).',
    inputs: [{ label: 'Locked nights', value: totalLocked.toString() }],
    source: 'analytics-str.js:359-378 getForwardPipeline()',
    note: 'Owner-blocked/personal-use closures earn nothing and are never counted as locked.'
  }));
  const lockedRevBox = mkSummaryBox('Locked Revenue', totalLockedRev > 0 ? formatEUR(totalLockedRev, { maxFrac: 0 }) : '—', 'at published rate', {
    title: 'Locked Revenue', formula: 'Sum, over locked nights, of that night\'s published rate after any promo discount.',
    inputs: [
      { label: 'Locked nights', value: totalLocked.toString() },
      { label: 'Locked Revenue', value: formatEUR(totalLockedRev, { maxFrac: 0 }) }
    ],
    source: 'analytics-str.js:368-379 getForwardPipeline() (makeRateForNight():207)',
    note: 'Rate = confirmed strRateTargets ADR (minus discount) when set, otherwise the historic-suggestion rate — same published-rate logic as the rest of this dashboard.'
  });
  lockedRevBox.style.cursor = 'pointer';
  lockedRevBox.title = 'Click for locked date ranges';
  lockedRevBox.onclick = () => openPipelineDetailModal(pipeline, { type: 'locked', title: 'Forward Pipeline — Locked Nights (Next 90 Days)' });
  sumGrid.appendChild(lockedRevBox);
  sumGrid.appendChild(mkSummaryBox('Open Nights',
    mkDrillValue(totalOpen.toString(), () =>
      openPipelineDetailModal(pipeline, { type: 'open', title: 'Forward Pipeline — Open Nights (Next 90 Days)' })),
    'available to book', {
    title: 'Open Nights', formula: 'Count of the next 90 days not covered by a guest reservation or owner-block.',
    inputs: [{ label: 'Open nights', value: totalOpen.toString() }],
    source: 'analytics-str.js:359-381 getForwardPipeline()'
  }));
  const potRevBox = mkSummaryBox('Revenue Potential', totalPot > 0 ? formatEUR(totalPot, { maxFrac: 0 }) : '—', 'open × target ADR', {
    title: 'Revenue Potential', formula: 'Sum, over open nights, of that night\'s full published rate (no discount).',
    inputs: [
      { label: 'Open nights', value: totalOpen.toString() },
      { label: 'Revenue Potential', value: formatEUR(totalPot, { maxFrac: 0 }) }
    ],
    source: 'analytics-str.js:368-381 getForwardPipeline() (makeRateForNight():207)',
    note: 'A best-case ceiling, not a forecast — assumes every open night sells at the full published rate with no discount.'
  });
  potRevBox.style.cursor = 'pointer';
  potRevBox.title = 'Click for open date ranges';
  potRevBox.onclick = () => openPipelineDetailModal(pipeline, { type: 'open', title: 'Forward Pipeline — Open Nights (Next 90 Days)' });
  sumGrid.appendChild(potRevBox);
  body.appendChild(sumGrid);

  // Per-property breakdown — each row drills into that property's date ranges.
  if (pipeline.length) {
    const hrow = el('tr');
    [
      { label: 'Property', right: false, tip: 'Property name.' },
      { label: 'Locked Nights', right: true, tip: 'Nights in the next 90 days already reserved by a guest (owner-blocks excluded).' },
      { label: 'Locked Rev', right: true, tip: 'Locked nights valued at the published rate, after any promo discount.' },
      { label: 'Open Nights', right: true, tip: 'Nights in the next 90 days still available to book.' },
      { label: 'Rev Potential', right: true, tip: 'Open nights valued at the full published rate (no discount).' }
    ].forEach(h => {
      const th = mkTh(h);
      th.style.cssText = `padding:6px 8px;text-align:${h.right ? 'right' : 'left'};font-size:11px;color:var(--text-muted);border-bottom:1px solid rgba(255,255,255,0.08);white-space:nowrap${h.tip ? ';cursor:help' : ''}`;
      hrow.appendChild(th);
    });
    const tbody = el('tbody');
    pipeline.forEach((r, i) => {
      const tr = el('tr', {
        style: `cursor:pointer;${i % 2 === 1 ? 'background:rgba(255,255,255,0.02)' : ''}`,
        title: 'Click for date-range detail'
      },
        el('td', { style: 'padding:8px;font-size:12px;color:var(--text)' }, shortName(r.propName)),
        mkTd(r.lockedNights.toString()),
        mkTd(r.lockedRevMin > 0 ? formatEUR(r.lockedRevMin, { maxFrac: 0 }) : '—'),
        mkTd(r.openNights.toString()),
        mkTd(r.potRevMax > 0 ? formatEUR(r.potRevMax, { maxFrac: 0 }) : '—')
      );
      tr.onclick = () => openPipelineDetailModal(pipeline, { propId: r.propId, title: `${shortName(r.propName)} — Forward Pipeline Detail` });
      tbody.appendChild(tr);
    });
    const table = el('table', { style: 'width:100%;border-collapse:collapse;font-size:12px' },
      el('thead', {}, hrow), tbody
    );
    body.appendChild(table);
  }

  card.appendChild(body);
  return card;
}

// Lists the underlying open/locked date-range segments (and the published
// rate used for each) behind the Forward Pipeline totals — filterable by
// property and/or segment type so both the summary boxes and table rows can
// drill into the same data.
function openPipelineDetailModal(pipeline, { propId = null, type = null, title } = {}) {
  const rows = [];
  pipeline.forEach(r => {
    if (propId && r.propId !== propId) return;
    r.segments.forEach(seg => {
      if (type && seg.type !== type) return;
      rows.push({ propName: r.propName, ...seg });
    });
  });
  rows.sort((a, b) => a.start.localeCompare(b.start) || a.propName.localeCompare(b.propName));

  const body = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });
  if (!rows.length) {
    body.appendChild(mkEmptyState('No dates in this category.'));
  } else {
    const totalValue = rows.reduce((s, r) => s + r.rev, 0);
    const rangeEnd = rows.reduce((mx, r) => r.end > mx ? r.end : mx, rows[0].end);
    body.appendChild(mkSummaryGrid([
      { label: 'Segments', value: rows.length.toString() },
      { label: 'Total Value', value: formatEUR(totalValue, { maxFrac: 0 }),
        explain: {
          title: 'Total Value', formula: 'Sum of each date-range segment\'s value (nights × published rate for that segment).',
          inputs: [{ label: 'Segments', value: rows.length.toString() }, { label: 'Total Value', value: formatEUR(totalValue, { maxFrac: 0 }) }],
          source: 'analytics-str.js:369-391 getForwardPipeline()',
          note: 'Matches the Locked Revenue / Revenue Potential totals for the same filter — this table is the auditable breakdown behind those figures.'
        }
      },
      { label: 'Date Range', value: `${fmtDate(rows[0].start)} – ${fmtDate(rangeEnd)}` }
    ], 3));

    body.appendChild(mkModalTable(
      [
        { label: 'Property', tip: 'Property name.' },
        { label: 'Type', tip: 'Locked = an existing guest reservation; Open = still available to book.' },
        { label: 'Dates', tip: 'Consecutive-night date range of this segment.' },
        { label: 'Nights', right: true, tip: 'Number of nights in this segment.' },
        { label: 'Avg Published Rate', right: true, tip: 'This segment\'s total value ÷ its nights.' },
        { label: 'Total Value', right: true, tip: 'Nights × published rate for this segment (discounted for Locked, full rate for Open).' }
      ],
      rows.map(r => [
        shortName(r.propName),
        r.type === 'locked' ? 'Locked' : 'Open',
        `${fmtDate(r.start)} – ${fmtDate(r.end)}`,
        r.nights.toString(),
        r.nights > 0 ? formatEUR(r.rev / r.nights) : '—',
        formatEUR(r.rev, { maxFrac: 0 })
      ]),
      { highlight: 5 }
    ));
  }

  openModal({ title, body, large: true });
}

// ── Modal drill-downs ─────────────────────────────────────────────────────────
function openRevenueModal(data) {
  const { payments, props, revByProp, totalRev, hasCmp, cmpPayments, cmpLabel } = data;
  const body = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });

  const revExplain = {
    title: 'Total Revenue', formula: 'Sum of paid STR payments\' amount, across all filtered properties, in the selected period.',
    inputs: [{ label: 'Bookings counted', value: String(payments.length) }, { label: 'Total', value: formatEUR(totalRev) }],
    source: 'analytics-str.js:234 getPortfolioData()',
    note: 'Only status:\'paid\' payments count.'
  };

  if (hasCmp) {
    const cmpTotalRev = cmpPayments.reduce((s, p) => s + payEUR(p), 0);
    body.appendChild(mkCmpGrid([
      { label: 'Total Revenue',
        curVal: mkDrillValue(formatEUR(totalRev), () =>
          drillDownModal(`STR Revenue — ${data.rangeLabel}`, payments, BOOKING_COLS_WITH_PROPERTY)),
        cmpVal: mkDrillValue(formatEUR(cmpTotalRev), () =>
          drillDownModal(`STR Revenue — ${cmpLabel}`, cmpPayments, BOOKING_COLS_WITH_PROPERTY)),
        explain: revExplain
      },
      { label: 'Bookings',
        curVal: mkDrillValue(payments.length.toString(), () =>
          drillDownModal(`STR Revenue — ${data.rangeLabel}`, payments, BOOKING_COLS_WITH_PROPERTY)),
        cmpVal: mkDrillValue(cmpPayments.length.toString(), () =>
          drillDownModal(`STR Revenue — ${cmpLabel}`, cmpPayments, BOOKING_COLS_WITH_PROPERTY))
      }
    ], 'Current Period', cmpLabel));
  } else {
    body.appendChild(mkSummaryGrid([
      { label: 'Total Revenue',
        value: mkDrillValue(formatEUR(totalRev), () =>
          drillDownModal(`STR Revenue — ${data.rangeLabel}`, payments, BOOKING_COLS_WITH_PROPERTY)),
        explain: revExplain
      },
      { label: 'Bookings',
        value: mkDrillValue(payments.length.toString(), () =>
          drillDownModal(`STR Revenue — ${data.rangeLabel}`, payments, BOOKING_COLS_WITH_PROPERTY))
      }
    ], 2));
  }

  body.appendChild(mkSectionLabel('Revenue by Property'));
  body.appendChild(mkModalTable(
    [
      { label: 'Property', tip: 'Property name.' },
      { label: 'Revenue', tip: 'Sum of paid STR payments for this property in the selected period.' },
      { label: '% of Total', tip: 'This property\'s revenue ÷ portfolio total revenue.' },
      { label: 'Bookings', tip: 'Number of paid payment records for this property in the period.' }
    ],
    props.map(p => {
      const rev  = revByProp.get(p.id) || 0;
      const pPays = payments.filter(pay => pay.propertyId === p.id);
      return [
        shortName(p.name),
        pPays.length
          ? mkDrillValue(formatEUR(rev), () => drillDownModal(`${shortName(p.name)} — Revenue`, pPays, BOOKING_COLS))
          : formatEUR(rev),
        totalRev > 0 ? (rev / totalRev * 100).toFixed(1) + '%' : '—',
        pPays.length.toString()
      ];
    }),
    { highlight: 1 }
  ));

  body.appendChild(mkSectionLabel(`Top Bookings — ${data.rangeLabel}`));
  const top = [...payments].sort((a, b) => payEUR(b) - payEUR(a)).slice(0, 10);
  body.appendChild(mkModalTable(
    [
      { label: 'Date', tip: 'Payment date.' },
      { label: 'Property', tip: 'Property this booking is attributed to.' },
      { label: 'Nights', tip: 'Nights booked on this payment record.' },
      { label: 'Amount', tip: 'Paid amount for this record.' }
    ],
    top.map(p => [
      p.date || '—',
      shortName(byId('properties', p.propertyId)?.name || '—'),
      (p.airbnbNights || '—').toString(),
      formatEUR(payEUR(p))
    ]),
    { highlight: 3 }
  ));

  openModal({ title: `STR Revenue — ${data.rangeLabel}`, body, large: true });
}

function openNightsModal(data) {
  // Nights are counted by stay date: the booking set is every stay that
  // overlaps the period (stayPays), clipped to the period / month.
  const { props, monthKeys, hasCmp, cmpLabel, totalNights, prevNights } = data;
  const payments = data.stayPays, cmpPayments = data.cmpStayPays || [], range = data.nightRange;
  const body = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });

  if (hasCmp) {
    body.appendChild(mkCmpGrid([
      { label: 'Nights Sold',
        curVal: mkDrillValue(totalNights.toString(), () =>
          drillDownModal(`Nights Sold — ${data.rangeLabel}`, payments, BOOKING_COLS_WITH_PROPERTY)),
        cmpVal: mkDrillValue((prevNights ?? 0).toString(), () =>
          drillDownModal(`Nights Sold — ${cmpLabel}`, cmpPayments, BOOKING_COLS_WITH_PROPERTY)),
        explain: {
          title: 'Nights Sold', formula: 'Nights of paid STR stays that fall inside the selected period, by stay date (a stay spanning two months is split across them).',
          inputs: [{ label: 'Total nights', value: totalNights.toLocaleString() }],
          source: 'analytics-str.js:96 bookedNights() → analytics-str.js:247 getPortfolioData()',
          note: 'bookedNights() returns 0 for Airbnb payout adjustments since they repeat the check-in/check-out of their originating Reservation.'
        }
      },
      { label: 'Bookings',
        curVal: mkDrillValue(payments.length.toString(), () =>
          drillDownModal(`Nights Sold — ${data.rangeLabel}`, payments, BOOKING_COLS_WITH_PROPERTY)),
        cmpVal: mkDrillValue(cmpPayments.length.toString(), () =>
          drillDownModal(`Nights Sold — ${cmpLabel}`, cmpPayments, BOOKING_COLS_WITH_PROPERTY))
      }
    ], 'Current Period', cmpLabel));
  }

  const rows = props.map(p => {
    const pPays = payments.filter(pay => pay.propertyId === p.id);
    const nights = sumNights(pPays, range);
    return [
      shortName(p.name),
      nights > 0
        ? mkDrillValue(nights.toString(), () => drillDownModal(`${shortName(p.name)} — Nights Sold`, pPays, BOOKING_COLS))
        : nights.toString(),
      pPays.length.toString()
    ];
  });
  body.appendChild(mkModalTable(
    [
      { label: 'Property', tip: 'Property name.' },
      { label: 'Nights Sold', tip: 'Sum of bookedNights(payment) for this property — 0 for Airbnb payout adjustments so nights aren\'t double-counted.' },
      { label: 'Bookings', tip: 'Number of paid payment records for this property in the period.' }
    ],
    rows, { highlight: 1 }
  ));

  body.appendChild(mkSectionLabel('Monthly Breakdown (All Properties)'));
  const byMonth = monthKeys.map(() => 0);
  const byMonthPays = monthKeys.map(() => []);
  monthKeys.forEach((k, idx) => {
    const mk = k.key;
    const moEnd = `${mk}-${String(daysInMonth(+mk.slice(0, 4), +mk.slice(5, 7) - 1)).padStart(2, '0')}`;
    const moRange = { start: `${mk}-01` > range.start ? `${mk}-01` : range.start, end: moEnd < range.end ? moEnd : range.end };
    payments.forEach(p => {
      const n = nightsInRange(p, moRange);
      if (n > 0) { byMonth[idx] += n; byMonthPays[idx].push(p); }
    });
  });
  body.appendChild(mkModalTable(
    [
      { label: 'Month', tip: 'Calendar month.' },
      { label: 'Nights Sold', tip: 'Nights stayed in this month across all properties (by stay date; Airbnb payout adjustments excluded).' }
    ],
    byMonth.map((n, i) => [
      monthKeys[i].label,
      n > 0
        ? mkDrillValue(n.toString(), () => drillDownModal(`${monthKeys[i].label} — Nights Sold`, byMonthPays[i], BOOKING_COLS_WITH_PROPERTY))
        : '—'
    ]),
    { highlight: 1 }
  ));

  openModal({ title: `Nights Sold — ${data.rangeLabel}`, body, large: true });
}

function openADRModal(data) {
  const { payments, props } = data;
  const body = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });

  body.appendChild(mkSectionLabel('ADR by Property'));
  body.appendChild(mkModalTable(
    [
      { label: 'Property', tip: 'Property name.' },
      { label: 'Avg ADR', tip: 'Revenue ÷ nights across this property\'s bookings.' },
      { label: 'Nights', tip: 'Nights sold in the period (excludes Airbnb payout adjustments).' },
      { label: 'Bookings', tip: 'Number of paid payment records for this property in the period.' }
    ],
    props.map(p => {
      const pPays = data.stayPays.filter(pay => pay.propertyId === p.id); // by stay date
      const nights = sumNights(pPays, data.nightRange);
      const adr = nights > 0 ? sumNightRevenue(pPays, data.nightRange) / nights : 0;
      return [
        shortName(p.name),
        adr > 0 ? formatEUR(adr) : '—',
        nights > 0
          ? mkDrillValue(nights.toString(), () => drillDownModal(`${shortName(p.name)} — Nights Sold`, pPays, BOOKING_COLS))
          : nights.toString(),
        pPays.length.toString()
      ];
    }),
    { highlight: 1 }
  ));

  openModal({ title: `ADR Breakdown — ${data.rangeLabel}`, body, large: true });
}

function openOccModal(data) {
  const { props, occByProp, monthKeys, occByMonth, availByMonth } = data;
  const body = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });

  body.appendChild(mkModalTable(
    [
      { label: 'Property', tip: 'Property name.' },
      { label: 'Occupancy %', tip: 'Occupied ÷ Available × 100.' },
      { label: 'Occupied', tip: 'Nights sold or Airbnb-"Reserved" in the period.' },
      { label: 'Open', tip: 'Available but unsold nights (Available − Occupied).' },
      { label: 'Blocked (off-market)', tip: 'Owner-closed nights, excluded from Available (no revenue possible).' },
      { label: 'Available', tip: 'Total days in the period minus Blocked nights.' }
    ],
    props.map(p => {
      const occ = occByProp.get(p.id) || { pct: 0, occupied: 0, available: 0, open: 0, blocked: 0 };
      return [shortName(p.name), occ.pct.toFixed(1) + '%', occ.occupied.toString(), occ.open.toString(), occ.blocked.toString(), occ.available.toString()];
    }),
    { highlight: 1 }
  ));

  body.appendChild(mkSectionLabel('Monthly Occupancy Trend (All Properties)'));
  body.appendChild(mkModalTable(
    [
      { label: 'Month', tip: 'Calendar month.' },
      { label: 'Occupied', right: true, tip: 'Occupied nights across all properties in this month.' },
      { label: 'Available', right: true, tip: 'Available nights (excl. owner-blocked) across all properties in this month.' },
      { label: 'Occupancy %', right: true, tip: 'Occupied ÷ Available × 100 for this month.' }
    ],
    monthKeys.map(k => {
      const occ = occByMonth.get(k.key) || 0;
      const avail = availByMonth.get(k.key) || 0;
      return [k.label, occ.toString(), avail.toString(), avail > 0 ? (occ / avail * 100).toFixed(1) + '%' : '—'];
    }),
    { highlight: 3 }
  ));

  body.appendChild(el('div', { style: 'font-size:12px;color:var(--text-muted)' },
    'Occupied = sold or reserved · Open = available but unsold · Blocked = owner-closed / off-market (no revenue, excluded from the rate). Occupancy % = Occupied ÷ Available.'));

  openModal({ title: `Occupancy — ${data.rangeLabel}`, body, large: true });
}

function openTargetModal(data) {
  const { props, payments, revByProp, targetRev, totalRev } = data;
  const body = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });

  body.appendChild(mkSummaryGrid([
    { label: 'Actual Revenue',
      value: mkDrillValue(formatEUR(totalRev), () =>
        drillDownModal(`Actual Revenue — ${data.rangeLabel}`, payments, BOOKING_COLS_WITH_PROPERTY)),
      explain: {
        title: 'Actual Revenue', formula: 'Sum of paid STR payments\' amount in the selected period.',
        inputs: [{ label: 'Total', value: formatEUR(totalRev) }],
        source: 'analytics-str.js:234 getPortfolioData()'
      }
    },
    { label: 'Target Revenue', value: formatEUR(targetRev),
      explain: {
        title: 'Target Revenue', formula: 'Sum, over every occupied night in the period, of that night\'s published rate (confirmed strRateTargets ADR when set, otherwise the historic-suggestion rate).',
        inputs: [{ label: 'Target Revenue', value: formatEUR(targetRev) }],
        source: 'analytics-str.js:262-277 getPortfolioData() (rangeOccupancy():147, makeRateForNight():207)',
        note: 'Ensures months/properties without a confirmed target still get a meaningful target instead of reading €0.'
      }
    },
    { label: 'Achievement', value: targetRev > 0 ? (totalRev / targetRev * 100).toFixed(1) + '%' : '—',
      explain: {
        title: 'Achievement', formula: 'Actual Revenue ÷ Target Revenue × 100.',
        inputs: [{ label: 'Actual Revenue', value: formatEUR(totalRev) }, { label: 'Target Revenue', value: formatEUR(targetRev) }],
        source: 'analytics-str.js:1278 openTargetModal()'
      }
    },
    { label: 'Variance', value: formatEUR(totalRev - targetRev),
      explain: {
        title: 'Variance', formula: 'Actual Revenue − Target Revenue.',
        inputs: [{ label: 'Actual Revenue', value: formatEUR(totalRev) }, { label: 'Target Revenue', value: formatEUR(targetRev) }],
        source: 'analytics-str.js:1278 openTargetModal()'
      }
    }
  ], 4));

  body.appendChild(mkSectionLabel('By Property'));
  const { targetRevByProp } = data;
  body.appendChild(mkModalTable(
    [
      { label: 'Property', tip: 'Property name.' },
      { label: 'Actual', tip: 'Actual revenue for this property in the selected period.' },
      { label: 'Target', tip: 'Target revenue for this property (occupied nights × published rate).' },
      { label: 'Achievement', tip: 'Actual ÷ Target × 100.' }
    ],
    props.map(p => {
      const rev = revByProp.get(p.id) || 0;
      const propTarget = targetRevByProp.get(p.id) || 0;
      const ach = propTarget > 0 ? (rev / propTarget * 100).toFixed(1) + '%' : '—';
      const pPays = payments.filter(pay => pay.propertyId === p.id);
      return [
        shortName(p.name),
        pPays.length
          ? mkDrillValue(formatEUR(rev), () => drillDownModal(`${shortName(p.name)} — Actual Revenue`, pPays, BOOKING_COLS))
          : formatEUR(rev),
        propTarget > 0 ? formatEUR(propTarget) : '—',
        ach
      ];
    }),
    { highlight: 2 }
  ));

  openModal({ title: `Revenue vs Target — ${data.rangeLabel}`, body, large: true });
}

// Full-range breakdown for a single property — shared by the mini occupancy
// bars and the Property Comparison table so both entry points open the same
// modal (ADR/target/occupancy/bookings per month, mirroring openMonthSpotlightModal
// but covering the whole current range instead of a single month).
function openPropertyRangeModal(propId, curRange) {
  const prop = byId('properties', propId);
  const { months, totalRev, totalNights, avgADR, targetRev } = getSpotlightData(propId, curRange);
  const pays = getPaymentsInRange(curRange.start, curRange.end, new Set([propId]));
  const bookings = pays.length;
  const occupiedTotal = months.reduce((s, m) => s + m.occupied, 0);
  const availTotal    = months.reduce((s, m) => s + m.available, 0);
  const periodOccPct  = availTotal > 0 ? occupiedTotal / availTotal * 100 : 0;

  const body = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });
  body.appendChild(mkSummaryGrid([
    { label: 'Total Revenue',
      value: mkDrillValue(formatEUR(totalRev, { maxFrac: 0 }), () =>
        drillDownModal(`${shortName(prop?.name || '')} — Revenue`, pays, BOOKING_COLS)),
      sub: curRange.label,
      explain: {
        title: 'Total Revenue', formula: 'Sum of this property\'s month.rev across the selected range (each month.rev = sum of its paid payments\' amount).',
        inputs: [{ label: 'Total Revenue', value: formatEUR(totalRev, { maxFrac: 0 }) }],
        source: 'analytics-str.js:320,329 getSpotlightData()'
      }
    },
    { label: 'Nights Sold',
      value: mkDrillValue(totalNights.toString(), () =>
        drillDownModal(`${shortName(prop?.name || '')} — Nights Sold`, pays, BOOKING_COLS)),
      explain: {
        title: 'Nights Sold', formula: 'Sum of bookedNights(payment) over this property\'s paid bookings in the range.',
        inputs: [{ label: 'Nights Sold', value: totalNights.toString() }],
        source: 'analytics-str.js:96 bookedNights() → analytics-str.js:321,330 getSpotlightData()',
        note: 'Airbnb payout adjustments (Resolution Adjustment, Cancellation Fee, etc.) contribute 0 nights so they don\'t double-count.'
      }
    },
    { label: 'Avg ADR', value: avgADR > 0 ? formatEUR(avgADR, { maxFrac: 0 }) : '—',
      explain: {
        title: 'Avg ADR', formula: 'Revenue-weighted average of each month\'s ADR: Σ(month.adr × month.nights) ÷ total nights.',
        inputs: [{ label: 'Total nights', value: totalNights.toString() }, { label: 'Avg ADR', value: avgADR > 0 ? formatEUR(avgADR) : '—' }],
        source: 'analytics-str.js:331 getSpotlightData()'
      }
    },
    { label: 'Occupancy', value: availTotal > 0 ? periodOccPct.toFixed(1) + '%' : '—',
      explain: {
        title: 'Occupancy', formula: 'Total occupied nights ÷ total available nights × 100, across the selected range.',
        inputs: [{ label: 'Occupied', value: occupiedTotal.toString() }, { label: 'Available', value: availTotal.toString() }],
        source: 'analytics-str.js:1343-1345 openPropertyRangeModal() (rangeOccupancy():147)',
        note: 'Available excludes owner-blocked nights never sold.'
      }
    },
    { label: 'Target Revenue', value: targetRev > 0 ? formatEUR(targetRev, { maxFrac: 0 }) : '—',
      explain: {
        title: 'Target Revenue', formula: 'Sum, over every occupied night in the range, of that night\'s published rate (confirmed strRateTargets ADR when set, otherwise the historic-suggestion rate).',
        inputs: [{ label: 'Target Revenue', value: targetRev > 0 ? formatEUR(targetRev, { maxFrac: 0 }) : '—' }],
        source: 'analytics-str.js:307-314 getSpotlightData() (makeRateForNight():207)'
      }
    },
    { label: 'Bookings',
      value: mkDrillValue(bookings.toString(), () =>
        drillDownModal(`${shortName(prop?.name || '')} — Bookings`, pays, BOOKING_COLS))
    }
  ], 3));

  body.appendChild(mkSectionLabel('Monthly Breakdown'));
  body.appendChild(mkModalTable(
    [
      { label: 'Month', tip: 'Calendar month.' },
      { label: 'Revenue', right: true, tip: 'Sum of paid payments for this property in this month.' },
      { label: 'Achieved ADR', right: true, tip: 'This month\'s revenue-per-night from bookings: Σ(rate×nights) ÷ nights.' },
      { label: 'Target ADR', right: true, tip: 'Confirmed strRateTargets ADR for this property/month, if set.' },
      { label: 'Occupied', right: true, tip: 'Occupied nights (sold or Airbnb-"Reserved") this month.' },
      { label: 'Available', right: true, tip: 'Available nights (excl. owner-blocked) this month.' },
      { label: 'Occupancy %', right: true, tip: 'Occupied ÷ Available × 100 for this month.' }
    ],
    months.map(m => {
      const moPays = pays.filter(p => (p.date || '').startsWith(m.mk));
      return [
        m.label,
        m.rev > 0
          ? mkDrillValue(formatEUR(m.rev, { maxFrac: 0 }), () => drillDownModal(`${shortName(prop?.name || '')} — ${m.label} Revenue`, moPays, BOOKING_COLS))
          : '—',
        m.adr > 0 ? formatEUR(m.adr, { maxFrac: 0 }) : '—',
        m.target != null ? formatEUR(m.target, { maxFrac: 0 }) : '—',
        m.occupied.toString(),
        m.available.toString(),
        m.available > 0 ? m.occ.toFixed(1) + '%' : '—'
      ];
    }),
    { highlight: 1 }
  ));

  openModal({ title: `${shortName(prop?.name || '')} — ${curRange.label}`, body, large: true });
}

function openMonthRevenueModal(monthIdx, data) {
  const { payments, monthKeys } = data;
  const k = monthKeys[monthIdx];
  if (!k) return;
  const moPays = payments.filter(p => (p.date || '').startsWith(k.key));
  const moRev  = moPays.reduce((s, p) => s + payEUR(p), 0);

  const body = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });
  body.appendChild(mkSummaryGrid([
    { label: 'Total Revenue',
      value: mkDrillValue(formatEUR(moRev), () =>
        drillDownModal(`${k.label} — All Bookings`, moPays, BOOKING_COLS_WITH_PROPERTY)),
      explain: {
        title: 'Total Revenue', formula: 'Sum of paid STR payments\' amount dated within this month, across all filtered properties.',
        inputs: [{ label: 'Bookings counted', value: String(moPays.length) }, { label: 'Total', value: formatEUR(moRev) }],
        source: 'analytics-str.js:1419-1420 openMonthRevenueModal()'
      }
    },
    { label: 'Bookings',
      value: mkDrillValue(moPays.length.toString(), () =>
        drillDownModal(`${k.label} — All Bookings`, moPays, BOOKING_COLS_WITH_PROPERTY))
    }
  ], 2));

  if (moPays.length) {
    const byProp = new Map();
    moPays.forEach(p => {
      const key = p.propertyId || '—';
      if (!byProp.has(key)) byProp.set(key, []);
      byProp.get(key).push(p);
    });
    const propRows = [...byProp.entries()].map(([propId, pays]) => ({
      name: shortName(byId('properties', propId)?.name || '—'),
      rev: pays.reduce((s, p) => s + payEUR(p), 0),
      nights: sumNights(pays),
      count: pays.length,
      pays
    })).sort((a, b) => b.rev - a.rev);

    body.appendChild(mkSectionLabel('By Property'));
    body.appendChild(mkModalTable(
      [
        { label: 'Property', tip: 'Property name.' },
        { label: 'Bookings', right: true, tip: 'Number of paid payment records this month.' },
        { label: 'Nights', right: true, tip: 'Nights sold this month (excludes Airbnb payout adjustments).' },
        { label: 'Revenue', right: true, tip: 'Sum of paid payments for this property this month.' }
      ],
      propRows.map(r => [
        r.name, r.count.toString(), r.nights > 0 ? r.nights.toString() : '—',
        mkDrillValue(formatEUR(r.rev), () => drillDownModal(`${r.name} — ${k.label} Revenue`, r.pays, BOOKING_COLS))
      ]),
      { highlight: 3 }
    ));

    const footer = el('div', { style: 'margin-top:4px;padding-top:12px;border-top:1px solid rgba(255,255,255,0.08);display:flex;justify-content:space-between;align-items:center' });
    footer.appendChild(el('div', { style: 'font-size:12px;color:var(--text-muted)' },
      `${moPays.length} booking${moPays.length === 1 ? '' : 's'} across ${propRows.length} propert${propRows.length !== 1 ? 'ies' : 'y'}`));
    const link = el('a', { style: 'font-size:12px;cursor:pointer;color:var(--accent)' }, 'View all bookings →');
    link.onclick = () => {
      drillDownModal(`${k.label} — All Bookings`,
        [...moPays].sort((a, b) => (a.airbnbCheckIn || a.date) < (b.airbnbCheckIn || b.date) ? -1 : 1),
        [
          { key: 'airbnbCheckIn', label: 'Check-in', tip: 'Check-in date (falls back to payment date).', format: (v, row) => v || row.date || '—' },
          { key: 'propertyId', label: 'Property', tip: 'Property this booking is attributed to.', format: v => shortName(byId('properties', v)?.name || '—') },
          { key: 'airbnbNights', label: 'Nights', right: true, tip: 'Nights booked on this payment record.', format: v => v != null ? String(v) : '—' },
          AMOUNT_COL
        ]
      );
    };
    footer.appendChild(link);
    body.appendChild(footer);
  } else {
    body.appendChild(mkEmptyState('No bookings in this month.'));
  }

  openModal({ title: `${k.label} — STR Revenue`, body, large: true });
}

function openMonthSpotlightModal(monthIdx, propId, months, curRange) {
  const mo = months[monthIdx];
  if (!mo) return;
  const prop = byId('properties', propId);
  const pays = getPaymentsInRange(curRange.start, curRange.end, new Set([propId])).filter(p =>
    (p.date || '').startsWith(mo.mk)
  );

  const body = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });
  body.appendChild(mkSummaryGrid([
    { label: 'Revenue',
      value: pays.length
        ? mkDrillValue(formatEUR(mo.rev), () => drillDownModal(`${shortName(prop?.name || '')} — ${mo.label} Revenue`, pays, BOOKING_COLS))
        : formatEUR(mo.rev),
      explain: {
        title: 'Revenue', formula: 'Sum of this property\'s paid payments\' amount dated within this month.',
        inputs: [{ label: 'Revenue', value: formatEUR(mo.rev) }],
        source: 'analytics-str.js:320 getSpotlightData()'
      }
    },
    { label: 'Achieved ADR',   value: mo.adr > 0 ? formatEUR(mo.adr) : '—',
      explain: {
        title: 'Achieved ADR', formula: 'Σ(avgNightlyRate × nights) over this month\'s paid bookings ÷ total nights.',
        inputs: [{ label: 'Achieved ADR', value: mo.adr > 0 ? formatEUR(mo.adr) : '—' }, { label: 'Nights', value: mo.nights.toString() }],
        source: 'analytics-str.js:322 getSpotlightData()'
      }
    },
    { label: 'Target ADR',     value: mo.target != null ? formatEUR(mo.target) : '—',
      explain: {
        title: 'Target ADR', formula: 'The confirmed strRateTargets.targetADR for this property and month, if one has been entered.',
        inputs: [{ label: 'Target ADR', value: mo.target != null ? formatEUR(mo.target) : '—' }],
        source: 'analytics-str.js:60 getTargetADR() → analytics-str.js:318,326 getSpotlightData()',
        note: 'A raw lookup, not a calculation — shows "—" when no target has been set for this month.'
      }
    },
    { label: 'Occupancy',      value: mo.occ.toFixed(1) + '%',
      explain: {
        title: 'Occupancy', formula: 'Occupied nights ÷ Available nights × 100, for this month.',
        inputs: [{ label: 'Occupied', value: mo.occupied.toString() }, { label: 'Available', value: mo.available.toString() }],
        source: 'analytics-str.js:325 getSpotlightData() (rangeOccupancy():147)',
        note: 'Available excludes owner-blocked nights never sold.'
      }
    },
    { label: 'Occupied Nights',  value: mo.occupied.toString() },
    { label: 'Available Nights', value: mo.available.toString() }
  ], 3));

  if (pays.length) {
    const footer = el('div', { style: 'display:flex;justify-content:space-between;align-items:center' });
    footer.appendChild(el('div', { style: 'font-size:12px;color:var(--text-muted)' },
      `${pays.length} booking${pays.length === 1 ? '' : 's'} this month`));
    const link = el('a', { style: 'font-size:12px;cursor:pointer;color:var(--accent)' }, 'View all bookings →');
    link.onclick = () => {
      drillDownModal(`${shortName(prop?.name || '')} — ${mo.label} Bookings`,
        pays,
        [
          { key: 'airbnbCheckIn', label: 'Check-in', tip: 'Check-in date.', format: (v, row) => v || row.date || '—' },
          { key: 'airbnbCheckOut', label: 'Check-out', tip: 'Check-out date.', format: v => v || '—' },
          { key: 'airbnbNights', label: 'Nights', right: true, tip: 'Nights booked on this payment record.', format: v => v != null ? String(v) : '—' },
          { key: 'avgNightlyRate', label: 'ADR', right: true, tip: 'Average nightly rate for this booking, in EUR.', format: (v, row) => v ? formatEUR(toEUR(v, row.currency, row.date)) : '—' },
          AMOUNT_COL
        ]
      );
    };
    footer.appendChild(link);
    body.appendChild(footer);
  } else {
    body.appendChild(mkEmptyState('No bookings recorded for this month.'));
  }

  openModal({ title: `${shortName(prop?.name || '')} — ${mo.label}`, body, large: true });
}

// ── Utility ───────────────────────────────────────────────────────────────────
function shortName(name) {
  if (!name) return '—';
  const pipe = name.indexOf('|');
  return pipe > 0 ? name.slice(0, pipe).trim() : name;
}
