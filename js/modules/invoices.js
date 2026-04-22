// Invoices module - builder + repository
import { state } from '../core/state.js';
import { el, openModal, closeModal, confirmDialog, toast, select, selVals, input, formRow, textarea, button, fmtDate, today, addDays, drillDownModal } from '../core/ui.js';
import { upsert, remove, byId, newId, formatMoney, formatEUR, toEUR } from '../core/data.js';
import { CURRENCIES, INVOICE_STATUSES, OWNERS, STREAMS, SERVICE_UNITS } from '../core/config.js';
import { downloadInvoicePDF } from '../core/pdf.js';
import { navigate } from '../core/router.js';

const INV_COLS = [
  { key: 'number', label: 'Number' },
  { key: 'clientName', label: 'Client' },
  { key: 'issueDate', label: 'Issued', format: v => fmtDate(v) },
  { key: 'dueDate', label: 'Due', format: v => fmtDate(v) },
  { key: 'owner', label: 'Owner', format: v => OWNERS[v] || v },
  { key: 'status', label: 'Status', format: v => { const st = INVOICE_STATUSES[v] || { label: v, css: '' }; return el('span', { class: `badge ${st.css}` }, st.label); } },
  { key: 'total', label: 'Amount', right: true, format: (v, row) => formatMoney(v, row.currency, { maxFrac: 0 }) },
  { key: 'eur', label: '€ EUR', right: true, format: v => formatEUR(v) }
];

function invDrillRows(invs) {
  return invs.map(i => ({ ...i, clientName: byId('clients', i.clientId)?.name || '-', eur: toEUR(i.total, i.currency) }));
}

export default {
  id: 'invoices',
  label: 'Invoices',
  icon: 'I',
  render(container) { container.appendChild(build()); },
  refresh() { const c = document.getElementById('content'); c.innerHTML = ''; c.appendChild(build()); },
  destroy() {}
};

