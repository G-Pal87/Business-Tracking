# Private calendar proxy (optional)

Airbnb calendars are fetched by the **GitHub calendar sync** (see [calendar-sync.md](calendar-sync.md)) — no proxy is needed. Browsers can't fetch Airbnb calendar links directly (Airbnb sends no CORS headers), and each link contains an access token (`?s=…`), so the app never sends them to public CORS proxies.

If you also want this browser to fetch calendars itself (e.g. instantly when you open STR Daily Rates), you can run your own free Cloudflare Worker. It takes about five minutes to set up.

## 1. Create the Worker

1. Sign in at <https://dash.cloudflare.com> and go to **Workers & Pages → Create → Create Worker**.
2. Give it a name, for example `calendar-proxy`, and click **Deploy**.
3. Click **Edit code**, replace everything with the script below, change `ALLOWED_ORIGIN` to the address you open the app on, and click **Deploy**.

```js
// Fetches an iCal feed for the Business Tracking app.
// Only accepts POST {url} from the app's own origin, and only for calendar hosts.
const ALLOWED_ORIGIN = 'https://<owner>.github.io';          // where the app runs
const ALLOWED_HOSTS  = [/(^|\.)airbnb\.[a-z.]+$/i];          // add others if you use them
const MAX_BYTES      = 2 * 1024 * 1024;

export default {
  async fetch(request) {
    const cors = {
      'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Cache-Control': 'no-store',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (request.method !== 'POST' || request.headers.get('Origin') !== ALLOWED_ORIGIN) {
      return new Response('Forbidden', { status: 403, headers: cors });
    }
    let target;
    try { target = new URL((await request.json()).url); } catch { return new Response('Bad request', { status: 400, headers: cors }); }
    if (target.protocol !== 'https:' || !ALLOWED_HOSTS.some(rx => rx.test(target.hostname))) {
      return new Response('Host not allowed', { status: 403, headers: cors });
    }
    const upstream = await fetch(target.toString(), { headers: { 'User-Agent': 'calendar-proxy' } });
    const body = await upstream.text();
    if (!upstream.ok || body.length > MAX_BYTES || !body.includes('BEGIN:VCALENDAR')) {
      return new Response('Upstream error', { status: 502, headers: cors });
    }
    return new Response(body, { headers: { ...cors, 'Content-Type': 'text/calendar; charset=utf-8' } });
  },
};
```

The Worker never logs or stores the link. It only accepts requests from your app's address, and only for calendar hosts.

## 2. Connect it in the app

1. Copy the Worker's address, for example `https://calendar-proxy.<you>.workers.dev`.
2. In the app, open **Settings → STR / Airbnb** and paste it into **Calendar proxy**.
4. Save, then import a calendar on one property to check that it works.

## 3. Replace the old links

Earlier calendar fetches went through the public proxies, so treat the old links as exposed. In Airbnb, go to **Listing → Availability → Export calendar** and create new links. Then paste the new links into each property.
