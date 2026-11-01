import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
const { setDb } = await import('../../js/core/state.js');
const data = await import('../../js/core/data.js');
const { computeSettlement, recordSettlement } = await import('../../js/core/settlement.js');

// Synthetic lease: 1 000 a month, calendar months, deposit 1 000.
const load = ({ paidSep = true, paidAug = true, moveIn = false, deposit = 1000 } = {}) => setDb({
  settings: {},
  properties: [{ id: 'p1', name: 'Flat', type: 'long_term', currency: 'EUR', owner: 'you' }],
  tenants: [{ id: 't1', propertyId: 'p1', name: 'Anna Kiss', leaseStartDate: moveIn ? '2026-01-17' : '2026-01-01', leaseEndDate: '2027-12-31',
    monthlyRent: 1000, currency: 'EUR', deposit, status: 'active', paymentDayOfMonth: moveIn ? 17 : 1, ...(moveIn ? { rentFromMoveIn: true } : {}) }],
  payments: [
    ...Array.from({ length: 7 }, (_, i) => ({ id: `r${i + 1}`, propertyId: 'p1', tenantId: 't1', amount: 1000, currency: 'EUR', date: `2026-0${i + 1}-01`, status: 'paid', type: 'rental', stream: 'long_term_rental' })),
    ...(paidAug ? [{ id: 'r8', propertyId: 'p1', tenantId: 't1', amount: 1000, currency: 'EUR', date: '2026-08-01', status: 'paid', type: 'rental', stream: 'long_term_rental' }] : []),
    ...(paidSep ? [{ id: 'r9', propertyId: 'p1', tenantId: 't1', amount: 1000, currency: 'EUR', date: '2026-09-01', status: 'paid', type: 'rental', stream: 'long_term_rental' }] : [])
  ]
});
const tenant = () => data.byId('tenants', 't1');

test('paid month, leaving on the 12th: refund only what a replacement pays for (default)', () => {
  load();
  const s = computeSettlement({ tenant: tenant(), termDate: '2026-09-12', replacementFrom: '2026-09-21' });
  assert.deepEqual(s.period && [s.period.from, s.period.to, s.period.paid, s.period.usedDays, s.period.unusedDays], ['2026-09-01', '2026-09-30', 1000, 12, 18]);
  assert.equal(s.refundDays, 10);                       // 21–30 Sep
  assert.equal(s.refund, 333.33);
  assert.equal(s.toGiveBack, 1333.33);                  // + deposit
  // replacement from the day after (default) = every unused day
  assert.equal(computeSettlement({ tenant: tenant(), termDate: '2026-09-12' }).refund, 600);
  assert.equal(computeSettlement({ tenant: tenant(), termDate: '2026-09-12', policy: 'all' }).refund, 600);
  assert.equal(computeSettlement({ tenant: tenant(), termDate: '2026-09-12', policy: 'none' }).refund, 0);
  // a replacement only after the period → nothing refunded
  assert.equal(computeSettlement({ tenant: tenant(), termDate: '2026-09-12', replacementFrom: '2026-10-05' }).refund, 0);
});

test('deductions come out of the deposit; beyond it the tenant owes', () => {
  load();
  let s = computeSettlement({ tenant: tenant(), termDate: '2026-09-30', deductions: [{ reason: 'Cleaning', amount: 150 }, { reason: '', amount: '' }] });
  assert.equal(s.refund, 0);                            // left on the last day: nothing unused
  assert.deepEqual(s.deductions, [{ reason: 'Cleaning', amount: 150 }]);
  assert.equal(s.toGiveBack, 850);
  s = computeSettlement({ tenant: tenant(), termDate: '2026-09-30', deductions: [{ reason: 'Damage', amount: 1400 }] });
  assert.equal(s.toGiveBack, 0); assert.equal(s.tenantOwes, 400);
});

test('unpaid rent (current and earlier) is settled from the deposit', () => {
  load({ paidSep: false, paidAug: false });
  const s = computeSettlement({ tenant: tenant(), termDate: '2026-09-15' });
  assert.deepEqual(s.rentRows.map(r => [r.monthKey, r.amount]), [['2026-08', 1000], ['2026-09', 500]]);
  assert.equal(s.refund, 0);
  assert.equal(s.tenantOwes, 500);                      // 1 000 deposit − 1 500 rent
  assert.equal(computeSettlement({ tenant: tenant(), termDate: '2026-09-15', includeUnpaidRent: false }).rentRows.length, 0);
});

test('rent from move-in day: the period runs 17th → 16th', () => {
  load({ moveIn: true });
  data.upsert('payments', { id: 'r10', propertyId: 'p1', tenantId: 't1', amount: 1000, currency: 'EUR', date: '2026-09-17', status: 'paid', type: 'rental', stream: 'long_term_rental' });
  const s = computeSettlement({ tenant: tenant(), termDate: '2026-10-01', policy: 'all' });
  assert.deepEqual([s.period.from, s.period.to, s.period.usedDays, s.period.unusedDays], ['2026-09-17', '2026-10-16', 15, 15]);
  assert.equal(s.refund, 500);
});

test('recording: refund lowers revenue, unpaid rent and kept deductions become income; schedule stays right', () => {
  load({ paidAug: false });
  const s = computeSettlement({ tenant: tenant(), termDate: '2026-09-12', policy: 'all', deductions: [{ reason: 'Cleaning', amount: 100 }] });
  // refund 600 (13–30 Sep), Aug unpaid 1 000, cleaning 100 → 600 + 1 000 − 1 100 = 500 back
  assert.equal(s.toGiveBack, 500);
  data.upsert('tenants', { ...tenant(), status: 'past', leaseEndDate: '2026-09-12', terminationDate: '2026-09-12' });
  const made = recordSettlement(tenant(), s);
  assert.deepEqual(made.map(p => [p.type, p.amount, p.rentMonth || '']), [['rent_refund', -600, '2026-09'], ['rental', 1000, '2026-08'], ['deposit_withheld', 100, '']]);
  assert.ok(made.every(p => p.status === 'paid' && p.stream === 'long_term_rental' && p.tenantId === 't1' && p.date === '2026-09-12'));
  // the refund isn't rent: September still reads as paid (1 000 for 1–12 Sep expected), August now paid
  const sched = data.generatePaymentSchedule(data.byId('properties', 'p1'));
  const sep = sched.find(e => e.monthKey === '2026-09'), aug = sched.find(e => e.monthKey === '2026-08');
  assert.equal(sep.amount, 400); assert.equal(sep.paid, true);
  assert.equal(aug.paid, true);
  // net money for September: 1 000 paid − 600 refunded = 400 = the 12 days used
  const sepNet = data.listActivePayments().filter(p => (p.rentMonth || p.date.slice(0, 7)) === '2026-09' && p.type !== 'deposit_withheld').reduce((t, p) => t + p.amount, 0);
  assert.equal(sepNet, 400);
});
