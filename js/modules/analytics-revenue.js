// Revenue Analytics Dashboard — understand revenue sources
import { el, select, fmtDate, drillDownModal, attachSortFilter } from '../core/ui.js';
import * as charts from '../core/charts.js';
import { STREAMS, OWNERS } from '../core/config.js';
import {
  availableYears, formatEUR, toEUR, byId,
  listActive, listActivePayments, listActiveClients,
  drillRevRows
} from '../core/data.js';

// ── Filter state ──────────────────────────────────────────────────────────────
let gFilters = {
  year:        String(new Date().getFullYear()),
  months:      new Set(),   // empty = all
  streams:     new Set(),
  owners:      new Set(),
  propertyIds: new Set(),
  clientIds:   new Set()
};

const MONTH_LABELS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const CHART_IDS    = ['rev-stream-bar', 'rev-prop-bar', 'rev-client-bar', 'rev-owner-donut'];
const OWNER_COLORS = { you: '#6366f1', rita: '#ec4899', both: '#14b8a6' };

// ── Module export ─────────────────────────────────────────────────────────────
export default {
  id:    'analytics-revenue',
  label: 'Revenue',
  icon:  '₊',
  render(container) { container.appendChild(buildView()); },
  refresh() { rebuildView(); },
  destroy() { CHART_IDS.forEach(id => charts.destroy(id)); }
};

// ── Filtering ─────────────────────────────────────────────────────────────────
function matchDate(row) {
  const d = row.date || row.issueDate || '';
  if (gFilters.year && gFilters.year !== 'all' && !d.startsWith(gFilters.year)) return false;
  if (gFilters.months.size > 0 && !gFilters.months.has(d.slice(5, 7))) return false;
  return true;
}
function matchStream(row) {
  return gFilters.streams.size === 0 || !row.stream || gFilters.streams.has(row.stream);
}
function matchOwner(row) {
  if (gFilters.owners.size === 0) return true;
  const propId   = row.propertyId;
  const clientId = row.clientId;
  const owner    = propId
    ? (byId('properties', propId)?.owner || 'both')
    : (row.owner || 'both');
  return owner === 'both' || gFilters.owners.has(owner);
}
function matchProperty(row) {
  return gFilters.propertyIds.size === 0 || !row.propertyId || gFilters.propertyIds.has(row.propertyId);
}
function matchClient(row) {
  return gFilters.clientIds.size === 0 || !row.clientId || gFilters.clientIds.has(row.clientId);
}

function getData() {
  const payments = listActivePayments().filter(p =>
    p.status === 'paid' && matchDate(p) && matchStream(p) && matchOwner(p) && matchProperty(p)
  );
  const invoices = listActive('invoices').filter(i =>
    i.status === 'paid' &&
    matchDate({ date: i.issueDate }) &&
    matchStream(i) &&
    matchOwner(i) &&
    matchClient(i)
  );
  const propRev   = payments.reduce((s, p) => s + toEUR(p.amount, p.currency, p.date), 0);
  const svcRev    = invoices.reduce((s, i) => s + toEUR(i.total, i.currency, i.issueDate), 0);
  return { payments, invoices, propRev, svcRev, total: propRev + svcRev };
}

// ── Rebuild ───────────────────────────────────────────────────────────────────
function rebuildView() {
  CHART_IDS.forEach(id => charts.destroy(id));
  const c = document.getElementById('content');
  if (!c) return;
  c.innerHTML = '';
  c.appendChild(buildView());
}

