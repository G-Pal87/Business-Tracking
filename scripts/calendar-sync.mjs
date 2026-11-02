// Scheduled Airbnb calendar sync (run by .github/workflows/sync-calendars.yml;
// see docs/calendar-sync.md and js/core/calsync.js).
//
//   1. reads ical-sources.json (written by the app, encrypted with the
//      calendar key) from the data branch;
//   2. fetches each Airbnb calendar directly (no CORS server-side, no proxy);
//   3. writes calendars.json (encrypted) back to the data branch when anything
//      changed, or every CALSYNC.heartbeatHours so "last checked" stays fresh;
//   4. closes newly booked nights in the public rates feed (written to
//      exports/daily-rates/ for publish-rates-feed.sh) and says so on
//      $GITHUB_OUTPUT (feed_changed=true);
//   5. exits 1 when a property couldn't be fetched, so the run shows red and
//      GitHub notifies the owner (the app also flags it).
//
// Env: CALENDAR_SYNC_KEY, GITHUB_TOKEN, GITHUB_REPOSITORY, DATA_BRANCH,
// DB_PATH, FEED_DIR (local output, default exports/daily-rates), GITHUB_OUTPUT (optional),
// GITHUB_API (tests only).
import fs from 'node:fs';
import path from 'node:path';

// js/core/ical.js imports the app state module, which touches localStorage.
if (!globalThis.localStorage) {
  const m = new Map();
  globalThis.localStorage = { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) };
}
const here = path.dirname(new URL(import.meta.url).pathname);
const { CALSYNC, syncPath, decryptCalendarJson, encryptCalendarJson, applyFetchedCalendar, closeBookedNights, isCalendarKey } =
  await import(path.join(here, '../js/core/calsync.js'));

const env = process.env;
const API = env.GITHUB_API || 'https://api.github.com';
const repo = env.GITHUB_REPOSITORY;
const branch = env.DATA_BRANCH || 'main';
const dbPath = env.DB_PATH || 'data/db.json';
// The feed's path on the rates-feed branch, and where the updated copy is
// written locally for publish-rates-feed.sh (the same folder in the workflow).
const FEED_REPO_DIR = 'exports/daily-rates';
const feedDir = env.FEED_DIR || FEED_REPO_DIR;
const key = (env.CALENDAR_SYNC_KEY || '').trim();
const log = (...a) => console.log('[calendar-sync]', ...a);
const output = (k, v) => { if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, `${k}=${v}\n`); };

const gh = async (method, p, body) => {
  const res = await fetch(`${API}/repos/${repo}${p}`, {
    method,
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${env.GITHUB_TOKEN}`, 'Content-Type': 'application/json', 'User-Agent': 'calendar-sync' },
    body: body ? JSON.stringify(body) : undefined
  });
  return res;
};
async function readJsonFile(p, ref) {
  const res = await gh('GET', `/contents/${p.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`);
  if (res.status === 404) return { json: null, sha: null };
  if (!res.ok) throw new Error(`reading ${p} failed (${res.status})`);
  const data = await res.json();
  let text = Buffer.from(data.content || '', 'base64').toString('utf8');
  if (!text && data.sha) {
    const blob = await gh('GET', `/git/blobs/${data.sha}`);
    text = Buffer.from((await blob.json()).content, 'base64').toString('utf8');
  }
  return { json: JSON.parse(text), sha: data.sha };
}
// The app saves to the same branch all the time; GitHub refuses a write that
// races one (409, or 422 "sha wasn't supplied"/stale) — re-read the file's sha
// and retry, like the app does.
async function writeJsonFile(p, obj, sha, message) {
  for (let attempt = 1; ; attempt++) {
    const res = await gh('PUT', `/contents/${p.split('/').map(encodeURIComponent).join('/')}`, {
      message, branch, content: Buffer.from(JSON.stringify(obj)).toString('base64'), ...(sha ? { sha } : {})
    });
    if (res.ok) return;
    if ((res.status === 409 || res.status === 422) && attempt < 5) {
      await new Promise(r => setTimeout(r, 400 * attempt + Math.random() * 600));
      sha = (await readJsonFile(p, branch)).sha;
      continue;
    }
    throw new Error(`writing ${p} failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }
}

// What kind of link is stored, without its secret parts — for the app's
// (encrypted) error message only, never the public log.
export function linkShape(url) {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/^\/calendar\/ical\/(\d+)\.ics$/);
    const params = [...u.searchParams.keys()].join(', ') || 'none';
    return m ? `${u.hostname}/calendar/ical/<${m[1].length}-digit listing>.ics, parameters: ${params}`
      : `${u.hostname}${u.pathname.replace(/\d{4,}/g, '<number>').slice(0, 60)} — this is not an Airbnb calendar EXPORT link (…/calendar/ical/<number>.ics?…)`;
  } catch { return 'not a valid web address'; }
}
const snippet = body => String(body || '').replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')
  .replace(/[A-Za-z0-9_-]{24,}/g, '…').replace(/\s+/g, ' ').trim().slice(0, 140);
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
async function fetchCalendar(url) {
  const get = ua => fetch(url, { headers: { 'User-Agent': ua, Accept: 'text/calendar,text/plain,*/*' }, signal: AbortSignal.timeout(25000) });
  let res = await get('Mozilla/5.0 (calendar-sync)');
  if (!res.ok) { await res.text().catch(() => ''); res = await get(BROWSER_UA); }   // some Airbnb edges refuse unusual agents
  return { res, body: await res.text() };
}

