// Expense Analytics Dashboard — understand cost structure
import { el, buildMultiSelect, button, fmtDate, monthLabel, drillDownModal, attachSortFilter, openModal } from '../core/ui.js';
import * as charts from '../core/charts.js';
import { STREAMS, COST_CATEGORIES, ACCOUNTING_TYPES } from '../core/config.js';
import {
  formatEUR, toEUR, byId,
  listActive, listActiveVendors, listActivePayments,
  isCapEx, resolveExpenseFields, companyPropIds
} from '../core/data.js';
import {
  createFilterState, getCurrentPeriodRange, getComparisonRange,
  getMonthKeysForRange, makeMatchers, buildFilterBar, buildComparisonLine
} from './analytics-filters.js?v=20260519';
import { mkSectionLabel, mkSummaryBox, mkSummaryGrid, mkModalTable, mkKpiCard, mkCmpGrid, mkEmptyState, expStream, safePct, mkInsightsBanner } from './analytics-helpers.js';

// ── Filter state ──────────────────────────────────────────────────────────────
let gF = createFilterState();
let gScope = 'company'; // 'company' | 'all'

// Expense-specific local filters (not handled by shared filter bar)
let gExpFilters = {
  categories:      new Set(),
  vendorIds:       new Set(),
  accountingTypes: new Set()
};

const CHART_IDS  = ['exp-cat-bar', 'exp-stream-donut', 'exp-vendor-bar', 'exp-cat-hbar', 'exp-type-donut', 'exp-prop-hbar'];

// Derives the set of costCategory keys that contain at least one CapEx expense.
// Replaces the old hardcoded CAPEX_CATS constant so new accountingType-based
// CapEx records are always classified correctly.
function getCapExCatKeys(allExp) {
  const s = new Set();
  allExp.forEach(e => { if (isCapEx(e)) s.add(resolveExpenseFields(e).costCategory); });
  return s;
}

let _capexSortCol   = -1, _capexSortDir   = 1;
let _expTableSortCol = -1, _expTableSortDir = 1;

