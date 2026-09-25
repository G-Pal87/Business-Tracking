// Timezone-safe calendar-date helpers for 'YYYY-MM-DD' strings.
//
// Two patterns caused recurring off-by-one-day bugs across the app for a
// positive-UTC-offset viewer (Cyprus/Hungary, UTC+1..+3):
//   - new Date('YYYY-MM-DD') parses as UTC midnight, then local-time setters
//     (setDate/setMonth) shift across DST boundaries;
//   - date.toISOString().slice(0,10) reads the UTC calendar date, which for
//     the first hours after local midnight is still "yesterday".
// Everything here does pure calendar arithmetic in UTC on Y/M/D integers, so
// the result never depends on the viewer's timezone or DST.

const pad = n => String(n).padStart(2, '0');

// Local calendar date of a Date object (defaults to now) as 'YYYY-MM-DD'.
export function localYmd(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Today's local calendar date.
export function todayYmd() { return localYmd(new Date()); }

// Current local 'YYYY-MM'.
export function thisMonthYm() { return todayYmd().slice(0, 7); }

// 'YYYY-MM-DD' (or longer ISO string) → Date at UTC midnight of that calendar day.
export function parseYmd(s) {
  const [y, m, d] = String(s).slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, (m || 1) - 1, d || 1));
}

// Date at UTC midnight → 'YYYY-MM-DD'.
export function utcYmd(d) {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function isYmd(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}/.test(s); }

export function daysInMonth(year, month1) {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

export function addDaysYmd(s, n) {
  const d = parseYmd(s);
  d.setUTCDate(d.getUTCDate() + n);
  return utcYmd(d);
}

// Adds whole months, clamping the day to the target month's length
// (Jan 31 + 1 month → Feb 28/29, never Mar 3). `anchorDay` lets a repeating
// series keep its original day-of-month (31 → Feb 28 → Mar 31) instead of
// drifting down permanently after the first short month.
export function addMonthsYmd(s, n, anchorDay = null) {
  const [y, m, d] = String(s).slice(0, 10).split('-').map(Number);
  const total = (y * 12 + (m - 1)) + n;
  const ny = Math.floor(total / 12);
  const nm = total - ny * 12 + 1;
  const day = Math.min(anchorDay ?? d, daysInMonth(ny, nm));
  return `${ny}-${pad(nm)}-${pad(day)}`;
}

export function addYearsYmd(s, n) {
  return addMonthsYmd(s, n * 12);
}

// Whole days from a to b (b - a), both 'YYYY-MM-DD'.
export function diffDaysYmd(a, b) {
  return Math.round((parseYmd(b) - parseYmd(a)) / 86400000);
}

// Parse any date-ish value to a local-calendar 'YYYY-MM-DD' (e.g. a date
// parsed from free text like "5 January 2026"). A bare 'YYYY-MM-DD' is
// returned unchanged; a Date uses its local calendar fields.
export function toLocalYmd(v) {
  if (!v) return '';
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const d = v instanceof Date ? v : new Date(v);
  if (isNaN(d)) return '';
  return localYmd(d);
}
