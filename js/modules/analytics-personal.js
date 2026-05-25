// Personal Income Dashboard — salary, owner rent, reimbursements, dividends, personal properties
import { el, openModal } from '../core/ui.js';
import * as charts from '../core/charts.js';
import { formatEUR, toEUR, byId, listActive, listActivePayments } from '../core/data.js';
import {
  createFilterState, buildFilterBar, buildComparisonLine,
  getCurrentPeriodRange, getComparisonRange, getMonthKeysForRange
} from './analytics-filters.js?v=20260519';
import {
  mkSectionLabel, mkSummaryBox, mkSummaryGrid, mkModalTable, mkVarianceBadge,
  mkEmptyState, mkKpiCard, safePct
} from './analytics-helpers.js';
import { PERSONAL_EXPENSE_CATS } from '../core/config.js';

// ── Constants ─────────────────────────────────────────────────────────────────
const SDC_RATE  = 0.0265;
const CHART_IDS = ['pi-monthly-bar', 'pi-giorgos-donut', 'pi-rita-donut'];
const YOU_HEX   = '#6366f1';
const RITA_HEX  = '#ec4899';
const YOU_LABEL = 'Giorgos';
const RITA_LABEL = 'Rita';

const INCOME_COLORS = {
  salary:   '#6366f1',
  rent:     '#14b8a6',
  reimb:    '#f59e0b',
  divs:     '#22c55e',
  personal: '#ec4899'
};

// ── Filter state ──────────────────────────────────────────────────────────────
let gF = createFilterState();

// ── Module export ─────────────────────────────────────────────────────────────
export default {
  id: 'analytics-personal',
  label: 'Personal Income',
  icon: '₱',
  render(container) { container.appendChild(buildView()); },
  refresh() { rebuildView(); },
  destroy() { CHART_IDS.forEach(id => charts.destroy(id)); }
};

// ── Data ──────────────────────────────────────────────────────────────────────
function getPersonData(person, start, end, months) {
  const inRange    = d => d && d >= start && d <= end;
  const cats       = PERSONAL_EXPENSE_CATS[person];
  const ownerKeys  = person === 'you' ? ['you', 'both'] : ['rita', 'both'];
  const recipient  = person === 'you' ? 'giorgos' : 'rita';

  // Salary
  const salaryExps = listActive('expenses').filter(e => e.category === cats.salary && inRange(e.date));
  const salary     = salaryExps.reduce((s, e) => s + toEUR(e.amount, e.currency, e.date), 0);

  // GESY / social contributions (company cost — shown for context, not personal income)
  const gesyExps   = listActive('expenses').filter(e => e.category === cats.gesy && inRange(e.date));
  const gesyTotal  = gesyExps.reduce((s, e) => s + toEUR(e.amount, e.currency, e.date), 0);

  // Reimbursements
  const reimbExps  = listActive('expenses').filter(e => e.category === cats.reimb && inRange(e.date));
  const reimb      = reimbExps.reduce((s, e) => s + toEUR(e.amount, e.currency, e.date), 0);

  // Owner rent — calculated from monthlyRent × active months for company-channel properties
  const companyProps = listActive('properties').filter(p =>
    (p.channel === 'company' || !p.channel) &&
    ownerKeys.includes(p.owner || 'both') &&
    (p.monthlyRent || 0) > 0 &&
    p.status !== 'sold'
  );
  const ownerRentByMonth = {};
  let ownerRentTotal = 0;
  for (const m of months) {
    const mDate = m.key + '-15';
    let mo = 0;
    for (const prop of companyProps) {
      if (prop.soldDate && prop.soldDate < m.key + '-01') continue;
      const share = prop.owner === 'both' ? 0.5 : 1;
      mo += toEUR(prop.monthlyRent || 0, prop.currency || 'EUR', mDate) * share;
    }
    ownerRentByMonth[m.key] = mo;
    ownerRentTotal += mo;
  }

  // Dividends
  const divRecords  = listActive('dividends').filter(d => d.recipient === recipient && inRange(d.date));
  const grossDivs   = divRecords.reduce((s, d) => s + (d.grossAmount || 0), 0);
  const sdcAmount   = grossDivs * SDC_RATE;
  const netDivs     = grossDivs - sdcAmount;

  // Personal-channel property income
  const personalProps = listActive('properties').filter(p =>
    p.channel === 'personal' && ownerKeys.includes(p.owner || 'both')
  );
  const personalPropIds = new Set(personalProps.map(p => p.id));
  const personalPayments = listActivePayments().filter(p =>
    p.status === 'paid' && inRange(p.date) && personalPropIds.has(p.propertyId)
  );
  const personalByProp = new Map();
  for (const pmt of personalPayments) {
    const eur = toEUR(pmt.amount, pmt.currency, pmt.date);
    personalByProp.set(pmt.propertyId, (personalByProp.get(pmt.propertyId) || 0) + eur);
  }
  const personalIncome = [...personalByProp.values()].reduce((s, v) => s + v, 0);

  const fromCompany = salary + ownerRentTotal + reimb + netDivs;
  const total = fromCompany + personalIncome;

  return {
    salary, salaryExps,
    gesyTotal, gesyExps,
    reimb, reimbExps,
    ownerRentTotal, ownerRentByMonth, companyProps,
    grossDivs, sdcAmount, netDivs, divRecords,
    personalIncome, personalPayments, personalProps, personalByProp,
    fromCompany, total
  };
}

