// Reports module — single source of truth for all analytical views
// Tabs: Summary | By Property | By Stream | Reconciliation
import { state } from '../core/state.js';
import { el, select, button, fmtDate, drillDownModal } from '../core/ui.js';
import * as charts from '../core/charts.js';
import { STREAMS } from '../core/config.js';
import {
  availableYears, formatEUR, toEUR, byId,
  propertyRevenueEUR, propertyExpensesEUR, propertyROI,
  renovationCapexEUR, groupByMonth, groupByStream,
  buildReportData, getForecastVsActual,
  drillRevRows, drillExpRows, drillNetRows
} from '../core/data.js';

const REV_COLS = [
  { key: 'date', label: 'Date', format: v => fmtDate(v) },
  { key: 'type', label: 'Type' },
  { key: 'source', label: 'Source' },
  { key: 'ref', label: 'Ref' },
  { key: 'eur', label: 'EUR', right: true, format: v => formatEUR(v) }
];
const EXP_COLS = [
  { key: 'date', label: 'Date', format: v => fmtDate(v) },
  { key: 'source', label: 'Property' },
  { key: 'category', label: 'Category' },
  { key: 'description', label: 'Description' },
  { key: 'eur', label: 'EUR', right: true, format: v => formatEUR(v) }
];
const NET_COLS = [
  { key: 'date', label: 'Date', format: v => fmtDate(v) },
  { key: 'kind', label: 'Kind' },
  { key: 'source', label: 'Source' },
  { key: 'eur', label: 'EUR', right: true, format: v => formatEUR(v) }
];

let gFilters = { year: String(new Date().getFullYear()), stream: 'all' };
const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

export default {
  id: 'reports',
  label: 'Reports',
  icon: 'R',
  render(container) { container.appendChild(build()); },
  refresh() { const c = document.getElementById('content'); c.innerHTML = ''; c.appendChild(build()); },
  destroy() { charts.destroyAll(); }
};

function build() {
  const wrap = el('div', { class: 'view active' });

  // Global filter bar
  const years = availableYears();
  const yearSel = select([{ value: 'all', label: 'All Years' }, ...years.map(y => ({ value: y, label: y }))], gFilters.year);
  const streamSel = select([{ value: 'all', label: 'All Streams' }, ...Object.entries(STREAMS).map(([v, m]) => ({ value: v, label: m.label }))], gFilters.stream);
  const filterBar = el('div', { class: 'flex gap-8 mb-16', style: 'flex-wrap:wrap' });
  filterBar.appendChild(el('span', { class: 'muted', style: 'align-self:center' }, 'Filter:'));
  filterBar.appendChild(yearSel);
  filterBar.appendChild(streamSel);
  filterBar.appendChild(el('div', { class: 'flex-1' }));
  filterBar.appendChild(button('Print / PDF', { onClick: () => window.print() }));
  wrap.appendChild(filterBar);

  yearSel.onchange = () => { gFilters.year = yearSel.value; refreshActive(); };
  streamSel.onchange = () => { gFilters.stream = streamSel.value; refreshActive(); };

  // Tabs
  const tabDefs = [
    { id: 'summary', label: 'Summary' },
    { id: 'property', label: 'By Property' },
    { id: 'stream', label: 'By Stream' },
    { id: 'reconciliation', label: 'Reconciliation' },
    { id: 'comparison', label: 'Comparison' }
  ];
  const tabs = el('div', { class: 'tabs' });
  const sections = {};
  let activeTab = 'summary';

  tabDefs.forEach((td, i) => {
    const s = el('div', { id: `rep-tab-${td.id}`, style: i > 0 ? 'display:none' : '' });
    sections[td.id] = s;
    const t = el('div', { class: 'tab' + (i === 0 ? ' active' : '') }, td.label);
    t.onclick = () => {
      tabs.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
      t.classList.add('active');
      Object.values(sections).forEach(x => x.style.display = 'none');
      s.style.display = '';
      activeTab = td.id;
      renderTab(td.id);
    };
    tabs.appendChild(t);
    wrap.appendChild(s);
  });
  wrap.insertBefore(tabs, wrap.children[1]);

  function refreshActive() { renderTab(activeTab); }
  function renderTab(id) {
    const s = sections[id];
    if (!s) return;
    s.innerHTML = '';
    charts.destroyAll();
    if (id === 'summary') renderSummary(s);
    else if (id === 'property') renderByProperty(s);
    else if (id === 'stream') renderByStream(s);
    else if (id === 'reconciliation') renderReconciliation(s);
    else if (id === 'comparison') renderComparison(s);
  }

  renderTab('summary');
  return wrap;
}

