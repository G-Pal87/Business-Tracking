import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
const { setDb, state } = await import('../../js/core/state.js');
const data = await import('../../js/core/data.js');
const elec = await import('../../js/core/electricity.js');

// Synthetic Hungarian flats with a reading window on the 1st–5th.
const load = (extra = {}) => setDb({
  settings: { electricity: { providerVendorId: 'v1' } },
  vendors: [{ id: 'v1', name: 'Power Co' }],
  properties: [
    { id: 'h1', name: 'Flat A', country: 'Hungary', type: 'long_term', currency: 'HUF', electricity: { windowFrom: 1, windowTo: 5, everyMonths: 1, invoiceDelayDays: 10, startMonth: '2026-09' } },
    { id: 'h2', name: 'Flat B', country: 'Hungary', type: 'long_term', currency: 'HUF', electricity: { windowFrom: 10, windowTo: 12, everyMonths: 2, invoiceDelayDays: 7, startMonth: '2026-08' } },
    { id: 'h3', name: 'Flat C', country: 'Hungary', type: 'long_term', currency: 'HUF' },            // not set up
    { id: 'c1', name: 'Beach', country: 'Cyprus', type: 'short_term', currency: 'EUR', electricity: { windowFrom: 1, windowTo: 5, startMonth: '2026-09' } }
  ],
  tenants: [
    { id: 't1', propertyId: 'h1', name: 'Anna Kiss', leaseStartDate: '2025-01-01', leaseEndDate: '2027-12-31', monthlyRent: 1, status: 'active', phone: '+36 30 111 2222', preferredContact: 'viber' },
    { id: 't2', propertyId: 'h2', name: 'Bela Nagy', leaseStartDate: '2025-01-01', leaseEndDate: '2027-12-31', monthlyRent: 1, status: 'active', phone: '+36 30 333 4444' }
  ],
  expenses: [], electricityCycles: [], ...extra
});

test('only Hungarian properties take part', () => {
  load();
  assert.deepEqual(elec.electricityProperties().map(p => p.id), ['h1', 'h2', 'h3']);
});

test('cycles repeat from the start month every N months, up to the next window', () => {
  load();
  const h1 = data.byId('properties', 'h1'), h2 = data.byId('properties', 'h2');
  assert.deepEqual(elec.cyclesFor(h1, '2026-11-03').map(c => c.period), ['2026-09', '2026-10', '2026-11', '2026-12']);
  assert.deepEqual(elec.cyclesFor(h2, '2026-11-03').map(c => c.period), ['2026-08', '2026-10', '2026-12']);
  const c = elec.cyclesFor(h1, '2026-11-03').find(c => c.period === '2026-11');
  assert.equal(c.windowFrom, '2026-11-01'); assert.equal(c.windowTo, '2026-11-05');
  assert.equal(c.reading, 'open'); assert.equal(c.invoice, 'waiting');
  assert.equal(elec.cyclesFor(h1, '2026-11-03')[0].reading, 'overdue');
  assert.equal(elec.cyclesFor(h1, '2026-11-03').at(-1).reading, 'upcoming');
  assert.deepEqual(elec.cyclesFor(data.byId('properties', 'h3')), []);
});

test('window end past the month length is clamped', () => {
  load();
  const p = { ...data.byId('properties', 'h1'), electricity: { windowFrom: 28, windowTo: 31, startMonth: '2027-02' } };
  const c = elec.cyclesFor(p, '2027-02-01')[0];
  assert.equal(c.windowFrom, '2027-02-28'); assert.equal(c.windowTo, '2027-02-28');
});

