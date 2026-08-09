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
  mkEmptyState, mkKpiCard, mkCmpGrid, mkInsightsBanner, safePct, fmtK
} from './analytics-helpers.js';
import { EXPENSE_CATEGORIES } from '../core/config.js';

// ── Constants ─────────────────────────────────────────────────────────────────
const SDC_RATE  = 0.0265;
const CHART_IDS = ['pi-stream-monthly', 'pi-person-monthly'];
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
let gScope = 'all'; // 'all' | 'company' | 'personal'

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
// Zeroed shape matching getPersonData's return, used when a person can't be
// safely resolved to a people record (see the legacyKey/name resolution below).
function emptyPersonData() {
  return {
    scope: gScope,
    salary: 0, salaryExps: [],
    gesyTotal: 0, gesyExps: [],
    reimb: 0, reimbExps: [],
    strIncomeExps: [], strIncomeTotal: 0,
    piExps: [], piExpTotal: 0,
    ownerRentTotal: 0, ownerRentByMonth: {}, companyProps: [],
    grossDivs: 0, sdcAmount: 0, netDivs: 0, divRecords: [],
    personalIncome: 0, personalPayments: [], personalProps: [], personalByProp: new Map(),
    fromCompany: 0, total: 0
  };
}

function getPersonData(person, start, end, months) {
  const inRange    = d => d && d >= start && d <= end;
  const ownerKeys  = person === 'you' ? ['you', 'both'] : ['rita', 'both'];
  const recipient  = person === 'you' ? 'giorgos' : 'rita';

  // Mirror getPeopleOwners logic exactly: it returns p.legacyKey || p.id as the option value,
  // or falls back to 'you'/'rita' when no people are configured.
  const activePeople = (state.db.people || []).filter(p =>
    !p.deletedAt && p.active !== false && ['partner', 'director'].includes(p.role)
  );
  // Resolve by legacyKey first (authoritative). If nothing matches, do NOT
  // guess by array position — that silently swaps Giorgos's and Rita's income
  // whenever people records exist without legacyKey set. Fall back to a name
  // match instead, and if that's also ambiguous, bail out with an empty
  // result rather than misattributing one partner's income to the other.
  const nameNeedle   = person === 'you' ? 'giorgos' : 'rita';
  const personRecord = activePeople.find(p => p.legacyKey === person) ||
                       activePeople.find(p => (p.name || '').toLowerCase().includes(nameNeedle));
  if (activePeople.length > 0 && !personRecord) {
    console.warn(
      `getPersonData: could not resolve "${person}" to a people record — no legacyKey match and no ` +
      `name containing "${nameNeedle}" among active partner/director records. Returning empty data ` +
      `instead of guessing by array position, to avoid misattributing income between partners.`
    );
    return emptyPersonData();
  }
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
  // Don't exclude currently-sold properties here — that would make the
  // per-month `soldDate` guard below dead code for them, dropping their
  // pre-sale rent from the whole period instead of just the months after
  // the sale. The inner loop already stops counting once soldDate is passed.
  const companyProps = listActive('properties').filter(p =>
    (p.channel === 'company' || !p.channel) &&
    ownerKeys.includes(p.owner || 'both') &&
    (p.ownerRentHistory || []).length > 0
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

  const grossFromCompany = salary + ownerRentTotal + reimb + netDivs + strIncomeTotal + piExpTotal;

  // Scope gate — 'company' shows only business-sourced income, 'personal' only
  // personal-property income, 'all' (default) shows both combined, matching
  // the Revenue dashboard's Scope toggle. Zeroing every field in the excluded
  // group (not just the fromCompany/personalIncome aggregates) keeps every
  // downstream consumer — KPI cards, breakdown tables, monthly charts,
  // insights — automatically consistent without each one re-checking gScope.
  const showCompany  = gScope !== 'personal';
  const showPersonal = gScope !== 'company';

  return {
    scope: gScope,
    salary:      showCompany ? salary : 0,           salaryExps:     showCompany ? salaryExps : [],
    gesyTotal:   showCompany ? gesyTotal : 0,         gesyExps:       showCompany ? gesyExps : [],
    reimb:       showCompany ? reimb : 0,             reimbExps:      showCompany ? reimbExps : [],
    strIncomeExps: showCompany ? strIncomeExps : [],  strIncomeTotal: showCompany ? strIncomeTotal : 0,
    piExps:      showCompany ? piExps : [],           piExpTotal:     showCompany ? piExpTotal : 0,
    ownerRentTotal:   showCompany ? ownerRentTotal : 0,
    ownerRentByMonth: showCompany ? ownerRentByMonth : {},
    companyProps:     showCompany ? companyProps : [],
    grossDivs:   showCompany ? grossDivs : 0,         sdcAmount: showCompany ? sdcAmount : 0,
    netDivs:     showCompany ? netDivs : 0,           divRecords: showCompany ? divRecords : [],
    personalIncome:   showPersonal ? personalIncome : 0,
    personalPayments: showPersonal ? personalPayments : [],
    personalProps:    showPersonal ? personalProps : [],
    personalByProp:   showPersonal ? personalByProp : new Map(),
    fromCompany: showCompany ? grossFromCompany : 0,
    total: (showCompany ? grossFromCompany : 0) + (showPersonal ? personalIncome : 0)
  };
}

// ── KPI section ───────────────────────────────────────────────────────────────
function buildKpiSection(youData, ritaData, youCmp, ritaCmp, cmpRange, months, cmpMonths, isIncomplete) {
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
    onClick: () => showPersonModal(YOU_LABEL, youData),
    explain: {
      title: `Total — ${YOU_LABEL}`, formula: 'From Company + Personal Properties',
      inputs: [
        { label: 'From Company', value: formatEUR(youData.fromCompany) },
        { label: 'Personal Properties', value: formatEUR(youData.personalIncome) }
      ],
      source: 'analytics-personal.js:211 getPersonData() — `total`',
      note: 'Whichever half is excluded by the Scope toggle (Company only / Personal only) contributes 0.'
    }
  }));

  // Rita total
  grid.appendChild(mkKpiCard({
    label: 'Total — ' + RITA_LABEL,
    value: formatEUR(ritaData.total),
    subtitle: `Company: ${formatEUR(ritaData.fromCompany)} · Personal: ${formatEUR(ritaData.personalIncome)}`,
    delta: safePct(ritaData.total, ritaCmp?.total),
    compLabel: cmpRange?.label,
    compValue: ritaCmp ? formatEUR(ritaCmp.total) : undefined,
    onClick: () => showPersonModal(RITA_LABEL, ritaData),
    explain: {
      title: `Total — ${RITA_LABEL}`, formula: 'From Company + Personal Properties',
      inputs: [
        { label: 'From Company', value: formatEUR(ritaData.fromCompany) },
        { label: 'Personal Properties', value: formatEUR(ritaData.personalIncome) }
      ],
      source: 'analytics-personal.js:211 getPersonData() — `total`',
      note: 'Whichever half is excluded by the Scope toggle (Company only / Personal only) contributes 0.'
    }
  }));

  // Combined Gross
  grid.appendChild(mkKpiCard({
    label: 'Combined Gross',
    value: formatEUR(combined),
    subtitle: 'Both directors combined',
    delta: safePct(combined, cmpCombined),
    compLabel: cmpRange?.label,
    compValue: cmpCombined !== null ? formatEUR(cmpCombined) : undefined,
    onClick: () => showCombinedGrossModal(youData, ritaData, youCmp, ritaCmp, cmpRange),
    explain: {
      title: 'Combined Gross', formula: `${YOU_LABEL} Total + ${RITA_LABEL} Total`,
      inputs: [
        { label: YOU_LABEL, value: formatEUR(youData.total) },
        { label: RITA_LABEL, value: formatEUR(ritaData.total) }
      ],
      source: 'analytics-personal.js:217 buildKpiSection() — `combined`'
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
    // A still-accumulating period (YTD, this-month, etc.) shouldn't project a
    // partial month/quarter's data up to a full-year estimate — that reads as
    // "this is what the year will total" when it's really just an average of
    // whatever's happened so far. Only offer the annualised projection for a
    // genuinely fixed/completed range.
    subtitle: (months.length < 12 && !isIncomplete)
      ? `~${formatEUR(avgMonth * 12)} annualised`
      : 'Combined both directors',
    delta: safePct(avgMonth, cmpAvg),
    compLabel: cmpRange?.label,
    compValue: cmpAvg ? formatEUR(cmpAvg) : undefined,
    onClick: () => showAvgMonthModal(youData, ritaData, months),
    explain: {
      title: 'Avg / Month', formula: 'Combined Gross ÷ Number of months in period',
      inputs: [
        { label: 'Combined Gross', value: formatEUR(combined) },
        { label: 'Months', value: String(months.length) }
      ],
      source: 'analytics-personal.js:284 buildKpiSection() — `avgMonth`',
      note: 'The "annualised" subtitle (×12) is only shown for a complete period spanning fewer than 12 months — never for a still-accumulating one like YTD.'
    }
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
    onClick: () => showDivCombinedModal(youData, ritaData),
    explain: {
      title: 'Dividends (Net SDC)', formula: `${YOU_LABEL} Net Dividends + ${RITA_LABEL} Net Dividends`,
      inputs: [
        { label: `${YOU_LABEL} Net`, value: formatEUR(youData.netDivs) },
        { label: `${RITA_LABEL} Net`, value: formatEUR(ritaData.netDivs) }
      ],
      source: 'analytics-personal.js:315 buildKpiSection() — `divsCombined`',
      note: 'Net dividends = gross dividends minus 2.65% SDC (getPersonData():166).'
    }
  }));

  return grid;
}

