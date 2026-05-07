// Settings module: GitHub config, FX rates, services catalog, business info, team
import { state, markDirty } from '../core/state.js';
import { el, openModal, closeModal, confirmDialog, toast, select, input, formRow, textarea, button } from '../core/ui.js';
import { saveConfig, clearConfig, fetchDb, saveLocalCache, listGithubFolder, fetchGithubFile, uploadGithubFile, deleteGithubFile } from '../core/github.js';
import { navigate } from '../core/router.js';
import { upsert, softDelete, listActive, newId, formatMoney, listDeletedRecords, restoreRecord, permanentlyDeleteRecord, restoreRecords, permanentlyDeleteRecords, purgeDeletedRecords } from '../core/data.js';
import { setDb } from '../core/state.js';
import { CURRENCIES, SERVICE_UNITS, STREAMS, SERVICE_STREAMS } from '../core/config.js';
import { generateInvoicePDF } from '../core/pdf.js';

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
  wrap.appendChild(buildInvoiceRepoCard());
  wrap.appendChild(buildTrashCard());
  wrap.appendChild(buildDangerCard());
  return wrap;
}

function githubStatusBadge(g) {
  if (!g.owner || !g.repo || !g.token) {
    return el('span', { class: 'badge' }, 'Not configured');
  }
  if (g.lastSyncError && (g.lastSyncError.toLowerCase().includes('conflict'))) {
    return el('span', { class: 'badge danger' }, 'Conflict');
  }
  if (g.lastSyncError && !g.usingCache) {
    return el('span', { class: 'badge danger' }, 'Save failed');
  }
  if (g.usingCache) {
    return el('span', { class: 'badge warning' }, 'Using local cache');
  }
  if (state.dirty) {
    return el('span', { class: 'badge warning' }, 'Local changes pending');
  }
  if (g.lastPushOk) {
    return el('span', { class: 'badge success' }, 'Connected and synced');
  }
  if (g.lastPullOk) {
    return el('span', { class: 'badge success' }, 'Connected');
  }
  return el('span', { class: 'badge' }, 'Configured');
}

