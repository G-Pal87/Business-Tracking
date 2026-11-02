import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const cs = await import('../../js/core/calsync.js');

// A fake GitHub contents API (data branch + rates-feed branch) and fake Airbnb calendars.
const KEY = cs.generateCalendarKey();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'calsync-'));
const files = new Map();             // `${ref}:${path}` → { text, sha }
let shaN = 0;
const put = (ref, p, obj) => files.set(`${ref}:${p}`, { text: JSON.stringify(obj), sha: `sha${++shaN}` });
const writes = [];
const airbnb = new Map();            // url → { status, body } | 'throw'
const ICS = evs => ['BEGIN:VCALENDAR', ...evs.flatMap(([u, s, e]) => ['BEGIN:VEVENT', `UID:${u}`, `DTSTART;VALUE=DATE:${s.replace(/-/g, '')}`, `DTEND;VALUE=DATE:${e.replace(/-/g, '')}`, 'SUMMARY:Reserved', 'END:VEVENT']), 'END:VCALENDAR'].join('\r\n');
globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  const res = (status, body) => ({ ok: status < 300, status, json: async () => JSON.parse(body), text: async () => body });
  if (u.hostname === 'api.github.test') {
    const m = u.pathname.match(/^\/repos\/o\/r\/contents\/(.+)$/);
    const p = decodeURIComponent(m[1]);
    if ((opts.method || 'GET') === 'GET') {
      const f = files.get(`${u.searchParams.get('ref')}:${p}`);
      return f ? res(200, JSON.stringify({ sha: f.sha, content: Buffer.from(f.text).toString('base64') })) : res(404, '{}');
    }
    const body = JSON.parse(opts.body);
    const cur = files.get(`${body.branch}:${p}`);
    if ((cur?.sha || undefined) !== body.sha) return res(409, 'sha mismatch');
    writes.push({ path: p, branch: body.branch });
    files.set(`${body.branch}:${p}`, { text: Buffer.from(body.content, 'base64').toString('utf8'), sha: `sha${++shaN}` });
    return res(200, '{}');
  }
  const a = airbnb.get(url);
  if (!a || a === 'throw') throw new TypeError('fetch failed');
  return res(a.status, a.body);
};
Object.assign(process.env, { CALENDAR_SYNC_KEY: KEY, GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r', DATA_BRANCH: 'data', DB_PATH: 'data/db.json',
  GITHUB_API: 'https://api.github.test', FEED_DIR: path.join(tmp, 'feed'), GITHUB_OUTPUT: path.join(tmp, 'out') });
const { main } = await import('../../scripts/calendar-sync.mjs');
const readCal = async () => cs.decryptCalendarJson(JSON.parse(files.get('data:data/calendars.json').text), KEY, 'data/calendars.json');
const output = () => fs.readFileSync(process.env.GITHUB_OUTPUT, 'utf8');

const U1 = 'https://www.airbnb.test/calendar/ical/1.ics?s=x', U2 = 'https://www.airbnb.test/calendar/ical/2.ics?s=y';
const today = new Date().toISOString().slice(0, 10);
const day = n => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

test('no sources file yet → nothing to do (exit 0)', async () => {
  assert.equal(await main(), 0);
  assert.equal(writes.length, 0);
});