// ── Multi-select dropdown ─────────────────────────────────────────────────────
function buildMultiSelect(items, filterSet, allLabel, onRefresh) {
  const wrapper    = el('div', { style: 'position:relative' });
  const trigLabel  = el('span');
  const trigger    = el('div', {
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
    const chk = el('input', { type: 'checkbox' });
    chk.dataset.value = value;
    chk.checked = filterSet.size === 0 || filterSet.has(value);
    const content = css ? el('span', { class: `badge ${css}` }, label) : el('span', {}, label);
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
  menu.onclick   = e => e.stopPropagation();
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

// ── Column definitions ────────────────────────────────────────────────────────
const REV_COLS = [
  { key: 'date',   label: 'Date',   format: v => fmtDate(v) },
  { key: 'type',   label: 'Type'   },
  { key: 'source', label: 'Entity' },
  { key: 'ref',    label: 'Ref'    },
  { key: 'eur',    label: 'EUR',    right: true, format: v => formatEUR(v) }
];

// ── Month key helpers ─────────────────────────────────────────────────────────
function getMonthKeys() {
  const year = gFilters.year !== 'all' ? gFilters.year : String(new Date().getFullYear());
  return MONTH_LABELS.map((label, i) => {
    const mm  = String(i + 1).padStart(2, '0');
    return { label, key: `${year}-${mm}`, mm };
  }).filter(m => gFilters.months.size === 0 || gFilters.months.has(m.mm));
}

// ── Inline insights ───────────────────────────────────────────────────────────
function buildInsightsBanner(insights) {
  if (!insights.length) return null;
  const wrap = el('div', { style: 'display:flex;flex-direction:column;gap:8px;margin-bottom:16px' });
  wrap.appendChild(el('div', {
    style: 'font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:var(--text-muted);margin-bottom:2px'
  }, 'Revenue Insights'));
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

function computeRevenueInsights({ payments, invoices, propRev, svcRev, total }) {
  const items = [];
  if (total === 0) {
    items.push({ level: 'info', text: 'No revenue recorded for the selected period.' });
    return items;
  }
  // Stream concentration
  const streamMap = new Map();
  payments.forEach(p => {
    const sk = p.stream || 'other';
    streamMap.set(sk, (streamMap.get(sk) || 0) + toEUR(p.amount, p.currency, p.date));
  });
  invoices.forEach(i => {
    const sk = i.stream || 'other';
    streamMap.set(sk, (streamMap.get(sk) || 0) + toEUR(i.total, i.currency, i.issueDate));
  });
  const topStream = [...streamMap.entries()].sort((a, b) => b[1] - a[1])[0];
  if (topStream && topStream[1] / total > 0.80) {
    const pct   = Math.round(topStream[1] / total * 100);
    const label = STREAMS[topStream[0]]?.label || topStream[0];
    items.push({ level: 'warning', text: `"${label}" accounts for ${pct}% of total revenue — high stream concentration.` });
  }
  // Property concentration
  const propMap = new Map();
  payments.forEach(p => {
    const name = byId('properties', p.propertyId)?.name || 'Unknown';
    propMap.set(name, (propMap.get(name) || 0) + toEUR(p.amount, p.currency, p.date));
  });
  const topProp = [...propMap.entries()].sort((a, b) => b[1] - a[1])[0];
  if (topProp && propRev > 0 && topProp[1] / propRev > 0.75) {
    const pct = Math.round(topProp[1] / propRev * 100);
    items.push({ level: 'warning', text: `"${topProp[0]}" generates ${pct}% of property revenue — single-property concentration risk.` });
  }
  // Owner concentration
  const ownerMap = new Map();
  payments.forEach(p => {
    const owner = byId('properties', p.propertyId)?.owner || 'both';
    ownerMap.set(owner, (ownerMap.get(owner) || 0) + toEUR(p.amount, p.currency, p.date));
  });
  invoices.forEach(i => {
    const owner = i.owner || 'both';
    ownerMap.set(owner, (ownerMap.get(owner) || 0) + toEUR(i.total, i.currency, i.issueDate));
  });
  const topOwner = [...ownerMap.entries()].filter(([k]) => k !== 'both').sort((a, b) => b[1] - a[1])[0];
  if (topOwner && topOwner[1] / total > 0.85) {
    const pct = Math.round(topOwner[1] / total * 100);
    items.push({ level: 'info', text: `One owner contributes ${pct}% of all revenue — limited diversification across owners.` });
  }
  return items;
}

// ── Main view ─────────────────────────────────────────────────────────────────
function buildView() {
  const wrap = el('div', { class: 'view active' });

  // Header
  wrap.appendChild(el('div', { style: 'margin-bottom:16px' },
    el('h2', { style: 'margin:0 0 4px;font-size:20px;font-weight:700' }, 'Revenue Analytics'),
    el('p',  { style: 'margin:0;font-size:13px;color:var(--text-muted)' },
      'Understand revenue sources — properties, clients, streams and owners')
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
    Object.entries(STREAMS).map(([k, v]) => ({ value: k, label: v.label, css: v.css })),
    gFilters.streams, 'All Streams', rebuildView
  ));
  filterBar.appendChild(buildMultiSelect(
    Object.entries(OWNERS).map(([k, v]) => ({ value: k, label: v })),
    gFilters.owners, 'All Owners', rebuildView
  ));
  filterBar.appendChild(buildMultiSelect(
    listActive('properties').map(p => ({ value: p.id, label: p.name })),
    gFilters.propertyIds, 'All Properties', rebuildView
  ));
  filterBar.appendChild(buildMultiSelect(
    listActiveClients().map(c => ({ value: c.id, label: c.name })),
    gFilters.clientIds, 'All Clients', rebuildView
  ));
  wrap.appendChild(filterBar);

  // Data
  const data = getData();
  const { payments, invoices, propRev, svcRev, total } = data;

  // Avg monthly (over months with any revenue)
  const months        = getMonthKeys();
  const monthsWithRev = months.filter(m => {
    const hasPay = payments.some(p => p.date?.slice(0, 7) === m.key);
    const hasInv = invoices.some(i => (i.issueDate || '').slice(0, 7) === m.key);
    return hasPay || hasInv;
  });
  const avgMonthly    = monthsWithRev.length ? total / monthsWithRev.length : 0;

  // KPI row
  const kpiRow = el('div', { class: 'grid grid-4 mb-16' });
  kpiRow.appendChild(kpiCard(
    'Total Revenue', formatEUR(total), '',
    () => drillDownModal('All Revenue', drillRevRows(payments, invoices), REV_COLS)
  ));
  kpiRow.appendChild(kpiCard(
    'Rental Revenue', formatEUR(propRev), '',
    () => drillDownModal('Rental Revenue', drillRevRows(payments, []), REV_COLS)
  ));
  kpiRow.appendChild(kpiCard(
    'Service Revenue', formatEUR(svcRev), '',
    () => drillDownModal('Service Revenue', drillRevRows([], invoices), REV_COLS)
  ));
  kpiRow.appendChild(kpiCard(
    'Average Monthly Revenue', formatEUR(avgMonthly),
    monthsWithRev.length ? `over ${monthsWithRev.length} month(s)` : '',
    () => {
      // Show per-month summary
      const rows = months.map(m => {
        const mPay = payments.filter(p => p.date?.slice(0, 7) === m.key);
        const mInv = invoices.filter(i => (i.issueDate || '').slice(0, 7) === m.key);
        const eur  = mPay.reduce((s, p) => s + toEUR(p.amount, p.currency, p.date), 0)
                   + mInv.reduce((s, i) => s + toEUR(i.total, i.currency, i.issueDate), 0);
        return { month: m.label, transactions: String(mPay.length + mInv.length), eur };
      }).filter(r => r.eur > 0);
      drillDownModal('Revenue by Month', rows, [
        { key: 'month',        label: 'Month' },
        { key: 'transactions', label: 'Count' },
        { key: 'eur',          label: 'EUR', right: true, format: v => formatEUR(v) }
      ]);
    }
  ));
  wrap.appendChild(kpiRow);

  // Inline insights
  const revInsights = computeRevenueInsights(data);
  const revBanner = buildInsightsBanner(revInsights);
  if (revBanner) wrap.appendChild(revBanner);

  // Charts row 1: stacked bar (2/3) + owner donut (1/3)
  const row1 = el('div', { style: 'display:grid;grid-template-columns:2fr 1fr;gap:16px;margin-bottom:16px' });
  row1.appendChild(el('div', { class: 'card' },
    el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'Revenue by Month & Stream')),
    el('div', { class: 'chart-wrap tall' }, el('canvas', { id: 'rev-stream-bar' }))
  ));
  row1.appendChild(el('div', { class: 'card' },
    el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'Revenue by Owner')),
    el('div', { class: 'chart-wrap tall' }, el('canvas', { id: 'rev-owner-donut' }))
  ));
  wrap.appendChild(row1);

  // Charts row 2: property hbar + client hbar
  const row2 = el('div', { class: 'grid grid-2 mb-16' });
  row2.appendChild(el('div', { class: 'card' },
    el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'Revenue by Property')),
    el('div', { class: 'chart-wrap tall' }, el('canvas', { id: 'rev-prop-bar' }))
  ));
  row2.appendChild(el('div', { class: 'card' },
    el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'Revenue by Client')),
    el('div', { class: 'chart-wrap tall' }, el('canvas', { id: 'rev-client-bar' }))
  ));
  wrap.appendChild(row2);

  // Revenue table — collapsed by default
  const tableCard  = el('div', { class: 'card' });
  const tableBody  = el('div', { style: 'display:none' });
  const toggleBtn  = el('button', {
    style: 'background:none;border:none;color:var(--accent);font-size:13px;cursor:pointer;padding:0'
  }, 'Show Revenue Records');
  toggleBtn.onclick = () => {
    const collapsed = tableBody.style.display === 'none';
    tableBody.style.display = collapsed ? '' : 'none';
    toggleBtn.textContent   = collapsed ? 'Hide Revenue Records' : 'Show Revenue Records';
  };
  tableCard.appendChild(el('div', { class: 'card-header', style: 'display:flex;align-items:center;justify-content:space-between' },
    el('div', { class: 'card-title' }, 'Revenue Records'),
    toggleBtn
  ));
  buildRevenueTable(tableBody, data);
  tableCard.appendChild(tableBody);
  wrap.appendChild(tableCard);

  // Render all charts after view enters live DOM
  setTimeout(() => {
    renderStreamBar(data);
    renderOwnerDonut(data);
    renderPropBar(data);
    renderClientBar(data);
  }, 0);

  return wrap;
}

