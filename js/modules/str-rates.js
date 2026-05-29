// STR Daily Rates — historic per-night rates derived from bookings, projected
// into a month calendar with suggested prices for open days. Booked/blocked
// days can be overlaid from an Airbnb iCal feed.
import { state } from '../core/state.js';
import { el, openModal, closeModal, toast, select, input, button, formRow, fmtDate, confirmDialog } from '../core/ui.js';
import { listActive, listActivePayments, byId, upsert, newId, formatMoney } from '../core/data.js';
import { fetchICal, parseICal } from '../core/ical.js';
import { uploadGithubFile } from '../core/github.js';
import { AIRBNB_GUEST_FEE_PCT, AIRBNB_TAX_PCT } from '../core/config.js';

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const WEEKDAYS = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];

// Persisted view selection across refreshes/navigation.
let _propId  = null;
let _anchor  = null; // "YYYY-MM" of the month being displayed

export default {
  id: 'str-rates',
  label: 'STR Daily Rates',
  icon: '€',
  render(container) { container.appendChild(build()); },
  refresh() { const c = document.getElementById('content'); c.innerHTML = ''; c.appendChild(build()); },
  destroy() {}
};

// ── UTC-safe date helpers (avoid local-timezone drift on YYYY-MM-DD strings) ──
function parseYMD(s) { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); }
function ymd(date)   { return date.toISOString().slice(0, 10); }
function addDays(s, n) { const d = parseYMD(s); d.setUTCDate(d.getUTCDate() + n); return ymd(d); }
function todayStr()  { return new Date().toISOString().slice(0, 10); }
function thisMonth() { return todayStr().slice(0, 7); }
function daysInMonth(year, month1) { return new Date(Date.UTC(year, month1, 0)).getUTCDate(); }

// ── Booking → per-night rate extraction ──────────────────────────────────────
// A reservation earns `avgNight` for each night from check-in (inclusive) to
// check-out (exclusive). We prefer the rate excluding the cleaning fee so the
// nightly price reflects what a guest is charged per night.
function checkInOf(p)  { return p.airbnbCheckIn  || p.checkIn  || ''; }
function checkOutOf(p) { return p.airbnbCheckOut || p.checkOut || ''; }

function avgNightOf(p) {
  if (p.avgNightExclCleaning != null) return p.avgNightExclCleaning;
  if (p.avgNightlyRate != null)       return p.avgNightlyRate;
  const ci = checkInOf(p), co = checkOutOf(p);
  const n = p.airbnbNights || (ci && co ? Math.max(0, Math.round((parseYMD(co) - parseYMD(ci)) / 86400000)) : 0);
  if (n > 0 && p.amount) return p.amount / n;
  return null;
}

// Build date → { rate, currency, label } for every historic night of an STR property.
function historicNightMap(propertyId) {
  const map = new Map();
  const bookings = listActivePayments().filter(p =>
    p.propertyId === propertyId &&
    p.stream === 'short_term_rental' &&
    p.status !== 'materialized' &&          // materialized duplicates a paid record
    checkInOf(p) && checkOutOf(p)
  );
  for (const p of bookings) {
    const rate = avgNightOf(p);
    if (rate == null || rate <= 0) continue;
    const ci = checkInOf(p), co = checkOutOf(p);
    const guest = (p.notes || '').split(' · ')[0] || '';
    for (let cur = ci; cur < co; cur = addDays(cur, 1)) {
      map.set(cur, { rate, currency: p.currency || 'EUR', label: guest, code: p.confirmationCode || '' });
    }
  }
  return map;
}

