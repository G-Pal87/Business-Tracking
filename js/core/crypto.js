// Client-side encryption for data stored in the (public) GitHub repo.
//
// db.json and uploaded documents are encrypted with a single shared AES-256-GCM
// "data key" before ever being committed. That data key is never stored raw —
// on each device it's kept "wrapped" (encrypted) under a key derived from that
// user's login password, and only unwrapped in memory after a successful
// login. This means the repo can stay public and the app can stay fully
// static (no backend) while still keeping the actual data unreadable to
// anyone without both the data key and a valid login.
//
// Envelope format written to db.json (and to each encrypted document):
//   { enc: 1, iv: base64, ct: base64 }
// `enc: 1` is the marker used to distinguish this from a plain (legacy,
// unencrypted) JSON object — see isEncryptedEnvelope().

const PBKDF2_ITERATIONS = 150000; // matches auth.js's password hashing cost
const WRAP_SALT_LS_KEY = 'bt_enc_wrap_salt';
const WRAPPED_KEY_LS_KEY = 'bt_enc_wrapped_key';
// A second, independent AES key used ONLY to encrypt files pushed to the
// debug/ export folder (see settings.js's "Debug Data Export" card). Kept
// entirely separate from the real data key: this one can be handed to a
// third party for troubleshooting (e.g. an AI assistant) without exposing
// anything else this app protects — db.json, documents, invoices — and
// revoking that access is just regenerating this key, not rotating the
// real one for every device/user.
const WRAPPED_DEBUG_KEY_LS_KEY = 'bt_enc_wrapped_debug_key';
// Previously-active data keys (most recent first), each wrapped under the
// session wrap-key exactly like the current one. Kept so that:
//   - a key rotation interrupted part-way (tab closed, crash, network loss)
//     can still read db.json / attachments that haven't been re-encrypted
//     under the new key yet, instead of leaving them unreadable;
//   - a device that is given a new key can still decrypt anything written
//     under the one it replaced while the rest of the team catches up.
// Decryption tries the current key first, then these. Encryption only ever
// uses the current key.
const WRAPPED_PREV_KEYS_LS_KEY = 'bt_enc_wrapped_prev_keys';
const MAX_PREV_KEYS = 3;

// Held only in memory for the lifetime of the tab — never persisted.
let _sessionWrapKey = null;    // CryptoKey, derived from the login password
let _dataKey = null;           // CryptoKey, the actual AES-256-GCM data key once unlocked
let _debugKey = null;          // CryptoKey, AES-256-GCM — scoped only to the debug/ export folder
let _pendingBootstrapKey = null; // set when a key is entered on a brand-new device, before login
let _prevKeys = [];            // CryptoKey[], previously-active data keys (see WRAPPED_PREV_KEYS_LS_KEY)
const _kidCache = new WeakMap(); // CryptoKey → key id string

function b64encode(bytes) {
  // Avoid String.fromCharCode(...bytes) — spreading a large byte array (e.g.
  // the whole encrypted db.json) as call arguments overflows the JS engine's
  // argument/stack limit. Chunk it instead.
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}
function b64decode(str) { return Uint8Array.from(atob(str), c => c.charCodeAt(0)); }

function randomBytes(n) { return crypto.getRandomValues(new Uint8Array(n)); }

// ── Wrap-key derivation (from the login password) ──────────────────────────

function getOrCreateWrapSalt() {
  let saltB64 = localStorage.getItem(WRAP_SALT_LS_KEY);
  if (!saltB64) {
    saltB64 = b64encode(randomBytes(16));
    localStorage.setItem(WRAP_SALT_LS_KEY, saltB64);
  }
  return saltB64;
}

async function deriveWrapKey(password) {
  const salt = b64decode(getOrCreateWrapSalt());
  const keyMaterial = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
  );
}

