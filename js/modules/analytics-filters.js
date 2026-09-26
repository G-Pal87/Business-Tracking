// Shared filter infrastructure for Executive & Revenue dashboards
import { el, buildMultiSelect, button } from '../core/ui.js';
import { STREAMS, OWNERS } from '../core/config.js';
import { listActive, listActivePayments, listActiveClients, byId, getPeopleOwners, derivedCache, memoGet } from '../core/data.js';
import { todayYmd, addDaysYmd, addMonthsYmd, addYearsYmd, daysInMonth, diffDaysYmd } from '../core/dates.js';
import { streamOf, invoiceOwner } from './analytics-helpers.js';

const ML = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const SS = 'background:var(--bg-elev-1);border:1px solid var(--border);border-radius:var(--radius-sm);padding:6px 10px;font-size:12px;color:var(--text);cursor:pointer';

// ── Data-driven year list (payments + invoices + expenses) ────────────────────
function getDataYears() {
  const y = new Set();
  listActive('invoices').forEach(i => { const yr = (i.issueDate || '').slice(0, 4); if (yr >= '2000') y.add(yr); });
  listActivePayments().forEach(p => { const yr = (p.date || '').slice(0, 4); if (yr >= '2000') y.add(yr); });
  listActive('expenses').forEach(e => { const yr = (e.date || '').slice(0, 4); if (yr >= '2000') y.add(yr); });
  listActive('properties').forEach(p => { const yr = (p.purchaseDate || '').slice(0, 4); if (yr >= '2000') y.add(yr); });
  listActive('forecasts').forEach(f => { if (f.year >= 2000) y.add(String(f.year)); });
  return [...y].sort().reverse(); // newest first
}

// ── Month/Year range picker ───────────────────────────────────────────────────
function buildMonthYearRange(fromVal, toVal, onFrom, onTo) {
  const years = getDataYears();

  function mkYear(cur) {
    const s = el('select', { style: SS });
    s.appendChild(el('option', { value: '' }, 'Year'));
    years.forEach(yr => { const o = el('option', { value: yr }, yr); if (yr === cur) o.selected = true; s.appendChild(o); });
    return s;
  }
  function mkMonth(cur) {
    const s = el('select', { style: SS });
    s.appendChild(el('option', { value: '' }, 'Month'));
    ML.forEach((m, i) => {
      const v = String(i + 1).padStart(2, '0');
      const o = el('option', { value: v }, m);
      if (v === cur) o.selected = true;
      s.appendChild(o);
    });
    return s;
  }

  const fy = fromVal?.slice(0, 4) || '', fm = fromVal?.slice(5, 7) || '';
  const ty = toVal?.slice(0, 4) || '',   tm = toVal?.slice(5, 7) || '';

  const fyS = mkYear(fy), fmS = mkMonth(fm);
  const tyS = mkYear(ty), tmS = mkMonth(tm);

  fyS.addEventListener('change', () => { if (fyS.value && fmS.value) onFrom(fyS.value, fmS.value); });
  fmS.addEventListener('change', () => { if (fyS.value && fmS.value) onFrom(fyS.value, fmS.value); });
  tyS.addEventListener('change', () => { if (tyS.value && tmS.value) onTo(tyS.value, tmS.value); });
  tmS.addEventListener('change', () => { if (tyS.value && tmS.value) onTo(tyS.value, tmS.value); });

  const lbl = txt => el('span', { style: 'font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px;white-space:nowrap' }, txt);

  return el('div', {
    style: 'display:inline-flex;align-items:center;gap:4px;background:var(--bg-elev-1);border:1px solid var(--border);border-radius:var(--radius-sm);padding:3px 8px'
  }, lbl('From'), fyS, fmS,
     el('span', { style: 'color:var(--border);padding:0 4px' }, '→'),
     lbl('To'), tyS, tmS
  );
}