// ── Module export ─────────────────────────────────────────────────────────────
export default {
  id:    'analytics-expenses',
  label: 'Expenses',
  icon:  '📉',
  render(container) { container.appendChild(buildView()); },
  refresh() { rebuildView(); },
  destroy() { CHART_IDS.forEach(id => charts.destroy(id)); }
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function vendorLabel(e) {
  if (e.vendorId) return byId('vendors', e.vendorId)?.name || e.vendor || '—';
  return e.vendor || '—';
}

// ── Data fetching ─────────────────────────────────────────────────────────────
function getData(start, end) {
  const { mStream, mOwner, mProperty } = makeMatchers(gF);
  const coPropIds = companyPropIds();
  const isCoRec = gScope === 'all'
    ? () => true
    : r => !r.propertyId || coPropIds.has(r.propertyId);
  const vendors = listActiveVendors();
  const vMap    = new Map(vendors.map(v => [v.name, v.id]));

  const allExp = listActive('expenses').filter(e => {
    const d = e.date || '';
    if (d < start || d > end) return false;
    if (!mStream(e) || !mOwner(e) || !mProperty(e)) return false;
    if (!isCoRec(e)) return false;
    if (gExpFilters.categories.size > 0) {
      if (!gExpFilters.categories.has(resolveExpenseFields(e).costCategory)) return false;
    }
    if (gExpFilters.vendorIds.size > 0) {
      const vid = e.vendorId || (e.vendor ? vMap.get(e.vendor) : null);
      if (!vid || !gExpFilters.vendorIds.has(vid)) return false;
    }
    if (gExpFilters.accountingTypes.size > 0) {
      if (!gExpFilters.accountingTypes.has(isCapEx(e) ? 'capex' : 'opex')) return false;
    }
    return true;
  });

  const opEx     = allExp.filter(e => !isCapEx(e));
  const capEx    = allExp.filter(e =>  isCapEx(e));
  const opTotal  = opEx.reduce( (s, e) => s + toEUR(e.amount, e.currency, e.date), 0);
  const capTotal = capEx.reduce((s, e) => s + toEUR(e.amount, e.currency, e.date), 0);
  return { allExp, opEx, capEx, opTotal, capTotal, total: opTotal + capTotal };
}

function getRevenue(start, end) {
  const { mStream, mOwner, mProperty, mClient } = makeMatchers(gF);
  const coPropIds = companyPropIds();
  const isCoRec = gScope === 'all'
    ? () => true
    : r => !r.propertyId || coPropIds.has(r.propertyId);
  const rentals = listActivePayments()
    .filter(p => p.status === 'paid' && (p.date || '') >= start && (p.date || '') <= end && mStream(p) && mOwner(p) && mProperty(p) && isCoRec(p))
    .reduce((s, p) => s + toEUR(p.amount, p.currency, p.date), 0);
  // Include paid service invoices so expense ratio reflects total revenue, not rental-only
  const services = listActive('invoices')
    .filter(i => i.status === 'paid' && (i.issueDate || '') >= start && (i.issueDate || '') <= end && mStream(i) && mOwner(i) && mClient(i))
    .reduce((s, i) => s + toEUR(i.total, i.currency, i.issueDate), 0);
  return { total: rentals + services, rentals, services };
}

// ── Rebuild ───────────────────────────────────────────────────────────────────
function rebuildView() {
  CHART_IDS.forEach(id => charts.destroy(id));
  const c = document.getElementById('content');
  if (!c) return;
  c.innerHTML = '';
  c.appendChild(buildView());
}

// ── Drill-down rows ───────────────────────────────────────────────────────────
function toExpDrillRows(expenses) {
  return expenses.map(e => {
    const resolved = resolveExpenseFields(e);
    return {
      date:        e.date,
      type:        isCapEx(e) ? 'CapEx' : 'OpEx',
      source:      byId('properties', e.propertyId)?.name || '—',
      category:    COST_CATEGORIES[resolved.costCategory]?.label || resolved.costCategory || e.category || '—',
      vendor:      vendorLabel(e),
      description: e.description || '—',
      eur:         toEUR(e.amount, e.currency, e.date)
    };
  }).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

const DRILL_COLS = [
  { key: 'date',        label: 'Date',        format: v => fmtDate(v) },
  { key: 'type',        label: 'Type'         },
  { key: 'source',      label: 'Property'     },
  { key: 'category',    label: 'Category'     },
  { key: 'vendor',      label: 'Vendor'       },
  { key: 'description', label: 'Description'  },
  { key: 'eur',         label: 'EUR',          right: true, format: v => formatEUR(v) }
];

// ── Expense Insights (same card-grid format as Executive Insights) ────────────
function computeExpenseInsights({ allExp, opTotal, capTotal, total, revenue, curRange, cmpData }) {
  const signals = []; // { title, text, severity: 'At Risk'|'Watch'|'Note', inspect, onClick }
  if (total === 0) return signals;

  // Cost pressure: OpEx / Revenue
  const opRatio = revenue > 0 ? (opTotal / revenue) * 100 : null;
  if (opRatio !== null && opRatio > 100) {
    signals.push({
      title:    'Cost Pressure',
      text:     `Operating cost ratio is ${opRatio.toFixed(0)}% — OpEx exceeds revenue. Portfolio is unprofitable for this period.`,
      severity: 'At Risk',
      inspect:  'Expense Records',
      onClick:  () => drillDownModal('Operating Expenses', toExpDrillRows(allExp.filter(e => !isCapEx(e))), DRILL_COLS)
    });
  } else if (opRatio !== null && opRatio > 80) {
    signals.push({
      title:    'Cost Pressure',
      text:     `Operating cost ratio is ${opRatio.toFixed(0)}% — OpEx consumes over 80% of revenue. Margins are thin.`,
      severity: 'Watch',
      inspect:  'Expense Records',
      onClick:  () => drillDownModal('Operating Expenses', toExpDrillRows(allExp.filter(e => !isCapEx(e))), DRILL_COLS)
    });
  }

  // CapEx concentration
  const capPct = (capTotal / total) * 100;
  if (capPct > 50) {
    signals.push({
      title:    'Capital Expenditure',
      text:     `CapEx is ${capPct.toFixed(0)}% of total expenses — major capital investment activity. Verify this is planned.`,
      severity: 'Watch',
      inspect:  'CapEx Detail',
      onClick:  () => drillDownModal('CapEx', toExpDrillRows(allExp.filter(e => isCapEx(e))), DRILL_COLS)
    });
  } else if (capPct > 30) {
    signals.push({
      title:    'Capital Expenditure',
      text:     `CapEx is ${capPct.toFixed(0)}% of total expenses — elevated capital investment activity.`,
      severity: 'Note',
      inspect:  'CapEx Detail',
      onClick:  () => drillDownModal('CapEx', toExpDrillRows(allExp.filter(e => isCapEx(e))), DRILL_COLS)
    });
  }

  // Category concentration
  const catMap = new Map();
  allExp.forEach(e => {
    const cat = resolveExpenseFields(e).costCategory || 'other';
    catMap.set(cat, (catMap.get(cat) || 0) + toEUR(e.amount, e.currency, e.date));
  });
  const topCat = [...catMap.entries()].sort((a, b) => b[1] - a[1])[0];
  if (topCat && topCat[1] / total > 0.55) {
    const pct = Math.round(topCat[1] / total * 100);
    const lbl = COST_CATEGORIES[topCat[0]]?.label || topCat[0];
    signals.push({
      title:    'Cost Concentration',
      text:     `"${lbl}" is the dominant cost category at ${pct}% of total spend.`,
      severity: 'Note',
      inspect:  'Category Breakdown',
      onClick:  () => drillDownModal(`Expenses — ${lbl}`, toExpDrillRows(allExp.filter(e => resolveExpenseFields(e).costCategory === topCat[0])), DRILL_COLS)
    });
  }

  // Vendor concentration — Fix 3: name vendor, show amount/%, show trend vs comparison
  const vendMap = new Map();
  allExp.forEach(e => {
    const name = vendorLabel(e);
    if (name === '—') return;
    vendMap.set(name, (vendMap.get(name) || 0) + toEUR(e.amount, e.currency, e.date));
  });
  const topVend = [...vendMap.entries()].sort((a, b) => b[1] - a[1])[0];
  if (topVend && topVend[1] / total > 0.5) {
    const pct = Math.round(topVend[1] / total * 100);
    let trendText = '';
    if (cmpData && cmpData.total > 0) {
      const cmpVendMap = new Map();
      cmpData.allExp.forEach(e => {
        const name = vendorLabel(e);
        if (name === '—') return;
        cmpVendMap.set(name, (cmpVendMap.get(name) || 0) + toEUR(e.amount, e.currency, e.date));
      });
      const cmpAmt = cmpVendMap.get(topVend[0]) || 0;
      const cmpPct = Math.round((cmpAmt / cmpData.total) * 100);
      if (cmpAmt > 0) {
        const diff = pct - cmpPct;
        trendText = ` Share is ${diff > 0 ? 'growing' : diff < 0 ? 'shrinking' : 'stable'} (was ${cmpPct}%).`;
      }
    }
    signals.push({
      title:    'Vendor Concentration',
      text:     `"${topVend[0]}" accounts for ${formatEUR(topVend[1])} (${pct}% of total expenses) — high dependency on a single vendor.${trendText}`,
      severity: 'Watch',
      inspect:  'Vendor Breakdown',
      onClick:  () => drillDownModal(`Expenses — ${topVend[0]}`, toExpDrillRows(allExp.filter(e => vendorLabel(e) === topVend[0])), DRILL_COLS)
    });
  }

  // Fix 2: Recurring expense detection
  if (curRange) {
    const vendorMonthMap = new Map(); // vendorKey → Map(monthKey → amounts[])
    allExp.forEach(e => {
      const key = vendorLabel(e) !== '—' ? vendorLabel(e) : (e.description || '—');
      if (key === '—') return;
      const mk = e.date?.slice(0, 7);
      if (!mk) return;
      if (!vendorMonthMap.has(key)) vendorMonthMap.set(key, new Map());
      const mMap = vendorMonthMap.get(key);
      const eur = toEUR(e.amount, e.currency, e.date);
      if (!mMap.has(mk)) mMap.set(mk, []);
      mMap.get(mk).push(eur);
    });

    const recurringPatterns = [];
    vendorMonthMap.forEach((mMap, key) => {
      if (mMap.size < 3) return; // need 3+ months
      // Compute per-month totals
      const monthTotals = [...mMap.values()].map(amts => amts.reduce((s, v) => s + v, 0));
      const avg = monthTotals.reduce((s, v) => s + v, 0) / monthTotals.length;
      if (avg === 0) return;
      // Check within 20% variance of average
      const allWithin = monthTotals.every(v => Math.abs(v - avg) / avg <= 0.2);
      if (allWithin) recurringPatterns.push({ key, avg, months: mMap.size });
    });

    if (recurringPatterns.length > 0) {
      recurringPatterns.sort((a, b) => b.avg - a.avg);
      const examples = recurringPatterns.slice(0, 3).map(p => `${p.key} monthly avg ${formatEUR(p.avg)}`).join(', ');
      const recurringRows = [];
      recurringPatterns.forEach(p => {
        const mMap = vendorMonthMap.get(p.key);
        [...mMap.entries()].sort((a, b) => a[0].localeCompare(b[0])).forEach(([mk, amts]) => {
          recurringRows.push({ vendor: p.key, month: mk, eur: amts.reduce((s, v) => s + v, 0) });
        });
      });
      signals.push({
        title:    'Recurring Expenses',
        text:     `${recurringPatterns.length} recurring expense pattern${recurringPatterns.length !== 1 ? 's' : ''} detected — ${examples}`,
        severity: 'Note',
        inspect:  'Recurring Vendors',
        onClick:  () => drillDownModal('Recurring Expenses', recurringRows, [
          { key: 'vendor', label: 'Vendor' },
          { key: 'month',  label: 'Month', format: v => monthLabel(v) },
          { key: 'eur',    label: 'EUR',   right: true, format: v => formatEUR(v) }
        ])
      });
    }
  }

  return signals;
}

// ── Main view ─────────────────────────────────────────────────────────────────
function buildView() {
  const wrap = el('div', { class: 'view active' });

  // Header
  wrap.appendChild(el('div', { style: 'margin-bottom:16px' },
    el('h2', { style: 'margin:0 0 4px;font-size:20px;font-weight:700' }, 'Expense Analytics'),
    el('p',  { style: 'margin:0;font-size:13px;color:var(--text-muted)' },
      'Understand cost structure — categories, vendors, streams and properties')
  ));

  // Shared filter bar (period, owner, stream, property, comparison)
  wrap.appendChild(buildFilterBar(gF, { showOwner: true, showStream: true, showProperty: true, showClient: false, storagePrefix: 'aexp', channelScope: gScope === 'all' ? null : 'company' }, newGF => {
    if (newGF) gF = newGF;
    rebuildView();
  }));

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

  // Expense-specific filters
  const vendors  = listActiveVendors();
  const catMS    = buildMultiSelect(Object.entries(COST_CATEGORIES).map(([k, v]) => ({ value: k, label: v.label, color: v.color })), gExpFilters.categories, 'All Categories', rebuildView, 'aexp_cats');
  const vendorMS = buildMultiSelect(vendors.map(v => ({ value: v.id, label: v.name })), gExpFilters.vendorIds, 'All Vendors', rebuildView, 'aexp_vendors');
  const typeMS   = buildMultiSelect(Object.entries(ACCOUNTING_TYPES).map(([k, v]) => ({ value: k, label: v.label, color: k === 'capex' ? '#f59e0b' : '#ef4444' })), gExpFilters.accountingTypes, 'OpEx + CapEx', rebuildView, 'aexp_types');

  const expFilterBar = el('div', { class: 'flex gap-8 mb-16', style: 'flex-wrap:wrap;align-items:center' });
  expFilterBar.appendChild(el('span', { style: 'font-size:12px;color:var(--text-muted);align-self:center' }, 'Expense filters:'));
  expFilterBar.appendChild(catMS);
  expFilterBar.appendChild(vendorMS);
  expFilterBar.appendChild(typeMS);
  wrap.appendChild(expFilterBar);

  // Compute ranges
  const curRange = getCurrentPeriodRange(gF);
  const cmpRange = getComparisonRange(gF, curRange);

  wrap.appendChild(buildComparisonLine(curRange, cmpRange));

  // Data
  const cur = getData(curRange.start, curRange.end);
  const cmp = cmpRange ? getData(cmpRange.start, cmpRange.end) : null;
  const revenueData    = getRevenue(curRange.start, curRange.end);
  const cmpRevenueData = cmpRange ? getRevenue(cmpRange.start, cmpRange.end) : null;
  const revenue    = revenueData.total;
  const cmpRevenue = cmpRevenueData ? cmpRevenueData.total : 0;
  const { allExp, opEx, capEx, opTotal, capTotal, total } = cur;
  const capExCats = getCapExCatKeys(allExp);
  const cmpLabel = cmpRange?.label;

  // ── Empty state ───────────────────────────────────────────────────────────
  if (opTotal === 0 && capTotal === 0 && allExp.length === 0) {
    wrap.appendChild(mkEmptyState('No expense records match the selected filters.'));
    return wrap;
  }

  // ── CapEx/OpEx split banner ────────────────────────────────────────────────
  if (total > 0) {
    const opPct  = Math.round((opTotal  / total) * 100);
    const capPct = 100 - opPct;
    const banner = el('div', {
      style: 'display:flex;align-items:center;gap:12px;margin-bottom:16px;padding:10px 16px;background:var(--bg-elev-1);border:1px solid var(--border);border-radius:var(--radius-sm);font-size:12px'
    });
    const bar = el('div', { style: 'flex:1;height:6px;border-radius:3px;background:var(--bg-elev-2);overflow:hidden;min-width:120px' });
    bar.appendChild(el('div', { style: `width:${opPct}%;height:100%;background:#ef4444;border-radius:3px 0 0 3px;display:inline-block` }));
    bar.appendChild(el('div', { style: `width:${capPct}%;height:100%;background:#f59e0b;border-radius:0 3px 3px 0;display:inline-block` }));
    banner.appendChild(el('span', { style: 'color:var(--text-muted);white-space:nowrap' }, 'Cost split:'));
    banner.appendChild(el('span', { style: 'display:flex;align-items:center;gap:4px' },
      el('span', { style: 'width:8px;height:8px;border-radius:50%;background:#ef4444;display:inline-block' }),
      el('span', {}, `OpEx ${opPct}%`)
    ));
    banner.appendChild(bar);
    banner.appendChild(el('span', { style: 'display:flex;align-items:center;gap:4px' },
      el('span', { style: 'width:8px;height:8px;border-radius:50%;background:#f59e0b;display:inline-block' }),
      el('span', {}, `CapEx ${capPct}%`)
    ));
    wrap.appendChild(banner);
  }

  // ── KPI row 1: Total Expenses | Operating Expenses | CapEx | Expense Ratio ──
  const kpiRow1 = el('div', { class: 'grid grid-4 mb-16' });

  // ── Shared KPI drill helpers (close over cur data) ─────────────────────────
  // ── Forecast budget helper: sum fc.months[mk].expenses for all active forecasts
  //    within the current date range (Fix 1)
  function getForecastOpExBudget() {
    const { keys: mks } = getMonthKeysForRange(curRange.start, curRange.end);
    const mkSet = new Set(mks.map(m => m.key));
    let total = 0;
    listActive('forecasts').forEach(fc => {
      Object.entries(fc.months || {}).forEach(([mk, md]) => {
        if (!mkSet.has(mk)) return;
        total += Number(md.expenses) || 0;
      });
    });
    return total > 0 ? total : null;
  }

  const totalExpDrill = () => {
    const body = el('div');
    if (cmp) {
      body.appendChild(mkCmpGrid([
        { label: 'Total Expenses',      curVal: formatEUR(total),    cmpVal: formatEUR(cmp.total)    },
        { label: 'Operating Expenses',  curVal: formatEUR(opTotal),  cmpVal: formatEUR(cmp.opTotal)  },
        { label: 'Capital Expenditure', curVal: formatEUR(capTotal), cmpVal: formatEUR(cmp.capTotal) },
      ], 'Current Period', cmpLabel));
    } else {
      const sgrid = el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:20px' });
      sgrid.appendChild(mkSummaryBox('Operating Expenses', formatEUR(opTotal),
        total > 0 ? `${(opTotal / total * 100).toFixed(0)}% of total · ${opEx.length} record${opEx.length !== 1 ? 's' : ''}` : null));
      sgrid.appendChild(mkSummaryBox('Capital Expenditure', formatEUR(capTotal),
        total > 0 ? `${(capTotal / total * 100).toFixed(0)}% of total · ${capEx.length} record${capEx.length !== 1 ? 's' : ''}` : null));
      body.appendChild(sgrid);
    }
    const catMap = new Map();
    allExp.forEach(e => { const c = resolveExpenseFields(e).costCategory || 'other'; catMap.set(c, (catMap.get(c) || 0) + toEUR(e.amount, e.currency, e.date)); });
    const cats = [...catMap.entries()].sort((a, b) => b[1] - a[1]);
    if (cats.length) {
      const fcBudget = getForecastOpExBudget();
      body.appendChild(mkSectionLabel('By Category'));
      body.appendChild(mkModalTable(
        [
          { label: 'Category' },
          { label: 'Type', muted: true },
          { label: 'Actual', right: true },
          { label: '% of Total', right: true, muted: true },
          { label: 'Budget', right: true, muted: true },
          { label: 'Variance', right: true, muted: true }
        ],
        cats.map(([k, v]) => {
          const budgetShare = fcBudget !== null ? (catMap.get(k) || 0) / (total || 1) * fcBudget : null;
          const variance = budgetShare !== null ? v - budgetShare : null;
          return [
            COST_CATEGORIES[k]?.label || k,
            capExCats.has(k) ? 'CapEx' : 'OpEx',
            formatEUR(v),
            total > 0 ? (v / total * 100).toFixed(1) + '%' : '—',
            budgetShare !== null ? formatEUR(budgetShare) : '—',
            variance !== null ? (variance >= 0 ? '+' : '') + formatEUR(variance) : '—'
          ];
        })
      ));
    }
    openModal({ title: `Total Expenses — ${formatEUR(total)}`, body, large: true });
  };

  const opExDrill = () => {
    const body = el('div');
    const catMap = new Map();
    opEx.forEach(e => { const c = resolveExpenseFields(e).costCategory || 'other'; catMap.set(c, (catMap.get(c) || 0) + toEUR(e.amount, e.currency, e.date)); });
    const cats = [...catMap.entries()].sort((a, b) => b[1] - a[1]);
    if (cats.length) {
      const fcBudget = getForecastOpExBudget();
      body.appendChild(mkSectionLabel('By Category'));
      body.appendChild(mkModalTable(
        [
          { label: 'Category' },
          { label: 'Actual', right: true },
          { label: '% of OpEx', right: true, muted: true },
          { label: 'Budget', right: true, muted: true },
          { label: 'Variance', right: true, muted: true }
        ],
        cats.map(([k, v]) => {
          const budgetShare = fcBudget !== null ? (catMap.get(k) || 0) / (opTotal || 1) * fcBudget : null;
          const variance = budgetShare !== null ? v - budgetShare : null;
          return [
            COST_CATEGORIES[k]?.label || k,
            formatEUR(v),
            opTotal > 0 ? (v / opTotal * 100).toFixed(1) + '%' : '—',
            budgetShare !== null ? formatEUR(budgetShare) : '—',
            variance !== null ? (variance >= 0 ? '+' : '') + formatEUR(variance) : '—'
          ];
        })
      ));
    }
    const propMap = new Map();
    opEx.forEach(e => { if (!e.propertyId) return; const n = byId('properties', e.propertyId)?.name || 'Unknown'; const x = propMap.get(e.propertyId) || { n, v: 0 }; x.v += toEUR(e.amount, e.currency, e.date); propMap.set(e.propertyId, x); });
    const props = [...propMap.values()].sort((a, b) => b.v - a.v);
    if (props.length) {
      body.appendChild(el('div', { style: 'margin-top:20px' }));
      body.appendChild(mkSectionLabel('By Property'));
      body.appendChild(mkModalTable(
        [{ label: 'Property' }, { label: 'Amount', right: true }, { label: '% of OpEx', right: true, muted: true }],
        props.map(p => [p.n, formatEUR(p.v), opTotal > 0 ? (p.v / opTotal * 100).toFixed(1) + '%' : '—'])
      ));
    }
    openModal({ title: `Operating Expenses — ${formatEUR(opTotal)}`, body, large: true });
  };

  const capExDrill = () => {
    const body = el('div');
    const propMap = new Map();
    capEx.forEach(e => { if (!e.propertyId) return; const n = byId('properties', e.propertyId)?.name || 'Unknown'; const x = propMap.get(e.propertyId) || { n, v: 0, cnt: 0 }; x.v += toEUR(e.amount, e.currency, e.date); x.cnt++; propMap.set(e.propertyId, x); });
    const props = [...propMap.values()].sort((a, b) => b.v - a.v);
    if (props.length) {
      const top = props.slice(0, 3);
      const pgrid = el('div', { style: `display:grid;grid-template-columns:repeat(${top.length},1fr);gap:12px;margin-bottom:20px` });
      top.forEach(p => pgrid.appendChild(mkSummaryBox(p.n, formatEUR(p.v), `${p.cnt} record${p.cnt !== 1 ? 's' : ''} · ${capTotal > 0 ? (p.v / capTotal * 100).toFixed(0) : 0}% of CapEx`)));
      body.appendChild(pgrid);
      body.appendChild(mkSectionLabel('All Properties'));
      body.appendChild(mkModalTable(
        [{ label: 'Property' }, { label: 'Records', right: true, muted: true }, { label: 'Amount', right: true }, { label: '% of CapEx', right: true, muted: true }],
        props.map(p => [p.n, String(p.cnt), formatEUR(p.v), capTotal > 0 ? (p.v / capTotal * 100).toFixed(1) + '%' : '—'])
      ));
    }
    const catMap = new Map();
    capEx.forEach(e => { const c = resolveExpenseFields(e).costCategory || 'other'; catMap.set(c, (catMap.get(c) || 0) + toEUR(e.amount, e.currency, e.date)); });
    const cats = [...catMap.entries()].sort((a, b) => b[1] - a[1]);
    if (cats.length) {
      body.appendChild(el('div', { style: 'margin-top:20px' }));
      body.appendChild(mkSectionLabel('By Category'));
      body.appendChild(mkModalTable(
        [{ label: 'Category' }, { label: 'Amount', right: true }, { label: '% of CapEx', right: true, muted: true }],
        cats.map(([k, v]) => [COST_CATEGORIES[k]?.label || k, formatEUR(v), capTotal > 0 ? (v / capTotal * 100).toFixed(1) + '%' : '—'])
      ));
    }
    openModal({ title: `CapEx — ${formatEUR(capTotal)}`, body, large: true });
  };

  const expRatioDrill = () => {
    const body = el('div');
    body.appendChild(mkSummaryGrid([
      { label: 'Revenue',              value: formatEUR(revenue) },
      { label: 'Operating Expenses',   value: formatEUR(opTotal) },
      { label: 'Expense Ratio',        value: expRatio !== null ? `${expRatio.toFixed(1)}%` : '—', sub: 'OpEx / Revenue' }
    ], 3));
    if (revenue > 0) {
      body.appendChild(mkSectionLabel('Revenue Composition'));
      body.appendChild(mkModalTable(
        [{ label: 'Source' }, { label: 'Amount', right: true }, { label: '% of Revenue', right: true, muted: true }],
        [
          ['Rentals',  formatEUR(revenueData.rentals),  (revenueData.rentals  / revenue * 100).toFixed(1) + '%'],
          ['Services', formatEUR(revenueData.services), (revenueData.services / revenue * 100).toFixed(1) + '%']
        ]
      ));
    }
    const catMap = new Map();
    opEx.forEach(e => { const c = resolveExpenseFields(e).costCategory || 'other'; catMap.set(c, (catMap.get(c) || 0) + toEUR(e.amount, e.currency, e.date)); });
    const cats = [...catMap.entries()].sort((a, b) => b[1] - a[1]);
    if (cats.length) {
      body.appendChild(el('div', { style: 'margin-top:20px' }));
      body.appendChild(mkSectionLabel('OpEx by Category'));
      body.appendChild(mkModalTable(
        [{ label: 'Category' }, { label: 'Amount', right: true }, { label: '% of OpEx', right: true, muted: true }],
        cats.map(([k, v]) => [COST_CATEGORIES[k]?.label || k, formatEUR(v), opTotal > 0 ? (v / opTotal * 100).toFixed(1) + '%' : '—'])
      ));
    }
    openModal({ title: `Expense Ratio — ${expRatio !== null ? expRatio.toFixed(1) + '%' : '—'}`, body, large: true });
  };

  // 1. Total Expenses
  kpiRow1.appendChild(mkKpiCard({
    label:       'Total Expenses',
    value:       formatEUR(total),
    delta:       safePct(total, cmp?.total),
    invertDelta: true,
    compLabel:   cmpLabel,
    compValue:   cmp ? formatEUR(cmp.total) : undefined,
    onClick:     totalExpDrill,
    lines: [
      { label: 'OpEx',  value: formatEUR(opTotal),  color: '#ef4444' },
      { label: 'CapEx', value: formatEUR(capTotal),  color: '#f59e0b' }
    ]
  }));

  // 2. Operating Expenses
  kpiRow1.appendChild(mkKpiCard({
    label:       'Operating Expenses',
    value:       formatEUR(opTotal),
    delta:       safePct(opTotal, cmp?.opTotal),
    invertDelta: true,
    compLabel:   cmpLabel,
    compValue:   cmp ? formatEUR(cmp.opTotal) : undefined,
    onClick:     opExDrill
  }));

  // 3. CapEx
  kpiRow1.appendChild(mkKpiCard({
    label:       'CapEx',
    value:       formatEUR(capTotal),
    delta:       safePct(capTotal, cmp?.capTotal),
    invertDelta: true,
    compLabel:   cmpLabel,
    compValue:   cmp ? formatEUR(cmp.capTotal) : undefined,
    variant:     capTotal > 0 ? 'warning' : '',
    onClick:     capExDrill
  }));

  // 4. Expense Ratio (OpEx / Revenue)
  const expRatio    = revenue > 0 ? (opTotal / revenue) * 100 : null;
  const cmpExpRatio = cmpRevenue > 0 ? ((cmp?.opTotal ?? 0) / cmpRevenue) * 100 : null;
  const ratioDelta  = expRatio !== null && cmpExpRatio !== null ? expRatio - cmpExpRatio : null;
  kpiRow1.appendChild(mkKpiCard({
    label:       'Expense Ratio',
    value:       expRatio !== null ? `${expRatio.toFixed(1)}%` : '—',
    subtitle:    'OpEx / Revenue',
    delta:       ratioDelta,
    deltaIsPp:   true,
    invertDelta: true,
    compLabel:   cmpLabel,
    variant:     expRatio !== null && expRatio > 80 ? 'danger' : '',
    onClick:     expRatioDrill
  }));

  wrap.appendChild(kpiRow1);

  // ── KPI row 2: CapEx Share | Top Vendor | Top Cost Category | Properties w/ Costs ──
  const kpiRow2 = el('div', { class: 'grid grid-4 mb-16' });

  // 5. CapEx Share
  const capSharePct    = total > 0 ? (capTotal / total) * 100 : null;
  const cmpCapSharePct = cmp && cmp.total > 0 ? (cmp.capTotal / cmp.total) * 100 : null;
  const capShareDelta  = capSharePct !== null && cmpCapSharePct !== null ? capSharePct - cmpCapSharePct : null;
  kpiRow2.appendChild(mkKpiCard({
    label:     'CapEx Share',
    value:     capSharePct !== null ? `${capSharePct.toFixed(1)}%` : '—',
    subtitle:  'of total expenses',
    delta:     capShareDelta,
    deltaIsPp: true,
    compLabel: cmpLabel,
    onClick:   capExDrill
  }));

  // 6. Top Vendor
  const vendMap2   = new Map();
  allExp.forEach(e => {
    const name = vendorLabel(e);
    if (name === '—') return;
    vendMap2.set(name, (vendMap2.get(name) || 0) + toEUR(e.amount, e.currency, e.date));
  });
  const topVendEntry = [...vendMap2.entries()].sort((a, b) => b[1] - a[1])[0];
  kpiRow2.appendChild(mkKpiCard({
    label:   'Top Vendor',
    value:   topVendEntry ? topVendEntry[0] : '—',
    subtitle: topVendEntry ? formatEUR(topVendEntry[1]) : 'No vendors recorded',
    onClick: () => {
      const rows = [...vendMap2.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([vendor, eur]) => ({ vendor, eur }));
      drillDownModal('Vendors Summary', rows, [
        { key: 'vendor', label: 'Vendor' },
        { key: 'eur',    label: 'EUR', right: true, format: v => formatEUR(v) }
      ]);
    }
  }));

  // 7. Top Cost Category
  const catMap2 = new Map();
  allExp.forEach(e => {
    const cat = resolveExpenseFields(e).costCategory || 'other';
    catMap2.set(cat, (catMap2.get(cat) || 0) + toEUR(e.amount, e.currency, e.date));
  });
  const topCatEntry = [...catMap2.entries()].sort((a, b) => b[1] - a[1])[0];
  kpiRow2.appendChild(mkKpiCard({
    label:   'Top Cost Category',
    value:   topCatEntry ? (COST_CATEGORIES[topCatEntry[0]]?.label || topCatEntry[0]) : '—',
    subtitle: topCatEntry ? formatEUR(topCatEntry[1]) : 'No categories',
    onClick: () => {
      const rows = [...catMap2.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([cat, eur]) => ({ category: COST_CATEGORIES[cat]?.label || cat, eur }));
      drillDownModal('Categories Summary', rows, [
        { key: 'category', label: 'Category' },
        { key: 'eur',      label: 'EUR', right: true, format: v => formatEUR(v) }
      ]);
    }
  }));

  // 8. Properties with Costs
  const propWithCosts    = new Set(allExp.map(e => e.propertyId).filter(Boolean));
  const cmpPropWithCosts = cmp ? new Set(cmp.allExp.map(e => e.propertyId).filter(Boolean)) : null;
  kpiRow2.appendChild(mkKpiCard({
    label:     'Properties with Costs',
    value:     String(propWithCosts.size),
    delta:     cmpPropWithCosts !== null ? safePct(propWithCosts.size, cmpPropWithCosts.size) : null,
    compLabel: cmpLabel,
    onClick:   () => {
      const rows = [...propWithCosts].map(pid => {
        const p   = byId('properties', pid);
        const amt = allExp.filter(e => e.propertyId === pid)
          .reduce((s, e) => s + toEUR(e.amount, e.currency, e.date), 0);
        return { property: p?.name || pid, eur: amt };
      }).sort((a, b) => b.eur - a.eur);
      drillDownModal('Costs by Property', rows, [
        { key: 'property', label: 'Property' },
        { key: 'eur',      label: 'EUR', right: true, format: v => formatEUR(v) }
      ]);
    }
  }));

  wrap.appendChild(kpiRow2);

  // Inline insights
  const expBanner = mkInsightsBanner(computeExpenseInsights({ allExp, opTotal, capTotal, total, revenue, curRange, cmpData: cmp }), 'Expense Insights');
  if (expBanner) wrap.appendChild(expBanner);

  // ── Chart row 1: Stacked bar (2/3) + Stream donut (1/3) ───────────────────
  const row1 = el('div', { style: 'display:grid;grid-template-columns:2fr 1fr;gap:16px;margin-bottom:16px' });
  row1.appendChild(el('div', { class: 'card' },
    el('div', { class: 'card-header' },
      el('div', { class: 'card-title' }, 'Monthly Expenses by Category'),
      el('div', { style: 'font-size:11px;color:var(--text-muted)' }, '● Amber = CapEx')
    ),
    el('div', { class: 'chart-wrap tall' }, el('canvas', { id: 'exp-cat-bar' }))
  ));
  row1.appendChild(el('div', { class: 'card' },
    el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'Expenses by Stream')),
    el('div', { class: 'chart-wrap tall' }, el('canvas', { id: 'exp-stream-donut' }))
  ));
  wrap.appendChild(row1);

  // ── Chart row 2: Category hbar (1/2) + Vendor hbar (1/2) ──────────────────
  const row2 = el('div', { class: 'grid grid-2 mb-16' });
  row2.appendChild(el('div', { class: 'card' },
    el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'Total by Category')),
    el('div', { class: 'chart-wrap tall' }, el('canvas', { id: 'exp-cat-hbar' }))
  ));
  row2.appendChild(el('div', { class: 'card' },
    el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'Total by Vendor')),
    el('div', { class: 'chart-wrap tall' }, el('canvas', { id: 'exp-vendor-bar' }))
  ));
  wrap.appendChild(row2);

  // ── Chart row 3: OpEx vs CapEx donut (1/3) + Cost by Property hbar (2/3) ──
  const row3 = el('div', { style: 'display:grid;grid-template-columns:1fr 2fr;gap:16px;margin-bottom:16px' });
  row3.appendChild(el('div', { class: 'card' },
    el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'OpEx vs CapEx')),
    el('div', { class: 'chart-wrap tall' }, el('canvas', { id: 'exp-type-donut' }))
  ));
  row3.appendChild(el('div', { class: 'card' },
    el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'Cost by Property')),
    el('div', { class: 'chart-wrap tall' }, el('canvas', { id: 'exp-prop-hbar' }))
  ));
  wrap.appendChild(row3);

  // ── Expense table (collapsible) ───────────────────────────────────────────
  const tableCard   = el('div', { class: 'card' });
  const tableBody   = el('div', { style: 'display:none' });
  const tableToggle = el('button', { style: 'background:none;border:none;color:var(--accent);font-size:13px;cursor:pointer;padding:0' }, 'Show Records');
  tableToggle.onclick = () => {
    const hidden = tableBody.style.display === 'none';
    tableBody.style.display = hidden ? '' : 'none';
    tableToggle.textContent = hidden ? 'Hide Records' : 'Show Records';
  };
  tableCard.appendChild(el('div', { class: 'card-header', style: 'display:flex;align-items:center;justify-content:space-between' },
    el('div', { class: 'card-title' }, 'Expense Records'),
    el('div', { style: 'display:flex;align-items:center;gap:16px' },
      el('div', { style: 'display:flex;gap:12px;font-size:11px;color:var(--text-muted);align-items:center' },
        el('span', { style: 'display:flex;align-items:center;gap:4px' },
          el('span', { style: 'width:10px;height:10px;border-left:3px solid #ef4444;display:inline-block' }),
          'OpEx'
        ),
        el('span', { style: 'display:flex;align-items:center;gap:4px' },
          el('span', { style: 'width:10px;height:10px;border-left:3px solid #f59e0b;display:inline-block' }),
          'CapEx'
        )
      ),
      tableToggle
    )
  ));
  buildExpenseTable(tableBody, cur);
  tableCard.appendChild(tableBody);
  wrap.appendChild(tableCard);

  // ── CapEx Detail section (collapsible) ────────────────────────────────────
  if (capEx.length > 0) buildCapExDetailSection(wrap, cur);

  setTimeout(() => {
    renderCatBar(cur, curRange);
    renderStreamDonut(cur);
    renderCatHBar(cur);
    renderVendorBar(cur);
    renderTypeDonut(cur);
    renderPropHBar(cur);
  }, 0);

  return wrap;
}