// Called right after a successful login (while the plaintext password is
// still available). Derives this device's wrap-key and, if a wrapped data
// key already exists in localStorage, unwraps it so the app can immediately
// decrypt data. Safe to call even if encryption has never been set up on
// this device — _dataKey simply stays null until Settings configures it.
export async function unlockOnLogin(password) {
  _sessionWrapKey = await deriveWrapKey(password);

  // A key entered pre-login on a brand-new device (see setBootstrapDataKey)
  // was never persisted — it couldn't be wrapped without a password to derive
  // the wrap-key from. Now that we have one, persist it for future reloads.
  if (_pendingBootstrapKey) {
    const key = _pendingBootstrapKey;
    _pendingBootstrapKey = null;
    await installDataKey(key);
    return;
  }

  _prevKeys = await unwrapPrevKeys();

  const wrapped = localStorage.getItem(WRAPPED_KEY_LS_KEY);
  if (!wrapped) { _dataKey = null; } else {
    try {
      const { iv, ct } = JSON.parse(wrapped);
      const raw = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: b64decode(iv) }, _sessionWrapKey, b64decode(ct)
      );
      _dataKey = await crypto.subtle.importKey('raw', raw, 'AES-GCM', true, ['encrypt', 'decrypt']);
    } catch {
      // Wrong password would already have failed login; a decrypt failure here
      // means corrupted/foreign localStorage state — treat as "not configured".
      _dataKey = null;
    }
  }

  const wrappedDebug = localStorage.getItem(WRAPPED_DEBUG_KEY_LS_KEY);
  if (!wrappedDebug) { _debugKey = null; return; }
  try {
    const { iv, ct } = JSON.parse(wrappedDebug);
    const raw = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64decode(iv) }, _sessionWrapKey, b64decode(ct)
    );
    _debugKey = await crypto.subtle.importKey('raw', raw, 'AES-GCM', true, ['encrypt', 'decrypt']);
  } catch {
    _debugKey = null;
  }
}

export function lockOnLogout() {
  _sessionWrapKey = null;
  _dataKey = null;
  _debugKey = null;
  _pendingBootstrapKey = null;
  _prevKeys = [];
}

async function wrapRawKey(raw) {
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, _sessionWrapKey, raw);
  return { iv: b64encode(iv), ct: b64encode(new Uint8Array(ct)) };
}

async function unwrapToKey({ iv, ct }, wrapKey = _sessionWrapKey) {
  const raw = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64decode(iv) }, wrapKey, b64decode(ct));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', true, ['encrypt', 'decrypt']);
}

async function unwrapPrevKeys() {
  let list = [];
  try { list = JSON.parse(localStorage.getItem(WRAPPED_PREV_KEYS_LS_KEY) || '[]'); } catch { list = []; }
  const keys = [];
  for (const w of Array.isArray(list) ? list : []) {
    try { keys.push(await unwrapToKey(w)); } catch { /* wrapped under another password — skip */ }
  }
  return keys;
}

async function persistPrevKeys() {
  if (!_sessionWrapKey) return;
  const wrapped = [];
  for (const k of _prevKeys) {
    wrapped.push(await wrapRawKey(await crypto.subtle.exportKey('raw', k)));
  }
  try { localStorage.setItem(WRAPPED_PREV_KEYS_LS_KEY, JSON.stringify(wrapped)); } catch { /* ignore */ }
}

// Short, non-secret fingerprint of a data key (first 9 bytes of SHA-256 of
// the raw key, base64). Written into every db.json envelope as `kid` so a
// device can tell "encrypted under a key I don't have" (key was rotated
// elsewhere) apart from corrupted data — and refuse to push over it.
export async function keyIdOf(key) {
  if (!key) return null;
  const hit = _kidCache.get(key);
  if (hit) return hit;
  const raw = await crypto.subtle.exportKey('raw', key);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', raw));
  const kid = b64encode(digest.subarray(0, 9));
  _kidCache.set(key, kid);
  return kid;
}

export async function activeKeyId() { return keyIdOf(_dataKey); }

