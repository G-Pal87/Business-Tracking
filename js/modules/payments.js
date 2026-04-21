// Payments module: manual payments, LT rental schedule, Airbnb CSV import
import { state } from '../core/state.js';
import { el, openModal, closeModal, confirmDialog, toast, select, selVals, input, formRow, textarea, button, fmtDate, today } from '../core/ui.js';
import { upsert, remove, byId, newId, formatMoney, formatEUR, toEUR, generatePaymentSchedule } from '../core/data.js';
import { CURRENCIES, PAYMENT_STATUSES, STREAMS } from '../core/config.js';
import { navigate } from '../core/router.js';

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

  const tabs = el('div', { class: 'tabs' });
  const allSection = el('div', {});
  const scheduleSection = el('div', { style: 'display:none' });
  const upcomingSection = el('div', { style: 'display:none' });

  const sections = [allSection, scheduleSection, upcomingSection];
  const tabEls = [
    el('div', { class: 'tab active' }, 'All Payments'),
    el('div', { class: 'tab' }, 'Rent Schedule'),
    el('div', { class: 'tab' }, 'Upcoming')
  ];
  tabEls.forEach((t, i) => {
    t.onclick = () => {
      tabEls.forEach(x => x.classList.remove('active')); t.classList.add('active');
      sections.forEach((s, j) => { s.style.display = j === i ? '' : 'none'; });
      if (i === 1 && !scheduleSection.dataset.built) { scheduleSection.dataset.built = '1'; buildScheduleSection(scheduleSection); }
      if (i === 2 && !upcomingSection.dataset.built) { upcomingSection.dataset.built = '1'; buildUpcomingSection(upcomingSection); }
    };
    tabs.appendChild(t);
  });

  wrap.appendChild(tabs);
  sections.forEach(s => wrap.appendChild(s));

  buildAllPayments(allSection);
  return wrap;
}

