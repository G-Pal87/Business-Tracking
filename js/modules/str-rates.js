// STR Daily Rates — historic per-night rates derived from bookings, projected
// into a month calendar with suggested prices for open days. Booked/blocked
// days can be overlaid from an Airbnb iCal feed.
import { state } from '../core/state.js';
import { el, openModal, closeModal, toast, select, input, button, formRow, fmtDate, confirmDialog } from '../core/ui.js';
import { listActive, listActivePayments, byId, upsert, newId, formatMoney } from '../core/data.js';
import { fetchICal, parseICal } from '../core/ical.js';
import { uploadGithubFile } from '../core/github.js';
import { AIRBNB_GUEST_FEE_PCT, AIRBNB_TAX_PCT, AIRBNB_CLEANING_FEE } from '../core/config.js';

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const WEEKDAYS = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];

// Persisted view selection across refreshes/navigation.
let _propId  = null;
let _anchor  = null; // "YYYY-MM" of the month being displayed

// Track in-flight iCal refreshes so concurrent renders don't spawn duplicate fetches.
const _icalRefreshing = new Set();

export default {
  id: 'str-rates',
  label: 'STR Daily Rates',
  icon: '€',
  render(container) { container.appendChild(build()); },
  refresh() { const c = document.getElementById('content'); c.innerHTML = ''; c.appendChild(build()); },
  destroy() {}
};

// ── UTC-safe date helpers (avoid local-timezone drift on YYYY-MM-DD strings) ──
function parseYMD(s) { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); }
function ymd(date)   { return date.toISOString().slice(0, 10); }
function addDays(s, n) { const d = parseYMD(s); d.setUTCDate(d.getUTCDate() + n); return ymd(d); }
function todayStr()  { return new Date().toISOString().slice(0, 10); }
function thisMonth() { return todayStr().slice(0, 7); }
function daysInMonth(year, month1) { return new Date(Date.UTC(year, month1, 0)).getUTCDate(); }

// ── Booking → per-night rate extraction ──────────────────────────────────────
// A reservation earns `avgNight` for each night from check-in (inclusive) to
// check-out (exclusive). We prefer the rate excluding the cleaning fee so the
// nightly price reflects what a guest is charged per night.
function checkInOf(p)  { return p.airbnbCheckIn  || p.checkIn  || ''; }
function checkOutOf(p) { return p.airbnbCheckOut || p.checkOut || ''; }

function avgNightOf(p) {
  if (p.avgNightExclCleaning != null) return p.avgNightExclCleaning;
  if (p.avgNightlyRate != null)       return p.avgNightlyRate;
  const ci = checkInOf(p), co = checkOutOf(p);
  const n = p.airbnbNights || (ci && co ? Math.max(0, Math.round((parseYMD(co) - parseYMD(ci)) / 86400000)) : 0);
  if (n > 0 && p.amount) return p.amount / n;
  return null;
}

// ADR = total payout per night (cleaning fee amortised in). Used for pricing benchmarks.
function adrNightOf(p) {
  const ci = checkInOf(p), co = checkOutOf(p);
  const n = p.airbnbNights || (ci && co ? Math.max(0, Math.round((parseYMD(co) - parseYMD(ci)) / 86400000)) : 0);
  if (n > 0 && p.amount) return p.amount / n;
  if (p.avgNightlyRate != null) return p.avgNightlyRate;
  return null;
}

// Build date → { rate, currency, label } for every historic night of an STR property.
function historicNightMap(propertyId) {
  const map = new Map();
  const bookings = listActivePayments().filter(p =>
    p.propertyId === propertyId &&
    p.stream === 'short_term_rental' &&
    p.status !== 'materialized' &&          // materialized duplicates a paid record
    checkInOf(p) && checkOutOf(p)
  );
  for (const p of bookings) {
    const rate = avgNightOf(p);
    if (rate == null || rate <= 0) continue;
    const ci = checkInOf(p), co = checkOutOf(p);
    const nights = p.airbnbNights || Math.max(0, Math.round((parseYMD(co) - parseYMD(ci)) / 86400000));
    const adr  = adrNightOf(p) || rate;
    const guest = (p.notes || '').split(' · ')[0] || '';
    for (let cur = ci; cur < co; cur = addDays(cur, 1)) {
      map.set(cur, {
        rate, adr,
        currency: p.currency || 'EUR',
        label: guest,
        code: p.confirmationCode || '',
        nights,
        amount: p.amount ?? null,
        cleaningFee: p.airbnbCleaningFee ?? null,
        checkIn: ci, checkOut: co
      });
    }
  }
  return map;
}

// ── Suggestion engine ─────────────────────────────────────────────────────────
// Priority: current year (3×) > year-1 (1.95×) > year-2 (1.27×) > year-3 (0.82×) …
// Each prior year is weighted at PRIOR_YEAR_DECAY of the year before it.
// Same-day data uses the same decay (no separate SAME_DAY_WEIGHT).
// Current year stands alone when its effectiveN ≥ STANDALONE_THRESHOLD.
const MIN_SAME_DAY_YEARS   = 2;
const CURRENT_YEAR_WEIGHT  = 3;    // weight for the current year's per-night data
const PRIOR_YEAR_DECAY     = 0.65; // each prior year = previous year × this factor
const STANDALONE_THRESHOLD = 15;   // effectiveN above which current year needs no prior blend

function buildSuggester(histMap) {
  const byYearMonth = new Map();
  const byMonthDay  = new Map();
  const all = [];
  for (const [date, info] of histMap) {
    const ym = date.slice(0, 7), md = date.slice(5);
    const entry = {
      date, rate: info.rate, adr: info.adr || info.rate,
      checkIn: info.checkIn || '', checkOut: info.checkOut || '',
      code: info.code || '', label: info.label || ''
    };
    (byYearMonth.get(ym) || byYearMonth.set(ym, []).get(ym)).push(entry);
    (byMonthDay.get(md)  || byMonthDay.set(md,  []).get(md)).push(entry);
    all.push(entry);
  }
  const avg    = arr => arr.reduce((s, r) => s + r.rate, 0) / arr.length;
  const avgADR = arr => arr.reduce((s, r) => s + r.adr,  0) / arr.length;

  // Per-night weight for data that is `yearsAgo` years old.
  function yrWeight(yearsAgo) {
    return CURRENT_YEAR_WEIGHT * Math.pow(PRIOR_YEAR_DECAY, yearsAgo);
  }
  // Format weight for display: "3×", "1.95×", "1.27×" …
  function fmtW(w) { return Number.isInteger(w) ? `${w}` : w.toFixed(2); }

  return function suggest(date) {
    const ym     = date.slice(0, 7);
    const dayStr = date.slice(8);
    const mo     = date.slice(5, 7);
    const moName = MONTHS[Number(mo) - 1];
    const yr     = ym.slice(0, 4);
    const yrNum  = Number(yr);

    const ymArr = byYearMonth.get(ym) || [];

    // All years that have data for this same month, sorted newest-first.
    const monthByYear = [];
    for (const [ym2, entries] of byYearMonth) {
      if (ym2.slice(5, 7) !== mo) continue;
      const yr2 = ym2.slice(0, 4);
      const yearsAgo = yrNum - Number(yr2);
      if (yearsAgo < 0) continue;
      monthByYear.push({ yr2, yearsAgo, entries, weight: yrWeight(yearsAgo),
        label: `${moName} ${yr2}` });
    }
    monthByYear.sort((a, b) => a.yearsAgo - b.yearsAgo);

    // Same calendar-day data split by prior year.
    const priorDayMap = new Map();
    for (const e of (byMonthDay.get(date.slice(5)) || [])) {
      const yr2 = e.date.slice(0, 4);
      if (yr2 === yr) continue;
      if (!priorDayMap.has(yr2)) priorDayMap.set(yr2, []);
      priorDayMap.get(yr2).push(e);
    }
    const priorDayYears = priorDayMap.size;

    // Current-year context from other months (reference only — not part of blend).
    let currentYearContext = null;
    if (!ymArr.length) {
      const cyOther = [];
      for (const [ym2, entries] of byYearMonth) {
        if (ym2.slice(0, 4) === yr && ym2 !== ym) cyOther.push(...entries);
      }
      if (cyOther.length) {
        const cyMonths = [...new Set(cyOther.map(e => MONTHS[Number(e.date.slice(5, 7)) - 1]))];
        currentYearContext = { nights: cyOther.length, avgRate: avg(cyOther),
          avgADR: avgADR(cyOther), months: cyMonths.join(', ') };
      }
    }

    // ── Decide which pools to use ──────────────────────────────────────────
    const pools = [];
    const currentEffN = ymArr.length * CURRENT_YEAR_WEIGHT;

    if (ymArr.length && currentEffN >= STANDALONE_THRESHOLD) {
      // Strong current-year signal — use alone, no prior blend needed.
      pools.push(monthByYear.find(p => p.yearsAgo === 0));

    } else if (ymArr.length) {
      // Thin current-year signal — blend with prior years, each decayed.
      for (const p of monthByYear) pools.push(p);

    } else {
      // No current-year data at all.
      if (priorDayYears >= MIN_SAME_DAY_YEARS) {
        // Same calendar-day, per-year decay.
        for (const [yr2, entries] of priorDayMap) {
          const yearsAgo = yrNum - Number(yr2);
          pools.push({ yr2, yearsAgo, entries, weight: yrWeight(yearsAgo),
            label: `${moName} ${yr2} day ${dayStr}` });
        }
        pools.sort((a, b) => a.yearsAgo - b.yearsAgo);
      } else {
        // Month average, per-year decay.
        for (const p of monthByYear) if (p.yearsAgo > 0) pools.push(p);
        if (!pools.length && all.length)
          pools.push({ label: 'overall history', entries: all, weight: 1 });
      }
    }
    if (!pools.length) return null;

    // ── Weighted blend ─────────────────────────────────────────────────────
    let totalW = 0, rateSum = 0, adrSum = 0;
    for (const pool of pools) {
      pool.rate = avg(pool.entries);
      pool.adr  = avgADR(pool.entries);
      const w   = pool.entries.length * pool.weight;
      rateSum  += pool.rate * w; adrSum += pool.adr * w; totalW += w;
    }
    const blendedRate = rateSum / totalW;
    const blendedADR  = adrSum  / totalW;
    const effectiveN  = Math.round(totalW);
    const confidence  = effectiveN >= 15 ? 'high' : effectiveN >= 5 ? 'medium' : 'low';

    const basis = pools.length > 1
      ? pools.map(p => `${p.label} (${p.entries.length}n, ${fmtW(p.weight)}×)`).join(' + ')
      : `${pools[0].label} (${pools[0].entries.length} night${pools[0].entries.length !== 1 ? 's' : ''})`;

    const fallbackReason = !ymArr.length
      ? (priorDayYears > 0 && priorDayYears < MIN_SAME_DAY_YEARS
          ? `Only ${priorDayYears} year of day-${dayStr} data (need ${MIN_SAME_DAY_YEARS}) — using ${moName} average`
          : `No ${moName} ${yr} bookings yet`)
      : null;

    // Plain-language reasoning.
    const priorPools = pools.filter(p => p.yearsAgo > 0);
    const why = ymArr.length
      ? (pools.length > 1
          ? `${moName} ${yr}: ${ymArr.length}n at ${fmtW(CURRENT_YEAR_WEIGHT)}× — blended with: ${priorPools.map(p => `${p.yr2} (${p.entries.length}n at ${fmtW(p.weight)}×)`).join(', ')}.`
          : `${moName} ${yr}: ${ymArr.length} night${ymArr.length > 1 ? 's' : ''} — strong standalone signal, no prior-year blend needed.`)
      : (priorDayYears >= MIN_SAME_DAY_YEARS
          ? `No ${moName} ${yr} bookings yet. Day-${dayStr} data (per-year decay): ${pools.map(p => `${p.yr2} (${p.entries.length}n at ${fmtW(p.weight)}×)`).join(', ')}.`
          : pools[0]?.label !== 'overall history'
              ? `No ${moName} ${yr} bookings yet. Prior-year ${moName} data (per-year decay): ${pools.map(p => `${p.yr2} (${p.entries.length}n at ${fmtW(p.weight)}×)`).join(', ')}.`
              : 'No month-specific history found — using overall property average.');

    const confidenceNote = buildConfidenceNote(pools, effectiveN, confidence, moName, yr, dayStr, priorDayYears, currentEffN);

    return {
      rate: blendedRate, adr: blendedADR,
      basis, confidence, effectiveN, confidenceNote, why,
      pools, sources: pools.flatMap(p => p.entries),
      fallbackReason, currentYearContext
    };
  };
}

