// Cyprus Provisional Corporation Tax Calculator
import { state, markDirty } from '../core/state.js';
import { el, input, select, button, formRow, toast } from '../core/ui.js';
import { formatEUR, toEUR, listActivePayments, listActive, availableYears, isCapEx } from '../core/data.js';
import { mkKpiCard } from './analytics-helpers.js';

const DEFAULTS = {
  year: String(new Date().getFullYear()),
  corpTaxRate: 12.5,
  bufferEnabled: true,
  bufferPct: 10,
  actualRevenue: 0,
  forecastRevenue: 0,
  actualExpenses: 0,
  forecastExpenses: 0,
  nonDeductibleExpenses: 0,
  taxAllowances: 0,
  estimatedFinalTax: 0,
  julPayment: 0,
  decRevRevenue: 0,
  decRevExpenses: 0,
  decRevNonDeductible: 0,
  decRevAllowances: 0,
};

function cfg() {
  if (!state.db.settings) state.db.settings = {};
  if (!state.db.settings.cyprusTax) state.db.settings.cyprusTax = { ...DEFAULTS };
  return state.db.settings.cyprusTax;
}

function persist(patch) {
  Object.assign(cfg(), patch);
  markDirty();
}

const safeN = v => (isFinite(Number(v)) ? Math.max(0, Number(v)) : 0);
const fmtE  = v => formatEUR(Math.max(0, v));

function calcAll(s) {
  const rate       = safeN(s.corpTaxRate);
  const bufPct     = safeN(s.bufferPct);
  const bufEnabled = !!s.bufferEnabled;

  const totalRevenue    = safeN(s.actualRevenue) + safeN(s.forecastRevenue);
  const totalDeductible = safeN(s.actualExpenses) + safeN(s.forecastExpenses);
  const estProfit       = Math.max(0, totalRevenue - totalDeductible + safeN(s.nonDeductibleExpenses) - safeN(s.taxAllowances));
  const bufferedProfit  = bufEnabled ? estProfit * (1 + bufPct / 100) : estProfit;
  const taxableProfit   = Math.max(0, bufferedProfit);
  const corpTax         = taxableProfit * (rate / 100);
  const julyPayment     = corpTax / 2;
  const decPayment      = corpTax / 2;

  // 75% safety check
  const finalTax      = safeN(s.estimatedFinalTax);
  const minRequired75 = finalTax * 0.75;
  const shortfall     = Math.max(0, minRequired75 - corpTax);

  // December revision
  const revProfit        = Math.max(0,
    safeN(s.decRevRevenue) - safeN(s.decRevExpenses)
    + safeN(s.decRevNonDeductible) - safeN(s.decRevAllowances)
  );
  const revisedAnnualTax = revProfit * (rate / 100);
  const alreadyPaid      = safeN(s.julPayment);
  const addDecRaw        = revisedAnnualTax - alreadyPaid;
  const reqDecPayment    = Math.max(0, addDecRaw);
  const overpayment      = addDecRaw < 0 ? Math.abs(addDecRaw) : 0;

  return {
    rate, bufPct, bufEnabled,
    totalRevenue, totalDeductible, estProfit, bufferedProfit, taxableProfit, corpTax,
    julyPayment, decPayment,
    finalTax, minRequired75, shortfall, safe: minRequired75 - corpTax <= 0,
    revProfit, revisedAnnualTax, alreadyPaid, reqDecPayment, overpayment,
  };
}

export default {
  id: 'cyprus-tax',
  label: 'Cyprus Corp Tax',
  icon: '§',
  render(container) { container.appendChild(build()); },
  refresh() {
    const c = document.getElementById('content');
    if (!c) return;
    c.innerHTML = '';
    c.appendChild(build());
  },
  destroy() {}
};

