import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
const cs = await import('../../js/core/calsync.js');

const ICS = (events, end = true) => ['BEGIN:VCALENDAR', 'VERSION:2.0',
  ...events.flatMap(([uid, s, e, sum]) => ['BEGIN:VEVENT', `UID:${uid}`, `DTSTART;VALUE=DATE:${s.replace(/-/g, '')}`, `DTEND;VALUE=DATE:${e.replace(/-/g, '')}`, `SUMMARY:${sum || 'Reserved'}`, 'END:VEVENT']),
  ...(end ? ['END:VCALENDAR'] : [])].join('\r\n');

test('calendar key: generate, validate, encrypt/decrypt bound to the path and the key', async () => {
  const k = cs.generateCalendarKey(), k2 = cs.generateCalendarKey();
  assert.ok(cs.isCalendarKey(k)); assert.ok(!cs.isCalendarKey('nope')); assert.notEqual(k, k2);
  const env = await cs.encryptCalendarJson({ hello: 'világ' }, k, 'data/calendars.json');
  assert.deepEqual(Object.keys(env), ['enc', 'iv', 'ct', 'kid', 'v']);       // the app's envelope shape, "enc" first
  assert.equal(env.enc, 1); assert.equal(env.v, 3);
  assert.deepEqual(await cs.decryptCalendarJson(env, k, 'data/calendars.json'), { hello: 'világ' });
  await assert.rejects(cs.decryptCalendarJson(env, k2, 'data/calendars.json'), e => e.code === 'KEY_MISMATCH');
  await assert.rejects(cs.decryptCalendarJson(env, k, 'data/ical-sources.json'));   // swapped file: AAD differs
  assert.equal(cs.syncPath('data/db.json', 'calendars.json'), 'data/calendars.json');
  assert.equal(cs.syncPath('db.json', 'calendars.json'), 'calendars.json');
});

test('applyFetchedCalendar: complete feed → blocks; broken or cut-off → keeps the old ones with an error', () => {
  const now = '2026-11-02T10:00:00.000Z', today = '2026-11-02';
  const ok = cs.applyFetchedCalendar(null, ICS([['a', '2026-11-10', '2026-11-12'], ['b', '2026-12-01', '2026-12-05', 'Airbnb (Not available)']]), now, today);
  assert.equal(ok.error, null); assert.equal(ok.fetchedAt, now); assert.equal(ok.blocks.length, 2);
  const cut = cs.applyFetchedCalendar(ok, ICS([['a', '2026-11-10', '2026-11-12']], false), now, today);
  assert.match(cut.error, /did not return a calendar/); assert.equal(cut.blocks.length, 2);
  const html = cs.applyFetchedCalendar(ok, '<html>error</html>', now, today);
  assert.ok(html.error); assert.equal(html.blocks.length, 2);
  // most upcoming bookings vanished at once → refused, old blocks kept
  const prev = { blocks: [['x1', '2026-11-20', '2026-11-22'], ['x2', '2026-12-10', '2026-12-12'], ['x3', '2027-01-10', '2027-01-12'], ['x4', '2027-02-10', '2027-02-12']].map(([uid, start, end]) => ({ uid, start, end, summary: 'Reserved' })), fetchedAt: 'old' };
  const drop = cs.applyFetchedCalendar(prev, ICS([['x1', '2026-11-20', '2026-11-22']]), now, today);
  assert.ok(drop.error); assert.equal(drop.blocks.length, 4); assert.equal(drop.fetchedAt, 'old');
});

test('closeBookedNights: open nights now booked become unavailable without prices; nothing is reopened', () => {
  const feed = { schema: 'str-daily-rates/v1', rates: [
    { date: '2026-11-10', currency: 'EUR', status: 'open', basis: 'target', amount: 100, originalAmount: 110, discountPct: 9, airbnbCheckout: 130 },
    { date: '2026-11-11', currency: 'EUR', status: 'open', amount: 100 },
    { date: '2026-11-12', currency: 'EUR', status: 'open', amount: 100 },
    { date: '2026-11-13', currency: 'EUR', status: 'unavailable' }
  ] };
  const { feed: out, closed } = cs.closeBookedNights(feed, [{ start: '2026-11-10', end: '2026-11-12' }]);   // nights 10, 11
  assert.equal(closed, 2);
  assert.deepEqual(out.rates[0], { date: '2026-11-10', currency: 'EUR', status: 'unavailable' });
  assert.deepEqual(out.rates[2], feed.rates[2]);                // checkout day stays open
  assert.deepEqual(out.rates[3], feed.rates[3]);
  assert.equal(cs.closeBookedNights(out, []).closed, 0);         // empty calendar never reopens
});

test('syncState: ok / error / stale / never', () => {
  const now = Date.parse('2026-11-02T12:00:00Z');
  assert.equal(cs.syncState(null, now), 'never');
  assert.equal(cs.syncState({ fetchedAt: '2026-11-02T10:00:00Z' }, now), 'ok');
  assert.equal(cs.syncState({ fetchedAt: '2026-11-02T10:00:00Z', error: 'x' }, now), 'error');
  assert.equal(cs.syncState({ fetchedAt: '2026-11-01T10:00:00Z', checkedAt: '2026-11-01T10:00:00Z' }, now), 'stale');
  assert.equal(cs.syncState({ fetchedAt: '2026-11-01T10:00:00Z', checkedAt: '2026-11-02T09:00:00Z' }, now), 'ok');
});
