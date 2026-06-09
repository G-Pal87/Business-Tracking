// STR Performance Dashboard — portfolio summary, property spotlight, forward pipeline
import { el, openModal, fmtDate } from '../core/ui.js';
import * as charts from '../core/charts.js';
import { state } from '../core/state.js';
import { formatEUR, listActive, listActivePayments, byId } from '../core/data.js';
import {
  createFilterState, getCurrentPeriodRange, getComparisonRange,
  getMonthKeysForRange, makeMatchers, buildFilterBar, buildComparisonLine
} from './analytics-filters.js';
import {
  mkKpiCard, mkSummaryGrid, mkSummaryBox, mkModalTable, mkSectionLabel,
  mkEmptyState, mkVarianceBadge, mkProgressBar, fmtK, safePct
} from './analytics-helpers.js';

// ── Constants ─────────────────────────────────────────────────────────────────
const CHART_IDS = ['str-rev-trend', 'str-occ-bar', 'str-adr-line', 'str-prop-rev-donut', 'str-spotlight-adr', 'str-spotlight-occ'];
const PROP_COLORS = ['#6366f1','#14b8a6','#f59e0b','#ec4899','#22c55e'];

// ── State ─────────────────────────────────────────────────────────────────────
let gF = createFilterState({ period: 'this-year', compareTo: 'prev-year' });
let gSpotlightPropId = null;