test('reading → invoice due after the delay → paid books an Electricity expense', () => {
  load();
  const h1 = data.byId('properties', 'h1');
  const cyc = () => elec.cyclesFor(h1, today).find(c => c.period === '2026-11');
  let today = '2026-11-03';
  elec.markReading(cyc(), { date: '2026-11-03', kwh: 12345 });
  assert.equal(cyc().reading, 'done');
  assert.equal(cyc().invoice, 'upcoming');
  assert.equal(cyc().invoiceDue, '2026-11-13');
  today = '2026-11-13';
  assert.equal(cyc().invoice, 'due');
  elec.markInvoicePaid(cyc(), { date: '2026-11-14', amount: 18500, invoiceNo: 'INV-1' });
  const c = cyc();
  assert.equal(c.invoice, 'done'); assert.equal(c.complete, true);
  const e = data.byId('expenses', c.record.expenseId);
  assert.equal(e.category, 'electricity'); assert.equal(e.propertyId, 'h1');
  assert.equal(e.amount, 18500); assert.equal(e.currency, 'HUF'); assert.equal(e.date, '2026-11-14');
  assert.equal(e.vendorId, 'v1'); assert.equal(e.vendor, 'Power Co');
  assert.equal(e.stream, 'long_term_rental');
  assert.match(e.description, /2026-11 · INV-1 · reading 12345 kWh/);
  // re-paying updates the same expense; undo removes it
  elec.markInvoicePaid(cyc(), { date: '2026-11-15', amount: 19000 });
  assert.equal(data.listActive('expenses').length, 1);
  assert.equal(data.listActive('expenses')[0].amount, 19000);
  assert.throws(() => elec.undoReading(cyc()));
  elec.undoInvoice(cyc());
  assert.equal(data.listActive('expenses').length, 0);
  assert.equal(cyc().invoice, 'due');
  elec.undoReading(cyc());
  assert.equal(cyc().reading, 'overdue');
});

test('a flat whose tenant pays the provider is left out', () => {
  load();
  data.upsert('tenants', { ...data.byId('tenants', 't1'), electricityPaidBy: 'tenant' });
  const today = '2026-11-03';
  const cs = elec.cyclesFor(data.byId('properties', 'h1'), today);
  assert.ok(cs.every(c => c.excluded && c.complete));
  const acts = elec.electricityActions(today);
  assert.ok(!acts.readings.some(c => c.property.id === 'h1'));
});

test('actions are cached per day and follow edits (reading, tenant change)', () => {
  load();
  const today = '2026-11-03';
  const a1 = elec.electricityActions(today);
  assert.equal(elec.electricityActions(today), a1, 'same day, no edits: cached');
  const nov = elec.cyclesFor(data.byId('properties', 'h1'), today).find(c => c.period === '2026-11');
  elec.markReading(nov, { date: today, kwh: 100 });
  const a2 = elec.electricityActions(today);
  assert.notEqual(a2, a1);
  assert.ok(!a2.readings.some(c => c.id === nov.id), 'submitted reading no longer listed');
  data.upsert('tenants', { ...data.byId('tenants', 't2'), electricityPaidBy: 'tenant' });
  assert.ok(!elec.electricityActions(today).readings.some(c => c.property.id === 'h2'), 'tenant change applies at once');
  assert.notEqual(elec.electricityActions('2026-11-04'), elec.electricityActions(today), 'another day: computed separately');
});

test('currentLeases: indexed by property, follows tenant edits, returns a fresh array', () => {
  load();
  assert.deepEqual(data.currentLeases('h1', '2026-11-03').map(t => t.id), ['t1']);
  const a = data.currentLeases('h1', '2026-11-03');
  a.push({ id: 'junk' });
  assert.deepEqual(data.currentLeases('h1', '2026-11-03').map(t => t.id), ['t1'], 'callers can change the result safely');
  data.upsert('tenants', { id: 't3', propertyId: 'h1', name: 'New', leaseStartDate: '2026-10-01', status: 'active' });
  assert.deepEqual(data.currentLeases('h1', '2026-11-03').map(t => t.id).sort(), ['t1', 't3']);
  data.softDelete('tenants', 't1');
  assert.deepEqual(data.currentLeases('h1', '2026-11-03').map(t => t.id), ['t3']);
  assert.deepEqual(data.tenantsOfProperty('nope'), []);
});

test('actions: readings open/overdue + invoices due; rows keep pending + upcoming', () => {
  load();
  const today = '2026-11-03';
  const a = elec.electricityActions(today);
  // h1: Sep, Oct overdue + Nov open; h2: Aug, Oct overdue
  assert.equal(a.readings.length, 5); assert.equal(a.invoices.length, 0); assert.equal(a.count, 5);
  const rows = elec.electricityRows(today);
  assert.deepEqual(rows.filter(r => r.property.id === 'h1').map(r => r.period), ['2026-09', '2026-10', '2026-11', '2026-12']);
});

