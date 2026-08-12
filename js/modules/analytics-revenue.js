// Revenue Analytics Dashboard — structure · growth · collections · contributors · dynamics
import { el, fmtDate, drillDownModal, attachSortFilter, openModal } from '../core/ui.js';
import * as charts from '../core/charts.js';
import { STREAMS, OWNERS } from '../core/config.js';
import {
  formatEUR, toEUR, byId,
  listActive, listActivePayments,
  drillRevRows, drillRevRowsPnL, companyPropIds, isCompanyRecord
} from '../core/data.js';
import {
  createFilterState, getCurrentPeriodRange, getComparisonRange,
  getMonthKeysForRange, makeMatchers, buildFilterBar, buildComparisonLine
} from './analytics-filters.js?v=20260519';
import { mkSectionLabel, mkSummaryBox, mkModalTable, mkSummaryGrid, mkVarianceBadge, mkEmptyState, mkKpiCard, mkCmpGrid, safePct, fmtK, groupByMonthKey, mkTh, mkDrillValue } from './analytics-helpers.js';
import { buildServicesSection, destroyServiceCharts, resetServiceStatusFilter } from './analytics-services.js';

const MONTH_LABELS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const OWNER_COLORS = { you: '#6366f1', rita: '#ec4899', both: '#14b8a6' };
const CHART_IDS    = [
  'rev-trend', 'rev-stream-bar', 'rev-prop-bar', 'rev-owner-donut',
  'rev-mix-evolution', 'rev-growth-trend', 'rev-paid-outstanding',
  'rev-concentration', 'rev-aging'
];
const REV_COLS = [
  { key: 'date',   label: 'Date',   format: v => fmtDate(v), tip: 'Date the payment was received or the invoice was issued.' },
  { key: 'type',   label: 'Type',   tip: 'Record type — Payment (rental) or Invoice (service).' },
  { key: 'source', label: 'Entity', tip: 'The property (for payments) or client (for invoices) this revenue came from.' },
  { key: 'ref',    label: 'Ref',    tip: 'Reference identifier for the transaction, e.g. an invoice number.' },
  { key: 'eur',    label: 'EUR',    right: true, format: v => formatEUR(v), tip: 'Amount converted to EUR at the record\'s own date.' }
];

// ── Grouping / footer helpers for compact drill-down modals ───────────────────
// These turn a scoped (payments, invoices) slice into small aggregated tables
// instead of a flat per-record dump; the raw list stays one click away via
// appendRawLink.
// These are shared by both Revenue (P&L) breakdowns and the Collections/AR cluster
// (outstanding/aging), so they stay VAT-inclusive (`.total`) like drillRevRows — P&L call
// sites pre-map their invoices through pnlInvs() below before calling in, rather than
// baking VAT treatment into the shared helper.
function revByStream(pays, invs) {
  const m = new Map();
  (pays || []).forEach(p => { const k = p.stream || 'other'; const e = m.get(k) || { key: k, eur: 0, count: 0 }; e.eur += toEUR(p.amount, p.currency, p.date); e.count++; m.set(k, e); });
  (invs || []).forEach(i => { const k = i.stream || 'other'; const e = m.get(k) || { key: k, eur: 0, count: 0 }; e.eur += toEUR(i.total, i.currency, i.issueDate); e.count++; m.set(k, e); });
  return [...m.values()].sort((a, b) => b.eur - a.eur).map(e => ({ ...e, name: STREAMS[e.key]?.label || e.key }));
}

function revByEntity(pays, invs) {
  const m = new Map();
  (pays || []).forEach(p => { const key = 'p:' + p.propertyId; const e = m.get(key) || { name: byId('properties', p.propertyId)?.name || 'Unknown', eur: 0, count: 0 }; e.eur += toEUR(p.amount, p.currency, p.date); e.count++; m.set(key, e); });
  (invs || []).forEach(i => { const key = 'c:' + i.clientId; const e = m.get(key) || { name: byId('clients', i.clientId)?.name || 'Unknown', eur: 0, count: 0 }; e.eur += toEUR(i.total, i.currency, i.issueDate); e.count++; m.set(key, e); });
  return [...m.values()].sort((a, b) => b.eur - a.eur);
}

function revByProperty(pays) {
  const m = new Map();
  (pays || []).forEach(p => { const id = p.propertyId; const e = m.get(id) || { name: byId('properties', id)?.name || 'Unknown', eur: 0, count: 0 }; e.eur += toEUR(p.amount, p.currency, p.date); e.count++; m.set(id, e); });
  return [...m.values()].sort((a, b) => b.eur - a.eur);
}

function revByClient(invs) {
  const m = new Map();
  (invs || []).forEach(i => { const id = i.clientId; const e = m.get(id) || { name: byId('clients', id)?.name || 'Unknown', eur: 0, count: 0 }; e.eur += toEUR(i.total, i.currency, i.issueDate); e.count++; m.set(id, e); });
  return [...m.values()].sort((a, b) => b.eur - a.eur);
}

function revByMonth(pays, invs) {
  const m = new Map();
  (pays || []).forEach(p => { const k = p.date?.slice(0, 7); if (!k) return; const e = m.get(k) || { key: k, eur: 0, count: 0 }; e.eur += toEUR(p.amount, p.currency, p.date); e.count++; m.set(k, e); });
  (invs || []).forEach(i => { const k = (i.issueDate || '').slice(0, 7); if (!k) return; const e = m.get(k) || { key: k, eur: 0, count: 0 }; e.eur += toEUR(i.total, i.currency, i.issueDate); e.count++; m.set(k, e); });
  return [...m.values()].sort((a, b) => b.key.localeCompare(a.key));
}

// VAT-exclusive invoice view for P&L-purpose callers of the rev-by-* helpers and openStreamDrill.
function pnlInvs(invs) {
  return (invs || []).map(i => ({ ...i, total: i.subtotal ?? i.total }));
}

function monthKeyLabel(key) {
  const [y, m] = key.split('-');
  return `${MONTH_LABELS[parseInt(m, 10) - 1] || m} ${y}`;
}

// openStreamDrill(title, pays, invs) — compact modal for a single-stream slice
// (e.g. one rental type or one service stream): summary + a grouped breakdown
// by property (when pays given) or by client (when invs given), raw list
// demoted behind a link.
function openStreamDrill(title, pays, invsRaw) {
  const invs = pnlInvs(invsRaw); // always called with paid (P&L) invoices — see callers
  const eur = (pays || []).reduce((s, p) => s + toEUR(p.amount, p.currency, p.date), 0) +
              (invs || []).reduce((s, i) => s + toEUR(i.total, i.currency, i.issueDate), 0);
  const body = el('div');
  body.appendChild(mkSummaryGrid([
    { label: 'Revenue', value: formatEUR(eur) },
    { label: 'Records', value: String((pays || []).length + (invs || []).length) }
  ], 2));
  const entities = revByEntity(pays, invs);
  if (entities.length) {
    body.appendChild(mkSectionLabel((pays || []).length ? 'By Property' : 'By Client'));
    body.appendChild(mkModalTable(
      [
        { label: 'Name', tip: 'Property or client name contributing to this stream.' },
        { label: 'Records', right: true, muted: true, tip: 'Number of payments or invoices from this property/client.' },
        { label: 'Revenue', right: true, tip: 'Total EUR revenue from this property/client in the current scope.' },
        { label: '% of Total', right: true, muted: true, tip: 'This property/client\'s share of the stream total shown above.' }
      ],
      entities.map(e => [e.name, String(e.count), formatEUR(e.eur), eur > 0 ? (e.eur / eur * 100).toFixed(1) + '%' : '—'])
    ));
  }
  appendRawLink(body, (pays || []).length + (invs || []).length, () => drillDownModal(title, drillRevRows(pays, invs), REV_COLS));
  openModal({ title: `${title} — ${formatEUR(eur)}`, body, large: true });
}

function appendRawLink(body, count, onClick, label) {
  const footer = el('div', { style: 'margin-top:16px;padding-top:12px;border-top:1px solid rgba(255,255,255,0.08);display:flex;justify-content:space-between;align-items:center' });
  footer.appendChild(el('div', { style: 'font-size:12px;color:var(--text-muted)' }, `${count} record${count === 1 ? '' : 's'}`));
  const link = el('a', { style: 'font-size:12px;cursor:pointer;color:var(--accent)' }, label || 'View all transactions →');
  link.onclick = onClick;
  footer.appendChild(link);
  body.appendChild(footer);
}

// ── Filter state ──────────────────────────────────────────────────────────────
let gF = createFilterState();
let gScope = 'company'; // 'company' | 'all'

let _revSortCol = -1, _revSortDir = 1, _revSearch = '';

// ── Module export ─────────────────────────────────────────────────────────────
export default {
  id: 'analytics-revenue', label: 'Revenue', icon: '📈',
  render(container) { container.appendChild(buildView()); },
  refresh() { rebuildView(); },
  destroy() { CHART_IDS.forEach(id => charts.destroy(id)); destroyServiceCharts(); }
};

// ── Data ──────────────────────────────────────────────────────────────────────
function getData(start, end) {
  const inRange = d => d && d >= start && d <= end;
  const { mStream, mOwner, mProperty, mClient } = makeMatchers(gF);
  const coPropIds = companyPropIds();
  const isCoRec = gScope === 'all'
    ? () => true
    : r => isCompanyRecord(r, coPropIds);

  // Property filter → isolate rental revenue (exclude invoices entirely)
  // Client filter   → isolate service revenue (exclude payments entirely)
  const payments = gF.clientIds.size > 0 ? [] : listActivePayments().filter(p =>
    p.status === 'paid' && inRange(p.date) && mStream(p) && mOwner(p) && mProperty(p) && isCoRec(p)
  );
  const invoices = gF.propertyIds.size > 0 ? [] : listActive('invoices').filter(i =>
    i.status === 'paid' && inRange(i.issueDate) && mStream(i) && mOwner(i) && mClient(i)
  );
  const outstanding = gF.propertyIds.size > 0 ? [] : listActive('invoices').filter(i =>
    ['sent', 'overdue'].includes(i.status) &&
    inRange(i.issueDate) && mStream(i) && mOwner(i) && mClient(i)
  );

  // svcRev/total are P&L revenue figures throughout this dashboard, so they exclude VAT
  // (subtotal). `outstanding`/outstandingTotal stay VAT-inclusive — that's the real amount
  // still owed by clients.
  const propRev     = payments.reduce((s, p) => s + toEUR(p.amount, p.currency, p.date), 0);
  const svcRev      = invoices.reduce((s, i) => s + toEUR(i.subtotal ?? i.total, i.currency, i.issueDate), 0);
  const svcRevCash  = invoices.reduce((s, i) => s + toEUR(i.total, i.currency, i.issueDate), 0);
  const outTotal = outstanding.reduce((s, i) => s + toEUR(i.total, i.currency, i.issueDate), 0);
  // Pre-bucket by month once so the chart renderers don't re-filter the full
  // arrays per month (keys/derivation match the inline filters exactly).
  return {
    payments, invoices, outstanding, propRev, svcRev, svcRevCash, total: propRev + svcRev, outstandingTotal: outTotal,
    payByMonth: groupByMonthKey(payments, p => p.date),
    invByMonth: groupByMonthKey(invoices, i => i.issueDate),
  };
}

