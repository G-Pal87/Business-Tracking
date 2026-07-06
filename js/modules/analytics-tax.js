// Tax — Annual P&L Report + Cyprus Provisional Tax Calculator
import { state, markDirty } from '../core/state.js';
import { el, input, select, button, formRow, toast, openModal } from '../core/ui.js';
import * as charts from '../core/charts.js';
import { COST_CATEGORIES } from '../core/config.js';
import {
  formatEUR, toEUR, byId,
  listActive, listActivePayments,
  resolveExpenseFields, isCapEx,
  newId, upsert, softDelete, companyPropIds,
  getPersonName
} from '../core/data.js';
import { mkSectionLabel, mkSummaryBox, mkSummaryGrid, mkModalTable, mkVarianceBadge, mkEmptyState, mkKpiCard } from './analytics-helpers.js';

// ── Module state ───────────────────────────────────────────────────────────────
const CHART_IDS  = ['tax-rev-exp-bar', 'tax-exp-cat-donut', 'tax-yoy-bar'];
const MONTH_LABELS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

let gYear  = null;
let gOwner = '';
let gTab   = 'pnl'; // 'pnl' | 'provisional'
let gScope = 'company'; // 'company' | 'all'

// ── Module export ──────────────────────────────────────────────────────────────
export default {
  id:    'analytics-tax',
  label: 'Tax',
  icon:  '🏛️',
  render(container) { container.appendChild(buildView()); },
  refresh() { rebuildView(); },
  destroy() { CHART_IDS.forEach(id => charts.destroy(id)); }
};

// ── Rebuild ────────────────────────────────────────────────────────────────────
function rebuildView() {
  CHART_IDS.forEach(id => charts.destroy(id));
  const c = document.getElementById('content');
  if (!c) return;
  c.innerHTML = '';
  c.appendChild(buildView());
}

// ── Main view (tab shell) ──────────────────────────────────────────────────────
function buildView() {
  const years = getDataYears();
  if (!gYear || !years.includes(gYear)) gYear = defaultYear();

  const wrap = el('div', { class: 'view active' });

  wrap.appendChild(el('div', { style: 'margin-bottom:16px' },
    el('h2', { style: 'margin:0 0 4px;font-size:20px;font-weight:700' }, 'Tax'),
    el('p',  { style: 'margin:0;font-size:13px;color:var(--text-muted)' },
      'Annual P&L reporting and provisional corporation tax calculator')
  ));

  // Tab bar
  const tabBar = el('div', {
    style: 'display:flex;gap:0;margin-bottom:24px;border-bottom:1px solid var(--border)'
  });
  for (const [key, label] of [['pnl', 'P&L Report'], ['provisional', 'Provisional Tax']]) {
    const isActive = gTab === key;
    const btn = el('button', {
      style: [
        'padding:9px 20px;border:none;border-bottom:2px solid',
        isActive
          ? 'var(--accent);color:var(--accent);font-weight:600;background:none'
          : 'transparent;color:var(--text-muted);background:none',
        ';cursor:pointer;font-size:13px;margin-bottom:-1px;transition:color 120ms,border-color 120ms'
      ].join(' ')
    }, label);
    btn.onclick = () => {
      if (gTab !== key) {
        CHART_IDS.forEach(id => charts.destroy(id));
        gTab = key;
        rebuildView();
      }
    };
    tabBar.appendChild(btn);
  }
  wrap.appendChild(tabBar);

  // Scope toggle (Company only / All incl. personal)
  const scopeBar = el('div', { style: 'display:flex;align-items:center;gap:8px;margin-bottom:12px' });
  scopeBar.appendChild(el('span', { style: 'font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text-muted)' }, 'Scope'));
  for (const [val, label] of [['company', 'Company only'], ['all', 'All (incl. personal)']]) {
    const isActive = gScope === val;
    const btn = el('button', {
      style: [
        'padding:4px 14px;border-radius:14px;border:1px solid;font-size:12px;cursor:pointer;transition:all 120ms',
        isActive
          ? 'border-color:var(--accent);background:var(--accent);color:#fff;font-weight:600'
          : 'border-color:var(--border);background:transparent;color:var(--text-muted)'
      ].join(';')
    }, label);
    btn.onclick = () => { if (gScope !== val) { gScope = val; rebuildView(); } };
    scopeBar.appendChild(btn);
  }
  wrap.appendChild(scopeBar);

  if (gTab === 'pnl') {
    wrap.appendChild(buildPnLContent(years));
  } else {
    wrap.appendChild(buildProvisionalTax());
  }

  return wrap;
}

// ═══════════════════════════════════════════════════════════════════════════════
// P&L REPORT TAB
// ═══════════════════════════════════════════════════════════════════════════════

function getDataYears() {
  const y = new Set();
  listActive('invoices').forEach(i => { const yr = (i.issueDate || '').slice(0, 4); if (yr >= '2000') y.add(yr); });
  listActivePayments().forEach(p => { const yr = (p.date || '').slice(0, 4); if (yr >= '2000') y.add(yr); });
  listActive('expenses').forEach(e => { const yr = (e.date || '').slice(0, 4); if (yr >= '2000') y.add(yr); });
  return [...y].sort().reverse();
}

function defaultYear() {
  const now = new Date();
  const currentYear = String(now.getFullYear());
  const years = getDataYears();
  if (!years.length) return currentYear;
  const prevYear = String(now.getFullYear() - 1);
  if (years.includes(prevYear)) return prevYear;
  return years[0];
}

function ownerMatches(record, ownerFilter) {
  if (!ownerFilter) return true;
  const ow = record.owner || 'both';
  if (ownerFilter === 'both') return true;
  return ow === ownerFilter || ow === 'both';
}

function invOwnerMatches(inv, ownerFilter) {
  if (!ownerFilter) return true;
  let ow = inv.owner;
  if (!ow && inv.clientId) ow = byId('clients', inv.clientId)?.owner;
  ow = ow || 'both';
  if (ownerFilter === 'both') return true;
  return ow === ownerFilter || ow === 'both';
}

function inYear(date, year) {
  return !!date && date.startsWith(year + '-');
}

function getTaxRate(year) {
  const rates = state.db.settings?.taxRates || {};
  return rates[String(year)] ?? state.db.settings?.corpTaxRate ?? 12.5;
}

function saveTaxRate(year, rate) {
  if (!state.db.settings) state.db.settings = {};
  if (!state.db.settings.taxRates) state.db.settings.taxRates = {};
  state.db.settings.taxRates[String(year)] = rate;
  markDirty();
}

function resolvedCatLabel(e) {
  const fields = resolveExpenseFields(e);
  const cat = fields.costCategory || e.costCategory || e.category || 'other';
  return COST_CATEGORIES[cat]?.label || cat;
}

function resolvedCatKey(e) {
  const fields = resolveExpenseFields(e);
  return fields.costCategory || e.costCategory || e.category || 'other';
}

function catColor(catKey) {
  return COST_CATEGORIES[catKey]?.color || '#8b93b0';
}

function getYearData(year, ownerFilter) {
  const coPropIds = companyPropIds();
  const isCoRec = gScope === 'all'
    ? () => true
    : r => !r.propertyId || coPropIds.has(r.propertyId);
  const payments = listActivePayments().filter(p =>
    p.status === 'paid' && inYear(p.date, year) && ownerMatches(p, ownerFilter) && isCoRec(p)
  );
  const invoices = listActive('invoices').filter(i =>
    i.status === 'paid' && inYear(i.issueDate || i.date, year) && invOwnerMatches(i, ownerFilter)
  );
  const allExp      = listActive('expenses').filter(e => inYear(e.date, year) && ownerMatches(e, ownerFilter) && isCoRec(e));
  const opExpenses  = allExp.filter(e => !isCapEx(e));
  const capExpenses = allExp.filter(e =>  isCapEx(e));

  const propMap = new Map(listActive('properties').map(p => [p.id, p]));
  const rentalPaymentsSTR = payments.filter(p => { const prop = p.propertyId ? propMap.get(p.propertyId) : null; return p.stream === 'short_term_rental' || prop?.type === 'short_term'; });
  const rentalPaymentsLTR = payments.filter(p => { const prop = p.propertyId ? propMap.get(p.propertyId) : null; return p.stream === 'long_term_rental'  || prop?.type === 'long_term';  });
  const invoicesCS    = invoices.filter(i => i.stream === 'customer_success');
  const invoicesMkt   = invoices.filter(i => i.stream === 'marketing_services');
  const invoicesOther = invoices.filter(i => !['customer_success','marketing_services'].includes(i.stream));
  if (invoicesOther.length > 0) {
    console.warn('[analytics-tax] invoicesOther catch-all:', invoicesOther.length, 'record(s). Streams:', [...new Set(invoicesOther.map(i => i.stream || '(none)'))]);
  }

  const sum = (arr, getAmt, getDate) => arr.reduce((s, x) => s + toEUR(getAmt(x), x.currency, getDate(x)), 0);
  const revSTR   = sum(rentalPaymentsSTR, p => p.amount, p => p.date);
  const revLTR   = sum(rentalPaymentsLTR, p => p.amount, p => p.date);
  const revCS    = sum(invoicesCS,        i => i.total,  i => i.issueDate || i.date);
  const revMkt   = sum(invoicesMkt,       i => i.total,  i => i.issueDate || i.date);
  const revOther = sum(invoicesOther,     i => i.total,  i => i.issueDate || i.date);
  const totalRevenue = revSTR + revLTR + revCS + revMkt + revOther;

  const catMap = new Map();
  for (const e of opExpenses) {
    const key = resolvedCatKey(e);
    catMap.set(key, (catMap.get(key) || 0) + toEUR(e.amount, e.currency, e.date));
  }

  const totalOpEx  = opExpenses.reduce((s, e)  => s + toEUR(e.amount, e.currency, e.date), 0);
  const totalCapEx = capExpenses.reduce((s, e) => s + toEUR(e.amount, e.currency, e.date), 0);
  const opProfit   = totalRevenue - totalOpEx;
  const netCash    = opProfit - totalCapEx;

  const monthly = Array.from({ length: 12 }, (_, mi) => {
    const mk  = `${year}-${String(mi + 1).padStart(2, '0')}`;
    const rev = payments.filter(p => p.date?.startsWith(mk)).reduce((s, p) => s + toEUR(p.amount, p.currency, p.date), 0)
              + invoices.filter(i => (i.issueDate || '').startsWith(mk)).reduce((s, i) => s + toEUR(i.total, i.currency, i.issueDate), 0);
    const opex = opExpenses.filter(e => e.date?.startsWith(mk)).reduce((s, e) => s + toEUR(e.amount, e.currency, e.date), 0);
    return { mk, rev, opex };
  });

  const forecasts = listActive('forecasts').filter(f => String(f.year) === String(year));
  let forecastRevenue = 0, forecastExpenses = 0;
  for (const f of forecasts) {
    if (f.yearTarget?.revenue)  forecastRevenue  += Number(f.yearTarget.revenue)  || 0;
    if (f.yearTarget?.expenses) forecastExpenses += Number(f.yearTarget.expenses) || 0;
  }
  const hasForecast = forecastRevenue > 0 || forecastExpenses > 0;
  const forecastNet = forecastRevenue - forecastExpenses;

  return {
    payments, invoices, opExpenses, capExpenses,
    rentalPaymentsSTR, rentalPaymentsLTR, invoicesCS, invoicesMkt, invoicesOther,
    revSTR, revLTR, revCS, revMkt, revOther, totalRevenue,
    catMap, totalOpEx, totalCapEx, opProfit, netCash,
    monthly,
    hasForecast, forecastRevenue, forecastExpenses, forecastNet
  };
}

