// Data layer: CRUD + aggregations + currency conversion
import { state, markDirty, runBatch } from './state.js';
import { MASTER_CURRENCY, EXPENSE_CATEGORIES } from './config.js';
import { today, toast } from './ui.js';
import { daysInMonth, diffDaysYmd, addMonthsYmd } from './dates.js';

const _fmtCache    = new Map();
const _numFmtCache = new Map();

// ============== Currency ==============
// FX conversions that had to guess — a HUF amount in a year with no rate
// configured (nearest year's rate used instead) or a currency with no rate
// table at all (counted 1:1 as EUR). Each distinct case is warned about once
// per session instead of being absorbed silently into the totals.
const _fxWarned = new Set();
const _fxWarnings = [];
function _fxWarn(key, message) {
  if (_fxWarned.has(key)) return;
  _fxWarned.add(key);
  _fxWarnings.push(message);
  console.warn('[BT] ' + message);
  try { toast(message, 'warning', 8000); } catch { /* no DOM (tests) */ }
}
export function getFxWarnings() { return [..._fxWarnings]; }

export function toEUR(amount, currency, dateOrYear) {
  if (!amount) return 0;
  if (currency === 'EUR' || !currency) return Number(amount);
  if (currency === 'HUF') {
    const yearRates = state.db.settings?.fxRates?.yearRates || {};
    const years = Object.keys(yearRates);
    if (years.length === 0) {
      // No FX table configured at all — returning the raw HUF number as if
      // it were EUR would silently inflate totals ~300-400x. 0 undercounts,
      // but it's the safer failure mode for a financial aggregate.
      console.warn('[BT] toEUR: no HUF FX rates configured — treating amount as 0 EUR instead of guessing');
      return 0;
    }
    const exactYear = String(dateOrYear || '').slice(0, 4);
    let rate = exactYear ? yearRates[exactYear] : undefined;
    if (rate === undefined) {
      // Fall back to the nearest configured year by absolute distance (not
      // always the most recent), so a record older than the earliest
      // configured year doesn't get converted with a much-later rate.
      const sorted = years.map(Number).sort((a, b) => a - b);
      const target = exactYear ? Number(exactYear) : sorted[sorted.length - 1];
      const nearest = sorted.reduce((best, yr) => Math.abs(yr - target) < Math.abs(best - target) ? yr : best);
      rate = yearRates[String(nearest)];
      if (exactYear) _fxWarn(`HUF:${exactYear}`, `No HUF→EUR rate set for ${exactYear} — using the ${nearest} rate instead. Add it in Settings (annual FX rates).`);
    }
    return Number(amount) * rate;
  }
  // No rate table exists for any other currency — still counted 1:1 (as
  // before), but flagged so a stray USD/GBP record doesn't pass unnoticed.
  _fxWarn(`CUR:${currency}`, `No FX rate for ${currency} — ${currency} amounts are being counted 1:1 as EUR.`);
  return Number(amount);
}

export function formatMoney(amount, currency = 'EUR', options = {}) {
  // Currency comes from synced records; only a well-formed ISO 4217 code is
  // ever passed through, so the output never carries arbitrary text (callers
  // insert it into HTML). Anything else formats as a plain number.
  if (typeof currency === 'string' && /^[A-Za-z]{3}$/.test(currency)) currency = currency.toUpperCase();
  else currency = null;
  if (!currency) {
    const frac = options.maxFrac ?? 2;
    return formatPlainNumber(amount, frac, Math.min(options.minFrac ?? 2, frac));
  }
  const maxFrac = options.maxFrac ?? (currency === 'HUF' ? 0 : 2);
  const minFrac = Math.min(options.minFrac ?? (currency === 'HUF' ? 0 : 2), maxFrac);
  const key = `${currency}:${maxFrac}:${minFrac}`;
  let fmt = _fmtCache.get(key);
  if (!fmt) {
    try {
      fmt = new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: maxFrac, minimumFractionDigits: minFrac });
    } catch (e) {
      return `${formatPlainNumber(amount, maxFrac, minFrac)} ${currency}`;
    }
    _fmtCache.set(key, fmt);
  }
  return fmt.format(amount || 0);
}

function formatPlainNumber(amount, maxFrac, minFrac) {
  const n = Number(amount);
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: maxFrac, minimumFractionDigits: minFrac })
    .format(Number.isFinite(n) ? n : 0);
}

export function formatEUR(amount, options = {}) {
  return formatMoney(amount, 'EUR', options);
}

export function formatNumber(n, frac = 0) {
  let fmt = _numFmtCache.get(frac);
  if (!fmt) {
    fmt = new Intl.NumberFormat('en-US', { minimumFractionDigits: frac, maximumFractionDigits: frac });
    _numFmtCache.set(frac, fmt);
  }
  return fmt.format(n || 0);
}

