// Electricity meter readings & invoices for the Hungarian flats.
//
// Each Hungarian property can have a repeating reading window (e.g. the 1st–5th
// of every month, or every 2 months from a start month). Each cycle has two
// steps the owner tracks:
//   1. the meter reading is submitted in the provider's system (in the window);
//   2. the provider posts the invoice ~N days later — it's checked and paid,
//      which books an Electricity expense on the property.
// A flat whose current tenant pays the provider directly
// (tenant.electricityPaidBy === 'tenant') is left out of that cycle.
//
// Config lives on the property (`electricity`), the per-cycle record in the
// `electricityCycles` collection (id `${propertyId}|${period}`), and the
// messaging accounts/template in settings.electricity.
import { state, runBatch } from './state.js';
import { listActive, byId, upsert, softDelete, newId, currentLeases } from './data.js';
import { todayYmd, addDaysYmd, addMonthsYmd, daysInMonth } from './dates.js';

export const DEFAULT_ELEC_CONFIG = { active: true, windowFrom: 1, windowTo: 5, everyMonths: 1, invoiceDelayDays: 10, startMonth: '' };
export const DEFAULT_READING_TEMPLATE =
  'Hi {tenant}, could you please send me a photo of the electricity meter at {property} between {from} and {to}? Thank you!';
// How many days before the window opens the "message tenant" step shows.
export const MESSAGE_LEAD_DAYS = 3;

export const isHungary = p => /^(hungary|magyarország|magyarorszag|hu)$/i.test(String(p?.country || '').trim());

export function elecConfig(p) {
  const c = p?.electricity;
  if (!c) return null;
  return { ...DEFAULT_ELEC_CONFIG, ...c };
}

export function electricityProperties() {
  return listActive('properties').filter(p => isHungary(p) && p.status !== 'sold');
}

const dayIn = (ym, d) => `${ym}-${String(Math.min(Math.max(1, d), daysInMonth(+ym.slice(0, 4), +ym.slice(5, 7)))).padStart(2, '0')}`;
const addMonthsYm = (ym, n) => addMonthsYmd(`${ym}-01`, n).slice(0, 7);

export const cycleId = (propertyId, period) => `${propertyId}|${period}`;
const recordOf = (propertyId, period) => {
  const r = byId('electricityCycles', cycleId(propertyId, period));
  return r && !r.deletedAt ? r : null;
};

// The tenant whose lease covers the start of the reading window (the one to
// ask for the reading), and whether they pay the provider themselves.
function tenantFor(p, day) {
  const leases = currentLeases(p.id, day);
  return leases.sort((a, b) => (b.leaseStartDate || '').localeCompare(a.leaseStartDate || ''))[0] || null;
}

function buildCycle(p, cfg, period, today) {
  const windowFrom = dayIn(period, cfg.windowFrom);
  const windowTo = dayIn(period, Math.max(cfg.windowFrom, cfg.windowTo));
  const rec = recordOf(p.id, period);
  const tenant = tenantFor(p, windowFrom);
  const excluded = tenant?.electricityPaidBy === 'tenant';
  const readingDone = !!rec?.readingAt;
  const invoiceDue = addDaysYmd(rec?.readingAt || windowTo, Math.max(0, Number(cfg.invoiceDelayDays) || 0));
  const invoiceDone = !!rec?.paidAt;
  const reading = readingDone ? 'done' : today < windowFrom ? 'upcoming' : today <= windowTo ? 'open' : 'overdue';
  const invoice = invoiceDone ? 'done' : !readingDone ? 'waiting' : today < invoiceDue ? 'upcoming' : 'due';
  return {
    id: cycleId(p.id, period), property: p, period, windowFrom, windowTo, invoiceDue, record: rec,
    tenant, excluded, reading, invoice,
    complete: excluded || (readingDone && invoiceDone),
    messageable: !excluded && !readingDone && !!tenant && addDaysYmd(windowFrom, -MESSAGE_LEAD_DAYS) <= today
  };
}

// Every cycle of a property from its start month up to the next one that
// hasn't opened yet (so the upcoming window is always listed).
export function cyclesFor(p, today = todayYmd()) {
  const cfg = elecConfig(p);
  if (!cfg || cfg.active === false) return [];
  const every = Math.min(Math.max(1, Math.floor(Number(cfg.everyMonths)) || 1), 12);
  const start = /^\d{4}-\d{2}$/.test(cfg.startMonth) ? cfg.startMonth : (p.electricity?.createdMonth || today.slice(0, 7));
  const out = [];
  for (let k = 0, period = start; k < 600; k++, period = addMonthsYm(start, k * every)) {
    const c = buildCycle(p, cfg, period, today);
    out.push(c);
    if (c.windowFrom > today) break;
  }
  return out;
}