// Re-wraps every locally stored key (data, previous, debug) under a key
// derived from `newPassword`. Must be called when the logged-in user changes
// their OWN password: the wrap-key is derived from the login password, so
// without this the next login can't unwrap the data key and the user is
// locked out of their data on this device until someone re-sends the key.
export async function rewrapKeysForNewPassword(newPassword) {
  if (!_sessionWrapKey) return false;
  const newWrapKey = await deriveWrapKey(newPassword);
  const rewrap = async (lsKey) => {
    const stored = localStorage.getItem(lsKey);
    if (!stored) return;
    const raw = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64decode(JSON.parse(stored).iv) }, _sessionWrapKey, b64decode(JSON.parse(stored).ct)
    );
    const iv = randomBytes(12);
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, newWrapKey, raw);
    return JSON.stringify({ iv: b64encode(iv), ct: b64encode(new Uint8Array(ct)) });
  };
  // Compute everything first, then write — a failure part-way must not
  // leave some slots wrapped under the old password and some under the new.
  // A failure on the data-key slot must surface — silently leaving it
  // wrapped under the old password would lock the user out on next sign-in.
  const nextData  = await rewrap(WRAPPED_KEY_LS_KEY);
  const nextDebug = await rewrap(WRAPPED_DEBUG_KEY_LS_KEY).catch(() => undefined);
  const nextPrev = [];
  for (const k of _prevKeys) {
    const raw = await crypto.subtle.exportKey('raw', k);
    const iv = randomBytes(12);
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, newWrapKey, raw);
    nextPrev.push({ iv: b64encode(iv), ct: b64encode(new Uint8Array(ct)) });
  }
  if (nextData)  localStorage.setItem(WRAPPED_KEY_LS_KEY, nextData);
  if (nextDebug) localStorage.setItem(WRAPPED_DEBUG_KEY_LS_KEY, nextDebug);
  localStorage.setItem(WRAPPED_PREV_KEYS_LS_KEY, JSON.stringify(nextPrev));
  _sessionWrapKey = newWrapKey;
  return true;
}

export function isUnlocked() { return _dataKey !== null; }
export function hasSessionWrapKey() { return _sessionWrapKey !== null; }
export function hasWrappedKeyConfigured() { return !!localStorage.getItem(WRAPPED_KEY_LS_KEY); }

// Used on a brand-new device (no local cache, no session yet) to unlock
// db.json enough to populate the login form — see requireAuth() in auth.js.
// Sets the key active immediately (in memory only); unlockOnLogin() persists
// it properly, wrapped under the password, once login actually succeeds.
export function setBootstrapDataKey(key) {
  _pendingBootstrapKey = key;
  _dataKey = key;
}

// ── Setting up / changing the data key (from Settings) ─────────────────────

// Generates a brand-new random 256-bit data key. Returns both the CryptoKey
// (not yet installed as the active key) and its base64 form to show the user
// once for backup — caller must still call installDataKey() to activate it.
export async function generateDataKey() {
  const raw = randomBytes(32);
  const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', true, ['encrypt', 'decrypt']);
  return { key, base64: b64encode(raw) };
}

export async function importDataKeyFromBase64(base64) {
  const raw = b64decode(base64.trim());
  if (raw.length !== 32) throw new Error('Encryption key must decode to 32 bytes (256 bits)');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', true, ['encrypt', 'decrypt']);
}

// Wraps `key` under this device's session wrap-key and persists it, then
// activates it as the in-memory data key. Requires unlockOnLogin() to have
// already run this session (i.e. the user is logged in).
export async function installDataKey(key) {
  if (!_sessionWrapKey) throw new Error('Not logged in — cannot install an encryption key');
  // Keep the key being replaced (if any, and if actually different) as a
  // previous key BEFORE overwriting the one wrapped slot — see
  // WRAPPED_PREV_KEYS_LS_KEY. Persisted first, so even a crash right after
  // the swap below can't lose the only copy of the old key.
  if (_dataKey && (await keyIdOf(_dataKey)) !== (await keyIdOf(key))) {
    const newKid = await keyIdOf(key);
    const kept = [];
    for (const k of [_dataKey, ..._prevKeys]) {
      const kid = await keyIdOf(k);
      if (kid !== newKid && !(await Promise.all(kept.map(keyIdOf))).includes(kid)) kept.push(k);
    }
    _prevKeys = kept.slice(0, MAX_PREV_KEYS);
    await persistPrevKeys();
  }
  const raw = await crypto.subtle.exportKey('raw', key);
  localStorage.setItem(WRAPPED_KEY_LS_KEY, JSON.stringify(await wrapRawKey(raw)));
  _dataKey = key;
}

