// Forecast module: monthly grid per property/service, stored, tax estimation
import { state } from '../core/state.js';
import { el, select, input, button, formRow, toast, fmtDate } from '../core/ui.js';
import * as charts from '../core/charts.js';
import { formatEUR, toEUR, byId, newId, availableYears, getOrCreateForecast, saveForecastMonth, setForecastTaxRate, getForecastVsActual, estimateTaxForYear } from '../core/data.js';
import { STREAMS } from '../core/config.js';

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

export default {
  id: 'forecast',
  label: 'Forecast',
  icon: 'F',
  render(container) {
    container.appendChild(build());
  },
  refresh() { const c = document.getElementById('content'); c.innerHTML = ''; c.appendChild(build()); },
  destroy() { charts.destroyAll(); }
};

function build() {
  const wrap = el('div', { class: 'view active' });
  const tabs = el('div', { class: 'tabs' });
  const sections = {};

  const tabDefs = [
    { id: 'prop', label: 'Property Forecast' },
    { id: 'service', label: 'Service Forecast' },
    { id: 'tax', label: 'Tax Estimation' }
  ];

  tabDefs.forEach((td, i) => {
    const t = el('div', { class: 'tab' + (i === 0 ? ' active' : '') }, td.label);
    const s = el('div', { style: i === 0 ? '' : 'display:none' });
    sections[td.id] = s;
    t.onclick = () => {
      tabs.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
      t.classList.add('active');
      Object.values(sections).forEach(x => x.style.display = 'none');
      s.style.display = '';
      if (s.dataset.built !== '1') {
        s.dataset.built = '1';
        if (td.id === 'prop') buildPropertySection(s);
        else if (td.id === 'service') buildServiceSection(s);
        else buildTaxSection(s);
      }
    };
    tabs.appendChild(t);
    wrap.appendChild(s);
  });
  wrap.insertBefore(tabs, wrap.firstChild);

  // Build first tab immediately
  sections.prop.dataset.built = '1';
  buildPropertySection(sections.prop);
  return wrap;
}

// ===== PROPERTY FORECAST =====
function buildPropertySection(wrap) {
  const props = (state.db.properties || []).filter(p => p.status !== 'renovation');
  if (props.length === 0) { wrap.appendChild(el('div', { class: 'empty' }, 'No active properties to forecast')); return; }

  const year = new Date().getFullYear();
  const years = [year - 1, year, year + 1, year + 2];
  const propSel = select(props.map(p => ({ value: p.id, label: p.name })), props[0].id);
  const yearSel = select(years.map(y => ({ value: y, label: String(y) })), year);

  const controls = el('div', { class: 'flex gap-8 mb-16' });
  controls.appendChild(propSel);
  controls.appendChild(yearSel);
  wrap.appendChild(controls);

  const gridWrap = el('div', {});
  wrap.appendChild(gridWrap);

  const chartWrap = el('div', { class: 'grid grid-2 mt-16' },
    el('div', { class: 'card' },
      el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'Forecast vs Actual')),
      el('div', { class: 'chart-wrap' }, el('canvas', { id: 'fc-prop-chart' }))
    ),
    el('div', { class: 'card' },
      el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'Annual Summary' )),
      el('div', { id: 'fc-prop-summary' })
    )
  );
  wrap.appendChild(chartWrap);

  const render = () => {
    gridWrap.innerHTML = '';
    gridWrap.appendChild(buildMonthlyGrid(propSel.value, yearSel.value, 'property', () => { renderChart(); renderSummary(); }));
    renderChart();
    renderSummary();
  };

  const renderChart = () => {
    const { months } = getForecastVsActual('property', propSel.value, yearSel.value);
    charts.bar('fc-prop-chart', {
      labels: MONTHS,
      datasets: [
        { label: 'Forecast Rev', data: months.map(m => Math.round(m.forecastRev)), backgroundColor: 'rgba(99,102,241,0.5)', borderColor: '#6366f1', borderWidth: 1 },
        { label: 'Actual Rev', data: months.map(m => Math.round(m.actualRev)), backgroundColor: '#10b981' },
        { label: 'Variance', data: months.map(m => Math.round(m.revVariance)), backgroundColor: m => m.raw < 0 ? '#ef4444' : '#10b981' }
      ]
    });
  };

  const renderSummary = () => {
    const { forecast, months } = getForecastVsActual('property', propSel.value, yearSel.value);
    const forecastRev = months.reduce((s, m) => s + m.forecastRev, 0);
    const forecastExp = months.reduce((s, m) => s + m.forecastExp, 0);
    const actualRev = months.reduce((s, m) => s + m.actualRev, 0);
    const actualExp = months.reduce((s, m) => s + m.actualExp, 0);
    const el2 = document.getElementById('fc-prop-summary');
    if (!el2) return;
    el2.innerHTML = '';
    el2.appendChild(el('div', { class: 'flex-col gap-8', style: 'padding:16px' },
      summaryRow('Forecast Revenue', formatEUR(forecastRev)),
      summaryRow('Forecast Expenses', formatEUR(forecastExp)),
      summaryRow('Forecast Net', formatEUR(forecastRev - forecastExp)),
      el('hr', { style: 'border-color:var(--border);margin:8px 0' }),
      summaryRow('Actual Revenue YTD', formatEUR(actualRev)),
      summaryRow('Actual Expenses YTD', formatEUR(actualExp)),
      summaryRow('Actual Net YTD', formatEUR(actualRev - actualExp)),
      el('hr', { style: 'border-color:var(--border);margin:8px 0' }),
      summaryRow('Revenue Variance YTD', formatEUR(actualRev - forecastRev), actualRev >= forecastRev ? 'success' : 'danger'),
    ));
  };

  propSel.onchange = render;
  yearSel.onchange = render;
  render();
}

