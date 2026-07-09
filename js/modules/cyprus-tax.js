// Cyprus Provisional Corporation Tax Calculator
import { state, markDirty } from '../core/state.js';
import { el, input, select, button, formRow, toast, openModal } from '../core/ui.js';
import { formatEUR, toEUR, listActivePayments, listActive, availableYears, isCapEx, byId, companyPropIds } from '../core/data.js';
import { mkKpiCard, mkModalTable, mkSectionLabel, mkSummaryGrid } from './analytics-helpers.js';

const DEFAULTS = {
  year: String(new Date().getFullYear()),
  // Cyprus's standard corporate tax rate rose from 12.5% to 15% for tax years
  // starting 1 January 2026 (OECD Pillar Two alignment). Existing saved
  // configs keep whatever rate they were set to — this only affects the
  // default a brand-new (never-configured) year starts from.
  corpTaxRate: 15,
  bufferEnabled: true,
  bufferPct: 10,
  actualRevenue: 0,
  forecastRevenue: 0,
  actualExpenses: 0,
  forecastExpenses: 0,
  nonDeductibleExpenses: 0,
  taxAllowances: 0,
  estimatedFinalTax: 0,
  julPayment: 0,
  decRevRevenue: 0,
  decRevExpenses: 0,
  decRevNonDeductible: 0,
  decRevAllowances: 0,
};

function cfg() {
  if (!state.db.settings) state.db.settings = {};
  if (!state.db.settings.cyprusTax) state.db.settings.cyprusTax = { ...DEFAULTS };
  return state.db.settings.cyprusTax;
}

function persist(patch) {
  Object.assign(cfg(), patch);
  markDirty();
}

const safeN = v => (isFinite(Number(v)) ? Math.max(0, Number(v)) : 0);
const fmtE  = v => formatEUR(Math.max(0, v), { minFrac: 2 });

const mkCurrencyInput = (val, style, onValue) => {
  const fmt   = v => v > 0 ? new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v) : '';
  const parse = s => { const n = parseFloat((s || '').replace(/[^0-9.]/g, '')); return isFinite(n) && n > 0 ? n : 0; };
  const i = el('input', { class: 'input', type: 'text', style: style || 'width:100%', inputmode: 'decimal', placeholder: '0.00', autocomplete: 'off' });
  const initVal = safeN(val);
  i.value = initVal > 0 ? fmt(initVal) : '';
  i.addEventListener('focus', () => { const n = parse(i.value); i.value = n > 0 ? String(n) : ''; i.select(); });
  i.addEventListener('blur',  () => { const n = parse(i.value); i.value = n > 0 ? fmt(n) : ''; });
  i.addEventListener('input', () => onValue(parse(i.value)));
  return i;
};

function calcAll(s) {
  const rate       = safeN(s.corpTaxRate);
  const bufPct     = safeN(s.bufferPct);
  const bufEnabled = !!s.bufferEnabled;

  const totalRevenue    = safeN(s.actualRevenue) + safeN(s.forecastRevenue);
  const totalDeductible = safeN(s.actualExpenses) + safeN(s.forecastExpenses);
  const estProfit       = Math.max(0, totalRevenue - totalDeductible + safeN(s.nonDeductibleExpenses) - safeN(s.taxAllowances));
  const bufferedProfit  = bufEnabled ? estProfit * (1 + bufPct / 100) : estProfit;
  const taxableProfit   = Math.max(0, bufferedProfit);
  const corpTax         = taxableProfit * (rate / 100);
  const julyPayment     = corpTax / 2;
  const decPayment      = corpTax / 2;

  const finalTax      = safeN(s.estimatedFinalTax);
  const minRequired75 = finalTax * 0.75;
  const shortfall     = Math.max(0, minRequired75 - corpTax);

  const revProfit        = Math.max(0, safeN(s.decRevRevenue) - safeN(s.decRevExpenses) + safeN(s.decRevNonDeductible) - safeN(s.decRevAllowances));
  const revisedAnnualTax = revProfit * (rate / 100);
  const alreadyPaid      = safeN(s.julPayment);
  const addDecRaw        = revisedAnnualTax - alreadyPaid;
  const reqDecPayment    = Math.max(0, addDecRaw);
  const overpayment      = addDecRaw < 0 ? Math.abs(addDecRaw) : 0;

  return {
    rate, bufPct, bufEnabled,
    totalRevenue, totalDeductible, estProfit, bufferedProfit, taxableProfit, corpTax,
    julyPayment, decPayment,
    finalTax, minRequired75, shortfall, safe: minRequired75 - corpTax <= 0,
    revProfit, revisedAnnualTax, alreadyPaid, reqDecPayment, overpayment,
  };
}

// ── Modal utilities ───────────────────────────────────────────────────────────
const pct = (v, tot) => tot > 0 ? `${((v / tot) * 100).toFixed(1)}%` : '—';

function daysLabel(dateStr) {
  // Compare local calendar dates only (both at local midnight) so the result
  // doesn't depend on what time of day "now" is or the machine's UTC offset —
  // parsing dateStr with `new Date(dateStr)` treats it as UTC midnight, which
  // can read as "overdue" a day early in UTC+ timezones (e.g. Cyprus) well
  // before the deadline day has actually finished locally.
  const [y, m, d] = dateStr.split('-').map(Number);
  const due   = new Date(y, m - 1, d);
  const now   = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diff  = Math.round((due - today) / 86400000);
  if (diff > 0)  return `${diff}d remaining`;
  if (diff === 0) return 'Due today';
  return `${Math.abs(diff)}d overdue`;
}

// Fraction of the current month still ahead of `cutoff` (the last date
// already folded into "actuals"). Used so a forecast entry for the current,
// still-in-progress month contributes only its not-yet-elapsed portion to
// "forecast remaining" — counting the whole month would double-count days
// already in actuals; excluding the month entirely (the old `mk > curMonth`
// check) silently dropped its remaining days from both totals.
function monthRemainingFraction(cutoff) {
  const y = Number(cutoff.slice(0, 4)), m = Number(cutoff.slice(5, 7)), d = Number(cutoff.slice(8, 10));
  const daysInMonth = new Date(y, m, 0).getDate();
  return Math.max(0, (daysInMonth - d) / daysInMonth);
}

// Records without a propertyId (service invoices, salary expenses, etc.) are
// always company-scope; records tied to a 'personal'-channel property are
// excluded — corporation tax is a company-only liability, and Dividends
// (getOpProfit) already applies this same filter.
function isCoRec(r) {
  const coPropIds = companyPropIds();
  return !r.propertyId || coPropIds.has(r.propertyId);
}

function getActualsForYear(year) {
  const today  = new Date().toISOString().slice(0, 10);
  const cutoff = today < `${year}-12-31` ? today : `${year}-12-31`;
  const s1     = `${year}-01-01`;
  return {
    pays:   listActivePayments().filter(p => p.status === 'paid' && p.date >= s1 && p.date <= cutoff && isCoRec(p)),
    invs:   listActive('invoices').filter(i => i.status === 'paid' && (i.issueDate || '') >= s1 && (i.issueDate || '') <= cutoff),
    exps:   listActive('expenses').filter(e => !isCapEx(e) && e.date >= s1 && e.date <= cutoff && isCoRec(e)),
    cutoff, year,
  };
}

function emptyModal(title, msg) {
  openModal({ title, body: el('div', { style: 'padding:24px;text-align:center;color:var(--text-muted)' }, msg) });
}