// ── KPI section ───────────────────────────────────────────────────────────────
function buildKpiSection(youData, ritaData, youCmp, ritaCmp, cmpRange) {
  const combined    = youData.total + ritaData.total;
  const cmpCombined = youCmp ? youCmp.total + ritaCmp.total : null;

  const grid = el('div', {
    style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px;margin-bottom:20px'
  });

  grid.appendChild(mkKpiCard({
    label: 'Total — ' + YOU_LABEL,
    value: formatEUR(youData.total),
    subtitle: `Company: ${formatEUR(youData.fromCompany)} · Personal: ${formatEUR(youData.personalIncome)}`,
    delta: safePct(youData.total, youCmp?.total),
    compLabel: cmpRange?.label,
    onClick: () => showPersonModal(YOU_LABEL, youData)
  }));

  grid.appendChild(mkKpiCard({
    label: 'Total — ' + RITA_LABEL,
    value: formatEUR(ritaData.total),
    subtitle: `Company: ${formatEUR(ritaData.fromCompany)} · Personal: ${formatEUR(ritaData.personalIncome)}`,
    delta: safePct(ritaData.total, ritaCmp?.total),
    compLabel: cmpRange?.label,
    onClick: () => showPersonModal(RITA_LABEL, ritaData)
  }));

  grid.appendChild(mkKpiCard({
    label: 'Combined Gross',
    value: formatEUR(combined),
    subtitle: 'Both directors combined',
    delta: safePct(combined, cmpCombined),
    compLabel: cmpRange?.label,
    onClick: () => {
      const body = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });
      body.appendChild(mkSummaryGrid([
        { label: YOU_LABEL,  value: formatEUR(youData.total),  sub: null },
        { label: RITA_LABEL, value: formatEUR(ritaData.total), sub: null },
        { label: 'Combined', value: formatEUR(combined) }
      ], 3));
      openModal({ title: 'Combined Gross Income', body, large: true });
    }
  }));

  const avgMonth = combined / Math.max(1, Object.keys(youData.ownerRentByMonth).length || 1);
  grid.appendChild(mkKpiCard({
    label: 'Avg / Month',
    value: formatEUR(avgMonth),
    subtitle: 'Combined both directors',
    delta: null
  }));

  return grid;
}

