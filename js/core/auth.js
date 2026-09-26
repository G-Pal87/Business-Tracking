// Auth: session management + login/setup screen
import { state, setDb } from './state.js';
import { el, input, formRow, button, toast } from './ui.js';
import { newId, upsert, listActive } from './data.js';
import { unlockOnLogin, lockOnLogout, hasWrappedKeyConfigured, isUnlocked, setBootstrapDataKey, importDataKeyFromBase64 } from './crypto.js';
import { recordSessionEvent } from './presence.js';

const SESSION_KEY = 'bt_session';
// Password hashing cost. Raised from 150k; each user record stores the
// count its hash was made with (passwordIter), and a successful login with
// an older count transparently re-hashes at this one (see verifyPassword).
const PBKDF2_ITERATIONS = 300000;
const LEGACY_ITERATIONS = 150000;
export const MIN_PASSWORD_LENGTH = 10;
// A session with no expiry at all (the previous behavior) never ends, so a
// forged/leaked/abandoned localStorage session on a shared machine stays
// valid indefinitely. Rolling idle timeout: every requireAuth() check that
// finds a still-valid session extends it another SESSION_IDLE_MS, so an
// actively-used app never logs anyone out — only a session untouched for
// this long expires.
const SESSION_IDLE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function b64encode(bytes) { return btoa(String.fromCharCode(...bytes)); }
function b64decode(str) { return Uint8Array.from(atob(str), c => c.charCodeAt(0)); }

// Legacy scheme (pre-hardening): a single unsalted SHA-256 round. Kept only
// so accounts created before this shipped can still log in once — never
// used for new accounts or password changes.
async function legacySha256(password) {
  const data = new TextEncoder().encode(password);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Salted PBKDF2-HMAC-SHA256 (150k iterations) — resistant to offline
// rainbow-table/brute-force attacks against the shared, GitHub-committed
// db.json, unlike the single unsalted SHA-256 round this replaces. Entirely
// client-side via Web Crypto, no new dependency.
export async function hashPassword(password, saltB64 = null, iterations = PBKDF2_ITERATIONS) {
  const salt = saltB64 ? b64decode(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    keyMaterial, 256
  );
  const hash = Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2, '0')).join('');
  return { hash, salt: b64encode(salt), iter: iterations };
}

// Verifies a password against a user record. Supports both the current
// salted scheme and the legacy unsalted one, so pre-existing accounts don't
// need a forced reset — a successful legacy login is transparently upgraded
// (caller should upsert the returned newHash/newSalt onto the user record).
export async function verifyPassword(password, user) {
  if (user.passwordSalt) {
    const iter = Number(user.passwordIter) || LEGACY_ITERATIONS;
    const { hash } = await hashPassword(password, user.passwordSalt, iter);
    if (hash !== user.passwordHash) return { ok: false, needsUpgrade: false };
    if (iter >= PBKDF2_ITERATIONS) return { ok: true, needsUpgrade: false };
    const up = await hashPassword(password);
    return { ok: true, needsUpgrade: true, newHash: up.hash, newSalt: up.salt, newIter: up.iter };
  }
  const legacyHash = await legacySha256(password);
  if (legacyHash !== user.passwordHash) return { ok: false, needsUpgrade: false };
  const { hash, salt, iter } = await hashPassword(password);
  return { ok: true, needsUpgrade: true, newHash: hash, newSalt: salt, newIter: iter };
}

// Writes an upgraded hash (see verifyPassword) back onto the user record.
function applyPasswordUpgrade(user, result) {
  if (!result?.needsUpgrade) return;
  upsert('users', { ...user, passwordHash: result.newHash, passwordSalt: result.newSalt, passwordIter: result.newIter });
}

// Once the data key is unlocked: decrypt the stored GitHub token (or encrypt
// a still-plain one) — see adoptStoredToken in github.js.
async function adoptToken() {
  try { await (await import('./github.js')).adoptStoredToken(); } catch { /* best-effort */ }
}

