import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
const f = await import('../../js/core/airbnb-fees.js');
const fs = f.feeSettings({});
const near = (a, b, eps = 0.01) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

// Synthetic bookings (shapes as the Airbnb CSV import stores them): 4 nights,
// €60 cleaning. Old: listed at €235/night → gross 1000, 3.57% kept. New: the
// same guest price (235 × 1.14 ≈ 268/night) → gross 1132, 18.45% kept.
const oldBk = { source: 'airbnb', amount: 964.3, airbnbGrossEarnings: 1000, airbnbServiceFee: 35.7, airbnbCleaningFee: 60, airbnbBookingDate: '2026-09-01', airbnbCheckIn: '2026-12-01' };
const newBk = { source: 'airbnb', amount: 923.15, airbnbGrossEarnings: 1131.6, airbnbServiceFee: 208.45, airbnbCleaningFee: 60, airbnbBookingDate: '2026-10-20', airbnbCheckIn: '2026-12-01' };

test('defaults: host-only, 15.5% + 19% VAT = 18.45%; old fee 3.57%; weekend +10%; growth 0', () => {
  assert.deepEqual(fs, { hostOnly: true, hostFeeBasePct: 15.5, vatPct: 19, hostFeePct: 18.45, splitHostFeePct: 3.57, guestFeePct: 14, taxPct: 0, weekendUpliftPct: 10, cleaningStrategy: 'keep', growthPct: 0 });
  const g = f.feeSettings({ feeModel: 'split', hostFeeBasePct: '15', vatPct: 27, weekendUpliftPct: 0, growthPct: '5' });
  assert.equal(g.hostOnly, false); assert.equal(g.hostFeePct, 19.05); assert.equal(g.splitHostFeePct, 3.81);
  assert.equal(g.weekendUpliftPct, 0); assert.equal(g.growthPct, 5);
  assert.equal(f.feeSettings({ vatPct: '' }).vatPct, 19);
});

test('fee model per booking: measured fee wins, then booking date, then stay start', () => {
  assert.equal(f.bookingFeeModel(oldBk), 'split');
  assert.equal(f.bookingFeeModel(newBk), 'host_only');
  // a booking made before the switch for a stay after it keeps the old model
  assert.equal(f.bookingFeeModel({ source: 'airbnb', amount: 500, airbnbBookingDate: '2026-10-12', airbnbCheckIn: '2027-02-01' }), 'split');
  assert.equal(f.bookingFeeModel({ source: 'airbnb', amount: 500, airbnbBookingDate: '2026-10-13' }), 'host_only');
  assert.equal(f.bookingFeeModel({ source: 'airbnb', amount: 500, airbnbCheckIn: '2026-08-01' }), 'split');
  assert.equal(f.bookingFeeModel({ ...newBk, airbnbBookingDate: '' }), 'host_only');
  assert.equal(f.bookingFeeModel({ source: 'manual', amount: 500 }), null);
  assert.equal(f.bookingFeeRate({ source: 'manual', amount: 500 }), 0);
  near(f.bookingFeeRate({ source: 'airbnb', amount: 500, airbnbBookingDate: '2027-01-01' }), 0.1845);
  near(f.bookingFeeRate({ source: 'airbnb', amount: 500, airbnbBookingDate: '2026-01-01' }), 0.0357);
});