// ── Person summary modal ──────────────────────────────────────────────────────
function showPersonModal(label, data) {
  const body = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });
  body.appendChild(mkSummaryGrid([
    { label: 'Total Gross',       value: formatEUR(data.total),
      explain: {
        title: 'Total Gross', formula: 'From Company + Personal Properties',
        inputs: [
          { label: 'From Company', value: formatEUR(data.fromCompany) },
          { label: 'Personal Properties', value: formatEUR(data.personalIncome) }
        ],
        source: 'analytics-personal.js:211 getPersonData() — `total`'
      }
    },
    { label: 'From Company',      value: formatEUR(data.fromCompany),
      explain: {
        title: 'From Company', formula: 'Director Salary + Property Rent (Owner) + Reimbursements + STR Income + Other Personal Income + Dividends (net SDC)',
        inputs: [
          { label: 'Director Salary', value: formatEUR(data.salary) },
          { label: 'Property Rent (Owner)', value: formatEUR(data.ownerRentTotal) },
          { label: 'Reimbursements', value: formatEUR(data.reimb) },
          { label: 'STR Income', value: formatEUR(data.strIncomeTotal) },
          { label: 'Other Personal Income', value: formatEUR(data.piExpTotal) },
          { label: 'Dividends (net SDC)', value: formatEUR(data.netDivs) }
        ],
        source: 'analytics-personal.js:183 getPersonData() — `grossFromCompany`',
        note: 'Zeroed out entirely when the Scope toggle is set to "Personal only".'
      }
    },
    { label: 'Personal Properties', value: formatEUR(data.personalIncome),
      explain: {
        title: 'Personal Properties', formula: 'Sum of paid payments on personal-channel properties owned by this person, in the selected period.',
        inputs: [
          { label: 'Payments counted', value: String(data.personalPayments.length) },
          { label: 'Total', value: formatEUR(data.personalIncome) }
        ],
        source: 'analytics-personal.js:181 getPersonData() — `personalIncome`',
        note: 'Zeroed out entirely when the Scope toggle is set to "Company only".'
      }
    }
  ], 3));
  // Grouped into the same two buckets as the summary boxes above (and as
  // buildPersonColumn's "From Company" / "Personal Properties" sections) —
  // a flat list mixing company-sourced and personal-property rows together
  // was the source of "is this business or personal income?" confusion.
  if (data.scope !== 'personal') {
    body.appendChild(mkSectionLabel('From Company'));
    body.appendChild(mkModalTable(
      [
        { label: 'Source', tip: 'Which company-sourced income stream this row represents.' },
        { label: 'Amount', right: true, tip: 'Total for this stream in the selected period, converted to EUR.' },
        { label: 'Notes', right: true, tip: 'Supporting detail — record count, property count, or the gross/SDC breakdown for dividends.' }
      ],
      [
        ['Director Salary',             formatEUR(data.salary),          `${data.salaryExps.length} expense records`],
        ['Property Rent (owner)',        formatEUR(data.ownerRentTotal),  `${data.companyProps.length} company-operated properties`],
        ['Reimbursements',               formatEUR(data.reimb),           `${data.reimbExps.length} records`],
        ['STR Income',                   formatEUR(data.strIncomeTotal),  data.strIncomeExps.length > 0 ? `${data.strIncomeExps.length} STR fee records` : 'None'],
        ['Other Personal Income',        formatEUR(data.piExpTotal),      data.piExps.length > 0 ? `${data.piExps.length} linked expenses` : 'None'],
        ['Dividends (net SDC)',          formatEUR(data.netDivs),         data.grossDivs > 0 ? `Gross ${formatEUR(data.grossDivs)} − SDC ${formatEUR(data.sdcAmount)}` : 'No dividends'],
      ],
      { highlight: 1 }
    ));
  }
  if (data.scope !== 'company') {
    body.appendChild(mkSectionLabel('Personal Properties'));
    body.appendChild(mkModalTable(
      [
        { label: 'Source', tip: 'Personal-channel property income line.' },
        { label: 'Amount', right: true, tip: 'Total personal-property rental income received in the selected period.' },
        { label: 'Notes', right: true, tip: 'Number of paid payments included in this total.' }
      ],
      [['Personal Properties', formatEUR(data.personalIncome), `${data.personalPayments.length} payments`]],
      { highlight: 1 }
    ));
  }
  if (data.gesyTotal > 0) {
    body.appendChild(el('div', { style: 'font-size:11px;color:var(--text-muted);padding:4px 0' },
      `ℹ Social contributions (GESY) paid by company: ${formatEUR(data.gesyTotal)} — employer cost, not personal income`
    ));
  }
  openModal({ title: `${label} — Full Gross Income`, body, large: true });
}