// ── Module export ─────────────────────────────────────────────────────────────
export default {
  id: 'analytics-str',
  label: 'STR Performance',
  icon: '⌂',
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
function getStrProps() {
  const { mOwner } = makeMatchers(gF);
  return allStrProps().filter(p =>
    mOwner(p) && (!gF.propertyIds.size || gF.propertyIds.has(p.id))
  );
}

// Paid STR payments inside an inclusive [start,end] date range, restricted to
// the supplied property ids.
function getPaymentsInRange(start, end, propIds) {
  return listActivePayments().filter(p =>
    p.stream === 'short_term_rental' &&
    p.status === 'paid' &&
    (p.date || '') >= start && (p.date || '') <= end &&
    p.propertyId && propIds.has(p.propertyId)
  );
}

function getTargetADR(propertyId, monthKey) {
  const targets = state.db.strRateTargets || [];
  return targets.find(t => t.propertyId === propertyId && t.month === monthKey) || null;
}

function getCalendar(propertyId) {
  return (state.db.strCalendars || []).find(c => c.propertyId === propertyId) || null;
}

// Count nights blocked (booked/reserved) in a given month from iCal blocks
function countBlockedNights(blocks, year, monthIdx) {
  if (!blocks?.length) return 0;
  const monthStart = new Date(year, monthIdx, 1);
  const monthEnd   = new Date(year, monthIdx + 1, 1);
  let nights = 0;
  for (const b of blocks) {
    if (!b.start || !b.end) continue;
    const bs = new Date(b.start);
    const be = new Date(b.end);
    const overlapStart = bs > monthStart ? bs : monthStart;
    const overlapEnd   = be < monthEnd   ? be : monthEnd;
    if (overlapEnd > overlapStart) {
      nights += Math.round((overlapEnd - overlapStart) / 86400000);
    }
  }
  return nights;
}

function daysInMonth(year, monthIdx) {
  return new Date(year, monthIdx + 1, 0).getDate();
}

// Classify an iCal block by its summary: owner-block (manually closed /
// unavailable, never sold) vs a guest reservation. Airbnb exports "Reserved"
// for bookings and "Airbnb (Not available)" for owner-blocks.
function isOwnerBlock(summary) {
  return /not available|unavailable|\bblocked\b|closed/i.test(summary || '');
}

// Split iCal blocks into { reserved, owner } date sets (each [start,end) → nights).
function buildBlockDateSets(blocks) {
  const reserved = new Set(), owner = new Set();
  for (const b of blocks || []) {
    if (!b.start || !b.end) continue;
    const target = isOwnerBlock(b.summary) ? owner : reserved;
    const d = new Date(b.start), be = new Date(b.end);
    while (d < be) { target.add(d.toISOString().slice(0, 10)); d.setDate(d.getDate() + 1); }
  }
  return { reserved, owner };
}

// Booked nights from paid bookings' check-in → check-out (covers off-platform
// sales recorded as payments, and past stays the Airbnb iCal no longer carries).
function buildBookedDateSet(propId) {
  const set = new Set();
  listActivePayments().forEach(p => {
    if (p.propertyId !== propId || p.stream !== 'short_term_rental' || p.status !== 'paid') return;
    const ci = p.airbnbCheckIn || p.checkIn, co = p.airbnbCheckOut || p.checkOut;
    if (!ci || !co) return;
    const d = new Date(ci + 'T00:00:00'), e = new Date(co + 'T00:00:00');
    while (d < e) { set.add(d.toISOString().slice(0, 10)); d.setDate(d.getDate() + 1); }
  });
  return set;
}

// Occupancy sets for a property:
//   occupiedSet  — booked (payments) ∪ "Reserved" iCal nights (revenue nights)
//   ownerBlockSet — manually-closed nights, EXCLUDED from available (you can't
//                   sell a day you closed). A payment on such a day wins (it
//                   becomes occupied), so off-platform sales count normally.
function buildOccupancySets(propId, blocks) {
  const { reserved, owner } = buildBlockDateSets(blocks);
  const occupiedSet = buildBookedDateSet(propId);
  for (const d of reserved) occupiedSet.add(d);
  return { occupiedSet, ownerBlockSet: owner };
}

// Iterate each day in [start,end] inclusive. Occupancy = occupied ÷ available,
// where available excludes owner-blocked days that weren't sold. Returns counts,
// per-month tallies, and (if rateFn given) published-rate revenue over occupied days.
function rangeOccupancy(occupiedSet, ownerBlockSet, start, end, rateFn) {
  let totalDays = 0, available = 0, occupied = 0, blocked = 0, rev = 0;
  const occByMonth = new Map(), availByMonth = new Map();
  const d   = new Date(start + 'T00:00:00');
  const lim = new Date(end + 'T00:00:00');
  while (d <= lim) {
    const ds = d.toISOString().slice(0, 10), mk = ds.slice(0, 7);
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
    d.setDate(d.getDate() + 1);
  }
  return { totalDays, available, occupied, blocked, occByMonth, availByMonth, rev };
}

// Historic achieved-ADR suggester for a property — same priority as the daily-
// rate feed: same calendar day across prior years → same month → overall average.
function buildAdrSuggester(propId) {
  const byMonthDay = new Map(), byMonth = new Map(), all = [];
  listActivePayments().forEach(p => {
    if (p.propertyId !== propId || p.stream !== 'short_term_rental' || p.status !== 'paid') return;
    const rate = p.avgNightExclCleaning != null ? p.avgNightExclCleaning
               : (p.avgNightlyRate != null ? p.avgNightlyRate : null);
    if (rate == null || rate <= 0) return;
    const ci = p.airbnbCheckIn || p.checkIn, co = p.airbnbCheckOut || p.checkOut;
    if (!ci || !co) return;
    const d = new Date(ci + 'T00:00:00'), e = new Date(co + 'T00:00:00');
    while (d < e) {
      const ds = d.toISOString().slice(0, 10), md = ds.slice(5), mo = ds.slice(5, 7);
      (byMonthDay.get(md) || byMonthDay.set(md, []).get(md)).push(rate);
      (byMonth.get(mo)    || byMonth.set(mo, []).get(mo)).push(rate);
      all.push(rate);
      d.setDate(d.getDate() + 1);
    }
  });
  const avg = a => a.reduce((s, r) => s + r, 0) / a.length;
  const overall = all.length ? avg(all) : null;
  return (date) => {
    const md = byMonthDay.get(date.slice(5));   if (md && md.length) return avg(md);
    const mo = byMonth.get(date.slice(5, 7));   if (mo && mo.length) return avg(mo);
    return overall;
  };
}

// Published nightly rate for a property on a date — mirrors the daily-rate feed:
// confirmed target ADR (optionally after promo discount) when set, otherwise the
// historic suggestion. Keeps dashboard revenue tied to the rates we actually push
// instead of zeroing months that have no confirmed target.
function makeRateForNight(propId) {
  const globalDisc = state.db.settings?.airbnb?.globalDiscountPct ?? 0;
  const suggest = buildAdrSuggester(propId);
  return (date, applyDiscount) => {
    const t = getTargetADR(propId, date.slice(0, 7));
    if (t) {
      const disc = (t.discountPct != null ? t.discountPct : globalDisc) / 100;
      return (t.targetADR || 0) * (applyDiscount ? (1 - disc) : 1);
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
    if (p.propertyId) revByProp.set(p.propertyId, (revByProp.get(p.propertyId) || 0) + p.amount);
  });
  const totalRev = [...revByProp.values()].reduce((s, v) => s + v, 0);

  // Revenue by month-key (for trend chart) — one object per month in the range.
  const revByMonth = monthKeys.map(() => ({}));
  payments.forEach(p => {
    const mk  = (p.date || '').slice(0, 7);
    const idx = keyIndex.get(mk);
    if (idx != null && p.propertyId) {
      revByMonth[idx][p.propertyId] = (revByMonth[idx][p.propertyId] || 0) + p.amount;
    }
  });

  // Nights sold & ADR from payments (airbnbNights field)
  let totalNights = 0;
  let nightsWithADR = 0;
  let adrSum = 0;
  payments.forEach(p => {
    const n = p.airbnbNights || 0;
    totalNights += n;
    if (n > 0 && p.avgNightlyRate) { adrSum += p.avgNightlyRate * n; nightsWithADR += n; }
  });
  const avgADR = nightsWithADR > 0 ? adrSum / nightsWithADR : 0;

  // Occupancy: blocked nights from iCal vs total days, range-accurate (the range
  // may start / end mid-month). Keep a per-month blocked tally for the target calc.
  const occByProp = new Map();
  const targetRevByProp = new Map();
  let targetRev = 0;
  props.forEach(p => {
    const cal = getCalendar(p.id);
    const { occupiedSet, ownerBlockSet } = buildOccupancySets(p.id, cal?.blocks || []);
    const rateForNight = makeRateForNight(p.id);
    // Expected ("target") revenue values each occupied night at the published
    // rate (confirmed target if set, else historic suggestion) — no more €0 for
    // properties/months without a confirmed target.
    const { available, occupied, blocked, rev } = rangeOccupancy(occupiedSet, ownerBlockSet, curRange.start, curRange.end, rateForNight);
    occByProp.set(p.id, { occupied, available, blocked, open: Math.max(0, available - occupied), pct: available > 0 ? occupied / available * 100 : 0 });
    targetRevByProp.set(p.id, rev);
    targetRev += rev;
  });
  const totalAvail = [...occByProp.values()].reduce((s, v) => s + v.available, 0);
  const totalOcc   = [...occByProp.values()].reduce((s, v) => s + v.occupied, 0);
  const avgOcc = totalAvail > 0 ? totalOcc / totalAvail * 100 : 0;

  // Comparison range for KPI deltas — same active prop ids. Null when off.
  let prevRev = null, prevNights = null;
  if (cmpRange) {
    const cmpPayments = getPaymentsInRange(cmpRange.start, cmpRange.end, propIds);
    prevRev = cmpPayments.reduce((s, p) => s + p.amount, 0);
    prevNights = cmpPayments.reduce((s, p) => s + (p.airbnbNights || 0), 0);
  }

  return {
    payments, props, revByProp, totalRev, revByMonth, monthKeys, keyIndex,
    targetRevByProp,
    totalNights, avgADR, avgOcc, occByProp, targetRev,
    prevRev, prevNights,
    rangeLabel: curRange.label,
    cmpLabel: cmpRange ? cmpRange.label : null
  };
}

// ── Property spotlight data ───────────────────────────────────────────────────
function getSpotlightData(propId, curRange) {
  const payments = getPaymentsInRange(curRange.start, curRange.end, new Set([propId]));
  const cal = getCalendar(propId);
  const { occupiedSet, ownerBlockSet } = buildOccupancySets(propId, cal?.blocks || []);
  const monthKeys = getMonthKeysForRange(curRange.start, curRange.end).keys;
  const { occByMonth, availByMonth } = rangeOccupancy(occupiedSet, ownerBlockSet, curRange.start, curRange.end);

  const months = monthKeys.map(k => {
    const mk       = k.key;
    const target   = getTargetADR(propId, mk);
    const paysInMo = payments.filter(p => (p.date || '').startsWith(mk));
    const rev      = paysInMo.reduce((s, p) => s + p.amount, 0);
    const nights   = paysInMo.reduce((s, p) => s + (p.airbnbNights || 0), 0);
    const adr      = nights > 0 ? paysInMo.reduce((s, p) => s + (p.avgNightlyRate || 0) * (p.airbnbNights || 0), 0) / nights : 0;
    const occupied  = occByMonth.get(mk) || 0;    // occupied nights in range
    const available = availByMonth.get(mk) || 0;  // available nights in range (excl. owner-blocks)
    const occ       = available > 0 ? occupied / available * 100 : 0;
    return { mk, label: k.label, target: target?.targetADR || null, rev, nights, adr, occupied, available, occ };
  });

  const totalRev    = months.reduce((s, m) => s + m.rev, 0);
  const totalNights = months.reduce((s, m) => s + m.nights, 0);
  const avgADR      = totalNights > 0 ? months.reduce((s, m) => s + m.adr * m.nights, 0) / totalNights : 0;
  const targetRev   = months.reduce((s, m) => s + (m.target || 0) * m.occupied, 0);

  return { months, totalRev, totalNights, avgADR, targetRev };
}

// ── Forward pipeline (next 90 days) ──────────────────────────────────────────
function getForwardPipeline() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const end90 = new Date(today);
  end90.setDate(today.getDate() + 90);

  const props = getStrProps();
  const results = [];

  props.forEach(prop => {
    const cal = getCalendar(prop.id);
    const blocks = (cal?.blocks || []).filter(b => {
      if (!b.start || !b.end) return false;
      const bs = new Date(b.start);
      const be = new Date(b.end);
      return be > today && bs < end90;
    });

    let lockedNights = 0;
    let lockedRevMin = 0; // booked nights × published rate (after promo discount)
    let openNights   = 0;
    let potRevMax    = 0; // open nights × published rate (full)

    // Value every night in the next 90 days at the published rate (confirmed
    // target if set, otherwise the historic suggestion) — same as the feed.
    const rateForNight = makeRateForNight(prop.id);
    const d = new Date(today);
    while (d < end90) {
      const ds = d.toISOString().slice(0, 10);
      const isBlocked = blocks.some(b => ds >= b.start && ds < b.end);
      if (isBlocked) {
        lockedNights++;
        lockedRevMin += rateForNight(ds, true);
      } else {
        openNights++;
        potRevMax += rateForNight(ds, false);
      }
      d.setDate(d.getDate() + 1);
    }

    results.push({
      propId: prop.id,
      propName: prop.name,
      lockedNights,
      lockedRevMin,
      openNights,
      potRevMax
    });
  });

  return results;
}

