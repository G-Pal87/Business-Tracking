// Reconciliation – best-in-class heatmap dashboard
import { el, fmtDate, drillDownModal, escapeHtml, openModal } from '../core/ui.js';
import { availableYears, formatEUR, buildReconciliationData, listActivePayments, listActive, toEUR, getPersonName, byId, companyPropIds, isCompanyRecord } from '../core/data.js';
import { mkSectionLabel, mkSummaryGrid, mkModalTable, groupByMonthKey, mkTh, mkExplainButton } from './analytics-helpers.js';

export default {
  id: 'reconciliation',
  label: 'Reconciliation',
  icon: '⚖️',
  render(container) { container.appendChild(build()); },
  refresh() { const c = document.getElementById('content'); c.innerHTML = ''; c.appendChild(build()); },
  destroy() {}
};

const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// Same owner/scope matching buildReconciliationData applies when computing
// the aggregate totals — needed here too so a service entity's drill-down
// modal lists exactly the invoices its heatmap cell/row total already counted,
// not every invoice for that stream regardless of the active Owner/Scope filter.
function matchInvOwner(inv) {
  if (!_recOwner) return true;
  let ow = inv.owner;
  if (!ow && inv.clientId) ow = byId('clients', inv.clientId)?.owner;
  ow = ow || 'both';
  return ow === 'both' || ow === _recOwner;
}
function matchInvScope(inv) {
  if (_recScope !== 'company') return true;
  return isCompanyRecord(inv, companyPropIds());
}

// Filter selections persisted at module scope so they survive refresh()/
// re-navigation — build() otherwise recreates yearSel/kindFilter/statusFilter
// from scratch on every visit, silently resetting them to today's defaults.
let _recYear   = null; // null = not yet chosen; falls back to curYear
let _recKind   = 'all';
let _recStatus = 'all';
let _recOwner  = ''; // '' = all owners | 'you' | 'rita'
// Defaults to 'all' (not 'company', unlike every other dashboard's scope
// toggle) so migrating this page onto the shared Owner/Scope conventions
// doesn't silently hide personal-channel properties someone is already
// relying on seeing here — 'all' matches this page's original, unscoped
// behaviour before the toggle existed.
let _recScope  = 'all';

const REC_COLS = [
  { key: 'date',   label: 'Date',   format: v => fmtDate(v), tip: 'Payment date or invoice issue date.' },
  { key: 'entity', label: 'Entity', tip: 'Property or service stream this record belongs to.' },
  { key: 'ref',    label: 'Ref', tip: "Payment confirmation code/type, or invoice number." },
  { key: 'status', label: 'Status', tip: 'Record status (e.g. paid, pending, overdue, draft).' },
  { key: 'eur',    label: 'EUR', right: true, format: v => formatEUR(v), tip: 'Amount converted to EUR at the record\'s date.' }
];

const payRow = (p, name) => ({ date: p.date,      entity: name, ref: p.confirmationCode || p.type || '', status: p.status, eur: toEUR(p.amount, p.currency, p.date) });
const invRow = (i, name) => ({ date: i.issueDate, entity: name, ref: i.number || '',                    status: i.status, eur: toEUR(i.total,  i.currency, i.issueDate) });
const byDate = rows => [...rows].sort((a, b) => (b.date || '').localeCompare(a.date || ''));

// statusBreakdown(rows, amountOf) — groups raw records by their `status` field
// for the small aggregated tables in cell-level modals below.
function statusBreakdown(rows, amountOf) {
  const map = new Map();
  for (const r of rows) {
    const st  = r.status || '—';
    const cur = map.get(st) || { count: 0, total: 0 };
    cur.count++; cur.total += amountOf(r);
    map.set(st, cur);
  }
  return [...map.entries()].sort((a, b) => b[1].total - a[1].total);
}

// appendRawLinkFooter(body, count, onClick) — secondary link that reopens the
// full raw drillDownModal list, same convention as Properties' "View all
// transactions →" footer, so demoting a modal to an aggregated view never
// drops the underlying record list, just moves it one click away.
function appendRawLinkFooter(body, count, onClick) {
  const footer = el('div', { style: 'margin-top:16px;padding-top:12px;border-top:1px solid rgba(255,255,255,0.08);display:flex;justify-content:space-between;align-items:center' });
  footer.appendChild(el('div', { style: 'font-size:12px;color:var(--text-muted)' }, `${count} record${count === 1 ? '' : 's'}`));
  const link = el('a', { style: 'font-size:12px;cursor:pointer;color:var(--accent)' }, 'View all transactions →');
  link.onclick = onClick;
  footer.appendChild(link);
  body.appendChild(footer);
}

function monthRange(mk) {
  const yr = Number(mk.slice(0, 4)), mo = Number(mk.slice(5, 7));
  return { start: `${mk}-01`, end: `${mk}-${new Date(yr, mo, 0).getDate().toString().padStart(2, '0')}` };
}

function cellStatus(m) {
  if (m.expected === 0 && m.actual === 0) return 'none';
  if (!m.isPast && m.expected > 0) return 'upcoming';
  if (!m.isPast) return 'bonus';
  if (m.expected === 0 && m.actual > 0) return 'bonus';
  if (m.actual >= m.expected) return 'reconciled';
  if (m.actual > 0) return 'partial';
  return 'missing';
}

const CELL_BG = {
  none:       'rgba(0,0,0,0.02)',
  upcoming:   'rgba(99,102,241,0.12)',
  reconciled: 'rgba(16,185,129,0.18)',
  partial:    'rgba(245,158,11,0.22)',
  missing:    'rgba(239,68,68,0.20)',
  bonus:      'rgba(16,185,129,0.18)',
};
const CELL_COLOR = {
  none:       '#94a3b8',
  upcoming:   '#6366f1',
  reconciled: '#059669',
  partial:    '#d97706',
  missing:    '#dc2626',
  bonus:      '#059669',
};

function cellLabel(m, st) {
  if (st === 'none')     return '';
  if (st === 'upcoming') return m.expected > 0 ? '↑' : '+';
  if (m.expected === 0)  return '+';
  return `${Math.round((m.actual / m.expected) * 100)}%`;
}

function rate(act, exp) {
  return exp > 0 ? Math.round((act / exp) * 100) : (act > 0 ? 100 : null);
}

