// "Needs attention" card — the things that need action, as of today, for the
// properties the dashboard's filters let through: uncollected rent, empty
// long-term flats, flats idle or in renovation, leases ending soon, and data
// that contradicts itself (status vs leases, overlapping leases). Shared by
// the Executive overview and the Properties dashboard.
import { el, button, fmtDate, toast, openModal, closeModal, confirmDialog } from '../core/ui.js';
import { listActive, listActivePayments, generatePaymentSchedule, currentLeases, expectedPropertyStatus, syncPropertyStatus, formatEUR, formatMoney, toEUR, byId, softDelete } from '../core/data.js';
import { findRentPaymentIssues, dismissRentCheck } from '../core/rent-checks.js';
import { PROPERTY_STATUSES } from '../core/config.js';
import { navigate } from '../core/router.js';
import { todayYmd, diffDaysYmd, addDaysYmd } from '../core/dates.js';
import { electricityActions } from '../core/electricity.js';
import { calendarSyncProblems } from './calsync-app.js';

const LEASE_WARN_DAYS = 90;
const STR_IDLE_DAYS = 60;
const DAYS_PER_MONTH = 30.4375;

const inRenovation = (p, day) => p.status === 'renovation' ||
  (p.renovationPeriods || []).some(r => r.startDate && r.startDate <= day && (!r.endDate || r.endDate >= day));

// When a long-term flat last stopped being let (latest lease end or
// termination before `day`), else its purchase date.
function emptySince(p, day) {
  let last = '';
  for (const t of listActive('tenants')) {
    if (t.propertyId !== p.id || t.status === 'prospective') continue;
    const end = t.terminationDate && (!t.leaseEndDate || t.terminationDate < t.leaseEndDate) ? t.terminationDate : t.leaseEndDate;
    if (end && end < day && end > last) last = end;
  }
  return last || p.purchaseDate || '';
}
function lastRentEUR(p, day) {
  const ts = listActive('tenants').filter(t => t.propertyId === p.id && t.monthlyRent)
    .sort((a, b) => (b.leaseStartDate || '').localeCompare(a.leaseStartDate || ''));
  return ts[0] ? toEUR(ts[0].monthlyRent, ts[0].currency || p.currency || 'EUR', day) : 0;
}

