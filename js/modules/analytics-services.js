// Services Analytics Dashboard — track CS + Marketing invoice revenue
import { el, buildMultiSelect, button, fmtDate, drillDownModal, attachSortFilter, openModal } from '../core/ui.js';
import * as charts from '../core/charts.js';
import { STREAMS, OWNERS, INVOICE_STATUSES, SERVICE_STREAMS } from '../core/config.js';
import {
  formatEUR, toEUR, byId,
  listActive, listActiveClients
} from '../core/data.js';
import { getMonthKeysForRange, makeMatchers } from './analytics-filters.js?v=20260519';
import { mkSectionLabel, mkSummaryBox, mkModalTable, mkSummaryGrid, mkVarianceBadge, mkEmptyState, mkKpiCard, mkInsightsBanner, safePct, mkTh } from './analytics-helpers.js';

// ── Filter state ──────────────────────────────────────────────────────────────
// Period/Owner/Stream/Client all come from Revenue's own shared filter state
// now (passed into buildServicesSection) rather than a second, independent
// filter bar stacked on the same page — see buildServicesSection below.
// Invoice Status has no Revenue-side equivalent, so it stays local.
let gStatusFilter = new Set();

// Clears this section's local invoice-status filter (state + its persisted
// localStorage key). This section has no buildFilterBar() call of its own —
// it's embedded in the host dashboard's page (see buildServicesSection below)
// and shares that page's filter bar — so the host's buildFilterBar() Reset
// button needs to invoke this via the `extraReset` hook (see
// analytics-filters.js) for Reset to actually clear this filter too.
export function resetServiceStatusFilter() {
  gStatusFilter.clear();
  try { localStorage.removeItem('btf:svc_statuses'); } catch {}
}

const CHART_IDS     = ['svc-client-bar', 'svc-month-bar', 'svc-status-donut', 'svc-outstanding-bar', 'svc-aging-bar'];
const STATUS_COLORS = { draft: '#8b93b0', sent: '#f59e0b', paid: '#10b981', overdue: '#ef4444' };

let _invoiceTableSortCol = -1, _invoiceTableSortDir = 1, _invoiceTableSearch = '';

// This used to be its own top-level "Services" dashboard/nav item. It's now
// folded into the Revenue dashboard as a section (Revenue already covers all
// streams including these two; this section adds the client-collections
// depth — DSO, cohorts, aging — that Revenue doesn't have) so it no longer
// registers as a router page. Takes Revenue's own shared filter state
// (gF, curRange, cmpRange) instead of building a second independent filter
// bar, and the host page's own rebuild callback since this section's local
// Status filter needs to re-render the *host* page, not manage #content
// itself.
export function buildServicesSection(gF, curRange, cmpRange, onChange) {
  return buildView(gF, curRange, cmpRange, onChange);
}

export function destroyServiceCharts() {
  CHART_IDS.forEach(id => charts.destroy(id));
}

