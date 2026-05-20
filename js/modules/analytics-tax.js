// Tax & Annual Summary Analytics Dashboard — year-end accounting and tax filing support
import { el, openModal } from '../core/ui.js';
import * as charts from '../core/charts.js';
import { COST_CATEGORIES } from '../core/config.js';
import {
  formatEUR, toEUR, byId,
  listActive, listActivePayments,
  resolveExpenseFields, isCapEx
} from '../core/data.js';
import { mkSectionLabel, mkSummaryBox, mkSummaryGrid, mkModalTable, mkVarianceBadge, mkEmptyState, mkKpiCard } from './analytics-helpers.js';

// ── Constants ─────────────────────────────────────────────────────────────────
const CHART_IDS = ['tax-rev-exp-bar', 'tax-exp-cat-donut', 'tax-yoy-bar'];
const MONTH_LABELS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// ── Module state ──────────────────────────────────────────────────────────────
let gYear   = null;  // string like '2024'
let gOwner  = '';    // '' | 'you' | 'rita' | 'both'

// ── Module export ─────────────────────────────────────────────────────────────
export default {
  id:    'analytics-tax',
  label: 'Annual / Tax',
  icon:  '₪',
  render(container) { container.appendChild(buildView()); },
  refresh() { rebuildView(); },
  destroy() { CHART_IDS.forEach(id => charts.destroy(id)); }
};

// ── Utility helpers ───────────────────────────────────────────────────────────
function getDataYears() {
  const y = new Set();
  listActive('invoices').forEach(i => {
    const yr = (i.issueDate || '').slice(0, 4);
    if (yr >= '2000') y.add(yr);
  });
  listActivePayments().forEach(p => {
    const yr = (p.date || '').slice(0, 4);
    if (yr >= '2000') y.add(yr);
  });
  listActive('expenses').forEach(e => {
    const yr = (e.date || '').slice(0, 4);
    if (yr >= '2000') y.add(yr);
  });
  return [...y].sort().reverse(); // newest first
}

function defaultYear() {
  const now = new Date();
  const currentYear = String(now.getFullYear());
  const years = getDataYears();
  if (!years.length) return currentYear;
  // Prefer last full year; if we're in current year and there's data, show last year if available
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

// ── Data aggregation ──────────────────────────────────────────────────────────
function getYearData(year, ownerFilter) {
  const payments = listActivePayments().filter(p =>
    p.status === 'paid' && inYear(p.date, year) && ownerMatches(p, ownerFilter)
  );

  const invoices = listActive('invoices').filter(i =>
    i.status === 'paid' && inYear(i.issueDate || i.date, year) && invOwnerMatches(i, ownerFilter)
  );

  const allExp = listActive('expenses').filter(e =>
    inYear(e.date, year) && ownerMatches(e, ownerFilter)
  );
  const opExpenses  = allExp.filter(e => !isCapEx(e));
  const capExpenses = allExp.filter(e =>  isCapEx(e));

  // Revenue breakdown by stream
  const rentalPaymentsSTR = payments.filter(p => {
    const prop = byId('properties', p.propertyId);
    return p.stream === 'short_term_rental' || prop?.type === 'short_term';
  });
  const rentalPaymentsLTR = payments.filter(p => {
    const prop = byId('properties', p.propertyId);
    return p.stream === 'long_term_rental' || prop?.type === 'long_term';
  });
  const invoicesCS  = invoices.filter(i => i.stream === 'customer_success');
  const invoicesMkt = invoices.filter(i => i.stream === 'marketing_services');
  const invoicesOther = invoices.filter(i => !['customer_success','marketing_services'].includes(i.stream));

  const sum = (arr, getAmt, getDate) => arr.reduce((s, x) => s + toEUR(getAmt(x), x.currency, getDate(x)), 0);

  const revSTR   = sum(rentalPaymentsSTR, p => p.amount,  p => p.date);
  const revLTR   = sum(rentalPaymentsLTR, p => p.amount,  p => p.date);
  const revCS    = sum(invoicesCS,        i => i.total,   i => i.issueDate || i.date);
  const revMkt   = sum(invoicesMkt,       i => i.total,   i => i.issueDate || i.date);
  const revOther = sum(invoicesOther,     i => i.total,   i => i.issueDate || i.date);
  const totalRevenue = revSTR + revLTR + revCS + revMkt + revOther;

  // OpEx by category
  const catMap = new Map();
  for (const e of opExpenses) {
    const key = resolvedCatKey(e);
    const amt = toEUR(e.amount, e.currency, e.date);
    catMap.set(key, (catMap.get(key) || 0) + amt);
  }

  const totalOpEx  = opExpenses.reduce((s, e) => s + toEUR(e.amount, e.currency, e.date), 0);
  const totalCapEx = capExpenses.reduce((s, e) => s + toEUR(e.amount, e.currency, e.date), 0);

  const opProfit   = totalRevenue - totalOpEx;
  const netCash    = opProfit - totalCapEx;

  // Monthly data for charts (12 months)
  const monthly = Array.from({ length: 12 }, (_, mi) => {
    const mk = `${year}-${String(mi + 1).padStart(2, '0')}`;
    const rev = payments.filter(p => p.date?.startsWith(mk)).reduce((s, p) => s + toEUR(p.amount, p.currency, p.date), 0)
              + invoices.filter(i => (i.issueDate || '').startsWith(mk)).reduce((s, i) => s + toEUR(i.total, i.currency, i.issueDate), 0);
    const opex = opExpenses.filter(e => e.date?.startsWith(mk)).reduce((s, e) => s + toEUR(e.amount, e.currency, e.date), 0);
    return { mk, rev, opex };
  });

  // Forecast data
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
    revSTR, revLTR, revCS, revMkt, revOther, totalRevenue,
    catMap, totalOpEx, totalCapEx, opProfit, netCash,
    monthly,
    hasForecast, forecastRevenue, forecastExpenses, forecastNet
  };
}

