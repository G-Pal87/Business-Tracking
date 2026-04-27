// Tenants module – CRUD for long-term rental tenants
import { state } from '../core/state.js';
import { el, openModal, closeModal, confirmDialog, toast, select, input, formRow, textarea, button, fmtDate, today } from '../core/ui.js';
import { upsert, remove, byId, newId, formatMoney } from '../core/data.js';
import { CURRENCIES } from '../core/config.js';

export default {
  id: 'tenants',
  label: 'Tenants',
  icon: 'T',
  render(container) { container.appendChild(build()); },
  refresh() { const c = document.getElementById('content'); c.innerHTML = ''; c.appendChild(build()); },
  destroy() {}
};

const STATUSES = {
  active:      { label: 'Active',      css: 'success' },
  past:        { label: 'Past',        css: '' },
  prospective: { label: 'Prospective', css: 'warning' }
};

function build() {
  const wrap = el('div', { class: 'view active' });

  const filterBar = el('div', { class: 'flex gap-8 mb-16', style: 'flex-wrap:wrap' });
  const ltProps = (state.db.properties || []).filter(p => p.type === 'long_term');
  const propSel = select([
    { value: 'all', label: 'All Properties' },
    ...ltProps.map(p => ({ value: p.id, label: p.name }))
  ], 'all');
  const statusSel = select([
    { value: 'all', label: 'All Statuses' },
    ...Object.entries(STATUSES).map(([v, m]) => ({ value: v, label: m.label }))
  ], 'all');

  filterBar.appendChild(propSel);
  filterBar.appendChild(statusSel);
  filterBar.appendChild(el('div', { class: 'flex-1' }));
  filterBar.appendChild(button('+ Add Tenant', { variant: 'primary', onClick: () => openForm(null, renderTable) }));
  wrap.appendChild(filterBar);

  const tableWrap = el('div', { class: 'table-wrap' });
  wrap.appendChild(tableWrap);

  const renderTable = () => {
    tableWrap.innerHTML = '';
    let rows = [...(state.db.tenants || [])];
    if (propSel.value !== 'all') rows = rows.filter(r => r.propertyId === propSel.value);
    if (statusSel.value !== 'all') rows = rows.filter(r => r.status === statusSel.value);
    rows.sort((a, b) => (b.leaseStartDate || '').localeCompare(a.leaseStartDate || ''));

    if (rows.length === 0) {
      tableWrap.appendChild(el('div', { class: 'empty' }, 'No tenants match your filters'));
      return;
    }

    const t = el('table', { class: 'table' });
    const htr = el('tr');
    ['Name', 'Property', 'Email', 'Phone', 'Lease Start', 'Lease End', 'Monthly Rent', 'Deposit', 'Status', ''].forEach((h, i) => {
      htr.appendChild(el('th', (i === 6 || i === 7) ? { class: 'right' } : {}, h));
    });
    const thead = el('thead'); thead.appendChild(htr); t.appendChild(thead);

    const tb = el('tbody');
    for (const r of rows) {
      const prop = byId('properties', r.propertyId);
      const sm = STATUSES[r.status] || { label: r.status, css: '' };
      const tr = el('tr');
      tr.appendChild(el('td', { style: 'font-weight:500' }, r.name));
      tr.appendChild(el('td', {}, prop?.name || '—'));
      tr.appendChild(el('td', { class: 'muted' }, r.email || '—'));
      tr.appendChild(el('td', { class: 'muted' }, r.phone || '—'));
      tr.appendChild(el('td', {}, r.leaseStartDate ? fmtDate(r.leaseStartDate) : '—'));
      tr.appendChild(el('td', {}, r.leaseEndDate ? fmtDate(r.leaseEndDate) : 'Open-ended'));
      tr.appendChild(el('td', { class: 'right num' }, r.monthlyRent ? formatMoney(r.monthlyRent, r.currency || 'EUR', { maxFrac: 0 }) : '—'));
      tr.appendChild(el('td', { class: 'right num muted' }, r.deposit ? formatMoney(r.deposit, r.currency || 'EUR', { maxFrac: 0 }) : '—'));
      tr.appendChild(el('td', {}, el('span', { class: `badge ${sm.css}` }, sm.label)));
      const actions = el('td', { class: 'right' });
      actions.appendChild(button('Edit', { variant: 'sm ghost', onClick: () => openForm(r, renderTable) }));
      actions.appendChild(button('Del', { variant: 'sm ghost', onClick: async () => {
        const ok = await confirmDialog(`Delete tenant "${r.name}"? This will not affect recorded payments.`, { danger: true, okLabel: 'Delete' });
        if (ok) { remove('tenants', r.id); toast('Deleted', 'success'); renderTable(); }
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

  propSel.onchange = renderTable;
  statusSel.onchange = renderTable;
  renderTable();
  return wrap;
}

function openForm(existing, onSave) {
  const ltProps = (state.db.properties || []).filter(p => p.type === 'long_term');
  const defaultProp = ltProps[0]?.id || '';
  const r = existing ? { ...existing } : {
    id: newId('ten'),
    name: '', phone: '', email: '',
    propertyId: defaultProp,
    leaseStartDate: today(), leaseEndDate: '',
    monthlyRent: 0, currency: 'EUR',
    deposit: 0, paymentDayOfMonth: 1,
    notes: '', status: 'active'
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
  const propS       = select(ltProps.map(p => ({ value: p.id, label: p.name })), r.propertyId);
  const leaseStartI = input({ type: 'date', value: r.leaseStartDate || '' });
  const leaseEndI   = input({ type: 'date', value: r.leaseEndDate || '' });
  const rentI       = input({ type: 'number', value: r.monthlyRent || 0, min: 0, step: 0.01 });
  const currencyS   = select(CURRENCIES, r.currency || 'EUR');
  const depositI    = input({ type: 'number', value: r.deposit || 0, min: 0, step: 0.01 });
  const payDayI     = input({ type: 'number', value: r.paymentDayOfMonth || 1, min: 1, max: 28 });
  const statusS     = select(Object.entries(STATUSES).map(([v, m]) => ({ value: v, label: m.label })), r.status || 'active');
  const notesT      = textarea({ placeholder: 'Notes' });
  notesT.value = r.notes || '';

  body.appendChild(formRow('Name', nameI));
  body.appendChild(el('div', { class: 'form-row horizontal' }, formRow('Phone', phoneI), formRow('Email', emailI)));
  body.appendChild(formRow('Property', propS));
  body.appendChild(el('div', { class: 'form-row horizontal' }, formRow('Lease Start', leaseStartI), formRow('Lease End', leaseEndI)));
  body.appendChild(el('div', { class: 'form-row horizontal' }, formRow('Monthly Rent', rentI), formRow('Currency', currencyS)));
  body.appendChild(el('div', { class: 'form-row horizontal' }, formRow('Deposit', depositI), formRow('Payment Day (1–28)', payDayI)));
  body.appendChild(formRow('Status', statusS));
  body.appendChild(formRow('Notes', notesT));

  const save = button('Save', { variant: 'primary', onClick: async () => {
    if (!nameI.value.trim()) { toast('Name is required', 'danger'); return; }
    if (!propS.value) { toast('Select a property', 'danger'); return; }
    if (Number(rentI.value) <= 0) { toast('Monthly rent must be greater than zero', 'danger'); return; }

    const updated = {
      ...r,
      name: nameI.value.trim(),
      phone: phoneI.value.trim(),
      email: emailI.value.trim(),
      propertyId: propS.value,
      leaseStartDate: leaseStartI.value,
      leaseEndDate: leaseEndI.value,
      monthlyRent: Number(rentI.value),
      currency: currencyS.value,
      deposit: Number(depositI.value) || 0,
      paymentDayOfMonth: Math.min(Math.max(Number(payDayI.value) || 1, 1), 28),
      notes: notesT.value.trim(),
      status: statusS.value
    };

    // Warn on overlapping active leases for the same property
    if (updated.status === 'active') {
      const others = (state.db.tenants || []).filter(t =>
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

    upsert('tenants', updated);
    toast(existing ? 'Tenant updated' : 'Tenant added', 'success');
    closeModal();
    if (onSave) onSave();
  }});

  openModal({
    title: existing ? 'Edit Tenant' : 'New Tenant',
    body,
    footer: [button('Cancel', { onClick: closeModal }), save],
    large: true
  });
}