function build() {
  const wrap = el('div', { class: 'view active' });

  const stats = computeStats();
  const allInvs = state.db.invoices || [];
  wrap.appendChild(el('div', { class: 'grid grid-4 mb-16' },
    kpi('Total Issued', formatEUR(stats.totalEUR), `${stats.count} invoices`, null, () => drillDownModal('All Invoices', invDrillRows(allInvs), INV_COLS)),
    kpi('Paid', formatEUR(stats.paidEUR), `${stats.paidCount}`, 'success', () => drillDownModal('Paid Invoices', invDrillRows(allInvs.filter(i => i.status === 'paid')), INV_COLS)),
    kpi('Outstanding', formatEUR(stats.openEUR), `${stats.openCount}`, 'warning', () => drillDownModal('Outstanding Invoices', invDrillRows(allInvs.filter(i => i.status === 'sent')), INV_COLS)),
    kpi('Overdue', formatEUR(stats.overdueEUR), `${stats.overdueCount}`, 'danger', () => drillDownModal('Overdue Invoices', invDrillRows(allInvs.filter(i => i.status === 'overdue')), INV_COLS))
  ));

  const bar = el('div', { class: 'flex gap-8 mb-16', style: 'flex-wrap:wrap' });
  const years = [...new Set((state.db.invoices || []).map(i => i.issueDate?.slice(0, 4)).filter(Boolean))].sort().reverse();
  const months = ['01','02','03','04','05','06','07','08','09','10','11','12'];
  const yearSel = select([{ value: 'all', label: 'All Years' }, ...years.map(y => ({ value: y, label: y }))], 'all');
  const monthSel = select([{ value: 'all', label: 'All Months' }, ...months.map(m => ({ value: m, label: new Date(2000, Number(m)-1, 1).toLocaleDateString('en-US', { month: 'long' }) }))], 'all');
  const clientSel = select([{ value: 'all', label: 'All Clients' }, ...(state.db.clients || []).map(c => ({ value: c.id, label: c.name }))], 'all');
  const ownerSel = select(Object.entries(OWNERS).map(([v, l]) => ({ value: v, label: l })), [], { multiple: true, title: 'Ctrl+click to select multiple owners' });
  const statusSel = select(Object.entries(INVOICE_STATUSES).map(([v, m]) => ({ value: v, label: m.label })), [], { multiple: true, title: 'Ctrl+click to select multiple statuses' });
  bar.appendChild(yearSel);
  bar.appendChild(monthSel);
  bar.appendChild(clientSel);
  bar.appendChild(ownerSel);
  bar.appendChild(statusSel);
  let selected = new Set();

  const deleteSelBtn = button('', { variant: 'danger', onClick: async () => {
    const count = selected.size;
    if (!count) return;
    const ok = await confirmDialog(`Delete ${count} invoice(s)? This cannot be undone.`, { danger: true, okLabel: `Delete ${count}` });
    if (!ok) return;
    for (const id of [...selected]) remove('invoices', id);
    selected.clear();
    toast(`Deleted ${count} invoice(s)`, 'success');
    renderTable();
  }});
  deleteSelBtn.style.display = 'none';

  bar.appendChild(el('div', { class: 'flex-1' }));
  bar.appendChild(deleteSelBtn);
  bar.appendChild(button('Import PDF', { onClick: () => openPDFImport() }));
  bar.appendChild(button('+ New Invoice', { variant: 'primary', onClick: () => openBuilder() }));
  wrap.appendChild(bar);

  const tableWrap = el('div', { class: 'table-wrap' });
  wrap.appendChild(tableWrap);

  const syncDeleteBtn = () => {
    if (selected.size > 0) {
      deleteSelBtn.textContent = `Delete ${selected.size} Selected`;
      deleteSelBtn.style.display = '';
    } else {
      deleteSelBtn.style.display = 'none';
    }
  };

  const renderTable = () => {
    selected.clear();
    syncDeleteBtn();
    tableWrap.innerHTML = '';
    let rows = [...(state.db.invoices || [])];
    if (yearSel.value !== 'all') rows = rows.filter(r => r.issueDate?.startsWith(yearSel.value));
    if (monthSel.value !== 'all') rows = rows.filter(r => r.issueDate?.slice(5, 7) === monthSel.value);
    const owners = selVals(ownerSel);
    const statuses = selVals(statusSel);
    if (clientSel.value !== 'all') rows = rows.filter(r => r.clientId === clientSel.value);
    if (owners) rows = rows.filter(r => owners.includes(r.owner));
    if (statuses) rows = rows.filter(r => statuses.includes(r.status));
    rows.sort((a, b) => (b.issueDate || '').localeCompare(a.issueDate));

    if (rows.length === 0) {
      tableWrap.appendChild(el('div', { class: 'empty' }, 'No invoices'));
      return;
    }
    const t = el('table', { class: 'table' });

    const selectAllChk = el('input', { type: 'checkbox', style: 'cursor:pointer' });
    const htr = el('tr', {});
    const chkTh = el('th', { style: 'width:36px' }); chkTh.appendChild(selectAllChk);
    htr.appendChild(chkTh);
    ['Number', 'Client', 'Issued', 'Due', 'Owner', 'Status'].forEach(h => htr.appendChild(el('th', {}, h)));
    htr.appendChild(el('th', { class: 'right' }, 'Total'));
    htr.appendChild(el('th', {}));
    const thead = el('thead', {}); thead.appendChild(htr); t.appendChild(thead);

    const tb = el('tbody');
    const rowChks = [];

    for (const r of rows) {
      const client = byId('clients', r.clientId);
      const st = INVOICE_STATUSES[r.status] || { label: r.status, css: '' };

      const chk = el('input', { type: 'checkbox', style: 'cursor:pointer' });
      rowChks.push(chk);
      chk.onclick = e => e.stopPropagation();
      chk.onchange = () => {
        if (chk.checked) selected.add(r.id); else selected.delete(r.id);
        const n = rowChks.filter(c => c.checked).length;
        selectAllChk.indeterminate = n > 0 && n < rows.length;
        selectAllChk.checked = n === rows.length;
        syncDeleteBtn();
      };

      const tr = el('tr');
      const chkTd = el('td', { style: 'width:36px' }); chkTd.appendChild(chk);
      chkTd.onclick = e => e.stopPropagation();
      tr.appendChild(chkTd);
      tr.appendChild(el('td', { style: 'font-weight:600' }, r.number));
      tr.appendChild(el('td', {}, client?.name || '-'));
      tr.appendChild(el('td', {}, fmtDate(r.issueDate)));
      tr.appendChild(el('td', {}, fmtDate(r.dueDate)));
      tr.appendChild(el('td', {}, OWNERS[r.owner] || r.owner));
      tr.appendChild(el('td', {}, el('span', { class: `badge ${st.css}` }, st.label)));
      tr.appendChild(el('td', { class: 'right num' }, formatMoney(r.total, r.currency, { maxFrac: 0 })));
      const actions = el('td', { class: 'right flex gap-4', style: 'justify-content:flex-end' });
      actions.appendChild(button('PDF', { variant: 'sm ghost', onClick: (e) => { e.stopPropagation(); downloadInvoicePDF(r); }}));
      actions.appendChild(button('Edit', { variant: 'sm ghost', onClick: (e) => { e.stopPropagation(); openBuilder(r); }}));
      actions.appendChild(button('Del', { variant: 'sm ghost', onClick: async (e) => {
        e.stopPropagation();
        const ok = await confirmDialog(`Delete ${r.number}?`, { danger: true, okLabel: 'Delete' });
        if (ok) { remove('invoices', r.id); toast('Deleted', 'success'); renderTable(); }
      }}));
      tr.appendChild(actions);
      tr.onclick = () => openPreview(r.id);
      tb.appendChild(tr);
    }
    t.appendChild(tb);
    tableWrap.appendChild(t);

    selectAllChk.onchange = () => {
      rowChks.forEach(c => { c.checked = selectAllChk.checked; });
      selectAllChk.indeterminate = false;
      if (selectAllChk.checked) rows.forEach(r => selected.add(r.id)); else selected.clear();
      syncDeleteBtn();
    };
    // Totals footer
    const totalEUR = rows.reduce((s, r) => s + toEUR(r.total, r.currency), 0);
    const paidRows = rows.filter(r => r.status === 'paid');
    const paidEUR = paidRows.reduce((s, r) => s + toEUR(r.total, r.currency), 0);
    const paidSpan = el('span', { style: 'cursor:pointer', title: 'Drill down' });
    paidSpan.appendChild(document.createTextNode('Paid: '));
    paidSpan.appendChild(el('strong', { class: 'num' }, formatEUR(paidEUR)));
    paidSpan.onclick = () => drillDownModal('Paid Invoices (filtered)', invDrillRows(paidRows), INV_COLS);
    const totalSpanEl = el('span', { style: 'cursor:pointer', title: 'Drill down' });
    totalSpanEl.appendChild(document.createTextNode('Total: '));
    totalSpanEl.appendChild(el('strong', { class: 'num' }, formatEUR(totalEUR)));
    totalSpanEl.onclick = () => drillDownModal('All Invoices (filtered)', invDrillRows(rows), INV_COLS);
    tableWrap.appendChild(el('div', { class: 'flex justify-between', style: 'padding:14px 16px;border-top:1px solid var(--border);font-size:13px;flex-wrap:wrap;gap:8px' },
      el('span', { class: 'muted' }, `${rows.length} invoice(s)`),
      el('div', { class: 'flex gap-16' }, paidSpan, totalSpanEl)
    ));
  };
  yearSel.onchange = renderTable;
  monthSel.onchange = renderTable;
  clientSel.onchange = renderTable;
  ownerSel.onchange = renderTable;
  statusSel.onchange = renderTable;
  renderTable();
  return wrap;
}