export function getSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export function setSession(user) {
  const now = Date.now();
  const s = { userId: user.id, username: user.username, role: user.role, name: user.name, issuedAt: now, expiresAt: now + SESSION_IDLE_MS };
  localStorage.setItem(SESSION_KEY, JSON.stringify(s));
  state.session = s;
}

// After the signed-in user changes their OWN password: keep this session
// (sessions issued before a password change are otherwise ended, see
// requireAuth).
export function refreshSessionIssued() {
  const s = getSession();
  if (!s) return;
  s.issuedAt = Date.now();
  localStorage.setItem(SESSION_KEY, JSON.stringify(s));
  if (state.session) state.session.issuedAt = s.issuedAt;
}

export function clearSession() {
  localStorage.removeItem(SESSION_KEY);
  state.session = null;
  lockOnLogout();
}

// `opts.loadAfterUnlock` (from app.js): loads this device's data once the
// encryption key is unlocked — opens the encrypted local cache, or pulls from
// GitHub. The local cache is encrypted, so on a device with a key a fresh
// page load has no user list to check a password against until the key is
// unlocked: sign-in then unlocks first, loads, and verifies after.
export function requireAuth(opts = {}) {
  return new Promise(resolve => {
    // listActive() excludes soft-deleted accounts, so a "removed" user's
    // already-open session is rejected on the next reload instead of
    // continuing to pass this check indefinitely.
    const users = listActive('users');
    const stored = getSession();
    // A session without an expiry, or issued before the user's password was
    // last changed (an admin reset it), has ended.
    const expired = !stored || stored.expiresAt == null || Date.now() > stored.expiresAt;

    if (users.length === 0 && typeof opts.loadAfterUnlock === 'function' && hasWrappedKeyConfigured() && !isUnlocked()) {
      const screen = el('div', { id: 'login-screen', class: 'login-screen' });
      document.body.appendChild(screen);
      renderUnlockFirst(screen, expired ? null : stored, opts, resolve);
      return;
    }

    const found = (stored && !expired) ? users.find(u => u.id === stored.userId) : null;
    const liveUser = found && !(found.passwordChangedAt && found.passwordChangedAt > (stored.issuedAt || 0)) ? found : null;
    if (liveUser) {
      // Re-sync from the live record so a role/name change an admin makes
      // takes effect the next time this user's session is checked, instead
      // of being stuck with whatever was cached in localStorage at login.
      // Also rolls the idle-timeout expiry forward — see SESSION_IDLE_MS.
      state.session = { userId: liveUser.id, username: liveUser.username, role: liveUser.role, name: liveUser.name, issuedAt: stored.issuedAt || Date.now(), expiresAt: Date.now() + SESSION_IDLE_MS };
      localStorage.setItem(SESSION_KEY, JSON.stringify(state.session));
      // A resumed session never re-enters the password, so the encryption
      // data key (only ever unwrapped from a plaintext password) isn't in
      // memory yet on a fresh page load/tab — prompt for it once per tab
      // before handing control back, rather than silently failing to
      // decrypt data later.
      if (hasWrappedKeyConfigured() && !isUnlocked()) {
        const screen = el('div', { id: 'login-screen', class: 'login-screen' });
        document.body.appendChild(screen);
        renderUnlock(
          screen, liveUser,
          () => { screen.remove(); resolve(state.session); },
          () => { clearSession(); screen.remove(); requireAuth(opts).then(resolve); }
        );
        return;
      }
      resolve(state.session);
      return;
    }
    if (stored) clearSession(); // session pointed at a deleted/missing account, or expired
    const screen = el('div', { id: 'login-screen', class: 'login-screen' });
    document.body.appendChild(screen);
    // A brand-new device (no local cache yet) that failed its first fetch
    // specifically because db.json is encrypted and this device has no key
    // — as opposed to a genuine connectivity/token problem — needs a chance
    // to paste the key before anything else can render, since there's no
    // user list yet to check a normal login against.
    if (state.github?.needsEncKey) { renderBootstrapUnlock(screen, resolve, opts); return; }
    const hasGithubConfig = !!(state.github?.owner && state.github?.repo);
    if (users.length === 0 && hasGithubConfig) renderNoData(screen, resolve);
    else if (users.length === 0) renderSetup(screen, resolve);
    else renderLogin(screen, resolve);
  });
}