function build() {
  const wrap = el('div', { style: 'padding:16px;max-width:1100px' });

  wrap.appendChild(el('div', { style: 'margin-bottom:20px' },
    el('div', { style: 'font-size:18px;font-weight:700;color:var(--text)' }, 'Cyprus Provisional Tax Calculator'),
    el('div', { style: 'font-size:12px;color:var(--text-muted);margin-top:4px' },
      'Estimate corporate income tax instalments and avoid the 10% additional charge for underestimation.')
  ));

  // Results section (3) — rebuilt on any settings/estimate change
  const resultsEl = el('div');

  // Safety check display area — only the KPI/status area is refreshed, not the input
  const safetyDisplayEl = el('div');
  const renderSafetyDisplay = () => {
    safetyDisplayEl.innerHTML = '';
    const c = calcAll(cfg());
    if (c.finalTax === 0) {
      safetyDisplayEl.appendChild(el('div', { style: 'color:var(--text-muted);font-size:13px;font-style:italic' },
        'Enter an estimated final tax liability above to see the safety check.'));
      return;
    }
    safetyDisplayEl.appendChild(el('div', { class: 'grid grid-3', style: 'margin-bottom:12px' },
      mkKpiCard({ label: 'Planned Provisional Tax',  value: fmtE(c.corpTax) }),
      mkKpiCard({ label: 'Minimum Required (75%)',   value: fmtE(c.minRequired75), subtitle: `75% of ${fmtE(c.finalTax)}` }),
      mkKpiCard({ label: 'Shortfall',                value: fmtE(c.shortfall), variant: c.shortfall > 0 ? 'danger' : 'success' })
    ));
    const safe = c.safe;
    safetyDisplayEl.appendChild(el('div', {
      style: `padding:12px 14px;border-radius:var(--radius-sm);border-left:4px solid var(--${safe ? 'success' : 'danger'});background:rgba(${safe ? '16,185,129' : '239,68,68'},0.07)`
    },
      el('span', { class: `badge ${safe ? 'success' : 'danger'}` },
        safe ? '✓ No additional charge risk' : '⚠ Risk of 10% additional charge'),
      el('div', { style: 'font-size:12px;color:var(--text-muted);margin-top:6px' },
        safe
          ? 'Your planned provisional tax covers at least 75% of the estimated final tax liability.'
          : `Increase provisional tax by ${fmtE(c.shortfall)} to reach the 75% threshold.`
      )
    ));
  };

  // December revision display area
  const decDisplayEl = el('div', { style: 'margin-top:16px' });
  const renderDecDisplay = () => {
    decDisplayEl.innerHTML = '';
    const c = calcAll(cfg());
    const s = cfg();
    const year = s.year || String(new Date().getFullYear());
    if (c.revProfit === 0 && safeN(s.decRevRevenue) === 0) {
      decDisplayEl.appendChild(el('div', { style: 'color:var(--text-muted);font-size:13px;font-style:italic' },
        'Enter revised year-end estimates above to see the required December payment.'));
      return;
    }
    decDisplayEl.appendChild(el('div', { class: 'grid grid-3 mb-16' },
      mkKpiCard({ label: 'Revised Taxable Profit',              value: fmtE(c.revProfit) }),
      mkKpiCard({ label: `Revised Corp Tax (${c.rate}%)`,       value: fmtE(c.revisedAnnualTax) }),
      mkKpiCard({ label: 'Already Paid in July',                value: fmtE(c.alreadyPaid) })
    ));
    decDisplayEl.appendChild(el('div', { class: 'grid grid-2' },
      mkKpiCard({
        label:    `Required 2nd Instalment — 31 Dec ${year}`,
        value:    fmtE(c.reqDecPayment),
        variant:  c.reqDecPayment > 0 ? 'warning' : 'success',
        subtitle: c.reqDecPayment > 0 ? 'Pay by 31 December' : 'No additional payment required'
      }),
      c.overpayment > 0
        ? mkKpiCard({ label: 'July Overpayment', value: fmtE(c.overpayment), variant: 'success', subtitle: 'Offset against final balance or claim as refund' })
        : mkKpiCard({ label: 'Overpayment', value: fmtE(0), subtitle: 'None' })
    ));
  };

  const recalc = () => {
    resultsEl.innerHTML = '';
    resultsEl.appendChild(buildResultsCard(calcAll(cfg()), cfg()));
    renderSafetyDisplay();
    renderDecDisplay();
  };

  // ── Section 1: Tax settings ─────────────────────────────────────────────
  wrap.appendChild(buildSettingsCard(recalc));

  // ── Section 2: Annual estimate ──────────────────────────────────────────
  wrap.appendChild(buildEstimateCard(recalc));

  // ── Section 3: Provisional tax result ──────────────────────────────────
  wrap.appendChild(resultsEl);

  // ── Section 4: 75% safety check ────────────────────────────────────────
  wrap.appendChild(buildSafetyCard(safetyDisplayEl, renderSafetyDisplay, recalc));

  // ── Section 5: December revision ───────────────────────────────────────
  wrap.appendChild(buildDecRevisionCard(decDisplayEl, renderDecDisplay, recalc));

  recalc();
  return wrap;
}

