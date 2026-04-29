// Data layer: CRUD + aggregations + currency conversion
import { state, markDirty } from './state.js';
import { MASTER_CURRENCY } from './config.js';

// ============== Currency ==============
export function toEUR(amount, currency, dateOrYear) {
  if (!amount) return 0;
  if (currency === 'EUR' || !currency) return Number(amount);
  if (currency === 'HUF') {
    const yearRates = state.db.settings?.fxRates?.yearRates || {};
    const raw = String(dateOrYear || '');
    const y = raw.slice(0, 4);
    let rate;
    if (y && yearRates[y] !== undefined) {
      rate = yearRates[y];
    } else {
      const keys = Object.keys(yearRates).sort();
      rate = keys.length ? yearRates[keys[keys.length - 1]] : undefined;
    }
    if (rate !== undefined) return Number(amount) * rate;
  }
  return Number(amount);
}

export function formatMoney(amount, currency = 'EUR', options = {}) {
  const opts = {
    style: 'currency',
    currency,
    maximumFractionDigits: options.maxFrac ?? (currency === 'HUF' ? 0 : 2),
    minimumFractionDigits: options.minFrac ?? 0
  };
  try {
    return new Intl.NumberFormat('en-US', opts).format(amount || 0);
  } catch (e) {
    return `${amount} ${currency}`;
  }
}

export function formatEUR(amount, options = {}) {
  return formatMoney(amount, 'EUR', options);
}

export function formatNumber(n, frac = 0) {
  return new Intl.NumberFormat('en-US', { minimumFractionDigits: frac, maximumFractionDigits: frac }).format(n || 0);
}

