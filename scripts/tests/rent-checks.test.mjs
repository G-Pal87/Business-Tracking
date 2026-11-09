import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
const { setDb, state } = await import('../../js/core/state.js');
const rc = await import('../../js/core/rent-checks.js');

// Synthetic flat: 1,000 a month from Jan 2025, paid on the 1st.
const flat = { id: 'p1', name: 'Flat', type: 'long_term', currency: 'EUR', status: 'active' };
const tenant = { id: 't1', propertyId: 'p1', name: 'Tenant A', status: 'active', monthlyRent: 1000, currency: 'EUR', leaseStartDate: '2025-01-01', leaseEndDate: '2027-12-31', paymentDayOfMonth: 1 };
const pay = (id, date, amount, extra = {}) => ({ id, propertyId: 'p1', tenantId: 't1', stream: 'long_term_rental', type: 'rental', status: 'paid', currency: 'EUR', date, amount, ...extra });
const load = (payments, settings = {}) => setDb({ settings, properties: [flat], tenants: [tenant], payments });
const find = () => rc.findRentPaymentIssues([flat]);

test('a normal month is not flagged', () => {
  load([pay('a', '2025-03-01', 1000), pay('b', '2025-04-02', 1000)]);
  assert.deepEqual(find(), []);
});

test('the same rent recorded twice for one month → duplicate', () => {
  load([pay('a', '2025-12-01', 1000), pay('b', '2025-12-03', 1000)]);
  const [x] = find();
  assert.equal(x.kind, 'duplicate'); assert.equal(x.monthKey, '2025-12');
  assert.equal(x.expected, 1000); assert.equal(x.paid, 2000); assert.equal(x.overBy, 1000);
  assert.deepEqual(x.payments.map(p => p.id), ['a', 'b']);
});

test('two different payments adding up to more than due → overpaid; split rent is fine', () => {
  load([pay('a', '2025-12-01', 1000), pay('b', '2025-12-10', 300)]);
  assert.equal(find()[0].kind, 'overpaid');
  assert.equal(find()[0].overBy, 300);
  load([pay('a', '2025-12-01', 600), pay('b', '2025-12-10', 400)]);   // paid in two parts
  assert.deepEqual(find(), []);
  load([pay('a', '2025-12-01', 1015)]);                                 // within 2% (fees/rounding)
  assert.deepEqual(find(), []);
});

test('rent matched by the month it covers, not the payment date', () => {
  // November rent paid on 2 Dec (rentMonth set) + December rent → no clash
  load([pay('a', '2025-12-02', 1000, { rentMonth: '2025-11' }), pay('b', '2025-12-05', 1000)]);
  assert.deepEqual(find(), []);
});

test('rent recorded for a month with no rent due → not due', () => {
  load([pay('a', '2024-06-01', 1000)]);                                 // before the lease
  assert.equal(find()[0].kind, 'not_due');
});

test('non-rent payments, pending payments and other properties are ignored', () => {
  load([pay('a', '2025-12-01', 1000), pay('b', '2025-12-01', 1000, { type: 'deposit_withheld' }), pay('c', '2025-12-02', 1000, { status: 'pending' })]);
  assert.deepEqual(find(), []);
});

test('"It\'s correct" stops the flag for that set of payments; a new payment flags it again', () => {
  load([pay('a', '2025-12-01', 1000), pay('b', '2025-12-03', 1000)]);
  rc.dismissRentCheck(find()[0].key);
  assert.deepEqual(find(), []);
  assert.equal(state.db.settings.rentChecks.dismissed.length, 1);
  load([...state.db.payments, pay('c', '2025-12-20', 1000)], state.db.settings);
  assert.equal(find().length, 1);
});

test('HUF rent compared in HUF', () => {
  setDb({ settings: {}, properties: [{ ...flat, currency: 'HUF' }], tenants: [{ ...tenant, monthlyRent: 250000, currency: 'HUF' }],
    payments: [pay('a', '2025-12-01', 250000, { currency: 'HUF' }), pay('b', '2025-12-01', 90323, { currency: 'HUF' })] });
  const [x] = rc.findRentPaymentIssues([{ ...flat, currency: 'HUF' }]);
  assert.equal(x.currency, 'HUF'); assert.equal(x.overBy, 90323); assert.equal(x.kind, 'overpaid');
});

test('a pro-rated move-in month paid in full → part month (not "overpaid")', () => {
  setDb({ settings: {}, properties: [flat], tenants: [{ ...tenant, leaseStartDate: '2025-07-31' }], payments: [pay('a', '2025-07-31', 1000)] });
  const [x] = find();
  assert.equal(x.kind, 'part_month'); assert.ok(x.expected < 100); assert.equal(x.fullRent, 1000);
});
