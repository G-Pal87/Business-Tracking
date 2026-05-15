// Revenue Analytics Dashboard — actual revenue performance
import { el, select, fmtDate, drillDownModal, attachSortFilter } from '../core/ui.js';
import * as charts from '../core/charts.js';
import { STREAMS, OWNERS, PROPERTY_STREAMS, SERVICE_STREAMS } from '../core/config.js';
import {
  availableYears, formatEUR, toEUR, byId,
  listActive, listActivePayments, listActiveClients,
  drillRevRows
} from '../core/data.js';

// ── Filter state ──────────────────────────────────────────────────────────────
let gFilters = {
  year:        String(new Date().getFullYear()),
  months:      new Set(),
  streams:     new Set(),
  owners:      new Set(),
  propertyIds: new Set(),
  clientIds:   new Set()
};

const MONTH_LABELS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const CHART_IDS    = [
  'rev-stream-bar', 'rev-prop-bar', 'rev-client-bar', 'rev-owner-donut',
  'rev-trend', 'rev-growth', 'rev-paid-vs-outstanding', 'rev-aging'
];
const OWNER_COLORS = { you: '#6366f1', rita: '#ec4899', both: '#14b8a6' };
const STR_KEY      = 'short_term_rental';
const LTR_KEY      = 'long_term_rental';

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
    : (byId('clients', clientId)?.owner  || 'both');
  return owner === 'both' || gFilters.owners.has(owner);
}
function matchProperty(row) {
  return gFilters.propertyIds.size === 0 || !row.propertyId || gFilters.propertyIds.has(row.propertyId);
}
function matchClient(row) {
  return gFilters.clientIds.size === 0 || !row.clientId || gFilters.clientIds.has(row.clientId);
}