// ── Person summary modal ──────────────────────────────────────────────────────
function showPersonModal(label, data) {
  const body = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });
  body.appendChild(mkSummaryGrid([
    { label: 'Total Gross',       value: formatEUR(data.total) },
    { label: 'From Company',      value: formatEUR(data.fromCompany) },
    { label: 'Personal Properties', value: formatEUR(data.personalIncome) }
  ], 3));
  body.appendChild(mkSectionLabel('Breakdown'));
  body.appendChild(mkModalTable(
    ['Source', 'Amount', 'Notes'],
    [
      ['Director Salary',       formatEUR(data.salary),       `${data.salaryExps.length} expense records`],
      ['Property Rent (owner)', formatEUR(data.ownerRentTotal), `${data.companyProps.length} company-operated properties`],
      ['Reimbursements',        formatEUR(data.reimb),        `${data.reimbExps.length} records`],
      ['Dividends (net SDC)',   formatEUR(data.netDivs),      data.grossDivs > 0 ? `Gross ${formatEUR(data.grossDivs)} − SDC ${formatEUR(data.sdcAmount)}` : 'No dividends'],
      ['Personal Properties',   formatEUR(data.personalIncome), `${data.personalPayments.length} payments`],
    ],
    { highlight: 1 }
  ));
  if (data.gesyTotal > 0) {
    body.appendChild(el('div', { style: 'font-size:11px;color:var(--text-muted);padding:4px 0' },
      `ℹ Social contributions (GESY) paid by company: ${formatEUR(data.gesyTotal)} — employer cost, not personal income`
    ));
  }
  openModal({ title: `${label} — Full Gross Income`, body, large: true });
}

// ── Salary drill-down ─────────────────────────────────────────────────────────
function showSalaryModal(label, data) {
  const body = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });
  body.appendChild(mkSummaryGrid([
    { label: 'Total Salary',  value: formatEUR(data.salary) },
    { label: 'Records',       value: String(data.salaryExps.length) },
    ...(data.gesyTotal > 0 ? [{ label: 'GESY (company cost)', value: formatEUR(data.gesyTotal) }] : [])
  ], 3));
  if (data.salaryExps.length > 0) {
    body.appendChild(mkSectionLabel('Salary Records'));
    const rows = data.salaryExps
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
      .map(e => [e.date || '—', formatEUR(toEUR(e.amount, e.currency, e.date)), e.description || '—']);
    body.appendChild(mkModalTable(['Date', 'Amount (EUR)', 'Description'], rows, { highlight: 1 }));
  } else {
    body.appendChild(mkEmptyState('No salary records for this period. Add expenses with category "Salary".'));
  }
  openModal({ title: `${label} — Director Salary`, body, large: true });
}

// ── Owner rent drill-down ─────────────────────────────────────────────────────
function showRentModal(label, data, months) {
  const body = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });
  body.appendChild(mkSummaryGrid([
    { label: 'Total Owner Rent', value: formatEUR(data.ownerRentTotal) },
    { label: 'Properties',       value: String(data.companyProps.length) },
    { label: 'Months in Period', value: String(months.length) }
  ], 3));
  if (data.companyProps.length > 0) {
    body.appendChild(mkSectionLabel('Company-Operated Properties (Monthly Rent)'));
    const rows = data.companyProps.map(p => {
      const share = p.owner === 'both' ? 0.5 : 1;
      const monthly = toEUR(p.monthlyRent || 0, p.currency || 'EUR', null);
      const period  = monthly * share * months.length;
      return [p.name, p.city, formatEUR(monthly * share) + '/mo', formatEUR(period)];
    });
    body.appendChild(mkModalTable(['Property', 'City', 'Share/Month', 'Period Total'], rows, { highlight: 3 }));
    body.appendChild(el('div', { style: 'font-size:11px;color:var(--text-muted)' },
      'Calculated from Monthly Owner Rent field × months in period. To update rent amounts, edit each property.'
    ));
  } else {
    body.appendChild(mkEmptyState('No company-operated properties with owner rent configured. Set "Monthly Owner Rent" on Cyprus properties.'));
  }
  openModal({ title: `${label} — Owner Rent Income`, body, large: true });
}

