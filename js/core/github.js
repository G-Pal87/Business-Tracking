// GitHub API layer — direct calls from the frontend using a PAT stored in db.json.
import { state, notify, invalidateActiveCache } from './state.js';
import { isEncryptedEnvelope, decryptEnvelopeToJson, decryptEnvelopeWithInfo, isRotationPending, setRotationPending, activeKeyId, encryptJsonToEnvelope, isUnlocked, hasWrappedKeyConfigured, encryptBytes, decryptBytes, isEncryptedBytes, supportsCompression, bytesToBase64, base64ToBytes } from './crypto.js';

const DB_LS_KEY  = 'bt_db_cache';
const CFG_LS_KEY = 'bt_github_config';

// Used by mergeLocalPending(): a record's sync marker is treated as this much
// earlier than it claims before trusting it to decide whether a local-only
// addition is a genuine offline edit. Deliberately NOT used for delete
// propagation (in either mergeLocalPending or resyncDb) — see the comments
// at each function's delete-propagation step for why. See mergeLocalPending()
// below for the full rationale.
const SYNC_SAFETY_MARGIN_MS = 15 * 60 * 1000; // 15 minutes

// Every GitHub request gets a deadline. Without one, a request that stalls
// (e.g. a mobile network switch mid-PUT) never settles: pushPending stays
// true, no later edit is ever scheduled, background resync stands down, and
// the sidebar says "Pushing…" until the page is reloaded. A timeout surfaces
// as an ordinary network failure, which every caller already retries.
const GH_TIMEOUT_MS       = 30 * 1000;
const GH_WRITE_TIMEOUT_MS = 120 * 1000; // uploads of multi-MB files on slow links
export async function ghFetch(url, opts = {}) {
  const ms = opts.method && opts.method !== 'GET' ? GH_WRITE_TIMEOUT_MS : GH_TIMEOUT_MS;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(timer); }
}

let pushQueue = Promise.resolve();
// { sha, path, db, decKid, etag } — see fetchDb(). `db` is the decrypted
// content of blob `sha`, and is a SHARED, READ-ONLY snapshot: the same object
// is usually also state.github.remoteDb (the merge base), and may be the
// push-first merge input in doPushDb. Nothing may mutate it or anything
// inside it — records that leave this module for state.db are cloned first
// (see adoptRecord), and fetchDb hands callers their own copy (except the
// conditional poll's 304 path — see there).
let _lastFetched = null;
// Which file a _lastFetched entry describes. The push-first path must only
// trust it for the exact same repo/branch/path (after a Settings change the
// cached sha belongs to another file).
const fetchTarget = (dbPath) => `${state.github.owner}/${state.github.repo}@${state.github.branch}:${dbPath}`;
let _sizeWarned = false; // throttles the db.json size-warning toast to once per session per threshold-crossing

// Cheap recency watermark for a whole db snapshot — the highest updatedAt
// across every collection. Used only to detect when a fresh GET has regressed
// (see fetchDb()'s remoteDb guard below), never to drive any actual merge
// decision — this is deliberately coarser than mergeDb's own per-record
// comparisons.
function maxUpdatedAt(db) {
  let max = 0;
  if (!db) return max;
  for (const val of Object.values(db)) {
    if (!Array.isArray(val)) continue;
    for (const item of val) {
      if (item && item.updatedAt > max) max = item.updatedAt;
    }
  }
  return max;
}

// ── Merge helpers ────────────────────────────────────────────────────────────

// Tombstones older than this are dropped when merging — must match
// pruneTombstones()'s default in data.js. Pruning only in data.js never stuck:
// every merge unions tombstones from all sides, so the pruned entries came
// straight back from the remote/base copy on the next sync.
const TOMBSTONE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export function unionTombstones(...sources) {
  const cutoff = Date.now() - TOMBSTONE_MAX_AGE_MS;
  const out = {};
  for (const src of sources) {
    if (!src) continue;
    for (const [k, ts] of Object.entries(src)) {
      if (typeof ts === 'number' && ts < cutoff) continue;
      if (out[k] === undefined || ts > out[k]) out[k] = ts;
    }
  }
  return out;
}

// A tombstone blocks a record from ever coming back — except one that was
// deliberately restored from a backup AFTER the tombstone was written
// (restoredAt, stamped by Settings → Restore). Without that exception a
// restore could never bring back anything that had been permanently deleted
// since the backup was taken, and other devices' merges would re-delete it.
export function isTombstoned(tombstones, col, item) {
  const ts = tombstones?.[`${col}:${item?.id}`];
  if (ts === undefined) return false;
  if (item && typeof item.restoredAt === 'number' && item.restoredAt > ts) return false;
  return true;
}

// Record equality ignoring who/when stamped the last edit.
function sameContent(a, b) {
  const strip = ({ updatedAt, updatedBy, ...rest }) => rest;
  return deepEqual(strip(a), strip(b));
}

// Last-synced copy of the plain (non-record) top-level fields — kept in the
// local cache as `_syncedPlain` so a reload can 3-way merge settings edits
// (see mergeLocalPending). Device-local: never pushed to db.json.
export function plainFieldsOf(db) {
  const out = {};
  for (const [k, v] of Object.entries(db || {})) {
    if (k.startsWith('_') || Array.isArray(v) || v === undefined) continue;
    out[k] = structuredClone(v);
  }
  return out;
}

function isPlainObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

// Structural equality, insensitive to object key order (deepMerge/patch
// helpers don't preserve it, so JSON.stringify comparison would misfire).
export function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  const ka = Object.keys(a).filter(k => a[k] !== undefined);
  const kb = Object.keys(b).filter(k => b[k] !== undefined);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!deepEqual(a[k], b[k])) return false;
  return true;
}

// Three-way merge of a plain (non-record) value such as `settings`: whichever
// side changed relative to the common ancestor wins; when both changed,
// recurse into sub-keys so edits to DIFFERENT settings (e.g. one device's FX
// rates, another's business details) both survive. A true same-leaf
// conflict keeps the local value.
export function merge3(base, local, remote) {
  if (deepEqual(local, base)) return remote;
  if (deepEqual(remote, base)) return local;
  if (isPlainObj(local) && isPlainObj(remote)) {
    const b = isPlainObj(base) ? base : {};
    const out = {};
    for (const k of new Set([...Object.keys(local), ...Object.keys(remote)])) {
      const v = merge3(b[k], local[k], remote[k]);
      if (v !== undefined) out[k] = v;
    }
    return out;
  }
  if (isIdArray(local) && isIdArray(remote) && (base === undefined || isIdArray(base))) {
    return merge3IdArray(base || [], local, remote);
  }
  return local;
}

// Arrays of {id,…} objects nested in plain fields (settings.team,
// engagements, dividendSettings…) used to be merged as one value, so two
// devices each adding an entry kept only one of them. Merge them per id
// instead: additions from both sides survive, a removal on one side sticks
// unless the other side edited that entry, and each entry is itself
// 3-way merged. Order follows remote, then local-only additions.
function isIdArray(v) {
  return Array.isArray(v) && v.length > 0 && v.every(x => isPlainObj(x) && x.id != null);
}
function merge3IdArray(base, local, remote) {
  const bm = new Map(base.map(x => [x.id, x]));
  const lm = new Map(local.map(x => [x.id, x]));
  const rm = new Map(remote.map(x => [x.id, x]));
  const out = [];
  const pick = id => {
    const b = bm.get(id), l = lm.get(id), r = rm.get(id);
    if (l && r) return merge3(b, l, r);
    // Present on one side only: an addition, or a removal on the other side.
    const only = l || r;
    if (!b) return only;                    // added on that side
    return deepEqual(only, b) ? undefined : only; // removed elsewhere, unless edited here
  };
  for (const id of rm.keys()) { const v = pick(id); if (v !== undefined) out.push(v); }
  for (const id of lm.keys()) { if (rm.has(id)) continue; const v = pick(id); if (v !== undefined) out.push(v); }
  return out;
}

// ── Plaintext-remote guard ───────────────────────────────────────────────────
// Once this device has read an encrypted db.json, a db.json that suddenly
// comes back as plain JSON is not "legacy data" — it can only have been
// written by something that bypassed this app (anyone holding the token can
// PUT a file). Merging it would launder whatever it contains (an injected
// admin user, a changed IBAN…) into the encrypted data on the next push, so
// refuse it. Device-local flag: set the first time an envelope is decrypted,
// which also keeps a brand-new, not-yet-encrypted setup working.
const ENC_SEEN_LS_KEY = 'bt_enc_remote_seen';
function markEncryptedRemoteSeen() {
  try { localStorage.setItem(ENC_SEEN_LS_KEY, '1'); } catch { /* ignore */ }
}
function encryptedRemoteSeen() {
  try { return localStorage.getItem(ENC_SEEN_LS_KEY) === '1'; } catch { return false; }
}
function assertPlaintextRemoteAllowed() {
  if (!encryptedRemoteSeen()) return;
  const err = new Error('db.json on GitHub is no longer encrypted. The app never writes it that way, so it was changed outside the app — nothing was loaded or saved. Restore it from a backup (Settings → Data) or check who has the GitHub token.');
  err.code = 'PLAINTEXT_REMOTE';
  throw err;
}

// ── Config ───────────────────────────────────────────────────────────────────

// The token is stored encrypted under the team data key (`tokenEnc`, the
// same BTX1 container as documents) once a key is unlocked, so it isn't
// readable from localStorage by anything that isn't signed in. Before that
// — a brand-new device that just opened a setup link — it is kept as-is
// until the first sign-in encrypts it (adoptStoredToken).
function readCfg() {
  try { return JSON.parse(localStorage.getItem(CFG_LS_KEY) || '{}'); } catch { return {}; }
}

async function writeCfg() {
  const cfg = {
    owner:  state.github.owner,
    repo:   state.github.repo,
    branch: state.github.branch,
    path:   state.github.dbPath
  };
  const token = state.github.token || '';
  if (token && isUnlocked()) {
    try {
      const bytes = await encryptBytes(new TextEncoder().encode(token));
      let bin = ''; for (const b of bytes) bin += String.fromCharCode(b);
      cfg.tokenEnc = btoa(bin);
    } catch { cfg.token = token; }
  } else if (token) {
    cfg.token = token;
  } else {
    const prev = readCfg();
    if (prev.tokenEnc) cfg.tokenEnc = prev.tokenEnc; // locked: keep it for next sign-in
  }
  try { localStorage.setItem(CFG_LS_KEY, JSON.stringify(cfg)); } catch { /* ignore */ }
}

export function loadConfig() {
  const cfg = readCfg();
  state.github.owner  = cfg.owner  || '';
  state.github.repo   = cfg.repo   || '';
  state.github.branch = cfg.branch || 'main';
  state.github.dbPath = cfg.path   || 'data/db.json';
  state.github.token  = cfg.token  || '';
}

// Called once the data key is unlocked (after sign-in / key entry): decrypts
// a stored `tokenEnc`, or encrypts a still-plain token in place.
export async function adoptStoredToken() {
  if (!isUnlocked()) return;
  const cfg = readCfg();
  if (cfg.token) {
    state.github.token = cfg.token;
  } else if (cfg.tokenEnc && !state.github.token) {
    try {
      const bytes = await decryptBytes(Uint8Array.from(atob(cfg.tokenEnc), c => c.charCodeAt(0)));
      state.github.token = new TextDecoder().decode(bytes);
    } catch { return; } // encrypted under a key this device no longer holds
  }
  await writeCfg();
}

// Called after db.json is loaded — syncs owner/repo/branch/path from db.appConfig.github
// into state and localStorage. Token is intentionally NOT read from the DB —
// it lives in localStorage only (set via setup link or Settings form).
export function applyDbConfig(ghCfg) {
  if (!ghCfg) return;
  if (ghCfg.owner)  state.github.owner  = ghCfg.owner;
  if (ghCfg.repo)   state.github.repo   = ghCfg.repo;
  if (ghCfg.branch) state.github.branch = ghCfg.branch;
  if (ghCfg.path)   state.github.dbPath = ghCfg.path;
  // ghCfg.token is deliberately ignored — never read tokens from the DB
  writeCfg();
}

