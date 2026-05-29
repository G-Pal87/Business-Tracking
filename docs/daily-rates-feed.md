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
  "horizonDays": 365,
  "rates": [
    { "date": "2026-05-30", "amount": 55, "guestAmount": 63, "currency": "EUR", "status": "open",    "basis": "May average" },
    { "date": "2026-05-31", "amount": 62, "guestAmount": 71, "currency": "EUR", "status": "booked",  "basis": "historic actual" },
    { "date": "2026-06-01", "amount": 58, "guestAmount": 66, "currency": "EUR", "status": "blocked", "basis": "same day, prior years" }
  ]
}
```

### Field meaning

| Field         | Meaning                                                                              |
|---------------|--------------------------------------------------------------------------------------|
| `date`        | The night, `YYYY-MM-DD`.                                                              |
| `amount`      | Net nightly rate — what the host earns (integer, rounded).                           |
| `guestAmount` | **Full price the guest pays per night, fees included** = `amount × (1 + guestFeePct% + taxPct%)`. Use this if you want to discount off the guest-facing price. |
| `currency`    | Currency of both amounts.                                                            |
| `status`      | `booked` (actual historic night), `blocked` (reserved via iCal), or `open`.          |
| `basis`       | How the amount was derived (`historic actual`, `same day, prior years`, `<Month> average`, `overall average`). |

Feed-level `guestFeePct` / `taxPct` tell you the assumptions used to gross
`amount` up to `guestAmount`. The feed covers the next `horizonDays` days
(default 365) from the day it was published.
