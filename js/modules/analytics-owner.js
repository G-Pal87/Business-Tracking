// Owner/Partner Analytics Dashboard — partner P&L, settlement, portfolio split
import { el, openModal, fmtDate, drillDownModal } from '../core/ui.js';
import * as charts from '../core/charts.js';
import { formatEUR, toEUR, byId, listActive, listActivePayments, isCapEx, getPersonName, companyPropIds, isCompanyRecord } from '../core/data.js';
import {
  createFilterState, buildFilterBar, buildComparisonLine,
  getCurrentPeriodRange, getComparisonRange, getMonthKeysForRange, makeMatchers
} from './analytics-filters.js?v=20260519';
import {
  mkSectionLabel, mkSummaryBox, mkSummaryGrid, mkModalTable, mkVarianceBadge, mkEmptyState, mkKpiCard, mkCmpGrid, safePct, mkExplainButton, mkDrillValue
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
    const owner  = rec._resolvedOwner || rec.owner || 'both';
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

  // Build Map once so annotation loops use O(1) lookups instead of O(n) byId scans
  const propMap = new Map(listActive('properties').map(p => [p.id, p]));

  const coPropIds = companyPropIds();
  const isCoRec = r => gScope === 'all' || isCompanyRecord(r, coPropIds);

  // Payments — rental income (no owner filter, we split manually)
  const payments = listActivePayments().filter(p =>
    p.status === 'paid' && inRange(p.date) && mStream(p) && mProperty(p) && isCoRec(p)
  );

  // Annotate payments with resolved owner
  const annotatedPayments = payments.map(p => {
    const prop = p.propertyId ? propMap.get(p.propertyId) : null;
    return { ...p, _resolvedOwner: p.owner || prop?.owner || 'both', _eur: toEUR(p.amount, p.currency, p.date) };
  });

  // Invoices — service income. mProperty is applied for consistency with the
  // payments/expenses filters just above — a property-linked invoice used to
  // count toward revenue/splits regardless of which property was selected.
  const invoices = listActive('invoices').filter(i =>
    i.status === 'paid' && inRange(i.issueDate) && mStream(i) && mProperty(i)
  );
  const annotatedInvoices = invoices.map(i => {
    const prop = i.propertyId ? propMap.get(i.propertyId) : null;
    return {
      ...i,
      _resolvedOwner: i.owner || prop?.owner || 'both',
      // VAT-exclusive: this is a revenue/profit split, not a cash figure — VAT collected isn't the owners' revenue.
      _eur: toEUR(i.subtotal ?? i.total, i.currency, i.issueDate)
    };
  });

  // Expenses (OpEx only for profit)
  const expenses = listActive('expenses').filter(e => {
    const d = e.date || '';
    return d >= start && d <= end && !isCapEx(e) && mProperty(e) && mStream(e) && isCoRec(e);
  });
  const annotatedExpenses = expenses.map(e => {
    const prop = e.propertyId ? propMap.get(e.propertyId) : null;
    return { ...e, _resolvedOwner: prop?.owner || e.owner || 'both', _eur: toEUR(e.amount, e.currency, e.date) };
  });

  // Revenue split
  const revSplit = splitByOwner(
    [...annotatedPayments, ...annotatedInvoices],
    r => r._eur
  );
  // Expense split
  const expSplit = splitByOwner(annotatedExpenses, r => r._eur);

  const total = revSplit.you + revSplit.rita;

  return {
    annotatedPayments,
    annotatedInvoices,
    annotatedExpenses,
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
function getPropertiesData(filterState) {
  const mPropStream = p => !filterState.streams.size || filterState.streams.has(propStream(p));
  const mPropId     = p => !filterState.propertyIds.size || filterState.propertyIds.has(p.id);
  const allProps = listActive('properties').filter(p => mPropStream(p) && mPropId(p));
  const youProps  = allProps.filter(p => p.owner === 'you');
  const ritaProps = allProps.filter(p => p.owner === 'rita');
  const bothProps = allProps.filter(p => !p.owner || p.owner === 'both');

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
    youValue, ritaValue, totalValue
  };
}

// ── Shared KPI modal body builder (Giorgos / Rita — avoids duplication) ──────
function buildShareKpiModal(owner, partnerLabel, revenue, pct, allRecords, cmpData, cmpRange) {
  const filtered = allRecords
    .filter(r => r._resolvedOwner === owner || r._resolvedOwner === 'both')
    .map(r => ({ ...r, _shareEur: r._resolvedOwner === 'both' ? r._eur * 0.5 : r._eur }))
    .sort((a, b) => b._shareEur - a._shareEur);
  const total = filtered.length;
  const relevant = filtered.slice(0, 5);
  const toRow = r => {
    const date   = r.date || r.issueDate || '—';
    const entity = r.propertyId ? (byId('properties', r.propertyId)?.name || '—')
                 : r.clientId   ? (byId('clients',    r.clientId)?.name   || '—') : '—';
    return [date, entity, r._resolvedOwner === 'both' ? 'Shared (50%)' : partnerLabel, formatEUR(r._shareEur)];
  };
  const cl = cmpRange?.label || '';

  const body = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });
  if (cmpData) {
    const cmpRecords = [...cmpData.annotatedPayments, ...cmpData.annotatedInvoices];
    const cmpRevenue = cmpData.revSplit[owner];
    const cmpTotal   = cmpData.revSplit.you + cmpData.revSplit.rita;
    const cmpPct     = cmpTotal > 0 ? cmpRevenue / cmpTotal * 100 : 0;
    body.appendChild(mkCmpGrid([
      { label: `${partnerLabel} Revenue`,
        curVal: mkDrillValue(formatEUR(revenue), () => drillDownModal(`${partnerLabel} Revenue`, toOwnerRevRows(allRecords, owner), OWNER_REV_COLS)),
        cmpVal: mkDrillValue(formatEUR(cmpRevenue), () => drillDownModal(`${partnerLabel} Revenue — ${cl}`, toOwnerRevRows(cmpRecords, owner), OWNER_REV_COLS)) },
      { label: '% of Portfolio',
        curVal: pct.toFixed(1) + '%',
        cmpVal: cmpPct.toFixed(1) + '%' },
    ], 'Current Period', cl));
  } else {
    body.appendChild(mkSummaryGrid([
      { label: `${partnerLabel} Revenue`, value: formatEUR(revenue),
        explain: {
          title: `${partnerLabel} Revenue`,
          formula: "Owner-split revenue: records whose owner matches this partner count 100%, records with owner='both' count 50%.",
          inputs: [{ label: `${partnerLabel} Revenue`, value: formatEUR(revenue) }],
          source: 'analytics-owner.js:44 splitByOwner()',
          note: 'Computed once in getData() and reused by the KPI card, Partner column and this modal so the figure always matches everywhere it appears.'
        }
      },
      { label: '% of Portfolio',          value: pct.toFixed(1) + '%',
        explain: {
          title: '% of Portfolio',
          formula: `${partnerLabel} Revenue ÷ Total Portfolio Revenue × 100`,
          inputs: [
            { label: `${partnerLabel} Revenue`, value: formatEUR(revenue) },
            { label: '% of Portfolio', value: pct.toFixed(1) + '%' }
          ],
          source: 'analytics-owner.js:406 buildKpiSection() — `youPct`/`ritaPct`'
        }
      }
    ], 2));
  }
  if (relevant.length > 0) {
    body.appendChild(mkSectionLabel(
      relevant.length < total ? `Top ${relevant.length} of ${total} Records by Amount` : `All ${total} Records by Amount`
    ));
    body.appendChild(mkModalTable(
      [
        { label: 'Date', tip: 'Payment or invoice date.' },
        { label: 'Entity', tip: 'The property or client this record is linked to.' },
        { label: 'Attribution', tip: "Which partner this record's amount was attributed to — 'Shared (50%)' means owner='both' and the amount was split evenly." },
        { label: 'EUR', right: true, tip: "This record's amount in EUR, already reduced to this partner's share." }
      ],
      relevant.map(toRow),
      { highlight: 3 }
    ));
    if (relevant.length < total) {
      const link = el('a', { style: 'font-size:12px;cursor:pointer;color:var(--accent)' }, `View all ${total} records →`);
      link.onclick = () => {
        const allBody = el('div');
        allBody.appendChild(mkModalTable(
          [
            { label: 'Date', tip: 'Payment or invoice date.' },
            { label: 'Entity', tip: 'The property or client this record is linked to.' },
            { label: 'Attribution', tip: "Which partner this record's amount was attributed to — 'Shared (50%)' means owner='both' and the amount was split evenly." },
            { label: 'EUR', right: true, tip: "This record's amount in EUR, already reduced to this partner's share." }
          ],
          filtered.map(toRow),
          { highlight: 3 }
        ));
        openModal({ title: `${partnerLabel} — All Records`, body: allBody, large: true });
      };
      body.appendChild(link);
    }
  }
  return body;
}