// ===== SUMMARY TAB =====
function renderSummary(wrap) {
  const d = buildReportData(gFilters);
  wrap.appendChild(el('div', { class: 'grid grid-4 mb-16' },
    kpi('Revenue', formatEUR(d.rev), '', () => drillDownModal('Revenue', drillRevRows(d.payments, d.invoices), REV_COLS)),
    kpi('Operating Exp.', formatEUR(d.exp), '', () => drillDownModal('Operating Expenses', drillExpRows(d.opExpenses), EXP_COLS)),
    kpi('Net', formatEUR(d.net), d.net >= 0 ? 'success' : 'danger', () => drillDownModal('Net — Revenue & Expenses', drillNetRows(d.payments, d.invoices, d.opExpenses), NET_COLS)),
    kpi('Renovation CapEx', formatEUR(d.reno), 'warning', () => drillDownModal('Renovation CapEx', drillExpRows(d.renoExpenses), EXP_COLS))
  ));

  const months = collectMonths(d.payments, d.invoices.map(i => ({ ...i, date: i.issueDate })), d.opExpenses, d.renoExpenses);
  const revByM = groupByMonth([...d.payments, ...d.invoices.map(i => ({ ...i, amount: i.total, date: i.issueDate }))]);
  const expByM = groupByMonth(d.opExpenses);
  const renoByM = groupByMonth(d.renoExpenses);

  wrap.appendChild(el('div', { class: 'card' },
    el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'Monthly Revenue vs Expenses')),
    el('div', { class: 'chart-wrap tall' }, el('canvas', { id: 'rep-monthly' }))
  ));

  setTimeout(() => {
    charts.bar('rep-monthly', {
      labels: months,
      datasets: [
        { label: 'Revenue', data: months.map(m => Math.round(revByM.get(m) || 0)), backgroundColor: '#10b981' },
        { label: 'Operating', data: months.map(m => Math.round(expByM.get(m) || 0)), backgroundColor: '#ef4444' },
        { label: 'Renovation', data: months.map(m => Math.round(renoByM.get(m) || 0)), backgroundColor: '#f59e0b' }
      ],
      onClickItem: (label, index, datasetIndex) => {
        const m = months[index];
        if (!m) return;
        const titles = ['Revenue', 'Operating Expenses', 'Renovation'];
        const title = `${label} — ${titles[datasetIndex] || ''}`;
        if (datasetIndex === 0) {
          drillDownModal(title, drillRevRows(d.payments.filter(p => (p.date || '').startsWith(m)), d.invoices.filter(i => (i.issueDate || '').startsWith(m))), REV_COLS);
        } else if (datasetIndex === 1) {
          drillDownModal(title, drillExpRows(d.opExpenses.filter(e => (e.date || '').startsWith(m))), EXP_COLS);
        } else {
          drillDownModal(title, drillExpRows(d.renoExpenses.filter(e => (e.date || '').startsWith(m))), EXP_COLS);
        }
      }
    });
  }, 0);
}