function buildConfidenceNote(pools, effectiveN, confidence, moName, yr, dayStr, priorDayYears, currentEffN) {
  const curPool        = pools.find(p => p.yearsAgo === 0);
  const priorPools     = pools.filter(p => p.yearsAgo > 0);
  const totalPriorN    = priorPools.reduce((s, p) => s + p.entries.length, 0);
  const priorYearRange = priorPools.length
    ? (priorPools.length === 1
        ? priorPools[0].yr2
        : `${priorPools[priorPools.length - 1].yr2}–${priorPools[0].yr2}`)
    : '';

  if (confidence === 'high') {
    if (curPool && priorPools.length)
      return `Strong signal: ${curPool.entries.length} ${yr} night${curPool.entries.length > 1 ? 's' : ''} (${CURRENT_YEAR_WEIGHT}×) + ${totalPriorN} prior-year nights (${priorYearRange}, decay-weighted)`;
    if (curPool)
      return `${curPool.entries.length} ${moName} ${yr} nights — strong current-year signal, no prior blend needed`;
    return `${totalPriorN} nights across ${priorYearRange} — solid prior-year baseline`;
  }
  if (confidence === 'medium') {
    if (curPool)
      return `${curPool.entries.length} ${moName} ${yr} night${curPool.entries.length > 1 ? 's' : ''} blended with ${totalPriorN} prior-year nights (${priorYearRange}) — moderate confidence`;
    return `${totalPriorN} prior-year nights (${priorYearRange}) — no ${moName} ${yr} data yet`;
  }
  if (curPool)
    return `Only ${curPool.entries.length} ${moName} ${yr} night${curPool.entries.length > 1 ? 's' : ''} — low confidence; rate will shift as more ${yr} bookings arrive`;
  if (priorDayYears === 1)
    return `Only 1 year of day-${dayStr} history — insufficient for reliable same-day signal`;
  return `Very little data — treat as rough estimate only`;
}

// ── Monthly stats (for trend chart + insights) ───────────────────────────────
function buildMonthlyStats(propertyId, anchor, numMonths = 12) {
  const bookings = listActivePayments().filter(p =>
    p.propertyId === propertyId &&
    p.stream === 'short_term_rental' &&
    p.status !== 'materialized' &&
    checkInOf(p) && checkOutOf(p)
  );
  const months = [];
  let cur = anchor;
  for (let i = 0; i < numMonths; i++) { months.unshift(cur); cur = shiftMonth(cur, -1); }

  const byMo = new Map();
  for (const p of bookings) {
    const adr = adrNightOf(p), net = avgNightOf(p);
    if (!adr && !net) continue;
    const ci = checkInOf(p), co = checkOutOf(p);
    for (let d = ci; d < co; d = addDays(d, 1)) {
      const mo = d.slice(0, 7);
      if (!byMo.has(mo)) byMo.set(mo, { adrSum: 0, netSum: 0, nights: 0 });
      const b = byMo.get(mo);
      b.adrSum += (adr || net || 0); b.netSum += (net || adr || 0); b.nights++;
    }
  }
  return months.map(mo => {
    const [y, m] = mo.split('-').map(Number);
    const dim = daysInMonth(y, m);
    const b = byMo.get(mo) || { adrSum: 0, netSum: 0, nights: 0 };
    return {
      month: mo,
      adr:     b.nights ? b.adrSum / b.nights : null,
      netRate: b.nights ? b.netSum / b.nights : null,
      nights: b.nights, days: dim,
      occ: Math.round((b.nights / dim) * 100)
    };
  });
}

// ── Occupancy × ADR by year (for a given calendar month) ─────────────────────
// Returns one row per year that has bookings in that month.
function buildOccupancyByYear(propertyId, month1) {
  const mo = String(month1).padStart(2, '0');
  const bookings = listActivePayments().filter(p =>
    p.propertyId === propertyId && p.stream === 'short_term_rental' &&
    p.status !== 'materialized' && checkInOf(p) && checkOutOf(p)
  );
  const byYear = new Map();
  for (const p of bookings) {
    const adr = adrNightOf(p), net = avgNightOf(p);
    if (!adr && !net) continue;
    const ci = checkInOf(p), co = checkOutOf(p);
    for (let d = ci; d < co; d = addDays(d, 1)) {
      if (d.slice(5, 7) !== mo) continue;
      const yr = d.slice(0, 4);
      if (!byYear.has(yr)) byYear.set(yr, { adrSum: 0, netSum: 0, nights: 0 });
      const b = byYear.get(yr);
      b.nights++; b.adrSum += (adr || net || 0); b.netSum += (net || adr || 0);
    }
  }
  return [...byYear.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([yr, b]) => ({
      year: yr,
      nights: b.nights,
      total: daysInMonth(Number(yr), month1),
      occ: b.nights / daysInMonth(Number(yr), month1),
      adr: b.nights ? b.adrSum / b.nights : null,
      net: b.nights ? b.netSum / b.nights : null,
      revenue: b.nights ? b.adrSum : null   // sum of ADR×nights = total ADR revenue
    }));
}

function renderOccupancyHistory(data, month1, ccy, confirmedADR) {
  const wrap = el('div', { style: 'margin-bottom:14px' });
  if (!data.length) {
    wrap.appendChild(el('div', { style: 'font-size:12px;color:var(--text-muted)' }, 'No historical data yet.'));
    return wrap;
  }

  const moName = MONTHS[month1 - 1];
  const fmt    = v => formatMoney(v, ccy, { maxFrac: 0 });
  const pct    = v => `${Math.round(v * 100)}%`;
  const today  = todayStr();
  const curYr  = today.slice(0, 4);
  const curMo  = today.slice(5, 7);

  // ── SVG bar chart ─────────────────────────────────────────────────────
  const W = 560, H = 190, PAD = { t: 50, b: 44, l: 32, r: 12 };
  const chartW = W - PAD.l - PAD.r;
  const chartH = H - PAD.t - PAD.b;
  const cols   = data.length;
  const barW   = Math.min(52, (chartW / cols) * 0.58);
  const slot   = chartW / cols;

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.style.cssText = 'width:100%;max-width:560px;height:auto;display:block;overflow:visible';

  // Grid lines at 25 / 50 / 75 / 100 %
  for (const level of [0.25, 0.5, 0.75, 1]) {
    const y = PAD.t + chartH * (1 - level);
    const ln = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    ln.setAttribute('x1', PAD.l); ln.setAttribute('x2', W - PAD.r);
    ln.setAttribute('y1', y);     ln.setAttribute('y2', y);
    ln.setAttribute('stroke', level === 0.5 ? 'rgba(128,128,128,0.25)' : 'rgba(128,128,128,0.10)');
    ln.setAttribute('stroke-dasharray', level === 1 ? '' : '3,3');
    svg.appendChild(ln);
    const lbl = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    lbl.setAttribute('x', PAD.l - 4); lbl.setAttribute('y', y + 4);
    lbl.setAttribute('text-anchor', 'end'); lbl.setAttribute('font-size', '9');
    lbl.setAttribute('fill', 'var(--text-muted)');
    lbl.textContent = level === 1 ? '100%' : level === 0.5 ? '50%' : '';
    svg.appendChild(lbl);
  }

  // Confirmed ADR target line (if set) — drawn as a labelled horizontal reference on a second pass
  // We'll add it after bars so it sits on top.

  // Bars
  data.forEach((d, i) => {
    const cx   = PAD.l + i * slot + slot / 2;
    const barH = Math.max(d.occ * chartH, 2);
    const barY = PAD.t + chartH - barH;
    const isCurrentYr  = d.year === curYr;
    const isPartial = isCurrentYr && String(month1).padStart(2, '0') === curMo;

    const fillColor = d.occ >= 0.8 ? '#10b981' : d.occ >= 0.5 ? '#6366f1' : '#f59e0b';

    // Bar (hatched/lighter for partial current month)
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', cx - barW / 2); rect.setAttribute('y', barY);
    rect.setAttribute('width', barW); rect.setAttribute('height', barH);
    rect.setAttribute('rx', '3');
    rect.setAttribute('fill', fillColor);
    rect.setAttribute('opacity', isPartial ? '0.45' : '0.82');
    svg.appendChild(rect);

    // Occupancy % above bar
    const occTxt = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    occTxt.setAttribute('x', cx); occTxt.setAttribute('y', barY - 16);
    occTxt.setAttribute('text-anchor', 'middle'); occTxt.setAttribute('font-size', '10');
    occTxt.setAttribute('fill', 'var(--text-muted)');
    occTxt.textContent = pct(d.occ) + (isPartial ? '*' : '');
    svg.appendChild(occTxt);

    // ADR above occupancy % — amber, bold
    if (d.adr) {
      const adrTxt = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      adrTxt.setAttribute('x', cx); adrTxt.setAttribute('y', barY - 28);
      adrTxt.setAttribute('text-anchor', 'middle'); adrTxt.setAttribute('font-size', '11');
      adrTxt.setAttribute('font-weight', '700'); adrTxt.setAttribute('fill', '#f59e0b');
      adrTxt.textContent = fmt(d.adr);
      svg.appendChild(adrTxt);
    }

    // Year label
    const yrTxt = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    yrTxt.setAttribute('x', cx); yrTxt.setAttribute('y', PAD.t + chartH + 14);
    yrTxt.setAttribute('text-anchor', 'middle'); yrTxt.setAttribute('font-size', '11');
    yrTxt.setAttribute('font-weight', isCurrentYr ? '700' : '400');
    yrTxt.setAttribute('fill', isCurrentYr ? 'var(--text)' : 'var(--text-muted)');
    yrTxt.textContent = d.year;
    svg.appendChild(yrTxt);

    // Nights label
    const nTxt2 = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    nTxt2.setAttribute('x', cx); nTxt2.setAttribute('y', PAD.t + chartH + 26);
    nTxt2.setAttribute('text-anchor', 'middle'); nTxt2.setAttribute('font-size', '9');
    nTxt2.setAttribute('fill', 'var(--text-muted)');
    nTxt2.textContent = `${d.nights}/${d.total}n`;
    svg.appendChild(nTxt2);
  });

  wrap.appendChild(svg);

  // ── Insight strip ─────────────────────────────────────────────────────
  if (data.length >= 2) {
    const newest = data[data.length - 1];
    const prev   = data[data.length - 2];
    const adrDiff = newest.adr && prev.adr ? newest.adr - prev.adr : null;
    const occDiff = newest.occ - prev.occ;
    const insights = [];

    if (adrDiff !== null) {
      const dir = adrDiff > 0 ? '↑' : '↓';
      insights.push(`ADR ${dir} ${fmt(Math.abs(adrDiff))} vs ${prev.year} (${fmt(prev.adr)} → ${fmt(newest.adr)})`);
    }
    if (Math.abs(occDiff) > 0.02) {
      const dir = occDiff > 0 ? '↑' : '↓';
      insights.push(`Occupancy ${dir} ${Math.round(Math.abs(occDiff) * 100)}pp vs ${prev.year} (${pct(prev.occ)} → ${pct(newest.occ)})`);
    }
    // ADR elasticity hint
    if (adrDiff !== null && Math.abs(occDiff) > 0.03) {
      if (adrDiff > 0 && occDiff < 0)
        insights.push(`Higher ADR appears to correlate with lower occupancy — consider whether the revenue trade-off is worth it`);
      else if (adrDiff > 0 && occDiff > 0)
        insights.push(`Higher ADR with higher occupancy — pricing pressure may support a further increase`);
      else if (adrDiff < 0 && occDiff > 0)
        insights.push(`Lower ADR drove higher occupancy — the rate cut filled more nights`);
    }

    if (insights.length) {
      const strip = el('div', { style: 'font-size:12px;color:var(--text-muted);margin-top:4px;line-height:1.6' });
      for (const ins of insights) {
        strip.appendChild(el('div', {}, `· ${ins}`));
      }
      wrap.appendChild(strip);
    }
  }

  const curYrData = data.find(d => d.year === curYr);
  if (curYrData) {
    const isPartialMonth = String(month1).padStart(2, '0') === curMo;
    if (isPartialMonth)
      wrap.appendChild(el('div', { style: 'font-size:11px;color:var(--text-muted);margin-top:3px' },
        `* ${curYr} occupancy is partial — month not yet complete (${curYrData.nights} of ${curYrData.total} nights booked so far)`));
  }

  return wrap;
}