// ============== IDs ==============
export function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.floor(Math.random() * 1000).toString(36)}`;
}

// ============== Generic CRUD ==============
export function upsert(collection, item) {
  const now = Date.now();
  const actor = state.session?.username || 'system';
  const arr = state.db[collection] || (state.db[collection] = []);
  const idx = arr.findIndex(x => x.id === item.id);
  if (idx < 0) {
    item.createdAt = now;
    item.createdBy = actor;
  }
  item.updatedAt = now;
  item.updatedBy = actor;
  if (idx >= 0) arr[idx] = item; else arr.push(item);
  markDirty();
  return item;
}

export function remove(collection, id) {
  const arr = state.db[collection] || [];
  const idx = arr.findIndex(x => x.id === id);
  if (idx >= 0) {
    arr.splice(idx, 1);
    markDirty();
    return true;
  }
  return false;
}

export function softDelete(collection, id) {
  const arr = state.db[collection] || [];
  const item = arr.find(x => x.id === id);
  if (!item) return false;
  const now = Date.now();
  const actor = state.session?.username || 'system';
  item.deletedAt = now;
  item.deletedBy = actor;
  item.updatedAt = now;
  item.updatedBy = actor;
  markDirty();
  return true;
}

export function listActive(collection) {
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

export function patchSettings(patch) {
  if (!state.db.settings) state.db.settings = {};
  Object.assign(state.db.settings, patch);
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
  return (state.db[collection] || []).find(x => x.id === id);
}

// ============== Filtering ==============
export function applyFilters(rows, { year, stream, owner, propertyId, clientId } = {}) {
  const f = state.ui.filters;
  const y = year ?? f.year;
  const s = stream ?? f.stream;
  const o = owner ?? f.owner;

  return rows.filter(r => {
    if (y && y !== 'all' && r.date) {
      if (!r.date.startsWith(String(y))) return false;
    }
    if (s && s !== 'all' && r.stream && r.stream !== s) return false;
    if (o && o !== 'all' && r.owner && r.owner !== o && r.owner !== 'both' && o !== 'both') {
      // property/invoice owner filter
      return false;
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
  mortgage:   'financing',           maintenance: 'maintenance',
  renovation: 'renovation',          insurance:   'insurance',
  tax:        'tax',                 utilities:   'utilities',
  management: 'property_management', cleaning:    'cleaning',
  electricity:'utilities',           water:       'utilities',
  inventory:  'other',               vat:         'tax',
  other:      'other'
};

// Derives accountingType / costCategory / recurrence for any expense record
// without mutating stored data — safe, non-destructive migration layer.
export function resolveExpenseFields(e) {
  return {
    accountingType: e.accountingType || (e.category === 'renovation' ? 'capex' : 'opex'),
    costCategory:   e.costCategory   || LEGACY_CAT_MAP[e.category] || 'other',
    recurrence:     e.recurrence     || (e.recurringGroupId ? 'recurring' : e.category === 'renovation' ? 'one_off' : 'recurring')
  };
}

// ============== Aggregations ==============
export function totalRevenueEUR(filters) {
  const payments = applyFilters(listActivePayments(), filters).filter(p => p.status === 'paid');
  const invoices = applyFilters(listActive('invoices'), filters).filter(i => i.status === 'paid');

  let total = 0;
  for (const p of payments) total += toEUR(p.amount, p.currency, p.date);
  for (const i of invoices) total += toEUR(i.total, i.currency, i.issueDate);
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

export function netIncomeEUR(filters) {
  return totalRevenueEUR(filters) - totalExpensesEUR(filters, { includeRenovation: false });
}

export function ytdRange() {
  const now = new Date();
  return { start: `${now.getFullYear()}-01-01`, end: now.toISOString().slice(0, 10) };
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
  for (const i of fInvs) total += toEUR(i.total, i.currency, i.date);
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
  const renoEUR = renovationCapexEUR({ propertyId });
  const totalInvested = purchaseEUR + renoEUR;
  if (!totalInvested) return 0;
  const now = new Date().getFullYear();
  const rev = propertyRevenueEUR(propertyId, { year: now });
  const exp = propertyExpensesEUR(propertyId, { year: now }, { includeRenovation: false });
  const net = rev - exp;
  return (net / totalInvested) * 100;
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
  return [...years].sort().reverse();
}

// ============== Vendors ==============
export function getVendors() { return state.db.vendors || []; }
export function getVendorsByProperty(propertyId) {
  return (state.db.vendors || []).filter(v => !v.propertyIds?.length || v.propertyIds.includes(propertyId));
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
  const fc = { id: newId('fcs'), type, entityId, year: Number(year), taxRate: 0, yearTarget: { revenue: 0, expenses: 0 }, months: {} };
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

export function upsertForecastEntry(forecastId, month, entry) {
  const fc = (state.db.forecasts || []).find(f => f.id === forecastId);
  if (!fc) return null;
  if (!fc.months[month]) fc.months[month] = {};
  const m = fc.months[month];
  if (!Array.isArray(m.entries)) m.entries = [];
  if (!entry.id) entry.id = newId('fce');
  const idx = m.entries.findIndex(e => e.id === entry.id);
  if (idx >= 0) m.entries[idx] = entry; else m.entries.push(entry);
  m.revenue = m.entries.reduce((s, e) => s + (Number(e.amount) || 0), 0);
  upsert('forecasts', fc);
  return entry;
}

export function removeForecastEntry(forecastId, month, entryId) {
  const fc = (state.db.forecasts || []).find(f => f.id === forecastId);
  const m = fc?.months?.[month];
  if (!m?.entries) return;
  m.entries = m.entries.filter(e => e.id !== entryId);
  m.revenue = m.entries.reduce((s, e) => s + (Number(e.amount) || 0), 0);
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

export function getForecastVsActual(type, entityId, year) {
  const fc = (state.db.forecasts || []).find(f => f.type === type && f.entityId === entityId && f.year === Number(year));
  const months = [];
  for (let m = 1; m <= 12; m++) {
    const key = `${year}-${String(m).padStart(2, '0')}`;
    const start = `${key}-01`;
    const end = `${key}-${new Date(year, m, 0).getDate().toString().padStart(2, '0')}`;
    let actualRev = 0, actualExp = 0;
    if (type === 'property') {
      actualRev = listActivePayments().filter(p => p.propertyId === entityId && p.status === 'paid' && p.date >= start && p.date <= end).reduce((s, p) => s + toEUR(p.amount, p.currency, year), 0);
      actualExp = listActive('expenses').filter(e => e.propertyId === entityId && !isCapEx(e) && e.date >= start && e.date <= end).reduce((s, e) => s + toEUR(e.amount, e.currency, year), 0);
    } else {
      actualRev = listActive('invoices').filter(i => i.stream === entityId && i.status === 'paid' && i.issueDate >= start && i.issueDate <= end).reduce((s, i) => s + toEUR(i.total, i.currency, year), 0);
    }
    const fd = fc?.months?.[key] || {};
    months.push({ key, forecastRev: fd.revenue || 0, forecastExp: fd.expenses || 0, actualRev, actualExp, revVariance: actualRev - (fd.revenue || 0), expVariance: actualExp - (fd.expenses || 0) });
  }
  return { forecast: fc, months, yearTarget: fc?.yearTarget || { revenue: 0, expenses: 0 } };
}

export function estimateTaxForYear(year, rate) {
  const s = `${year}-01-01`, e = `${year}-12-31`;
  const rev = [...listActivePayments().filter(p => p.status === 'paid' && p.date >= s && p.date <= e).map(p => toEUR(p.amount, p.currency, year)), ...listActive('invoices').filter(i => i.status === 'paid' && i.issueDate >= s && i.issueDate <= e).map(i => toEUR(i.total, i.currency, year))].reduce((a, b) => a + b, 0);
  const exp = listActive('expenses').filter(ex => !isCapEx(ex) && ex.date >= s && ex.date <= e).reduce((a, ex) => a + toEUR(ex.amount, ex.currency, year), 0);
  const taxable = Math.max(0, rev - exp);
  const forecastRev = (state.db.forecasts || []).filter(f => f.year === Number(year)).reduce((sum, f) => sum + Object.values(f.months || {}).reduce((ms, md) => ms + (md.revenue || 0), 0), 0);
  const forecastTaxable = Math.max(0, forecastRev - exp);
  const r = Number(rate) || 0;
  return { rev, exp, taxable, estimatedTax: taxable * (r / 100), forecastRev, forecastTaxable, forecastTax: forecastTaxable * (r / 100), rate: r };
}

// ============== LT Schedule ==============

// Internal helper: generate schedule entries for one lease segment.
// leaseData must have: monthlyRent, currency, leaseStartDate?, leaseEndDate?, paymentDayOfMonth?
function _scheduleSegment(propertyId, leaseData, tenantId, vacantPeriods, soldDate) {
  const now = new Date();
  const dueDay = Math.min(Math.max(leaseData.paymentDayOfMonth || 1, 1), 28);

  let rangeStart, rangeEnd;
  if (leaseData.leaseStartDate) {
    const d = new Date(leaseData.leaseStartDate);
    rangeStart = new Date(d.getFullYear(), d.getMonth(), 1);
  } else {
    rangeStart = new Date(now.getFullYear(), now.getMonth() - 11, 1);
  }
  if (leaseData.leaseEndDate) {
    const d = new Date(leaseData.leaseEndDate);
    rangeEnd = new Date(d.getFullYear(), d.getMonth() + 1, 1);
  } else {
    rangeEnd = new Date(now.getFullYear(), now.getMonth() + 13, 1);
  }

  const results = [];
  let cursor = new Date(rangeStart);
  while (cursor < rangeEnd) {
    const lastDay = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate();
    const day = Math.min(dueDay, lastDay);
    const dueDate = new Date(cursor.getFullYear(), cursor.getMonth(), day);
    const monthKey = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}`;
    const dateStr = `${monthKey}-${String(day).padStart(2, '0')}`;
    const paidPayment = listActivePayments().find(p =>
      p.propertyId === propertyId &&
      p.date?.slice(0, 7) === monthKey &&
      p.status === 'paid' &&
      (p.stream === 'long_term_rental' || p.type === 'rental')
    );
    const linkedPayment = paidPayment || listActivePayments().find(p =>
      p.propertyId === propertyId &&
      p.date?.slice(0, 7) === monthKey &&
      (p.stream === 'long_term_rental' || p.type === 'rental')
    );
    const paid = !!paidPayment;
    // Skip unpaid entries in a vacant period or on/after the sold date
    if (!paid) {
      const inVacant = (vacantPeriods || []).some(vp =>
        vp.startDate && dateStr >= vp.startDate && dateStr <= (vp.endDate || '9999-12-31')
      );
      const afterSold = soldDate ? dateStr > soldDate : false;
      if (inVacant || afterSold) {
        cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
        continue;
      }
    }
    const overdue = !paid && dueDate < now;
    results.push({
      date: dateStr, monthKey,
      amount: leaseData.monthlyRent, currency: leaseData.currency || 'EUR',
      amountEUR: toEUR(leaseData.monthlyRent, leaseData.currency || 'EUR', cursor.getFullYear()),
      paid, overdue,
      paidPaymentId: paidPayment?.id || null,
      linkedPaymentId: linkedPayment?.id || null,
      tenantId: tenantId || null
    });
    cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
  }
  return results;
}