// `props`: the properties to check (already filtered by the dashboard).
// `weight(prop)`: the owner share applied to money (1 without an owner filter).
export function getAttentionItems(props, weight = () => 1, day = todayYmd()) {
  const out = { overdue: [], empty: [], idle: [], ending: [], checks: [], electricity: [] };
  const live = props.filter(p => p.status !== 'sold');
  const pays = listActivePayments();
  for (const p of live) {
    const w = weight(p);
    const leases = currentLeases(p.id, day);
    // Uncollected rent: scheduled rent past its due date, unpaid.
    if (p.type === 'long_term') {
      const due = generatePaymentSchedule(p).filter(e => !e.paid && e.date < day);
      if (due.length) {
        const oldest = due.reduce((m, e) => (e.date < m ? e.date : m), due[0].date);
        out.overdue.push({ prop: p, months: due.length, eur: due.reduce((s, e) => s + (e.amountEUR || 0), 0) * w, oldest, days: diffDaysYmd(oldest, day) });
      }
    }
    // Empty / idle / in renovation.
    if (inRenovation(p, day) && !leases.length) {
      const per = (p.renovationPeriods || []).filter(r => r.startDate && r.startDate <= day && (!r.endDate || r.endDate >= day))
        .sort((a, b) => a.startDate.localeCompare(b.startDate))[0];
      out.idle.push({ prop: p, kind: 'renovation', since: per?.startDate || '', days: per ? diffDaysYmd(per.startDate, day) : null });
    } else if (p.type === 'long_term' && !leases.length) {
      const since = emptySince(p, day);
      const days = since ? diffDaysYmd(since, day) : null;
      out.empty.push({ prop: p, since, days, missedEUR: days ? lastRentEUR(p, day) * (days / DAYS_PER_MONTH) * w : 0 });
    } else if (p.type === 'short_term') {
      const mine = pays.filter(x => x.propertyId === p.id && (x.status === 'paid' || x.status === 'pending'));
      const stayEnd = x => x.airbnbCheckOut || x.checkOut || x.date || '';
      const future = mine.some(x => (x.airbnbCheckIn || x.checkIn || x.date || '') >= day);
      const last = mine.filter(x => x.status === 'paid').map(stayEnd).filter(d => d && d < day).sort().pop() || '';
      const days = last ? diffDaysYmd(last, day) : null;
      if (!future && (days === null || days >= STR_IDLE_DAYS)) out.idle.push({ prop: p, kind: 'no_bookings', since: last, days });
    }
    // Leases ending soon with no following lease.
    for (const t of leases) {
      if (!t.leaseEndDate || t.leaseEndDate > addDaysYmd(day, LEASE_WARN_DAYS)) continue;
      const next = listActive('tenants').some(o => o.id !== t.id && o.propertyId === p.id && o.status !== 'prospective' && (o.leaseStartDate || '') > (t.leaseStartDate || ''));
      if (!next) out.ending.push({ prop: p, tenant: t, end: t.leaseEndDate, days: diffDaysYmd(day, t.leaseEndDate) });
    }
    // Data that contradicts itself.
    const want = expectedPropertyStatus(p, day);
    if (want) out.checks.push({ prop: p, kind: 'status', from: p.status || 'active', to: want, text: leases.length ? `marked ${PROPERTY_STATUSES[p.status]?.label || p.status} but has a tenant` : 'marked Active but has no tenant' });
    if (leases.length > 1) out.checks.push({ prop: p, kind: 'overlap', text: `${leases.length} leases running at the same time (${leases.map(t => t.name || '—').join(', ')}) — end the old one` });
  }
  // Electricity (Hungarian flats): readings to submit, invoices to pay.
  const ids = new Set(live.map(p => p.id));
  const ea = electricityActions(day);
  for (const c of ea.readings) if (ids.has(c.property.id)) out.electricity.push({ prop: c.property, kind: 'reading', c });
  for (const c of ea.invoices) if (ids.has(c.property.id)) out.electricity.push({ prop: c.property, kind: 'invoice', c });
  // Rent months paid twice, overpaid, or paid when no rent was due.
  for (const x of findRentPaymentIssues(live)) out.checks.push({ prop: x.prop, kind: 'rent', issue: x, text: rentIssueText(x) });
  // Airbnb calendars that aren't syncing (or the sync isn't set up).
  for (const x of calendarSyncProblems()) {
    if (x.prop && !ids.has(x.prop.id)) continue;
    out.checks.push({ prop: x.prop || { id: '', name: 'Airbnb calendars' }, kind: 'calsync', text: x.text });
  }
  out.overdue.sort((a, b) => b.eur - a.eur);
  out.empty.sort((a, b) => (b.days || 0) - (a.days || 0));
  out.idle.sort((a, b) => (b.days || 0) - (a.days || 0));
  out.ending.sort((a, b) => a.days - b.days);
  return out;
}

