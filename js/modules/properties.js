// Properties module
import { state } from '../core/state.js';
import { el, openModal, closeModal, confirmDialog, toast, select, input, formRow, textarea, button, fmtDate } from '../core/ui.js';
import {
  upsert, remove, byId, newId, formatEUR, formatMoney, toEUR,
  propertyRevenueEUR, propertyExpensesEUR, renovationCapexEUR, propertyROI
} from '../core/data.js';
import { PROPERTY_TYPES, PROPERTY_STATUSES, CURRENCIES, OWNERS, VENDOR_ROLES } from '../core/config.js';
import { fetchICal, parseICal, nights } from '../core/ical.js';
import { openExpenseForm } from './expenses.js';

let selectedId = null;

export default {
  id: 'properties',
  label: 'Properties',
  icon: 'H',

  render(container) {
    container.appendChild(build());
  },
  refresh() {
    const c = document.getElementById('content');
    c.innerHTML = '';
    c.appendChild(build());
  },
  destroy() {}
};

function build() {
  const wrap = el('div', { class: 'view active' });

  const header = el('div', { class: 'section-header' },
    el('div', { class: 'card-title' }, `${(state.db.properties || []).length} Properties`),
    el('div', { class: 'actions' },
      button('+ Add Property', { variant: 'primary', onClick: () => openForm() })
    )
  );
  wrap.appendChild(header);

  const grid = el('div', { class: 'prop-grid' });
  const props = state.db.properties || [];
  if (props.length === 0) {
    grid.appendChild(el('div', { class: 'empty' }, el('div', { class: 'empty-icon' }, 'H'), 'No properties yet. Add your first one.'));
  }
  for (const p of props) grid.appendChild(card(p));
  wrap.appendChild(grid);

  return wrap;
}

function card(p) {
  const statusCss = PROPERTY_STATUSES[p.status]?.css || 'vacant';
  const year = new Date().getFullYear();
  const rev = propertyRevenueEUR(p.id, { year });
  const exp = propertyExpensesEUR(p.id, { year }, { includeRenovation: false });
  const roi = propertyROI(p.id);
  const c = el('div', { class: 'prop-card' });
  c.onclick = () => openDetail(p.id);
  c.appendChild(el('div', { class: 'prop-card-header' },
    el('div', {},
      el('div', { class: 'prop-card-name' }, p.name),
      el('div', { class: 'prop-card-loc' }, `${p.flag || ''} ${p.city}, ${p.country}`)
    ),
    el('span', { class: `badge ${statusCss === 'active' ? 'success' : statusCss === 'renovation' ? 'warning' : ''}` },
      el('span', { class: `dot ${statusCss}` }),
      PROPERTY_STATUSES[p.status]?.label || p.status
    )
  ));
  c.appendChild(el('div', { class: 'flex gap-8 mt-8' },
    el('span', { class: `badge ${p.type === 'short_term' ? 'short' : 'long'}` }, p.type === 'short_term' ? 'Short-term' : 'Long-term'),
    el('span', { class: 'badge' }, OWNERS[p.owner] || p.owner)
  ));
  c.appendChild(el('div', { class: 'prop-card-stats' },
    statBox('Purchase', formatMoney(p.purchasePrice, p.currency, { maxFrac: 0 })),
    statBox('Rev YTD', formatEUR(rev)),
    statBox('ROI', `${roi.toFixed(1)}%`)
  ));
  return c;
}

function statBox(label, value) {
  return el('div', {},
    el('div', { class: 'prop-card-stat-label' }, label),
    el('div', { class: 'prop-card-stat-value num' }, value)
  );
}