// Sign-in on a device whose data (local cache) is encrypted and not yet
// readable: unlock the key with the password, load the data, then verify the
// password against the loaded user record. With `stored`, only the password
// is asked (resuming that session).
function renderUnlockFirst(screen, stored, opts, resolve) {
  screen.innerHTML = '';
  const card = el('div', { class: 'login-card' });
  card.appendChild(el('div', { class: 'login-brand' }, 'BT'));
  card.appendChild(el('div', { class: 'login-title' }, 'Business Tracking'));
  card.appendChild(el('div', { class: 'login-sub' }, stored ? `Welcome back, ${stored.name || stored.username} — sign in to continue` : 'Sign in to continue'));

  const usernameI = stored ? null : input({ placeholder: 'Username', autocomplete: 'username' });
  const passwordI = input({ type: 'password', placeholder: 'Password', autocomplete: 'current-password' });
  const errEl = el('div', { class: 'login-error' });
  if (usernameI) card.appendChild(formRow('Username', usernameI));
  card.appendChild(formRow('Password', passwordI));
  card.appendChild(errEl);

  const btn = button(stored ? 'Unlock' : 'Sign In', { variant: 'primary' });
  btn.style.cssText = 'width:100%;margin-top:8px';
  card.appendChild(btn);

  if (stored) {
    const switchBtn = button('Not you? Switch user', { variant: 'ghost' });
    switchBtn.style.cssText = 'width:100%;margin-top:4px;font-size:12px';
    switchBtn.onclick = () => { clearSession(); renderUnlockFirst(screen, null, opts, resolve); };
    card.appendChild(switchBtn);
  }
  // This device's key is wrapped under one user's password; anyone else signs
  // in here by entering the team key once.
  const keyBtn = button('Use the team encryption key instead', { variant: 'ghost' });
  keyBtn.style.cssText = 'width:100%;margin-top:4px;font-size:12px';
  // Signing in with the key still needs a normal login afterwards (which also
  // wraps the key under that user's password on this device).
  keyBtn.onclick = () => { clearSession(); renderBootstrapUnlock(screen, resolve, opts); };
  card.appendChild(keyBtn);
  screen.appendChild(card);

  const doSignIn = async () => {
    const username = usernameI ? usernameI.value.trim() : stored.username;
    const password = passwordI.value;
    if (!username || !password) { errEl.textContent = usernameI ? 'Enter username and password' : 'Enter your password'; return; }
    errEl.textContent = '';
    btn.disabled = true;
    const fail = (msg) => { lockOnLogout(); errEl.textContent = msg; passwordI.value = ''; btn.disabled = false; };
    try {
      await unlockOnLogin(password);
      if (!isUnlocked()) {
        fail('Incorrect password. If this browser was set up by someone else, use the team encryption key instead.');
        return;
      }
      await adoptToken();
      btn.textContent = 'Loading…';
      await opts.loadAfterUnlock();
      btn.textContent = stored ? 'Unlock' : 'Sign In';
      const users = listActive('users');
      const user = stored ? users.find(u => u.id === stored.userId) : users.find(u => u.username === username);
      const result = user ? await verifyPassword(password, user) : { ok: false };
      if (!result.ok) { fail(stored ? 'Incorrect password' : 'Invalid username or password'); return; }
      applyPasswordUpgrade(user, result);
      if (stored && !(user.passwordChangedAt && user.passwordChangedAt > (stored.issuedAt || 0))) {
        state.session = { userId: user.id, username: user.username, role: user.role, name: user.name, issuedAt: stored.issuedAt || Date.now(), expiresAt: Date.now() + SESSION_IDLE_MS };
        localStorage.setItem(SESSION_KEY, JSON.stringify(state.session));
      } else {
        setSession(user);
        recordSessionEvent('login').catch(() => {});
      }
      screen.remove();
      resolve(state.session);
    } catch (e) {
      console.error(e);
      fail('Could not sign in: ' + (e?.message || 'unknown error'));
      btn.textContent = stored ? 'Unlock' : 'Sign In';
    }
  };

  btn.onclick = doSignIn;
  passwordI.addEventListener('keydown', e => { if (e.key === 'Enter') doSignIn(); });
  usernameI?.addEventListener('keydown', e => { if (e.key === 'Enter') passwordI.focus(); });
  setTimeout(() => (usernameI || passwordI).focus(), 50);
}