// ── Chart 1: Stacked bar — Month × Category ───────────────────────────────────
function renderCatBar({ allExp }, curRange) {
  const { keys: months } = getMonthKeysForRange(curRange.start, curRange.end);
  if (!months.length) return;

  const capExCats   = getCapExCatKeys(allExp);
  const catMonthMap = new Map();
  allExp.forEach(e => {
    const cat = resolveExpenseFields(e).costCategory;
    const mk  = e.date?.slice(0, 7);
    if (!mk) return;
    if (!catMonthMap.has(cat)) catMonthMap.set(cat, new Map());
    const m = catMonthMap.get(cat);
    m.set(mk, (m.get(mk) || 0) + toEUR(e.amount, e.currency, e.date));
  });

  if (!catMonthMap.size) return;

  // OpEx categories first, CapEx (renovation) last — amber visual separation
  const opKeys  = Object.keys(COST_CATEGORIES).filter(k => !capExCats.has(k) && catMonthMap.has(k));
  const capKeys = Object.keys(COST_CATEGORIES).filter(k =>  capExCats.has(k) && catMonthMap.has(k));
  const orderedKeys = [...opKeys, ...capKeys];

  charts.bar('exp-cat-bar', {
    labels: months.map(m => m.label),
    datasets: orderedKeys.map(k => ({
      label:           COST_CATEGORIES[k].label,
      data:            months.map(m => Math.round(catMonthMap.get(k)?.get(m.key) || 0)),
      backgroundColor: COST_CATEGORIES[k].color
    })),
    stacked: true,
    onClickItem: (label, idx, dsIdx) => {
      const mk = months[idx]?.key;
      if (!mk) return;
      const clickedCat = orderedKeys[dsIdx];
      const monthExp   = allExp.filter(e => e.date?.slice(0, 7) === mk);
      const monthTotal = monthExp.reduce((s, e) => s + toEUR(e.amount, e.currency, e.date), 0);
      const catMap = new Map();
      monthExp.forEach(e => { const c = resolveExpenseFields(e).costCategory || 'other'; catMap.set(c, (catMap.get(c) || 0) + toEUR(e.amount, e.currency, e.date)); });
      const cats = [...catMap.entries()].sort((a, b) => b[1] - a[1]);
      const body = el('div');
      body.appendChild(mkSectionLabel(`Expense Breakdown — ${label}`));
      body.appendChild(mkModalTable(
        [{ label: 'Category' }, { label: 'Type', muted: true }, { label: 'Amount', right: true }, { label: '% of Month', right: true, muted: true }],
        cats.map(([k, v]) => {
          const row = [COST_CATEGORIES[k]?.label || k, capExCats.has(k) ? 'CapEx' : 'OpEx', formatEUR(v), monthTotal > 0 ? (v / monthTotal * 100).toFixed(1) + '%' : '—'];
          if (k === clickedCat) row[0] = `▶ ${row[0]}`;
          return row;
        })
      ));
      openModal({ title: `${label} — ${formatEUR(monthTotal)}`, body, large: true });
    }
  });
}