// ── Chart 1: Stacked bar — Month × Stream ────────────────────────────────────
function renderStreamBar({ payments, invoices }) {
  const months = getMonthKeys();
  if (!months.length) return;

  // Build map: streamKey → Map(monthKey → eur)
  const streamMonthMap = new Map();
  const addToMap = (sk, mk, eur) => {
    if (!streamMonthMap.has(sk)) streamMonthMap.set(sk, new Map());
    const m = streamMonthMap.get(sk);
    m.set(mk, (m.get(mk) || 0) + eur);
  };
  payments.forEach(p => {
    const mk = p.date?.slice(0, 7);
    if (mk) addToMap(p.stream || 'other', mk, toEUR(p.amount, p.currency, p.date));
  });
  invoices.forEach(i => {
    const mk = (i.issueDate || '').slice(0, 7);
    if (mk) addToMap(i.stream || 'other', mk, toEUR(i.total, i.currency, i.issueDate));
  });

  if (!streamMonthMap.size) return;

  // Preserve STREAMS order, then any extra keys
  const orderedKeys = [
    ...Object.keys(STREAMS).filter(k => streamMonthMap.has(k)),
    ...[...streamMonthMap.keys()].filter(k => !STREAMS[k])
  ];

  charts.bar('rev-stream-bar', {
    labels: months.map(m => m.label),
    datasets: orderedKeys.map(sk => ({
      label:           STREAMS[sk]?.label || sk,
      data:            months.map(m => Math.round(streamMonthMap.get(sk)?.get(m.key) || 0)),
      backgroundColor: STREAMS[sk]?.color || '#8b93b0'
    })),
    stacked: true,
    onClickItem: (label, idx, dsIdx) => {
      const mk = months[idx]?.key;
      if (!mk) return;
      const sk   = orderedKeys[dsIdx];
      const mPay = payments.filter(p => p.date?.slice(0, 7) === mk && (p.stream || 'other') === sk);
      const mInv = invoices.filter(i => (i.issueDate || '').slice(0, 7) === mk && (i.stream || 'other') === sk);
      drillDownModal(
        `${label} — ${STREAMS[sk]?.label || sk}`,
        drillRevRows(mPay, mInv),
        REV_COLS
      );
    }
  });
}

