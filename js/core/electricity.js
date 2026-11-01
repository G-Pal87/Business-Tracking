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
// Reading-request message per language; each tenant picks one
// (tenant.messageLanguage, default English).
export const MESSAGE_LANGUAGES = { en: 'English', hu: 'Magyar' };
export const DEFAULT_TEMPLATES = {
  en: 'Hi {tenant}, could you please send me a photo of the electricity meter at {property} between {from} and {to}? Thank you!',
  hu: 'Kedves {tenant}! Kérem, küldjön egy fotót a villanyóra állásáról ({property}) {from} és {to} között. Köszönöm!'
};
const EMAIL_SUBJECT = { en: 'Electricity meter reading', hu: 'Villanyóra-állás' };
export const langOf = t => (t?.messageLanguage === 'hu' ? 'hu' : 'en');
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

// The provider a flat's invoices go to: the vendor on its latest paid
// electricity invoice, else the default provider (settings).
export function providerFor(p) {
  const last = listActive('expenses').filter(e => e.propertyId === p.id && e.electricityCycleId && e.vendorId)
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''))[0];
  const id = last?.vendorId || state.db.settings?.electricity?.providerVendorId || '';
  const v = id ? byId('vendors', id) : null;
  return v && !v.deletedAt ? v : null;
}

// Step 2: invoice checked & paid — books an Electricity expense on the
// property and links it. `vendorId`: the vendor paid (e.g. E.ON); omitted →
// the default provider from settings, '' → no vendor.
export function markInvoicePaid(c, { date, amount, currency, invoiceNo = '', vendorId }) {
  const p = c.property;
  const providerId = vendorId !== undefined ? vendorId : (state.db.settings?.electricity?.providerVendorId || '');
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
    if (!provider) { delete expense.vendorId; delete expense.vendor; }
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
  // `template` was the single (English) text before languages were added.
  const templates = { en: s.templates?.en || s.template || DEFAULT_TEMPLATES.en, hu: s.templates?.hu || DEFAULT_TEMPLATES.hu };
  return { accounts: s.accounts || [], defaultAccountId: s.defaultAccountId || '', templates, template: templates.en, providerVendorId: s.providerVendorId || '' };
}

// Dates in the message, in the tenant's language: a real date in the app
// ("Nov 1, 2026" / "november 1."), a day of the month in the repeating
// calendar reminder ("the 1st" / "1.").
const HU_MONTHS = ['január', 'február', 'március', 'április', 'május', 'június', 'július', 'augusztus', 'szeptember', 'október', 'november', 'december'];
const EN_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function messageDate(ymd, lang, calendar) {
  const d = Number(ymd.slice(8, 10)), m = Number(ymd.slice(5, 7)) - 1;
  if (calendar) return lang === 'hu' ? `${d}.` : `the ${ordinal(d)}`;
  return lang === 'hu' ? `${HU_MONTHS[m]} ${d}.` : `${EN_MONTHS[m]} ${d}, ${ymd.slice(0, 4)}`;
}

