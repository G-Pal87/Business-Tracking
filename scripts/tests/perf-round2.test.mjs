// Round-2 performance changes: shared payment index, derived-cache registry,
// the analytics-forecast shared forecast values, fmtDate memo and the queued
// chart creation. Synthetic inline data only — no fixtures, no real records.
// Run: node --test scripts/tests/*.test.mjs
import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.getComputedStyle = globalThis.getComputedStyle || (() => ({ getPropertyValue: () => '' }));
globalThis.requestAnimationFrame = globalThis.requestAnimationFrame || (f => setTimeout(f, 0));
document.documentElement = document.documentElement || { style: {} };

const { state, setDb, invalidateActiveCache, markDirty } = await import('../../js/core/state.js');
const data = await import('../../js/core/data.js');
const ui = await import('../../js/core/ui.js');
const { _calculateDashboardData } = await import('../../js/modules/analytics-forecast.js');

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

// Small deterministic generator — obviously fake records.
function genDb(seed = 1) {
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const pick = a => a[Math.floor(rnd() * a.length)];
  const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
  const p2 = n => String(n).padStart(2, '0');
  const rdate = () => `${ri(2024, 2026)}-${p2(ri(1, 12))}-${p2(ri(1, 28))}`;
  const properties = [], tenants = [], payments = [], forecasts = [];
  for (let i = 0; i < 5; i++) {
    const type = i % 2 ? 'short_term' : 'long_term';
    properties.push({ id: 'p' + i, name: 'Prop ' + i, type, currency: 'EUR', owner: pick(['you', 'rita', 'both']), channel: pick(['company', undefined]) });
    if (type === 'long_term') tenants.push({ id: 't' + i, propertyId: 'p' + i, status: 'active', monthlyRent: ri(500, 1200), currency: 'EUR', leaseStartDate: '2024-02-10', paymentDayOfMonth: 5 });
    for (let y = 2024; y <= 2026; y++) if (rnd() < 0.8) {
      const months = {};
      for (let m = 1; m <= 12; m++) if (rnd() < 0.6) {
        months[`${y}-${p2(m)}`] = rnd() < 0.3
          ? { entries: [{ id: 'e' + m, amount: ri(10, 900) }, { id: 'x' + m, amount: 50, bookingStatus: 'cancelled' }], expenses: ri(0, 200) }
          : { revenue: rnd() < 0.2 ? 0 : ri(100, 3000), expenses: ri(0, 200) };
      }
      forecasts.push({ id: `fc_${i}_${y}`, type: 'property', entityId: 'p' + i, year: y, months });
    }
  }
  // An untyped duplicate for p0/2025 (listed after the typed one): the
  // property breakdown looks among type:'property' records only, the other
  // two among all records — they must keep resolving different records.
  forecasts.push({ id: 'dup', entityId: 'p0', year: 2025, months: { '2025-02': { revenue: 4321 }, '2025-03': { entries: [{ id: 'z', amount: 7 }] } } });
  forecasts.push({ id: 'svc', type: 'service', entityId: 'customer_success', year: 2025, months: { '2025-04': { revenue: 1000, expenses: 10 } } });
  for (let k = 0; k < 120; k++) {
    const pid = pick([...properties.map(p => p.id), undefined, null]);
    payments.push({ id: 'pay' + k, propertyId: pid, stream: pick(['short_term_rental', 'long_term_rental', undefined]), status: pick(['paid', 'paid', 'pending', 'materialized']), amount: ri(50, 2000), currency: 'EUR', date: rdate(), deletedAt: rnd() < 0.05 ? 1 : undefined });
  }
  return { properties, tenants, payments, forecasts, expenses: [], invoices: [], clients: [], settings: { fxRates: { yearRates: {} } } };
}