// ── Dividends drill-down ──────────────────────────────────────────────────────
function showDivModal(label, data) {
  const body = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });
  body.appendChild(mkSummaryGrid([
    { label: 'Gross Dividends', value: formatEUR(data.grossDivs) },
    { label: 'SDC (2.65%)',     value: formatEUR(data.sdcAmount) },
    { label: 'Net Dividends',   value: formatEUR(data.netDivs) }
  ], 3));
  if (data.divRecords.length > 0) {
    body.appendChild(mkSectionLabel('Dividend Records'));
    const rows = data.divRecords
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
      .map(d => [
        d.date || '—',
        formatEUR(d.grossAmount || 0),
        formatEUR((d.grossAmount || 0) * SDC_RATE),
        formatEUR((d.grossAmount || 0) * (1 - SDC_RATE)),
        d.notes || '—'
      ]);
    body.appendChild(mkModalTable(['Date', 'Gross', 'SDC', 'Net', 'Notes'], rows, { highlight: 3 }));
  } else {
    body.appendChild(mkEmptyState('No dividends for this period. Add dividends in the Tax → Dividends tab.'));
  }
  openModal({ title: `${label} — Dividends`, body, large: true });
}

// ── Personal properties drill-down ────────────────────────────────────────────
function showPersonalPropsModal(label, data) {
  const body = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });
  body.appendChild(mkSummaryGrid([
    { label: 'Total Income',  value: formatEUR(data.personalIncome) },
    { label: 'Properties',    value: String(data.personalProps.length) },
    { label: 'Payments',      value: String(data.personalPayments.length) }
  ], 3));
  if (data.personalProps.length > 0) {
    body.appendChild(mkSectionLabel('Income by Property'));
    const rows = data.personalProps
      .map(p => ({ prop: p, income: data.personalByProp.get(p.id) || 0 }))
      .sort((a, b) => b.income - a.income)
      .map(({ prop, income }) => [prop.name, prop.city, prop.country, formatEUR(income)]);
    body.appendChild(mkModalTable(['Property', 'City', 'Country', 'Income (EUR)'], rows, { highlight: 3 }));
  } else {
    body.appendChild(mkEmptyState('No personal-channel properties. Mark properties as Personal in the Properties form.'));
  }
  openModal({ title: `${label} — Personal Properties`, body, large: true });
}

