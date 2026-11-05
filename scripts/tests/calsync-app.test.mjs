import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
const { setDb, state } = await import('../../js/core/state.js');
const data = await import('../../js/core/data.js');
const cs = await import('../../js/core/calsync.js');
const app = await import('../../js/modules/calsync-app.js');

const KEY = cs.generateCalendarKey();
const load = (calendarSync = { secretKey: KEY }) => {
  setDb({
    settings: { calendarSync },
    properties: [
      { id: 's1', name: 'Beach', type: 'short_term', airbnbCalUrl: 'https://www.airbnb.test/calendar/ical/1.ics?s=x' },
      { id: 's2', name: 'Pool', type: 'short_term', airbnbCalUrl: 'https://www.airbnb.test/calendar/ical/2.ics?s=y' },
      { id: 's3', name: 'No link', type: 'short_term' }
    ],
    strCalendars: [{ id: 'c1', propertyId: 's1', url: 'https://www.airbnb.test/calendar/ical/1.ics?s=x', importedAt: '2026-08-10', blocks: [{ uid: 'old', start: '2026-08-01', end: '2026-08-03', summary: 'Reserved' }] }]
  });
  Object.assign(state.github, { owner: 'o', repo: 'r', branch: 'data', dbPath: 'data/db.json', token: '' });
};
const now = new Date().toISOString();

test('applySyncedCalendars: new bookings merged in, sync time and errors recorded, unchanged → no write', () => {
  load();
  const doc = { v: 1, checkedAt: now, calendars: {
    s1: { blocks: [{ uid: 'old', start: '2026-08-01', end: '2026-08-03', summary: 'Reserved' }, { uid: 'new', start: '2026-12-01', end: '2026-12-04', summary: 'Reserved' }], fetchedAt: now, error: null },
    s2: { blocks: [], fetchedAt: null, error: 'Airbnb returned HTTP 410 (is the calendar link still valid?)' },
    ghost: { blocks: [], fetchedAt: now }
  } };
  assert.equal(app.applySyncedCalendars(doc), 2);
  const c1 = data.listActive('strCalendars').find(c => c.propertyId === 's1');
  assert.deepEqual(c1.blocks.map(b => b.uid).sort(), ['new', 'old']);
  assert.equal(c1.importedAt, now.slice(0, 10)); assert.equal(c1.syncedAt, now); assert.equal(c1.syncError, null);
  const c2 = data.listActive('strCalendars').find(c => c.propertyId === 's2');
  assert.match(c2.syncError, /HTTP 410/);
  assert.equal(app.applySyncedCalendars(doc), 0);       // same file again → nothing to write
});

test('status per property and the problems list (set up / failing / stale)', () => {
  load({});
  assert.deepEqual(app.calendarSyncProblems().map(p => p.kind), ['off']);
  assert.equal(app.propertySyncStatus('s1').state, 'off');
  load();
  assert.equal(app.propertySyncStatus('s1').state, 'never');
  const old = new Date(Date.now() - 20 * 3600e3).toISOString();
  app.applySyncedCalendars({ checkedAt: old, calendars: { s1: { blocks: [], fetchedAt: old }, s2: { blocks: [], fetchedAt: now, error: 'boom' } } });
  assert.equal(app.propertySyncStatus('s1').state, 'stale');
  assert.equal(app.propertySyncStatus('s2').state, 'error');
  const probs = app.calendarSyncProblems();
  assert.deepEqual(probs.map(p => [p.kind, p.prop.id]), [['stale', 's1'], ['error', 's2']]);   // s3 has no link → not listed
  app.applySyncedCalendars({ checkedAt: now, calendars: { s1: { blocks: [], fetchedAt: now }, s2: { blocks: [], fetchedAt: now, error: null } } });
  assert.deepEqual(app.calendarSyncProblems(), []);
});