// ── Section 1 ────────────────────────────────────────────────────────────────
function buildSettingsCard(onChange) {
  const s    = cfg();
  const card = el('div', { class: 'card mb-16' });
  card.appendChild(el('div', { class: 'card-header' },
    el('div', {},
      el('div', { class: 'card-title' }, 'Tax Settings'),
      el('div', { class: 'card-subtitle' }, 'Corporate tax rate and safety buffer')
    )
  ));
  const body = el('div', { style: 'padding:0 16px 16px' });

  const curYear = String(new Date().getFullYear());
  const years   = [...new Set([curYear, ...availableYears()])].sort().reverse();
  const yearSel = select(years.map(y => ({ value: y, label: y })), s.year || curYear);
  yearSel.onchange = () => { persist({ year: yearSel.value }); onChange(); };

  const rateI = input({ type: 'number', value: s.corpTaxRate ?? 12.5, min: 0, max: 100, step: 0.1, style: 'width:110px' });
  rateI.oninput = () => { persist({ corpTaxRate: safeN(rateI.value) }); onChange(); };

  const bufChk = el('input', { type: 'checkbox' });
  bufChk.checked = !!s.bufferEnabled;
  const bufPctI = input({ type: 'number', value: s.bufferPct ?? 10, min: 0, max: 100, step: 0.1, style: 'width:80px' });
  bufPctI.oninput = () => { persist({ bufferPct: safeN(bufPctI.value) }); onChange(); };
  bufChk.onchange = () => { persist({ bufferEnabled: bufChk.checked }); onChange(); };

  body.appendChild(el('div', { style: 'display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px' },
    formRow('Tax Year', yearSel),
    formRow('Corporate Tax Rate',
      el('div', { style: 'display:flex;align-items:center;gap:6px' },
        rateI, el('span', { style: 'color:var(--text-muted);font-size:13px' }, '%')),
      'Cyprus default: 12.5%'),
    formRow('Safety Buffer',
      el('div', { style: 'display:flex;align-items:center;gap:10px' },
        el('label', { style: 'display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px;white-space:nowrap' }, bufChk, 'Enable'),
        bufPctI,
        el('span', { style: 'color:var(--text-muted);font-size:13px' }, '%')),
      'Inflates estimate to reduce underpayment risk')
  ));

  card.appendChild(body);
  return card;
}