function buildGithubCard() {
  const card = el('div', { class: 'card mb-16' });
  const g = state.github;
  const isAdmin = state.session?.role === 'admin';

  card.appendChild(el('div', { class: 'card-header' },
    el('div', {},
      el('div', { class: 'card-title' }, 'GitHub Storage'),
      el('div', { class: 'card-subtitle' }, 'Sync data to a repo so it is accessible to everyone')
    ),
    githubStatusBadge(g)
  ));

  if (g.lastSyncError) {
    card.appendChild(el('div', {
      style: 'background:var(--danger-light,#fff0f0);border-left:3px solid var(--danger,#dc3545);padding:8px 12px;margin-bottom:12px;font-size:12px;color:var(--danger,#dc3545);border-radius:4px'
    }, `Last sync error: ${g.lastSyncError}`));
  }

  if (!isAdmin) {
    // Read-only view for non-admins
    const infoGrid = el('div', { style: 'display:grid;grid-template-columns:120px 1fr;gap:8px 16px;font-size:13px;margin-bottom:8px' });
    for (const [label, value] of [
      ['Owner',  g.owner  || '\u2014'],
      ['Repo',   g.repo   || '\u2014'],
      ['Branch', g.branch || 'main'],
      ['Path',   g.dbPath || 'data/db.json'],
      ['Token',  g.token  ? 'Configured' : 'Not configured'],
    ]) {
      infoGrid.appendChild(el('div', { style: 'color:var(--text-muted)' }, label));
      infoGrid.appendChild(el('div', {}, value));
    }
    card.appendChild(infoGrid);
    return card;
  }

  // Admin edit form
  const ownerI  = input({ value: g.owner,  placeholder: 'github-username' });
  const repoI   = input({ value: g.repo,   placeholder: 'business-tracking' });
  const branchI = input({ value: g.branch || 'main', placeholder: 'main' });
  const dbPathI = input({ value: g.dbPath || 'data/db.json', placeholder: 'data/db.json' });
  const tokenI  = input({ type: 'password', placeholder: g.token ? 'Leave blank to keep current token' : 'ghp_\u2026' });

  card.appendChild(el('div', { class: 'form-row horizontal' }, formRow('Owner', ownerI), formRow('Repo', repoI)));
  card.appendChild(el('div', { class: 'form-row horizontal' }, formRow('Branch', branchI), formRow('Path', dbPathI)));
  card.appendChild(formRow(
    g.token ? 'Token (configured)' : 'Token (PAT)',
    tokenI,
    'Stored in db.json and shared across all users/devices.'
  ));

  const saveBtn = button('Save & Pull', { variant: 'primary', onClick: async () => {
    const owner  = ownerI.value.trim();
    const repo   = repoI.value.trim();
    const branch = branchI.value.trim() || 'main';
    const dbPath = dbPathI.value.trim() || 'data/db.json';
    const token  = tokenI.value.trim() || g.token;

    if (!owner || !repo) { toast('Owner and repo are required', 'danger'); return; }

    saveConfig({ owner, repo, branch, dbPath, token });

    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving\u2026';
    try {
      const db = await fetchDb();
      // Preserve the config we just set in the fetched db before calling setDb
      if (!db.appConfig) db.appConfig = {};
      db.appConfig.github = { owner, repo, branch, path: dbPath, token };
      setDb(db);
      saveLocalCache(state.db);
      markDirty(); // push db.appConfig.github to GitHub
      toast('Connected! Data loaded from GitHub.', 'success');
      setTimeout(() => navigate('settings'), 250);
    } catch (e) {
      // Config saved locally; push will happen when connection is available
      if (!state.db.appConfig) state.db.appConfig = {};
      state.db.appConfig.github = { owner, repo, branch, path: dbPath, token };
      markDirty();
      toast('Config saved. Pull failed: ' + e.message, 'warning', 5000);
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save & Pull';
    }
  }});

  const btnRow = el('div', { class: 'flex gap-8', style: 'margin-top:8px' });
  btnRow.appendChild(saveBtn);

  if (g.token) {
    const pushBtn = button('Push Now', { onClick: async () => {
      if (!state.github.syncNow) { toast('Not ready \u2014 reload the page', 'warning'); return; }
      pushBtn.disabled = true;
      pushBtn.textContent = 'Pushing\u2026';
      try {
        await state.github.syncNow();
        toast('Pushed to GitHub', 'success');
      } catch (e) {
        toast('Push failed: ' + (state.github.lastSyncError || e.message), 'danger', 5000);
      } finally {
        pushBtn.disabled = false;
        pushBtn.textContent = 'Push Now';
      }
      setTimeout(() => navigate('settings'), 150);
    }});
    btnRow.appendChild(pushBtn);

    const disconnectBtn = button('Disconnect', { variant: 'danger', onClick: async () => {
      const ok = await confirmDialog('Disconnect from GitHub? Config will be cleared from db.json.', { danger: true, okLabel: 'Disconnect' });
      if (!ok) return;
      if (!state.db.appConfig) state.db.appConfig = {};
      state.db.appConfig.github = { owner: '', repo: '', branch: 'main', path: 'data/db.json', token: '' };
      clearConfig();
      markDirty();
      toast('Disconnected from GitHub', 'info');
      setTimeout(() => navigate('settings'), 200);
    }});
    btnRow.appendChild(disconnectBtn);
  }

  card.appendChild(btnRow);

  if (g.lastSyncError && !g.usingCache) {
    const retryBtn = button('Retry Sync Now', { variant: 'primary', onClick: async () => {
      if (!state.github.syncNow) { toast('Not ready \u2014 reload the page', 'warning'); return; }
      retryBtn.disabled = true;
      retryBtn.textContent = 'Retrying\u2026';
      try {
        await state.github.syncNow();
        toast('Sync successful', 'success');
      } catch (e) {
        toast('Sync failed: ' + (state.github.lastSyncError || e.message), 'danger', 5000);
      } finally {
        retryBtn.disabled = false;
        retryBtn.textContent = 'Retry Sync Now';
      }
      setTimeout(() => navigate('settings'), 150);
    }});
    const retryRow = el('div', { style: 'margin-top:8px' });
    retryRow.appendChild(retryBtn);
    card.appendChild(retryRow);
  }

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

function trashDisplayName(collection, item) {
  if (item.name) return item.name;
  if (item.number) return `#${item.number}`;
  if (item.description) return item.description;
  if (item.amount != null && item.date) return `${item.date} · ${item.amount}${item.currency ? ' ' + item.currency : ''}`;
  return item.id;
}

function capitalizeFirst(str) {
  return str ? str.charAt(0).toUpperCase() + str.slice(1) : str;
}

function buildTrashCard() {
  const card = el('div', { class: 'card mb-16' });

  const renderCard = (activeCol = 'all') => {
    card.innerHTML = '';

    const all = listDeletedRecords().sort((a, b) => (b.item.deletedAt || 0) - (a.item.deletedAt || 0));
    const colNames = [...new Set(all.map(r => r.collection))].sort();

    card.appendChild(el('div', { class: 'card-header' },
      el('div', {},
        el('div', { class: 'card-title' }, 'Trash'),
        el('div', { class: 'card-subtitle' }, `${all.length} soft-deleted record${all.length !== 1 ? 's' : ''}`)
      )
    ));

    if (all.length === 0) {
      card.appendChild(el('div', { class: 'empty' }, 'Trash is empty'));
      return;
    }

    // --- Selection state ---
    const selection = new Set();
    const rowCbs = new Map(); // key -> <input type=checkbox>

    // --- Bulk action controls ---
    const selCountEl  = el('span', { style: 'font-size:12px;color:var(--text-muted);align-self:center' }, '');
    const restoreSelBtn = button('Restore Selected', { variant: 'primary' });
    const deleteSelBtn  = button('Delete Selected',  { variant: 'danger' });
    const deleteAllBtn  = button('Delete All',       { variant: 'danger' });

    const updateBulkState = () => {
      const n = selection.size;
      selCountEl.textContent = n > 0 ? `${n} selected` : '';
      restoreSelBtn.disabled = n === 0;
      deleteSelBtn.disabled  = n === 0;
    };
    updateBulkState();

    // --- Collection filter ---
    const colOptions = [
      { value: 'all', label: 'All Collections' },
      ...colNames.map(c => ({ value: c, label: capitalizeFirst(c) }))
    ];
    const colSel = select(colOptions, activeCol);

    const getVisible = () => colSel.value === 'all' ? all : all.filter(r => r.collection === colSel.value);

    // --- Select All checkbox ---
    const selectAllCb = el('input', { type: 'checkbox', title: 'Select all visible' });

    const syncSelectAll = () => {
      const vis = getVisible();
      const n = vis.filter(r => selection.has(r.key)).length;
      selectAllCb.checked       = n > 0 && n === vis.length;
      selectAllCb.indeterminate = n > 0 && n < vis.length;
    };

    const toggleRow = (key, checked) => {
      if (checked) selection.add(key); else selection.delete(key);
      syncSelectAll();
      updateBulkState();
    };

    selectAllCb.onchange = () => {
      for (const { key } of getVisible()) {
        const cb = rowCbs.get(key);
        if (!cb) continue;
        cb.checked = selectAllCb.checked;
        if (selectAllCb.checked) selection.add(key); else selection.delete(key);
      }
      updateBulkState();
    };

    colSel.onchange = () => renderCard(colSel.value);

    // --- Bulk action handlers ---
    restoreSelBtn.onclick = () => {
      const targets = [...selection].map(key => {
        const i = key.indexOf(':');
        return { collection: key.slice(0, i), id: key.slice(i + 1) };
      });
      const count = restoreRecords(targets);
      if (count > 0) markDirty();
      toast(`Restored ${count} record${count !== 1 ? 's' : ''}`, 'success');
      renderCard(colSel.value);
    };

    deleteSelBtn.onclick = async () => {
      const n = selection.size;
      const ok = await confirmDialog(
        `This will permanently remove ${n} selected record${n !== 1 ? 's' : ''} from the database. This cannot be undone. Continue?`,
        { danger: true, okLabel: 'Delete Permanently' }
      );
      if (!ok) return;
      const targets = [...selection].map(key => {
        const i = key.indexOf(':');
        return { collection: key.slice(0, i), id: key.slice(i + 1) };
      });
      const count = permanentlyDeleteRecords(targets);
      toast(`Permanently deleted ${count} record${count !== 1 ? 's' : ''}`, 'success');
      renderCard(colSel.value);
    };

    deleteAllBtn.onclick = async () => {
      const ok = await confirmDialog(
        'This will permanently remove all deleted records from the database. This cannot be undone. Continue?',
        { danger: true, okLabel: 'Delete All Permanently' }
      );
      if (!ok) return;
      const count = purgeDeletedRecords();
      toast(`Permanently deleted ${count} record${count !== 1 ? 's' : ''}`, 'success');
      renderCard();
    };

    // --- Filter + bulk action bar ---
    card.appendChild(el('div', {
      class: 'flex gap-8 mb-16',
      style: 'align-items:center;flex-wrap:wrap;padding-top:12px'
    }, colSel, el('div', { class: 'flex-1' }), selCountEl, restoreSelBtn, deleteSelBtn, deleteAllBtn));

    // --- Table ---
    const vis = getVisible();
    if (vis.length === 0) {
      card.appendChild(el('div', { class: 'empty' }, 'No deleted records in this collection'));
      return;
    }

    const tw = el('div', { class: 'table-wrap' });
    const t  = el('table', { class: 'table' });

    const thCb = el('th', { style: 'width:36px;text-align:center' });
    thCb.appendChild(selectAllCb);
    const htr = el('tr');
    [thCb,
      el('th', {}, 'Collection'),
      el('th', {}, 'Record'),
      el('th', {}, 'Deleted At'),
      el('th', {}, 'Deleted By'),
      el('th', {})
    ].forEach(th => htr.appendChild(th));
    const thead = el('thead');
    thead.appendChild(htr);
    t.appendChild(thead);

    const tb = el('tbody');
    for (const { key, collection, item } of vis) {
      const cb = el('input', { type: 'checkbox' });
      cb.onchange = () => toggleRow(key, cb.checked);
      rowCbs.set(key, cb);

      const tdCb = el('td', { style: 'text-align:center' });
      tdCb.appendChild(cb);

      const tr = el('tr');
      tr.appendChild(tdCb);
      tr.appendChild(el('td', {}, el('span', { class: 'badge' }, capitalizeFirst(collection))));
      tr.appendChild(el('td', {}, trashDisplayName(collection, item)));
      tr.appendChild(el('td', { style: 'font-size:12px;white-space:nowrap' },
        item.deletedAt ? new Date(item.deletedAt).toLocaleString() : '—'
      ));
      tr.appendChild(el('td', { style: 'font-size:12px;color:var(--text-muted)' }, item.deletedBy || '—'));

      const actions = el('td', { class: 'right' });
      actions.appendChild(button('Restore', {
        variant: 'sm ghost',
        onClick: () => {
          restoreRecord(collection, item.id);
          markDirty();
          toast('Restored', 'success');
          renderCard(colSel.value);
        }
      }));
      actions.appendChild(button('Delete', {
        variant: 'sm ghost',
        onClick: async () => {
          const ok = await confirmDialog(
            'Permanently delete this record? This cannot be undone.',
            { danger: true, okLabel: 'Delete Permanently' }
          );
          if (!ok) return;
          permanentlyDeleteRecord(collection, item.id);
          toast('Permanently deleted', 'success');
          renderCard(colSel.value);
        }
      }));
      tr.appendChild(actions);
      tb.appendChild(tr);
    }
    t.appendChild(tb);
    tw.appendChild(t);
    card.appendChild(tw);
  };

  renderCard();
  return card;
}

function buildInvoiceRepoCard() {
  const card = el('div', { class: 'card mb-16' });
  card.appendChild(el('div', { class: 'card-header' },
    el('div', {},
      el('div', { class: 'card-title' }, 'Invoice Repository Maintenance'),
      el('div', { class: 'card-subtitle' }, 'Audit and back up PDF files stored in the invoice repository')
    )
  ));

  const resultEl       = el('div', { style: 'margin-top:12px' });
  const backupStatusEl = el('div', { style: 'font-size:12px;margin-top:8px' });

  const checkBtn  = button('Check Invoice Repository', { onClick: runCheck });
  const backupBtn = button('Backup Invoices', { onClick: runBackup });
  card.appendChild(el('div', { class: 'flex gap-8' }, checkBtn, backupBtn));
  card.appendChild(resultEl);
  card.appendChild(backupStatusEl);

  // Mirrors invoicePdfPath() in invoices.js — derive canonical repo path from invoice number
  function canonicalPath(inv) {
    const safe = (inv.number || inv.id).replace(/[/\\:*?"<>|]/g, '_').replace(/\s+/g, '_');
    return `invoices/${safe}.pdf`;
  }

  // ── Check ────────────────────────────────────────────────────────────────────

  async function runCheck() {
    const { owner, repo, token } = state.github;
    if (!owner || !repo || !token) {
      resultEl.innerHTML = '<div style="color:var(--danger,#dc3545)">GitHub not configured — add owner/repo/token above.</div>';
      return;
    }

    checkBtn.disabled = true;
    checkBtn.textContent = 'Checking…';
    resultEl.innerHTML = '<div style="color:var(--text-muted);font-size:13px">Fetching repository file list…</div>';

    let repoFiles;
    try {
      repoFiles = await listGithubFolder('invoices');
    } catch (err) {
      resultEl.innerHTML = `<div style="color:var(--danger,#dc3545)">Could not read repository: ${err.message}</div>`;
      checkBtn.disabled = false;
      checkBtn.textContent = 'Check Invoice Repository';
      return;
    }

    checkBtn.disabled = false;
    checkBtn.textContent = 'Check Invoice Repository';

    // Top-level PDFs only; backup/ subfolder is type:'dir' so filtered out by listGithubFolder
    const pdfFiles   = repoFiles.filter(f => f.name.toLowerCase().endsWith('.pdf'));
    const repoByName = new Map(pdfFiles.map(f => [f.name.toLowerCase(), f]));

    const invoices     = listActive('invoices');
    const discrepancies = [];
    const matchedNames  = new Set();

    // Detect two invoice records that would produce the same canonical filename
    const canonicalCount = new Map();
    for (const inv of invoices) {
      const cn = canonicalPath(inv).toLowerCase();
      if (!canonicalCount.has(cn)) canonicalCount.set(cn, []);
      canonicalCount.get(cn).push(inv);
    }
    for (const [, invs] of canonicalCount) {
      if (invs.length > 1) {
        discrepancies.push({
          type: 'duplicate',
          detail: `Invoice numbers ${invs.map(i => `"${i.number || i.id}"`).join(' and ')} resolve to the same filename — rename one invoice to fix`,
          invs
        });
      }
    }

    // Match each invoice to a repo file
    for (const inv of invoices) {
      const expPath  = canonicalPath(inv);
      const expName  = expPath.split('/').pop();
      const expLow   = expName.toLowerCase();

      if (repoByName.has(expLow)) {
        // File exists at the canonical name
        matchedNames.add(expLow);
        if (inv.pdfPath !== expPath) {
          // pdfPath is wrong or missing, but the file itself is already correct
          discrepancies.push({
            type: 'filename_mismatch',
            subtype: 'pdfpath_only',
            detail: `Invoice "${inv.number || inv.id}": pdfPath "${inv.pdfPath || '(none)'}" should point to "${expPath}" (file already correctly named)`,
            inv,
            expPath
          });
        }
      } else {
        const storedName = (inv.pdfPath || '').split('/').pop();
        const storedLow  = storedName.toLowerCase();
        if (storedLow && repoByName.has(storedLow)) {
          // File exists but under the wrong name
          matchedNames.add(storedLow);
          discrepancies.push({
            type: 'filename_mismatch',
            subtype: 'wrong_name',
            detail: `Invoice "${inv.number || inv.id}": file found as "${storedName}" but should be "${expName}"`,
            inv,
            expPath,
            wrongPath: inv.pdfPath
          });
        } else {
          // No file found anywhere for this invoice
          const canRegen = inv.source !== 'pdf_import';
          discrepancies.push({
            type: 'missing_file',
            detail: canRegen
              ? `Invoice "${inv.number || inv.id}": PDF missing — can be regenerated`
              : `Invoice "${inv.number || inv.id}": original PDF missing — re-import manually to re-attach${inv.pdfPath ? ` (stale link "${inv.pdfPath}" will be cleared)` : ''}`,
            inv,
            expPath,
            canRegen
          });
        }
      }
    }

    // Files in the repo with no matching invoice record
    for (const [nameLow, file] of repoByName) {
      if (!matchedNames.has(nameLow)) {
        discrepancies.push({
          type: 'orphan_file',
          detail: `"${file.name}" has no matching invoice record`,
          file
        });
      }
    }

    renderCheckResults(invoices.length, pdfFiles.length, discrepancies);
  }

  // ── Render results with per-row Resolve buttons ───────────────────────────────

  function renderCheckResults(totalInvoices, totalPdfs, discrepancies) {
    resultEl.innerHTML = '';

    // Refresh button — always visible once results are shown
    const refreshRow = el('div', { style: 'display:flex;justify-content:flex-end;align-items:center;gap:8px;margin-bottom:8px' });
    const tsEl = el('span', { style: 'font-size:11px;color:var(--text-muted)' }, `Checked at ${new Date().toLocaleTimeString()}`);
    const refreshBtn = button('Refresh', { variant: 'sm ghost', onClick: runCheck });
    refreshRow.appendChild(tsEl);
    refreshRow.appendChild(refreshBtn);
    resultEl.appendChild(refreshRow);

    const missing = discrepancies.filter(d => d.type === 'missing_file').length;
    const matched = totalInvoices - missing;

    const summaryGrid = el('div', { style: 'display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:12px' });
    for (const [label, val, good] of [
      ['Invoice records', totalInvoices, true],
      ['Repository PDFs', totalPdfs,     true],
      ['Matched',         matched,        matched === totalInvoices],
      ['Discrepancies',   discrepancies.length, discrepancies.length === 0]
    ]) {
      summaryGrid.appendChild(el('div', {
        style: `background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:10px;text-align:center;border-top:3px solid ${good ? 'var(--success,#198754)' : 'var(--danger,#dc3545)'}`
      },
        el('div', { style: 'font-size:1.4rem;font-weight:700' }, String(val)),
        el('div', { style: 'font-size:11px;color:var(--text-muted)' }, label)
      ));
    }
    resultEl.appendChild(summaryGrid);

    if (discrepancies.length === 0) {
      resultEl.appendChild(el('div', { style: 'color:var(--success,#198754);font-size:13px' },
        'All invoice records match repository files.'));
      return;
    }

    const TYPE_LABEL = { missing_file: 'Missing file', orphan_file: 'Orphan file', filename_mismatch: 'Name mismatch', duplicate: 'Duplicate' };
    const TYPE_CSS   = { orphan_file: 'warning', duplicate: 'warning' };

    const list = el('div', { style: 'display:flex;flex-direction:column;gap:2px' });
    for (const d of discrepancies) {
      const badgeCss = TYPE_CSS[d.type] || 'danger';
      const row = el('div', {
        style: 'display:flex;align-items:flex-start;gap:6px;font-size:12px;padding:6px 0;border-bottom:1px solid var(--border)'
      });
      row.appendChild(el('span', { class: `badge ${badgeCss}`, style: 'flex-shrink:0;margin-top:1px' }, TYPE_LABEL[d.type] || d.type));
      row.appendChild(el('span', { style: 'flex:1' }, d.detail));

      const statusEl = el('span', { style: 'font-size:11px;white-space:nowrap;flex-shrink:0' });
      const action   = resolveAction(d);

      if (action) {
        const btn = button('Resolve', { variant: 'sm primary' });
        btn.onclick = async () => {
          btn.disabled    = true;
          btn.textContent = 'Resolving…';
          statusEl.textContent = '';
          statusEl.style.color = '';
          try {
            await action();
            btn.textContent      = '✓ Done';
            statusEl.textContent = 'Refreshing…';
            statusEl.style.color = 'var(--success,#198754)';
            await new Promise(r => setTimeout(r, 600));
            await runCheck();
          } catch (err) {
            btn.disabled    = false;
            btn.textContent = 'Resolve';
            if (err.message !== 'cancelled') {
              statusEl.textContent = err.message;
              statusEl.style.color = 'var(--danger,#dc3545)';
            }
          }
        };
        row.appendChild(statusEl);
        row.appendChild(btn);
      }

      list.appendChild(row);
    }
    resultEl.appendChild(list);
  }

  // ── Resolve actions ───────────────────────────────────────────────────────────
  // Returns an async thunk for auto-resolvable discrepancies, or null if not safe.

  function resolveAction(d) {
    if (d.type === 'filename_mismatch' && d.subtype === 'pdfpath_only') {
      // File is already correctly named — just update the DB record's pdfPath
      return async () => {
        upsert('invoices', { ...d.inv, pdfPath: d.expPath });
        markDirty();
      };
    }

    if (d.type === 'filename_mismatch' && d.subtype === 'wrong_name') {
      // File exists under the old/wrong name — rename it in GitHub and fix pdfPath
      return async () => {
        const fileData = await fetchGithubFile(d.wrongPath);
        const b64      = fileData.content.replace(/\s/g, '');
        await uploadGithubFile(d.expPath, b64, `Rename PDF: ${d.inv.number || d.inv.id}`);
        await deleteGithubFile(d.wrongPath, fileData.sha, `Remove old path for invoice ${d.inv.number || d.inv.id}`);
        upsert('invoices', { ...d.inv, pdfPath: d.expPath });
        markDirty();
      };
    }

    if (d.type === 'missing_file' && d.canRegen) {
      // Builder invoice — regenerate the PDF and upload it
      return async () => {
        const b64 = generateInvoicePDF(d.inv).output('datauristring').split(',')[1];
        if (!b64) throw new Error('PDF generation produced empty content');
        await uploadGithubFile(d.expPath, b64, `Regenerate PDF for invoice ${d.inv.number || d.inv.id}`);
        upsert('invoices', { ...d.inv, pdfPath: d.expPath });
        markDirty();
      };
    }

    if (d.type === 'missing_file' && !d.canRegen && d.inv.pdfPath) {
      // Imported invoice with a stale pdfPath pointing to a file that no longer exists — clear the link
      return async () => {
        const updated = { ...d.inv };
        delete updated.pdfPath;
        upsert('invoices', updated);
        markDirty();
      };
    }

    if (d.type === 'orphan_file') {
      // Repo file with no matching invoice — ask before deleting
      return async () => {
        const ok = await confirmDialog(
          `Delete orphaned file "${d.file.name}" from the repository? This cannot be undone.`,
          { danger: true, okLabel: 'Delete File' }
        );
        if (!ok) throw new Error('cancelled');
        await deleteGithubFile(d.file.path, d.file.sha, `Delete orphan: ${d.file.name}`);
      };
    }

    // duplicate: requires changing invoice numbers — no safe auto-resolve
    return null;
  }

  // ── Backup ───────────────────────────────────────────────────────────────────

  async function runBackup() {
    const { owner, repo, token } = state.github;
    if (!owner || !repo || !token) {
      backupStatusEl.textContent = 'GitHub not configured.';
      backupStatusEl.style.color = 'var(--danger,#dc3545)';
      return;
    }

    backupBtn.disabled = true;
    backupBtn.textContent = 'Backing up…';
    backupStatusEl.style.color = 'var(--text-muted)';
    backupStatusEl.textContent = 'Listing invoice files…';

    let files;
    try {
      const all = await listGithubFolder('invoices');
      files = all.filter(f => f.name.toLowerCase().endsWith('.pdf'));
    } catch (err) {
      backupStatusEl.textContent = `Failed to list files: ${err.message}`;
      backupStatusEl.style.color = 'var(--danger,#dc3545)';
      backupBtn.disabled = false;
      backupBtn.textContent = 'Backup Invoices';
      return;
    }

    if (files.length === 0) {
      backupStatusEl.textContent = 'No PDF files found in invoice repository.';
      backupStatusEl.style.color = 'var(--text-muted)';
      backupBtn.disabled = false;
      backupBtn.textContent = 'Backup Invoices';
      return;
    }

    let done = 0, failed = 0;
    for (const file of files) {
      backupStatusEl.textContent = `Copying ${done + failed + 1} / ${files.length}: ${file.name}…`;
      try {
        const fileData = await fetchGithubFile(file.path);
        const b64 = fileData.content.replace(/\s/g, '');
        await uploadGithubFile(`invoices/backup/${file.name}`, b64, `Backup: ${file.name}`);
        done++;
      } catch (err) {
        console.warn(`[backup] Failed for ${file.name}:`, err.message);
        failed++;
      }
    }

    backupBtn.disabled = false;
    backupBtn.textContent = 'Backup Invoices';
    if (failed > 0) {
      backupStatusEl.textContent = `Backup done: ${done} copied, ${failed} failed. Check browser console for details.`;
      backupStatusEl.style.color = 'var(--danger,#dc3545)';
    } else {
      backupStatusEl.textContent = `Backup complete: ${done} file${done !== 1 ? 's' : ''} copied to invoices/backup/.`;
      backupStatusEl.style.color = 'var(--success,#198754)';
    }
  }

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
        setTimeout(() => location.hash = 'analytics', 200);
      }
    } catch (e) {
      toast('Invalid JSON', 'danger');
    }
  };
  const importBtn = button('Import JSON', { onClick: () => importInput.click() });
  card.appendChild(el('div', { class: 'flex gap-8' }, exportBtn, importBtn, importInput));
  return card;
}
