// Time Off module — tracks days off for FTE-style engagements (e.g. C TWO)
// and drives the monthly worked-days invoice.
//
// Billing model:
//   - billable days = (Mon–Fri working days in month) − (deducted days off)
//   - deducted day types: 'standard' and 'carry_out' (reduce the month's invoice)
//   - 'carry_in' days are physically off but fully billed (drawn from the carry bank)
//
// Balances (per engagement):
//   - Annual quota remaining (calendar year) = quota − (standard + carry_out in that year,
//     both already taken and booked-upcoming; the UI shows those two parts separately)
//   - Carry bank (running, all-time)          = Σ carry_out − Σ carry_in, PLUS any unused
//     quota automatically rolled forward from every fully-completed year since
//     eng.quotaStartYear (live/derived — see computeCarryBank; nothing is ever written for
//     this, unlike an explicit carry_out). Defaults to the current year for any engagement
//     that hasn't set one, so a year with no logged entries is never mistaken for "38 unused
//     days" when it may just be a year that predates this app / wasn't tracked at all.
import { el, openModal, closeModal, confirmDialog, toast, select, input, formRow, textarea, button, fmtDate, today, addDays } from '../core/ui.js';
import { upsert, softDelete, listActive, newId, byId, formatMoney, getPersonName, patchSettings } from '../core/data.js';
import { state, runBatch } from '../core/state.js';
import { parseYmd } from '../core/dates.js';

const TYPE_META = {
  standard:  { label: 'Standard day off',      short: 'Standard',  deducts: true,  css: '' },
  carry_out: { label: 'Carry-out (defer rest)', short: 'Carry-out', deducts: true,  css: 'warning' },
  carry_in:  { label: 'Carry-in (balanced)',    short: 'Carry-in',  deducts: false, css: 'info' },
};

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// Earliest year selectable in the year picker further down — a UI navigation
// range only, independent of eng.quotaStartYear (which governs rollover math).
const EARLIEST_VIEWABLE_YEAR = 2024;

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
      quotaStartYear: new Date().getFullYear(),
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
  const invoiceId = monthInvoiceId(eng.id, year, monthIdx, entries);
  return { entries, working, deducted, carryIn, billable, amount: billable * (eng.dailyRate || 0), invoiceId };
}

// A month is invoiced when a live (not soft-deleted) invoice carries this
// engagement+month marker (set by createMonthInvoice — works even for a
// month with no time-off entries), or — for invoices created before the
// marker existed — when one of the month's entries links to a live invoice.
function isLiveInvoice(id) {
  const inv = id ? byId('invoices', id) : null;
  return !!(inv && !inv.deletedAt);
}
function monthInvoiceId(engId, year, monthIdx, entries) {
  const ym = `${year}-${String(monthIdx + 1).padStart(2, '0')}`;
  const marked = listActive('invoices').find(i => i.engagementId === engId && i.engagementMonth === ym);
  if (marked) return marked.id;
  return entries.find(t => isLiveInvoice(t.invoiceId))?.invoiceId || null;
}

function isWeekend(ymd) {
  const dow = parseYmd(ymd).getUTCDay();
  return dow === 0 || dow === 6;
}

// Carry bank = the manual carry_out/carry_in ledger, PLUS unused quota
// auto-rolled forward from every fully-completed past year (current year's
// leftover isn't final until the year ends, so it never contributes yet).
// `excludeId` lets a save-time check compute the bank as it would be
// WITHOUT the entry currently being edited/saved, so the guard and the
// displayed balance can never disagree. `extra` (optional) is a hypothetical
// entry added in its place, to compute the bank as it WOULD be after a save.
function computeCarryBank(eng, excludeId = null, extra = null) {
  const all = listActive('timeOff').filter(t => t.engagementId === eng.id && t.id !== excludeId);
  if (extra) all.push(...[].concat(extra)); // one hypothetical entry, or several (a date range)
  const manualCarry = sumAmount(all, t => t.type === 'carry_out') - sumAmount(all, t => t.type === 'carry_in');

  const thisYear = new Date().getFullYear();
  const startYear = eng.quotaStartYear ?? thisYear;
  let rolledOverQuota = 0;
  for (let y = startYear; y < thisYear; y++) {
    const consumedY = sumAmount(all.filter(t => (t.date || '').startsWith(String(y))), t => TYPE_META[t.type]?.deducts);
    rolledOverQuota += Math.max(0, (eng.annualQuota || 0) - consumedY);
  }
  return manualCarry + rolledOverQuota;
}

