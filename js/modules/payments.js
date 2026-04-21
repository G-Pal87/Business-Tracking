// Payments module: manual payments, LT rental schedule, Airbnb CSV import
import { state } from '../core/state.js';
import { el, openModal, closeModal, confirmDialog, toast, select, selVals, input, formRow, textarea, button, fmtDate, today } from '../core/ui.js';
import { upsert, remove, byId, newId, formatMoney, formatEUR, toEUR, generatePaymentSchedule } from '../core/data.js';
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
  const propSel = select([{ value: 'all', label: 'All Properties' }, ...(state.db.properties || []).map(p => ({ value: p.id, label: p.name }))], 'all');
  const statusSel = select(Object.entries(PAYMENT_STATUSES).map(([v, m]) => ({ value: v, label: m.label })), [], { multiple: true, title: 'Ctrl+click to select multiple statuses' });
  const streamSel = select([{ value: 'all', label: 'All Streams' }, ...Object.entries(STREAMS).filter(([k]) => k.includes('rental')).map(([v, m]) => ({ value: v, label: m.short }))], 'all');

  filterBar.appendChild(propSel);
  filterBar.appendChild(statusSel);
  filterBar.appendChild(streamSel);
  filterBar.appendChild(el('div', { class: 'flex-1' }));
  filterBar.appendChild(button('Import Airbnb CSV', { onClick: () => openCSVImport() }));
  filterBar.appendChild(button('Export CSV', { onClick: () => exportCSV() }));
  filterBar.appendChild(button('+ Add Payment', { variant: 'primary', onClick: () => openForm() }));
  wrap.appendChild(filterBar);

  const tableWrap = el('div', { class: 'table-wrap' });
  wrap.appendChild(tableWrap);

  const renderTable = () => {
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
    t.innerHTML = `<thead><tr><th>Due Date</th><th>Month</th><th class="right">Amount</th><th class="right">EUR</th><th>Status</th><th></th></tr></thead>`;
    const tb = el('tbody');
    for (const s of rows) {
      const isThisMonth = s.monthKey === thisMonthKey;
      const tr = el('tr', isThisMonth && !s.paid ? { style: 'background:var(--bg-highlight, #fefce8)' } : {});
      tr.appendChild(el('td', {}, fmtDate(s.date)));
      tr.appendChild(el('td', { class: 'muted' }, s.monthKey));
      tr.appendChild(el('td', { class: 'right num' }, formatMoney(s.amount, s.currency, { maxFrac: 0 })));
      tr.appendChild(el('td', { class: 'right num muted' }, s.currency === 'EUR' ? '' : formatEUR(s.amountEUR)));
      tr.appendChild(el('td', {},
        s.paid ? el('span', { class: 'badge success' }, 'Paid')
        : s.overdue ? el('span', { class: 'badge danger' }, 'Overdue')
        : isThisMonth ? el('span', { class: 'badge warning' }, 'Due this month')
        : el('span', { class: 'badge' }, 'Upcoming')
      ));
      const td = el('td', { class: 'right' });
      if (!s.paid) {
        td.appendChild(button('Mark Paid', { variant: 'sm primary', onClick: () => recordRentPayment(prop, s, render) }));
      }
      tr.appendChild(td);
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
    setTimeout(() => location.hash = 'payments', 200);
  }});
  openModal({ title: existing ? 'Edit Payment' : 'New Payment', body, footer: [button('Cancel', { onClick: closeModal }), save] });
}

// ===== Airbnb CSV Import =====
function openCSVImport() {
  const props = state.db.properties || [];
  if (props.length === 0) { toast('Add properties first', 'warning'); return; }

  const body = el('div', {});
  const propS = select(props.map(p => ({ value: p.id, label: p.name })));
  const typeS = select([
    { value: 'completed', label: 'Completed Transactions (historical)' },
    { value: 'future', label: 'Future / Pending Payouts' }
  ]);
  const fileI = el('input', { type: 'file', accept: '.csv', class: 'input' });
  const preview = el('div', { style: 'margin-top:12px;font-size:12px;color:var(--text-muted)' });

  body.appendChild(formRow('Property', propS));
  body.appendChild(formRow('File type', typeS));
  body.appendChild(formRow('Airbnb CSV file', fileI));
  body.appendChild(preview);

  fileI.onchange = async () => {
    const file = fileI.files?.[0];
    if (!file) return;
    const text = await file.text();
    const rows = parseAirbnbCSV(text);
    preview.textContent = `Found ${rows.length} valid row(s) in CSV.`;
  };

  const importBtn = button('Import', { variant: 'primary', onClick: async () => {
    const file = fileI.files?.[0];
    if (!file) { toast('Select a file', 'warning'); return; }
    const text = await file.text();
    const rows = parseAirbnbCSV(text);
    const prop = byId('properties', propS.value);
    if (!prop) return;
    let added = 0, updated = 0;
    for (const row of rows) {
      const status = typeS.value === 'future' ? 'pending' : 'paid';
      const existing = (state.db.payments || []).find(p => p.propertyId === prop.id && p.airbnbRef === row.reference);
      const pay = existing ? { ...existing } : {
        id: newId('pay'), propertyId: prop.id,
        stream: 'short_term_rental', source: 'airbnb'
      };
      Object.assign(pay, {
        amount: Math.abs(row.amount), currency: row.currency || prop.currency,
        date: row.date, type: 'rental', status,
        airbnbRef: row.reference,
        notes: row.description || ''
      });
      const isNew = !existing;
      upsert('payments', pay);
      if (isNew) added++; else updated++;
    }
    toast(`Imported ${added} new, ${updated} updated`, 'success');
    closeModal();
    setTimeout(() => location.hash = 'payments', 200);
  }});
  openModal({ title: 'Import Airbnb CSV', body, footer: [button('Cancel', { onClick: closeModal }), importBtn] });
}

function parseAirbnbCSV(text) {
  const lines = text.replace(/\r/g, '').split('\n').filter(Boolean);
  if (lines.length < 2) return [];
  const headers = lines[0].toLowerCase().split(',').map(h => h.replace(/"/g, '').trim());
  const get = (row, names) => {
    for (const n of names) {
      const i = headers.indexOf(n);
      if (i >= 0) return row[i]?.replace(/"/g, '').trim() || '';
    }
    return '';
  };
  const results = [];
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const parts = line.match(/(".*?"|[^,]+|(?<=,)(?=,))/g) || line.split(',');
    const row = parts.map(p => (p || '').replace(/^"|"$/g, '').trim());
    const type = get(row, ['type']).toLowerCase();
    // Include reservation rows and payout rows
    if (!type || (type !== 'reservation' && type !== 'payout' && !type.includes('payout'))) continue;
    const dateRaw = get(row, ['date', 'paid date', 'start date']);
    const date = parseDateStr(dateRaw);
    if (!date) continue;
    const amtRaw = get(row, ['amount', 'amount (usd)', 'gross earnings', 'paid out']);
    const amount = parseFloat(amtRaw.replace(/[^0-9.-]/g, '')) || 0;
    if (!amount) continue;
    results.push({
      date,
      reference: get(row, ['confirmation code', 'reference', 'reservation code']),
      amount: Math.abs(amount),
      currency: get(row, ['currency']) || 'EUR',
      description: get(row, ['description', 'type'])
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