// ===== BY PROPERTY TAB =====
function renderByProperty(wrap) {
  const yearFilter = gFilters.year !== 'all' ? { year: gFilters.year } : {};
  const props = state.db.properties || [];
  const rows = props.map(p => {
    const rev = propertyRevenueEUR(p.id, yearFilter);
    const exp = propertyExpensesEUR(p.id, yearFilter, { includeRenovation: false });
    const reno = renovationCapexEUR({ propertyId: p.id });
    const purchaseEUR = toEUR(p.purchasePrice, p.currency);
    const net = rev - exp;
    const roi = propertyROI(p.id);
    return { p, rev, exp, reno, purchaseEUR, net, roi };
  }).sort((a, b) => b.roi - a.roi);

  const t = el('table', { class: 'table' });
  t.innerHTML = `<thead><tr>
    <th>Property</th><th>Status</th><th class="right">Purchase</th><th class="right">Reno CapEx</th>
    <th class="right">Revenue</th><th class="right">Expenses</th><th class="right">Net</th><th class="right">ROI %</th>
  </tr></thead>`;
  const tb = el('tbody');
  for (const { p, rev, exp, reno, purchaseEUR, net, roi } of rows) {
    const tr = el('tr', { style: 'cursor:pointer' });
    tr.onclick = () => {
      const yearStr = gFilters.year !== 'all' ? gFilters.year : null;
      const pays = (state.db.payments || []).filter(pay => pay.propertyId === p.id && pay.status === 'paid' && (!yearStr || (pay.date || '').startsWith(yearStr)));
      drillDownModal(`${p.name} — Payments`, drillRevRows(pays, []), REV_COLS);
    };
    tr.appendChild(el('td', {}, el('div', {}, p.name), el('div', { class: 'muted', style: 'font-size:11px' }, `${p.city}, ${p.country}`)));
    tr.appendChild(el('td', {}, el('span', { class: 'badge ' + (p.status === 'active' ? 'success' : p.status === 'renovation' ? 'warning' : '') }, p.status)));
    tr.appendChild(el('td', { class: 'right num' }, formatEUR(purchaseEUR)));
    tr.appendChild(el('td', { class: 'right num' }, reno > 0 ? formatEUR(reno) : '—'));
    tr.appendChild(el('td', { class: 'right num' }, formatEUR(rev)));
    tr.appendChild(el('td', { class: 'right num' }, formatEUR(exp)));
    tr.appendChild(el('td', { class: 'right num' }, formatEUR(net)));
    tr.appendChild(el('td', { class: 'right num' }, `${roi.toFixed(2)}%`));
    tb.appendChild(tr);
  }
  t.appendChild(tb);
  const tw = el('div', { class: 'table-wrap' }); tw.appendChild(t);
  wrap.appendChild(tw);
}