// ── Shared drill-down modal openers (reused by KPI cards, charts, and the
//    partner columns so identical numbers always open identical modals) ──────
function openRevenueSplitModal(data, cmpData, cmpRange) {
  const { total, revSplit, annotatedPayments, annotatedInvoices } = data;
  const revRecords = [...annotatedPayments, ...annotatedInvoices];
  const youPct  = total > 0 ? revSplit.you  / total * 100 : 0;
  const ritaPct = total > 0 ? revSplit.rita / total * 100 : 0;
  const cl = cmpRange?.label || '';

  const body = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });
  if (cmpData) {
    const cmpRevRecords = [...cmpData.annotatedPayments, ...cmpData.annotatedInvoices];
    const cmpYou  = cmpData.revSplit.you;
    const cmpRita = cmpData.revSplit.rita;
    body.appendChild(mkCmpGrid([
      { label: YOU_LABEL,
        curVal: mkDrillValue(formatEUR(revSplit.you), () => drillDownModal(`${YOU_LABEL} Revenue`, toOwnerRevRows(revRecords, 'you'), OWNER_REV_COLS)),
        cmpVal: mkDrillValue(formatEUR(cmpYou), () => drillDownModal(`${YOU_LABEL} Revenue — ${cl}`, toOwnerRevRows(cmpRevRecords, 'you'), OWNER_REV_COLS)) },
      { label: RITA_LABEL,
        curVal: mkDrillValue(formatEUR(revSplit.rita), () => drillDownModal(`${RITA_LABEL} Revenue`, toOwnerRevRows(revRecords, 'rita'), OWNER_REV_COLS)),
        cmpVal: mkDrillValue(formatEUR(cmpRita), () => drillDownModal(`${RITA_LABEL} Revenue — ${cl}`, toOwnerRevRows(cmpRevRecords, 'rita'), OWNER_REV_COLS)) },
      { label: 'Total',
        curVal: mkDrillValue(formatEUR(total), () => drillDownModal('Total Revenue', toOwnerRevRows(revRecords), OWNER_REV_COLS)),
        cmpVal: mkDrillValue(formatEUR(cmpData.total), () => drillDownModal(`Total Revenue — ${cl}`, toOwnerRevRows(cmpRevRecords), OWNER_REV_COLS)) },
    ], 'Current Period', cl));
  } else {
    body.appendChild(mkSummaryGrid([
      { label: YOU_LABEL,
        value: mkDrillValue(formatEUR(revSplit.you), () => drillDownModal(`${YOU_LABEL} Revenue`, toOwnerRevRows(revRecords, 'you'), OWNER_REV_COLS)),
        sub: youPct.toFixed(1) + '%',
        explain: {
          title: `${YOU_LABEL} Revenue`,
          formula: "Owner-split revenue: 'you' records count 100%, 'both' records count 50%.",
          inputs: [
            { label: `${YOU_LABEL} Revenue`, value: formatEUR(revSplit.you) },
            { label: '% of Total', value: youPct.toFixed(1) + '%' }
          ],
          source: 'analytics-owner.js:44 splitByOwner()'
        }
      },
      { label: RITA_LABEL,
        value: mkDrillValue(formatEUR(revSplit.rita), () => drillDownModal(`${RITA_LABEL} Revenue`, toOwnerRevRows(revRecords, 'rita'), OWNER_REV_COLS)),
        sub: ritaPct.toFixed(1) + '%',
        explain: {
          title: `${RITA_LABEL} Revenue`,
          formula: "Owner-split revenue: 'rita' records count 100%, 'both' records count 50%.",
          inputs: [
            { label: `${RITA_LABEL} Revenue`, value: formatEUR(revSplit.rita) },
            { label: '% of Total', value: ritaPct.toFixed(1) + '%' }
          ],
          source: 'analytics-owner.js:44 splitByOwner()'
        }
      },
      { label: 'Total',
        value: mkDrillValue(formatEUR(total), () => drillDownModal('Total Revenue', toOwnerRevRows(revRecords), OWNER_REV_COLS)),
        explain: {
          title: 'Total Portfolio Revenue',
          formula: `${YOU_LABEL} Revenue + ${RITA_LABEL} Revenue`,
          inputs: [
            { label: `${YOU_LABEL} Revenue`, value: formatEUR(revSplit.you) },
            { label: `${RITA_LABEL} Revenue`, value: formatEUR(revSplit.rita) }
          ],
          source: 'analytics-owner.js:117 getData() — `total: revSplit.you + revSplit.rita`'
        }
      }
    ], 3));
  }
  body.appendChild(mkSectionLabel('Revenue Split'));
  body.appendChild(mkModalTable(
    [
      { label: 'Partner', tip: 'Giorgos, Rita, or the combined Total row.' },
      { label: 'Revenue', right: true, tip: "This partner's owner-split share of total portfolio revenue for the period." },
      { label: '% of Total', right: true, tip: "This partner's revenue as a percentage of total portfolio revenue." }
    ],
    [
      [YOU_LABEL,  formatEUR(revSplit.you),  youPct.toFixed(1)  + '%'],
      [RITA_LABEL, formatEUR(revSplit.rita), ritaPct.toFixed(1) + '%'],
      ['Total',    formatEUR(total),          '100%']
    ],
    { highlight: 1 }
  ));
  openModal({ title: 'Total Portfolio Revenue — Breakdown', body, large: true });
}

