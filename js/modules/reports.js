// Reports module — single source of truth for all analytical views
// Tabs: Summary | By Property | By Stream | Reconciliation
import { state } from '../core/state.js';
import { el, select, button, fmtDate, drillDownModal } from '../core/ui.js';
import * as charts from '../core/charts.js';
import { STREAMS } from '../core/config.js';
import {
  availableYears, formatEUR, toEUR, byId, listActive, listActivePayments,
  propertyRevenueEUR, propertyExpensesEUR, propertyROI,
  renovationCapexEUR, groupByMonth, groupByStream,
  buildReportData, getForecastVsActual, buildReconciliationData,
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

let gFilters = { year: String(new Date().getFullYear()), streams: new Set(), propertyId: 'all' };
const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

export default {
  id: 'reports',
  label: 'Reports',
  icon: 'R',
  render(container) { container.appendChild(build()); },
  refresh() { const c = document.getElementById('content'); c.innerHTML = ''; c.appendChild(build()); },
  destroy() { charts.destroyAll(); }
};

function buildStreamMultiSelect(onRefresh) {
  const streamEntries = Object.entries(STREAMS);
  const wrapper = el('div', { style: 'position:relative' });

  const trigLabel = el('span', {}, 'All Streams');
  const trigger = el('div', {
    class: 'select',
    style: 'cursor:pointer;display:flex;align-items:center;width:auto;min-width:150px;user-select:none'
  }, trigLabel);

  const menu = el('div', {
    style: 'display:none;position:absolute;top:calc(100% + 4px);left:0;z-index:300;background:var(--bg-elev-2);border:1px solid var(--border);border-radius:var(--radius-sm);min-width:200px;box-shadow:0 4px 16px rgba(0,0,0,0.35);padding:4px 0'
  });

  const allChk = el('input', { type: 'checkbox' });
  menu.appendChild(el('label', { style: 'display:flex;align-items:center;gap:8px;padding:6px 12px;cursor:pointer;border-bottom:1px solid var(--border);font-size:13px' },
    allChk, el('span', {}, 'All Streams')));

  const chks = streamEntries.map(([key, meta]) => {
    const chk = el('input', { type: 'checkbox' });
    chk.dataset.key = key;
    chk.checked = gFilters.streams.size === 0 || gFilters.streams.has(key);
    menu.appendChild(el('label', { style: 'display:flex;align-items:center;gap:8px;padding:6px 12px;cursor:pointer;font-size:13px' },
      chk, el('span', { class: `badge ${meta.css}` }, meta.label)));
    return chk;
  });

  const sync = () => {
    const sel = chks.filter(c => c.checked);
    const n = sel.length;
    allChk.checked = n === chks.length; allChk.indeterminate = n > 0 && n < chks.length;
    trigLabel.textContent = n === chks.length ? 'All Streams' : n === 0 ? 'No Streams' : n === 1 ? (STREAMS[sel[0].dataset.key]?.label || '') : `${n} Streams`;
    gFilters.streams = n === chks.length ? new Set() : new Set(sel.map(c => c.dataset.key));
  };

  allChk.checked = gFilters.streams.size === 0;
  allChk.onchange = () => { chks.forEach(c => { c.checked = allChk.checked; }); allChk.indeterminate = false; sync(); onRefresh(); };
  chks.forEach(chk => { chk.onchange = () => { sync(); onRefresh(); }; });

  trigger.onclick = e => { e.stopPropagation(); menu.style.display = menu.style.display === 'none' ? '' : 'none'; };
  menu.onclick = e => e.stopPropagation();
  document.addEventListener('click', () => { menu.style.display = 'none'; });

  wrapper.appendChild(trigger); wrapper.appendChild(menu);
  sync();
  return wrapper;
}

function build() {
  const wrap = el('div', { class: 'view active' });

  // Global filter bar
  const years = availableYears();
  const yearSel = select([{ value: 'all', label: 'All Years' }, ...years.map(y => ({ value: y, label: y }))], gFilters.year);
  const filterBar = el('div', { class: 'flex gap-8 mb-16', style: 'flex-wrap:wrap' });
  filterBar.appendChild(el('span', { class: 'muted', style: 'align-self:center' }, 'Filter:'));
  filterBar.appendChild(yearSel);
  filterBar.appendChild(buildStreamMultiSelect(() => refreshActive()));
  const rentalProps = (listActive('properties')).filter(p => p.type === 'short_term' || p.type === 'long_term');
  const propSel = select([
    { value: 'all', label: 'All Properties' },
    ...rentalProps.map(p => ({ value: p.id, label: `${p.name} (${p.type === 'short_term' ? 'ST' : 'LT'})` }))
  ], gFilters.propertyId);
  filterBar.appendChild(propSel);
  filterBar.appendChild(el('div', { class: 'flex-1' }));
  filterBar.appendChild(button('Print / PDF', { onClick: () => window.print() }));
  wrap.appendChild(filterBar);

  yearSel.onchange = () => { gFilters.year = yearSel.value; refreshActive(); };
  propSel.onchange = () => { gFilters.propertyId = propSel.value; refreshActive(); };

  // Tabs
  const tabDefs = [
    { id: 'summary', label: 'Summary' },
    { id: 'property', label: 'By Property' },
    { id: 'stream', label: 'By Stream' },
    { id: 'reconciliation', label: 'Reconciliation' },
    { id: 'comparison', label: 'Comparison' },
    { id: 'contribution', label: 'Contribution' }
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
    else if (id === 'contribution') renderContribution(s);
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
  let props = listActive('properties');
  if (gFilters.propertyId !== 'all') props = props.filter(p => p.id === gFilters.propertyId);
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
      const pays = (listActivePayments()).filter(pay => pay.propertyId === p.id && pay.status === 'paid' && (!yearStr || (pay.date || '').startsWith(yearStr)));
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
      labels: ['Giorgos', 'Rita', 'Both'],
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
  const curYear = gFilters.year !== 'all' ? gFilters.year : String(new Date().getFullYear());
  const years = availableYears();
  const yearOpts = [...new Set([String(Number(curYear) - 1), curYear, String(Number(curYear) + 1), ...years])].sort().reverse();

  // Controls: year + view toggle
  const yearSel = select(yearOpts.map(y => ({ value: y, label: y })), curYear);
  const viewMonthly = el('div', { class: 'tab active', style: 'padding:4px 12px;font-size:12px' }, 'Monthly');
  const viewYearly  = el('div', { class: 'tab',        style: 'padding:4px 12px;font-size:12px' }, 'Yearly');
  const viewTabs    = el('div', { class: 'tabs', style: 'display:inline-flex;margin-left:auto' }, viewMonthly, viewYearly);
  let currentView   = 'monthly';

  const bar = el('div', { class: 'flex gap-8 mb-16', style: 'align-items:center;flex-wrap:wrap' });
  bar.appendChild(yearSel);
  bar.appendChild(viewTabs);
  wrap.appendChild(bar);

  const kpiRow  = el('div', { class: 'grid grid-4 mb-16' });
  const content = el('div', {});
  wrap.appendChild(kpiRow);
  wrap.appendChild(content);

  // Entity selector only visible in monthly view
  const allEntities = () => buildReconciliationData(Number(yearSel.value));

  const kindBadge = kind =>
    kind === 'lt' ? el('span', { class: 'badge long' }, 'LT Rental') :
    kind === 'st' ? el('span', { class: 'badge short' }, 'ST Rental') :
                   el('span', { class: 'badge cs' }, 'Service');

  const statusBadge = (m) => {
    if (!m.isPast && m.expected === 0) return null;
    if (!m.isPast) return el('span', { class: 'badge' }, 'Upcoming');
    if (m.expected === 0) return null;
    if (m.actual >= m.expected) return el('span', { class: 'badge success' }, 'Reconciled');
    if (m.actual > 0) return el('span', { class: 'badge warning' }, 'Partial');
    return el('span', { class: 'badge danger' }, 'Missing');
  };

  const rowStyle = m => {
    if (!m.isPast || m.expected === 0) return {};
    if (m.actual >= m.expected) return {};
    if (m.actual > 0) return { style: 'background:rgba(245,158,11,.06)' };
    return { style: 'background:rgba(239,68,68,.05)' };
  };

  const rate = (act, exp) => exp > 0 ? Math.round((act / exp) * 100) : (act > 0 ? 100 : null);
  const rateBadge = (act, exp) => {
    const r = rate(act, exp);
    if (r === null) return el('span', { class: 'muted' }, '—');
    if (r >= 100) return el('span', { class: 'badge success' }, `${r}%`);
    if (r >= 75)  return el('span', { class: 'badge warning' }, `${r}%`);
    return el('span', { class: 'badge danger' }, `${r}%`);
  };

  const render = () => {
    charts.destroy('recon-chart');
    kpiRow.innerHTML = '';
    content.innerHTML = '';

    let entities = allEntities();
    if (gFilters.propertyId !== 'all') entities = entities.filter(e => e.id === gFilters.propertyId);
    const totExp = entities.reduce((s, e) => s + e.totExp, 0);
    const totAct = entities.reduce((s, e) => s + e.totAct, 0);
    const outstanding = entities.reduce((s, e) => s + Math.max(0, e.totExp - e.totAct), 0);
    const cr = rate(totAct, totExp);

    kpiRow.appendChild(kpi('Expected', formatEUR(totExp), ''));
    kpiRow.appendChild(kpi('Received', formatEUR(totAct), ''));
    kpiRow.appendChild(kpi('Outstanding', formatEUR(outstanding), outstanding > 0 ? 'danger' : 'success'));
    kpiRow.appendChild(kpi('Collection Rate', cr !== null ? `${cr}%` : '—', cr === null ? '' : cr >= 100 ? 'success' : cr >= 75 ? 'warning' : 'danger'));

    if (currentView === 'monthly') renderMonthly(entities);
    else renderYearly(entities);
  };

  const renderMonthly = (entities) => {
    if (entities.length === 0) { content.appendChild(el('div', { class: 'empty' }, 'No data')); return; }

    // Entity selector
    const entSel = select(entities.map(e => ({ value: e.id, label: e.label })), entities[0].id);
    const ebar = el('div', { class: 'flex gap-8 mb-12' });
    ebar.appendChild(entSel);
    content.appendChild(ebar);

    const tableWrap = el('div', { class: 'table-wrap' });
    const chartCard = el('div', { class: 'card mt-16' },
      el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'Expected vs Actual by Month')),
      el('div', { class: 'chart-wrap' }, el('canvas', { id: 'recon-chart' }))
    );
    content.appendChild(tableWrap);
    content.appendChild(chartCard);

    const drawEntity = () => {
      tableWrap.innerHTML = '';
      charts.destroy('recon-chart');
      const ent = entities.find(e => e.id === entSel.value);
      if (!ent) return;

      const visMonths = ent.months.filter(m => m.expected > 0 || m.actual > 0);

      const t = el('table', { class: 'table' });
      t.innerHTML = `<thead><tr>
        <th>Month</th><th class="right">Expected</th><th class="right">Received</th>
        <th class="right">Variance</th><th class="right">Rate</th><th>Status</th>
      </tr></thead>`;
      const tb = el('tbody');

      for (const m of ent.months) {
        if (m.expected === 0 && m.actual === 0) continue;
        const varEUR = m.actual - m.expected;
        const tr = el('tr', rowStyle(m));
        tr.appendChild(el('td', {}, MON[m.m - 1]));
        tr.appendChild(el('td', { class: 'right num' }, formatEUR(m.expected)));
        tr.appendChild(el('td', { class: 'right num' }, formatEUR(m.actual)));
        tr.appendChild(el('td', { class: `right num ${m.isPast && m.expected > 0 ? (varEUR >= 0 ? 'success' : 'danger') : 'muted'}` },
          m.expected > 0 ? formatEUR(varEUR) : '—'));
        tr.appendChild(el('td', { class: 'right' }, rateBadge(m.actual, m.expected)));
        const sb = statusBadge(m);
        tr.appendChild(el('td', {}, sb || ''));
        tb.appendChild(tr);
      }

      // Totals row
      const totExp = ent.totExp, totAct = ent.totAct;
      const totTr = el('tr', { style: 'font-weight:600;border-top:2px solid var(--border)' });
      totTr.appendChild(el('td', {}, 'Total'));
      totTr.appendChild(el('td', { class: 'right num' }, formatEUR(totExp)));
      totTr.appendChild(el('td', { class: 'right num' }, formatEUR(totAct)));
      totTr.appendChild(el('td', { class: `right num ${totAct >= totExp ? 'success' : 'danger'}` }, formatEUR(totAct - totExp)));
      totTr.appendChild(el('td', { class: 'right' }, rateBadge(totAct, totExp)));
      totTr.appendChild(el('td', {}));
      tb.appendChild(totTr);
      t.appendChild(tb);
      tableWrap.appendChild(t);

      // Chart
      setTimeout(() => {
        charts.bar('recon-chart', {
          labels: visMonths.map(m => MON[m.m - 1]),
          datasets: [
            { label: 'Expected', data: visMonths.map(m => Math.round(m.expected)), backgroundColor: 'rgba(99,102,241,0.45)', borderColor: '#6366f1', borderWidth: 1 },
            { label: 'Received', data: visMonths.map(m => Math.round(m.actual)), backgroundColor: visMonths.map(m =>
                !m.isPast ? '#94a3b8' : m.actual >= m.expected ? '#10b981' : m.actual > 0 ? '#f59e0b' : '#ef4444'
            )}
          ]
        });
      }, 0);
    };

    entSel.onchange = drawEntity;
    drawEntity();
  };

  const renderYearly = (entities) => {
    if (entities.length === 0) { content.appendChild(el('div', { class: 'empty' }, 'No data')); return; }

    const t = el('table', { class: 'table' });
    t.innerHTML = `<thead><tr>
      <th>Entity</th><th>Type</th><th class="right">Expected</th><th class="right">Received</th>
      <th class="right">Outstanding</th><th class="right">Rate</th>
    </tr></thead>`;
    const tb = el('tbody');

    for (const ent of entities) {
      if (ent.totExp === 0 && ent.totAct === 0) continue;
      const outstanding = Math.max(0, ent.totExp - ent.totAct);
      const tr = el('tr', outstanding > 0 && ent.totAct < ent.totExp ? { style: outstanding > ent.totExp * 0.25 ? 'background:rgba(239,68,68,.05)' : 'background:rgba(245,158,11,.06)' } : {});
      tr.appendChild(el('td', { style: 'font-weight:500' }, ent.label));
      tr.appendChild(el('td', {}, kindBadge(ent.kind)));
      tr.appendChild(el('td', { class: 'right num' }, formatEUR(ent.totExp)));
      tr.appendChild(el('td', { class: 'right num' }, formatEUR(ent.totAct)));
      tr.appendChild(el('td', { class: `right num ${outstanding > 0 ? 'danger' : 'success'}` }, outstanding > 0 ? formatEUR(outstanding) : '—'));
      tr.appendChild(el('td', { class: 'right' }, rateBadge(ent.totAct, ent.totExp)));
      tb.appendChild(tr);
    }

    // Grand total
    const gExp = entities.reduce((s, e) => s + e.totExp, 0);
    const gAct = entities.reduce((s, e) => s + e.totAct, 0);
    const gOut = Math.max(0, gExp - gAct);
    const totTr = el('tr', { style: 'font-weight:700;border-top:2px solid var(--border)' });
    totTr.appendChild(el('td', {}, 'Grand Total'));
    totTr.appendChild(el('td', {}));
    totTr.appendChild(el('td', { class: 'right num' }, formatEUR(gExp)));
    totTr.appendChild(el('td', { class: 'right num' }, formatEUR(gAct)));
    totTr.appendChild(el('td', { class: `right num ${gOut > 0 ? 'danger' : 'success'}` }, gOut > 0 ? formatEUR(gOut) : '—'));
    totTr.appendChild(el('td', { class: 'right' }, rateBadge(gAct, gExp)));
    tb.appendChild(totTr);
    t.appendChild(tb);
    content.appendChild(el('div', { class: 'table-wrap' }, t));

    // Bar chart
    const hasData = entities.filter(e => e.totExp > 0 || e.totAct > 0);
    const chartCard = el('div', { class: 'card mt-16' },
      el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, `${yearSel.value} Collection by Entity`)),
      el('div', { class: 'chart-wrap' }, el('canvas', { id: 'recon-chart' }))
    );
    content.appendChild(chartCard);
    setTimeout(() => {
      charts.bar('recon-chart', {
        labels: hasData.map(e => e.label),
        datasets: [
          { label: 'Expected', data: hasData.map(e => Math.round(e.totExp)), backgroundColor: 'rgba(99,102,241,0.45)', borderColor: '#6366f1', borderWidth: 1 },
          { label: 'Received', data: hasData.map(e => Math.round(e.totAct)), backgroundColor: hasData.map(e =>
              e.totAct >= e.totExp ? '#10b981' : e.totAct > 0 ? '#f59e0b' : '#ef4444'
          )}
        ],
        horizontal: true
      });
    }, 0);
  };

  viewMonthly.onclick = () => {
    [viewMonthly, viewYearly].forEach(t => t.classList.remove('active'));
    viewMonthly.classList.add('active');
    currentView = 'monthly'; render();
  };
  viewYearly.onclick = () => {
    [viewMonthly, viewYearly].forEach(t => t.classList.remove('active'));
    viewYearly.classList.add('active');
    currentView = 'yearly'; render();
  };
  yearSel.onchange = render;
  render();
}

