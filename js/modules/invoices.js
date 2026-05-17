// Invoices module - builder + repository
import { state } from '../core/state.js';
import { el, openModal, closeModal, confirmDialog, toast, select, selVals, input, formRow, textarea, button, fmtDate, today, addDays, drillDownModal, attachSortFilter, buildMultiSelect } from '../core/ui.js';
import { upsert, softDelete, listActive, byId, newId, formatMoney, formatEUR, toEUR } from '../core/data.js';
import { CURRENCIES, INVOICE_STATUSES, OWNERS, STREAMS, SERVICE_UNITS } from '../core/config.js';
import { downloadInvoicePDF, generateInvoicePDF } from '../core/pdf.js';
import { navigate } from '../core/router.js';
import { uploadGithubFile, fetchGithubFile, deleteGithubFile } from '../core/github.js';

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
  render(container) { container.appendChild(build()); scheduleMigration(); schedulePathMigration(); },
  refresh() { const c = document.getElementById('content'); c.innerHTML = ''; c.appendChild(build()); },
  destroy() {}
};

// Canonical repo path for an invoice PDF — always uses the UI invoice number as the filename.
function invoicePdfPath(inv) {
  const safe = (inv.number || inv.id).replace(/[/\\:*?"<>|#&%]/g, '_').replace(/\s+/g, '_');
  return `invoices/${safe}.pdf`;
}

async function deleteInvoiceFile(inv) {
  if (inv.pdfPath) {
    try { await deleteGithubFile(inv.pdfPath, null, `Delete PDF for invoice ${inv.number || inv.id}`); } catch { /* ignore */ }
  }
}

// ── One-time migration: move embedded pdfData → GitHub invoices/ folder ───────

let migrationScheduled = false;
function scheduleMigration() {
  if (migrationScheduled) return;
  const pending = (state.db.invoices || []).filter(i => i.pdfData && !i.pdfPath && !i.deletedAt);
  if (pending.length === 0) return;
  migrationScheduled = true;
  setTimeout(() => migrateEmbeddedPDFs(pending), 2000);
}

async function migrateEmbeddedPDFs(pending) {
  const { owner, repo, token } = state.github;
  if (!owner || !repo || !token) return;

  let done = 0;
  for (const inv of pending) {
    try {
      const pdfPath = invoicePdfPath(inv);
      await uploadGithubFile(pdfPath, inv.pdfData, `Migrate PDF for invoice ${inv.number || inv.id}`);
      const updated = { ...inv, pdfPath };
      delete updated.pdfData;
      upsert('invoices', updated);
      done++;
    } catch (err) {
      console.warn(`[PDF migrate] could not upload PDF for invoice ${inv.id}:`, err);
    }
  }

  if (done > 0) toast(`Migrated ${done} invoice PDF${done > 1 ? 's' : ''} to GitHub repository`, 'success', 5000);
}

// ── Retrospective migration: rename id-based paths → number-based paths ────────

let pathMigrationScheduled = false;
function schedulePathMigration() {
  if (pathMigrationScheduled) return;
  const { owner, repo, token } = state.github;
  if (!owner || !repo || !token) return;
  const pending = (state.db.invoices || []).filter(i => !i.deletedAt && i.pdfPath && i.pdfPath !== invoicePdfPath(i));
  if (pending.length === 0) return;
  pathMigrationScheduled = true;
  setTimeout(() => migrateInvoicePdfPaths(pending), 4000);
}

async function migrateInvoicePdfPaths(pending) {
  let done = 0;
  for (const inv of pending) {
    const correctPath = invoicePdfPath(inv);
    if (inv.pdfPath === correctPath) continue;
    console.log(`[PDF rename] ${inv.pdfPath} → ${correctPath}`);
    try {
      const fileData = await fetchGithubFile(inv.pdfPath);
      const b64 = fileData.content.replace(/\s/g, '');
      await uploadGithubFile(correctPath, b64, `Rename PDF: ${inv.number || inv.id}`);
      await deleteGithubFile(inv.pdfPath, fileData.sha, `Remove old path for invoice ${inv.number || inv.id}`);
      upsert('invoices', { ...inv, pdfPath: correctPath });
      done++;
    } catch (err) {
      console.warn(`[PDF rename] Could not rename ${inv.pdfPath} → ${correctPath}:`, err.message);
    }
  }
  if (done > 0) {
    toast(`Renamed ${done} invoice PDF${done > 1 ? 's' : ''} to use UI naming convention`, 'success', 5000);
    console.log(`[PDF rename] Complete: ${done} renamed`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────

// ── ZIP helpers ───────────────────────────────────────────────────────────────
function buildZipFilename(yearFilter, monthFilter, clientFilter, ownerFilter, statusFilter) {
  const parts = ['invoices'];
  if (yearFilter.size)   parts.push([...yearFilter].sort().join('-'));
  if (monthFilter.size)  parts.push('m' + [...monthFilter].sort().join('-'));
  if (statusFilter.size) parts.push([...statusFilter].sort().join('-'));
  if (ownerFilter.size)  parts.push([...ownerFilter].sort().join('-'));
  if (clientFilter.size) {
    const names = [...clientFilter]
      .map(id => byId('clients', id)?.name || id)
      .map(n => n.replace(/[^a-zA-Z0-9]/g, '').slice(0, 12));
    parts.push(names.join('-'));
  }
  const now = new Date();
  const ts = now.getFullYear().toString()
    + String(now.getMonth() + 1).padStart(2, '0')
    + String(now.getDate()).padStart(2, '0')
    + 'T'
    + String(now.getHours()).padStart(2, '0')
    + String(now.getMinutes()).padStart(2, '0')
    + String(now.getSeconds()).padStart(2, '0');
  parts.push(ts);
  return parts.join('_') + '.zip';
}

async function downloadInvoicesAsZip(invoices, zipFilename) {
  const JSZip = window.JSZip;
  if (!JSZip) { toast('ZIP library not loaded — refresh and try again', 'danger'); return; }

  const zip = new JSZip();
  let ok = 0, failed = 0;

  for (const inv of invoices) {
    const filename = `${(inv.number || inv.id).replace(/[/\\:*?"<>|]/g, '_')}.pdf`;
    try {
      const blob = await resolveInvoiceBlob(inv);
      zip.file(filename, blob);
      ok++;
    } catch (err) {
      console.warn(`[ZIP] Could not resolve PDF for ${inv.number || inv.id}:`, err.message);
      failed++;
    }
  }

  if (ok === 0) { toast('Could not generate any PDFs for the selected invoices', 'danger'); return; }
  if (failed > 0) toast(`${failed} invoice(s) could not be included — check the console for details`, 'warning', 5000);

  const content = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  const url = URL.createObjectURL(content);
  const a   = document.createElement('a');
  a.href     = url;
  a.download = zipFilename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  toast(`Downloaded ${ok} invoice PDF(s) as ${zipFilename}`, 'success', 4000);
}

function makeKpiCard(label, variant, onClick) {
  const valEl = el('div', { class: 'kpi-value', style: 'font-size:1.4rem' }, '—');
  const subEl = el('div', { class: 'kpi-trend' }, '');
  const node  = el('div', { class: 'kpi' + (variant ? ' ' + variant : ''), style: 'cursor:pointer' },
    el('div', { class: 'kpi-label' }, label),
    valEl, subEl,
    el('div', { class: 'kpi-accent-bar' })
  );
  node.onclick = onClick;
  return { node, valEl, subEl };
}

function build() {
  const wrap = el('div', { class: 'view active' });

  let filteredRows = [];
  const totalKpi   = makeKpiCard('Total Issued', null,      () => drillDownModal('All Invoices',          invDrillRows(filteredRows), INV_COLS));
  const paidKpi    = makeKpiCard('Paid',          'success', () => drillDownModal('Paid Invoices',          invDrillRows(filteredRows.filter(i => i.status === 'paid')), INV_COLS));
  const openKpi    = makeKpiCard('Outstanding',   'warning', () => drillDownModal('Outstanding Invoices',   invDrillRows(filteredRows.filter(i => i.status === 'sent')), INV_COLS));
  const overdueKpi = makeKpiCard('Overdue',       'danger',  () => drillDownModal('Overdue Invoices',       invDrillRows(filteredRows.filter(i => i.status === 'overdue')), INV_COLS));
  wrap.appendChild(el('div', { class: 'grid grid-4 mb-16' }, totalKpi.node, paidKpi.node, openKpi.node, overdueKpi.node));

  const bar = el('div', { class: 'flex gap-8 mb-16', style: 'flex-wrap:wrap' });
  const years = [...new Set(listActive('invoices').map(i => i.issueDate?.slice(0, 4)).filter(Boolean))].sort().reverse();
  const months = ['01','02','03','04','05','06','07','08','09','10','11','12'];
  const yearFilter   = new Set();
  const monthFilter  = new Set();
  const clientFilter = new Set();
  const ownerFilter  = new Set();
  const statusFilter = new Set();
  const yearMS   = buildMultiSelect(years.map(y => ({ value: y, label: y })), yearFilter, 'All Years', () => renderTable(), 'inv_years');
  const monthMS  = buildMultiSelect(months.map(m => ({ value: m, label: new Date(2000, Number(m)-1, 1).toLocaleDateString('en-US', { month: 'long' }) })), monthFilter, 'All Months', () => renderTable(), 'inv_months');
  const clientMS = buildMultiSelect(listActive('clients').map(c => ({ value: c.id, label: c.name })), clientFilter, 'All Clients', () => renderTable(), 'inv_clients');
  const ownerMS  = buildMultiSelect(Object.entries(OWNERS).filter(([k]) => k !== 'both').map(([v, l]) => ({ value: v, label: l })), ownerFilter, 'All Owners', () => renderTable(), 'inv_owners');
  const statusMS = buildMultiSelect(Object.entries(INVOICE_STATUSES).map(([v, m]) => ({ value: v, label: m.label, css: m.css })), statusFilter, 'All Statuses', () => renderTable(), 'inv_statuses');
  const resetFiltersBtn = button('Reset Filters', { variant: 'sm ghost', onClick: () => { yearMS.reset(); monthMS.reset(); clientMS.reset(); ownerMS.reset(); statusMS.reset(); renderTable(); } });
  bar.appendChild(yearMS);
  bar.appendChild(monthMS);
  bar.appendChild(clientMS);
  bar.appendChild(ownerMS);
  bar.appendChild(statusMS);
  bar.appendChild(resetFiltersBtn);
  let selected = new Set();

  const deleteSelBtn = button('', { variant: 'danger', onClick: async () => {
    const count = selected.size;
    if (!count) return;
    const ok = await confirmDialog(`Delete ${count} invoice(s)? This cannot be undone.`, { danger: true, okLabel: `Delete ${count}` });
    if (!ok) return;
    for (const id of [...selected]) softDelete('invoices', id);
    selected.clear();
    toast(`Deleted ${count} invoice(s)`, 'success');
    renderTable();
  }});
  deleteSelBtn.style.display = 'none';

  const downloadZipBtn = button('', { variant: 'ghost', onClick: async () => {
    const ids = [...selected];
    if (!ids.length) return;
    const invoicesToZip = ids.map(id => byId('invoices', id)).filter(Boolean);
    const zipName = buildZipFilename(yearFilter, monthFilter, clientFilter, ownerFilter, statusFilter);
    downloadZipBtn.disabled = true;
    downloadZipBtn.textContent = 'Preparing…';
    try {
      await downloadInvoicesAsZip(invoicesToZip, zipName);
    } finally {
      downloadZipBtn.disabled = false;
      syncBulkActions();
    }
  }});
  downloadZipBtn.style.display = 'none';

  bar.appendChild(el('div', { class: 'flex-1' }));
  bar.appendChild(downloadZipBtn);
  bar.appendChild(deleteSelBtn);
  bar.appendChild(button('Import PDF', { onClick: () => openPDFImport() }));
  bar.appendChild(button('+ New Invoice', { variant: 'primary', onClick: () => openBuilder() }));
  wrap.appendChild(bar);

  const tableWrap = el('div', { class: 'table-wrap' });
  wrap.appendChild(tableWrap);
  attachSortFilter(tableWrap);
  tableWrap.addEventListener('sf:filter', () => {
    const countEl = tableWrap.querySelector('.table-footer-count');
    const paidEl  = tableWrap.querySelector('.table-footer-paid');
    const totalEl = tableWrap.querySelector('.table-footer-total');
    if (!countEl || !totalEl) return;
    const vis = [...tableWrap.querySelectorAll('tbody tr')].filter(tr => tr.style.display !== 'none');
    const total = vis.reduce((s, tr) => s + parseFloat(tr.dataset.eur || 0), 0);
    const paid  = vis.filter(tr => tr.dataset.paid === '1').reduce((s, tr) => s + parseFloat(tr.dataset.eur || 0), 0);
    countEl.textContent = `${vis.length} invoice(s)`;
    if (paidEl) paidEl.textContent = formatEUR(paid);
    totalEl.textContent = formatEUR(total);
  });

  const syncBulkActions = () => {
    if (selected.size > 0) {
      deleteSelBtn.textContent = `Delete ${selected.size} Selected`;
      deleteSelBtn.style.display = '';
      downloadZipBtn.textContent = `Download ${selected.size} as ZIP`;
      downloadZipBtn.style.display = '';
    } else {
      deleteSelBtn.style.display = 'none';
      downloadZipBtn.style.display = 'none';
    }
  };

  const renderTable = () => {
    selected.clear();
    syncBulkActions();
    tableWrap.innerHTML = '';
    let rows = [...listActive('invoices')];
    if (yearFilter.size > 0)   rows = rows.filter(r => yearFilter.has(r.issueDate?.slice(0, 4)));
    if (monthFilter.size > 0)  rows = rows.filter(r => monthFilter.has(r.issueDate?.slice(5, 7)));
    if (clientFilter.size > 0) rows = rows.filter(r => clientFilter.has(r.clientId));
    if (ownerFilter.size > 0)  rows = rows.filter(r => ownerFilter.has(r.owner));
    if (statusFilter.size > 0) rows = rows.filter(r => statusFilter.has(r.status));
    rows.sort((a, b) => (b.issueDate || '').localeCompare(a.issueDate));

    // Update KPI cards to reflect current filter
    filteredRows = rows;
    const paidRows    = rows.filter(r => r.status === 'paid');
    const sentRows    = rows.filter(r => r.status === 'sent');
    const overdueRows = rows.filter(r => r.status === 'overdue');
    totalKpi.valEl.textContent   = formatEUR(rows.reduce((s, r) => s + toEUR(r.total, r.currency), 0));
    totalKpi.subEl.textContent   = `${rows.length} invoices`;
    paidKpi.valEl.textContent    = formatEUR(paidRows.reduce((s, r) => s + toEUR(r.total, r.currency), 0));
    paidKpi.subEl.textContent    = String(paidRows.length);
    openKpi.valEl.textContent    = formatEUR(sentRows.reduce((s, r) => s + toEUR(r.total, r.currency), 0));
    openKpi.subEl.textContent    = String(sentRows.length);
    overdueKpi.valEl.textContent = formatEUR(overdueRows.reduce((s, r) => s + toEUR(r.total, r.currency), 0));
    overdueKpi.subEl.textContent = String(overdueRows.length);

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
        syncBulkActions();
      };

      const tr = el('tr');
      tr.dataset.eur = String(toEUR(r.total, r.currency));
      tr.dataset.paid = r.status === 'paid' ? '1' : '0';
      const chkTd = el('td', { style: 'width:36px' }); chkTd.appendChild(chk);
      chkTd.onclick = e => e.stopPropagation();
      tr.appendChild(chkTd);
      const numTd = el('td', { style: 'font-weight:600' }, r.number);
      numTd.dataset.sort = String(parseInt((r.number || '').split('_')[0], 10) || r.number || '');
      tr.appendChild(numTd);
      tr.appendChild(el('td', {}, client?.name || '-'));
      tr.appendChild(el('td', {}, fmtDate(r.issueDate)));
      tr.appendChild(el('td', {}, fmtDate(r.dueDate)));
      tr.appendChild(el('td', {}, OWNERS[r.owner] || r.owner));
      tr.appendChild(el('td', {}, el('span', { class: `badge ${st.css}` }, st.label)));
      tr.appendChild(el('td', { class: 'right num' }, formatMoney(r.total, r.currency, { maxFrac: 0 })));
      const actions = el('td', { class: 'right flex gap-4', style: 'justify-content:flex-end' });
      actions.appendChild(button('View', { variant: 'sm ghost', onClick: (e) => { e.stopPropagation(); openPDFViewer(r); }}));
      actions.appendChild(button('PDF', { variant: 'sm ghost', onClick: (e) => {
        e.stopPropagation();
        if (r.source === 'pdf_import' && (r.pdfPath || r.pdfData)) downloadOriginalPDF(r); else downloadInvoicePDF(r);
      }}));
      actions.appendChild(button('Edit', { variant: 'sm ghost', onClick: (e) => { e.stopPropagation(); openBuilder(r); }}));
      actions.appendChild(button('Del', { variant: 'sm ghost', onClick: async (e) => {
        e.stopPropagation();
        const ok = await confirmDialog(`Delete ${r.number}?`, { danger: true, okLabel: 'Delete' });
        if (ok) { softDelete('invoices', r.id); toast('Deleted', 'success'); renderTable(); }
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
      syncBulkActions();
    };
    // Totals footer
    const totalEUR = rows.reduce((s, r) => s + toEUR(r.total, r.currency), 0);
    const paidEUR = paidRows.reduce((s, r) => s + toEUR(r.total, r.currency), 0);
    const paidSpan = el('span', { style: 'cursor:pointer', title: 'Drill down' });
    paidSpan.appendChild(document.createTextNode('Paid: '));
    paidSpan.appendChild(el('strong', { class: 'num table-footer-paid' }, formatEUR(paidEUR)));
    paidSpan.onclick = () => drillDownModal('Paid Invoices (filtered)', invDrillRows(paidRows), INV_COLS);
    const totalSpanEl = el('span', { style: 'cursor:pointer', title: 'Drill down' });
    totalSpanEl.appendChild(document.createTextNode('Total: '));
    totalSpanEl.appendChild(el('strong', { class: 'num table-footer-total' }, formatEUR(totalEUR)));
    totalSpanEl.onclick = () => drillDownModal('All Invoices (filtered)', invDrillRows(rows), INV_COLS);
    tableWrap.appendChild(el('div', { class: 'flex justify-between table-footer', style: 'padding:14px 16px;border-top:1px solid var(--border);font-size:13px;flex-wrap:wrap;gap:8px' },
      el('span', { class: 'muted table-footer-count' }, `${rows.length} invoice(s)`),
      el('div', { class: 'flex gap-16' }, paidSpan, totalSpanEl)
    ));
  };
  renderTable();
  return wrap;
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
  const clients = listActive('clients');
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
    const dateFmt = date.split('-').reverse().join('');
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
  const save = button('Save Invoice', { variant: 'primary', onClick: async () => {
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
      const dateFmt = inv.issueDate.split('-').reverse().join('');
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

    // Generate and upload PDF BEFORE upsert so the doSave debounce doesn't
    // race with the GitHub upload commit (two concurrent commits to the same
    // branch cause GitHub to cancel one of them).
    let pdfUploadStatus = null;
    if (inv.source !== 'pdf_import') {
      const pdfPath = invoicePdfPath(inv);
      const invLabel = inv.number || inv.id;
      const origText = save.textContent;
      save.disabled = true;
      save.textContent = 'Uploading PDF…';
      try {
        const pdfDoc = generateInvoicePDF(inv);
        const dataUri = pdfDoc.output('datauristring');
        const b64 = dataUri.split(',')[1];
        if (!b64) throw new Error('PDF generation produced empty content');
        await uploadGithubFile(pdfPath, b64, `${existing ? 'Update' : 'Create'} PDF for invoice ${invLabel}`);
        inv.pdfPath = pdfPath;
        pdfUploadStatus = 'success';
      } catch (err) {
        console.error('Invoice PDF upload failed:', err);
        pdfUploadStatus = err.message || 'unknown error';
      } finally {
        save.disabled = false;
        save.textContent = origText;
      }
    }

    // Single upsert — pdfPath is already set if upload succeeded
    upsert('invoices', inv);

    if (pdfUploadStatus === 'success') toast(`Invoice ${inv.number || inv.id} was successfully uploaded to the repo.`, 'success', 4000);
    else if (pdfUploadStatus) toast(`Invoice ${inv.number || inv.id} could not be uploaded to the repo.`, 'danger', 6000);
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

  // PDF attachment section (only for imported invoices)
  if (inv.source === 'pdf_import') {
    const hasFile = inv.pdfPath || inv.pdfData;
    const attachWrap = el('div', { style: 'margin-top:16px;padding:12px;background:var(--bg-elev-2);border-radius:var(--radius-sm);display:flex;gap:8px;align-items:center;flex-wrap:wrap' });
    const attachLabel = el('span', { style: 'font-size:13px;color:var(--text-muted);flex:1' },
      hasFile
        ? (inv.pdfPath ? `Attached: ${inv.pdfPath}` : 'Attached: embedded PDF (legacy)')
        : 'No PDF attached'
    );
    attachWrap.appendChild(attachLabel);

    if (hasFile) {
      attachWrap.appendChild(button('View PDF', { variant: 'sm', onClick: () => { closeModal(); setTimeout(() => openPDFViewer(inv), 200); } }));
      attachWrap.appendChild(button('Download', { variant: 'sm', onClick: () => downloadOriginalPDF(inv) }));
    }

    // Replace / upload button
    const replaceInput = el('input', { type: 'file', accept: '.pdf', style: 'display:none' });
    replaceInput.onchange = async () => {
      const file = replaceInput.files?.[0];
      if (!file) return;
      const replBtn = attachWrap.querySelector('.btn-replace');
      if (replBtn) { replBtn.disabled = true; replBtn.textContent = 'Uploading…'; }
      try {
        const b64 = await new Promise((res, rej) => {
          const r = new FileReader();
          r.onload  = () => res(r.result.split(',')[1]);
          r.onerror = rej;
          r.readAsDataURL(file);
        });
        // Delete old file from GitHub if it was stored there
        if (inv.pdfPath) {
          try { await deleteGithubFile(inv.pdfPath, null, `Replace PDF for invoice ${inv.number || inv.id}`); } catch { /* ignore */ }
        }
        const newPath = invoicePdfPath(inv);
        await uploadGithubFile(newPath, b64, `Upload PDF for invoice ${inv.number || inv.id}`);
        const updated = { ...inv, pdfPath: newPath };
        delete updated.pdfData;
        upsert('invoices', updated);
        toast('PDF replaced', 'success');
        closeModal();
      } catch (err) {
        toast(`Upload failed: ${err.message}`, 'danger');
      }
      if (replBtn) { replBtn.disabled = false; replBtn.textContent = hasFile ? 'Replace PDF' : 'Attach PDF'; }
    };
    const replBtn = button(hasFile ? 'Replace PDF' : 'Attach PDF', { variant: 'sm ghost' });
    replBtn.className += ' btn-replace';
    replBtn.onclick = () => replaceInput.click();
    attachWrap.appendChild(replaceInput);
    attachWrap.appendChild(replBtn);

    // Delete PDF button (only when a file is attached)
    if (hasFile) {
      const delPdfBtn = button('Remove PDF', { variant: 'sm ghost' });
      delPdfBtn.onclick = async () => {
        const ok = await confirmDialog('Remove the attached PDF from this invoice?', { danger: true, okLabel: 'Remove' });
        if (!ok) return;
        if (inv.pdfPath) {
          try { await deleteGithubFile(inv.pdfPath, null, `Remove PDF for invoice ${inv.number || inv.id}`); } catch { /* ignore */ }
        }
        const updated = { ...inv };
        delete updated.pdfPath;
        delete updated.pdfData;
        upsert('invoices', updated);
        toast('PDF removed', 'success');
        closeModal();
      };
      attachWrap.appendChild(delPdfBtn);
    }
    body.appendChild(attachWrap);
  }

  const pdfBtn = button('Download PDF', { variant: 'primary', onClick: () => {
    if (inv.source === 'pdf_import' && (inv.pdfPath || inv.pdfData)) downloadOriginalPDF(inv); else downloadInvoicePDF(inv);
  }});
  const closeBtn = button('Close', { onClick: closeModal });
  openModal({ title: `Invoice ${inv.number || 'Preview'}`, body, footer: [closeBtn, pdfBtn], large: true });
}

function escape(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ===== PDF Import =====
function openPDFImport() {
  const clients = listActive('clients');
  const body = el('div', {});
  const streamS = select([
    { value: 'customer_success',   label: 'Customer Success' },
    { value: 'marketing_services', label: 'Marketing Services' }
  ], 'customer_success');
  const clientS = select([{ value: '', label: '— No client —' }, ...clients.map(c => ({ value: c.id, label: c.name }))], clients[0]?.id || '');
  const fileI = el('input', { type: 'file', accept: '.pdf', class: 'input' });

  // Meta row — hidden until a file is chosen
  const metaWrap = el('div', { style: 'display:none;gap:12px;flex-wrap:wrap;margin-bottom:4px' });
  const dateI    = el('input', { type: 'date', class: 'input', value: today() });
  const dueDateI = el('input', { type: 'date', class: 'input', value: addDays(today(), 30) });
  const numI     = el('input', { type: 'text', class: 'input', placeholder: 'e.g. INV-001', style: 'width:180px' });
  metaWrap.appendChild(formRow('Invoice Date', dateI));
  metaWrap.appendChild(formRow('Due Date', dueDateI));
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

  const showManualEntry = (rawLines, statusMsg) => {
    preview.innerHTML = '';
    const msg = statusMsg ||
      (rawLines.length > 0
        ? 'Auto-parse found no items — enter them manually using the extracted text as reference:'
        : 'Could not extract text from this PDF. Fill in the line items below and click Import:');
    preview.appendChild(el('div', { style: 'color:var(--warning,#f59e0b);font-size:12px;margin-bottom:6px' }, msg));

    if (rawLines.length > 0) {
      const pre = el('pre', { style: 'font-size:11px;color:var(--text-muted);white-space:pre-wrap;max-height:120px;overflow:auto;background:var(--bg-elev-2);padding:8px;border-radius:4px;margin-bottom:12px' });
      pre.textContent = rawLines.slice(0, 60).join('\n');
      preview.appendChild(pre);
    }

    const descI = el('input', { type: 'text', class: 'input', placeholder: 'Service description', style: 'min-width:200px' });
    const qtyI = el('input', { type: 'number', class: 'input', value: '1', style: 'width:64px' });
    const rateI = el('input', { type: 'number', class: 'input', placeholder: '0.00', style: 'width:90px' });
    const totalI = el('input', { type: 'number', class: 'input', placeholder: '0.00', style: 'width:90px' });

    const calcTotal = () => {
      const q = parseFloat(qtyI.value) || 0, r = parseFloat(rateI.value) || 0;
      if (q > 0 && r > 0) totalI.value = (q * r).toFixed(2);
    };
    qtyI.oninput = calcTotal;
    rateI.oninput = calcTotal;

    const addBtn = button('+ Add Item', { onClick: () => {
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

    // Immediately: show meta fields and set invoice number from filename
    metaWrap.style.display = 'flex';
    const filenameBase = file.name.replace(/\.pdf$/i, '').trim();
    if (!numI.value || numI.value === numI.getAttribute('data-auto')) {
      numI.value = filenameBase;
      numI.setAttribute('data-auto', filenameBase);
    }

    parsed = null;
    manualItems = [];
    preview.textContent = 'Extracting text…';

    let lines = [];
    try {
      lines = await extractPDFLines(await file.arrayBuffer(), msg => { preview.textContent = msg; });
    } catch (e) {
      // Extraction failed entirely — go straight to manual entry
      showManualEntry([], 'Could not read this PDF. Fill in the invoice details below:');
      return;
    }

    try {
      parsed = parsePDFInvoice(lines, streamS.value);
    } catch (e) {
      parsed = { invoiceDate: '', invoiceNumber: '', clientName: '', lineItems: [] };
    }

    // Pre-fill meta from parsed data (but don't overwrite a user-edited field)
    if (parsed.invoiceDate) {
      dateI.value = parsed.invoiceDate;
      // Keep due date relative if user hasn't manually changed it
      if (!dueDateI.dataset.manual) dueDateI.value = addDays(parsed.invoiceDate, 30);
    }
    if (parsed.invoiceNumber) {
      numI.value = parsed.invoiceNumber;
      numI.setAttribute('data-auto', parsed.invoiceNumber);
    }

    preview.innerHTML = '';

    if (!parsed.lineItems.length) {
      showManualEntry(lines);
      return;
    }

    // Auto-parse succeeded — show preview table
    const info = el('div', { style: 'font-size:12px;color:var(--text-muted);margin-bottom:8px' },
      `Date: ${parsed.invoiceDate || '—'}  ·  #: ${parsed.invoiceNumber || '—'}  ·  Client: ${parsed.clientName || '—'}  ·  ${parsed.lineItems.length} item(s)`
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
  };

  dueDateI.addEventListener('input', () => { dueDateI.dataset.manual = '1'; });
  fileI.onchange = refresh;
  streamS.onchange = () => { if (fileI.files?.[0]) refresh(); };

  const importBtn = button('Import', { variant: 'primary', onClick: async () => {
    const items = (parsed?.lineItems?.length > 0) ? parsed.lineItems : manualItems;
    if (items.length === 0) { toast('Add at least one line item before importing', 'warning'); return; }
    const issueDate  = dateI.value || today();
    const dueDate    = dueDateI.value || addDays(issueDate, 30);
    const invoiceNum = numI.value.trim();
    const total = items.reduce((s, l) => s + l.total, 0);
    const year = issueDate.slice(0, 4);
    const dup = (state.db.invoices || []).some(i =>
      i.source === 'pdf_import' && i.issueDate === issueDate && Math.abs(i.total - total) < 0.01
    );
    if (dup) { toast('Invoice already imported (same date & total)', 'warning'); return; }

    const invId = newId('inv');
    const inv = {
      id: invId,
      number: invoiceNum || String(nextInvoiceSequence(year, null)),
      clientId: clientS.value || '',
      owner: byId('clients', clientS.value)?.owner || 'you',
      issueDate,
      dueDate,
      stream: streamS.value,
      currency: 'EUR',
      status: 'paid',
      lineItems: items.map(li => ({ id: newId('li'), description: li.description, quantity: li.quantity, unit: 'day', rate: li.rate, total: li.total })),
      subtotal: total, taxRate: 0, tax: 0, total,
      notes: 'Imported from PDF',
      source: 'pdf_import'
    };

    // Upload PDF to GitHub (preferred) — avoids storing large base64 in the DB / localStorage.
    const file = fileI.files?.[0];
    if (file) {
      importBtn.disabled = true;
      importBtn.textContent = 'Uploading…';
      try {
        const b64 = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload  = () => resolve(reader.result.split(',')[1]);
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });
        const pdfPath = invoicePdfPath(inv);
        await uploadGithubFile(pdfPath, b64, `Upload invoice PDF ${inv.number || inv.id}`);
        inv.pdfPath = pdfPath;
      } catch (err) {
        // GitHub not configured or upload failed — warn but still save the record.
        console.warn('PDF upload to GitHub failed:', err);
        toast(`PDF not saved to GitHub: ${err.message}. Invoice saved without attachment.`, 'warning', 6000);
      }
      importBtn.disabled = false;
      importBtn.textContent = 'Import';
    }

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
    workerPath: 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/worker.min.js',
    langPath: 'https://tessdata.projectnaptha.com/4.0.0',
    corePath: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@5/tesseract-core-simd-lstm.wasm.js',
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
      // OCR fallback: negative lookbehind stops "400.00" matching inside "13,400.00"
      amts = [...line.matchAll(/(?<![,\d])(\d{1,3}(?:,\d{3})+\.\d{2}|\d+\.\d{2})(?!\d)/g)]
        .filter(m => parseFloat(m[1].replace(/,/g, '')) >= 1);
    }
    if (amts.length === 0) continue;

    const rawTotal = amts[amts.length - 1][1].replace(/,/g, '');
    const total = parseFloat(rawTotal);
    if (isNaN(total) || total <= 0) continue;
    const rawRate = amts.length >= 2 ? amts[amts.length - 2][1].replace(/,/g, '') : rawTotal;
    const rate = parseFloat(rawRate);

    // Remove amount spans right-to-left to preserve earlier indices
    let desc = line;
    for (const m of [...amts].sort((a, b) => b.index - a.index)) {
      desc = desc.slice(0, m.index) + desc.slice(m.index + m[0].length);
    }
    const qtyMatch = desc.match(/\b(\d{1,3}[.,]\d{2})\b/);
    const quantity = qtyMatch ? parseFloat(qtyMatch[1].replace(',', '.')) : 1;
    desc = desc.replace(/\b\d{1,3}[.,]\d{2}\b/g, '').replace(/\s+/g, ' ').trim();
    if (!desc || desc.length < 3) continue;

    lineItems.push({ description: desc, quantity, rate: isNaN(rate) ? total : rate, total });
  }

  return { invoiceDate, invoiceNumber, clientName, lineItems };
}

// ===== PDF viewer / download helpers =====

function b64toBlob(b64, mimeType = 'application/pdf') {
  const bytes = atob(b64);
  const arr = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
  return new Blob([arr], { type: mimeType });
}

async function resolveInvoiceBlob(inv) {
  if (inv.pdfPath) {
    const data = await fetchGithubFile(inv.pdfPath);
    const b64  = (data.content || '').replace(/\s/g, '');
    return b64toBlob(b64);
  }
  if (inv.pdfData) return b64toBlob(inv.pdfData);
  return generateInvoicePDF(inv).output('blob');
}

async function downloadOriginalPDF(inv) {
  try {
    const blob = await resolveInvoiceBlob(inv);
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `${inv.number || 'invoice'}.pdf`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (err) {
    toast(`Download failed: ${err.message}`, 'danger');
  }
}

async function openPDFViewer(inv) {
  const hasAttached = inv.pdfPath || inv.pdfData;
  const titleLabel  = `Invoice ${inv.number || 'Preview'}`;

  // Loading placeholder while we fetch
  const frame = el('iframe', { style: 'width:100%;height:70vh;border:none;display:block' });
  const loadMsg = el('div', { style: 'padding:24px;text-align:center;color:var(--text-muted)' }, 'Loading PDF…');
  const bodyWrap = el('div', {}, hasAttached ? loadMsg : frame);

  const dlBtn = button('Download', { variant: 'primary', onClick: () => downloadOriginalPDF(inv) });
  const { close } = openModal({ title: titleLabel, body: bodyWrap, footer: [button('Close', { onClick: () => close() }), dlBtn], large: true });

  let objectUrl = null;
  const cleanup = () => { if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; } };

  if (hasAttached) {
    try {
      const blob  = await resolveInvoiceBlob(inv);
      objectUrl   = URL.createObjectURL(blob);
      frame.src   = objectUrl;
      bodyWrap.replaceChildren(frame);
    } catch (err) {
      bodyWrap.replaceChildren(el('div', { style: 'padding:24px;color:var(--danger,#ef4444)' }, `Could not load PDF: ${err.message}`));
    }
  } else {
    // Generated invoice — render immediately
    try {
      const blob = generateInvoicePDF(inv).output('blob');
      objectUrl  = URL.createObjectURL(blob);
      frame.src  = objectUrl;
    } catch (err) {
      bodyWrap.replaceChildren(el('div', { style: 'padding:24px;color:var(--danger,#ef4444)' }, `Could not render invoice: ${err.message}`));
    }
  }

  // Revoke object URL when modal is dismissed
  const overlay = document.getElementById('modal-overlay');
  if (overlay) overlay.addEventListener('click', cleanup, { once: true });
  document.addEventListener('keydown', function esc(e) { if (e.key === 'Escape') { cleanup(); document.removeEventListener('keydown', esc); } });
}
