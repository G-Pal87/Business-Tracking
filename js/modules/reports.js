// Reports module
import { state } from '../core/state.js';
import { el, select, button, toast } from '../core/ui.js';
import * as charts from '../core/charts.js';
import { STREAMS } from '../core/config.js';
import {
  availableYears, formatEUR, toEUR, byId,
  propertyRevenueEUR, propertyExpensesEUR, propertyROI,
  groupByMonth, groupByStream, renovationCapexEUR
} from '../core/data.js';

let filters = { year: 'all', stream: 'all' };

export default {
  id: 'reports',
  label: 'Reports',
  icon: 'R',
  render(container) {
    container.appendChild(build());
    renderAll();
  },
  refresh() { const c = document.getElementById('content'); c.innerHTML = ''; c.appendChild(build()); renderAll(); },
  destroy() { charts.destroyAll(); }
};

function build() {
  const wrap = el('div', { class: 'view active' });

  const years = availableYears();
  const yearSel = select([{ value: 'all', label: 'All Years' }, ...years.map(y => ({ value: y, label: y }))], filters.year);
  const streamSel = select([{ value: 'all', label: 'All Streams' }, ...Object.entries(STREAMS).map(([v, m]) => ({ value: v, label: m.label }))], filters.stream);

  const bar = el('div', { class: 'flex gap-8 mb-16', style: 'flex-wrap:wrap' });
  bar.appendChild(el('span', { class: 'muted', style: 'align-self:center' }, 'Filter:'));
  bar.appendChild(yearSel);
  bar.appendChild(streamSel);
  bar.appendChild(el('div', { class: 'flex-1' }));
  bar.appendChild(button('Print / PDF', { onClick: () => window.print() }));
  wrap.appendChild(bar);

  yearSel.onchange = () => { filters.year = yearSel.value; renderAll(); };
  streamSel.onchange = () => { filters.stream = streamSel.value; renderAll(); };

  // KPI row
  wrap.appendChild(el('div', { class: 'grid grid-4', id: 'reports-kpi' }));

  // Charts
  wrap.appendChild(el('div', { class: 'grid grid-2 mt-16' },
    el('div', { class: 'card' },
      el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'Monthly Revenue vs Expenses')),
      el('div', { class: 'chart-wrap tall' }, el('canvas', { id: 'rep-monthly' }))
    ),
    el('div', { class: 'card' },
      el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'Revenue by Business Stream')),
      el('div', { class: 'chart-wrap tall' }, el('canvas', { id: 'rep-stream' }))
    )
  ));

  // ROI per property table
  wrap.appendChild(el('div', { class: 'card mt-16' },
    el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'ROI per Property')),
    el('div', { id: 'roi-table' })
  ));

  return wrap;
}

function inFilter(row) {
  if (filters.year !== 'all') {
    const d = row.date || row.issueDate || '';
    if (!d.startsWith(filters.year)) return false;
  }
  if (filters.stream !== 'all' && row.stream && row.stream !== filters.stream) return false;
  return true;
}