// ── Combined gross drill-down ─────────────────────────────────────────────────
function showCombinedGrossModal(youData, ritaData, youCmp, ritaCmp, cmpRange) {
  const combined    = youData.total + ritaData.total;
  const cmpCombined = youCmp && ritaCmp ? youCmp.total + ritaCmp.total : null;
  const body = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });
  const combinedExplain = {
    title: 'Combined', formula: `${YOU_LABEL} Total Gross + ${RITA_LABEL} Total Gross`,
    inputs: [
      { label: YOU_LABEL, value: formatEUR(youData.total) },
      { label: RITA_LABEL, value: formatEUR(ritaData.total) }
    ],
    source: 'analytics-personal.js:427 showCombinedGrossModal() — `combined`'
  };
  const personTotalExplain = data => ({
    title: 'Total Gross', formula: 'From Company + Personal Properties',
    inputs: [
      { label: 'From Company', value: formatEUR(data.fromCompany) },
      { label: 'Personal Properties', value: formatEUR(data.personalIncome) }
    ],
    source: 'analytics-personal.js:211 getPersonData() — `total`'
  });
  if (youCmp && ritaCmp && cmpRange) {
    body.appendChild(mkCmpGrid([
      { label: YOU_LABEL,  curVal: formatEUR(youData.total),  cmpVal: formatEUR(youCmp.total),  explain: personTotalExplain(youData)  },
      { label: RITA_LABEL, curVal: formatEUR(ritaData.total), cmpVal: formatEUR(ritaCmp.total), explain: personTotalExplain(ritaData) },
      { label: 'Combined', curVal: formatEUR(combined),       cmpVal: formatEUR(cmpCombined),   explain: combinedExplain },
    ], 'Current Period', cmpRange.label));
  } else {
    body.appendChild(mkSummaryGrid([
      { label: YOU_LABEL,  value: formatEUR(youData.total),  sub: null, explain: personTotalExplain(youData) },
      { label: RITA_LABEL, value: formatEUR(ritaData.total), sub: null, explain: personTotalExplain(ritaData) },
      { label: 'Combined', value: formatEUR(combined), explain: combinedExplain }
    ], 3));
  }
  // Grouped Company/Personal, same rationale as showPersonModal above.
  if (youData.scope !== 'personal') {
    body.appendChild(mkSectionLabel('From Company'));
    body.appendChild(mkModalTable(
      [
        { label: 'Source', tip: 'Company-sourced income stream.' },
        { label: YOU_LABEL, right: true, tip: `${YOU_LABEL}'s amount for this stream in the selected period.` },
        { label: RITA_LABEL, right: true, tip: `${RITA_LABEL}'s amount for this stream in the selected period.` },
        { label: 'Combined', right: true, tip: 'Sum of both directors for this stream.' }
      ],
      [
        ['Director Salary',       formatEUR(youData.salary),         formatEUR(ritaData.salary),         formatEUR(youData.salary + ritaData.salary)],
        ['Property Rent (Owner)', formatEUR(youData.ownerRentTotal), formatEUR(ritaData.ownerRentTotal), formatEUR(youData.ownerRentTotal + ritaData.ownerRentTotal)],
        ['Reimbursements',        formatEUR(youData.reimb),          formatEUR(ritaData.reimb),          formatEUR(youData.reimb + ritaData.reimb)],
        ['Dividends (Net SDC)',   formatEUR(youData.netDivs),        formatEUR(ritaData.netDivs),        formatEUR(youData.netDivs + ritaData.netDivs)],
      ],
      { highlight: 3 }
    ));
  }
  if (youData.scope !== 'company') {
    body.appendChild(mkSectionLabel('Personal Properties'));
    body.appendChild(mkModalTable(
      [
        { label: 'Source', tip: 'Personal-channel property income.' },
        { label: YOU_LABEL, right: true, tip: `${YOU_LABEL}'s personal-property income in the selected period.` },
        { label: RITA_LABEL, right: true, tip: `${RITA_LABEL}'s personal-property income in the selected period.` },
        { label: 'Combined', right: true, tip: 'Sum of both directors\' personal-property income.' }
      ],
      [['Personal Properties', formatEUR(youData.personalIncome), formatEUR(ritaData.personalIncome), formatEUR(youData.personalIncome + ritaData.personalIncome)]],
      { highlight: 3 }
    ));
  }
  openModal({ title: 'Combined Gross Income', body, large: true });
}

// ── Avg / Month drill-down ────────────────────────────────────────────────────
function showAvgMonthModal(youData, ritaData, months) {
  const combined = youData.total + ritaData.total;
  const avg      = months.length > 0 ? combined / months.length : 0;
  const body = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });
  body.appendChild(mkSummaryGrid([
    { label: 'Avg / Month',  value: formatEUR(avg),
      explain: {
        title: 'Avg / Month', formula: 'Total Period ÷ Number of months in period',
        inputs: [
          { label: 'Total Period', value: formatEUR(combined) },
          { label: 'Months', value: String(months.length) }
        ],
        source: 'analytics-personal.js:497 showAvgMonthModal() — `avg`'
      }
    },
    { label: 'Total Period', value: formatEUR(combined),
      explain: {
        title: 'Total Period', formula: `${YOU_LABEL} Total Gross + ${RITA_LABEL} Total Gross`,
        inputs: [
          { label: YOU_LABEL, value: formatEUR(youData.total) },
          { label: RITA_LABEL, value: formatEUR(ritaData.total) }
        ],
        source: 'analytics-personal.js:496 showAvgMonthModal() — `combined`'
      }
    },
    { label: 'Months',       value: String(months.length) }
  ], 3));
  if (months.length > 0) {
    body.appendChild(mkSectionLabel('Combined Income by Month'));
    const rows = months.map(m => {
      const mk = m.key;
      const sal = youData.salaryExps.filter(e => (e.date || '').slice(0, 7) === mk).reduce((s, e) => s + toEUR(e.amount, e.currency, e.date), 0)
                + ritaData.salaryExps.filter(e => (e.date || '').slice(0, 7) === mk).reduce((s, e) => s + toEUR(e.amount, e.currency, e.date), 0);
      const rent = (youData.ownerRentByMonth[mk] || 0) + (ritaData.ownerRentByMonth[mk] || 0);
      const reimb = youData.reimbExps.filter(e => (e.date || '').slice(0, 7) === mk).reduce((s, e) => s + toEUR(e.amount, e.currency, e.date), 0)
                  + ritaData.reimbExps.filter(e => (e.date || '').slice(0, 7) === mk).reduce((s, e) => s + toEUR(e.amount, e.currency, e.date), 0);
      const divs = youData.divRecords.filter(d => (d.date || '').slice(0, 7) === mk).reduce((s, d) => s + (d.grossAmount || 0) * (1 - SDC_RATE), 0)
                 + ritaData.divRecords.filter(d => (d.date || '').slice(0, 7) === mk).reduce((s, d) => s + (d.grossAmount || 0) * (1 - SDC_RATE), 0);
      const pers = youData.personalPayments.filter(p => (p.date || '').slice(0, 7) === mk).reduce((s, p) => s + toEUR(p.amount, p.currency, p.date), 0)
                 + ritaData.personalPayments.filter(p => (p.date || '').slice(0, 7) === mk).reduce((s, p) => s + toEUR(p.amount, p.currency, p.date), 0);
      return [m.label, formatEUR(sal + rent + reimb + divs + pers)];
    });
    body.appendChild(mkModalTable(
      [
        { label: 'Month', tip: 'Calendar month within the selected period.' },
        { label: 'Combined Income', right: true, tip: 'Salary + Owner Rent + Reimbursements + Net Dividends + Personal Property income, both directors combined, for that month.' }
      ],
      rows, { highlight: 1 }));
  }
  openModal({ title: 'Average Monthly Income', body, large: true });
}