// ===== BY STREAM TAB =====
function renderByStream(wrap) {
  const d = buildReportData(gFilters);
  const allRevRows = [...d.payments, ...d.invoices.map(i => ({ ...i, amount: i.total }))];
  const streamKeys = Object.keys(STREAMS);
  const streamRev = streamKeys.map(k => allRevRows.filter(r => r.stream === k).reduce((s, r) => s + toEUR(r.amount, r.currency), 0));
  const streamExp = streamKeys.map(k => d.opExpenses.filter(r => r.stream === k).reduce((s, r) => s + toEUR(r.amount, r.currency), 0));

  // Owner split
  const ownerMap = { you: 0, rita: 0, both: 0 };
  for (const r of allRevRows) {
    const owner = r.owner || (byId('properties', r.propertyId)?.owner) || byId('clients', r.clientId)?.owner || 'you';
    ownerMap[owner] = (ownerMap[owner] || 0) + toEUR(r.amount, r.currency);
  }

  wrap.appendChild(el('div', { class: 'grid grid-2' },
    el('div', { class: 'card' },
      el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'Revenue vs Expenses by Stream')),
      el('div', { class: 'chart-wrap' }, el('canvas', { id: 'rep-stream-bar' }))
    ),
    el('div', { class: 'card' },
      el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'Revenue by Owner')),
      el('div', { class: 'chart-wrap' }, el('canvas', { id: 'rep-owner' }))
    )
  ));

  const t = el('table', { class: 'table' });
  t.innerHTML = `<thead><tr><th>Stream</th><th class="right">Revenue</th><th class="right">Expenses</th><th class="right">Net</th><th class="right">Margin</th></tr></thead>`;
  const tb = el('tbody');
  streamKeys.forEach((k, i) => {
    const r = streamRev[i], e = streamExp[i], n = r - e;
    const tr = el('tr');
    tr.appendChild(el('td', {}, el('span', { class: `badge ${STREAMS[k].css}` }, STREAMS[k].label)));
    tr.appendChild(el('td', { class: 'right num' }, formatEUR(r)));
    tr.appendChild(el('td', { class: 'right num' }, formatEUR(e)));
    tr.appendChild(el('td', { class: 'right num' }, formatEUR(n)));
    tr.appendChild(el('td', { class: 'right num' }, r ? `${((n / r) * 100).toFixed(1)}%` : '—'));
    tb.appendChild(tr);
  });
  t.appendChild(tb);
  const tw = el('div', { class: 'table-wrap mt-16' }); tw.appendChild(t);
  wrap.appendChild(tw);

  setTimeout(() => {
    charts.bar('rep-stream-bar', {
      labels: streamKeys.map(k => STREAMS[k].short),
      datasets: [
        { label: 'Revenue', data: streamRev.map(n => Math.round(n)), backgroundColor: '#10b981' },
        { label: 'Expenses', data: streamExp.map(n => Math.round(n)), backgroundColor: '#ef4444' }
      ],
      onClickItem: (label, index, datasetIndex) => {
        const k = streamKeys[index];
        if (!k) return;
        if (datasetIndex === 0) {
          drillDownModal(`${STREAMS[k].label} — Revenue`, drillRevRows(d.payments.filter(p => p.stream === k), d.invoices.filter(i => i.stream === k)), REV_COLS);
        } else {
          drillDownModal(`${STREAMS[k].label} — Expenses`, drillExpRows(d.opExpenses.filter(e => e.stream === k)), EXP_COLS);
        }
      }
    });
    charts.doughnut('rep-owner', {
      labels: ['You', 'Rita', 'Both'],
      data: [Math.round(ownerMap.you), Math.round(ownerMap.rita), Math.round(ownerMap.both)],
      colors: ['#6366f1', '#ec4899', '#14b8a6'],
      onClickItem: (label, index) => {
        const ownerKey = ['you', 'rita', 'both'][index];
        const pays = d.payments.filter(p => (p.owner || byId('properties', p.propertyId)?.owner) === ownerKey);
        const invs = d.invoices.filter(i => i.owner === ownerKey);
        drillDownModal(`${label} — Revenue`, drillRevRows(pays, invs), REV_COLS);
      }
    });
  }, 0);
}

