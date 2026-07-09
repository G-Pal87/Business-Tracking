// Dividends — Operations module for recording and analysing dividend distributions
import { state, markDirty } from '../core/state.js';
import { el, input, select, button, formRow, toast, openModal, closeModal } from '../core/ui.js';
import * as charts from '../core/charts.js';
import {
  formatEUR, toEUR,
  listActive, listActivePayments,
  resolveExpenseFields, isCapEx,
  newId, upsert, softDelete, companyPropIds,
  getPersonName
} from '../core/data.js';
import { mkSectionLabel, mkSummaryBox, mkSummaryGrid, mkVarianceBadge, mkEmptyState, mkKpiCard } from './analytics-helpers.js';

// ── Constants ─────────────────────────────────────────────────────────────────
// This 2.65% withholding is the General Healthcare System (GHS/GESY)
// contribution, which applies to dividend income for ALL Cyprus tax
// residents regardless of domicile status, capped at the first €180,000 of
// a person's annual GHS-able income (~€4,770/year max). It is NOT the
// Special Defence Contribution (SDC) — SDC is a separate charge (5% from
// 2026) that applies only to Cyprus-domiciled residents; non-domiciled
// residents are exempt from SDC on dividends entirely. This module only
// tracks GHS; if a recipient is Cyprus-domiciled, SDC liability is not
// modelled here and should be handled with a tax adviser.
const GHS_RATE       = 0.0265;
const GHS_ANNUAL_CAP = 180000; // EUR — GHS contributions stop accruing above this per recipient per year
const CHART_IDS = ['div-history-bar', 'div-recipient-donut'];
const G_COLOR   = '#6366f1';
const R_COLOR   = '#ec4899';
let G_LABEL = 'Giorgos';
let R_LABEL = 'Rita';

// ── Module state ──────────────────────────────────────────────────────────────
let gYear = null;

// ── Module export ─────────────────────────────────────────────────────────────
export default {
  id:    'dividends',
  label: 'Dividends',
  icon:  '💰',
  render(container) { container.appendChild(buildView()); },
  refresh() { rebuildView(); },
  destroy() { CHART_IDS.forEach(id => charts.destroy(id)); }
};