// ── Constants ─────────────────────────────────────────────────────────────────
export const PERIOD_OPTIONS = [
  ['ytd',            'YTD'],
  ['this-month',     'This Month'],
  ['last-month',     'Last Month'],
  ['this-quarter',   'This Quarter'],
  ['last-quarter',   'Last Quarter'],
  ['this-year',      'Full Year'],
  ['last-year',      'Last Year'],
  ['last-30-days',   'Last 30 Days'],
  ['last-90-days',   'Last 90 Days'],
  ['last-12-months', 'Last 12 Months'],
  ['all',            'All Time'],
  ['custom',         'Custom'],
];

export const COMPARISON_OPTIONS = [
  ['none',                  'No Comparison'],
  ['prev-period',           'Previous Period'],
  ['last-month',            'Last Month'],
  ['last-quarter',          'Last Quarter'],
  ['last-year',             'Last Year'],
  ['same-period-last-year', 'Same Period Last Year'],
  ['prev-year',             'Previous Year'],
  ['last-30-days',          'Last 30 Days'],
  ['last-90-days',          'Last 90 Days'],
  ['last-12-months',        'Last 12 Months'],
  ['cmp-custom',            'Custom'],
];

// ── Filter state factory ──────────────────────────────────────────────────────
export function createFilterState(overrides = {}) {
  return Object.assign({
    period:      'ytd',
    customStart: '',
    customEnd:   '',
    owners:      new Set(),
    streams:     new Set(),
    propertyIds: new Set(),
    clientIds:   new Set(),
    compareTo:   'prev-year',
    cmpStart:    '',
    cmpEnd:      '',
  }, overrides);
}

// ── Date utilities (internal) ─────────────────────────────────────────────────
// All range math is pure 'YYYY-MM-DD' calendar arithmetic via core/dates.js
// ("today" is the viewer's LOCAL date), so results never shift a day for a
// UTC+2/+3 viewer or across DST.
const addDays = addDaysYmd;
const addYrs  = addYearsYmd;
const pad2    = n => String(n).padStart(2, '0');
// Last day of the calendar month containing ymd.
const monthEnd = ymd => `${ymd.slice(0, 7)}-${pad2(daysInMonth(+ymd.slice(0, 4), +ymd.slice(5, 7)))}`;

// ── Period range ──────────────────────────────────────────────────────────────
export function getCurrentPeriodRange(gF) {
  const today = todayYmd();
  const y     = +today.slice(0, 4);
  const m     = +today.slice(5, 7) - 1; // 0-based
  const d     = +today.slice(8, 10);

  switch (gF.period) {
    case 'ytd':
      return { start: `${y}-01-01`, end: today, label: `YTD ${y}`, isIncomplete: true };

    case 'this-month': {
      const mm = String(m + 1).padStart(2, '0');
      const lastDay = daysInMonth(y, m + 1);
      return { start: `${y}-${mm}-01`, end: today, label: `${ML[m]} ${y}`, isIncomplete: d < lastDay };
    }

    case 'last-month': {
      const lm = m === 0 ? 12 : m, ly = m === 0 ? y - 1 : y;
      const lmS = String(lm).padStart(2, '0');
      return { start: `${ly}-${lmS}-01`, end: `${ly}-${lmS}-${daysInMonth(ly, lm)}`, label: `${ML[lm - 1]} ${ly}`, isIncomplete: false };
    }

    case 'this-quarter': {
      const qs = Math.floor(m / 3) * 3;
      return { start: `${y}-${String(qs + 1).padStart(2, '0')}-01`, end: today, label: `Q${Math.floor(m / 3) + 1} ${y}`, isIncomplete: true };
    }

    case 'last-quarter': {
      const cq = Math.floor(m / 3), pq = cq === 0 ? 3 : cq - 1, py = cq === 0 ? y - 1 : y;
      const qsm = pq * 3 + 1, qem = qsm + 2;
      return { start: `${py}-${String(qsm).padStart(2, '0')}-01`, end: `${py}-${String(qem).padStart(2, '0')}-${daysInMonth(py, qem)}`, label: `Q${pq + 1} ${py}`, isIncomplete: false };
    }

    case 'this-year': {
      const end = `${y}-12-31`;
      return { start: `${y}-01-01`, end, label: String(y), isIncomplete: today < end };
    }

    case 'last-year': {
      const ly = y - 1;
      return { start: `${ly}-01-01`, end: `${ly}-12-31`, label: String(ly), isIncomplete: false };
    }

    case 'last-30-days':
      return { start: addDays(today, -29), end: today, label: 'Last 30 Days', isIncomplete: false };

    case 'last-90-days':
      return { start: addDays(today, -89), end: today, label: 'Last 90 Days', isIncomplete: false };

    case 'last-12-months':
      return { start: addDays(addYrs(today, -1), 1), end: today, label: 'Last 12 Months', isIncomplete: false };

    case 'all': {
      const years = getDataYears();
      const earliestYear = years.length ? years[years.length - 1] : String(y);
      return { start: `${earliestYear}-01-01`, end: today, label: 'All Time', isIncomplete: false };
    }

    case 'custom':
      if (gF.customStart && gF.customEnd && gF.customStart <= gF.customEnd)
        return { start: gF.customStart, end: gF.customEnd, label: `${gF.customStart} – ${gF.customEnd}`, isIncomplete: false };
      return { start: `${y}-01-01`, end: today, label: `YTD ${y}`, isIncomplete: true };

    default: {
      if (gF.period?.startsWith('year-')) {
        const yr = gF.period.slice(5);
        return { start: `${yr}-01-01`, end: `${yr}-12-31`, label: yr, isIncomplete: false };
      }
      return { start: `${y}-01-01`, end: today, label: `YTD ${y}`, isIncomplete: true };
    }
  }
}

