# Daily-Rate Feed (for the Short-Term-Rentals repo)

Business-Tracking publishes a read-only, per-property daily-rate feed that the
**Short-Term-Rentals** repo consumes to build its iCal. Business-Tracking only
specifies the **amount** to push per date; the iCal generation lives in the
Short-Term-Rentals repo.

## How it's published

The feeds refresh **automatically** after every data sync to GitHub: whenever
payment / property / calendar changes are pushed, the feeds whose rates changed
are re-published (unchanged feeds are skipped, so it won't spam commits). You can
also publish on demand via **STR Daily Rates → Publish Rates Feed**, which also
shows the public URLs.

Both publish paths write JSON files into the configured GitHub repo under
`exports/daily-rates/`:

```
exports/daily-rates/index.json        # manifest listing every property feed
exports/daily-rates/<propertyId>.json  # one feed per short-term property
```

For the raw HTTPS URLs to be readable without a token, **the repo must be public**.

## Read URLs

```
https://raw.githubusercontent.com/<owner>/<repo>/<branch>/exports/daily-rates/index.json
https://raw.githubusercontent.com/<owner>/<repo>/<branch>/exports/daily-rates/<propertyId>.json
```

The exact URLs are shown in a dialog right after publishing.

## `index.json` schema

```json
{
  "schema": "str-daily-rates-index/v1",
  "generatedAt": "2026-05-29T10:00:00.000Z",
  "properties": [
    { "id": "prop_abc123", "name": "Poolside Studio", "currency": "EUR", "file": "prop_abc123.json", "nights": 365 }
  ]
}
```

## Per-property feed schema

```json
{
  "schema": "str-daily-rates/v1",
  "generatedAt": "2026-05-29T10:00:00.000Z",
  "property": { "id": "prop_abc123", "name": "Poolside Studio", "currency": "EUR", "airbnbCalUrl": "" },
  "guestFeePct": 14,
  "taxPct": 0,
  "cleaningFee": 50,
  "cleaningGuestTotal": 50,
  "horizonDays": 365,
  "rates": [
    { "date": "2026-05-29", "currency": "EUR", "status": "booked",  "basis": "historic actual",       "originalAmount": 60, "discountPct": 0,  "amount": 60, "airbnbCheckout": 68 },
    { "date": "2026-05-30", "currency": "EUR", "status": "open",    "basis": "May average",           "originalAmount": 55, "discountPct": 0,  "amount": 55, "airbnbCheckout": 63 },
    { "date": "2026-06-01", "currency": "EUR", "status": "blocked", "basis": "confirmed target",       "originalAmount": 60, "discountPct": 10, "amount": 54, "airbnbCheckout": 68 }
  ]
}
```

### Field meaning

| Field            | Meaning                                                                              |
|------------------|--------------------------------------------------------------------------------------|
| `date`           | The night, `YYYY-MM-DD`.                                                              |
| `originalAmount` | Net nightly rate **before** any promotional discount (integer, rounded).             |
| `discountPct`    | The **effective discount %** applied to this night — always present, including `0` when no discount applies, so you can read it unconditionally and mention it to guests. Resolved per night as: a per-month override set in STR Rates → Promotional Discount, falling back to the global discount in Settings → STR / Airbnb if no override exists for that month. Never applied to `booked` (historic actual) nights, since those are past, already-charged stays, not a forward-looking offer. |
| `amount`         | Net nightly rate **after** discount — what the host actually earns = `originalAmount × (1 − discountPct%)`. Equal to `originalAmount` when `discountPct` is 0. |
| `airbnbCheckout` | **Guest-facing nightly price**, guest fee + tax included = `originalAmount × (1 + guestFeePct% + taxPct%)`. Computed from the pre-discount rate — the discount is a host-side promotion, not a change to Airbnb's own fee structure. This is the per-night price to use; cleaning is added separately (once per booking). |
| `currency`       | Currency of all amounts.                                                             |
| `status`         | `booked` (actual historic night), `blocked` (reserved via iCal), or `open`.          |
| `basis`          | How the rate was derived (`historic actual`, `confirmed target`, `same day, prior years`, `<Month> average`, `overall average`). |

Cleaning is charged **once per booking**, not per night. Feed-level fields:
- `guestFeePct` / `taxPct` — Airbnb guest service fee and tax applied to gross the nightly rate up.
- `cleaningFee` / `cleaningGuestTotal` — flat cleaning fee the guest pays, once per booking (no fee/tax added, so these are equal). Set in Settings → STR / Airbnb (default 50). **Add this once per stay.**

There is no feed-level "global discount" field — discount can vary by month
(a per-month override in STR Rates beats the global default), so it's
resolved and exposed per night via `discountPct`/`originalAmount` instead of
one flat setting that could be wrong for an overridden month.

### Reconstructing the full Airbnb guest price

```
guest total for a stay = Σ(airbnbCheckout for each booked night) + cleaningGuestTotal
```

`airbnbCheckout` is already fee/tax-inclusive and pre-discount — apply your
own discount messaging using `discountPct` if you want to show guests the
promotional saving. The feed covers the next `horizonDays` days (default
365) from publication.
