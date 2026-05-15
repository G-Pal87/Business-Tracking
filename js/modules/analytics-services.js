// Services Analytics Dashboard — track CS + Marketing invoice revenue
import { el, buildMultiSelect, button, fmtDate, drillDownModal, attachSortFilter } from '../core/ui.js';
import * as charts from '../core/charts.js';
import { STREAMS, OWNERS, INVOICE_STATUSES, SERVICE_STREAMS } from '../core/config.js';
import {
  availableYears, formatEUR, toEUR, byId,
  listActive, listActiveClients
} from '../core/data.js';

// ── Filter state ──────────────────────────────────────────────────────────────
let gFilters = {
  years:     new Set([String(new Date().getFullYear())]),
  months:    new Set(),
  clientIds: new Set(),
  streams:   new Set(),
  statuses:  new Set(),
  owners:    new Set()
};

const MONTH_LABELS  = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const CHART_IDS     = ['svc-client-bar', 'svc-month-bar', 'svc-status-donut', 'svc-outstanding-bar'];
const STATUS_COLORS = { draft: '#8b93b0', sent: '#f59e0b', paid: '#10b981', overdue: '#ef4444' };

// ── Module export ─────────────────────────────────────────────────────────────
export default {
  id:    'analytics-services',
  label: 'Services',
  icon:  'S',
  render(container) { container.appendChild(buildView()); },
  refresh() { rebuildView(); },
  destroy() { CHART_IDS.forEach(id => charts.destroy(id)); }
};

// ── Filtering ─────────────────────────────────────────────────────────────────
function matchDate(inv) {
  const d = inv.issueDate || inv.date || '';
  if (gFilters.years.size > 0 && !gFilters.years.has(d.slice(0, 4))) return false;
  if (gFilters.months.size > 0 && !gFilters.months.has(d.slice(5, 7))) return false;
  return true;
}
function matchStream(inv) {
  return gFilters.streams.size === 0 || gFilters.streams.has(inv.stream);
}
function matchOwner(inv) {
  if (gFilters.owners.size === 0) return true;
  const owner = inv.owner || 'both';
  return owner === 'both' || gFilters.owners.has(owner);
}
function matchClient(inv) {
  return gFilters.clientIds.size === 0 || gFilters.clientIds.has(inv.clientId);
}
function matchStatus(inv) {
  return gFilters.statuses.size === 0 || gFilters.statuses.has(inv.status);
}

// ── Data aggregation ──────────────────────────────────────────────────────────
// kpiBase: no status filter → KPI cards, status donut, outstanding chart always
//          reflect the true financial picture regardless of status filter.
// base:    status-filtered → drives month bar, client revenue bar, and table.
function getData() {
  const kpiBase = listActive('invoices').filter(i =>
    SERVICE_STREAMS.includes(i.stream) &&
    matchDate(i) && matchStream(i) && matchOwner(i) && matchClient(i)
  );
  const base = gFilters.statuses.size === 0 ? kpiBase : kpiBase.filter(matchStatus);

  const paid        = kpiBase.filter(i => i.status === 'paid');
  const outstanding = kpiBase.filter(i => i.status === 'sent' || i.status === 'overdue');
  const overdue     = kpiBase.filter(i => i.status === 'overdue');
  const nonDraft    = kpiBase.filter(i => i.status !== 'draft');

  const sum = arr => arr.reduce((s, i) => s + toEUR(i.total, i.currency, i.issueDate), 0);
  return {
    base, kpiBase,
    paid, outstanding, overdue, nonDraft,
    paidTotal:        sum(paid),
    invoicedTotal:    sum(nonDraft),
    outstandingTotal: sum(outstanding),
    overdueTotal:     sum(overdue)
  };
}

