// Invoice PDF generator using jsPDF — supports multiple templates
import { byId, formatMoney } from './data.js';
import { state } from './state.js';
import { fmtDate, toast } from './ui.js';
import { loadLib } from './libs.js';

export const PDF_TEMPLATES = [
  { value: 'standard',  label: 'Standard',      description: 'Clean two-column header, light table' },
  { value: 'luxury',    label: 'Luxury',         description: 'Parchment background, gold accents, serif typography' },
  { value: 'corporate', label: 'Corporate Navy', description: 'Bold navy header band, formal layout' },
  { value: 'minimal',   label: 'Minimal',        description: 'Ultra-clean, accent stripe, lots of whitespace' },
];

// ── Font loader (fetch from repo, cache in memory) ────────────────────────────
const _fontCache = {};

function arrayBufToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(binary);
}

// Only fetches + caches the font bytes — does NOT register them with `doc`.
// Registration (addFileToVFS/addFont) happens separately in a fixed order in
// loadAllFonts, because jsPDF assigns each font's internal PDF resource
// number (/F1, /F2, ...) in first-registered order. Registering while fonts
// are still resolving concurrently (the old Promise.all approach) let the
// network's completion order — inherently nondeterministic — decide resource
// numbering, so re-generating byte-identical invoice content produced a
// different (though equally valid) PDF on every cold-cache run. Content
// hashing (e.g. to skip a no-op re-upload) needs the same input to always
// produce the same output, so fetch can stay concurrent but registration order
// must not depend on it.
async function fetchFont(filename, family, style) {
  const cacheKey = `${family}:${style}`;
  if (!_fontCache[cacheKey]) {
    const base = window.location.origin + window.location.pathname.replace(/\/[^/]*$/, '');
    const url  = `${base}/assets/fonts/${filename}`;
    const res  = await fetch(url);
    if (!res.ok) throw new Error(`Font fetch failed: ${filename} (${res.status})`);
    _fontCache[cacheKey] = arrayBufToBase64(await res.arrayBuffer());
  }
}

const FONT_SPECS = [
  ['CormorantGaramond-Light.ttf',       'Cormorant',     'normal'],
  ['CormorantGaramond-LightItalic.ttf', 'Cormorant',     'italic'],
  ['CormorantGaramond-Regular.ttf',     'CormorantReg',  'normal'],
  ['CormorantGaramond-SemiBold.ttf',    'CormorantBold', 'normal'],
  ['DMSans-Regular.ttf',                'DMSans',        'normal'],
  ['DMSans-Medium.ttf',                 'DMSans',        'bold'],
  ['Gelasio-Regular.ttf',               'Georgia',       'normal'],
  ['Gelasio-Italic.ttf',                'Georgia',       'italic'],
  ['Gelasio-BoldItalic.ttf',            'Georgia',       'bolditalic'],
];

// Glyph fallback for text the template fonts can't show — none of DM Sans,
// Cormorant or Gelasio has Greek, and jsPDF silently drops everything from
// the first missing glyph to the end of the string. Optional: when the files
// aren't deployed, text is drawn as before and a warning is shown.
// Noto Sans (SIL Open Font License 1.1) covers Latin, Greek and Cyrillic.
const FALLBACK_FAMILY = 'NotoSans';
const FALLBACK_SPECS = [
  ['NotoSans-Regular.ttf',    FALLBACK_FAMILY, 'normal'],
  ['NotoSans-Bold.ttf',       FALLBACK_FAMILY, 'bold'],
  ['NotoSans-Italic.ttf',     FALLBACK_FAMILY, 'italic'],
  ['NotoSans-BoldItalic.ttf', FALLBACK_FAMILY, 'bolditalic'],
];

// Fallback files that aren't deployed (404) — not re-requested on every PDF.
const _fallbackMissing = new Set();

// Fetches every font (concurrently), then registers the template fonts that
// loaded in the fixed FONT_SPECS order (see fetchFont for why order
// matters). A font that fails to load no longer aborts the whole PDF: the
// template's family falls back to the built-in Helvetica (installFontGuards)
// and the caller gets a warning. The fallback fonts are only fetched here;
// they are registered on first use (jsPDF embeds every registered font, so
// registering them up front would bloat every Latin-only invoice).
async function loadAllFonts(doc) {
  if (doc.__fontsLoaded) return;
  doc.__fontsLoaded = true;
  const fallbackWanted = FALLBACK_SPECS.filter(([filename]) => !_fallbackMissing.has(filename));
  const [coreResults, fbResults] = await Promise.all([
    Promise.allSettled(FONT_SPECS.map(([filename, family, style]) => fetchFont(filename, family, style))),
    Promise.allSettled(fallbackWanted.map(([filename, family, style]) => fetchFont(filename, family, style))),
  ]);
  fbResults.forEach((r, i) => { if (r.status !== 'fulfilled') _fallbackMissing.add(fallbackWanted[i][0]); });
  const missing = [];
  FONT_SPECS.forEach(([filename, family, style], i) => {
    const b64 = _fontCache[`${family}:${style}`];
    if (coreResults[i].status !== 'fulfilled' || !b64) { missing.push(filename); return; }
    try {
      doc.addFileToVFS(filename, b64);
      doc.addFont(filename, family, style);
    } catch (e) {
      missing.push(filename);
    }
  });
  if (missing.length) {
    pdfWarn(doc, `Some invoice fonts could not be loaded (${missing.join(', ')}) — the PDF uses Helvetica for that text instead.`);
  }
  installFontGuards(doc);
}