// ── Rebuild ───────────────────────────────────────────────────────────────────
function rebuildView() {
  CHART_IDS.forEach(id => charts.destroy(id));
  const c = document.getElementById('content');
  if (!c) return;
  c.innerHTML = '';
  c.appendChild(buildView());
}

// ── Year selector bar ─────────────────────────────────────────────────────────
function buildYearSelectorBar(years, selectedYear, selectedOwner, onChange) {
  const bar = el('div', {
    style: 'display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:16px;padding:12px 16px;background:var(--bg-elev-1);border:1px solid var(--border);border-radius:var(--radius-sm)'
  });

  // Year pills
  const yearGroup = el('div', { style: 'display:flex;align-items:center;gap:6px;flex-wrap:wrap' });
  yearGroup.appendChild(el('span', {
    style: 'font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text-muted);margin-right:4px'
  }, 'Year'));

  for (const yr of years) {
    const isActive = yr === selectedYear;
    const pill = el('button', {
      style: [
        'padding:4px 12px;border-radius:14px;border:1px solid',
        isActive
          ? 'var(--accent);background:var(--accent);color:#fff;font-weight:600'
          : 'var(--border);background:transparent;color:var(--text-muted)',
        ';font-size:12px;cursor:pointer;transition:all 120ms'
      ].join(' ')
    }, yr);
    pill.addEventListener('click', () => onChange(yr, selectedOwner));
    yearGroup.appendChild(pill);
  }
  bar.appendChild(yearGroup);

  // Divider
  bar.appendChild(el('div', { style: 'width:1px;height:24px;background:var(--border)' }));

  // Owner filter
  const ownerGroup = el('div', { style: 'display:flex;align-items:center;gap:6px' });
  ownerGroup.appendChild(el('span', {
    style: 'font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text-muted);margin-right:4px'
  }, 'Owner'));

  const ownerOpts = [['', 'All'], ['you', 'Giorgos'], ['rita', 'Rita'], ['both', 'Both']];
  for (const [val, label] of ownerOpts) {
    const isActive = val === selectedOwner;
    const pill = el('button', {
      style: [
        'padding:4px 12px;border-radius:14px;border:1px solid',
        isActive
          ? 'var(--accent);background:var(--accent);color:#fff;font-weight:600'
          : 'var(--border);background:transparent;color:var(--text-muted)',
        ';font-size:12px;cursor:pointer;transition:all 120ms'
      ].join(' ')
    }, label);
    pill.addEventListener('click', () => onChange(selectedYear, val));
    ownerGroup.appendChild(pill);
  }
  bar.appendChild(ownerGroup);

  return bar;
}