// ── Comparison range ──────────────────────────────────────────────────────────
export function getComparisonRange(gF, cur) {
  if (gF.compareTo === 'none') return null;
  if (gF.period === 'all') return null;

  switch (gF.compareTo) {
    case 'prev-period': {
      // Same number of days, ending the day before the current period starts.
      const newEnd = addDays(cur.start, -1);
      return { start: addDays(newEnd, -diffDaysYmd(cur.start, cur.end)), end: newEnd, label: 'Prev Period' };
    }

    // 'last-month' / 'last-quarter' / 'last-year' are RELATIVE TO THE SELECTED
    // PERIOD: the calendar month / quarter / year immediately before the one
    // containing cur.start (e.g. Q3 2026 → Jun 2026 / Q2 2026 / 2025; a past
    // "2024" period → Dec 2023 / Q4 2023 / 2023) — not relative to today.
    case 'last-month': {
      const start = addMonthsYmd(`${cur.start.slice(0, 7)}-01`, -1);
      return { start, end: monthEnd(start), label: `${ML[+start.slice(5, 7) - 1]} ${start.slice(0, 4)}` };
    }

    case 'last-quarter': {
      const qsm   = Math.floor((+cur.start.slice(5, 7) - 1) / 3) * 3 + 1; // cur.start's quarter's first month
      const start = addMonthsYmd(`${cur.start.slice(0, 4)}-${pad2(qsm)}-01`, -3);
      const end   = monthEnd(addMonthsYmd(start, 2));
      return { start, end, label: `Q${Math.floor((+start.slice(5, 7) - 1) / 3) + 1} ${start.slice(0, 4)}` };
    }

    case 'last-year': {
      const ly = +cur.start.slice(0, 4) - 1;
      return { start: `${ly}-01-01`, end: `${ly}-12-31`, label: String(ly) };
    }

    case 'same-period-last-year':
      return { start: addYrs(cur.start, -1), end: addYrs(cur.end, -1), label: 'Same Period LY' };

    case 'prev-year': {
      // The current range shifted back exactly one year, so like is compared
      // with like (This Quarter → the same quarter last year, not Jan–Sep).
      // When the current range runs past today (e.g. Full Year while the year
      // is in progress) the comparison stops at today−1y, so an in-progress
      // period is never compared against a complete one.
      const start = addYrs(cur.start, -1);
      let end     = addYrs(cur.end, -1);
      const today = todayYmd();
      if (cur.end > today) { const cap = addYrs(today, -1); if (cap < end) end = cap; }
      if (end < start) end = start;
      const py      = start.slice(0, 4);
      const sameYr  = py === end.slice(0, 4);
      // Plain year label only for a whole calendar year; a capped/partial one
      // (e.g. YTD) reads "Same Period 2025" so it isn't mistaken for the full year.
      const label   = sameYr && start.endsWith('-01-01') && end.endsWith('-12-31') ? py : sameYr ? `Same Period ${py}` : 'Prev Year';
      return { start, end, label };
    }

    case 'last-30-days': {
      const end   = addDays(cur.start, -1);
      const start = addDays(end, -29);
      return { start, end, label: 'Prev 30 Days' };
    }

    case 'last-90-days': {
      const end   = addDays(cur.start, -1);
      const start = addDays(end, -89);
      return { start, end, label: 'Prev 90 Days' };
    }

    case 'last-12-months': {
      const end2 = addDays(cur.start, -1);
      return { start: addDays(addYrs(end2, -1), 1), end: end2, label: 'Prev 12 Months' };
    }

    case 'cmp-custom':
      if (!gF.cmpStart || !gF.cmpEnd) return null;
      return { start: gF.cmpStart, end: gF.cmpEnd, label: `${gF.cmpStart} – ${gF.cmpEnd}` };

    default:
      return null;
  }
}