// ── Recurring income drill-down ───────────────────────────────────────────────
function showRecurringModal(youData, ritaData) {
  const combined     = youData.total + ritaData.total;
  const recurring    = (youData.salary + youData.ownerRentTotal) + (ritaData.salary + ritaData.ownerRentTotal);
  const nonRecurring = combined - recurring;
  const body = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });
  body.appendChild(mkSummaryGrid([
    { label: 'Recurring',     value: formatEUR(recurring),
      explain: {
        title: 'Recurring', formula: '(Director Salary + Property Rent (Owner)), both directors combined',
        inputs: [
          { label: `${YOU_LABEL} Salary`, value: formatEUR(youData.salary) },
          { label: `${YOU_LABEL} Owner Rent`, value: formatEUR(youData.ownerRentTotal) },
          { label: `${RITA_LABEL} Salary`, value: formatEUR(ritaData.salary) },
          { label: `${RITA_LABEL} Owner Rent`, value: formatEUR(ritaData.ownerRentTotal) }
        ],
        source: 'analytics-personal.js:550 showRecurringModal() — `recurring`'
      }
    },
    { label: 'Non-Recurring', value: formatEUR(nonRecurring),
      explain: {
        title: 'Non-Recurring', formula: 'Combined Gross − Recurring',
        inputs: [
          { label: 'Combined Gross', value: formatEUR(combined) },
          { label: 'Recurring', value: formatEUR(recurring) }
        ],
        source: 'analytics-personal.js:551 showRecurringModal() — `nonRecurring`'
      }
    },
    { label: '% Recurring',   value: combined > 0 ? (recurring / combined * 100).toFixed(0) + '%' : '—',
      explain: {
        title: '% Recurring', formula: 'Recurring ÷ Combined Gross × 100',
        inputs: [
          { label: 'Recurring', value: formatEUR(recurring) },
          { label: 'Combined Gross', value: formatEUR(combined) }
        ],
        source: 'analytics-personal.js:576 showRecurringModal()'
      }
    }
  ], 3));
  body.appendChild(mkSectionLabel('Recurring — Salary + Owner Rent'));
  body.appendChild(mkModalTable(
    [
      { label: 'Source', tip: 'Recurring income stream — salary or owner rent.' },
      { label: YOU_LABEL, right: true, tip: `${YOU_LABEL}'s amount for this stream in the selected period.` },
      { label: RITA_LABEL, right: true, tip: `${RITA_LABEL}'s amount for this stream in the selected period.` },
      { label: 'Combined', right: true, tip: 'Sum of both directors for this stream.' }
    ],
    [
      ['Director Salary',       formatEUR(youData.salary),         formatEUR(ritaData.salary),         formatEUR(youData.salary + ritaData.salary)],
      ['Property Rent (Owner)', formatEUR(youData.ownerRentTotal), formatEUR(ritaData.ownerRentTotal), formatEUR(youData.ownerRentTotal + ritaData.ownerRentTotal)],
    ],
    { highlight: 3 }
  ));
  body.appendChild(mkSectionLabel('Non-Recurring — Everything Else'));
  body.appendChild(mkModalTable(
    [
      { label: 'Source', tip: 'Non-recurring / variable income stream.' },
      { label: YOU_LABEL, right: true, tip: `${YOU_LABEL}'s amount for this stream in the selected period.` },
      { label: RITA_LABEL, right: true, tip: `${RITA_LABEL}'s amount for this stream in the selected period.` },
      { label: 'Combined', right: true, tip: 'Sum of both directors for this stream.' }
    ],
    [
      ['Reimbursements',      formatEUR(youData.reimb),          formatEUR(ritaData.reimb),          formatEUR(youData.reimb + ritaData.reimb)],
      ['Dividends (Net SDC)', formatEUR(youData.netDivs),        formatEUR(ritaData.netDivs),        formatEUR(youData.netDivs + ritaData.netDivs)],
      ['Personal Properties', formatEUR(youData.personalIncome), formatEUR(ritaData.personalIncome), formatEUR(youData.personalIncome + ritaData.personalIncome)],
    ],
    { highlight: 3 }
  ));
  openModal({ title: 'Recurring vs Non-Recurring Income', body, large: true });
}

// ── Combined dividends drill-down ─────────────────────────────────────────────
function showDivCombinedModal(youData, ritaData) {
  const grossCombined = youData.grossDivs + ritaData.grossDivs;
  const body = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });
  body.appendChild(mkSummaryGrid([
    { label: 'Gross Combined',    value: formatEUR(grossCombined),
      explain: {
        title: 'Gross Combined', formula: `${YOU_LABEL} Gross Dividends + ${RITA_LABEL} Gross Dividends`,
        inputs: [
          { label: `${YOU_LABEL} Gross`, value: formatEUR(youData.grossDivs) },
          { label: `${RITA_LABEL} Gross`, value: formatEUR(ritaData.grossDivs) }
        ],
        source: 'analytics-personal.js:621 showDivCombinedModal() — `grossCombined`'
      }
    },
    { label: `${YOU_LABEL} Net`,  value: formatEUR(youData.netDivs),
      explain: {
        title: `${YOU_LABEL} Net Dividends`, formula: 'Gross Dividends − SDC (2.65%)',
        inputs: [
          { label: 'Gross Dividends', value: formatEUR(youData.grossDivs) },
          { label: 'SDC', value: formatEUR(youData.sdcAmount) }
        ],
        source: 'analytics-personal.js:166 getPersonData() — `netDivs`'
      }
    },
    { label: `${RITA_LABEL} Net`, value: formatEUR(ritaData.netDivs),
      explain: {
        title: `${RITA_LABEL} Net Dividends`, formula: 'Gross Dividends − SDC (2.65%)',
        inputs: [
          { label: 'Gross Dividends', value: formatEUR(ritaData.grossDivs) },
          { label: 'SDC', value: formatEUR(ritaData.sdcAmount) }
        ],
        source: 'analytics-personal.js:166 getPersonData() — `netDivs`'
      }
    },
    { label: 'SDC Total',         value: formatEUR(youData.sdcAmount + ritaData.sdcAmount),
      explain: {
        title: 'SDC Total', formula: 'Gross Dividends × 2.65% (Special Defence Contribution), both directors combined',
        inputs: [
          { label: `${YOU_LABEL} SDC`, value: formatEUR(youData.sdcAmount) },
          { label: `${RITA_LABEL} SDC`, value: formatEUR(ritaData.sdcAmount) }
        ],
        source: 'analytics-personal.js:165 getPersonData() — `sdcAmount` (SDC_RATE = 0.0265, line 17)'
      }
    },
  ], 4));
  const merged = [
    ...youData.divRecords.map(d => ({ ...d, _label: YOU_LABEL })),
    ...ritaData.divRecords.map(d => ({ ...d, _label: RITA_LABEL })),
  ];
  if (merged.length > 0) {
    const byYear = new Map();
    for (const d of merged) {
      const yr  = (d.date || '').slice(0, 4) || '—';
      const cur = byYear.get(yr) || { gross: 0, count: 0 };
      cur.gross += d.grossAmount || 0;
      cur.count += 1;
      byYear.set(yr, cur);
    }
    if (byYear.size > 1) {
      body.appendChild(mkSectionLabel('By Year'));
      const yearRows = [...byYear.entries()]
        .sort((a, b) => b[0].localeCompare(a[0]))
        .map(([yr, v]) => [yr, String(v.count), formatEUR(v.gross), formatEUR(v.gross * SDC_RATE), formatEUR(v.gross * (1 - SDC_RATE))]);
      body.appendChild(mkModalTable(
        [
          { label: 'Year', tip: 'Calendar year the dividend(s) were declared.' },
          { label: 'Records', right: true, tip: 'Number of dividend records declared that year.' },
          { label: 'Gross', right: true, tip: 'Sum of gross dividend amounts declared that year.' },
          { label: 'SDC', right: true, tip: 'Special Defence Contribution withheld — 2.65% of gross.' },
          { label: 'Net', right: true, tip: 'Gross dividends minus SDC — amount actually received.' }
        ],
        yearRows, { highlight: 4 }));
    }
    body.appendChild(mkSectionLabel('Dividend Records'));
    const rows = merged
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
      .map(d => [
        d.date || '—',
        d._label,
        formatEUR(d.grossAmount || 0),
        formatEUR((d.grossAmount || 0) * SDC_RATE),
        formatEUR((d.grossAmount || 0) * (1 - SDC_RATE)),
      ]);
    body.appendChild(mkModalTable(
      [
        { label: 'Date', tip: 'Date the dividend was declared.' },
        { label: 'Person', right: true, tip: 'Which director this dividend record belongs to.' },
        { label: 'Gross', right: true, tip: 'Gross dividend amount declared.' },
        { label: 'SDC', right: true, tip: 'Special Defence Contribution withheld — 2.65% of gross.' },
        { label: 'Net', right: true, tip: 'Gross dividend minus SDC — amount actually received.' }
      ],
      rows, { highlight: 4 }));
  } else {
    body.appendChild(mkEmptyState('No dividends for this period. Add dividends in the Tax → Dividends tab.'));
  }
  openModal({ title: 'Dividends — Combined', body, large: true });
}