export function clearDataKey() {
  localStorage.removeItem(WRAPPED_KEY_LS_KEY);
  localStorage.removeItem(WRAPPED_PREV_KEYS_LS_KEY);
  _dataKey = null;
  _prevKeys = [];
}

// Base64 of every previously-active key still held on this device (most
// recent first) — lets an admin recover the old key after a rotation.
export async function exportPreviousKeysBase64() {
  const out = [];
  for (const k of _prevKeys) out.push(b64encode(new Uint8Array(await crypto.subtle.exportKey('raw', k))));
  return out;
}

// ── Debug export key (separate from the real data key, see comment above) ──

export function isDebugKeyUnlocked() { return _debugKey !== null; }
export function hasDebugKeyConfigured() { return !!localStorage.getItem(WRAPPED_DEBUG_KEY_LS_KEY); }

export async function generateDebugKey() {
  const raw = randomBytes(32);
  const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', true, ['encrypt', 'decrypt']);
  return { key, base64: b64encode(raw) };
}

// Wraps `key` under this device's session wrap-key and persists it under its
// own localStorage slot — never touches WRAPPED_KEY_LS_KEY (the real data key).
export async function installDebugKey(key) {
  if (!_sessionWrapKey) throw new Error('Not logged in — cannot install a debug key');
  const raw = await crypto.subtle.exportKey('raw', key);
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, _sessionWrapKey, raw);
  localStorage.setItem(WRAPPED_DEBUG_KEY_LS_KEY, JSON.stringify({
    iv: b64encode(iv), ct: b64encode(new Uint8Array(ct))
  }));
  _debugKey = key;
}

export function clearDebugKey() {
  localStorage.removeItem(WRAPPED_DEBUG_KEY_LS_KEY);
  _debugKey = null;
}

// One-time reveal so the key can be handed to whoever needs debug access —
// same extractable-key mechanism as exportActiveDataKeyBase64.
export async function exportActiveDebugKeyBase64() {
  if (!_debugKey) throw new Error('No debug key active on this device');
  const raw = await crypto.subtle.exportKey('raw', _debugKey);
  return b64encode(new Uint8Array(raw));
}

// Encrypts a debug snapshot under the debug key — deliberately separate from
// encryptJsonToEnvelope (which uses the real data key) so a debug export can
// never accidentally end up encrypted under, or require, the real key.
export async function encryptJsonWithDebugKey(obj) {
  if (!_debugKey) throw new Error('No debug key configured on this device');
  const iv = randomBytes(12);
  const plaintext = new TextEncoder().encode(JSON.stringify(obj));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, _debugKey, plaintext);
  return { enc: 1, iv: b64encode(iv), ct: b64encode(new Uint8Array(ct)) };
}

// Lets an admin retrieve the currently active key on demand — e.g. if the
// one-time reveal shown at generation time was missed, or a new device/user
// needs it later. Works because every data key here is created with
// extractable: true.
export async function exportActiveDataKeyBase64() {
  if (!_dataKey) throw new Error('No encryption key active on this device');
  const raw = await crypto.subtle.exportKey('raw', _dataKey);
  return b64encode(new Uint8Array(raw));
}

// ── Encrypt / decrypt JSON (db.json) ────────────────────────────────────────

export function isEncryptedEnvelope(parsed) {
  return !!parsed && typeof parsed === 'object' && parsed.enc === 1
    && typeof parsed.iv === 'string' && typeof parsed.ct === 'string';
}

// ── Optional gzip compression inside the envelope ──────────────────────────
// A compressed envelope is { enc: 1, v: 2, z: 'gzip', iv, ct, kid }: the JSON
// is gzipped BEFORE encryption (ciphertext itself can't be compressed), which
// shrinks db.json ~5-8x. `v` is the envelope format version: code that sees a
// version newer than it understands refuses to read (and therefore to save)
// instead of guessing — see decryptEnvelopeWithInfo.
//
// Compression is only ever written when the caller asks for it (doPushDb,
// gated by the synced settings.compressDb switch), because an app version
// from before this change can't read it. Reading is always supported.
export const ENVELOPE_FORMAT_VERSION = 2;