// ── Chart 2: Donut — Expenses by Stream ──────────────────────────────────────
function renderStreamDonut({ allExp }) {
  const streamMap = new Map();
  allExp.forEach(e => {
    const s = expStream(e);
    streamMap.set(s, (streamMap.get(s) || 0) + toEUR(e.amount, e.currency, e.date));
  });

  const entries    = [...streamMap.entries()].filter(([, v]) => v > 0);
  const streamKeys = entries.map(([k]) => k);
  if (!entries.length) return;

  charts.doughnut('exp-stream-donut', {
    labels: entries.map(([k]) => STREAMS[k]?.label || k),
    data:   entries.map(([, v]) => Math.round(v)),
    colors: streamKeys.map(k => STREAMS[k]?.color || '#8b93b0'),
    onClickItem: (_label, idx) => {
      const sk       = streamKeys[idx];
      const streamExp   = allExp.filter(e => expStream(e) === sk);
      const streamTotal = streamExp.reduce((s, e) => s + toEUR(e.amount, e.currency, e.date), 0);
      const body = el('div');
      const catMap = new Map();
      streamExp.forEach(e => { const c = resolveExpenseFields(e).costCategory || 'other'; catMap.set(c, (catMap.get(c) || 0) + toEUR(e.amount, e.currency, e.date)); });
      const cats = [...catMap.entries()].sort((a, b) => b[1] - a[1]);
      if (cats.length) {
        body.appendChild(mkSectionLabel('By Category'));
        body.appendChild(mkModalTable(
          [{ label: 'Category' }, { label: 'Amount', right: true }, { label: '% of Stream', right: true, muted: true }],
          cats.map(([k, v]) => [COST_CATEGORIES[k]?.label || k, formatEUR(v), streamTotal > 0 ? (v / streamTotal * 100).toFixed(1) + '%' : '—'])
        ));
      }
      const propMap = new Map();
      streamExp.forEach(e => { if (!e.propertyId) return; const n = byId('properties', e.propertyId)?.name || 'Unknown'; const x = propMap.get(e.propertyId) || { n, v: 0 }; x.v += toEUR(e.amount, e.currency, e.date); propMap.set(e.propertyId, x); });
      const props = [...propMap.values()].sort((a, b) => b.v - a.v);
      if (props.length) {
        body.appendChild(el('div', { style: 'margin-top:20px' }));
        body.appendChild(mkSectionLabel('By Property'));
        body.appendChild(mkModalTable(
          [{ label: 'Property' }, { label: 'Amount', right: true }, { label: '% of Stream', right: true, muted: true }],
          props.map(p => [p.n, formatEUR(p.v), streamTotal > 0 ? (p.v / streamTotal * 100).toFixed(1) + '%' : '—'])
        ));
      }
      openModal({ title: `${STREAMS[sk]?.label || sk} Expenses — ${formatEUR(streamTotal)}`, body, large: true });
    }
  });
}

