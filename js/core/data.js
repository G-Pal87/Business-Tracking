// Data layer: CRUD + aggregations + currency conversion
import { state, markDirty } from './state.js';
import { MASTER_CURRENCY } from './config.js';

// ============== Currency ==============
export function toEUR(amount, currency) {
  if (!amount) return 0;
  if (currency === 'EUR' || !currency) return Number(amount);
  const rate = state.db.settings?.fxRates?.[`${currency}_EUR`];
  if (rate) return Number(amount) * rate;
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

// ============== Vendors ==============
export function getVendors() { return state.db.vendors || []; }
export function getVendorsByProperty(propertyId) {
  return (state.db.vendors || []).filter(v => !v.propertyIds?.length || v.propertyIds.includes(propertyId));
}

// ============== Forecasts ==============
export function getOrCreateForecast(type, entityId, year) {
  if (!state.db.forecasts) state.db.forecasts = [];
  const existing = state.db.forecasts.find(f => f.type === type && f.entityId === entityId && f.year === Number(year));
  if (existing) {
    if (!existing.yearTarget) { existing.yearTarget = { revenue: 0, expenses: 0 }; markDirty(); }
    return existing;
  }
  const fc = { id: newId('fcs'), type, entityId, year: Number(year), taxRate: 0, yearTarget: { revenue: 0, expenses: 0 }, months: {} };
  state.db.forecasts.push(fc);
  markDirty();
  return fc;
}

export function saveForecastMonth(forecastId, month, data) {
  const fc = (state.db.forecasts || []).find(f => f.id === forecastId);
  if (!fc) return;
  fc.months[month] = { ...(fc.months[month] || {}), ...data };
  markDirty();
}

export function setForecastTaxRate(forecastId, rate) {
  const fc = (state.db.forecasts || []).find(f => f.id === forecastId);
  if (!fc) return;
  fc.taxRate = Number(rate) || 0;
  markDirty();
}

export function saveForecastYear(forecastId, data) {
  const fc = (state.db.forecasts || []).find(f => f.id === forecastId);
  if (!fc) return;
  fc.yearTarget = { ...(fc.yearTarget || {}), ...data };
  markDirty();
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
      actualRev = (state.db.payments || []).filter(p => p.propertyId === entityId && p.status === 'paid' && p.date >= start && p.date <= end).reduce((s, p) => s + toEUR(p.amount, p.currency), 0);
      actualExp = (state.db.expenses || []).filter(e => e.propertyId === entityId && e.category !== 'renovation' && e.date >= start && e.date <= end).reduce((s, e) => s + toEUR(e.amount, e.currency), 0);
    } else {
      actualRev = (state.db.invoices || []).filter(i => i.stream === entityId && i.status === 'paid' && i.issueDate >= start && i.issueDate <= end).reduce((s, i) => s + toEUR(i.total, i.currency), 0);
    }
    const fd = fc?.months?.[key] || {};
    months.push({ key, forecastRev: fd.revenue || 0, forecastExp: fd.expenses || 0, actualRev, actualExp, revVariance: actualRev - (fd.revenue || 0), expVariance: actualExp - (fd.expenses || 0) });
  }
  return { forecast: fc, months, yearTarget: fc?.yearTarget || { revenue: 0, expenses: 0 } };
}

export function estimateTaxForYear(year, rate) {
  const s = `${year}-01-01`, e = `${year}-12-31`;
  const rev = [...(state.db.payments || []).filter(p => p.status === 'paid' && p.date >= s && p.date <= e).map(p => toEUR(p.amount, p.currency)), ...(state.db.invoices || []).filter(i => i.status === 'paid' && i.issueDate >= s && i.issueDate <= e).map(i => toEUR(i.total, i.currency))].reduce((a, b) => a + b, 0);
  const exp = (state.db.expenses || []).filter(ex => ex.category !== 'renovation' && ex.date >= s && ex.date <= e).reduce((a, ex) => a + toEUR(ex.amount, ex.currency), 0);
  const taxable = Math.max(0, rev - exp);
  const forecastRev = (state.db.forecasts || []).filter(f => f.year === Number(year)).reduce((sum, f) => sum + Object.values(f.months || {}).reduce((ms, md) => ms + (md.revenue || 0), 0), 0);
  const forecastTaxable = Math.max(0, forecastRev - exp);
  const r = Number(rate) || 0;
  return { rev, exp, taxable, estimatedTax: taxable * (r / 100), forecastRev, forecastTaxable, forecastTax: forecastTaxable * (r / 100), rate: r };
}

// ============== LT Schedule ==============
export function generatePaymentSchedule(property) {
  if (property.type !== 'long_term' || !property.monthlyRent) return [];
  const now = new Date();
  const dueDay = Math.min(Math.max(property.paymentDayOfMonth || 1, 1), 28);

  // Range: lease start (or 12 months back) → lease end (or 12 months ahead)
  let rangeStart, rangeEnd;
  if (property.leaseStartDate) {
    const d = new Date(property.leaseStartDate);
    rangeStart = new Date(d.getFullYear(), d.getMonth(), 1);
  } else {
    rangeStart = new Date(now.getFullYear(), now.getMonth() - 11, 1);
  }
  if (property.leaseEndDate) {
    const d = new Date(property.leaseEndDate);
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
    const paidPayment = (state.db.payments || []).find(p =>
      p.propertyId === property.id &&
      p.date?.slice(0, 7) === monthKey &&
      p.status === 'paid' &&
      (p.stream === 'long_term_rental' || p.type === 'rental')
    );
    const paid = !!paidPayment;
    const overdue = !paid && dueDate < now;
    results.push({
      date: dateStr, monthKey,
      amount: property.monthlyRent, currency: property.currency,
      amountEUR: toEUR(property.monthlyRent, property.currency),
      paid, overdue, paidPaymentId: paidPayment?.id || null
    });
    cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
  }
  return results;
}