// Revenue vs ADR bar chart — shows total monthly revenue per year with ADR annotated
// so the user can directly see whether raising or lowering the rate moved revenue.
function renderRevenueADRChart(data, month1, ccy) {
  const wrap = el('div', { style: 'margin-bottom:14px' });
  const active = data.filter(d => d.revenue);
  if (!active.length) {
    wrap.appendChild(el('div', { style: 'font-size:12px;color:var(--text-muted)' }, 'No historical data yet.'));
    return wrap;
  }

  const fmt    = v => formatMoney(v, ccy, { maxFrac: 0 });
  const today  = todayStr();
  const curYr  = today.slice(0, 4);
  const curMo  = today.slice(5, 7);
  const mo1Str = String(month1).padStart(2, '0');

  const W = 560, H = 170;
  const PAD = { t: 54, b: 48, l: 32, r: 12 };
  const chartH = H - PAD.t - PAD.b;
  const ns  = 'http://www.w3.org/2000/svg';
  const maxRev = Math.max(...active.map(d => d.revenue), 1);
  const n   = data.length;
  const colW = (W - PAD.l - PAD.r) / Math.max(n, 1);

  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('style', 'width:100%;max-width:560px;display:block');

  // Grid at 50% and 100% revenue
  for (const frac of [0.5, 1.0]) {
    const y = PAD.t + chartH * (1 - frac);
    const gl = document.createElementNS(ns, 'line');
    gl.setAttribute('x1', PAD.l); gl.setAttribute('x2', W - PAD.r);
    gl.setAttribute('y1', y);    gl.setAttribute('y2', y);
    gl.setAttribute('stroke', 'var(--border)'); gl.setAttribute('stroke-dasharray', '3,3');
    svg.appendChild(gl);
    if (frac === 1.0) {
      const lbl = document.createElementNS(ns, 'text');
      lbl.setAttribute('x', PAD.l - 2); lbl.setAttribute('y', y + 3);
      lbl.setAttribute('text-anchor', 'end'); lbl.setAttribute('font-size', '8');
      lbl.setAttribute('fill', 'var(--text-muted)');
      lbl.textContent = fmt(maxRev);
      svg.appendChild(lbl);
    }
  }

  data.forEach((d, i) => {
    if (!d.revenue) return;
    const isPartial = d.year === curYr && mo1Str === curMo;
    const isBest    = d.revenue === maxRev;
    const cx   = PAD.l + (i + 0.5) * colW;
    const barW = Math.min(colW * 0.55, 44);
    const barH = Math.max(chartH * (d.revenue / maxRev), 2);
    const barY = PAD.t + chartH - barH;
    const color = isBest ? '#10b981' : '#6366f1';

    const rect = document.createElementNS(ns, 'rect');
    rect.setAttribute('x', cx - barW / 2); rect.setAttribute('y', barY);
    rect.setAttribute('width', barW); rect.setAttribute('height', barH);
    rect.setAttribute('rx', '3'); rect.setAttribute('fill', color);
    rect.setAttribute('opacity', isPartial ? '0.5' : '1');
    svg.appendChild(rect);

    // Revenue above bar
    const revTxt = document.createElementNS(ns, 'text');
    revTxt.setAttribute('x', cx);
    revTxt.setAttribute('y', Math.max(barY - 18, PAD.t - 32));
    revTxt.setAttribute('text-anchor', 'middle'); revTxt.setAttribute('font-size', '10');
    revTxt.setAttribute('font-weight', '700');
    revTxt.setAttribute('fill', isBest ? '#10b981' : 'var(--text)');
    revTxt.textContent = fmt(d.revenue) + (isPartial ? '*' : '');
    svg.appendChild(revTxt);

    // ADR just above bar top (amber)
    const adrTxt = document.createElementNS(ns, 'text');
    adrTxt.setAttribute('x', cx);
    adrTxt.setAttribute('y', Math.max(barY - 4, PAD.t - 18));
    adrTxt.setAttribute('text-anchor', 'middle'); adrTxt.setAttribute('font-size', '9');
    adrTxt.setAttribute('fill', '#f59e0b');
    adrTxt.textContent = d.adr ? fmt(d.adr) : '';
    svg.appendChild(adrTxt);

    // Year below bar
    const yrTxt = document.createElementNS(ns, 'text');
    yrTxt.setAttribute('x', cx); yrTxt.setAttribute('y', PAD.t + chartH + 14);
    yrTxt.setAttribute('text-anchor', 'middle'); yrTxt.setAttribute('font-size', '10');
    yrTxt.setAttribute('font-weight', '600'); yrTxt.setAttribute('fill', 'var(--text)');
    yrTxt.textContent = d.year;
    svg.appendChild(yrTxt);

    // Nights booked
    const nTxt = document.createElementNS(ns, 'text');
    nTxt.setAttribute('x', cx); nTxt.setAttribute('y', PAD.t + chartH + 26);
    nTxt.setAttribute('text-anchor', 'middle'); nTxt.setAttribute('font-size', '9');
    nTxt.setAttribute('fill', 'var(--text-muted)');
    nTxt.textContent = isPartial ? `${d.nights}/${d.total}n` : `${d.nights}n`;
    svg.appendChild(nTxt);

    // Occupancy %
    const occTxt = document.createElementNS(ns, 'text');
    occTxt.setAttribute('x', cx); occTxt.setAttribute('y', PAD.t + chartH + 38);
    occTxt.setAttribute('text-anchor', 'middle'); occTxt.setAttribute('font-size', '9');
    occTxt.setAttribute('fill', 'var(--text-muted)');
    occTxt.textContent = `${Math.round(d.occ * 100)}%${isPartial ? '*' : ''}`;
    svg.appendChild(occTxt);
  });

  wrap.appendChild(svg);

  // Insight strip — YoY ADR → Revenue impact
  if (active.length >= 2) {
    const prev    = active[active.length - 2];
    const curr    = active[active.length - 1];
    const revDiff = curr.revenue - prev.revenue;
    const adrDiff = (curr.adr || 0) - (prev.adr || 0);
    const revPct  = prev.revenue ? Math.round(Math.abs(revDiff) / prev.revenue * 100) : null;
    const isPartialCurr = curr.year === curYr && mo1Str === curMo;
    const insights = [];
    const partTag = isPartialCurr ? ` (${curr.year} partial)` : '';

    insights.push(
      `${prev.year}→${curr.year}${partTag}: ADR ${adrDiff >= 0 ? '↑' : '↓'} ${fmt(Math.abs(adrDiff))} (${fmt(prev.adr)} → ${fmt(curr.adr)}) | Revenue ${revDiff >= 0 ? '↑' : '↓'} ${fmt(Math.abs(revDiff))}${revPct != null ? ` (${revPct}%)` : ''}`
    );
    if      (adrDiff > 0 && revDiff < 0) insights.push('Higher ADR reduced total revenue — the occupancy drop more than offset the rate increase');
    else if (adrDiff > 0 && revDiff > 0) insights.push('Higher ADR grew total revenue — demand held despite the rate increase');
    else if (adrDiff < 0 && revDiff > 0) insights.push('Lower ADR boosted revenue — more nights booked outweighed the rate reduction');
    else if (adrDiff < 0 && revDiff < 0) insights.push('Lower ADR did not recover revenue — occupancy lift was insufficient');

    const strip = el('div', { style: 'font-size:12px;color:var(--text-muted);margin-top:4px;line-height:1.6' });
    for (const ins of insights) strip.appendChild(el('div', {}, `· ${ins}`));
    wrap.appendChild(strip);
  }

  const partialEntry = active.find(d => d.year === curYr && mo1Str === curMo);
  if (partialEntry)
    wrap.appendChild(el('div', { style: 'font-size:10px;color:var(--text-muted);margin-top:3px' },
      `* ${curYr} revenue is partial — ${partialEntry.nights} of ${partialEntry.total} nights booked so far`));

  return wrap;
}

