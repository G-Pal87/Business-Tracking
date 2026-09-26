// Run with: node --test scripts/tests/*.test.mjs
// db.json push path (push-first with sha, fallback GET + 3-way merge on
// conflict), shared read-only snapshot isolation, and the base64 helpers —
// against an in-memory stand-in for the GitHub Contents API. Synthetic data only.
import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';

const gh = await import('../../js/core/github.js');
const cr = await import('../../js/core/crypto.js');
const { state, setDb } = await import('../../js/core/state.js');

const T = Date.now() - 60_000;
const b64 = s => Buffer.from(s, 'utf8').toString('base64');
const unb64 = s => Buffer.from(s, 'base64').toString('utf8');

// Fake Contents API: path -> { sha, content (base64) }.
const files = new Map();
const log = [];
let shaSeq = 0;
globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  const path = decodeURIComponent(u.pathname.replace(/^\/repos\/o\/r\/contents\//, ''));
  const method = opts.method || 'GET';
  log.push({ method, path });
  const res = (status, body, headers = {}) => ({
    status, ok: status >= 200 && status < 300,
    headers: { get: k => headers[k.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body)
  });
  const f = files.get(path);
  if (method === 'GET') {
    if (!f) return res(404, {});
    const etag = `W/"etag-${f.sha}"`;
    if (opts.headers?.['If-None-Match'] === etag) return res(304, null, { etag });
    return res(200, { sha: f.sha, content: f.content }, { etag });
  }
  const body = JSON.parse(opts.body);
  if (f && !body.sha) return res(422, { message: '"sha" wasn\'t supplied.' });
  if (f && body.sha !== f.sha) return res(409, { message: 'does not match' });
  if (!f && body.sha) return res(409, { message: 'does not match' });
  const sha = `sha${++shaSeq}`;
  files.set(path, { sha, content: body.content });
  return res(201, { content: { sha } });
};

async function setRemote(db) {
  const env = await cr.encryptJsonToEnvelope(db);
  files.set('data/db.json', { sha: `sha${++shaSeq}`, content: b64(JSON.stringify(env)) });
}
async function readRemote() {
  return cr.decryptEnvelopeToJson(JSON.parse(unb64(files.get('data/db.json').content)));
}
const since = n => log.slice(n);

state.github.owner = 'o';
state.github.repo = 'r';
state.github.token = 't';
state.github.branch = 'main';
state.github.dbPath = 'data/db.json';

const { key } = await cr.generateDataKey();
cr.setBootstrapDataKey(key);

test('first push after a fetch PUTs directly with the known sha (no GET)', async () => {
  await setRemote({ payments: [{ id: 'a', v: 0, updatedAt: T }], settings: { x: 1 }, _tombstones: {} });
  setDb(await gh.fetchDb());
  state.db.payments.push({ id: 'b', v: 1, createdAt: T + 5, updatedAt: T + 5 });
  state.dirty = true;
  const n = log.length;
  await gh.pushDb('test');
  assert.deepEqual(since(n).map(r => r.method), ['PUT']);
  const remote = await readRemote();
  assert.deepEqual(remote.payments.map(p => p.id).sort(), ['a', 'b']);
});

test('push-first on a stale sha falls back to GET + 3-way merge and keeps both sides', async () => {
  // Another device writes: edits settings.y and adds record c.
  const other = await readRemote();
  other.payments.push({ id: 'c', v: 'other', createdAt: T + 6, updatedAt: T + 6 });
  other.settings = { ...other.settings, y: 2 };
  other._mtimes = { ...(other._mtimes || {}), settings: Date.now() + 1000 };
  await setRemote(other);
  // This tab adds d and edits a.
  state.db.payments.push({ id: 'd', v: 1, createdAt: T + 7, updatedAt: T + 7 });
  state.db.payments.find(p => p.id === 'a').v = 'local';
  state.db.payments.find(p => p.id === 'a').updatedAt = T + 8;
  const n = log.length;
  await gh.pushDb('test');
  assert.deepEqual(since(n).map(r => r.method), ['PUT', 'GET', 'PUT'], '409 on the optimistic PUT, then the normal path');
  const remote = await readRemote();
  assert.deepEqual(remote.payments.map(p => p.id).sort(), ['a', 'b', 'c', 'd']);
  assert.equal(remote.payments.find(p => p.id === 'a').v, 'local');
  assert.equal(remote.settings.y, 2, "the other device's settings edit survives");
  // Adopted remote record is in state.db and in the id index.
  assert.ok(state.db.payments.some(p => p.id === 'c'));
  assert.equal(state._ix.get('payments').get('c').v, 'other');
  assert.equal(state.db.settings.y, 2, 'untouched plain field brought in');
});

test('in-place edits of state.db never reach the merge base / sha cache', async () => {
  const base = state.github.remoteDb;
  const baseC = base.payments.find(p => p.id === 'c');
  state.db.payments.find(p => p.id === 'c').v = 'mutated';
  state.db.settings.x = 99;
  assert.equal(baseC.v, 'other');
  assert.equal(base.settings.x, 1);
  assert.notEqual(state.db.payments.find(p => p.id === 'c'), baseC);
  // Undo, so later pushes don't carry the scribbles.
  state.db.payments.find(p => p.id === 'c').v = 'other';
  state.db.settings.x = 1;
});

test('fetchDb hands unconditional callers their own copy; resyncDb never leaks the shared one', async () => {
  const a = await gh.fetchDb();
  const b = await gh.fetchDb();
  assert.notEqual(a, b);
  assert.notEqual(a, state.github.remoteDb);
  a.settings.x = 'scribble';
  assert.equal(state.github.remoteDb.settings.x, 1);
  // Conditional poll (ETag known after the fetches above) → 304.
  const polled = await gh.fetchDb({ conditional: true });
  assert.equal(state.github.lastFetchUnchanged, true);
  const before = JSON.stringify(polled);
  const local = structuredClone(state.db);
  local._mtimes = { settings: 0 };
  local.settings = { x: 'older' };
  const synced = gh.resyncDb(polled, local);
  assert.notEqual(synced.settings, polled.settings, 'remote plain value is copied, not shared');
  synced.settings.x = 'edited';
  assert.equal(JSON.stringify(polled), before, 'input untouched');
});

test('push with nothing new after a push still works push-first', async () => {
  const n = log.length;
  await gh.pushDb('noop');
  assert.deepEqual(since(n).map(r => r.method), ['PUT']);
  await gh.flushLocalCache();
});

test('base64 helpers match Buffer exactly, across chunk boundaries', () => {
  for (const len of [0, 1, 2, 3, 0x7fff, 0x8000, 0x8001, 100_003]) {
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = (i * 131 + 7) & 0xff;
    const enc = cr.bytesToBase64(bytes);
    assert.equal(enc, Buffer.from(bytes).toString('base64'), `encode ${len}`);
    assert.deepEqual(cr.base64ToBytes(enc), bytes, `decode ${len}`);
  }
});

test('encrypted upload: assumeNew PUTs without a lookup; an existing file falls back to sha lookup', async () => {
  const content = Buffer.from(Array.from({ length: 70_000 }, (_, i) => i & 0xff)).toString('base64');
  let n = log.length;
  await gh.uploadGithubFileEncrypted('documents/new.bin', content, 'Update file', { assumeNew: true });
  assert.deepEqual(since(n).map(r => r.method), ['PUT']);
  n = log.length;
  await gh.uploadGithubFileEncrypted('documents/new.bin', content, 'Update file', { assumeNew: true });
  assert.deepEqual(since(n).map(r => r.method), ['PUT', 'GET', 'PUT']);
  n = log.length;
  await gh.uploadGithubFileEncrypted('documents/new.bin', content, 'Update file');
  assert.deepEqual(since(n).map(r => r.method), ['GET', 'PUT'], 'default: unchanged lookup-then-PUT');
  const back = await gh.fetchGithubFileEncrypted('documents/new.bin');
  assert.equal(back.content, content, 'round-trips byte-exact');
  const stored = Buffer.from(files.get('documents/new.bin').content, 'base64');
  assert.equal(stored.subarray(0, 4).toString(), 'BTX1', 'stored encrypted');
});

test('uploads still refuse plaintext', async () => {
  await assert.rejects(gh.uploadGithubFile('documents/plain.txt', b64('hello'), 'x', { assumeNew: true }), e => e.code === 'NO_ENC_KEY');
});
