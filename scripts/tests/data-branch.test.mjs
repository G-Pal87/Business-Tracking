// Run with: node --test scripts/tests/*.test.mjs
// Data-branch move (docs/data-branch.md): fetchDb's 404 → bootstrap-config
// follow, the pin that keeps applyDbConfig from switching back, pushes that
// must never re-create db.json on the old branch, and the bootstrap config
// written to the Pages branch. In-memory, branch-aware stand-in for the
// GitHub Contents API and the Pages-hosted data/github-config.json.
// Synthetic data only.
import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';

const gh = await import('../../js/core/github.js');
const cr = await import('../../js/core/crypto.js');
const { state, setDb } = await import('../../js/core/state.js');

const b64 = s => Buffer.from(s, 'utf8').toString('base64');
const unb64 = s => Buffer.from(s, 'base64').toString('utf8');
const T = Date.now() - 60_000;

// ── fake GitHub ──────────────────────────────────────────────────────────────
let branches, commits, tips, log, seq, bootstrap, bootstrapReads, forceGetStatus, putMissingWithSha;
function reset() {
  branches = new Map();          // branch -> Map(path -> { sha, content })
  commits = new Map();           // commit sha -> Map(path -> file) snapshot
  tips = new Map();              // branch -> commit sha
  log = [];
  seq = 0;
  bootstrap = null;              // object served as data/github-config.json, or null (404)
  bootstrapReads = 0;
  forceGetStatus = null;         // e.g. 401: every db.json GET answers this
  putMissingWithSha = '409';     // what a PUT with a sha does when the file is missing: '409' | 'create'
}
function commit(branch) {
  const c = `c${++seq}`;
  commits.set(c, new Map(branches.get(branch)));
  const parent = tips.get(branch);
  tips.set(branch, c);
  return { sha: c, parents: parent ? [{ sha: parent }] : [] };
}
function put(branch, path, content) {
  if (!branches.has(branch)) branches.set(branch, new Map());
  const sha = `b${++seq}`;
  branches.get(branch).set(path, { sha, content });
  return { sha, commit: commit(branch) };
}
const res = (status, body, headers = {}) => ({
  status, ok: status >= 200 && status < 300,
  headers: { get: k => headers[k.toLowerCase()] ?? null },
  json: async () => body,
  text: async () => JSON.stringify(body)
});
globalThis.fetch = async (url, opts = {}) => {
  if (!/^https?:/.test(url)) {
    // Relative URL: the Pages-hosted bootstrap config.
    assert.equal(url, 'data/github-config.json');
    assert.equal(opts.cache, 'no-store');
    bootstrapReads++;
    return bootstrap ? res(200, structuredClone(bootstrap)) : res(404, {});
  }
  const u = new URL(url);
  const m = u.pathname.match(/^\/repos\/o\/r\/contents\/(.+)$/);
  assert.ok(m, `unexpected URL ${url}`);
  const path = decodeURIComponent(m[1]);
  const method = opts.method || 'GET';
  if (method === 'GET') {
    const ref = u.searchParams.get('ref');
    log.push({ method, path, ref });
    if (forceGetStatus && path.endsWith('db.json')) return res(forceGetStatus, {});
    const tree = commits.has(ref) ? commits.get(ref) : branches.get(ref);
    const f = tree?.get(path);
    if (!f) return res(404, {});
    return res(200, { sha: f.sha, content: f.content }, { etag: `W/"${f.sha}"` });
  }
  const body = JSON.parse(opts.body);
  log.push({ method, path, ref: body.branch });
  const tree = branches.get(body.branch);
  if (!tree) return res(404, { message: 'Branch not found' });
  const f = tree.get(path);
  if (method === 'DELETE') {
    if (!f) return res(404, {});
    if (body.sha !== f.sha) return res(409, {});
    tree.delete(path);
    return res(200, { commit: commit(body.branch) });
  }
  if (f && !body.sha) return res(422, { message: '"sha" wasn\'t supplied.' });
  if (f && body.sha !== f.sha) return res(409, { message: 'does not match' });
  if (!f && body.sha && putMissingWithSha === '409') return res(409, { message: 'does not match' });
  const { sha, commit: c } = put(body.branch, path, body.content);
  return res(f ? 200 : 201, { content: { sha }, commit: c });
};

