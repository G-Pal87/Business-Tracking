// Forecast module: monthly grid per property/service, stored, tax estimation
import { state } from '../core/state.js';
import { el, select, input, button, formRow, toast, fmtDate, openModal, closeModal } from '../core/ui.js';
import * as charts from '../core/charts.js';
import { formatEUR, toEUR, byId, newId, availableYears, getOrCreateForecast, saveForecastMonth, saveForecastYear, setForecastTaxRate, getForecastVsActual, estimateTaxForYear, getForecastEntries, upsertForecastEntry, removeForecastEntry } from '../core/data.js';
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

  // --- Property checklist dropdown (matches Reports "All Streams" pattern) ---
  let selectedPropIds = new Set(props.map(p => p.id));

  const getSelIds = () => selectedPropIds.size > 0 ? [...selectedPropIds] : [props[0].id];

  const propWrapper = el('div', { style: 'position:relative' });
  const trigLabel = el('span', {}, 'All Properties');
  const propTrigger = el('div', {
    class: 'select',
    style: 'cursor:pointer;display:flex;align-items:center;width:auto;min-width:160px;user-select:none'
  }, trigLabel);

  const propMenu = el('div', {
    style: 'display:none;position:absolute;top:calc(100% + 4px);left:0;z-index:300;background:var(--bg-elev-2);border:1px solid var(--border);border-radius:var(--radius-sm);min-width:220px;box-shadow:0 4px 16px rgba(0,0,0,0.35);padding:4px 0'
  });

  const allChk = el('input', { type: 'checkbox' });
  allChk.checked = true;
  propMenu.appendChild(el('label', { style: 'display:flex;align-items:center;gap:8px;padding:6px 12px;cursor:pointer;border-bottom:1px solid var(--border);font-size:13px' },
    allChk, el('span', {}, 'All Properties')));

  const propChks = props.map(p => {
    const chk = el('input', { type: 'checkbox' });
    chk.dataset.id = p.id;
    chk.checked = true;
    propMenu.appendChild(el('label', { style: 'display:flex;align-items:center;gap:8px;padding:6px 12px;cursor:pointer;font-size:13px' },
      chk, el('span', {}, p.name)));
    return chk;
  });

  const syncPropSel = () => {
    const sel = propChks.filter(c => c.checked);
    const n = sel.length;
    allChk.checked = n === propChks.length;
    allChk.indeterminate = n > 0 && n < propChks.length;
    trigLabel.textContent = n === propChks.length ? 'All Properties'
      : n === 0 ? 'No Properties'
      : n === 1 ? (props.find(p => p.id === sel[0].dataset.id)?.name || '1 Property')
      : `${n} Properties`;
    selectedPropIds = new Set(sel.map(c => c.dataset.id));
  };

  allChk.onchange = () => {
    propChks.forEach(c => { c.checked = allChk.checked; });
    allChk.indeterminate = false;
    syncPropSel();
    render();
  };
  propChks.forEach(chk => { chk.onchange = () => { syncPropSel(); render(); }; });

  propTrigger.onclick = e => { e.stopPropagation(); propMenu.style.display = propMenu.style.display === 'none' ? '' : 'none'; };
  propMenu.onclick = e => e.stopPropagation();
  document.addEventListener('click', () => { propMenu.style.display = 'none'; });

  propWrapper.appendChild(propTrigger);
  propWrapper.appendChild(propMenu);
  // -------------------------------------------------------------------------

  const yearSel = el('select', { class: 'select' });

  const updateYearOptions = () => {
    const selIds = getSelIds();
    const forecasts = (state.db.forecasts || []).filter(f => f.type === 'property' && selIds.includes(f.entityId));
    const years = new Set(forecasts.map(f => String(f.year)));
    availableYears().forEach(y => years.add(y));
    const sorted = [...years].sort();
    const prev = yearSel.value;
    yearSel.innerHTML = '';
    sorted.forEach(y => {
      const o = document.createElement('option');
      o.value = y; o.textContent = y;
      if (y === prev) o.selected = true;
      yearSel.appendChild(o);
    });
    if (!yearSel.value && sorted.length) yearSel.value = sorted[sorted.length - 1];
  };

  updateYearOptions();

  const controls = el('div', { class: 'flex gap-8 mb-16', style: 'align-items:flex-start' });
  controls.appendChild(propWrapper);
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
      el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'Annual Summary')),
      el('div', { id: 'fc-prop-summary' })
    )
  );
  wrap.appendChild(chartWrap);

  const getAggregated = () => {
    const propIds = getSelIds();
    const year = yearSel.value;
    const results = propIds.map(id => getForecastVsActual('property', id, year));
    const months = results[0].months.map((_, i) => ({
      key: results[0].months[i].key,
      forecastRev: results.reduce((s, r) => s + r.months[i].forecastRev, 0),
      forecastExp: results.reduce((s, r) => s + r.months[i].forecastExp, 0),
      actualRev:   results.reduce((s, r) => s + r.months[i].actualRev, 0),
      actualExp:   results.reduce((s, r) => s + r.months[i].actualExp, 0),
      revVariance: results.reduce((s, r) => s + r.months[i].revVariance, 0),
    }));
    const yearTarget = {
      revenue:  results.reduce((s, r) => s + (r.yearTarget?.revenue || 0), 0),
      expenses: results.reduce((s, r) => s + (r.yearTarget?.expenses || 0), 0),
    };
    return { months, yearTarget };
  };

  const render = () => {
    updateYearOptions();
    const selIds = getSelIds();
    gridWrap.innerHTML = '';
    if (selIds.length === 1) {
      gridWrap.appendChild(buildMonthlyGrid(selIds[0], yearSel.value, 'property', () => { renderChart(); renderSummary(); }));
    } else {
      gridWrap.appendChild(buildAggregatedGrid(selIds, yearSel.value));
    }
    renderChart();
    renderSummary();
  };

  const renderChart = () => {
    const { months } = getAggregated();
    charts.bar('fc-prop-chart', {
      labels: MONTHS,
      datasets: [
        { label: 'Forecast Rev', data: months.map(m => Math.round(m.forecastRev)), backgroundColor: 'rgba(99,102,241,0.5)', borderColor: '#6366f1', borderWidth: 1 },
        { label: 'Actual Rev',   data: months.map(m => Math.round(m.actualRev)),   backgroundColor: '#10b981' },
        { label: 'Variance',     data: months.map(m => Math.round(m.revVariance)), backgroundColor: m => m.raw < 0 ? '#ef4444' : '#10b981' }
      ]
    });
  };

  const renderSummary = () => {
    const { months, yearTarget } = getAggregated();
    const forecastRev = months.reduce((s, m) => s + m.forecastRev, 0);
    const forecastExp = months.reduce((s, m) => s + m.forecastExp, 0);
    const actualRev   = months.reduce((s, m) => s + m.actualRev, 0);
    const actualExp   = months.reduce((s, m) => s + m.actualExp, 0);
    const el2 = document.getElementById('fc-prop-summary');
    if (!el2) return;
    el2.innerHTML = '';
    const items = [
      summaryRow('Forecast Revenue',      formatEUR(forecastRev)),
      summaryRow('Forecast Expenses',     formatEUR(forecastExp)),
      summaryRow('Forecast Net',          formatEUR(forecastRev - forecastExp)),
      el('hr', { style: 'border-color:var(--border);margin:8px 0' }),
      summaryRow('Actual Revenue YTD',    formatEUR(actualRev)),
      summaryRow('Actual Expenses YTD',   formatEUR(actualExp)),
      summaryRow('Actual Net YTD',        formatEUR(actualRev - actualExp)),
      el('hr', { style: 'border-color:var(--border);margin:8px 0' }),
      summaryRow('Revenue Variance YTD',  formatEUR(actualRev - forecastRev), actualRev >= forecastRev ? 'success' : 'danger'),
    ];
    if (yearTarget.revenue || yearTarget.expenses) {
      const ytRev = yearTarget.revenue || 0;
      items.push(
        el('hr', { style: 'border-color:var(--border);margin:8px 0' }),
        summaryRow('Annual Target Revenue',  formatEUR(ytRev)),
        summaryRow('Annual Target Expenses', formatEUR(yearTarget.expenses || 0)),
        summaryRow('Forecast vs Target',     formatEUR(forecastRev - ytRev), forecastRev >= ytRev ? 'success' : 'danger'),
        summaryRow('Actual vs Target',       formatEUR(actualRev   - ytRev), actualRev   >= ytRev ? 'success' : 'danger'),
      );
    }
    el2.appendChild(el('div', { class: 'flex-col gap-8', style: 'padding:16px' }, ...items));
  };

  yearSel.onchange = render;
  render();
}

