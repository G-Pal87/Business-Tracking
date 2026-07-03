// Owner/Partner Analytics Dashboard — partner P&L, settlement, portfolio split
import { el, openModal } from '../core/ui.js';
import * as charts from '../core/charts.js';
import { formatEUR, toEUR, byId, listActive, listActivePayments, isCapEx, getPersonName } from '../core/data.js';
import {
  createFilterState, buildFilterBar, buildComparisonLine,
  getCurrentPeriodRange, getComparisonRange, getMonthKeysForRange, makeMatchers
} from './analytics-filters.js?v=20260519';
import {
  mkSectionLabel, mkSummaryBox, mkSummaryGrid, mkModalTable, mkVarianceBadge, mkEmptyState, mkKpiCard, mkCmpGrid, safePct
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

  const scopeOk = p => gScope === 'all' || (propMap.get(p.propertyId)?.channel || 'company') === 'company';

  // Payments — rental income (no owner filter, we split manually)
  const payments = listActivePayments().filter(p =>
    p.status === 'paid' && inRange(p.date) && mStream(p) && mProperty(p) && (!p.propertyId || scopeOk(p))
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
  const annotatedInvoices = invoices.map(i => ({
    ...i,
    _resolvedOwner: i.owner || 'both',
    _eur: toEUR(i.total, i.currency, i.issueDate)
  }));

  // Expenses (OpEx only for profit)
  const expenses = listActive('expenses').filter(e => {
    const d = e.date || '';
    return d >= start && d <= end && !isCapEx(e) && mProperty(e) && mStream(e) && (!e.propertyId || scopeOk(e));
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
function buildShareKpiModal(owner, partnerLabel, revenue, pct, allRecords) {
  const relevant = allRecords
    .filter(r => r._resolvedOwner === owner || r._resolvedOwner === 'both')
    .map(r => ({ ...r, _shareEur: r._resolvedOwner === 'both' ? r._eur * 0.5 : r._eur }))
    .sort((a, b) => b._shareEur - a._shareEur)
    .slice(0, 5);

  const body = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });
  body.appendChild(mkSummaryGrid([
    { label: `${partnerLabel} Revenue`, value: formatEUR(revenue) },
    { label: '% of Portfolio',          value: pct.toFixed(1) + '%' }
  ], 2));
  if (relevant.length > 0) {
    body.appendChild(mkSectionLabel('Top 5 Records by Amount'));
    body.appendChild(mkModalTable(
      ['Date', 'Entity', 'Attribution', 'EUR'],
      relevant.map(r => {
        const date   = r.date || r.issueDate || '—';
        const entity = r.propertyId ? (byId('properties', r.propertyId)?.name || '—')
                     : r.clientId   ? (byId('clients',    r.clientId)?.name   || '—') : '—';
        return [date, entity, r._resolvedOwner === 'both' ? 'Shared (50%)' : partnerLabel, formatEUR(r._shareEur)];
      }),
      { highlight: 3 }
    ));
  }
  return body;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function safePctStr(val, total) {
  if (!total || !isFinite(total)) return '—';
  return (val / total * 100).toFixed(1) + '%';
}

function netColor(val) {
  return val >= 0 ? 'var(--success, #22c55e)' : 'var(--danger, #ef4444)';
}

// ── Partner column card ───────────────────────────────────────────────────────
function buildPartnerColumn(label, color, data, propsData, isYou) {
  const rev    = isYou ? data.revSplit.you  : data.revSplit.rita;
  const exp    = isYou ? data.expSplit.you  : data.expSplit.rita;
  const net    = isYou ? data.netSplit.you  : data.netSplit.rita;
  const count  = isYou ? propsData.youCount : propsData.ritaCount;
  const value  = isYou ? propsData.youValue : propsData.ritaValue;

  const col = el('div', {
    style: `background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:8px;padding:16px;border-top:3px solid ${color}`
  });

  // Partner header
  col.appendChild(el('div', {
    style: `font-size:14px;font-weight:700;color:${color};margin-bottom:12px;letter-spacing:0.03em`
  }, label));

  const rows = [
    { label: 'Revenue',                        value: formatEUR(rev),   sub: null },
    { label: 'Operating Expenses (excl. CapEx)', value: formatEUR(exp),   sub: null },
    { label: 'Net Profit',          value: formatEUR(net),   sub: null, netVal: net },
    { label: 'Portfolio Properties',value: String(count),    sub: null },
    { label: 'Portfolio Book Value', value: formatEUR(value), sub: null },
  ];

  for (const row of rows) {
    const item = el('div', { style: 'display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px solid rgba(255,255,255,0.04)' });
    item.appendChild(el('span', { style: 'font-size:12px;color:var(--text-muted)' }, row.label));
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
    value: formatEUR(total),
    subtitle: 'All partners combined',
    delta: safePct(total, cmpData?.total),
    compLabel: cl,
    compValue: cmpData ? formatEUR(cmpData.total) : undefined,
    onClick: () => {
      const body = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });
      if (cmpData) {
        const cmpYou  = cmpData.revSplit.you;
        const cmpRita = cmpData.revSplit.rita;
        body.appendChild(mkCmpGrid([
          { label: YOU_LABEL,  curVal: formatEUR(revSplit.you),  cmpVal: formatEUR(cmpYou)  },
          { label: RITA_LABEL, curVal: formatEUR(revSplit.rita), cmpVal: formatEUR(cmpRita) },
          { label: 'Total',    curVal: formatEUR(total),          cmpVal: formatEUR(cmpData.total) },
        ], 'Current Period', cl));
      } else {
        body.appendChild(mkSummaryGrid([
          { label: YOU_LABEL,  value: formatEUR(revSplit.you),  sub: youPct.toFixed(1) + '%' },
          { label: RITA_LABEL, value: formatEUR(revSplit.rita), sub: ritaPct.toFixed(1) + '%' },
          { label: 'Total',    value: formatEUR(total) }
        ], 3));
      }
      body.appendChild(mkSectionLabel('Revenue Split'));
      body.appendChild(mkModalTable(
        ['Partner', 'Revenue', '% of Total'],
        [
          [YOU_LABEL,  formatEUR(revSplit.you),  youPct.toFixed(1)  + '%'],
          [RITA_LABEL, formatEUR(revSplit.rita), ritaPct.toFixed(1) + '%'],
          ['Total',    formatEUR(total),          '100%']
        ],
        { highlight: 1 }
      ));
      openModal({ title: 'Total Portfolio Revenue — Breakdown', body, large: true });
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
      const body = buildShareKpiModal('you', 'Giorgos', revSplit.you, youPct, [...annotatedPayments, ...annotatedInvoices]);
      openModal({ title: 'Giorgos Share — Detail', body, large: true });
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
      const body = buildShareKpiModal('rita', 'Rita', revSplit.rita, ritaPct, [...annotatedPayments, ...annotatedInvoices]);
      openModal({ title: 'Rita Share — Detail', body, large: true });
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
          ['Property', 'Revenue', '% of Shared Total'],
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
function buildPartnerComparison(data, propsData) {
  const section = el('div', { class: 'mb-16' });
  section.appendChild(mkSectionLabel('Partner Overview'));

  const grid = el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:16px' });
  grid.appendChild(buildPartnerColumn(YOU_LABEL, YOU_COLOR, data, propsData, true));
  grid.appendChild(buildPartnerColumn(RITA_LABEL, RITA_COLOR, data, propsData, false));
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
    return { stream, you, rita, total: you + rita, count: invoices.length };
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
  const rows = streamTotals.map(r => [
    streamLabel(r.stream),
    formatEUR(r.you),
    formatEUR(r.rita),
    formatEUR(r.total)
  ]);
  rows.push(['Total', formatEUR(grandYou), formatEUR(grandRita), formatEUR(grandTotal)]);

  body.appendChild(mkModalTable(
    ['Stream', 'Giorgos', 'Rita', 'Total'],
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
function buildSettlementSection(data, curRange) {
  const { revSplit, expSplit, netSplit } = data;
  const periodLabel = curRange.label;

  const section = el('div', { class: 'card mb-16' });
  section.appendChild(el('div', { class: 'card-header' },
    el('div', { class: 'card-title' }, `Settlement Summary — ${periodLabel}`)
  ));

  const body = el('div', { style: 'padding:0 16px 16px' });

  // Summary grid
  const totRev = revSplit.you + revSplit.rita;
  const totExp = expSplit.you + expSplit.rita;
  const totNet = netSplit.you + netSplit.rita;

  const sgrid = el('div', { style: 'display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:20px' });
  sgrid.appendChild(mkSummaryBox('Total Revenue', formatEUR(totRev), null));
  sgrid.appendChild(mkSummaryBox('Total OpEx', formatEUR(totExp), null));
  sgrid.appendChild(mkSummaryBox('Net Profit', formatEUR(totNet),
    totNet >= 0 ? 'Portfolio profitable' : 'Portfolio at a loss'));
  body.appendChild(sgrid);

  // Per-partner expense attribution breakdown
  // Shared expenses (owner='both') → split 50/50 by share percentage
  const youShareFraction  = totRev > 0 ? revSplit.you  / totRev : 0.5;
  const ritaShareFraction = totRev > 0 ? revSplit.rita / totRev : 0.5;

  // Partition expenses: partner-specific vs shared
  const { annotatedExpenses } = data;
  let youDirectExp = 0, ritaDirectExp = 0, sharedExp = 0;
  for (const e of annotatedExpenses) {
    const owner = e._resolvedOwner;
    if (owner === 'you')       youDirectExp  += e._eur;
    else if (owner === 'rita') ritaDirectExp += e._eur;
    else                       sharedExp     += e._eur;
  }
  // Attribute shared expenses proportionally to each partner's revenue share
  const youSharedAlloc  = sharedExp * youShareFraction;
  const ritaSharedAlloc = sharedExp * ritaShareFraction;
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
    ['', YOU_LABEL, RITA_LABEL, 'Total'],
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
    note.appendChild(el('div', { style: 'font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-muted);margin-bottom:4px' }, 'Implied Settlement'));
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

  section.appendChild(body);
  return section;
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
        { label: YOU_LABEL,  value: formatEUR(split.you),  sub: `${items.filter(r => (r._resolvedOwner === 'you' || r._resolvedOwner === 'both')).length} records` },
        { label: RITA_LABEL, value: formatEUR(split.rita), sub: `${items.filter(r => (r._resolvedOwner === 'rita' || r._resolvedOwner === 'both')).length} records` }
      ], 2));

      const rows = items
        .sort((a, b) => ((b.date || b.issueDate) || '').localeCompare((a.date || a.issueDate) || ''))
        .map(r => [
          r.date || r.issueDate || '—',
          r._resolvedOwner === 'you' ? YOU_LABEL : r._resolvedOwner === 'rita' ? RITA_LABEL : 'Shared',
          r.propertyId ? (byId('properties', r.propertyId)?.name || '—') : (r.clientId ? (byId('clients', r.clientId)?.name || '—') : '—'),
          formatEUR(r._eur)
        ]);
      body.appendChild(mkSectionLabel('Records'));
      body.appendChild(mkModalTable(['Date', 'Owner', 'Entity', 'EUR'], rows, { highlight: 3 }));
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
    const owner = prop.owner || 'both';
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
    const owner = prop.owner || 'both';
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

      const body = el('div');
      body.appendChild(mkSummaryGrid([
        { label: 'Revenue — Giorgos',  value: formatEUR(item.youRev),  sub: `OpEx: ${formatEUR(item.youExp)}` },
        { label: 'Revenue — Rita',     value: formatEUR(item.ritaRev), sub: `OpEx: ${formatEUR(item.ritaExp)}` },
        { label: 'Net Profit — Giorgos', value: formatEUR(item.youNet),  sub: null },
        { label: 'Net Profit — Rita',    value: formatEUR(item.ritaNet), sub: null },
      ], 2));

      const rows = [
        ['Revenue',  formatEUR(item.youRev),  formatEUR(item.ritaRev),  formatEUR(item.youRev + item.ritaRev)],
        ['OpEx',     formatEUR(item.youExp),  formatEUR(item.ritaExp),  formatEUR(item.youExp + item.ritaExp)],
        ['Net',      formatEUR(item.youNet),  formatEUR(item.ritaNet),  formatEUR(item.youNet + item.ritaNet)],
      ];
      body.appendChild(mkSectionLabel('Full P&L with Owner Attribution'));
      body.appendChild(mkModalTable(['', YOU_LABEL, RITA_LABEL, 'Total'], rows, { highlight: 3 }));
      openModal({ title: `${item.name} — P&L by Owner`, body, large: true });
    }
  });
}

function renderValueDonut(propsData) {
  const { youValue, ritaValue } = propsData;
  if (!youValue && !ritaValue) return;

  charts.doughnut('own-value-donut', {
    labels: [YOU_LABEL, RITA_LABEL],
    data:   [Math.round(youValue), Math.round(ritaValue)],
    colors: [YOU_HEX, RITA_HEX],
    onClickItem: (label, idx) => {
      const isYou  = idx === 0;
      const ownedOwners = isYou ? ['you', 'both'] : ['rita', 'both'];
      const props  = propsData.allProps.filter(p => ownedOwners.includes(p.owner || 'both'));
      const body   = el('div');
      const rows   = props.map(p => {
        const fullEur = toEUR(p.purchasePrice || 0, p.currency || 'EUR', p.purchaseDate || null);
        const share   = (p.owner === 'both' || !p.owner) ? fullEur * 0.5 : fullEur;
        return [p.name, p.owner === 'both' ? 'Shared (50%)' : isYou ? 'Giorgos' : 'Rita', formatEUR(share)];
      });
      body.appendChild(mkModalTable(['Property', 'Attribution', 'Book Value (EUR)'], rows, { highlight: 2 }));
      openModal({ title: `Portfolio Value — ${label}`, body, large: true });
    }
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
  wrap.appendChild(buildPartnerComparison(data, propsData));

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
    const btn = el('button', {
      style: 'background:none;border:1px solid var(--border);border-radius:4px;color:var(--text-muted);font-size:11px;cursor:pointer;padding:2px 6px;line-height:1'
    }, '%');
    btn.onclick = () => { const sp = charts.toggleDoughnutPct('own-value-donut'); btn.textContent = sp ? '€' : '%'; };

    row2.appendChild(el('div', { class: 'card' },
      el('div', { class: 'card-header', style: 'display:flex;align-items:center;justify-content:space-between' },
        el('div', { class: 'card-title' }, 'Portfolio Value Split'),
        btn
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
    pGrid.appendChild(mkSummaryBox(YOU_LABEL, `${propsData.youCount} propert${propsData.youCount !== 1 ? 'ies' : 'y'}`, formatEUR(propsData.youValue)));
    pGrid.appendChild(mkSummaryBox(RITA_LABEL, `${propsData.ritaCount} propert${propsData.ritaCount !== 1 ? 'ies' : 'y'}`, formatEUR(propsData.ritaValue)));
    infoBody.appendChild(pGrid);

    if (propsData.bothProps.length > 0) {
      infoBody.appendChild(mkSectionLabel('Shared Properties (50/50)'));
      const rows = propsData.bothProps.map(p => {
        const eur = toEUR(p.purchasePrice || 0, p.currency || 'EUR', p.purchaseDate || null);
        return [p.name, formatEUR(eur), formatEUR(eur * 0.5)];
      });
      infoBody.appendChild(mkModalTable(['Property', 'Total Value', 'Per Partner'], rows, { highlight: 2 }));
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
