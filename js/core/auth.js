// Auth: session management + login/setup screen
import { state, setDb } from './state.js';
import { el, input, formRow, button } from './ui.js';
import { newId, upsert, listActive } from './data.js';
import { unlockOnLogin, lockOnLogout, hasWrappedKeyConfigured, isUnlocked, setBootstrapDataKey, importDataKeyFromBase64 } from './crypto.js';
import { recordSessionEvent } from './presence.js';

const SESSION_KEY = 'bt_session';
const PBKDF2_ITERATIONS = 150000;
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
export async function hashPassword(password, saltB64 = null) {
  const salt = saltB64 ? b64decode(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial, 256
  );
  const hash = Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2, '0')).join('');
  return { hash, salt: b64encode(salt) };
}

// Verifies a password against a user record. Supports both the current
// salted scheme and the legacy unsalted one, so pre-existing accounts don't
// need a forced reset — a successful legacy login is transparently upgraded
// (caller should upsert the returned newHash/newSalt onto the user record).
export async function verifyPassword(password, user) {
  if (user.passwordSalt) {
    const { hash } = await hashPassword(password, user.passwordSalt);
    return { ok: hash === user.passwordHash, needsUpgrade: false };
  }
  const legacyHash = await legacySha256(password);
  if (legacyHash !== user.passwordHash) return { ok: false, needsUpgrade: false };
  const { hash, salt } = await hashPassword(password);
  return { ok: true, needsUpgrade: true, newHash: hash, newSalt: salt };
}

export function getSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export function setSession(user) {
  const s = { userId: user.id, username: user.username, role: user.role, name: user.name, expiresAt: Date.now() + SESSION_IDLE_MS };
  localStorage.setItem(SESSION_KEY, JSON.stringify(s));
  state.session = s;
}

export function clearSession() {
  localStorage.removeItem(SESSION_KEY);
  state.session = null;
  lockOnLogout();
}

export function requireAuth() {
  return new Promise(resolve => {
    // listActive() excludes soft-deleted accounts, so a "removed" user's
    // already-open session is rejected on the next reload instead of
    // continuing to pass this check indefinitely.
    const users = listActive('users');
    const stored = getSession();
    // Sessions saved before expiresAt existed have no such field at all —
    // `!= null` (not a plain falsy/undefined check) so those are treated as
    // not-yet-expired and simply gain a real expiry on this check, rather
    // than every existing user being logged out the moment this shipped.
    const expired = stored?.expiresAt != null && Date.now() > stored.expiresAt;
    const liveUser = (stored && !expired) ? users.find(u => u.id === stored.userId) : null;
    if (liveUser) {
      // Re-sync from the live record so a role/name change an admin makes
      // takes effect the next time this user's session is checked, instead
      // of being stuck with whatever was cached in localStorage at login.
      // Also rolls the idle-timeout expiry forward — see SESSION_IDLE_MS.
      state.session = { userId: liveUser.id, username: liveUser.username, role: liveUser.role, name: liveUser.name, expiresAt: Date.now() + SESSION_IDLE_MS };
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
          () => { clearSession(); screen.remove(); requireAuth().then(resolve); }
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
    if (state.github?.needsEncKey) { renderBootstrapUnlock(screen, resolve); return; }
    const hasGithubConfig = !!(state.github?.owner && state.github?.repo);
    if (users.length === 0 && hasGithubConfig) renderNoData(screen, resolve);
    else if (users.length === 0) renderSetup(screen, resolve);
    else renderLogin(screen, resolve);
  });
}

// Shown on a brand-new device when the very first data fetch failed because
// db.json is encrypted and no key has been entered here yet (see app.js
// Phase 2 and crypto.js's NO_ENC_KEY). Unlike renderUnlock, there is no known
// user yet to check a password against — this only unblocks the data fetch;
// a normal login/setup screen renders afterward once real user records exist.
function renderBootstrapUnlock(screen, resolve) {
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
      const remoteDb = await github.fetchDb();
      state.github.needsEncKey = false;
      setDb(remoteDb);
      github.applyDbConfig(remoteDb.appConfig?.github);
      github.saveLocalCache(remoteDb);
      screen.remove();
      requireAuth().then(resolve);
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
    const password = passwordI.value;
    if (!password) { errEl.textContent = 'Enter your password'; return; }
    errEl.textContent = '';
    btn.disabled = true;
    try {
      const result = await verifyPassword(password, user);
      if (!result.ok) { errEl.textContent = 'Incorrect password'; passwordI.value = ''; btn.disabled = false; return; }
      await unlockOnLogin(password);
      done();
    } catch (e) { errEl.textContent = 'Unlock error'; btn.disabled = false; }
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
    const username = usernameI.value.trim();
    const password = passwordI.value;
    if (!username || !password) { errEl.textContent = 'Enter username and password'; return; }
    errEl.textContent = '';
    btn.disabled = true;
    try {
      const user = listActive('users').find(u => u.username === username);
      const result = user ? await verifyPassword(password, user) : { ok: false };
      if (!result.ok) {
        errEl.textContent = 'Invalid username or password';
        passwordI.value = '';
        btn.disabled = false;
        // Logged under the attempted username, not a real session — this can
        // be someone mistyping their own password or an actual intrusion
        // attempt, and admins have no other way to tell which without this.
        recordSessionEvent('failed_login', { username, name: user?.name || username }).catch(() => {});
        return;
      }
      if (result.needsUpgrade) {
        upsert('users', { ...user, passwordHash: result.newHash, passwordSalt: result.newSalt });
      }
      await unlockOnLogin(password);
      setSession(user);
      recordSessionEvent('login').catch(() => {});
      screen.remove();
      resolve(state.session);
    } catch (e) { errEl.textContent = 'Sign in error'; btn.disabled = false; }
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
  const passwordI = input({ type: 'password', placeholder: 'Password (min 6 chars)', autocomplete: 'new-password' });
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
    if (password.length < 6) { errEl.textContent = 'Password must be at least 6 characters'; return; }
    errEl.textContent = '';
    btn.disabled = true;
    try {
      const { hash, salt } = await hashPassword(password);
      const user = { id: newId('usr'), username, name, role: 'admin', passwordHash: hash, passwordSalt: salt };
      upsert('users', user);
      await unlockOnLogin(password);
      setSession(user);
      recordSessionEvent('login').catch(() => {});
      screen.remove();
      resolve(state.session);
    } catch (e) { errEl.textContent = 'Error creating account'; btn.disabled = false; }
  };

  setTimeout(() => nameI.focus(), 50);
}