function computeStats() {
  const rows = state.db.invoices || [];
  const totalEUR = rows.reduce((s, r) => s + toEUR(r.total, r.currency), 0);
  const paid = rows.filter(r => r.status === 'paid');
  const open = rows.filter(r => r.status === 'sent');
  const overdue = rows.filter(r => r.status === 'overdue');
  return {
    count: rows.length,
    totalEUR,
    paidEUR: paid.reduce((s, r) => s + toEUR(r.total, r.currency), 0),
    paidCount: paid.length,
    openEUR: open.reduce((s, r) => s + toEUR(r.total, r.currency), 0),
    openCount: open.length,
    overdueEUR: overdue.reduce((s, r) => s + toEUR(r.total, r.currency), 0),
    overdueCount: overdue.length
  };
}

function kpi(label, value, sub, variant, onClick) {
  const node = el('div', { class: 'kpi' + (variant ? ' ' + variant : '') },
    el('div', { class: 'kpi-label' }, label),
    el('div', { class: 'kpi-value', style: 'font-size:1.4rem' }, value),
    el('div', { class: 'kpi-trend' }, sub || ''),
    el('div', { class: 'kpi-accent-bar' })
  );
  if (onClick) { node.onclick = onClick; node.style.cursor = 'pointer'; }
  return node;
}

function sanitizeClientName(name) {
  return String(name).replace(/[^a-zA-Z0-9]/g, '').slice(0, 20) || 'Client';
}

function nextInvoiceSequence(year, excludeId) {
  let max = 0;
  for (const inv of (state.db.invoices || [])) {
    if (inv.id === excludeId) continue;
    if ((inv.issueDate || '').startsWith(year) && inv.number) {
      const n = parseInt(inv.number.split('_')[0], 10);
      if (!isNaN(n) && n > max) max = n;
    }
  }
  return max + 1;
}

