// Insights module - cross-stream, YTD, YoY, owner-based
import { state } from '../core/state.js';
import { el, select } from '../core/ui.js';
import * as charts from '../core/charts.js';
import { STREAMS, OWNERS } from '../core/config.js';
import {
  toEUR, formatEUR, availableYears,
  revenueInRangeEUR, expensesInRangeEUR, ytdRange
} from '../core/data.js';

let filters = { year: 'ytd', stream: 'all', owner: 'all' };

export default {
  id: 'insights',
  label: 'Insights',
  icon: 'S',
  render(container) { container.appendChild(build()); renderAll(); },
  refresh() { const c = document.getElementById('content'); c.innerHTML = ''; c.appendChild(build()); renderAll(); },
  destroy() { charts.destroyAll(); }
};

function build() {
  const wrap = el('div', { class: 'view active' });

  const years = availableYears();
  const yearSel = select([
    { value: 'ytd', label: 'Year-to-Date' },
    { value: 'all', label: 'All Time' },
    ...years.map(y => ({ value: y, label: y }))
  ], filters.year);
  const streamSel = select([{ value: 'all', label: 'All Streams' }, ...Object.entries(STREAMS).map(([v, m]) => ({ value: v, label: m.label }))], filters.stream);
  const ownerSel = select([{ value: 'all', label: 'All Owners' }, ...Object.entries(OWNERS).map(([v, l]) => ({ value: v, label: l }))], filters.owner);

  const bar = el('div', { class: 'flex gap-8 mb-16', style: 'flex-wrap:wrap' });
  bar.appendChild(el('span', { class: 'muted', style: 'align-self:center' }, 'Filter:'));
  bar.appendChild(yearSel);
  bar.appendChild(streamSel);
  bar.appendChild(ownerSel);
  wrap.appendChild(bar);

  yearSel.onchange = () => { filters.year = yearSel.value; renderAll(); };
  streamSel.onchange = () => { filters.stream = streamSel.value; renderAll(); };
  ownerSel.onchange = () => { filters.owner = ownerSel.value; renderAll(); };

  wrap.appendChild(el('div', { class: 'grid grid-4', id: 'ins-kpi' }));

  wrap.appendChild(el('div', { class: 'grid grid-2 mt-16' },
    el('div', { class: 'card' },
      el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'P&L by Business Stream')),
      el('div', { class: 'chart-wrap tall' }, el('canvas', { id: 'ins-pl' }))
    ),
    el('div', { class: 'card' },
      el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'Revenue by Owner')),
      el('div', { class: 'chart-wrap tall' }, el('canvas', { id: 'ins-owner' }))
    )
  ));

  wrap.appendChild(el('div', { class: 'card mt-16' },
    el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'Stream Breakdown')),
    el('div', { id: 'ins-stream-table' })
  ));

  return wrap;
}

function computeRange() {
  if (filters.year === 'ytd') return ytdRange();
  if (filters.year === 'all') return { start: '1900-01-01', end: '2999-12-31' };
  return { start: `${filters.year}-01-01`, end: `${filters.year}-12-31` };
}

function matchesFilters(row, { stream, owner } = filters) {
  if (filters.stream !== 'all' && row.stream && row.stream !== filters.stream) return false;
  if (filters.owner !== 'all' && row.owner && row.owner !== filters.owner && row.owner !== 'both') return false;
  return true;
}