// ── Annual P&L Table ──────────────────────────────────────────────────────────
function buildPnLTable(data) {
  const {
    revSTR, revLTR, revCS, revMkt, revOther, totalRevenue,
    catMap, totalOpEx, totalCapEx, opProfit, netCash
  } = data;

  const wrap = el('div', {
    class: 'card mb-16',
    style: 'background:var(--bg-elev-2)'
  });

  wrap.appendChild(el('div', { class: 'card-header' },
    el('div', { class: 'card-title' }, 'Annual Profit & Loss Statement'),
    el('div', { style: 'font-size:12px;color:var(--text-muted)' }, 'Cash basis · EUR')
  ));

  const tbl = el('table', {
    style: 'width:100%;border-collapse:collapse;font-size:13px;padding:16px'
  });
  const tbody = el('tbody');

  const mkRow = (label, value, opts = {}) => {
    const {
      isSectionHeader = false,
      isSectionTotal  = false,
      isSubtotal      = false,
      isSeparator     = false,
      isPositive      = null,
      indent          = 0
    } = opts;

    if (isSeparator) {
      const tr = el('tr');
      const td = el('td', {
        colspan: '2',
        style: 'padding:4px 16px;border-bottom:1px solid rgba(255,255,255,0.12)'
      });
      tr.appendChild(td);
      return tr;
    }

    const tr = el('tr');

    // Determine styles
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

    const labelTd = el('td', { style: labelStyle }, label);
    const valueTd = el('td', { style: valueStyle }, isSectionHeader ? '' : formatEUR(value));

    tr.appendChild(labelTd);
    if (!isSectionHeader) tr.appendChild(valueTd);
    return tr;
  };

  // INCOME
  tbody.appendChild(mkRow('INCOME', 0, { isSectionHeader: true }));
  if (revSTR   > 0) tbody.appendChild(mkRow('Rental Revenue (STR)',         revSTR,   { indent: 1 }));
  if (revLTR   > 0) tbody.appendChild(mkRow('Rental Revenue (LTR)',         revLTR,   { indent: 1 }));
  if (revCS    > 0) tbody.appendChild(mkRow('Service Revenue (CS)',          revCS,    { indent: 1 }));
  if (revMkt   > 0) tbody.appendChild(mkRow('Service Revenue (Marketing)',   revMkt,   { indent: 1 }));
  if (revOther > 0) tbody.appendChild(mkRow('Other Service Revenue',         revOther, { indent: 1 }));
  tbody.appendChild(mkRow(null, null, { isSeparator: true }));
  tbody.appendChild(mkRow('Total Revenue', totalRevenue, {
    isSectionTotal: true, isPositive: totalRevenue >= 0
  }));

  // OPERATING EXPENSES
  tbody.appendChild(mkRow('OPERATING EXPENSES', 0, { isSectionHeader: true }));
  const catEntries = [...catMap.entries()].sort((a, b) => b[1] - a[1]);
  for (const [catKey, amt] of catEntries) {
    const label = COST_CATEGORIES[catKey]?.label || catKey;
    tbody.appendChild(mkRow(label, amt, { indent: 1 }));
  }
  tbody.appendChild(mkRow(null, null, { isSeparator: true }));
  tbody.appendChild(mkRow('Total Operating Expenses', totalOpEx, {
    isSectionTotal: true, isPositive: false
  }));

  // Operating profit
  tbody.appendChild(mkRow('', 0, {})); // spacer
  tbody.appendChild(mkRow('Operating Profit', opProfit, {
    isSubtotal: true, isPositive: opProfit >= 0
  }));

  // CAPITAL EXPENDITURES
  tbody.appendChild(mkRow('CAPITAL EXPENDITURES (not P&L)', 0, { isSectionHeader: true }));
  tbody.appendChild(mkRow(null, null, { isSeparator: true }));
  tbody.appendChild(mkRow('Total CapEx', totalCapEx, {
    isSectionTotal: true, isPositive: null
  }));

  // Net Cash Used
  tbody.appendChild(mkRow('', 0, {}));
  tbody.appendChild(mkRow('Net Cash Used', netCash, {
    isSubtotal: true, isPositive: netCash >= 0
  }));

  tbl.appendChild(tbody);
  const tblWrap = el('div', { style: 'padding:0 0 16px' });
  tblWrap.appendChild(tbl);
  wrap.appendChild(tblWrap);

  return wrap;
}