export function supportsCompression() {
  return typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';
}

async function gzipBytes(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzipBytes(bytes) {
  if (typeof DecompressionStream !== 'function') {
    const err = new Error('The data is stored compressed, and this browser is too old to read it. Update the browser (Safari/iOS 16.4+, Chrome 80+, Firefox 113+). Nothing will be saved from this device until then.');
    err.code = 'UNSUPPORTED_BROWSER';
    throw err;
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function encryptJsonToEnvelope(obj, { compress = false } = {}) {
  if (!_dataKey) throw new Error('No encryption key configured on this device');
  const iv = randomBytes(12);
  let plaintext = new TextEncoder().encode(JSON.stringify(obj));
  const zip = compress && supportsCompression();
  if (zip) plaintext = await gzipBytes(plaintext);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, _dataKey, plaintext);
  // `kid` is additive: older app versions ignore unknown envelope fields.
  const env = { enc: 1, iv: b64encode(iv), ct: b64encode(new Uint8Array(ct)), kid: await keyIdOf(_dataKey) };
  if (zip) { env.v = ENVELOPE_FORMAT_VERSION; env.z = 'gzip'; }
  return env;
}

export function isCompressedEnvelope(env) { return !!env && env.z === 'gzip'; }

// Candidate keys for decryption: the one the envelope names (if we hold it),
// then the current key, then previous keys.
async function candidateKeys(kid) {
  const all = [_dataKey, ..._prevKeys].filter(Boolean);
  if (!kid) return all;
  const named = [];
  for (const k of all) if ((await keyIdOf(k)) === kid) named.push(k);
  // If the envelope names a key we don't hold, still try the others — a
  // kid is only a hint and never grounds to give up without trying.
  return [...named, ...all.filter(k => !named.includes(k))];
}

function keyMismatchError() {
  const err = new Error('The data on GitHub is encrypted with a different key than the one on this device — the team key was probably changed on another device. Paste the new key in Settings → Encryption. Changes made here are kept locally until then.');
  err.code = 'KEY_MISMATCH';
  return err;
}

export async function decryptEnvelopeToJson(envelope) {
  return (await decryptEnvelopeWithInfo(envelope)).data;
}

// Same as decryptEnvelopeToJson, but also reports whether it took a
// PREVIOUS key (not the current one) to read it — doPushDb uses this to
// refuse re-encrypting the shared data under a current key that can't read
// it (e.g. a wrong key pasted into Settings), outside a deliberate rotation.
export async function decryptEnvelopeWithInfo(envelope) {
  if (!_dataKey && _prevKeys.length === 0) {
    const err = new Error('Data is encrypted but no encryption key is configured on this device');
    err.code = 'NO_ENC_KEY';
    throw err;
  }
  if ((Number(envelope.v) || 1) > ENVELOPE_FORMAT_VERSION || (envelope.z && envelope.z !== 'gzip')) {
    const err = new Error('The data on GitHub was saved by a newer version of the app. Reload the page to update. Nothing will be saved from this tab until then.');
    err.code = 'NEWER_FORMAT';
    throw err;
  }
  const iv = b64decode(envelope.iv), ct = b64decode(envelope.ct);
  for (const key of await candidateKeys(envelope.kid)) {
    let plaintext;
    try { plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct)); }
    catch { continue; } // wrong key — try the next one
    if (envelope.z === 'gzip') plaintext = await gunzipBytes(plaintext);
    return { data: JSON.parse(new TextDecoder().decode(plaintext)), usedPrevious: key !== _dataKey, usedKid: await keyIdOf(key) };
  }
  throw keyMismatchError();
}

// True if `key` alone can decrypt `envelope` — used to validate a pasted key
// against the live data before installing it.
export async function canDecryptWith(key, envelope) {
  try {
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64decode(envelope.iv) }, key, b64decode(envelope.ct));
    return true;
  } catch { return false; }
}