// ── Month keys for a date range ───────────────────────────────────────────────
export function getMonthKeysForRange(start, end) {
  const sy = parseInt(start.slice(0, 4)), sm = parseInt(start.slice(5, 7));
  const ey = parseInt(end.slice(0, 4)),   em = parseInt(end.slice(5, 7));
  const isSingleYear = sy === ey;
  const keys = [];
  let y = sy, m = sm;
  while (y < ey || (y === ey && m <= em)) {
    const mm = String(m).padStart(2, '0');
    keys.push({ key: `${y}-${mm}`, label: isSingleYear ? ML[m - 1] : `${ML[m - 1]} '${String(y).slice(2)}`, y: String(y), m });
    if (++m > 12) { m = 1; y++; }
  }
  return { keys, isSingleYear };
}

// ── Filter matchers ───────────────────────────────────────────────────────────
// Business stream of a record, or `fallback` (default null) when none can be
// resolved. Thin wrapper over analytics-helpers.js streamOf() — the single
// resolver. Filters use the null fallback (unresolved never matches a selected
// stream); breakdowns should use `resolveStream(r) || 'other'` (or
// resolveStream(r, 'other')) so their buckets sum to the headline totals.
export function resolveStream(row, fallback = null) {
  return streamOf(row, fallback);
}

export function makeMatchers(gF) {
  return {
    mStream:   row => { if (!gF.streams.size) return true; const s = resolveStream(row); return s !== null && gF.streams.has(s); },
    mOwner:    row => { if (!gF.owners.size)       return true; const ow = row.propertyId ? (byId('properties', row.propertyId)?.owner || 'both') : (row.owner || 'both'); return ow === 'both' || gF.owners.has(ow); },
    // Owner match for INVOICES — uses the single invoiceOwner() rule
    // (inv.owner → property owner → client owner → 'both').
    mInvOwner: inv => { if (!gF.owners.size)       return true; const ow = invoiceOwner(inv); return ow === 'both' || gF.owners.has(ow); },
    mProperty: row => { if (!gF.propertyIds.size)  return true; if (!row.propertyId) return false; return gF.propertyIds.has(row.propertyId); },
    mClient:   row => { if (!gF.clientIds.size)    return true; if (!row.clientId)   return false; return gF.clientIds.has(row.clientId); },
  };
}

