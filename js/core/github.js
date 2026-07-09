// GitHub API layer — direct calls from the frontend using a PAT stored in db.json.
import { state, notify, invalidateActiveCache } from './state.js';

const DB_LS_KEY  = 'bt_db_cache';
const CFG_LS_KEY = 'bt_github_config';

// Used by mergeLocalPending(): a record's sync marker is treated as this much
// earlier than it claims before trusting it to decide whether a local-only
// addition is a genuine offline edit. Deliberately NOT used for delete
// propagation (in either mergeLocalPending or resyncDb) — see the comments
// at each function's delete-propagation step for why. See mergeLocalPending()
// below for the full rationale.
const SYNC_SAFETY_MARGIN_MS = 15 * 60 * 1000; // 15 minutes

let pushQueue = Promise.resolve();
let _sizeWarned = false; // throttles the db.json size-warning toast to once per session per threshold-crossing

// ── Config ───────────────────────────────────────────────────────────────────

export function loadConfig() {
  try {
    const cfg = JSON.parse(localStorage.getItem(CFG_LS_KEY) || '{}');
    state.github.owner  = cfg.owner  || '';
    state.github.repo   = cfg.repo   || '';
    state.github.branch = cfg.branch || 'main';
    state.github.dbPath = cfg.path   || 'data/db.json';
    state.github.token  = cfg.token  || '';
  } catch { /* ignore */ }
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
  try {
    localStorage.setItem(CFG_LS_KEY, JSON.stringify({
      owner:  state.github.owner,
      repo:   state.github.repo,
      branch: state.github.branch,
      path:   state.github.dbPath,
      token:  state.github.token   // preserve the current localStorage-sourced token
    }));
  } catch { /* ignore */ }
}

