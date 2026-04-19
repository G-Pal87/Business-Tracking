# Business Tracking

A modular web application for tracking properties (short-term Airbnb + long-term rentals) and business services (Customer Success + Marketing), with GitHub as the data store.

## Features

- **Dashboard** — KPIs, YTD revenue/expenses/net, renovation CapEx, 12-month revenue vs expenses, stream breakdown
- **Properties** — Manage properties in EUR and HUF, track renovation vs active status, Airbnb iCal sync, per-property ROI
- **Payments** — Record rental income, filter by property/status/stream, CSV export
- **Expenses** — Track renovation costs, mortgage, maintenance, insurance per property
- **Reports** — Revenue vs expenses, ROI ranking per property, filter by year/stream, print/PDF
- **Forecast** — What-if sliders (occupancy, rate, expense multipliers), 24-month projected P&L, break-even analysis
- **Clients** — CS and Marketing clients, contract info, per-client revenue
- **Invoices** — Builder with client + premade service catalog, auto qty × rate calculation, PDF export
- **Insights** — Cross-stream P&L, YTD vs YoY, owner-based split (You / Rita / Both), per-stream margins
- **Settings** — GitHub storage config, FX rates (HUF→EUR), service catalog, business info on invoices

## Architecture

```
index.html                    # App shell + nav
css/                          # base, layout, components
js/
  core/                       # Reusable layer
    config.js                 # streams, categories, constants
    state.js                  # store + subscribe pattern
    github.js                 # GitHub Contents API
    data.js                   # CRUD + aggregations + currency
    router.js                 # hash routing + module registry
    ui.js                     # modals, toasts, forms
    charts.js                 # Chart.js wrappers
    pdf.js                    # jsPDF invoice generator
    ical.js                   # Airbnb calendar parser
  modules/                    # One file per feature - all plug-and-play
    dashboard.js
    properties.js
    payments.js
    expenses.js
    reports.js
    forecast.js
    clients.js
    invoices.js
    insights.js
    settings.js
  app.js                      # Boots everything
data/
  db.json                     # Single source of truth
```

### Adding a new module

Every module exports:

```js
export default {
  id: 'unique_id',
  label: 'Nav Label',
  icon: 'X',
  render(container, state) { /* draws the view */ },
  refresh(state)            { /* re-renders on data change */ },
  destroy()                  { /* cleanup */ }
};
```

Register in `js/app.js` and add to a nav group in `buildSidebar()`. Done.

## Currency

- Properties, payments, expenses, invoices each store a native currency (`EUR` or `HUF`)
- Master currency is **EUR** — all dashboards and reports convert to EUR
- HUF→EUR rate editable in **Settings** (applied on the fly to all aggregations)
- Detail views show both native amount and EUR equivalent

## GitHub Storage

Data lives in `data/db.json` inside a GitHub repo. The app reads/writes it via the GitHub Contents API using a Personal Access Token (PAT).

### Setup (first time)

1. Push this project to a GitHub repo (public or private)
2. Enable **GitHub Pages** on the repo (Settings → Pages → source: main branch)
3. Open the deployed URL (e.g. `https://<user>.github.io/<repo>/`)
4. Go to **Settings** in the app:
   - Owner: your GitHub username
   - Repo: repo name
   - Branch: `main` (or your default)
   - Token: create a [fine-grained PAT](https://github.com/settings/personal-access-tokens/new) with **Contents: Read and Write** on that repo
5. Click **Save & Pull** — app loads data, future edits auto-sync

The app caches data in `localStorage` for offline viewing.

### Public read access

If your repo is public, **reading** works without a token — viewers can open the app and see data without signing in. Only **writes** require a token.

## Airbnb iCal Import

Airbnb has no public API, but exports iCal calendars per listing. In Airbnb: Listing → Availability → Export Calendar (copy the `.ics` URL).

In the app: Properties → (property) → paste URL → **Import iCal**. Each booking becomes a payment (nights × nightly rate).

## Tech

- Vanilla JS (ES modules) — no build step
- Chart.js for charts
- jsPDF for invoice PDFs
- GitHub Contents API for persistence
- Hosted on GitHub Pages

## Development

Open `index.html` via a local HTTP server (needed for ES modules):

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

## Owners & Streams

| Stream | Default Owner |
|---|---|
| Short-term Rentals | You / Rita / Both |
| Long-term Rentals | You / Rita / Both |
| Customer Success | You |
| Marketing Services | Rita |

Every revenue/expense line is tagged with a stream + owner for filtered analytics.