// ── KPI Cards ─────────────────────────────────────────────────────────────────
function buildKpiCards(data, year) {
  const {
    totalRevenue, totalOpEx, totalCapEx, opProfit, netCash,
    hasForecast, forecastNet
  } = data;

  const operatingMargin = totalRevenue > 0 ? ((totalRevenue - totalOpEx) / totalRevenue * 100) : 0;

  const grid = el('div', {
    style: 'display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin-bottom:16px'
  });

  // 1. Operating Margin
  grid.appendChild(mkKpiCard({
    label: 'Operating Margin',
    value: `${operatingMargin.toFixed(1)}%`,
    subtitle: 'Revenue minus OpEx',
    variant: operatingMargin >= 50 ? 'success' : operatingMargin >= 20 ? 'warning' : 'danger',
    onClick: () => {
      const body = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });
      body.appendChild(mkSummaryGrid([
        { label: 'Total Revenue',     value: formatEUR(totalRevenue) },
        { label: 'Total OpEx',        value: formatEUR(totalOpEx) },
        { label: 'Operating Profit',  value: formatEUR(opProfit) },
        { label: 'Operating Margin',      value: `${operatingMargin.toFixed(2)}%` }
      ], 2));
      body.appendChild(el('div', {
        style: 'font-size:12px;color:var(--text-muted);line-height:1.5'
      }, 'Operating Margin = (Revenue − OpEx) ÷ Revenue × 100. Excludes CapEx as it is a balance-sheet item.'));
      openModal({ title: 'Operating Margin — Breakdown', body });
    }
  ));

  // 2. Total Tax-Deductible
  grid.appendChild(mkKpiCard({
    label: 'Total Tax-Deductible',
    value: formatEUR(totalOpEx),
    subtitle: 'Estimated deductible OpEx',
    variant: '',
    onClick: () => {
      const body = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });
      const catEntries = [...data.catMap.entries()].sort((a, b) => b[1] - a[1]);
      body.appendChild(mkSectionLabel('OpEx by Category'));
      body.appendChild(mkModalTable(
        ['Category', 'Amount', '% of OpEx'],
        catEntries.map(([k, v]) => [
          COST_CATEGORIES[k]?.label || k,
          formatEUR(v),
          totalOpEx > 0 ? (v / totalOpEx * 100).toFixed(1) + '%' : '—'
        ])
      ));
      body.appendChild(el('div', {
        style: 'font-size:12px;color:var(--text-muted);line-height:1.5;margin-top:8px'
      }, 'Operating expenses are generally deductible for tax purposes. CapEx is typically depreciated over the asset\'s useful life. Consult your accountant for specific deductibility.'));
      openModal({ title: 'Tax-Deductible OpEx — Breakdown', body, large: true });
    }
  }));

  // 3. Capital Deployed
  grid.appendChild(mkKpiCard({
    label: 'Capital Deployed',
    value: formatEUR(totalCapEx),
    subtitle: 'Non-deductible (depreciated)',
    variant: totalCapEx > 0 ? 'warning' : '',
    onClick: () => {
      const body = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });
      const capByCategory = new Map();
      for (const e of data.capExpenses) {
        const key = resolvedCatKey(e);
        const amt = toEUR(e.amount, e.currency, e.date);
        capByCategory.set(key, (capByCategory.get(key) || 0) + amt);
      }
      const catEntries = [...capByCategory.entries()].sort((a, b) => b[1] - a[1]);
      body.appendChild(mkSummaryGrid([
        { label: 'Total CapEx', value: formatEUR(totalCapEx), sub: `${data.capExpenses.length} items` },
        { label: 'As % of Revenue', value: totalRevenue > 0 ? (totalCapEx / totalRevenue * 100).toFixed(1) + '%' : '—', sub: 'Capital intensity' }
      ], 2));
      if (catEntries.length > 0) {
        body.appendChild(mkSectionLabel('CapEx by Category'));
        body.appendChild(mkModalTable(
          ['Category', 'Amount', '% of CapEx'],
          catEntries.map(([k, v]) => [
            COST_CATEGORIES[k]?.label || k,
            formatEUR(v),
            totalCapEx > 0 ? (v / totalCapEx * 100).toFixed(1) + '%' : '—'
          ])
        ));
      } else {
        body.appendChild(mkEmptyState('No CapEx recorded for this year.'));
      }
      openModal({ title: 'Capital Deployed — Breakdown', body, large: true });
    }
  }));

  // 4. Year vs Forecast
  if (hasForecast) {
    const actualNet  = opProfit;
    const variance   = actualNet - forecastNet;
    const variantStr = variance >= 0 ? 'success' : 'danger';
    const forecastCard = mkKpiCard({
      label: 'Year vs Forecast',
      value: formatEUR(actualNet),
      variant: variantStr,
      onClick: () => {
        const body = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });
        body.appendChild(mkSummaryGrid([
          { label: 'Actual Revenue',       value: formatEUR(totalRevenue) },
          { label: 'Forecast Revenue',     value: formatEUR(data.forecastRevenue) },
          { label: 'Actual OpEx',          value: formatEUR(totalOpEx) },
          { label: 'Forecast Expenses',    value: formatEUR(data.forecastExpenses) },
          { label: 'Actual Net (OpEx)',     value: formatEUR(actualNet) },
          { label: 'Forecast Net',         value: formatEUR(forecastNet) }
        ], 2));
        body.appendChild(mkSectionLabel('Variance'));
        body.appendChild(mkModalTable(
          ['Metric', 'Actual', 'Forecast', 'Variance'],
          [
            ['Revenue',     formatEUR(totalRevenue),         formatEUR(data.forecastRevenue),  formatEUR(totalRevenue - data.forecastRevenue)],
            ['Expenses',    formatEUR(totalOpEx),            formatEUR(data.forecastExpenses), formatEUR(totalOpEx - data.forecastExpenses)],
            ['Net (OpEx)',  formatEUR(actualNet),            formatEUR(forecastNet),           formatEUR(variance)]
          ]
        ));
        openModal({ title: `${year} Actual vs Forecast`, body, large: true });
      }
    });
    // Safely insert variance badge + label as DOM nodes before the accent bar (avoids outerHTML injection)
    const subtitleEl = el('div', { style: 'font-size:11px;color:var(--text-muted);margin-top:2px;display:flex;align-items:center;gap:4px' });
    subtitleEl.appendChild(mkVarianceBadge(variance, formatEUR(Math.abs(variance))));
    subtitleEl.appendChild(document.createTextNode(' vs forecast net'));
    const accentBar = forecastCard.querySelector('.kpi-accent-bar');
    forecastCard.insertBefore(subtitleEl, accentBar);
    grid.appendChild(forecastCard);
  } else {
    grid.appendChild(mkKpiCard({
      label: 'Year vs Forecast',
      value: '—',
      subtitle: 'No forecast set for this year'
    }));
  }

  return grid;
}