// ===== RECONCILIATION TAB =====
function renderReconciliation(wrap) {
  wrap.appendChild(el('div', { class: 'muted mb-16', style: 'font-size:12px' }, 'Compare forecast revenue against actual received payments. Requires forecasts to be set in the Forecast module.'));
  const year = gFilters.year !== 'all' ? gFilters.year : String(new Date().getFullYear());
  const props = (state.db.properties || []).filter(p => p.status !== 'renovation');
  const services = [
    { id: 'customer_success', label: 'Customer Success', type: 'service' },
    { id: 'marketing_services', label: 'Marketing Services', type: 'service' }
  ];
  const entities = [
    ...props.map(p => ({ id: p.id, label: p.name, type: 'property' })),
    ...services
  ];

  if (entities.length === 0) { wrap.appendChild(el('div', { class: 'empty' }, 'No entities to reconcile')); return; }
  const entSel = select(entities.map(e => ({ value: e.id, label: e.label })), entities[0].id);
  const yearSel = select([String(Number(year) - 1), year, String(Number(year) + 1)].map(y => ({ value: y, label: y })), year);

  const bar = el('div', { class: 'flex gap-8 mb-16' });
  bar.appendChild(entSel);
  bar.appendChild(yearSel);
  wrap.appendChild(bar);

  const tableWrap = el('div', {});
  wrap.appendChild(tableWrap);
  const chartCard = el('div', { class: 'card mt-16' },
    el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'Forecast vs Actual' )),
    el('div', { class: 'chart-wrap' }, el('canvas', { id: 'rep-recon-chart' }))
  );
  wrap.appendChild(chartCard);

  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  const render = () => {
    tableWrap.innerHTML = '';
    charts.destroy('rep-recon-chart');
    const ent = entities.find(e => e.id === entSel.value);
    if (!ent) return;
    const { months } = getForecastVsActual(ent.type, ent.id, yearSel.value);

    const t = el('table', { class: 'table' });
    t.innerHTML = `<thead><tr>
      <th>Month</th><th class="right">Forecast</th><th class="right">Actual</th><th class="right">Variance</th><th class="right">Status</th>
    </tr></thead>`;
    const tb = el('tbody');
    const now = new Date();
    for (let i = 0; i < 12; i++) {
      const m = months[i];
      const isPast = new Date(yearSel.value, i + 1, 0) <= now;
      if (!isPast && m.forecastRev === 0 && m.actualRev === 0) continue;
      const tr = el('tr');
      const varianceCls = m.revVariance >= 0 ? 'success' : 'danger';
      tr.appendChild(el('td', {}, MONTHS[i]));
      tr.appendChild(el('td', { class: 'right num' }, formatEUR(m.forecastRev)));
      tr.appendChild(el('td', { class: 'right num' }, formatEUR(m.actualRev)));
      tr.appendChild(el('td', { class: `right num ${varianceCls}` }, formatEUR(m.revVariance)));
      tr.appendChild(el('td', {},
        !isPast ? el('span', { class: 'badge' }, 'Future')
        : m.revVariance >= 0 ? el('span', { class: 'badge success' }, 'On track')
        : el('span', { class: 'badge danger' }, 'Shortfall')
      ));
      tb.appendChild(tr);
    }
    t.appendChild(tb);
    const tw = el('div', { class: 'table-wrap' }); tw.appendChild(t);
    tableWrap.appendChild(tw);

    const pastMonths = months.filter((_, i) => new Date(yearSel.value, i + 1, 0) <= now);
    setTimeout(() => {
      charts.bar('rep-recon-chart', {
        labels: MONTHS.filter((_, i) => months[i].forecastRev > 0 || months[i].actualRev > 0),
        datasets: [
          { label: 'Forecast', data: months.filter(m => m.forecastRev > 0 || m.actualRev > 0).map(m => Math.round(m.forecastRev)), backgroundColor: 'rgba(99,102,241,0.5)', borderColor: '#6366f1', borderWidth: 1 },
          { label: 'Actual', data: months.filter(m => m.forecastRev > 0 || m.actualRev > 0).map(m => Math.round(m.actualRev)), backgroundColor: '#10b981' }
        ]
      });
    }, 0);
  };

  entSel.onchange = render;
  yearSel.onchange = render;
  render();
}