test('message: preferred contact, else WhatsApp; template filled', () => {
  load();
  const c = elec.cyclesFor(data.byId('properties', 'h1'), '2026-11-03').find(c => c.period === '2026-11');
  assert.equal(c.messageable, true);
  const text = elec.fillTemplate(elec.DEFAULT_READING_TEMPLATE, c);
  assert.match(text, /^Hi Anna, .* at Flat A between 2026-11-01 and 2026-11-05/);
  const v = elec.messageLink(c.tenant, text);
  assert.equal(v.via, 'viber'); assert.equal(v.href, 'viber://chat?number=%2B36301112222'); assert.equal(v.copyText, text);
  const w = elec.messageLink(data.byId('tenants', 't2'), 'hello there');
  assert.equal(w.via, 'whatsapp'); assert.equal(w.href, 'https://wa.me/36303334444?text=hello%20there');
  assert.equal(elec.messageLink({ name: 'x' }, 'hi'), null);
  elec.markMessaged(c, { via: 'viber', accountId: 'acc1' });
  assert.equal(data.byId('electricityCycles', c.id).messagedVia, 'viber');
});

const decodeGo = url => JSON.parse(Buffer.from(url.split('#go=')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));

test('calendar: one repeating event per tracked flat, with a one-tap link and the lease end as UNTIL', () => {
  load();
  const cal = elec.buildCalendar('https://app.example/', '2026-11-03');
  assert.deepEqual(cal.events.map(e => `${e.kind}:${e.property.id}`), ['reading:h1', 'invoice:h1', 'reading:h2', 'invoice:h2']);
  const ics = cal.ics.replace(/\r\n /g, '');          // unfold
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /UID:elec-h1@business-tracking/);
  assert.match(ics, /DTSTART:20261101T090000/);        // current window (still open) for h1
  assert.match(ics, /RRULE:FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=1;UNTIL=20271231T235959/);
  assert.match(ics, /RRULE:FREQ=MONTHLY;INTERVAL=2;BYMONTHDAY=10;UNTIL=20271231T235959/);
  assert.match(ics, /SUMMARY:Electricity reading: Flat A \(Anna\)/);
  assert.match(ics, /TRIGGER:PT0M/);
  assert.ok(cal.ics.split('\r\n').every(l => new TextEncoder().encode(l).length <= 75), 'lines folded');
  // h1 prefers Viber, h2 WhatsApp; the message uses day ordinals
  const urls = [...ics.matchAll(/URL:(\S+)/g)].map(m => m[1]).filter(u => u.includes('#go='));
  const viber = decodeGo(urls[0]), wa = decodeGo(urls[1]);
  // invoice reminders: 3 days before the tenant's rent payment day, after the window closes
  // (no Payment Day set → the 1st: 3 days before the 1st = 3rd-last day of the month before)
  assert.match(ics, /UID:elec-invoice-h1@business-tracking\r\nDTSTART:20261128T090000\r\nDURATION:PT15M\r\nRRULE:FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=-3;UNTIL=20271231T235959/);
  assert.match(ics, /UID:elec-invoice-h2@business-tracking\r\nDTSTART:20261229T090000\r\nDURATION:PT15M\r\nRRULE:FREQ=MONTHLY;INTERVAL=2;BYMONTHDAY=-3;/);
  assert.match(ics, /SUMMARY:Pay electricity invoice: Flat A/);
  assert.match(ics, /URL:https:\/\/app\.example\/#electricity/);
  assert.deepEqual(Object.keys(cal.hashes), ['h1', 'h2']);
  assert.deepEqual({ c: viber.c, p: viber.p, n: viber.n }, { c: 'v', p: 'h1', n: '36301112222' });
  assert.match(viber.t, /^Hi Anna, .* at Flat A between the 1st and the 5th/);
  assert.deepEqual({ c: wa.c, p: wa.p, n: wa.n }, { c: 'w', p: 'h2', n: '36303334444' });
  assert.match(wa.t, /between the 10th and the 12th/);
  // the hash changes when something in the reminders changes, not otherwise
  assert.equal(elec.buildCalendar('https://app.example/', '2026-11-03').hash, cal.hash);
  data.upsert('tenants', { ...data.byId('tenants', 't2'), phone: '+36 30 999 0000' });
  assert.notEqual(elec.buildCalendar('https://app.example/', '2026-11-03').hash, cal.hash);
});