// ── Breakdown sub-row modals ──────────────────────────────────────────────────

function modalRentalPayments() {
  const year   = cfg().year || String(new Date().getFullYear());
  const { pays } = getActualsForYear(year);
  if (!pays.length) { emptyModal('Rental Payments', 'No paid rental payments for this period.'); return; }

  const propMap = Object.fromEntries((state.db.properties || []).map(p => [p.id, p]));
  const byProp = {}, byMonth = {};
  for (const p of pays) {
    const rev = toEUR(p.amount, p.currency, year);
    const pid = p.propertyId || '_';
    if (!byProp[pid]) byProp[pid] = { rev: 0, n: 0 };
    byProp[pid].rev += rev; byProp[pid].n++;
    const mo = p.date.slice(0, 7);
    byMonth[mo] = (byMonth[mo] || 0) + rev;
  }
  const total    = Object.values(byProp).reduce((a, d) => a + d.rev, 0);
  const propRows = Object.entries(byProp).sort(([, a], [, b]) => b.rev - a.rev);
  const moRows   = Object.entries(byMonth).sort(([a], [b]) => a.localeCompare(b));

  const body = el('div');
  body.appendChild(mkSummaryGrid([
    { label: 'Total Revenue',  value: fmtE(total) },
    { label: 'Payments',       value: String(pays.length) },
    { label: 'Avg / Payment',  value: fmtE(total / pays.length) },
    { label: 'Properties',     value: String(propRows.length) },
  ], 4));
  body.appendChild(mkSectionLabel('Revenue by Property'));
  body.appendChild(mkModalTable(
    [{ label: 'Property' }, { label: 'Pmts', right: true }, { label: 'Revenue', right: true }, { label: 'Share', right: true, muted: true }],
    propRows.map(([id, d]) => { const p = propMap[id]; return [p?.name || p?.address || 'Unknown', String(d.n), fmtE(d.rev), pct(d.rev, total)]; })
  ));
  body.appendChild(mkSectionLabel('Monthly Collections'));
  body.appendChild(mkModalTable(
    [{ label: 'Month' }, { label: 'Revenue', right: true }, { label: 'Share', right: true, muted: true }],
    moRows.map(([mo, v]) => [mo, fmtE(v), pct(v, total)])
  ));
  openModal({ title: `Rental Payments — ${year}`, body, large: true });
}

function modalInvoiceRevenue() {
  const year   = cfg().year || String(new Date().getFullYear());
  const { invs } = getActualsForYear(year);
  if (!invs.length) { emptyModal('Invoice Revenue', 'No paid invoices for this period.'); return; }

  const clientMap = Object.fromEntries((state.db.clients || []).map(c => [c.id, c]));
  const byClient  = {};
  for (const i of invs) {
    const rev = toEUR(i.total, i.currency, year);
    const id  = i.clientId || '_';
    if (!byClient[id]) byClient[id] = { rev: 0, n: 0 };
    byClient[id].rev += rev; byClient[id].n++;
  }
  const total  = Object.values(byClient).reduce((a, d) => a + d.rev, 0);
  const clRows = Object.entries(byClient).sort(([, a], [, b]) => b.rev - a.rev);

  const body = el('div');
  body.appendChild(mkSummaryGrid([
    { label: 'Total Invoiced', value: fmtE(total) },
    { label: 'Invoices',       value: String(invs.length) },
    { label: 'Avg Invoice',    value: fmtE(total / invs.length) },
    { label: 'Clients',        value: String(clRows.length) },
  ], 4));
  body.appendChild(mkSectionLabel('Revenue by Client'));
  body.appendChild(mkModalTable(
    [{ label: 'Client' }, { label: 'Invoices', right: true }, { label: 'Revenue', right: true }, { label: 'Share', right: true, muted: true }],
    clRows.map(([id, d]) => { const c = clientMap[id]; return [c?.name || c?.company || 'Unknown', String(d.n), fmtE(d.rev), pct(d.rev, total)]; })
  ));
  openModal({ title: `Invoice Revenue — ${year}`, body, large: true });
}

function modalExpenseCategory(cat) {
  const year     = cfg().year || String(new Date().getFullYear());
  const { exps } = getActualsForYear(year);
  const catExps  = exps.filter(e => (e.category || 'Other') === cat);
  if (!catExps.length) { emptyModal(cat, 'No expenses found for this category.'); return; }

  const allTotal = exps.reduce((a, e) => a + toEUR(e.amount, e.currency, year), 0);
  const total    = catExps.reduce((a, e) => a + toEUR(e.amount, e.currency, year), 0);
  const byMonth  = {};
  for (const e of catExps) {
    const mo = e.date.slice(0, 7);
    byMonth[mo] = (byMonth[mo] || 0) + toEUR(e.amount, e.currency, year);
  }
  const moRows  = Object.entries(byMonth).sort(([a], [b]) => a.localeCompare(b));
  const topRecs = [...catExps].sort((a, b) => toEUR(b.amount, b.currency, year) - toEUR(a.amount, a.currency, year)).slice(0, 8);

  const body = el('div');
  body.appendChild(mkSummaryGrid([
    { label: 'Category Total',    value: fmtE(total) },
    { label: 'Records',           value: String(catExps.length) },
    { label: 'Avg / Record',      value: fmtE(total / catExps.length) },
    { label: '% of All Expenses', value: pct(total, allTotal) },
  ], 4));
  body.appendChild(mkSectionLabel('Monthly Distribution'));
  body.appendChild(mkModalTable(
    [{ label: 'Month' }, { label: 'Amount', right: true }, { label: '% of Category', right: true, muted: true }],
    moRows.map(([mo, v]) => [mo, fmtE(v), pct(v, total)])
  ));
  body.appendChild(mkSectionLabel(`Top Records (${topRecs.length} of ${catExps.length})`));
  body.appendChild(mkModalTable(
    [{ label: 'Description / Vendor' }, { label: 'Date' }, { label: 'Amount', right: true }],
    topRecs.map(e => {
      const vendorName = e.vendorId ? byId('vendors', e.vendorId)?.name : null;
      const label = e.description || vendorName || e.vendor || '—';
      return [label, e.date || '', fmtE(toEUR(e.amount, e.currency, year))];
    })
  ));
  openModal({ title: `${cat} — ${year}`, body, large: true });
}