// Recommended ADR = average ADR for the same calendar month across all years.
function computeRecommendedADR(propertyId, month1) {
  const mo = String(month1).padStart(2, '0');
  const bookings = listActivePayments().filter(p =>
    p.propertyId === propertyId && p.stream === 'short_term_rental' &&
    p.status !== 'materialized' && checkInOf(p) && checkOutOf(p)
  );
  let sum = 0, n = 0;
  for (const p of bookings) {
    const adr = adrNightOf(p);
    if (adr == null || adr <= 0) continue;
    const ci = checkInOf(p), co = checkOutOf(p);
    for (let d = ci; d < co; d = addDays(d, 1)) {
      if (d.slice(5, 7) === mo) { sum += adr; n++; }
    }
  }
  return n > 0 ? Math.round(sum / n) : null;
}

function getConfirmedTarget(propertyId, month) {
  return (state.db.strRateTargets || []).find(t =>
    t.propertyId === propertyId && t.month === month && !t.deletedAt
  ) || null;
}

// ── iCal blocks (external reserved/blocked days) ─────────────────────────────
function calendarFor(propertyId) {
  return (state.db.strCalendars || []).find(c => c.propertyId === propertyId && !c.deletedAt) || null;
}

// Set of date strings covered by any imported block (DTEND is exclusive).
function blockedDateSet(propertyId) {
  const set = new Set();
  const cal = calendarFor(propertyId);
  if (!cal) return set;
  for (const b of cal.blocks || []) {
    if (!b.start || !b.end) continue;
    for (let cur = b.start; cur < b.end; cur = addDays(cur, 1)) set.add(cur);
  }
  return set;
}

// ── Daily-rate feed export (consumed read-only by the Short-Term-Rentals repo) ─
// Publishes one JSON file per short-term property mapping each upcoming date to
// the rate amount to push into a channel/iCal. The external repo only needs the
// `amount` per `date`; `status`/`basis` are extra context it can ignore.
const FEED_DIR = 'exports/daily-rates';
const FEED_HORIZON_DAYS = 365;

// UTF-8 safe base64 (GitHub Contents API expects base64-encoded content).
function toB64(str) { return btoa(unescape(encodeURIComponent(str))); }

// Build the per-property rate feed: actual rate on booked nights, suggested rate
// on open/blocked nights, for the next FEED_HORIZON_DAYS days from today.
// Each night carries the NIGHTLY price only:
//   amount      — net nightly rate (what the host earns)
//   guestAmount — guest-facing nightly price, guest fee + tax included
// The cleaning fee is charged ONCE PER BOOKING — see feed-level `cleaningFee` /
// `cleaningGuestTotal`, which the consumer adds once per stay.
function buildRatesFeed(propertyId, horizonDays = FEED_HORIZON_DAYS) {
  const prop    = byId('properties', propertyId);
  const ccy     = prop?.currency || 'EUR';
  const histMap = historicNightMap(propertyId);
  const suggest = buildSuggester(histMap);
  const blocked = blockedDateSet(propertyId);

  // Guest service fee + tax used to gross the net rate up to the full guest price.
  const af      = state.db.settings?.airbnb || {};
  const feePct  = af.guestFeePct != null ? af.guestFeePct : AIRBNB_GUEST_FEE_PCT;
  const taxPct  = af.taxPct      != null ? af.taxPct      : AIRBNB_TAX_PCT;
  const cleanFee = af.cleaningFee != null ? af.cleaningFee : AIRBNB_CLEANING_FEE;
  const guestMult = 1 + (feePct + taxPct) / 100;

  const rates = [];
  let date = todayStr();
  for (let i = 0; i < horizonDays; i++) {
    const hist = histMap.get(date);
    let amount = null, basis = null, status;
    if (hist) {
      amount = hist.rate; basis = 'historic actual'; status = 'booked';
    } else {
      const mo = date.slice(0, 7);
      const target = getConfirmedTarget(propertyId, mo);
      if (target) { amount = target.targetADR; basis = 'confirmed target'; }
      else { const s = suggest(date); if (s) { amount = s.rate; basis = s.basis; } }
      status = blocked.has(date) ? 'blocked' : 'open';
    }
    if (amount != null) {
      rates.push({
        date,
        amount: Math.round(amount),                  // net nightly rate (host earns)
        guestAmount: Math.round(amount * guestMult), // guest nightly price, fees included (no cleaning)
        currency: ccy,
        status,
        basis
      });
    }
    date = addDays(date, 1);
  }

  return {
    schema: 'str-daily-rates/v1',
    generatedAt: new Date().toISOString(),
    property: { id: prop?.id || propertyId, name: prop?.name || '', currency: ccy, airbnbCalUrl: prop?.airbnbCalUrl || '' },
    guestFeePct: feePct,
    taxPct,
    cleaningFee: Math.round(cleanFee),                       // flat cleaning fee, charged once per booking
    cleaningGuestTotal: Math.round(cleanFee),                // flat fee the guest pays for cleaning (no fee/tax added)
    horizonDays,
    rates
  };
}

// Content signature of a feed (ignores generatedAt so unchanged data is a no-op).
function feedSig(feed) { return JSON.stringify({ p: feed.property, r: feed.rates }); }

// Cache of the last-published signature per property, so auto-publish only
// uploads feeds whose rates actually changed. In-memory only (resets on reload,
// in which case the next publish simply re-uploads everything once).
const _lastFeedSig = new Map();
let _lastManifestSig = '';
let _publishing = false;

const feedBase = () => {
  const { owner, repo, branch } = state.github;
  return `https://raw.githubusercontent.com/${owner}/${repo}/${branch || 'main'}/${FEED_DIR}`;
};

// Publish a feed file per STR property plus an index manifest. Always uploads
// every property (used by the manual button). Returns the public base URL + manifest.
async function publishRatesFeeds() {
  const stProps = listActive('properties').filter(p => p.type === 'short_term');
  if (!stProps.length) throw new Error('No short-term properties to export');

  const manifest = { schema: 'str-daily-rates-index/v1', generatedAt: new Date().toISOString(), properties: [] };
  for (const p of stProps) {
    const feed = buildRatesFeed(p.id);
    const file = `${p.id}.json`;
    await uploadGithubFile(`${FEED_DIR}/${file}`, toB64(JSON.stringify(feed, null, 2)), `Publish daily-rate feed: ${p.name}`);
    _lastFeedSig.set(p.id, feedSig(feed));
    manifest.properties.push({ id: p.id, name: p.name, currency: p.currency || 'EUR', file, nights: feed.rates.length });
  }
  await uploadGithubFile(`${FEED_DIR}/index.json`, toB64(JSON.stringify(manifest, null, 2)), 'Publish daily-rate feed index');
  _lastManifestSig = JSON.stringify(manifest.properties);

  return { base: feedBase(), manifest };
}

// Auto-publish hook (called after a successful data sync). Incremental: only
// uploads property feeds whose content changed, and only rewrites the index when
// a feed changed or the property set changed. Silent and best-effort.
export async function autoPublishRatesFeeds() {
  if (_publishing) return;
  const { owner, repo, token } = state.github;
  if (!owner || !repo || !token) return;
  const stProps = listActive('properties').filter(p => p.type === 'short_term');
  if (!stProps.length) return;

  _publishing = true;
  try {
    const manifestProps = [];
    let changed = false;
    for (const p of stProps) {
      const feed = buildRatesFeed(p.id);
      manifestProps.push({ id: p.id, name: p.name, currency: p.currency || 'EUR', file: `${p.id}.json`, nights: feed.rates.length });
      const sig = feedSig(feed);
      if (_lastFeedSig.get(p.id) === sig) continue; // unchanged → skip upload
      await uploadGithubFile(`${FEED_DIR}/${p.id}.json`, toB64(JSON.stringify(feed, null, 2)), `Update daily-rate feed: ${p.name}`);
      _lastFeedSig.set(p.id, sig);
      changed = true;
    }
    const manifestSig = JSON.stringify(manifestProps);
    if (changed || manifestSig !== _lastManifestSig) {
      const manifest = { schema: 'str-daily-rates-index/v1', generatedAt: new Date().toISOString(), properties: manifestProps };
      await uploadGithubFile(`${FEED_DIR}/index.json`, toB64(JSON.stringify(manifest, null, 2)), 'Update daily-rate feed index');
      _lastManifestSig = manifestSig;
    }
  } catch (e) {
    console.warn('Auto-publish daily-rate feeds failed:', e);
  } finally {
    _publishing = false;
  }
}

// Show the public URLs after publishing so they can be wired into the other repo.
function showFeedUrls({ base, manifest }) {
  const body = el('div', {});
  body.appendChild(el('div', { style: 'font-size:13px;color:var(--text-muted);margin-bottom:10px' },
    'Daily-rate feeds published. The Short-Term-Rentals repo can read these read-only over HTTPS (the repo must be public for raw URLs to work without a token).'));

  const urlRow = (label, url) => {
    const inp = input({ value: url });
    inp.readOnly = true;
    inp.onclick = () => { inp.select(); };
    return formRow(label, inp);
  };

  body.appendChild(urlRow('Index (start here)', `${base}/index.json`));
  for (const p of manifest.properties) {
    body.appendChild(urlRow(`${p.name} (${p.nights} nights)`, `${base}/${p.file}`));
  }
  openModal({ title: 'Daily-Rate Feed URLs', body, footer: [button('Close', { onClick: closeModal })] });
}