// Distinct (propertyId, resolved stream) pairs over all active payments, in
// order of first occurrence — every filter bar used to resolve the stream of
// every payment. The stream facet below only looks at a payment's propertyId
// and stream, so walking the distinct pairs adds exactly the same streams in
// the same order (a pair passes the filters iff each of its payments does).
// Rebuilt when payments or properties (property type → stream) change.
const _payStreamPairsCache = derivedCache(['payments', 'properties']);
function paymentStreamPairs() {
  return memoGet(_payStreamPairsCache(), 'pairs', () => {
    const seen = new Map(); // propertyId → Set(stream)
    const pairs = [];
    for (const pay of listActivePayments()) {
      const s = resolveStream(pay);
      if (!s) continue;
      let streams = seen.get(pay.propertyId);
      if (!streams) { streams = new Set(); seen.set(pay.propertyId, streams); }
      if (streams.has(s)) continue;
      streams.add(s);
      pairs.push({ propertyId: pay.propertyId, stream: s });
    }
    return pairs;
  });
}

// ── Available filter options (leave-one-out faceting) ─────────────────────────
// For each dimension, compute available options using ALL OTHER active filters
// (not the dimension itself), then trim stale selections from gF.
function computeAvailableOptions(gF, channelScope) {
  const allProps   = channelScope
    ? listActive('properties').filter(p => (p.channel || 'company') === channelScope)
    : listActive('properties');
  const allInvs    = listActive('invoices').filter(i => i.status !== 'cancelled' && i.status !== 'void');
  const allClients = listActiveClients();

  const propStreamKey = p => p.type === 'short_term' ? 'short_term_rental'
                           : p.type === 'long_term'  ? 'long_term_rental' : null;
  const ownerOf = propId => { const p = byId('properties', propId); return p?.owner || 'both'; };

  // ── Available Properties ─────────────────────────────────────────────────
  // Leave-one-out: NOT constrained by gF.propertyIds
  // Constrained by: owners, streams
  const availProps = allProps.filter(p => {
    if (gF.owners.size > 0 && p.owner !== 'both' && !gF.owners.has(p.owner)) return false;
    if (gF.streams.size > 0) {
      const s = propStreamKey(p);
      if (!s || !gF.streams.has(s)) return false;
    }
    return true;
  });
  const availPropIds = new Set(availProps.map(p => p.id));
  for (const id of [...gF.propertyIds]) if (!availPropIds.has(id)) gF.propertyIds.delete(id);

  // ── Available Owners ─────────────────────────────────────────────────────
  // Leave-one-out: NOT constrained by gF.owners
  // Constrained by: streams, propertyIds
  const availOwners = new Set();
  allProps.forEach(p => {
    if (gF.streams.size > 0) {
      const s = propStreamKey(p);
      if (!s || !gF.streams.has(s)) return;
    }
    if (gF.propertyIds.size > 0 && !gF.propertyIds.has(p.id)) return;
    availOwners.add(p.owner || 'both');
  });
  // Owners from invoices (service revenue)
  allInvs.forEach(i => {
    if (gF.streams.size > 0) {
      const s = resolveStream(i);
      if (!s || !gF.streams.has(s)) return;
    }
    if (gF.clientIds.size > 0 && !gF.clientIds.has(i.clientId)) return;
    availOwners.add(invoiceOwner(i)); // same owner rule the invoice matchers use
  });
  for (const o of [...gF.owners]) if (!availOwners.has(o)) gF.owners.delete(o);

  // ── Available Streams ────────────────────────────────────────────────────
  // Leave-one-out: NOT constrained by gF.streams
  // Constrained by: owners, propertyIds, clientIds
  const availStreams = new Set();
  // From property types (rental streams)
  allProps.forEach(p => {
    if (gF.owners.size > 0 && p.owner !== 'both' && !gF.owners.has(p.owner)) return;
    if (gF.propertyIds.size > 0 && !gF.propertyIds.has(p.id)) return;
    const s = propStreamKey(p);
    if (s) availStreams.add(s);
  });
  // From payments (distinct propertyId/stream pairs — see paymentStreamPairs)
  paymentStreamPairs().forEach(pay => {
    const s = pay.stream;
    if (gF.propertyIds.size > 0 && (!pay.propertyId || !gF.propertyIds.has(pay.propertyId))) return;
    if (gF.owners.size > 0 && pay.propertyId) {
      const ow = ownerOf(pay.propertyId);
      if (ow !== 'both' && !gF.owners.has(ow)) return;
    }
    availStreams.add(s);
  });
  // From invoices
  allInvs.forEach(i => {
    const s = resolveStream(i);
    if (!s) return;
    if (gF.clientIds.size > 0 && !gF.clientIds.has(i.clientId)) return;
    if (gF.owners.size > 0 && i.propertyId) {
      const ow = ownerOf(i.propertyId);
      if (ow !== 'both' && !gF.owners.has(ow)) return;
    }
    if (gF.propertyIds.size > 0 && (!i.propertyId || !gF.propertyIds.has(i.propertyId))) return;
    availStreams.add(s);
  });
  for (const s of [...gF.streams]) if (!availStreams.has(s)) gF.streams.delete(s);

  // ── Available Clients ────────────────────────────────────────────────────
  // Leave-one-out: NOT constrained by gF.clientIds
  // Constrained by: streams, owners, propertyIds
  const availClientIds = new Set();
  allInvs.forEach(i => {
    if (!i.clientId) return;
    if (gF.streams.size > 0) {
      const s = resolveStream(i);
      if (!s || !gF.streams.has(s)) return;
    }
    if (gF.owners.size > 0 && i.propertyId) {
      const ow = ownerOf(i.propertyId);
      if (ow !== 'both' && !gF.owners.has(ow)) return;
    }
    if (gF.propertyIds.size > 0 && (!i.propertyId || !gF.propertyIds.has(i.propertyId))) return;
    availClientIds.add(i.clientId);
  });
  const availClients = allClients.filter(c => availClientIds.has(c.id));
  for (const id of [...gF.clientIds]) if (!availClientIds.has(id)) gF.clientIds.delete(id);

  return { availProps, availOwners, availStreams, availClients };
}

