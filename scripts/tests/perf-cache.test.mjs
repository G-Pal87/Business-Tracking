// Memoization / cache-invalidation tests for the derived-data caches
// (generatePaymentSchedule, getForecastVsActual, countUnresolvedGapNights).
// Synthetic inline data only — no fixtures, no real records.
// Run: node --test scripts/tests/*.test.mjs
import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.getComputedStyle = globalThis.getComputedStyle || (() => ({ getPropertyValue: () => '' }));
document.documentElement = document.documentElement || { style: {} };

const { state, setDb, invalidateActiveCache } = await import('../../js/core/state.js');
const data = await import('../../js/core/data.js');
const { countUnresolvedGapNights } = await import('../../js/modules/str-rates.js');

// Pin "now" (today() reads new Date()) so date-dependent output is stable.
const RealDate = Date;
function setNow(iso) {
  const t = new RealDate(iso).getTime();
  globalThis.Date = class extends RealDate {
    constructor(...a) { if (a.length) super(...a); else super(t); }
    static now() { return t; }
  };
}
function restoreNow() { globalThis.Date = RealDate; }

const LT = { id: 'p1', type: 'long_term', name: 'Flat A', currency: 'EUR' };
const baseDb = () => ({
  settings: { fxRates: { yearRates: { 2024: 0.0025, 2025: 0.0026 } } },
  properties: [structuredClone(LT)],
  tenants: [
    { id: 't1', propertyId: 'p1', status: 'active', monthlyRent: 900, leaseStartDate: '2024-01-10', paymentDayOfMonth: 5,
      rentHistory: [{ from: '0000-01', amount: 900 }, { from: '2025-03', amount: 950 }] }
  ],
  payments: [
    { id: 'r1', propertyId: 'p1', type: 'rental', stream: 'long_term_rental', status: 'paid', amount: 900, currency: 'EUR', date: '2024-02-05' },
    { id: 'r2', propertyId: 'p1', type: 'rental', stream: 'long_term_rental', status: 'paid', amount: 900, currency: 'EUR', date: '2024-04-02', rentMonth: '2024-03' }
  ],
  expenses: [
    { id: 'e1', propertyId: 'p1', category: 'cleaning', amount: 50, currency: 'EUR', date: '2024-02-10' },
    { id: 'e2', propertyId: 'p1', category: 'renovation', amount: 5000, currency: 'EUR', date: '2024-02-11' },
    { id: 'e3', stream: 'customer_success', category: 'other', amount: 70000, currency: 'HUF', date: '2024-05-01' }
  ],
  invoices: [
    { id: 'i1', stream: 'customer_success', status: 'paid', subtotal: 1000, total: 1190, currency: 'EUR', issueDate: '2024-05-03' },
    { id: 'i2', stream: 'customer_success', status: 'sent', subtotal: 500, total: 595, currency: 'EUR', issueDate: '2024-05-04' }
  ],
  forecasts: [{ id: 'fc1', type: 'property', entityId: 'p1', year: 2024, months: { '2024-02': { revenue: 0, expenses: 20 } } }]
});
const prop = () => data.byId('properties', 'p1');
// A copy of the property bypasses the per-object memo — a fresh computation.
const fresh = () => data.generatePaymentSchedule({ ...prop() });

test('generatePaymentSchedule: memo hit equals a fresh computation; entries frozen, array per call', () => {
  setNow('2024-06-15T12:00:00');
  try {
    setDb(baseDb());
    const a = data.generatePaymentSchedule(prop());
    const b = data.generatePaymentSchedule(prop());
    assert.notEqual(a, b);                 // own array each call
    assert.deepEqual(a, b);
    assert.deepEqual(a, fresh());
    assert.ok(Object.isFrozen(a[0]));
    a.pop();                               // mutating the returned array can't corrupt the cache
    assert.deepEqual(data.generatePaymentSchedule(prop()), b);
    assert.equal(b.find(e => e.monthKey === '2024-03').paid, true);   // paid late, via rentMonth
    assert.equal(b.find(e => e.monthKey === '2024-05').overdue, true);
  } finally { restoreNow(); }
});