function buildYearSelectorBar(years, selectedYear, selectedOwner, taxRate, onChange, onTaxRateChange) {
  const bar = el('div', {
    style: 'display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:16px;padding:12px 16px;background:var(--bg-elev-1);border:1px solid var(--border);border-radius:var(--radius-sm)'
  });

  const yearGroup = el('div', { style: 'display:flex;align-items:center;gap:6px;flex-wrap:wrap' });
  yearGroup.appendChild(el('span', { style: 'font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text-muted);margin-right:4px' }, 'Year'));
  for (const yr of years) {
    const isActive = yr === selectedYear;
    const pill = el('button', {
      style: ['padding:4px 12px;border-radius:14px;border:1px solid', isActive ? 'var(--accent);background:var(--accent);color:#fff;font-weight:600' : 'var(--border);background:transparent;color:var(--text-muted)', ';font-size:12px;cursor:pointer;transition:all 120ms'].join(' ')
    }, yr);
    pill.addEventListener('click', () => onChange(yr, selectedOwner));
    yearGroup.appendChild(pill);
  }
  bar.appendChild(yearGroup);
  bar.appendChild(el('div', { style: 'width:1px;height:24px;background:var(--border)' }));

  const ownerGroup = el('div', { style: 'display:flex;align-items:center;gap:6px' });
  ownerGroup.appendChild(el('span', { style: 'font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text-muted);margin-right:4px' }, 'Owner'));
  for (const [val, label] of [['', 'All'], ['you', getPersonName('you')], ['rita', getPersonName('rita')], ['both', 'Both']]) {
    const isActive = val === selectedOwner;
    const pill = el('button', {
      style: ['padding:4px 12px;border-radius:14px;border:1px solid', isActive ? 'var(--accent);background:var(--accent);color:#fff;font-weight:600' : 'var(--border);background:transparent;color:var(--text-muted)', ';font-size:12px;cursor:pointer;transition:all 120ms'].join(' ')
    }, label);
    pill.addEventListener('click', () => onChange(selectedYear, val));
    ownerGroup.appendChild(pill);
  }
  bar.appendChild(ownerGroup);
  bar.appendChild(el('div', { style: 'width:1px;height:24px;background:var(--border)' }));

  const rateI = input({ type: 'number', value: taxRate, min: 0, max: 100, step: 0.1, style: 'width:68px;padding:3px 6px;font-size:12px' });
  rateI.title = `Corporation tax rate applied to ${selectedYear} Operating Profit`;
  let rateDebounce;
  rateI.oninput = () => {
    clearTimeout(rateDebounce);
    rateDebounce = setTimeout(() => {
      const v = parseFloat(rateI.value);
      if (isFinite(v) && v >= 0 && v <= 100) onTaxRateChange(v);
    }, 600);
  };
  bar.appendChild(el('div', { style: 'display:flex;align-items:center;gap:5px' },
    el('span', { style: 'font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text-muted)' }, `${selectedYear} Tax Rate`),
    rateI,
    el('span', { style: 'font-size:12px;color:var(--text-muted)' }, '%')
  ));

  return bar;
}

function buildPnLTable(data, taxRate, year) {
  const { revSTR, revLTR, revCS, revMkt, revOther, totalRevenue, catMap, totalOpEx, totalCapEx, opProfit, netCash } = data;
  const taxableIncome = Math.max(0, opProfit);
  const estimatedTax  = taxableIncome * (taxRate / 100);
  const netAfterTax   = opProfit - estimatedTax;
  const wrap = el('div', { class: 'card mb-16', style: 'background:var(--bg-elev-2)' });
  wrap.appendChild(el('div', { class: 'card-header' },
    el('div', { class: 'card-title' }, 'Annual Profit & Loss Statement'),
    el('div', { style: 'font-size:12px;color:var(--text-muted)' }, 'Cash basis · EUR')
  ));

  const tbl   = el('table', { style: 'width:100%;border-collapse:collapse;font-size:13px;padding:16px' });
  const tbody = el('tbody');

  const mkRow = (label, value, opts = {}) => {
    const { isSectionHeader = false, isSectionTotal = false, isSubtotal = false, isSeparator = false, isPositive = null, indent = 0, onClick = null } = opts;
    if (isSeparator) {
      const tr = el('tr');
      tr.appendChild(el('td', { colspan: '2', style: 'padding:4px 16px;border-bottom:1px solid rgba(255,255,255,0.12)' }));
      return tr;
    }
    const tr = el('tr');
    let labelStyle = `padding:5px ${16 + indent * 16}px 5px 16px;`;
    let valueStyle = 'padding:5px 16px;text-align:right;';
    if (isSectionHeader) {
      labelStyle += 'font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--text-muted);padding-top:14px;';
      valueStyle  = 'display:none';
    } else if (isSectionTotal || isSubtotal) {
      labelStyle += 'font-weight:700;color:var(--text);';
      valueStyle += 'font-weight:700;';
      if (isPositive === true)  valueStyle += 'color:var(--success,#10b981);';
      if (isPositive === false) valueStyle += 'color:var(--danger,#ef4444);';
      if (isPositive === null)  valueStyle += 'color:var(--text);';
    } else {
      labelStyle += 'color:var(--text-muted);';
      valueStyle += 'color:var(--text-muted);';
    }
    tr.appendChild(el('td', { style: labelStyle }, label));
    if (!isSectionHeader) tr.appendChild(el('td', { style: valueStyle }, formatEUR(value)));
    if (onClick) {
      tr.style.cursor = 'pointer';
      tr.title = 'Click for breakdown';
      tr.addEventListener('mouseenter', () => { tr.style.background = 'rgba(255,255,255,0.05)'; });
      tr.addEventListener('mouseleave', () => { tr.style.background = ''; });
      tr.onclick = onClick;
    }
    return tr;
  };

  tbody.appendChild(mkRow('INCOME', 0, { isSectionHeader: true }));
  if (revSTR   > 0) tbody.appendChild(mkRow('Rental Revenue (STR)',       revSTR,   { indent: 1, onClick: () => openPnLRevenueModal('Rental Revenue (STR)', data.rentalPaymentsSTR, false, year) }));
  if (revLTR   > 0) tbody.appendChild(mkRow('Rental Revenue (LTR)',       revLTR,   { indent: 1, onClick: () => openPnLRevenueModal('Rental Revenue (LTR)', data.rentalPaymentsLTR, false, year) }));
  if (revCS    > 0) tbody.appendChild(mkRow('Service Revenue (CS)',        revCS,    { indent: 1, onClick: () => openPnLRevenueModal('Service Revenue (CS)', data.invoicesCS, true, year) }));
  if (revMkt   > 0) tbody.appendChild(mkRow('Service Revenue (Marketing)', revMkt,   { indent: 1, onClick: () => openPnLRevenueModal('Service Revenue (Marketing)', data.invoicesMkt, true, year) }));
  if (revOther > 0) tbody.appendChild(mkRow('Other Services',              revOther, { indent: 1, onClick: () => openPnLRevenueModal('Other Services', data.invoicesOther, true, year) }));
  tbody.appendChild(mkRow(null, null, { isSeparator: true }));
  tbody.appendChild(mkRow('Total Revenue', totalRevenue, { isSectionTotal: true, isPositive: totalRevenue >= 0 }));

  tbody.appendChild(mkRow('OPERATING EXPENSES', 0, { isSectionHeader: true }));
  for (const [catKey, amt] of [...catMap.entries()].sort((a, b) => b[1] - a[1])) {
    tbody.appendChild(mkRow(COST_CATEGORIES[catKey]?.label || catKey, amt, { indent: 1 }));
  }
  tbody.appendChild(mkRow(null, null, { isSeparator: true }));
  tbody.appendChild(mkRow('Total Operating Expenses', totalOpEx, { isSectionTotal: true, isPositive: false }));
  tbody.appendChild(mkRow('', 0, {}));
  tbody.appendChild(mkRow('Operating Profit', opProfit, { isSubtotal: true, isPositive: opProfit >= 0 }));

  tbody.appendChild(mkRow('CAPITAL EXPENDITURES (not P&L)', 0, { isSectionHeader: true }));
  tbody.appendChild(mkRow(null, null, { isSeparator: true }));
  tbody.appendChild(mkRow('Total CapEx', totalCapEx, { isSectionTotal: true, isPositive: null }));
  tbody.appendChild(mkRow('', 0, {}));
  tbody.appendChild(mkRow('Net Cash Used', netCash, { isSubtotal: true, isPositive: netCash >= 0 }));

  tbody.appendChild(mkRow(`TAX ESTIMATION — ${year} (${taxRate}%)`, 0, { isSectionHeader: true }));
  tbody.appendChild(mkRow('Taxable Income (Operating Profit)', taxableIncome, { indent: 1 }));
  if (opProfit < 0) tbody.appendChild(mkRow('Note: loss year — no tax due', 0, { indent: 1 }));
  tbody.appendChild(mkRow(null, null, { isSeparator: true }));
  tbody.appendChild(mkRow(`Estimated Corporation Tax @ ${taxRate}%`, estimatedTax, { isSectionTotal: true, isPositive: estimatedTax === 0 }));
  tbody.appendChild(mkRow('', 0, {}));
  tbody.appendChild(mkRow('Net After Tax (est.)', netAfterTax, { isSubtotal: true, isPositive: netAfterTax >= 0 }));

  tbl.appendChild(tbody);
  wrap.appendChild(el('div', { style: 'padding:0 0 16px' }, tbl));
  return wrap;
}

function openPnLRevenueModal(streamLabel, records, isInvoice, year) {
  if (!records || !records.length) { emptyModal(streamLabel, `No ${isInvoice ? 'invoices' : 'payments'} found for this stream in ${year}.`); return; }
  const propMap   = new Map(listActive('properties').map(p => [p.id, p]));
  const clientMap = new Map(listActive('clients').map(c => [c.id, c]));
  const byEntity = new Map(), byMonth = new Map();
  for (const r of records) {
    const amt  = isInvoice ? toEUR(r.total, r.currency, r.issueDate || r.date) : toEUR(r.amount, r.currency, r.date);
    const date = isInvoice ? (r.issueDate || r.date) : r.date;
    const eid  = isInvoice ? (r.clientId || '_') : (r.propertyId || '_');
    const cur  = byEntity.get(eid) || { rev: 0, n: 0 };
    cur.rev += amt; cur.n++;
    byEntity.set(eid, cur);
    const mo = (date || '').slice(0, 7);
    if (mo) byMonth.set(mo, (byMonth.get(mo) || 0) + amt);
  }
  const total    = [...byEntity.values()].reduce((a, d) => a + d.rev, 0);
  const entRows  = [...byEntity.entries()].sort(([, a], [, b]) => b.rev - a.rev);
  const moRows   = [...byMonth.entries()].sort(([a], [b]) => a.localeCompare(b));

  const body = el('div');
  body.appendChild(mkSummaryGrid([
    { label: 'Total Revenue', value: formatEUR(total) },
    { label: isInvoice ? 'Invoices' : 'Payments', value: String(records.length) },
    { label: 'Avg', value: formatEUR(total / records.length) },
    { label: isInvoice ? 'Clients' : 'Properties', value: String(entRows.length) }
  ], 4));
  body.appendChild(mkSectionLabel(`Revenue by ${isInvoice ? 'Client' : 'Property'}`));
  body.appendChild(mkModalTable(
    [{ label: isInvoice ? 'Client' : 'Property' }, { label: isInvoice ? 'Invoices' : 'Pmts', right: true }, { label: 'Revenue', right: true }, { label: 'Share', right: true, muted: true }],
    entRows.map(([id, d]) => {
      const name = isInvoice ? (clientMap.get(id)?.name || clientMap.get(id)?.company || 'Unknown') : (propMap.get(id)?.name || propMap.get(id)?.address || 'Unknown');
      return [name, String(d.n), formatEUR(d.rev), total > 0 ? `${(d.rev / total * 100).toFixed(1)}%` : '—'];
    })
  ));
  if (moRows.length) {
    body.appendChild(mkSectionLabel('Monthly Breakdown'));
    body.appendChild(mkModalTable([{ label: 'Month' }, { label: 'Revenue', right: true }, { label: 'Share', right: true, muted: true }], moRows.map(([mo, v]) => [mo, formatEUR(v), total > 0 ? `${(v / total * 100).toFixed(1)}%` : '—'])));
  }
  openModal({ title: `${streamLabel} — ${year}`, body, large: true });
}