function yearBalances(eng, year) {
  const yearEntries = entriesFor(eng.id, year, null);
  const deducts = t => TYPE_META[t.type]?.deducts;
  const consumed = sumAmount(yearEntries, deducts);
  // Split the year's deducted days into already taken (today or earlier) vs.
  // booked but still upcoming. Quota remaining counts both — a booked day is
  // already spoken for.
  const todayYmd = today();
  const upcoming = sumAmount(yearEntries, t => deducts(t) && (t.date || '') > todayYmd);
  const quotaRemaining = (eng.annualQuota || 0) - consumed;
  const carryBank = computeCarryBank(eng);
  return { consumed, taken: consumed - upcoming, upcoming, quotaRemaining, carryBank };
}

// All booked-but-not-yet-taken entries (any type, any year), soonest first.
function upcomingEntries(engId) {
  const todayYmd = today();
  return listActive('timeOff')
    .filter(t => t.engagementId === engId && (t.date || '') > todayYmd)
    .sort((a, b) => (a.date || '').localeCompare(b.date || ''));
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
  for (let y = new Date().getFullYear() + 1; y >= EARLIEST_VIEWABLE_YEAR; y--) years.push(y);
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
  widgets.appendChild(statWidget(`${selectedYear} days consumed`, fmtDays(bal.taken)));
  widgets.appendChild(statWidget(`${selectedYear} days booked (upcoming)`, fmtDays(bal.upcoming)));
  widgets.appendChild(statWidget('Carry bank (all-time)', fmtDays(bal.carryBank)));
  widgets.appendChild(statWidget('Daily rate', formatMoney(eng.dailyRate, eng.currency, { maxFrac: 0 })));
  const widgetCard = el('div', { class: 'card mb-16' });
  widgetCard.appendChild(el('div', { class: 'card-header' },
    el('div', { class: 'card-title' }, client ? `${client.name} — ${getPersonName(client.owner)}` : 'Engagement')
  ));
  widgetCard.appendChild(widgets);
  wrap.appendChild(widgetCard);

  // ── Upcoming booked days ──
  const upcoming = upcomingEntries(eng.id);
  if (upcoming.length > 0) {
    const upCard = el('div', { class: 'card mb-16' });
    upCard.appendChild(el('div', { class: 'card-header' },
      el('div', { class: 'card-title' }, `Upcoming Time Off (${fmtDays(sumAmount(upcoming))} day(s) booked)`)));
    const ut = el('table', { class: 'table' });
    ut.innerHTML = `<thead><tr><th>Date</th><th>Type</th><th class="right">Amount</th><th>Notes</th></tr></thead>`;
    const utb = el('tbody');
    for (const en of upcoming) {
      const meta = TYPE_META[en.type] || { short: en.type, css: '' };
      const tr = el('tr', { style: 'cursor:pointer' });
      tr.appendChild(el('td', {}, fmtDate(en.date)));
      tr.appendChild(el('td', {}, el('span', { class: `badge ${meta.css}` }, meta.short)));
      tr.appendChild(el('td', { class: 'right num' }, fmtDays(Number(en.amount) || 0)));
      tr.appendChild(el('td', { class: 'muted', style: 'font-size:12px' }, en.notes || ''));
      tr.onclick = () => openEntryForm(eng, en);
      utb.appendChild(tr);
    }
    ut.appendChild(utb);
    const utWrap = el('div', { class: 'table-wrap' });
    utWrap.appendChild(ut);
    upCard.appendChild(utWrap);
    wrap.appendChild(upCard);
  }

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
    if (b.invoiceId) { // monthBilling only returns live (non-deleted) invoices
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
        // Removing a carry-out (or a past-year day) can pull the carry bank
        // below zero when carry-ins already spent it — block rather than
        // leave a negative bank.
        const bankAfter = computeCarryBank(eng, en.id);
        if (bankAfter < -1e-9 && bankAfter < computeCarryBank(eng) - 1e-9) {
          toast(`Can't delete: the carry bank would drop to ${fmtDays(bankAfter)} day(s). Remove or change the carry-in days that use it first.`, 'danger', 6000);
          return;
        }
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
  // New entries can cover a period: one ordinary entry per weekday in
  // [From, To] — the same shape as a single-day entry, so billing, invoices
  // and balances treat each day exactly as if it had been logged on its own.
  const periodS = select([
    { value: 'single', label: 'Single day' },
    { value: 'range', label: 'Date range' },
  ], 'single');
  const toI = input({ type: 'date', value: en.date });
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

  // A past date can land in a month whose invoice was already created
  // (createMonthInvoice tags that month's entries with invoiceId) — logging
  // it retrospectively is fine, but it's a one-time snapshot at invoice
  // creation, so it won't retroactively change that invoice. Surface that
  // up front rather than let it look like a silent no-op later.
  const invoicedHint = el('div', { style: 'font-size:11px;color:var(--warning);padding:4px 0' });
  const isRange = () => !existing && periodS.value === 'range';
  // Every date in the chosen period that would actually be logged, plus what
  // gets skipped and why. Same rules as a single entry: Mon–Fri only, and a
  // day can't hold more than one full day in total.
  const MAX_RANGE_DAYS = 366;
  const planRange = (amount) => {
    const from = dateI.value, to = toI.value;
    const out = { days: [], weekends: 0, taken: [], error: '' };
    if (!from || !to) { out.error = 'From and To dates are required'; return out; }
    if (to < from) { out.error = 'The To date is before the From date'; return out; }
    const taken = listActive('timeOff').filter(t => t.engagementId === eng.id);
    for (let d = from, n = 0; d <= to; d = addDays(d, 1), n++) {
      if (n >= MAX_RANGE_DAYS) { out.error = `A period can cover at most ${MAX_RANGE_DAYS} days`; return out; }
      if (isWeekend(d)) { out.weekends++; continue; }
      if (sumAmount(taken.filter(t => t.date === d)) + amount > 1 + 1e-9) { out.taken.push(d); continue; }
      out.days.push(d);
    }
    return out;
  };
  // Months of the period (or the single date) that already have an invoice.
  const updateInvoicedHint = () => {
    if (!dateI.value) { invoicedHint.textContent = ''; return; }
    const end = isRange() && toI.value >= dateI.value ? toI.value : dateI.value;
    const done = [];
    for (let ym = dateI.value.slice(0, 7); ym <= end.slice(0, 7); ) {
      const y = Number(ym.slice(0, 4)), mIdx = Number(ym.slice(5, 7)) - 1;
      if (monthBilling(eng, y, mIdx).invoiceId) done.push(`${MONTHS[mIdx]} ${y}`);
      const nm = mIdx === 11 ? `${y + 1}-01` : `${y}-${String(mIdx + 2).padStart(2, '0')}`;
      ym = nm;
    }
    invoicedHint.textContent = !done.length ? ''
      : done.length === 1 && !isRange()
        ? `${done[0]} has already been invoiced — this entry won't change that invoice.`
        : `Already invoiced: ${done.join(', ')} — entries in ${done.length === 1 ? 'that month' : 'those months'} won't change ${done.length === 1 ? 'its invoice' : 'their invoices'}.`;
  };
  const rangeHint = el('div', { style: 'font-size:11px;color:var(--text-muted);padding:4px 0' });
  const updateRangeHint = () => {
    if (!isRange()) { rangeHint.textContent = ''; return; }
    const plan = planRange(Number(amountS.value) || 1);
    if (plan.error) { rangeHint.textContent = plan.error; return; }
    const parts = [`${plan.days.length} working day(s) will be logged`];
    if (plan.weekends) parts.push(`${plan.weekends} weekend day(s) skipped`);
    if (plan.taken.length) parts.push(`${plan.taken.length} already logged, skipped`);
    rangeHint.textContent = parts.join(' · ') + '.';
  };
  const dateRow = el('div', { class: 'form-row horizontal' });
  // Read-only total, recalculated on every change: the days this entry (or
  // period) will actually log — weekends and already-logged days excluded.
  const daysI = input({ type: 'text', value: '' });
  daysI.readOnly = true;
  daysI.tabIndex = -1;
  daysI.style.background = 'var(--bg-subtle, transparent)';
  const updateDaysOff = () => {
    const amount = Number(amountS.value) || 1;
    let total = 0;
    if (isRange()) {
      const plan = planRange(amount);
      total = plan.error ? 0 : plan.days.length * amount;
    } else if (dateI.value) {
      const keepsOwnDate = existing && existing.date === dateI.value;
      const others = listActive('timeOff').filter(t => t.engagementId === eng.id && t.id !== en.id && t.date === dateI.value);
      const fits = sumAmount(others) + amount <= 1 + 1e-9;
      total = (keepsOwnDate || !isWeekend(dateI.value)) && fits ? amount : 0;
    }
    daysI.value = `${fmtDays(total)} day${total === 1 ? '' : 's'}`;
  };
  const layoutDates = () => {
    dateRow.replaceChildren(...(isRange()
      ? [formRow('From', dateI), formRow('To', toI), formRow('Amount (each day)', amountS), formRow('Days off', daysI)]
      : [formRow('Date', dateI), formRow('Amount', amountS), formRow('Days off', daysI)]));
  };
  const refreshHints = () => { updateInvoicedHint(); updateRangeHint(); updateDaysOff(); };
  dateI.onchange = () => { if (isRange() && (!toI.value || toI.value < dateI.value)) toI.value = dateI.value; refreshHints(); };
  toI.onchange = refreshHints;
  amountS.onchange = () => { updateRangeHint(); updateDaysOff(); };
  periodS.onchange = () => { layoutDates(); refreshHints(); };
  layoutDates();
  refreshHints();

  if (!existing) body.appendChild(formRow('Period', periodS));
  body.appendChild(dateRow);
  body.appendChild(rangeHint);
  body.appendChild(formRow('Type', typeS));
  body.appendChild(hint);
  body.appendChild(invoicedHint);
  body.appendChild(formRow('Notes', notesT));

  const saveRange = () => {
    const newType = typeS.value;
    const newAmount = Number(amountS.value) || 1;
    const plan = planRange(newAmount);
    if (plan.error) { toast(plan.error, 'danger'); return; }
    if (!plan.days.length) {
      toast('No working days left to log in that period (weekends and already-logged days are skipped).', 'danger', 5000);
      return;
    }
    const entries = plan.days.map(d => ({
      id: newId('to'), engagementId: eng.id, personId: eng.personId,
      date: d, amount: newAmount, type: newType, notes: notesT.value.trim(),
    }));
    // Same carry-bank rules as a single entry, applied to the whole period at
    // once: carry-ins can't spend more than the bank holds, and nothing may
    // leave the bank negative (e.g. standard days in a past year shrinking
    // the rolled-over quota that carry-ins already spent).
    const total = newAmount * entries.length;
    if (newType === 'carry_in') {
      const bankBefore = computeCarryBank(eng);
      if (total > bankBefore + 1e-9) {
        toast(`Carry bank only has ${fmtDays(Math.max(0, bankBefore))} day(s) available — can't carry in ${fmtDays(total)}.`, 'danger', 5000);
        return;
      }
    }
    const bankAfter = computeCarryBank(eng, null, entries);
    if (bankAfter < -1e-9 && bankAfter < computeCarryBank(eng) - 1e-9) {
      toast(`This period would leave the carry bank at ${fmtDays(bankAfter)} day(s). Adjust the carry-in days first.`, 'danger', 6000);
      return;
    }
    runBatch(() => { for (const e of entries) upsert('timeOff', e); });
    selectedYear = Number(entries[0].date.slice(0, 4));
    const skipped = plan.weekends + plan.taken.length;
    toast(`Logged ${fmtDays(total)} day(s) of time off across ${entries.length} working day(s)` +
      (plan.taken.length ? ` — skipped ${plan.taken.length} already-logged day(s)` : '') +
      (skipped && !plan.taken.length ? ' (weekends skipped)' : '') + '.', 'success', 5000);
    closeModal();
    setTimeout(rerender, 100);
  };

  const save = button('Save', { variant: 'primary', onClick: () => {
    if (isRange()) { saveRange(); return; }
    if (!dateI.value) { toast('Date required', 'danger'); return; }
    const newType = typeS.value;
    const newAmount = Number(amountS.value) || 1;
    // Billing counts Mon–Fri only (workingDaysInMonth), so a weekend "day
    // off" would wrongly cut a working day from the invoice. An entry that is
    // already on a weekend (older data) can still be edited in place.
    if (isWeekend(dateI.value) && !(existing && existing.date === dateI.value)) {
      toast('That date is a weekend — only Mon–Fri days count as working days.', 'danger', 5000);
      return;
    }
    // Same day logged twice (more than one full day in total) would deduct it twice.
    const sameDay = listActive('timeOff').filter(t => t.engagementId === eng.id && t.id !== en.id && t.date === dateI.value);
    if (sumAmount(sameDay) + newAmount > 1 + 1e-9) {
      toast(`Time off is already logged on ${fmtDate(dateI.value)}.`, 'danger', 5000);
      return;
    }
    // Guard: a carry-in can't spend more than the bank actually holds — the
    // bank is a running total (see computeCarryBank), it has no built-in
    // floor, so without this check it would silently go negative. Uses the
    // same helper the displayed balance uses (incl. auto-rolled-over quota
    // from past years) so this check can never disagree with what's shown.
    if (newType === 'carry_in') {
      const bankBeforeThis = computeCarryBank(eng, en.id);
      if (newAmount > bankBeforeThis + 1e-9) {
        toast(`Carry bank only has ${fmtDays(Math.max(0, bankBeforeThis))} day(s) available — can't carry in ${fmtDays(newAmount)}.`, 'danger', 5000);
        return;
      }
    }
    // Retyping/shrinking a carry-out (or any change) must not leave the carry
    // bank negative when carry-ins already spent it.
    {
      const bankAfter = computeCarryBank(eng, en.id, { ...en, date: dateI.value, amount: newAmount, type: newType });
      if (bankAfter < -1e-9 && bankAfter < computeCarryBank(eng) - 1e-9) {
        toast(`This change would leave the carry bank at ${fmtDays(bankAfter)} day(s). Adjust the carry-in days first.`, 'danger', 6000);
        return;
      }
    }
    // If the date now falls in a different month than before, this entry no
    // longer belongs to whatever invoice it was tagged with (createMonthInvoice
    // tags entries per calendar month) — clear the stale link so the new
    // month isn't falsely shown as already invoiced (see monthBilling/
    // invoiceId) while the old month keeps sitting under an invoice for a day
    // it no longer has.
    const oldMonth = (en.date || '').slice(0, 7);
    const newMonth = (dateI.value || '').slice(0, 7);
    const monthChanged = oldMonth !== newMonth;
    Object.assign(en, {
      date: dateI.value,
      amount: newAmount,
      type: newType,
      notes: notesT.value.trim(),
    });
    if (monthChanged && en.invoiceId) {
      en.invoiceId = null;
    }
    // Otherwise, if this entry was previously tied to an invoice and the
    // month didn't change, keep the link as-is.
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
  const quotaYearI = input({ type: 'number', value: e.quotaStartYear ?? new Date().getFullYear(), min: 2000, step: 1 });

  body.appendChild(el('div', { class: 'form-row horizontal' }, formRow('Client', clientS), formRow('Person', personS)));
  body.appendChild(el('div', { class: 'form-row horizontal' }, formRow('Daily Rate', rateI), formRow('Currency', curS)));
  body.appendChild(formRow('Annual Quota (days)', quotaI));
  body.appendChild(formRow('Quota tracking starts in', quotaYearI,
    'Unused quota from this year onward auto-rolls into the carry bank once each year ends. Years before this never contribute, even if nothing was logged for them.'));

  const save = button('Save', { variant: 'primary', onClick: () => {
    const list = state.db.settings.engagements.map(x => x.id === e.id
      ? { ...x, clientId: clientS.value, personId: personS.value, dailyRate: Number(rateI.value) || 0, annualQuota: Number(quotaI.value) || 0, currency: curS.value, quotaStartYear: Number(quotaYearI.value) || new Date().getFullYear() }
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
  if (b.invoiceId) { toast(`${MONTHS[monthIdx]} ${year} has already been invoiced`, 'warning'); return; }
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
    // Engagement+month marker: lets monthBilling see this month as invoiced
    // even when it has no time-off entries to carry the link.
    engagementId: eng.id,
    engagementMonth: `${year}-${String(monthIdx + 1).padStart(2, '0')}`,
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
        if (!isLiveInvoice(en.invoiceId)) { upsert('timeOff', { ...en, invoiceId: invId }); }
      }
    }
    rerender();
  }});
}