// ── Expense Categories Table ──────────────────────────────────────────────────
function buildExpenseCategoryTable(data) {
  const { catMap, totalOpEx, capExpenses } = data;

  // Build capex by category too
  const capCatMap = new Map();
  for (const e of capExpenses) {
    const key = resolvedCatKey(e);
    const amt = toEUR(e.amount, e.currency, e.date);
    capCatMap.set(key, (capCatMap.get(key) || 0) + amt);
  }

  const wrap = el('div', { class: 'card mb-16' });
  wrap.appendChild(el('div', { class: 'card-header' },
    el('div', { class: 'card-title' }, 'Expense Categories'),
    el('div', { style: 'font-size:12px;color:var(--text-muted)' }, 'Click a row to see individual records')
  ));

  // Build combined list: OpEx categories + CapEx categories
  const rows = [];
  for (const [catKey, amt] of [...catMap.entries()].sort((a, b) => b[1] - a[1])) {
    const expList = data.opExpenses.filter(e => resolvedCatKey(e) === catKey);
    rows.push({ catKey, amt, count: expList.length, isCapex: false, expList });
  }
  for (const [catKey, amt] of [...capCatMap.entries()].sort((a, b) => b[1] - a[1])) {
    const expList = capExpenses.filter(e => resolvedCatKey(e) === catKey);
    rows.push({ catKey, amt, count: expList.length, isCapex: true, expList });
  }

  if (!rows.length) {
    wrap.appendChild(mkEmptyState('No expense data for this year.'));
    return wrap;
  }

  const tbl = el('table', { style: 'width:100%;border-collapse:collapse;font-size:13px' });

  // Header
  const hrow = el('tr');
  ['Category', 'Count', 'Total (€)', '% of OpEx', 'Type'].forEach((h, hi) => {
    hrow.appendChild(el('th', {
      style: `padding:8px 12px;text-align:${hi === 0 ? 'left' : 'right'};font-size:11px;font-weight:600;` +
             `text-transform:uppercase;letter-spacing:.04em;color:var(--text-muted);` +
             `border-bottom:1px solid rgba(255,255,255,0.08)`
    }, h));
  });
  tbl.appendChild(el('thead', {}, hrow));

  const tbody = el('tbody');
  rows.forEach((row, ri) => {
    const tr = el('tr', {
      style: [
        ri % 2 === 1 ? 'background:rgba(255,255,255,0.02)' : '',
        'cursor:pointer;transition:background 80ms'
      ].join(';')
    });
    tr.addEventListener('mouseenter', () => { tr.style.background = 'rgba(255,255,255,0.05)'; });
    tr.addEventListener('mouseleave', () => { tr.style.background = ri % 2 === 1 ? 'rgba(255,255,255,0.02)' : ''; });

    const dotColor = catColor(row.catKey);
    const labelCell = el('td', { style: 'padding:8px 12px;display:flex;align-items:center;gap:8px' });
    const dot = el('span', { style: `width:8px;height:8px;border-radius:50%;background:${dotColor};flex-shrink:0;display:inline-block` });
    labelCell.appendChild(dot);
    labelCell.appendChild(document.createTextNode(COST_CATEGORIES[row.catKey]?.label || row.catKey));
    tr.appendChild(labelCell);

    const pctOfOpEx = (!row.isCapex && totalOpEx > 0) ? (row.amt / totalOpEx * 100).toFixed(1) + '%' : '—';
    [
      [String(row.count),       'right'],
      [formatEUR(row.amt),      'right'],
      [pctOfOpEx,               'right'],
      [row.isCapex ? 'CapEx' : 'OpEx', 'right']
    ].forEach(([text, align]) => {
      tr.appendChild(el('td', { style: `padding:8px 12px;text-align:${align};color:var(--text-muted)` }, text));
    });

    tr.onclick = () => openCategoryModal(row.catKey, row.expList, row.isCapex, row.amt);
    tbody.appendChild(tr);
  });
  tbl.appendChild(tbody);

  const tblWrap = el('div', { style: 'padding:0 0 8px' });
  tblWrap.appendChild(tbl);
  wrap.appendChild(tblWrap);

  return wrap;
}

function openCategoryModal(catKey, expList, isCapex, total) {
  const label = COST_CATEGORIES[catKey]?.label || catKey;
  const body  = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });

  body.appendChild(mkSummaryGrid([
    { label: 'Category',   value: label,                        sub: isCapex ? 'CapEx' : 'OpEx' },
    { label: 'Total',      value: formatEUR(total),             sub: `${expList.length} records` },
    { label: 'Avg Amount', value: expList.length > 0 ? formatEUR(total / expList.length) : '—', sub: 'per expense' }
  ], 3));

  body.appendChild(mkSectionLabel('Individual Records'));

  const sorted = [...expList].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  body.appendChild(mkModalTable(
    ['Date', 'Description', 'Property / Vendor', 'Amount (EUR)'],
    sorted.map(e => {
      const prop   = e.propertyId ? byId('properties', e.propertyId)?.name : null;
      const vendor = e.vendorId   ? byId('vendors', e.vendorId)?.name      : null;
      return [
        e.date || '—',
        e.description || e.notes || '—',
        prop || vendor || '—',
        formatEUR(toEUR(e.amount, e.currency, e.date))
      ];
    })
  ));

  openModal({ title: `${label} — Expense Detail`, body, large: true });
}