function modalForecastEntities(forRevenue) {
  const s        = cfg();
  const year     = s.year || String(new Date().getFullYear());
  const today    = new Date().toISOString().slice(0, 10);
  const cutoff   = today < `${year}-12-31` ? today : `${year}-12-31`;
  const curMonth = cutoff.slice(0, 7);
  const propMap  = Object.fromEntries((state.db.properties || []).map(p => [p.id, p]));
  const humanize = id => id.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

  const curMonthFrac = monthRemainingFraction(cutoff);
  const fcData = {};
  for (const fc of (state.db.forecasts || []).filter(f => !f.deletedAt && f.year === Number(year))) {
    const eid = fc.entityId || fc.propertyId || fc.id;
    if (!fcData[eid]) fcData[eid] = { rev: 0, exp: 0, months: 0, type: fc.type };
    for (const [mk, md] of Object.entries(fc.months || {})) {
      if (mk < curMonth) continue;
      const frac = mk === curMonth ? curMonthFrac : 1;
      if (frac <= 0) continue;
      const rev = (Number(md.revenue) || 0) * frac, exp = (Number(md.expenses) || 0) * frac;
      if (rev > 0 || exp > 0) { fcData[eid].rev += rev; fcData[eid].exp += exp; fcData[eid].months++; }
    }
  }

  const rows = Object.entries(fcData)
    .filter(([, d]) => forRevenue ? d.rev > 0 : d.exp > 0)
    .sort(([, a], [, b]) => forRevenue ? b.rev - a.rev : b.exp - a.exp);
  if (!rows.length) { emptyModal('Forecast', 'No forecast data found for remaining months.'); return; }

  const total    = rows.reduce((a, [, d]) => a + (forRevenue ? d.rev : d.exp), 0);
  const propCount = rows.filter(([id, d]) => d.type === 'property' || !!propMap[id]).length;
  const svcCount  = rows.length - propCount;

  const body = el('div');
  body.appendChild(mkSummaryGrid([
    { label: forRevenue ? 'Forecast Revenue' : 'Forecast Expenses', value: fmtE(total) },
    { label: 'Properties', value: String(propCount) },
    { label: 'Services', value: String(svcCount) },
    { label: 'From Month', value: `${curMonth} (partial) onwards` },
  ], 4));
  body.appendChild(mkSectionLabel(`${forRevenue ? 'Revenue' : 'Expense'} Forecast by Entity`));
  body.appendChild(mkModalTable(
    [{ label: 'Entity' }, { label: 'Type' }, { label: 'Months', right: true }, { label: forRevenue ? 'Revenue' : 'Expenses', right: true }, { label: 'Share', right: true, muted: true }],
    rows.map(([id, d]) => {
      const prop = propMap[id];
      const isProperty = d.type === 'property' || !!prop;
      const name = prop ? (prop.name || prop.address || id) : humanize(id);
      const val  = forRevenue ? d.rev : d.exp;
      return [name, isProperty ? 'Property' : 'Service', String(d.months), fmtE(val), pct(val, total)];
    })
  ));
  openModal({ title: `Forecast ${forRevenue ? 'Revenue' : 'Expenses'} — ${year}`, body, large: true });
}

// ── Provisional Tax Result KPI modals ────────────────────────────────────────

function modalRevenueDetail() {
  const s      = cfg();
  const year   = s.year || String(new Date().getFullYear());
  const { pays, invs } = getActualsForYear(year);
  const byMonth = {};
  for (const p of pays) { const mo = p.date.slice(0, 7); byMonth[mo] = (byMonth[mo] || 0) + toEUR(p.amount, p.currency, year); }
  for (const i of invs) { const mo = (i.issueDate || '').slice(0, 7); if (mo) byMonth[mo] = (byMonth[mo] || 0) + toEUR(i.total, i.currency, year); }
  const moRows   = Object.entries(byMonth).sort(([a], [b]) => a.localeCompare(b));
  const actTotal = moRows.reduce((a, [, v]) => a + v, 0);
  const paysTotal = pays.reduce((a, p) => a + toEUR(p.amount, p.currency, year), 0);
  const invsTotal = invs.reduce((a, i) => a + toEUR(i.total, i.currency, year), 0);

  const body = el('div');
  body.appendChild(mkSummaryGrid([
    { label: 'Actual Collected',       value: fmtE(actTotal) },
    { label: 'Forecast Remaining',     value: fmtE(safeN(s.forecastRevenue)) },
    { label: 'Rental Share',           value: pct(paysTotal, actTotal) },
    { label: 'Invoice Share',          value: pct(invsTotal, actTotal) },
  ], 4));
  if (moRows.length) {
    body.appendChild(mkSectionLabel('Month-by-Month Actual Collections'));
    let cum = 0;
    body.appendChild(mkModalTable(
      [{ label: 'Month' }, { label: 'Revenue', right: true }, { label: 'Cumulative', right: true, muted: true }],
      moRows.map(([mo, v]) => { cum += v; return [mo, fmtE(v), fmtE(cum)]; })
    ));
  }
  openModal({ title: `Annual Revenue Breakdown — ${year}`, body, large: true });
}

function modalExpensesDetail() {
  const s      = cfg();
  const year   = s.year || String(new Date().getFullYear());
  const { exps } = getActualsForYear(year);
  const byCat  = {};
  for (const e of exps) { const cat = e.category || 'Other'; byCat[cat] = (byCat[cat] || 0) + toEUR(e.amount, e.currency, year); }
  const actTotal = Object.values(byCat).reduce((a, v) => a + v, 0);
  const catRows  = Object.entries(byCat).sort(([, a], [, b]) => b - a);

  const body = el('div');
  body.appendChild(mkSummaryGrid([
    { label: 'Actual to Date',       value: fmtE(actTotal) },
    { label: 'Forecast Remaining',   value: fmtE(safeN(s.forecastExpenses)) },
    { label: 'Expense Categories',   value: String(catRows.length) },
    { label: 'Largest Category',     value: catRows[0]?.[0] || '—', sub: catRows[0] ? fmtE(catRows[0][1]) : '' },
  ], 4));
  if (catRows.length) {
    body.appendChild(mkSectionLabel('All Categories — Actual to Date'));
    body.appendChild(mkModalTable(
      [{ label: 'Category' }, { label: 'Amount', right: true }, { label: '% of Actual', right: true, muted: true }],
      catRows.map(([cat, v]) => [cat, fmtE(v), pct(v, actTotal)])
    ));
  }
  openModal({ title: `Deductible Expenses Breakdown — ${year}`, body, large: true });
}

function modalTaxableProfit() {
  const s = cfg();
  const c = calcAll(s);
  const margin = c.totalRevenue > 0 ? (c.estProfit / c.totalRevenue * 100).toFixed(1) : null;
  const rows = [
    ['Est. Annual Revenue', '', fmtE(c.totalRevenue)],
    ['Est. Deductible Expenses', '−', fmtE(c.totalDeductible)],
  ];
  if (safeN(s.nonDeductibleExpenses) > 0) rows.push(['Non-deductible add-back', '+', fmtE(safeN(s.nonDeductibleExpenses))]);
  if (safeN(s.taxAllowances)         > 0) rows.push(['Tax allowances', '−', fmtE(safeN(s.taxAllowances))]);
  rows.push(['Est. Taxable Profit', '=', fmtE(c.estProfit)]);

  const body = el('div');
  body.appendChild(mkSummaryGrid([
    { label: 'Est. Revenue',    value: fmtE(c.totalRevenue) },
    { label: 'Est. Expenses',   value: fmtE(c.totalDeductible) },
    { label: 'Taxable Profit',  value: fmtE(c.estProfit) },
    { label: 'Profit Margin',   value: margin ? `${margin}%` : '—', sub: 'Profit ÷ Revenue' },
  ], 4));
  body.appendChild(mkSectionLabel('Calculation'));
  body.appendChild(mkModalTable([{ label: 'Item' }, { label: '' }, { label: 'Amount', right: true }], rows));
  openModal({ title: 'Taxable Profit — Calculation', body, large: false });
}

