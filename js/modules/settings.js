// Settings module: GitHub config, FX rates, services catalog, business info, team
import { state, markDirty } from '../core/state.js';
import { el, openModal, closeModal, confirmDialog, toast, select, input, formRow, textarea, button } from '../core/ui.js';
import { saveConfig, clearConfig, fetchDb, saveLocalCache, listGithubFolder, fetchGithubFile, uploadGithubFile, deleteGithubFile } from '../core/github.js';
import { navigate } from '../core/router.js';
import { upsert, softDelete, listActive, byId, newId, formatMoney, listDeletedRecords, restoreRecord, permanentlyDeleteRecord, restoreRecords, permanentlyDeleteRecords, purgeDeletedRecords, reapplyRuleToAllPayments } from '../core/data.js';
import { setDb } from '../core/state.js';
import { CURRENCIES, SERVICE_UNITS, STREAMS, SERVICE_STREAMS, EXPENSE_CATEGORIES } from '../core/config.js';
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
  wrap.appendChild(buildReservationExpenseRulesCard());
  wrap.appendChild(buildTeamCard());
  wrap.appendChild(buildInvoiceRepoCard());
  wrap.appendChild(buildPropertiesRepoCard());
  wrap.appendChild(buildClientsRepoCard());
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

async function pushBootstrapConfig({ owner, repo, branch, path }) {
  const content = JSON.stringify({ owner, repo, branch, path }, null, 2);
  const b64 = btoa(unescape(encodeURIComponent(content)));
  await uploadGithubFile('data/github-config.json', b64, 'Update GitHub bootstrap config');
}

function buildGithubCard() {
  const card = el('div', { class: 'card mb-16' });
  const g = state.github;
  // Merge runtime state with db config so new devices (no localStorage) still see values
  const dbCfg    = state.db.appConfig?.github || {};
  const effOwner  = g.owner  || dbCfg.owner  || '';
  const effRepo   = g.repo   || dbCfg.repo   || '';
  const effBranch = g.branch || dbCfg.branch || 'main';
  const effPath   = g.dbPath || dbCfg.path   || 'data/db.json';
  const effToken  = g.token  || dbCfg.token  || '';
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
      ['Owner',  effOwner  || '\u2014'],
      ['Repo',   effRepo   || '\u2014'],
      ['Branch', effBranch || 'main'],
      ['Path',   effPath   || 'data/db.json'],
      ['Token',  effToken  ? 'Configured' : 'Not configured'],
    ]) {
      infoGrid.appendChild(el('div', { style: 'color:var(--text-muted)' }, label));
      infoGrid.appendChild(el('div', {}, value));
    }
    card.appendChild(infoGrid);
    return card;
  }

  // Admin edit form
  const ownerI  = input({ value: effOwner,  placeholder: 'github-username' });
  const repoI   = input({ value: effRepo,   placeholder: 'business-tracking' });
  const branchI = input({ value: effBranch, placeholder: 'main' });
  const dbPathI = input({ value: effPath,   placeholder: 'data/db.json' });
  const tokenI  = input({ type: 'password', placeholder: effToken ? 'Leave blank to keep current token' : 'ghp_\u2026' });

  card.appendChild(el('div', { class: 'form-row horizontal' }, formRow('Owner', ownerI), formRow('Repo', repoI)));
  card.appendChild(el('div', { class: 'form-row horizontal' }, formRow('Branch', branchI), formRow('Path', dbPathI)));
  card.appendChild(formRow(
    effToken ? 'Token (configured)' : 'Token (PAT)',
    tokenI,
    'Stored in db.json and shared across all users/devices.'
  ));

  const saveBtn = button('Save & Pull', { variant: 'primary', onClick: async () => {
    const owner  = ownerI.value.trim();
    const repo   = repoI.value.trim();
    const branch = branchI.value.trim() || 'main';
    const dbPath = dbPathI.value.trim() || 'data/db.json';
    const token  = tokenI.value.trim() || effToken;

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
      // Push bootstrap config (no token) so new devices can auto-configure
      pushBootstrapConfig({ owner, repo, branch, path: dbPath }).catch(() => {});
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

  if (effToken) {
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

  // Setup Link section — prominent, separate from action buttons
  if (effOwner && effRepo) {
    const setupSection = el('div', {
      style: 'margin-top:16px;padding:12px 14px;background:var(--info-soft);border:1px solid var(--info);border-radius:var(--radius-sm)'
    });
    setupSection.appendChild(el('div', {
      style: 'font-size:12px;font-weight:600;color:var(--info);margin-bottom:6px'
    }, '🔗 Share Access with New Users'));
    setupSection.appendChild(el('div', {
      style: 'font-size:12px;color:var(--text-muted);margin-bottom:10px'
    }, 'New browsers/devices see empty settings because the config lives in your localStorage. Generate a one-click setup link and share it — anyone who opens it gets auto-configured instantly.'));

    const setupLinkInput = el('input', {
      type: 'text',
      readonly: true,
      style: 'width:100%;font-size:11px;margin-bottom:8px',
      value: ''
    });

    const params = new URLSearchParams({ owner: effOwner, repo: effRepo, branch: effBranch, path: effPath });
    const setupUrl = `${window.location.origin}${window.location.pathname}#/setup?${params}`;
    setupLinkInput.value = setupUrl;

    const copyBtn = button('Copy Link', { variant: 'primary', onClick: () => {
      setupLinkInput.select();
      if (navigator.clipboard) {
        navigator.clipboard.writeText(setupUrl)
          .then(() => toast('Setup link copied — share it with any new user', 'success', 5000))
          .catch(() => { document.execCommand('copy'); toast('Setup link copied', 'success', 5000); });
      } else {
        document.execCommand('copy');
        toast('Setup link copied', 'success', 5000);
      }
    }});

    const linkRow = el('div', { class: 'flex gap-8', style: 'align-items:center' });
    linkRow.appendChild(setupLinkInput);
    linkRow.appendChild(copyBtn);
    setupSection.appendChild(linkRow);
    card.appendChild(setupSection);
  }


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

  const renderCard = () => {
    card.innerHTML = '';
    card.appendChild(el('div', { class: 'card-header' },
      el('div', {},
        el('div', { class: 'card-title' }, 'Service Catalog'),
        el('div', { class: 'card-subtitle' }, 'Premade services used when building invoices')
      ),
      button('+ Add Service', { variant: 'primary', onClick: () => openServiceForm(null, renderCard) })
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
        actions.appendChild(button('Edit', { variant: 'sm ghost', onClick: () => openServiceForm(s, renderCard) }));
        actions.appendChild(button('Del', { variant: 'sm ghost', onClick: async () => {
          const ok = await confirmDialog(`Delete service ${s.name}?`, { danger: true, okLabel: 'Delete' });
          if (ok) { softDelete('services', s.id); toast('Deleted', 'success'); renderCard(); }
        }}));
        tr.appendChild(actions);
        tb.appendChild(tr);
      }
      t.appendChild(tb);
      const tw = el('div', { class: 'table-wrap' }); tw.appendChild(t);
      card.appendChild(tw);
    }
  };

  renderCard();
  return card;
}

function openServiceForm(existing, onSave) {
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
    onSave?.();
  }});
  openModal({ title: existing ? 'Edit Service' : 'New Service', body, footer: [button('Cancel', { onClick: closeModal }), save] });
}