test('Airbnb daily rate: old bookings at what their guests paid, new as they are', () => {
  // cleaning fee kept (default): the old guest fee on cleaning moves into the nightly rate
  near(f.airbnbRatePerNight(oldBk, 4), (1000 * 1.14 - 60) / 4);        // 270
  // the case from the Airbnb app: €160 total, €40 cleaning, 3 nights, guest paid 19% on top (€190.53)
  const bk = { source: 'airbnb', amount: 154.29, airbnbGrossEarnings: 160, airbnbServiceFee: 5.71, airbnbCleaningFee: 40, airbnbBookingDate: '2026-03-21' };
  const g19 = f.feeSettings({ guestFeePct: 19 });
  near(f.airbnbRatePerNight(bk, 3, g19), (190.4 - 40) / 3);           // €50.13 → €50 a night with €40 cleaning
  near(50 * 3 + 40, 190.4, 0.5);                                       // guest pays the same total
  // cleaning fee raised by the guest fee too: it stays with cleaning
  const raise = f.feeSettings({ guestFeePct: 19, cleaningStrategy: 'raise' });
  near(f.airbnbRatePerNight(bk, 3, raise), 40 * 1.19);                // €47.60 (+ €47.60 cleaning)
  near(f.airbnbRatePerNight(oldBk, 4, f.feeSettings({ cleaningStrategy: 'raise' })), f.airbnbRatePerNight(newBk, 4), 0.1);
  near(f.airbnbRatePerNight(newBk, 4), (1131.6 - 60) / 4);            // host-only: as it is
  // no gross in the import → derived from the payout and the fee
  near(f.airbnbRatePerNight({ source: 'airbnb', amount: 816, airbnbCleaningFee: 0, airbnbBookingDate: '2026-11-01' }, 4), 816 / 0.8155 / 4);
  // direct bookings: their own nightly price
  near(f.airbnbRatePerNight({ source: 'manual', amount: 400, airbnbCleaningFee: 40 }, 4), 90);
  assert.equal(f.airbnbRatePerNight(oldBk, 0), null);
});

test('what you receive', () => {
  near(f.payoutPerNight(oldBk, 4), (964.3 - 60 * (1 - 0.0357)) / 4);
  near(f.payoutForRate(100, fs), 81.55);
  near(f.payoutForRate(100, f.feeSettings({ feeModel: 'split' })), 96.43);
});

test('Airbnb checkout and feed guestFeePct', () => {
  near(f.airbnbCheckoutFor(100, fs), 100);                      // host-only: the guest pays the rate
  near(f.airbnbCheckoutFor(100, { ...fs, taxPct: 5 }), 105);
  near(f.airbnbCheckoutFor(100, f.feeSettings({ feeModel: 'split' })), 114);
  assert.equal(f.feedGuestFeePct(fs), 0);
  assert.equal(f.feedGuestFeePct(f.feeSettings({ feeModel: 'split' })), 14);
  for (const s of [fs, { ...fs, taxPct: 5 }, f.feeSettings({ feeModel: 'split', taxPct: 3 })])
    near(80 * (1 + (f.feedGuestFeePct(s) + s.taxPct) / 100), f.airbnbCheckoutFor(80, s));
});

test('confirmed targets: old payout targets read as the Airbnb rate, new ones as saved', () => {
  near(f.targetBase({ targetADR: 100 }, fs), 100 * 1.14 / (1 - 0.0357));      // ≈ 118.2
  assert.equal(f.targetBase({ targetADR: 120, basis: 'airbnb_rate' }, fs), 120);
  assert.equal(f.targetBase(null, fs), null);
});

test('weekend uplift on Friday and Saturday nights only', () => {
  // 2027-01-01 is a Friday
  assert.deepEqual(['2026-12-31', '2027-01-01', '2027-01-02', '2027-01-03'].map(f.isWeekendNight), [false, true, true, false]);
  near(f.weekendFactor('2027-01-02', fs), 1.1);
  assert.equal(f.weekendFactor('2027-01-04', fs), 1);
  assert.equal(f.weekendFactor('2027-01-02', { ...fs, weekendUpliftPct: 0 }), 1);
});

test('lead time, last-minute and growth', () => {
  assert.equal(f.leadDays('2026-12-28', '2027-01-02'), 5);
  assert.equal(f.leadDays('', '2027-01-02'), null);
  assert.equal(f.isLastMinute(5), true); assert.equal(f.isLastMinute(7), false); assert.equal(f.isLastMinute(null), false);
  assert.equal(f.growthFactor(2, fs), 1);
  near(f.growthFactor(2, { ...fs, growthPct: 5 }), 1.1025);
  assert.equal(f.growthFactor(0, { ...fs, growthPct: 5 }), 1);
});

test('guest total: no guest fee on host-only bookings', () => {
  near(f.guestTotalOf(newBk, fs), 1131.6);
  near(f.guestTotalOf(oldBk, fs), 1140);
});