// Shown on a brand-new device when the very first data fetch failed because
// db.json is encrypted and no key has been entered here yet (see app.js
// Phase 2 and crypto.js's NO_ENC_KEY). Unlike renderUnlock, there is no known
// user yet to check a password against — this only unblocks the data fetch;
// a normal login/setup screen renders afterward once real user records exist.
function renderBootstrapUnlock(screen, resolve, opts = {}) {
  screen.innerHTML = '';
  const card = el('div', { class: 'login-card' });
  card.appendChild(el('div', { class: 'login-brand' }, 'BT'));
  card.appendChild(el('div', { class: 'login-title' }, 'Business Tracking'));
  card.appendChild(el('div', { class: 'login-sub' }, 'This device needs the encryption key to continue'));
  card.appendChild(el('div', {
    style: 'font-size:13px;color:var(--text-muted);margin:8px 0 16px;line-height:1.5;text-align:center'
  }, 'Data is encrypted. Get the key from whoever set this up, through a secure channel — never email/chat/URL.'));

  const keyI = input({ type: 'password', placeholder: 'Encryption key' });
  const errEl = el('div', { class: 'login-error' });
  card.appendChild(formRow('Encryption Key', keyI));
  card.appendChild(errEl);

  const btn = button('Continue', { variant: 'primary' });
  btn.style.cssText = 'width:100%;margin-top:8px';
  card.appendChild(btn);
  screen.appendChild(card);

  const doContinue = async () => {
    const raw = keyI.value.trim();
    if (!raw) { errEl.textContent = 'Paste the encryption key'; return; }
    errEl.textContent = '';
    btn.disabled = true;
    try {
      const key = await importDataKeyFromBase64(raw);
      setBootstrapDataKey(key);
      const github = await import('./github.js');
      await adoptToken();
      if (typeof opts.loadAfterUnlock === 'function') {
        // app.js knows how to load this device's data (its encrypted cache
        // opens with the team key too) — then sign in normally.
        await opts.loadAfterUnlock();
        state.github.needsEncKey = false;
        screen.remove();
        requireAuth(opts).then(resolve);
        return;
      }
      const remoteDb = await github.fetchDb();
      state.github.needsEncKey = false;
      // Mark as synced (as app.js Phase 2 does) — without a _syncedAt, a
      // record added on this brand-new device and not yet pushed before the
      // next reload was treated as untrusted by mergeLocalPending and dropped.
      remoteDb._syncedAt = Date.now();
      remoteDb._syncedPlain = github.plainFieldsOf(remoteDb);
      setDb(remoteDb);
      github.applyDbConfig(remoteDb.appConfig?.github);
      github.saveLocalCache(remoteDb);
      screen.remove();
      requireAuth(opts).then(resolve);

      // Same protection as Phase 2's fetch in app.js: GitHub's Contents API can
      // occasionally serve a read a few seconds behind the latest commit, and
      // this is a brand-new device's very first load, with nothing local yet
      // to catch that lag. A confirmatory re-pull moments later, merged the
      // same way the app's own background sync does, self-heals it silently.
      // Skipped while anything is unsaved/being pushed or a form is open, and
      // merged against the CURRENT data — it used to setDb() unconditionally,
      // discarding whatever was entered right after sign-in.
      setTimeout(async () => {
        const busy = () => state.dirty || state.saving || !!document.querySelector('.modal-overlay.open, .ms-menu.open');
        if (busy()) return;
        const prevBase = state.github.remoteDb;
        try {
          const confirmDb = await github.fetchDb();
          const fetchedBase = state.github.remoteDb;
          // Restore the base only if nothing (e.g. a push) replaced it meanwhile.
          const restoreBase = () => { if (state.github.remoteDb === fetchedBase) state.github.remoteDb = prevBase; };
          if (busy()) { restoreBase(); return; }
          const reconciled = github.mergeLocalPending(confirmDb, structuredClone(state.db));
          const hasLocal = reconciled._hasLocalChanges;
          delete reconciled._hasLocalChanges;
          if (hasLocal) { restoreBase(); return; } // leave it to the next push's 3-way merge
          reconciled._syncedAt = Date.now();
          setDb(reconciled);
          github.saveLocalCache(reconciled);
        } catch { /* best-effort — the regular 60s backgroundResync will catch it anyway */ }
      }, 4000);
    } catch (e) {
      state.github.needsEncKey = true;
      errEl.textContent = 'Incorrect key, or could not load data: ' + e.message;
      btn.disabled = false;
    }
  };

  btn.onclick = doContinue;
  keyI.addEventListener('keydown', e => { if (e.key === 'Enter') doContinue(); });
  setTimeout(() => keyI.focus(), 50);
}

