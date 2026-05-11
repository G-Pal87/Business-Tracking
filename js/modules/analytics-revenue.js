// Revenue Analytics Dashboard — structure · growth · collections · contributors · dynamics
import { el, fmtDate, drillDownModal, attachSortFilter } from '../core/ui.js';
import * as charts from '../core/charts.js';
import { STREAMS, OWNERS } from '../core/config.js';
import {
  formatEUR, toEUR, byId,
  listActive, listActivePayments,
  drillRevRows
} from '../core/data.js';
import {
  createFilterState, getCurrentPeriodRange, getComparisonRange,
  getMonthKeysForRange, makeMatchers, buildFilterBar, buildComparisonLine
} from './analytics-filters.js';

const MONTH_LABELS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const OWNER_COLORS = { you: '#6366f1', rita: '#ec4899', both: '#14b8a6' };
const CHART_IDS    = [
  'rev-trend', 'rev-stream-bar', 'rev-prop-bar', 'rev-client-bar', 'rev-owner-donut',
  'rev-mix-evolution', 'rev-growth-trend', 'rev-paid-outstanding',
  'rev-concentration', 'rev-aging'
];
const REV_COLS = [
  { key: 'date',   label: 'Date',   format: v => fmtDate(v) },
  { key: 'type',   label: 'Type'   },
  { key: 'source', label: 'Entity' },
  { key: 'ref',    label: 'Ref'    },
  { key: 'eur',    label: 'EUR',    right: true, format: v => formatEUR(v) }
];
// ── Filter state ──────────────────────────────────────────────────────────────
let gF = createFilterState();

// ── Module export ─────────────────────────────────────────────────────────────
export default {
  id: 'analytics-revenue', label: 'Revenue', icon: '₊',
  render(container) { container.appendChild(buildView()); },
  refresh() { rebuildView(); },
  destroy() { CHART_IDS.forEach(id => charts.destroy(id)); }
};

