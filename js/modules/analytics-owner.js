// Owner/Partner Analytics Dashboard — partner P&L, settlement, portfolio split
import { el, openModal, fmtDate, drillDownModal } from '../core/ui.js';
import * as charts from '../core/charts.js';
import { todayYmd } from '../core/dates.js';
import { formatEUR, toEUR, byId, listActive, listActivePayments, isCapEx, getPersonName, companyPropIds, isCompanyRecord } from '../core/data.js';
import {
  createFilterState, buildFilterBar, buildComparisonLine,
  getCurrentPeriodRange, getComparisonRange, getMonthKeysForRange, makeMatchers
} from './analytics-filters.js';
import {
  mkSectionLabel, mkSummaryBox, mkSummaryGrid, mkModalTable, mkVarianceBadge, mkEmptyState, mkKpiCard, mkCmpGrid, safePct, mkExplainButton, mkDrillValue,
  mkDashboardTabs, loadDashboardTab, memoView,
  invoiceOwner, invoiceNetEUR, recordOwner, partnerKey, groupByMonthKey
} from './analytics-helpers.js';
import { SERVICE_STREAMS, STREAMS, PROPERTY_STREAMS } from '../core/config.js';

// ── Constants ─────────────────────────────────────────────────────────────────
const CHART_IDS    = ['own-rev-bar', 'own-profit-hbar', 'own-value-donut'];
const YOU_COLOR    = 'var(--accent, #6366f1)';
const YOU_HEX      = '#6366f1';
const RITA_COLOR   = 'var(--stream-mkt, #ec4899)';
const RITA_HEX     = '#ec4899';
let YOU_LABEL  = 'Giorgos';
let RITA_LABEL = 'Rita';

// Dashboard tabs; `scope` tells which filters apply to the tab's figures.
const OWN_TABS = [
  { id: 'overview',  label: 'Overview',  scope: 'Revenue, expenses, profit and settlement follow the period and comparison filters. The Shared Properties count is as of today.' },
  { id: 'breakdown', label: 'Breakdown', scope: 'Everything on this tab follows the period filter.' },
  { id: 'portfolio', label: 'Portfolio', scope: 'The portfolio held at the end of the selected period (today for a current period): bought by then, not yet sold. All filters apply.' }
];
const OWN_TAB_KEY = 'btf:owner_dash_tab';
let gTab = loadDashboardTab(OWN_TAB_KEY, OWN_TABS);

// ── Filter state ──────────────────────────────────────────────────────────────
let gF = createFilterState();
let gScope = 'company'; // 'company' | 'all'

// ── Module export ─────────────────────────────────────────────────────────────
export default {
  id: 'analytics-owner',
  label: 'Partners',
  icon: '👤',
  render(container) { container.appendChild(buildView()); },
  refresh() { rebuildView(); },
  destroy() { CHART_IDS.forEach(id => charts.destroy(id)); }
};

// ── Owner attribution helper ──────────────────────────────────────────────────
/**
 * splitByOwner(records, amountFn)
 * For each record, determine its owner and attribute amount accordingly.
 * owner='both' → 50/50; 'you' → 100% Giorgos; 'rita' → 100% Rita.
 * Returns { you: number, rita: number }
 */
function splitByOwner(records, amountFn) {
  let you = 0, rita = 0;
  for (const rec of records) {
    const amount = amountFn(rec);
    const owner  = partnerKey(rec._resolvedOwner || rec.owner || 'both');
    if (owner === 'you') {
      you += amount;
    } else if (owner === 'rita') {
      rita += amount;
    } else {
      // 'both' → 50/50
      you  += amount * 0.5;
      rita += amount * 0.5;
    }
  }
  return { you, rita };
}

// ── Data fetching ─────────────────────────────────────────────────────────────
function getData(start, end) {
  const inRange = d => d && d >= start && d <= end;
  const { mStream, mProperty } = makeMatchers(gF);

  const coPropIds = companyPropIds();
  const isCoRec = r => gScope === 'all' || isCompanyRecord(r, coPropIds);

  // Payments — rental income (no owner filter, we split manually)
  const payments = listActivePayments().filter(p =>
    p.status === 'paid' && inRange(p.date) && mStream(p) && mProperty(p) && isCoRec(p)
  );

  // Owner attribution — ONE rule per record kind, shared with the filter
  // matchers: payments/expenses use recordOwner() (property's owner for a
  // property-linked record, else the record's own owner — same as
  // makeMatchers().mOwner); invoices use invoiceOwner(). partnerKey()
  // normalises people-record ids to 'you' | 'rita' | 'both'.
  const annotatedPayments = payments.map(p =>
    ({ ...p, _resolvedOwner: partnerKey(recordOwner(p)), _eur: toEUR(p.amount, p.currency, p.date) }));

  // Invoices — service income. mProperty is applied for consistency with the
  // payments/expenses filters just above — a property-linked invoice used to
  // count toward revenue/splits regardless of which property was selected.
  // isCoRec: an invoice linked to a personal-channel property (or flagged
  // personal) is out of Company scope, same as payments/expenses.
  const invoices = listActive('invoices').filter(i =>
    i.status === 'paid' && inRange(i.issueDate) && mStream(i) && mProperty(i) && isCoRec(i)
  );
  const annotatedInvoices = invoices.map(i => ({
    ...i,
    _resolvedOwner: partnerKey(invoiceOwner(i)),
    // VAT-exclusive: this is a revenue/profit split, not a cash figure — VAT collected isn't the owners' revenue.
    _eur: invoiceNetEUR(i)
  }));

  // Expenses (OpEx only for profit)
  const expenses = listActive('expenses').filter(e => {
    const d = e.date || '';
    return d >= start && d <= end && !isCapEx(e) && mProperty(e) && mStream(e) && isCoRec(e);
  });
  const annotatedExpenses = expenses.map(e =>
    ({ ...e, _resolvedOwner: partnerKey(recordOwner(e)), _eur: toEUR(e.amount, e.currency, e.date) }));

  // All revenue records (payments + invoices), built once and reused by
  // every section/modal instead of re-spreading both arrays each time.
  const revRecords = [...annotatedPayments, ...annotatedInvoices];

  // Revenue split
  const revSplit = splitByOwner(revRecords, r => r._eur);
  // Expense split
  const expSplit = splitByOwner(annotatedExpenses, r => r._eur);

  const total = revSplit.you + revSplit.rita;

  return {
    annotatedPayments,
    annotatedInvoices,
    annotatedExpenses,
    revRecords,
    revSplit,
    expSplit,
    total,
    netSplit: { you: revSplit.you - expSplit.you, rita: revSplit.rita - expSplit.rita }
  };
}

// ── Property stream resolver ──────────────────────────────────────────────────
function propStream(p) {
  if (p.type === 'short_term') return 'short_term_rental';
  if (p.type === 'long_term')  return 'long_term_rental';
  return 'other';
}

