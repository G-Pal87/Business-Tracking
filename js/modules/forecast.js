// Forecast & Simulation module
import { state } from '../core/state.js';
import { el, select, input } from '../core/ui.js';
import * as charts from '../core/charts.js';
import { formatEUR, toEUR, byId, propertyExpensesEUR, renovationCapexEUR } from '../core/data.js';

export default {
  id: 'forecast',
  label: 'Forecast',
  icon: 'F',
  render(container) {
    const props = state.db.properties || [];
    let selectedId = props[0]?.id || null;
    container.appendChild(build(selectedId, onChange));
    recalc(selectedId);
    function onChange(id) { selectedId = id; recalc(id); }
  },
  refresh() { const c = document.getElementById('content'); c.innerHTML = ''; this.render(c); },
  destroy() { charts.destroyAll(); }
};

function build(selectedId, onChange) {
  const wrap = el('div', { class: 'view active' });
  const props = state.db.properties || [];

  if (props.length === 0) {
    wrap.appendChild(el('div', { class: 'empty' }, 'Add a property first to forecast'));
    return wrap;
  }

  const propSel = select(props.map(p => ({ value: p.id, label: p.name })), selectedId || props[0].id);
  propSel.onchange = () => onChange(propSel.value);

  wrap.appendChild(el('div', { class: 'card mb-16' },
    el('div', { class: 'card-header' },
      el('div', {}, el('div', { class: 'card-title' }, 'Property'), el('div', { class: 'card-subtitle' }, 'Select a property to simulate')),
      propSel
    )
  ));

  // Controls
  const controls = el('div', { class: 'card mb-16' });
  controls.innerHTML = `
    <div class="card-header"><div class="card-title">What-if Simulation</div></div>
    <div class="grid grid-3">
      <div class="range-wrap">
        <div class="range-head"><span>Occupancy %</span><span class="range-value" id="val-occ">65%</span></div>
        <input type="range" id="slider-occ" min="0" max="100" value="65">
      </div>
      <div class="range-wrap">
        <div class="range-head"><span>Rate multiplier</span><span class="range-value" id="val-rate">100%</span></div>
        <input type="range" id="slider-rate" min="50" max="200" value="100">
      </div>
      <div class="range-wrap">
        <div class="range-head"><span>Expense multiplier</span><span class="range-value" id="val-exp">100%</span></div>
        <input type="range" id="slider-exp" min="50" max="200" value="100">
      </div>
    </div>
  `;
  wrap.appendChild(controls);

  // KPIs
  wrap.appendChild(el('div', { class: 'grid grid-4 mb-16', id: 'fc-kpis' }));

  // Chart
  wrap.appendChild(el('div', { class: 'card' },
    el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'Projected P&L - next 24 months')),
    el('div', { class: 'chart-wrap tall' }, el('canvas', { id: 'fc-chart' }))
  ));

  // Wire sliders
  setTimeout(() => {
    ['occ', 'rate', 'exp'].forEach(key => {
      const s = document.getElementById('slider-' + key);
      if (!s) return;
      s.oninput = () => {
        document.getElementById('val-' + key).textContent = s.value + '%';
        recalc(propSel.value);
      };
    });
  }, 50);

  return wrap;
}

function recalc(propertyId) {
  if (!propertyId) return;
  const p = byId('properties', propertyId);
  if (!p) return;

  const occ = Number(document.getElementById('slider-occ')?.value || 65) / 100;
  const rateMul = Number(document.getElementById('slider-rate')?.value || 100) / 100;
  const expMul = Number(document.getElementById('slider-exp')?.value || 100) / 100;

  // Revenue model
  let annualRevNative;
  if (p.type === 'short_term') {
    annualRevNative = 365 * occ * (p.nightlyRate || 0) * rateMul;
  } else {
    annualRevNative = 12 * (p.monthlyRent || 0) * rateMul;
  }
  const annualRevEUR = toEUR(annualRevNative, p.currency);

  // Expense model: last 12 months non-renovation expenses for this property
  const now = new Date();
  const yearAgo = new Date(now); yearAgo.setFullYear(yearAgo.getFullYear() - 1);
  const rows = (state.db.expenses || []).filter(e => e.propertyId === propertyId && e.category !== 'renovation' && e.date >= yearAgo.toISOString().slice(0, 10));
  let baselineExpEUR = rows.reduce((s, r) => s + toEUR(r.amount, r.currency), 0);
  if (baselineExpEUR === 0) {
    // Fall back to mortgage estimate
    const mortgageEUR = toEUR((p.mortgageMonthly || 0) * 12, p.currency);
    baselineExpEUR = mortgageEUR;
  }
  const annualExpEUR = baselineExpEUR * expMul;

  const netEUR = annualRevEUR - annualExpEUR;
  const purchaseEUR = toEUR(p.purchasePrice, p.currency);
  const renoEUR = renovationCapexEUR({ propertyId });
  const totalInvested = purchaseEUR + renoEUR;
  const roi = totalInvested ? (netEUR / totalInvested) * 100 : 0;
  const breakEvenYears = netEUR > 0 ? (totalInvested / netEUR) : Infinity;

  // KPIs
  const kpis = document.getElementById('fc-kpis');
  kpis.innerHTML = '';
  kpis.append(
    kpi('Projected Revenue', formatEUR(annualRevEUR), 'annual'),
    kpi('Projected Expenses', formatEUR(annualExpEUR), 'annual operating'),
    kpi('Projected Net', formatEUR(netEUR), `ROI ${roi.toFixed(2)}%`, netEUR >= 0 ? 'success' : 'danger'),
    kpi('Break-even', breakEvenYears === Infinity ? 'never' : `${breakEvenYears.toFixed(1)} yrs`, `Invested ${formatEUR(totalInvested)}`, 'warning')
  );

  // 24-month chart - cumulative net
  const labels = [], revData = [], expData = [], netCum = [];
  let cum = -totalInvested;
  for (let i = 0; i < 24; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    labels.push(d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' }));
    const r = annualRevEUR / 12;
    const e = annualExpEUR / 12;
    revData.push(Math.round(r));
    expData.push(Math.round(e));
    cum += (r - e);
    netCum.push(Math.round(cum));
  }
  charts.line('fc-chart', {
    labels,
    datasets: [
      { label: 'Monthly Revenue', data: revData, borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,0.1)' },
      { label: 'Monthly Expenses', data: expData, borderColor: '#ef4444', backgroundColor: 'rgba(239,68,68,0.1)' },
      { label: 'Cumulative Net (post-invest)', data: netCum, borderColor: '#6366f1', backgroundColor: 'rgba(99,102,241,0.1)', fill: false }
    ]
  });
}

function kpi(label, value, sub, variant) {
  return el('div', { class: 'kpi' + (variant ? ' ' + variant : '') },
    el('div', { class: 'kpi-label' }, label),
    el('div', { class: 'kpi-value' }, value),
    el('div', { class: 'kpi-trend' }, sub || ''),
    el('div', { class: 'kpi-accent-bar' })
  );
}
