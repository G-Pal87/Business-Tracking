// Clients module
import { state } from '../core/state.js';
import { el, openModal, closeModal, confirmDialog, toast, select, input, formRow, textarea, button, fmtDate } from '../core/ui.js';
import { upsert, remove, newId, formatMoney, formatEUR, toEUR, byId } from '../core/data.js';
import { CURRENCIES, OWNERS, STREAMS, SERVICE_STREAMS } from '../core/config.js';

export default {
  id: 'clients',
  label: 'Clients',
  icon: 'C',
  render(container) { container.appendChild(build()); },
  refresh() { const c = document.getElementById('content'); c.innerHTML = ''; c.appendChild(build()); },
  destroy() {}
};

function build() {
  const wrap = el('div', { class: 'view active' });

  const filterBar = el('div', { class: 'flex gap-8 mb-16' });
  const streamSel = select([{ value: 'all', label: 'All Streams' }, ...SERVICE_STREAMS.map(s => ({ value: s, label: STREAMS[s].label }))], 'all');
  const ownerSel = select([{ value: 'all', label: 'All Owners' }, ...Object.entries(OWNERS).map(([v, l]) => ({ value: v, label: l }))], 'all');
  filterBar.appendChild(streamSel);
  filterBar.appendChild(ownerSel);
  filterBar.appendChild(el('div', { class: 'flex-1' }));
  filterBar.appendChild(button('+ Add Client', { variant: 'primary', onClick: () => openForm() }));
  wrap.appendChild(filterBar);

  const grid = el('div', { class: 'prop-grid' });
  wrap.appendChild(grid);

  const renderCards = () => {
    grid.innerHTML = '';
    let rows = [...(state.db.clients || [])];
    if (streamSel.value !== 'all') rows = rows.filter(r => r.stream === streamSel.value);
    if (ownerSel.value !== 'all') rows = rows.filter(r => r.owner === ownerSel.value);
    if (rows.length === 0) {
      grid.appendChild(el('div', { class: 'empty' }, 'No clients'));
      return;
    }
    for (const c of rows) grid.appendChild(card(c));
  };
  streamSel.onchange = renderCards;
  ownerSel.onchange = renderCards;
  renderCards();
  return wrap;
}

function card(c) {
  const invs = (state.db.invoices || []).filter(i => i.clientId === c.id);
  const paid = invs.filter(i => i.status === 'paid');
  const totalPaidEUR = paid.reduce((s, i) => s + toEUR(i.total, i.currency), 0);
  const totalOutEUR = invs.filter(i => i.status !== 'paid' && i.status !== 'draft').reduce((s, i) => s + toEUR(i.total, i.currency), 0);
  const streamMeta = STREAMS[c.stream] || { short: c.stream, css: '' };

  const node = el('div', { class: 'prop-card' });
  node.onclick = () => openDetail(c.id);
  node.appendChild(el('div', { class: 'prop-card-header' },
    el('div', {},
      el('div', { class: 'prop-card-name' }, c.name),
      el('div', { class: 'prop-card-loc' }, c.email || '')
    ),
    el('span', { class: `badge ${streamMeta.css}` }, streamMeta.short)
  ));
  node.appendChild(el('div', { class: 'flex gap-8 mt-8' },
    el('span', { class: 'badge' }, OWNERS[c.owner] || c.owner),
    el('span', { class: 'badge' }, c.currency)
  ));
  node.appendChild(el('div', { class: 'prop-card-stats' },
    stat('Paid', formatEUR(totalPaidEUR)),
    stat('Open', formatEUR(totalOutEUR)),
    stat('Invoices', String(invs.length))
  ));
  return node;
}

function stat(label, value) {
  return el('div', {},
    el('div', { class: 'prop-card-stat-label' }, label),
    el('div', { class: 'prop-card-stat-value num' }, value)
  );
}

