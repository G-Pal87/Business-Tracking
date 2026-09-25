# Daily-Rate Feed (for the Short-Term-Rentals repo)

Business-Tracking publishes a read-only, per-property daily-rate feed that the
**Short-Term-Rentals** repo consumes to build its iCal. Business-Tracking only
specifies the **amount** to push per date; the iCal generation lives in the
Short-Term-Rentals repo.

## How it's published

The feeds refresh **automatically** after every data sync to GitHub: whenever
payment / property / calendar changes are pushed, the feeds whose rates changed
are re-published (nothing is published when no feed changed). You can
also publish on demand via **STR Daily Rates → Publish Rates Feed**, which also
shows the public URLs.

Both publish paths write the JSON files to the **`rates-feed` branch** of the
configured GitHub repo, under `exports/daily-rates/`. That branch always holds
exactly **one commit**: every publish replaces the whole branch with the current
files, so past prices never accumulate in the public git history. (The feeds
used to be committed to `main`, which kept every old version.) Don't commit
feed files to `main`; `exports/` is gitignored there.

```
exports/daily-rates/index.json        # manifest listing every property feed
exports/daily-rates/<propertyId>.json  # one feed per short-term property
```

For the raw HTTPS URLs to be readable without a token, **the repo must be public**.

## Read URLs

```
https://raw.githubusercontent.com/<owner>/<repo>/rates-feed/exports/daily-rates/index.json
https://raw.githubusercontent.com/<owner>/<repo>/rates-feed/exports/daily-rates/<propertyId>.json
```

The exact URLs are shown in a dialog right after publishing.

## Privacy

These files are **public**. They only contain what the website needs:

- **Open** nights carry the advertised price.
- **Booked and owner-blocked** nights are both published as `unavailable`, **with no amount**.
  Earlier versions published the real payout of every booked night ("historic actual") and
  distinguished booked from blocked nights; neither is published any more.
- When prices are hidden for a property, the feed has `showPrices: false` and **no amounts at all**
  (and no fee/cleaning fields). The website then shows "Price on request".

"Replaced" is not the same as "deleted": an overwritten `rates-feed` commit stays
reachable by its SHA on GitHub until it is garbage-collected, and old feeds that were
committed to `main` (including the early ones with real payouts) remain in `main`'s
history. See [security.md](security.md#if-something-leaked) for how to have them purged.
The daily privacy-guard scan checks that the branch holds only these files, in this schema.

Prices are hidden per property (property form → "Website prices", or the toggle in
STR Daily Rates) or for every property at once (Settings → STR / Airbnb →
"Hide all prices on the website"). Feeds of properties that no longer exist are removed
automatically on publish.

## `index.json` schema

```json
{
  "schema": "str-daily-rates-index/v1",
  "generatedAt": "2026-05-29T10:00:00.000Z",
  "properties": [
    { "id": "prop_abc123", "name": "Poolside Studio", "currency": "EUR", "file": "prop_abc123.json", "nights": 365, "showPrices": true }
  ]
}
```

## Per-property feed schema

Prices shown (`showPrices: true`):

```json
{
  "schema": "str-daily-rates/v1",
  "generatedAt": "2026-05-29T10:00:00.000Z",
  "property": { "id": "prop_abc123", "name": "Poolside Studio", "currency": "EUR", "airbnbCalUrl": "" },
  "showPrices": true,
  "horizonDays": 365,
  "guestFeePct": 14,
  "taxPct": 0,
  "cleaningFee": 50,
  "cleaningGuestTotal": 50,
  "rates": [
    { "date": "2026-05-29", "currency": "EUR", "status": "unavailable" },
    { "date": "2026-05-30", "currency": "EUR", "status": "open", "basis": "suggested",        "originalAmount": 55, "discountPct": 0,  "amount": 55, "airbnbCheckout": 63 },
    { "date": "2026-06-01", "currency": "EUR", "status": "open", "basis": "confirmed target", "originalAmount": 60, "discountPct": 10, "amount": 54, "airbnbCheckout": 68 }
  ]
}
```

Prices hidden (`showPrices: false`) — availability only:

```json
{
  "schema": "str-daily-rates/v1",
  "generatedAt": "2026-05-29T10:00:00.000Z",
  "property": { "id": "prop_abc123", "name": "Poolside Studio", "currency": "EUR", "airbnbCalUrl": "" },
  "showPrices": false,
  "horizonDays": 365,
  "rates": [
    { "date": "2026-05-29", "currency": "EUR", "status": "unavailable" },
    { "date": "2026-05-30", "currency": "EUR", "status": "open" }
  ]
}
```

### Field meaning

| Field            | Meaning |
|------------------|---------|
| `showPrices`     | `false` = do not show any price for this property (use "Price on request"). Missing = treat as `true` (older feeds). |
| `date`           | The night, `YYYY-MM-DD`. |
| `status`         | `open` (bookable) or `unavailable` (booked or blocked — deliberately not distinguished). |
| `originalAmount` | Open nights only: nightly rate **before** any promotional discount. |
| `discountPct`    | Open nights only: effective discount % (per-month override, else the global discount; always present, `0` when none). |
| `amount`         | Open nights only: nightly rate **after** discount = `originalAmount × (1 − discountPct%)`. |
| `airbnbCheckout` | Open nights only: guest-facing nightly price incl. guest fee + tax, from the pre-discount rate. |
| `currency`       | Currency of all amounts. |
| `basis`          | `confirmed target` or `suggested`. |

Cleaning is charged **once per booking**, not per night (`cleaningFee` / `cleaningGuestTotal`,
present only when prices are shown). The feed covers the next `horizonDays` days (default 365).
