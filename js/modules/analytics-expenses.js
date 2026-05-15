// Expense Analytics Dashboard — understand cost structure
import { el, buildMultiSelect, button, fmtDate, drillDownModal, attachSortFilter } from '../core/ui.js';
import * as charts from '../core/charts.js';
import { STREAMS, COST_CATEGORIES, ACCOUNTING_TYPES } from '../core/config.js';
import {
  formatEUR, toEUR, byId,
  listActive, listActiveVendors, listActivePayments,
  isCapEx, resolveExpenseFields
} from '../core/data.js';
import {
  createFilterState, getCurrentPeriodRange, getComparisonRange,
  getMonthKeysForRange, makeMatchers, buildFilterBar, buildComparisonLine
} from './analytics-filters.js';

// ── Filter state ──────────────────────────────────────────────────────────────
let gF = createFilterState();

// Expense-specific local filters (not handled by shared filter bar)
let gExpFilters = {
  categories:      new Set(),
  vendorIds:       new Set(),
  accountingTypes: new Set()
};

const CHART_IDS  = ['exp-cat-bar', 'exp-stream-donut', 'exp-vendor-bar', 'exp-cat-hbar', 'exp-type-donut', 'exp-prop-hbar'];
// renovation is the only costCategory key that maps to CapEx in chart ordering
const CAPEX_CATS = new Set(['renovation']);

