// Per-collection cache invalidation (state.js dataRev / data.js derivedCache):
// an edit to collection X drops only the derived caches that read X; unscoped
// edits, sync-style invalidateActiveCache(), settings changes, db swaps and
// direct editSeq bumps still drop everything. Synthetic inline data only.
// Run: node --test scripts/tests/*.test.mjs
import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.getComputedStyle = globalThis.getComputedStyle || (() => ({ getPropertyValue: () => '' }));
document.documentElement = document.documentElement || { style: {} };

const { state, setDb, markDirty, invalidateActiveCache, dataRev } = await import('../../js/core/state.js');
const data = await import('../../js/core/data.js');

const RealDate = Date;
function setNow(iso) {
  const t = new RealDate(iso).getTime();
  globalThis.Date = class extends RealDate {
    constructor(...a) { if (a.length) super(...a); else super(t); }
    static now() { return t; }
  };
}
function restoreNow() { globalThis.Date = RealDate; }

const baseDb = () => ({
  settings: { fxRates: { yearRates: { 2024: 0.0025, 2025: 0.0026 } } },
  properties: [
    { id: 'p1', type: 'long_term', name: 'Flat A', currency: 'EUR' },
    { id: 'p2', type: 'long_term', name: 'Flat B', currency: 'HUF' }
  ],
  tenants: [
    { id: 't1', propertyId: 'p1', status: 'active', monthlyRent: 900, leaseStartDate: '2024-01-10', paymentDayOfMonth: 5 },
    { id: 't2', propertyId: 'p2', status: 'active', monthlyRent: 300000, currency: 'HUF', leaseStartDate: '2024-01-01', paymentDayOfMonth: 1 }
  ],
  payments: [
    { id: 'r1', propertyId: 'p1', type: 'rental', stream: 'long_term_rental', status: 'paid', amount: 900, currency: 'EUR', date: '2024-02-05' }
  ],
  expenses: [{ id: 'e1', propertyId: 'p1', category: 'cleaning', amount: 50, currency: 'EUR', date: '2024-02-10' }],
  vendors: [{ id: 'v1', name: 'Cleaner' }],
  invoices: [],
  forecasts: [{ id: 'fc1', type: 'property', entityId: 'p1', year: 2024, months: { '2024-02': { revenue: 0, expenses: 20 } } }]
});
const prop = id => data.byId('properties', id);
// Same frozen entry objects ⇔ the schedule came from the cache.
const cachedHit = (a, b) => a.length > 0 && a[0] === b[0];

test('dataRev: scoped bump moves only that collection; unscoped / sync / setDb move all', () => {
  setDb(baseDb());
  const r = c => dataRev(c);
  const p0 = r('payments'), v0 = r('vendors'), s0 = r('settings');
  markDirty('vendors');
  assert.equal(r('payments'), p0);
  assert.equal(r('settings'), s0);
  assert.notEqual(r('vendors'), v0);
  const p1 = r('payments'), v1 = r('vendors');
  markDirty();
  assert.notEqual(r('payments'), p1); assert.notEqual(r('vendors'), v1); assert.notEqual(r('settings'), s0);
  const p2 = r('payments');
  invalidateActiveCache('payments');
  assert.notEqual(r('payments'), p2);
  const p3 = r('payments'), t3 = r('tenants');
  invalidateActiveCache();
  assert.notEqual(r('payments'), p3); assert.notEqual(r('tenants'), t3);
  const p4 = r('payments');
  // A direct editSeq bump that bypassed markDirty counts as an unscoped edit.
  state.editSeq++;
  assert.notEqual(r('payments'), p4);
  const p5 = r('payments');
  setDb(baseDb());
  assert.notEqual(r('payments'), p5);
});