// ── Rebuild ───────────────────────────────────────────────────────────────────
let _container = null;

function rebuildView() {
  if (!_container) return;
  _container.innerHTML = '';
  _container.appendChild(buildView());
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
    storagePrefix: 'str'
  }, (newState) => { if (newState) Object.assign(gF, newState); rebuildView(); });
  _container.appendChild(filterBar);

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
  twoCol.appendChild(buildOccupancyCard(data));
  _container.appendChild(twoCol);

  // ── Section 2b: Occupancy heatmap (property × month)
  _container.appendChild(buildStrOccupancyHeatmap(data));

  // ── Section 3: Property comparison table
  _container.appendChild(buildComparisonTable(data));

  // ── Section 4: Property spotlight
  _container.appendChild(buildSpotlightSection(data.props, curRange));

  // ── Section 5: Forward pipeline
  _container.appendChild(buildForwardPipelineCard());

  return _container;
}

// ── Portfolio KPI row ─────────────────────────────────────────────────────────
function buildPortfolioKpis(data) {
  const { totalRev, prevRev, totalNights, prevNights, avgADR, avgOcc, targetRev, payments, props, rangeLabel, cmpLabel } = data;
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
    onClick: () => openRevenueModal(data)
  }));

  // 2. Nights Sold
  grid.appendChild(mkKpiCard({
    label: 'Nights Sold',
    value: totalNights.toLocaleString(),
    subtitle: `${propCount} propert${propCount !== 1 ? 'ies' : 'y'}`,
    delta: hasCmp && prevNights != null ? safePct(totalNights, prevNights) : undefined,
    compLabel: hasCmp ? cmpLabel : undefined,
    onClick: () => openNightsModal(data)
  }));

  // 3. Avg ADR (achieved)
  grid.appendChild(mkKpiCard({
    label: 'Avg ADR (Achieved)',
    value: avgADR > 0 ? formatEUR(avgADR, { maxFrac: 0 }) : '—',
    subtitle: 'Avg nightly rate across bookings',
    onClick: () => openADRModal(data)
  }));

  // 4. Avg Occupancy
  grid.appendChild(mkKpiCard({
    label: 'Avg Occupancy',
    value: avgOcc > 0 ? avgOcc.toFixed(1) + '%' : '—',
    subtitle: 'Booked + blocked nights ÷ days',
    variant: avgOcc >= 70 ? 'success' : avgOcc >= 40 ? undefined : 'warning',
    onClick: () => openOccModal(data)
  }));

  // 5. Revenue vs Target
  if (targetRev > 0) {
    grid.appendChild(mkKpiCard({
      label: 'Revenue vs Target',
      value: vsTarget != null ? vsTarget.toFixed(1) + '%' : '—',
      subtitle: `Target: ${formatEUR(targetRev, { maxFrac: 0 })}`,
      variant: vsTarget != null && vsTarget >= 90 ? 'success' : vsTarget != null && vsTarget < 70 ? 'danger' : undefined,
      onClick: () => openTargetModal(data)
    }));
  }

  // 6. Avg Rev / Property
  if (propCount > 1) {
    grid.appendChild(mkKpiCard({
      label: 'Avg Rev / Property',
      value: formatEUR(totalRev / propCount, { maxFrac: 0 }),
      subtitle: `Across ${propCount} STR properties`
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
function buildOccupancyCard(data) {
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
    const row = el('div');
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
    el('div', { style: 'font-size:12px;color:var(--text-muted)' }, 'Booked nights ÷ days per month')
  ));
  if (!props.length) { card.appendChild(mkEmptyState('No short-term rental properties found.')); return card; }

  const body = el('div', { style: 'padding:0 16px 16px;overflow-x:auto' });
  const table = el('table', { class: 'table', style: 'min-width:600px' });
  const htr = el('tr');
  htr.appendChild(el('th', {}, 'Property'));
  monthKeys.forEach(k => htr.appendChild(el('th', { class: 'right', style: 'white-space:nowrap' }, k.label)));
  table.appendChild(el('thead', {}, htr));

  let anyNights = false;
  const tbody = el('tbody');
  for (const p of props) {
    const tr = el('tr');
    tr.appendChild(el('td', { style: 'white-space:nowrap;font-weight:600' }, shortName(p.name)));
    monthKeys.forEach(k => {
      const mk = k.key;
      const monthPays = payments.filter(pay => pay.propertyId === p.id && (pay.date || '').slice(0, 7) === mk);
      const nights = monthPays.reduce((s, pay) => s + (pay.airbnbNights || 0), 0);
      const hasField = monthPays.some(pay => pay.airbnbNights != null);
      if (nights > 0) anyNights = true;
      const dim = daysInMonth(+k.y, k.m - 1);
      const pct = Math.min(100, dim > 0 ? nights / dim * 100 : 0);
      const td = el('td', { class: 'right', style: 'cursor:pointer' });
      if (!hasField || nights === 0) {
        td.textContent = monthPays.length > 0 ? '—' : '';
        td.style.color = 'var(--text-muted)';
      } else {
        td.textContent = pct.toFixed(0) + '%';
        td.style.color = pct >= 70 ? 'var(--success)' : pct >= 40 ? '#f59e0b' : 'var(--danger)';
      }
      if (monthPays.length > 0) {
        td.title = 'Click for payments';
        td.onclick = () => {
          const mb = el('div');
          mb.appendChild(mkSectionLabel(`${shortName(p.name)} — ${k.label}`));
          mb.appendChild(mkModalTable(
            [{ label: 'Date' }, { label: 'Nights', right: true }, { label: 'Amount', right: true }],
            [...monthPays].sort((a, b) => (a.date || '').localeCompare(b.date || '')).map(pay => [
              fmtDate(pay.date),
              pay.airbnbNights != null ? String(pay.airbnbNights) : '—',
              formatEUR(pay.amount)
            ])
          ));
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
    }, '⚠ Occupancy data requires Airbnb nights. Import an Airbnb CSV in the Payments section to populate this field.'));
  }
  card.appendChild(body);
  return card;
}

// ── Property comparison table ─────────────────────────────────────────────────
function buildComparisonTable(data) {
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
    const nights = pPays.reduce((s, pay) => s + (pay.airbnbNights || 0), 0);
    const adr   = nights > 0
      ? pPays.reduce((s, pay) => s + (pay.avgNightlyRate || 0) * (pay.airbnbNights || 0), 0) / nights
      : 0;
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

    return el('tr', { style: i % 2 === 1 ? 'background:rgba(255,255,255,0.02)' : '' },
      nameCell,
      revBar,
      mkTd(nights > 0 ? nights.toString() : '—'),
      mkTd(adr > 0 ? formatEUR(adr, { maxFrac: 0 }) : '—'),
      mkTd(occ.pct.toFixed(1) + '%'),
      mkTd(pPays.length.toString())
    );
  });

  const thead = el('thead');
  const hrow = el('tr');
  ['Property', 'Revenue', 'Nights', 'Avg ADR', 'Occupancy', 'Bookings'].forEach((h, hi) => {
    hrow.appendChild(el('th', {
      style: `padding:6px 8px;text-align:${hi === 0 ? 'left' : 'right'};font-size:11px;color:var(--text-muted);border-bottom:1px solid rgba(255,255,255,0.08);white-space:nowrap`
    }, h));
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
  adrSummary.appendChild(mkSummaryBox('Total Revenue', formatEUR(totalRev, { maxFrac: 0 }), curRange.label));
  adrSummary.appendChild(mkSummaryBox('Target Revenue', targetRev > 0 ? formatEUR(targetRev, { maxFrac: 0 }) : '—', 'confirmed months'));
  adrSummary.appendChild(mkSummaryBox('Avg ADR', avgADR > 0 ? formatEUR(avgADR, { maxFrac: 0 }) : '—', 'from bookings'));
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
  occSummary.appendChild(mkSummaryBox('Nights Sold', totalNights.toString(), 'from bookings'));
  const occupiedTotal = months.reduce((s, m) => s + m.occupied, 0);
  const availTotal    = months.reduce((s, m) => s + m.available, 0);
  const periodOcc = availTotal > 0 ? (occupiedTotal / availTotal * 100).toFixed(1) + '%' : '—';
  occSummary.appendChild(mkSummaryBox('Period Occupancy', periodOcc, 'occupied ÷ available'));
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
    el('div', { class: 'card-subtitle' }, new Date().toISOString().slice(0,10) + ' → ' + (() => { const d = new Date(); d.setDate(d.getDate()+90); return d.toISOString().slice(0,10); })())
  ));
  const body = el('div', { style: 'padding:0 16px 16px' });

  const totalLocked = pipeline.reduce((s, r) => s + r.lockedNights, 0);
  const totalLockedRev = pipeline.reduce((s, r) => s + r.lockedRevMin, 0);
  const totalOpen = pipeline.reduce((s, r) => s + r.openNights, 0);
  const totalPot  = pipeline.reduce((s, r) => s + r.potRevMax, 0);

  // Summary row
  const sumGrid = el('div', { style: 'display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:12px' });
  sumGrid.appendChild(mkSummaryBox('Locked Nights', totalLocked.toString(), 'confirmed bookings'));
  sumGrid.appendChild(mkSummaryBox('Locked Revenue', totalLockedRev > 0 ? formatEUR(totalLockedRev, { maxFrac: 0 }) : '—', 'at published rate'));
  sumGrid.appendChild(mkSummaryBox('Open Nights', totalOpen.toString(), 'available to book'));
  sumGrid.appendChild(mkSummaryBox('Revenue Potential', totalPot > 0 ? formatEUR(totalPot, { maxFrac: 0 }) : '—', 'open × target ADR'));
  body.appendChild(sumGrid);

  // Per-property breakdown
  if (pipeline.length) {
    body.appendChild(mkModalTable(
      [
        { label: 'Property', right: false },
        { label: 'Locked Nights', right: true },
        { label: 'Locked Rev', right: true },
        { label: 'Open Nights', right: true },
        { label: 'Rev Potential', right: true }
      ],
      pipeline.map(r => [
        shortName(r.propName),
        r.lockedNights.toString(),
        r.lockedRevMin > 0 ? formatEUR(r.lockedRevMin, { maxFrac: 0 }) : '—',
        r.openNights.toString(),
        r.potRevMax > 0 ? formatEUR(r.potRevMax, { maxFrac: 0 }) : '—'
      ])
    ));
  }

  card.appendChild(body);
  return card;
}

// ── Modal drill-downs ─────────────────────────────────────────────────────────
function openRevenueModal(data) {
  const { payments, props, revByProp, totalRev } = data;
  const body = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });

  body.appendChild(mkSummaryGrid([
    { label: 'Total Revenue', value: formatEUR(totalRev) },
    { label: 'Bookings', value: payments.length.toString() }
  ], 2));

  body.appendChild(mkSectionLabel('Revenue by Property'));
  body.appendChild(mkModalTable(
    ['Property', 'Revenue', '% of Total', 'Bookings'],
    props.map(p => {
      const rev  = revByProp.get(p.id) || 0;
      const pPays = payments.filter(pay => pay.propertyId === p.id);
      return [shortName(p.name), formatEUR(rev), totalRev > 0 ? (rev / totalRev * 100).toFixed(1) + '%' : '—', pPays.length.toString()];
    }),
    { highlight: 1 }
  ));

  body.appendChild(mkSectionLabel(`Top Bookings — ${data.rangeLabel}`));
  const top = [...payments].sort((a, b) => b.amount - a.amount).slice(0, 10);
  body.appendChild(mkModalTable(
    ['Date', 'Property', 'Nights', 'Amount'],
    top.map(p => [
      p.date || '—',
      shortName(byId('properties', p.propertyId)?.name || '—'),
      (p.airbnbNights || '—').toString(),
      formatEUR(p.amount)
    ]),
    { highlight: 3 }
  ));

  openModal({ title: `STR Revenue — ${data.rangeLabel}`, body, large: true });
}

