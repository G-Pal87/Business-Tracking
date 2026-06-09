// Time Off module — tracks days off for FTE-style engagements (e.g. C TWO)
// and drives the monthly worked-days invoice.
//
// Billing model:
//   - billable days = (Mon–Fri working days in month) − (deducted days off)
//   - deducted day types: 'standard' and 'carry_out' (reduce the month's invoice)
//   - 'carry_in' days are physically off but fully billed (drawn from the carry bank)
//
// Balances (per engagement):
//   - Annual quota remaining (calendar year) = quota − (standard + carry_out in that year)
//   - Carry bank (running, all-time)          = Σ carry_out − Σ carry_in
import { el, openModal, closeModal, confirmDialog, toast, select, input, formRow, textarea, button, fmtDate, today, addDays } from '../core/ui.js';
import { upsert, softDelete, listActive, newId, byId, formatMoney, getPersonName, patchSettings } from '../core/data.js';
import { state } from '../core/state.js';

const TYPE_META = {
  standard:  { label: 'Standard day off',      short: 'Standard',  deducts: true,  css: '' },
  carry_out: { label: 'Carry-out (defer rest)', short: 'Carry-out', deducts: true,  css: 'warning' },
  carry_in:  { label: 'Carry-in (balanced)',    short: 'Carry-in',  deducts: false, css: 'info' },
};

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// ── Engagement helpers ──────────────────────────────────────────────────────

function engagements() {
  return (state.db.settings?.engagements || []).filter(e => e.active !== false);
}

// Auto-seed a default C TWO engagement if none exists yet.
function ensureDefaultEngagement() {
  const list = state.db.settings?.engagements || [];
  if (list.length > 0) return;
  const ctwo = listActive('clients').find(c => (c.billingCode || '').toUpperCase() === 'CTWO')
            || listActive('clients').find(c => /c\s*two/i.test(c.name || ''));
  const giorgos = (state.db.people || []).find(p => p.legacyKey === 'you')
               || (state.db.people || []).find(p => /giorgos/i.test(p.name || ''));
  patchSettings({
    engagements: [{
      id: newId('eng'),
      clientId: ctwo?.id || '',
      personId: giorgos?.id || '',
      dailyRate: 670,
      currency: ctwo?.currency || 'EUR',
      annualQuota: 38,
      workingDays: 'mon-fri',
      active: true,
    }],
  });
}

// ── Date / billing math ─────────────────────────────────────────────────────

