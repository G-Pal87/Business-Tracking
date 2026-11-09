// Activity log (per-record change history, data.js): local user edits through
// upsert / softDelete / restore are logged; setDb loads and sync merges are
// not; the log is capped; it merges as a plain {id} collection; logging
// doesn't invalidate unrelated caches. Synthetic inline data only.
// Run: node --test scripts/tests/*.test.mjs
import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.getComputedStyle = globalThis.getComputedStyle || (() => ({ getPropertyValue: () => '' }));
document.documentElement = document.documentElement || { style: {} };

const { state, setDb, dataRev, runBatch } = await import('../../js/core/state.js');
const data = await import('../../js/core/data.js');
const gh = await import('../../js/core/github.js');

const baseDb = () => ({
  properties: [{ id: 'p1', name: 'Flat A', type: 'long_term', currency: 'EUR' }],
  tenants: [{ id: 't1', name: 'Jo Tenant', propertyId: 'p1', status: 'active', monthlyRent: 900 }],
  payments: [{ id: 'pay1', propertyId: 'p1', tenantId: 't1', amount: 850, currency: 'EUR', date: '2026-03-12', status: 'paid', updatedAt: 1, createdAt: 1 }],
  expenses: [], vendors: [], invoices: [], users: []
});
const log = () => data.activityEntries();
function fresh() {
  setDb(baseDb());
  state.session = { userId: 'u1', username: 'anna', name: 'Anna', role: 'admin' };
}

test('create / update / delete / restore are logged with user, label and field diff', () => {
  fresh();
  data.upsert('payments', { id: 'pay2', propertyId: 'p1', amount: 100, currency: 'EUR', date: '2026-04-01' });
  let e = log()[0];
  assert.equal(e.action, 'create');
  assert.equal(e.by, 'Anna');
  assert.equal(e.collection, 'payments');
  assert.equal(e.recordId, 'pay2');
  assert.match(e.label, /^Payment 1 Apr 2026 · €100/);
  assert.ok(!Number.isNaN(Date.parse(e.at)));
  assert.equal(e.changes, undefined, 'creates stay compact');

  data.upsert('payments', { ...data.byId('payments', 'pay1'), amount: 900, notes: 'late' });
  e = log()[0];
  assert.equal(e.action, 'update');
  assert.equal(e.recordId, 'pay1');
  assert.equal(e.cur, 'EUR');
  assert.deepEqual(e.changes.map(c => c.field).sort(), ['amount', 'notes']);
  const amt = e.changes.find(c => c.field === 'amount');
  assert.equal(amt.from, 850); assert.equal(amt.to, 900);
  assert.ok(!e.changes.some(c => c.field === 'updatedAt' || c.field === 'updatedBy'), 'noise fields skipped');

  data.softDelete('payments', 'pay1');
  assert.equal(log()[0].action, 'delete');
  assert.equal(data.restoreRecord('payments', 'pay1'), true);
  assert.equal(log()[0].action, 'restore');
  data.softDelete('payments', 'pay1');
  data.restoreRecords([{ collection: 'payments', id: 'pay1' }]);
  const hist = data.activityEntries({ collection: 'payments', recordId: 'pay1' });
  assert.deepEqual(hist.map(x => x.action), ['restore', 'delete', 'restore', 'delete', 'update']);
});

test('saving without changes logs nothing; long values truncated; secrets hidden', () => {
  fresh();
  data.upsert('tenants', { ...data.byId('tenants', 't1') });
  assert.equal(log().length, 0);
  data.upsert('tenants', { ...data.byId('tenants', 't1'), notes: 'x'.repeat(500), passwordHash: 'abc' });
  const e = log()[0];
  const notes = e.changes.find(c => c.field === 'notes');
  assert.ok(notes.to.length <= 80);
  const pw = e.changes.find(c => c.field === 'passwordHash');
  assert.equal(pw.hidden, true); assert.equal(pw.to, null);
  assert.ok(!JSON.stringify(e).includes('abc'));
  assert.equal(e.label, 'Jo Tenant');
});

test('setDb loads and sync merges are never logged; internal collections are not logged', () => {
  fresh();
  setDb({ ...baseDb(), payments: [{ id: 'x', amount: 1 }] });
  assert.equal(log().length, 0);
  // A merge result adopted via setDb (what the sync paths do).
  const merged = gh.mergeDb({ ...baseDb(), payments: [{ id: 'y', amount: 2, updatedAt: 5 }] }, baseDb(), baseDb());
  setDb(merged);
  assert.equal(log().length, 0);
  data.upsert('syncConflicts', { id: 'c1' });
  assert.equal(log().length, 0);
  data.withoutActivityLog(() => data.upsert('payments', { id: 'z', amount: 3 }));
  assert.equal(log().length, 0);
});