// ===== COMPARISON TAB =====
function renderComparison(wrap) {
  const baseYear = gFilters.year !== 'all' ? Number(gFilters.year) : new Date().getFullYear();
  const props = (state.db.properties || []).filter(p => p.status !== 'renovation');
  const services = [
    { id: 'customer_success', label: 'Customer Success', type: 'service' },
    { id: 'marketing_services', label: 'Marketing Services', type: 'service' }
  ];
  const entities = [
    ...props.map(p => ({ id: p.id, label: p.name, type: 'property' })),
    ...services
  ];
  if (!entities.length) { wrap.appendChild(el('div', { class: 'empty' }, 'No entities to compare')); return; }

  const entSel = select(entities.map(e => ({ value: e.id, label: e.label })), entities[0].id);
  const yearSel = select(
    [baseYear - 1, baseYear, baseYear + 1].map(y => ({ value: String(y), label: String(y) })),
    String(baseYear)
  );
  const controls = el('div', { class: 'flex gap-8 mb-16' });
  controls.appendChild(entSel);
  controls.appendChild(yearSel);
  wrap.appendChild(controls);

  const body = el('div', {});
  wrap.appendChild(body);

  const render = () => {
    body.innerHTML = '';
    charts.destroy('cmp-yoy');
    charts.destroy('cmp-mom');
    const ent = entities.find(e => e.id === entSel.value);
    if (!ent) return;
    const yr = Number(yearSel.value);

    const { months: cur, yearTarget } = getForecastVsActual(ent.type, ent.id, yr);
    const { months: prv } = getForecastVsActual(ent.type, ent.id, yr - 1);

    const curRev = cur.reduce((s, m) => s + m.actualRev, 0);
    const prvRev = prv.reduce((s, m) => s + m.actualRev, 0);
    const curFc  = cur.reduce((s, m) => s + m.forecastRev, 0);
    const yoyPct = prvRev ? (curRev - prvRev) / prvRev * 100 : 0;
    const fvaPct = curFc  ? (curRev - curFc)  / curFc  * 100 : 0;

    body.appendChild(el('div', { class: 'grid grid-4 mb-16' },
      kpi(`${yr} Actual`,   formatEUR(curRev)),
      kpi(`${yr - 1} Actual`, formatEUR(prvRev)),
      kpi('YoY Change', `${yoyPct >= 0 ? '+' : ''}${yoyPct.toFixed(1)}%`, yoyPct >= 0 ? 'success' : 'danger'),
      kpi(`${yr} Forecast`, formatEUR(curFc), curFc ? (fvaPct >= 0 ? 'success' : 'danger') : '')
    ));

    body.appendChild(el('div', { class: 'grid grid-2 mb-16' },
      el('div', { class: 'card' },
        el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, `Year-over-Year: ${yr - 1} vs ${yr}`)),
        el('div', { class: 'chart-wrap' }, el('canvas', { id: 'cmp-yoy' }))
      ),
      el('div', { class: 'card' },
        el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, `Month-over-Month — ${yr}`)),
        el('div', { class: 'chart-wrap' }, el('canvas', { id: 'cmp-mom' }))
      )
    ));

    body.appendChild(el('div', { class: 'card mb-16' },
      el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, `Year-over-Year Detail — ${yr - 1} vs ${yr}`)),
      buildYoYTable(cur, prv, yr)
    ));

    body.appendChild(el('div', { class: 'card' },
      el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, `Month-over-Month Detail — ${yr}`)),
      buildMoMTable(cur, prv, yr)
    ));

    setTimeout(() => {
      charts.bar('cmp-yoy', {
        labels: MON,
        datasets: [
          { label: String(yr - 1), data: prv.map(m => Math.round(m.actualRev)), backgroundColor: 'rgba(99,102,241,0.35)', borderColor: '#6366f1', borderWidth: 1 },
          { label: `${yr} Forecast`, data: cur.map(m => Math.round(m.forecastRev)), backgroundColor: 'rgba(16,185,129,0.3)', borderColor: '#10b981', borderWidth: 1 },
          { label: `${yr} Actual`, data: cur.map(m => Math.round(m.actualRev)), backgroundColor: '#10b981' }
        ],
        onClickItem: (label, index, datasetIndex) => {
          const m = datasetIndex === 0 ? prv[index] : cur[index];
          if (!m) return;
          const s = m.key + '-01', e = m.key + '-' + new Date(Number(m.key.slice(0, 4)), Number(m.key.slice(5, 7)), 0).getDate().toString().padStart(2, '0');
          if (ent.type === 'property') {
            const pays = (state.db.payments || []).filter(p => p.propertyId === ent.id && p.status === 'paid' && p.date >= s && p.date <= e);
            drillDownModal(`${MON[index]} ${datasetIndex === 0 ? yr - 1 : yr} — Revenue`, drillRevRows(pays, []), REV_COLS);
          } else {
            const invs = (state.db.invoices || []).filter(i => i.stream === ent.id && i.status === 'paid' && i.issueDate >= s && i.issueDate <= e);
            drillDownModal(`${MON[index]} ${datasetIndex === 0 ? yr - 1 : yr} — Invoiced`, drillRevRows([], invs), REV_COLS);
          }
        }
      });

      const momColors = cur.map((m, i) => {
        const prevRev = i === 0 ? prv[11].actualRev : cur[i - 1].actualRev;
        return m.actualRev >= prevRev ? '#10b981' : '#ef4444';
      });
      charts.bar('cmp-mom', {
        labels: MON,
        datasets: [
          { label: 'Actual Revenue', data: cur.map(m => Math.round(m.actualRev)), backgroundColor: momColors },
          { label: 'Forecast', data: cur.map(m => Math.round(m.forecastRev)), backgroundColor: 'rgba(99,102,241,0.4)', borderColor: '#6366f1', borderWidth: 1 }
        ],
        onClickItem: (label, index) => {
          const m = cur[index];
          if (!m) return;
          const s = m.key + '-01', e = m.key + '-' + new Date(Number(m.key.slice(0, 4)), Number(m.key.slice(5, 7)), 0).getDate().toString().padStart(2, '0');
          if (ent.type === 'property') {
            const pays = (state.db.payments || []).filter(p => p.propertyId === ent.id && p.status === 'paid' && p.date >= s && p.date <= e);
            drillDownModal(`${MON[index]} ${yr} — Revenue`, drillRevRows(pays, []), REV_COLS);
          } else {
            const invs = (state.db.invoices || []).filter(i => i.stream === ent.id && i.status === 'paid' && i.issueDate >= s && i.issueDate <= e);
            drillDownModal(`${MON[index]} ${yr} — Invoiced`, drillRevRows([], invs), REV_COLS);
          }
        }
      });
    }, 0);
  };

  entSel.onchange = render;
  yearSel.onchange = render;
  render();
}

