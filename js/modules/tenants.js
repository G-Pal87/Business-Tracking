// Tenants module – CRUD for long-term rental tenants
import { el, openModal, closeModal, confirmDialog, toast, select, input, formRow, textarea, button, fmtDate, today, attachSortFilter, buildMultiSelect } from '../core/ui.js';
import { upsert, softDelete, listActive, byId, newId, formatMoney, generatePaymentSchedule, getContractExpiryFlag, getTenantDisplayStatus, getPeopleOwners, getPersonName, syncPropertyStatus } from '../core/data.js';
import { CURRENCIES, PROPERTY_STATUSES } from '../core/config.js';
import { isHungary, MESSAGE_LANGUAGES, messageLink } from '../core/electricity.js';
import { computeSettlement, recordSettlement, settlementText } from '../core/settlement.js';
import { runBatch } from '../core/state.js';
import { recordRentPaymentsBulk } from './payments.js';
import { mkTh } from './analytics-helpers.js';
import { thisMonthYm, addDaysYmd } from '../core/dates.js';

let _sortCol = -1, _sortDir = 1, _tenSearch = '';

export default {
  id: 'tenants',
  label: 'Tenants',
  icon: '👥',
  render(container) { container.appendChild(build()); },
  refresh() { const c = document.getElementById('content'); c.innerHTML = ''; c.appendChild(build()); },
  destroy() {}
};

const STATUSES = {
  active:      { label: 'Active',      css: 'success' },
  past:        { label: 'Past',        css: '' },
  prospective: { label: 'Prospective', css: 'warning' }
};
// Layers the computed 'terminating' state (see getTenantDisplayStatus in
// core/data.js) on top of STATUSES, for badges/filters only — never offered
// in the manual status dropdown below, since it isn't a value a user sets.
const DISPLAY_STATUSES = { ...STATUSES, terminating: { label: 'Terminating', css: 'warning' } };
// Status filter for this app session: current tenants (Active + Terminating)
// by default each time the app loads; a change is kept until the next load.
// null = the default; [] = all statuses.
let _tenStatusSel = null;
const DEFAULT_TENANT_STATUSES = ['active', 'terminating'];

