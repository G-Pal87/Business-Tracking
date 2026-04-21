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
    const s = state.db.settings;
    const year = (issueI.value || today()).slice(0, 4);
    const owner = ownerS.value;
    const prefix = s.invoicePrefix?.[owner] || (owner === 'rita' ? 'RTA' : 'INV');
    const key = `${owner}_${year}`;
    const next = (s.invoiceCounters?.[key] || 0) + 1;
    numberI.placeholder = `Auto: ${prefix}-${year}-${String(next).padStart(3, '0')}`;
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
      const s = state.db.settings;
      if (!s.invoiceCounters) s.invoiceCounters = {};
      if (!s.invoicePrefix) s.invoicePrefix = {};
      const year = inv.issueDate.slice(0, 4);
      const prefix = s.invoicePrefix[inv.owner] || (inv.owner === 'rita' ? 'RTA' : 'INV');
      const counterKey = `${inv.owner}_${year}`;
      const nextSeq = (s.invoiceCounters[counterKey] || 0) + 1;
      const candidate = `${prefix}-${year}-${String(nextSeq).padStart(3, '0')}`;
      if ((state.db.invoices || []).some(i => i.id !== inv.id && i.number === candidate)) {
        toast(`Auto-generated number ${candidate} conflicts with an existing invoice`, 'danger');
        return;
      }
      s.invoiceCounters[counterKey] = nextSeq;
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