// ── Explain builders — "how is this calculated" payloads for mkSummaryGrid ──
// Expected/Received/Outstanding are computed differently per entity kind (see
// buildReconciliationData in core/data.js: LT rent comes from the active
// lease, STR expected is every payment on the books that month regardless of
// status, both LT and STR actual/received are status:'paid' only, and
// Services expected is invoiced (non-draft) totals). These builders mirror
// that logic per call site instead of guessing a single generic formula.

function monthExpectedExplain(ent, m) {
  if (ent.kind === 'lt') {
    return {
      title: 'Expected — LT Rent',
      formula: "Monthly rent (EUR) of whichever tenant's lease is active this month; 0 if no lease covers it.",
      inputs: [{ label: 'Expected (EUR)', value: formatEUR(m.expected) }],
      source: 'core/data.js:854-861 buildReconciliationData()',
      note: 'Long-term Expected comes from the active lease’s monthlyRent, not from payments received — a bonus/extra payment this month won’t raise it.'
    };
  }
  if (ent.kind === 'service') {
    return {
      title: 'Expected — Invoiced',
      formula: 'Sum of invoice totals (EUR) issued this month (drafts excluded).',
      inputs: [{ label: 'Expected (EUR)', value: formatEUR(m.expected) }],
      source: 'core/data.js:895-896 buildReconciliationData()',
      note: 'Expected here means "invoiced this month", regardless of whether the invoice has since been paid.'
    };
  }
  return {
    title: 'Expected — ST Rent',
    formula: 'Sum of every payment dated this month, of any status.',
    inputs: [{ label: 'Expected (EUR)', value: formatEUR(m.expected) }],
    source: 'core/data.js:866-867 buildReconciliationData()',
    note: 'Short-term Expected is derived from payment records already on the books for the month (any status), unlike LT rent which uses a fixed lease amount.'
  };
}

function monthActualExplain(ent, m) {
  return {
    title: 'Received — Actual',
    formula: ent.kind === 'service'
      ? "Sum of invoice totals (EUR) with status 'paid', issued this month."
      : "Sum of payment amounts (EUR) with status 'paid', dated this month.",
    inputs: [{ label: 'Received (EUR)', value: formatEUR(m.actual) }],
    source: ent.kind === 'service' ? 'core/data.js:897 buildReconciliationData()'
          : ent.kind === 'lt'      ? 'core/data.js:862-864 buildReconciliationData()'
          :                          'core/data.js:868 buildReconciliationData()',
    note: 'Only status:\'paid\' records count as Received — pending/overdue amounts show up in Expected/Outstanding instead, never here.'
  };
}

function entityExpectedExplain(ent) {
  const per = ent.kind === 'lt'      ? "each month's active-lease monthly rent (EUR)"
            : ent.kind === 'service' ? "each month's invoiced totals (EUR, drafts excluded)"
            :                          "each month's payments (EUR, any status)";
  return {
    title: 'Expected (Year Total)',
    formula: `Sum of ${per} across all 12 months.`,
    inputs: [{ label: 'Total Expected (EUR)', value: formatEUR(ent.totExp) }],
    source: ent.kind === 'service' ? 'core/data.js:900 buildReconciliationData()' : 'core/data.js:873 buildReconciliationData()',
    note: ent.kind === 'lt' ? 'LT rent is looked up from the active lease per month, not from payments received.'
        : ent.kind === 'st' ? 'ST Expected includes every payment on the books that month regardless of status — unlike LT, which uses the lease rent.'
        : 'Service Expected is invoiced (not paid) totals.'
  };
}

function entityActualExplain(ent) {
  return {
    title: 'Received (Year Total)',
    formula: ent.kind === 'service'
      ? "Sum of each month's paid invoice totals (EUR)."
      : "Sum of each month's paid payment amounts (EUR).",
    inputs: [{ label: 'Total Received (EUR)', value: formatEUR(ent.totAct) }],
    source: ent.kind === 'service' ? 'core/data.js:901 buildReconciliationData()' : 'core/data.js:874 buildReconciliationData()',
    note: 'Only status:\'paid\' records count toward Received, in every month.'
  };
}

function entityOutstandingExplain(ent) {
  return {
    title: 'Outstanding',
    formula: 'max(0, Total Expected − Total Received)',
    inputs: [
      { label: 'Total Expected (EUR)', value: formatEUR(ent.totExp) },
      { label: 'Total Received (EUR)', value: formatEUR(ent.totAct) }
    ],
    source: 'reconciliation.js:392,421 openEntityModal()',
    note: 'Floored at zero — an entity that has received more than Expected (e.g. a bonus ST month) never shows a negative Outstanding.'
  };
}

function totalExpectedExplain(withData, source) {
  return {
    title: 'Expected (Total)',
    formula: "Sum of every listed entity's year-Expected total.",
    inputs: [
      { label: 'Entities', value: String(withData.length) },
      { label: 'Total Expected (EUR)', value: formatEUR(withData.reduce((s, e) => s + (e.totExp ?? e.expected ?? 0), 0)) }
    ],
    source,
    note: "Each entity's own Expected formula differs by type — LT uses active-lease rent, ST uses all payments on the books that month, Services use invoiced totals. See core/data.js buildReconciliationData()."
  };
}

function totalReceivedExplain(withData, source) {
  return {
    title: 'Received (Total)',
    formula: "Sum of every listed entity's year-Received total (status:'paid' only, in every case).",
    inputs: [{ label: 'Total Received (EUR)', value: formatEUR(withData.reduce((s, e) => s + (e.totAct ?? e.received ?? 0), 0)) }],
    source
  };
}

function totalOutstandingExplain(withData, source) {
  return {
    title: 'Outstanding (Total)',
    formula: "Sum, per entity, of max(0, that entity's Expected − Received).",
    inputs: [{ label: 'Total Outstanding (EUR)', value: formatEUR(withData.reduce((s, e) => s + (e.outstanding ?? Math.max(0, e.totExp - e.totAct)), 0)) }],
    source,
    note: 'The max(0, …) clamp is applied per entity before summing, so one entity running ahead of Expected never offsets another entity\'s shortfall.'
  };
}

function collectionRateExplain(totExp, totAct, cr) {
  return {
    title: 'Collection Rate',
    formula: cr === null ? 'Not shown when Expected is 0 and nothing was Received.' : 'round(Total Received ÷ Total Expected × 100)',
    inputs: [
      { label: 'Total Expected (EUR)', value: formatEUR(totExp) },
      { label: 'Total Received (EUR)', value: formatEUR(totAct) }
    ],
    source: 'reconciliation.js:124-126 rate()',
    note: "When Expected is 0 but something was Received anyway (a bonus month), the rate shows 100%."
  };
}

