// Airbnb fee models (docs/airbnb-fees.md).
//
// Until 13 Oct 2026 hosts using a channel manager were on the SPLIT model:
// ~3% host fee (+ VAT on it ≈ 3.6% of the booking total) and a guest service
// fee (~14%) added on top of the price. From then on it's HOST-ONLY: 15.5%
// (+ VAT ≈ 18.4%) taken from the payout, nothing added for the guest.
// A reservation keeps the model it was BOOKED under, even for a stay after
// the switch.
//
// STR Daily Rates learns from what each booking actually PAID OUT per night
// (excl. cleaning), which is comparable across both models, then turns a
// payout target into the price to set on Airbnb with the current host fee.

export const HOST_ONLY_FROM = '2026-10-13';
export const DEFAULT_HOST_FEE_PCT = 18.4;   // 15.5% + VAT, as measured on the first host-only payouts
export const SPLIT_HOST_FEE_PCT = 3.6;      // 3% + VAT (old model)
export const DEFAULT_GUEST_FEE_PCT = 14;    // old model's guest fee
// A measured fee share above this is host-only (old ≈ 3.6%, new ≈ 18.4%).
const HOST_ONLY_THRESHOLD = 0.10;

const num = (v, d) => (v === '' || v == null || !Number.isFinite(Number(v)) ? d : Number(v));

// The fee settings (state.db.settings.airbnb) with defaults.
export function feeSettings(af = {}) {
  return {
    hostOnly: af.feeModel !== 'split',
    hostFeePct: num(af.hostFeePct, DEFAULT_HOST_FEE_PCT),
    guestFeePct: num(af.guestFeePct, DEFAULT_GUEST_FEE_PCT),
    taxPct: num(af.taxPct, 0)
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

// Fee share (0–1) taken from this booking's payout, cleaning included.
export function bookingFeeRate(p, fs = feeSettings()) {
  const model = bookingFeeModel(p);
  if (!model) return 0;
  const r = measuredFeeRate(p);
  if (r != null) return r;
  return (model === 'host_only' ? fs.hostFeePct : SPLIT_HOST_FEE_PCT) / 100;
}

// What the booking paid out per night, excl. cleaning. The payout (amount) is
// after Airbnb's fee on the WHOLE booking total, cleaning included, so only
// the cleaning that actually reached you is taken off.
export function payoutPerNight(p, nights, fs = feeSettings()) {
  if (!(nights > 0) || p?.amount == null) return null;
  const cleaning = Number(p.airbnbCleaningFee) || 0;
  return (Number(p.amount) - cleaning * (1 - bookingFeeRate(p, fs))) / nights;
}

// Nightly price to set on Airbnb so a booking pays out `payout`.
export function airbnbPriceFor(payout, fs = feeSettings()) {
  if (payout == null) return null;
  return payout / (1 - (fs.hostOnly ? fs.hostFeePct : SPLIT_HOST_FEE_PCT) / 100);
}

// What an Airbnb guest pays per night for a payout target: the Airbnb price
// (+ tax); under the split model the guest fee comes on top as well.
export function airbnbCheckoutFor(payout, fs = feeSettings()) {
  if (payout == null) return null;
  const price = airbnbPriceFor(payout, fs);
  return price * (1 + ((fs.hostOnly ? 0 : fs.guestFeePct) + fs.taxPct) / 100);
}

// The rates feed's `guestFeePct`: the mark-up from a nightly rate to its
// Airbnb checkout price, net of tax — so `airbnbCheckout = originalAmount ×
// (1 + (guestFeePct + taxPct)/100)` keeps holding for the website.
export function feedGuestFeePct(fs = feeSettings()) {
  return Math.round(((airbnbCheckoutFor(100, fs) / 100 - 1) * 100 - fs.taxPct) * 10) / 10;
}

// Estimated guest total of an imported reservation: the booking total (host
// gross) plus tax, plus the guest fee only for split-model bookings.
export function guestTotalOf(p, fs = feeSettings()) {
  const base = p?.airbnbGrossEarnings != null ? Number(p.airbnbGrossEarnings) : (p?.amount != null ? Number(p.amount) : null);
  if (base == null) return null;
  const guestFee = bookingFeeModel(p) === 'host_only' ? 0 : fs.guestFeePct;
  return base * (1 + (guestFee + fs.taxPct) / 100);
}

export const FEE_MODEL_LABEL = { host_only: 'new Airbnb fee (host-only)', split: 'old Airbnb fee (split)' };
