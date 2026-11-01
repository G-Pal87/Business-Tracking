// Move-out settlement for a lease termination: how much to give back to the
// tenant (or what they still owe), from the rent period they last paid, the
// deposit and any deductions.
//
//   rent paid for the period covering the termination date
//     − the days used (period start → termination date)
//     = unused days, refunded per `policy`:
//         'replacement' — only the days a replacement tenant pays for (from
//                          `replacementFrom` to the period end) [default]
//         'all'         — every unused day
//         'none'        — nothing
//   + deposit
//   − deductions (unpaid rent is added automatically; damage, cleaning, fee…)
//   = to give back (≥ 0) or tenant owes (< 0)
//
// recordSettlement() books it: the refund as a negative 'rent_refund' payment
// (revenue down for the unused days), unpaid rent settled from the money held
// as that month's rent, other deductions kept as 'deposit_withheld' revenue.
import { listActive, generatePaymentSchedule, isRentPayment, rentMonthOf, upsert, newId, byId } from './data.js';
import { addDaysYmd, diffDaysYmd } from './dates.js';

const r2 = n => Math.round(n * 100) / 100;

export function computeSettlement({ tenant, termDate, policy = 'replacement', replacementFrom = '', deductions = [], includeUnpaidRent = true }) {
  const prop = byId('properties', tenant.propertyId);
  const sched = prop ? generatePaymentSchedule(prop).filter(e => e.tenantId === tenant.id) : [];
  const period = sched.find(e => e.covFrom && e.covTo && e.covFrom <= termDate && termDate <= e.covTo) || null;
  const out = {
    currency: tenant.currency || prop?.currency || 'EUR',
    termDate, policy, period: null, refund: 0, refundDays: 0,
    rentRows: [], deductions: [], deposit: Number(tenant.deposit) || 0
  };
  if (period) {
    const rentPays = listActive('payments').filter(p => p.propertyId === tenant.propertyId && isRentPayment(p) &&
      p.status === 'paid' && rentMonthOf(p) === period.monthKey && (!p.tenantId || p.tenantId === tenant.id));
    const paidSum = rentPays.reduce((s, p) => s + (Number(p.amount) || 0), 0);
    const days = diffDaysYmd(period.covFrom, period.covTo) + 1;
    const usedDays = diffDaysYmd(period.covFrom, termDate) + 1;
    const unusedDays = days - usedDays;
    const paid = Math.min(paidSum, period.amount);
    out.period = { from: period.covFrom, to: period.covTo, monthKey: period.monthKey, amount: period.amount, paid, days, usedDays, unusedDays };
    if (paid > 0 && unusedDays > 0) {
      const firstUnused = addDaysYmd(termDate, 1);
      const repl = policy === 'replacement' ? (replacementFrom && replacementFrom > termDate ? replacementFrom : firstUnused) : firstUnused;
      out.replacementFrom = policy === 'replacement' ? repl : '';
      out.refundDays = policy === 'none' ? 0 : repl > period.covTo ? 0 : diffDaysYmd(repl, period.covTo) + 1;
      out.refund = r2(paid * out.refundDays / days);
    }
    // The period isn't paid: the days used are owed.
    if (includeUnpaidRent && paid <= 0 && usedDays > 0) {
      out.rentRows.push({ kind: 'rent', monthKey: period.monthKey, reason: `Unpaid rent ${period.covFrom} – ${termDate}`, amount: r2(period.amount * usedDays / days) });
    }
  }
  // Earlier rent still unpaid.
  if (includeUnpaidRent) {
    for (const e of sched) {
      if (e.paid || !e.overdue || (period && e.monthKey >= period.monthKey) || e.covFrom > termDate) continue;
      out.rentRows.push({ kind: 'rent', monthKey: e.monthKey, reason: `Unpaid rent ${e.monthKey}`, amount: r2(e.amount) });
    }
    out.rentRows.sort((a, b) => a.monthKey.localeCompare(b.monthKey));
  }
  out.deductions = deductions.filter(d => Number(d.amount) > 0).map(d => ({ reason: String(d.reason || '').trim() || 'Deduction', amount: r2(Number(d.amount)) }));
  const rentOwed = out.rentRows.reduce((s, d) => s + d.amount, 0);
  const other = out.deductions.reduce((s, d) => s + d.amount, 0);
  out.totalDeductions = r2(rentOwed + other);
  out.net = r2(out.refund + out.deposit - out.totalDeductions);
  out.toGiveBack = out.net > 0 ? out.net : 0;
  out.tenantOwes = out.net < 0 ? r2(-out.net) : 0;
  return out;
}

// Books a computed settlement (see the header). Returns the payments created.
export function recordSettlement(tenant, s) {
  const base = { propertyId: tenant.propertyId, tenantId: tenant.id, currency: s.currency, date: s.termDate, status: 'paid', source: 'manual', stream: 'long_term_rental' };
  const made = [];
  const add = p => { const rec = { id: newId('pay'), ...base, ...p }; upsert('payments', rec); made.push(rec); };
  if (s.refund > 0 && s.period) {
    add({ type: 'rent_refund', amount: -s.refund, rentMonth: s.period.monthKey,
      notes: `Rent refund — ${s.refundDays} unused day(s) to ${s.period.to} (lease termination, ${tenant.name})` });
  }
  // What the tenant owes is settled from the money held (deposit + refund),
  // unpaid rent first; anything beyond that stays owed (recorded when paid).
  let pool = s.deposit + s.refund;
  for (const row of s.rentRows) {
    const amt = r2(Math.min(row.amount, pool));
    if (amt <= 0) break;
    add({ type: 'rental', amount: amt, rentMonth: row.monthKey, notes: `${row.reason} — settled from the deposit at termination` });
    pool = r2(pool - amt);
  }
  const otherTotal = s.deductions.reduce((t, d) => t + d.amount, 0);
  const kept = r2(Math.min(otherTotal, pool));
  if (kept > 0) {
    add({ type: 'deposit_withheld', amount: kept,
      notes: `Kept at termination (${tenant.name}): ${s.deductions.map(d => `${d.reason} ${d.amount}`).join(', ')}` });
  }
  return made;
}
