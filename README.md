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
index.html                    # App shell + nav (Chart.js + jsPDF loaded up front)
css/                          # base, layout, components
js/
  bootstrap.js                # cache-busting loader for app.js
  app.js                      # Boot: load cache → sync with GitHub → auth → router
  core/                       # Reusable layer
    config.js                 # streams, categories, constants
    state.js                  # store + subscribe pattern
    github.js                 # GitHub Contents API, 3-way merge, local cache
    crypto.js                 # AES-GCM encryption of db.json + attachments
    auth.js                   # users, sessions, login/unlock screens
    presence.js               # who's online, device registry, remote disconnect
    data.js                   # CRUD + aggregations + currency + rent schedules
    dates.js                  # timezone-safe YYYY-MM-DD helpers
    router.js                 # hash routing + module registry
    ui.js                     # modals, toasts, forms, tables
    charts.js                 # Chart.js wrappers
    pdf.js                    # jsPDF invoice generator
    ical.js                   # Airbnb calendar parser
    libs.js                   # on-demand loader for pdf.js / Tesseract / JSZip
  modules/                    # One file per feature
    analytics*.js             # Analysis views (executive, revenue, expenses,
                              #   properties, STR, cash flow, forecast, owner,
                              #   personal, tax) + shared helpers/filters
    reconciliation.js         # expected vs actual per property / stream
    properties.js, payments.js, str-rates.js, expenses.js, dividends.js,
    tenants.js, vendors.js, inventory.js, company-structure.js, clients.js,
    invoices.js, time-off.js, forecast.js, cyprus-tax.js (tax helpers),
    settings.js, users.js
data/
  db.json                     # Single source of truth (encrypted envelope)
backups/                      # Encrypted snapshots: 14 daily, 8 weekly, 8 monthly (GitHub Action)
# exports/daily-rates/ lives on the single-commit `rates-feed` branch, not here
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

Add a row (same `id`/`label`/`icon`, plus its `file`) to the `ROUTES` list in `js/app.js` and add its id to a nav group in `buildSidebar()`. Done. Modules are loaded on first navigation (and prefetched at idle after the first screen), so a module must not rely on import-time side effects.

### Deploying

Pages is deployed by `.github/workflows/pages.yml` (Settings → Pages → Source: **GitHub Actions**). It publishes only the code, and stamps `js/version.js` with the commit SHA so browsers cache the modules until the next deploy; data saves don't trigger a deploy.

## Currency

- Properties, payments, expenses, invoices each store a native currency (`EUR` or `HUF`)
- Master currency is **EUR** — all dashboards and reports convert to EUR
- HUF→EUR rate editable in **Settings** (applied on the fly to all aggregations)
- Detail views show both native amount and EUR equivalent

## GitHub Storage

Data lives in `data/db.json` inside a GitHub repo. The app reads/writes it via the GitHub Contents API using a Personal Access Token (PAT).

### Setup (first time)

1. Push this project to a GitHub repo (public or private)
2. Enable **GitHub Pages** on the repo (Settings → Pages → Source: GitHub Actions — see Deploying above)
3. Open the deployed URL (e.g. `https://<user>.github.io/<repo>/`)
4. Go to **Settings** in the app:
   - Owner: your GitHub username
   - Repo: repo name
   - Branch: `main` (or your default)
   - Token: create a [fine-grained PAT](https://github.com/settings/personal-access-tokens/new) with **Contents: Read and Write** on that repo
5. Click **Save & Pull** — app loads data, future edits auto-sync

The app caches data in `localStorage` for offline viewing.

### Encryption

Once an admin generates a key (Settings → Encryption), `data/db.json`, backups and
uploaded documents are encrypted client-side with AES-256-GCM before being committed.
Every device needs the key once (it is then stored wrapped under the user's login
password). Rotating the key re-encrypts everything; the previous key is kept on the
rotating device as a fallback until the rotation finishes. A device holding an old key
refuses to save over data it can't decrypt, and asks for the new key instead.

### Security model and limits

The app has no backend: the repository is the database, and it is **public**.
Encryption keeps the *contents* private; everything else follows from that design.

- **The shared token is full data access.** Every user's device holds the same
  GitHub token and the same data key. Anyone with both can read, change or delete
  all data and its history — treat every user as fully trusted.
- **Roles are enforced only in the browser.** "Admin" and "user" decide what the UI
  shows. A user can edit their own role in the synced data (or in DevTools) and push
  it; there is nothing server-side to stop them.
- **"Kill session" / "Disconnect others" are advisory.** They set a flag the
  running tab obeys. A reload gets past it, and the token, key and local cache on
  that device are untouched. Anyone with the token can also forge these signals and
  the session log.
- **Rotating the key doesn't protect the past.** Every earlier version of `db.json`,
  the attachments and the backups stays in the git history (and on GitHub Pages),
  still encrypted under the old key. Whoever had the old key can keep decrypting
  everything written up to the rotation.
- **Metadata is public.** File sizes, commit times and counts, the `presence`
  branch (who is online, device names, login events) and the rate feeds are
  readable by anyone.

**When someone leaves (or a device is lost):**

1. Revoke the shared PAT on GitHub and create a new one (Settings → Developer
   settings → Fine-grained tokens); enter it on the remaining devices.
2. Rotate the encryption key in Settings → Encryption and give the new key only
   to the remaining users.
3. Remove the user in Settings → Users.
4. Accept that data up to that point stays readable to them (see above). Real
   revocation means moving the data to a new **private** repository.

See [docs/security.md](docs/security.md) for the privacy guard, the git hooks and
what the history keeps.

### Sync model

Each save fetches the latest `db.json`, three-way merges it with local changes
(per record by `updatedAt`; plain fields such as settings per key), and writes it back
guarded by the file's SHA. Permanently deleted records leave a tombstone so stale copies
can't resurrect them. Restoring a snapshot re-stamps its records so they win the merge,
and moves records that aren't in the snapshot to Trash.

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

This repository is public. Enable the privacy-guard git hooks once per clone, so
unencrypted data or secrets are caught **before** they are committed or pushed
(CI only notices after the push, when it is already public):

```bash
git config core.hooksPath .githooks
```

Check the whole history of every branch at any time with
`python3 .github/scripts/privacy-guard.py --all` (see [docs/security.md](docs/security.md)).

## Owners & Streams

| Stream | Default Owner |
|---|---|
| Short-term Rentals | You / Rita / Both |
| Long-term Rentals | You / Rita / Both |
| Customer Success | You |
| Marketing Services | Rita |

Every revenue/expense line is tagged with a stream + owner for filtered analytics.