function build() {
  const wrap = el('div', { class: 'view active' });

  const filterBar = el('div', { class: 'flex gap-8 mb-16', style: 'flex-wrap:wrap' });
  const allProps = listActive('properties');
  const ltProps = allProps.filter(p => p.type === 'long_term');
  const propMap = new Map(allProps.map(p => [p.id, p]));
  const propFilter   = new Set();
  const ownerFilter  = new Set();
  const statusFilter = new Set();

  const matchesExcept = (t, skip) => {
    if (skip !== 'prop'   && propFilter.size   > 0 && !propFilter.has(t.propertyId)) return false;
    if (skip !== 'owner'  && ownerFilter.size  > 0 && !ownerFilter.has(propMap.get(t.propertyId)?.owner)) return false;
    if (skip !== 'status' && statusFilter.size > 0 && !statusFilter.has(getTenantDisplayStatus(t))) return false;
    return true;
  };

  let _rtTimer;
  const debouncedRT = () => { clearTimeout(_rtTimer); _rtTimer = setTimeout(() => { _tenStatusSel = [...statusFilter]; rebuildFilters(); renderTable(); }, 250); };
  const propMS   = buildMultiSelect([], propFilter,   'All Properties', debouncedRT, 'ten_props');
  const ownerMS  = buildMultiSelect([], ownerFilter,  'All Owners',     debouncedRT, 'ten_owners');
  const statusMS = buildMultiSelect([], statusFilter, 'All Statuses',   debouncedRT, 'ten_statuses');
  statusFilter.clear();
  (_tenStatusSel ?? DEFAULT_TENANT_STATUSES).forEach(v => statusFilter.add(v));

  const rebuildFilters = () => {
    const allTenants = listActive('tenants');
    const validProps = new Set(), validOwners = new Set(), validStatuses = new Set();
    for (const t of allTenants) {
      if (matchesExcept(t, 'prop'))   { if (t.propertyId) validProps.add(t.propertyId); }
      if (matchesExcept(t, 'owner'))  { const ow = propMap.get(t.propertyId)?.owner; if (ow) validOwners.add(ow); }
      if (matchesExcept(t, 'status')) { const ds = getTenantDisplayStatus(t); if (ds) validStatuses.add(ds); }
    }
    propMS.setItems([...validProps].map(id => allProps.find(p => p.id === id)).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name)).map(p => ({ value: p.id, label: p.name })));
    ownerMS.setItems(getPeopleOwners({ includeBoth: true }).filter(o => validOwners.has(o.value)));
    statusMS.setItems([...validStatuses].map(s => { const m = DISPLAY_STATUSES[s] || { label: s, css: '' }; return { value: s, label: m.label, css: m.css }; }));
  };

  const resetFiltersBtn = button('Reset Filters', { variant: 'sm ghost', onClick: () => { propMS.reset(); ownerMS.reset(); statusMS.reset(); _tenStatusSel = []; rebuildFilters(); renderTable(); } });
  filterBar.appendChild(propMS);
  filterBar.appendChild(ownerMS);
  filterBar.appendChild(statusMS);
  filterBar.appendChild(resetFiltersBtn);
  filterBar.appendChild(el('div', { class: 'flex-1' }));
  filterBar.appendChild(button('+ Add Tenant', { variant: 'primary', onClick: () => openForm(null, renderTable) }));
  wrap.appendChild(filterBar);

  const tableWrap = el('div', { class: 'table-wrap' });
  wrap.appendChild(tableWrap);
  attachSortFilter(tableWrap, { initialCol: _sortCol, initialDir: _sortDir, initialSearch: _tenSearch, onSortChange: (c, d) => { _sortCol = c; _sortDir = d; }, onSearchChange: v => { _tenSearch = v; } });

  const renderTable = () => {
    tableWrap.innerHTML = '';
    let rows = [...listActive('tenants')];
    if (propFilter.size > 0)   rows = rows.filter(r => propFilter.has(r.propertyId));
    if (ownerFilter.size > 0)  rows = rows.filter(r => ownerFilter.has(propMap.get(r.propertyId)?.owner));
    if (statusFilter.size > 0) rows = rows.filter(r => statusFilter.has(getTenantDisplayStatus(r)));
    rows.sort((a, b) => (b.leaseStartDate || '').localeCompare(a.leaseStartDate || ''));

    if (rows.length === 0) {
      tableWrap.appendChild(el('div', { class: 'empty' }, 'No tenants match your filters'));
      return;
    }

    const TEN_COLS = [
      { label: 'Name',         tip: "Tenant's full name." },
      { label: 'Property',     tip: 'The long-term rental property this tenant is leasing.' },
      { label: 'Owner',        tip: 'Which partner owns the property this tenant is leasing.' },
      { label: 'Contact',      tip: 'Reach the tenant in one click — ★ marks their preferred way of contact.' },
      { label: 'Lease Start',  tip: "Date the tenant's lease began." },
      { label: 'Lease End',    tip: "Date the tenant's lease is scheduled to end, or \"Open-ended\" if no end date is set." },
      { label: 'Monthly Rent', right: true, tip: "The tenant's contracted monthly rent amount." },
      { label: 'Deposit',      right: true, tip: 'Security deposit amount held for this tenant.' },
      { label: 'Payment Day',  right: true, tip: 'Day of the month the rent is due (a day past the month\'s end falls on its last day).' },
      { label: 'Status',       tip: "Whether the tenant's lease is Active, Past, or Prospective." },
      { label: '' }
    ];
    const t = el('table', { class: 'table' });
    const htr = el('tr');
    TEN_COLS.forEach(col => htr.appendChild(mkTh(col)));
    const thead = el('thead'); thead.appendChild(htr); t.appendChild(thead);

    const tb = el('tbody');
    for (const r of rows) {
      const prop = propMap.get(r.propertyId);
      const sm = DISPLAY_STATUSES[getTenantDisplayStatus(r)] || { label: r.status, css: '' };
      const tr = el('tr');
      tr.appendChild(el('td', { style: 'font-weight:500' }, r.name));
      tr.appendChild(el('td', {}, prop?.name || '—'));
      tr.appendChild(el('td', { class: 'muted' }, prop?.owner ? getPersonName(prop.owner) : '—'));
      tr.appendChild(el('td', {}, contactCell(r)));
      tr.appendChild(el('td', {}, r.leaseStartDate ? fmtDate(r.leaseStartDate) : '—'));
      tr.appendChild(el('td', {}, r.leaseEndDate ? fmtDate(r.leaseEndDate) : 'Open-ended',
        r.terminationDate ? el('div', { class: 'muted', style: 'font-size:11px' }, `terminated ${fmtDate(r.terminationDate)}`) : null));
      tr.appendChild(el('td', { class: 'right num' }, r.monthlyRent ? formatMoney(r.monthlyRent, r.currency || 'EUR', { maxFrac: 0 }) : '—'));
      tr.appendChild(el('td', { class: 'right num muted' }, r.deposit ? formatMoney(r.deposit, r.currency || 'EUR', { maxFrac: 0 }) : '—'));
      tr.appendChild(el('td', { class: 'right num' }, ordinalDay(r.paymentDayOfMonth)));
      const statusCell = el('td', {}, el('span', { class: `badge ${sm.css}` }, sm.label));
      // Terminating = terminated with a move-out date still ahead: say when.
      if (getTenantDisplayStatus(r) === 'terminating') {
        statusCell.appendChild(el('div', { class: 'muted', style: 'font-size:11px;margin-top:2px' }, `leaves ${fmtDate(r.terminationDate)}`));
      }
      const expiryFlag = getContractExpiryFlag(r);
      if (expiryFlag) {
        statusCell.appendChild(expiryFlag.status === 'expired'
          ? el('span', { class: 'badge danger', style: 'margin-left:6px' }, 'Contract expired')
          : el('span', { class: 'badge warning', style: 'margin-left:6px' }, `Expires in ${expiryFlag.days}d`));
      }
      tr.appendChild(statusCell);
      const actions = el('td', { class: 'right' });
      actions.appendChild(button('Edit', { variant: 'sm ghost', onClick: () => openForm(r, renderTable) }));
      if (r.status !== 'past') {
        const tBtn = button('Terminate', { variant: 'sm ghost', onClick: () => openTerminationModal(r, renderTable) });
        tBtn.style.color = '#ef4444';
        actions.appendChild(tBtn);
      }
      actions.appendChild(button('Del', { variant: 'sm ghost', onClick: async () => {
        const pmtCount = listActive('payments').filter(p => p.tenantId === r.id).length;
        if (pmtCount) { toast(`Cannot delete — ${pmtCount} payment(s) are linked to this tenant.`, 'danger', 5000); return; }
        const ok = await confirmDialog(`Delete tenant "${r.name}"?`, { danger: true, okLabel: 'Delete' });
        if (ok) { softDelete('tenants', r.id); syncPropertyStatus(r.propertyId); toast('Deleted', 'success'); renderTable(); }
      }}));
      tr.appendChild(actions);
      tb.appendChild(tr);
    }
    t.appendChild(tb);
    tableWrap.appendChild(t);
    tableWrap.appendChild(el('div', { class: 'flex justify-between', style: 'padding:14px 16px;border-top:1px solid var(--border);font-size:13px' },
      el('span', { class: 'muted' }, `${rows.length} tenant(s)`)
    ));
  };

  rebuildFilters();
  renderTable();
  return wrap;
}