// ── Section 2 ────────────────────────────────────────────────────────────────
function buildEstimateCard(onChange) {
  const s    = cfg();
  const card = el('div', { class: 'card mb-16' });

  const prefillBtn = button('↓ Prefill from actuals', { variant: 'sm ghost', onClick: () => prefillFromActuals(onChange) });
  card.appendChild(el('div', { class: 'card-header' },
    el('div', {},
      el('div', { class: 'card-title' }, 'Annual Estimate'),
      el('div', { class: 'card-subtitle' }, 'Expected full-year revenue and expenses')
    ),
    prefillBtn
  ));
  const body = el('div', { style: 'padding:0 16px 16px' });

  const fi = (key, val, label, hint) => {
    const i = input({ type: 'number', value: val || '', min: 0, step: 0.01, style: 'width:100%', placeholder: '0.00' });
    i.oninput = () => { persist({ [key]: safeN(i.value) }); onChange(); };
    return formRow(label, i, hint);
  };

  body.appendChild(el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:20px' },
    el('div', {},
      el('div', { style: 'font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px;padding-bottom:6px;border-bottom:1px solid var(--border)' }, 'Revenue (€)'),
      fi('actualRevenue',   s.actualRevenue,   'Actual revenue to date'),
      fi('forecastRevenue', s.forecastRevenue, 'Forecast revenue, rest of year')
    ),
    el('div', {},
      el('div', { style: 'font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px;padding-bottom:6px;border-bottom:1px solid var(--border)' }, 'Expenses (€)'),
      fi('actualExpenses',   s.actualExpenses,   'Actual deductible expenses to date'),
      fi('forecastExpenses', s.forecastExpenses, 'Forecast deductible expenses, rest of year')
    )
  ));
  body.appendChild(el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-top:12px' },
    fi('nonDeductibleExpenses', s.nonDeductibleExpenses, 'Non-deductible expenses (€)', 'Entertainment, fines, etc. — added back to taxable profit'),
    fi('taxAllowances',         s.taxAllowances,         'Tax allowances / deductions (€)', 'Depreciation, R&D credits, etc. — reduces taxable profit')
  ));

  card.appendChild(body);
  return card;
}

function prefillFromActuals(onChange) {
  const s      = cfg();
  const year   = s.year || String(new Date().getFullYear());
  const cutoff = new Date().toISOString().slice(0, 10);
  const s1     = `${year}-01-01`;

  const pays = listActivePayments().filter(p => p.status === 'paid' && p.date >= s1 && p.date <= cutoff);
  const invs = listActive('invoices').filter(i => i.status === 'paid' && (i.issueDate || '') >= s1 && (i.issueDate || '') <= cutoff);
  const exps = listActive('expenses').filter(e => !isCapEx(e) && e.date >= s1 && e.date <= cutoff);

  const rev = [...pays.map(p => toEUR(p.amount, p.currency, year)), ...invs.map(i => toEUR(i.total, i.currency, year))].reduce((a, b) => a + b, 0);
  const exp = exps.reduce((a, e) => a + toEUR(e.amount, e.currency, year), 0);

  persist({ actualRevenue: Math.round(rev * 100) / 100, actualExpenses: Math.round(exp * 100) / 100 });

  // Full rebuild to refresh the input values
  const c = document.getElementById('content');
  if (c) { c.innerHTML = ''; c.appendChild(build()); }
  toast(`Prefilled from ${year} actuals up to ${cutoff}`, 'success');
}

// ── Section 3 ────────────────────────────────────────────────────────────────
function buildResultsCard(c, s) {
  const year     = s.year || String(new Date().getFullYear());
  const nextYear = String(Number(year) + 1);
  const card     = el('div', { class: 'card mb-16' });

  card.appendChild(el('div', { class: 'card-header' },
    el('div', {},
      el('div', { class: 'card-title' }, 'Provisional Tax Result'),
      el('div', { class: 'card-subtitle' }, `Estimated corporation tax liability for ${year}`)
    )
  ));
  const body = el('div', { style: 'padding:0 16px 16px' });

  body.appendChild(el('div', { class: 'grid grid-3 mb-16' },
    mkKpiCard({ label: 'Est. Annual Revenue',       value: fmtE(c.totalRevenue) }),
    mkKpiCard({ label: 'Est. Deductible Expenses',  value: fmtE(c.totalDeductible) }),
    mkKpiCard({ label: 'Est. Taxable Profit',        value: fmtE(c.estProfit) })
  ));

  const taxRow = [];
  if (c.bufEnabled) {
    taxRow.push(mkKpiCard({
      label:    `Buffered Taxable Profit (+${c.bufPct}%)`,
      value:    fmtE(c.taxableProfit),
      subtitle: `${c.bufPct}% safety margin applied`
    }));
  }
  taxRow.push(mkKpiCard({
    label:   `Est. Corporation Tax (${c.rate}%)`,
    value:   fmtE(c.corpTax),
    variant: c.corpTax > 0 ? 'warning' : ''
  }));
  body.appendChild(el('div', { style: `display:grid;grid-template-columns:repeat(${taxRow.length},1fr);gap:16px;margin-bottom:16px` },
    ...taxRow
  ));

  body.appendChild(el('div', { style: 'font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px' }, 'Payment Schedule'));
  body.appendChild(el('div', { class: 'grid grid-3' },
    mkKpiCard({ label: `1st Instalment — 31 Jul ${year}`,    value: fmtE(c.julyPayment),  subtitle: '50% of estimated corporation tax' }),
    mkKpiCard({ label: `2nd Instalment — 31 Dec ${year}`,    value: fmtE(c.decPayment),   subtitle: '50% of estimated corporation tax' }),
    mkKpiCard({ label: `Final Balance — 1 Aug ${nextYear}`,  value: '—',                  subtitle: 'Based on actual audited profit' })
  ));

  card.appendChild(body);
  return card;
}

