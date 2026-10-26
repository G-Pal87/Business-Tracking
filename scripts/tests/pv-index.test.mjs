// propertyValueMetrics (per-property index + memo) vs the original full-scan
// implementation, on synthetic data only. Results must be bit-identical.
import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
const { state, setDb } = await import('../../js/core/state.js');
const {
  propertyValueMetrics, propertyValueAt, toEUR, isCapEx, listActive, listActivePayments, upsert, softDelete
} = await import('../../js/core/data.js');

// The pre-index implementation, verbatim.
function referenceMetrics(prop, asOf, { excludePersonal = false } = {}) {
  const at = propertyValueAt(prop, asOf);
  if (!at) return null;
  const cur = prop.currency || 'EUR';
  const valueEUR    = toEUR(at.value, cur, asOf);
  const purchaseEUR = prop.purchasePrice ? toEUR(prop.purchasePrice, cur, prop.purchaseDate) : 0;
  let capexEUR = 0, netIncomeEUR = 0;
  for (const e of listActive('expenses')) {
    if (e.propertyId !== prop.id || !e.date || e.date > asOf || (excludePersonal && e.personal)) continue;
    const amt = toEUR(e.amount, e.currency, e.date);
    if (isCapEx(e)) capexEUR += amt; else netIncomeEUR -= amt;
  }
  for (const p of listActivePayments()) {
    if (p.propertyId !== prop.id || p.status !== 'paid' || !p.date || p.date > asOf || (excludePersonal && p.personal)) continue;
    netIncomeEUR += toEUR(p.amount, p.currency, p.date);
  }
  const investedEUR = purchaseEUR + capexEUR;
  const gainEUR = valueEUR - investedEUR;
  const totalReturnEUR = gainEUR + netIncomeEUR;
  const years = prop.purchaseDate
    ? (new Date(asOf).getTime() - new Date(prop.purchaseDate).getTime()) / (365.25 * 24 * 3600 * 1000) : 0;
  const cagrPct = years >= 1 && purchaseEUR > 0 && valueEUR > 0
    ? (Math.pow(valueEUR / purchaseEUR, 1 / years) - 1) * 100 : null;
  return {
    valueEUR, valueDate: at.date, valueSource: at.source, isPurchaseValue: at.isPurchase,
    purchaseEUR, capexEUR, investedEUR, gainEUR,
    gainPct: investedEUR > 0 ? (gainEUR / investedEUR) * 100 : null,
    netIncomeEUR, totalReturnEUR,
    totalReturnPct: investedEUR > 0 ? (totalReturnEUR / investedEUR) * 100 : null,
    cagrPct, years
  };
}

// Deterministic PRNG so failures reproduce.
function rng(seed) { return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; }; }

function syntheticDb(seed) {
  const r = rng(seed);
  const pick = a => a[Math.floor(r() * a.length)];
  const date = () => `${2012 + Math.floor(r() * 15)}-${String(1 + Math.floor(r() * 12)).padStart(2, '0')}-${String(1 + Math.floor(r() * 28)).padStart(2, '0')}`;
  const properties = [];
  for (let i = 0; i < 6; i++) {
    const purchaseDate = date();
    properties.push({
      id: `p${i}`, name: `Prop ${i}`, currency: pick(['EUR', 'HUF', 'EUR']), status: i === 5 ? 'sold' : 'active',
      soldDate: i === 5 ? '2025-06-30' : '', purchasePrice: i === 4 ? 0 : Math.round(r() * 3e5 * 100) / 100, purchaseDate,
      valuations: [{ id: 'v1', date: date(), value: Math.round(r() * 4e5), source: 'agent' }, { id: 'v2', date: date(), value: Math.round(r() * 4e5), source: 'estimate' }]
    });
  }
  const expenses = [], payments = [];
  for (let i = 0; i < 900; i++) {
    expenses.push({
      id: `e${i}`, propertyId: pick(['p0', 'p1', 'p2', 'p3', 'p4', 'p5', '', 'pX']), date: r() < 0.02 ? '' : date(),
      amount: Math.round(r() * 250000) / 100, currency: pick(['EUR', 'HUF', 'EUR', 'USD']),
      category: pick(['renovation', 'utilities', 'cleaning', 'tax']), accountingType: pick(['', '', 'capex', 'opex']),
      personal: r() < 0.2, deletedAt: r() < 0.05 ? '2026-01-01T00:00:00Z' : undefined
    });
    payments.push({
      id: `y${i}`, propertyId: pick(['p0', 'p1', 'p2', 'p3', 'p4', 'p5']), date: r() < 0.02 ? '' : date(),
      amount: Math.round(r() * 300000) / 100, currency: pick(['EUR', 'HUF']), status: pick(['paid', 'paid', 'pending']),
      personal: r() < 0.2, deletedAt: r() < 0.05 ? '2026-01-01T00:00:00Z' : undefined
    });
  }
  const settings = { ...(state.db.settings || {}), fxRates: { yearRates: { 2014: 0.0032, 2018: 0.0029, 2022: 0.0025, 2025: 0.00255 } } };
  return { ...structuredClone(state.db), settings, properties, expenses, payments };
}

