// Home — the first screen: what needs doing today. A greeting, then cards in
// priority order, each shown only when it has something to say:
//   1. Needs attention   — getAttentionItems (attention.js), compact, with a
//                          link to the full card on the Executive dashboard
//   2. This week         — next 7 days: STR check-ins / check-outs (payments
//                          + Airbnb calendar blocks), rent due, lease starts /
//                          ends, invoices due
//   3. Money             — this month vs last month, overdue invoices / rent
//   4. Airbnb calendars  — sync status (calsync-app.js) + Refresh
//   5. Short-term nights — nights booked this month / next per STR property
// Every row is a button: it opens the right page (or, for a rent check, the
// review dialog in place). Everything, both owners and personal records
// included — the dashboards hold the owner / scope filters.
import { state } from '../core/state.js';
import { el, fmtDate } from '../core/ui.js';
import { listActive, listActivePayments, generatePaymentSchedule, isReservationNight, isRentPayment, toEUR, formatEUR, invoiceCashDate } from '../core/data.js';
import { navigate } from '../core/router.js';
import { todayYmd, addDaysYmd, diffDaysYmd, parseYmd, daysInMonth } from '../core/dates.js';
import { isOwnerBlockSummary } from '../core/ical.js';
import { getAttentionItems, openRentCheckModal } from './attention.js';
import { calendarSyncProblems, propertySyncStatus, calSyncSettings, lastPull, refreshNow } from './calsync-app.js';
import { classifyInvoice, invoiceDueDate, invoiceGrossEUR, invoiceNetEUR } from './analytics-helpers.js';

const WEEK_DAYS = 7;          // "This week" = today + the next 6 days
const WEEK_MAX_ROWS = 8;

let _container = null;
let _onCalsync = null;

// ── Small helpers ────────────────────────────────────────────────────────────
const eur0 = v => formatEUR(v, { maxFrac: 0 });
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const monthName = ym => parseYmd(`${ym}-01`).toLocaleDateString('en-GB', { month: 'long', timeZone: 'UTC' });
const addMonthsYm = (ym, n) => {
  const d = parseYmd(`${ym}-01`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 7);
};
function* nights(ci, co) {           // check-in inclusive, check-out exclusive
  for (let d = ci, g = 0; d < co && g < 400; d = addDaysYmd(d, 1), g++) yield d;
}
function dayLabel(ymd, today) {
  const n = diffDaysYmd(today, ymd);
  if (n === 0) return 'Today';
  if (n === 1) return 'Tomorrow';
  return parseYmd(ymd).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}
function greeting() {
  const h = new Date().getHours();
  const part = h < 5 ? 'Good evening' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  const name = String(state.session?.name || state.session?.username || '').trim().split(/\s+/)[0];
  return name ? `${part}, ${name}` : part;
}
// Open the Executive dashboard's Overview tab and bring its "Needs attention"
// card into view.
function openExecAttention() {
  try { localStorage.setItem('btf:exec_dash_tab', 'overview'); } catch { /* storage blocked */ }
  navigate('analytics');
  let tries = 0;
  const seek = () => {
    const t = [...document.querySelectorAll('#content .card-title')].find(x => x.textContent.trim() === 'Needs attention');
    if (t) t.closest('.card')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    else if (++tries < 30) setTimeout(seek, 100);
  };
  setTimeout(seek, 50);
}

