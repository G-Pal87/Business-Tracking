// Services Analytics Dashboard — track CS + Marketing invoice revenue
import { el, buildMultiSelect, button, fmtDate, drillDownModal, attachSortFilter } from '../core/ui.js';
import * as charts from '../core/charts.js';
import { STREAMS, OWNERS, INVOICE_STATUSES, SERVICE_STREAMS } from '../core/config.js';
import {
  formatEUR, toEUR, byId,
  listActive, listActiveClients
} from '../core/data.js';
import {
  createFilterState, getCurrentPeriodRange, getComparisonRange,
  getMonthKeysForRange, makeMatchers, buildFilterBar, buildComparisonLine
} from './analytics-filters.js';

// ── Filter state ──────────────────────────────────────────────────────────────
let gF = createFilterState();
let gStatusFilter = new Set(); // Invoice Status — local, service-specific

const CHART_IDS     = ['svc-client-bar', 'svc-month-bar', 'svc-status-donut', 'svc-outstanding-bar', 'svc-aging-bar'];
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

// ── Owner matcher with client-owner fallback ──────────────────────────────────
function matchOwnerSvc(inv) {
  if (!gF.owners.size) return true;
  let ow = inv.owner;
  if (!ow && inv.clientId) ow = byId('clients', inv.clientId)?.owner;
  ow = ow || 'both';
  return ow === 'both' || gF.owners.has(ow);
}

function safePct(cur, cmp) {
  if (cmp == null || !isFinite(cmp) || cmp === 0) return null;
  return (cur - cmp) / Math.abs(cmp) * 100;
}