// ── GESY / social contributions drill-down ────────────────────────────────────
function showGesyModal(youData, ritaData) {
  const gesyTotal   = youData.gesyTotal + ritaData.gesyTotal;
  const salaryTotal = youData.salary + ritaData.salary;
  const body = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });
  body.appendChild(mkSummaryGrid([
    { label: 'GESY Total',            value: formatEUR(gesyTotal),
      explain: {
        title: 'GESY Total', formula: 'Sum of "social_contributions" category expenses linked to each director, both directors combined',
        inputs: [
          { label: `${YOU_LABEL} GESY`, value: formatEUR(youData.gesyTotal) },
          { label: `${RITA_LABEL} GESY`, value: formatEUR(ritaData.gesyTotal) }
        ],
        source: 'analytics-personal.js:113 getPersonData() — `gesyTotal`'
      }
    },
    { label: 'Combined Salary',       value: formatEUR(salaryTotal),
      explain: {
        title: 'Combined Salary', formula: `${YOU_LABEL} Salary + ${RITA_LABEL} Salary`,
        inputs: [
          { label: `${YOU_LABEL} Salary`, value: formatEUR(youData.salary) },
          { label: `${RITA_LABEL} Salary`, value: formatEUR(ritaData.salary) }
        ],
        source: 'analytics-personal.js:721 showGesyModal() — `salaryTotal`'
      }
    },
    { label: 'True Employment Cost',  value: formatEUR(salaryTotal + gesyTotal),
      explain: {
        title: 'True Employment Cost', formula: 'Combined Salary + GESY Total',
        inputs: [
          { label: 'Combined Salary', value: formatEUR(salaryTotal) },
          { label: 'GESY Total', value: formatEUR(gesyTotal) }
        ],
        source: 'analytics-personal.js:744 showGesyModal()',
        note: 'GESY is an employer cost, not personal income — this figure exists for context, not to be added into any income total.'
      }
    }
  ], 3));
  const merged = [
    ...youData.gesyExps.map(e => ({ ...e, _label: YOU_LABEL })),
    ...ritaData.gesyExps.map(e => ({ ...e, _label: RITA_LABEL })),
  ];
  if (merged.length > 0) {
    const byPerson = new Map();
    for (const e of merged) {
      const eur = toEUR(e.amount, e.currency, e.date);
      const cur = byPerson.get(e._label) || { total: 0, count: 0 };
      cur.total += eur;
      cur.count += 1;
      byPerson.set(e._label, cur);
    }
    body.appendChild(mkSectionLabel('By Person'));
    const personRows = [...byPerson.entries()]
      .sort((a, b) => b[1].total - a[1].total)
      .map(([p, v]) => [p, String(v.count), formatEUR(v.total)]);
    body.appendChild(mkModalTable(
      [
        { label: 'Person', tip: 'Which director this GESY / social-contribution cost is attributed to.' },
        { label: 'Records', right: true, tip: 'Number of social-contribution expense records for that person.' },
        { label: 'Amount', right: true, tip: 'Total GESY / social contributions paid for that person in the selected period.' }
      ],
      personRows, { highlight: 2 }));

    body.appendChild(mkSectionLabel('Social Contribution Records'));
    const rows = merged
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
      .map(e => [e.date || '—', e._label, formatEUR(toEUR(e.amount, e.currency, e.date)), e.description || '—']);
    body.appendChild(mkModalTable(
      [
        { label: 'Date', tip: 'Expense date.' },
        { label: 'Person', right: true, tip: 'Which director this record is attributed to.' },
        { label: 'Amount (EUR)', right: true, tip: 'Amount converted to EUR at the expense date.' },
        { label: 'Description', right: true, tip: 'Free-text note entered on the expense record.' }
      ],
      rows, { highlight: 2 }));
  } else {
    body.appendChild(mkEmptyState('No GESY / social contribution records this period.'));
  }
  openModal({ title: 'Employer GESY Cost', body, large: true });
}

// ── Salary drill-down ─────────────────────────────────────────────────────────
function showSalaryModal(label, data) {
  const body = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });
  body.appendChild(mkSummaryGrid([
    { label: 'Total Salary',  value: formatEUR(data.salary),
      explain: {
        title: 'Total Salary', formula: 'Sum of expenses with category "salary" linked to this person, dated within the selected period.',
        inputs: [{ label: 'Records', value: String(data.salaryExps.length) }, { label: 'Total', value: formatEUR(data.salary) }],
        source: 'analytics-personal.js:107 getPersonData() — `salary`'
      }
    },
    { label: 'Records',       value: String(data.salaryExps.length) },
    ...(data.gesyTotal > 0 ? [{ label: 'GESY (company cost)', value: formatEUR(data.gesyTotal),
      explain: {
        title: 'GESY (company cost)', formula: 'Sum of expenses with category "social_contributions" linked to this person, in the selected period.',
        inputs: [{ label: 'Total', value: formatEUR(data.gesyTotal) }],
        source: 'analytics-personal.js:113 getPersonData() — `gesyTotal`',
        note: 'Employer cost shown for context — not personal income, not included in Total Salary.'
      }
    }] : [])
  ], 3));
  if (data.salaryExps.length > 0) {
    const byMonth = new Map();
    for (const e of data.salaryExps) {
      const mk  = (e.date || '').slice(0, 7) || '—';
      const cur = byMonth.get(mk) || { total: 0, count: 0 };
      cur.total += toEUR(e.amount, e.currency, e.date);
      cur.count += 1;
      byMonth.set(mk, cur);
    }
    body.appendChild(mkSectionLabel('Salary by Month'));
    const monthRows = [...byMonth.entries()]
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([mk, v]) => [mk, String(v.count), formatEUR(v.total)]);
    body.appendChild(mkModalTable(
      [
        { label: 'Month', tip: 'Calendar month within the selected period.' },
        { label: 'Records', right: true, tip: 'Number of salary expense records in that month.' },
        { label: 'Amount', right: true, tip: 'Total salary paid that month, converted to EUR.' }
      ],
      monthRows, { highlight: 2 }));

    const footer = el('div', { style: 'margin-top:4px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.08);display:flex;justify-content:flex-end' });
    const link = el('a', { style: 'font-size:12px;cursor:pointer;color:var(--accent)' }, 'View all salary records →');
    link.onclick = () => {
      const rows = data.salaryExps
        .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
        .map(e => [e.date || '—', formatEUR(toEUR(e.amount, e.currency, e.date)), e.description || '—']);
      const rawBody = el('div');
      rawBody.appendChild(mkModalTable(
        [
          { label: 'Date', tip: 'Expense date.' },
          { label: 'Amount (EUR)', right: true, tip: 'Amount converted to EUR at the expense date.' },
          { label: 'Description', right: true, tip: 'Free-text note entered on the expense record.' }
        ],
        rows, { highlight: 1 }));
      openModal({ title: `${label} — Salary Records`, body: rawBody, large: true });
    };
    footer.appendChild(link);
    body.appendChild(footer);
  } else {
    body.appendChild(mkEmptyState('No salary records for this period. Add expenses with category "Salary".'));
  }
  openModal({ title: `${label} — Director Salary`, body, large: true });
}

