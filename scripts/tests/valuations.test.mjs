import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
const { state, setDb } = await import('../../js/core/state.js');
const { propertyValueAt, propertyValuations, propertyValueMetrics } = await import('../../js/core/data.js');

// Synthetic fixture only — no real records.
function load({ prop, expenses = [], payments = [] }) {
  setDb({ ...structuredClone(state.db), properties: [prop], expenses, payments });
  return prop;
}
const base = {
  id: 'p1', name: 'Test', currency: 'EUR', status: 'active',
  purchasePrice: 100000, purchaseDate: '2010-06-01',
  valuations: [
    { id: 'v2', date: '2026-03-01', value: 210000, source: 'agent' },
    { id: 'v1', date: '2020-12-31', value: 150000, source: 'estimate' },
    { id: 'bad', date: '2021-01-01', value: 0 }, // ignored: not a value
  ],
};

test('valuations are sorted and invalid entries dropped', () => {
  assert.deepEqual(propertyValuations(base).map(v => v.id), ['v1', 'v2']);
});

test('value carries forward from the latest valuation, purchase price before the first', () => {
  const p = load({ prop: structuredClone(base) });
  assert.equal(propertyValueAt(p, '2009-01-01'), null);               // not yet owned
  assert.equal(propertyValueAt(p, '2015-12-31').value, 100000);       // purchase price
  assert.equal(propertyValueAt(p, '2015-12-31').isPurchase, true);
  assert.equal(propertyValueAt(p, '2020-12-31').value, 150000);       // valuation day itself
  assert.equal(propertyValueAt(p, '2025-12-31').value, 150000);       // carried forward
  assert.equal(propertyValueAt(p, '2026-10-01').value, 210000);
});

test('a sold property has no value after its sale date', () => {
  const p = load({ prop: { ...structuredClone(base), status: 'sold', soldDate: '2026-05-01' } });
  assert.equal(propertyValueAt(p, '2026-04-30').value, 210000);
  assert.equal(propertyValueAt(p, '2026-05-02'), null);
});

test('metrics: gain subtracts CapEx, total return adds net rental income', () => {
  const p = load({
    prop: structuredClone(base),
    expenses: [
      { id: 'e1', propertyId: 'p1', date: '2015-01-01', amount: 10000, currency: 'EUR', category: 'renovation' },
      { id: 'e2', propertyId: 'p1', date: '2025-01-01', amount: 2000,  currency: 'EUR', category: 'utilities' },
      { id: 'e3', propertyId: 'p1', date: '2026-09-01', amount: 5000,  currency: 'EUR', category: 'renovation' }, // after asOf
    ],
    payments: [
      { id: 'pay1', propertyId: 'p1', date: '2025-02-01', amount: 12000, currency: 'EUR', status: 'paid' },
      { id: 'pay2', propertyId: 'p1', date: '2025-03-01', amount: 999,   currency: 'EUR', status: 'pending' },
    ],
  });
  const m = propertyValueMetrics(p, '2026-06-30');
  assert.equal(m.valueEUR, 210000);
  assert.equal(m.capexEUR, 10000);
  assert.equal(m.investedEUR, 110000);
  assert.equal(m.gainEUR, 100000);
  assert.equal(m.netIncomeEUR, 10000);     // 12000 paid − 2000 opex
  assert.equal(m.totalReturnEUR, 110000);
  assert.ok(Math.abs(m.gainPct - 90.909) < 0.01);
  // 100k → 210k over ~16.08 years
  assert.ok(Math.abs(m.cagrPct - (Math.pow(2.1, 1 / m.years) - 1) * 100) < 1e-9);
  assert.ok(m.cagrPct > 4.6 && m.cagrPct < 4.8);
});
