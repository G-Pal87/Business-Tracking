# Airbnb fee models

On **13 Oct 2026** Airbnb moved hosts using a channel manager (incl. the EEA)
from the **split** fee to a **host-only** fee:

| | Host fee (taken from your price) | Guest fee (added on top) |
|---|---|---|
| Split (old) | 3% + VAT ≈ **3.6%** of the booking total | ~14% |
| Host-only (new) | 15.5% + VAT ≈ **18.4%** of the booking total | none |

A reservation keeps the model it was **booked** under, even when the stay is
after 13 Oct 2026. Keeping the same payout needs the Airbnb price raised by
about **18%** (0.964 ÷ 0.816), not 15%.

## How the app handles it (`js/core/airbnb-fees.js`)

- **Each reservation's model** comes from its own import figures (service fee ÷
  gross earnings: ≥ 10% = host-only), else from its booking date (≥ 13 Oct 2026
  = host-only), else from its check-in (before the switch = split). Manual and
  off-platform bookings pay no Airbnb fee.
- **STR Daily Rates learns from payouts.** Each booked night's net rate is what
  the booking paid out per night excl. cleaning — and only the cleaning that
  reached you (after Airbnb's fee on it) is taken off. Payouts are comparable
  across both models, so old and new bookings feed the suggestions and the
  recommended monthly target alike; next year's suggestion for a season blends
  that season's old- and new-fee bookings on the same footing.
- **"Set in Airbnb"** turns a payout (a suggestion or a confirmed target) into
  the nightly price to type into Airbnb: payout ÷ (1 − host fee). Shown on the
  month's KPIs, in each day's detail and in the target form.
- **Day detail** shows each booking's booking date and fee model.
- **Rates feed**: `amount` (the direct-booking price) stays the payout target;
  `airbnbCheckout` is what an Airbnb guest pays — the Airbnb price (+ tax), plus
  the guest fee only under the split model. `guestFeePct` is the mark-up from
  `originalAmount` to `airbnbCheckout` net of tax (22.5% at an 18.4% host fee),
  so `airbnbCheckout = originalAmount × (1 + (guestFeePct + taxPct)/100)` still
  holds.
- **Payments**: the estimated guest total adds the guest fee only to
  reservations booked under the split model.

Settings → Airbnb: **fee model for new bookings** (host-only by default) and
**host fee % incl. VAT** (default 18.4%, as measured on the first host-only
payouts). The guest fee % only applies to the old split model.