function openExpenseSplitModal(data, cmpData, cmpRange) {
  const { expSplit, annotatedExpenses } = data;
  const totalExp = expSplit.you + expSplit.rita;
  const youPct  = totalExp > 0 ? expSplit.you  / totalExp * 100 : 0;
  const ritaPct = totalExp > 0 ? expSplit.rita / totalExp * 100 : 0;
  const cl = cmpRange?.label || '';

  const body = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });
  if (cmpData) {
    const cmpTotalExp = cmpData.expSplit.you + cmpData.expSplit.rita;
    body.appendChild(mkCmpGrid([
      { label: YOU_LABEL,
        curVal: mkDrillValue(formatEUR(expSplit.you), () => drillDownModal(`${YOU_LABEL} Operating Expenses`, toOwnerExpRows(annotatedExpenses, 'you'), OWNER_EXP_COLS)),
        cmpVal: mkDrillValue(formatEUR(cmpData.expSplit.you), () => drillDownModal(`${YOU_LABEL} Operating Expenses — ${cl}`, toOwnerExpRows(cmpData.annotatedExpenses, 'you'), OWNER_EXP_COLS)) },
      { label: RITA_LABEL,
        curVal: mkDrillValue(formatEUR(expSplit.rita), () => drillDownModal(`${RITA_LABEL} Operating Expenses`, toOwnerExpRows(annotatedExpenses, 'rita'), OWNER_EXP_COLS)),
        cmpVal: mkDrillValue(formatEUR(cmpData.expSplit.rita), () => drillDownModal(`${RITA_LABEL} Operating Expenses — ${cl}`, toOwnerExpRows(cmpData.annotatedExpenses, 'rita'), OWNER_EXP_COLS)) },
      { label: 'Total',
        curVal: mkDrillValue(formatEUR(totalExp), () => drillDownModal('Total Operating Expenses', toOwnerExpRows(annotatedExpenses), OWNER_EXP_COLS)),
        cmpVal: mkDrillValue(formatEUR(cmpTotalExp), () => drillDownModal(`Total Operating Expenses — ${cl}`, toOwnerExpRows(cmpData.annotatedExpenses), OWNER_EXP_COLS)) },
    ], 'Current Period', cl));
  } else {
    body.appendChild(mkSummaryGrid([
      { label: YOU_LABEL,
        value: mkDrillValue(formatEUR(expSplit.you), () => drillDownModal(`${YOU_LABEL} Operating Expenses`, toOwnerExpRows(annotatedExpenses, 'you'), OWNER_EXP_COLS)),
        sub: youPct.toFixed(1) + '%',
        explain: {
          title: `${YOU_LABEL} Operating Expenses`,
          formula: "Owner-split expenses: 'you' records count 100%, 'both' records count 50%.",
          inputs: [
            { label: `${YOU_LABEL} Operating Expenses`, value: formatEUR(expSplit.you) },
            { label: '% of Total', value: youPct.toFixed(1) + '%' }
          ],
          source: 'analytics-owner.js:44 splitByOwner()'
        }
      },
      { label: RITA_LABEL,
        value: mkDrillValue(formatEUR(expSplit.rita), () => drillDownModal(`${RITA_LABEL} Operating Expenses`, toOwnerExpRows(annotatedExpenses, 'rita'), OWNER_EXP_COLS)),
        sub: ritaPct.toFixed(1) + '%',
        explain: {
          title: `${RITA_LABEL} Operating Expenses`,
          formula: "Owner-split expenses: 'rita' records count 100%, 'both' records count 50%.",
          inputs: [
            { label: `${RITA_LABEL} Operating Expenses`, value: formatEUR(expSplit.rita) },
            { label: '% of Total', value: ritaPct.toFixed(1) + '%' }
          ],
          source: 'analytics-owner.js:44 splitByOwner()'
        }
      },
      { label: 'Total',
        value: mkDrillValue(formatEUR(totalExp), () => drillDownModal('Total Operating Expenses', toOwnerExpRows(annotatedExpenses), OWNER_EXP_COLS)),
        explain: {
          title: 'Total Operating Expenses',
          formula: `${YOU_LABEL} Operating Expenses + ${RITA_LABEL} Operating Expenses`,
          inputs: [
            { label: `${YOU_LABEL} Operating Expenses`, value: formatEUR(expSplit.you) },
            { label: `${RITA_LABEL} Operating Expenses`, value: formatEUR(expSplit.rita) }
          ],
          source: 'analytics-owner.js:115 getData() — `expSplit`'
        }
      }
    ], 3));
  }
  body.appendChild(mkSectionLabel('Operating Expenses Split'));
  body.appendChild(mkModalTable(
    [
      { label: 'Partner', tip: 'Giorgos, Rita, or the combined Total row.' },
      { label: 'Operating Expenses', right: true, tip: "This partner's owner-split share of total operating expenses for the period." },
      { label: '% of Total', right: true, tip: "This partner's operating expenses as a percentage of total operating expenses." }
    ],
    [
      [YOU_LABEL,  formatEUR(expSplit.you),  youPct.toFixed(1)  + '%'],
      [RITA_LABEL, formatEUR(expSplit.rita), ritaPct.toFixed(1) + '%'],
      ['Total',    formatEUR(totalExp),      '100%']
    ],
    { highlight: 1 }
  ));
  openModal({ title: 'Total Operating Expenses — Breakdown', body, large: true });
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