function modalBufferedProfit() {
  const s = cfg();
  const c = calcAll(s);
  if (!c.bufEnabled) return;
  const bufferAmt = c.taxableProfit - c.estProfit;
  const extraTax  = bufferAmt * c.rate / 100;

  const body = el('div');
  body.appendChild(mkSummaryGrid([
    { label: 'Base Taxable Profit',   value: fmtE(c.estProfit) },
    { label: `Buffer (${c.bufPct}%)`, value: `+ ${fmtE(bufferAmt)}` },
    { label: 'Buffered Profit',       value: fmtE(c.taxableProfit) },
    { label: 'Extra Tax Cost',        value: fmtE(extraTax), sub: 'Cost of the safety margin' },
  ], 4));
  body.appendChild(el('div', { style: 'margin-top:4px;padding:12px;border-radius:6px;background:rgba(251,191,36,0.08);border-left:3px solid var(--warning);font-size:12px;color:var(--text-muted);line-height:1.6' },
    `The ${c.bufPct}% buffer inflates the taxable profit estimate so provisional tax is less likely to fall below 75% of the final liability. Cyprus imposes a 10% surcharge on any shortfall below that threshold. The buffer costs ~${fmtE(extraTax)} in extra provisional tax but protects against the penalty.`
  ));
  openModal({ title: `Safety Buffer — ${c.bufPct}%`, body });
}

function modalCorpTax() {
  const s        = cfg();
  const c        = calcAll(s);
  const year     = s.year || String(new Date().getFullYear());
  const nextYear = String(Number(year) + 1);
  const effRate  = c.totalRevenue > 0 ? (c.corpTax / c.totalRevenue * 100).toFixed(2) : '0.00';
  const netRetained = Math.max(0, c.estProfit - c.corpTax);

  const body = el('div');
  body.appendChild(mkSummaryGrid([
    { label: 'Corp Tax Rate',              value: `${c.rate}%` },
    { label: 'Taxable Profit',             value: fmtE(c.taxableProfit) },
    { label: 'Total Corp Tax',             value: fmtE(c.corpTax) },
    { label: 'Effective Rate on Revenue',  value: `${effRate}%`, sub: 'Tax ÷ Est. Revenue' },
  ], 4));
  body.appendChild(mkSectionLabel('Payment Schedule'));
  body.appendChild(mkModalTable(
    [{ label: 'Instalment' }, { label: 'Due Date' }, { label: 'Amount', right: true }, { label: 'Status', right: true, muted: true }],
    [
      ['1st — 50%',     `31 Jul ${year}`,       fmtE(c.julyPayment), daysLabel(`${year}-07-31`)],
      ['2nd — 50%',     `31 Dec ${year}`,        fmtE(c.decPayment),  daysLabel(`${year}-12-31`)],
      ['Final balance', `1 Aug ${nextYear}`,     '—',                 'After audit'],
    ]
  ));
  if (c.estProfit > 0) {
    body.appendChild(el('div', { style: 'margin-top:12px;font-size:12px;color:var(--text-muted)' },
      `Net profit retained after tax: ${fmtE(netRetained)} (${(netRetained / c.estProfit * 100).toFixed(1)}% of taxable profit)`));
  }
  openModal({ title: `Corporation Tax — ${year}`, body, large: true });
}

function modalInstalment(which) {
  const s      = cfg();
  const c      = calcAll(s);
  const year   = s.year || String(new Date().getFullYear());
  const isJuly = which === 'july';
  const dueDate = `${year}-${isJuly ? '07-31' : '12-31'}`;
  const amount  = isJuly ? c.julyPayment : c.decPayment;

  const body = el('div');
  body.appendChild(mkSummaryGrid([
    { label: 'Amount Due',       value: fmtE(amount) },
    { label: 'Due Date',         value: isJuly ? `31 Jul ${year}` : `31 Dec ${year}` },
    { label: 'Deadline Status',  value: daysLabel(dueDate) },
    { label: 'Total Corp Tax',   value: fmtE(c.corpTax), sub: 'Both instalments combined' },
  ], 4));
  body.appendChild(el('div', { style: 'margin-top:4px;padding:12px;border-radius:6px;background:rgba(251,191,36,0.08);border-left:3px solid var(--warning);font-size:12px;color:var(--text-muted);line-height:1.6' },
    isJuly
      ? `Pay ${fmtE(amount)} to the Cyprus Tax Department by 31 July ${year}. Late payment attracts a 10% additional charge. The 2nd instalment is due 31 December ${year}.`
      : `Pay ${fmtE(amount)} by 31 December ${year}. Before paying, use the December Revision section to check whether this amount needs adjusting based on updated year-end estimates. Late payment attracts a 10% additional charge.`
  ));
  openModal({ title: `${isJuly ? '1st' : '2nd'} Instalment — ${isJuly ? '31 Jul' : '31 Dec'} ${year}`, body });
}

function modalFinalBalance() {
  const s        = cfg();
  const c        = calcAll(s);
  const year     = s.year || String(new Date().getFullYear());
  const nextYear = String(Number(year) + 1);

  const body = el('div');
  body.appendChild(mkSummaryGrid([
    { label: 'Provisional Tax Paid', value: fmtE(c.corpTax), sub: 'Jul + Dec instalments' },
    { label: 'Current Estimate',     value: fmtE(c.corpTax), sub: 'Based on your inputs' },
    { label: 'Final Balance',        value: '—',             sub: 'Determined after audit' },
    { label: 'Deadline',             value: `1 Aug ${nextYear}` },
  ], 4));
  body.appendChild(el('div', { style: 'margin-top:4px;padding:12px;border-radius:6px;background:rgba(99,102,241,0.08);border-left:3px solid var(--accent);font-size:12px;color:var(--text-muted);line-height:1.6' },
    `The final balance is settled after submitting audited accounts. If actual profit exceeded estimates, pay the difference plus any applicable interest. If lower, you receive a credit or refund. The deadline for the final balance payment is 1 August ${nextYear}.`
  ));
  openModal({ title: `Final Balance — 1 Aug ${nextYear}`, body });
}

// ── December Revision KPI modals ─────────────────────────────────────────────

function modalDecRevProfit() {
  const s = cfg();
  const c = calcAll(s);
  const delta = c.revProfit - c.estProfit;
  const rows = [['Revised Revenue', '', fmtE(safeN(s.decRevRevenue))], ['Revised Expenses', '−', fmtE(safeN(s.decRevExpenses))]];
  if (safeN(s.decRevNonDeductible) > 0) rows.push(['Non-deductible add-back', '+', fmtE(safeN(s.decRevNonDeductible))]);
  if (safeN(s.decRevAllowances)    > 0) rows.push(['Tax allowances', '−', fmtE(safeN(s.decRevAllowances))]);
  rows.push(['Revised Taxable Profit', '=', fmtE(c.revProfit)]);

  const body = el('div');
  body.appendChild(mkSummaryGrid([
    { label: 'Original Estimate', value: fmtE(c.estProfit) },
    { label: 'Revised Estimate',  value: fmtE(c.revProfit) },
    { label: 'Change',            value: (delta >= 0 ? '+' : '−') + fmtE(Math.abs(delta)), sub: delta > 0 ? 'Profit up' : delta < 0 ? 'Profit down' : 'No change' },
    { label: 'Tax Impact',        value: (delta >= 0 ? '+' : '−') + fmtE(Math.abs(delta) * c.rate / 100), sub: `At ${c.rate}% rate` },
  ], 4));
  body.appendChild(mkSectionLabel('Revised Calculation'));
  body.appendChild(mkModalTable([{ label: 'Item' }, { label: '' }, { label: 'Amount', right: true }], rows));
  openModal({ title: 'Revised Taxable Profit vs Original', body, large: false });
}