const monthLabel = mk => new Date(`${mk}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
function rentIssueText(x) {
  const m = v => formatMoney(v, x.currency, { maxFrac: 0 });
  const n = x.payments.length;
  if (x.kind === 'duplicate') return `${monthLabel(x.monthKey)} rent recorded ${n}× (${m(x.paid)} paid vs ${m(x.expected)} due) — possible duplicate`;
  if (x.kind === 'not_due') return `${monthLabel(x.monthKey)}: ${m(x.paid)} rent recorded but no lease covers that month`;
  if (x.kind === 'part_month') return `${monthLabel(x.monthKey)}: full rent ${m(x.paid)} recorded for a part month (${m(x.expected)} due — the lease starts or ends that month)`;
  return `${monthLabel(x.monthKey)} overpaid by ${m(x.overBy)} (${m(x.paid)} paid vs ${m(x.expected)} due)`;
}

// Review one flagged rent month: the payments recorded for it, each with a
// Delete (to Trash, restorable), or "It's correct" to stop flagging it.
export function openRentCheckModal(x, onChange) {
  const m = v => formatMoney(v, x.currency, { maxFrac: 2 });
  const body = el('div', {});
  body.appendChild(el('div', { style: 'font-size:13px;margin-bottom:10px;line-height:1.5' },
    el('strong', {}, `${x.prop.name} · ${monthLabel(x.monthKey)}`), el('br'),
    `Rent due: ${m(x.expected)} · recorded as paid: ${m(x.paid)}`,
    x.kind === 'not_due' ? ' · no lease covers this month' : x.overBy > 0 ? ` · ${m(x.overBy)} more than due` : ''));
  const table = el('table', { class: 'table' });
  table.appendChild(el('thead', {}, el('tr', {}, el('th', {}, 'Paid on'), el('th', { class: 'right' }, 'Amount'), el('th', {}, 'Tenant / notes'), el('th', {}, ''))));
  const tb = el('tbody');
  for (const p of x.payments) {
    const tenant = p.tenantId ? byId('tenants', p.tenantId)?.name : '';
    const del = button('Delete', { variant: 'sm ghost', onClick: async () => {
      const ok = await confirmDialog(`Delete the ${formatMoney(p.amount, p.currency || x.currency, { maxFrac: 2 })} payment of ${fmtDate(p.date)}? It goes to Trash (Settings), where it can be restored.`, { danger: true, okLabel: 'Delete' });
      if (!ok) return;
      softDelete('payments', p.id);
      toast('Payment moved to Trash', 'success');
      closeModal();
      onChange?.();
    } });
    tb.appendChild(el('tr', {}, el('td', {}, fmtDate(p.date)), el('td', { class: 'right num' }, formatMoney(p.amount, p.currency || x.currency, { maxFrac: 2 })),
      el('td', { class: 'muted' }, [tenant, p.notes || p.reference || ''].filter(Boolean).join(' · ') || '—'), el('td', { class: 'right' }, del)));
  }
  table.appendChild(tb);
  body.appendChild(el('div', { class: 'table-wrap' }, table));
  const hint = {
    duplicate: 'If both payments are real (e.g. one is for another month), set the right month on that payment in Property Payments — otherwise delete the duplicate.',
    overpaid: 'If part of this was for another month, set the right month on the payment in Property Payments. If the tenant really paid more, mark it as correct.',
    part_month: 'The lease starts or ends this month, so the app expects pro-rated rent. If the tenant pays a full month on move-in/out, turn off pro-rating on the tenant (Tenants → edit). If this payment is for the next month, set its month in Property Payments.',
    not_due: 'No lease covers this month. Check the lease dates on the tenant, or set the right month on the payment in Property Payments.'
  }[x.kind];
  body.appendChild(el('div', { style: 'font-size:12px;color:var(--text-muted);margin-top:10px;line-height:1.5' },
    `${hint} You can also mark it as correct; a new payment for the month flags it again.`));
  openModal({ title: 'Check rent payments', body, footer: [
    button('Close', { onClick: closeModal }),
    button('It\'s correct — stop flagging', { variant: 'primary', onClick: () => { dismissRentCheck(x.key); toast('Marked as correct', 'success'); closeModal(); onChange?.(); } })
  ] });
}

export function buildAttentionCard(props, { weight = () => 1, onChange = null } = {}) {
  const day = todayYmd();
  const it = getAttentionItems(props, weight, day);
  const card = el('div', { class: 'card mb-16' });
  const total = it.overdue.length + it.empty.length + it.idle.length + it.ending.length + it.checks.length + it.electricity.length;
  card.appendChild(el('div', { class: 'card-header' },
    el('div', {}, el('div', { class: 'card-title' }, 'Needs attention'),
      el('div', { style: 'font-size:12px;color:var(--text-muted)' }, 'As of today · follows the owner, property and scope filters · not affected by the period filter'))));
  const body = el('div', { style: 'padding:0 16px 14px;display:flex;flex-direction:column;gap:12px' });
  card.appendChild(body);
  if (!total) {
    body.appendChild(el('div', { style: 'color:var(--success);font-size:13px' }, '✓ Nothing needs attention'));
    return card;
  }
  const section = (title, color, rows) => {
    if (!rows.length) return;
    const s = el('div', {});
    s.appendChild(el('div', { style: `font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:${color};margin-bottom:4px` }, `${title} (${rows.length})`));
    for (const r of rows) s.appendChild(r);
    body.appendChild(s);
  };
  const row = (name, detail, right = null, onClick = null) => {
    const d = el('div', { style: `display:flex;align-items:center;gap:10px;padding:5px 0;border-bottom:1px solid var(--border);font-size:13px${onClick ? ';cursor:pointer' : ''}` },
      el('div', { style: 'font-weight:600;min-width:0;flex:0 1 auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis' }, name),
      el('div', { style: 'color:var(--text-muted);flex:1;min-width:0' }, detail),
      right);
    if (onClick) d.onclick = onClick;
    return d;
  };
  const toSchedule = () => navigate('payments');
  section('Uncollected rent', 'var(--danger)', it.overdue.map(o => row(o.prop.name,
    `${o.months} month${o.months > 1 ? 's' : ''} unpaid · oldest due ${fmtDate(o.oldest)} (${o.days} days late)`,
    el('div', { style: 'font-weight:600;color:var(--danger)' }, formatEUR(o.eur)), toSchedule)));
  section('Empty — no tenant', 'var(--warning)', it.empty.map(o => row(o.prop.name,
    o.since ? `empty since ${fmtDate(o.since)} (${o.days} days)` : 'no tenant recorded',
    o.missedEUR ? el('div', { style: 'color:var(--warning)' }, `≈ ${formatEUR(o.missedEUR)} rent missed`) : null)));
  section('Idle / in renovation', 'var(--text-muted)', it.idle.map(o => row(o.prop.name,
    o.kind === 'renovation'
      ? (o.since ? `in renovation since ${fmtDate(o.since)} (${o.days} days)` : 'in renovation (no start date recorded)')
      : (o.since ? `no bookings for ${o.days} days (last stay ended ${fmtDate(o.since)}), none upcoming` : 'no bookings recorded, none upcoming'))));
  section(`Leases ending within ${LEASE_WARN_DAYS} days`, 'var(--info)', it.ending.map(o => row(o.prop.name,
    `${o.tenant.name || 'Tenant'} · ends ${fmtDate(o.end)} (in ${o.days} days) · no next lease yet`)));
  section('Electricity', '#d97706', it.electricity.map(o => row(o.prop.name,
    o.kind === 'reading'
      ? `meter reading ${o.c.period} — ${o.c.reading === 'overdue' ? `window closed ${fmtDate(o.c.windowTo)}` : `submit by ${fmtDate(o.c.windowTo)}`}`
      : `invoice ${o.c.period} — check & pay (expected since ${fmtDate(o.c.invoiceDue)})`,
    null, () => navigate('electricity'))));
  const fixable = it.checks.filter(c => c.kind === 'status');
  section('Data to check', 'var(--accent)', it.checks.map(c => row(c.prop.name, c.text,
    c.kind === 'status' ? button(`Set to ${PROPERTY_STATUSES[c.to]?.label || c.to}`, { variant: 'sm ghost', onClick: e => {
      e.stopPropagation();
      syncPropertyStatus(c.prop.id);
      toast(`${c.prop.name} is now ${PROPERTY_STATUSES[c.to]?.label || c.to}`, 'success');
      if (onChange) onChange();
    } }) : null, c.kind === 'calsync' ? () => navigate('str-rates') : c.kind === 'rent' ? () => openRentCheckModal(c.issue, onChange) : null)));
  if (fixable.length > 1) {
    body.appendChild(el('div', {}, button(`Fix all ${fixable.length} statuses`, { variant: 'sm primary', onClick: () => {
      for (const c of fixable) syncPropertyStatus(c.prop.id);
      toast(`${fixable.length} property statuses updated`, 'success');
      if (onChange) onChange();
    } })));
  }
  return card;
}