// ── Data ──────────────────────────────────────────────────────────────────────
function getData(start, end) {
  const inRange = d => d && d >= start && d <= end;
  const { mStream, mOwner, mProperty, mClient } = makeMatchers(gF);

  // Property filter → isolate rental revenue (exclude invoices entirely)
  // Client filter   → isolate service revenue (exclude payments entirely)
  const payments = gF.clientIds.size > 0 ? [] : listActivePayments().filter(p =>
    p.status === 'paid' && inRange(p.date) && mStream(p) && mOwner(p) && mProperty(p)
  );
  const invoices = gF.propertyIds.size > 0 ? [] : listActive('invoices').filter(i =>
    i.status === 'paid' && inRange(i.issueDate) && mStream(i) && mOwner(i) && mClient(i)
  );
  const outstanding = gF.propertyIds.size > 0 ? [] : listActive('invoices').filter(i =>
    !['paid', 'cancelled', 'void'].includes(i.status) &&
    inRange(i.issueDate) && mStream(i) && mOwner(i) && mClient(i)
  );

  const propRev  = payments.reduce((s, p) => s + toEUR(p.amount, p.currency, p.date), 0);
  const svcRev   = invoices.reduce((s, i) => s + toEUR(i.total, i.currency, i.issueDate), 0);
  const outTotal = outstanding.reduce((s, i) => s + toEUR(i.total, i.currency, i.issueDate), 0);
  return { payments, invoices, outstanding, propRev, svcRev, total: propRev + svcRev, outstandingTotal: outTotal };
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function safePct(cur, cmp) {
  if (cmp === null || cmp === undefined || !isFinite(cmp) || cmp === 0) return null;
  const v = (cur - cmp) / Math.abs(cmp) * 100;
  return isFinite(v) ? v : null;
}

const fmtK = v => v >= 10000 ? `€${(v / 1000).toFixed(0)}k` : v >= 1000 ? `€${(v / 1000).toFixed(1)}k` : formatEUR(v, { maxFrac: 0 });

// ── KPI card ──────────────────────────────────────────────────────────────────
function kpiCard({ label, value, subtitle, delta, deltaIsPp, invertDelta, compLabel, variant, onClick }) {
  const card = el('div', {
    class: 'kpi' + (variant ? ' ' + variant : ''),
    style: 'cursor:pointer;transition:box-shadow 120ms',
    title: 'Click for breakdown'
  });
  card.addEventListener('mouseenter', () => { card.style.boxShadow = '0 0 0 2px var(--accent)'; });
  card.addEventListener('mouseleave', () => { card.style.boxShadow = ''; });
  if (onClick) card.onclick = onClick;

  card.appendChild(el('div', { class: 'kpi-label' }, label));
  card.appendChild(el('div', { class: 'kpi-value' }, value));

  const trend = el('div', { class: 'kpi-trend' });
  if (delta === null || delta === undefined || !isFinite(delta)) {
    if (compLabel) {
      trend.appendChild(el('span', { style: 'color:var(--text-muted);font-size:11px' }, 'N/A'));
      trend.appendChild(document.createTextNode(` vs ${compLabel}`));
    }
  } else {
    const sign = delta > 0 ? '+' : '';
    const disp = deltaIsPp ? `${sign}${delta.toFixed(1)} pp` : `${sign}${delta.toFixed(1)}%`;
    const cls  = delta === 0 ? '' : delta > 0 ? (invertDelta ? 'down' : 'up') : (invertDelta ? 'up' : 'down');
    trend.appendChild(el('span', { class: cls }, disp));
    if (compLabel) trend.appendChild(document.createTextNode(` vs ${compLabel}`));
  }
  card.appendChild(trend);
  if (subtitle) card.appendChild(el('div', { style: 'font-size:11px;color:var(--text-muted);margin-top:2px' }, subtitle));
  card.appendChild(el('div', { class: 'kpi-accent-bar' }));
  return card;
}

// ── Composite KPI card (wider, with breakdown lines) ─────────────────────────
function compositeKpiCard({ label, value, delta, deltaIsPp, compLabel, onClick, lines }) {
  const card = el('div', {
    class: 'kpi',
    style: 'cursor:pointer;transition:box-shadow 120ms',
    title: 'Click for breakdown'
  });
  card.addEventListener('mouseenter', () => { card.style.boxShadow = '0 0 0 2px var(--accent)'; });
  card.addEventListener('mouseleave', () => { card.style.boxShadow = ''; });
  if (onClick) card.onclick = onClick;

  card.appendChild(el('div', { class: 'kpi-label' }, label));
  card.appendChild(el('div', { class: 'kpi-value' }, value));

  const trend = el('div', { class: 'kpi-trend' });
  if (delta === null || delta === undefined || !isFinite(delta)) {
    if (compLabel) trend.appendChild(el('span', { style: 'color:var(--text-muted);font-size:11px' }, `N/A vs ${compLabel}`));
  } else {
    const sign = delta > 0 ? '+' : '';
    const disp = deltaIsPp ? `${sign}${delta.toFixed(1)} pp` : `${sign}${delta.toFixed(1)}%`;
    const cls  = delta === 0 ? '' : delta > 0 ? 'up' : 'down';
    trend.appendChild(el('span', { class: cls }, disp));
    if (compLabel) trend.appendChild(document.createTextNode(` vs ${compLabel}`));
  }
  card.appendChild(trend);

  if (lines?.length) {
    card.appendChild(el('div', { style: 'margin:8px 0 6px;border-top:1px solid rgba(255,255,255,0.06)' }));
    for (const ln of lines) {
      const row = el('div', { style: 'display:flex;justify-content:space-between;align-items:flex-start;gap:6px;font-size:11px;padding:2px 4px;margin:0 -4px;border-radius:3px' });
      row.appendChild(el('span', { style: 'color:var(--text-muted);flex-shrink:0' }, ln.label));
      const right = el('span', { style: 'color:var(--text);font-weight:500;min-width:0;word-break:break-word;text-align:right' },
        ln.value + (ln.pct !== undefined ? ` (${ln.pct})` : '')
      );
      row.appendChild(right);
      if (ln.onClick) {
        row.style.cursor = 'pointer';
        row.addEventListener('mouseenter', () => { row.style.background = 'rgba(255,255,255,0.05)'; });
        row.addEventListener('mouseleave', () => { row.style.background = ''; });
        row.onclick = e => { e.stopPropagation(); ln.onClick(); };
      }
      card.appendChild(row);
    }
  }

  card.appendChild(el('div', { class: 'kpi-accent-bar' }));
  return card;
}

// ── KPI section ───────────────────────────────────────────────────────────────
function buildKpiSection(cur, cmp, cmpRange) {
  const { payments, invoices, outstanding, propRev, svcRev, total, outstandingTotal } = cur;
  const cl = cmpRange?.label || '';

  const invoicedT = svcRev + outstandingTotal;
  const collRate  = invoicedT > 0 ? svcRev / invoicedT * 100 : null;

  // Stream-level revenue
  const strMap = new Map();
  payments.forEach(p => { const s = p.stream || 'other'; strMap.set(s, (strMap.get(s) || 0) + toEUR(p.amount, p.currency, p.date)); });
  invoices.forEach(i => { const s = i.stream || 'other'; strMap.set(s, (strMap.get(s) || 0) + toEUR(i.total, i.currency, i.issueDate)); });
  const stRev  = strMap.get('short_term_rental')  || 0;
  const ltRev  = strMap.get('long_term_rental')   || 0;
  const csRev  = strMap.get('customer_success')   || 0;
  const mktRev = strMap.get('marketing_services') || 0;

  const activePropIds   = new Set(payments.map(p => p.propertyId).filter(Boolean));
  const activeClientIds = new Set(invoices.map(i => i.clientId).filter(Boolean));
  const avgPerProp      = activePropIds.size   > 0 ? propRev / activePropIds.size   : null;
  const avgPerClient    = activeClientIds.size > 0 ? svcRev  / activeClientIds.size : null;

  // Top contributors sorted by revenue
  const contribs = [];
  {
    const pMap = new Map(), iMap = new Map();
    payments.forEach(p => pMap.set(p.propertyId, (pMap.get(p.propertyId) || 0) + toEUR(p.amount, p.currency, p.date)));
    invoices.forEach(i => iMap.set(i.clientId,   (iMap.get(i.clientId)   || 0) + toEUR(i.total, i.currency, i.issueDate)));
    pMap.forEach((v, id) => contribs.push({ name: byId('properties', id)?.name || 'Unknown', val: v, type: 'Property' }));
    iMap.forEach((v, id) => contribs.push({ name: byId('clients',    id)?.name || 'Unknown', val: v, type: 'Client'   }));
    contribs.sort((a, b) => b.val - a.val);
  }

  // Comparison deltas
  let dTotal, dRental, dService, dOutstanding, dAvgProp, dAvgClient;
  if (cmp) {
    dTotal       = safePct(total,             cmp.total);
    dRental      = safePct(propRev,           cmp.propRev);
    dService     = safePct(svcRev,            cmp.svcRev);
    dOutstanding = safePct(outstandingTotal,  cmp.outstandingTotal);
    const cmpPropIds   = new Set(cmp.payments.map(p => p.propertyId).filter(Boolean));
    const cmpClientIds = new Set(cmp.invoices.map(i => i.clientId).filter(Boolean));
    dAvgProp   = safePct(avgPerProp,   cmpPropIds.size   > 0 ? cmp.propRev / cmpPropIds.size   : null);
    dAvgClient = safePct(avgPerClient, cmpClientIds.size > 0 ? cmp.svcRev  / cmpClientIds.size : null);
  }

  const pct = (num, den) => den > 0 ? (num / den * 100).toFixed(0) + '%' : '—';
  const outstandingRows = () => outstanding
    .map(i => ({ date: i.issueDate, type: 'Invoice', source: byId('clients', i.clientId)?.name || '', ref: i.number || '', eur: toEUR(i.total, i.currency, i.issueDate) }))
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  const wrapper = el('div', { class: 'mb-16' });

  // ── Composite cards row ──────────────────────────────────────────────────────
  const compGrid = el('div', { style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:12px;margin-bottom:12px' });

  compGrid.appendChild(compositeKpiCard({
    label: 'Total Revenue', value: formatEUR(total),
    delta: dTotal, compLabel: cl,
    onClick: () => drillDownModal('All Revenue', drillRevRows(payments, invoices), REV_COLS),
    lines: [
      { label: 'Rental',   value: formatEUR(propRev), pct: pct(propRev, total),
        onClick: () => drillDownModal('Rental Revenue',  drillRevRows(payments, []), REV_COLS) },
      { label: 'Services', value: formatEUR(svcRev),  pct: pct(svcRev,  total),
        onClick: () => drillDownModal('Service Revenue', drillRevRows([], invoices), REV_COLS) },
    ]
  }));

  compGrid.appendChild(compositeKpiCard({
    label: 'Service Revenue', value: formatEUR(svcRev),
    delta: dService, compLabel: cl,
    onClick: () => drillDownModal('Service Revenue', drillRevRows([], invoices), REV_COLS),
    lines: [
      { label: 'Customer Success',   value: formatEUR(csRev),  pct: pct(csRev,  svcRev),
        onClick: () => drillDownModal('Customer Success',   drillRevRows([], invoices.filter(i => i.stream === 'customer_success')),   REV_COLS) },
      { label: 'Marketing Services', value: formatEUR(mktRev), pct: pct(mktRev, svcRev),
        onClick: () => drillDownModal('Marketing Services', drillRevRows([], invoices.filter(i => i.stream === 'marketing_services')), REV_COLS) },
    ]
  }));

  compGrid.appendChild(compositeKpiCard({
    label: 'Rental Revenue', value: formatEUR(propRev),
    delta: dRental, compLabel: cl,
    onClick: () => drillDownModal('Rental Revenue', drillRevRows(payments, []), REV_COLS),
    lines: [
      { label: 'Short-term', value: formatEUR(stRev), pct: pct(stRev, propRev),
        onClick: () => drillDownModal('Short-term Rental', drillRevRows(payments.filter(p => p.stream === 'short_term_rental'), []), REV_COLS) },
      { label: 'Long-term',  value: formatEUR(ltRev), pct: pct(ltRev, propRev),
        onClick: () => drillDownModal('Long-term Rental',  drillRevRows(payments.filter(p => p.stream === 'long_term_rental'),  []), REV_COLS) },
    ]
  }));

  compGrid.appendChild(compositeKpiCard({
    label: 'Top Contributor', value: contribs[0]?.name || '—',
    delta: null, compLabel: '',
    onClick: () => drillDownModal('Revenue Concentration',
      contribs.map(c => ({ type: c.type, name: c.name, eur: c.val })),
      [{ key: 'type', label: 'Type' }, { key: 'name', label: 'Name' }, { key: 'eur', label: 'EUR', right: true, format: v => formatEUR(v) }]),
    lines: contribs.slice(0, 3).map((c, i) => ({
      label: `#${i + 1} ${c.type}`, value: c.name, pct: pct(c.val, total),
    }))
  }));

  compGrid.appendChild(kpiCard({
    label: 'Collection Rate', value: collRate !== null ? collRate.toFixed(1) + '%' : 'N/A',
    subtitle: 'Paid / (Paid + Outstanding)',
    variant: collRate !== null && collRate < 70 ? 'warning' : (collRate === 100 ? 'success' : ''),
    onClick: () => drillDownModal('Outstanding Invoices', outstandingRows(), REV_COLS)
  }));
  compGrid.appendChild(kpiCard({
    label: 'Outstanding Revenue', value: formatEUR(outstandingTotal),
    variant: outstandingTotal > 0 ? 'warning' : '',
    delta: dOutstanding, invertDelta: true, compLabel: cl,
    onClick: () => drillDownModal('Outstanding Revenue', outstandingRows(), REV_COLS)
  }));
  compGrid.appendChild(kpiCard({
    label: 'Avg / Property', value: avgPerProp !== null ? formatEUR(avgPerProp) : 'N/A',
    subtitle: activePropIds.size > 0 ? `${activePropIds.size} propert${activePropIds.size > 1 ? 'ies' : 'y'} active` : '',
    delta: dAvgProp, compLabel: cl,
    onClick: () => {
      const map = new Map();
      payments.forEach(p => map.set(p.propertyId, { name: byId('properties', p.propertyId)?.name || 'Unknown', eur: (map.get(p.propertyId)?.eur || 0) + toEUR(p.amount, p.currency, p.date) }));
      drillDownModal('Revenue per Property', [...map.values()].sort((a, b) => b.eur - a.eur),
        [{ key: 'name', label: 'Property' }, { key: 'eur', label: 'EUR', right: true, format: v => formatEUR(v) }]);
    }
  }));
  compGrid.appendChild(kpiCard({
    label: 'Avg / Client', value: avgPerClient !== null ? formatEUR(avgPerClient) : 'N/A',
    subtitle: activeClientIds.size > 0 ? `${activeClientIds.size} client${activeClientIds.size > 1 ? 's' : ''} active` : '',
    delta: dAvgClient, compLabel: cl,
    onClick: () => {
      const map = new Map();
      invoices.forEach(i => map.set(i.clientId, { name: byId('clients', i.clientId)?.name || 'Unknown', eur: (map.get(i.clientId)?.eur || 0) + toEUR(i.total, i.currency, i.issueDate) }));
      drillDownModal('Revenue per Client', [...map.values()].sort((a, b) => b.eur - a.eur),
        [{ key: 'name', label: 'Client' }, { key: 'eur', label: 'EUR', right: true, format: v => formatEUR(v) }]);
    }
  }));

  wrapper.appendChild(compGrid);
  return wrapper;
}

// ── Revenue Performance Insights ──────────────────────────────────────────────
function buildRevenueInsights(curData, cmpData, cmpRange) {
  const { payments, invoices, outstanding, propRev, svcRev, total, outstandingTotal } = curData;

  const section = el('div', { class: 'card mb-16' });
  section.appendChild(el('div', { class: 'card-header' },
    el('div', { class: 'card-title' }, 'Revenue Performance Insights')
  ));
  const body = el('div', { style: 'padding:0 16px 16px;font-size:13px;line-height:1.8' });

  if (total === 0 && outstandingTotal === 0) {
    body.appendChild(el('div', { style: 'color:var(--text-muted)' }, 'No insights available for the selected period.'));
    section.appendChild(body);
    return section;
  }

  const row = el('div', { style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px' });

  const makeBlock = (label, lines) => {
    const block = el('div');
    block.appendChild(el('div', {
      style: 'font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:var(--text-muted);margin-bottom:6px'
    }, label));
    lines.forEach(({ text, onClick }) => {
      const p2 = el('p', { style: 'margin:0' }, text);
      if (onClick) { p2.style.cursor = 'pointer'; p2.title = 'Click for breakdown'; p2.onclick = onClick; }
      block.appendChild(p2);
    });
    return block;
  };

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
    e.rev += toEUR(i.total, i.currency, i.issueDate);
    e.invs.push(i);
    entityMap.set(key, e);
  });
  const topEntity = [...entityMap.values()].sort((a, b) => b.rev - a.rev)[0];
  if (topEntity && total > 0) {
    const pct = (topEntity.rev / total * 100).toFixed(0);
    row.appendChild(makeBlock('Revenue concentration', [{
      text: `Top contributor: ${topEntity.name} — ${formatEUR(topEntity.rev)} (${pct}% of total)`,
      onClick: () => drillDownModal(`Revenue — ${topEntity.name}`,
        drillRevRows(topEntity.pays, topEntity.invs), REV_COLS)
    }]));
  }

  // ── 2. Revenue mix ─────────────────────────────────────────────────────────
  if (total > 0) {
    const rentalPct = (propRev / total * 100).toFixed(0);
    const svcPct    = (svcRev   / total * 100).toFixed(0);
    row.appendChild(makeBlock('Revenue mix', [
      {
        text: `Rental: ${rentalPct}% (${formatEUR(propRev)})`,
        onClick: propRev > 0
          ? () => drillDownModal('Rental Revenue', drillRevRows(payments, []), REV_COLS)
          : null
      },
      {
        text: `Service: ${svcPct}% (${formatEUR(svcRev)})`,
        onClick: svcRev > 0
          ? () => drillDownModal('Service Revenue', drillRevRows([], invoices), REV_COLS)
          : null
      }
    ]));
  }

  // ── 3. Growth signal ───────────────────────────────────────────────────────
  {
    const lines = [];
    if (cmpData && cmpRange) {
      const delta = safePct(total, cmpData.total);
      if (delta === null) {
        lines.push({ text: `No comparison revenue data for ${cmpRange.label}.` });
      } else {
        const word = delta > 1 ? 'up' : delta < -1 ? 'down' : 'stable';
        const sign = delta > 0 ? '+' : '';
        lines.push({
          text: `Revenue ${word} ${sign}${delta.toFixed(1)}% vs ${cmpRange.label}`,
          onClick: () => drillDownModal('All Revenue', drillRevRows(payments, invoices), REV_COLS)
        });
        lines.push({ text: `${formatEUR(cmpData.total)} → ${formatEUR(total)}` });
      }
    } else {
      lines.push({ text: 'No comparison period selected.' });
    }
    row.appendChild(makeBlock('Growth signal', lines));
  }

  // ── 4. Outstanding revenue signal ──────────────────────────────────────────
  {
    const invoicedTotal = svcRev + outstandingTotal;
    const lines = [];
    if (outstandingTotal > 0 && invoicedTotal > 0) {
      const pct    = (outstandingTotal / invoicedTotal * 100).toFixed(0);
      const isRisk = outstandingTotal / invoicedTotal > 0.3;
      lines.push({
        text: `${formatEUR(outstandingTotal)} outstanding — ${pct}% of invoiced${isRisk ? ' · High risk' : ''}`,
        onClick: () => drillDownModal('Outstanding Revenue',
          outstanding.map(i => ({
            date: i.issueDate, type: 'Invoice',
            source: byId('clients', i.clientId)?.name || '',
            ref: i.number || '',
            eur: toEUR(i.total, i.currency, i.issueDate)
          })).sort((a, b) => (b.date || '').localeCompare(a.date || '')),
          REV_COLS)
      });
      if (svcRev === 0)
        lines.push({ text: 'No service revenue collected yet for this period.' });
    } else if (invoicedTotal > 0) {
      lines.push({ text: 'All invoiced service revenue has been collected.' });
    } else {
      lines.push({ text: 'No service invoices for the selected period.' });
    }
    row.appendChild(makeBlock('Outstanding signal', lines));
  }

  body.appendChild(row);
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

function renderTrend({ payments, invoices }, months) {
  const data = months.map(m => {
    const p = payments.filter(x => x.date?.slice(0, 7) === m.key).reduce((s, x) => s + toEUR(x.amount, x.currency, x.date), 0);
    const i = invoices.filter(x => (x.issueDate || '').slice(0, 7) === m.key).reduce((s, x) => s + toEUR(x.total, x.currency, x.issueDate), 0);
    return Math.round(p + i);
  });
  if (!data.some(v => v > 0)) return;
  charts.line('rev-trend', {
    labels: months.map(m => m.label),
    datasets: [{ label: 'Revenue', data, borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,0.08)', fill: true }],
    onClickItem: (_, idx) => {
      const mk = months[idx]?.key;
      if (!mk) return;
      drillDownModal(`${months[idx].label} — Revenue`,
        drillRevRows(payments.filter(p => p.date?.slice(0, 7) === mk), invoices.filter(i => (i.issueDate || '').slice(0, 7) === mk)),
        REV_COLS);
    }
  });
}

function renderStreamBar({ payments, invoices }, months) {
  const smMap = new Map();
  const add   = (sk, mk, eur) => { if (!smMap.has(sk)) smMap.set(sk, new Map()); const m = smMap.get(sk); m.set(mk, (m.get(mk) || 0) + eur); };
  payments.forEach(p => { const mk = p.date?.slice(0, 7); if (mk) add(p.stream || 'other', mk, toEUR(p.amount, p.currency, p.date)); });
  invoices.forEach(i => { const mk = (i.issueDate || '').slice(0, 7); if (mk) add(i.stream || 'other', mk, toEUR(i.total, i.currency, i.issueDate)); });
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
      drillDownModal(`${label} — ${STREAMS[sk]?.label || sk}`,
        drillRevRows(payments.filter(p => p.date?.slice(0, 7) === mk && (p.stream || 'other') === sk),
                     invoices.filter(i => (i.issueDate || '').slice(0, 7) === mk && (i.stream || 'other') === sk)),
        REV_COLS);
    }
  });
}

function renderOwnerDonut({ payments, invoices }) {
  const owMap = new Map();
  payments.forEach(p => { const ow = byId('properties', p.propertyId)?.owner || 'both'; owMap.set(ow, (owMap.get(ow) || 0) + toEUR(p.amount, p.currency, p.date)); });
  invoices.forEach(i => { const ow = i.owner || 'both'; owMap.set(ow, (owMap.get(ow) || 0) + toEUR(i.total, i.currency, i.issueDate)); });
  const keys = Object.keys(OWNERS).filter(k => (owMap.get(k) || 0) > 0);
  if (!keys.length) return;
  charts.doughnut('rev-owner-donut', {
    labels: keys.map(k => OWNERS[k]),
    data:   keys.map(k => Math.round(owMap.get(k) || 0)),
    colors: keys.map(k => OWNER_COLORS[k] || '#8b93b0'),
    onClickItem: (_, idx) => {
      const ok = keys[idx];
      drillDownModal(`Revenue — ${OWNERS[ok]}`,
        drillRevRows(payments.filter(p => (byId('properties', p.propertyId)?.owner || 'both') === ok),
                     invoices.filter(i => (i.owner || 'both') === ok)),
        REV_COLS);
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
      drillDownModal(`Revenue — ${entry.name}`, drillRevRows(payments.filter(p => p.propertyId === id), []), REV_COLS);
    }
  });
}

function renderClientBar({ invoices }) {
  const map = new Map();
  invoices.forEach(i => map.set(i.clientId, { name: byId('clients', i.clientId)?.name || 'Unknown', eur: (map.get(i.clientId)?.eur || 0) + toEUR(i.total, i.currency, i.issueDate) }));
  const sorted = [...map.entries()].sort((a, b) => b[1].eur - a[1].eur);
  if (!sorted.length) return;
  charts.bar('rev-client-bar', {
    labels: sorted.map(([, m]) => m.name),
    datasets: [{ label: 'Revenue (EUR)', data: sorted.map(([, m]) => Math.round(m.eur)), backgroundColor: sorted.map((_, i) => `hsla(${(160 + i * 35) % 360},65%,55%,0.85)`) }],
    horizontal: true,
    onClickItem: (_, idx) => {
      const [id, entry] = sorted[idx];
      drillDownModal(`Revenue — ${entry.name}`, drillRevRows([], invoices.filter(i => i.clientId === id)), REV_COLS);
    }
  });
}

function renderMixEvolution({ payments, invoices }, months) {
  const rental  = months.map(m => Math.round(payments.filter(p => p.date?.slice(0, 7) === m.key).reduce((s, p) => s + toEUR(p.amount, p.currency, p.date), 0)));
  const service = months.map(m => Math.round(invoices.filter(i => (i.issueDate || '').slice(0, 7) === m.key).reduce((s, i) => s + toEUR(i.total, i.currency, i.issueDate), 0)));
  if (!rental.some(v => v > 0) && !service.some(v => v > 0)) return;
  charts.bar('rev-mix-evolution', {
    labels: months.map(m => m.label),
    datasets: [
      { label: 'Rental',  data: rental,  backgroundColor: '#6366f1' },
      { label: 'Service', data: service, backgroundColor: '#10b981' }
    ],
    stacked: true,
    onClickItem: (_, idx) => {
      const mk = months[idx]?.key;
      if (!mk) return;
      drillDownModal(`${months[idx].label} — Revenue Mix`,
        drillRevRows(payments.filter(p => p.date?.slice(0, 7) === mk), invoices.filter(i => (i.issueDate || '').slice(0, 7) === mk)),
        REV_COLS);
    }
  });
}

function renderGrowthTrend({ payments, invoices }, months) {
  const totals = months.map(m => {
    const p = payments.filter(x => x.date?.slice(0, 7) === m.key).reduce((s, x) => s + toEUR(x.amount, x.currency, x.date), 0);
    const i = invoices.filter(x => (x.issueDate || '').slice(0, 7) === m.key).reduce((s, x) => s + toEUR(x.total, x.currency, x.issueDate), 0);
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
      const mk = months[idx]?.key;
      if (!mk) return;
      drillDownModal(`${months[idx].label} — Revenue`,
        drillRevRows(payments.filter(p => p.date?.slice(0, 7) === mk), invoices.filter(i => (i.issueDate || '').slice(0, 7) === mk)),
        REV_COLS);
    }
  });
}

function renderPaidOutstanding({ invoices }, months, start, end) {
  const { mStream, mOwner, mClient } = makeMatchers(gF);
  const allOut = gF.propertyIds.size > 0 ? [] : listActive('invoices').filter(i =>
    !['paid', 'cancelled', 'void'].includes(i.status) &&
    i.issueDate && i.issueDate >= start && i.issueDate <= end &&
    mStream(i) && mOwner(i) && mClient(i)
  );
  const paidData = months.map(m => Math.round(invoices.filter(i => (i.issueDate || '').slice(0, 7) === m.key).reduce((s, i) => s + toEUR(i.total, i.currency, i.issueDate), 0)));
  const outData  = months.map(m => Math.round(allOut.filter(i => (i.issueDate || '').slice(0, 7) === m.key).reduce((s, i) => s + toEUR(i.total, i.currency, i.issueDate), 0)));
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
      if (dsIdx === 0) {
        drillDownModal(`${months[idx].label} — Paid`, drillRevRows([], invoices.filter(i => (i.issueDate || '').slice(0, 7) === mk)), REV_COLS);
      } else {
        const rows = allOut.filter(i => (i.issueDate || '').slice(0, 7) === mk).map(i => ({
          date: i.issueDate, type: 'Invoice', source: byId('clients', i.clientId)?.name || '', ref: i.number || '', eur: toEUR(i.total, i.currency, i.issueDate)
        }));
        drillDownModal(`${months[idx].label} — Outstanding`, rows, REV_COLS);
      }
    }
  });
}

