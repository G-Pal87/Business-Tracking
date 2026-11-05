# Airbnb calendar sync (GitHub)

Browsers can't read Airbnb calendar links: Airbnb sends no CORS headers, and the
app doesn't send the links (which contain an access token) to public proxies.
So a scheduled GitHub workflow fetches them server-side, every 30 minutes, for every
short-term property — whether or not anyone has the app open.

## How it works

```
app ──(encrypted calendar links)──▶ data branch: <data dir>/ical-sources.json
                                            │
             .github/workflows/sync-calendars.yml (every 30 min, or "Refresh")
             scripts/calendar-sync.mjs: fetches each Airbnb calendar directly
                                            │
app ◀──(encrypted calendars)────── data branch: <data dir>/calendars.json
                                            │
             closes newly booked nights in the rates feed (rates-feed branch)
             and asks the Short-Term-Rentals site to rebuild
```

- Both files use the app's encrypted envelope format with a separate
  **calendar key** — never the data key. The app keeps it in its encrypted
  settings; GitHub keeps it as the `CALENDAR_SYNC_KEY` Actions secret. Each file
  is bound to its path (AES-GCM additional data) and names the key it was
  written with (`kid`), so a mismatched key is reported as such.
- The workflow only **closes** nights in the published feed (status
  `unavailable`, no amount). Reopening a night or changing a price still comes
  from the app's pricing when it publishes.
- A cut-off or empty response never wipes stored bookings (`mergeBlocksChecked`).
- `calendars.json` is rewritten when bookings or errors change, on every run
  someone asked for (Refresh, the app's catch-up run, a manual run), and at
  least every 3 hours otherwise, so "last checked" stays meaningful.
- **GitHub starts scheduled runs late** — in practice often 4–7 hours apart
  instead of every 30 minutes. So whenever the app is open and the last check
  is over an hour old, it asks GitHub for a run itself (at most every 30
  minutes) and redraws when the result lands; meanwhile a late calendar shows
  "checking Airbnb now…" instead of a warning.
- It runs in its own concurrency group: GitHub keeps one pending run per group
  and cancels the older pending one, so sharing backup/squash's group could
  cancel a queued backup. Free on a public repository (GitHub-hosted runners).

## Set up (once)

1. In the app: **STR Daily Rates → Set up calendar sync**. It creates the
   calendar key and shows it with a **Copy** button.
2. In GitHub: **repository → Settings → Secrets and variables → Actions → New
   repository secret**, name `CALENDAR_SYNC_KEY`, paste the key, **Add secret**.
3. Back in the app: **Done — start the first sync**. The calendars arrive within
   a minute or two.

## When something goes wrong

The app flags it — under each property's calendar, in a banner on STR Daily
Rates and in **Needs attention → Data to check**:

| Flag | Meaning |
|---|---|
| Not set up | No calendar key yet — follow "Set up". |
| Waiting for the first run | The key exists but no run has finished; check the secret is set. |
| Key doesn't match | The `CALENDAR_SYNC_KEY` secret differs from the app's key — copy it again. |
| Sync failed: … | Airbnb refused or returned no calendar (e.g. an expired link — export a new one in Airbnb). |
| Not synced since … | No successful check for 6+ hours — check the "Sync Airbnb calendars" runs under GitHub → Actions. |

A property that newly can't be fetched also fails the workflow run, so GitHub
emails the repository owner once. While it keeps failing, later runs pass with
a yellow warning ("already failing") instead of emailing every 30 minutes; the
app keeps flagging it until it syncs again.

**Refresh** (STR Daily Rates) asks GitHub for a run now (a `calendar-sync`
repository dispatch) and shows the result when it lands.

## Optional: own calendar proxy

With your own proxy ([ical-proxy.md](ical-proxy.md)) this browser also fetches
calendars directly when STR Daily Rates opens. It isn't required.
