// Auth: session management + login/setup screen
import { state, markDirty } from './state.js';
import { el, input, formRow, button } from './ui.js';
import { newId } from './data.js';

const SESSION_KEY = 'bt_session';

export async function hashPassword(password) {
  const data = new TextEncoder().encode(password);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
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
    const users = state.db.users || [];
    const stored = getSession();
    if (stored && users.find(u => u.id === stored.userId)) {
      state.session = stored;
      resolve(state.session);
      return;
    }
    const screen = el('div', { id: 'login-screen', class: 'login-screen' });
    document.body.appendChild(screen);
    if (users.length === 0) renderSetup(screen, resolve);
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
      const hash = await hashPassword(password);
      const user = (state.db.users || []).find(u => u.username === username && u.passwordHash === hash);
      if (!user) { errEl.textContent = 'Invalid username or password'; passwordI.value = ''; btn.disabled = false; return; }
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
      const hash = await hashPassword(password);
      const user = { id: newId('usr'), username, name, role: 'admin', passwordHash: hash };
      if (!state.db.users) state.db.users = [];
      state.db.users.push(user);
      markDirty();
      setSession(user);
      screen.remove();
      resolve(state.session);
    } catch (e) { errEl.textContent = 'Error creating account'; btn.disabled = false; }
  };

  setTimeout(() => nameI.focus(), 50);
}