// ── Partner column card ───────────────────────────────────────────────────────
function buildPartnerColumn(label, color, data, cmpData, propsData, curRange, cmpRange, isYou) {
  const rev    = isYou ? data.revSplit.you  : data.revSplit.rita;
  const exp    = isYou ? data.expSplit.you  : data.expSplit.rita;
  const net    = isYou ? data.netSplit.you  : data.netSplit.rita;
  const count  = isYou ? propsData.youCount : propsData.ritaCount;
  const value  = isYou ? propsData.youValue : propsData.ritaValue;
  const owner  = isYou ? 'you' : 'rita';
  const revRecords = [...data.annotatedPayments, ...data.annotatedInvoices];

  const col = el('div', {
    style: `background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:8px;padding:16px;border-top:3px solid ${color}`
  });

  // Partner header
  col.appendChild(el('div', {
    style: `font-size:14px;font-weight:700;color:${color};margin-bottom:12px;letter-spacing:0.03em`
  }, label));

  const rows = [
    { label: 'Revenue',
      value: mkDrillValue(formatEUR(rev), () => openRevenueSplitModal(data, cmpData, cmpRange)),
      sub: null, onClick: () => openRevenueSplitModal(data, cmpData, cmpRange),
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
      sub: null, onClick: () => openExpenseSplitModal(data, cmpData, cmpRange),
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
      sub: null, netVal: net, onClick: () => openSettlementModal(data, cmpData, curRange, cmpRange),
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
    { label: 'Portfolio Properties',
      value: mkDrillValue(String(count), () => openValueSplitModal(label, isYou ? 0 : 1, propsData)),
      sub: null
    },
    { label: 'Portfolio Book Value',
      value: mkDrillValue(formatEUR(value), () => openValueSplitModal(label, isYou ? 0 : 1, propsData)),
      sub: null, onClick: () => openValueSplitModal(label, isYou ? 0 : 1, propsData),
      explain: {
        title: `${label} Portfolio Book Value`,
        formula: "Sum of each owned property's purchase price (converted to EUR); properties with owner='both' contribute 50% to each partner.",
        inputs: [{ label: 'Book Value', value: formatEUR(value) }],
        source: 'analytics-owner.js:146 getPropertiesData() — `bookValue()`',
        note: 'Based on purchasePrice only — does not net out mortgage balance or reflect current market value.'
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
  const { total, revSplit, annotatedPayments, annotatedInvoices } = data;
  const revRecords = [...annotatedPayments, ...annotatedInvoices];
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
    onClick: () => openRevenueSplitModal(data, cmpData, cmpRange),
    explain: {
      title: 'Total Portfolio Revenue',
      formula: 'Giorgos Revenue + Rita Revenue (owner-split totals)',
      inputs: [
        { label: 'Giorgos Revenue', value: formatEUR(revSplit.you) },
        { label: 'Rita Revenue', value: formatEUR(revSplit.rita) }
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
    label: 'Giorgos Share',
    value: youPct.toFixed(1) + '%',
    subtitle: formatEUR(revSplit.you),
    delta: safePct(youPct, cmpYouPct),
    deltaIsPp: true,
    compLabel: cl,
    compValue: cmpYouPct != null ? `${cmpYouPct.toFixed(1)}%` : undefined,
    onClick: () => {
      const body = buildShareKpiModal('you', 'Giorgos', revSplit.you, youPct, [...annotatedPayments, ...annotatedInvoices], cmpData, cmpRange);
      openModal({ title: 'Giorgos Share — Detail', body, large: true });
    },
    explain: {
      title: 'Giorgos Share',
      formula: 'Giorgos Revenue ÷ Total Portfolio Revenue × 100',
      inputs: [
        { label: 'Giorgos Revenue', value: formatEUR(revSplit.you) },
        { label: 'Total Portfolio Revenue', value: formatEUR(total) }
      ],
      source: 'analytics-owner.js:406 buildKpiSection() — `youPct`',
      note: "The underlying revenue split resolves each record's owner ('you'/'rita'/'both') via splitByOwner(); 'both' records count half toward each partner."
    }
  }));

  // 3. Rita Share
  grid.appendChild(mkKpiCard({
    label: 'Rita Share',
    value: ritaPct.toFixed(1) + '%',
    subtitle: formatEUR(revSplit.rita),
    delta: safePct(ritaPct, cmpRitaPct),
    deltaIsPp: true,
    compLabel: cl,
    compValue: cmpRitaPct != null ? `${cmpRitaPct.toFixed(1)}%` : undefined,
    onClick: () => {
      const body = buildShareKpiModal('rita', 'Rita', revSplit.rita, ritaPct, [...annotatedPayments, ...annotatedInvoices], cmpData, cmpRange);
      openModal({ title: 'Rita Share — Detail', body, large: true });
    },
    explain: {
      title: 'Rita Share',
      formula: 'Rita Revenue ÷ Total Portfolio Revenue × 100',
      inputs: [
        { label: 'Rita Revenue', value: formatEUR(revSplit.rita) },
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
        const allRecords = [...annotatedPayments, ...annotatedInvoices];
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
          .map(r => [r.name, formatEUR(r.rev), sharedRevTotal > 0 ? (r.rev / sharedRevTotal * 100).toFixed(1) + '%' : '—']);

        body.appendChild(mkSectionLabel('Shared Properties — Period Revenue'));
        body.appendChild(mkModalTable(
          [
            { label: 'Property', tip: "Property with owner = 'both' (jointly owned)." },
            { label: 'Revenue', right: true, tip: "Total period revenue for this shared property, before the 50/50 partner split is applied." },
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
function buildPartnerComparison(data, cmpData, propsData, curRange, cmpRange) {
  const section = el('div', { class: 'mb-16' });
  section.appendChild(mkSectionLabel('Partner Overview'));

  const grid = el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:16px' });
  grid.appendChild(buildPartnerColumn(YOU_LABEL, YOU_COLOR, data, cmpData, propsData, curRange, cmpRange, true));
  grid.appendChild(buildPartnerColumn(RITA_LABEL, RITA_COLOR, data, cmpData, propsData, curRange, cmpRange, false));
  section.appendChild(grid);
  return section;
}

// ── Service Revenue by Stream section ────────────────────────────────────────
function buildServiceStreamSection(annotatedInvoices, curRange) {
  const streamTotals = SERVICE_STREAMS.map(stream => {
    const invoices = annotatedInvoices.filter(i => i.stream === stream);
    let you = 0, rita = 0;
    for (const i of invoices) {
      const o = i._resolvedOwner;
      if (o === 'you')  { you  += i._eur; }
      else if (o === 'rita') { rita += i._eur; }
      else { you += i._eur * 0.5; rita += i._eur * 0.5; }
    }
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
      { label: 'Giorgos', right: true, tip: "Giorgos's owner-split share of paid invoices in this stream." },
      { label: 'Rita', right: true, tip: "Rita's owner-split share of paid invoices in this stream." },
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
  const { revSplit, expSplit, netSplit, annotatedPayments, annotatedInvoices, annotatedExpenses } = data;
  const revRecords = [...annotatedPayments, ...annotatedInvoices];
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
    formula: 'Giorgos Revenue + Rita Revenue (owner-split totals)',
    inputs: [
      { label: 'Giorgos Revenue', value: formatEUR(revSplit.you) },
      { label: 'Rita Revenue', value: formatEUR(revSplit.rita) }
    ],
    source: 'analytics-owner.js:608 buildSettlementBody() — `totRev = revSplit.you + revSplit.rita`'
  }));
  sgrid.appendChild(mkSummaryBox('Total OpEx',
    mkDrillValue(formatEUR(totExp), () => drillDownModal('Total OpEx', toOwnerExpRows(annotatedExpenses), OWNER_EXP_COLS)),
    null, {
    title: 'Total OpEx',
    formula: 'Giorgos OpEx + Rita OpEx (owner-split totals, CapEx excluded)',
    inputs: [
      { label: 'Giorgos OpEx', value: formatEUR(expSplit.you) },
      { label: 'Rita OpEx', value: formatEUR(expSplit.rita) }
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
      { label: YOU_LABEL, right: true, tip: "Giorgos's amount for this line item." },
      { label: RITA_LABEL, right: true, tip: "Rita's amount for this line item." },
      { label: 'Total', right: true, tip: 'Combined amount across both partners for this line item.' }
    ],
    rows,
    { highlight: 3, firstColLeft: true }
  ));

  // Implied settlement
  const diff = netSplit.you - netSplit.rita;
  if (Math.abs(diff) > 0.01) {
    const who  = diff > 0 ? RITA_LABEL : YOU_LABEL;
    const to   = diff > 0 ? YOU_LABEL  : RITA_LABEL;
    const amt  = Math.abs(diff) / 2;
    const note = el('div', {
      style: 'margin-top:16px;padding:10px 14px;border-radius:6px;background:rgba(99,102,241,0.06);border-left:3px solid var(--accent,#6366f1)'
    });
    const noteTitleRow = el('div', { style: 'display:flex;align-items:center;gap:4px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-muted);margin-bottom:4px' }, 'Implied Settlement');
    noteTitleRow.appendChild(mkExplainButton({
      title: 'Implied Settlement',
      formula: '|Giorgos Net − Rita Net| ÷ 2, paid by the partner with the higher net profit to the partner with the lower net profit — this equalizes both partners’ net take for the period.',
      inputs: [
        { label: 'Giorgos Net', value: formatEUR(netSplit.you) },
        { label: 'Rita Net', value: formatEUR(netSplit.rita) },
        { label: 'Difference', value: formatEUR(Math.abs(diff)) }
      ],
      source: 'analytics-owner.js:685 buildSettlementBody() — `diff`/`amt`',
      note: "This assumes both partners should end each period with equal net profit — it is not derived from any ownership-percentage config, since none exists in the data model beyond the per-record/per-property `owner` tag ('you' | 'rita' | 'both')."
    }));
    note.appendChild(noteTitleRow);
    note.appendChild(el('div', { style: 'font-size:13px;color:var(--text)' },
      `To equalise net profits, ${who} owes ${to} ${formatEUR(amt)}.`
    ));
    note.appendChild(el('div', { style: 'font-size:11px;color:var(--text-muted);margin-top:4px' },
      `Giorgos net: ${formatEUR(netSplit.you)} · Rita net: ${formatEUR(netSplit.rita)} · Difference: ${formatEUR(Math.abs(diff))}`
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

function openSettlementModal(data, cmpData, curRange, cmpRange) {
  const body = buildSettlementBody(data);
  if (cmpData) {
    const totRev = data.revSplit.you + data.revSplit.rita;
    const totExp = data.expSplit.you + data.expSplit.rita;
    const totNet = data.netSplit.you + data.netSplit.rita;
    const cmpTotRev = cmpData.revSplit.you + cmpData.revSplit.rita;
    const cmpTotExp = cmpData.expSplit.you + cmpData.expSplit.rita;
    const cmpTotNet = cmpData.netSplit.you + cmpData.netSplit.rita;
    const cl = cmpRange?.label || '';
    const revRecords    = [...data.annotatedPayments, ...data.annotatedInvoices];
    const cmpRevRecords = [...cmpData.annotatedPayments, ...cmpData.annotatedInvoices];

    const cmpSection = el('div', { style: 'display:flex;flex-direction:column;gap:8px;margin-bottom:20px' });
    cmpSection.appendChild(mkSectionLabel(`vs ${cl}`));
    cmpSection.appendChild(mkCmpGrid([
      { label: 'Total Revenue',
        curVal: mkDrillValue(formatEUR(totRev), () => drillDownModal('Total Revenue', toOwnerRevRows(revRecords), OWNER_REV_COLS)),
        cmpVal: mkDrillValue(formatEUR(cmpTotRev), () => drillDownModal(`Total Revenue — ${cl}`, toOwnerRevRows(cmpRevRecords), OWNER_REV_COLS)) },
      { label: 'Total OpEx',
        curVal: mkDrillValue(formatEUR(totExp), () => drillDownModal('Total OpEx', toOwnerExpRows(data.annotatedExpenses), OWNER_EXP_COLS)),
        cmpVal: mkDrillValue(formatEUR(cmpTotExp), () => drillDownModal(`Total OpEx — ${cl}`, toOwnerExpRows(cmpData.annotatedExpenses), OWNER_EXP_COLS)) },
      { label: 'Net Profit',
        curVal: mkDrillValue(formatEUR(totNet), () => drillDownModal('Net Profit', toOwnerMixedRows(revRecords, data.annotatedExpenses), OWNER_MIXED_COLS)),
        cmpVal: mkDrillValue(formatEUR(cmpTotNet), () => drillDownModal(`Net Profit — ${cl}`, toOwnerMixedRows(cmpRevRecords, cmpData.annotatedExpenses), OWNER_MIXED_COLS)) },
    ], 'Current Period', cl));
    body.prepend(cmpSection);
  }
  openModal({ title: `Settlement Summary — ${curRange.label}`, body, large: true });
}

// ── Charts ────────────────────────────────────────────────────────────────────

function renderRevBar(annotatedPayments, annotatedInvoices, months) {
  if (!months.length) return;

  const allRecords = [...annotatedPayments, ...annotatedInvoices];
  const youData  = [];
  const ritaData = [];

  for (const m of months) {
    const mk = m.key;
    const pays = allRecords.filter(r => (r.date || r.issueDate || '').slice(0, 7) === mk);
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
      const items = allRecords.filter(r => (r.date || r.issueDate || '').slice(0, 7) === mk);
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

      body.appendChild(mkSectionLabel('By Property / Client'));
      body.appendChild(mkModalTable(
        [
          { label: 'Entity', tip: 'Property or client generating this revenue.' },
          { label: YOU_LABEL, right: true, tip: "Giorgos's owner-split share of this entity's revenue in the selected month." },
          { label: RITA_LABEL, right: true, tip: "Rita's owner-split share of this entity's revenue in the selected month." },
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
            { label: 'Owner', tip: "Resolved owner for this record — Giorgos, Rita, or Shared (owner='both')." },
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

function renderProfitHBar(annotatedPayments, annotatedInvoices, annotatedExpenses) {
  const allProps = listActive('properties');
  if (!allProps.length) return;

  // Pre-build Map for O(1) property lookups instead of O(n) byId scans per record
  const propMap  = new Map(allProps.map(p => [p.id, p]));
  const propRevs = new Map();
  const propExps = new Map();

  for (const r of [...annotatedPayments, ...annotatedInvoices]) {
    const propId = r.propertyId;
    if (!propId) {
      // Service invoices have no propertyId — bucket under a virtual 'Services' entry
      const svcKey = '__services__';
      const e = propRevs.get(svcKey) || { name: 'Services', owner: r._resolvedOwner || 'both', youRev: 0, ritaRev: 0 };
      const o = r._resolvedOwner; const half = r._eur * 0.5;
      if (o === 'you') { e.youRev += r._eur; } else if (o === 'rita') { e.ritaRev += r._eur; } else { e.youRev += half; e.ritaRev += half; }
      propRevs.set(svcKey, e);
      continue;
    }
    const prop  = propMap.get(propId);
    if (!prop)  continue;
    // Use the record's own _resolvedOwner (payments/invoices already fall back
    // to the linked property's owner in getData()) rather than re-deriving from
    // the property directly — otherwise this chart can disagree with the KPIs/
    // Settlement section's totals for the exact same records.
    const owner = r._resolvedOwner || 'both';
    const e     = propRevs.get(propId) || { name: prop.name, owner, youRev: 0, ritaRev: 0 };
    const half  = r._eur * 0.5;
    if (owner === 'you') { e.youRev += r._eur; } else if (owner === 'rita') { e.ritaRev += r._eur; } else { e.youRev += half; e.ritaRev += half; }
    propRevs.set(propId, e);
  }

  for (const e of annotatedExpenses) {
    const propId = e.propertyId;
    if (!propId) continue;
    const prop  = propMap.get(propId);
    if (!prop)  continue;
    // Same reasoning as the revenue loop above — use the expense's own
    // _resolvedOwner instead of re-deriving from the property.
    const owner = e._resolvedOwner || 'both';
    const entry = propExps.get(propId) || { youExp: 0, ritaExp: 0 };
    const half  = e._eur * 0.5;
    if (owner === 'you') { entry.youExp += e._eur; } else if (owner === 'rita') { entry.ritaExp += e._eur; } else { entry.youExp += half; entry.ritaExp += half; }
    propExps.set(propId, entry);
  }

  const propIds = new Set([...propRevs.keys(), ...propExps.keys()]);
  if (!propIds.size) return;

  const items = [...propIds].map(id => {
    const rev = propRevs.get(id) || { name: id === '__services__' ? 'Services' : (propMap.get(id)?.name || 'Unknown'), owner: 'both', youRev: 0, ritaRev: 0 };
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

      const propRevRecords = item.id === '__services__'
        ? [...annotatedPayments, ...annotatedInvoices].filter(r => !r.propertyId)
        : [...annotatedPayments, ...annotatedInvoices].filter(r => r.propertyId === item.id);
      const propExpRecords = item.id === '__services__' ? [] : annotatedExpenses.filter(e => e.propertyId === item.id);

      const body = el('div');
      body.appendChild(mkSummaryGrid([
        { label: 'Revenue — Giorgos',
          value: mkDrillValue(formatEUR(item.youRev), () => drillDownModal(`${item.name} — Revenue (${YOU_LABEL})`, toOwnerRevRows(propRevRecords, 'you'), OWNER_REV_COLS)),
          sub: `OpEx: ${formatEUR(item.youExp)}`,
          explain: {
            title: 'Revenue — Giorgos',
            formula: "Owner-split revenue for this property: 'you' records count 100%, 'both' records count 50%.",
            inputs: [{ label: 'Revenue — Giorgos', value: formatEUR(item.youRev) }],
            source: 'analytics-owner.js:847 renderProfitHBar()'
          }
        },
        { label: 'Revenue — Rita',
          value: mkDrillValue(formatEUR(item.ritaRev), () => drillDownModal(`${item.name} — Revenue (${RITA_LABEL})`, toOwnerRevRows(propRevRecords, 'rita'), OWNER_REV_COLS)),
          sub: `OpEx: ${formatEUR(item.ritaExp)}`,
          explain: {
            title: 'Revenue — Rita',
            formula: "Owner-split revenue for this property: 'rita' records count 100%, 'both' records count 50%.",
            inputs: [{ label: 'Revenue — Rita', value: formatEUR(item.ritaRev) }],
            source: 'analytics-owner.js:847 renderProfitHBar()'
          }
        },
        { label: 'Net Profit — Giorgos',
          value: mkDrillValue(formatEUR(item.youNet), () => drillDownModal(`${item.name} — Net Profit (${YOU_LABEL})`, toOwnerMixedRows(propRevRecords, propExpRecords, 'you'), OWNER_MIXED_COLS)),
          sub: null,
          explain: {
            title: 'Net Profit — Giorgos',
            formula: 'Revenue — Giorgos − OpEx — Giorgos',
            inputs: [
              { label: 'Revenue — Giorgos', value: formatEUR(item.youRev) },
              { label: 'OpEx — Giorgos', value: formatEUR(item.youExp) }
            ],
            source: 'analytics-owner.js:903 renderProfitHBar() — `youNet: rev.youRev - exp.youExp`'
          }
        },
        { label: 'Net Profit — Rita',
          value: mkDrillValue(formatEUR(item.ritaNet), () => drillDownModal(`${item.name} — Net Profit (${RITA_LABEL})`, toOwnerMixedRows(propRevRecords, propExpRecords, 'rita'), OWNER_MIXED_COLS)),
          sub: null,
          explain: {
            title: 'Net Profit — Rita',
            formula: 'Revenue — Rita − OpEx — Rita',
            inputs: [
              { label: 'Revenue — Rita', value: formatEUR(item.ritaRev) },
              { label: 'OpEx — Rita', value: formatEUR(item.ritaExp) }
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
          { label: YOU_LABEL, right: true, tip: "Giorgos's owner-split share for this property." },
          { label: RITA_LABEL, right: true, tip: "Rita's owner-split share for this property." },
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
  const props  = propsData.allProps.filter(p => ownedOwners.includes(p.owner || 'both'));
  const rows   = props.map(p => {
    const fullEur = toEUR(p.purchasePrice || 0, p.currency || 'EUR', p.purchaseDate || null);
    const share   = (p.owner === 'both' || !p.owner) ? fullEur * 0.5 : fullEur;
    return [p.name, p.owner === 'both' ? 'Shared (50%)' : isYou ? 'Giorgos' : 'Rita', formatEUR(share)];
  });
  const totalValue = isYou ? propsData.youValue : propsData.ritaValue;

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
      { label: 'Attribution', tip: "Which partner this property's book value share belongs to — 'Shared (50%)' for owner='both' properties." },
      { label: 'Book Value (EUR)', right: true, tip: "This partner's share of the property's purchase price, converted to EUR." }
    ],
    rows, { highlight: 2 }
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

  const data      = getData(curRange.start, curRange.end);
  const cmpData   = cmpRange ? getData(cmpRange.start, cmpRange.end) : null;
  const propsData = getPropertiesData(gF);

  const compLine = buildComparisonLine(curRange, cmpRange);
  if (compLine) wrap.appendChild(compLine);

  // KPI cards
  wrap.appendChild(buildKpiSection(data, cmpData, propsData, cmpRange));

  // Partner side-by-side columns
  wrap.appendChild(buildPartnerComparison(data, cmpData, propsData, curRange, cmpRange));

  // ── Charts row 1: Revenue by Owner (monthly bar) ──────────────────────────
  const row1 = el('div', { class: 'grid grid-2 mb-16' });

  row1.appendChild(el('div', { class: 'card' },
    el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'Revenue by Owner (Monthly)')),
    el('div', { class: 'chart-wrap tall' }, el('canvas', { id: 'own-rev-bar' }))
  ));

  // Profit by Property (horizontal bar)
  row1.appendChild(el('div', { class: 'card' },
    el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'Profit by Property & Owner')),
    el('div', { class: 'chart-wrap tall' }, el('canvas', { id: 'own-profit-hbar' }))
  ));

  wrap.appendChild(row1);

  // ── Charts row 2: Portfolio Value donut ───────────────────────────────────
  const row2 = el('div', { class: 'grid grid-2 mb-16' });

  {
    row2.appendChild(el('div', { class: 'card' },
      el('div', { class: 'card-header' },
        el('div', { class: 'card-title' }, 'Portfolio Value Split')
      ),
      el('div', { class: 'chart-wrap tall' }, el('canvas', { id: 'own-value-donut' }))
    ));
  }

  // Portfolio summary card (plain info, no chart)
  {
    const infoCard = el('div', { class: 'card' });
    infoCard.appendChild(el('div', { class: 'card-header' },
      el('div', { class: 'card-title' }, 'Portfolio Summary')
    ));
    const infoBody = el('div', { style: 'padding:0 16px 16px' });

    const totalProps = propsData.allProps.length;
    const pGrid = el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px' });
    pGrid.appendChild(mkSummaryBox(YOU_LABEL, `${propsData.youCount} propert${propsData.youCount !== 1 ? 'ies' : 'y'}`,
      mkDrillValue(formatEUR(propsData.youValue), () => openValueSplitModal(YOU_LABEL, 0, propsData)), {
      title: `${YOU_LABEL} Book Value`,
      formula: "Sum of purchase price (EUR) for properties fully owned by Giorgos, plus 50% of purchase price for jointly-owned ('both') properties.",
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
      formula: "Sum of purchase price (EUR) for properties fully owned by Rita, plus 50% of purchase price for jointly-owned ('both') properties.",
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
    row2.appendChild(infoCard);
  }

  wrap.appendChild(row2);

  // ── Service Revenue by Stream ─────────────────────────────────────────────
  const svcStreamSection = buildServiceStreamSection(data.annotatedInvoices, curRange);
  if (svcStreamSection) wrap.appendChild(svcStreamSection);

  // ── Settlement section ────────────────────────────────────────────────────
  wrap.appendChild(buildSettlementSection(data, curRange));

  // Render charts after DOM is ready
  setTimeout(() => {
    renderRevBar(data.annotatedPayments, data.annotatedInvoices, months);
    renderProfitHBar(data.annotatedPayments, data.annotatedInvoices, data.annotatedExpenses);
    renderValueDonut(propsData);
  }, 0);

  return wrap;
}
