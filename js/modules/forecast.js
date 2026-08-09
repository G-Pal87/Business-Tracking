// Forecast module: monthly grid per property/service
import { state, markDirty } from '../core/state.js';
import { el, select, input, button, formRow, toast, fmtDate, openModal, closeModal, confirmDialog, drillDownModal, attachSortFilter } from '../core/ui.js';
import * as charts from '../core/charts.js';
import { formatEUR, toEUR, byId, newId, availableYears, getOrCreateForecast, saveForecastMonth, saveForecastYear, getForecastVsActual, getForecastEntries, upsertForecastEntry, removeForecastEntry, sumForecastEntries, listActive, listActivePayments, generatePaymentSchedule } from '../core/data.js';
import { STREAMS, EXPENSE_CATEGORIES } from '../core/config.js';
import { backfillAirbnbForecastEntries } from './payments.js';
// mkExplainButton is the same "ⓘ how is this calculated" affordance used by
// the analytics dashboards (see analytics-helpers.js) — reused here for the
// Annual Summary panel's computed figures rather than re-implementing it.
import { mkExplainButton } from './analytics-helpers.js';

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

let _fcBreakSortCol  = -1, _fcBreakSortDir  = 1, _fcBreakSearch  = '';
let _fcStreamSortCol = -1, _fcStreamSortDir = 1, _fcStreamSearch = '';

// Property/Service Forecast filter selections — persisted at module scope so
// they survive refresh() calls triggered by background data syncs (initial
// GitHub pull, periodic resync). Without this, buildPropertySection/
// buildServiceSection re-declare fresh local state on every rebuild, so any
// sync landing while a filter is set silently resets it back to "all
// selected". null means "not yet touched by the user" so the first render
// still defaults to "all selected" rather than an empty, everything-hidden
// state.
let gPropSelectedIds   = null;
let gPropStreamIds     = new Set();
let gPropSelectedYears = new Set();
let gSvcSelectedIds    = null;
let gSvcSelectedYears  = new Set();

