// Company Structure — people management and dividend settings
import { state, markDirty } from '../core/state.js';
import { el, openModal, closeModal, confirmDialog, toast, select, input, formRow, button, textarea } from '../core/ui.js';
import { upsert, softDelete, listActive, newId, listActivePayments } from '../core/data.js';
import { PERSON_ROLES, DIVIDEND_METHODS } from '../core/config.js';
import { uploadGithubBytesEncrypted, deleteGithubFile, fetchGithubFileEncrypted } from '../core/github.js';
import { openFileSafely, base64ToBytes, prepareUploadFiles, prepTrackerForButton, storagePathWithExt, fmtFileSize } from '../core/files.js';

export default {
  id: 'company-structure',
  label: 'Company Structure',
  icon: '🏢',
  render(container) { container.appendChild(buildView()); },
  refresh() {
    const c = document.getElementById('content');
    if (!c) return;
    c.innerHTML = '';
    c.appendChild(buildView());
  },
  destroy() {}
};

// ── Helpers ───────────────────────────────────────────────────────────────────

// Personal documents (passport, ID, tax, bank…) — same storage as property
// and client documents: encrypted in the browser (AES-GCM, bound to the path)
// before upload, stored on the data branch as People/{person id}/{doc id}.{ext}
// with only metadata (name, type, size) in db.json.
async function previewDoc(doc) {
  try {
    const file = await fetchGithubFileEncrypted(doc.path);
    // The stored doc.type is never trusted for the preview: see core/files.js.
    const how = openFileSafely(base64ToBytes(file.content), doc.name || 'document');
    if (how === 'download') toast('This file type can’t be previewed safely, so it was downloaded instead.', 'info');
  } catch (e) {
    toast('Could not open document: ' + e.message, 'danger');
  }
}

function docIcon(type) {
  if (!type) return '\u{1F4CE}';
  if (type.startsWith('image/')) return '\u{1F5BC}';
  if (type === 'application/pdf') return '\u{1F4C4}';
  if (type.includes('word')) return '\u{1F4DD}';
  if (type.includes('excel') || type.includes('spreadsheet')) return '\u{1F4CA}';
  return '\u{1F4CE}';
}

function getPeople() {
  return (state.db.people || []).filter(p => !p.deletedAt);
}

function getDividendSettings() {
  return state.db.settings?.dividendSettings || [];
}

function getRelatedRecordCount(person) {
  const key = person.legacyKey || person.id;
  // Dividends always store the literal 'giorgos'/'rita' recipient strings
  // (see analytics-personal.js's `person === 'you' ? 'giorgos' : 'rita'`
  // translation), while Giorgos's own legacyKey is 'you' — translate the
  // same way here so his dividend count isn't silently always 0.
  const dividendKey = key === 'you' ? 'giorgos' : key;
  const counts = {
    properties: listActive('properties').filter(r => r.owner === key).length,
    invoices:   listActive('invoices').filter(r => r.owner === key).length,
    clients:    listActive('clients').filter(r => r.owner === key).length,
    payments:   listActivePayments().filter(r => r.owner === key).length,
    // Expenses use the same owner-key convention as properties/invoices/etc.
    // for property-linked records (properties.js's generateOwnerRentExpenses)
    // and separately a personId field for person-associated expenses
    // (expenses.js) — both use getPeopleOwners()'s legacyKey||id values, so
    // both are checked here.
    expenses:   listActive('expenses').filter(r => r.owner === key || r.personId === key).length,
    dividends:  listActive('dividends').filter(r => r.recipient === dividendKey).length,
    // Time-off engagements always store the person's real db id (see
    // time-off.js's ensureDefaultEngagement/openEngagementForm), not the
    // legacyKey||id convention the fields above use.
    engagements: (state.db.settings?.engagements || []).filter(en => en.personId === person.id).length,
    // Their own documents: removing the person would orphan the files.
    documents: (person.documents || []).length,
  };
  const total = Object.values(counts).reduce((s, v) => s + v, 0);
  return { total, counts };
}

