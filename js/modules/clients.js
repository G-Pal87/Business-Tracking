// Clients module
import { state } from '../core/state.js';
import { el, openModal, closeModal, confirmDialog, toast, select, input, formRow, textarea, button, fmtDate, buildMultiSelect } from '../core/ui.js';
import { upsert, softDelete, listActive, newId, formatMoney, formatEUR, toEUR, byId } from '../core/data.js';
import { CURRENCIES, OWNERS, STREAMS, SERVICE_STREAMS } from '../core/config.js';
import { navigate } from '../core/router.js';
import { uploadGithubFile, deleteGithubFile, fetchGithubFile } from '../core/github.js';

// ── Document helpers (same pattern as properties.js) ─────────────────────────

function fmtSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result.split(',')[1]);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

async function previewDoc(doc) {
  const mime = doc.type || 'application/octet-stream';
  let b64;
  if (doc.path) {
    const file = await fetchGithubFile(doc.path);
    b64 = file.content.replace(/\n/g, '');
  } else {
    b64 = doc.data;
  }
  const byteChars = atob(b64);
  const bytes = new Uint8Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) bytes[i] = byteChars.charCodeAt(i);
  const blob = new Blob([bytes], { type: mime });
  window.open(URL.createObjectURL(blob), '_blank');
}

function docIcon(type) {
  if (!type) return '\u{1F4CE}';
  if (type.startsWith('image/')) return '\u{1F5BC}';
  if (type === 'application/pdf') return '\u{1F4C4}';
  if (type.includes('word')) return '\u{1F4DD}';
  if (type.includes('excel') || type.includes('spreadsheet')) return '\u{1F4CA}';
  return '\u{1F4CE}';
}

function sanitizeName(str) {
  return str.replace(/[/\\]/g, '-').trim();
}

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
  const streamFilter = new Set();
  const ownerFilter  = new Set();
  const streamMS = buildMultiSelect(SERVICE_STREAMS.map(s => ({ value: s, label: STREAMS[s].label, css: STREAMS[s].css })), streamFilter, 'All Streams', renderCards, 'cli_streams');
  const ownerMS  = buildMultiSelect(Object.entries(OWNERS).map(([v, l]) => ({ value: v, label: l })), ownerFilter, 'All Owners', renderCards, 'cli_owners');
  const resetFiltersBtn = button('Reset Filters', { variant: 'sm ghost', onClick: () => { streamMS.reset(); ownerMS.reset(); renderCards(); } });
  filterBar.appendChild(streamMS);
  filterBar.appendChild(ownerMS);
  filterBar.appendChild(resetFiltersBtn);
  filterBar.appendChild(el('div', { class: 'flex-1' }));
  filterBar.appendChild(button('+ Add Client', { variant: 'primary', onClick: () => openForm() }));
  wrap.appendChild(filterBar);

  const grid = el('div', { class: 'prop-grid' });
  wrap.appendChild(grid);

  function renderCards() {
    grid.innerHTML = '';
    let rows = [...listActive('clients')];
    if (streamFilter.size > 0) rows = rows.filter(r => streamFilter.has(r.stream));
    if (ownerFilter.size > 0)  rows = rows.filter(r => ownerFilter.has(r.owner));
    if (rows.length === 0) {
      grid.appendChild(el('div', { class: 'empty' }, 'No clients'));
      return;
    }
    for (const c of rows) grid.appendChild(card(c));
  }
  renderCards();
  return wrap;
}