export function saveConfig({ owner, repo, branch, dbPath, token }) {
  state.github.owner  = owner  || '';
  state.github.repo   = repo   || '';
  state.github.branch = branch || 'main';
  state.github.dbPath = dbPath || 'data/db.json';
  if (token !== undefined) state.github.token = token || '';
  return writeCfg();
}

export function clearConfig() {
  state.github.token         = '';
  state.github.owner         = '';
  state.github.repo          = '';
  state.github.branch        = 'main';
  state.github.dbPath        = 'data/db.json';
  state.github.sha           = null;
  state.github.connected     = false;
  state.github.remoteDb      = null;
  state.github.lastPullOk    = false;
  state.github.lastPushOk    = false;
  state.github.usingCache    = false;
  state.github.lastSyncError = null;
  state.github.lastPulledAt  = null;
  state.github.lastPushedAt  = null;
  state.github.syncNow       = null;
  _lastFetched = null;
  try { localStorage.removeItem(CFG_LS_KEY); } catch { /* ignore */ }
}

// ── Fetch db.json ─────────────────────────────────────────────────────────────

function b64decode(str) {
  return decodeURIComponent(escape(atob(str.replace(/\s/g, ''))));
}

function b64encode(str) {
  return btoa(unescape(encodeURIComponent(str)));
}

function safeParseDb(content) {
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('GitHub returned empty content for db.json');
  }
  try { return JSON.parse(content); }
  catch (e) { throw new Error(`db.json contains invalid JSON: ${e.message}`); }
}

// A 403 from GitHub can mean either a genuine token/permission problem OR
// rate limiting (primary: quota exhausted; secondary: too many requests too
// fast) — both surface as the same status code. Treating every 403 as an
// auth failure was misleading during heavy multi-tab/team usage: a transient,
// self-clearing rate limit got reported (and acted on) as if the token itself
// were broken. Retry-After (seconds) signals a secondary limit; an exhausted
// x-ratelimit-remaining signals the primary one, resetting at x-ratelimit-reset.
function rateLimitWaitMs(res) {
  const retryAfter = res.headers.get('retry-after');
  if (retryAfter && !isNaN(Number(retryAfter))) return Number(retryAfter) * 1000;
  if (res.headers.get('x-ratelimit-remaining') === '0') {
    const resetAt = Number(res.headers.get('x-ratelimit-reset'));
    if (resetAt) return Math.min(5 * 60 * 1000, Math.max(0, resetAt * 1000 - Date.now()));
    return 60 * 1000;
  }
  return 0;
}

