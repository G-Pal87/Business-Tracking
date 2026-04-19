// Settings module: GitHub config, FX rates, services catalog, business info, team
import { state, markDirty } from '../core/state.js';
import { el, openModal, closeModal, confirmDialog, toast, select, input, formRow, textarea, button } from '../core/ui.js';
import { saveConfig, clearConfig, fetchDb, pushDb, saveLocalCache } from '../core/github.js';
import { upsert, remove, newId, formatMoney } from '../core/data.js';
import { setDb } from '../core/state.js';
import { CURRENCIES, SERVICE_UNITS, STREAMS, SERVICE_STREAMS } from '../core/config.js';

export default {
  id: 'settings',
  label: 'Settings',
  icon: 'G',
  render(container) { container.appendChild(build()); },
  refresh() { const c = document.getElementById('content'); c.innerHTML = ''; c.appendChild(build()); },
  destroy() {}
};

function build() {
  const wrap = el('div', { class: 'view active' });

  wrap.appendChild(buildGithubCard());
  wrap.appendChild(buildCurrencyCard());
  wrap.appendChild(buildBusinessCard());
  wrap.appendChild(buildServicesCard());
  wrap.appendChild(buildTeamCard());
  wrap.appendChild(buildDangerCard());
  return wrap;
}

function buildGithubCard() {
  const card = el('div', { class: 'card mb-16' });
  const g = state.github;
  card.appendChild(el('div', { class: 'card-header' },
    el('div', {},
      el('div', { class: 'card-title' }, 'GitHub Storage'),
      el('div', { class: 'card-subtitle' }, 'Sync data to a repo so it is accessible to everyone')
    ),
    g.connected
      ? el('span', { class: 'badge success' }, 'Connected')
      : el('span', { class: 'badge' }, 'Not connected')
  ));

  const ownerI = input({ value: g.owner, placeholder: 'github-username' });
  const repoI = input({ value: g.repo, placeholder: 'business-tracking' });
  const branchI = input({ value: g.branch || 'main', placeholder: 'main' });
  const tokenI = input({ value: g.token ? '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022' : '', type: 'password', placeholder: 'Personal Access Token' });

  card.appendChild(el('div', { class: 'form-row horizontal' }, formRow('Owner', ownerI), formRow('Repo', repoI)));
  card.appendChild(el('div', { class: 'form-row horizontal' }, formRow('Branch', branchI), formRow('Token (PAT)', tokenI, 'Requires repo scope. Stored in localStorage only.')));

  const saveBtn = button('Save & Pull', { variant: 'primary', onClick: async () => {
    const token = tokenI.value.includes('\u2022') ? g.token : tokenI.value.trim();
    saveConfig({ token, owner: ownerI.value.trim(), repo: repoI.value.trim(), branch: branchI.value.trim() });
    try {
      const db = await fetchDb();
      setDb(db);
      saveLocalCache(db);
      toast('Connected! Data loaded from GitHub.', 'success');
      setTimeout(() => location.hash = 'dashboard', 250);
    } catch (e) {
      toast('Pull failed: ' + e.message, 'danger', 5000);
    }
  }});
  const pushBtn = button('Push to GitHub', { onClick: async () => {
    try {
      await pushDb(state.db, 'Manual sync from app');
      state.dirty = false;
      toast('Data pushed to GitHub', 'success');
    } catch (e) {
      toast('Push failed: ' + e.message, 'danger', 5000);
    }
  }});
  const disconnect = button('Disconnect', { variant: 'danger', onClick: () => {
    clearConfig();
    toast('Disconnected', 'info');
    setTimeout(() => location.hash = 'settings', 200);
  }});

  card.appendChild(el('div', { class: 'flex gap-8' }, saveBtn, pushBtn, g.token ? disconnect : null));
  return card;
}