// Registers the fetched fallback fonts with `doc` (once). Returns whether
// at least one style is available.
function registerFallbackFonts(doc) {
  if (doc.__fallbackRegistered === undefined) {
    doc.__fallbackRegistered = false;
    for (const [filename, family, style] of FALLBACK_SPECS) {
      const b64 = _fontCache[`${family}:${style}`];
      if (!b64) continue;
      try {
        doc.addFileToVFS(filename, b64);
        doc.addFont(filename, family, style);
        doc.__fallbackRegistered = true;
      } catch (e) { /* unusable file — treat as missing */ }
    }
  }
  return doc.__fallbackRegistered;
}

function pdfWarn(doc, msg) {
  doc.__pdfWarnings = doc.__pdfWarnings || [];
  if (!doc.__pdfWarnings.includes(msg)) doc.__pdfWarnings.push(msg);
}

function hasFont(doc, family, style) {
  const list = doc.getFontList();
  return !!(list[family] && list[family].includes(style));
}

// Built-in Helvetica style closest to a template font/style.
function helveticaStyle(family, style) {
  if (style === 'bolditalic') return 'bolditalic';
  if (style === 'bold' || family === 'CormorantBold') return 'bold';
  if (style === 'italic') return 'italic';
  return 'normal';
}

// Characters the built-in (WinAnsi-encoded) standard fonts can draw.
const WIN_ANSI_EXTRA = new Set([0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x017d,
  0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x017e, 0x0178]);

// True when the current font has no glyph for some character of `str`.
function fontLacksGlyphs(font, str) {
  const s = String(str ?? '');
  const meta = font && font.metadata;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code < 0x20 || code === 0x20 || code === 0xa0) continue;
    if (meta && typeof meta.characterToGlyph === 'function') {
      if (!meta.characterToGlyph(code)) return true;
    } else if (code > 0xff && !WIN_ANSI_EXTRA.has(code)) {
      return true;
    }
  }
  return false;
}

// Wraps setFont / text / splitTextToSize / getTextWidth on this document:
//   - setFont with a family that failed to load resolves to Helvetica;
//   - text the current font can't draw (e.g. Greek) is measured and drawn
//     with the Noto Sans fallback in the matching style, when available.
function installFontGuards(doc) {
  const origSetFont = doc.setFont.bind(doc);
  doc.setFont = (family, style = 'normal', weight) => {
    if (!hasFont(doc, family, style)) {
      const lc = String(family || '').toLowerCase();
      if (!['helvetica', 'times', 'courier'].includes(lc)) return origSetFont('helvetica', helveticaStyle(family, style));
    }
    return weight !== undefined ? origSetFont(family, style, weight) : origSetFont(family, style);
  };

  const withFallback = (text, fn) => {
    const cur = doc.getFont();
    const parts = Array.isArray(text) ? text : [text];
    if (!parts.some(t => fontLacksGlyphs(cur, t))) return fn();
    if (!registerFallbackFonts(doc)) {
      pdfWarn(doc, 'This invoice has characters (e.g. Greek) that the invoice fonts can\'t show, and the fallback font (assets/fonts/NotoSans-*.ttf) isn\'t available — some text may be missing from the PDF.');
      return fn();
    }
    let style = helveticaStyle(cur.fontName, cur.fontStyle);
    if (!hasFont(doc, FALLBACK_FAMILY, style)) style = 'normal';
    if (!hasFont(doc, FALLBACK_FAMILY, style)) style = FALLBACK_SPECS.find(([, fam, st]) => hasFont(doc, fam, st))[2];
    origSetFont(FALLBACK_FAMILY, style);
    try { return fn(); } finally { origSetFont(cur.fontName, cur.fontStyle); }
  };

  const origText = doc.text.bind(doc);
  doc.text = (text, ...rest) => withFallback(text, () => origText(text, ...rest));
  const origSplit = doc.splitTextToSize.bind(doc);
  doc.splitTextToSize = (text, ...rest) => withFallback(text, () => origSplit(text, ...rest));
  const origWidth = doc.getTextWidth.bind(doc);
  doc.getTextWidth = (text) => withFallback(text, () => origWidth(text));
}

// Wraps `text` to `width` with the current font and returns the lines
// (always at least one, possibly '').
function wrap(doc, text, width) {
  const lines = doc.splitTextToSize(String(text ?? ''), width);
  return lines.length ? lines : [''];
}

// Every line of `lines`, each wrapped to `width`.
function wrapAll(doc, lines, width) {
  return lines.flatMap(l => wrap(doc, l, width));
}

// Largest font size (from `size` down to `min`) at which `text` fits on one
// line of `width`; sets it on doc and returns the (possibly truncated) text.
function fitOneLine(doc, text, width, size, min) {
  const s = String(text ?? '');
  let fs = size;
  doc.setFontSize(fs);
  while (fs > min && doc.getTextWidth(s) > width) { fs -= 1; doc.setFontSize(fs); }
  if (doc.getTextWidth(s) <= width) return s;
  let t = s;
  while (t.length > 1 && doc.getTextWidth(`${t}…`) > width) t = t.slice(0, -1);
  return `${t.trimEnd()}…`;
}


function bizLines(biz) {
  return [
    biz.address,
    biz.registrationNumber ? `Reg: ${biz.registrationNumber}` : '',
    biz.vatNumber          ? `VAT: ${biz.vatNumber}`          : '',
    biz.iban               ? `IBAN: ${biz.iban}`              : '',
    biz.bic                ? `BIC: ${biz.bic}`                : '',
    biz.swift && biz.swift !== biz.bic ? `SWIFT: ${biz.swift}` : '',
  ].filter(Boolean);
}