// ── Drill-down openers ──────────────────────────────────────────────────────

function openCellModal(ent, m, yr) {
  const st = cellStatus(m);
  if (st === 'none') return;
  const title = `${ent.label} — ${MON[m.m - 1]} ${yr}`;

  if (ent.kind === 'lt') {
    const mk01 = `${m.mk}-01`;
    const tenants = listActive('tenants').filter(t => {
      if (t.propertyId !== ent.id || !t.monthlyRent) return false;
      const ls = t.leaseStartDate ? t.leaseStartDate.slice(0, 7) + '-01' : null;
      const le = t.leaseEndDate   ? t.leaseEndDate.slice(0, 7)   + '-01' : null;
      return (!ls || mk01 >= ls) && (!le || mk01 <= le);
    });
    if (tenants.length || st === 'upcoming' || st === 'missing') {
      return drillDownModal(title + (st === 'missing' ? ' — No Payment' : ' — Tenants'), tenants.map(t => ({
        tenant: t.name,
        lease:  `${t.leaseStartDate ? fmtDate(t.leaseStartDate) : '—'} → ${t.leaseEndDate ? fmtDate(t.leaseEndDate) : 'open-ended'}`,
        eur:    toEUR(t.monthlyRent, t.currency || 'EUR', Number(yr))
      })), [
        { key: 'tenant', label: 'Tenant', tip: 'Tenant name on the active lease for this property.' },
        { key: 'lease',  label: 'Lease Period', tip: 'Lease start and end dates (open-ended if no end date is set).' },
        { key: 'eur',    label: 'Monthly Rent', right: true, format: v => formatEUR(v), tip: 'Monthly rent (EUR) — this is the property\'s Expected figure for months covered by the lease.' }
      ]);
    }
    // Fallthrough: show actual payments if we have them
    return openCellPaymentModal(title, ent, m);
  }

  if (ent.kind === 'service') {
    return openCellServiceModal(title, ent, m);
  }

  openCellPaymentModal(title, ent, m);
}

// openCellPaymentModal(title, ent, m) — one property/stream, one month: a
// small Expected/Received/Payments summary plus a by-status breakdown (when
// more than one status is present), with the full raw list still one click
// away via the footer link.
function openCellPaymentModal(title, ent, m) {
  const { start, end } = monthRange(m.mk);
  const pays = listActivePayments().filter(p => p.propertyId === ent.id && p.date >= start && p.date <= end);

  const body = el('div');
  body.appendChild(mkSectionLabel('Summary'));
  body.appendChild(mkSummaryGrid([
    { label: 'Expected', value: formatEUR(m.expected), explain: monthExpectedExplain(ent, m) },
    { label: 'Received', value: formatEUR(m.actual), explain: monthActualExplain(ent, m) },
    { label: 'Payments', value: String(pays.length) }
  ], 3));

  const breakdown = statusBreakdown(pays, p => toEUR(p.amount, p.currency, p.date));
  if (breakdown.length > 1) {
    body.appendChild(mkSectionLabel('By Status'));
    body.appendChild(mkModalTable(
      [{ label: 'Status', tip: 'Payment status for this group.' }, { label: 'Count', right: true, tip: 'Number of payments with this status in the selected month.' }, { label: 'Total', right: true, tip: 'Sum of amounts (EUR) for payments with this status.' }],
      breakdown.map(([st, v]) => [st, String(v.count), formatEUR(v.total)])
    ));
  }

  appendRawLinkFooter(body, pays.length, () => drillDownModal(title, byDate(pays.map(p => payRow(p, ent.label))), REC_COLS));
  openModal({ title, body, large: true });
}

// openCellServiceModal(title, ent, m) — same shape as openCellPaymentModal,
// scoped to one service stream/month of invoices instead of payments.
function openCellServiceModal(title, ent, m) {
  const { start, end } = monthRange(m.mk);
  const invs = listActive('invoices').filter(i =>
    i.stream === ent.id && i.issueDate >= start && i.issueDate <= end && i.status !== 'draft' &&
    matchInvOwner(i) && matchInvScope(i)
  );

  const body = el('div');
  body.appendChild(mkSectionLabel('Summary'));
  body.appendChild(mkSummaryGrid([
    { label: 'Expected', value: formatEUR(m.expected), explain: monthExpectedExplain(ent, m) },
    { label: 'Received', value: formatEUR(m.actual), explain: monthActualExplain(ent, m) },
    { label: 'Invoices', value: String(invs.length) }
  ], 3));

  const breakdown = statusBreakdown(invs, i => toEUR(i.total, i.currency, i.issueDate));
  if (breakdown.length > 1) {
    body.appendChild(mkSectionLabel('By Status'));
    body.appendChild(mkModalTable(
      [{ label: 'Status', tip: 'Invoice status for this group.' }, { label: 'Count', right: true, tip: 'Number of invoices with this status in the selected month.' }, { label: 'Total', right: true, tip: 'Sum of amounts (EUR) for invoices with this status.' }],
      breakdown.map(([st, v]) => [st, String(v.count), formatEUR(v.total)])
    ));
  }

  appendRawLinkFooter(body, invs.length, () => drillDownModal(title, byDate(invs.map(i => invRow(i, ent.label))), REC_COLS));
  openModal({ title, body, large: true });
}