// ── Data aggregation ──────────────────────────────────────────────────────────
// kpiBase: no status filter → KPIs, status donut, outstanding/aging always reflect
//          the true financial picture regardless of status filter.
// base:    status-filtered → monthly bar, client revenue bar, table.
function getData(start, end) {
  const { mStream, mClient } = makeMatchers(gF);

  const matchDate = inv => {
    const d = (inv.issueDate || inv.date || '').slice(0, 10);
    return d >= start && d <= end;
  };

  const kpiBase = listActive('invoices').filter(i =>
    SERVICE_STREAMS.includes(i.stream) &&
    matchDate(i) && mStream(i) && matchOwnerSvc(i) && mClient(i)
  );
  const base = gStatusFilter.size === 0 ? kpiBase : kpiBase.filter(i => gStatusFilter.has(i.status));

  const paid        = kpiBase.filter(i => i.status === 'paid');
  const outstanding = kpiBase.filter(i => i.status === 'sent' || i.status === 'overdue');
  const overdue     = kpiBase.filter(i => i.status === 'overdue');
  const nonDraft    = kpiBase.filter(i => i.status !== 'draft');

  const sum = arr => arr.reduce((s, i) => s + toEUR(i.total, i.currency, i.issueDate), 0);
  const paidTotal        = sum(paid);
  const invoicedTotal    = sum(nonDraft);
  const outstandingTotal = sum(outstanding);
  const overdueTotal     = sum(overdue);
  const collectionRate   = invoicedTotal > 0 ? paidTotal / invoicedTotal * 100 : null;

  // Client revenue concentration
  const clientRevMap = new Map();
  paid.forEach(i => {
    if (!i.clientId) return;
    clientRevMap.set(i.clientId, (clientRevMap.get(i.clientId) || 0) + toEUR(i.total, i.currency, i.issueDate));
  });

  let topClient = null, topClientRev = 0;
  for (const [cid, rev] of clientRevMap.entries()) {
    if (rev > topClientRev) {
      topClientRev = rev;
      topClient = { clientId: cid, name: byId('clients', cid)?.name || '—', rev };
    }
  }
  const concentration = paidTotal > 0 && topClient ? topClientRev / paidTotal * 100 : null;

  // Active clients: those with at least one non-draft invoice in period
  const activeClientIds = new Set(nonDraft.map(i => i.clientId).filter(Boolean));

  return {
    base, kpiBase,
    paid, outstanding, overdue, nonDraft,
    paidTotal, invoicedTotal, outstandingTotal, overdueTotal,
    collectionRate, topClient, concentration, activeClientIds, clientRevMap
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

// ── Drill-down row builders ───────────────────────────────────────────────────
function toInvDrillRows(invoices) {
  return invoices.map(i => ({
    date:    i.issueDate || i.date,
    number:  i.number ? `#${i.number}` : '—',
    client:  byId('clients', i.clientId)?.name || '—',
    stream:  STREAMS[i.stream]?.short || i.stream || '—',
    status:  INVOICE_STATUSES[i.status]?.label || i.status || '—',
    dueDate: i.dueDate || null,
    eur:     toEUR(i.total, i.currency, i.issueDate)
  })).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

const INV_DRILL_COLS = [
  { key: 'date',    label: 'Issue Date', format: v => fmtDate(v)       },
  { key: 'number',  label: 'Invoice'                                    },
  { key: 'client',  label: 'Client'                                     },
  { key: 'stream',  label: 'Stream'                                     },
  { key: 'status',  label: 'Status'                                     },
  { key: 'dueDate', label: 'Due Date',   format: v => v ? fmtDate(v) : '—' },
  { key: 'eur',     label: 'EUR',        right: true, format: v => formatEUR(v) }
];

function toClientConcentrationRows(clientRevMap, paidTotal) {
  return [...clientRevMap.entries()]
    .map(([cid, rev]) => ({
      client:  byId('clients', cid)?.name || '—',
      paidRev: rev,
      share:   paidTotal > 0 ? rev / paidTotal * 100 : 0
    }))
    .sort((a, b) => b.paidRev - a.paidRev);
}
const CONCENTRATION_DRILL_COLS = [
  { key: 'client',  label: 'Client'                                            },
  { key: 'paidRev', label: 'Paid Revenue', right: true, format: v => formatEUR(v) },
  { key: 'share',   label: 'Share',        right: true, format: v => v.toFixed(1) + '%' }
];

function toActiveClientRows(kpiBase) {
  const map = new Map();
  kpiBase.forEach(i => {
    if (!i.clientId) return;
    const c = map.get(i.clientId) || { paid: 0, invoiced: 0, outstanding: 0, overdue: 0, count: 0 };
    const eur = toEUR(i.total, i.currency, i.issueDate);
    c.count++;
    if (i.status === 'paid') c.paid += eur;
    if (i.status !== 'draft') c.invoiced += eur;
    if (i.status === 'sent' || i.status === 'overdue') c.outstanding += eur;
    if (i.status === 'overdue') c.overdue += eur;
    map.set(i.clientId, c);
  });
  return [...map.entries()]
    .map(([cid, d]) => ({
      client:      byId('clients', cid)?.name || '—',
      paidRev:     d.paid,
      invoicedRev: d.invoiced,
      outstanding: d.outstanding,
      overdue:     d.overdue,
      count:       d.count
    }))
    .sort((a, b) => b.paidRev - a.paidRev);
}
const ACTIVE_CLIENT_DRILL_COLS = [
  { key: 'client',      label: 'Client'                                               },
  { key: 'paidRev',     label: 'Paid Revenue',     right: true, format: v => formatEUR(v) },
  { key: 'invoicedRev', label: 'Invoiced Revenue', right: true, format: v => formatEUR(v) },
  { key: 'outstanding', label: 'Outstanding',      right: true, format: v => formatEUR(v) },
  { key: 'overdue',     label: 'Overdue',          right: true, format: v => formatEUR(v) },
  { key: 'count',       label: 'Invoice Count',    right: true }
];

// ── KPI card ──────────────────────────────────────────────────────────────────
function kpiCard(labelOrOpts, value, variant, onClick) {
  let label, subtitle, delta, deltaIsPp, invertDelta, compLabel;
  if (typeof labelOrOpts === 'object' && labelOrOpts !== null) {
    ({ label, value, subtitle, delta, deltaIsPp, invertDelta, compLabel, variant, onClick } = labelOrOpts);
  } else {
    label = labelOrOpts;
  }

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

  if (delta !== null && delta !== undefined && isFinite(delta)) {
    const up     = invertDelta ? delta < 0 : delta >= 0;
    const sign   = delta >= 0 ? '+' : '';
    const suffix = deltaIsPp ? ' pp' : '%';
    const trendEl = el('div', { class: 'kpi-trend ' + (up ? 'up' : 'down') });
    trendEl.appendChild(el('span', { class: 'kpi-arrow' }, up ? '▲' : '▼'));
    trendEl.append(` ${sign}${delta.toFixed(1)}${suffix}`);
    if (compLabel) trendEl.appendChild(el('span', { class: 'kpi-comp-label' }, ` vs ${compLabel}`));
    card.appendChild(trendEl);
  }

  if (subtitle) {
    card.appendChild(el('div', { style: 'font-size:11px;color:var(--text-muted);margin-top:2px' }, subtitle));
  }

  card.appendChild(el('div', { class: 'kpi-accent-bar' }));
  return card;
}

// ── Service Performance Insights ──────────────────────────────────────────────
function computeServiceInsights({ paidTotal, invoicedTotal, outstandingTotal, overdueTotal, concentration, topClient, collectionRate, nonDraft, cmpData, cmpRange }) {
  const signals = [];

  if (nonDraft.length === 0) {
    signals.push({
      severity: 'Note',
      title: 'NO INVOICE ACTIVITY',
      text: 'No non-draft service invoices found for the selected period and filters.',
      inspect: null
    });
    return signals;
  }

  // Client concentration
  if (concentration !== null && topClient) {
    if (concentration > 60) {
      signals.push({
        severity: 'At Risk',
        title: 'CLIENT CONCENTRATION',
        text: `${topClient.name} drives ${concentration.toFixed(0)}% of paid service revenue — high dependency risk.`,
        inspect: 'Revenue by Client'
      });
    } else if (concentration > 40) {
      signals.push({
        severity: 'Watch',
        title: 'CLIENT CONCENTRATION',
        text: `${topClient.name} accounts for ${concentration.toFixed(0)}% of paid service revenue. Consider diversifying.`,
        inspect: 'Revenue by Client'
      });
    }
  }

  // Collection health
  if (collectionRate !== null) {
    if (collectionRate < 60) {
      signals.push({
        severity: 'At Risk',
        title: 'COLLECTION HEALTH',
        text: `Collection rate is ${collectionRate.toFixed(0)}% — less than 60% of invoiced revenue has been paid.`,
        inspect: 'Invoice Records'
      });
    } else if (collectionRate < 80) {
      signals.push({
        severity: 'Watch',
        title: 'COLLECTION HEALTH',
        text: `Collection rate is ${collectionRate.toFixed(0)}%. A portion of invoiced revenue remains uncollected.`,
        inspect: 'Invoice Records'
      });
    }
  }

  // Overdue risk
  if (overdueTotal > 0) {
    const sev = paidTotal > 0 && overdueTotal > paidTotal * 0.3 ? 'At Risk' : 'Watch';
    signals.push({
      severity: sev,
      title: 'OVERDUE INVOICES',
      text: `${formatEUR(overdueTotal)} in overdue invoices require follow-up.`,
      inspect: 'Invoice Records'
    });
  }

  // Outstanding risk
  if (outstandingTotal > 0 && paidTotal > 0 && outstandingTotal > paidTotal * 0.5) {
    signals.push({
      severity: 'Watch',
      title: 'OUTSTANDING RISK',
      text: `${formatEUR(outstandingTotal)} outstanding — more than 50% of paid revenue. Monitor collection closely.`,
      inspect: 'Outstanding per Client'
    });
  }

  // Revenue growth/decline vs comparison
  if (cmpData && cmpRange) {
    const growth = safePct(paidTotal, cmpData.paidTotal);
    if (growth !== null && growth < -20) {
      signals.push({
        severity: 'Watch',
        title: 'REVENUE DECLINE',
        text: `Paid service revenue is down ${Math.abs(growth).toFixed(0)}% vs ${cmpRange.label}. Investigate service demand.`,
        inspect: 'Monthly Revenue by Stream'
      });
    } else if (growth !== null && growth > 20) {
      signals.push({
        severity: 'Note',
        title: 'REVENUE GROWTH',
        text: `Paid service revenue grew ${growth.toFixed(0)}% vs ${cmpRange.label}.`,
        inspect: 'Monthly Revenue by Stream'
      });
    }
  }

  if (signals.length === 0) {
    signals.push({
      severity: 'Note',
      title: 'HEALTHY',
      text: 'No major service revenue or collection risks detected for the selected period.',
      inspect: null
    });
  }

  return signals;
}

function buildInsightsBanner(signals) {
  const SEV_COLOR = { 'At Risk': '#ef4444', 'Watch': '#f59e0b', 'Note': '#6366f1' };
  const SEV_BG    = { 'At Risk': 'rgba(239,68,68,0.06)', 'Watch': 'rgba(245,158,11,0.06)', 'Note': 'rgba(99,102,241,0.06)' };

  const card = el('div', { class: 'card mb-16' });
  card.appendChild(el('div', { class: 'card-header' },
    el('div', { class: 'card-title' }, 'Service Performance Insights')
  ));

  const grid = el('div', { style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px;padding:16px' });

  for (const sig of signals) {
    const color = SEV_COLOR[sig.severity] || SEV_COLOR['Note'];
    const bg    = SEV_BG[sig.severity]    || SEV_BG['Note'];
    const block = el('div', {
      style: `background:${bg};border-left:3px solid ${color};border-radius:0 var(--radius-sm) var(--radius-sm) 0;padding:12px 14px`
    });

    const titleRow = el('div', { style: 'display:flex;align-items:center;justify-content:space-between;margin-bottom:6px' });
    titleRow.appendChild(el('span', { style: `font-size:11px;font-weight:700;letter-spacing:0.5px;color:${color}` }, sig.title));
    titleRow.appendChild(el('span', { style: `font-size:10px;font-weight:600;padding:2px 6px;border-radius:3px;background:${color};color:#fff` }, sig.severity));
    block.appendChild(titleRow);

    block.appendChild(el('p', { style: 'margin:0 0 6px;font-size:12px;color:var(--text);line-height:1.4' }, sig.text));

    if (sig.inspect) {
      block.appendChild(el('div', { style: `font-size:11px;color:${color};font-weight:600` }, `→ Inspect: ${sig.inspect}`));
    }

    grid.appendChild(block);
  }

  card.appendChild(grid);
  return card;
}

// ── Main view ─────────────────────────────────────────────────────────────────
function buildView() {
  const wrap = el('div', { class: 'view active' });

  // Header
  wrap.appendChild(el('div', { style: 'margin-bottom:16px' },
    el('h2', { style: 'margin:0 0 4px;font-size:20px;font-weight:700' }, 'Services Analytics'),
    el('p',  { style: 'margin:0;font-size:13px;color:var(--text-muted)' },
      'Customer Success and Marketing Services invoice revenue, client concentration, and collection')
  ));

  // Shared filter bar — Period, Owner, Client, Comparison (no property, custom stream)
  const filterBarEl = buildFilterBar(gF, {
    showOwner: true, showStream: false, showProperty: false, showClient: true,
    storagePrefix: 'svc'
  }, newState => {
    if (newState) Object.assign(gF, newState);
    rebuildView();
  });
  wrap.appendChild(filterBarEl);

  // Local stream filter (service streams only)
  const streamWrap = el('div', { style: 'display:flex;align-items:center;gap:8px;margin-bottom:16px;flex-wrap:wrap' });
  streamWrap.appendChild(el('span', { style: 'font-size:12px;color:var(--text-muted)' }, 'Stream:'));
  const streamMS = buildMultiSelect(
    SERVICE_STREAMS.map(k => ({ value: k, label: STREAMS[k]?.label || k })),
    gF.streams, 'All Streams', rebuildView, 'svc_streams'
  );
  streamWrap.appendChild(streamMS);

  // Local invoice status filter
  streamWrap.appendChild(el('span', { style: 'font-size:12px;color:var(--text-muted);margin-left:8px' }, 'Status:'));
  const statusMS = buildMultiSelect(
    Object.entries(INVOICE_STATUSES).map(([k, v]) => ({ value: k, label: v.label })),
    gStatusFilter, 'All Statuses', rebuildView, 'svc_statuses'
  );
  streamWrap.appendChild(statusMS);
  wrap.appendChild(streamWrap);

  // Date ranges
  const curRange = getCurrentPeriodRange(gF);
  const cmpRange = getComparisonRange(gF, curRange);
  const { start, end } = curRange;

  const curData = getData(start, end);
  const cmpData = cmpRange ? getData(cmpRange.start, cmpRange.end) : null;

  const {
    paid, outstanding, overdue, nonDraft, kpiBase,
    paidTotal, invoicedTotal, outstandingTotal, overdueTotal,
    collectionRate, topClient, concentration, activeClientIds, clientRevMap
  } = curData;

  // Comparison line
  const compLine = buildComparisonLine(curRange, cmpRange);
  if (compLine) wrap.appendChild(compLine);

  // Deltas (suppress when unavailable)
  const deltaPaid       = safePct(paidTotal,        cmpData?.paidTotal);
  const deltaInvoiced   = safePct(invoicedTotal,     cmpData?.invoicedTotal);
  const deltaOutstanding = safePct(outstandingTotal, cmpData?.outstandingTotal);
  const deltaCollection  = (collectionRate !== null && cmpData?.collectionRate !== null && cmpData?.collectionRate !== undefined)
    ? collectionRate - cmpData.collectionRate : null;

  // ── KPI row 1: Paid Revenue, Invoiced Revenue, Collection Rate, Outstanding ─
  const kpiRow1 = el('div', { class: 'grid grid-4 mb-16' });
  kpiRow1.appendChild(kpiCard({
    label:      'Paid Revenue',
    value:      formatEUR(paidTotal),
    variant:    'success',
    delta:      deltaPaid,
    compLabel:  cmpRange?.label,
    onClick:    () => drillDownModal('Paid Invoices', toInvDrillRows(paid), INV_DRILL_COLS)
  }));
  kpiRow1.appendChild(kpiCard({
    label:     'Invoiced Revenue',
    value:     formatEUR(invoicedTotal),
    delta:     deltaInvoiced,
    compLabel: cmpRange?.label,
    onClick:   () => drillDownModal('Invoiced (non-draft)', toInvDrillRows(nonDraft), INV_DRILL_COLS)
  }));
  kpiRow1.appendChild(kpiCard({
    label:     'Collection Rate',
    value:     collectionRate !== null ? collectionRate.toFixed(0) + '%' : '—',
    variant:   collectionRate !== null && collectionRate < 60 ? 'danger' : collectionRate !== null && collectionRate < 80 ? 'warning' : '',
    subtitle:  'Paid / invoiced revenue',
    delta:     deltaCollection,
    deltaIsPp: true,
    compLabel: cmpRange?.label,
    onClick:   () => drillDownModal('Invoiced (non-draft)', toInvDrillRows(nonDraft), INV_DRILL_COLS)
  }));
  kpiRow1.appendChild(kpiCard({
    label:       'Outstanding',
    value:       formatEUR(outstandingTotal),
    variant:     outstandingTotal > 0 ? 'warning' : '',
    delta:       deltaOutstanding,
    invertDelta: true,
    compLabel:   cmpRange?.label,
    onClick:     () => drillDownModal('Outstanding Invoices', toInvDrillRows(outstanding), INV_DRILL_COLS)
  }));
  wrap.appendChild(kpiRow1);

  // ── KPI row 2: Overdue, Client Concentration, Top Client, Active Clients ───
  const concVariant = concentration === null ? '' : concentration > 60 ? 'danger' : concentration > 40 ? 'warning' : 'success';
  const kpiRow2 = el('div', { class: 'grid grid-4 mb-16' });
  kpiRow2.appendChild(kpiCard({
    label:   'Overdue',
    value:   formatEUR(overdueTotal),
    variant: overdueTotal > 0 ? 'danger' : '',
    onClick: () => drillDownModal('Overdue Invoices', toInvDrillRows(overdue), INV_DRILL_COLS)
  }));
  kpiRow2.appendChild(kpiCard({
    label:   'Client Concentration',
    value:   concentration !== null ? concentration.toFixed(0) + '%' : '—',
    variant: concVariant,
    subtitle: 'Top client share of paid revenue',
    onClick: () => drillDownModal('Revenue by Client', toClientConcentrationRows(clientRevMap, paidTotal), CONCENTRATION_DRILL_COLS)
  }));
  kpiRow2.appendChild(kpiCard({
    label:   'Top Client',
    value:   topClient ? topClient.name : '—',
    subtitle: topClient ? `${formatEUR(topClient.rev)} · ${concentration !== null ? concentration.toFixed(0) + '%' : '—'} of paid` : null,
    onClick: () => topClient
      ? drillDownModal(`Invoices — ${topClient.name}`, toInvDrillRows(paid.filter(i => i.clientId === topClient.clientId)), INV_DRILL_COLS)
      : null
  }));
  kpiRow2.appendChild(kpiCard({
    label:   'Active Clients',
    value:   String(activeClientIds.size),
    subtitle: 'Clients with invoiced activity',
    onClick: () => drillDownModal('Client Summary', toActiveClientRows(kpiBase), ACTIVE_CLIENT_DRILL_COLS)
  }));
  wrap.appendChild(kpiRow2);

  // ── Service Performance Insights ──────────────────────────────────────────
  const signals = computeServiceInsights({
    paidTotal, invoicedTotal, outstandingTotal, overdueTotal,
    concentration, topClient, collectionRate, nonDraft, cmpData, cmpRange
  });
  wrap.appendChild(buildInsightsBanner(signals));

  // ── Service Revenue Trends ─────────────────────────────────────────────────
  wrap.appendChild(el('div', { style: 'margin:8px 0 12px' },
    el('h3', { style: 'margin:0;font-size:14px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px' }, 'Service Revenue Trends')
  ));
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

  // ── Client Revenue and Concentration ──────────────────────────────────────
  wrap.appendChild(el('div', { style: 'margin:8px 0 12px' },
    el('h3', { style: 'margin:0;font-size:14px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px' }, 'Client Revenue and Concentration')
  ));
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

  // ── Invoice Collection ─────────────────────────────────────────────────────
  wrap.appendChild(el('div', { style: 'margin:8px 0 12px' },
    el('h3', { style: 'margin:0;font-size:14px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px' }, 'Invoice Collection')
  ));
  wrap.appendChild(el('div', { class: 'card mb-16' },
    el('div', { class: 'card-header' },
      el('div', { class: 'card-title' }, 'Outstanding Aging'),
      el('div', { style: 'font-size:12px;color:var(--text-muted)' }, 'Aged by due date — click a bucket for invoices')
    ),
    el('div', { class: 'chart-wrap' }, el('canvas', { id: 'svc-aging-bar' }))
  ));

  // ── Invoice Records ────────────────────────────────────────────────────────
  const tableCard = el('div', { class: 'card' });
  tableCard.appendChild(el('div', { class: 'card-header' },
    el('div', { class: 'card-title' }, 'Invoice Records'),
    el('div', { style: 'font-size:12px;color:var(--text-muted)' },
      gStatusFilter.size > 0 ? 'Status filter active' : 'All statuses'
    )
  ));
  buildInvoiceTable(tableCard, curData);
  wrap.appendChild(tableCard);

  const { keys: monthKeys } = getMonthKeysForRange(start, end);
  setTimeout(() => {
    renderMonthBar(curData, monthKeys);
    renderStatusDonut(curData);
    renderClientBar(curData);
    renderOutstandingBar(curData);
    renderAgingBar(curData);
  }, 0);

  return wrap;
}

// ── Chart 1: Horizontal bar — Client revenue (paid, from kpiBase) ─────────────
function renderClientBar({ paid }) {
  const map = new Map();
  paid.forEach(i => {
    if (!i.clientId) return;
    const cur = map.get(i.clientId) || { eur: 0, name: byId('clients', i.clientId)?.name || 'Unknown', id: i.clientId };
    map.set(i.clientId, { eur: cur.eur + toEUR(i.total, i.currency, i.issueDate), name: cur.name, id: cur.id });
  });

  const sorted = [...map.values()].sort((a, b) => b.eur - a.eur);
  if (!sorted.length) return;

  charts.bar('svc-client-bar', {
    labels: sorted.map(d => d.name),
    datasets: [{
      label:           'Paid Revenue (EUR)',
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
function renderMonthBar({ base }, monthKeys) {
  if (!monthKeys.length) return;

  const streamMonthMap = new Map();
  base.forEach(i => {
    const sk = i.stream;
    const mk = (i.issueDate || i.date || '').slice(0, 7);
    if (!mk || !SERVICE_STREAMS.includes(sk)) return;
    if (!streamMonthMap.has(sk)) streamMonthMap.set(sk, new Map());
    const m = streamMonthMap.get(sk);
    m.set(mk, (m.get(mk) || 0) + toEUR(i.total, i.currency, i.issueDate));
  });

  const orderedKeys = SERVICE_STREAMS.filter(k => streamMonthMap.has(k));
  if (!orderedKeys.length) return;

  charts.bar('svc-month-bar', {
    labels: monthKeys.map(m => m.label),
    datasets: orderedKeys.map(sk => ({
      label:           STREAMS[sk]?.label || sk,
      data:            monthKeys.map(m => Math.round(streamMonthMap.get(sk)?.get(m.key) || 0)),
      backgroundColor: STREAMS[sk]?.color || '#8b93b0'
    })),
    stacked: true,
    onClickItem: (label, idx, dsIdx) => {
      const mk  = monthKeys[idx]?.key;
      if (!mk) return;
      const sk  = orderedKeys[dsIdx];
      const rows = base.filter(i => (i.issueDate || i.date || '').slice(0, 7) === mk && i.stream === sk);
      drillDownModal(`${label} — ${STREAMS[sk]?.label || sk}`, toInvDrillRows(rows), INV_DRILL_COLS);
    }
  });
}

// ── Chart 3: Donut — Invoice Status distribution (from kpiBase) ───────────────
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

// ── Chart 4: Horizontal bar — Outstanding per client ─────────────────────────
function renderOutstandingBar({ outstanding }) {
  const map = new Map();
  outstanding.forEach(i => {
    if (!i.clientId) return;
    const cur = map.get(i.clientId) || { eur: 0, name: byId('clients', i.clientId)?.name || 'Unknown', id: i.clientId };
    map.set(i.clientId, { eur: cur.eur + toEUR(i.total, i.currency, i.issueDate), name: cur.name, id: cur.id });
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

// ── Chart 5: Bar — Outstanding Aging ─────────────────────────────────────────
function renderAgingBar({ outstanding }) {
  const today = new Date().toISOString().slice(0, 10);
  const daysDiff = dateStr => {
    if (!dateStr) return 0;
    const ms = new Date(today) - new Date(dateStr);
    return Math.max(0, Math.floor(ms / 86400000));
  };

  const BUCKETS = [
    { label: '0–30 days',  min: 0,  max: 30,       items: [] },
    { label: '31–60 days', min: 31, max: 60,        items: [] },
    { label: '61–90 days', min: 61, max: 90,        items: [] },
    { label: '90+ days',   min: 91, max: Infinity,  items: [] }
  ];
  const AGING_COLORS = [
    'rgba(245,158,11,0.8)',
    'rgba(239,68,68,0.6)',
    'rgba(239,68,68,0.8)',
    'rgba(185,28,28,0.85)'
  ];

  outstanding.forEach(i => {
    const agingDate = i.dueDate || i.issueDate || i.date;
    const days = daysDiff(agingDate);
    for (const b of BUCKETS) {
      if (days >= b.min && days <= b.max) { b.items.push(i); break; }
    }
  });

  if (BUCKETS.every(b => !b.items.length)) return;

  charts.bar('svc-aging-bar', {
    labels: BUCKETS.map(b => b.label),
    datasets: [{
      label:           'Outstanding (EUR)',
      data:            BUCKETS.map(b => Math.round(b.items.reduce((s, i) => s + toEUR(i.total, i.currency, i.issueDate), 0))),
      backgroundColor: AGING_COLORS
    }],
    onClickItem: (_label, idx) => {
      const b = BUCKETS[idx];
      if (!b.items.length) return;
      drillDownModal(`Outstanding — ${b.label}`, toInvDrillRows(b.items), INV_DRILL_COLS);
    }
  });
}

// ── Invoice Records table ─────────────────────────────────────────────────────
function buildInvoiceTable(container, { base }) {
  const today = new Date().toISOString().slice(0, 10);
  const daysDiff = dateStr => {
    if (!dateStr) return 0;
    const ms = new Date(today) - new Date(dateStr);
    return Math.max(0, Math.floor(ms / 86400000));
  };

  const TABLE_COLS = [
    { key: 'number',      label: 'Invoice'                  },
    { key: 'client',      label: 'Client'                   },
    { key: 'stream',      label: 'Stream'                   },
    { key: 'owner',       label: 'Owner'                    },
    { key: 'status',      label: 'Status',      badge: true },
    { key: 'issueDate',   label: 'Issue Date'               },
    { key: 'dueDate',     label: 'Due Date'                 },
    { key: 'amountEUR',   label: 'Amount EUR',  right: true },
    { key: 'overdueDays', label: 'Overdue Days', right: true }
  ];

  const rows = base.map(i => {
    const status  = i.status || 'draft';
    const isOut   = status === 'sent' || status === 'overdue';
    const agingDate = i.dueDate || i.issueDate || i.date;
    const days    = isOut ? daysDiff(agingDate) : 0;
    const ownerKey = i.owner || byId('clients', i.clientId)?.owner;
    return {
      _date:        i.issueDate || i.date,
      _eur:         toEUR(i.total, i.currency, i.issueDate),
      number:       i.number ? `#${i.number}` : '—',
      client:       byId('clients', i.clientId)?.name || '—',
      stream:       STREAMS[i.stream]?.short || i.stream || '—',
      owner:        OWNERS[ownerKey] || ownerKey || '—',
      status:       INVOICE_STATUSES[status]?.label || status,
      _statusCss:   INVOICE_STATUSES[status]?.css || '',
      issueDate:    fmtDate(i.issueDate || i.date),
      dueDate:      i.dueDate ? fmtDate(i.dueDate) : '—',
      amountEUR:    formatEUR(toEUR(i.total, i.currency, i.issueDate)),
      overdueDays:  isOut && days > 0 ? String(days) : '—'
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
