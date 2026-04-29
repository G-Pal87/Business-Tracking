// Settings module: GitHub config, FX rates, services catalog, business info, team
import { state, markDirty } from '../core/state.js';
import { el, openModal, closeModal, confirmDialog, toast, select, input, formRow, textarea, button } from '../core/ui.js';
import { saveConfig, clearConfig, fetchDb, pushDb, saveLocalCache, resolveGitRemote } from '../core/github.js';
import { upsert, softDelete, listActive, newId, formatMoney } from '../core/data.js';
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
  wrap.appendChild(buildVendorsCard());
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

  // Auto-populate owner/repo from local .git when not already saved
  if (!g.owner || !g.repo) {
    resolveGitRemote().then(info => {
      if (!info) return;
      if (!ownerI.value) ownerI.value = info.owner;
      if (!repoI.value)  repoI.value  = info.repo;
    });
  }

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

  const renderCard = () => {
    card.innerHTML = '';
    card.appendChild(el('div', { class: 'card-header' },
      el('div', {},
        el('div', { class: 'card-title' }, 'HUF/EUR Annual Rates'),
        el('div', { class: 'card-subtitle' }, 'Fixed yearly conversion rate: 1 HUF = X EUR')
      ),
      button('+ Add Year', { variant: 'primary', onClick: () => openAddYearForm(renderCard) })
    ));

    const yearRates = state.db.settings?.fxRates?.yearRates || {};
    const years = Object.keys(yearRates).sort().reverse();

    if (years.length === 0) {
      card.appendChild(el('div', { class: 'empty' }, 'No rates defined. Add a year to get started.'));
    } else {
      const t = el('table', { class: 'table' });
      t.innerHTML = `<thead><tr><th>Year</th><th>1 HUF = EUR</th><th></th></tr></thead>`;
      const tb = el('tbody');
      for (const yr of years) {
        const rateI = input({ type: 'number', value: yearRates[yr], step: 0.000001, min: 0, style: 'width:140px' });
        const saveBtn = button('Save', { variant: 'sm primary', onClick: () => {
          const r = Number(rateI.value);
          if (!r || r <= 0) { toast('Enter a valid rate', 'danger'); return; }
          state.db.settings.fxRates.yearRates[yr] = r;
          markDirty();
          toast(`${yr} rate saved`, 'success');
        }});
        const delBtn = button('Del', { variant: 'sm ghost', onClick: async () => {
          const ok = await confirmDialog(`Remove the ${yr} rate?`, { danger: true, okLabel: 'Remove' });
          if (!ok) return;
          delete state.db.settings.fxRates.yearRates[yr];
          markDirty();
          renderCard();
        }});
        const td = el('td', { class: 'right' });
        td.appendChild(saveBtn);
        td.appendChild(delBtn);
        const tr = el('tr');
        tr.appendChild(el('td', {}, yr));
        tr.appendChild(el('td', {}, rateI));
        tr.appendChild(td);
        tb.appendChild(tr);
      }
      t.appendChild(tb);
      card.appendChild(el('div', { class: 'table-wrap' }, t));
    }

    const taxI = input({ type: 'number', value: state.db.settings?.defaultTaxRate || 0, min: 0, max: 100, step: 0.1 });
    card.appendChild(el('div', { class: 'form-row horizontal', style: 'margin-top:16px' },
      formRow('Default invoice tax %', taxI)
    ));
    card.appendChild(button('Save Tax Rate', { variant: 'primary', onClick: () => {
      state.db.settings.defaultTaxRate = Number(taxI.value) || 0;
      markDirty();
      toast('Saved', 'success');
    }}));
  };

  renderCard();
  return card;
}

function openAddYearForm(onDone) {
  const yearI = input({ type: 'number', value: new Date().getFullYear(), min: 2000, max: 2100, step: 1 });
  const rateI = input({ type: 'number', step: 0.000001, min: 0, placeholder: 'e.g. 0.00256' });
  const body = el('div', {});
  body.appendChild(formRow('Year', yearI));
  body.appendChild(formRow('1 HUF = EUR', rateI));
  const save = button('Add', { variant: 'primary', onClick: () => {
    const yr = String(Number(yearI.value) | 0);
    const r = Number(rateI.value);
    if (!yr || Number(yr) < 2000) { toast('Enter a valid year', 'danger'); return; }
    if (!r || r <= 0) { toast('Enter a valid rate', 'danger'); return; }
    if (!state.db.settings.fxRates.yearRates) state.db.settings.fxRates.yearRates = {};
    state.db.settings.fxRates.yearRates[yr] = r;
    markDirty();
    toast(`${yr} rate added`, 'success');
    closeModal();
    onDone();
  }});
  openModal({ title: 'Add Annual Rate', body, footer: [button('Cancel', { onClick: closeModal }), save] });
}