// The reading request for a cycle, in its tenant's language.
export function messageFor(c, { calendar = false } = {}) {
  const lang = langOf(c.tenant);
  return fillTemplate(messagingSettings().templates[lang], c, d => messageDate(d, lang, calendar));
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
    email: t.email && { via: 'email', href: `mailto:${encodeURIComponent(t.email).replace(/%40/g, '@')}?subject=${encodeURIComponent(EMAIL_SUBJECT[langOf(t)])}&body=${encodeURIComponent(text)}` },
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
  const payload = { c: ml.via[0], t: text, p: propertyId, ...(n ? { n } : {}), ...(ml.via === 'email' ? { e: t.email, s: EMAIL_SUBJECT[langOf(t)] } : {}) };
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

const strHash = str => { let h = 5381; for (let i = 0; i < str.length; i++) h = ((h * 33) ^ str.charCodeAt(i)) >>> 0; return h.toString(36); };
// Monthly repeat on a day of the month; days past 28 fall on the month's last
// day in short months, as in the tracker.
const byMonthDay = day => (day > 28 ? `BYMONTHDAY=${Array.from({ length: day - 27 }, (_, i) => 28 + i).join(',')};BYSETPOS=-1` : `BYMONTHDAY=${day}`);

// Two repeating events per tracked flat:
//   reading — on the day the window opens, with the one-tap message link
//             (needs a tenant with a phone/email);
//   invoice — on the window's last day + the invoice delay, to check & pay
//             the provider's invoice and mark it paid in the app.
// Returns { ics, hash, hashes: {propertyId: hash}, events: [{ kind,
// property, tenant?, via?, google }], skipped: [{ property, reason }] } —
// the hashes cover everything but the creation stamp, so the app can tell
// which flats' reminders are missing or out of date; `skipped` says why a flat
// has no reading reminder. `propertyIds` limits it to those flats.
export function buildCalendar(baseUrl, today = todayYmd(), { propertyIds = null } = {}) {
  const events = [], skipped = [], hashes = {};
  const bodies = [];
  for (const p of electricityProperties()) {
    if (propertyIds && !propertyIds.includes(p.id)) continue;
    const cfg = elecConfig(p);
    if (!cfg) { skipped.push({ property: p, reason: 'reading window not set up' }); continue; }
    if (cfg.active === false) { skipped.push({ property: p, reason: 'tracking switched off' }); continue; }
    const cs = cyclesFor(p, today);
    const c = cs.find(x => x.windowTo >= today);
    if (!c) { skipped.push({ property: p, reason: 'no upcoming reading window' }); continue; }
    if (c.excluded) { skipped.push({ property: p, reason: 'tenant pays the electricity directly' }); continue; }
    const every = Math.min(Math.max(1, Math.floor(Number(cfg.everyMonths)) || 1), 12);
    const t = c.tenant;
    const end = t ? [t.leaseEndDate, t.terminationDate].filter(Boolean).sort()[0] : '';
    const until = end ? `;UNTIL=${icsDate(end)}T235959` : '';
    const body = [];
    const add = (kind, start, day, title, details, url, extra) => {
      const rrule = `RRULE:FREQ=MONTHLY;INTERVAL=${every};${byMonthDay(day)}${until}`;
      const dt = `${icsDate(start)}T090000`;
      body.push('BEGIN:VEVENT', `UID:elec-${kind === 'reading' ? '' : 'invoice-'}${p.id}@business-tracking`, `DTSTART:${dt}`, 'DURATION:PT15M', rrule,
        `SUMMARY:${icsEscape(title)}`, `DESCRIPTION:${icsEscape(details)}`, `URL:${url}`,
        'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsEscape(title)}`, 'TRIGGER:PT0M', 'END:VALARM', 'END:VEVENT');
      events.push({ kind, property: p, ...extra, google: googleCalendarLink({ title, details, start: dt, end: `${icsDate(start)}T091500`, rrule }) });
    };
    // Reading request
    if (!t) skipped.push({ property: p, reason: 'no current tenant — no reading reminder' });
    else {
      const text = messageFor(c, { calendar: true });
      const link = goLink(baseUrl, t, text, p.id);
      if (!link) skipped.push({ property: p, reason: `no phone number or email on ${t.name || 'the tenant'} — no reading reminder` });
      else {
        const first = (t.name || '').split(' ')[0] || 'tenant';
        const how = link.via === 'whatsapp' ? `Tap to send it on WhatsApp: ${link.url}`
          : link.via === 'viber' ? `Tap, then "Copy message & open Viber chat" — paste and send to ${first}: ${link.url}`
          : `Tap to email it: ${link.url}`;
        add('reading', c.windowFrom, Number(cfg.windowFrom), `Electricity reading: ${p.name} (${first})`,
          `Ask ${first} for the meter reading (window day ${cfg.windowFrom}–${cfg.windowTo}).\n\n${how}\n\nMessage:\n${text}`, link.url, { tenant: t, via: link.via });
      }
    }
    // Invoice check & pay
    const due = addDaysYmd(c.windowTo, Math.max(0, Number(cfg.invoiceDelayDays) || 0));
    const appUrl = `${baseUrl}#electricity`;
    const prov = providerFor(p);
    const site = /^https?:\/\//i.test(prov?.website || '') ? prov.website : '';
    add('invoice', due, Number(due.slice(8, 10)), `Pay electricity invoice: ${p.name}`,
      `The ${prov ? `${prov.name} ` : 'provider\'s '}invoice for ${p.name} should be in (about ${cfg.invoiceDelayDays} days after the reading).` +
      (site ? `\n\nCheck and pay it on ${prov.name}: ${site}` : '') +
      `\n\nThen mark it paid in the app (it's booked as an Electricity expense): ${appUrl}`, site || appUrl, { provider: prov || null });
    hashes[p.id] = strHash(body.join('\n'));
    bodies.push(...body);
  }
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Business Tracking//Electricity readings//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    ...bodies.flatMap(l => l === 'BEGIN:VEVENT' ? [l, `DTSTAMP:${stamp}`] : [l]), 'END:VCALENDAR'];
  return { ics: lines.map(icsFold).join('\r\n') + '\r\n', hash: strHash(bodies.join('\n')), hashes, events, skipped };
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