// ── Building blocks ──────────────────────────────────────────────────────────
// A tappable row: [badge] title / sub ........ right ›
function row({ title, sub = '', right = null, rightTone = '', badge = null, icon = null, tone = '', onClick, testid = '' }) {
  const kids = [];
  const mark = icon || badge;
  if (mark) kids.push(el('span', { class: `home-icon${tone ? ` tone-${tone}` : ''}`, 'aria-hidden': 'true' }, mark));
  kids.push(el('span', { class: 'home-row-main' },
    el('span', { class: 'home-row-title' }, title),
    sub ? el('span', { class: 'home-row-sub' }, sub) : null));
  if (right != null) kids.push(el('span', { class: `home-row-right${rightTone ? ` tone-${rightTone}` : ''}` }, right));
  if (onClick) kids.push(el('span', { class: 'home-chev', 'aria-hidden': 'true' }, '›'));
  const attrs = { class: 'home-row', type: 'button' };
  if (testid) attrs['data-row'] = testid;
  const b = el(onClick ? 'button' : 'div', attrs, ...kids);
  if (onClick) b.addEventListener('click', onClick);
  return b;
}
function card(id, title, { sub = '', link = null, tone = '' } = {}, ...body) {
  const head = el('div', { class: 'home-card-head' },
    el('div', { class: 'home-card-titles' },
      el('h2', { class: 'home-card-title' }, title),
      sub ? el('div', { class: 'home-card-sub' }, sub) : null),
    link ? el('button', { class: 'home-link', type: 'button', onclick: link.onClick }, link.label) : null);
  return el('section', { class: `card home-card${tone ? ` home-card--${tone}` : ''}`, id: `home-${id}`, 'data-card': id }, head, ...body);
}
const groupLabel = (text, tone = '') => el('div', { class: `home-group${tone ? ` tone-${tone}` : ''}` }, text);

// ── 1. To do ─────────────────────────────────────────────────────────────────
// One list, three clearly separate parts — what needs doing comes first, data
// tidying and plain information are folded underneath so they never mix with
// it:  Action needed · Data to tidy · For your information.
// Each row: an icon for its kind, a plain-language title ("Collect rent ·
// Flat"), the detail and the amount. "Show all" expands in place.
const TODO_LIMIT = 5;
const _expanded = new Set();     // sections opened by the user (kept across redraws)

function attentionData(props, today) {
  const it = getAttentionItems(props, () => 1, today);
  // Calendar sync problems show in the status pill / sync card.
  it.checks = it.checks.filter(c => c.kind !== 'calsync');
  return it;
}

function todoItems(it, rerender) {
  const act = [], tidy = [], info = [];
  for (const o of it.overdue) act.push({ key: 'overdue', icon: '€', tone: 'danger', rank: 0,
    title: `Collect rent · ${o.prop.name}`, sub: `${plural(o.months, 'month')} unpaid · ${o.days} days late`,
    right: eur0(o.eur), rightTone: 'danger', onClick: () => navigate('payments') });
  for (const o of it.electricity) act.push({ key: 'electricity', icon: '⚡', tone: 'warning', rank: 1,
    title: `${o.kind === 'reading' ? 'Submit meter reading' : 'Check & pay electricity'} · ${o.prop.name}`,
    sub: o.kind === 'reading'
      ? `${o.c.period} — ${o.c.reading === 'overdue' ? `window closed ${fmtDate(o.c.windowTo)}` : `by ${fmtDate(o.c.windowTo)}`}`
      : `Invoice ${o.c.period}`,
    onClick: () => navigate('electricity') });
  for (const o of it.ending) act.push({ key: 'ending', icon: '⌛', tone: 'info', rank: 2,
    title: `Lease ending · ${o.prop.name}`, sub: `${o.tenant.name || 'Tenant'} · ${fmtDate(o.end)} (in ${plural(o.days, 'day')}) · no next lease`,
    onClick: () => navigate('tenants') });
  for (const o of it.empty) act.push({ key: 'empty', icon: '⌂', tone: 'warning', rank: 3,
    title: `Find a tenant · ${o.prop.name}`, sub: o.since ? `Empty since ${fmtDate(o.since)} (${plural(o.days, 'day')})` : 'No tenant recorded',
    right: o.missedEUR ? `≈ ${eur0(o.missedEUR)} missed` : null, rightTone: 'warning', onClick: () => navigate('tenants') });
  for (const c of it.checks) tidy.push({ key: 'checks', icon: '✎', tone: 'accent',
    title: c.prop.name, sub: c.text,
    onClick: c.kind === 'rent' ? () => openRentCheckModal(c.issue, rerender)
      : c.kind === 'overlap' ? () => navigate('tenants') : () => navigate('properties') });
  for (const o of it.idle) info.push({ key: 'idle', icon: o.kind === 'renovation' ? '⚒' : '☾', tone: 'muted',
    title: o.prop.name,
    sub: o.kind === 'renovation' ? `In renovation${o.since ? ` since ${fmtDate(o.since)}` : ''}`
      : (o.since ? `No bookings for ${plural(o.days, 'day')}, none upcoming` : 'No bookings recorded, none upcoming'),
    onClick: () => navigate(o.kind === 'renovation' ? 'properties' : 'str-rates') });
  act.sort((a, b) => a.rank - b.rank);
  return { act, tidy, info };
}