async function setRemote(branch, db, path = 'data/db.json') {
  const env = await cr.encryptJsonToEnvelope(db);
  return put(branch, path, b64(JSON.stringify(env)));
}
async function readRemote(branch, path = 'data/db.json') {
  const f = branches.get(branch)?.get(path);
  return f ? cr.decryptEnvelopeToJson(JSON.parse(unb64(f.content))) : null;
}
function removeRemote(branch, path) {
  branches.get(branch).delete(path);
  commit(branch);
}
const storedCfg = () => JSON.parse(localStorage.getItem('bt_github_config') || '{}');

const { key } = await cr.generateDataKey();
cr.setBootstrapDataKey(key);

// Fresh device state for each test: configured for o/r on main.
function device(branch = 'main') {
  reset();
  gh.clearConfig();
  gh._resetLocationStateForTests();
  state.github.owner = 'o';
  state.github.repo = 'r';
  state.github.token = 't';
  state.github.branch = branch;
  state.github.dbPath = 'data/db.json';
  state.github.remoteDb = null;
}
const dbWith = (branch, extra = {}) => ({
  payments: [{ id: 'a', v: 0, updatedAt: T }],
  settings: { x: 1 },
  appConfig: { github: { owner: 'o', repo: 'r', branch, path: 'data/db.json' } },
  _tombstones: {},
  ...extra
});

// ── fetchDb follow ───────────────────────────────────────────────────────────

test('dormant: db.json on main is read as before, the bootstrap config is never consulted', async () => {
  device();
  await setRemote('main', dbWith('main'));
  bootstrap = { owner: 'o', repo: 'r', branch: 'data', path: 'data/db.json' }; // even if it said otherwise
  const db = await gh.fetchDb();
  assert.equal(db.payments[0].id, 'a');
  assert.equal(bootstrapReads, 0);
  assert.equal(state.github.branch, 'main');
  assert.equal(gh.pinnedLocation(), null);
});

test('404 + bootstrap naming the same branch: throws DB_NOT_FOUND, no switch', async () => {
  device();
  branches.set('main', new Map());
  bootstrap = { owner: 'o', repo: 'r', branch: 'main', path: 'data/db.json' };
  await assert.rejects(gh.fetchDb(), e => e.code === 'DB_NOT_FOUND' && /db\.json not found/.test(e.message));
  assert.equal(bootstrapReads, 1);
  assert.equal(state.github.branch, 'main');
  assert.equal(gh.pinnedLocation(), null);
});

test('404 + bootstrap naming another branch of the same repo: switches, persists, retries once', async () => {
  device();
  branches.set('main', new Map());
  await setRemote('data', dbWith('main', { payments: [{ id: 'on-data', updatedAt: T }] }));
  bootstrap = { owner: 'o', repo: 'r', branch: 'data', path: 'data/db.json' };
  const db = await gh.fetchDb();
  assert.equal(db.payments[0].id, 'on-data');
  assert.equal(state.github.branch, 'data');
  assert.deepEqual(log.filter(r => r.method === 'GET').map(r => r.ref), ['main', 'data']);
  assert.equal(bootstrapReads, 1);
  const cfg = storedCfg();
  assert.equal(cfg.branch, 'data');
  assert.deepEqual(cfg.pin, { owner: 'o', repo: 'r', branch: 'data', path: 'data/db.json' });
  // A later reload restores the pin from localStorage.
  gh._resetLocationStateForTests();
  gh.loadConfig();
  assert.equal(state.github.branch, 'data');
  assert.deepEqual(gh.pinnedLocation(), { owner: 'o', repo: 'r', branch: 'data', path: 'data/db.json' });
});

