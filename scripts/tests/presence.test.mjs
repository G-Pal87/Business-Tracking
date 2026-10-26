// Run with: node --test scripts/tests/*.test.mjs
// Checks that presence-branch files are only ever written encrypted, using
// an in-memory stand-in for the GitHub Contents API. Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Minimal browser globals the modules touch.
const store = new Map();
globalThis.localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k)
};
globalThis.document = { hidden: false, addEventListener() {}, getElementById: () => null, body: { prepend() {} } };
globalThis.window = { addEventListener() {} };
globalThis.location = { hash: '#analytics', reload() {} };

// Fake Contents API: path -> { sha, content (base64) }.
const files = new Map();
const puts = [];
let reads = 0, notModified = 0;
globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  const path = decodeURIComponent(u.pathname.replace(/^\/repos\/o\/r\/contents\//, ''));
  const json = (status, body, headers = {}) => ({
    status, ok: status >= 200 && status < 300,
    headers: { get: k => headers[k.toLowerCase()] ?? null },
    json: async () => body
  });
  if ((opts.method || 'GET') === 'GET') {
    reads++;
    const f = files.get(path);
    if (!f) return json(404, {});
    const etag = `"${f.sha}"`;
    if (opts.headers?.['If-None-Match'] === etag) { notModified++; return json(304, null, { etag }); }
    return json(200, { sha: f.sha, content: f.content }, { etag });
  }
  const body = JSON.parse(opts.body);
  const cur = files.get(path);
  if (cur && body.sha !== cur.sha) return json(409, {});
  const sha = `sha${puts.length + 1}`;
  files.set(path, { sha, content: body.content });
  puts.push({ path, message: body.message, branch: body.branch, content: body.content });
  return json(201, { content: { sha } });
};

const b64 = s => Buffer.from(s, 'utf8').toString('base64');
const unb64 = s => Buffer.from(s, 'base64').toString('utf8');

const { state } = await import('../../js/core/state.js');
const crypto = await import('../../js/core/crypto.js');
const presence = await import('../../js/core/presence.js');

state.github.owner = 'o';
state.github.repo = 'r';
state.github.token = 't';
state.session = { username: 'user1', name: 'User One', role: 'admin' };

test('nothing is written while the key is locked; failed logins wait without a username', async () => {
  assert.equal(crypto.isUnlocked(), false);
  assert.equal(await presence.recordSessionEvent('failed_login', { username: 'typed-secret', name: 'x' }), false);
  assert.equal(await presence.recordSessionEvent('login'), false);
  assert.equal(await presence.requestDisconnectOtherSessions(), false);
  assert.equal(puts.length, 0);
  const pending = JSON.parse(store.get('bt_pending_session_events'));
  assert.equal(pending.length, 1);
  assert.equal(pending[0].username, null);
  assert.ok(!JSON.stringify(pending).includes('typed-secret'));
});

test('writes are encrypted envelopes with a generic message, and queued failed logins are flushed', async () => {
  const { key } = await crypto.generateDataKey();
  crypto.setBootstrapDataKey(key);
  assert.ok(await presence.recordSessionEvent('login'));
  const last = puts.at(-1);
  assert.equal(last.path, 'data/session-history.json');
  assert.equal(last.branch, 'presence');
  assert.equal(last.message, 'Sync');
  const env = JSON.parse(unb64(last.content));
  assert.ok(crypto.isEncryptedEnvelope(env));
  assert.ok(!unb64(last.content).includes('User One'));
  const events = (await crypto.decryptEnvelopeToJson(env)).events;
  assert.deepEqual(events.map(e => e.type), ['failed_login', 'login']);
  assert.equal(events[0].username, null);
  assert.equal(events[1].name, 'User One');
  assert.equal(store.has('bt_pending_session_events'), false);
  const history = await presence.listSessionHistory();
  assert.equal(history.length, 2);
});

test('a plaintext file after encrypted ones were seen is ignored (not trusted) and rewritten encrypted', async () => {
  // This device already decrypted presence-branch files above, so a plain
  // JSON file can only have been written outside the app: its content is
  // ignored (it used to be read once as "legacy").
  files.set('data/session-history.json', {
    sha: 'legacy1',
    content: b64(JSON.stringify({ events: [{ type: 'failed_login', username: 'someone', name: 'Someone', at: 1 }] }))
  });
  const before = puts.length;
  const events = await presence.listSessionHistory();
  assert.equal(events.length, 0);
  // The rewrite runs in the background through the write queue.
  await new Promise(r => setTimeout(r, 50));
  assert.equal(puts.length, before + 1);
  const rewritten = files.get('data/session-history.json');
  const env = JSON.parse(unb64(rewritten.content));
  assert.ok(crypto.isEncryptedEnvelope(env));
  assert.ok(!unb64(rewritten.content).includes('someone'));
});

test('repeat reads send the ETag and reuse the cached copy on 304', async () => {
  await presence.listSessionHistory();
  const n = notModified;
  await presence.listSessionHistory();
  assert.equal(notModified, n + 1);
});

test('kill signals round-trip encrypted', async () => {
  assert.ok(await presence.killDevice('other-device'));
  const f = files.get('data/session-signal.json');
  const env = JSON.parse(unb64(f.content));
  assert.ok(crypto.isEncryptedEnvelope(env));
  const doc = await crypto.decryptEnvelopeToJson(env);
  assert.equal(doc.kills['other-device'].by, 'User One');
});

test('a plaintext session-signal file is never acted on (no kill/disconnect)', async () => {
  files.set('data/session-signal.json', {
    sha: 'plain-signal',
    content: b64(JSON.stringify({ disconnectAt: Date.now() + 60_000, issuedBy: 'attacker', kills: { [state.github.sessionId]: { at: Date.now() + 60_000, by: 'attacker' } } }))
  });
  // A kill written now goes through an encrypted rewrite that drops the plaintext content.
  assert.ok(await presence.killDevice('another-device'));
  const env = JSON.parse(unb64(files.get('data/session-signal.json').content));
  assert.ok(crypto.isEncryptedEnvelope(env));
  const doc = await crypto.decryptEnvelopeToJson(env);
  assert.equal(doc.disconnectAt, undefined);
  assert.equal(doc.issuedBy, undefined);
  assert.deepEqual(Object.keys(doc.kills), ['another-device']);
  assert.equal(state.github.disconnected || false, false);
});
