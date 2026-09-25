import { state } from './state.js';

// Minimal iCal parser for Airbnb VEVENT blocks.
//
// Tolerant of real-world feeds: property names are case-insensitive and
// trailing whitespace is ignored; only properties that belong directly to a
// VEVENT are read (a nested VALARM's DESCRIPTION no longer overwrites the
// event's); TEXT values are unescaped (\, \; \n \\); and an event whose
// DTSTART/DTEND can't be read as a real date is skipped rather than carried
// with a raw string that later loops compare against dates.
export function parseICal(text) {
  const events = [];
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  // Unfold continuation lines (RFC 5545)
  const unfolded = [];
  for (const l of lines) {
    if ((l.startsWith(' ') || l.startsWith('\t')) && unfolded.length > 0) {
      unfolded[unfolded.length - 1] += l.slice(1);
    } else {
      // Either a normal new line, or a continuation with nothing to fold
      // into (an invalid leading continuation per RFC 5545 — there's no
      // prior line yet). `unfolded[-1] += …` would silently write to a
      // non-index property, dropping the content; push it as its own entry
      // instead so it's at least preserved rather than lost.
      unfolded.push(l.startsWith(' ') || l.startsWith('\t') ? l.slice(1) : l);
    }
  }
  const stack = [];          // open component names, outermost first
  let current = null;        // the VEVENT being read
  let bad = false;           // current VEVENT has an unreadable date
  for (const rawLine of unfolded) {
    const line = rawLine.replace(/\s+$/, '');
    if (!line) continue;
    const { name, value } = splitContentLine(line);
    if (name === 'BEGIN') {
      const comp = value.trim().toUpperCase();
      stack.push(comp);
      if (comp === 'VEVENT' && stack.length <= 2) { current = {}; bad = false; }
      continue;
    }
    if (name === 'END') {
      const comp = value.trim().toUpperCase();
      const at = stack.lastIndexOf(comp);
      if (at !== -1) stack.length = at; // also closes anything left open inside it
      if (comp === 'VEVENT' && current) {
        if (!bad) events.push(current);
        current = null;
      }
      continue;
    }
    // Only properties that sit directly on the VEVENT (not on a nested
    // VALARM etc.).
    if (!current || stack[stack.length - 1] !== 'VEVENT') continue;
    if (name === 'DTSTART' || name === 'DTEND') {
      const d = parseICalDate(value);
      if (!d) { bad = true; continue; }
      if (name === 'DTSTART') current.start = d; else current.end = d;
    }
    else if (name === 'SUMMARY') current.summary = unescapeText(value);
    else if (name === 'DESCRIPTION') current.description = unescapeText(value);
    // UID is kept verbatim: it keys stored annotations, so it must not change
    // for feeds that were parsed before TEXT unescaping existed.
    else if (name === 'UID') current.uid = value.trim();
  }
  return events;
}

// "NAME;PARAM=x;PARAM2="a:b":value" → { name (upper-case), params, value }.
// The first colon outside a quoted parameter value ends the name/params part.
function splitContentLine(line) {
  let inQuote = false, i = 0;
  for (; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuote = !inQuote;
    else if (c === ':' && !inQuote) break;
  }
  const head = line.slice(0, i);
  const value = i < line.length ? line.slice(i + 1) : '';
  const [rawName, ...params] = head.split(';');
  return { name: rawName.trim().toUpperCase(), params, value };
}

// RFC 5545 TEXT unescaping: \\ → \, \; → ;, \, → ,, \n / \N → newline.
function unescapeText(v) {
  return String(v).replace(/\\([\\;,nN])/g, (_, c) => (c === 'n' || c === 'N') ? '\n' : c);
}