test('also follows a changed path on the same branch', async () => {
  device();
  branches.set('main', new Map());
  await setRemote('main', dbWith('main'), 'store/db.json');
  bootstrap = { owner: 'o', repo: 'r', branch: 'main', path: 'store/db.json' };
  await gh.fetchDb();
  assert.equal(state.github.dbPath, 'store/db.json');
});

test('never switches repositories', async () => {
  device();
  branches.set('main', new Map());
  await setRemote('data', dbWith('data'));
  for (const cfg of [{ owner: 'x', repo: 'r', branch: 'data' }, { owner: 'o', repo: 'other', branch: 'data' }, { repo: 'r', branch: 'data' }]) {
    bootstrap = cfg;
    await assert.rejects(gh.fetchDb(), e => e.code === 'DB_NOT_FOUND');
    assert.equal(state.github.owner, 'o');
    assert.equal(state.github.repo, 'r');
    assert.equal(state.github.branch, 'main');
  }
});

test('rejects malformed branch/path names in the bootstrap config', async () => {
  device();
  branches.set('main', new Map());
  for (const cfg of [{ branch: '../x' }, { branch: 'a b' }, { branch: '' }, { branch: 5 }, { path: '../db.json' }, { path: '/abs.json' }, { path: 'data/db.txt' }]) {
    bootstrap = { owner: 'o', repo: 'r', ...cfg };
    await assert.rejects(gh.fetchDb(), e => e.code === 'DB_NOT_FOUND');
    assert.equal(state.github.branch, 'main');
    assert.equal(state.github.dbPath, 'data/db.json');
  }
});

test('no switch on 401 / 403 / 500 / network errors — the bootstrap config is not even read', async () => {
  for (const status of [401, 403, 500]) {
    device();
    await setRemote('data', dbWith('data'));
    bootstrap = { owner: 'o', repo: 'r', branch: 'data' };
    forceGetStatus = status;
    await assert.rejects(gh.fetchDb(), e => e.code !== 'DB_NOT_FOUND');
    assert.equal(bootstrapReads, 0, `status ${status}`);
    assert.equal(state.github.branch, 'main');
  }
});

test('no loop: one retry per read and at most one move per session', async () => {
  device();
  branches.set('main', new Map());
  branches.set('data', new Map()); // bootstrap points at data, but it's missing there too
  bootstrap = { owner: 'o', repo: 'r', branch: 'data' };
  await assert.rejects(gh.fetchDb(), e => e.code === 'DB_NOT_FOUND');
  assert.equal(state.github.branch, 'data');
  assert.equal(log.filter(r => r.method === 'GET').length, 2, 'main, then data once');
  // A second move in the same session is refused even if the bootstrap changes again.
  await setRemote('elsewhere', dbWith('elsewhere'));
  bootstrap = { owner: 'o', repo: 'r', branch: 'elsewhere' };
  await assert.rejects(gh.fetchDb(), e => e.code === 'DB_NOT_FOUND');
  assert.equal(state.github.branch, 'data');
});

test('bootstrap unreachable (not on Pages / offline): original DB_NOT_FOUND', async () => {
  device();
  branches.set('main', new Map());
  bootstrap = null;
  await assert.rejects(gh.fetchDb(), e => e.code === 'DB_NOT_FOUND');
  assert.equal(state.github.branch, 'main');
});

// ── pin vs applyDbConfig ─────────────────────────────────────────────────────

test('applyDbConfig does not revert a location adopted from the bootstrap config', async () => {
  device();
  branches.set('main', new Map());
  await setRemote('data', dbWith('main'));
  bootstrap = { owner: 'o', repo: 'r', branch: 'data' };
  const db = await gh.fetchDb();
  gh.applyDbConfig(db.appConfig.github);           // still says main inside the db
  assert.equal(state.github.branch, 'data');
  assert.equal(storedCfg().branch, 'data');
  // A db naming another repo is not covered by the pin (old behaviour).
  gh.applyDbConfig({ owner: 'o2', repo: 'r2', branch: 'b2', path: 'x/db.json' });
  assert.equal(state.github.owner, 'o2');
  assert.equal(state.github.branch, 'b2');
  assert.equal(gh.pinnedLocation(), null, 'pin for another repo is dropped');
});