// ── Person column ─────────────────────────────────────────────────────────────
function buildPersonColumn(label, color, data, months) {
  const col = el('div', {
    style: `background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:8px;padding:16px;border-top:3px solid ${color}`
  });
  col.appendChild(el('div', { style: `font-size:14px;font-weight:700;color:${color};margin-bottom:12px;letter-spacing:0.03em` }, label));

  const makeRow = (rowLabel, value, clickable, onClick, sub) => {
    const item = el('div', {
      style: 'display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px solid rgba(255,255,255,0.04)' +
             (clickable ? ';cursor:pointer' : '')
    });
    if (clickable) {
      item.addEventListener('mouseenter', () => { item.style.background = 'rgba(255,255,255,0.03)'; });
      item.addEventListener('mouseleave', () => { item.style.background = ''; });
      item.onclick = onClick;
    }
    const lhs = el('div');
    lhs.appendChild(el('span', { style: 'font-size:12px;color:var(--text-muted)' }, rowLabel));
    if (sub) lhs.appendChild(el('div', { style: 'font-size:10px;color:var(--text-dim);margin-top:1px' }, sub));
    item.appendChild(lhs);
    item.appendChild(el('span', { style: 'font-size:13px;font-weight:600;color:var(--text)' }, value));
    return item;
  };

  // ── From Company ────────────────────────────────────────────────────────────
  col.appendChild(mkSectionLabel('From Company'));

  col.appendChild(makeRow(
    'Director Salary', formatEUR(data.salary),
    data.salaryExps.length > 0 || true,
    () => showSalaryModal(label, data),
    data.salaryExps.length > 0 ? `${data.salaryExps.length} records` : 'No records — add salary expenses'
  ));

  col.appendChild(makeRow(
    'Property Rent (Owner)', formatEUR(data.ownerRentTotal),
    true,
    () => showRentModal(label, data, months),
    data.companyProps.length > 0 ? `${data.companyProps.length} properties × ${months.length} months` : 'Set Monthly Owner Rent on properties'
  ));

  col.appendChild(makeRow(
    'Reimbursements', formatEUR(data.reimb),
    data.reimbExps.length > 0,
    () => {
      const body = el('div', { style: 'display:flex;flex-direction:column;gap:12px' });
      if (data.reimbExps.length > 0) {
        const rows = data.reimbExps
          .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
          .map(e => [e.date || '—', formatEUR(toEUR(e.amount, e.currency, e.date)), e.description || '—']);
        body.appendChild(mkModalTable(['Date', 'Amount (EUR)', 'Description'], rows, { highlight: 1 }));
      } else {
        body.appendChild(mkEmptyState('No reimbursements this period.'));
      }
      openModal({ title: `${label} — Reimbursements`, body, large: true });
    },
    data.reimbExps.length > 0 ? `${data.reimbExps.length} records` : null
  ));

  col.appendChild(makeRow(
    'Dividends (net SDC)', formatEUR(data.netDivs),
    data.divRecords.length > 0,
    () => showDivModal(label, data),
    data.grossDivs > 0
      ? `Gross ${formatEUR(data.grossDivs)} − SDC ${formatEUR(data.sdcAmount)}`
      : 'No dividends this period'
  ));

  // Subtotal from company
  const compSub = el('div', { style: 'display:flex;justify-content:space-between;align-items:center;padding:8px 0;margin-top:2px' });
  compSub.appendChild(el('span', { style: 'font-size:12px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:.04em' }, 'Subtotal Company'));
  compSub.appendChild(el('span', { style: 'font-size:14px;font-weight:700;color:var(--text)' }, formatEUR(data.fromCompany)));
  col.appendChild(compSub);

  // ── Personal Properties ─────────────────────────────────────────────────────
  if (data.personalProps.length > 0 || true) {
    col.appendChild(mkSectionLabel('Personal Properties'));
    col.appendChild(makeRow(
      'Rental Income', formatEUR(data.personalIncome),
      data.personalPayments.length > 0 || data.personalProps.length > 0,
      () => showPersonalPropsModal(label, data),
      data.personalProps.length > 0
        ? `${data.personalProps.length} properties · ${data.personalPayments.length} payments`
        : 'No personal-channel properties'
    ));
  }

  // ── Total ───────────────────────────────────────────────────────────────────
  const totalRow = el('div', { style: 'display:flex;justify-content:space-between;align-items:center;padding:10px 0;margin-top:4px;border-top:2px solid rgba(255,255,255,0.1)' });
  totalRow.appendChild(el('span', { style: 'font-size:13px;font-weight:700;color:var(--text)' }, 'Total Gross Income'));
  totalRow.appendChild(el('span', { style: `font-size:16px;font-weight:800;color:${color}` }, formatEUR(data.total)));
  col.appendChild(totalRow);

  return col;
}