function workingDaysInMonth(year, monthIdx) {
  // monthIdx is 0-based; counts Mon–Fri
  let count = 0;
  const d = new Date(Date.UTC(year, monthIdx, 1));
  while (d.getUTCMonth() === monthIdx) {
    const dow = d.getUTCDay(); // 0 Sun … 6 Sat
    if (dow !== 0 && dow !== 6) count++;
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return count;
}

function lastDayOfMonth(year, monthIdx) {
  return new Date(Date.UTC(year, monthIdx + 1, 0)).toISOString().slice(0, 10);
}

function entriesFor(engId, year, monthIdx) {
  const prefix = monthIdx == null
    ? String(year)
    : `${year}-${String(monthIdx + 1).padStart(2, '0')}`;
  return listActive('timeOff')
    .filter(t => t.engagementId === engId && (t.date || '').startsWith(prefix))
    .sort((a, b) => (a.date || '').localeCompare(b.date || ''));
}

function sumAmount(entries, predicate = () => true) {
  return entries.filter(predicate).reduce((s, t) => s + (Number(t.amount) || 0), 0);
}

function monthBilling(eng, year, monthIdx) {
  const entries  = entriesFor(eng.id, year, monthIdx);
  const working  = workingDaysInMonth(year, monthIdx);
  const deducted = sumAmount(entries, t => TYPE_META[t.type]?.deducts);
  const carryIn  = sumAmount(entries, t => t.type === 'carry_in');
  const billable = Math.max(0, working - deducted);
  const invoiceId = entries.find(t => t.invoiceId)?.invoiceId || null;
  return { entries, working, deducted, carryIn, billable, amount: billable * (eng.dailyRate || 0), invoiceId };
}

function yearBalances(eng, year) {
  const yearEntries = entriesFor(eng.id, year, null);
  const consumed = sumAmount(yearEntries, t => TYPE_META[t.type]?.deducts);
  const quotaRemaining = (eng.annualQuota || 0) - consumed;
  // Carry bank is a running all-time balance
  const all = listActive('timeOff').filter(t => t.engagementId === eng.id);
  const carryBank = sumAmount(all, t => t.type === 'carry_out') - sumAmount(all, t => t.type === 'carry_in');
  return { consumed, quotaRemaining, carryBank };
}

// ── Module ──────────────────────────────────────────────────────────────────

export default {
  id: 'time-off',
  label: 'Time Off',
  icon: '\u{1F334}',
  render(container) { container.appendChild(build()); },
  refresh() { const c = document.getElementById('content'); c.innerHTML = ''; c.appendChild(build()); },
  destroy() {},
};

let selectedYear = new Date().getFullYear();

function build() {
  ensureDefaultEngagement();
  const wrap = el('div', { class: 'view active' });
  const engs = engagements();

  if (engs.length === 0) {
    wrap.appendChild(el('div', { class: 'empty' }, 'No engagement configured. Add a client with billing code "CTWO" first.'));
    return wrap;
  }

  // Single engagement for now — use the first
  const eng = engs[0];
  const client = byId('clients', eng.clientId);

  // ── Toolbar ──
  const bar = el('div', { class: 'flex gap-8 mb-16', style: 'align-items:center' });
  const years = [];
  for (let y = new Date().getFullYear() + 1; y >= 2024; y--) years.push(y);
  const yearS = select(years.map(y => ({ value: String(y), label: String(y) })), String(selectedYear));
  yearS.onchange = () => { selectedYear = Number(yearS.value); rerender(); };
  bar.appendChild(formRow('Year', yearS));
  bar.appendChild(el('div', { class: 'flex-1' }));
  bar.appendChild(button('⚙ Engagement', { variant: 'ghost', onClick: () => openEngagementForm(eng) }));
  bar.appendChild(button('+ Log Time Off', { variant: 'primary', onClick: () => openEntryForm(eng) }));
  wrap.appendChild(bar);

  // ── Balance widgets ──
  const bal = yearBalances(eng, selectedYear);
  const widgets = el('div', { class: 'prop-card-stats', style: 'margin-bottom:16px' });
  widgets.appendChild(statWidget(`${selectedYear} quota remaining`, `${fmtDays(bal.quotaRemaining)} / ${eng.annualQuota}`, bal.quotaRemaining < 0 ? 'danger' : ''));
  widgets.appendChild(statWidget(`${selectedYear} days consumed`, fmtDays(bal.consumed)));
  widgets.appendChild(statWidget('Carry bank (all-time)', fmtDays(bal.carryBank)));
  widgets.appendChild(statWidget('Daily rate', formatMoney(eng.dailyRate, eng.currency, { maxFrac: 0 })));
  const widgetCard = el('div', { class: 'card mb-16' });
  widgetCard.appendChild(el('div', { class: 'card-header' },
    el('div', { class: 'card-title' }, client ? `${client.name} — ${getPersonName(client.owner)}` : 'Engagement')
  ));
  widgetCard.appendChild(widgets);
  wrap.appendChild(widgetCard);

  // ── Monthly breakdown ──
  const tableCard = el('div', { class: 'card' });
  tableCard.appendChild(el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, `${selectedYear} Monthly Breakdown`)));
  const t = el('table', { class: 'table' });
  t.innerHTML = `<thead><tr>
    <th>Month</th><th class="right">Working</th><th class="right">Off (deducted)</th>
    <th class="right">Carry-in</th><th class="right">Billable</th><th class="right">Amount</th><th></th>
  </tr></thead>`;
  const tb = el('tbody');

  let totalBillable = 0, totalAmount = 0;
  for (let m = 0; m < 12; m++) {
    const b = monthBilling(eng, selectedYear, m);
    const hasActivity = b.entries.length > 0;
    totalBillable += b.billable;
    totalAmount   += b.amount;

    const tr = el('tr', { style: 'cursor:pointer' });
    tr.appendChild(el('td', {}, MONTHS[m]));
    tr.appendChild(el('td', { class: 'right num muted' }, String(b.working)));
    tr.appendChild(el('td', { class: 'right num' }, b.deducted ? fmtDays(b.deducted) : '—'));
    tr.appendChild(el('td', { class: 'right num' }, b.carryIn ? fmtDays(b.carryIn) : '—'));
    tr.appendChild(el('td', { class: 'right num' }, String(b.billable)));
    tr.appendChild(el('td', { class: 'right num' }, formatMoney(b.amount, eng.currency, { maxFrac: 0 })));

    const actions = el('td', { class: 'right', style: 'white-space:nowrap' });
    if (b.invoiceId && byId('invoices', b.invoiceId)) {
      const inv = byId('invoices', b.invoiceId);
      actions.appendChild(el('span', { class: 'badge success' }, `Invoiced ${inv.number ? '#' + inv.number : ''}`.trim()));
    } else if (hasActivity || b.billable > 0) {
      actions.appendChild(button('Create Invoice', { variant: 'sm primary', onClick: (e) => { e.stopPropagation(); createMonthInvoice(eng, selectedYear, m); }}));
    }
    tr.appendChild(actions);
    tr.onclick = () => openMonthDetail(eng, selectedYear, m);
    tb.appendChild(tr);
  }

  const tfootRow = el('tr', { style: 'font-weight:700;border-top:2px solid var(--border)' });
  tfootRow.appendChild(el('td', {}, 'Total'));
  tfootRow.appendChild(el('td', {}, ''));
  tfootRow.appendChild(el('td', {}, ''));
  tfootRow.appendChild(el('td', {}, ''));
  tfootRow.appendChild(el('td', { class: 'right num' }, String(totalBillable)));
  tfootRow.appendChild(el('td', { class: 'right num' }, formatMoney(totalAmount, eng.currency, { maxFrac: 0 })));
  tfootRow.appendChild(el('td', {}, ''));
  tb.appendChild(tfootRow);

  t.appendChild(tb);
  const tableWrap = el('div', { class: 'table-wrap' });
  tableWrap.appendChild(t);
  tableCard.appendChild(tableWrap);
  wrap.appendChild(tableCard);

  return wrap;
}