// ============== IDs ==============
export function newId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`;
}

// ============== Generic CRUD ==============
export function upsert(collection, item) {
  if (collection === 'users' && item.role === 'admin') {
    // Defense-in-depth against the trivial self-escalation path (calling
    // upsert('users', {role:'admin'}) from the console): block granting NEW
    // admin status unless the acting session is already an admin, or this
    // is the very first account ever created (no users exist yet). This is
    // NOT a real security boundary — there's no backend, so a determined
    // attacker could still bypass it — but it closes the trivial case.
    const existingUsers = state.db.users || [];
    const priorRecord = existingUsers.find(u => u.id === item.id);
    const grantingAdmin = !priorRecord || priorRecord.role !== 'admin';
    const isBootstrap = existingUsers.length === 0;
    if (grantingAdmin && !isBootstrap && state.session?.role !== 'admin') {
      throw new Error('Only an existing admin can grant admin access');
    }
  }
  const now = Date.now();
  const actor = state.session?.username || 'system';
  const arr = state.db[collection] || (state.db[collection] = []);
  const ix  = state._ix?.get(collection);
  // Use the id index (when available) to decide insert vs. replace in O(1).
  // Only fall back to the O(n) findIndex for the rarer in-place replace, and
  // skip the scan entirely for brand-new records — this is what makes bulk
  // imports O(n) instead of O(n²).
  const isNew = ix ? !ix.has(item.id) : arr.findIndex(x => x.id === item.id) < 0;
  if (isNew) {
    item.createdAt = now;
    item.createdBy = actor;
  }
  // Monotonic: always later than the version being replaced, even when this
  // device's clock runs behind the one that wrote it — otherwise the merge
  // (last-writer-wins where it can't tell) could treat this edit as older.
  const prev = isNew ? null : (ix?.get(item.id) || arr.find(x => x.id === item.id));
  item.updatedAt = nextStamp(prev?.updatedAt, now);
  item.updatedBy = actor;
  if (isNew) {
    arr.push(item);
  } else {
    const idx = arr.findIndex(x => x.id === item.id);
    if (idx >= 0) arr[idx] = item; else arr.push(item);
  }
  ix?.set(item.id, item);
  markDirty();
  return item;
}

// WARNING: internal / machine-generated records only.
// Do NOT call remove() for user-facing business entities — use softDelete() instead.
export function remove(collection, id) {
  const arr = state.db[collection] || [];
  const idx = arr.findIndex(x => x.id === id);
  if (idx >= 0) {
    arr.splice(idx, 1);
    state._ix?.get(collection)?.delete(id);
    markDirty();
    return true;
  }
  return false;
}

export function softDelete(collection, id) {
  // Locate via the id index (O(1)) instead of scanning the array.
  const item = state._ix?.get(collection)?.get(id) || (state.db[collection] || []).find(x => x.id === id);
  if (!item) return false;
  const now = Date.now();
  const actor = state.session?.username || 'system';
  item.deletedAt = now;
  item.deletedBy = actor;
  item.updatedAt = nextStamp(item.updatedAt, now);
  item.updatedBy = actor;
  markDirty();
  return true;
}

// updatedAt for an edit of a record last stamped `prev`: now, or just after
// `prev` when this device's clock is behind it.
export function nextStamp(prev, now = Date.now()) {
  return Math.max(now, (Number(prev) || 0) + 1);
}

export function listActive(collection) {
  // Memoized: the filtered array is cached per collection and reused until the
  // collection mutates (state.markDirty/setDb clear state._activeCache). This
  // collapses the many listActive() calls per render into one scan per data
  // version — critical as soft-deleted records accumulate. Returning the shared
  // reference is safe: no caller mutates a listActive() return in place.
  const cache = state._activeCache;
  if (cache) {
    const hit = cache.get(collection);
    if (hit) return hit;
    const arr = (state.db[collection] || []).filter(x => !x.deletedAt);
    cache.set(collection, arr);
    return arr;
  }
  return (state.db[collection] || []).filter(x => !x.deletedAt);
}

export function listActivePayments()   { return listActive('payments'); }
export function listActiveExpenses()   { return listActive('expenses'); }
export function listActiveInvoices()   { return listActive('invoices'); }
export function listActiveProperties() { return listActive('properties'); }
export function listActiveTenants()    { return listActive('tenants'); }
export function listActiveVendors()    { return listActive('vendors'); }
export function listActiveClients()    { return listActive('clients'); }
export function listActiveServices()   { return listActive('services'); }
export function listActiveInventory()  { return listActive('inventory'); }

// ============== STR (short-term rental) helpers ==============
// Airbnb payout adjustments (Resolution Adjustment, Resolution Payout,
// Cancellation Fee, Adjustment) share the same check-in/check-out dates as the
// "Reservation" record they adjust. Treating them as separate booked nights
// double-counts occupancy/nights-sold and skews ADR-per-night wherever nights
// are summed or iterated directly from payment records.
export function isReservationNight(p) {
  return !(p.source === 'airbnb' && p.airbnbType && p.airbnbType !== 'Reservation');
}

function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const sv = source[key];
    const tv = result[key];
    if (sv !== null && typeof sv === 'object' && !Array.isArray(sv) &&
        tv !== null && typeof tv === 'object' && !Array.isArray(tv)) {
      result[key] = deepMerge(tv, sv);
    } else {
      result[key] = sv;
    }
  }
  return result;
}

export function patchSettings(patch) {
  if (!state.db.settings) state.db.settings = {};
  state.db.settings = deepMerge(state.db.settings, patch);
  markDirty();
}

export function createRecord(collection, data) {
  const item = { id: newId(collection.slice(0, 3)), ...data };
  return upsert(collection, item);
}

export function updateRecord(collection, id, patch) {
  const item = byId(collection, id);
  if (!item) return null;
  return upsert(collection, { ...item, ...patch });
}

export function byId(collection, id) {
  const ix = state._ix?.get(collection);
  if (ix) return ix.get(id);
  return (state.db[collection] || []).find(x => x.id === id);
}

// ============== Filtering ==============
export function applyFilters(rows, { year, years, stream, owner, propertyId, clientId } = {}) {
  const f = state.ui.filters;
  const y = year ?? f.year;
  const s = stream ?? f.stream;
  const o = owner ?? f.owner;

  return rows.filter(r => {
    // Invoices carry issueDate, not date — without the fallback they skipped
    // the year test entirely and every year's invoices were counted.
    const d = r.date || r.issueDate;
    if (years instanceof Set && years.size > 0 && d) {
      if (![...years].some(yr => d.startsWith(String(yr)))) return false;
    } else if (y && y !== 'all' && d) {
      if (!d.startsWith(String(y))) return false;
    }
    if (s && s !== 'all' && r.stream && r.stream !== s) return false;
    if (o && o !== 'all' && o !== 'both') {
      // A record with no owner assigned defaults to 'both' (shared) — same
      // convention used by mOwner() in analytics-filters.js — so it's an
      // explicit rule here too, not an accidental pass-through of falsy
      // `r.owner`.
      const ro = r.owner || 'both';
      if (ro !== 'both' && ro !== o) return false;
    }
    if (propertyId && r.propertyId !== propertyId) return false;
    if (clientId && r.clientId !== clientId) return false;
    return true;
  });
}

// ============== Cost classification helpers ==============

// Backwards-compatible CapEx detection:
// New records carry accountingType; legacy records fall back to category === 'renovation'.
export function isCapEx(e) {
  if (e.accountingType) return e.accountingType === 'capex';
  return e.category === 'renovation';
}

// Legacy category → costCategory mapping (mirrors COST_CATEGORIES in config.js)
const LEGACY_CAT_MAP = {
  mortgage:             'financing',           maintenance:          'maintenance',
  renovation:           'renovation',          tax:                  'tax',
  utilities:            'utilities',           management:           'property_management',
  cleaning:             'cleaning',            electricity:          'utilities',
  water:                'utilities',           inventory:            'inventory',
  vat:                  'tax',                 reimbursement:        'other',
  str_fee:              'property_management', salary:               'payroll',
  social_contributions: 'payroll',             gesy:                 'payroll',
  eurolife:             'insurance',           other:                'other'
};

// Derives accountingType / costCategory / recurrence for any expense record
// without mutating stored data — safe, non-destructive migration layer.
export function resolveExpenseFields(e) {
  return {
    accountingType: e.accountingType || (e.category === 'renovation' ? 'capex' : 'opex'),
    costCategory:   e.costCategory   || LEGACY_CAT_MAP[e.category] || 'other',
    recurrence:     e.recurrence     || (e.recurringGroupId ? 'recurring' : (e.category === 'renovation' || e.category === 'reimbursement') ? 'one_off' : 'recurring')
  };
}

// Whether an expense is a deductible business cost for corporation tax and
// operating profit. A per-record `deductible` boolean wins; otherwise the
// category default applies (settings.expenseDeductibility[category] can
// override config.js EXPENSE_CATEGORIES[category].deductible). Tax payments,
// VAT remittances and mortgage repayments default to non-deductible.
export function isDeductibleExpense(e) {
  if (typeof e?.deductible === 'boolean') return e.deductible;
  const cat = e?.category || 'other';
  const override = state.db.settings?.expenseDeductibility?.[cat];
  if (typeof override === 'boolean') return override;
  return EXPENSE_CATEGORIES[cat]?.deductible !== false;
}

// Invoice statuses that never represent earned revenue.
const NON_ACCRUED_INVOICE_STATUSES = new Set(['draft', 'cancelled', 'void']);
// Accrual basis (tax / P&L): an invoice counts once issued, paid or not,
// on its issue date. Drafts and cancelled/void invoices never count.
export function isAccruedInvoice(i) {
  return !!i && !NON_ACCRUED_INVOICE_STATUSES.has(i.status);
}
// Cash basis: the date a paid invoice's money came in — `paidDate` when it
// was recorded (invoices.js stamps it on "mark paid"), else the issue date
// (legacy records). Null for an invoice that isn't paid.
export function invoiceCashDate(i) {
  if (!i || i.status !== 'paid') return null;
  return i.paidDate || i.issueDate || i.date || null;
}

// ============== Aggregations ==============
export function totalRevenueEUR(filters) {
  const payments = applyFilters(listActivePayments(), filters).filter(p => p.status === 'paid');
  const invoices = applyFilters(listActive('invoices'), filters).filter(i => i.status === 'paid');

  let total = 0;
  for (const p of payments) total += toEUR(p.amount, p.currency, p.date);
  // Revenue excludes VAT/tax collected on behalf of the tax authority — use
  // subtotal (pre-tax), not total. Falls back to total only for legacy
  // records that predate the subtotal field.
  for (const i of invoices) total += toEUR(i.subtotal ?? i.total, i.currency, i.issueDate);
  return total;
}

export function totalExpensesEUR(filters, { includeRenovation = true } = {}) {
  let rows = applyFilters(listActive('expenses'), filters);
  if (!includeRenovation) rows = rows.filter(e => !isCapEx(e));
  let total = 0;
  for (const e of rows) total += toEUR(e.amount, e.currency, e.date);
  return total;
}

export function renovationCapexEUR(filters) {
  const rows = applyFilters(listActive('expenses'), filters).filter(e => isCapEx(e));
  let total = 0;
  for (const e of rows) total += toEUR(e.amount, e.currency, e.date);
  return total;
}

// ── Sum helpers — operate on already-filtered arrays ─────────────────────────
export function sumPaymentsEUR(payments) {
  return payments.reduce((s, p) => s + toEUR(p.amount, p.currency, p.date), 0);
}
// Revenue excludes VAT/tax collected on the tax authority's behalf — sums
// subtotal (pre-tax), not total. Falls back to total only for legacy
// records that predate the subtotal field.
export function sumInvoicesEUR(invoices) {
  return invoices.reduce((s, i) => s + toEUR(i.subtotal ?? i.total, i.currency, i.issueDate), 0);
}
export function sumExpensesEUR(expenses) {
  return expenses.reduce((s, e) => s + toEUR(e.amount, e.currency, e.date), 0);
}

// Unfiltered yearly totals — used for period-over-period comparisons
export function yearTotalsEUR(year) {
  const pays  = listActivePayments().filter(p => p.status === 'paid'    && (p.date      || '').startsWith(year));
  const invs  = listActive('invoices').filter(i => i.status === 'paid'  && (i.issueDate || '').startsWith(year));
  const opEx  = listActive('expenses').filter(e => !isCapEx(e)          && (e.date      || '').startsWith(year));
  const capEx = listActive('expenses').filter(e =>  isCapEx(e)          && (e.date      || '').startsWith(year));
  const rev   = sumPaymentsEUR(pays) + sumInvoicesEUR(invs);
  const exp   = sumExpensesEUR(opEx);
  const reno  = sumExpensesEUR(capEx);
  return { rev, exp, reno, net: rev - exp, netCash: rev - exp - reno };
}

export function netIncomeEUR(filters) {
  return totalRevenueEUR(filters) - totalExpensesEUR(filters, { includeRenovation: false });
}

export function ytdRange() {
  // Local date — toISOString() is the UTC date, a day behind after local midnight.
  const t = today();
  return { start: `${t.slice(0, 4)}-01-01`, end: t };
}

function inDateRange(date, start, end) {
  return date >= start && date <= end;
}

export function revenueInRangeEUR(start, end, filters = {}) {
  const rows = listActivePayments().filter(p => inDateRange(p.date, start, end) && p.status === 'paid');
  const invs = listActive('invoices').filter(i => inDateRange(i.issueDate, start, end) && i.status === 'paid');
  const fRows = applyFilters(rows, filters);
  const fInvs = applyFilters(invs.map(i => ({ ...i, date: i.issueDate })), filters);
  let total = 0;
  for (const p of fRows) total += toEUR(p.amount, p.currency, p.date);
  // Revenue excludes VAT/tax — subtotal, not total (falls back to total for
  // legacy records that predate the subtotal field).
  for (const i of fInvs) total += toEUR(i.subtotal ?? i.total, i.currency, i.date);
  return total;
}

export function expensesInRangeEUR(start, end, filters = {}, { includeRenovation = true } = {}) {
  let rows = listActive('expenses').filter(e => inDateRange(e.date, start, end));
  if (!includeRenovation) rows = rows.filter(e => !isCapEx(e));
  rows = applyFilters(rows, filters);
  let total = 0;
  for (const e of rows) total += toEUR(e.amount, e.currency, e.date);
  return total;
}

export function propertyRevenueEUR(propertyId, filters) {
  const rows = listActivePayments().filter(p => p.propertyId === propertyId && p.status === 'paid');
  const filtered = applyFilters(rows, filters);
  return filtered.reduce((s, p) => s + toEUR(p.amount, p.currency, p.date), 0);
}

export function propertyExpensesEUR(propertyId, filters, { includeRenovation = true } = {}) {
  let rows = listActive('expenses').filter(e => e.propertyId === propertyId);
  if (!includeRenovation) rows = rows.filter(e => !isCapEx(e));
  const filtered = applyFilters(rows, filters);
  return filtered.reduce((s, e) => s + toEUR(e.amount, e.currency, e.date), 0);
}

export function propertyROI(propertyId) {
  const prop = byId('properties', propertyId);
  if (!prop) return 0;
  const purchaseEUR = toEUR(prop.purchasePrice, prop.currency, prop.purchaseDate);
  // "Total invested" is a lifetime figure — pin year:'all' explicitly so it
  // doesn't inherit whatever year happens to be selected in the ambient
  // dashboard filter (state.ui.filters.year).
  const renoEUR = renovationCapexEUR({ propertyId, year: 'all' });
  const totalInvested = purchaseEUR + renoEUR;
  if (!totalInvested) return 0;
  const now = new Date().getFullYear();
  const rev = propertyRevenueEUR(propertyId, { year: now });
  const exp = propertyExpensesEUR(propertyId, { year: now }, { includeRenovation: false });
  const net = rev - exp;
  return (net / totalInvested) * 100;
}

// net profit / total invested capital × 100
// Accepts pre-computed { netIncome, totalInvested } to avoid double work in callers
// that already have filtered data; falls back to current-year calculation.
export function simplePropertyROI(propertyId, { netIncome, totalInvested } = {}) {
  const prop = byId('properties', propertyId);
  if (!prop) return null;

  const invested = totalInvested !== undefined ? totalInvested : (() => {
    const purchaseEUR = prop.purchasePrice
      ? toEUR(prop.purchasePrice, prop.currency, prop.purchaseDate) : 0;
    // Lifetime figure — see propertyROI() above for why year is pinned to 'all'.
    return purchaseEUR + renovationCapexEUR({ propertyId, year: 'all' });
  })();
  if (invested <= 0) return null;

  const net = netIncome !== undefined ? netIncome : (() => {
    const yr  = new Date().getFullYear();
    const rev = propertyRevenueEUR(propertyId, { year: yr });
    const exp = propertyExpensesEUR(propertyId, { year: yr }, { includeRenovation: false });
    return rev - exp;
  })();

  return (net / invested) * 100;
}

// Simple ROI normalized by years of ownership since purchaseDate.
// Represents the average annual return per year the asset has been held.
// Accepts same overrides as simplePropertyROI.
export function annualizedPropertyROI(propertyId, { netIncome, totalInvested } = {}) {
  const prop = byId('properties', propertyId);
  if (!prop || !prop.purchaseDate) return null;

  // Holding period ends at the sale date for a sold property — counting the
  // years after it was sold kept shrinking its annualized ROI forever.
  const endMs = (prop.status === 'sold' && prop.soldDate) ? new Date(prop.soldDate).getTime() : Date.now();
  const years = (endMs - new Date(prop.purchaseDate).getTime()) / (365.25 * 24 * 3600 * 1000);
  if (years < 0.083) return null; // less than ~1 month owned — too early to be meaningful

  const simple = simplePropertyROI(propertyId, { netIncome, totalInvested });
  if (simple === null) return null;

  return simple / years;
}

// Annual cash flow / actual cash invested × 100
// Cash invested = purchase price − mortgage balance (i.e., the equity/down-payment).
// Returns null when no mortgage data is present (cash purchase) or when the
// mortgage covers the full price, since the denominator would be zero.
export function cashOnCashPropertyROI(propertyId, { annualCashFlow } = {}) {
  const prop = byId('properties', propertyId);
  if (!prop || !(prop.mortgageAmount > 0) || !prop.purchasePrice) return null;

  const purchaseEUR  = toEUR(prop.purchasePrice,   prop.currency, prop.purchaseDate);
  const mortgageEUR  = toEUR(prop.mortgageAmount,  prop.currency, prop.purchaseDate);
  const cashInvested = purchaseEUR - mortgageEUR;
  if (cashInvested <= 0) return null;

  const cashFlow = annualCashFlow !== undefined ? annualCashFlow : (() => {
    const yr  = new Date().getFullYear();
    const rev = propertyRevenueEUR(propertyId, { year: yr });
    const exp = propertyExpensesEUR(propertyId, { year: yr }, { includeRenovation: false });
    return rev - exp;
  })();

  return (cashFlow / cashInvested) * 100;
}

export function groupByMonth(rows, dateField = 'date', amountField = 'amount', currencyField = 'currency') {
  const map = new Map();
  for (const r of rows) {
    const key = (r[dateField] || '').slice(0, 7); // YYYY-MM
    if (!key) continue;
    map.set(key, (map.get(key) || 0) + toEUR(r[amountField], r[currencyField], r[dateField]));
  }
  return map;
}

export function groupByStream(rows, amountField = 'amount', currencyField = 'currency') {
  const map = new Map();
  for (const r of rows) {
    const k = r.stream || 'other';
    map.set(k, (map.get(k) || 0) + toEUR(r[amountField], r[currencyField], r.date || r.issueDate));
  }
  return map;
}

export function groupByCategory(rows) {
  const map = new Map();
  for (const r of rows) {
    const k = r.category || 'other';
    map.set(k, (map.get(k) || 0) + toEUR(r.amount, r.currency, r.date));
  }
  return map;
}

export function recentActivity(limit = 8) {
  const items = [];
  for (const p of listActivePayments()) items.push({ kind: 'payment', date: p.date, data: p });
  for (const e of listActive('expenses')) items.push({ kind: 'expense', date: e.date, data: e });
  for (const i of listActive('invoices')) items.push({ kind: 'invoice', date: i.issueDate, data: i });
  items.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  return items.slice(0, limit);
}

export function availableYears() {
  const years = new Set();
  for (const p of listActivePayments()) if (p.date) years.add(p.date.slice(0, 4));
  for (const e of listActive('expenses')) if (e.date) years.add(e.date.slice(0, 4));
  for (const i of listActive('invoices')) if (i.issueDate) years.add(i.issueDate.slice(0, 4));
  // Include years that have forecast records (e.g. from pending Airbnb import)
  for (const f of (state.db.forecasts || [])) if (f.year) years.add(String(f.year));
  return [...years].sort().reverse();
}

// ============== Vendors ==============
export function getVendors() { return listActive('vendors'); }
export function getVendorsByProperty(propertyId) {
  return listActive('vendors').filter(v => !v.propertyIds?.length || v.propertyIds.includes(propertyId));
}

// ============== Forecasts ==============
export function getOrCreateForecast(type, entityId, year) {
  const existing = (state.db.forecasts || []).find(f => f.type === type && f.entityId === entityId && f.year === Number(year));
  if (existing) {
    if (!existing.yearTarget) {
      existing.yearTarget = { revenue: 0, expenses: 0 };
      upsert('forecasts', existing);
    }
    return existing;
  }
  // Deterministic id: two devices creating the same year's forecast (e.g.
  // both importing bookings) create the SAME record, which merges, instead
  // of two records whose totals then both count.
  const fc = { id: `fcs_${type}_${entityId}_${Number(year)}`, type, entityId, year: Number(year), taxRate: 0, yearTarget: { revenue: 0, expenses: 0 }, months: {} };
  upsert('forecasts', fc);
  return fc;
}

export function saveForecastMonth(forecastId, month, data) {
  const fc = (state.db.forecasts || []).find(f => f.id === forecastId);
  if (!fc) return;
  fc.months[month] = { ...(fc.months[month] || {}), ...data };
  upsert('forecasts', fc);
}

// Multi-entry forecast helpers (used by service forecast).
// When entries[] exists, the month's revenue is auto-derived from their sum.
// Months with only the legacy `revenue` field continue to work unchanged.
export function getForecastEntries(forecastId, month) {
  const fc = (state.db.forecasts || []).find(f => f.id === forecastId);
  return fc?.months?.[month]?.entries || [];
}

// A booking-linked entry (entry.bookingStatus set) that's been cancelled or
// manually removed is kept in entries[] as a tombstone — so a later re-import
// never resurrects it — but must not count toward revenue. Plain manual
// entries (no bookingStatus) are unaffected and always count, same as before.
// Exported so every place that independently re-sums entries[] (analytics
// dashboards mirroring this same data) excludes tombstones consistently
// instead of each re-implementing the same filter inline.
export function sumForecastEntries(entries) {
  return entries.reduce((s, e) => {
    if (e.bookingStatus === 'cancelled' || e.bookingStatus === 'removed') return s;
    return s + (Number(e.amount) || 0);
  }, 0);
}

export function upsertForecastEntry(forecastId, month, entry) {
  const fc = (state.db.forecasts || []).find(f => f.id === forecastId);
  if (!fc) return null;
  if (!fc.months[month]) fc.months[month] = {};
  const m = fc.months[month];
  if (!Array.isArray(m.entries)) m.entries = [];
  if (!entry.id) entry.id = newId('fce');
  const idx = m.entries.findIndex(e => e.id === entry.id);
  if (idx >= 0) m.entries[idx] = entry; else m.entries.push(entry);
  m.revenue = sumForecastEntries(m.entries);
  upsert('forecasts', fc);
  return entry;
}

export function removeForecastEntry(forecastId, month, entryId) {
  const fc = (state.db.forecasts || []).find(f => f.id === forecastId);
  const m = fc?.months?.[month];
  if (!m?.entries) return;
  m.entries = m.entries.filter(e => e.id !== entryId);
  m.revenue = sumForecastEntries(m.entries);
  upsert('forecasts', fc);
}

export function setForecastTaxRate(forecastId, rate) {
  const fc = (state.db.forecasts || []).find(f => f.id === forecastId);
  if (!fc) return;
  fc.taxRate = Number(rate) || 0;
  upsert('forecasts', fc);
}

export function saveForecastYear(forecastId, data) {
  const fc = (state.db.forecasts || []).find(f => f.id === forecastId);
  if (!fc) return;
  fc.yearTarget = { ...(fc.yearTarget || {}), ...data };
  upsert('forecasts', fc);
}

// Month a payment's actual lands in for forecast-vs-actual. An Airbnb payout
// counts in its stay (check-in) month — the month its forecast line is keyed
// by (payments.js syncAirbnbForecastEntry) — so a 31 Jul check-in paid out
// 1 Aug doesn't read as −100% in July and +100% in August. Everything else
// counts on its payment date, as before.
export function forecastActualMonthKey(p) {
  const d = (p?.source === 'airbnb' && p.airbnbCheckIn) ? p.airbnbCheckIn : p?.date;
  return (d || '').slice(0, 7);
}

export function getForecastVsActual(type, entityId, year) {
  const fc = (state.db.forecasts || []).find(f => f.type === type && f.entityId === entityId && f.year === Number(year));

  // For LT rental properties: build a monthKey→amountEUR map from the rent schedule
  // so months with no manual forecast entry still show projected rent.
  let ltRentByMonth = null;
  if (type === 'property') {
    const prop = byId('properties', entityId);
    if (prop?.type === 'long_term') {
      ltRentByMonth = {};
      for (const entry of generatePaymentSchedule(prop)) {
        // += : a hand-over month can carry two tenants' part-month rent.
        if (entry.monthKey?.startsWith(String(year))) {
          ltRentByMonth[entry.monthKey] = (ltRentByMonth[entry.monthKey] || 0) + toEUR(entry.amount, entry.currency, year);
        }
      }
    }
  }

  // Pre-filter collections to entity + year — avoids 24 full-collection scans
  const yearStr = String(year);
  let entityPayments = null, entityExpenses = null, entityInvoices = null;
  if (type === 'property') {
    entityPayments = listActivePayments().filter(p => p.propertyId === entityId && p.status === 'paid' && forecastActualMonthKey(p).startsWith(yearStr));
    entityExpenses = listActive('expenses').filter(e => e.propertyId === entityId && !isCapEx(e) && (e.date || '').startsWith(yearStr));
  } else {
    entityInvoices = listActive('invoices').filter(i => i.stream === entityId && i.status === 'paid' && (i.issueDate || '').startsWith(yearStr));
    // Service-stream expenses match by e.stream (same convention as
    // getActualExpRows in forecast.js) — this used to be left unset, so
    // actualExp was hardcoded to 0 for every service-forecast month below.
    entityExpenses = listActive('expenses').filter(e => e.stream === entityId && !isCapEx(e) && (e.date || '').startsWith(yearStr));
  }

  const months = [];
  for (let m = 1; m <= 12; m++) {
    const key = `${year}-${String(m).padStart(2, '0')}`;
    const start = `${key}-01`;
    const end = `${key}-${new Date(year, m, 0).getDate().toString().padStart(2, '0')}`;
    let actualRev = 0, actualExp = 0;
    if (type === 'property') {
      actualRev = entityPayments.filter(p => forecastActualMonthKey(p) === key).reduce((s, p) => s + toEUR(p.amount, p.currency, year), 0);
    } else {
      // Revenue excludes VAT/tax — subtotal, not total (falls back to total
      // for legacy records that predate the subtotal field).
      actualRev = entityInvoices.filter(i => i.issueDate >= start && i.issueDate <= end).reduce((s, i) => s + toEUR(i.subtotal ?? i.total, i.currency, year), 0);
    }
    actualExp = entityExpenses.filter(e => e.date >= start && e.date <= end).reduce((s, e) => s + toEUR(e.amount, e.currency, year), 0);
    const fd = fc?.months?.[key] || {};
    // Fall back to scheduled LT rent only when no forecast entry exists at all
    // for this month — `!= null` (not `||`) so an explicit revenue of 0 (e.g.
    // "tenant moving out, no rent expected") is respected instead of being
    // silently replaced by the scheduled rent.
    const forecastRev = fd.revenue != null ? fd.revenue : (ltRentByMonth?.[key] ?? 0);
    const forecastExp = fd.expenses || 0;
    months.push({ key, forecastRev, forecastExp, actualRev, actualExp, revVariance: actualRev - forecastRev, expVariance: actualExp - forecastExp });
  }
  return { forecast: fc, months, yearTarget: fc?.yearTarget || { revenue: 0, expenses: 0 } };
}

export function forecastedRevenueEUR(year) {
  const forecasts = (state.db.forecasts || []).filter(f => f.year === Number(year));
  return forecasts.reduce((sum, fc) => {
    return sum + Object.values(fc.months || {}).reduce((ms, md) => {
      const entries = Array.isArray(md.entries) ? md.entries : [];
      return ms + (entries.length > 0
        ? sumForecastEntries(entries)
        : Number(md.revenue) || 0);
    }, 0);
  }, 0);
}

// Returns a Map of YYYY-MM → forecasted EUR for monthly trend overlay
export function forecastMonthlyEUR(year) {
  const forecasts = (state.db.forecasts || []).filter(f => f.year === Number(year));
  const map = new Map();
  for (const fc of forecasts) {
    for (const [mk, md] of Object.entries(fc.months || {})) {
      const entries = Array.isArray(md.entries) ? md.entries : [];
      const val = entries.length > 0 ? sumForecastEntries(entries) : Number(md.revenue) || 0;
      if (val > 0) map.set(mk, (map.get(mk) || 0) + val);
    }
  }
  return map;
}

// (estimateTaxForYear used to live here — unused, and it mixed year-to-date
// actual expenses with a full-year revenue forecast. The tax estimate lives
// in cyprus-tax.js getActualsForYear / forecastRemainingForYear.)

// ============== LT Schedule ==============

// Payments on a long-term property that are NOT a month's rent — a withheld
// deposit or termination fee (tenants.js) used to be stored as type
// 'rental', which marked the final month's unpaid rent as paid.
export const NON_RENT_PAYMENT_TYPES = new Set(['deposit_withheld', 'termination_fee']);
export function isRentPayment(p) {
  return (p.stream === 'long_term_rental' || p.type === 'rental') && !NON_RENT_PAYMENT_TYPES.has(p.type);
}

// Tenants whose rent is expected: never prospective ones; a past tenant only
// up to their termination/lease-end date (or this month if neither is set —
// switching a tenant to "Past" without an end date used to keep generating
// overdue rent 13 months into the future).
function _expectedRentLease(t) {
  if (!t.monthlyRent || t.status === 'prospective') return null;
  if (t.status !== 'past') return t;
  // No end date at all: rent stops after the current month (a whole month,
  // not prorated to today — the end is a guess, not a move-out date).
  const t0 = today();
  const end = t.terminationDate || t.leaseEndDate ||
    `${t0.slice(0, 7)}-${String(daysInMonth(+t0.slice(0, 4), +t0.slice(5, 7))).padStart(2, '0')}`;
  return { ...t, leaseEndDate: t.leaseEndDate && t.leaseEndDate < end ? t.leaseEndDate : end };
}

// Month a rent payment covers. Rent recorded from the schedule carries an
// explicit `rentMonth` ('YYYY-MM'), so September rent paid on 2 October still
// settles September; older records (and payments without one) fall back to
// the month of the payment date.
export function rentMonthOf(p) {
  const rm = p?.rentMonth;
  if (typeof rm === 'string' && /^\d{4}-\d{2}$/.test(rm)) return rm;
  return (p?.date || '').slice(0, 7);
}

// A tenant's rent for one month. `rentHistory` ([{ from: 'YYYY-MM', amount,
// currency? }], written by tenants.js when the rent changes) is looked up
// per month so a rent increase doesn't rewrite the months before it; a
// month before the first entry uses the first entry. Tenants without a
// history keep using the flat monthlyRent for every month, as before.
export function tenantRentForMonth(t, monthKey) {
  const hist = Array.isArray(t?.rentHistory)
    ? t.rentHistory.filter(h => h && typeof h.from === 'string' && Number(h.amount) > 0)
    : [];
  if (!hist.length) return { amount: Number(t?.monthlyRent) || 0, currency: t?.currency || 'EUR' };
  const sorted = [...hist].sort((a, b) => a.from.localeCompare(b.from));
  let pick = sorted[0];
  for (const h of sorted) if (h.from.slice(0, 7) <= monthKey) pick = h;
  return { amount: Number(pick.amount), currency: pick.currency || t.currency || 'EUR' };
}

const _pad2 = n => String(n).padStart(2, '0');
const _addMonthsMk = (mk, n) => addMonthsYmd(`${mk}-01`, n).slice(0, 7);

// Internal helper: raw (unlinked) schedule entries for one lease segment.
// leaseData: monthlyRent, currency, rentHistory?, leaseStartDate?,
// leaseEndDate?, paymentDayOfMonth?, prorateRent?
// A month the lease only partly covers (starts on the 20th, ends on the 15th)
// is prorated by days unless the tenant has prorateRent === false. The due
// day is capped at the month's real length (31 → 30 Apr / 28 Feb), and a
// part month is never due before the lease starts.
function _scheduleSegment(leaseData, tenantId) {
  const curMk = today().slice(0, 7);
  const startMk = leaseData.leaseStartDate ? leaseData.leaseStartDate.slice(0, 7) : _addMonthsMk(curMk, -11);
  const endMk   = leaseData.leaseEndDate   ? leaseData.leaseEndDate.slice(0, 7)   : _addMonthsMk(curMk, 12);
  const payDay  = Math.min(Math.max(Math.floor(Number(leaseData.paymentDayOfMonth)) || 1, 1), 31);
  const prorate = leaseData.prorateRent !== false;
  const ls = leaseData.leaseStartDate ? leaseData.leaseStartDate.slice(0, 10) : '';
  const le = leaseData.leaseEndDate   ? leaseData.leaseEndDate.slice(0, 10)   : '';

  const results = [];
  for (let mk = startMk, guard = 0; mk <= endMk && guard < 1200; mk = _addMonthsMk(mk, 1), guard++) {
    const y = Number(mk.slice(0, 4)), m = Number(mk.slice(5, 7));
    const dim = daysInMonth(y, m);
    const monthStart = `${mk}-01`, monthEnd = `${mk}-${_pad2(dim)}`;
    const covFrom = ls && ls > monthStart ? ls : monthStart;
    const covTo   = le && le < monthEnd   ? le : monthEnd;
    if (covTo < covFrom) continue;
    const rent = tenantRentForMonth(leaseData, mk);
    const days = diffDaysYmd(covFrom, covTo) + 1;
    const amount = prorate && days < dim ? Math.round(rent.amount * days / dim * 100) / 100 : rent.amount;
    let date = `${mk}-${_pad2(Math.min(payDay, dim))}`;
    if (date < covFrom) date = covFrom;
    results.push({
      date, monthKey: mk, covFrom, covTo,
      amount, currency: rent.currency,
      amountEUR: toEUR(amount, rent.currency, y),
      tenantId: tenantId || null
    });
  }
  return results;
}

export const CONTRACT_EXPIRY_WARNING_DAYS = 60;

// Flags an active tenant's lease as already ended or ending soon (within
// CONTRACT_EXPIRY_WARNING_DAYS). Returns null when there's nothing to flag
// (no end date, lease not active, or the end date is far in the future).
export function getContractExpiryFlag(tenant) {
  if (!tenant || !tenant.leaseEndDate || tenant.status !== 'active') return null;
  // Whole calendar days between local today and the end date — comparing a
  // UTC-midnight Date with the local "now" flagged leases a few hours off.
  const diffDays = diffDaysYmd(today(), tenant.leaseEndDate.slice(0, 10));
  if (diffDays < 0) return { status: 'expired', days: diffDays };
  if (diffDays <= CONTRACT_EXPIRY_WARNING_DAYS) return { status: 'expiring-soon', days: diffDays };
  return null;
}

// A tenant's stored `status` flips to 'past' the instant a lease is
// terminated, even when the termination date entered is still in the
// future — so terminating "as of tomorrow" would otherwise already read
// as a past tenant today, everywhere status is displayed. This computes
// the effective display status, holding at 'terminating' until that date
// actually arrives.
export function getTenantDisplayStatus(tenant) {
  if (tenant?.status === 'past' && tenant.terminationDate && tenant.terminationDate > today()) {
    return 'terminating';
  }
  return tenant?.status;
}

export function generatePaymentSchedule(property) {
  if (property.type !== 'long_term') return [];

  const tenants = listActive('tenants')
    .filter(t => t.propertyId === property.id)
    .map(_expectedRentLease)
    .filter(Boolean)
    .sort((a, b) => (a.leaseStartDate || '').localeCompare(b.leaseStartDate || ''));

  if (!tenants.length) return [];

  // This property's rent payments by the month they cover (rentMonthOf).
  const paysByMonth = new Map();
  for (const p of listActivePayments()) {
    if (p.propertyId !== property.id || !isRentPayment(p)) continue;
    const mk = rentMonthOf(p);
    if (!mk) continue;
    const arr = paysByMonth.get(mk) || [];
    arr.push(p);
    paysByMonth.set(mk, arr);
  }

  const vacantPeriods = property.vacantPeriods || [];
  const soldDate = (property.status === 'sold' && property.soldDate) ? property.soldDate : null;

  // Merge segments from all tenants (already sorted earlier-lease-first
  // above) in tenant-priority order, so "earlier lease wins" is decided by
  // lease start date rather than day-of-month. Only days two leases BOTH
  // cover are contested: a hand-over month where one lease ends on the 15th
  // and the next starts on the 16th keeps both part-month entries.
  const byMonth = new Map();
  for (const t of tenants) {
    for (const e of _scheduleSegment(t, t.id)) {
      const acc = byMonth.get(e.monthKey) || [];
      if (acc.some(a => e.covFrom <= a.covTo && a.covFrom <= e.covTo)) continue;
      acc.push(e);
      byMonth.set(e.monthKey, acc);
    }
  }

  const todayStr = today();
  const out = [];
  for (const [mk, entries] of byMonth) {
    const monthPays = paysByMonth.get(mk) || [];
    const used = new Set();
    for (const e of entries) {
      // One tenant that month: any rent payment for the property counts, as
      // before. A hand-over month matches each part to a payment tagged with
      // that tenant (or an untagged one), and one payment settles one part.
      const cands = entries.length === 1 ? monthPays
        : monthPays.filter(p => !used.has(p.id) && (!p.tenantId || p.tenantId === e.tenantId))
          .sort((a, b) => (b.tenantId === e.tenantId) - (a.tenantId === e.tenantId));
      const paidPayment = cands.find(p => p.status === 'paid') || null;
      const linkedPayment = paidPayment || cands[0] || null;
      if (entries.length > 1 && paidPayment) used.add(paidPayment.id);
      const paid = !!paidPayment;
      // Skip unpaid entries in a vacant period or on/after the sold date
      if (!paid) {
        const inVacant = vacantPeriods.some(vp =>
          vp.startDate && e.date >= vp.startDate && e.date <= (vp.endDate || '9999-12-31')
        );
        const afterSold = soldDate ? e.date > soldDate : false;
        if (inVacant || afterSold) continue;
      }
      // Overdue only AFTER the due day — comparing a local-midnight due date
      // with "now" flagged rent overdue on the due day itself.
      const overdue = !paid && e.date < todayStr;
      out.push({
        ...e, paid, overdue,
        paidPaymentId: paidPayment?.id || null,
        linkedPaymentId: linkedPayment?.id || null
      });
    }
  }
  out.sort((a, b) => a.date.localeCompare(b.date));
  return out;
}

// ============== Reconciliation ==============
// ownerFilter: '' (all) | 'you' | 'rita' — a property/invoice tagged 'both'
// always matches, mirroring the owner-filter convention used across every
// analytics-*.js dashboard's mOwner()/ownerMatches() matcher.
// scope: 'all' (default — every property/invoice, personal included, matching
// this function's original behaviour) | 'company' — excludes personal-channel
// properties and personal-flagged invoices, same as every analytics
// dashboard's Company-only/All scope toggle.
// Year totals plus "to date" totals (months up to and including the current
// one) — headline Expected / Outstanding / collection rate use the to-date
// pair so rent that isn't due yet doesn't read as outstanding.
function _recTotals(months, curMk) {
  let totExp = 0, totAct = 0, expToDate = 0, actToDate = 0;
  for (const m of months) {
    totExp += m.expected; totAct += m.actual;
    if (m.mk <= curMk) { expToDate += m.expected; actToDate += m.actual; }
  }
  return { totExp, totAct, totVariance: totAct - totExp, expToDate, actToDate };
}

export function buildReconciliationData(year, ownerFilter, scope) {
  const yr = Number(year);
  const yearStr = String(yr);
  // A month is "past" once it has fully ended in local time — comparing the
  // month-end's local midnight with "now" counted the current month as past
  // on its own last day.
  const curMk = today().slice(0, 7);

  const matchPropOwner = prop => {
    if (!ownerFilter) return true;
    const ow = prop.owner || 'both';
    return ow === 'both' || ow === ownerFilter;
  };
  const matchInvOwner = inv => {
    if (!ownerFilter) return true;
    let ow = inv.owner;
    if (!ow && inv.clientId) ow = byId('clients', inv.clientId)?.owner;
    ow = ow || 'both';
    return ow === 'both' || ow === ownerFilter;
  };
  const matchPropScope = prop => scope !== 'company' || (prop.channel || 'company') === 'company';
  const coPropIds = companyPropIds();
  const matchInvScope = inv => scope !== 'company' || isCompanyRecord(inv, coPropIds);

  // Pre-build lookup maps — avoids O(n) listActive() scans inside nested loops
  const paysByProp = new Map();
  // Long-term rent is matched by the month it covers (rentMonthOf), which
  // can sit in a different year from the payment date (December rent paid
  // on 2 January), so it gets its own map keyed by property.
  const rentByProp = new Map();
  for (const p of listActivePayments()) {
    if (p.status === 'paid' && isRentPayment(p) && rentMonthOf(p).startsWith(yearStr)) {
      const arr = rentByProp.get(p.propertyId) || [];
      arr.push(p);
      rentByProp.set(p.propertyId, arr);
    }
    if (!(p.date || '').startsWith(yearStr)) continue;
    const arr = paysByProp.get(p.propertyId) || [];
    arr.push(p);
    paysByProp.set(p.propertyId, arr);
  }
  const invsByStream = new Map();
  for (const i of listActive('invoices')) {
    if (!isAccruedInvoice(i) || !(i.issueDate || '').startsWith(yearStr) || !matchInvOwner(i) || !matchInvScope(i)) continue;
    const arr = invsByStream.get(i.stream) || [];
    arr.push(i);
    invsByStream.set(i.stream, arr);
  }

  const entities = [];

  for (const prop of listActive('properties')) {
    if (!matchPropOwner(prop) || !matchPropScope(prop)) continue;
    const propPayments = paysByProp.get(prop.id) || [];
    const propRent = rentByProp.get(prop.id) || [];
    // Long-term Expected comes from the rent schedule itself, so vacancies,
    // the sale date, rent changes and part months all apply here too.
    const schedByMonth = new Map();
    if (prop.type === 'long_term') {
      for (const e of generatePaymentSchedule(prop)) {
        if (!e.monthKey.startsWith(yearStr)) continue;
        schedByMonth.set(e.monthKey, (schedByMonth.get(e.monthKey) || 0) + toEUR(e.amount, e.currency, yr));
      }
    }
    const months = [];
    for (let m = 1; m <= 12; m++) {
      const mk = `${yr}-${String(m).padStart(2, '0')}`;
      const start = `${mk}-01`;
      const end = `${mk}-${new Date(yr, m, 0).getDate().toString().padStart(2, '0')}`;
      const isPast = mk < curMk;
      let expected = 0, actual = 0;

      if (prop.type === 'long_term') {
        expected = schedByMonth.get(mk) || 0;
        // Rent only (no withheld deposit / termination fee), by rent month.
        actual = propRent
          .filter(p => rentMonthOf(p) === mk)
          .reduce((s, p) => s + toEUR(p.amount, p.currency, yr), 0);
      } else if (prop.type === 'short_term') {
        // A materialized row is a frozen copy of a forecast booking that has
        // since paid out — its paid record is already here, so counting both
        // doubled Expected.
        const monthPays = propPayments.filter(p => p.date >= start && p.date <= end && p.status !== 'materialized');
        expected = monthPays.reduce((s, p) => s + toEUR(p.amount, p.currency, yr), 0);
        actual   = monthPays.filter(p => p.status === 'paid').reduce((s, p) => s + toEUR(p.amount, p.currency, yr), 0);
      }

      months.push({ mk, m, expected, actual, variance: actual - expected, isPast });
    }
    entities.push({
      id: prop.id, label: prop.name,
      kind: prop.type === 'long_term' ? 'lt' : 'st',
      months, ..._recTotals(months, curMk)
    });
  }

  // Services: issued invoices = expected; paid = actual
  for (const { stream, label } of [
    { stream: 'customer_success',  label: 'Customer Success' },
    { stream: 'marketing_services', label: 'Marketing Services' }
  ]) {
    const streamInvs = invsByStream.get(stream) || [];
    const months = [];
    for (let m = 1; m <= 12; m++) {
      const mk = `${yr}-${String(m).padStart(2, '0')}`;
      const start = `${mk}-01`;
      const end = `${mk}-${new Date(yr, m, 0).getDate().toString().padStart(2, '0')}`;
      const isPast = mk < curMk;
      const invs = streamInvs.filter(i => i.issueDate >= start && i.issueDate <= end);
      const expected = invs.reduce((s, i) => s + toEUR(i.total, i.currency, yr), 0);
      const actual   = invs.filter(i => i.status === 'paid').reduce((s, i) => s + toEUR(i.total, i.currency, yr), 0);
      months.push({ mk, m, expected, actual, variance: actual - expected, isPast });
    }
    entities.push({ id: stream, label, kind: 'service', months, ..._recTotals(months, curMk) });
  }

  return entities;
}

// ============== Centralised report data (single source of truth) ==============
export function buildReportData(filters = {}) {
  const f = { ...state.ui.filters, ...filters };
  const matchDate = row => {
    if (f.years instanceof Set) {
      if (f.years.size === 0) return true;
      const d = row.date || row.issueDate || '';
      return [...f.years].some(y => d.startsWith(String(y)));
    }
    if (!f.year || f.year === 'all') return true;
    const d = row.date || row.issueDate || '';
    return d.startsWith(String(f.year));
  };
  const matchStream = row => {
    if (f.streams instanceof Set) return f.streams.size === 0 || !row.stream || f.streams.has(row.stream);
    return !f.stream || f.stream === 'all' || !row.stream || row.stream === f.stream;
  };
  const matchProperty = row => {
    if (f.propertyIds instanceof Set) return f.propertyIds.size === 0 || f.propertyIds.has(row.propertyId);
    return !f.propertyId || f.propertyId === 'all' || row.propertyId === f.propertyId;
  };

  const payments = listActivePayments().filter(p => p.status === 'paid' && matchDate(p) && matchStream(p) && matchProperty(p));
  const invoices = listActive('invoices').filter(i => i.status === 'paid' && matchDate({ date: i.issueDate }) && matchStream(i) && matchProperty(i));
  const allExpenses  = listActive('expenses');
  const opExpenses   = allExpenses.filter(e => !isCapEx(e) && matchDate(e) && matchStream(e) && matchProperty(e));
  const renoExpenses = allExpenses.filter(e =>  isCapEx(e) && matchDate(e) && matchProperty(e));

  // Revenue excludes VAT/tax — subtotal, not total (falls back to total for
  // legacy records that predate the subtotal field).
  const rev = [...payments, ...invoices.map(i => ({ ...i, amount: i.subtotal ?? i.total, date: i.date || i.issueDate }))].reduce((s, r) => s + toEUR(r.amount, r.currency, r.date), 0);
  const exp = opExpenses.reduce((s, r) => s + toEUR(r.amount, r.currency, r.date), 0);
  const reno = renoExpenses.reduce((s, r) => s + toEUR(r.amount, r.currency, r.date), 0);

  return { payments, invoices, opExpenses, renoExpenses, rev, exp, reno, net: rev - exp };
}

// Returns true if a record counts as "company" scope: payments explicitly
// flagged `personal` (e.g. off-platform bookings that don't go through the
// company) are always excluded, regardless of their property's channel;
// otherwise scope follows the property's channel as before.
export function isCompanyRecord(r, coPropIds) {
  if (r.personal) return false;
  return !r.propertyId || coPropIds.has(r.propertyId);
}

// Returns a Set of property IDs whose channel is 'company' (or unset, which defaults to company).
// Records without a propertyId (e.g. salary expenses, service invoices) are always company-scope.
export function companyPropIds() {
  return new Set(
    listActive('properties')
      .filter(p => (p.channel || 'company') === 'company')
      .map(p => p.id)
  );
}

// ============== Drill-down row normalisers (used by all reporting modules) ==============
export function drillRevRows(payments, invoices) {
  return [
    ...(payments || []).map(p => ({ date: p.date, type: 'Payment', source: byId('properties', p.propertyId)?.name || p.source || '', ref: p.type || '', eur: toEUR(p.amount, p.currency, p.date) })),
    ...(invoices || []).map(i => ({ date: i.issueDate || i.date, type: 'Invoice', source: byId('clients', i.clientId)?.name || '', ref: i.number || '', eur: toEUR(i.total || i.amount, i.currency, i.issueDate || i.date) }))
  ].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

export function drillExpRows(expenses) {
  return (expenses || []).map(e => ({ date: e.date, source: byId('properties', e.propertyId)?.name || '', category: e.category, description: e.description || '', eur: toEUR(e.amount, e.currency, e.date) }))
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

export function drillNetRows(payments, invoices, expenses) {
  return [
    ...drillRevRows(payments, invoices).map(r => ({ date: r.date, kind: 'Revenue', source: r.source + (r.ref ? ' · ' + r.ref : ''), eur: r.eur })),
    ...drillExpRows(expenses).map(r => ({ date: r.date, kind: 'Expense', source: (r.source ? r.source + ' · ' : '') + r.category, eur: r.eur }))
  ].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

// VAT-exclusive variants for P&L-purpose drill-downs (Revenue, Net Operating Profit, etc.) —
// invoices carry VAT in `total`; P&L figures must use pre-tax `subtotal`. Cash-purpose call
// sites (Net Cash Flow, Outstanding/Overdue/Paid Invoices, Actual Collected) keep using
// drillRevRows/drillNetRows directly since VAT collected is real cash.
function pnlInvoices(invoices) {
  return (invoices || []).map(i => ({ ...i, total: i.subtotal ?? i.total }));
}

export function drillRevRowsPnL(payments, invoices) {
  return drillRevRows(payments, pnlInvoices(invoices));
}

export function drillNetRowsPnL(payments, invoices, expenses) {
  return drillNetRows(payments, pnlInvoices(invoices), expenses);
}

// ============== Trash / Soft-delete management ==============

export function listDeletedRecords() {
  const records = [];
  Object.keys(state.db).forEach(collection => {
    if (!Array.isArray(state.db[collection])) return;
    if (collection === 'syncConflicts') return; // dismissed conflict notes, not user records
    state.db[collection]
      .filter(item => item && item.deletedAt)
      .forEach(item => records.push({ key: `${collection}:${item.id}`, collection, item }));
  });
  return records;
}

export function restoreRecord(collection, id) {
  const arr = state.db[collection];
  if (!Array.isArray(arr)) return false;
  const item = arr.find(x => x.id === id);
  if (!item || !item.deletedAt) return false;
  delete item.deletedAt;
  delete item.deletedBy;
  item.updatedAt = nextStamp(item.updatedAt);
  item.updatedBy = state.session?.username || 'system';
  markDirty();
  return true;
}

// Permanent-delete tombstones: every id ever hard-deleted is recorded here
// (synced as part of db.json, same as any other field) so mergeDb/
// mergeLocalPending/resyncDb can refuse to resurrect it no matter what a
// stale/lagging GitHub read claims. Without this, a hard delete that already
// pushed successfully could still come back: any LATER push (for something
// completely unrelated) that happens to fetch a lagging copy of GitHub —
// one still showing the old, deleted record — had no way to know the record
// was gone for a *reason* rather than just "not yet in this snapshot", so it
// flowed straight through into the merge and got written back to remote,
// resurrecting it both there and locally. A permanent, explicit tombstone
// closes that off entirely instead of relying on timestamp heuristics, which
// this exact bug shape has broken more than once tonight.
export function recordTombstone(collection, id) {
  if (!state.db._tombstones) state.db._tombstones = {};
  state.db._tombstones[`${collection}:${id}`] = Date.now();
}

// Bounds tombstone growth — kept for maxAgeDays. Must comfortably exceed
// autoPurgeOldDeleted's own maxAgeDays (5, see app.js): a tombstone is only
// created once a soft-deleted record is hard-purged at that point, so its
// total protection window is 5 days + this value. A device offline for
// longer than that total — plausible for weeks-long trips, not just a lagging
// GitHub read — that made a genuine edit to a record before it was deleted
// elsewhere could resurrect it once reconnected, if the tombstone has
// already expired by then. 30 days keeps that combined window realistic
// while tombstones themselves stay tiny (a timestamp per deleted id).
export function pruneTombstones(maxAgeDays = 30) {
  const tombstones = state.db._tombstones;
  if (!tombstones) return 0;
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  let count = 0;
  for (const key of Object.keys(tombstones)) {
    if (tombstones[key] < cutoff) { delete tombstones[key]; count++; }
  }
  return count;
}

export function permanentlyDeleteRecord(collection, id) {
  const arr = state.db[collection];
  if (!Array.isArray(arr)) return false;
  const index = arr.findIndex(x => x && x.id === id);
  if (index === -1) return false;
  arr.splice(index, 1);
  state._ix?.get(collection)?.delete(id);
  recordTombstone(collection, id);
  markDirty();
  return true;
}

export function restoreRecords(records) {
  let count = 0;
  records.forEach(({ collection, id }) => {
    const arr = state.db[collection];
    if (!Array.isArray(arr)) return;
    const item = arr.find(x => x.id === id);
    if (!item || !item.deletedAt) return;
    delete item.deletedAt;
    delete item.deletedBy;
    item.updatedAt = nextStamp(item.updatedAt);
    item.updatedBy = state.session?.username || 'system';
    count++;
  });
  if (count > 0) markDirty();
  return count;
}

export function permanentlyDeleteRecords(records) {
  let count = 0;
  records.forEach(({ collection, id }) => {
    const arr = state.db[collection];
    if (!Array.isArray(arr)) return;
    const index = arr.findIndex(x => x && x.id === id);
    if (index === -1) return;
    arr.splice(index, 1);
    state._ix?.get(collection)?.delete(id);
    recordTombstone(collection, id);
    count++;
  });
  if (count > 0) markDirty();
  return count;
}

export function purgeDeletedRecords() {
  let count = 0;
  Object.keys(state.db).forEach(collection => {
    if (!Array.isArray(state.db[collection])) return;
    const before = state.db[collection].length;
    for (const item of state.db[collection]) {
      if (item.deletedAt) recordTombstone(collection, item.id);
    }
    state.db[collection] = state.db[collection].filter(item => !item.deletedAt);
    count += before - state.db[collection].length;
    // Rebuild the id index so byId() can't return purged records.
    if (state._ix) state._ix.set(collection, new Map(state.db[collection].map(item => [item.id, item])));
  });
  if (count > 0) markDirty();
  return count;
}

// Collect every string value held by a record (depth-limited) into `set`.
// Any of these may be a foreign key pointing at another record's id, so a
// deleted record whose id appears here must not be purged (would orphan a ref).
function _collectStringValues(value, set, depth = 0) {
  if (value == null || depth > 5) return;
  const t = typeof value;
  if (t === 'string') { set.add(value); return; }
  if (t !== 'object') return;
  if (Array.isArray(value)) {
    for (const v of value) _collectStringValues(v, set, depth + 1);
    return;
  }
  for (const k in value) _collectStringValues(value[k], set, depth + 1);
}

/**
 * Permanently remove records that were soft-deleted longer than `maxAgeDays`
 * ago, EXCEPT any whose id is still referenced by an active (non-deleted)
 * record — keeping referential integrity intact. Runs at load after the
 * authoritative data is in place. Returns the number of records purged.
 */
export function autoPurgeOldDeleted({ maxAgeDays = 90 } = {}) {
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;

  // 1) Build the set of ids referenced by any active record.
  const referenced = new Set();
  for (const col of Object.keys(state.db)) {
    const arr = state.db[col];
    if (!Array.isArray(arr)) continue;
    for (const rec of arr) {
      if (rec && rec.deletedAt) continue; // only active records can hold live refs
      _collectStringValues(rec, referenced);
    }
  }

  // 2) Purge old soft-deleted records that nothing active points at.
  let count = 0;
  for (const col of Object.keys(state.db)) {
    const arr = state.db[col];
    if (!Array.isArray(arr)) continue;
    let changed = false;
    const kept = [];
    for (const rec of arr) {
      const purgeable = rec && rec.deletedAt && rec.deletedAt < cutoff && !referenced.has(rec.id);
      if (purgeable) { changed = true; count++; recordTombstone(col, rec.id); continue; }
      kept.push(rec);
    }
    if (changed) {
      state.db[col] = kept;
      if (state._ix) state._ix.set(col, new Map(kept.map(r => [r.id, r])));
    }
  }
  pruneTombstones();
  if (count > 0) markDirty();
  return count;
}

// ============== Inventory FIFO helpers ==============

export function totalRemaining(item) {
  if (!item) return 0;
  if (item.batches) return item.batches.reduce((s, b) => s + (b.remaining ?? b.qty ?? 0), 0);
  return item.stock || 0; // legacy flat format
}

/**
 * Compute FIFO deduction from oldest batches first (does NOT mutate item).
 * Returns { updatedBatches, consumed: [{batchId, qty, unitPrice, currency}], totalCost, deficit }.
 * deficit > 0 means available stock was less than requested qty.
 */
/**
 * dateForFx (optional): date/year used to convert each consumed batch's cost
 * to EUR. Batches can carry different currencies, so `totalCost` (raw sum,
 * kept for callers that already know all batches share one currency) is
 * unsafe to use whenever `mixedCurrency` is true — use `totalCostEUR` instead.
 */
export function fifoDeduct(item, qty, dateForFx = null) {
  if (!item?.batches?.length) return { updatedBatches: item?.batches || [], consumed: [], totalCost: 0, totalCostEUR: 0, mixedCurrency: false, deficit: qty };
  const sorted = [...item.batches].sort((a, b) => (a.dateBought || '').localeCompare(b.dateBought || ''));
  let need = qty;
  const consumed = [];
  let totalCost = 0;
  let totalCostEUR = 0;
  const patchMap = new Map();

  for (const b of sorted) {
    if (need <= 0) break;
    const avail = b.remaining ?? b.qty ?? 0;
    const take  = Math.min(avail, need);
    if (take <= 0) continue;
    const currency = b.currency || 'EUR';
    const lineCost = take * (b.unitPrice || 0);
    consumed.push({ batchId: b.id, qty: take, unitPrice: b.unitPrice || 0, currency });
    totalCost += lineCost;
    totalCostEUR += toEUR(lineCost, currency, dateForFx);
    patchMap.set(b.id, avail - take);
    need -= take;
  }

  const updatedBatches = item.batches.map(b =>
    patchMap.has(b.id) ? { ...b, remaining: patchMap.get(b.id) } : b
  );
  const mixedCurrency = new Set(consumed.map(c => c.currency)).size > 1;
  return { updatedBatches, consumed, totalCost, totalCostEUR, mixedCurrency, deficit: need };
}

// ============== Reservation Expense Rules ==============

export function restoreInventoryStock(expense) {
  if (!expense.inventoryItemId || !expense.inventoryQty) return;
  const item = byId('inventory', expense.inventoryItemId);
  if (!item) return;
  if (expense.inventoryBatches && item.batches) {
    const restoreMap = new Map(expense.inventoryBatches.map(c => [c.batchId, c.qty]));
    const updatedBatches = item.batches.map(b =>
      restoreMap.has(b.id) ? { ...b, remaining: (b.remaining ?? b.qty ?? 0) + restoreMap.get(b.id) } : b
    );
    upsert('inventory', { ...item, batches: updatedBatches });
  } else if (item.batches) {
    // Legacy expense (predates per-batch consumption tracking, so it has no
    // inventoryBatches of its own) on an item that has since migrated to
    // batches — totalRemaining() ignores item.stock entirely once an item
    // has batches, so crediting back into stock here silently lost the
    // restored quantity forever. Add it as a new batch instead so it's
    // actually counted; unitPrice 0 since the original per-unit cost isn't
    // recoverable here — this only restores the QUANTITY, not cost history.
    const restoredBatch = {
      id: newId('batch'), dateBought: expense.date || today(),
      qty: expense.inventoryQty, remaining: expense.inventoryQty, unitPrice: 0, currency: 'EUR',
      note: 'Restored from deleted expense (pre-batch-tracking record)'
    };
    upsert('inventory', { ...item, batches: [...item.batches, restoredBatch] });
  } else {
    upsert('inventory', { ...item, stock: (item.stock || 0) + expense.inventoryQty });
  }
}

// Match vendor cleaningPeriods by property + date. vendorId='' means any vendor.
export function findVendorRateByPeriod(propertyId, date, vendorId = '') {
  const out = [];
  for (const v of listActive('vendors')) {
    if (vendorId && v.id !== vendorId) continue;
    for (const period of (v.cleaningPeriods || [])) {
      if (period.propertyId === propertyId &&
          period.startDate && period.startDate <= date &&
          (!period.endDate || period.endDate >= date)) {
        out.push({ vendor: v, period });
      }
    }
  }
  return out;
}

// Build a lookup of generated expenses keyed by `ruleId|reservationRef`, used to
// find an already-generated expense in O(1). Pass this into
// applyReservationExpenseRules during bulk imports to avoid a full expense scan
// per rule per row (otherwise O(rows × rules × expenses)).
export function buildGeneratedExpenseIndex() {
  const m = new Map();
  for (const e of (state.db.expenses || [])) {
    if (e.isGenerated && !e.deletedAt && e.reservationRuleId && e.reservationRef) {
      m.set(e.reservationRuleId + '|' + e.reservationRef, e);
    }
  }
  return m;
}

// Build a lookup of generated expenses keyed by `reservationRef|category`,
// used by applyReservationExpenseRules to detect a same-category cross-rule
// conflict in O(1). Pass this into applyReservationExpenseRules during bulk
// imports/reapplies to avoid a full expense scan per rule per row (otherwise
// O(rows × rules × expenses)) — mirrors buildGeneratedExpenseIndex above.
export function buildGeneratedExpenseCategoryIndex() {
  const m = new Map();
  for (const e of (state.db.expenses || [])) {
    if (e.isGenerated && !e.deletedAt && e.reservationRuleId && e.reservationRef) {
      m.set(e.reservationRef + '|' + e.category, e.reservationRuleId);
    }
  }
  return m;
}

// Shared claim-tracking for the "one auto-generated expense per category per
// reservation" guard: `categoryIndex`, when supplied by a bulk caller, is a
// map shared across the whole run (built once via
// buildGeneratedExpenseCategoryIndex) — O(1) per rule instead of rescanning
// every expense per payment. Falls back to a fresh scan of just this
// reservation's own expenses when called standalone (e.g. a single manual
// payment save or a single "Run" click).
function _makeClaimTracker(reservationRef, categoryIndex) {
  const keyOf = category => reservationRef + '|' + category;
  const localClaims = categoryIndex ? null : new Map();
  if (localClaims) {
    for (const e of (state.db.expenses || [])) {
      if (e.isGenerated && !e.deletedAt && e.reservationRef === reservationRef && e.reservationRuleId) {
        localClaims.set(e.category, e.reservationRuleId);
      }
    }
  }
  return {
    getOwner: category => categoryIndex ? categoryIndex.get(keyOf(category)) : localClaims.get(category),
    setOwner: (category, ruleId) => categoryIndex ? categoryIndex.set(keyOf(category), ruleId) : localClaims.set(category, ruleId)
  };
}

// Applies a single rule to a single payment, guarded by the same "don't
// duplicate a category another rule already owns" check used everywhere
// else. Returns a conflict descriptor (or null) instead of applying when
// another rule already claimed this reservation's category.
function _applyRuleGuarded(rule, payment, reservationRef, genIndex, tracker) {
  const category = rule.category || 'cleaning';
  const owner = tracker.getOwner(category);
  if (owner && owner !== rule.id) {
    const ownerRule = byId('reservationExpenseRules', owner);
    return { category, reservationRef, ruleId: rule.id, ruleName: rule.name, ownerRuleId: owner, ownerRuleName: ownerRule?.name || owner };
  }
  _applyOneRule(rule, payment, reservationRef, genIndex);
  tracker.setOwner(category, rule.id);
  return null;
}

// Applies every enabled rule matching this payment's property, returning any
// same-category conflicts that were skipped so callers can warn the user
// instead of silently duplicating an expense. Two enabled rules mapping to
// the same category (e.g. an old "Airbnb cleaning fee" rule left on
// alongside a new "Vendor rate" rule, both categorized "cleaning") only let
// the first one through; different categories (e.g. cleaning + maintenance)
// are unaffected — each owns its own category independently.
export function applyReservationExpenseRules(payment, genIndex = null, categoryIndex = null, { allowInventory = true } = {}) {
  const reservationRef = payment.confirmationCode || payment.id;
  if (!reservationRef || !payment.propertyId) return [];
  // Airbnb adjustment/resolution rows share the reservation's confirmation
  // code — they must not (re)generate its expenses, or they overwrite the
  // reservation's generated expense with their own (usually zero) fees.
  if (!isReservationNight(payment)) return [];
  const rules = listActive('reservationExpenseRules').filter(r =>
    r.enabled && (!r.propertyId || r.propertyId === payment.propertyId) &&
    (allowInventory || r.amountSource !== 'inventory')
  );
  const tracker = _makeClaimTracker(reservationRef, categoryIndex);
  const conflicts = [];
  for (const rule of rules) {
    const conflict = _applyRuleGuarded(rule, payment, reservationRef, genIndex, tracker);
    if (conflict) conflicts.push(conflict);
  }
  return conflicts;
}

// Applies ONLY the given rule to a single payment — unlike
// applyReservationExpenseRules, this never touches any OTHER rule even if
// other enabled rules also match the payment's property. Used by the
// explicit per-rule "Run" action and reapplyRuleToAllPayments, so clicking
// "Run" on one rule can't silently re-trigger a different one.
export function applyRuleToPayment(rule, payment, genIndex = null, categoryIndex = null) {
  const reservationRef = payment.confirmationCode || payment.id;
  if (!reservationRef || !payment.propertyId) return [];
  if (!isReservationNight(payment)) return []; // see applyReservationExpenseRules
  const tracker = _makeClaimTracker(reservationRef, categoryIndex);
  const conflict = _applyRuleGuarded(rule, payment, reservationRef, genIndex, tracker);
  return conflict ? [conflict] : [];
}

// Formats a de-duplicated, human-readable warning for conflicts returned by
// applyReservationExpenseRules / reapplyRuleToAllPayments, or null if none.
export function formatRuleConflictWarning(conflicts) {
  if (!conflicts || conflicts.length === 0) return null;
  const seen = new Set();
  const lines = [];
  for (const c of conflicts) {
    const key = [c.category, c.ruleId, c.ownerRuleId].sort().join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(`"${c.ruleName}" (${c.category}) — already generated by "${c.ownerRuleName}"`);
  }
  return `${conflicts.length} duplicate expense${conflicts.length === 1 ? '' : 's'} skipped: ${lines.join('; ')}. Disable or recategorize one of the conflicting rules.`;
}

function _applyOneRule(rule, payment, reservationRef, genIndex = null) {
  const existing = genIndex
    ? (genIndex.get(rule.id + '|' + reservationRef) || null)
    : (state.db.expenses || []).find(e =>
        e.isGenerated && e.reservationRuleId === rule.id && e.reservationRef === reservationRef && !e.deletedAt
      );
  if (existing?.manualOverride) return;

  let amount = 0, currency = rule.fixedCurrency || payment.currency || 'EUR';
  let inventoryItemId, inventoryQty, inventoryBatches;
  let overrideVendorId, overrideVendorName;
  let reviewNeeded, reviewReason;

  if (rule.amountSource === 'fixed') {
    amount = rule.fixedAmount || 0;
    currency = rule.fixedCurrency || payment.currency || 'EUR';
  } else if (rule.amountSource === 'airbnb_cleaning_fee') {
    amount = payment.airbnbCleaningFee || 0;
    currency = payment.currency || 'EUR';
  } else if (rule.amountSource === 'inventory' && rule.inventoryItemId) {
    if (existing) {
      // Don't re-deduct; only refresh metadata fields to stay in sync. Skip the
      // write entirely when nothing would actually change — upsert() always
      // stamps a fresh updatedAt, and re-running an import over reservations it
      // already generated expenses for otherwise bumps every one of them on
      // every run, manufacturing a "this was edited" signal (feeding spurious
      // 3-way sync conflicts) out of a genuine no-op.
      const refreshedDate        = payment.checkIn || payment.airbnbCheckIn || payment.date || existing.date;
      const refreshedVendorId    = rule.vendorId || existing.vendorId || '';
      const refreshedDescription = rule.description || existing.description || '';
      if (
        refreshedDate        !== existing.date ||
        refreshedVendorId    !== existing.vendorId ||
        refreshedDescription !== existing.description
      ) {
        const refreshed = upsert('expenses', {
          ...existing,
          date: refreshedDate,
          vendorId: refreshedVendorId,
          description: refreshedDescription
        });
        if (genIndex) genIndex.set(rule.id + '|' + reservationRef, refreshed);
      }
      return;
    }
    const item = byId('inventory', rule.inventoryItemId);
    if (!item) return;
    const qty = rule.inventoryQty || 1;
    const invDate = payment.checkIn || payment.airbnbCheckIn || payment.date || '';
    const { updatedBatches, consumed, totalCostEUR, deficit } = fifoDeduct(item, qty, invDate);
    upsert('inventory', { ...item, batches: updatedBatches });
    // Always normalized to EUR — consumed batches can span multiple
    // currencies, and there's no human review on this auto-generated path.
    amount = totalCostEUR;
    currency = 'EUR';
    inventoryItemId = rule.inventoryItemId;
    inventoryQty = qty;
    inventoryBatches = consumed;
    if (deficit > 0) {
      reviewNeeded = true;
      reviewReason = `Insufficient stock — short by ${deficit} unit${deficit === 1 ? '' : 's'}; cost may be understated`;
    }
  } else if (rule.amountSource === 'vendor_rate') {
    const refDate = payment.checkIn || payment.airbnbCheckIn || payment.date || '';
    const matches = refDate ? findVendorRateByPeriod(payment.propertyId, refDate, rule.vendorId || '') : [];
    if (matches.length === 0) {
      reviewNeeded = true;
      reviewReason = 'No vendor rate found for this property and date';
    } else if (matches.length > 1 && !rule.vendorId) {
      reviewNeeded = true;
      reviewReason = 'Multiple vendor rates match — set a specific vendor on the rule';
    } else {
      const { vendor, period } = matches[0];
      amount = period.fee;
      // The fee is in its own currency (the rate's, else the property's —
      // which is what vendors.js has always displayed it in), not the
      // payout's: a HUF 15,000 fee on a EUR payout isn't €15,000.
      currency = period.currency || byId('properties', payment.propertyId)?.currency || payment.currency || 'EUR';
      overrideVendorId = vendor.id;
      overrideVendorName = vendor.name;
    }
  }

  const candidate = {
    id: existing?.id || newId('exp'),
    propertyId: payment.propertyId,
    category: rule.category || 'cleaning',
    amount,
    currency,
    date: payment.checkIn || payment.airbnbCheckIn || payment.date || '',
    vendorId: overrideVendorId ?? (rule.vendorId || ''),
    vendor: overrideVendorName ?? '',
    description: rule.description || '',
    stream: payment.stream || 'short_term_rental',
    reservationRuleId: rule.id,
    reservationRef,
    isGenerated: true,
    manualOverride: existing?.manualOverride || false,
    ...(inventoryItemId ? { inventoryItemId, inventoryQty, inventoryBatches } : {}),
    ...(reviewNeeded ? { reviewNeeded, reviewReason } : {})
  };

  // Skip the write when re-running over a reservation produces an identical
  // result to what's already stored — upsert() always stamps a fresh
  // updatedAt, and bumping unchanged records on every re-import manufactures
  // a spurious "this was edited" signal that feeds false 3-way sync conflicts.
  if (existing && _sameExpenseFields(existing, candidate)) return;

  upsert('expenses', candidate);
  // Keep the caller's bulk index current — without this, two payments sharing
  // a reservationRef in one bulk run (runAllReservationExpenseRules /
  // reapplyRuleToAllPayments) both missed the index and each generated its
  // own expense (and, for inventory rules, deducted stock twice).
  if (genIndex) genIndex.set(rule.id + '|' + reservationRef, candidate);
}

function _sameExpenseFields(existing, candidate) {
  const keys = [
    'propertyId', 'category', 'amount', 'currency', 'date', 'vendorId', 'vendor',
    'description', 'stream', 'reservationRuleId', 'reservationRef', 'isGenerated',
    'manualOverride', 'inventoryItemId', 'inventoryQty', 'reviewNeeded', 'reviewReason'
  ];
  return keys.every(k => (existing[k] ?? null) === (candidate[k] ?? null))
    && JSON.stringify(existing.inventoryBatches ?? null) === JSON.stringify(candidate.inventoryBatches ?? null);
}

// ============== People / Owner helpers ==============

export function getPeopleOwners({ includeBoth = false } = {}) {
  const people = (state.db.people || []).filter(p =>
    !p.deletedAt && p.active !== false && ['partner', 'director'].includes(p.role)
  );
  if (people.length === 0) {
    // Fallback to hardcoded OWNERS when no people are configured
    const opts = [{ value: 'you', label: 'Giorgos' }, { value: 'rita', label: 'Rita' }];
    if (includeBoth) opts.push({ value: 'both', label: 'Both' });
    return opts;
  }
  const opts = people.map(p => ({ value: p.legacyKey || p.id, label: p.name }));
  if (includeBoth && opts.length > 1) opts.push({ value: 'both', label: 'Both' });
  return opts;
}

export function getPersonName(ownerKey) {
  if (!ownerKey) return '—';
  const people = state.db.people || [];
  const person = people.find(p => (p.legacyKey || p.id) === ownerKey && !p.deletedAt);
  if (person) return person.name;
  // Fallback: check OWNERS constant
  const OWNERS_FALLBACK = { you: 'Giorgos', rita: 'Rita', both: 'Both' };
  return OWNERS_FALLBACK[ownerKey] || ownerKey;
}

// Build a lookup of generated expenses grouped by reservationRef, so delete/
// import loops can find a payment's generated expenses in O(1) instead of
// scanning all expenses per payment (otherwise O(payments × expenses)).
export function buildReservationExpenseRefMap() {
  const m = new Map();
  for (const e of (state.db.expenses || [])) {
    if (e.isGenerated && !e.deletedAt && e.reservationRef) {
      let list = m.get(e.reservationRef);
      if (!list) { list = []; m.set(e.reservationRef, list); }
      list.push(e);
    }
  }
  return m;
}

export function removeReservationExpenses(payment, refMap = null) {
  const reservationRef = payment.confirmationCode || payment.id;
  if (!reservationRef) return;
  const matches = refMap
    ? (refMap.get(reservationRef) || [])
    : (state.db.expenses || []).filter(e => e.isGenerated && e.reservationRef === reservationRef && !e.deletedAt);
  for (const e of matches) {
    if (e.deletedAt) continue;
    restoreInventoryStock(e);
    softDelete('expenses', e.id);
  }
}

export function deletePayment(id) {
  const p = byId('payments', id);
  if (p) removeReservationExpenses(p);
  return softDelete('payments', id);
}

// Apply ONLY the given rule to all its matching short-term payments — fills
// in any missing generated expense for a matching reservation without
// duplicating ones that already exist (existing-expense dedup lives in
// _applyOneRule; cross-rule same-category dedup lives in
// applyRuleToPayment/applyReservationExpenseRules above). Never touches any
// OTHER rule, even one matching the same property.
//
// Inventory-sourced rules are skipped by default (retroactively deducting
// stock for every historical reservation is a real, irreversible side effect
// that shouldn't happen implicitly just from saving a rule) — pass
// `allowInventory: true` for an explicit, user-initiated "run this rule now"
// action where that's the whole point.
export function reapplyRuleToAllPayments(rule, { allowInventory = false } = {}) {
  if (!rule.enabled) return { processed: 0, created: 0, conflicts: [] };
  if (rule.amountSource === 'inventory' && !allowInventory) return { processed: 0, created: 0, conflicts: [] };
  const payments = listActive('payments').filter(p =>
    p.stream === 'short_term_rental' &&
    (!rule.propertyId || rule.propertyId === p.propertyId) &&
    (p.confirmationCode || p.id)
  );
  // Index generated expenses once and batch the mutations — avoids an
  // O(payments × expenses) scan and a per-payment save/refresh cycle.
  const genIndex = buildGeneratedExpenseIndex();
  const categoryIndex = buildGeneratedExpenseCategoryIndex();
  const before = (state.db.expenses || []).filter(e => e.isGenerated && !e.deletedAt && e.reservationRuleId === rule.id).length;
  const conflicts = [];
  runBatch(() => {
    for (const pay of payments) conflicts.push(...applyRuleToPayment(rule, pay, genIndex, categoryIndex));
  });
  const after = (state.db.expenses || []).filter(e => e.isGenerated && !e.deletedAt && e.reservationRuleId === rule.id).length;
  return { processed: payments.length, created: Math.max(0, after - before), conflicts };
}

// Apply every enabled rule to every matching short-term payment in one pass
// — the "Run All Rules" bulk action. Reuses applyReservationExpenseRules's
// per-payment "every matching rule, cross-rule same-category guard" logic,
// so the result is exactly what re-importing every reservation from scratch
// would produce, just without touching payments themselves.
//
// Inventory-sourced rules are skipped by default, same rationale as
// reapplyRuleToAllPayments — pass `allowInventory: true` for an explicit,
// user-initiated run.
export function runAllReservationExpenseRules({ allowInventory = false } = {}) {
  const rules = listActive('reservationExpenseRules').filter(r => r.enabled);
  if (rules.length === 0) return { rulesRun: 0, processed: 0, created: 0, conflicts: [] };
  const payments = listActive('payments').filter(p =>
    p.stream === 'short_term_rental' && (p.confirmationCode || p.id)
  );
  const genIndex = buildGeneratedExpenseIndex();
  const categoryIndex = buildGeneratedExpenseCategoryIndex();
  const before = (state.db.expenses || []).filter(e => e.isGenerated && !e.deletedAt).length;
  const conflicts = [];
  runBatch(() => {
    for (const pay of payments) conflicts.push(...applyReservationExpenseRules(pay, genIndex, categoryIndex, { allowInventory }));
  });
  const after = (state.db.expenses || []).filter(e => e.isGenerated && !e.deletedAt).length;
  return { rulesRun: rules.length, processed: payments.length, created: Math.max(0, after - before), conflicts };
}