// Ways to reach a tenant. WhatsApp/Viber use their own number when set, else
// the phone number (international format, e.g. +36 30 123 4567).
const CONTACT_METHODS = { whatsapp: 'WhatsApp', viber: 'Viber', call: 'Call', email: 'Email' };
const intlDigits = n => (n || '').replace(/[^\d+]/g, '').replace(/^00/, '+').replace(/\+/g, '');
function contactLinks(t) {
  const out = [];
  const wa = t.whatsapp || t.phone, vb = t.viber || t.phone;
  if (intlDigits(wa)) out.push({ key: 'whatsapp', href: `https://wa.me/${intlDigits(wa)}`, value: wa });
  if (intlDigits(vb)) out.push({ key: 'viber', href: `viber://chat?number=%2B${intlDigits(vb)}`, value: vb });
  if (intlDigits(t.phone)) out.push({ key: 'call', href: `tel:+${intlDigits(t.phone)}`, value: t.phone });
  if (t.email) out.push({ key: 'email', href: `mailto:${encodeURIComponent(t.email).replace(/%40/g, '@')}`, value: t.email });
  return out;
}
function contactCell(t) {
  const links = contactLinks(t);
  if (!links.length) return el('span', { class: 'muted' }, '—');
  const pref = t.preferredContact;
  links.sort((a, b) => (b.key === pref) - (a.key === pref));
  const wrap = el('div', { style: 'display:flex;flex-direction:column;gap:2px' });
  const chips = el('div', { style: 'display:flex;gap:4px;flex-wrap:wrap' });
  for (const l of links) {
    const isPref = l.key === pref;
    const a = el('a', {
      href: l.href, title: `${CONTACT_METHODS[l.key]}: ${l.value}`,
      ...(l.key === 'whatsapp' ? { target: '_blank', rel: 'noopener' } : {}),
      class: `badge${isPref ? ' info' : ''}`,
      style: `text-decoration:none;cursor:pointer;${isPref ? 'font-weight:700' : ''}`
    }, `${isPref ? '★ ' : ''}${CONTACT_METHODS[l.key]}`);
    a.onclick = e => e.stopPropagation();
    chips.appendChild(a);
  }
  wrap.appendChild(chips);
  // The numbers/email as text too, so the table search finds them.
  wrap.appendChild(el('div', { class: 'muted', style: 'font-size:11px' }, [t.phone, t.email].filter(Boolean).join(' · ')));
  return wrap;
}
const ordinalDay = d => {
  const n = Math.min(Math.max(Math.floor(Number(d)) || 1, 1), 31);
  const suf = n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th';
  return `${n}${suf}`;
};

// A renovation/vacant period left open-ended (no endDate) means "still
// ongoing" on the property lifecycle timeline. Once a tenant's lease starts,
// any such period that began before that lease is no longer ongoing — close
// it as of the lease start date instead of leaving a stale band that runs
// forever alongside the new tenant's bar. Returns which kinds got closed, so
// the caller can tell the user.
function closeOpenPeriodsOnLeaseStart(propertyId, leaseStartDate) {
  if (!leaseStartDate) return [];
  const prop = byId('properties', propertyId);
  if (!prop) return [];
  const closedKinds = [];
  const closeOpen = (periods, kind) => (periods || []).map(p => {
    if (!p.endDate && p.startDate && p.startDate <= leaseStartDate) {
      closedKinds.push(kind);
      return { ...p, endDate: leaseStartDate };
    }
    return p;
  });
  const renovationPeriods = closeOpen(prop.renovationPeriods, 'renovation period');
  const vacantPeriods     = closeOpen(prop.vacantPeriods,     'vacant period');
  if (closedKinds.length) upsert('properties', { ...prop, renovationPeriods, vacantPeriods });
  return closedKinds;
}