// ── Main view ─────────────────────────────────────────────────────────────────
function build() {
  const wrap = el('div', { class: 'view active' });

  const stProps = listActive('properties').filter(p => p.type === 'short_term');
  if (stProps.length === 0) {
    wrap.appendChild(el('div', { class: 'empty' }, 'No short-term rental properties configured. Add a short-term property first.'));
    return wrap;
  }

  if (!_propId || !stProps.some(p => p.id === _propId)) _propId = stProps[0].id;
  if (!_anchor) _anchor = thisMonth();

  // ── Controls bar ──
  const bar = el('div', { class: 'flex gap-8 mb-16', style: 'align-items:center;flex-wrap:wrap' });
  const propSel = select(stProps.map(p => ({ value: p.id, label: p.name })), _propId);
  propSel.style.maxWidth = '240px';
  propSel.onchange = () => { _propId = propSel.value; rerender(); };

  const prevBtn  = button('‹', { variant: 'sm ghost' });
  const nextBtn  = button('›', { variant: 'sm ghost' });
  const monthLbl = el('strong', { style: 'min-width:150px;text-align:center;font-size:15px' });
  prevBtn.onclick = () => { _anchor = shiftMonth(_anchor, -1); rerender(); };
  nextBtn.onclick = () => { _anchor = shiftMonth(_anchor, +1); rerender(); };
  const todayBtn = button('Today', { variant: 'sm ghost', onClick: () => { _anchor = thisMonth(); rerender(); } });

  bar.appendChild(el('span', { style: 'font-size:13px;color:var(--text-muted)' }, 'Property:'));
  bar.appendChild(propSel);
  bar.appendChild(el('div', { style: 'width:8px' }));
  bar.appendChild(prevBtn);
  bar.appendChild(monthLbl);
  bar.appendChild(nextBtn);
  bar.appendChild(todayBtn);
  bar.appendChild(el('div', { class: 'flex-1' }));
  const publishBtn = button('Publish Rates Feed', { onClick: async () => {
    const ok = await confirmDialog(
      `Publish daily-rate feeds for all short-term properties to GitHub (under ${FEED_DIR}/)? These JSON files are read by the Short-Term-Rentals repo.`,
      { okLabel: 'Publish' }
    );
    if (!ok) return;
    const orig = publishBtn.textContent;
    publishBtn.disabled = true; publishBtn.textContent = 'Publishing…';
    try {
      const res = await publishRatesFeeds();
      toast(`Published ${res.manifest.properties.length} rate feed(s)`, 'success');
      showFeedUrls(res);
    } catch (e) {
      toast(`Publish failed: ${e.message}`, 'danger', 6000);
    } finally {
      publishBtn.disabled = false; publishBtn.textContent = orig;
    }
  }});
  bar.appendChild(publishBtn);
  wrap.appendChild(bar);

  const kpiRow     = el('div', { style: 'display:grid;grid-template-columns:repeat(5,1fr);gap:12px;margin-bottom:16px' });
  const calCard    = el('div', { class: 'card' });
  const analysisEl = el('div', {});
  wrap.appendChild(kpiRow);
  wrap.appendChild(calCard);
  wrap.appendChild(analysisEl);

  function rerender() {
    propSel.value = _propId;
    const prop = byId('properties', _propId);
    const ccy  = prop?.currency || 'EUR';
    const [yStr, mStr] = _anchor.split('-');
    const year = Number(yStr), month1 = Number(mStr);
    monthLbl.textContent = `${MONTHS[month1 - 1]} ${year}`;

    const histMap = historicNightMap(_propId);
    const suggest = buildSuggester(histMap);
    const blocked = blockedDateSet(_propId);

    // Auto-refresh iCal whenever URL is known but record is missing or stale (>4 h).
    // Silently re-fetches and calls rerender() on success so blocks update automatically.
    autoRefreshICal(_propId, rerender);

    const rates = [...histMap.values()].map(v => v.rate);
    const minR = rates.length ? Math.min(...rates) : 0;
    const maxR = rates.length ? Math.max(...rates) : 0;

    renderKpis(kpiRow, { histMap, suggest, blocked, year, month1, ccy, propertyId: _propId });
    renderCalendar(calCard, { histMap, suggest, blocked, year, month1, ccy, minR, maxR, onAutoRefresh: rerender });
    renderAnalysis(analysisEl, { propertyId: _propId, year, month1, ccy, onRerender: rerender });
  }

  rerender();
  return wrap;
}

function shiftMonth(anchor, delta) {
  let [y, m] = anchor.split('-').map(Number);
  m += delta;
  while (m < 1)  { m += 12; y--; }
  while (m > 12) { m -= 12; y++; }
  return `${y}-${String(m).padStart(2, '0')}`;
}

// ── KPI cards ─────────────────────────────────────────────────────────────────
function renderKpis(row, { histMap, suggest, blocked, year, month1, ccy, propertyId }) {
  row.innerHTML = '';
  const mo = String(month1).padStart(2, '0');
  const dim = daysInMonth(year, month1);

  // Net nightly rate (excl. cleaning) + ADR (incl. cleaning) for this month, all years.
  const monthEntries = [...histMap].filter(([d]) => d.slice(5, 7) === mo);
  const netRates = monthEntries.map(([, v]) => v.rate);
  const adrRates = monthEntries.map(([, v]) => v.adr);
  const avgNet = netRates.length ? netRates.reduce((s, r) => s + r, 0) / netRates.length : null;
  const avgADR = adrRates.length ? adrRates.reduce((s, r) => s + r, 0) / adrRates.length : null;

  // Confirmed target for this month
  const anchor = `${year}-${mo}`;
  const confirmed = propertyId ? getConfirmedTarget(propertyId, anchor) : null;

  // Booked vs open nights within the displayed month.
  let booked = 0, suggSum = 0, suggN = 0;
  for (let d = 1; d <= dim; d++) {
    const date = `${year}-${mo}-${String(d).padStart(2, '0')}`;
    const isBooked = histMap.has(date) || blocked.has(date);
    if (isBooked) { booked++; continue; }
    const s = suggest(date);
    if (s) { suggSum += s.rate; suggN++; }
  }
  const avgSugg = suggN ? suggSum / suggN : null;
  const occ = Math.round((booked / dim) * 100);

  const card = (label, value, sub, variant) => el('div', { class: `kpi${variant ? ' ' + variant : ''}` },
    el('div', { class: 'kpi-label' }, label),
    el('div', { class: 'kpi-value num' }, value),
    sub ? el('div', { class: 'fx-hint' }, sub) : null
  );

  row.appendChild(card('ADR', avgADR != null ? formatMoney(avgADR, ccy, { maxFrac: 0 }) : '—', `incl. cleaning · ${MONTHS[month1 - 1]}, all years`));
  row.appendChild(card('Net Nightly Rate', avgNet != null ? formatMoney(avgNet, ccy, { maxFrac: 0 }) : '—', `excl. cleaning · ${netRates.length} night(s)`));
  row.appendChild(card('Confirmed Target', confirmed ? formatMoney(confirmed.targetADR, ccy, { maxFrac: 0 }) : '—', confirmed ? `set ${fmtDate(confirmed.confirmedAt)}` : 'not set', confirmed ? 'success' : ''));
  row.appendChild(card('Booked Nights', String(booked), `of ${dim} · ${occ}% occupancy`, occ >= 70 ? 'success' : ''));
  row.appendChild(card('Open Nights', String(dim - booked), 'awaiting bookings', (dim - booked) > 0 ? 'warning' : ''));
}

// ── Calendar grid ───────────────────────────────────────────────────────────
function renderCalendar(card, { histMap, suggest, blocked, year, month1, ccy, minR, maxR, onAutoRefresh }) {
  card.innerHTML = '';
  const mo  = String(month1).padStart(2, '0');
  const dim = daysInMonth(year, month1);
  const first = parseYMD(`${year}-${mo}-01`);
  const lead  = (first.getUTCDay() + 6) % 7; // Monday-first offset
  const tStr  = todayStr();

  const body = el('div', { style: 'padding:16px' });

  // Weekday header
  const head = el('div', { style: 'display:grid;grid-template-columns:repeat(7,1fr);gap:6px;margin-bottom:6px' });
  for (const w of WEEKDAYS) head.appendChild(el('div', { style: 'font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted);text-align:center' }, w));
  body.appendChild(head);

  const grid = el('div', { style: 'display:grid;grid-template-columns:repeat(7,1fr);gap:6px' });
  for (let i = 0; i < lead; i++) grid.appendChild(el('div', {}));

  for (let d = 1; d <= dim; d++) {
    const date = `${year}-${mo}-${String(d).padStart(2, '0')}`;
    const hist = histMap.get(date);
    const isBlocked = blocked.has(date);
    const isToday = date === tStr;

    let bg = 'transparent', border = '1px solid var(--border)', rateEl, badge = '';

    if (hist) {
      // Historic actual night — colour graded by price within the property's range.
      const t = maxR > minR ? (hist.rate - minR) / (maxR - minR) : 0.5;
      bg = `rgba(16,185,129,${(0.10 + 0.22 * t).toFixed(3)})`;
      border = '1px solid rgba(16,185,129,0.45)';
      rateEl = el('div', { style: 'font-size:13px;font-weight:700;color:var(--text)' }, formatMoney(hist.rate, hist.currency, { maxFrac: 0 }));
      badge = 'booked';
    } else if (isBlocked) {
      bg = 'rgba(239,68,68,0.15)';
      border = '1px solid rgba(239,68,68,0.55)';
      const s = suggest(date);
      rateEl = el('div', { style: 'font-size:12px;font-style:italic;color:var(--text-muted)' }, s ? formatMoney(s.rate, ccy, { maxFrac: 0 }) : '—');
      badge = 'blocked';
    } else {
      const s = suggest(date);
      rateEl = el('div', { style: 'font-size:12px;font-style:italic;color:var(--text-muted)' }, s ? formatMoney(s.rate, ccy, { maxFrac: 0 }) : '—');
      badge = s ? (s.confidence || 'sugg') : '';
    }

    const cell = el('div', {
      style: `position:relative;min-height:66px;padding:6px;border-radius:6px;border:${border};background:${bg};cursor:pointer;` +
             (isToday ? 'box-shadow:0 0 0 2px var(--accent,#6366f1) inset;' : '')
    });
    const badgeColor = badge === 'booked' ? '#10b981' : badge === 'blocked' ? '#ef4444' : badge === 'low' ? '#f59e0b' : 'var(--text-muted)';
    const badgeText  = badge === 'booked' ? 'booked' : badge === 'blocked' ? 'blocked' : badge === 'low' ? '?' : badge === 'medium' ? '~' : badge === 'high' ? 'sugg' : badge ? 'sugg' : '';
    cell.appendChild(el('div', { style: 'display:flex;justify-content:space-between;align-items:center' },
      el('span', { style: 'font-size:12px;font-weight:600;color:var(--text-muted)' }, String(d)),
      badgeText ? el('span', { style: `font-size:8px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:${badgeColor}` }, badgeText) : null
    ));
    cell.appendChild(el('div', { style: 'margin-top:8px;text-align:center' }, rateEl));
    cell.onclick = () => openDayDetail(date, { hist, isBlocked, suggest, ccy });
    grid.appendChild(cell);
  }

  body.appendChild(grid);

  // Legend
  const legend = el('div', { class: 'flex gap-8', style: 'flex-wrap:wrap;margin-top:14px;font-size:11px;color:var(--text-muted)' });
  const chip = (color, label) => el('span', { class: 'flex gap-4', style: 'align-items:center' },
    el('span', { style: `width:11px;height:11px;border-radius:3px;background:${color};display:inline-block` }),
    el('span', {}, label)
  );
  legend.appendChild(chip('rgba(16,185,129,0.30)', 'Booked (actual rate)'));
  legend.appendChild(chip('rgba(239,68,68,0.20)', 'Blocked (iCal)'));
  legend.appendChild(chip('transparent', 'Open · sugg = high confidence · ~ = medium · ? = low'));
  body.appendChild(legend);

  const calInfo    = calendarFor(_propId);
  const refreshing = _icalRefreshing.has(_propId);
  if (calInfo?.importedAt) {
    const infoWrap = el('div', { style: 'margin-top:8px;font-size:11px;color:var(--text-muted);display:flex;align-items:center;gap:8px;flex-wrap:wrap' });
    infoWrap.appendChild(el('span', {}, `Calendar imported ${fmtDate(calInfo.importedAt)} · ${(calInfo.blocks || []).length} reserved period(s).`));
    const refreshLnk = el('span', { style: `color:var(--accent,#6366f1);cursor:${refreshing ? 'default' : 'pointer'};text-decoration:underline` },
      refreshing ? 'refreshing…' : 'Refresh');
    if (!refreshing) refreshLnk.onclick = () => autoRefreshICal(_propId, onAutoRefresh, { force: true });
    infoWrap.appendChild(refreshLnk);
    body.appendChild(infoWrap);
  } else if (refreshing) {
    body.appendChild(el('div', { style: 'margin-top:8px;font-size:11px;color:var(--text-muted)' },
      'Fetching Airbnb calendar…'));
  } else {
    body.appendChild(el('div', {
      style: 'margin-top:10px;padding:8px 12px;border-radius:6px;background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.25);font-size:12px;display:flex;align-items:center;gap:8px'
    },
      el('span', { style: 'color:#ef4444;font-size:14px' }, '⚠'),
      el('span', {}, 'No Airbnb iCal URL set for this property — upcoming reservations won\'t show as blocked. Add the iCal URL in '),
      el('strong', {}, 'Properties → Edit Property → Airbnb iCal URL'),
      el('span', {}, '.')
    ));
  }

  card.appendChild(body);
}

