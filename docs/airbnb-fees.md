# Airbnb fee models and the STR daily rate

On **13 Oct 2026** Airbnb moved hosts using a channel manager (incl. the EEA)
from the **split** fee to a **host-only** fee:

| | Host fee (taken from your price) | Guest fee (added on top) |
|---|---|---|
| Split (old) | 3% + VAT (≈ 3.57% at 19% VAT) | ~14% |
| Host-only (new) | 15.5% + VAT (≈ 18.45% at 19% VAT) | none |

A reservation keeps the model it was **booked** under, even when the stay is
after 13 Oct 2026. To keep the guest's price the same, the Airbnb daily rate
now has to carry the old guest fee: a €100 rate under the old model (the guest
paid ~€114) is a €114 rate under the new one.

## What STR Daily Rates recommends (`js/core/airbnb-fees.js`)

The recommendation is **the Airbnb daily rate to set** (excl. cleaning), in
today's host-only terms — what the guest pays per night.

- **Every past Airbnb booking is put on that scale:** nightly rate = (booking
  total − cleaning) ÷ nights; old split-fee bookings × (1 + guest fee), since
  their guests paid the fee on top; new host-only ones as they are. So old and
  new bookings blend without dragging the rate down.
- **Cleaning fee after the change** (Settings): *keep* (default) — your
  Airbnb cleaning fee stays as it is, so the guest fee your guests used to pay
  on cleaning moves into the nightly rate: (booking total × (1 + guest fee) −
  cleaning) ÷ nights, e.g. €160 total, €40 cleaning, 3 nights, 19% → €50 a
  night, and the guest pays €190 as before. *Raise* — you raise the cleaning
  fee by the guest fee too: (booking total − cleaning) ÷ nights × (1 + guest
  fee) = €48 a night + €48 cleaning. The guest fee your guests paid can be
  checked in the Airbnb app (guest total ÷ booking total; 19% ≈ 16% + VAT).
- **Which model a booking was on** comes from its own import figures (service
  fee ÷ gross earnings: ≥ 10% = host-only), else its booking date (≥ 13 Oct
  2026 = host-only), else its check-in (before the switch = split).
- **Direct (off-platform) bookings** are shown on the calendar but not learnt
  from: their price is the discounted website price.
- **Last-minute bookings** (booked < 7 days ahead, often priced down to fill
  the night) count at half weight. STR Daily Rates shows how much lower they
  went than earlier bookings for the same months ("Last-Minute Bookings").
- **Weekend uplift** (Settings, default 10%) applies to Friday and Saturday
  nights. Past weekend nights are brought back to the weekday level before
  blending, so the uplift isn't counted twice.
- **Yearly price growth** (Settings, default 0%) raises older years' rates per
  year before blending.
- **Year weights** are unchanged: the target date's year 3× per night, each
  year before × 0.65 (1.95×, 1.27×, 0.82×…); 5+ nights in the same month and
  year stand alone.
- **Confirmed monthly targets** are the weekday Airbnb rate (weekends get the
  uplift). Targets confirmed before this change were payouts per night; they're
  read on the new scale (× (1 + guest fee) ÷ (1 − old host fee) ≈ × 1.18)
  without being rewritten, and saved with `basis: 'airbnb_rate'` when next
  confirmed.
- **"You receive"** shows what a night at that rate pays out after Airbnb's
  current fee.

## The website

`amount` (the direct price) = the Airbnb daily rate − your discount (global,
or the month's own, which overrides it). `airbnbCheckout` = what an Airbnb guest
pays: the rate (+ tax); plus the guest fee only under the old split model.
`guestFeePct` is 0 under host-only, so `airbnbCheckout = originalAmount ×
(1 + (guestFeePct + taxPct)/100)` still holds.

## Settings → Airbnb

Fee model for new bookings · Host fee % (before VAT, 15.5) · VAT on Airbnb's
fee % (19) · Guest service fee % (old split model only, 14) · Occupancy /
tourist tax % · Weekend uplift % (10) · Yearly price growth % (0).

STR Analytics keeps comparing targets with achieved revenue on the payout
footing (a target night counts as what it would pay out).

## Pricing strategy (`js/core/pricing-strategy.js`)

The history-based suggestion is adjusted by a strategy before it's shown and
published. Confirmed monthly targets are explicit prices and are never adjusted.

| Strategy | Effect |
|---|---|
| **Auto** (default) | Per property and month, from booking pace: occupancy booked on Airbnb now vs booked by the same day last year (by booking date). ½% per point ahead/behind, ±3% for months that usually sell out (≥ 85%) / stay quiet (≤ 40%), capped (±15%). Falls back to Balanced without last year's booking dates, or when the month is mostly closed. |
| **Fill nights** | −10% (editable) |
| **Balanced** | the suggestion as it is |
| **Maximise rate** | +10% (editable) |

**Last-minute drop:** open nights within 7 days (editable) get your measured
last-minute drop (how much cheaper your last-minute bookings went), or a fixed
% — under Fill nights, and under Auto unless it's raising the price.

**Which applies:** the month's own choice (per property, in the ADR target box)
beats the property's (STR Daily Rates, next to "Website prices"), which beats
the global one (Settings → Airbnb). The day popup says which applied and why,
e.g. "Strategy: Auto: Fill nights −11% — July 31% booked vs 52% this time last
year → history rate €70 becomes €62 (global setting)".