function modalDecRevTax() {
  const s     = cfg();
  const c     = calcAll(s);
  const delta = c.revisedAnnualTax - c.corpTax;

  const body = el('div');
  body.appendChild(mkSummaryGrid([
    { label: 'Original Corp Tax',  value: fmtE(c.corpTax),          sub: 'From Annual Estimate' },
    { label: 'Revised Corp Tax',   value: fmtE(c.revisedAnnualTax) },
    { label: 'Tax Change',         value: (delta >= 0 ? '+' : '−') + fmtE(Math.abs(delta)), sub: delta > 0 ? 'More tax required' : delta < 0 ? 'Less tax required' : 'No change' },
    { label: 'Rate Applied',       value: `${c.rate}%` },
  ], 4));
  body.appendChild(el('div', { style: 'margin-top:4px;padding:12px;border-radius:6px;background:rgba(99,102,241,0.08);border-left:3px solid var(--accent);font-size:12px;color:var(--text-muted);line-height:1.6' },
    delta > 0
      ? `Your revised estimates show ${fmtE(delta)} more in corporation tax than originally planned. Check the Required Dec Payment card to see how much more you owe in December.`
      : delta < 0
        ? `Your revised estimates show ${fmtE(Math.abs(delta))} less in corporation tax than originally planned. You may have overpaid in July — see the Overpayment card.`
        : 'Your revised estimates match the original — no adjustment to the December payment needed.'
  ));
  openModal({ title: 'Revised Corp Tax vs Original Estimate', body, large: false });
}

function modalJulyPaid() {
  const s = cfg();
  const c = calcAll(s);
  const coverOrig    = c.corpTax        > 0 ? (c.alreadyPaid / c.corpTax        * 100).toFixed(1) : '—';
  const coverRevised = c.revisedAnnualTax > 0 ? (c.alreadyPaid / c.revisedAnnualTax * 100).toFixed(1) : '—';
  const surplus = c.alreadyPaid - c.revisedAnnualTax;

  const body = el('div');
  body.appendChild(mkSummaryGrid([
    { label: 'July Payment',             value: fmtE(c.alreadyPaid) },
    { label: '% of Original Tax',        value: `${coverOrig}%`,    sub: `Original: ${fmtE(c.corpTax)}` },
    { label: '% of Revised Tax',         value: `${coverRevised}%`, sub: `Revised: ${fmtE(c.revisedAnnualTax)}` },
    { label: surplus >= 0 ? 'Surplus Paid' : 'Still Owed', value: fmtE(Math.abs(surplus)), sub: surplus >= 0 ? 'Overpaid so far' : 'Remaining liability' },
  ], 4));
  openModal({ title: 'July Payment — Coverage Analysis', body, large: false });
}

function modalReqDecPayment() {
  const s    = cfg();
  const c    = calcAll(s);
  const year = s.year || String(new Date().getFullYear());
  const delta = c.reqDecPayment - c.decPayment;

  const body = el('div');
  body.appendChild(mkSummaryGrid([
    { label: 'Original Dec Plan',     value: fmtE(c.decPayment),     sub: '50% of original estimate' },
    { label: 'Required Dec Payment',  value: fmtE(c.reqDecPayment),  sub: delta > 0 ? '↑ More than planned' : delta < 0 ? '↓ Less than planned' : 'Same as planned' },
    { label: 'Change vs Plan',        value: (delta >= 0 ? '+' : '−') + fmtE(Math.abs(delta)) },
    { label: 'Deadline Status',       value: daysLabel(`${year}-12-31`) },
  ], 4));
  body.appendChild(el('div', { style: 'margin-top:4px;padding:12px;border-radius:6px;' + (c.reqDecPayment > 0 ? 'background:rgba(251,191,36,0.08);border-left:3px solid var(--warning)' : 'background:rgba(16,185,129,0.08);border-left:3px solid var(--success)') + ';font-size:12px;color:var(--text-muted);line-height:1.6' },
    c.reqDecPayment > 0
      ? `Pay ${fmtE(c.reqDecPayment)} by 31 December ${year}. Failure to pay the correct amount results in a 10% surcharge on the underpaid portion.`
      : `Your July payment fully covers the revised annual tax liability. No December payment is required.`
  ));
  openModal({ title: `Required December Payment — 31 Dec ${year}`, body, large: false });
}

function modalOverpayment() {
  const s = cfg();
  const c = calcAll(s);

  const body = el('div');
  body.appendChild(mkSummaryGrid([
    { label: 'July Payment',       value: fmtE(c.alreadyPaid) },
    { label: 'Revised Annual Tax', value: fmtE(c.revisedAnnualTax) },
    { label: 'Overpayment',        value: fmtE(c.overpayment) },
    { label: 'No Dec Payment Due', value: 'Confirmed' },
  ], 4));
  body.appendChild(mkSectionLabel('Your Options'));
  body.appendChild(mkModalTable(
    ['Option', 'Description'],
    [
      ['Offset against final balance', `Apply the ${fmtE(c.overpayment)} credit toward the final corporation tax balance due after the year-end audit (1 Aug).`],
      ['Claim a refund', 'Request a refund from the Cyprus Tax Department after the final assessment is issued. Processing times vary.'],
    ]
  ));
  openModal({ title: 'July Overpayment — Options', body, large: true });
}

// ─────────────────────────────────────────────────────────────────────────────

export default {
  id: 'cyprus-tax',
  label: 'Cyprus Corp Tax',
  icon: '§',
  render(container) { container.appendChild(build()); },
  refresh() {
    const c = document.getElementById('content');
    if (!c) return;
    c.innerHTML = '';
    c.appendChild(build());
  },
  destroy() {}
};

