import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
const ps = await import('../../js/core/pricing-strategy.js');
const ss = ps.strategySettings({});
const near = (a, b, eps = 0.001) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

test('defaults: Auto, fill −10%, maximise +10%, cap ±15%, last-minute 7 days measured (10% fallback)', () => {
  assert.deepEqual(ss, { strategy: 'auto', fillPct: 10, maximisePct: 10, capPct: 15, lmDays: 7, lmMode: 'measured', lmPct: 10 });
  assert.equal(ps.strategySettings({ pricingStrategy: 'bogus' }).strategy, 'auto');
  assert.equal(ps.strategySettings({ pricingStrategy: 'fill', fillPct: '12', lastMinuteMode: 'fixed' }).fillPct, 12);
});

test('month beats property beats global', () => {
  const prop = { pricingStrategy: 'maximise', monthStrategies: { '2027-08': { strategy: 'fill', pct: 12 } } };
  assert.deepEqual(ps.resolveStrategy(ss, prop, '2027-08'), { strategy: 'fill', pct: 12, source: 'month' });
  assert.deepEqual(ps.resolveStrategy(ss, prop, '2027-09'), { strategy: 'maximise', pct: null, source: 'property' });
  assert.deepEqual(ps.resolveStrategy(ss, {}, '2027-09'), { strategy: 'auto', pct: null, source: 'global' });
  assert.deepEqual(ps.resolveStrategy({ ...ss, strategy: 'balanced' }, { monthStrategies: { '2027-09': { strategy: '' } } }, '2027-09').source, 'global');
});

test('Auto: half a % per point of occupancy vs last year, leaning for full/quiet months, capped', () => {
  assert.deepEqual(ps.autoAdjustment({ curOcc: 52, lyOcc: 31, lyFinal: 70 }), { pct: 11, as: 'maximise', lean: 0 });     // +21 pts → +10.5
  assert.deepEqual(ps.autoAdjustment({ curOcc: 31, lyOcc: 52, lyFinal: 70 }), { pct: -11, as: 'fill', lean: 0 });
  assert.equal(ps.autoAdjustment({ curOcc: 50, lyOcc: 48, lyFinal: 90 }).pct, 4);                                         // +1 pace +3 sells out
  assert.equal(ps.autoAdjustment({ curOcc: 50, lyOcc: 48, lyFinal: 30 }).as, 'balanced');                                 // +1 −3 = −2
  assert.equal(ps.autoAdjustment({ curOcc: 100, lyOcc: 0, lyFinal: 90 }).pct, 15);                                        // capped
  assert.equal(ps.autoAdjustment({ curOcc: 0, lyOcc: 100, lyFinal: 90 }, 8).pct, -8);
  assert.equal(ps.autoAdjustment({ curOcc: 50, lyOcc: null, lyFinal: null }), null);
});

test('effect on a night: fill / maximise / balanced, with the last-minute drop where it applies', () => {
  const R = (strategy, pct = null) => ({ strategy, pct, source: 'global' });
  let e = ps.strategyEffect({ ss, r: R('fill'), daysAway: 30 });
  near(e.factor, 0.9); assert.equal(e.note, 'Fill nights −10%');
  e = ps.strategyEffect({ ss, r: R('fill', 12), daysAway: 3, measuredLmPct: 8 });
  near(e.factor, 0.88 * 0.92); assert.match(e.note, /3 days away, last-minute −8%/);
  e = ps.strategyEffect({ ss, r: R('fill'), daysAway: 2, measuredLmPct: null });
  near(e.factor, 0.9 * 0.9);                                                  // nothing measured → fallback 10%
  e = ps.strategyEffect({ ss: { ...ss, lmMode: 'fixed', lmPct: 5 }, r: R('fill'), daysAway: 0, measuredLmPct: 20 });
  near(e.factor, 0.9 * 0.95); assert.match(e.note, /tonight, last-minute −5%/);
  e = ps.strategyEffect({ ss, r: R('maximise'), daysAway: 1, measuredLmPct: 8 });
  near(e.factor, 1.1); assert.equal(e.lmPct, 0);                              // no last-minute drop when maximising
  e = ps.strategyEffect({ ss, r: R('balanced'), daysAway: 1, measuredLmPct: 8 });
  near(e.factor, 1);
});