// ── Module export ─────────────────────────────────────────────────────────────
export default {
  id:    'analytics-expenses',
  label: 'Expenses',
  icon:  '−',
  render(container) { container.appendChild(buildView()); },
  refresh() { rebuildView(); },
  destroy() { CHART_IDS.forEach(id => charts.destroy(id)); }
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function expStream(e) {
  if (e.stream) return e.stream;
  if (e.propertyId) {
    const p = byId('properties', e.propertyId);
    if (p?.type === 'short_term') return 'short_term_rental';
    if (p?.type === 'long_term')  return 'long_term_rental';
  }
  return 'other';
}

function vendorLabel(e) {
  if (e.vendorId) return byId('vendors', e.vendorId)?.name || e.vendor || '—';
  return e.vendor || '—';
}

function safePct(cur, cmp) {
  if (cmp == null || !isFinite(cmp) || cmp === 0) return null;
  return (cur - cmp) / Math.abs(cmp) * 100;
}

// ── Data fetching ─────────────────────────────────────────────────────────────
function getData(start, end) {
  const { mStream, mOwner, mProperty } = makeMatchers(gF);
  const vendors = listActiveVendors();
  const vMap    = new Map(vendors.map(v => [v.name, v.id]));

  const allExp = listActive('expenses').filter(e => {
    const d = e.date || '';
    if (d < start || d > end) return false;
    if (!mStream(e) || !mOwner(e) || !mProperty(e)) return false;
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
  const { mStream, mOwner, mProperty } = makeMatchers(gF);
  return listActivePayments()
    .filter(p => p.status === 'paid' && (p.date || '') >= start && (p.date || '') <= end && mStream(p) && mOwner(p) && mProperty(p))
    .reduce((s, p) => s + toEUR(p.amount, p.currency, p.date), 0);
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

// ── KPI card ──────────────────────────────────────────────────────────────────
function kpiCard({ label, value, subtitle, delta, deltaIsPp, invertDelta, compLabel, variant, onClick }) {
  const card = el('div', {
    class: 'kpi' + (variant ? ' ' + variant : ''),
    style: 'cursor:pointer;transition:box-shadow 120ms',
    title: 'Click for breakdown'
  });
  card.addEventListener('mouseenter', () => { card.style.boxShadow = '0 0 0 2px var(--accent)'; });
  card.addEventListener('mouseleave', () => { card.style.boxShadow = ''; });
  card.onclick = onClick;
  card.appendChild(el('div', { class: 'kpi-label' }, label));
  card.appendChild(el('div', { class: 'kpi-value' }, value));
  if (subtitle) card.appendChild(el('div', { class: 'kpi-sub' }, subtitle));
  if (delta !== null && delta !== undefined && isFinite(delta)) {
    const trend = el('div', { class: 'kpi-trend' });
    const sign  = delta > 0 ? '+' : '';
    const disp  = deltaIsPp ? `${sign}${delta.toFixed(1)} pp` : `${sign}${delta.toFixed(1)}%`;
    const cls   = delta === 0 ? '' : delta > 0 ? (invertDelta ? 'down' : 'up') : (invertDelta ? 'up' : 'down');
    trend.appendChild(el('span', { class: cls }, disp));
    if (compLabel) trend.appendChild(document.createTextNode(` vs ${compLabel}`));
    card.appendChild(trend);
  }
  card.appendChild(el('div', { class: 'kpi-accent-bar' }));
  return card;
}

function compositeKpiCard({ label, value, subtitle, delta, deltaIsPp, invertDelta, compLabel, variant, onClick, lines }) {
  const card = kpiCard({ label, value, subtitle, delta, deltaIsPp, invertDelta, compLabel, variant, onClick });
  if (lines?.length) {
    const bd = el('div', { style: 'margin-top:6px;display:flex;flex-direction:column;gap:2px' });
    for (const { label: ll, value: lv, color } of lines) {
      bd.appendChild(el('div', { style: 'display:flex;justify-content:space-between;font-size:11px;color:var(--text-muted)' },
        el('span', { style: color ? `color:${color}` : '' }, ll),
        el('span', { class: 'num' }, lv)
      ));
    }
    card.appendChild(bd);
  }
  return card;
}

// ── Inline insights ───────────────────────────────────────────────────────────
function buildInsightsBanner(insights) {
  if (!insights.length) return null;
  const wrap = el('div', { style: 'display:flex;flex-direction:column;gap:8px;margin-bottom:16px' });
  const STYLES = {
    danger:  { bg: 'rgba(239,68,68,0.08)',  border: '#ef4444', icon: '⚠' },
    warning: { bg: 'rgba(245,158,11,0.08)', border: '#f59e0b', icon: '⚡' },
    info:    { bg: 'rgba(99,102,241,0.08)', border: '#6366f1', icon: 'ℹ' }
  };
  for (const { level, text } of insights) {
    const s = STYLES[level] || STYLES.info;
    wrap.appendChild(el('div', {
      style: `display:flex;align-items:flex-start;gap:10px;padding:10px 14px;background:${s.bg};border-left:3px solid ${s.border};border-radius:0 var(--radius-sm) var(--radius-sm) 0;font-size:13px`
    },
      el('span', { style: `color:${s.border};flex-shrink:0` }, s.icon),
      el('span', { style: 'color:var(--text);line-height:1.4' }, text)
    ));
  }
  return wrap;
}

function computeExpenseInsights({ allExp, opTotal, capTotal, total, revenue }) {
  const items = [];
  if (total === 0) {
    items.push({ level: 'info', text: 'No expenses recorded for the selected period.' });
    return items;
  }
  // Cost pressure: OpEx / Revenue (not total / revenue)
  const opRatio = revenue > 0 ? (opTotal / revenue) * 100 : null;
  if (opRatio !== null && opRatio > 100) {
    items.push({ level: 'danger', text: `Operating cost ratio is ${opRatio.toFixed(0)}% — OpEx exceeds revenue. Portfolio is unprofitable for this period.` });
  } else if (opRatio !== null && opRatio > 80) {
    items.push({ level: 'warning', text: `Operating cost ratio is ${opRatio.toFixed(0)}% — OpEx consumes over 80% of revenue. Margins are thin.` });
  }
  const capPct = total > 0 ? (capTotal / total) * 100 : 0;
  if (capPct > 50) {
    items.push({ level: 'warning', text: `CapEx is ${capPct.toFixed(0)}% of total expenses — major capital expenditure activity. Verify this is planned.` });
  } else if (capPct > 30) {
    items.push({ level: 'info', text: `CapEx is ${capPct.toFixed(0)}% of total expenses — elevated capital investment activity.` });
  }
  // Category concentration
  const catMap = new Map();
  allExp.forEach(e => {
    const cat = resolveExpenseFields(e).costCategory || 'other';
    catMap.set(cat, (catMap.get(cat) || 0) + toEUR(e.amount, e.currency, e.date));
  });
  const topCat = [...catMap.entries()].sort((a, b) => b[1] - a[1])[0];
  if (topCat && topCat[1] / total > 0.55) {
    const pct   = Math.round(topCat[1] / total * 100);
    const lbl   = COST_CATEGORIES[topCat[0]]?.label || topCat[0];
    items.push({ level: 'info', text: `"${lbl}" is the dominant cost category at ${pct}% of total spend.` });
  }
  // Vendor concentration
  const vendMap = new Map();
  allExp.forEach(e => {
    const name = vendorLabel(e);
    if (name === '—') return;
    vendMap.set(name, (vendMap.get(name) || 0) + toEUR(e.amount, e.currency, e.date));
  });
  const topVend = [...vendMap.entries()].sort((a, b) => b[1] - a[1])[0];
  if (topVend && topVend[1] / total > 0.5) {
    const pct = Math.round(topVend[1] / total * 100);
    items.push({ level: 'warning', text: `"${topVend[0]}" accounts for ${pct}% of total expenses — high vendor concentration. Consider diversifying suppliers.` });
  }
  return items;
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
  wrap.appendChild(buildFilterBar(gF, { showOwner: true, showStream: true, showProperty: true, showClient: false, storagePrefix: 'aexp' }, newGF => {
    if (newGF) gF = newGF;
    rebuildView();
  }));

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
  const revenue    = getRevenue(curRange.start, curRange.end);
  const cmpRevenue = cmpRange ? getRevenue(cmpRange.start, cmpRange.end) : 0;
  const { allExp, opEx, capEx, opTotal, capTotal, total } = cur;
  const cmpLabel = cmpRange?.label;

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

  // 1. Total Expenses
  kpiRow1.appendChild(compositeKpiCard({
    label:       'Total Expenses',
    value:       formatEUR(total),
    delta:       safePct(total, cmp?.total),
    invertDelta: true,
    compLabel:   cmpLabel,
    onClick:     () => drillDownModal('All Expenses', toExpDrillRows(allExp), DRILL_COLS),
    lines: [
      { label: 'OpEx',  value: formatEUR(opTotal),  color: '#ef4444' },
      { label: 'CapEx', value: formatEUR(capTotal),  color: '#f59e0b' }
    ]
  }));

  // 2. Operating Expenses
  kpiRow1.appendChild(kpiCard({
    label:       'Operating Expenses',
    value:       formatEUR(opTotal),
    delta:       safePct(opTotal, cmp?.opTotal),
    invertDelta: true,
    compLabel:   cmpLabel,
    onClick:     () => drillDownModal('Operating Expenses', toExpDrillRows(opEx), DRILL_COLS)
  }));

  // 3. CapEx
  kpiRow1.appendChild(kpiCard({
    label:       'CapEx',
    value:       formatEUR(capTotal),
    delta:       safePct(capTotal, cmp?.capTotal),
    invertDelta: true,
    compLabel:   cmpLabel,
    variant:     capTotal > 0 ? 'warning' : '',
    onClick:     () => drillDownModal('CapEx', toExpDrillRows(capEx), DRILL_COLS)
  }));

  // 4. Expense Ratio (OpEx / Revenue)
  const expRatio    = revenue > 0 ? (opTotal / revenue) * 100 : null;
  const cmpExpRatio = cmpRevenue > 0 ? ((cmp?.opTotal ?? 0) / cmpRevenue) * 100 : null;
  const ratioDelta  = expRatio !== null && cmpExpRatio !== null ? expRatio - cmpExpRatio : null;
  kpiRow1.appendChild(kpiCard({
    label:       'Expense Ratio',
    value:       expRatio !== null ? `${expRatio.toFixed(1)}%` : '—',
    subtitle:    'OpEx / Revenue',
    delta:       ratioDelta,
    deltaIsPp:   true,
    invertDelta: true,
    compLabel:   cmpLabel,
    variant:     expRatio !== null && expRatio > 80 ? 'danger' : '',
    onClick:     () => drillDownModal('Expense Ratio Breakdown', [
      { metric: 'Revenue',                        value: formatEUR(revenue) },
      { metric: 'Operating Expenses',             value: formatEUR(opTotal) },
      { metric: 'Expense Ratio (OpEx / Revenue)', value: expRatio !== null ? `${expRatio.toFixed(1)}%` : '—' }
    ], [
      { key: 'metric', label: 'Metric' },
      { key: 'value',  label: 'Value', right: true }
    ])
  }));

  wrap.appendChild(kpiRow1);

  // ── KPI row 2: CapEx Share | Top Vendor | Top Cost Category | Properties w/ Costs ──
  const kpiRow2 = el('div', { class: 'grid grid-4 mb-16' });

  // 5. CapEx Share
  const capSharePct    = total > 0 ? (capTotal / total) * 100 : null;
  const cmpCapSharePct = cmp && cmp.total > 0 ? (cmp.capTotal / cmp.total) * 100 : null;
  const capShareDelta  = capSharePct !== null && cmpCapSharePct !== null ? capSharePct - cmpCapSharePct : null;
  kpiRow2.appendChild(kpiCard({
    label:     'CapEx Share',
    value:     capSharePct !== null ? `${capSharePct.toFixed(1)}%` : '—',
    subtitle:  'of total expenses',
    delta:     capShareDelta,
    deltaIsPp: true,
    compLabel: cmpLabel,
    onClick:   () => drillDownModal('CapEx Records', toExpDrillRows(capEx), DRILL_COLS)
  }));

  // 6. Top Vendor
  const vendMap2   = new Map();
  allExp.forEach(e => {
    const name = vendorLabel(e);
    if (name === '—') return;
    vendMap2.set(name, (vendMap2.get(name) || 0) + toEUR(e.amount, e.currency, e.date));
  });
  const topVendEntry = [...vendMap2.entries()].sort((a, b) => b[1] - a[1])[0];
  kpiRow2.appendChild(kpiCard({
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
  kpiRow2.appendChild(kpiCard({
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
  kpiRow2.appendChild(kpiCard({
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
  const expBanner = buildInsightsBanner(computeExpenseInsights({ allExp, opTotal, capTotal, total, revenue }));
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

  // ── Expense table ──────────────────────────────────────────────────────────
  const tableCard = el('div', { class: 'card' });
  tableCard.appendChild(el('div', { class: 'card-header' },
    el('div', { class: 'card-title' }, 'Expense Records'),
    el('div', { style: 'display:flex;gap:12px;font-size:11px;color:var(--text-muted);align-items:center' },
      el('span', { style: 'display:flex;align-items:center;gap:4px' },
        el('span', { style: 'width:10px;height:10px;border-left:3px solid #ef4444;display:inline-block' }),
        'OpEx'
      ),
      el('span', { style: 'display:flex;align-items:center;gap:4px' },
        el('span', { style: 'width:10px;height:10px;border-left:3px solid #f59e0b;display:inline-block' }),
        'CapEx'
      )
    )
  ));
  buildExpenseTable(tableCard, cur);
  wrap.appendChild(tableCard);

  // ── CapEx Detail section ───────────────────────────────────────────────────
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
  const opKeys  = Object.keys(COST_CATEGORIES).filter(k => !CAPEX_CATS.has(k) && catMonthMap.has(k));
  const capKeys = Object.keys(COST_CATEGORIES).filter(k =>  CAPEX_CATS.has(k) && catMonthMap.has(k));
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
      const cat  = orderedKeys[dsIdx];
      const rows = allExp.filter(e =>
        e.date?.slice(0, 7) === mk && resolveExpenseFields(e).costCategory === cat
      );
      drillDownModal(
        `${label} — ${COST_CATEGORIES[cat]?.label || cat}`,
        toExpDrillRows(rows),
        DRILL_COLS
      );
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
      const sk   = streamKeys[idx];
      const rows = allExp.filter(e => expStream(e) === sk);
      drillDownModal(`Expenses — ${STREAMS[sk]?.label || sk}`, toExpDrillRows(rows), DRILL_COLS);
    }
  });
}

// ── Chart 3: Horizontal bar — Category totals ─────────────────────────────────
function renderCatHBar({ allExp }) {
  const catMap = new Map();
  allExp.forEach(e => {
    const cat = resolveExpenseFields(e).costCategory;
    catMap.set(cat, (catMap.get(cat) || 0) + toEUR(e.amount, e.currency, e.date));
  });

  // OpEx first, CapEx last; sort descending within each group
  const opEntries  = [...catMap.entries()].filter(([k]) => !CAPEX_CATS.has(k)).sort((a, b) => b[1] - a[1]);
  const capEntries = [...catMap.entries()].filter(([k]) =>  CAPEX_CATS.has(k)).sort((a, b) => b[1] - a[1]);
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
      const cat  = catKeys[idx];
      const rows = allExp.filter(e => resolveExpenseFields(e).costCategory === cat);
      drillDownModal(
        `Expenses — ${COST_CATEGORIES[cat]?.label || cat}`,
        toExpDrillRows(rows),
        DRILL_COLS
      );
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
      const vid  = vendIds[idx];
      const name = sorted[idx][1].name;
      const rows = allExp.filter(e => {
        const en = vendorLabel(e) === '—' ? 'No Vendor' : vendorLabel(e);
        return (e.vendorId || en) === vid;
      });
      drillDownModal(`Expenses — ${name}`, toExpDrillRows(rows), DRILL_COLS);
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
      const rows = idx === 0 ? opEx : capEx;
      const name = idx === 0 ? 'Operating Expenses' : 'CapEx';
      drillDownModal(name, toExpDrillRows(rows), DRILL_COLS);
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
      const pid  = propIds[idx];
      const name = sorted[idx][1].name;
      const rows = allExp.filter(e => e.propertyId === pid);
      drillDownModal(`Expenses — ${name}`, toExpDrillRows(rows), DRILL_COLS);
    }
  });
}

// ── CapEx Detail section ──────────────────────────────────────────────────────
function buildCapExDetailSection(container, { capEx, total }) {
  const card = el('div', { class: 'card', style: 'margin-top:16px' });
  const capTotal = capEx.reduce((s, e) => s + toEUR(e.amount, e.currency, e.date), 0);
  card.appendChild(el('div', { class: 'card-header' },
    el('div', { class: 'card-title' }, 'CapEx Detail'),
    el('div', { style: 'font-size:11px;color:var(--text-muted)' },
      `${capEx.length} record(s) · ${total > 0 ? ((capTotal / total) * 100).toFixed(1) : '0'}% of total spend`
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
  card.appendChild(tableWrap);
  container.appendChild(card);
  attachSortFilter(tableWrap);
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
  attachSortFilter(tableWrap);

  const totalEUR = rows.reduce((s, r) => s + (r._eur || 0), 0);
  container.appendChild(el('div', {
    style: 'display:flex;justify-content:space-between;margin-top:8px;font-size:13px'
  },
    el('span', { style: 'color:var(--text-muted)' }, `${rows.length} record(s)`),
    el('strong', { class: 'num' }, `Total: ${formatEUR(totalEUR)}`)
  ));
}