function openNightsModal(data) {
  const { payments, props, monthKeys, keyIndex } = data;
  const body = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });

  const rows = props.map(p => {
    const pPays = payments.filter(pay => pay.propertyId === p.id);
    const nights = pPays.reduce((s, pay) => s + (pay.airbnbNights || 0), 0);
    return [shortName(p.name), nights.toString(), pPays.length.toString()];
  });
  body.appendChild(mkModalTable(['Property', 'Nights Sold', 'Bookings'], rows, { highlight: 1 }));

  body.appendChild(mkSectionLabel('Monthly Breakdown (All Properties)'));
  const byMonth = monthKeys.map(() => 0);
  payments.forEach(p => {
    const idx = keyIndex.get((p.date || '').slice(0, 7));
    if (idx != null) byMonth[idx] += (p.airbnbNights || 0);
  });
  body.appendChild(mkModalTable(
    ['Month', 'Nights Sold'],
    byMonth.map((n, i) => [monthKeys[i].label, n > 0 ? n.toString() : '—']),
    { highlight: 1 }
  ));

  openModal({ title: `Nights Sold — ${data.rangeLabel}`, body, large: true });
}

function openADRModal(data) {
  const { payments, props } = data;
  const body = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });

  body.appendChild(mkSectionLabel('ADR by Property'));
  body.appendChild(mkModalTable(
    ['Property', 'Avg ADR', 'Nights', 'Bookings'],
    props.map(p => {
      const pPays = payments.filter(pay => pay.propertyId === p.id);
      const nights = pPays.reduce((s, pay) => s + (pay.airbnbNights || 0), 0);
      const adr = nights > 0
        ? pPays.reduce((s, pay) => s + (pay.avgNightlyRate || 0) * (pay.airbnbNights || 0), 0) / nights
        : 0;
      return [shortName(p.name), adr > 0 ? formatEUR(adr) : '—', nights.toString(), pPays.length.toString()];
    }),
    { highlight: 1 }
  ));

  openModal({ title: `ADR Breakdown — ${data.rangeLabel}`, body, large: true });
}

