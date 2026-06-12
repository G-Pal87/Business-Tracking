// Personal Income Dashboard — salary, owner rent, reimbursements, dividends, personal properties
import { el, openModal } from '../core/ui.js';
import * as charts from '../core/charts.js';
import { formatEUR, toEUR, byId, listActive, listActivePayments, getPersonName } from '../core/data.js';
import { state } from '../core/state.js';
import {
  createFilterState, buildFilterBar, buildComparisonLine,
  getCurrentPeriodRange, getComparisonRange, getMonthKeysForRange
} from './analytics-filters.js?v=20260519';
import {
  mkSectionLabel, mkSummaryBox, mkSummaryGrid, mkModalTable, mkVarianceBadge,
  mkEmptyState, mkKpiCard, mkCmpGrid, safePct, fmtK
} from './analytics-helpers.js';
import { EXPENSE_CATEGORIES } from '../core/config.js';

// ── Constants ─────────────────────────────────────────────────────────────────
const SDC_RATE  = 0.0265;
const CHART_IDS = ['pi-stream-monthly', 'pi-person-monthly', 'pi-giorgos-donut', 'pi-rita-donut'];
const YOU_HEX   = '#6366f1';
const RITA_HEX  = '#ec4899';
let YOU_LABEL  = 'Giorgos';
let RITA_LABEL = 'Rita';

const INCOME_COLORS = {
  salary:   '#6366f1',
  rent:     '#14b8a6',
  reimb:    '#f59e0b',
  divs:     '#22c55e',
  personal: '#ec4899'
};

function rentForMonth(history, monthKey) {
  const sorted = [...history].sort((a, b) => a.from.localeCompare(b.from));
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (sorted[i].from.slice(0, 7) <= monthKey) return sorted[i];
  }
  return null;
}

// ── Filter state ──────────────────────────────────────────────────────────────
let gF = createFilterState();

// ── Module export ─────────────────────────────────────────────────────────────
export default {
  id: 'analytics-personal',
  label: 'Personal Income',
  icon: '💼',
  render(container) { container.appendChild(buildView()); },
  refresh() { rebuildView(); },
  destroy() { CHART_IDS.forEach(id => charts.destroy(id)); }
};