// `conditional`: only the 60s background poll passes it. It sends the ETag of
// the last read so an unchanged db.json comes back as 304 — which GitHub does
// not count against the rate limit (every open tab polls, all sharing one
// token). Every other caller (first load, pre-push base, confirmatory
// re-pulls) keeps the unique If-None-Match that forces the CDN to revalidate,
// since those need the freshest possible read.
export async function fetchDb({ conditional = false } = {}) {
  const { owner, repo, branch, dbPath, token } = state.github;
  if (!owner || !repo) throw new Error('GitHub not configured');

  const useEtag = conditional && _lastFetched?.etag && _lastFetched.path === dbPath;
  const headers = { 'Accept': 'application/vnd.github+json', 'If-None-Match': useEtag ? _lastFetched.etag : `"${Date.now()}"` };
  if (token) headers['Authorization'] = `token ${token}`;

  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${dbPath}?ref=${encodeURIComponent(branch || 'main')}`;

  // ATTEMPTS covers both the 403-rate-limit retry below AND a raw network
  // failure (dropped connection, DNS hiccup) — a transient blip during the
  // page-load burst (this fetch competes with ~26 other module downloads)
  // used to throw on the very first try with no retry at all, surfacing as
  // "GitHub unreachable" even though a retry moments later would succeed.
  const ATTEMPTS = 3;
  let res;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try { res = await ghFetch(url, { headers, cache: 'no-store' }); }
    catch {
      if (attempt < ATTEMPTS) { await sleep(backoff(attempt)); continue; }
      throw new Error('Cannot reach GitHub — check your internet connection');
    }

    if (res.status === 403 && attempt < ATTEMPTS) {
      const waitMs = rateLimitWaitMs(res);
      if (waitMs > 0) { await sleep(waitMs); continue; }
    }
    break;
  }

  state.github.lastFetchUnchanged = false;
  if (res.status === 304 && useEtag) {
    // Unchanged since the last read — same content, same sha.
    state.github.lastFetchUnchanged = true;
    state.github.connected     = true;
    state.github.lastPullOk    = true;
    state.github.usingCache    = false;
    state.github.lastPulledAt  = Date.now();
    state.github.lastSyncError = null;
    // The conditional poll's only caller (app.js backgroundResync) discards
    // this result when the sha is unchanged, or passes it to resyncDb, which
    // copies it and never mutates or leaks its input — so skip the
    // whole-database clone every idle tab used to pay every 60s. Only a
    // shallow copy: setting/replacing top-level fields on it is harmless, but
    // its collections, records and settings are the shared read-only
    // snapshot — a conditional caller must not mutate anything nested
    // (structuredClone it first if it ever needs to).
    return { ..._lastFetched.db };
  }

  if (!res.ok) {
    if (res.status === 404) throw new Error('db.json not found in repo. Create data/db.json first.');
    if (res.status === 401) throw new Error(token ? 'GitHub auth failed — token is invalid or expired' : 'GitHub token required — enter a Personal Access Token in Settings → GitHub Storage');
    if (res.status === 403) {
      throw new Error(rateLimitWaitMs(res) > 0 ? 'GitHub rate limit exceeded — try again shortly' : 'GitHub access denied — check token permissions');
    }
    throw new Error(`GitHub fetch failed (${res.status})`);
  }

  const data = await res.json();
  const { sha, content } = data;
  const etag = res.headers.get('etag');

  // The Contents API inlines `content` for files up to 1MB; past that it is
  // empty and the file is read by sha through the git blobs API (see doPushDb
  // for why never via download_url). Either way the parsed content is exactly
  // the version `sha` names, which is what makes the _lastFetched sha cache
  // below safe.
  let parsed;
  const sameAsLast = !!(_lastFetched && _lastFetched.sha === sha && _lastFetched.path === dbPath);
  if (sameAsLast) {
    // Same blob sha as the last successful fetch = byte-identical content:
    // skip the (possible) blob download + decrypt + parse below — every tab
    // used to repeat all of it every 60s even when nothing changed. Callers
    // mutate what fetchDb returns, so they get their own copy — except the
    // conditional poll, which gets the same shallow copy as its 304 path
    // (see there). It lands here on the first poll after this tab's own push,
    // whose PUT response carries no ETag to send.
    parsed = conditional ? { ..._lastFetched.db } : structuredClone(_lastFetched.db);
  } else if (content) {
    parsed = safeParseDb(b64decode(content));
  } else if (sha) {
    parsed = safeParseDb(b64decode(await fetchGithubBlobBase64(sha)));
  } else {
    throw new Error('GitHub returned no content');
  }

  // Transparent decrypt: db.json is either a legacy plain object (pre-
  // encryption / no key ever configured) or the { enc: 1, iv, ct } envelope —
  // decryptEnvelopeToJson throws a clear error if this device has no data
  // key configured yet rather than silently returning ciphertext as "data".
  let decKid = _lastFetched?.sha === sha ? _lastFetched.decKid : null;
  if (isEncryptedEnvelope(parsed)) {
    ({ data: parsed, usedKid: decKid } = await decryptEnvelopeWithInfo(parsed));
    markEncryptedRemoteSeen();
  } else if (_lastFetched?.sha !== sha) {
    assertPlaintextRemoteAllowed();
  }
  // One private copy serves as both the sha cache and (below) the merge base —
  // both are read-only (see _lastFetched), so they can share it.
  if (!sameAsLast) _lastFetched = { sha, path: dbPath, target: fetchTarget(dbPath), db: structuredClone(parsed), decKid };
  if (etag) _lastFetched.etag = etag;
  state.github.lastFetchedSha = sha;

  state.github.sha           = sha;
  state.github.connected     = true;
  state.github.lastPullOk    = true;
  state.github.usingCache    = false;
  state.github.lastPulledAt  = Date.now();
  state.github.lastSyncError = null;
  // Guard against GitHub's Contents API occasionally serving a stale/lagging
  // CDN read (documented and already worked around elsewhere in this file —
  // see mergeDb's direction-sensitive remoteChanged check): only advance the
  // conflict-detection "base" if this fetch looks at least as fresh as what
  // it already holds. A regressed base here is what turns an entirely
  // ordinary single-user edit into a manufactured "someone else changed this"
  // conflict on the next push, purely from comparing against stale ancestor
  // data — never affects the returned `parsed` content itself, which callers
  // still get in full regardless (e.g. to setDb() the actual working data).
  // maxUpdatedAt alone misjudges freshness when the newest commit's only
  // change is a hard delete/purge that removed the very record holding the
  // previous highest timestamp — the remaining max can regress even though
  // the fetch is genuinely newer. A tombstone count that grew is an
  // independent, monotonic signal of exactly that case: purging always adds
  // a tombstone, so more tombstones than the held base already has means
  // real forward progress happened even if maxUpdatedAt alone can't see it.
  const tombstonesGrew = Object.keys(parsed._tombstones || {}).length >
    Object.keys(state.github.remoteDb?._tombstones || {}).length;
  if (!state.github.remoteDb || tombstonesGrew || maxUpdatedAt(parsed) >= maxUpdatedAt(state.github.remoteDb)) {
    state.github.remoteDb = _lastFetched.db;
  }
  return parsed;
}

// ── Push db.json ──────────────────────────────────────────────────────────────

export async function pushDb(message = 'Update data') {
  pushQueue = pushQueue.catch(() => null).then(() => doPushDb(message));
  return pushQueue;
}

async function doPushDb(message = 'Update data') {
  const { owner, repo, branch, dbPath, token } = state.github;
  if (!owner || !repo) throw new Error('GitHub not configured');
  if (!token) throw new Error('GitHub token not configured — add it in Settings');

  // Fail closed, not open: db.json lives in a PUBLIC repo, so it is never
  // written as plaintext — not even by a device that has no key set up at
  // all (that fallback is how unencrypted data once reached the history).
  // The edit stays local (state.dirty) until a key is unlocked/entered.
  if (!isUnlocked()) {
    const err = new Error(hasWrappedKeyConfigured()
      ? 'Encryption key not unlocked on this device — unlock it in Settings → Encryption before saving.'
      : 'No encryption key on this device — paste the team key in Settings → Encryption before saving. Nothing was saved to GitHub; your changes are kept locally.');
    err.code = 'NO_ENC_KEY';
    throw err;
  }

  // Without a remoteDb base, mergeDb() below can't tell a genuine concurrent
  // edit from an unrelated one and falls back to plain last-writer-wins for
  // this entire push. That normally only happens once per session (Phase 4
  // in app.js sets remoteDb on the first successful pull) — but if that
  // pull failed or was skipped, this push would otherwise go out with no
  // conflict protection at all. One extra fetch here is worth the latency.
  if (!state.github.remoteDb) {
    try {
      const freshBase = await fetchDb();
      // mergeDb's delete-propagation compares this new base against state.db: any
      // id present in base but absent from local is treated as a genuine local
      // deletion and stripped from what gets pushed. Without this reconciliation,
      // a record this session's state.db has simply never seen (e.g. added by
      // another session/device moments ago) reads as "deleted by me" the instant
      // this fallback hands mergeDb a base that already contains it — and the
      // very next push silently erases someone else's just-saved data.
      //
      // Never adopt a tombstoned id, though — this loop bypasses mergeDb's own
      // tombstone backstop entirely, so without this check a permanently-
      // deleted record that this fresh GET happens to still show (a stale
      // read, or simply the very first fetch of a session that never saw the
      // delete) would get pushed straight into state.db and resurrected.
      const tombstones = unionTombstones(freshBase._tombstones, state.db._tombstones);
      for (const [col, items] of Object.entries(freshBase)) {
        if (!Array.isArray(items) || !Array.isArray(state.db[col])) continue;
        const localIds = new Set(state.db[col].map(x => x.id));
        for (const item of items) {
          if (!localIds.has(item.id) && !isTombstoned(tombstones, col, item)) {
            state.db[col].push(item);
            localIds.add(item.id);
            // Keep the id index in sync — this path bypasses upsert/markDirty,
            // so byId() would otherwise miss this record until a full reload.
            state._ix?.get(col)?.set(item.id, item);
          }
        }
      }
      invalidateActiveCache();
    } catch { /* best-effort — push still proceeds without a base */ }
  }

  const apiBase  = `https://api.github.com/repos/${owner}/${repo}/contents/${dbPath}`;
  const ghHeaders = {
    'Accept':        'application/vnd.github+json',
    'Authorization': `token ${token}`,
    'Content-Type':  'application/json'
  };

  // Captured now, before the network round-trip below (which can take several
  // retries under contention) — this is the instant that actually reflects what
  // `snapshot` contains. Stamping state.db._syncedAt with Date.now() AFTER the
  // round-trip instead would mark this moment as "confirmed synced" even though
  // it includes edits made *after* snapshot was taken (which were never part of
  // this push's payload) — mergeLocalPending compares a record's createdAt against
  // _syncedAt to decide whether it's a genuine unsynced edit, so a too-late
  // _syncedAt makes a real new record made mid-push look already-synced and
  // silently discards it on the next reload.
  const snapshotTakenAt = Date.now();
  const snapshot = structuredClone(state.db);
  // Recorded here, at the instant it stops being true of `snapshot` — not after the
  // network round-trip below. doSave() compares state.editSeq against this once the
  // push resolves to tell "a new edit landed mid-push" apart from "the edit that
  // triggered this very push is still sitting in state.dirty" (which was always true,
  // since nothing had cleared it yet, and previously made doSave() re-push every
  // single time — turning one save into two full GET+merge+PUT cycles).
  const editSeqAtSnapshot = state.editSeq;
  // Never push the token to GitHub — strip it from appConfig before computing content
  if (snapshot.appConfig?.github?.token) delete snapshot.appConfig.github.token;
  // mergeDb only reads `base` (the last-synced snapshot), so we can reference
  // remoteDb directly instead of cloning the whole DB again on every push.
  const base     = state.github.remoteDb || null;
  let   lastError = null;

  // Push first, read only on conflict (optimistic concurrency). When this tab
  // already holds the decrypted content of a known db.json sha, the first
  // attempt skips the GET and merges against that content as "the remote",
  // then PUTs with that sha. GitHub accepts the PUT only while the file's
  // current blob sha still equals it — i.e. only if the remote really IS
  // that content (a blob sha is a hash of the content) — so the merge is
  // exactly what the GET path would have produced. Any other writer in
  // between turns it into a 409/422, and the loop falls back to the normal
  // GET + 3-way merge from attempt 1 on. Attempt 0 exists only in this mode.
  const canPushFirst = !!(_lastFetched && _lastFetched.sha && _lastFetched.path === dbPath &&
    _lastFetched.target === fetchTarget(dbPath) && _lastFetched.db);

  for (let attempt = canPushFirst ? 0 : 1; attempt <= 8; attempt++) {
    const pushFirst = attempt === 0;
    let sha;
    let freshDb;
    let remoteKid = null; // id of the key that decrypted the remote (null = plaintext)
    if (pushFirst) {
      sha       = _lastFetched.sha;
      freshDb   = _lastFetched.db; // shared read-only snapshot — see _lastFetched
      remoteKid = _lastFetched.decKid;
    } else {
      // GET current SHA + content — append timestamp to bypass GitHub's edge-cache,
      // which can return a stale SHA even when cache: 'no-store' is set.
      // If-None-Match with a unique value forces GitHub's Fastly CDN to revalidate
      // with origin on every attempt — it's in GitHub's CORS allow-list unlike Cache-Control.
      const getHeaders = { ...ghHeaders, 'If-None-Match': `"${Date.now()}"` };
      let getRes;
      try {
        getRes = await ghFetch(`${apiBase}?ref=${encodeURIComponent(branch || 'main')}`, {
          headers: getHeaders, cache: 'no-store'
        });
      } catch {
        if (attempt < 8) { await sleep(backoff(attempt)); continue; }
        throw new Error('Cannot reach GitHub');
      }

      if (!getRes.ok) {
        if (getRes.status === 403) {
          const waitMs = rateLimitWaitMs(getRes);
          if (waitMs > 0 && attempt < 8) { await sleep(waitMs); continue; }
          throw new Error(waitMs > 0 ? 'GitHub rate limit exceeded — try again shortly' : 'GitHub auth failed — check your token');
        }
        if (getRes.status === 401) throw new Error('GitHub auth failed — check your token');
        throw new Error(`GitHub fetch failed (${getRes.status})`);
      }

      const getData = await getRes.json();
      sha = getData.sha;
      if (_lastFetched && _lastFetched.sha === sha && _lastFetched.path === dbPath) {
        // Unchanged since our last read/push (same blob sha) — skip the
        // download + decrypt; see fetchDb(). mergeDb never mutates its inputs
        // and records leaving `merged` for state.db are cloned (adoptRecord),
        // so the shared snapshot is used as-is.
        freshDb = _lastFetched.db;
        remoteKid = _lastFetched.decKid;
      } else if (getData.content) {
        freshDb = safeParseDb(b64decode(getData.content));
      } else if (sha) {
        // Read the content BY SHA (git blobs API) rather than via download_url.
        // download_url is a raw.githubusercontent URL tied to the branch, which
        // can lag behind the sha this same response reports — merging against
        // that older content and then PUTting with the newer sha "succeeds" and
        // silently erases whatever the newer commit added. A blob read is
        // content-addressed: it is exactly the version the sha names.
        freshDb = safeParseDb(b64decode(await fetchGithubBlobBase64(sha)));
      } else {
        throw new Error('GitHub returned no content for db.json');
      }
    }
    if (isEncryptedEnvelope(freshDb)) {
      // Never push over a remote we can't read. This used to fall back to
      // "push our own snapshot, unmerged" — meant for the moment mid-key-
      // rotation — but the same path fired for ANY device still holding the
      // old key after a rotation elsewhere: its first save overwrote the
      // whole remote with its stale local copy under the old key, the
      // rotating device then couldn't read that and did the same back, and
      // the two kept wiping each other's data. decryptEnvelopeToJson now
      // also tries previously-held keys (crypto.js), so the rotating device
      // itself can still read the old-key remote and merge normally; a
      // device that genuinely lacks the key gets KEY_MISMATCH and keeps its
      // edits locally (state.dirty stays set) until the new key is entered.
      const { data, usedKid } = await decryptEnvelopeWithInfo(freshDb);
      remoteKid = usedKid;
      freshDb = data;
      markEncryptedRemoteSeen();
    } else if (!(_lastFetched && _lastFetched.sha === sha)) {
      assertPlaintextRemoteAllowed();
    }
    {
      // Refuse when the remote is readable only with a key OTHER than this
      // device's current one (checked for cached reads too — the key may
      // have changed since the content was cached).
      const curKid = await activeKeyId();
      if (remoteKid && curKid && remoteKid !== curKid && !isRotationPending()) {
        // Only an OLDER key on this device can read the remote: the current
        // key is not the team's key (e.g. a wrong key pasted in Settings).
        // Pushing would re-encrypt everything under it and lock every other
        // device out, while looking fine here.
        const err = new Error('The encryption key currently set on this device cannot read the data on GitHub (only an older key on this device can). It is probably the wrong key — re-enter the team key in Settings → Encryption. Nothing was saved to GitHub; your changes are kept locally.');
        err.code = 'KEY_MISMATCH';
        throw err;
      }
    }
    const merged  = mergeDb(freshDb, snapshot, base);
    // Never push the token. Copy-on-write: merged.appConfig may be the
    // shared remote snapshot's object, which must not be mutated.
    if (merged.appConfig?.github?.token) {
      const { token: _omit, ...ghCfg } = merged.appConfig.github;
      merged.appConfig = { ...merged.appConfig, github: ghCfg };
    }

    // PUT merged content — always encrypted (see the guard at the top).
    // Compressed only once an admin has switched it on (Settings →
    // Encryption), after every device runs a version that can read it.
    const jsonStr = JSON.stringify(await encryptJsonToEnvelope(merged, { compress: merged.settings?.compressDb === true }));
    if (jsonStr.length > 8 * 1024 * 1024) {
      const mb = (jsonStr.length / 1024 / 1024).toFixed(1);
      console.warn(`[BT] DB is ${mb} MB — consider purging deleted records in Settings → Data`);
      // console.warn alone is invisible to anyone but a developer with devtools
      // open — surface it to the user too, throttled to once per session per
      // size-threshold crossing so it doesn't toast on every single push.
      if (!_sizeWarned) {
        _sizeWarned = true;
        import('./ui.js').then(({ toast }) =>
          toast(`Data file is ${mb} MB and approaching GitHub's size limits — consider purging deleted records in Settings → Data.`, 'warning', 8000)
        ).catch(() => {});
      }
    } else {
      _sizeWarned = false;
    }
    let putRes;
    try {
      putRes = await ghFetch(apiBase, {
        method: 'PUT',
        headers: ghHeaders,
        body: JSON.stringify({
          message,
          content: b64encode(jsonStr),
          branch:  branch || 'main',
          sha
        })
      });
    } catch {
      if (attempt < 8) { await sleep(backoff(attempt)); continue; }
      throw new Error('Cannot reach GitHub');
    }

    if (putRes.status === 409 || putRes.status === 422 || putRes.status >= 500) {
      // 409: someone committed between our GET and PUT (sha moved on).
      // 422 ("sha wasn't supplied"/stale) and 5xx are transient the same way.
      // Each retry re-GETs the current SHA; back off exponentially with full
      // jitter so several busy tabs stop colliding with each other.
      lastError = `HTTP ${putRes.status}`;
      // A push-first sha mismatch only means our cached copy is behind —
      // not contention — so go straight to the GET + merge path.
      if (pushFirst && putRes.status < 500) continue;
      if (attempt < 8) { await sleep(50 + Math.random() * Math.min(5000, 150 * 2 ** attempt)); continue; }
      break; // exhausted — fall through below
    }

    if (!putRes.ok) {
      if (putRes.status === 403) {
        const waitMs = rateLimitWaitMs(putRes);
        if (waitMs > 0 && attempt < 8) { await sleep(waitMs); continue; }
        throw new Error(waitMs > 0 ? 'GitHub rate limit exceeded — try again shortly' : 'Token lacks write access');
      }
      if (putRes.status === 401) throw new Error('Token lacks write access');
      throw new Error(`Push failed (${putRes.status})`);
    }

    const newSha = (await putRes.json()).content.sha;
    if (merged._newConflicts?.length) {
      const n = merged._newConflicts.length;
      notify('sync-conflicts', merged._newConflicts);
      import('./ui.js').then(({ toast }) =>
        toast(`${n} record${n === 1 ? ' was' : 's were'} edited on two devices at the same time. The later edit was kept; the other version is in Settings → Sync conflicts (below Trash) if you need it.`, 'warning', 12000)
      ).catch(() => {});
    }

    state.github.sha          = newSha;
    // `merged` becomes the shared read-only snapshot (merge base + sha cache)
    // as-is, with no copies: it is built only from `snapshot` (this push's
    // private clone) and the read-only remote snapshot, and nothing below
    // mutates it — records that move from it into state.db are cloned.
    const decKid = isUnlocked() ? await activeKeyId() : null;
    state.github.remoteDb     = merged;
    _lastFetched = { sha: newSha, path: dbPath, target: fetchTarget(dbPath), db: merged, decKid };
    // db.json is now encrypted under the current key — an interrupted
    // rotation (see setRotationPending) has completed its db.json part.
    if (isUnlocked() && isRotationPending()) setRotationPending(false);
    state.github.lastPushOk   = true;
    state.github.lastPushedAt = Date.now();
    state.github.lastSyncError = null;
    state.github.connected    = true;
    state.github.usingCache   = false;
    // Local state is now consistent with this remote as of snapshotTakenAt — NOT
    // Date.now(). Anything created/edited after that instant (mid-flight, during
    // the retries above) was never part of `snapshot`/this push's payload, and
    // must still compare as newer than _syncedAt so mergeLocalPending treats it
    // as a genuine unsynced edit on the next reload instead of discarding it.
    state.db._syncedAt = snapshotTakenAt;
    applyMergedToUntouched(merged, snapshot);

    // Adopt remote-only additions, but never re-add items permanently deleted
    // during this push (items that were in snapshot but are now gone from state.db).
    const permanentlyDeletedDuringPush = new Set();
    for (const [col, items] of Object.entries(snapshot)) {
      if (!Array.isArray(items)) continue;
      const currentIds = new Set((state.db[col] || []).map(x => x.id));
      for (const item of items) {
        if (!currentIds.has(item.id)) permanentlyDeletedDuringPush.add(`${col}:${item.id}`);
      }
    }

    let adopted = false;
    for (const [col, items] of Object.entries(merged)) {
      if (!Array.isArray(items) || !Array.isArray(state.db[col])) continue;
      const localIds = new Set(state.db[col].map(x => x.id));
      for (const item of items) {
        if (!localIds.has(item.id) && !permanentlyDeletedDuringPush.has(`${col}:${item.id}`)) {
          const own = adoptRecord(item);
          state.db[col].push(own);
          // Keep the id index in sync — this path bypasses upsert/markDirty,
          // so byId() would otherwise miss remote-adopted records until reload.
          state._ix?.get(col)?.set(own.id, own);
          adopted = true;
        }
      }
    }
    // Adopting records changes the active set without going through markDirty.
    if (adopted) invalidateActiveCache();

    saveLocalCache(state.db);
    dropAppliedJournals();
    return { sha: newSha, editSeqAtSnapshot };
  }

  // All retries lost the race against other writers. This is contention,
  // not a conflict between edits (those are resolved in mergeDb) — report it
  // as an ordinary failure so doSave's backoff retries it automatically,
  // instead of telling the user someone modified the same data.
  const err = new Error(`GitHub was busy (${lastError || 'write contention'}) — will retry automatically`);
  err.code = 'SHA_RETRY_EXHAUSTED';
  throw err;
}