function section(id, title, items, { tone = '', collapsed = false, hint = '' } = {}) {
  if (!items.length) return null;
  const open = collapsed ? _expanded.has(id) : true;
  const showAll = _expanded.has(`${id}:all`);
  const wrap = el('div', { class: `home-section${tone ? ` tone-${tone}` : ''}`, 'data-section': id });
  const head = el(collapsed ? 'button' : 'div', { class: 'home-section-head', type: collapsed ? 'button' : undefined, 'aria-expanded': collapsed ? String(open) : undefined },
    el('span', { class: 'home-section-title' }, title),
    el('span', { class: 'home-section-count' }, String(items.length)),
    hint ? el('span', { class: 'home-section-hint' }, hint) : null,
    collapsed ? el('span', { class: 'home-section-caret', 'aria-hidden': 'true' }, open ? '▾' : '▸') : null);
  if (collapsed) head.addEventListener('click', () => { open ? _expanded.delete(id) : _expanded.add(id); draw(); });
  wrap.appendChild(head);
  if (!open) return wrap;
  const shown = showAll ? items : items.slice(0, TODO_LIMIT);
  for (const r of shown) wrap.appendChild(row({ ...r, testid: `attn-${r.key}` }));
  if (items.length > TODO_LIMIT) {
    wrap.appendChild(el('button', { class: 'home-more', type: 'button', onclick: () => { showAll ? _expanded.delete(`${id}:all`) : _expanded.add(`${id}:all`); draw(); } },
      showAll ? 'Show fewer' : `Show all ${items.length}`));
  }
  return wrap;
}

function buildAttention(it, rerender) {
  const { act, tidy, info } = todoItems(it, rerender);
  const total = act.length + tidy.length + info.length;
  if (!total) return null;
  const body = el('div', { class: 'home-list' },
    section('act', 'Action needed', act, { tone: act.some(a => a.tone === 'danger') ? 'danger' : 'warning' }),
    act.length ? null : el('div', { class: 'home-allclear' }, '✓ Nothing urgent'),
    section('tidy', 'Data to tidy', tidy, { tone: 'accent', collapsed: true, hint: 'records that don’t add up' }),
    section('info', 'For your information', info, { collapsed: true }));
  return { total, actions: act.length, urgent: act.some(a => a.tone === 'danger'), node: card('attention', 'To do', {
    sub: [act.length && plural(act.length, 'action'), tidy.length && `${tidy.length} to tidy`, info.length && `${info.length} FYI`].filter(Boolean).join(' · '),
    link: { label: 'Executive ›', onClick: openExecAttention } }, body) };
}