// ── Suggestion engine ─────────────────────────────────────────────────────────
// For a date with no historic actual, suggest a price from history, preferring
// the most specific signal available: same month-day across years → same month
// → overall average.
function buildSuggester(histMap) {
  const byMonthDay = new Map(); // "MM-DD" → [rates]
  const byMonth    = new Map(); // "MM"    → [rates]
  const all = [];
  for (const [date, info] of histMap) {
    const md = date.slice(5);      // MM-DD
    const mo = date.slice(5, 7);   // MM
    (byMonthDay.get(md) || byMonthDay.set(md, []).get(md)).push(info.rate);
    (byMonth.get(mo)    || byMonth.set(mo, []).get(mo)).push(info.rate);
    all.push(info.rate);
  }
  const avg = arr => arr.reduce((s, r) => s + r, 0) / arr.length;
  const overall = all.length ? avg(all) : null;

  return function suggest(date) {
    const md = byMonthDay.get(date.slice(5));
    if (md && md.length) return { rate: avg(md), basis: 'same day, prior years' };
    const mo = byMonth.get(date.slice(5, 7));
    if (mo && mo.length) return { rate: avg(mo), basis: `${MONTHS[Number(date.slice(5, 7)) - 1]} average` };
    if (overall != null)  return { rate: overall, basis: 'overall average' };
    return null;
  };
}

// ── iCal blocks (external reserved/blocked days) ─────────────────────────────
function calendarFor(propertyId) {
  return (state.db.strCalendars || []).find(c => c.propertyId === propertyId && !c.deletedAt) || null;
}

// Set of date strings covered by any imported block (DTEND is exclusive).
function blockedDateSet(propertyId) {
  const set = new Set();
  const cal = calendarFor(propertyId);
  if (!cal) return set;
  for (const b of cal.blocks || []) {
    if (!b.start || !b.end) continue;
    for (let cur = b.start; cur < b.end; cur = addDays(cur, 1)) set.add(cur);
  }
  return set;
}

// ── Daily-rate feed export (consumed read-only by the Short-Term-Rentals repo) ─
// Publishes one JSON file per short-term property mapping each upcoming date to
// the rate amount to push into a channel/iCal. The external repo only needs the
// `amount` per `date`; `status`/`basis` are extra context it can ignore.
const FEED_DIR = 'exports/daily-rates';
const FEED_HORIZON_DAYS = 365;

// UTF-8 safe base64 (GitHub Contents API expects base64-encoded content).
function toB64(str) { return btoa(unescape(encodeURIComponent(str))); }