// `defaults` pre-fills a new tenant (e.g. a replacement after a termination).
function openForm(existing, onSave, defaults = {}) {
  const ltProps = listActive('properties').filter(p => p.type === 'long_term');
  const defaultProp = ltProps[0]?.id || '';
  const r = existing ? { ...existing } : {
    id: newId('ten'),
    name: '', phone: '', email: '',
    propertyId: defaultProp,
    leaseStartDate: today(), leaseEndDate: '',
    // Rent currency follows the apartment's own currency (its purchase price's).
    monthlyRent: 0, currency: byId('properties', defaultProp)?.currency || 'EUR',
    deposit: 0, paymentDayOfMonth: 1,
    notes: '', status: 'active',
    ...defaults
  };

  const body = el('div', {});

  if (ltProps.length === 0) {
    body.appendChild(el('div', { class: 'empty' }, 'No long-term properties configured. Add a long-term property first.'));
    openModal({ title: existing ? 'Edit Tenant' : 'New Tenant', body, footer: [button('Close', { onClick: closeModal })] });
    return;
  }

  const nameI       = input({ value: r.name, placeholder: 'Full name' });
  const phoneI      = input({ value: r.phone || '', placeholder: '+1 234 567 890' });
  const emailI      = input({ type: 'email', value: r.email || '', placeholder: 'tenant@email.com' });
  const whatsappI   = input({ value: r.whatsapp || '', placeholder: 'Same as phone' });
  const viberI      = input({ value: r.viber || '', placeholder: 'Same as phone' });
  // Preferred way of contact: checkboxes that behave as a single choice
  // (ticking one unticks the others; none ticked = no preference).
  const prefChks = Object.entries(CONTACT_METHODS).map(([key, label]) => {
    const c = el('input', { type: 'checkbox' });
    c.checked = r.preferredContact === key;
    c.dataset.method = key;
    c.id = `tenPref_${key}_${r.id}`;
    c.addEventListener('change', () => { if (c.checked) prefChks.forEach(o => { if (o.chk !== c) o.chk.checked = false; }); });
    return { key, chk: c, row: el('label', { for: c.id, style: 'display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer' }, c, label) };
  });
  // Who pays the electricity provider: we do on the tenant's behalf (default)
  // or the tenant directly — then the flat is left out of the Electricity tracker.
  const elecPaidS = select([{ value: 'us', label: "We pay (on the tenant's behalf)" }, { value: 'tenant', label: 'Tenant pays the provider directly' }], r.electricityPaidBy === 'tenant' ? 'tenant' : 'us');
  // Language of the messages the app prepares for this tenant (e.g. the
  // electricity reading request).
  const langS = select(Object.entries(MESSAGE_LANGUAGES).map(([value, label]) => ({ value, label })), r.messageLanguage === 'hu' ? 'hu' : 'en');
  const prefRow = el('div', { style: 'display:flex;gap:16px;flex-wrap:wrap;padding:6px 0' }, ...prefChks.map(o => o.row));
  const propS       = select(ltProps.map(p => ({ value: p.id, label: p.name })), r.propertyId);
  const leaseStartI = input({ type: 'date', value: r.leaseStartDate || '' });
  const leaseEndI   = input({ type: 'date', value: r.leaseEndDate || '' });
  const rentI       = input({ type: 'number', value: r.monthlyRent || 0, min: 0, step: 0.01 });
  const currencyS   = select(CURRENCIES, r.currency || 'EUR');
  const depositI    = input({ type: 'number', value: r.deposit || 0, min: 0, step: 0.01 });
  // Due day 1–31: a day past the month's end falls on its last day (31 → 30 Apr).
  const payDayI     = input({ type: 'number', value: r.paymentDayOfMonth || 1, min: 1, max: 31 });
  const statusS     = select(Object.entries(STATUSES).map(([v, m]) => ({ value: v, label: m.label })), r.status || 'active');
  const notesT      = textarea({ placeholder: 'Notes' });
  notesT.value = r.notes || '';
  // Rent change effective from — for an existing tenant whose rent or
  // currency is edited: earlier months keep the old rent (rentHistory)
  // instead of the whole schedule being rewritten at the new rate. Also shown
  // when the tenant already has a rent history, so a change saved from the
  // wrong month can be moved without re-typing the rent. A month at or before
  // the lease start applies the rent to the whole lease.
  const hasRentHist = !!existing && Array.isArray(existing.rentHistory) && existing.rentHistory.length > 0;
  const rentChanged = () => !!existing && (Number(rentI.value) !== Number(existing.monthlyRent) || currencyS.value !== (existing.currency || 'EUR'));
  // Prefilled with the month the current rent took effect (when there is a
  // history) so it reads as "this rent applies from …"; changing it moves
  // that change. Compared by value on save, not by input events.
  const lastHist    = hasRentHist ? existing.rentHistory[existing.rentHistory.length - 1] : null;
  const histFrom    = lastHist && /^\d{4}-\d{2}/.test(lastHist.from || '') && !lastHist.from.startsWith('0000') ? lastHist.from.slice(0, 7) : '';
  const rentFromI   = input({ type: 'month', value: histFrom || thisMonthYm() });
  let rentFromTouched = false;
  rentFromI.addEventListener('input', () => { rentFromTouched = true; });
  rentFromI.addEventListener('change', () => { rentFromTouched = true; });
  // Editing the rent with the month untouched defaults it to this month.
  const syncRentFromDefault = () => {
    if (!rentFromTouched && histFrom) rentFromI.value = rentChanged() ? thisMonthYm() : histFrom;
  };
  const rentFromRow = el('div', {}, formRow('Rent change effective from', rentFromI),
    el('div', { style: 'font-size:11px;color:var(--text-muted);margin:-4px 0 8px' },
      'Earlier months keep the previous rent. Pick the lease start month to apply this rent to the whole lease.'));
  const syncRentFrom = () => {
    rentFromRow.style.display = existing && (rentChanged() || hasRentHist) ? '' : 'none';
  };
  // A new tenant's rent currency follows the chosen apartment's currency
  // until the currency is picked by hand.
  let currencyTouched = !!existing;
  currencyS.addEventListener('change', () => { currencyTouched = true; });
  propS.addEventListener('change', () => {
    const c = byId('properties', propS.value)?.currency;
    if (!currencyTouched && c) currencyS.value = c;
  });
  rentI.addEventListener('input', () => { syncRentFromDefault(); syncRentFrom(); });
  currencyS.addEventListener('change', () => { syncRentFromDefault(); syncRentFrom(); });
  syncRentFrom();
  // Part months (lease starting on the 20th, ending on the 15th) are prorated
  // by days; untick for leases that charge a full first/last month.
  const prorateChk  = el('input', { type: 'checkbox' });
  prorateChk.checked = r.prorateRent !== false;
  prorateChk.id = 'tenProrate_' + r.id;
  const prorateRow  = el('div', { style: 'display:flex;align-items:center;gap:8px;margin:2px 0 8px' }, prorateChk,
    el('label', { for: prorateChk.id, style: 'font-size:12px;cursor:pointer' }, 'Prorate rent for part months (move-in / move-out)'));
  // Rent months run from the move-in day (in on the 13th → 13th–12th): the
  // first payment is a full month and the last part calendar month owes
  // nothing. On by default for new leases; existing leases keep calendar
  // months until switched.
  const moveInChk   = el('input', { type: 'checkbox' });
  moveInChk.checked = existing ? r.rentFromMoveIn === true : true;
  moveInChk.id = 'tenMoveIn_' + r.id;
  const moveInRow   = el('div', { style: 'display:flex;align-items:center;gap:8px;margin:2px 0 8px' }, moveInChk,
    el('label', { for: moveInChk.id, style: 'font-size:12px;cursor:pointer' }, 'Rent runs from move-in day (e.g. 13th to 12th of next month)'));

  // A terminated lease: say so, and allow undoing a termination made by
  // mistake (back to Active; the lease end stays editable below).
  let cancelTermination = false;
  let termDateI = null;
  if (existing?.terminationDate) {
    const future = existing.terminationDate > today();
    const box = el('div', { style: 'margin-bottom:12px;padding:8px 12px;border-radius:6px;font-size:13px;border-left:3px solid var(--warning);background:var(--warning-soft, rgba(245,158,11,0.10));display:flex;align-items:center;gap:10px;flex-wrap:wrap' });
    const msg = el('span', { style: 'flex:1;min-width:200px' },
      `${future ? 'Terminating' : 'Terminated'} — ${future ? 'leaves' : 'left'} on ${fmtDate(existing.terminationDate)}` +
      (existing.terminationComments ? ` · ${existing.terminationComments}` : ''));
    box.appendChild(msg);
    const undo = button('Cancel termination', { variant: 'sm ghost', onClick: () => {
      cancelTermination = !cancelTermination;
      undo.textContent = cancelTermination ? 'Keep termination' : 'Cancel termination';
      msg.textContent = cancelTermination
        ? 'Termination will be cancelled when you save — status goes back to Active. Check the Lease End date below.'
        : `${future ? 'Terminating' : 'Terminated'} — ${future ? 'leaves' : 'left'} on ${fmtDate(existing.terminationDate)}`;
      if (cancelTermination) statusS.value = 'active';
      else statusS.value = existing.status;
    } });
    box.appendChild(undo);
    // Correct a wrong termination date: the lease end moves with it (the
    // rent schedule stops there) and so do the payments booked at
    // termination (withheld deposit / fee).
    termDateI = input({ type: 'date', value: existing.terminationDate });
    termDateI.style.maxWidth = '170px';
    termDateI.addEventListener('change', () => { if (termDateI.value) leaseEndI.value = termDateI.value; });
    box.appendChild(el('label', { style: 'display:flex;align-items:center;gap:6px;font-size:12px;width:100%' }, 'Termination date', termDateI,
      el('span', { class: 'muted' }, 'rent stops on this day; changing it moves the lease end and the termination payments')));
    body.appendChild(box);
  }

  body.appendChild(formRow('Name', nameI));
  body.appendChild(el('div', { class: 'form-row horizontal' }, formRow('Phone', phoneI), formRow('Email', emailI)));
  body.appendChild(el('div', { class: 'form-row horizontal' }, formRow('WhatsApp number', whatsappI), formRow('Viber number', viberI)));
  body.appendChild(formRow('Message language', langS));
  body.appendChild(formRow('Preferred contact', prefRow, 'Use international format for numbers (e.g. +36 30 123 4567) so the WhatsApp / Viber / call links work.'));
  body.appendChild(formRow('Property', propS));
  body.appendChild(el('div', { class: 'form-row horizontal' }, formRow('Lease Start', leaseStartI), formRow('Lease End', leaseEndI)));
  body.appendChild(el('div', { class: 'form-row horizontal' }, formRow('Monthly Rent', rentI), formRow('Currency', currencyS)));
  body.appendChild(rentFromRow);
  const elecRow = formRow('Electricity', elecPaidS, 'Hungarian flats only: "Tenant pays" leaves this flat out of the meter-reading / invoice tracker while this lease runs.');
  if (!isHungary(byId('properties', propS.value))) elecRow.style.display = 'none';
  propS.addEventListener('change', () => { elecRow.style.display = isHungary(byId('properties', propS.value)) ? '' : 'none'; });
  body.appendChild(el('div', { class: 'form-row horizontal' }, formRow('Deposit', depositI), formRow('Payment Day (1–31)', payDayI)));
  body.appendChild(elecRow);
  body.appendChild(moveInRow);
  body.appendChild(prorateRow);
  body.appendChild(formRow('Status', statusS));
  body.appendChild(formRow('Notes', notesT));

  const save = button('Save', { variant: 'primary', onClick: async () => {
    if (!nameI.value.trim()) { toast('Name is required', 'danger'); return; }
    if (!propS.value) { toast('Select a property', 'danger'); return; }
    const pref = prefChks.find(o => o.chk.checked)?.key || '';
    const prefMissing = { whatsapp: !(whatsappI.value.trim() || phoneI.value.trim()), viber: !(viberI.value.trim() || phoneI.value.trim()), call: !phoneI.value.trim(), email: !emailI.value.trim() }[pref];
    const newTerm = termDateI && !cancelTermination ? termDateI.value : '';
    if (termDateI && !cancelTermination) {
      if (!newTerm) { toast('Termination date is required (or use Cancel termination)', 'danger'); return; }
      if (leaseStartI.value && newTerm < leaseStartI.value) { toast('Termination date cannot be before the lease start', 'danger'); return; }
    }
    if (pref && prefMissing) { toast(`Preferred contact is ${CONTACT_METHODS[pref]} — add ${pref === 'email' ? 'an email address' : 'a phone number'} first`, 'danger'); return; }
    if (Number(rentI.value) <= 0) { toast('Monthly rent must be greater than zero', 'danger'); return; }
    if (Number(depositI.value) < 0) { toast('Deposit cannot be negative', 'danger'); return; }
    if (leaseStartI.value && leaseEndI.value && leaseEndI.value < leaseStartI.value) {
      toast('Lease end cannot be before lease start', 'danger'); return;
    }

    const updated = {
      ...r,
      name: nameI.value.trim(),
      phone: phoneI.value.trim(),
      email: emailI.value.trim(),
      whatsapp: whatsappI.value.trim(),
      viber: viberI.value.trim(),
      preferredContact: pref,
      electricityPaidBy: elecPaidS.value,
      messageLanguage: langS.value,
      propertyId: propS.value,
      leaseStartDate: leaseStartI.value,
      leaseEndDate: leaseEndI.value,
      monthlyRent: Number(rentI.value),
      currency: currencyS.value,
      deposit: Number(depositI.value) || 0,
      paymentDayOfMonth: Math.min(Math.max(Math.floor(Number(payDayI.value)) || 1, 1), 31),
      notes: notesT.value.trim(),
      status: statusS.value
    };
    const termMoved = newTerm && newTerm !== existing.terminationDate;
    if (termMoved) { updated.terminationDate = newTerm; updated.leaseEndDate = newTerm; }
    if (cancelTermination) {
      delete updated.terminationDate;
      delete updated.terminationDepositAction;
      delete updated.terminationComments;
      updated.status = statusS.value === 'past' ? 'active' : statusS.value;
    }
    if (prorateChk.checked) delete updated.prorateRent; else updated.prorateRent = false;
    if (moveInChk.checked) updated.rentFromMoveIn = true; else delete updated.rentFromMoveIn;
    // Rent / currency changed on an existing tenant → record it from the
    // chosen month on. The first change seeds the history with the old rent
    // for every earlier month.
    // An unchanged rent with a re-picked month moves the latest change.
    if (existing && (rentChanged() || (hasRentHist && /^\d{4}-\d{2}$/.test(rentFromI.value) && rentFromI.value !== (histFrom || thisMonthYm())))) {
      const from = /^\d{4}-\d{2}$/.test(rentFromI.value) ? rentFromI.value : thisMonthYm();
      const hist = hasRentHist
        ? [...existing.rentHistory]
        : [{ from: '0000-01', amount: Number(existing.monthlyRent) || 0, currency: existing.currency || 'EUR' }];
      // Rent unchanged: drop the entry that set the current rent so it moves
      // to the picked month instead of staying where it was saved.
      const last = hist[hist.length - 1];
      if (!rentChanged() && hist.length > 1 && last && Number(last.amount) === updated.monthlyRent && (last.currency || 'EUR') === updated.currency) hist.pop();
      if (updated.leaseStartDate && from <= updated.leaseStartDate.slice(0, 7)) {
        delete updated.rentHistory;
      } else {
        updated.rentHistory = [
          ...hist.filter(h => h && typeof h.from === 'string' && h.from.slice(0, 7) < from),
          { from, amount: updated.monthlyRent, currency: updated.currency }
        ];
      }
    }

    // Duplicate-name guard
    if (!existing) {
      const dupe = listActive('tenants').find(t =>
        t.name.trim().toLowerCase() === updated.name.toLowerCase() && t.propertyId === updated.propertyId
      );
      if (dupe) {
        const ok = await confirmDialog(`A tenant named "${dupe.name}" already exists for this property. Save anyway?`, { okLabel: 'Save Anyway' });
        if (!ok) return;
      }
    }

    // Warn on overlapping active leases for the same property
    if (updated.status === 'active') {
      const others = listActive('tenants').filter(t =>
        t.id !== updated.id && t.propertyId === updated.propertyId && t.status === 'active'
      );
      const s1 = updated.leaseStartDate || '0000-01-01';
      const e1 = updated.leaseEndDate   || '9999-12-31';
      const overlap = others.find(t => {
        const s2 = t.leaseStartDate || '0000-01-01';
        const e2 = t.leaseEndDate   || '9999-12-31';
        return s1 <= e2 && s2 <= e1;
      });
      if (overlap) {
        const ok = await confirmDialog(
          `"${overlap.name}" already has an active lease overlapping this period for the same property. Save anyway?`,
          { okLabel: 'Save Anyway' }
        );
        if (!ok) return;
      }
    }

    const isNewPastTenant = !existing && updated.status === 'past';
    upsert('tenants', updated);
    const closedKinds = closeOpenPeriodsOnLeaseStart(updated.propertyId, updated.leaseStartDate);
    // Keep the property's status in line with its leases (a tenant makes it
    // Active; no running lease on an Active long-term flat makes it Vacant).
    const statusChange = syncPropertyStatus(updated.propertyId);
    if (existing && existing.propertyId !== updated.propertyId) syncPropertyStatus(existing.propertyId);
    if (statusChange) toast(`${byId('properties', updated.propertyId)?.name || 'Property'} is now ${PROPERTY_STATUSES[statusChange.to]?.label || statusChange.to}`, 'info', 5000);
    toast(existing ? 'Tenant updated' : 'Tenant added', 'success');
    if (termMoved) {
      const termPays = listActive('payments').filter(p => p.tenantId === updated.id && (p.type === 'deposit_withheld' || p.type === 'termination_fee') && p.date === existing.terminationDate);
      for (const p of termPays) upsert('payments', { ...p, date: newTerm });
      // Rent already received for months after the new date stays (it's real
      // money) — point it out so it can be refunded/re-filed.
      const after = listActive('payments').filter(p => p.tenantId === updated.id && p.status === 'paid' &&
        !['deposit_withheld', 'termination_fee', 'deposit'].includes(p.type) && (p.rentMonth || (p.date || '').slice(0, 7)) > newTerm.slice(0, 7));
      toast(`Termination moved to ${fmtDate(newTerm)} — rent schedule updated${termPays.length ? `, ${termPays.length} termination payment(s) re-dated` : ''}.`, 'info', 7000);
      if (listActive('payments').some(p => p.tenantId === updated.id && p.type === 'rent_refund')) {
        toast('This lease has a move-out settlement worked out for the old date — check its rent refund in Payments (or cancel and re-terminate).', 'warning', 10000);
      }
      if (after.length) toast(`${after.length} rent payment(s) already received for months after ${fmtDate(newTerm)} are kept — check them in Payments (refund or move them).`, 'warning', 10000);
    }
    if (cancelTermination) {
      const termPays = listActive('payments').filter(p => p.tenantId === updated.id && (p.type === 'deposit_withheld' || p.type === 'termination_fee'));
      if (termPays.length) toast(`Termination cancelled — ${termPays.length} payment(s) booked at termination (withheld deposit / fee) are still in Payments; delete them there if they no longer apply.`, 'warning', 9000);
    }
    if (closedKinds.length) {
      toast(`Closed open ${[...new Set(closedKinds)].join(' & ')} as of ${fmtDate(updated.leaseStartDate)}`, 'info', 5000);
    }
    closeModal();
    if (onSave) onSave();

    // A brand-new tenant entered with an already-concluded lease ("past")
    // means their rent schedule (generatePaymentSchedule) shows every month
    // as Overdue — nothing marks it paid automatically. Offer to backfill it
    // right away, capped at the lease end (or today, if somehow unset) so
    // this never offers to pre-pay months that haven't happened yet.
    if (isNewPastTenant) {
      const prop = byId('properties', updated.propertyId);
      if (prop) {
        const cutoff = updated.leaseEndDate || today();
        const unpaidEntries = generatePaymentSchedule(prop)
          .filter(e => e.tenantId === updated.id && !e.paid && e.date <= cutoff);
        if (unpaidEntries.length > 0) {
          setTimeout(async () => {
            const ok = await confirmDialog(
              `This tenant's lease has already ended (${fmtDate(updated.leaseStartDate)} – ${updated.leaseEndDate ? fmtDate(updated.leaseEndDate) : 'present'}). Mark all ${unpaidEntries.length} month(s) of rent as paid?`,
              { okLabel: `Mark ${unpaidEntries.length} Paid` }
            );
            if (!ok) return;
            const { created, skipped } = recordRentPaymentsBulk(prop, unpaidEntries);
            if (created.length) toast(`${created.length} rent payment(s) recorded`, 'success');
            if (skipped.length) toast(`${skipped.length} month(s) already had a paid payment — skipped`, 'info');
            if (onSave) onSave();
          }, 220);
        }
      }
    }
  }});

  openModal({
    title: existing ? 'Edit Tenant' : 'New Tenant',
    body,
    footer: [button('Cancel', { onClick: closeModal }), save],
    large: true
  });
}