// ============== Reconciliation ==============
export function buildReconciliationData(year) {
  const yr = Number(year);
  const now = new Date();
  const entities = [];

  for (const prop of (state.db.properties || [])) {
    const months = [];
    for (let m = 1; m <= 12; m++) {
      const mk = `${yr}-${String(m).padStart(2, '0')}`;
      const start = `${mk}-01`;
      const end = `${mk}-${new Date(yr, m, 0).getDate().toString().padStart(2, '0')}`;
      const monthEnd = new Date(yr, m, 0);
      const isPast = monthEnd < now;
      let expected = 0, actual = 0;

      if (prop.type === 'long_term' && prop.monthlyRent) {
        // Expected = monthly rent if this month falls within the lease window
        const ls = prop.leaseStartDate ? new Date(prop.leaseStartDate) : null;
        const le = prop.leaseEndDate   ? new Date(prop.leaseEndDate)   : null;
        const mStart = new Date(yr, m - 1, 1);
        const inLease =
          (!ls || mStart >= new Date(ls.getFullYear(), ls.getMonth(), 1)) &&
          (!le || mStart <= new Date(le.getFullYear(), le.getMonth(), 1));
        if (inLease) expected = toEUR(prop.monthlyRent, prop.currency);
        actual = (state.db.payments || [])
          .filter(p => p.propertyId === prop.id && p.date >= start && p.date <= end && p.status === 'paid')
          .reduce((s, p) => s + toEUR(p.amount, p.currency), 0);
      } else if (prop.type === 'short_term') {
        // Expected = all booked revenue (paid + pending); Actual = paid only
        const all = (state.db.payments || []).filter(p =>
          p.propertyId === prop.id && p.date >= start && p.date <= end
        );
        expected = all.reduce((s, p) => s + toEUR(p.amount, p.currency), 0);
        actual   = all.filter(p => p.status === 'paid').reduce((s, p) => s + toEUR(p.amount, p.currency), 0);
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
      const invs = (state.db.invoices || []).filter(i =>
        i.stream === stream && i.issueDate >= start && i.issueDate <= end && i.status !== 'draft'
      );
      const expected = invs.reduce((s, i) => s + toEUR(i.total, i.currency), 0);
      const actual   = invs.filter(i => i.status === 'paid').reduce((s, i) => s + toEUR(i.total, i.currency), 0);
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

  const payments = (state.db.payments || []).filter(p => p.status === 'paid' && matchDate(p) && matchStream(p) && matchProperty(p));
  const invoices = (state.db.invoices || []).filter(i => i.status === 'paid' && matchDate({ date: i.issueDate }) && matchStream(i) && matchProperty(i));
  const opExpenses = (state.db.expenses || []).filter(e => e.category !== 'renovation' && matchDate(e) && matchStream(e) && matchProperty(e));
  const renoExpenses = (state.db.expenses || []).filter(e => e.category === 'renovation' && matchDate(e) && matchProperty(e));

  const rev = [...payments, ...invoices.map(i => ({ ...i, amount: i.total }))].reduce((s, r) => s + toEUR(r.amount, r.currency), 0);
  const exp = opExpenses.reduce((s, r) => s + toEUR(r.amount, r.currency), 0);
  const reno = renoExpenses.reduce((s, r) => s + toEUR(r.amount, r.currency), 0);

  return { payments, invoices, opExpenses, renoExpenses, rev, exp, reno, net: rev - exp };
}

// ============== Drill-down row normalisers (used by all reporting modules) ==============
export function drillRevRows(payments, invoices) {
  return [
    ...(payments || []).map(p => ({ date: p.date, type: 'Payment', source: byId('properties', p.propertyId)?.name || p.source || '', ref: p.type || '', eur: toEUR(p.amount, p.currency) })),
    ...(invoices || []).map(i => ({ date: i.issueDate || i.date, type: 'Invoice', source: byId('clients', i.clientId)?.name || '', ref: i.number || '', eur: toEUR(i.total || i.amount, i.currency) }))
  ].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

export function drillExpRows(expenses) {
  return (expenses || []).map(e => ({ date: e.date, source: byId('properties', e.propertyId)?.name || '', category: e.category, description: e.description || '', eur: toEUR(e.amount, e.currency) }))
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

export function drillNetRows(payments, invoices, expenses) {
  return [
    ...drillRevRows(payments, invoices).map(r => ({ date: r.date, kind: 'Revenue', source: r.source + (r.ref ? ' · ' + r.ref : ''), eur: r.eur })),
    ...drillExpRows(expenses).map(r => ({ date: r.date, kind: 'Expense', source: (r.source ? r.source + ' · ' : '') + r.category, eur: r.eur }))
  ].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}