function renderConcentration({ payments, invoices }) {
  const cMap = new Map();
  payments.forEach(p => { const k = 'p:' + p.propertyId; cMap.set(k, { name: byId('properties', p.propertyId)?.name || 'Unknown', eur: (cMap.get(k)?.eur || 0) + toEUR(p.amount, p.currency, p.date), id: p.propertyId, isPay: true }); });
  invoices.forEach(i => { const k = 'c:' + i.clientId;   cMap.set(k, { name: byId('clients', i.clientId)?.name || 'Unknown', eur: (cMap.get(k)?.eur || 0) + toEUR(i.total, i.currency, i.issueDate), id: i.clientId,   isPay: false }); });
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
      if (idx >= top5.length) return;
      const e = top5[idx];
      drillDownModal(`Revenue — ${e.name}`,
        e.isPay ? drillRevRows(payments.filter(p => p.propertyId === e.id), [])
                : drillRevRows([], invoices.filter(i => i.clientId === e.id)),
        REV_COLS);
    }
  });
}

function renderAging({ outstanding }) {
  if (!outstanding.length) return;
  const today   = new Date().toISOString().slice(0, 10);
  const buckets = [0, 0, 0, 0];
  const items   = [[], [], [], []];
  outstanding.forEach(i => {
    const days = Math.floor((new Date(today) - new Date(i.issueDate || today)) / 86400000);
    const b    = days <= 30 ? 0 : days <= 60 ? 1 : days <= 90 ? 2 : 3;
    buckets[b] += toEUR(i.total, i.currency, i.issueDate);
    items[b].push(i);
  });
  if (!buckets.some(v => v > 0)) return;
  charts.bar('rev-aging', {
    labels:   ['0–30 days', '31–60 days', '61–90 days', '90+ days'],
    datasets: [{ label: 'Outstanding (EUR)', data: buckets.map(Math.round), backgroundColor: ['#10b981', '#f59e0b', '#f97316', '#ef4444'] }],
    onClickItem: (label, idx) => {
      const rows = items[idx].map(i => ({ date: i.issueDate, type: 'Invoice', source: byId('clients', i.clientId)?.name || '', ref: i.number || '', eur: toEUR(i.total, i.currency, i.issueDate) }));
      drillDownModal(`Outstanding — ${label}`, rows, REV_COLS);
    }
  });
}