function clientLines(client) {
  return [
    client.address,
    client.email,
    client.vatNumber          ? `VAT: ${client.vatNumber}`          : '',
    client.registrationNumber ? `Reg: ${client.registrationNumber}` : '',
  ].filter(Boolean);
}

// ── Shared line-items + totals renderer ──────────────────────────────────────
// Returns the final y position after rendering.
function renderLineItems(doc, invoice, startY, margin, pageH) {
  const rowH      = 24;
  const C_DESC_X  = margin + 8;
  const C_DESC_W  = 245;
  const C_QTY_X   = 370;
  const C_RATE_X  = 460;
  const C_AMT_X   = 548;
  const tableW    = C_AMT_X - margin;

  const drawHeader = (hy) => {
    doc.setFillColor(243, 244, 246);
    doc.rect(margin, hy, tableW, rowH, 'F');
    doc.setFontSize(9);
    doc.setTextColor(80);
    doc.setFont('DMSans', 'bold');
    doc.text('DESCRIPTION', C_DESC_X,  hy + 16);
    doc.text('QTY',         C_QTY_X,   hy + 16, { align: 'right' });
    doc.text('RATE',        C_RATE_X,  hy + 16, { align: 'right' });
    doc.text('AMOUNT',      C_AMT_X,   hy + 16, { align: 'right' });
    doc.setFont('DMSans', 'normal');
    doc.setTextColor(0);
    doc.setDrawColor(180);
    doc.setLineWidth(0.5);
    doc.line(margin, hy + rowH, C_AMT_X, hy + rowH);
    doc.setFontSize(10);
    return hy + rowH;
  };
  let y = drawHeader(startY);

  // QTY is right-aligned at C_QTY_X; the space left of it after the
  // description column is its width ("12 nights" or a long unit wraps).
  const C_QTY_W = C_QTY_X - (C_DESC_X + C_DESC_W) - 6;
  for (const li of invoice.lineItems || []) {
    const descLines = doc.splitTextToSize(li.description || '', C_DESC_W);
    const qtyLines  = wrap(doc, `${li.quantity} ${li.unit || ''}`.trim(), C_QTY_W);
    const itemH = Math.max(rowH, Math.max(descLines.length, qtyLines.length) * 14 + 8);
    if (y + itemH > pageH - 80) { doc.addPage(); y = drawHeader(margin); }
    const midY = y + 16;
    doc.text(descLines,                                             C_DESC_X, midY);
    doc.text(qtyLines,                                              C_QTY_X,  midY, { align: 'right' });
    doc.text(formatMoney(li.rate,  invoice.currency),              C_RATE_X, midY, { align: 'right' });
    doc.text(formatMoney(li.total, invoice.currency),              C_AMT_X,  midY, { align: 'right' });
    y += itemH;
    doc.setDrawColor(230);
    doc.line(margin, y, C_AMT_X, y);
  }

  y += 20;

  // Keep the totals block (~70pt) together and on the page — it used to be
  // drawn past the bottom edge when the last line item ended near it.
  if (y + 70 > pageH - 60) { doc.addPage(); y = margin + 20; }

  // Totals
  doc.setFontSize(10);
  doc.setTextColor(0);
  doc.text('Subtotal', C_RATE_X, y, { align: 'right' });
  doc.text(formatMoney(invoice.subtotal, invoice.currency), C_AMT_X, y, { align: 'right' });
  y += 18;
  doc.text(`Tax (${invoice.taxRate || 0}%)`, C_RATE_X, y, { align: 'right' });
  doc.text(formatMoney(invoice.tax || 0, invoice.currency), C_AMT_X, y, { align: 'right' });
  y += 18;
  doc.setLineWidth(1.5);
  doc.setDrawColor(0);
  doc.line(C_RATE_X - 80, y, C_AMT_X, y);
  y += 16;
  doc.setFontSize(13);
  doc.setFont('DMSans', 'bold');
  doc.text('TOTAL', C_RATE_X, y, { align: 'right' });
  doc.text(formatMoney(invoice.total, invoice.currency), C_AMT_X, y, { align: 'right' });
  doc.setFont('DMSans', 'normal');

  return y;
}

function renderNotes(doc, invoice, y, margin) {
  if (!invoice.notes) return y;
  // Page-break aware: long notes used to run off the bottom of the page.
  // Bottom limit leaves room for the Corporate template's footer band (820pt).
  const limit = doc.internal.pageSize.getHeight() - 60;
  doc.setFontSize(9);
  const lines = doc.splitTextToSize(invoice.notes, 500);
  const lineH = doc.getFontSize() * (typeof doc.getLineHeightFactor === 'function' ? doc.getLineHeightFactor() : 1.15);
  y += 28;
  // Heading + at least the first line must fit, else start on a new page.
  if (y + 14 + lineH > limit) { doc.addPage(); y = margin; }
  doc.setTextColor(120);
  doc.text('NOTES', margin, y);
  doc.setTextColor(0);
  y += 14;
  doc.setFontSize(9);
  if (y + (lines.length - 1) * lineH <= limit) {
    // Fits — single call, same output as before.
    doc.text(lines, margin, y);
    return y + (lines.length - 1) * lineH;
  }
  for (const line of lines) {
    if (y > limit) { doc.addPage(); y = margin; }
    doc.text(line, margin, y);
    y += lineH;
  }
  return y - lineH;
}