function buildBusinessCard() {
  const card = el('div', { class: 'card mb-16' });
  const b = state.db.settings?.business || {};
  card.appendChild(el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'Business Info (on invoices)')));
  const nameI = input({ value: b.name });
  const emailI = input({ value: b.email });
  const addressI = input({ value: b.address });
  const regI = input({ value: b.registrationNumber, placeholder: 'e.g. 01-09-123456' });
  const vatI = input({ value: b.vatNumber, placeholder: 'e.g. HU12345678' });
  const ibanI = input({ value: b.iban, placeholder: 'e.g. HU42 1177 3016 1111...' });
  const bicI = input({ value: b.bic, placeholder: 'e.g. OTPVHUHB' });
  const swiftI = input({ value: b.swift, placeholder: 'Same as BIC or separate SWIFT code' });
  bicI.oninput  = () => { bicI.value  = bicI.value.toUpperCase(); };
  swiftI.oninput = () => { swiftI.value = swiftI.value.toUpperCase(); };
  card.appendChild(el('div', { class: 'form-row horizontal' }, formRow('Business Name', nameI), formRow('Email', emailI)));
  card.appendChild(formRow('Address', addressI));
  card.appendChild(el('div', { class: 'form-row horizontal' }, formRow('Company Registration No.', regI), formRow('VAT Number', vatI)));
  card.appendChild(el('div', { class: 'form-row horizontal' }, formRow('IBAN', ibanI), formRow('BIC', bicI)));
  card.appendChild(formRow('SWIFT', swiftI, 'Used on invoice payment details. BIC and SWIFT are often identical.'));
  const save = button('Save', { variant: 'primary', onClick: () => {
    const iban  = ibanI.value.trim().replace(/\s/g, '').toUpperCase();
    const bic   = bicI.value.trim().toUpperCase();
    const swift = swiftI.value.trim().toUpperCase();
    const reg   = regI.value.trim();
    const BIC_RE = /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/;
    if (iban  && !/^[A-Z]{2}\d{2}[A-Z0-9]{1,30}$/.test(iban))  { toast('IBAN format looks incorrect', 'warning'); }
    if (bic   && !BIC_RE.test(bic))   { toast('BIC must be 8 or 11 characters (e.g. OTPVHUHB)', 'warning'); }
    if (swift && !BIC_RE.test(swift)) { toast('SWIFT must be 8 or 11 characters (e.g. OTPVHUHBXXX)', 'warning'); }
    if (reg   && !/^[A-Z0-9][A-Z0-9 \-\.]{3,}$/i.test(reg)) { toast('Company registration number looks incorrect', 'warning'); }
    state.db.settings.business = {
      ...b,
      name: nameI.value.trim(),
      email: emailI.value.trim(),
      address: addressI.value.trim(),
      registrationNumber: reg,
      vatNumber: vatI.value.trim(),
      iban,
      bic,
      swift
    };
    markDirty();
    toast('Saved', 'success');
  }});
  card.appendChild(save);
  return card;
}

function buildVendorsCard() {
  const card = el('div', { class: 'card mb-16' });
  card.appendChild(el('div', { class: 'card-header' },
    el('div', {}, el('div', { class: 'card-title' }, 'Vendors'), el('div', { class: 'card-subtitle' }, 'Cleaners, maintenance, management companies')),
    button('+ Add Vendor', { variant: 'primary', onClick: () => openVendorForm() })
  ));
  const vendors = listActive('vendors');
  if (vendors.length === 0) {
    card.appendChild(el('div', { class: 'empty' }, 'No vendors'));
    return card;
  }
  const t = el('table', { class: 'table' });
  t.innerHTML = `<thead><tr><th>Name</th><th>Type</th><th>Properties</th><th>Contact</th><th></th></tr></thead>`;
  const tb = el('tbody');
  for (const v of vendors) {
    const props = (state.db.properties || []).filter(p => (v.propertyIds || []).includes(p.id)).map(p => p.name).join(', ');
    const tr = el('tr');
    tr.appendChild(el('td', {}, v.name));
    tr.appendChild(el('td', {}, el('span', { class: 'badge' }, v.type)));
    tr.appendChild(el('td', { class: 'muted', style: 'font-size:12px' }, props || 'All'));
    tr.appendChild(el('td', { class: 'muted', style: 'font-size:12px' }, v.email || ''));
    const actions = el('td', { class: 'right' });
    actions.appendChild(button('Edit', { variant: 'sm ghost', onClick: () => openVendorForm(v) }));
    actions.appendChild(button('Del', { variant: 'sm ghost', onClick: async () => {
      const ok = await confirmDialog(`Delete vendor ${v.name}?`, { danger: true, okLabel: 'Delete' });
      if (ok) { softDelete('vendors', v.id); toast('Deleted', 'success'); setTimeout(() => location.hash = 'settings', 200); }
    }}));
    tr.appendChild(actions);
    tb.appendChild(tr);
  }
  t.appendChild(tb);
  const tw = el('div', { class: 'table-wrap' }); tw.appendChild(t);
  card.appendChild(tw);
  return card;
}