// ── Properties data ───────────────────────────────────────────────────────────
// Current portfolio only: sold properties are excluded from book value, and
// the Company scope excludes personal-channel properties (same rule as the
// revenue/expense figures above via isCompanyRecord()).
// Properties held on `asOf` (bought by then, not yet sold) — the end of the
// selected period, or today for a period that hasn't ended; same rule as the
// Properties dashboard's Portfolio & Value tab.
function getPropertiesData(filterState, asOf = todayYmd()) {
  const mPropStream = p => !filterState.streams.size || filterState.streams.has(propStream(p));
  const mPropId     = p => !filterState.propertyIds.size || filterState.propertyIds.has(p.id);
  const mPropScope  = p => gScope === 'all' || (p.channel || 'company') === 'company';
  const heldOn      = p => (!p.purchaseDate || p.purchaseDate <= asOf) &&
    !(p.status === 'sold' && (!p.soldDate || p.soldDate <= asOf));
  const allProps = listActive('properties').filter(p => heldOn(p) && mPropScope(p) && mPropStream(p) && mPropId(p));
  const youProps  = allProps.filter(p => partnerKey(p.owner) === 'you');
  const ritaProps = allProps.filter(p => partnerKey(p.owner) === 'rita');
  const bothProps = allProps.filter(p => partnerKey(p.owner) === 'both');

  function bookValue(props, splitHalf = false) {
    return props.reduce((s, p) => {
      const eur = toEUR(p.purchasePrice || 0, p.currency || 'EUR', p.purchaseDate || null);
      return s + (splitHalf ? eur * 0.5 : eur);
    }, 0);
  }

  const youValue  = bookValue(youProps) + bookValue(bothProps, true);
  const ritaValue = bookValue(ritaProps) + bookValue(bothProps, true);
  const totalValue = youValue + ritaValue;

  return {
    allProps, youProps, ritaProps, bothProps,
    youCount:  youProps.length + bothProps.length,
    ritaCount: ritaProps.length + bothProps.length,
    youValue, ritaValue, totalValue, asOf
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function safePctStr(val, total) {
  if (!total || !isFinite(total)) return '—';
  return (val / total * 100).toFixed(1) + '%';
}

function netColor(val) {
  return val >= 0 ? 'var(--success, #22c55e)' : 'var(--danger, #ef4444)';
}

// ── Drill-down row builders (owner-attributed) ───────────────────────────────
// owner=null → no filter, full record amount, 'Attribution' shows the resolved
// owner; owner='you'/'rita' → filtered to that partner's records (records with
// owner='both' are included at their 50% share — same rule as splitByOwner()).
function toOwnerRevRows(records, owner = null) {
  return records
    .filter(r => !owner || r._resolvedOwner === owner || r._resolvedOwner === 'both')
    .map(r => {
      const shared = r._resolvedOwner === 'both';
      return {
        date: r.date || r.issueDate,
        entity: r.propertyId ? (byId('properties', r.propertyId)?.name || '—')
              : r.clientId   ? (byId('clients', r.clientId)?.name || '—') : '—',
        attribution: shared ? 'Shared (50%)' : (r._resolvedOwner === 'you' ? YOU_LABEL : RITA_LABEL),
        eur: owner && shared ? r._eur * 0.5 : r._eur
      };
    })
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

function toOwnerExpRows(expenses, owner = null) {
  return expenses
    .filter(e => !owner || e._resolvedOwner === owner || e._resolvedOwner === 'both')
    .map(e => {
      const shared = e._resolvedOwner === 'both';
      return {
        date: e.date,
        entity: e.propertyId ? (byId('properties', e.propertyId)?.name || '—') : '—',
        category: e.category || '—',
        attribution: shared ? 'Shared (50%)' : (e._resolvedOwner === 'you' ? YOU_LABEL : RITA_LABEL),
        eur: owner && shared ? e._eur * 0.5 : e._eur
      };
    })
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

function toOwnerMixedRows(revRecords, expRecords, owner = null) {
  return [
    ...toOwnerRevRows(revRecords, owner).map(r => ({ ...r, kind: 'Revenue', category: '—' })),
    ...toOwnerExpRows(expRecords, owner).map(e => ({ ...e, kind: 'Expense' }))
  ].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

const OWNER_REV_COLS = [
  { key: 'date',        label: 'Date',        format: v => fmtDate(v) },
  { key: 'entity',      label: 'Entity' },
  { key: 'attribution', label: 'Attribution' },
  { key: 'eur',         label: 'EUR', right: true, format: v => formatEUR(v) }
];

const OWNER_EXP_COLS = [
  { key: 'date',        label: 'Date',        format: v => fmtDate(v) },
  { key: 'entity',      label: 'Property' },
  { key: 'category',    label: 'Category' },
  { key: 'attribution', label: 'Attribution' },
  { key: 'eur',         label: 'EUR', right: true, format: v => formatEUR(v) }
];

const OWNER_MIXED_COLS = [
  { key: 'date',        label: 'Date',        format: v => fmtDate(v) },
  { key: 'kind',        label: 'Kind' },
  { key: 'entity',      label: 'Entity' },
  { key: 'attribution', label: 'Attribution' },
  { key: 'eur',         label: 'EUR', right: true, format: v => formatEUR(v) }
];

// ── Per-card breakdowns ───────────────────────────────────────────────────────
// Each card / partner figure opens its own table: the amounts that add up to
// that number, grouped by property or client, with a bold Total row equal to
// the figure clicked.
const eurCell  = v => (v == null || v === '' ? '' : formatEUR(v));
const pctCell  = v => (v == null || v === '' ? '' : `${v.toFixed(1)}%`);
const ppCell   = v => (v == null || v === '' ? '' : `${v.toFixed(1)} pp`);
const shareCell = v => (v == null || v === '' ? '' : `${Math.round(v * 100)}%`);
const ownerName = o => (o === 'both' ? 'Shared (50/50)' : o === 'you' ? YOU_LABEL : RITA_LABEL);
// Share of a record a partner gets — same rule as splitByOwner().
const partnerShare = (o, partner) => (o === 'both' ? 0.5 : o === partner ? 1 : 0);
const revEntity = r => r.propertyId ? (byId('properties', r.propertyId)?.name || '—')
                     : r.clientId   ? (byId('clients', r.clientId)?.name || '—') : 'Other';
const expEntity = e => e.propertyId ? (byId('properties', e.propertyId)?.name || '—')
                     : `General — ${e.category || 'uncategorised'}`;

// drillDownModal plus a bold Total row (skipped when there's only one row —
// that row already is the total).
function drillWithTotal(title, rows, cols, total) {
  const all = total && rows.length > 1 ? [...rows, { ...total, _total: true }] : rows;
  drillDownModal(title, all, cols.map(c => ({
    ...c,
    format: (v, r) => {
      const d = c.format ? c.format(v, r) : (v ?? '—');
      return r._total ? el('strong', {}, d instanceof Node ? d : String(d ?? '')) : d;
    }
  })));
}

// Records grouped by entity + owner: { name, owner, n, amt }.
function groupByEntityOwner(records, entityFn) {
  const map = new Map();
  for (const r of records) {
    const name = entityFn(r), owner = r._resolvedOwner || 'both';
    const key = name + '|' + owner;
    const g = map.get(key) || { name, owner, n: 0, amt: 0 };
    g.n += 1; g.amt += r._eur;
    map.set(key, g);
  }
  return [...map.values()];
}

// Total Portfolio Revenue — every property/client, and where its revenue goes.
function openTotalRevenueDrill(data) {
  const rows = groupByEntityOwner(data.revRecords, revEntity).map(g => ({
    ...g, ownerLbl: ownerName(g.owner),
    you: g.amt * partnerShare(g.owner, 'you'), rita: g.amt * partnerShare(g.owner, 'rita')
  })).sort((a, b) => b.amt - a.amt);
  drillWithTotal('Total Portfolio Revenue', rows, [
    { key: 'name', label: 'Property / Client' },
    { key: 'ownerLbl', label: 'Owner' },
    { key: 'n', label: 'Records', right: true },
    { key: 'amt', label: 'Revenue', right: true, format: eurCell, tip: 'Paid payments + paid invoices (before VAT) in the period.' },
    { key: 'you', label: `→ ${YOU_LABEL}`, right: true, format: eurCell, tip: `${YOU_LABEL}'s part: 100% of their own, 50% of shared.` },
    { key: 'rita', label: `→ ${RITA_LABEL}`, right: true, format: eurCell, tip: `${RITA_LABEL}'s part: 100% of their own, 50% of shared.` }
  ], {
    name: 'Total', ownerLbl: '', n: rows.reduce((s, r) => s + r.n, 0),
    amt: data.total, you: data.revSplit.you, rita: data.revSplit.rita
  });
}

// One partner's revenue — each property/client and the share that counts.
function openPartnerRevenueDrill(data, partner, label) {
  const rows = groupByEntityOwner(data.revRecords, revEntity)
    .map(g => ({ ...g, ownerLbl: ownerName(g.owner), share: partnerShare(g.owner, partner) }))
    .filter(g => g.share > 0)
    .map(g => ({ ...g, part: g.amt * g.share }))
    .sort((a, b) => b.part - a.part);
  drillWithTotal(`${label} — Revenue`, rows, [
    { key: 'name', label: 'Property / Client' },
    { key: 'ownerLbl', label: 'Owner' },
    { key: 'n', label: 'Records', right: true },
    { key: 'amt', label: 'Full Revenue', right: true, format: eurCell },
    { key: 'share', label: '× Share', right: true, format: shareCell, tip: '100% for their own, 50% for shared.' },
    { key: 'part', label: `= ${label} Revenue`, right: true, format: eurCell }
  ], { name: 'Total', ownerLbl: '', n: rows.reduce((s, r) => s + r.n, 0), amt: rows.reduce((s, r) => s + r.amt, 0), share: '', part: data.revSplit[partner] });
}

// One partner's operating expenses — each property (or general category).
function openPartnerExpenseDrill(data, partner, label) {
  const rows = groupByEntityOwner(data.annotatedExpenses, expEntity)
    .map(g => ({ ...g, ownerLbl: ownerName(g.owner), share: partnerShare(g.owner, partner) }))
    .filter(g => g.share > 0)
    .map(g => ({ ...g, part: g.amt * g.share }))
    .sort((a, b) => b.part - a.part);
  drillWithTotal(`${label} — Operating Expenses`, rows, [
    { key: 'name', label: 'Property / Category' },
    { key: 'ownerLbl', label: 'Owner' },
    { key: 'n', label: 'Records', right: true },
    { key: 'amt', label: 'Full OpEx', right: true, format: eurCell, tip: 'Operating expenses in the period, CapEx excluded.' },
    { key: 'share', label: '× Share', right: true, format: shareCell, tip: '100% for their own, 50% for shared.' },
    { key: 'part', label: `= ${label} OpEx`, right: true, format: eurCell }
  ], { name: 'Total', ownerLbl: '', n: rows.reduce((s, r) => s + r.n, 0), amt: rows.reduce((s, r) => s + r.amt, 0), share: '', part: data.expSplit[partner] });
}

// One partner's net profit — their revenue minus their OpEx, per property/client.
function openPartnerNetDrill(data, partner, label) {
  const map = new Map();
  const get = name => { if (!map.has(name)) map.set(name, { name, rev: 0, exp: 0 }); return map.get(name); };
  for (const r of data.revRecords) { const s = partnerShare(r._resolvedOwner, partner); if (s) get(revEntity(r)).rev += r._eur * s; }
  for (const e of data.annotatedExpenses) { const s = partnerShare(e._resolvedOwner, partner); if (s) get(expEntity(e)).exp += e._eur * s; }
  const rows = [...map.values()].map(r => ({ ...r, net: r.rev - r.exp })).sort((a, b) => b.net - a.net);
  drillWithTotal(`${label} — Net Profit`, rows, [
    { key: 'name', label: 'Property / Client' },
    { key: 'rev', label: `${label} Revenue`, right: true, format: eurCell },
    { key: 'exp', label: `− ${label} OpEx`, right: true, format: eurCell },
    { key: 'net', label: '= Net Profit', right: true, format: eurCell }
  ], { name: 'Total', rev: data.revSplit[partner], exp: data.expSplit[partner], net: data.netSplit[partner] });
}

// A partner's share % — all revenue (the denominator), the part that counts
// for this partner, and how many points of the % each property/client adds.
function openPartnerShareDrill(data, partner, label) {
  const total = data.total;
  const rows = groupByEntityOwner(data.revRecords, revEntity).map(g => {
    const share = partnerShare(g.owner, partner);
    const part = g.amt * share;
    return { ...g, ownerLbl: ownerName(g.owner), share, part, contrib: total > 0 ? (part / total) * 100 : null };
  }).sort((a, b) => (b.contrib ?? 0) - (a.contrib ?? 0) || b.amt - a.amt);
  drillWithTotal(`${label} Share`, rows, [
    { key: 'name', label: 'Property / Client' },
    { key: 'ownerLbl', label: 'Owner' },
    { key: 'amt', label: 'Revenue', right: true, format: eurCell, tip: 'Full revenue — all of it counts toward the total the share is measured against.' },
    { key: 'share', label: '× Share', right: true, format: shareCell, tip: `${label}'s part of it: 100% own, 50% shared, 0% the other partner's.` },
    { key: 'part', label: `= ${label} Revenue`, right: true, format: eurCell },
    { key: 'contrib', label: 'Points of Share', right: true, format: ppCell, tip: `${label} revenue from this line ÷ total portfolio revenue. These add up to the card.` }
  ], { name: 'Total', ownerLbl: '', amt: total, share: '', part: data.revSplit[partner], contrib: total > 0 ? (data.revSplit[partner] / total) * 100 : null });
}

// ── Partner column card ───────────────────────────────────────────────────────
// Period figures only — each partner's property count and book value are on
// the Portfolio tab (Portfolio Summary), as of the end of the period.
function buildPartnerColumn(label, color, data, cmpData, curRange, cmpRange, isYou) {
  const rev    = isYou ? data.revSplit.you  : data.revSplit.rita;
  const exp    = isYou ? data.expSplit.you  : data.expSplit.rita;
  const net    = isYou ? data.netSplit.you  : data.netSplit.rita;
  const owner  = isYou ? 'you' : 'rita';
  const revRecords = data.revRecords;

  const col = el('div', {
    style: `background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:8px;padding:16px;border-top:3px solid ${color}`
  });

  // Partner header
  col.appendChild(el('div', {
    style: `font-size:14px;font-weight:700;color:${color};margin-bottom:12px;letter-spacing:0.03em`
  }, label));

  const rows = [
    { label: 'Revenue',
      value: mkDrillValue(formatEUR(rev), () =>
        drillDownModal(`${label} — Revenue`, toOwnerRevRows(revRecords, owner), OWNER_REV_COLS)),
      sub: null, onClick: () => openPartnerRevenueDrill(data, owner, label),
      explain: {
        title: `${label} Revenue`,
        formula: "Owner-split revenue: records owned by this partner count 100%, records with owner='both' count 50%.",
        inputs: [{ label: 'Revenue', value: formatEUR(rev) }],
        source: 'analytics-owner.js:44 splitByOwner()',
        note: "Owner is resolved per record (the record's own `owner` field, falling back to its linked property's `owner`, defaulting to 'both')."
      }
    },
    { label: 'Operating Expenses (excl. CapEx)',
      value: mkDrillValue(formatEUR(exp), () =>
        drillDownModal(`${label} — Operating Expenses`, toOwnerExpRows(data.annotatedExpenses, owner), OWNER_EXP_COLS)),
      sub: null, onClick: () => openPartnerExpenseDrill(data, owner, label),
      explain: {
        title: `${label} Operating Expenses`,
        formula: "Same owner-split rule as Revenue, applied to operating expenses (CapEx excluded).",
        inputs: [{ label: 'Operating Expenses', value: formatEUR(exp) }],
        source: 'analytics-owner.js:44 splitByOwner()',
        note: 'CapEx/renovation spend is excluded — see the isCapEx() filter in getData().'
      }
    },
    { label: 'Net Profit',
      value: mkDrillValue(formatEUR(net), () =>
        drillDownModal(`${label} — Net Profit`, toOwnerMixedRows(revRecords, data.annotatedExpenses, owner), OWNER_MIXED_COLS)),
      sub: null, netVal: net, onClick: () => openPartnerNetDrill(data, owner, label),
      explain: {
        title: `${label} Net Profit`,
        formula: 'Revenue (owner split) − Operating Expenses (owner split)',
        inputs: [
          { label: 'Revenue', value: formatEUR(rev) },
          { label: 'Operating Expenses', value: formatEUR(exp) }
        ],
        source: 'analytics-owner.js:126 getData() — `netSplit`'
      }
    },
  ];

  for (const row of rows) {
    const item = el('div', {
      style: 'display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px solid rgba(255,255,255,0.04)' +
             (row.onClick ? ';cursor:pointer' : '')
    });
    if (row.onClick) {
      item.title = 'Click for breakdown';
      item.addEventListener('mouseenter', () => { item.style.background = 'rgba(255,255,255,0.04)'; });
      item.addEventListener('mouseleave', () => { item.style.background = ''; });
      item.onclick = row.onClick;
    }
    const labelWrap = el('span', { style: 'display:flex;align-items:center;gap:4px;font-size:12px;color:var(--text-muted)' }, row.label);
    if (row.explain) labelWrap.appendChild(mkExplainButton(row.explain));
    item.appendChild(labelWrap);
    const valStyle = row.netVal !== undefined
      ? `font-size:13px;font-weight:600;color:${netColor(row.netVal)}`
      : 'font-size:13px;font-weight:600;color:var(--text)';
    item.appendChild(el('span', { style: valStyle }, row.value));
    col.appendChild(item);
  }

  return col;
}

// ── KPI section ───────────────────────────────────────────────────────────────
function buildKpiSection(data, cmpData, propsData, cmpRange) {
  const { total, revSplit, revRecords } = data;
  const youPct  = total > 0 ? revSplit.you  / total * 100 : 0;
  const ritaPct = total > 0 ? revSplit.rita / total * 100 : 0;
  const sharedCount = propsData.bothProps.length;

  const grid = el('div', {
    style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px;margin-bottom:20px'
  });

  // 1. Total Portfolio Revenue
  const cl = cmpRange?.label || '';
  grid.appendChild(mkKpiCard({
    label: 'Total Portfolio Revenue',
    value: mkDrillValue(formatEUR(total), () => drillDownModal('Total Portfolio Revenue', toOwnerRevRows(revRecords), OWNER_REV_COLS)),
    subtitle: 'All partners combined',
    delta: safePct(total, cmpData?.total),
    compLabel: cl,
    compValue: cmpData ? formatEUR(cmpData.total) : undefined,
    onClick: () => openTotalRevenueDrill(data),
    explain: {
      title: 'Total Portfolio Revenue',
      formula: `${YOU_LABEL} Revenue + ${RITA_LABEL} Revenue (owner-split totals)`,
      inputs: [
        { label: `${YOU_LABEL} Revenue`, value: formatEUR(revSplit.you) },
        { label: `${RITA_LABEL} Revenue`, value: formatEUR(revSplit.rita) }
      ],
      source: 'analytics-owner.js:117 getData() — `total: revSplit.you + revSplit.rita`',
      note: "Includes both rental payments and paid service invoices; owner='both' records are already split 50/50 inside revSplit before this total is formed."
    }
  }));

  // Compute comparison period share percentages for delta
  const cmpTotal   = cmpData ? (cmpData.revSplit.you + cmpData.revSplit.rita) : 0;
  const cmpYouPct  = cmpTotal > 0 ? cmpData.revSplit.you  / cmpTotal * 100 : null;
  const cmpRitaPct = cmpTotal > 0 ? cmpData.revSplit.rita / cmpTotal * 100 : null;

  // 2. Giorgos Share
  grid.appendChild(mkKpiCard({
    label: `${YOU_LABEL} Share`,
    value: youPct.toFixed(1) + '%',
    subtitle: formatEUR(revSplit.you),
    delta: safePct(youPct, cmpYouPct),
    deltaIsPp: true,
    compLabel: cl,
    compValue: cmpYouPct != null ? `${cmpYouPct.toFixed(1)}%` : undefined,
    onClick: () => openPartnerShareDrill(data, 'you', YOU_LABEL),
    explain: {
      title: `${YOU_LABEL} Share`,
      formula: `${YOU_LABEL} Revenue ÷ Total Portfolio Revenue × 100`,
      inputs: [
        { label: `${YOU_LABEL} Revenue`, value: formatEUR(revSplit.you) },
        { label: 'Total Portfolio Revenue', value: formatEUR(total) }
      ],
      source: 'analytics-owner.js:406 buildKpiSection() — `youPct`',
      note: "The underlying revenue split resolves each record's owner ('you'/'rita'/'both') via splitByOwner(); 'both' records count half toward each partner."
    }
  }));

  // 3. Rita Share
  grid.appendChild(mkKpiCard({
    label: `${RITA_LABEL} Share`,
    value: ritaPct.toFixed(1) + '%',
    subtitle: formatEUR(revSplit.rita),
    delta: safePct(ritaPct, cmpRitaPct),
    deltaIsPp: true,
    compLabel: cl,
    compValue: cmpRitaPct != null ? `${cmpRitaPct.toFixed(1)}%` : undefined,
    onClick: () => openPartnerShareDrill(data, 'rita', RITA_LABEL),
    explain: {
      title: `${RITA_LABEL} Share`,
      formula: `${RITA_LABEL} Revenue ÷ Total Portfolio Revenue × 100`,
      inputs: [
        { label: `${RITA_LABEL} Revenue`, value: formatEUR(revSplit.rita) },
        { label: 'Total Portfolio Revenue', value: formatEUR(total) }
      ],
      source: 'analytics-owner.js:407 buildKpiSection() — `ritaPct`',
      note: "The underlying revenue split resolves each record's owner ('you'/'rita'/'both') via splitByOwner(); 'both' records count half toward each partner."
    }
  }));

  // 4. Shared Properties
  grid.appendChild(mkKpiCard({
    label: 'Shared Properties',
    value: String(sharedCount),
    subtitle: 'owner = both',
    onClick: () => {
      const body = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });
      if (propsData.bothProps.length > 0) {
        // Compute period revenue per shared property
        const allRecords = revRecords;
        const sharedRevMap = new Map();
        for (const r of allRecords) {
          if (!r.propertyId) continue;
          const prop = propsData.bothProps.find(p => p.id === r.propertyId);
          if (!prop) continue;
          sharedRevMap.set(r.propertyId, (sharedRevMap.get(r.propertyId) || 0) + r._eur);
        }
        const sharedRevTotal = [...sharedRevMap.values()].reduce((s, v) => s + v, 0);

        const sharedRows = propsData.bothProps
          .map(p => ({ name: p.name, rev: sharedRevMap.get(p.id) || 0 }))
          .sort((a, b) => b.rev - a.rev)
          .map((r, i) => [`${i + 1}. ${r.name}`, formatEUR(r.rev), formatEUR(r.rev * 0.5), sharedRevTotal > 0 ? (r.rev / sharedRevTotal * 100).toFixed(1) + '%' : '—']);
        sharedRows.push([
          el('strong', {}, `Total — ${propsData.bothProps.length} shared propert${propsData.bothProps.length === 1 ? 'y' : 'ies'}`),
          el('strong', {}, formatEUR(sharedRevTotal)), el('strong', {}, formatEUR(sharedRevTotal * 0.5)),
          el('strong', {}, sharedRevTotal > 0 ? '100%' : '—')
        ]);

        body.appendChild(mkSectionLabel('Shared Properties — Period Revenue'));
        body.appendChild(mkModalTable(
          [
            { label: 'Property', tip: "Property with owner = 'both' (jointly owned)." },
            { label: 'Revenue', right: true, tip: "Total period revenue for this shared property, before the 50/50 partner split is applied." },
            { label: 'Each Partner (50%)', right: true, tip: 'What each partner gets from this property.' },
            { label: '% of Shared Total', right: true, tip: "This property's share of revenue among all shared properties." }
          ],
          sharedRows,
          { highlight: 1 }
        ));
      } else {
        body.appendChild(el('div', { style: 'font-size:13px;color:var(--text-muted)' }, 'No shared properties found.'));
      }
      openModal({ title: 'Shared Properties', body, large: true });
    }
  }));

  return grid;
}

// ── Partner comparison layout ─────────────────────────────────────────────────
function buildPartnerComparison(data, cmpData, curRange, cmpRange) {
  const section = el('div', { class: 'mb-16' });
  section.appendChild(mkSectionLabel('Partner Overview'));

  const grid = el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:16px' });
  grid.appendChild(buildPartnerColumn(YOU_LABEL, YOU_COLOR, data, cmpData, curRange, cmpRange, true));
  grid.appendChild(buildPartnerColumn(RITA_LABEL, RITA_COLOR, data, cmpData, curRange, cmpRange, false));
  section.appendChild(grid);
  return section;
}

// ── Service Revenue by Stream section ────────────────────────────────────────
function buildServiceStreamSection(annotatedInvoices, curRange) {
  const streamTotals = SERVICE_STREAMS.map(stream => {
    const invoices = annotatedInvoices.filter(i => i.stream === stream);
    const { you, rita } = splitByOwner(invoices, i => i._eur);
    return { stream, you, rita, total: you + rita, count: invoices.length, invoices };
  }).filter(r => r.total > 0);

  if (streamTotals.length === 0) return null;

  const grandYou   = streamTotals.reduce((s, r) => s + r.you,   0);
  const grandRita  = streamTotals.reduce((s, r) => s + r.rita,  0);
  const grandTotal = grandYou + grandRita;

  const section = el('div', { class: 'card mb-16' });
  section.appendChild(el('div', { class: 'card-header' },
    el('div', { class: 'card-title' }, `Service Revenue by Stream — ${curRange.label}`)
  ));

  const body = el('div', { style: 'padding:0 16px 16px' });

  const streamLabel = s => s.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  const rows = streamTotals.map(r => {
    const sLabel = streamLabel(r.stream);
    return [
      sLabel,
      mkDrillValue(formatEUR(r.you), () => drillDownModal(`${sLabel} — ${YOU_LABEL}`, toOwnerRevRows(r.invoices, 'you'), OWNER_REV_COLS)),
      mkDrillValue(formatEUR(r.rita), () => drillDownModal(`${sLabel} — ${RITA_LABEL}`, toOwnerRevRows(r.invoices, 'rita'), OWNER_REV_COLS)),
      mkDrillValue(formatEUR(r.total), () => drillDownModal(`${sLabel} — Total`, toOwnerRevRows(r.invoices), OWNER_REV_COLS))
    ];
  });
  const allStreamInvoices = streamTotals.flatMap(r => r.invoices);
  rows.push([
    'Total',
    mkDrillValue(formatEUR(grandYou), () => drillDownModal(`Service Revenue — ${YOU_LABEL}`, toOwnerRevRows(allStreamInvoices, 'you'), OWNER_REV_COLS)),
    mkDrillValue(formatEUR(grandRita), () => drillDownModal(`Service Revenue — ${RITA_LABEL}`, toOwnerRevRows(allStreamInvoices, 'rita'), OWNER_REV_COLS)),
    mkDrillValue(formatEUR(grandTotal), () => drillDownModal('Service Revenue — Total', toOwnerRevRows(allStreamInvoices), OWNER_REV_COLS))
  ]);

  body.appendChild(mkModalTable(
    [
      { label: 'Stream', tip: 'Service revenue stream (e.g. management, cleaning).' },
      { label: `${YOU_LABEL}`, right: true, tip: `${YOU_LABEL}'s owner-split share of paid invoices in this stream.` },
      { label: `${RITA_LABEL}`, right: true, tip: `${RITA_LABEL}'s owner-split share of paid invoices in this stream.` },
      { label: 'Total', right: true, tip: 'Combined paid invoice total for this stream.' }
    ],
    rows,
    { highlight: 3 }
  ));

  body.appendChild(el('div', { style: 'font-size:11px;color:var(--text-muted);margin-top:8px' },
    `Paid invoices only · ${curRange.label} · "both" owner = 50/50 split`
  ));

  section.appendChild(body);
  return section;
}

// ── Settlement section ────────────────────────────────────────────────────────
function buildSettlementBody(data) {
  const { revSplit, expSplit, netSplit, revRecords, annotatedExpenses } = data;
  const body = el('div', { style: 'padding:0 16px 16px' });

  // Summary grid
  const totRev = revSplit.you + revSplit.rita;
  const totExp = expSplit.you + expSplit.rita;
  const totNet = netSplit.you + netSplit.rita;

  const sgrid = el('div', { style: 'display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:20px' });
  sgrid.appendChild(mkSummaryBox('Total Revenue',
    mkDrillValue(formatEUR(totRev), () => drillDownModal('Total Revenue', toOwnerRevRows(revRecords), OWNER_REV_COLS)),
    null, {
    title: 'Total Revenue',
    formula: `${YOU_LABEL} Revenue + ${RITA_LABEL} Revenue (owner-split totals)`,
    inputs: [
      { label: `${YOU_LABEL} Revenue`, value: formatEUR(revSplit.you) },
      { label: `${RITA_LABEL} Revenue`, value: formatEUR(revSplit.rita) }
    ],
    source: 'analytics-owner.js:608 buildSettlementBody() — `totRev = revSplit.you + revSplit.rita`'
  }));
  sgrid.appendChild(mkSummaryBox('Total OpEx',
    mkDrillValue(formatEUR(totExp), () => drillDownModal('Total OpEx', toOwnerExpRows(annotatedExpenses), OWNER_EXP_COLS)),
    null, {
    title: 'Total OpEx',
    formula: `${YOU_LABEL} OpEx + ${RITA_LABEL} OpEx (owner-split totals, CapEx excluded)`,
    inputs: [
      { label: `${YOU_LABEL} OpEx`, value: formatEUR(expSplit.you) },
      { label: `${RITA_LABEL} OpEx`, value: formatEUR(expSplit.rita) }
    ],
    source: 'analytics-owner.js:609 buildSettlementBody() — `totExp = expSplit.you + expSplit.rita`'
  }));
  sgrid.appendChild(mkSummaryBox('Net Profit',
    mkDrillValue(formatEUR(totNet), () => drillDownModal('Net Profit', toOwnerMixedRows(revRecords, annotatedExpenses), OWNER_MIXED_COLS)),
    totNet >= 0 ? 'Portfolio profitable' : 'Portfolio at a loss', {
    title: 'Net Profit',
    formula: 'Total Revenue − Total OpEx',
    inputs: [
      { label: 'Total Revenue', value: formatEUR(totRev) },
      { label: 'Total OpEx', value: formatEUR(totExp) }
    ],
    source: 'analytics-owner.js:610 buildSettlementBody() — `totNet = netSplit.you + netSplit.rita`'
  }));
  body.appendChild(sgrid);

  // Per-partner expense attribution breakdown.
  // Shared expenses (owner='both') must be split 50/50 here, matching exactly
  // how expSplit/netSplit compute them via splitByOwner() — otherwise this
  // table's own "Total Expenses" row (below) is derived differently than the
  // "Net Profit" row right underneath it, and the two don't reconcile.
  let youDirectExp = 0, ritaDirectExp = 0, sharedExp = 0;
  for (const e of annotatedExpenses) {
    const owner = e._resolvedOwner;
    if (owner === 'you')       youDirectExp  += e._eur;
    else if (owner === 'rita') ritaDirectExp += e._eur;
    else                       sharedExp     += e._eur;
  }
  // 50/50, same as splitByOwner's 'both' handling — not proportional to
  // revenue share, so this reconciles with netSplit (revSplit − expSplit).
  const youSharedAlloc  = sharedExp * 0.5;
  const ritaSharedAlloc = sharedExp * 0.5;
  const youTotalExp  = youDirectExp  + youSharedAlloc;
  const ritaTotalExp = ritaDirectExp + ritaSharedAlloc;

  // Table rows: [label, Giorgos, Rita, Total]
  const rows = [
    ['Gross Revenue Share',       formatEUR(revSplit.you),  formatEUR(revSplit.rita),  formatEUR(totRev)],
    ['  Direct Expenses',         formatEUR(youDirectExp),  formatEUR(ritaDirectExp),  formatEUR(youDirectExp + ritaDirectExp)],
    ['  Shared Expenses (alloc)', formatEUR(youSharedAlloc),formatEUR(ritaSharedAlloc),formatEUR(sharedExp)],
    ['− Total Expenses',          formatEUR(youTotalExp),   formatEUR(ritaTotalExp),   formatEUR(totExp)],
    ['= Net Profit',              formatEUR(netSplit.you),  formatEUR(netSplit.rita),  formatEUR(totNet)],
  ];

  body.appendChild(mkSectionLabel('Per-Partner Net Distribution'));
  body.appendChild(mkModalTable(
    [
      { label: '', tip: 'Line item in the settlement calculation.' },
      { label: YOU_LABEL, right: true, tip: `${YOU_LABEL}'s amount for this line item.` },
      { label: RITA_LABEL, right: true, tip: `${RITA_LABEL}'s amount for this line item.` },
      { label: 'Total', right: true, tip: 'Combined amount across both partners for this line item.' }
    ],
    rows,
    { highlight: 3, firstColLeft: true }
  ));

  // Implied settlement
  const diff = netSplit.you - netSplit.rita;
  if (Math.abs(diff) > 0.01) {
    // Net profits here are ENTITLEMENTS (what each partner's ownership share
    // earned), not cash received — all cash lands in the shared/company
    // account. If that pooled net is taken out 50/50, the partner entitled to
    // more is short by half the difference, so the LOWER-net partner owes
    // the HIGHER-net partner |diff| ÷ 2 (after which each has exactly their
    // entitlement).
    const who  = diff > 0 ? RITA_LABEL : YOU_LABEL;
    const to   = diff > 0 ? YOU_LABEL  : RITA_LABEL;
    const amt  = Math.abs(diff) / 2;
    const note = el('div', {
      style: 'margin-top:16px;padding:10px 14px;border-radius:6px;background:rgba(99,102,241,0.06);border-left:3px solid var(--accent,#6366f1)'
    });
    const noteTitleRow = el('div', { style: 'display:flex;align-items:center;gap:4px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-muted);margin-bottom:4px' }, 'Implied Settlement');
    noteTitleRow.appendChild(mkExplainButton({
      title: 'Implied Settlement',
      formula: `|${YOU_LABEL} Net − ${RITA_LABEL} Net| ÷ 2, owed by the partner with the LOWER net profit to the partner with the HIGHER net profit — assuming the period’s pooled net profit is paid out 50/50, this gives each partner exactly their ownership-based net.`,
      inputs: [
        { label: `${YOU_LABEL} Net`, value: formatEUR(netSplit.you) },
        { label: `${RITA_LABEL} Net`, value: formatEUR(netSplit.rita) },
        { label: 'Difference', value: formatEUR(Math.abs(diff)) }
      ],
      source: 'analytics-owner.js:685 buildSettlementBody() — `diff`/`amt`',
      note: "The Net figures are entitlements from the per-record/per-property `owner` tag ('you' 100% · 'rita' 100% · 'both' 50/50), not cash each partner actually received — the data model doesn't record who withdrew what. The settlement assumes the pooled net profit is (or will be) paid out 50/50; if each partner has already been paid their own net, no settlement is due."
    }));
    note.appendChild(noteTitleRow);
    note.appendChild(el('div', { style: 'font-size:13px;color:var(--text)' },
      `If the period's net profit is paid out 50/50, ${who} owes ${to} ${formatEUR(amt)} so each partner ends with their ownership-based net.`
    ));
    note.appendChild(el('div', { style: 'font-size:11px;color:var(--text-muted);margin-top:4px' },
      `${YOU_LABEL} net: ${formatEUR(netSplit.you)} · ${RITA_LABEL} net: ${formatEUR(netSplit.rita)} · Difference: ${formatEUR(Math.abs(diff))}`
    ));
    body.appendChild(note);
  } else {
    body.appendChild(el('div', { style: 'margin-top:12px;font-size:13px;color:var(--text-muted)' },
      'Net profits are balanced — no settlement required this period.'
    ));
  }

  return body;
}

function buildSettlementSection(data, curRange) {
  const section = el('div', { class: 'card mb-16' });
  section.appendChild(el('div', { class: 'card-header' },
    el('div', { class: 'card-title' }, `Settlement Summary — ${curRange.label}`)
  ));
  section.appendChild(buildSettlementBody(data));
  return section;
}

// ── Charts ────────────────────────────────────────────────────────────────────

function renderRevBar(allRecords, months) {
  if (!months.length) return;

  const youData  = [];
  const ritaData = [];
  // Grouped once (same date expression as before) instead of re-filtering
  // every record for every month and again on each bar click.
  const byMonth = groupByMonthKey(allRecords, r => r.date || r.issueDate);

  for (const m of months) {
    const mk = m.key;
    const pays = byMonth.get(mk) || [];
    const split = splitByOwner(pays, r => r._eur);
    youData.push(Math.round(split.you));
    ritaData.push(Math.round(split.rita));
  }

  if (!youData.some(v => v > 0) && !ritaData.some(v => v > 0)) return;

  charts.bar('own-rev-bar', {
    labels: months.map(m => m.label),
    datasets: [
      { label: YOU_LABEL,  data: youData,  backgroundColor: YOU_HEX  },
      { label: RITA_LABEL, data: ritaData, backgroundColor: RITA_HEX }
    ],
    onClickItem: (_, idx) => {
      const mk = months[idx]?.key;
      if (!mk) return;
      const items = [...(byMonth.get(mk) || [])]; // copy — sorted in place below
      if (!items.length) { openModal({ title: `${months[idx].label} — No Data`, body: mkEmptyState('No revenue this month.') }); return; }

      const split = splitByOwner(items, r => r._eur);
      const body = el('div');
      body.appendChild(mkSummaryGrid([
        { label: YOU_LABEL,
          value: mkDrillValue(formatEUR(split.you), () => drillDownModal(`${YOU_LABEL} Revenue — ${months[idx].label}`, toOwnerRevRows(items, 'you'), OWNER_REV_COLS)),
          sub: `${items.filter(r => (r._resolvedOwner === 'you' || r._resolvedOwner === 'both')).length} records`,
          explain: {
            title: `${YOU_LABEL} Revenue — ${months[idx].label}`,
            formula: "Owner-split revenue for this month: 'you' records count 100%, 'both' records count 50%.",
            inputs: [{ label: `${YOU_LABEL} Revenue`, value: formatEUR(split.you) }],
            source: 'analytics-owner.js:44 splitByOwner()'
          }
        },
        { label: RITA_LABEL,
          value: mkDrillValue(formatEUR(split.rita), () => drillDownModal(`${RITA_LABEL} Revenue — ${months[idx].label}`, toOwnerRevRows(items, 'rita'), OWNER_REV_COLS)),
          sub: `${items.filter(r => (r._resolvedOwner === 'rita' || r._resolvedOwner === 'both')).length} records`,
          explain: {
            title: `${RITA_LABEL} Revenue — ${months[idx].label}`,
            formula: "Owner-split revenue for this month: 'rita' records count 100%, 'both' records count 50%.",
            inputs: [{ label: `${RITA_LABEL} Revenue`, value: formatEUR(split.rita) }],
            source: 'analytics-owner.js:44 splitByOwner()'
          }
        }
      ], 2));

      // Group by property/client so the breakdown shows where revenue came
      // from instead of one row per raw payment/invoice.
      const entityMap = new Map();
      for (const r of items) {
        const key  = r.propertyId ? `p:${r.propertyId}` : r.clientId ? `c:${r.clientId}` : 'other';
        const name = r.propertyId ? (byId('properties', r.propertyId)?.name || '—')
                   : r.clientId   ? (byId('clients',    r.clientId)?.name   || '—') : 'Other';
        const e = entityMap.get(key) || { name, you: 0, rita: 0 };
        const s = splitByOwner([r], rec => rec._eur);
        e.you  += s.you;
        e.rita += s.rita;
        entityMap.set(key, e);
      }
      const entityRows = [...entityMap.values()]
        .sort((a, b) => (b.you + b.rita) - (a.you + a.rita))
        .map(e => [e.name, formatEUR(e.you), formatEUR(e.rita), formatEUR(e.you + e.rita)]);
      if (entityMap.size > 1) entityRows.push([
        el('strong', {}, 'Total'), el('strong', {}, formatEUR(split.you)),
        el('strong', {}, formatEUR(split.rita)), el('strong', {}, formatEUR(split.you + split.rita))
      ]);

      body.appendChild(mkSectionLabel('By Property / Client'));
      body.appendChild(mkModalTable(
        [
          { label: 'Entity', tip: 'Property or client generating this revenue.' },
          { label: YOU_LABEL, right: true, tip: `${YOU_LABEL}'s owner-split share of this entity's revenue in the selected month.` },
          { label: RITA_LABEL, right: true, tip: `${RITA_LABEL}'s owner-split share of this entity's revenue in the selected month.` },
          { label: 'Total', right: true, tip: 'Combined revenue from this entity in the selected month.' }
        ],
        entityRows, { highlight: 3 }
      ));

      const footer = el('div', { style: 'margin-top:16px;padding-top:12px;border-top:1px solid rgba(255,255,255,0.08);display:flex;justify-content:space-between;align-items:center' });
      footer.appendChild(el('div', { style: 'font-size:12px;color:var(--text-muted)' }, `${items.length} record${items.length === 1 ? '' : 's'} in ${months[idx].label}`));
      const link = el('a', { style: 'font-size:12px;cursor:pointer;color:var(--accent)' }, 'View records →');
      link.onclick = () => {
        const rows = items
          .sort((a, b) => ((b.date || b.issueDate) || '').localeCompare((a.date || a.issueDate) || ''))
          .map(r => [
            r.date || r.issueDate || '—',
            r._resolvedOwner === 'you' ? YOU_LABEL : r._resolvedOwner === 'rita' ? RITA_LABEL : 'Shared',
            r.propertyId ? (byId('properties', r.propertyId)?.name || '—') : (r.clientId ? (byId('clients', r.clientId)?.name || '—') : '—'),
            formatEUR(r._eur)
          ]);
        const recBody = el('div');
        recBody.appendChild(mkModalTable(
          [
            { label: 'Date', tip: 'Payment or invoice date.' },
            { label: 'Owner', tip: `Resolved owner for this record — ${YOU_LABEL}, ${RITA_LABEL}, or Shared (owner='both').` },
            { label: 'Entity', tip: 'Property or client this record is linked to.' },
            { label: 'EUR', right: true, tip: 'Full record amount in EUR (not yet split between partners).' }
          ],
          rows, { highlight: 3 }
        ));
        openModal({ title: `${months[idx].label} — All Records`, body: recBody, large: true });
      };
      footer.appendChild(link);
      body.appendChild(footer);

      openModal({ title: `${months[idx].label} — Revenue Breakdown`, body, large: true });
    }
  });
}

// Every revenue/expense record lands in exactly one bar so the chart
// reconciles with the Settlement totals: its property; 'Services' for revenue
// with no property (service invoices); 'Unallocated / Company' for expenses
// with no property (company overheads) and for any record whose property no
// longer exists. Owner split uses each record's own _resolvedOwner via
// splitByOwner() — the same rule as the KPIs/Settlement.
const SVC_BUCKET = '__services__';
const UNALLOC_BUCKET = '__unallocated__';
const BUCKET_NAMES = { [SVC_BUCKET]: 'Services', [UNALLOC_BUCKET]: 'Unallocated / Company' };

function renderProfitHBar(revRecords, annotatedExpenses) {
  const allProps = listActive('properties');

  // Pre-build Map for O(1) property lookups instead of O(n) byId scans per record
  const propMap  = new Map(allProps.map(p => [p.id, p]));
  const revBucket = r => !r.propertyId ? SVC_BUCKET : propMap.has(r.propertyId) ? r.propertyId : UNALLOC_BUCKET;
  const expBucket = e => e.propertyId && propMap.has(e.propertyId) ? e.propertyId : UNALLOC_BUCKET;
  const propRevs = new Map();
  const propExps = new Map();

  for (const r of revRecords) {
    const key = revBucket(r);
    const e   = propRevs.get(key) || { name: BUCKET_NAMES[key] || propMap.get(key).name, youRev: 0, ritaRev: 0 };
    const sp  = splitByOwner([r], rec => rec._eur);
    e.youRev += sp.you; e.ritaRev += sp.rita;
    propRevs.set(key, e);
  }

  for (const x of annotatedExpenses) {
    const key   = expBucket(x);
    const entry = propExps.get(key) || { youExp: 0, ritaExp: 0 };
    const sp    = splitByOwner([x], rec => rec._eur);
    entry.youExp += sp.you; entry.ritaExp += sp.rita;
    propExps.set(key, entry);
  }

  const propIds = new Set([...propRevs.keys(), ...propExps.keys()]);
  if (!propIds.size) return;

  const items = [...propIds].map(id => {
    const rev = propRevs.get(id) || { name: BUCKET_NAMES[id] || propMap.get(id)?.name || 'Unknown', youRev: 0, ritaRev: 0 };
    const exp = propExps.get(id) || { youExp: 0, ritaExp: 0 };
    return {
      id,
      name:    rev.name,
      youNet:  rev.youRev  - exp.youExp,
      ritaNet: rev.ritaRev - exp.ritaExp,
      youRev:  rev.youRev,
      ritaRev: rev.ritaRev,
      youExp:  exp.youExp,
      ritaExp: exp.ritaExp,
    };
  }).sort((a, b) => (b.youNet + b.ritaNet) - (a.youNet + a.ritaNet));

  if (!items.length) return;

  charts.bar('own-profit-hbar', {
    labels:   items.map(x => x.name),
    datasets: [
      { label: YOU_LABEL,  data: items.map(x => Math.round(x.youNet)),  backgroundColor: YOU_HEX  },
      { label: RITA_LABEL, data: items.map(x => Math.round(x.ritaNet)), backgroundColor: RITA_HEX }
    ],
    horizontal: true,
    onClickItem: (_, idx) => {
      const item = items[idx];
      if (!item) return;

      const propRevRecords = revRecords.filter(r => revBucket(r) === item.id);
      const propExpRecords = annotatedExpenses.filter(e => expBucket(e) === item.id);

      const body = el('div');
      body.appendChild(mkSummaryGrid([
        { label: `Revenue — ${YOU_LABEL}`,
          value: mkDrillValue(formatEUR(item.youRev), () => drillDownModal(`${item.name} — Revenue (${YOU_LABEL})`, toOwnerRevRows(propRevRecords, 'you'), OWNER_REV_COLS)),
          sub: `OpEx: ${formatEUR(item.youExp)}`,
          explain: {
            title: `Revenue — ${YOU_LABEL}`,
            formula: "Owner-split revenue for this property: 'you' records count 100%, 'both' records count 50%.",
            inputs: [{ label: `Revenue — ${YOU_LABEL}`, value: formatEUR(item.youRev) }],
            source: 'analytics-owner.js:847 renderProfitHBar()'
          }
        },
        { label: `Revenue — ${RITA_LABEL}`,
          value: mkDrillValue(formatEUR(item.ritaRev), () => drillDownModal(`${item.name} — Revenue (${RITA_LABEL})`, toOwnerRevRows(propRevRecords, 'rita'), OWNER_REV_COLS)),
          sub: `OpEx: ${formatEUR(item.ritaExp)}`,
          explain: {
            title: `Revenue — ${RITA_LABEL}`,
            formula: "Owner-split revenue for this property: 'rita' records count 100%, 'both' records count 50%.",
            inputs: [{ label: `Revenue — ${RITA_LABEL}`, value: formatEUR(item.ritaRev) }],
            source: 'analytics-owner.js:847 renderProfitHBar()'
          }
        },
        { label: `Net Profit — ${YOU_LABEL}`,
          value: mkDrillValue(formatEUR(item.youNet), () => drillDownModal(`${item.name} — Net Profit (${YOU_LABEL})`, toOwnerMixedRows(propRevRecords, propExpRecords, 'you'), OWNER_MIXED_COLS)),
          sub: null,
          explain: {
            title: `Net Profit — ${YOU_LABEL}`,
            formula: `Revenue — ${YOU_LABEL} − OpEx — ${YOU_LABEL}`,
            inputs: [
              { label: `Revenue — ${YOU_LABEL}`, value: formatEUR(item.youRev) },
              { label: `OpEx — ${YOU_LABEL}`, value: formatEUR(item.youExp) }
            ],
            source: 'analytics-owner.js:903 renderProfitHBar() — `youNet: rev.youRev - exp.youExp`'
          }
        },
        { label: `Net Profit — ${RITA_LABEL}`,
          value: mkDrillValue(formatEUR(item.ritaNet), () => drillDownModal(`${item.name} — Net Profit (${RITA_LABEL})`, toOwnerMixedRows(propRevRecords, propExpRecords, 'rita'), OWNER_MIXED_COLS)),
          sub: null,
          explain: {
            title: `Net Profit — ${RITA_LABEL}`,
            formula: `Revenue — ${RITA_LABEL} − OpEx — ${RITA_LABEL}`,
            inputs: [
              { label: `Revenue — ${RITA_LABEL}`, value: formatEUR(item.ritaRev) },
              { label: `OpEx — ${RITA_LABEL}`, value: formatEUR(item.ritaExp) }
            ],
            source: 'analytics-owner.js:904 renderProfitHBar() — `ritaNet: rev.ritaRev - exp.ritaExp`'
          }
        },
      ], 2));

      const rows = [
        ['Revenue',  formatEUR(item.youRev),  formatEUR(item.ritaRev),  formatEUR(item.youRev + item.ritaRev)],
        ['OpEx',     formatEUR(item.youExp),  formatEUR(item.ritaExp),  formatEUR(item.youExp + item.ritaExp)],
        ['Net',      formatEUR(item.youNet),  formatEUR(item.ritaNet),  formatEUR(item.youNet + item.ritaNet)],
      ];
      body.appendChild(mkSectionLabel('Full P&L with Owner Attribution'));
      body.appendChild(mkModalTable(
        [
          { label: '', tip: 'Revenue, OpEx, or Net line item for this property.' },
          { label: YOU_LABEL, right: true, tip: `${YOU_LABEL}'s owner-split share for this property.` },
          { label: RITA_LABEL, right: true, tip: `${RITA_LABEL}'s owner-split share for this property.` },
          { label: 'Total', right: true, tip: 'Combined amount across both partners for this property.' }
        ],
        rows, { highlight: 3 }
      ));
      openModal({ title: `${item.name} — P&L by Owner`, body, large: true });
    }
  });
}

function openValueSplitModal(label, idx, propsData) {
  const isYou  = idx === 0;
  const ownedOwners = isYou ? ['you', 'both'] : ['rita', 'both'];
  const props  = propsData.allProps.filter(p => ownedOwners.includes(partnerKey(p.owner)));
  const items  = props.map(p => {
    const fullEur = toEUR(p.purchasePrice || 0, p.currency || 'EUR', p.purchaseDate || null);
    const shared  = partnerKey(p.owner) === 'both';
    return { name: p.name, shared, fullEur, share: shared ? fullEur * 0.5 : fullEur };
  }).sort((a, b) => b.share - a.share);
  const totalValue = isYou ? propsData.youValue : propsData.ritaValue;
  const rows = items.map(i => [i.name, i.shared ? 'Shared (50/50)' : label, formatEUR(i.fullEur), i.shared ? '50%' : '100%', formatEUR(i.share)]);
  if (items.length > 1) rows.push([
    el('strong', {}, 'Total'), '', el('strong', {}, formatEUR(items.reduce((s, i) => s + i.fullEur, 0))), '',
    el('strong', {}, formatEUR(totalValue))
  ]);

  const body = el('div');
  body.appendChild(mkSummaryGrid([
    { label: 'Total Book Value', value: formatEUR(totalValue),
      explain: {
        title: `${label} — Total Book Value`,
        formula: "Sum of purchase price (EUR) for properties owned by this partner; owner='both' properties contribute 50%.",
        inputs: [{ label: 'Total Book Value', value: formatEUR(totalValue) }],
        source: 'analytics-owner.js:153 getPropertiesData() — `youValue`/`ritaValue` (via `bookValue()`)',
        note: 'Based on purchasePrice only — does not net out mortgage balance or reflect current market value.'
      }
    },
    { label: 'Properties',       value: String(props.length) }
  ], 2));
  body.appendChild(mkSectionLabel('Properties'));
  body.appendChild(mkModalTable(
    [
      { label: 'Property', tip: 'Property name.' },
      { label: 'Owner', tip: "Who owns the property — 'Shared (50/50)' for jointly owned properties." },
      { label: 'Purchase Price', right: true, tip: 'Full purchase price, converted to EUR at the purchase date.' },
      { label: '× Share', right: true, tip: '100% for their own, 50% for shared.' },
      { label: 'Book Value (EUR)', right: true, tip: "This partner's share of the property's purchase price." }
    ],
    rows, { highlight: 4 }
  ));
  openModal({ title: `${label} — Book Value Breakdown`, body, large: true });
}

function renderValueDonut(propsData) {
  const { youValue, ritaValue } = propsData;
  if (!youValue && !ritaValue) return;

  charts.doughnut('own-value-donut', {
    labels: [YOU_LABEL, RITA_LABEL],
    data:   [Math.round(youValue), Math.round(ritaValue)],
    colors: [YOU_HEX, RITA_HEX],
    onClickItem: (label, idx) => openValueSplitModal(label, idx, propsData)
  });
}

// ── Rebuild ───────────────────────────────────────────────────────────────────
function rebuildView() {
  CHART_IDS.forEach(id => charts.destroy(id));
  const c = document.getElementById('content');
  if (!c) return;
  c.innerHTML = '';
  c.appendChild(buildView());
}

// ── Main view ─────────────────────────────────────────────────────────────────
function buildView() {
  YOU_LABEL  = getPersonName('you');
  RITA_LABEL = getPersonName('rita');

  const wrap = el('div', { class: 'view active' });

  // Header
  wrap.appendChild(el('div', { style: 'margin-bottom:16px' },
    el('h2', { style: 'margin:0 0 4px;font-size:20px;font-weight:700' }, 'Partners'),
    el('p',  { style: 'margin:0;font-size:13px;color:var(--text-muted)' }, 'Revenue · Expenses · P&L · Portfolio · Settlement')
  ));

  // Filter bar (no owner filter — whole dashboard IS the owner breakdown)
  wrap.appendChild(buildFilterBar(
    gF,
    { showOwner: false, showStream: true, showProperty: true, storagePrefix: 'ana_owner', channelScope: gScope === 'all' ? null : 'company' },
    (newGF) => { if (newGF) gF = newGF; rebuildView(); }
  ));

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
  const { keys: months } = getMonthKeysForRange(curRange.start, curRange.end);

  // Memoised (see memoView): a tab switch reuses these instead of
  // recomputing; any data edit, filter/scope change or new day recomputes.
  const { data, cmpData, propsData } = memoView('analytics-owner',
    { gF, gScope, curRange, cmpRange, YOU_LABEL, RITA_LABEL }, () => ({
      data:      getData(curRange.start, curRange.end),
      cmpData:   cmpRange ? getData(cmpRange.start, cmpRange.end) : null,
      propsData: getPropertiesData(gF, curRange.end && curRange.end < todayYmd() ? curRange.end : todayYmd())
    }));

  const compLine = buildComparisonLine(curRange, cmpRange);

  // ── Tabs ───────────────────────────────────────────────────────────────────
  // One tab is built per render (switching rebuilds the view), so each chart
  // canvas exists once.
  wrap.appendChild(mkDashboardTabs(OWN_TABS, gTab, id => { gTab = id; rebuildView(); }, OWN_TAB_KEY));
  const renders = [];

  if (gTab === 'overview') {
    if (compLine) wrap.appendChild(compLine);

    // KPI cards
    wrap.appendChild(buildKpiSection(data, cmpData, propsData, cmpRange));

    // Partner side-by-side columns
    wrap.appendChild(buildPartnerComparison(data, cmpData, curRange, cmpRange));

    // Settlement (what one partner owes the other this period)
    wrap.appendChild(buildSettlementSection(data, curRange));
  }

  if (gTab === 'breakdown') {
    // Revenue by Owner (monthly bar) + Profit by Property (horizontal bar)
    wrap.appendChild(el('div', { class: 'grid grid-2 mb-16' },
      el('div', { class: 'card' },
        el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'Revenue by Owner (Monthly)')),
        el('div', { class: 'chart-wrap tall' }, el('canvas', { id: 'own-rev-bar' }))
      ),
      el('div', { class: 'card' },
        el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'Profit by Property & Owner')),
        el('div', { class: 'chart-wrap tall' }, el('canvas', { id: 'own-profit-hbar' }))
      )
    ));

    // Service Revenue by Stream
    const svcStreamSection = buildServiceStreamSection(data.annotatedInvoices, curRange);
    if (svcStreamSection) wrap.appendChild(svcStreamSection);

    renders.push(() => renderRevBar(data.revRecords, months), () => renderProfitHBar(data.revRecords, data.annotatedExpenses));
  }

  if (gTab === 'portfolio') {
    // Portfolio Value donut + summary
    const portfolioRow = el('div', { class: 'grid grid-2 mb-16' });
    portfolioRow.appendChild(el('div', { class: 'card' },
      el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'Portfolio Value Split'),
        el('div', { style: 'font-size:12px;color:var(--text-muted)' }, `Book value held on ${fmtDate(propsData.asOf)}`)),
      el('div', { class: 'chart-wrap tall' }, el('canvas', { id: 'own-value-donut' }))
    ));

    // Portfolio summary card (plain info, no chart)
    {
      const infoCard = el('div', { class: 'card' });
      infoCard.appendChild(el('div', { class: 'card-header' },
        el('div', { class: 'card-title' }, 'Portfolio Summary'),
        el('div', { style: 'font-size:12px;color:var(--text-muted)' }, `Properties held on ${fmtDate(propsData.asOf)}`)
      ));
      const infoBody = el('div', { style: 'padding:0 16px 16px' });

      const totalProps = propsData.allProps.length;
      const pGrid = el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px' });
      pGrid.appendChild(mkSummaryBox(YOU_LABEL, `${propsData.youCount} propert${propsData.youCount !== 1 ? 'ies' : 'y'}`,
        mkDrillValue(formatEUR(propsData.youValue), () => openValueSplitModal(YOU_LABEL, 0, propsData)), {
        title: `${YOU_LABEL} Book Value`,
        formula: `Sum of purchase price (EUR) for properties fully owned by ${YOU_LABEL}, plus 50% of purchase price for jointly-owned ('both') properties.`,
        inputs: [
          { label: 'Book Value', value: formatEUR(propsData.youValue) },
          { label: 'Properties (incl. shared)', value: String(propsData.youCount) }
        ],
        source: 'analytics-owner.js:153 getPropertiesData() — `youValue`',
        note: 'A shared property is counted in both youCount and ritaCount, and its value split 50/50 between both — it is not double-counted in the portfolio total.'
      }));
      pGrid.appendChild(mkSummaryBox(RITA_LABEL, `${propsData.ritaCount} propert${propsData.ritaCount !== 1 ? 'ies' : 'y'}`,
        mkDrillValue(formatEUR(propsData.ritaValue), () => openValueSplitModal(RITA_LABEL, 1, propsData)), {
        title: `${RITA_LABEL} Book Value`,
        formula: `Sum of purchase price (EUR) for properties fully owned by ${RITA_LABEL}, plus 50% of purchase price for jointly-owned ('both') properties.`,
        inputs: [
          { label: 'Book Value', value: formatEUR(propsData.ritaValue) },
          { label: 'Properties (incl. shared)', value: String(propsData.ritaCount) }
        ],
        source: 'analytics-owner.js:154 getPropertiesData() — `ritaValue`',
        note: 'A shared property is counted in both youCount and ritaCount, and its value split 50/50 between both — it is not double-counted in the portfolio total.'
      }));
      infoBody.appendChild(pGrid);

      if (propsData.bothProps.length > 0) {
        infoBody.appendChild(mkSectionLabel('Shared Properties (50/50)'));
        const rows = propsData.bothProps.map(p => {
          const eur = toEUR(p.purchasePrice || 0, p.currency || 'EUR', p.purchaseDate || null);
          return [p.name, formatEUR(eur), formatEUR(eur * 0.5)];
        });
        infoBody.appendChild(mkModalTable(
          [
            { label: 'Property', tip: "Jointly-owned (owner='both') property." },
            { label: 'Total Value', right: true, tip: "Full purchase price of the property, converted to EUR." },
            { label: 'Per Partner', right: true, tip: "Each partner's 50% share of the property's purchase price." }
          ],
          rows, { highlight: 2 }
        ));
      } else {
        infoBody.appendChild(el('div', { style: 'font-size:13px;color:var(--text-muted)' }, `${totalProps} total propert${totalProps !== 1 ? 'ies' : 'y'} · no shared properties`));
      }

      infoCard.appendChild(infoBody);
      portfolioRow.appendChild(infoCard);
    }

    wrap.appendChild(portfolioRow);
    renders.push(() => renderValueDonut(propsData));
  }

  // Render charts after DOM is ready
  setTimeout(() => renders.forEach(fn => fn()), 0);

  return wrap;
}
