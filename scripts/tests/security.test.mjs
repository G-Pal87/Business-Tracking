// Run with: node --test scripts/tests/*.test.mjs
// Rollback guard (db `_rev`), AES-GCM path binding (AAD) for db.json and
// attachments, token-at-rest handling, config validation and the PBKDF2
// upgrade — against an in-memory stand-in for the GitHub Contents API.
// Synthetic data only.
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
let shaSeq = 0;
globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url, 'https://pages.example/');
  const res = (status, body, headers = {}) => ({
    status, ok: status >= 200 && status < 300,
    headers: { get: k => headers[k.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body)
  });
  if (!u.pathname.startsWith('/repos/o/r/contents/')) return res(404, {});
  const path = decodeURIComponent(u.pathname.replace(/^\/repos\/o\/r\/contents\//, ''));
  const method = opts.method || 'GET';
  const f = files.get(path);
  if (method === 'GET') {
    if (!f) return res(404, {});
    return res(200, { sha: f.sha, content: f.content, type: 'file' }, { etag: `W/"e-${f.sha}"` });
  }
  if (method === 'DELETE') { files.delete(path); return res(200, {}); }
  const body = JSON.parse(opts.body);
  if (f && !body.sha) return res(422, { message: '"sha" wasn\'t supplied.' });
  if (f && body.sha !== f.sha) return res(409, { message: 'does not match' });
  if (!f && body.sha) return res(409, { message: 'does not match' });
  const sha = `sha${++shaSeq}`;
  files.set(path, { sha, content: body.content });
  return res(f ? 200 : 201, { content: { sha } });
};

const DB = 'data/db.json';
async function setRemoteEnvelope(env) {
  files.set(DB, { sha: `sha${++shaSeq}`, content: b64(JSON.stringify(env)) });
}
async function setRemote(db, opts = { aad: cr.DB_ENVELOPE_AAD }) {
  await setRemoteEnvelope(await cr.encryptJsonToEnvelope(db, opts));
}
const remoteEnvelope = () => JSON.parse(unb64(files.get(DB).content));
const readRemote = () => cr.decryptEnvelopeToJson(remoteEnvelope());

function freshDevice() {
  gh.clearConfig();
  gh._resetLocationStateForTests();
  state.github.owner = 'o';
  state.github.repo = 'r';
  state.github.token = 't';
  state.github.branch = 'main';
  state.github.dbPath = DB;
  state.github.remoteDb = null;
  files.clear();
}

const { key } = await cr.generateDataKey();
cr.setBootstrapDataKey(key);

const baseDb = (extra = {}) => ({ payments: [{ id: 'a', createdAt: T, updatedAt: T }], settings: { x: 1 }, _tombstones: {}, ...extra });

// ── rollback guard ───────────────────────────────────────────────────────────

test('first use: a db without _rev is accepted, and the first push writes _rev 1 (v3 envelope)', async () => {
  freshDevice();
  await setRemote(baseDb(), {}); // legacy envelope (no AAD, no _rev)
  assert.equal(remoteEnvelope().v, undefined);
  setDb(await gh.fetchDb());
  assert.equal(gh.seenDbRev(), 0);
  state.db.payments.push({ id: 'b', createdAt: T + 1, updatedAt: T + 1 });
  state.dirty = true;
  await gh.pushDb('t');
  const env = remoteEnvelope();
  assert.equal(env.v, 3);
  assert.deepEqual(Object.keys(env).sort(), ['ct', 'enc', 'iv', 'kid', 'v']); // no new envelope fields
  const remote = await readRemote();
  assert.equal(remote._rev, 1);
  assert.equal(gh.seenDbRev(), 1);
});

test('rollback: an older db.json (same key) is refused by fetchDb and by push; remote not overwritten', async () => {
  freshDevice();
  await setRemote(baseDb({ _rev: 4 }));
  const oldEnv = remoteEnvelope(); // e.g. a copy from history / a backup's `data`
  setDb(await gh.fetchDb());
  state.db.payments.push({ id: 'b', createdAt: T + 1, updatedAt: T + 1 });
  state.dirty = true;
  await gh.pushDb('t');
  assert.equal((await readRemote())._rev, 5);

  await setRemoteEnvelope(oldEnv); // attacker with the token PUTs the old copy back
  const shaAfterAttack = files.get(DB).sha;
  await assert.rejects(gh.fetchDb(), e => e.code === 'DB_ROLLBACK');
  await assert.rejects(gh.fetchDb({ conditional: true }), e => e.code === 'DB_ROLLBACK');

  state.db.payments.push({ id: 'c', createdAt: T + 2, updatedAt: T + 2 });
  state.dirty = true;
  await assert.rejects(gh.pushDb('t'), e => e.code === 'DB_ROLLBACK');
  assert.equal(files.get(DB).sha, shaAfterAttack, 'nothing pushed over the rolled-back file');
  // A db without any _rev, once a rev was seen, is a rollback too.
  await setRemote(baseDb(), {});
  await assert.rejects(gh.fetchDb(), e => e.code === 'DB_ROLLBACK');
});

test('restore: allowDbRollbackForRestore lets the restored data go over a rolled-back remote, numbered above everything seen', async () => {
  freshDevice();
  await setRemote(baseDb({ _rev: 9 }));
  const oldEnv = await cr.encryptJsonToEnvelope(baseDb({ _rev: 3 }), { aad: cr.DB_ENVELOPE_AAD });
  setDb(await gh.fetchDb());
  assert.equal(gh.seenDbRev(), 9);
  await setRemoteEnvelope(oldEnv);
  // What Settings → Restore does: stamp the rev, allow the one push, push.
  const restored = structuredClone(state.db);
  restored.payments = [{ id: 'r1', createdAt: T, updatedAt: Date.now(), restoredAt: Date.now() }];
  restored._rev = gh.nextDbRev();
  assert.ok(restored._rev > 9);
  gh.allowDbRollbackForRestore();
  setDb(restored);
  state.dirty = true;
  await gh.pushDb('restore');
  const remote = await readRemote();
  assert.ok(remote._rev > 9);
  assert.ok(remote.payments.some(p => p.id === 'r1'));
  // The override is one-shot.
  await setRemoteEnvelope(oldEnv);
  state.dirty = true;
  await assert.rejects(gh.pushDb('t'), e => e.code === 'DB_ROLLBACK');
});

test('concurrent pushes: a push that loses the race (409) merges and writes a higher rev; both edits survive', async () => {
  freshDevice();
  await setRemote(baseDb({ _rev: 1 }));
  setDb(await gh.fetchDb());
  // Another device pushes rev 2 with its own record (what its doPushDb writes).
  const other = await readRemote();
  other.payments.push({ id: 'other', createdAt: T + 3, updatedAt: T + 3 });
  other._rev = 2;
  await setRemote(other);
  // This device pushes from its cached sha: push-first PUT → 409 → GET + merge.
  state.db.payments.push({ id: 'mine', createdAt: T + 4, updatedAt: T + 4 });
  state.dirty = true;
  await gh.pushDb('t');
  const remote = await readRemote();
  assert.equal(remote._rev, 3);
  assert.deepEqual(remote.payments.map(p => p.id).sort(), ['a', 'mine', 'other']);
  assert.equal(gh.seenDbRev(), 3);
  // And the next push from here keeps increasing.
  state.db.payments.push({ id: 'mine2', createdAt: T + 5, updatedAt: T + 5 });
  state.dirty = true;
  await gh.pushDb('t');
  assert.equal((await readRemote())._rev, 4);
});

test('_rev is merge metadata: never a conflict, remote value kept by mergeDb/resyncDb', () => {
  const base = { payments: [], settings: { a: 1 }, _rev: 3 };
  const merged = gh.mergeDb({ payments: [], settings: { a: 1 }, _rev: 5 }, { payments: [], settings: { a: 1 }, _rev: 2 }, base);
  assert.equal(merged._rev, 5);
  assert.equal(merged._newConflicts, undefined);
  const r = gh.resyncDb({ payments: [], _rev: 7 }, { payments: [], _rev: 4 });
  assert.equal(r._rev, 7);
});

// ── AAD / legacy formats ─────────────────────────────────────────────────────

test('legacy envelopes (no v, gzip v2) still decrypt; v3 is bound to the db name', async () => {
  const obj = { hello: 'world', n: [1, 2, 3] };
  const legacy = await cr.encryptJsonToEnvelope(obj);
  assert.equal(legacy.v, undefined);
  assert.deepEqual(await cr.decryptEnvelopeToJson(legacy), obj);
  const gz = await cr.encryptJsonToEnvelope(obj, { compress: true });
  assert.equal(gz.v, 2);
  assert.deepEqual(await cr.decryptEnvelopeToJson(gz), obj);
  const v3 = await cr.encryptJsonToEnvelope(obj, { aad: cr.DB_ENVELOPE_AAD, compress: true });
  assert.equal(v3.v, 3);
  assert.equal(v3.z, 'gzip');
  assert.deepEqual(await cr.decryptEnvelopeToJson(v3), obj); // default AAD = db name (backup restore path)
  assert.ok(await cr.canDecryptWith(key, v3));
  await assert.rejects(cr.decryptEnvelopeToJson(v3, { aad: 'data/other.json' }));
  // A legacy envelope relabelled v3 (attacker can't recompute the tag) fails.
  await assert.rejects(cr.decryptEnvelopeToJson({ ...legacy, v: 3 }));
});

test('legacy BTX1 containers (no AAD) still decrypt via the path-bound fetch', async () => {
  freshDevice();
  const plain = new TextEncoder().encode('%PDF-synthetic-legacy');
  const container = await cr.encryptBytes(plain); // old format: no AAD
  files.set('invoices/legacy.pdf', { sha: 's-l', content: Buffer.from(container).toString('base64') });
  const got = await gh.fetchGithubFileEncrypted('invoices/legacy.pdf');
  assert.equal(Buffer.from(got.content, 'base64').toString(), '%PDF-synthetic-legacy');
});

test('uploadGithubBytesEncrypted binds to the path: a container swapped to another path fails to decrypt', async () => {
  freshDevice();
  await setRemote(baseDb()); // db.json present (attachment writes check it isn't missing)
  const a = new TextEncoder().encode('synthetic file A');
  const b = new TextEncoder().encode('synthetic file B');
  await gh.uploadGithubBytesEncrypted('Clients/x/a.bin', a, 'Upload', { assumeNew: true });
  await gh.uploadGithubBytesEncrypted('/Clients/x/b.bin', b, 'Upload');
  assert.ok(gh.isEncryptedUpload(files.get('Clients/x/a.bin').content));
  assert.equal(Buffer.from((await gh.fetchGithubFileEncrypted('Clients/x/a.bin')).content, 'base64').toString(), 'synthetic file A');
  // Attacker with the token puts A's container at B's path.
  files.set('Clients/x/b.bin', { ...files.get('Clients/x/a.bin'), sha: 'swapped' });
  await assert.rejects(gh.fetchGithubFileEncrypted('Clients/x/b.bin'), e => e.code === 'DECRYPT_FAILED');
  // Locked: refused before anything is uploaded.
  cr.lockOnLogout();
  await assert.rejects(gh.uploadGithubBytesEncrypted('Clients/x/c.bin', a, 'Upload'), e => e.code === 'NO_ENC_KEY');
  assert.equal(files.has('Clients/x/c.bin'), false);
  cr.setBootstrapDataKey(key);
  await assert.rejects(gh.uploadGithubBytesEncrypted('Clients/x/c.bin', 'not bytes', 'Upload'), TypeError);
});

test('a raw re-upload to another path (rename/backup copy) is re-encrypted for the new path, or refused', async () => {
  freshDevice();
  await setRemote(baseDb());
  await gh.uploadGithubBytesEncrypted('invoices/old.pdf', new TextEncoder().encode('synthetic pdf'), 'Upload');
  const fetched = await gh.fetchGithubFile('invoices/old.pdf');
  await gh.uploadGithubFile('invoices/new.pdf', fetched.content.replace(/\s/g, ''), 'Update file');
  assert.equal(Buffer.from((await gh.fetchGithubFileEncrypted('invoices/new.pdf')).content, 'base64').toString(), 'synthetic pdf');
  // A bound container from an unknown source can't be made readable → refused, nothing written.
  const foreign = await cr.encryptBytes(new TextEncoder().encode('x'), { aad: 'somewhere/else.bin' });
  await assert.rejects(gh.uploadGithubFile('invoices/other.pdf', Buffer.from(foreign).toString('base64'), 'Update file'), e => e.code === 'AAD_MISMATCH');
  assert.equal(files.has('invoices/other.pdf'), false);
});

test('isEncryptedUpload: structural check on the head only', () => {
  assert.equal(gh.isEncryptedUpload(b64('plain text, definitely not encrypted')), false);
  assert.equal(gh.isEncryptedUpload(Buffer.from('BTX1short').toString('base64')), false);
  const big = new Uint8Array(4 + 12 + 5000); big.set([0x42, 0x54, 0x58, 0x31]);
  assert.equal(gh.isEncryptedUpload(Buffer.from(big).toString('base64').replace(/(.{60})/g, '$1\n')), true);
});

// ── token at rest ────────────────────────────────────────────────────────────

test('a token saved while locked is never written to localStorage in plain form; encrypted on unlock', async () => {
  freshDevice();
  cr.lockOnLogout();
  await gh.saveConfig({ owner: 'o', repo: 'r', branch: 'main', dbPath: DB, token: 'ghp_SYNTHETIC1' });
  const cfg = JSON.parse(localStorage.getItem('bt_github_config'));
  assert.equal(cfg.token, undefined);
  assert.equal(cfg.tokenEnc, undefined);
  assert.equal(sessionStorage.getItem('bt_pending_token'), 'ghp_SYNTHETIC1');
  // Survives a reload of this tab (loadConfig), before sign-in.
  state.github.token = '';
  gh.loadConfig();
  assert.equal(state.github.token, 'ghp_SYNTHETIC1');
  // Sign-in unlocks → stored encrypted, pending copy dropped.
  cr.setBootstrapDataKey(key);
  await gh.adoptStoredToken();
  const after = JSON.parse(localStorage.getItem('bt_github_config'));
  assert.equal(after.token, undefined);
  assert.ok(after.tokenEnc);
  assert.equal(sessionStorage.getItem('bt_pending_token'), null);
  assert.ok(!localStorage.getItem('bt_github_config').includes('SYNTHETIC1'));
  state.github.token = '';
  gh.loadConfig();
  await gh.adoptStoredToken();
  assert.equal(state.github.token, 'ghp_SYNTHETIC1');
});

test('an existing plaintext token (older version) keeps working locked, and is migrated on unlock', async () => {
  freshDevice();
  localStorage.setItem('bt_github_config', JSON.stringify({ owner: 'o', repo: 'r', branch: 'main', path: DB, token: 'ghp_LEGACY2' }));
  cr.lockOnLogout();
  gh.loadConfig();
  assert.equal(state.github.token, 'ghp_LEGACY2');
  await gh.saveConfig({ owner: 'o', repo: 'r', branch: 'main', dbPath: DB }); // a locked write keeps it
  assert.equal(JSON.parse(localStorage.getItem('bt_github_config')).token, 'ghp_LEGACY2');
  cr.setBootstrapDataKey(key);
  await gh.adoptStoredToken();
  const cfg = JSON.parse(localStorage.getItem('bt_github_config'));
  assert.equal(cfg.token, undefined);
  assert.ok(cfg.tokenEnc);
  assert.equal(state.github.token, 'ghp_LEGACY2');
});

// ── config validation ────────────────────────────────────────────────────────

test('saveConfig / applyDbConfig validate owner, repo, branch and path', () => {
  freshDevice();
  assert.equal(gh.validateLocation({ owner: 'some-org', repo: 'my.repo_1', branch: 'data', dbPath: 'data/db.json' }), null);
  for (const bad of [
    { owner: 'o/../x', repo: 'r' }, { owner: 'o', repo: 'r?ref=x' }, { owner: 'o', repo: '..' },
    { owner: 'o', repo: 'r', branch: '../main' }, { owner: 'o', repo: 'r', dbPath: '../secrets.json' },
    { owner: 'o', repo: 'r', dbPath: 'data/db.txt' }
  ]) {
    assert.ok(gh.validateLocation(bad), JSON.stringify(bad));
    assert.throws(() => gh.saveConfig(bad), e => e.code === 'INVALID_CONFIG');
  }
  assert.equal(state.github.owner, 'o'); // nothing changed by the refused saves
  gh.applyDbConfig({ owner: 'o', repo: 'r', branch: 'x/../y', path: 'data/db.json?x' });
  assert.equal(state.github.branch, 'main');
  assert.equal(state.github.dbPath, DB);
});

// ── PBKDF2 upgrade ───────────────────────────────────────────────────────────

test('keys wrapped at 300k iterations unlock and are re-wrapped at 600k', async () => {
  assert.equal(cr.PBKDF2_ITERATIONS, 600000);
  cr.lockOnLogout();
  for (const k of ['bt_enc_wrap_salt', 'bt_enc_wrapped_key', 'bt_enc_wrap_iter', 'bt_enc_wrapped_prev_keys']) localStorage.removeItem(k);
  // Simulate a device set up by the previous version: data key wrapped at 300k.
  const pw = 'synthetic-password-1';
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const km = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveKey']);
  const wk = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 300000, hash: 'SHA-256' }, km, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, wk, raw));
  const B = u => Buffer.from(u).toString('base64');
  localStorage.setItem('bt_enc_wrap_salt', B(salt));
  localStorage.setItem('bt_enc_wrapped_key', JSON.stringify({ iv: B(iv), ct: B(ct) }));
  localStorage.setItem('bt_enc_wrap_iter', '300000');
  const before = localStorage.getItem('bt_enc_wrapped_key');
  await cr.unlockOnLogin(pw);
  assert.equal(cr.isUnlocked(), true);
  assert.equal(localStorage.getItem('bt_enc_wrap_iter'), '600000');
  assert.notEqual(localStorage.getItem('bt_enc_wrapped_key'), before); // re-wrapped
  assert.equal(await cr.exportActiveDataKeyBase64(), B(raw));
  const kid = await cr.activeKeyId();
  cr.lockOnLogout();
  await cr.unlockOnLogin(pw, { proceed: Promise.resolve(true) });
  assert.equal(await cr.activeKeyId(), kid);
  assert.equal(await cr.exportActiveDataKeyBase64(), B(raw));
  cr.lockOnLogout();
  assert.equal(await cr.unlockOnLogin('wrong-password', { proceed: Promise.resolve(false) }), false);
  assert.equal(cr.isUnlocked(), false);
  cr.setBootstrapDataKey(key);
});