// ── Data ──────────────────────────────────────────────────────────────────────
function getData() {
  const payments = listActivePayments().filter(p =>
    p.status === 'paid' && matchDate(p) && matchStream(p) && matchOwner(p) && matchProperty(p)
  );
  const invoices = listActive('invoices').filter(i =>
    i.status === 'paid' &&
    matchDate({ date: i.issueDate }) &&
    matchStream(i) && matchOwner(i) && matchClient(i)
  );
  const outstandingInvoices = listActive('invoices').filter(i => {
    if (['paid', 'void', 'cancelled'].includes(i.status)) return false;
    return matchDate({ date: i.issueDate }) &&
           matchStream(i) && matchOwner(i) && matchClient(i);
  });

  const propRev = payments.reduce((s, p) => s + toEUR(p.amount, p.currency, p.date), 0);
  const svcRev  = invoices.reduce((s, i) => s + toEUR(i.total, i.currency, i.issueDate), 0);
  const total   = propRev + svcRev;

  const strPropIds = new Set();
  const ltrPropIds = new Set();
  let strRev = 0, ltrRev = 0;
  payments.forEach(p => {
    const eur = toEUR(p.amount, p.currency, p.date);
    if (p.stream === STR_KEY) { strRev += eur; if (p.propertyId) strPropIds.add(p.propertyId); }
    else if (p.stream === LTR_KEY) { ltrRev += eur; if (p.propertyId) ltrPropIds.add(p.propertyId); }
  });

  const outstandingEUR = outstandingInvoices.reduce((s, i) => s + toEUR(i.total, i.currency, i.issueDate), 0);
  const collectionBase = svcRev + outstandingEUR;
  const collectionRate = collectionBase > 0 ? svcRev / collectionBase : null;

  let prevTotal = null, prevPayments = [], prevInvoices = [];
  if (gFilters.year !== 'all') {
    const prevYear = String(Number(gFilters.year) - 1);
    prevPayments = listActivePayments().filter(p => {
      const d = p.date || '';
      if (!d.startsWith(prevYear)) return false;
      if (gFilters.months.size > 0 && !gFilters.months.has(d.slice(5, 7))) return false;
      return p.status === 'paid' && matchStream(p) && matchOwner(p) && matchProperty(p);
    });
    prevInvoices = listActive('invoices').filter(i => {
      const d = i.issueDate || '';
      if (!d.startsWith(prevYear)) return false;
      if (gFilters.months.size > 0 && !gFilters.months.has(d.slice(5, 7))) return false;
      return i.status === 'paid' && matchStream(i) && matchOwner(i) && matchClient(i);
    });
    prevTotal = prevPayments.reduce((s, p) => s + toEUR(p.amount, p.currency, p.date), 0) +
                prevInvoices.reduce((s, i) => s + toEUR(i.total, i.currency, i.issueDate), 0);
  }

  // All-time data for seasonality heatmap — year/month filters excluded intentionally
  const heatmapPayments = listActivePayments().filter(p =>
    p.status === 'paid' && matchStream(p) && matchOwner(p) && matchProperty(p)
  );
  const heatmapInvoices = listActive('invoices').filter(i =>
    i.status === 'paid' && matchStream(i) && matchOwner(i) && matchClient(i)
  );

  return {
    payments, invoices, outstandingInvoices,
    propRev, svcRev, total,
    strRev, ltrRev, strPropIds, ltrPropIds,
    outstandingEUR, collectionRate,
    prevTotal, prevPayments, prevInvoices,
    heatmapPayments, heatmapInvoices
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
function kpiCard({ label, value, variant = '', onClick, breakdown, trend, status, note }) {
  const card = el('div', {
    class: 'kpi' + (variant ? ' ' + variant : ''),
    style: onClick ? 'cursor:pointer;transition:box-shadow 120ms' : '',
    title: onClick ? 'Click for breakdown' : ''
  });
  if (onClick) {
    card.addEventListener('mouseenter', () => { card.style.boxShadow = '0 0 0 2px var(--accent)'; });
    card.addEventListener('mouseleave', () => { card.style.boxShadow = ''; });
    card.onclick = onClick;
  }
  card.appendChild(el('div', { class: 'kpi-label' }, label));
  card.appendChild(el('div', { class: 'kpi-value' }, String(value ?? '—')));
  if (trend && !trend.hide) {
    const color = trend.up ? 'var(--success)' : 'var(--danger)';
    const arrow = trend.up ? '▲' : '▼';
    card.appendChild(el('div', {
      class: 'kpi-trend',
      style: `color:${color};font-size:12px;margin-top:4px`
    }, `${arrow} ${trend.pct}${trend.label ? ' vs ' + trend.label : ''}`));
  }
  if (status) {
    card.appendChild(el('div', { style: 'margin-top:6px' },
      el('span', { class: `badge ${status.variant}` }, status.label)
    ));
  }
  if (breakdown?.length) {
    const bWrap = el('div', { style: 'margin-top:6px;font-size:11px;color:var(--text-muted);line-height:1.6' });
    breakdown.forEach(({ label: bl, value: bv }) => {
      bWrap.appendChild(el('div', { style: 'display:flex;justify-content:space-between;gap:8px' },
        el('span', {}, bl),
        el('span', { class: 'num' }, bv)
      ));
    });
    card.appendChild(bWrap);
  }
  if (note) {
    card.appendChild(el('div', { style: 'margin-top:4px;font-size:11px;color:var(--text-muted)' }, note));
  }
  card.appendChild(el('div', { class: 'kpi-accent-bar' }));
  return card;
}

// ── REV_COLS (for drill-down modals) ─────────────────────────────────────────
const REV_COLS = [
  { key: 'date',   label: 'Date',   format: v => fmtDate(v) },
  { key: 'type',   label: 'Type'   },
  { key: 'source', label: 'Entity' },
  { key: 'ref',    label: 'Ref'    },
  { key: 'eur',    label: 'EUR',    right: true, format: v => formatEUR(v) }
];

// ── TX_COLS (for main Revenue Records table) ──────────────────────────────────
const TX_COLS = [
  { key: 'type',      label: 'Type'       },
  { key: 'date',      label: 'Date'       },
  { key: 'stream',    label: 'Stream'     },
  { key: 'entity',    label: 'Entity'     },
  { key: 'owner',     label: 'Owner'      },
  { key: 'status',    label: 'Status'     },
  { key: 'amountEUR', label: 'Amount EUR', right: true }
];

// ── Month key helpers ─────────────────────────────────────────────────────────
function getMonthKeys() {
  const year = gFilters.year !== 'all' ? gFilters.year : String(new Date().getFullYear());
  return MONTH_LABELS.map((label, i) => {
    const mm = String(i + 1).padStart(2, '0');
    return { label, key: `${year}-${mm}`, mm };
  }).filter(m => gFilters.months.size === 0 || gFilters.months.has(m.mm));
}

// ── Insights ──────────────────────────────────────────────────────────────────
function computeRevenueInsights(data) {
  const { payments, invoices, propRev, svcRev, total,
          outstandingEUR, collectionRate, strRev, ltrRev } = data;
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
    const lbl   = STREAMS[topStream[0]]?.label || topStream[0];
    items.push({ level: 'warning', text: `"${lbl}" drives ${pct}% of revenue — high stream concentration. Consider growing other revenue streams.` });
  }

  // Collection rate
  if (collectionRate !== null && collectionRate < 0.80) {
    const pct = Math.round(collectionRate * 100);
    items.push({ level: 'danger', text: `Invoice collection rate is ${pct}% — ${formatEUR(outstandingEUR)} outstanding. Review overdue invoices below.` });
  } else if (collectionRate !== null && collectionRate < 0.90) {
    const pct = Math.round(collectionRate * 100);
    items.push({ level: 'warning', text: `Collection rate is ${pct}%. Follow up on ${formatEUR(outstandingEUR)} in outstanding invoices.` });
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
    items.push({ level: 'warning', text: `"${topProp[0]}" generates ${pct}% of property revenue — single-property dependency. Review capacity in other units.` });
  }

  // Rental mix commentary
  const rentalTotal = strRev + ltrRev;
  if (rentalTotal > 0) {
    const strPct = strRev / rentalTotal;
    if (strPct > 0.90) {
      items.push({ level: 'info', text: `Rental revenue is ${Math.round(strPct * 100)}% STR. LTR provides more predictable income — consider adding long-term tenants.` });
    } else if (strPct < 0.10 && ltrRev > 0) {
      items.push({ level: 'info', text: `Rental revenue is almost entirely LTR. STR units could improve yield during peak season.` });
    }
  }

  return items;
}

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

// ── KPI section (9 cards) ─────────────────────────────────────────────────────
function buildKpiSection(data) {
  const {
    payments, invoices, outstandingInvoices,
    propRev, svcRev, total,
    strRev, ltrRev, strPropIds, ltrPropIds,
    outstandingEUR, collectionRate, prevTotal
  } = data;

  // Growth KPI
  let growthValue = '—', growthTrend = null, growthNote = null;
  if (gFilters.year === 'all') {
    growthNote = 'Select a year to compare';
  } else if (prevTotal !== null) {
    const prevLabel = String(Number(gFilters.year) - 1);
    if (prevTotal === 0 && total === 0) {
      growthNote = 'No data for prior year';
    } else if (prevTotal === 0 && total > 0) {
      growthValue = 'New';
      growthTrend = { up: true, pct: 'New revenue', label: prevLabel, hide: false };
    } else if (prevTotal > 0) {
      const g    = (total - prevTotal) / prevTotal * 100;
      const sign = g >= 0 ? '+' : '';
      growthValue = `${sign}${g.toFixed(1)}%`;
      growthTrend = { up: g >= 0, pct: growthValue, label: prevLabel, hide: false };
    }
  }

  // Top Contributor — compare top property vs top client, use whichever is larger
  const propMap = new Map();
  payments.forEach(p => {
    const name = byId('properties', p.propertyId)?.name || 'Unknown';
    propMap.set(name, (propMap.get(name) || 0) + toEUR(p.amount, p.currency, p.date));
  });
  const clientMap = new Map();
  invoices.forEach(i => {
    const name = byId('clients', i.clientId)?.name || 'Unknown';
    clientMap.set(name, (clientMap.get(name) || 0) + toEUR(i.total, i.currency, i.issueDate));
  });
  const topProps   = [...propMap.entries()].sort((a, b) => b[1] - a[1]);
  const topClients = [...clientMap.entries()].sort((a, b) => b[1] - a[1]);
  const useProps   = (topProps[0]?.[1] || 0) >= (topClients[0]?.[1] || 0);
  const topList    = useProps ? topProps : topClients;
  const topName    = topList[0]?.[0] || '—';
  const top3       = topList.slice(0, 3);

  // Revenue Concentration
  const topContribEUR = topList[0]?.[1] || 0;
  const concPct       = total > 0 ? topContribEUR / total * 100 : 0;
  const concStatus    = concPct < 50
    ? { label: 'Healthy', variant: 'success' }
    : concPct < 75
    ? { label: 'Watch',   variant: 'warning' }
    : { label: 'Risk',    variant: 'danger'  };

  // Avg Rental / Property
  const allRentalPropIds = new Set([...strPropIds, ...ltrPropIds]);
  const totalRentalProps = allRentalPropIds.size;
  const avgSTR = strPropIds.size > 0 ? strRev / strPropIds.size : null;
  const avgLTR = ltrPropIds.size > 0 ? ltrRev / ltrPropIds.size : null;
  const avgRentalValue = totalRentalProps > 0
    ? formatEUR((strRev + ltrRev) / totalRentalProps)
    : '—';
  const avgRentalBreakdown = [];
  if (avgSTR !== null) avgRentalBreakdown.push({
    label: `STR avg (${strPropIds.size} prop${strPropIds.size !== 1 ? 's' : ''})`,
    value: formatEUR(avgSTR)
  });
  if (avgLTR !== null) avgRentalBreakdown.push({
    label: `LTR avg (${ltrPropIds.size} prop${ltrPropIds.size !== 1 ? 's' : ''})`,
    value: formatEUR(avgLTR)
  });

  const outstandingDrillCols = [
    { key: 'client', label: 'Client'  },
    { key: 'date',   label: 'Date'    },
    { key: 'status', label: 'Status'  },
    { key: 'eur',    label: 'EUR', right: true, format: v => formatEUR(v) }
  ];
  const outstandingDrillRows = () => outstandingInvoices.map(i => ({
    client: byId('clients', i.clientId)?.name || '—',
    date:   fmtDate(i.issueDate),
    status: i.status || '—',
    eur:    toEUR(i.total, i.currency, i.issueDate)
  }));

  // Row 1: 4 KPIs
  const row1 = el('div', { class: 'grid grid-4 mb-16' });

  row1.appendChild(kpiCard({
    label: 'Total Revenue',
    value: formatEUR(total),
    onClick: () => drillDownModal('All Revenue', drillRevRows(payments, invoices), REV_COLS)
  }));

  const propBreakdown = [];
  if (strRev > 0) propBreakdown.push({ label: 'STR',   value: formatEUR(strRev) });
  if (ltrRev > 0) propBreakdown.push({ label: 'LTR',   value: formatEUR(ltrRev) });
  const otherRentalRev = propRev - strRev - ltrRev;
  if (otherRentalRev > 0.01) propBreakdown.push({ label: 'Other rentals', value: formatEUR(otherRentalRev) });

  row1.appendChild(kpiCard({
    label:     'Property Revenue',
    value:     formatEUR(propRev),
    breakdown: propBreakdown,
    onClick:   () => drillDownModal('Property Revenue', drillRevRows(payments, []), REV_COLS)
  }));

  row1.appendChild(kpiCard({
    label:   'Service Revenue',
    value:   formatEUR(svcRev),
    onClick: () => drillDownModal('Service Revenue', drillRevRows([], invoices), REV_COLS)
  }));

  row1.appendChild(kpiCard({
    label: 'Revenue Growth',
    value: growthValue,
    trend: growthTrend || { hide: true },
    note:  growthNote
  }));

  // Row 2: 5 KPIs
  const row2 = el('div', {
    style: 'display:grid;grid-template-columns:repeat(5,1fr);gap:16px;margin-bottom:16px'
  });

  row2.appendChild(kpiCard({
    label:     'Top Contributor',
    value:     topName,
    breakdown: top3.map(([name, eur]) => ({ label: name, value: formatEUR(eur) })),
    onClick:   topList.length ? () => {
      drillDownModal(useProps ? 'Revenue by Property' : 'Revenue by Client',
        topList.map(([name, eur]) => ({ name, eur })),
        [
          { key: 'name', label: useProps ? 'Property' : 'Client' },
          { key: 'eur',  label: 'Revenue (EUR)', right: true, format: v => formatEUR(v) }
        ]
      );
    } : null
  }));

  row2.appendChild(kpiCard({
    label:  'Revenue Concentration',
    value:  total > 0 ? `${concPct.toFixed(1)}%` : '—',
    status: total > 0 ? concStatus : null,
    note:   total > 0 ? `Top: ${topName}` : null
  }));

  row2.appendChild(kpiCard({
    label:   'Collection Rate',
    value:   collectionRate !== null ? `${Math.round(collectionRate * 100)}%` : 'N/A',
    variant: collectionRate !== null
      ? (collectionRate >= 0.9 ? 'success' : collectionRate >= 0.75 ? 'warning' : 'danger')
      : '',
    note:    'Service invoices only',
    onClick: outstandingInvoices.length
      ? () => drillDownModal('Outstanding Invoices', outstandingDrillRows(), outstandingDrillCols)
      : null
  }));

  row2.appendChild(kpiCard({
    label:   'Outstanding Revenue',
    value:   formatEUR(outstandingEUR),
    variant: outstandingEUR > 0 ? 'warning' : '',
    note:    `${outstandingInvoices.length} invoice(s) — service only`,
    onClick: outstandingInvoices.length
      ? () => drillDownModal('Outstanding Invoices', outstandingDrillRows(), outstandingDrillCols)
      : null
  }));

  row2.appendChild(kpiCard({
    label:     'Avg Rental / Property',
    value:     avgRentalValue,
    breakdown: avgRentalBreakdown,
    note:      totalRentalProps > 0
      ? `${totalRentalProps} rental propert${totalRentalProps !== 1 ? 'ies' : 'y'}`
      : 'No rental data'
  }));

  const wrap = el('div', {});
  wrap.appendChild(row1);
  wrap.appendChild(row2);
  return wrap;
}

// ── Revenue Trend section ─────────────────────────────────────────────────────
function buildTrendSection() {
  return el('div', { class: 'card mb-16' },
    el('div', { class: 'card-header' },
      el('div', { class: 'card-title' }, 'Revenue Trend')
    ),
    el('div', { class: 'chart-wrap tall' }, el('canvas', { id: 'rev-trend' }))
  );
}

// ── Revenue Mix & Growth section ──────────────────────────────────────────────
function buildMixGrowthSection() {
  const row = el('div', { class: 'grid grid-2 mb-16' });
  row.appendChild(el('div', { class: 'card' },
    el('div', { class: 'card-header' },
      el('div', { class: 'card-title' }, 'Revenue Mix by Month')
    ),
    el('div', { class: 'chart-wrap tall' }, el('canvas', { id: 'rev-stream-bar' }))
  ));
  row.appendChild(el('div', { class: 'card' },
    el('div', { class: 'card-header' },
      el('div', { class: 'card-title' }, 'Month-over-Month Growth %')
    ),
    el('div', { class: 'chart-wrap tall' }, el('canvas', { id: 'rev-growth' }))
  ));
  return row;
}

// ── Contributor Analysis section ──────────────────────────────────────────────
function buildContributorSection() {
  const row = el('div', { class: 'grid grid-2 mb-16' });
  row.appendChild(el('div', { class: 'card' },
    el('div', { class: 'card-header' },
      el('div', { class: 'card-title' }, 'Revenue by Property (Rentals)')
    ),
    el('div', { class: 'chart-wrap tall' }, el('canvas', { id: 'rev-prop-bar' }))
  ));
  row.appendChild(el('div', { class: 'card' },
    el('div', { class: 'card-header' },
      el('div', { class: 'card-title' }, 'Revenue by Client (Services)')
    ),
    el('div', { class: 'chart-wrap tall' }, el('canvas', { id: 'rev-client-bar' }))
  ));
  return row;
}

// ── Invoice Collection section ────────────────────────────────────────────────
function buildCollectionSection() {
  const row = el('div', { class: 'grid grid-2 mb-16' });
  row.appendChild(el('div', { class: 'card' },
    el('div', { class: 'card-header' },
      el('div', { class: 'card-title' }, 'Paid vs Outstanding by Month')
    ),
    el('div', { class: 'chart-wrap tall' }, el('canvas', { id: 'rev-paid-vs-outstanding' }))
  ));
  row.appendChild(el('div', { class: 'card' },
    el('div', { class: 'card-header' },
      el('div', { class: 'card-title' }, 'Invoice Aging')
    ),
    el('div', { class: 'chart-wrap tall' }, el('canvas', { id: 'rev-aging' }))
  ));
  return row;
}

// ── Owner split section ───────────────────────────────────────────────────────
function buildOwnerSection() {
  return el('div', { class: 'card mb-16' },
    el('div', { class: 'card-header' },
      el('div', { class: 'card-title' }, 'Revenue by Owner')
    ),
    el('div', { class: 'chart-wrap' }, el('canvas', { id: 'rev-owner-donut' }))
  );
}

// ── Seasonality heatmap section ───────────────────────────────────────────────
function buildSeasonalitySection(data) {
  const card = el('div', { class: 'card mb-16' },
    el('div', { class: 'card-header' },
      el('div', { class: 'card-title' }, 'Revenue Seasonality (All Years)')
    )
  );
  card.appendChild(buildHeatmapGrid(data));
  return card;
}

function buildHeatmapGrid({ heatmapPayments, heatmapInvoices }) {
  const yearSet = new Set();
  heatmapPayments.forEach(p => { const y = (p.date || '').slice(0, 4); if (y.length === 4) yearSet.add(y); });
  heatmapInvoices.forEach(i => { const y = (i.issueDate || '').slice(0, 4); if (y.length === 4) yearSet.add(y); });

  if (!yearSet.size) {
    return el('div', { style: 'padding:16px;font-size:13px;color:var(--text-muted)' }, 'No data available.');
  }

  const years = [...yearSet].sort();
  const map   = new Map();
  heatmapPayments.forEach(p => {
    const mk = (p.date || '').slice(0, 7);
    if (mk.length === 7) map.set(mk, (map.get(mk) || 0) + toEUR(p.amount, p.currency, p.date));
  });
  heatmapInvoices.forEach(i => {
    const mk = (i.issueDate || '').slice(0, 7);
    if (mk.length === 7) map.set(mk, (map.get(mk) || 0) + toEUR(i.total, i.currency, i.issueDate));
  });

  const maxVal = Math.max(...[...map.values()], 1);

  const grid = el('div', {
    style: 'display:grid;grid-template-columns:52px repeat(12,1fr);gap:2px;padding:16px;overflow-x:auto'
  });

  // Header
  grid.appendChild(el('div', {}));
  MONTH_LABELS.forEach(m => {
    grid.appendChild(el('div', {
      style: 'text-align:center;font-size:11px;color:var(--text-muted);padding:4px 2px'
    }, m));
  });

  // Year rows
  years.forEach(year => {
    grid.appendChild(el('div', {
      style: 'display:flex;align-items:center;font-size:11px;color:var(--text-muted);padding-right:6px'
    }, year));

    MONTH_LABELS.forEach((_, mi) => {
      const mm  = String(mi + 1).padStart(2, '0');
      const key = `${year}-${mm}`;
      const eur = map.get(key) || 0;
      const bg  = eur > 0
        ? `rgba(99,102,241,${(0.15 + (eur / maxVal) * 0.75).toFixed(2)})`
        : 'rgba(255,255,255,0.03)';

      const cell = el('div', {
        style: `background:${bg};border-radius:3px;min-height:28px;display:flex;align-items:center;justify-content:center;cursor:${eur > 0 ? 'pointer' : 'default'}`,
        title: eur > 0 ? `${MONTH_LABELS[mi]} ${year}: ${formatEUR(eur)}` : ''
      });

      if (eur > 0) {
        cell.appendChild(el('span', { style: 'font-size:10px;color:rgba(255,255,255,0.9)' },
          eur >= 10000 ? `${Math.round(eur / 1000)}k` : String(Math.round(eur))
        ));
        cell.onclick = () => {
          const mPay = heatmapPayments.filter(p => (p.date || '').slice(0, 7) === key);
          const mInv = heatmapInvoices.filter(i => (i.issueDate || '').slice(0, 7) === key);
          drillDownModal(`Revenue — ${MONTH_LABELS[mi]} ${year}`, drillRevRows(mPay, mInv), REV_COLS);
        };
      }
      grid.appendChild(cell);
    });
  });

  return grid;
}

// ── Revenue Records section (collapsible) ─────────────────────────────────────
function buildRecordsSection(data) {
  const card      = el('div', { class: 'card' });
  const body      = el('div', { style: 'display:none' });
  let   expanded  = false;
  let   populated = false;

  const toggleBtn = el('button', { class: 'btn btn-sm' }, 'Show Records');
  toggleBtn.onclick = () => {
    expanded = !expanded;
    body.style.display = expanded ? '' : 'none';
    toggleBtn.textContent = expanded ? 'Hide Records' : 'Show Records';
    if (expanded && !populated) {
      buildRevenueTable(body, data);
      populated = true;
    }
  };

  card.appendChild(el('div', { class: 'card-header' },
    el('div', { class: 'card-title' }, 'Revenue Records'),
    toggleBtn
  ));
  card.appendChild(body);
  return card;
}

// ── Main view ─────────────────────────────────────────────────────────────────
function buildView() {
  const wrap = el('div', { class: 'view active' });

  // Header
  wrap.appendChild(el('div', { style: 'margin-bottom:16px' },
    el('h2', { style: 'margin:0 0 4px;font-size:20px;font-weight:700' }, 'Revenue Analytics'),
    el('p',  { style: 'margin:0;font-size:13px;color:var(--text-muted)' },
      'Actual revenue performance — sources, trends, collection and seasonality')
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

  // 1. KPI cards
  wrap.appendChild(buildKpiSection(data));

  // 2. Insights
  const insights = computeRevenueInsights(data);
  const banner   = buildInsightsBanner(insights);
  if (banner) wrap.appendChild(banner);

  // 3. Revenue Trend
  wrap.appendChild(buildTrendSection());

  // 4. Revenue Mix & Growth
  wrap.appendChild(buildMixGrowthSection());

  // 5. Contributor Analysis
  wrap.appendChild(buildContributorSection());

  // 6. Invoice Collection
  wrap.appendChild(buildCollectionSection());

  // 7. Owner split
  wrap.appendChild(buildOwnerSection());

  // 8. Seasonality heatmap
  wrap.appendChild(buildSeasonalitySection(data));

  // 9. Revenue Records (collapsible)
  wrap.appendChild(buildRecordsSection(data));

  // Render all charts after DOM is live
  setTimeout(() => {
    renderTrendLine(data);
    renderStreamBar(data);
    renderGrowthLine(data);
    renderPropBar(data);
    renderClientBar(data);
    renderCollectionBar(data);
    renderAgingBar(data);
    renderOwnerDonut(data);
  }, 0);

  return wrap;
}

// ── Chart: Revenue Trend line ─────────────────────────────────────────────────
function renderTrendLine({ payments, invoices }) {
  const months = getMonthKeys();
  if (!months.length) return;

  const vals = months.map(m => {
    const pay = payments.filter(p => (p.date || '').slice(0, 7) === m.key)
      .reduce((s, p) => s + toEUR(p.amount, p.currency, p.date), 0);
    const inv = invoices.filter(i => (i.issueDate || '').slice(0, 7) === m.key)
      .reduce((s, i) => s + toEUR(i.total, i.currency, i.issueDate), 0);
    return Math.round(pay + inv);
  });

  if (!vals.some(v => v > 0)) return;

  charts.line('rev-trend', {
    labels:   months.map(m => m.label),
    datasets: [{
      label:           'Revenue (EUR)',
      data:            vals,
      borderColor:     '#6366f1',
      backgroundColor: 'rgba(99,102,241,0.1)',
      fill:            true
    }],
    onClickItem: (label, idx) => {
      const m    = months[idx];
      if (!m) return;
      const mPay = payments.filter(p => (p.date || '').slice(0, 7) === m.key);
      const mInv = invoices.filter(i => (i.issueDate || '').slice(0, 7) === m.key);
      drillDownModal(`Revenue — ${label}`, drillRevRows(mPay, mInv), REV_COLS);
    }
  });
}

// ── Chart: Revenue Mix stacked bar ────────────────────────────────────────────
function renderStreamBar({ payments, invoices }) {
  const months = getMonthKeys();
  if (!months.length) return;

  const streamMonthMap = new Map();
  const addToMap = (sk, mk, eur) => {
    if (!streamMonthMap.has(sk)) streamMonthMap.set(sk, new Map());
    const m = streamMonthMap.get(sk);
    m.set(mk, (m.get(mk) || 0) + eur);
  };
  payments.forEach(p => {
    const mk = (p.date || '').slice(0, 7);
    if (mk) addToMap(p.stream || 'other', mk, toEUR(p.amount, p.currency, p.date));
  });
  invoices.forEach(i => {
    const mk = (i.issueDate || '').slice(0, 7);
    if (mk) addToMap(i.stream || 'other', mk, toEUR(i.total, i.currency, i.issueDate));
  });

  if (!streamMonthMap.size) return;

  const orderedKeys = [
    ...Object.keys(STREAMS).filter(k => streamMonthMap.has(k)),
    ...[...streamMonthMap.keys()].filter(k => !STREAMS[k])
  ];

  charts.bar('rev-stream-bar', {
    labels:   months.map(m => m.label),
    datasets: orderedKeys.map(sk => ({
      label:           STREAMS[sk]?.label || sk,
      data:            months.map(m => Math.round(streamMonthMap.get(sk)?.get(m.key) || 0)),
      backgroundColor: STREAMS[sk]?.color || '#8b93b0'
    })),
    stacked:     true,
    onClickItem: (label, idx, dsIdx) => {
      const mk   = months[idx]?.key;
      if (!mk) return;
      const sk   = orderedKeys[dsIdx];
      const mPay = payments.filter(p => (p.date || '').slice(0, 7) === mk && (p.stream || 'other') === sk);
      const mInv = invoices.filter(i => (i.issueDate || '').slice(0, 7) === mk && (i.stream || 'other') === sk);
      drillDownModal(`${label} — ${STREAMS[sk]?.label || sk}`, drillRevRows(mPay, mInv), REV_COLS);
    }
  });
}

// ── Chart: Month-over-Month Growth % ─────────────────────────────────────────
function renderGrowthLine({ payments, invoices }) {
  const months = getMonthKeys();
  if (months.length < 2) return;

  const totals = months.map(m => {
    const pay = payments.filter(p => (p.date || '').slice(0, 7) === m.key)
      .reduce((s, p) => s + toEUR(p.amount, p.currency, p.date), 0);
    const inv = invoices.filter(i => (i.issueDate || '').slice(0, 7) === m.key)
      .reduce((s, i) => s + toEUR(i.total, i.currency, i.issueDate), 0);
    return pay + inv;
  });

  const labels = months.slice(1).map(m => m.label);
  const growth = months.slice(1).map((_, i) => {
    const prev = totals[i];
    const curr = totals[i + 1];
    if (prev === 0) return null;
    return parseFloat(((curr - prev) / prev * 100).toFixed(1));
  });

  if (!growth.some(v => v !== null)) return;

  charts.line('rev-growth', {
    labels,
    datasets: [{
      label:           'MoM Growth %',
      data:            growth,
      borderColor:     '#14b8a6',
      backgroundColor: 'rgba(20,184,166,0.08)',
      fill:            true,
      spanGaps:        true
    }],
    onClickItem: null
  });
}

// ── Chart: Property horizontal bar ────────────────────────────────────────────
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
    labels:   sorted.map(([name]) => name),
    datasets: [{
      label:           'Revenue (EUR)',
      data:            sorted.map(([, m]) => Math.round(m.eur)),
      backgroundColor: sorted.map((_, i) => `hsla(${(200 + i * 30) % 360}, 65%, 55%, 0.85)`)
    }],
    horizontal:  true,
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

// ── Chart: Client horizontal bar ──────────────────────────────────────────────
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
    labels:   sorted.map(([name]) => name),
    datasets: [{
      label:           'Revenue (EUR)',
      data:            sorted.map(([, m]) => Math.round(m.eur)),
      backgroundColor: sorted.map((_, i) => `hsla(${(160 + i * 35) % 360}, 65%, 55%, 0.85)`)
    }],
    horizontal:  true,
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

// ── Chart: Paid vs Outstanding stacked bar ────────────────────────────────────
function renderCollectionBar({ invoices, outstandingInvoices }) {
  const months = getMonthKeys();
  if (!months.length) return;

  const paid = months.map(m =>
    Math.round(invoices.filter(i => (i.issueDate || '').slice(0, 7) === m.key)
      .reduce((s, i) => s + toEUR(i.total, i.currency, i.issueDate), 0))
  );
  const outstanding = months.map(m =>
    Math.round(outstandingInvoices.filter(i => (i.issueDate || '').slice(0, 7) === m.key)
      .reduce((s, i) => s + toEUR(i.total, i.currency, i.issueDate), 0))
  );

  if (!paid.some(v => v > 0) && !outstanding.some(v => v > 0)) return;

  charts.bar('rev-paid-vs-outstanding', {
    labels:   months.map(m => m.label),
    datasets: [
      { label: 'Paid',        data: paid,        backgroundColor: 'rgba(16,185,129,0.75)' },
      { label: 'Outstanding', data: outstanding,  backgroundColor: 'rgba(245,158,11,0.75)' }
    ],
    stacked: true
  });
}

// ── Chart: Invoice Aging bar ──────────────────────────────────────────────────
function renderAgingBar({ outstandingInvoices }) {
  if (!outstandingInvoices.length) return;

  const now     = Date.now();
  const BUCKETS = ['0–30 days', '31–60 days', '61–90 days', '>90 days'];
  const amounts = [0, 0, 0, 0];
  const invs    = [[], [], [], []];

  outstandingInvoices.forEach(i => {
    const ref  = i.dueDate || i.issueDate || '';
    const days = ref ? Math.max(0, Math.floor((now - new Date(ref)) / 86400000)) : 0;
    const eur  = toEUR(i.total, i.currency, i.issueDate);
    const bi   = days <= 30 ? 0 : days <= 60 ? 1 : days <= 90 ? 2 : 3;
    amounts[bi] += eur;
    invs[bi].push(i);
  });

  if (!amounts.some(v => v > 0)) return;

  charts.bar('rev-aging', {
    labels:   BUCKETS,
    datasets: [{
      label:           'Outstanding (EUR)',
      data:            amounts.map(v => Math.round(v)),
      backgroundColor: [
        'rgba(16,185,129,0.75)',
        'rgba(245,158,11,0.75)',
        'rgba(239,68,68,0.6)',
        'rgba(239,68,68,0.9)'
      ]
    }],
    onClickItem: (_label, idx) => {
      const rows = invs[idx].map(i => ({
        client: byId('clients', i.clientId)?.name || '—',
        date:   fmtDate(i.issueDate),
        due:    i.dueDate ? fmtDate(i.dueDate) : '—',
        status: i.status || '—',
        eur:    toEUR(i.total, i.currency, i.issueDate)
      }));
      drillDownModal(`Aging: ${BUCKETS[idx]}`, rows, [
        { key: 'client', label: 'Client'     },
        { key: 'date',   label: 'Issued'     },
        { key: 'due',    label: 'Due Date'   },
        { key: 'status', label: 'Status'     },
        { key: 'eur',    label: 'EUR', right: true, format: v => formatEUR(v) }
      ]);
    }
  });
}

// ── Chart: Owner donut ────────────────────────────────────────────────────────
function renderOwnerDonut({ payments, invoices }) {
  const ownerMap = new Map();
  payments.forEach(p => {
    const owner = byId('properties', p.propertyId)?.owner || 'both';
    ownerMap.set(owner, (ownerMap.get(owner) || 0) + toEUR(p.amount, p.currency, p.date));
  });
  invoices.forEach(i => {
    const owner = byId('clients', i.clientId)?.owner || 'both';
    ownerMap.set(owner, (ownerMap.get(owner) || 0) + toEUR(i.total, i.currency, i.issueDate));
  });

  const keys = Object.keys(OWNERS).filter(k => (ownerMap.get(k) || 0) > 0);
  if (!keys.length) return;

  charts.doughnut('rev-owner-donut', {
    labels:      keys.map(k => OWNERS[k]),
    data:        keys.map(k => Math.round(ownerMap.get(k) || 0)),
    colors:      keys.map(k => OWNER_COLORS[k] || '#8b93b0'),
    onClickItem: (_label, idx) => {
      const ok   = keys[idx];
      const oPay = payments.filter(p => (byId('properties', p.propertyId)?.owner || 'both') === ok);
      const oInv = invoices.filter(i => (byId('clients',    i.clientId)?.owner   || 'both') === ok);
      drillDownModal(`Revenue — ${OWNERS[ok]}`, drillRevRows(oPay, oInv), REV_COLS);
    }
  });
}

// ── Revenue Records table ─────────────────────────────────────────────────────
function buildRevenueTable(container, { payments, invoices }) {
  const rows = [];

  for (const p of payments) {
    const prop = byId('properties', p.propertyId);
    rows.push({
      _date:     p.date,
      _eur:      toEUR(p.amount, p.currency, p.date),
      type:      'Payment',
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
      type:      'Invoice',
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