// ── Charts ────────────────────────────────────────────────────────────────────
function renderMonthlyBar(youData, ritaData, months) {
  if (!months.length) return;

  const youMonthly  = [];
  const ritaMonthly = [];

  for (const m of months) {
    const mk = m.key;
    // Salary: sum by month
    const youSal = youData.salaryExps
      .filter(e => (e.date || '').slice(0, 7) === mk)
      .reduce((s, e) => s + toEUR(e.amount, e.currency, e.date), 0);
    const ritaSal = ritaData.salaryExps
      .filter(e => (e.date || '').slice(0, 7) === mk)
      .reduce((s, e) => s + toEUR(e.amount, e.currency, e.date), 0);
    // Rent by month
    const youRent  = youData.ownerRentByMonth[mk] || 0;
    const ritaRent = ritaData.ownerRentByMonth[mk] || 0;
    // Reimbs by month
    const youReimb = youData.reimbExps
      .filter(e => (e.date || '').slice(0, 7) === mk)
      .reduce((s, e) => s + toEUR(e.amount, e.currency, e.date), 0);
    const ritaReimb = ritaData.reimbExps
      .filter(e => (e.date || '').slice(0, 7) === mk)
      .reduce((s, e) => s + toEUR(e.amount, e.currency, e.date), 0);
    // Dividends by month
    const youDivs = youData.divRecords
      .filter(d => (d.date || '').slice(0, 7) === mk)
      .reduce((s, d) => s + (d.grossAmount || 0) * (1 - SDC_RATE), 0);
    const ritaDivs = ritaData.divRecords
      .filter(d => (d.date || '').slice(0, 7) === mk)
      .reduce((s, d) => s + (d.grossAmount || 0) * (1 - SDC_RATE), 0);
    // Personal by month
    const youPers = youData.personalPayments
      .filter(p => (p.date || '').slice(0, 7) === mk)
      .reduce((s, p) => s + toEUR(p.amount, p.currency, p.date), 0);
    const ritaPers = ritaData.personalPayments
      .filter(p => (p.date || '').slice(0, 7) === mk)
      .reduce((s, p) => s + toEUR(p.amount, p.currency, p.date), 0);

    youMonthly.push(Math.round(youSal + youRent + youReimb + youDivs + youPers));
    ritaMonthly.push(Math.round(ritaSal + ritaRent + ritaReimb + ritaDivs + ritaPers));
  }

  if (!youMonthly.some(v => v > 0) && !ritaMonthly.some(v => v > 0)) return;

  charts.bar('pi-monthly-bar', {
    labels:   months.map(m => m.label),
    datasets: [
      { label: YOU_LABEL,  data: youMonthly,  backgroundColor: YOU_HEX  },
      { label: RITA_LABEL, data: ritaMonthly, backgroundColor: RITA_HEX }
    ],
    onClickItem: (_, idx) => {
      const m    = months[idx];
      if (!m) return;
      const mk   = m.key;
      const yTot = youMonthly[idx];
      const rTot = ritaMonthly[idx];
      const body = el('div', { style: 'display:flex;flex-direction:column;gap:12px' });
      body.appendChild(mkSummaryGrid([
        { label: YOU_LABEL,  value: formatEUR(yTot) },
        { label: RITA_LABEL, value: formatEUR(rTot) },
        { label: 'Combined', value: formatEUR(yTot + rTot) }
      ], 3));
      openModal({ title: `${m.label} — Income Breakdown`, body, large: true });
    }
  });
}

function renderCompositionDonut(canvasId, data, label, color) {
  const slices = [
    { key: 'salary',   label: 'Salary',          value: data.salary,        color: INCOME_COLORS.salary  },
    { key: 'rent',     label: 'Property Rent',    value: data.ownerRentTotal,color: INCOME_COLORS.rent    },
    { key: 'reimb',    label: 'Reimbursements',   value: data.reimb,         color: INCOME_COLORS.reimb   },
    { key: 'divs',     label: 'Dividends (net)',  value: data.netDivs,       color: INCOME_COLORS.divs    },
    { key: 'personal', label: 'Personal Prop.',   value: data.personalIncome,color: INCOME_COLORS.personal}
  ].filter(s => s.value > 0);

  if (!slices.length) return;

  charts.doughnut(canvasId, {
    labels: slices.map(s => s.label),
    data:   slices.map(s => Math.round(s.value)),
    colors: slices.map(s => s.color),
    onClickItem: (sliceLabel) => {
      const s = slices.find(x => x.label === sliceLabel);
      if (!s) return;
      const body = el('div');
      body.appendChild(mkSummaryGrid([
        { label: sliceLabel,     value: formatEUR(s.value) },
        { label: '% of Total',   value: data.total > 0 ? (s.value / data.total * 100).toFixed(1) + '%' : '—' }
      ], 2));
      openModal({ title: `${label} — ${sliceLabel}`, body, large: false });
    }
  });
}

// ── Rebuild ───────────────────────────────────────────────────────────────────
function rebuildView() {
  CHART_IDS.forEach(id => charts.destroy(id));
  const c = document.getElementById('content');
  if (!c) return;
  c.innerHTML = '';
  c.appendChild(buildView());
}

