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

// Held only in memory for the lifetime of the tab — never persisted.
let _sessionWrapKey = null;    // CryptoKey, derived from the login password
let _dataKey = null;           // CryptoKey, the actual AES-256-GCM data key once unlocked
let _pendingBootstrapKey = null; // set when a key is entered on a brand-new device, before login

function b64encode(bytes) { return btoa(String.fromCharCode(...bytes)); }
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

  const wrapped = localStorage.getItem(WRAPPED_KEY_LS_KEY);
  if (!wrapped) { _dataKey = null; return; }
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

export function lockOnLogout() {
  _sessionWrapKey = null;
  _dataKey = null;
  _pendingBootstrapKey = null;
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
  const raw = await crypto.subtle.exportKey('raw', key);
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, _sessionWrapKey, raw);
  localStorage.setItem(WRAPPED_KEY_LS_KEY, JSON.stringify({
    iv: b64encode(iv), ct: b64encode(new Uint8Array(ct))
  }));
  _dataKey = key;
}

export function clearDataKey() {
  localStorage.removeItem(WRAPPED_KEY_LS_KEY);
  _dataKey = null;
}

// ── Encrypt / decrypt JSON (db.json) ────────────────────────────────────────

export function isEncryptedEnvelope(parsed) {
  return !!parsed && typeof parsed === 'object' && parsed.enc === 1
    && typeof parsed.iv === 'string' && typeof parsed.ct === 'string';
}

export async function encryptJsonToEnvelope(obj) {
  if (!_dataKey) throw new Error('No encryption key configured on this device');
  const iv = randomBytes(12);
  const plaintext = new TextEncoder().encode(JSON.stringify(obj));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, _dataKey, plaintext);
  return { enc: 1, iv: b64encode(iv), ct: b64encode(new Uint8Array(ct)) };
}

export async function decryptEnvelopeToJson(envelope) {
  if (!_dataKey) {
    const err = new Error('Data is encrypted but no encryption key is configured on this device');
    err.code = 'NO_ENC_KEY';
    throw err;
  }
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64decode(envelope.iv) }, _dataKey, b64decode(envelope.ct)
  );
  return JSON.parse(new TextDecoder().decode(plaintext));
}

// ── Encrypt / decrypt raw bytes (uploaded documents/invoices) ──────────────

// Returns a small binary container: 12-byte IV followed by ciphertext, so
// encrypted files can be stored/transferred as a single opaque blob (base64
// for the GitHub Contents API, same as today's uploadGithubFile).
export async function encryptBytes(bytes) {
  if (!_dataKey) throw new Error('No encryption key configured on this device');
  const iv = randomBytes(12);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, _dataKey, bytes));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0); out.set(ct, iv.length);
  return out;
}

export async function decryptBytes(container) {
  if (!_dataKey) throw new Error('File is encrypted but no encryption key is configured on this device — add it in Settings');
  const iv = container.slice(0, 12);
  const ct = container.slice(12);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, _dataKey, ct);
  return new Uint8Array(plaintext);
}