// ===== SERVICE FORECAST =====
function buildServiceSection(wrap) {
  const serviceEntities = [
    { id: 'customer_success', label: 'Customer Success' },
    { id: 'marketing_services', label: 'Marketing Services' }
  ];

  // --- Service checklist dropdown (matches Property Forecast / Reports pattern) ---
  let selectedStreamIds = new Set(serviceEntities.map(s => s.id));

  const getSelIds = () => selectedStreamIds.size > 0 ? [...selectedStreamIds] : [serviceEntities[0].id];

  const svcWrapper = el('div', { style: 'position:relative' });
  const trigLabel = el('span', {}, 'All Services');
  const svcTrigger = el('div', {
    class: 'select',
    style: 'cursor:pointer;display:flex;align-items:center;width:auto;min-width:160px;user-select:none'
  }, trigLabel);

  const svcMenu = el('div', {
    style: 'display:none;position:absolute;top:calc(100% + 4px);left:0;z-index:300;background:var(--bg-elev-2);border:1px solid var(--border);border-radius:var(--radius-sm);min-width:220px;box-shadow:0 4px 16px rgba(0,0,0,0.35);padding:4px 0'
  });

  const allSvcChk = el('input', { type: 'checkbox' });
  allSvcChk.checked = true;
  svcMenu.appendChild(el('label', { style: 'display:flex;align-items:center;gap:8px;padding:6px 12px;cursor:pointer;border-bottom:1px solid var(--border);font-size:13px' },
    allSvcChk, el('span', {}, 'All Services')));

  const svcChks = serviceEntities.map(s => {
    const chk = el('input', { type: 'checkbox' });
    chk.dataset.id = s.id;
    chk.checked = true;
    svcMenu.appendChild(el('label', { style: 'display:flex;align-items:center;gap:8px;padding:6px 12px;cursor:pointer;font-size:13px' },
      chk, el('span', {}, s.label)));
    return chk;
  });

  const syncSvcSel = () => {
    const sel = svcChks.filter(c => c.checked);
    const n = sel.length;
    allSvcChk.checked = n === svcChks.length;
    allSvcChk.indeterminate = n > 0 && n < svcChks.length;
    trigLabel.textContent = n === svcChks.length ? 'All Services'
      : n === 0 ? 'No Services'
      : n === 1 ? (serviceEntities.find(s => s.id === sel[0].dataset.id)?.label || '1 Service')
      : `${n} Services`;
    selectedStreamIds = new Set(sel.map(c => c.dataset.id));
  };

  allSvcChk.onchange = () => { svcChks.forEach(c => { c.checked = allSvcChk.checked; }); allSvcChk.indeterminate = false; syncSvcSel(); render(); };
  svcChks.forEach(chk => { chk.onchange = () => { syncSvcSel(); render(); }; });

  svcTrigger.onclick = e => { e.stopPropagation(); svcMenu.style.display = svcMenu.style.display === 'none' ? '' : 'none'; };
  svcMenu.onclick = e => e.stopPropagation();
  document.addEventListener('click', () => { svcMenu.style.display = 'none'; });

  svcWrapper.appendChild(svcTrigger);
  svcWrapper.appendChild(svcMenu);
  // -------------------------------------------------------------------------

  const yearSel = el('select', { class: 'select' });

  const updateYearOptions = () => {
    const selIds = getSelIds();
    const forecasts = (state.db.forecasts || []).filter(f => f.type === 'service' && selIds.includes(f.entityId));
    const years = new Set(forecasts.map(f => String(f.year)));
    availableYears().forEach(y => years.add(y));
    const sorted = [...years].sort();
    const prev = yearSel.value;
    yearSel.innerHTML = '';
    sorted.forEach(y => {
      const o = document.createElement('option');
      o.value = y; o.textContent = y;
      if (y === prev) o.selected = true;
      yearSel.appendChild(o);
    });
    if (!yearSel.value && sorted.length) yearSel.value = sorted[sorted.length - 1];
  };

  updateYearOptions();

  const controls = el('div', { class: 'flex gap-8 mb-16' });
  controls.appendChild(svcWrapper);
  controls.appendChild(yearSel);
  wrap.appendChild(controls);

  const gridWrap = el('div', {});
  wrap.appendChild(gridWrap);

  const chartWrap = el('div', { class: 'grid grid-2 mt-16' },
    el('div', { class: 'card' },
      el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'Forecast vs Actual Invoiced')),
      el('div', { class: 'chart-wrap' }, el('canvas', { id: 'fc-svc-chart' }))
    ),
    el('div', { class: 'card' },
      el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'Annual Summary')),
      el('div', { id: 'fc-svc-summary' })
    )
  );
  wrap.appendChild(chartWrap);

  const getAggregated = () => {
    const streamIds = getSelIds();
    const year = yearSel.value;
    const results = streamIds.map(id => getForecastVsActual('service', id, year));
    const months = results[0].months.map((_, i) => ({
      key: results[0].months[i].key,
      forecastRev: results.reduce((s, r) => s + r.months[i].forecastRev, 0),
      forecastExp: results.reduce((s, r) => s + r.months[i].forecastExp, 0),
      actualRev:   results.reduce((s, r) => s + r.months[i].actualRev, 0),
      actualExp:   results.reduce((s, r) => s + r.months[i].actualExp, 0),
      revVariance: results.reduce((s, r) => s + r.months[i].revVariance, 0),
    }));
    const yearTarget = { revenue: results.reduce((s, r) => s + (r.yearTarget?.revenue || 0), 0) };
    return { months, yearTarget };
  };

  const render = () => {
    updateYearOptions();
    const selIds = getSelIds();
    gridWrap.innerHTML = '';
    if (selIds.length === 1) {
      gridWrap.appendChild(buildMonthlyGrid(selIds[0], yearSel.value, 'service', () => { renderChart(); renderSummary(); }));
    } else {
      gridWrap.appendChild(buildAggregatedGrid(selIds, yearSel.value, 'service'));
    }
    renderChart();
    renderSummary();
  };

  const renderChart = () => {
    const { months } = getAggregated();
    charts.bar('fc-svc-chart', {
      labels: MONTHS,
      datasets: [
        { label: 'Forecast', data: months.map(m => Math.round(m.forecastRev)), backgroundColor: 'rgba(99,102,241,0.5)', borderColor: '#6366f1', borderWidth: 1 },
        { label: 'Invoiced (paid)', data: months.map(m => Math.round(m.actualRev)), backgroundColor: '#10b981' }
      ]
    });
  };

  const renderSummary = () => {
    const { months, yearTarget } = getAggregated();
    const forecastRev = months.reduce((s, m) => s + m.forecastRev, 0);
    const actualRev   = months.reduce((s, m) => s + m.actualRev,   0);
    const el2 = document.getElementById('fc-svc-summary');
    if (!el2) return;
    el2.innerHTML = '';
    const items = [
      summaryRow('Forecast Revenue', formatEUR(forecastRev)),
      el('hr', { style: 'border-color:var(--border);margin:8px 0' }),
      summaryRow('Actual Revenue YTD', formatEUR(actualRev)),
      el('hr', { style: 'border-color:var(--border);margin:8px 0' }),
      summaryRow('Revenue Variance YTD', formatEUR(actualRev - forecastRev), actualRev >= forecastRev ? 'success' : 'danger'),
    ];
    if (yearTarget.revenue) {
      const ytRev = yearTarget.revenue;
      items.push(
        el('hr', { style: 'border-color:var(--border);margin:8px 0' }),
        summaryRow('Annual Target', formatEUR(ytRev)),
        summaryRow('Forecast vs Target', formatEUR(forecastRev - ytRev), forecastRev >= ytRev ? 'success' : 'danger'),
        summaryRow('Actual vs Target', formatEUR(actualRev - ytRev), actualRev >= ytRev ? 'success' : 'danger'),
      );
    }
    el2.appendChild(el('div', { class: 'flex-col gap-8', style: 'padding:16px' }, ...items));
  };

  yearSel.onchange = render;
  render();
}