// After a successful push, `merged` (now the remote AND the new merge base)
// can contain other users' changes to records this tab already holds. The
// adoption loop in doPushDb only added records that were missing locally, so
// a record another user had updated stayed stale in state.db while the base
// moved ahead to their version. The next local edit of that record then
// looked like "only local changed" to mergeDb and last-writer-wins silently
// reverted the other user's fields, with no conflict raised. Bring those
// changes in — but only for records (and plain fields like settings) this
// tab has NOT touched since the snapshot was taken, so nothing edited
// mid-push is ever overwritten.
// Records in `merged` are shared with the read-only remote snapshot (see
// _lastFetched); state.db records are edited in place. Every record that
// moves from one to the other goes through here, so the two never share an
// object.
function adoptRecord(item) { return structuredClone(item); }

function applyMergedToUntouched(merged, snapshot) {
  let changed = false;
  for (const [col, mergedArr] of Object.entries(merged)) {
    if (col.startsWith('_')) continue;
    const localVal = state.db[col];
    if (!Array.isArray(mergedArr)) {
      if (Array.isArray(localVal) || mergedArr === undefined) continue;
      if (deepEqual(localVal, snapshot[col]) && !deepEqual(localVal, mergedArr)) {
        state.db[col] = structuredClone(mergedArr);
        changed = true;
      }
      continue;
    }
    if (!Array.isArray(localVal) || !Array.isArray(snapshot[col])) continue;
    const snapMap   = new Map(snapshot[col].map(x => [x.id, x]));
    const mergedMap = new Map(mergedArr.map(x => [x.id, x]));
    const ix = state._ix?.get(col);
    let w = 0;
    for (let r = 0; r < localVal.length; r++) {
      const item = localVal[r];
      const snapItem = snapMap.get(item.id);
      const untouched = snapItem && item.updatedAt === snapItem.updatedAt;
      if (untouched) {
        const m = mergedMap.get(item.id);
        if (!m) {
          // The merge dropped it (removed/purged remotely, or tombstoned).
          ix?.delete(item.id);
          changed = true;
          continue;
        }
        if (m.updatedAt !== item.updatedAt) {
          const own = adoptRecord(m);
          localVal[w++] = own;
          ix?.set(own.id, own);
          changed = true;
          continue;
        }
      }
      localVal[w++] = item;
    }
    localVal.length = w;
  }
  if (merged._mtimes) state.db._mtimes = { ...merged._mtimes };
  state.db._syncedPlain = plainFieldsOf(merged);
  // Union, never replace — a hard delete made mid-push has a tombstone only
  // in state.db, and dropping it would let that record resurrect.
  if (merged._tombstones) state.db._tombstones = unionTombstones(state.db._tombstones, merged._tombstones);
  if (changed) invalidateActiveCache();
}

// ── Three-way merge ───────────────────────────────────────────────────────────

export function mergeDb(freshRemote, localCurrent, lastSynced) {
  const result    = {};
  const conflicts = [];
  const cols = new Set([
    ...Object.keys(freshRemote  || {}),
    ...Object.keys(localCurrent || {})
  ]);

  // Union of every id ever permanently deleted, from either side — see
  // recordTombstone() in data.js for why this exists. Always a union, never
  // "pick one side", since either side may know about a delete the other
  // doesn't yet.
  const tombstones = unionTombstones(freshRemote?._tombstones, lastSynced?._tombstones, localCurrent?._tombstones);
  // Per-field "last changed at" stamps for plain (non-record) fields like
  // `settings` — see mergePlainField(). Carried forward from the remote and
  // re-stamped for every field this push changes.
  const mtimes = { ...(freshRemote?._mtimes || {}) };
  const now = Date.now();
  // Stamps must strictly increase across devices regardless of clock skew:
  // a device whose clock runs behind would otherwise stamp its newer change
  // as "older" than a skewed-ahead device's earlier one, and that device
  // would then treat the newer value as a stale read and revert it.
  const stampFor = col => Math.max(now, (freshRemote?._mtimes?.[col] || 0) + 1, (lastSynced?._mtimes?.[col] || 0) + 1);

  for (const col of cols) {
    if (col === '_tombstones') { result._tombstones = tombstones; continue; }
    if (col === '_mtimes') continue; // written after the loop
    if (col === '_syncedPlain') continue; // device-local sync metadata, never pushed
    const fresh = freshRemote[col];
    const local = localCurrent[col];
    const base  = lastSynced ? lastSynced[col] : undefined;

    if (!Array.isArray(local) || !Array.isArray(fresh)) {
      if (col.startsWith('_') || !lastSynced || local === undefined || fresh === undefined
          || Array.isArray(local) || Array.isArray(fresh)) {
        result[col] = local !== undefined ? local : fresh;
        if (!col.startsWith('_') && lastSynced && local !== undefined && !deepEqual(local, base)) mtimes[col] = stampFor(col);
        continue;
      }
      const { value, localChanged } = mergePlainField(col, fresh, local, base, freshRemote, lastSynced);
      result[col] = value;
      if (localChanged) mtimes[col] = stampFor(col);
      continue;
    }

    const baseMap  = new Map((Array.isArray(base) ? base : []).map(x => [x.id, x]));
    const localMap = new Map(local.map(x => [x.id, x]));
    const merged   = new Map(fresh.map(x => [x.id, x]));

    for (const item of local) {
      const remoteItem = merged.get(item.id);
      const baseItem   = baseMap.get(item.id);

      const localChanged  = !baseItem || item.updatedAt !== baseItem.updatedAt;

      // Local copy is unchanged since the common ancestor → remote is authoritative.
      if (baseItem && !localChanged) continue;

      if (!remoteItem) {
        // Remote no longer has this record.
        if (baseItem) {
          // It existed at the ancestor and remote removed it (delete/purge). Only
          // a genuine local edit should resurrect it; otherwise respect the remote
          // removal (and never re-add a record we ourselves soft-deleted).
          if (localChanged && !item.deletedAt) merged.set(item.id, item);
        } else {
          // Brand-new local record the remote has never seen → add it.
          merged.set(item.id, item);
        }
        continue;
      }

      // Deliberately direction-sensitive: only a remote timestamp NEWER than the
      // known base proves someone else genuinely edited this record since we
      // last saw it. A remote read that comes back OLDER than base is GitHub's
      // read path serving a stale/lagging replica of a write we already know
      // succeeded (confirmed directly: a live conflict here showed 232 records
      // all reading a remote updatedAt from over an hour earlier than the base
      // this same session had already confirmed) — not a real edit by anyone.
      // Treating "different" as "changed" regardless of direction is what
      // manufactured a "concurrent edit" conflict out of nothing but CDN lag.
      const remoteChanged = !baseItem || remoteItem.updatedAt > baseItem.updatedAt;

      if (localChanged && remoteChanged && baseItem && sameContent(item, remoteItem)) {
        // Both sides made the IDENTICAL change (e.g. the same one-time data
        // repair run by two devices after an update) — nothing to reconcile.
        continue;
      }
      if (localChanged && remoteChanged && baseItem) {
        // Both sides edited a known common ancestor → genuine concurrent edit.
        // This used to throw and block the whole push (every other unrelated
        // edit stayed unpushed until a reload, which then resolved it by
        // timestamp anyway). Now: keep the later edit, and keep the other
        // version in the synced `syncConflicts` list so it can be reviewed
        // and restored (Settings → Data). Everything else merges normally.
        const localWins = (item.updatedAt || 0) >= (remoteItem.updatedAt || 0);
        if (localWins) merged.set(item.id, item);
        conflicts.push({
          collection: col,
          id: item.id,
          kept: localWins ? 'local' : 'remote',
          lost: structuredClone(localWins ? remoteItem : item),
          localUpdatedAt:  item.updatedAt ?? null,
          localUpdatedBy:  item.updatedBy ?? null,
          remoteUpdatedAt: remoteItem.updatedAt ?? null,
          remoteUpdatedBy: remoteItem.updatedBy ?? null,
          baseUpdatedAt:   baseItem.updatedAt ?? null,
          baseUpdatedBy:   baseItem.updatedBy ?? null
        });
        continue;
      }

      if (baseItem && localChanged && !remoteChanged) {
        // Only this device changed the record since the common ancestor: its
        // edit wins regardless of timestamps. Comparing clocks here let a
        // device whose clock runs behind another's lose its genuinely newer
        // edit (and applyMergedToUntouched then overwrote it locally too).
        merged.set(item.id, item);
        continue;
      }

      // No ancestor to arbitrate (e.g. a push after a failed initial pull).
      // Fall back to last-writer-wins by updatedAt so a STALE local cache can
      // never overwrite a fresher remote record — this is the root fix for
      // the cross-user data-loss bug.
      if ((item.updatedAt || 0) >= (remoteItem.updatedAt || 0)) {
        merged.set(item.id, item);
      }
      // else: remote is newer → keep it.
    }

    // Propagate local hard-deletes/purges, but never let a local deletion wipe a
    // record the remote has independently modified since the common ancestor.
    // Same direction-sensitivity as above: only a remote updatedAt NEWER than
    // base means it was genuinely touched since; a stale/lagging read that
    // comes back older (or exactly equal) hasn't, so the delete still applies.
    for (const id of baseMap.keys()) {
      if (localMap.has(id)) continue;
      const remoteItem = merged.get(id);
      const baseItem   = baseMap.get(id);
      if (!remoteItem || !baseItem || remoteItem.updatedAt <= baseItem.updatedAt) {
        merged.delete(id);
      }
    }

    // Final, unconditional backstop: never let a permanently-deleted id back
    // in, no matter what a stale fresh-fetch claims. This is what actually
    // closes the bug the comments above were guarding against with
    // timestamps alone — a stale `fresh` read can include an id neither
    // `base` nor `local` have anymore (both correctly reflect an earlier
    // successful delete), and nothing else in this function would catch
    // that, since the delete-propagation loop above only ever looks at ids
    // still present in `baseMap`.
    for (const [id, item] of merged) {
      if (isTombstoned(tombstones, col, item)) merged.delete(id);
    }

    result[col] = [...merged.values()];
  }
  result._mtimes = mtimes;

  if (conflicts.length > 0) {
    recordConflicts(result, conflicts, now);
    // Non-enumerable so it never reaches db.json; doPushDb reports it.
    Object.defineProperty(result, '_newConflicts', { value: conflicts, enumerable: false });
  }

  return result;
}