// ── Chart 3: Horizontal bar — Category totals ─────────────────────────────────
function renderCatHBar({ allExp }) {
  const capExCats = getCapExCatKeys(allExp);
  const catMap = new Map();
  allExp.forEach(e => {
    const cat = resolveExpenseFields(e).costCategory;
    catMap.set(cat, (catMap.get(cat) || 0) + toEUR(e.amount, e.currency, e.date));
  });

  // OpEx first, CapEx last; sort descending within each group
  const opEntries  = [...catMap.entries()].filter(([k]) => !capExCats.has(k)).sort((a, b) => b[1] - a[1]);
  const capEntries = [...catMap.entries()].filter(([k]) =>  capExCats.has(k)).sort((a, b) => b[1] - a[1]);
  const sorted     = [...opEntries, ...capEntries];
  if (!sorted.length) return;

  const catKeys = sorted.map(([k]) => k);

  charts.bar('exp-cat-hbar', {
    labels: sorted.map(([k]) => COST_CATEGORIES[k]?.label || k),
    datasets: [{
      label:           'Amount (EUR)',
      data:            sorted.map(([, v]) => Math.round(v)),
      backgroundColor: catKeys.map(k => COST_CATEGORIES[k]?.color || '#8b93b0')
    }],
    horizontal: true,
    onClickItem: (_label, idx) => {
      const cat    = catKeys[idx];
      const catExp = allExp.filter(e => resolveExpenseFields(e).costCategory === cat);
      const catTotal = catExp.reduce((s, e) => s + toEUR(e.amount, e.currency, e.date), 0);
      const catOpEx  = catExp.filter(e => !isCapEx(e)).reduce((s, e) => s + toEUR(e.amount, e.currency, e.date), 0);
      const catCapEx = catTotal - catOpEx;
      const body = el('div');
      if (catOpEx > 0 || catCapEx > 0) {
        const sgrid = el('div', { style: `display:grid;grid-template-columns:${catOpEx > 0 && catCapEx > 0 ? '1fr 1fr' : '1fr'};gap:12px;margin-bottom:20px` });
        if (catOpEx  > 0) sgrid.appendChild(mkSummaryBox('OpEx',  formatEUR(catOpEx),  `${(catOpEx  / catTotal * 100).toFixed(0)}% of category`));
        if (catCapEx > 0) sgrid.appendChild(mkSummaryBox('CapEx', formatEUR(catCapEx), `${(catCapEx / catTotal * 100).toFixed(0)}% of category`));
        body.appendChild(sgrid);
      }
      const vendMap = new Map();
      catExp.forEach(e => { const n = vendorLabel(e); if (n === '—') return; vendMap.set(n, (vendMap.get(n) || 0) + toEUR(e.amount, e.currency, e.date)); });
      const vends = [...vendMap.entries()].sort((a, b) => b[1] - a[1]);
      if (vends.length) {
        body.appendChild(mkSectionLabel('By Vendor'));
        body.appendChild(mkModalTable(
          [{ label: 'Vendor' }, { label: 'Amount', right: true }, { label: '% of Category', right: true, muted: true }],
          vends.map(([n, v]) => [n, formatEUR(v), catTotal > 0 ? (v / catTotal * 100).toFixed(1) + '%' : '—'])
        ));
      }
      const propMap = new Map();
      catExp.forEach(e => { if (!e.propertyId) return; const n = byId('properties', e.propertyId)?.name || 'Unknown'; const x = propMap.get(e.propertyId) || { n, v: 0 }; x.v += toEUR(e.amount, e.currency, e.date); propMap.set(e.propertyId, x); });
      const props = [...propMap.values()].sort((a, b) => b.v - a.v);
      if (props.length) {
        body.appendChild(el('div', { style: 'margin-top:20px' }));
        body.appendChild(mkSectionLabel('By Property'));
        body.appendChild(mkModalTable(
          [{ label: 'Property' }, { label: 'Amount', right: true }, { label: '% of Category', right: true, muted: true }],
          props.map(p => [p.n, formatEUR(p.v), catTotal > 0 ? (p.v / catTotal * 100).toFixed(1) + '%' : '—'])
        ));
      }
      openModal({ title: `${COST_CATEGORIES[cat]?.label || cat} — ${formatEUR(catTotal)}`, body, large: true });
    }
  });
}

