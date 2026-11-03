import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
const f = await import('../../js/core/airbnb-fees.js');
const fs = f.feeSettings({});
const near = (a, b, eps = 0.01) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

// Synthetic bookings (shapes as the Airbnb CSV import stores them).
const oldBk = { source: 'airbnb', amount: 964, airbnbGrossEarnings: 1000, airbnbServiceFee: 36, airbnbCleaningFee: 60, airbnbBookingDate: '2026-09-01', airbnbCheckIn: '2026-12-01' };
const newBk = { source: 'airbnb', amount: 816, airbnbGrossEarnings: 1000, airbnbServiceFee: 184, airbnbCleaningFee: 60, airbnbBookingDate: '2026-10-20', airbnbCheckIn: '2026-12-01' };

test('defaults: host-only model at 18.4%', () => {
  assert.deepEqual(fs, { hostOnly: true, hostFeePct: 18.4, guestFeePct: 14, taxPct: 0 });
  assert.equal(f.feeSettings({ feeModel: 'split', hostFeePct: '17', taxPct: 2 }).hostOnly, false);
  assert.equal(f.feeSettings({ hostFeePct: '' }).hostFeePct, 18.4);
});

test('fee model per booking: measured fee wins, then booking date, then stay start', () => {
  assert.equal(f.bookingFeeModel(oldBk), 'split');
  assert.equal(f.bookingFeeModel(newBk), 'host_only');
  // a booking made before the switch for a stay after it keeps the old model
  assert.equal(f.bookingFeeModel({ source: 'airbnb', amount: 500, airbnbBookingDate: '2026-10-12', airbnbCheckIn: '2027-02-01' }), 'split');
  assert.equal(f.bookingFeeModel({ source: 'airbnb', amount: 500, airbnbBookingDate: '2026-10-13' }), 'host_only');
  assert.equal(f.bookingFeeModel({ source: 'airbnb', amount: 500, airbnbCheckIn: '2026-08-01' }), 'split');
  // the fee itself beats a missing/odd date
  assert.equal(f.bookingFeeModel({ ...newBk, airbnbBookingDate: '' }), 'host_only');
  assert.equal(f.bookingFeeModel({ source: 'manual', amount: 500 }), null);
  assert.equal(f.bookingFeeRate({ source: 'manual', amount: 500 }), 0);
  near(f.bookingFeeRate(newBk), 0.184);
  near(f.bookingFeeRate({ source: 'airbnb', amount: 500, airbnbBookingDate: '2027-01-01' }), 0.184);
  near(f.bookingFeeRate({ source: 'airbnb', amount: 500, airbnbBookingDate: '2026-01-01' }), 0.036);
});

test('payout per night takes off only the cleaning that reached you', () => {
  // old: (964 − 60×0.964)/4 ; new: (816 − 60×0.816)/4
  near(f.payoutPerNight(oldBk, 4), (964 - 57.84) / 4);
  near(f.payoutPerNight(newBk, 4), (816 - 48.96) / 4);
  near(f.payoutPerNight({ source: 'manual', amount: 400, airbnbCleaningFee: 40 }, 4), 90);
  assert.equal(f.payoutPerNight(oldBk, 0), null);
});

test('same Airbnb price raised ~18% → same payout per night in both models', () => {
  const oldPrice = 100, newPrice = 100 * 0.964 / 0.816;           // ≈ 118.1
  near(newPrice / oldPrice - 1, 0.1814, 0.001);
  near(oldPrice * 0.964, newPrice * 0.816);
});

test('Set in Airbnb and checkout prices for a payout target', () => {
  near(f.airbnbPriceFor(100, fs), 100 / 0.816);                   // 122.55
  near(f.airbnbCheckoutFor(100, fs), 100 / 0.816);                 // no guest fee on top
  near(f.airbnbCheckoutFor(100, { ...fs, taxPct: 5 }), 100 / 0.816 * 1.05);
  const split = f.feeSettings({ feeModel: 'split' });
  near(f.airbnbPriceFor(100, split), 100 / 0.964);
  near(f.airbnbCheckoutFor(100, split), 100 / 0.964 * 1.14);
  assert.equal(f.airbnbPriceFor(null, fs), null);
});

test('feed guestFeePct keeps airbnbCheckout = amount × (1 + (guestFeePct + taxPct)/100)', () => {
  for (const s of [fs, { ...fs, taxPct: 5 }, f.feeSettings({ feeModel: 'split', taxPct: 3 })]) {
    const g = f.feedGuestFeePct(s);
    near(80 * (1 + (g + s.taxPct) / 100), f.airbnbCheckoutFor(80, s), 0.1);
  }
  assert.equal(f.feedGuestFeePct(fs), 22.5);
});

test('guest total: no guest fee on host-only bookings', () => {
  near(f.guestTotalOf(newBk, fs), 1000);
  near(f.guestTotalOf(oldBk, fs), 1140);
});