function openDetail(id) {
  const c = byId('clients', id);
  if (!c) return;
  const invs = (state.db.invoices || []).filter(i => i.clientId === id).sort((a, b) => (b.issueDate || '').localeCompare(a.issueDate));
  const body = el('div', {});
  body.appendChild(el('div', { class: 'mb-16' },
    el('h2', {}, c.name),
    el('div', { class: 'muted' }, c.email || ''),
    el('div', { class: 'flex gap-8 mt-8' },
      el('span', { class: `badge ${STREAMS[c.stream]?.css || ''}` }, STREAMS[c.stream]?.label || c.stream),
      el('span', { class: 'badge' }, OWNERS[c.owner] || c.owner),
      el('span', { class: 'badge' }, c.currency)
    ),
    c.address ? el('div', { class: 'mt-8 muted', style: 'font-size:12px' }, c.address) : null,
    c.vatNumber ? el('div', { class: 'muted', style: 'font-size:12px' }, 'VAT: ' + c.vatNumber) : null,
    c.registrationNumber ? el('div', { class: 'muted', style: 'font-size:12px' }, 'Reg: ' + c.registrationNumber) : null,
    c.notes ? el('div', { class: 'mt-8', style: 'font-size:13px' }, c.notes) : null
  ));

  if (invs.length === 0) {
    body.appendChild(el('div', { class: 'empty' }, 'No invoices yet'));
  } else {
    const t = el('table', { class: 'table' });
    t.innerHTML = `<thead><tr><th>Number</th><th>Issued</th><th>Status</th><th class="right">Amount</th></tr></thead>`;
    const tb = el('tbody');
    for (const i of invs) {
      const tr = el('tr');
      tr.appendChild(el('td', {}, i.number));
      tr.appendChild(el('td', {}, fmtDate(i.issueDate)));
      tr.appendChild(el('td', {}, el('span', { class: `badge ${i.status === 'paid' ? 'success' : i.status === 'sent' ? 'warning' : ''}` }, i.status)));
      tr.appendChild(el('td', { class: 'right num' }, formatMoney(i.total, i.currency, { maxFrac: 0 })));
      tb.appendChild(tr);
    }
    t.appendChild(tb);
    const wrap = el('div', { class: 'table-wrap' }); wrap.appendChild(t); body.appendChild(wrap);
  }

  const edit = button('Edit', { onClick: () => { closeModal(); setTimeout(() => openForm(c), 220); } });
  const del = button('Delete', { variant: 'danger', onClick: async () => {
    const ok = await confirmDialog(`Delete client ${c.name}?`, { danger: true, okLabel: 'Delete' });
    if (!ok) return;
    remove('clients', c.id);
    toast('Deleted', 'success');
    closeModal(); setTimeout(() => location.hash = 'clients', 200);
  }});
  openModal({ title: 'Client', body, footer: [del, edit], large: true });
}

function openForm(existing) {
  const c = existing ? { ...existing } : {
    id: newId('cli'),
    name: '', email: '', address: '', vatNumber: '', registrationNumber: '',
    owner: 'you', stream: 'customer_success', currency: 'EUR',
    contractStart: new Date().toISOString().slice(0, 10),
    notes: ''
  };
  const body = el('div', {});
  const nameI = input({ value: c.name });
  const emailI = input({ value: c.email, type: 'email' });
  const addressI = input({ value: c.address });
  const vatI = input({ value: c.vatNumber, placeholder: 'e.g. HU12345678' });
  const regI = input({ value: c.registrationNumber, placeholder: 'e.g. 01-09-123456' });
  const ownerS = select(Object.entries(OWNERS).map(([v, l]) => ({ value: v, label: l })), c.owner);
  const streamS = select(SERVICE_STREAMS.map(s => ({ value: s, label: STREAMS[s].label })), c.stream);
  const currencyS = select(CURRENCIES, c.currency);
  const dateI = input({ type: 'date', value: c.contractStart });
  const notesT = textarea(); notesT.value = c.notes || '';

  body.appendChild(formRow('Name', nameI));
  body.appendChild(el('div', { class: 'form-row horizontal' }, formRow('Email', emailI), formRow('VAT Number', vatI)));
  body.appendChild(el('div', { class: 'form-row horizontal' }, formRow('Company Registration No.', regI)));
  body.appendChild(formRow('Address', addressI));
  body.appendChild(el('div', { class: 'form-row horizontal' }, formRow('Stream', streamS), formRow('Owner', ownerS)));
  body.appendChild(el('div', { class: 'form-row horizontal' }, formRow('Currency', currencyS), formRow('Contract Start', dateI)));
  body.appendChild(formRow('Notes', notesT));

  const save = button('Save', { variant: 'primary', onClick: () => {
    if (!nameI.value.trim()) { toast('Name required', 'danger'); return; }
    Object.assign(c, {
      name: nameI.value.trim(),
      email: emailI.value.trim(),
      address: addressI.value.trim(),
      vatNumber: vatI.value.trim(),
      registrationNumber: regI.value.trim(),
      owner: ownerS.value,
      stream: streamS.value,
      currency: currencyS.value,
      contractStart: dateI.value,
      notes: notesT.value.trim()
    });
    upsert('clients', c);
    toast(existing ? 'Client updated' : 'Client added', 'success');
    closeModal();
    setTimeout(() => location.hash = 'clients', 200);
  }});
  const cancel = button('Cancel', { onClick: closeModal });
  openModal({ title: existing ? 'Edit Client' : 'New Client', body, footer: [cancel, save] });
}