test('the pin is dropped once the db itself records the adopted location', async () => {
  device();
  branches.set('main', new Map());
  await setRemote('data', dbWith('main'));
  bootstrap = { owner: 'o', repo: 'r', branch: 'data' };
  await gh.fetchDb();
  assert.ok(gh.pinnedLocation());
  gh.applyDbConfig({ owner: 'o', repo: 'r', branch: 'data', path: 'data/db.json' });
  assert.equal(gh.pinnedLocation(), null);
  assert.equal(state.github.branch, 'data');
  await new Promise(r => setTimeout(r, 50)); // writeCfg is async
  assert.equal(storedCfg().pin, undefined);
  // A later deliberate move recorded in the db is followed again.
  gh.applyDbConfig({ owner: 'o', repo: 'r', branch: 'data2', path: 'data/db.json' });
  assert.equal(state.github.branch, 'data2');
});

test('an explicit Settings save / setup link clears the pin; without a pin applyDbConfig behaves as before', async () => {
  device();
  branches.set('main', new Map());
  await setRemote('data', dbWith('main'));
  bootstrap = { owner: 'o', repo: 'r', branch: 'data' };
  await gh.fetchDb();
  await gh.saveConfig({ owner: 'o', repo: 'r', branch: 'data', dbPath: 'data/db.json', token: 't' });
  assert.equal(gh.pinnedLocation(), null);
  await new Promise(r => setTimeout(r, 50)); // writeCfg is async
  assert.equal(storedCfg().pin, undefined);
  gh.applyDbConfig({ owner: 'o', repo: 'r', branch: 'main', path: 'data/db.json' });
  assert.equal(state.github.branch, 'main');
});

test('adoptBootstrapConfig (Phase 1.5): defaults are not pinned, a moved location is', () => {
  device();
  state.github.owner = '';
  gh.adoptBootstrapConfig({ owner: 'o', repo: 'r', branch: 'main', path: 'data/db.json' });
  assert.equal(state.github.branch, 'main');
  assert.equal(gh.pinnedLocation(), null);
  gh.adoptBootstrapConfig({ owner: 'o', repo: 'r', branch: 'data', path: 'data/db.json' });
  assert.equal(state.github.branch, 'data');
  assert.deepEqual(gh.pinnedLocation(), { owner: 'o', repo: 'r', branch: 'data', path: 'data/db.json' });
  gh.applyDbConfig({ owner: 'o', repo: 'r', branch: 'main', path: 'data/db.json' });
  assert.equal(state.github.branch, 'data');
  gh.adoptBootstrapConfig({ owner: 'o', repo: 'r', branch: '../evil' });
  assert.equal(state.github.branch, 'main', 'malformed branch falls back to the default');
});

test('the next push after a move writes the new branch into db.appConfig.github, on the data branch', async () => {
  device();
  branches.set('main', new Map());
  await setRemote('data', dbWith('main'));
  bootstrap = { owner: 'o', repo: 'r', branch: 'data' };
  const db = await gh.fetchDb();
  db._syncedAt = Date.now();
  setDb(db);
  gh.applyDbConfig(db.appConfig.github);
  state.db.payments.push({ id: 'b', createdAt: T + 5, updatedAt: T + 5 });
  state.dirty = true;
  await gh.pushDb('test');
  assert.ok(log.filter(r => r.method === 'PUT').every(r => r.ref === 'data'));
  assert.equal(branches.get('main').has('data/db.json'), false, 'nothing written to main');
  const remote = await readRemote('data');
  assert.equal(remote.appConfig.github.branch, 'data');
  assert.deepEqual(remote.payments.map(p => p.id).sort(), ['a', 'b']);
  assert.equal(state.db.appConfig.github.branch, 'data', 'untouched plain field adopted locally');
});

