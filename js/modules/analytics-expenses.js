// Expense Analytics Dashboard — understand cost structure
import { el, select, fmtDate, drillDownModal, attachSortFilter } from '../core/ui.js';
import * as charts from '../core/charts.js';
import { STREAMS, COST_CATEGORIES, ACCOUNTING_TYPES } from '../core/config.js';
import {
  availableYears, formatEUR, toEUR, byId,
  listActive, listActiveVendors, listActivePayments,
  isCapEx, resolveExpenseFields
} from '../core/data.js';

// ── Filter state ──────────────────────────────────────────────────────────────
let gFilters = {
  year:            String(new Date().getFullYear()),
  months:          new Set(),   // empty = all
  categories:      new Set(),   // costCategory keys
  propertyIds:     new Set(),
  vendorIds:       new Set(),
  streams:         new Set(),
  accountingTypes: new Set()    // 'opex' | 'capex'
};

const MONTH_LABELS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const CHART_IDS    = ['exp-cat-bar', 'exp-stream-donut', 'exp-vendor-bar', 'exp-cat-hbar', 'exp-type-donut', 'exp-prop-hbar'];

// renovation is the only CapEx cost-category key
const CAPEX_CATS   = new Set(['renovation']);

// ── Module export ─────────────────────────────────────────────────────────────
export default {
  id:    'analytics-expenses',
  label: 'Expenses',
  icon:  '−',
  render(container) { container.appendChild(buildView()); },
  refresh() { rebuildView(); },
  destroy() { CHART_IDS.forEach(id => charts.destroy(id)); }
};

// ── Filtering ─────────────────────────────────────────────────────────────────
function matchDate(row) {
  const d = row.date || '';
  if (gFilters.year && gFilters.year !== 'all' && !d.startsWith(gFilters.year)) return false;
  if (gFilters.months.size > 0 && !gFilters.months.has(d.slice(5, 7))) return false;
  return true;
}
function matchCategory(row) {
  if (gFilters.categories.size === 0) return true;
  return gFilters.categories.has(resolveExpenseFields(row).costCategory);
}
function matchProperty(row) {
  return gFilters.propertyIds.size === 0 || !row.propertyId || gFilters.propertyIds.has(row.propertyId);
}
function matchStream(row) {
  if (gFilters.streams.size === 0) return true;
  return gFilters.streams.has(expStream(row));
}
function matchVendor(row) {
  if (gFilters.vendorIds.size === 0) return true;
  const vid = row.vendorId || '';
  if (vid) return gFilters.vendorIds.has(vid);
  if (row.vendor) {
    const v = listActiveVendors().find(v => v.name === row.vendor);
    return v ? gFilters.vendorIds.has(v.id) : false;
  }
  return false;
}
function matchAccType(row) {
  if (gFilters.accountingTypes.size === 0) return true;
  return gFilters.accountingTypes.has(isCapEx(row) ? 'capex' : 'opex');
}

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

function getFilteredRevenue() {
  return listActivePayments()
    .filter(p => p.status === 'paid' && matchDate(p))
    .reduce((s, p) => s + toEUR(p.amount, p.currency, p.date), 0);
}

function getData() {
  const allExp = listActive('expenses').filter(e =>
    matchDate(e) && matchCategory(e) && matchProperty(e) && matchStream(e) && matchVendor(e) && matchAccType(e)
  );
  const opEx     = allExp.filter(e => !isCapEx(e));
  const capEx    = allExp.filter(e =>  isCapEx(e));
  const opTotal  = opEx.reduce( (s, e) => s + toEUR(e.amount, e.currency, e.date), 0);
  const capTotal = capEx.reduce((s, e) => s + toEUR(e.amount, e.currency, e.date), 0);
  const revenue  = getFilteredRevenue();
  return { allExp, opEx, capEx, opTotal, capTotal, total: opTotal + capTotal, revenue };
}

// ── Rebuild ───────────────────────────────────────────────────────────────────
function rebuildView() {
  CHART_IDS.forEach(id => charts.destroy(id));
  const c = document.getElementById('content');
  if (!c) return;
  c.innerHTML = '';
  c.appendChild(buildView());
}

// ── Drill-down rows (richer than drillExpRows — adds type + vendor) ───────────
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

