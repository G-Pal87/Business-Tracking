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
