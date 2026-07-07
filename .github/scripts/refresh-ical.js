#!/usr/bin/env node
'use strict';

// Fetches every Airbnb iCal URL stored in data/db.json (strCalendars),
// updates the blocks array in-place, then rebuilds the affected
// exports/daily-rates/*.json feed files.
//
// Designed to run in GitHub Actions (ubuntu-latest + Node 20).
// Airbnb blocks cloud IPs, so we try direct then fall back to corsproxy.io,
// matching the same fetch strategy the browser app uses in ical.js.

const fs   = require('fs');
const path = require('path');

// ── Constants (mirrors config.js / str-rates.js) ──────────────────────────────
const AIRBNB_GUEST_FEE_PCT = 14;
const AIRBNB_TAX_PCT       = 0;
const AIRBNB_CLEANING_FEE  = 50;
const FEED_HORIZON_DAYS    = 365;
const FEED_DIR             = 'exports/daily-rates';
const MONTHS               = ['January','February','March','April','May','June',
                               'July','August','September','October','November','December'];

// Suggestion-engine weights (mirrors str-rates.js)
const MIN_SAME_DAY_YEARS   = 2;
const CURRENT_YEAR_WEIGHT  = 3;
const PRIOR_YEAR_DECAY     = 0.65;
const STANDALONE_THRESHOLD = 15;

// ── Date helpers ──────────────────────────────────────────────────────────────
function parseYMD(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
function ymd(d)      { return d.toISOString().slice(0, 10); }
function todayStr()  { return new Date().toISOString().slice(0, 10); }
function addDays(s, n) {
  const d = parseYMD(s);
  d.setUTCDate(d.getUTCDate() + n);
  return ymd(d);
}

// ── iCal parser (port of js/core/ical.js) ────────────────────────────────────
function parseICalDate(str) {
  if (!str) return null;
  if (/^\d{8}$/.test(str))          return `${str.slice(0,4)}-${str.slice(4,6)}-${str.slice(6,8)}`;
  if (/^\d{8}T\d{6}Z?$/.test(str)) return `${str.slice(0,4)}-${str.slice(4,6)}-${str.slice(6,8)}`;
  return str;
}

function parseICal(text) {
  const events   = [];
  const lines    = text.replace(/\r/g, '').split('\n');
  const unfolded = [];
  for (const l of lines) {
    if (l.startsWith(' ') || l.startsWith('\t')) unfolded[unfolded.length - 1] += l.slice(1);
    else unfolded.push(l);
  }
  let current = null;
  for (const line of unfolded) {
    if (line === 'BEGIN:VEVENT')  { current = {}; }
    else if (line === 'END:VEVENT') { if (current) events.push(current); current = null; }
    else if (current) {
      const [rawKey, ...rest] = line.split(':');
      const val = rest.join(':');
      const key = rawKey.split(';')[0];
      if      (key === 'DTSTART') current.start   = parseICalDate(val);
      else if (key === 'DTEND')   current.end     = parseICalDate(val);
      else if (key === 'SUMMARY') current.summary = val;
      else if (key === 'UID')     current.uid     = val;
    }
  }
  return events;
}

// ── iCal fetch: direct → multiple CORS-proxy fallbacks ───────────────────────
// Airbnb blocks cloud/datacenter IPs. We try direct first (works from
// residential IPs / GitHub Actions) then fall back through several free
// proxy services in case any one is rate-limited or blocked.
async function fetchICal(url) {
  const direct = await fetchWithTimeout(url, 15000);
  if (direct !== null) return direct;

  const proxies = [
    `https://corsproxy.io/?${encodeURIComponent(url)}`,
    `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`,
    `https://cors.eu.org/${url}`,
  ];

  for (const proxyUrl of proxies) {
    const label = proxyUrl.split('/')[2];
    console.log(`  Trying proxy: ${label}`);
    const body = await fetchWithTimeout(proxyUrl, 25000);
    if (body === null) continue;
    // allorigins.win wraps the response in { contents: "…" }
    if (proxyUrl.includes('allorigins')) {
      try { return JSON.parse(body).contents; } catch { continue; }
    }
    return body;
  }
  throw new Error('iCal unreachable via direct fetch and all proxy fallbacks');
}

async function fetchWithTimeout(url, ms) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(ms) });
    if (res.ok) return await res.text();
    console.log(`  HTTP ${res.status} from ${url.slice(0, 70)}…`);
    return null;
  } catch (e) {
    console.log(`  Fetch error: ${e.message}`);
    return null;
  }
}