// ── Multi-select dropdown ─────────────────────────────────────────────────────
function buildMultiSelect(items, filterSet, allLabel, onRefresh) {
  const wrapper   = el('div', { style: 'position:relative' });
  const trigLabel = el('span');
  const trigger   = el('div', {
    class: 'select',
    style: 'cursor:pointer;display:flex;align-items:center;gap:6px;width:auto;min-width:130px;user-select:none'
  }, trigLabel);
  const menu = el('div', {
    style: [
      'display:none;position:absolute;top:calc(100% + 4px);left:0;z-index:300',
      'background:var(--bg-elev-2);border:1px solid var(--border)',
      'border-radius:var(--radius-sm);min-width:190px',
      'box-shadow:0 4px 16px rgba(0,0,0,0.35);padding:4px 0;max-height:260px;overflow-y:auto'
    ].join(';')
  });

  const allChk = el('input', { type: 'checkbox' });
  menu.appendChild(el('label', {
    style: 'display:flex;align-items:center;gap:8px;padding:6px 12px;cursor:pointer;border-bottom:1px solid var(--border);font-size:13px'
  }, allChk, el('span', {}, allLabel)));

  const chks = items.map(({ value, label, color }) => {
    const chk = el('input', { type: 'checkbox' });
    chk.dataset.value = value;
    chk.checked = filterSet.size === 0 || filterSet.has(value);
    const dot     = color ? el('span', { style: `display:inline-block;width:8px;height:8px;border-radius:50%;background:${color};flex-shrink:0` }) : null;
    const txt     = el('span', {}, label);
    const content = el('span', { style: 'display:flex;align-items:center;gap:6px' }, ...(dot ? [dot] : []), txt);
    menu.appendChild(el('label', {
      style: 'display:flex;align-items:center;gap:8px;padding:6px 12px;cursor:pointer;font-size:13px'
    }, chk, content));
    return chk;
  });

  const sync = () => {
    const sel = chks.filter(c => c.checked);
    const n   = sel.length;
    allChk.checked       = n === chks.length;
    allChk.indeterminate = n > 0 && n < chks.length;
    trigLabel.textContent =
      n === chks.length || n === 0 ? allLabel
      : n === 1 ? (items.find(i => i.value === sel[0].dataset.value)?.label || '')
      : `${n} selected`;
    filterSet.clear();
    if (n > 0 && n < chks.length) sel.forEach(c => filterSet.add(c.dataset.value));
  };

  allChk.checked = filterSet.size === 0;
  allChk.onchange = () => {
    chks.forEach(c => { c.checked = allChk.checked; });
    allChk.indeterminate = false;
    sync(); onRefresh();
  };
  chks.forEach(chk => { chk.onchange = () => { sync(); onRefresh(); }; });
  trigger.onclick = e => {
    e.stopPropagation();
    menu.style.display = menu.style.display === 'none' ? '' : 'none';
  };
  menu.onclick = e => e.stopPropagation();
  document.addEventListener('click', () => { menu.style.display = 'none'; });
  wrapper.appendChild(trigger);
  wrapper.appendChild(menu);
  sync();
  return wrapper;
}

// ── KPI card ──────────────────────────────────────────────────────────────────
function kpiCard(label, value, variant, onClick) {
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
  card.appendChild(el('div', { class: 'kpi-accent-bar' }));
  return card;
}

