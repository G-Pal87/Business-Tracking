// Payments module
import { state } from '../core/state.js';
import { el, openModal, closeModal, confirmDialog, toast, select, input, formRow, textarea, button, fmtDate, today } from '../core/ui.js';
import { upsert, remove, byId, newId, formatMoney, formatEUR, toEUR } from '../core/data.js';
import { CURRENCIES, PAYMENT_STATUSES, STREAMS } from '../core/config.js';

export default {
  id: 'payments',
  label: 'Payments',
  icon: 'P',
  render(container) { container.appendChild(build()); },
  refresh() { const c = document.getElementById('content'); c.innerHTML = ''; c.appendChild(build()); },
  destroy() {}
};

function build() {
  const wrap = el('div', { class: 'view active' });

  const filterBar = el('div', { class: 'flex gap-8 mb-16', style: 'flex-wrap:wrap' });
  const propSel = select([{ value: 'all', label: 'All Properties' }, ...(state.db.properties || []).map(p => ({ value: p.id, label: p.name }))], 'all');
  const statusSel = select([{ value: 'all', label: 'All Statuses' }, ...Object.entries(PAYMENT_STATUSES).map(([v, m]) => ({ value: v, label: m.label }))], 'all');
  const streamSel = select([{ value: 'all', label: 'All Streams' }, ...Object.entries(STREAMS).map(([v, m]) => ({ value: v, label: m.short }))], 'all');
  filterBar.appendChild(propSel);
  filterBar.appendChild(statusSel);
  filterBar.appendChild(streamSel);
  filterBar.appendChild(el('div', { class: 'flex-1' }));
  filterBar.appendChild(button('Export CSV', { onClick: () => exportCSV() }));
  filterBar.appendChild(button('+ Add Payment', { variant: 'primary', onClick: () => openForm() }));
  wrap.appendChild(filterBar);

  const tableWrap = el('div', { class: 'table-wrap' });
  wrap.appendChild(tableWrap);

  const renderTable = () => {
    tableWrap.innerHTML = '';
    let rows = [...(state.db.payments || [])];
    if (propSel.value !== 'all') rows = rows.filter(r => r.propertyId === propSel.value);
    if (statusSel.value !== 'all') rows = rows.filter(r => r.status === statusSel.value);
    if (streamSel.value !== 'all') rows = rows.filter(r => r.stream === streamSel.value);
    rows.sort((a, b) => (b.date || '').localeCompare(a.date));

    if (rows.length === 0) {
      tableWrap.appendChild(el('div', { class: 'empty' }, 'No payments match your filters'));
      return;
    }

    const t = el('table', { class: 'table' });
    t.innerHTML = `<thead><tr>
      <th>Date</th><th>Property</th><th>Type</th><th>Source</th><th>Status</th><th class="right">Amount</th><th class="right">EUR</th><th></th>
    </tr></thead>`;
    const tb = el('tbody');
    for (const r of rows) {
      const prop = byId('properties', r.propertyId);
      const sMeta = PAYMENT_STATUSES[r.status] || { label: r.status, css: '' };
      const tr = el('tr');
      tr.appendChild(el('td', {}, fmtDate(r.date)));
      tr.appendChild(el('td', {}, prop?.name || '-'));
      tr.appendChild(el('td', {}, r.type || '-'));
      tr.appendChild(el('td', {}, el('span', { class: 'badge' }, r.source || 'manual')));
      tr.appendChild(el('td', {}, el('span', { class: `badge ${sMeta.css}` }, sMeta.label)));
      tr.appendChild(el('td', { class: 'right num' }, formatMoney(r.amount, r.currency, { maxFrac: 0 })));
      tr.appendChild(el('td', { class: 'right num muted' }, r.currency === 'EUR' ? '' : formatEUR(toEUR(r.amount, r.currency))));
      const actions = el('td', { class: 'right' });
      actions.appendChild(button('Edit', { variant: 'sm ghost', onClick: () => openForm(r) }));
      actions.appendChild(button('Del', { variant: 'sm ghost', onClick: async () => {
        const ok = await confirmDialog('Delete this payment?', { danger: true, okLabel: 'Delete' });
        if (ok) { remove('payments', r.id); toast('Deleted', 'success'); renderTable(); }
      }}));
      tr.appendChild(actions);
      tb.appendChild(tr);
    }
    t.appendChild(tb);
    tableWrap.appendChild(t);

    const totalEUR = rows.reduce((s, r) => s + toEUR(r.amount, r.currency), 0);
    tableWrap.appendChild(el('div', { class: 'flex justify-between', style: 'padding:14px 16px;border-top:1px solid var(--border);font-size:13px' },
      el('span', { class: 'muted' }, `${rows.length} payment(s)`),
      el('strong', { class: 'num' }, `Total: ${formatEUR(totalEUR)}`)
    ));
  };

  propSel.onchange = renderTable;
  statusSel.onchange = renderTable;
  streamSel.onchange = renderTable;
  renderTable();
  return wrap;
}