// Concurrent-edit losers, kept as ordinary synced records so every device
// sees them and one can be restored. Bounded: at most 200, and entries
// older than 60 days are dropped on the next conflict.
const CONFLICT_KEEP_MS = 60 * 24 * 60 * 60 * 1000;
function recordConflicts(result, conflicts, now) {
  const list = Array.isArray(result.syncConflicts) ? result.syncConflicts.filter(c => !c.deletedAt && now - (c.createdAt || 0) < CONFLICT_KEEP_MS) : [];
  for (const c of conflicts) {
    list.push({
      id: `cfl_${c.collection}_${c.id}_${now}`,
      collection: c.collection,
      recordId: c.id,
      kept: c.kept,
      lostVersion: c.lost,
      localUpdatedBy: c.localUpdatedBy,
      remoteUpdatedBy: c.remoteUpdatedBy,
      createdAt: now,
      updatedAt: now
    });
  }
  result.syncConflicts = list.slice(-200);
}

// Plain (non-record) top-level fields — `settings`, `appConfig` — used to be
// "local always wins" in every merge, so a device with a stale copy reverted
// other devices' settings changes (FX rates, business details…) on its next
// push. Now a proper 3-way merge against the last-synced base. `_mtimes`
// guards against GitHub's occasional stale read: a remote copy whose
// recorded change time for this field is OLDER than the base's is a lagging
// replica, not someone else's edit, and must not overwrite anything.
function mergePlainField(col, fresh, local, base, freshRemote, lastSynced) {
  const baseMt   = lastSynced?._mtimes?.[col] || 0;
  const remoteMt = freshRemote?._mtimes?.[col] || 0;
  const localChanged  = !deepEqual(local, base);
  const remoteChanged = !deepEqual(fresh, base) && remoteMt >= baseMt;
  if (!localChanged)  return { value: remoteChanged ? fresh : local, localChanged: false };
  if (!remoteChanged) return { value: local, localChanged: true };
  return { value: merge3(base, local, fresh), localChanged: true };
}

// ── Background-resync merge (last-writer-wins, no 3-way base) ────────────────
// Used by backgroundResync ONLY. Unlike mergeDb, this has no concept of a
// "base" — it simply keeps whichever version of each record has the higher
// updatedAt timestamp. This correctly handles CDN-stale responses: if GitHub's
// CDN returns an old version of a record (low updatedAt), the locally-held
// newer version wins. If another user genuinely updated a record (high updatedAt),
// the remote wins.
export function resyncDb(remote, local) {
  const result = structuredClone(remote);
  // True if this fetch of `remote` turned out to be missing/behind something
  // local already had — i.e. the fetch was stale relative to local. The
  // caller MUST NOT advance _syncedAt to "now" when this is true: it would
  // mark a record as confirmed-synced when this specific fetch never actually
  // saw it on GitHub, and the next reload's mergeLocalPending would then read
  // that false confirmation as "remote must have deleted this" and drop it.
  let staleFetch = false;
  // Union of every id ever permanently deleted, from either side — see
  // recordTombstone() in data.js.
  const tombstones = unionTombstones(remote?._tombstones, local?._tombstones);
  const remoteMt = remote?._mtimes || {};
  const localMt  = local?._mtimes || {};
  result._mtimes = { ...remoteMt };
  for (const col of Object.keys(local)) {
    if (col === '_tombstones') { result._tombstones = tombstones; continue; }
    if (col === '_mtimes') continue; // handled per field below
    const localArr = local[col];
    if (!Array.isArray(localArr)) {
      // Non-array fields (settings, config, etc.). This only runs when the
      // tab has nothing unpushed (backgroundResync bails while dirty), so
      // the local value is simply the last-synced one: take the remote's
      // when it records a NEWER change than we know of (another device
      // edited it), otherwise keep local — which also ignores a stale read.
      // Used to be "always local", so settings changed elsewhere never
      // reached an open tab and its next push reverted them.
      // `>=`: a differing value with an EQUAL stamp comes from an older app
      // version, which rewrites fields without updating _mtimes — i.e. a
      // genuine change elsewhere (a stale read carries an OLDER stamp).
      if (!col.startsWith('_') && remote[col] !== undefined && (remoteMt[col] || 0) >= (localMt[col] || 0)
          && !deepEqual(remote[col], localArr)) {
        // Keep result[col] — the remote value, already copied by the
        // structuredClone above. Never hand out `remote[col]` itself: `remote`
        // can be fetchDb's shared read-only snapshot, and this value ends up
        // in state.db, where settings are edited in place.
      } else {
        result[col] = localArr;
        if (localMt[col] !== undefined && (localMt[col] || 0) > (remoteMt[col] || 0)) result._mtimes[col] = localMt[col];
      }
      continue;
    }
    const remoteArr = result[col];
    if (!Array.isArray(remoteArr)) { result[col] = localArr; continue; }
    const map = new Map(remoteArr.map(x => [x.id, x]));
    for (const item of localArr) {
      const rv = map.get(item.id);
      // Local-only soft-deleted record that's absent from remote was purged
      // remotely (auto-purge of old deletions) — don't resurrect it, or the DB
      // re-bloats with dead records every sync. A genuine offline soft-delete
      // still exists on remote as active, so it takes the rv branch below.
      if (!rv && item.deletedAt) continue;
      if (!rv || (item.updatedAt || 0) > (rv.updatedAt || 0)) {
        // Local is newer or remote doesn't have it → keep local, and this
        // fetch is stale with respect to that record.
        map.set(item.id, item);
        staleFetch = true;
      }
      // else: remote is same-age or newer → already in map, keep remote.
    }
    // Unpushed hard deletes (records fully removed from state.db, e.g. via
    // Settings → "Delete Permanently") are kept out by their tombstone below —
    // every hard-delete path records one. A remote-only record is NOT inferred
    // "deleted here" from `updatedAt <= _syncedAt` any more: _syncedAt is
    // stamped when a fetch finishes, while another device's new record carries
    // the (earlier) time it was edited, so a record created elsewhere moments
    // before an idle tab's poll — or on a device whose clock runs slow — read
    // as deleted, was dropped here, and the tab's next push deleted it from
    // GitHub with no tombstone and no warning.
    // Tombstones are the only delete signal, independent of sync history — see
    // the matching comment in mergeDb().
    for (const [id, item] of map) {
      if (isTombstoned(tombstones, col, item)) map.delete(id);
    }
    result[col] = [...map.values()];
  }
  // Nothing local is unpushed when resync runs, so the result IS the
  // last-synced state of the plain fields.
  result._syncedPlain = plainFieldsOf(result);
  result._staleFetch = staleFetch;
  return result;
}

// ── Local cache ───────────────────────────────────────────────────────────────

// Called on sign-out so the full cached business dataset (payments, tenant
// PII, invoices, etc.) doesn't linger in localStorage — readable by anyone
// with access to the browser — after the user has logged out of the app.
// Deliberately does NOT also clear bt_github_config/the token: owner/repo/
// branch/path re-derive from the committed data/github-config.json fallback
// on next load either way, but wiping the token here risks the next login
// finding no local cache AND no token to refetch with, which would lock
// everyone out until an admin re-enters it in Settings.
export function clearCachedDb() {
  try {
    localStorage.removeItem(DB_LS_KEY);
    for (const k of journalKeys()) localStorage.removeItem(k);
  } catch { /* ignore */ }
  _pendingEncryptedCache = null;
}

// The cache is encrypted under the data key (see writeLocalCacheNow), which
// only exists in memory after sign-in — so on a fresh page load it can't be
// read yet. fetchLocalDb then returns null and keeps the envelope here;
// auth.js signs in first (which unlocks the key) and opens it afterwards.
let _pendingEncryptedCache = null;
export function hasPendingEncryptedCache() { return !!_pendingEncryptedCache; }
export async function openPendingEncryptedCache() {
  const env = _pendingEncryptedCache;
  if (!env) return null;
  try {
    const db = await decryptEnvelopeToJson(env);
    _pendingEncryptedCache = null;
    return db;
  } catch (e) {
    // Key rotated away / removed — the cached copy is unreadable, but the
    // pending-edits journals (small, separately encrypted) may still open.
    console.warn('[BT] Local cache could not be decrypted', e);
    if (e?.code === 'KEY_MISMATCH') _pendingEncryptedCache = null;
    return null;
  }
}

export async function fetchLocalDb() {
  const cached = localStorage.getItem(DB_LS_KEY);
  if (cached) {
    let parsed = null;
    try { parsed = JSON.parse(cached); } catch { /* corrupt, fall through */ }
    if (parsed && isEncryptedEnvelope(parsed)) {
      if (isUnlocked()) {
        try { return await decryptEnvelopeToJson(parsed); } catch { return null; }
      }
      _pendingEncryptedCache = parsed;
      return null;
    }
    // Legacy plaintext cache (written before the cache was encrypted):
    // used once, and replaced by an encrypted copy on the next cache write.
    if (parsed) return parsed;
  }
  // Locked, on a device that has already read db.json encrypted: the static
  // copy is an envelope that would be discarded below (return null) — skip
  // downloading it. Anything else (a legacy plaintext file, a device that
  // never saw an encrypted db.json) still goes through the download as before.
  if (!isUnlocked() && encryptedRemoteSeen()) return null;
  try {
    const res = await fetch('data/db.json', { cache: 'no-store' });
    if (res.ok) {
      const parsed = await res.json();
      if (isEncryptedEnvelope(parsed)) {
        // No local cache (e.g. right after sign-out) means this static-file
        // read is the only source we have — but without a key we can't turn
        // it into real data. Returning the raw envelope here would make the
        // caller think a valid (if empty/garbage) db loaded, skipping the
        // fetchDb() path that actually surfaces NO_ENC_KEY and prompts for
        // the key. Returning null instead defers to that path.
        if (!isUnlocked()) return null;
        return await decryptEnvelopeToJson(parsed);
      }
      return parsed;
    }
  } catch { /* ignore */ }
  return null;
}

