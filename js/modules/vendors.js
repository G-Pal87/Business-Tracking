// Vendors module
import { state } from '../core/state.js';
import { el, openModal, closeModal, confirmDialog, toast, select, input, formRow, textarea, button, buildMultiSelect } from '../core/ui.js';
import { upsert, softDelete, listActive, byId, newId, formatMoney, toEUR, formatEUR } from '../core/data.js';
import { VENDOR_ROLES, PROPERTY_TYPES, CURRENCIES } from '../core/config.js';

const APT_TYPES = [
  { key: 'studio',             label: 'Studio' },
  { key: 'one_bedroom',        label: '1 Bedroom' },
  { key: 'two_bedroom',        label: '2 Bedroom' },
  { key: 'three_bedroom_plus', label: '3+ Bedroom' }
];

export default {
  id: 'vendors',
  label: 'Vendors',
  icon: 'V',
  render(container) { container.appendChild(build()); },
  refresh() { const c = document.getElementById('content'); c.innerHTML = ''; c.appendChild(build()); },
  destroy() {}
};

function build() {
  const wrap = el('div', { class: 'view active' });

  const filterBar = el('div', { class: 'flex gap-8 mb-16' });
  const roleFilter = new Set();
  const roleMS = buildMultiSelect(Object.entries(VENDOR_ROLES).map(([v, m]) => ({ value: v, label: m.label })), roleFilter, 'All Roles', () => renderCards(), 'vnd_roles');
  const resetFiltersBtn = button('Reset Filters', { variant: 'sm ghost', onClick: () => { roleMS.reset(); renderCards(); } });
  filterBar.appendChild(roleMS);
  filterBar.appendChild(resetFiltersBtn);
  filterBar.appendChild(el('div', { class: 'flex-1' }));
  filterBar.appendChild(button('+ Add Vendor', { variant: 'primary', onClick: () => openForm() }));
  wrap.appendChild(filterBar);

  const grid = el('div', { class: 'prop-grid' });
  wrap.appendChild(grid);

  function renderCards() {
    grid.innerHTML = '';
    let rows = [...listActive('vendors')];
    if (roleFilter.size > 0) rows = rows.filter(r => roleFilter.has(r.role));
    if (rows.length === 0) {
      grid.appendChild(el('div', { class: 'empty' },
        el('div', { class: 'empty-icon' }, 'V'),
        'No vendors yet. Add your first one.'
      ));
      return;
    }
    for (const v of rows) grid.appendChild(card(v));
  }
  renderCards();
  return wrap;
}

function card(v) {
  const roleMeta = VENDOR_ROLES[v.role] || { label: v.role };
  const rateCount = Object.keys(v.rates || {}).length;
  const node = el('div', { class: 'prop-card' });
  node.onclick = () => openDetail(v.id);
  node.appendChild(el('div', { class: 'prop-card-header' },
    el('div', {},
      el('div', { class: 'prop-card-name' }, v.name),
      el('div', { class: 'prop-card-loc' }, v.phone || v.email || '')
    ),
    el('span', { class: 'badge' }, roleMeta.label)
  ));
  node.appendChild(el('div', { class: 'prop-card-stats' },
    statBox('Properties', String(rateCount)),
    statBox('Phone', v.phone || '-'),
    statBox('Email', v.email ? v.email.split('@')[0] + '@…' : '-')
  ));
  return node;
}

function statBox(label, value) {
  return el('div', {},
    el('div', { class: 'prop-card-stat-label' }, label),
    el('div', { class: 'prop-card-stat-value' }, value)
  );
}

function smallStat(label, value, sub) {
  return el('div', { class: 'kpi pad-sm' },
    el('div', { class: 'kpi-label' }, label),
    el('div', { style: 'font-size:1rem;font-weight:600;font-variant-numeric:tabular-nums' }, value),
    sub ? el('div', { class: 'fx-hint' }, sub) : null
  );
}