function openDetail(id) {
  selectedId = id;
  const p = byId('properties', id);
  if (!p) return;
  const year = new Date().getFullYear();
  const rev = propertyRevenueEUR(id, { year });
  const exp = propertyExpensesEUR(id, { year }, { includeRenovation: false });
  const reno = renovationCapexEUR({ propertyId: id });
  const roi = propertyROI(id);
  const net = rev - exp;

  const body = el('div', {});
  body.appendChild(el('div', { class: 'flex gap-16 mb-16' },
    el('div', { class: 'prop-flag' }, p.flag || 'P'),
    el('div', { class: 'flex-1' },
      el('h2', {}, p.name),
      el('div', { class: 'muted', style: 'font-size:12px' }, `${p.address}, ${p.city}, ${p.country}`),
      el('div', { class: 'flex gap-8 mt-8' },
        el('span', { class: `badge ${p.status === 'active' ? 'success' : p.status === 'renovation' ? 'warning' : ''}` }, PROPERTY_STATUSES[p.status]?.label || p.status),
        el('span', { class: `badge ${p.type === 'short_term' ? 'short' : 'long'}` }, PROPERTY_TYPES[p.type]),
        el('span', { class: 'badge' }, OWNERS[p.owner] || p.owner)
      )
    )
  ));

  body.appendChild(el('div', { class: 'grid grid-4 mb-16' },
    smallStat('Purchase Price', formatMoney(p.purchasePrice, p.currency, { maxFrac: 0 }), p.currency !== 'EUR' ? `${formatEUR(toEUR(p.purchasePrice, p.currency))} EUR` : null),
    smallStat('Revenue YTD', formatEUR(rev)),
    smallStat('Expenses YTD', formatEUR(exp)),
    smallStat('Net YTD', formatEUR(net))
  ));

  body.appendChild(el('div', { class: 'grid grid-3 mb-16' },
    smallStat('Mortgage Balance', formatMoney(p.mortgageAmount, p.currency, { maxFrac: 0 }), `Monthly ${formatMoney(p.mortgageMonthly, p.currency, { maxFrac: 0 })} @ ${p.mortgageRate}%`),
    smallStat('Renovation CapEx', formatEUR(reno)),
    smallStat('Annual ROI', `${roi.toFixed(2)}%`)
  ));

  if (p.type === 'short_term') {
    body.appendChild(el('div', { class: 'card mb-16' },
      el('div', { class: 'card-header' },
        el('div', { class: 'card-title' }, 'Airbnb Calendar Sync'),
        el('div', { class: 'actions' }, button('Import iCal', { variant: 'primary', onClick: () => doImportICal(p) }))
      ),
      el('div', { class: 'form-row' },
        el('label', { class: 'form-label' }, 'iCal URL (Airbnb export)'),
        input({ id: 'ical-url', value: p.airbnbCalUrl || '', placeholder: 'https://airbnb.com/calendar/ical/...' })
      )
    ));
  }

  // Vendors with rates for this property
  const propVendors = (state.db.vendors || []).filter(v => v.rates && v.rates[id] !== undefined);
  if (propVendors.length > 0) {
    const vendorCard = el('div', { class: 'card mb-16' });
    vendorCard.appendChild(el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'Vendors')));
    const vGrid = el('div', { class: 'grid grid-3', style: 'padding:12px 16px' });
    for (const v of propVendors) {
      const roleMeta = VENDOR_ROLES[v.role] || { label: v.role };
      vGrid.appendChild(smallStat(v.name, formatMoney(v.rates[id], p.currency, { maxFrac: 0 }), roleMeta.label));
    }
    vendorCard.appendChild(vGrid);
    body.appendChild(vendorCard);
  }

  // Utility rates
  if (p.cleaningFee || p.monthlyElectricity || p.monthlyWater) {
    const ratesCard = el('div', { class: 'card mb-16' });
    ratesCard.appendChild(el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'Configured Expense Rates')));
    const rateGrid = el('div', { class: 'grid grid-3', style: 'padding:12px 16px' });
    if (p.cleaningFee) rateGrid.appendChild(smallStat('Cleaning Fee', formatMoney(p.cleaningFee, p.currency, { maxFrac: 0 }), 'per booking'));
    if (p.monthlyElectricity) rateGrid.appendChild(smallStat('Electricity', formatMoney(p.monthlyElectricity, p.currency, { maxFrac: 0 }), 'per month'));
    if (p.monthlyWater) rateGrid.appendChild(smallStat('Water', formatMoney(p.monthlyWater, p.currency, { maxFrac: 0 }), 'per month'));
    ratesCard.appendChild(rateGrid);
    body.appendChild(ratesCard);
  }

  // Expense breakdown
  const expList = (state.db.expenses || []).filter(e => e.propertyId === id).sort((a, b) => (b.date || '').localeCompare(a.date));
  const expTable = el('div', { class: 'card mb-16' });
  const addExpBtn = button('+ Add Expense', { variant: 'primary', onClick: () => {
    closeModal();
    const defaults = { propertyId: id, stream: p.type === 'short_term' ? 'short_term_rental' : 'long_term_rental', currency: p.currency };
    setTimeout(() => openExpenseForm(defaults), 220);
  }});
  expTable.appendChild(el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'Recent Expenses'), el('div', { class: 'actions' }, addExpBtn)));
  if (expList.length === 0) expTable.appendChild(el('div', { class: 'empty' }, 'No expenses recorded'));
  else {
    const tw = el('div', { class: 'table-wrap' });
    const t = el('table', { class: 'table' });
    t.innerHTML = '<thead><tr><th>Date</th><th>Category</th><th>Description</th><th class="right">Amount</th></tr></thead>';
    const tb = el('tbody');
    for (const e of expList.slice(0, 10)) {
      const tr = el('tr');
      tr.appendChild(el('td', {}, fmtDate(e.date)));
      tr.appendChild(el('td', {}, el('span', { class: 'badge' }, e.category)));
      tr.appendChild(el('td', {}, e.description || ''));
      tr.appendChild(el('td', { class: 'right num' }, formatMoney(e.amount, e.currency, { maxFrac: 0 })));
      tb.appendChild(tr);
    }
    t.appendChild(tb);
    tw.appendChild(t);
    expTable.appendChild(tw);
  }
  body.appendChild(expTable);

  const editBtn = button('Edit', { onClick: () => { closeModal(); setTimeout(() => openForm(p), 220); } });
  const delBtn = button('Delete', { variant: 'danger', onClick: async () => {
    const ok = await confirmDialog(`Delete property "${p.name}"? This will NOT delete its payments/expenses.`, { danger: true, okLabel: 'Delete' });
    if (!ok) return;
    remove('properties', p.id);
    toast('Property deleted', 'success');
    closeModal();
    setTimeout(() => location.hash = 'properties', 250);
  }});

  openModal({ title: 'Property Details', body, footer: [delBtn, editBtn], large: true });
}