function openOccModal(data) {
  const { props, occByProp } = data;
  const body = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });

  body.appendChild(mkModalTable(
    ['Property', 'Occupancy %', 'Occupied', 'Open', 'Blocked (off-market)', 'Available'],
    props.map(p => {
      const occ = occByProp.get(p.id) || { pct: 0, occupied: 0, available: 0, open: 0, blocked: 0 };
      return [shortName(p.name), occ.pct.toFixed(1) + '%', occ.occupied.toString(), occ.open.toString(), occ.blocked.toString(), occ.available.toString()];
    }),
    { highlight: 1 }
  ));

  body.appendChild(el('div', { style: 'font-size:12px;color:var(--text-muted)' },
    'Occupied = sold or reserved · Open = available but unsold · Blocked = owner-closed / off-market (no revenue, excluded from the rate). Occupancy % = Occupied ÷ Available.'));

  openModal({ title: `Occupancy — ${data.rangeLabel}`, body, large: true });
}

function openTargetModal(data) {
  const { props, revByProp, targetRev, totalRev } = data;
  const body = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });

  body.appendChild(mkSummaryGrid([
    { label: 'Actual Revenue', value: formatEUR(totalRev) },
    { label: 'Target Revenue', value: formatEUR(targetRev) },
    { label: 'Achievement', value: targetRev > 0 ? (totalRev / targetRev * 100).toFixed(1) + '%' : '—' },
    { label: 'Variance', value: formatEUR(totalRev - targetRev) }
  ], 4));

  body.appendChild(mkSectionLabel('By Property'));
  const { targetRevByProp } = data;
  body.appendChild(mkModalTable(
    ['Property', 'Actual', 'Target', 'Achievement'],
    props.map(p => {
      const rev = revByProp.get(p.id) || 0;
      const propTarget = targetRevByProp.get(p.id) || 0;
      const ach = propTarget > 0 ? (rev / propTarget * 100).toFixed(1) + '%' : '—';
      return [shortName(p.name), formatEUR(rev), propTarget > 0 ? formatEUR(propTarget) : '—', ach];
    }),
    { highlight: 2 }
  ));

  openModal({ title: `Revenue vs Target — ${data.rangeLabel}`, body, large: true });
}

