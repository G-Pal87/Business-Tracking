// Reconciliation module – expected vs actual payment collection
import { el, select, button } from '../core/ui.js';
import * as charts from '../core/charts.js';
import { availableYears, formatEUR, buildReconciliationData } from '../core/data.js';

export default {
  id: 'reconciliation',
  label: 'Reconciliation',
  icon: '⇌',
  render(container) { container.appendChild(build()); },
  refresh() { const c = document.getElementById('content'); c.innerHTML = ''; c.appendChild(build()); },
  destroy() { charts.destroyAll(); }
};

const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function build() {
  const wrap = el('div', { class: 'view active' });
  const curYear = String(new Date().getFullYear());
  const years = availableYears();
  const yearOpts = [...new Set([String(Number(curYear) - 1), curYear, String(Number(curYear) + 1), ...years])].sort().reverse();

  const yearSel     = select(yearOpts.map(y => ({ value: y, label: y })), curYear);
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

  const kindBadge = kind =>
    kind === 'lt' ? el('span', { class: 'badge long' }, 'LT Rental') :
    kind === 'st' ? el('span', { class: 'badge short' }, 'ST Rental') :
                   el('span', { class: 'badge cs' }, 'Service');

  const statusBadge = m => {
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

    const entities = buildReconciliationData(Number(yearSel.value));
    const totExp = entities.reduce((s, e) => s + e.totExp, 0);
    const totAct = entities.reduce((s, e) => s + e.totAct, 0);
    const outstanding = entities.reduce((s, e) => s + Math.max(0, e.totExp - e.totAct), 0);
    const cr = rate(totAct, totExp);

    kpiRow.appendChild(kpi('Expected',        formatEUR(totExp),     ''));
    kpiRow.appendChild(kpi('Received',         formatEUR(totAct),     ''));
    kpiRow.appendChild(kpi('Outstanding',      formatEUR(outstanding), outstanding > 0 ? 'danger' : 'success'));
    kpiRow.appendChild(kpi('Collection Rate',  cr !== null ? `${cr}%` : '—', cr === null ? '' : cr >= 100 ? 'success' : cr >= 75 ? 'warning' : 'danger'));

    if (currentView === 'monthly') renderMonthly(entities);
    else renderYearly(entities);
  };

  const renderMonthly = entities => {
    if (entities.length === 0) { content.appendChild(el('div', { class: 'empty' }, 'No data')); return; }

    const entSel   = select(entities.map(e => ({ value: e.id, label: e.label })), entities[0].id);
    const ebar     = el('div', { class: 'flex gap-8 mb-12' }, entSel);
    const tableWrap = el('div', { class: 'table-wrap' });
    const chartCard = el('div', { class: 'card mt-16' },
      el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'Expected vs Actual by Month')),
      el('div', { class: 'chart-wrap' }, el('canvas', { id: 'recon-chart' }))
    );
    content.appendChild(ebar);
    content.appendChild(tableWrap);
    content.appendChild(chartCard);

    const drawEntity = () => {
      tableWrap.innerHTML = '';
      charts.destroy('recon-chart');
      const ent = entities.find(e => e.id === entSel.value);
      if (!ent) return;

      const visMonths = ent.months.filter(m => m.expected > 0 || m.actual > 0);
      const t  = el('table', { class: 'table' });
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
        tr.appendChild(el('td', {}, statusBadge(m) || ''));
        tb.appendChild(tr);
      }

      const totTr = el('tr', { style: 'font-weight:600;border-top:2px solid var(--border)' });
      totTr.appendChild(el('td', {}, 'Total'));
      totTr.appendChild(el('td', { class: 'right num' }, formatEUR(ent.totExp)));
      totTr.appendChild(el('td', { class: 'right num' }, formatEUR(ent.totAct)));
      totTr.appendChild(el('td', { class: `right num ${ent.totAct >= ent.totExp ? 'success' : 'danger'}` }, formatEUR(ent.totAct - ent.totExp)));
      totTr.appendChild(el('td', { class: 'right' }, rateBadge(ent.totAct, ent.totExp)));
      totTr.appendChild(el('td', {}));
      tb.appendChild(totTr);
      t.appendChild(tb);
      tableWrap.appendChild(t);

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

  const renderYearly = entities => {
    if (entities.length === 0) { content.appendChild(el('div', { class: 'empty' }, 'No data')); return; }

    const t = el('table', { class: 'table' });
    t.innerHTML = `<thead><tr>
      <th>Entity</th><th>Type</th><th class="right">Expected</th><th class="right">Received</th>
      <th class="right">Outstanding</th><th class="right">Rate</th>
    </tr></thead>`;
    const tb = el('tbody');

    for (const ent of entities) {
      if (ent.totExp === 0 && ent.totAct === 0) continue;
      const out = Math.max(0, ent.totExp - ent.totAct);
      const tr  = el('tr', out > 0 ? { style: out > ent.totExp * 0.25 ? 'background:rgba(239,68,68,.05)' : 'background:rgba(245,158,11,.06)' } : {});
      tr.appendChild(el('td', { style: 'font-weight:500' }, ent.label));
      tr.appendChild(el('td', {}, kindBadge(ent.kind)));
      tr.appendChild(el('td', { class: 'right num' }, formatEUR(ent.totExp)));
      tr.appendChild(el('td', { class: 'right num' }, formatEUR(ent.totAct)));
      tr.appendChild(el('td', { class: `right num ${out > 0 ? 'danger' : 'success'}` }, out > 0 ? formatEUR(out) : '—'));
      tr.appendChild(el('td', { class: 'right' }, rateBadge(ent.totAct, ent.totExp)));
      tb.appendChild(tr);
    }

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
  return wrap;
}

function kpi(label, value, variant) {
  return el('div', { class: 'kpi' + (variant ? ' ' + variant : '') },
    el('div', { class: 'kpi-label' }, label),
    el('div', { class: 'kpi-value' }, value),
    el('div', { class: 'kpi-accent-bar' })
  );
}
