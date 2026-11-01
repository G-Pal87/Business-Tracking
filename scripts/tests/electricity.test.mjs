import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
const { setDb } = await import('../../js/core/state.js');
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
  assert.equal(cal.events.length, 2);
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
  const urls = [...ics.matchAll(/URL:(\S+)/g)].map(m => m[1]);
  const viber = decodeGo(urls[0]), wa = decodeGo(urls[1]);
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
  assert.equal(elec.buildCalendar('https://app.example/', '2026-11-03').events.length, 0);
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
