// Airbnb fee models and the STR daily-rate basis (docs/airbnb-fees.md).
//
// Until 13 Oct 2026 hosts using a channel manager were on the SPLIT model:
// a 3% host fee (+ VAT on it) taken from the price, and a guest service fee
// (~14%) added on top for the guest. From then on it's HOST-ONLY: 15.5%
// (+ VAT) taken from the price, nothing added for the guest. A reservation
// keeps the model it was BOOKED under, even for a stay after the switch.
//
// STR Daily Rates recommends the AIRBNB DAILY RATE to set (excl. cleaning),
// under today's host-only model: what the guest pays per night. Every past
// booking is put on that scale — split-model bookings × (1 + guest fee), as
// their guests paid the fee on top, host-only bookings as they are — so old
// and new bookings blend without dragging the rate down. The website's
// direct price is that rate minus your discount.

export const HOST_ONLY_FROM = '2026-10-13';
export const DEFAULT_HOST_FEE_BASE_PCT = 15.5;  // host-only fee, before VAT
export const DEFAULT_VAT_PCT = 19;              // VAT Airbnb adds to its fee (15.5% × 1.19 = 18.4%, as on the first host-only payouts)
export const SPLIT_HOST_FEE_BASE_PCT = 3;       // old split model's host fee, before VAT
export const DEFAULT_GUEST_FEE_PCT = 14;        // old split model's guest fee
export const DEFAULT_WEEKEND_UPLIFT_PCT = 10;   // Friday and Saturday nights
export const DEFAULT_GROWTH_PCT = 0;            // yearly price growth applied to older years
export const LAST_MINUTE_DAYS = 7;              // booked fewer days ahead than this = last-minute
export const LAST_MINUTE_WEIGHT = 0.5;          // last-minute bookings count half in recommendations
// A measured fee share above this is host-only (old ≈ 3.6%, new ≈ 18.4%).
const HOST_ONLY_THRESHOLD = 0.10;

const num = (v, d) => (v === '' || v == null || !Number.isFinite(Number(v)) ? d : Number(v));
const round2 = x => Math.round((x + 1e-9) * 100) / 100;

// The fee and pricing settings (state.db.settings.airbnb) with defaults.
// hostFeePct / splitHostFeePct are the effective shares incl. VAT.
export function feeSettings(af = {}) {
  const vatPct = num(af.vatPct, DEFAULT_VAT_PCT);
  const hostFeeBasePct = num(af.hostFeeBasePct, DEFAULT_HOST_FEE_BASE_PCT);
  return {
    hostOnly: af.feeModel !== 'split',
    hostFeeBasePct, vatPct,
    hostFeePct: round2(hostFeeBasePct * (1 + vatPct / 100)),
    splitHostFeePct: round2(SPLIT_HOST_FEE_BASE_PCT * (1 + vatPct / 100)),
    guestFeePct: num(af.guestFeePct, DEFAULT_GUEST_FEE_PCT),
    taxPct: num(af.taxPct, 0),
    weekendUpliftPct: num(af.weekendUpliftPct, DEFAULT_WEEKEND_UPLIFT_PCT),
    // 'keep': your Airbnb cleaning fee stays as it is, so the old guest fee
    // on cleaning moves into the nightly rate; 'raise': you raise the
    // cleaning fee by the guest fee too, so it stays with cleaning.
    cleaningStrategy: af.cleaningStrategy === 'raise' ? 'raise' : 'keep',
    growthPct: num(af.growthPct, DEFAULT_GROWTH_PCT)
  };
}

// Share of the booking total (host gross) Airbnb kept, from the import's own
// figures; null when they're missing.
export function measuredFeeRate(p) {
  const gross = Number(p?.airbnbGrossEarnings), fee = Number(p?.airbnbServiceFee);
  if (!(gross > 0) || !Number.isFinite(fee) || fee === 0) return null;
  const r = Math.abs(fee) / gross;
  return r < 0.6 ? r : null;
}

// 'host_only' | 'split' for an Airbnb reservation, null for anything else
// (manual / off-platform bookings pay no Airbnb fee). The import's own fee
// figures win; else the booking date decides.
export function bookingFeeModel(p) {
  if (!p || p.source !== 'airbnb') return null;
  const r = measuredFeeRate(p);
  if (r != null) return r >= HOST_ONLY_THRESHOLD ? 'host_only' : 'split';
  const booked = p.airbnbBookingDate || '';
  if (booked) return booked >= HOST_ONLY_FROM ? 'host_only' : 'split';
  // No booking date: a stay that started before the switch was booked before it.
  const ci = p.airbnbCheckIn || p.checkIn || '';
  return ci && ci < HOST_ONLY_FROM ? 'split' : 'host_only';
}

// Fee share (0–1) taken from this booking's total, cleaning included.
export function bookingFeeRate(p, fs = feeSettings()) {
  const model = bookingFeeModel(p);
  if (!model) return 0;
  const r = measuredFeeRate(p);
  if (r != null) return r;
  return (model === 'host_only' ? fs.hostFeePct : fs.splitHostFeePct) / 100;
}