// ── Charts section ────────────────────────────────────────────────────────────
function buildCharts(data, year) {
  const wrap = el('div');

  // Chart row 1: Monthly bar + donut
  const row1 = el('div', { style: 'display:grid;grid-template-columns:2fr 1fr;gap:16px;margin-bottom:16px' });

  row1.appendChild(el('div', { class: 'card' },
    el('div', { class: 'card-header' },
      el('div', { class: 'card-title' }, 'Monthly Revenue vs Operating Expenses'),
      el('div', { style: 'font-size:12px;color:var(--text-muted)' }, 'Operating P&L view — CapEx excluded')
    ),
    el('div', { class: 'chart-wrap tall' }, el('canvas', { id: 'tax-rev-exp-bar' }))
  ));

  row1.appendChild(el('div', { class: 'card' },
    el('div', { class: 'card-header' },
      el('div', { class: 'card-title' }, 'OpEx by Category'),
      el('div', { style: 'font-size:12px;color:var(--text-muted)' }, 'Click slice for detail')
    ),
    el('div', { class: 'chart-wrap tall' }, el('canvas', { id: 'tax-exp-cat-donut' }))
  ));
  wrap.appendChild(row1);

  // Chart row 2: Year-over-year
  wrap.appendChild(el('div', { class: 'card mb-16' },
    el('div', { class: 'card-header' },
      el('div', { class: 'card-title' }, 'Year-over-Year Revenue Comparison'),
      el('div', { style: 'font-size:12px;color:var(--text-muted)' }, 'Click a bar to see that year\'s P&L summary')
    ),
    el('div', { class: 'chart-wrap tall' }, el('canvas', { id: 'tax-yoy-bar' }))
  ));

  return wrap;
}

function renderCharts(data, year, ownerFilter) {
  // ── Chart 1: Monthly Revenue vs OpEx bar ─────────────────────────────────
  charts.bar('tax-rev-exp-bar', {
    labels:   MONTH_LABELS,
    datasets: [
      {
        label: 'Revenue',
        data:  data.monthly.map(m => Math.round(m.rev)),
        backgroundColor: 'rgba(16,185,129,0.75)',
        borderColor:     '#10b981',
        borderWidth:     1
      },
      {
        label: 'Operating Expenses',
        data:  data.monthly.map(m => Math.round(m.opex)),
        backgroundColor: 'rgba(239,68,68,0.65)',
        borderColor:     '#ef4444',
        borderWidth:     1
      }
    ],
    onClickItem: (label, index) => {
      const m = data.monthly[index];
      if (!m) return;
      const mk = m.mk; // e.g. '2024-03'
      const monthLabel = MONTH_LABELS[index];

      // Revenue sources for this month
      const monthPayments = data.payments.filter(p => p.date?.startsWith(mk));
      const monthInvoices = data.invoices.filter(i => (i.issueDate || '').startsWith(mk));
      const monthExpenses = data.opExpenses.filter(e => e.date?.startsWith(mk));

      const body = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });

      body.appendChild(mkSummaryGrid([
        { label: 'Revenue',           value: formatEUR(m.rev)  },
        { label: 'Operating Expenses', value: formatEUR(m.opex) },
        { label: 'Net',               value: formatEUR(m.rev - m.opex) }
      ], 3));

      if (monthPayments.length > 0 || monthInvoices.length > 0) {
        body.appendChild(mkSectionLabel('Revenue Breakdown'));
        const revRows = [
          ...monthPayments.map(p => {
            const prop = p.propertyId ? byId('properties', p.propertyId)?.name : null;
            return [p.date || '—', prop || '—', 'Payment', formatEUR(toEUR(p.amount, p.currency, p.date))];
          }),
          ...monthInvoices.map(i => {
            const client = i.clientId ? byId('clients', i.clientId)?.name : null;
            return [i.issueDate || '—', client || '—', 'Invoice', formatEUR(toEUR(i.total, i.currency, i.issueDate))];
          })
        ].sort((a, b) => a[0].localeCompare(b[0]));
        body.appendChild(mkModalTable(['Date', 'Entity', 'Type', 'Amount (EUR)'], revRows));
      }

      if (monthExpenses.length > 0) {
        body.appendChild(mkSectionLabel('Expense Breakdown'));
        const expRows = monthExpenses
          .sort((a, b) => (a.date || '').localeCompare(b.date || ''))
          .map(e => {
            const prop   = e.propertyId ? byId('properties', e.propertyId)?.name : null;
            const vendor = e.vendorId   ? byId('vendors', e.vendorId)?.name      : null;
            return [e.date || '—', e.description || e.notes || '—', prop || vendor || '—', formatEUR(toEUR(e.amount, e.currency, e.date))];
          });
        body.appendChild(mkModalTable(['Date', 'Description', 'Entity', 'Amount (EUR)'], expRows));
      }

      if (!monthPayments.length && !monthInvoices.length && !monthExpenses.length) {
        body.appendChild(mkEmptyState('No data for this month.'));
      }

      openModal({ title: `${monthLabel} ${year} — Revenue & Expense Detail`, body, large: true });
    }
  });

  // ── Chart 2: OpEx category donut ──────────────────────────────────────────
  const catEntries = [...data.catMap.entries()].sort((a, b) => b[1] - a[1]);
  if (catEntries.length > 0) {
    charts.doughnut('tax-exp-cat-donut', {
      labels: catEntries.map(([k]) => COST_CATEGORIES[k]?.label || k),
      data:   catEntries.map(([, v]) => Math.round(v)),
      colors: catEntries.map(([k]) => catColor(k)),
      onClickItem: (label, index) => {
        const [catKey] = catEntries[index];
        const expList = data.opExpenses.filter(e => resolvedCatKey(e) === catKey);
        openCategoryModal(catKey, expList, false, catEntries[index][1]);
      }
    });
  }

  // ── Chart 3: Year-over-Year bar ───────────────────────────────────────────
  const allYears = getDataYears().reverse(); // oldest first for the chart
  const yoyRevenue = [];
  const yoyOpEx    = [];

  for (const yr of allYears) {
    const d = getYearData(yr, ownerFilter);
    yoyRevenue.push(Math.round(d.totalRevenue));
    yoyOpEx.push(Math.round(d.totalOpEx));
  }

  charts.bar('tax-yoy-bar', {
    labels: allYears,
    datasets: [
      {
        label: 'Revenue',
        data:  yoyRevenue,
        backgroundColor: 'rgba(16,185,129,0.75)',
        borderColor:     '#10b981',
        borderWidth:     1
      },
      {
        label: 'Operating Expenses',
        data:  yoyOpEx,
        backgroundColor: 'rgba(239,68,68,0.65)',
        borderColor:     '#ef4444',
        borderWidth:     1
      }
    ],
    onClickItem: (label) => {
      const clickedYear = label;
      const d = getYearData(clickedYear, ownerFilter);
      const body = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });
      body.appendChild(mkSummaryGrid([
        { label: 'Total Revenue',        value: formatEUR(d.totalRevenue)  },
        { label: 'Total OpEx',           value: formatEUR(d.totalOpEx)     },
        { label: 'Operating Profit',     value: formatEUR(d.opProfit)      },
        { label: 'CapEx',                value: formatEUR(d.totalCapEx)    },
        { label: 'Net Cash Used',        value: formatEUR(d.netCash)       },
        { label: 'Operating Margin',         value: d.totalRevenue > 0 ? (d.opProfit / d.totalRevenue * 100).toFixed(1) + '%' : '—' }
      ], 3));
      const catEnt = [...d.catMap.entries()].sort((a, b) => b[1] - a[1]);
      if (catEnt.length > 0) {
        body.appendChild(mkSectionLabel('OpEx by Category'));
        body.appendChild(mkModalTable(
          ['Category', 'Amount', '% of OpEx'],
          catEnt.map(([k, v]) => [
            COST_CATEGORIES[k]?.label || k,
            formatEUR(v),
            d.totalOpEx > 0 ? (v / d.totalOpEx * 100).toFixed(1) + '%' : '—'
          ])
        ));
      }
      openModal({ title: `${clickedYear} Annual P&L Summary`, body, large: true });
    }
  });
}

