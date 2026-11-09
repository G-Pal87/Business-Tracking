// Duplicate / overpaid rent months (long-term properties).
//
// For each month, the rent recorded as paid (rent payments matched to the
// month they cover — rentMonthOf, same as the Rent Schedule) is compared with
// the rent expected that month (generatePaymentSchedule: rent history, part
// months, hand-overs). A month is flagged when:
//   duplicate  two or more paid rent payments of the same amount, or
//   overpaid   more paid than expected (beyond a small tolerance), or
//   part month one full month's rent recorded for a move-in / move-out month
//              the schedule pro-rates (pro-rating, or the payment's month, is off)
//   not due    rent recorded for a month with no rent expected.
// Shown in Needs attention → Data to check, where a payment can be deleted
// (to Trash) or the month marked as correct — remembered per month and set of
// payments in settings.rentChecks.dismissed, so a new payment flags it again.
import { state, markDirty } from './state.js';
import { listActivePayments, generatePaymentSchedule, isRentPayment, rentMonthOf, toEUR, byId, tenantRentForMonth, derivedCache, memoGet } from './data.js';

export const OVERPAY_TOLERANCE = 0.02;   // 2% (rounding, FX, bank fees)
const SAME_AMOUNT = 0.005;                // ±0.5% counts as the same amount

export function rentCheckKey(propertyId, monthKey, paymentIds) {
  return `${propertyId}|${monthKey}|${[...paymentIds].sort().join(',')}`;
}

// Paid rent payments by property id → month — built once, shared until
// payments change (read-only).
const _paidIdxCache = derivedCache(['payments']);
function paidRentByPropertyMonth() {
  return memoGet(_paidIdxCache(), 'idx', buildPaidRentIndex);
}
function buildPaidRentIndex() {
  const out = new Map();
  for (const p of listActivePayments()) {
    if (p.status !== 'paid' || !isRentPayment(p) || !p.propertyId) continue;
    const mk = rentMonthOf(p);
    if (!mk) continue;
    let byMonth = out.get(p.propertyId);
    if (!byMonth) { byMonth = new Map(); out.set(p.propertyId, byMonth); }
    (byMonth.get(mk) || byMonth.set(mk, []).get(mk)).push(p);
  }
  return out;
}

// [{ prop, monthKey, kind, expected, paid, overBy, currency, payments, key }]
export function findRentPaymentIssues(props) {
  const dismissed = new Set(state.db?.settings?.rentChecks?.dismissed || []);
  const paidIdx = paidRentByPropertyMonth();
  const out = [];
  for (const prop of props) {
    if (prop.type !== 'long_term') continue;
    const byMonth = paidIdx.get(prop.id);
    if (!byMonth) continue;
    const sched = new Map();
    for (const e of generatePaymentSchedule(prop)) (sched.get(e.monthKey) || sched.set(e.monthKey, []).get(e.monthKey)).push(e);
    for (const [mk, payments] of byMonth) {
      const entries = sched.get(mk) || [];
      // Work in the rent's own currency when everything uses it, else in EUR.
      const cur = entries[0]?.currency || payments[0].currency || prop.currency || 'EUR';
      const same = entries.every(e => e.currency === cur) && payments.every(p => (p.currency || cur) === cur);
      const money = same ? (amt => amt) : null;
      const expected = entries.reduce((s, e) => s + (same ? e.amount : e.amountEUR || 0), 0);
      const paid = payments.reduce((s, p) => s + (money ? Number(p.amount) || 0 : toEUR(Number(p.amount) || 0, p.currency || cur, p.date)), 0);
      const amounts = payments.map(p => Number(p.amount) || 0);
      const dup = payments.length > 1 && amounts.some((a, i) => amounts.some((b, j) => j !== i && a > 0 && Math.abs(a - b) <= a * SAME_AMOUNT));
      const overBy = paid - expected;
      const over = expected > 0 && overBy > Math.max(1, expected * OVERPAY_TOLERANCE);
      const notDue = expected === 0 && paid > 0;
      if (!dup && !over && !notDue) continue;
      // A pro-rated month paid in full: one payment ≈ the full monthly rent.
      let fullRent = 0;
      for (const e of entries) {
        const t = e.tenantId ? byId('tenants', e.tenantId) : null;
        const r = t ? tenantRentForMonth(t, mk) : null;
        fullRent += r ? (same ? r.amount : toEUR(r.amount, r.currency, `${mk}-01`)) : 0;
      }
      const partMonth = over && !dup && payments.length === 1 && expected < fullRent * 0.98 && Math.abs(paid - fullRent) <= fullRent * OVERPAY_TOLERANCE;
      const key = rentCheckKey(prop.id, mk, payments.map(p => p.id));
      if (dismissed.has(key)) continue;
      out.push({
        prop, monthKey: mk, kind: notDue ? 'not_due' : dup ? 'duplicate' : partMonth ? 'part_month' : 'overpaid', fullRent,
        expected, paid, overBy, currency: same ? cur : 'EUR', payments: [...payments].sort((a, b) => (a.date || '').localeCompare(b.date || '')),
        key
      });
    }
  }
  return out.sort((a, b) => b.monthKey.localeCompare(a.monthKey));
}

// "It's correct" — stop flagging this month with these payments.
export function dismissRentCheck(key) {
  const cur = state.db.settings?.rentChecks?.dismissed || [];
  if (cur.includes(key)) return;
  state.db.settings = { ...(state.db.settings || {}), rentChecks: { ...(state.db.settings?.rentChecks || {}), dismissed: [...cur, key] } };
  markDirty('settings');
}