// ── Chart 4: Horizontal bar — Vendor totals ───────────────────────────────────
function renderVendorBar({ allExp }) {
  const map = new Map();
  allExp.forEach(e => {
    const name = vendorLabel(e) === '—' ? 'No Vendor' : vendorLabel(e);
    const vid  = e.vendorId || name;
    const cur  = map.get(vid) || { eur: 0, name };
    map.set(vid, { eur: cur.eur + toEUR(e.amount, e.currency, e.date), name: cur.name });
  });

  const sorted  = [...map.entries()].sort((a, b) => b[1].eur - a[1].eur).slice(0, 15);
  const vendIds = sorted.map(([k]) => k);
  if (!sorted.length) return;

  charts.bar('exp-vendor-bar', {
    labels: sorted.map(([, m]) => m.name),
    datasets: [{
      label:           'Amount (EUR)',
      data:            sorted.map(([, m]) => Math.round(m.eur)),
      backgroundColor: sorted.map((_, i) => `hsla(${(14 + i * 22) % 360}, 60%, 52%, 0.85)`)
    }],
    horizontal: true,
    onClickItem: (_label, idx) => {
      const vid     = vendIds[idx];
      const name    = sorted[idx][1].name;
      const vendExp = allExp.filter(e => { const en = vendorLabel(e) === '—' ? 'No Vendor' : vendorLabel(e); return (e.vendorId || en) === vid; });
      const vendTotal = vendExp.reduce((s, e) => s + toEUR(e.amount, e.currency, e.date), 0);
      const body = el('div');
      const catMap = new Map();
      vendExp.forEach(e => { const c = resolveExpenseFields(e).costCategory || 'other'; catMap.set(c, (catMap.get(c) || 0) + toEUR(e.amount, e.currency, e.date)); });
      const cats = [...catMap.entries()].sort((a, b) => b[1] - a[1]);
      if (cats.length) {
        body.appendChild(mkSectionLabel('By Category'));
        body.appendChild(mkModalTable(
          [{ label: 'Category' }, { label: 'Amount', right: true }, { label: '% of Vendor Total', right: true, muted: true }],
          cats.map(([k, v]) => [COST_CATEGORIES[k]?.label || k, formatEUR(v), vendTotal > 0 ? (v / vendTotal * 100).toFixed(1) + '%' : '—'])
        ));
      }
      const propMap = new Map();
      vendExp.forEach(e => { if (!e.propertyId) return; const n = byId('properties', e.propertyId)?.name || 'Unknown'; const x = propMap.get(e.propertyId) || { n, v: 0 }; x.v += toEUR(e.amount, e.currency, e.date); propMap.set(e.propertyId, x); });
      const props = [...propMap.values()].sort((a, b) => b.v - a.v);
      if (props.length) {
        body.appendChild(el('div', { style: 'margin-top:20px' }));
        body.appendChild(mkSectionLabel('By Property'));
        body.appendChild(mkModalTable(
          [{ label: 'Property' }, { label: 'Amount', right: true }, { label: '% of Vendor Total', right: true, muted: true }],
          props.map(p => [p.n, formatEUR(p.v), vendTotal > 0 ? (p.v / vendTotal * 100).toFixed(1) + '%' : '—'])
        ));
      }
      openModal({ title: `${name} — ${formatEUR(vendTotal)}`, body, large: true });
    }
  });
}