// ── Seasonality heatmap (DOM table, shows all available years for context) ────
function buildSeasonalityHeatmap() {
  const { mStream, mOwner, mProperty, mClient } = makeMatchers(gF);
  const pays = listActivePayments().filter(p => p.status === 'paid' && mStream(p) && mOwner(p) && mProperty(p));
  const invs = gF.propertyIds.size > 0 ? [] : listActive('invoices').filter(i => i.status === 'paid' && mStream(i) && mOwner(i) && mClient(i));
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
  htr.appendChild(el('th', { style: 'text-align:left;padding:4px 8px;color:var(--text-muted)' }, 'Year'));
  MONTH_LABELS.forEach(ml => htr.appendChild(el('th', { style: 'padding:4px 6px;text-align:right;color:var(--text-muted)' }, ml)));
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
          drillDownModal(`${MONTH_LABELS[capturedMi]} ${y} — Revenue`,
            drillRevRows(pays.filter(p => p.date?.slice(0, 7) === capturedKey), invs.filter(i => i.issueDate?.slice(0, 7) === capturedKey)),
            REV_COLS);
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
  { key: 'date',      label: 'Date'        },
  { key: 'stream',    label: 'Stream'      },
  { key: 'entity',    label: 'Entity'      },
  { key: 'owner',     label: 'Owner'       },
  { key: 'status',    label: 'Status'      },
  { key: 'amountEUR', label: 'Amount EUR', right: true }
];

