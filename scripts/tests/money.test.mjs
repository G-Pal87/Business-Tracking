// Unit tests for the money / tax / date helpers (audit findings M1–M24).
// Synthetic inline data only — no fixtures, no real records.
// Run: node --test scripts/tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Minimal browser stubs so the ES modules import under Node.
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
if (!globalThis.window) globalThis.window = {};

const { state, setDb } = await import('../../js/core/state.js');
const data = await import('../../js/core/data.js');
const helpers = await import('../../js/modules/analytics-helpers.js');
const tax = await import('../../js/modules/cyprus-tax.js');
const { todayYmd, addDaysYmd, addMonthsYmd } = await import('../../js/core/dates.js');

const load = (db) => setDb({ settings: { fxRates: { yearRates: { 2024: 0.0025 } } }, ...db });

// ── FX (M20) ──────────────────────────────────────────────────────────────────
test('toEUR: fallback year and unknown currency are converted but warned about', () => {
  load({});
  assert.equal(data.toEUR(1000, 'HUF', 2024), 2.5);
  assert.equal(data.toEUR(1000, 'HUF', 2030), 2.5); // nearest year
  assert.equal(data.toEUR(10, 'USD', 2024), 10);    // 1:1, as before
  const w = data.getFxWarnings().join(' | ');
  assert.match(w, /2030/);
  assert.match(w, /USD/);
});

// ── applyFilters (M23) ────────────────────────────────────────────────────────
test('applyFilters: invoices are year-filtered by issueDate', () => {
  load({});
  const rows = [{ issueDate: '2024-03-01' }, { issueDate: '2025-03-01' }, { date: '2024-05-05' }];
  assert.equal(data.applyFilters(rows, { year: 2024 }).length, 2);
});

// ── Deductibility (M3) / accrual (M4) / paid date (M22) ──────────────────────
test('isDeductibleExpense: tax, VAT, mortgage off by default; per-record and settings overrides', () => {
  load({});
  assert.equal(data.isDeductibleExpense({ category: 'tax' }), false);
  assert.equal(data.isDeductibleExpense({ category: 'vat' }), false);
  assert.equal(data.isDeductibleExpense({ category: 'mortgage' }), false);
  assert.equal(data.isDeductibleExpense({ category: 'cleaning' }), true);
  assert.equal(data.isDeductibleExpense({ category: 'mortgage', deductible: true }), true);
  state.db.settings.expenseDeductibility = { cleaning: false };
  assert.equal(data.isDeductibleExpense({ category: 'cleaning' }), false);
});

test('isAccruedInvoice / invoiceCashDate', () => {
  assert.equal(data.isAccruedInvoice({ status: 'draft' }), false);
  assert.equal(data.isAccruedInvoice({ status: 'cancelled' }), false);
  assert.equal(data.isAccruedInvoice({ status: 'sent' }), true);
  assert.equal(data.isAccruedInvoice({ status: 'paid' }), true);
  assert.equal(data.invoiceCashDate({ status: 'sent', issueDate: '2024-12-15' }), null);
  assert.equal(data.invoiceCashDate({ status: 'paid', issueDate: '2024-12-15' }), '2024-12-15');
  assert.equal(data.invoiceCashDate({ status: 'paid', issueDate: '2024-12-15', paidDate: '2025-02-20' }), '2025-02-20');
});

// ── Forecast month key (M17) ─────────────────────────────────────────────────
test('forecastActualMonthKey: Airbnb by stay month, others by date', () => {
  assert.equal(data.forecastActualMonthKey({ source: 'airbnb', airbnbCheckIn: '2024-07-31', date: '2024-08-01' }), '2024-07');
  assert.equal(data.forecastActualMonthKey({ source: 'manual', checkIn: '2024-07-31', date: '2024-08-01' }), '2024-08');
});

// ── Rent helpers (M6, M7) ────────────────────────────────────────────────────
test('rentMonthOf falls back to the payment date', () => {
  assert.equal(data.rentMonthOf({ date: '2024-10-02', rentMonth: '2024-09' }), '2024-09');
  assert.equal(data.rentMonthOf({ date: '2024-10-02' }), '2024-10');
  assert.equal(data.rentMonthOf({ date: '2024-10-02', rentMonth: 'bogus' }), '2024-10');
});

test('tenantRentForMonth uses rentHistory per month, flat rent without it', () => {
  const t = { monthlyRent: 850, currency: 'EUR', rentHistory: [{ from: '0000-01', amount: 800 }, { from: '2024-09', amount: 850 }] };
  assert.equal(data.tenantRentForMonth(t, '2024-08').amount, 800);
  assert.equal(data.tenantRentForMonth(t, '2024-09').amount, 850);
  assert.equal(data.tenantRentForMonth({ monthlyRent: 700 }, '2020-01').amount, 700);
});