// ── Tax CSV Download ──────────────────────────────────────────────────────────
function downloadTaxCsv(year, catData, totalOpEx, totalCapEx, totalRevenue) {
  const rows = [['Category', 'Type', 'Count', 'Amount EUR', '% of OpEx']];
  catData.opex.forEach(c => rows.push([c.label, 'OpEx', c.count, c.total.toFixed(2), (c.total / totalOpEx * 100).toFixed(1) + '%']));
  catData.capex.forEach(c => rows.push([c.label, 'CapEx', c.count, c.total.toFixed(2), '—']));
  rows.push(['TOTAL OpEx', '', '', totalOpEx.toFixed(2), '100%']);
  rows.push(['TOTAL CapEx', '', '', totalCapEx.toFixed(2), '—']);
  rows.push(['TOTAL Revenue', '', '', totalRevenue.toFixed(2), '—']);

  const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `tax-summary-${year}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Tax Export Section ────────────────────────────────────────────────────────
function buildTaxExportSection(data, year) {
  const wrap = el('div', { class: 'card mb-16' });
  wrap.appendChild(el('div', { class: 'card-header' },
    el('div', { class: 'card-title' }, 'Tax Export'),
    el('div', { style: 'font-size:12px;color:var(--text-muted)' }, 'Export a formatted summary for your accountant')
  ));

  const inner = el('div', { style: 'padding:16px;display:flex;align-items:center;gap:16px;flex-wrap:wrap' });

  const toast = el('div', {
    style: [
      'display:none;padding:8px 16px;border-radius:6px;background:var(--success,#10b981);color:#fff;',
      'font-size:13px;font-weight:600;transition:opacity 200ms'
    ].join('')
  }, 'Copied to clipboard!');

  const btn = el('button', {
    class: 'btn btn-primary',
    style: 'display:flex;align-items:center;gap:8px;font-size:13px'
  });
  btn.appendChild(el('span', {}, '📋'));
  btn.appendChild(document.createTextNode('Copy for Accountant'));

  btn.addEventListener('click', () => {
    const catEntries = [...data.catMap.entries()].sort((a, b) => b[1] - a[1]);
    const catLines = catEntries
      .map(([k, v]) => `  ${COST_CATEGORIES[k]?.label || k}: ${formatEUR(v)}`)
      .join('\n');

    const text = [
      `Annual P&L Summary — ${year}`,
      `Revenue: ${formatEUR(data.totalRevenue)}`,
      `Operating Expenses: ${formatEUR(data.totalOpEx)}`,
      `Operating Profit: ${formatEUR(data.opProfit)}`,
      `Capital Expenditures: ${formatEUR(data.totalCapEx)}`,
      `Net Cash: ${formatEUR(data.netCash)}`,
      '',
      'Expense Breakdown:',
      catLines,
      '',
      `Generated: ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}`
    ].join('\n');

    navigator.clipboard.writeText(text).then(() => {
      toast.style.display = 'inline-block';
      setTimeout(() => { toast.style.display = 'none'; }, 2500);
    }).catch(() => {
      // Fallback: show a textarea with the text
      const fallbackModal = el('div', { style: 'display:flex;flex-direction:column;gap:12px' });
      fallbackModal.appendChild(el('div', { style: 'font-size:13px;color:var(--text-muted)' }, 'Copy the text below:'));
      const ta = el('textarea', {
        style: 'width:100%;height:200px;padding:10px;font-family:monospace;font-size:12px;background:var(--bg-elev-2);color:var(--text);border:1px solid var(--border);border-radius:4px;resize:vertical',
        readonly: ''
      });
      ta.value = text;
      fallbackModal.appendChild(ta);
      openModal({ title: 'Copy for Accountant', body: fallbackModal, large: true });
    });
  });

  // Build catData for CSV export
  const buildCatData = () => {
    const opex = [...data.catMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([k, total]) => ({
        label: COST_CATEGORIES[k]?.label || k,
        count: data.opExpenses.filter(e => resolvedCatKey(e) === k).length,
        total
      }));

    const capCatMap = new Map();
    for (const e of data.capExpenses) {
      const key = resolvedCatKey(e);
      const amt = toEUR(e.amount, e.currency, e.date);
      capCatMap.set(key, (capCatMap.get(key) || 0) + amt);
    }
    const capex = [...capCatMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([k, total]) => ({
        label: COST_CATEGORIES[k]?.label || k,
        count: data.capExpenses.filter(e => resolvedCatKey(e) === k).length,
        total
      }));

    return { opex, capex };
  };

  const csvBtn = el('button', {
    class: 'btn btn-secondary',
    style: 'display:flex;align-items:center;gap:8px;font-size:13px'
  });
  csvBtn.appendChild(el('span', {}, '⬇'));
  csvBtn.appendChild(document.createTextNode('Download CSV'));
  csvBtn.addEventListener('click', () => {
    downloadTaxCsv(year, buildCatData(), data.totalOpEx, data.totalCapEx, data.totalRevenue);
  });

  inner.appendChild(btn);
  inner.appendChild(csvBtn);
  inner.appendChild(toast);
  inner.appendChild(el('div', {
    style: 'font-size:12px;color:var(--text-muted);line-height:1.5'
  }, `Copies a plain-text summary of ${year} P&L including revenue, operating expenses, and expense breakdown by category.`));

  wrap.appendChild(inner);
  return wrap;
}

// ── Main view builder ─────────────────────────────────────────────────────────
function buildView() {
  // Initialize year/owner if not set
  const years = getDataYears();
  if (!gYear || !years.includes(gYear)) {
    gYear = defaultYear();
  }

  const wrap = el('div', { class: 'view active' });

  // Header
  wrap.appendChild(el('div', { style: 'margin-bottom:16px' },
    el('h2', { style: 'margin:0 0 4px;font-size:20px;font-weight:700' }, 'Annual / Tax Summary'),
    el('p',  { style: 'margin:0;font-size:13px;color:var(--text-muted)' },
      'Year-end P&L, tax-deductible expense analysis, and annual comparisons')
  ));

  if (!years.length) {
    wrap.appendChild(el('div', { style: 'padding:40px;text-align:center;color:var(--text-muted);font-size:14px' },
      'No data found. Add payments, invoices, or expenses to get started.'
    ));
    return wrap;
  }

  // Year selector bar (custom — no standard filter bar)
  const selectorBar = buildYearSelectorBar(years, gYear, gOwner, (newYear, newOwner) => {
    gYear  = newYear;
    gOwner = newOwner;
    rebuildView();
  });
  wrap.appendChild(selectorBar);

  // Load data for selected year/owner
  const data = getYearData(gYear, gOwner);

  // Annual P&L Table
  wrap.appendChild(buildPnLTable(data));

  // KPI Cards
  wrap.appendChild(buildKpiCards(data, gYear));

  // Expense Categories Table
  wrap.appendChild(buildExpenseCategoryTable(data));

  // Charts
  wrap.appendChild(buildCharts(data, gYear));

  // Tax Export
  wrap.appendChild(buildTaxExportSection(data, gYear));

  // Render charts after DOM is ready
  requestAnimationFrame(() => renderCharts(data, gYear, gOwner));

  return wrap;
}