function renderAll() {
  const payments = (state.db.payments || []).filter(p => p.status === 'paid').filter(inFilter);
  const invoices = (state.db.invoices || []).filter(i => i.status === 'paid').map(i => ({ ...i, amount: i.total, date: i.issueDate })).filter(inFilter);
  const expenses = (state.db.expenses || []).filter(e => e.category !== 'renovation').filter(inFilter);
  const renos = (state.db.expenses || []).filter(e => e.category === 'renovation').filter(inFilter);

  const rev = [...payments, ...invoices].reduce((s, r) => s + toEUR(r.amount, r.currency), 0);
  const exp = expenses.reduce((s, r) => s + toEUR(r.amount, r.currency), 0);
  const reno = renos.reduce((s, r) => s + toEUR(r.amount, r.currency), 0);
  const net = rev - exp;

  document.getElementById('reports-kpi').innerHTML = '';
  document.getElementById('reports-kpi').append(
    kpi('Revenue', formatEUR(rev)),
    kpi('Operating Exp.', formatEUR(exp)),
    kpi('Net', formatEUR(net), net >= 0 ? 'success' : 'danger'),
    kpi('Renovation CapEx', formatEUR(reno), 'warning')
  );

  // Monthly chart - build last 12 or full year
  const months = collectMonths(payments, invoices, expenses, renos);
  const revByM = groupByMonth([...payments, ...invoices]);
  const expByM = groupByMonth(expenses);
  const renoByM = groupByMonth(renos);
  charts.bar('rep-monthly', {
    labels: months,
    datasets: [
      { label: 'Revenue', data: months.map(m => Math.round(revByM.get(m) || 0)), backgroundColor: '#10b981' },
      { label: 'Operating', data: months.map(m => Math.round(expByM.get(m) || 0)), backgroundColor: '#ef4444' },
      { label: 'Renovation', data: months.map(m => Math.round(renoByM.get(m) || 0)), backgroundColor: '#f59e0b' }
    ]
  });

  // Stream doughnut
  const byStream = groupByStream([...payments, ...invoices]);
  const sLabels = [], sData = [], sColors = [];
  for (const [k, m] of Object.entries(STREAMS)) {
    sLabels.push(m.short);
    sData.push(Math.round(byStream.get(k) || 0));
    sColors.push(m.color);
  }
  charts.doughnut('rep-stream', { labels: sLabels, data: sData, colors: sColors });

  // ROI table
  const tableWrap = document.getElementById('roi-table');
  tableWrap.innerHTML = '';
  const props = state.db.properties || [];
  const t = el('table', { class: 'table' });
  t.innerHTML = `<thead><tr>
    <th>Property</th><th>Status</th><th class="right">Purchase</th><th class="right">Reno CapEx</th><th class="right">Revenue</th><th class="right">Expenses</th><th class="right">Net</th><th class="right">ROI %</th>
  </tr></thead>`;
  const tb = el('tbody');
  const rows = props.map(p => {
    const rev = propertyRevenueEUR(p.id, filters.year !== 'all' ? { year: filters.year } : {});
    const exp = propertyExpensesEUR(p.id, filters.year !== 'all' ? { year: filters.year } : {}, { includeRenovation: false });
    const reno = renovationCapexEUR({ propertyId: p.id });
    const purchaseEUR = toEUR(p.purchasePrice, p.currency);
    const totalInvested = purchaseEUR + reno;
    const net = rev - exp;
    const roi = totalInvested ? (net / totalInvested) * 100 : 0;
    return { p, rev, exp, reno, purchaseEUR, net, roi };
  }).sort((a, b) => b.roi - a.roi);

  for (const { p, rev, exp, reno, purchaseEUR, net, roi } of rows) {
    const tr = el('tr');
    tr.appendChild(el('td', {}, p.name));
    tr.appendChild(el('td', {}, el('span', { class: 'badge ' + (p.status === 'active' ? 'success' : p.status === 'renovation' ? 'warning' : '') }, p.status)));
    tr.appendChild(el('td', { class: 'right num' }, formatEUR(purchaseEUR)));
    tr.appendChild(el('td', { class: 'right num' }, formatEUR(reno)));
    tr.appendChild(el('td', { class: 'right num' }, formatEUR(rev)));
    tr.appendChild(el('td', { class: 'right num' }, formatEUR(exp)));
    tr.appendChild(el('td', { class: 'right num ' + (net >= 0 ? '' : '') }, formatEUR(net)));
    tr.appendChild(el('td', { class: 'right num' }, `${roi.toFixed(2)}%`));
    tb.appendChild(tr);
  }
  t.appendChild(tb);
  const wrap = el('div', { class: 'table-wrap' });
  wrap.appendChild(t);
  tableWrap.appendChild(wrap);
}

function collectMonths(...groups) {
  const all = new Set();
  for (const g of groups) for (const r of g) if (r.date) all.add(r.date.slice(0, 7));
  if (all.size === 0) {
    const now = new Date();
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      all.add(d.toISOString().slice(0, 7));
    }
  }
  return [...all].sort();
}

function kpi(label, value, variant) {
  return el('div', { class: 'kpi' + (variant ? ' ' + variant : '') },
    el('div', { class: 'kpi-label' }, label),
    el('div', { class: 'kpi-value' }, value),
    el('div', { class: 'kpi-accent-bar' })
  );
}