test('rent schedule cache survives vendor/expense/invoice edits, drops on payment/tenant/property edits', () => {
  setNow('2024-06-15T12:00:00');
  try {
    setDb(baseDb());
    const a = data.generatePaymentSchedule(prop('p1'));
    data.upsert('vendors', { ...data.byId('vendors', 'v1'), name: 'Cleaner 2' });
    data.upsert('expenses', { id: 'e2', propertyId: 'p1', category: 'cleaning', amount: 10, currency: 'EUR', date: '2024-03-10' });
    data.softDelete('expenses', 'e1');
    data.upsert('invoices', { id: 'i1', stream: 'customer_success', status: 'paid', subtotal: 1, total: 1, currency: 'EUR', issueDate: '2024-05-01' });
    const b = data.generatePaymentSchedule(prop('p1'));
    assert.ok(cachedHit(a, b), 'vendor/expense/invoice edits must not drop the rent schedule cache');
    assert.deepEqual(b, data.generatePaymentSchedule({ ...prop('p1') }));

    // Payment edit: May becomes paid.
    assert.equal(b.find(e => e.monthKey === '2024-05').paid, false);
    data.upsert('payments', { id: 'r2', propertyId: 'p1', type: 'rental', stream: 'long_term_rental', status: 'paid', amount: 900, currency: 'EUR', date: '2024-05-05' });
    const c = data.generatePaymentSchedule(prop('p1'));
    assert.ok(!cachedHit(b, c));
    assert.equal(c.find(e => e.monthKey === '2024-05').paid, true);

    // Tenant edit: rent change.
    data.upsert('tenants', { ...data.byId('tenants', 't1'), monthlyRent: 1000 });
    const d = data.generatePaymentSchedule(prop('p1'));
    assert.ok(!cachedHit(c, d));
    assert.equal(d.find(e => e.monthKey === '2024-06').amount, 1000);

    // Payment soft-delete.
    data.softDelete('payments', 'r2');
    const e = data.generatePaymentSchedule(prop('p1'));
    assert.equal(e.find(x => x.monthKey === '2024-05').paid, false);

    // Property edit: vacant period hides unpaid months.
    data.upsert('properties', { ...prop('p1'), vacantPeriods: [{ startDate: '2024-04-01', endDate: '2024-12-31' }] });
    const f = data.generatePaymentSchedule(prop('p1'));
    assert.equal(f.find(x => x.monthKey === '2024-05'), undefined);
    assert.deepEqual(f, data.generatePaymentSchedule({ ...prop('p1') }));
  } finally { restoreNow(); }
});

test('sync-style invalidateActiveCache() drops every derived cache', () => {
  setNow('2024-06-15T12:00:00');
  try {
    setDb(baseDb());
    const a = data.generatePaymentSchedule(prop('p1'));
    const fa = data.getForecastVsActual('property', 'p1', 2024);
    // Sync adopts a remote record in place (no markDirty), then invalidates.
    const pay = { id: 'r9', propertyId: 'p1', type: 'rental', stream: 'long_term_rental', status: 'paid', amount: 900, currency: 'EUR', date: '2024-05-06' };
    state.db.payments.push(pay);
    state._ix.get('payments').set(pay.id, pay);
    // Sync may also rewrite a record's fields in place.
    state.db.forecasts[0].months['2024-02'].expenses = 99;
    invalidateActiveCache();
    const b = data.generatePaymentSchedule(prop('p1'));
    assert.ok(!cachedHit(a, b));
    assert.equal(b.find(e => e.monthKey === '2024-05').paid, true);
    const fb = data.getForecastVsActual('property', 'p1', 2024);
    assert.notEqual(fa.months, fb.months);
    assert.equal(fb.months[1].forecastExp, 99);
  } finally { restoreNow(); }
});

test('settings changes drop toEUR-dependent caches', () => {
  setNow('2024-06-15T12:00:00');
  try {
    setDb(baseDb());
    const a = data.generatePaymentSchedule(prop('p2'));
    const jun = a.find(e => e.monthKey === '2024-06');
    assert.equal(jun.amountEUR, 300000 * 0.0025);

    // In-place FX edit + unscoped markDirty (settings.js pattern).
    state.db.settings.fxRates.yearRates['2024'] = 0.003;
    markDirty();
    const b = data.generatePaymentSchedule(prop('p2'));
    assert.equal(b.find(e => e.monthKey === '2024-06').amountEUR, 300000 * 0.003);

    // patchSettings (new settings identity).
    data.patchSettings({ fxRates: { yearRates: { 2024: 0.004 } } });
    const c = data.generatePaymentSchedule(prop('p2'));
    assert.equal(c.find(e => e.monthKey === '2024-06').amountEUR, 300000 * 0.004);

    // Forecast-vs-actual (LT rent fallback, toEUR) follows too.
    const f = data.getForecastVsActual('property', 'p2', 2024);
    assert.equal(f.months[5].forecastRev, 300000 * 0.004);
    state.db.settings.fxRates.yearRates['2024'] = 0.005;
    markDirty();
    assert.equal(data.getForecastVsActual('property', 'p2', 2024).months[5].forecastRev, 300000 * 0.005);

    // Nearest-year fallback (sorted-years cache) sees a newly added year.
    assert.equal(data.toEUR(1000, 'HUF', '2030-01-01'), 1000 * 0.0026);
    state.db.settings.fxRates.yearRates['2029'] = 0.01;
    markDirty();
    assert.equal(data.toEUR(1000, 'HUF', '2030-01-01'), 1000 * 0.01);
  } finally { restoreNow(); }
});