// Merge freshly-fetched blocks with the previous snapshot so blocks that have
// already elapsed and dropped off Airbnb's live iCal feed aren't lost (mirrors
// js/core/ical.js). Airbnb's feed only reflects current/future state — once a
// booking or owner-block is in the past, Airbnb can prune it from the feed
// entirely. Future/current blocks always defer to the fresh feed (so
// cancellations there are still reflected); only already-elapsed blocks that
// vanished from the feed get carried forward.
function mergeBlocks(existingBlocks, freshBlocks, today) {
  const freshUids = new Set(freshBlocks.filter(b => b.uid).map(b => b.uid));
  const preserved = (existingBlocks || []).filter(b =>
    b.end && b.end <= today && !freshUids.has(b.uid)
  );
  return [...preserved, ...freshBlocks];
}

// ── DB helpers ────────────────────────────────────────────────────────────────
function listActive(db, col) {
  return (db[col] || []).filter(x => !x.deletedAt);
}

function getConfirmedTarget(db, propertyId, month) {
  return (db.strRateTargets || []).find(t =>
    t.propertyId === propertyId && t.month === month && !t.deletedAt
  ) || null;
}

function blockedDateSet(db, propertyId) {
  const set = new Set();
  const cal = (db.strCalendars || []).find(c => c.propertyId === propertyId && !c.deletedAt);
  if (!cal) return set;
  for (const b of cal.blocks || []) {
    if (!b.start || !b.end) continue;
    for (let cur = b.start; cur < b.end; cur = addDays(cur, 1)) set.add(cur);
  }
  return set;
}

// Port of avgNightOf / historicNightMap from str-rates.js
function historicNightMap(db, propertyId) {
  const map = new Map();
  const bookings = listActive(db, 'payments').filter(p =>
    p.propertyId === propertyId &&
    p.stream === 'short_term_rental' &&
    p.status !== 'materialized'
  );
  for (const p of bookings) {
    const ci = p.airbnbCheckIn  || p.checkIn  || '';
    const co = p.airbnbCheckOut || p.checkOut || '';
    if (!ci || !co) continue;
    const nights = p.airbnbNights ||
      Math.max(0, Math.round((parseYMD(co) - parseYMD(ci)) / 86400000));
    if (!nights || !p.amount) continue;

    // Net nightly rate: prefer pre-computed field, else derive
    const rate = p.avgNightExclCleaning ?? p.avgNightlyRate ?? (p.amount / nights);
    // ADR: total payout / nights (cleaning amortised in)
    const adr  = p.amount / nights;
    if (!rate || rate <= 0) continue;

    const guest = (p.notes || '').split(' · ')[0] || '';
    for (let cur = ci; cur < co; cur = addDays(cur, 1)) {
      map.set(cur, {
        rate, adr,
        currency: p.currency || 'EUR',
        label: guest,
        code: p.confirmationCode || '',
        nights, amount: p.amount,
        cleaningFee: p.airbnbCleaningFee ?? null,
        checkIn: ci, checkOut: co
      });
    }
  }
  return map;
}

