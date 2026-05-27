// Invoice PDF generator using jsPDF — supports multiple templates
import { byId, formatMoney } from './data.js';
import { state } from './state.js';
import { fmtDate } from './ui.js';

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

async function loadFont(doc, filename, family, style) {
  const cacheKey = `${family}:${style}`;
  if (!_fontCache[cacheKey]) {
    const base = window.location.origin + window.location.pathname.replace(/\/[^/]*$/, '');
    const url  = `${base}/assets/fonts/${filename}`;
    const res  = await fetch(url);
    if (!res.ok) throw new Error(`Font fetch failed: ${filename} (${res.status})`);
    _fontCache[cacheKey] = arrayBufToBase64(await res.arrayBuffer());
  }
  doc.addFileToVFS(filename, _fontCache[cacheKey]);
  doc.addFont(filename, family, style);
}

async function loadAllFonts(doc) {
  await Promise.all([
    loadFont(doc, 'CormorantGaramond-Light.ttf',      'Cormorant', 'normal'),
    loadFont(doc, 'CormorantGaramond-LightItalic.ttf','Cormorant', 'italic'),
    loadFont(doc, 'CormorantGaramond-SemiBold.ttf',   'CormorantBold', 'normal'),
    loadFont(doc, 'DMSans-Regular.ttf',               'DMSans', 'normal'),
    loadFont(doc, 'DMSans-Medium.ttf',                'DMSans', 'bold'),
  ]);
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

  // Header row
  doc.setFillColor(243, 244, 246);
  doc.rect(margin, startY, tableW, rowH, 'F');
  doc.setFontSize(9);
  doc.setTextColor(80);
  doc.setFont('helvetica', 'bold');
  doc.text('DESCRIPTION', C_DESC_X,  startY + 16);
  doc.text('QTY',         C_QTY_X,   startY + 16, { align: 'right' });
  doc.text('RATE',        C_RATE_X,  startY + 16, { align: 'right' });
  doc.text('AMOUNT',      C_AMT_X,   startY + 16, { align: 'right' });
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(0);
  doc.setDrawColor(180);
  doc.setLineWidth(0.5);
  doc.line(margin, startY + rowH, C_AMT_X, startY + rowH);
  let y = startY + rowH;

  doc.setFontSize(10);
  for (const li of invoice.lineItems || []) {
    const descLines = doc.splitTextToSize(li.description || '', C_DESC_W);
    const itemH = Math.max(rowH, descLines.length * 14 + 8);
    if (y + itemH > pageH - 80) { doc.addPage(); y = margin; }
    const midY = y + 16;
    doc.text(descLines,                                             C_DESC_X, midY);
    doc.text(`${li.quantity} ${li.unit || ''}`.trim(),             C_QTY_X,  midY, { align: 'right' });
    doc.text(formatMoney(li.rate,  invoice.currency),              C_RATE_X, midY, { align: 'right' });
    doc.text(formatMoney(li.total, invoice.currency),              C_AMT_X,  midY, { align: 'right' });
    y += itemH;
    doc.setDrawColor(230);
    doc.line(margin, y, C_AMT_X, y);
  }

  y += 20;

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
  doc.setFont('helvetica', 'bold');
  doc.text('TOTAL', C_RATE_X, y, { align: 'right' });
  doc.text(formatMoney(invoice.total, invoice.currency), C_AMT_X, y, { align: 'right' });
  doc.setFont('helvetica', 'normal');

  return y;
}

function renderNotes(doc, invoice, y, margin) {
  if (!invoice.notes) return y;
  y += 28;
  doc.setFontSize(9);
  doc.setTextColor(120);
  doc.text('NOTES', margin, y);
  doc.setTextColor(0);
  y += 14;
  const lines = doc.splitTextToSize(invoice.notes, 500);
  doc.setFontSize(9);
  doc.text(lines, margin, y);
  return y;
}

// ── Template: Standard ────────────────────────────────────────────────────────
function renderStandard(doc, invoice) {
  const client = byId('clients', invoice.clientId) || {};
  const biz    = state.db.settings?.business || {};
  const team   = (state.db.settings?.team || []).find(t => t.id === invoice.owner);
  const ownerName = team?.name || (invoice.owner === 'rita' ? 'Rita' : invoice.owner === 'you' ? 'Owner' : 'Team');

  const margin = 48;
  const rightX = 320;
  let y  = margin;
  let ry = margin;

  doc.setFontSize(28);
  doc.setFont('helvetica', 'bold');
  doc.text('INVOICE', margin, y);
  y += 20;
  doc.setFontSize(11);
  doc.text(biz.name || ownerName, margin, y);
  y += 16;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  bizLines(biz).forEach(line => { doc.text(line, margin, y); y += 12; });

  doc.setFontSize(9);
  doc.setTextColor(120);
  doc.text('Invoice No', rightX, ry);
  doc.setTextColor(0);
  doc.setFontSize(14);
  doc.setFont('helvetica', 'bold');
  doc.text(String(invoice.number || ''), rightX, ry + 15);
  ry += 32;

  doc.setFont('helvetica', 'normal');
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
  doc.setFont('helvetica', 'bold');
  doc.text(client.name || '', margin, y);
  y += 14;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  clientLines(client).forEach(line => { doc.text(line, margin, y); y += 12; });
  y += 24;

  y = renderLineItems(doc, invoice, y, margin, 841);
  y = renderNotes(doc, invoice, y, margin);
}