test('fetches every property, writes encrypted calendars.json, closes booked nights in the feed', async () => {
  put('data', 'data/ical-sources.json', await cs.encryptCalendarJson({ v: 1, sources: [{ propertyId: 'p1', url: U1 }, { propertyId: 'p2', url: U2 }] }, KEY, 'data/ical-sources.json'));
  airbnb.set(U1, { status: 200, body: ICS([['booking-uid-b1@airbnb', day(3), day(5)]]) });
  airbnb.set(U2, { status: 200, body: ICS([]) });
  put('rates-feed', 'exports/daily-rates/index.json', { schema: 'str-daily-rates-index/v1', properties: [{ id: 'p1', file: 'p1.json' }, { id: 'p2', file: 'p2.json' }] });
  const nights = [0, 1, 2, 3, 4, 5, 6].map(n => ({ date: day(n), currency: 'EUR', status: 'open', amount: 100, basis: 'target' }));
  put('rates-feed', 'exports/daily-rates/p1.json', { schema: 'str-daily-rates/v1', rates: nights });
  put('rates-feed', 'exports/daily-rates/p2.json', { schema: 'str-daily-rates/v1', rates: nights });
  assert.equal(await main(), 0);
  const envText = files.get('data:data/calendars.json').text;
  assert.match(envText, /^\{"enc":1,"iv":/);                       // encrypted envelope, nothing readable
  // (a long, distinctive marker: 2-character strings turn up in random ciphertext by chance)
  assert.ok(!envText.includes('booking-uid-b1') && !envText.includes(day(3)));
  const cal = await readCal();
  assert.deepEqual(cal.calendars.p1.blocks.map(b => b.uid), ['booking-uid-b1@airbnb']);
  assert.equal(cal.calendars.p1.error, null); assert.ok(cal.calendars.p1.fetchedAt);
  assert.deepEqual(cal.calendars.p2.blocks, []);
  assert.match(output(), /feed_changed=true/);
  const f1 = JSON.parse(fs.readFileSync(path.join(process.env.FEED_DIR, 'p1.json'), 'utf8'));
  assert.deepEqual(f1.rates.map(r => r.status), ['open', 'open', 'open', 'unavailable', 'unavailable', 'open', 'open']);
  assert.ok(!('amount' in f1.rates[3]) && !('basis' in f1.rates[3]));
  assert.ok(fs.existsSync(path.join(process.env.FEED_DIR, 'p2.json')) && fs.existsSync(path.join(process.env.FEED_DIR, 'index.json')));  // whole feed tree for the single-commit publish
});

test('nothing changed → no rewrite (heartbeat not due), feed untouched', async () => {
  const before = writes.length;
  fs.writeFileSync(process.env.GITHUB_OUTPUT, '');
  // the published feed now has the closed nights (as after the publish step)
  const f1 = JSON.parse(files.get('rates-feed:exports/daily-rates/p1.json').text);
  put('rates-feed', 'exports/daily-rates/p1.json', cs.closeBookedNights(f1, (await readCal()).calendars.p1.blocks).feed);
  assert.equal(await main(), 0);
  assert.equal(writes.length, before);
  assert.match(output(), /feed_changed=false/);
  assert.ok(!fs.existsSync(process.env.FEED_DIR));
});

test('a calendar that fails is flagged (exit 1), keeps its last bookings; the others still sync', async () => {
  airbnb.set(U1, { status: 410, body: 'Gone' });
  airbnb.set(U2, { status: 200, body: ICS([['n1', day(1), day(2)]]) });
  const logged = [], realLog = console.log;
  console.log = (...a) => { logged.push(a.join(' ')); };
  try { assert.equal(await main(), 1); } finally { console.log = realLog; }
  const errLine = logged.find(l => l.startsWith('::error'));
  assert.match(errLine, /^::error title=1 of 2 Airbnb calendars not synced::p1 \(Airbnb returned HTTP 410/);
  assert.ok(!/airbnb\.test|ical/.test(errLine));            // the public log never shows a calendar link
  const cal = await readCal();
  assert.match(cal.calendars.p1.error, /HTTP 410/);
  assert.deepEqual(cal.calendars.p1.blocks.map(b => b.uid), ['booking-uid-b1@airbnb']);
  assert.deepEqual(cal.calendars.p2.blocks.map(b => b.uid), ['n1']);
  airbnb.set(U1, 'throw');
  assert.equal(await main(), 1);
  assert.match((await readCal()).calendars.p1.error, /could not reach Airbnb/);
});

test('wrong key in the secret → clear error (exit 1), nothing written', async () => {
  const before = writes.length;
  put('data', 'data/ical-sources.json', await cs.encryptCalendarJson({ v: 1, sources: [] }, cs.generateCalendarKey(), 'data/ical-sources.json'));
  assert.equal(await main(), 1);
  assert.equal(writes.length, before);
});