// ── Suggestion engine (port of buildSuggester from str-rates.js) ──────────────
function buildSuggester(histMap) {
  const byYearMonth = new Map();
  const byMonthDay  = new Map();
  const all = [];
  for (const [date, info] of histMap) {
    const ym = date.slice(0, 7), md = date.slice(5);
    const entry = { date, rate: info.rate, adr: info.adr || info.rate };
    if (!byYearMonth.has(ym)) byYearMonth.set(ym, []);
    byYearMonth.get(ym).push(entry);
    if (!byMonthDay.has(md))  byMonthDay.set(md, []);
    byMonthDay.get(md).push(entry);
    all.push(entry);
  }
  const avg    = arr => arr.reduce((s, r) => s + r.rate, 0) / arr.length;
  const avgADR = arr => arr.reduce((s, r) => s + r.adr,  0) / arr.length;
  const yrWeight = ya => CURRENT_YEAR_WEIGHT * Math.pow(PRIOR_YEAR_DECAY, ya);

  return function suggest(date) {
    const ym    = date.slice(0, 7);
    const dayStr= date.slice(8);
    const mo    = date.slice(5, 7);
    const yr    = ym.slice(0, 4);
    const yrNum = Number(yr);

    const ymArr = byYearMonth.get(ym) || [];

    const monthByYear = [];
    for (const [ym2, entries] of byYearMonth) {
      if (ym2.slice(5, 7) !== mo) continue;
      const ya = yrNum - Number(ym2.slice(0, 4));
      if (ya < 0) continue;
      monthByYear.push({ ya, entries, weight: yrWeight(ya) });
    }
    monthByYear.sort((a, b) => a.ya - b.ya);

    const priorDayMap = new Map();
    for (const e of (byMonthDay.get(date.slice(5)) || [])) {
      const yr2 = e.date.slice(0, 4);
      if (yr2 === yr) continue;
      if (!priorDayMap.has(yr2)) priorDayMap.set(yr2, []);
      priorDayMap.get(yr2).push(e);
    }
    const priorDayYears = priorDayMap.size;

    const pools = [];
    const currentEffN = ymArr.length * CURRENT_YEAR_WEIGHT;

    if (ymArr.length && currentEffN >= STANDALONE_THRESHOLD) {
      pools.push(monthByYear.find(p => p.ya === 0));
    } else if (ymArr.length) {
      for (const p of monthByYear) pools.push(p);
    } else if (priorDayYears >= MIN_SAME_DAY_YEARS) {
      for (const [yr2, entries] of priorDayMap) {
        const ya = yrNum - Number(yr2);
        pools.push({ ya, entries, weight: yrWeight(ya) });
      }
      pools.sort((a, b) => a.ya - b.ya);
    } else {
      for (const p of monthByYear) if (p.ya > 0) pools.push(p);
      if (!pools.length && all.length)
        pools.push({ entries: all, weight: 1, label: 'overall history' });
    }
    if (!pools.length) return null;

    let totalW = 0, rateSum = 0, adrSum = 0;
    for (const pool of pools) {
      pool.rate = avg(pool.entries);
      pool.adr  = avgADR(pool.entries);
      const w   = pool.entries.length * pool.weight;
      rateSum  += pool.rate * w;
      adrSum   += pool.adr  * w;
      totalW   += w;
    }
    const mo1     = Number(mo);
    const moName  = MONTHS[mo1 - 1];
    const basis   = pools.length > 1
      ? pools.map(p => `${moName} ${yr} blended (${p.entries.length}n)`).join(' + ')
      : `${(pools[0].label || moName)} (${pools[0].entries.length} night${pools[0].entries.length !== 1 ? 's' : ''})`;

    return { rate: rateSum / totalW, adr: adrSum / totalW, basis };
  };
}

// ── Feed builder (port of buildRatesFeed from str-rates.js) ───────────────────
function buildRatesFeed(db, propertyId) {
  const prop    = listActive(db, 'properties').find(p => p.id === propertyId);
  const ccy     = prop?.currency || 'EUR';
  const histMap = historicNightMap(db, propertyId);
  const suggest = buildSuggester(histMap);
  const blocked = blockedDateSet(db, propertyId);

  const af         = db.settings?.airbnb || {};
  const feePct     = af.guestFeePct     != null ? af.guestFeePct     : AIRBNB_GUEST_FEE_PCT;
  const taxPct     = af.taxPct          != null ? af.taxPct          : AIRBNB_TAX_PCT;
  const cleanFee   = af.cleaningFee     != null ? af.cleaningFee     : AIRBNB_CLEANING_FEE;
  const globalDisc = af.globalDiscountPct || 0;
  const guestMult  = 1 + (feePct + taxPct) / 100;

  const rates = [];
  let date = todayStr();
  for (let i = 0; i < FEED_HORIZON_DAYS; i++) {
    const hist = histMap.get(date);
    let amount = null, basis = null, status;

    if (hist) {
      amount = hist.rate; basis = 'historic actual'; status = 'booked';
    } else {
      const mo     = date.slice(0, 7);
      const target = getConfirmedTarget(db, propertyId, mo);
      if (target)      { amount = target.targetADR; basis = 'confirmed target'; }
      else             { const s = suggest(date); if (s) { amount = s.rate; basis = s.basis; } }
      status = blocked.has(date) ? 'blocked' : 'open';
    }

    if (amount != null) {
      const entry  = { date, currency: ccy, status, basis };
      const rawAmt = Math.round(amount);
      // Effective discount for this night: monthly override (explicit, incl.
      // 0) beats the global default; historic/booked nights are actuals, not
      // a forward-looking offer, so no discount applies to them. Always set
      // on every entry (even 0%) — omitting it when there's no discount left
      // a consumer with no reliable field to read "what's on offer right now"
      // from, since a missing field and an explicit 0% are indistinguishable.
      let discPct = 0;
      if (!hist) {
        const mo     = date.slice(0, 7);
        const target = getConfirmedTarget(db, propertyId, mo);
        discPct = target?.discountPct != null ? target.discountPct : globalDisc;
      }
      entry.originalAmount = rawAmt;
      entry.discountPct    = discPct;
      entry.amount         = discPct > 0 ? Math.round(rawAmt * (1 - discPct / 100)) : rawAmt;
      entry.airbnbCheckout = Math.round(rawAmt * guestMult);
      rates.push(entry);
    }
    date = addDays(date, 1);
  }

  return {
    schema: 'str-daily-rates/v1',
    generatedAt: new Date().toISOString(),
    property: { id: prop?.id || propertyId, name: prop?.name || '', currency: ccy, airbnbCalUrl: prop?.airbnbCalUrl || '' },
    guestFeePct: feePct, taxPct,
    cleaningFee: Math.round(cleanFee),
    cleaningGuestTotal: Math.round(cleanFee),
    horizonDays: FEED_HORIZON_DAYS,
    rates
  };
}