test('pullSyncedCalendars: off / waiting / key mismatch / ok', async () => {
  const realFetch = globalThis.fetch;
  let file = null;
  globalThis.fetch = async url => {
    if (!String(url).includes('/contents/data/calendars.json')) return { ok: false, status: 404, json: async () => ({}) };
    if (!file) return { ok: false, status: 404, headers: { get: () => null }, json: async () => ({}) };
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ sha: 's', content: Buffer.from(JSON.stringify(file)).toString('base64') }) };
  };
  try {
    load({});
    assert.equal((await app.pullSyncedCalendars()).state, 'off');
    load();
    assert.equal((await app.pullSyncedCalendars()).state, 'waiting');
    file = await cs.encryptCalendarJson({ v: 1, checkedAt: now, calendars: {} }, cs.generateCalendarKey(), 'data/calendars.json');
    assert.equal((await app.pullSyncedCalendars()).state, 'keyMismatch');
    file = await cs.encryptCalendarJson({ v: 1, checkedAt: now, calendars: { s2: { blocks: [{ uid: 'z', start: '2026-12-10', end: '2026-12-11' }], fetchedAt: now, error: null } } }, KEY, 'data/calendars.json');
    const r = await app.pullSyncedCalendars();
    assert.equal(r.state, 'ok'); assert.equal(r.checkedAt, now);
    assert.deepEqual(data.listActive('strCalendars').find(c => c.propertyId === 's2').blocks.map(b => b.uid), ['z']);
  } finally { globalThis.fetch = realFetch; }
});

test('a replaced Airbnb link is the one shared and stored (not the old one kept with the calendar)', () => {
  load();
  data.upsert('properties', { ...data.byId('properties', 's1'), airbnbCalUrl: 'https://www.airbnb.test/calendar/ical/1.ics?s=NEW' });
  const now2 = new Date().toISOString();
  app.applySyncedCalendars({ checkedAt: now2, calendars: { s1: { blocks: [], fetchedAt: now2 } } });
  assert.equal(data.listActive('strCalendars').find(c => c.propertyId === 's1').url, 'https://www.airbnb.test/calendar/ical/1.ics?s=NEW');
});

test('calendarSyncTick asks GitHub for a run when the last check is over an hour old (not more than every 30 min)', async () => {
  const realFetch = globalThis.fetch;
  const dispatches = [];
  let file = null;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.endsWith('/dispatches') && opts.method === 'POST') { dispatches.push(JSON.parse(opts.body).event_type); return { ok: true, status: 204, headers: { get: () => null }, json: async () => ({}) }; }
    if (u.includes('/contents/data/calendars.json') && file) return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ sha: 's', content: Buffer.from(JSON.stringify(file)).toString('base64') }) };
    return { ok: false, status: 404, headers: { get: () => null }, json: async () => ({}), text: async () => '' };
  };
  try {
    load();
    state.github.token = 't';
    const fresh = new Date(Date.now() - 20 * 60e3).toISOString();
    file = await cs.encryptCalendarJson({ v: 1, checkedAt: fresh, calendars: { s1: { blocks: [], fetchedAt: fresh } } }, KEY, 'data/calendars.json');
    await app.calendarSyncTick();
    assert.deepEqual(dispatches, []);                         // checked 20 min ago → nothing to do
    const old = new Date(Date.now() - 8 * 3600e3).toISOString();
    file = await cs.encryptCalendarJson({ v: 1, checkedAt: old, calendars: { s1: { blocks: [], fetchedAt: old }, s2: { blocks: [], fetchedAt: old } } }, KEY, 'data/calendars.json');
    await app.calendarSyncTick();
    await new Promise(r => setTimeout(r, 20));
    assert.deepEqual(dispatches, ['calendar-sync']);          // 8 h old → asked for a run
    assert.equal(app.autoRunInProgress(), true);
    assert.equal(app.propertySyncStatus('s1').state, 'checking');   // not flagged while the run is under way
    assert.deepEqual(app.calendarSyncProblems(), []);
    await app.calendarSyncTick();
    assert.deepEqual(dispatches, ['calendar-sync']);          // not again within 30 minutes
  } finally { globalThis.fetch = realFetch; state.github.token = ''; }
});