// Shown once per browser tab when a session resumed without re-entering a
// password (see requireAuth) but this device has an encryption key
// configured — needs the password once to unwrap it into memory.
function renderUnlock(screen, user, done, onSwitchUser) {
  screen.innerHTML = '';
  const card = el('div', { class: 'login-card' });
  card.appendChild(el('div', { class: 'login-brand' }, 'BT'));
  card.appendChild(el('div', { class: 'login-title' }, 'Business Tracking'));
  card.appendChild(el('div', { class: 'login-sub' }, `Welcome back, ${user.name || user.username} — unlock to continue`));

  const passwordI = input({ type: 'password', placeholder: 'Password', autocomplete: 'current-password' });
  const errEl = el('div', { class: 'login-error' });
  card.appendChild(formRow('Password', passwordI));
  card.appendChild(errEl);

  const btn = button('Unlock', { variant: 'primary' });
  btn.style.cssText = 'width:100%;margin-top:8px';
  card.appendChild(btn);

  const switchBtn = button('Not you? Switch user', { variant: 'ghost' });
  switchBtn.style.cssText = 'width:100%;margin-top:4px;font-size:12px';
  switchBtn.onclick = onSwitchUser;
  card.appendChild(switchBtn);

  screen.appendChild(card);

  const doUnlock = async () => {
    if (btn.disabled) return; // Enter while a previous attempt is still running
    const password = passwordI.value;
    if (!password) { errEl.textContent = 'Enter your password'; return; }
    errEl.textContent = '';
    btn.disabled = true;
    // Both checks cost a PBKDF2 derivation; run them side by side. The unlock
    // only derives its key until `verified` resolves true — a wrong password
    // leaves nothing unlocked or persisted, exactly as when they ran in turn.
    let allowUnlock;
    const verified = new Promise(r => { allowUnlock = r; });
    const unlocking = unlockOnLogin(password, { proceed: verified });
    unlocking.catch(() => {}); // awaited below on success; never an unhandled rejection
    try {
      const result = await verifyPassword(password, user);
      if (!result.ok) { allowUnlock(false); errEl.textContent = 'Incorrect password'; passwordI.value = ''; btn.disabled = false; return; }
      allowUnlock(true);
      await unlocking;
      await adoptToken();
      applyPasswordUpgrade(user, result);
      // See the matching comment in doLogin below — a wrapped key existing on
      // this device under a different user's password fails to unwrap
      // silently otherwise, with nothing telling the user why every
      // subsequent data read/write is broken.
      if (!isUnlocked() && hasWrappedKeyConfigured()) {
        toast('This device has an encryption key set up under a different user — paste the team’s key in Settings → Encryption to unlock your data here.', 'warning', 10000);
      }
      done();
    } catch (e) { errEl.textContent = 'Unlock error'; btn.disabled = false; }
    finally { allowUnlock(false); } // no-op once allowed; releases the gate on every other path
  };

  btn.onclick = doUnlock;
  passwordI.addEventListener('keydown', e => { if (e.key === 'Enter') doUnlock(); });
  setTimeout(() => passwordI.focus(), 50);
}