function openForm(existing) {
  const r = existing ? { ...existing } : {
    id: newId('pay'),
    propertyId: state.db.properties?.[0]?.id || '',
    amount: 0, currency: 'EUR',
    date: today(),
    type: 'rental', status: 'paid', source: 'manual',
    stream: 'short_term_rental', notes: ''
  };

  const body = el('div', {});
  const propOpts = (state.db.properties || []).map(p => ({ value: p.id, label: p.name }));
  const propS = select(propOpts, r.propertyId);
  const amountI = input({ type: 'number', value: r.amount, min: 0, step: 0.01 });
  const currencyS = select(CURRENCIES, r.currency);
  const dateI = input({ type: 'date', value: r.date });
  const typeS = select(['rental', 'deposit', 'cleaning', 'other'], r.type);
  const statusS = select(Object.keys(PAYMENT_STATUSES), r.status);
  const sourceS = select(['manual', 'airbnb', 'bank'], r.source);
  const streamS = select(Object.entries(STREAMS).map(([v, m]) => ({ value: v, label: m.short })), r.stream);
  const notesT = textarea(); notesT.value = r.notes || '';

  body.appendChild(formRow('Property', propS));
  body.appendChild(el('div', { class: 'form-row horizontal' }, formRow('Amount', amountI), formRow('Currency', currencyS)));
  body.appendChild(el('div', { class: 'form-row horizontal' }, formRow('Date', dateI), formRow('Type', typeS)));
  body.appendChild(el('div', { class: 'form-row horizontal' }, formRow('Status', statusS), formRow('Source', sourceS)));
  body.appendChild(formRow('Stream', streamS));
  body.appendChild(formRow('Notes', notesT));

  // Auto-set stream when property changes
  propS.onchange = () => {
    const p = byId('properties', propS.value);
    if (p) {
      streamS.value = p.type === 'short_term' ? 'short_term_rental' : 'long_term_rental';
      currencyS.value = p.currency;
    }
  };

  const save = button('Save', { variant: 'primary', onClick: () => {
    if (!propS.value) { toast('Select a property', 'danger'); return; }
    if (Number(amountI.value) <= 0) { toast('Amount must be positive', 'danger'); return; }
    Object.assign(r, {
      propertyId: propS.value,
      amount: Number(amountI.value),
      currency: currencyS.value,
      date: dateI.value,
      type: typeS.value,
      status: statusS.value,
      source: sourceS.value,
      stream: streamS.value,
      notes: notesT.value.trim()
    });
    upsert('payments', r);
    toast(existing ? 'Payment updated' : 'Payment added', 'success');
    closeModal();
    setTimeout(() => location.hash = 'payments', 200);
  }});
  const cancel = button('Cancel', { onClick: closeModal });

  openModal({ title: existing ? 'Edit Payment' : 'New Payment', body, footer: [cancel, save] });
}

function exportCSV() {
  const rows = state.db.payments || [];
  const headers = ['id', 'date', 'propertyId', 'amount', 'currency', 'type', 'status', 'source', 'stream', 'notes'];
  const lines = [headers.join(',')];
  for (const r of rows) {
    lines.push(headers.map(h => JSON.stringify(r[h] ?? '')).join(','));
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `payments-${today()}.csv`;
  a.click();
  toast('CSV downloaded', 'success');
}