function buildAllPayments(wrap) {
  const filterBar = el('div', { class: 'flex gap-8 mb-16', style: 'flex-wrap:wrap' });
  const propSel   = select([{ value: 'all', label: 'All Properties' }, ...(state.db.properties || []).map(p => ({ value: p.id, label: p.name }))], 'all');
  const statusSel = select(Object.entries(PAYMENT_STATUSES).map(([v, m]) => ({ value: v, label: m.label })), [], { multiple: true, title: 'Ctrl+click to select multiple statuses' });
  const streamSel = select([{ value: 'all', label: 'All Streams' }, ...Object.entries(STREAMS).filter(([k]) => k.includes('rental')).map(([v, m]) => ({ value: v, label: m.short }))], 'all');

  let selected = new Set();

  const deleteSelBtn = button('', { variant: 'danger', onClick: async () => {
    const count = selected.size;
    if (!count) return;
    const ok = await confirmDialog(`Delete ${count} payment(s)? This cannot be undone.`, { danger: true, okLabel: `Delete ${count}` });
    if (!ok) return;
    for (const id of [...selected]) remove('payments', id);
    selected.clear();
    toast(`Deleted ${count} payment(s)`, 'success');
    renderTable();
  }});
  deleteSelBtn.style.display = 'none';

  filterBar.appendChild(propSel);
  filterBar.appendChild(statusSel);
  filterBar.appendChild(streamSel);
  filterBar.appendChild(el('div', { class: 'flex-1' }));
  filterBar.appendChild(deleteSelBtn);
  filterBar.appendChild(button('Import Airbnb CSV', { onClick: () => openCSVImport() }));
  filterBar.appendChild(button('Export CSV', { onClick: () => exportCSV() }));
  filterBar.appendChild(button('+ Add Payment', { variant: 'primary', onClick: () => openForm() }));
  wrap.appendChild(filterBar);

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

    let rows = [...(state.db.payments || [])];
    const statuses = selVals(statusSel);
    if (propSel.value !== 'all') rows = rows.filter(r => r.propertyId === propSel.value);
    if (statuses) rows = rows.filter(r => statuses.includes(r.status));
    if (streamSel.value !== 'all') rows = rows.filter(r => r.stream === streamSel.value);
    rows.sort((a, b) => (b.date || '').localeCompare(a.date));

    if (rows.length === 0) {
      tableWrap.appendChild(el('div', { class: 'empty' }, 'No payments match your filters'));
      return;
    }

    const t = el('table', { class: 'table' });

    // Header with select-all checkbox
    const selectAllChk = el('input', { type: 'checkbox', style: 'cursor:pointer' });
    const htr = el('tr', {});
    const chkTh = el('th', { style: 'width:36px' });
    chkTh.appendChild(selectAllChk);
    htr.appendChild(chkTh);
    ['Date', 'Property', 'Type', 'Source', 'Status'].forEach(h => htr.appendChild(el('th', {}, h)));
    htr.appendChild(el('th', { class: 'right' }, 'Amount'));
    htr.appendChild(el('th', { class: 'right' }, 'EUR'));
    htr.appendChild(el('th', {}));
    const thead = el('thead', {}); thead.appendChild(htr); t.appendChild(thead);

    const tb = el('tbody');
    const rowChks = [];

    for (const r of rows) {
      const prop  = byId('properties', r.propertyId);
      const sMeta = PAYMENT_STATUSES[r.status] || { label: r.status, css: '' };

      const chk = el('input', { type: 'checkbox', style: 'cursor:pointer' });
      rowChks.push(chk);
      chk.onchange = () => {
        if (chk.checked) selected.add(r.id); else selected.delete(r.id);
        const n = rowChks.filter(c => c.checked).length;
        selectAllChk.indeterminate = n > 0 && n < rows.length;
        selectAllChk.checked = n === rows.length;
        syncDeleteBtn();
      };

      const tr = el('tr');
      const chkTd = el('td', { style: 'width:36px' }); chkTd.appendChild(chk);
      tr.appendChild(chkTd);
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

    selectAllChk.onchange = () => {
      rowChks.forEach(c => { c.checked = selectAllChk.checked; });
      selectAllChk.indeterminate = false;
      if (selectAllChk.checked) rows.forEach(r => selected.add(r.id)); else selected.clear();
      syncDeleteBtn();
    };

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
}

function recordRentPayment(prop, entry, onDone) {
  upsert('payments', {
    id: newId('pay'),
    propertyId: prop.id,
    amount: entry.amount,
    currency: entry.currency,
    date: entry.date,
    type: 'rental',
    status: 'paid',
    source: 'manual',
    stream: 'long_term_rental',
    notes: `Rent ${entry.monthKey}`
  });
  toast('Payment recorded', 'success');
  if (onDone) onDone();
}

function buildScheduleSection(wrap) {
  const ltProps = (state.db.properties || []).filter(p => p.type === 'long_term');
  if (ltProps.length === 0) {
    wrap.appendChild(el('div', { class: 'empty' }, 'No long-term rental properties configured'));
    return;
  }

  const propSel = select(ltProps.map(p => ({ value: p.id, label: p.name })), ltProps[0].id);
  const showUnpaidOnly = el('label', { class: 'flex gap-8', style: 'align-items:center;cursor:pointer;font-size:13px' });
  const unpaidChk = el('input', { type: 'checkbox' });
  showUnpaidOnly.appendChild(unpaidChk);
  showUnpaidOnly.appendChild(document.createTextNode('Unpaid only'));

  const bar = el('div', { class: 'flex gap-8 mb-16', style: 'align-items:center' });
  bar.appendChild(propSel);
  bar.appendChild(el('div', { class: 'flex-1' }));
  bar.appendChild(showUnpaidOnly);
  wrap.appendChild(bar);

  const kpiRow = el('div', { class: 'grid grid-4 mb-16' });
  wrap.appendChild(kpiRow);

  const tableWrap = el('div', { class: 'table-wrap' });
  wrap.appendChild(tableWrap);

  const render = () => {
    const prop = byId('properties', propSel.value);
    if (!prop) return;
    const schedule = generatePaymentSchedule(prop);
    const now = new Date();
    const thisMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    const paidThisYear = schedule.filter(s => s.paid && s.monthKey.startsWith(String(now.getFullYear())));
    const overdue = schedule.filter(s => s.overdue);
    const upcoming = schedule.filter(s => !s.paid && !s.overdue);
    const next = upcoming[0];
    const daysToNext = next ? Math.ceil((new Date(next.date) - now) / 86400000) : null;

    kpiRow.innerHTML = '';
    kpiRow.appendChild(kpiCard('Paid This Year', String(paidThisYear.length), `${formatEUR(paidThisYear.reduce((s, e) => s + e.amountEUR, 0))}`, 'success'));
    kpiRow.appendChild(kpiCard('Overdue', String(overdue.length), overdue.length ? formatEUR(overdue.reduce((s, e) => s + e.amountEUR, 0)) : '—', overdue.length ? 'danger' : ''));
    kpiRow.appendChild(kpiCard('Upcoming', String(upcoming.length), upcoming.length ? formatEUR(upcoming.reduce((s, e) => s + e.amountEUR, 0)) : '—', ''));
    kpiRow.appendChild(kpiCard('Next Due', next ? fmtDate(next.date) : '—', daysToNext !== null ? (daysToNext <= 0 ? 'Today!' : daysToNext === 1 ? 'Tomorrow' : `In ${daysToNext} days`) : '—', daysToNext !== null && daysToNext <= 3 ? 'warning' : ''));

    tableWrap.innerHTML = '';
    let rows = schedule;
    if (unpaidChk.checked) rows = rows.filter(s => !s.paid);
    if (rows.length === 0) { tableWrap.appendChild(el('div', { class: 'empty' }, 'No entries')); return; }

    const t = el('table', { class: 'table' });
    t.innerHTML = `<thead><tr>
      <th>Due Date</th><th>Month</th>
      <th class="right">Amount</th><th>Cur.</th>
      <th>Status</th><th></th>
    </tr></thead>`;
    const tb = el('tbody');

    for (const s of rows) {
      const isThisMonth = s.monthKey === thisMonthKey;
      const tr = el('tr');

      const closeOtherEdits = () => {
        tb.querySelectorAll('tr.row-editing').forEach(r => r.dispatchEvent(new CustomEvent('cancel-edit')));
      };

      const renderViewRow = () => {
        tr.innerHTML = '';
        tr.classList.remove('row-editing');
        tr.style.background = isThisMonth && !s.paid ? 'rgba(99,102,241,0.04)' : '';

        tr.appendChild(el('td', {}, fmtDate(s.date)));
        tr.appendChild(el('td', { class: 'muted' }, s.monthKey));
        tr.appendChild(el('td', { class: 'right num' }, formatMoney(s.amount, s.currency, { maxFrac: 0 })));
        tr.appendChild(el('td', { class: 'muted', style: 'font-size:12px' }, s.currency));
        tr.appendChild(el('td', {},
          s.paid ? el('span', { class: 'badge success' }, 'Paid')
          : s.overdue ? el('span', { class: 'badge danger' }, 'Overdue')
          : isThisMonth ? el('span', { class: 'badge warning' }, 'Due this month')
          : el('span', { class: 'badge' }, 'Upcoming')
        ));
        const td = el('td', { class: 'right', style: 'white-space:nowrap' });
        if (!s.paid) {
          td.appendChild(button('Mark Paid', { variant: 'sm primary', onClick: () => recordRentPayment(prop, s, render) }));
        }
        td.appendChild(button('Edit', { variant: 'sm ghost', onClick: () => { closeOtherEdits(); renderEditRow(); } }));
        tr.appendChild(td);
      };

      const renderEditRow = () => {
        tr.innerHTML = '';
        tr.classList.add('row-editing');
        tr.style.background = '';

        const linked = s.linkedPaymentId
          ? (state.db.payments || []).find(p => p.id === s.linkedPaymentId) || null
          : null;

        const dateI = el('input', {
          type: 'date', class: 'input',
          value: linked?.date || s.date,
          style: 'min-width:130px;width:100%'
        });
        const amtI = el('input', {
          type: 'number', class: 'input',
          value: String(linked?.amount ?? s.amount),
          min: '0', step: '0.01',
          style: 'min-width:80px;width:100%'
        });
        const curS = el('select', { class: 'select', style: 'width:100%' });
        for (const c of CURRENCIES) {
          const o = el('option', { value: c }, c);
          if (c === (linked?.currency || s.currency)) o.selected = true;
          curS.appendChild(o);
        }

        const statusOpts = [
          { value: 'paid', label: 'Paid' },
          { value: 'pending', label: 'Pending' }
        ];
        if (s.linkedPaymentId) statusOpts.push({ value: 'revert', label: 'Revert to Scheduled' });
        const currentStatus = linked?.status === 'paid' ? 'paid' : linked ? 'pending' : 'pending';
        const statusS = el('select', { class: 'select', style: 'width:100%' });
        for (const o of statusOpts) {
          const opt = el('option', { value: o.value }, o.label);
          if (o.value === currentStatus) opt.selected = true;
          statusS.appendChild(opt);
        }

        const notesI = el('input', {
          type: 'text', class: 'input',
          value: linked?.notes || `Rent ${s.monthKey}`,
          placeholder: 'Notes',
          style: 'width:100%;margin-bottom:6px'
        });

        tr.addEventListener('cancel-edit', renderViewRow);

        const saveBtn = button('Save', { variant: 'sm primary', onClick: () => {
          const newDate = dateI.value;
          const newAmt  = Number(amtI.value);
          const newCur  = curS.value;
          const newStat = statusS.value;
          const newNotes = notesI.value.trim() || `Rent ${s.monthKey}`;

          if (!newDate) { toast('Date is required', 'danger'); return; }
          if (newAmt <= 0) { toast('Amount must be greater than zero', 'danger'); return; }

          if (newStat === 'revert') {
            if (s.linkedPaymentId) remove('payments', s.linkedPaymentId);
            toast('Payment record removed — row reverted to scheduled state', 'success');
          } else {
            const pay = linked ? { ...linked } : {
              id: newId('pay'),
              propertyId: prop.id,
              stream: 'long_term_rental',
              source: 'manual',
              type: 'rental'
            };
            Object.assign(pay, { amount: newAmt, currency: newCur, date: newDate, status: newStat, notes: newNotes });
            upsert('payments', pay);
            toast(`Payment ${linked ? 'updated' : 'recorded'} as ${newStat}`, 'success');
          }
          render();
        }});

        const cancelBtn = button('Cancel', { variant: 'sm ghost', onClick: renderViewRow });

        // Col 1: date | Col 2: month (static) | Col 3: amount | Col 4: currency | Col 5: status | Col 6: notes + buttons
        tr.appendChild(el('td', {}, dateI));
        tr.appendChild(el('td', { class: 'muted', style: 'font-size:11px;white-space:nowrap' }, s.monthKey));
        tr.appendChild(el('td', {}, amtI));
        tr.appendChild(el('td', {}, curS));
        tr.appendChild(el('td', {}, statusS));
        const lastTd = el('td', {});
        lastTd.appendChild(notesI);
        const btnRow = el('div', { class: 'flex gap-4', style: 'justify-content:flex-end' });
        btnRow.appendChild(cancelBtn);
        btnRow.appendChild(saveBtn);
        lastTd.appendChild(btnRow);
        tr.appendChild(lastTd);
      };

      renderViewRow();
      tb.appendChild(tr);
    }

    t.appendChild(tb);
    tableWrap.appendChild(t);

    const totalEUR = rows.reduce((s, e) => s + e.amountEUR, 0);
    tableWrap.appendChild(el('div', { class: 'flex justify-between', style: 'padding:14px 16px;border-top:1px solid var(--border);font-size:13px' },
      el('span', { class: 'muted' }, `${prop.tenantName ? prop.tenantName + ' · ' : ''}${rows.length} month(s) shown`),
      el('strong', { class: 'num' }, `Total: ${formatEUR(totalEUR)}`)
    ));
  };

  propSel.onchange = render;
  unpaidChk.onchange = render;
  render();
}

function kpiCard(label, value, sub, variant) {
  return el('div', { class: `kpi${variant ? ' ' + variant : ''}` },
    el('div', { class: 'kpi-label' }, label),
    el('div', { class: 'kpi-value num' }, value),
    sub ? el('div', { class: 'fx-hint' }, sub) : null
  );
}

function buildUpcomingSection(wrap) {
  const ltProps = (state.db.properties || []).filter(p => p.type === 'long_term' && p.monthlyRent);
  if (ltProps.length === 0) {
    wrap.appendChild(el('div', { class: 'empty' }, 'No long-term rental properties configured'));
    return;
  }

  const horizonSel = select([
    { value: '1', label: 'Next 1 month' },
    { value: '3', label: 'Next 3 months' },
    { value: '6', label: 'Next 6 months' },
    { value: '12', label: 'Next 12 months' }
  ], '3');
  const bar = el('div', { class: 'flex gap-8 mb-16', style: 'align-items:center' });
  bar.appendChild(el('span', { style: 'font-size:13px;color:var(--text-muted)' }, 'Show:'));
  bar.appendChild(horizonSel);
  wrap.appendChild(bar);

  const kpiRow = el('div', { class: 'grid grid-4 mb-16' });
  wrap.appendChild(kpiRow);

  const tableWrap = el('div', { class: 'table-wrap' });
  wrap.appendChild(tableWrap);

  const render = () => {
    const now = new Date();
    const horizonMonths = Number(horizonSel.value);
    const cutoff = new Date(now.getFullYear(), now.getMonth() + horizonMonths + 1, 1);
    const thisMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    // Collect all overdue + upcoming within horizon across all LT properties
    const allEntries = [];
    for (const prop of ltProps) {
      for (const entry of generatePaymentSchedule(prop)) {
        if (entry.paid) continue;
        if (!entry.overdue && new Date(entry.date) >= cutoff) continue;
        allEntries.push({ ...entry, prop });
      }
    }
    allEntries.sort((a, b) => a.date.localeCompare(b.date));

    const overdue = allEntries.filter(e => e.overdue);
    const thisMonth = allEntries.filter(e => e.monthKey === thisMonthKey);
    const upcoming = allEntries.filter(e => !e.overdue);
    const totalEUR = allEntries.reduce((s, e) => s + e.amountEUR, 0);

    kpiRow.innerHTML = '';
    kpiRow.appendChild(kpiCard('Overdue', String(overdue.length), overdue.length ? formatEUR(overdue.reduce((s, e) => s + e.amountEUR, 0)) : '—', overdue.length ? 'danger' : ''));
    kpiRow.appendChild(kpiCard('Due This Month', String(thisMonth.length), thisMonth.length ? formatEUR(thisMonth.reduce((s, e) => s + e.amountEUR, 0)) : '—', thisMonth.length ? 'warning' : ''));
    kpiRow.appendChild(kpiCard('Upcoming', String(upcoming.length), upcoming.length ? formatEUR(upcoming.reduce((s, e) => s + e.amountEUR, 0)) : '—', ''));
    kpiRow.appendChild(kpiCard('Total Expected', formatEUR(totalEUR), `${allEntries.length} payment(s)`, ''));

    tableWrap.innerHTML = '';
    if (allEntries.length === 0) {
      tableWrap.appendChild(el('div', { class: 'empty' }, 'No upcoming payments'));
      return;
    }

    const t = el('table', { class: 'table' });
    t.innerHTML = `<thead><tr><th>Due Date</th><th>Property</th><th>Tenant</th><th class="right">Amount</th><th class="right">EUR</th><th>Status</th><th></th></tr></thead>`;
    const tb = el('tbody');
    for (const entry of allEntries) {
      const { prop } = entry;
      const dueDate = new Date(entry.date);
      const diffDays = Math.ceil((dueDate - now) / 86400000);
      const isThisMonth = entry.monthKey === thisMonthKey;

      const statusBadge = entry.overdue
        ? el('span', { class: 'badge danger' }, 'Overdue')
        : isThisMonth
          ? el('span', { class: 'badge warning' }, 'Due this month')
          : el('span', { class: 'badge' }, diffDays <= 7 ? `In ${diffDays}d` : 'Upcoming');

      const tr = el('tr', entry.overdue ? { style: 'background:rgba(239,68,68,.04)' } : {});
      tr.appendChild(el('td', {}, fmtDate(entry.date)));
      tr.appendChild(el('td', {}, prop.name));
      tr.appendChild(el('td', { class: 'muted' }, prop.tenantName || '—'));
      tr.appendChild(el('td', { class: 'right num' }, formatMoney(entry.amount, entry.currency, { maxFrac: 0 })));
      tr.appendChild(el('td', { class: 'right num muted' }, entry.currency === 'EUR' ? '' : formatEUR(entry.amountEUR)));
      tr.appendChild(el('td', {}, statusBadge));
      const td = el('td', { class: 'right' });
      td.appendChild(button('Mark Paid', { variant: 'sm primary', onClick: () => recordRentPayment(prop, entry, render) }));
      tr.appendChild(td);
      tb.appendChild(tr);
    }
    t.appendChild(tb);
    tableWrap.appendChild(t);

    tableWrap.appendChild(el('div', { class: 'flex justify-between', style: 'padding:14px 16px;border-top:1px solid var(--border);font-size:13px' },
      el('span', { class: 'muted' }, `${ltProps.length} propert${ltProps.length === 1 ? 'y' : 'ies'} · ${allEntries.length} payment(s)`),
      el('strong', { class: 'num' }, `Expected: ${formatEUR(totalEUR)}`)
    ));
  };

  horizonSel.onchange = render;
  render();
}

function openForm(existing) {
  const r = existing ? { ...existing } : {
    id: newId('pay'), propertyId: state.db.properties?.[0]?.id || '',
    amount: 0, currency: 'EUR', date: today(), type: 'rental',
    status: 'paid', source: 'manual', stream: 'short_term_rental', notes: ''
  };
  const body = el('div', {});
  const propS = select((state.db.properties || []).map(p => ({ value: p.id, label: p.name })), r.propertyId);
  const amountI = input({ type: 'number', value: r.amount, min: 0, step: 0.01 });
  const currencyS = select(CURRENCIES, r.currency);
  const dateI = input({ type: 'date', value: r.date });
  const typeS = select(['rental', 'deposit', 'cleaning', 'other'], r.type);
  const statusS = select(Object.keys(PAYMENT_STATUSES), r.status);
  const sourceS = select(['manual', 'airbnb', 'bank'], r.source);
  const streamS = select(Object.entries(STREAMS).filter(([k]) => k.includes('rental')).map(([v, m]) => ({ value: v, label: m.short })), r.stream);
  const notesT = textarea(); notesT.value = r.notes || '';

  body.appendChild(formRow('Property', propS));
  body.appendChild(el('div', { class: 'form-row horizontal' }, formRow('Amount', amountI), formRow('Currency', currencyS)));
  body.appendChild(el('div', { class: 'form-row horizontal' }, formRow('Date', dateI), formRow('Type', typeS)));
  body.appendChild(el('div', { class: 'form-row horizontal' }, formRow('Status', statusS), formRow('Source', sourceS)));
  body.appendChild(formRow('Stream', streamS));
  body.appendChild(formRow('Notes', notesT));

  propS.onchange = () => {
    const p = byId('properties', propS.value);
    if (p) { streamS.value = p.type === 'short_term' ? 'short_term_rental' : 'long_term_rental'; currencyS.value = p.currency; }
  };

  const save = button('Save', { variant: 'primary', onClick: () => {
    if (!propS.value) { toast('Select a property', 'danger'); return; }
    if (Number(amountI.value) <= 0) { toast('Amount must be positive', 'danger'); return; }
    Object.assign(r, {
      propertyId: propS.value, amount: Number(amountI.value),
      currency: currencyS.value, date: dateI.value, type: typeS.value,
      status: statusS.value, source: sourceS.value, stream: streamS.value,
      notes: notesT.value.trim()
    });
    upsert('payments', r);
    toast(existing ? 'Payment updated' : 'Payment added', 'success');
    closeModal();
    setTimeout(() => navigate('payments'), 200);
  }});
  openModal({ title: existing ? 'Edit Payment' : 'New Payment', body, footer: [button('Cancel', { onClick: closeModal }), save] });
}

// ===== Airbnb CSV Import =====
function openCSVImport() {
  const props = state.db.properties || [];
  if (props.length === 0) { toast('Add properties first', 'warning'); return; }

  const stProps = props.filter(p => p.type === 'short_term');
  const normName = s => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const findProp = listing => {
    const n = normName(listing);
    if (!n) return null;
    return stProps.find(p => normName(p.name) === n)
      || stProps.find(p => n.includes(normName(p.name)) || normName(p.name).includes(n))
      || null;
  };

  const body = el('div', {});

  const makeFileSlot = (label, hint) => {
    const fileI = el('input', { type: 'file', accept: '.csv', class: 'input' });
    const wrap = el('div', { class: 'card', style: 'padding:12px 16px;margin-bottom:12px' },
      el('div', { style: 'font-size:11px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--text-muted);margin-bottom:2px' }, label),
      el('div', { style: 'font-size:11px;color:var(--text-muted);margin-bottom:8px' }, hint),
      fileI
    );
    return { fileI, wrap };
  };

  const { fileI: completedFileI, wrap: completedWrap } = makeFileSlot(
    'Completed Payouts',
    'airbnb_.csv — historical paid-out transactions'
  );
  const { fileI: pendingFileI, wrap: pendingWrap } = makeFileSlot(
    'Future / Pending Payouts',
    'airbnb_pending.csv — forecasted upcoming reservations'
  );

  const preview = el('div', { style: 'font-size:13px;min-height:24px' });

  body.appendChild(completedWrap);
  body.appendChild(pendingWrap);
  body.appendChild(preview);

  const updatePreview = async () => {
    preview.innerHTML = '';
    for (const { file, status } of [
      { file: completedFileI.files?.[0], status: 'paid' },
      { file: pendingFileI.files?.[0], status: 'pending' }
    ]) {
      if (!file) continue;
      const text = await file.text();
      const rows = parseAirbnbCSV(text);
      let added = 0, updated = 0, skipped = 0;
      for (const row of rows) {
        const pmatch = findProp(row.listing);
        const exists = row.reference
          ? (state.db.payments || []).some(p => p.airbnbRef === row.reference)
          : pmatch && (state.db.payments || []).some(p =>
              p.source === 'airbnb' && p.propertyId === pmatch.id &&
              p.date === row.date && Number(p.amount) === Number(row.amount));
        if (exists) { updated++; continue; }
        if (pmatch) added++; else skipped++;
      }
      const badge = el('span', { class: `badge ${status === 'paid' ? 'success' : 'warning'}` }, status === 'paid' ? 'Paid' : 'Pending');
      preview.appendChild(el('div', { class: 'flex gap-8', style: 'align-items:center;margin-bottom:6px' },
        badge,
        el('span', { style: 'font-weight:500' }, file.name),
        el('span', { class: 'muted' }, `— ${rows.length} rows · ${added} new · ${updated} update${skipped ? ` · ${skipped} skipped (no match)` : ''}`)
      ));
    }
  };

  completedFileI.onchange = updatePreview;
  pendingFileI.onchange = updatePreview;

  const importBtn = button('Import', { variant: 'primary', onClick: async () => {
    if (!completedFileI.files?.[0] && !pendingFileI.files?.[0]) {
      toast('Select at least one file', 'warning'); return;
    }

    let totalAdded = 0, totalUpdated = 0;

    for (const { file, status } of [
      { file: completedFileI.files?.[0], status: 'paid' },
      { file: pendingFileI.files?.[0], status: 'pending' }
    ]) {
      if (!file) continue;
      const text = await file.text();
      const rows = parseAirbnbCSV(text);

      for (const row of rows) {
        const matched = findProp(row.listing);
        if (!matched) continue;

        // Idempotency: primary key = airbnbRef; fallback = source+property+date+amount
        const existing = row.reference
          ? (state.db.payments || []).find(p => p.airbnbRef === row.reference)
          : (state.db.payments || []).find(p =>
              p.source === 'airbnb' && p.propertyId === matched.id &&
              p.date === row.date && Number(p.amount) === Number(row.amount));
        const pay = existing ? { ...existing } : {
          id: newId('pay'),
          propertyId: matched.id,
          stream: 'short_term_rental',
          source: 'airbnb'
        };
        Object.assign(pay, {
          amount: row.amount,
          currency: row.currency || matched.currency,
          date: row.date,
          type: 'rental',
          status,
          airbnbRef: row.reference,
          airbnbCheckIn: row.checkIn,
          airbnbNights: row.nights,
          notes: [row.guest, row.listing].filter(Boolean).join(' · ')
        });
        upsert('payments', pay);
        const cleanAmt = row.cleaningFee || matched.cleaningFee || 0;
        if (cleanAmt > 0) {
          const expDate = row.checkIn || row.date;
          const existingExp = row.reference
            ? (state.db.expenses || []).find(e => e.airbnbRef === row.reference && e.category === 'cleaning')
            : (state.db.expenses || []).find(e =>
                e.category === 'cleaning' && e.propertyId === matched.id && e.date === expDate);
          if (!existingExp) {
            upsert('expenses', {
              id: newId('exp'),
              propertyId: matched.id,
              category: 'cleaning',
              amount: cleanAmt,
              currency: row.currency || matched.currency,
              date: expDate,
              airbnbRef: row.reference || '',
              vendorId: '',
              vendor: '',
              description: '',
              stream: 'short_term_rental'
            });
          }
        }
        if (existing) totalUpdated++; else totalAdded++;
      }
    }

    toast(`Imported: ${totalAdded} new, ${totalUpdated} updated`, 'success');
    closeModal();
    setTimeout(() => navigate('payments'), 200);
  }});

  openModal({
    title: 'Import Airbnb CSV',
    body,
    footer: [button('Cancel', { onClick: closeModal }), importBtn],
    large: true
  });
}

// RFC-4180-compliant CSV parser with flexible Airbnb column mapping
function parseAirbnbCSV(text) {
  // Strip BOM, normalise line endings
  const clean = text.replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = clean.split('\n');

  const parseLine = (line) => {
    const fields = [];
    let cur = '', inQuote = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        if (inQuote && line[i + 1] === '"') { cur += '"'; i++; }
        else inQuote = !inQuote;
      } else if (c === ',' && !inQuote) {
        fields.push(cur.trim()); cur = '';
      } else {
        cur += c;
      }
    }
    fields.push(cur.trim());
    return fields;
  };

  // Find the header row (first non-empty line)
  const headerLine = lines.find(l => l.trim());
  if (!headerLine) return [];
  const headers = parseLine(headerLine).map(h =>
    h.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  );

  // Flexible column lookup — tries each name until a match is found
  const col = (row, ...candidates) => {
    for (const name of candidates) {
      const i = headers.findIndex(h => h === name || h.startsWith(name));
      if (i >= 0 && i < row.length) return (row[i] ?? '').trim();
    }
    return '';
  };

  const results = [];
  let foundHeader = false;

  for (const line of lines) {
    if (!foundHeader) { if (line.trim() === headerLine.trim()) { foundHeader = true; } continue; }
    if (!line.trim()) continue;

    const row = parseLine(line);

    // Confirmation Code is the reservation idempotency key
    const reference = col(row, 'reference', 'transaction id', 'trans id', 'confirmation code', 'confirmation', 'reservation code', 'code');

    // Amount: prefer "paid out" (actual cash received) → fall back to abs(amount)
    const paidOut  = col(row, 'paid out', 'gross earnings', 'host payout', 'payout amount');
    const rawAmt   = col(row, 'amount', 'total amount', 'total');
    const amtStr   = paidOut || rawAmt;
    const amount   = Math.abs(parseFloat(amtStr.replace(/[^0-9.-]/g, '')) || 0);

    // Date: use payout/transaction date; fall back to check-in date for pending files
    const dateRaw    = col(row, 'date', 'paid date', 'payout date', 'transaction date');
    const checkInRaw = col(row, 'start date', 'check in', 'checkin', 'arrival date');
    const date       = parseDateStr(dateRaw) || parseDateStr(checkInRaw);
    if (!date) continue;

    results.push({
      date,
      checkIn:     parseDateStr(checkInRaw) || '',
      nights:      parseInt(col(row, 'nights', 'number of nights'), 10) || 0,
      reference,
      amount,
      currency:    col(row, 'currency', 'currency code') || 'EUR',
      guest:       col(row, 'guest', 'guest name'),
      listing:     col(row, 'listing', 'listing name', 'property'),
      cleaningFee: Math.abs(parseFloat((col(row, 'cleaning fee', 'cleaning') || '').replace(/[^0-9.-]/g, '')) || 0)
    });
  }

  return results;
}

function parseDateStr(raw) {
  if (!raw) return null;
  const d = new Date(raw);
  if (!isNaN(d)) return d.toISOString().slice(0, 10);
  return null;
}

function exportCSV() {
  const rows = state.db.payments || [];
  const headers = ['id', 'date', 'propertyId', 'amount', 'currency', 'type', 'status', 'source', 'stream', 'notes'];
  const lines = [headers.join(',')];
  for (const r of rows) lines.push(headers.map(h => JSON.stringify(r[h] ?? '')).join(','));
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `payments-${today()}.csv`;
  a.click();
  toast('CSV downloaded', 'success');
}