export function mergeLocalPending(remoteDb, localCache) {
  const cols   = new Set([...Object.keys(remoteDb || {}), ...Object.keys(localCache || {})]);
  const result = {};
  let   hasLocalChanges = false;

  // _syncedAt is stamped onto the local cache every time we successfully pull
  // from GitHub. A local record can only override remote if it was modified
  // AFTER that point — proving it's a real offline edit, not a migrateDb stamp
  // or any other metadata backfill. Without _syncedAt (old or corrupted cache)
  // remote is fully authoritative and no local record can override it.
  const syncedAt = localCache?._syncedAt ?? null;
  // Defense-in-depth: this exact bug shape (some other code path stamping
  // _syncedAt a little too aggressively — e.g. a background poll that read a
  // stale copy of GitHub right after a push, before its write had propagated)
  // has recurred across several different sync paths in this codebase. Rather
  // than trust every future caller to get the stamping perfectly right, treat
  // the marker as this much earlier than it claims: a record created in that
  // window still isn't assumed confirmed. A push (or purge) that's genuinely
  // this stale is already a separate problem the retry/conflict UI surfaces;
  // this margin only protects against silently discarding real data.
  const effSyncedAt = syncedAt ? syncedAt - SYNC_SAFETY_MARGIN_MS : null;

  // Union of every id ever permanently deleted, from either side — see
  // recordTombstone() in data.js. Must survive this merge (it's excluded by
  // the "skip internal meta fields" line below like other `_`-prefixed keys)
  // so it keeps protecting future merges, not just this one.
  const tombstones = unionTombstones(remoteDb?._tombstones, localCache?._tombstones);
  if (remoteDb?._mtimes) result._mtimes = { ...remoteDb._mtimes };

  for (const col of cols) {
    if (col === '_tombstones') { result._tombstones = tombstones; continue; }
    if (col.startsWith('_')) continue; // skip internal meta fields
    const remote = remoteDb[col];
    const local  = localCache[col];

    if (!Array.isArray(remote) || !Array.isArray(local)) {
      // The remote records a change to this field made after this cache last
      // synced (another device edited it) → the remote value is newer. The
      // old rule below ("with sync history, local wins") reverted such edits
      // every time a device reloaded with an older cache.
      const rMt = remoteDb?._mtimes?.[col] || 0;
      const lMt = localCache?._mtimes?.[col] || 0;
      // With the last-synced copy of this field (_syncedPlain) available, do
      // a real 3-way merge: an unpushed local edit and another device's edit
      // to a different key both survive. (Without it, taking the whole remote
      // value silently dropped the local edit.) A remote whose stamp is OLDER
      // than the one this cache last saw is a stale read — keep local.
      const sp = localCache?._syncedPlain;
      if (syncedAt && sp && local !== undefined && remote !== undefined) {
        const value = rMt < lMt ? local : merge3(sp[col], local, remote);
        result[col] = value;
        if (!deepEqual(value, remote)) hasLocalChanges = true;
        continue;
      }
      if (remote !== undefined && rMt > lMt) { result[col] = remote; continue; }
      // Non-array fields (settings, appConfig): without sync history remote is
      // authoritative (old cache can't be trusted). With sync history local wins
      // because the user may have intentionally changed settings since last sync.
      result[col] = syncedAt ? (local ?? remote) : (remote ?? local);
      // These have no per-record timestamp to drive hasLocalChanges the way
      // the array branch below does — without this value comparison, a
      // settings-only edit made just before a reload/close (flushed to the
      // local cache but never pushed) had no way to mark itself unsynced,
      // and setDb() unconditionally clears state.dirty on load, so the edit
      // could be silently stranded, never reaching db.json for any other
      // device/user.
      if (syncedAt && local !== undefined && JSON.stringify(local) !== JSON.stringify(remote)) {
        hasLocalChanges = true;
      }
      continue;
    }

    // Remote is authoritative by default
    const merged   = new Map(remote.map(x => [x.id, x]));
    const localMap = new Map(local.map(x => [x.id, x]));

    for (const item of local) {
      const remoteItem = merged.get(item.id);
      if (!remoteItem) {
        // Local-only item: only keep if it was created after the last known sync,
        // which proves it's a genuine offline addition. Without sync history we
        // can't trust it — remote is authoritative (item may have been deleted remotely).
        if (!item.deletedAt && effSyncedAt && item.createdAt && item.createdAt > effSyncedAt) {
          merged.set(item.id, item);
          hasLocalChanges = true;
        }
      } else if (
        effSyncedAt &&
        item.updatedAt && item.updatedAt > effSyncedAt &&
        item.updatedAt > (remoteItem.updatedAt || 0)
      ) {
        // Local record was modified after the last sync AND is newer than remote:
        // this is a genuine offline edit — apply it.
        merged.set(item.id, item);
        hasLocalChanges = true;
      }
      // Otherwise: remote is same age or newer, or we have no sync baseline → remote wins
    }

    // Hard deletes (records fully removed from state.db, e.g. via Settings →
    // "Delete Permanently") that never made it to remote — e.g. the push that
    // would have carried the delete failed or hadn't fired yet before this
    // reload — are carried by their tombstone: every hard-delete path records
    // one in state.db._tombstones, which the cache keeps, so the union above
    // includes it. A remote-only record is NOT inferred "deleted here" from
    // `updatedAt <= _syncedAt` any more: _syncedAt is stamped when a fetch
    // finishes, while another device's new record carries the (earlier) time
    // it was edited, so a record created elsewhere just before this cache's
    // last sync — or on a device whose clock runs slow — was dropped on reload
    // and then deleted from GitHub by the next push.
    //
    // Tombstones are the only delete signal, independent of sync history — see
    // the matching comment in mergeDb(). A remote-only id that's tombstoned is
    // never resurrected here regardless of timestamps.
    for (const [id, item] of merged) {
      if (isTombstoned(tombstones, col, item)) {
        merged.delete(id);
        // Remote still has it, so the delete itself is an unpushed local change.
        if (!localMap.has(id)) hasLocalChanges = true;
      }
    }

    result[col] = [...merged.values()];
  }

  result._syncedPlain = plainFieldsOf(remoteDb);
  result._hasLocalChanges = hasLocalChanges;
  return result;
}

let _saveCacheTimer = null;
let _pendingSaveDb  = null;
let _cacheDisabled  = false;

// Called on sign-out: cancels any pending debounced write and ignores all
// further ones, so nothing re-creates the cache after clearCachedDb().
export function disableLocalCache() {
  _cacheDisabled = true;
  clearTimeout(_saveCacheTimer);
  _saveCacheTimer = null;
  _pendingSaveDb = null;
}

function stripHeavyFields(db) {
  const safe = { ...db };
  // Strip heavy fields that are already externalized to the GitHub repo
  // (invoice PDFs, expense receipt blobs, document blobs). They're
  // re-fetchable on demand and would otherwise blow the localStorage quota.
  // Soft-deleted records are intentionally kept so unpushed local deletions
  // survive an offline reload + merge.
  if (Array.isArray(safe.invoices)) {
    safe.invoices = safe.invoices.map(({ pdfData, ...rest }) => rest);
  }
  if (Array.isArray(safe.expenses)) {
    safe.expenses = safe.expenses.map(e => {
      if (!e.receipt?.data && !e.documents) return e;
      const copy = { ...e };
      if (copy.receipt?.data) copy.receipt = { ...copy.receipt, data: undefined };
      if (Array.isArray(copy.documents)) copy.documents = copy.documents.map(({ data, ...rest }) => rest);
      return copy;
    });
  }
  return safe;
}

// ── Pending-edits journal ────────────────────────────────────────────────────
// Besides the full cache, each tab keeps a small journal of what it has NOT
// pushed yet: the records whose updatedAt differs from the last-synced base,
// changed plain fields and new tombstones. It is keyed per tab, so
//   - two tabs no longer lose each other's unpushed edits by overwriting the
//     one shared cache key, and
//   - when the full cache no longer fits in localStorage, the (much smaller)
//     journal still does, and a reload re-applies it instead of silently
//     restoring an older snapshot.
// Journals are applied on load (applyPendingJournals) and removed once the
// edits they carry have been pushed.
const JOURNAL_PREFIX = 'bt_pending_';
const TAB_ID = (() => {
  try {
    let id = sessionStorage.getItem('bt_tab_id');
    if (!id) { id = crypto.randomUUID(); sessionStorage.setItem('bt_tab_id', id); }
    return id;
  } catch { return crypto.randomUUID(); }
})();
const OWN_JOURNAL_KEY = JOURNAL_PREFIX + TAB_ID;
let _appliedJournalKeys = [];

function journalKeys() {
  const out = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(JOURNAL_PREFIX)) out.push(k);
    }
  } catch { /* ignore */ }
  return out;
}

export function computeJournal(db, base) {
  if (!db || !base) return null;
  const j = { records: {}, plain: {}, mtimes: {}, tombstones: {} };
  let n = 0;
  for (const [col, val] of Object.entries(db)) {
    if (col.startsWith('_')) continue;
    if (Array.isArray(val)) {
      const bm = new Map((Array.isArray(base[col]) ? base[col] : []).map(x => [x.id, x]));
      const changed = val.filter(x => { const b = bm.get(x.id); return !b || b.updatedAt !== x.updatedAt; });
      if (changed.length) { j.records[col] = changed; n += changed.length; }
    } else if (val !== undefined && !deepEqual(val, base[col])) {
      j.plain[col] = val;
      j.mtimes[col] = db._mtimes?.[col] || 0;
      n++;
    }
  }
  for (const [k, ts] of Object.entries(db._tombstones || {})) {
    if (base._tombstones?.[k] === undefined) { j.tombstones[k] = ts; n++; }
  }
  return n ? j : null;
}

// Applies every journal found in this browser (this tab's from before a
// reload, other tabs', closed tabs') onto `db` — a record only where the
// journal's copy is newer than what `db` holds. Returns how many changes it
// applied; the caller then pushes them. The journal keys are remembered and
// removed after the next successful push.
export async function applyPendingJournals(db) {
  let applied = 0;
  const keys = [];
  for (const key of journalKeys()) {
    let j;
    try { j = await decryptEnvelopeToJson(JSON.parse(localStorage.getItem(key))); }
    catch { continue; } // unreadable (other key) — leave it
    keys.push(key);
    for (const [col, items] of Object.entries(j.records || {})) {
      if (!Array.isArray(db[col])) db[col] = [];
      const ix = new Map(db[col].map((x, i) => [x.id, i]));
      for (const item of items) {
        const i = ix.get(item.id);
        if (i === undefined) { db[col].push(item); ix.set(item.id, db[col].length - 1); applied++; }
        else if ((item.updatedAt || 0) > (db[col][i].updatedAt || 0)) { db[col][i] = item; applied++; }
      }
    }
    for (const [col, val] of Object.entries(j.plain || {})) {
      if ((j.mtimes?.[col] || 0) >= (db._mtimes?.[col] || 0) && !deepEqual(db[col], val)) { db[col] = val; applied++; }
    }
    const newTs = Object.keys(j.tombstones || {}).filter(k => db._tombstones?.[k] === undefined);
    if (newTs.length) {
      db._tombstones = unionTombstones(db._tombstones, j.tombstones);
      for (const k of newTs) {
        const [col, ...rest] = k.split(':');
        const id = rest.join(':');
        if (Array.isArray(db[col])) db[col] = db[col].filter(x => !(x.id === id && isTombstoned(db._tombstones, col, x)));
      }
      applied += newTs.length;
    }
  }
  _appliedJournalKeys = keys.filter(k => k !== OWN_JOURNAL_KEY);
  return applied;
}

// After a successful push: other tabs' journals applied at load are now on
// GitHub (a still-open tab simply rewrites its own on its next cache write).
function dropAppliedJournals() {
  for (const k of _appliedJournalKeys) { try { localStorage.removeItem(k); } catch { /* ignore */ } }
  _appliedJournalKeys = [];
}