function buildKpiCards(data, year, taxRate) {
  const { totalRevenue, totalOpEx, totalCapEx, opProfit, netCash, hasForecast, forecastNet } = data;
  const operatingMargin = totalRevenue > 0 ? ((totalRevenue - totalOpEx) / totalRevenue * 100) : 0;
  const taxableIncome   = Math.max(0, opProfit);
  const estimatedTax    = taxableIncome * (taxRate / 100);
  const netAfterTax     = opProfit - estimatedTax;

  if (totalRevenue === 0 && totalOpEx === 0 && totalCapEx === 0) {
    return mkEmptyState('No activity recorded for ' + year + '. Select a different year or add data.');
  }

  const grid = el('div', { style: 'display:grid;grid-template-columns:repeat(5,1fr);gap:12px;margin-bottom:16px' });

  // 1. Operating Margin
  grid.appendChild(mkKpiCard({
    label: 'Operating Margin', value: `${operatingMargin.toFixed(1)}%`,
    subtitle: operatingMargin > 80 ? 'High margin — service-led' : 'Revenue minus OpEx',
    variant: operatingMargin >= 50 ? 'success' : operatingMargin >= 20 ? 'warning' : 'danger',
    onClick: () => {
      const body = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });
      body.appendChild(mkSummaryGrid([
        { label: 'Total Revenue',    value: formatEUR(totalRevenue) },
        { label: 'Total OpEx',       value: formatEUR(totalOpEx) },
        { label: 'Operating Profit', value: formatEUR(opProfit) },
        { label: 'Operating Margin', value: `${operatingMargin.toFixed(2)}%` }
      ], 2));
      body.appendChild(el('div', { style: 'font-size:12px;color:var(--text-muted);line-height:1.5' }, 'Operating Margin = (Revenue − OpEx) ÷ Revenue × 100. Excludes CapEx as it is a balance-sheet item.'));
      openModal({ title: 'Operating Margin — Breakdown', body });
    }
  }));

  // 2. Estimated Corporation Tax
  grid.appendChild(mkKpiCard({
    label: `Est. Corp Tax @ ${taxRate}%`, value: formatEUR(estimatedTax),
    subtitle: opProfit <= 0 ? 'No taxable profit this year' : `On ${formatEUR(taxableIncome)} taxable income`,
    variant: estimatedTax > 0 ? 'danger' : '',
    onClick: () => {
      const body = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });
      body.appendChild(mkSummaryGrid([
        { label: 'Operating Profit',        value: formatEUR(opProfit),      sub: 'Taxable base' },
        { label: `Tax Rate (${year})`,       value: `${taxRate}%`,            sub: 'Corporation tax' },
        { label: 'Estimated Corp Tax',       value: formatEUR(estimatedTax),  sub: 'Gross liability' },
        { label: 'Net After Tax (est.)',     value: formatEUR(netAfterTax),   sub: opProfit > 0 ? 'After tax' : 'Loss year' }
      ], 2));
      body.appendChild(el('div', { style: 'font-size:12px;color:var(--text-muted);line-height:1.5;margin-top:8px' },
        `Tax rate for ${year} is set in the year selector bar above. Each year can have its own rate to account for rate changes. This is an estimate — consult your accountant for the precise figure.`
      ));
      openModal({ title: `Estimated Corporation Tax — ${year}`, body });
    }
  }));

  // 3. Tax-Deductible OpEx
  grid.appendChild(mkKpiCard({
    label: 'Tax-Deductible OpEx', value: formatEUR(totalOpEx), subtitle: 'Estimated deductible expenses',
    onClick: () => {
      const body = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });
      const catEntries = [...data.catMap.entries()].sort((a, b) => b[1] - a[1]);
      body.appendChild(mkSectionLabel('OpEx by Category'));
      body.appendChild(mkModalTable(['Category', 'Amount', '% of OpEx'], catEntries.map(([k, v]) => [COST_CATEGORIES[k]?.label || k, formatEUR(v), totalOpEx > 0 ? (v / totalOpEx * 100).toFixed(1) + '%' : '—'])));
      body.appendChild(el('div', { style: 'font-size:12px;color:var(--text-muted);line-height:1.5;margin-top:8px' }, 'Operating expenses are generally deductible for tax purposes. CapEx is typically depreciated over the asset\'s useful life.'));
      openModal({ title: 'Tax-Deductible OpEx — Breakdown', body, large: true });
    }
  }));

  // 4. Capital Deployed
  grid.appendChild(mkKpiCard({
    label: 'Capital Deployed', value: formatEUR(totalCapEx),
    subtitle: totalCapEx === 0 ? 'No capital assets this year' : 'Non-deductible (depreciated)',
    variant: totalCapEx > 0 ? 'warning' : '',
    onClick: () => {
      const body = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });
      const capByCategory = new Map();
      for (const e of data.capExpenses) capByCategory.set(resolvedCatKey(e), (capByCategory.get(resolvedCatKey(e)) || 0) + toEUR(e.amount, e.currency, e.date));
      const catEntries = [...capByCategory.entries()].sort((a, b) => b[1] - a[1]);
      body.appendChild(mkSummaryGrid([
        { label: 'Total CapEx',     value: formatEUR(totalCapEx), sub: `${data.capExpenses.length} items` },
        { label: 'As % of Revenue', value: totalRevenue > 0 ? (totalCapEx / totalRevenue * 100).toFixed(1) + '%' : '—', sub: 'Capital intensity' }
      ], 2));
      if (catEntries.length > 0) {
        body.appendChild(mkSectionLabel('CapEx by Category'));
        body.appendChild(mkModalTable(['Category', 'Amount', '% of CapEx'], catEntries.map(([k, v]) => [COST_CATEGORIES[k]?.label || k, formatEUR(v), totalCapEx > 0 ? (v / totalCapEx * 100).toFixed(1) + '%' : '—'])));
      } else {
        body.appendChild(mkEmptyState('No CapEx recorded for this year.'));
      }
      openModal({ title: 'Capital Deployed — Breakdown', body, large: true });
    }
  }));

  // 5. Year vs Forecast
  if (hasForecast) {
    const actualNet    = opProfit;
    const variance     = actualNet - forecastNet;
    const forecastCard = mkKpiCard({
      label: 'Year vs Forecast', value: formatEUR(actualNet), variant: variance >= 0 ? 'success' : 'danger',
      onClick: () => {
        const body = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });
        body.appendChild(mkSummaryGrid([
          { label: 'Actual Revenue',    value: formatEUR(totalRevenue) },
          { label: 'Forecast Revenue',  value: formatEUR(data.forecastRevenue) },
          { label: 'Actual OpEx',       value: formatEUR(totalOpEx) },
          { label: 'Forecast Expenses', value: formatEUR(data.forecastExpenses) },
          { label: 'Actual Net (OpEx)', value: formatEUR(actualNet) },
          { label: 'Forecast Net',      value: formatEUR(forecastNet) }
        ], 2));
        body.appendChild(mkSectionLabel('Variance'));
        body.appendChild(mkModalTable(['Metric', 'Actual', 'Forecast', 'Variance'], [
          ['Revenue',    formatEUR(totalRevenue), formatEUR(data.forecastRevenue),  formatEUR(totalRevenue - data.forecastRevenue)],
          ['Expenses',   formatEUR(totalOpEx),    formatEUR(data.forecastExpenses), formatEUR(totalOpEx - data.forecastExpenses)],
          ['Net (OpEx)', formatEUR(actualNet),    formatEUR(forecastNet),           formatEUR(variance)]
        ]));
        openModal({ title: `${year} Actual vs Forecast`, body, large: true });
      }
    });
    const subtitleEl = el('div', { style: 'font-size:11px;color:var(--text-muted);margin-top:2px;display:flex;align-items:center;gap:4px' });
    subtitleEl.appendChild(mkVarianceBadge(variance, formatEUR(Math.abs(variance))));
    subtitleEl.appendChild(document.createTextNode(' vs forecast net'));
    const accentBar = forecastCard.querySelector('.kpi-accent-bar');
    forecastCard.insertBefore(subtitleEl, accentBar);
    grid.appendChild(forecastCard);
  } else {
    grid.appendChild(mkKpiCard({
      label: 'Year vs Forecast', value: '—', subtitle: 'No forecast set for this year',
      onClick: () => {
        let tRevenue = 0, tExpenses = 0;
        const body = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });
        body.appendChild(el('p', { style: 'font-size:13px;color:var(--text-muted);line-height:1.6;margin:0' },
          `Set a simple revenue and expense target for ${year} to enable the actual vs forecast comparison.`
        ));
        const revI = mkCurrencyInput(0, 'width:100%', v => { tRevenue = v; });
        const expI = mkCurrencyInput(0, 'width:100%', v => { tExpenses = v; });
        body.appendChild(el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:16px' },
          formRow(`${year} Revenue Target (€)`, revI),
          formRow(`${year} Expense Target (€)`, expI)
        ));
        const saveBtn = button('Save Year Targets', { variant: 'primary sm' });
        saveBtn.onclick = () => {
          if (tRevenue <= 0 && tExpenses <= 0) { toast('Enter at least one target', 'error'); return; }
          const existing = listActive('forecasts').find(f => String(f.year) === String(year) && f.entityId === '_portfolio_target');
          upsert('forecasts', { id: existing?.id || newId('fc'), year: Number(year), entityId: '_portfolio_target', type: 'portfolio', yearTarget: { revenue: tRevenue, expenses: tExpenses } });
          markDirty();
          rebuildView();
          toast(`${year} forecast targets saved`, 'success');
        };
        body.appendChild(el('div', {}, saveBtn));
        openModal({ title: `Set Year Forecast — ${year}`, body });
      }
    }));
  }

  return grid;
}

function buildExpenseCategoryTable(data) {
  const { catMap, totalOpEx, capExpenses } = data;
  const capCatMap = new Map();
  for (const e of capExpenses) capCatMap.set(resolvedCatKey(e), (capCatMap.get(resolvedCatKey(e)) || 0) + toEUR(e.amount, e.currency, e.date));

  const wrap = el('div', { class: 'card mb-16' });
  wrap.appendChild(el('div', { class: 'card-header' },
    el('div', { class: 'card-title' }, 'Expense Categories'),
    el('div', { style: 'font-size:12px;color:var(--text-muted)' }, 'Click a row to see individual records')
  ));

  const rows = [];
  for (const [catKey, amt] of [...catMap.entries()].sort((a, b) => b[1] - a[1])) {
    rows.push({ catKey, amt, count: data.opExpenses.filter(e => resolvedCatKey(e) === catKey).length, isCapex: false, expList: data.opExpenses.filter(e => resolvedCatKey(e) === catKey) });
  }
  for (const [catKey, amt] of [...capCatMap.entries()].sort((a, b) => b[1] - a[1])) {
    rows.push({ catKey, amt, count: capExpenses.filter(e => resolvedCatKey(e) === catKey).length, isCapex: true, expList: capExpenses.filter(e => resolvedCatKey(e) === catKey) });
  }

  if (!rows.length) { wrap.appendChild(mkEmptyState('No expense data for this year.')); return wrap; }

  const tbl  = el('table', { style: 'width:100%;border-collapse:collapse;font-size:13px' });
  const hrow = el('tr');
  ['Category', 'Count', 'Total (€)', '% of OpEx', 'Type'].forEach((h, hi) => {
    hrow.appendChild(el('th', { style: `padding:8px 12px;text-align:${hi === 0 ? 'left' : 'right'};font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:var(--text-muted);border-bottom:1px solid rgba(255,255,255,0.08)` }, h));
  });
  tbl.appendChild(el('thead', {}, hrow));

  const tbody = el('tbody');
  rows.forEach((row, ri) => {
    const tr = el('tr', { style: [ri % 2 === 1 ? 'background:rgba(255,255,255,0.02)' : '', 'cursor:pointer;transition:background 80ms'].join(';') });
    tr.addEventListener('mouseenter', () => { tr.style.background = 'rgba(255,255,255,0.05)'; });
    tr.addEventListener('mouseleave', () => { tr.style.background = ri % 2 === 1 ? 'rgba(255,255,255,0.02)' : ''; });
    const labelCell = el('td', { style: 'padding:8px 12px;display:flex;align-items:center;gap:8px' });
    labelCell.appendChild(el('span', { style: `width:8px;height:8px;border-radius:50%;background:${catColor(row.catKey)};flex-shrink:0;display:inline-block` }));
    labelCell.appendChild(document.createTextNode(COST_CATEGORIES[row.catKey]?.label || row.catKey));
    tr.appendChild(labelCell);
    const pctOfOpEx = (!row.isCapex && totalOpEx > 0) ? (row.amt / totalOpEx * 100).toFixed(1) + '%' : '—';
    [[String(row.count), 'right'], [formatEUR(row.amt), 'right'], [pctOfOpEx, 'right'], [row.isCapex ? 'CapEx' : 'OpEx', 'right']].forEach(([text, align]) => {
      tr.appendChild(el('td', { style: `padding:8px 12px;text-align:${align};color:var(--text-muted)` }, text));
    });
    tr.onclick = () => openCategoryModal(row.catKey, row.expList, row.isCapex, row.amt);
    tbody.appendChild(tr);
  });
  tbl.appendChild(tbody);
  wrap.appendChild(el('div', { style: 'padding:0 0 8px' }, tbl));
  return wrap;
}

