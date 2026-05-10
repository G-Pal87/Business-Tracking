// Shared filter infrastructure for Executive & Revenue dashboards
import { el, buildMultiSelect, button } from '../core/ui.js';
import { STREAMS, OWNERS } from '../core/config.js';
import { listActive, listActivePayments, listActiveClients, byId } from '../core/data.js';

const ML = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const SS = 'background:var(--bg-elev-1);border:1px solid var(--border);border-radius:var(--radius-sm);padding:6px 10px;font-size:12px;color:var(--text);cursor:pointer';

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
const fmtD    = dt => (dt instanceof Date ? dt : new Date(dt)).toISOString().slice(0, 10);
const addDays = (d, n) => { const dt = new Date(d); dt.setDate(dt.getDate() + n); return fmtD(dt); };
const addYrs  = (d, n) => { const dt = new Date(d); dt.setFullYear(dt.getFullYear() + n); return fmtD(dt); };

// ── Period range ──────────────────────────────────────────────────────────────
export function getCurrentPeriodRange(gF) {
  const now   = new Date();
  const today = fmtD(now);
  const y     = now.getFullYear();
  const m     = now.getMonth(); // 0-based
  const d     = now.getDate();

  switch (gF.period) {
    case 'ytd':
      return { start: `${y}-01-01`, end: today, label: `YTD ${y}`, isIncomplete: true };

    case 'this-month': {
      const mm = String(m + 1).padStart(2, '0');
      const lastDay = new Date(y, m + 1, 0).getDate();
      return { start: `${y}-${mm}-01`, end: today, label: `${ML[m]} ${y}`, isIncomplete: d < lastDay };
    }

    case 'last-month': {
      const lm = m === 0 ? 12 : m, ly = m === 0 ? y - 1 : y;
      const lmS = String(lm).padStart(2, '0');
      return { start: `${ly}-${lmS}-01`, end: `${ly}-${lmS}-${new Date(ly, lm, 0).getDate()}`, label: `${ML[lm - 1]} ${ly}`, isIncomplete: false };
    }

    case 'this-quarter': {
      const qs = Math.floor(m / 3) * 3;
      return { start: `${y}-${String(qs + 1).padStart(2, '0')}-01`, end: today, label: `Q${Math.floor(m / 3) + 1} ${y}`, isIncomplete: true };
    }

    case 'last-quarter': {
      const cq = Math.floor(m / 3), pq = cq === 0 ? 3 : cq - 1, py = cq === 0 ? y - 1 : y;
      const qsm = pq * 3 + 1, qem = qsm + 2;
      return { start: `${py}-${String(qsm).padStart(2, '0')}-01`, end: `${py}-${String(qem).padStart(2, '0')}-${new Date(py, qem, 0).getDate()}`, label: `Q${pq + 1} ${py}`, isIncomplete: false };
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
      return { start: addDays(now, -29), end: today, label: 'Last 30 Days', isIncomplete: false };

    case 'last-90-days':
      return { start: addDays(now, -89), end: today, label: 'Last 90 Days', isIncomplete: false };

    case 'last-12-months': {
      const s = new Date(now);
      s.setFullYear(s.getFullYear() - 1);
      s.setDate(s.getDate() + 1);
      return { start: fmtD(s), end: today, label: 'Last 12 Months', isIncomplete: false };
    }

    case 'all':
      return { start: '2000-01-01', end: today, label: 'All Time', isIncomplete: false };

    case 'custom':
      if (gF.customStart && gF.customEnd && gF.customStart <= gF.customEnd)
        return { start: gF.customStart, end: gF.customEnd, label: `${gF.customStart} – ${gF.customEnd}`, isIncomplete: false };
      return { start: `${y}-01-01`, end: today, label: `YTD ${y}`, isIncomplete: true };

    default:
      return { start: `${y}-01-01`, end: today, label: `YTD ${y}`, isIncomplete: true };
  }
}

// ── Comparison range ──────────────────────────────────────────────────────────
export function getComparisonRange(gF, cur) {
  if (gF.compareTo === 'none') return null;

  const durMs = new Date(cur.end) - new Date(cur.start);

  switch (gF.compareTo) {
    case 'prev-period': {
      const newEnd   = new Date(new Date(cur.start) - 86400000);
      const newStart = new Date(newEnd - durMs);
      return { start: fmtD(newStart), end: fmtD(newEnd), label: 'Prev Period' };
    }

    case 'last-month': {
      const now = new Date();
      const lm  = now.getMonth() === 0 ? 12 : now.getMonth();
      const ly  = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
      const lmS = String(lm).padStart(2, '0');
      return { start: `${ly}-${lmS}-01`, end: `${ly}-${lmS}-${new Date(ly, lm, 0).getDate()}`, label: `${ML[lm - 1]} ${ly}` };
    }

    case 'last-quarter': {
      const now = new Date();
      const cq  = Math.floor(now.getMonth() / 3), pq = cq === 0 ? 3 : cq - 1, py = cq === 0 ? now.getFullYear() - 1 : now.getFullYear();
      const qsm = pq * 3 + 1, qem = qsm + 2;
      return { start: `${py}-${String(qsm).padStart(2, '0')}-01`, end: `${py}-${String(qem).padStart(2, '0')}-${new Date(py, qem, 0).getDate()}`, label: `Q${pq + 1} ${py}` };
    }

    case 'last-year': {
      const ly = new Date().getFullYear() - 1;
      return { start: `${ly}-01-01`, end: `${ly}-12-31`, label: String(ly) };
    }

    case 'same-period-last-year':
      return { start: addYrs(cur.start, -1), end: addYrs(cur.end, -1), label: 'Same Period LY' };

    case 'prev-year': {
      const py  = new Date(cur.start).getFullYear() - 1;
      const end = cur.isIncomplete ? addYrs(cur.end, -1) : `${py}-12-31`;
      return { start: `${py}-01-01`, end, label: String(py) };
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
      const s    = new Date(end2);
      s.setFullYear(s.getFullYear() - 1);
      s.setDate(s.getDate() + 1);
      return { start: fmtD(s), end: end2, label: 'Prev 12 Months' };
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
export function resolveStream(row) {
  if (row.stream) return row.stream;
  if (row.propertyId) {
    const p = byId('properties', row.propertyId);
    if (p?.type === 'short_term') return 'short_term_rental';
    if (p?.type === 'long_term')  return 'long_term_rental';
  }
  return null;
}

export function makeMatchers(gF) {
  return {
    mStream:   row => { if (!gF.streams.size) return true; const s = resolveStream(row); return s !== null && gF.streams.has(s); },
    mOwner:    row => { if (!gF.owners.size)       return true; const ow = row.propertyId ? (byId('properties', row.propertyId)?.owner || 'both') : (row.owner || 'both'); return ow === 'both' || gF.owners.has(ow); },
    mProperty: row => { if (!gF.propertyIds.size)  return true; if (!row.propertyId) return false; return gF.propertyIds.has(row.propertyId); },
    mClient:   row => { if (!gF.clientIds.size)    return true; if (!row.clientId)   return false; return gF.clientIds.has(row.clientId); },
  };
}

// ── Available filter options (leave-one-out faceting) ─────────────────────────
// For each dimension, compute available options using ALL OTHER active filters
// (not the dimension itself), then trim stale selections from gF.
function computeAvailableOptions(gF) {
  const allProps   = listActive('properties');
  const allPays    = listActivePayments();
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
    const ow = i.propertyId ? ownerOf(i.propertyId) : (i.owner || 'both');
    availOwners.add(ow);
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
  // From payments
  allPays.forEach(pay => {
    const s = resolveStream(pay);
    if (!s) return;
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
    const sameM = d1.getFullYear() === d2.getFullYear() && d1.getMonth() === d2.getMonth();
    const short = { day: 'numeric', month: 'short' };
    const full  = { day: 'numeric', month: 'short', year: 'numeric' };
    return sameM
      ? `${d1.toLocaleDateString('en-GB', short)} – ${d2.toLocaleDateString('en-GB', full)}`
      : `${d1.toLocaleDateString('en-GB', short)} – ${d2.toLocaleDateString('en-GB', full)}`;
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
  } = opts || {};

  // Compute available options using leave-one-out faceting & trim stale selections
  const { availProps, availOwners, availStreams, availClients } = computeAvailableOptions(gF);

  const bar = el('div', { class: 'flex gap-8 mb-16', style: 'flex-wrap:wrap;align-items:center' });

  // Period
  bar.appendChild(makeSelect(PERIOD_OPTIONS, gF.period, v => { gF.period = v; onChange(); }));

  // Custom period: date pickers
  if (gF.period === 'custom') {
    const fromIn = el('input', { type: 'date', value: gF.customStart, style: SS, title: 'From' });
    fromIn.addEventListener('change', () => { gF.customStart = fromIn.value; onChange(); });
    bar.appendChild(fromIn);
    const toIn = el('input', { type: 'date', value: gF.customEnd, style: SS, title: 'To' });
    toIn.addEventListener('change', () => { gF.customEnd = toIn.value; onChange(); });
    bar.appendChild(toIn);
  }

  // Owner — only show owners that exist in data given other filters
  if (showOwner) {
    bar.appendChild(buildMultiSelect(
      Object.entries(OWNERS)
        .filter(([k]) => availOwners.has(k))
        .map(([k, v]) => ({ value: k, label: v })),
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

  // Custom comparison: date pickers
  if (gF.compareTo === 'cmp-custom') {
    const fromIn = el('input', { type: 'date', value: gF.cmpStart, style: SS, title: 'Compare from' });
    fromIn.addEventListener('change', () => { gF.cmpStart = fromIn.value; onChange(); });
    bar.appendChild(fromIn);
    const toIn = el('input', { type: 'date', value: gF.cmpEnd, style: SS, title: 'Compare to' });
    toIn.addEventListener('change', () => { gF.cmpEnd = toIn.value; onChange(); });
    bar.appendChild(toIn);
  }

  // Reset
  bar.appendChild(button('Reset', {
    variant: 'sm ghost',
    onClick: () => onChange(createFilterState()),
  }));

  return bar;
}