// ── Valid filter options (leave-one-out faceting) ─────────────────────────────
function getValidOpts() {
  const invs = listActive('invoices').filter(i => SERVICE_STREAMS.includes(i.stream));
  const vY = new Set(), vSt = new Set(), vCi = new Set(), vOw = new Set(), vStat = new Set();
  const yrOk   = yr  => !gFilters.years.size     || gFilters.years.has(yr);
  const stOk   = st  => !gFilters.streams.size   || gFilters.streams.has(st);
  const ciOk   = ci  => !gFilters.clientIds.size || gFilters.clientIds.has(ci);
  const owOk   = ow  => !gFilters.owners.size    || ow === 'both' || gFilters.owners.has(ow);
  const statOk = s   => !gFilters.statuses.size  || gFilters.statuses.has(s);
  const addOw  = (vSet, ow) => { if (ow === 'both') { vSet.add('you'); vSet.add('rita'); vSet.add('both'); } else if (ow) vSet.add(ow); };
  for (const i of invs) {
    const ow   = i.owner || 'both', st = i.stream || 'other';
    const yr   = (i.issueDate || '').slice(0, 4);
    const ci   = i.clientId, stat = i.status || 'draft';
    if (yr && stOk(st) && ciOk(ci) && owOk(ow) && statOk(stat)) vY.add(yr);
    if (yrOk(yr) && ciOk(ci) && owOk(ow) && statOk(stat)) vSt.add(st);
    if (ci && yrOk(yr) && stOk(st) && owOk(ow) && statOk(stat)) vCi.add(ci);
    if (yrOk(yr) && stOk(st) && ciOk(ci) && statOk(stat)) addOw(vOw, ow);
    if (yrOk(yr) && stOk(st) && ciOk(ci) && owOk(ow)) vStat.add(stat);
  }
  return { vY, vSt, vCi, vOw, vStat };
}

// ── Rebuild ───────────────────────────────────────────────────────────────────
function rebuildView() {
  CHART_IDS.forEach(id => charts.destroy(id));
  const c = document.getElementById('content');
  if (!c) return;
  c.innerHTML = '';
  c.appendChild(buildView());
}