function openTerminationModal(tenant, onSave) {
  const prop     = byId('properties', tenant.propertyId);
  const currency = tenant.currency || 'EUR';
  const money    = n => formatMoney(n, currency, { maxFrac: 0 });

  const body = el('div');

  // Context strip
  body.appendChild(el('div', {
    style: 'margin-bottom:16px;padding:10px 12px;background:var(--bg-elev-1);border-radius:6px;border:1px solid var(--border);font-size:13px'
  },
    el('strong', {}, tenant.name),
    el('span', { style: 'color:var(--text-muted);margin-left:8px' },
      `${prop?.name || '—'}  ·  lease from ${tenant.leaseStartDate ? fmtDate(tenant.leaseStartDate) : '—'}`
    )
  ));

  // Termination date — defaults to today
  const termDateI = input({ type: 'date', value: today() });
  body.appendChild(formRow('Termination Date (last day)', termDateI));

  // ── Move-out settlement (core/settlement.js) ──
  // Unused days of the last paid rent period: refund only what a replacement
  // pays for (default), all of them, or none; then deposit minus deductions.
  let policy = 'replacement';
  const deductions = [];
  const replI = input({ type: 'date' });
  const unpaidChk = el('input', { type: 'checkbox', id: 'setUnpaid' });
  unpaidChk.checked = true;
  const card = el('div', { style: 'border:1px solid var(--border);border-radius:8px;padding:12px 14px;margin:8px 0 12px' });
  card.appendChild(el('div', { style: 'font-weight:700;margin-bottom:8px' }, 'Move-out settlement'));
  const periodBox = el('div', { style: 'font-size:13px;margin-bottom:8px' });
  const policyBox = el('div', { style: 'display:flex;flex-direction:column;gap:6px;margin-bottom:10px;font-size:13px' });
  const radio = (val, label) => {
    const r = el('input', { type: 'radio', name: 'set-policy', value: val });
    r.checked = policy === val;
    r.onchange = () => { policy = val; recalc(); };
    return el('label', { style: 'display:flex;align-items:center;gap:8px;cursor:pointer' }, r, label);
  };
  policyBox.appendChild(radio('replacement', 'Refund only the days a replacement pays for'));
  const replRow = el('div', { style: 'display:flex;align-items:center;gap:8px;margin-left:24px' }, el('span', { class: 'muted' }, 'Replacement pays from'), replI);
  policyBox.appendChild(replRow);
  policyBox.appendChild(radio('all', 'Refund all unused days'));
  policyBox.appendChild(radio('none', 'No refund'));
  const unpaidRow = el('label', { for: 'setUnpaid', style: 'display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;margin-bottom:8px' }, unpaidChk, 'Settle unpaid rent from the deposit');
  const dedBox = el('div', { style: 'display:flex;flex-direction:column;gap:6px;margin-bottom:8px' });
  const dedBtns = el('div', { style: 'display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap' },
    button('+ Add deduction', { variant: 'sm ghost', onClick: () => { deductions.push({ reason: '', amount: '' }); drawDeductions(); } }),
    (tenant.deposit || 0) > 0 ? button('Keep the whole deposit', { variant: 'sm ghost', onClick: () => { deductions.push({ reason: 'Deposit kept', amount: tenant.deposit }); drawDeductions(); } }) : null);
  const breakdown = el('div', { style: 'font-size:13px;border-top:1px solid var(--border);padding-top:8px' });
  card.appendChild(periodBox);
  card.appendChild(policyBox);
  card.appendChild(unpaidRow);
  card.appendChild(el('div', { class: 'muted', style: 'font-size:12px;margin-bottom:4px' }, `Deductions from the deposit (${money(tenant.deposit || 0)} held) — damage, cleaning, termination fee…`));
  card.appendChild(dedBox);
  card.appendChild(dedBtns);
  card.appendChild(breakdown);
  body.appendChild(card);

  function drawDeductions() {
    dedBox.innerHTML = '';
    deductions.forEach((d, i) => {
      const rI = input({ value: d.reason, placeholder: 'Reason, e.g. cleaning' });
      const aI = input({ type: 'number', value: d.amount, min: 0, step: 1, placeholder: 'Amount' });
      aI.style.maxWidth = '140px';
      rI.oninput = () => { d.reason = rI.value; recalc(); };
      aI.oninput = () => { d.amount = aI.value; recalc(); };
      dedBox.appendChild(el('div', { style: 'display:flex;gap:6px;align-items:center' }, rI, aI,
        button('✕', { variant: 'sm ghost', onClick: () => { deductions.splice(i, 1); drawDeductions(); } })));
    });
    recalc();
  }

  let settlement = null;
  function recalc() {
    const termDate = termDateI.value || today();
    if (!replI.value || replI.dataset.auto === '1') { replI.value = addDaysYmd(termDate, 1); replI.dataset.auto = '1'; }
    settlement = computeSettlement({ tenant, termDate, policy, replacementFrom: replI.value, deductions, includeUnpaidRent: unpaidChk.checked });
    const s = settlement, pd = s.period;
    periodBox.innerHTML = '';
    if (!pd) periodBox.appendChild(el('div', { class: 'muted' }, 'No rent period of this lease covers that date — nothing to split.'));
    else {
      periodBox.appendChild(el('div', {}, `Rent period ${fmtDate(pd.from)} – ${fmtDate(pd.to)}: `,
        el('strong', {}, pd.paid > 0 ? `${money(pd.paid)} paid` : 'not paid'),
        el('span', { class: 'muted' }, ` · ${pd.usedDays} day(s) used, ${pd.unusedDays} unused`)));
    }
    const showPolicy = pd && pd.paid > 0 && pd.unusedDays > 0;
    policyBox.style.display = showPolicy ? 'flex' : 'none';
    replRow.style.display = policy === 'replacement' ? 'flex' : 'none';
    unpaidRow.style.display = s.rentRows.length || (pd && pd.paid <= 0) ? 'flex' : 'none';
    breakdown.innerHTML = '';
    const line = (label, amt, strong) => el('div', { style: `display:flex;justify-content:space-between;padding:2px 0;${strong ? 'font-weight:700;font-size:15px;border-top:1px solid var(--border);margin-top:4px;padding-top:6px' : ''}` },
      el('span', {}, label), el('span', {}, amt));
    if (showPolicy) breakdown.appendChild(line(`Rent refund (${s.refundDays} of ${pd.unusedDays} unused day(s))`, `+${money(s.refund)}`));
    if (s.deposit) breakdown.appendChild(line('Deposit', `+${money(s.deposit)}`));
    for (const d of [...s.rentRows, ...s.deductions]) breakdown.appendChild(line(d.reason, `−${money(d.amount)}`));
    breakdown.appendChild(s.tenantOwes > 0
      ? line('Tenant owes', money(s.tenantOwes), true)
      : line('To give back', money(s.toGiveBack), true));
  }
  termDateI.addEventListener('input', recalc);
  termDateI.addEventListener('change', recalc);
  replI.addEventListener('change', () => { replI.dataset.auto = ''; recalc(); });
  unpaidChk.addEventListener('change', recalc);
  recalc();

  // Comments
  const commentsT = textarea({ placeholder: 'Reason for termination, notes…' });
  commentsT.value = '';
  body.appendChild(formRow('Comments', commentsT));

  const terminateBtn = button('Terminate & record settlement', { variant: 'primary', onClick: async () => {
    const termDate = termDateI.value || today();
    const comments = commentsT.value.trim();
    if (tenant.leaseStartDate && termDate < tenant.leaseStartDate) {
      toast('Termination date cannot be before the lease start', 'danger'); return;
    }
    if (deductions.some(d => d.amount !== '' && !(Number(d.amount) >= 0))) { toast('Deduction amounts must be positive numbers', 'danger'); return; }
    recalc();
    const s = settlement;
    const ok = await confirmDialog(
      `Terminate the lease for "${tenant.name}" effective ${fmtDate(termDate)}?\n\n` +
      (s.tenantOwes > 0 ? `The tenant owes ${money(s.tenantOwes)}.` : `You give back ${money(s.toGiveBack)}.`) +
      '\nStatus will be set to Past and the settlement recorded.',
      { danger: true, okLabel: 'Confirm Termination' }
    );
    if (!ok) return;

    // Append termination note to existing notes
    let updatedNotes = tenant.notes || '';
    if (comments) {
      updatedNotes = (updatedNotes ? updatedNotes + '\n\n' : '') + `[Terminated ${termDate}] ${comments}`;
    }
    const kept = Math.min(s.deposit, s.totalDeductions);
    runBatch(() => {
      upsert('tenants', {
        ...tenant,
        status:                    'past',
        leaseEndDate:              termDate,
        terminationDate:           termDate,
        terminationDepositAction:  !s.deposit ? 'none' : kept <= 0 ? 'returned' : kept >= s.deposit ? 'withheld' : 'partial',
        terminationComments:       comments || null,
        terminationSettlement: {
          policy: s.policy, replacementFrom: s.replacementFrom || null, refund: s.refund, refundDays: s.refundDays,
          deposit: s.deposit, deductions: [...s.rentRows, ...s.deductions], toGiveBack: s.toGiveBack, tenantOwes: s.tenantOwes,
          period: s.period ? { from: s.period.from, to: s.period.to, paid: s.period.paid } : null
        },
        notes:                     updatedNotes
      });
      recordSettlement(tenant, s);
    });
    // Lease over (as of today) and no other tenant → the flat is Vacant.
    const statusChange = syncPropertyStatus(tenant.propertyId);
    if (statusChange) toast(`${byId('properties', tenant.propertyId)?.name || 'Property'} is now ${PROPERTY_STATUSES[statusChange.to]?.label || statusChange.to}`, 'info', 5000);

    toast(`Lease terminated for ${tenant.name}`, 'success');
    closeModal();
    if (onSave) onSave();
    setTimeout(() => openSettlementSummary(byId('tenants', tenant.id) || tenant, s, onSave), 250);
  }});
  terminateBtn.style.background = '#ef4444';
  terminateBtn.style.borderColor = '#ef4444';

  openModal({
    title: `Terminate Lease — ${tenant.name}`,
    body,
    footer: [button('Cancel', { onClick: closeModal }), terminateBtn],
    large: true
  });
}