// ── Chart 2: Donut — Owner split ──────────────────────────────────────────────
function renderOwnerDonut({ payments, invoices }) {
  const ownerMap = new Map();
  payments.forEach(p => {
    const owner = byId('properties', p.propertyId)?.owner || 'both';
    ownerMap.set(owner, (ownerMap.get(owner) || 0) + toEUR(p.amount, p.currency, p.date));
  });
  invoices.forEach(i => {
    const owner = i.owner || 'both';
    ownerMap.set(owner, (ownerMap.get(owner) || 0) + toEUR(i.total, i.currency, i.issueDate));
  });

  const keys = Object.keys(OWNERS).filter(k => (ownerMap.get(k) || 0) > 0);
  if (!keys.length) return;

  charts.doughnut('rev-owner-donut', {
    labels: keys.map(k => OWNERS[k]),
    data:   keys.map(k => Math.round(ownerMap.get(k) || 0)),
    colors: keys.map(k => OWNER_COLORS[k] || '#8b93b0'),
    onClickItem: (_label, idx) => {
      const ok   = keys[idx];
      const oPay = payments.filter(p => (byId('properties', p.propertyId)?.owner || 'both') === ok);
      const oInv = invoices.filter(i => (i.owner || 'both') === ok);
      drillDownModal(`Revenue — ${OWNERS[ok]}`, drillRevRows(oPay, oInv), REV_COLS);
    }
  });
}

