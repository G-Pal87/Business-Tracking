// CSV reading/writing and import-value parsing shared by the exporters and
// the Airbnb CSV importer. Pure functions only (plus downloadCsv, which needs
// a DOM) so the parsers can be unit-tested under node.

// ── Writing ──────────────────────────────────────────────────────────────────

// A value that is really a number: finite JS numbers, or strings that are a
// plain decimal ("-12.50", "1234"). Those stay numeric in the spreadsheet;
// everything else is treated as text.
const PLAIN_NUMBER = /^[+-]?\d+(\.\d+)?$/;

// Text that a spreadsheet would treat as a formula (=, +, -, @) or that
// starts with a tab/CR (both used to smuggle formulas past naive checks).
const FORMULA_LEAD = /^[=+\-@\t\r]/;

// One RFC 4180 cell. Text cells that a spreadsheet would evaluate as a
// formula get a leading apostrophe ("CSV injection" / formula injection —
// a guest note like =HYPERLINK(...) would otherwise run when the file is
// opened in Excel or Sheets). Every cell is quoted, so commas, quotes and
// line breaks inside values are safe.
export function csvCell(v) {
  if (v == null) return '""';
  if (typeof v === 'number') return Number.isFinite(v) ? `"${v}"` : '""';
  let s = String(v);
  if (FORMULA_LEAD.test(s) && !PLAIN_NUMBER.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

// Rows (arrays of values) → CSV text, CRLF line endings, no BOM.
export function toCsv(rows) {
  return rows.map(r => r.map(csvCell).join(',')).join('\r\n');
}

// UTF-8 byte-order mark: without it Excel opens the file as the system's
// ANSI code page and shows € / ő / Greek as mojibake.
export const UTF8_BOM = '﻿';

// Triggers a download of `rows` as a UTF-8 CSV file. The object URL is
// revoked after a delay — revoking it synchronously after click() can cancel
// the download in Firefox and Safari.
export function downloadCsv(filename, rows) {
  const blob = new Blob([UTF8_BOM + toCsv(rows)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// ── Reading ──────────────────────────────────────────────────────────────────

// RFC 4180 parser: the whole text in one pass, splitting rows on newlines
// only outside quoted fields. Returns { rows, unterminatedQuote } —
// `unterminatedQuote` is the 1-based line where a quote was opened and never
// closed (that quote swallows the rest of the file, so callers should warn),
// or 0. Fields are trimmed.
export function parseCsvRows(text) {
  const clean = String(text || '').replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const rows = [];
  let field = '', row = [], inQuote = false, line = 1, quoteLine = 0;
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (c === '\n') line++;
    if (inQuote) {
      if (c === '"') { if (clean[i + 1] === '"') { field += '"'; i++; } else inQuote = false; }
      else field += c;
    } else if (c === '"') {
      inQuote = true; quoteLine = line;
    } else if (c === ',') {
      row.push(field.trim()); field = '';
    } else if (c === '\n') {
      row.push(field.trim()); rows.push(row); row = []; field = '';
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field.trim()); rows.push(row); }
  return { rows, unterminatedQuote: inQuote ? quoteLine : 0 };
}

// ── Amounts ──────────────────────────────────────────────────────────────────

// Parses an amount written in US (1,234.56), European (1.234,56 / 1234,56)
// or Hungarian (150.000 / 150 000) style. Returns a signed number (0 when
// there are no digits). A minus sign only counts before the first digit or
// after the last one ("-12", "€-12", "12-"), or when the whole value is in
// parentheses ("(12.34)") — a hyphen in the middle of the text no longer
// flips the sign. A Unicode minus (U+2212) counts as a minus.
export function parseAmountSigned(str) {
  const raw = String(str ?? '').trim();
  const first = raw.search(/\d/);
  if (first === -1) return 0;
  let last = first;
  for (let i = raw.length - 1; i >= first; i--) { if (/\d/.test(raw[i])) { last = i; break; } }
  const before = raw.slice(0, first);
  const after  = raw.slice(last + 1);
  const neg = /^\(.*\)$/.test(raw) || /[-−]/.test(before) || /[-−]/.test(after);

  // Digits and separators only; spaces (incl. no-break and thin spaces) and
  // apostrophes are thousands separators.
  let s = raw.slice(first, last + 1).replace(/[\s   ']/g, '').replace(/[^0-9.,]/g, '');
  const lastComma = s.lastIndexOf(',');
  const lastDot   = s.lastIndexOf('.');
  if (lastComma > -1 && lastDot > -1) {
    // Both present — whichever comes last is the decimal separator.
    s = lastComma > lastDot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (lastComma > -1) {
    // Comma only: a lone comma followed by 1-2 digits is a decimal separator
    // ("1234,56"); anything else is a thousands separator ("1,234").
    const parts = s.split(',');
    s = (parts.length === 2 && parts[1].length <= 2) ? s.replace(',', '.') : s.replace(/,/g, '');
  } else if (lastDot > -1 && /^\d{1,3}(\.\d{3})+$/.test(s)) {
    // Dot only, in 3-digit groups: thousands ("150.000" HUF = 150000, not 150).
    s = s.replace(/\./g, '');
  }
  const v = Math.abs(parseFloat(s) || 0);
  return neg && v ? -v : v;
}

// Amounts in a free-text line (PDF text / OCR). Returns [{ index, length,
// value }] in line order. First looks for amounts tied to a currency — €, £,
// $, Ft, HUF, EUR, USD, GBP, before or after the number — in US or EU
// formatting; when there are none, falls back to bare numbers with two
// decimals ("1,234.56", "1.234,56", "400.00"), ignoring values under 1.
const CUR_PRE  = String.raw`(?:[€£$]|\b(?:Ft|HUF|EUR|USD|GBP)\b\.?)`;
const CUR_POST = String.raw`(?:[€£$]|(?:Ft|HUF|EUR|USD|GBP)\b\.?)`;
const NUM      = String.raw`\d{1,3}(?:[.,  ]\d{3})+(?:[.,]\d{1,2})?(?!\d)|\d+(?:[.,]\d{1,2})?(?!\d)`;
const NUM_SP   = String.raw`\d{1,3}(?: \d{3})+(?![\d.,])`; // "150 000 Ft"
const RE_CURRENCY = new RegExp(
  String.raw`(?<![\d.,])(${NUM_SP})\s*(?:Ft|HUF)\b|` +
  String.raw`(?:Ft|HUF)\s*(${NUM_SP})(?![\d.,])|` +
  String.raw`${CUR_PRE}\s*-?\s*(${NUM})|` +
  String.raw`(?<![\d.,])(${NUM})\s*${CUR_POST}`,
  'g'
);
const RE_BARE = /(?<![.,\d])(\d{1,3}(?:,\d{3})+\.\d{2}|\d{1,3}(?:\.\d{3})+,\d{2}|\d+[.,]\d{2})(?![\d.,]*\d)/g;

export function findAmountsInText(line) {
  const out = [];
  const s = String(line || '');
  for (const m of s.matchAll(RE_CURRENCY)) {
    const num = m[1] || m[2] || m[3] || m[4];
    const value = Math.abs(parseAmountSigned(num));
    out.push({ index: m.index, length: m[0].length, value });
  }
  if (out.length) return out;
  for (const m of s.matchAll(RE_BARE)) {
    const value = Math.abs(parseAmountSigned(m[1]));
    if (value >= 1) out.push({ index: m.index, length: m[0].length, value });
  }
  return out;
}

// ── Dates ────────────────────────────────────────────────────────────────────

const pad2 = n => String(n).padStart(2, '0');
const SLASH_DATE = /^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/;

function validYmd(y, m, d) {
  if (!(y >= 1900 && y <= 2200) || !(m >= 1 && m <= 12) || !(d >= 1)) return null;
  const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (d > dim) return null;
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

// Decides the day/month order of a file's slash dates ("03/04/2026").
// Returns { dayFirst, ambiguous, conflicting }: any first field > 12 means
// DD/MM; any second field > 12 means MM/DD (Airbnb's US format, also the
// default when nothing decides it — `ambiguous` is then true). Both at once
// is `conflicting`: the file mixes formats, so no order is trustworthy.
export function detectDateOrder(values) {
  let firstBig = false, secondBig = false, any = false;
  for (const v of values) {
    const m = SLASH_DATE.exec(String(v || '').trim());
    if (!m) continue;
    any = true;
    if (+m[1] > 12) firstBig = true;
    if (+m[2] > 12) secondBig = true;
  }
  return {
    dayFirst: firstBig && !secondBig,
    ambiguous: any && !firstBig && !secondBig,
    conflicting: firstBig && secondBig
  };
}

// A date cell → 'YYYY-MM-DD', or null when it can't be read as a real
// calendar date (month 13, 31 April, garbage…). Slash/dot dates follow
// `dayFirst` (see detectDateOrder). The free-form fallback reads the local
// calendar date — toISOString() used to shift it a day back in UTC+ zones.
export function parseImportDate(raw, { dayFirst = false } = {}) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const sl = SLASH_DATE.exec(s);
  if (sl) {
    const a = +sl[1], b = +sl[2], y = +sl[3];
    return dayFirst ? validYmd(y, b, a) : validYmd(y, a, b);
  }
  const iso = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?!\d)/.exec(s);
  if (iso) return validYmd(+iso[1], +iso[2], +iso[3]);
  // Only attempt free-form text with a 4-digit year and a month name
  // ("Feb 13, 2026") — Date() happily turns "1" or "12-3" into some
  // arbitrary date.
  if (!/\d{4}/.test(s) || !/[a-z]/i.test(s)) return null;
  const d = new Date(s);
  if (isNaN(d)) return null;
  return validYmd(d.getFullYear(), d.getMonth() + 1, d.getDate());
}