test('dormant: without a pin, pushes leave appConfig.github exactly as it is', async () => {
  device();
  await setRemote('main', dbWith('main'));
  const db = await gh.fetchDb();
  db._syncedAt = Date.now();
  setDb(db);
  state.db.payments.push({ id: 'b', createdAt: T + 5, updatedAt: T + 5 });
  await gh.pushDb('test');
  const remote = await readRemote('main');
  assert.deepEqual(remote.appConfig.github, { owner: 'o', repo: 'r', branch: 'main', path: 'data/db.json' });
});

// ── pushes never re-create db.json on the old branch ─────────────────────────

async function staleTab() {
  device();
  await setRemote('main', dbWith('main'));
  const db = await gh.fetchDb();          // push-first cache now holds main's sha
  db._syncedAt = Date.now();
  setDb(db);
  // The cutover: data branch = copy of main's db.json; db.json removed from main.
  branches.set('data', new Map([['data/db.json', branches.get('main').get('data/db.json')]]));
  commit('data');
  removeRemote('main', 'data/db.json');
  state.db.payments.push({ id: 'stale-edit', createdAt: Date.now(), updatedAt: Date.now() });
  state.dirty = true;
}

test('stale tab, push-first path: PUT 409 → GET 404 → refuses (db.json not found), main untouched', async () => {
  await staleTab();
  bootstrap = { owner: 'o', repo: 'r', branch: 'main' }; // bootstrap not deployed yet
  const n = log.length;
  await assert.rejects(gh.pushDb('test'), e => e.code === 'DB_NOT_FOUND' && /db\.json not found/.test(e.message));
  assert.deepEqual(log.slice(n).map(r => r.method), ['PUT', 'GET']);
  assert.equal(branches.get('main').has('data/db.json'), false);
  assert.ok(state.db.payments.some(p => p.id === 'stale-edit'), 'edit kept locally');
});

test('stale tab, GET path (no cached sha): GET 404 → refuses, main untouched', async () => {
  device(); // clearConfig() dropped the push-first sha cache
  branches.set('main', new Map());              // db.json already removed from main
  bootstrap = null;
  setDb({ ...dbWith('main'), _syncedAt: Date.now() }); // edits held only locally
  state.db.payments.push({ id: 'stale-edit', createdAt: Date.now(), updatedAt: Date.now() });
  state.dirty = true;
  await assert.rejects(gh.pushDb('test'), e => e.code === 'DB_NOT_FOUND' && /db\.json not found/.test(e.message));
  assert.ok(log.some(r => r.method === 'GET' && r.ref === 'main'));
  assert.ok(log.every(r => r.method === 'GET'), 'no PUT at all');
  assert.equal(branches.get('main').has('data/db.json'), false);
  assert.ok(state.db.payments.some(p => p.id === 'stale-edit'));
});

test('if GitHub ever CREATES the file on a sha-carrying PUT (201), the push deletes it again and refuses', async () => {
  await staleTab();
  putMissingWithSha = 'create';
  bootstrap = { owner: 'o', repo: 'r', branch: 'main' };
  await assert.rejects(gh.pushDb('test'), e => e.code === 'DB_NOT_FOUND');
  assert.equal(branches.get('main').has('data/db.json'), false, 're-created file removed');
  const del = log.filter(r => r.method === 'DELETE');
  assert.equal(del.length, 1);
  assert.equal(del[0].ref, 'main');
  assert.ok(state.db.payments.some(p => p.id === 'stale-edit'));
  // The retry must not repeat the push-first PUT (which would re-create it again).
  await assert.rejects(gh.pushDb('retry'), e => e.code === 'DB_NOT_FOUND');
  assert.equal(log.filter(r => r.method === 'DELETE').length, 1, 'no second create/delete cycle');
  assert.equal(branches.get('main').has('data/db.json'), false);
});