// ===== SHARED MONTHLY GRID =====
function buildMonthlyGrid(entityId, year, type, onChange) {
  const fc = getOrCreateForecast(type, entityId, year);
  const now = new Date();

  const card = el('div', { class: 'card' });
  card.appendChild(el('div', { class: 'card-header' },
    el('div', { class: 'card-title' }, `Monthly Forecast — ${year}`),
    el('div', { class: 'muted', style: 'font-size:12px' }, 'Click any cell to edit')
  ));

  // Annual target bar
  const annualBar = el('div', { class: 'flex gap-16 items-center', style: 'padding:10px 16px;background:var(--bg-elev-2);border-bottom:1px solid var(--border);font-size:12px;flex-wrap:wrap;gap:12px' });
  card.appendChild(annualBar);

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
  renderRows();
  t.appendChild(tb);
  const tw = el('div', { class: 'table-wrap' }); tw.appendChild(t);
  card.appendChild(tw);

  renderAnnualBar();
  return card;

  function renderAnnualBar() {
    annualBar.innerHTML = '';
    annualBar.appendChild(el('span', { style: 'font-weight:600;color:var(--text-muted);letter-spacing:.04em;font-size:11px;white-space:nowrap' }, 'ANNUAL TARGET'));
    const targetFields = type === 'property'
      ? [['revenue', 'Revenue'], ['expenses', 'Expenses']]
      : [['revenue', 'Revenue']];
    for (const [field, label] of targetFields) {
      const valSpan = el('span', { class: 'num', style: 'cursor:pointer;font-weight:600', title: 'Click to edit' });
      valSpan.textContent = formatEUR((fc.yearTarget || {})[field] || 0);
      valSpan.onclick = () => {
        const inp = el('input', { type: 'number', value: (fc.yearTarget || {})[field] || 0, min: 0,
          style: 'width:120px;text-align:right;background:var(--bg-elev-3);border:1px solid var(--accent);border-radius:4px;padding:4px 6px;color:var(--text)' });
        valSpan.replaceWith(inp); inp.focus(); inp.select();
        const commit = () => {
          const v = Number(inp.value) || 0;
          saveForecastYear(fc.id, { [field]: v });
          inp.replaceWith(valSpan);
          valSpan.textContent = formatEUR(v);
          rebuildTotals();
          if (onChange) onChange();
        };
        inp.onblur = commit;
        inp.onkeydown = e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') inp.replaceWith(valSpan); };
      };
      const grp = el('span', { class: 'flex gap-4 items-center' });
      grp.appendChild(el('span', { class: 'muted' }, label + ':'));
      grp.appendChild(valSpan);
      annualBar.appendChild(grp);
    }
    annualBar.appendChild(button('Distribute evenly', { variant: 'sm ghost', onClick: () => {
      const yt = fc.yearTarget || {};
      const rev12 = Math.round((yt.revenue || 0) / 12);
      for (let m = 1; m <= 12; m++) {
        const data = { revenue: rev12 };
        if (type === 'property') {
          data.expenses = Math.round((yt.expenses || 0) / 12);
          data.expenseEntries = [];
        }
        saveForecastMonth(fc.id, `${year}-${String(m).padStart(2, '0')}`, data);
      }
      renderRows();
      if (onChange) onChange();
    }}));
  }

  function renderRows() {
    tb.innerHTML = '';
    const { months, yearTarget } = getForecastVsActual(type, entityId, year);
    for (let i = 0; i < 12; i++) {
      const mData = months[i];
      const monthKey = mData.key;
      const isPast = new Date(Number(year), i + 1, 0) < now;
      const tr = el('tr');
      tr.appendChild(el('td', {}, MONTHS[i]));

      function makeEditable(field, current) {
        const cell = el('td', { class: 'right num' }, formatEUR(current));
        cell.style.cursor = 'pointer';
        cell.title = 'Click to edit';
        cell.onclick = () => {
          const inp = el('input', { type: 'number', value: current, min: 0,
            style: 'width:100px;text-align:right;background:var(--bg-elev-3);border:1px solid var(--accent);border-radius:4px;padding:4px 6px;color:var(--text)' });
          cell.innerHTML = ''; cell.appendChild(inp);
          inp.focus(); inp.select();
          const commit = () => {
            const val = Number(inp.value) || 0;
            saveForecastMonth(fc.id, monthKey, { [field]: val });
            cell.innerHTML = ''; cell.textContent = formatEUR(val);
            rebuildTotals();
            if (onChange) onChange();
          };
          inp.onblur = commit;
          inp.onkeydown = e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') { cell.innerHTML = ''; cell.textContent = formatEUR(current); } };
        };
        return cell;
      }

      const net = mData.forecastRev - mData.forecastExp;
      if (type === 'service') {
        tr.appendChild(makeEntriesCell(monthKey, mData.forecastRev, i));
      } else {
        tr.appendChild(makeEditable('revenue', mData.forecastRev));
      }
      tr.appendChild(makeExpEntriesCell(monthKey, mData.forecastExp, i));
      tr.appendChild(el('td', { class: 'right num' + (net < 0 ? ' danger' : '') }, formatEUR(net)));
      tr.appendChild(el('td', { class: 'right num ' + (isPast ? '' : 'muted') }, formatEUR(mData.actualRev)));
      tr.appendChild(el('td', { class: `right num ${mData.revVariance >= 0 ? '' : 'danger'}` }, isPast || mData.actualRev > 0 ? formatEUR(mData.revVariance) : '—'));
      tb.appendChild(tr);
    }
    appendTotals(months, yearTarget);
  }

  function rebuildTotals() {
    const { months, yearTarget } = getForecastVsActual(type, entityId, year);
    while (tb.rows.length > 12) tb.deleteRow(tb.rows.length - 1);
    appendTotals(months, yearTarget);
  }

  function makeEntriesCell(monthKey, current, monthIdx) {
    const cell = el('td', { class: 'right num' });
    const entries = getForecastEntries(fc.id, monthKey);
    const sub = entries.length ? el('div', { class: 'muted', style: 'font-size:11px;font-weight:400' }, `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`) : null;
    cell.appendChild(el('div', {}, formatEUR(current)));
    if (sub) cell.appendChild(sub);
    cell.style.cursor = 'pointer';
    cell.title = 'Click to manage entries';
    cell.onclick = () => openEntriesEditor(monthKey, `${MONTHS[monthIdx]} ${year}`);
    return cell;
  }

  function openEntriesEditor(monthKey, monthLabel) {
    const body = el('div', {});
    const listWrap = el('div', {});
    body.appendChild(listWrap);

    const refresh = () => {
      listWrap.innerHTML = '';
      const entries = getForecastEntries(fc.id, monthKey);

      if (entries.length === 0) {
        listWrap.appendChild(el('div', { class: 'empty', style: 'padding:24px' }, 'No entries yet — click "Add Entry" below.'));
      } else {
        const t = el('table', { class: 'table' });
        t.innerHTML = '<thead><tr><th>Client / Lead</th><th class="right" style="width:130px">Amount (€)</th><th>Notes / Status</th><th style="width:60px"></th></tr></thead>';
        const tb2 = el('tbody');
        for (const e of entries) {
          const tr = el('tr');
          const nameI = input({ value: e.clientName || '', placeholder: 'Client name' });
          const amtI  = input({ type: 'number', value: e.amount || 0, min: 0, step: 0.01, style: 'text-align:right' });
          const noteI = input({ value: e.notes || '', placeholder: 'e.g. Lead, In Discussion, Confirmed' });
          nameI.onchange = () => { e.clientName = nameI.value.trim(); upsertForecastEntry(fc.id, monthKey, e); };
          amtI.onchange  = () => { e.amount = Number(amtI.value) || 0; upsertForecastEntry(fc.id, monthKey, e); refresh(); rebuildTotals(); if (onChange) onChange(); };
          noteI.onchange = () => { e.notes = noteI.value; upsertForecastEntry(fc.id, monthKey, e); };
          tr.appendChild(el('td', {}, nameI));
          tr.appendChild(el('td', { class: 'right' }, amtI));
          tr.appendChild(el('td', {}, noteI));
          tr.appendChild(el('td', { class: 'right' }, button('Del', { variant: 'sm ghost', onClick: () => {
            removeForecastEntry(fc.id, monthKey, e.id);
            refresh();
            rebuildTotals();
            if (onChange) onChange();
          }})));
          tb2.appendChild(tr);
        }
        t.appendChild(tb2);
        const tw = el('div', { class: 'table-wrap' }); tw.appendChild(t);
        listWrap.appendChild(tw);
      }

      const total = getForecastEntries(fc.id, monthKey).reduce((s, e) => s + (Number(e.amount) || 0), 0);
      listWrap.appendChild(el('div', { class: 'flex justify-between', style: 'padding:12px 16px;margin-top:12px;border-top:1px solid var(--border);font-weight:600' },
        el('span', {}, 'Monthly Total'),
        el('span', { class: 'num' }, formatEUR(total))
      ));
    };

    refresh();

    const addBtn = button('+ Add Entry', { variant: 'primary', onClick: () => {
      upsertForecastEntry(fc.id, monthKey, { clientName: '', amount: 0, notes: '' });
      refresh();
      rebuildTotals();
      if (onChange) onChange();
    }});
    const doneBtn = button('Done', { onClick: () => { closeModal(); renderRows(); } });

    openModal({ title: `Forecast Entries — ${monthLabel}`, body, footer: [addBtn, doneBtn], large: true });
  }

  function makeExpEntriesCell(monthKey, currentExp, monthIdx) {
    const cell = el('td', { class: 'right num' });
    const entries = fc.months?.[monthKey]?.expenseEntries || [];
    const sub = entries.length ? el('div', { class: 'muted', style: 'font-size:11px;font-weight:400' }, `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`) : null;
    cell.appendChild(el('div', {}, formatEUR(currentExp)));
    if (sub) cell.appendChild(sub);
    cell.style.cursor = 'pointer';
    cell.title = 'Click to manage expense entries';
    cell.onclick = () => openExpEntriesEditor(monthKey, `${MONTHS[monthIdx]} ${year}`);
    return cell;
  }

  function openExpEntriesEditor(monthKey, monthLabel) {
    const body = el('div', {});
    const listWrap = el('div', {});
    body.appendChild(listWrap);

    const getEntries = () => fc.months?.[monthKey]?.expenseEntries || [];

    const saveEntries = (entries) => {
      const total = entries.reduce((s, e) => s + (Number(e.amount) || 0), 0);
      saveForecastMonth(fc.id, monthKey, { expenseEntries: entries, expenses: total });
    };

    const refresh = () => {
      listWrap.innerHTML = '';
      const entries = getEntries();

      if (entries.length === 0) {
        listWrap.appendChild(el('div', { class: 'empty', style: 'padding:24px' }, 'No expense entries yet — click "Add Entry" below.'));
      } else {
        const t = el('table', { class: 'table' });
        t.innerHTML = '<thead><tr><th>Description</th><th class="right" style="width:130px">Amount (€)</th><th>Category / Notes</th><th style="width:60px"></th></tr></thead>';
        const tb2 = el('tbody');
        for (const e of entries) {
          const tr = el('tr');
          const descI = input({ value: e.description || '', placeholder: 'e.g. Cleaning, Maintenance' });
          const amtI  = input({ type: 'number', value: e.amount || 0, min: 0, step: 0.01, style: 'text-align:right' });
          const noteI = input({ value: e.notes || '', placeholder: 'Category or notes' });
          const commit = () => {
            e.description = descI.value.trim();
            e.amount = Number(amtI.value) || 0;
            e.notes = noteI.value.trim();
            saveEntries(getEntries());
            rebuildTotals();
            if (onChange) onChange();
            refresh();
          };
          descI.onchange = commit;
          amtI.onchange  = commit;
          noteI.onchange = commit;
          tr.appendChild(el('td', {}, descI));
          tr.appendChild(el('td', { class: 'right' }, amtI));
          tr.appendChild(el('td', {}, noteI));
          tr.appendChild(el('td', { class: 'right' }, button('Del', { variant: 'sm ghost', onClick: () => {
            const updated = getEntries().filter(x => x !== e);
            saveEntries(updated);
            refresh();
            rebuildTotals();
            if (onChange) onChange();
          }})));
          tb2.appendChild(tr);
        }
        t.appendChild(tb2);
        const tw2 = el('div', { class: 'table-wrap' }); tw2.appendChild(t);
        listWrap.appendChild(tw2);
      }

      const total = getEntries().reduce((s, e) => s + (Number(e.amount) || 0), 0);
      listWrap.appendChild(el('div', { class: 'flex justify-between', style: 'padding:12px 16px;margin-top:12px;border-top:1px solid var(--border);font-weight:600' },
        el('span', {}, 'Monthly Total'),
        el('span', { class: 'num' }, formatEUR(total))
      ));
    };

    refresh();

    const addBtn = button('+ Add Entry', { variant: 'primary', onClick: () => {
      const updated = [...getEntries(), { id: newId('expe'), description: '', amount: 0, notes: '' }];
      saveEntries(updated);
      refresh();
      rebuildTotals();
      if (onChange) onChange();
    }});
    const doneBtn = button('Done', { onClick: () => { closeModal(); renderRows(); } });

    openModal({ title: `Expense Entries — ${monthLabel}`, body, footer: [addBtn, doneBtn], large: true });
  }

  function appendTotals(months, yearTarget) {
    const fcRev = months.reduce((s, m) => s + m.forecastRev, 0);
    const fcExp = months.reduce((s, m) => s + m.forecastExp, 0);
    const fcNet = fcRev - fcExp;
    const actRev = months.reduce((s, m) => s + m.actualRev, 0);
    const variance = actRev - fcRev;

    const tRow = el('tr', { style: 'font-weight:600;background:var(--bg-elev-2)' });
    tRow.appendChild(el('td', { style: 'font-size:11px;letter-spacing:.04em' }, 'TOTAL'));
    tRow.appendChild(el('td', { class: 'right num' }, formatEUR(fcRev)));
    tRow.appendChild(el('td', { class: 'right num' }, formatEUR(fcExp)));
    tRow.appendChild(el('td', { class: 'right num' + (fcNet < 0 ? ' danger' : '') }, formatEUR(fcNet)));
    tRow.appendChild(el('td', { class: 'right num' }, formatEUR(actRev)));
    tRow.appendChild(el('td', { class: `right num ${variance >= 0 ? '' : 'danger'}` }, formatEUR(variance)));
    tb.appendChild(tRow);

    if (yearTarget && (yearTarget.revenue || yearTarget.expenses)) {
      const ytRev = yearTarget.revenue || 0;
      const ytExp = yearTarget.expenses || 0;
      const ytNet = ytRev - ytExp;
      const ytRow = el('tr', { style: 'font-size:11px;color:var(--text-muted);background:var(--bg-elev-3)' });
      ytRow.appendChild(el('td', {}, 'vs Annual Target'));
      ytRow.appendChild(el('td', { class: 'right num' + (fcRev - ytRev >= 0 ? '' : ' danger') }, formatEUR(fcRev - ytRev)));
      if (type === 'property') {
        ytRow.appendChild(el('td', { class: 'right num' + (fcExp - ytExp > 0 ? ' warning' : '') }, formatEUR(fcExp - ytExp)));
        ytRow.appendChild(el('td', { class: 'right num' + (fcNet - ytNet >= 0 ? '' : ' danger') }, formatEUR(fcNet - ytNet)));
      } else {
        ytRow.appendChild(el('td', {}));
        ytRow.appendChild(el('td', {}));
      }
      ytRow.appendChild(el('td', { class: 'right num' + (actRev >= ytRev ? '' : ' danger') }, formatEUR(actRev - ytRev)));
      ytRow.appendChild(el('td', {}));
      tb.appendChild(ytRow);
    }
  }
}