const AS_OF = ['2011-01-01', '2013-12-31', '2016-06-30', '2019-12-31', '2021-02-28', '2023-12-31', '2025-06-30', '2025-07-01', '2026-10-26', '2030-01-01'];

test('index-based metrics are bit-identical to the full scan (synthetic, 3 seeds)', () => {
  for (const seed of [1, 42, 20261026]) {
    setDb(syntheticDb(seed));
    for (const prop of listActive('properties')) {
      for (const asOf of AS_OF) {
        for (const excludePersonal of [false, true]) {
          const want = referenceMetrics(prop, asOf, { excludePersonal });
          // twice: computed, then served from the memo
          assert.deepStrictEqual(propertyValueMetrics(prop, asOf, { excludePersonal }), want, `${seed} ${prop.id} ${asOf} ${excludePersonal}`);
          assert.deepStrictEqual(propertyValueMetrics(prop, asOf, { excludePersonal }), want);
        }
      }
    }
  }
});

test('memo never serves stale numbers after edits, deletes or FX changes', () => {
  setDb(syntheticDb(7));
  const prop = listActive('properties')[0];
  const before = propertyValueMetrics(prop, '2026-10-26');
  upsert('expenses', { id: 'new1', propertyId: prop.id, date: '2020-01-01', amount: 12345.67, currency: 'EUR', category: 'renovation' });
  const afterAdd = propertyValueMetrics(prop, '2026-10-26');
  assert.deepStrictEqual(afterAdd, referenceMetrics(prop, '2026-10-26'));
  assert.notEqual(afterAdd.capexEUR, before.capexEUR);
  softDelete('expenses', 'new1');
  assert.deepStrictEqual(propertyValueMetrics(prop, '2026-10-26'), referenceMetrics(prop, '2026-10-26'));
  upsert('payments', { id: 'newpay', propertyId: prop.id, date: '2021-05-05', amount: 999, currency: 'HUF', status: 'paid' });
  assert.deepStrictEqual(propertyValueMetrics(prop, '2026-10-26'), referenceMetrics(prop, '2026-10-26'));
  // A new valuation (property edit) replaces the object and bumps the revision.
  const edited = { ...prop, valuations: [...prop.valuations, { id: 'v9', date: '2026-01-01', value: 777777, source: 'agent' }] };
  upsert('properties', edited);
  assert.equal(propertyValueMetrics(edited, '2026-10-26').valueEUR, referenceMetrics(edited, '2026-10-26').valueEUR);
  // FX table change
  state.db.settings = { ...state.db.settings, fxRates: { yearRates: { 2014: 0.01 } } };
  assert.deepStrictEqual(propertyValueMetrics(edited, '2026-10-26'), referenceMetrics(edited, '2026-10-26'));
});

test('callers get their own copy of a memoised result', () => {
  setDb(syntheticDb(3));
  const prop = listActive('properties')[0];
  const a = propertyValueMetrics(prop, '2026-10-26');
  a.valueEUR = -1;
  assert.notEqual(propertyValueMetrics(prop, '2026-10-26').valueEUR, -1);
  assert.equal(propertyValueMetrics(null, '2026-10-26'), null);
});