function openCategoryModal(catKey, expList, isCapex, total) {
  const label = COST_CATEGORIES[catKey]?.label || catKey;
  const body  = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });
  body.appendChild(mkSummaryGrid([
    { label: 'Category',   value: label,                                                                                 sub: isCapex ? 'CapEx' : 'OpEx' },
    { label: 'Total',      value: formatEUR(total),                                                                      sub: `${expList.length} records` },
    { label: 'Avg Amount', value: expList.length > 0 ? formatEUR(total / expList.length) : '—',                         sub: 'per expense' }
  ], 3));
  body.appendChild(mkSectionLabel('Individual Records'));
  const sorted = [...expList].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  body.appendChild(mkModalTable(
    ['Date', 'Description', 'Property / Vendor', 'Amount (EUR)'],
    sorted.map(e => {
      const prop   = e.propertyId ? byId('properties', e.propertyId)?.name : null;
      const vendor = e.vendorId   ? byId('vendors', e.vendorId)?.name      : null;
      return [e.date || '—', e.description || e.notes || '—', prop || vendor || '—', formatEUR(toEUR(e.amount, e.currency, e.date))];
    })
  ));
  openModal({ title: `${label} — Expense Detail`, body, large: true });
}

const CHART_FALLBACK_MSG = 'Chart unavailable — network connection required to load charting library';

function mkChartWrap(id) {
  const w = el('div', { class: 'chart-wrap tall', style: 'position:relative' });
  w.appendChild(el('canvas', { id }));
  w.appendChild(el('p', {
    id: `${id}-fallback`,
    style: 'display:none;text-align:center;color:var(--text-muted);font-size:13px;padding:40px 16px;margin:0;position:absolute;inset:0;display:none;align-items:center;justify-content:center'
  }, CHART_FALLBACK_MSG));
  return w;
}

function buildCharts(data, year) {
  const wrap = el('div');
  const row1 = el('div', { style: 'display:grid;grid-template-columns:2fr 1fr;gap:16px;margin-bottom:16px' });
  row1.appendChild(el('div', { class: 'card' },
    el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'Monthly Revenue vs Operating Expenses'), el('div', { style: 'font-size:12px;color:var(--text-muted)' }, 'Operating P&L view — CapEx excluded')),
    mkChartWrap('tax-rev-exp-bar')
  ));
  row1.appendChild(el('div', { class: 'card' },
    el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'OpEx by Category'), el('div', { style: 'font-size:12px;color:var(--text-muted)' }, 'Click slice for detail')),
    mkChartWrap('tax-exp-cat-donut')
  ));
  wrap.appendChild(row1);
  wrap.appendChild(el('div', { class: 'card mb-16' },
    el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'Year-over-Year Revenue Comparison'), el('div', { style: 'font-size:12px;color:var(--text-muted)' }, 'Click a bar to see that year\'s P&L summary')),
    mkChartWrap('tax-yoy-bar')
  ));
  return wrap;
}

function renderCharts(data, year, ownerFilter) {
  if (typeof window.Chart === 'undefined') {
    CHART_IDS.forEach(id => {
      const canvas   = document.getElementById(id);
      const fallback = document.getElementById(`${id}-fallback`);
      if (canvas)   canvas.style.display = 'none';
      if (fallback) { fallback.style.display = 'flex'; }
    });
    return;
  }

  charts.bar('tax-rev-exp-bar', {
    labels: MONTH_LABELS,
    datasets: [
      { label: 'Revenue',             data: data.monthly.map(m => Math.round(m.rev)),  backgroundColor: 'rgba(16,185,129,0.75)', borderColor: '#10b981', borderWidth: 1 },
      { label: 'Operating Expenses',  data: data.monthly.map(m => Math.round(m.opex)), backgroundColor: 'rgba(239,68,68,0.65)',  borderColor: '#ef4444', borderWidth: 1 }
    ],
    onClickItem: (label, index) => {
      const m = data.monthly[index];
      if (!m) return;
      const mk           = m.mk;
      const monthLabel   = MONTH_LABELS[index];
      const monthPayments = data.payments.filter(p => p.date?.startsWith(mk));
      const monthInvoices = data.invoices.filter(i => (i.issueDate || '').startsWith(mk));
      const monthExpenses = data.opExpenses.filter(e => e.date?.startsWith(mk));
      const body = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });
      body.appendChild(mkSummaryGrid([{ label: 'Revenue', value: formatEUR(m.rev) }, { label: 'Operating Expenses', value: formatEUR(m.opex) }, { label: 'Net', value: formatEUR(m.rev - m.opex) }], 3));
      if (monthPayments.length > 0 || monthInvoices.length > 0) {
        body.appendChild(mkSectionLabel('Revenue Breakdown'));
        const revRows = [
          ...monthPayments.map(p => { const prop = p.propertyId ? byId('properties', p.propertyId)?.name : null; return [p.date || '—', prop || '—', 'Payment', formatEUR(toEUR(p.amount, p.currency, p.date))]; }),
          ...monthInvoices.map(i => { const client = i.clientId ? byId('clients', i.clientId)?.name : null;      return [i.issueDate || '—', client || '—', 'Invoice', formatEUR(toEUR(i.total, i.currency, i.issueDate))]; })
        ].sort((a, b) => a[0].localeCompare(b[0]));
        body.appendChild(mkModalTable(['Date', 'Entity', 'Type', 'Amount (EUR)'], revRows));
      }
      if (monthExpenses.length > 0) {
        body.appendChild(mkSectionLabel('Expense Breakdown'));
        body.appendChild(mkModalTable(['Date', 'Description', 'Entity', 'Amount (EUR)'], monthExpenses.sort((a, b) => (a.date || '').localeCompare(b.date || '')).map(e => {
          const prop   = e.propertyId ? byId('properties', e.propertyId)?.name : null;
          const vendor = e.vendorId   ? byId('vendors', e.vendorId)?.name      : null;
          return [e.date || '—', e.description || e.notes || '—', prop || vendor || '—', formatEUR(toEUR(e.amount, e.currency, e.date))];
        })));
      }
      if (!monthPayments.length && !monthInvoices.length && !monthExpenses.length) body.appendChild(mkEmptyState('No data for this month.'));
      openModal({ title: `${monthLabel} ${year} — Revenue & Expense Detail`, body, large: true });
    }
  });

  const catEntries = [...data.catMap.entries()].sort((a, b) => b[1] - a[1]);
  if (catEntries.length > 0) {
    charts.doughnut('tax-exp-cat-donut', {
      labels: catEntries.map(([k]) => COST_CATEGORIES[k]?.label || k),
      data:   catEntries.map(([, v]) => Math.round(v)),
      colors: catEntries.map(([k]) => catColor(k)),
      onClickItem: (label, index) => {
        const [catKey] = catEntries[index];
        openCategoryModal(catKey, data.opExpenses.filter(e => resolvedCatKey(e) === catKey), false, catEntries[index][1]);
      }
    });
    charts.toggleDoughnutPct('tax-exp-cat-donut');
  }

  const allYears   = getDataYears().reverse();
  const yoyCache   = new Map(allYears.map(yr => [yr, getYearData(yr, ownerFilter)]));
  const yoyRevenue = allYears.map(yr => Math.round(yoyCache.get(yr).totalRevenue));
  const yoyOpEx    = allYears.map(yr => Math.round(yoyCache.get(yr).totalOpEx));
  charts.bar('tax-yoy-bar', {
    labels: allYears,
    datasets: [
      { label: 'Revenue',            data: yoyRevenue, backgroundColor: 'rgba(16,185,129,0.75)', borderColor: '#10b981', borderWidth: 1 },
      { label: 'Operating Expenses', data: yoyOpEx,    backgroundColor: 'rgba(239,68,68,0.65)',  borderColor: '#ef4444', borderWidth: 1 }
    ],
    onClickItem: (clickedYear) => {
      const d = yoyCache.get(clickedYear) || getYearData(clickedYear, ownerFilter);
      const body = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });
      body.appendChild(mkSummaryGrid([
        { label: 'Total Revenue',    value: formatEUR(d.totalRevenue) },
        { label: 'Total OpEx',       value: formatEUR(d.totalOpEx) },
        { label: 'Operating Profit', value: formatEUR(d.opProfit) },
        { label: 'CapEx',            value: formatEUR(d.totalCapEx) },
        { label: 'Net Cash Used',    value: formatEUR(d.netCash) },
        { label: 'Operating Margin', value: d.totalRevenue > 0 ? (d.opProfit / d.totalRevenue * 100).toFixed(1) + '%' : '—' }
      ], 3));
      const catEnt = [...d.catMap.entries()].sort((a, b) => b[1] - a[1]);
      if (catEnt.length > 0) {
        body.appendChild(mkSectionLabel('OpEx by Category'));
        body.appendChild(mkModalTable(['Category', 'Amount', '% of OpEx'], catEnt.map(([k, v]) => [COST_CATEGORIES[k]?.label || k, formatEUR(v), d.totalOpEx > 0 ? (v / d.totalOpEx * 100).toFixed(1) + '%' : '—'])));
      }
      openModal({ title: `${clickedYear} Annual P&L Summary`, body, large: true });
    }
  });
}

function downloadTaxCsv(year, catData, totalOpEx, totalCapEx, totalRevenue) {
  const rows = [['Category', 'Type', 'Count', 'Amount EUR', '% of OpEx']];
  catData.opex.forEach(c => rows.push([c.label, 'OpEx', c.count, c.total.toFixed(2), (c.total / totalOpEx * 100).toFixed(1) + '%']));
  catData.capex.forEach(c => rows.push([c.label, 'CapEx', c.count, c.total.toFixed(2), '—']));
  rows.push(['TOTAL OpEx', '', '', totalOpEx.toFixed(2), '100%']);
  rows.push(['TOTAL CapEx', '', '', totalCapEx.toFixed(2), '—']);
  rows.push(['TOTAL Revenue', '', '', totalRevenue.toFixed(2), '—']);
  const csv  = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = `tax-summary-${year}.csv`; a.click();
  URL.revokeObjectURL(url);
}

