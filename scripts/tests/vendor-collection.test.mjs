import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
const { setDb } = await import('../../js/core/state.js');
const data = await import('../../js/core/data.js');

// Rent a vendor collected in cash and kept against their own costs.
const load = () => setDb({
  settings: { fxRates: { yearRates: { 2026: 0.0027 } } },
  properties: [{ id: 'p1', name: 'Flat', type: 'long_term', currency: 'HUF', owner: 'you' }],
  vendors: [{ id: 'v1', name: 'Handyman' }, { id: 'v2', name: 'Cleaner' }],
  expenses: [
    { id: 'old1', vendorId: 'v1', category: 'maintenance', amount: 10, currency: 'HUF', date: '2026-01-05' },
    { id: 'old2', vendorId: 'v2', category: 'cleaning', amount: 10, currency: 'HUF', date: '2026-01-06' },
    { id: 'old3', vendorId: 'v2', category: 'cleaning', amount: 10, currency: 'HUF', date: '2026-02-06' }
  ],
  payments: [{ id: 'pay1', propertyId: 'p1', amount: 150000, currency: 'HUF', date: '2026-10-10', status: 'paid', type: 'rental', stream: 'long_term_rental', rentMonth: '2026-10' }]
});
const exp = id => data.listActive('expenses').find(e => e.id === id);
const pay = () => data.byId('payments', 'pay1');

test('vendor collection books a linked expense with the vendor, property, date and currency', () => {
  load();
  const e = data.setVendorCollection('pay1', { vendorId: 'v1', category: 'maintenance', amount: 120000 });
  assert.equal(e.vendorId, 'v1');
  assert.equal(e.vendor, 'Handyman');
  assert.equal(e.propertyId, 'p1');
  assert.equal(e.amount, 120000);
  assert.equal(e.currency, 'HUF');
  assert.equal(e.date, '2026-10-10');
  assert.equal(e.category, 'maintenance');
  assert.equal(e.stream, 'long_term_rental');
  assert.equal(e.linkedPaymentId, 'pay1');
  assert.equal(pay().collectedByVendorId, 'v1');
  assert.equal(pay().linkedExpenseId, e.id);
  assert.equal(pay().status, 'paid');                 // rent stays revenue
  assert.equal(pay().amount, 150000);
});

test('changing the vendor / amount updates the same expense; undo removes it', () => {
  load();
  const e1 = data.setVendorCollection('pay1', { vendorId: 'v1', category: 'maintenance', amount: 150000 });
  const e2 = data.setVendorCollection('pay1', { vendorId: 'v2', category: 'cleaning', amount: 50000 });
  assert.equal(e2.id, e1.id);                         // updated in place, not duplicated
  assert.equal(data.listActive('expenses').filter(e => e.linkedPaymentId === 'pay1').length, 1);
  assert.equal(exp(e1.id).vendor, 'Cleaner');
  assert.equal(exp(e1.id).amount, 50000);
  data.setVendorCollection('pay1', null);
  assert.equal(exp(e1.id), undefined);                // expense gone
  assert.equal(pay().linkedExpenseId, undefined);
  assert.equal(pay().collectedByVendorId, undefined);
  assert.equal(pay().status, 'paid');
});

test('deleting the payment deletes its expense; deleting the expense unlinks the payment', () => {
  load();
  const e = data.setVendorCollection('pay1', { vendorId: 'v1', category: 'maintenance', amount: 150000 });
  data.softDelete('payments', 'pay1');
  assert.equal(exp(e.id), undefined);

  load();
  const e2 = data.setVendorCollection('pay1', { vendorId: 'v1', category: 'maintenance', amount: 150000 });
  data.softDelete('expenses', e2.id);
  assert.equal(pay().deletedAt, undefined);           // payment kept
  assert.equal(pay().linkedExpenseId, undefined);
  assert.equal(pay().collectedByVendorId, undefined);
});

test("a vendor's usual category comes from their past expenses", () => {
  load();
  assert.equal(data.vendorUsualCategory('v2'), 'cleaning');
  assert.equal(data.vendorUsualCategory('v1'), 'maintenance');
  assert.equal(data.vendorUsualCategory('nobody'), 'maintenance');
  const e = data.setVendorCollection('pay1', { vendorId: 'v2', amount: 1000 }); // no category given
  assert.equal(e.category, 'cleaning');
});