// ── Rebuild ────────────────────────────────────────────────────────────────────
function rebuildView() {
  CHART_IDS.forEach(id => charts.destroy(id));
  const c = document.getElementById('content');
  if (!c) return;
  c.innerHTML = '';
  c.appendChild(buildView());
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const safeN = v => (isFinite(Number(v)) ? Math.max(0, Number(v)) : 0);
const fmtE  = v => formatEUR(v, { minFrac: 2 });
const fmtEAny = v => formatEUR(v, { minFrac: 2 });

function getDataYears() {
  const y = new Set();
  listActive('invoices').forEach(i => { const yr = (i.issueDate || '').slice(0, 4); if (yr >= '2000') y.add(yr); });
  listActivePayments().forEach(p => { const yr = (p.date || '').slice(0, 4); if (yr >= '2000') y.add(yr); });
  listActive('expenses').forEach(e => { const yr = (e.date || '').slice(0, 4); if (yr >= '2000') y.add(yr); });
  listActive('dividends').forEach(d => { const yr = (d.date || '').slice(0, 4); if (yr >= '2000') y.add(yr); });
  return [...y].sort().reverse();
}

function defaultYear() {
  const now         = new Date();
  const currentYear = String(now.getFullYear());
  const years       = getDataYears();
  if (!years.length) return currentYear;
  return years[0]; // Most recent year with any data
}

function inYear(date, year) {
  return !!date && date.startsWith(year + '-');
}

// GHS applies to the first €180,000 of a recipient's capped income each
// year, not per-payment — so contributions must be computed cumulatively in
// date order per recipient, not as a flat rate on each dividend in isolation.
// Returns a Map of dividend.id -> actual GHS amount for that dividend.
function ghsScheduleForYear(divsForYear) {
  const cumByRecipient = {};
  const sorted = [...divsForYear].sort((a, b) => (a.date || '').localeCompare(b.date || '') || String(a.id).localeCompare(String(b.id)));
  const ghsById = new Map();
  for (const d of sorted) {
    const key = d.recipient || '_';
    const priorCum = cumByRecipient[key] || 0;
    const amt = d.grossAmount || 0;
    const capacity = Math.max(0, GHS_ANNUAL_CAP - priorCum);
    ghsById.set(d.id, Math.min(amt, capacity) * GHS_RATE);
    cumByRecipient[key] = priorCum + amt;
  }
  return ghsById;
}

// Cumulative gross dividends already recorded for a recipient in a given
// year (excluding one dividend by id, e.g. the one currently being edited).
// Used to preview GHS for a not-yet-saved amount against the cap.
function priorCumForRecipientYear(year, recipient, excludeId) {
  return listActive('dividends')
    .filter(d => d.id !== excludeId && d.recipient === recipient && inYear(d.date, year))
    .reduce((s, d) => s + (d.grossAmount || 0), 0);
}

function ghsForAmount(amount, priorCum) {
  const capacity = Math.max(0, GHS_ANNUAL_CAP - priorCum);
  return Math.min(amount, capacity) * GHS_RATE;
}

function getOpProfit(year) {
  const coPropIds = companyPropIds();
  const isCoRec   = r => !r.propertyId || coPropIds.has(r.propertyId);

  const payments = listActivePayments().filter(p =>
    p.status === 'paid' && inYear(p.date, year) && isCoRec(p)
  );
  const invoices = listActive('invoices').filter(i =>
    i.status === 'paid' && inYear(i.issueDate || i.date, year)
  );
  const opExpenses = listActive('expenses').filter(e =>
    inYear(e.date, year) && !isCapEx(e) && isCoRec(e)
  );
  const capExpenses = listActive('expenses').filter(e =>
    inYear(e.date, year) && isCapEx(e) && isCoRec(e)
  );

  const totalRevenue = [
    ...payments.map(p => toEUR(p.amount, p.currency, p.date)),
    ...invoices.map(i => toEUR(i.total, i.currency, i.issueDate || i.date))
  ].reduce((s, v) => s + v, 0);

  const totalOpEx = opExpenses.reduce((s, e) => s + toEUR(e.amount, e.currency, e.date), 0);
  const totalCapEx = capExpenses.reduce((s, e) => s + toEUR(e.amount, e.currency, e.date), 0);

  return { totalRevenue, totalOpEx, totalCapEx, opProfit: totalRevenue - totalOpEx };
}

function getCorpTaxEst(year) {
  const s = state.db.settings?.cyprusTax;
  if (!s || String(s.year) !== String(year)) return null;
  const rate = safeN(s.corpTaxRate);
  const totalRevenue = safeN(s.actualRevenue) + safeN(s.forecastRevenue);
  const totalDeductible = safeN(s.actualExpenses) + safeN(s.forecastExpenses);
  // Deliberately ignores the Provisional Tax tab's safety buffer: that buffer
  // only pads what gets pre-paid in instalments to avoid the 75%-underpayment
  // penalty (and is reconciled back down at the December revision) — it is
  // not part of the real expected tax liability. Dividend decisions (After-Tax
  // Profit, Retained Earnings, Payout Ratio) need the true unbuffered estimate,
  // or the safety margin silently overstates tax and understates profit here.
  const taxableProfit = Math.max(0, totalRevenue - totalDeductible + safeN(s.nonDeductibleExpenses) - safeN(s.taxAllowances));
  return taxableProfit * (rate / 100);
}

const mkCurrencyInput = (val, style, onValue) => {
  const fmt   = v => v > 0 ? new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v) : '';
  const parse = s => { const n = parseFloat((s || '').replace(/[^0-9.]/g, '')); return isFinite(n) && n > 0 ? n : 0; };
  const i = el('input', { class: 'input', type: 'text', style: style || 'width:100%', inputmode: 'decimal', placeholder: '0.00', autocomplete: 'off' });
  const initVal = safeN(val);
  i.value = initVal > 0 ? fmt(initVal) : '';
  i.addEventListener('focus', () => { const n = parse(i.value); i.value = n > 0 ? String(n) : ''; i.select(); });
  i.addEventListener('blur',  () => { const n = parse(i.value); i.value = n > 0 ? fmt(n) : ''; });
  i.addEventListener('input', () => onValue(parse(i.value)));
  return i;
};