function buildYoYTable(cur, prv, yr) {
  const now = new Date();
  const t = el('table', { class: 'table' });
  t.innerHTML = `<thead><tr>
    <th>Month</th><th class="right">${yr - 1}</th><th class="right">${yr} Forecast</th>
    <th class="right">${yr} Actual</th><th class="right">YoY Δ</th><th class="right">YoY %</th><th class="right">vs Forecast</th>
  </tr></thead>`;
  const tb = el('tbody');

  for (let i = 0; i < 12; i++) {
    const c = cur[i], p = prv[i];
    const isPast = new Date(yr, i + 1, 0) < now;
    const yoyD = c.actualRev - p.actualRev;
    const yoyP = p.actualRev ? yoyD / p.actualRev * 100 : 0;
    const vsF  = c.forecastRev ? c.actualRev - c.forecastRev : null;
    const tr = el('tr');
    tr.appendChild(el('td', {}, MON[i]));
    tr.appendChild(el('td', { class: 'right num' }, p.actualRev ? formatEUR(p.actualRev) : '—'));
    tr.appendChild(el('td', { class: 'right num muted' }, c.forecastRev ? formatEUR(c.forecastRev) : '—'));
    tr.appendChild(el('td', { class: 'right num' + (!isPast ? ' muted' : '') }, formatEUR(c.actualRev)));
    tr.appendChild(el('td', { class: `right num${isPast ? (yoyD >= 0 ? ' success' : ' danger') : ' muted'}` }, isPast ? (yoyD >= 0 ? '+' : '') + formatEUR(yoyD) : '—'));
    tr.appendChild(el('td', { class: `right num${isPast ? (yoyP >= 0 ? ' success' : ' danger') : ' muted'}` }, isPast ? `${yoyP >= 0 ? '+' : ''}${yoyP.toFixed(1)}%` : '—'));
    tr.appendChild(el('td', { class: `right num${vsF !== null && isPast ? (vsF >= 0 ? '' : ' danger') : ' muted'}` }, vsF !== null && isPast ? (vsF >= 0 ? '+' : '') + formatEUR(vsF) : '—'));
    tb.appendChild(tr);
  }

  const tCur = cur.reduce((s, m) => s + m.actualRev, 0);
  const tPrv = prv.reduce((s, m) => s + m.actualRev, 0);
  const tFc  = cur.reduce((s, m) => s + m.forecastRev, 0);
  const tYoY = tCur - tPrv;
  const tYoYP = tPrv ? tYoY / tPrv * 100 : 0;
  const tVsF  = tFc ? tCur - tFc : null;
  const tot = el('tr', { style: 'font-weight:600;background:var(--bg-elev-2)' });
  tot.appendChild(el('td', {}, 'TOTAL'));
  tot.appendChild(el('td', { class: 'right num' }, formatEUR(tPrv)));
  tot.appendChild(el('td', { class: 'right num muted' }, tFc ? formatEUR(tFc) : '—'));
  tot.appendChild(el('td', { class: 'right num' }, formatEUR(tCur)));
  tot.appendChild(el('td', { class: `right num ${tYoY >= 0 ? 'success' : 'danger'}` }, (tYoY >= 0 ? '+' : '') + formatEUR(tYoY)));
  tot.appendChild(el('td', { class: `right num ${tYoYP >= 0 ? 'success' : 'danger'}` }, `${tYoYP >= 0 ? '+' : ''}${tYoYP.toFixed(1)}%`));
  tot.appendChild(el('td', { class: `right num${tVsF !== null ? (tVsF >= 0 ? '' : ' danger') : ''}` }, tVsF !== null ? (tVsF >= 0 ? '+' : '') + formatEUR(tVsF) : '—'));
  tb.appendChild(tot);

  t.appendChild(tb);
  const tw = el('div', { class: 'table-wrap' }); tw.appendChild(t);
  return tw;
}