const pad2 = n => String(n).padStart(2, '0');
function validYmd(y, m, d) {
  if (!(y >= 1900 && y <= 2200) || !(m >= 1 && m <= 12) || !(d >= 1)) return null;
  if (d > new Date(Date.UTC(y, m, 0)).getUTCDate()) return null;
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

// iCal DATE / DATE-TIME → 'YYYY-MM-DD', or null when the value isn't a real
// date (e.g. "TBD" — returned raw before, it compared greater than every
// date string and made day-by-day loops run to the year 10000).
export function parseICalDate(input) {
  const str = String(input ?? '').trim().toUpperCase();
  if (!str) return null;
  const dm = /^(\d{4})(\d{2})(\d{2})$/.exec(str);
  if (dm) return validYmd(+dm[1], +dm[2], +dm[3]);
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(str);
  if (m) {
    const [, y, mo, d, h, mi, s, z] = m;
    if (!validYmd(+y, +mo, +d) || +h > 23 || +mi > 59 || +s > 60) return null;
    if (z) {
      // Trailing "Z" marks a real UTC instant. Slicing the digits directly
      // (as below) reads the UTC calendar date, which is the WRONG local day
      // for any viewer whose offset carries the instant across midnight —
      // e.g. 20260810T220000Z (10pm UTC) is already Aug 11 for a UTC+3
      // viewer. Build the actual UTC instant and let the Date object convert
      // it to the viewer's local calendar date.
      const dt = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s));
      return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
    }
    // No "Z" — a "floating" local time with no timezone attached. This is
    // what Airbnb's own iCal exports actually use, so there is no UTC
    // instant to convert: reading the digits straight off is already correct
    // and must not be routed through Date/UTC math, which would introduce a
    // spurious shift for this, the common, case. (A TZID parameter, if
    // present, is not used — there is no timezone database here to convert
    // by.)
    return `${y}-${mo}-${d}`;
  }
  return null;
}

// A complete iCal body: it opens AND closes the VCALENDAR. A body cut off
// part-way (a proxy truncating the response) still has BEGIN:VCALENDAR and
// parses to a plausible-looking prefix of the events — treating that as the
// whole feed dropped every booking after the cut.
export function isCompleteICal(body) {
  return typeof body === 'string' && /(^|\n)BEGIN:VCALENDAR/i.test(body) && /(^|\n)END:VCALENDAR\s*$/i.test(body);
}

export function nights(startStr, endStr) {
  if (!startStr || !endStr) return 0;
  const s = new Date(startStr); const e = new Date(endStr);
  return Math.max(0, Math.round((e - s) / (1000 * 60 * 60 * 24)));
}

// Classifies an iCal block by its SUMMARY: an owner-block (manually closed /
// unavailable, never sold) vs a guest reservation. Airbnb exports "Reserved"
// for bookings and "Airbnb (Not available)" for owner-blocks/other-listing
// availability syncs — only the latter should ever be expected to have no
// matching payment.
export function isOwnerBlockSummary(summary) {
  return /not available|unavailable|\bblocked\b|\bclosed\b/i.test(summary || '');
}

// Merge freshly-fetched blocks with the previous snapshot so blocks that have
// already elapsed and dropped off Airbnb's live iCal feed aren't lost. Airbnb's
// feed only reflects current/future state — once a booking or owner-block is in
// the past, Airbnb can prune it from the feed entirely. Future/current blocks
// always defer to the fresh feed (so cancellations there are still reflected);
// only already-elapsed blocks that vanished from the feed get carried forward.
//
// Safety nets — both keep the existing blocks unchanged and report why in
// `refused`, since each is far more likely a bad fetch (proxy error page,
// truncated body) than real cancellations:
//   - a fresh feed with zero events while the stored snapshot still has
//     current/future blocks;
//   - the number of current/future blocks dropping sharply: fewer than half
//     of the stored ones, when at least 3 are stored. Pass
//     `{ allowSharpDrop: true }` (e.g. a refresh the user asked for) to
//     accept such a drop anyway; the empty-feed rule always applies.
export function mergeBlocksChecked(existingBlocks, freshBlocks, today, { allowSharpDrop = false } = {}) {
  const existing = existingBlocks || [];
  const fresh = freshBlocks || [];
  const isFuture = b => b.end && b.end > today;
  const existingFuture = existing.filter(isFuture).length;
  if (fresh.length === 0 && existingFuture > 0) {
    return { blocks: existing, refused: `The calendar feed returned no bookings while ${existingFuture} upcoming block(s) are stored — kept the stored calendar.` };
  }
  const freshFuture = fresh.filter(isFuture).length;
  if (!allowSharpDrop && existingFuture >= 3 && freshFuture * 2 < existingFuture) {
    return { blocks: existing, refused: `The calendar feed has ${freshFuture} upcoming block(s) but ${existingFuture} are stored — this looks like an incomplete response, so the stored calendar was kept.` };
  }
  const freshUids = new Set(fresh.filter(b => b.uid).map(b => b.uid));
  // Also dedupe on the date range: Airbnb can re-issue a UID for the same
  // stay, which used to carry the old copy forward next to the new one.
  const seenRanges = new Set(fresh.map(b => `${b.start}|${b.end}`));
  const seenUids = new Set(freshUids);
  const preserved = [];
  for (const b of existing) {
    if (!b.end || b.end > today) continue;
    const range = `${b.start}|${b.end}`;
    if ((b.uid && seenUids.has(b.uid)) || seenRanges.has(range)) continue;
    if (b.uid) seenUids.add(b.uid);
    seenRanges.add(range);
    preserved.push(b);
  }
  return { blocks: [...preserved, ...fresh], refused: null };
}