// ── Encrypted local cache ────────────────────────────────────────────────────
// The cache holds the whole database, so it is written only encrypted (under
// the data key, gzipped inside the envelope where supported — ~5-8x smaller,
// which also keeps it well inside the localStorage quota). A device without
// an unlocked key writes nothing: it could not have loaded real data anyway.
let _cacheWriteSeq = 0;
async function writeLocalCacheNow(db) {
  if (_cacheDisabled || !db) return;
  if (!isUnlocked()) return;
  const seq = ++_cacheWriteSeq;
  let cacheJson, journalJson = null;
  try {
    cacheJson = JSON.stringify(await encryptJsonToEnvelope(stripHeavyFields(db), { compress: supportsCompression() }));
    const j = computeJournal(db, state.github.remoteDb);
    if (j && state.dirty) journalJson = JSON.stringify(await encryptJsonToEnvelope(j, { compress: supportsCompression() }));
  } catch (e) { console.warn('saveLocalCache: encrypt failed', e); return; }
  // A newer write started while this one was encrypting — let it win.
  if (seq !== _cacheWriteSeq || _cacheDisabled) return;
  // Journal first: it is small and is what protects unpushed edits.
  try {
    if (journalJson) localStorage.setItem(OWN_JOURNAL_KEY, journalJson);
    else localStorage.removeItem(OWN_JOURNAL_KEY);
  } catch (e) { console.warn('saveLocalCache: journal', e); }
  try {
    localStorage.setItem(DB_LS_KEY, cacheJson);
    state.github.cacheQuotaFull = false;
  } catch (e) {
    console.warn('saveLocalCache:', e);
    if (e.name === 'QuotaExceededError') {
      // Never leave the previous (now stale) snapshot behind: a reload would
      // restore it and silently lose everything since. Without it the next
      // load pulls from GitHub and re-applies the journal.
      try { localStorage.removeItem(DB_LS_KEY); } catch { /* ignore */ }
      state.github.cacheQuotaFull = true;
      notify('cache-quota-exceeded');
      import('./ui.js').then(({ toast }) =>
        toast('Local cache full — this browser will load from GitHub next time. Unsaved changes are still kept. Purge deleted records in Settings → Data to free space.', 'warning', 8000)
      ).catch(() => {});
    }
  }
}

export function saveLocalCache(db) {
  _pendingSaveDb = db;
  clearTimeout(_saveCacheTimer);
  _saveCacheTimer = setTimeout(() => {
    _saveCacheTimer = null;
    const toSave = _pendingSaveDb;
    _pendingSaveDb = null;
    writeLocalCacheNow(toSave).catch(() => {});
  }, 250);
}

// Writes whatever saveLocalCache() has queued, bypassing its debounce — call
// from beforeunload / pagehide / visibilitychange(hidden). Encryption is
// asynchronous, so this is best-effort when the page is being torn down; the
// short debounce above keeps that window small, and beforeunload still warns
// while anything is unpushed.
export function flushLocalCache() {
  if (!_saveCacheTimer) return Promise.resolve();
  clearTimeout(_saveCacheTimer);
  _saveCacheTimer = null;
  const toSave = _pendingSaveDb;
  _pendingSaveDb = null;
  return toSave ? writeLocalCacheNow(toSave).catch(() => {}) : Promise.resolve();
}

// ── File storage (invoice PDFs, etc.) ────────────────────────────────────────

// Files the app may write unencrypted: only the bootstrap config, which holds
// nothing but owner/repo/branch/path (see settings.js pushBootstrapConfig).
const PLAINTEXT_UPLOAD_ALLOWED = new Set(['data/github-config.json']);

// True when base64 content is one of this app's encrypted formats: the
// BTX1 byte container (encryptBytes: magic + 12-byte IV + ciphertext with a
// 16-byte tag) or a JSON envelope (encryptJsonToEnvelope / the debug-key
// envelope: only enc/iv/ct plus the known metadata keys, a 12-byte IV and a
// non-trivial ciphertext). A structural check, not just a prefix match, so
// plaintext that merely starts with the magic bytes or with {"enc":1 is
// refused.
const ENVELOPE_KEYS = new Set(['enc', 'iv', 'ct', 'kid', 'v', 'z']);
function b64Len(b64) {
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor(b64.length * 3 / 4) - pad;
}
export function isEncryptedUpload(b64Content) {
  const b64 = String(b64Content || '').replace(/\s/g, '');
  const head64 = b64.slice(0, 96);
  let head;
  try { head = Uint8Array.from(atob(head64.slice(0, head64.length - (head64.length % 4))), c => c.charCodeAt(0)); }
  catch { return false; }
  if (isEncryptedBytes(head)) return b64Len(b64) >= 4 + 12 + 16;
  const text = new TextDecoder('utf-8', { fatal: false }).decode(head);
  if (!/^\s*\{\s*"enc"\s*:\s*1\s*,/.test(text)) return false;
  let env;
  try { env = JSON.parse(decodeURIComponent(escape(atob(b64)))); } catch { return false; }
  if (!env || typeof env !== 'object' || Array.isArray(env)) return false;
  if (!Object.keys(env).every(k => ENVELOPE_KEYS.has(k))) return false;
  if (env.enc !== 1 || typeof env.iv !== 'string' || typeof env.ct !== 'string') return false;
  try { if (atob(env.iv).length !== 12 || atob(env.ct).length < 16) return false; } catch { return false; }
  return true;
}

/**
 * Upload or replace a file in the GitHub repo.
 * @param {string} path       - repo-relative path, e.g. "invoices/inv_abc.pdf"
 * @param {string} b64Content - base64-encoded file content (no data-URL prefix)
 * @param {string} message    - commit message
 * @param {{assumeNew?: boolean}} [opts] - assumeNew: the path is freshly
 *   generated and almost certainly doesn't exist yet, so the first attempt
 *   PUTs without looking up a sha; if the file does exist (409/422), the
 *   next attempt looks it up as usual. Leave unset for overwrites.
 * @returns {Promise<{sha: string}>}
 */
export async function uploadGithubFile(path, b64Content, message = 'Upload file', { assumeNew = false } = {}) {
  const { owner, repo, branch, token } = state.github;
  if (!owner || !repo || !token) throw new Error('GitHub not configured — add owner/repo/token in Settings');

  // Normalise path: strip any accidental leading slash so files always land
  // inside their intended folder, not the repo root.
  const cleanPath = path.replace(/^\/+/, '');
  const encodedPath = cleanPath.split('/').map(encodeURIComponent).join('/');

  // Last line of defence: the repo is public, so nothing but an encrypted
  // file may be written to it (see isEncryptedUpload). Callers are expected
  // to encrypt; this catches any path that forgets to.
  if (!PLAINTEXT_UPLOAD_ALLOWED.has(cleanPath) && !isEncryptedUpload(b64Content)) {
    const err = new Error(`Refusing to upload "${cleanPath}" unencrypted — unlock the encryption key in Settings → Encryption first. Nothing was uploaded.`);
    err.code = 'NO_ENC_KEY';
    throw err;
  }

  const headers = {
    'Accept':        'application/vnd.github+json',
    'Authorization': `token ${token}`,
    'Content-Type':  'application/json'
  };
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${encodedPath}`;
  const ATTEMPTS = 6;

  let lastErr = null;
  let skipShaLookup = assumeNew;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    // Re-read the file's current SHA on every attempt (required for updates).
    // A 404 means the file doesn't exist yet — create it by omitting the sha.
    // If-None-Match forces the CDN to revalidate so we don't PUT against a stale
    // SHA. GitHub creates parent directories automatically.
    // (Skipped once for assumeNew: a PUT without a sha never overwrites an
    // existing file — GitHub rejects it — so trying it first is safe.)
    const blind = skipShaLookup;
    skipShaLookup = false;
    let existingSha = null;
    if (!blind) {
      try {
        const check = await ghFetch(
          `${apiUrl}?ref=${encodeURIComponent(branch || 'main')}`,
          { headers: { ...headers, 'If-None-Match': `"${Date.now()}"` }, cache: 'no-store' }
        );
        if (check.ok) {
          const d = await check.json();
          existingSha = d.sha;
        }
        // 404 → file does not exist yet; proceed to create without sha
      } catch { /* network error during existence check — proceed anyway */ }
    }

    const body = { message, content: b64Content, branch: branch || 'main' };
    if (existingSha) body.sha = existingSha;

    let res;
    try {
      res = await ghFetch(apiUrl, { method: 'PUT', headers, body: JSON.stringify(body) });
    } catch {
      // A dropped connection here threw a raw TypeError that skipped this
      // retry loop entirely — the surrounding ATTEMPTS loop only covered the
      // 409-conflict path, not the upload PUT itself failing outright.
      if (attempt < ATTEMPTS) { lastErr = 'network error'; await sleep(backoff(attempt)); continue; }
      throw new Error(`Cannot reach GitHub while uploading "${cleanPath}"`);
    }
    if (res.ok) {
      const data = await res.json();
      return { sha: data.content.sha };
    }

    // The blind create hit an existing file (GitHub: 422 "sha wasn't
    // supplied", or 409) — look the sha up and retry right away.
    if (blind && (res.status === 409 || res.status === 422) && attempt < ATTEMPTS) {
      lastErr = `${res.status} file exists`;
      continue;
    }

    // 409 = the file changed between our GET and PUT (concurrent/parallel upload
    // or stale CDN SHA). Re-read the fresh SHA and retry instead of failing.
    if (res.status === 409 && attempt < ATTEMPTS) {
      lastErr = '409 SHA conflict';
      await sleep(backoff(attempt));
      continue;
    }

    if (res.status === 403) {
      const waitMs = rateLimitWaitMs(res);
      if (waitMs > 0 && attempt < ATTEMPTS) { lastErr = 'rate limited'; await sleep(waitMs); continue; }
      if (waitMs > 0) throw new Error('GitHub rate limit exceeded — try again shortly');
    }

    let errBody = '';
    try { errBody = await res.text(); } catch { /* ignore */ }
    console.error(`GitHub file upload failed (${res.status}) for path "${cleanPath}":`, errBody);
    if (res.status === 401 || res.status === 403) throw new Error('Token lacks write access');
    if (res.status === 404) throw new Error(`Repository or branch not found (404). Check owner/repo/branch settings. Path: ${cleanPath}`);
    throw new Error(`File upload failed (${res.status}): ${errBody}`);
  }

  throw new Error(`File upload failed after ${ATTEMPTS} attempts (${lastErr}) for path "${cleanPath}"`);
}

// Chunked (0x8000-byte String.fromCharCode.apply) rather than one string
// concatenation per byte — see crypto.js bytesToBase64.
function rawBytesToBase64(bytes) {
  return bytesToBase64(bytes);
}

function base64ToRawBytes(b64) {
  return base64ToBytes(b64.replace(/\s/g, ''));
}

/**
 * Same as uploadGithubFile, but encrypts the file's bytes first when this
 * device has a data key configured — use for anything holding business data
 * (documents, invoice PDFs, receipts). Do NOT use for files meant to stay
 * plain (the public daily-rate feed, the bootstrap config file).
 * @param {string} path      - repo-relative path
 * @param {string} b64Content - base64-encoded file content (same shape callers already produce)
 * @param {string} message   - commit message
 */
export async function uploadGithubFileEncrypted(path, b64Content, message = 'Upload file', opts = {}) {
  // Never falls back to a plaintext upload: the repo is public.
  if (!isUnlocked()) {
    const err = new Error('Encryption key not unlocked on this device — unlock it in Settings → Encryption before uploading. Nothing was uploaded.');
    err.code = 'NO_ENC_KEY';
    throw err;
  }
  const encrypted = await encryptBytes(base64ToRawBytes(b64Content));
  return uploadGithubFile(path, rawBytesToBase64(encrypted), message, opts);
}

/**
 * List files directly inside a folder in the GitHub repo.
 * Returns an empty array if the folder does not exist (404).
 * Subdirectories are excluded; only immediate file children are returned.
 * @param {string} folderPath - repo-relative path, e.g. "invoices"
 * @returns {Promise<Array<{name: string, path: string, sha: string, size: number}>>}
 */
export async function listGithubFolder(folderPath) {
  const { owner, repo, branch, token } = state.github;
  if (!owner || !repo) throw new Error('GitHub not configured');

  const headers = { 'Accept': 'application/vnd.github+json' };
  if (token) headers['Authorization'] = `token ${token}`;

  const cleanPath = folderPath.replace(/^\/+|\/+$/g, '');
  const encodedPath = cleanPath.split('/').map(encodeURIComponent).join('/');
  const res = await ghFetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(branch || 'main')}`,
    { headers, cache: 'no-store' }
  );
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`Folder listing failed (${res.status})`);
  const data = await res.json();
  return Array.isArray(data) ? data.filter(f => f.type === 'file') : [];
}