// ── Item 5: shared payments-by-property index ───────────────────────────────
test('paymentsByProperty: each group equals the per-property filter, same order', () => {
  setDb(genDb(3));
  const all = data.listActivePayments();
  const ids = [...new Set(all.map(p => p.propertyId)), 'nope'];
  for (const id of ids) {
    assert.deepEqual(data.paymentsOfProperty(id), all.filter(p => p.propertyId === id));
  }
  // Every active payment appears exactly once.
  const total = [...data.paymentsByProperty().values()].reduce((s, a) => s + a.length, 0);
  assert.equal(total, all.length);
});

test('paymentsByProperty: follows edits, sync-style in-place changes and db swaps', () => {
  setDb(genDb(4));
  const before = data.paymentsOfProperty('p1').length;
  data.upsert('payments', { id: 'new1', propertyId: 'p1', status: 'paid', amount: 1, currency: 'EUR', date: '2025-01-01' });
  assert.equal(data.paymentsOfProperty('p1').length, before + 1);

  const seq = state.editSeq;
  const adopted = { id: 'new2', propertyId: 'p1', status: 'paid', amount: 1, currency: 'EUR', date: '2025-01-02' };
  state.db.payments.push(adopted);
  state._ix.get('payments').set(adopted.id, adopted);
  invalidateActiveCache();
  assert.equal(state.editSeq, seq);
  assert.equal(data.paymentsOfProperty('p1').length, before + 2);

  setDb(genDb(4));
  assert.equal(data.paymentsOfProperty('p1').length, before);
});

// ── Item 2: derived-cache registry ──────────────────────────────────────────
test('derivedCache: every instance is emptied on a db load and by clearDerivedCaches()', () => {
  setDb(genDb(5));
  const a = data.derivedCache(['payments']);
  const b = data.derivedCache([], () => 'k');
  a().set('x', 1); b().set('y', 2);
  assert.equal(a().get('x'), 1);
  data.clearDerivedCaches();
  assert.equal(a().has('x'), false);
  assert.equal(b().has('y'), false);

  a().set('x', 1);
  const heldMap = a();
  setDb(genDb(5));                       // 'data-loaded' → registry cleared
  assert.notEqual(a(), heldMap, 'the previous generation map is no longer the cache');
  assert.equal(a().has('x'), false);
});

test('toEUR: HUF nearest-year fallback still follows rate-table changes', () => {
  setDb({ settings: { fxRates: { yearRates: { 2024: 0.25 } } } });
  assert.equal(data.toEUR(1000, 'HUF', '2030'), 250);
  state.db.settings.fxRates.yearRates = { 2024: 0.25, 2029: 0.5 };      // new table object
  assert.equal(data.toEUR(1000, 'HUF', '2030'), 500);
  state.db.settings.fxRates.yearRates[2031] = 0.75;                     // in place + edit
  markDirty();
  assert.equal(data.toEUR(1000, 'HUF', '2030'), 500);                  // 2029/2031 equidistant → earlier, as before
  assert.equal(data.toEUR(1000, 'HUF', '2032'), 750);
});

