// Minimal iCal parser for Airbnb VEVENT blocks
export function parseICal(text) {
  const events = [];
  const lines = text.replace(/\r/g, '').split('\n');
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
  let current = null;
  for (const line of unfolded) {
    if (line === 'BEGIN:VEVENT') current = {};
    else if (line === 'END:VEVENT') { if (current) events.push(current); current = null; }
    else if (current) {
      const [rawKey, ...rest] = line.split(':');
      const val = rest.join(':');
      const key = rawKey.split(';')[0];
      if (key === 'DTSTART') current.start = parseICalDate(val);
      else if (key === 'DTEND') current.end = parseICalDate(val);
      else if (key === 'SUMMARY') current.summary = val;
      else if (key === 'DESCRIPTION') current.description = val;
      else if (key === 'UID') current.uid = val;
    }
  }
  return events;
}

function parseICalDate(str) {
  if (!str) return null;
  if (/^\d{8}$/.test(str)) {
    return `${str.slice(0, 4)}-${str.slice(4, 6)}-${str.slice(6, 8)}`;
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(str);
  if (m) {
    const [, y, mo, d, h, mi, s, z] = m;
    if (z) {
      // Trailing "Z" marks a real UTC instant. Slicing the digits directly
      // (as below) reads the UTC calendar date, which is the WRONG local day
      // for any viewer whose offset carries the instant across midnight —
      // e.g. 20260810T220000Z (10pm UTC) is already Aug 11 for a UTC+3
      // viewer. Build the actual UTC instant and let the Date object convert
      // it to the viewer's local calendar date.
      const dt = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s));
      return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
    }
    // No "Z" — a "floating" local time with no timezone attached. This is
    // what Airbnb's own iCal exports actually use (see file/module comments
    // above), so there is no UTC instant to convert: reading the digits
    // straight off is already correct and must not be routed through
    // Date/UTC math, which would introduce a spurious shift for this,
    // the common, case. (A TZID parameter, if present, was already discarded
    // by the caller — see `rawKey.split(';')[0]` in parseICal — so it never
    // reaches this function; there is no usable timezone info to convert by.)
    return `${y}-${mo}-${d}`;
  }
  return str;
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
export function mergeBlocks(existingBlocks, freshBlocks, today) {
  const freshUids = new Set(freshBlocks.filter(b => b.uid).map(b => b.uid));
  const preserved = (existingBlocks || []).filter(b =>
    b.end && b.end <= today && !freshUids.has(b.uid)
  );
  return [...preserved, ...freshBlocks];
}

// Fetches an iCal URL (through a CORS proxy if needed). Airbnb blocks direct
// cross-origin browser requests, so the direct attempt is expected to fail —
// the browser will log that CORS block to the console regardless of this
// try/catch handling it, that's normal. Tries several proxies in turn (not
// just one) since public CORS proxies are individually unreliable — this
// mirrors the fallback chain .github/scripts/refresh-ical.js already uses for
// the scheduled sync, so the browser-side refresh is equally resilient.
export async function fetchICal(url) {
  try {
    const res = await fetch(url);
    if (res.ok) return await res.text();
  } catch (e) { /* CORS — expected, fall through to proxies */ }

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
        try { return JSON.parse(body).contents; } catch { continue; }
      }
      return body;
    } catch (e) { /* try the next proxy */ }
  }
  throw new Error('Failed to fetch iCal — direct request and all proxy fallbacks failed');
}