function openEntityModal(ent, yr) {
  const title = `${ent.label} — ${yr}`;
  if (ent.kind === 'lt') {
    const yStart = `${yr}-01-01`, yEnd = `${yr}-12-31`;
    const tenants = listActive('tenants').filter(t => {
      if (t.propertyId !== ent.id || !t.monthlyRent) return false;
      const ls = t.leaseStartDate || '0000-01-01';
      const le = t.leaseEndDate   || '9999-12-31';
      return ls <= yEnd && le >= yStart;
    });
    if (tenants.length) {
      return drillDownModal(title + ' — Tenants', tenants.map(t => ({
        tenant: t.name,
        lease:  `${t.leaseStartDate ? fmtDate(t.leaseStartDate) : '—'} → ${t.leaseEndDate ? fmtDate(t.leaseEndDate) : 'open-ended'}`,
        eur:    toEUR(t.monthlyRent, t.currency || 'EUR', Number(yr))
      })), [
        { key: 'tenant', label: 'Tenant', tip: 'Tenant name on the active lease for this property.' },
        { key: 'lease',  label: 'Lease Period', tip: 'Lease start and end dates (open-ended if no end date is set).' },
        { key: 'eur',    label: 'Monthly Rent', right: true, format: v => formatEUR(v), tip: 'Monthly rent (EUR) — this is the property\'s Expected figure for months covered by the lease.' }
      ]);
    }
  }
  if (ent.kind === 'service') {
    const invs = listActive('invoices').filter(i =>
      i.stream === ent.id && (i.issueDate || '').startsWith(yr) && i.status !== 'draft' &&
      matchInvOwner(i) && matchInvScope(i)
    );

    const body = el('div');
    body.appendChild(mkSectionLabel('Performance'));
    body.appendChild(mkSummaryGrid([
      { label: 'Expected',    value: formatEUR(ent.totExp), explain: entityExpectedExplain(ent) },
      { label: 'Received',    value: formatEUR(ent.totAct), explain: entityActualExplain(ent) },
      { label: 'Outstanding', value: formatEUR(Math.max(0, ent.totExp - ent.totAct)), explain: entityOutstandingExplain(ent) },
      { label: 'Invoices',    value: String(invs.length) }
    ], 4));

    const byMonth = groupByMonthKey(invs, i => i.issueDate);
    const monthRows = [...byMonth.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([mk, list]) => [
      MON[Number(mk.slice(5, 7)) - 1],
      String(list.length),
      formatEUR(list.reduce((s, i) => s + toEUR(i.total, i.currency, i.issueDate), 0))
    ]);
    if (monthRows.length) {
      body.appendChild(mkSectionLabel('By Month'));
      body.appendChild(mkModalTable(
        [{ label: 'Month', tip: 'Calendar month within the selected year.' }, { label: 'Invoices', right: true, tip: 'Number of invoices issued that month.' }, { label: 'Total', right: true, tip: 'Sum of invoice totals (EUR) issued that month.' }],
        monthRows
      ));
    }

    appendRawLinkFooter(body, invs.length, () => drillDownModal(title, byDate(invs.map(i => invRow(i, ent.label))), REC_COLS));
    return openModal({ title, body, large: true });
  }

  const pays = listActivePayments().filter(p => p.propertyId === ent.id && (p.date || '').startsWith(yr));

  const body = el('div');
  body.appendChild(mkSectionLabel('Performance'));
  body.appendChild(mkSummaryGrid([
    { label: 'Expected',    value: formatEUR(ent.totExp), explain: entityExpectedExplain(ent) },
    { label: 'Received',    value: formatEUR(ent.totAct), explain: entityActualExplain(ent) },
    { label: 'Outstanding', value: formatEUR(Math.max(0, ent.totExp - ent.totAct)), explain: entityOutstandingExplain(ent) },
    { label: 'Payments',    value: String(pays.length) }
  ], 4));

  const byMonth = groupByMonthKey(pays, p => p.date);
  const monthRows = [...byMonth.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([mk, list]) => [
    MON[Number(mk.slice(5, 7)) - 1],
    String(list.length),
    formatEUR(list.reduce((s, p) => s + toEUR(p.amount, p.currency, p.date), 0))
  ]);
  if (monthRows.length) {
    body.appendChild(mkSectionLabel('By Month'));
    body.appendChild(mkModalTable(
      [{ label: 'Month', tip: 'Calendar month within the selected year.' }, { label: 'Payments', right: true, tip: 'Number of payments received that month.' }, { label: 'Total', right: true, tip: 'Sum of payment amounts (EUR) received that month.' }],
      monthRows
    ));
  }

  appendRawLinkFooter(body, pays.length, () => drillDownModal(title, byDate(pays.map(p => payRow(p, ent.label))), REC_COLS));
  openModal({ title, body, large: true });
}

// ── Main build ──────────────────────────────────────────────────────────────