// ── Owner matcher with client-owner fallback ──────────────────────────────────
function matchOwnerSvc(inv, gF) {
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
function getData(gF, start, end) {
  const { mStream, mClient } = makeMatchers(gF);

  const matchDate = inv => {
    const d = (inv.issueDate || inv.date || '').slice(0, 10);
    return d >= start && d <= end;
  };

  const kpiBase = listActive('invoices').filter(i =>
    SERVICE_STREAMS.includes(i.stream) &&
    matchDate(i) && mStream(i) && matchOwnerSvc(i, gF) && mClient(i)
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
  { key: 'date',    label: 'Issue Date', format: v => fmtDate(v),       tip: 'Date the invoice was issued.' },
  { key: 'number',  label: 'Invoice',                                   tip: 'Invoice number.' },
  { key: 'client',  label: 'Client',                                    tip: 'Client billed on this invoice.' },
  { key: 'stream',  label: 'Stream',                                    tip: 'Service stream (CS or Marketing) this invoice belongs to.' },
  { key: 'status',  label: 'Status',                                    tip: 'Invoice status: draft, sent, paid, or overdue.' },
  { key: 'dueDate', label: 'Due Date',   format: v => v ? fmtDate(v) : '—', tip: 'Date payment is due.' },
  { key: 'eur',     label: 'EUR',        right: true, format: v => formatEUR(v), tip: 'Invoice total converted to EUR.' }
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

const AGING_INV_DRILL_COLS = [
  { key: 'client',    label: 'Client',                                         tip: 'Client billed on this invoice.' },
  { key: 'issueDate', label: 'Invoice Date',     format: v => v ? fmtDate(v) : '—', tip: 'Date the invoice was issued.' },
  { key: 'dueDate',   label: 'Due Date',         format: v => v ? fmtDate(v) : '—', tip: 'Date payment is due.' },
  { key: 'daysOut',   label: 'Days Outstanding', right: true,                    tip: 'Days elapsed since the due date (or issue date if no due date is set).' },
  { key: 'eur',       label: 'Amount',           right: true, format: v => formatEUR(v), tip: 'Outstanding invoice total converted to EUR.' }
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

// ── Per-stream metric breakdown ───────────────────────────────────────────────
// Same 4 metrics as kpiRow1 (Paid Revenue, Invoiced, Collection Rate,
// Outstanding), split by stream — surfaced as inline `lines` on those cards
// instead of a separate "Stream Performance" card that just re-derived them.
function computeStreamData(kpiBase) {
  const sum = arr => arr.reduce((s, i) => s + toEUR(i.total, i.currency, i.issueDate), 0);

  return SERVICE_STREAMS.map(k => {
    const streamInvs    = kpiBase.filter(i => i.stream === k);
    const streamPaidInv = streamInvs.filter(i => i.status === 'paid');
    const streamNonDraft = streamInvs.filter(i => i.status !== 'draft');
    const streamOutInv  = streamInvs.filter(i => i.status === 'sent' || i.status === 'overdue');

    const streamPaid         = sum(streamPaidInv);
    const streamInvoiced     = sum(streamNonDraft);
    const streamOutstanding  = sum(streamOutInv);
    const streamCollectionRate = streamInvoiced > 0 ? streamPaid / streamInvoiced * 100 : null;
    const invoiceCount       = streamNonDraft.length;

    return {
      k, label: STREAMS[k]?.label || k,
      streamPaid, streamInvoiced, streamOutstanding, streamCollectionRate, invoiceCount,
      streamPaidInv, streamNonDraft, streamOutInv
    };
  });
}

function streamClientModal(title, invs, valueKey) {
  const body = el('div');
  const clientMap = new Map();
  invs.forEach(i => {
    const id = i.clientId; const n = byId('clients', id)?.name || 'Unknown';
    const x = clientMap.get(id) || { n, v: 0, overdue: 0, cnt: 0 };
    x.v += toEUR(i.total, i.currency, i.issueDate);
    if (i.status === 'overdue') x.overdue += toEUR(i.total, i.currency, i.issueDate);
    x.cnt++; clientMap.set(id, x);
  });
  const clients = [...clientMap.values()].sort((a, b) => b.v - a.v);
  if (clients.length) {
    body.appendChild(mkSectionLabel('By Client'));
    const cols = valueKey === 'outstanding'
      ? [
          { label: 'Client', tip: 'Client billed.' },
          { label: 'Invoices', right: true, muted: true, tip: 'Count of invoices for this client in this stream.' },
          { label: 'Outstanding', right: true, tip: 'Sum of sent + overdue invoice totals for this client.' },
          { label: 'Overdue', right: true, tip: 'Portion of the outstanding total that is past due.' }
        ]
      : [
          { label: 'Client', tip: 'Client billed.' },
          { label: 'Invoices', right: true, muted: true, tip: 'Count of invoices for this client in this stream.' },
          { label: 'Revenue', right: true, tip: 'Sum of invoice totals for this client in this stream.' },
          { label: '% of Total', right: true, muted: true, tip: 'This client\'s share of the total shown across all clients in this stream.' }
        ];
    const total = clients.reduce((s, c) => s + c.v, 0);
    body.appendChild(mkModalTable(cols, clients.map(c => [
      c.n, String(c.cnt), formatEUR(c.v),
      valueKey === 'outstanding' ? (c.overdue > 0 ? formatEUR(c.overdue) : '—') : (total > 0 ? (c.v / total * 100).toFixed(1) + '%' : '—')
    ])));
  } else {
    body.appendChild(mkEmptyState('No invoices for this stream in the selected period.'));
  }
  openModal({ title, body, large: true });
}

// ── Main view ─────────────────────────────────────────────────────────────────
function buildView(gF, curRange, cmpRange, onChange) {
  const wrap = el('div', {});

  // Header
  wrap.appendChild(el('div', { style: 'margin-bottom:16px' },
    el('h3', { style: 'margin:0 0 4px;font-size:16px;font-weight:700' }, 'Services (Customer Success & Marketing)'),
    el('p',  { style: 'margin:0;font-size:13px;color:var(--text-muted)' },
      'Invoice revenue, client concentration, and collection for these two streams specifically — Period/Owner/Client/Stream filters and comparison above apply here too')
  ));

  // Local invoice status filter — the one filter dimension with no Revenue-side
  // equivalent, so it's the only filter control this section still owns.
  const streamWrap = el('div', { style: 'display:flex;align-items:center;gap:8px;margin-bottom:16px;flex-wrap:wrap' });
  streamWrap.appendChild(el('span', { style: 'font-size:12px;color:var(--text-muted)' }, 'Status:'));
  const statusMS = buildMultiSelect(
    Object.entries(INVOICE_STATUSES).map(([k, v]) => ({ value: k, label: v.label })),
    gStatusFilter, 'All Statuses', onChange, 'svc_statuses'
  );
  streamWrap.appendChild(statusMS);
  wrap.appendChild(streamWrap);

  const { start, end } = curRange;

  const curData = getData(gF, start, end);
  const cmpData = cmpRange ? getData(gF, cmpRange.start, cmpRange.end) : null;

  const {
    paid, outstanding, overdue, nonDraft, kpiBase,
    paidTotal, invoicedTotal, outstandingTotal, overdueTotal,
    collectionRate, topClient, concentration, activeClientIds, clientRevMap
  } = curData;

  // Deltas (suppress when unavailable)
  const deltaPaid       = safePct(paidTotal,        cmpData?.paidTotal);
  const deltaInvoiced   = safePct(invoicedTotal,     cmpData?.invoicedTotal);
  const deltaOutstanding = safePct(outstandingTotal, cmpData?.outstandingTotal);
  const deltaCollection  = (collectionRate !== null && cmpData?.collectionRate !== null && cmpData?.collectionRate !== undefined)
    ? collectionRate - cmpData.collectionRate : null;

  // ── KPI row 1: Paid Revenue, Invoiced Revenue, Collection Rate, Outstanding ─
  // Per-stream splits render inline via `lines` — folded in from the former
  // standalone "Stream Performance" card, which just re-derived these same
  // 4 metrics × 2 streams below these cards.
  const streamData = computeStreamData(kpiBase);
  const pct = (num, den) => den > 0 ? (num / den * 100).toFixed(0) + '%' : '—';
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
        [
          { label: 'Client', tip: 'Client billed.' },
          { label: 'Invoices', right: true, muted: true, tip: 'Count of paid invoices for this client.' },
          { label: 'Revenue', right: true, tip: 'Sum of this client\'s paid invoice totals.' },
          { label: '% of Paid', right: true, muted: true, tip: 'This client\'s share of total paid revenue.' }
        ],
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
    onClick:   onClickPaidRevenue,
    explain: {
      title: 'Paid Revenue', formula: 'Sum of EUR-converted invoice totals for CS/Marketing invoices with status = paid, dated within the selected period.',
      inputs: [
        { label: 'Paid invoices', value: String(paid.length) },
        { label: 'Total', value: formatEUR(paidTotal) }
      ],
      source: 'analytics-services.js:85 getData() — `paidTotal = sum(paid)`'
    },
    lines: streamData.map(d => ({
      label: d.label, value: formatEUR(d.streamPaid), pct: pct(d.streamPaid, paidTotal),
      onClick: () => streamClientModal(`Paid Revenue — ${d.label} — ${formatEUR(d.streamPaid)}`, d.streamPaidInv, 'paid')
    }))
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
          [
            { label: 'Client', tip: 'Client billed.' },
            { label: 'Invoices', right: true, muted: true, tip: 'Count of non-draft invoices for this client.' },
            { label: 'Invoiced', right: true, tip: 'Sum of this client\'s non-draft invoice totals.' },
            { label: '% of Total', right: true, muted: true, tip: 'This client\'s share of total invoiced revenue.' }
          ],
          clients.map(c => [c.n, String(c.cnt), formatEUR(c.v), invoicedTotal > 0 ? (c.v / invoicedTotal * 100).toFixed(1) + '%' : '—'])
        ));
      }
      openModal({ title: `Invoiced Revenue — ${formatEUR(invoicedTotal)}`, body, large: true });
    },
    explain: {
      title: 'Invoiced Revenue', formula: 'Sum of EUR-converted invoice totals for all non-draft CS/Marketing invoices (sent, paid, or overdue) in the selected period.',
      inputs: [
        { label: 'Non-draft invoices', value: String(nonDraft.length) },
        { label: 'Total', value: formatEUR(invoicedTotal) }
      ],
      source: 'analytics-services.js:86 getData() — `invoicedTotal = sum(nonDraft)`',
      note: 'Draft invoices are excluded — they aren\'t yet committed revenue.'
    },
    lines: streamData.map(d => ({
      label: d.label, value: formatEUR(d.streamInvoiced), pct: pct(d.streamInvoiced, invoicedTotal),
      onClick: () => streamClientModal(`Invoiced Revenue — ${d.label} — ${formatEUR(d.streamInvoiced)}`, d.streamNonDraft, 'invoiced')
    }))
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
        [
          { label: 'Client', tip: 'Client billed.' },
          { label: 'Invoiced', right: true, tip: 'Sum of this client\'s non-draft invoice totals.' },
          { label: 'Paid', right: true, tip: 'Sum of this client\'s paid invoice totals.' },
          { label: 'Rate', right: true, muted: true, tip: 'Paid ÷ Invoiced × 100 for this client.' }
        ],
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
    onClick:   onClickCollectionRate,
    explain: {
      title: 'Collection Rate', formula: 'Paid Revenue ÷ Invoiced Revenue × 100',
      inputs: [
        { label: 'Paid Revenue', value: formatEUR(paidTotal) },
        { label: 'Invoiced Revenue', value: formatEUR(invoicedTotal) }
      ],
      source: 'analytics-services.js:89 getData() — `collectionRate = paidTotal / invoicedTotal * 100`',
      note: 'Null (shown as —) when there is no invoiced revenue in the period.'
    },
    lines: streamData.map(d => ({
      label: d.label, value: d.streamCollectionRate !== null ? d.streamCollectionRate.toFixed(0) + '%' : '—',
      onClick: () => streamClientModal(`Collection Rate — ${d.label} — ${d.streamCollectionRate !== null ? d.streamCollectionRate.toFixed(0) + '%' : 'N/A'}`, d.streamNonDraft, 'invoiced')
    }))
  }));
  const onClickOutstanding = () => {
    const body = el('div');
    const clientMap = new Map();
    outstanding.forEach(i => { const id = i.clientId; const n = byId('clients', id)?.name || 'Unknown'; const x = clientMap.get(id) || { n, v: 0, overdue: 0, cnt: 0 }; x.v += toEUR(i.total, i.currency, i.issueDate); if (i.status === 'overdue') x.overdue += toEUR(i.total, i.currency, i.issueDate); x.cnt++; clientMap.set(id, x); });
    const clients = [...clientMap.values()].sort((a, b) => b.v - a.v);
    if (clients.length) {
      body.appendChild(mkSectionLabel('Outstanding by Client'));
      body.appendChild(mkModalTable(
        [
          { label: 'Client', tip: 'Client billed.' },
          { label: 'Invoices', right: true, muted: true, tip: 'Count of sent/overdue invoices for this client.' },
          { label: 'Outstanding', right: true, tip: 'Sum of this client\'s sent + overdue invoice totals.' },
          { label: 'Overdue', right: true, tip: 'Portion of this client\'s outstanding total that is past due.' }
        ],
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
    onClick:     onClickOutstanding,
    explain: {
      title: 'Outstanding', formula: 'Sum of EUR-converted invoice totals for invoices with status = sent or overdue, dated within the selected period.',
      inputs: [
        { label: 'Outstanding invoices', value: String(outstanding.length) },
        { label: 'Total', value: formatEUR(outstandingTotal) }
      ],
      source: 'analytics-services.js:87 getData() — `outstandingTotal = sum(outstanding)`'
    },
    lines: streamData.map(d => ({
      label: d.label, value: formatEUR(d.streamOutstanding), pct: pct(d.streamOutstanding, outstandingTotal),
      onClick: () => streamClientModal(`Outstanding — ${d.label} — ${formatEUR(d.streamOutstanding)}`, d.streamOutInv, 'outstanding')
    }))
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
        [
          { label: 'Client', tip: 'Client billed.' },
          { label: 'Invoices', right: true, muted: true, tip: 'Count of overdue invoices for this client.' },
          { label: 'Overdue Amount', right: true, tip: 'Sum of this client\'s overdue invoice totals.' },
          { label: '% of Total Overdue', right: true, muted: true, tip: 'This client\'s share of total overdue across all clients.' }
        ],
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
    onClick: onClickOverdue,
    explain: {
      title: 'Overdue', formula: 'Sum of EUR-converted invoice totals for invoices with status = overdue, dated within the selected period.',
      inputs: [
        { label: 'Overdue invoices', value: String(overdue.length) },
        { label: 'Total', value: formatEUR(overdueTotal) }
      ],
      source: 'analytics-services.js:88 getData() — `overdueTotal = sum(overdue)`'
    }
  }));
  const onClickClientConcentration = () => {
    const rows = toClientConcentrationRows(clientRevMap, paidTotal);
    const body = el('div');
    body.appendChild(mkSectionLabel('Summary'));
    body.appendChild(mkSummaryGrid([
      { label: 'Top Client',    value: topClient ? topClient.name : '—' },
      { label: 'Concentration', value: concentration !== null ? concentration.toFixed(0) + '%' : '—',
        explain: {
          title: 'Client Concentration', formula: 'Top client\'s paid revenue ÷ total paid revenue × 100',
          inputs: [
            { label: 'Top Client Paid Revenue', value: topClient ? formatEUR(topClient.rev) : '—' },
            { label: 'Total Paid Revenue', value: formatEUR(paidTotal) }
          ],
          source: 'analytics-services.js:105 getData() — `concentration = topClientRev / paidTotal * 100`'
        }
      },
      { label: 'Paid Revenue',  value: formatEUR(paidTotal) }
    ], 3));
    if (rows.length) {
      body.appendChild(mkSectionLabel('By Client'));
      body.appendChild(mkModalTable(
        [
          { label: 'Client', tip: 'Client billed.' },
          { label: 'Paid Revenue', right: true, tip: 'Sum of this client\'s paid invoice totals.' },
          { label: 'Share', right: true, muted: true, tip: 'This client\'s paid revenue as a percentage of total paid revenue.' }
        ],
        rows.map(r => [r.client, formatEUR(r.paidRev), r.share.toFixed(1) + '%'])
      ));
    } else {
      body.appendChild(mkEmptyState('No paid revenue for the selected period.'));
    }
    openModal({ title: 'Revenue by Client', body, large: true });
  };
  kpiRow2.appendChild(mkKpiCard({
    label:   'Client Concentration',
    value:   concentration !== null ? concentration.toFixed(0) + '%' : '—',
    variant: concVariant,
    subtitle: 'Top client share of paid revenue',
    onClick: onClickClientConcentration,
    explain: {
      title: 'Client Concentration', formula: 'Top client\'s paid revenue ÷ total paid revenue × 100',
      inputs: [
        { label: 'Top Client', value: topClient ? topClient.name : '—' },
        { label: 'Top Client Paid Revenue', value: topClient ? formatEUR(topClient.rev) : '—' },
        { label: 'Total Paid Revenue', value: formatEUR(paidTotal) }
      ],
      source: 'analytics-services.js:105 getData() — `concentration = topClientRev / paidTotal * 100`',
      note: 'Measures dependency risk — a high share means revenue is concentrated in one client.'
    }
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
          [
            { label: 'Stream', tip: 'Service stream (CS or Marketing).' },
            { label: 'Invoiced', right: true, tip: 'Sum of this client\'s non-draft invoice totals in this stream.' }
          ],
          streams.map(([s, v]) => [STREAMS[s]?.label || s, formatEUR(v)])
        ));
      }
      openModal({ title: `${topClient.name} — Client Profile`, body, large: true });
    }
  }));
  const onClickActiveClients = () => {
    const rows = toActiveClientRows(kpiBase);
    const body = el('div');
    body.appendChild(mkSectionLabel('Summary'));
    body.appendChild(mkSummaryGrid([
      { label: 'Active Clients',   value: String(activeClientIds.size) },
      { label: 'Invoiced Revenue', value: formatEUR(invoicedTotal) },
      { label: 'Outstanding',      value: formatEUR(outstandingTotal) }
    ], 3));
    if (rows.length) {
      body.appendChild(mkSectionLabel('By Client'));
      body.appendChild(mkModalTable(
        [
          { label: 'Client', tip: 'Client with at least one non-draft invoice in the period.' },
          { label: 'Paid Revenue', right: true, tip: 'Sum of this client\'s paid invoice totals.' },
          { label: 'Invoiced Revenue', right: true, tip: 'Sum of this client\'s non-draft invoice totals.' },
          { label: 'Outstanding', right: true, tip: 'Sum of this client\'s sent + overdue invoice totals.' },
          { label: 'Overdue', right: true, tip: 'Sum of this client\'s overdue invoice totals.' },
          { label: 'Invoices', right: true, muted: true, tip: 'Count of invoices for this client in the period.' }
        ],
        rows.map(r => [r.client, formatEUR(r.paidRev), formatEUR(r.invoicedRev), formatEUR(r.outstanding), formatEUR(r.overdue), String(r.count)])
      ));
    } else {
      body.appendChild(mkEmptyState('No client activity for the selected period.'));
    }
    openModal({ title: 'Client Summary', body, large: true });
  };
  kpiRow2.appendChild(mkKpiCard({
    label:   'Active Clients',
    value:   String(activeClientIds.size),
    subtitle: 'Clients with invoiced activity',
    onClick: onClickActiveClients,
    explain: {
      title: 'Active Clients', formula: 'Count of distinct clients with at least one non-draft (sent, paid, or overdue) invoice in the selected period.',
      inputs: [{ label: 'Active Clients', value: String(activeClientIds.size) }],
      source: 'analytics-services.js:108 getData() — `activeClientIds = new Set(nonDraft.map(i => i.clientId)...)`'
    }
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
    explain: {
      title: 'Days Sales Outstanding', formula: '(Outstanding ÷ Invoiced) × Days in Period',
      inputs: [
        { label: 'Outstanding', value: formatEUR(outstandingTotal) },
        { label: 'Invoiced (non-draft)', value: formatEUR(invoicedTotal) },
        { label: 'Days in Period', value: String(periodDays) }
      ],
      source: 'analytics-services.js:760 buildView() — `dso = (outstandingTotal / invoicedTotal) * periodDays`',
      note: 'Estimates how many days of invoiced revenue are still uncollected, on average — lower is healthier.'
    },
    onClick: () => {
      const body = el('div');
      body.appendChild(mkSectionLabel('DSO Formula'));
      body.appendChild(mkModalTable(
        [{ label: 'Metric', tip: 'Component of the DSO calculation.' }, { label: 'Value', right: true, tip: 'Value of the component for the selected period.' }],
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
            { label: 'Client', tip: 'Client with outstanding non-draft invoices.' },
            { label: 'DSO (days)', right: true, tip: '(Outstanding ÷ Invoiced) × Days in Period, for this client.' },
            { label: 'Outstanding', right: true, tip: 'Sum of this client\'s sent + overdue invoice totals.' },
            { label: 'Invoiced', right: true, muted: true, tip: 'Sum of this client\'s non-draft invoice totals.' }
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
    explain: {
      title: 'Avg Invoice Size', formula: 'Invoiced Revenue ÷ Count of non-draft invoices',
      inputs: [
        { label: 'Invoiced Revenue', value: formatEUR(invoicedTotal) },
        { label: 'Non-draft Invoices', value: String(nonDraft.length) }
      ],
      source: 'analytics-services.js:767 buildView() — `avgInvValue = invoicedTotal / nonDraft.length`'
    },
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
            { label: 'Client', tip: 'Client billed.' },
            { label: 'Issue Date', tip: 'Date the invoice was issued.' },
            { label: 'Amount', right: true, tip: 'Invoice total converted to EUR.' }
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
          { label: 'Range', tip: 'Invoice amount bucket (EUR).' },
          { label: 'Count', right: true, tip: 'Number of non-draft invoices in this amount range.' },
          { label: 'Total', right: true, tip: 'Sum of invoice totals in this amount range.' },
          { label: '% of Invoiced', right: true, muted: true, tip: 'This bucket\'s total as a percentage of overall invoiced revenue.' }
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
    explain: {
      title: 'New vs Recurring', formula: 'A client with a non-draft invoice in the selected period is "new" if it has no non-draft service invoice dated before the period start, otherwise "recurring".',
      inputs: [
        { label: 'New Clients', value: String(newClientIds.length) },
        { label: 'Recurring Clients', value: String(recurringClientIds.length) }
      ],
      source: 'analytics-services.js:786 buildView() — `newClientIds`/`recurringClientIds` (vs. `clientsBeforePeriod`)',
      note: 'Compares against ALL historical CS/Marketing invoices, not just the current filter\'s date range, so "new" means new to the business, not just to this period\'s filters.'
    },
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
          [
            { label: 'Client', tip: 'Client with no non-draft invoices before the selected period.' },
            { label: 'Invoices', right: true, muted: true, tip: 'Count of this client\'s non-draft invoices in the period.' },
            { label: 'Revenue', right: true, tip: 'Sum of this client\'s non-draft invoice totals in the period.' }
          ],
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
            { label: 'Client', tip: 'Client with non-draft invoice activity before the selected period.' },
            { label: 'Period Revenue', right: true, tip: 'Sum of this client\'s non-draft invoice totals within the selected period.' },
            { label: 'Historical Revenue', right: true, muted: true, tip: 'Sum of this client\'s non-draft invoice totals across all time (all service invoices ever recorded, any period).' }
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
          [
            { label: 'Stream', tip: 'Service stream (CS or Marketing).' },
            { label: 'Revenue', right: true, tip: 'Sum of this client\'s paid invoice totals in this stream.' },
            { label: '% of Paid', right: true, muted: true, tip: 'This stream\'s share of this client\'s total paid revenue.' }
          ],
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
          [
            { label: 'Client', tip: 'Client billed.' },
            { label: 'Revenue', right: true, tip: 'Sum of this client\'s invoice totals for this month and stream.' },
            { label: '% of Stream', right: true, muted: true, tip: 'This client\'s share of the stream\'s total for this month.' }
          ],
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
      const sk    = entries[idx][0];
      const rows  = kpiBase.filter(i => i.status === sk);
      const label = INVOICE_STATUSES[sk]?.label || sk;
      const total = rows.reduce((s, i) => s + toEUR(i.total, i.currency, i.issueDate), 0);

      const body = el('div');
      body.appendChild(mkSectionLabel('Summary'));
      body.appendChild(mkSummaryGrid([
        { label: 'Invoices',   value: String(rows.length) },
        { label: 'Total Value', value: formatEUR(total) }
      ], 2));

      const clientMap = new Map();
      rows.forEach(i => {
        const id = i.clientId; const n = byId('clients', id)?.name || 'Unknown';
        const x = clientMap.get(id) || { n, v: 0, cnt: 0 };
        x.v += toEUR(i.total, i.currency, i.issueDate); x.cnt++;
        clientMap.set(id, x);
      });
      const clients = [...clientMap.values()].sort((a, b) => b.v - a.v);
      if (clients.length) {
        body.appendChild(mkSectionLabel('By Client'));
        body.appendChild(mkModalTable(
          [
            { label: 'Client', tip: 'Client billed.' },
            { label: 'Invoices', right: true, muted: true, tip: 'Count of invoices in this status for this client.' },
            { label: 'Total', right: true, tip: 'Sum of this client\'s invoice totals in this status.' },
            { label: '% of Total', right: true, muted: true, tip: 'This client\'s share of the total value in this status.' }
          ],
          clients.map(c => [c.n, String(c.cnt), formatEUR(c.v), total > 0 ? (c.v / total * 100).toFixed(1) + '%' : '—'])
        ));
      }

      const footer = el('div', { style: 'margin-top:16px;padding-top:12px;border-top:1px solid rgba(255,255,255,0.08);display:flex;justify-content:space-between;align-items:center' });
      footer.appendChild(el('div', { style: 'font-size:12px;color:var(--text-muted)' }, `${rows.length} invoice${rows.length === 1 ? '' : 's'} in this status`));
      const link = el('a', { style: 'font-size:12px;cursor:pointer;color:var(--accent)' }, 'View all invoices →');
      link.onclick = () => drillDownModal(`Invoices — ${label}`, toInvDrillRows(rows), INV_DRILL_COLS);
      footer.appendChild(link);
      body.appendChild(footer);

      openModal({ title: `Invoices — ${label}`, body, large: true });
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
      const clientInvs = outstanding.filter(i => i.clientId === d.id);
      const overdueAmt = clientInvs.filter(i => i.status === 'overdue').reduce((s, i) => s + toEUR(i.total, i.currency, i.issueDate), 0);

      const body = el('div');
      body.appendChild(mkSectionLabel('Summary'));
      body.appendChild(mkSummaryGrid([
        { label: 'Invoices',    value: String(clientInvs.length) },
        { label: 'Outstanding', value: formatEUR(d.eur) },
        { label: 'Overdue',     value: overdueAmt > 0 ? formatEUR(overdueAmt) : '—' }
      ], 3));

      const streamMap = new Map();
      clientInvs.forEach(i => { streamMap.set(i.stream, (streamMap.get(i.stream) || 0) + toEUR(i.total, i.currency, i.issueDate)); });
      const streams = [...streamMap.entries()].sort((a, b) => b[1] - a[1]);
      if (streams.length) {
        body.appendChild(mkSectionLabel('By Stream'));
        body.appendChild(mkModalTable(
          [
            { label: 'Stream', tip: 'Service stream (CS or Marketing).' },
            { label: 'Outstanding', right: true, tip: 'Sum of this client\'s sent + overdue invoice totals in this stream.' },
            { label: '% of Total', right: true, muted: true, tip: 'This stream\'s share of this client\'s total outstanding.' }
          ],
          streams.map(([s, v]) => [STREAMS[s]?.label || s, formatEUR(v), d.eur > 0 ? (v / d.eur * 100).toFixed(0) + '%' : '—'])
        ));
      }

      const footer = el('div', { style: 'margin-top:16px;padding-top:12px;border-top:1px solid rgba(255,255,255,0.08);display:flex;justify-content:space-between;align-items:center' });
      footer.appendChild(el('div', { style: 'font-size:12px;color:var(--text-muted)' }, `${clientInvs.length} invoice${clientInvs.length === 1 ? '' : 's'} outstanding`));
      const link = el('a', { style: 'font-size:12px;cursor:pointer;color:var(--accent)' }, 'View all invoices →');
      link.onclick = () => drillDownModal(`Outstanding — ${d.name}`, toInvDrillRows(clientInvs), INV_DRILL_COLS);
      footer.appendChild(link);
      body.appendChild(footer);

      openModal({ title: `Outstanding — ${d.name}`, body, large: true });
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
          { label: 'Client', tip: 'Client with an invoice in this aging bucket.' },
          { label: 'Invoices', right: true, muted: true, tip: 'Count of this client\'s invoices in this aging bucket.' },
          { label: 'Outstanding', right: true, tip: 'Sum of this client\'s invoice totals in this aging bucket.' },
          { label: 'Oldest Due Date', right: true, muted: true, tip: 'Earliest due date among this client\'s invoices in this bucket.' }
        ],
        clientRows.map(c => [
          c.name,
          String(c.count),
          formatEUR(c.total),
          c.oldestDue ? fmtDate(c.oldestDue) : '—'
        ])
      ));

      // Individual invoice rows are demoted behind a link — the "By Client" table
      // above already covers the aggregated view, so the raw per-invoice list is
      // one click away rather than always-rendered.
      const footer = el('div', { style: 'margin-top:16px;padding-top:12px;border-top:1px solid rgba(255,255,255,0.08);display:flex;justify-content:space-between;align-items:center' });
      footer.appendChild(el('div', { style: 'font-size:12px;color:var(--text-muted)' }, `${b.items.length} invoice${b.items.length === 1 ? '' : 's'} in this bucket`));
      const link = el('a', { style: 'font-size:12px;cursor:pointer;color:var(--accent)' }, 'View individual invoices →');
      link.onclick = () => {
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
        drillDownModal(`Aging — ${b.label} — Individual Invoices`, invRows, AGING_INV_DRILL_COLS);
      };
      footer.appendChild(link);
      body.appendChild(footer);

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
    { key: 'number',      label: 'Invoice',                  tip: 'Invoice number.' },
    { key: 'client',      label: 'Client',                   tip: 'Client billed on this invoice.' },
    { key: 'stream',      label: 'Stream',                   tip: 'Service stream (CS or Marketing) this invoice belongs to.' },
    { key: 'owner',       label: 'Owner',                    tip: 'Owner attributed to this invoice, falling back to the client\'s owner if not set on the invoice itself.' },
    { key: 'status',      label: 'Status',      badge: true, tip: 'Invoice status: draft, sent, paid, or overdue.' },
    { key: 'issueDate',   label: 'Issue Date',                tip: 'Date the invoice was issued.' },
    { key: 'dueDate',     label: 'Due Date',                  tip: 'Date payment is due.' },
    { key: 'amountEUR',   label: 'Amount EUR',  right: true, tip: 'Invoice total converted to EUR.' },
    { key: 'overdueDays', label: 'Overdue Days', right: true, tip: 'Days elapsed since the due date (or issue date if no due date), for sent/overdue invoices only.' }
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
  TABLE_COLS.forEach(col => htr.appendChild(mkTh(col)));
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
  attachSortFilter(tableWrap, { initialCol: _invoiceTableSortCol, initialDir: _invoiceTableSortDir, initialSearch: _invoiceTableSearch, onSortChange: (c, d) => { _invoiceTableSortCol = c; _invoiceTableSortDir = d; }, onSearchChange: v => { _invoiceTableSearch = v; } });

  const totalEUR = rows.reduce((s, r) => s + r._eur, 0);
  container.appendChild(el('div', {
    style: 'display:flex;justify-content:space-between;margin-top:8px;font-size:13px'
  },
    el('span', { style: 'color:var(--text-muted)' }, `${rows.length} record(s)`),
    el('strong', { class: 'num' }, `Total: ${formatEUR(totalEUR)}`)
  ));
}