test('generatePaymentSchedule: invalidated by edits, sync-style changes, db swaps and the date', () => {
  setNow('2024-06-15T12:00:00');
  try {
    setDb(baseDb());
    const before = data.generatePaymentSchedule(prop());
    assert.equal(before.find(e => e.monthKey === '2024-05').paid, false);

    // Edit (upsert → editSeq)
    data.upsert('payments', { id: 'r3', propertyId: 'p1', type: 'rental', stream: 'long_term_rental', status: 'paid', amount: 900, currency: 'EUR', date: '2024-05-05' });
    const afterEdit = data.generatePaymentSchedule(prop());
    assert.equal(afterEdit.find(e => e.monthKey === '2024-05').paid, true);
    assert.deepEqual(afterEdit, fresh());

    // Sync adopting a record in place: no editSeq bump, only invalidateActiveCache()
    const seq = state.editSeq;
    const adopted = { id: 'r4', propertyId: 'p1', type: 'rental', stream: 'long_term_rental', status: 'paid', amount: 900, currency: 'EUR', date: '2024-06-05' };
    state.db.payments.push(adopted);
    state._ix.get('payments').set(adopted.id, adopted);
    invalidateActiveCache();
    assert.equal(state.editSeq, seq);
    assert.equal(data.generatePaymentSchedule(prop()).find(e => e.monthKey === '2024-06').paid, true);

    // Date change: overdue status follows today()
    setNow('2024-07-20T12:00:00');
    const later = data.generatePaymentSchedule(prop());
    assert.equal(later.find(e => e.monthKey === '2024-07').overdue, true);
    assert.deepEqual(later, fresh());

    // Whole-db swap
    setDb(baseDb());
    assert.equal(data.generatePaymentSchedule(prop()).find(e => e.monthKey === '2024-05').paid, false);
  } finally { restoreNow(); }
});

test('generatePaymentSchedule: rent history per month is unchanged by the per-lease sort', () => {
  setNow('2025-06-15T12:00:00');
  try {
    setDb(baseDb());
    const s = data.generatePaymentSchedule(prop());
    assert.equal(s.find(e => e.monthKey === '2025-02').amount, 900);
    assert.equal(s.find(e => e.monthKey === '2025-03').amount, 950);
    assert.equal(s.find(e => e.monthKey === '2024-01').amount, Math.round(900 * 22 / 31 * 100) / 100); // part month from the 10th
    assert.equal(data.tenantRentForMonth(state.db.tenants[0], '2025-03').amount, 950);
  } finally { restoreNow(); }
});

// Straightforward re-statement of getForecastVsActual's actuals, for comparison.
function naiveActuals(type, id, year) {
  const ys = String(year);
  return Array.from({ length: 12 }, (_, i) => {
    const key = `${ys}-${String(i + 1).padStart(2, '0')}`;
    const rev = type === 'property'
      ? data.listActivePayments().filter(p => p.propertyId === id && p.status === 'paid' && data.forecastActualMonthKey(p) === key).reduce((s, p) => s + data.toEUR(p.amount, p.currency, year), 0)
      : data.listActive('invoices').filter(x => x.stream === id && x.status === 'paid' && (x.issueDate || '').startsWith(key)).reduce((s, x) => s + data.toEUR(x.subtotal ?? x.total, x.currency, year), 0);
    const exp = data.listActive('expenses').filter(e => (type === 'property' ? e.propertyId : e.stream) === id && !data.isCapEx(e) && (e.date || '').startsWith(key)).reduce((s, e) => s + data.toEUR(e.amount, e.currency, year), 0);
    return { key, rev, exp };
  });
}