function buildCurrencyCard() {
  const card = el('div', { class: 'card mb-16' });
  card.appendChild(el('div', { class: 'card-header' },
    el('div', {},
      el('div', { class: 'card-title' }, 'Currencies'),
      el('div', { class: 'card-subtitle' }, `Master currency: ${state.db.settings?.masterCurrency || 'EUR'}`)
    )
  ));
  const fx = state.db.settings?.fxRates?.HUF_EUR || 0.0025;
  const rateI = input({ type: 'number', value: fx, step: 0.0001 });
  const taxI = input({ type: 'number', value: state.db.settings?.defaultTaxRate || 0, min: 0, max: 100, step: 0.1 });
  card.appendChild(el('div', { class: 'form-row horizontal' },
    formRow('HUF -> EUR rate', rateI, `1 HUF = ${fx} EUR . Example: 350,000 HUF = ${formatMoney(350000 * fx, 'EUR')}`),
    formRow('Default invoice tax %', taxI)
  ));
  const save = button('Save', { variant: 'primary', onClick: () => {
    state.db.settings.fxRates = { HUF_EUR: Number(rateI.value) };
    state.db.settings.defaultTaxRate = Number(taxI.value) || 0;
    markDirty();
    toast('Saved', 'success');
    setTimeout(() => location.hash = 'settings', 200);
  }});
  card.appendChild(save);
  return card;
}

function buildBusinessCard() {
  const card = el('div', { class: 'card mb-16' });
  const b = state.db.settings?.business || {};
  card.appendChild(el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'Business Info (on invoices)')));
  const nameI = input({ value: b.name });
  const emailI = input({ value: b.email });
  const addressI = input({ value: b.address });
  const vatI = input({ value: b.vatNumber });
  const ibanI = input({ value: b.iban });
  const bicI = input({ value: b.bic });
  card.appendChild(el('div', { class: 'form-row horizontal' }, formRow('Business Name', nameI), formRow('Email', emailI)));
  card.appendChild(formRow('Address', addressI));
  card.appendChild(el('div', { class: 'form-row horizontal' }, formRow('VAT Number', vatI), formRow('IBAN', ibanI)));
  card.appendChild(formRow('BIC / SWIFT', bicI));
  const save = button('Save', { variant: 'primary', onClick: () => {
    state.db.settings.business = {
      name: nameI.value.trim(),
      email: emailI.value.trim(),
      address: addressI.value.trim(),
      vatNumber: vatI.value.trim(),
      iban: ibanI.value.trim(),
      bic: bicI.value.trim()
    };
    markDirty();
    toast('Saved', 'success');
  }});
  card.appendChild(save);
  return card;
}

function buildServicesCard() {
  const card = el('div', { class: 'card mb-16' });
  card.appendChild(el('div', { class: 'card-header' },
    el('div', {},
      el('div', { class: 'card-title' }, 'Service Catalog'),
      el('div', { class: 'card-subtitle' }, 'Premade services used when building invoices')
    ),
    button('+ Add Service', { variant: 'primary', onClick: () => openServiceForm() })
  ));
  const services = state.db.services || [];
  if (services.length === 0) {
    card.appendChild(el('div', { class: 'empty' }, 'No services'));
  } else {
    const t = el('table', { class: 'table' });
    t.innerHTML = `<thead><tr><th>Name</th><th>Stream</th><th>Unit</th><th class="right">Rate</th><th></th></tr></thead>`;
    const tb = el('tbody');
    for (const s of services) {
      const tr = el('tr');
      tr.appendChild(el('td', {}, s.name));
      tr.appendChild(el('td', {}, el('span', { class: `badge ${STREAMS[s.stream]?.css || ''}` }, STREAMS[s.stream]?.short || s.stream)));
      tr.appendChild(el('td', {}, s.unit));
      tr.appendChild(el('td', { class: 'right num' }, formatMoney(s.defaultRate, s.currency)));
      const actions = el('td', { class: 'right' });
      actions.appendChild(button('Edit', { variant: 'sm ghost', onClick: () => openServiceForm(s) }));
      actions.appendChild(button('Del', { variant: 'sm ghost', onClick: async () => {
        const ok = await confirmDialog(`Delete service ${s.name}?`, { danger: true, okLabel: 'Delete' });
        if (ok) { remove('services', s.id); toast('Deleted', 'success'); setTimeout(() => location.hash = 'settings', 200); }
      }}));
      tr.appendChild(actions);
      tb.appendChild(tr);
    }
    t.appendChild(tb);
    const tw = el('div', { class: 'table-wrap' }); tw.appendChild(t);
    card.appendChild(tw);
  }
  return card;
}

