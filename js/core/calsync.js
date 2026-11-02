// Airbnb calendar sync through GitHub (docs/calendar-sync.md).
//
// Browsers can't read Airbnb calendar links (no CORS), so a scheduled GitHub
// workflow (.github/workflows/sync-calendars.yml → scripts/calendar-sync.mjs)
// fetches them server-side. The two sides talk through two files next to
// db.json on the data branch, both encrypted with a separate calendar key
// (settings.calendarSync.secretKey in the app, the CALENDAR_SYNC_KEY secret
// in GitHub) — never the data key:
//   ical-sources.json  written by the app:      { v, sources: [{ propertyId, url }] }
//   calendars.json     written by the workflow: { v, checkedAt, calendars: {
//                        propertyId: { blocks, fetchedAt, attemptAt, error } } }
// The workflow also closes newly booked nights in the public rates feed, so
// the website stays right while nobody has the app open.
//
// Shared by the app and the workflow script (Node 22): WebCrypto only.
import { parseICal, isCompleteICal, mergeBlocksChecked } from './ical.js';

export const CALSYNC = {
  sourcesFile: 'ical-sources.json',
  calendarsFile: 'calendars.json',
  event: 'calendar-sync',
  secretName: 'CALENDAR_SYNC_KEY',
  workflowFile: 'sync-calendars.yml',
  // The workflow rewrites calendars.json at least this often even when nothing
  // changed, so "last checked" stays meaningful; the app flags a property as
  // stale past STALE_HOURS (the workflow runs every 2 hours).
  heartbeatHours: 12,
  staleHours: 14
};

const subtle = () => globalThis.crypto.subtle;
const b64 = bytes => { let s = ''; for (const x of bytes) s += String.fromCharCode(x); return btoa(s); };
const unb64 = str => Uint8Array.from(atob(String(str)), c => c.charCodeAt(0));

export function dataDirOf(dbPath) {
  const p = String(dbPath || 'data/db.json');
  return p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
}
export const syncPath = (dbPath, file) => (dataDirOf(dbPath) ? `${dataDirOf(dbPath)}/${file}` : file);

export function generateCalendarKey() {
  return b64(globalThis.crypto.getRandomValues(new Uint8Array(32)));
}
export function isCalendarKey(k) {
  try { return unb64(String(k).trim()).length === 32; } catch { return false; }
}
// Short id of a key (base64 of the first 9 bytes of its SHA-256), stored as the
// envelope's `kid` so either side can tell a mismatched key from a broken file.
export async function calendarKeyId(keyB64) {
  const h = new Uint8Array(await subtle().digest('SHA-256', unb64(String(keyB64).trim())));
  return b64(h.slice(0, 9));
}
const importKey = keyB64 => subtle().importKey('raw', unb64(String(keyB64).trim()), 'AES-GCM', false, ['encrypt', 'decrypt']);

// The app's envelope format ({enc:1, iv, ct, kid, v}); the file path is bound
// in as additional data, so a file can't be swapped for another.
export async function encryptCalendarJson(obj, keyB64, aad) {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(aad) }, await importKey(keyB64), new TextEncoder().encode(JSON.stringify(obj)));
  return { enc: 1, iv: b64(iv), ct: b64(new Uint8Array(ct)), kid: await calendarKeyId(keyB64), v: 3 };
}
export async function decryptCalendarJson(env, keyB64, aad) {
  if (!env || env.enc !== 1 || !env.iv || !env.ct) throw new Error('not an encrypted calendar file');
  if (env.kid && env.kid !== await calendarKeyId(keyB64)) {
    const err = new Error('the calendar file was written with a different calendar key');
    err.code = 'KEY_MISMATCH';
    throw err;
  }
  const pt = await subtle().decrypt({ name: 'AES-GCM', iv: unb64(env.iv), additionalData: new TextEncoder().encode(aad) }, await importKey(keyB64), unb64(env.ct));
  return JSON.parse(new TextDecoder().decode(pt));
}

// One property's sync result from a fetched iCal body. Keeps the previous
// blocks (with an error) when the body isn't a complete calendar or looks cut
// off (mergeBlocksChecked) — a bad response never wipes bookings.
export function applyFetchedCalendar(prev, body, nowIso, today) {
  const base = { blocks: prev?.blocks || [], fetchedAt: prev?.fetchedAt || null, attemptAt: nowIso };
  if (!isCompleteICal(body)) return { ...base, error: 'Airbnb did not return a calendar (check the calendar link)' };
  const fresh = parseICal(body).filter(e => e.start && e.end).map(e => ({ start: e.start, end: e.end, uid: e.uid || '', summary: e.summary || '' }));
  const { blocks, refused } = mergeBlocksChecked(prev?.blocks, fresh, today);
  if (refused) return { ...base, error: refused };
  return { blocks, fetchedAt: nowIso, attemptAt: nowIso, error: null };
}

// Nights covered by any block (DTEND exclusive), as YYYY-MM-DD.
export function blockedNights(blocks) {
  const set = new Set();
  for (const b of blocks || []) {
    if (!b.start || !b.end) continue;
    const d = new Date(`${b.start}T00:00:00Z`), end = new Date(`${b.end}T00:00:00Z`);
    for (let i = 0; d < end && i < 800; i++, d.setUTCDate(d.getUTCDate() + 1)) set.add(d.toISOString().slice(0, 10));
  }
  return set;
}

// Closes, in a published property feed (docs/daily-rates-feed.md), the open
// nights Airbnb now shows as booked or blocked: status 'unavailable', price
// fields dropped (an unavailable night never carries an amount). Nights are
// only closed, never reopened — a reopened night needs the app's pricing.
const PRICE_FIELDS = ['basis', 'originalAmount', 'discountPct', 'amount', 'airbnbCheckout'];
export function closeBookedNights(feed, blocks) {
  const nights = blockedNights(blocks);
  let closed = 0;
  const rates = (feed.rates || []).map(r => {
    if (r.status !== 'open' || !nights.has(r.date)) return r;
    closed++;
    const out = { ...r, status: 'unavailable' };
    for (const k of PRICE_FIELDS) delete out[k];
    return out;
  });
  return { feed: closed ? { ...feed, rates } : feed, closed };
}

// A property's sync state for flags: 'ok' | 'error' | 'stale' | 'never'.
export function syncState(entry, now = Date.now()) {
  if (!entry || !entry.fetchedAt) return entry?.error ? 'error' : 'never';
  if (entry.error) return 'error';
  const ref = Date.parse(entry.checkedAt || entry.attemptAt || entry.fetchedAt);
  return now - ref > CALSYNC.staleHours * 3600e3 ? 'stale' : 'ok';
}