test('calendar: skips flats whose tenant pays, with no tenant, or no way to message; window day 31 → last day', () => {
  load();
  data.upsert('tenants', { ...data.byId('tenants', 't1'), electricityPaidBy: 'tenant' });
  data.upsert('tenants', { ...data.byId('tenants', 't2'), phone: '', preferredContact: '' });
  const evs = elec.buildCalendar('https://app.example/', '2026-11-03').events;
  assert.deepEqual(evs.map(e => `${e.kind}:${e.property.id}`), ['reading:h2', 'invoice:h2']); // h1: tenant pays; h2: both reminders, no message link
  assert.equal(evs[0].via, undefined);
  load();
  data.upsert('properties', { ...data.byId('properties', 'h2'), electricity: { windowFrom: 31, windowTo: 31, everyMonths: 1, startMonth: '2026-11' } });
  const ics = elec.buildCalendar('https://app.example/', '2026-11-03').ics.replace(/\r\n /g, '');
  assert.match(ics, /BYMONTHDAY=28,29,30,31;BYSETPOS=-1/);
  // preferred "call" can't carry the message → falls back to WhatsApp
  data.upsert('tenants', { ...data.byId('tenants', 't1'), preferredContact: 'call' });
  const l = elec.goLink('https://app.example/', data.byId('tenants', 't1'), 'hi', 'h1');
  assert.equal(l.via, 'whatsapp');
});

test('sent notes from calendar links mark the right cycle once', () => {
  load();
  localStorage.setItem('bt_elec_sent', JSON.stringify([
    { p: 'h1', at: '2026-11-02', c: 'v' },
    { p: 'h2', at: '2026-10-09', c: 'w' },              // 1 day before h2's Oct window → Oct cycle
    { p: 'gone', at: '2026-11-01', c: 'w' },            // unknown property, recent → kept
    { p: 'gone', at: '2026-01-01', c: 'w' }             // unknown and old → dropped
  ]));
  assert.equal(elec.applySentMarks('2026-11-03'), 2);
  const r1 = data.byId('electricityCycles', 'h1|2026-11'), r2 = data.byId('electricityCycles', 'h2|2026-10');
  assert.deepEqual([r1.messagedAt, r1.messagedVia, r1.messagedFrom], ['2026-11-02', 'viber', 'calendar']);
  assert.deepEqual([r2.messagedAt, r2.messagedVia], ['2026-10-09', 'whatsapp']);
  assert.deepEqual(JSON.parse(localStorage.getItem('bt_elec_sent')).map(m => m.at), ['2026-11-01']);
  // applying again changes nothing
  localStorage.setItem('bt_elec_sent', JSON.stringify([{ p: 'h1', at: '2026-11-04', c: 'v' }]));
  assert.equal(elec.applySentMarks('2026-11-04'), 0);
});

test('a sent note for a flat not set up yet is kept until its window exists', () => {
  load();
  localStorage.setItem('bt_elec_sent', JSON.stringify([{ p: 'h3', at: '2026-11-02', c: 'w' }]));
  assert.equal(elec.applySentMarks('2026-11-03'), 0);
  assert.equal(JSON.parse(localStorage.getItem('bt_elec_sent')).length, 1);
  data.upsert('properties', { ...data.byId('properties', 'h3'), electricity: { windowFrom: 1, windowTo: 5, startMonth: '2026-11' } });
  data.upsert('tenants', { id: 't9', propertyId: 'h3', name: 'Cili', leaseStartDate: '2025-01-01', monthlyRent: 1, status: 'active', phone: '+36301' });
  assert.equal(elec.applySentMarks('2026-11-03'), 1);
  assert.equal(localStorage.getItem('bt_elec_sent'), null);
});

