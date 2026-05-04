// Executive Analytics Dashboard
import { el, select, fmtDate, drillDownModal } from '../core/ui.js';
import * as charts from '../core/charts.js';
import { STREAMS, OWNERS, COST_CATEGORIES, EXPENSE_CATEGORIES } from '../core/config.js';
import {
  availableYears, formatEUR, toEUR, byId,
  listActive, listActivePayments,
  isCapEx, drillRevRows, drillExpRows, forecastedRevenueEUR, forecastMonthlyEUR,
  sumPaymentsEUR, sumInvoicesEUR, sumExpensesEUR, yearTotalsEUR
} from '../core/data.js';

// ── Module-local filter state ────────────────────────────────────────────────
let gFilters = {
  years:   new Set([String(new Date().getFullYear())]),
  months:  new Set(),
  streams: new Set(),
  owners:  new Set()
};

const MONTH_LABELS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const CHART_IDS    = ['exec-trend-rev', 'exec-trend-profit', 'exec-trend-cashflow', 'exec-kd-rev-stream', 'exec-kd-exp-cat'];

// ── Module definition ────────────────────────────────────────────────────────
export default {
  id:    'analytics',
  label: 'Executive',
  icon:  'A',
  render(container) { container.appendChild(buildView()); },
  refresh() { rebuildView(); },
  destroy() { CHART_IDS.forEach(id => charts.destroy(id)); }
};

// ── Filter helpers ───────────────────────────────────────────────────────────
function matchDate(row) {
  const d = row.date || row.issueDate || '';
  if (gFilters.years.size > 0 && !gFilters.years.has(d.slice(0, 4))) return false;
  if (gFilters.months.size > 0 && !gFilters.months.has(d.slice(5, 7))) return false;
  return true;
}
function matchStream(row) {
  return gFilters.streams.size === 0 || !row.stream || gFilters.streams.has(row.stream);
}
function matchOwner(row) {
  if (gFilters.owners.size === 0) return true;
  if (!row.propertyId) return true;
  const owner = byId('properties', row.propertyId)?.owner || 'both';
  return owner === 'both' || gFilters.owners.has(owner);
}

function getData() {
  const payments = listActivePayments().filter(p =>
    p.status === 'paid' && matchDate(p) && matchStream(p) && matchOwner(p)
  );
  const invoices = listActive('invoices').filter(i =>
    i.status === 'paid' && matchDate({ date: i.issueDate }) && matchStream(i)
  );
  const opExpenses = listActive('expenses').filter(e =>
    !isCapEx(e) && matchDate(e) && matchStream(e) && matchOwner(e)
  );
  const renoExpenses = listActive('expenses').filter(e =>
    isCapEx(e) && matchDate(e) && matchOwner(e)
  );
  const rev  = sumPaymentsEUR(payments) + sumInvoicesEUR(invoices);
  const exp  = sumExpensesEUR(opExpenses);
  const reno = sumExpensesEUR(renoExpenses);
  return { payments, invoices, opExpenses, renoExpenses, rev, exp, reno, net: rev - exp };
}

// ── Rebuild helper ────────────────────────────────────────────────────────────
function rebuildView() {
  CHART_IDS.forEach(id => charts.destroy(id));
  const c = document.getElementById('content');
  if (!c) return;
  c.innerHTML = '';
  c.appendChild(buildView());
}