export default {
  id: 'forecast',
  label: 'Forecast',
  icon: '🔭',
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

  // Restore persisted filter selections (see module-level vars near the top
  // of this file); prune any property ids deleted since the last visit.
  if (gPropSelectedIds === null) gPropSelectedIds = new Set(props.map(p => p.id));
  gPropSelectedIds = new Set([...gPropSelectedIds].filter(id => props.some(p => p.id === id)));
  if (gPropSelectedIds.size === 0) gPropSelectedIds = new Set(props.map(p => p.id));
  let selectedPropIds = gPropSelectedIds;
  let selectedStreamIds = gPropStreamIds; // empty = all
  let selectedYears = gPropSelectedYears;
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
  allStreamChk.checked = selectedStreamIds.size === 0;
  streamMenu.appendChild(el('label', { style: LABEL_STYLE + ';border-bottom:1px solid var(--border)' }, allStreamChk, el('span', {}, 'All Streams')));
  const streamChks = streamOpts.map(opt => {
    const chk = el('input', { type: 'checkbox' });
    chk.dataset.value = opt.value;
    chk.checked = selectedStreamIds.size === 0 || selectedStreamIds.has(opt.value);
    streamMenu.appendChild(el('label', { style: LABEL_STYLE }, chk, el('span', {}, opt.label)));
    return chk;
  });

  // ── Property checklist ────────────────────────────────────────────────────
  // Short-term listings can carry long names (e.g. "Poolside Central Studio |
  // Balcony & Beach Walk") — without a cap, a single selected long name grows
  // the trigger button (and stretches the whole toolbar), and an unconstrained
  // row in the dropdown grows the menu just as wide. Both get a hard max-width
  // with ellipsis truncation instead; the full name is still available via
  // the title tooltip on hover.
  const TRIG_LABEL_STYLE = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:220px;min-width:0;display:inline-block;vertical-align:middle';
  const propWrapper = el('div', { style: 'position:relative' });
  const trigLabel = el('span', { style: TRIG_LABEL_STYLE }, 'All Properties');
  const propTrigger = el('div', { class: 'select', style: 'cursor:pointer;display:flex;align-items:center;width:auto;min-width:160px;max-width:260px;user-select:none' }, trigLabel);
  const propMenu = el('div', { style: MENU_STYLE.replace('200px', '240px') + ';max-width:320px' });
  const allChk = el('input', { type: 'checkbox' });
  allChk.checked = selectedPropIds.size === props.length;
  propMenu.appendChild(el('label', { style: LABEL_STYLE + ';border-bottom:1px solid var(--border)' }, allChk, el('span', {}, 'All Properties')));
  const propChks = props.map(p => {
    const chk = el('input', { type: 'checkbox' });
    chk.dataset.id = p.id;
    chk.checked = selectedPropIds.has(p.id);
    const nameSpan = el('span', { style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0' }, p.name);
    nameSpan.title = p.name;
    propMenu.appendChild(el('label', { style: LABEL_STYLE }, chk, nameSpan));
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
    gPropSelectedYears = selectedYears;
  };

  const syncPropSel = () => {
    const visibleChks = propChks.filter(c => c.closest('label')?.style.display !== 'none');
    const sel = visibleChks.filter(c => c.checked);
    allChk.checked = visibleChks.length > 0 && sel.length === visibleChks.length;
    allChk.indeterminate = sel.length > 0 && sel.length < visibleChks.length;
    const singleName = sel.length === 1 ? (props.find(p => p.id === sel[0].dataset.id)?.name || '1 Property') : null;
    trigLabel.textContent = sel.length === visibleChks.length && visibleChks.length > 0 ? 'All Properties'
      : sel.length === 0 ? 'No Properties'
      : sel.length === 1 ? singleName
      : `${sel.length} Properties`;
    trigLabel.title = singleName || ''; // full name on hover when the trigger label is ellipsis-truncated
    selectedPropIds = new Set(propChks.filter(c => c.checked).map(c => c.dataset.id));
    gPropSelectedIds = selectedPropIds;
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
    gPropStreamIds = selectedStreamIds;
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
        gridWrap.appendChild(buildAggregatedGrid(selIds, year, 'property', () => render()));
      }
    }
    requestAnimationFrame(() => { renderChart(aggCache); renderSummary(aggCache); renderBreakdown(selIds); });
  };

  const renderBreakdown = (selIds) => {
    breakdownWrap.innerHTML = '';
    const years = getSelYears();
    const year = years[years.length - 1] || String(new Date().getFullYear());
    const fcCache = new Map(selIds.map(id => [id, getForecastVsActual('property', id, year)]));
    const bCard = buildPropertyBreakdownCard(selIds, year, fcCache);
    breakdownWrap.appendChild(bCard);
    const bTw = bCard.querySelector('.table-wrap');
    if (bTw) attachSortFilter(bTw, { initialCol: _fcBreakSortCol, initialDir: _fcBreakSortDir, initialSearch: _fcBreakSearch, onSortChange: (c, d) => { _fcBreakSortCol = c; _fcBreakSortDir = d; }, onSearchChange: v => { _fcBreakSearch = v; } });
    const sCard = buildStreamBreakdownCard(selIds, year, fcCache);
    if (sCard) {
      breakdownWrap.appendChild(sCard);
      const sTw = sCard.querySelector('.table-wrap');
      if (sTw) attachSortFilter(sTw, { initialCol: _fcStreamSortCol, initialDir: _fcStreamSortDir, initialSearch: _fcStreamSearch, onSortChange: (c, d) => { _fcStreamSortCol = c; _fcStreamSortDir = d; }, onSearchChange: v => { _fcStreamSearch = v; } });
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
      for (const m of agg.months) { forecastRev += m.forecastRev; forecastExp += m.forecastExp; actualRev += m.actualRev; actualExp += m.actualExp; }
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
      summaryRow('Forecast Revenue',      formatEUR(forecastRev), null, {
        title: 'Forecast Revenue', formula: 'Sum of each selected month\'s Forecast Revenue, across every selected property and year.',
        inputs: [{ label: 'Months summed', value: String(allMonths.length) }, { label: 'Total', value: formatEUR(forecastRev) }],
        source: 'js/modules/forecast.js buildPropertySection() renderSummary()',
        note: 'Each month\'s figure excludes cancelled/removed forecast entries — see sumForecastEntries() in core/data.js.'
      }),
      summaryRow('Forecast Expenses',     formatEUR(forecastExp), null, {
        title: 'Forecast Expenses', formula: 'Sum of each selected month\'s Forecast Expenses, across every selected property and year.',
        inputs: [{ label: 'Months summed', value: String(allMonths.length) }, { label: 'Total', value: formatEUR(forecastExp) }],
        source: 'js/modules/forecast.js buildPropertySection() renderSummary()'
      }),
      summaryRow('Forecast Net',          formatEUR(forecastRev - forecastExp), null, {
        title: 'Forecast Net', formula: 'Forecast Revenue − Forecast Expenses',
        inputs: [{ label: 'Forecast Revenue', value: formatEUR(forecastRev) }, { label: 'Forecast Expenses', value: formatEUR(forecastExp) }],
        source: 'js/modules/forecast.js buildPropertySection() renderSummary()'
      }),
      el('hr', { style: 'border-color:var(--border);margin:8px 0' }),
      summaryRow('Actual Revenue YTD',    formatEUR(actualRev), null, {
        title: 'Actual Revenue YTD', formula: 'Sum of actual paid payments dated within each selected month, across every selected property and year.',
        inputs: [{ label: 'Total', value: formatEUR(actualRev) }],
        source: 'js/core/data.js getForecastVsActual() — `actualRev`'
      }),
      summaryRow('Actual Expenses YTD',   formatEUR(actualExp), null, {
        title: 'Actual Expenses YTD', formula: 'Sum of actual expenses dated within each selected month, across every selected property and year. Excludes CapEx/renovation.',
        inputs: [{ label: 'Total', value: formatEUR(actualExp) }],
        source: 'js/core/data.js getForecastVsActual() — `actualExp`'
      }),
      summaryRow('Actual Net YTD',        formatEUR(actualRev - actualExp), null, {
        title: 'Actual Net YTD', formula: 'Actual Revenue YTD − Actual Expenses YTD',
        inputs: [{ label: 'Actual Revenue YTD', value: formatEUR(actualRev) }, { label: 'Actual Expenses YTD', value: formatEUR(actualExp) }],
        source: 'js/modules/forecast.js buildPropertySection() renderSummary()'
      }),
      el('hr', { style: 'border-color:var(--border);margin:8px 0' }),
      summaryRow('Revenue Variance YTD',  formatEUR(actualRev - forecastRev), actualRev >= forecastRev ? 'success' : 'danger', {
        title: 'Revenue Variance YTD', formula: 'Actual Revenue YTD − Forecast Revenue',
        inputs: [{ label: 'Actual Revenue YTD', value: formatEUR(actualRev) }, { label: 'Forecast Revenue', value: formatEUR(forecastRev) }],
        source: 'js/modules/forecast.js buildPropertySection() renderSummary()'
      }),
      summaryRow('Revenue Variance %',    forecastRev > 0 ? ((actualRev - forecastRev) / forecastRev * 100).toFixed(1) + '%' : '—',
        actualRev >= forecastRev ? 'success' : 'danger', {
        title: 'Revenue Variance %', formula: '(Actual Revenue YTD − Forecast Revenue) ÷ Forecast Revenue × 100',
        inputs: [{ label: 'Revenue Variance YTD', value: formatEUR(actualRev - forecastRev) }, { label: 'Forecast Revenue', value: formatEUR(forecastRev) }],
        source: 'js/modules/forecast.js buildPropertySection() renderSummary()',
        note: 'Shows "—" when Forecast Revenue is €0 to avoid dividing by zero.'
      }),
    ];
    if (yearTarget.revenue || yearTarget.expenses) {
      const ytRev = yearTarget.revenue || 0;
      items.push(
        el('hr', { style: 'border-color:var(--border);margin:8px 0' }),
        summaryRow('Annual Target Revenue',  formatEUR(ytRev), null, {
          title: 'Annual Target Revenue', formula: 'Sum of each selected property\'s own Annual Target Revenue for the selected year(s).',
          inputs: [{ label: 'Total', value: formatEUR(ytRev) }],
          source: 'js/core/data.js saveForecastYear() / fc.yearTarget.revenue',
          note: 'Set per-property on the "Annual Target" bar above the monthly grid.'
        }),
        summaryRow('Annual Target Expenses', formatEUR(yearTarget.expenses || 0), null, {
          title: 'Annual Target Expenses', formula: 'Sum of each selected property\'s own Annual Target Expenses for the selected year(s).',
          inputs: [{ label: 'Total', value: formatEUR(yearTarget.expenses || 0) }],
          source: 'js/core/data.js saveForecastYear() / fc.yearTarget.expenses'
        }),
        summaryRow('Forecast vs Target',     formatEUR(forecastRev - ytRev), forecastRev >= ytRev ? 'success' : 'danger', {
          title: 'Forecast vs Target', formula: 'Forecast Revenue − Annual Target Revenue',
          inputs: [{ label: 'Forecast Revenue', value: formatEUR(forecastRev) }, { label: 'Annual Target Revenue', value: formatEUR(ytRev) }],
          source: 'js/modules/forecast.js buildPropertySection() renderSummary()'
        }),
        summaryRow('Actual vs Target',       formatEUR(actualRev   - ytRev), actualRev   >= ytRev ? 'success' : 'danger', {
          title: 'Actual vs Target', formula: 'Actual Revenue YTD − Annual Target Revenue',
          inputs: [{ label: 'Actual Revenue YTD', value: formatEUR(actualRev) }, { label: 'Annual Target Revenue', value: formatEUR(ytRev) }],
          source: 'js/modules/forecast.js buildPropertySection() renderSummary()'
        }),
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
  // Restore persisted selection (module-level — see top of file) so a
  // background sync landing mid-edit doesn't reset it.
  if (gSvcSelectedIds === null) gSvcSelectedIds = new Set(serviceEntities.map(s => s.id));
  let selectedStreamIds = gSvcSelectedIds;

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
  allSvcChk.checked = selectedStreamIds.size === serviceEntities.length;
  svcMenu.appendChild(el('label', { style: 'display:flex;align-items:center;gap:8px;padding:6px 12px;cursor:pointer;border-bottom:1px solid var(--border);font-size:13px' },
    allSvcChk, el('span', {}, 'All Services')));

  const svcChks = serviceEntities.map(s => {
    const chk = el('input', { type: 'checkbox' });
    chk.dataset.id = s.id;
    chk.checked = selectedStreamIds.has(s.id);
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
    gSvcSelectedIds = selectedStreamIds;
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
  let selectedSvcYears = gSvcSelectedYears;

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
    gSvcSelectedYears = selectedSvcYears;
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
        gridWrap.appendChild(buildAggregatedGrid(selIds, year, 'service', () => render()));
      }
    }
    requestAnimationFrame(() => { renderChart(aggCache); renderSummary(aggCache); });
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
      for (const m of agg.months) { forecastRev += m.forecastRev; actualRev += m.actualRev; }
      yearTarget.revenue += agg.yearTarget?.revenue || 0;
      allMonths = allMonths.concat(agg.months);
    }
    const el2 = document.getElementById('fc-svc-summary');
    if (!el2) return;
    el2.innerHTML = '';
    const insightItems = buildForecastInsightItems(allMonths, yearTarget);
    const items = [
      ...insightItems,
      summaryRow('Forecast Revenue', formatEUR(forecastRev), null, {
        title: 'Forecast Revenue', formula: 'Sum of each selected month\'s Forecast Revenue, across every selected service and year.',
        inputs: [{ label: 'Months summed', value: String(allMonths.length) }, { label: 'Total', value: formatEUR(forecastRev) }],
        source: 'js/modules/forecast.js buildServiceSection() renderSummary()',
        note: 'Each month\'s figure excludes cancelled/removed forecast entries — see sumForecastEntries() in core/data.js.'
      }),
      el('hr', { style: 'border-color:var(--border);margin:8px 0' }),
      summaryRow('Actual Revenue YTD', formatEUR(actualRev), null, {
        title: 'Actual Revenue YTD', formula: 'Sum of actual paid invoices issued within each selected month, across every selected service and year.',
        inputs: [{ label: 'Total', value: formatEUR(actualRev) }],
        source: 'js/core/data.js getForecastVsActual() — `actualRev`'
      }),
      el('hr', { style: 'border-color:var(--border);margin:8px 0' }),
      summaryRow('Revenue Variance YTD', formatEUR(actualRev - forecastRev), actualRev >= forecastRev ? 'success' : 'danger', {
        title: 'Revenue Variance YTD', formula: 'Actual Revenue YTD − Forecast Revenue',
        inputs: [{ label: 'Actual Revenue YTD', value: formatEUR(actualRev) }, { label: 'Forecast Revenue', value: formatEUR(forecastRev) }],
        source: 'js/modules/forecast.js buildServiceSection() renderSummary()'
      }),
      summaryRow('Revenue Variance %',   forecastRev > 0 ? ((actualRev - forecastRev) / forecastRev * 100).toFixed(1) + '%' : '—',
        actualRev >= forecastRev ? 'success' : 'danger', {
        title: 'Revenue Variance %', formula: '(Actual Revenue YTD − Forecast Revenue) ÷ Forecast Revenue × 100',
        inputs: [{ label: 'Revenue Variance YTD', value: formatEUR(actualRev - forecastRev) }, { label: 'Forecast Revenue', value: formatEUR(forecastRev) }],
        source: 'js/modules/forecast.js buildServiceSection() renderSummary()',
        note: 'Shows "—" when Forecast Revenue is €0 to avoid dividing by zero.'
      }),
    ];
    if (yearTarget.revenue) {
      const ytRev = yearTarget.revenue;
      items.push(
        el('hr', { style: 'border-color:var(--border);margin:8px 0' }),
        summaryRow('Annual Target', formatEUR(ytRev), null, {
          title: 'Annual Target', formula: 'Sum of each selected service\'s own Annual Target Revenue for the selected year(s).',
          inputs: [{ label: 'Total', value: formatEUR(ytRev) }],
          source: 'js/core/data.js saveForecastYear() / fc.yearTarget.revenue',
          note: 'Set per-service on the "Annual Target" bar above the monthly grid.'
        }),
        summaryRow('Forecast vs Target', formatEUR(forecastRev - ytRev), forecastRev >= ytRev ? 'success' : 'danger', {
          title: 'Forecast vs Target', formula: 'Forecast Revenue − Annual Target',
          inputs: [{ label: 'Forecast Revenue', value: formatEUR(forecastRev) }, { label: 'Annual Target', value: formatEUR(ytRev) }],
          source: 'js/modules/forecast.js buildServiceSection() renderSummary()'
        }),
        summaryRow('Actual vs Target', formatEUR(actualRev - ytRev), actualRev >= ytRev ? 'success' : 'danger', {
          title: 'Actual vs Target', formula: 'Actual Revenue YTD − Annual Target',
          inputs: [{ label: 'Actual Revenue YTD', value: formatEUR(actualRev) }, { label: 'Annual Target', value: formatEUR(ytRev) }],
          source: 'js/modules/forecast.js buildServiceSection() renderSummary()'
        }),
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
  { key: 'date',   label: 'Date',       format: v => fmtDate(v), tip: 'Payment date (property) or invoice issue date (service).' },
  { key: 'source', label: 'Source',     tip: 'Property this payment belongs to (property forecast) or client billed (service forecast).' },
  { key: 'ref',    label: 'Type',       tip: 'Payment/booking type, e.g. Airbnb vs manual (property), or the invoice number (service).' },
  { key: 'code',   label: 'Conf. Code', tip: 'Airbnb confirmation code, when the payment is booking-linked (property only).' },
  { key: 'eur',    label: 'EUR',        right: true, format: v => formatEUR(v), tip: 'Amount converted to EUR at this record\'s date.' }
];
const FC_EXP_COLS = [
  { key: 'date',     label: 'Date',        format: v => fmtDate(v), tip: 'Date the expense was recorded.' },
  { key: 'category', label: 'Category',    tip: 'Expense category, e.g. Cleaning, Maintenance, Utilities.' },
  { key: 'desc',     label: 'Description', tip: 'Expense description as entered.' },
  { key: 'vendor',   label: 'Vendor',      tip: 'Vendor name, if one was linked or entered.' },
  { key: 'eur',      label: 'EUR',         right: true, format: v => formatEUR(v), tip: 'Expense amount converted to EUR at this record\'s date. Excludes CapEx/renovation expenses.' }
];
const FC_VAR_COLS = [
  { key: 'label', label: 'Item', tip: 'Which figure this row shows: Forecast Revenue, Actual Revenue, or the Variance between them.' },
  { key: 'eur',   label: 'EUR', right: true, format: v => v === null ? '—' : formatEUR(v), tip: 'EUR amount for this line.' },
  { key: 'pct',   label: '%',   right: true, tip: 'Variance as a percentage of Forecast Revenue: (Actual − Forecast) ÷ Forecast × 100.' }
];
const BOOKING_STATUS_LABELS = { pending: 'Pending', materialized: 'Paid', cancelled: 'Cancelled', removed: 'Removed' };

// Reads the persisted, itemized Airbnb-sourced forecast entries for a
// property/month — one row per booking, however it currently stands
// (pending / materialized / cancelled / removed). Unlike the old approach of
// live-querying payments with status === 'pending', this works identically
// for past and future months, since a booking's entry sticks around (frozen
// or tombstoned) instead of vanishing once it pays out or gets cancelled.
function getAirbnbForecastEntries(propertyId, monthKey) {
  const fc = getOrCreateForecast('property', propertyId, monthKey.slice(0, 4));
  return getForecastEntries(fc.id, monthKey)
    .filter(e => e.auto)
    .map(e => ({
      id: e.id, date: e.checkIn, guest: e.guest || '—', code: e.confirmationCode || '—',
      nights: e.nights || 0, eur: e.amount, bookingStatus: e.bookingStatus,
      statusLabel: BOOKING_STATUS_LABELS[e.bookingStatus] || e.bookingStatus || '—'
    }))
    .sort((a, b) => (a.date || '').localeCompare(b.date || ''));
}

// ===== SHARED MONTHLY GRID =====
function buildMonthlyGrid(entityId, year, type, onChange) {
  // Idempotent, self-healing backfill: reconstructs any missing itemized
  // Airbnb forecast entry (e.g. from before this itemized model existed, or
  // from a past month whose entry had already been recalculated away to
  // zero) so past months keep their forecast instead of showing zero.
  if (type === 'property') backfillAirbnbForecastEntries(entityId);
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
    <th title="Calendar month within the selected forecast year.">Month</th>
    <th class="right" style="cursor:help" title="Sum of this month's forecasted amounts — itemized Airbnb-linked and manual booking entries for a property, or itemized entries for a service — excluding cancelled/removed entries. Click a cell to manage entries.">Forecast Revenue</th>
    <th class="right" style="cursor:help" title="Sum of this month's itemized forecast expense entries (properties only; always €0 for services). Click a cell to manage entries.">Forecast Expenses</th>
    <th class="right" style="cursor:help" title="Forecast Revenue minus Forecast Expenses for this month.">Forecast Net</th>
    <th class="right" style="cursor:help" title="Sum of paid payments (property) or paid invoices (service) actually recorded in this month, converted to EUR. Click a non-zero cell to see the underlying records.">Actual Revenue</th>
    <th class="right" style="cursor:help" title="Sum of actual expenses recorded in this month, excluding CapEx/renovation. Click a non-zero cell to see the underlying records.">Actual Expenses</th>
    <th class="right" style="cursor:help" title="Actual Revenue minus Actual Expenses for this month.">Actual Net</th>
    <th class="right" style="cursor:help" title="Actual Revenue minus Forecast Revenue for this month. Click a cell for the forecast/actual/variance breakdown.">Rev Variance</th>
    <th class="right" style="cursor:help" title="Rev Variance as a percentage of Forecast Revenue: (Actual − Forecast) ÷ Forecast × 100.">Var %</th>
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
    annualBar.appendChild(button('Distribute evenly', { variant: 'sm ghost', onClick: async () => {
      const yt = fc.yearTarget || {};
      const rev12 = Math.round((yt.revenue || 0) / 12);
      const monthKeys = Array.from({ length: 12 }, (_, m) => `${year}-${String(m + 1).padStart(2, '0')}`);
      // Itemized revenue entries (manual + the Airbnb auto-entry) and, for
      // properties, itemized expense entries both get silently wiped by the
      // flat overwrite below — check first and confirm, since this can
      // discard real recorded bookings/expenses with no way to undo it.
      const hasItemized = monthKeys.some(mk => {
        const m = fc.months?.[mk] || {};
        return (m.entries && m.entries.length > 0) || (type === 'property' && m.expenseEntries && m.expenseEntries.length > 0);
      });
      // For long-term rental properties, getForecastVsActual() falls back to
      // the lease schedule's rent (ltRentByMonth) for any month with no
      // explicit forecast.revenue set (fd.revenue == null). The flat
      // overwrite below always writes an explicit revenue (even 0), which
      // would silently and permanently disable that lease-based fallback for
      // months that currently rely on it — warn before doing that.
      let hasLeaseFallback = false;
      if (type === 'property') {
        const prop = byId('properties', entityId);
        if (prop?.type === 'long_term') {
          const ltMonths = new Set(
            generatePaymentSchedule(prop).filter(e => e.monthKey?.startsWith(String(year))).map(e => e.monthKey)
          );
          hasLeaseFallback = monthKeys.some(mk => (fc.months?.[mk] || {}).revenue == null && ltMonths.has(mk));
        }
      }
      if (hasItemized || hasLeaseFallback) {
        const parts = [];
        if (hasItemized) parts.push('Some months have itemized revenue and/or expense entries — distributing evenly will replace them all with flat 1/12 amounts.');
        if (hasLeaseFallback) parts.push('Some months currently have no explicit forecast and are using this lease\'s rent schedule as the forecast — distributing evenly will overwrite them with an explicit flat amount and permanently disable that automatic lease-based forecast for those months.');
        parts.push('This cannot be undone. Continue?');
        const ok = await confirmDialog(parts.join(' '), { danger: true, okLabel: 'Distribute Evenly' });
        if (!ok) return;
      }
      for (const mk of monthKeys) {
        const data = { revenue: rev12, entries: [] };
        if (type === 'property') {
          data.expenses = Math.round((yt.expenses || 0) / 12);
          data.expenseEntries = [];
        }
        saveForecastMonth(fc.id, mk, data);
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

      // Property forecast revenue: itemized Airbnb-sourced bookings (one entry
      // per reservation, editable/deletable, frozen once paid out) plus
      // itemized manual entries for anything Airbnb doesn't know about —
      // off-platform / direct bookings. Both share the same entries[]
      // mechanism as Service Forecast, so Analytics → Forecast picks them up
      // automatically. A flat quick-edit stays available for months with no
      // itemized entries yet.
      function makePropertyRevCell(current, mk, monthIdx) {
        const pending = getAirbnbForecastEntries(entityId, mk).filter(e => e.bookingStatus === 'pending' || e.bookingStatus === 'materialized');
        const entries = getForecastEntries(fc.id, mk);
        const cell = el('td', { class: 'right num', style: 'white-space:nowrap' });

        const amtSpan = el('span', {}, formatEUR(current));
        cell.appendChild(amtSpan);

        // Quick-edit icon — only meaningful while no itemized entries exist;
        // once entries exist they're the source of truth (mirrors Services).
        if (entries.length === 0) {
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
        }

        const manualCount = entries.filter(e => !e.auto).length;
        const subParts = [];
        if (pending.length > 0) subParts.push(`${pending.length} Airbnb reservation${pending.length === 1 ? '' : 's'}`);
        if (manualCount > 0) subParts.push(`${manualCount} manual entr${manualCount === 1 ? 'y' : 'ies'}`);
        if (subParts.length) {
          cell.appendChild(el('div', { class: 'muted', style: 'font-size:11px;font-weight:400' }, subParts.join(' · ')));
        }

        cell.style.cursor = 'pointer';
        cell.title = 'Click to manage forecasted bookings';
        cell.onclick = () => openPropertyEntriesEditor(mk, `${MONTHS[monthIdx]} ${year}`);
        return cell;
      }

      // A settled/tombstoned Airbnb entry (bookingStatus cancelled/removed) is
      // shown read-only with a Restore action, rather than editable fields —
      // there's nothing meaningful left to edit once a booking is known gone,
      // but the user can still bring it back into the active forecast.
      function isSettledAirbnbEntry(e) {
        return e.auto && (e.bookingStatus === 'cancelled' || e.bookingStatus === 'removed');
      }

      function openPropertyEntriesEditor(monthKey, monthLabel) {
        const body = el('div', {});
        const listWrap = el('div', {});
        body.appendChild(listWrap);

        // Unified, fully editable list: manual off-platform bookings and
        // Airbnb-sourced bookings side by side. An Airbnb-sourced line stays
        // editable while active (pending/materialized) — editing it flags it
        // `overridden` so a later CSV re-import never clobbers the change —
        // and becomes a read-only, restorable tombstone once cancelled/removed.
        const refresh = () => {
          listWrap.innerHTML = '';
          const entries = getForecastEntries(fc.id, monthKey)
            .slice()
            .sort((a, b) => (a.checkIn || '').localeCompare(b.checkIn || ''));

          if (entries.length === 0) {
            listWrap.appendChild(el('div', { class: 'empty', style: 'padding:24px' }, 'No forecasted bookings yet — click "Add Booking" below.'));
          } else {
            const t = el('table', { class: 'table' });
            t.innerHTML = '<thead><tr>'
              + '<th title="Editable description of a manual booking, or the Airbnb reservation\'s guest/notes once auto-generated.">Description</th>'
              + '<th class="right" style="width:130px;cursor:help" title="Forecasted amount for this entry — editable unless the entry is a settled (cancelled/removed) Airbnb booking.">Amount (€)</th>'
              + '<th style="cursor:help" title="Free-text notes for this entry.">Notes</th>'
              + '<th style="width:110px;cursor:help" title="Whether this entry is Airbnb-linked (with its current booking status) or manually added.">Source</th>'
              + '<th style="width:70px;cursor:help" title="Restore a settled Airbnb booking, or delete an entry."></th>'
              + '</tr></thead>';
            const tb2 = el('tbody');
            for (const e of entries) {
              const tr = el('tr');
              const settled = isSettledAirbnbEntry(e);

              let descCell, amtCell, noteCell;
              if (settled) {
                descCell = el('td', { style: 'text-decoration:line-through;color:var(--text-muted)' }, e.description || '');
                amtCell  = el('td', { class: 'right', style: 'text-decoration:line-through;color:var(--text-muted)' }, formatEUR(e.amount || 0));
                noteCell = el('td', { class: 'muted' }, e.notes || '');
              } else {
                const descI = input({ value: e.description || '', placeholder: 'e.g. Direct booking — Guest name' });
                const amtI  = input({ type: 'number', value: e.amount || 0, min: 0, step: 0.01, style: 'text-align:right' });
                const noteI = input({ value: e.notes || '', placeholder: 'e.g. Confirmed, bank transfer' });
                const commit = () => {
                  e.description = descI.value.trim();
                  e.amount = Number(amtI.value) || 0;
                  e.notes = noteI.value.trim();
                  if (e.auto) e.overridden = true;
                  upsertForecastEntry(fc.id, monthKey, e);
                  rebuildTotals();
                  if (onChange) onChange();
                  refresh();
                };
                descI.onchange = commit;
                amtI.onchange  = commit;
                noteI.onchange = commit;
                descCell = el('td', {}, descI);
                amtCell  = el('td', { class: 'right' }, amtI);
                noteCell = el('td', {}, noteI);
              }

              const sourceCell = el('td', {});
              if (e.auto) {
                sourceCell.appendChild(el('span', { class: 'badge', style: 'margin-right:4px' }, 'Airbnb'));
                sourceCell.appendChild(el('span', { class: 'muted', style: 'font-size:11px' }, BOOKING_STATUS_LABELS[e.bookingStatus] || ''));
              }

              const actionsCell = el('td', { class: 'right' });
              if (settled) {
                actionsCell.appendChild(button('Restore', { variant: 'sm ghost', onClick: () => {
                  upsertForecastEntry(fc.id, monthKey, { ...e, bookingStatus: 'pending', overridden: true });
                  refresh();
                  rebuildTotals();
                  if (onChange) onChange();
                }}));
              } else {
                actionsCell.appendChild(button('Del', { variant: 'sm ghost', onClick: () => {
                  if (e.auto) {
                    // Tombstone, don't splice — keeps a later re-import of the
                    // same booking from silently recreating this line.
                    upsertForecastEntry(fc.id, monthKey, { ...e, bookingStatus: 'removed', overridden: true });
                  } else {
                    removeForecastEntry(fc.id, monthKey, e.id);
                  }
                  refresh();
                  rebuildTotals();
                  if (onChange) onChange();
                }}));
              }

              tr.appendChild(descCell);
              tr.appendChild(amtCell);
              tr.appendChild(noteCell);
              tr.appendChild(sourceCell);
              tr.appendChild(actionsCell);
              tb2.appendChild(tr);
            }
            t.appendChild(tb2);
            const tw = el('div', { class: 'table-wrap' }); tw.appendChild(t);
            listWrap.appendChild(tw);
          }

          const total = sumForecastEntries(entries);
          listWrap.appendChild(el('div', { class: 'flex justify-between', style: 'padding:12px 16px;margin-top:12px;border-top:1px solid var(--border);font-weight:600' },
            el('span', {}, 'Total Forecasted'),
            el('span', { class: 'num' }, formatEUR(total))
          ));
        };

        refresh();

        const addBtn = button('+ Add Booking', { variant: 'primary', onClick: () => {
          // Migrate an existing flat forecast number into the first entry so
          // switching to itemized mode never silently drops it.
          const existing = getForecastEntries(fc.id, monthKey);
          if (existing.length === 0) {
            const flat = Number(fc.months?.[monthKey]?.revenue) || 0;
            if (flat > 0) upsertForecastEntry(fc.id, monthKey, { description: 'Existing forecast', amount: flat, notes: '' });
          }
          upsertForecastEntry(fc.id, monthKey, { description: '', amount: 0, notes: '' });
          refresh();
          rebuildTotals();
          if (onChange) onChange();
        }});
        const doneBtn = button('Done', { onClick: () => { closeModal(); renderRows(); } });

        openModal({ title: `Forecasted Bookings — ${monthLabel}`, body, footer: [addBtn, doneBtn], large: true });
      }

      const net = mData.forecastRev - mData.forecastExp;
      if (type === 'service') {
        tr.appendChild(makeEntriesCell(monthKey, mData.forecastRev, i));
      } else {
        tr.appendChild(makePropertyRevCell(mData.forecastRev, monthKey, i));
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
        t.innerHTML = '<thead><tr>'
          + '<th title="Name of the client or lead this forecasted entry represents.">Client / Lead</th>'
          + '<th class="right" style="width:130px;cursor:help" title="Forecasted amount for this entry.">Amount (€)</th>'
          + '<th style="cursor:help" title="Free-text notes, e.g. deal stage (Lead, In Discussion, Confirmed).">Notes / Status</th>'
          + '<th style="width:60px;cursor:help" title="Delete this entry.">'
          + '</th></tr></thead>';
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
        t.innerHTML = '<thead><tr>'
          + '<th title="What this forecasted expense is for.">Description</th>'
          + '<th class="right" style="width:130px;cursor:help" title="Forecasted expense amount for this entry.">Amount (€)</th>'
          + '<th style="cursor:help" title="Free-text category or notes for this expense entry.">Category / Notes</th>'
          + '<th style="width:60px;cursor:help" title="Delete this entry.">'
          + '</th></tr></thead>';
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
    tRow.appendChild(el('td', { style: 'font-size:11px;letter-spacing:.04em;cursor:help', title: 'Sum of the 12 months above for each column.' }, 'TOTAL'));
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
      // Each cell below is (this column's TOTAL row value) minus the Annual
      // Target set on the annual bar above — a per-column diff, not a
      // separate stored figure. See saveForecastYear()/fc.yearTarget.
      ytRow.appendChild(el('td', { style: 'cursor:help', title: 'Each figure below is this column\'s TOTAL (above) minus the Annual Target set for this year (see the Annual Target bar above the table).' }, 'vs Annual Target'));
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

// Human-readable label for a forecast entity, property name or service stream label.
function entityLabel(id, type) {
  return type === 'service' ? (STREAMS[id]?.label || id) : (byId('properties', id)?.name || id);
}

// ===== AGGREGATED GRID (multi-select summary, property and service) =====
// The totals table below stays a read-only aggregate across everything
// currently selected — but any one of the selected entities can still be
// opened for full editing (monthly forecast + itemized entries + annual
// target) via the picker below, without narrowing the outer filter down to
// a single selection first.
function buildAggregatedGrid(entityIds, year, type = 'property', onChange) {
  if (type === 'property') entityIds.forEach(backfillAirbnbForecastEntries);
  const card = el('div', { class: 'card' });
  const label = type === 'service' ? `${entityIds.length} services selected` : `${entityIds.length} properties selected`;
  card.appendChild(el('div', { class: 'card-header' },
    el('div', { class: 'card-title' }, `Aggregated Forecast — ${year}`),
    el('div', { class: 'muted', style: 'font-size:12px' }, label)
  ));

  const editBar = el('div', {
    style: 'display:flex;align-items:center;gap:8px;padding:10px 16px;background:var(--bg-elev-2);border-bottom:1px solid var(--border);flex-wrap:wrap'
  });
  editBar.appendChild(el('span', { style: 'font-size:12px;color:var(--text-muted)' }, 'Edit forecast for:'));
  // Defaults to an empty placeholder rather than silently pre-selecting
  // entityIds[0] — with several properties/services selected in the outer
  // filter, auto-picking "the first one" looked like an arbitrary, easy to
  // miss default; forcing an explicit choice avoids editing the wrong entity.
  const entityOpts = [
    { value: '', label: type === 'service' ? '— Select service —' : '— Select property —' },
    ...entityIds.map(id => ({ value: id, label: entityLabel(id, type) }))
  ];
  const entitySel = select(entityOpts, '');
  editBar.appendChild(entitySel);
  editBar.appendChild(button('Edit Monthly Forecast', { variant: 'sm primary', onClick: () => {
    const chosenId = entitySel.value;
    if (!chosenId) { toast(type === 'service' ? 'Select a service first' : 'Select a property first', 'warning'); return; }
    const modalBody = el('div', {});
    modalBody.appendChild(buildMonthlyGrid(chosenId, year, type, onChange));
    openModal({
      title: `${entityLabel(chosenId, type)} — ${year} Forecast`,
      body: modalBody,
      footer: [button('Done', { variant: 'primary', onClick: () => { closeModal(); if (onChange) onChange(); } })],
      large: true
    });
  }}));
  card.appendChild(editBar);

  // Precompute each entity's forecast doc once — reused below by both the
  // Forecast Revenue and Forecast Expenses drill-downs, for every month.
  const fcByEntity = new Map(entityIds.map(id => [id, getOrCreateForecast(type, id, year)]));
  const entityWord = type === 'service' ? 'Service' : 'Property';
  const FC_ENTRY_DRILL_COLS = [
    { key: 'entityName',  label: entityWord, tip: `${entityWord} this forecast entry belongs to.` },
    { key: 'description', label: 'Description', tip: 'What this forecasted booking/entry is for.' },
    { key: 'source',      label: 'Source', tip: 'Whether this entry came from an Airbnb-linked booking (with its current status) or was entered manually.' },
    { key: 'notes',       label: 'Notes', tip: 'Free-text notes entered for this forecast entry.' },
    { key: 'eur',         label: 'Amount', right: true, format: v => formatEUR(v), tip: 'Forecasted amount for this entry, in EUR. Excludes cancelled/removed bookings.' }
  ];
  const FC_EXP_DRILL_COLS = [
    { key: 'entityName',  label: entityWord, tip: `${entityWord} this forecasted expense entry belongs to.` },
    { key: 'description', label: 'Description', tip: 'What this forecasted expense entry is for.' },
    { key: 'notes',       label: 'Category / Notes', tip: 'Free-text category or notes entered for this expense entry.' },
    { key: 'eur',         label: 'Amount', right: true, format: v => formatEUR(v), tip: 'Forecasted expense amount for this entry, in EUR.' }
  ];
  // All revenue entries (Airbnb-sourced + manual) across the selected
  // entities for one month — this is what actually sums to forecastRev, so
  // it's the same breakdown regardless of property vs service.
  const getRevEntriesForMonth = monthKey => entityIds.flatMap(id => {
    const efc = fcByEntity.get(id);
    return getForecastEntries(efc.id, monthKey)
      .filter(e => e.bookingStatus !== 'cancelled' && e.bookingStatus !== 'removed')
      .map(e => ({
        entityName: entityLabel(id, type),
        description: e.description || (e.auto ? 'Airbnb reservation' : '—'),
        source: e.auto ? `Airbnb${BOOKING_STATUS_LABELS[e.bookingStatus] ? ' · ' + BOOKING_STATUS_LABELS[e.bookingStatus] : ''}` : 'Manual',
        notes: e.notes || '', eur: Number(e.amount) || 0, date: e.checkIn || ''
      }));
  }).sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  const getExpEntriesForMonth = monthKey => entityIds.flatMap(id => {
    const efc = fcByEntity.get(id);
    return (efc.months?.[monthKey]?.expenseEntries || []).map(e => ({
      entityName: entityLabel(id, type), description: e.description || '—',
      notes: e.notes || '', eur: Number(e.amount) || 0
    }));
  });

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
    <th title="Calendar month within the selected forecast year.">Month</th>
    <th class="right" style="cursor:help" title="Sum, across every selected ${type === 'service' ? 'service' : 'property'}, of this month's forecasted amounts — excludes cancelled/removed entries. Click a cell to see the itemized breakdown.">Forecast Revenue</th>
    <th class="right" style="cursor:help" title="Sum, across every selected ${type === 'service' ? 'service' : 'property'}, of this month's itemized forecast expense entries. Click a cell to see the itemized breakdown.">Forecast Expenses</th>
    <th class="right" style="cursor:help" title="Forecast Revenue minus Forecast Expenses for this month, summed across every selected entity.">Forecast Net</th>
    <th class="right" style="cursor:help" title="Sum, across every selected entity, of actual paid revenue recorded in this month. Click a non-zero cell to see the underlying records.">Actual Revenue</th>
    <th class="right" style="cursor:help" title="Sum, across every selected entity, of actual expenses recorded in this month (excludes CapEx). Click a non-zero cell to see the underlying records.">Actual Expenses</th>
    <th class="right" style="cursor:help" title="Actual Revenue minus Actual Expenses for this month, summed across every selected entity.">Actual Net</th>
    <th class="right" style="cursor:help" title="Actual Revenue minus Forecast Revenue for this month, summed across every selected entity. Click a cell for the forecast/actual/variance breakdown.">Rev Variance</th>
    <th class="right" style="cursor:help" title="Rev Variance as a percentage of Forecast Revenue: (Actual − Forecast) ÷ Forecast × 100.">Var %</th>
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

    // Forecast Revenue — clickable drill-down for both property and service
    const fRevCell = el('td', { class: 'right num' });
    const revEntries = getRevEntriesForMonth(months[i].key);
    fRevCell.appendChild(el('div', {}, formatEUR(m.forecastRev)));
    if (revEntries.length > 0) {
      fRevCell.appendChild(el('div', { class: 'muted', style: 'font-size:11px;font-weight:400' },
        `${revEntries.length} entr${revEntries.length === 1 ? 'y' : 'ies'}`));
      fRevCell.style.cursor = 'pointer';
      fRevCell.title = 'Click to see forecast breakdown';
      fRevCell.onclick = () => drillDownModal(
        `Forecast Revenue — ${MONTHS[i]}`, revEntries, FC_ENTRY_DRILL_COLS);
    } else {
      fRevCell.textContent = formatEUR(m.forecastRev);
    }
    tr.appendChild(fRevCell);

    // Forecast Expenses — clickable drill-down (same idea, itemized expenseEntries)
    const fExpCell = el('td', { class: 'right num' });
    const expEntries = getExpEntriesForMonth(months[i].key);
    fExpCell.appendChild(el('div', {}, formatEUR(m.forecastExp)));
    if (expEntries.length > 0) {
      fExpCell.appendChild(el('div', { class: 'muted', style: 'font-size:11px;font-weight:400' },
        `${expEntries.length} entr${expEntries.length === 1 ? 'y' : 'ies'}`));
      fExpCell.style.cursor = 'pointer';
      fExpCell.title = 'Click to see forecast expense breakdown';
      fExpCell.onclick = () => drillDownModal(
        `Forecast Expenses — ${MONTHS[i]}`, expEntries, FC_EXP_DRILL_COLS);
    } else {
      fExpCell.textContent = formatEUR(m.forecastExp);
    }
    tr.appendChild(fExpCell);
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
  tRow.appendChild(el('td', { style: 'font-size:11px;letter-spacing:.04em;cursor:help', title: 'Sum of the 12 months above for each column, across every selected entity.' }, 'TOTAL'));
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
    // Sum, across the selected entities, of each entity's own Annual Target
    // (see saveForecastYear()/fc.yearTarget); each cell is TOTAL (above)
    // minus that summed target.
    ytRow.appendChild(el('td', { style: 'cursor:help', title: 'Each figure below is this column\'s TOTAL (above) minus the sum of every selected entity\'s own Annual Target.' }, 'vs Annual Target'));
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
    <th title="Property name. Click a row for the monthly breakdown.">Property</th><th title="Short-term (Airbnb-style nightly rental) or long-term (leased) rental.">Stream</th>
    <th class="right" style="cursor:help" title="Forecasted revenue total for the selected year.">For. Rev</th><th class="right" style="cursor:help" title="Actual paid revenue total for the selected year.">Act. Rev</th>
    <th class="right" style="cursor:help" title="Actual Revenue minus Forecast Revenue for the year.">Rev Var</th><th class="right" style="cursor:help" title="Rev Variance as a percentage of Forecast Revenue.">Var %</th>
    <th class="right" style="cursor:help" title="Forecasted expenses total for the selected year.">For. Exp</th><th class="right" style="cursor:help" title="Actual expenses total for the selected year (excludes CapEx).">Act. Exp</th>
    <th class="right" style="cursor:help" title="Forecast Revenue minus Forecast Expenses for the year.">For. Net</th><th class="right" style="cursor:help" title="Actual Revenue minus Actual Expenses for the year.">Act. Net</th>
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
        { key: 'month',  label: 'Month', tip: 'Calendar month within the selected year.' },
        { key: 'fcRev',  label: 'For. Rev',  right: true, tip: 'Forecasted revenue for this property/month.' },
        { key: 'actRev', label: 'Act. Rev',  right: true, tip: 'Actual paid revenue for this property/month.' },
        { key: 'revVar', label: 'Variance',  right: true, tip: 'Actual Revenue minus Forecast Revenue for this property/month.' },
        { key: 'varPct', label: 'Var %',     right: true, tip: 'Variance as a percentage of Forecast Revenue.' },
        { key: 'fcExp',  label: 'For. Exp',  right: true, tip: 'Forecasted expenses for this property/month.' },
        { key: 'actExp', label: 'Act. Exp',  right: true, tip: 'Actual expenses for this property/month (excludes CapEx).' },
        { key: 'actNet', label: 'Act. Net',  right: true, tip: 'Actual Revenue minus Actual Expenses for this property/month.' },
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
  tRow.appendChild(el('td', { style: 'font-size:11px;letter-spacing:.04em;cursor:help', title: 'Sum of every row above, for each column.' }, 'TOTAL'));
  tRow.appendChild(el('td', { style: 'font-size:11px;letter-spacing:.04em' }, ''));
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
    <th title="Short-term (Airbnb-style nightly rental) or long-term (leased) rental. Click a row for the underlying properties.">Stream</th><th class="right" style="cursor:help" title="Number of selected properties in this stream.">Properties</th>
    <th class="right" style="cursor:help" title="Forecasted revenue total for the selected year, summed across this stream's properties.">For. Rev</th><th class="right" style="cursor:help" title="Actual paid revenue total for the selected year, summed across this stream's properties.">Act. Rev</th>
    <th class="right" style="cursor:help" title="Actual Revenue minus Forecast Revenue for the year.">Rev Var</th><th class="right" style="cursor:help" title="Rev Variance as a percentage of Forecast Revenue.">Var %</th>
    <th class="right" style="cursor:help" title="Forecasted expenses total for the selected year, summed across this stream's properties.">For. Exp</th><th class="right" style="cursor:help" title="Actual expenses total for the selected year (excludes CapEx), summed across this stream's properties.">Act. Exp</th>
    <th class="right" style="cursor:help" title="Forecast Revenue minus Forecast Expenses for the year.">For. Net</th><th class="right" style="cursor:help" title="Actual Revenue minus Actual Expenses for the year.">Act. Net</th>
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
        { key: 'name',   label: 'Property', tip: 'Property name.' },
        { key: 'fcRev',  label: 'For. Rev',  right: true, tip: 'Forecasted revenue total for the selected year.' },
        { key: 'actRev', label: 'Act. Rev',  right: true, tip: 'Actual paid revenue total for the selected year.' },
        { key: 'revVar', label: 'Variance',  right: true, tip: 'Actual Revenue minus Forecast Revenue for the year.' },
        { key: 'varPct', label: 'Var %',     right: true, tip: 'Variance as a percentage of Forecast Revenue.' },
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

// `explain` is an optional mkExplainButton payload (see analytics-helpers.js)
// rendered as a small "ⓘ" next to the label — used for figures in this row
// that are computed (sums/differences/percentages) rather than a raw
// passthrough of a single stored value.
function summaryRow(label, value, variant, explain) {
  const labelSpan = el('span', { class: 'muted', style: 'font-size:12px;display:inline-flex;align-items:center;gap:4px' }, label);
  if (explain) labelSpan.appendChild(mkExplainButton(explain));
  return el('div', { class: 'flex justify-between items-center', style: 'padding:4px 0' },
    labelSpan,
    el('span', { class: 'num ' + (variant || ''), style: 'font-weight:600' }, value)
  );
}