function smallStat(label, value, sub) {
  return el('div', { class: 'kpi pad-sm' },
    el('div', { class: 'kpi-label' }, label),
    el('div', { style: 'font-size:1.15rem;font-weight:700;font-variant-numeric:tabular-nums' }, value),
    sub ? el('div', { class: 'fx-hint' }, sub) : null
  );
}

function openForm(existing) {
  const p = existing ? { ...existing } : {
    id: newId('prop'),
    name: '', address: '', city: '', country: '', flag: '',
    type: 'short_term', status: 'active',
    bedrooms: 1, bathrooms: 1,
    purchasePrice: 0, currency: 'EUR', purchaseDate: new Date().toISOString().slice(0, 10),
    monthlyRent: 0, nightlyRate: 0,
    mortgageAmount: 0, mortgageMonthly: 0, mortgageRate: 0,
    owner: 'both', airbnbCalUrl: '', notes: '',
    cleaningFee: 0, monthlyElectricity: 0, monthlyWater: 0
  };

  const body = el('div', {});
  const nameI = input({ value: p.name, placeholder: 'e.g. Barcelona Beach Apt' });
  const addressI = input({ value: p.address, placeholder: 'Street address' });
  const cityI = input({ value: p.city });
  const countryI = input({ value: p.country });
  const flagI = input({ value: p.flag, placeholder: 'ES, HU, PT...', maxlength: 4 });
  const typeS = select(Object.entries(PROPERTY_TYPES).map(([v, l]) => ({ value: v, label: l })), p.type);
  const statusS = select(Object.entries(PROPERTY_STATUSES).map(([v, m]) => ({ value: v, label: m.label })), p.status);
  const ownerS = select(Object.entries(OWNERS).map(([v, l]) => ({ value: v, label: l })), p.owner);
  const currencyS = select(CURRENCIES, p.currency);
  const purchaseI = input({ type: 'number', value: p.purchasePrice, min: 0, step: 1000 });
  const dateI = input({ type: 'date', value: p.purchaseDate });
  const rentI = input({ type: 'number', value: p.monthlyRent || 0, min: 0 });
  const payDayI = input({ type: 'number', value: p.paymentDayOfMonth || 1, min: 1, max: 28 });
  const nightlyI = input({ type: 'number', value: p.nightlyRate || 0, min: 0 });
  const mAmtI = input({ type: 'number', value: p.mortgageAmount, min: 0 });
  const mMoI = input({ type: 'number', value: p.mortgageMonthly, min: 0 });
  const mRateI = input({ type: 'number', value: p.mortgageRate, min: 0, step: 0.1 });
  const notesT = textarea({ placeholder: 'Notes' });
  notesT.value = p.notes || '';
  const bedsI = input({ type: 'number', value: p.bedrooms, min: 0 });
  const bathsI = input({ type: 'number', value: p.bathrooms, min: 0 });
  const icalI = input({ value: p.airbnbCalUrl || '', placeholder: 'https://airbnb.com/calendar/ical/...' });
  const cleaningFeeI = input({ type: 'number', value: p.cleaningFee || 0, min: 0, step: 0.01 });
  const electricityI = input({ type: 'number', value: p.monthlyElectricity || 0, min: 0, step: 0.01 });
  const waterI = input({ type: 'number', value: p.monthlyWater || 0, min: 0, step: 0.01 });

  // Rows that toggle based on type
  const ltRow = el('div', { class: 'form-row horizontal' }, formRow('Monthly Rent', rentI), formRow('Payment Due Day', payDayI));
  const stRow = el('div', { class: 'form-row horizontal' }, formRow('Nightly Rate', nightlyI));
  const icalRow = formRow('Airbnb iCal URL', icalI);

  const updateTypeFields = () => {
    const isLT = typeS.value === 'long_term';
    ltRow.style.display = isLT ? '' : 'none';
    stRow.style.display = isLT ? 'none' : '';
    icalRow.style.display = isLT ? 'none' : '';
  };
  typeS.onchange = updateTypeFields;

  body.appendChild(formRow('Name', nameI));
  body.appendChild(el('div', { class: 'form-row horizontal' }, formRow('Address', addressI), formRow('City', cityI)));
  body.appendChild(el('div', { class: 'form-row horizontal' }, formRow('Country', countryI), formRow('Flag (ISO)', flagI)));
  body.appendChild(el('div', { class: 'form-row horizontal' }, formRow('Type', typeS), formRow('Status', statusS)));
  body.appendChild(el('div', { class: 'form-row horizontal' }, formRow('Owner', ownerS), formRow('Currency', currencyS)));
  body.appendChild(el('div', { class: 'form-row horizontal' }, formRow('Purchase Price', purchaseI), formRow('Purchase Date', dateI)));
  body.appendChild(el('div', { class: 'form-row horizontal' }, formRow('Bedrooms', bedsI), formRow('Bathrooms', bathsI)));
  body.appendChild(ltRow);
  body.appendChild(stRow);
  body.appendChild(el('div', { class: 'form-row horizontal' }, formRow('Mortgage Amount', mAmtI), formRow('Monthly Payment', mMoI)));
  body.appendChild(formRow('Interest Rate %', mRateI));
  body.appendChild(icalRow);
  body.appendChild(el('div', { class: 'form-row horizontal' }, formRow('Cleaning Fee (per booking)', cleaningFeeI), formRow('Monthly Electricity', electricityI)));
  body.appendChild(el('div', { class: 'form-row horizontal' }, formRow('Monthly Water', waterI)));
  body.appendChild(formRow('Notes', notesT));
  updateTypeFields();

  const saveBtn = button('Save', { variant: 'primary', onClick: () => {
    if (!nameI.value.trim()) { toast('Name is required', 'danger'); return; }
    Object.assign(p, {
      name: nameI.value.trim(),
      address: addressI.value.trim(),
      city: cityI.value.trim(),
      country: countryI.value.trim(),
      flag: flagI.value.trim().toUpperCase(),
      type: typeS.value,
      status: statusS.value,
      owner: ownerS.value,
      currency: currencyS.value,
      purchasePrice: Number(purchaseI.value) || 0,
      purchaseDate: dateI.value,
      bedrooms: Number(bedsI.value) || 0,
      bathrooms: Number(bathsI.value) || 0,
      monthlyRent: Number(rentI.value) || 0,
      paymentDayOfMonth: Number(payDayI.value) || 1,
      nightlyRate: Number(nightlyI.value) || 0,
      mortgageAmount: Number(mAmtI.value) || 0,
      mortgageMonthly: Number(mMoI.value) || 0,
      mortgageRate: Number(mRateI.value) || 0,
      airbnbCalUrl: icalI.value.trim(),
      notes: notesT.value.trim(),
      cleaningFee: Number(cleaningFeeI.value) || 0,
      monthlyElectricity: Number(electricityI.value) || 0,
      monthlyWater: Number(waterI.value) || 0
    });
    upsert('properties', p);
    toast(existing ? 'Property updated' : 'Property added', 'success');
    closeModal();
    setTimeout(() => location.hash = 'properties', 200);
  }});
  const cancelBtn = button('Cancel', { onClick: closeModal });

  openModal({ title: existing ? 'Edit Property' : 'New Property', body, footer: [cancelBtn, saveBtn], large: true });
}