// The booking's AIRBNB DAILY RATE in today's (host-only) terms, excl. cleaning
// — the nightly price that, with today's cleaning fee, costs a guest what
// this booking's guest paid:
//   host-only bookings: (booking total − cleaning) ÷ nights, as they are;
//   split bookings, cleaning fee kept:   (booking total × (1 + guest fee) − cleaning) ÷ nights
//     e.g. €160 total, €40 cleaning, 3 nights, 19% → (190.40 − 40) ÷ 3 = €50.13;
//   split bookings, cleaning fee raised: (booking total − cleaning) ÷ nights × (1 + guest fee).
// Manual / off-platform bookings: their own nightly price (no Airbnb fee).
export function airbnbRatePerNight(p, nights, fs = feeSettings()) {
  if (!(nights > 0) || p?.amount == null) return null;
  const cleaning = Number(p.airbnbCleaningFee) || 0;
  const model = bookingFeeModel(p);
  if (!model) return (Number(p.amount) - cleaning) / nights;
  const gross = Number(p.airbnbGrossEarnings) > 0 ? Number(p.airbnbGrossEarnings) : Number(p.amount) / (1 - bookingFeeRate(p, fs));
  if (model !== 'split') return (gross - cleaning) / nights;
  const g = 1 + fs.guestFeePct / 100;
  return fs.cleaningStrategy === 'raise' ? (gross - cleaning) / nights * g : (gross * g - cleaning) / nights;
}

// What the booking paid out per night, excl. cleaning (the cleaning that
// reached you, after Airbnb's fee on it, is taken off).
export function payoutPerNight(p, nights, fs = feeSettings()) {
  if (!(nights > 0) || p?.amount == null) return null;
  const cleaning = Number(p.airbnbCleaningFee) || 0;
  return (Number(p.amount) - cleaning * (1 - bookingFeeRate(p, fs))) / nights;
}

// What you receive per night at an Airbnb daily rate, under the current model.
export function payoutForRate(rate, fs = feeSettings()) {
  if (rate == null) return null;
  return rate * (1 - (fs.hostOnly ? fs.hostFeePct : fs.splitHostFeePct) / 100);
}

// What an Airbnb guest pays per night at an Airbnb daily rate: the rate (+ tax);
// under the split model the guest fee comes on top as well.
export function airbnbCheckoutFor(rate, fs = feeSettings()) {
  if (rate == null) return null;
  return rate * (1 + ((fs.hostOnly ? 0 : fs.guestFeePct) + fs.taxPct) / 100);
}

// The rates feed's `guestFeePct`: what Airbnb adds for the guest on top of the
// rate (none under host-only), so airbnbCheckout = originalAmount × (1 +
// (guestFeePct + taxPct)/100).
export function feedGuestFeePct(fs = feeSettings()) {
  return fs.hostOnly ? 0 : fs.guestFeePct;
}

// Estimated guest total of an imported reservation: the booking total (host
// gross) plus tax, plus the guest fee only for split-model bookings.
export function guestTotalOf(p, fs = feeSettings()) {
  const base = p?.airbnbGrossEarnings != null ? Number(p.airbnbGrossEarnings) : (p?.amount != null ? Number(p.amount) : null);
  if (base == null) return null;
  const guestFee = bookingFeeModel(p) === 'host_only' ? 0 : fs.guestFeePct;
  return base * (1 + (guestFee + fs.taxPct) / 100);
}

// ── Confirmed monthly targets ────────────────────────────────────────────────
// Targets confirmed before this change were payouts per night; they're read
// on the Airbnb-rate scale (× (1 + guest fee) ÷ (1 − old host fee) — what
// their guests paid) without rewriting them. New ones are saved with
// basis 'airbnb_rate'. A target is the WEEKDAY rate; weekends get the uplift.
export function targetBase(t, fs = feeSettings()) {
  if (!t || t.targetADR == null) return null;
  if (t.basis === 'airbnb_rate') return Number(t.targetADR);
  return Number(t.targetADR) * (1 + fs.guestFeePct / 100) / (1 - fs.splitHostFeePct / 100);
}

// ── Weekend uplift ───────────────────────────────────────────────────────────
// Friday and Saturday nights (a night = its check-in date).
export function isWeekendNight(date) {
  const d = new Date(`${date}T00:00:00Z`).getUTCDay();
  return d === 5 || d === 6;
}
export function weekendFactor(date, fs = feeSettings()) {
  return isWeekendNight(date) ? 1 + fs.weekendUpliftPct / 100 : 1;
}

// ── Lead time ────────────────────────────────────────────────────────────────
// Days between booking and check-in; null when the booking date is unknown.
export function leadDays(bookingDate, checkIn) {
  if (!bookingDate || !checkIn) return null;
  const d = Math.round((Date.parse(`${checkIn}T00:00:00Z`) - Date.parse(`${String(bookingDate).slice(0, 10)}T00:00:00Z`)) / 864e5);
  return Number.isFinite(d) ? Math.max(0, d) : null;
}
export const isLastMinute = lead => lead != null && lead < LAST_MINUTE_DAYS;

// Older years' rates brought to the target year with the yearly growth %.
export function growthFactor(yearsAgo, fs = feeSettings()) {
  return yearsAgo > 0 ? Math.pow(1 + fs.growthPct / 100, yearsAgo) : 1;
}

export const FEE_MODEL_LABEL = { host_only: 'new Airbnb fee (host-only)', split: 'old Airbnb fee (split)' };