// ============ BUILDER ============
function openBuilder(existing) {
  const clients = state.db.clients || [];
  if (clients.length === 0) { toast('Add a client first', 'warning'); return; }

  const inv = existing ? { ...existing, lineItems: existing.lineItems?.map(l => ({ ...l })) || [] } : {
    id: newId('inv'),
    number: '',
    clientId: clients[0].id,
    owner: clients[0].owner,
    issueDate: today(),
    dueDate: addDays(today(), 30),
    stream: clients[0].stream,
    currency: clients[0].currency,
    status: 'draft',
    lineItems: [],
    subtotal: 0, taxRate: state.db.settings?.defaultTaxRate || 0, tax: 0, total: 0, notes: ''
  };

  const body = el('div', {});
  const clientS = select(clients.map(c => ({ value: c.id, label: c.name })), inv.clientId);
  const numberI = input({ value: inv.number, placeholder: '' });
  const issueI = input({ type: 'date', value: inv.issueDate });
  const dueI = input({ type: 'date', value: inv.dueDate });
  const statusS = select(Object.keys(INVOICE_STATUSES), inv.status);
  const ownerS = select(Object.entries(OWNERS).map(([v, l]) => ({ value: v, label: l })), inv.owner);
  const currencyS = select(CURRENCIES, inv.currency);
  const taxI = input({ type: 'number', value: inv.taxRate, min: 0, max: 100, step: 0.1 });
  const notesT = textarea({ placeholder: 'Notes / payment terms' });
  notesT.value = inv.notes || '';

  body.appendChild(el('div', { class: 'form-row horizontal' }, formRow('Client', clientS), formRow('Owner', ownerS)));
  body.appendChild(el('div', { class: 'form-row horizontal' }, formRow('Number', numberI), formRow('Status', statusS)));
  body.appendChild(el('div', { class: 'form-row horizontal' }, formRow('Issue Date', issueI), formRow('Due Date', dueI)));
  body.appendChild(el('div', { class: 'form-row horizontal' }, formRow('Currency', currencyS), formRow('Tax %', taxI)));

  // Line items editor
  const linesWrap = el('div', { class: 'card', style: 'background:var(--bg);padding:14px;margin-bottom:14px' });
  linesWrap.appendChild(el('div', { class: 'card-title mb-8' }, 'Line Items'));
  const linesList = el('div', { class: 'line-items' });
  linesWrap.appendChild(linesList);

  const addServiceSel = select([{ value: '', label: 'Add service...' }, ...(state.db.services || []).map(s => ({ value: s.id, label: `${s.name} (${formatMoney(s.defaultRate, s.currency, { maxFrac: 0 })}/${s.unit})` }))], '');
  const addCustomBtn = button('+ Custom line', { onClick: () => addLine({ description: '', quantity: 1, unit: 'project', rate: 0, total: 0 }) });
  const addBar = el('div', { class: 'flex gap-8' });
  addBar.appendChild(addServiceSel);
  addBar.appendChild(addCustomBtn);
  linesWrap.appendChild(addBar);
  addServiceSel.onchange = () => {
    const svc = byId('services', addServiceSel.value);
    if (svc) {
      addLine({ serviceId: svc.id, description: svc.name, quantity: 1, unit: svc.unit, rate: svc.defaultRate, total: svc.defaultRate });
    }
    addServiceSel.value = '';
  };

  const totalsDiv = el('div', { class: 'flex-col gap-4', style: 'margin-top:12px;padding-top:12px;border-top:1px solid var(--border);font-size:13px' });
  linesWrap.appendChild(totalsDiv);

  body.appendChild(linesWrap);
  body.appendChild(formRow('Notes', notesT));

  function recalcLine(li) {
    li.total = (Number(li.quantity) || 0) * (Number(li.rate) || 0);
  }
  function recalcInvoice() {
    const subtotal = inv.lineItems.reduce((s, l) => s + (Number(l.total) || 0), 0);
    const taxRate = Number(taxI.value) || 0;
    const tax = subtotal * (taxRate / 100);
    const total = subtotal + tax;
    inv.subtotal = subtotal;
    inv.tax = tax;
    inv.total = total;
    inv.taxRate = taxRate;
    totalsDiv.innerHTML = '';
    const cur = currencyS.value;
    totalsDiv.append(
      rowKV('Subtotal', formatMoney(subtotal, cur)),
      rowKV(`Tax (${taxRate}%)`, formatMoney(tax, cur)),
      rowKV('Total', formatMoney(total, cur), true)
    );
  }
  function rowKV(k, v, bold) {
    return el('div', { class: 'flex justify-between', style: bold ? 'font-weight:700;font-size:15px;margin-top:6px' : '' },
      el('span', { class: 'muted' }, k),
      el('span', { class: 'num' }, v)
    );
  }

  function addLine(data) {
    const line = { id: newId('li'), ...data };
    inv.lineItems.push(line);
    drawLines();
  }
  function removeLine(idx) {
    inv.lineItems.splice(idx, 1);
    drawLines();
  }
  function drawLines() {
    linesList.innerHTML = '';
    linesList.appendChild(el('div', { class: 'line-item-row header' },
      el('div', {}, 'Description'), el('div', {}, 'Qty'), el('div', {}, 'Unit'), el('div', { class: 'right' }, 'Rate / Total'), el('div', {})
    ));
    inv.lineItems.forEach((li, idx) => {
      const descI = input({ value: li.description, placeholder: 'Description' });
      const qtyI = input({ type: 'number', value: li.quantity, min: 0, step: 0.25 });
      const unitS = select(Object.entries(SERVICE_UNITS).map(([v, l]) => ({ value: v, label: l })), li.unit || 'project');
      const rateI = input({ type: 'number', value: li.rate, min: 0, step: 0.01 });
      const totalSpan = el('div', { class: 'num right' }, formatMoney(li.total, currencyS.value));
      const delBtn = button('\u00d7', { variant: 'sm ghost', onClick: () => removeLine(idx) });

      [descI, qtyI, rateI, unitS].forEach(inp => {
        inp.oninput = inp.onchange = () => {
          li.description = descI.value;
          li.quantity = Number(qtyI.value) || 0;
          li.unit = unitS.value;
          li.rate = Number(rateI.value) || 0;
          recalcLine(li);
          totalSpan.textContent = formatMoney(li.total, currencyS.value);
          recalcInvoice();
        };
      });

      const row = el('div', { class: 'line-item-row' },
        descI, qtyI, unitS,
        el('div', { class: 'right', style: 'display:flex;flex-direction:column;gap:2px' },
          rateI,
          totalSpan
        ),
        delBtn
      );
      linesList.appendChild(row);
    });
    recalcInvoice();
  }

  function refreshNumberHint() {
    if (existing || numberI.value.trim()) return;
    const year = (issueI.value || today()).slice(0, 4);
    const date = issueI.value || today();
    const dateFmt = date.split('-').reverse().join('-');
    const client = byId('clients', clientS.value);
    const clientPart = client ? sanitizeClientName(client.name) : 'Client';
    const seq = nextInvoiceSequence(year);
    numberI.placeholder = `Auto: ${seq}_${clientPart}_${dateFmt}`;
  }

  clientS.onchange = () => {
    const c = byId('clients', clientS.value);
    if (c) { ownerS.value = c.owner; currencyS.value = c.currency; drawLines(); }
    refreshNumberHint();
  };
  ownerS.onchange = refreshNumberHint;
  issueI.onchange = refreshNumberHint;
  numberI.oninput = () => { if (!numberI.value.trim()) refreshNumberHint(); else numberI.placeholder = ''; };
  currencyS.onchange = () => drawLines();
  taxI.oninput = recalcInvoice;

  refreshNumberHint();
  drawLines();

  const preview = button('Preview', { onClick: () => previewInvoice(inv, clientS.value) });
  const save = button('Save Invoice', { variant: 'primary', onClick: () => {
    if (inv.lineItems.length === 0) { toast('Add at least one line item', 'danger'); return; }
    inv.clientId = clientS.value;
    inv.owner = ownerS.value;
    inv.currency = currencyS.value;
    inv.issueDate = issueI.value;
    inv.dueDate = dueI.value;
    inv.status = statusS.value;
    inv.stream = byId('clients', inv.clientId)?.stream || inv.stream;
    inv.notes = notesT.value;
    if (!numberI.value.trim()) {
      const year = inv.issueDate.slice(0, 4);
      const client = byId('clients', inv.clientId);
      const clientPart = client ? sanitizeClientName(client.name) : 'Client';
      const seq = nextInvoiceSequence(year, inv.id);
      const dateFmt = inv.issueDate.split('-').reverse().join('-');
      const candidate = `${seq}_${clientPart}_${dateFmt}`;
      if ((state.db.invoices || []).some(i => i.id !== inv.id && i.number === candidate)) {
        toast(`Auto-generated number ${candidate} conflicts with an existing invoice`, 'danger');
        return;
      }
      inv.number = candidate;
    } else {
      inv.number = numberI.value.trim();
      if ((state.db.invoices || []).some(i => i.id !== inv.id && i.number === inv.number)) {
        toast(`Invoice number ${inv.number} is already in use`, 'danger');
        return;
      }
    }
    recalcInvoice();
    upsert('invoices', inv);
    toast(existing ? 'Invoice updated' : 'Invoice saved', 'success');
    closeModal();
    setTimeout(() => navigate('invoices'), 200);
  }});
  const cancel = button('Cancel', { onClick: closeModal });

  openModal({ title: existing ? 'Edit Invoice' : 'New Invoice', body, footer: [cancel, preview, save], large: true });
}