// ── Item 6: analytics-forecast shares one set of per-property values ────────
// The three loops as they were before the change (property filter = default
// filters, Company scope), for an old-vs-new comparison.
function ltRentByMonth(prop, year) {
  if (prop?.type !== 'long_term') return null;
  const map = {};
  for (const e of data.generatePaymentSchedule(prop)) {
    if (e.monthKey?.startsWith(String(year))) map[e.monthKey] = (map[e.monthKey] || 0) + data.toEUR(e.amount, e.currency, year);
  }
  return map;
}
function resolveRev(prop, year, mk, md) {
  const entries = Array.isArray(md?.entries) ? md.entries : [];
  if (entries.length > 0) return data.sumForecastEntries(entries);
  if (md?.revenue != null) return Number(md.revenue) || 0;
  const lt = ltRentByMonth(prop, year);
  return lt ? (lt[mk] || 0) : 0;
}
const propOk = p => (p.channel || 'company') === 'company';
function referenceFc(months, startY, endY) {
  const all = data.listActive('forecasts');
  const byAll = new Map(all.map(fc => [fc.entityId + ':' + fc.year, fc]));
  const byProp = new Map(all.filter(fc => fc.type === 'property').map(fc => [fc.entityId + ':' + fc.year, fc]));
  const fcMonthlyRev = new Map(), fcPropMonthlyRev = new Map();
  const add = (m, k, v) => m.set(k, (m.get(k) || 0) + v);
  for (let y = startY; y <= endY; y++) {
    for (const prop of data.listActive('properties')) {
      if (!propOk(prop)) continue;
      const fc = byAll.get(prop.id + ':' + y);
      if (prop.type === 'long_term') {
        for (let m = 1; m <= 12; m++) {
          const mk = `${y}-${String(m).padStart(2, '0')}`;
          const rev = resolveRev(prop, y, mk, fc?.months?.[mk]);
          if (rev > 0) { add(fcMonthlyRev, mk, rev); add(fcPropMonthlyRev, mk + '_' + prop.id, rev); }
        }
      } else if (fc) {
        for (const [mk, md] of Object.entries(fc.months || {})) {
          const entries = Array.isArray(md.entries) ? md.entries : [];
          const rev = entries.length > 0 ? data.sumForecastEntries(entries) : Number(md.revenue) || 0;
          if (rev > 0) { add(fcMonthlyRev, mk, rev); add(fcPropMonthlyRev, mk + '_' + prop.id, rev); }
        }
      }
    }
    for (const fc of all.filter(f => f.year === y && f.type === 'service')) {
      for (const [mk, md] of Object.entries(fc.months || {})) {
        const entries = Array.isArray(md.entries) ? md.entries : [];
        const rev = entries.length > 0 ? data.sumForecastEntries(entries) : Number(md.revenue) || 0;
        if (rev > 0) add(fcMonthlyRev, mk, rev);
      }
    }
  }
  const perProp = (lookup) => {
    const out = new Map();
    for (const prop of data.listActive('properties')) {
      if (!propOk(prop)) continue;
      for (const m of months) {
        const mk = m.key, y = parseInt(mk.slice(0, 4));
        const fc = lookup.get(prop.id + ':' + y);
        let val;
        if (prop.type === 'long_term') val = resolveRev(prop, y, mk, fc?.months?.[mk]);
        else {
          const md = fc?.months?.[mk];
          if (!md) continue;
          const entries = Array.isArray(md.entries) ? md.entries : [];
          val = entries.length > 0 ? data.sumForecastEntries(entries) : Number(md.revenue) || 0;
        }
        if (val > 0) out.set(prop.id, (out.get(prop.id) || 0) + val);
      }
    }
    return out;
  };
  return { fcMonthlyRev, fcPropMonthlyRev, streamLookup: perProp(byAll), propLookup: perProp(byProp) };
}

test('analytics-forecast: shared per-property forecast values give the same maps and breakdowns', () => {
  setNow('2025-08-15T12:00:00');
  try {
    for (const seed of [1, 2, 3, 11]) {
      setDb(genDb(seed));
      for (const range of [{ start: '2025-01-01', end: '2025-12-31' }, { start: '2024-05-10', end: '2026-03-31' }]) {
        const d = _calculateDashboardData(range);
        const ref = referenceFc(d.months, +range.start.slice(0, 4), +range.end.slice(0, 4));
        assert.deepEqual([...d.fcMonthlyRev], [...ref.fcMonthlyRev], 'fcMonthlyRev');
        assert.deepEqual([...d.fcPropMonthlyRev], [...ref.fcPropMonthlyRev], 'fcPropMonthlyRev');
        // Property breakdown: forecast per property (full months; no filters).
        for (const row of d.propertyBreakdown) {
          assert.equal(row.fcRev, ref.propLookup.get(row.propId) || 0, 'property fc ' + row.propId);
        }
        // Stream breakdown: per-stream sums of the stream-side lookup.
        const byStream = new Map();
        for (const prop of data.listActive('properties')) {
          const s = prop.type === 'short_term' ? 'short_term_rental' : 'long_term_rental';
          if (ref.streamLookup.has(prop.id)) byStream.set(s, (byStream.get(s) || 0) + ref.streamLookup.get(prop.id));
        }
        for (const row of d.streamBreakdown) {
          if (row.key === 'short_term_rental' || row.key === 'long_term_rental') {
            assert.ok(Math.abs(row.fcRev - (byStream.get(row.key) || 0)) < 1e-6, 'stream fc ' + row.key);
          }
        }
      }
    }
    // The untyped duplicate really does make the two lookups differ for p0.
    setDb(genDb(1));
    const d = _calculateDashboardData({ start: '2025-01-01', end: '2025-12-31' });
    const ref = referenceFc(d.months, 2025, 2025);
    assert.notEqual(ref.streamLookup.get('p0'), ref.propLookup.get('p0'));
  } finally { restoreNow(); }
});

