// Services Analytics Dashboard — track CS + Marketing invoice revenue
import { el, buildMultiSelect, button, fmtDate, drillDownModal, attachSortFilter, openModal } from '../core/ui.js';
import * as charts from '../core/charts.js';
import { STREAMS, OWNERS, INVOICE_STATUSES, SERVICE_STREAMS } from '../core/config.js';
import {
  formatEUR, toEUR, byId,
  listActive, listActiveClients
} from '../core/data.js';
import {
  createFilterState, getCurrentPeriodRange, getComparisonRange,
  getMonthKeysForRange, makeMatchers, buildFilterBar, buildComparisonLine
} from './analytics-filters.js?v=20260519';
import { mkSectionLabel, mkSummaryBox, mkModalTable, mkSummaryGrid, mkVarianceBadge, mkEmptyState, mkKpiCard, mkInsightsBanner, safePct } from './analytics-helpers.js';

// ── Filter state ──────────────────────────────────────────────────────────────
let gF = createFilterState();
let gStatusFilter = new Set(); // Invoice Status — local, service-specific

const CHART_IDS     = ['svc-client-bar', 'svc-month-bar', 'svc-status-donut', 'svc-outstanding-bar', 'svc-aging-bar'];
const STATUS_COLORS = { draft: '#8b93b0', sent: '#f59e0b', paid: '#10b981', overdue: '#ef4444' };

let _invoiceTableSortCol = -1, _invoiceTableSortDir = 1;