// ── Owner rent drill-down ─────────────────────────────────────────────────────
function showRentModal(label, data, months) {
  const body = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });
  body.appendChild(mkSummaryGrid([
    { label: 'Total Owner Rent', value: formatEUR(data.ownerRentTotal),
      explain: {
        title: 'Total Owner Rent', formula: 'For each month in the period, sum each company property\'s active owner-rent rate (from its rate history) × this director\'s ownership share, then add across all months.',
        inputs: [
          { label: 'Company-operated properties', value: String(data.companyProps.length) },
          { label: 'Months in period', value: String(months.length) },
          { label: 'Total', value: formatEUR(data.ownerRentTotal) }
        ],
        source: 'analytics-personal.js:146 getPersonData() — `ownerRentTotal` (uses rentForMonth() at :32)',
        note: 'A property\'s rent stops counting from its soldDate onward; owner:"both" properties count at a 50% share.'
      }
    },
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
    body.appendChild(mkModalTable(
      [
        { label: 'Property', tip: 'Company-operated property name.' },
        { label: 'City', right: true, tip: 'Property location.' },
        { label: 'Share/Month', right: true, tip: 'Current monthly owner-rent rate applied to this director\'s ownership share.' },
        { label: 'Period Total', right: true, tip: 'This director\'s share of owner rent from this property, summed over the selected period.' }
      ],
      rows, { highlight: 3 }));
    body.appendChild(el('div', { style: 'font-size:11px;color:var(--text-muted)' },
      'Owner rent is calculated from the Owner Rent rate history on each property (rate-per-month aware). ' +
      'To update rent rates, edit each property.'
    ));
  } else {
    body.appendChild(mkEmptyState('No company-operated properties with rent rates configured. Open each property and add rates under "Owner Rent".'));
  }
  openModal({ title: `${label} — Owner Rent Income`, body, large: true });
}

// ── Reimbursements drill-down ─────────────────────────────────────────────────
function showReimbModal(label, data) {
  const body  = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });
  const count = data.reimbExps.length;
  body.appendChild(mkSummaryGrid([
    { label: 'Total Reimbursed', value: formatEUR(data.reimb),
      explain: {
        title: 'Total Reimbursed', formula: 'Sum of expenses with category "reimbursement" linked to this person, dated within the selected period.',
        inputs: [{ label: 'Records', value: String(count) }, { label: 'Total', value: formatEUR(data.reimb) }],
        source: 'analytics-personal.js:119 getPersonData() — `reimb`'
      }
    },
    { label: 'Records',          value: String(count) },
    { label: 'Average',          value: count > 0 ? formatEUR(data.reimb / count) : '—',
      explain: {
        title: 'Average', formula: 'Total Reimbursed ÷ number of reimbursement records',
        inputs: [{ label: 'Total Reimbursed', value: formatEUR(data.reimb) }, { label: 'Records', value: String(count) }],
        source: 'analytics-personal.js:931 showReimbModal()'
      }
    }
  ], 3));
  if (count > 0) {
    body.appendChild(mkSectionLabel('Reimbursement Records'));
    const rows = data.reimbExps
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
      .map(e => [e.date || '—', formatEUR(toEUR(e.amount, e.currency, e.date)), e.description || '—']);
    body.appendChild(mkModalTable(
      [
        { label: 'Date', tip: 'Expense date.' },
        { label: 'Amount (EUR)', right: true, tip: 'Amount converted to EUR at the expense date.' },
        { label: 'Description', right: true, tip: 'Free-text note entered on the expense record.' }
      ],
      rows, { highlight: 1 }));
  } else {
    body.appendChild(mkEmptyState('No reimbursements this period.'));
  }
  openModal({ title: `${label} — Reimbursements`, body, large: true });
}

// ── Dividends drill-down ──────────────────────────────────────────────────────
function showDivModal(label, data) {
  const body = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });
  body.appendChild(mkSummaryGrid([
    { label: 'Gross Dividends', value: formatEUR(data.grossDivs),
      explain: {
        title: 'Gross Dividends', formula: 'Sum of grossAmount across dividend records for this director\'s recipient, dated within the selected period.',
        inputs: [{ label: 'Records', value: String(data.divRecords.length) }, { label: 'Total', value: formatEUR(data.grossDivs) }],
        source: 'analytics-personal.js:164 getPersonData() — `grossDivs`'
      }
    },
    { label: 'SDC (2.65%)',     value: formatEUR(data.sdcAmount),
      explain: {
        title: 'SDC (2.65%)', formula: 'Gross Dividends × 2.65% (Special Defence Contribution)',
        inputs: [{ label: 'Gross Dividends', value: formatEUR(data.grossDivs) }],
        source: 'analytics-personal.js:165 getPersonData() — `sdcAmount` (SDC_RATE = 0.0265, line 17)'
      }
    },
    { label: 'Net Dividends',   value: formatEUR(data.netDivs),
      explain: {
        title: 'Net Dividends', formula: 'Gross Dividends − SDC',
        inputs: [{ label: 'Gross Dividends', value: formatEUR(data.grossDivs) }, { label: 'SDC', value: formatEUR(data.sdcAmount) }],
        source: 'analytics-personal.js:166 getPersonData() — `netDivs`'
      }
    }
  ], 3));
  if (data.divRecords.length > 0) {
    const byYear = new Map();
    for (const d of data.divRecords) {
      const yr  = (d.date || '').slice(0, 4) || '—';
      const cur = byYear.get(yr) || { gross: 0, count: 0 };
      cur.gross += d.grossAmount || 0;
      cur.count += 1;
      byYear.set(yr, cur);
    }
    if (byYear.size > 1) {
      body.appendChild(mkSectionLabel('By Year'));
      const yearRows = [...byYear.entries()]
        .sort((a, b) => b[0].localeCompare(a[0]))
        .map(([yr, v]) => [yr, String(v.count), formatEUR(v.gross), formatEUR(v.gross * SDC_RATE), formatEUR(v.gross * (1 - SDC_RATE))]);
      body.appendChild(mkModalTable(
        [
          { label: 'Year', tip: 'Calendar year the dividend(s) were declared.' },
          { label: 'Records', right: true, tip: 'Number of dividend records declared that year.' },
          { label: 'Gross', right: true, tip: 'Sum of gross dividend amounts declared that year.' },
          { label: 'SDC', right: true, tip: 'Special Defence Contribution withheld — 2.65% of gross.' },
          { label: 'Net', right: true, tip: 'Gross dividends minus SDC — amount actually received.' }
        ],
        yearRows, { highlight: 4 }));
    }
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
    body.appendChild(mkModalTable(
      [
        { label: 'Date', tip: 'Date the dividend was declared.' },
        { label: 'Gross', right: true, tip: 'Gross dividend amount declared.' },
        { label: 'SDC', right: true, tip: 'Special Defence Contribution withheld — 2.65% of gross.' },
        { label: 'Net', right: true, tip: 'Gross dividend minus SDC — amount actually received.' },
        { label: 'Notes', right: true, tip: 'Free-text note entered on the dividend record.' }
      ],
      rows, { highlight: 3 }));
  } else {
    body.appendChild(mkEmptyState('No dividends for this period. Add dividends in the Tax → Dividends tab.'));
  }
  openModal({ title: `${label} — Dividends`, body, large: true });
}