function buildRevenueTable(container, { payments, invoices }) {
  const rows = [];
  payments.forEach(p => {
    const prop = byId('properties', p.propertyId);
    rows.push({ _date: p.date, _eur: toEUR(p.amount, p.currency, p.date), date: fmtDate(p.date), stream: STREAMS[p.stream]?.short || p.stream || '—', entity: prop?.name || '—', owner: OWNERS[prop?.owner] || prop?.owner || '—', status: p.status || '—', amountEUR: formatEUR(toEUR(p.amount, p.currency, p.date)) });
  });
  invoices.forEach(i => {
    const client = byId('clients', i.clientId);
    rows.push({ _date: i.issueDate, _eur: toEUR(i.total, i.currency, i.issueDate), date: fmtDate(i.issueDate), stream: STREAMS[i.stream]?.short || i.stream || '—', entity: client?.name || '—', owner: OWNERS[client?.owner] || client?.owner || '—', status: i.status || '—', amountEUR: formatEUR(toEUR(i.total, i.currency, i.issueDate)) });
  });
  rows.sort((a, b) => (b._date || '').localeCompare(a._date || ''));

  const table = el('table', { class: 'table' });
  const htr   = el('tr');
  TX_COLS.forEach(col => htr.appendChild(el('th', { class: col.right ? 'right' : '' }, col.label)));
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
  attachSortFilter(wrap);
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

  wrap.appendChild(buildFilterBar(gF, { showOwner: true, showStream: true, showProperty: true, showClient: true, storagePrefix: 'rev' }, (newGF) => { if (newGF) gF = newGF; rebuildView(); }));

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

  // Row 3: Property + Client
  const row3 = el('div', { class: 'grid grid-2 mb-16' });
  row3.appendChild(el('div', { class: 'card' },
    el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'Revenue by Property')),
    el('div', { class: 'chart-wrap tall' }, el('canvas', { id: 'rev-prop-bar' }))
  ));
  row3.appendChild(el('div', { class: 'card' },
    el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'Revenue by Client')),
    el('div', { class: 'chart-wrap tall' }, el('canvas', { id: 'rev-client-bar' }))
  ));
  wrap.appendChild(row3);

  // Row 4: Concentration + Owner
  const row4 = el('div', { class: 'grid grid-2 mb-16' });
  {
    const btn1 = el('button', { style: 'background:none;border:1px solid var(--border);border-radius:4px;color:var(--text-muted);font-size:11px;cursor:pointer;padding:2px 6px;line-height:1' }, '%');
    btn1.onclick = () => { const sp = charts.toggleDoughnutPct('rev-concentration'); btn1.textContent = sp ? '€' : '%'; };
    row4.appendChild(el('div', { class: 'card' },
      el('div', { class: 'card-header', style: 'display:flex;align-items:center;justify-content:space-between' },
        el('div', { class: 'card-title' }, 'Revenue Concentration (Top 5)'), btn1),
      el('div', { class: 'chart-wrap tall' }, el('canvas', { id: 'rev-concentration' }))
    ));
  }
  {
    const btn2 = el('button', { style: 'background:none;border:1px solid var(--border);border-radius:4px;color:var(--text-muted);font-size:11px;cursor:pointer;padding:2px 6px;line-height:1' }, '%');
    btn2.onclick = () => { const sp = charts.toggleDoughnutPct('rev-owner-donut'); btn2.textContent = sp ? '€' : '%'; };
    row4.appendChild(el('div', { class: 'card' },
      el('div', { class: 'card-header', style: 'display:flex;align-items:center;justify-content:space-between' },
        el('div', { class: 'card-title' }, 'Revenue by Owner'), btn2),
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

  setTimeout(() => {
    renderTrend(curData, months);
    renderStreamBar(curData, months);
    renderMixEvolution(curData, months);
    renderGrowthTrend(curData, months);
    renderPropBar(curData);
    renderClientBar(curData);
    renderConcentration(curData);
    renderOwnerDonut(curData);
    renderPaidOutstanding(curData, months, curRange.start, curRange.end);
    renderAging(curData);
  }, 0);

  return wrap;
}