test('Auto on a night: pace decides; no history → Balanced; last-minute only when not raising', () => {
  const R = { strategy: 'auto', pct: null, source: 'global' };
  let e = ps.strategyEffect({ ss, r: R, pace: { curOcc: 31, lyOcc: 52, lyFinal: 70 }, daysAway: 40, monthName: 'July' });
  near(e.factor, 0.89); assert.equal(e.as, 'fill');
  assert.equal(e.note, 'Auto: Fill nights −11% — July 31% booked vs 52% this time last year');
  e = ps.strategyEffect({ ss, r: R, pace: { curOcc: 31, lyOcc: 52, lyFinal: 70 }, daysAway: 2, measuredLmPct: 8, monthName: 'July' });
  near(e.factor, 0.89 * 0.92);
  e = ps.strategyEffect({ ss, r: R, pace: { curOcc: 80, lyOcc: 40, lyFinal: 95 }, daysAway: 2, measuredLmPct: 8, monthName: 'July' });
  near(e.factor, 1.15); assert.equal(e.lmPct, 0);
  e = ps.strategyEffect({ ss, r: R, pace: { curOcc: 30, lyOcc: null, lyFinal: null }, daysAway: 40 });
  near(e.factor, 1); assert.match(e.note, /no booking history from last year/);
  e = ps.strategyEffect({ ss, r: R, pace: { curOcc: 0, lyOcc: null, lyFinal: null, reason: 'mostly closed this month' }, daysAway: 200 });
  near(e.factor, 1); assert.equal(e.note, 'Auto: Balanced (mostly closed this month)');
});

test('gap nights: a short open run with booked/closed nights on both sides', () => {
  const U = new Set(['2027-03-01', '2027-03-02', '2027-03-04', '2027-03-08', '2027-03-11']);
  assert.equal(ps.gapRunLength('2027-03-03', U, 2), 1);           // 1-night gap (2nd and 4th booked)
  assert.equal(ps.gapRunLength('2027-03-09', U, 2), 2);           // 9–10 between 8 and 11
  assert.equal(ps.gapRunLength('2027-03-10', U, 2), 2);
  assert.equal(ps.gapRunLength('2027-03-05', U, 2), 0);           // 5–7 is 3 nights > 2
  assert.equal(ps.gapRunLength('2027-03-05', U, 3), 3);
  assert.equal(ps.gapRunLength('2027-03-02', U, 2), 0);           // booked itself
  assert.equal(ps.gapRunLength('2027-03-12', U, 2), 0);           // open after the last booking
  assert.equal(ps.gapRunLength('2027-03-03', U, 0), 0);           // off
});

test('special dates: exact and every year, across New Year', () => {
  const list = [{ label: 'Christmas', from: '2026-12-24', to: '2026-12-26', pct: 20, yearly: true },
                { label: 'NYE', from: '2026-12-31', to: '2027-01-01', pct: 40, yearly: true },
                { label: 'Festival', from: '2027-06-10', to: '2027-06-12', pct: 30 }];
  assert.deepEqual(ps.specialDateFor('2027-12-25', list), { label: 'Christmas', pct: 20 });
  assert.deepEqual(ps.specialDateFor('2028-01-01', list), { label: 'NYE', pct: 40 });
  assert.deepEqual(ps.specialDateFor('2027-06-11', list), { label: 'Festival', pct: 30 });
  assert.equal(ps.specialDateFor('2028-06-11', list), null);       // not yearly
  assert.equal(ps.specialDateFor('2027-12-27', list), null);
  assert.equal(ps.specialDateFor('2027-12-25', [{ from: '2026-12-24', pct: 0, yearly: true }]), null);
});

test('price limits', () => {
  assert.deepEqual(ps.clampRate(30, 35, 90), { rate: 35, capped: 'min' });
  assert.deepEqual(ps.clampRate(120, 35, 90), { rate: 90, capped: 'max' });
  assert.deepEqual(ps.clampRate(60, 35, 90), { rate: 60, capped: null });
  assert.deepEqual(ps.clampRate(10, null, null), { rate: 10, capped: null });
});