// ── Drill-down row builder ────────────────────────────────────────────────────
function toInvDrillRows(invoices) {
  return invoices.map(i => ({
    date:   i.issueDate,
    number: i.number ? `#${i.number}` : '—',
    client: byId('clients', i.clientId)?.name || '—',
    stream: STREAMS[i.stream]?.short || i.stream || '—',
    status: INVOICE_STATUSES[i.status]?.label || i.status || '—',
    eur:    toEUR(i.total, i.currency, i.issueDate)
  })).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

const INV_DRILL_COLS = [
  { key: 'date',   label: 'Date',    format: v => fmtDate(v) },
  { key: 'number', label: 'Invoice'  },
  { key: 'client', label: 'Client'   },
  { key: 'stream', label: 'Stream'   },
  { key: 'status', label: 'Status'   },
  { key: 'eur',    label: 'EUR',      right: true, format: v => formatEUR(v) }
];

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

// ── Main view ─────────────────────────────────────────────────────────────────
function buildView() {
  const wrap = el('div', { class: 'view active' });

  // Header
  wrap.appendChild(el('div', { style: 'margin-bottom:16px' },
    el('h2', { style: 'margin:0 0 4px;font-size:20px;font-weight:700' }, 'Services Analytics'),
    el('p',  { style: 'margin:0;font-size:13px;color:var(--text-muted)' },
      'Track Customer Success and Marketing Services invoice revenue')
  ));

  // Filter bar
  const opts = getValidOpts();
  const trim = (set, valid) => { if (valid.size) for (const v of [...set]) if (!valid.has(v)) set.delete(v); };
  trim(gFilters.years, opts.vY); trim(gFilters.streams, opts.vSt);
  trim(gFilters.clientIds, opts.vCi); trim(gFilters.owners, opts.vOw); trim(gFilters.statuses, opts.vStat);
  const yearMS   = buildMultiSelect(availableYears().filter(y => !opts.vY.size || opts.vY.has(y)).map(y => ({ value: y, label: y })), gFilters.years, 'All Years', rebuildView, 'svc_years');
  const monthMS  = buildMultiSelect(MONTH_LABELS.map((m, i) => ({ value: String(i + 1).padStart(2, '0'), label: m })), gFilters.months, 'All Months', rebuildView, 'svc_months');
  const clientMS = buildMultiSelect(listActiveClients().filter(c => !opts.vCi.size || opts.vCi.has(c.id)).map(c => ({ value: c.id, label: c.name })), gFilters.clientIds, 'All Clients', rebuildView, 'svc_clients');
  const streamMS = buildMultiSelect(SERVICE_STREAMS.filter(k => !opts.vSt.size || opts.vSt.has(k)).map(k => ({ value: k, label: STREAMS[k].label, color: STREAMS[k].color })), gFilters.streams, 'All Streams', rebuildView, 'svc_streams');
  const statusMS = buildMultiSelect(Object.entries(INVOICE_STATUSES).filter(([k]) => !opts.vStat.size || opts.vStat.has(k)).map(([k, v]) => ({ value: k, label: v.label, css: v.css })), gFilters.statuses, 'All Statuses', rebuildView, 'svc_statuses');
  const ownerMS  = buildMultiSelect(Object.entries(OWNERS).filter(([k]) => k !== 'both' && (!opts.vOw.size || opts.vOw.has(k))).map(([k, v]) => ({ value: k, label: v })), gFilters.owners, 'All Owners', rebuildView, 'svc_owners');

  const filterBar = el('div', { class: 'flex gap-8 mb-16', style: 'flex-wrap:wrap;align-items:center' });
  filterBar.appendChild(el('span', { style: 'font-size:12px;color:var(--text-muted);align-self:center' }, 'Filters:'));
  filterBar.appendChild(yearMS);
  filterBar.appendChild(monthMS);
  filterBar.appendChild(clientMS);
  filterBar.appendChild(streamMS);
  filterBar.appendChild(statusMS);
  filterBar.appendChild(ownerMS);
  filterBar.appendChild(button('Reset Filters', { variant: 'sm ghost', onClick: () => { yearMS.reset(); monthMS.reset(); clientMS.reset(); streamMS.reset(); statusMS.reset(); ownerMS.reset(); rebuildView(); } }));
  wrap.appendChild(filterBar);

  // Data
  const data = getData();
  const { paid, outstanding, overdue, nonDraft,
          paidTotal, invoicedTotal, outstandingTotal, overdueTotal } = data;

  // ── KPI row ────────────────────────────────────────────────────────────────
  const kpiRow = el('div', { class: 'grid grid-4 mb-16' });
  kpiRow.appendChild(kpiCard(
    'Paid Revenue', formatEUR(paidTotal), 'success',
    () => drillDownModal('Paid Invoices', toInvDrillRows(paid), INV_DRILL_COLS)
  ));
  kpiRow.appendChild(kpiCard(
    'Invoiced', formatEUR(invoicedTotal), '',
    () => drillDownModal('All Invoiced (non-draft)', toInvDrillRows(nonDraft), INV_DRILL_COLS)
  ));
  kpiRow.appendChild(kpiCard(
    'Outstanding', formatEUR(outstandingTotal),
    outstandingTotal > 0 ? 'warning' : '',
    () => drillDownModal('Outstanding Invoices', toInvDrillRows(outstanding), INV_DRILL_COLS)
  ));
  kpiRow.appendChild(kpiCard(
    'Overdue', formatEUR(overdueTotal),
    overdueTotal > 0 ? 'danger' : '',
    () => drillDownModal('Overdue Invoices', toInvDrillRows(overdue), INV_DRILL_COLS)
  ));
  wrap.appendChild(kpiRow);

  // ── Chart row 1: monthly stacked bar (2/3) + status donut (1/3) ───────────
  const row1 = el('div', { style: 'display:grid;grid-template-columns:2fr 1fr;gap:16px;margin-bottom:16px' });
  row1.appendChild(el('div', { class: 'card' },
    el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'Monthly Revenue by Stream')),
    el('div', { class: 'chart-wrap tall' }, el('canvas', { id: 'svc-month-bar' }))
  ));
  row1.appendChild(el('div', { class: 'card' },
    el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'Invoice Status')),
    el('div', { class: 'chart-wrap tall' }, el('canvas', { id: 'svc-status-donut' }))
  ));
  wrap.appendChild(row1);

  // ── Chart row 2: client revenue hbar (1/2) + outstanding hbar (1/2) ───────
  const row2 = el('div', { class: 'grid grid-2 mb-16' });
  row2.appendChild(el('div', { class: 'card' },
    el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'Revenue by Client')),
    el('div', { class: 'chart-wrap tall' }, el('canvas', { id: 'svc-client-bar' }))
  ));
  row2.appendChild(el('div', { class: 'card' },
    el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'Outstanding per Client')),
    el('div', { class: 'chart-wrap tall' }, el('canvas', { id: 'svc-outstanding-bar' }))
  ));
  wrap.appendChild(row2);

  // ── Invoice table ──────────────────────────────────────────────────────────
  const tableCard = el('div', { class: 'card' });
  const svcTableHeader = el('div', { class: 'card-header', style: 'cursor:pointer;user-select:none;display:flex;align-items:center;justify-content:space-between' });
  const svcHeaderLeft = el('div', { style: 'display:flex;align-items:center;gap:16px' });
  svcHeaderLeft.appendChild(el('div', { class: 'card-title' }, 'Invoice Records'));
  svcHeaderLeft.appendChild(el('div', { style: 'font-size:12px;color:var(--text-muted)' },
    gFilters.statuses.size > 0 ? 'Status filter active' : 'All statuses'
  ));
  svcTableHeader.appendChild(svcHeaderLeft);
  const svcChevron = el('span', { style: 'font-size:11px;color:var(--text-muted);display:inline-block;transition:transform 200ms' }, '▼');
  svcTableHeader.appendChild(svcChevron);
  tableCard.appendChild(svcTableHeader);
  const svcTableBody = el('div');
  buildInvoiceTable(svcTableBody, data);
  tableCard.appendChild(svcTableBody);
  let svcCollapsed = false;
  svcTableHeader.onclick = () => {
    svcCollapsed = !svcCollapsed;
    svcTableBody.style.display = svcCollapsed ? 'none' : '';
    svcChevron.style.transform = svcCollapsed ? 'rotate(-90deg)' : '';
  };
  wrap.appendChild(tableCard);

  setTimeout(() => {
    renderMonthBar(data);
    renderStatusDonut(data);
    renderClientBar(data);
    renderOutstandingBar(data);
  }, 0);

  return wrap;
}