// ── Chart 3: Horizontal bar — Property revenue ────────────────────────────────
function renderPropBar({ payments }) {
  const map = new Map();
  payments.forEach(p => {
    const name = byId('properties', p.propertyId)?.name || 'Unknown';
    const cur  = map.get(name) || { eur: 0, id: p.propertyId };
    map.set(name, { eur: cur.eur + toEUR(p.amount, p.currency, p.date), id: p.propertyId });
  });

  const sorted = [...map.entries()].sort((a, b) => b[1].eur - a[1].eur);
  if (!sorted.length) return;

  charts.bar('rev-prop-bar', {
    labels: sorted.map(([name]) => name),
    datasets: [{
      label:           'Revenue (EUR)',
      data:            sorted.map(([, m]) => Math.round(m.eur)),
      backgroundColor: sorted.map((_, i) => `hsla(${(200 + i * 30) % 360}, 65%, 55%, 0.85)`)
    }],
    horizontal: true,
    onClickItem: (_label, idx) => {
      const { id } = sorted[idx][1];
      drillDownModal(
        `Revenue — ${sorted[idx][0]}`,
        drillRevRows(payments.filter(p => p.propertyId === id), []),
        REV_COLS
      );
    }
  });
}

// ── Chart 4: Horizontal bar — Client revenue ──────────────────────────────────
function renderClientBar({ invoices }) {
  const map = new Map();
  invoices.forEach(i => {
    const name = byId('clients', i.clientId)?.name || 'Unknown';
    const cur  = map.get(name) || { eur: 0, id: i.clientId };
    map.set(name, { eur: cur.eur + toEUR(i.total, i.currency, i.issueDate), id: i.clientId });
  });

  const sorted = [...map.entries()].sort((a, b) => b[1].eur - a[1].eur);
  if (!sorted.length) return;

  charts.bar('rev-client-bar', {
    labels: sorted.map(([name]) => name),
    datasets: [{
      label:           'Revenue (EUR)',
      data:            sorted.map(([, m]) => Math.round(m.eur)),
      backgroundColor: sorted.map((_, i) => `hsla(${(160 + i * 35) % 360}, 65%, 55%, 0.85)`)
    }],
    horizontal: true,
    onClickItem: (_label, idx) => {
      const { id } = sorted[idx][1];
      drillDownModal(
        `Revenue — ${sorted[idx][0]}`,
        drillRevRows([], invoices.filter(i => i.clientId === id)),
        REV_COLS
      );
    }
  });
}

// ── Revenue table ─────────────────────────────────────────────────────────────
// Columns: date, stream, entity, owner, status, amountEUR
const TX_COLS = [
  { key: 'date',      label: 'Date'       },
  { key: 'stream',    label: 'Stream'     },
  { key: 'entity',    label: 'Entity'     },
  { key: 'owner',     label: 'Owner'      },
  { key: 'status',    label: 'Status'     },
  { key: 'amountEUR', label: 'Amount EUR', right: true }
];

function buildRevenueTable(container, { payments, invoices }) {
  const rows = [];

  for (const p of payments) {
    const prop = byId('properties', p.propertyId);
    rows.push({
      _date:     p.date,
      _eur:      toEUR(p.amount, p.currency, p.date),
      date:      fmtDate(p.date),
      stream:    STREAMS[p.stream]?.short || p.stream || '—',
      entity:    prop?.name || '—',
      owner:     OWNERS[prop?.owner] || prop?.owner || '—',
      status:    p.status || '—',
      amountEUR: formatEUR(toEUR(p.amount, p.currency, p.date))
    });
  }
  for (const i of invoices) {
    const client = byId('clients', i.clientId);
    rows.push({
      _date:     i.issueDate,
      _eur:      toEUR(i.total, i.currency, i.issueDate),
      date:      fmtDate(i.issueDate),
      stream:    STREAMS[i.stream]?.short || i.stream || '—',
      entity:    client?.name || '—',
      owner:     OWNERS[client?.owner] || client?.owner || '—',
      status:    i.status || '—',
      amountEUR: formatEUR(toEUR(i.total, i.currency, i.issueDate))
    });
  }

  rows.sort((a, b) => (b._date || '').localeCompare(a._date || ''));

  const table = el('table', { class: 'table' });
  const htr   = el('tr');
  TX_COLS.forEach(col => htr.appendChild(el('th', { class: col.right ? 'right' : '' }, col.label)));
  table.appendChild(el('thead', {}, htr));

  const tbody = el('tbody');
  for (const r of rows) {
    const tr = el('tr');
    TX_COLS.forEach(col => {
      tr.appendChild(el('td', { class: col.right ? 'right num' : '' }, r[col.key] ?? '—'));
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