function openPreview(id) {
  const inv = byId('invoices', id);
  if (!inv) return;
  previewInvoice(inv, inv.clientId);
}

function previewInvoice(inv, clientId) {
  const client = byId('clients', clientId) || {};
  const biz = state.db.settings?.business || {};
  const body = el('div', {});
  const preview = el('div', { class: 'invoice-preview' });
  preview.innerHTML = `
    <div class="inv-hdr">
      <div>
        <h1>INVOICE</h1>
        <div class="inv-party">
          <strong>${escape(biz.name || 'Your Business')}</strong><br>
          ${escape(biz.address || '')}<br>
          ${escape(biz.email || '')}<br>
          ${biz.vatNumber ? 'VAT: ' + escape(biz.vatNumber) : ''}
        </div>
      </div>
      <div class="inv-meta">
        <div style="font-size:16px;font-weight:700;margin-bottom:12px">${escape(inv.number || 'DRAFT')}</div>
        Issued: ${fmtDate(inv.issueDate)}<br>
        Due: ${fmtDate(inv.dueDate)}<br>
        <br>
        <strong>BILL TO:</strong><br>
        ${escape(client.name || '')}<br>
        ${escape(client.address || '')}<br>
        ${escape(client.email || '')}<br>
        ${client.vatNumber ? 'VAT: ' + escape(client.vatNumber) : ''}
      </div>
    </div>
    <table>
      <thead><tr><th>Description</th><th style="width:60px">Qty</th><th style="width:60px">Unit</th><th style="width:100px;text-align:right">Rate</th><th style="width:100px;text-align:right">Total</th></tr></thead>
      <tbody>
        ${(inv.lineItems || []).map(li => `
          <tr>
            <td>${escape(li.description)}</td>
            <td>${li.quantity}</td>
            <td>${escape(li.unit || '')}</td>
            <td style="text-align:right">${formatMoney(li.rate, inv.currency)}</td>
            <td style="text-align:right">${formatMoney(li.total, inv.currency)}</td>
          </tr>`).join('')}
      </tbody>
    </table>
    <div class="totals">
      <div class="totals-row"><span>Subtotal</span><span>${formatMoney(inv.subtotal, inv.currency)}</span></div>
      ${inv.taxRate ? `<div class="totals-row"><span>Tax (${inv.taxRate}%)</span><span>${formatMoney(inv.tax, inv.currency)}</span></div>` : ''}
      <div class="totals-row total"><span>Total</span><span>${formatMoney(inv.total, inv.currency)}</span></div>
    </div>
    ${inv.notes ? `<div style="margin-top:32px;padding-top:16px;border-top:1px solid #eee;font-size:12px;color:#666">${escape(inv.notes)}</div>` : ''}
  `;
  body.appendChild(preview);
  const pdfBtn = button('Download PDF', { variant: 'primary', onClick: () => downloadInvoicePDF(inv) });
  const closeBtn = button('Close', { onClick: closeModal });
  openModal({ title: `Invoice ${inv.number || 'Preview'}`, body, footer: [closeBtn, pdfBtn], large: true });
}