// Build the per-property rate feed: actual rate on booked nights, suggested rate
// on open/blocked nights, for the next FEED_HORIZON_DAYS days from today.
// Each night carries both the net nightly rate (`amount`, what the host earns)
// and the full guest-facing price (`guestAmount` = amount grossed up by the
// configured guest service fee % + tax %) so the consumer can discount it.
function buildRatesFeed(propertyId, horizonDays = FEED_HORIZON_DAYS) {
  const prop    = byId('properties', propertyId);
  const ccy     = prop?.currency || 'EUR';
  const histMap = historicNightMap(propertyId);
  const suggest = buildSuggester(histMap);
  const blocked = blockedDateSet(propertyId);

  // Guest service fee + tax used to gross the net rate up to the full guest price.
  const af      = state.db.settings?.airbnb || {};
  const feePct  = af.guestFeePct != null ? af.guestFeePct : AIRBNB_GUEST_FEE_PCT;
  const taxPct  = af.taxPct      != null ? af.taxPct      : AIRBNB_TAX_PCT;
  const guestMult = 1 + (feePct + taxPct) / 100;

  const rates = [];
  let date = todayStr();
  for (let i = 0; i < horizonDays; i++) {
    const hist = histMap.get(date);
    let amount = null, basis = null, status;
    if (hist) {
      amount = hist.rate; basis = 'historic actual'; status = 'booked';
    } else {
      const s = suggest(date);
      if (s) { amount = s.rate; basis = s.basis; }
      status = blocked.has(date) ? 'blocked' : 'open';
    }
    if (amount != null) {
      rates.push({
        date,
        amount: Math.round(amount),                  // net nightly rate (host earns)
        guestAmount: Math.round(amount * guestMult), // full price guest pays per night, fees included
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
    property: { id: prop?.id || propertyId, name: prop?.name || '', currency: ccy, airbnbCalUrl: prop?.airbnbCalUrl || '' },
    guestFeePct: feePct,
    taxPct,
    horizonDays,
    rates
  };
}

// Content signature of a feed (ignores generatedAt so unchanged data is a no-op).
function feedSig(feed) { return JSON.stringify({ p: feed.property, r: feed.rates }); }

// Cache of the last-published signature per property, so auto-publish only
// uploads feeds whose rates actually changed. In-memory only (resets on reload,
// in which case the next publish simply re-uploads everything once).
const _lastFeedSig = new Map();
let _lastManifestSig = '';
let _publishing = false;

const feedBase = () => {
  const { owner, repo, branch } = state.github;
  return `https://raw.githubusercontent.com/${owner}/${repo}/${branch || 'main'}/${FEED_DIR}`;
};

// Publish a feed file per STR property plus an index manifest. Always uploads
// every property (used by the manual button). Returns the public base URL + manifest.
async function publishRatesFeeds() {
  const stProps = listActive('properties').filter(p => p.type === 'short_term');
  if (!stProps.length) throw new Error('No short-term properties to export');

  const manifest = { schema: 'str-daily-rates-index/v1', generatedAt: new Date().toISOString(), properties: [] };
  for (const p of stProps) {
    const feed = buildRatesFeed(p.id);
    const file = `${p.id}.json`;
    await uploadGithubFile(`${FEED_DIR}/${file}`, toB64(JSON.stringify(feed, null, 2)), `Publish daily-rate feed: ${p.name}`);
    _lastFeedSig.set(p.id, feedSig(feed));
    manifest.properties.push({ id: p.id, name: p.name, currency: p.currency || 'EUR', file, nights: feed.rates.length });
  }
  await uploadGithubFile(`${FEED_DIR}/index.json`, toB64(JSON.stringify(manifest, null, 2)), 'Publish daily-rate feed index');
  _lastManifestSig = JSON.stringify(manifest.properties);

  return { base: feedBase(), manifest };
}

// Auto-publish hook (called after a successful data sync). Incremental: only
// uploads property feeds whose content changed, and only rewrites the index when
// a feed changed or the property set changed. Silent and best-effort.
export async function autoPublishRatesFeeds() {
  if (_publishing) return;
  const { owner, repo, token } = state.github;
  if (!owner || !repo || !token) return;
  const stProps = listActive('properties').filter(p => p.type === 'short_term');
  if (!stProps.length) return;

  _publishing = true;
  try {
    const manifestProps = [];
    let changed = false;
    for (const p of stProps) {
      const feed = buildRatesFeed(p.id);
      manifestProps.push({ id: p.id, name: p.name, currency: p.currency || 'EUR', file: `${p.id}.json`, nights: feed.rates.length });
      const sig = feedSig(feed);
      if (_lastFeedSig.get(p.id) === sig) continue; // unchanged → skip upload
      await uploadGithubFile(`${FEED_DIR}/${p.id}.json`, toB64(JSON.stringify(feed, null, 2)), `Update daily-rate feed: ${p.name}`);
      _lastFeedSig.set(p.id, sig);
      changed = true;
    }
    const manifestSig = JSON.stringify(manifestProps);
    if (changed || manifestSig !== _lastManifestSig) {
      const manifest = { schema: 'str-daily-rates-index/v1', generatedAt: new Date().toISOString(), properties: manifestProps };
      await uploadGithubFile(`${FEED_DIR}/index.json`, toB64(JSON.stringify(manifest, null, 2)), 'Update daily-rate feed index');
      _lastManifestSig = manifestSig;
    }
  } catch (e) {
    console.warn('Auto-publish daily-rate feeds failed:', e);
  } finally {
    _publishing = false;
  }
}

// Show the public URLs after publishing so they can be wired into the other repo.
function showFeedUrls({ base, manifest }) {
  const body = el('div', {});
  body.appendChild(el('div', { style: 'font-size:13px;color:var(--text-muted);margin-bottom:10px' },
    'Daily-rate feeds published. The Short-Term-Rentals repo can read these read-only over HTTPS (the repo must be public for raw URLs to work without a token).'));

  const urlRow = (label, url) => {
    const inp = input({ value: url });
    inp.readOnly = true;
    inp.onclick = () => { inp.select(); };
    return formRow(label, inp);
  };

  body.appendChild(urlRow('Index (start here)', `${base}/index.json`));
  for (const p of manifest.properties) {
    body.appendChild(urlRow(`${p.name} (${p.nights} nights)`, `${base}/${p.file}`));
  }
  openModal({ title: 'Daily-Rate Feed URLs', body, footer: [button('Close', { onClick: closeModal })] });
}

// ── Main view ─────────────────────────────────────────────────────────────────
function build() {
  const wrap = el('div', { class: 'view active' });

  const stProps = listActive('properties').filter(p => p.type === 'short_term');
  if (stProps.length === 0) {
    wrap.appendChild(el('div', { class: 'empty' }, 'No short-term rental properties configured. Add a short-term property first.'));
    return wrap;
  }

  if (!_propId || !stProps.some(p => p.id === _propId)) _propId = stProps[0].id;
  if (!_anchor) _anchor = thisMonth();

  // ── Controls bar ──
  const bar = el('div', { class: 'flex gap-8 mb-16', style: 'align-items:center;flex-wrap:wrap' });
  const propSel = select(stProps.map(p => ({ value: p.id, label: p.name })), _propId);
  propSel.style.maxWidth = '240px';
  propSel.onchange = () => { _propId = propSel.value; rerender(); };

  const prevBtn  = button('‹', { variant: 'sm ghost' });
  const nextBtn  = button('›', { variant: 'sm ghost' });
  const monthLbl = el('strong', { style: 'min-width:150px;text-align:center;font-size:15px' });
  prevBtn.onclick = () => { _anchor = shiftMonth(_anchor, -1); rerender(); };
  nextBtn.onclick = () => { _anchor = shiftMonth(_anchor, +1); rerender(); };
  const todayBtn = button('Today', { variant: 'sm ghost', onClick: () => { _anchor = thisMonth(); rerender(); } });

  bar.appendChild(el('span', { style: 'font-size:13px;color:var(--text-muted)' }, 'Property:'));
  bar.appendChild(propSel);
  bar.appendChild(el('div', { style: 'width:8px' }));
  bar.appendChild(prevBtn);
  bar.appendChild(monthLbl);
  bar.appendChild(nextBtn);
  bar.appendChild(todayBtn);
  bar.appendChild(el('div', { class: 'flex-1' }));
  const publishBtn = button('Publish Rates Feed', { onClick: async () => {
    const ok = await confirmDialog(
      `Publish daily-rate feeds for all short-term properties to GitHub (under ${FEED_DIR}/)? These JSON files are read by the Short-Term-Rentals repo.`,
      { okLabel: 'Publish' }
    );
    if (!ok) return;
    const orig = publishBtn.textContent;
    publishBtn.disabled = true; publishBtn.textContent = 'Publishing…';
    try {
      const res = await publishRatesFeeds();
      toast(`Published ${res.manifest.properties.length} rate feed(s)`, 'success');
      showFeedUrls(res);
    } catch (e) {
      toast(`Publish failed: ${e.message}`, 'danger', 6000);
    } finally {
      publishBtn.disabled = false; publishBtn.textContent = orig;
    }
  }});
  bar.appendChild(publishBtn);
  bar.appendChild(button('Import Airbnb Calendar', { onClick: () => openImportModal(_propId, rerender) }));
  wrap.appendChild(bar);

  const kpiRow   = el('div', { class: 'grid grid-4 mb-16' });
  const calCard  = el('div', { class: 'card' });
  wrap.appendChild(kpiRow);
  wrap.appendChild(calCard);

  function rerender() {
    propSel.value = _propId;
    const prop = byId('properties', _propId);
    const ccy  = prop?.currency || 'EUR';
    const [yStr, mStr] = _anchor.split('-');
    const year = Number(yStr), month1 = Number(mStr);
    monthLbl.textContent = `${MONTHS[month1 - 1]} ${year}`;

    const histMap = historicNightMap(_propId);
    const suggest = buildSuggester(histMap);
    const blocked = blockedDateSet(_propId);

    // Rate range across history → used for colour grading.
    const rates = [...histMap.values()].map(v => v.rate);
    const minR = rates.length ? Math.min(...rates) : 0;
    const maxR = rates.length ? Math.max(...rates) : 0;

    renderKpis(kpiRow, { histMap, suggest, blocked, year, month1, ccy });
    renderCalendar(calCard, { histMap, suggest, blocked, year, month1, ccy, minR, maxR });
  }

  rerender();
  return wrap;
}

function shiftMonth(anchor, delta) {
  let [y, m] = anchor.split('-').map(Number);
  m += delta;
  while (m < 1)  { m += 12; y--; }
  while (m > 12) { m -= 12; y++; }
  return `${y}-${String(m).padStart(2, '0')}`;
}

// ── KPI cards ─────────────────────────────────────────────────────────────────
function renderKpis(row, { histMap, suggest, blocked, year, month1, ccy }) {
  row.innerHTML = '';
  const mo = String(month1).padStart(2, '0');
  const dim = daysInMonth(year, month1);

  // Historic average for this calendar month, across all years.
  const monthHist = [...histMap].filter(([d]) => d.slice(5, 7) === mo).map(([, v]) => v.rate);
  const avgHist = monthHist.length ? monthHist.reduce((s, r) => s + r, 0) / monthHist.length : null;

  // Booked vs open nights within the displayed month.
  let booked = 0, suggSum = 0, suggN = 0;
  for (let d = 1; d <= dim; d++) {
    const date = `${year}-${mo}-${String(d).padStart(2, '0')}`;
    const isBooked = histMap.has(date) || blocked.has(date);
    if (isBooked) { booked++; continue; }
    const s = suggest(date);
    if (s) { suggSum += s.rate; suggN++; }
  }
  const avgSugg = suggN ? suggSum / suggN : null;
  const occ = Math.round((booked / dim) * 100);

  const card = (label, value, sub, variant) => el('div', { class: `kpi${variant ? ' ' + variant : ''}` },
    el('div', { class: 'kpi-label' }, label),
    el('div', { class: 'kpi-value num' }, value),
    sub ? el('div', { class: 'fx-hint' }, sub) : null
  );

  row.appendChild(card('Avg Historic Rate', avgHist != null ? formatMoney(avgHist, ccy, { maxFrac: 0 }) : '—', `${MONTHS[month1 - 1]}, all years · ${monthHist.length} night(s)`));
  row.appendChild(card('Suggested Avg', avgSugg != null ? formatMoney(avgSugg, ccy, { maxFrac: 0 }) : '—', 'open days this month'));
  row.appendChild(card('Booked Nights', String(booked), `of ${dim} · ${occ}% occupancy`, occ >= 70 ? 'success' : ''));
  row.appendChild(card('Open Nights', String(dim - booked), 'awaiting bookings', (dim - booked) > 0 ? 'warning' : ''));
}

// ── Calendar grid ───────────────────────────────────────────────────────────
function renderCalendar(card, { histMap, suggest, blocked, year, month1, ccy, minR, maxR }) {
  card.innerHTML = '';
  const mo  = String(month1).padStart(2, '0');
  const dim = daysInMonth(year, month1);
  const first = parseYMD(`${year}-${mo}-01`);
  const lead  = (first.getUTCDay() + 6) % 7; // Monday-first offset
  const tStr  = todayStr();

  const body = el('div', { style: 'padding:16px' });

  // Weekday header
  const head = el('div', { style: 'display:grid;grid-template-columns:repeat(7,1fr);gap:6px;margin-bottom:6px' });
  for (const w of WEEKDAYS) head.appendChild(el('div', { style: 'font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted);text-align:center' }, w));
  body.appendChild(head);

  const grid = el('div', { style: 'display:grid;grid-template-columns:repeat(7,1fr);gap:6px' });
  for (let i = 0; i < lead; i++) grid.appendChild(el('div', {}));

  for (let d = 1; d <= dim; d++) {
    const date = `${year}-${mo}-${String(d).padStart(2, '0')}`;
    const hist = histMap.get(date);
    const isBlocked = blocked.has(date);
    const isToday = date === tStr;

    let bg = 'transparent', border = '1px solid var(--border)', rateEl, badge = '';

    if (hist) {
      // Historic actual night — colour graded by price within the property's range.
      const t = maxR > minR ? (hist.rate - minR) / (maxR - minR) : 0.5;
      bg = `rgba(16,185,129,${(0.10 + 0.22 * t).toFixed(3)})`;
      border = '1px solid rgba(16,185,129,0.45)';
      rateEl = el('div', { style: 'font-size:13px;font-weight:700;color:var(--text)' }, formatMoney(hist.rate, hist.currency, { maxFrac: 0 }));
      badge = 'booked';
    } else if (isBlocked) {
      // Reserved/blocked via iCal — show suggested price but mark unavailable.
      bg = 'rgba(239,68,68,0.06)';
      border = '1px solid rgba(239,68,68,0.35)';
      const s = suggest(date);
      rateEl = el('div', { style: 'font-size:12px;font-style:italic;color:var(--text-muted)' }, s ? formatMoney(s.rate, ccy, { maxFrac: 0 }) : '—');
      badge = 'blocked';
    } else {
      // Open day — show the suggested rate (the recommended price).
      const s = suggest(date);
      rateEl = el('div', { style: 'font-size:12px;font-style:italic;color:var(--text-muted)' }, s ? formatMoney(s.rate, ccy, { maxFrac: 0 }) : '—');
      badge = s ? 'suggested' : '';
    }

    const cell = el('div', {
      style: `position:relative;min-height:66px;padding:6px;border-radius:6px;border:${border};background:${bg};cursor:pointer;` +
             (isToday ? 'box-shadow:0 0 0 2px var(--accent,#6366f1) inset;' : '')
    });
    cell.appendChild(el('div', { style: 'display:flex;justify-content:space-between;align-items:center' },
      el('span', { style: 'font-size:12px;font-weight:600;color:var(--text-muted)' }, String(d)),
      badge ? el('span', { style: `font-size:8px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:${badge === 'booked' ? '#10b981' : badge === 'blocked' ? '#ef4444' : 'var(--text-muted)'}` }, badge === 'suggested' ? 'sugg' : badge) : null
    ));
    cell.appendChild(el('div', { style: 'margin-top:8px;text-align:center' }, rateEl));
    cell.onclick = () => openDayDetail(date, { hist, isBlocked, suggest, ccy });
    grid.appendChild(cell);
  }

  body.appendChild(grid);

  // Legend
  const legend = el('div', { class: 'flex gap-8', style: 'flex-wrap:wrap;margin-top:14px;font-size:11px;color:var(--text-muted)' });
  const chip = (color, label) => el('span', { class: 'flex gap-4', style: 'align-items:center' },
    el('span', { style: `width:11px;height:11px;border-radius:3px;background:${color};display:inline-block` }),
    el('span', {}, label)
  );
  legend.appendChild(chip('rgba(16,185,129,0.30)', 'Booked (historic actual rate)'));
  legend.appendChild(chip('rgba(239,68,68,0.20)', 'Reserved / blocked (from iCal)'));
  legend.appendChild(chip('transparent', 'Open (suggested rate, italic)'));
  body.appendChild(legend);

  const calInfo = calendarFor(_propId);
  if (calInfo?.importedAt) {
    body.appendChild(el('div', { style: 'margin-top:8px;font-size:11px;color:var(--text-muted)' },
      `Calendar last imported ${fmtDate(calInfo.importedAt)} · ${(calInfo.blocks || []).length} reserved period(s).`));
  }

  card.appendChild(body);
}

// ── Day detail modal ──────────────────────────────────────────────────────────
function openDayDetail(date, { hist, isBlocked, suggest, ccy }) {
  const body = el('div', {});
  const row = (label, value) => el('div', { class: 'flex justify-between', style: 'padding:6px 0;border-bottom:1px solid var(--border);font-size:13px' },
    el('span', { class: 'muted' }, label), el('strong', {}, value));

  body.appendChild(el('div', { style: 'font-size:15px;font-weight:600;margin-bottom:10px' }, fmtDate(date)));

  if (hist) {
    body.appendChild(row('Status', 'Booked (historic)'));
    body.appendChild(row('Actual nightly rate', formatMoney(hist.rate, hist.currency, { maxFrac: 0 })));
    if (hist.label) body.appendChild(row('Guest', hist.label));
    if (hist.code)  body.appendChild(row('Confirmation', hist.code));
  } else {
    body.appendChild(row('Status', isBlocked ? 'Reserved / blocked (iCal)' : 'Open'));
    const s = suggest(date);
    if (s) {
      body.appendChild(row('Suggested rate', formatMoney(s.rate, ccy, { maxFrac: 0 })));
      body.appendChild(row('Based on', s.basis));
    } else {
      body.appendChild(el('div', { style: 'padding:8px 0;font-size:13px;color:var(--text-muted)' }, 'No historic data yet to suggest a rate.'));
    }
  }

  openModal({ title: 'Daily Rate', body, footer: [button('Close', { onClick: closeModal })] });
}

// ── Airbnb iCal import ─────────────────────────────────────────────────────────
function openImportModal(propertyId, onDone) {
  const prop = byId('properties', propertyId);
  const existing = calendarFor(propertyId);
  const body = el('div', {});

  body.appendChild(el('div', { style: 'font-size:13px;color:var(--text-muted);margin-bottom:10px' },
    'Paste the property’s Airbnb iCal export URL. Reserved and blocked dates will be overlaid on the calendar so you can see open vs. booked days. (Airbnb iCal carries availability only, not prices.)'));

  const urlI = input({ value: existing?.url || prop?.airbnbCalUrl || '', placeholder: 'https://www.airbnb.com/calendar/ical/....ics' });
  body.appendChild(formRow('Airbnb iCal URL', urlI));

  const status = el('div', { style: 'font-size:12px;color:var(--text-muted);min-height:18px;margin-top:6px' });
  body.appendChild(status);

  const importBtn = button('Import', { variant: 'primary', onClick: async () => {
    const url = urlI.value.trim();
    if (!url) { toast('Enter an iCal URL', 'warning'); return; }
    status.textContent = 'Fetching calendar…';
    try {
      const text = await fetchICal(url);
      const events = parseICal(text);
      const blocks = events
        .filter(e => e.start && e.end)
        .map(e => ({ start: e.start, end: e.end, uid: e.uid || '', summary: e.summary || '' }));
      const rec = existing
        ? { ...existing, url, blocks, importedAt: todayStr() }
        : { id: newId('stc'), propertyId, url, blocks, importedAt: todayStr() };
      upsert('strCalendars', rec);
      // Persist the URL on the property too, so it round-trips with the property record.
      if (prop && prop.airbnbCalUrl !== url) upsert('properties', { ...prop, airbnbCalUrl: url });
      toast(`Imported ${blocks.length} reserved period(s)`, 'success');
      closeModal();
      onDone?.();
    } catch (e) {
      status.textContent = '';
      toast(`iCal import failed: ${e.message}`, 'danger', 5000);
    }
  }});

  openModal({ title: 'Import Airbnb Calendar', body, footer: [button('Cancel', { onClick: closeModal }), importBtn] });
}