function build() {
  const wrap = el('div', { style: 'padding:16px;max-width:1100px' });

  wrap.appendChild(el('div', { style: 'margin-bottom:20px' },
    el('div', { style: 'font-size:18px;font-weight:700;color:var(--text)' }, 'Cyprus Provisional Tax Calculator'),
    el('div', { style: 'font-size:12px;color:var(--text-muted);margin-top:4px' },
      'Estimate corporate income tax instalments and avoid the 10% additional charge for underestimation.')
  ));

  const resultsEl       = el('div');
  const safetyDisplayEl = el('div');

  const renderSafetyDisplay = () => {
    safetyDisplayEl.innerHTML = '';
    const c = calcAll(cfg());
    if (c.finalTax === 0) {
      safetyDisplayEl.appendChild(el('div', { style: 'color:var(--text-muted);font-size:13px;font-style:italic' }, 'Enter an estimated final tax liability above to see the safety check.'));
      return;
    }
    safetyDisplayEl.appendChild(el('div', { class: 'grid grid-3', style: 'margin-bottom:12px' },
      mkKpiCard({ label: 'Planned Provisional Tax', value: fmtE(c.corpTax) }),
      mkKpiCard({ label: 'Minimum Required (75%)',  value: fmtE(c.minRequired75), subtitle: `75% of ${fmtE(c.finalTax)}` }),
      mkKpiCard({ label: 'Shortfall',               value: fmtE(c.shortfall), variant: c.shortfall > 0 ? 'danger' : 'success' })
    ));
    const safe = c.safe;
    safetyDisplayEl.appendChild(el('div', {
      style: `padding:12px 14px;border-radius:var(--radius-sm);border-left:4px solid var(--${safe ? 'success' : 'danger'});background:rgba(${safe ? '16,185,129' : '239,68,68'},0.07)`
    },
      el('span', { class: `badge ${safe ? 'success' : 'danger'}` }, safe ? '✓ No additional charge risk' : '⚠ Risk of 10% additional charge'),
      el('div', { style: 'font-size:12px;color:var(--text-muted);margin-top:6px' },
        safe ? 'Your planned provisional tax covers at least 75% of the estimated final tax liability.'
             : `Increase provisional tax by ${fmtE(c.shortfall)} to reach the 75% threshold.`)
    ));
  };

  const decDisplayEl = el('div', { style: 'margin-top:16px' });
  const renderDecDisplay = () => {
    decDisplayEl.innerHTML = '';
    const c    = calcAll(cfg());
    const s    = cfg();
    const year = s.year || String(new Date().getFullYear());
    if (c.revProfit === 0 && safeN(s.decRevRevenue) === 0) {
      decDisplayEl.appendChild(el('div', { style: 'color:var(--text-muted);font-size:13px;font-style:italic' }, 'Enter revised year-end estimates above to see the required December payment.'));
      return;
    }
    decDisplayEl.appendChild(el('div', { class: 'grid grid-3 mb-16' },
      mkKpiCard({ label: 'Revised Taxable Profit',          value: fmtE(c.revProfit),         onClick: modalDecRevProfit }),
      mkKpiCard({ label: `Revised Corp Tax (${c.rate}%)`,   value: fmtE(c.revisedAnnualTax),  onClick: modalDecRevTax }),
      mkKpiCard({ label: 'Already Paid in July',            value: fmtE(c.alreadyPaid),       onClick: modalJulyPaid })
    ));
    decDisplayEl.appendChild(el('div', { class: 'grid grid-2' },
      mkKpiCard({
        label:   `Required 2nd Instalment — 31 Dec ${year}`,
        value:   fmtE(c.reqDecPayment),
        variant: c.reqDecPayment > 0 ? 'warning' : 'success',
        subtitle: c.reqDecPayment > 0 ? 'Pay by 31 December' : 'No additional payment required',
        onClick: modalReqDecPayment,
      }),
      c.overpayment > 0
        ? mkKpiCard({ label: 'July Overpayment', value: fmtE(c.overpayment), variant: 'success', subtitle: 'Offset or refund — click for options', onClick: modalOverpayment })
        : mkKpiCard({ label: 'Overpayment', value: fmtE(0), subtitle: 'None' })
    ));
  };

  const recalc = () => {
    resultsEl.innerHTML = '';
    resultsEl.appendChild(buildResultsCard(calcAll(cfg()), cfg()));
    renderSafetyDisplay();
    renderDecDisplay();
  };

  wrap.appendChild(buildSettingsCard(recalc));
  wrap.appendChild(buildEstimateCard(recalc));
  wrap.appendChild(resultsEl);
  wrap.appendChild(buildSafetyCard(safetyDisplayEl, renderSafetyDisplay, recalc));
  wrap.appendChild(buildDecRevisionCard(decDisplayEl, renderDecDisplay, recalc));

  recalc();
  return wrap;
}

// ── Section 1 ────────────────────────────────────────────────────────────────
function buildSettingsCard(onChange) {
  const s    = cfg();
  const card = el('div', { class: 'card mb-16' });
  card.appendChild(el('div', { class: 'card-header' },
    el('div', {},
      el('div', { class: 'card-title' }, 'Tax Settings'),
      el('div', { class: 'card-subtitle' }, 'Corporate tax rate and safety buffer')
    )
  ));
  const body = el('div', { style: 'padding:0 16px 16px' });

  const curYear = String(new Date().getFullYear());
  const years   = [...new Set([curYear, ...availableYears()])].sort().reverse();
  const yearSel = select(years.map(y => ({ value: y, label: y })), s.year || curYear);
  yearSel.onchange = () => { persist({ year: yearSel.value }); onChange(); };

  const rateI = input({ type: 'number', value: s.corpTaxRate ?? 15, min: 0, max: 100, step: 0.1, style: 'width:110px' });
  rateI.oninput = () => { persist({ corpTaxRate: safeN(rateI.value) }); onChange(); };

  const bufChk = el('input', { type: 'checkbox' });
  bufChk.checked = !!s.bufferEnabled;
  const bufPctI = input({ type: 'number', value: s.bufferPct ?? 10, min: 0, max: 100, step: 0.1, style: 'width:80px' });
  bufPctI.oninput = () => { persist({ bufferPct: safeN(bufPctI.value) }); onChange(); };
  bufChk.onchange = () => { persist({ bufferEnabled: bufChk.checked }); onChange(); };

  body.appendChild(el('div', { style: 'display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px' },
    formRow('Tax Year', yearSel),
    formRow('Corporate Tax Rate',
      el('div', { style: 'display:flex;align-items:center;gap:6px' }, rateI, el('span', { style: 'color:var(--text-muted);font-size:13px' }, '%')),
      'Cyprus standard rate: 15% from tax year 2026 onwards (12.5% for years before 2026)'),
    formRow('Safety Buffer',
      el('div', { style: 'display:flex;align-items:center;gap:10px' },
        el('label', { style: 'display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px;white-space:nowrap' }, bufChk, 'Enable'),
        bufPctI, el('span', { style: 'color:var(--text-muted);font-size:13px' }, '%')),
      'Inflates estimate to reduce underpayment risk')
  ));
  card.appendChild(body);
  return card;
}