// ── Main view ─────────────────────────────────────────────────────────────────
function buildView() {
  G_LABEL = getPersonName('you');
  R_LABEL = getPersonName('rita');

  const years = getDataYears();
  if (!gYear || !years.includes(gYear)) gYear = defaultYear();

  const wrap = el('div', { class: 'view active' });

  wrap.appendChild(el('div', { style: 'margin-bottom:16px' },
    el('h2', { style: 'margin:0 0 4px;font-size:20px;font-weight:700' }, 'Dividends'),
    el('p',  { style: 'margin:0;font-size:13px;color:var(--text-muted)' },
      'Record, review and analyse dividend distributions with GHS liability tracking')
  ));

  // Year bar
  const yearBar = el('div', {
    style: 'display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:20px;padding:12px 16px;background:var(--bg-elev-1);border:1px solid var(--border);border-radius:var(--radius-sm)'
  });
  yearBar.appendChild(el('span', { style: 'font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text-muted);margin-right:4px' }, 'Year'));
  for (const yr of (years.length ? years : [String(new Date().getFullYear())])) {
    const isActive = yr === gYear;
    const pill = el('button', {
      style: ['padding:4px 12px;border-radius:14px;border:1px solid',
        isActive ? 'var(--accent);background:var(--accent);color:#fff;font-weight:600'
                 : 'var(--border);background:transparent;color:var(--text-muted)',
        ';font-size:12px;cursor:pointer;transition:all 120ms'].join(' ')
    }, yr);
    pill.onclick = () => { if (gYear !== yr) { gYear = yr; rebuildView(); } };
    yearBar.appendChild(pill);
  }
  wrap.appendChild(yearBar);

  // Gather data for selected year
  const allDivs  = listActive('dividends');
  const yearDivs = allDivs.filter(d => inYear(d.date, gYear)).sort((a, b) => b.date.localeCompare(a.date));
  const pnlData  = getOpProfit(gYear);
  const corpTaxEst = getCorpTaxEst(gYear);

  const totalGross = yearDivs.reduce((s, d) => s + (d.grossAmount || 0), 0);
  const ghsById    = ghsScheduleForYear(yearDivs);
  const ghsAmount  = [...ghsById.values()].reduce((s, v) => s + v, 0);
  const netTotal   = totalGross - ghsAmount;
  const gTotal     = yearDivs.filter(d => d.recipient === 'giorgos').reduce((s, d) => s + (d.grossAmount || 0), 0);
  const rTotal     = yearDivs.filter(d => d.recipient === 'rita').reduce((s, d) => s + (d.grossAmount || 0), 0);
  const afterTax   = corpTaxEst !== null ? pnlData.opProfit - corpTaxEst : pnlData.opProfit;
  const retained   = afterTax - totalGross;
  const payoutRatio = afterTax > 0 ? (totalGross / afterTax) * 100 : 0;

  // ── KPI cards ────────────────────────────────────────────────────────────────
  wrap.appendChild(el('div', { style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:16px;margin-bottom:20px' },
    mkKpiCard({
      label: 'Operating Profit',
      value: fmtE(pnlData.opProfit),
      subtitle: 'Revenue minus OpEx (company scope)',
      onClick: () => {
        const body = el('div');
        body.appendChild(mkSummaryGrid([
          { label: 'Total Revenue',    value: fmtE(pnlData.totalRevenue) },
          { label: 'Total OpEx',       value: fmtE(pnlData.totalOpEx) },
          { label: 'Operating Profit', value: fmtE(pnlData.opProfit) },
          { label: 'CapEx (excluded)', value: fmtE(pnlData.totalCapEx) },
        ], 2));
        body.appendChild(el('div', { style: 'margin-top:8px;font-size:12px;color:var(--text-muted);padding:8px 12px;background:rgba(99,102,241,0.06);border-left:2px solid var(--accent);border-radius:4px;line-height:1.6' },
          'Company-channel properties only. CapEx is excluded from OpEx but shown for reference. For the full P&L breakdown, open the Tax → P&L Report tab.'
        ));
        openModal({ title: `Operating Profit — ${gYear}`, body });
      }
    }),
    mkKpiCard({
      label: 'Est. Corporation Tax',
      value: corpTaxEst !== null ? fmtE(corpTaxEst) : '—',
      subtitle: corpTaxEst !== null ? `Provisional Tax (${gYear})` : 'Set in Tax → Provisional tab',
      variant: corpTaxEst !== null && corpTaxEst > 0 ? 'warning' : '',
      onClick: () => {
        const body = el('div', { style: 'display:flex;flex-direction:column;gap:12px' });
        if (corpTaxEst !== null) {
          body.appendChild(mkSummaryGrid([
            { label: 'Operating Profit',   value: fmtE(pnlData.opProfit) },
            { label: 'Est. Corporation Tax', value: fmtE(corpTaxEst) },
            { label: 'After-Tax Profit',   value: fmtE(Math.max(0, afterTax)) },
            { label: 'Tax Rate Applied',   value: `${state.db.settings?.cyprusTax?.corpTaxRate ?? 15}%` },
          ], 2));
        } else {
          body.appendChild(el('p', { style: 'font-size:13px;color:var(--text-muted);line-height:1.6;margin:0' },
            `No corporation tax estimate is linked to ${gYear}. Configure the Provisional Tax tab under Tax (Analysis) for the same year.`
          ));
        }
        openModal({ title: `Est. Corporation Tax — ${gYear}`, body });
      }
    }),
    mkKpiCard({
      label: 'Gross Dividends',
      value: fmtE(totalGross),
      subtitle: yearDivs.length ? `${yearDivs.length} payment${yearDivs.length > 1 ? 's' : ''}` : 'None recorded',
      onClick: totalGross > 0 ? () => {
        const body = el('div');
        body.appendChild(mkSummaryGrid([
          { label: G_LABEL, value: fmtE(gTotal), sub: `${yearDivs.filter(d => d.recipient === 'giorgos').length} payment(s)` },
          { label: R_LABEL, value: fmtE(rTotal), sub: `${yearDivs.filter(d => d.recipient === 'rita').length} payment(s)` },
          { label: 'GHS (2.65%)', value: fmtE(ghsAmount) },
          { label: 'Net Total',   value: fmtE(netTotal) },
        ], 2));
        openModal({ title: `Gross Dividends — ${gYear}`, body });
      } : null
    }),
    mkKpiCard({
      label: 'GHS Contribution (2.65%)',
      value: fmtE(ghsAmount),
      subtitle: totalGross > 0 ? `On ${fmtE(totalGross)} gross` : 'No dividends declared',
      variant: ghsAmount > 0 ? 'warning' : '',
      onClick: () => {
        const body = el('div', { style: 'display:flex;flex-direction:column;gap:12px' });
        body.appendChild(mkSummaryGrid([
          { label: 'Gross Dividends', value: fmtE(totalGross) },
          { label: 'GHS Rate',        value: '2.65%' },
          { label: 'GHS Amount',      value: fmtE(ghsAmount) },
          { label: 'Net to Shareholders', value: fmtE(netTotal) },
        ], 2));
        body.appendChild(el('div', { style: 'font-size:12px;color:var(--text-muted);padding:10px 12px;background:rgba(251,191,36,0.07);border-left:2px solid var(--warning,#f59e0b);border-radius:4px;line-height:1.6' },
          `General Healthcare System (GHS/GESY) contribution of 2.65% is withheld at source on dividends for ALL Cyprus tax residents, regardless of domicile status, on the first €${GHS_ANNUAL_CAP.toLocaleString('en-US')} of a recipient's annual GHS-able income (max ~${fmtE(GHS_ANNUAL_CAP * GHS_RATE)}/year). Non-domiciled residents are separately exempt from Special Defence Contribution (SDC) on dividends — this module does not model SDC for domiciled recipients.`
        ));
        openModal({ title: `GHS Contribution — ${gYear}`, body });
      }
    }),
    mkKpiCard({
      label: 'Retained Earnings',
      value: fmtEAny(retained),
      subtitle: corpTaxEst !== null ? 'After tax & dividends' : 'After dividends (no tax est.)',
      variant: retained < 0 ? 'danger' : retained < pnlData.opProfit * 0.1 ? 'warning' : 'success',
      onClick: () => {
        const body = el('div');
        body.appendChild(mkSummaryGrid([
          { label: 'Operating Profit',     value: fmtE(pnlData.opProfit) },
          { label: 'Est. Corporation Tax', value: corpTaxEst !== null ? fmtE(corpTaxEst) : '—' },
          { label: 'Gross Dividends',      value: fmtE(totalGross) },
          { label: 'Retained Earnings',    value: fmtEAny(retained) },
        ], 2));
        if (corpTaxEst === null) {
          body.appendChild(el('div', { style: 'margin-top:8px;font-size:12px;color:var(--text-muted)' },
            'Corp tax not included — configure the Provisional Tax tab (Tax → Analysis) for this year to show the full picture.'
          ));
        }
        openModal({ title: `Retained Earnings — ${gYear}`, body });
      }
    }),
    mkKpiCard({
      label: 'Payout Ratio',
      value: afterTax > 0 ? `${payoutRatio.toFixed(1)}%` : '—',
      subtitle: afterTax > 0 ? `of ${fmtE(afterTax)} after-tax profit` : corpTaxEst === null ? 'Set corp tax estimate for ratio' : 'No after-tax profit',
      variant: payoutRatio > 90 ? 'danger' : payoutRatio > 70 ? 'warning' : payoutRatio > 0 ? 'success' : '',
      onClick: afterTax > 0 ? () => {
        const body = el('div', { style: 'display:flex;flex-direction:column;gap:12px' });
        body.appendChild(mkSummaryGrid([
          { label: 'After-Tax Profit',  value: fmtE(afterTax) },
          { label: 'Gross Dividends',   value: fmtE(totalGross) },
          { label: 'Payout Ratio',      value: `${payoutRatio.toFixed(1)}%` },
          { label: 'Retained (%)',      value: afterTax > 0 ? `${(100 - payoutRatio).toFixed(1)}%` : '—' },
        ], 2));
        body.appendChild(el('div', { style: 'font-size:12px;color:var(--text-muted);padding:10px 12px;background:rgba(99,102,241,0.06);border-left:2px solid var(--accent);border-radius:4px;line-height:1.6' },
          `A payout ratio above 90% leaves minimal capital for reinvestment and risk reserve. Most small businesses target 50–75% when conditions are stable.`
        ));
        openModal({ title: `Payout Ratio — ${gYear}`, body });
      } : null
    })
  ));

  // ── Insights ──────────────────────────────────────────────────────────────────
  const insights = buildInsights(gYear, yearDivs, pnlData, corpTaxEst, retained, payoutRatio, afterTax, ghsAmount);
  if (insights) wrap.appendChild(insights);

  // ── Charts ────────────────────────────────────────────────────────────────────
  wrap.appendChild(buildChartsSection(allDivs));

  // ── Add form ──────────────────────────────────────────────────────────────────
  wrap.appendChild(buildAddForm(gYear));

  // ── Dividend log ──────────────────────────────────────────────────────────────
  wrap.appendChild(buildLogTable(gYear, yearDivs, gTotal, rTotal, totalGross, ghsAmount, netTotal, ghsById));

  // ── Footnote ──────────────────────────────────────────────────────────────────
  wrap.appendChild(el('div', { style: 'margin-top:12px;font-size:11px;color:var(--text-muted);padding:10px 14px;background:var(--bg-elev-1);border:1px solid var(--border);border-radius:var(--radius-sm);line-height:1.7' },
    `⚖️  GHS (GESY) at 2.65% is withheld at source on dividends for all Cyprus tax residents, capped at the first €${GHS_ANNUAL_CAP.toLocaleString('en-US')} of a recipient's annual GHS-able income per year. ` +
    'Non-domiciled residents are separately exempt from Special Defence Contribution (SDC) on dividends (not modelled here); domiciled residents may owe SDC in addition to GHS — check with your adviser. ' +
    'Gross amounts entered here are the declared distribution; net = gross − GHS. ' +
    'This module does not constitute tax advice — consult your Cyprus-licensed tax adviser.'
  ));

  return wrap;
}

// ── Insights section ──────────────────────────────────────────────────────────
function buildInsights(year, yearDivs, pnlData, corpTaxEst, retained, payoutRatio, afterTax, ghsAmount) {
  const items = [];

  if (!yearDivs.length) {
    items.push({ type: 'info', text: `No dividends declared for ${year}. Use the form below to record the first distribution.` });
  }

  if (payoutRatio > 90 && afterTax > 0) {
    items.push({ type: 'danger', text: `Payout ratio is ${payoutRatio.toFixed(1)}% — only ${fmtE(Math.max(0, retained))} retained. Consider holding more profit in the company for tax provisioning and working capital.` });
  } else if (payoutRatio > 75 && afterTax > 0) {
    items.push({ type: 'warning', text: `Payout ratio is ${payoutRatio.toFixed(1)}%. Retaining at least 25% is generally recommended to cover corporation tax, reinvestment, and unexpected costs.` });
  }

  if (retained < 0) {
    items.push({ type: 'danger', text: `Retained earnings are negative (${fmtEAny(retained)}). Dividends exceed after-tax profit — this depletes accumulated reserves or signals over-distribution.` });
  }

  if (corpTaxEst === null && yearDivs.length > 0) {
    items.push({ type: 'warning', text: `No corporation tax estimate set for ${year}. Open Tax → Provisional Tax tab to configure it, then the Payout Ratio and Retained Earnings here will reflect the full picture.` });
  }

  if (ghsAmount > 0) {
    items.push({ type: 'info', text: `GHS due: ${fmtE(ghsAmount)} for ${year}. Remit to the Cyprus Tax Department promptly; late payment incurs interest and penalties.` });
  }

  // Non-dom reminder — show in Q2/Q3
  const month = new Date().getMonth() + 1;
  if (month >= 4 && month <= 8) {
    items.push({ type: 'info', text: `Reminder: non-domicile status must be declared annually by 31 July using the TD98 form to maintain SDC exemption on dividends (separate from the 2.65% GHS contribution, which applies regardless of domicile).` });
  }

  if (!items.length) return null;

  const colors = { info: 'var(--accent)', warning: 'var(--warning,#f59e0b)', danger: 'var(--danger,#ef4444)' };
  const bgs    = { info: 'rgba(99,102,241,0.07)', warning: 'rgba(251,191,36,0.07)', danger: 'rgba(239,68,68,0.07)' };
  const icons  = { info: 'ℹ', warning: '⚠', danger: '🔴' };

  const section = el('div', { style: 'margin-bottom:20px' });
  section.appendChild(mkSectionLabel('Insights'));
  const grid = el('div', { style: 'display:flex;flex-direction:column;gap:8px' });
  for (const { type, text } of items) {
    grid.appendChild(el('div', {
      style: `font-size:13px;line-height:1.6;padding:10px 14px;background:${bgs[type]};border-left:3px solid ${colors[type]};border-radius:4px;color:var(--text)`
    }, `${icons[type]}  ${text}`));
  }
  section.appendChild(grid);
  return section;
}

// ── Charts section ────────────────────────────────────────────────────────────
function buildChartsSection(allDivs) {
  const section = el('div', { style: 'margin-bottom:20px' });
  section.appendChild(mkSectionLabel('History'));

  const row = el('div', { style: 'display:grid;grid-template-columns:2fr 1fr;gap:16px' });

  // History bar — stacked Giorgos + Rita by year
  const histCard = el('div', { class: 'card' });
  histCard.appendChild(el('div', { class: 'card-header' },
    el('div', { class: 'card-title' }, 'Dividends by Year'),
    el('div', { style: 'font-size:12px;color:var(--text-muted)' }, 'Gross declared — click a bar to select year')
  ));
  histCard.appendChild(el('div', { style: 'padding:16px;height:220px' },
    el('canvas', { id: 'div-history-bar' })
  ));
  row.appendChild(histCard);

  // Recipient donut — current year split
  const donutCard = el('div', { class: 'card' });
  donutCard.appendChild(el('div', { class: 'card-header' },
    el('div', { class: 'card-title' }, `${gYear} Split`),
    el('div', { style: 'font-size:12px;color:var(--text-muted)' }, 'Gross by recipient')
  ));
  donutCard.appendChild(el('div', { style: 'padding:16px;height:220px' },
    el('canvas', { id: 'div-recipient-donut' })
  ));
  row.appendChild(donutCard);
  section.appendChild(row);

  // Render charts on next tick
  requestAnimationFrame(() => renderHistoryBar(allDivs));
  requestAnimationFrame(() => renderRecipientDonut(allDivs));

  return section;
}

function renderHistoryBar(allDivs) {
  // Group by year × recipient
  const byYear = {};
  for (const d of allDivs) {
    const yr = (d.date || '').slice(0, 4);
    if (!yr || yr < '2000') continue;
    if (!byYear[yr]) byYear[yr] = { giorgos: 0, rita: 0 };
    if (d.recipient === 'giorgos') byYear[yr].giorgos += d.grossAmount || 0;
    else byYear[yr].rita += d.grossAmount || 0;
  }
  const labels = Object.keys(byYear).sort();
  if (!labels.length) return;

  charts.bar('div-history-bar', {
    labels,
    stacked: true,
    datasets: [
      { label: G_LABEL, data: labels.map(yr => byYear[yr].giorgos), color: G_COLOR },
      { label: R_LABEL, data: labels.map(yr => byYear[yr].rita),    color: R_COLOR },
    ],
    onClickItem: (idx) => {
      const yr = labels[idx];
      if (yr && gYear !== yr) { gYear = yr; rebuildView(); }
    }
  });
}

function renderRecipientDonut(allDivs) {
  const yearDivs = allDivs.filter(d => inYear(d.date, gYear));
  const gTotal   = yearDivs.filter(d => d.recipient === 'giorgos').reduce((s, d) => s + (d.grossAmount || 0), 0);
  const rTotal   = yearDivs.filter(d => d.recipient === 'rita').reduce((s, d) => s + (d.grossAmount || 0), 0);

  if (gTotal + rTotal === 0) return;

  charts.doughnut('div-recipient-donut', {
    labels: [G_LABEL, R_LABEL],
    data:   [gTotal, rTotal],
    colors: [G_COLOR, R_COLOR],
    onClickItem: null
  });
}

// ── Add dividend form ─────────────────────────────────────────────────────────
function buildAddForm(year) {
  const formCard = el('div', { class: 'card mb-16' });
  formCard.appendChild(el('div', { class: 'card-header' },
    el('div', { class: 'card-title' }, 'Record Dividend Payment'),
    el('div', { style: 'font-size:12px;color:var(--text-muted)' }, 'Log a gross dividend distribution')
  ));
  const formBody = el('div', { style: 'padding:0 16px 16px' });

  let formDate      = `${year}-01-01`;
  let formAmount    = 0;
  let formRecipient = 'giorgos';
  let formNotes     = '';

  const dateI = input({ type: 'date', value: formDate, style: 'width:150px' });
  dateI.oninput = () => { formDate = dateI.value; };

  const ghsPreviewEl = el('div', { style: 'font-size:11px;color:var(--text-muted);margin-top:4px;min-height:16px;transition:opacity 120ms' });
  const updateGhsPreview = v => {
    if (v > 0) {
      const prior = priorCumForRecipientYear(year, formRecipient, null);
      const ghs   = ghsForAmount(v, prior);
      ghsPreviewEl.textContent = `GHS ${fmtE(ghs)} · Net received ${fmtE(v - ghs)}`;
      ghsPreviewEl.style.opacity = '1';
    } else {
      ghsPreviewEl.textContent = '';
      ghsPreviewEl.style.opacity = '0';
    }
  };

  const amountWrap = el('div');
  const amountI    = mkCurrencyInput(0, 'width:160px', v => { formAmount = v; updateGhsPreview(v); });
  amountWrap.appendChild(amountI);
  amountWrap.appendChild(ghsPreviewEl);

  const recipientSel = select([{ value: 'giorgos', label: G_LABEL }, { value: 'rita', label: R_LABEL }], 'giorgos');
  recipientSel.onchange = () => { formRecipient = recipientSel.value; updateGhsPreview(formAmount); };

  const notesI = input({ type: 'text', placeholder: 'Notes (optional)', style: 'flex:1;min-width:140px' });
  notesI.oninput = () => { formNotes = notesI.value; };

  const addBtn = button('+ Add Dividend', { variant: 'primary sm' });
  addBtn.onclick = () => {
    if (!formDate) { toast('Select a date', 'error'); return; }
    if (formAmount <= 0) {
      amountI.style.borderColor = 'var(--danger,#ef4444)';
      toast('Enter a gross amount greater than zero', 'error');
      setTimeout(() => { amountI.style.borderColor = ''; }, 2000);
      return;
    }
    upsert('dividends', { id: newId('div'), date: formDate, grossAmount: formAmount, recipient: formRecipient, notes: formNotes });
    // The date picker isn't constrained to the year currently being viewed —
    // without this, saving a dividend for a different year made it vanish
    // from the list the instant the view rebuilt, reading as a failed save.
    const savedYear = formDate.slice(0, 4);
    if (savedYear !== String(year)) {
      gYear = savedYear;
      toast(`Dividend recorded for ${savedYear} — switched the view to that year`, 'success', 5000);
    } else {
      toast('Dividend recorded', 'success');
    }
    rebuildView();
  };

  formBody.appendChild(el('div', { style: 'display:grid;grid-template-columns:150px 180px 130px 1fr auto;gap:0 14px;align-items:start' },
    formRow('Date', dateI),
    formRow('Gross Amount (€)', amountWrap),
    formRow('Recipient', recipientSel),
    formRow('Notes', notesI),
    el('div', { style: 'padding-top:22px' }, addBtn)
  ));

  formBody.appendChild(el('div', { style: 'margin-top:10px;font-size:12px;color:var(--text-muted);padding:8px 12px;background:rgba(99,102,241,0.06);border-left:2px solid var(--accent);border-radius:4px' },
    `GHS (GESY) of 2.65% is withheld on the gross dividend, up to the recipient's €${GHS_ANNUAL_CAP.toLocaleString('en-US')} annual cap. Net received = gross − GHS.`
  ));

  formCard.appendChild(formBody);
  return formCard;
}

// ── Dividend log table ────────────────────────────────────────────────────────
function buildLogTable(year, yearDivs, gTotal, rTotal, totalGross, ghsAmount, netTotal, ghsById) {
  const logCard = el('div', { class: 'card mb-16' });
  logCard.appendChild(el('div', { class: 'card-header' },
    el('div', { class: 'card-title' }, `Dividend Log — ${year}`),
    el('div', { style: 'font-size:12px;color:var(--text-muted)' },
      `${yearDivs.length} payment${yearDivs.length !== 1 ? 's' : ''} · GHS rate 2.65% (capped)`)
  ));

  if (!yearDivs.length) {
    logCard.appendChild(el('div', { style: 'padding:24px;text-align:center;color:var(--text-muted);font-size:13px;font-style:italic' },
      `No dividends recorded for ${year}. Use the form above to add one.`
    ));
    return logCard;
  }

  const tbl  = el('table', { style: 'width:100%;border-collapse:collapse;font-size:13px' });
  const hrow = el('tr');
  [['Date', 'left'], ['Recipient', 'left'], ['Gross Amount', 'right'], ['GHS (2.65%)', 'right'], ['Net Amount', 'right'], ['Notes', 'left'], ['', 'right']].forEach(([h, align]) => {
    hrow.appendChild(el('th', {
      style: `padding:8px 12px;text-align:${align};font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:var(--text-muted);border-bottom:1px solid rgba(255,255,255,0.08)`
    }, h));
  });
  tbl.appendChild(el('thead', {}, hrow));

  const tbody = el('tbody');
  yearDivs.forEach((d, ri) => {
    const ghs  = ghsById.get(d.id) || 0;
    const net  = (d.grossAmount || 0) - ghs;
    const isG  = d.recipient === 'giorgos';
    const tr   = el('tr', { style: ri % 2 === 1 ? 'background:rgba(255,255,255,0.02)' : '' });

    [
      [d.date || '—',            'left',  'var(--text-muted)'],
      [isG ? G_LABEL : R_LABEL,  'left',  isG ? 'var(--accent)' : '#f472b6'],
      [fmtE(d.grossAmount || 0), 'right', 'var(--text)'],
      [fmtE(ghs),                'right', 'var(--text-muted)'],
      [fmtE(net),                'right', 'var(--success,#10b981)'],
      [d.notes || '—',           'left',  'var(--text-muted)'],
    ].forEach(([text, align, color]) => {
      tr.appendChild(el('td', { style: `padding:8px 12px;text-align:${align};color:${color}` }, text));
    });

    // Actions cell
    const actTd = el('td', { style: 'padding:8px 12px;text-align:right;white-space:nowrap' });
    const editBtn = el('button', { style: 'padding:2px 8px;font-size:11px;border:1px solid var(--accent);background:transparent;color:var(--accent);border-radius:4px;cursor:pointer;margin-right:6px' }, 'Edit');
    editBtn.onclick = () => openEditModal(d);
    const delBtn = el('button', { style: 'padding:2px 8px;font-size:11px;border:1px solid var(--border);background:transparent;color:var(--text-muted);border-radius:4px;cursor:pointer' }, '×');
    delBtn.onclick = () => {
      if (confirm(`Remove dividend of ${fmtE(d.grossAmount || 0)} for ${isG ? G_LABEL : R_LABEL} on ${d.date}?`)) {
        softDelete('dividends', d.id);
        rebuildView();
      }
    };
    actTd.appendChild(editBtn);
    actTd.appendChild(delBtn);
    tr.appendChild(actTd);
    tbody.appendChild(tr);
  });

  // Totals row
  const totRow = el('tr', { style: 'border-top:2px solid var(--border);font-weight:700' });
  [['Total', 'left', ''], ['', 'left', ''], [fmtE(totalGross), 'right', ''], [fmtE(ghsAmount), 'right', ''], [fmtE(netTotal), 'right', 'var(--success,#10b981)'], ['', 'left', ''], ['', 'right', '']].forEach(([text, align, color]) => {
    totRow.appendChild(el('td', { style: `padding:8px 12px;text-align:${align};color:${color || 'var(--text)'}` }, text));
  });
  tbody.appendChild(totRow);
  tbl.appendChild(tbody);
  logCard.appendChild(el('div', { style: 'padding:0 0 8px' }, tbl));

  // Per-recipient split footer
  if (gTotal > 0 || rTotal > 0) {
    const gGhs = yearDivs.filter(d => d.recipient === 'giorgos').reduce((s, d) => s + (ghsById.get(d.id) || 0), 0);
    const rGhs = yearDivs.filter(d => d.recipient === 'rita').reduce((s, d) => s + (ghsById.get(d.id) || 0), 0);
    const parts = [];
    if (gTotal > 0) parts.push(el('span', {}, `${G_LABEL}: ${fmtE(gTotal)} gross · ${fmtE(gTotal - gGhs)} net`));
    if (rTotal > 0) parts.push(el('span', {}, `${R_LABEL}: ${fmtE(rTotal)} gross · ${fmtE(rTotal - rGhs)} net`));
    if (gTotal > 0 && rTotal > 0) {
      parts.push(el('span', { style: 'color:var(--text-muted);font-style:italic' }, 'GHS applies to all dividends, capped per recipient'));
    }
    logCard.appendChild(el('div', { style: 'padding:0 16px 16px;display:flex;gap:24px;flex-wrap:wrap;font-size:12px;color:var(--text-muted)' }, ...parts));
  }

  return logCard;
}

// ── Edit dividend modal ───────────────────────────────────────────────────────
function openEditModal(d) {
  let editDate      = d.date || '';
  let editAmount    = d.grossAmount || 0;
  let editRecipient = d.recipient || 'giorgos';
  let editNotes     = d.notes || '';

  const body = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });

  const dateI = input({ type: 'date', value: editDate, style: 'width:160px' });
  dateI.oninput = () => { editDate = dateI.value; updateGhsPreview(editAmount); };

  const ghsPreviewEl = el('div', { style: 'font-size:11px;color:var(--text-muted);margin-top:4px;min-height:16px;transition:opacity 120ms' });
  const updateGhsPreview = v => {
    if (v > 0 && editDate) {
      const prior = priorCumForRecipientYear(editDate.slice(0, 4), editRecipient, d.id);
      const ghs   = ghsForAmount(v, prior);
      ghsPreviewEl.textContent = `GHS ${fmtE(ghs)} · Net received ${fmtE(v - ghs)}`;
      ghsPreviewEl.style.opacity = '1';
    } else {
      ghsPreviewEl.textContent = '';
      ghsPreviewEl.style.opacity = '0';
    }
  };
  const amountWrap = el('div');
  const amountI    = mkCurrencyInput(editAmount, 'width:160px', v => { editAmount = v; updateGhsPreview(v); });
  amountWrap.appendChild(amountI);
  amountWrap.appendChild(ghsPreviewEl);
  updateGhsPreview(editAmount);

  const recipientSel = select([{ value: 'giorgos', label: G_LABEL }, { value: 'rita', label: R_LABEL }], editRecipient);
  recipientSel.onchange = () => { editRecipient = recipientSel.value; updateGhsPreview(editAmount); };

  const notesI = input({ type: 'text', value: editNotes, placeholder: 'Notes (optional)', style: 'width:100%' });
  notesI.oninput = () => { editNotes = notesI.value; };

  body.appendChild(el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:12px' },
    formRow('Date', dateI),
    formRow('Gross Amount (€)', amountWrap)
  ));
  body.appendChild(el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:12px' },
    formRow('Recipient', recipientSel),
    formRow('Notes', notesI)
  ));

  const saveBtn = button('Save Changes', { variant: 'primary' });
  saveBtn.onclick = () => {
    if (!editDate) { toast('Select a date', 'error'); return; }
    if (editAmount <= 0) {
      amountI.style.borderColor = 'var(--danger,#ef4444)';
      toast('Enter a gross amount greater than zero', 'error');
      setTimeout(() => { amountI.style.borderColor = ''; }, 2000);
      return;
    }
    upsert('dividends', { ...d, date: editDate, grossAmount: editAmount, recipient: editRecipient, notes: editNotes });
    closeModal();
    toast('Dividend updated', 'success');
    rebuildView();
  };

  openModal({
    title: `Edit Dividend — ${d.date || ''}`,
    body,
    footer: saveBtn
  });
}