function openDetail(id) {
  const v = byId('vendors', id);
  if (!v) return;
  const rates = v.rates || {};

  const body = el('div', {});

  const totalPaidEUR = listActive('expenses')
    .filter(e => e.vendorId === v.id)
    .reduce((s, e) => s + toEUR(e.amount, e.currency, e.date), 0);

  body.appendChild(el('div', { class: 'grid grid-3 mb-16' },
    smallStat('Role', (VENDOR_ROLES[v.role] || { label: v.role }).label),
    smallStat('Phone', v.phone || '—'),
    smallStat('Email', v.email || '—')
  ));
  body.appendChild(el('div', { class: 'grid grid-3 mb-16' },
    smallStat('Total Paid', formatEUR(totalPaidEUR)),
    el('div', {}),
    el('div', {})
  ));

  if (v.pricingMode === 'hourly' && v.hourlyRate) {
    body.appendChild(el('div', { class: 'grid grid-3 mb-16' },
      smallStat('Pricing', 'Hourly'),
      smallStat('Rate', formatMoney(v.hourlyRate, v.currency || 'EUR') + ' / hr'),
      el('div', {})
    ));
  } else if (v.pricingMode === 'apt_type') {
    const ar = v.aptTypeRates || {};
    const cur = v.currency || 'EUR';
    body.appendChild(el('div', { class: 'card mb-16' },
      el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'Rates per Apartment Type')),
      el('div', { class: 'grid grid-4', style: 'padding:8px 16px 16px' },
        ...APT_TYPES.map(t => smallStat(t.label, formatMoney(ar[t.key] || 0, cur, { maxFrac: 0 })))
      )
    ));
  }

  if (v.notes) {
    body.appendChild(el('div', {
      class: 'card mb-16',
      style: 'padding:12px 16px;font-size:13px;color:var(--text-muted)'
    }, v.notes));
  }

  const ratesCard = el('div', { class: 'card mb-16' });
  const addRateBtn = button('+ Add Rate', {
    variant: 'primary',
    onClick: () => {
      closeModal();
      setTimeout(() => openRateForm(v, null, () => setTimeout(() => openDetail(id), 220)), 220);
    }
  });
  ratesCard.appendChild(el('div', { class: 'card-header' },
    el('div', { class: 'card-title' }, 'Rates per Property'),
    el('div', { class: 'actions' }, addRateBtn)
  ));

  const rateEntries = Object.entries(rates);
  if (rateEntries.length === 0) {
    ratesCard.appendChild(el('div', { class: 'empty' }, 'No rates configured yet'));
  } else {
    const tw = el('div', { class: 'table-wrap' });
    const t = el('table', { class: 'table' });
    t.innerHTML = '<thead><tr><th>Property</th><th>Type</th><th class="right">Rate</th><th></th></tr></thead>';
    const tb = el('tbody');
    for (const [propId, rate] of rateEntries) {
      const prop = byId('properties', propId);
      if (!prop) continue;
      const tr = el('tr');
      tr.appendChild(el('td', {}, prop.name));
      tr.appendChild(el('td', {}, el('span', { class: `badge ${prop.type === 'short_term' ? 'short' : 'long'}` }, PROPERTY_TYPES[prop.type] || prop.type)));
      tr.appendChild(el('td', { class: 'right num' }, formatMoney(rate, prop.currency, { maxFrac: 0 })));
      const actions = el('td', { class: 'right' });
      actions.appendChild(button('Edit', {
        variant: 'sm ghost',
        onClick: () => {
          closeModal();
          setTimeout(() => openRateForm(v, propId, () => setTimeout(() => openDetail(id), 220)), 220);
        }
      }));
      actions.appendChild(button('Del', {
        variant: 'sm ghost',
        onClick: async () => {
          const ok = await confirmDialog(`Remove rate for "${prop.name}"?`, { danger: true, okLabel: 'Remove' });
          if (!ok) return;
          delete v.rates[propId];
          upsert('vendors', v);
          toast('Rate removed', 'success');
          closeModal();
          setTimeout(() => openDetail(id), 220);
        }
      }));
      tr.appendChild(actions);
      tb.appendChild(tr);
    }
    t.appendChild(tb);
    tw.appendChild(t);
    ratesCard.appendChild(tw);
  }
  body.appendChild(ratesCard);

  const editBtn = button('Edit', { onClick: () => { closeModal(); setTimeout(() => openForm(v), 220); } });
  const delBtn = button('Delete', {
    variant: 'danger',
    onClick: async () => {
      const ok = await confirmDialog(`Delete vendor "${v.name}"?`, { danger: true, okLabel: 'Delete' });
      if (!ok) return;
      softDelete('vendors', v.id);
      toast('Vendor deleted', 'success');
      closeModal();
      setTimeout(() => location.hash = 'vendors', 250);
    }
  });

  openModal({ title: v.name, body, footer: [delBtn, editBtn], large: true });
}

function openRateForm(vendor, existingPropId, onDone) {
  if (!vendor.rates) vendor.rates = {};
  const allProps = listActive('properties');
  const available = existingPropId
    ? allProps.filter(p => p.id === existingPropId)
    : allProps.filter(p => !(p.id in vendor.rates));

  if (available.length === 0) {
    toast('All properties already have rates configured', 'info');
    if (onDone) onDone();
    return;
  }

  const defaultProp = available[0];
  const body = el('div', {});
  const propS = select(available.map(p => ({ value: p.id, label: p.name })), existingPropId || defaultProp?.id);
  const amountI = input({ type: 'number', value: existingPropId ? (vendor.rates[existingPropId] || 0) : 0, min: 0, step: 0.01 });

  body.appendChild(formRow('Property', propS));
  body.appendChild(formRow('Rate', amountI));

  const saveBtn = button('Save', {
    variant: 'primary',
    onClick: () => {
      if (!propS.value) { toast('Select a property', 'danger'); return; }
      if (Number(amountI.value) <= 0) { toast('Rate must be greater than 0', 'danger'); return; }
      vendor.rates[propS.value] = Number(amountI.value);
      upsert('vendors', vendor);
      toast('Rate saved', 'success');
      closeModal();
      if (onDone) onDone();
    }
  });
  const cancelBtn = button('Cancel', { onClick: () => { closeModal(); if (onDone) onDone(); } });
  openModal({ title: existingPropId ? 'Edit Rate' : 'Add Rate', body, footer: [cancelBtn, saveBtn] });
}

