import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';

const gh = await import('../../js/core/github.js');
const cr = await import('../../js/core/crypto.js');
const { state } = await import('../../js/core/state.js');

const T = Date.now() - 60_000;

test('merge3 merges arrays of {id} objects per entry', () => {
  const base   = [{ id: 'a', n: 1 }];
  const local  = [{ id: 'a', n: 1 }, { id: 'b', n: 2 }];
  const remote = [{ id: 'a', n: 1 }, { id: 'c', n: 3 }];
  const out = gh.merge3(base, local, remote);
  assert.deepEqual(out.map(x => x.id).sort(), ['a', 'b', 'c']);
});

test('merge3 id arrays: removal on one side sticks unless edited on the other', () => {
  const base = [{ id: 'a', n: 1 }, { id: 'b', n: 1 }];
  assert.deepEqual(gh.merge3(base, [{ id: 'a', n: 1 }], [{ id: 'a', n: 1 }, { id: 'b', n: 1 }]).map(x => x.id), ['a']);
  assert.deepEqual(gh.merge3(base, [{ id: 'a', n: 1 }], [{ id: 'a', n: 1 }, { id: 'b', n: 2 }]).map(x => x.id).sort(), ['a', 'b']);
});

test('resyncDb keeps a record created elsewhere just before the last sync (Y1)', () => {
  const local  = { payments: [{ id: 'a', updatedAt: T }], _syncedAt: T + 11, _tombstones: {} };
  const remote = { payments: [{ id: 'a', updatedAt: T }, { id: 'new', updatedAt: T + 10 }], _tombstones: {} };
  assert.ok(gh.resyncDb(remote, local).payments.some(p => p.id === 'new'));
});

test('resyncDb still drops tombstoned records', () => {
  const local  = { payments: [{ id: 'a', updatedAt: T }], _syncedAt: T + 11, _tombstones: { 'payments:x': T + 5 } };
  const remote = { payments: [{ id: 'a', updatedAt: T }, { id: 'x', updatedAt: T }], _tombstones: {} };
  assert.ok(!gh.resyncDb(remote, local).payments.some(p => p.id === 'x'));
});

test('mergeLocalPending keeps new remote records and pushes unpushed tombstones', () => {
  const remote = { payments: [{ id: 'a', updatedAt: T }, { id: 'new', updatedAt: T + 10 }, { id: 'x', updatedAt: T }], _tombstones: {} };
  const local  = { payments: [{ id: 'a', updatedAt: T }], _syncedAt: T + 11, _tombstones: { 'payments:x': T + 5 } };
  const m = gh.mergeLocalPending(remote, local);
  assert.ok(m.payments.some(p => p.id === 'new'));
  assert.ok(!m.payments.some(p => p.id === 'x'));
  assert.equal(m._hasLocalChanges, true);
});

test('mergeDb: only-local edit wins even when its clock is behind (Y2)', () => {
  const base   = { payments: [{ id: 'a', v: 0, updatedAt: T + 1000 }] };
  const remote = { payments: [{ id: 'a', v: 0, updatedAt: T + 1000 }] };
  const local  = { payments: [{ id: 'a', v: 1, updatedAt: T + 500 }] }; // slow clock
  const out = gh.mergeDb(remote, local, base);
  assert.equal(out.payments[0].v, 1);
});

test('mergeDb: concurrent edit keeps the later one and records the other (Y3)', () => {
  const base   = { payments: [{ id: 'a', v: 0, updatedAt: T }], other: [{ id: 'o', updatedAt: T }] };
  const remote = { payments: [{ id: 'a', v: 'remote', updatedAt: T + 20 }], other: [{ id: 'o', updatedAt: T }] };
  const local  = { payments: [{ id: 'a', v: 'local', updatedAt: T + 10 }], other: [{ id: 'o', updatedAt: T }, { id: 'o2', updatedAt: T + 5 }] };
  const out = gh.mergeDb(remote, local, base);
  assert.equal(out.payments[0].v, 'remote');
  assert.ok(out.other.some(x => x.id === 'o2'), 'unrelated edits still merge');
  assert.equal(out.syncConflicts.length, 1);
  assert.equal(out.syncConflicts[0].lostVersion.v, 'local');
  assert.equal(out._newConflicts.length, 1);
  assert.ok(!Object.keys(out).includes('_newConflicts'), 'never serialised');
});