function buildReservationExpenseRulesCard() {
  const card = el('div', { class: 'card mb-16' });

  const renderCard = () => {
    card.innerHTML = '';
    card.appendChild(el('div', { class: 'card-header' },
      el('div', {},
        el('div', { class: 'card-title' }, 'Reservation Expense Rules'),
        el('div', { class: 'card-subtitle' }, 'Auto-generate expenses for each reservation (historical & future, imported & manual)')
      ),
      button('+ Add Rule', { variant: 'primary', onClick: () => openReservationExpenseRuleForm(null, renderCard) })
    ));
    const rules = listActive('reservationExpenseRules');
    if (rules.length === 0) {
      card.appendChild(el('div', { class: 'empty' }, 'No rules configured'));
    } else {
      const t = el('table', { class: 'table' });
      t.innerHTML = `<thead><tr><th>Name</th><th>Property</th><th>Category</th><th>Amount Source</th><th>Enabled</th><th></th></tr></thead>`;
      const tb = el('tbody');
      for (const rule of rules) {
        const prop = rule.propertyId ? byId('properties', rule.propertyId) : null;
        const catLabel = EXPENSE_CATEGORIES[rule.category]?.label || rule.category;
        const srcLabel = rule.amountSource === 'airbnb_cleaning_fee' ? 'Airbnb cleaning fee'
          : rule.amountSource === 'inventory' ? 'Inventory (FIFO)'
          : rule.amountSource === 'vendor_rate' ? 'Vendor rate by period'
          : `Fixed ${rule.fixedAmount} ${rule.fixedCurrency || 'EUR'}`;
        const tr = el('tr');
        tr.appendChild(el('td', {}, rule.name));
        tr.appendChild(el('td', {}, prop?.name || 'All properties'));
        tr.appendChild(el('td', {}, catLabel));
        tr.appendChild(el('td', {}, srcLabel));
        tr.appendChild(el('td', {}, el('span', { class: `badge ${rule.enabled ? 'success' : ''}` }, rule.enabled ? 'On' : 'Off')));
        const acts = el('td', { class: 'right' });
        acts.appendChild(button('Edit', { variant: 'sm ghost', onClick: () => openReservationExpenseRuleForm(rule, renderCard) }));
        acts.appendChild(button('Del', { variant: 'sm ghost', onClick: async () => {
          const ok = await confirmDialog(`Delete rule "${rule.name}"?`, { danger: true, okLabel: 'Delete' });
          if (!ok) return;
          softDelete('reservationExpenseRules', rule.id);
          toast('Rule deleted', 'success');
          renderCard();
        }}));
        tr.appendChild(acts);
        tb.appendChild(tr);
      }
      t.appendChild(tb);
      const tw = el('div', { class: 'table-wrap' }); tw.appendChild(t);
      card.appendChild(tw);
    }
  };

  renderCard();
  return card;
}

