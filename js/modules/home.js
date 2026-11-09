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
const ATTN_PER_GROUP = 3;     // rows per attention group before "+N more"
const WEEK_MAX_ROWS = 12;

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
function row({ title, sub = '', right = null, rightTone = '', badge = null, tone = '', onClick, testid = '' }) {
  const kids = [];
  if (badge) kids.push(el('span', { class: `home-badge${tone ? ` tone-${tone}` : ''}` }, badge));
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
const moreRow = (n, onClick) => el('button', { class: 'home-more', type: 'button', onclick: onClick }, `+ ${n} more`);

// ── 1. Needs attention ───────────────────────────────────────────────────────
function attentionData(props, today) {
  const it = getAttentionItems(props, () => 1, today);
  // Calendar sync problems get their own card below.
  it.checks = it.checks.filter(c => c.kind !== 'calsync');
  return it;
}

function buildAttention(it, rerender) {
  const groups = [];
  const add = (key, label, tone, rows) => { if (rows.length) groups.push({ key, label, tone, rows }); };
  add('overdue', 'Uncollected rent', 'danger', it.overdue.map(o => ({
    title: o.prop.name, sub: `${plural(o.months, 'month')} unpaid · ${o.days} days late`,
    right: eur0(o.eur), rightTone: 'danger', onClick: () => navigate('payments') })));
  add('electricity', 'Electricity', 'warning', it.electricity.map(o => ({
    title: o.prop.name,
    sub: o.kind === 'reading'
      ? `Meter reading ${o.c.period} — ${o.c.reading === 'overdue' ? `window closed ${fmtDate(o.c.windowTo)}` : `submit by ${fmtDate(o.c.windowTo)}`}`
      : `Invoice ${o.c.period} — check & pay`,
    onClick: () => navigate('electricity') })));
  add('ending', 'Leases ending', 'info', it.ending.map(o => ({
    title: o.prop.name, sub: `${o.tenant.name || 'Tenant'} · ends ${fmtDate(o.end)} (${o.days} days) · no next lease`,
    onClick: () => navigate('tenants') })));
  add('empty', 'Empty — no tenant', 'warning', it.empty.map(o => ({
    title: o.prop.name, sub: o.since ? `Empty since ${fmtDate(o.since)} (${o.days} days)` : 'No tenant recorded',
    right: o.missedEUR ? `≈ ${eur0(o.missedEUR)}` : null, rightTone: 'warning', onClick: () => navigate('tenants') })));
  add('idle', 'Idle / renovation', '', it.idle.map(o => ({
    title: o.prop.name,
    sub: o.kind === 'renovation' ? `In renovation${o.since ? ` since ${fmtDate(o.since)}` : ''}`
      : (o.since ? `No bookings for ${o.days} days, none upcoming` : 'No bookings recorded, none upcoming'),
    onClick: () => navigate(o.kind === 'renovation' ? 'properties' : 'str-rates') })));
  add('checks', 'Data to check', 'accent', it.checks.map(c => ({
    title: c.prop.name, sub: c.text,
    onClick: c.kind === 'rent' ? () => openRentCheckModal(c.issue, rerender)
      : c.kind === 'overlap' ? () => navigate('tenants') : () => navigate('properties') })));

  const total = groups.reduce((s, g) => s + g.rows.length, 0);
  if (!total) return null;
  const body = el('div', { class: 'home-list' });
  // Counts strip: one chip per group.
  body.appendChild(el('div', { class: 'home-counts' }, ...groups.map(g =>
    el('span', { class: `home-count${g.tone ? ` tone-${g.tone}` : ''}` }, el('b', {}, String(g.rows.length)), ` ${g.label}`))));
  for (const g of groups) {
    body.appendChild(groupLabel(`${g.label} (${g.rows.length})`, g.tone));
    for (const r of g.rows.slice(0, ATTN_PER_GROUP)) body.appendChild(row({ ...r, testid: `attn-${g.key}` }));
    if (g.rows.length > ATTN_PER_GROUP) body.appendChild(moreRow(g.rows.length - ATTN_PER_GROUP, openExecAttention));
  }
  return { total, node: card('attention', 'Needs attention', {
    sub: plural(total, 'item'), tone: it.overdue.length ? 'danger' : 'warning',
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
      if (inWin(s.ci)) ev.push({ date: s.ci, order: 1, kind: 'checkin', badge: 'Check-in', tone: 'success', title: p.name,
        sub: `${who} · ${plural(diffDaysYmd(s.ci, s.co), 'night')}${s.source === 'calendar' ? ' · from the Airbnb calendar' : ''}`, onClick: go });
      if (inWin(s.co)) ev.push({ date: s.co, order: 0, kind: 'checkout', badge: 'Check-out', tone: 'muted', title: p.name, sub: who, onClick: go });
    }
  }
  for (const p of props) {
    if (p.type !== 'long_term' || p.status === 'sold') continue;
    const tenants = new Map(listActive('tenants').filter(t => t.propertyId === p.id).map(t => [t.id, t]));
    for (const e of generatePaymentSchedule(p)) {
      if (e.paid || !inWin(e.date)) continue;
      ev.push({ date: e.date, order: 2, kind: 'rent', badge: 'Rent due', tone: 'info', title: p.name,
        sub: `${tenants.get(e.tenantId)?.name || 'Tenant'} · ${monthName(e.monthKey)} rent`, right: eur0(e.amountEUR || 0), onClick: () => navigate('payments') });
    }
  }
  const propName = new Map(props.map(p => [p.id, p.name]));
  for (const t of listActive('tenants')) {
    if (!propName.has(t.propertyId)) continue;
    if (t.status !== 'past' && inWin(t.leaseStartDate)) ev.push({ date: t.leaseStartDate, order: 3, kind: 'lease-start', badge: 'Move-in', tone: 'success', title: propName.get(t.propertyId), sub: `${t.name || 'Tenant'} · lease starts`, onClick: () => navigate('tenants') });
    const leaseEnd = t.terminationDate && (!t.leaseEndDate || t.terminationDate < t.leaseEndDate) ? t.terminationDate : t.leaseEndDate;
    if (t.status !== 'prospective' && inWin(leaseEnd)) ev.push({ date: leaseEnd, order: 3, kind: 'lease-end', badge: 'Move-out', tone: 'warning', title: propName.get(t.propertyId), sub: `${t.name || 'Tenant'} · lease ${t.terminationDate === leaseEnd ? 'terminates' : 'ends'}`, onClick: () => navigate('tenants') });
  }
  const clients = new Map(listActive('clients').map(c => [c.id, c.name]));
  for (const i of listActive('invoices')) {
    if (classifyInvoice(i, today) !== 'outstanding') continue;
    const due = invoiceDueDate(i);
    if (!inWin(due)) continue;
    ev.push({ date: due, order: 4, kind: 'invoice', badge: 'Invoice due', tone: 'accent', title: `#${i.number || '—'} · ${clients.get(i.clientId) || i.clientName || 'Client'}`,
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
  for (const e of ev.slice(0, WEEK_MAX_ROWS)) {
    if (e.date !== last) { body.appendChild(groupLabel(dayLabel(e.date, today), e.date === today ? 'accent' : '')); last = e.date; }
    body.appendChild(row({ ...e, testid: `week-${e.kind}` }));
  }
  if (ev.length > WEEK_MAX_ROWS) body.appendChild(el('div', { class: 'home-note' }, `+ ${ev.length - WEEK_MAX_ROWS} more this week`));
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
    el('span', { class: 'home-money-label' }, `Collected in ${monthName(m.ym)} so far`),
    el('span', { class: 'home-money-value' }, eur0(tot(cur)),
      d ? el('span', { class: `home-delta tone-${d.tone}` }, d.text) : null),
    el('span', { class: 'home-money-label' }, `${eur0(tot(lastToDate))} by this day in ${monthName(m.prev)} · ${eur0(tot(last))} all ${monthName(m.prev)}`));
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
  return card('money', 'Money', { sub: 'Paid, cash basis, EUR', link: { label: 'Executive ›', onClick: () => navigate('analytics') } }, body);
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
  body.appendChild(el('div', { class: `home-sync tone-${tone === 'ok' ? 'success' : tone}`, 'data-row': 'sync-status' },
    el('span', { class: 'home-sync-icon', 'aria-hidden': 'true' }, icon),
    el('button', { class: 'home-sync-text', type: 'button', onclick: () => navigate('str-rates') }, summary),
    calSyncSettings().secretKey ? refreshBtn : null));
  for (const x of problems.filter(p => p.prop)) {
    body.appendChild(row({ title: x.prop.name, sub: x.text.replace(/^Airbnb calendar /, ''), onClick: () => navigate('str-rates'), testid: 'sync-problem' }));
  }
  return { tone, node: card('sync', 'Airbnb calendars', {}, body) };
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

// Masonry: 1 column on phones, 2–3 on wider screens. Cards go, in priority
// order, into whichever column is shortest so far — no empty column and no
// gaps under short cards. Re-laid out only when the column count changes.
const columnsFor = w => (w >= 900 ? 3 : w >= 600 ? 2 : 1);
let _ro = null;
function layoutGrid(grid, cards) {
  const place = () => {
    const n = columnsFor(grid.clientWidth || window.innerWidth);
    if (grid.dataset.cols === String(n) && grid.childNodes.length) return;
    grid.dataset.cols = String(n);
    grid.style.setProperty('--home-cols', n);
    grid.innerHTML = '';
    const cols = Array.from({ length: n }, () => grid.appendChild(el('div', { class: 'home-col' })));
    for (const c of cards) cols.reduce((a, b) => (b.offsetHeight < a.offsetHeight ? b : a)).appendChild(c);
  };
  place();
  _ro?.disconnect();
  _ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { if (grid.isConnected) place(); else _ro?.disconnect(); }) : null;
  _ro?.observe(grid);
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
  // Greeting + glance chips (each scrolls to its card).
  const chips = [];
  const chip = (target, text, tone) => chips.push(el('button', { class: `home-chip tone-${tone}`, type: 'button',
    onclick: () => document.getElementById(`home-${target}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }, text));
  if (attn) chip('attention', plural(attn.total, 'thing') + ' to check', it.overdue.length ? 'danger' : 'warning');
  const checkins = ev.filter(e => e.kind === 'checkin');
  if (checkins.length) chip('week', plural(checkins.length, 'check-in') + ' this week', 'success');
  else if (ev.length) chip('week', plural(ev.length, 'event') + ' this week', 'info');
  if (sync && sync.tone !== 'ok') chip('sync', 'Calendar sync needs a look', sync.tone);
  if (!attn && !ev.length) chips.push(el('span', { class: 'home-chip tone-success' }, '✓ All clear today'));
  const weekday = parseYmd(today).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  view.appendChild(el('header', { class: 'home-hero' },
    el('div', { class: 'home-date' }, weekday),
    el('h1', { class: 'home-greeting' }, greeting()),
    chips.length ? el('div', { class: 'home-chips' }, ...chips) : null));

  const grid = el('div', { class: 'home-grid' });
  const cards = [attn?.node, week, money, sync?.node, nightsCard].filter(Boolean);
  if (!cards.length) cards.push(el('div', { class: 'card home-empty' }, 'Nothing here yet — add properties, tenants or invoices and today’s to-dos show up here.'));
  view.appendChild(grid);

  _container.innerHTML = '';
  _container.appendChild(view);
  layoutGrid(grid, cards);
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
    _ro?.disconnect();
    _ro = null;
    _container = null;
  }
};