// ── Rent schedule (M6, M7, M8) ───────────────────────────────────────────────
const LT = { id: 'p1', type: 'long_term', name: 'Flat A', currency: 'EUR' };

test('schedule: part months prorated, hand-over keeps both parts, due day capped at month length', () => {
  load({
    properties: [LT],
    tenants: [
      { id: 't1', propertyId: 'p1', status: 'past', monthlyRent: 900, leaseStartDate: '2024-01-01', leaseEndDate: '2024-04-15', paymentDayOfMonth: 31 },
      { id: 't2', propertyId: 'p1', status: 'past', monthlyRent: 600, leaseStartDate: '2024-04-16', leaseEndDate: '2024-06-30', paymentDayOfMonth: 1 }
    ]
  });
  const s = data.generatePaymentSchedule(LT);
  const feb = s.find(e => e.monthKey === '2024-02');
  assert.equal(feb.date, '2024-02-29'); // 31 → last day of Feb (leap year)
  assert.equal(feb.amount, 900);
  const apr = s.filter(e => e.monthKey === '2024-04');
  assert.equal(apr.length, 2);
  assert.equal(apr.find(e => e.tenantId === 't1').amount, 450);  // 15/30
  const t2apr = apr.find(e => e.tenantId === 't2');
  assert.equal(t2apr.amount, 300);                                // 15/30
  assert.equal(t2apr.date, '2024-04-16');                         // not due before move-in
});

test('schedule: prorateRent false charges full part months; rent history per month', () => {
  load({
    properties: [LT],
    tenants: [{ id: 't1', propertyId: 'p1', status: 'past', monthlyRent: 850, prorateRent: false,
      leaseStartDate: '2024-06-20', leaseEndDate: '2024-10-31',
      rentHistory: [{ from: '0000-01', amount: 800 }, { from: '2024-09', amount: 850 }] }]
  });
  const s = data.generatePaymentSchedule(LT);
  assert.equal(s.find(e => e.monthKey === '2024-06').amount, 800);
  assert.equal(s.find(e => e.monthKey === '2024-08').amount, 800);
  assert.equal(s.find(e => e.monthKey === '2024-09').amount, 850);
});

test('schedule: rent paid late settles its rent month; deposits never count as rent', () => {
  load({
    properties: [LT],
    tenants: [{ id: 't1', propertyId: 'p1', status: 'past', monthlyRent: 800, leaseStartDate: '2024-08-01', leaseEndDate: '2024-10-31' }],
    payments: [
      { id: 'a', propertyId: 'p1', type: 'rental', stream: 'long_term_rental', status: 'paid', amount: 800, date: '2024-10-02', rentMonth: '2024-09' },
      { id: 'b', propertyId: 'p1', type: 'deposit_withheld', stream: 'long_term_rental', status: 'paid', amount: 1600, date: '2024-10-31' }
    ]
  });
  const s = data.generatePaymentSchedule(LT);
  assert.equal(s.find(e => e.monthKey === '2024-09').paid, true);
  assert.equal(s.find(e => e.monthKey === '2024-10').paid, false);
});

// ── Reconciliation (M2, M9, M10, M24) ────────────────────────────────────────
test('reconciliation: ST ignores materialized copies; LT uses schedule, rent only, sale date', () => {
  const ST = { id: 's1', type: 'short_term', name: 'Studio', currency: 'EUR' };
  const SOLD = { ...LT, status: 'sold', soldDate: '2024-06-30' };
  load({
    properties: [ST, SOLD],
    tenants: [{ id: 't1', propertyId: 'p1', status: 'active', monthlyRent: 1000, leaseStartDate: '2024-01-01' }],
    payments: [
      { id: 'x', propertyId: 's1', stream: 'short_term_rental', status: 'paid', amount: 500, date: '2024-03-10' },
      { id: 'y', propertyId: 's1', stream: 'short_term_rental', status: 'materialized', amount: 500, date: '2024-03-10' },
      { id: 'z', propertyId: 'p1', type: 'deposit_withheld', stream: 'long_term_rental', status: 'paid', amount: 2000, date: '2024-06-30' }
    ]
  });
  const ents = data.buildReconciliationData(2024, '', 'all');
  const st = ents.find(e => e.id === 's1');
  assert.equal(st.months[2].expected, 500);
  assert.equal(st.months[2].actual, 500);
  const lt = ents.find(e => e.id === 'p1');
  assert.equal(lt.months[5].expected, 1000);  // June
  assert.equal(lt.months[5].actual, 0);       // deposit isn't rent
  assert.equal(lt.months[6].expected, 0);     // July, after the sale
  // 2024 is fully past: to-date totals equal year totals, every month "past"
  assert.equal(lt.expToDate, lt.totExp);
  assert.ok(lt.months.every(m => m.isPast));
});