// ── KPI section ───────────────────────────────────────────────────────────────
function buildKpiSection(cur, cmp, cmpRange) {
  const { payments, invoices, outstanding, propRev, svcRev, total, outstandingTotal } = cur;
  const cl = cmpRange?.label || '';

  // Stream-level revenue
  const strMap = new Map();
  payments.forEach(p => { const s = p.stream || 'other'; strMap.set(s, (strMap.get(s) || 0) + toEUR(p.amount, p.currency, p.date)); });
  invoices.forEach(i => { const s = i.stream || 'other'; strMap.set(s, (strMap.get(s) || 0) + toEUR(i.subtotal ?? i.total, i.currency, i.issueDate)); });
  const stRev  = strMap.get('short_term_rental')  || 0;
  const ltRev  = strMap.get('long_term_rental')   || 0;
  const csRev  = strMap.get('customer_success')   || 0;
  const mktRev = strMap.get('marketing_services') || 0;

  const activePropIds   = new Set(payments.map(p => p.propertyId).filter(Boolean));
  const activeClientIds = new Set(invoices.map(i => i.clientId).filter(Boolean));

  // STR / LTR revenue-generating property sets (denominator = only props with paid revenue)
  const strPropIds = new Set(payments.filter(p => p.stream === 'short_term_rental' && p.propertyId).map(p => p.propertyId));
  const ltrPropIds = new Set(payments.filter(p => p.stream === 'long_term_rental'  && p.propertyId).map(p => p.propertyId));
  const avgStr     = strPropIds.size > 0 ? stRev / strPropIds.size : 0;
  const avgLtr     = ltrPropIds.size > 0 ? ltRev / ltrPropIds.size : 0;
  const allRentalPropIds = new Set([...strPropIds, ...ltrPropIds]);
  const avgRental  = allRentalPropIds.size > 0 ? (stRev + ltRev) / allRentalPropIds.size : null;

  // Top contributors sorted by revenue
  const contribs = [];
  {
    const pMap = new Map(), iMap = new Map();
    payments.forEach(p => pMap.set(p.propertyId, (pMap.get(p.propertyId) || 0) + toEUR(p.amount, p.currency, p.date)));
    invoices.forEach(i => iMap.set(i.clientId,   (iMap.get(i.clientId)   || 0) + toEUR(i.subtotal ?? i.total, i.currency, i.issueDate)));
    pMap.forEach((v, id) => contribs.push({ id, name: byId('properties', id)?.name || 'Unknown', val: v, type: 'Property' }));
    iMap.forEach((v, id) => contribs.push({ id, name: byId('clients',    id)?.name || 'Unknown', val: v, type: 'Client'   }));
    contribs.sort((a, b) => b.val - a.val);
  }

  // Comparison deltas
  let dTotal, dRental, dService;
  if (cmp) {
    dTotal   = safePct(total,   cmp.total);
    dRental  = safePct(propRev, cmp.propRev);
    dService = safePct(svcRev,  cmp.svcRev);
  }

  const pct = (num, den) => den > 0 ? (num / den * 100).toFixed(0) + '%' : '—';

  // ── Total Revenue drill-down ────────────────────────────────────────────────
  const totalRevDrill = () => {
    const body = el('div');
    const { propRev: cPropRev, svcRev: cSvcRev, total: cTotal } = cmp || {};

    if (cmp) {
      body.appendChild(mkCmpGrid([
        { label: 'Total Revenue',
          curVal: mkDrillValue(formatEUR(total), () => drillDownModal('Total Revenue', drillRevRowsPnL(payments, invoices), REV_COLS)),
          cmpVal: mkDrillValue(formatEUR(cTotal), () => drillDownModal(`Total Revenue — ${cl}`, drillRevRowsPnL(cmp.payments, cmp.invoices), REV_COLS)) },
        { label: 'Rental Revenue',
          curVal: mkDrillValue(formatEUR(propRev), () => drillDownModal('Rental Revenue', drillRevRowsPnL(payments, []), REV_COLS)),
          cmpVal: mkDrillValue(formatEUR(cPropRev), () => drillDownModal(`Rental Revenue — ${cl}`, drillRevRowsPnL(cmp.payments, []), REV_COLS)) },
        { label: 'Service Revenue',
          curVal: mkDrillValue(formatEUR(svcRev), () => drillDownModal('Service Revenue', drillRevRowsPnL([], invoices), REV_COLS)),
          cmpVal: mkDrillValue(formatEUR(cSvcRev), () => drillDownModal(`Service Revenue — ${cl}`, drillRevRowsPnL([], cmp.invoices), REV_COLS)) },
      ], 'Current Period', cl));
    } else {
      // Rental vs Service summary boxes
      const sgrid = el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:20px' });
      sgrid.appendChild(mkSummaryBox('Rental Revenue', mkDrillValue(formatEUR(propRev), () => openStreamDrill('Rental Revenue', payments, [])),
        total > 0 ? `${(propRev / total * 100).toFixed(0)}% of total · ${activePropIds.size} propert${activePropIds.size !== 1 ? 'ies' : 'y'}` : null));
      sgrid.appendChild(mkSummaryBox('Service Revenue', mkDrillValue(formatEUR(svcRev), () => openStreamDrill('Service Revenue', [], invoices)),
        total > 0 ? `${(svcRev / total * 100).toFixed(0)}% of total · ${activeClientIds.size} client${activeClientIds.size !== 1 ? 's' : ''}` : null));
      body.appendChild(sgrid);
    }

    // Stream breakdown table
    const streamRows = [
      { label: 'Short-term Rental', eur: stRev, drill: () => openStreamDrill('Short-term Rental', payments.filter(p => p.stream === 'short_term_rental'), []) },
      { label: 'Long-term Rental',  eur: ltRev, drill: () => openStreamDrill('Long-term Rental',  payments.filter(p => p.stream === 'long_term_rental'),  []) },
      { label: 'Customer Success',  eur: csRev, drill: () => openStreamDrill('Customer Success',  [], invoices.filter(i => i.stream === 'customer_success')) },
      { label: 'Marketing Services', eur: mktRev, drill: () => openStreamDrill('Marketing Services', [], invoices.filter(i => i.stream === 'marketing_services')) },
    ].filter(r => r.eur > 0);
    if (streamRows.length) {
      body.appendChild(mkSectionLabel('Revenue by Stream'));
      const hdrs = [
        { label: 'Stream', tip: 'Revenue stream — short-term rental, long-term rental, customer success, or marketing services.' },
        { label: 'Revenue', right: true, tip: 'Total EUR revenue from this stream for the current period.' },
        { label: '% of Total', right: true, muted: true, tip: 'This stream\'s share of total revenue for the period.' }
      ];
      body.appendChild(mkModalTable(hdrs, streamRows.map(r => [
        r.label, mkDrillValue(formatEUR(r.eur), r.drill),
        total > 0 ? (r.eur / total * 100).toFixed(1) + '%' : '—'
      ])));
    }

    // Top contributors
    if (contribs.length) {
      body.appendChild(el('div', { style: 'margin-top:20px' }));
      body.appendChild(mkSectionLabel('Top Contributors'));
      const hdrs = [
        { label: '#', muted: true, tip: 'Rank by revenue, highest first.' },
        { label: 'Name', tip: 'Property or client name.' },
        { label: 'Type', muted: true, tip: 'Whether this contributor is a Property (rental) or a Client (services).' },
        { label: 'Revenue', right: true, tip: 'Total EUR revenue from this contributor for the current period.' },
        { label: 'Share', right: true, muted: true, tip: 'This contributor\'s share of total revenue.' }
      ];
      const rows = contribs.slice(0, 8).map((c, i) => [
        String(i + 1), c.name, c.type, mkDrillValue(formatEUR(c.val), () => contribDrill(c, cmp)),
        total > 0 ? (c.val / total * 100).toFixed(1) + '%' : '—'
      ]);
      body.appendChild(mkModalTable(hdrs, rows));
    }

    openModal({ title: `Total Revenue — ${formatEUR(total)}`, body, large: true });
  };

  // ── Service Revenue drill-down ──────────────────────────────────────────────
  const serviceRevDrill = () => {
    const body = el('div');

    if (cmp) {
      const cmpStr = new Map();
      (cmp.invoices || []).forEach(i => { const s = i.stream || 'other'; cmpStr.set(s, (cmpStr.get(s)||0) + toEUR(i.subtotal ?? i.total, i.currency, i.issueDate)); });
      body.appendChild(mkCmpGrid([
        { label: 'Service Revenue',
          curVal: mkDrillValue(formatEUR(svcRev), () => drillDownModal('Service Revenue', drillRevRowsPnL([], invoices), REV_COLS)),
          cmpVal: mkDrillValue(formatEUR(cmp.svcRev), () => drillDownModal(`Service Revenue — ${cl}`, drillRevRowsPnL([], cmp.invoices), REV_COLS)) },
        { label: 'Customer Success',
          curVal: mkDrillValue(formatEUR(csRev), () => drillDownModal('Customer Success', drillRevRowsPnL([], invoices.filter(i => i.stream === 'customer_success')), REV_COLS)),
          cmpVal: mkDrillValue(formatEUR(cmpStr.get('customer_success') || 0), () => drillDownModal(`Customer Success — ${cl}`, drillRevRowsPnL([], (cmp.invoices || []).filter(i => i.stream === 'customer_success')), REV_COLS)) },
        { label: 'Marketing Services',
          curVal: mkDrillValue(formatEUR(mktRev), () => drillDownModal('Marketing Services', drillRevRowsPnL([], invoices.filter(i => i.stream === 'marketing_services')), REV_COLS)),
          cmpVal: mkDrillValue(formatEUR(cmpStr.get('marketing_services') || 0), () => drillDownModal(`Marketing Services — ${cl}`, drillRevRowsPnL([], (cmp.invoices || []).filter(i => i.stream === 'marketing_services')), REV_COLS)) },
      ], 'Current Period', cl));
    } else {
      // CS vs Marketing boxes
      const streamData = [
        { label: 'Customer Success',   eur: csRev,  key: 'customer_success'   },
        { label: 'Marketing Services', eur: mktRev, key: 'marketing_services' },
      ].filter(s => s.eur > 0);
      if (streamData.length) {
        const sgrid = el('div', { style: `display:grid;grid-template-columns:repeat(${streamData.length},1fr);gap:12px;margin-bottom:20px` });
        streamData.forEach(s => sgrid.appendChild(mkSummaryBox(s.label,
          mkDrillValue(formatEUR(s.eur), () => openStreamDrill(s.label, [], invoices.filter(i => i.stream === s.key))),
          svcRev > 0 ? `${(s.eur / svcRev * 100).toFixed(0)}% of service revenue` : null)));
        body.appendChild(sgrid);
      }
    }

    // Clients table
    const clientMap = new Map();
    invoices.forEach(i => {
      const id   = i.clientId;
      const name = byId('clients', id)?.name || 'Unknown';
      const eur  = toEUR(i.subtotal ?? i.total, i.currency, i.issueDate);
      const e    = clientMap.get(id) || { id, name, eur: 0, count: 0 };
      e.eur  += eur;
      e.count++;
      clientMap.set(id, e);
    });
    const clients = [...clientMap.values()].sort((a, b) => b.eur - a.eur);
    if (clients.length) {
      body.appendChild(mkSectionLabel('By Client'));
      const hdrs = [
        { label: 'Client', tip: 'Client billed for services.' },
        { label: 'Invoices', right: true, muted: true, tip: 'Number of paid invoices from this client.' },
        { label: 'Revenue', right: true, tip: 'Total EUR revenue billed to this client.' },
        { label: '% of Service', right: true, muted: true, tip: 'This client\'s share of total service revenue.' }
      ];
      const rows = clients.map(c => [
        c.name, String(c.count),
        mkDrillValue(formatEUR(c.eur), () => drillDownModal(`Service Revenue — ${c.name}`, drillRevRowsPnL([], invoices.filter(i => i.clientId === c.id)), REV_COLS)),
        svcRev > 0 ? (c.eur / svcRev * 100).toFixed(1) + '%' : '—'
      ]);
      body.appendChild(mkModalTable(hdrs, rows));
    }

    openModal({ title: `Service Revenue — ${formatEUR(svcRev)}`, body, large: true });
  };

  // ── Rental Revenue drill-down ───────────────────────────────────────────────
  const rentalRevDrill = () => {
    const body = el('div');

    if (cmp) {
      const cmpStr = new Map();
      (cmp.payments || []).forEach(p => { const s = p.stream || 'other'; cmpStr.set(s, (cmpStr.get(s)||0) + toEUR(p.amount, p.currency, p.date)); });
      body.appendChild(mkCmpGrid([
        { label: 'Rental Revenue',
          curVal: mkDrillValue(formatEUR(propRev), () => drillDownModal('Rental Revenue', drillRevRowsPnL(payments, []), REV_COLS)),
          cmpVal: mkDrillValue(formatEUR(cmp.propRev), () => drillDownModal(`Rental Revenue — ${cl}`, drillRevRowsPnL(cmp.payments, []), REV_COLS)) },
        { label: 'Short-term Rental',
          curVal: mkDrillValue(formatEUR(stRev), () => drillDownModal('Short-term Rental', drillRevRowsPnL(payments.filter(p => p.stream === 'short_term_rental'), []), REV_COLS)),
          cmpVal: mkDrillValue(formatEUR(cmpStr.get('short_term_rental') || 0), () => drillDownModal(`Short-term Rental — ${cl}`, drillRevRowsPnL((cmp.payments || []).filter(p => p.stream === 'short_term_rental'), []), REV_COLS)) },
        { label: 'Long-term Rental',
          curVal: mkDrillValue(formatEUR(ltRev), () => drillDownModal('Long-term Rental', drillRevRowsPnL(payments.filter(p => p.stream === 'long_term_rental'), []), REV_COLS)),
          cmpVal: mkDrillValue(formatEUR(cmpStr.get('long_term_rental') || 0), () => drillDownModal(`Long-term Rental — ${cl}`, drillRevRowsPnL((cmp.payments || []).filter(p => p.stream === 'long_term_rental'), []), REV_COLS)) },
      ], 'Current Period', cl));
    } else {
      // STR vs LTR summary boxes
      const typeData = [
        { label: 'Short-term Rental', eur: stRev, props: strPropIds.size, key: 'short_term_rental' },
        { label: 'Long-term Rental',  eur: ltRev, props: ltrPropIds.size, key: 'long_term_rental'  },
      ].filter(t => t.eur > 0);
      if (typeData.length) {
        const sgrid = el('div', { style: `display:grid;grid-template-columns:repeat(${typeData.length},1fr);gap:12px;margin-bottom:20px` });
        typeData.forEach(t => sgrid.appendChild(mkSummaryBox(t.label,
          mkDrillValue(formatEUR(t.eur), () => openStreamDrill(t.label, payments.filter(p => p.stream === t.key), [])),
          `${t.props} prop${t.props !== 1 ? 's' : ''} · ${propRev > 0 ? (t.eur / propRev * 100).toFixed(0) : 0}% of rental`)));
        body.appendChild(sgrid);
      }
    }

    // Per-property table
    const propRevMap = new Map();
    payments.forEach(p => {
      const id   = p.propertyId;
      const prop = byId('properties', id);
      const name = prop?.name || 'Unknown';
      const type = p.stream === 'short_term_rental' ? 'STR' : p.stream === 'long_term_rental' ? 'LTR' : 'Other';
      const eur  = toEUR(p.amount, p.currency, p.date);
      const e    = propRevMap.get(id) || { id, name, type, eur: 0, count: 0 };
      e.eur  += eur;
      e.count++;
      propRevMap.set(id, e);
    });
    const props = [...propRevMap.values()].sort((a, b) => b.eur - a.eur);
    if (props.length) {
      body.appendChild(mkSectionLabel('By Property'));
      const hdrs = [
        { label: 'Property', tip: 'Rental property name.' },
        { label: 'Type', muted: true, tip: 'Rental type — STR (short-term) or LTR (long-term).' },
        { label: 'Payments', right: true, muted: true, tip: 'Number of paid payments recorded for this property.' },
        { label: 'Revenue', right: true, tip: 'Total EUR revenue from this property.' },
        { label: '% of Rental', right: true, muted: true, tip: 'This property\'s share of total rental revenue.' }
      ];
      const rows = props.map(p => [
        p.name, p.type, String(p.count),
        mkDrillValue(formatEUR(p.eur), () => drillDownModal(`Rental Revenue — ${p.name}`, drillRevRowsPnL(payments.filter(pp => pp.propertyId === p.id), []), REV_COLS)),
        propRev > 0 ? (p.eur / propRev * 100).toFixed(1) + '%' : '—'
      ]);
      body.appendChild(mkModalTable(hdrs, rows));
    }

    openModal({ title: `Rental Revenue — ${formatEUR(propRev)}`, body, large: true });
  };

  // ── Top Contributor drill-down (scoped to a single entity) ─────────────────
  const contribDrill = (c, cmp) => {
    if (!c) return;
    const pays = c.type === 'Property' ? payments.filter(p => p.propertyId === c.id) : [];
    const invs = c.type === 'Client'   ? pnlInvs(invoices.filter(i => i.clientId   === c.id)) : [];
    const eur  = pays.reduce((s, p) => s + toEUR(p.amount, p.currency, p.date), 0) + invs.reduce((s, i) => s + toEUR(i.total, i.currency, i.issueDate), 0);
    const body = el('div');

    if (cmp) {
      const cPays = c.type === 'Property' ? (cmp.payments || []).filter(p => p.propertyId === c.id) : [];
      const cInvs = c.type === 'Client'   ? pnlInvs((cmp.invoices || []).filter(i => i.clientId   === c.id)) : [];
      const cEur  = cPays.reduce((s, p) => s + toEUR(p.amount, p.currency, p.date), 0) + cInvs.reduce((s, i) => s + toEUR(i.total, i.currency, i.issueDate), 0);
      body.appendChild(mkCmpGrid([
        { label: 'Revenue',
          curVal: mkDrillValue(formatEUR(eur), () => drillDownModal(`Revenue — ${c.name}`, drillRevRowsPnL(pays, invs), REV_COLS)),
          cmpVal: mkDrillValue(formatEUR(cEur), () => drillDownModal(`Revenue — ${c.name} — ${cl}`, drillRevRowsPnL(cPays, cInvs), REV_COLS)) },
      ], 'Current Period', cl));
    } else {
      body.appendChild(mkSummaryGrid([
        { label: 'Revenue', value: formatEUR(eur) },
        { label: 'Records', value: String(pays.length + invs.length) },
        { label: 'Share of Total', value: total > 0 ? (eur / total * 100).toFixed(1) + '%' : '—' }
      ], 3));
    }
    const byMonth = revByMonth(pays, invs);
    if (byMonth.length) {
      body.appendChild(mkSectionLabel('By Month'));
      body.appendChild(mkModalTable(
        [
          { label: 'Month', tip: 'Calendar month the revenue was recorded in.' },
          { label: 'Records', right: true, muted: true, tip: 'Number of payments or invoices in this month.' },
          { label: 'Revenue', right: true, tip: 'Total EUR revenue for this month.' }
        ],
        byMonth.map(m => [monthKeyLabel(m.key), String(m.count), formatEUR(m.eur)])
      ));
    }
    appendRawLink(body, pays.length + invs.length, () => drillDownModal(`Revenue — ${c.name}`, drillRevRowsPnL(pays, invs), REV_COLS));
    openModal({ title: `Revenue — ${c.name}`, body, large: true });
  };

  const wrapper = el('div', { class: 'mb-16' });

  // ── Composite cards row ──────────────────────────────────────────────────────
  const compGrid = el('div', { style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:12px;margin-bottom:12px' });

  compGrid.appendChild(mkKpiCard({
    label: 'Total Revenue', value: formatEUR(total),
    delta: dTotal, compLabel: cl, compValue: cmp ? formatEUR(cmp.total) : undefined,
    onClick: totalRevDrill,
    explain: {
      title: 'Total Revenue',
      formula: 'Rental Revenue + Service Revenue for the selected period.',
      inputs: [
        { label: 'Rental Revenue', value: formatEUR(propRev) },
        { label: 'Service Revenue', value: formatEUR(svcRev) }
      ],
      source: 'analytics-revenue.js:154 getData()',
      note: 'Only paid payments and paid invoices count toward revenue.'
    },
    lines: [
      { label: 'Rental',   value: formatEUR(propRev), pct: pct(propRev, total), onClick: rentalRevDrill },
      { label: 'Services', value: formatEUR(svcRev),  pct: pct(svcRev,  total), onClick: serviceRevDrill },
    ]
  }));

  compGrid.appendChild(mkKpiCard({
    label: 'Service Revenue', value: formatEUR(svcRev),
    delta: dService, compLabel: cl, compValue: cmp ? formatEUR(cmp.svcRev) : undefined,
    onClick: serviceRevDrill,
    explain: {
      title: 'Service Revenue',
      formula: 'Sum of paid invoices (Customer Success + Marketing Services) in the selected period.',
      inputs: [
        { label: 'Customer Success', value: formatEUR(csRev) },
        { label: 'Marketing Services', value: formatEUR(mktRev) }
      ],
      source: 'analytics-revenue.js:149 getData()',
      note: 'Only invoices with status \'paid\' count here; \'sent\'/\'overdue\' invoices show up as Outstanding instead.'
    },
    lines: [
      { label: 'Customer Success',   value: formatEUR(csRev),  pct: pct(csRev,  svcRev),
        onClick: () => openStreamDrill('Customer Success',   [], invoices.filter(i => i.stream === 'customer_success')) },
      { label: 'Marketing Services', value: formatEUR(mktRev), pct: pct(mktRev, svcRev),
        onClick: () => openStreamDrill('Marketing Services', [], invoices.filter(i => i.stream === 'marketing_services')) },
    ]
  }));

  compGrid.appendChild(mkKpiCard({
    label: 'Rental Revenue', value: formatEUR(propRev),
    delta: dRental, compLabel: cl, compValue: cmp ? formatEUR(cmp.propRev) : undefined,
    onClick: rentalRevDrill,
    explain: {
      title: 'Rental Revenue',
      formula: 'Sum of paid rental payments (Short-term + Long-term) in the selected period.',
      inputs: [
        { label: 'Short-term Rental', value: formatEUR(stRev) },
        { label: 'Long-term Rental', value: formatEUR(ltRev) }
      ],
      source: 'analytics-revenue.js:148 getData()',
      note: 'Only payments with status \'paid\' count here.'
    },
    lines: [
      { label: 'Short-term', value: formatEUR(stRev), pct: pct(stRev, propRev),
        onClick: () => openStreamDrill('Short-term Rental', payments.filter(p => p.stream === 'short_term_rental'), []) },
      { label: 'Long-term',  value: formatEUR(ltRev), pct: pct(ltRev, propRev),
        onClick: () => openStreamDrill('Long-term Rental',  payments.filter(p => p.stream === 'long_term_rental'),  []) },
    ]
  }));

  compGrid.appendChild(mkKpiCard({
    label: 'Top Contributor', value: contribs[0]?.name || '—',
    delta: null, compLabel: '',
    onClick: () => contribDrill(contribs[0], cmp),
    explain: {
      title: 'Top Contributor',
      formula: 'All revenue is grouped by property (payments) or client (invoices) and summed; the highest-revenue entity is shown.',
      inputs: [
        { label: 'Name', value: contribs[0]?.name || '—' },
        { label: 'Type', value: contribs[0]?.type || '—' },
        { label: 'Revenue', value: contribs[0] ? formatEUR(contribs[0].val) : '—' }
      ],
      source: 'analytics-revenue.js:186 buildKpiSection() (contribs)',
      note: contribs.length ? '' : 'No contributors in the selected period.'
    },
    lines: contribs.slice(0, 3).map((c, i) => ({
      label: `#${i + 1} ${c.type}`, value: c.name, pct: pct(c.val, total),
      onClick: () => contribDrill(c, cmp),
    }))
  }));

  // Revenue Concentration KPI
  {
    const topC    = contribs[0];
    const concPct = total > 0 && topC ? topC.val / total * 100 : 0;
    const concVariant  = concPct < 40 ? 'success' : concPct >= 60 ? 'warning' : '';
    const concStatus   = concPct < 40 ? 'Healthy' : concPct < 60 ? 'Watch' : 'Risk';
    const concTypeLbl  = topC?.type === 'Property' ? 'property' : topC?.type === 'Client' ? 'client' : 'contributor';
    compGrid.appendChild(mkKpiCard({
      label:    'Revenue Concentration',
      value:    total > 0 ? `${concPct.toFixed(1)}%` : '0%',
      subtitle: `Top ${concTypeLbl} share · ${concStatus}`,
      variant:  concVariant,
      explain: {
        title: 'Revenue Concentration',
        formula: 'Top contributor\'s revenue ÷ Total revenue × 100.',
        inputs: [
          { label: 'Top Contributor', value: topC?.name || '—' },
          { label: 'Top Contributor Revenue', value: topC ? formatEUR(topC.val) : '—' },
          { label: 'Total Revenue', value: formatEUR(total) }
        ],
        source: 'analytics-revenue.js:501 buildKpiSection() (concPct)',
        note: 'Below 40% is Healthy, 40–59% is Watch, 60%+ is Risk.'
      },
      onClick:  () => {
        const body = el('div');
        body.appendChild(mkSummaryGrid([
          { label: 'Top Contributor', value: topC?.name || '—', sub: topC ? concTypeLbl : null },
          { label: 'Share of Total',  value: total > 0 ? `${concPct.toFixed(1)}%` : '0%', sub: concStatus },
          { label: 'Total Revenue',   value: formatEUR(total) }
        ], 3));
        body.appendChild(mkSectionLabel('All Contributors'));
        body.appendChild(mkModalTable(
          [{ label: 'Type', muted: true }, { label: 'Name' }, { label: 'Revenue', right: true }, { label: 'Share', right: true, muted: true }],
          contribs.map(c => [c.type, c.name, mkDrillValue(formatEUR(c.val), () => contribDrill(c)), total > 0 ? (c.val / total * 100).toFixed(1) + '%' : '0%'])
        ));
        openModal({ title: `Revenue Concentration — ${total > 0 ? concPct.toFixed(1) + '%' : '0%'}`, body, large: true });
      }
    }));
  }

  // Average Rental Revenue / Property (composite, STR and LTR separately)
  compGrid.appendChild(mkKpiCard({
    label:   'Avg Rental Revenue / Property',
    value:   avgRental !== null ? formatEUR(avgRental) : '—',
    delta:   null,
    compLabel: '',
    subtitle: allRentalPropIds.size > 0 ? `${allRentalPropIds.size} revenue-generating propert${allRentalPropIds.size > 1 ? 'ies' : 'y'}` : 'No rental revenue',
    explain: {
      title: 'Avg Rental Revenue / Property',
      formula: '(Short-term Revenue + Long-term Revenue) ÷ number of distinct properties with any rental revenue in the period.',
      inputs: [
        { label: 'Rental Revenue', value: formatEUR(stRev + ltRev) },
        { label: 'Revenue-generating Properties', value: String(allRentalPropIds.size) }
      ],
      source: 'analytics-revenue.js:183 buildKpiSection() (avgRental)',
      note: 'Properties with zero rental revenue this period are excluded from the denominator, so this is not the same as revenue ÷ total owned properties.'
    },
    onClick: () => {
      const body = el('div');
      body.appendChild(mkSectionLabel('Avg Revenue / Property'));
      body.appendChild(mkModalTable(
        [{ label: 'Rental Type' }, { label: 'Revenue', right: true }, { label: 'Revenue Properties', right: true, muted: true }, { label: 'Avg / Property', right: true }],
        [
          ['Short-term', mkDrillValue(formatEUR(stRev), () => openStreamDrill('Short-term Rental', payments.filter(p => p.stream === 'short_term_rental'), [])), String(strPropIds.size), formatEUR(strPropIds.size > 0 ? avgStr : 0)],
          ['Long-term',  mkDrillValue(formatEUR(ltRev), () => openStreamDrill('Long-term Rental',  payments.filter(p => p.stream === 'long_term_rental'),  [])), String(ltrPropIds.size), formatEUR(ltrPropIds.size > 0 ? avgLtr : 0)]
        ]
      ));
      openModal({ title: 'Avg Rental Revenue / Property', body, large: true });
    },
    lines: [
      {
        label: 'Short-term',
        value: strPropIds.size > 0 ? formatEUR(avgStr) : '€0',
        pct:   strPropIds.size > 0 ? `${strPropIds.size} prop${strPropIds.size > 1 ? 's' : ''}` : 'no revenue',
        onClick: () => openStreamDrill('Short-term Rental', payments.filter(p => p.stream === 'short_term_rental'), [])
      },
      {
        label: 'Long-term',
        value: ltrPropIds.size > 0 ? formatEUR(avgLtr) : '€0',
        pct:   ltrPropIds.size > 0 ? `${ltrPropIds.size} prop${ltrPropIds.size > 1 ? 's' : ''}` : 'no revenue',
        onClick: () => openStreamDrill('Long-term Rental', payments.filter(p => p.stream === 'long_term_rental'), [])
      }
    ]
  }));

  wrapper.appendChild(compGrid);
  return wrapper;
}

// ── Revenue Performance Insights ──────────────────────────────────────────────
function buildRevenueInsights(curData, cmpData, cmpRange) {
  const { payments, invoices, outstanding, propRev, svcRev, svcRevCash, total, outstandingTotal } = curData;

  const section = el('div', { class: 'card mb-16' });
  section.appendChild(el('div', { class: 'card-header' },
    el('div', { class: 'card-title' }, 'Revenue Performance Insights')
  ));
  const body = el('div', { style: 'padding:0 16px 16px' });

  const signals = []; // { title, text, severity: 'At Risk'|'Watch'|'Note', inspect, onClick }

  // ── 1. Revenue concentration ───────────────────────────────────────────────
  const entityMap = new Map();
  payments.forEach(p => {
    const key  = 'p:' + (p.propertyId || 'unknown');
    const name = byId('properties', p.propertyId)?.name || 'Unknown Property';
    const e    = entityMap.get(key) || { name, rev: 0, pays: [], invs: [] };
    e.rev += toEUR(p.amount, p.currency, p.date);
    e.pays.push(p);
    entityMap.set(key, e);
  });
  invoices.forEach(i => {
    const key  = 'c:' + (i.clientId || 'unknown');
    const name = byId('clients', i.clientId)?.name || 'Unknown Client';
    const e    = entityMap.get(key) || { name, rev: 0, pays: [], invs: [] };
    e.rev += toEUR(i.subtotal ?? i.total, i.currency, i.issueDate);
    e.invs.push({ ...i, total: i.subtotal ?? i.total });
    entityMap.set(key, e);
  });
  const topEntity = [...entityMap.values()].sort((a, b) => b.rev - a.rev)[0];
  if (topEntity && total > 0) {
    const pct      = topEntity.rev / total * 100;
    const severity = pct >= 60 ? 'At Risk' : pct >= 40 ? 'Watch' : 'Note';
    signals.push({
      title:   'Revenue Concentration',
      text:    `Top contributor: ${topEntity.name} — ${formatEUR(topEntity.rev)} (${pct.toFixed(0)}% of total).${pct >= 60 ? ' High concentration — consider diversifying revenue sources.' : ''}`,
      severity,
      inspect: 'Revenue Dashboard',
      onClick: () => {
        const body = el('div');
        body.appendChild(mkSummaryGrid([
          { label: 'Revenue',        value: formatEUR(topEntity.rev) },
          { label: 'Records',        value: String(topEntity.pays.length + topEntity.invs.length) },
          { label: 'Share of Total', value: `${pct.toFixed(1)}%` }
        ], 3));
        const byMonth = revByMonth(topEntity.pays, topEntity.invs);
        if (byMonth.length) {
          body.appendChild(mkSectionLabel('By Month'));
          body.appendChild(mkModalTable(
            [
          { label: 'Month', tip: 'Calendar month the revenue was recorded in.' },
          { label: 'Records', right: true, muted: true, tip: 'Number of payments or invoices in this month.' },
          { label: 'Revenue', right: true, tip: 'Total EUR revenue for this month.' }
        ],
            byMonth.map(m => [monthKeyLabel(m.key), String(m.count), formatEUR(m.eur)])
          ));
        }
        appendRawLink(body, topEntity.pays.length + topEntity.invs.length,
          () => drillDownModal(`Revenue — ${topEntity.name}`, drillRevRowsPnL(topEntity.pays, topEntity.invs), REV_COLS));
        openModal({ title: `Revenue — ${topEntity.name}`, body, large: true });
      }
    });
  }

  // ── 2. Revenue mix ─────────────────────────────────────────────────────────
  if (total > 0) {
    if (propRev === 0) {
      signals.push({
        title:   'Revenue Mix',
        text:    `No rental revenue this period — 100% from services (${formatEUR(svcRev)}).`,
        severity: 'Watch',
        inspect: 'Payments / Properties',
        onClick: () => openStreamDrill('Service Revenue', [], invoices)
      });
    } else if (svcRev === 0) {
      signals.push({
        title:   'Revenue Mix',
        text:    `No service revenue this period — 100% from rentals (${formatEUR(propRev)}).`,
        severity: 'Note',
        inspect: 'Services Dashboard',
        onClick: () => openStreamDrill('Rental Revenue', payments, [])
      });
    } else {
      const rentalPct = (propRev / total * 100).toFixed(0);
      const svcPct    = (svcRev  / total * 100).toFixed(0);
      signals.push({
        title:   'Revenue Mix',
        text:    `Rental ${rentalPct}% (${formatEUR(propRev)}) · Service ${svcPct}% (${formatEUR(svcRev)}).`,
        severity: 'Note',
        inspect: 'Revenue Dashboard',
        onClick: () => {
          const body = el('div');
          body.appendChild(mkSummaryGrid([
            { label: 'Rental Revenue',  value: formatEUR(propRev), sub: `${rentalPct}% of total` },
            { label: 'Service Revenue', value: formatEUR(svcRev),  sub: `${svcPct}% of total` },
          ], 2));
          const streams = revByStream(payments, pnlInvs(invoices));
          if (streams.length) {
            body.appendChild(mkSectionLabel('By Stream'));
            body.appendChild(mkModalTable(
              [
          { label: 'Stream', tip: 'Revenue stream — short-term rental, long-term rental, customer success, or marketing services.' },
          { label: 'Records', right: true, muted: true, tip: 'Number of payments or invoices in this stream for the selected slice.' },
          { label: 'Revenue', right: true, tip: 'Total EUR revenue from this stream for the selected slice.' },
          { label: '% of Total', right: true, muted: true, tip: 'This stream\'s share of the slice\'s total revenue.' }
        ],
              streams.map(s => [s.name, String(s.count), formatEUR(s.eur), total > 0 ? (s.eur / total * 100).toFixed(1) + '%' : '—'])
            ));
            appendRawLink(body, payments.length + invoices.length, () => drillDownModal('Revenue Mix', drillRevRowsPnL(payments, invoices), REV_COLS));
          } else {
            body.appendChild(mkEmptyState('No revenue records for the current period.'));
          }
          openModal({ title: `Revenue Mix — ${formatEUR(total)}`, body, large: true });
        }
      });
    }
  }

  // ── 3. Growth signal ───────────────────────────────────────────────────────
  if (cmpData && cmpRange) {
    const delta = safePct(total, cmpData.total);
    if (delta !== null) {
      const sign     = delta > 0 ? '+' : '';
      const word     = delta > 1 ? 'up' : delta < -1 ? 'down' : 'stable';
      const severity = delta <= -20 ? 'At Risk' : delta < 0 ? 'Watch' : 'Note';
      signals.push({
        title:   'Growth Signal',
        text:    `Revenue ${word} ${sign}${delta.toFixed(1)}% vs ${cmpRange.label} (${formatEUR(cmpData.total)} → ${formatEUR(total)}).`,
        severity,
        inspect: 'Revenue Dashboard',
        onClick: () => {
          const body = el('div');
          body.appendChild(mkSummaryGrid([
            { label: 'Revenue — Current Period',   value: formatEUR(total) },
            { label: `Revenue — ${cmpRange.label}`, value: formatEUR(cmpData.total) },
            { label: 'Change',                      value: `${sign}${delta.toFixed(1)}%` },
          ], 3));
          const streams = revByStream(payments, pnlInvs(invoices));
          if (streams.length) {
            body.appendChild(mkSectionLabel('By Stream — Current Period'));
            body.appendChild(mkModalTable(
              [
          { label: 'Stream', tip: 'Revenue stream — short-term rental, long-term rental, customer success, or marketing services.' },
          { label: 'Records', right: true, muted: true, tip: 'Number of payments or invoices in this stream for the selected slice.' },
          { label: 'Revenue', right: true, tip: 'Total EUR revenue from this stream for the selected slice.' },
          { label: '% of Total', right: true, muted: true, tip: 'This stream\'s share of the slice\'s total revenue.' }
        ],
              streams.map(s => [s.name, String(s.count), formatEUR(s.eur), total > 0 ? (s.eur / total * 100).toFixed(1) + '%' : '—'])
            ));
            appendRawLink(body, payments.length + invoices.length, () => drillDownModal('Growth Signal — Current Period', drillRevRowsPnL(payments, invoices), REV_COLS));
          } else {
            body.appendChild(mkEmptyState('No revenue records for the current period.'));
          }
          openModal({ title: `Growth Signal — ${formatEUR(total)} vs ${formatEUR(cmpData.total)}`, body, large: true });
        }
      });
    }
  }

  // ── 4. Outstanding signal ──────────────────────────────────────────────────
  const invoicedTotal = svcRevCash + outstandingTotal;
  if (outstandingTotal > 0 && invoicedTotal > 0) {
    const pct = outstandingTotal / invoicedTotal * 100;
    signals.push({
      title:   'Outstanding Revenue',
      text:    `${formatEUR(outstandingTotal)} outstanding — ${pct.toFixed(0)}% of invoiced service revenue.${pct > 30 ? ' High collection risk.' : ''}`,
      severity: pct > 50 ? 'At Risk' : 'Watch',
      inspect: 'Services Dashboard',
      onClick: () => {
        const body = el('div');
        body.appendChild(mkSummaryGrid([
          { label: 'Outstanding',   value: formatEUR(outstandingTotal) },
          { label: 'Invoices',     value: String(outstanding.length) },
          { label: '% of Invoiced', value: `${pct.toFixed(1)}%` }
        ], 3));
        const clients = revByClient(outstanding);
        if (clients.length) {
          body.appendChild(mkSectionLabel('By Client'));
          body.appendChild(mkModalTable(
            [
              { label: 'Client', tip: 'Client with unpaid (sent or overdue) invoices.' },
              { label: 'Invoices', right: true, muted: true, tip: 'Number of outstanding invoices from this client.' },
              { label: 'Outstanding', right: true, tip: 'Total EUR still unpaid for this client.' },
              { label: '% of Total', right: true, muted: true, tip: 'This client\'s share of total outstanding revenue.' }
            ],
            clients.map(c => [c.name, String(c.count), formatEUR(c.eur), outstandingTotal > 0 ? (c.eur / outstandingTotal * 100).toFixed(1) + '%' : '—'])
          ));
        }
        appendRawLink(body, outstanding.length, () => drillDownModal('Outstanding Revenue',
          outstanding.map(i => ({
            date:   i.issueDate, type: 'Invoice',
            source: byId('clients', i.clientId)?.name || '',
            ref:    i.number || '',
            eur:    toEUR(i.total, i.currency, i.issueDate)
          })).sort((a, b) => (b.date || '').localeCompare(a.date || '')),
          REV_COLS));
        openModal({ title: `Outstanding Revenue — ${formatEUR(outstandingTotal)}`, body, large: true });
      }
    });
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  if (!signals.length) {
    body.appendChild(el('div', { style: 'font-size:13px;color:var(--text-muted)' },
      `No major revenue risks detected for the selected period. Total revenue: ${formatEUR(total)}.`));
    section.appendChild(body);
    return section;
  }

  const SEV_COLOR = { 'At Risk': '#ef4444', 'Watch': '#f59e0b', 'Note': '#6366f1' };
  const SEV_BG    = { 'At Risk': 'rgba(239,68,68,0.06)', 'Watch': 'rgba(245,158,11,0.06)', 'Note': 'rgba(99,102,241,0.06)' };
  const grid = el('div', { style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px' });

  for (const sig of signals) {
    const color = SEV_COLOR[sig.severity] || '#6b7280';
    const bg    = SEV_BG[sig.severity]    || 'transparent';
    const block = el('div', { style: `padding:10px 12px;border-radius:4px;border-left:3px solid ${color};background:${bg}` });

    const titleRow = el('div', { style: 'display:flex;align-items:center;justify-content:space-between;margin-bottom:4px' });
    titleRow.appendChild(el('span', { style: 'font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-muted)' }, sig.title));
    titleRow.appendChild(el('span', { style: `font-size:10px;font-weight:700;padding:1px 6px;border-radius:10px;color:${color};border:1px solid ${color}` }, sig.severity));
    block.appendChild(titleRow);

    const p = el('p', { style: 'margin:0 0 5px;font-size:12px;line-height:1.5;color:var(--text)' }, sig.text);
    if (sig.onClick) { p.style.cursor = 'pointer'; p.title = 'Click for breakdown'; p.onclick = sig.onClick; }
    block.appendChild(p);
    if (sig.inspect) block.appendChild(el('div', { style: 'font-size:11px;color:var(--text-muted)' }, `→ Inspect: ${sig.inspect}`));

    grid.appendChild(block);
  }

  body.appendChild(grid);
  section.appendChild(body);
  return section;
}

// ── Rebuild ───────────────────────────────────────────────────────────────────
function rebuildView() {
  CHART_IDS.forEach(id => charts.destroy(id));
  const c = document.getElementById('content');
  if (!c) return;
  c.innerHTML = '';
  c.appendChild(buildView());
}

// ── Chart renderers ───────────────────────────────────────────────────────────

function renderTrend({ payments, invoices, payByMonth, invByMonth }, months) {
  const data = months.map(m => {
    const p = (payByMonth.get(m.key) || []).reduce((s, x) => s + toEUR(x.amount, x.currency, x.date), 0);
    const i = (invByMonth.get(m.key) || []).reduce((s, x) => s + toEUR(x.subtotal ?? x.total, x.currency, x.issueDate), 0);
    return Math.round(p + i);
  });
  if (!data.some(v => v > 0)) return;
  charts.line('rev-trend', {
    labels: months.map(m => m.label),
    datasets: [{ label: 'Revenue', data, borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,0.08)', fill: true }],
    onClickItem: (_, idx) => {
      const mk = months[idx]?.key;
      if (!mk) return;
      const mPays = payments.filter(p => p.date?.slice(0, 7) === mk);
      const mInvs = pnlInvs(invoices.filter(i => (i.issueDate || '').slice(0, 7) === mk));
      const mTotal = mPays.reduce((s, p) => s + toEUR(p.amount, p.currency, p.date), 0) + mInvs.reduce((s, i) => s + toEUR(i.total, i.currency, i.issueDate), 0);
      const body = el('div');
      body.appendChild(mkSummaryGrid([
        { label: 'Revenue',  value: formatEUR(mTotal) },
        { label: 'Payments', value: String(mPays.length) },
        { label: 'Invoices', value: String(mInvs.length) }
      ], 3));
      const streams = revByStream(mPays, mInvs);
      if (streams.length) {
        body.appendChild(mkSectionLabel('By Stream'));
        body.appendChild(mkModalTable(
          [
          { label: 'Stream', tip: 'Revenue stream — short-term rental, long-term rental, customer success, or marketing services.' },
          { label: 'Records', right: true, muted: true, tip: 'Number of payments or invoices in this stream for the selected slice.' },
          { label: 'Revenue', right: true, tip: 'Total EUR revenue from this stream for the selected slice.' },
          { label: '% of Total', right: true, muted: true, tip: 'This stream\'s share of the slice\'s total revenue.' }
        ],
          streams.map(s => [s.name, String(s.count), formatEUR(s.eur), mTotal > 0 ? (s.eur / mTotal * 100).toFixed(1) + '%' : '—'])
        ));
      }
      appendRawLink(body, mPays.length + mInvs.length, () => drillDownModal(`${months[idx].label} — Revenue`, drillRevRowsPnL(mPays, mInvs), REV_COLS));
      openModal({ title: `${months[idx].label} — Revenue`, body, large: true });
    }
  });
}

function renderStreamBar({ payments, invoices }, months) {
  const smMap = new Map();
  const add   = (sk, mk, eur) => { if (!smMap.has(sk)) smMap.set(sk, new Map()); const m = smMap.get(sk); m.set(mk, (m.get(mk) || 0) + eur); };
  payments.forEach(p => { const mk = p.date?.slice(0, 7); if (mk) add(p.stream || 'other', mk, toEUR(p.amount, p.currency, p.date)); });
  invoices.forEach(i => { const mk = (i.issueDate || '').slice(0, 7); if (mk) add(i.stream || 'other', mk, toEUR(i.subtotal ?? i.total, i.currency, i.issueDate)); });
  if (!smMap.size) return;
  const orderedKeys = [...Object.keys(STREAMS).filter(k => smMap.has(k)), ...[...smMap.keys()].filter(k => !STREAMS[k])];
  charts.bar('rev-stream-bar', {
    labels: months.map(m => m.label),
    datasets: orderedKeys.map(sk => ({
      label: STREAMS[sk]?.label || sk,
      data:  months.map(m => Math.round(smMap.get(sk)?.get(m.key) || 0)),
      backgroundColor: STREAMS[sk]?.color || '#8b93b0'
    })),
    stacked: true,
    onClickItem: (label, idx, dsIdx) => {
      const mk = months[idx]?.key;
      if (!mk) return;
      const sk = orderedKeys[dsIdx];
      const title = `${label} — ${STREAMS[sk]?.label || sk}`;
      const sPays = payments.filter(p => p.date?.slice(0, 7) === mk && (p.stream || 'other') === sk);
      const sInvs = pnlInvs(invoices.filter(i => (i.issueDate || '').slice(0, 7) === mk && (i.stream || 'other') === sk));
      const sTotal = sPays.reduce((s, p) => s + toEUR(p.amount, p.currency, p.date), 0) + sInvs.reduce((s, i) => s + toEUR(i.total, i.currency, i.issueDate), 0);
      const body = el('div');
      body.appendChild(mkSummaryGrid([
        { label: 'Revenue', value: formatEUR(sTotal) },
        { label: 'Records', value: String(sPays.length + sInvs.length) }
      ], 2));
      const entities = revByEntity(sPays, sInvs);
      if (entities.length) {
        body.appendChild(mkSectionLabel(sPays.length ? 'By Property' : 'By Client'));
        body.appendChild(mkModalTable(
          [
            { label: 'Name', tip: 'Property or client name.' },
            { label: 'Records', right: true, muted: true, tip: 'Number of payments or invoices.' },
            { label: 'Revenue', right: true, tip: 'Total EUR revenue.' }
          ],
          entities.map(e => [e.name, String(e.count), formatEUR(e.eur)])
        ));
      }
      appendRawLink(body, sPays.length + sInvs.length, () => drillDownModal(title, drillRevRowsPnL(sPays, sInvs), REV_COLS));
      openModal({ title, body, large: true });
    }
  });
}

function renderOwnerDonut({ payments, invoices }) {
  const owMap = new Map();
  payments.forEach(p => { const ow = byId('properties', p.propertyId)?.owner || 'both'; owMap.set(ow, (owMap.get(ow) || 0) + toEUR(p.amount, p.currency, p.date)); });
  invoices.forEach(i => { const ow = i.owner || 'both'; owMap.set(ow, (owMap.get(ow) || 0) + toEUR(i.subtotal ?? i.total, i.currency, i.issueDate)); });
  const keys = Object.keys(OWNERS).filter(k => (owMap.get(k) || 0) > 0);
  if (!keys.length) return;
  charts.doughnut('rev-owner-donut', {
    labels: keys.map(k => OWNERS[k]),
    data:   keys.map(k => Math.round(owMap.get(k) || 0)),
    colors: keys.map(k => OWNER_COLORS[k] || '#8b93b0'),
    onClickItem: (_, idx) => {
      const ok = keys[idx];
      const oPays = payments.filter(p => (byId('properties', p.propertyId)?.owner || 'both') === ok);
      const oInvs = pnlInvs(invoices.filter(i => (i.owner || 'both') === ok));
      const oTotal = oPays.reduce((s, p) => s + toEUR(p.amount, p.currency, p.date), 0) + oInvs.reduce((s, i) => s + toEUR(i.total, i.currency, i.issueDate), 0);
      const body = el('div');
      body.appendChild(mkSummaryGrid([
        { label: 'Revenue',  value: formatEUR(oTotal) },
        { label: 'Payments', value: String(oPays.length) },
        { label: 'Invoices', value: String(oInvs.length) }
      ], 3));
      const streams = revByStream(oPays, oInvs);
      if (streams.length) {
        body.appendChild(mkSectionLabel('By Stream'));
        body.appendChild(mkModalTable(
          [
          { label: 'Stream', tip: 'Revenue stream — short-term rental, long-term rental, customer success, or marketing services.' },
          { label: 'Records', right: true, muted: true, tip: 'Number of payments or invoices in this stream for the selected slice.' },
          { label: 'Revenue', right: true, tip: 'Total EUR revenue from this stream for the selected slice.' },
          { label: '% of Total', right: true, muted: true, tip: 'This stream\'s share of the slice\'s total revenue.' }
        ],
          streams.map(s => [s.name, String(s.count), formatEUR(s.eur), oTotal > 0 ? (s.eur / oTotal * 100).toFixed(1) + '%' : '—'])
        ));
      }
      const entities = revByEntity(oPays, oInvs).slice(0, 10);
      if (entities.length) {
        body.appendChild(mkSectionLabel('Top Properties / Clients'));
        body.appendChild(mkModalTable(
          [
            { label: 'Name', tip: 'Property or client name.' },
            { label: 'Records', right: true, muted: true, tip: 'Number of payments or invoices.' },
            { label: 'Revenue', right: true, tip: 'Total EUR revenue.' }
          ],
          entities.map(e => [e.name, String(e.count), formatEUR(e.eur)])
        ));
      }
      appendRawLink(body, oPays.length + oInvs.length, () => drillDownModal(`Revenue — ${OWNERS[ok]}`, drillRevRowsPnL(oPays, oInvs), REV_COLS));
      openModal({ title: `Revenue — ${OWNERS[ok]}`, body, large: true });
    }
  });
}

function renderPropBar({ payments }) {
  const map = new Map();
  payments.forEach(p => map.set(p.propertyId, { name: byId('properties', p.propertyId)?.name || 'Unknown', eur: (map.get(p.propertyId)?.eur || 0) + toEUR(p.amount, p.currency, p.date) }));
  const sorted = [...map.entries()].sort((a, b) => b[1].eur - a[1].eur);
  if (!sorted.length) return;
  charts.bar('rev-prop-bar', {
    labels: sorted.map(([, m]) => m.name),
    datasets: [{ label: 'Revenue (EUR)', data: sorted.map(([, m]) => Math.round(m.eur)), backgroundColor: sorted.map((_, i) => `hsla(${(200 + i * 30) % 360},65%,55%,0.85)`) }],
    horizontal: true,
    onClickItem: (_, idx) => {
      const [id, entry] = sorted[idx];
      const pPays = payments.filter(p => p.propertyId === id);
      const body  = el('div');
      body.appendChild(mkSummaryGrid([
        { label: 'Revenue', value: formatEUR(entry.eur) },
        { label: 'Payments', value: String(pPays.length) }
      ], 2));
      const byMonth = revByMonth(pPays, []);
      if (byMonth.length) {
        body.appendChild(mkSectionLabel('By Month'));
        body.appendChild(mkModalTable(
          [
            { label: 'Month', tip: 'Calendar month the payments were recorded in.' },
            { label: 'Payments', right: true, muted: true, tip: 'Number of paid payments in this month for this property.' },
            { label: 'Revenue', right: true, tip: 'Total EUR revenue in this month for this property.' }
          ],
          byMonth.map(m => [monthKeyLabel(m.key), String(m.count), formatEUR(m.eur)])
        ));
      }
      appendRawLink(body, pPays.length, () => drillDownModal(`Revenue — ${entry.name}`, drillRevRowsPnL(pPays, []), REV_COLS));
      openModal({ title: `Revenue — ${entry.name}`, body, large: true });
    }
  });
}

function renderMixEvolution({ payments, invoices, payByMonth, invByMonth }, months) {
  const rental  = months.map(m => Math.round((payByMonth.get(m.key) || []).reduce((s, p) => s + toEUR(p.amount, p.currency, p.date), 0)));
  const service = months.map(m => Math.round((invByMonth.get(m.key) || []).reduce((s, i) => s + toEUR(i.subtotal ?? i.total, i.currency, i.issueDate), 0)));
  if (!rental.some(v => v > 0) && !service.some(v => v > 0)) return;
  charts.bar('rev-mix-evolution', {
    labels: months.map(m => m.label),
    datasets: [
      { label: 'Rental',  data: rental,  backgroundColor: '#6366f1' },
      { label: 'Service', data: service, backgroundColor: '#10b981' }
    ],
    stacked: true,
    onClickItem: (_, idx, dsIdx) => {
      const mk = months[idx]?.key;
      if (!mk) return;
      if (dsIdx === 0) {
        openStreamDrill(`${months[idx].label} — Rental`, payments.filter(p => p.date?.slice(0, 7) === mk), []);
      } else {
        openStreamDrill(`${months[idx].label} — Service`, [], invoices.filter(i => (i.issueDate || '').slice(0, 7) === mk));
      }
    }
  });
}

function renderGrowthTrend({ payments, invoices, payByMonth, invByMonth }, months) {
  const totals = months.map(m => {
    const p = (payByMonth.get(m.key) || []).reduce((s, x) => s + toEUR(x.amount, x.currency, x.date), 0);
    const i = (invByMonth.get(m.key) || []).reduce((s, x) => s + toEUR(x.subtotal ?? x.total, x.currency, x.issueDate), 0);
    return p + i;
  });
  const growthData = totals.map((v, i) => {
    if (i === 0 || totals[i - 1] === 0) return null;
    const g = (v - totals[i - 1]) / totals[i - 1] * 100;
    return isFinite(g) ? parseFloat(g.toFixed(1)) : null;
  });
  if (!growthData.some(v => v !== null)) return;
  charts.line('rev-growth-trend', {
    labels: months.map(m => m.label),
    datasets: [{ label: 'MoM Growth %', data: growthData, borderColor: '#f59e0b', backgroundColor: 'rgba(245,158,11,0.08)', fill: false }],
    onClickItem: (_, idx) => {
      const m   = months[idx];
      const mk  = m?.key;
      if (!mk) return;

      const label      = m.label;
      const curRev     = totals[idx];
      const prevRev    = idx > 0 ? totals[idx - 1] : null;
      const prevLabel  = idx > 0 ? months[idx - 1].label : null;
      const growthPct  = growthData[idx];

      // Records that contributed to this month
      const mPays = payments.filter(p => p.date?.slice(0, 7) === mk);
      const mInvs = pnlInvs(invoices.filter(i => (i.issueDate || '').slice(0, 7) === mk));

      const body = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });

      // Summary boxes: current month, prior month, growth %
      const summaryItems = [
        { label: `Revenue — ${label}`,              value: formatEUR(curRev) },
        { label: prevLabel ? `Revenue — ${prevLabel}` : 'Prior Month', value: prevRev !== null ? formatEUR(prevRev) : '—' },
        { label: 'MoM Growth',                       value: growthPct !== null ? (growthPct > 0 ? '+' : '') + growthPct.toFixed(1) + '%' : '—' },
      ];
      body.appendChild(mkSummaryGrid(summaryItems, 3));

      // Contributing payments / invoices, grouped by stream
      if (mPays.length > 0 || mInvs.length > 0) {
        const streams = revByStream(mPays, mInvs);
        body.appendChild(mkSectionLabel(`By Stream — ${label}`));
        body.appendChild(mkModalTable(
          [
          { label: 'Stream', tip: 'Revenue stream — short-term rental, long-term rental, customer success, or marketing services.' },
          { label: 'Records', right: true, muted: true, tip: 'Number of payments or invoices in this stream for the selected slice.' },
          { label: 'Revenue', right: true, tip: 'Total EUR revenue from this stream for the selected slice.' },
          { label: '% of Total', right: true, muted: true, tip: 'This stream\'s share of the slice\'s total revenue.' }
        ],
          streams.map(s => [s.name, String(s.count), formatEUR(s.eur), curRev > 0 ? (s.eur / curRev * 100).toFixed(1) + '%' : '—'])
        ));
        appendRawLink(body, mPays.length + mInvs.length, () => drillDownModal(`Revenue — ${label}`, drillRevRowsPnL(mPays, mInvs), REV_COLS));
      } else {
        body.appendChild(mkEmptyState(`No revenue records for ${label}.`));
      }

      openModal({ title: `Revenue — ${label}`, body, large: true });
    }
  });
}

function renderPaidOutstanding({ invoices, invByMonth }, months, start, end) {
  const { mStream, mOwner, mClient } = makeMatchers(gF);
  const allOut = gF.propertyIds.size > 0 ? [] : listActive('invoices').filter(i =>
    ['sent', 'overdue'].includes(i.status) &&
    i.issueDate && i.issueDate >= start && i.issueDate <= end &&
    mStream(i) && mOwner(i) && mClient(i)
  );
  const outByMonth = groupByMonthKey(allOut, i => i.issueDate);
  const paidData = months.map(m => Math.round((invByMonth.get(m.key) || []).reduce((s, i) => s + toEUR(i.total, i.currency, i.issueDate), 0)));
  const outData  = months.map(m => Math.round((outByMonth.get(m.key) || []).reduce((s, i) => s + toEUR(i.total, i.currency, i.issueDate), 0)));
  if (!paidData.some(v => v > 0) && !outData.some(v => v > 0)) return;
  charts.bar('rev-paid-outstanding', {
    labels: months.map(m => m.label),
    datasets: [
      { label: 'Paid',        data: paidData, backgroundColor: '#10b981' },
      { label: 'Outstanding', data: outData,  backgroundColor: '#f59e0b' }
    ],
    onClickItem: (_, idx, dsIdx) => {
      const mk = months[idx]?.key;
      if (!mk) return;
      const title = dsIdx === 0 ? `${months[idx].label} — Paid` : `${months[idx].label} — Outstanding`;
      // Paid bucket is P&L revenue (VAT-exclusive); Outstanding bucket is AR (VAT-inclusive, real amount owed).
      const mInvs = dsIdx === 0
        ? pnlInvs(invoices.filter(i => (i.issueDate || '').slice(0, 7) === mk))
        : allOut.filter(i => (i.issueDate || '').slice(0, 7) === mk);
      const eur = mInvs.reduce((s, i) => s + toEUR(i.total, i.currency, i.issueDate), 0);
      const body = el('div');
      body.appendChild(mkSummaryGrid([
        { label: dsIdx === 0 ? 'Paid' : 'Outstanding', value: formatEUR(eur) },
        { label: 'Invoices', value: String(mInvs.length) }
      ], 2));
      const clients = revByClient(mInvs);
      if (clients.length) {
        body.appendChild(mkSectionLabel('By Client'));
        body.appendChild(mkModalTable(
          [
            { label: 'Client', tip: 'Client on the invoice(s).' },
            { label: 'Invoices', right: true, muted: true, tip: 'Number of invoices in this bucket for this client.' },
            { label: 'Amount', right: true, tip: 'Total EUR amount for this client in this bucket.' }
          ],
          clients.map(c => [c.name, String(c.count), formatEUR(c.eur)])
        ));
      }
      appendRawLink(body, mInvs.length, () => drillDownModal(title, drillRevRows([], mInvs), REV_COLS));
      openModal({ title, body, large: true });
    }
  });
}

function renderConcentration({ payments, invoices }) {
  const cMap = new Map();
  payments.forEach(p => { const k = 'p:' + p.propertyId; cMap.set(k, { name: byId('properties', p.propertyId)?.name || 'Unknown', eur: (cMap.get(k)?.eur || 0) + toEUR(p.amount, p.currency, p.date), id: p.propertyId, isPay: true }); });
  invoices.forEach(i => { const k = 'c:' + i.clientId;   cMap.set(k, { name: byId('clients', i.clientId)?.name || 'Unknown', eur: (cMap.get(k)?.eur || 0) + toEUR(i.subtotal ?? i.total, i.currency, i.issueDate), id: i.clientId,   isPay: false }); });
  const sorted = [...cMap.values()].sort((a, b) => b.eur - a.eur);
  if (!sorted.length) return;
  const top5   = sorted.slice(0, 5);
  const rest   = sorted.slice(5).reduce((s, v) => s + v.eur, 0);
  const colors = ['#6366f1','#10b981','#f59e0b','#ec4899','#14b8a6','#8b93b0'];
  charts.doughnut('rev-concentration', {
    labels: [...top5.map(v => v.name), ...(rest > 0 ? ['Others'] : [])],
    data:   [...top5.map(v => Math.round(v.eur)), ...(rest > 0 ? [Math.round(rest)] : [])],
    colors: colors.slice(0, top5.length + (rest > 0 ? 1 : 0)),
    onClickItem: (_, idx) => {
      if (idx < top5.length) {
        const e = top5[idx];
        const ePays = e.isPay ? payments.filter(p => p.propertyId === e.id) : [];
        const eInvs = e.isPay ? [] : pnlInvs(invoices.filter(i => i.clientId === e.id));
        const body  = el('div');
        body.appendChild(mkSummaryGrid([
          { label: 'Revenue', value: formatEUR(e.eur) },
          { label: 'Records', value: String(ePays.length + eInvs.length) }
        ], 2));
        const byMonth = revByMonth(ePays, eInvs);
        if (byMonth.length) {
          body.appendChild(mkSectionLabel('By Month'));
          body.appendChild(mkModalTable(
            [
          { label: 'Month', tip: 'Calendar month the revenue was recorded in.' },
          { label: 'Records', right: true, muted: true, tip: 'Number of payments or invoices in this month.' },
          { label: 'Revenue', right: true, tip: 'Total EUR revenue for this month.' }
        ],
            byMonth.map(m => [monthKeyLabel(m.key), String(m.count), formatEUR(m.eur)])
          ));
        }
        appendRawLink(body, ePays.length + eInvs.length, () => drillDownModal(`Revenue — ${e.name}`, drillRevRowsPnL(ePays, eInvs), REV_COLS));
        openModal({ title: `Revenue — ${e.name}`, body, large: true });
        return;
      }
      // "Others" slice — combined revenue of every contributor beyond the Top 5.
      const restEntities  = sorted.slice(5);
      const restPropIds   = new Set(restEntities.filter(e => e.isPay).map(e => e.id));
      const restClientIds = new Set(restEntities.filter(e => !e.isPay).map(e => e.id));
      const restPays = payments.filter(p => restPropIds.has(p.propertyId));
      const restInvs = pnlInvs(invoices.filter(i => restClientIds.has(i.clientId)));
      const body = el('div');
      body.appendChild(mkSummaryGrid([
        { label: 'Revenue',      value: formatEUR(rest) },
        { label: 'Contributors', value: String(restEntities.length) }
      ], 2));
      body.appendChild(mkSectionLabel('By Property / Client'));
      body.appendChild(mkModalTable(
        [
          { label: 'Name', tip: 'Property or client name (outside the Top 5 contributors).' },
          { label: 'Revenue', right: true, tip: 'Total EUR revenue from this contributor.' },
          { label: '% of Others', right: true, muted: true, tip: 'This contributor\'s share of the combined \'Others\' revenue.' }
        ],
        restEntities.map(e => [e.name, formatEUR(e.eur), rest > 0 ? (e.eur / rest * 100).toFixed(1) + '%' : '—'])
      ));
      appendRawLink(body, restPays.length + restInvs.length, () => drillDownModal(`Revenue — Others (${restEntities.length} beyond Top 5)`, drillRevRowsPnL(restPays, restInvs), REV_COLS));
      openModal({ title: `Revenue — Others (${restEntities.length} beyond Top 5)`, body, large: true });
    }
  });
}

function renderAging({ outstanding }) {
  if (!outstanding.length) return;
  const today   = new Date().toISOString().slice(0, 10);
  const buckets = [0, 0, 0, 0];
  const items   = [[], [], [], []];
  outstanding.forEach(i => {
    // Use dueDate if available; otherwise compute due date as issueDate + 30 days
    let dueDate = i.dueDate;
    if (!dueDate && i.issueDate) {
      // `new Date(i.issueDate)` parses a date-only string as UTC midnight;
      // setDate/getDate operate in local time, so in negative-UTC-offset
      // timezones this could shift the computed due date a day off once
      // re-serialized via toISOString (which is UTC). Do the whole
      // computation in UTC to match how it was parsed and re-serialized.
      const d = new Date(i.issueDate);
      d.setUTCDate(d.getUTCDate() + 30);
      dueDate = d.toISOString().slice(0, 10);
    }
    const ref  = dueDate || today;
    const days = Math.max(0, Math.floor((new Date(today) - new Date(ref)) / 86400000));
    const b    = days <= 30 ? 0 : days <= 60 ? 1 : days <= 90 ? 2 : 3;
    buckets[b] += toEUR(i.total, i.currency, i.issueDate);
    items[b].push(i);
  });
  if (!buckets.some(v => v > 0)) return;
  charts.bar('rev-aging', {
    labels:   ['0–30 days', '31–60 days', '61–90 days', '90+ days'],
    datasets: [{ label: 'Outstanding (EUR)', data: buckets.map(Math.round), backgroundColor: ['#10b981', '#f59e0b', '#f97316', '#ef4444'] }],
    onClickItem: (label, idx) => {
      const AGING_COLS = [
        { key: 'source', label: 'Client',    tip: 'Client billed on this outstanding invoice.' },
        { key: 'date',   label: 'Issued',    tip: 'Date the invoice was issued.' },
        { key: 'due',    label: 'Due Date',  tip: 'Date payment is due (issue date + 30 days when no due date is set).' },
        { key: 'eur',    label: 'EUR', right: true, format: v => formatEUR(v), tip: 'Outstanding invoice amount converted to EUR.' }
      ];
      const bucketInvs = items[idx];
      const eur = buckets[idx];
      const body = el('div');
      body.appendChild(mkSummaryGrid([
        { label: 'Outstanding', value: formatEUR(eur) },
        { label: 'Invoices',    value: String(bucketInvs.length) }
      ], 2));
      const clients = revByClient(bucketInvs);
      if (clients.length) {
        body.appendChild(mkSectionLabel('By Client'));
        body.appendChild(mkModalTable(
          [
            { label: 'Client', tip: 'Client on the invoice(s).' },
            { label: 'Invoices', right: true, muted: true, tip: 'Number of invoices in this bucket for this client.' },
            { label: 'Amount', right: true, tip: 'Total EUR amount for this client in this bucket.' }
          ],
          clients.map(c => [c.name, String(c.count), formatEUR(c.eur)])
        ));
      }
      appendRawLink(body, bucketInvs.length, () => drillDownModal(`Outstanding — ${label}`,
        bucketInvs.map(i => ({
          source: byId('clients', i.clientId)?.name || '',
          date:   i.issueDate || '',
          due:    i.dueDate   || '—',
          eur:    toEUR(i.total, i.currency, i.issueDate)
        })), AGING_COLS));
      openModal({ title: `Outstanding — ${label}`, body, large: true });
    }
  });
}

// ── Seasonality heatmap (DOM table, shows all available years for context) ────
function buildSeasonalityHeatmap() {
  const { mStream, mOwner, mProperty, mClient } = makeMatchers(gF);
  const coPropIds = companyPropIds();
  const isCoRec   = r => isCompanyRecord(r, coPropIds);
  const pays = listActivePayments().filter(p => p.status === 'paid' && mStream(p) && mOwner(p) && mProperty(p) && isCoRec(p));
  // P&L revenue heatmap — VAT-exclusive, via pnlInvs (this dashboard's `invs` here is always paid-only).
  const invs = pnlInvs(gF.propertyIds.size > 0 ? [] : listActive('invoices').filter(i => i.status === 'paid' && mStream(i) && mOwner(i) && mClient(i)));
  const years = [...new Set([...pays.map(p => p.date?.slice(0, 4)), ...invs.map(i => i.issueDate?.slice(0, 4))].filter(Boolean))].sort();
  if (!years.length) return null;

  const grid = new Map();
  pays.forEach(p => { const k = p.date?.slice(0, 7); if (k) grid.set(k, (grid.get(k) || 0) + toEUR(p.amount, p.currency, p.date)); });
  invs.forEach(i => { const k = i.issueDate?.slice(0, 7); if (k) grid.set(k, (grid.get(k) || 0) + toEUR(i.total, i.currency, i.issueDate)); });
  const maxVal = Math.max(...grid.values(), 1);

  const wrap  = el('div', { class: 'card mb-16', style: 'overflow-x:auto' });
  wrap.appendChild(el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'Revenue Seasonality')));

  const table = el('table', { style: 'border-collapse:collapse;width:100%;font-size:12px' });
  const htr   = el('tr');
  htr.appendChild(el('th', { style: 'text-align:left;padding:4px 8px;color:var(--text-muted)', title: 'Calendar year.' }, 'Year'));
  MONTH_LABELS.forEach(ml => htr.appendChild(el('th', { style: 'padding:4px 6px;text-align:right;color:var(--text-muted);cursor:help', title: 'Total EUR revenue recorded in this month; cell shading shows relative intensity.' }, ml)));
  table.appendChild(el('thead', {}, htr));

  const tbody = el('tbody');
  years.forEach(y => {
    const tr = el('tr');
    tr.appendChild(el('td', { style: 'padding:4px 8px;font-weight:600;color:var(--text-muted)' }, y));
    MONTH_LABELS.forEach((_, mi) => {
      const mm  = String(mi + 1).padStart(2, '0');
      const key = `${y}-${mm}`;
      const v   = grid.get(key) || 0;
      const alpha = v > 0 ? Math.max(0.1, v / maxVal * 0.8) : 0;
      const td  = el('td', {
        style: `padding:4px 6px;text-align:right;background:rgba(16,185,129,${alpha.toFixed(2)});border-radius:3px;cursor:${v > 0 ? 'pointer' : 'default'}`,
        title: v > 0 ? formatEUR(v) : ''
      }, v > 0 ? fmtK(v) : el('span', { style: 'color:var(--text-muted);opacity:0.4' }, '—'));
      if (v > 0) {
        const capturedKey = key, capturedMi = mi;
        td.onclick = () => {
          const title = `${MONTH_LABELS[capturedMi]} ${y} — Revenue`;
          const mPays = pays.filter(p => p.date?.slice(0, 7) === capturedKey);
          const mInvs = invs.filter(i => i.issueDate?.slice(0, 7) === capturedKey);
          const mTotal = mPays.reduce((s, p) => s + toEUR(p.amount, p.currency, p.date), 0) + mInvs.reduce((s, i) => s + toEUR(i.total, i.currency, i.issueDate), 0);
          const body = el('div');
          body.appendChild(mkSummaryGrid([
            { label: 'Revenue',  value: formatEUR(mTotal) },
            { label: 'Payments', value: String(mPays.length) },
            { label: 'Invoices', value: String(mInvs.length) }
          ], 3));
          const streams = revByStream(mPays, mInvs);
          if (streams.length) {
            body.appendChild(mkSectionLabel('By Stream'));
            body.appendChild(mkModalTable(
              [
          { label: 'Stream', tip: 'Revenue stream — short-term rental, long-term rental, customer success, or marketing services.' },
          { label: 'Records', right: true, muted: true, tip: 'Number of payments or invoices in this stream for the selected slice.' },
          { label: 'Revenue', right: true, tip: 'Total EUR revenue from this stream for the selected slice.' },
          { label: '% of Total', right: true, muted: true, tip: 'This stream\'s share of the slice\'s total revenue.' }
        ],
              streams.map(s => [s.name, String(s.count), formatEUR(s.eur), mTotal > 0 ? (s.eur / mTotal * 100).toFixed(1) + '%' : '—'])
            ));
          }
          appendRawLink(body, mPays.length + mInvs.length, () => drillDownModal(title, drillRevRowsPnL(mPays, mInvs), REV_COLS));
          openModal({ title, body, large: true });
        };
      }
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

// ── Revenue table (collapsed) ─────────────────────────────────────────────────
const TX_COLS = [
  { key: 'type',      label: 'Type',        tip: 'Whether this row is a rental Payment or a service Invoice.' },
  { key: 'date',      label: 'Date',        tip: 'Date the payment was received or the invoice was issued.' },
  { key: 'stream',    label: 'Stream',      tip: 'Revenue stream — short/long-term rental, customer success, or marketing services.' },
  { key: 'entity',    label: 'Entity',      tip: 'Property (for payments) or client (for invoices) tied to this record.' },
  { key: 'owner',     label: 'Owner',       tip: 'Owner of the property or client generating this revenue.' },
  { key: 'status',    label: 'Status',      tip: 'Payment/invoice status, e.g. paid, sent, or overdue.' },
  { key: 'amountEUR', label: 'Amount EUR', right: true, tip: 'Amount converted to EUR at the record\'s own date.' }
];

function buildRevenueTable(container, { payments, invoices }) {
  const rows = [];
  payments.forEach(p => {
    const prop = byId('properties', p.propertyId);
    rows.push({ _date: p.date, _eur: toEUR(p.amount, p.currency, p.date), type: 'Payment', date: fmtDate(p.date), stream: STREAMS[p.stream]?.short || p.stream || '—', entity: prop?.name || '—', owner: OWNERS[prop?.owner] || prop?.owner || '—', status: p.status || '—', amountEUR: formatEUR(toEUR(p.amount, p.currency, p.date)) });
  });
  invoices.forEach(i => {
    const client = byId('clients', i.clientId);
    rows.push({ _date: i.issueDate, _eur: toEUR(i.subtotal ?? i.total, i.currency, i.issueDate), type: 'Invoice', date: fmtDate(i.issueDate), stream: STREAMS[i.stream]?.short || i.stream || '—', entity: client?.name || '—', owner: OWNERS[client?.owner] || client?.owner || '—', status: i.status || '—', amountEUR: formatEUR(toEUR(i.subtotal ?? i.total, i.currency, i.issueDate)) });
  });
  rows.sort((a, b) => (b._date || '').localeCompare(a._date || ''));

  if (rows.length === 0) {
    container.appendChild(mkEmptyState('No revenue records match the selected filters.'));
    return;
  }

  const table = el('table', { class: 'table' });
  const htr   = el('tr');
  TX_COLS.forEach(col => htr.appendChild(mkTh(col)));
  table.appendChild(el('thead', {}, htr));

  const tbody = el('tbody');
  rows.forEach(r => {
    const tr = el('tr');
    TX_COLS.forEach(col => tr.appendChild(el('td', { class: col.right ? 'right num' : '' }, r[col.key] ?? '—')));
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);

  const wrap = el('div', { class: 'table-wrap' });
  wrap.appendChild(table);
  container.appendChild(wrap);
  attachSortFilter(wrap, { initialCol: _revSortCol, initialDir: _revSortDir, initialSearch: _revSearch, onSortChange: (c, d) => { _revSortCol = c; _revSortDir = d; }, onSearchChange: v => { _revSearch = v; } });
  container.appendChild(el('div', { style: 'display:flex;justify-content:space-between;margin-top:8px;font-size:13px' },
    el('span', { style: 'color:var(--text-muted)' }, `${rows.length} record(s)`),
    el('strong', { class: 'num' }, `Total: ${formatEUR(rows.reduce((s, r) => s + (r._eur || 0), 0))}`)
  ));
}

// ── Main view ─────────────────────────────────────────────────────────────────
function buildView() {
  const wrap = el('div', { class: 'view active' });

  wrap.appendChild(el('div', { style: 'margin-bottom:16px' },
    el('h2', { style: 'margin:0 0 4px;font-size:20px;font-weight:700' }, 'Revenue'),
    el('p',  { style: 'margin:0;font-size:13px;color:var(--text-muted)' }, 'Structure · Growth · Collections · Contributors · Dynamics')
  ));

  wrap.appendChild(buildFilterBar(gF, { showOwner: true, showStream: true, showProperty: true, showClient: true, storagePrefix: 'rev', channelScope: gScope === 'all' ? null : 'company', extraReset: resetServiceStatusFilter }, (newGF) => { if (newGF) gF = newGF; rebuildView(); }));

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

  const curRange = getCurrentPeriodRange(gF);
  const cmpRange = getComparisonRange(gF, curRange);
  const curData  = getData(curRange.start, curRange.end);
  const cmpData  = cmpRange ? getData(cmpRange.start, cmpRange.end) : null;

  wrap.appendChild(buildComparisonLine(curRange, cmpRange));

  wrap.appendChild(buildKpiSection(curData, cmpData, cmpRange));
  wrap.appendChild(buildRevenueInsights(curData, cmpData, cmpRange));

  const { keys: months } = getMonthKeysForRange(curRange.start, curRange.end);

  // Row 1: Revenue Trend + Stream
  const row1 = el('div', { class: 'grid grid-2 mb-16' });
  row1.appendChild(el('div', { class: 'card' },
    el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'Revenue Trend')),
    el('div', { class: 'chart-wrap tall' }, el('canvas', { id: 'rev-trend' }))
  ));
  row1.appendChild(el('div', { class: 'card' },
    el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'Revenue by Stream')),
    el('div', { class: 'chart-wrap tall' }, el('canvas', { id: 'rev-stream-bar' }))
  ));
  wrap.appendChild(row1);

  // Row 2: Mix Evolution + Growth Trend
  const row2 = el('div', { class: 'grid grid-2 mb-16' });
  row2.appendChild(el('div', { class: 'card' },
    el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'Revenue Mix Evolution')),
    el('div', { class: 'chart-wrap tall' }, el('canvas', { id: 'rev-mix-evolution' }))
  ));
  row2.appendChild(el('div', { class: 'card' },
    el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'Revenue Growth % (MoM)')),
    el('div', { class: 'chart-wrap tall' }, el('canvas', { id: 'rev-growth-trend' }))
  ));
  wrap.appendChild(row2);

  // Row 3: Property
  // (Revenue by Client was dropped here — it duplicated Services' client
  // chart below, which has the richer per-client drill-down: outstanding,
  // collection rate, and stream breakdown.)
  const row3 = el('div', { class: 'mb-16' });
  row3.appendChild(el('div', { class: 'card' },
    el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'Revenue by Property')),
    el('div', { class: 'chart-wrap tall' }, el('canvas', { id: 'rev-prop-bar' }))
  ));
  wrap.appendChild(row3);

  // Row 4: Concentration + Owner
  const row4 = el('div', { class: 'grid grid-2 mb-16' });
  {
    row4.appendChild(el('div', { class: 'card' },
      el('div', { class: 'card-header' },
        el('div', { class: 'card-title' }, 'Revenue Concentration (Top 5)')),
      el('div', { class: 'chart-wrap tall' }, el('canvas', { id: 'rev-concentration' }))
    ));
  }
  {
    row4.appendChild(el('div', { class: 'card' },
      el('div', { class: 'card-header' },
        el('div', { class: 'card-title' }, 'Revenue by Owner')),
      el('div', { class: 'chart-wrap tall' }, el('canvas', { id: 'rev-owner-donut' }))
    ));
  }
  wrap.appendChild(row4);

  // Row 5: Paid vs Outstanding + Aging
  const row5 = el('div', { class: 'grid grid-2 mb-16' });
  row5.appendChild(el('div', { class: 'card' },
    el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'Paid vs Outstanding (Invoices)')),
    el('div', { class: 'chart-wrap tall' }, el('canvas', { id: 'rev-paid-outstanding' }))
  ));
  row5.appendChild(el('div', { class: 'card' },
    el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'Outstanding Aging')),
    el('div', { class: 'chart-wrap tall' }, el('canvas', { id: 'rev-aging' }))
  ));
  wrap.appendChild(row5);

  // Seasonality heatmap
  const heatmap = buildSeasonalityHeatmap();
  if (heatmap) wrap.appendChild(heatmap);

  // Revenue records (collapsed)
  const tableCard = el('div', { class: 'card' });
  const tableBody = el('div', { style: 'display:none' });
  const toggleBtn = el('button', { style: 'background:none;border:none;color:var(--accent);font-size:13px;cursor:pointer;padding:0' }, 'Show Revenue Records');
  toggleBtn.onclick = () => {
    const hidden = tableBody.style.display === 'none';
    tableBody.style.display = hidden ? '' : 'none';
    toggleBtn.textContent   = hidden ? 'Hide Revenue Records' : 'Show Revenue Records';
  };
  tableCard.appendChild(el('div', { class: 'card-header', style: 'display:flex;align-items:center;justify-content:space-between' },
    el('div', { class: 'card-title' }, 'Revenue Records'), toggleBtn
  ));
  buildRevenueTable(tableBody, curData);
  tableCard.appendChild(tableBody);
  wrap.appendChild(tableCard);

  // ── Services (Customer Success & Marketing) ───────────────────────────────
  // Folded in from the former standalone Services dashboard — same section,
  // same filters/KPIs/charts/table, just composed onto this page instead of
  // its own nav item, since it was really "Revenue filtered to two streams
  // plus client-collections depth (DSO, cohorts, aging) Revenue doesn't have."
  wrap.appendChild(buildServicesSection(gF, curRange, cmpRange, rebuildView));

  setTimeout(() => {
    renderTrend(curData, months);
    renderStreamBar(curData, months);
    renderMixEvolution(curData, months);
    renderGrowthTrend(curData, months);
    renderPropBar(curData);
    renderConcentration(curData);
    renderOwnerDonut(curData);
    renderPaidOutstanding(curData, months, curRange.start, curRange.end);
    renderAging(curData);
  }, 0);

  return wrap;
}