/**
 * Fetch metadata + base64 content of a file from the GitHub repo.
 * @param {string} path - repo-relative path
 * @returns {Promise<{content: string, sha: string, download_url: string}>}
 */
export async function fetchGithubFile(path) {
  const { owner, repo, branch, token } = state.github;
  if (!owner || !repo) throw new Error('GitHub not configured');

  const headers = { 'Accept': 'application/vnd.github+json' };
  if (token) headers['Authorization'] = `token ${token}`;

  const encodedPath = path.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/');
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(branch || 'main')}`;

  let res = await ghFetch(url, { headers, cache: 'no-store' });
  if (res.status === 403) {
    const waitMs = rateLimitWaitMs(res);
    if (waitMs > 0) { await sleep(waitMs); res = await ghFetch(url, { headers, cache: 'no-store' }); }
  }
  if (!res.ok) {
    if (res.status === 404) throw new Error('File not found in repository');
    if (res.status === 403 && rateLimitWaitMs(res) > 0) throw new Error('GitHub rate limit exceeded — try again shortly');
    if (res.status === 401 || res.status === 403) throw new Error('GitHub auth failed — check your token');
    throw new Error(`File fetch failed (${res.status})`);
  }
  const data = await res.json(); // { content (b64), sha, download_url, ... }
  // The Contents API only inlines `content` for files up to 1MB — past that
  // it returns an empty string (encoding "none"). Daily backups can exceed that,
  // so without this fallback "Restore from Backup" (and key rotation, which
  // re-reads every backup) always failed with "Unexpected end of JSON input".
  // The git blobs API returns base64 content for files up to 100MB, with the
  // same auth, so callers keep receiving the same { content: base64 } shape.
  if (!data.content && data.sha && data.type !== 'dir') {
    data.content = await fetchGithubBlobBase64(data.sha);
  }
  return data;
}

async function fetchGithubBlobBase64(sha) {
  const { owner, repo, token } = state.github;
  const headers = { 'Accept': 'application/vnd.github+json' };
  if (token) headers['Authorization'] = `token ${token}`;
  const url = `https://api.github.com/repos/${owner}/${repo}/git/blobs/${sha}`;
  let res = await ghFetch(url, { headers, cache: 'no-store' });
  if (res.status === 403) {
    const waitMs = rateLimitWaitMs(res);
    if (waitMs > 0) { await sleep(waitMs); res = await ghFetch(url, { headers, cache: 'no-store' }); }
  }
  if (!res.ok) throw new Error(`File download failed (${res.status})`);
  const blob = await res.json();
  if (blob.encoding !== 'base64' || typeof blob.content !== 'string') {
    throw new Error('File download returned an unexpected encoding');
  }
  return blob.content.replace(/\s/g, '');
}

/**
 * Same as fetchGithubFile, but transparently decrypts the content when it
 * was encrypted (auto-detected via isEncryptedBytes) — pairs with
 * uploadGithubFileEncrypted. A legacy/never-encrypted file is returned as-is,
 * so this is safe to use on old data during migration.
 * @param {string} path - repo-relative path
 * @returns {Promise<{content: string, sha: string, download_url: string}>}
 */
export async function fetchGithubFileEncrypted(path) {
  const fileData = await fetchGithubFile(path);
  const bytes = base64ToRawBytes(fileData.content);
  if (!isEncryptedBytes(bytes)) return fileData;
  const decrypted = await decryptBytes(bytes);
  return { ...fileData, content: rawBytesToBase64(decrypted) };
}

/**
 * Delete a file from the GitHub repo.
 * Silently succeeds if the file is already gone (404).
 * @param {string} path    - repo-relative path
 * @param {string} sha     - blob SHA (from a prior fetchGithubFile call); if unknown pass null and we'll look it up
 * @param {string} message - commit message
 */
export async function deleteGithubFile(path, sha = null, message = 'Delete file') {
  const { owner, repo, branch, token } = state.github;
  if (!owner || !repo || !token) throw new Error('GitHub not configured');

  const headers = {
    'Accept':        'application/vnd.github+json',
    'Authorization': `token ${token}`,
    'Content-Type':  'application/json'
  };
  const encodedPath = path.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/');
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${encodedPath}`;

  // Resolve SHA if caller didn't provide one
  if (!sha) {
    try {
      const check = await ghFetch(`${apiUrl}?ref=${encodeURIComponent(branch || 'main')}`, { headers, cache: 'no-store' });
      if (!check.ok) return; // already gone
      const d = await check.json();
      sha = d.sha;
    } catch { return; }
  }

  // Unlike uploadGithubFile, this had no retry loop at all — a single dropped
  // connection failed the delete outright with no chance to recover.
  const ATTEMPTS = 4;
  let lastErr = null;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    let res;
    try {
      res = await ghFetch(apiUrl, {
        method:  'DELETE',
        headers,
        body:    JSON.stringify({ message, sha, branch: branch || 'main' })
      });
    } catch {
      if (attempt < ATTEMPTS) { lastErr = 'network error'; await sleep(backoff(attempt)); continue; }
      throw new Error(`Cannot reach GitHub while deleting "${path}"`);
    }
    if (res.ok || res.status === 404) return;

    // 409 = sha went stale between lookup and delete — re-resolve and retry
    if (res.status === 409 && attempt < ATTEMPTS) {
      lastErr = '409 SHA conflict';
      try {
        const check = await ghFetch(`${apiUrl}?ref=${encodeURIComponent(branch || 'main')}`, { headers, cache: 'no-store' });
        if (!check.ok) return; // gone now
        sha = (await check.json()).sha;
      } catch { /* keep existing sha, retry with it anyway */ }
      await sleep(150 + Math.random() * 200);
      continue;
    }

    if (res.status === 403) {
      const waitMs = rateLimitWaitMs(res);
      if (waitMs > 0 && attempt < ATTEMPTS) { lastErr = 'rate limited'; await sleep(waitMs); continue; }
      if (waitMs > 0) throw new Error('GitHub rate limit exceeded — try again shortly');
    }

    throw new Error(`File delete failed (${res.status})`);
  }

  throw new Error(`File delete failed after ${ATTEMPTS} attempts (${lastErr}) for path "${path}"`);
}

// ── Snapshot branches (public files that must not accumulate history) ────────
// Some public files (the STR daily-rate feeds) only ever need their CURRENT
// content. Committing them to main kept every past version in the public git
// history. A snapshot branch instead holds exactly one commit with no parent:
// each publish builds a fresh tree + parentless commit and force-moves the
// branch to it, so the branch never carries more than the current files.

async function ghApi(method, apiPath, body) {
  const { owner, repo, token } = state.github;
  if (!owner || !repo || !token) throw new Error('GitHub not configured — add owner/repo/token in Settings');
  const headers = {
    'Accept':        'application/vnd.github+json',
    'Authorization': `token ${token}`,
    'Content-Type':  'application/json'
  };
  const url = `https://api.github.com/repos/${owner}/${repo}${apiPath}`;
  const ATTEMPTS = 4;
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await ghFetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
    } catch {
      if (attempt < ATTEMPTS) { await sleep(backoff(attempt)); continue; }
      throw new Error(`Cannot reach GitHub (${method} ${apiPath})`);
    }
    if (res.status === 403 && attempt < ATTEMPTS) {
      const waitMs = rateLimitWaitMs(res);
      if (waitMs > 0) { await sleep(waitMs); continue; }
    }
    if (res.status >= 500 && attempt < ATTEMPTS) { await sleep(backoff(attempt)); continue; }
    return res;
  }
}

/**
 * Replace `branchName` with a single parentless commit containing exactly
 * `files` (text only). Creates the branch if it doesn't exist yet.
 * @param {string} branchName - e.g. "rates-feed" (never the data branch)
 * @param {Array<{path: string, content: string}>} files - repo-relative paths, UTF-8 text
 * @param {string} message - commit message
 * @returns {Promise<{commit: string}>}
 */
export async function publishSnapshotBranch(branchName, files, message) {
  if (!branchName || branchName === (state.github.branch || 'main')) {
    throw new Error('Refusing to replace the data branch with a snapshot');
  }
  const fail = async (res, what) => {
    let t = ''; try { t = await res.text(); } catch { /* ignore */ }
    if (res.status === 401 || res.status === 403) throw new Error('Token lacks write access');
    throw new Error(`${what} failed (${res.status}): ${t}`);
  };
  const tree = files.map(f => ({ path: f.path.replace(/^\/+/, ''), mode: '100644', type: 'blob', content: f.content }));
  const treeRes = await ghApi('POST', '/git/trees', { tree });
  if (!treeRes.ok) await fail(treeRes, 'Creating feed tree');
  const treeSha = (await treeRes.json()).sha;

  const commitRes = await ghApi('POST', '/git/commits', { message, tree: treeSha, parents: [] });
  if (!commitRes.ok) await fail(commitRes, 'Creating feed commit');
  const commitSha = (await commitRes.json()).sha;

  const refPath = `/git/refs/heads/${branchName.split('/').map(encodeURIComponent).join('/')}`;
  let refRes = await ghApi('PATCH', refPath, { sha: commitSha, force: true });
  if (refRes.status === 422 || refRes.status === 404) {
    // Branch doesn't exist yet — create it.
    refRes = await ghApi('POST', '/git/refs', { ref: `refs/heads/${branchName}`, sha: commitSha });
    // 422 here = someone else created it in the meantime; move it instead.
    if (refRes.status === 422) refRes = await ghApi('PATCH', refPath, { sha: commitSha, force: true });
  }
  if (!refRes.ok) await fail(refRes, `Updating branch ${branchName}`);
  return { commit: commitSha };
}

/**
 * Read a UTF-8 text file from a specific branch. Returns null if the file
 * (or the branch) doesn't exist.
 */
export async function fetchBranchFileText(branchName, path) {
  const encodedPath = path.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/');
  const res = await ghApi('GET', `/contents/${encodedPath}?ref=${encodeURIComponent(branchName)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`File fetch failed (${res.status})`);
  const data = await res.json();
  const b64 = data.content || (data.sha ? await fetchGithubBlobBase64(data.sha) : '');
  return b64decode(b64);
}

/**
 * Fire a repository_dispatch event on this repo (lets a workflow react to
 * something the app did that isn't a push to a workflow-carrying branch).
 * Best-effort: resolves false instead of throwing.
 */
export async function dispatchRepoEvent(eventType) {
  try {
    const res = await ghApi('POST', '/dispatches', { event_type: eventType });
    return res.ok;
  } catch { return false; }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Exponential backoff with full jitter (a uniformly random wait up to the
// exponential cap, plus a small floor) — spreads out several clients that hit
// the same SHA conflict far better than a fixed base + small jitter, which
// kept them retrying nearly in lockstep.
function backoff(attempt) {
  return 100 + Math.random() * Math.min(8000, 250 * 2 ** attempt);
}