function escape(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ===== PDF Import =====
function openPDFImport() {
  const clients = state.db.clients || [];
  const body = el('div', {});
  const streamS = select([
    { value: 'customer_success',   label: 'Customer Success' },
    { value: 'marketing_services', label: 'Marketing Services' }
  ], 'customer_success');
  const clientS = select([{ value: '', label: '— No client —' }, ...clients.map(c => ({ value: c.id, label: c.name }))], clients[0]?.id || '');
  const fileI = el('input', { type: 'file', accept: '.pdf', class: 'input' });

  // Date + invoice # are always editable; pre-filled from auto-parse if found
  const metaWrap = el('div', { style: 'display:none;display:flex;gap:12px;flex-wrap:wrap;margin-bottom:4px' });
  const dateI = el('input', { type: 'date', class: 'input', value: today() });
  const numI = el('input', { type: 'text', class: 'input', placeholder: 'e.g. INV-001', style: 'width:140px' });
  metaWrap.appendChild(formRow('Invoice Date', dateI));
  metaWrap.appendChild(formRow('Invoice #', numI));

  const preview = el('div', { style: 'margin-top:12px;font-size:13px;min-height:20px' });

  body.appendChild(formRow('Stream', streamS));
  body.appendChild(formRow('Client', clientS));
  body.appendChild(formRow('PDF File', fileI));
  body.appendChild(el('div', { style: 'margin-top:12px' }, metaWrap));
  body.appendChild(preview);

  let parsed = null;
  let manualItems = [];

  const manualList = el('div', {});
  const renderManualList = () => {
    manualList.innerHTML = '';
    if (manualItems.length === 0) return;
    const tw = el('div', { class: 'table-wrap' });
    const t = el('table', { class: 'table' });
    t.innerHTML = '<thead><tr><th>Description</th><th class="right">Qty</th><th class="right">Rate</th><th class="right">Total</th><th></th></tr></thead>';
    const tb = el('tbody');
    manualItems.forEach((item, idx) => {
      const tr = el('tr');
      tr.appendChild(el('td', {}, item.description));
      tr.appendChild(el('td', { class: 'right num' }, String(item.quantity)));
      tr.appendChild(el('td', { class: 'right num' }, `€ ${item.rate.toFixed(2)}`));
      tr.appendChild(el('td', { class: 'right num' }, `€ ${item.total.toFixed(2)}`));
      const rm = el('button', { class: 'btn', style: 'padding:2px 8px;font-size:11px' }, '×');
      rm.onclick = () => { manualItems.splice(idx, 1); renderManualList(); };
      tr.appendChild(el('td', { style: 'width:32px;text-align:center' }, rm));
      tb.appendChild(tr);
    });
    t.appendChild(tb); tw.appendChild(t);
    manualList.appendChild(tw);
  };

  const showManualEntry = (rawLines) => {
    preview.innerHTML = '';
    if (rawLines.length > 0) {
      preview.appendChild(el('div', { style: 'color:var(--warning,#f59e0b);font-size:12px;margin-bottom:6px' },
        'Auto-parse found no items — enter them manually using the extracted text as reference:'));
      const pre = el('pre', { style: 'font-size:11px;color:var(--text-muted);white-space:pre-wrap;max-height:130px;overflow:auto;background:var(--bg-elev-2);padding:8px;border-radius:4px;margin-bottom:12px' });
      pre.textContent = rawLines.slice(0, 60).join('\n');
      preview.appendChild(pre);
    } else {
      preview.appendChild(el('div', { style: 'color:var(--warning,#f59e0b);font-size:12px;margin-bottom:12px' },
        'Could not extract text from this PDF. Enter invoice items manually:'));
    }

    const descI = el('input', { type: 'text', class: 'input', placeholder: 'Service description', style: 'min-width:180px' });
    const qtyI = el('input', { type: 'number', class: 'input', value: '1', style: 'width:64px' });
    const rateI = el('input', { type: 'number', class: 'input', placeholder: '0.00', style: 'width:90px' });
    const totalI = el('input', { type: 'number', class: 'input', placeholder: '0.00', style: 'width:90px' });

    const calcTotal = () => {
      const q = parseFloat(qtyI.value) || 0, r = parseFloat(rateI.value) || 0;
      if (q > 0 && r > 0) totalI.value = (q * r).toFixed(2);
    };
    qtyI.oninput = calcTotal;
    rateI.oninput = calcTotal;

    const addBtn = button('+ Add', { onClick: () => {
      const desc = descI.value.trim();
      const qty = parseFloat(qtyI.value) || 1;
      const rate = parseFloat(rateI.value) || 0;
      const total = parseFloat(totalI.value) || (rate * qty);
      if (!desc || total <= 0) { toast('Enter a description and total amount', 'warning'); return; }
      manualItems.push({ description: desc, quantity: qty, rate, total });
      descI.value = ''; qtyI.value = '1'; rateI.value = ''; totalI.value = '';
      renderManualList();
    }});

    const row = el('div', { style: 'display:flex;gap:6px;align-items:flex-end;flex-wrap:wrap;margin-bottom:8px' });
    row.appendChild(formRow('Description', descI));
    row.appendChild(formRow('Qty', qtyI));
    row.appendChild(formRow('Rate (€)', rateI));
    row.appendChild(formRow('Total (€)', totalI));
    row.appendChild(el('div', { style: 'display:flex;align-items:flex-end;padding-bottom:1px' }, addBtn));

    preview.appendChild(row);
    preview.appendChild(manualList);
    renderManualList();
  };

  const refresh = async () => {
    const file = fileI.files?.[0];
    if (!file) return;
    manualItems = [];
    preview.textContent = 'Parsing…';
    try {
      const lines = await extractPDFLines(await file.arrayBuffer(), msg => { preview.textContent = msg; });
      parsed = parsePDFInvoice(lines, streamS.value);
      if (parsed.issueDate) dateI.value = parsed.issueDate;
      if (parsed.invoiceNumber) numI.value = parsed.invoiceNumber;
      preview.innerHTML = '';

      if (!parsed || parsed.lineItems.length === 0) {
        showManualEntry(lines);
        return;
      }

      const info = el('div', { style: 'font-size:12px;color:var(--text-muted);margin-bottom:8px' },
        `Date: ${parsed.issueDate || '—'}  ·  #: ${parsed.invoiceNumber || '—'}  ·  Client: ${parsed.clientName || '—'}  ·  ${parsed.lineItems.length} item(s)`
      );
      const tw = el('div', { class: 'table-wrap' });
      const t = el('table', { class: 'table' });
      t.innerHTML = '<thead><tr><th>Description</th><th class="right">Qty</th><th class="right">Rate</th><th class="right">Total</th></tr></thead>';
      const tb = el('tbody');
      for (const li of parsed.lineItems) {
        const tr = el('tr');
        tr.appendChild(el('td', {}, li.description));
        tr.appendChild(el('td', { class: 'right num' }, String(li.quantity)));
        tr.appendChild(el('td', { class: 'right num' }, `€ ${li.rate.toFixed(2)}`));
        tr.appendChild(el('td', { class: 'right num' }, `€ ${li.total.toFixed(2)}`));
        tb.appendChild(tr);
      }
      t.appendChild(tb); tw.appendChild(t);
      preview.appendChild(info);
      preview.appendChild(tw);
    } catch (e) { preview.textContent = 'Parse error: ' + e.message; }
  };

  fileI.onchange = refresh;
  streamS.onchange = refresh;

  const importBtn = button('Import', { variant: 'primary', onClick: () => {
    const items = (parsed?.lineItems?.length > 0) ? parsed.lineItems : manualItems;
    if (items.length === 0) { toast('No line items to import', 'warning'); return; }
    const issueDate = dateI.value || today();
    const invoiceNum = numI.value.trim();
    const total = items.reduce((s, l) => s + l.total, 0);
    const year = issueDate.slice(0, 4);
    const dup = (state.db.invoices || []).some(i =>
      i.source === 'pdf_import' && i.issueDate === issueDate && Math.abs(i.total - total) < 0.01
    );
    if (dup) { toast('Invoice already imported (same date & total)', 'warning'); return; }
    const inv = {
      id: newId('inv'),
      number: invoiceNum || String(nextInvoiceSequence(year, null)),
      clientId: clientS.value || '',
      owner: byId('clients', clientS.value)?.owner || 'you',
      issueDate,
      dueDate: issueDate,
      stream: streamS.value,
      currency: 'EUR',
      status: 'paid',
      lineItems: items.map(li => ({ id: newId('li'), description: li.description, quantity: li.quantity, unit: 'day', rate: li.rate, total: li.total })),
      subtotal: total, taxRate: 0, tax: 0, total,
      notes: 'Imported from PDF',
      source: 'pdf_import'
    };
    upsert('invoices', inv);
    toast('Invoice imported', 'success');
    closeModal();
    setTimeout(() => navigate('invoices'), 200);
  }});

  openModal({ title: 'Import Invoice PDF', body, footer: [button('Cancel', { onClick: closeModal }), importBtn], large: true });
}

async function extractPDFLines(arrayBuffer, onStatus) {
  const lib = window.pdfjsLib;
  if (!lib) throw new Error('PDF.js not loaded. Refresh the page and try again.');
  lib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
  const pdf = await lib.getDocument({ data: arrayBuffer }).promise;
  const allLines = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const byY = new Map();
    for (const item of content.items) {
      if (!item.str?.trim()) continue;
      const y = Math.round(item.transform[5]);
      if (!byY.has(y)) byY.set(y, []);
      byY.get(y).push({ x: item.transform[4], str: item.str });
    }
    [...byY.entries()].sort((a, b) => b[0] - a[0]).forEach(([, items]) => {
      const line = items.sort((a, b) => a.x - b.x).map(i => i.str).join(' ').trim();
      if (line) allLines.push(line);
    });
  }
  if (allLines.length > 0) return allLines;

  // No text operators found — PDF uses vector-path glyphs; fall back to OCR
  if (onStatus) onStatus('No selectable text found — running OCR (may take ~30s)…');
  return extractPDFLinesOCR(pdf, onStatus);
}