// ── Section 4 ────────────────────────────────────────────────────────────────
function buildSafetyCard(displayEl, renderDisplay, onChange) {
  const s    = cfg();
  const card = el('div', { class: 'card mb-16' });
  card.appendChild(el('div', { class: 'card-header' },
    el('div', {},
      el('div', { class: 'card-title' }, '75% Safety Check'),
      el('div', { class: 'card-subtitle' }, 'Provisional tax must cover ≥ 75% of actual final tax to avoid the 10% penalty')
    )
  ));
  const body = el('div', { style: 'padding:0 16px 16px' });

  const finalTaxI = input({ type: 'number', value: s.estimatedFinalTax || '', min: 0, step: 0.01, style: 'width:220px', placeholder: '0.00' });
  finalTaxI.oninput = () => { persist({ estimatedFinalTax: safeN(finalTaxI.value) }); renderDisplay(); onChange(); };

  body.appendChild(formRow(
    'Estimated final actual tax liability (€)',
    finalTaxI,
    'Your best estimate of the audited year-end tax. Leave 0 if unknown.'
  ));
  body.appendChild(displayEl);
  card.appendChild(body);
  return card;
}

// ── Section 5 ────────────────────────────────────────────────────────────────
function buildDecRevisionCard(displayEl, renderDisplay, onChange) {
  const s    = cfg();
  const year = s.year || String(new Date().getFullYear());
  const card = el('div', { class: 'card mb-16' });

  card.appendChild(el('div', { class: 'card-header' },
    el('div', {},
      el('div', { class: 'card-title' }, 'December Revision Check'),
      el('div', { class: 'card-subtitle' }, `Revise estimates before 31 December ${year} to determine the correct 2nd instalment`)
    )
  ));
  const body = el('div', { style: 'padding:0 16px 16px' });

  body.appendChild(el('p', { style: 'font-size:12px;color:var(--text-muted);margin:0 0 14px' },
    'Use revised full-year figures to check whether the second instalment needs increasing.'
  ));

  const fi = (key, val, label) => {
    const i = input({ type: 'number', value: val || '', min: 0, step: 0.01, style: 'width:100%', placeholder: '0.00' });
    i.oninput = () => { persist({ [key]: safeN(i.value) }); renderDisplay(); };
    return formRow(label, i);
  };
  const julI = input({ type: 'number', value: s.julPayment || '', min: 0, step: 0.01, style: 'width:220px', placeholder: '0.00' });
  julI.oninput = () => { persist({ julPayment: safeN(julI.value) }); renderDisplay(); };

  body.appendChild(el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:16px' },
    fi('decRevRevenue',       s.decRevRevenue,       'Revised expected annual revenue (€)'),
    fi('decRevExpenses',      s.decRevExpenses,      'Revised deductible expenses (€)')
  ));
  body.appendChild(el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:16px' },
    fi('decRevNonDeductible', s.decRevNonDeductible, 'Revised non-deductible expenses (€)'),
    fi('decRevAllowances',    s.decRevAllowances,    'Revised tax allowances / deductions (€)')
  ));
  body.appendChild(el('div', { style: 'margin-top:4px' },
    formRow('Amount already paid in July (€)', julI, 'Your actual first instalment payment')
  ));
  body.appendChild(displayEl);
  card.appendChild(body);
  return card;
}