// The rows the tracker shows: per property, every cycle that still needs a
// step plus the latest finished one and the upcoming one; `history` adds all.
export function electricityRows(today = todayYmd(), { history = false } = {}) {
  const rows = [];
  for (const p of electricityProperties()) {
    const cs = cyclesFor(p, today);
    if (!cs.length) continue;
    const lastDone = [...cs].reverse().find(c => c.complete && c.windowFrom <= today);
    for (const c of cs) {
      const upcoming = c.windowFrom > today;
      if (history || !c.complete || upcoming || c === lastDone) rows.push(c);
    }
  }
  return rows.sort((a, b) => a.windowFrom.localeCompare(b.windowFrom) || a.property.name.localeCompare(b.property.name));
}

// Steps needing action now: readings whose window is open or past, invoices
// due. Drives the sidebar badge and the Needs-attention card.
export function electricityActions(today = todayYmd()) {
  const readings = [], invoices = [];
  for (const p of electricityProperties()) {
    for (const c of cyclesFor(p, today)) {
      if (c.excluded) continue;
      if (c.reading === 'open' || c.reading === 'overdue') readings.push(c);
      if (c.invoice === 'due') invoices.push(c);
    }
  }
  return { readings, invoices, count: readings.length + invoices.length };
}

function saveRecord(c, patch) {
  const prev = recordOf(c.property.id, c.period) || { id: c.id, propertyId: c.property.id, period: c.period };
  const next = { ...prev, ...patch };
  for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
  upsert('electricityCycles', next);
  return next;
}

// Step 1: reading submitted to the provider (date, meter reading in kWh).
export function markReading(c, { date, kwh, note = '' }) {
  return saveRecord(c, { readingAt: date, kwh: kwh === '' || kwh == null ? undefined : Number(kwh), note: note || undefined });
}
export function undoReading(c) {
  if (c.record?.paidAt) throw new Error('Undo the invoice first');
  return saveRecord(c, { readingAt: undefined, kwh: undefined, note: undefined });
}

// Step 2: invoice checked & paid — books an Electricity expense on the
// property (with the provider as vendor when one is set) and links it.
export function markInvoicePaid(c, { date, amount, currency, invoiceNo = '' }) {
  const p = c.property;
  const providerId = state.db.settings?.electricity?.providerVendorId || '';
  const provider = providerId ? byId('vendors', providerId) : null;
  const linked = c.record?.expenseId ? byId('expenses', c.record.expenseId) : null;
  let rec;
  runBatch(() => {
    const expense = {
      ...(linked && !linked.deletedAt ? linked : {}),
      id: linked && !linked.deletedAt ? linked.id : newId('exp'),
      propertyId: p.id,
      category: 'electricity',
      amount: Number(amount),
      currency: currency || p.currency || 'HUF',
      date,
      stream: p.type === 'short_term' ? 'short_term_rental' : 'long_term_rental',
      description: `Electricity invoice ${c.period}${invoiceNo ? ` · ${invoiceNo}` : ''}${c.record?.kwh != null ? ` · reading ${c.record.kwh} kWh` : ''}`,
      electricityCycleId: c.id,
      ...(provider ? { vendorId: provider.id, vendor: provider.name } : {})
    };
    upsert('expenses', expense);
    rec = saveRecord(c, { paidAt: date, invoiceAmount: Number(amount), invoiceCurrency: expense.currency, invoiceNo: invoiceNo || undefined, expenseId: expense.id });
  });
  return rec;
}
export function undoInvoice(c) {
  runBatch(() => {
    const e = c.record?.expenseId ? byId('expenses', c.record.expenseId) : null;
    if (e && !e.deletedAt) softDelete('expenses', e.id);
    saveRecord(c, { paidAt: undefined, invoiceAmount: undefined, invoiceCurrency: undefined, invoiceNo: undefined, expenseId: undefined });
  });
}

export function markMessaged(c, { via, accountId }) {
  return saveRecord(c, { messagedAt: todayYmd(), messagedVia: via, messagedAccountId: accountId || undefined, messagedFrom: undefined });
}

// ── Messages to tenants ───────────────────────────────────────────────────────
export function messagingSettings() {
  const s = state.db.settings?.electricity || {};
  return { accounts: s.accounts || [], defaultAccountId: s.defaultAccountId || '', template: s.template || DEFAULT_READING_TEMPLATE, providerVendorId: s.providerVendorId || '' };
}