function renderAll() {
  const { start, end } = computeRange();

  // Gather filtered data
  const payments = (state.db.payments || []).filter(p => p.status === 'paid' && p.date >= start && p.date <= end && matchesFilters(p));
  const invoices = (state.db.invoices || []).filter(i => i.status === 'paid' && i.issueDate >= start && i.issueDate <= end && matchesFilters(i));
  const expenses = (state.db.expenses || []).filter(e => e.category !== 'renovation' && e.date >= start && e.date <= end && matchesFilters(e));
  const renos = (state.db.expenses || []).filter(e => e.category === 'renovation' && e.date >= start && e.date <= end && matchesFilters(e));

  const rev = [...payments, ...invoices.map(i => ({ ...i, amount: i.total }))].reduce((s, r) => s + toEUR(r.amount, r.currency), 0);
  const exp = expenses.reduce((s, r) => s + toEUR(r.amount, r.currency), 0);
  const reno = renos.reduce((s, r) => s + toEUR(r.amount, r.currency), 0);
  const net = rev - exp;
  const margin = rev ? (net / rev) * 100 : 0;

  // Last year same range for YoY
  let lyRev = 0, lyExp = 0;
  if (filters.year === 'ytd') {
    const now = new Date();
    const lyEnd = new Date(now); lyEnd.setFullYear(now.getFullYear() - 1);
    const lyStart = `${now.getFullYear() - 1}-01-01`;
    lyRev = revenueInRangeEUR(lyStart, lyEnd.toISOString().slice(0, 10));
    lyExp = expensesInRangeEUR(lyStart, lyEnd.toISOString().slice(0, 10), {}, { includeRenovation: false });
  }

  const kpiEl = document.getElementById('ins-kpi');
  kpiEl.innerHTML = '';
  kpiEl.append(
    kpi('Revenue', formatEUR(rev), lyRev ? `${((rev - lyRev) / lyRev * 100).toFixed(1)}% YoY` : ''),
    kpi('Operating Exp.', formatEUR(exp), lyExp ? `${((exp - lyExp) / lyExp * 100).toFixed(1)}% YoY` : ''),
    kpi('Net', formatEUR(net), `Margin ${margin.toFixed(1)}%`, net >= 0 ? 'success' : 'danger'),
    kpi('Renovation CapEx', formatEUR(reno), 'investments', 'warning')
  );

  // P&L by stream
  const streamKeys = Object.keys(STREAMS);
  const streamLabels = streamKeys.map(k => STREAMS[k].short);
  const streamRev = streamKeys.map(k => {
    return [...payments, ...invoices.map(i => ({ ...i, amount: i.total }))].filter(r => r.stream === k).reduce((s, r) => s + toEUR(r.amount, r.currency), 0);
  });
  const streamExp = streamKeys.map(k => {
    return expenses.filter(r => r.stream === k).reduce((s, r) => s + toEUR(r.amount, r.currency), 0);
  });
  charts.bar('ins-pl', {
    labels: streamLabels,
    datasets: [
      { label: 'Revenue', data: streamRev.map(n => Math.round(n)), backgroundColor: '#10b981' },
      { label: 'Expenses', data: streamExp.map(n => Math.round(n)), backgroundColor: '#ef4444' }
    ]
  });

  // By owner (service streams)
  const ownerKeys = ['you', 'rita', 'both'];
  const ownerLabels = ownerKeys.map(k => OWNERS[k]);
  const ownerData = ownerKeys.map(k => {
    const invs = invoices.filter(i => i.owner === k);
    const pays = payments.filter(p => {
      const prop = (state.db.properties || []).find(x => x.id === p.propertyId);
      return prop && prop.owner === k;
    });
    return Math.round([...pays, ...invs.map(i => ({ ...i, amount: i.total }))].reduce((s, r) => s + toEUR(r.amount, r.currency), 0));
  });
  charts.doughnut('ins-owner', {
    labels: ownerLabels,
    data: ownerData,
    colors: ['#6366f1', '#ec4899', '#14b8a6']
  });

  // Stream breakdown table
  const tableEl = document.getElementById('ins-stream-table');
  tableEl.innerHTML = '';
  const t = el('table', { class: 'table' });
  t.innerHTML = `<thead><tr>
    <th>Stream</th><th class="right">Revenue</th><th class="right">Expenses</th><th class="right">Net</th><th class="right">Margin</th>
  </tr></thead>`;
  const tb = el('tbody');
  streamKeys.forEach((k, i) => {
    const r = streamRev[i], e = streamExp[i], n = r - e;
    const m = r ? (n / r * 100) : 0;
    const tr = el('tr');
    tr.appendChild(el('td', {}, el('span', { class: `badge ${STREAMS[k].css}` }, STREAMS[k].label)));
    tr.appendChild(el('td', { class: 'right num' }, formatEUR(r)));
    tr.appendChild(el('td', { class: 'right num' }, formatEUR(e)));
    tr.appendChild(el('td', { class: 'right num' }, formatEUR(n)));
    tr.appendChild(el('td', { class: 'right num' }, `${m.toFixed(1)}%`));
    tb.appendChild(tr);
  });
  t.appendChild(tb);
  const wrap = el('div', { class: 'table-wrap' }); wrap.appendChild(t);
  tableEl.appendChild(wrap);
}

function kpi(label, value, sub, variant) {
  return el('div', { class: 'kpi' + (variant ? ' ' + variant : '') },
    el('div', { class: 'kpi-label' }, label),
    el('div', { class: 'kpi-value' }, value),
    el('div', { class: 'kpi-trend' }, sub || ''),
    el('div', { class: 'kpi-accent-bar' })
  );
}