// ── Day detail modal ──────────────────────────────────────────────────────────
function openDayDetail(date, { hist, isBlocked, suggest, ccy }) {
  const body = el('div', {});
  const row = (label, value, muted) => {
    const v = el('strong', {}, value);
    if (muted) v.style.color = 'var(--text-muted)';
    return el('div', { class: 'flex justify-between', style: 'padding:6px 0;border-bottom:1px solid var(--border);font-size:13px' },
      el('span', { class: 'muted' }, label), v);
  };
  const section = txt => el('div', { style: 'font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--text-muted);margin:12px 0 4px' }, txt);
  const fmt = (v, c) => formatMoney(v, c || ccy, { maxFrac: 2 });

  body.appendChild(el('div', { style: 'font-size:15px;font-weight:600;margin-bottom:10px' }, fmtDate(date)));

  if (hist) {
    body.appendChild(row('Status', 'Booked'));
    if (hist.label) body.appendChild(row('Guest', hist.label));
    if (hist.code)  body.appendChild(row('Confirmation', hist.code));
    if (hist.checkIn) body.appendChild(row('Stay', `${fmtDate(hist.checkIn)} – ${fmtDate(hist.checkOut)} (${hist.nights} night${hist.nights !== 1 ? 's' : ''})`));

    body.appendChild(section('Nightly Rate Breakdown'));
    body.appendChild(row('ADR (incl. cleaning amortised)', fmt(hist.adr, hist.currency)));
    body.appendChild(row('Net nightly rate (excl. cleaning)', fmt(hist.rate, hist.currency)));
    const cleanPerNight = hist.adr - hist.rate;
    if (cleanPerNight > 0.01) body.appendChild(row('Cleaning per night (amortised)', fmt(cleanPerNight, hist.currency), true));

    if (hist.amount != null && hist.nights) {
      body.appendChild(section('Booking Totals'));
      body.appendChild(row('Total booking amount', fmt(hist.amount, hist.currency)));
      if (hist.cleaningFee != null) {
        body.appendChild(row('of which cleaning fee', fmt(hist.cleaningFee, hist.currency), true));
        body.appendChild(row('of which accommodation', fmt(hist.amount - hist.cleaningFee, hist.currency), true));
      }
      body.appendChild(section('Formulas'));
      body.appendChild(row('ADR', `${fmt(hist.amount, hist.currency)} ÷ ${hist.nights} nights = ${fmt(hist.adr, hist.currency)}`));
      if (hist.cleaningFee != null) {
        body.appendChild(row('Net rate', `(${fmt(hist.amount, hist.currency)} − ${fmt(hist.cleaningFee, hist.currency)}) ÷ ${hist.nights} = ${fmt(hist.rate, hist.currency)}`));
      }
    }
  } else {
    body.appendChild(row('Status', isBlocked ? 'Reserved / blocked (iCal)' : 'Open'));
    const s = suggest(date);
    if (s) {
      // ── Confidence badge ──
      const confColor = s.confidence === 'high' ? '#10b981' : s.confidence === 'medium' ? '#f59e0b' : '#ef4444';
      const confLabel = s.confidence === 'high' ? 'HIGH' : s.confidence === 'medium' ? 'MEDIUM' : 'LOW';
      const confRow = el('div', { style: 'display:flex;align-items:center;gap:8px;margin:8px 0' });
      confRow.appendChild(el('span', { style: `background:${confColor};color:#fff;font-size:10px;font-weight:700;padding:2px 7px;border-radius:10px;letter-spacing:.05em` }, confLabel));
      confRow.appendChild(el('span', { style: 'font-size:12px;color:var(--text-muted)' }, `effectiveN = ${s.effectiveN}`));
      body.appendChild(confRow);
      if (s.confidenceNote) {
        body.appendChild(el('div', { style: `font-size:12px;padding:5px 8px;border-radius:4px;border-left:3px solid ${confColor};background:var(--bg-alt,rgba(0,0,0,.04));margin-bottom:8px` }, s.confidenceNote));
      }

      // ── Why reasoning ──
      if (s.why) {
        body.appendChild(section('Why This Rate?'));
        body.appendChild(el('div', { style: 'font-size:12px;line-height:1.5;padding:3px 0 4px' }, s.why));
      }

      // ── Current-year cross-month context ──
      if (s.currentYearContext) {
        const ctx = s.currentYearContext;
        const yr = date.slice(0, 4);
        const ctxBox = el('div', { style: 'margin:4px 0 8px;font-size:12px;background:var(--bg-alt,rgba(0,0,0,.04));border-radius:4px;padding:7px 10px;border-left:3px solid #6366f1' });
        ctxBox.appendChild(el('div', { style: 'font-weight:600;margin-bottom:3px' }, `${yr} bookings (other months)`));
        ctxBox.appendChild(el('div', {}, `${ctx.nights} nights in ${ctx.months} — avg ADR ${fmt(ctx.avgADR)} · avg Net ${fmt(ctx.avgRate)}`));
        ctxBox.appendChild(el('div', { style: 'color:var(--text-muted);font-size:11px;margin-top:3px' },
          `These are your current-year ${yr} bookings, but from a different month. They are shown here for context — they do not directly feed the formula above. Once bookings arrive for this month in ${yr}, they will become the primary signal (${CURRENT_YEAR_WEIGHT}× weight).`
        ));
        body.appendChild(ctxBox);
      }

      // ── Method explanation ──
      body.appendChild(section('Suggestion Method'));
      body.appendChild(row('Basis', s.basis));
      if (s.fallbackReason) {
        body.appendChild(el('div', { style: 'font-size:11px;color:var(--text-muted);padding:3px 0 6px' }, `ℹ ${s.fallbackReason}`));
      }

      // ── Pool breakdown ──
      if (s.pools && s.pools.length) {
        body.appendChild(section(`Data Pools (${s.pools.length} source${s.pools.length !== 1 ? 's' : ''})`));
        const poolTable = el('div', { style: 'font-size:12px' });
        for (const pool of s.pools) {
          const poolAvgAdr = pool.adr ?? pool.entries.reduce((a, e) => a + e.adr, 0) / pool.entries.length;
          const poolAvgNet = pool.rate ?? pool.entries.reduce((a, e) => a + e.rate, 0) / pool.entries.length;
          const poolRow = el('div', { style: 'display:flex;justify-content:space-between;align-items:center;padding:4px 0;border-bottom:1px solid var(--border)' });
          const left = el('div', {});
          left.appendChild(el('div', { style: 'font-weight:600' }, pool.label));
          const wLabel = Number.isInteger(pool.weight) ? `${pool.weight}` : pool.weight.toFixed(2);
          left.appendChild(el('div', { style: 'color:var(--text-muted);font-size:11px' }, `${pool.entries.length} night${pool.entries.length !== 1 ? 's' : ''} · weight ${wLabel}×`));
          const right = el('div', { style: 'text-align:right' });
          right.appendChild(el('div', {}, `ADR ${fmt(poolAvgAdr)}`));
          right.appendChild(el('div', { style: 'color:var(--text-muted);font-size:11px' }, `Net ${fmt(poolAvgNet)}`));
          poolRow.appendChild(left); poolRow.appendChild(right);
          poolTable.appendChild(poolRow);
        }
        body.appendChild(poolTable);

        // Blended formula when multiple pools
        if (s.pools.length > 1) {
          const fmlaEl = el('div', { style: 'margin-top:6px;font-size:12px;background:var(--bg-alt,rgba(0,0,0,.04));border-radius:4px;padding:6px 8px' });
          const adrParts = s.pools.map(p => {
            const w = p.entries.length * p.weight;
            return `${fmt(p.adr)}×${w.toFixed(1)}`;
          }).join(' + ');
          const totalW = s.pools.reduce((a, p) => a + p.entries.length * p.weight, 0);
          fmlaEl.appendChild(el('div', {}, `ADR = (${adrParts}) ÷ ${totalW.toFixed(1)} = ${fmt(s.adr)}`));
          const netParts = s.pools.map(p => {
            const w = p.entries.length * p.weight;
            return `${fmt(p.rate)}×${w.toFixed(1)}`;
          }).join(' + ');
          fmlaEl.appendChild(el('div', { style: 'margin-top:2px' }, `Net = (${netParts}) ÷ ${totalW.toFixed(1)} = ${fmt(s.rate)}`));
          body.appendChild(fmlaEl);
        }
      }

      // ── Suggested rates ──
      body.appendChild(section('Suggested Rates'));
      body.appendChild(row('ADR (incl. cleaning amortised)', fmt(s.adr)));
      body.appendChild(row('Net nightly rate (excl. cleaning)', fmt(s.rate)));
      const cleanEst = s.adr - s.rate;
      if (cleanEst > 0.01) body.appendChild(row('Est. cleaning per night', fmt(cleanEst), true));

      if (s.sources && s.sources.length) {
        // De-duplicate nights → unique bookings keyed by checkIn|checkOut
        const bkMap = new Map();
        for (const src of s.sources) {
          const key = src.checkIn && src.checkOut ? `${src.checkIn}|${src.checkOut}` : src.date;
          if (!bkMap.has(key)) bkMap.set(key, {
            checkIn: src.checkIn, checkOut: src.checkOut,
            code: src.code, label: src.label,
            rateSum: 0, adrSum: 0, n: 0
          });
          const b = bkMap.get(key); b.rateSum += src.rate; b.adrSum += src.adr; b.n++;
        }
        const bks = [...bkMap.values()].sort((a, b) => (a.checkIn || '').localeCompare(b.checkIn || ''));

        body.appendChild(section(`Source bookings (${bks.length} booking${bks.length !== 1 ? 's' : ''} · ${s.sources.length} nights)`));
        for (const b of bks) {
          const avgNet = b.rateSum / b.n, avgAdr = b.adrSum / b.n;
          const dateRange = b.checkIn ? `${fmtDate(b.checkIn)} – ${fmtDate(b.checkOut)}` : '—';
          const guest = b.label || b.code || 'Guest';
          const bkRow = el('div', { style: 'padding:5px 0;border-bottom:1px solid var(--border);font-size:12px' });
          bkRow.appendChild(el('div', { style: 'display:flex;justify-content:space-between' },
            el('span', { style: 'font-weight:600' }, guest),
            el('span', { style: 'color:var(--text-muted)' }, `${b.n} night${b.n !== 1 ? 's' : ''}`)
          ));
          bkRow.appendChild(el('div', { style: 'color:var(--text-muted);font-size:11px;margin-top:1px' }, dateRange));
          bkRow.appendChild(el('div', { style: 'display:flex;gap:12px;margin-top:3px' },
            el('span', {}, `ADR ${fmt(avgAdr)}`),
            el('span', { style: 'color:var(--text-muted)' }, `Net ${fmt(avgNet)}`),
            Math.abs(avgAdr - avgNet) > 0.5 ? el('span', { style: 'color:var(--text-muted)' }, `Clean ${fmt(avgAdr - avgNet)}/night`) : null
          ));
          body.appendChild(bkRow);
        }

        // Weighted average formula (compact, up to 4 bookings)
        const totalN = s.sources.length;
        const avgNet = s.sources.reduce((s, r) => s + r.rate, 0) / totalN;
        const avgAdr = s.sources.reduce((s, r) => s + r.adr,  0) / totalN;
        const formulaEl = el('div', { style: 'margin-top:8px;font-size:12px;background:var(--bg-alt,rgba(0,0,0,.04));border-radius:4px;padding:6px 8px' });
        if (bks.length <= 4) {
          const adrParts = bks.map(b => `${fmt(b.adrSum / b.n)}×${b.n}`).join(' + ');
          const netParts = bks.map(b => `${fmt(b.rateSum / b.n)}×${b.n}`).join(' + ');
          formulaEl.appendChild(el('div', {}, `ADR = (${adrParts}) ÷ ${totalN} = ${fmt(avgAdr)}`));
          formulaEl.appendChild(el('div', { style: 'margin-top:2px' }, `Net = (${netParts}) ÷ ${totalN} = ${fmt(avgNet)}`));
        } else {
          formulaEl.appendChild(el('div', {}, `ADR avg: ${fmt(avgAdr)} over ${totalN} nights from ${bks.length} bookings`));
          formulaEl.appendChild(el('div', { style: 'margin-top:2px' }, `Net avg: ${fmt(avgNet)} over ${totalN} nights`));
        }
        body.appendChild(formulaEl);
      }
    } else {
      body.appendChild(el('div', { style: 'padding:8px 0;font-size:13px;color:var(--text-muted)' }, 'No historic data yet to suggest a rate.'));
    }
  }

  openModal({ title: 'Daily Rate Detail', body, footer: [button('Close', { onClick: closeModal })] });
}