function renderLogin(screen, resolve) {
  screen.innerHTML = '';
  const card = el('div', { class: 'login-card' });
  card.appendChild(el('div', { class: 'login-brand' }, 'BT'));
  card.appendChild(el('div', { class: 'login-title' }, 'Business Tracking'));
  card.appendChild(el('div', { class: 'login-sub' }, 'Sign in to continue'));

  const usernameI = input({ placeholder: 'Username', autocomplete: 'username' });
  const passwordI = input({ type: 'password', placeholder: 'Password', autocomplete: 'current-password' });
  const errEl = el('div', { class: 'login-error' });

  card.appendChild(formRow('Username', usernameI));
  card.appendChild(formRow('Password', passwordI));
  card.appendChild(errEl);

  const btn = button('Sign In', { variant: 'primary' });
  btn.style.cssText = 'width:100%;margin-top:8px';
  card.appendChild(btn);
  screen.appendChild(card);

  const doLogin = async () => {
    if (btn.disabled) return; // Enter while a previous attempt is still running
    const username = usernameI.value.trim();
    const password = passwordI.value;
    if (!username || !password) { errEl.textContent = 'Enter username and password'; return; }
    errEl.textContent = '';
    btn.disabled = true;
    // Derive the wrap-key (PBKDF2) alongside the password check below; the
    // unlock commits nothing until `verified` resolves true, so a failed
    // login leaves no key unlocked or persisted — same as running in turn.
    let allowUnlock;
    const verified = new Promise(r => { allowUnlock = r; });
    const unlocking = unlockOnLogin(password, { proceed: verified });
    unlocking.catch(() => {}); // awaited below on success; never an unhandled rejection
    try {
      let user = listActive('users').find(u => u.username === username);
      let result = user ? await verifyPassword(password, user) : { ok: false };
      // A "wrong" password on THIS device can actually be stale data: app.js
      // Phase 1 logs in against whatever db.json this browser's localStorage
      // last cached, before the background GitHub sync ever runs — so a
      // password changed elsewhere (or on another device) still fails here
      // until that cache catches up. One fresh pull, only on a failed check,
      // tells a genuinely wrong password apart from a stale local cache
      // instead of reporting the same generic error for both.
      if (!result.ok && state.github?.owner && state.github?.repo) {
        try {
          const github = await import('./github.js');
          const remoteDb = await github.fetchDb();
          // Merge rather than overwrite: the local cache can hold offline
          // edits from the last session that haven't reached GitHub yet, and
          // a single mistyped password used to replace them (and the cache)
          // with the raw remote. Same rule as app.js Phase 4, which re-runs
          // this merge after login anyway.
          const merged = github.mergeLocalPending(remoteDb, structuredClone(state.db));
          const hasLocal = merged._hasLocalChanges;
          delete merged._hasLocalChanges;
          merged._syncedAt = hasLocal ? (state.db._syncedAt ?? null) : Date.now();
          setDb(merged);
          github.applyDbConfig(merged.appConfig?.github);
          github.saveLocalCache(merged);
          user = listActive('users').find(u => u.username === username);
          result = user ? await verifyPassword(password, user) : { ok: false };
        } catch { /* GitHub unreachable — fall through to the cached result */ }
      }
      if (!result.ok) {
        errEl.textContent = 'Invalid username or password';
        passwordI.value = '';
        btn.disabled = false;
        // Only the fact and time of a failed attempt is recorded — never the
        // typed username (people often type their password there by mistake).
        recordSessionEvent('failed_login').catch(() => {});
        return;
      }
      applyPasswordUpgrade(user, result);
      allowUnlock(true);
      await unlocking;
      await adoptToken();
      setSession(user);
      recordSessionEvent('login').catch(() => {});
      screen.remove();
      // A wrapped key exists on this device (someone set encryption up here
      // before) but this user's password couldn't unwrap it — it was wrapped
      // under a DIFFERENT user's password. Previously this failed silently:
      // login succeeded, but every subsequent data read/write throws
      // NO_ENC_KEY with nothing telling the user why. The fix (pasting the
      // team's key) already exists in Settings → Encryption; this just makes
      // sure the user learns they need it, right when it matters.
      if (!isUnlocked() && hasWrappedKeyConfigured()) {
        toast('This device has an encryption key set up under a different user — paste the team’s key in Settings → Encryption to unlock your data here.', 'warning', 10000);
      }
      resolve(state.session);
    } catch (e) { errEl.textContent = 'Sign in error'; btn.disabled = false; }
    finally { allowUnlock(false); } // no-op once allowed; releases the gate on every other path
  };

  btn.onclick = doLogin;
  passwordI.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  usernameI.addEventListener('keydown', e => { if (e.key === 'Enter') passwordI.focus(); });
  setTimeout(() => usernameI.focus(), 50);
}

