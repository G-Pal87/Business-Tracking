// Minimal iCal parser for Airbnb VEVENT blocks
export function parseICal(text) {
  const events = [];
  const lines = text.replace(/\r/g, '').split('\n');
  // Unfold continuation lines (RFC 5545)
  const unfolded = [];
  for (const l of lines) {
    if (l.startsWith(' ') || l.startsWith('\t')) {
      unfolded[unfolded.length - 1] += l.slice(1);
    } else {
      unfolded.push(l);
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
  if (/^\d{8}T\d{6}Z?$/.test(str)) {
    return `${str.slice(0, 4)}-${str.slice(4, 6)}-${str.slice(6, 8)}`;
  }
  return str;
}

export function nights(startStr, endStr) {
  if (!startStr || !endStr) return 0;
  const s = new Date(startStr); const e = new Date(endStr);
  return Math.max(0, Math.round((e - s) / (1000 * 60 * 60 * 24)));
}

// Fetches an iCal URL (through a CORS proxy if needed)
export async function fetchICal(url) {
  // Direct fetch attempt first
  try {
    const res = await fetch(url);
    if (res.ok) return await res.text();
  } catch (e) { /* CORS */ }
  // Fallback to public CORS proxy
  const proxied = `https://corsproxy.io/?${encodeURIComponent(url)}`;
  const res = await fetch(proxied);
  if (!res.ok) throw new Error('Failed to fetch iCal (CORS)');
  return await res.text();
}
