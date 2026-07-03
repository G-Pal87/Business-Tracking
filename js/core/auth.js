// Auth: session management + login/setup screen
import { state } from './state.js';
import { el, input, formRow, button } from './ui.js';
import { newId, upsert, listActive } from './data.js';

const SESSION_KEY = 'bt_session';
const PBKDF2_ITERATIONS = 150000;

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
  const s = { userId: user.id, username: user.username, role: user.role, name: user.name };
  localStorage.setItem(SESSION_KEY, JSON.stringify(s));
  state.session = s;
}

export function clearSession() {
  localStorage.removeItem(SESSION_KEY);
  state.session = null;
}

export function requireAuth() {
  return new Promise(resolve => {
    // listActive() excludes soft-deleted accounts, so a "removed" user's
    // already-open session is rejected on the next reload instead of
    // continuing to pass this check indefinitely.
    const users = listActive('users');
    const stored = getSession();
    const liveUser = stored ? users.find(u => u.id === stored.userId) : null;
    if (liveUser) {
      // Re-sync from the live record so a role/name change an admin makes
      // takes effect the next time this user's session is checked, instead
      // of being stuck with whatever was cached in localStorage at login.
      state.session = { userId: liveUser.id, username: liveUser.username, role: liveUser.role, name: liveUser.name };
      localStorage.setItem(SESSION_KEY, JSON.stringify(state.session));
      resolve(state.session);
      return;
    }
    if (stored) clearSession(); // session pointed at a deleted/missing account
    const screen = el('div', { id: 'login-screen', class: 'login-screen' });
    document.body.appendChild(screen);
    const hasGithubConfig = !!(state.github?.owner && state.github?.repo);
    if (users.length === 0 && hasGithubConfig) renderNoData(screen, resolve);
    else if (users.length === 0) renderSetup(screen, resolve);
    else renderLogin(screen, resolve);
  });
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
      if (!result.ok) { errEl.textContent = 'Invalid username or password'; passwordI.value = ''; btn.disabled = false; return; }
      if (result.needsUpgrade) {
        upsert('users', { ...user, passwordHash: result.newHash, passwordSalt: result.newSalt });
      }
      setSession(user);
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
      setSession(user);
      screen.remove();
      resolve(state.session);
    } catch (e) { errEl.textContent = 'Error creating account'; btn.disabled = false; }
  };

  setTimeout(() => nameI.focus(), 50);
}