function feedSig(feed) {
  return JSON.stringify({ p: feed.property, r: feed.rates });
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const root   = path.resolve(__dirname, '..', '..');
  const dbPath = path.join(root, 'data', 'db.json');
  const db     = JSON.parse(fs.readFileSync(dbPath, 'utf8'));

  const calendars = (db.strCalendars || []).filter(c => !c.deletedAt && c.url);
  if (!calendars.length) {
    console.log('No active strCalendar entries with URLs — nothing to refresh.');
    return;
  }

  let dbChanged = false;
  const changedPropIds = new Set();

  for (const cal of calendars) {
    const shortUrl = cal.url.slice(0, 70) + (cal.url.length > 70 ? '…' : '');
    console.log(`\nFetching iCal for ${cal.propertyId} (${shortUrl})`);
    try {
      const text = await fetchICal(cal.url);
      const events = parseICal(text);
      const freshBlocks = events
        .filter(e => e.start && e.end)
        .map(e => ({ start: e.start, end: e.end, uid: (e.uid || '').trim(), summary: (e.summary || '').trim() }));
      const mergedBlocks = mergeBlocks(cal.blocks, freshBlocks, todayStr())
        .sort((a, b) => a.start < b.start ? -1 : a.start > b.start ? 1 : 0);

      // Normalise existing blocks the same way before comparing so ordering
      // differences in the iCal feed don't trigger a spurious commit every run.
      const normOld = (cal.blocks || [])
        .map(b => ({ start: b.start, end: b.end, uid: (b.uid || '').trim(), summary: (b.summary || '').trim() }))
        .sort((a, b) => a.start < b.start ? -1 : a.start > b.start ? 1 : 0);

      const oldSig = JSON.stringify(normOld);
      const newSig = JSON.stringify(mergedBlocks);
      if (oldSig === newSig) {
        console.log(`  No changes (${mergedBlocks.length} block(s))`);
      } else {
        console.log(`  Updated: ${(cal.blocks||[]).length} → ${mergedBlocks.length} block(s)`);
        cal.blocks      = mergedBlocks;
        cal.lastFetched = new Date().toISOString();
        dbChanged = true;
        changedPropIds.add(cal.propertyId);
      }
    } catch (err) {
      console.error(`  FAILED: ${err.message}`);
    }
  }

  if (!dbChanged) {
    console.log('\nNo iCal changes detected — skipping file writes.');
    return;
  }

  // Write updated db.json
  fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
  console.log(`\nWrote data/db.json (${changedPropIds.size} calendar(s) updated)`);

  // Rebuild feeds + index for changed properties
  const stProps = listActive(db, 'properties').filter(p => p.type === 'short_term');
  const manifest = {
    schema: 'str-daily-rates-index/v1',
    generatedAt: new Date().toISOString(),
    properties: []
  };

  for (const prop of stProps) {
    const feedPath = path.join(root, FEED_DIR, `${prop.id}.json`);
    const newFeed  = buildRatesFeed(db, prop.id);

    // Check if the content actually changed vs what's on disk
    let oldSig = '';
    if (fs.existsSync(feedPath)) {
      try { oldSig = feedSig(JSON.parse(fs.readFileSync(feedPath, 'utf8'))); } catch { /* rebuild */ }
    }
    const newSig = feedSig(newFeed);

    if (oldSig !== newSig || changedPropIds.has(prop.id)) {
      fs.writeFileSync(feedPath, JSON.stringify(newFeed, null, 2));
      console.log(`Rebuilt feed: ${prop.id} (${newFeed.rates.length} rate entries)`);
    }

    manifest.properties.push({
      id: prop.id, name: prop.name, currency: prop.currency || 'EUR',
      file: `${prop.id}.json`, nights: newFeed.rates.length
    });
  }

  const indexPath = path.join(root, FEED_DIR, 'index.json');
  fs.writeFileSync(indexPath, JSON.stringify(manifest, null, 2));
  console.log(`Wrote ${FEED_DIR}/index.json`);
}

main().catch(err => { console.error(err); process.exit(1); });