function openMonthRevenueModal(monthIdx, data) {
  const { payments, monthKeys } = data;
  const k = monthKeys[monthIdx];
  if (!k) return;
  const moPays = payments.filter(p => (p.date || '').startsWith(k.key));
  const moRev  = moPays.reduce((s, p) => s + p.amount, 0);

  const body = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });
  body.appendChild(mkSummaryGrid([
    { label: 'Total Revenue', value: formatEUR(moRev) },
    { label: 'Bookings',      value: moPays.length.toString() }
  ], 2));

  if (moPays.length) {
    body.appendChild(mkModalTable(
      ['Check-in', 'Property', 'Nights', 'Amount'],
      [...moPays].sort((a, b) => (a.airbnbCheckIn || a.date) < (b.airbnbCheckIn || b.date) ? -1 : 1).map(p => [
        p.airbnbCheckIn || p.date || '—',
        shortName(byId('properties', p.propertyId)?.name || '—'),
        (p.airbnbNights || '—').toString(),
        formatEUR(p.amount)
      ]),
      { highlight: 3 }
    ));
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
    { label: 'Revenue',        value: formatEUR(mo.rev) },
    { label: 'Achieved ADR',   value: mo.adr > 0 ? formatEUR(mo.adr) : '—' },
    { label: 'Target ADR',     value: mo.target != null ? formatEUR(mo.target) : '—' },
    { label: 'Occupancy',      value: mo.occ.toFixed(1) + '%' },
    { label: 'Occupied Nights',  value: mo.occupied.toString() },
    { label: 'Available Nights', value: mo.available.toString() }
  ], 3));

  if (pays.length) {
    body.appendChild(mkSectionLabel('Bookings'));
    body.appendChild(mkModalTable(
      ['Check-in', 'Check-out', 'Nights', 'ADR', 'Amount'],
      pays.map(p => [
        p.airbnbCheckIn || p.date || '—',
        p.airbnbCheckOut || '—',
        (p.airbnbNights || '—').toString(),
        p.avgNightlyRate ? formatEUR(p.avgNightlyRate) : '—',
        formatEUR(p.amount)
      ]),
      { highlight: 4 }
    ));
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