test('a normal update answered 201 (parent had db.json) is NOT undone', async () => {
  device();
  await setRemote('main', dbWith('main'));
  setDb(await gh.fetchDb());
  // Make this fake answer 201 for an update, with a parent that has db.json.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const r = await realFetch(url, opts);
    if (opts.method === 'PUT' && r.status === 200) return { ...r, status: 201 };
    return r;
  };
  try {
    state.db.payments.push({ id: 'b', createdAt: T + 5, updatedAt: T + 5 });
    await gh.pushDb('test');
  } finally { globalThis.fetch = realFetch; }
  assert.equal(log.filter(r => r.method === 'DELETE').length, 0);
  assert.ok(branches.get('main').has('data/db.json'));
});

test('stale tab follows the move on push; the automatic retry then merges into the data branch', async () => {
  await staleTab();
  bootstrap = { owner: 'o', repo: 'r', branch: 'data' };
  await assert.rejects(gh.pushDb('test'), e => e.code === 'DB_NOT_FOUND');
  assert.equal(state.github.branch, 'data');
  // Another device wrote to the data branch in the meantime.
  const other = await readRemote('data');
  other.payments.push({ id: 'other-device', createdAt: Date.now(), updatedAt: Date.now() });
  await setRemote('data', other);
  await gh.pushDb('retry');
  const remote = await readRemote('data');
  assert.deepEqual(remote.payments.map(p => p.id).sort(), ['a', 'other-device', 'stale-edit']);
  assert.equal(remote.appConfig.github.branch, 'data');
  assert.equal(branches.get('main').has('data/db.json'), false);
});

// ── attachments + bootstrap config ───────────────────────────────────────────

test('attachment writes/deletes are refused where db.json was just found missing', async () => {
  device();
  branches.set('main', new Map([['invoices/x.pdf', { sha: 'bx', content: 'AA==' }]]));
  bootstrap = null;
  await assert.rejects(gh.fetchDb(), e => e.code === 'DB_NOT_FOUND');
  const enc = cr.bytesToBase64(await cr.encryptBytes(new Uint8Array(64)));
  await assert.rejects(gh.uploadGithubFile('invoices/y.pdf', enc, 'u'), e => e.code === 'DB_NOT_FOUND');
  await assert.rejects(gh.deleteGithubFile('invoices/x.pdf'), e => e.code === 'DB_NOT_FOUND');
  await assert.rejects(gh.listGithubFolder('invoices'), e => e.code === 'DB_NOT_FOUND');
  assert.ok(branches.get('main').has('invoices/x.pdf'));
  assert.equal(branches.get('main').has('invoices/y.pdf'), false);
  // Cleared by the next successful read.
  await setRemote('main', dbWith('main'));
  await gh.fetchDb();
  await gh.uploadGithubFile('invoices/y.pdf', enc, 'u');
  assert.ok(branches.get('main').has('invoices/y.pdf'));
});

test('uploadGithubFile branch override: the bootstrap config goes to the Pages branch, same plaintext rule', async () => {
  device('data');
  branches.set('main', new Map());
  branches.set('data', new Map());
  const cfg = b64(JSON.stringify({ owner: 'o', repo: 'r', branch: 'data', path: 'data/db.json' }));
  await gh.uploadGithubFile('data/github-config.json', cfg, 'cfg', { branch: 'main' });
  assert.ok(branches.get('main').has('data/github-config.json'));
  assert.equal(branches.get('data').has('data/github-config.json'), false);
  // Still only that one file may be plaintext, whatever the branch.
  await assert.rejects(gh.uploadGithubFile('data/other.json', cfg, 'x', { branch: 'main' }), e => e.code === 'NO_ENC_KEY');
  await assert.rejects(gh.uploadGithubFile('data/github-config.json', cfg, 'x', { branch: '../x' }), /Invalid branch/);
  // Without the override: the data branch, as before.
  await gh.uploadGithubFile('data/github-config.json', cfg, 'cfg');
  assert.ok(branches.get('data').has('data/github-config.json'));
});