function openReservationExpenseRuleForm(existing, onSave) {
  const rule = existing ? { ...existing } : {
    id: newId('rer'),
    name: '',
    propertyId: '',
    category: 'cleaning',
    vendorId: '',
    amountSource: 'airbnb_cleaning_fee',
    fixedAmount: 0,
    fixedCurrency: 'EUR',
    inventoryItemId: '',
    inventoryQty: 1,
    description: '',
    enabled: true
  };

  const body = el('div', {});
  const stProps = listActive('properties').filter(p => p.type === 'short_term');
  const vendors = listActive('vendors');
  const invItems = listActive('inventory');

  const nameI      = input({ value: rule.name, placeholder: 'e.g. Cleaning Fee' });
  const propS      = select(
    [{ value: '', label: 'All short-term properties' }, ...stProps.map(p => ({ value: p.id, label: p.name }))],
    rule.propertyId || ''
  );
  const catS       = select(
    Object.entries(EXPENSE_CATEGORIES).map(([v, m]) => ({ value: v, label: m.label })),
    rule.category || 'cleaning'
  );
  const vendorS    = select(
    [{ value: '', label: 'None' }, ...vendors.map(v => ({ value: v.id, label: v.name }))],
    rule.vendorId || ''
  );
  const srcS       = select([
    { value: 'airbnb_cleaning_fee', label: 'Airbnb cleaning fee (from import data)' },
    { value: 'fixed',               label: 'Fixed amount' },
    { value: 'inventory',           label: 'Inventory item (FIFO deduction)' },
    { value: 'vendor_rate',         label: 'Vendor rate by property & period' }
  ], rule.amountSource || 'airbnb_cleaning_fee');
  const fixedAmtI  = input({ type: 'number', value: rule.fixedAmount || 0, min: 0, step: 0.01 });
  const fixedCurrS = select(CURRENCIES, rule.fixedCurrency || 'EUR');
  const invItemS   = select(
    [{ value: '', label: 'Select item…' }, ...invItems.map(i => ({ value: i.id, label: i.name }))],
    rule.inventoryItemId || ''
  );
  const invQtyI    = input({ type: 'number', value: rule.inventoryQty || 1, min: 1 });
  const descI      = input({ value: rule.description || '', placeholder: 'Optional — prefills expense description' });
  const enabledChk = el('input', { type: 'checkbox' });
  enabledChk.checked = rule.enabled !== false;

  const fixedRow = el('div', { class: 'form-row horizontal' }, formRow('Amount', fixedAmtI), formRow('Currency', fixedCurrS));
  const invRow   = el('div', { class: 'form-row horizontal' }, formRow('Inventory Item', invItemS), formRow('Qty / Reservation', invQtyI));

  const updateVis = () => {
    fixedRow.style.display = srcS.value === 'fixed'     ? '' : 'none';
    invRow.style.display   = srcS.value === 'inventory' ? '' : 'none';
  };
  srcS.onchange = updateVis;
  updateVis();

  body.appendChild(formRow('Rule Name', nameI));
  body.appendChild(el('div', { class: 'form-row horizontal' }, formRow('Property', propS), formRow('Expense Category', catS)));
  body.appendChild(el('div', { class: 'form-row horizontal' }, formRow('Vendor', vendorS), formRow('Amount Source', srcS)));
  body.appendChild(fixedRow);
  body.appendChild(invRow);
  body.appendChild(formRow('Description', descI));
  body.appendChild(formRow('Enabled', el('label', { style: 'display:flex;align-items:center;gap:8px;cursor:pointer' }, enabledChk, el('span', {}, 'Active'))));

  const saveBtn = button('Save', { variant: 'primary', onClick: () => {
    if (!nameI.value.trim()) { toast('Rule name is required', 'danger'); return; }
    if (srcS.value === 'inventory' && !invItemS.value) { toast('Select an inventory item', 'danger'); return; }
    Object.assign(rule, {
      name:            nameI.value.trim(),
      propertyId:      propS.value,
      category:        catS.value,
      vendorId:        vendorS.value,
      amountSource:    srcS.value,
      fixedAmount:     Number(fixedAmtI.value) || 0,
      fixedCurrency:   fixedCurrS.value,
      inventoryItemId: invItemS.value,
      inventoryQty:    Number(invQtyI.value) || 1,
      description:     descI.value.trim(),
      enabled:         enabledChk.checked
    });
    upsert('reservationExpenseRules', rule);
    toast('Rule saved', 'success');
    closeModal();
    // Retroactively apply to existing payments (non-inventory sources only)
    reapplyRuleToAllPayments(rule);
    onSave?.();
  }});

  openModal({
    title: existing ? 'Edit Reservation Expense Rule' : 'New Reservation Expense Rule',
    body,
    footer: [button('Cancel', { onClick: closeModal }), saveBtn]
  });
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
      let pdfErrors = 0;
      for (const { collection, id } of targets) {
        if (collection === 'invoices') {
          const inv = all.find(r => r.collection === 'invoices' && r.item.id === id)?.item;
          if (!inv?.pdfPath) continue;
          try { await deleteGithubFile(inv.pdfPath, null, `Delete PDF for invoice ${inv.number || inv.id}`); }
          catch { pdfErrors++; }
        } else if (collection === 'properties') {
          const prop = all.find(r => r.collection === 'properties' && r.item.id === id)?.item;
          for (const doc of (prop?.documents || [])) {
            if (!doc.path) continue;
            try { await deleteGithubFile(doc.path, null, `Delete document: ${doc.name}`); }
            catch { pdfErrors++; }
          }
        } else if (collection === 'clients') {
          const cli = all.find(r => r.collection === 'clients' && r.item.id === id)?.item;
          for (const doc of (cli?.documents || [])) {
            if (!doc.path) continue;
            try { await deleteGithubFile(doc.path, null, `Delete document: ${doc.name}`); }
            catch { pdfErrors++; }
          }
        }
      }
      const count = permanentlyDeleteRecords(targets);
      if (pdfErrors > 0)
        toast(`Permanently deleted ${count} record(s) — ${pdfErrors} file(s) could not be cleaned up`, 'warning', 6000);
      else
        toast(`Permanently deleted ${count} record${count !== 1 ? 's' : ''}`, 'success');
      renderCard(colSel.value);
    };

    deleteAllBtn.onclick = async () => {
      const ok = await confirmDialog(
        'This will permanently remove all deleted records from the database. This cannot be undone. Continue?',
        { danger: true, okLabel: 'Delete All Permanently' }
      );
      if (!ok) return;
      let pdfErrors = 0;
      for (const { collection, item } of all) {
        if (collection === 'invoices' && item.pdfPath) {
          try { await deleteGithubFile(item.pdfPath, null, `Delete PDF for invoice ${item.number || item.id}`); }
          catch { pdfErrors++; }
        } else if (collection === 'properties' || collection === 'clients') {
          for (const doc of (item.documents || [])) {
            if (!doc.path) continue;
            try { await deleteGithubFile(doc.path, null, `Delete document: ${doc.name}`); }
            catch { pdfErrors++; }
          }
        }
      }
      const count = purgeDeletedRecords();
      if (pdfErrors > 0)
        toast(`Permanently deleted ${count} record(s) — ${pdfErrors} file(s) could not be cleaned up`, 'warning', 6000);
      else
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
          if (collection === 'invoices' && item.pdfPath) {
            try {
              await deleteGithubFile(item.pdfPath, null, `Delete PDF for invoice ${item.number || item.id}`);
            } catch (e) {
              const proceed = await confirmDialog(
                `PDF cleanup failed: ${e.message}\nDelete invoice record anyway?`,
                { okLabel: 'Delete Record Only' }
              );
              if (!proceed) return;
              toast('Invoice deleted — PDF cleanup failed', 'warning', 5000);
              permanentlyDeleteRecord(collection, item.id);
              renderCard(colSel.value);
              return;
            }
          } else if (collection === 'properties') {
            for (const doc of (item.documents || [])) {
              if (!doc.path) continue;
              try { await deleteGithubFile(doc.path, null, `Delete document: ${doc.name}`); }
              catch { /* best-effort */ }
            }
          } else if (collection === 'clients') {
            for (const doc of (item.documents || [])) {
              if (!doc.path) continue;
              try { await deleteGithubFile(doc.path, null, `Delete document: ${doc.name}`); }
              catch { /* best-effort */ }
            }
          }
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

  const resultEl        = el('div', { style: 'margin-top:12px' });
  const backupStatusEl  = el('div', { style: 'font-size:12px;margin-top:8px' });
  const deleteStatusEl  = el('div', { style: 'font-size:12px;margin-top:8px' });

  const checkBtn        = button('Check Invoice Repository', { onClick: runCheck });
  const backupBtn       = button('Backup Invoices', { onClick: runBackup });
  const deleteBackupBtn = button('Delete Invoice Backups', { variant: 'danger', onClick: runDeleteBackups });
  card.appendChild(el('div', { class: 'flex gap-8' }, checkBtn, backupBtn, deleteBackupBtn));
  card.appendChild(resultEl);
  card.appendChild(backupStatusEl);
  card.appendChild(deleteStatusEl);

  // Mirrors invoicePdfPath() in invoices.js — derive canonical repo path from invoice number
  function canonicalPath(inv) {
    const safe = (inv.number || inv.id).replace(/[/\\:*?"<>|#&%]/g, '_').replace(/\s+/g, '_');
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
          const repoFile = repoByName.get(storedLow);
          matchedNames.add(storedLow);
          discrepancies.push({
            type: 'filename_mismatch',
            subtype: 'wrong_name',
            detail: `Invoice "${inv.number || inv.id}": file found as "${storedName}" but should be "${expName}"`,
            inv,
            expPath,
            wrongPath: repoFile.path,
            wrongSha:  repoFile.sha
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
        await deleteGithubFile(d.wrongPath, d.wrongSha || fileData.sha, `Remove old path for invoice ${d.inv.number || d.inv.id}`);
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

  // ── Delete Backups ────────────────────────────────────────────────────────────

  async function runDeleteBackups() {
    const { owner, repo, token } = state.github;
    if (!owner || !repo || !token) {
      deleteStatusEl.textContent = 'GitHub not configured.';
      deleteStatusEl.style.color = 'var(--danger,#dc3545)';
      return;
    }

    deleteBackupBtn.disabled = true;
    deleteBackupBtn.textContent = 'Listing…';
    deleteStatusEl.style.color = 'var(--text-muted)';
    deleteStatusEl.textContent = 'Listing backup files…';

    let files;
    try {
      files = await listBackupFiles('invoices/backup');
    } catch (err) {
      deleteStatusEl.textContent = `Failed to list backup files: ${err.message}`;
      deleteStatusEl.style.color = 'var(--danger,#dc3545)';
      deleteBackupBtn.disabled = false;
      deleteBackupBtn.textContent = 'Delete Invoice Backups';
      return;
    }

    deleteBackupBtn.disabled = false;
    deleteBackupBtn.textContent = 'Delete Invoice Backups';

    if (files.length === 0) {
      deleteStatusEl.textContent = 'Backup folder is empty or does not exist — nothing to delete.';
      deleteStatusEl.style.color = 'var(--text-muted)';
      return;
    }

    const ok = await confirmDialog(
      `Delete all ${files.length} file${files.length !== 1 ? 's' : ''} in invoices/backup/? This cannot be undone.`,
      { danger: true, okLabel: 'Delete Backups' }
    );
    if (!ok) { deleteStatusEl.textContent = ''; return; }

    deleteBackupBtn.disabled = true;
    deleteBackupBtn.textContent = 'Deleting…';
    let done = 0, failed = 0;
    for (const file of files) {
      deleteStatusEl.textContent = `Deleting ${done + failed + 1} / ${files.length}: ${file.name}…`;
      try {
        await deleteGithubFile(file.path, file.sha, `Delete invoice backup: ${file.name}`);
        done++;
      } catch (err) {
        console.warn(`[delete-invoice-backup] Failed for ${file.name}:`, err.message);
        failed++;
      }
    }

    deleteBackupBtn.disabled = false;
    deleteBackupBtn.textContent = 'Delete Invoice Backups';
    if (failed > 0) {
      deleteStatusEl.textContent = `Deleted ${done}, failed ${failed}. Check console for details.`;
      deleteStatusEl.style.color = 'var(--danger,#dc3545)';
    } else {
      deleteStatusEl.textContent = `Deleted ${done} backup file${done !== 1 ? 's' : ''} from invoices/backup/.`;
      deleteStatusEl.style.color = 'var(--success,#198754)';
    }
    if (resultEl.innerHTML) await runCheck();
  }

  return card;
}

// ── Shared helpers for document repo maintenance cards ────────────────────────

// List all files inside a backup folder, recursing one level into sub-folders.
async function listBackupFiles(backupPath) {
  const { owner, repo, branch, token } = state.github;
  if (!owner || !repo) return [];
  const headers = { 'Accept': 'application/vnd.github+json' };
  if (token) headers['Authorization'] = `token ${token}`;
  const cleanPath = backupPath.replace(/^\/+|\/+$/g, '');
  const encodedPath = cleanPath.split('/').map(encodeURIComponent).join('/');
  let topItems;
  try {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(branch || 'main')}`,
      { headers, cache: 'no-store' }
    );
    if (res.status === 404) return [];
    if (!res.ok) throw new Error(`Backup folder listing failed (${res.status})`);
    const data = await res.json();
    topItems = Array.isArray(data) ? data : [];
  } catch (err) {
    if (err.message && err.message.includes('404')) return [];
    throw err;
  }
  const files = [];
  for (const item of topItems) {
    if (item.type === 'file') {
      files.push(item);
    } else if (item.type === 'dir') {
      try {
        const subFiles = await listGithubFolder(item.path);
        files.push(...subFiles);
      } catch { /* skip unreadable subfolder */ }
    }
  }
  return files;
}

async function listDocRepoFiles(rootFolder) {
  // List root folder, then recurse one level into sub-folders (skip 'backup')
  let topItems;
  try {
    topItems = await listGithubFolder(rootFolder);
  } catch (err) {
    if (err.message && (err.message.includes('404') || err.message.includes('Not Found'))) return [];
    throw err;
  }
  const files = [];
  for (const item of topItems) {
    if (item.type === 'file') {
      files.push(item);
    } else if (item.type === 'dir' && item.name.toLowerCase() !== 'backup') {
      try {
        const subItems = await listGithubFolder(item.path);
        for (const sub of subItems) { if (sub.type === 'file') files.push(sub); }
      } catch { /* skip unreadable sub-folder */ }
    }
  }
  return files;
}

function buildDocRepoCard({ title, subtitle, rootFolder, collection, entityLabel, checkBtnLabel, backupBtnLabel, deleteBackupBtnLabel }) {
  const card = el('div', { class: 'card mb-16' });
  card.appendChild(el('div', { class: 'card-header' },
    el('div', {},
      el('div', { class: 'card-title' }, title),
      el('div', { class: 'card-subtitle' }, subtitle)
    )
  ));

  const resultEl        = el('div', { style: 'margin-top:12px' });
  const backupStatusEl  = el('div', { style: 'font-size:12px;margin-top:8px' });
  const deleteStatusEl  = el('div', { style: 'font-size:12px;margin-top:8px' });

  const checkBtn        = button(checkBtnLabel,  { onClick: runCheck });
  const backupBtn       = button(backupBtnLabel, { onClick: runBackup });
  const deleteBackupBtn = button(deleteBackupBtnLabel, { variant: 'danger', onClick: runDeleteBackups });
  card.appendChild(el('div', { class: 'flex gap-8' }, checkBtn, backupBtn, deleteBackupBtn));
  card.appendChild(resultEl);
  card.appendChild(backupStatusEl);
  card.appendChild(deleteStatusEl);

  // ── Check ─────────────────────────────────────────────────────────────────

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
      repoFiles = await listDocRepoFiles(rootFolder);
    } catch (err) {
      resultEl.innerHTML = `<div style="color:var(--danger,#dc3545)">Could not read repository: ${err.message}</div>`;
      checkBtn.disabled = false;
      checkBtn.textContent = checkBtnLabel;
      return;
    }
    checkBtn.disabled = false;
    checkBtn.textContent = checkBtnLabel;

    const repoByPath = new Map(repoFiles.map(f => [f.path.toLowerCase(), f]));
    const entities   = listActive(collection);

    // Collect all doc records that have a repo path
    const allDocs = [];
    for (const entity of entities) {
      for (const doc of (entity.documents || [])) {
        if (doc.path) allDocs.push({ doc, entity });
      }
    }

    const discrepancies = [];
    const matchedPaths  = new Set();

    for (const { doc, entity } of allDocs) {
      const pathLow = doc.path.toLowerCase();
      if (repoByPath.has(pathLow)) {
        matchedPaths.add(pathLow);
      } else {
        discrepancies.push({
          type:   'missing_file',
          detail: `"${doc.name}" (${entityLabel}: "${entity.name}"): file at "${doc.path}" not found in repository — record will be removed`,
          doc, entity
        });
      }
    }

    for (const [pathLow, file] of repoByPath) {
      if (!matchedPaths.has(pathLow)) {
        discrepancies.push({
          type:   'orphan_file',
          detail: `"${file.name}" (${file.path}) has no matching document record`,
          file
        });
      }
    }

    renderCheckResults(entities.length, repoFiles.length, allDocs.length, discrepancies);
  }

  // ── Render results ─────────────────────────────────────────────────────────

  function renderCheckResults(totalEntities, totalFiles, totalDocs, discrepancies) {
    resultEl.innerHTML = '';

    const refreshRow = el('div', { style: 'display:flex;justify-content:flex-end;align-items:center;gap:8px;margin-bottom:8px' });
    refreshRow.appendChild(el('span', { style: 'font-size:11px;color:var(--text-muted)' }, `Checked at ${new Date().toLocaleTimeString()}`));
    refreshRow.appendChild(button('Refresh', { variant: 'sm ghost', onClick: runCheck }));
    resultEl.appendChild(refreshRow);

    const summaryGrid = el('div', { style: 'display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:12px' });
    for (const [label, val, good] of [
      [`${entityLabel}s`,      totalEntities, true],
      ['Repository files',     totalFiles,    true],
      ['Document records',     totalDocs,     true],
      ['Discrepancies',        discrepancies.length, discrepancies.length === 0]
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
        `All ${entityLabel.toLowerCase()} document records match repository files.`));
      return;
    }

    const TYPE_LABEL = { missing_file: 'Missing file', orphan_file: 'Orphan file' };
    const TYPE_CSS   = { orphan_file: 'warning' };

    const list = el('div', { style: 'display:flex;flex-direction:column;gap:2px' });
    for (const d of discrepancies) {
      const row = el('div', { style: 'display:flex;align-items:flex-start;gap:6px;font-size:12px;padding:6px 0;border-bottom:1px solid var(--border)' });
      row.appendChild(el('span', { class: `badge ${TYPE_CSS[d.type] || 'danger'}`, style: 'flex-shrink:0;margin-top:1px' }, TYPE_LABEL[d.type] || d.type));
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

  // ── Resolve actions ────────────────────────────────────────────────────────

  function resolveAction(d) {
    if (d.type === 'missing_file') {
      return async () => {
        const updated = { ...d.entity, documents: (d.entity.documents || []).filter(doc => doc.id !== d.doc.id) };
        upsert(collection, updated);
        markDirty();
      };
    }
    if (d.type === 'orphan_file') {
      return async () => {
        const ok = await confirmDialog(
          `Delete orphaned file "${d.file.name}" from the repository? This cannot be undone.`,
          { danger: true, okLabel: 'Delete File' }
        );
        if (!ok) throw new Error('cancelled');
        await deleteGithubFile(d.file.path, d.file.sha, `Delete orphan: ${d.file.name}`);
      };
    }
    return null;
  }

  // ── Backup ─────────────────────────────────────────────────────────────────

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
    backupStatusEl.textContent = `Listing ${rootFolder}/ files…`;

    let files;
    try {
      files = await listDocRepoFiles(rootFolder);
    } catch (err) {
      backupStatusEl.textContent = `Failed to list files: ${err.message}`;
      backupStatusEl.style.color = 'var(--danger,#dc3545)';
      backupBtn.disabled = false;
      backupBtn.textContent = backupBtnLabel;
      return;
    }

    if (files.length === 0) {
      backupStatusEl.textContent = `No files found under ${rootFolder}/.`;
      backupStatusEl.style.color = 'var(--text-muted)';
      backupBtn.disabled = false;
      backupBtn.textContent = backupBtnLabel;
      return;
    }

    let done = 0, failed = 0;
    for (const file of files) {
      backupStatusEl.textContent = `Copying ${done + failed + 1} / ${files.length}: ${file.name}…`;
      try {
        const fileData = await fetchGithubFile(file.path);
        const b64      = fileData.content.replace(/\s/g, '');
        // Preserve sub-folder: {Root}/{name}/file → {Root}/backup/{name}/file
        const relative = file.path.replace(new RegExp(`^${rootFolder}/`), '');
        await uploadGithubFile(`${rootFolder}/backup/${relative}`, b64, `Backup: ${file.name}`);
        done++;
      } catch (err) {
        console.warn(`[backup] Failed for ${file.name}:`, err.message);
        failed++;
      }
    }

    backupBtn.disabled = false;
    backupBtn.textContent = backupBtnLabel;
    if (failed > 0) {
      backupStatusEl.textContent = `Backup done: ${done} copied, ${failed} failed. Check console for details.`;
      backupStatusEl.style.color = 'var(--danger,#dc3545)';
    } else {
      backupStatusEl.textContent = `Backup complete: ${done} file${done !== 1 ? 's' : ''} copied to ${rootFolder}/backup/.`;
      backupStatusEl.style.color = 'var(--success,#198754)';
    }
  }

  // ── Delete Backups ─────────────────────────────────────────────────────────

  async function runDeleteBackups() {
    const { owner, repo, token } = state.github;
    if (!owner || !repo || !token) {
      deleteStatusEl.textContent = 'GitHub not configured.';
      deleteStatusEl.style.color = 'var(--danger,#dc3545)';
      return;
    }

    deleteBackupBtn.disabled = true;
    deleteBackupBtn.textContent = 'Listing…';
    deleteStatusEl.style.color = 'var(--text-muted)';
    deleteStatusEl.textContent = `Listing ${rootFolder}/backup/ files…`;

    let files;
    try {
      files = await listBackupFiles(`${rootFolder}/backup`);
    } catch (err) {
      deleteStatusEl.textContent = `Failed to list backup files: ${err.message}`;
      deleteStatusEl.style.color = 'var(--danger,#dc3545)';
      deleteBackupBtn.disabled = false;
      deleteBackupBtn.textContent = deleteBackupBtnLabel;
      return;
    }

    deleteBackupBtn.disabled = false;
    deleteBackupBtn.textContent = deleteBackupBtnLabel;

    if (files.length === 0) {
      deleteStatusEl.textContent = `Backup folder is empty or does not exist — nothing to delete.`;
      deleteStatusEl.style.color = 'var(--text-muted)';
      return;
    }

    const ok = await confirmDialog(
      `Delete all ${files.length} file${files.length !== 1 ? 's' : ''} in ${rootFolder}/backup/? This cannot be undone.`,
      { danger: true, okLabel: 'Delete Backups' }
    );
    if (!ok) { deleteStatusEl.textContent = ''; return; }

    deleteBackupBtn.disabled = true;
    deleteBackupBtn.textContent = 'Deleting…';
    let done = 0, failed = 0;
    for (const file of files) {
      deleteStatusEl.textContent = `Deleting ${done + failed + 1} / ${files.length}: ${file.name}…`;
      try {
        await deleteGithubFile(file.path, file.sha, `Delete ${rootFolder.toLowerCase()} backup: ${file.name}`);
        done++;
      } catch (err) {
        console.warn(`[delete-backup] Failed for ${file.name}:`, err.message);
        failed++;
      }
    }

    deleteBackupBtn.disabled = false;
    deleteBackupBtn.textContent = deleteBackupBtnLabel;
    if (failed > 0) {
      deleteStatusEl.textContent = `Deleted ${done}, failed ${failed}. Check console for details.`;
      deleteStatusEl.style.color = 'var(--danger,#dc3545)';
    } else {
      deleteStatusEl.textContent = `Deleted ${done} backup file${done !== 1 ? 's' : ''} from ${rootFolder}/backup/.`;
      deleteStatusEl.style.color = 'var(--success,#198754)';
    }
    if (resultEl.innerHTML) await runCheck();
  }

  return card;
}

function buildPropertiesRepoCard() {
  return buildDocRepoCard({
    title:                'Property Document Repository Maintenance',
    subtitle:             'Audit and back up document files stored under Properties/ in the repository',
    rootFolder:           'Properties',
    collection:           'properties',
    entityLabel:          'Property',
    checkBtnLabel:        'Check Property Documents',
    backupBtnLabel:       'Backup Property Documents',
    deleteBackupBtnLabel: 'Delete Property Backups'
  });
}

function buildClientsRepoCard() {
  return buildDocRepoCard({
    title:                'Client Document Repository Maintenance',
    subtitle:             'Audit and back up document files stored under Clients/ in the repository',
    rootFolder:           'Clients',
    collection:           'clients',
    entityLabel:          'Client',
    checkBtnLabel:        'Check Client Documents',
    backupBtnLabel:       'Backup Client Documents',
    deleteBackupBtnLabel: 'Delete Client Backups'
  });
}

function buildDangerCard() {
  const EXPORT_VERSION = 2;
  const SCHEMA_VERSION = 1;

  // Canonical collection list — order controls export/import summary display
  const ALL_COLLECTIONS = [
    'properties', 'payments', 'expenses', 'vendors', 'tenants',
    'clients', 'services', 'invoices', 'users', 'forecasts',
    'inventory', 'reservationExpenseRules'
  ];

  // Build a versioned snapshot of the full app state.
  // GitHub token is intentionally excluded — it must not appear in exported files.
  function buildSnapshot() {
    const data = structuredClone(state.db);
    if (data.appConfig?.github?.token) delete data.appConfig.github.token;
    return {
      exportVersion: EXPORT_VERSION,
      schemaVersion: SCHEMA_VERSION,
      exportedAt:    new Date().toISOString(),
      appVersion:    String(window._appV || ''),
      exportedBy:    state.session?.username || null,
      snapshotName:  null,
      data
    };
  }

  function triggerDownload(content, filename) {
    const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
    const a   = document.createElement('a');
    a.href     = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  function doExport(filename) {
    triggerDownload(JSON.stringify(buildSnapshot(), null, 2), filename);
  }

  const card = el('div', { class: 'card mb-16' });
  card.appendChild(el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'Data')));

  const statusEl = el('div', { style: 'font-size:12px;margin-top:8px' });

  // ── Export ──────────────────────────────────────────────────────────────────

  const exportBtn = button('Export JSON', { onClick: () => {
    doExport(`bt-snapshot-${new Date().toISOString().slice(0, 10)}.json`);
    statusEl.textContent = `Full snapshot exported at ${new Date().toLocaleTimeString()}.`;
    statusEl.style.color = 'var(--success,#198754)';
  }});

  // ── Import ──────────────────────────────────────────────────────────────────

  const importInput = input({ type: 'file', accept: '.json', style: 'display:none' });

  importInput.onchange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    importInput.value = '';

    // 1. Parse file
    let raw;
    try { raw = JSON.parse(await file.text()); }
    catch {
      statusEl.textContent = 'Import failed: file is not valid JSON.';
      statusEl.style.color = 'var(--danger,#dc3545)';
      return;
    }

    // 2. Detect format: versioned snapshot vs legacy raw-db export
    let importedData, meta;
    if (typeof raw.exportVersion === 'number') {
      if (raw.exportVersion > EXPORT_VERSION) {
        statusEl.textContent = `Import failed: snapshot version ${raw.exportVersion} is newer than this app supports (max v${EXPORT_VERSION}). Update the app first.`;
        statusEl.style.color = 'var(--danger,#dc3545)';
        return;
      }
      if (!raw.data || typeof raw.data !== 'object' || Array.isArray(raw.data)) {
        statusEl.textContent = 'Import failed: snapshot is missing the required "data" section.';
        statusEl.style.color = 'var(--danger,#dc3545)';
        return;
      }
      importedData = raw.data;
      meta         = raw;
    } else if (raw.properties !== undefined || raw.payments !== undefined || raw.settings !== undefined) {
      // Legacy raw-db export — accept with a warning
      importedData = raw;
      meta         = null;
    } else {
      statusEl.textContent = 'Import failed: file does not appear to be a valid Business Tracking export.';
      statusEl.style.color = 'var(--danger,#dc3545)';
      return;
    }

    // 3. Build confirmation body with snapshot summary
    const rows = ALL_COLLECTIONS
      .filter(c => Array.isArray(importedData[c]))
      .map(c => {
        const total   = importedData[c].length;
        const active  = importedData[c].filter(x => !x.deletedAt).length;
        return { name: c, total, active, deleted: total - active };
      });

    const bodyEl = el('div', {});

    if (meta) {
      const parts = [
        `Exported ${new Date(meta.exportedAt).toLocaleString()}`,
        meta.exportedBy   ? `by ${meta.exportedBy}` : null,
        meta.appVersion   ? `(app v${meta.appVersion})` : null
      ].filter(Boolean);
      bodyEl.appendChild(el('div', {
        style: 'margin-bottom:12px;font-size:13px;color:var(--text-muted)'
      }, parts.join(' · ')));
    } else {
      bodyEl.appendChild(el('div', {
        style: 'margin-bottom:12px;padding:8px;background:var(--warning-bg,#fff3cd);border-radius:4px;font-size:12px'
      }, 'Legacy export — no version metadata. Proceeding anyway.'));
    }

    const grid = el('div', {
      style: 'display:grid;grid-template-columns:1fr 1fr;gap:4px 16px;font-size:12px;margin-bottom:12px'
    });
    for (const { name, active, deleted } of rows) {
      grid.appendChild(el('div', { style: 'color:var(--text-muted)' }, name));
      grid.appendChild(el('div', {}, `${active} active${deleted > 0 ? ` + ${deleted} deleted` : ''}`));
    }
    if (rows.length === 0) {
      grid.appendChild(el('div', { style: 'color:var(--text-muted);grid-column:1/-1' }, 'No data collections found in this file.'));
    }
    bodyEl.appendChild(grid);

    bodyEl.appendChild(el('div', {
      style: 'padding:8px;background:var(--danger-bg,#f8d7da);border-radius:4px;font-size:12px;color:var(--danger,#dc3545)'
    }, 'This will replace ALL current app data. Your current state will be downloaded as an automatic backup before the restore proceeds.'));

    // 4. Confirm via custom modal
    const confirmed = await new Promise(resolve => {
      let settled = false;
      const settle = v => { if (!settled) { settled = true; resolve(v); } };
      const okBtn     = button('Restore Snapshot', { variant: 'danger' });
      const cancelBtn = button('Cancel');
      const { close } = openModal({
        title:   'Restore Snapshot',
        body:    bodyEl,
        footer:  [cancelBtn, okBtn],
        onClose: () => settle(false)
      });
      okBtn.onclick     = () => { close(); settle(true); };
      cancelBtn.onclick = () => { close(); settle(false); };
    });

    if (!confirmed) return;

    // 5. Auto-backup current state before overwriting
    doExport(`bt-pre-import-backup-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}.json`);

    // 6. Restore — preserve current GitHub token; take all other config from snapshot
    const restoredDb   = structuredClone(importedData);
    const currentToken = state.github.token || '';
    if (!restoredDb.appConfig)         restoredDb.appConfig = {};
    if (!restoredDb.appConfig.github)  restoredDb.appConfig.github = {};
    if (currentToken)                  restoredDb.appConfig.github.token = currentToken;

    setDb(restoredDb);          // triggers data-loaded → current view refreshes
    saveLocalCache(restoredDb); // warm localStorage cache
    markDirty();                // queue push to GitHub

    const activeTotal = rows.reduce((s, r) => s + r.active, 0);
    statusEl.textContent = `Snapshot restored: ${activeTotal} active records across ${rows.length} collection${rows.length !== 1 ? 's' : ''}. Syncing to GitHub…`;
    statusEl.style.color = 'var(--success,#198754)';
    toast('Snapshot restored successfully', 'success');
    navigate('analytics');
  };

  const importBtn = button('Import JSON', { onClick: () => importInput.click() });
  card.appendChild(el('div', { class: 'flex gap-8' }, exportBtn, importBtn, importInput));
  card.appendChild(statusEl);
  return card;
}