// ===== COMPARISON TAB =====
function renderComparison(wrap) {
  const baseYear = gFilters.year !== 'all' ? Number(gFilters.year) : new Date().getFullYear();
  const props = (listActive('properties')).filter(p => p.status !== 'renovation');
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
            const pays = (listActivePayments()).filter(p => p.propertyId === ent.id && p.status === 'paid' && p.date >= s && p.date <= e);
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
            const pays = (listActivePayments()).filter(p => p.propertyId === ent.id && p.status === 'paid' && p.date >= s && p.date <= e);
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

// ===== CONTRIBUTION TAB =====
const CSTREAMS = [
  { key: 'short_term_rental',  color: '#8b5cf6', payType: 'payment' },
  { key: 'long_term_rental',   color: '#14b8a6', payType: 'payment' },
  { key: 'customer_success',   color: '#3b82f6', payType: 'invoice' },
  { key: 'marketing_services', color: '#ec4899', payType: 'invoice' }
];

function renderContribution(wrap) {
  const curYear = gFilters.year !== 'all' ? gFilters.year : String(new Date().getFullYear());
  const years = availableYears();
  const yearOpts = [...new Set([String(Number(curYear) - 1), curYear, String(Number(curYear) + 1), ...years])].sort().reverse();

  const streamLabel = key => STREAMS[key]?.label || key;

  const yearSel     = select(yearOpts.map(y => ({ value: y, label: y })), curYear);
  const viewMonthly = el('div', { class: 'tab active', style: 'padding:4px 12px;font-size:12px' }, 'Monthly');
  const viewYearly  = el('div', { class: 'tab',        style: 'padding:4px 12px;font-size:12px' }, 'Yearly');
  const viewTabs    = el('div', { class: 'tabs', style: 'display:inline-flex;margin-left:auto' }, viewMonthly, viewYearly);
  let currentView   = 'monthly';

  const ctrlBar = el('div', { class: 'flex gap-8 mb-16', style: 'align-items:center;flex-wrap:wrap' });
  ctrlBar.appendChild(yearSel);
  ctrlBar.appendChild(viewTabs);
  wrap.appendChild(ctrlBar);

  const kpiRow  = el('div', { class: 'grid grid-4 mb-16' });
  const content = el('div', {});
  wrap.appendChild(kpiRow);
  wrap.appendChild(content);

  // Collect revenue rows per stream for a given year prefix
  const streamRevData = (yr) => CSTREAMS.map(cs => {
    const label = streamLabel(cs.key);
    let rows;
    if (cs.payType === 'payment') {
      rows = (listActivePayments()).filter(p => p.status === 'paid' && p.stream === cs.key && (p.date || '').startsWith(yr) && (gFilters.propertyId === 'all' || p.propertyId === gFilters.propertyId));
    } else {
      rows = (state.db.invoices || []).filter(i => i.status === 'paid' && i.stream === cs.key && (i.issueDate || '').startsWith(yr));
    }
    const totalEUR = cs.payType === 'payment'
      ? rows.reduce((s, p) => s + toEUR(p.amount, p.currency), 0)
      : rows.reduce((s, i) => s + toEUR(i.total, i.currency), 0);
    return { ...cs, label, rows, totalEUR };
  });

  // Collect revenue per stream per month
  const monthlyRevData = (yr) => MON.map((mon, mi) => {
    const mk = `${yr}-${String(mi + 1).padStart(2, '0')}`;
    const streams = CSTREAMS.map(cs => {
      const label = streamLabel(cs.key);
      let rows;
      if (cs.payType === 'payment') {
        rows = (listActivePayments()).filter(p => p.status === 'paid' && p.stream === cs.key && (p.date || '').startsWith(mk) && (gFilters.propertyId === 'all' || p.propertyId === gFilters.propertyId));
      } else {
        rows = (state.db.invoices || []).filter(i => i.status === 'paid' && i.stream === cs.key && (i.issueDate || '').startsWith(mk));
      }
      const totalEUR = cs.payType === 'payment'
        ? rows.reduce((s, p) => s + toEUR(p.amount, p.currency), 0)
        : rows.reduce((s, i) => s + toEUR(i.total, i.currency), 0);
      return { ...cs, label, rows, totalEUR };
    });
    const total = streams.reduce((s, cs) => s + cs.totalEUR, 0);
    return { mk, mon, streams, total };
  });

  const drillStream = (cs, titleSuffix) => {
    const title = `${cs.label} — ${titleSuffix}`;
    if (cs.payType === 'payment') drillDownModal(title, drillRevRows(cs.rows, []), REV_COLS);
    else drillDownModal(title, drillRevRows([], cs.rows), REV_COLS);
  };

  const render = () => {
    charts.destroy('ctrib-stacked');
    charts.destroy('ctrib-donut');
    charts.destroy('ctrib-hbar');
    kpiRow.innerHTML = '';
    content.innerHTML = '';

    const yr = yearSel.value;
    const annual = streamRevData(yr);
    const total  = annual.reduce((s, cs) => s + cs.totalEUR, 0);

    for (const cs of annual) {
      const pct = total > 0 ? ((cs.totalEUR / total) * 100).toFixed(1) : '0.0';
      kpiRow.appendChild(kpi(cs.label, `${formatEUR(cs.totalEUR)} (${pct}%)`, '', () => drillStream(cs, yr)));
    }

    if (currentView === 'monthly') renderContribMonthly(annual, total, yr);
    else renderContribYearly(annual, total, yr);
  };

  const renderContribMonthly = (annual, total, yr) => {
    const months = monthlyRevData(yr);

    const chartCard = el('div', { class: 'card mb-16' },
      el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'Revenue Contribution by Month')),
      el('div', { class: 'chart-wrap tall' }, el('canvas', { id: 'ctrib-stacked' }))
    );
    content.appendChild(chartCard);

    // Detail table
    const t = el('table', { class: 'table' });
    const hdrs = annual.map(cs => `<th class="right">${cs.label}</th>`).join('');
    t.innerHTML = `<thead><tr><th>Month</th>${hdrs}<th class="right">Total</th></tr></thead>`;
    const tb = el('tbody');

    for (const mData of months) {
      if (mData.total === 0) continue;
      const tr = el('tr');
      tr.appendChild(el('td', {}, mData.mon));
      for (const cs of mData.streams) {
        const td = el('td', { class: 'right num', style: cs.totalEUR > 0 ? 'cursor:pointer' : '' }, cs.totalEUR > 0 ? formatEUR(cs.totalEUR) : '—');
        if (cs.totalEUR > 0) td.onclick = () => drillStream(cs, `${mData.mon} ${yr}`);
        tr.appendChild(td);
      }
      tr.appendChild(el('td', { class: 'right num' }, formatEUR(mData.total)));
      tb.appendChild(tr);
    }

    // Totals row with percentages
    const totTr = el('tr', { style: 'font-weight:600;border-top:2px solid var(--border)' });
    totTr.appendChild(el('td', {}, 'Total'));
    for (const cs of annual) {
      const pct = total > 0 ? ` (${((cs.totalEUR / total) * 100).toFixed(1)}%)` : '';
      totTr.appendChild(el('td', { class: 'right num' }, `${formatEUR(cs.totalEUR)}${pct}`));
    }
    totTr.appendChild(el('td', { class: 'right num' }, formatEUR(total)));
    tb.appendChild(totTr);
    t.appendChild(tb);
    content.appendChild(el('div', { class: 'table-wrap' }, t));

    setTimeout(() => {
      charts.bar('ctrib-stacked', {
        labels: MON,
        datasets: CSTREAMS.map((cs, ci) => ({
          label: streamLabel(cs.key),
          data: months.map(m => Math.round(m.streams[ci].totalEUR)),
          backgroundColor: cs.color
        })),
        stacked: true,
        onClickItem: (label, index, datasetIndex) => {
          const mData = months[index];
          const cs = mData && mData.streams[datasetIndex];
          if (!cs || cs.totalEUR === 0) return;
          drillStream(cs, `${mData.mon} ${yr}`);
        }
      });
    }, 0);
  };

  const renderContribYearly = (annual, total, yr) => {
    const chartRow = el('div', { class: 'grid grid-2 mb-16' },
      el('div', { class: 'card' },
        el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, `${yr} Revenue Share`)),
        el('div', { class: 'chart-wrap' }, el('canvas', { id: 'ctrib-donut' }))
      ),
      el('div', { class: 'card' },
        el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, `${yr} Absolute Revenue`)),
        el('div', { class: 'chart-wrap' }, el('canvas', { id: 'ctrib-hbar' }))
      )
    );
    content.appendChild(chartRow);

    const t = el('table', { class: 'table' });
    t.innerHTML = `<thead><tr><th>Stream</th><th class="right">Revenue (EUR)</th><th class="right">Share</th></tr></thead>`;
    const tb = el('tbody');
    for (const cs of annual) {
      const pct = total > 0 ? ((cs.totalEUR / total) * 100).toFixed(1) : '0.0';
      const tr = el('tr', { style: 'cursor:pointer' });
      tr.onclick = () => drillStream(cs, yr);
      tr.appendChild(el('td', {}, el('span', { class: `badge ${STREAMS[cs.key]?.css || ''}` }, cs.label)));
      tr.appendChild(el('td', { class: 'right num' }, formatEUR(cs.totalEUR)));
      tr.appendChild(el('td', { class: 'right num' }, `${pct}%`));
      tb.appendChild(tr);
    }
    const totTr = el('tr', { style: 'font-weight:600;border-top:2px solid var(--border)' });
    totTr.appendChild(el('td', {}, 'Total'));
    totTr.appendChild(el('td', { class: 'right num' }, formatEUR(total)));
    totTr.appendChild(el('td', { class: 'right num' }, '100%'));
    tb.appendChild(totTr);
    t.appendChild(tb);
    content.appendChild(el('div', { class: 'table-wrap' }, t));

    setTimeout(() => {
      charts.doughnut('ctrib-donut', {
        labels: annual.map(cs => cs.label),
        data: annual.map(cs => Math.round(cs.totalEUR)),
        colors: CSTREAMS.map(cs => cs.color),
        onClickItem: (label, index) => {
          const cs = annual[index];
          if (cs) drillStream(cs, yr);
        }
      });
      charts.bar('ctrib-hbar', {
        labels: annual.map(cs => cs.label),
        datasets: [{
          label: 'Revenue',
          data: annual.map(cs => Math.round(cs.totalEUR)),
          backgroundColor: CSTREAMS.map(cs => cs.color)
        }],
        horizontal: true,
        onClickItem: (label, index) => {
          const cs = annual[index];
          if (cs) drillStream(cs, yr);
        }
      });
    }, 0);
  };

  viewMonthly.onclick = () => {
    [viewMonthly, viewYearly].forEach(t => t.classList.remove('active'));
    viewMonthly.classList.add('active');
    currentView = 'monthly'; render();
  };
  viewYearly.onclick = () => {
    [viewMonthly, viewYearly].forEach(t => t.classList.remove('active'));
    viewYearly.classList.add('active');
    currentView = 'yearly'; render();
  };
  yearSel.onchange = render;
  render();
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
