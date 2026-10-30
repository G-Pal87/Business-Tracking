// "Needs attention" card — the things that need action, as of today, for the
// properties the dashboard's filters let through: uncollected rent, empty
// long-term flats, flats idle or in renovation, leases ending soon, and data
// that contradicts itself (status vs leases, overlapping leases). Shared by
// the Executive overview and the Properties dashboard.
import { el, button, fmtDate, toast } from '../core/ui.js';
import { listActive, listActivePayments, generatePaymentSchedule, currentLeases, expectedPropertyStatus, syncPropertyStatus, formatEUR, toEUR, byId } from '../core/data.js';
import { PROPERTY_STATUSES } from '../core/config.js';
import { navigate } from '../core/router.js';
import { todayYmd, diffDaysYmd, addDaysYmd } from '../core/dates.js';

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
  const out = { overdue: [], empty: [], idle: [], ending: [], checks: [] };
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
  out.overdue.sort((a, b) => b.eur - a.eur);
  out.empty.sort((a, b) => (b.days || 0) - (a.days || 0));
  out.idle.sort((a, b) => (b.days || 0) - (a.days || 0));
  out.ending.sort((a, b) => a.days - b.days);
  return out;
}

export function buildAttentionCard(props, { weight = () => 1, onChange = null } = {}) {
  const day = todayYmd();
  const it = getAttentionItems(props, weight, day);
  const card = el('div', { class: 'card mb-16' });
  const total = it.overdue.length + it.empty.length + it.idle.length + it.ending.length + it.checks.length;
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
  const fixable = it.checks.filter(c => c.kind === 'status');
  section('Data to check', 'var(--accent)', it.checks.map(c => row(c.prop.name, c.text,
    c.kind === 'status' ? button(`Set to ${PROPERTY_STATUSES[c.to]?.label || c.to}`, { variant: 'sm ghost', onClick: e => {
      e.stopPropagation();
      syncPropertyStatus(c.prop.id);
      toast(`${c.prop.name} is now ${PROPERTY_STATUSES[c.to]?.label || c.to}`, 'success');
      if (onChange) onChange();
    } }) : null)));
  if (fixable.length > 1) {
    body.appendChild(el('div', {}, button(`Fix all ${fixable.length} statuses`, { variant: 'sm primary', onClick: () => {
      for (const c of fixable) syncPropertyStatus(c.prop.id);
      toast(`${fixable.length} property statuses updated`, 'success');
      if (onChange) onChange();
    } })));
  }
  return card;
}