test('calendar: says why each flat has no reminder', () => {
  load();
  data.upsert('tenants', { ...data.byId('tenants', 't2'), phone: '', preferredContact: '' });
  const cal = elec.buildCalendar('https://app.example/', '2026-11-03');
  assert.deepEqual(cal.skipped.map(s => [s.property.id, s.reason]), [
    ['h2', 'no phone number or email on Bela Nagy — reading reminder without a message link'],
    ['h3', 'reading window not set up']
  ]);
  data.upsert('tenants', { ...data.byId('tenants', 't1'), electricityPaidBy: 'tenant' });
  assert.equal(elec.buildCalendar('https://app.example/', '2026-11-03').skipped[0].reason, 'tenant pays the electricity directly');
});

test('Google Calendar link: pre-filled repeating event in Hungarian time', () => {
  load();
  const ev = elec.buildCalendar('https://app.example/', '2026-11-03').events.find(e => e.property.id === 'h2');
  const u = new URL(ev.google);
  assert.equal(u.origin + u.pathname, 'https://calendar.google.com/calendar/render');
  const q = u.searchParams;
  assert.equal(q.get('action'), 'TEMPLATE');
  assert.equal(q.get('text'), 'Electricity reading: Flat B (Bela)');
  assert.equal(q.get('dates'), '20261210T090000/20261210T091500');
  assert.equal(q.get('recur'), 'RRULE:FREQ=MONTHLY;INTERVAL=2;BYMONTHDAY=10;UNTIL=20271231T235959');
  assert.equal(q.get('ctz'), 'Europe/Budapest');
  assert.match(q.get('details'), /Tap to send it on WhatsApp: https:\/\/app\.example\/#go=/);
});

test('messages follow the tenant language (English default, Hungarian), in the app and in the calendar', () => {
  load();
  const cyc = () => elec.cyclesFor(data.byId('properties', 'h1'), '2026-11-03').find(c => c.period === '2026-11');
  assert.equal(elec.messageFor(cyc()), 'Hi Anna, could you please send me a photo of the electricity meter at Flat A between Nov 1, 2026 and Nov 5, 2026? Thank you!');
  data.upsert('tenants', { ...data.byId('tenants', 't1'), messageLanguage: 'hu' });
  assert.equal(elec.messageFor(cyc()), 'Kedves Anna! Kérem, küldjön egy fotót a villanyóra állásáról (Flat A) november 1. és november 5. között. Köszönöm!');
  assert.match(elec.messageFor(cyc(), { calendar: true }), /\(Flat A\) 1\. és 5\. között/);
  const ics = elec.buildCalendar('https://app.example/', '2026-11-03').ics.replace(/\r\n /g, '');
  const urls = [...ics.matchAll(/URL:(\S+)/g)].map(m => m[1]).filter(u => u.includes('#go=')).map(decodeGo);
  assert.match(urls.find(u => u.p === 'h1').t, /^Kedves Anna!/);
  assert.match(urls.find(u => u.p === 'h2').t, /^Hi Bela,/);
  // edited templates per language; the old single template still counts as English
  data.upsert('tenants', { ...data.byId('tenants', 't2'), messageLanguage: 'en', email: 'b@example.test', preferredContact: 'email' });
  state.db.settings.electricity = { template: 'Old EN {tenant}', templates: { hu: 'HU {tenant} {from}' } };
  assert.equal(elec.messageFor(cyc()), 'HU Anna november 1.');
  const c2 = elec.cyclesFor(data.byId('properties', 'h2'), '2026-11-03').at(-1);
  assert.equal(elec.messageFor(c2), 'Old EN Bela');
  assert.match(elec.messageLink(c2.tenant, 'x').href, /subject=Electricity%20meter%20reading/);
  data.upsert('tenants', { ...data.byId('tenants', 't2'), messageLanguage: 'hu' });
  assert.match(elec.messageLink(data.byId('tenants', 't2'), 'x').href, /subject=Villany%C3%B3ra-%C3%A1ll%C3%A1s/);
  const l = elec.goLink('https://app.example/', data.byId('tenants', 't2'), 'x', 'h2');
  assert.equal(decodeGo(l.url).s, 'Villanyóra-állás');
});

test('calendar for one flat only; per-flat hashes change independently', () => {
  load();
  const one = elec.buildCalendar('https://app.example/', '2026-11-03', { propertyIds: ['h2'] });
  assert.deepEqual(one.events.map(e => `${e.kind}:${e.property.id}`), ['reading:h2', 'invoice:h2']);
  const all = elec.buildCalendar('https://app.example/', '2026-11-03');
  assert.equal(one.hashes.h2, all.hashes.h2);
  data.upsert('tenants', { ...data.byId('tenants', 't1'), paymentDayOfMonth: 20 });
  const after = elec.buildCalendar('https://app.example/', '2026-11-03');
  assert.notEqual(after.hashes.h1, all.hashes.h1);
  assert.equal(after.hashes.h2, all.hashes.h2);
});

test('invoice paid: vendor chosen at payment overrides the default; none removes it', () => {
  load();
  data.upsert('vendors', { id: 'v2', name: 'E.ON', role: 'utility' });
  const cyc = () => elec.cyclesFor(data.byId('properties', 'h1'), '2026-11-20').find(c => c.period === '2026-11');
  elec.markReading(cyc(), { date: '2026-11-03', kwh: 1 });
  elec.markInvoicePaid(cyc(), { date: '2026-11-14', amount: 100 });                    // default (Power Co)
  let e = data.byId('expenses', cyc().record.expenseId);
  assert.equal(e.vendor, 'Power Co');
  elec.markInvoicePaid(cyc(), { date: '2026-11-14', amount: 100, vendorId: 'v2' });     // chosen
  e = data.byId('expenses', cyc().record.expenseId);
  assert.deepEqual([e.vendorId, e.vendor, e.category], ['v2', 'E.ON', 'electricity']);
  elec.markInvoicePaid(cyc(), { date: '2026-11-14', amount: 100, vendorId: '' });       // none
  e = data.byId('expenses', cyc().record.expenseId);
  assert.ok(!('vendorId' in e) && !('vendor' in e));
  assert.equal(data.listActive('expenses').length, 1);
});

test('vendor website: normalised, only http(s) kept', () => {
  assert.equal(data.normalizeWebsite(''), '');
  assert.equal(data.normalizeWebsite(' www.eon.hu '), 'https://www.eon.hu/');
  assert.equal(data.normalizeWebsite('https://www.eon.hu/ugyfelszolgalat'), 'https://www.eon.hu/ugyfelszolgalat');
  assert.equal(data.normalizeWebsite('javascript:alert(1)'), null);
  assert.equal(data.normalizeWebsite('not a site'), null);
});

test('invoice reminder carries the provider portal link (latest vendor used for the flat, else the default)', () => {
  load();
  data.upsert('vendors', { id: 'v1', name: 'Power Co', website: 'https://power.example/login' });
  data.upsert('vendors', { id: 'v2', name: 'E.ON', role: 'utility', website: 'https://www.eon.hu/' });
  let ics = elec.buildCalendar('https://app.example/', '2026-11-03').ics.replace(/\r\n /g, '');
  assert.match(ics, /Check and pay it on Power Co: https:\/\/power\.example\/login/);
  assert.match(ics, /SUMMARY:Pay electricity invoice: Flat A\r\nDESCRIPTION:[^\r]*\r\nURL:https:\/\/power\.example\/login/);
  // h1's last invoice was paid to E.ON → its reminder links E.ON; h2 keeps the default
  const cyc = elec.cyclesFor(data.byId('properties', 'h1'), '2026-11-03').find(c => c.period === '2026-10');
  elec.markReading(cyc, { date: '2026-10-03' });
  elec.markInvoicePaid(elec.cyclesFor(data.byId('properties', 'h1'), '2026-11-03').find(c => c.period === '2026-10'), { date: '2026-10-20', amount: 1, vendorId: 'v2' });
  const cal = elec.buildCalendar('https://app.example/', '2026-11-03');
  ics = cal.ics.replace(/\r\n /g, '');
  assert.match(ics, /invoice for Flat A[^\r]*Check and pay it on E\.ON: https:\/\/www\.eon\.hu\//);
  assert.match(ics, /invoice for Flat B[^\r]*Check and pay it on Power Co/);
  const inv = cal.events.find(e => e.kind === 'invoice' && e.property.id === 'h1');
  assert.equal(inv.provider.name, 'E.ON');
  assert.match(new URL(inv.google).searchParams.get('details'), /https:\/\/www\.eon\.hu\//);
  // changing the website marks the flat's reminders as changed
  data.upsert('vendors', { ...data.byId('vendors', 'v2'), website: 'https://www.eon.hu/new' });
  assert.notEqual(elec.buildCalendar('https://app.example/', '2026-11-03').hashes.h1, cal.hashes.h1);
});

test('deleting the expense of a paid invoice warns, and puts the invoice back to unpaid', () => {
  load();
  const cyc = () => elec.cyclesFor(data.byId('properties', 'h1'), '2026-11-20').find(c => c.period === '2026-11');
  elec.markReading(cyc(), { date: '2026-11-03', kwh: 5 });
  elec.markInvoicePaid(cyc(), { date: '2026-11-14', amount: 100, invoiceNo: 'X1' });
  const e = data.byId('expenses', cyc().record.expenseId);
  assert.match(data.expenseDeleteWarning(e), /electricity invoice for Flat A \(2026-11\), marked paid on 2026-11-14\. Deleting it marks that invoice as unpaid again/);
  assert.equal(data.expenseDeleteWarning({ id: 'x', amount: 1 }), '');
  data.softDelete('expenses', e.id);
  const c = cyc();
  assert.equal(c.invoice, 'due');                      // unpaid again
  assert.equal(c.reading, 'done');                     // the reading stays
  assert.ok(!c.record.paidAt && !c.record.expenseId && !c.record.invoiceNo);
  assert.equal(c.record.kwh, 5);
});

test('every set-up flat gets both reminders, even with no tenant (read the meter yourself)', () => {
  load();
  data.upsert('properties', { ...data.byId('properties', 'h3'), electricity: { windowFrom: 1, windowTo: 5, startMonth: '2026-11', invoiceDelayDays: 10 } });
  const cal = elec.buildCalendar('https://app.example/', '2026-11-03');
  assert.deepEqual(cal.events.map(e => `${e.kind}:${e.property.id}`), ['reading:h1', 'invoice:h1', 'reading:h2', 'invoice:h2', 'reading:h3', 'invoice:h3']);
  const ics = cal.ics.replace(/\r\n /g, '');
  assert.match(ics, /SUMMARY:Electricity reading: Flat C \(no tenant\)\r\nDESCRIPTION:No tenant at the moment: read the meter yourself/);
  assert.match(ics, /UID:elec-h3@business-tracking/);
});

test('invoice reminder: 3 days before the rent payment day; window end + delay without a tenant', () => {
  load();
  const inv = () => elec.buildCalendar('https://app.example/', '2026-11-03').ics.replace(/\r\n /g, '').split('BEGIN:VEVENT').find(b => /UID:elec-invoice-h1@/.test(b));
  data.upsert('tenants', { ...data.byId('tenants', 't1'), paymentDayOfMonth: 13 });
  assert.match(inv(), /DTSTART:20261110T090000/);                        // window ends 5 Nov → rent 13 Nov → 10 Nov
  assert.match(inv(), /BYMONTHDAY=10;/);
  assert.match(inv(), /Reminder 3 days before Anna's rent payment day \(the 13th\)/);
  data.upsert('tenants', { ...data.byId('tenants', 't1'), paymentDayOfMonth: 7 });
  assert.match(inv(), /DTSTART:20261204T090000/);                        // 4 Nov is before the window closes → next month
  data.upsert('tenants', { ...data.byId('tenants', 't1'), paymentDayOfMonth: 3 });
  assert.match(inv(), /DTSTART:20261130T090000/); assert.match(inv(), /BYMONTHDAY=-1;/); // last day of the month before
  data.upsert('tenants', { ...data.byId('tenants', 't1'), paymentDayOfMonth: 2 });
  assert.match(inv(), /BYMONTHDAY=-2;/);
  data.upsert('tenants', { ...data.byId('tenants', 't1'), paymentDayOfMonth: 31 });
  assert.match(inv(), /DTSTART:20261128T090000/); assert.match(inv(), /BYMONTHDAY=28;/); // the 28th every month (31 − 3)
  // no tenant → window end + invoice delay (5 Nov + 10)
  data.softDelete('tenants', 't1');
  assert.match(inv(), /DTSTART:20261115T090000/);
  assert.match(inv(), /about 10 days after the reading/);
});