// ── Chart 5: Donut — OpEx vs CapEx ───────────────────────────────────────────
function renderTypeDonut({ opTotal, capTotal, opEx, capEx }) {
  if (opTotal + capTotal === 0) return;
  charts.doughnut('exp-type-donut', {
    labels: ['OpEx', 'CapEx'],
    data:   [Math.round(opTotal), Math.round(capTotal)],
    colors: ['#ef4444', '#f59e0b'],
    onClickItem: (_label, idx) => {
      const expenses = idx === 0 ? opEx : capEx;
      const expTotal = idx === 0 ? opTotal : capTotal;
      const typeName = idx === 0 ? 'Operating Expenses' : 'Capital Expenditure';
      const typeShort = idx === 0 ? 'OpEx' : 'CapEx';
      const body = el('div');
      const catMap = new Map();
      expenses.forEach(e => { const c = resolveExpenseFields(e).costCategory || 'other'; catMap.set(c, (catMap.get(c) || 0) + toEUR(e.amount, e.currency, e.date)); });
      const cats = [...catMap.entries()].sort((a, b) => b[1] - a[1]);
      if (cats.length) {
        body.appendChild(mkSectionLabel('By Category'));
        body.appendChild(mkModalTable(
          [{ label: 'Category' }, { label: 'Amount', right: true }, { label: `% of ${typeShort}`, right: true, muted: true }],
          cats.map(([k, v]) => [COST_CATEGORIES[k]?.label || k, formatEUR(v), expTotal > 0 ? (v / expTotal * 100).toFixed(1) + '%' : '—'])
        ));
      }
      const propMap = new Map();
      expenses.forEach(e => { if (!e.propertyId) return; const n = byId('properties', e.propertyId)?.name || 'Unknown'; const x = propMap.get(e.propertyId) || { n, v: 0 }; x.v += toEUR(e.amount, e.currency, e.date); propMap.set(e.propertyId, x); });
      const props = [...propMap.values()].sort((a, b) => b.v - a.v);
      if (props.length) {
        body.appendChild(el('div', { style: 'margin-top:20px' }));
        body.appendChild(mkSectionLabel('By Property'));
        body.appendChild(mkModalTable(
          [{ label: 'Property' }, { label: 'Amount', right: true }, { label: `% of ${typeShort}`, right: true, muted: true }],
          props.map(p => [p.n, formatEUR(p.v), expTotal > 0 ? (p.v / expTotal * 100).toFixed(1) + '%' : '—'])
        ));
      }
      openModal({ title: `${typeName} — ${formatEUR(expTotal)}`, body, large: true });
    }
  });
}

// ── Chart 6: Horizontal bar — Cost by Property ────────────────────────────────
function renderPropHBar({ allExp }) {
  const propMap = new Map();
  allExp.forEach(e => {
    if (!e.propertyId) return;
    const p   = byId('properties', e.propertyId);
    const key = e.propertyId;
    const cur = propMap.get(key) || { eur: 0, name: p?.name || key };
    propMap.set(key, { eur: cur.eur + toEUR(e.amount, e.currency, e.date), name: cur.name });
  });

  const sorted  = [...propMap.entries()].sort((a, b) => b[1].eur - a[1].eur);
  const propIds = sorted.map(([k]) => k);
  if (!sorted.length) return;

  charts.bar('exp-prop-hbar', {
    labels: sorted.map(([, m]) => m.name),
    datasets: [{
      label:           'Amount (EUR)',
      data:            sorted.map(([, m]) => Math.round(m.eur)),
      backgroundColor: sorted.map((_, i) => `hsla(${(200 + i * 31) % 360}, 55%, 50%, 0.85)`)
    }],
    horizontal: true,
    onClickItem: (_label, idx) => {
      const pid     = propIds[idx];
      const name    = sorted[idx][1].name;
      const propExp = allExp.filter(e => e.propertyId === pid);
      const propTotal  = propExp.reduce((s, e) => s + toEUR(e.amount, e.currency, e.date), 0);
      const propOpEx   = propExp.filter(e => !isCapEx(e)).reduce((s, e) => s + toEUR(e.amount, e.currency, e.date), 0);
      const propCapEx  = propTotal - propOpEx;
      const body = el('div');
      if (propOpEx > 0 || propCapEx > 0) {
        const sgrid = el('div', { style: `display:grid;grid-template-columns:${propOpEx > 0 && propCapEx > 0 ? '1fr 1fr' : '1fr'};gap:12px;margin-bottom:20px` });
        if (propOpEx  > 0) sgrid.appendChild(mkSummaryBox('OpEx',  formatEUR(propOpEx),  `${(propOpEx  / propTotal * 100).toFixed(0)}% of property costs`));
        if (propCapEx > 0) sgrid.appendChild(mkSummaryBox('CapEx', formatEUR(propCapEx), `${(propCapEx / propTotal * 100).toFixed(0)}% of property costs`));
        body.appendChild(sgrid);
      }
      const catMap = new Map();
      propExp.forEach(e => { const c = resolveExpenseFields(e).costCategory || 'other'; catMap.set(c, (catMap.get(c) || 0) + toEUR(e.amount, e.currency, e.date)); });
      const cats = [...catMap.entries()].sort((a, b) => b[1] - a[1]);
      if (cats.length) {
        body.appendChild(mkSectionLabel('By Category'));
        body.appendChild(mkModalTable(
          [{ label: 'Category' }, { label: 'Type', muted: true }, { label: 'Amount', right: true }, { label: '% of Property', right: true, muted: true }],
          cats.map(([k, v]) => [COST_CATEGORIES[k]?.label || k, getCapExCatKeys(allExp).has(k) ? 'CapEx' : 'OpEx', formatEUR(v), propTotal > 0 ? (v / propTotal * 100).toFixed(1) + '%' : '—'])
        ));
      }
      const vendMap = new Map();
      propExp.forEach(e => { const n = vendorLabel(e); if (n === '—') return; vendMap.set(n, (vendMap.get(n) || 0) + toEUR(e.amount, e.currency, e.date)); });
      const vends = [...vendMap.entries()].sort((a, b) => b[1] - a[1]);
      if (vends.length) {
        body.appendChild(el('div', { style: 'margin-top:20px' }));
        body.appendChild(mkSectionLabel('By Vendor'));
        body.appendChild(mkModalTable(
          [{ label: 'Vendor' }, { label: 'Amount', right: true }, { label: '% of Property', right: true, muted: true }],
          vends.map(([n, v]) => [n, formatEUR(v), propTotal > 0 ? (v / propTotal * 100).toFixed(1) + '%' : '—'])
        ));
      }
      openModal({ title: `${name} — ${formatEUR(propTotal)}`, body, large: true });
    }
  });
}