// ── Section 2 ────────────────────────────────────────────────────────────────
function buildEstimateCard(onChange) {
  const s    = cfg();
  const card = el('div', { class: 'card mb-16' });

  const prefillBtn = button('↓ Prefill from actuals & forecast', { variant: 'sm ghost', onClick: () => prefillFromActuals(onChange) });
  card.appendChild(el('div', { class: 'card-header' },
    el('div', {},
      el('div', { class: 'card-title' }, 'Annual Estimate'),
      el('div', { class: 'card-subtitle' }, 'Expected full-year revenue and expenses')
    ),
    prefillBtn
  ));
  const body = el('div', { style: 'padding:0 16px 16px' });

  const breakdownEl = el('div');
  const renderBreakdown = () => {
    const s2 = cfg();
    breakdownEl.innerHTML = '';
    const totalRev = safeN(s2.actualRevenue) + safeN(s2.forecastRevenue);
    const totalExp = safeN(s2.actualExpenses) + safeN(s2.forecastExpenses);
    if (totalRev === 0 && totalExp === 0) return;

    const bd = s2._prefillBreakdown || null;

    const row = (label, value, isTot) => el('div', {
      style: `display:flex;justify-content:space-between;align-items:center;padding:${isTot ? '6px 0 2px' : '4px 0'};${isTot ? 'border-top:1px solid var(--border);margin-top:4px;font-weight:600' : ''}`
    },
      el('span', { style: `font-size:12px;color:${isTot ? 'var(--text)' : 'var(--text-muted)'}` }, label),
      el('span', { style: `font-size:12px;color:${isTot ? 'var(--text)' : 'var(--text-muted)'};font-weight:${isTot ? '700' : '400'}` }, fmtE(value))
    );
    const subRow = (label, value, onClick) => {
      const d = el('div', {
        style: `display:flex;justify-content:space-between;align-items:center;padding:2px 0 2px 14px${onClick ? ';cursor:pointer' : ''}`
      },
        el('span', { style: `font-size:11px;color:var(--text-muted);opacity:.75${onClick ? ';text-decoration:underline;text-decoration-style:dotted;text-underline-offset:2px' : ''}` }, label),
        el('span', { style: 'font-size:11px;color:var(--text-muted);opacity:.75' }, fmtE(value))
      );
      if (onClick) d.onclick = onClick;
      return d;
    };

    // Revenue column
    const revEl = el('div');
    revEl.appendChild(el('div', { style: 'font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px' }, 'Revenue breakdown'));
    revEl.appendChild(row('Actual (paid to date)', safeN(s2.actualRevenue)));
    if (bd) {
      if (bd.paysCount > 0) revEl.appendChild(subRow(`↳ Rental payments (${bd.paysCount})`, bd.paysRevenue, modalRentalPayments));
      if (bd.invsCount > 0) revEl.appendChild(subRow(`↳ Invoices (${bd.invsCount})`, bd.invsRevenue, modalInvoiceRevenue));
    }
    revEl.appendChild(row('Forecast (remaining months)', safeN(s2.forecastRevenue)));
    if (bd && bd.fcRevCount > 0) revEl.appendChild(subRow(`↳ ${bd.fcRevLabel} in forecast`, safeN(s2.forecastRevenue), () => modalForecastEntities(true)));
    if (safeN(s2.nonDeductibleExpenses) > 0) revEl.appendChild(row('Non-deductible add-back', safeN(s2.nonDeductibleExpenses)));
    if (safeN(s2.taxAllowances) > 0) {
      revEl.appendChild(el('div', { style: 'display:flex;justify-content:space-between;align-items:center;padding:4px 0' },
        el('span', { style: 'font-size:12px;color:var(--text-muted)' }, 'Tax allowances'),
        el('span', { style: 'font-size:12px;color:var(--text-muted)' }, `−${fmtE(safeN(s2.taxAllowances))}`)
      ));
    }
    revEl.appendChild(row('Est. taxable revenue', totalRev + safeN(s2.nonDeductibleExpenses) - safeN(s2.taxAllowances), true));

    // Expenses column
    const expEl = el('div');
    expEl.appendChild(el('div', { style: 'font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px' }, 'Expenses breakdown'));
    expEl.appendChild(row('Actual (to date)', safeN(s2.actualExpenses)));
    if (bd && bd.expsByCat) {
      const cats = Object.entries(bd.expsByCat);
      for (const [cat, amt] of cats.slice(0, 5)) expEl.appendChild(subRow(`↳ ${cat}`, amt, () => modalExpenseCategory(cat)));
      if (cats.length > 5) {
        const rest = cats.slice(5).reduce((a, [, v]) => a + v, 0);
        expEl.appendChild(subRow(`↳ ${cats.length - 5} more categor${cats.length - 5 === 1 ? 'y' : 'ies'}`, rest));
      }
    }
    expEl.appendChild(row('Forecast (remaining months)', safeN(s2.forecastExpenses)));
    if (bd && bd.fcExpCount > 0 && safeN(s2.forecastExpenses) > 0) expEl.appendChild(subRow(`↳ ${bd.fcExpLabel} in forecast`, safeN(s2.forecastExpenses), () => modalForecastEntities(false)));
    expEl.appendChild(row('Total deductible expenses', totalExp, true));

    breakdownEl.appendChild(el('div', {
      style: 'margin-top:16px;padding:12px 14px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-sm);display:grid;grid-template-columns:1fr 1fr;gap:16px 24px'
    }, revEl, expEl));
  };

  const MAIN_FIELDS = new Set(['actualRevenue', 'forecastRevenue', 'actualExpenses', 'forecastExpenses']);
  const fi = (key, val, label, hint) => {
    const i = mkCurrencyInput(val, 'width:100%', v => {
      const patch = { [key]: v };
      if (MAIN_FIELDS.has(key)) patch._prefillBreakdown = null;
      persist(patch);
      onChange();
      renderBreakdown();
    });
    return formRow(label, i, hint);
  };

  body.appendChild(el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:20px' },
    el('div', {},
      el('div', { style: 'font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px;padding-bottom:6px;border-bottom:1px solid var(--border)' }, 'Revenue (€)'),
      fi('actualRevenue',   s.actualRevenue,   'Actual revenue to date'),
      fi('forecastRevenue', s.forecastRevenue, 'Forecast revenue, rest of year')
    ),
    el('div', {},
      el('div', { style: 'font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px;padding-bottom:6px;border-bottom:1px solid var(--border)' }, 'Expenses (€)'),
      fi('actualExpenses',   s.actualExpenses,   'Actual deductible expenses to date'),
      fi('forecastExpenses', s.forecastExpenses, 'Forecast deductible expenses, rest of year')
    )
  ));
  body.appendChild(el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-top:12px' },
    fi('nonDeductibleExpenses', s.nonDeductibleExpenses, 'Non-deductible expenses (€)', 'Entertainment, fines, etc. — added back to taxable profit'),
    fi('taxAllowances',         s.taxAllowances,         'Tax allowances / deductions (€)', 'Depreciation, R&D credits, etc. — reduces taxable profit')
  ));

  body.appendChild(breakdownEl);
  renderBreakdown();
  card.appendChild(body);
  return card;
}

function prefillFromActuals(onChange) {
  const s        = cfg();
  const year     = s.year || String(new Date().getFullYear());
  const today    = new Date().toISOString().slice(0, 10);
  const cutoff   = today < `${year}-12-31` ? today : `${year}-12-31`;
  const curMonth = cutoff.slice(0, 7);
  const s1       = `${year}-01-01`;

  const pays = listActivePayments().filter(p => p.status === 'paid' && p.date >= s1 && p.date <= cutoff && isCoRec(p));
  const invs = listActive('invoices').filter(i => i.status === 'paid' && (i.issueDate || '') >= s1 && (i.issueDate || '') <= cutoff);
  const exps = listActive('expenses').filter(e => !isCapEx(e) && e.date >= s1 && e.date <= cutoff && isCoRec(e));

  const rnd = v => Math.round(v * 100) / 100;
  const paysRevenue = pays.reduce((a, p) => a + toEUR(p.amount, p.currency, year), 0);
  const invsRevenue = invs.reduce((a, i) => a + toEUR(i.total, i.currency, year), 0);
  const actualRevenue  = paysRevenue + invsRevenue;
  const actualExpenses = exps.reduce((a, e) => a + toEUR(e.amount, e.currency, year), 0);

  const expsByCat = {};
  for (const e of exps) {
    const cat = e.category || 'Other';
    expsByCat[cat] = (expsByCat[cat] || 0) + toEUR(e.amount, e.currency, year);
  }

  let forecastRevenue = 0, forecastExpenses = 0;
  const fcRevIds = new Set(), fcExpIds = new Set();
  const propIds  = new Set((state.db.properties || []).map(p => p.id));
  const curMonthFrac = monthRemainingFraction(cutoff);
  for (const fc of (state.db.forecasts || []).filter(f => !f.deletedAt && f.year === Number(year))) {
    const eid = fc.entityId || fc.propertyId || fc.id;
    for (const [mk, md] of Object.entries(fc.months || {})) {
      if (mk < curMonth) continue;
      const frac = mk === curMonth ? curMonthFrac : 1;
      if (frac <= 0) continue;
      const rev = (Number(md.revenue) || 0) * frac;
      const exp = (Number(md.expenses) || 0) * frac;
      if (rev > 0) { fcRevIds.add(eid); forecastRevenue  += rev; }
      if (exp > 0) { fcExpIds.add(eid); forecastExpenses += exp; }
    }
  }

  const fcLabel = ids => {
    const pCount = [...ids].filter(id => propIds.has(id)).length;
    const sCount = ids.size - pCount;
    if (pCount && sCount) return `${pCount} propert${pCount === 1 ? 'y' : 'ies'} + ${sCount} service${sCount === 1 ? '' : 's'}`;
    if (pCount) return `${pCount} propert${pCount === 1 ? 'y' : 'ies'}`;
    return `${sCount} service${sCount === 1 ? '' : 's'}`;
  };

  persist({
    actualRevenue:    rnd(actualRevenue),
    actualExpenses:   rnd(actualExpenses),
    forecastRevenue:  rnd(forecastRevenue),
    forecastExpenses: rnd(forecastExpenses),
    _prefillBreakdown: {
      paysRevenue: rnd(paysRevenue), paysCount: pays.length,
      invsRevenue: rnd(invsRevenue), invsCount: invs.length,
      expsByCat: Object.fromEntries(Object.entries(expsByCat).sort(([, a], [, b]) => b - a).map(([k, v]) => [k, rnd(v)])),
      expsCount: exps.length,
      fcRevLabel: fcLabel(fcRevIds), fcRevCount: fcRevIds.size,
      fcExpLabel: fcLabel(fcExpIds), fcExpCount: fcExpIds.size,
      cutoff,
    }
  });

  const c = document.getElementById('content');
  if (c) { c.innerHTML = ''; c.appendChild(build()); }
  toast(`Prefilled: actuals to ${cutoff}, forecast from ${curMonth} onwards`, 'success');
}