function openServiceForm(existing) {
  const s = existing ? { ...existing } : { id: newId('svc'), name: '', description: '', unit: 'day', defaultRate: 0, currency: 'EUR', stream: 'customer_success' };
  const body = el('div', {});
  const nameI = input({ value: s.name });
  const descI = input({ value: s.description });
  const unitS = select(Object.entries(SERVICE_UNITS).map(([v, l]) => ({ value: v, label: l })), s.unit);
  const rateI = input({ type: 'number', value: s.defaultRate, min: 0, step: 0.01 });
  const currencyS = select(CURRENCIES, s.currency);
  const streamS = select(SERVICE_STREAMS.map(v => ({ value: v, label: STREAMS[v].label })), s.stream);
  body.appendChild(formRow('Name', nameI));
  body.appendChild(formRow('Description', descI));
  body.appendChild(el('div', { class: 'form-row horizontal' }, formRow('Unit', unitS), formRow('Stream', streamS)));
  body.appendChild(el('div', { class: 'form-row horizontal' }, formRow('Default Rate', rateI), formRow('Currency', currencyS)));

  const save = button('Save', { variant: 'primary', onClick: () => {
    if (!nameI.value.trim()) { toast('Name required', 'danger'); return; }
    Object.assign(s, {
      name: nameI.value.trim(), description: descI.value.trim(),
      unit: unitS.value, defaultRate: Number(rateI.value) || 0,
      currency: currencyS.value, stream: streamS.value
    });
    upsert('services', s);
    toast('Saved', 'success');
    closeModal();
    setTimeout(() => location.hash = 'settings', 200);
  }});
  openModal({ title: existing ? 'Edit Service' : 'New Service', body, footer: [button('Cancel', { onClick: closeModal }), save] });
}

function buildTeamCard() {
  const card = el('div', { class: 'card mb-16' });
  card.appendChild(el('div', { class: 'card-header' },
    el('div', { class: 'card-title' }, 'Team')
  ));
  const team = state.db.settings?.team || [];
  const rows = el('div', {});
  for (const t of team) {
    const nameI = input({ value: t.name });
    const roleI = input({ value: t.role });
    const row = el('div', { class: 'form-row horizontal' },
      formRow(`${t.id} - name`, nameI),
      formRow(`${t.id} - role`, roleI)
    );
    rows.appendChild(row);
    nameI.onchange = () => { t.name = nameI.value.trim(); markDirty(); };
    roleI.onchange = () => { t.role = roleI.value.trim(); markDirty(); };
  }
  card.appendChild(rows);
  return card;
}

function buildDangerCard() {
  const card = el('div', { class: 'card mb-16' });
  card.appendChild(el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'Data')));
  const exportBtn = button('Export JSON', { onClick: () => {
    const blob = new Blob([JSON.stringify(state.db, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `db-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
  }});
  const importInput = input({ type: 'file', accept: '.json', style: 'display:none' });
  importInput.onchange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    try {
      const db = JSON.parse(text);
      const ok = await confirmDialog('Replace all current data with this JSON file? (Local only until you push to GitHub.)', { danger: true, okLabel: 'Replace' });
      if (ok) {
        setDb(db);
        saveLocalCache(db);
        toast('Data replaced', 'success');
        setTimeout(() => location.hash = 'dashboard', 200);
      }
    } catch (e) {
      toast('Invalid JSON', 'danger');
    }
  };
  const importBtn = button('Import JSON', { onClick: () => importInput.click() });
  card.appendChild(el('div', { class: 'flex gap-8' }, exportBtn, importBtn, importInput));
  return card;
}