function buildTaxExportSection(data, year) {
  const wrap  = el('div', { class: 'card mb-16' });
  wrap.appendChild(el('div', { class: 'card-header' },
    el('div', { class: 'card-title' }, 'Tax Export'),
    el('div', { style: 'font-size:12px;color:var(--text-muted)' }, 'Export a formatted summary for your accountant')
  ));
  const inner = el('div', { style: 'padding:16px;display:flex;align-items:center;gap:16px;flex-wrap:wrap' });
  const toastEl = el('div', { style: 'display:none;padding:8px 16px;border-radius:6px;background:var(--success,#10b981);color:#fff;font-size:13px;font-weight:600' }, 'Copied to clipboard!');

  const btn = el('button', { class: 'btn btn-primary', style: 'display:flex;align-items:center;gap:8px;font-size:13px' });
  btn.appendChild(el('span', {}, '📋'));
  btn.appendChild(document.createTextNode('Copy for Accountant'));
  btn.addEventListener('click', () => {
    const catEntries = [...data.catMap.entries()].sort((a, b) => b[1] - a[1]);
    const catLines   = catEntries.map(([k, v]) => `  ${COST_CATEGORIES[k]?.label || k}: ${formatEUR(v)}`).join('\n');
    const yr      = gYear;
    const txRate  = getTaxRate(yr);
    const txBase  = Math.max(0, data.opProfit);
    const txAmt   = txBase * (txRate / 100);
    const text = [`Annual P&L Summary — ${yr}`, `Revenue: ${formatEUR(data.totalRevenue)}`, `Operating Expenses: ${formatEUR(data.totalOpEx)}`, `Operating Profit: ${formatEUR(data.opProfit)}`, `Capital Expenditures: ${formatEUR(data.totalCapEx)}`, `Net Cash: ${formatEUR(data.netCash)}`, '', `Tax Estimation (${yr})`, `Corporation Tax Rate: ${txRate}%`, `Taxable Income: ${formatEUR(txBase)}`, `Estimated Corporation Tax: ${formatEUR(txAmt)}`, `Net After Tax (est.): ${formatEUR(data.opProfit - txAmt)}`, '', 'Expense Breakdown:', catLines, '', `Generated: ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}`].join('\n');
    navigator.clipboard.writeText(text).then(() => {
      toastEl.style.display = 'inline-block';
      setTimeout(() => { toastEl.style.display = 'none'; }, 2500);
    }).catch(() => {
      const fb = el('div', { style: 'display:flex;flex-direction:column;gap:12px' });
      fb.appendChild(el('div', { style: 'font-size:13px;color:var(--text-muted)' }, 'Copy the text below:'));
      const ta = el('textarea', { style: 'width:100%;height:200px;padding:10px;font-family:monospace;font-size:12px;background:var(--bg-elev-2);color:var(--text);border:1px solid var(--border);border-radius:4px;resize:vertical', readonly: '' });
      ta.value = text;
      fb.appendChild(ta);
      openModal({ title: 'Copy for Accountant', body: fb, large: true });
    });
  });

  const buildCatData = () => {
    const opex = [...data.catMap.entries()].sort((a, b) => b[1] - a[1]).map(([k, total]) => ({ label: COST_CATEGORIES[k]?.label || k, count: data.opExpenses.filter(e => resolvedCatKey(e) === k).length, total }));
    const capCatMap = new Map();
    for (const e of data.capExpenses) capCatMap.set(resolvedCatKey(e), (capCatMap.get(resolvedCatKey(e)) || 0) + toEUR(e.amount, e.currency, e.date));
    const capex = [...capCatMap.entries()].sort((a, b) => b[1] - a[1]).map(([k, total]) => ({ label: COST_CATEGORIES[k]?.label || k, count: data.capExpenses.filter(e => resolvedCatKey(e) === k).length, total }));
    return { opex, capex };
  };

  const csvBtn = el('button', { class: 'btn btn-secondary', style: 'display:flex;align-items:center;gap:8px;font-size:13px' });
  csvBtn.appendChild(el('span', {}, '⬇'));
  csvBtn.appendChild(document.createTextNode('Download CSV'));
  csvBtn.addEventListener('click', () => downloadTaxCsv(year, buildCatData(), data.totalOpEx, data.totalCapEx, data.totalRevenue));

  inner.appendChild(btn);
  inner.appendChild(csvBtn);
  inner.appendChild(toastEl);
  inner.appendChild(el('div', { style: 'font-size:12px;color:var(--text-muted);line-height:1.5' }, `Copies a plain-text summary of ${year} P&L including revenue, operating expenses, and expense breakdown by category.`));
  wrap.appendChild(inner);
  return wrap;
}