// ── Item 8: fmtDate memo ────────────────────────────────────────────────────
test('fmtDate: memoized output equals the direct formatting', () => {
  const direct = s => new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(s + 'T00:00:00Z'));
  for (let i = 0; i < 6000; i++) {       // past the 5000-entry bound
    const s = `20${10 + (i % 20)}-${String(1 + (i % 12)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`;
    assert.equal(ui.fmtDate(s), direct(s));
    assert.equal(ui.fmtDate(s), direct(s));
  }
  assert.equal(ui.fmtDate(''), '');
  assert.equal(ui.fmtDate(null), '');
  assert.equal(ui.fmtDate('garbage'), 'Invalid Date');
  assert.equal(ui.fmtDate('garbage'), 'Invalid Date');
});

// ── Item 3: queued chart creation ───────────────────────────────────────────
test('charts: creation is queued one per frame, cancellable, and re-renders skip animation', async () => {
  const created = [];
  globalThis.Chart = class { constructor(ctx, cfg) { this.canvas = ctx.canvas; this.cfg = cfg; created.push(this); } destroy() { this.destroyed = true; } };
  const canvases = new Map();
  const mkCanvas = id => {
    const c = { id, isConnected: true, style: {}, parentElement: { querySelector: () => null, offsetHeight: 0, style: {} } };
    c.getContext = () => ({ canvas: c });
    canvases.set(id, c);
    return c;
  };
  const realGet = document.getElementById;
  document.getElementById = id => canvases.get(id) || null;
  const flush = () => new Promise(r => setTimeout(r, 30));
  try {
    const charts = await import('../../js/core/charts.js');
    ['a', 'b', 'c', 'd'].forEach(mkCanvas);
    charts.bar('a', { labels: ['x'], datasets: [{ data: [1] }] });
    charts.line('b', { labels: ['x'], datasets: [{ data: [1] }] });
    charts.doughnut('c', { labels: ['x'], data: [1], colors: ['#fff'] });
    charts.bar('d', { labels: ['x'], datasets: [{ data: [1] }] });
    assert.equal(created.length, 0, 'nothing is created synchronously');
    charts.destroy('b');                     // cancel a queued creation
    await flush();
    assert.deepEqual(created.map(c => c.canvas.id), ['a', 'c', 'd']);
    assert.equal(created[0].cfg.options.animation, undefined, 'first draw animates');

    charts.bar('a', { labels: ['y'], datasets: [{ data: [2] }] });   // re-render
    assert.equal(created[0].destroyed, true, 'the old instance is destroyed at once');
    await flush();
    assert.equal(created.at(-1).cfg.options.animation, false, 're-render skips the animation');

    const n = created.length;
    charts.bar('c', { labels: ['x'], datasets: [{ data: [1] }] });
    charts.bar('d', { labels: ['x'], datasets: [{ data: [1] }] });
    charts.destroyAll();                     // navigating away mid-queue
    await flush();
    assert.equal(created.length, n, 'destroyAll cancels queued creations');

    canvases.get('a').isConnected = false;   // view rebuilt before the chart's turn
    charts.bar('a', { labels: ['x'], datasets: [{ data: [1] }] });
    canvases.get('a').isConnected = false;
    await flush();
    assert.equal(created.length, n, 'a detached canvas is skipped');
  } finally {
    document.getElementById = realGet;
    delete globalThis.Chart;
  }
});