// ── Personal properties drill-down ────────────────────────────────────────────
function showPersonalPropsModal(label, data) {
  const body = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });
  body.appendChild(mkSummaryGrid([
    { label: 'Total Income',  value: formatEUR(data.personalIncome),
      explain: {
        title: 'Total Income', formula: 'Sum of paid payments dated within the selected period, across this director\'s personal-channel properties.',
        inputs: [
          { label: 'Personal-channel properties', value: String(data.personalProps.length) },
          { label: 'Payments counted', value: String(data.personalPayments.length) },
          { label: 'Total', value: formatEUR(data.personalIncome) }
        ],
        source: 'analytics-personal.js:181 getPersonData() — `personalIncome`',
        note: 'Only status:\'paid\' payments on properties with channel:\'personal\' owned by this director count.'
      }
    },
    { label: 'Properties',    value: String(data.personalProps.length) },
    { label: 'Payments',      value: String(data.personalPayments.length) }
  ], 3));
  if (data.personalProps.length > 0) {
    body.appendChild(mkSectionLabel('Income by Property'));
    const rows = data.personalProps
      .map(p => ({ prop: p, income: data.personalByProp.get(p.id) || 0 }))
      .sort((a, b) => b.income - a.income)
      .map(({ prop, income }) => [prop.name, prop.city, prop.country, formatEUR(income)]);
    body.appendChild(mkModalTable(
      [
        { label: 'Property', tip: 'Personal-channel property name.' },
        { label: 'City', right: true, tip: 'Property location.' },
        { label: 'Country', right: true, tip: 'Property location.' },
        { label: 'Income (EUR)', right: true, tip: 'Sum of paid payments for this property in the selected period.' }
      ],
      rows, { highlight: 3 }));
  } else {
    body.appendChild(mkEmptyState('No personal-channel properties. Mark properties as Personal in the Properties form.'));
  }
  openModal({ title: `${label} — Personal Properties`, body, large: true });
}