// ── Comparison explanation line ───────────────────────────────────────────────
export function buildComparisonLine(curRange, cmpRange) {
  const fmtR = r => {
    if (!r) return '';
    const d1   = new Date(r.start + 'T00:00:00');
    const d2   = new Date(r.end   + 'T00:00:00');
    const sameY = d1.getFullYear() === d2.getFullYear();
    const short = { day: 'numeric', month: 'short' };
    const full  = { day: 'numeric', month: 'short', year: 'numeric' };
    return `${d1.toLocaleDateString('en-GB', sameY ? short : full)} – ${d2.toLocaleDateString('en-GB', full)}`;
  };
  const curStr = `${fmtR(curRange)}${curRange.isIncomplete ? ' (in progress)' : ''}`;
  const text   = cmpRange
    ? `Comparing ${curStr} against ${fmtR(cmpRange)}`
    : `Showing ${curStr}`;
  return el('div', { style: 'font-size:12px;color:var(--text-muted);margin-bottom:12px;font-style:italic' }, text);
}

// ── Filter bar ────────────────────────────────────────────────────────────────
// opts: { showOwner, showStream, showProperty, showClient, storagePrefix }
// onChange(newGF?) — if called with a new state object, caller should replace gF
function makeSelect(options, value, onChange) {
  const s = el('select', { style: SS });
  options.forEach(([v, lbl]) => { const o = el('option', { value: v }, lbl); if (v === value) o.selected = true; s.appendChild(o); });
  s.addEventListener('change', () => onChange(s.value));
  return s;
}