test('reconciliation: current month is not past; future months excluded from to-date', () => {
  const yr = Number(todayYmd().slice(0, 4));
  load({ properties: [LT], tenants: [{ id: 't1', propertyId: 'p1', status: 'active', monthlyRent: 100, leaseStartDate: `${yr - 1}-01-01` }] });
  const lt = data.buildReconciliationData(yr, '', 'all').find(e => e.id === 'p1');
  const curIdx = Number(todayYmd().slice(5, 7)) - 1;
  assert.equal(lt.months[curIdx].isPast, false);
  assert.equal(lt.expToDate, 100 * (curIdx + 1));
});

test('getContractExpiryFlag compares calendar days', () => {
  const t = todayYmd();
  assert.equal(data.getContractExpiryFlag({ status: 'active', leaseEndDate: t }).days, 0);
  assert.equal(data.getContractExpiryFlag({ status: 'active', leaseEndDate: addDaysYmd(t, -1) }).status, 'expired');
  assert.equal(data.getContractExpiryFlag({ status: 'active', leaseEndDate: addMonthsYmd(t, 6) }), null);
});

// ── Vendor fee currency (M21) ────────────────────────────────────────────────
test('vendor_rate expense uses the fee currency, not the payout currency', () => {
  load({
    properties: [{ id: 's1', type: 'short_term', name: 'Studio', currency: 'HUF' }],
    vendors: [{ id: 'v1', name: 'Cleaner', cleaningPeriods: [{ id: 'cp', propertyId: 's1', startDate: '2024-01-01', fee: 15000 }] }],
    reservationExpenseRules: [{ id: 'r1', enabled: true, amountSource: 'vendor_rate', category: 'cleaning' }],
    expenses: []
  });
  data.applyReservationExpenseRules({ id: 'pay1', propertyId: 's1', currency: 'EUR', checkIn: '2024-05-01', stream: 'short_term_rental' });
  const e = state.db.expenses.find(x => x.reservationRuleId === 'r1');
  assert.equal(e.amount, 15000);
  assert.equal(e.currency, 'HUF');
});

// ── Dividends GHS / SDC (M19) ────────────────────────────────────────────────
test('GHS: dated rate, cap reduced by other income; SDC only when domiciled', () => {
  load({});
  assert.equal(helpers.ghsRateForDate('2024-06-01'), 0.0265);
  assert.equal(helpers.ghsRateForDate('2019-06-01'), 0.017);
  state.db.settings.dividendTax = { otherIncome: { 2024: { a: 170000 } }, domiciled: { b: true } };
  const g = helpers.ghsByDividend([{ id: 'd1', recipient: 'a', date: '2024-05-01', grossAmount: 50000 }]);
  assert.equal(Math.round(g.get('d1') * 100) / 100, 265); // 10,000 × 2.65%
  assert.equal(helpers.sdcForDividend({ recipient: 'a', date: '2024-05-01', grossAmount: 1000 }), 0);
  assert.equal(helpers.sdcForDividend({ recipient: 'b', date: '2025-05-01', grossAmount: 1000 }), 170);
  assert.equal(helpers.sdcForDividend({ recipient: 'b', date: '2026-05-01', grossAmount: 1000 }), 50);
});

// ── Tax forecast (M5) ────────────────────────────────────────────────────────
test('splitForecastMonthRevenue: pending bookings whole, manual prorated, materialized excluded', () => {
  const md = { revenue: 999, entries: [
    { amount: 100 }, { amount: 200, bookingStatus: 'pending' },
    { amount: 400, bookingStatus: 'materialized' }, { amount: 800, bookingStatus: 'cancelled' }
  ] };
  assert.deepEqual(tax.splitForecastMonthRevenue(md), { manual: 100, lump: 200 });
  assert.deepEqual(tax.splitForecastMonthRevenue(md, false), { manual: 100, lump: 600 });
  assert.deepEqual(tax.splitForecastMonthRevenue({ revenue: 50 }), { manual: 50, lump: 0 });
});

test('forecastRemainingForYear: unpaid scheduled rent counts in full in the cutoff month, paid rent not at all', () => {
  load({
    properties: [LT],
    tenants: [{ id: 't1', propertyId: 'p1', status: 'past', monthlyRent: 900, leaseStartDate: '2024-01-01', leaseEndDate: '2024-12-31', paymentDayOfMonth: 28 }],
    payments: [{ id: 'a', propertyId: 'p1', type: 'rental', stream: 'long_term_rental', status: 'paid', amount: 900, date: '2024-11-01' }]
  });
  // Cutoff 5 Sep: Sep–Dec unpaid except November (paid ahead).
  const r = tax.forecastRemainingForYear(2024, { cutoff: '2024-09-05', scope: 'all' });
  assert.equal(r.revenue, 900 * 3);
});