export async function main() {
  if (!key) { log('CALENDAR_SYNC_KEY is not set — calendar sync is not set up yet (docs/calendar-sync.md). Nothing to do.'); return 0; }
  if (!isCalendarKey(key)) { console.error('CALENDAR_SYNC_KEY is not a valid calendar key (copy it again from the app).'); return 1; }
  const srcPath = syncPath(dbPath, CALSYNC.sourcesFile), calPath = syncPath(dbPath, CALSYNC.calendarsFile);
  const src = await readJsonFile(srcPath, branch);
  if (!src.json) { log(`${srcPath} not found — open STR Daily Rates in the app once so it can share the calendar links.`); return 0; }
  let sources;
  try { sources = (await decryptCalendarJson(src.json, key, srcPath)).sources || []; }
  catch (e) { console.error(`Can't read ${srcPath}: ${e.message}. Make sure CALENDAR_SYNC_KEY matches the key shown in the app.`); return 1; }
  const prevFile = await readJsonFile(calPath, branch);
  let prev = { calendars: {} };
  if (prevFile.json) { try { prev = await decryptCalendarJson(prevFile.json, key, calPath); } catch (e) { log(`previous ${calPath} unreadable (${e.message}) — starting fresh`); } }

  const nowIso = new Date().toISOString(), today = nowIso.slice(0, 10);
  const next = {};
  const publicErrors = {};
  let failures = 0;
  for (const s of sources) {
    if (!s?.propertyId || !/^https:\/\//i.test(s.url || '')) continue;
    const before = prev.calendars?.[s.propertyId];
    let entry;
    // `error` (shown in the app, encrypted) can say what Airbnb answered and
    // what kind of link is stored; `publicError` (the public log) can't.
    let publicError = null;
    try {
      const { res, body } = await fetchCalendar(s.url);
      if (res.ok) {
        entry = applyFetchedCalendar(before, body, nowIso, today);
        if (entry.error) {
          publicError = /did not return a calendar/.test(entry.error) ? 'Airbnb did not return a calendar' : 'the calendar looked cut off — stored bookings kept';
          entry.error += ` — link: ${linkShape(s.url)}`;
        }
      } else {
        publicError = `Airbnb returned HTTP ${res.status}`;
        const said = snippet(body);
        entry = { blocks: before?.blocks || [], fetchedAt: before?.fetchedAt || null, attemptAt: nowIso,
          error: `Airbnb returned HTTP ${res.status}${said ? ` ("${said}")` : ''} — link: ${linkShape(s.url)}. Copy a fresh link from Airbnb → the listing → Availability → Export calendar.` };
      }
    } catch (e) {
      publicError = `could not reach Airbnb (${e.name === 'TimeoutError' ? 'timed out' : e.message})`;
      entry = { blocks: before?.blocks || [], fetchedAt: before?.fetchedAt || null, attemptAt: nowIso, error: publicError };
    }
    if (entry.error) failures++;
    next[s.propertyId] = entry;
    if (entry.error) publicErrors[s.propertyId] = publicError || 'failed';
    log(`${s.propertyId}: ${entry.error ? `FAILED — ${publicErrors[s.propertyId]}` : `${entry.blocks.length} block(s)`}`);
  }

  // Write when bookings or errors changed, or the heartbeat is due.
  const sig = cals => JSON.stringify(Object.entries(cals || {}).sort().map(([id, c]) => [id, c.blocks, c.error || null]));
  const heartbeatDue = !prev.checkedAt || Date.now() - Date.parse(prev.checkedAt) > CALSYNC.heartbeatHours * 3600e3;
  if (sig(next) !== sig(prev.calendars) || heartbeatDue) {
    const doc = { v: 1, checkedAt: nowIso, calendars: next };
    await writeJsonFile(calPath, await encryptCalendarJson(doc, key, calPath), prevFile.sha, 'Sync Airbnb calendars');
    log(`wrote ${calPath}`);
  } else log('no calendar changes');

  // Close newly booked nights in the published feed.
  let closedTotal = 0;
  const idx = await readJsonFile(`${FEED_REPO_DIR}/index.json`, 'rates-feed').catch(() => ({ json: null }));
  if (idx.json) {
    fs.mkdirSync(feedDir, { recursive: true });
    fs.writeFileSync(path.join(feedDir, 'index.json'), JSON.stringify(idx.json, null, 2));
    for (const entry of idx.json.properties || []) {
      const file = entry.file || `${entry.id}.json`;
      if (!/^[A-Za-z0-9_-]+\.json$/.test(file)) continue;
      const f = await readJsonFile(`${FEED_REPO_DIR}/${file}`, 'rates-feed');
      if (!f.json) continue;
      const blocks = next[entry.id]?.blocks || [];
      const { feed, closed } = closeBookedNights(f.json, blocks);
      if (closed) log(`${entry.id}: closed ${closed} newly booked night(s) in the feed`);
      closedTotal += closed;
      fs.writeFileSync(path.join(feedDir, file), JSON.stringify(feed, null, 2));
    }
  }
  output('feed_changed', closedTotal > 0 ? 'true' : 'false');
  if (closedTotal === 0 && fs.existsSync(feedDir)) fs.rmSync(feedDir, { recursive: true, force: true }); // nothing to publish

  if (failures) {
    // The repository (and so this log) is public: app ids and reasons only —
    // the app names the properties (STR Daily Rates, Needs attention).
    const failed = Object.entries(publicErrors).map(([id, e]) => `${id} (${e})`);
    console.log(`::error title=${failures} of ${Object.keys(next).length} Airbnb calendars not synced::${failed.join('; ')} — open STR Daily Rates in the app to see which properties these are.`);
    return 1;
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(code => process.exit(code), e => { console.error(e); process.exit(1); });
}