export function saveConfig({ owner, repo, branch, dbPath, token }) {
  state.github.owner  = owner  || '';
  state.github.repo   = repo   || '';
  state.github.branch = branch || 'main';
  state.github.dbPath = dbPath || 'data/db.json';
  if (token !== undefined) state.github.token = token || '';
  try {
    localStorage.setItem(CFG_LS_KEY, JSON.stringify({
      owner:  state.github.owner,
      repo:   state.github.repo,
      branch: state.github.branch,
      path:   state.github.dbPath,
      token:  state.github.token
    }));
  } catch { /* ignore */ }
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

export async function fetchDb() {
  const { owner, repo, branch, dbPath, token } = state.github;
  if (!owner || !repo) throw new Error('GitHub not configured');

  const headers = { 'Accept': 'application/vnd.github+json', 'If-None-Match': `"${Date.now()}"` };
  if (token) headers['Authorization'] = `token ${token}`;

  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${dbPath}?ref=${encodeURIComponent(branch || 'main')}`;

  const ATTEMPTS = 3;
  let res;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try { res = await fetch(url, { headers, cache: 'no-store' }); }
    catch { throw new Error('Cannot reach GitHub — check your internet connection'); }

    if (res.status === 403 && attempt < ATTEMPTS) {
      const waitMs = rateLimitWaitMs(res);
      if (waitMs > 0) { await sleep(waitMs); continue; }
    }
    break;
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
  const { sha, content, download_url } = data;

  let parsed;
  if (content) {
    parsed = safeParseDb(b64decode(content));
  } else if (download_url) {
    const bustUrl = download_url.includes('?')
      ? `${download_url}&_=${Date.now()}`
      : `${download_url}?_=${Date.now()}`;
    const raw = await fetch(bustUrl, { cache: 'no-store' }).then(r => {
      if (!r.ok) throw new Error(`Download failed (${r.status})`);
      return r.text();
    });
    parsed = safeParseDb(raw);
  } else {
    throw new Error('GitHub returned no content');
  }

  state.github.sha           = sha;
  state.github.connected     = true;
  state.github.lastPullOk    = true;
  state.github.usingCache    = false;
  state.github.lastPulledAt  = Date.now();
  state.github.lastSyncError = null;
  state.github.remoteDb      = structuredClone(parsed);
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
      const tombstones = { ...freshBase._tombstones, ...state.db._tombstones };
      for (const [col, items] of Object.entries(freshBase)) {
        if (!Array.isArray(items) || !Array.isArray(state.db[col])) continue;
        const localIds = new Set(state.db[col].map(x => x.id));
        for (const item of items) {
          if (!localIds.has(item.id) && tombstones[`${col}:${item.id}`] === undefined) {
            state.db[col].push(item);
            localIds.add(item.id);
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
  // Never push the token to GitHub — strip it from appConfig before computing content
  if (snapshot.appConfig?.github?.token) delete snapshot.appConfig.github.token;
  // mergeDb only reads `base` (the last-synced snapshot), so we can reference
  // remoteDb directly instead of cloning the whole DB again on every push.
  const base     = state.github.remoteDb || null;
  let   lastError = null;

  for (let attempt = 1; attempt <= 8; attempt++) {
    // GET current SHA + content — append timestamp to bypass GitHub's edge-cache,
    // which can return a stale SHA even when cache: 'no-store' is set.
    // If-None-Match with a unique value forces GitHub's Fastly CDN to revalidate
    // with origin on every attempt — it's in GitHub's CORS allow-list unlike Cache-Control.
    const getHeaders = { ...ghHeaders, 'If-None-Match': `"${Date.now()}"` };
    let getRes;
    try {
      getRes = await fetch(`${apiBase}?ref=${encodeURIComponent(branch || 'main')}`, {
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
    const { sha } = getData;
    let freshDb;
    if (getData.content) {
      freshDb = safeParseDb(b64decode(getData.content));
    } else if (getData.download_url) {
      // Bust CDN cache on the raw download URL too, same as the API GET above.
      const bustUrl = getData.download_url.includes('?')
        ? `${getData.download_url}&_=${Date.now()}`
        : `${getData.download_url}?_=${Date.now()}`;
      const raw = await fetch(bustUrl, { cache: 'no-store' }).then(r => {
        if (!r.ok) throw new Error(`Download failed (${r.status})`);
        return r.text();
      });
      freshDb = safeParseDb(raw);
    } else {
      throw new Error('GitHub returned no content for db.json');
    }
    const merged  = mergeDb(freshDb, snapshot, base);
    if (merged.appConfig?.github?.token) delete merged.appConfig.github.token;

    // PUT merged content
    const jsonStr = JSON.stringify(merged);
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
      putRes = await fetch(apiBase, {
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

    if (putRes.status === 409) {
      lastError = 'SHA conflict';
      // Each retry re-GETs the current SHA, so we don't need to wait for CDN
      // expiry — just pause briefly to avoid hammering and retry immediately.
      if (attempt < 8) { await sleep(150 + Math.random() * 100); continue; }
      break; // exhausted — fall through to ConflictError below
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

    state.github.sha          = newSha;
    state.github.remoteDb     = structuredClone(merged);
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
          state.db[col].push(item);
          // Keep the id index in sync — this path bypasses upsert/markDirty,
          // so byId() would otherwise miss remote-adopted records until reload.
          state._ix?.get(col)?.set(item.id, item);
          adopted = true;
        }
      }
    }
    // Adopting records changes the active set without going through markDirty.
    if (adopted) invalidateActiveCache();

    saveLocalCache(state.db);
    return { sha: newSha };
  }

  // All retries exhausted with SHA conflicts — treat as ConflictError so
  // doSave stops re-queuing and prompts the user to refresh instead.
  const err = new Error('SHA conflict after retries — refresh the page to resync');
  err.name = 'ConflictError';
  throw err;
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
  const tombstones = { ...(freshRemote?._tombstones), ...(lastSynced?._tombstones), ...(localCurrent?._tombstones) };

  for (const col of cols) {
    if (col === '_tombstones') { result._tombstones = tombstones; continue; }
    const fresh = freshRemote[col];
    const local = localCurrent[col];
    const base  = lastSynced ? lastSynced[col] : undefined;

    if (!Array.isArray(local) || !Array.isArray(fresh)) {
      result[col] = local !== undefined ? local : fresh;
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

      if (localChanged && remoteChanged && baseItem) {
        // Both sides edited a known common ancestor → genuine concurrent-edit conflict.
        // Carry enough detail to diagnose from the console without reproducing —
        // this exact 3-way check has been the source of confusing false positives
        // (e.g. a write that re-stamps updatedAt without changing any real field).
        conflicts.push({
          collection: col,
          id: item.id,
          localUpdatedAt:  item.updatedAt ?? null,
          localUpdatedBy:  item.updatedBy ?? null,
          remoteUpdatedAt: remoteItem.updatedAt ?? null,
          remoteUpdatedBy: remoteItem.updatedBy ?? null,
          baseUpdatedAt:   baseItem.updatedAt ?? null,
          baseUpdatedBy:   baseItem.updatedBy ?? null
        });
        continue;
      }

      // Either only the local side changed, or there is no ancestor to arbitrate
      // (e.g. a push after a failed initial pull). Fall back to last-writer-wins
      // by updatedAt so a STALE local cache can never overwrite a fresher remote
      // record — this is the root fix for the cross-user data-loss bug.
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
    for (const id of merged.keys()) {
      if (tombstones[`${col}:${id}`] !== undefined) merged.delete(id);
    }

    result[col] = [...merged.values()];
  }

  if (conflicts.length > 0) {
    const err = new Error('Concurrent edit conflict — another user modified the same records');
    err.name      = 'ConflictError';
    err.conflicts = conflicts;
    throw err;
  }

  return result;
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
  const syncedAt = local?._syncedAt ?? null;
  // Union of every id ever permanently deleted, from either side — see
  // recordTombstone() in data.js.
  const tombstones = { ...remote?._tombstones, ...local?._tombstones };
  for (const col of Object.keys(local)) {
    if (col === '_tombstones') { result._tombstones = tombstones; continue; }
    const localArr = local[col];
    if (!Array.isArray(localArr)) {
      // Non-array fields (settings, config, etc.) — prefer local.
      result[col] = localArr;
      continue;
    }
    const remoteArr = result[col];
    if (!Array.isArray(remoteArr)) { result[col] = localArr; continue; }
    const localIds = new Set(localArr.map(x => x.id));
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
    // Propagate hard deletes (records fully removed from state.db, e.g. via
    // Settings → "Delete Permanently") that haven't reached remote yet — this
    // runs every 60s in the background, not just on reload, so an unpushed
    // delete could otherwise resurrect mid-session with no refresh at all.
    // Same rule as mergeLocalPending, deliberately using the RAW syncedAt (not
    // the margin-adjusted effSyncedAt) for the same reason: the margin exists
    // to protect additions from a stale post-push read, not to arbitrate
    // deletes, and reusing it here would make deleting anything touched in
    // the last 15 minutes silently fail to stick.
    if (syncedAt) {
      for (const id of map.keys()) {
        if (localIds.has(id)) continue;
        const remoteItem = map.get(id);
        if ((remoteItem.updatedAt || 0) <= syncedAt) map.delete(id);
      }
    }
    // Final, unconditional backstop, independent of sync history — see the
    // matching comment in mergeDb().
    for (const id of map.keys()) {
      if (tombstones[`${col}:${id}`] !== undefined) map.delete(id);
    }
    result[col] = [...map.values()];
  }
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
  try { localStorage.removeItem(DB_LS_KEY); } catch { /* ignore */ }
}

export async function fetchLocalDb() {
  const cached = localStorage.getItem(DB_LS_KEY);
  if (cached) {
    try { return JSON.parse(cached); } catch { /* corrupt, fall through */ }
  }
  try {
    const res = await fetch('data/db.json', { cache: 'no-store' });
    if (res.ok) return await res.json();
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
  const tombstones = { ...remoteDb?._tombstones, ...localCache?._tombstones };

  for (const col of cols) {
    if (col === '_tombstones') { result._tombstones = tombstones; continue; }
    if (col.startsWith('_')) continue; // skip internal meta fields
    const remote = remoteDb[col];
    const local  = localCache[col];

    if (!Array.isArray(remote) || !Array.isArray(local)) {
      // Non-array fields (settings, appConfig): without sync history remote is
      // authoritative (old cache can't be trusted). With sync history local wins
      // because the user may have intentionally changed settings since last sync.
      result[col] = syncedAt ? (local ?? remote) : (remote ?? local);
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
        remoteItem.updatedAt && item.updatedAt > remoteItem.updatedAt
      ) {
        // Local record was modified after the last sync AND is newer than remote:
        // this is a genuine offline edit — apply it.
        merged.set(item.id, item);
        hasLocalChanges = true;
      }
      // Otherwise: remote is same age or newer, or we have no sync baseline → remote wins
    }

    // Propagate hard deletes (records fully removed from state.db, e.g. via
    // Settings → "Delete Permanently") that never made it to remote — e.g. the
    // push that would have carried the delete failed or hadn't fired yet before
    // this reload. Without this, mergeLocalPending only ever ADDS records from
    // local on top of remote and a not-yet-pushed hard delete comes right back.
    // Only safe to infer "local deleted this" when we have real sync history
    // AND remote's copy hasn't changed since that last known sync — if remote
    // is newer, local's absence just means the cache predates it, not a delete.
    //
    // Deliberately compares against the RAW syncedAt here, not the margin-
    // adjusted effSyncedAt — matching mergeDb's own (margin-free) delete
    // propagation. The margin exists to protect ADDITIONS from a stale
    // post-push read that momentarily doesn't show them yet; applying the
    // same margin here instead breaks the common case of deleting something
    // that was itself touched recently (e.g. import it, then delete it) — a
    // delete on a record last changed 1-14 minutes ago would silently fail to
    // stick on the very next reload. Withholding a genuine delete is merely
    // annoying (redo it, or it propagates on the next successful push); it
    // carries none of the addition case's silent-data-loss risk, so it
    // doesn't need the same conservative padding.
    if (syncedAt) {
      for (const id of merged.keys()) {
        if (localMap.has(id)) continue;
        const remoteItem = merged.get(id);
        if ((remoteItem.updatedAt || 0) <= syncedAt) {
          merged.delete(id);
          hasLocalChanges = true;
        }
      }
    }

    // Final, unconditional backstop, independent of sync history — see the
    // matching comment in mergeDb(). A remote-only id that's tombstoned is
    // never resurrected here regardless of timestamps.
    for (const id of merged.keys()) {
      if (tombstones[`${col}:${id}`] !== undefined) merged.delete(id);
    }

    result[col] = [...merged.values()];
  }

  result._hasLocalChanges = hasLocalChanges;
  return result;
}

let _saveCacheTimer = null;
let _pendingSaveDb  = null;

function writeLocalCacheNow(db) {
  try {
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
    localStorage.setItem(DB_LS_KEY, JSON.stringify(safe));
  } catch (e) {
    console.warn('saveLocalCache:', e);
    if (e.name === 'QuotaExceededError') {
      state.github.cacheQuotaFull = true;
      notify('cache-quota-exceeded');
      import('./ui.js').then(({ toast }) =>
        toast('Local cache full — offline access may use stale data. Purge deleted records in Settings → Data to free space.', 'warning', 8000)
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
    writeLocalCacheNow(toSave);
  }, 500);
}

// Synchronously writes whatever saveLocalCache() has queued, bypassing its
// 500ms debounce. A refresh/close within that window otherwise loses the
// write entirely: state.dirty warns the tab is closing with unsaved changes,
// but that warning doesn't stop a user who dismisses it (and many browsers
// don't even show it without recent interaction) — the debounce timer is
// simply abandoned mid-air, and next load reads the pre-edit cache with no
// record that anything newer ever existed. Call this from beforeunload.
export function flushLocalCache() {
  if (!_saveCacheTimer) return;
  clearTimeout(_saveCacheTimer);
  _saveCacheTimer = null;
  const toSave = _pendingSaveDb;
  _pendingSaveDb = null;
  if (toSave) writeLocalCacheNow(toSave);
}

// ── File storage (invoice PDFs, etc.) ────────────────────────────────────────

/**
 * Upload or replace a file in the GitHub repo.
 * @param {string} path       - repo-relative path, e.g. "invoices/inv_abc.pdf"
 * @param {string} b64Content - base64-encoded file content (no data-URL prefix)
 * @param {string} message    - commit message
 * @returns {Promise<{sha: string}>}
 */
export async function uploadGithubFile(path, b64Content, message = 'Upload file') {
  const { owner, repo, branch, token } = state.github;
  if (!owner || !repo || !token) throw new Error('GitHub not configured — add owner/repo/token in Settings');

  // Normalise path: strip any accidental leading slash so files always land
  // inside their intended folder, not the repo root.
  const cleanPath = path.replace(/^\/+/, '');
  const encodedPath = cleanPath.split('/').map(encodeURIComponent).join('/');

  const headers = {
    'Accept':        'application/vnd.github+json',
    'Authorization': `token ${token}`,
    'Content-Type':  'application/json'
  };
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${encodedPath}`;
  const ATTEMPTS = 6;

  let lastErr = null;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    // Re-read the file's current SHA on every attempt (required for updates).
    // A 404 means the file doesn't exist yet — create it by omitting the sha.
    // If-None-Match forces the CDN to revalidate so we don't PUT against a stale
    // SHA. GitHub creates parent directories automatically.
    let existingSha = null;
    try {
      const check = await fetch(
        `${apiUrl}?ref=${encodeURIComponent(branch || 'main')}`,
        { headers: { ...headers, 'If-None-Match': `"${Date.now()}"` }, cache: 'no-store' }
      );
      if (check.ok) {
        const d = await check.json();
        existingSha = d.sha;
      }
      // 404 → file does not exist yet; proceed to create without sha
    } catch { /* network error during existence check — proceed anyway */ }

    const body = { message, content: b64Content, branch: branch || 'main' };
    if (existingSha) body.sha = existingSha;

    let res;
    try {
      res = await fetch(apiUrl, { method: 'PUT', headers, body: JSON.stringify(body) });
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

    // 409 = the file changed between our GET and PUT (concurrent/parallel upload
    // or stale CDN SHA). Re-read the fresh SHA and retry instead of failing.
    if (res.status === 409 && attempt < ATTEMPTS) {
      lastErr = '409 SHA conflict';
      await sleep(150 + Math.random() * 200);
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
  const res = await fetch(
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

  let res = await fetch(url, { headers, cache: 'no-store' });
  if (res.status === 403) {
    const waitMs = rateLimitWaitMs(res);
    if (waitMs > 0) { await sleep(waitMs); res = await fetch(url, { headers, cache: 'no-store' }); }
  }
  if (!res.ok) {
    if (res.status === 404) throw new Error('File not found in repository');
    if (res.status === 403 && rateLimitWaitMs(res) > 0) throw new Error('GitHub rate limit exceeded — try again shortly');
    if (res.status === 401 || res.status === 403) throw new Error('GitHub auth failed — check your token');
    throw new Error(`File fetch failed (${res.status})`);
  }
  return res.json(); // { content (b64), sha, download_url, ... }
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
      const check = await fetch(`${apiUrl}?ref=${encodeURIComponent(branch || 'main')}`, { headers, cache: 'no-store' });
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
      res = await fetch(apiUrl, {
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
        const check = await fetch(`${apiUrl}?ref=${encodeURIComponent(branch || 'main')}`, { headers, cache: 'no-store' });
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

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Exponential backoff with jitter — avoids a thundering herd when several
// clients hit the same SHA conflict and all retry in lockstep.
function backoff(attempt) {
  const base = Math.min(8000, 250 * 2 ** attempt);
  return base + Math.random() * 400;
}