// ===== AGGREGATED GRID (multi-select, read-only — property and service) =====
function buildAggregatedGrid(entityIds, year, type = 'property') {
  const card = el('div', { class: 'card' });
  const label = type === 'service' ? `${entityIds.length} services selected` : `${entityIds.length} properties selected`;
  card.appendChild(el('div', { class: 'card-header' },
    el('div', { class: 'card-title' }, `Aggregated Forecast — ${year}`),
    el('div', { class: 'muted', style: 'font-size:12px' }, label)
  ));

  const results = entityIds.map(id => getForecastVsActual(type, id, year));
  const months = results[0].months.map((_, i) => ({
    key: results[0].months[i].key,
    forecastRev: results.reduce((s, r) => s + r.months[i].forecastRev, 0),
    forecastExp: results.reduce((s, r) => s + r.months[i].forecastExp, 0),
    actualRev:   results.reduce((s, r) => s + r.months[i].actualRev, 0),
    revVariance: results.reduce((s, r) => s + r.months[i].revVariance, 0),
  }));
  const yearTarget = {
    revenue:  results.reduce((s, r) => s + (r.yearTarget?.revenue || 0), 0),
    expenses: results.reduce((s, r) => s + (r.yearTarget?.expenses || 0), 0),
  };

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

  const now = new Date();
  for (let i = 0; i < 12; i++) {
    const m = months[i];
    const isPast = new Date(Number(year), i + 1, 0) < now;
    const net = m.forecastRev - m.forecastExp;
    const tr = el('tr');
    tr.appendChild(el('td', {}, MONTHS[i]));
    tr.appendChild(el('td', { class: 'right num' }, formatEUR(m.forecastRev)));
    tr.appendChild(el('td', { class: 'right num' }, formatEUR(m.forecastExp)));
    tr.appendChild(el('td', { class: 'right num' + (net < 0 ? ' danger' : '') }, formatEUR(net)));
    tr.appendChild(el('td', { class: 'right num ' + (isPast ? '' : 'muted') }, formatEUR(m.actualRev)));
    tr.appendChild(el('td', { class: `right num ${m.revVariance >= 0 ? '' : 'danger'}` }, isPast || m.actualRev > 0 ? formatEUR(m.revVariance) : '—'));
    tb.appendChild(tr);
  }

  const fcRev = months.reduce((s, m) => s + m.forecastRev, 0);
  const fcExp = months.reduce((s, m) => s + m.forecastExp, 0);
  const fcNet = fcRev - fcExp;
  const actRev = months.reduce((s, m) => s + m.actualRev, 0);
  const variance = actRev - fcRev;
  const tRow = el('tr', { style: 'font-weight:600;background:var(--bg-elev-2)' });
  tRow.appendChild(el('td', { style: 'font-size:11px;letter-spacing:.04em' }, 'TOTAL'));
  tRow.appendChild(el('td', { class: 'right num' }, formatEUR(fcRev)));
  tRow.appendChild(el('td', { class: 'right num' }, formatEUR(fcExp)));
  tRow.appendChild(el('td', { class: 'right num' + (fcNet < 0 ? ' danger' : '') }, formatEUR(fcNet)));
  tRow.appendChild(el('td', { class: 'right num' }, formatEUR(actRev)));
  tRow.appendChild(el('td', { class: `right num ${variance >= 0 ? '' : 'danger'}` }, formatEUR(variance)));
  tb.appendChild(tRow);

  if (yearTarget.revenue || yearTarget.expenses) {
    const ytRev = yearTarget.revenue || 0;
    const ytExp = yearTarget.expenses || 0;
    const ytNet = ytRev - ytExp;
    const ytRow = el('tr', { style: 'font-size:11px;color:var(--text-muted);background:var(--bg-elev-3)' });
    ytRow.appendChild(el('td', {}, 'vs Annual Target'));
    ytRow.appendChild(el('td', { class: 'right num' + (fcRev - ytRev >= 0 ? '' : ' danger') }, formatEUR(fcRev - ytRev)));
    ytRow.appendChild(el('td', { class: 'right num' + (fcExp - ytExp > 0 ? ' warning' : '') }, formatEUR(fcExp - ytExp)));
    ytRow.appendChild(el('td', { class: 'right num' + (fcNet - ytNet >= 0 ? '' : ' danger') }, formatEUR(fcNet - ytNet)));
    ytRow.appendChild(el('td', { class: 'right num' + (actRev >= ytRev ? '' : ' danger') }, formatEUR(actRev - ytRev)));
    ytRow.appendChild(el('td', {}));
    tb.appendChild(ytRow);
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