// ── Main view ─────────────────────────────────────────────────────────────────
function buildView() {
  const wrap = el('div', { class: 'view active' });

  wrap.appendChild(el('div', { style: 'margin-bottom:16px' },
    el('h2', { style: 'margin:0 0 4px;font-size:20px;font-weight:700' }, 'Personal Income'),
    el('p',  { style: 'margin:0;font-size:13px;color:var(--text-muted)' },
      'Salary · Owner rent · Reimbursements · Dividends · Personal properties')
  ));

  wrap.appendChild(buildFilterBar(
    gF,
    { showOwner: false, showStream: false, showProperty: false, storagePrefix: 'ana_personal' },
    (newGF) => { if (newGF) gF = newGF; rebuildView(); }
  ));

  const curRange = getCurrentPeriodRange(gF);
  const cmpRange = getComparisonRange(gF, curRange);
  const { keys: months } = getMonthKeysForRange(curRange.start, curRange.end);
  const { keys: cmpMonths } = cmpRange
    ? getMonthKeysForRange(cmpRange.start, cmpRange.end)
    : { keys: [] };

  const youData  = getPersonData('you',  curRange.start, curRange.end, months);
  const ritaData = getPersonData('rita', curRange.start, curRange.end, months);
  const youCmp   = cmpRange ? getPersonData('you',  cmpRange.start, cmpRange.end, cmpMonths) : null;
  const ritaCmp  = cmpRange ? getPersonData('rita', cmpRange.start, cmpRange.end, cmpMonths) : null;

  const compLine = buildComparisonLine(curRange, cmpRange);
  if (compLine) wrap.appendChild(compLine);

  wrap.appendChild(buildKpiSection(youData, ritaData, youCmp, ritaCmp, cmpRange));

  // ── Person columns ──────────────────────────────────────────────────────────
  const colGrid = el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px' });
  colGrid.appendChild(buildPersonColumn(YOU_LABEL,  YOU_HEX,  youData,  months));
  colGrid.appendChild(buildPersonColumn(RITA_LABEL, RITA_HEX, ritaData, months));
  wrap.appendChild(colGrid);

  // ── Charts ──────────────────────────────────────────────────────────────────
  const chartsRow = el('div', { class: 'grid grid-2 mb-16' });

  // Monthly income trend
  chartsRow.appendChild(el('div', { class: 'card' },
    el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, `Monthly Income — ${curRange.label}`)),
    el('div', { class: 'chart-wrap tall' }, el('canvas', { id: 'pi-monthly-bar' }))
  ));

  // Composition donuts
  const donutCard = el('div', { class: 'card' });
  donutCard.appendChild(el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'Income Composition')));
  const donutRow = el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:0;padding:0 8px 8px' });
  const mkDonutCell = (id, personLabel) => {
    const cell = el('div', { style: 'display:flex;flex-direction:column;align-items:center' });
    cell.appendChild(el('div', { style: 'font-size:11px;font-weight:600;color:var(--text-muted);margin:8px 0 4px;text-transform:uppercase;letter-spacing:.05em' }, personLabel));
    cell.appendChild(el('div', { class: 'chart-wrap', style: 'height:160px;width:100%' }, el('canvas', { id })));
    return cell;
  };
  donutRow.appendChild(mkDonutCell('pi-giorgos-donut', YOU_LABEL));
  donutRow.appendChild(mkDonutCell('pi-rita-donut', RITA_LABEL));
  donutCard.appendChild(donutRow);
  chartsRow.appendChild(donutCard);
  wrap.appendChild(chartsRow);

  // ── Footnote ────────────────────────────────────────────────────────────────
  wrap.appendChild(el('div', { style: 'font-size:11px;color:var(--text-dim);padding:4px 0 16px' },
    'Owner rent is calculated from the Monthly Owner Rent field on each property × months in period. ' +
    'Dividends shown net of SDC (2.65%). Social contributions (GESY) paid by the company are not personal income and are excluded.'
  ));

  setTimeout(() => {
    renderMonthlyBar(youData, ritaData, months);
    renderCompositionDonut('pi-giorgos-donut', youData, YOU_LABEL, YOU_HEX);
    renderCompositionDonut('pi-rita-donut',    ritaData, RITA_LABEL, RITA_HEX);
  }, 0);

  return wrap;
}