// ── Section 3 ────────────────────────────────────────────────────────────────
function buildResultsCard(c, s) {
  const year     = s.year || String(new Date().getFullYear());
  const nextYear = String(Number(year) + 1);
  const card     = el('div', { class: 'card mb-16' });

  card.appendChild(el('div', { class: 'card-header' },
    el('div', {},
      el('div', { class: 'card-title' }, 'Provisional Tax Result'),
      el('div', { class: 'card-subtitle' }, `Estimated corporation tax liability for ${year}`)
    )
  ));
  const body = el('div', { style: 'padding:0 16px 16px' });

  const revSub = [
    safeN(s.actualRevenue)   > 0 ? `Actual ${fmtE(safeN(s.actualRevenue))}`   : null,
    safeN(s.forecastRevenue) > 0 ? `Forecast ${fmtE(safeN(s.forecastRevenue))}` : null,
  ].filter(Boolean).join(' + ') || null;
  const expSub = [
    safeN(s.actualExpenses)   > 0 ? `Actual ${fmtE(safeN(s.actualExpenses))}`   : null,
    safeN(s.forecastExpenses) > 0 ? `Forecast ${fmtE(safeN(s.forecastExpenses))}` : null,
  ].filter(Boolean).join(' + ') || null;

  body.appendChild(el('div', { class: 'grid grid-3 mb-16' },
    mkKpiCard({ label: 'Est. Annual Revenue',      value: fmtE(c.totalRevenue),    subtitle: revSub,  onClick: modalRevenueDetail }),
    mkKpiCard({ label: 'Est. Deductible Expenses', value: fmtE(c.totalDeductible), subtitle: expSub,  onClick: modalExpensesDetail }),
    mkKpiCard({ label: 'Est. Taxable Profit',      value: fmtE(c.estProfit),                          onClick: modalTaxableProfit })
  ));

  const taxRow = [];
  if (c.bufEnabled) {
    taxRow.push(mkKpiCard({
      label:    `Buffered Taxable Profit (+${c.bufPct}%)`,
      value:    fmtE(c.taxableProfit),
      subtitle: `${c.bufPct}% safety margin applied`,
      onClick:  modalBufferedProfit,
    }));
  }
  taxRow.push(mkKpiCard({
    label:   `Est. Corporation Tax (${c.rate}%)`,
    value:   fmtE(c.corpTax),
    variant: c.corpTax > 0 ? 'warning' : '',
    onClick: modalCorpTax,
  }));
  body.appendChild(el('div', { style: `display:grid;grid-template-columns:repeat(${taxRow.length},1fr);gap:16px;margin-bottom:16px` }, ...taxRow));

  body.appendChild(el('div', { style: 'font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px' }, 'Payment Schedule'));
  body.appendChild(el('div', { class: 'grid grid-3' },
    mkKpiCard({ label: `1st Instalment — 31 Jul ${year}`,   value: fmtE(c.julyPayment), subtitle: '50% of estimated corporation tax', onClick: () => modalInstalment('july') }),
    mkKpiCard({ label: `2nd Instalment — 31 Dec ${year}`,   value: fmtE(c.decPayment),  subtitle: '50% — revise in Dec if needed',   onClick: () => modalInstalment('dec') }),
    mkKpiCard({ label: `Final Balance — 1 Aug ${nextYear}`, value: '—',                 subtitle: 'Based on actual audited profit',  onClick: modalFinalBalance })
  ));

  card.appendChild(body);
  return card;
}

// ── Section 4 ────────────────────────────────────────────────────────────────
function buildSafetyCard(displayEl, renderDisplay, onChange) {
  const s    = cfg();
  const card = el('div', { class: 'card mb-16' });
  card.appendChild(el('div', { class: 'card-header' },
    el('div', {},
      el('div', { class: 'card-title' }, '75% Safety Check'),
      el('div', { class: 'card-subtitle' }, 'Provisional tax must cover ≥ 75% of actual final tax to avoid the 10% penalty')
    )
  ));
  const body = el('div', { style: 'padding:0 16px 16px' });

  const finalTaxI = mkCurrencyInput(s.estimatedFinalTax, 'width:220px', v => { persist({ estimatedFinalTax: v }); renderDisplay(); onChange(); });

  body.appendChild(formRow('Estimated final actual tax liability (€)', finalTaxI, 'Your best estimate of the audited year-end tax. Leave 0 if unknown.'));
  body.appendChild(displayEl);
  card.appendChild(body);
  return card;
}

// ── Section 5 ────────────────────────────────────────────────────────────────
function buildDecRevisionCard(displayEl, renderDisplay, onChange) {
  const s    = cfg();
  const year = s.year || String(new Date().getFullYear());
  const card = el('div', { class: 'card mb-16' });

  card.appendChild(el('div', { class: 'card-header' },
    el('div', {},
      el('div', { class: 'card-title' }, 'December Revision Check'),
      el('div', { class: 'card-subtitle' }, `Revise estimates before 31 December ${year} to determine the correct 2nd instalment`)
    )
  ));
  const body = el('div', { style: 'padding:0 16px 16px' });

  body.appendChild(el('p', { style: 'font-size:12px;color:var(--text-muted);margin:0 0 14px' },
    'Use revised full-year figures to check whether the second instalment needs increasing.'
  ));

  const fi = (key, val, label) => {
    const i = mkCurrencyInput(val, 'width:100%', v => { persist({ [key]: v }); renderDisplay(); });
    return formRow(label, i);
  };
  const julI = mkCurrencyInput(s.julPayment, 'width:220px', v => { persist({ julPayment: v }); renderDisplay(); });

  body.appendChild(el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:16px' },
    fi('decRevRevenue',       s.decRevRevenue,       'Revised expected annual revenue (€)'),
    fi('decRevExpenses',      s.decRevExpenses,      'Revised deductible expenses (€)')
  ));
  body.appendChild(el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:16px' },
    fi('decRevNonDeductible', s.decRevNonDeductible, 'Revised non-deductible expenses (€)'),
    fi('decRevAllowances',    s.decRevAllowances,    'Revised tax allowances / deductions (€)')
  ));
  body.appendChild(el('div', { style: 'margin-top:4px' },
    formRow('Amount already paid in July (€)', julI, 'Your actual first instalment payment')
  ));
  body.appendChild(displayEl);
  card.appendChild(body);
  return card;
}
