// Forecast module: monthly grid per property/service
import { state, markDirty } from '../core/state.js';
import { el, select, input, button, formRow, toast, fmtDate, openModal, closeModal, drillDownModal, attachSortFilter } from '../core/ui.js';
import * as charts from '../core/charts.js';
import { formatEUR, toEUR, byId, newId, availableYears, getOrCreateForecast, saveForecastMonth, saveForecastYear, getForecastVsActual, getForecastEntries, upsertForecastEntry, removeForecastEntry, listActive, listActivePayments } from '../core/data.js';
import { STREAMS, EXPENSE_CATEGORIES } from '../core/config.js';

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

let _fcBreakSortCol  = -1, _fcBreakSortDir  = 1;
let _fcStreamSortCol = -1, _fcStreamSortDir = 1;

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
    { id: 'service', label: 'Service Forecast' }
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
        else buildServiceSection(s);
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
  // All active properties — no status filter so all 19 (or however many) appear
  const props = listActive('properties');
  if (props.length === 0) { wrap.appendChild(el('div', { class: 'empty' }, 'No active properties to forecast')); return; }

  let selectedPropIds = new Set(props.map(p => p.id));
  let selectedStreamIds = new Set(); // empty = all
  let selectedYears = new Set();
  let yearChks = [];

  const MENU_STYLE = 'display:none;position:absolute;top:calc(100% + 4px);left:0;z-index:300;background:var(--bg-elev-2);border:1px solid var(--border);border-radius:var(--radius-sm);min-width:200px;box-shadow:0 4px 16px rgba(0,0,0,0.35);padding:4px 0;max-height:320px;overflow-y:auto';
  const LABEL_STYLE = 'display:flex;align-items:center;gap:8px;padding:6px 12px;cursor:pointer;font-size:13px';

  // ── Stream filter ─────────────────────────────────────────────────────────
  const streamOpts = [
    { value: 'short_term_rental', label: STREAMS.short_term_rental?.label || 'Short-term' },
    { value: 'long_term_rental',  label: STREAMS.long_term_rental?.label  || 'Long-term'  }
  ];
  const streamWrapper = el('div', { style: 'position:relative' });
  const streamTrigLabel = el('span', {}, 'All Streams');
  const streamTrigger = el('div', { class: 'select', style: 'cursor:pointer;display:flex;align-items:center;width:auto;min-width:140px;user-select:none' }, streamTrigLabel);
  const streamMenu = el('div', { style: MENU_STYLE });
  const allStreamChk = el('input', { type: 'checkbox' });
  allStreamChk.checked = true;
  streamMenu.appendChild(el('label', { style: LABEL_STYLE + ';border-bottom:1px solid var(--border)' }, allStreamChk, el('span', {}, 'All Streams')));
  const streamChks = streamOpts.map(opt => {
    const chk = el('input', { type: 'checkbox' });
    chk.dataset.value = opt.value;
    chk.checked = true;
    streamMenu.appendChild(el('label', { style: LABEL_STYLE }, chk, el('span', {}, opt.label)));
    return chk;
  });

  // ── Property checklist ────────────────────────────────────────────────────
  const propWrapper = el('div', { style: 'position:relative' });
  const trigLabel = el('span', {}, 'All Properties');
  const propTrigger = el('div', { class: 'select', style: 'cursor:pointer;display:flex;align-items:center;width:auto;min-width:160px;user-select:none' }, trigLabel);
  const propMenu = el('div', { style: MENU_STYLE.replace('200px', '240px') });
  const allChk = el('input', { type: 'checkbox' });
  allChk.checked = true;
  propMenu.appendChild(el('label', { style: LABEL_STYLE + ';border-bottom:1px solid var(--border)' }, allChk, el('span', {}, 'All Properties')));
  const propChks = props.map(p => {
    const chk = el('input', { type: 'checkbox' });
    chk.dataset.id = p.id;
    chk.checked = true;
    propMenu.appendChild(el('label', { style: LABEL_STYLE }, chk, el('span', {}, p.name)));
    return chk;
  });

  // ── Year multi-select ─────────────────────────────────────────────────────
  const yearWrapper = el('div', { style: 'position:relative' });
  const yearTrigLabel = el('span', {}, String(new Date().getFullYear()));
  const yearTrigger = el('div', { class: 'select', style: 'cursor:pointer;display:flex;align-items:center;width:auto;min-width:90px;user-select:none' }, yearTrigLabel);
  const yearMenu = el('div', { style: MENU_STYLE.replace('200px', '160px') });

  // ── Sync helpers ──────────────────────────────────────────────────────────
  const syncYearSel = () => {
    const sel = yearChks.filter(c => c.checked);
    yearTrigLabel.textContent =
      sel.length === 0 ? 'No Years'
      : sel.length === yearChks.length && yearChks.length === 1 ? sel[0].dataset.year
      : sel.length === yearChks.length ? 'All Years'
      : sel.length === 1 ? sel[0].dataset.year
      : `${sel.length} Years`;
    selectedYears = new Set(sel.map(c => c.dataset.year));
  };

  const syncPropSel = () => {
    const visibleChks = propChks.filter(c => c.closest('label')?.style.display !== 'none');
    const sel = visibleChks.filter(c => c.checked);
    allChk.checked = visibleChks.length > 0 && sel.length === visibleChks.length;
    allChk.indeterminate = sel.length > 0 && sel.length < visibleChks.length;
    trigLabel.textContent = sel.length === visibleChks.length && visibleChks.length > 0 ? 'All Properties'
      : sel.length === 0 ? 'No Properties'
      : sel.length === 1 ? (props.find(p => p.id === sel[0].dataset.id)?.name || '1 Property')
      : `${sel.length} Properties`;
    selectedPropIds = new Set(propChks.filter(c => c.checked).map(c => c.dataset.id));
  };

  // Rebuilds year checkboxes from data available for the selected properties
  const updateYearOptions = () => {
    const pIds = new Set([...selectedPropIds]);
    const years = new Set();
    for (const p of listActivePayments()) {
      if (!pIds.size || pIds.has(p.propertyId)) if (p.date) years.add(p.date.slice(0, 4));
    }
    for (const e of listActive('expenses')) {
      if (!pIds.size || pIds.has(e.propertyId)) if (e.date) years.add(e.date.slice(0, 4));
    }
    for (const f of (state.db.forecasts || [])) {
      if (f.type === 'property' && (!pIds.size || pIds.has(f.entityId)) && f.year) years.add(String(f.year));
    }
    if (years.size === 0) years.add(String(new Date().getFullYear()));

    const sorted = [...years].sort();
    const prev = new Set([...selectedYears]);
    const curYear = String(new Date().getFullYear());

    yearMenu.innerHTML = '';
    yearChks = [];

    const allYearChk = el('input', { type: 'checkbox' });
    allYearChk.onchange = () => {
      yearChks.forEach(c => { c.checked = allYearChk.checked; });
      allYearChk.indeterminate = false;
      syncYearSel();
      render();
    };
    yearMenu.appendChild(el('label', { style: LABEL_STYLE + ';border-bottom:1px solid var(--border)' }, allYearChk, el('span', {}, 'All Years')));

    sorted.forEach(y => {
      const chk = el('input', { type: 'checkbox' });
      chk.dataset.year = y;
      chk.checked = prev.size > 0 ? prev.has(y) : y === curYear;
      chk.onchange = () => {
        const sel = yearChks.filter(c => c.checked);
        allYearChk.checked = yearChks.length > 0 && sel.length === yearChks.length;
        allYearChk.indeterminate = sel.length > 0 && sel.length < yearChks.length;
        syncYearSel();
        render();
      };
      yearMenu.appendChild(el('label', { style: LABEL_STYLE }, chk, el('span', {}, y)));
      yearChks.push(chk);
    });

    // Ensure at least one year selected
    if (yearChks.every(c => !c.checked) && yearChks.length > 0) yearChks[yearChks.length - 1].checked = true;
    const sel = yearChks.filter(c => c.checked);
    allYearChk.checked = yearChks.length > 0 && sel.length === yearChks.length;
    allYearChk.indeterminate = sel.length > 0 && sel.length < yearChks.length;
    syncYearSel();
  };

  // Stream changes → filter property list to matching type
  const syncPropertyVisibility = () => {
    propChks.forEach(chk => {
      const p = byId('properties', chk.dataset.id);
      const sk = p?.type === 'short_term' ? 'short_term_rental' : 'long_term_rental';
      const visible = selectedStreamIds.size === 0 || selectedStreamIds.has(sk);
      const row = chk.closest('label');
      if (row) row.style.display = visible ? '' : 'none';
      chk.checked = visible; // auto-select all visible, deselect hidden
    });
    syncPropSel();
    updateYearOptions();
  };

  const syncStreamSel = () => {
    const sel = streamChks.filter(c => c.checked);
    const n = sel.length;
    allStreamChk.checked = n === streamChks.length;
    allStreamChk.indeterminate = n > 0 && n < streamChks.length;
    streamTrigLabel.textContent = n === streamChks.length || n === 0 ? 'All Streams'
      : n === 1 ? (streamOpts.find(o => o.value === sel[0].dataset.value)?.label || '')
      : `${n} Streams`;
    selectedStreamIds = n === streamChks.length ? new Set() : new Set(sel.map(c => c.dataset.value));
    syncPropertyVisibility();
  };

  // ── Event wiring ──────────────────────────────────────────────────────────
  allStreamChk.onchange = () => { streamChks.forEach(c => { c.checked = allStreamChk.checked; }); allStreamChk.indeterminate = false; syncStreamSel(); render(); };
  streamChks.forEach(chk => { chk.onchange = () => { syncStreamSel(); render(); }; });
  streamTrigger.onclick = e => { e.stopPropagation(); streamMenu.style.display = streamMenu.style.display === 'none' ? '' : 'none'; };
  streamMenu.onclick = e => e.stopPropagation();

  allChk.onchange = () => {
    const visibleChks = propChks.filter(c => c.closest('label')?.style.display !== 'none');
    visibleChks.forEach(c => { c.checked = allChk.checked; });
    allChk.indeterminate = false;
    syncPropSel();
    updateYearOptions();
    render();
  };
  propChks.forEach(chk => { chk.onchange = () => { syncPropSel(); updateYearOptions(); render(); }; });
  propTrigger.onclick = e => { e.stopPropagation(); propMenu.style.display = propMenu.style.display === 'none' ? '' : 'none'; };
  propMenu.onclick = e => e.stopPropagation();

  yearTrigger.onclick = e => { e.stopPropagation(); yearMenu.style.display = yearMenu.style.display === 'none' ? '' : 'none'; };
  yearMenu.onclick = e => e.stopPropagation();

  const closeForecMenus = () => {
    if (!streamWrapper.isConnected) { document.removeEventListener('click', closeForecMenus); return; }
    streamMenu.style.display = 'none';
    propMenu.style.display = 'none';
    yearMenu.style.display = 'none';
  };
  document.addEventListener('click', closeForecMenus);

  streamWrapper.appendChild(streamTrigger);
  streamWrapper.appendChild(streamMenu);
  propWrapper.appendChild(propTrigger);
  propWrapper.appendChild(propMenu);
  yearWrapper.appendChild(yearTrigger);
  yearWrapper.appendChild(yearMenu);

  // ── Data helpers ──────────────────────────────────────────────────────────
  const getSelIds = () => {
    const base = selectedPropIds.size > 0 ? [...selectedPropIds] : props.map(p => p.id);
    if (selectedStreamIds.size === 0) return base.length ? base : [props[0].id];
    const filtered = base.filter(id => {
      const p = byId('properties', id);
      const sk = p?.type === 'short_term' ? 'short_term_rental' : 'long_term_rental';
      return selectedStreamIds.has(sk);
    });
    return filtered.length ? filtered : base.length ? [base[0]] : [props[0].id];
  };

  const getSelYears = () => [...selectedYears].sort().filter(Boolean);

  const getAggregated = (year) => {
    const propIds = getSelIds();
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

  // ── Render functions ──────────────────────────────────────────────────────
  const render = () => {
    const selIds = getSelIds();
    const years = getSelYears();
    const aggCache = new Map(years.map(y => [y, getAggregated(y)]));
    gridWrap.innerHTML = '';
    if (years.length === 0) return;
    for (const year of years) {
      if (years.length > 1) {
        gridWrap.appendChild(el('div', {
          style: 'font-size:13px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--text-muted);padding:16px 0 4px;border-top:2px solid var(--border);margin-top:8px'
        }, year));
      }
      if (selIds.length === 1) {
        gridWrap.appendChild(buildMonthlyGrid(selIds[0], year, 'property', () => {
          const fc = new Map(getSelYears().map(y => [y, getAggregated(y)]));
          renderChart(fc); renderSummary(fc);
        }));
      } else {
        gridWrap.appendChild(buildAggregatedGrid(selIds, year));
      }
    }
    renderChart(aggCache);
    renderSummary(aggCache);
    renderBreakdown(selIds);
  };

  const renderBreakdown = (selIds) => {
    breakdownWrap.innerHTML = '';
    const years = getSelYears();
    const year = years[years.length - 1] || String(new Date().getFullYear());
    const fcCache = new Map(selIds.map(id => [id, getForecastVsActual('property', id, year)]));
    const bCard = buildPropertyBreakdownCard(selIds, year, fcCache);
    breakdownWrap.appendChild(bCard);
    const bTw = bCard.querySelector('.table-wrap');
    if (bTw) attachSortFilter(bTw, { initialCol: _fcBreakSortCol, initialDir: _fcBreakSortDir, onSortChange: (c, d) => { _fcBreakSortCol = c; _fcBreakSortDir = d; } });
    const sCard = buildStreamBreakdownCard(selIds, year, fcCache);
    if (sCard) {
      breakdownWrap.appendChild(sCard);
      const sTw = sCard.querySelector('.table-wrap');
      if (sTw) attachSortFilter(sTw, { initialCol: _fcStreamSortCol, initialDir: _fcStreamSortDir, onSortChange: (c, d) => { _fcStreamSortCol = c; _fcStreamSortDir = d; } });
    }
  };

  const renderChart = (aggCache) => {
    const years = getSelYears();
    const bgColors  = ['rgba(99,102,241,0.5)', 'rgba(245,158,11,0.45)', 'rgba(16,185,129,0.4)', 'rgba(239,68,68,0.4)'];
    const lineColors = ['#6366f1', '#f59e0b', '#10b981', '#ef4444'];
    const datasets = [];
    years.forEach((year, idx) => {
      const { months } = aggCache?.get(year) ?? getAggregated(year);
      const bg = bgColors[idx % bgColors.length];
      const ln = lineColors[idx % lineColors.length];
      datasets.push({ label: `Forecast ${year}`, data: months.map(m => Math.round(m.forecastRev)), backgroundColor: bg, borderColor: ln, borderWidth: 1 });
      datasets.push({ label: `Actual ${year}`,   data: months.map(m => Math.round(m.actualRev)),   backgroundColor: ln });
      if (years.length === 1) {
        datasets.push({ label: 'Variance', data: months.map(m => Math.round(m.revVariance)), backgroundColor: m => m.raw < 0 ? '#ef4444' : '#10b981' });
      }
    });
    charts.bar('fc-prop-chart', { labels: MONTHS, datasets });
  };

  const renderSummary = (aggCache) => {
    const years = getSelYears();
    let forecastRev = 0, forecastExp = 0, actualRev = 0, actualExp = 0;
    let yearTarget = { revenue: 0, expenses: 0 };
    let allMonths = [];
    for (const year of years) {
      const agg = aggCache?.get(year) ?? getAggregated(year);
      forecastRev += agg.months.reduce((s, m) => s + m.forecastRev, 0);
      forecastExp += agg.months.reduce((s, m) => s + m.forecastExp, 0);
      actualRev   += agg.months.reduce((s, m) => s + m.actualRev, 0);
      actualExp   += agg.months.reduce((s, m) => s + m.actualExp, 0);
      yearTarget.revenue  += agg.yearTarget?.revenue  || 0;
      yearTarget.expenses += agg.yearTarget?.expenses || 0;
      allMonths = allMonths.concat(agg.months);
    }
    const el2 = document.getElementById('fc-prop-summary');
    if (!el2) return;
    el2.innerHTML = '';
    const insightItems = buildForecastInsightItems(allMonths, yearTarget);
    const items = [
      ...insightItems,
      summaryRow('Forecast Revenue',      formatEUR(forecastRev)),
      summaryRow('Forecast Expenses',     formatEUR(forecastExp)),
      summaryRow('Forecast Net',          formatEUR(forecastRev - forecastExp)),
      el('hr', { style: 'border-color:var(--border);margin:8px 0' }),
      summaryRow('Actual Revenue YTD',    formatEUR(actualRev)),
      summaryRow('Actual Expenses YTD',   formatEUR(actualExp)),
      summaryRow('Actual Net YTD',        formatEUR(actualRev - actualExp)),
      el('hr', { style: 'border-color:var(--border);margin:8px 0' }),
      summaryRow('Revenue Variance YTD',  formatEUR(actualRev - forecastRev), actualRev >= forecastRev ? 'success' : 'danger'),
      summaryRow('Revenue Variance %',    forecastRev > 0 ? ((actualRev - forecastRev) / forecastRev * 100).toFixed(1) + '%' : '—',
        actualRev >= forecastRev ? 'success' : 'danger'),
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

  // ── Controls assembly ─────────────────────────────────────────────────────
  const resetBtn = button('Reset Filters', { variant: 'sm ghost', onClick: () => {
    streamChks.forEach(c => { c.checked = true; });
    allStreamChk.checked = true; allStreamChk.indeterminate = false;
    syncStreamSel(); // → syncPropertyVisibility → syncPropSel + updateYearOptions
    yearChks.forEach(c => { c.checked = true; });
    const allYearChkEl = yearMenu.querySelector('input');
    if (allYearChkEl) { allYearChkEl.checked = true; allYearChkEl.indeterminate = false; }
    syncYearSel();
    render();
  }});

  const controls = el('div', { class: 'flex gap-8 mb-16', style: 'align-items:center;flex-wrap:wrap' });
  controls.appendChild(el('span', { style: 'font-size:12px;color:var(--text-muted);align-self:center' }, 'Filters:'));
  controls.appendChild(yearWrapper);
  controls.appendChild(streamWrapper);
  controls.appendChild(propWrapper);
  controls.appendChild(resetBtn);
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

  const breakdownWrap = el('div', {});
  wrap.appendChild(breakdownWrap);

  // ── Initial render ────────────────────────────────────────────────────────
  updateYearOptions();
  render();
  // Defer chart/summary render until elements are in the live DOM
  requestAnimationFrame(() => {
    const fc = new Map(getSelYears().map(y => [y, getAggregated(y)]));
    renderChart(fc); renderSummary(fc);
  });
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

  svcWrapper.appendChild(svcTrigger);
  svcWrapper.appendChild(svcMenu);
  // -------------------------------------------------------------------------

  // ── Year multi-select (service forecast) ──────────────────────────────────
  let svcYearChks = [];
  let selectedSvcYears = new Set();

  const svcYearWrapper = el('div', { style: 'position:relative' });
  const svcYearTrigLabel = el('span', {}, String(new Date().getFullYear()));
  const svcYearTrigger = el('div', { class: 'select', style: 'cursor:pointer;display:flex;align-items:center;width:auto;min-width:90px;user-select:none' }, svcYearTrigLabel);
  const svcYearMenu = el('div', { style: 'display:none;position:absolute;top:calc(100% + 4px);left:0;z-index:300;background:var(--bg-elev-2);border:1px solid var(--border);border-radius:var(--radius-sm);min-width:160px;box-shadow:0 4px 16px rgba(0,0,0,0.35);padding:4px 0;max-height:320px;overflow-y:auto' });

  const syncSvcYearSel = () => {
    const sel = svcYearChks.filter(c => c.checked);
    svcYearTrigLabel.textContent =
      sel.length === 0 ? 'No Years'
      : sel.length === svcYearChks.length && svcYearChks.length === 1 ? sel[0].dataset.year
      : sel.length === svcYearChks.length ? 'All Years'
      : sel.length === 1 ? sel[0].dataset.year
      : `${sel.length} Years`;
    selectedSvcYears = new Set(sel.map(c => c.dataset.year));
  };

  const updateSvcYearOptions = () => {
    // Only years that have service forecast entries
    const years = new Set();
    const curYear = String(new Date().getFullYear());
    for (const f of (state.db.forecasts || [])) {
      if (f.type === 'service' && f.year) years.add(String(f.year));
    }
    // Also include years with actual paid invoices for these streams
    for (const inv of listActive('invoices')) {
      const id = inv.stream;
      if (serviceEntities.some(s => s.id === id) && inv.issueDate) years.add(inv.issueDate.slice(0, 4));
    }
    if (years.size === 0) years.add(curYear);

    const sorted = [...years].sort();
    const prev = new Set([...selectedSvcYears]);

    svcYearMenu.innerHTML = '';
    svcYearChks = [];

    const allYrChk = el('input', { type: 'checkbox' });
    allYrChk.onchange = () => {
      svcYearChks.forEach(c => { c.checked = allYrChk.checked; });
      allYrChk.indeterminate = false;
      syncSvcYearSel();
      render();
    };
    svcYearMenu.appendChild(el('label', { style: 'display:flex;align-items:center;gap:8px;padding:6px 12px;cursor:pointer;border-bottom:1px solid var(--border);font-size:13px' }, allYrChk, el('span', {}, 'All Years')));

    sorted.forEach(y => {
      const chk = el('input', { type: 'checkbox' });
      chk.dataset.year = y;
      chk.checked = prev.size > 0 ? prev.has(y) : y === curYear;
      chk.onchange = () => {
        const sel = svcYearChks.filter(c => c.checked);
        allYrChk.checked = svcYearChks.length > 0 && sel.length === svcYearChks.length;
        allYrChk.indeterminate = sel.length > 0 && sel.length < svcYearChks.length;
        syncSvcYearSel();
        render();
      };
      svcYearMenu.appendChild(el('label', { style: 'display:flex;align-items:center;gap:8px;padding:6px 12px;cursor:pointer;font-size:13px' }, chk, el('span', {}, y)));
      svcYearChks.push(chk);
    });

    if (svcYearChks.every(c => !c.checked) && svcYearChks.length > 0) svcYearChks[svcYearChks.length - 1].checked = true;
    const sel = svcYearChks.filter(c => c.checked);
    allYrChk.checked = svcYearChks.length > 0 && sel.length === svcYearChks.length;
    allYrChk.indeterminate = sel.length > 0 && sel.length < svcYearChks.length;
    syncSvcYearSel();
  };

  svcYearTrigger.onclick = e => { e.stopPropagation(); svcYearMenu.style.display = svcYearMenu.style.display === 'none' ? '' : 'none'; };
  svcYearMenu.onclick = e => e.stopPropagation();
  const closeSvcMenus = () => {
    if (!svcWrapper.isConnected) { document.removeEventListener('click', closeSvcMenus); return; }
    svcMenu.style.display = 'none';
    svcYearMenu.style.display = 'none';
  };
  document.addEventListener('click', closeSvcMenus);
  svcYearWrapper.appendChild(svcYearTrigger);
  svcYearWrapper.appendChild(svcYearMenu);

  const getSelSvcYears = () => [...selectedSvcYears].sort().filter(Boolean);

  const svcResetBtn = button('Reset Filters', { variant: 'sm ghost', onClick: () => {
    svcChks.forEach(c => { c.checked = true; });
    allSvcChk.checked = true; allSvcChk.indeterminate = false;
    syncSvcSel();
    svcYearChks.forEach(c => { c.checked = true; });
    const allYrChkEl = svcYearMenu.querySelector('input');
    if (allYrChkEl) { allYrChkEl.checked = true; allYrChkEl.indeterminate = false; }
    syncSvcYearSel();
    render();
  }});

  const controls = el('div', { class: 'flex gap-8 mb-16', style: 'align-items:center;flex-wrap:wrap' });
  controls.appendChild(el('span', { style: 'font-size:12px;color:var(--text-muted);align-self:center' }, 'Filters:'));
  controls.appendChild(svcYearWrapper);
  controls.appendChild(svcWrapper);
  controls.appendChild(svcResetBtn);
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

  const getAggregated = (year) => {
    const streamIds = getSelIds();
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
    updateSvcYearOptions();
    const selIds = getSelIds();
    const years = getSelSvcYears();
    const aggCache = new Map(years.map(y => [y, getAggregated(y)]));
    gridWrap.innerHTML = '';
    if (years.length === 0) return;
    for (const year of years) {
      if (years.length > 1) {
        gridWrap.appendChild(el('div', {
          style: 'font-size:13px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--text-muted);padding:16px 0 4px;border-top:2px solid var(--border);margin-top:8px'
        }, year));
      }
      if (selIds.length === 1) {
        gridWrap.appendChild(buildMonthlyGrid(selIds[0], year, 'service', () => {
          const fc = new Map(getSelSvcYears().map(y => [y, getAggregated(y)]));
          renderChart(fc); renderSummary(fc);
        }));
      } else {
        gridWrap.appendChild(buildAggregatedGrid(selIds, year, 'service'));
      }
    }
    renderChart(aggCache);
    renderSummary(aggCache);
  };

  const renderChart = (aggCache) => {
    const years = getSelSvcYears();
    const bgColors   = ['rgba(99,102,241,0.5)', 'rgba(245,158,11,0.45)', 'rgba(16,185,129,0.4)', 'rgba(239,68,68,0.4)'];
    const lineColors = ['#6366f1', '#f59e0b', '#10b981', '#ef4444'];
    const datasets = [];
    years.forEach((year, idx) => {
      const { months } = aggCache?.get(year) ?? getAggregated(year);
      datasets.push({ label: `Forecast ${year}`, data: months.map(m => Math.round(m.forecastRev)), backgroundColor: bgColors[idx % bgColors.length], borderColor: lineColors[idx % lineColors.length], borderWidth: 1 });
      datasets.push({ label: `Invoiced ${year}`,  data: months.map(m => Math.round(m.actualRev)),  backgroundColor: lineColors[idx % lineColors.length] });
    });
    charts.bar('fc-svc-chart', { labels: MONTHS, datasets });
  };

  const renderSummary = (aggCache) => {
    const years = getSelSvcYears();
    let forecastRev = 0, actualRev = 0;
    let yearTarget = { revenue: 0 };
    let allMonths = [];
    for (const year of years) {
      const agg = aggCache?.get(year) ?? getAggregated(year);
      forecastRev += agg.months.reduce((s, m) => s + m.forecastRev, 0);
      actualRev   += agg.months.reduce((s, m) => s + m.actualRev,   0);
      yearTarget.revenue += agg.yearTarget?.revenue || 0;
      allMonths = allMonths.concat(agg.months);
    }
    const el2 = document.getElementById('fc-svc-summary');
    if (!el2) return;
    el2.innerHTML = '';
    const insightItems = buildForecastInsightItems(allMonths, yearTarget);
    const items = [
      ...insightItems,
      summaryRow('Forecast Revenue', formatEUR(forecastRev)),
      el('hr', { style: 'border-color:var(--border);margin:8px 0' }),
      summaryRow('Actual Revenue YTD', formatEUR(actualRev)),
      el('hr', { style: 'border-color:var(--border);margin:8px 0' }),
      summaryRow('Revenue Variance YTD', formatEUR(actualRev - forecastRev), actualRev >= forecastRev ? 'success' : 'danger'),
      summaryRow('Revenue Variance %',   forecastRev > 0 ? ((actualRev - forecastRev) / forecastRev * 100).toFixed(1) + '%' : '—',
        actualRev >= forecastRev ? 'success' : 'danger'),
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

  updateSvcYearOptions();
  render();
}

// ===== INLINE INSIGHTS =====
function buildForecastInsightItems(months, yearTarget) {
  const STYLES = {
    danger:  { bg: 'rgba(239,68,68,0.08)',  border: '#ef4444', icon: '⚠' },
    warning: { bg: 'rgba(245,158,11,0.08)', border: '#f59e0b', icon: '⚡' },
    info:    { bg: 'rgba(99,102,241,0.08)', border: '#6366f1', icon: 'ℹ' }
  };
  const insights = [];
  const forecastRev = months.reduce((s, m) => s + m.forecastRev, 0);
  const actualRev   = months.reduce((s, m) => s + m.actualRev, 0);
  const forecastExp = months.reduce((s, m) => s + m.forecastExp, 0);
  const actualExp   = months.reduce((s, m) => s + m.actualExp, 0);

  if (forecastRev > 0) {
    const varPct = ((actualRev - forecastRev) / forecastRev) * 100;
    if (varPct < -20) {
      insights.push({ level: 'danger',  text: `Actual revenue is ${Math.abs(varPct).toFixed(0)}% below forecast — significant shortfall detected.` });
    } else if (varPct < -10) {
      insights.push({ level: 'warning', text: `Actual revenue is ${Math.abs(varPct).toFixed(0)}% below forecast for the selected period.` });
    } else if (varPct > 15) {
      insights.push({ level: 'info',    text: `Actual revenue is ${varPct.toFixed(0)}% above forecast — outperforming projections.` });
    }
  }
  if (forecastExp > 0) {
    const expVarPct = ((actualExp - forecastExp) / forecastExp) * 100;
    if (expVarPct > 25) {
      insights.push({ level: 'warning', text: `Actual expenses are ${expVarPct.toFixed(0)}% above forecast — overspending detected.` });
    }
  }
  if (yearTarget?.revenue && forecastRev > 0 && forecastRev < yearTarget.revenue * 0.75) {
    insights.push({ level: 'warning', text: 'Forecast revenue is more than 25% below the annual target — on-track assessment needed.' });
  }
  if (!insights.length) return [];

  return insights.map(({ level, text }) => {
    const s = STYLES[level] || STYLES.info;
    return el('div', {
      style: `display:flex;align-items:flex-start;gap:10px;padding:10px 14px;margin-bottom:6px;background:${s.bg};border-left:3px solid ${s.border};border-radius:0 var(--radius-sm) var(--radius-sm) 0;font-size:13px`
    },
      el('span', { style: `color:${s.border};flex-shrink:0` }, s.icon),
      el('span', { style: 'color:var(--text);line-height:1.4' }, text)
    );
  });
}

// ===== DRILL-DOWN HELPERS =====
function getActualRevRows(entityId, type, monthKey) {
  if (type === 'service') {
    return listActive('invoices').filter(i =>
      i.status === 'paid' && (i.issueDate || '').slice(0, 7) === monthKey && i.stream === entityId
    ).map(i => ({
      date:   i.issueDate,
      source: byId('clients', i.clientId)?.name || '—',
      ref:    i.invoiceNumber || '—',
      code:   '',
      eur:    toEUR(i.total, i.currency, i.issueDate)
    })).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  }
  return listActivePayments().filter(p =>
    p.status === 'paid' && p.date?.slice(0, 7) === monthKey && p.propertyId === entityId
  ).map(p => ({
    date:   p.date,
    source: byId('properties', p.propertyId)?.name || p.source || '—',
    ref:    p.airbnbType || p.type || '—',
    code:   p.confirmationCode || p.airbnbRef || '—',
    eur:    toEUR(p.amount, p.currency, p.date)
  })).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

function getActualExpRows(entityId, type, monthKey) {
  return listActive('expenses').filter(e =>
    e.date?.slice(0, 7) === monthKey &&
    (type === 'property' ? e.propertyId === entityId : (e.stream === entityId))
  ).map(e => ({
    date:     e.date,
    category: EXPENSE_CATEGORIES[e.category]?.label || e.category || '—',
    desc:     e.description || '—',
    vendor:   e.vendor || (e.vendorId ? byId('vendors', e.vendorId)?.name : '') || '—',
    eur:      toEUR(e.amount, e.currency, e.date)
  })).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

const FC_REV_COLS = [
  { key: 'date',   label: 'Date',       format: v => fmtDate(v) },
  { key: 'source', label: 'Source' },
  { key: 'ref',    label: 'Type' },
  { key: 'code',   label: 'Conf. Code' },
  { key: 'eur',    label: 'EUR',        right: true, format: v => formatEUR(v) }
];
const FC_EXP_COLS = [
  { key: 'date',     label: 'Date',        format: v => fmtDate(v) },
  { key: 'category', label: 'Category'    },
  { key: 'desc',     label: 'Description' },
  { key: 'vendor',   label: 'Vendor'      },
  { key: 'eur',      label: 'EUR',         right: true, format: v => formatEUR(v) }
];
const FC_VAR_COLS = [
  { key: 'label', label: 'Item' },
  { key: 'eur',   label: 'EUR', right: true, format: v => v === null ? '—' : formatEUR(v) },
  { key: 'pct',   label: '%',   right: true }
];
const FC_PENDING_COLS = [
  { key: 'date',   label: 'Check-in',     format: v => fmtDate(v) },
  { key: 'guest',  label: 'Guest' },
  { key: 'code',   label: 'Conf. Code' },
  { key: 'nights', label: 'Nights',        right: true },
  { key: 'eur',    label: 'Amount',        right: true, format: v => formatEUR(v) }
];

function getPendingAirbnbRows(propertyId, monthKey) {
  return listActivePayments()
    .filter(p => p.source === 'airbnb' && p.status === 'pending'
      && p.propertyId === propertyId
      && (p.airbnbCheckIn || p.date || '').slice(0, 7) === monthKey)
    .map(p => ({
      date:   p.airbnbCheckIn || p.date,
      guest:  (p.notes || '').split(' · ')[0] || '—',
      code:   p.confirmationCode || p.airbnbRef || '—',
      nights: p.airbnbNights || 0,
      eur:    toEUR(p.amount, p.currency || 'EUR', p.date)
    }))
    .sort((a, b) => (a.date || '').localeCompare(b.date || ''));
}

// ===== SHARED MONTHLY GRID =====
function buildMonthlyGrid(entityId, year, type, onChange) {
  const fc = getOrCreateForecast(type, entityId, year);
  const now = new Date();

  const card = el('div', { class: 'card' });
  card.appendChild(el('div', { class: 'card-header' },
    el('div', { class: 'card-title' }, `Monthly Forecast — ${year}`),
    el('div', { class: 'muted', style: 'font-size:12px' }, 'Click forecast revenue to drill down · Click expenses to manage entries')
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
    <th class="right">Actual Expenses</th>
    <th class="right">Actual Net</th>
    <th class="right">Rev Variance</th>
    <th class="right">Var %</th>
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

      // Property forecast revenue: drill-down if pending Airbnb payments exist,
      // otherwise falls back to inline edit. Always shows a pencil icon for manual edit.
      function makeForecastRevCell(current, mk, monthIdx) {
        const pending = getPendingAirbnbRows(entityId, mk);
        const cell = el('td', { class: 'right num', style: 'white-space:nowrap' });

        const amtSpan = el('span', {}, formatEUR(current));
        cell.appendChild(amtSpan);

        // Edit icon — always present; stops propagation so it doesn't trigger drill-down
        const editIcon = el('span', {
          title: 'Edit forecast value',
          style: 'margin-left:6px;opacity:0.35;font-size:11px;cursor:pointer;user-select:none'
        }, '✎');
        editIcon.onmouseenter = () => { editIcon.style.opacity = '1'; };
        editIcon.onmouseleave = () => { editIcon.style.opacity = '0.35'; };
        editIcon.onclick = e => {
          e.stopPropagation();
          cell.innerHTML = '';
          const inp = el('input', { type: 'number', value: current, min: 0,
            style: 'width:100px;text-align:right;background:var(--bg-elev-3);border:1px solid var(--accent);border-radius:4px;padding:4px 6px;color:var(--text)' });
          cell.appendChild(inp); inp.focus(); inp.select();
          const commit = () => {
            const val = Number(inp.value) || 0;
            saveForecastMonth(fc.id, mk, { revenue: val });
            current = val;
            cell.innerHTML = '';
            amtSpan.textContent = formatEUR(val);
            cell.appendChild(amtSpan);
            cell.appendChild(editIcon);
            rebuildTotals();
            if (onChange) onChange();
          };
          inp.onblur = commit;
          inp.onkeydown = ev => { if (ev.key === 'Enter') commit(); if (ev.key === 'Escape') { cell.innerHTML = ''; cell.appendChild(amtSpan); cell.appendChild(editIcon); } };
        };
        cell.appendChild(editIcon);

        if (pending.length > 0) {
          // Sub-label showing reservation count
          const sub = el('div', { class: 'muted', style: 'font-size:11px;font-weight:400' },
            `${pending.length} reservation${pending.length === 1 ? '' : 's'}`);
          cell.appendChild(sub);
          cell.style.cursor = 'pointer';
          cell.title = 'Click to see pending reservations';
          cell.onclick = () => drillDownModal(
            `Forecast Revenue — ${MONTHS[monthIdx]} ${year}`, pending, FC_PENDING_COLS);
        }
        return cell;
      }

      const net = mData.forecastRev - mData.forecastExp;
      if (type === 'service') {
        tr.appendChild(makeEntriesCell(monthKey, mData.forecastRev, i));
      } else {
        tr.appendChild(makeForecastRevCell(mData.forecastRev, monthKey, i));
      }
      tr.appendChild(makeExpEntriesCell(monthKey, mData.forecastExp, i));
      tr.appendChild(el('td', { class: 'right num' + (net < 0 ? ' danger' : '') }, formatEUR(net)));
      // Actual Revenue — clickable drill-down
      const actRevCell = el('td', { class: 'right num ' + (isPast ? '' : 'muted') });
      actRevCell.textContent = formatEUR(mData.actualRev);
      if (mData.actualRev > 0) {
        actRevCell.style.cursor = 'pointer';
        actRevCell.title = 'Click for revenue records';
        actRevCell.onclick = () => drillDownModal(
          `Actual Revenue — ${MONTHS[i]}`, getActualRevRows(entityId, type, monthKey), FC_REV_COLS);
      }
      tr.appendChild(actRevCell);

      // Actual Expenses — clickable drill-down
      const actExpCell = el('td', { class: 'right num ' + (isPast ? '' : 'muted') });
      actExpCell.textContent = (isPast || mData.actualExp > 0) ? formatEUR(mData.actualExp) : '—';
      if (mData.actualExp > 0) {
        actExpCell.style.cursor = 'pointer';
        actExpCell.title = 'Click for expense records';
        actExpCell.onclick = () => drillDownModal(
          `Actual Expenses — ${MONTHS[i]}`, getActualExpRows(entityId, type, monthKey), FC_EXP_COLS);
      }
      tr.appendChild(actExpCell);

      // Actual Net
      const actualNet = mData.actualRev - mData.actualExp;
      const showAct = isPast || mData.actualRev > 0 || mData.actualExp > 0;
      tr.appendChild(el('td', { class: 'right num ' + (showAct ? (actualNet < 0 ? 'danger' : '') : 'muted') },
        showAct ? formatEUR(actualNet) : '—'));

      // Rev Variance — clickable drill-down
      const showVar = isPast || mData.actualRev > 0;
      const varCell = el('td', { class: `right num ${mData.revVariance >= 0 ? '' : 'danger'}` });
      varCell.textContent = showVar ? formatEUR(mData.revVariance) : '—';
      if (showVar) {
        varCell.style.cursor = 'pointer';
        varCell.title = 'Click for variance breakdown';
        varCell.onclick = () => drillDownModal(`Variance — ${MONTHS[i]}`, [
          { label: 'Forecast Revenue',           eur: mData.forecastRev,   pct: '' },
          { label: 'Actual Revenue',             eur: mData.actualRev,     pct: '' },
          { label: 'Variance (Actual − Forecast)', eur: mData.revVariance,
            pct: mData.forecastRev > 0 ? ((mData.revVariance / mData.forecastRev) * 100).toFixed(1) + '%' : '—' },
        ], FC_VAR_COLS);
      }
      tr.appendChild(varCell);

      // Var %
      const varPct = mData.forecastRev > 0 && showVar
        ? ((mData.revVariance / mData.forecastRev) * 100).toFixed(1) + '%' : '—';
      tr.appendChild(el('td', { class: `right num ${mData.revVariance < 0 && showVar ? 'danger' : ''}` }, varPct));
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
    const fcRev  = months.reduce((s, m) => s + m.forecastRev, 0);
    const fcExp  = months.reduce((s, m) => s + m.forecastExp, 0);
    const fcNet  = fcRev - fcExp;
    const actRev = months.reduce((s, m) => s + m.actualRev, 0);
    const actExp = months.reduce((s, m) => s + m.actualExp, 0);
    const actNet = actRev - actExp;
    const variance = actRev - fcRev;
    const varPct   = fcRev > 0 ? ((variance / fcRev) * 100).toFixed(1) + '%' : '—';

    const tRow = el('tr', { style: 'font-weight:600;background:var(--bg-elev-2)' });
    tRow.appendChild(el('td', { style: 'font-size:11px;letter-spacing:.04em' }, 'TOTAL'));
    tRow.appendChild(el('td', { class: 'right num' }, formatEUR(fcRev)));
    tRow.appendChild(el('td', { class: 'right num' }, formatEUR(fcExp)));
    tRow.appendChild(el('td', { class: 'right num' + (fcNet < 0 ? ' danger' : '') }, formatEUR(fcNet)));
    tRow.appendChild(el('td', { class: 'right num' }, formatEUR(actRev)));
    tRow.appendChild(el('td', { class: 'right num' }, formatEUR(actExp)));
    tRow.appendChild(el('td', { class: 'right num' + (actNet < 0 ? ' danger' : '') }, formatEUR(actNet)));
    tRow.appendChild(el('td', { class: `right num ${variance >= 0 ? '' : 'danger'}` }, formatEUR(variance)));
    tRow.appendChild(el('td', { class: `right num ${variance >= 0 ? '' : 'danger'}` }, varPct));
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
      ytRow.appendChild(el('td', {})); // actExp
      ytRow.appendChild(el('td', {})); // actNet
      ytRow.appendChild(el('td', {})); // variance
      ytRow.appendChild(el('td', {})); // var%
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
    actualExp:   results.reduce((s, r) => s + r.months[i].actualExp, 0),
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
    <th class="right">Actual Expenses</th>
    <th class="right">Actual Net</th>
    <th class="right">Rev Variance</th>
    <th class="right">Var %</th>
  </tr></thead>`;
  const tb = el('tbody');

  const now = new Date();
  for (let i = 0; i < 12; i++) {
    const m = months[i];
    const isPast = new Date(Number(year), i + 1, 0) < now;
    const net    = m.forecastRev - m.forecastExp;
    const actNet = m.actualRev - m.actualExp;
    const showVar = isPast || m.actualRev > 0;
    const varPct  = m.forecastRev > 0 && showVar
      ? ((m.revVariance / m.forecastRev) * 100).toFixed(1) + '%' : '—';
    const tr = el('tr');
    tr.appendChild(el('td', {}, MONTHS[i]));

    // Forecast Revenue — clickable drill-down for property type
    const fRevCell = el('td', { class: 'right num' });
    if (type === 'property') {
      const pending = entityIds.flatMap(id => getPendingAirbnbRows(id, months[i].key))
        .sort((a, b) => (a.date || '').localeCompare(b.date || ''));
      fRevCell.appendChild(el('div', {}, formatEUR(m.forecastRev)));
      if (pending.length > 0) {
        fRevCell.appendChild(el('div', { class: 'muted', style: 'font-size:11px;font-weight:400' },
          `${pending.length} reservation${pending.length === 1 ? '' : 's'}`));
        fRevCell.style.cursor = 'pointer';
        fRevCell.title = 'Click to see pending reservations';
        fRevCell.onclick = () => drillDownModal(
          `Forecast Revenue — ${MONTHS[i]}`, pending, FC_PENDING_COLS);
      } else {
        fRevCell.textContent = formatEUR(m.forecastRev);
      }
    } else {
      fRevCell.textContent = formatEUR(m.forecastRev);
    }
    tr.appendChild(fRevCell);

    tr.appendChild(el('td', { class: 'right num' }, formatEUR(m.forecastExp)));
    tr.appendChild(el('td', { class: 'right num' + (net < 0 ? ' danger' : '') }, formatEUR(net)));

    // Actual Revenue — clickable
    const aRev = el('td', { class: 'right num ' + (isPast ? '' : 'muted') }, formatEUR(m.actualRev));
    if (m.actualRev > 0) {
      aRev.style.cursor = 'pointer'; aRev.title = 'Click for revenue records';
      aRev.onclick = () => {
        const rows = entityIds.flatMap(id => getActualRevRows(id, type, months[i].key))
          .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
        drillDownModal(`Actual Revenue — ${MONTHS[i]}`, rows, FC_REV_COLS);
      };
    }
    tr.appendChild(aRev);

    // Actual Expenses — clickable
    const showAct = isPast || m.actualExp > 0;
    const aExp = el('td', { class: 'right num ' + (isPast ? '' : 'muted') }, showAct ? formatEUR(m.actualExp) : '—');
    if (m.actualExp > 0) {
      aExp.style.cursor = 'pointer'; aExp.title = 'Click for expense records';
      aExp.onclick = () => {
        const rows = entityIds.flatMap(id => getActualExpRows(id, type, months[i].key))
          .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
        drillDownModal(`Actual Expenses — ${MONTHS[i]}`, rows, FC_EXP_COLS);
      };
    }
    tr.appendChild(aExp);

    tr.appendChild(el('td', { class: 'right num ' + (showAct ? (actNet < 0 ? 'danger' : '') : 'muted') },
      showAct ? formatEUR(actNet) : '—'));

    // Rev Variance — clickable
    const vCell = el('td', { class: `right num ${m.revVariance >= 0 ? '' : 'danger'}` });
    vCell.textContent = showVar ? formatEUR(m.revVariance) : '—';
    if (showVar) {
      vCell.style.cursor = 'pointer'; vCell.title = 'Click for variance breakdown';
      vCell.onclick = () => drillDownModal(`Variance — ${MONTHS[i]}`, [
        { label: 'Forecast Revenue',             eur: m.forecastRev, pct: '' },
        { label: 'Actual Revenue',               eur: m.actualRev,   pct: '' },
        { label: 'Variance (Actual − Forecast)', eur: m.revVariance,
          pct: m.forecastRev > 0 ? ((m.revVariance / m.forecastRev) * 100).toFixed(1) + '%' : '—' },
      ], FC_VAR_COLS);
    }
    tr.appendChild(vCell);
    tr.appendChild(el('td', { class: `right num ${m.revVariance < 0 && showVar ? 'danger' : ''}` }, varPct));
    tb.appendChild(tr);
  }

  const fcRev  = months.reduce((s, m) => s + m.forecastRev, 0);
  const fcExp  = months.reduce((s, m) => s + m.forecastExp, 0);
  const fcNet  = fcRev - fcExp;
  const actRev = months.reduce((s, m) => s + m.actualRev, 0);
  const actExp = months.reduce((s, m) => s + m.actualExp, 0);
  const actNet = actRev - actExp;
  const variance = actRev - fcRev;
  const totVarPct = fcRev > 0 ? ((variance / fcRev) * 100).toFixed(1) + '%' : '—';

  const tRow = el('tr', { style: 'font-weight:600;background:var(--bg-elev-2)' });
  tRow.appendChild(el('td', { style: 'font-size:11px;letter-spacing:.04em' }, 'TOTAL'));
  tRow.appendChild(el('td', { class: 'right num' }, formatEUR(fcRev)));
  tRow.appendChild(el('td', { class: 'right num' }, formatEUR(fcExp)));
  tRow.appendChild(el('td', { class: 'right num' + (fcNet < 0 ? ' danger' : '') }, formatEUR(fcNet)));
  tRow.appendChild(el('td', { class: 'right num' }, formatEUR(actRev)));
  tRow.appendChild(el('td', { class: 'right num' }, formatEUR(actExp)));
  tRow.appendChild(el('td', { class: 'right num' + (actNet < 0 ? ' danger' : '') }, formatEUR(actNet)));
  tRow.appendChild(el('td', { class: `right num ${variance >= 0 ? '' : 'danger'}` }, formatEUR(variance)));
  tRow.appendChild(el('td', { class: `right num ${variance >= 0 ? '' : 'danger'}` }, totVarPct));
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
    ytRow.appendChild(el('td', {})); // actExp
    ytRow.appendChild(el('td', {})); // actNet
    ytRow.appendChild(el('td', {})); // variance
    ytRow.appendChild(el('td', {})); // var%
    tb.appendChild(ytRow);
  }

  t.appendChild(tb);
  const tw = el('div', { class: 'table-wrap' }); tw.appendChild(t);
  card.appendChild(tw);
  return card;
}

// ===== PROPERTY BREAKDOWN CARD =====
function buildPropertyBreakdownCard(selIds, year, fcCache) {
  const rows = selIds.map(id => {
    const prop = byId('properties', id);
    const { months } = fcCache?.get(id) ?? getForecastVsActual('property', id, year);
    const fcRev  = months.reduce((s, m) => s + m.forecastRev, 0);
    const fcExp  = months.reduce((s, m) => s + m.forecastExp, 0);
    const actRev = months.reduce((s, m) => s + m.actualRev, 0);
    const actExp = months.reduce((s, m) => s + m.actualExp, 0);
    const revVar = actRev - fcRev;
    const sk     = prop?.type === 'short_term' ? 'short_term_rental' : 'long_term_rental';
    return { id, prop, fcRev, fcExp, actRev, actExp, revVar,
             fcNet: fcRev - fcExp, actNet: actRev - actExp,
             revVarPct: fcRev > 0 ? ((revVar / fcRev) * 100).toFixed(1) + '%' : '—',
             stream: STREAMS[sk]?.short || sk };
  });

  const card = el('div', { class: 'card mt-16' });
  card.appendChild(el('div', { class: 'card-header' },
    el('div', { class: 'card-title' }, 'Property-Level Forecast'),
    el('div', { style: 'font-size:12px;color:var(--text-muted)' }, `${year} · click row for monthly detail`)
  ));

  const t = el('table', { class: 'table' });
  t.innerHTML = `<thead><tr>
    <th>Property</th><th>Stream</th>
    <th class="right">For. Rev</th><th class="right">Act. Rev</th>
    <th class="right">Rev Var</th><th class="right">Var %</th>
    <th class="right">For. Exp</th><th class="right">Act. Exp</th>
    <th class="right">For. Net</th><th class="right">Act. Net</th>
  </tr></thead>`;
  const tb = el('tbody');

  rows.forEach(d => {
    const tr = el('tr', { style: 'cursor:pointer', title: 'Click for monthly breakdown' });
    tr.onclick = () => {
      const { months } = getForecastVsActual('property', d.id, year);
      const mRows = months.map((m, i) => ({
        month:   MONTHS[i],
        fcRev:   formatEUR(m.forecastRev),
        actRev:  formatEUR(m.actualRev),
        revVar:  formatEUR(m.revVariance),
        varPct:  m.forecastRev > 0 ? ((m.revVariance / m.forecastRev) * 100).toFixed(1) + '%' : '—',
        fcExp:   formatEUR(m.forecastExp),
        actExp:  formatEUR(m.actualExp),
        actNet:  formatEUR(m.actualRev - m.actualExp),
      }));
      drillDownModal(`${d.prop?.name || d.id} — ${year}`, mRows, [
        { key: 'month',  label: 'Month' },
        { key: 'fcRev',  label: 'For. Rev',  right: true },
        { key: 'actRev', label: 'Act. Rev',  right: true },
        { key: 'revVar', label: 'Variance',  right: true },
        { key: 'varPct', label: 'Var %',     right: true },
        { key: 'fcExp',  label: 'For. Exp',  right: true },
        { key: 'actExp', label: 'Act. Exp',  right: true },
        { key: 'actNet', label: 'Act. Net',  right: true },
      ]);
    };
    tr.appendChild(el('td', {}, d.prop?.name || d.id));
    tr.appendChild(el('td', {}, d.stream));
    tr.appendChild(el('td', { class: 'right num' }, formatEUR(d.fcRev)));
    tr.appendChild(el('td', { class: 'right num' }, formatEUR(d.actRev)));
    tr.appendChild(el('td', { class: `right num ${d.revVar >= 0 ? '' : 'danger'}` }, formatEUR(d.revVar)));
    tr.appendChild(el('td', { class: `right num ${d.revVar >= 0 ? '' : 'danger'}` }, d.revVarPct));
    tr.appendChild(el('td', { class: 'right num' }, formatEUR(d.fcExp)));
    tr.appendChild(el('td', { class: 'right num' }, formatEUR(d.actExp)));
    tr.appendChild(el('td', { class: `right num ${d.fcNet < 0 ? 'danger' : ''}` }, formatEUR(d.fcNet)));
    tr.appendChild(el('td', { class: `right num ${d.actNet < 0 ? 'danger' : ''}` }, formatEUR(d.actNet)));
    tb.appendChild(tr);
  });

  // Totals row
  const tot = rows.reduce((a, d) => ({
    fcRev:  a.fcRev  + d.fcRev,  fcExp:  a.fcExp  + d.fcExp,
    actRev: a.actRev + d.actRev, actExp: a.actExp + d.actExp,
    revVar: a.revVar + d.revVar, fcNet:  a.fcNet  + d.fcNet,
    actNet: a.actNet + d.actNet,
  }), { fcRev: 0, fcExp: 0, actRev: 0, actExp: 0, revVar: 0, fcNet: 0, actNet: 0 });
  const totVarPct = tot.fcRev > 0 ? ((tot.revVar / tot.fcRev) * 100).toFixed(1) + '%' : '—';
  const tRow = el('tr', { style: 'font-weight:600;background:var(--bg-elev-2)' });
  ['TOTAL', ''].forEach(v => tRow.appendChild(el('td', { style: 'font-size:11px;letter-spacing:.04em' }, v)));
  [tot.fcRev, tot.actRev].forEach(v => tRow.appendChild(el('td', { class: 'right num' }, formatEUR(v))));
  tRow.appendChild(el('td', { class: `right num ${tot.revVar >= 0 ? '' : 'danger'}` }, formatEUR(tot.revVar)));
  tRow.appendChild(el('td', { class: `right num ${tot.revVar >= 0 ? '' : 'danger'}` }, totVarPct));
  [tot.fcExp, tot.actExp].forEach(v => tRow.appendChild(el('td', { class: 'right num' }, formatEUR(v))));
  tRow.appendChild(el('td', { class: `right num ${tot.fcNet < 0 ? 'danger' : ''}` }, formatEUR(tot.fcNet)));
  tRow.appendChild(el('td', { class: `right num ${tot.actNet < 0 ? 'danger' : ''}` }, formatEUR(tot.actNet)));
  tb.appendChild(tRow);

  t.appendChild(tb);
  const tw = el('div', { class: 'table-wrap' }); tw.appendChild(t);
  card.appendChild(tw);
  return card;
}

// ===== STREAM BREAKDOWN CARD =====
function buildStreamBreakdownCard(selIds, year, fcCache) {
  const streamMap = new Map();
  selIds.forEach(id => {
    const prop = byId('properties', id);
    const sk   = prop?.type === 'short_term' ? 'short_term_rental' : 'long_term_rental';
    const { months } = fcCache?.get(id) ?? getForecastVsActual('property', id, year);
    const fcRev  = months.reduce((s, m) => s + m.forecastRev, 0);
    const fcExp  = months.reduce((s, m) => s + m.forecastExp, 0);
    const actRev = months.reduce((s, m) => s + m.actualRev, 0);
    const actExp = months.reduce((s, m) => s + m.actualExp, 0);
    const cur = streamMap.get(sk) || { fcRev: 0, fcExp: 0, actRev: 0, actExp: 0, count: 0 };
    streamMap.set(sk, { fcRev: cur.fcRev + fcRev, fcExp: cur.fcExp + fcExp,
      actRev: cur.actRev + actRev, actExp: cur.actExp + actExp, count: cur.count + 1 });
  });

  if (streamMap.size < 2) return null; // only meaningful when both streams present

  const card = el('div', { class: 'card mt-16' });
  card.appendChild(el('div', { class: 'card-header' },
    el('div', { class: 'card-title' }, 'Stream-Level Forecast'),
    el('div', { style: 'font-size:12px;color:var(--text-muted)' }, `${year} · click row for underlying records`)
  ));

  const t = el('table', { class: 'table' });
  t.innerHTML = `<thead><tr>
    <th>Stream</th><th class="right">Properties</th>
    <th class="right">For. Rev</th><th class="right">Act. Rev</th>
    <th class="right">Rev Var</th><th class="right">Var %</th>
    <th class="right">For. Exp</th><th class="right">Act. Exp</th>
    <th class="right">For. Net</th><th class="right">Act. Net</th>
  </tr></thead>`;
  const tb = el('tbody');

  [...streamMap.entries()].forEach(([sk, d]) => {
    const revVar = d.actRev - d.fcRev;
    const varPct = d.fcRev > 0 ? ((revVar / d.fcRev) * 100).toFixed(1) + '%' : '—';
    const fcNet  = d.fcRev - d.fcExp;
    const actNet = d.actRev - d.actExp;
    const tr = el('tr', { style: 'cursor:pointer', title: 'Click for underlying properties' });
    tr.onclick = () => {
      const propRows = selIds
        .filter(id => { const p = byId('properties', id); return (p?.type === 'short_term' ? 'short_term_rental' : 'long_term_rental') === sk; })
        .map(id => {
          const p = byId('properties', id);
          const { months } = getForecastVsActual('property', id, year);
          const fRev = months.reduce((s, m) => s + m.forecastRev, 0);
          const aRev = months.reduce((s, m) => s + m.actualRev, 0);
          return { name: p?.name || id, fcRev: formatEUR(fRev), actRev: formatEUR(aRev),
            revVar: formatEUR(aRev - fRev),
            varPct: fRev > 0 ? ((aRev - fRev) / fRev * 100).toFixed(1) + '%' : '—' };
        });
      drillDownModal(`${STREAMS[sk]?.label || sk} — Properties`, propRows, [
        { key: 'name',   label: 'Property' },
        { key: 'fcRev',  label: 'For. Rev',  right: true },
        { key: 'actRev', label: 'Act. Rev',  right: true },
        { key: 'revVar', label: 'Variance',  right: true },
        { key: 'varPct', label: 'Var %',     right: true },
      ]);
    };
    tr.appendChild(el('td', {}, STREAMS[sk]?.label || sk));
    tr.appendChild(el('td', { class: 'right num' }, String(d.count)));
    tr.appendChild(el('td', { class: 'right num' }, formatEUR(d.fcRev)));
    tr.appendChild(el('td', { class: 'right num' }, formatEUR(d.actRev)));
    tr.appendChild(el('td', { class: `right num ${revVar >= 0 ? '' : 'danger'}` }, formatEUR(revVar)));
    tr.appendChild(el('td', { class: `right num ${revVar >= 0 ? '' : 'danger'}` }, varPct));
    tr.appendChild(el('td', { class: 'right num' }, formatEUR(d.fcExp)));
    tr.appendChild(el('td', { class: 'right num' }, formatEUR(d.actExp)));
    tr.appendChild(el('td', { class: `right num ${fcNet < 0 ? 'danger' : ''}` }, formatEUR(fcNet)));
    tr.appendChild(el('td', { class: `right num ${actNet < 0 ? 'danger' : ''}` }, formatEUR(actNet)));
    tb.appendChild(tr);
  });

  t.appendChild(tb);
  const tw = el('div', { class: 'table-wrap' }); tw.appendChild(t);
  card.appendChild(tw);
  return card;
}

function summaryRow(label, value, variant) {
  return el('div', { class: 'flex justify-between items-center', style: 'padding:4px 0' },
    el('span', { class: 'muted', style: 'font-size:12px' }, label),
    el('span', { class: 'num ' + (variant || ''), style: 'font-weight:600' }, value)
  );
}