async function extractPDFLinesOCR(pdf, onStatus) {
  if (!window.Tesseract) throw new Error('Tesseract.js not loaded. Refresh the page and try again.');
  const worker = await window.Tesseract.createWorker('eng', 1, {
    logger: m => {
      if (onStatus && m.status === 'recognizing text') {
        onStatus(`OCR: ${Math.round((m.progress || 0) * 100)}%`);
      }
    }
  });
  const allLines = [];
  try {
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const viewport = page.getViewport({ scale: 2 });
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      const { data: { text } } = await worker.recognize(canvas);
      text.split('\n').forEach(line => { if (line.trim()) allLines.push(line.trim()); });
    }
  } finally {
    await worker.terminate();
  }
  return allLines;
}

function parsePDFInvoice(lines, fallbackStream = 'customer_success') {
  const SKIP = /^(description|days|rate|amount|subtotal|vat|total|reg\s*no|vat\s*no|address|make\s*all|beneficiary|iban|bic|swift|bank|account|sort\s*code)/i;
  let invoiceDate = '', invoiceNumber = '', clientName = '';
  let inTo = false;
  const lineItems = [];

  for (const line of lines) {
    // Invoice date
    if (!invoiceDate) {
      const dm = line.match(/(?:date|issued?)\s*[:\s]+(.+)/i);
      if (dm) { const d = new Date(dm[1].trim()); if (!isNaN(d)) invoiceDate = d.toISOString().slice(0, 10); }
    }
    // Invoice number
    if (!invoiceNumber) {
      const nm = line.match(/invoice\s*[#:]\s*(\S+)/i);
      if (nm) invoiceNumber = nm[1];
    }
    // Client name (first non-empty line after "TO:" or "BILL TO:")
    if (/^(?:bill\s+)?to:\s*$/i.test(line.trim())) { inTo = true; continue; }
    if (inTo && !clientName && line.trim()) { clientName = line.trim(); inTo = false; }

    if (SKIP.test(line.trim())) continue;

    // Try amounts with currency symbol first, then plain decimals for OCR output
    let amts = [...line.matchAll(/[-]?\s*[€£$]\s*([\d,]+\.?\d*)/g)];
    if (amts.length === 0) {
      // OCR fallback: match decimal numbers that look like money (e.g. 2,500.00 or 250.00)
      amts = [...line.matchAll(/\b(\d{1,3}(?:[,\s]\d{3})*[.,]\d{2})\b/g)].filter(m => {
        const n = parseFloat(m[1].replace(/[,\s]/g, ''));
        return !isNaN(n) && n >= 1;
      });
    }
    if (amts.length === 0) continue;

    const rawTotal = amts[amts.length - 1][1].replace(/[,\s]/g, '');
    const total = parseFloat(rawTotal);
    if (isNaN(total) || total <= 0) continue;
    const rawRate = amts.length >= 2 ? amts[amts.length - 2][1].replace(/[,\s]/g, '') : rawTotal;
    const rate = parseFloat(rawRate);

    let desc = line;
    for (const m of amts) desc = desc.replace(m[0], '');
    const qtyMatch = desc.match(/\b(\d{1,3}[.,]\d{2})\b/);
    const quantity = qtyMatch ? parseFloat(qtyMatch[1].replace(',', '.')) : 1;
    desc = desc.replace(/\b\d{1,3}[.,]\d{2}\b/g, '').replace(/\s+/g, ' ').trim();
    if (!desc || desc.length < 3) continue;

    lineItems.push({ description: desc, quantity, rate: isNaN(rate) ? total : rate, total });
  }

  return { invoiceDate, invoiceNumber, clientName, lineItems };
}