// ===== SERVICE FORECAST =====
function buildServiceSection(wrap) {
  const serviceEntities = [
    { id: 'customer_success', label: 'Customer Success' },
    { id: 'marketing_services', label: 'Marketing Services' }
  ];
  const year = new Date().getFullYear();
  const years = [year - 1, year, year + 1, year + 2];
  const streamSel = select(serviceEntities.map(s => ({ value: s.id, label: s.label })), serviceEntities[0].id);
  const yearSel = select(years.map(y => ({ value: y, label: String(y) })), year);

  const controls = el('div', { class: 'flex gap-8 mb-16' });
  controls.appendChild(streamSel);
  controls.appendChild(yearSel);
  wrap.appendChild(controls);

  const gridWrap = el('div', {});
  wrap.appendChild(gridWrap);

  const chartWrap = el('div', { class: 'card mt-16' },
    el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'Forecast vs Actual Invoiced')),
    el('div', { class: 'chart-wrap' }, el('canvas', { id: 'fc-svc-chart' }))
  );
  wrap.appendChild(chartWrap);

  const render = () => {
    gridWrap.innerHTML = '';
    gridWrap.appendChild(buildMonthlyGrid(streamSel.value, yearSel.value, 'service', renderChart));
    renderChart();
  };

  const renderChart = () => {
    const { months } = getForecastVsActual('service', streamSel.value, yearSel.value);
    charts.bar('fc-svc-chart', {
      labels: MONTHS,
      datasets: [
        { label: 'Forecast', data: months.map(m => Math.round(m.forecastRev)), backgroundColor: 'rgba(99,102,241,0.5)', borderColor: '#6366f1', borderWidth: 1 },
        { label: 'Invoiced (paid)', data: months.map(m => Math.round(m.actualRev)), backgroundColor: '#10b981' }
      ]
    });
  };

  streamSel.onchange = render;
  yearSel.onchange = render;
  render();
}

// ===== SHARED MONTHLY GRID =====
function buildMonthlyGrid(entityId, year, type, onChange) {
  const fc = getOrCreateForecast(type, entityId, year);

  const card = el('div', { class: 'card' });
  card.appendChild(el('div', { class: 'card-header' },
    el('div', { class: 'card-title' }, `Monthly Forecast — ${year}`),
    el('div', { class: 'muted', style: 'font-size:12px' }, 'Click any cell to edit')
  ));

  const t = el('table', { class: 'table' });
  t.innerHTML = `<thead><tr>
    <th>Month</th>
    <th class="right">Forecast Revenue</th>
    <th class="right">Forecast Expenses</th>
    <th class="right">Forecast Net</th>
    <th class="right">Actual Revenue</th>
    <th class="right">Variance</th>
  </tr></thead>`;
  const tb = el('tbody');

  const { months } = getForecastVsActual(type, entityId, year);
  const now = new Date();

  for (let i = 0; i < 12; i++) {
    const mData = months[i];
    const monthKey = mData.key;
    const isPast = new Date(year, i + 1, 0) < now;
    const tr = el('tr');
    tr.appendChild(el('td', {}, MONTHS[i]));

    const makeEditable = (field, current) => {
      const cell = el('td', { class: 'right num' }, formatEUR(current));
      cell.style.cursor = 'pointer';
      cell.title = 'Click to edit';
      cell.onclick = () => {
        const inp = el('input', { type: 'number', value: current, min: 0, style: 'width:100px;text-align:right;background:var(--bg-elev-3);border:1px solid var(--accent);border-radius:4px;padding:4px 6px;color:var(--text)' });
        cell.innerHTML = '';
        cell.appendChild(inp);
        inp.focus();
        inp.select();
        const commit = () => {
          const val = Number(inp.value) || 0;
          saveForecastMonth(fc.id, monthKey, { [field]: val });
          cell.innerHTML = '';
          cell.textContent = formatEUR(val);
          if (onChange) onChange();
        };
        inp.onblur = commit;
        inp.onkeydown = e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') { cell.textContent = formatEUR(current); } };
      };
      return cell;
    };

    const net = mData.forecastRev - mData.forecastExp;
    const varianceCls = mData.revVariance >= 0 ? '' : 'danger';
    tr.appendChild(makeEditable('revenue', mData.forecastRev));
    tr.appendChild(makeEditable('expenses', mData.forecastExp));
    tr.appendChild(el('td', { class: 'right num' + (net < 0 ? ' danger' : '') }, formatEUR(net)));
    tr.appendChild(el('td', { class: 'right num ' + (isPast ? '' : 'muted') }, formatEUR(mData.actualRev)));
    tr.appendChild(el('td', { class: `right num ${varianceCls}` }, isPast || mData.actualRev > 0 ? formatEUR(mData.revVariance) : '—'));
    tb.appendChild(tr);
  }
  t.appendChild(tb);
  const tw = el('div', { class: 'table-wrap' }); tw.appendChild(t);
  card.appendChild(tw);
  return card;
}