// ── Airbnb iCal auto-refresh ──────────────────────────────────────────────────
// Silently re-fetches iCal whenever the URL is known but the strCalendars record
// is missing or older than 4 hours. Called on every rerender so the blocks are
// always current and the record self-heals after any sync overwrite.
async function autoRefreshICal(propertyId, onDone, { force = false } = {}) {
  if (_icalRefreshing.has(propertyId)) return;
  const prop     = byId('properties', propertyId);
  const existing = calendarFor(propertyId);
  const url      = existing?.url || prop?.airbnbCalUrl || '';
  if (!url) return;
  const freshMs  = 4 * 60 * 60 * 1000; // 4-hour cache window
  if (!force && existing && (Date.now() - (existing.updatedAt || 0)) < freshMs) return;

  _icalRefreshing.add(propertyId);
  try {
    const text   = await fetchICal(url);
    const events = parseICal(text);
    const blocks = events
      .filter(e => e.start && e.end)
      .map(e => ({ start: e.start, end: e.end, uid: e.uid || '', summary: e.summary || '' }));
    const rec = existing
      ? { ...existing, url, blocks, importedAt: todayStr() }
      : { id: newId('stc'), propertyId, url, blocks, importedAt: todayStr() };
    upsert('strCalendars', rec);
    onDone?.();
  } catch { /* silent — leave existing record intact */ }
  finally { _icalRefreshing.delete(propertyId); }
}


// ── ADR Analysis section ──────────────────────────────────────────────────────
function renderAnalysis(container, { propertyId, year, month1, ccy, onRerender }) {
  container.innerHTML = '';
  const anchor = `${year}-${String(month1).padStart(2, '0')}`;
  const monthStats   = buildMonthlyStats(propertyId, anchor, 12);
  const recommendedADR = computeRecommendedADR(propertyId, month1);
  const confirmed    = getConfirmedTarget(propertyId, anchor);
  const currentStats = monthStats.find(s => s.month === anchor) || { month: anchor, adr: null, netRate: null, nights: 0, days: daysInMonth(year, month1), occ: 0 };

  const card = el('div', { class: 'card', style: 'margin-top:16px' });
  const inner = el('div', { style: 'padding:16px' });
  card.appendChild(inner);

  inner.appendChild(el('div', { style: 'font-size:14px;font-weight:700;margin-bottom:14px' }, 'ADR Analysis'));

  const occData = buildOccupancyByYear(propertyId, month1);
  const chartsRow = el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:4px' });

  const occCol = el('div', {});
  occCol.appendChild(el('div', { style: 'font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted);margin-bottom:6px' }, `${MONTHS[month1 - 1]} — Occupancy & ADR by Year`));
  occCol.appendChild(renderOccupancyHistory(occData, month1, ccy, confirmed?.targetADR));

  const revCol = el('div', {});
  revCol.appendChild(el('div', { style: 'font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted);margin-bottom:6px' }, `${MONTHS[month1 - 1]} — Revenue & ADR by Year`));
  revCol.appendChild(renderRevenueADRChart(occData, month1, ccy));

  chartsRow.appendChild(occCol);
  chartsRow.appendChild(revCol);
  inner.appendChild(chartsRow);

  inner.appendChild(renderTrendChart(monthStats, anchor, confirmed, ccy));
  inner.appendChild(renderInsights({ monthStats, anchor, currentStats, recommendedADR, confirmed, ccy }));
  inner.appendChild(renderADRTargetForm({ propertyId, anchor, recommendedADR, confirmed, ccy, onRerender }));

  container.appendChild(card);
}