function card(c) {
  const invs = listActive('invoices').filter(i => i.clientId === c.id);
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
  const invs = listActive('invoices').filter(i => i.clientId === id).sort((a, b) => (b.issueDate || '').localeCompare(a.issueDate));
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

  // Documents
  const docsViewCard = el('div', { class: 'card mb-16' });
  const docsTitleEl = el('div', { class: 'card-title' }, `Documents (${(c.documents || []).length})`);
  docsViewCard.appendChild(el('div', { class: 'card-header' },
    docsTitleEl,
    button('Manage', { onClick: () => { closeModal(); setTimeout(() => openForm(c), 220); } })
  ));
  const dl = el('div', { class: 'doc-list' });
  const renderDetailDocList = () => {
    dl.innerHTML = '';
    const currentDocs = c.documents || [];
    docsTitleEl.textContent = `Documents (${currentDocs.length})`;
    if (currentDocs.length === 0) {
      dl.appendChild(el('div', { class: 'doc-empty' }, 'No documents attached. Use Manage to upload.'));
      return;
    }
    for (const d of currentDocs) {
      const row = el('div', { class: 'doc-row' });
      row.appendChild(el('span', { class: 'doc-icon' }, docIcon(d.type)));
      row.appendChild(el('span', { class: 'doc-name', title: d.name }, d.name));
      row.appendChild(el('span', { class: 'doc-size' }, fmtSize(d.size)));
      if (d.uploadedAt) row.appendChild(el('span', { class: 'doc-date' }, fmtDate(d.uploadedAt.slice(0, 10))));
      row.appendChild(button('Preview', { variant: 'ghost', onClick: () => previewDoc(d) }));
      if (d.path) {
        row.appendChild(button('Delete', { variant: 'ghost', onClick: async () => {
          const ok = await confirmDialog(`Delete document "${d.name}"?`, { danger: true, okLabel: 'Delete' });
          if (!ok) return;
          try { await deleteGithubFile(d.path, null, `Remove document: ${d.name}`); }
          catch (e) { toast(`Repo cleanup failed: ${e.message}`, 'warning', 5000); }
          c.documents = (c.documents || []).filter(x => x.id !== d.id);
          upsert('clients', c);
          renderDetailDocList();
        }}));
      }
      dl.appendChild(row);
    }
  };
  renderDetailDocList();
  docsViewCard.appendChild(dl);
  body.appendChild(docsViewCard);

  const edit = button('Edit', { onClick: () => { closeModal(); setTimeout(() => openForm(c), 220); } });
  const del = button('Delete', { variant: 'danger', onClick: async () => {
    const ok = await confirmDialog(`Delete client ${c.name}?`, { danger: true, okLabel: 'Delete' });
    if (!ok) return;
    softDelete('clients', c.id);
    toast('Deleted', 'success');
    closeModal(); setTimeout(() => navigate('clients'), 200);
  }});
  openModal({ title: 'Client', body, footer: [del, edit], large: true });
}

