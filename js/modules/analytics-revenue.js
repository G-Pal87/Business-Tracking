// Revenue Analytics Dashboard — structure · growth · collections · contributors · dynamics
import { el, buildMultiSelect, button, fmtDate, drillDownModal, attachSortFilter } from '../core/ui.js';
import * as charts from '../core/charts.js';
import { STREAMS, OWNERS } from '../core/config.js';
import {
  availableYears, formatEUR, toEUR, byId,
  listActive, listActivePayments, listActiveClients,
  drillRevRows
} from '../core/data.js';

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
const SELECT_STYLE = 'background:var(--bg-elev-1);border:1px solid var(--border);border-radius:var(--radius-sm);padding:6px 10px;font-size:12px;color:var(--text);cursor:pointer';

// ── Filter state ──────────────────────────────────────────────────────────────
let gF = {
  period:       'ytd',
  customYear:   String(new Date().getFullYear()),
  customMonths: new Set(),
  owners:       new Set(),
  streams:      new Set(),
  propertyIds:  new Set(),
  clientIds:    new Set(),
  compareTo:    'prev-year',
};

// ── Module export ─────────────────────────────────────────────────────────────
export default {
  id: 'analytics-revenue', label: 'Revenue', icon: '₊',
  render(container) { container.appendChild(buildView()); },
  refresh() { rebuildView(); },
  destroy() { CHART_IDS.forEach(id => charts.destroy(id)); }
};