// ── Template: Corporate Navy ──────────────────────────────────────────────────
function renderCorporate(doc, invoice) {
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
  doc.setFontSize(20);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(255, 255, 255);
  doc.text(biz.name || ownerName, margin, 34);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(200, 210, 230);
  const bl = bizLines(biz);
  bl.slice(0, 2).forEach((line, i) => doc.text(line, margin, 50 + i * 13));

  // "INVOICE" right in white
  doc.setFontSize(30);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(255, 255, 255);
  doc.text('INVOICE', W - margin, 36, { align: 'right' });
  // Invoice number in gold accent
  doc.setFontSize(11);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(ACC_R, ACC_G, ACC_B);
  doc.text(`No. ${invoice.number || 'DRAFT'}`, W - margin, 54, { align: 'right' });
  doc.setTextColor(200, 210, 230);
  doc.setFontSize(9);
  doc.text(`Issued: ${fmtDate(invoice.issueDate)}  •  Due: ${fmtDate(invoice.dueDate)}`, W - margin, 70, { align: 'right' });

  doc.setTextColor(0);
  doc.setFont('helvetica', 'normal');

  // ── Gold accent stripe below header ───────────────────────────────────────
  doc.setFillColor(ACC_R, ACC_G, ACC_B);
  doc.rect(0, hdrH, W, 3, 'F');

  let y = hdrH + 24;

  // ── Two-column: From / Bill To ─────────────────────────────────────────────
  const colW = 220;
  const col2X = W - margin - colW;

  doc.setFontSize(8);
  doc.setTextColor(120);
  doc.setFont('helvetica', 'bold');
  doc.text('FROM', margin, y);
  doc.text('BILL TO', col2X, y);
  y += 14;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(0);
  doc.text(biz.name || ownerName, margin, y);
  doc.text(client.name || '', col2X, y);
  y += 14;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  const bl2 = bizLines(biz);
  const cl  = clientLines(client);
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
function renderMinimal(doc, invoice) {
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
  doc.setFont('helvetica', 'bold');
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
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(20, 20, 20);
  doc.text(biz.name || ownerName, margin, y);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(120);
  doc.text(`Issued  ${fmtDate(invoice.issueDate)}`, W - margin, y, { align: 'right' });
  y += 14;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(100);
  bizLines(biz).forEach(line => { doc.text(line, margin, y); y += 11; });

  doc.setTextColor(120);
  doc.text(`Due      ${fmtDate(invoice.dueDate)}`, W - margin, y - (bizLines(biz).length * 11) + 14, { align: 'right' });

  doc.setTextColor(0);
  y += 20;

  // Bill-to box (light gray background)
  const billToLines = [client.name || ''];
  clientLines(client).forEach(l => billToLines.push(l));
  const boxH = billToLines.length * 13 + 22;

  doc.setFillColor(248, 249, 250);
  doc.setDrawColor(230);
  doc.setLineWidth(0.5);
  doc.rect(margin, y, W - margin * 2, boxH, 'FD');

  doc.setFontSize(8);
  doc.setTextColor(120);
  doc.setFont('helvetica', 'bold');
  doc.text('BILL TO', margin + 10, y + 14);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(20, 20, 20);
  doc.text(client.name || '', margin + 10, y + 27);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(80);
  clientLines(client).forEach((line, i) => doc.text(line, margin + 10, y + 40 + i * 13));

  y += boxH + 24;

  y = renderLineItems(doc, invoice, y, margin, 841);
  y = renderNotes(doc, invoice, y, margin);
}

// ── Template: Luxury (Cormorant Garamond + DM Sans, parchment + gold) ─────────
async function renderLuxury(doc, invoice) {
  await loadAllFonts(doc);

  const client = byId('clients', invoice.clientId) || {};
  const biz    = state.db.settings?.business || {};

  const W      = 595;
  const margin = 48;       // ~56px
  const rEdge  = W - margin;

  // Colours
  const PARCH  = [250, 247, 242];   // #faf7f2
  const DARK   = [42,  33,  24];    // #2a2118
  const GOLD   = [184, 147, 90];    // #b8935a
  const HAIR   = [214, 201, 176];   // #d6c9b0
  const ROWDIV = [237, 230, 214];   // #ede6d6
  const GHOST  = [232, 217, 184];   // #e8d9b8
  const MUTED  = [153, 153, 153];   // #999
  const FOOTER = [136, 136, 136];   // #888

  // Page background
  doc.setFillColor(...PARCH);
  doc.rect(0, 0, W, 841, 'F');

  // Top gold border 4pt
  doc.setFillColor(...GOLD);
  doc.rect(0, 0, W, 3, 'F');

  let y = 52;

  // ── Header ─────────────────────────────────────────────────────────────────
  // Left: company name
  doc.setFont('CormorantBold', 'normal');
  doc.setFontSize(16);
  doc.setTextColor(...DARK);
  doc.text(biz.name || 'Your Company', margin, y);

  // Left: sub-line (reg/type)
  const subParts = [
    biz.registrationNumber ? `Reg ${biz.registrationNumber}` : ''
  ].filter(Boolean);
  if (subParts.length || biz.vatNumber) {
    doc.setFont('DMSans', 'normal');
    doc.setFontSize(7);
    doc.setTextColor(...GOLD);
    const subText = subParts.join(' · ');
    doc.text(subText, margin, y + 13, { charSpace: 1.2 });
  }

  // Right: "Invoice" italic light serif
  doc.setFont('Cormorant', 'italic');
  doc.setFontSize(26);
  doc.setTextColor(...GOLD);
  doc.text('Invoice', rEdge, y, { align: 'right' });

  // Right: ghost number
  doc.setFont('CormorantBold', 'normal');
  doc.setFontSize(54);
  doc.setTextColor(...GHOST);
  doc.text(`#${invoice.number || 'DRAFT'}`, rEdge, y + 40, { align: 'right' });

  y += 70;

  // ── Hairline rule ───────────────────────────────────────────────────────────
  doc.setDrawColor(...HAIR);
  doc.setLineWidth(0.5);
  doc.line(margin, y, rEdge, y);
  y += 22;

  // ── Meta grid: BILLED TO / ISSUED / DUE ────────────────────────────────────
  const col1 = margin;
  const col2 = margin + 180;
  const col3 = margin + 320;

  // Labels
  doc.setFont('DMSans', 'normal');
  doc.setFontSize(7);
  doc.setTextColor(...GOLD);
  ['BILLED TO', 'ISSUED', 'DUE'].forEach((lbl, i) => {
    doc.text(lbl, [col1, col2, col3][i], y, { charSpace: 1.4 });
  });
  y += 11;

  // BILLED TO value (multi-line)
  doc.setFont('Cormorant', 'normal');
  doc.setFontSize(11);
  doc.setTextColor(...DARK);
  const billLines = [
    client.name || '',
    ...(client.address ? client.address.split(',').map(s => s.trim()) : []),
    client.vatNumber ? `VAT: ${client.vatNumber}` : '',
    client.registrationNumber ? `Reg: ${client.registrationNumber}` : '',
  ].filter(Boolean);
  billLines.forEach((line, i) => {
    if (i === 0) { doc.setFont('CormorantBold', 'normal'); }
    else         { doc.setFont('Cormorant', 'normal'); }
    doc.text(line, col1, y + i * 13);
  });

  // ISSUED / DUE values
  doc.setFont('Cormorant', 'normal');
  doc.setFontSize(11);
  doc.setTextColor(...DARK);
  doc.text(fmtDate(invoice.issueDate), col2, y);
  doc.text(fmtDate(invoice.dueDate),   col3, y);

  y += Math.max(billLines.length * 13, 13) + 28;

  // ── Line items table ────────────────────────────────────────────────────────
  const C_DESC  = margin;
  const C_QTY   = margin + 270;
  const C_RATE  = margin + 360;
  const C_AMT   = rEdge;
  const DESC_W  = 240;

  // Table header
  doc.setFont('DMSans', 'normal');
  doc.setFontSize(7.5);
  doc.setTextColor(...GOLD);
  doc.text('DESCRIPTION', C_DESC, y, { charSpace: 1.2 });
  doc.text('QTY',         C_QTY,  y, { charSpace: 1.2 });
  doc.text('RATE',        C_RATE, y, { charSpace: 1.2 });
  doc.text('AMOUNT',      C_AMT,  y, { align: 'right', charSpace: 1.2 });

  y += 8;
  doc.setDrawColor(...HAIR);
  doc.setLineWidth(0.5);
  doc.line(margin, y, rEdge, y);
  y += 16;

  // Rows
  for (const li of invoice.lineItems || []) {
    const descLines = doc.splitTextToSize(li.description || '', DESC_W);
    const hasNote   = li.note || li.period;
    const rowH      = descLines.length * 14 + (hasNote ? 14 : 0) + 22;
    if (y + rowH > 780) { doc.addPage(); doc.setFillColor(...PARCH); doc.rect(0, 0, W, 841, 'F'); y = margin; }

    // Description main
    doc.setFont('CormorantBold', 'normal');
    doc.setFontSize(12);
    doc.setTextColor(...DARK);
    doc.text(descLines, C_DESC, y);

    // Sub-line (note/period from description second line if split)
    if (descLines.length > 1) {
      doc.setFont('Cormorant', 'italic');
      doc.setFontSize(10);
      doc.setTextColor(...GOLD);
    }

    // Qty / Rate / Amount
    doc.setFont('Cormorant', 'normal');
    doc.setFontSize(12);
    doc.setTextColor(...DARK);
    doc.text(`${li.quantity} ${li.unit || ''}`.trim(), C_QTY,  y);
    doc.text(formatMoney(li.rate,  invoice.currency),  C_RATE, y);
    doc.text(formatMoney(li.total, invoice.currency),  C_AMT,  y, { align: 'right' });

    y += descLines.length * 14 + 16;
    doc.setDrawColor(...ROWDIV);
    doc.setLineWidth(0.5);
    doc.line(margin, y, rEdge, y);
    y += 10;
  }

  y += 10;

  // ── Totals ─────────────────────────────────────────────────────────────────
  const TOT_X = rEdge - 175;

  doc.setDrawColor(...HAIR);
  doc.setLineWidth(0.5);
  doc.line(TOT_X, y, rEdge, y);
  y += 14;

  doc.setFont('DMSans', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(...MUTED);
  doc.text('Subtotal', TOT_X, y);
  doc.text(formatMoney(invoice.subtotal, invoice.currency), rEdge, y, { align: 'right' });
  y += 16;

  doc.text(`Tax (${invoice.taxRate || 0}%)`, TOT_X, y);
  doc.text(formatMoney(invoice.tax || 0, invoice.currency), rEdge, y, { align: 'right' });
  y += 8;

  doc.setDrawColor(...HAIR);
  doc.line(TOT_X, y, rEdge, y);
  y += 14;

  doc.setFont('Cormorant', 'normal');
  doc.setFontSize(16);
  doc.setTextColor(...GOLD);
  doc.text('Total', TOT_X, y);
  doc.text(formatMoney(invoice.total, invoice.currency), rEdge, y, { align: 'right' });

  y += 30;

  // ── Notes ──────────────────────────────────────────────────────────────────
  if (invoice.notes) {
    doc.setFont('DMSans', 'normal');
    doc.setFontSize(8.5);
    doc.setTextColor(...MUTED);
    const noteLines = doc.splitTextToSize(invoice.notes, rEdge - margin);
    doc.text(noteLines, margin, y);
    y += noteLines.length * 12 + 16;
  }

  // ── Footer: IBAN / BIC / SWIFT ─────────────────────────────────────────────
  const footerFields = [
    biz.iban  ? { label: 'IBAN',  value: biz.iban }  : null,
    biz.bic   ? { label: 'BIC',   value: biz.bic }   : null,
    biz.swift && biz.swift !== biz.bic ? { label: 'SWIFT', value: biz.swift } : null,
  ].filter(Boolean);

  if (footerFields.length) {
    y += 8;
    doc.setDrawColor(...HAIR);
    doc.setLineWidth(0.5);
    doc.line(margin, y, rEdge, y);
    y += 14;

    footerFields.forEach((f, i) => {
      const fx = margin + i * 120;
      doc.setFont('DMSans', 'normal');
      doc.setFontSize(7);
      doc.setTextColor(...GOLD);
      doc.text(f.label, fx, y, { charSpace: 1.2 });
      doc.setFontSize(9);
      doc.setTextColor(...FOOTER);
      doc.text(f.value, fx, y + 12);
    });
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function generateInvoicePDF(invoice, templateOverride) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });

  const tpl = templateOverride || state.db.settings?.business?.invoiceTemplate || 'standard';

  if (tpl === 'luxury') {
    await renderLuxury(doc, invoice);
  } else if (tpl === 'corporate') {
    renderCorporate(doc, invoice);
  } else if (tpl === 'minimal') {
    renderMinimal(doc, invoice);
  } else {
    renderStandard(doc, invoice);
  }

  return doc;
}

export async function downloadInvoicePDF(invoice, filename) {
  const doc = await generateInvoicePDF(invoice);
  doc.save(filename || `${invoice.number || 'invoice'}.pdf`);
}