test('forecast-vs-actual cache: kept across vendor edits, dropped by expense and forecast edits', () => {
  setNow('2024-06-15T12:00:00');
  try {
    setDb(baseDb());
    const a = data.getForecastVsActual('property', 'p1', 2024);
    data.upsert('vendors', { id: 'v2', name: 'Plumber' });
    const b = data.getForecastVsActual('property', 'p1', 2024);
    assert.equal(a.months, b.months);
    data.upsert('expenses', { id: 'e3', propertyId: 'p1', category: 'cleaning', amount: 30, currency: 'EUR', date: '2024-02-12' });
    const c = data.getForecastVsActual('property', 'p1', 2024);
    assert.notEqual(b.months, c.months);
    assert.equal(c.months[1].actualExp, 80);
    data.saveForecastMonth('fc1', '2024-02', { expenses: 25 });
    const d = data.getForecastVsActual('property', 'p1', 2024);
    assert.equal(d.months[1].forecastExp, 25);
  } finally { restoreNow(); }
});

// Randomized equivalence: after any sequence of edits, every memoized value
// equals a from-scratch computation (caches cleared).
test('randomized edits: cached results always equal fresh computations', () => {
  setNow('2024-06-15T12:00:00');
  try {
    setDb(baseDb());
    let seed = 12345;
    const rnd = n => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    const snapshot = () => ({
      s1: data.generatePaymentSchedule(prop('p1')),
      s2: data.generatePaymentSchedule(prop('p2')),
      f1: data.getForecastVsActual('property', 'p1', 2024),
      f2: data.getForecastVsActual('property', 'p2', 2024),
      pb: [...data.paymentsByProperty().entries()].map(([k, v]) => [k, v.map(p => p.id)]),
      eur: data.toEUR(1000, 'HUF', '2031-02-02')
    });
    const ops = [
      () => data.upsert('payments', { id: `rp${rnd(6)}`, propertyId: rnd(2) ? 'p1' : 'p2', type: 'rental', stream: 'long_term_rental', status: rnd(2) ? 'paid' : 'pending', amount: 100 + rnd(900), currency: 'EUR', date: `2024-0${1 + rnd(9)}-0${1 + rnd(9)}` }),
      () => data.softDelete('payments', `rp${rnd(6)}`),
      () => data.upsert('tenants', { ...data.byId('tenants', 't1'), monthlyRent: 500 + rnd(1000) }),
      () => data.upsert('expenses', { id: `ex${rnd(5)}`, propertyId: 'p1', category: 'cleaning', amount: rnd(200), currency: 'EUR', date: `2024-0${1 + rnd(9)}-15` }),
      () => data.upsert('vendors', { id: `vd${rnd(3)}`, name: 'V' + rnd(99) }),
      () => data.upsert('properties', { ...prop('p2'), vacantPeriods: rnd(2) ? [{ startDate: '2024-03-01', endDate: '2024-05-31' }] : [] }),
      () => { state.db.settings.fxRates.yearRates[String(2024 + rnd(8))] = (1 + rnd(9)) / 1000; markDirty(); },
      () => data.saveForecastMonth('fc1', `2024-0${1 + rnd(9)}`, { revenue: rnd(3) ? rnd(2000) : null, expenses: rnd(100) }),
      () => { const p = data.byId('payments', 'r1'); p.amount = 800 + rnd(200); invalidateActiveCache(); }
    ];
    for (let i = 0; i < 300; i++) {
      ops[rnd(ops.length)]();
      if (rnd(3) === 0) continue; // let some edits pile up between reads
      const cached = snapshot();
      data.clearDerivedCaches();
      const freshVals = snapshot();
      assert.deepEqual(cached, freshVals, `mismatch after op #${i}`);
    }
  } finally { restoreNow(); }
});
