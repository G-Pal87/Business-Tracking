// Company Structure — people management and dividend settings
import { state, markDirty } from '../core/state.js';
import { el, openModal, closeModal, confirmDialog, toast, select, input, formRow, button, textarea } from '../core/ui.js';
import { upsert, softDelete, listActive, newId, listActivePayments } from '../core/data.js';
import { PERSON_ROLES, DIVIDEND_METHODS } from '../core/config.js';

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

function getPeople() {
  return (state.db.people || []).filter(p => !p.deletedAt);
}

function getDividendSettings() {
  return state.db.settings?.dividendSettings || [];
}

function getRelatedRecordCount(person) {
  const key = person.legacyKey || person.id;
  const counts = {
    properties: listActive('properties').filter(r => r.owner === key).length,
    invoices:   listActive('invoices').filter(r => r.owner === key).length,
    clients:    listActive('clients').filter(r => r.owner === key).length,
    payments:   listActivePayments().filter(r => r.owner === key).length,
    dividends:  listActive('dividends').filter(r => r.recipient === key).length,
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
      <th>Name</th><th>Role</th><th>Share %</th><th>Phone</th><th>Email</th><th>Status</th><th></th>
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

  const saveBtn = button('Save', { variant: 'primary', onClick: () => {
    if (!nameI.value.trim()) { toast('Name required', 'danger'); return; }
    const newShare = ['partner', 'director'].includes(roleS.value) ? (Number(shareI.value) || 0) : null;
    if (newShare != null) {
      const othersTotal = getPeople()
        .filter(x => x.id !== p.id && ['partner', 'director'].includes(x.role) && x.sharePercent != null)
        .reduce((sum, x) => sum + x.sharePercent, 0);
      if (othersTotal + newShare > 100) {
        toast(`Share % exceeds 100% — others hold ${othersTotal}%, leaving ${(100 - othersTotal).toFixed(2)}% available`, 'danger');
        return;
      }
    }
    Object.assign(p, {
      name: nameI.value.trim(),
      role: roleS.value,
      sharePercent: newShare,
      phone: phoneI.value.trim(),
      email: emailI.value.trim(),
      active: activeChk.checked
    });
    upsert('people', p);
    toast('Saved', 'success');
    closeModal();
    onSave?.();
  }});

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
      const existing = getDividendSettings().find(s => s.year === yr);
      if (existing) {
        existing.method = methodS.value;
      } else {
        if (!state.db.settings.dividendSettings) state.db.settings.dividendSettings = [];
        state.db.settings.dividendSettings.push({ year: yr, method: methodS.value });
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