function openForm(existing) {
  const c = existing ? { ...existing } : {
    id: newId('cli'),
    name: '', email: '', address: '', vatNumber: '', registrationNumber: '',
    currency: 'EUR',
    contractStart: new Date().toISOString().slice(0, 10),
    notes: ''
  };
  const body = el('div', {});
  const nameI = input({ value: c.name });
  const emailI = input({ value: c.email, type: 'email' });
  const addressI = input({ value: c.address });
  const vatI = input({ value: c.vatNumber, placeholder: 'e.g. HU12345678' });
  const regI = input({ value: c.registrationNumber, placeholder: 'e.g. 01-09-123456' });
  const currencyS = select(CURRENCIES, c.currency);
  const dateI = input({ type: 'date', value: c.contractStart });
  const notesT = textarea(); notesT.value = c.notes || '';

  body.appendChild(formRow('Name', nameI));
  body.appendChild(el('div', { class: 'form-row horizontal' }, formRow('Email', emailI), formRow('VAT Number', vatI)));
  body.appendChild(el('div', { class: 'form-row horizontal' }, formRow('Company Registration No.', regI)));
  body.appendChild(formRow('Address', addressI));
  body.appendChild(el('div', { class: 'form-row horizontal' }, formRow('Currency', currencyS), formRow('Contract Start', dateI)));
  body.appendChild(formRow('Notes', notesT));

  // Documents upload
  let pendingDocs = [...(c.documents || [])];
  const fileInput = el('input', {
    type: 'file',
    accept: '.pdf,.jpg,.jpeg,.png,.gif,.doc,.docx,.xls,.xlsx',
    multiple: true,
    style: 'display:none'
  });
  const docListEl = el('div', { class: 'doc-list', style: 'margin-top:8px' });
  const renderDocList = () => {
    docListEl.innerHTML = '';
    if (pendingDocs.length === 0) {
      docListEl.appendChild(el('div', { class: 'doc-empty' }, 'No documents yet.'));
      return;
    }
    for (const d of pendingDocs) {
      const row = el('div', { class: 'doc-row' });
      row.appendChild(el('span', { class: 'doc-icon' }, docIcon(d.type)));
      row.appendChild(el('span', { class: 'doc-name', title: d.name }, d.name));
      row.appendChild(el('span', { class: 'doc-size' }, fmtSize(d.size)));
      row.appendChild(el('button', {
        class: 'btn ghost sm', type: 'button', title: 'Remove',
        onClick: async () => {
          if (d.path) {
            try { await deleteGithubFile(d.path, null, `Remove document: ${d.name}`); }
            catch (e) { toast(`Repo cleanup failed: ${e.message}`, 'warning', 5000); }
          }
          pendingDocs = pendingDocs.filter(x => x.id !== d.id);
          renderDocList();
        }
      }, '✕'));
      docListEl.appendChild(row);
    }
  };
  renderDocList();
  const dropZone = el('div', { class: 'doc-drop-zone' }, 'Drop files here or click to browse');
  dropZone.onclick = () => fileInput.click();
  dropZone.ondragover = e => { e.preventDefault(); dropZone.classList.add('dragover'); };
  dropZone.ondragleave = () => dropZone.classList.remove('dragover');
  dropZone.ondrop = e => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    for (const file of [...e.dataTransfer.files]) {
      pendingDocs.push({ id: newId('doc'), name: file.name, type: file.type, size: file.size, uploadedAt: new Date().toISOString(), _file: file });
    }
    renderDocList();
  };
  fileInput.onchange = () => {
    for (const file of [...fileInput.files]) {
      pendingDocs.push({ id: newId('doc'), name: file.name, type: file.type, size: file.size, uploadedAt: new Date().toISOString(), _file: file });
    }
    renderDocList();
    fileInput.value = '';
  };
  const docsCard = el('div', { class: 'card mb-16' });
  docsCard.appendChild(fileInput);
  docsCard.appendChild(el('div', { class: 'card-header' },
    el('div', { class: 'card-title' }, 'Documents'),
    button('+ Upload', { variant: 'primary', onClick: () => fileInput.click() })
  ));
  docsCard.appendChild(dropZone);
  docsCard.appendChild(docListEl);
  body.appendChild(docsCard);

  const save = button('Save', { variant: 'primary', onClick: async () => {
    if (!nameI.value.trim()) { toast('Name required', 'danger'); return; }
    const clientName = nameI.value.trim();
    const safeClientName = sanitizeName(clientName);

    // Upload any pending new files to the repo; keep only metadata in db.json
    const docsToSave = [];
    for (const d of pendingDocs) {
      if (d._file) {
        const safeFileName = sanitizeName(d.name);
        const repoPath = `Clients/${safeClientName}/${safeFileName}`;
        try {
          const b64 = await readFileAsBase64(d._file);
          await uploadGithubFile(repoPath, b64, `Upload document: ${d.name}`);
          docsToSave.push({ id: d.id, name: d.name, type: d.type, size: d.size, uploadedAt: d.uploadedAt, path: repoPath, clientId: c.id });
        } catch (e) {
          toast(`Failed to upload ${d.name}: ${e.message}`, 'danger', 6000);
          return;
        }
      } else {
        const { _file, ...rest } = d;
        docsToSave.push(rest);
      }
    }

    Object.assign(c, {
      name: clientName,
      email: emailI.value.trim(),
      address: addressI.value.trim(),
      vatNumber: vatI.value.trim(),
      registrationNumber: regI.value.trim(),
      currency: currencyS.value,
      contractStart: dateI.value,
      notes: notesT.value.trim(),
      documents: docsToSave
    });
    upsert('clients', c);
    toast(existing ? 'Client updated' : 'Client added', 'success');
    closeModal();
    setTimeout(() => navigate('clients'), 200);
  }});
  const cancel = button('Cancel', { onClick: closeModal });
  openModal({ title: existing ? 'Edit Client' : 'New Client', body, footer: [cancel, save] });
}