export function buildFilterBar(gF, opts, onChange) {
  const {
    showOwner    = true,
    showStream   = true,
    showProperty = true,
    showClient   = false,
    storagePrefix = 'ana',
    channelScope  = null,
    // Optional hook for callers/sections that keep their own extra filter
    // state alongside the shared owners/streams/props/clients (e.g. the
    // Services section's local invoice-status filter). Reset invokes this
    // after clearing its own state so that state gets cleared too. Defaults
    // to a no-op so every existing caller is unaffected.
    extraReset    = () => {},
  } = opts || {};

  // Compute available options using leave-one-out faceting & trim stale selections
  const { availProps, availOwners, availStreams, availClients } = computeAvailableOptions(gF, channelScope);

  const bar = el('div', { class: 'flex gap-8 mb-16', style: 'flex-wrap:wrap;align-items:center' });

  // Period — static options + dynamic past-year shortcuts
  {
    const s = el('select', { style: SS });
    PERIOD_OPTIONS.forEach(([v, lbl]) => {
      const o = el('option', { value: v }, lbl);
      if (v === gF.period) o.selected = true;
      s.appendChild(o);
    });
    const pastYears = getDataYears().filter(yr => yr < String(new Date().getFullYear()));
    if (pastYears.length) {
      const sep = el('option', { disabled: 'true' }, '──────────');
      s.appendChild(sep);
      pastYears.forEach(yr => {
        const o = el('option', { value: `year-${yr}` }, yr);
        if (`year-${yr}` === gF.period) o.selected = true;
        s.appendChild(o);
      });
    }
    s.addEventListener('change', () => { gF.period = s.value; onChange(); });
    bar.appendChild(s);
  }

  // Custom period: month/year range picker
  if (gF.period === 'custom') {
    bar.appendChild(buildMonthYearRange(
      gF.customStart, gF.customEnd,
      (y, m) => { gF.customStart = `${y}-${m}-01`; onChange(); },
      (y, m) => { const d = new Date(+y, +m, 0).getDate(); gF.customEnd = `${y}-${m}-${String(d).padStart(2, '0')}`; onChange(); }
    ));
  }

  // Owner — only show owners that exist in data given other filters
  if (showOwner) {
    bar.appendChild(buildMultiSelect(
      getPeopleOwners().filter(o => availOwners.has(o.value)),
      gF.owners, 'All Owners', onChange, `${storagePrefix}_owners`
    ));
  }

  // Stream — only show streams that exist in data given other filters
  if (showStream) {
    bar.appendChild(buildMultiSelect(
      Object.entries(STREAMS)
        .filter(([k]) => availStreams.has(k))
        .map(([k, v]) => ({ value: k, label: v.label, css: v.css })),
      gF.streams, 'All Streams', onChange, `${storagePrefix}_streams`
    ));
  }

  // Property — only show properties valid for selected owners & streams
  if (showProperty) {
    bar.appendChild(buildMultiSelect(
      availProps.map(p => ({ value: p.id, label: p.name })),
      gF.propertyIds, 'All Properties', onChange, `${storagePrefix}_props`
    ));
  }

  // Client — only show clients reachable given selected streams, owners, properties
  if (showClient) {
    bar.appendChild(buildMultiSelect(
      availClients.map(c => ({ value: c.id, label: c.name })),
      gF.clientIds, 'All Clients', onChange, `${storagePrefix}_clients`
    ));
  }

  // Compare To
  bar.appendChild(makeSelect(COMPARISON_OPTIONS, gF.compareTo, v => { gF.compareTo = v; onChange(); }));

  // Custom comparison: month/year range picker
  if (gF.compareTo === 'cmp-custom') {
    bar.appendChild(buildMonthYearRange(
      gF.cmpStart, gF.cmpEnd,
      (y, m) => { gF.cmpStart = `${y}-${m}-01`; onChange(); },
      (y, m) => { const d = new Date(+y, +m, 0).getDate(); gF.cmpEnd = `${y}-${m}-${String(d).padStart(2, '0')}`; onChange(); }
    ));
  }

  // Reset — must clear localStorage first, otherwise buildMultiSelect will
  // restore the old selections from storage the moment the bar is rebuilt.
  bar.appendChild(button('Reset', {
    variant: 'sm ghost',
    onClick: () => {
      ['_owners', '_streams', '_props', '_clients'].forEach(k => {
        try { localStorage.removeItem(`btf:${storagePrefix}${k}`); } catch {}
      });
      extraReset();
      onChange(createFilterState({ period: 'all' }));
    },
  }));

  return bar;
}
