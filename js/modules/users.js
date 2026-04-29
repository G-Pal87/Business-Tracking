// Users module - admin only
import { state } from '../core/state.js';
import { el, openModal, closeModal, confirmDialog, toast, input, select, formRow, button, attachSortFilter } from '../core/ui.js';
import { upsert, softDelete, listActive, newId } from '../core/data.js';
import { hashPassword } from '../core/auth.js';

export default {
  id: 'users',
  label: 'Users',
  icon: 'U',
  render(container) { container.appendChild(build()); },
  refresh() { const c = document.getElementById('content'); c.innerHTML = ''; c.appendChild(build()); },
  destroy() {}
};

function build() {
  if (state.session?.role !== 'admin') {
    return el('div', { class: 'empty' },
      el('div', { class: 'empty-icon' }, 'U'),
      'Access denied. Admin role required.'
    );
  }

  const wrap = el('div', { class: 'view active' });
  const filterBar = el('div', { class: 'flex gap-8 mb-16' });
  filterBar.appendChild(el('div', { class: 'flex-1' }));
  filterBar.appendChild(button('+ Add User', { variant: 'primary', onClick: () => openForm(null, wrap) }));
  wrap.appendChild(filterBar);

  const tableCard = el('div', { class: 'card' });
  wrap.appendChild(tableCard);
  renderTable(tableCard, wrap);
  return wrap;
}

function renderTable(container, wrap) {
  container.innerHTML = '';
  const users = listActive('users');

  if (users.length === 0) {
    container.appendChild(el('div', { class: 'empty' }, 'No users yet.'));
    return;
  }

  const tw = el('div', { class: 'table-wrap' });
  const t = el('table', { class: 'table' });
  t.innerHTML = '<thead><tr><th>Name</th><th>Username</th><th>Role</th><th></th></tr></thead>';
  const tb = el('tbody');

  for (const u of users) {
    const tr = el('tr');
    tr.appendChild(el('td', {}, u.name));
    tr.appendChild(el('td', {}, u.username));
    tr.appendChild(el('td', {}, el('span', { class: 'badge' }, u.role)));
    const actions = el('td', { class: 'right' });
    actions.appendChild(button('Edit', { variant: 'sm ghost', onClick: () => openForm(u, wrap) }));
    actions.appendChild(button('Del', {
      variant: 'sm ghost',
      onClick: async () => {
        if (u.id === state.session?.userId) { toast('Cannot delete your own account', 'warning'); return; }
        const ok = await confirmDialog(`Delete user "${u.username}"?`, { danger: true, okLabel: 'Delete' });
        if (!ok) return;
        softDelete('users', u.id);
        toast('User deleted', 'success');
        const c = document.getElementById('content');
        c.innerHTML = '';
        c.appendChild(build());
      }
    }));
    tr.appendChild(actions);
    tb.appendChild(tr);
  }

  t.appendChild(tb);
  tw.appendChild(t);
  container.appendChild(tw);
  attachSortFilter(tw);
}

function openForm(existing, wrap) {
  const isNew = !existing;
  const u = existing ? { ...existing } : { id: newId('usr'), username: '', name: '', role: 'user', passwordHash: '' };

  const body = el('div', {});
  const nameI = input({ value: u.name, placeholder: 'Full name' });
  const usernameI = input({ value: u.username, placeholder: 'Username', autocomplete: 'off' });
  const roleS = select([{ value: 'admin', label: 'Admin' }, { value: 'user', label: 'User' }], u.role);
  const passwordI = input({ type: 'password', placeholder: isNew ? 'Password' : 'New password (leave blank to keep)', autocomplete: 'new-password' });

  body.appendChild(formRow('Name', nameI));
  body.appendChild(formRow('Username', usernameI));
  body.appendChild(formRow('Role', roleS));
  body.appendChild(formRow(isNew ? 'Password' : 'Change Password', passwordI));

  const saveBtn = button('Save', {
    variant: 'primary',
    onClick: async () => {
      const name = nameI.value.trim();
      const username = usernameI.value.trim();
      const password = passwordI.value;
      if (!name || !username) { toast('Name and username are required', 'danger'); return; }
      if (isNew && !password) { toast('Password is required', 'danger'); return; }
      if (password && password.length < 6) { toast('Password must be at least 6 characters', 'danger'); return; }
      const dup = listActive('users').find(x => x.username === username && x.id !== u.id);
      if (dup) { toast('Username already taken', 'danger'); return; }
      Object.assign(u, { name, username, role: roleS.value });
      if (password) u.passwordHash = await hashPassword(password);
      upsert('users', u);
      toast(isNew ? 'User created' : 'User updated', 'success');
      closeModal();
      const c = document.getElementById('content');
      c.innerHTML = '';
      c.appendChild(build());
    }
  });

  openModal({ title: isNew ? 'New User' : 'Edit User', body, footer: [button('Cancel', { onClick: closeModal }), saveBtn] });
}