export function fillTemplate(tpl, c, fmt = d => d) {
  return String(tpl)
    .replaceAll('{tenant}', (c.tenant?.name || '').split(' ')[0] || 'there')
    .replaceAll('{property}', c.property.name || '')
    .replaceAll('{from}', fmt(c.windowFrom))
    .replaceAll('{to}', fmt(c.windowTo));
}

const digits = n => (n || '').replace(/[^\d+]/g, '').replace(/^00/, '+').replace(/\+/g, '');
// How to reach the tenant: their preferred contact if it's possible, else
// WhatsApp, Viber, email. Returns { via, href, copyText? } or null.
export function messageLink(t, text) {
  if (!t) return null;
  const wa = digits(t.whatsapp || t.phone), vb = digits(t.viber || t.phone);
  const ways = {
    whatsapp: wa && { via: 'whatsapp', href: `https://wa.me/${wa}?text=${encodeURIComponent(text)}` },
    // Viber can't pre-fill a chat with a given number: the text is copied and the chat opened.
    viber: vb && { via: 'viber', href: `viber://chat?number=%2B${vb}`, copyText: text },
    email: t.email && { via: 'email', href: `mailto:${encodeURIComponent(t.email).replace(/%40/g, '@')}?subject=${encodeURIComponent('Electricity meter reading')}&body=${encodeURIComponent(text)}` },
    call: digits(t.phone) && { via: 'call', href: `tel:+${digits(t.phone)}` }
  };
  const pref = t.preferredContact;
  return (pref && ways[pref]) || ways.whatsapp || ways.viber || ways.email || ways.call || null;
}

// ── Calendar reminders (.ics) with one-tap message links ──────────────────────
// Google Calendar can't import a file from its phone app, so each event also
// gets an "add to Google Calendar" link: Google's event form, pre-filled with
// the repeat rule (times in Hungarian time), saved with one tap.
export function googleCalendarLink({ title, details, start, end, rrule }) {
  const q = new URLSearchParams({ action: 'TEMPLATE', text: title, dates: `${start}/${end}`, details, recur: rrule, ctz: 'Europe/Budapest' });
  return `https://calendar.google.com/calendar/render?${q}`;
}

// One repeating event per tracked flat with a tenant to ask, on the day the
// reading window opens, at 9:00 with an alert. The event carries a link to the
// app's #go= hand-over (js/go.js), which opens WhatsApp / Viber / email with
// the message and notes "sent" for the app (applySentMarks).
const ordinal = n => `${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`;
const b64url = s => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function goLink(baseUrl, t, text, propertyId) {
  let ml = messageLink(t, text);
  if (ml?.via === 'call') ml = messageLink({ ...t, preferredContact: '' }, text); // a call can't carry the message
  if (!ml || ml.via === 'call') return null;
  const n = ml.via === 'whatsapp' ? digits(t.whatsapp || t.phone) : ml.via === 'viber' ? digits(t.viber || t.phone) : '';
  const payload = { c: ml.via[0], t: text, p: propertyId, ...(n ? { n } : {}), ...(ml.via === 'email' ? { e: t.email } : {}) };
  return { via: ml.via, url: `${baseUrl}#go=${b64url(JSON.stringify(payload))}` };
}

const icsEscape = s => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
// Lines longer than 75 octets are folded (RFC 5545), never inside a UTF-8 character.
function icsFold(line) {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const out = [];
  let cur = '', len = 0;
  for (const ch of line) {
    const l = enc.encode(ch).length;
    if (len + l > (out.length ? 74 : 75)) { out.push(cur); cur = ''; len = 0; }
    cur += ch; len += l;
  }
  out.push(cur);
  return out.join('\r\n ');
}
const icsDate = ymd => ymd.replace(/-/g, '');