function buildPnLContent(years) {
  const wrap = el('div');

  if (!years.length) {
    wrap.appendChild(el('div', { style: 'padding:40px;text-align:center;color:var(--text-muted);font-size:14px' }, 'No data found. Add payments, invoices, or expenses to get started.'));
    return wrap;
  }

  const taxRate    = getTaxRate(gYear);
  const selectorBar = buildYearSelectorBar(years, gYear, gOwner, taxRate, (newYear, newOwner) => {
    gYear  = newYear;
    gOwner = newOwner;
    rebuildView();
  }, (newRate) => {
    saveTaxRate(gYear, newRate);
    rebuildView();
  });
  wrap.appendChild(selectorBar);

  const data = getYearData(gYear, gOwner);
  wrap.appendChild(buildPnLTable(data, taxRate, gYear));
  wrap.appendChild(buildKpiCards(data, gYear, taxRate));
  wrap.appendChild(buildExpenseCategoryTable(data));
  wrap.appendChild(buildCharts(data, gYear));
  wrap.appendChild(buildTaxExportSection(data, gYear));

  requestAnimationFrame(() => renderCharts(data, gYear, gOwner));
  return wrap;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROVISIONAL TAX TAB
// ═══════════════════════════════════════════════════════════════════════════════

const PT_DEFAULTS = {
  year: String(new Date().getFullYear()),
  corpTaxRate: 12.5,
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
  if (!state.db.settings.cyprusTax) state.db.settings.cyprusTax = { ...PT_DEFAULTS };
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

const pct = (v, tot) => tot > 0 ? `${((v / tot) * 100).toFixed(1)}%` : '—';

function daysLabel(dateStr) {
  const diff = Math.round((new Date(dateStr) - new Date()) / 86400000);
  if (diff > 0)  return `${diff}d remaining`;
  if (diff === 0) return 'Due today';
  return `${Math.abs(diff)}d overdue`;
}

function getActualsForYear(year) {
  const today  = new Date().toISOString().slice(0, 10);
  const cutoff = today < `${year}-12-31` ? today : `${year}-12-31`;
  const s1     = `${year}-01-01`;
  return {
    pays: listActivePayments().filter(p => p.status === 'paid' && p.date >= s1 && p.date <= cutoff),
    invs: listActive('invoices').filter(i => i.status === 'paid' && (i.issueDate || '') >= s1 && (i.issueDate || '') <= cutoff),
    exps: listActive('expenses').filter(e => !isCapEx(e) && e.date >= s1 && e.date <= cutoff),
    cutoff, year,
  };
}

function emptyModal(title, msg) {
  openModal({ title, body: el('div', { style: 'padding:24px;text-align:center;color:var(--text-muted)' }, msg) });
}

function modalRentalPayments() {
  const year = cfg().year || String(new Date().getFullYear());
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
  body.appendChild(mkSummaryGrid([{ label: 'Total Revenue', value: fmtE(total) }, { label: 'Payments', value: String(pays.length) }, { label: 'Avg / Payment', value: fmtE(total / pays.length) }, { label: 'Properties', value: String(propRows.length) }], 4));
  body.appendChild(mkSectionLabel('Revenue by Property'));
  body.appendChild(mkModalTable([{ label: 'Property' }, { label: 'Pmts', right: true }, { label: 'Revenue', right: true }, { label: 'Share', right: true, muted: true }], propRows.map(([id, d]) => { const p = propMap[id]; return [p?.name || p?.address || 'Unknown', String(d.n), fmtE(d.rev), pct(d.rev, total)]; })));
  body.appendChild(mkSectionLabel('Monthly Collections'));
  body.appendChild(mkModalTable([{ label: 'Month' }, { label: 'Revenue', right: true }, { label: 'Share', right: true, muted: true }], moRows.map(([mo, v]) => [mo, fmtE(v), pct(v, total)])));
  openModal({ title: `Rental Payments — ${year}`, body, large: true });
}

function modalInvoiceRevenue() {
  const year = cfg().year || String(new Date().getFullYear());
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
  body.appendChild(mkSummaryGrid([{ label: 'Total Invoiced', value: fmtE(total) }, { label: 'Invoices', value: String(invs.length) }, { label: 'Avg Invoice', value: fmtE(total / invs.length) }, { label: 'Clients', value: String(clRows.length) }], 4));
  body.appendChild(mkSectionLabel('Revenue by Client'));
  body.appendChild(mkModalTable([{ label: 'Client' }, { label: 'Invoices', right: true }, { label: 'Revenue', right: true }, { label: 'Share', right: true, muted: true }], clRows.map(([id, d]) => { const c = clientMap[id]; return [c?.name || c?.company || 'Unknown', String(d.n), fmtE(d.rev), pct(d.rev, total)]; })));
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
  for (const e of catExps) { const mo = e.date.slice(0, 7); byMonth[mo] = (byMonth[mo] || 0) + toEUR(e.amount, e.currency, year); }
  const moRows  = Object.entries(byMonth).sort(([a], [b]) => a.localeCompare(b));
  const topRecs = [...catExps].sort((a, b) => toEUR(b.amount, b.currency, year) - toEUR(a.amount, a.currency, year)).slice(0, 8);

  const body = el('div');
  body.appendChild(mkSummaryGrid([{ label: 'Category Total', value: fmtE(total) }, { label: 'Records', value: String(catExps.length) }, { label: 'Avg / Record', value: fmtE(total / catExps.length) }, { label: '% of All Expenses', value: pct(total, allTotal) }], 4));
  body.appendChild(mkSectionLabel('Monthly Distribution'));
  body.appendChild(mkModalTable([{ label: 'Month' }, { label: 'Amount', right: true }, { label: '% of Category', right: true, muted: true }], moRows.map(([mo, v]) => [mo, fmtE(v), pct(v, total)])));
  body.appendChild(mkSectionLabel(`Top Records (${topRecs.length} of ${catExps.length})`));
  body.appendChild(mkModalTable([{ label: 'Description / Vendor' }, { label: 'Date' }, { label: 'Amount', right: true }], topRecs.map(e => {
    const vendorName = e.vendorId ? byId('vendors', e.vendorId)?.name : null;
    return [e.description || vendorName || e.vendor || '—', e.date || '', fmtE(toEUR(e.amount, e.currency, year))];
  })));
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

  const fcData = {};
  for (const fc of (state.db.forecasts || []).filter(f => !f.deletedAt && f.year === Number(year))) {
    const eid = fc.entityId || fc.propertyId || fc.id;
    if (!fcData[eid]) fcData[eid] = { rev: 0, exp: 0, months: 0, type: fc.type };
    for (const [mk, md] of Object.entries(fc.months || {})) {
      if (mk > curMonth) {
        const rev = Number(md.revenue) || 0, exp = Number(md.expenses) || 0;
        if (rev > 0 || exp > 0) { fcData[eid].rev += rev; fcData[eid].exp += exp; fcData[eid].months++; }
      }
    }
  }

  const rows = Object.entries(fcData).filter(([, d]) => forRevenue ? d.rev > 0 : d.exp > 0).sort(([, a], [, b]) => forRevenue ? b.rev - a.rev : b.exp - a.exp);
  if (!rows.length) { emptyModal('Forecast', 'No forecast data found for remaining months.'); return; }

  const total     = rows.reduce((a, [, d]) => a + (forRevenue ? d.rev : d.exp), 0);
  const propCount = rows.filter(([id, d]) => d.type === 'property' || !!propMap[id]).length;
  const svcCount  = rows.length - propCount;

  const body = el('div');
  body.appendChild(mkSummaryGrid([{ label: forRevenue ? 'Forecast Revenue' : 'Forecast Expenses', value: fmtE(total) }, { label: 'Properties', value: String(propCount) }, { label: 'Services', value: String(svcCount) }, { label: 'From Month', value: `> ${curMonth}` }], 4));
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

function modalRevenueDetail() {
  const s = cfg();
  const year = s.year || String(new Date().getFullYear());
  const { pays, invs } = getActualsForYear(year);
  const byMonth = {};
  for (const p of pays) { const mo = p.date.slice(0, 7); byMonth[mo] = (byMonth[mo] || 0) + toEUR(p.amount, p.currency, year); }
  for (const i of invs) { const mo = (i.issueDate || '').slice(0, 7); if (mo) byMonth[mo] = (byMonth[mo] || 0) + toEUR(i.total, i.currency, year); }
  const moRows    = Object.entries(byMonth).sort(([a], [b]) => a.localeCompare(b));
  const actTotal  = moRows.reduce((a, [, v]) => a + v, 0);
  const paysTotal = pays.reduce((a, p) => a + toEUR(p.amount, p.currency, year), 0);
  const invsTotal = invs.reduce((a, i) => a + toEUR(i.total, i.currency, year), 0);

  const body = el('div');
  body.appendChild(mkSummaryGrid([{ label: 'Actual Collected', value: fmtE(actTotal) }, { label: 'Forecast Remaining', value: fmtE(safeN(s.forecastRevenue)) }, { label: 'Rental Share', value: pct(paysTotal, actTotal) }, { label: 'Invoice Share', value: pct(invsTotal, actTotal) }], 4));
  if (moRows.length) {
    body.appendChild(mkSectionLabel('Month-by-Month Actual Collections'));
    let cum = 0;
    body.appendChild(mkModalTable([{ label: 'Month' }, { label: 'Revenue', right: true }, { label: 'Cumulative', right: true, muted: true }], moRows.map(([mo, v]) => { cum += v; return [mo, fmtE(v), fmtE(cum)]; })));
  }
  openModal({ title: `Annual Revenue Breakdown — ${year}`, body, large: true });
}

function modalExpensesDetail() {
  const s = cfg();
  const year = s.year || String(new Date().getFullYear());
  const { exps } = getActualsForYear(year);
  const byCat  = {};
  for (const e of exps) { const cat = e.category || 'Other'; byCat[cat] = (byCat[cat] || 0) + toEUR(e.amount, e.currency, year); }
  const actTotal = Object.values(byCat).reduce((a, v) => a + v, 0);
  const catRows  = Object.entries(byCat).sort(([, a], [, b]) => b - a);

  const body = el('div');
  body.appendChild(mkSummaryGrid([{ label: 'Actual to Date', value: fmtE(actTotal) }, { label: 'Forecast Remaining', value: fmtE(safeN(s.forecastExpenses)) }, { label: 'Expense Categories', value: String(catRows.length) }, { label: 'Largest Category', value: catRows[0]?.[0] || '—', sub: catRows[0] ? fmtE(catRows[0][1]) : '' }], 4));
  if (catRows.length) {
    body.appendChild(mkSectionLabel('All Categories — Actual to Date'));
    body.appendChild(mkModalTable([{ label: 'Category' }, { label: 'Amount', right: true }, { label: '% of Actual', right: true, muted: true }], catRows.map(([cat, v]) => [cat, fmtE(v), pct(v, actTotal)])));
  }
  openModal({ title: `Deductible Expenses Breakdown — ${year}`, body, large: true });
}

function modalTaxableProfit() {
  const s = cfg();
  const c = calcAll(s);
  const margin = c.totalRevenue > 0 ? (c.estProfit / c.totalRevenue * 100).toFixed(1) : null;
  const rows = [['Est. Annual Revenue', '', fmtE(c.totalRevenue)], ['Est. Deductible Expenses', '−', fmtE(c.totalDeductible)]];
  if (safeN(s.nonDeductibleExpenses) > 0) rows.push(['Non-deductible add-back', '+', fmtE(safeN(s.nonDeductibleExpenses))]);
  if (safeN(s.taxAllowances)         > 0) rows.push(['Tax allowances', '−', fmtE(safeN(s.taxAllowances))]);
  rows.push(['Est. Taxable Profit', '=', fmtE(c.estProfit)]);

  const body = el('div');
  body.appendChild(mkSummaryGrid([{ label: 'Est. Revenue', value: fmtE(c.totalRevenue) }, { label: 'Est. Expenses', value: fmtE(c.totalDeductible) }, { label: 'Taxable Profit', value: fmtE(c.estProfit) }, { label: 'Profit Margin', value: margin ? `${margin}%` : '—', sub: 'Profit ÷ Revenue' }], 4));
  body.appendChild(mkSectionLabel('Calculation'));
  body.appendChild(mkModalTable([{ label: 'Item' }, { label: '' }, { label: 'Amount', right: true }], rows));
  openModal({ title: 'Taxable Profit — Calculation', body });
}

function modalBufferedProfit() {
  const s = cfg();
  const c = calcAll(s);
  if (!c.bufEnabled) return;
  const bufferAmt = c.taxableProfit - c.estProfit;
  const extraTax  = bufferAmt * c.rate / 100;
  const body = el('div');
  body.appendChild(mkSummaryGrid([{ label: 'Base Taxable Profit', value: fmtE(c.estProfit) }, { label: `Buffer (${c.bufPct}%)`, value: `+ ${fmtE(bufferAmt)}` }, { label: 'Buffered Profit', value: fmtE(c.taxableProfit) }, { label: 'Extra Tax Cost', value: fmtE(extraTax), sub: 'Cost of the safety margin' }], 4));
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
  body.appendChild(mkSummaryGrid([{ label: 'Corp Tax Rate', value: `${c.rate}%` }, { label: 'Taxable Profit', value: fmtE(c.taxableProfit) }, { label: 'Total Corp Tax', value: fmtE(c.corpTax) }, { label: 'Effective Rate on Revenue', value: `${effRate}%`, sub: 'Tax ÷ Est. Revenue' }], 4));
  body.appendChild(mkSectionLabel('Payment Schedule'));
  body.appendChild(mkModalTable([{ label: 'Instalment' }, { label: 'Due Date' }, { label: 'Amount', right: true }, { label: 'Status', right: true, muted: true }], [
    ['1st — 50%',     `31 Jul ${year}`,      fmtE(c.julyPayment), daysLabel(`${year}-07-31`)],
    ['2nd — 50%',     `31 Dec ${year}`,      fmtE(c.decPayment),  daysLabel(`${year}-12-31`)],
    ['Final balance', `1 Aug ${nextYear}`,   '—',                 'After audit'],
  ]));
  if (c.estProfit > 0) body.appendChild(el('div', { style: 'margin-top:12px;font-size:12px;color:var(--text-muted)' }, `Net profit retained after tax: ${fmtE(netRetained)} (${(netRetained / c.estProfit * 100).toFixed(1)}% of taxable profit)`));
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
  body.appendChild(mkSummaryGrid([{ label: 'Amount Due', value: fmtE(amount) }, { label: 'Due Date', value: isJuly ? `31 Jul ${year}` : `31 Dec ${year}` }, { label: 'Deadline Status', value: daysLabel(dueDate) }, { label: 'Total Corp Tax', value: fmtE(c.corpTax), sub: 'Both instalments combined' }], 4));

  body.appendChild(mkSectionLabel('How This Amount Was Calculated'));
  const calcRows = [
    ['Est. Annual Revenue',      '',  fmtE(c.totalRevenue)],
    ['Est. Deductible Expenses', '−', fmtE(c.totalDeductible)],
  ];
  if (safeN(s.nonDeductibleExpenses) > 0) calcRows.push(['Non-deductible add-back', '+', fmtE(safeN(s.nonDeductibleExpenses))]);
  if (safeN(s.taxAllowances)         > 0) calcRows.push(['Tax allowances',          '−', fmtE(safeN(s.taxAllowances))]);
  calcRows.push(['Est. Taxable Profit', '=', fmtE(c.estProfit)]);
  if (c.bufEnabled) calcRows.push([`Safety Buffer (+${c.bufPct}%)`, '+', fmtE(c.taxableProfit - c.estProfit)]);
  calcRows.push([`Corporation Tax @ ${c.rate}%`, '=', fmtE(c.corpTax)]);
  calcRows.push([isJuly ? '1st Instalment (50%)' : '2nd Instalment (50%)', '=', fmtE(amount)]);
  body.appendChild(mkModalTable([{ label: 'Item' }, { label: '' }, { label: 'Amount', right: true }], calcRows));

  body.appendChild(mkSectionLabel('Underlying Figures'));
  const linkRow = (label, value, onClick) => {
    const row = el('div', { style: 'display:flex;justify-content:space-between;align-items:center;padding:6px 4px;margin:0 -4px;border-radius:4px;cursor:pointer' },
      el('span', { style: 'font-size:12px;color:var(--text-muted);text-decoration:underline;text-decoration-style:dotted;text-underline-offset:2px' }, label),
      el('span', { style: 'font-size:12px;color:var(--text);font-weight:600' }, value)
    );
    row.addEventListener('mouseenter', () => { row.style.background = 'rgba(255,255,255,0.05)'; });
    row.addEventListener('mouseleave', () => { row.style.background = ''; });
    row.onclick = onClick;
    return row;
  };
  body.appendChild(linkRow('↳ Revenue breakdown', fmtE(c.totalRevenue), modalRevenueDetail));
  body.appendChild(linkRow('↳ Expense breakdown', fmtE(c.totalDeductible), modalExpensesDetail));

  body.appendChild(el('div', { style: 'margin-top:12px;padding:12px;border-radius:6px;background:rgba(251,191,36,0.08);border-left:3px solid var(--warning);font-size:12px;color:var(--text-muted);line-height:1.6' },
    isJuly
      ? `Pay ${fmtE(amount)} to the Cyprus Tax Department by 31 July ${year}. Late payment attracts a 10% additional charge. The 2nd instalment is due 31 December ${year}.`
      : `Pay ${fmtE(amount)} by 31 December ${year}. Before paying, use the December Revision section to check whether this amount needs adjusting based on updated year-end estimates. Late payment attracts a 10% additional charge.`
  ));
  openModal({ title: `${isJuly ? '1st' : '2nd'} Instalment — ${isJuly ? '31 Jul' : '31 Dec'} ${year}`, body, large: true });
}

function modalFinalBalance() {
  const s        = cfg();
  const c        = calcAll(s);
  const year     = s.year || String(new Date().getFullYear());
  const nextYear = String(Number(year) + 1);
  const today    = new Date().toISOString().slice(0, 10);
  const paidSoFar = (today > `${year}-07-31` ? c.julyPayment : 0) + (today > `${year}-12-31` ? c.decPayment : 0);
  const targetTax = c.finalTax > 0 ? c.finalTax : (c.revisedAnnualTax > 0 ? c.revisedAnnualTax : c.corpTax);
  const coverage  = targetTax > 0 ? (paidSoFar / targetTax * 100) : 0;
  const body = el('div');
  body.appendChild(mkSummaryGrid([
    { label: 'Provisional Tax Paid',           value: fmtE(paidSoFar), sub: paidSoFar > 0 ? 'Instalments due so far' : 'No instalments due yet' },
    { label: '% of Est. Tax Covered',          value: targetTax > 0 ? `${coverage.toFixed(1)}%` : '—', sub: `vs ${fmtE(targetTax)} estimated liability` },
    { label: 'Final Balance',                  value: 'Pending audit', sub: 'Determined after year-end filing' },
    { label: 'Deadline',                       value: `1 Aug ${nextYear}` }
  ], 4));
  body.appendChild(el('div', { style: 'margin-top:4px;padding:12px;border-radius:6px;background:rgba(99,102,241,0.08);border-left:3px solid var(--accent);font-size:12px;color:var(--text-muted);line-height:1.6' },
    `The final balance is settled after submitting audited accounts, so it cannot be shown as a number here — it depends on the actual audited profit for ${year}. If actual profit exceeded estimates, pay the difference plus any applicable interest. If lower, you receive a credit or refund. The deadline for the final balance payment is 1 August ${nextYear}.`
  ));
  openModal({ title: `Final Balance — 1 Aug ${nextYear}`, body });
}

function modalDecRevProfit() {
  const s = cfg();
  const c = calcAll(s);
  const delta = c.revProfit - c.estProfit;
  const rows = [['Revised Revenue', '', fmtE(safeN(s.decRevRevenue))], ['Revised Expenses', '−', fmtE(safeN(s.decRevExpenses))]];
  if (safeN(s.decRevNonDeductible) > 0) rows.push(['Non-deductible add-back', '+', fmtE(safeN(s.decRevNonDeductible))]);
  if (safeN(s.decRevAllowances)    > 0) rows.push(['Tax allowances', '−', fmtE(safeN(s.decRevAllowances))]);
  rows.push(['Revised Taxable Profit', '=', fmtE(c.revProfit)]);
  const body = el('div');
  body.appendChild(mkSummaryGrid([{ label: 'Original Estimate', value: fmtE(c.estProfit) }, { label: 'Revised Estimate', value: fmtE(c.revProfit) }, { label: 'Change', value: (delta >= 0 ? '+' : '−') + fmtE(Math.abs(delta)), sub: delta > 0 ? 'Profit up' : delta < 0 ? 'Profit down' : 'No change' }, { label: 'Tax Impact', value: (delta >= 0 ? '+' : '−') + fmtE(Math.abs(delta) * c.rate / 100), sub: `At ${c.rate}% rate` }], 4));
  body.appendChild(mkSectionLabel('Revised Calculation'));
  body.appendChild(mkModalTable([{ label: 'Item' }, { label: '' }, { label: 'Amount', right: true }], rows));
  openModal({ title: 'Revised Taxable Profit vs Original', body });
}

function modalDecRevTax() {
  const s     = cfg();
  const c     = calcAll(s);
  const delta = c.revisedAnnualTax - c.corpTax;
  const body = el('div');
  body.appendChild(mkSummaryGrid([{ label: 'Original Corp Tax', value: fmtE(c.corpTax), sub: 'From Annual Estimate' }, { label: 'Revised Corp Tax', value: fmtE(c.revisedAnnualTax) }, { label: 'Tax Change', value: (delta >= 0 ? '+' : '−') + fmtE(Math.abs(delta)), sub: delta > 0 ? 'More tax required' : delta < 0 ? 'Less tax required' : 'No change' }, { label: 'Rate Applied', value: `${c.rate}%` }], 4));
  body.appendChild(el('div', { style: 'margin-top:4px;padding:12px;border-radius:6px;background:rgba(99,102,241,0.08);border-left:3px solid var(--accent);font-size:12px;color:var(--text-muted);line-height:1.6' },
    delta > 0 ? `Your revised estimates show ${fmtE(delta)} more in corporation tax than originally planned. Check the Required Dec Payment card to see how much more you owe in December.`
    : delta < 0 ? `Your revised estimates show ${fmtE(Math.abs(delta))} less in corporation tax than originally planned. You may have overpaid in July — see the Overpayment card.`
    : 'Your revised estimates match the original — no adjustment to the December payment needed.'
  ));
  openModal({ title: 'Revised Corp Tax vs Original Estimate', body });
}

function modalJulyPaid() {
  const s = cfg();
  const c = calcAll(s);
  const coverOrig    = c.corpTax          > 0 ? (c.alreadyPaid / c.corpTax          * 100).toFixed(1) : '—';
  const coverRevised = c.revisedAnnualTax > 0 ? (c.alreadyPaid / c.revisedAnnualTax * 100).toFixed(1) : '—';
  const surplus = c.alreadyPaid - c.revisedAnnualTax;
  const body = el('div');
  body.appendChild(mkSummaryGrid([{ label: 'July Payment', value: fmtE(c.alreadyPaid) }, { label: '% of Original Tax', value: `${coverOrig}%`, sub: `Original: ${fmtE(c.corpTax)}` }, { label: '% of Revised Tax', value: `${coverRevised}%`, sub: `Revised: ${fmtE(c.revisedAnnualTax)}` }, { label: surplus >= 0 ? 'Surplus Paid' : 'Still Owed', value: fmtE(Math.abs(surplus)), sub: surplus >= 0 ? 'Overpaid so far' : 'Remaining liability' }], 4));
  openModal({ title: 'July Payment — Coverage Analysis', body });
}

function modalReqDecPayment() {
  const s    = cfg();
  const c    = calcAll(s);
  const year = s.year || String(new Date().getFullYear());
  const delta = c.reqDecPayment - c.decPayment;
  const body = el('div');
  body.appendChild(mkSummaryGrid([{ label: 'Original Dec Plan', value: fmtE(c.decPayment), sub: '50% of original estimate' }, { label: 'Required Dec Payment', value: fmtE(c.reqDecPayment), sub: delta > 0 ? '↑ More than planned' : delta < 0 ? '↓ Less than planned' : 'Same as planned' }, { label: 'Change vs Plan', value: (delta >= 0 ? '+' : '−') + fmtE(Math.abs(delta)) }, { label: 'Deadline Status', value: daysLabel(`${year}-12-31`) }], 4));
  body.appendChild(el('div', { style: `margin-top:4px;padding:12px;border-radius:6px;${c.reqDecPayment > 0 ? 'background:rgba(251,191,36,0.08);border-left:3px solid var(--warning)' : 'background:rgba(16,185,129,0.08);border-left:3px solid var(--success)'};font-size:12px;color:var(--text-muted);line-height:1.6` },
    c.reqDecPayment > 0 ? `Pay ${fmtE(c.reqDecPayment)} by 31 December ${year}. Failure to pay the correct amount results in a 10% surcharge on the underpaid portion.` : `Your July payment fully covers the revised annual tax liability. No December payment is required.`
  ));
  openModal({ title: `Required December Payment — 31 Dec ${year}`, body });
}

function modalSafetyCheck() {
  const s    = cfg();
  const c    = calcAll(s);
  const year = s.year || String(new Date().getFullYear());
  const body = el('div');
  body.appendChild(mkSummaryGrid([
    { label: 'Estimated Final Tax',     value: fmtE(c.finalTax),      sub: 'Your year-end estimate' },
    { label: 'Planned Provisional Tax', value: fmtE(c.corpTax),       sub: 'Jul + Dec instalments' },
    { label: 'Minimum Required (75%)',  value: fmtE(c.minRequired75), sub: `75% of ${fmtE(c.finalTax)}` },
    { label: 'Shortfall',               value: fmtE(c.shortfall),     sub: c.shortfall > 0 ? 'Additional tax needed' : 'None' }
  ], 4));
  body.appendChild(mkSectionLabel('How the 75% Safe Harbor Is Calculated'));
  body.appendChild(mkModalTable([{ label: 'Item' }, { label: '' }, { label: 'Amount', right: true }], [
    ['Estimated Final Tax Liability',       '',  fmtE(c.finalTax)],
    ['× 75% Safe Harbor Threshold',         '×', '75%'],
    ['Minimum Required Provisional Tax',    '=', fmtE(c.minRequired75)],
    ['Planned Provisional Tax (Jul + Dec)', '−', fmtE(c.corpTax)],
    ['Shortfall (if positive)',             '=', fmtE(c.shortfall)],
  ]));
  body.appendChild(mkSectionLabel('Contributing Instalments'));
  body.appendChild(mkModalTable([{ label: 'Instalment' }, { label: 'Due Date' }, { label: 'Amount', right: true }], [
    ['1st — 50%', `31 Jul ${year}`, fmtE(c.julyPayment)],
    ['2nd — 50%', `31 Dec ${year}`, fmtE(c.decPayment)],
  ]));
  const safe = c.safe;
  body.appendChild(el('div', { style: `margin-top:4px;padding:12px;border-radius:6px;border-left:4px solid var(--${safe ? 'success' : 'danger'});background:rgba(${safe ? '16,185,129' : '239,68,68'},0.07);font-size:12px;color:var(--text-muted);line-height:1.6` },
    safe
      ? `Your planned provisional tax of ${fmtE(c.corpTax)} covers at least 75% of your estimated final tax liability of ${fmtE(c.finalTax)}. Cyprus imposes a 10% surcharge on any provisional tax shortfall below the 75% threshold — you are currently protected from that charge.`
      : `Your planned provisional tax of ${fmtE(c.corpTax)} falls short of the 75% threshold (${fmtE(c.minRequired75)}) by ${fmtE(c.shortfall)}. Increase your 2nd instalment (or make a top-up payment) to reach ${fmtE(c.minRequired75)} and avoid the 10% additional charge on the shortfall.`
  ));
  openModal({ title: '75% Safety Check — Explanation', body, large: true });
}

function modalOverpayment() {
  const s = cfg();
  const c = calcAll(s);
  const body = el('div');
  body.appendChild(mkSummaryGrid([{ label: 'July Payment', value: fmtE(c.alreadyPaid) }, { label: 'Revised Annual Tax', value: fmtE(c.revisedAnnualTax) }, { label: 'Overpayment', value: fmtE(c.overpayment) }, { label: 'No Dec Payment Due', value: 'Confirmed' }], 4));
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

function ptBuildSettingsCard(onChange) {
  const s    = cfg();
  const card = el('div', { class: 'card mb-16' });
  card.appendChild(el('div', { class: 'card-header' },
    el('div', {}, el('div', { class: 'card-title' }, 'Tax Settings'), el('div', { class: 'card-subtitle' }, 'Corporate tax rate and safety buffer'))
  ));
  const body = el('div', { style: 'padding:0 16px 16px' });

  const dataYears    = getDataYears(); // only years with actual payments/invoices/expenses
  const selectedYear = dataYears.includes(s.year) ? s.year : (dataYears[0] || String(new Date().getFullYear()));
  if (selectedYear !== s.year) persist({ year: selectedYear });
  const yearSel = select(dataYears.map(y => ({ value: y, label: y })), selectedYear);
  yearSel.onchange = () => { persist({ year: yearSel.value }); onChange(); };

  const rateI = input({ type: 'number', value: s.corpTaxRate ?? 12.5, min: 0, max: 100, step: 0.1, style: 'width:110px' });
  rateI.oninput = () => { persist({ corpTaxRate: safeN(rateI.value) }); onChange(); };

  const bufChk = el('input', { type: 'checkbox' });
  bufChk.checked = !!s.bufferEnabled;
  const bufPctI = input({ type: 'number', value: s.bufferPct ?? 10, min: 0, max: 100, step: 0.1, style: 'width:80px' });
  bufPctI.oninput = () => { persist({ bufferPct: safeN(bufPctI.value) }); onChange(); };
  bufChk.onchange = () => { persist({ bufferEnabled: bufChk.checked }); onChange(); };

  body.appendChild(el('div', { style: 'display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px' },
    formRow('Tax Year', yearSel),
    formRow('Corporate Tax Rate', el('div', { style: 'display:flex;align-items:center;gap:6px' }, rateI, el('span', { style: 'color:var(--text-muted);font-size:13px' }, '%')), 'Cyprus default: 12.5%'),
    formRow('Safety Buffer', el('div', { style: 'display:flex;align-items:center;gap:10px' }, el('label', { style: 'display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px;white-space:nowrap' }, bufChk, 'Enable'), bufPctI, el('span', { style: 'color:var(--text-muted);font-size:13px' }, '%')), 'Inflates estimate to reduce underpayment risk')
  ));
  card.appendChild(body);
  return card;
}

function ptBuildEstimateCard(onChange) {
  const s    = cfg();
  const card = el('div', { class: 'card mb-16' });

  const prefillBtn = button('↓ Prefill from actuals & forecast', { variant: 'sm ghost', onClick: () => ptPrefillFromActuals(onChange) });
  card.appendChild(el('div', { class: 'card-header' },
    el('div', {}, el('div', { class: 'card-title' }, 'Annual Estimate'), el('div', { class: 'card-subtitle' }, 'Expected full-year revenue and expenses')),
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
    }, el('span', { style: `font-size:12px;color:${isTot ? 'var(--text)' : 'var(--text-muted)'}` }, label), el('span', { style: `font-size:12px;color:${isTot ? 'var(--text)' : 'var(--text-muted)'};font-weight:${isTot ? '700' : '400'}` }, fmtE(value)));
    const subRow = (label, value, onClick) => {
      const d = el('div', { style: `display:flex;justify-content:space-between;align-items:center;padding:2px 0 2px 14px${onClick ? ';cursor:pointer' : ''}` },
        el('span', { style: `font-size:11px;color:var(--text-muted);opacity:.75${onClick ? ';text-decoration:underline;text-decoration-style:dotted;text-underline-offset:2px' : ''}` }, label),
        el('span', { style: 'font-size:11px;color:var(--text-muted);opacity:.75' }, fmtE(value))
      );
      if (onClick) d.onclick = onClick;
      return d;
    };

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

    breakdownEl.appendChild(el('div', { style: 'margin-top:16px;padding:12px 14px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-sm);display:grid;grid-template-columns:1fr 1fr;gap:16px 24px' }, revEl, expEl));
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
  body.appendChild(el('div', { style: 'font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px;margin:16px 0 10px;padding-bottom:6px;border-bottom:1px solid var(--border)' }, 'Profit Adjustments (€)'));
  body.appendChild(el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:20px' },
    fi('nonDeductibleExpenses', s.nonDeductibleExpenses, 'Non-deductible expenses', 'Entertainment, fines, etc. — added back to taxable profit'),
    fi('taxAllowances',         s.taxAllowances,         'Tax allowances / deductions', 'Depreciation, R&D credits, etc. — reduces taxable profit')
  ));

  body.appendChild(breakdownEl);
  renderBreakdown();
  card.appendChild(body);
  return card;
}

function ptPrefillFromActuals(onChange) {
  const s        = cfg();
  const year     = s.year || String(new Date().getFullYear());
  const today    = new Date().toISOString().slice(0, 10);
  const cutoff   = today < `${year}-12-31` ? today : `${year}-12-31`;
  const curMonth = cutoff.slice(0, 7);
  const s1       = `${year}-01-01`;

  const pays = listActivePayments().filter(p => p.status === 'paid' && p.date >= s1 && p.date <= cutoff);
  const invs = listActive('invoices').filter(i => i.status === 'paid' && (i.issueDate || '') >= s1 && (i.issueDate || '') <= cutoff);
  const exps = listActive('expenses').filter(e => !isCapEx(e) && e.date >= s1 && e.date <= cutoff);

  const rnd = v => Math.round(v * 100) / 100;
  const paysRevenue    = pays.reduce((a, p) => a + toEUR(p.amount, p.currency, year), 0);
  const invsRevenue    = invs.reduce((a, i) => a + toEUR(i.total, i.currency, year), 0);
  const actualRevenue  = paysRevenue + invsRevenue;
  const actualExpenses = exps.reduce((a, e) => a + toEUR(e.amount, e.currency, year), 0);

  const expsByCat = {};
  for (const e of exps) { const cat = e.category || 'Other'; expsByCat[cat] = (expsByCat[cat] || 0) + toEUR(e.amount, e.currency, year); }

  let forecastRevenue = 0, forecastExpenses = 0;
  const fcRevIds = new Set(), fcExpIds = new Set();
  const propIds  = new Set((state.db.properties || []).map(p => p.id));
  for (const fc of (state.db.forecasts || []).filter(f => !f.deletedAt && f.year === Number(year))) {
    const eid = fc.entityId || fc.propertyId || fc.id;
    for (const [mk, md] of Object.entries(fc.months || {})) {
      if (mk > curMonth) {
        const rev = Number(md.revenue) || 0, exp = Number(md.expenses) || 0;
        if (rev > 0) { fcRevIds.add(eid); forecastRevenue  += rev; }
        if (exp > 0) { fcExpIds.add(eid); forecastExpenses += exp; }
      }
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

  rebuildView();
  toast(`Prefilled: actuals to ${cutoff}, forecast from ${curMonth} onwards`, 'success');
}

function ptBuildResultsCard(c, s) {
  const year     = s.year || String(new Date().getFullYear());
  const nextYear = String(Number(year) + 1);
  const card     = el('div', { class: 'card mb-16' });

  card.appendChild(el('div', { class: 'card-header' },
    el('div', {}, el('div', { class: 'card-title' }, 'Provisional Tax Result'), el('div', { class: 'card-subtitle' }, `Estimated corporation tax liability for ${year}`))
  ));

  if (c.totalRevenue === 0 && c.totalDeductible === 0) {
    const emptyBody = el('div', { style: 'padding:32px 24px;text-align:center' });
    emptyBody.appendChild(el('div', { style: 'font-size:28px;margin-bottom:10px' }, '📊'));
    emptyBody.appendChild(el('div', { style: 'font-size:14px;font-weight:600;color:var(--text);margin-bottom:6px' }, 'Enter your income estimates above to see the tax calculation'));
    emptyBody.appendChild(el('div', { style: 'font-size:13px;color:var(--text-muted);line-height:1.6;max-width:420px;margin:0 auto' },
      'Fill in the Annual Estimate card with actual and forecast revenue and expenses, or click "Prefill from actuals & forecast" to auto-populate from your recorded data.'
    ));
    card.appendChild(emptyBody);
    return card;
  }

  const body = el('div', { style: 'padding:0 16px 16px' });

  const revSub = [safeN(s.actualRevenue) > 0 ? `Actual ${fmtE(safeN(s.actualRevenue))}` : null, safeN(s.forecastRevenue) > 0 ? `Forecast ${fmtE(safeN(s.forecastRevenue))}` : null].filter(Boolean).join(' + ') || null;
  const expSub = [safeN(s.actualExpenses) > 0 ? `Actual ${fmtE(safeN(s.actualExpenses))}` : null, safeN(s.forecastExpenses) > 0 ? `Forecast ${fmtE(safeN(s.forecastExpenses))}` : null].filter(Boolean).join(' + ') || null;

  body.appendChild(el('div', { class: 'grid grid-3 mb-16' },
    mkKpiCard({ label: 'Est. Annual Revenue',      value: fmtE(c.totalRevenue),    subtitle: revSub, onClick: modalRevenueDetail }),
    mkKpiCard({ label: 'Est. Deductible Expenses', value: fmtE(c.totalDeductible), subtitle: expSub, onClick: modalExpensesDetail }),
    mkKpiCard({ label: 'Est. Taxable Profit',      value: fmtE(c.estProfit),       onClick: modalTaxableProfit })
  ));

  const taxRow = [];
  if (c.bufEnabled) taxRow.push(mkKpiCard({ label: `Buffered Taxable Profit (+${c.bufPct}%)`, value: fmtE(c.taxableProfit), subtitle: `${c.bufPct}% safety margin applied`, onClick: modalBufferedProfit }));
  taxRow.push(mkKpiCard({ label: `Est. Corporation Tax (${c.rate}%)`, value: fmtE(c.corpTax), variant: c.corpTax > 0 ? 'warning' : '', onClick: modalCorpTax }));
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

function ptBuildSafetyCard(displayEl, renderDisplay, onChange) {
  const s    = cfg();
  const card = el('div', { class: 'card mb-16' });
  card.appendChild(el('div', { class: 'card-header' },
    el('div', {}, el('div', { class: 'card-title' }, '75% Safety Check'), el('div', { class: 'card-subtitle' }, 'Provisional tax must cover ≥ 75% of actual final tax to avoid the 10% penalty'))
  ));
  const body = el('div', { style: 'padding:0 16px 16px' });
  const finalTaxI = mkCurrencyInput(s.estimatedFinalTax, 'width:220px', v => { persist({ estimatedFinalTax: v }); renderDisplay(); onChange(); });
  body.appendChild(formRow('Estimated final actual tax liability (€)', finalTaxI, 'Your best estimate of the audited year-end tax. Leave 0 if unknown.'));
  body.appendChild(displayEl);
  card.appendChild(body);
  return card;
}

function ptBuildDecRevisionCard(displayEl, renderDisplay, onChange) {
  const s    = cfg();
  const year = s.year || String(new Date().getFullYear());
  const card = el('div', { class: 'card mb-16' });
  card.appendChild(el('div', { class: 'card-header' },
    el('div', {}, el('div', { class: 'card-title' }, 'December Revision Check'), el('div', { class: 'card-subtitle' }, `Revise estimates before 31 December ${year} to determine the correct 2nd instalment`))
  ));
  const body = el('div', { style: 'padding:0 16px 16px' });
  body.appendChild(el('p', { style: 'font-size:12px;color:var(--text-muted);margin:0 0 14px' }, 'Use revised full-year figures to check whether the second instalment needs increasing.'));

  const fi = (key, val, label) => {
    const i = mkCurrencyInput(val, 'width:100%', v => { persist({ [key]: v }); renderDisplay(); });
    return formRow(label, i);
  };
  const julI = mkCurrencyInput(s.julPayment, 'width:220px', v => { persist({ julPayment: v }); renderDisplay(); });

  body.appendChild(el('div', { style: 'font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px;padding-bottom:6px;border-bottom:1px solid var(--border)' }, 'Revised Year-End Estimates'));
  body.appendChild(el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:16px' },
    fi('decRevRevenue',  s.decRevRevenue,  'Expected annual revenue (€)'),
    fi('decRevExpenses', s.decRevExpenses, 'Deductible expenses (€)')
  ));
  body.appendChild(el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:8px' },
    fi('decRevNonDeductible', s.decRevNonDeductible, 'Non-deductible expenses (€)'),
    fi('decRevAllowances',    s.decRevAllowances,    'Tax allowances / deductions (€)')
  ));
  body.appendChild(el('div', { style: 'font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px;margin:16px 0 10px;padding-bottom:6px;border-bottom:1px solid var(--border)' }, 'Prior Payment'));
  body.appendChild(el('div', { style: 'margin-top:4px' },
    formRow('Amount already paid in July (€)', julI, 'Your actual first instalment payment')
  ));
  body.appendChild(displayEl);
  card.appendChild(body);
  return card;
}

function buildProvisionalTax() {
  const wrap = el('div', { style: 'padding:0;max-width:1100px' });

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
      mkKpiCard({ label: 'Planned Provisional Tax', value: fmtE(c.corpTax), onClick: modalSafetyCheck }),
      mkKpiCard({ label: 'Minimum Required (75%)',  value: fmtE(c.minRequired75), subtitle: `75% of ${fmtE(c.finalTax)}`, onClick: modalSafetyCheck }),
      mkKpiCard({ label: 'Shortfall',               value: fmtE(c.shortfall), variant: c.shortfall > 0 ? 'danger' : 'success', onClick: modalSafetyCheck })
    ));
    const safe = c.safe;
    safetyDisplayEl.appendChild(el('div', { style: `padding:12px 14px;border-radius:var(--radius-sm);border-left:4px solid var(--${safe ? 'success' : 'danger'});background:rgba(${safe ? '16,185,129' : '239,68,68'},0.07)` },
      el('span', { class: `badge ${safe ? 'success' : 'danger'}` }, safe ? '✓ No additional charge risk' : '⚠ Risk of 10% additional charge'),
      el('div', { style: 'font-size:12px;color:var(--text-muted);margin-top:6px' }, safe ? 'Your planned provisional tax covers at least 75% of the estimated final tax liability.' : `Increase provisional tax by ${fmtE(c.shortfall)} to reach the 75% threshold.`)
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
      mkKpiCard({ label: 'Revised Taxable Profit',         value: fmtE(c.revProfit),        onClick: modalDecRevProfit }),
      mkKpiCard({ label: `Revised Corp Tax (${c.rate}%)`,  value: fmtE(c.revisedAnnualTax), onClick: modalDecRevTax }),
      mkKpiCard({ label: 'Already Paid in July',           value: fmtE(c.alreadyPaid),      onClick: modalJulyPaid })
    ));
    decDisplayEl.appendChild(el('div', { class: 'grid grid-2' },
      mkKpiCard({ label: `Required 2nd Instalment — 31 Dec ${year}`, value: fmtE(c.reqDecPayment), variant: c.reqDecPayment > 0 ? 'warning' : 'success', subtitle: c.reqDecPayment > 0 ? 'Pay by 31 December' : 'No additional payment required', onClick: modalReqDecPayment }),
      c.overpayment > 0
        ? mkKpiCard({ label: 'July Overpayment', value: fmtE(c.overpayment), variant: 'success', subtitle: 'Offset or refund — click for options', onClick: modalOverpayment })
        : mkKpiCard({ label: 'Overpayment', value: fmtE(0), subtitle: 'None' })
    ));
  };

  const recalc = () => {
    resultsEl.innerHTML = '';
    resultsEl.appendChild(ptBuildResultsCard(calcAll(cfg()), cfg()));
    renderSafetyDisplay();
    renderDecDisplay();
  };

  wrap.appendChild(ptBuildSettingsCard(recalc));
  wrap.appendChild(ptBuildEstimateCard(recalc));
  wrap.appendChild(resultsEl);
  wrap.appendChild(ptBuildSafetyCard(safetyDisplayEl, renderSafetyDisplay, recalc));
  wrap.appendChild(ptBuildDecRevisionCard(decDisplayEl, renderDecDisplay, recalc));

  recalc();
  return wrap;
}

// (Dividends moved to Operations → Dividends module)