// ── Period range ──────────────────────────────────────────────────────────────
function getCurrentPeriodRange() {
  const now   = new Date();
  const today = now.toISOString().slice(0, 10);
  const y     = now.getFullYear();
  const m     = now.getMonth(); // 0-based
  const d     = now.getDate();

  if (gF.period === 'ytd')
    return { start: `${y}-01-01`, end: today, label: `YTD ${y}`, isIncomplete: true };

  if (gF.period === 'this-month') {
    const mm = String(m + 1).padStart(2, '0');
    const lastDay = new Date(y, m + 1, 0).getDate();
    return { start: `${y}-${mm}-01`, end: today, label: `${MONTH_LABELS[m]} ${y}`, isIncomplete: d < lastDay };
  }
  if (gF.period === 'this-quarter') {
    const qs = Math.floor(m / 3) * 3;
    return { start: `${y}-${String(qs + 1).padStart(2, '0')}-01`, end: today, label: `Q${Math.floor(m / 3) + 1} ${y}`, isIncomplete: true };
  }
  if (gF.period === 'this-year') {
    const end = `${y}-12-31`;
    return { start: `${y}-01-01`, end, label: String(y), isIncomplete: today < end };
  }
  if (gF.period === 'last-year') {
    const ly = y - 1;
    return { start: `${ly}-01-01`, end: `${ly}-12-31`, label: String(ly), isIncomplete: false };
  }
  if (gF.period === 'custom') {
    const cy = gF.customYear;
    if (gF.customMonths.size === 0) {
      const isThisYear = cy === String(y);
      return { start: `${cy}-01-01`, end: isThisYear ? today : `${cy}-12-31`, label: cy, isIncomplete: isThisYear };
    }
    const sorted  = [...gF.customMonths].map(Number).sort((a, b) => a - b);
    const firstM  = sorted[0], lastM = sorted[sorted.length - 1];
    const start   = `${cy}-${String(firstM).padStart(2, '0')}-01`;
    const lastDay = new Date(Number(cy), lastM, 0).getDate();
    const end     = `${cy}-${String(lastM).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
    return { start, end, label: sorted.map(n => MONTH_LABELS[n - 1]).join(', ') + ' ' + cy, isIncomplete: false };
  }
  return { start: `${y}-01-01`, end: today, label: `YTD ${y}`, isIncomplete: true };
}

function getComparisonRange(cur) {
  if (gF.compareTo === 'none') return null;
  const addYears = (s, n) => { const dt = new Date(s); dt.setFullYear(dt.getFullYear() + n); return dt.toISOString().slice(0, 10); };

  if (gF.compareTo === 'prev-period') {
    const durMs   = new Date(cur.end) - new Date(cur.start);
    const newEnd  = new Date(new Date(cur.start) - 86400000);
    const newStart= new Date(newEnd - durMs);
    const fmt     = dt => dt.toISOString().slice(0, 10);
    return { start: fmt(newStart), end: fmt(newEnd), label: 'Prev Period' };
  }
  if (gF.compareTo === 'last-month') {
    const now = new Date();
    const lm  = now.getMonth() === 0 ? 12 : now.getMonth();
    const ly  = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
    const lmStr = String(lm).padStart(2, '0');
    return { start: `${ly}-${lmStr}-01`, end: `${ly}-${lmStr}-${new Date(ly, lm, 0).getDate()}`, label: `${MONTH_LABELS[lm - 1]} ${ly}` };
  }
  if (gF.compareTo === 'last-quarter') {
    const now  = new Date();
    const cq   = Math.floor(now.getMonth() / 3);
    const pq   = cq === 0 ? 3 : cq - 1;
    const py   = cq === 0 ? now.getFullYear() - 1 : now.getFullYear();
    const qsm  = pq * 3 + 1, qem = qsm + 2;
    const qsmS = String(qsm).padStart(2, '0'), qemS = String(qem).padStart(2, '0');
    return { start: `${py}-${qsmS}-01`, end: `${py}-${qemS}-${new Date(py, qem, 0).getDate()}`, label: `Q${pq + 1} ${py}` };
  }
  if (gF.compareTo === 'same-period-last-year')
    return { start: addYears(cur.start, -1), end: addYears(cur.end, -1), label: 'Same Period LY' };
  if (gF.compareTo === 'prev-year') {
    const py  = new Date(cur.start).getFullYear() - 1;
    const end = cur.isIncomplete ? addYears(cur.end, -1) : `${py}-12-31`;
    return { start: `${py}-01-01`, end, label: String(py) };
  }
  if (gF.compareTo === 'last-year') {
    const ly = new Date().getFullYear() - 1;
    return { start: `${ly}-01-01`, end: `${ly}-12-31`, label: String(ly) };
  }
  return null;
}

// ── Month keys for range ──────────────────────────────────────────────────────
function getMonthKeysForRange(start, end) {
  const sy = parseInt(start.slice(0, 4)), sm = parseInt(start.slice(5, 7));
  const ey = parseInt(end.slice(0, 4)),   em = parseInt(end.slice(5, 7));
  const isSingleYear = sy === ey;
  const keys = [];
  let y = sy, m = sm;
  while (y < ey || (y === ey && m <= em)) {
    const mm    = String(m).padStart(2, '0');
    const label = isSingleYear ? MONTH_LABELS[m - 1] : `${MONTH_LABELS[m - 1]} '${String(y).slice(2)}`;
    keys.push({ key: `${y}-${mm}`, label, y: String(y), m });
    if (++m > 12) { m = 1; y++; }
  }
  return { keys, isSingleYear };
}

// ── Filter matchers ───────────────────────────────────────────────────────────
function resolveStream(row) {
  if (row.stream) return row.stream;
  if (row.propertyId) {
    const p = byId('properties', row.propertyId);
    if (p?.type === 'short_term') return 'short_term_rental';
    if (p?.type === 'long_term')  return 'long_term_rental';
  }
  return null;
}
const mStream   = row => { if (!gF.streams.size) return true; const s = resolveStream(row); return !s || gF.streams.has(s); };
const mOwner    = row => {
  if (!gF.owners.size) return true;
  const ow = row.propertyId ? (byId('properties', row.propertyId)?.owner || 'both') : (row.owner || 'both');
  return ow === 'both' || gF.owners.has(ow);
};
const mProperty = row => { if (!gF.propertyIds.size) return true; if (!row.propertyId) return false; return gF.propertyIds.has(row.propertyId); };
const mClient   = row => { if (!gF.clientIds.size) return true; if (!row.clientId) return false; return gF.clientIds.has(row.clientId); };