function renderTrendChart(monthStats, anchor, confirmed, ccy) {
  const wrap = el('div', { style: 'margin-bottom:16px' });
  const data = monthStats.slice(-12);
  const allVals = data.flatMap(s => [s.adr, s.netRate]).filter(Boolean);
  if (confirmed?.targetADR) allVals.push(confirmed.targetADR);
  const maxVal = allVals.length ? Math.max(...allVals) * 1.15 : 200;

  const W = 60, H = 80, cols = data.length;
  const svgW = W * cols;
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${svgW} ${H + 22}`);
  svg.style.cssText = 'width:100%;height:130px;display:block';
  svg.setAttribute('preserveAspectRatio', 'none');

  // Confirmed target dashed line
  if (confirmed?.targetADR) {
    const ty = H - (confirmed.targetADR / maxVal) * H;
    const line = document.createElementNS(svgNS, 'line');
    line.setAttribute('x1', '0'); line.setAttribute('y1', ty);
    line.setAttribute('x2', String(svgW)); line.setAttribute('y2', ty);
    line.setAttribute('stroke', '#ef4444'); line.setAttribute('stroke-width', '1');
    line.setAttribute('stroke-dasharray', '4 3'); line.setAttribute('opacity', '0.8');
    svg.appendChild(line);
    const ltxt = document.createElementNS(svgNS, 'text');
    ltxt.setAttribute('x', '2'); ltxt.setAttribute('y', String(ty - 2));
    ltxt.setAttribute('font-size', '6'); ltxt.setAttribute('fill', '#ef4444');
    ltxt.textContent = `Target ${formatMoney(confirmed.targetADR, ccy, { maxFrac: 0 })}`;
    svg.appendChild(ltxt);
  }

  const netPoints = [];
  data.forEach((s, i) => {
    const cx = i * W + W / 2;
    const isAnchor = s.month === anchor;

    if (s.adr != null) {
      const bh = (s.adr / maxVal) * H;
      const rect = document.createElementNS(svgNS, 'rect');
      rect.setAttribute('x', String(i * W + W * 0.15));
      rect.setAttribute('y', String(H - bh));
      rect.setAttribute('width', String(W * 0.7));
      rect.setAttribute('height', String(bh));
      rect.setAttribute('rx', '2');
      rect.setAttribute('fill', isAnchor ? '#6366f1' : '#10b981');
      rect.setAttribute('opacity', isAnchor ? '1' : '0.65');
      svg.appendChild(rect);

      const vtxt = document.createElementNS(svgNS, 'text');
      vtxt.setAttribute('x', String(cx)); vtxt.setAttribute('y', String(H - bh - 2));
      vtxt.setAttribute('text-anchor', 'middle'); vtxt.setAttribute('font-size', '5.5');
      vtxt.setAttribute('fill', 'currentColor');
      vtxt.textContent = formatMoney(s.adr, ccy, { maxFrac: 0 });
      svg.appendChild(vtxt);
    }

    if (s.netRate != null) {
      const ny = H - (s.netRate / maxVal) * H;
      netPoints.push(`${cx},${ny}`);
      const dot = document.createElementNS(svgNS, 'circle');
      dot.setAttribute('cx', String(cx)); dot.setAttribute('cy', String(ny)); dot.setAttribute('r', '2.5');
      dot.setAttribute('fill', '#f59e0b');
      svg.appendChild(dot);
    }

    const mo = MONTHS[Number(s.month.slice(5, 7)) - 1].slice(0, 3);
    const yr = s.month.slice(2, 4);
    const lbl = document.createElementNS(svgNS, 'text');
    lbl.setAttribute('x', String(cx)); lbl.setAttribute('y', String(H + 14));
    lbl.setAttribute('text-anchor', 'middle'); lbl.setAttribute('font-size', '6');
    lbl.setAttribute('fill', isAnchor ? '#6366f1' : 'currentColor');
    lbl.setAttribute('opacity', isAnchor ? '1' : '0.55');
    lbl.textContent = `${mo} ${yr}`;
    svg.appendChild(lbl);
  });

  if (netPoints.length > 1) {
    const polyline = document.createElementNS(svgNS, 'polyline');
    polyline.setAttribute('points', netPoints.join(' '));
    polyline.setAttribute('fill', 'none'); polyline.setAttribute('stroke', '#f59e0b');
    polyline.setAttribute('stroke-width', '1.5'); polyline.setAttribute('opacity', '0.7');
    svg.insertBefore(polyline, svg.firstChild);
  }

  wrap.appendChild(svg);

  const leg = el('div', { style: 'display:flex;gap:14px;font-size:11px;color:var(--text-muted);margin-top:4px' });
  const chip = (color, label, dashed) => {
    const icon = dashed
      ? el('span', { style: `width:14px;height:0;border-top:2px dashed ${color};display:inline-block;margin-bottom:2px` })
      : el('span', { style: `width:10px;height:10px;border-radius:2px;background:${color};display:inline-block` });
    return el('span', { style: 'display:flex;align-items:center;gap:4px' }, icon, el('span', {}, label));
  };
  leg.appendChild(chip('#10b981', 'ADR'));
  leg.appendChild(chip('#f59e0b', 'Net nightly rate'));
  if (confirmed?.targetADR) leg.appendChild(chip('#ef4444', 'Confirmed target', true));
  wrap.appendChild(leg);
  return wrap;
}

function renderInsights({ monthStats, anchor, currentStats, recommendedADR, confirmed, ccy }) {
  const insights = [];
  const fmt = v => formatMoney(v, ccy, { maxFrac: 0 });
  const mo1 = Number(anchor.slice(5, 7));
  const yr  = Number(anchor.slice(0, 4));

  // YoY ADR comparison
  const prevYearMo = `${yr - 1}-${String(mo1).padStart(2, '0')}`;
  const pyStats = monthStats.find(s => s.month === prevYearMo);
  if (currentStats.adr && pyStats?.adr) {
    const pct = Math.round(((currentStats.adr - pyStats.adr) / pyStats.adr) * 100);
    const dir = pct >= 0 ? '↑' : '↓';
    const color = pct >= 0 ? '#10b981' : '#ef4444';
    insights.push({ text: `ADR ${fmt(currentStats.adr)} is ${dir}${Math.abs(pct)}% vs ${MONTHS[mo1 - 1]} ${yr - 1} (${fmt(pyStats.adr)})`, color });
  }

  // Open night revenue opportunity
  if (currentStats.nights > 0 && recommendedADR) {
    const open = currentStats.days - currentStats.nights;
    if (open > 0) {
      const potential = open * recommendedADR;
      insights.push({ text: `${currentStats.nights} nights booked (${currentStats.occ}% occupancy) · ${open} open nights at recommended ${fmt(recommendedADR)} = ${fmt(potential)} potential revenue`, color: null });
    } else {
      insights.push({ text: `Month is fully booked (100% occupancy) — consider raising rates for next year`, color: '#10b981' });
    }
  }

  // 3-month ADR momentum
  const recent = monthStats.filter(s => s.adr != null).slice(-4);
  if (recent.length >= 3) {
    const first = recent[0].adr, last = recent[recent.length - 2].adr;
    const diff = last - first;
    if (Math.abs(diff) > 5) {
      const dir = diff > 0 ? 'upward' : 'downward';
      const color = diff > 0 ? '#10b981' : '#f59e0b';
      insights.push({ text: `ADR has been on a ${dir} trend over the last 3 months (${fmt(first)} → ${fmt(last)})`, color });
    }
  }

  // Upside vs recommendation
  if (currentStats.adr && recommendedADR && currentStats.adr < recommendedADR * 0.92) {
    const upside = recommendedADR - currentStats.adr;
    insights.push({ text: `Current ADR ${fmt(currentStats.adr)} is ${fmt(upside)} below the ${MONTHS[mo1 - 1]} historical average — pricing may be conservative`, color: '#f59e0b' });
  }

  // Confirmed target note
  if (confirmed) {
    const adj = confirmed.adjustmentPct ? ` (${confirmed.adjustmentPct > 0 ? '+' : ''}${confirmed.adjustmentPct}% adjustment)` : '';
    insights.push({ text: `Confirmed target for ${MONTHS[mo1 - 1]} ${yr}: ${fmt(confirmed.targetADR)}${adj} — will be used when publishing the rate feed`, color: '#6366f1' });
  } else if (recommendedADR) {
    insights.push({ text: `Recommended ADR: ${fmt(recommendedADR)} (${MONTHS[mo1 - 1]} historical avg, all years) — approve or override below`, color: '#6366f1' });
  }

  if (!insights.length) return el('div', {});

  const wrap = el('div', { style: 'margin-bottom:16px' });
  wrap.appendChild(el('div', { style: 'font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted);margin-bottom:8px' }, 'Insights'));
  for (const ins of insights) {
    const row = el('div', { style: 'display:flex;gap:8px;align-items:flex-start;font-size:13px;padding:5px 0;border-bottom:1px solid var(--border)' });
    row.appendChild(el('span', { style: `color:${ins.color || 'var(--accent,#6366f1)'};flex-shrink:0;font-weight:700` }, '•'));
    row.appendChild(el('span', {}, ins.text));
    wrap.appendChild(row);
  }
  return wrap;
}

function renderADRTargetForm({ propertyId, anchor, recommendedADR, confirmed, ccy, onRerender }) {
  const mo1 = Number(anchor.slice(5, 7));
  const yr  = Number(anchor.slice(0, 4));
  const monthName = `${MONTHS[mo1 - 1]} ${yr}`;
  const fmt = v => formatMoney(v, ccy, { maxFrac: 0 });

  const wrap = el('div', {});
  const hdr = el('div', { style: 'display:flex;align-items:center;justify-content:space-between;margin-bottom:10px' });
  hdr.appendChild(el('div', { style: 'font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted)' }, `ADR Target — ${monthName}`));
  if (confirmed) {
    const badge = el('span', { style: 'font-size:11px;font-weight:600;color:#10b981;background:rgba(16,185,129,.1);padding:2px 8px;border-radius:10px' },
      `✓ Confirmed ${fmt(confirmed.targetADR)}`);
    hdr.appendChild(badge);
  }
  wrap.appendChild(hdr);

  // Recommended row
  if (recommendedADR) {
    const recRow = el('div', { style: 'font-size:13px;margin-bottom:12px' });
    recRow.appendChild(el('span', { style: 'color:var(--text-muted)' }, 'Recommended: '));
    recRow.appendChild(el('strong', {}, fmt(recommendedADR)));
    recRow.appendChild(el('span', { style: 'font-size:11px;color:var(--text-muted);margin-left:6px' }, `(${MONTHS[mo1 - 1]} historical average, all years)`));
    wrap.appendChild(recRow);
  } else {
    wrap.appendChild(el('div', { style: 'font-size:13px;color:var(--text-muted);margin-bottom:12px' }, 'No historical data for this month yet. Enter a target ADR manually.'));
  }

  // Form row: % adjustment → calculated value → target input
  const formRow2 = el('div', { style: 'display:flex;align-items:flex-end;gap:10px;flex-wrap:wrap;margin-bottom:12px' });

  const adjWrap = el('div', {});
  adjWrap.appendChild(el('div', { style: 'font-size:11px;color:var(--text-muted);margin-bottom:4px' }, '% Adjustment'));
  const adjInp = input({ value: confirmed?.adjustmentPct != null ? String(confirmed.adjustmentPct) : '', placeholder: 'e.g. +10', style: 'width:80px' });
  adjWrap.appendChild(adjInp);

  const arrowEl = el('div', { style: 'font-size:18px;color:var(--text-muted);padding-bottom:6px;line-height:1' }, '→');
  const adjResult = el('div', { style: 'font-size:13px;font-weight:600;color:var(--text);padding-bottom:8px;min-width:55px' },
    confirmed?.adjustmentPct != null && recommendedADR ? fmt(Math.round(recommendedADR * (1 + confirmed.adjustmentPct / 100))) : ''
  );

  const targetWrap = el('div', {});
  targetWrap.appendChild(el('div', { style: 'font-size:11px;color:var(--text-muted);margin-bottom:4px' }, 'Target ADR'));
  const targetInp = input({
    value: confirmed ? String(confirmed.targetADR) : (recommendedADR ? String(recommendedADR) : ''),
    placeholder: 'e.g. 130',
    style: 'width:100px'
  });
  targetWrap.appendChild(targetInp);

  adjInp.oninput = () => {
    const base = recommendedADR || (confirmed?.targetADR) || 0;
    const pct = parseFloat(adjInp.value);
    if (!isNaN(pct) && base) {
      const result = Math.round(base * (1 + pct / 100));
      adjResult.textContent = fmt(result);
      targetInp.value = String(result);
    } else {
      adjResult.textContent = '';
    }
  };
  targetInp.oninput = () => { adjInp.value = ''; adjResult.textContent = ''; };

  formRow2.appendChild(adjWrap);
  formRow2.appendChild(arrowEl);
  formRow2.appendChild(adjResult);
  formRow2.appendChild(targetWrap);
  wrap.appendChild(formRow2);

  // Buttons
  const btnRow = el('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px' });

  const saveTarget = (targetADR) => {
    const adjPct = parseFloat(adjInp.value);
    const base   = confirmed ? { ...confirmed } : {};
    if (!base.id) base.id = newId('srt');
    Object.assign(base, {
      propertyId, month: anchor,
      recommendedADR: recommendedADR || null,
      adjustmentPct: !isNaN(adjPct) ? adjPct : 0,
      targetADR,
      confirmedAt: todayStr()
    });
    delete base.deletedAt;
    upsert('strRateTargets', base);
    toast(`ADR target set to ${fmt(targetADR)} for ${monthName}`, 'success');
    onRerender?.();
  };

  if (recommendedADR) {
    btnRow.appendChild(button('✓ Approve Recommendation', { variant: 'primary sm', onClick: () => saveTarget(recommendedADR) }));
  }
  btnRow.appendChild(button('Save Override', { variant: 'sm', onClick: () => {
    const v = parseFloat(targetInp.value);
    if (!v || v <= 0) { toast('Enter a valid target ADR', 'warning'); return; }
    saveTarget(Math.round(v));
  }}));
  if (recommendedADR) {
    btnRow.appendChild(button('Reset to Recommended', { variant: 'sm ghost', onClick: () => {
      adjInp.value = '';
      adjResult.textContent = '';
      targetInp.value = String(recommendedADR);
      targetInp.focus();
    }}));
  }
  if (confirmed) {
    btnRow.appendChild(button('Clear', { variant: 'sm ghost', onClick: () => {
      upsert('strRateTargets', { ...confirmed, deletedAt: todayStr() });
      toast('ADR target cleared', 'success');
      onRerender?.();
    }}));
  }
  wrap.appendChild(btnRow);

  // Status line
  if (confirmed) {
    const statusEl = el('div', { style: 'font-size:12px;color:var(--text-muted)' });
    statusEl.appendChild(el('span', { style: 'color:#10b981;font-weight:600' }, '✓ Confirmed '));
    statusEl.appendChild(el('strong', {}, fmt(confirmed.targetADR)));
    statusEl.appendChild(el('span', {}, ` · set on ${fmtDate(confirmed.confirmedAt)}`));
    if (confirmed.adjustmentPct) statusEl.appendChild(el('span', {}, ` · ${confirmed.adjustmentPct > 0 ? '+' : ''}${confirmed.adjustmentPct}% applied to recommendation`));
    wrap.appendChild(statusEl);
  }

  return wrap;
}