// ── Data ──────────────────────────────────────────────────────────────────────
function getPersonData(person, start, end, months) {
  const inRange    = d => d && d >= start && d <= end;
  const ownerKeys  = person === 'you' ? ['you', 'both'] : ['rita', 'both'];
  const recipient  = person === 'you' ? 'giorgos' : 'rita';

  // Mirror getPeopleOwners logic exactly: it returns p.legacyKey || p.id as the option value,
  // or falls back to 'you'/'rita' when no people are configured.
  const activePeople = (state.db.people || []).filter(p =>
    !p.deletedAt && p.active !== false && ['partner', 'director'].includes(p.role)
  );
  const personRecord = activePeople.find(p => p.legacyKey === person) ||
                       activePeople[person === 'you' ? 0 : 1];
  const personId  = personRecord?.id;
  // personKey is the value getPeopleOwners stores as select option value
  const personKey = activePeople.length === 0 ? person : (personRecord?.legacyKey || personRecord?.id || person);
  const matchesPerson = e => e.personId === personKey || e.personId === person || (personId && e.personId === personId);

  // Salary — expenses with category 'salary' linked to this person
  const salaryExps = listActive('expenses').filter(e =>
    e.category === 'salary' && matchesPerson(e) && inRange(e.date)
  );
  const salary = salaryExps.reduce((s, e) => s + toEUR(e.amount, e.currency, e.date), 0);

  // Social contributions (company cost — shown for context)
  const gesyExps = listActive('expenses').filter(e =>
    e.category === 'social_contributions' && matchesPerson(e) && inRange(e.date)
  );
  const gesyTotal = gesyExps.reduce((s, e) => s + toEUR(e.amount, e.currency, e.date), 0);

  // Reimbursements
  const reimbExps = listActive('expenses').filter(e =>
    e.category === 'reimbursement' && matchesPerson(e) && inRange(e.date)
  );
  const reimb = reimbExps.reduce((s, e) => s + toEUR(e.amount, e.currency, e.date), 0);

  // STR Income — str_fee expenses linked to this person and flagged as personal income
  const strIncomeExps = listActive('expenses').filter(e =>
    e.category === 'str_fee' && matchesPerson(e) && e.countsAsPersonalIncome && inRange(e.date)
  );
  const strIncomeTotal = strIncomeExps.reduce((s, e) => s + toEUR(e.amount, e.currency, e.date), 0);

  // Person-linked personal income expenses (any category, countsAsPersonalIncome=true, not already counted above)
  const piExps = listActive('expenses').filter(e =>
    matchesPerson(e) &&
    e.countsAsPersonalIncome &&
    !['salary', 'reimbursement', 'social_contributions', 'str_fee'].includes(e.category) &&
    inRange(e.date)
  );
  const piExpTotal = piExps.reduce((s, e) => s + toEUR(e.amount, e.currency, e.date), 0);

  // Owner rent — derived from ownerRentHistory, rate-per-month aware
  const companyProps = listActive('properties').filter(p =>
    (p.channel === 'company' || !p.channel) &&
    ownerKeys.includes(p.owner || 'both') &&
    (p.ownerRentHistory || []).length > 0 &&
    p.status !== 'sold'
  );
  const ownerRentByMonth = {};
  let ownerRentTotal = 0;
  for (const m of months) {
    const mDate = m.key + '-15';
    let mo = 0;
    for (const prop of companyProps) {
      if (prop.soldDate && prop.soldDate < m.key + '-01') continue;
      const entry = rentForMonth(prop.ownerRentHistory || [], m.key);
      if (!entry) continue;
      const share = prop.owner === 'both' ? 0.5 : 1;
      mo += toEUR(entry.amount || 0, entry.currency || prop.currency || 'EUR', mDate) * share;
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

  const fromCompany = salary + ownerRentTotal + reimb + netDivs + strIncomeTotal + piExpTotal;
  const total = fromCompany + personalIncome;

  return {
    salary, salaryExps,
    gesyTotal, gesyExps,
    reimb, reimbExps,
    strIncomeExps, strIncomeTotal,
    piExps, piExpTotal,
    ownerRentTotal, ownerRentByMonth, companyProps,
    grossDivs, sdcAmount, netDivs, divRecords,
    personalIncome, personalPayments, personalProps, personalByProp,
    fromCompany, total
  };
}

// ── KPI section ───────────────────────────────────────────────────────────────
function buildKpiSection(youData, ritaData, youCmp, ritaCmp, cmpRange, months, cmpMonths) {
  const combined    = youData.total + ritaData.total;
  const cmpCombined = youCmp && ritaCmp ? youCmp.total + ritaCmp.total : null;

  const grid = el('div', {
    style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px;margin-bottom:20px'
  });

  // Giorgos total
  grid.appendChild(mkKpiCard({
    label: 'Total — ' + YOU_LABEL,
    value: formatEUR(youData.total),
    subtitle: `Company: ${formatEUR(youData.fromCompany)} · Personal: ${formatEUR(youData.personalIncome)}`,
    delta: safePct(youData.total, youCmp?.total),
    compLabel: cmpRange?.label,
    compValue: youCmp ? formatEUR(youCmp.total) : undefined,
    onClick: () => showPersonModal(YOU_LABEL, youData)
  }));

  // Rita total
  grid.appendChild(mkKpiCard({
    label: 'Total — ' + RITA_LABEL,
    value: formatEUR(ritaData.total),
    subtitle: `Company: ${formatEUR(ritaData.fromCompany)} · Personal: ${formatEUR(ritaData.personalIncome)}`,
    delta: safePct(ritaData.total, ritaCmp?.total),
    compLabel: cmpRange?.label,
    compValue: ritaCmp ? formatEUR(ritaCmp.total) : undefined,
    onClick: () => showPersonModal(RITA_LABEL, ritaData)
  }));

  // Combined Gross
  grid.appendChild(mkKpiCard({
    label: 'Combined Gross',
    value: formatEUR(combined),
    subtitle: 'Both directors combined',
    delta: safePct(combined, cmpCombined),
    compLabel: cmpRange?.label,
    compValue: cmpCombined !== null ? formatEUR(cmpCombined) : undefined,
    onClick: () => {
      const body = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });
      if (youCmp && ritaCmp && cmpRange) {
        body.appendChild(mkCmpGrid([
          { label: YOU_LABEL,  curVal: formatEUR(youData.total),  cmpVal: formatEUR(youCmp.total)  },
          { label: RITA_LABEL, curVal: formatEUR(ritaData.total), cmpVal: formatEUR(ritaCmp.total) },
          { label: 'Combined', curVal: formatEUR(combined),       cmpVal: formatEUR(cmpCombined)   },
        ], 'Current Period', cmpRange.label));
      } else {
        body.appendChild(mkSummaryGrid([
          { label: YOU_LABEL,  value: formatEUR(youData.total),  sub: null },
          { label: RITA_LABEL, value: formatEUR(ritaData.total), sub: null },
          { label: 'Combined', value: formatEUR(combined) }
        ], 3));
      }
      openModal({ title: 'Combined Gross Income', body, large: true });
    }
  }));

  // Avg / Month with annualised run-rate
  const avgMonth = months.length > 0 ? combined / months.length : 0;
  const cmpAvg   = cmpRange && youCmp && ritaCmp
    ? (youCmp.total + ritaCmp.total) / Math.max(1, cmpMonths.length)
    : null;
  grid.appendChild(mkKpiCard({
    label: 'Avg / Month',
    value: formatEUR(avgMonth),
    subtitle: months.length < 12
      ? `~${formatEUR(avgMonth * 12)} annualised`
      : 'Combined both directors',
    delta: safePct(avgMonth, cmpAvg),
    compLabel: cmpRange?.label,
    compValue: cmpAvg ? formatEUR(cmpAvg) : undefined,
  }));

  // Recurring Income card
  const recurring    = (youData.salary + youData.ownerRentTotal) + (ritaData.salary + ritaData.ownerRentTotal);
  const cmpRecurring = youCmp && ritaCmp
    ? (youCmp.salary + youCmp.ownerRentTotal) + (ritaCmp.salary + ritaCmp.ownerRentTotal)
    : null;
  const recPct = combined > 0 ? (recurring / combined * 100).toFixed(0) + '% of total' : null;
  grid.appendChild(mkKpiCard({
    label: 'Recurring Income',
    value: formatEUR(recurring),
    subtitle: recPct ? `${recPct} · Salary + Owner Rent` : 'Salary + Owner Rent',
    delta: safePct(recurring, cmpRecurring),
    compLabel: cmpRange?.label,
    compValue: cmpRecurring ? formatEUR(cmpRecurring) : undefined,
  }));

  // Dividends (Combined) card
  const divsCombined    = youData.netDivs + ritaData.netDivs;
  const cmpDivsCombined = youCmp && ritaCmp ? youCmp.netDivs + ritaCmp.netDivs : null;
  grid.appendChild(mkKpiCard({
    label: 'Dividends (Net SDC)',
    value: divsCombined > 0 ? formatEUR(divsCombined) : '—',
    subtitle: divsCombined > 0
      ? `Gross ${formatEUR(youData.grossDivs + ritaData.grossDivs)} − SDC ${formatEUR(youData.sdcAmount + ritaData.sdcAmount)}`
      : 'No dividends this period',
    delta: safePct(divsCombined, cmpDivsCombined),
    compLabel: cmpRange?.label,
    compValue: cmpDivsCombined && cmpDivsCombined > 0 ? formatEUR(cmpDivsCombined) : undefined,
    onClick: () => {
      const body = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });
      body.appendChild(mkSummaryGrid([
        { label: `${YOU_LABEL} Net`,  value: formatEUR(youData.netDivs) },
        { label: `${RITA_LABEL} Net`, value: formatEUR(ritaData.netDivs) },
        { label: 'SDC Total',         value: formatEUR(youData.sdcAmount + ritaData.sdcAmount) },
      ], 3));
      openModal({ title: 'Dividends — Combined', body, large: false });
    }
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
      ['Director Salary',             formatEUR(data.salary),          `${data.salaryExps.length} expense records`],
      ['Property Rent (owner)',        formatEUR(data.ownerRentTotal),  `${data.companyProps.length} company-operated properties`],
      ['Reimbursements',               formatEUR(data.reimb),           `${data.reimbExps.length} records`],
      ['STR Income',                   formatEUR(data.strIncomeTotal),  data.strIncomeExps.length > 0 ? `${data.strIncomeExps.length} STR fee records` : 'None'],
      ['Other Personal Income',        formatEUR(data.piExpTotal),      data.piExps.length > 0 ? `${data.piExps.length} linked expenses` : 'None'],
      ['Dividends (net SDC)',          formatEUR(data.netDivs),         data.grossDivs > 0 ? `Gross ${formatEUR(data.grossDivs)} − SDC ${formatEUR(data.sdcAmount)}` : 'No dividends'],
      ['Personal Properties',          formatEUR(data.personalIncome),  `${data.personalPayments.length} payments`],
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
      const share   = p.owner === 'both' ? 0.5 : 1;
      const history = p.ownerRentHistory || [];
      const latest  = [...history].sort((a, b) => a.from.localeCompare(b.from)).pop();
      const curMonthly = latest ? toEUR(latest.amount || 0, latest.currency || p.currency || 'EUR', null) : 0;
      let periodTotal = 0;
      for (const m of months) {
        if (p.soldDate && p.soldDate < m.key + '-01') continue;
        const entry = rentForMonth(history, m.key);
        if (!entry) continue;
        periodTotal += toEUR(entry.amount || 0, entry.currency || p.currency || 'EUR', m.key + '-15') * share;
      }
      return [p.name, p.city, formatEUR(curMonthly * share) + '/mo', formatEUR(periodTotal)];
    });
    body.appendChild(mkModalTable(['Property', 'City', 'Share/Month', 'Period Total'], rows, { highlight: 3 }));
    body.appendChild(el('div', { style: 'font-size:11px;color:var(--text-muted)' },
      'Owner rent is calculated from the Owner Rent rate history on each property (rate-per-month aware). ' +
      'To update rent rates, edit each property.'
    ));
  } else {
    body.appendChild(mkEmptyState('No company-operated properties with rent rates configured. Open each property and add rates under "Owner Rent".'));
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
function buildPersonColumn(label, color, data, months, cmpData) {
  const col = el('div', {
    style: `background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:8px;padding:16px;border-top:3px solid ${color}`
  });
  col.appendChild(el('div', { style: `font-size:14px;font-weight:700;color:${color};margin-bottom:12px;letter-spacing:0.03em` }, label));

  // makeRow — optional cmpNote renders a muted second line on the right side
  const makeRow = (rowLabel, value, clickable, onClick, sub, cmpNote) => {
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

    const rhs = el('div', { style: 'display:flex;flex-direction:column;align-items:flex-end;gap:2px' });
    rhs.appendChild(el('span', { style: 'font-size:13px;font-weight:600;color:var(--text)' }, value));
    if (cmpNote) {
      rhs.appendChild(el('span', { style: 'font-size:10px;color:var(--text-muted)' }, cmpNote));
    }
    item.appendChild(rhs);
    return item;
  };

  // Helper: % of total sub-text
  const pctOf = (val) => data.total > 0 ? `${(val / data.total * 100).toFixed(0)}% of total` : null;

  // ── From Company ────────────────────────────────────────────────────────────
  col.appendChild(mkSectionLabel('From Company'));

  col.appendChild(makeRow(
    'Director Salary', formatEUR(data.salary),
    data.salaryExps.length > 0 || true,
    () => showSalaryModal(label, data),
    [
      data.salaryExps.length > 0 ? `${data.salaryExps.length} records` : 'No records — add salary expenses',
      pctOf(data.salary)
    ].filter(Boolean).join(' · '),
    cmpData ? `${formatEUR(cmpData.salary)} prev` : null
  ));

  col.appendChild(makeRow(
    'Property Rent (Owner)', formatEUR(data.ownerRentTotal),
    true,
    () => showRentModal(label, data, months),
    [
      data.companyProps.length > 0 ? `${data.companyProps.length} properties × ${months.length} months` : 'Configure rent rates on company properties',
      pctOf(data.ownerRentTotal)
    ].filter(Boolean).join(' · '),
    cmpData ? `${formatEUR(cmpData.ownerRentTotal)} prev` : null
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
    [
      data.reimbExps.length > 0 ? `${data.reimbExps.length} records` : null,
      pctOf(data.reimb)
    ].filter(Boolean).join(' · '),
    cmpData ? `${formatEUR(cmpData.reimb)} prev` : null
  ));

  if (data.strIncomeTotal > 0 || data.strIncomeExps.length > 0) {
    col.appendChild(makeRow(
      'STR Income', formatEUR(data.strIncomeTotal),
      data.strIncomeExps.length > 0,
      () => {
        const body = el('div', { style: 'display:flex;flex-direction:column;gap:12px' });
        if (data.strIncomeExps.length > 0) {
          const rows = data.strIncomeExps
            .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
            .map(e => [
              e.date || '—',
              formatEUR(toEUR(e.amount, e.currency, e.date)),
              byId('properties', e.propertyId)?.name || '—',
              e.description || '—'
            ]);
          body.appendChild(mkModalTable(['Date', 'Amount (EUR)', 'Property', 'Description'], rows, { highlight: 1 }));
        } else {
          body.appendChild(mkEmptyState('No STR income records this period.'));
        }
        openModal({ title: `${label} — STR Income`, body, large: true });
      },
      [
        data.strIncomeExps.length > 0 ? `${data.strIncomeExps.length} STR fee record(s)` : 'No STR income yet',
        pctOf(data.strIncomeTotal)
      ].filter(Boolean).join(' · '),
      cmpData ? `${formatEUR(cmpData.strIncomeTotal || 0)} prev` : null
    ));
  }

  if (data.piExpTotal > 0 || data.piExps.length > 0) {
    col.appendChild(makeRow(
      'Other Personal Income', formatEUR(data.piExpTotal),
      data.piExps.length > 0,
      () => {
        const body = el('div', { style: 'display:flex;flex-direction:column;gap:12px' });
        if (data.piExps.length > 0) {
          const rows = data.piExps
            .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
            .map(e => [e.date || '—', formatEUR(toEUR(e.amount, e.currency, e.date)), EXPENSE_CATEGORIES[e.category]?.label || e.category, e.description || '—']);
          body.appendChild(mkModalTable(['Date', 'Amount (EUR)', 'Category', 'Description'], rows, { highlight: 1 }));
        } else {
          body.appendChild(mkEmptyState('No personal income expenses linked to this person.'));
        }
        openModal({ title: `${label} — Other Personal Income`, body, large: true });
      },
      [
        data.piExps.length > 0 ? `${data.piExps.length} linked expense(s)` : 'No linked expenses yet',
        pctOf(data.piExpTotal)
      ].filter(Boolean).join(' · '),
      cmpData ? `${formatEUR(cmpData.piExpTotal || 0)} prev` : null
    ));
  }

  col.appendChild(makeRow(
    'Dividends (net SDC)', formatEUR(data.netDivs),
    data.divRecords.length > 0,
    () => showDivModal(label, data),
    [
      data.grossDivs > 0
        ? `Gross ${formatEUR(data.grossDivs)} − SDC ${formatEUR(data.sdcAmount)}`
        : 'No dividends this period',
      pctOf(data.netDivs)
    ].filter(Boolean).join(' · '),
    cmpData ? `${formatEUR(cmpData.netDivs)} prev` : null
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
      [
        data.personalProps.length > 0
          ? `${data.personalProps.length} properties · ${data.personalPayments.length} payments`
          : 'No personal-channel properties',
        pctOf(data.personalIncome)
      ].filter(Boolean).join(' · '),
      cmpData ? `${formatEUR(cmpData.personalIncome)} prev` : null
    ));
  }

  // ── Total ───────────────────────────────────────────────────────────────────
  const totalRow = el('div', { style: 'display:flex;justify-content:space-between;align-items:center;padding:10px 0;margin-top:4px;border-top:2px solid rgba(255,255,255,0.1)' });
  totalRow.appendChild(el('span', { style: 'font-size:13px;font-weight:700;color:var(--text)' }, 'Total Gross Income'));
  totalRow.appendChild(el('span', { style: `font-size:16px;font-weight:800;color:${color}` }, formatEUR(data.total)));
  col.appendChild(totalRow);

  return col;
}