// ── Data ──────────────────────────────────────────────────────────────────────
function getData(start, end) {
  const inRange = d => d && d >= start && d <= end;

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

// ── KPI section ───────────────────────────────────────────────────────────────
function buildKpiSection(cur, cmp, cmpRange) {
  const { payments, invoices, outstanding, propRev, svcRev, total, outstandingTotal } = cur;
  const cl = cmpRange?.label || '';

  const rentalPct  = total > 0 ? propRev / total * 100 : 0;
  const servicePct = total > 0 ? svcRev  / total * 100 : 0;
  const invoicedT  = svcRev + outstandingTotal;
  const collRate   = invoicedT > 0 ? svcRev / invoicedT * 100 : null;

  const activePropIds   = new Set(payments.map(p => p.propertyId).filter(Boolean));
  const activeClientIds = new Set(invoices.map(i => i.clientId).filter(Boolean));
  const avgPerProp      = activePropIds.size   > 0 ? propRev / activePropIds.size   : null;
  const avgPerClient    = activeClientIds.size > 0 ? svcRev  / activeClientIds.size : null;

  // Top contributor (property or client)
  let topC = null;
  {
    const pMap = new Map(), iMap = new Map();
    payments.forEach(p => pMap.set(p.propertyId, (pMap.get(p.propertyId) || 0) + toEUR(p.amount, p.currency, p.date)));
    invoices.forEach(i => iMap.set(i.clientId,   (iMap.get(i.clientId)   || 0) + toEUR(i.total, i.currency, i.issueDate)));
    let best = { val: 0, name: '' };
    pMap.forEach((v, id) => { if (v > best.val) best = { val: v, name: byId('properties', id)?.name || 'Unknown' }; });
    iMap.forEach((v, id) => { if (v > best.val) best = { val: v, name: byId('clients',    id)?.name || 'Unknown' }; });
    if (best.name && total > 0) topC = { name: best.name, pct: best.val / total * 100 };
  }

  // Comparison deltas
  let dTotal, dRental, dService, dMix, dOutstanding, dAvgProp, dAvgClient;
  if (cmp) {
    dTotal       = safePct(total,          cmp.total);
    dRental      = safePct(propRev,        cmp.propRev);
    dService     = safePct(svcRev,         cmp.svcRev);
    dMix         = cmp.total > 0 ? rentalPct - (cmp.propRev / cmp.total * 100) : null;
    dOutstanding = safePct(outstandingTotal, cmp.outstandingTotal);
    const cmpPropIds   = new Set(cmp.payments.map(p => p.propertyId).filter(Boolean));
    const cmpClientIds = new Set(cmp.invoices.map(i => i.clientId).filter(Boolean));
    dAvgProp   = safePct(avgPerProp,   cmpPropIds.size   > 0 ? cmp.propRev / cmpPropIds.size   : null);
    dAvgClient = safePct(avgPerClient, cmpClientIds.size > 0 ? cmp.svcRev  / cmpClientIds.size : null);
  }

  const grid = el('div', { class: 'mb-16', style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:12px' });

  grid.appendChild(kpiCard({
    label: 'Total Revenue', value: formatEUR(total),
    delta: dTotal, compLabel: cl,
    onClick: () => drillDownModal('All Revenue', drillRevRows(payments, invoices), REV_COLS)
  }));
  grid.appendChild(kpiCard({
    label: 'Rental Revenue', value: formatEUR(propRev),
    delta: dRental, compLabel: cl,
    onClick: () => drillDownModal('Rental Revenue', drillRevRows(payments, []), REV_COLS)
  }));
  grid.appendChild(kpiCard({
    label: 'Service Revenue', value: formatEUR(svcRev),
    delta: dService, compLabel: cl,
    onClick: () => drillDownModal('Service Revenue', drillRevRows([], invoices), REV_COLS)
  }));
  grid.appendChild(kpiCard({
    label: 'Revenue Mix', value: `${rentalPct.toFixed(0)}% / ${servicePct.toFixed(0)}%`,
    subtitle: 'Rental / Service',
    delta: dMix, deltaIsPp: true, compLabel: cl,
    onClick: () => drillDownModal('Revenue Mix',
      [{ seg: 'Rental',  amt: formatEUR(propRev), pct: rentalPct.toFixed(1)  + '%' },
       { seg: 'Service', amt: formatEUR(svcRev),  pct: servicePct.toFixed(1) + '%' }],
      [{ key: 'seg', label: 'Segment' }, { key: 'amt', label: 'Amount', right: true }, { key: 'pct', label: '%', right: true }])
  }));
  grid.appendChild(kpiCard({
    label: 'Collection Rate', value: collRate !== null ? collRate.toFixed(1) + '%' : 'N/A',
    subtitle: 'Paid / (Paid + Outstanding)',
    variant: collRate !== null && collRate < 70 ? 'warning' : (collRate === 100 ? 'success' : ''),
    onClick: () => drillDownModal('Outstanding Invoices',
      outstanding.map(i => ({ date: i.issueDate, type: 'Invoice', source: byId('clients', i.clientId)?.name || '', ref: i.number || '', eur: toEUR(i.total, i.currency, i.issueDate) }))
        .sort((a, b) => (b.date || '').localeCompare(a.date || '')),
      REV_COLS)
  }));
  grid.appendChild(kpiCard({
    label: 'Outstanding Revenue', value: formatEUR(outstandingTotal),
    variant: outstandingTotal > 0 ? 'warning' : '',
    delta: dOutstanding, invertDelta: true, compLabel: cl,
    onClick: () => drillDownModal('Outstanding Revenue',
      outstanding.map(i => ({ date: i.issueDate, type: 'Invoice', source: byId('clients', i.clientId)?.name || '', ref: i.number || '', eur: toEUR(i.total, i.currency, i.issueDate) }))
        .sort((a, b) => (b.date || '').localeCompare(a.date || '')),
      REV_COLS)
  }));
  grid.appendChild(kpiCard({
    label: 'Top Contributor', value: topC ? topC.name : '—',
    subtitle: topC ? `${topC.pct.toFixed(0)}% of revenue` : 'No data',
    onClick: () => {
      const pMap = new Map(), iMap = new Map();
      payments.forEach(p => pMap.set(p.propertyId, { name: byId('properties', p.propertyId)?.name || 'Unknown', eur: (pMap.get(p.propertyId)?.eur || 0) + toEUR(p.amount, p.currency, p.date), type: 'Property' }));
      invoices.forEach(i => iMap.set(i.clientId, { name: byId('clients', i.clientId)?.name || 'Unknown', eur: (iMap.get(i.clientId)?.eur || 0) + toEUR(i.total, i.currency, i.issueDate), type: 'Client' }));
      drillDownModal('Revenue Concentration', [...pMap.values(), ...iMap.values()].sort((a, b) => b.eur - a.eur),
        [{ key: 'type', label: 'Type' }, { key: 'name', label: 'Name' }, { key: 'eur', label: 'EUR', right: true, format: v => formatEUR(v) }]);
    }
  }));
  grid.appendChild(kpiCard({
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
  grid.appendChild(kpiCard({
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

  return grid;
}

// ── Filter bar ────────────────────────────────────────────────────────────────
function buildFilterBar() {
  const bar = el('div', { class: 'flex gap-8 mb-16', style: 'flex-wrap:wrap;align-items:center' });

  // Period
  const periodSel = el('select', { style: SELECT_STYLE });
  [['ytd','YTD'],['this-month','This Month'],['this-quarter','This Quarter'],
   ['this-year','This Year'],['last-year','Last Year'],['custom','Custom']
  ].forEach(([v, lbl]) => {
    const opt = el('option', { value: v }, lbl);
    if (gF.period === v) opt.selected = true;
    periodSel.appendChild(opt);
  });
  periodSel.onchange = () => { gF.period = periodSel.value; rebuildView(); };
  bar.appendChild(periodSel);

  // Custom year + months
  if (gF.period === 'custom') {
    const yearSel = el('select', { style: SELECT_STYLE });
    availableYears().forEach(y => {
      const opt = el('option', { value: y }, y);
      if (gF.customYear === y) opt.selected = true;
      yearSel.appendChild(opt);
    });
    yearSel.onchange = () => { gF.customYear = yearSel.value; rebuildView(); };
    bar.appendChild(yearSel);
    bar.appendChild(buildMultiSelect(
      MONTH_LABELS.map((lbl, i) => ({ value: String(i + 1).padStart(2, '0'), label: lbl })),
      gF.customMonths, 'All Months', rebuildView, 'rev_cust_months'
    ));
  }

  // Owner
  bar.appendChild(buildMultiSelect(
    Object.entries(OWNERS).map(([k, v]) => ({ value: k, label: v })),
    gF.owners, 'All Owners', rebuildView, 'rev_owners'
  ));

  // Stream
  bar.appendChild(buildMultiSelect(
    Object.entries(STREAMS).map(([k, v]) => ({ value: k, label: v.label, css: v.css })),
    gF.streams, 'All Streams', rebuildView, 'rev_streams'
  ));

  // Property
  bar.appendChild(buildMultiSelect(
    listActive('properties').map(p => ({ value: p.id, label: p.name })),
    gF.propertyIds, 'All Properties', rebuildView, 'rev_props'
  ));

  // Client
  bar.appendChild(buildMultiSelect(
    listActiveClients().map(c => ({ value: c.id, label: c.name })),
    gF.clientIds, 'All Clients', rebuildView, 'rev_clients'
  ));

  // Compare To
  const cmpSel = el('select', { style: SELECT_STYLE });
  [['prev-year','vs Prev Year'],['same-period-last-year','vs Same Period LY'],
   ['prev-period','vs Prev Period'],['last-month','vs Last Month'],
   ['last-quarter','vs Last Quarter'],['last-year','vs Last Year'],['none','No Comparison']
  ].forEach(([v, lbl]) => {
    const opt = el('option', { value: v }, lbl);
    if (gF.compareTo === v) opt.selected = true;
    cmpSel.appendChild(opt);
  });
  cmpSel.onchange = () => { gF.compareTo = cmpSel.value; rebuildView(); };
  bar.appendChild(cmpSel);

  // Reset
  bar.appendChild(button('Reset', {
    variant: 'sm ghost',
    onClick: () => {
      gF = { period: 'ytd', customYear: String(new Date().getFullYear()), customMonths: new Set(), owners: new Set(), streams: new Set(), propertyIds: new Set(), clientIds: new Set(), compareTo: 'prev-year' };
      rebuildView();
    }
  }));

  return bar;
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

  wrap.appendChild(buildFilterBar());

  const curRange = getCurrentPeriodRange();
  const cmpRange = getComparisonRange(curRange);
  const curData  = getData(curRange.start, curRange.end);
  const cmpData  = cmpRange ? getData(cmpRange.start, cmpRange.end) : null;

  wrap.appendChild(el('div', { style: 'font-size:12px;color:var(--text-muted);margin-bottom:12px' },
    curRange.label + (curRange.isIncomplete ? ' (in progress)' : '') + (cmpRange ? ` · vs ${cmpRange.label}` : '')
  ));

  wrap.appendChild(buildKpiSection(curData, cmpData, cmpRange));

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
  row4.appendChild(el('div', { class: 'card' },
    el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'Revenue Concentration (Top 5)')),
    el('div', { class: 'chart-wrap tall' }, el('canvas', { id: 'rev-concentration' }))
  ));
  row4.appendChild(el('div', { class: 'card' },
    el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'Revenue by Owner')),
    el('div', { class: 'chart-wrap tall' }, el('canvas', { id: 'rev-owner-donut' }))
  ));
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