// Set by Settings → key rotation from the moment the new key is installed
// until db.json has been pushed under it; persisted so an interrupted
// rotation can still finish re-encrypting on the next save.
const ROTATION_PENDING_LS_KEY = 'bt_enc_rotation_pending';
export function setRotationPending(on) {
  try { on ? localStorage.setItem(ROTATION_PENDING_LS_KEY, '1') : localStorage.removeItem(ROTATION_PENDING_LS_KEY); } catch { /* ignore */ }
}
export function isRotationPending() {
  try { return localStorage.getItem(ROTATION_PENDING_LS_KEY) === '1'; } catch { return false; }
}

// ── Encrypt / decrypt raw bytes (uploaded documents/invoices) ──────────────

// Container: 4-byte magic marker + 12-byte IV + ciphertext. Unlike the JSON
// envelope (which is self-describing via `enc: 1`), an arbitrary file's bytes
// have no natural "is this encrypted" signal — the marker lets callers detect
// legacy unencrypted files already in the repo without guessing from content.
const BYTES_MAGIC = new Uint8Array([0x42, 0x54, 0x58, 0x31]); // "BTX1"

export function isEncryptedBytes(bytes) {
  if (!bytes || bytes.length < BYTES_MAGIC.length) return false;
  return BYTES_MAGIC.every((b, i) => bytes[i] === b);
}

export async function encryptBytes(bytes) {
  if (!_dataKey) throw new Error('No encryption key configured on this device');
  const iv = randomBytes(12);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, _dataKey, bytes));
  const out = new Uint8Array(BYTES_MAGIC.length + iv.length + ct.length);
  out.set(BYTES_MAGIC, 0); out.set(iv, BYTES_MAGIC.length); out.set(ct, BYTES_MAGIC.length + iv.length);
  return out;
}

export async function decryptBytes(container) {
  if (!_dataKey && _prevKeys.length === 0) throw new Error('File is encrypted but no encryption key is configured on this device — add it in Settings');
  const iv = container.slice(BYTES_MAGIC.length, BYTES_MAGIC.length + 12);
  const ct = container.slice(BYTES_MAGIC.length + 12);
  // Current key first, then previous keys — a file not yet re-encrypted by
  // an interrupted rotation is still readable.
  let lastErr = null;
  for (const key of [_dataKey, ..._prevKeys].filter(Boolean)) {
    try { return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct)); }
    catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('Could not decrypt file');
}

// ── Encrypt / decrypt file/folder NAMES ─────────────────────────────────────
// Same container as encryptBytes (BTX1 magic + IV + ciphertext), just
// base64url-encoded (RFC 4648 §5: '+'/'/' -> '-'/'_', no padding) so the
// result is safe to use as a path segment. AES-GCM's IV is random per call,
// so encrypting the same name twice gives two different results — there is
// no way to "encrypt and string-compare"; matching a name found in the repo
// against an expected name means decrypting the repo's name back to
// plaintext first (see decryptFilename), then comparing plaintext strings.

function toBase64Url(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(str) {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - str.length % 4) % 4);
  return Uint8Array.from(atob(padded), c => c.charCodeAt(0));
}

export async function encryptFilename(name) {
  const container = await encryptBytes(new TextEncoder().encode(name));
  return toBase64Url(container);
}

// Returns null (not the original throwing) when `encoded` doesn't look like
// one of our encrypted names — callers should treat that as "this is a
// legacy plain name, use it as-is" rather than an error, since encrypted and
// not-yet-migrated plain filenames are expected to coexist during rollout.
export async function decryptFilename(encoded) {
  let container;
  try { container = fromBase64Url(encoded); } catch { return null; }
  if (!isEncryptedBytes(container)) return null;
  if (!_dataKey) {
    const err = new Error('Filename is encrypted but no encryption key is configured on this device');
    err.code = 'NO_ENC_KEY';
    throw err;
  }
  try {
    const plaintext = await decryptBytes(container);
    return new TextDecoder().decode(plaintext);
  } catch {
    return null; // wrong key or corrupted -- treat as unrecognized rather than crash the caller
  }
}