// ── Module export ─────────────────────────────────────────────────────────────
export default {
  id:    'analytics-services',
  label: 'Services',
  icon:  '🛠️',
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

// ── Service Performance Insights ──────────────────────────────────────────────
function computeServiceInsights({
  paidTotal, invoicedTotal, outstandingTotal, overdueTotal, concentration, topClient, collectionRate, nonDraft, cmpData, cmpRange,
  onClickClientConcentration, onClickCollectionRate, onClickOverdue, onClickOutstanding, onClickPaidRevenue
}) {
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
        inspect: 'Revenue by Client',
        onClick: onClickClientConcentration
      });
    } else if (concentration > 40) {
      signals.push({
        severity: 'Watch',
        title: 'CLIENT CONCENTRATION',
        text: `${topClient.name} accounts for ${concentration.toFixed(0)}% of paid service revenue. Consider diversifying.`,
        inspect: 'Revenue by Client',
        onClick: onClickClientConcentration
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
        inspect: 'Invoice Records',
        onClick: onClickCollectionRate
      });
    } else if (collectionRate < 80) {
      signals.push({
        severity: 'Watch',
        title: 'COLLECTION HEALTH',
        text: `Collection rate is ${collectionRate.toFixed(0)}%. A portion of invoiced revenue remains uncollected.`,
        inspect: 'Invoice Records',
        onClick: onClickCollectionRate
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
      inspect: 'Invoice Records',
      onClick: onClickOverdue
    });
  }

  // Outstanding risk
  if (outstandingTotal > 0 && paidTotal > 0 && outstandingTotal > paidTotal * 0.5) {
    signals.push({
      severity: 'Watch',
      title: 'OUTSTANDING RISK',
      text: `${formatEUR(outstandingTotal)} outstanding — more than 50% of paid revenue. Monitor collection closely.`,
      inspect: 'Outstanding per Client',
      onClick: onClickOutstanding
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
        inspect: 'Monthly Revenue by Stream',
        onClick: onClickPaidRevenue
      });
    } else if (growth !== null && growth > 20) {
      signals.push({
        severity: 'Note',
        title: 'REVENUE GROWTH',
        text: `Paid service revenue grew ${growth.toFixed(0)}% vs ${cmpRange.label}.`,
        inspect: 'Monthly Revenue by Stream',
        onClick: onClickPaidRevenue
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

// ── Stream Performance Card ───────────────────────────────────────────────────
function buildStreamPerformanceCard(kpiBase) {
  const sum = arr => arr.reduce((s, i) => s + toEUR(i.total, i.currency, i.issueDate), 0);

  const streamData = SERVICE_STREAMS.map(k => {
    const streamInvs    = kpiBase.filter(i => i.stream === k);
    const streamPaidInv = streamInvs.filter(i => i.status === 'paid');
    const streamNonDraft = streamInvs.filter(i => i.status !== 'draft');
    const streamOutInv  = streamInvs.filter(i => i.status === 'sent' || i.status === 'overdue');

    const streamPaid         = sum(streamPaidInv);
    const streamInvoiced     = sum(streamNonDraft);
    const streamOutstanding  = sum(streamOutInv);
    const streamCollectionRate = streamInvoiced > 0 ? streamPaid / streamInvoiced * 100 : null;
    const invoiceCount       = streamNonDraft.length;

    // Top client by paid revenue
    const clientRevMap = new Map();
    streamPaidInv.forEach(i => {
      if (!i.clientId) return;
      clientRevMap.set(i.clientId, (clientRevMap.get(i.clientId) || 0) + toEUR(i.total, i.currency, i.issueDate));
    });
    let topClient = null, topClientRev = 0;
    for (const [cid, rev] of clientRevMap.entries()) {
      if (rev > topClientRev) {
        topClientRev = rev;
        topClient = byId('clients', cid)?.name || '—';
      }
    }

    return {
      k, streamPaid, streamInvoiced, streamOutstanding, streamCollectionRate, topClient, invoiceCount,
      streamPaidInv, streamNonDraft, streamOutInv
    };
  });

  // Skip if both streams have zero invoiced revenue
  const totalInvoiced = streamData.reduce((s, d) => s + d.streamInvoiced, 0);
  if (totalInvoiced === 0) {
    return mkEmptyState('No stream invoice activity for the selected period.');
  }

  const card = el('div', { class: 'card mb-16' });
  card.appendChild(el('div', { class: 'card-header' },
    el('div', { class: 'card-title' }, 'Stream Performance')
  ));

  const grid = el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:16px;padding:16px' });

  for (const d of streamData) {
    const cfg   = STREAMS[d.k] || {};
    const color = cfg.color || '#8b93b0';
    const label = cfg.label || d.k;

    const col = el('div', { style: 'display:flex;flex-direction:column;gap:10px' });

    // Stream label header
    col.appendChild(el('div', {
      style: `font-size:12px;font-weight:700;letter-spacing:0.5px;text-transform:uppercase;color:${color};padding-bottom:4px;border-bottom:2px solid ${color}`
    }, label));

    // Summary boxes grid — each opens the stream-filtered version of the matching top-level modal
    const boxGrid = el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:8px' });

    const rateVariant = d.streamCollectionRate === null ? '' :
      d.streamCollectionRate >= 80 ? 'success' :
      d.streamCollectionRate >= 60 ? 'warning' : 'danger';
    const rateLabel = d.streamCollectionRate !== null ? d.streamCollectionRate.toFixed(0) + '%' : '—';

    boxGrid.appendChild(mkKpiCard({
      label:   'Paid Revenue',
      value:   formatEUR(d.streamPaid),
      subtitle: d.invoiceCount > 0 ? `${d.invoiceCount} invoice${d.invoiceCount !== 1 ? 's' : ''}` : null,
      onClick: () => {
        const body = el('div');
        const clientMap = new Map();
        d.streamPaidInv.forEach(i => { const id = i.clientId; const n = byId('clients', id)?.name || 'Unknown'; const x = clientMap.get(id) || { n, v: 0, cnt: 0 }; x.v += toEUR(i.total, i.currency, i.issueDate); x.cnt++; clientMap.set(id, x); });
        const clients = [...clientMap.values()].sort((a, b) => b.v - a.v);
        if (clients.length) {
          body.appendChild(mkSectionLabel('By Client'));
          body.appendChild(mkModalTable(
            ['Client', 'Invoices', 'Revenue', '% of Paid'],
            clients.map(c => [c.n, String(c.cnt), formatEUR(c.v), d.streamPaid > 0 ? (c.v / d.streamPaid * 100).toFixed(1) + '%' : '—'])
          ));
        } else {
          body.appendChild(mkEmptyState('No paid invoices for this stream in the selected period.'));
        }
        openModal({ title: `Paid Revenue — ${label} — ${formatEUR(d.streamPaid)}`, body, large: true });
      }
    }));

    boxGrid.appendChild(mkKpiCard({
      label:   'Collection Rate',
      value:   rateLabel,
      variant: rateVariant,
      subtitle: 'Paid / invoiced',
      onClick: () => {
        const body = el('div');
        const streamOverdueTotal = sum(d.streamOutInv.filter(i => i.status === 'overdue'));
        const sgrid = el('div', { style: 'display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:20px' });
        sgrid.appendChild(mkSummaryBox('Paid', formatEUR(d.streamPaid), d.streamCollectionRate != null ? `${d.streamCollectionRate.toFixed(0)}% collected` : null));
        sgrid.appendChild(mkSummaryBox('Outstanding', formatEUR(d.streamOutstanding), d.streamInvoiced > 0 ? `${(d.streamOutstanding / d.streamInvoiced * 100).toFixed(0)}% of invoiced` : null));
        sgrid.appendChild(mkSummaryBox('Overdue', formatEUR(streamOverdueTotal), d.streamOutstanding > 0 ? `${(streamOverdueTotal / d.streamOutstanding * 100).toFixed(0)}% of outstanding` : null));
        body.appendChild(sgrid);
        const clientMap = new Map();
        d.streamNonDraft.forEach(i => { const id = i.clientId; const n = byId('clients', id)?.name || 'Unknown'; const x = clientMap.get(id) || { n, paid: 0, total: 0 }; x.total += toEUR(i.total, i.currency, i.issueDate); if (i.status === 'paid') x.paid += toEUR(i.total, i.currency, i.issueDate); clientMap.set(id, x); });
        const clients = [...clientMap.values()].sort((a, b) => b.total - a.total);
        if (clients.length) {
          body.appendChild(mkSectionLabel('Collection by Client'));
          body.appendChild(mkModalTable(
            ['Client', 'Invoiced', 'Paid', 'Rate'],
            clients.map(c => [c.n, formatEUR(c.total), formatEUR(c.paid), c.total > 0 ? (c.paid / c.total * 100).toFixed(0) + '%' : '—'])
          ));
        }
        openModal({ title: `Collection Rate — ${label} — ${d.streamCollectionRate != null ? d.streamCollectionRate.toFixed(0) + '%' : 'N/A'}`, body, large: true });
      }
    }));

    boxGrid.appendChild(mkKpiCard({
      label:   'Invoiced',
      value:   formatEUR(d.streamInvoiced),
      onClick: () => {
        const body = el('div');
        const statusMap = new Map();
        d.streamNonDraft.forEach(i => { statusMap.set(i.status, (statusMap.get(i.status) || 0) + toEUR(i.total, i.currency, i.issueDate)); });
        const statuses = [...statusMap.entries()].sort((a, b) => b[1] - a[1]);
        if (statuses.length) {
          const sgrid = el('div', { style: `display:grid;grid-template-columns:repeat(${Math.min(statuses.length, 4)},1fr);gap:10px;margin-bottom:20px` });
          statuses.forEach(([s, v]) => sgrid.appendChild(mkSummaryBox(INVOICE_STATUSES[s]?.label || s, formatEUR(v), d.streamInvoiced > 0 ? `${(v / d.streamInvoiced * 100).toFixed(0)}%` : null)));
          body.appendChild(sgrid);
        }
        const clientMap = new Map();
        d.streamNonDraft.forEach(i => { const id = i.clientId; const n = byId('clients', id)?.name || 'Unknown'; const x = clientMap.get(id) || { n, v: 0, cnt: 0 }; x.v += toEUR(i.total, i.currency, i.issueDate); x.cnt++; clientMap.set(id, x); });
        const clients = [...clientMap.values()].sort((a, b) => b.v - a.v);
        if (clients.length) {
          body.appendChild(mkSectionLabel('By Client'));
          body.appendChild(mkModalTable(
            ['Client', 'Invoices', 'Invoiced', '% of Total'],
            clients.map(c => [c.n, String(c.cnt), formatEUR(c.v), d.streamInvoiced > 0 ? (c.v / d.streamInvoiced * 100).toFixed(1) + '%' : '—'])
          ));
        }
        openModal({ title: `Invoiced Revenue — ${label} — ${formatEUR(d.streamInvoiced)}`, body, large: true });
      }
    }));

    boxGrid.appendChild(mkKpiCard({
      label:   'Outstanding',
      value:   formatEUR(d.streamOutstanding),
      variant: d.streamOutstanding > 0 ? 'warning' : '',
      onClick: () => {
        const body = el('div');
        const clientMap = new Map();
        d.streamOutInv.forEach(i => { const id = i.clientId; const n = byId('clients', id)?.name || 'Unknown'; const x = clientMap.get(id) || { n, v: 0, overdue: 0, cnt: 0 }; x.v += toEUR(i.total, i.currency, i.issueDate); if (i.status === 'overdue') x.overdue += toEUR(i.total, i.currency, i.issueDate); x.cnt++; clientMap.set(id, x); });
        const clients = [...clientMap.values()].sort((a, b) => b.v - a.v);
        if (clients.length) {
          body.appendChild(mkSectionLabel('Outstanding by Client'));
          body.appendChild(mkModalTable(
            ['Client', 'Invoices', 'Outstanding', 'Overdue'],
            clients.map(c => [c.n, String(c.cnt), formatEUR(c.v), c.overdue > 0 ? formatEUR(c.overdue) : '—'])
          ));
        } else {
          body.appendChild(mkEmptyState('No outstanding invoices for this stream.'));
        }
        openModal({ title: `Outstanding — ${label} — ${formatEUR(d.streamOutstanding)}`, body, large: true });
      }
    }));

    col.appendChild(boxGrid);

    // Top client line
    const topClientEl = el('div', { style: 'font-size:11px;color:var(--text-muted);margin-top:2px' });
    topClientEl.appendChild(el('span', { style: 'font-weight:600' }, 'Top client: '));
    topClientEl.appendChild(document.createTextNode(d.topClient || '—'));
    col.appendChild(topClientEl);

    grid.appendChild(col);
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
  const onClickPaidRevenue = () => {
    const body = el('div');
    const streamMap = new Map();
    paid.forEach(i => { const s = i.stream; streamMap.set(s, (streamMap.get(s) || 0) + toEUR(i.total, i.currency, i.issueDate)); });
    const streams = [...streamMap.entries()].sort((a, b) => b[1] - a[1]);
    if (streams.length > 1) {
      const sgrid = el('div', { style: `display:grid;grid-template-columns:repeat(${Math.min(streams.length, 3)},1fr);gap:10px;margin-bottom:20px` });
      streams.forEach(([s, v]) => sgrid.appendChild(mkSummaryBox(STREAMS[s]?.label || s, formatEUR(v), paidTotal > 0 ? `${(v / paidTotal * 100).toFixed(0)}%` : null)));
      body.appendChild(sgrid);
    }
    const clientMap = new Map();
    paid.forEach(i => { const id = i.clientId; const n = byId('clients', id)?.name || 'Unknown'; const x = clientMap.get(id) || { n, v: 0, cnt: 0 }; x.v += toEUR(i.total, i.currency, i.issueDate); x.cnt++; clientMap.set(id, x); });
    const clients = [...clientMap.values()].sort((a, b) => b.v - a.v);
    if (clients.length) {
      body.appendChild(mkSectionLabel('By Client'));
      body.appendChild(mkModalTable(
        ['Client', 'Invoices', 'Revenue', '% of Paid'],
        clients.map(c => [c.n, String(c.cnt), formatEUR(c.v), paidTotal > 0 ? (c.v / paidTotal * 100).toFixed(1) + '%' : '—'])
      ));
    }
    openModal({ title: `Paid Revenue — ${formatEUR(paidTotal)}`, body, large: true });
  };
  kpiRow1.appendChild(mkKpiCard({
    label:     'Paid Revenue',
    value:     formatEUR(paidTotal),
    variant:   'success',
    delta:     deltaPaid,
    compLabel: cmpRange?.label,
    compValue: cmpData ? formatEUR(cmpData.paidTotal) : undefined,
    onClick:   onClickPaidRevenue
  }));
  kpiRow1.appendChild(mkKpiCard({
    label:     'Invoiced Revenue',
    value:     formatEUR(invoicedTotal),
    delta:     deltaInvoiced,
    compLabel: cmpRange?.label,
    compValue: cmpData ? formatEUR(cmpData.invoicedTotal) : undefined,
    onClick:   () => {
      const body = el('div');
      const statusMap = new Map();
      nonDraft.forEach(i => { statusMap.set(i.status, (statusMap.get(i.status) || 0) + toEUR(i.total, i.currency, i.issueDate)); });
      const statuses = [...statusMap.entries()].sort((a, b) => b[1] - a[1]);
      if (statuses.length) {
        const sgrid = el('div', { style: `display:grid;grid-template-columns:repeat(${Math.min(statuses.length, 4)},1fr);gap:10px;margin-bottom:20px` });
        statuses.forEach(([s, v]) => sgrid.appendChild(mkSummaryBox(INVOICE_STATUSES[s]?.label || s, formatEUR(v), invoicedTotal > 0 ? `${(v / invoicedTotal * 100).toFixed(0)}%` : null)));
        body.appendChild(sgrid);
      }
      const clientMap = new Map();
      nonDraft.forEach(i => { const id = i.clientId; const n = byId('clients', id)?.name || 'Unknown'; const x = clientMap.get(id) || { n, v: 0, cnt: 0 }; x.v += toEUR(i.total, i.currency, i.issueDate); x.cnt++; clientMap.set(id, x); });
      const clients = [...clientMap.values()].sort((a, b) => b.v - a.v);
      if (clients.length) {
        body.appendChild(mkSectionLabel('By Client'));
        body.appendChild(mkModalTable(
          ['Client', 'Invoices', 'Invoiced', '% of Total'],
          clients.map(c => [c.n, String(c.cnt), formatEUR(c.v), invoicedTotal > 0 ? (c.v / invoicedTotal * 100).toFixed(1) + '%' : '—'])
        ));
      }
      openModal({ title: `Invoiced Revenue — ${formatEUR(invoicedTotal)}`, body, large: true });
    }
  }));
  const onClickCollectionRate = () => {
    const body = el('div');
    const sgrid = el('div', { style: 'display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:20px' });
    sgrid.appendChild(mkSummaryBox('Paid', formatEUR(paidTotal), collectionRate != null ? `${collectionRate.toFixed(0)}% collected` : null));
    sgrid.appendChild(mkSummaryBox('Outstanding', formatEUR(outstandingTotal), invoicedTotal > 0 ? `${(outstandingTotal / invoicedTotal * 100).toFixed(0)}% of invoiced` : null));
    sgrid.appendChild(mkSummaryBox('Overdue', formatEUR(overdueTotal), outstandingTotal > 0 ? `${(overdueTotal / outstandingTotal * 100).toFixed(0)}% of outstanding` : null));
    body.appendChild(sgrid);
    const clientMap = new Map();
    nonDraft.forEach(i => { const id = i.clientId; const n = byId('clients', id)?.name || 'Unknown'; const x = clientMap.get(id) || { n, paid: 0, total: 0 }; x.total += toEUR(i.total, i.currency, i.issueDate); if (i.status === 'paid') x.paid += toEUR(i.total, i.currency, i.issueDate); clientMap.set(id, x); });
    const clients = [...clientMap.values()].sort((a, b) => b.total - a.total);
    if (clients.length) {
      body.appendChild(mkSectionLabel('Collection by Client'));
      body.appendChild(mkModalTable(
        ['Client', 'Invoiced', 'Paid', 'Rate'],
        clients.map(c => [c.n, formatEUR(c.total), formatEUR(c.paid), c.total > 0 ? (c.paid / c.total * 100).toFixed(0) + '%' : '—'])
      ));
    }
    openModal({ title: `Collection Rate — ${collectionRate != null ? collectionRate.toFixed(0) + '%' : 'N/A'}`, body, large: true });
  };
  kpiRow1.appendChild(mkKpiCard({
    label:     'Collection Rate',
    value:     collectionRate !== null ? collectionRate.toFixed(0) + '%' : '—',
    variant:   collectionRate !== null && collectionRate < 60 ? 'danger' : collectionRate !== null && collectionRate < 80 ? 'warning' : '',
    subtitle:  'Paid / invoiced revenue',
    delta:     deltaCollection,
    deltaIsPp: true,
    compLabel: cmpRange?.label,
    compValue: cmpData?.collectionRate != null ? cmpData.collectionRate.toFixed(0) + '%' : undefined,
    onClick:   onClickCollectionRate
  }));
  const onClickOutstanding = () => {
    const body = el('div');
    const clientMap = new Map();
    outstanding.forEach(i => { const id = i.clientId; const n = byId('clients', id)?.name || 'Unknown'; const x = clientMap.get(id) || { n, v: 0, overdue: 0, cnt: 0 }; x.v += toEUR(i.total, i.currency, i.issueDate); if (i.status === 'overdue') x.overdue += toEUR(i.total, i.currency, i.issueDate); x.cnt++; clientMap.set(id, x); });
    const clients = [...clientMap.values()].sort((a, b) => b.v - a.v);
    if (clients.length) {
      body.appendChild(mkSectionLabel('Outstanding by Client'));
      body.appendChild(mkModalTable(
        ['Client', 'Invoices', 'Outstanding', 'Overdue'],
        clients.map(c => [c.n, String(c.cnt), formatEUR(c.v), c.overdue > 0 ? formatEUR(c.overdue) : '—'])
      ));
    }
    openModal({ title: `Outstanding — ${formatEUR(outstandingTotal)}`, body, large: true });
  };
  kpiRow1.appendChild(mkKpiCard({
    label:       'Outstanding',
    value:       formatEUR(outstandingTotal),
    variant:     outstandingTotal > 0 ? 'warning' : '',
    delta:       deltaOutstanding,
    invertDelta: true,
    compLabel:   cmpRange?.label,
    compValue:   cmpData ? formatEUR(cmpData.outstandingTotal) : undefined,
    onClick:     onClickOutstanding
  }));
  wrap.appendChild(kpiRow1);

  // ── KPI row 2: Overdue, Client Concentration, Top Client, Active Clients ───
  const concVariant = concentration === null ? '' : concentration > 60 ? 'danger' : concentration > 40 ? 'warning' : 'success';
  const kpiRow2 = el('div', { class: 'grid grid-4 mb-16' });
  const onClickOverdue = () => {
    const body = el('div');
    const clientMap = new Map();
    overdue.forEach(i => { const id = i.clientId; const n = byId('clients', id)?.name || 'Unknown'; const x = clientMap.get(id) || { n, v: 0, cnt: 0 }; x.v += toEUR(i.total, i.currency, i.issueDate); x.cnt++; clientMap.set(id, x); });
    const clients = [...clientMap.values()].sort((a, b) => b.v - a.v);
    if (clients.length) {
      body.appendChild(mkSectionLabel('Overdue by Client'));
      body.appendChild(mkModalTable(
        ['Client', 'Invoices', 'Overdue Amount', '% of Total Overdue'],
        clients.map(c => [c.n, String(c.cnt), formatEUR(c.v), overdueTotal > 0 ? (c.v / overdueTotal * 100).toFixed(1) + '%' : '—'])
      ));
    } else {
      body.appendChild(el('div', { style: 'color:var(--text-muted);font-size:13px' }, 'No overdue invoices for the selected period.'));
    }
    openModal({ title: `Overdue — ${formatEUR(overdueTotal)}`, body, large: true });
  };
  kpiRow2.appendChild(mkKpiCard({
    label:   'Overdue',
    value:   formatEUR(overdueTotal),
    variant: overdueTotal > 0 ? 'danger' : '',
    onClick: onClickOverdue
  }));
  const onClickClientConcentration = () => drillDownModal('Revenue by Client', toClientConcentrationRows(clientRevMap, paidTotal), CONCENTRATION_DRILL_COLS);
  kpiRow2.appendChild(mkKpiCard({
    label:   'Client Concentration',
    value:   concentration !== null ? concentration.toFixed(0) + '%' : '—',
    variant: concVariant,
    subtitle: 'Top client share of paid revenue',
    onClick: onClickClientConcentration
  }));
  kpiRow2.appendChild(mkKpiCard({
    label:   'Top Client',
    value:   topClient ? topClient.name : '—',
    subtitle: topClient ? `${formatEUR(topClient.rev)} · ${concentration !== null ? concentration.toFixed(0) + '%' : '—'} of paid` : null,
    onClick: () => {
      if (!topClient) return;
      const topInvs = kpiBase.filter(i => i.clientId === topClient.clientId);
      const paid_ = topInvs.filter(i => i.status === 'paid').reduce((s, i) => s + toEUR(i.total, i.currency, i.issueDate), 0);
      const out_ = topInvs.filter(i => ['sent', 'overdue'].includes(i.status)).reduce((s, i) => s + toEUR(i.total, i.currency, i.issueDate), 0);
      const inv_ = topInvs.filter(i => i.status !== 'draft').reduce((s, i) => s + toEUR(i.total, i.currency, i.issueDate), 0);
      const body = el('div');
      const sgrid = el('div', { style: 'display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:20px' });
      sgrid.appendChild(mkSummaryBox('Invoiced', formatEUR(inv_), null));
      sgrid.appendChild(mkSummaryBox('Paid', formatEUR(paid_), inv_ > 0 ? `${(paid_ / inv_ * 100).toFixed(0)}% collected` : null));
      sgrid.appendChild(mkSummaryBox('Outstanding', formatEUR(out_), out_ > 0 ? 'Follow-up needed' : 'None'));
      body.appendChild(sgrid);
      const streamMap = new Map();
      topInvs.filter(i => i.status !== 'draft').forEach(i => { streamMap.set(i.stream, (streamMap.get(i.stream) || 0) + toEUR(i.total, i.currency, i.issueDate)); });
      const streams = [...streamMap.entries()].sort((a, b) => b[1] - a[1]);
      if (streams.length) {
        body.appendChild(mkSectionLabel('By Stream'));
        body.appendChild(mkModalTable(
          ['Stream', 'Invoiced'],
          streams.map(([s, v]) => [STREAMS[s]?.label || s, formatEUR(v)])
        ));
      }
      openModal({ title: `${topClient.name} — Client Profile`, body, large: true });
    }
  }));
  kpiRow2.appendChild(mkKpiCard({
    label:   'Active Clients',
    value:   String(activeClientIds.size),
    subtitle: 'Clients with invoiced activity',
    onClick: () => drillDownModal('Client Summary', toActiveClientRows(kpiBase), ACTIVE_CLIENT_DRILL_COLS)
  }));
  wrap.appendChild(kpiRow2);

  // ── KPI row 3: DSO, Avg Invoice Size, New vs Recurring Clients ───────────
  // Fix 4 — Days Sales Outstanding: (Outstanding / Invoiced) × Days in Period
  const periodDays = Math.round((new Date(end) - new Date(start)) / 86400000) + 1;
  const dso = invoicedTotal > 0 ? (outstandingTotal / invoicedTotal) * periodDays : null;
  const dsoVariant = dso === null ? '' : dso < 30 ? 'success' : dso <= 60 ? 'warning' : 'danger';
  const dsoSubtitle = dso === null ? 'No invoiced activity' :
    dso < 30  ? 'Healthy collection speed' :
    dso <= 60 ? 'Review follow-up cadence' : 'Collections at risk';

  // Fix 6 — Average Invoice Size: total invoiced ÷ count of non-draft invoices
  const avgInvValue = nonDraft.length > 0 ? invoicedTotal / nonDraft.length : null;
  const deltaAvgInv = (avgInvValue !== null && cmpData && cmpData.nonDraft.length > 0)
    ? safePct(avgInvValue, cmpData.invoicedTotal / cmpData.nonDraft.length) : null;

  // Draft invoice totals for Fix 6 draft summary
  const draftInvs  = kpiBase.filter(i => i.status === 'draft');
  const draftCount = draftInvs.length;
  const draftTotal = draftInvs.reduce((s, i) => s + toEUR(i.total, i.currency, i.issueDate), 0);

  // New vs Recurring Clients: compare clientIds in kpiBase against ALL historical invoices
  const allHistoricalInvs = listActive('invoices').filter(i => SERVICE_STREAMS.includes(i.stream));
  const periodStart = start;
  const clientsBeforePeriod = new Set(
    allHistoricalInvs
      .filter(i => (i.issueDate || i.date || '').slice(0, 10) < periodStart)
      .map(i => i.clientId)
      .filter(Boolean)
  );
  const periodClientIds = new Set(nonDraft.map(i => i.clientId).filter(Boolean));
  const newClientIds       = [...periodClientIds].filter(id => !clientsBeforePeriod.has(id));
  const recurringClientIds = [...periodClientIds].filter(id =>  clientsBeforePeriod.has(id));

  const newClientRevenue = nonDraft
    .filter(i => newClientIds.includes(i.clientId))
    .reduce((s, i) => s + toEUR(i.total, i.currency, i.issueDate), 0);
  const recurringClientRevenue = nonDraft
    .filter(i => recurringClientIds.includes(i.clientId))
    .reduce((s, i) => s + toEUR(i.total, i.currency, i.issueDate), 0);

  const kpiRow3 = el('div', { class: 'grid grid-4 mb-16' });

  // Fix 4 — DSO KPI card
  kpiRow3.appendChild(mkKpiCard({
    label:   'Days Sales Outstanding',
    value:   dso !== null ? `${Math.round(dso)}d` : '—',
    variant: dsoVariant,
    subtitle: dsoSubtitle,
    onClick: () => {
      const body = el('div');
      body.appendChild(mkSectionLabel('DSO Formula'));
      body.appendChild(mkModalTable(
        [{ label: 'Metric' }, { label: 'Value', right: true }],
        [
          ['Outstanding Invoices Balance', formatEUR(outstandingTotal)],
          ['Total Invoiced (non-draft)',    formatEUR(invoicedTotal)],
          ['Days in Period',               String(periodDays)],
          ['DSO = (Outstanding / Invoiced) × Days', dso !== null ? `${Math.round(dso)} days` : '—']
        ]
      ));
      // Per-client DSO
      const clientDsoMap = new Map();
      nonDraft.forEach(i => {
        if (!i.clientId) return;
        const id = i.clientId;
        const eur = toEUR(i.total, i.currency, i.issueDate);
        const rec = clientDsoMap.get(id) || { invoiced: 0, outstanding: 0 };
        rec.invoiced += eur;
        if (i.status === 'sent' || i.status === 'overdue') rec.outstanding += eur;
        clientDsoMap.set(id, rec);
      });
      const clientDsoRows = [...clientDsoMap.entries()]
        .map(([cid, d]) => ({
          client: byId('clients', cid)?.name || '—',
          dso: d.invoiced > 0 ? (d.outstanding / d.invoiced) * periodDays : 0,
          outstanding: d.outstanding,
          invoiced: d.invoiced
        }))
        .filter(r => r.outstanding > 0)
        .sort((a, b) => b.dso - a.dso);

      if (clientDsoRows.length) {
        body.appendChild(mkSectionLabel('Per-Client DSO (worst first)'));
        body.appendChild(mkModalTable(
          [
            { label: 'Client' },
            { label: 'DSO (days)', right: true },
            { label: 'Outstanding', right: true },
            { label: 'Invoiced', right: true, muted: true }
          ],
          clientDsoRows.map(r => [
            r.client,
            String(Math.round(r.dso)),
            formatEUR(r.outstanding),
            formatEUR(r.invoiced)
          ])
        ));
      } else {
        body.appendChild(el('div', { style: 'color:var(--text-muted);font-size:13px;margin-top:12px' }, 'No outstanding invoices — DSO is 0.'));
      }
      openModal({ title: `Days Sales Outstanding — ${dso !== null ? Math.round(dso) + 'd' : 'N/A'}`, body, large: true });
    }
  }));

  // Fix 6 — Average Invoice Size KPI
  kpiRow3.appendChild(mkKpiCard({
    label:    'Avg Invoice Size',
    value:    nonDraft.length > 0 ? formatEUR(invoicedTotal / nonDraft.length) : '—',
    subtitle: avgInvValue !== null ? `${nonDraft.length} invoice${nonDraft.length !== 1 ? 's' : ''}` : 'No invoices',
    delta:    deltaAvgInv,
    compLabel: cmpRange?.label,
    compValue: (cmpData && cmpData.nonDraft.length > 0) ? formatEUR(cmpData.invoicedTotal / cmpData.nonDraft.length) : undefined,
    onClick:  () => {
      const body = el('div');

      // Top 5 largest invoices
      const top5 = [...nonDraft]
        .map(i => ({ i, eur: toEUR(i.total, i.currency, i.issueDate) }))
        .sort((a, b) => b.eur - a.eur)
        .slice(0, 5);

      if (top5.length) {
        body.appendChild(mkSectionLabel('Top 5 Largest Invoices'));
        body.appendChild(mkModalTable(
          [
            { label: 'Client' },
            { label: 'Issue Date' },
            { label: 'Amount', right: true }
          ],
          top5.map(({ i, eur }) => [
            byId('clients', i.clientId)?.name || '—',
            fmtDate(i.issueDate || i.date),
            formatEUR(eur)
          ])
        ));
      }

      // Distribution buckets
      const DIST_BUCKETS = [
        { label: '0 – 500',   min: 0,    max: 500,      items: [] },
        { label: '500 – 1k',  min: 500,  max: 1000,     items: [] },
        { label: '1k – 5k',   min: 1000, max: 5000,     items: [] },
        { label: '5k+',       min: 5000, max: Infinity,  items: [] }
      ];
      nonDraft.forEach(i => {
        const eur = toEUR(i.total, i.currency, i.issueDate);
        for (const b of DIST_BUCKETS) {
          if (eur >= b.min && eur < b.max) { b.items.push({ i, eur }); break; }
        }
      });

      body.appendChild(mkSectionLabel('Invoice Distribution'));
      body.appendChild(mkModalTable(
        [
          { label: 'Range' },
          { label: 'Count', right: true },
          { label: 'Total', right: true },
          { label: '% of Invoiced', right: true, muted: true }
        ],
        DIST_BUCKETS.map(b => {
          const bTotal = b.items.reduce((s, x) => s + x.eur, 0);
          return [
            b.label,
            String(b.items.length),
            b.items.length ? formatEUR(bTotal) : '—',
            invoicedTotal > 0 && b.items.length ? (bTotal / invoicedTotal * 100).toFixed(1) + '%' : '—'
          ];
        })
      ));

      openModal({ title: `Avg Invoice Size — ${avgInvValue !== null ? formatEUR(avgInvValue) : 'N/A'}`, body, large: true });
    }
  }));

  // New vs Recurring Clients KPI
  kpiRow3.appendChild(mkKpiCard({
    label:   'New vs Recurring',
    value:   `${newClientIds.length} new / ${recurringClientIds.length} recurring`,
    variant: 'info',
    subtitle: 'Clients in selected period',
    onClick: () => {
      const body = el('div');
      const sgrid = el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:20px' });
      sgrid.appendChild(mkSummaryBox('New Client Revenue',       formatEUR(newClientRevenue),       `${newClientIds.length} client(s)`));
      sgrid.appendChild(mkSummaryBox('Recurring Client Revenue', formatEUR(recurringClientRevenue), `${recurringClientIds.length} client(s)`));
      body.appendChild(sgrid);

      if (newClientIds.length) {
        body.appendChild(mkSectionLabel('New Clients (first invoice in period)'));
        const newRows = newClientIds.map(id => {
          const name = byId('clients', id)?.name || '—';
          const invs = nonDraft.filter(i => i.clientId === id);
          const rev  = invs.reduce((s, i) => s + toEUR(i.total, i.currency, i.issueDate), 0);
          return { name, rev, count: invs.length };
        }).sort((a, b) => b.rev - a.rev);
        body.appendChild(mkModalTable(
          [{ label: 'Client' }, { label: 'Invoices', right: true, muted: true }, { label: 'Revenue', right: true }],
          newRows.map(r => [r.name, String(r.count), formatEUR(r.rev)])
        ));
      }

      if (recurringClientIds.length) {
        body.appendChild(mkSectionLabel('Recurring Clients (with historical revenue)'));
        const recurRows = recurringClientIds.map(id => {
          const name = byId('clients', id)?.name || '—';
          const periodInvs = nonDraft.filter(i => i.clientId === id);
          const periodRev  = periodInvs.reduce((s, i) => s + toEUR(i.total, i.currency, i.issueDate), 0);
          const allInvs    = allHistoricalInvs.filter(i => i.clientId === id && i.status !== 'draft');
          const histRev    = allInvs.reduce((s, i) => s + toEUR(i.total, i.currency, i.issueDate), 0);
          return { name, periodRev, histRev, count: periodInvs.length };
        }).sort((a, b) => b.histRev - a.histRev);
        body.appendChild(mkModalTable(
          [
            { label: 'Client' },
            { label: 'Period Revenue', right: true },
            { label: 'Historical Revenue', right: true, muted: true }
          ],
          recurRows.map(r => [r.name, formatEUR(r.periodRev), formatEUR(r.histRev)])
        ));
      }

      openModal({ title: 'New vs Recurring Clients', body, large: true });
    }
  }));

  // 4th slot — leave empty (grid-4 still looks balanced with 3)
  kpiRow3.appendChild(el('div'));

  wrap.appendChild(kpiRow3);

  // Fix 6 — Draft summary line (always show draft count/amount so they are visible)
  if (draftCount > 0) {
    wrap.appendChild(el('div', {
      style: 'font-size:12px;color:var(--text-muted);margin:-8px 0 16px;padding:6px 10px;background:var(--bg-elev-1);border:1px solid var(--border);border-radius:var(--radius-sm);display:inline-block'
    }, `${draftCount} draft${draftCount !== 1 ? 's' : ''} · ${formatEUR(draftTotal)} not yet sent`));
  }

  // ── Stream Performance ────────────────────────────────────────────────────
  const streamPerfCard = buildStreamPerformanceCard(kpiBase);
  if (streamPerfCard) wrap.appendChild(streamPerfCard);

  // ── Service Performance Insights ──────────────────────────────────────────
  const signals = computeServiceInsights({
    paidTotal, invoicedTotal, outstandingTotal, overdueTotal,
    concentration, topClient, collectionRate, nonDraft, cmpData, cmpRange,
    onClickClientConcentration, onClickCollectionRate, onClickOverdue, onClickOutstanding, onClickPaidRevenue
  });
  wrap.appendChild(mkInsightsBanner(signals, 'Service Performance Insights'));

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
  const svcTableHeader = el('div', { class: 'card-header', style: 'cursor:pointer;user-select:none;display:flex;align-items:center;justify-content:space-between' });
  const svcHeaderLeft = el('div', { style: 'display:flex;align-items:center;gap:16px' });
  svcHeaderLeft.appendChild(el('div', { class: 'card-title' }, 'Invoice Records'));
  svcHeaderLeft.appendChild(el('div', { style: 'font-size:12px;color:var(--text-muted)' },
    gStatusFilter.size > 0 ? 'Status filter active' : 'All statuses'
  ));
  svcTableHeader.appendChild(svcHeaderLeft);
  const svcChevron = el('span', { style: 'font-size:11px;color:var(--text-muted);display:inline-block;transition:transform 200ms' }, '▼');
  svcTableHeader.appendChild(svcChevron);
  tableCard.appendChild(svcTableHeader);
  const svcTableBody = el('div');
  buildInvoiceTable(svcTableBody, curData);
  tableCard.appendChild(svcTableBody);
  let svcCollapsed = false;
  svcTableHeader.onclick = () => {
    svcCollapsed = !svcCollapsed;
    svcTableBody.style.display = svcCollapsed ? 'none' : '';
    svcChevron.style.transform = svcCollapsed ? 'rotate(-90deg)' : '';
  };
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
function renderClientBar({ paid, kpiBase }) {
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
      const clientInvs = kpiBase.filter(i => i.clientId === d.id);
      const out_ = clientInvs.filter(i => ['sent', 'overdue'].includes(i.status)).reduce((s, i) => s + toEUR(i.total, i.currency, i.issueDate), 0);
      const inv_ = clientInvs.filter(i => i.status !== 'draft').reduce((s, i) => s + toEUR(i.total, i.currency, i.issueDate), 0);
      const body = el('div');
      const sgrid = el('div', { style: 'display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:20px' });
      sgrid.appendChild(mkSummaryBox('Paid Revenue', formatEUR(d.eur), null));
      sgrid.appendChild(mkSummaryBox('Outstanding', formatEUR(out_), null));
      sgrid.appendChild(mkSummaryBox('Collection Rate', inv_ > 0 ? `${(d.eur / inv_ * 100).toFixed(0)}%` : '—', null));
      body.appendChild(sgrid);
      const streamMap = new Map();
      clientInvs.filter(i => i.status === 'paid').forEach(i => { streamMap.set(i.stream, (streamMap.get(i.stream) || 0) + toEUR(i.total, i.currency, i.issueDate)); });
      const streams = [...streamMap.entries()].sort((a, b) => b[1] - a[1]);
      if (streams.length) {
        body.appendChild(mkSectionLabel('By Stream (Paid)'));
        body.appendChild(mkModalTable(
          [{ label: 'Stream' }, { label: 'Revenue', right: true }, { label: '% of Paid', right: true, muted: true }],
          streams.map(([s, v]) => [STREAMS[s]?.label || s, formatEUR(v), d.eur > 0 ? (v / d.eur * 100).toFixed(0) + '%' : '—'])
        ));
      }
      openModal({ title: `${d.name} — Client Profile`, body, large: true });
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
      const mk = monthKeys[idx]?.key;
      if (!mk) return;
      const sk = orderedKeys[dsIdx];
      const streamRows = base.filter(i => (i.issueDate || i.date || '').slice(0, 7) === mk && i.stream === sk);
      const streamTotal = streamRows.reduce((s, i) => s + toEUR(i.total, i.currency, i.issueDate), 0);
      const body = el('div');
      const statusMap = new Map();
      streamRows.forEach(i => { statusMap.set(i.status, (statusMap.get(i.status) || 0) + toEUR(i.total, i.currency, i.issueDate)); });
      const statuses = [...statusMap.entries()].sort((a, b) => b[1] - a[1]);
      if (statuses.length) {
        const sgrid = el('div', { style: `display:grid;grid-template-columns:repeat(${Math.min(statuses.length, 4)},1fr);gap:10px;margin-bottom:20px` });
        statuses.forEach(([s, v]) => sgrid.appendChild(mkSummaryBox(INVOICE_STATUSES[s]?.label || s, formatEUR(v), streamTotal > 0 ? `${(v / streamTotal * 100).toFixed(0)}%` : null)));
        body.appendChild(sgrid);
      }
      const clientMap = new Map();
      streamRows.forEach(i => { const id = i.clientId; const n = byId('clients', id)?.name || 'Unknown'; const x = clientMap.get(id) || { n, v: 0 }; x.v += toEUR(i.total, i.currency, i.issueDate); clientMap.set(id, x); });
      const clients = [...clientMap.values()].sort((a, b) => b.v - a.v);
      if (clients.length) {
        body.appendChild(mkSectionLabel(`${STREAMS[sk]?.label || sk} — By Client`));
        body.appendChild(mkModalTable(
          [{ label: 'Client' }, { label: 'Revenue', right: true }, { label: '% of Stream', right: true, muted: true }],
          clients.map(c => [c.n, formatEUR(c.v), streamTotal > 0 ? (c.v / streamTotal * 100).toFixed(0) + '%' : '—'])
        ));
      }
      openModal({ title: `${label} — ${STREAMS[sk]?.label || sk}`, body, large: true });
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

      const bucketTotal = b.items.reduce((s, i) => s + toEUR(i.total, i.currency, i.issueDate), 0);

      // Build client-level aggregation
      const clientMap = new Map();
      b.items.forEach(i => {
        const id = i.clientId;
        const name = byId('clients', id)?.name || 'Unknown';
        const eur = toEUR(i.total, i.currency, i.issueDate);
        const due = i.dueDate || i.issueDate || i.date || '';
        const existing = clientMap.get(id) || { name, total: 0, count: 0, oldestDue: '' };
        existing.total += eur;
        existing.count++;
        if (!existing.oldestDue || due < existing.oldestDue) existing.oldestDue = due;
        clientMap.set(id, existing);
      });
      const clientRows = [...clientMap.values()].sort((a, b2) => b2.total - a.total);

      const body = el('div');
      const sgrid = el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:20px' });
      sgrid.appendChild(mkSummaryBox('Invoices in Bucket', String(b.items.length), null));
      sgrid.appendChild(mkSummaryBox('Total Outstanding', formatEUR(bucketTotal), null));
      body.appendChild(sgrid);

      body.appendChild(mkSectionLabel('By Client (worst first)'));
      body.appendChild(mkModalTable(
        [
          { label: 'Client' },
          { label: 'Invoices', right: true, muted: true },
          { label: 'Outstanding', right: true },
          { label: 'Oldest Due Date', right: true, muted: true }
        ],
        clientRows.map(c => [
          c.name,
          String(c.count),
          formatEUR(c.total),
          c.oldestDue ? fmtDate(c.oldestDue) : '—'
        ])
      ));

      // Fix 5 — Individual invoice rows, sorted by days outstanding descending
      const today2 = new Date().toISOString().slice(0, 10);
      const invRows = b.items.map(i => {
        const agingDate = i.dueDate || i.issueDate || i.date;
        const daysOut = agingDate
          ? Math.max(0, Math.floor((new Date(today2) - new Date(agingDate)) / 86400000))
          : 0;
        return {
          client:   byId('clients', i.clientId)?.name || '—',
          issueDate: i.issueDate || i.date || '',
          dueDate:  i.dueDate || '',
          daysOut,
          eur:      toEUR(i.total, i.currency, i.issueDate)
        };
      }).sort((a, b2) => b2.daysOut - a.daysOut);

      body.appendChild(mkSectionLabel('Individual Invoices (oldest first)'));
      body.appendChild(mkModalTable(
        [
          { label: 'Client' },
          { label: 'Invoice Date' },
          { label: 'Due Date' },
          { label: 'Days Outstanding', right: true },
          { label: 'Amount', right: true }
        ],
        invRows.map(r => [
          r.client,
          r.issueDate ? fmtDate(r.issueDate) : '—',
          r.dueDate   ? fmtDate(r.dueDate)   : '—',
          String(r.daysOut),
          formatEUR(r.eur)
        ])
      ));

      openModal({ title: `Aging — ${b.label}`, body, large: true });
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
  attachSortFilter(tableWrap, { initialCol: _invoiceTableSortCol, initialDir: _invoiceTableSortDir, onSortChange: (c, d) => { _invoiceTableSortCol = c; _invoiceTableSortDir = d; } });

  const totalEUR = rows.reduce((s, r) => s + r._eur, 0);
  container.appendChild(el('div', {
    style: 'display:flex;justify-content:space-between;margin-top:8px;font-size:13px'
  },
    el('span', { style: 'color:var(--text-muted)' }, `${rows.length} record(s)`),
    el('strong', { class: 'num' }, `Total: ${formatEUR(totalEUR)}`)
  ));
}