// ── Combined personal properties drill-down ───────────────────────────────────
function showPersonalPropsCombinedModal(youData, ritaData) {
  const propMap = new Map();
  for (const p of [...youData.personalProps, ...ritaData.personalProps]) propMap.set(p.id, p);
  const merged = {
    personalIncome:   youData.personalIncome + ritaData.personalIncome,
    personalProps:    [...propMap.values()],
    personalPayments: [...youData.personalPayments, ...ritaData.personalPayments],
    personalByProp:   new Map([...youData.personalByProp, ...ritaData.personalByProp]),
  };
  showPersonalPropsModal('Combined', merged);
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
  if (data.scope === 'personal') {
    col.appendChild(el('div', { style: 'font-size:11px;color:var(--text-dim);font-style:italic;padding:2px 0 8px' },
      'Hidden — scope set to Personal only'));
  } else {
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
    () => showReimbModal(label, data),
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
        const body = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });
        const exps = data.strIncomeExps;
        body.appendChild(mkSummaryGrid([
          { label: 'Total STR Income', value: formatEUR(data.strIncomeTotal),
            explain: {
              title: 'Total STR Income', formula: 'Sum of "str_fee" category expenses linked to this person and flagged countsAsPersonalIncome, dated within the selected period.',
              inputs: [{ label: 'Records', value: String(exps.length) }, { label: 'Total', value: formatEUR(data.strIncomeTotal) }],
              source: 'analytics-personal.js:122 getPersonData() — `strIncomeTotal`'
            }
          },
          { label: 'Records',          value: String(exps.length) },
          { label: 'Properties',       value: String(new Set(exps.map(e => e.propertyId).filter(Boolean)).size) }
        ], 3));
        if (exps.length > 0) {
          const byProp = new Map();
          for (const e of exps) {
            const name = byId('properties', e.propertyId)?.name || 'Unassigned';
            const cur  = byProp.get(name) || { total: 0, count: 0 };
            cur.total += toEUR(e.amount, e.currency, e.date);
            cur.count += 1;
            byProp.set(name, cur);
          }
          body.appendChild(mkSectionLabel('STR Income by Property'));
          const propRows = [...byProp.entries()]
            .sort((a, b) => b[1].total - a[1].total)
            .map(([name, v]) => [name, String(v.count), formatEUR(v.total)]);
          body.appendChild(mkModalTable(
            [
              { label: 'Property', tip: 'Property this STR fee income is linked to.' },
              { label: 'Records', right: true, tip: 'Number of STR fee expense records for that property.' },
              { label: 'Amount', right: true, tip: 'Total STR income for that property in the selected period.' }
            ],
            propRows, { highlight: 2 }));

          const footer = el('div', { style: 'margin-top:4px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.08);display:flex;justify-content:flex-end' });
          const link = el('a', { style: 'font-size:12px;cursor:pointer;color:var(--accent)' }, 'View all STR records →');
          link.onclick = () => {
            const rows = exps
              .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
              .map(e => [
                e.date || '—',
                formatEUR(toEUR(e.amount, e.currency, e.date)),
                byId('properties', e.propertyId)?.name || '—',
                e.description || '—'
              ]);
            const rawBody = el('div');
            rawBody.appendChild(mkModalTable(
              [
                { label: 'Date', tip: 'Expense date.' },
                { label: 'Amount (EUR)', right: true, tip: 'Amount converted to EUR at the expense date.' },
                { label: 'Property', right: true, tip: 'Property this STR fee income is linked to.' },
                { label: 'Description', right: true, tip: 'Free-text note entered on the expense record.' }
              ],
              rows, { highlight: 1 }));
            openModal({ title: `${label} — STR Income Records`, body: rawBody, large: true });
          };
          footer.appendChild(link);
          body.appendChild(footer);
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
        const body = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });
        const exps = data.piExps;
        body.appendChild(mkSummaryGrid([
          { label: 'Total',      value: formatEUR(data.piExpTotal),
            explain: {
              title: 'Total', formula: 'Sum of expenses linked to this person, flagged countsAsPersonalIncome, excluding salary/reimbursement/social_contributions/str_fee (counted elsewhere), dated within the selected period.',
              inputs: [{ label: 'Records', value: String(exps.length) }, { label: 'Total', value: formatEUR(data.piExpTotal) }],
              source: 'analytics-personal.js:128 getPersonData() — `piExpTotal`'
            }
          },
          { label: 'Records',    value: String(exps.length) },
          { label: 'Categories', value: String(new Set(exps.map(e => e.category)).size) }
        ], 3));
        if (exps.length > 0) {
          const byCat = new Map();
          for (const e of exps) {
            const cat = EXPENSE_CATEGORIES[e.category]?.label || e.category || '—';
            const cur = byCat.get(cat) || { total: 0, count: 0 };
            cur.total += toEUR(e.amount, e.currency, e.date);
            cur.count += 1;
            byCat.set(cat, cur);
          }
          body.appendChild(mkSectionLabel('By Category'));
          const catRows = [...byCat.entries()]
            .sort((a, b) => b[1].total - a[1].total)
            .map(([cat, v]) => [cat, String(v.count), formatEUR(v.total)]);
          body.appendChild(mkModalTable(
            [
              { label: 'Category', tip: 'Expense category this personal-income record was filed under.' },
              { label: 'Records', right: true, tip: 'Number of expense records in that category.' },
              { label: 'Amount', right: true, tip: 'Total for that category in the selected period.' }
            ],
            catRows, { highlight: 2 }));

          const footer = el('div', { style: 'margin-top:4px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.08);display:flex;justify-content:flex-end' });
          const link = el('a', { style: 'font-size:12px;cursor:pointer;color:var(--accent)' }, 'View all records →');
          link.onclick = () => {
            const rows = exps
              .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
              .map(e => [e.date || '—', formatEUR(toEUR(e.amount, e.currency, e.date)), EXPENSE_CATEGORIES[e.category]?.label || e.category, e.description || '—']);
            const rawBody = el('div');
            rawBody.appendChild(mkModalTable(
              [
                { label: 'Date', tip: 'Expense date.' },
                { label: 'Amount (EUR)', right: true, tip: 'Amount converted to EUR at the expense date.' },
                { label: 'Category', right: true, tip: 'Expense category this record was filed under.' },
                { label: 'Description', right: true, tip: 'Free-text note entered on the expense record.' }
              ],
              rows, { highlight: 1 }));
            openModal({ title: `${label} — Other Personal Income Records`, body: rawBody, large: true });
          };
          footer.appendChild(link);
          body.appendChild(footer);
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
  } // end From Company scope gate

  // ── Personal Properties ─────────────────────────────────────────────────────
  col.appendChild(mkSectionLabel('Personal Properties'));
  if (data.scope === 'company') {
    col.appendChild(el('div', { style: 'font-size:11px;color:var(--text-dim);font-style:italic;padding:2px 0 8px' },
      'Hidden — scope set to Company only'));
  } else {
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
    onClick:  () => showRecurringModal(youData, ritaData)
  });

  // 2. Income balance between partners
  const youShare = youData.total / combined * 100;
  if (youShare > 65 || youShare < 35) {
    signals.push({
      title:    'Partner Income Balance',
      severity: 'Watch',
      text:     `${YOU_LABEL} receives ${youShare.toFixed(0)}% of combined income (${formatEUR(youData.total)}) vs ${RITA_LABEL} at ${(100 - youShare).toFixed(0)}% (${formatEUR(ritaData.total)}). Review if intentional.`,
      onClick:  () => showCombinedGrossModal(youData, ritaData, youCmp, ritaCmp, cmpRange)
    });
  }

  // 3. Dividends context
  if (youData.grossDivs === 0 && ritaData.grossDivs === 0) {
    signals.push({
      title:    'No Dividends',
      severity: 'Note',
      text:     'No dividends declared this period. Dividends (after 2.65% SDC) can be a tax-efficient way to extract company profits when surplus exists.',
      onClick:  () => showDivCombinedModal(youData, ritaData)
    });
  } else {
    const sdcTotal   = youData.sdcAmount + ritaData.sdcAmount;
    const grossTotal = youData.grossDivs + ritaData.grossDivs;
    signals.push({
      title:    'Dividends & SDC',
      severity: 'Note',
      text:     `${formatEUR(grossTotal)} gross dividends paid. SDC withheld: ${formatEUR(sdcTotal)} (2.65%). Net to directors: ${formatEUR(divs)}.`,
      onClick:  () => showDivCombinedModal(youData, ritaData)
    });
  }

  // 4. Personal property income
  if (pers > 0) {
    const persPct = (pers / combined * 100).toFixed(0);
    signals.push({
      title:    'Personal Properties',
      severity: 'Note',
      text:     `Personal-channel properties contribute ${formatEUR(pers)} (${persPct}% of combined income) — ${youData.personalProps.length + ritaData.personalProps.length} properties, ${youData.personalPayments.length + ritaData.personalPayments.length} payments.`,
      onClick:  () => showPersonalPropsCombinedModal(youData, ritaData)
    });
  }

  // 5. GESY context
  const gesyTotal = youData.gesyTotal + ritaData.gesyTotal;
  if (gesyTotal > 0) {
    signals.push({
      title:    'Employer GESY Cost',
      severity: 'Note',
      text:     `Company paid ${formatEUR(gesyTotal)} in GESY / social contributions on top of salaries — the true employment cost is ${formatEUR(salary + gesyTotal)}.`,
      onClick:  () => showGesyModal(youData, ritaData)
    });
  }

  return mkInsightsBanner(signals, 'Income Insights');
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
      [
        { label: 'Stream', tip: 'Income stream for this month.' },
        { label: 'Amount', right: true, tip: 'Combined amount for both directors in this stream, that month.' },
        { label: '% of Month', right: true, muted: true, tip: 'Share of this month\'s combined income coming from this stream.' }
      ],
      items.map(i => [i.label, formatEUR(i.val), total > 0 ? (i.val / total * 100).toFixed(0) + '%' : '—'])
    ));
    body.appendChild(mkSummaryGrid([{ label: 'Total Combined', value: formatEUR(total),
      explain: {
        title: 'Total Combined', formula: 'Director Salary + Owner Rent + Reimbursements + Dividends (Net SDC) + Personal Properties, both directors, for this month.',
        inputs: items.map(i => ({ label: i.label, value: formatEUR(i.val) })),
        source: 'analytics-personal.js:1485 renderStreamMonthly() onClickItem() — `total`'
      }
    }], 1));
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
        { label: YOU_LABEL,  value: formatEUR(yTot),
          explain: {
            title: `${YOU_LABEL} — ${m.label}`, formula: 'Salary + Owner Rent + Reimbursements + Dividends (Net SDC) + Personal Properties for this director, that month.',
            inputs: [{ label: 'Total', value: formatEUR(yTot) }],
            source: 'analytics-personal.js:1562 renderPersonMonthly() — `youMonthly`'
          }
        },
        { label: RITA_LABEL, value: formatEUR(rTot),
          explain: {
            title: `${RITA_LABEL} — ${m.label}`, formula: 'Salary + Owner Rent + Reimbursements + Dividends (Net SDC) + Personal Properties for this director, that month.',
            inputs: [{ label: 'Total', value: formatEUR(rTot) }],
            source: 'analytics-personal.js:1563 renderPersonMonthly() — `ritaMonthly`'
          }
        },
        { label: 'Combined', value: formatEUR(yTot + rTot),
          explain: {
            title: 'Combined', formula: `${YOU_LABEL} + ${RITA_LABEL}, that month.`,
            inputs: [{ label: YOU_LABEL, value: formatEUR(yTot) }, { label: RITA_LABEL, value: formatEUR(rTot) }],
            source: 'analytics-personal.js:1583 renderPersonMonthly() onClickItem()'
          }
        }
      ], 3));
      openModal({ title: `${m.label} — Partner Comparison`, body, large: false });
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

  // Scope toggle (All / Company only / Personal only) — matches the Revenue
  // dashboard's Scope control, letting business-sourced income (salary, owner
  // rent, reimbursements, dividends, flagged STR/other income) be isolated
  // from personal-channel property income, or vice versa.
  const scopeBar = el('div', { style: 'display:flex;align-items:center;gap:8px;margin-bottom:12px' });
  scopeBar.appendChild(el('span', { style: 'font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text-muted)' }, 'Scope'));
  for (const [val, label] of [['all', 'All'], ['company', 'Company only'], ['personal', 'Personal only']]) {
    const isActive = gScope === val;
    const btn = el('button', {
      style: [
        'padding:4px 14px;border-radius:14px;border:1px solid;font-size:12px;cursor:pointer;transition:all 120ms',
        isActive
          ? 'border-color:var(--accent);background:var(--accent);color:#fff;font-weight:600'
          : 'border-color:var(--border);background:transparent;color:var(--text-muted)'
      ].join(';')
    }, label);
    btn.onclick = () => { if (gScope !== val) { gScope = val; rebuildView(); } };
    scopeBar.appendChild(btn);
  }
  wrap.appendChild(scopeBar);

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

  wrap.appendChild(buildKpiSection(youData, ritaData, youCmp, ritaCmp, cmpRange, months, cmpMonths, curRange.isIncomplete));

  // ── Person columns ──────────────────────────────────────────────────────────
  const colGrid = el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px' });
  colGrid.appendChild(buildPersonColumn(YOU_LABEL,  YOU_HEX,  youData,  months, youCmp));
  colGrid.appendChild(buildPersonColumn(RITA_LABEL, RITA_HEX, ritaData, months, ritaCmp));
  wrap.appendChild(colGrid);

  // ── Insights ────────────────────────────────────────────────────────────────
  const insightsEl = buildInsights(youData, ritaData, youCmp, ritaCmp, cmpRange);
  if (insightsEl) wrap.appendChild(insightsEl);

  // ── Charts — Row 1: stacked stream ──────────────────────────────────────────
  // (Composition donuts were dropped here — they just restated percentages
  // already shown as text in each person's column above.)
  const row1 = el('div', { class: 'mb-16' });

  row1.appendChild(el('div', { class: 'card' },
    el('div', { class: 'card-header' }, el('div', { class: 'card-title' }, 'Income by Stream — Monthly')),
    el('div', { class: 'chart-wrap tall' }, el('canvas', { id: 'pi-stream-monthly' }))
  ));
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
  }, 0);

  return wrap;
}