async function doImportICal(prop) {
  const urlEl = document.getElementById('ical-url');
  const url = urlEl ? urlEl.value.trim() : prop.airbnbCalUrl;
  if (!url) { toast('Enter iCal URL', 'warning'); return; }
  try {
    toast('Fetching calendar...', 'info');
    const text = await fetchICal(url);
    const events = parseICal(text);
    let added = 0;
    for (const ev of events) {
      if (!ev.start || !ev.end) continue;
      const n = nights(ev.start, ev.end);
      if (n <= 0) continue;
      const amount = n * (prop.nightlyRate || 0);
      // avoid duplicates
      const dupe = (state.db.payments || []).some(p => p.propertyId === prop.id && p.date === ev.start && p.source === 'airbnb' && p.notes?.includes(ev.uid || ''));
      if (dupe) continue;
      const pay = {
        id: newId('pay'),
        propertyId: prop.id,
        amount,
        currency: prop.currency,
        date: ev.start,
        type: 'rental',
        status: 'paid',
        source: 'airbnb',
        stream: 'short_term_rental',
        notes: `iCal: ${n} nights${ev.uid ? ' / ' + ev.uid : ''}`
      };
      upsert('payments', pay);
      added++;
    }
    prop.airbnbCalUrl = url;
    upsert('properties', prop);
    toast(`Imported ${added} booking(s)`, 'success');
    closeModal();
    setTimeout(() => location.hash = 'properties', 200);
  } catch (e) {
    toast(`iCal import failed: ${e.message}`, 'danger', 5000);
  }
}