// After a termination: the settlement to send the tenant (their language),
// and — when a replacement takes over — their new lease from that date.
function openSettlementSummary(tenant, s, onSave) {
  const text = settlementText(tenant, s, (n, c) => formatMoney(n, c, { maxFrac: 0 }), fmtDate);
  const body = el('div', {});
  body.appendChild(el('div', { style: 'font-size:15px;font-weight:700;margin-bottom:8px' },
    s.tenantOwes > 0 ? `Tenant owes ${formatMoney(s.tenantOwes, s.currency, { maxFrac: 0 })}` : `To give back: ${formatMoney(s.toGiveBack, s.currency, { maxFrac: 0 })}`));
  const ta = textarea({ rows: 8 });
  ta.value = text;
  ta.readOnly = true;
  ta.style.width = '100%';
  body.appendChild(ta);
  const btns = el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-top:8px' });
  btns.appendChild(button('Copy', { variant: 'sm', onClick: async () => {
    try { await navigator.clipboard.writeText(text); toast('Copied', 'success'); } catch { ta.select(); toast('Select the text and copy it', 'warning'); }
  } }));
  const ml = messageLink(tenant, text);
  if (ml && ml.via !== 'call') {
    btns.appendChild(button(`Send via ${{ whatsapp: 'WhatsApp', viber: 'Viber', email: 'email' }[ml.via]}`, { variant: 'sm', onClick: async () => {
      if (ml.copyText) { try { await navigator.clipboard.writeText(text); toast('Copied — paste it in the Viber chat', 'info'); } catch { /* shown above */ } }
      window.open(ml.href, '_blank', 'noopener');
    } }));
  }
  body.appendChild(btns);
  if (s.policy === 'replacement' && s.replacementFrom && s.period && s.replacementFrom <= s.period.to) {
    body.appendChild(el('div', { style: 'margin-top:14px;padding:10px 12px;border-radius:6px;background:var(--info-soft);font-size:13px' },
      el('div', { style: 'margin-bottom:6px' }, `The replacement pays from ${fmtDate(s.replacementFrom)}. Add their lease so their rent is expected from that day.`),
      button(`Create the new tenant from ${fmtDate(s.replacementFrom)}`, { variant: 'sm primary', onClick: () => {
        closeModal();
        setTimeout(() => openForm(null, onSave, { propertyId: tenant.propertyId, leaseStartDate: s.replacementFrom, monthlyRent: tenant.monthlyRent, currency: tenant.currency }), 220);
      } })));
  }
  openModal({ title: 'Move-out settlement', body, footer: [button('Close', { onClick: closeModal })] });
}
