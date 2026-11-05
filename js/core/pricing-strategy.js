// Pricing strategy for STR Daily Rates (docs/airbnb-fees.md → "Pricing strategy").
//
// The history-based suggestion (the Airbnb daily rate) is adjusted by a
// strategy before it's shown and published:
//   fill      Fill nights     — below the suggestion, plus a last-minute drop
//   balanced  Balanced        — the suggestion as it is
//   maximise  Maximise rate   — above the suggestion
//   auto      Auto            — picks one per property and month from booking
//                               pace: nights booked now vs at the same point
//                               last year, and how full the month usually gets
// Which applies: the month's own choice (per property) beats the property's,
// which beats the global one (Settings → Airbnb, Auto by default). A
// confirmed monthly target is an explicit price and is never adjusted.

export const STRATEGY_LABEL = { auto: 'Auto', fill: 'Fill nights', balanced: 'Balanced', maximise: 'Maximise rate' };
export const STRATEGIES = ['auto', 'fill', 'balanced', 'maximise'];
export const DEFAULTS = { strategy: 'auto', fillPct: 10, maximisePct: 10, capPct: 15, lmDays: 7, lmMode: 'measured', lmPct: 10 };
// Auto: each percentage point of occupancy ahead of / behind last year moves
// the price by this many %; months that usually sell out / stay half empty
// lean up / down by LEAN_PCT.
export const PACE_SENSITIVITY = 0.5;
export const LEAN_PCT = 3, FULL_MONTH_OCC = 85, SLOW_MONTH_OCC = 40;

const num = (v, d) => (v === '' || v == null || !Number.isFinite(Number(v)) ? d : Number(v));
const pick = v => (STRATEGIES.includes(v) ? v : null);

export function strategySettings(af = {}) {
  return {
    strategy: pick(af.pricingStrategy) || DEFAULTS.strategy,
    fillPct: num(af.fillPct, DEFAULTS.fillPct),
    maximisePct: num(af.maximisePct, DEFAULTS.maximisePct),
    capPct: num(af.autoCapPct, DEFAULTS.capPct),
    lmDays: num(af.lastMinuteDays, DEFAULTS.lmDays),
    lmMode: af.lastMinuteMode === 'fixed' ? 'fixed' : 'measured',
    lmPct: num(af.lastMinutePct, DEFAULTS.lmPct)
  };
}

// Month (per property) → property → global.
export function resolveStrategy(ss, prop, ym) {
  const m = prop?.monthStrategies?.[ym];
  if (m && pick(m.strategy)) return { strategy: m.strategy, pct: m.pct != null && m.pct !== '' ? Number(m.pct) : null, source: 'month' };
  if (pick(prop?.pricingStrategy)) return { strategy: prop.pricingStrategy, pct: null, source: 'property' };
  return { strategy: ss.strategy, pct: null, source: 'global' };
}

// Auto's adjustment (signed %) from booking pace. Occupancies are 0–100;
// lyOcc = booked by the same day last year, lyFinal = how full that month
// ended up. null when last year has nothing to compare with.
export function autoAdjustment({ curOcc, lyOcc, lyFinal }, capPct = DEFAULTS.capPct) {
  if (lyOcc == null || lyFinal == null) return null;
  const pace = PACE_SENSITIVITY * (curOcc - lyOcc);
  const lean = lyFinal >= FULL_MONTH_OCC ? LEAN_PCT : lyFinal <= SLOW_MONTH_OCC ? -LEAN_PCT : 0;
  const raw = Math.max(-capPct, Math.min(capPct, pace + lean));
  const pct = Math.sign(raw) * Math.round(Math.abs(raw)) + 0;   // symmetric rounding (−10.5 → −11); + 0 turns −0 into 0
  return { pct, as: pct >= 3 ? 'maximise' : pct <= -3 ? 'fill' : 'balanced', lean };
}

// The strategy's effect on one night: { factor, pct, as, lmPct, note }.
//   r       resolveStrategy result
//   pace    { curOcc, lyOcc, lyFinal } for the night's month (Auto)
//   daysAway  nights from today (0 = tonight)
//   measuredLmPct  your measured last-minute drop (% cheaper), or null
export function strategyEffect({ ss, r, pace, daysAway, measuredLmPct, monthName = '' }) {
  let pct = 0, as = r.strategy, note = '';
  if (r.strategy === 'fill') { pct = -(r.pct ?? ss.fillPct); note = `${STRATEGY_LABEL.fill} −${-pct}%`; }
  else if (r.strategy === 'maximise') { pct = r.pct ?? ss.maximisePct; note = `${STRATEGY_LABEL.maximise} +${pct}%`; }
  else if (r.strategy === 'auto') {
    const a = pace ? autoAdjustment(pace, ss.capPct) : null;
    if (!a) { as = 'balanced'; note = `Auto: Balanced (${pace?.reason || 'no booking history from last year to compare'})`; }
    else {
      pct = a.pct; as = a.as;
      const sign = pct > 0 ? `+${pct}%` : pct < 0 ? `−${-pct}%` : '±0%';
      note = `Auto: ${STRATEGY_LABEL[as]} ${sign} — ${monthName} ${Math.round(pace.curOcc)}% booked vs ${Math.round(pace.lyOcc)}% this time last year`
        + (a.lean > 0 ? ', usually sells out' : a.lean < 0 ? ', usually quiet' : '');
    }
  } else note = `${STRATEGY_LABEL.balanced}`;
  // Last-minute drop: Fill nights, and Auto unless it's pushing the price up.
  let lmPct = 0;
  if ((r.strategy === 'fill' || (r.strategy === 'auto' && as !== 'maximise')) && daysAway != null && daysAway >= 0 && daysAway < ss.lmDays) {
    lmPct = ss.lmMode === 'fixed' ? ss.lmPct : (measuredLmPct > 0 ? measuredLmPct : ss.lmPct);
    if (lmPct > 0) note += ` · ${daysAway === 0 ? 'tonight' : `${daysAway} day${daysAway !== 1 ? 's' : ''} away`}, last-minute −${lmPct}%`;
  }
  const factor = (1 + pct / 100) * (1 - lmPct / 100);
  return { factor, pct, as, lmPct, note };
}

export const SOURCE_LABEL = { month: 'set for this month', property: 'set for this property', global: 'global setting' };