test('push-first: a cached copy below the floor (old bytes put back on GitHub) is never written over', async () => {
  freshDevice();
  await setRemote(baseDb({ _rev: 10 }));
  setDb(await gh.fetchDb());
  const old = files.get(DB);
  // This device later accepts rev 11 with another record (e.g. in another tab)…
  const r11 = baseDb({ _rev: 11 });
  r11.payments.push({ id: 'from-rev11', createdAt: T + 7, updatedAt: T + 7 });
  await setRemote(r11);
  await gh.fetchDb({ conditional: false });
  assert.equal(gh.seenDbRev(), 11);
  // …then the exact old blob is put back (same sha as this tab's cache).
  files.set(DB, old);
  setDb(await (async () => { const d = structuredClone(state.db); d.payments.push({ id: 'mine', createdAt: T + 8, updatedAt: T + 8 }); return d; })());
  state.dirty = true;
  await assert.rejects(gh.pushDb('t'), e => e.code === 'DB_ROLLBACK');
  assert.equal((await readRemote())._rev, 10, 'remote untouched');
});

test('restore by a device that saw a LOWER revision is still accepted by a device that saw a higher one', async () => {
  // Device C saw rev 20.
  freshDevice();
  await setRemote(baseDb({ _rev: 20 }));
  await gh.fetchDb();
  const seenMap = localStorage.getItem('bt_db_rev_seen');
  // Device R (saw only 15) restores over a remote rolled back to 5.
  freshDevice();
  await setRemote(baseDb({ _rev: 15 }));
  setDb(await gh.fetchDb());
  await setRemote(baseDb({ _rev: 5 }));
  const restored = structuredClone(state.db);
  restored.payments = [{ id: 'restored', createdAt: T, updatedAt: Date.now(), restoredAt: Date.now() }];
  restored._rev = gh.nextDbRev();
  gh.allowDbRollbackForRestore();
  setDb(restored);
  state.dirty = true;
  await gh.pushDb('restore');
  const pushedRev = (await readRemote())._rev;
  assert.ok(pushedRev > 20);
  // Back on device C (its seen-rev record restored): the restored data is accepted.
  const remoteFile = files.get(DB);
  freshDevice();
  files.set(DB, remoteFile);
  localStorage.setItem('bt_db_rev_seen', seenMap);
  const db = await gh.fetchDb();
  assert.ok(db.payments.some(p => p.id === 'restored'));
});

test('forgetDbRevision: a device stuck on DB_ROLLBACK can accept GitHub\'s copy after confirming', async () => {
  freshDevice();
  await setRemote(baseDb({ _rev: 9 }));
  await gh.fetchDb();
  await setRemote(baseDb({ _rev: 3 }));
  await assert.rejects(gh.fetchDb(), e => e.code === 'DB_ROLLBACK');
  gh.forgetDbRevision();
  const db = await gh.fetchDb();
  assert.equal(db._rev, 3);
  assert.equal(gh.seenDbRev(), 3);
});