function renderNoData(screen, resolve) {
  screen.innerHTML = '';
  const card = el('div', { class: 'login-card' });
  card.appendChild(el('div', { class: 'login-brand' }, 'BT'));
  card.appendChild(el('div', { class: 'login-title' }, 'Business Tracking'));
  card.appendChild(el('div', { class: 'login-sub' }, 'Could not load data from GitHub'));
  card.appendChild(el('div', {
    style: 'font-size:13px;color:var(--text-muted);margin:16px 0;line-height:1.6;text-align:center'
  }, 'The app is configured but could not reach the database — your token may be missing or expired. Open the setup link you were given, or ask your admin to share a new one.'));
  const retryBtn = button('Retry', { variant: 'primary' });
  retryBtn.style.cssText = 'width:100%;margin-top:4px';
  retryBtn.onclick = () => { location.reload(); };
  card.appendChild(retryBtn);
  screen.appendChild(card);
}

function renderSetup(screen, resolve) {
  screen.innerHTML = '';
  const card = el('div', { class: 'login-card' });
  card.appendChild(el('div', { class: 'login-brand' }, 'BT'));
  card.appendChild(el('div', { class: 'login-title' }, 'Business Tracking'));
  card.appendChild(el('div', { class: 'login-sub' }, 'Create your admin account to get started'));

  const nameI = input({ placeholder: 'Full name' });
  const usernameI = input({ placeholder: 'Username', autocomplete: 'username' });
  const passwordI = input({ type: 'password', placeholder: `Password (min ${MIN_PASSWORD_LENGTH} chars)`, autocomplete: 'new-password' });
  const errEl = el('div', { class: 'login-error' });

  card.appendChild(formRow('Name', nameI));
  card.appendChild(formRow('Username', usernameI));
  card.appendChild(formRow('Password', passwordI));
  card.appendChild(errEl);

  const btn = button('Create Account', { variant: 'primary' });
  btn.style.cssText = 'width:100%;margin-top:8px';
  card.appendChild(btn);
  screen.appendChild(card);

  btn.onclick = async () => {
    const name = nameI.value.trim();
    const username = usernameI.value.trim();
    const password = passwordI.value;
    if (!name || !username || !password) { errEl.textContent = 'All fields are required'; return; }
    if (password.length < MIN_PASSWORD_LENGTH) { errEl.textContent = `Password must be at least ${MIN_PASSWORD_LENGTH} characters`; return; }
    errEl.textContent = '';
    btn.disabled = true;
    try {
      const { hash, salt, iter } = await hashPassword(password);
      const user = { id: newId('usr'), username, name, role: 'admin', passwordHash: hash, passwordSalt: salt, passwordIter: iter };
      upsert('users', user);
      await unlockOnLogin(password);
      await adoptToken();
      setSession(user);
      recordSessionEvent('login').catch(() => {});
      screen.remove();
      // This device already has a key wrapped under a different password
      // (e.g. an existing team member's) — see the matching comment in
      // doLogin above for why this needs to be surfaced rather than left silent.
      if (!isUnlocked() && hasWrappedKeyConfigured()) {
        toast('This device has an encryption key set up under a different user — paste the team’s key in Settings → Encryption to unlock your data here.', 'warning', 10000);
      }
      resolve(state.session);
    } catch (e) { errEl.textContent = 'Error creating account'; btn.disabled = false; }
  };

  setTimeout(() => nameI.focus(), 50);
}