function openForm(existing) {
  const v = existing ? { ...existing } : {
    id: newId('vnd'),
    name: '', role: 'cleaner',
    phone: '', email: '', notes: '',
    rates: {},
    pricingMode: 'hourly', hourlyRate: 0, currency: 'EUR',
    aptTypeRates: { studio: 0, one_bedroom: 0, two_bedroom: 0, three_bedroom_plus: 0 }
  };

  const body = el('div', {});
  const nameI = input({ value: v.name, placeholder: 'Full name or company' });
  const roleS = select(Object.entries(VENDOR_ROLES).map(([val, m]) => ({ value: val, label: m.label })), v.role);
  const phoneI = input({ type: 'tel', value: v.phone || '', placeholder: '+1 555 0000' });
  const emailI = input({ type: 'email', value: v.email || '', placeholder: 'email@example.com' });
  const notesT = textarea({ placeholder: 'Notes (bank details, contact info, etc.)' });
  notesT.value = v.notes || '';

  // Pricing section
  const pricingModeS = select(
    [{ value: 'hourly', label: 'Hourly rate' }, { value: 'apt_type', label: 'Per apartment type' }],
    v.pricingMode || 'hourly'
  );
  const currencyS = select(CURRENCIES, v.currency || 'EUR');
  const hourlyRateI = input({ type: 'number', value: v.hourlyRate || 0, min: 0, step: 0.01 });
  const aptRates = v.aptTypeRates || {};
  const aptInputs = Object.fromEntries(APT_TYPES.map(t => [t.key, input({ type: 'number', value: aptRates[t.key] || 0, min: 0, step: 0.01 })]));

  const hourlyRow = el('div', { class: 'form-row horizontal' }, formRow('Hourly Rate', hourlyRateI));
  const aptGrid = el('div', {},
    el('div', { class: 'form-row horizontal' }, formRow('Studio', aptInputs.studio), formRow('1 Bedroom', aptInputs.one_bedroom)),
    el('div', { class: 'form-row horizontal' }, formRow('2 Bedroom', aptInputs.two_bedroom), formRow('3+ Bedroom', aptInputs.three_bedroom_plus))
  );
  const syncPricingMode = () => {
    const isHourly = pricingModeS.value === 'hourly';
    hourlyRow.style.display = isHourly ? '' : 'none';
    aptGrid.style.display   = isHourly ? 'none' : '';
  };
  pricingModeS.onchange = syncPricingMode;

  const pricingCard = el('div', { class: 'card', style: 'background:var(--bg);padding:12px;margin-bottom:14px' });
  pricingCard.appendChild(el('div', { class: 'card-title mb-8' }, 'Pricing'));
  pricingCard.appendChild(el('div', { class: 'form-row horizontal' }, formRow('Mode', pricingModeS), formRow('Currency', currencyS)));
  pricingCard.appendChild(hourlyRow);
  pricingCard.appendChild(aptGrid);
  syncPricingMode();

  body.appendChild(formRow('Name', nameI));
  body.appendChild(el('div', { class: 'form-row horizontal' }, formRow('Role', roleS)));
  body.appendChild(el('div', { class: 'form-row horizontal' }, formRow('Phone', phoneI), formRow('Email', emailI)));
  body.appendChild(pricingCard);
  body.appendChild(formRow('Notes', notesT));

  const saveBtn = button('Save', {
    variant: 'primary',
    onClick: () => {
      if (!nameI.value.trim()) { toast('Name is required', 'danger'); return; }
      Object.assign(v, {
        name: nameI.value.trim(),
        role: roleS.value,
        phone: phoneI.value.trim(),
        email: emailI.value.trim(),
        notes: notesT.value.trim(),
        pricingMode: pricingModeS.value,
        currency: currencyS.value,
        hourlyRate: Number(hourlyRateI.value) || 0,
        aptTypeRates: Object.fromEntries(APT_TYPES.map(t => [t.key, Number(aptInputs[t.key].value) || 0]))
      });
      upsert('vendors', v);
      toast(existing ? 'Vendor updated' : 'Vendor added', 'success');
      closeModal();
      setTimeout(() => location.hash = 'vendors', 200);
    }
  });
  const cancelBtn = button('Cancel', { onClick: closeModal });
  openModal({ title: existing ? 'Edit Vendor' : 'New Vendor', body, footer: [cancelBtn, saveBtn] });
}