// ── Chart 1: Horizontal bar — Client revenue (paid) ──────────────────────────
function renderClientBar({ paid }) {
  const map = new Map();
  paid.forEach(i => {
    const name = byId('clients', i.clientId)?.name || 'Unknown';
    const cur  = map.get(i.clientId) || { eur: 0, name, id: i.clientId };
    map.set(i.clientId, { eur: cur.eur + toEUR(i.total, i.currency, i.issueDate), name: cur.name, id: i.clientId });
  });

  const sorted = [...map.values()].sort((a, b) => b.eur - a.eur);
  if (!sorted.length) return;

  charts.bar('svc-client-bar', {
    labels: sorted.map(d => d.name),
    datasets: [{
      label:           'Revenue (EUR)',
      data:            sorted.map(d => Math.round(d.eur)),
      backgroundColor: sorted.map((_, i) => `hsla(${(160 + i * 35) % 360}, 65%, 55%, 0.85)`)
    }],
    horizontal: true,
    onClickItem: (_label, idx) => {
      const d = sorted[idx];
      drillDownModal(`Revenue — ${d.name}`, toInvDrillRows(paid.filter(i => i.clientId === d.id)), INV_DRILL_COLS);
    }
  });
}

// ── Chart 2: Stacked bar — Month × (CS, Marketing) ───────────────────────────
function renderMonthBar({ base }) {
  const months = getMonthKeys();
  if (!months.length) return;

  const streamMonthMap = new Map();
  base.forEach(i => {
    const sk = i.stream;
    const mk = (i.issueDate || '').slice(0, 7);
    if (!mk || !SERVICE_STREAMS.includes(sk)) return;
    if (!streamMonthMap.has(sk)) streamMonthMap.set(sk, new Map());
    const m = streamMonthMap.get(sk);
    m.set(mk, (m.get(mk) || 0) + toEUR(i.total, i.currency, i.issueDate));
  });

  const orderedKeys = SERVICE_STREAMS.filter(k => streamMonthMap.has(k));
  if (!orderedKeys.length) return;

  charts.bar('svc-month-bar', {
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
      const rows = base.filter(i => (i.issueDate || '').slice(0, 7) === mk && i.stream === sk);
      drillDownModal(`${label} — ${STREAMS[sk]?.label || sk}`, toInvDrillRows(rows), INV_DRILL_COLS);
    }
  });
}