test('isEncryptedUpload is structural', () => {
  const b64 = s => Buffer.from(s).toString('base64');
  const iv = Buffer.alloc(12, 1).toString('base64');
  const ct = Buffer.alloc(40, 2).toString('base64');
  assert.equal(gh.isEncryptedUpload(b64(JSON.stringify({ enc: 1, iv, ct, kid: 'k' }))), true);
  assert.equal(gh.isEncryptedUpload(b64(JSON.stringify({ enc: 1, iv, ct, payments: [] }))), false);
  assert.equal(gh.isEncryptedUpload(b64(JSON.stringify({ enc: 1, iv: '', ct: '' }))), false);
  assert.equal(gh.isEncryptedUpload(b64('BTX1')), false);
  assert.equal(gh.isEncryptedUpload(Buffer.concat([Buffer.from('BTX1'), Buffer.alloc(40, 3)]).toString('base64')), true);
  assert.equal(gh.isEncryptedUpload(b64('{"plain":true}')), false);
});

test('journal round-trip: unpushed edits survive and apply only when newer (T2/Y5)', async () => {
  const { key } = await cr.generateDataKey();
  cr.setBootstrapDataKey(key);
  const base = { payments: [{ id: 'a', v: 0, updatedAt: T }], settings: { x: 1 }, _tombstones: {} };
  const db   = { payments: [{ id: 'a', v: 1, updatedAt: T + 5 }, { id: 'b', v: 1, updatedAt: T + 6 }], settings: { x: 2 }, _tombstones: { 'payments:z': T + 7 } };
  const j = gh.computeJournal(db, base);
  assert.equal(j.records.payments.length, 2);
  assert.deepEqual(j.plain.settings, { x: 2 });
  localStorage.setItem('bt_pending_other-tab', JSON.stringify(await cr.encryptJsonToEnvelope(j)));
  const target = { payments: [{ id: 'a', v: 0, updatedAt: T }, { id: 'z', updatedAt: T }], settings: { x: 1 }, _tombstones: {} };
  const n = await gh.applyPendingJournals(target);
  assert.ok(n >= 3);
  assert.equal(target.payments.find(p => p.id === 'a').v, 1);
  assert.ok(target.payments.some(p => p.id === 'b'));
  assert.ok(!target.payments.some(p => p.id === 'z'));
  assert.deepEqual(target.settings, { x: 2 });
  // An older journal copy never overwrites a newer record.
  const newer = { payments: [{ id: 'a', v: 9, updatedAt: T + 100 }], _tombstones: {} };
  await gh.applyPendingJournals(newer);
  assert.equal(newer.payments.find(p => p.id === 'a').v, 9);
  localStorage.removeItem('bt_pending_other-tab');
  assert.equal(gh.computeJournal(base, base), null);
});

test('cache is only ever written encrypted', async () => {
  state.dirty = false;
  gh.saveLocalCache({ payments: [{ id: 'p', guestName: 'Sample', updatedAt: T }], settings: {} });
  await gh.flushLocalCache();
  const raw = localStorage.getItem('bt_db_cache');
  assert.ok(raw, 'cache written');
  assert.ok(!raw.includes('Sample'));
  assert.equal(JSON.parse(raw).enc, 1);
  cr.lockOnLogout();
  assert.equal(await gh.fetchLocalDb(), null, 'locked: not readable yet');
  assert.equal(gh.hasPendingEncryptedCache(), true);
});