// Same as mergeBlocksChecked, returning just the blocks (the existing ones,
// unchanged, when the merge was refused).
export function mergeBlocks(existingBlocks, freshBlocks, today, opts) {
  const { blocks, refused } = mergeBlocksChecked(existingBlocks, freshBlocks, today, opts);
  if (refused && typeof console !== 'undefined') console.warn(`[ical] ${refused}`);
  return blocks;
}

// A real iCal body. CORS proxies can answer 200 with an HTML error page or
// a JSON error; treating that as the feed parsed to zero events and wiped
// every future booking on save. A body without END:VCALENDAR was cut off.
function looksLikeICal(body) {
  return isCompleteICal(body);
}

// Fetches an iCal URL. Airbnb blocks direct cross-origin browser requests,
// so the direct attempt is expected to fail (the browser logs that CORS block
// regardless of this try/catch — that's normal). Airbnb calendar links carry
// an access token, so:
//   - with a private proxy configured (Settings → STR / Airbnb, see
//     docs/ical-proxy.md) the link is sent ONLY there, in a POST body;
//   - otherwise the public CORS proxies are tried in turn — unless that is
//     switched off, in which case this fails with a clear message.
export async function fetchICal(url) {
  try {
    const res = await fetch(url);
    if (res.ok) {
      const body = await res.text();
      if (looksLikeICal(body)) return body;
    }
  } catch (e) { /* CORS — expected, fall through to proxies */ }

  const af = state.db?.settings?.airbnb || {};
  if (af.icalProxyUrl) {
    const res = await fetch(af.icalProxyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });
    if (!res.ok) throw new Error(`Calendar proxy returned ${res.status} — check the proxy URL in Settings → STR / Airbnb`);
    const body = await res.text();
    if (!looksLikeICal(body)) throw new Error('Calendar proxy did not return a calendar');
    return body;
  }
  if (af.allowPublicIcalProxies === false) {
    throw new Error('Calendar could not be fetched: public proxies are switched off and no own proxy is set (Settings → STR / Airbnb).');
  }

  const proxies = [
    `https://corsproxy.io/?${encodeURIComponent(url)}`,
    `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`,
    `https://cors.eu.org/${url}`,
  ];
  for (const proxyUrl of proxies) {
    try {
      const res = await fetch(proxyUrl);
      if (!res.ok) continue;
      const body = await res.text();
      // allorigins.win wraps the response in { contents: "…" }
      if (proxyUrl.includes('allorigins')) {
        let contents;
        try { contents = JSON.parse(body).contents; } catch { continue; }
        if (looksLikeICal(contents)) return contents;
        continue;
      }
      if (looksLikeICal(body)) return body;
      // Not a calendar (error page etc.) — try the next proxy.
    } catch (e) { /* try the next proxy */ }
  }
  throw new Error('Failed to fetch iCal — direct request and all proxy fallbacks failed');
}