export function generatePaymentSchedule(property) {
  if (property.type !== 'long_term') return [];

  const tenants = listActive('tenants')
    .filter(t => t.propertyId === property.id && t.monthlyRent)
    .sort((a, b) => (a.leaseStartDate || '').localeCompare(b.leaseStartDate || ''));

  if (!tenants.length) return [];

  const vacantPeriods = property.vacantPeriods || [];
  const soldDate = (property.status === 'sold' && property.soldDate) ? property.soldDate : null;

  // Merge segments from all tenants, deduplicate by monthKey (earlier lease wins)
  const all = [];
  for (const t of tenants) all.push(..._scheduleSegment(property.id, t, t.id, vacantPeriods, soldDate));
  all.sort((a, b) => a.date.localeCompare(b.date));
  const seen = new Set();
  return all.filter(e => { if (seen.has(e.monthKey)) return false; seen.add(e.monthKey); return true; });
}

// ============== Reconciliation ==============
export function buildReconciliationData(year) {
  const yr = Number(year);
  const now = new Date();
  const entities = [];

  for (const prop of listActive('properties')) {
    const months = [];
    for (let m = 1; m <= 12; m++) {
      const mk = `${yr}-${String(m).padStart(2, '0')}`;
      const start = `${mk}-01`;
      const end = `${mk}-${new Date(yr, m, 0).getDate().toString().padStart(2, '0')}`;
      const monthEnd = new Date(yr, m, 0);
      const isPast = monthEnd < now;
      let expected = 0, actual = 0;

      if (prop.type === 'long_term') {
        const propTenants = listActive('tenants').filter(t => t.propertyId === prop.id && t.monthlyRent);
        const mStr = `${mk}-01`;
        const tenant = propTenants.find(t => {
          const ls = t.leaseStartDate ? t.leaseStartDate.slice(0, 7) + '-01' : null;
          const le = t.leaseEndDate   ? t.leaseEndDate.slice(0, 7)   + '-01' : null;
          return (!ls || mStr >= ls) && (!le || mStr <= le);
        });
        if (tenant) expected = toEUR(tenant.monthlyRent, tenant.currency || 'EUR', yr);
        actual = listActivePayments()
          .filter(p => p.propertyId === prop.id && p.date >= start && p.date <= end && p.status === 'paid')
          .reduce((s, p) => s + toEUR(p.amount, p.currency, yr), 0);
      } else if (prop.type === 'short_term') {
        // Expected = all booked revenue (paid + pending); Actual = paid only
        const all = listActivePayments().filter(p =>
          p.propertyId === prop.id && p.date >= start && p.date <= end
        );
        expected = all.reduce((s, p) => s + toEUR(p.amount, p.currency, yr), 0);
        actual   = all.filter(p => p.status === 'paid').reduce((s, p) => s + toEUR(p.amount, p.currency, yr), 0);
      }

      months.push({ mk, m, expected, actual, variance: actual - expected, isPast });
    }
    const totExp = months.reduce((s, m) => s + m.expected, 0);
    const totAct = months.reduce((s, m) => s + m.actual, 0);
    entities.push({
      id: prop.id, label: prop.name,
      kind: prop.type === 'long_term' ? 'lt' : 'st',
      months, totExp, totAct, totVariance: totAct - totExp
    });
  }

  // Services: issued invoices = expected; paid = actual
  for (const { stream, label } of [
    { stream: 'customer_success',  label: 'Customer Success' },
    { stream: 'marketing_services', label: 'Marketing Services' }
  ]) {
    const months = [];
    for (let m = 1; m <= 12; m++) {
      const mk = `${yr}-${String(m).padStart(2, '0')}`;
      const start = `${mk}-01`;
      const end = `${mk}-${new Date(yr, m, 0).getDate().toString().padStart(2, '0')}`;
      const monthEnd = new Date(yr, m, 0);
      const isPast = monthEnd < now;
      const invs = listActive('invoices').filter(i =>
        i.stream === stream && i.issueDate >= start && i.issueDate <= end && i.status !== 'draft'
      );
      const expected = invs.reduce((s, i) => s + toEUR(i.total, i.currency, yr), 0);
      const actual   = invs.filter(i => i.status === 'paid').reduce((s, i) => s + toEUR(i.total, i.currency, yr), 0);
      months.push({ mk, m, expected, actual, variance: actual - expected, isPast });
    }
    const totExp = months.reduce((s, m) => s + m.expected, 0);
    const totAct = months.reduce((s, m) => s + m.actual, 0);
    entities.push({
      id: stream, label, kind: 'service',
      months, totExp, totAct, totVariance: totAct - totExp
    });
  }

  return entities;
}