// ── STR bookings: payments + Airbnb calendar blocks ──────────────────────────
// One entry per stay, per short-term property. A calendar "Reserved" block
// with no recorded payment for the same stay still counts (booked on Airbnb,
// payout not imported yet); owner blocks ("Not available") never do.
function strStays(strProps) {
  const ids = new Set(strProps.map(p => p.id));
  const byProp = new Map(strProps.map(p => [p.id, []]));
  const seen = new Set();
  for (const x of listActivePayments()) {
    if (!ids.has(x.propertyId) || (x.status !== 'paid' && x.status !== 'pending') || !isReservationNight(x)) continue;
    const ci = x.airbnbCheckIn || x.checkIn || '', co = x.airbnbCheckOut || x.checkOut || '';
    if (!ci || !co || co <= ci) continue;
    const key = `${x.propertyId}|${x.confirmationCode || ''}|${ci}|${co}`;
    const key2 = `${x.propertyId}|${ci}|${co}`;
    if (seen.has(key) || (!x.confirmationCode && seen.has(key2))) continue;
    seen.add(key); seen.add(key2);
    byProp.get(x.propertyId).push({ ci, co, guest: x.guestName || (x.notes || '').split(' · ')[0] || '', source: 'payment' });
  }
  for (const cal of state.db.strCalendars || []) {
    if (cal.deletedAt || !byProp.has(cal.propertyId)) continue;
    const stays = byProp.get(cal.propertyId);
    for (const b of cal.blocks || []) {
      if (!b.start || !b.end || b.end <= b.start || isOwnerBlockSummary(b.summary)) continue;
      // Same stay already recorded as a payment (or overlapping one) → skip.
      if (stays.some(s => s.source === 'payment' && s.ci < b.end && b.start < s.co)) continue;
      stays.push({ ci: b.start, co: b.end, guest: '', source: 'calendar' });
    }
  }
  return byProp;
}

// ── 2. This week ─────────────────────────────────────────────────────────────
function weekEvents(props, strProps, stays, today) {
  const end = addDaysYmd(today, WEEK_DAYS - 1);
  const inWin = d => d && d >= today && d <= end;
  const ev = [];
  for (const p of strProps) {
    for (const s of stays.get(p.id) || []) {
      const who = s.guest || (s.source === 'calendar' ? 'Airbnb booking' : 'Guest');
      const go = () => navigate(s.source === 'calendar' ? 'str-rates' : 'payments');
      if (inWin(s.ci)) ev.push({ date: s.ci, order: 1, kind: 'checkin', badge: '↘', label: 'Check-in', tone: 'success', title: p.name,
        sub: `${who} · ${plural(diffDaysYmd(s.ci, s.co), 'night')}${s.source === 'calendar' ? ' · from the Airbnb calendar' : ''}`, onClick: go });
      if (inWin(s.co)) ev.push({ date: s.co, order: 0, kind: 'checkout', badge: '↗', label: 'Check-out', tone: 'muted', title: p.name, sub: who, onClick: go });
    }
  }
  for (const p of props) {
    if (p.type !== 'long_term' || p.status === 'sold') continue;
    const tenants = new Map(listActive('tenants').filter(t => t.propertyId === p.id).map(t => [t.id, t]));
    for (const e of generatePaymentSchedule(p)) {
      if (e.paid || !inWin(e.date)) continue;
      ev.push({ date: e.date, order: 2, kind: 'rent', badge: '€', label: 'Rent due', tone: 'info', title: p.name,
        sub: `${tenants.get(e.tenantId)?.name || 'Tenant'} · ${monthName(e.monthKey)} rent`, right: eur0(e.amountEUR || 0), onClick: () => navigate('payments') });
    }
  }
  const propName = new Map(props.map(p => [p.id, p.name]));
  for (const t of listActive('tenants')) {
    if (!propName.has(t.propertyId)) continue;
    if (t.status !== 'past' && inWin(t.leaseStartDate)) ev.push({ date: t.leaseStartDate, order: 3, kind: 'lease-start', badge: '⌂', label: 'Move-in', tone: 'success', title: propName.get(t.propertyId), sub: `${t.name || 'Tenant'} · lease starts`, onClick: () => navigate('tenants') });
    const leaseEnd = t.terminationDate && (!t.leaseEndDate || t.terminationDate < t.leaseEndDate) ? t.terminationDate : t.leaseEndDate;
    if (t.status !== 'prospective' && inWin(leaseEnd)) ev.push({ date: leaseEnd, order: 3, kind: 'lease-end', badge: '⌂', label: 'Move-out', tone: 'warning', title: propName.get(t.propertyId), sub: `${t.name || 'Tenant'} · lease ${t.terminationDate === leaseEnd ? 'terminates' : 'ends'}`, onClick: () => navigate('tenants') });
  }
  const clients = new Map(listActive('clients').map(c => [c.id, c.name]));
  for (const i of listActive('invoices')) {
    if (classifyInvoice(i, today) !== 'outstanding') continue;
    const due = invoiceDueDate(i);
    if (!inWin(due)) continue;
    ev.push({ date: due, order: 4, kind: 'invoice', badge: '#', label: 'Invoice due', tone: 'accent', title: `#${i.number || '—'} · ${clients.get(i.clientId) || i.clientName || 'Client'}`,
      sub: 'payment due', right: eur0(invoiceGrossEUR(i)), onClick: () => navigate('invoices') });
  }
  ev.sort((a, b) => a.date.localeCompare(b.date) || a.order - b.order || a.title.localeCompare(b.title));
  return ev;
}