function rebuildView() {
  const c = document.getElementById('content');
  if (!c) return;
  c.innerHTML = '';
  c.appendChild(buildView());
}

// ── People section ────────────────────────────────────────────────────────────

function buildPeopleCard() {
  const card = el('div', { class: 'card mb-16' });

  const addBtn = button('+ Add Person', { variant: 'primary', onClick: () => openPersonForm(null) });
  card.appendChild(el('div', { class: 'card-header' },
    el('div', {},
      el('div', { class: 'card-title' }, 'People'),
      el('div', { class: 'card-subtitle' }, 'Directors, partners, employees and assistants')
    ),
    addBtn
  ));

  const body = el('div', { style: 'padding:0 0 8px' });
  card.appendChild(body);

  const renderBody = () => {
    body.innerHTML = '';
    const people = getPeople();
    if (people.length === 0) {
      body.appendChild(el('div', { class: 'empty' }, 'No people added yet'));
      return;
    }

    const t = el('table', { class: 'table' });
    t.innerHTML = `<thead><tr>
      <th>Name</th><th>Role</th><th>Share %</th><th>Phone</th><th>Email</th><th>Documents</th><th>Status</th><th></th>
    </tr></thead>`;
    const tb = el('tbody');

    for (const p of people) {
      const roleMeta = PERSON_ROLES[p.role] || { label: p.role, color: '#8b93b0' };
      const tr = el('tr');
      tr.appendChild(el('td', {},
        el('span', { style: 'font-weight:600' }, p.name),
        p.legacyKey ? el('span', { style: 'font-size:10px;color:var(--text-muted);margin-left:6px' }, `(${p.legacyKey})`) : null
      ));
      tr.appendChild(el('td', {},
        el('span', { class: 'badge', style: `background:${roleMeta.color}22;color:${roleMeta.color};border:1px solid ${roleMeta.color}44` }, roleMeta.label)
      ));
      tr.appendChild(el('td', {}, ['partner', 'director'].includes(p.role) && p.sharePercent != null ? `${p.sharePercent}%` : '—'));
      tr.appendChild(el('td', { style: 'color:var(--text-muted);font-size:12px' }, p.phone || '—'));
      tr.appendChild(el('td', { style: 'color:var(--text-muted);font-size:12px' }, p.email || '—'));
      const nDocs = (p.documents || []).length;
      tr.appendChild(el('td', { style: 'font-size:12px' }, nDocs ? `\u{1F4CE} ${nDocs}` : '—'));
      tr.appendChild(el('td', {},
        el('span', { class: `badge ${p.active !== false ? 'success' : ''}` }, p.active !== false ? 'Active' : 'Inactive')
      ));
      const acts = el('td', { class: 'right' });
      acts.appendChild(button('Edit', { variant: 'sm ghost', onClick: () => openPersonForm(p, renderBody) }));
      if (!p.legacyKey) {
        const { total, counts } = getRelatedRecordCount(p);
        if (total > 0) {
          const lines = Object.entries(counts).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}`).join(', ');
          const delBtn = button('Del', { variant: 'sm ghost' });
          delBtn.disabled = true;
          delBtn.title = `Cannot delete — linked to: ${lines}`;
          delBtn.style.cssText = 'opacity:0.35;cursor:not-allowed';
          acts.appendChild(delBtn);
        } else {
          acts.appendChild(button('Del', { variant: 'sm ghost', onClick: async () => {
            const ok = await confirmDialog(`Remove ${p.name}? This cannot be undone.`, { danger: true, okLabel: 'Remove' });
            if (ok) { softDelete('people', p.id); toast('Removed', 'success'); renderBody(); }
          }}));
        }
      }
      tr.appendChild(acts);
      tb.appendChild(tr);
    }
    t.appendChild(tb);
    body.appendChild(el('div', { class: 'table-wrap' }, t));
  };

  renderBody();
  addBtn.onclick = () => openPersonForm(null, renderBody);
  return card;
}

function openPersonForm(existing, onSave) {
  const isEdit = !!existing;
  const p = existing ? { ...existing } : {
    id: newId('ppl'), name: '', role: 'employee',
    sharePercent: 0, phone: '', email: '', active: true
  };

  const body = el('div', {});
  const nameI      = input({ value: p.name, placeholder: 'Full name' });
  const roleS      = select(Object.entries(PERSON_ROLES).map(([v, m]) => ({ value: v, label: m.label })), p.role);
  const shareI     = input({ type: 'number', value: p.sharePercent ?? 0, min: 0, max: 100, step: 0.01, style: 'width:100%' });
  const phoneI     = input({ value: p.phone || '', placeholder: '+357 99 000000' });
  const emailI     = input({ type: 'email', value: p.email || '', placeholder: 'name@company.com' });
  const activeChk  = el('input', { type: 'checkbox' });
  activeChk.checked = p.active !== false;

  const othersTotal = getPeople()
    .filter(x => x.id !== p.id && ['partner', 'director'].includes(x.role) && x.sharePercent != null)
    .reduce((sum, x) => sum + x.sharePercent, 0);
  const available = 100 - othersTotal;
  const shareHint = `Ownership % for dividends — max available: ${available.toFixed(available % 1 === 0 ? 0 : 2)}%`;

  const shareRow = el('div', {});
  shareRow.appendChild(formRow('Share %', shareI, shareHint));

  const updateShareVis = () => {
    shareRow.style.display = ['partner', 'director'].includes(roleS.value) ? '' : 'none';
  };
  roleS.onchange = updateShareVis;
  updateShareVis();

  body.appendChild(formRow('Full Name', nameI));
  body.appendChild(formRow('Role', roleS));
  body.appendChild(shareRow);
  body.appendChild(el('div', { class: 'form-row horizontal' }, formRow('Phone', phoneI), formRow('Email', emailI)));
  body.appendChild(formRow('Status', el('label', { style: 'display:flex;align-items:center;gap:8px;cursor:pointer' }, activeChk, el('span', {}, 'Active'))));

  // ── Documents ──
  // Folders are metadata only (person.docFolders: { id, name, parentId }, and
  // doc.folderId), kept inside the encrypted db.json. Stored files keep their
  // ID-only paths, so folder names never appear in the public repository and
  // creating, renaming or moving never re-uploads a file.
  // Copies: moving a document between folders must not touch the stored
  // record until Save (Cancel really cancels).
  let pendingDocs = (p.documents || []).map(d => ({ ...d }));
  let pendingFolders = (p.docFolders || []).map(f => ({ ...f }));
  // Removals are deferred to Save, so Cancel really cancels.
  let pendingRemovals = [];
  let curFolder = null; // null = top level
  const MAX_FOLDER_DEPTH = 6;
  const folderById = id => pendingFolders.find(f => f.id === id) || null;
  const folderChain = id => { const out = []; for (let f = folderById(id); f && out.length < 20; f = folderById(f.parentId)) out.unshift(f); return out; };
  const folderPathLabel = id => id ? folderChain(id).map(f => f.name).join(' / ') : 'Top level';
  const childFolders = parentId => pendingFolders.filter(f => (f.parentId || null) === parentId).sort((a, b) => a.name.localeCompare(b.name));
  const docsIn = folderId => pendingDocs.filter(d => (d.folderId || null) === folderId);
  // A folder and everything below it (for "can't move a folder into itself").
  const descendantIds = id => { const ids = new Set([id]); let grew = true; while (grew) { grew = false; for (const f of pendingFolders) if (f.parentId && ids.has(f.parentId) && !ids.has(f.id)) { ids.add(f.id); grew = true; } } return ids; };
  // Documents whose folder no longer exists show at the top level.
  for (const d of pendingDocs) if (d.folderId && !folderById(d.folderId)) d.folderId = null;

  const fileInput = el('input', { type: 'file', accept: '.pdf,.jpg,.jpeg,.png,.gif,.webp,.heic,.doc,.docx,.xls,.xlsx', multiple: true, style: 'display:none' });
  const crumbsEl = el('div', { style: 'display:flex;flex-wrap:wrap;align-items:center;gap:4px;font-size:13px;margin:8px 0' });
  const folderBar = el('div', { style: 'display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-bottom:6px' });
  const docListEl = el('div', { class: 'doc-list', style: 'margin-top:4px' });

  const cleanName = v => String(v || '').trim().replace(/\s+/g, ' ').slice(0, 60);
  const nameTaken = (name, parentId, exceptId) => pendingFolders.some(f => f.id !== exceptId && (f.parentId || null) === parentId && f.name.toLowerCase() === name.toLowerCase());

  // Inline name editor (the form is already a modal, so no nested dialog).
  const inlineNameEditor = (initial, onOk) => {
    const inp = input({ value: initial, placeholder: 'Folder name', style: 'width:200px' });
    const wrap = el('span', { style: 'display:inline-flex;gap:4px;align-items:center' });
    const ok = () => { const v = cleanName(inp.value); if (v) onOk(v); };
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); ok(); } if (e.key === 'Escape') { e.preventDefault(); renderDocs(); } });
    wrap.append(inp, button('OK', { variant: 'sm primary', onClick: ok }), button('Cancel', { variant: 'sm ghost', onClick: () => renderDocs() }));
    setTimeout(() => inp.focus(), 0);
    return wrap;
  };

  const renderDocs = () => {
    // Breadcrumbs
    crumbsEl.innerHTML = '';
    const crumb = (label, id, isLast) => isLast
      ? el('strong', {}, label)
      : el('a', { href: '#', onClick: e => { e.preventDefault(); curFolder = id; renderDocs(); } }, label);
    const chain = folderChain(curFolder);
    crumbsEl.appendChild(el('span', {}, '\u{1F4C1} '));
    crumbsEl.appendChild(crumb('All documents', null, chain.length === 0));
    chain.forEach((f, i) => { crumbsEl.appendChild(el('span', { style: 'color:var(--text-muted)' }, ' / ')); crumbsEl.appendChild(crumb(f.name, f.id, i === chain.length - 1)); });

    // Folder actions for the current folder
    folderBar.innerHTML = '';
    const depth = chain.length;
    if (depth < MAX_FOLDER_DEPTH) {
      folderBar.appendChild(button('+ New folder', { variant: 'sm ghost', onClick: () => {
        folderBar.innerHTML = '';
        folderBar.appendChild(inlineNameEditor('', name => {
          if (nameTaken(name, curFolder)) { toast('A folder with that name already exists here', 'warning'); return; }
          pendingFolders.push({ id: newId('fld'), name, parentId: curFolder });
          renderDocs();
        }));
      }}));
    }
    if (curFolder) {
      const cur = folderById(curFolder);
      folderBar.appendChild(button('Rename folder', { variant: 'sm ghost', onClick: () => {
        folderBar.innerHTML = '';
        folderBar.appendChild(inlineNameEditor(cur.name, name => {
          if (nameTaken(name, cur.parentId || null, cur.id)) { toast('A folder with that name already exists here', 'warning'); return; }
          cur.name = name; renderDocs();
        }));
      }}));
      // Move the current folder (and its contents) somewhere else.
      const blocked = descendantIds(cur.id);
      const targets = [{ value: '', label: 'Top level' }, ...pendingFolders
        .filter(f => !blocked.has(f.id) && folderChain(f.id).length < MAX_FOLDER_DEPTH)
        .map(f => ({ value: f.id, label: folderPathLabel(f.id) }))
        .sort((a, b) => a.label.localeCompare(b.label))];
      const moveFolderS = select([{ value: '__', label: 'Move folder to…' }, ...targets], '__', { style: 'width:auto;font-size:12px' });
      moveFolderS.onchange = () => {
        if (moveFolderS.value === '__') return;
        const parentId = moveFolderS.value || null;
        if (nameTaken(cur.name, parentId, cur.id)) { toast('A folder with that name already exists there', 'warning'); renderDocs(); return; }
        cur.parentId = parentId; renderDocs();
      };
      folderBar.appendChild(moveFolderS);
      folderBar.appendChild(button('Delete folder', { variant: 'sm ghost', onClick: () => {
        if (childFolders(cur.id).length || docsIn(cur.id).length) { toast('Move or remove what is inside the folder first', 'warning'); return; }
        pendingFolders = pendingFolders.filter(f => f.id !== cur.id);
        curFolder = cur.parentId || null; renderDocs();
      }}));
    }

    // Contents: subfolders, then documents
    docListEl.innerHTML = '';
    const subs = childFolders(curFolder);
    const docs = docsIn(curFolder);
    for (const f of subs) {
      const nInside = docsIn(f.id).length + childFolders(f.id).length;
      const row = el('div', { class: 'doc-row', style: 'cursor:pointer', onClick: () => { curFolder = f.id; renderDocs(); } });
      row.appendChild(el('span', { class: 'doc-icon' }, '\u{1F4C1}'));
      row.appendChild(el('span', { class: 'doc-name', title: f.name, style: 'font-weight:600' }, f.name));
      row.appendChild(el('span', { class: 'doc-size' }, nInside ? `${nInside} item${nInside === 1 ? '' : 's'}` : 'empty'));
      docListEl.appendChild(row);
    }
    if (!subs.length && !docs.length) {
      docListEl.appendChild(el('div', { class: 'doc-empty' }, curFolder ? 'This folder is empty. Upload files here or move documents into it.' : 'No documents yet.'));
    }
    const moveTargets = [{ value: '', label: 'Top level' }, ...pendingFolders
      .map(f => ({ value: f.id, label: folderPathLabel(f.id) }))
      .sort((a, b) => a.label.localeCompare(b.label))];
    for (const d of docs) {
      const row = el('div', { class: 'doc-row' });
      row.appendChild(el('span', { class: 'doc-icon' }, docIcon(d.type)));
      row.appendChild(el('span', { class: 'doc-name', title: d.name }, d.name));
      row.appendChild(el('span', { class: 'doc-size' }, d.size ? fmtFileSize(d.size) : ''));
      if (pendingFolders.length) {
        const mv = select([{ value: '__', label: 'Move to…' }, ...moveTargets.filter(t => t.value !== (d.folderId || ''))], '__', { style: 'width:auto;font-size:12px', title: 'Move to folder' });
        mv.onchange = () => { if (mv.value === '__') return; d.folderId = mv.value || null; renderDocs(); };
        row.appendChild(mv);
      }
      if (d.path) row.appendChild(button('Preview', { variant: 'sm ghost', onClick: () => previewDoc(d) }));
      row.appendChild(el('button', {
        class: 'btn ghost sm', type: 'button', title: 'Remove',
        onClick: () => {
          if (d.path) pendingRemovals.push({ path: d.path, name: d.name });
          pendingDocs = pendingDocs.filter(x => x.id !== d.id);
          renderDocs();
        }
      }, '✕'));
      docListEl.appendChild(row);
    }
  };
  renderDocs();
  // Over-limit files are refused and photos shrunk/stripped (core/files.js);
  // Save waits for files still being prepared. New files go into the folder
  // that is open when they are picked.
  let prep = null;
  const addPendingFiles = files => {
    const targetFolder = curFolder;
    return prep.track((async () => {
      for (const file of await prepareUploadFiles(files, (msg, kind) => toast(msg, kind, 6000))) {
        pendingDocs.push({ id: newId('doc'), name: file.name, type: file.type, size: file.size, uploadedAt: new Date().toISOString(), folderId: targetFolder, _file: file });
      }
      renderDocs();
    })());
  };
  const dropZone = el('div', { class: 'doc-drop-zone' }, 'Drop files here or click to browse (they go into the open folder)');
  dropZone.onclick = () => fileInput.click();
  dropZone.ondragover = e => { e.preventDefault(); dropZone.classList.add('dragover'); };
  dropZone.ondragleave = () => dropZone.classList.remove('dragover');
  dropZone.ondrop = e => { e.preventDefault(); dropZone.classList.remove('dragover'); addPendingFiles([...e.dataTransfer.files]); };
  fileInput.onchange = () => { addPendingFiles([...fileInput.files]); fileInput.value = ''; };
  const docsCard = el('div', { class: 'card', style: 'margin-top:12px' });
  docsCard.appendChild(fileInput);
  docsCard.appendChild(el('div', { class: 'card-header' },
    el('div', {},
      el('div', { class: 'card-title' }, 'Documents'),
      el('div', { class: 'card-subtitle' }, 'Passport, ID, tax, bank… Encrypted before upload; folder names stay inside the encrypted data. Visible to everyone who can sign in to the app.')
    ),
    button('+ Upload', { variant: 'primary', onClick: () => fileInput.click() })
  ));
  docsCard.appendChild(crumbsEl);
  docsCard.appendChild(folderBar);
  docsCard.appendChild(docListEl);
  docsCard.appendChild(dropZone);
  body.appendChild(docsCard);

  const saveBtn = button('Save', { variant: 'primary', onClick: async () => {
    // dataset.saving: the preparation tracker must not re-enable Save mid-save.
    if (saveBtn.disabled || saveBtn.dataset.saving) return;
    saveBtn.dataset.saving = '1';
    saveBtn.disabled = true;
    try { await doSave(); }
    finally { delete saveBtn.dataset.saving; saveBtn.disabled = !!saveBtn.dataset.preparing; }
  }});
  prep = prepTrackerForButton(saveBtn);

  async function doSave() {
    await prep.idle();
    if (!nameI.value.trim()) { toast('Name required', 'danger'); return; }
    const newShare = ['partner', 'director'].includes(roleS.value) ? (Number(shareI.value) || 0) : null;
    if (newShare != null) {
      if (newShare < 0) { toast('Share % cannot be negative', 'danger'); return; }
      const othersTotal = getPeople()
        .filter(x => x.id !== p.id && ['partner', 'director'].includes(x.role) && x.sharePercent != null)
        .reduce((sum, x) => sum + x.sharePercent, 0);
      if (othersTotal + newShare > 100) {
        toast(`Share % exceeds 100% — others hold ${othersTotal}%, leaving ${(100 - othersTotal).toFixed(2)}% available`, 'danger');
        return;
      }
    }
    // Upload new files (only ids + a short real extension reach the public
    // path; encrypted uploads refuse to run while the key is locked).
    const docsToSave = [];
    for (const d of pendingDocs) {
      if (!d._file) { docsToSave.push(d); continue; }
      const repoPath = storagePathWithExt(`People/${p.id}/${d.id}`, d.name, d.type);
      try {
        await uploadGithubBytesEncrypted(repoPath, new Uint8Array(await d._file.arrayBuffer()), 'Update file');
      } catch (e) {
        // Nothing deleted yet; earlier uploads in this save are kept for a retry.
        toast(`Failed to upload ${d.name}: ${e.message}`, 'danger', 6000);
        return;
      }
      const meta = { id: d.id, name: d.name, type: d.type, size: d.size, uploadedAt: d.uploadedAt, path: repoPath, folderId: d.folderId || null };
      docsToSave.push(meta);
      const idx = pendingDocs.indexOf(d);
      if (idx !== -1) pendingDocs[idx] = meta; // a retry doesn't re-upload it
    }
    Object.assign(p, {
      name: nameI.value.trim(),
      role: roleS.value,
      sharePercent: newShare,
      phone: phoneI.value.trim(),
      email: emailI.value.trim(),
      active: activeChk.checked,
      documents: docsToSave,
      docFolders: pendingFolders
    });
    upsert('people', p);
    // Only now that the record no longer references them, delete removed files.
    const removals = pendingRemovals;
    pendingRemovals = [];
    for (const rem of removals) {
      try { await deleteGithubFile(rem.path, null, 'Delete file'); }
      catch (e) { toast(`Repo cleanup failed for ${rem.name}: ${e.message}`, 'warning', 5000); }
    }
    toast('Saved', 'success');
    closeModal();
    onSave?.();
  }

  openModal({
    title: isEdit ? `Edit — ${existing.name}` : 'Add Person',
    body,
    footer: [button('Cancel', { onClick: closeModal }), saveBtn]
  });
}

// ── Dividend Settings section ─────────────────────────────────────────────────

function buildDividendSettingsCard() {
  const card = el('div', { class: 'card mb-16' });

  const chevron = el('span', { class: 'card-toggle-chevron' }, '▶');
  const header = el('div', { class: 'card-header card-header--toggle' },
    el('div', {},
      el('div', { class: 'card-title' }, 'Dividend Method (per Year)'),
      el('div', { class: 'card-subtitle' }, 'How dividend allocations are calculated — can vary year to year')
    ),
    el('div', { style: 'display:flex;align-items:center;gap:8px' }, chevron)
  );
  card.appendChild(header);

  const body = el('div', { class: 'card-collapsible-body', style: 'display:none' });
  card.appendChild(body);

  header.addEventListener('click', () => {
    const open = body.style.display !== 'none';
    body.style.display = open ? 'none' : '';
    chevron.classList.toggle('open', !open);
  });

  const renderBody = () => {
    body.innerHTML = '';

    const settings = getDividendSettings().slice().sort((a, b) => b.year - a.year);

    const addYearForm = el('div', { style: 'display:flex;gap:8px;align-items:flex-end;margin-bottom:16px' });
    const yearI = input({ type: 'number', value: new Date().getFullYear(), min: 2000, max: 2100, style: 'width:90px' });
    const methodS = select(
      Object.entries(DIVIDEND_METHODS).map(([v, m]) => ({ value: v, label: m.label })),
      'fixed_rate'
    );
    const addBtn = button('Add / Update', { variant: 'primary sm', onClick: () => {
      const yr = Number(yearI.value) | 0;
      if (!yr || yr < 2000) { toast('Enter a valid year', 'danger'); return; }
      // dividendSettings entries are keyed by year, not id, so they don't go
      // through upsert() — stamp the same who/when metadata by hand instead
      // of leaving this the only collection with no audit trail at all.
      const now = Date.now();
      const actor = state.session?.username || 'system';
      const existing = getDividendSettings().find(s => s.year === yr);
      if (existing) {
        existing.method = methodS.value;
        existing.updatedAt = now;
        existing.updatedBy = actor;
      } else {
        if (!state.db.settings.dividendSettings) state.db.settings.dividendSettings = [];
        state.db.settings.dividendSettings.push({ year: yr, method: methodS.value, createdAt: now, createdBy: actor, updatedAt: now, updatedBy: actor });
      }
      markDirty();
      toast(`${yr} dividend method saved`, 'success');
      renderBody();
    }});
    addYearForm.appendChild(formRow('Year', yearI));
    addYearForm.appendChild(formRow('Method', methodS));
    addYearForm.appendChild(el('div', { style: 'padding-bottom:2px' }, addBtn));
    body.appendChild(addYearForm);

    if (settings.length === 0) {
      body.appendChild(el('div', { class: 'empty' }, 'No year-specific settings. Add a year above.'));
      return;
    }

    const t = el('table', { class: 'table' });
    t.innerHTML = `<thead><tr><th>Year</th><th>Method</th><th></th></tr></thead>`;
    const tb = el('tbody');
    for (const s of settings) {
      const methodLabel = DIVIDEND_METHODS[s.method]?.label || s.method;
      const tr = el('tr');
      tr.appendChild(el('td', { style: 'font-weight:600' }, String(s.year)));
      tr.appendChild(el('td', {}, methodLabel));
      const acts = el('td', { class: 'right' });
      acts.appendChild(button('Del', { variant: 'sm ghost', onClick: async () => {
        const ok = await confirmDialog(`Remove ${s.year} dividend setting?`, { danger: true, okLabel: 'Remove' });
        if (!ok) return;
        state.db.settings.dividendSettings = (state.db.settings.dividendSettings || []).filter(x => x.year !== s.year);
        markDirty();
        renderBody();
      }}));
      tr.appendChild(acts);
      tb.appendChild(tr);
    }
    t.appendChild(tb);
    body.appendChild(el('div', { class: 'table-wrap' }, t));

    body.appendChild(el('div', { style: 'margin-top:12px;font-size:12px;color:var(--text-muted);padding:8px 12px;background:var(--bg-elev-1);border-radius:4px;line-height:1.6' },
      'Fixed Rate: dividends are split proportionally to each partner\'s share percentage. ' +
      'Acquired Revenue: dividends are split based on revenue each partner/director personally generated during the year.'
    ));
  };

  renderBody();
  return card;
}

// ── Staff directory section ───────────────────────────────────────────────────

function buildStaffDirectoryCard() {
  const card = el('div', { class: 'card mb-16' });

  const chevron = el('span', { class: 'card-toggle-chevron' }, '▶');
  const header = el('div', { class: 'card-header card-header--toggle' },
    el('div', {},
      el('div', { class: 'card-title' }, 'Staff Directory'),
      el('div', { class: 'card-subtitle' }, 'Quick reference for contact details')
    ),
    chevron
  );
  card.appendChild(header);

  const body = el('div', { class: 'card-collapsible-body', style: 'display:none' });
  card.appendChild(body);

  header.addEventListener('click', () => {
    const open = body.style.display !== 'none';
    body.style.display = open ? 'none' : '';
    chevron.classList.toggle('open', !open);
  });

  const people = getPeople().filter(p => p.active !== false);
  if (people.length === 0) {
    body.appendChild(el('div', { class: 'empty' }, 'No active people found'));
  } else {
    const grid = el('div', { style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px;padding:8px 0' });
    for (const p of people) {
      const roleMeta = PERSON_ROLES[p.role] || { label: p.role || '—', color: '#8b93b0' };
      const card2 = el('div', {
        style: `border:1px solid var(--border);border-radius:8px;padding:14px;border-top:3px solid ${roleMeta.color}`
      });
      card2.appendChild(el('div', { style: 'font-size:14px;font-weight:700;margin-bottom:4px' }, p.name));
      card2.appendChild(el('div', { style: `font-size:11px;font-weight:600;color:${roleMeta.color};text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px` }, roleMeta.label));
      if (p.phone) {
        const row = el('div', { style: 'font-size:12px;color:var(--text-muted);margin-bottom:3px' });
        row.appendChild(el('span', { style: 'margin-right:6px' }, '📞'));
        const a = document.createElement('a');
        a.href = `tel:${p.phone}`;
        a.textContent = p.phone;
        a.style.cssText = 'color:var(--primary,#3b82f6);text-decoration:none';
        row.appendChild(a);
        card2.appendChild(row);
      }
      if (p.email) {
        const row = el('div', { style: 'font-size:12px;color:var(--text-muted)' });
        row.appendChild(el('span', { style: 'margin-right:6px' }, '✉'));
        const a = document.createElement('a');
        a.href = `mailto:${p.email}`;
        a.textContent = p.email;
        a.style.cssText = 'color:var(--primary,#3b82f6);text-decoration:none;word-break:break-all';
        row.appendChild(a);
        card2.appendChild(row);
      }
      if (['partner', 'director'].includes(p.role) && p.sharePercent != null) {
        card2.appendChild(el('div', { style: 'font-size:11px;color:var(--text-muted);margin-top:6px' }, `Share: ${p.sharePercent}%`));
      }
      grid.appendChild(card2);
    }
    body.appendChild(grid);
  }

  return card;
}

// ── Main view ─────────────────────────────────────────────────────────────────

function buildView() {
  const wrap = el('div', { class: 'view active' });

  wrap.appendChild(el('div', { style: 'margin-bottom:16px' },
    el('h2', { style: 'margin:0 0 4px;font-size:20px;font-weight:700' }, 'Company Structure'),
    el('p',  { style: 'margin:0;font-size:13px;color:var(--text-muted)' },
      'People · Roles · Shares · Dividend Settings · Staff Directory')
  ));

  wrap.appendChild(buildPeopleCard());
  wrap.appendChild(buildDividendSettingsCard());
  wrap.appendChild(buildStaffDirectoryCard());

  return wrap;
}