// ============== Centralised report data (single source of truth) ==============
export function buildReportData(filters = {}) {
  const f = { ...state.ui.filters, ...filters };
  const matchDate = row => {
    if (!f.year || f.year === 'all') return true;
    const d = row.date || row.issueDate || '';
    return d.startsWith(String(f.year));
  };
  const matchStream = row => {
    if (f.streams instanceof Set) return f.streams.size === 0 || !row.stream || f.streams.has(row.stream);
    return !f.stream || f.stream === 'all' || !row.stream || row.stream === f.stream;
  };
  const matchProperty = row => !f.propertyId || f.propertyId === 'all' || row.propertyId === f.propertyId;

  const payments = listActivePayments().filter(p => p.status === 'paid' && matchDate(p) && matchStream(p) && matchProperty(p));
  const invoices = listActive('invoices').filter(i => i.status === 'paid' && matchDate({ date: i.issueDate }) && matchStream(i) && matchProperty(i));
  const opExpenses = listActive('expenses').filter(e => !isCapEx(e) && matchDate(e) && matchStream(e) && matchProperty(e));
  const renoExpenses = listActive('expenses').filter(e => isCapEx(e) && matchDate(e) && matchProperty(e));

  const rev = [...payments, ...invoices.map(i => ({ ...i, amount: i.total, date: i.date || i.issueDate }))].reduce((s, r) => s + toEUR(r.amount, r.currency, r.date), 0);
  const exp = opExpenses.reduce((s, r) => s + toEUR(r.amount, r.currency, r.date), 0);
  const reno = renoExpenses.reduce((s, r) => s + toEUR(r.amount, r.currency, r.date), 0);

  return { payments, invoices, opExpenses, renoExpenses, rev, exp, reno, net: rev - exp };
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
