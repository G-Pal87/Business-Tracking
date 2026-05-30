#!/usr/bin/env node
/*
 * Standalone daily-rate feed exporter.
 *
 * Reads data/db.json and writes one JSON feed per short-term property plus an
 * index manifest into exports/daily-rates/. This mirrors the in-app publisher
 * (js/modules/str-rates.js → buildRatesFeed) so the feed can also be regenerated
 * headlessly by CI. The Short-Term-Rentals repo consumes these read-only.
 *
 * No dependencies — plain Node. Run: node scripts/export-daily-rates.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'db.json');
const OUT_DIR = path.join(ROOT, 'exports', 'daily-rates');

// Defaults mirror js/core/config.js (overridable via settings.airbnb in the DB).
const DEFAULT_GUEST_FEE_PCT = 14;
const DEFAULT_TAX_PCT = 0;
const DEFAULT_CLEANING_FEE = 50;
const HORIZON_DAYS = 365;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

// ── UTC-safe date helpers (match the app's str-rates helpers) ────────────────
function parseYMD(s) { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); }
function ymd(date) { return date.toISOString().slice(0, 10); }
function addDays(s, n) { const d = parseYMD(s); d.setUTCDate(d.getUTCDate() + n); return ymd(d); }
function todayStr() { return new Date().toISOString().slice(0, 10); }

function checkInOf(p) { return p.airbnbCheckIn || p.checkIn || ''; }
function checkOutOf(p) { return p.airbnbCheckOut || p.checkOut || ''; }

function avgNightOf(p) {
  if (p.avgNightExclCleaning != null) return p.avgNightExclCleaning;
  if (p.avgNightlyRate != null) return p.avgNightlyRate;
  const ci = checkInOf(p), co = checkOutOf(p);
  const n = p.airbnbNights || (ci && co ? Math.max(0, Math.round((parseYMD(co) - parseYMD(ci)) / 86400000)) : 0);
  if (n > 0 && p.amount) return p.amount / n;
  return null;
}

const isActive = (r) => r && !r.deletedAt;

// date → { rate, currency } for every historic night of a property.
function historicNightMap(payments, propertyId) {
  const map = new Map();
  const bookings = payments.filter(p =>
    isActive(p) &&
    p.propertyId === propertyId &&
    p.stream === 'short_term_rental' &&
    p.status !== 'materialized' &&
    checkInOf(p) && checkOutOf(p)
  );
  for (const p of bookings) {
    const rate = avgNightOf(p);
    if (rate == null || rate <= 0) continue;
    const ci = checkInOf(p), co = checkOutOf(p);
    for (let cur = ci; cur < co; cur = addDays(cur, 1)) {
      map.set(cur, { rate, currency: p.currency || 'EUR' });
    }
  }
  return map;
}

// Suggested price for an open day: same month-day across years → same month → overall.
function buildSuggester(histMap) {
  const byMonthDay = new Map();
  const byMonth = new Map();
  const all = [];
  for (const [date, info] of histMap) {
    const md = date.slice(5), mo = date.slice(5, 7);
    (byMonthDay.get(md) || byMonthDay.set(md, []).get(md)).push(info.rate);
    (byMonth.get(mo) || byMonth.set(mo, []).get(mo)).push(info.rate);
    all.push(info.rate);
  }
  const avg = arr => arr.reduce((s, r) => s + r, 0) / arr.length;
  const overall = all.length ? avg(all) : null;
  return function suggest(date) {
    const md = byMonthDay.get(date.slice(5));
    if (md && md.length) return { rate: avg(md), basis: 'same day, prior years' };
    const mo = byMonth.get(date.slice(5, 7));
    if (mo && mo.length) return { rate: avg(mo), basis: `${MONTHS[Number(date.slice(5, 7)) - 1]} average` };
    if (overall != null) return { rate: overall, basis: 'overall average' };
    return null;
  };
}

function blockedDateSet(strCalendars, propertyId) {
  const set = new Set();
  const cal = (strCalendars || []).find(c => c.propertyId === propertyId && !c.deletedAt);
  if (!cal) return set;
  for (const b of cal.blocks || []) {
    if (!b.start || !b.end) continue;
    for (let cur = b.start; cur < b.end; cur = addDays(cur, 1)) set.add(cur);
  }
  return set;
}

// Confirmed manual ADR target for a property + month ('YYYY-MM'), or null.
// Mirrors getConfirmedTarget() in js/modules/str-rates.js so CI-generated feeds
// honor the same manual targets the in-app publisher uses.
function getConfirmedTarget(strRateTargets, propertyId, month) {
  return (strRateTargets || []).find(t =>
    t.propertyId === propertyId && t.month === month && !t.deletedAt
  ) || null;
}

function buildRatesFeed(db, prop) {
  const ccy = prop.currency || 'EUR';
  const histMap = historicNightMap(db.payments || [], prop.id);
  const suggest = buildSuggester(histMap);
  const blocked = blockedDateSet(db.strCalendars, prop.id);

  const af = (db.settings && db.settings.airbnb) || {};
  const feePct = af.guestFeePct != null ? af.guestFeePct : DEFAULT_GUEST_FEE_PCT;
  const taxPct = af.taxPct != null ? af.taxPct : DEFAULT_TAX_PCT;
  const cleanFee = af.cleaningFee != null ? af.cleaningFee : DEFAULT_CLEANING_FEE;
  const guestMult = 1 + (feePct + taxPct) / 100;

  const rates = [];
  let date = todayStr();
  for (let i = 0; i < HORIZON_DAYS; i++) {
    const hist = histMap.get(date);
    let amount = null, basis = null, status;
    if (hist) {
      amount = hist.rate; basis = 'historic actual'; status = 'booked';
    } else {
      const target = getConfirmedTarget(db.strRateTargets, prop.id, date.slice(0, 7));
      if (target) { amount = target.targetADR; basis = 'confirmed target'; }
      else { const s = suggest(date); if (s) { amount = s.rate; basis = s.basis; } }
      status = blocked.has(date) ? 'blocked' : 'open';
    }
    if (amount != null) {
      rates.push({
        date,
        amount: Math.round(amount),
        guestAmount: Math.round(amount * guestMult),
        currency: ccy,
        status,
        basis
      });
    }
    date = addDays(date, 1);
  }

  return {
    schema: 'str-daily-rates/v1',
    generatedAt: new Date().toISOString(),
    property: { id: prop.id, name: prop.name || '', currency: ccy, airbnbCalUrl: prop.airbnbCalUrl || '' },
    guestFeePct: feePct,
    taxPct,
    cleaningFee: Math.round(cleanFee),
    cleaningGuestTotal: Math.round(cleanFee),
    horizonDays: HORIZON_DAYS,
    rates
  };
}

function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`db.json not found at ${DB_PATH}`);
    process.exit(1);
  }
  const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  const stProps = (db.properties || []).filter(p => isActive(p) && p.type === 'short_term');

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const manifest = { schema: 'str-daily-rates-index/v1', generatedAt: new Date().toISOString(), properties: [] };
  for (const p of stProps) {
    const feed = buildRatesFeed(db, p);
    const file = `${p.id}.json`;
    fs.writeFileSync(path.join(OUT_DIR, file), JSON.stringify(feed, null, 2) + '\n');
    manifest.properties.push({
      id: p.id, name: p.name || '', currency: p.currency || 'EUR',
      file, airbnbCalUrl: p.airbnbCalUrl || '', nights: feed.rates.length
    });
    console.log(`wrote ${file} (${feed.rates.length} nights)`);
  }
  fs.writeFileSync(path.join(OUT_DIR, 'index.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`wrote index.json (${manifest.properties.length} properties)`);
}

main();
