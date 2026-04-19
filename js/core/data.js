// Data layer: CRUD + aggregations + currency conversion
import { state, markDirty } from './state.js';
import { MASTER_CURRENCY } from './config.js';

// ============== Currency ==============
export function toEUR(amount, currency) {
  if (!amount) return 0;
  if (currency === 'EUR' || !currency) return Number(amount);
  if (currency === 'HUF') {
    const rate = state.db.settings?.fxRates?.HUF_EUR || 0.0025;
    return Number(amount) * rate;
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
  const arr = state.db[collection] || (state.db[collection] = []);
  const idx = arr.findIndex(x => x.id === item.id);
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

// ============== Aggregations ==============
export function totalRevenueEUR(filters) {
  const payments = applyFilters(state.db.payments || [], filters).filter(p => p.status === 'paid');
  const invoices = applyFilters(state.db.invoices || [], filters).filter(i => i.status === 'paid');

  let total = 0;
  for (const p of payments) total += toEUR(p.amount, p.currency);
  for (const i of invoices) total += toEUR(i.total, i.currency);
  return total;
}

export function totalExpensesEUR(filters, { includeRenovation = true } = {}) {
  let rows = applyFilters(state.db.expenses || [], filters);
  if (!includeRenovation) rows = rows.filter(e => e.category !== 'renovation');
  let total = 0;
  for (const e of rows) total += toEUR(e.amount, e.currency);
  return total;
}

export function renovationCapexEUR(filters) {
  const rows = applyFilters(state.db.expenses || [], filters).filter(e => e.category === 'renovation');
  let total = 0;
  for (const e of rows) total += toEUR(e.amount, e.currency);
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
  const rows = (state.db.payments || []).filter(p => inDateRange(p.date, start, end) && p.status === 'paid');
  const invs = (state.db.invoices || []).filter(i => inDateRange(i.issueDate, start, end) && i.status === 'paid');
  const fRows = applyFilters(rows, filters);
  const fInvs = applyFilters(invs.map(i => ({ ...i, date: i.issueDate })), filters);
  let total = 0;
  for (const p of fRows) total += toEUR(p.amount, p.currency);
  for (const i of fInvs) total += toEUR(i.total, i.currency);
  return total;
}

export function expensesInRangeEUR(start, end, filters = {}, { includeRenovation = true } = {}) {
  let rows = (state.db.expenses || []).filter(e => inDateRange(e.date, start, end));
  if (!includeRenovation) rows = rows.filter(e => e.category !== 'renovation');
  rows = applyFilters(rows, filters);
  let total = 0;
  for (const e of rows) total += toEUR(e.amount, e.currency);
  return total;
}

export function propertyRevenueEUR(propertyId, filters) {
  const rows = (state.db.payments || []).filter(p => p.propertyId === propertyId && p.status === 'paid');
  const filtered = applyFilters(rows, filters);
  return filtered.reduce((s, p) => s + toEUR(p.amount, p.currency), 0);
}

export function propertyExpensesEUR(propertyId, filters, { includeRenovation = true } = {}) {
  let rows = (state.db.expenses || []).filter(e => e.propertyId === propertyId);
  if (!includeRenovation) rows = rows.filter(e => e.category !== 'renovation');
  const filtered = applyFilters(rows, filters);
  return filtered.reduce((s, e) => s + toEUR(e.amount, e.currency), 0);
}

export function propertyROI(propertyId) {
  const prop = byId('properties', propertyId);
  if (!prop) return 0;
  const purchaseEUR = toEUR(prop.purchasePrice, prop.currency);
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
    map.set(key, (map.get(key) || 0) + toEUR(r[amountField], r[currencyField]));
  }
  return map;
}

export function groupByStream(rows, amountField = 'amount', currencyField = 'currency') {
  const map = new Map();
  for (const r of rows) {
    const k = r.stream || 'other';
    map.set(k, (map.get(k) || 0) + toEUR(r[amountField], r[currencyField]));
  }
  return map;
}

export function groupByCategory(rows) {
  const map = new Map();
  for (const r of rows) {
    const k = r.category || 'other';
    map.set(k, (map.get(k) || 0) + toEUR(r.amount, r.currency));
  }
  return map;
}

export function recentActivity(limit = 8) {
  const items = [];
  for (const p of state.db.payments || []) items.push({ kind: 'payment', date: p.date, data: p });
  for (const e of state.db.expenses || []) items.push({ kind: 'expense', date: e.date, data: e });
  for (const i of state.db.invoices || []) items.push({ kind: 'invoice', date: i.issueDate, data: i });
  items.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  return items.slice(0, limit);
}

export function availableYears() {
  const years = new Set();
  for (const p of state.db.payments || []) if (p.date) years.add(p.date.slice(0, 4));
  for (const e of state.db.expenses || []) if (e.date) years.add(e.date.slice(0, 4));
  for (const i of state.db.invoices || []) if (i.issueDate) years.add(i.issueDate.slice(0, 4));
  return [...years].sort().reverse();
}