function buildMoMTable(cur, prv, yr) {
  const now = new Date();
  const t = el('table', { class: 'table' });
  t.innerHTML = `<thead><tr>
    <th>Month</th><th class="right">Actual Revenue</th><th class="right">Prev Month</th>
    <th class="right">MoM Δ</th><th class="right">MoM %</th><th class="right">Forecast</th><th class="right">vs Forecast</th>
  </tr></thead>`;
  const tb = el('tbody');

  for (let i = 0; i < 12; i++) {
    const c = cur[i];
    const prevRev = i === 0 ? prv[11].actualRev : cur[i - 1].actualRev;
    const isPast = new Date(yr, i + 1, 0) < now;
    const delta = c.actualRev - prevRev;
    const deltaPct = prevRev ? delta / prevRev * 100 : 0;
    const vsF = c.forecastRev ? c.actualRev - c.forecastRev : null;
    const tr = el('tr');
    tr.appendChild(el('td', {}, MON[i]));
    tr.appendChild(el('td', { class: 'right num' + (!isPast ? ' muted' : '') }, formatEUR(c.actualRev)));
    tr.appendChild(el('td', { class: 'right num muted' }, formatEUR(prevRev)));
    tr.appendChild(el('td', { class: `right num${isPast ? (delta >= 0 ? ' success' : ' danger') : ' muted'}` }, isPast ? (delta >= 0 ? '+' : '') + formatEUR(delta) : '—'));
    tr.appendChild(el('td', { class: `right num${isPast ? (deltaPct >= 0 ? ' success' : ' danger') : ' muted'}` }, isPast ? `${deltaPct >= 0 ? '+' : ''}${deltaPct.toFixed(1)}%` : '—'));
    tr.appendChild(el('td', { class: 'right num muted' }, c.forecastRev ? formatEUR(c.forecastRev) : '—'));
    tr.appendChild(el('td', { class: `right num${vsF !== null && isPast ? (vsF >= 0 ? '' : ' danger') : ' muted'}` }, vsF !== null && isPast ? (vsF >= 0 ? '+' : '') + formatEUR(vsF) : '—'));
    tb.appendChild(tr);
  }

  t.appendChild(tb);
  const tw = el('div', { class: 'table-wrap' }); tw.appendChild(t);
  return tw;
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

function kpi(label, value, variant, onClick) {
  const attrs = { class: 'kpi' + (variant ? ' ' + variant : '') };
  if (onClick) { attrs.style = 'cursor:pointer'; attrs.onclick = onClick; }
  return el('div', attrs,
    el('div', { class: 'kpi-label' }, label),
    el('div', { class: 'kpi-value' }, value),
    el('div', { class: 'kpi-accent-bar' })
  );
}