test('getForecastVsActual: indexed + memoized result matches a naive scan and follows edits', () => {
  setNow('2024-06-15T12:00:00');
  try {
    setDb(baseDb());
    for (const [type, id] of [['property', 'p1'], ['service', 'customer_success']]) {
      const r = data.getForecastVsActual(type, id, '2024');
      const n = naiveActuals(type, id, '2024');
      assert.deepEqual(r.months.map(m => ({ key: m.key, rev: m.actualRev, exp: m.actualExp })), n);
    }
    const r1 = data.getForecastVsActual('property', 'p1', 2024);
    assert.equal(r1.months[1].forecastRev, 0);          // explicit 0 respected
    assert.equal(r1.months[1].actualExp, 50);           // CapEx excluded
    assert.equal(r1.months[2].forecastRev, 900);        // lease-schedule fallback
    assert.ok(Object.isFrozen(r1.months));

    data.upsert('expenses', { id: 'e4', propertyId: 'p1', category: 'cleaning', amount: 30, currency: 'EUR', date: '2024-02-20' });
    assert.equal(data.getForecastVsActual('property', 'p1', 2024).months[1].actualExp, 80);
    data.saveForecastMonth('fc1', '2024-03', { revenue: 111 });
    assert.equal(data.getForecastVsActual('property', 'p1', 2024).months[2].forecastRev, 111);
  } finally { restoreNow(); }
});

test('toEUR: exact-year fast path and nearest-year fallback unchanged; follows rate edits', () => {
  setDb(baseDb());
  assert.equal(data.toEUR(1000, 'HUF', '2024-05-01'), 2.5);
  assert.equal(data.toEUR(1000, 'HUF', 2023), 2.5);            // nearest: 2024
  assert.equal(data.toEUR(1000, 'HUF', 2031), 1000 * 0.0026);  // nearest: 2025
  assert.equal(data.toEUR(1000, 'HUF', ''), 1000 * 0.0026);    // no year: latest
  state.db.settings.fxRates.yearRates[2030] = 0.003;
  state.editSeq++;                                             // what markDirty() does
  assert.equal(data.toEUR(1000, 'HUF', 2031), 3);
  setDb({ settings: { fxRates: { yearRates: {} } } });
  assert.equal(data.toEUR(1000, 'HUF', 2024), 0);
});

test('countUnresolvedGapNights: nights across month/leap-day boundaries; follows annotations', () => {
  setDb({
    properties: [{ id: 's1', type: 'short_term', name: 'Studio', currency: 'EUR' }],
    strCalendars: [{ id: 'c1', propertyId: 's1', blocks: [
      { uid: 'a', start: '2024-02-27', end: '2024-03-03', summary: 'Reserved' },   // 5 nights incl. 29 Feb
      { uid: 'b', start: '2024-12-30', end: '2025-01-02', summary: 'Reserved' },   // 3 nights across new year
      { uid: 'c', start: '2024-06-01', end: '2024-06-05', summary: 'Airbnb (Not available)' }, // owner block
      { uid: 'd', start: '2024-07-01', end: 'TBD', summary: 'Reserved' }           // malformed → 0 nights
    ] }],
    payments: [
      // covers 28 Feb – 1 Mar of block a (3 nights)
      { id: 'b1', propertyId: 's1', stream: 'short_term_rental', source: 'airbnb', airbnbType: 'Reservation', status: 'paid', amount: 300, currency: 'EUR', date: '2024-03-02', airbnbCheckIn: '2024-02-28', airbnbCheckOut: '2024-03-02' }
    ]
  });
  assert.equal(countUnresolvedGapNights(), 2 + 3);
  data.upsert('strBlockAnnotations', { id: 'sba1', propertyId: 's1', uid: 'b', reason: 'other' });
  assert.equal(countUnresolvedGapNights(), 2);
  data.softDelete('strBlockAnnotations', 'sba1');
  assert.equal(countUnresolvedGapNights(), 5);
  data.upsert('payments', { id: 'b2', propertyId: 's1', stream: 'short_term_rental', source: 'manual', status: 'paid', amount: 100, currency: 'EUR', date: '2024-03-03', checkIn: '2024-02-27', checkOut: '2024-03-03' });
  assert.equal(countUnresolvedGapNights(), 3);
});