function openVendorForm(existing) {
  const v = existing ? { ...existing } : {
    id: newId('vnd'), name: '', type: 'cleaner', email: '', phone: '',
    pricing: { studio: 0, one_bedroom: 0, two_bedroom: 0, three_bedroom_plus: 0 },
    currency: 'EUR', propertyIds: [], notes: ''
  };
  const body = el('div', {});
  const nameI = input({ value: v.name });
  const typeS = select(['cleaner', 'maintenance', 'management', 'other'], v.type);
  const emailI = input({ value: v.email, type: 'email' });
  const phoneI = input({ value: v.phone });
  const currencyS = select(CURRENCIES, v.currency);
  const notesT = textarea(); notesT.value = v.notes || '';

  const pricing = { ...v.pricing };
  const studioI = input({ type: 'number', value: pricing.studio || 0, min: 0 });
  const oneBedI = input({ type: 'number', value: pricing.one_bedroom || 0, min: 0 });
  const twoBedI = input({ type: 'number', value: pricing.two_bedroom || 0, min: 0 });
  const threePlusI = input({ type: 'number', value: pricing.three_bedroom_plus || 0, min: 0 });

  const propChecks = el('div', { class: 'flex', style: 'flex-wrap:wrap;gap:8px' });
  for (const p of state.db.properties || []) {
    const cb = el('input', { type: 'checkbox', id: `vc_${p.id}` });
    cb.checked = (v.propertyIds || []).includes(p.id);
    propChecks.appendChild(el('label', { style: 'display:flex;align-items:center;gap:4px;font-size:12px' }, cb, p.name));
  }

  body.appendChild(el('div', { class: 'form-row horizontal' }, formRow('Name', nameI), formRow('Type', typeS)));
  body.appendChild(el('div', { class: 'form-row horizontal' }, formRow('Email', emailI), formRow('Phone', phoneI)));
  body.appendChild(el('div', { class: 'form-row horizontal' }, formRow('Currency', currencyS)));
  body.appendChild(el('div', { class: 'card', style: 'background:var(--bg);padding:12px;margin-bottom:12px' },
    el('div', { class: 'card-title mb-8' }, 'Cleaning Price per Apt Type'),
    el('div', { class: 'form-row horizontal' }, formRow('Studio', studioI), formRow('1 Bedroom', oneBedI)),
    el('div', { class: 'form-row horizontal' }, formRow('2 Bedroom', twoBedI), formRow('3+ Bedroom', threePlusI))
  ));
  body.appendChild(formRow('Properties', propChecks));
  body.appendChild(formRow('Notes', notesT));

  const save = button('Save', { variant: 'primary', onClick: () => {
    if (!nameI.value.trim()) { toast('Name required', 'danger'); return; }
    const selectedProps = [...document.querySelectorAll('[id^="vc_"]')].filter(c => c.checked).map(c => c.id.replace('vc_', ''));
    Object.assign(v, {
      name: nameI.value.trim(), type: typeS.value, email: emailI.value.trim(),
      phone: phoneI.value.trim(), currency: currencyS.value,
      pricing: { studio: Number(studioI.value), one_bedroom: Number(oneBedI.value), two_bedroom: Number(twoBedI.value), three_bedroom_plus: Number(threePlusI.value) },
      propertyIds: selectedProps, notes: notesT.value.trim()
    });
    upsert('vendors', v);
    toast('Vendor saved', 'success');
    closeModal();
    setTimeout(() => location.hash = 'settings', 200);
  }});
  openModal({ title: existing ? 'Edit Vendor' : 'New Vendor', body, footer: [button('Cancel', { onClick: closeModal }), save] });
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
  const services = listActive('services');
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
        if (ok) { softDelete('services', s.id); toast('Deleted', 'success'); setTimeout(() => location.hash = 'settings', 200); }
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