// ── Insights ──────────────────────────────────────────────────────────────────
function buildInsights(youData, ritaData, youCmp, ritaCmp, cmpRange) {
  const combined = youData.total + ritaData.total;
  if (combined === 0) return null;

  const salary    = youData.salary + ritaData.salary;
  const rent      = youData.ownerRentTotal + ritaData.ownerRentTotal;
  const divs      = youData.netDivs + ritaData.netDivs;
  const pers      = youData.personalIncome + ritaData.personalIncome;
  const recurring = salary + rent;
  const recPct    = combined > 0 ? recurring / combined * 100 : 0;

  const signals = [];

  // 1. Income stability
  signals.push({
    title:    'Income Stability',
    severity: recPct >= 70 ? 'Note' : 'Watch',
    text:     `${recPct.toFixed(0)}% of combined income is recurring (salary + owner rent = ${formatEUR(recurring)}). ` +
              (recPct >= 70 ? 'Good stability — most income is predictable.' : 'Consider increasing recurring income streams.'),
  });

  // 2. Income balance between partners
  const youShare = youData.total / combined * 100;
  if (youShare > 65 || youShare < 35) {
    signals.push({
      title:    'Partner Income Balance',
      severity: 'Watch',
      text:     `${YOU_LABEL} receives ${youShare.toFixed(0)}% of combined income (${formatEUR(youData.total)}) vs ${RITA_LABEL} at ${(100 - youShare).toFixed(0)}% (${formatEUR(ritaData.total)}). Review if intentional.`,
    });
  }

  // 3. Dividends context
  if (youData.grossDivs === 0 && ritaData.grossDivs === 0) {
    signals.push({
      title:    'No Dividends',
      severity: 'Note',
      text:     'No dividends declared this period. Dividends (after 2.65% SDC) can be a tax-efficient way to extract company profits when surplus exists.',
    });
  } else {
    const sdcTotal   = youData.sdcAmount + ritaData.sdcAmount;
    const grossTotal = youData.grossDivs + ritaData.grossDivs;
    signals.push({
      title:    'Dividends & SDC',
      severity: 'Note',
      text:     `${formatEUR(grossTotal)} gross dividends paid. SDC withheld: ${formatEUR(sdcTotal)} (2.65%). Net to directors: ${formatEUR(divs)}.`,
    });
  }

  // 4. Personal property income
  if (pers > 0) {
    const persPct = (pers / combined * 100).toFixed(0);
    signals.push({
      title:    'Personal Properties',
      severity: 'Note',
      text:     `Personal-channel properties contribute ${formatEUR(pers)} (${persPct}% of combined income) — ${youData.personalProps.length + ritaData.personalProps.length} properties, ${youData.personalPayments.length + ritaData.personalPayments.length} payments.`,
    });
  }

  // 5. GESY context
  const gesyTotal = youData.gesyTotal + ritaData.gesyTotal;
  if (gesyTotal > 0) {
    signals.push({
      title:    'Employer GESY Cost',
      severity: 'Note',
      text:     `Company paid ${formatEUR(gesyTotal)} in GESY / social contributions on top of salaries — the true employment cost is ${formatEUR(salary + gesyTotal)}.`,
    });
  }

  // Render using analytics-helpers mkInsightsBanner pattern
  const SEV_COLOR = { 'At Risk': '#ef4444', 'Watch': '#f59e0b', 'Note': '#6366f1' };
  const SEV_BG    = { 'At Risk': 'rgba(239,68,68,0.06)', 'Watch': 'rgba(245,158,11,0.06)', 'Note': 'rgba(99,102,241,0.06)' };

  const card = el('div', { class: 'card mb-16' });
  card.appendChild(el('div', { class: 'card-header' },
    el('div', { class: 'card-title' }, 'Income Insights')
  ));
  const grid = el('div', { style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px;padding:16px' });
  for (const sig of signals) {
    const color = SEV_COLOR[sig.severity] || SEV_COLOR['Note'];
    const bg    = SEV_BG[sig.severity]    || SEV_BG['Note'];
    const block = el('div', {
      style: `background:${bg};border-left:3px solid ${color};border-radius:0 var(--radius-sm) var(--radius-sm) 0;padding:12px 14px`
    });
    const titleRow = el('div', { style: 'display:flex;align-items:center;justify-content:space-between;margin-bottom:6px' });
    titleRow.appendChild(el('span', { style: `font-size:11px;font-weight:700;letter-spacing:0.5px;color:${color}` }, sig.title));
    titleRow.appendChild(el('span', { style: `font-size:10px;font-weight:600;padding:2px 6px;border-radius:3px;background:${color};color:#fff` }, sig.severity));
    block.appendChild(titleRow);
    block.appendChild(el('p', { style: 'margin:0;font-size:12px;color:var(--text);line-height:1.4' }, sig.text));
    grid.appendChild(block);
  }
  card.appendChild(grid);
  return card;
}

// ── Charts ────────────────────────────────────────────────────────────────────

// Stacked-by-stream monthly chart
function renderStreamMonthly(youData, ritaData, months) {
  if (!months.length) return;

  const salaryData = [], rentData = [], reimbData = [], divsData = [], persData = [];

  for (const m of months) {
    const mk = m.key;

    const sal = youData.salaryExps.filter(e => (e.date || '').slice(0, 7) === mk)
                  .reduce((s, e) => s + toEUR(e.amount, e.currency, e.date), 0)
              + ritaData.salaryExps.filter(e => (e.date || '').slice(0, 7) === mk)
                  .reduce((s, e) => s + toEUR(e.amount, e.currency, e.date), 0);

    const rent = (youData.ownerRentByMonth[mk] || 0) + (ritaData.ownerRentByMonth[mk] || 0);

    const reimb = youData.reimbExps.filter(e => (e.date || '').slice(0, 7) === mk)
                    .reduce((s, e) => s + toEUR(e.amount, e.currency, e.date), 0)
                + ritaData.reimbExps.filter(e => (e.date || '').slice(0, 7) === mk)
                    .reduce((s, e) => s + toEUR(e.amount, e.currency, e.date), 0);

    const divs = youData.divRecords.filter(d => (d.date || '').slice(0, 7) === mk)
                   .reduce((s, d) => s + (d.grossAmount || 0) * (1 - SDC_RATE), 0)
               + ritaData.divRecords.filter(d => (d.date || '').slice(0, 7) === mk)
                   .reduce((s, d) => s + (d.grossAmount || 0) * (1 - SDC_RATE), 0);

    const pers = youData.personalPayments.filter(p => (p.date || '').slice(0, 7) === mk)
                   .reduce((s, p) => s + toEUR(p.amount, p.currency, p.date), 0)
               + ritaData.personalPayments.filter(p => (p.date || '').slice(0, 7) === mk)
                   .reduce((s, p) => s + toEUR(p.amount, p.currency, p.date), 0);

    salaryData.push(Math.round(sal));
    rentData.push(Math.round(rent));
    reimbData.push(Math.round(reimb));
    divsData.push(Math.round(divs));
    persData.push(Math.round(pers));
  }

  const hasData = [...salaryData, ...rentData, ...reimbData, ...divsData, ...persData].some(v => v > 0);
  if (!hasData) return;

  const onClickItem = (_, idx) => {
    const m = months[idx];
    if (!m) return;
    const items = [
      { label: 'Director Salary',     val: salaryData[idx] },
      { label: 'Owner Rent',          val: rentData[idx]   },
      { label: 'Reimbursements',      val: reimbData[idx]  },
      { label: 'Dividends (Net SDC)', val: divsData[idx]   },
      { label: 'Personal Properties', val: persData[idx]   },
    ].filter(i => i.val > 0);
    const total = items.reduce((s, i) => s + i.val, 0);
    const body = el('div', { style: 'display:flex;flex-direction:column;gap:12px' });
    body.appendChild(mkSectionLabel('Income by Stream'));
    body.appendChild(mkModalTable(
      [{ label: 'Stream' }, { label: 'Amount', right: true }, { label: '% of Month', right: true, muted: true }],
      items.map(i => [i.label, formatEUR(i.val), total > 0 ? (i.val / total * 100).toFixed(0) + '%' : '—'])
    ));
    body.appendChild(mkSummaryGrid([{ label: 'Total Combined', value: formatEUR(total) }], 1));
    openModal({ title: `${m.label} — Income Breakdown`, body, large: false });
  };

  const datasets = [];
  if (salaryData.some(v => v > 0)) datasets.push({ label: 'Salary',         data: salaryData, backgroundColor: INCOME_COLORS.salary   });
  if (rentData.some(v => v > 0))   datasets.push({ label: 'Owner Rent',     data: rentData,   backgroundColor: INCOME_COLORS.rent     });
  if (reimbData.some(v => v > 0))  datasets.push({ label: 'Reimbursements', data: reimbData,  backgroundColor: INCOME_COLORS.reimb    });
  if (divsData.some(v => v > 0))   datasets.push({ label: 'Dividends',      data: divsData,   backgroundColor: INCOME_COLORS.divs     });
  if (persData.some(v => v > 0))   datasets.push({ label: 'Personal Props', data: persData,   backgroundColor: INCOME_COLORS.personal });

  charts.bar('pi-stream-monthly', {
    labels: months.map(m => m.label),
    datasets,
    stacked: true,
    onClickItem,
  });
}

// Giorgos vs Rita monthly comparison chart
function renderPersonMonthly(youData, ritaData, months) {
  if (!months.length) return;

  const youMonthly  = [];
  const ritaMonthly = [];

  for (const m of months) {
    const mk = m.key;

    const youSal = youData.salaryExps
      .filter(e => (e.date || '').slice(0, 7) === mk)
      .reduce((s, e) => s + toEUR(e.amount, e.currency, e.date), 0);
    const ritaSal = ritaData.salaryExps
      .filter(e => (e.date || '').slice(0, 7) === mk)
      .reduce((s, e) => s + toEUR(e.amount, e.currency, e.date), 0);

    const youRent  = youData.ownerRentByMonth[mk] || 0;
    const ritaRent = ritaData.ownerRentByMonth[mk] || 0;

    const youReimb = youData.reimbExps
      .filter(e => (e.date || '').slice(0, 7) === mk)
      .reduce((s, e) => s + toEUR(e.amount, e.currency, e.date), 0);
    const ritaReimb = ritaData.reimbExps
      .filter(e => (e.date || '').slice(0, 7) === mk)
      .reduce((s, e) => s + toEUR(e.amount, e.currency, e.date), 0);

    const youDivs = youData.divRecords
      .filter(d => (d.date || '').slice(0, 7) === mk)
      .reduce((s, d) => s + (d.grossAmount || 0) * (1 - SDC_RATE), 0);
    const ritaDivs = ritaData.divRecords
      .filter(d => (d.date || '').slice(0, 7) === mk)
      .reduce((s, d) => s + (d.grossAmount || 0) * (1 - SDC_RATE), 0);

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

  charts.bar('pi-person-monthly', {
    labels:   months.map(m => m.label),
    datasets: [
      { label: YOU_LABEL,  data: youMonthly,  backgroundColor: YOU_HEX  },
      { label: RITA_LABEL, data: ritaMonthly, backgroundColor: RITA_HEX }
    ],
    onClickItem: (_, idx) => {
      const m    = months[idx];
      if (!m) return;
      const yTot = youMonthly[idx];
      const rTot = ritaMonthly[idx];
      const body = el('div', { style: 'display:flex;flex-direction:column;gap:12px' });
      body.appendChild(mkSummaryGrid([
        { label: YOU_LABEL,  value: formatEUR(yTot) },
        { label: RITA_LABEL, value: formatEUR(rTot) },
        { label: 'Combined', value: formatEUR(yTot + rTot) }
      ], 3));
      openModal({ title: `${m.label} — Partner Comparison`, body, large: false });
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
  YOU_LABEL  = getPersonName('you');
  RITA_LABEL = getPersonName('rita');

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

  wrap.appendChild(buildKpiSection(youData, ritaData, youCmp, ritaCmp, cmpRange, months, cmpMonths));

  // ── Person columns ──────────────────────────────────────────────────────────
  const colGrid = el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px' });
  colGrid.appendChild(buildPersonColumn(YOU_LABEL,  YOU_HEX,  youData,  months, youCmp));
  colGrid.appendChild(buildPersonColumn(RITA_LABEL, RITA_HEX, ritaData, months, ritaCmp));
  wrap.appendChild(colGrid);

  // ── Insights ────────────────────────────────────────────────────────────────
  const insightsEl = buildInsights(youData, ritaData, youCmp, ritaCmp, cmpRange);
  if (insightsEl) wrap.appendChild(insightsEl);

  // ── Charts — Row 1: stacked stream + donuts ─────────────────────────────────
  const row1 = el('div', { class: 'grid grid-2 mb-16' });

  row1.appendChild(el('div', { class: 'card' },
    el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'Income by Stream — Monthly')),
    el('div', { class: 'chart-wrap tall' }, el('canvas', { id: 'pi-stream-monthly' }))
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
  row1.appendChild(donutCard);
  wrap.appendChild(row1);

  // ── Charts — Row 2: partner comparison (full width) ─────────────────────────
  const row2 = el('div', { class: 'mb-16' });
  row2.appendChild(el('div', { class: 'card' },
    el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'Partner Comparison — Monthly')),
    el('div', { class: 'chart-wrap tall' }, el('canvas', { id: 'pi-person-monthly' }))
  ));
  wrap.appendChild(row2);

  // ── Footnote ────────────────────────────────────────────────────────────────
  wrap.appendChild(el('div', { style: 'font-size:11px;color:var(--text-dim);padding:4px 0 16px' },
    'Owner rent is calculated from the Owner Rent rate history on each property (rate-per-month aware). ' +
    'Dividends shown net of SDC (2.65%). Social contributions (GESY) paid by the company are not personal income and are excluded.'
  ));

  setTimeout(() => {
    renderStreamMonthly(youData, ritaData, months);
    renderPersonMonthly(youData, ritaData, months);
    renderCompositionDonut('pi-giorgos-donut', youData, YOU_LABEL, YOU_HEX);
    renderCompositionDonut('pi-rita-donut',    ritaData, RITA_LABEL, RITA_HEX);
  }, 0);

  return wrap;
}