test('cap: newest ACTIVITY_MAX_ENTRIES kept, entries older than the age limit dropped', () => {
  fresh();
  const now = Date.now();
  const old = now - (data.ACTIVITY_MAX_AGE_DAYS + 5) * 864e5;
  state.db.activityLog = [
    { id: 'a_old', createdAt: old, updatedAt: old, at: new Date(old).toISOString(), collection: 'payments', recordId: 'pay1', action: 'update' },
    ...Array.from({ length: 30 }, (_, i) => ({ id: `a${i}`, createdAt: now - 1000 + i, updatedAt: now - 1000 + i, at: '', collection: 'payments', recordId: 'pay1', action: 'update' }))
  ];
  const dropped = data.pruneActivityLog({ now, maxEntries: 20 });
  assert.equal(dropped, 11);
  assert.equal(state.db.activityLog.length, 20);
  assert.ok(!state.db.activityLog.some(e => e.id === 'a_old'));
  assert.equal(log()[0].id, 'a29');
  // Default cap enforced automatically while logging.
  fresh();
  runBatch(() => {
    for (let i = 0; i < data.ACTIVITY_MAX_ENTRIES + 300; i++) data.upsert('payments', { id: `b${i}`, amount: i, currency: 'EUR', date: '2026-01-01' });
  });
  assert.ok(state.db.activityLog.length <= data.ACTIVITY_MAX_ENTRIES + 250);
  data.pruneActivityLog();
  assert.equal(state.db.activityLog.length, data.ACTIVITY_MAX_ENTRIES);
});

test('logging does not bump other revisions or the log collection; bulk import stays fast and compact', () => {
  fresh();
  const vRev = dataRev('vendors');
  const before = data.listActive('expenses');
  data.upsert('payments', { id: 'q1', amount: 5, currency: 'EUR', date: '2026-01-01' });
  assert.equal(dataRev('vendors'), vRev);
  assert.equal(data.listActive('expenses'), before, 'unrelated active cache kept');
  fresh();
  const t0 = performance.now();
  runBatch(() => { for (let i = 0; i < 1000; i++) data.upsert('payments', { id: `imp${i}`, propertyId: 'p1', amount: 100 + i, currency: 'EUR', date: '2026-02-03', status: 'paid' }); });
  const ms = performance.now() - t0;
  assert.ok(ms < 1500, `1000 logged creates took ${ms.toFixed(0)}ms`);
  const bytes = JSON.stringify(state.db.activityLog).length / 1000;
  assert.ok(bytes < 400, `avg entry ${bytes.toFixed(0)} bytes`);
});

test('mergeDb treats the log as a plain {id} array: union of new entries, local prune propagates', () => {
  const e = (id, t) => ({ id, createdAt: t, updatedAt: t, at: '', collection: 'payments', recordId: 'p', action: 'update' });
  const base   = { activityLog: [e('a', 1), e('b', 2)] };
  const local  = { activityLog: [e('b', 2), e('l', 4)] };          // pruned 'a', added 'l'
  const remote = { activityLog: [e('a', 1), e('b', 2), e('r', 3)] }; // added 'r'
  const out = gh.mergeDb(remote, local, base);
  assert.deepEqual(out.activityLog.map(x => x.id).sort(), ['b', 'l', 'r']);
  const pending = gh.mergeLocalPending({ activityLog: [e('b', 2)] }, { activityLog: [e('b', 2), e('n', Date.now())], _syncedAt: Date.now() - 600_000 });
  assert.deepEqual(pending.activityLog.map(x => x.id).sort(), ['b', 'n']);
});

test('autoPurgeOldDeleted ignores log references to deleted records', () => {
  fresh();
  data.upsert('vendors', { id: 'v9', name: 'Gone' });
  data.softDelete('vendors', 'v9');
  data.byId('vendors', 'v9').deletedAt = Date.now() - 200 * 864e5;
  assert.equal(data.autoPurgeOldDeleted({ maxAgeDays: 90 }), 1);
  assert.equal(data.byId('vendors', 'v9'), undefined);
});

test('Change history switched off: nothing is logged; clearing empties it', () => {
  setDb(baseDb());
  data.upsert('properties', { id: 'pOn', name: 'Logged' });
  assert.equal(data.activityEntries().filter(e => e.recordId === 'pOn').length, 1);
  data.setActivityLogEnabled(false);
  assert.equal(data.activityLogEnabled(), false);
  data.upsert('properties', { id: 'pOff', name: 'Not logged' });
  data.upsert('properties', { id: 'pOn', name: 'Edited while off' });
  data.softDelete('properties', 'pOff');
  assert.equal(data.activityEntries().filter(e => e.recordId === 'pOff' || (e.recordId === 'pOn' && e.action !== 'create')).length, 0);
  data.setActivityLogEnabled(true);
  data.upsert('properties', { id: 'pOn', name: 'Edited again' });
  assert.ok(data.activityEntries().some(e => e.recordId === 'pOn' && e.action === 'update'));
  const n = data.activityEntries().length;
  assert.equal(data.clearActivityLog(), n);
  assert.equal(data.activityEntries().length, 0);
  assert.equal(data.clearActivityLog(), 0);
  // the records themselves are untouched
  assert.equal(data.byId('properties', 'pOn').name, 'Edited again');
});