// ── Chart 3: Donut — Invoice Status distribution (always from kpiBase) ────────
function renderStatusDonut({ kpiBase }) {
  const statusMap = new Map();
  kpiBase.forEach(i => {
    const s = i.status || 'draft';
    statusMap.set(s, (statusMap.get(s) || 0) + toEUR(i.total, i.currency, i.issueDate));
  });

  const entries = Object.keys(INVOICE_STATUSES)
    .filter(k => (statusMap.get(k) || 0) > 0)
    .map(k => [k, statusMap.get(k)]);
  if (!entries.length) return;

  charts.doughnut('svc-status-donut', {
    labels: entries.map(([k]) => INVOICE_STATUSES[k]?.label || k),
    data:   entries.map(([, v]) => Math.round(v)),
    colors: entries.map(([k]) => STATUS_COLORS[k] || '#8b93b0'),
    onClickItem: (_label, idx) => {
      const sk   = entries[idx][0];
      const rows = kpiBase.filter(i => i.status === sk);
      drillDownModal(`Invoices — ${INVOICE_STATUSES[sk]?.label || sk}`, toInvDrillRows(rows), INV_DRILL_COLS);
    }
  });
}

// ── Chart 4: Horizontal bar — Outstanding per client (always from outstanding) ─
function renderOutstandingBar({ outstanding }) {
  const map = new Map();
  outstanding.forEach(i => {
    const name = byId('clients', i.clientId)?.name || 'Unknown';
    const cur  = map.get(i.clientId) || { eur: 0, name, id: i.clientId };
    map.set(i.clientId, { eur: cur.eur + toEUR(i.total, i.currency, i.issueDate), name: cur.name, id: i.clientId });
  });

  const sorted = [...map.values()].sort((a, b) => b.eur - a.eur);
  if (!sorted.length) return;

  charts.bar('svc-outstanding-bar', {
    labels: sorted.map(d => d.name),
    datasets: [{
      label:           'Outstanding (EUR)',
      data:            sorted.map(d => Math.round(d.eur)),
      backgroundColor: sorted.map(d => {
        const hasOverdue = outstanding.some(i => i.clientId === d.id && i.status === 'overdue');
        return hasOverdue ? 'rgba(239,68,68,0.8)' : 'rgba(245,158,11,0.8)';
      })
    }],
    horizontal: true,
    onClickItem: (_label, idx) => {
      const d = sorted[idx];
      drillDownModal(
        `Outstanding — ${d.name}`,
        toInvDrillRows(outstanding.filter(i => i.clientId === d.id)),
        INV_DRILL_COLS
      );
    }
  });
}

// ── Invoice table ─────────────────────────────────────────────────────────────
// Columns: client, stream, status (badge), invoiceDate, amountEUR
function buildInvoiceTable(container, { base }) {
  const TABLE_COLS = [
    { key: 'client',    label: 'Client'      },
    { key: 'stream',    label: 'Stream'      },
    { key: 'status',    label: 'Status',      badge: true },
    { key: 'date',      label: 'Invoice Date' },
    { key: 'amountEUR', label: 'Amount EUR',  right: true }
  ];

  const rows = base.map(i => {
    const status = i.status || 'draft';
    return {
      _date:      i.issueDate,
      _eur:       toEUR(i.total, i.currency, i.issueDate),
      client:     byId('clients', i.clientId)?.name || '—',
      stream:     STREAMS[i.stream]?.short || i.stream || '—',
      status:     INVOICE_STATUSES[status]?.label || status,
      _statusCss: INVOICE_STATUSES[status]?.css || '',
      date:       fmtDate(i.issueDate),
      amountEUR:  formatEUR(toEUR(i.total, i.currency, i.issueDate))
    };
  }).sort((a, b) => (b._date || '').localeCompare(a._date || ''));

  const table = el('table', { class: 'table' });
  const htr   = el('tr');
  TABLE_COLS.forEach(col => htr.appendChild(el('th', { class: col.right ? 'right' : '' }, col.label)));
  table.appendChild(el('thead', {}, htr));

  const tbody = el('tbody');
  for (const r of rows) {
    const tr = el('tr');
    TABLE_COLS.forEach(col => {
      const td = el('td', { class: col.right ? 'right num' : '' });
      if (col.badge) {
        td.appendChild(el('span', { class: `badge ${r._statusCss}` }, r[col.key]));
      } else {
        td.textContent = r[col.key] ?? '—';
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

  const totalEUR = rows.reduce((s, r) => s + r._eur, 0);
  container.appendChild(el('div', {
    style: 'display:flex;justify-content:space-between;margin-top:8px;font-size:13px'
  },
    el('span', { style: 'color:var(--text-muted)' }, `${rows.length} record(s)`),
    el('strong', { class: 'num' }, `Total: ${formatEUR(totalEUR)}`)
  ));
}