// ===== TAX ESTIMATION =====
function buildTaxSection(wrap) {
  const year = new Date().getFullYear();
  const years = [year - 1, year, year + 1];
  const yearSel = select(years.map(y => ({ value: y, label: String(y) })), year);
  const rateI = input({ type: 'number', value: state.db.settings?.globalTaxRate || 15, min: 0, max: 100, step: 0.1, style: 'width:80px' });

  const controls = el('div', { class: 'flex gap-8 mb-16 items-center' });
  controls.appendChild(el('span', { class: 'muted' }, 'Year:'));
  controls.appendChild(yearSel);
  controls.appendChild(el('span', { class: 'muted' }, 'Tax rate %:'));
  controls.appendChild(rateI);
  wrap.appendChild(controls);

  const resultsWrap = el('div', {});
  wrap.appendChild(resultsWrap);

  const chartCard = el('div', { class: 'card mt-16' },
    el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'Actual vs Forecast Tax')),
    el('div', { class: 'chart-wrap' }, el('canvas', { id: 'fc-tax-chart' }))
  );
  wrap.appendChild(chartCard);

  const render = () => {
    // Save rate
    if (state.db.settings) {
      state.db.settings.globalTaxRate = Number(rateI.value) || 0;
    }
    const data = estimateTaxForYear(yearSel.value, rateI.value);
    resultsWrap.innerHTML = '';
    resultsWrap.appendChild(el('div', { class: 'grid grid-4 mb-16' },
      kpi('Actual Revenue', formatEUR(data.rev)),
      kpi('Actual Expenses', formatEUR(data.exp)),
      kpi('Taxable Income (actual)', formatEUR(data.taxable)),
      kpi(`Estimated Tax @ ${data.rate}%`, formatEUR(data.estimatedTax), 'warning')
    ));
    resultsWrap.appendChild(el('div', { class: 'grid grid-4' },
      kpi('Forecast Revenue', formatEUR(data.forecastRev), 'info'),
      kpi('Taxable Income (forecast)', formatEUR(data.forecastTaxable)),
      kpi('Forecast Tax Liability', formatEUR(data.forecastTax), 'warning'),
      kpi('Variance vs Forecast', formatEUR(data.estimatedTax - data.forecastTax), data.estimatedTax > data.forecastTax ? 'danger' : 'success')
    ));

    // Chart: per-stream breakdown
    const streamKeys = ['short_term_rental', 'long_term_rental', 'customer_success', 'marketing_services'];
    const streamRevs = streamKeys.map(k => {
      const y = yearSel.value;
      const pays = (state.db.payments || []).filter(p => p.stream === k && p.status === 'paid' && p.date?.startsWith(String(y)));
      const invs = (state.db.invoices || []).filter(i => i.stream === k && i.status === 'paid' && i.issueDate?.startsWith(String(y)));
      return Math.round([...pays.map(p => toEUR(p.amount, p.currency)), ...invs.map(i => toEUR(i.total, i.currency))].reduce((a, b) => a + b, 0));
    });
    charts.bar('fc-tax-chart', {
      labels: streamKeys.map(k => STREAMS[k].short),
      datasets: [
        { label: 'Revenue', data: streamRevs, backgroundColor: '#10b981' },
        { label: `Est. Tax (${data.rate}%)`, data: streamRevs.map(r => Math.round(r * (data.rate / 100))), backgroundColor: '#f59e0b' }
      ]
    });
  };

  yearSel.onchange = render;
  rateI.oninput = render;
  render();
}

function summaryRow(label, value, variant) {
  return el('div', { class: 'flex justify-between items-center', style: 'padding:4px 0' },
    el('span', { class: 'muted', style: 'font-size:12px' }, label),
    el('span', { class: 'num ' + (variant || ''), style: 'font-weight:600' }, value)
  );
}

function kpi(label, value, variant) {
  return el('div', { class: 'kpi' + (variant ? ' ' + variant : '') },
    el('div', { class: 'kpi-label' }, label),
    el('div', { class: 'kpi-value', style: 'font-size:1.3rem' }, value),
    el('div', { class: 'kpi-accent-bar' })
  );
}