function buildWeek(ev, today) {
  if (!ev.length) return null;
  const body = el('div', { class: 'home-list' });
  const counts = {};
  for (const e of ev) counts[e.kind] = (counts[e.kind] || 0) + 1;
  const sum = [
    counts.checkin && plural(counts.checkin, 'check-in'), counts.checkout && plural(counts.checkout, 'check-out'),
    counts.rent && plural(counts.rent, 'rent payment'), (counts['lease-start'] || counts['lease-end']) && plural((counts['lease-start'] || 0) + (counts['lease-end'] || 0), 'lease change'),
    counts.invoice && plural(counts.invoice, 'invoice')
  ].filter(Boolean).join(' · ');
  let last = '';
  const showAll = _expanded.has('week:all');
  for (const e of showAll ? ev : ev.slice(0, WEEK_MAX_ROWS)) {
    if (e.date !== last) { body.appendChild(groupLabel(dayLabel(e.date, today), e.date === today ? 'accent' : '')); last = e.date; }
    body.appendChild(row({ ...e, title: `${e.label} · ${e.title}`, testid: `week-${e.kind}` }));
  }
  if (ev.length > WEEK_MAX_ROWS) body.appendChild(el('button', { class: 'home-more', type: 'button', onclick: () => { showAll ? _expanded.delete('week:all') : _expanded.add('week:all'); draw(); } },
    showAll ? 'Show fewer' : `Show all ${ev.length} this week`));
  return card('week', 'This week', { sub: sum }, body);
}

// ── 3. Money ─────────────────────────────────────────────────────────────────
function moneyData(it, today) {
  const ym = today.slice(0, 7), prev = addMonthsYm(ym, -1);
  const dayN = +today.slice(8, 10);
  const prevSameDay = `${prev}-${String(Math.min(dayN, daysInMonth(+prev.slice(0, 4), +prev.slice(5, 7)))).padStart(2, '0')}`;
  const z = () => ({ rent: 0, str: 0, inv: 0 });
  const cur = z(), last = z(), lastToDate = z();
  const addTo = (k, d, v) => {
    if (d.startsWith(ym) && d <= today) cur[k] += v;
    else if (d.startsWith(prev)) { last[k] += v; if (d <= prevSameDay) lastToDate[k] += v; }
  };
  for (const p of listActivePayments()) {
    if (p.status !== 'paid' || !p.date) continue;
    const d = p.date.slice(0, 10);
    if (!d.startsWith(ym) && !d.startsWith(prev)) continue;
    const k = p.stream === 'short_term_rental' ? 'str' : isRentPayment(p) ? 'rent' : null;
    if (k) addTo(k, d, toEUR(p.amount, p.currency, d));
  }
  let overdueInv = 0, overdueN = 0;
  for (const i of listActive('invoices')) {
    const c = classifyInvoice(i, today);
    if (c === 'overdue') { overdueInv += invoiceGrossEUR(i); overdueN++; }
    const cd = invoiceCashDate(i);
    if (cd) addTo('inv', cd.slice(0, 10), invoiceNetEUR(i));
  }
  const tot = o => o.rent + o.str + o.inv;
  return { ym, prev, cur, last, lastToDate, tot, overdueInv, overdueN,
    overdueRent: it.overdue.reduce((s, o) => s + o.eur, 0), overdueRentN: it.overdue.length };
}