// ── CapEx Detail section (collapsible) ───────────────────────────────────────
function buildCapExDetailSection(container, { capEx, total }) {
  const card     = el('div', { class: 'card', style: 'margin-top:16px' });
  const capTotal = capEx.reduce((s, e) => s + toEUR(e.amount, e.currency, e.date), 0);
  const body     = el('div', { style: 'display:none' });
  const toggle   = el('button', { style: 'background:none;border:none;color:var(--accent);font-size:13px;cursor:pointer;padding:0' }, 'Show Records');
  toggle.onclick = () => {
    const hidden = body.style.display === 'none';
    body.style.display = hidden ? '' : 'none';
    toggle.textContent = hidden ? 'Hide Records' : 'Show Records';
  };
  card.appendChild(el('div', { class: 'card-header', style: 'display:flex;align-items:center;justify-content:space-between' },
    el('div', { class: 'card-title' }, 'CapEx Detail'),
    el('div', { style: 'display:flex;align-items:center;gap:16px' },
      el('div', { style: 'font-size:11px;color:var(--text-muted)' },
        `${capEx.length} record(s) · ${total > 0 ? ((capTotal / total) * 100).toFixed(1) : '0'}% of total spend`
      ),
      toggle
    )
  ));

  const rows = capEx.map(e => {
    const resolved = resolveExpenseFields(e);
    const eur      = toEUR(e.amount, e.currency, e.date);
    return {
      _eur:        eur,
      date:        fmtDate(e.date),
      property:    byId('properties', e.propertyId)?.name || '—',
      category:    COST_CATEGORIES[resolved.costCategory]?.label || e.category || '—',
      vendor:      vendorLabel(e),
      description: e.description || '—',
      eur:         formatEUR(eur),
      pctTotal:    total > 0 ? `${((eur / total) * 100).toFixed(1)}%` : '—'
    };
  }).sort((a, b) => b._eur - a._eur);

  const CAPEX_COLS = [
    { key: 'date',        label: 'Date'        },
    { key: 'property',    label: 'Property'    },
    { key: 'category',    label: 'Category'    },
    { key: 'vendor',      label: 'Vendor'      },
    { key: 'description', label: 'Description' },
    { key: 'eur',         label: 'EUR',         right: true },
    { key: 'pctTotal',    label: '% of Total',  right: true }
  ];

  const table = el('table', { class: 'table' });
  const htr   = el('tr');
  CAPEX_COLS.forEach(col => htr.appendChild(el('th', { class: col.right ? 'right' : '' }, col.label)));
  table.appendChild(el('thead', {}, htr));

  const tbody = el('tbody');
  rows.forEach(r => {
    const tr = el('tr', { style: 'border-left:3px solid #f59e0b' });
    CAPEX_COLS.forEach(col => {
      tr.appendChild(el('td', { class: col.right ? 'right num' : '' }, r[col.key] ?? '—'));
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);

  const tableWrap = el('div', { class: 'table-wrap' });
  tableWrap.appendChild(table);
  body.appendChild(tableWrap);
  card.appendChild(body);
  container.appendChild(card);
  attachSortFilter(tableWrap, { initialCol: _capexSortCol, initialDir: _capexSortDir, onSortChange: (c, d) => { _capexSortCol = c; _capexSortDir = d; } });
}

// ── Expense table ─────────────────────────────────────────────────────────────
function buildExpenseTable(container, { allExp }) {
  const rows = allExp.map(e => {
    const resolved = resolveExpenseFields(e);
    const prop     = byId('properties', e.propertyId);
    const capex    = isCapEx(e);
    return {
      _date:       e.date,
      _eur:        toEUR(e.amount, e.currency, e.date),
      _capex:      capex,
      date:        fmtDate(e.date),
      type:        capex ? 'CapEx' : 'OpEx',
      category:    COST_CATEGORIES[resolved.costCategory]?.label || resolved.costCategory || e.category || '—',
      vendor:      vendorLabel(e),
      description: e.description || '—',
      stream:      STREAMS[expStream(e)]?.short || expStream(e) || '—',
      property:    prop?.name || '—',
      amountEUR:   formatEUR(toEUR(e.amount, e.currency, e.date))
    };
  }).sort((a, b) => (b._date || '').localeCompare(a._date || ''));

  const TABLE_COLS = [
    { key: 'type',        label: 'Type'        },
    { key: 'date',        label: 'Date'        },
    { key: 'category',    label: 'Category'    },
    { key: 'vendor',      label: 'Vendor'      },
    { key: 'description', label: 'Description' },
    { key: 'stream',      label: 'Stream'      },
    { key: 'property',    label: 'Property'    },
    { key: 'amountEUR',   label: 'Amount EUR',  right: true }
  ];

  const table = el('table', { class: 'table' });
  const htr   = el('tr');
  TABLE_COLS.forEach(col => htr.appendChild(el('th', { class: col.right ? 'right' : '' }, col.label)));
  table.appendChild(el('thead', {}, htr));

  const tbody = el('tbody');
  for (const r of rows) {
    const borderColor = r._capex ? '#f59e0b' : '#ef4444';
    const tr = el('tr', { style: `border-left:3px solid ${borderColor}` });
    TABLE_COLS.forEach(col => {
      const td = el('td', { class: col.right ? 'right num' : '' });
      if (col.key === 'type') {
        td.appendChild(el('span', {
          style: `font-size:10px;font-weight:600;padding:2px 6px;border-radius:3px;letter-spacing:0.04em;` +
                 (r._capex
                   ? 'background:rgba(245,158,11,0.15);color:#f59e0b'
                   : 'background:rgba(239,68,68,0.12);color:#ef4444')
        }, r.type));
      } else {
        td.appendChild(document.createTextNode(r[col.key] ?? '—'));
      }
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);

  const tableWrap = el('div', { class: 'table-wrap' });
  tableWrap.appendChild(table);
  container.appendChild(tableWrap);
  attachSortFilter(tableWrap, { initialCol: _expTableSortCol, initialDir: _expTableSortDir, onSortChange: (c, d) => { _expTableSortCol = c; _expTableSortDir = d; } });

  const totalEUR = rows.reduce((s, r) => s + (r._eur || 0), 0);
  container.appendChild(el('div', {
    style: 'display:flex;justify-content:space-between;margin-top:8px;font-size:13px'
  },
    el('span', { style: 'color:var(--text-muted)' }, `${rows.length} record(s)`),
    el('strong', { class: 'num' }, `Total: ${formatEUR(totalEUR)}`)
  ));
}