// ── Template: Standard ────────────────────────────────────────────────────────
async function renderStandard(doc, invoice) {
  await loadAllFonts(doc);
  const client = byId('clients', invoice.clientId) || {};
  const biz    = state.db.settings?.business || {};
  const team   = (state.db.settings?.team || []).find(t => t.id === invoice.owner);
  const ownerName = team?.name || (invoice.owner === 'rita' ? 'Rita' : invoice.owner === 'you' ? 'Owner' : 'Team');

  const margin = 48;
  const rightX = 320;
  let y  = margin;
  let ry = margin;

  doc.setFontSize(28);
  doc.setFont('DMSans', 'bold');
  doc.text('INVOICE', margin, y);
  y += 20;
  doc.setFontSize(11);
  // Left column ends before the invoice-number column at rightX.
  const leftW = rightX - margin - 12;
  wrap(doc, biz.name || ownerName, leftW).forEach(line => { doc.text(line, margin, y); y += 14; });
  y += 2;
  doc.setFont('DMSans', 'normal');
  doc.setFontSize(9);
  wrapAll(doc, bizLines(biz), leftW).forEach(line => { doc.text(line, margin, y); y += 12; });

  doc.setFontSize(9);
  doc.setTextColor(120);
  doc.text('Invoice No', rightX, ry);
  doc.setTextColor(0);
  doc.setFontSize(14);
  doc.setFont('DMSans', 'bold');
  doc.text(String(invoice.number || ''), rightX, ry + 15);
  ry += 32;

  doc.setFont('DMSans', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(120);
  doc.text('Issued', rightX, ry);
  doc.setTextColor(0);
  doc.text(fmtDate(invoice.issueDate), rightX, ry + 12);
  ry += 24;
  doc.setTextColor(120);
  doc.text('Due', rightX, ry);
  doc.setTextColor(0);
  doc.text(fmtDate(invoice.dueDate), rightX, ry + 12);
  doc.setTextColor(0);

  y = Math.max(y, ry) + 20;
  doc.setDrawColor(200);
  doc.setLineWidth(0.5);
  doc.line(margin, y, 548, y);
  y += 16;

  doc.setFontSize(9);
  doc.setTextColor(120);
  doc.text('BILL TO', margin, y);
  doc.setTextColor(0);
  y += 14;
  doc.setFontSize(11);
  doc.setFont('DMSans', 'bold');
  wrap(doc, client.name || '', 548 - margin).forEach(line => { doc.text(line, margin, y); y += 14; });
  doc.setFont('DMSans', 'normal');
  doc.setFontSize(9);
  wrapAll(doc, clientLines(client), 548 - margin).forEach(line => { doc.text(line, margin, y); y += 12; });
  y += 24;

  y = renderLineItems(doc, invoice, y, margin, 841);
  y = renderNotes(doc, invoice, y, margin);
}

// ── Template: Corporate Navy ──────────────────────────────────────────────────
async function renderCorporate(doc, invoice) {
  await loadAllFonts(doc);
  const client = byId('clients', invoice.clientId) || {};
  const biz    = state.db.settings?.business || {};
  const team   = (state.db.settings?.team || []).find(t => t.id === invoice.owner);
  const ownerName = team?.name || (invoice.owner === 'rita' ? 'Rita' : invoice.owner === 'you' ? 'Owner' : 'Team');

  const W       = 595;
  const margin  = 48;
  const NAV_R   = 15;
  const NAV_G   = 45;
  const NAV_B   = 96;  // #0f2d60
  const ACC_R   = 212;
  const ACC_G   = 163;
  const ACC_B   = 57;  // #d4a339 gold accent

  // ── Full-width navy header band ────────────────────────────────────────────
  const hdrH = 84;
  doc.setFillColor(NAV_R, NAV_G, NAV_B);
  doc.rect(0, 0, W, hdrH, 'F');

  // Company name left in white
  // The band's left side stops short of the right-aligned "INVOICE" title.
  // Only two business lines fit in the band; every line (IBAN/BIC included)
  // is printed in full in the FROM column below.
  const hdrLeftW = W - margin * 2 - 190;
  doc.setFont('DMSans', 'bold');
  doc.setTextColor(255, 255, 255);
  doc.text(fitOneLine(doc, biz.name || ownerName, hdrLeftW, 20, 12), margin, 34);
  doc.setFont('DMSans', 'normal');
  doc.setTextColor(200, 210, 230);
  const bl = bizLines(biz);
  bl.slice(0, 2).forEach((line, i) => doc.text(fitOneLine(doc, line, hdrLeftW, 9, 7), margin, 50 + i * 13));
  doc.setFontSize(9);

  // "INVOICE" right in white
  doc.setFontSize(30);
  doc.setFont('DMSans', 'bold');
  doc.setTextColor(255, 255, 255);
  doc.text('INVOICE', W - margin, 36, { align: 'right' });
  // Invoice number in gold accent
  doc.setFontSize(11);
  doc.setFont('DMSans', 'normal');
  doc.setTextColor(ACC_R, ACC_G, ACC_B);
  doc.text(`No. ${invoice.number || 'DRAFT'}`, W - margin, 54, { align: 'right' });
  doc.setTextColor(200, 210, 230);
  doc.setFontSize(9);
  doc.text(`Issued: ${fmtDate(invoice.issueDate)}  •  Due: ${fmtDate(invoice.dueDate)}`, W - margin, 70, { align: 'right' });

  doc.setTextColor(0);
  doc.setFont('DMSans', 'normal');

  // ── Gold accent stripe below header ───────────────────────────────────────
  doc.setFillColor(ACC_R, ACC_G, ACC_B);
  doc.rect(0, hdrH, W, 3, 'F');

  let y = hdrH + 24;

  // ── Two-column: From / Bill To ─────────────────────────────────────────────
  const colW = 220;
  const col2X = W - margin - colW;

  doc.setFontSize(8);
  doc.setTextColor(120);
  doc.setFont('DMSans', 'bold');
  doc.text('FROM', margin, y);
  doc.text('BILL TO', col2X, y);
  y += 14;

  doc.setFont('DMSans', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(0);
  const fromName = wrap(doc, biz.name || ownerName, colW);
  const toName   = wrap(doc, client.name || '', colW);
  const nameRows = Math.max(fromName.length, toName.length);
  for (let i = 0; i < nameRows; i++) {
    if (fromName[i]) doc.text(fromName[i], margin, y);
    if (toName[i])   doc.text(toName[i],   col2X, y);
    y += 14;
  }

  doc.setFont('DMSans', 'normal');
  doc.setFontSize(9);
  const bl2 = wrapAll(doc, bizLines(biz), colW);
  const cl  = wrapAll(doc, clientLines(client), colW);
  const maxRows = Math.max(bl2.length, cl.length);
  for (let i = 0; i < maxRows; i++) {
    if (bl2[i]) doc.text(bl2[i], margin,  y);
    if (cl[i])  doc.text(cl[i],  col2X, y);
    y += 12;
  }
  y += 20;

  // Divider
  doc.setDrawColor(NAV_R, NAV_G, NAV_B);
  doc.setLineWidth(1.5);
  doc.line(margin, y, W - margin, y);
  y += 20;

  y = renderLineItems(doc, invoice, y, margin, 841);

  // Footer band
  const footerY = 820;
  doc.setFillColor(NAV_R, NAV_G, NAV_B);
  doc.rect(0, footerY, W, 28, 'F');
  doc.setFontSize(8);
  doc.setTextColor(200, 210, 230);
  doc.text(`${biz.name || ''} — Thank you for your business`, margin, footerY + 18);

  y = renderNotes(doc, invoice, y, margin);
}

// ── Template: Minimal ─────────────────────────────────────────────────────────
async function renderMinimal(doc, invoice) {
  await loadAllFonts(doc);
  const client = byId('clients', invoice.clientId) || {};
  const biz    = state.db.settings?.business || {};
  const team   = (state.db.settings?.team || []).find(t => t.id === invoice.owner);
  const ownerName = team?.name || (invoice.owner === 'rita' ? 'Rita' : invoice.owner === 'you' ? 'Owner' : 'Team');

  const W       = 595;
  const margin  = 56;
  const ACC_R   = 37;
  const ACC_G   = 99;
  const ACC_B   = 235;   // #2563eb blue

  // Left accent stripe
  doc.setFillColor(ACC_R, ACC_G, ACC_B);
  doc.rect(0, 0, 5, 841, 'F');

  let y = 52;

  // INVOICE large
  doc.setFontSize(32);
  doc.setFont('DMSans', 'bold');
  doc.setTextColor(20, 20, 20);
  doc.text('INVOICE', margin, y);

  // Invoice number right-aligned, accent color
  doc.setFontSize(22);
  doc.setTextColor(ACC_R, ACC_G, ACC_B);
  doc.text(`#${invoice.number || 'DRAFT'}`, W - margin, y, { align: 'right' });
  doc.setTextColor(0);
  y += 20;

  // Thin accent rule
  doc.setDrawColor(ACC_R, ACC_G, ACC_B);
  doc.setLineWidth(1);
  doc.line(margin, y, W - margin, y);
  y += 16;

  // Company name + date meta side by side
  // Left column stops short of the right-aligned Issued/Due dates.
  const leftW = W - margin * 2 - 140;
  doc.setFont('DMSans', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(20, 20, 20);
  const nameLines = wrap(doc, biz.name || ownerName, leftW);
  nameLines.forEach((line, i) => doc.text(line, margin, y + i * 13));

  doc.setFont('DMSans', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(120);
  doc.text(`Issued  ${fmtDate(invoice.issueDate)}`, W - margin, y, { align: 'right' });
  doc.text(`Due      ${fmtDate(invoice.dueDate)}`, W - margin, y + 28, { align: 'right' });
  y += 14 + (nameLines.length - 1) * 13;

  doc.setFont('DMSans', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(100);
  wrapAll(doc, bizLines(biz), leftW).forEach(line => { doc.text(line, margin, y); y += 11; });

  doc.setTextColor(0);
  y += 20;

  // Bill-to box (light gray background)
  const boxInnerW = W - margin * 2 - 20;
  doc.setFont('DMSans', 'bold');
  doc.setFontSize(10);
  const clientNameLines = wrap(doc, client.name || '', boxInnerW);
  doc.setFont('DMSans', 'normal');
  doc.setFontSize(9);
  const clientInfoLines = wrapAll(doc, clientLines(client), boxInnerW);
  const boxH = (clientNameLines.length + clientInfoLines.length) * 13 + 22;

  doc.setFillColor(248, 249, 250);
  doc.setDrawColor(230);
  doc.setLineWidth(0.5);
  doc.rect(margin, y, W - margin * 2, boxH, 'FD');

  doc.setFontSize(8);
  doc.setTextColor(120);
  doc.setFont('DMSans', 'bold');
  doc.text('BILL TO', margin + 10, y + 14);

  doc.setFont('DMSans', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(20, 20, 20);
  clientNameLines.forEach((line, i) => doc.text(line, margin + 10, y + 27 + i * 13));

  doc.setFont('DMSans', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(80);
  const infoY = y + 40 + (clientNameLines.length - 1) * 13;
  clientInfoLines.forEach((line, i) => doc.text(line, margin + 10, infoY + i * 13));

  y += boxH + 24;

  y = renderLineItems(doc, invoice, y, margin, 841);
  y = renderNotes(doc, invoice, y, margin);
}

// ── Template: Luxury — exact port of invoice_t3_option1.html ─────────────────
// px→pt scale: A4 595pt / 800px HTML max-width ≈ 0.744
async function renderLuxury(doc, invoice) {
  await loadAllFonts(doc);

  const client = byId('clients', invoice.clientId) || {};
  const biz    = state.db.settings?.business || {};

  const W    = 595.28;
  const ML   = 42;          // 56px * 0.744
  const MR   = W - ML;
  const MT   = 48;          // 60px top padding * 0.744 + 4pt border

  // Colors — matched to Invoice_23_Converted.docx
  const PARCH  = [250, 247, 242];  // #faf7f2
  const BNAME  = [43,  41,  38];   // #2B2926 company name
  const DARK   = [49,  48,  46];   // #31302E value ink
  const GOLD   = [185, 159, 99];   // #B99F63
  const HAIR   = [214, 201, 176];  // #d6c9b0
  const ROWDIV = [237, 230, 214];  // #ede6d6
  const GHOST  = [229, 217, 187];  // #E5D9BB
  const MUTED  = [155, 154, 150];  // #9B9A96
  const FTR    = [122, 121, 117];  // #7A7975

  // Page background
  doc.setFillColor(...PARCH);
  doc.rect(0, 0, W, 841, 'F');

  // 4px top gold border → 3pt
  doc.setFillColor(...GOLD);
  doc.rect(0, 0, W, 3, 'F');

  // ── Header (.head: space-between, margin-bottom 44px→33pt) ───────────────
  let y = MT;

  // Left: company name — Georgia bolditalic 17pt #2B2926
  // Left column: everything left of the right-aligned "Invoice" / number.
  const LEFT_W = 300;
  doc.setFont('Georgia', 'bolditalic');
  doc.setFontSize(17);
  doc.setTextColor(...BNAME);
  // charSpace widens every glyph gap; splitTextToSize doesn't know about it,
  // so wrap to a proportionally narrower width.
  const nameLines = wrap(doc, biz.name || 'Your Company', LEFT_W * 0.93);
  nameLines.forEach((line, i) => doc.text(line, ML, y + i * 20, { charSpace: 0.6 }));

  // Left: sub-info — DMSans regular 8pt gold uppercase (Word sub-line style)
  const subItems = [
    biz.registrationNumber ? `Reg No  ${biz.registrationNumber}` : '',
    biz.vatNumber          ? `VAT  ${biz.vatNumber}`              : '',
    biz.address            || '',
  ].filter(Boolean);

  let leftY = y + 15 + (nameLines.length - 1) * 20;
  if (subItems.length) {
    doc.setFont('DMSans', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(...GOLD);
    wrapAll(doc, subItems.map(l => l.toUpperCase()), LEFT_W * 0.7).forEach(line => {
      doc.text(line, ML, leftY, { charSpace: 1.6 });
      leftY += 12;
    });
  }

  // Right: "Invoice" — Georgia bolditalic 28pt gold
  doc.setFont('Georgia', 'bolditalic');
  doc.setFontSize(28);
  doc.setTextColor(...GOLD);
  doc.text('Invoice', MR, y, { align: 'right' });

  // Right: ghost number — Arial bolditalic 42pt #E5D9BB
  doc.setFont('helvetica', 'bolditalic');
  doc.setFontSize(42);
  doc.setTextColor(...GHOST);
  doc.text(`#${invoice.number || 'DRAFT'}`, MR, y + 34, { align: 'right' }); // Word: 28pt × 1.2 line height = 34pt baseline gap

  // header block height + margin-bottom (a wrapped name / long address
  // pushes the rule down instead of running into it)
  y = Math.max(y + 40, leftY - 11) + 24;

  // ── Hairline rule (.rule: 0.5px solid #d6c9b0, margin-bottom 28px→21pt) ──
  doc.setDrawColor(...HAIR);
  doc.setLineWidth(0.5);
  doc.line(ML, y, MR, y);
  y += 33; // rule → meta gap: HTML ref hr.rule margin-bottom 44px → 33pt

  // ── Meta grid — Word col widths: Billed To=180pt, Issued=145pt, Due=190pt ──
  const C1 = ML;           // Billed To starts at left margin
  const C2 = ML + 180;     // Issued starts 180pt in
  const C3 = ML + 325;     // Due starts 325pt in (180+145)

  // Labels — helvetica bolditalic 6pt gold, tracked (Word: Arial 6pt bold italic)
  doc.setFont('helvetica', 'bolditalic');
  doc.setFontSize(6);
  doc.setTextColor(...GOLD);
  doc.text('BILLED TO', C1, y, { charSpace: 1.35 });
  doc.text('ISSUED',    C2, y, { charSpace: 1.35 });
  doc.text('DUE',       C3, y, { charSpace: 1.35 });
  y += 13; // label→value gap: label cap(4pt) + margin(4.5pt) + value cap(7pt) ≈ 13pt

  // Values — Georgia bolditalic 10pt #31302E (Word: Georgia 10pt bold italic)
  const LH = 15; // 10pt × 1.5
  doc.setFont('Georgia', 'bolditalic');
  doc.setFontSize(10);
  doc.setTextColor(...DARK);

  const billLines = [
    client.name || '',
    ...(client.address || '').split(/\n|,/).map(s => s.trim()).filter(Boolean),
    client.email || '',
    client.vatNumber ? `VAT: ${client.vatNumber}` : '',
    client.registrationNumber ? `Reg: ${client.registrationNumber}` : '',
  ].filter(Boolean);

  const wrappedBillLines = billLines.flatMap(line => doc.splitTextToSize(line, 178)); // 180pt col

  const valueY = y;
  wrappedBillLines.forEach((line, i) => doc.text(line, C1, valueY + i * LH));
  const billH = Math.max(wrappedBillLines.length, 1) * LH;

  // Issued / Due values — same config as Billed To
  doc.text(fmtDate(invoice.issueDate), C2, valueY);
  doc.text(fmtDate(invoice.dueDate),   C3, valueY);

  y += billH + 27;

  // ── Line items table — Word col widths: Desc=215pt, Qty=82.5pt, Rate=107.5pt, Amt=110pt
  const C_DESC   = ML;               // left margin
  const C_QTY_R  = ML + 297.5;       // right edge of QTY col (for label + value)
  const C_QTY_C  = ML + 256.25;      // center of QTY col (value: center-aligned)
  const C_RATE   = ML + 405;         // right edge of RATE col
  const C_AMT    = MR;               // right edge
  const DESC_W   = 213;              // description wrap width (Word: 215pt col)

  // Labels — helvetica bolditalic 6pt gold (Word: Arial 6pt bold italic).
  // Drawn again at the top of every continuation page.
  const drawTableHeader = () => {
    doc.setFont('helvetica', 'bolditalic');
    doc.setFontSize(6);
    doc.setTextColor(...GOLD);
    doc.text('DESCRIPTION', C_DESC,  y, { charSpace: 1.2 });
    doc.text('QTY',         C_QTY_R, y, { align: 'right', charSpace: 1.2 });
    doc.text('RATE',        C_RATE,  y, { align: 'right', charSpace: 1.2 });
    doc.text('AMOUNT',      C_AMT,   y, { align: 'right', charSpace: 1.2 });
    y += 2; // space-after: 2pt (Word: 40 twips)
    doc.setDrawColor(...HAIR);
    doc.setLineWidth(0.5);
    doc.line(ML, y, MR, y);
    y += 12;
  };
  drawTableHeader();

  for (const li of invoice.lineItems || []) {
    const parts       = (li.description || '').split('\n');
    const mainDesc    = parts[0];
    const subDesc     = parts.slice(1).join(' ').trim();
    // Set font before splitTextToSize so width is measured with the correct metrics
    doc.setFont('Georgia', 'bolditalic');
    doc.setFontSize(11);
    const mainWrapped = doc.splitTextToSize(mainDesc, DESC_W);
    const mainH       = mainWrapped.length * 14; // 14pt line height for 11pt font
    doc.setFontSize(8);
    const subWrapped  = subDesc ? doc.splitTextToSize(subDesc, DESC_W) : [];
    const subH        = subWrapped.length * 10;
    const descTotal   = mainH + (subDesc ? 1.5 + subH : 0);
    const rowH        = 14 + descTotal + 10; // 14pt top padding + content + 10pt bottom

    if (y + rowH > 780) {
      doc.addPage();
      doc.setFillColor(...PARCH);
      doc.rect(0, 0, W, 841, 'F');
      doc.setFillColor(...GOLD);
      doc.rect(0, 0, W, 3, 'F');
      y = MT;
      drawTableHeader();
    }

    // Single baseline for all columns; for multi-line desc, numbers center on the block
    const descY   = y + 14;
    const numberY = descY + Math.max(0, (descTotal - 14) / 2);

    // Description — Georgia bolditalic 11pt #31302E (Word: Georgia 11pt bold italic)
    doc.setFont('Georgia', 'bolditalic');
    doc.setFontSize(11);
    doc.setTextColor(...DARK);
    doc.text(mainWrapped, C_DESC, descY);

    if (subDesc) {
      // Sub-line — Georgia bolditalic 8pt gold (Word: Georgia 8pt bold italic)
      doc.setFont('Georgia', 'bolditalic');
      doc.setFontSize(8);
      doc.setTextColor(...GOLD);
      doc.text(subWrapped, C_DESC, descY + mainH + 1.5, { lineHeightFactor: 10 / 8 });
    }

    // Qty center / Rate right / Amount right — Georgia bolditalic 10pt (Word: Georgia 10pt bold italic)
    doc.setFont('Georgia', 'bolditalic');
    doc.setFontSize(10);
    doc.setTextColor(...DARK);
    const QTY_W  = C_QTY_R - (C_DESC + DESC_W);   // ~84pt
    const RATE_W = C_RATE   - C_QTY_R;             // ~107pt
    const AMT_W  = C_AMT    - C_RATE;              // ~106pt
    doc.text(doc.splitTextToSize(`${li.quantity} ${li.unit || ''}`.trim(), QTY_W),  C_QTY_C, numberY, { align: 'center' });
    doc.text(doc.splitTextToSize(formatMoney(li.rate,  invoice.currency),  RATE_W), C_RATE,  numberY, { align: 'right' });
    doc.text(doc.splitTextToSize(formatMoney(li.total, invoice.currency),  AMT_W),  C_AMT,   numberY, { align: 'right' });

    y += rowH;
    // Divider after every row — lighter than ROWDIV, aligned to table columns
    doc.setDrawColor(245, 239, 226);
    doc.setLineWidth(0.5);
    doc.line(ML, y, MR, y);
  }

  // Start a fresh parchment page when the next block wouldn't fit — the
  // totals/footer used to be drawn past the bottom edge after a long table.
  const luxEnsureRoom = (needed, bottom) => {
    if (y + needed <= bottom) return;
    doc.addPage();
    doc.setFillColor(...PARCH);
    doc.rect(0, 0, W, 841, 'F');
    doc.setFillColor(...GOLD);
    doc.rect(0, 0, W, 3, 'F');
    y = MT;
  };
  luxEnsureRoom(80, 800);

  // ── Totals (.tot: margin-top 20px→15pt, width 230px→172pt) ───────────────
  y += 15;
  const TOT_L = MR - 172;

  doc.setDrawColor(...HAIR);
  doc.setLineWidth(0.5);
  doc.line(TOT_L, y, MR, y);
  y += 13; // Word space-before 7pt + 8pt font cap height (~6pt) = baseline offset

  // Subtotal / Tax — Arial bold italic 8pt, #9B9A96
  doc.setFont('helvetica', 'bolditalic');
  doc.setFontSize(8);
  doc.setTextColor(...MUTED);
  doc.text('Subtotal', TOT_L, y);
  doc.text(formatMoney(invoice.subtotal, invoice.currency), MR, y, { align: 'right' });
  y += 10; // 8pt font + space-after(1pt) + space-before(1pt)

  doc.text(`Tax (${invoice.taxRate || 0}%)`, TOT_L, y);
  doc.text(formatMoney(invoice.tax || 0, invoice.currency), MR, y, { align: 'right' });
  y += 3; // Word space-after Tax=1pt + 8pt descender (~1.6pt) ≈ 3pt to divider line

  // Total — Georgia bold italic 14pt, gold
  doc.setDrawColor(...HAIR);
  doc.line(TOT_L, y, MR, y);
  y += 15; // Word space-before Total=5pt + 14pt cap height (~10pt) = 15pt to baseline

  doc.setFont('Georgia', 'bolditalic');
  doc.setFontSize(14);
  doc.setTextColor(...GOLD);
  doc.text('Total', TOT_L, y);
  doc.text(formatMoney(invoice.total, invoice.currency), MR, y, { align: 'right' });
  y += 18;

  // Luxury template: no notes section per the golden reference.

  // ── Footer (.foot: margin-top 40px→30pt, border-top, padding-top 18px→13.5pt)
  const footerFields = [
    biz.iban  ? { label: 'IBAN',  value: biz.iban }  : null,
    biz.bic   ? { label: 'BIC',   value: biz.bic }   : null,
    biz.swift && biz.swift !== biz.bic ? { label: 'SWIFT', value: biz.swift } : null,
  ].filter(Boolean);

  if (footerFields.length) {
    luxEnsureRoom(60, 820);
    y += 30;
    doc.setDrawColor(...HAIR);
    doc.setLineWidth(0.5);
    doc.line(ML, y, MR, y);
    y += 13.5;

    // Footer — Word col widths: IBAN=135pt, BIC=85pt, SWIFT=295pt
    // Labels: helvetica bolditalic 6pt gold, 2pt gap to value (Word: Arial 6pt bold italic)
    // Values: helvetica bolditalic 8pt #7A7975 (Word: Arial 8pt bold italic)
    // Columns start at those widths but grow to fit their value — a full
    // 34-character IBAN is wider than 135pt and used to run into the BIC.
    let fx = ML;
    footerFields.forEach((f, idx) => {
      const minW = [135, 85, 295][idx] ?? 135;
      doc.setFont('helvetica', 'bolditalic');
      doc.setFontSize(8);
      const colWidth = Math.max(minW, doc.getTextWidth(f.value) + 14);
      doc.setFontSize(6);
      doc.setTextColor(...GOLD);
      doc.text(f.label, fx, y, { charSpace: 1.2 });

      doc.setFontSize(8);
      doc.setTextColor(...FTR);
      doc.text(f.value, fx, y + 8); // 2pt space-after label (Word: 40 twips)
      fx += colWidth;
    });
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

// jsPDF also stamps a random 32-hex-char file ID into the PDF trailer's /ID on
// every output() call (see setFileId), independent of /CreationDate. Deriving
// it from the invoice's own id keeps it deterministic per invoice (so
// re-generating unchanged data is byte-identical) while still varying between
// different invoices, same as a real per-document ID would.
async function stableFileId(seed) {
  const data = new TextEncoder().encode(String(seed || ''));
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).slice(0, 16).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function generateInvoicePDF(invoice, templateOverride) {
  // jsPDF is loaded on first use (pinned + SRI, see core/libs.js) rather than
  // as a render-blocking <script> on every page load.
  const { jsPDF } = await loadLib('jspdf');
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  // jsPDF stamps the wall-clock time into the PDF's /CreationDate metadata by
  // default, so re-generating byte-identical invoice content still produces
  // different output on every call. Pin it to the invoice's own issue date so
  // regenerating unchanged data yields byte-identical PDFs (content hashing,
  // e.g. to skip a no-op re-upload, relies on this).
  doc.setCreationDate(invoice.issueDate ? new Date(invoice.issueDate) : new Date(0));
  doc.setFileId(await stableFileId(invoice.id));

  const tpl = templateOverride || state.db.settings?.business?.invoiceTemplate || 'standard';

  if (tpl === 'luxury') {
    await renderLuxury(doc, invoice);
  } else if (tpl === 'corporate') {
    await renderCorporate(doc, invoice);
  } else if (tpl === 'minimal') {
    await renderMinimal(doc, invoice);
  } else {
    await renderStandard(doc, invoice);
  }

  // Font problems (a template font that failed to load, or characters no
  // available font can draw) don't stop the PDF; tell the user once.
  for (const msg of doc.__pdfWarnings || []) {
    console.warn(`[pdf] ${msg}`);
    try { toast(msg, 'warning'); } catch { /* no UI (e.g. tests) */ }
  }

  return doc;
}

export async function downloadInvoicePDF(invoice, filename) {
  const doc = await generateInvoicePDF(invoice);
  doc.save(filename || `${invoice.number || 'invoice'}.pdf`);
}