// ── Multi-select dropdown ────────────────────────────────────────────────────
function buildMultiSelect(items, filterSet, allLabel, onRefresh) {
  const wrapper = el('div', { style: 'position:relative' });

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

  const chks = items.map(({ value, label, css }) => {
    const chk          = el('input', { type: 'checkbox' });
    chk.dataset.value  = value;
    chk.checked        = filterSet.size === 0 || filterSet.has(value);
    const content      = css ? el('span', { class: `badge ${css}` }, label) : el('span', {}, label);
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
    sync();
  };
  chks.forEach(chk => { chk.onchange = () => sync(); });
  const closeMenu = () => {
    if (menu.style.display === 'none') return;
    menu.style.display = 'none';
    onRefresh();
  };
  trigger.onclick = e => {
    e.stopPropagation();
    menu.style.display === 'none' ? (menu.style.display = '') : closeMenu();
  };
  menu.onclick = e => e.stopPropagation();
  document.addEventListener('click', closeMenu);
  wrapper.appendChild(trigger);
  wrapper.appendChild(menu);
  sync();
  return wrapper;
}

// ── KPI card ──────────────────────────────────────────────────────────────────
function kpiCard(label, value, variant, onClick, sub) {
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
  if (sub != null) card.appendChild(el('div', { class: 'kpi-trend' }, sub));
  card.appendChild(el('div', { class: 'kpi-accent-bar' }));
  return card;
}

function periodTrend(current, prev, prevLabel, invert = false) {
  if (prev === null || prev === undefined || prev === 0) return null;
  const pct  = ((current - prev) / Math.abs(prev)) * 100;
  const sign = pct > 0 ? '+' : '';
  const cls  = (invert ? pct < 0 : pct > 0) ? 'up' : (invert ? pct > 0 : pct < 0) ? 'down' : '';
  return el('span', { class: cls }, `${sign}${pct.toFixed(1)}% vs ${prevLabel}`);
}

// ── Drill-down column sets ────────────────────────────────────────────────────
const REV_COLS = [
  { key: 'date',   label: 'Date',   format: v => fmtDate(v) },
  { key: 'type',   label: 'Type'   },
  { key: 'source', label: 'Entity' },
  { key: 'ref',    label: 'Ref'    },
  { key: 'eur',    label: 'EUR',    right: true, format: v => formatEUR(v) }
];
const EXP_COLS = [
  { key: 'date',        label: 'Date',       format: v => fmtDate(v) },
  { key: 'source',      label: 'Property'    },
  { key: 'category',    label: 'Category'    },
  { key: 'description', label: 'Description' },
  { key: 'eur',         label: 'EUR',         right: true, format: v => formatEUR(v) }
];
const MIXED_COLS = [
  { key: 'date',   label: 'Date',             format: v => fmtDate(v) },
  { key: 'kind',   label: 'Kind'              },
  { key: 'source', label: 'Entity / Source'   },
  { key: 'eur',    label: 'EUR',               right: true, format: v => formatEUR(v) }
];

function mixedRows(revPays, revInvs, expItems) {
  return [
    ...drillRevRows(revPays, revInvs).map(r => ({
      date: r.date, kind: 'Revenue',
      source: r.source + (r.ref ? ' · ' + r.ref : ''), eur: r.eur
    })),
    ...drillExpRows(expItems).map(r => ({
      date: r.date, kind: 'Expense',
      source: (r.source ? r.source + ' · ' : '') + r.category, eur: r.eur
    }))
  ].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

// ── Single source of truth ────────────────────────────────────────────────────
function calculateExecutiveSummary(data) {
  const { payments, invoices, opExpenses, renoExpenses, rev, exp, reno, net } = data;
  const netCash  = net - reno;
  const expRatio = rev > 0 ? (exp / rev) * 100 : 0;

  // Outstanding / overdue invoices — respecting current date + stream filters
  const outstandingInvs = listActive('invoices').filter(i =>
    (i.status === 'sent' || i.status === 'overdue') &&
    matchDate({ date: i.issueDate }) &&
    matchStream(i)
  );
  const overdueInvs  = outstandingInvs.filter(i => i.status === 'overdue');
  const outstanding  = sumInvoicesEUR(outstandingInvs);
  const overdue      = sumInvoicesEUR(overdueInvs);

  // Forecast variance
  const currentYear = gFilters.years.size === 1 ? [...gFilters.years][0] : null;
  let forecastVariance = null, forecastRev = null;
  if (currentYear) {
    forecastRev = forecastedRevenueEUR(currentYear);
    if (forecastRev > 0) forecastVariance = rev - forecastRev;
  }

  // Revenue by Stream — accumulate pays/invs per stream
  const revByStream = new Map();
  payments.forEach(p => {
    const s = p.stream || 'other';
    const e = revByStream.get(s) || { rev: 0, pays: [], invs: [] };
    e.rev += toEUR(p.amount, p.currency, p.date);
    e.pays.push(p);
    revByStream.set(s, e);
  });
  invoices.forEach(i => {
    const s = i.stream || 'other';
    const e = revByStream.get(s) || { rev: 0, pays: [], invs: [] };
    e.rev += toEUR(i.total, i.currency, i.issueDate);
    e.invs.push(i);
    revByStream.set(s, e);
  });

  // Expenses by Category — accumulate items per category
  const expByCategory = new Map();
  [...opExpenses, ...renoExpenses].forEach(x => {
    const cat   = x.costCategory || x.category || 'other';
    const entry = expByCategory.get(cat) || { exp: 0, items: [] };
    entry.exp += toEUR(x.amount, x.currency, x.date);
    entry.items.push(x);
    expByCategory.set(cat, entry);
  });

  // Entities — properties + clients, with per-entity rev/exp/net/roi
  const entityMap = new Map();
  payments.forEach(p => {
    if (!p.propertyId) return;
    const prop = byId('properties', p.propertyId);
    if (!prop) return;
    const e = entityMap.get(p.propertyId) || { id: p.propertyId, name: prop.name, type: 'property', rev: 0, exp: 0, pays: [], invs: [], opExps: [] };
    e.rev += toEUR(p.amount, p.currency, p.date);
    e.pays.push(p);
    entityMap.set(p.propertyId, e);
  });
  invoices.forEach(i => {
    if (!i.clientId) return;
    const client = byId('clients', i.clientId);
    if (!client) return;
    const e = entityMap.get(i.clientId) || { id: i.clientId, name: client.name, type: 'client', rev: 0, exp: 0, pays: [], invs: [], opExps: [] };
    e.rev += toEUR(i.total, i.currency, i.issueDate);
    e.invs.push(i);
    entityMap.set(i.clientId, e);
  });
  opExpenses.forEach(x => {
    const e = x.propertyId && entityMap.get(x.propertyId);
    if (e) { e.exp += toEUR(x.amount, x.currency, x.date); e.opExps.push(x); }
  });
  const entities = [...entityMap.values()].map(e => {
    const eNet = e.rev - e.exp;
    let roi = null;
    if (e.type === 'property') {
      const prop = byId('properties', e.id);
      if (prop?.purchasePrice) {
        const purchaseEUR   = toEUR(prop.purchasePrice, prop.currency, prop.purchaseDate);
        const allRenoEUR    = listActive('expenses')
          .filter(ex => isCapEx(ex) && ex.propertyId === e.id)
          .reduce((s, ex) => s + toEUR(ex.amount, ex.currency, ex.date), 0);
        const totalInvested = purchaseEUR + allRenoEUR;
        if (totalInvested > 0) roi = (eNet / totalInvested) * 100;
      }
    }
    return { ...e, net: eNet, roi };
  });

  return {
    rev, exp, reno, net, netCash, expRatio,
    outstanding, overdue, outstandingInvs, overdueInvs,
    forecastVariance, forecastRev,
    revByStream, expByCategory, entities,
    payments, invoices, opExpenses, renoExpenses
  };
}

// Unfiltered summary for a previous year — used only for period-over-period deltas
function calculatePrevYearSummary(year) {
  const pt       = yearTotalsEUR(year);
  const expRatio = pt.rev > 0 ? (pt.exp / pt.rev) * 100 : null;
  const outstandingInvs = listActive('invoices').filter(i =>
    (i.status === 'sent' || i.status === 'overdue') && (i.issueDate || '').startsWith(year)
  );
  const overdueInvs = outstandingInvs.filter(i => i.status === 'overdue');
  const outstanding = sumInvoicesEUR(outstandingInvs);
  const overdue     = sumInvoicesEUR(overdueInvs);
  const pyFRev      = forecastedRevenueEUR(year);
  return {
    year, ...pt, expRatio, outstanding, overdue,
    forecastVariance: pyFRev > 0 ? pt.rev - pyFRev : null,
    forecastRev:      pyFRev > 0 ? pyFRev : null
  };
}

// ── 8-card KPI Row ────────────────────────────────────────────────────────────
function buildKpiRow(summary, prevSummary, prevYear) {
  const { rev, net, netCash, outstanding, exp, reno, expRatio, forecastVariance, forecastRev,
          payments, invoices, opExpenses, renoExpenses, outstandingInvs } = summary;
  const pl = prevYear;

  const grid = el('div', {
    class: 'mb-16',
    style: 'display:grid;grid-template-columns:repeat(9,1fr);gap:12px'
  });

  grid.appendChild(kpiCard(
    'Revenue', formatEUR(rev),
    rev >= 0 ? '' : 'danger',
    () => drillDownModal('Revenue Breakdown', drillRevRows(payments, invoices), REV_COLS),
    prevSummary ? periodTrend(rev, prevSummary.rev, pl) : null
  ));
  grid.appendChild(kpiCard(
    'Forecast Revenue', forecastRev ? formatEUR(forecastRev) : '—',
    '',
    () => drillDownModal('Revenue Breakdown', drillRevRows(payments, invoices), REV_COLS)
  ));
  const varVariant = forecastVariance === null ? '' : forecastVariance >= 0 ? 'success' : 'danger';
  grid.appendChild(kpiCard(
    'Forecast Variance', forecastVariance !== null ? formatEUR(forecastVariance) : '—',
    varVariant,
    () => drillDownModal('Revenue Breakdown', drillRevRows(payments, invoices), REV_COLS),
    prevSummary && forecastVariance !== null
      ? periodTrend(forecastVariance, prevSummary.forecastVariance, pl) : null
  ));
  grid.appendChild(kpiCard(
    'Net Profit', formatEUR(net),
    net >= 0 ? 'success' : 'danger',
    () => drillDownModal('Net Profit Breakdown', mixedRows(payments, invoices, opExpenses), MIXED_COLS),
    prevSummary ? periodTrend(net, prevSummary.net, pl) : null
  ));
  grid.appendChild(kpiCard(
    'Cash Flow', formatEUR(netCash),
    netCash >= 0 ? 'success' : 'danger',
    () => drillDownModal('Cash Flow Breakdown', mixedRows(payments, invoices, [...opExpenses, ...renoExpenses]), MIXED_COLS),
    prevSummary ? periodTrend(netCash, prevSummary.netCash, pl) : null
  ));
  grid.appendChild(kpiCard(
    'Outstanding', formatEUR(outstanding),
    outstanding > 0 ? 'warning' : '',
    () => drillDownModal('Outstanding Invoices', drillRevRows([], outstandingInvs), REV_COLS),
    prevSummary ? periodTrend(outstanding, prevSummary.outstanding, pl, true) : null
  ));
  grid.appendChild(kpiCard(
    'OpEx', formatEUR(exp),
    '',
    () => drillDownModal('Operating Expenses', drillExpRows(opExpenses), EXP_COLS),
    prevSummary ? periodTrend(exp, prevSummary.exp, pl, true) : null
  ));
  grid.appendChild(kpiCard(
    'CapEx', formatEUR(reno),
    reno > 0 ? 'warning' : '',
    () => drillDownModal('Renovation CapEx', drillExpRows(renoExpenses), EXP_COLS),
    prevSummary ? periodTrend(reno, prevSummary.reno, pl, true) : null
  ));
  grid.appendChild(kpiCard(
    'Expense Ratio', rev > 0 ? `${expRatio.toFixed(1)}%` : '—',
    expRatio > 80 ? 'danger' : expRatio > 60 ? 'warning' : '',
    () => drillDownModal('Operating Expenses', drillExpRows(opExpenses), EXP_COLS),
    prevSummary ? periodTrend(expRatio, prevSummary.expRatio, pl, true) : null
  ));

  return grid;
}

// ── Business Trends — DOM skeleton ────────────────────────────────────────────
function buildTrendsSection() {
  const card = el('div', { class: 'card mb-16' });
  card.appendChild(el('div', { class: 'card-header' },
    el('div', { class: 'card-title' }, 'Business Trends')
  ));
  const grid = el('div', {
    style: 'display:grid;grid-template-columns:repeat(3,1fr);gap:16px;padding:0 16px 16px'
  });
  const makePanel = (title, canvasId) => {
    const panel = el('div');
    panel.appendChild(el('div', { class: 'kpi-label', style: 'margin-bottom:8px' }, title));
    panel.appendChild(el('div', { class: 'chart-wrap' }, el('canvas', { id: canvasId })));
    return panel;
  };
  grid.appendChild(makePanel('Revenue',    'exec-trend-rev'));
  grid.appendChild(makePanel('Net Profit', 'exec-trend-profit'));
  grid.appendChild(makePanel('Cash Flow',  'exec-trend-cashflow'));
  card.appendChild(grid);
  return card;
}

// ── Performance Insights ──────────────────────────────────────────────────────
function buildDriverExplanations(summary) {
  const { expByCategory, entities } = summary;

  const section = el('div', { class: 'card mb-16' });
  section.appendChild(el('div', { class: 'card-header' },
    el('div', { class: 'card-title' }, 'Performance Insights')
  ));
  const body = el('div', { style: 'padding:0 16px 16px;font-size:13px;line-height:1.8' });

  const topEntities = [...entities].sort((a, b) => b.rev - a.rev).slice(0, 2);
  const topExpCat   = [...expByCategory.entries()].sort((a, b) => b[1].exp - a[1].exp)[0];

  if (!topEntities.length && !topExpCat) {
    body.appendChild(el('div', { style: 'color:var(--text-muted)' },
      'No explanation available for the selected filters.'
    ));
    section.appendChild(body);
    return section;
  }

  const row = el('div', { style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px' });

  const makeBlock = (label, lines) => {
    const block = el('div');
    block.appendChild(el('div', {
      style: 'font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:var(--text-muted);margin-bottom:6px'
    }, label));
    lines.forEach(({ text, onClick }) => {
      const p = el('p', { style: 'margin:0' }, text);
      if (onClick) {
        p.style.cursor = 'pointer';
        p.title = 'Click for breakdown';
        p.onclick = onClick;
      }
      block.appendChild(p);
    });
    return block;
  };

  // Revenue concentration
  if (topEntities.length) {
    const lines = [];
    if (topEntities[0]) {
      const e = topEntities[0];
      lines.push({
        text: `Top contributor: ${e.name} (${formatEUR(e.rev)})`,
        onClick: () => drillDownModal(`${e.name} — Revenue`, drillRevRows(e.pays, e.invs), REV_COLS)
      });
    }
    if (topEntities[1]) {
      const e = topEntities[1];
      lines.push({
        text: `Second: ${e.name} (${formatEUR(e.rev)})`,
        onClick: () => drillDownModal(`${e.name} — Revenue`, drillRevRows(e.pays, e.invs), REV_COLS)
      });
    }
    row.appendChild(makeBlock('Revenue concentration', lines));
  }

  // Cost concentration
  if (topExpCat) {
    const [ck, cd] = topExpCat;
    const catLabel = COST_CATEGORIES[ck]?.label || EXPENSE_CATEGORIES[ck]?.label || ck;
    row.appendChild(makeBlock('Cost concentration', [{
      text: `Main cost driver: ${catLabel} (${formatEUR(cd.exp)})`,
      onClick: () => drillDownModal(`Expenses — ${catLabel}`, drillExpRows(cd.items), EXP_COLS)
    }]));
  }

  // Risk signal — only if there is a dominant single contributor
  if (topEntities[0]) {
    row.appendChild(makeBlock('Risk signal', [{
      text: `High dependency on a single contributor (${topEntities[0].name})`,
      onClick: () => drillDownModal(`${topEntities[0].name} — Revenue`, drillRevRows(topEntities[0].pays, topEntities[0].invs), REV_COLS)
    }]));
  }

  // Investment signal — only if CapEx category data is present
  const capExCat = [...expByCategory.entries()]
    .filter(([k]) => (COST_CATEGORIES[k]?.label || '').toLowerCase().includes('capex') ||
                     (EXPENSE_CATEGORIES[k]?.label || '').toLowerCase().includes('capex') ||
                     k === 'capex' || k === 'renovation')
    .sort((a, b) => b[1].exp - a[1].exp)[0];
  if (capExCat) {
    const [ck, cd] = capExCat;
    const catLabel = COST_CATEGORIES[ck]?.label || EXPENSE_CATEGORIES[ck]?.label || ck;
    row.appendChild(makeBlock('Investment signal', [{
      text: `High CapEx driven by ${catLabel} (${formatEUR(cd.exp)})`,
      onClick: () => drillDownModal(`Expenses — ${catLabel}`, drillExpRows(cd.items), EXP_COLS)
    }]));
  }

  body.appendChild(row);
  section.appendChild(body);
  return section;
}

// ── Key Drivers — DOM skeleton (2-panel) ──────────────────────────────────────
function buildKeyDriversSection() {
  const card = el('div', { class: 'card mb-16' });
  card.appendChild(el('div', { class: 'card-header' },
    el('div', { class: 'card-title' }, 'Key Drivers')
  ));
  const grid = el('div', {
    style: 'display:grid;grid-template-columns:1fr 1fr;gap:16px;padding:0 16px 16px'
  });
  const makePanel = (title, canvasId) => {
    const panel = el('div');
    panel.appendChild(el('div', { class: 'kpi-label', style: 'margin-bottom:8px' }, title));
    panel.appendChild(el('div', { class: 'chart-wrap' }, el('canvas', { id: canvasId })));
    return panel;
  };
  grid.appendChild(makePanel('Revenue by Stream',    'exec-kd-rev-stream'));
  grid.appendChild(makePanel('Expenses by Category', 'exec-kd-exp-cat'));
  card.appendChild(grid);
  return card;
}

// ── Key Drivers — render 2 doughnut charts from summary ──────────────────────
function renderKeyDrivers(summary) {
  const { revByStream, expByCategory } = summary;

  // Revenue by Stream
  const revEntries = [...revByStream.entries()].filter(([, d]) => d.rev > 0);
  if (revEntries.length) {
    charts.doughnut('exec-kd-rev-stream', {
      labels: revEntries.map(([k]) => STREAMS[k]?.label || k),
      data:   revEntries.map(([, d]) => Math.round(d.rev)),
      colors: revEntries.map(([k]) => STREAMS[k]?.color || '#8b93b0'),
      onClickItem: (label, idx) => {
        const [, sd] = revEntries[idx];
        drillDownModal(`Revenue — ${label}`, drillRevRows(sd.pays, sd.invs), REV_COLS);
      }
    });
  }

  // Expenses by Category
  const catEntries = [...expByCategory.entries()]
    .filter(([, d]) => d.exp > 0)
    .sort((a, b) => b[1].exp - a[1].exp);
  if (catEntries.length) {
    charts.doughnut('exec-kd-exp-cat', {
      labels: catEntries.map(([k]) => COST_CATEGORIES[k]?.label || EXPENSE_CATEGORIES[k]?.label || k),
      data:   catEntries.map(([, d]) => Math.round(d.exp)),
      colors: catEntries.map(([k]) => COST_CATEGORIES[k]?.color || EXPENSE_CATEGORIES[k]?.color || '#8b93b0'),
      onClickItem: (label, idx) => {
        const [, cd] = catEntries[idx];
        drillDownModal(`Expenses — ${label}`, drillExpRows(cd.items), EXP_COLS);
      }
    });
  }
}

// ── Main view builder ─────────────────────────────────────────────────────────
function buildView() {
  const wrap = el('div', { class: 'view active' });

  // Page header
  wrap.appendChild(el('div', { style: 'margin-bottom:16px' },
    el('h2', { style: 'margin:0 0 4px;font-size:20px;font-weight:700' }, 'Executive Analytics'),
    el('p',  { style: 'margin:0;font-size:13px;color:var(--text-muted)' },
      'Consolidated overview — revenue, expenses and cash flow')
  ));

  // Filter bar: Year → Month → Owner → Stream
  const yearFilter = buildMultiSelect(
    availableYears().map(y => ({ value: y, label: y })),
    gFilters.years, 'All Years', rebuildView
  );

  const filterBar = el('div', { class: 'flex gap-8 mb-16', style: 'flex-wrap:wrap;align-items:center' });
  filterBar.appendChild(el('span', { style: 'font-size:12px;color:var(--text-muted);align-self:center' }, 'Filters:'));
  filterBar.appendChild(yearFilter);
  filterBar.appendChild(buildMultiSelect(
    MONTH_LABELS.map((m, i) => ({ value: String(i + 1).padStart(2, '0'), label: m })),
    gFilters.months, 'All Months', rebuildView
  ));
  filterBar.appendChild(buildMultiSelect(
    Object.entries(OWNERS).map(([k, v]) => ({ value: k, label: v })),
    gFilters.owners, 'All Owners', rebuildView
  ));
  filterBar.appendChild(buildMultiSelect(
    Object.entries(STREAMS).map(([k, v]) => ({ value: k, label: v.label, css: v.css })),
    gFilters.streams, 'All Streams', rebuildView
  ));
  wrap.appendChild(filterBar);

  // Single data pass → single summary object
  const data    = getData();
  const summary = calculateExecutiveSummary(data);

  const currentYear = gFilters.years.size === 1 ? [...gFilters.years][0] : null;
  const prevYear    = currentYear ? String(Number(currentYear) - 1) : null;
  const prevSummary = prevYear ? calculatePrevYearSummary(prevYear) : null;

  // Layout: KPI Row → Trends → Key Drivers → Performance Insights
  wrap.appendChild(buildKpiRow(summary, prevSummary, prevYear));
  wrap.appendChild(buildTrendsSection());
  wrap.appendChild(buildKeyDriversSection());
  wrap.appendChild(buildDriverExplanations(summary));

  setTimeout(() => {
    renderTrendCharts(data);
    renderKeyDrivers(summary);
  }, 0);

  return wrap;
}

// ── Month key helper ──────────────────────────────────────────────────────────
function getMonthKeys() {
  const selectedYears = gFilters.years.size > 0
    ? [...gFilters.years].sort()
    : availableYears();
  if (selectedYears.length === 1) {
    const year = selectedYears[0];
    return MONTH_LABELS.map((label, i) => {
      const mm = String(i + 1).padStart(2, '0');
      return { label, key: `${year}-${mm}`, mm };
    }).filter(m => gFilters.months.size === 0 || gFilters.months.has(m.mm));
  }
  const keys = [];
  for (const year of selectedYears) {
    MONTH_LABELS.forEach((label, i) => {
      const mm = String(i + 1).padStart(2, '0');
      if (gFilters.months.size === 0 || gFilters.months.has(mm)) {
        keys.push({ label: `${label} '${year.slice(2)}`, key: `${year}-${mm}`, mm });
      }
    });
  }
  return keys;
}

// ── Business Trends — render 3 line charts ────────────────────────────────────
function renderTrendCharts({ payments, invoices, opExpenses, renoExpenses }) {
  const months = getMonthKeys();
  if (!months.length) return;

  const revMap = new Map(), expMap = new Map(), renoMap = new Map();
  payments.forEach(p => {
    const mk = p.date?.slice(0, 7);
    if (mk) revMap.set(mk, (revMap.get(mk) || 0) + toEUR(p.amount, p.currency, p.date));
  });
  invoices.forEach(i => {
    const mk = (i.issueDate || '').slice(0, 7);
    if (mk) revMap.set(mk, (revMap.get(mk) || 0) + toEUR(i.total, i.currency, i.issueDate));
  });
  opExpenses.forEach(e => {
    const mk = e.date?.slice(0, 7);
    if (mk) expMap.set(mk, (expMap.get(mk) || 0) + toEUR(e.amount, e.currency, e.date));
  });
  renoExpenses.forEach(e => {
    const mk = e.date?.slice(0, 7);
    if (mk) renoMap.set(mk, (renoMap.get(mk) || 0) + toEUR(e.amount, e.currency, e.date));
  });

  const labels   = months.map(m => m.label);
  const revData  = months.map(m => Math.round(revMap.get(m.key)  || 0));
  const expData  = months.map(m => Math.round(expMap.get(m.key)  || 0));
  const renoData = months.map(m => Math.round(renoMap.get(m.key) || 0));
  const netData  = months.map((_, i) => revData[i] - expData[i]);
  const cashData = months.map((_, i) => netData[i] - renoData[i]);

  const currentYear = gFilters.years.size === 1 ? [...gFilters.years][0] : null;
  let fcMap = null;
  if (currentYear) {
    const raw = forecastMonthlyEUR(currentYear);
    if (raw.size > 0) fcMap = raw;
  }

  // Revenue trend (with optional forecast overlay)
  const revDatasets = [{
    label: 'Revenue', data: revData,
    borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,0.08)', fill: true
  }];
  if (fcMap) {
    const fcData = months.map(m => Math.round(fcMap.get(m.key) || 0));
    if (fcData.some(v => v > 0)) {
      revDatasets.push({
        label: 'Forecast', data: fcData,
        borderColor: '#6366f1', backgroundColor: 'transparent',
        borderDash: [4, 4], fill: false
      });
    }
  }
  charts.line('exec-trend-rev', {
    labels, datasets: revDatasets,
    onClickItem: (label, idx) => {
      const mk = months[idx]?.key;
      if (!mk) return;
      drillDownModal(
        `${label} — Revenue`,
        drillRevRows(
          payments.filter(p => p.date?.slice(0, 7) === mk),
          invoices.filter(i => (i.issueDate || '').slice(0, 7) === mk)
        ),
        REV_COLS
      );
    }
  });

  charts.line('exec-trend-profit', {
    labels,
    datasets: [{
      label: 'Net Profit', data: netData,
      borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,0.08)', fill: true
    }],
    onClickItem: (label, idx) => {
      const mk = months[idx]?.key;
      if (!mk) return;
      drillDownModal(
        `${label} — Net Profit`,
        mixedRows(
          payments.filter(p => p.date?.slice(0, 7) === mk),
          invoices.filter(i => (i.issueDate || '').slice(0, 7) === mk),
          opExpenses.filter(e => e.date?.slice(0, 7) === mk)
        ),
        MIXED_COLS
      );
    }
  });

  charts.line('exec-trend-cashflow', {
    labels,
    datasets: [{
      label: 'Cash Flow', data: cashData,
      borderColor: '#f59e0b', backgroundColor: 'rgba(245,158,11,0.08)', fill: true
    }],
    onClickItem: (label, idx) => {
      const mk = months[idx]?.key;
      if (!mk) return;
      drillDownModal(
        `${label} — Cash Flow`,
        mixedRows(
          payments.filter(p => p.date?.slice(0, 7) === mk),
          invoices.filter(i => (i.issueDate || '').slice(0, 7) === mk),
          [...opExpenses, ...renoExpenses].filter(e => e.date?.slice(0, 7) === mk)
        ),
        MIXED_COLS
      );
    }
  });
}