function build() {
  const wrap = el('div', { class: 'view active' });

  // Header — same convention as every analytics-*.js dashboard
  wrap.appendChild(el('div', { style: 'margin-bottom:16px' },
    el('h2', { style: 'margin:0 0 4px;font-size:20px;font-weight:700' }, 'Reconciliation'),
    el('p',  { style: 'margin:0;font-size:13px;color:var(--text-muted)' },
      'Expected vs received revenue by property/stream, month by month, for one full year at a time')
  ));

  // Scope toggle (Company only / All incl. personal) — same convention and
  // styling as every other analytics dashboard, defaulted to 'all' here (see
  // _recScope's definition above) so nothing disappears from view by default.
  const scopeBar = el('div', { style: 'display:flex;align-items:center;gap:8px;margin-bottom:12px' });
  scopeBar.appendChild(el('span', { style: 'font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text-muted)' }, 'Scope'));
  for (const [val, label] of [['company', 'Company only'], ['all', 'All (incl. personal)']]) {
    const isActive = _recScope === val;
    const btn = el('button', {
      style: [
        'padding:4px 14px;border-radius:14px;border:1px solid;font-size:12px;cursor:pointer;transition:all 120ms',
        isActive
          ? 'border-color:var(--accent);background:var(--accent);color:#fff;font-weight:600'
          : 'border-color:var(--border);background:transparent;color:var(--text-muted)'
      ].join(';')
    }, label);
    btn.onclick = () => { if (_recScope !== val) { _recScope = val; render(); } };
    scopeBar.appendChild(btn);
  }
  wrap.appendChild(scopeBar);

  const curYear = String(new Date().getFullYear());
  // Only show years with actual data, capped at current year (future years have nothing to reconcile)
  const yearOpts = [...new Set([curYear, ...availableYears().filter(y => y <= curYear)])].sort().reverse();

  if (_recYear === null || !yearOpts.includes(_recYear)) _recYear = curYear;

  const yearSel = document.createElement('select');
  yearSel.className = 'form-control';
  yearSel.style.cssText = 'width:90px;font-size:13px';
  for (const y of yearOpts) {
    const opt = document.createElement('option');
    opt.value = y; opt.textContent = y;
    if (y === _recYear) opt.selected = true;
    yearSel.appendChild(opt);
  }

  function makeFilterGroup(items, getVal, setVal) {
    const grp = el('div', { style: 'display:inline-flex;border:1px solid var(--border);border-radius:6px;overflow:hidden' });
    const btns = [];
    const refresh = () => {
      btns.forEach((b, i) => {
        const active = items[i].key === getVal();
        b.style.background = active ? 'var(--primary)' : 'transparent';
        b.style.color      = active ? '#fff' : 'var(--text)';
      });
    };
    for (const item of items) {
      const b = el('button', {
        style: 'padding:5px 11px;font-size:12px;font-weight:500;border:none;cursor:pointer;border-right:1px solid var(--border);transition:background .15s'
      }, item.label);
      b.onclick = () => { setVal(item.key); refresh(); render(); };
      btns.push(b);
      grp.appendChild(b);
    }
    refresh();
    return grp;
  }

  const kindGrp = makeFilterGroup(
    [{ key: 'all', label: 'All' }, { key: 'lt', label: 'LT' }, { key: 'st', label: 'ST' }, { key: 'service', label: 'Services' }],
    () => _recKind, v => _recKind = v
  );
  const statusGrp = makeFilterGroup(
    [{ key: 'all', label: 'All' }, { key: 'problem', label: 'Problems' }, { key: 'reconciled', label: 'Reconciled' }],
    () => _recStatus, v => _recStatus = v
  );
  // Owner — same underlying data (getPersonName) and "both always matches"
  // semantics as every other dashboard's Owner filter (core/data.js's
  // buildReconciliationData ownerFilter param), styled as a button group to
  // match this page's existing Type/Status controls rather than importing
  // the shared multi-select widget those dashboards use.
  const ownerGrp = makeFilterGroup(
    [{ key: '', label: 'All' }, { key: 'you', label: getPersonName('you') }, { key: 'rita', label: getPersonName('rita') }],
    () => _recOwner, v => _recOwner = v
  );

  const sep = el('div', { style: 'width:1px;height:24px;background:var(--border)' });
  const sep2 = el('div', { style: 'width:1px;height:24px;background:var(--border)' });
  const controlBar = el('div', { class: 'flex gap-12 mb-16', style: 'align-items:center;flex-wrap:wrap' },
    el('div', { style: 'font-size:12px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px' }, 'Year'),
    yearSel, sep,
    el('div', { style: 'font-size:12px;color:var(--text-muted)' }, 'Type:'),   kindGrp,
    el('div', { style: 'font-size:12px;color:var(--text-muted)' }, 'Status:'), statusGrp, sep2,
    el('div', { style: 'font-size:12px;color:var(--text-muted)' }, 'Owner:'),  ownerGrp
  );
  wrap.appendChild(controlBar);

  const kpiRow     = el('div', { class: 'grid grid-4 mb-16' });
  const heatmapCard = el('div', { class: 'card mb-16' });
  const detailCard  = el('div', { class: 'card' });
  wrap.appendChild(kpiRow);
  wrap.appendChild(heatmapCard);
  wrap.appendChild(detailCard);

  const render = () => {
    kpiRow.innerHTML = '';
    heatmapCard.innerHTML = '';
    detailCard.innerHTML = '';

    const yr = yearSel.value;
    const allEntities = buildReconciliationData(Number(yr), _recOwner, _recScope);
    const withData    = allEntities.filter(e => e.totExp > 0 || e.totAct > 0);

    const filtered = withData.filter(e => {
      if (_recKind !== 'all' && e.kind !== _recKind) return false;
      if (_recStatus === 'problem')    return e.months.some(m => { const s = cellStatus(m); return s === 'missing' || s === 'partial'; });
      if (_recStatus === 'reconciled') return e.months.every(m => { const s = cellStatus(m); return s !== 'missing' && s !== 'partial'; }) && (e.totAct > 0 || e.totExp > 0);
      return true;
    });

    // ── KPI cards (always reflect unfiltered totals) ────────────────────────
    const totExp     = withData.reduce((s, e) => s + e.totExp, 0);
    const totAct     = withData.reduce((s, e) => s + e.totAct, 0);
    const outstanding = withData.reduce((s, e) => s + Math.max(0, e.totExp - e.totAct), 0);
    const cr          = rate(totAct, totExp);

    const entRowsFor = list => list.map(e => ({
      entity: e.label,
      type: e.kind === 'lt' ? 'LT Rental' : e.kind === 'st' ? 'ST Rental' : 'Service',
      expected: e.totExp, received: e.totAct, outstanding: Math.max(0, e.totExp - e.totAct)
    }));
    const appendEntityTable = (body, rows) => body.appendChild(mkModalTable(
      [
        { label: 'Entity', tip: 'Property or service stream.' },
        { label: 'Type', tip: 'LT Rental, ST Rental, or Service — the entity\'s stream kind.' },
        { label: 'Expected', right: true, tip: 'Sum of the entity\'s monthly Expected figures for the year (formula varies by type — see the ⓘ on the KPI card above).' },
        { label: 'Received', right: true, tip: 'Sum of the entity\'s monthly Received (status:\'paid\' only) figures for the year.' },
        { label: 'Outstanding', right: true, tip: 'Expected minus Received, floored at zero.' }
      ],
      rows.map(r => [r.entity, r.type, formatEUR(r.expected), formatEUR(r.received), formatEUR(r.outstanding)])
    ));

    const onExpected = () => {
      const rows = entRowsFor(withData.filter(e => e.totExp > 0));
      const body = el('div');
      body.appendChild(mkSectionLabel('Summary'));
      body.appendChild(mkSummaryGrid([
        { label: 'Total Expected', value: formatEUR(rows.reduce((s, r) => s + r.expected, 0)), explain: totalExpectedExplain(rows, 'reconciliation.js:592 onExpected()') },
        { label: 'Total Received', value: formatEUR(rows.reduce((s, r) => s + r.received, 0)), explain: totalReceivedExplain(rows, 'reconciliation.js:593 onExpected()') },
        { label: 'Entities',       value: String(rows.length) }
      ], 3));
      body.appendChild(mkSectionLabel('By Entity'));
      appendEntityTable(body, rows);
      openModal({ title: `Expected — ${yr}`, body, large: true });
    };

    const onReceived = () => {
      const propNames = new Map(withData.filter(e => e.kind !== 'service').map(e => [e.id, e.label]));
      const svcNames  = new Map(withData.filter(e => e.kind === 'service').map(e => [e.id, e.label]));
      const pays = listActivePayments().filter(p => p.status === 'paid' && (p.date || '').startsWith(yr) && propNames.has(p.propertyId));
      const invs = listActive('invoices').filter(i => i.status === 'paid' && (i.issueDate || '').startsWith(yr) && svcNames.has(i.stream) && matchInvOwner(i) && matchInvScope(i));
      const allRows = [
        ...pays.map(p => ({ label: propNames.get(p.propertyId) || '', eur: toEUR(p.amount, p.currency, p.date) })),
        ...invs.map(i => ({ label: svcNames.get(i.stream) || '', eur: toEUR(i.total, i.currency, i.issueDate) }))
      ];
      const total = allRows.reduce((s, r) => s + r.eur, 0);

      const body = el('div');
      body.appendChild(mkSectionLabel('Summary'));
      body.appendChild(mkSummaryGrid([
        {
          label: 'Total Received', value: formatEUR(total),
          explain: {
            title: 'Total Received',
            formula: "Sum of paid payment amounts (EUR) + paid invoice totals (EUR), both dated in the selected year.",
            inputs: [
              { label: 'Paid payments', value: String(pays.length) },
              { label: 'Paid invoices', value: String(invs.length) },
              { label: 'Total (EUR)',   value: formatEUR(total) }
            ],
            source: 'reconciliation.js:610 onReceived()',
            note: "Filters to status:'paid' only, on top of the current Owner/Scope selection."
          }
        },
        { label: 'Payments',       value: String(pays.length) },
        { label: 'Invoices',       value: String(invs.length) },
        {
          label: 'Average', value: allRows.length > 0 ? formatEUR(total / allRows.length) : '—',
          explain: {
            title: 'Average', formula: 'Total Received ÷ number of paid records (payments + invoices).',
            inputs: [
              { label: 'Total Received (EUR)', value: formatEUR(total) },
              { label: 'Paid records', value: String(allRows.length) }
            ],
            source: 'reconciliation.js:632 onReceived()'
          }
        }
      ], 4));

      const byEntity = new Map();
      for (const r of allRows) {
        const cur = byEntity.get(r.label) || { count: 0, total: 0 };
        cur.count++; cur.total += r.eur;
        byEntity.set(r.label, cur);
      }
      const entRows = [...byEntity.entries()].sort((a, b) => b[1].total - a[1].total);
      if (entRows.length) {
        body.appendChild(mkSectionLabel('By Entity'));
        body.appendChild(mkModalTable(
          [
            { label: 'Entity', tip: 'Property or service stream that received the payment/invoice.' },
            { label: 'Records', right: true, tip: 'Number of paid payments or invoices for this entity in the year.' },
            { label: 'Total', right: true, tip: 'Sum of paid amounts (EUR) for this entity in the year.' }
          ],
          entRows.map(([label, v]) => [label, String(v.count), formatEUR(v.total)])
        ));
      }

      appendRawLinkFooter(body, allRows.length, () => drillDownModal(`Received — ${yr}`, byDate([
        ...pays.map(p => payRow(p, propNames.get(p.propertyId) || '')),
        ...invs.map(i => invRow(i, svcNames.get(i.stream) || ''))
      ]), REC_COLS));

      openModal({ title: `Received — ${yr}`, body, large: true });
    };

    const onOutstanding = () => {
      const rows = entRowsFor(withData.filter(e => e.totExp > e.totAct));
      const body = el('div');
      body.appendChild(mkSectionLabel('Summary'));
      body.appendChild(mkSummaryGrid([
        {
          label: 'Total Outstanding', value: formatEUR(rows.reduce((s, r) => s + r.outstanding, 0)),
          explain: {
            title: 'Total Outstanding',
            formula: 'Sum of (Expected − Received) across every entity listed below (only entities where Expected > Received).',
            inputs: [
              { label: 'Entities', value: String(rows.length) },
              { label: 'Total Outstanding (EUR)', value: formatEUR(rows.reduce((s, r) => s + r.outstanding, 0)) }
            ],
            source: 'reconciliation.js:677 onOutstanding()'
          }
        },
        { label: 'Total Expected',    value: formatEUR(rows.reduce((s, r) => s + r.expected, 0)), explain: totalExpectedExplain(rows, 'reconciliation.js:688 onOutstanding()') },
        { label: 'Entities',          value: String(rows.length) }
      ], 3));
      body.appendChild(mkSectionLabel('By Entity'));
      appendEntityTable(body, rows);
      openModal({ title: `Outstanding — ${yr}`, body, large: true });
    };

    kpiRow.appendChild(kpi('Expected',       formatEUR(totExp),          '',                                                  onExpected,   totalExpectedExplain(withData, 'reconciliation.js:566 render()')));
    kpiRow.appendChild(kpi('Received',        formatEUR(totAct),          '',                                                  onReceived,   totalReceivedExplain(withData, 'reconciliation.js:567 render()')));
    kpiRow.appendChild(kpi('Outstanding',     formatEUR(outstanding),     outstanding > 0 ? 'danger' : 'success',              onOutstanding, totalOutstandingExplain(withData, 'reconciliation.js:568 render()')));
    kpiRow.appendChild(kpi('Collection Rate', cr !== null ? `${cr}%` : '—', cr === null ? '' : cr >= 100 ? 'success' : cr >= 75 ? 'warning' : 'danger', onOutstanding, collectionRateExplain(totExp, totAct, cr)));

    // ── Heatmap ─────────────────────────────────────────────────────────────
    renderHeatmap(heatmapCard, filtered, yr);

    // ── Detail table ─────────────────────────────────────────────────────────
    renderDetail(detailCard, withData, yr);
  };

  // ── Heatmap renderer ──────────────────────────────────────────────────────
  function renderHeatmap(container, entities, yr) {
    const header = el('div', { class: 'card-header' },
      el('div', { class: 'card-title' }, 'Collection Heatmap'),
      el('div', { style: 'font-size:11px;color:var(--text-muted)' }, 'Click any cell to view records • Click entity name to view full year')
    );
    container.appendChild(header);

    // Legend
    const legend = el('div', { style: 'display:flex;gap:14px;padding:8px 16px 10px;flex-wrap:wrap;border-bottom:1px solid var(--border)' });
    for (const [st, label] of [
      ['reconciled','Reconciled'],['partial','Partial'],['missing','Missing'],['upcoming','Upcoming'],['none','No expectation']
    ]) {
      const swatch = el('div', { style: `width:12px;height:12px;border-radius:3px;flex-shrink:0;background:${CELL_BG[st]};border:1px solid rgba(0,0,0,0.1)` });
      legend.appendChild(el('div', { style: 'display:flex;align-items:center;gap:5px;font-size:11px;color:var(--text-muted)' }, swatch, label));
    }
    container.appendChild(legend);

    if (entities.length === 0) {
      container.appendChild(el('div', { class: 'empty', style: 'padding:48px 20px' }, 'No entities match the selected filters'));
      return;
    }

    const scroll = el('div', { style: 'overflow-x:auto' });
    container.appendChild(scroll);

    const t = document.createElement('table');
    t.style.cssText = 'width:100%;border-collapse:collapse;min-width:820px';

    // Colgroup
    const cg = document.createElement('colgroup');
    const addCol = w => { const c = document.createElement('col'); c.style.width = w; cg.appendChild(c); };
    addCol('180px');
    MON.forEach(() => addCol('52px'));
    addCol('62px');
    t.appendChild(cg);

    // Thead
    const thead = document.createElement('thead');
    const htr   = document.createElement('tr');
    htr.style.cssText = 'background:var(--surface)';
    const cellStyle = 'padding:7px 4px;font-size:10px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.6px;border-bottom:2px solid var(--border);text-align:center';

    const th0 = mkTh({ label: 'Entity', tip: 'Property or service stream — click the name to view its full-year breakdown.' });
    th0.style.cssText = cellStyle + ';text-align:left;padding-left:12px;position:sticky;left:0;background:var(--surface);cursor:help';
    htr.appendChild(th0);

    for (const m of MON) {
      const th = mkTh({ label: m, tip: `${m}: percentage of that month's Expected amount actually Received (click a cell to view its records).` });
      th.style.cssText = cellStyle + ';cursor:help';
      htr.appendChild(th);
    }

    const thRate = mkTh({ label: 'Rate', tip: "Year-to-date collection rate for this entity: Received ÷ Expected × 100." });
    thRate.style.cssText = cellStyle + ';padding-right:10px;cursor:help';
    htr.appendChild(thRate);
    thead.appendChild(htr);
    t.appendChild(thead);

    const tbody = document.createElement('tbody');
    const KINDS = [['lt','LT Rentals'],['st','ST Rentals'],['service','Services']];

    for (const [kind, kindLabel] of KINDS) {
      const gEnts = entities.filter(e => e.kind === kind);
      if (gEnts.length === 0) continue;

      // Section header
      const secTr = document.createElement('tr');
      const secTd = document.createElement('td');
      secTd.colSpan = 14;
      secTd.style.cssText = 'padding:9px 12px 5px;font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.8px;color:var(--text-muted);background:var(--surface);border-top:2px solid var(--border)';
      secTd.textContent = kindLabel;
      secTr.appendChild(secTd);
      tbody.appendChild(secTr);

      for (const ent of gEnts) {
        const tr = document.createElement('tr');
        tr.style.cssText = 'border-bottom:1px solid var(--border);transition:background .1s';
        tr.onmouseenter = () => tr.style.background = 'rgba(99,102,241,0.03)';
        tr.onmouseleave = () => tr.style.background = '';

        // Entity name cell (sticky)
        const nameTd = document.createElement('td');
        nameTd.style.cssText = 'padding:6px 12px;font-size:12px;font-weight:600;color:var(--text);cursor:pointer;position:sticky;left:0;background:var(--surface);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:180px;border-right:1px solid var(--border)';
        nameTd.title = ent.label;
        nameTd.textContent = ent.label;
        nameTd.onclick = () => openEntityModal(ent, yr);
        tr.appendChild(nameTd);

        // Month cells
        for (const m of ent.months) {
          const st  = cellStatus(m);
          const td  = document.createElement('td');
          const can = st !== 'none';
          td.style.cssText = `padding:5px 2px;text-align:center;background:${CELL_BG[st]};font-size:10px;font-weight:700;color:${CELL_COLOR[st]};cursor:${can ? 'pointer' : 'default'};border-right:1px solid var(--border);user-select:none;line-height:1`;
          td.textContent = cellLabel(m, st);
          td.title = `${MON[m.m-1]} — Expected: ${formatEUR(m.expected)} / Received: ${formatEUR(m.actual)}`;
          if (can) {
            td.onclick = () => openCellModal(ent, m, yr);
            td.onmouseenter = () => { td.style.outline = '2px solid var(--primary,#6366f1)'; td.style.outlineOffset = '-2px'; td.style.zIndex = '1'; td.style.position = 'relative'; };
            td.onmouseleave = () => { td.style.outline = ''; td.style.outlineOffset = ''; td.style.zIndex = ''; td.style.position = ''; };
          }
          tr.appendChild(td);
        }

        // Rate cell
        const r   = rate(ent.totAct, ent.totExp);
        const rtd = document.createElement('td');
        rtd.style.cssText = 'padding:5px 8px;text-align:center;font-size:11px;font-weight:700';
        if (r !== null) {
          rtd.style.color = r >= 100 ? '#059669' : r >= 75 ? '#d97706' : '#dc2626';
          rtd.textContent = `${r}%`;
        } else {
          rtd.textContent = '—';
          rtd.style.color = 'var(--text-muted)';
        }
        tr.appendChild(rtd);
        tbody.appendChild(tr);
      }

      // Section aggregate row
      const gExp  = gEnts.reduce((s, e) => s + e.totExp, 0);
      const gAct  = gEnts.reduce((s, e) => s + e.totAct, 0);
      const gRate = rate(gAct, gExp);
      const aggTr = document.createElement('tr');
      aggTr.style.cssText = 'background:var(--surface);border-top:1px solid var(--border)';

      const aggName = document.createElement('td');
      aggName.style.cssText = 'padding:6px 12px;font-size:11px;font-weight:700;color:var(--text-muted);position:sticky;left:0;background:var(--surface);border-right:1px solid var(--border)';
      aggName.textContent = kindLabel + ' Total';
      aggTr.appendChild(aggName);

      for (let mi = 0; mi < 12; mi++) {
        const mExp = gEnts.reduce((s, e) => s + (e.months[mi]?.expected || 0), 0);
        const mAct = gEnts.reduce((s, e) => s + (e.months[mi]?.actual   || 0), 0);
        const td   = document.createElement('td');
        td.style.cssText = 'padding:5px 2px;text-align:center;font-size:10px;font-weight:700;border-right:1px solid var(--border)';
        if (mExp > 0 || mAct > 0) {
          const r = rate(mAct, mExp);
          td.style.color = r === null ? '#059669' : r >= 100 ? '#059669' : r >= 75 ? '#d97706' : '#dc2626';
          td.textContent = r !== null ? `${r}%` : '+';
        }
        aggTr.appendChild(td);
      }

      const aggRate = document.createElement('td');
      aggRate.style.cssText = 'padding:5px 8px;text-align:center;font-size:11px;font-weight:700';
      if (gRate !== null) {
        aggRate.style.color = gRate >= 100 ? '#059669' : gRate >= 75 ? '#d97706' : '#dc2626';
        aggRate.textContent = `${gRate}%`;
      } else {
        aggRate.textContent = '—';
        aggRate.style.color = 'var(--text-muted)';
      }
      aggTr.appendChild(aggRate);
      tbody.appendChild(aggTr);
    }

    t.appendChild(tbody);
    scroll.appendChild(t);
  }

  // ── Detail table renderer ─────────────────────────────────────────────────
  function renderDetail(container, entities, yr) {
    container.appendChild(el('div', { class: 'card-header' },
      el('div', { class: 'card-title' }, `${yr} — Entity Summary`),
      el('div', { style: 'font-size:11px;color:var(--text-muted)' }, 'Click a row to view records')
    ));

    const t  = document.createElement('table');
    t.className = 'table';
    const htr = el('tr', {},
      mkTh({ label: 'Entity', tip: 'Property or service stream — click a row to view its full-year breakdown.' }),
      mkTh({ label: 'Type', tip: 'LT Rental, ST Rental, or Service.' }),
      mkTh({ label: 'Expected', right: true, tip: 'Sum of the entity\'s monthly Expected figures for the year (formula varies by type).' }),
      mkTh({ label: 'Received', right: true, tip: 'Sum of the entity\'s monthly Received (status:\'paid\' only) figures for the year.' }),
      mkTh({ label: 'Outstanding', right: true, tip: 'Expected minus Received, floored at zero.' }),
      mkTh({ label: 'Rate', right: true, tip: 'Received ÷ Expected × 100, rounded.' })
    );
    t.appendChild(el('thead', {}, htr));
    const tb = document.createElement('tbody');

    const groups = [['lt','LT Rental','long'],['st','ST Rental','short'],['service','Service','cs']];
    for (const [kind, kindLabel, badgeCls] of groups) {
      const gEnts = entities.filter(e => e.kind === kind && (e.totExp > 0 || e.totAct > 0));
      if (gEnts.length === 0) continue;

      for (const ent of gEnts) {
        const out = Math.max(0, ent.totExp - ent.totAct);
        const r   = rate(ent.totAct, ent.totExp);
        const tr  = document.createElement('tr');
        tr.style.cursor = 'pointer';
        if (out > 0) tr.style.background = out > ent.totExp * 0.25 ? 'rgba(239,68,68,.05)' : 'rgba(245,158,11,.06)';
        tr.onmouseenter = () => tr.style.opacity = '0.82';
        tr.onmouseleave = () => tr.style.opacity = '';
        tr.onclick = () => openEntityModal(ent, yr);
        tr.innerHTML = `
          <td style="font-weight:500">${escapeHtml(ent.label)}</td>
          <td><span class="badge ${badgeCls}">${kindLabel}</span></td>
          <td class="right num">${formatEUR(ent.totExp)}</td>
          <td class="right num">${formatEUR(ent.totAct)}</td>
          <td class="right num ${out > 0 ? 'danger' : 'success'}">${out > 0 ? formatEUR(out) : '—'}</td>
          <td class="right">${r !== null ? `<span class="badge ${r >= 100 ? 'success' : r >= 75 ? 'warning' : 'danger'}">${r}%</span>` : '<span class="muted">—</span>'}</td>
        `;
        tb.appendChild(tr);
      }

      // Kind subtotal
      const kExp  = gEnts.reduce((s, e) => s + e.totExp, 0);
      const kAct  = gEnts.reduce((s, e) => s + e.totAct, 0);
      const kOut  = Math.max(0, kExp - kAct);
      const kRate = rate(kAct, kExp);
      const subTr = document.createElement('tr');
      subTr.style.cssText = 'font-weight:600;border-top:1px solid var(--border);background:var(--surface)';
      subTr.innerHTML = `
        <td style="color:var(--text-muted);font-size:11px">${kindLabel} Subtotal</td>
        <td></td>
        <td class="right num">${formatEUR(kExp)}</td>
        <td class="right num">${formatEUR(kAct)}</td>
        <td class="right num ${kOut > 0 ? 'danger' : 'success'}">${kOut > 0 ? formatEUR(kOut) : '—'}</td>
        <td class="right">${kRate !== null ? `<span class="badge ${kRate >= 100 ? 'success' : kRate >= 75 ? 'warning' : 'danger'}">${kRate}%</span>` : '<span class="muted">—</span>'}</td>
      `;
      tb.appendChild(subTr);
    }

    // Grand total
    const gExp  = entities.reduce((s, e) => s + e.totExp, 0);
    const gAct  = entities.reduce((s, e) => s + e.totAct, 0);
    const gOut  = Math.max(0, gExp - gAct);
    const gRate = rate(gAct, gExp);
    const totTr = document.createElement('tr');
    totTr.style.cssText = 'font-weight:700;border-top:2px solid var(--border)';
    totTr.innerHTML = `
      <td>Grand Total</td><td></td>
      <td class="right num">${formatEUR(gExp)}</td>
      <td class="right num">${formatEUR(gAct)}</td>
      <td class="right num ${gOut > 0 ? 'danger' : 'success'}">${gOut > 0 ? formatEUR(gOut) : '—'}</td>
      <td class="right">${gRate !== null ? `<span class="badge ${gRate >= 100 ? 'success' : gRate >= 75 ? 'warning' : 'danger'}">${gRate}%</span>` : '<span class="muted">—</span>'}</td>
    `;
    tb.appendChild(totTr);
    t.appendChild(tb);
    container.appendChild(el('div', { class: 'table-wrap' }, t));
  }

  yearSel.onchange = () => { _recYear = yearSel.value; render(); };
  render();
  return wrap;
}

function kpi(label, value, variant, onClick, explain) {
  const d = el('div', { class: 'kpi' + (variant ? ' ' + variant : '') });
  if (onClick) { d.style.cursor = 'pointer'; d.onclick = onClick; }
  if (explain) {
    const labelRow = el('div', { class: 'kpi-label', style: 'display:flex;align-items:center;gap:4px' }, label);
    labelRow.appendChild(mkExplainButton(explain));
    d.appendChild(labelRow);
  } else {
    d.appendChild(el('div', { class: 'kpi-label' }, label));
  }
  d.appendChild(el('div', { class: 'kpi-value' }, value));
  d.appendChild(el('div', { class: 'kpi-accent-bar' }));
  return d;
}