// { ics, hash, events: [{ property, tenant, via }], skipped: [{ property, reason }] } —
// hash covers everything but the creation stamp, so the app can tell when a
// downloaded file is stale; `skipped` says why a flat has no reminder.
export function buildCalendar(baseUrl, today = todayYmd()) {
  const tpl = messagingSettings().template;
  const events = [], body = [], skipped = [];
  for (const p of electricityProperties()) {
    const cfg = elecConfig(p);
    if (!cfg) { skipped.push({ property: p, reason: 'reading window not set up' }); continue; }
    if (cfg.active === false) { skipped.push({ property: p, reason: 'tracking switched off' }); continue; }
    const cs = cyclesFor(p, today);
    const c = cs.find(x => x.windowTo >= today);
    if (!c) { skipped.push({ property: p, reason: 'no upcoming reading window' }); continue; }
    if (c.excluded) { skipped.push({ property: p, reason: 'tenant pays the electricity directly' }); continue; }
    if (!c.tenant) { skipped.push({ property: p, reason: 'no current tenant' }); continue; }
    const t = c.tenant;
    const text = fillTemplate(tpl, c, d => `the ${ordinal(Number(d.slice(8, 10)))}`);
    const link = goLink(baseUrl, t, text, p.id);
    if (!link) { skipped.push({ property: p, reason: `no phone number or email on ${t.name || 'the tenant'}` }); continue; }
    const every = Math.min(Math.max(1, Math.floor(Number(cfg.everyMonths)) || 1), 12);
    const day = Number(cfg.windowFrom);
    // Days past 28 fall on the month's last day in short months, as in the tracker.
    const byDay = day > 28 ? `BYMONTHDAY=${Array.from({ length: day - 27 }, (_, i) => 28 + i).join(',')};BYSETPOS=-1` : `BYMONTHDAY=${day}`;
    const end = [t.leaseEndDate, t.terminationDate].filter(Boolean).sort()[0];
    const first = (t.name || '').split(' ')[0] || 'tenant';
    const how = link.via === 'whatsapp' ? `Tap to send it on WhatsApp: ${link.url}`
      : link.via === 'viber' ? `Tap to open Viber with the message, then pick ${first}: ${link.url}`
      : `Tap to email it: ${link.url}`;
    const title = `Electricity reading: ${p.name} (${first})`;
    const details = `Ask ${first} for the meter reading (window day ${cfg.windowFrom}–${cfg.windowTo}).\n\n${how}\n\nMessage:\n${text}`;
    const rrule = `RRULE:FREQ=MONTHLY;INTERVAL=${every};${byDay}${end ? `;UNTIL=${icsDate(end)}T235959` : ''}`;
    body.push(
      'BEGIN:VEVENT',
      `UID:elec-${p.id}@business-tracking`,
      `DTSTART:${icsDate(c.windowFrom)}T090000`,
      'DURATION:PT15M',
      rrule,
      `SUMMARY:${icsEscape(title)}`,
      `DESCRIPTION:${icsEscape(details)}`,
      `URL:${link.url}`,
      'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsEscape(`Electricity reading: ${p.name}`)}`, 'TRIGGER:PT0M', 'END:VALARM',
      'END:VEVENT'
    );
    events.push({ property: p, tenant: t, via: link.via,
      google: googleCalendarLink({ title, details, start: `${icsDate(c.windowFrom)}T090000`, end: `${icsDate(c.windowFrom)}T091500`, rrule }) });
  }
  const content = body.join('\n');
  let hash = 5381;
  for (let i = 0; i < content.length; i++) hash = ((hash * 33) ^ content.charCodeAt(i)) >>> 0;
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Business Tracking//Electricity readings//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    ...body.flatMap(l => l === 'BEGIN:VEVENT' ? [l, `DTSTAMP:${stamp}`] : [l]), 'END:VCALENDAR'];
  return { ics: lines.map(icsFold).join('\r\n') + '\r\n', hash: hash.toString(36), events, skipped };
}

// "Sent" notes left by js/go.js when a calendar link was tapped in this
// browser: each marks the cycle it belongs to (the latest whose window had
// opened, or was about to, on that day) as messaged. Notes for properties not
// loaded yet are kept for 60 days; returns how many were applied.
export function applySentMarks(today = todayYmd()) {
  let q;
  try { q = JSON.parse(localStorage.getItem('bt_elec_sent') || '[]'); } catch { return 0; }
  if (!Array.isArray(q) || !q.length) return 0;
  const via = { w: 'whatsapp', v: 'viber', e: 'email' };
  const keep = [];
  let applied = 0;
  for (const m of q) {
    const p = m && byId('properties', m.p);
    if (!p || p.deletedAt || !/^\d{4}-\d{2}-\d{2}$/.test(m.at || '')) {
      if (m && /^\d{4}-\d{2}-\d{2}$/.test(m.at || '') && m.at >= addDaysYmd(today, -60)) keep.push(m);
      continue;
    }
    const c = [...cyclesFor(p, m.at)].reverse().find(x => x.windowFrom <= addDaysYmd(m.at, MESSAGE_LEAD_DAYS));
    if (!c) { if (m.at >= addDaysYmd(today, -60)) keep.push(m); continue; } // window not set up (yet)
    if (!(c.record?.messagedAt && c.record.messagedAt >= addDaysYmd(c.windowFrom, -MESSAGE_LEAD_DAYS))) {
      saveRecord(c, { messagedAt: m.at, messagedVia: via[m.c] || 'whatsapp', messagedFrom: 'calendar' });
      applied++;
    }
  }
  try { if (keep.length) localStorage.setItem('bt_elec_sent', JSON.stringify(keep)); else localStorage.removeItem('bt_elec_sent'); } catch { /* ignore */ }
  return applied;
}