function delta(cur, ref) {
  if (!ref) return cur ? { text: 'new', tone: 'success' } : null;
  const pct = Math.round((cur - ref) / Math.abs(ref) * 100);
  return { text: `${pct > 0 ? '▲' : pct < 0 ? '▼' : ''}${Math.abs(pct)}%`, tone: pct >= 0 ? 'success' : 'danger' };
}

function buildMoney(m) {
  const { cur, last, lastToDate, tot } = m;
  if (!tot(cur) && !tot(last) && !m.overdueInv && !m.overdueRent) return null;
  const d = delta(tot(cur), tot(lastToDate));
  const hero = el('button', { class: 'home-money-hero', type: 'button', 'data-row': 'money-total', onclick: () => navigate('analytics-revenue') },
    el('span', { class: 'home-money-value' }, eur0(tot(cur)),
      d ? el('span', { class: `home-delta tone-${d.tone}` }, d.text) : null),
    el('span', { class: 'home-money-label' }, `collected so far · ${eur0(tot(lastToDate))} by this day in ${monthName(m.prev)} · ${eur0(tot(last))} all ${monthName(m.prev)}`));
  const body = el('div', { class: 'home-list' }, hero);
  const line = (label, k, route) => {
    if (!cur[k] && !last[k]) return;
    body.appendChild(row({ title: label, sub: `${monthName(m.prev)}: ${eur0(last[k])}`, right: eur0(cur[k]), onClick: () => navigate(route), testid: `money-${k}` }));
  };
  line('Long-term rent', 'rent', 'reconciliation');
  line('Short-term stays', 'str', 'analytics-str');
  line('Invoices paid', 'inv', 'analytics-revenue');
  if (m.overdueRent) body.appendChild(row({ title: 'Rent overdue', sub: plural(m.overdueRentN, 'property', 'properties'), right: eur0(m.overdueRent), rightTone: 'danger', onClick: () => navigate('payments'), testid: 'money-overdue-rent' }));
  if (m.overdueInv) body.appendChild(row({ title: 'Invoices overdue', sub: plural(m.overdueN, 'invoice'), right: eur0(m.overdueInv), rightTone: 'danger', onClick: () => navigate('invoices'), testid: 'money-overdue-inv' }));
  return card('money', `Money · ${monthName(m.ym)}`, { sub: 'Paid, cash basis, EUR', link: { label: 'Executive ›', onClick: () => navigate('analytics') } }, body);
}