// ── Month key helpers ─────────────────────────────────────────────────────────
function getMonthKeys() {
  const year = gFilters.year !== 'all' ? gFilters.year : String(new Date().getFullYear());
  return MONTH_LABELS.map((label, i) => {
    const mm = String(i + 1).padStart(2, '0');
    return { label, key: `${year}-${mm}`, mm };
  }).filter(m => gFilters.months.size === 0 || gFilters.months.has(m.mm));
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

  // Filter bar
  const years   = availableYears();
  const yearSel = select(
    [{ value: 'all', label: 'All Years' }, ...years.map(y => ({ value: y, label: y }))],
    gFilters.year
  );
  yearSel.onchange = () => { gFilters.year = yearSel.value; rebuildView(); };

  const filterBar = el('div', { class: 'flex gap-8 mb-16', style: 'flex-wrap:wrap;align-items:center' });
  filterBar.appendChild(el('span', { style: 'font-size:12px;color:var(--text-muted);align-self:center' }, 'Filters:'));
  filterBar.appendChild(yearSel);
  filterBar.appendChild(buildMultiSelect(
    MONTH_LABELS.map((m, i) => ({ value: String(i + 1).padStart(2, '0'), label: m })),
    gFilters.months, 'All Months', rebuildView
  ));
  filterBar.appendChild(buildMultiSelect(
    Object.entries(COST_CATEGORIES).map(([k, v]) => ({ value: k, label: v.label, color: v.color })),
    gFilters.categories, 'All Categories', rebuildView
  ));
  filterBar.appendChild(buildMultiSelect(
    listActive('properties').map(p => ({ value: p.id, label: p.name })),
    gFilters.propertyIds, 'All Properties', rebuildView
  ));
  filterBar.appendChild(buildMultiSelect(
    listActiveVendors().map(v => ({ value: v.id, label: v.name })),
    gFilters.vendorIds, 'All Vendors', rebuildView
  ));
  filterBar.appendChild(buildMultiSelect(
    Object.entries(STREAMS).map(([k, v]) => ({ value: k, label: v.label, color: v.color })),
    gFilters.streams, 'All Streams', rebuildView
  ));
  filterBar.appendChild(buildMultiSelect(
    Object.entries(ACCOUNTING_TYPES).map(([k, v]) => ({
      value: k, label: v.label,
      color: k === 'capex' ? '#f59e0b' : '#ef4444'
    })),
    gFilters.accountingTypes, 'OpEx + CapEx', rebuildView
  ));
  wrap.appendChild(filterBar);

  // Data
  const data = getData();
  const { allExp, opEx, capEx, opTotal, capTotal, total, revenue } = data;
  const vendorSet = new Set(allExp.map(e => e.vendorId || e.vendor || '').filter(Boolean));

  // ── CapEx/OpEx split banner ────────────────────────────────────────────────
  // Subtle inline summary bar showing the split ratio
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

  // ── KPI row ────────────────────────────────────────────────────────────────
  // Four cards: Total | OpEx | CapEx/Renovation | Vendors
  const kpiRow = el('div', { class: 'grid grid-4 mb-16' });
  kpiRow.appendChild(kpiCard(
    'Total Expenses', formatEUR(total), '',
    () => drillDownModal('All Expenses', toExpDrillRows(allExp), DRILL_COLS)
  ));
  kpiRow.appendChild(kpiCard(
    'Operating (OpEx)', formatEUR(opTotal), '',
    () => drillDownModal('Operating Expenses', toExpDrillRows(opEx), DRILL_COLS)
  ));
  kpiRow.appendChild(kpiCard(
    'Renovation (CapEx)', formatEUR(capTotal), capTotal > 0 ? 'warning' : '',
    () => drillDownModal('Renovation CapEx', toExpDrillRows(capEx), DRILL_COLS)
  ));
  kpiRow.appendChild(kpiCard(
    'Vendors Used', String(vendorSet.size), `across ${allExp.length} expense(s)`,
    () => {
      const vMap = new Map();
      allExp.forEach(e => {
        const name = vendorLabel(e) === '—' ? 'No Vendor' : vendorLabel(e);
        vMap.set(name, (vMap.get(name) || 0) + toEUR(e.amount, e.currency, e.date));
      });
      const rows = [...vMap.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([vendor, eur]) => ({ vendor, eur }));
      drillDownModal('Vendors Summary', rows, [
        { key: 'vendor', label: 'Vendor' },
        { key: 'eur',    label: 'EUR', right: true, format: v => formatEUR(v) }
      ]);
    }
  ));
  wrap.appendChild(kpiRow);

  // ── Secondary KPI row: ratio metrics ──────────────────────────────────────
  const propWithCosts = new Set(allExp.map(e => e.propertyId).filter(Boolean));
  const costRatioPct  = revenue > 0 ? (total / revenue) * 100 : null;
  const capSharePct   = total > 0   ? (capTotal / total) * 100 : null;
  const avgCostProp   = propWithCosts.size > 0 ? total / propWithCosts.size : null;

  const kpiRow2 = el('div', { class: 'grid grid-4 mb-16' });
  kpiRow2.appendChild(kpiCard(
    'Cost Ratio', costRatioPct !== null ? `${costRatioPct.toFixed(1)}%` : '—',
    costRatioPct !== null && costRatioPct > 80 ? 'danger' : '',
    () => drillDownModal('Cost Ratio Breakdown', [
      { metric: 'Total Revenue', value: formatEUR(revenue) },
      { metric: 'Total Expenses', value: formatEUR(total) },
      { metric: 'Cost Ratio', value: costRatioPct !== null ? `${costRatioPct.toFixed(1)}%` : '—' }
    ], [
      { key: 'metric', label: 'Metric' },
      { key: 'value',  label: 'Value', right: true }
    ])
  ));
  kpiRow2.appendChild(kpiCard(
    'CapEx Share', capSharePct !== null ? `${capSharePct.toFixed(1)}%` : '—',
    '',
    () => drillDownModal('CapEx Records', toExpDrillRows(capEx), DRILL_COLS)
  ));
  kpiRow2.appendChild(kpiCard(
    'Properties w/ Costs', String(propWithCosts.size), '',
    () => {
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
  ));
  kpiRow2.appendChild(kpiCard(
    'Avg Cost / Property', avgCostProp !== null ? formatEUR(avgCostProp) : '—', '',
    () => drillDownModal('All Expenses', toExpDrillRows(allExp), DRILL_COLS)
  ));
  wrap.appendChild(kpiRow2);

  // ── Chart row 1: Stacked bar (2/3) + Stream donut (1/3) ───────────────────
  const row1 = el('div', { style: 'display:grid;grid-template-columns:2fr 1fr;gap:16px;margin-bottom:16px' });
  row1.appendChild(el('div', { class: 'card' },
    el('div', { class: 'card-header' },
      el('div', { class: 'card-title' }, 'Monthly Expenses by Category'),
      el('div', { style: 'font-size:11px;color:var(--text-muted)' }, '● Amber = CapEx (Renovation)')
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
  buildExpenseTable(tableCard, data);
  wrap.appendChild(tableCard);

  // ── CapEx Impact section ───────────────────────────────────────────────────
  if (capEx.length > 0) buildCapExImpactSection(wrap, data);

  setTimeout(() => {
    renderCatBar(data);
    renderStreamDonut(data);
    renderCatHBar(data);
    renderVendorBar(data);
    renderTypeDonut(data);
    renderPropHBar(data);
  }, 0);

  return wrap;
}

// ── Chart 1: Stacked bar — Month × Category ───────────────────────────────────
function renderCatBar({ allExp }) {
  const months = getMonthKeys();
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

  // Preserve COST_CATEGORIES order; OpEx categories first, then CapEx (renovation)
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

  const entries     = [...streamMap.entries()].filter(([, v]) => v > 0);
  const streamKeys  = entries.map(([k]) => k);
  if (!entries.length) return;

  const streamColor = k => STREAMS[k]?.color || '#8b93b0';

  charts.doughnut('exp-stream-donut', {
    labels: entries.map(([k]) => STREAMS[k]?.label || k),
    data:   entries.map(([, v]) => Math.round(v)),
    colors: streamKeys.map(streamColor),
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

  // Order: OpEx first, CapEx last; sort descending within each group
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
      const name = idx === 0 ? 'Operating Expenses' : 'Renovation CapEx';
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

// ── CapEx Impact section ──────────────────────────────────────────────────────
function buildCapExImpactSection(container, { capEx, total }) {
  const card = el('div', { class: 'card', style: 'margin-top:16px' });
  card.appendChild(el('div', { class: 'card-header' },
    el('div', { class: 'card-title' }, 'CapEx Impact — Renovation Detail'),
    el('div', { style: 'font-size:11px;color:var(--text-muted)' },
      `${capEx.length} record(s) · ${total > 0 ? ((capEx.reduce((s, e) => s + toEUR(e.amount, e.currency, e.date), 0) / total * 100).toFixed(1)) : '0'}% of total spend`
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
// Columns: type (visual), date, category, vendor, stream, property, amountEUR
// CapEx rows get an amber left-border; OpEx rows get a red left-border
function buildExpenseTable(container, { allExp }) {
  const rows = allExp.map(e => {
    const resolved = resolveExpenseFields(e);
    const prop     = byId('properties', e.propertyId);
    const capex    = isCapEx(e);
    return {
      _date:     e.date,
      _eur:      toEUR(e.amount, e.currency, e.date),
      _capex:    capex,
      date:      fmtDate(e.date),
      type:      capex ? 'CapEx' : 'OpEx',
      category:  COST_CATEGORIES[resolved.costCategory]?.label || resolved.costCategory || e.category || '—',
      vendor:    vendorLabel(e),
      stream:    STREAMS[expStream(e)]?.short || expStream(e) || '—',
      property:  prop?.name || '—',
      amountEUR: formatEUR(toEUR(e.amount, e.currency, e.date))
    };
  }).sort((a, b) => (b._date || '').localeCompare(a._date || ''));

  // Table columns — type first for visual separation, then the required columns
  const TABLE_COLS = [
    { key: 'type',      label: 'Type'       },
    { key: 'date',      label: 'Date'       },
    { key: 'category',  label: 'Category'   },
    { key: 'vendor',    label: 'Vendor'     },
    { key: 'stream',    label: 'Stream'     },
    { key: 'property',  label: 'Property'   },
    { key: 'amountEUR', label: 'Amount EUR', right: true }
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
        // Badge for OpEx / CapEx
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