function rerender() {
  const c = document.getElementById('content');
  c.innerHTML = '';
  c.appendChild(build());
}

function fmtDays(n) {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function statWidget(label, value, css = '') {
  return el('div', {},
    el('div', { class: 'prop-card-stat-label' }, label),
    el('div', { class: `prop-card-stat-value num ${css}` }, value)
  );
}

// ── Month detail (list entries) ───────────────────────────────────────────────

function openMonthDetail(eng, year, monthIdx) {
  const b = monthBilling(eng, year, monthIdx);
  const body = el('div', {});
  body.appendChild(el('div', { class: 'mb-16' },
    el('h2', {}, `${MONTHS[monthIdx]} ${year}`),
    el('div', { class: 'muted', style: 'font-size:13px;margin-top:4px' },
      `${b.working} working days − ${fmtDays(b.deducted)} deducted = ${b.billable} billable × ${formatMoney(eng.dailyRate, eng.currency, { maxFrac: 0 })} = ${formatMoney(b.amount, eng.currency, { maxFrac: 0 })}`)
  ));

  if (b.entries.length === 0) {
    body.appendChild(el('div', { class: 'empty' }, 'No days off logged this month.'));
  } else {
    const t = el('table', { class: 'table' });
    t.innerHTML = `<thead><tr><th>Date</th><th>Type</th><th class="right">Amount</th><th>Notes</th><th></th></tr></thead>`;
    const tb = el('tbody');
    for (const en of b.entries) {
      const meta = TYPE_META[en.type] || { short: en.type, css: '' };
      const tr = el('tr', {});
      tr.appendChild(el('td', {}, fmtDate(en.date)));
      tr.appendChild(el('td', {}, el('span', { class: `badge ${meta.css}` }, meta.short)));
      tr.appendChild(el('td', { class: 'right num' }, fmtDays(Number(en.amount) || 0)));
      tr.appendChild(el('td', { class: 'muted', style: 'font-size:12px' }, en.notes || ''));
      const actions = el('td', { class: 'right', style: 'white-space:nowrap' });
      actions.appendChild(button('Edit', { variant: 'sm ghost', onClick: () => { closeModal(); setTimeout(() => openEntryForm(eng, en), 220); }}));
      actions.appendChild(button('Delete', { variant: 'sm danger', onClick: async () => {
        const ok = await confirmDialog(`Delete time off on ${fmtDate(en.date)}?`, { danger: true, okLabel: 'Delete' });
        if (!ok) return;
        softDelete('timeOff', en.id);
        toast('Deleted', 'success');
        closeModal(); setTimeout(rerender, 100);
      }}));
      tr.appendChild(actions);
      tb.appendChild(tr);
    }
    t.appendChild(tb);
    const tw = el('div', { class: 'table-wrap' });
    tw.appendChild(t);
    body.appendChild(tw);
  }

  const addBtn = button('+ Log Time Off', { variant: 'primary', onClick: () => { closeModal(); setTimeout(() => openEntryForm(eng, null, lastDayOfMonth(year, monthIdx)), 220); }});
  const footer = [button('Close', { onClick: closeModal }), addBtn];
  if (!b.invoiceId && b.billable > 0) {
    footer.push(button('Create Invoice', { variant: 'primary', onClick: () => { closeModal(); setTimeout(() => createMonthInvoice(eng, year, monthIdx), 220); }}));
  }
  openModal({ title: 'Month Detail', body, footer, large: true });
}

// ── Entry form ────────────────────────────────────────────────────────────────

function openEntryForm(eng, existing, defaultDate) {
  const isFuture = (dateStr) => dateStr >= today();
  const en = existing ? { ...existing } : {
    id: newId('to'),
    engagementId: eng.id,
    personId: eng.personId,
    date: defaultDate || today(),
    amount: 1,
    type: 'standard',
    notes: '',
  };

  const body = el('div', {});
  const dateI = input({ type: 'date', value: en.date });
  const amountS = select([
    { value: '1', label: 'Full day' },
    { value: '0.5', label: 'Half day' },
  ], String(en.amount === 0.5 ? 0.5 : 1));
  const typeS = select(Object.entries(TYPE_META).map(([v, m]) => ({ value: v, label: m.label })), en.type);
  const notesT = textarea({ placeholder: 'Optional notes' });
  notesT.value = en.notes || '';

  const hint = el('div', { style: 'font-size:11px;color:var(--text-muted);padding:4px 0' });
  const updateHint = () => {
    const m = TYPE_META[typeS.value];
    hint.textContent = m?.deducts
      ? 'Reduces this month’s invoice and consumes annual quota.'
      : 'Fully billed (no invoice reduction); draws down the carry bank.';
  };
  typeS.onchange = updateHint;
  updateHint();

  body.appendChild(el('div', { class: 'form-row horizontal' }, formRow('Date', dateI), formRow('Amount', amountS)));
  body.appendChild(formRow('Type', typeS));
  body.appendChild(hint);
  body.appendChild(formRow('Notes', notesT));

  const save = button('Save', { variant: 'primary', onClick: () => {
    if (!dateI.value) { toast('Date required', 'danger'); return; }
    // Log going forward only (allow editing existing past entries)
    if (!existing && !isFuture(dateI.value)) {
      toast('Time off can only be logged from today onward', 'danger', 4000);
      return;
    }
    Object.assign(en, {
      date: dateI.value,
      amount: Number(amountS.value) || 1,
      type: typeS.value,
      notes: notesT.value.trim(),
    });
    // If this entry was previously tied to an invoice, keep the link
    upsert('timeOff', en);
    selectedYear = Number(dateI.value.slice(0, 4));
    toast(existing ? 'Time off updated' : 'Time off logged', 'success');
    closeModal();
    setTimeout(rerender, 100);
  }});
  openModal({ title: existing ? 'Edit Time Off' : 'Log Time Off', body, footer: [button('Cancel', { onClick: closeModal }), save] });
}

// ── Engagement settings form ──────────────────────────────────────────────────

function openEngagementForm(eng) {
  const e = { ...eng };
  const body = el('div', {});
  const clients = listActive('clients');
  const clientS = select(clients.map(c => ({ value: c.id, label: c.name })), e.clientId || (clients[0]?.id || ''));
  const people = (state.db.people || []).filter(p => p.active !== false);
  const personS = select(people.map(p => ({ value: p.id, label: p.name })), e.personId || (people[0]?.id || ''));
  const rateI = input({ type: 'number', value: e.dailyRate, min: 0, step: 1 });
  const quotaI = input({ type: 'number', value: e.annualQuota, min: 0, step: 0.5 });
  const curS = select([{ value: 'EUR', label: 'EUR' }, { value: 'HUF', label: 'HUF' }], e.currency || 'EUR');

  body.appendChild(el('div', { class: 'form-row horizontal' }, formRow('Client', clientS), formRow('Person', personS)));
  body.appendChild(el('div', { class: 'form-row horizontal' }, formRow('Daily Rate', rateI), formRow('Currency', curS)));
  body.appendChild(formRow('Annual Quota (days)', quotaI));

  const save = button('Save', { variant: 'primary', onClick: () => {
    const list = state.db.settings.engagements.map(x => x.id === e.id
      ? { ...x, clientId: clientS.value, personId: personS.value, dailyRate: Number(rateI.value) || 0, annualQuota: Number(quotaI.value) || 0, currency: curS.value }
      : x);
    patchSettings({ engagements: list });
    toast('Engagement updated', 'success');
    closeModal();
    setTimeout(rerender, 100);
  }});
  openModal({ title: 'Engagement Settings', body, footer: [button('Cancel', { onClick: closeModal }), save] });
}

// ── Invoice creation ──────────────────────────────────────────────────────────

async function createMonthInvoice(eng, year, monthIdx) {
  const b = monthBilling(eng, year, monthIdx);
  if (b.billable <= 0) { toast('No billable days this month', 'warning'); return; }
  const client = byId('clients', eng.clientId);
  if (!client) { toast('Engagement client not found', 'danger'); return; }

  const monthLabel = `${MONTHS[monthIdx]} ${year}`;
  const issue = lastDayOfMonth(year, monthIdx);
  const rate  = eng.dailyRate || 0;
  const total = Math.round(b.billable * rate * 100) / 100;
  const invId = newId('inv');

  const draft = {
    id: invId,
    number: '',
    clientId: eng.clientId,
    owner: client.owner,
    issueDate: issue,
    dueDate: addDays(issue, 30),
    stream: client.stream,
    currency: eng.currency,
    status: 'draft',
    lineItems: [{
      id: newId('li'),
      description: `Professional Services — ${monthLabel}`,
      quantity: b.billable,
      unit: 'day',
      rate,
      total,
    }],
    subtotal: total,
    taxRate: 0,
    tax: 0,
    total,
    notes: `${b.working} working days − ${fmtDays(b.deducted)} day(s) off = ${b.billable} billable days @ ${formatMoney(rate, eng.currency, { maxFrac: 0 })}/day`,
  };

  const { openBuilder } = await import('./invoices.js');
  openBuilder(draft, { onSaved: () => {
    // Tag this month's entries with the invoice id so the month shows as invoiced.
    // Re-read by id in case the user changed the number; id is preserved by the builder.
    const saved = byId('invoices', invId);
    if (saved) {
      for (const en of entriesFor(eng.id, year, monthIdx)) {
        if (!en.invoiceId) { en.invoiceId = invId; upsert('timeOff', en); }
      }
    }
    rerender();
  }});
}