// ── 4. Airbnb calendar sync ──────────────────────────────────────────────────
const ago = iso => {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const m = Math.round(ms / 60e3);
  return m < 60 ? `${Math.max(1, m)} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : fmtDate(iso.slice(0, 10));
};

function buildSync(strProps, rerender) {
  const linked = strProps.filter(p => p.airbnbCalUrl || (state.db.strCalendars || []).some(c => c.propertyId === p.id && !c.deletedAt && c.url));
  if (!linked.length) return null;
  const body = el('div', { class: 'home-list' });
  const refreshBtn = el('button', { class: 'btn sm', type: 'button', onclick: e => { e.stopPropagation(); refreshNow(rerender); } }, 'Refresh');
  const lp = lastPull();
  const problems = calendarSyncProblems();
  let tone = 'ok', summary;
  if (!calSyncSettings().secretKey) {
    tone = 'danger';
    summary = 'Not syncing automatically — set it up in STR Daily Rates';
  } else if (lp?.state === 'keyMismatch') {
    tone = 'danger'; summary = 'Calendar key in GitHub doesn’t match — calendars can’t be read';
  } else if (lp?.state === 'error') {
    tone = 'danger'; summary = `Couldn’t read the synced calendars: ${lp.message}`;
  } else if (problems.length) {
    tone = problems.some(x => x.kind === 'error') ? 'danger' : 'warning';
    summary = `${plural(problems.length, 'calendar')} not in sync`;
  } else {
    const times = linked.map(p => { const s = propertySyncStatus(p.id); return s.checkedAt || s.syncedAt || ''; }).filter(Boolean).sort();
    const latest = times.pop();
    summary = `${linked.length === 1 ? 'Calendar' : `All ${linked.length} calendars`} synced${latest ? ` ${ago(latest)}` : ''}`;
  }
  const icon = tone === 'ok' ? '✓' : '⚠';
  // A small status pill in the page header; a card only when something's wrong.
  const pill = el('div', { class: `home-sync tone-${tone === 'ok' ? 'success' : tone}`, 'data-row': 'sync-status' },
    el('span', { class: 'home-sync-icon', 'aria-hidden': 'true' }, icon),
    el('button', { class: 'home-sync-text', type: 'button', onclick: () => navigate('str-rates') }, summary),
    calSyncSettings().secretKey ? refreshBtn : null);
  const rows = problems.filter(p => p.prop);
  for (const x of rows) body.appendChild(row({ icon: '⚠', tone: 'warning', title: x.prop.name, sub: x.text.replace(/^Airbnb calendar /, ''), onClick: () => navigate('str-rates'), testid: 'sync-problem' }));
  return { tone, pill, node: tone === 'ok' || !rows.length ? null : card('sync', 'Airbnb calendars', { sub: summary }, body) };
}

// ── 5. Short-term nights ─────────────────────────────────────────────────────
function buildNights(strProps, stays, today) {
  if (!strProps.length) return null;
  const ym = today.slice(0, 7), next = addMonthsYm(ym, 1);
  const dim = mk => daysInMonth(+mk.slice(0, 4), +mk.slice(5, 7));
  const body = el('div', { class: 'home-list' });
  body.appendChild(el('div', { class: 'home-nights-head' },
    el('span', {}, ''), el('span', {}, monthName(ym)), el('span', {}, monthName(next))));
  for (const p of strProps) {
    const set = new Set();
    for (const s of stays.get(p.id) || []) for (const d of nights(s.ci < `${ym}-01` ? `${ym}-01` : s.ci, s.co)) {
      if (d.startsWith(ym) || d.startsWith(next)) set.add(d); else if (d > `${next}-31`) break;
    }
    let a = 0, b = 0;
    for (const d of set) { if (d.startsWith(ym)) a++; else b++; }
    const cell = (n, mk) => el('span', { class: 'home-nights-cell' },
      el('span', { class: 'home-nights-n' }, `${n}`, el('small', {}, `/${dim(mk)}`)),
      el('span', { class: 'home-bar' }, el('span', { style: `width:${Math.round(n / dim(mk) * 100)}%` })));
    const r = el('button', { class: 'home-nights-row', type: 'button', 'data-row': 'nights', onclick: () => navigate('str-rates') },
      el('span', { class: 'home-row-title' }, p.name), cell(a, ym), cell(b, next));
    body.appendChild(r);
  }
  return card('nights', 'Short-term nights booked', { sub: 'Recorded stays + Airbnb calendar', link: { label: 'STR ›', onClick: () => navigate('analytics-str') } }, body);
}

// ── Page ─────────────────────────────────────────────────────────────────────
function draw() {
  if (!_container) return;
  const t0 = performance.now();
  const today = todayYmd();
  const props = listActive('properties').filter(p => p.status !== 'sold');
  const strProps = props.filter(p => p.type === 'short_term');
  const rerender = () => draw();

  const safe = (name, fn) => { try { return fn(); } catch (e) { console.error(`[home] ${name}:`, e); return null; } };
  const it = safe('attention', () => attentionData(props, today)) || { overdue: [], empty: [], idle: [], ending: [], checks: [], electricity: [] };
  const stays = safe('stays', () => strStays(strProps)) || new Map();
  const ev = safe('week', () => weekEvents(props, strProps, stays, today)) || [];
  const attn = safe('attention card', () => buildAttention(it, rerender));
  const week = safe('week card', () => buildWeek(ev, today));
  const money = safe('money', () => buildMoney(moneyData(it, today)));
  const sync = safe('sync', () => buildSync(strProps, rerender));
  const nightsCard = safe('nights', () => buildNights(strProps, stays, today));

  const view = el('div', { class: 'view active home' });
  const m = safe('money data', () => moneyData(it, today));
  const scrollTo = target => () => document.getElementById(`home-${target}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  // Header: date, greeting, the calendar-sync pill, then four glance tiles.
  const weekday = parseYmd(today).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
  view.appendChild(el('header', { class: 'home-hero' },
    el('div', { class: 'home-hero-text' },
      el('div', { class: 'home-date' }, weekday),
      el('h1', { class: 'home-greeting' }, greeting())),
    sync?.pill || null));
  const tile = (label, value, sub, tone, onClick, id) => el('button', { class: `home-tile${tone ? ` tone-${tone}` : ''}`, type: 'button', 'data-tile': id, onclick: onClick },
    el('span', { class: 'home-tile-label' }, label),
    el('span', { class: 'home-tile-value' }, value),
    sub ? el('span', { class: 'home-tile-sub' }, sub) : null);
  const checkins = ev.filter(e => e.kind === 'checkin').length, checkouts = ev.filter(e => e.kind === 'checkout').length;
  const overdue = (m?.overdueRent || 0) + (m?.overdueInv || 0);
  const d = m ? delta(m.tot(m.cur), m.tot(m.lastToDate)) : null;
  view.appendChild(el('div', { class: 'home-tiles' },
    tile('To do', attn ? String(attn.actions) : '0', attn ? (attn.actions ? (attn.total > attn.actions ? `+${attn.total - attn.actions} to tidy / FYI` : 'actions') : 'nothing urgent') : 'all clear',
      attn?.urgent ? 'danger' : attn?.actions ? 'warning' : 'success', scrollTo('attention'), 'todo'),
    tile('This week', String(ev.length), ev.length ? [checkins && plural(checkins, 'check-in'), checkouts && plural(checkouts, 'check-out')].filter(Boolean).join(' · ') || plural(ev.length, 'event') : 'quiet week', '', scrollTo('week'), 'week'),
    tile(`Collected · ${m ? monthName(m.ym) : ''}`, m ? eur0(m.tot(m.cur)) : '—', d ? `${d.text} vs same day last month` : '', d?.tone === 'danger' ? '' : '', scrollTo('money'), 'collected'),
    tile('Overdue', eur0(overdue), overdue ? [m.overdueRentN && plural(m.overdueRentN, 'rent'), m.overdueN && plural(m.overdueN, 'invoice')].filter(Boolean).join(' · ') : 'nothing overdue', overdue ? 'danger' : 'success', scrollTo('money'), 'overdue')));

  // Two columns on wide screens: what to do (to-dos, this week) on the left,
  // the figures (money, occupancy, sync problems) on the right; one column on phones.
  const main = [attn?.node, week].filter(Boolean), side = [money, nightsCard, sync?.node].filter(Boolean);
  if (!main.length && !side.length) main.push(el('div', { class: 'card home-empty' }, 'Nothing here yet — add properties, tenants or invoices and today’s to-dos show up here.'));
  view.appendChild(el('div', { class: 'home-grid' },
    el('div', { class: 'home-col home-col--main' }, ...main),
    el('div', { class: 'home-col home-col--side' }, ...side)));

  _container.innerHTML = '';
  _container.appendChild(view);
  const ms = performance.now() - t0;
  if (ms > 150) console.info(`[home] rendered in ${Math.round(ms)} ms`);
}

export default {
  id: 'home',
  label: 'Home',
  icon: '🏡',
  render(container) {
    _container = container;
    if (!_onCalsync) {
      _onCalsync = () => { if (_container?.isConnected) draw(); };
      globalThis.addEventListener('calsync-updated', _onCalsync);
    }
    draw();
  },
  refresh() { draw(); },
  destroy() {
    if (_onCalsync) globalThis.removeEventListener('calsync-updated', _onCalsync);
    _onCalsync = null;
    _container = null;
  }
};
