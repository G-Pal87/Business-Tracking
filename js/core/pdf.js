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

  // Colors — exact hex from spec
  const PARCH  = [250, 247, 242];  // #faf7f2
  const DARK   = [42,  33,  24];   // #2a2118
  const GOLD   = [184, 147, 90];   // #b8935a
  const HAIR   = [214, 201, 176];  // #d6c9b0
  const ROWDIV = [237, 230, 214];  // #ede6d6
  const GHOST  = [232, 217, 184];  // #e8d9b8
  const MUTED  = [153, 153, 153];  // #999
  const FTR    = [136, 136, 136];  // #888

  // Page background
  doc.setFillColor(...PARCH);
  doc.rect(0, 0, W, 841, 'F');

  // 4px top gold border → 3pt
  doc.setFillColor(...GOLD);
  doc.rect(0, 0, W, 3, 'F');

  // ── Header (.head: space-between, margin-bottom 44px→33pt) ───────────────
  let y = MT;

  // Left: .bn — Cormorant SemiBold 21px→15.75pt, letter-spacing 0.04em
  doc.setFont('CormorantBold', 'normal');
  doc.setFontSize(15.75);
  doc.setTextColor(...DARK);
  doc.text(biz.name || 'Your Company', ML, y, { charSpace: 0.6 });

  // Left: .bs — DM Sans 11px→8.25pt, uppercase, letter-spacing 0.2em, gold, margin-top 3px
  const subLine = [
    biz.legalSuffix || '',
    biz.registrationNumber ? `Reg ${biz.registrationNumber}` : '',
  ].filter(Boolean).join(' · ');

  const bizDetails = [
    biz.vatNumber ? `VAT: ${biz.vatNumber}` : '',
    biz.address || '',
  ].filter(Boolean);

  doc.setFont('DMSans', 'normal');
  doc.setTextColor(...GOLD);
  let leftY = y + 15;
  if (subLine) {
    doc.setFontSize(8.25);
    doc.text(subLine.toUpperCase(), ML, leftY, { charSpace: 1.6 });
    leftY += 11;
  }
  if (bizDetails.length) {
    doc.setFontSize(7.5);
    doc.setTextColor(...MUTED);
    bizDetails.forEach(line => {
      doc.text(line, ML, leftY);
      leftY += 10;
    });
  }

  // Right: "Invoice" — Cormorant Light Italic 36px→27pt, gold, line-height 1
  doc.setFont('Cormorant', 'italic');
  doc.setFontSize(27);
  doc.setTextColor(...GOLD);
  doc.text('Invoice', MR, y, { align: 'right' });

  // Right: ghost number — Cormorant SemiBold 72px→54pt, #e8d9b8, margin-top -8px→-6pt
  doc.setFont('CormorantBold', 'normal');
  doc.setFontSize(54);
  doc.setTextColor(...GHOST);
  doc.text(`#${invoice.number || 'DRAFT'}`, MR, y + 38, { align: 'right' });

  // ghost line height (~54pt) + 32px (24pt) margin-bottom below the header block
  y += 50 + 24;

  // ── Hairline rule (.rule: 0.5px solid #d6c9b0, margin-bottom 28px→21pt) ──
  doc.setDrawColor(...HAIR);
  doc.setLineWidth(0.5);
  doc.line(ML, y, MR, y);
  y += 33;

  // ── Meta grid — C1 10% wider, C2/C3 share remaining space equally ────────
  const metaGap = 18;
  const totalMetaW = MR - ML - 2 * metaGap;
  const col1W = totalMetaW / 3 * 1.1;
  const col2W = (totalMetaW - col1W) / 2;
  const C1 = ML;
  const C2 = ML + col1W + metaGap;
  const C3 = C2 + col2W + metaGap;

  // Labels — DM Sans 400, 7.5pt, gold, tracked
  doc.setFont('DMSans', 'normal');
  doc.setFontSize(7.5);
  doc.setTextColor(...GOLD);
  doc.text('BILLED TO', C1, y, { charSpace: 1.35 });
  doc.text('ISSUED',    C2, y, { charSpace: 1.35 });
  doc.text('DUE',       C3, y, { charSpace: 1.35 });
  y += 18; // label-to-value gap

  // Values — Cormorant Garamond 400 upright, 14px→10.5pt, #2a2118, line-height 1.5→15.75pt
  const LH = 15.75; // 14px × 1.5 × 0.75
  doc.setFont('Cormorant', 'normal');
  doc.setFontSize(10.5);
  doc.setTextColor(...DARK); // #2a2118

  const billLines = [
    client.name || '',
    ...(client.address || '').split(/\n|,/).map(s => s.trim()).filter(Boolean),
    client.email || '',
    client.vatNumber ? `VAT: ${client.vatNumber}` : '',
    client.registrationNumber ? `Reg: ${client.registrationNumber}` : '',
  ].filter(Boolean);

  const wrappedBillLines = billLines.flatMap(line => doc.splitTextToSize(line, 158));

  const valueY = y;
  wrappedBillLines.forEach((line, i) => doc.text(line, C1, valueY + i * LH));
  const billH = Math.max(wrappedBillLines.length, 1) * LH;

  // Issued / Due — same font as Billed To value
  doc.setFont('Cormorant', 'normal');
  doc.setFontSize(10.5);
  doc.setTextColor(...DARK);
  doc.text(fmtDate(invoice.issueDate), C2, valueY);
  doc.text(fmtDate(invoice.dueDate),   C3, valueY);

  y += billH + 27; // 36px margin-bottom below tallest column

  // ── Line items table ───────────────────────────────────────────────────────
  // thead th: DM Sans 10px→7.5pt, uppercase, letter-spacing 0.16em, gold, padding 9px→6.75pt
  const C_DESC = ML;           // 42pt
  const C_QTY  = 250.8;        // golden x — left-aligned
  const C_RATE = 339.1;        // golden x — left-aligned (NOT right)
  const C_AMT  = MR;           // right edge, right-anchored for AMOUNT only
  const DESC_W = C_QTY - ML - 10; // wrap before Qty column

  doc.setFont('DMSans', 'normal');
  doc.setFontSize(7.5);
  doc.setTextColor(...GOLD);
  doc.text('DESCRIPTION', C_DESC, y, { charSpace: 1.2 });
  doc.text('QTY',         C_QTY,  y, { charSpace: 1.2 });
  doc.text('RATE',        C_RATE, y, { charSpace: 1.2 });
  doc.text('AMOUNT',      C_AMT,  y, { align: 'right', charSpace: 1.2 });
  y += 6.75;
  doc.setDrawColor(...HAIR);
  doc.setLineWidth(0.5);
  doc.line(ML, y, MR, y);
  y += 12;

  // tbody td: Cormorant 15px→11.25pt, padding 16px→12pt each side
  // .ds sub-line: 12px→9pt, italic, gold, margin-top 2px→1.5pt
  for (const li of invoice.lineItems || []) {
    // Split description on newline — first line bold, rest italic gold sub-line
    const parts     = (li.description || '').split('\n');
    const mainDesc  = parts[0];
    const subDesc   = parts.slice(1).join(' ').trim();
    const mainWrapped = doc.splitTextToSize(mainDesc, DESC_W);
    const rowH = 12 + mainWrapped.length * 12 + (subDesc ? 10 : 0) + 12;

    if (y + rowH > 780) {
      doc.addPage();
      doc.setFillColor(...PARCH);
      doc.rect(0, 0, W, 841, 'F');
      doc.setFillColor(...GOLD);
      doc.rect(0, 0, W, 3, 'F');
      y = MT;
    }

    const ry        = y + 12; // padding-top
    const mainH     = mainWrapped.length * 12;
    const subH      = subDesc ? 12 : 0;
    const descTotal = mainH + subH;
    const numberY   = ry + (descTotal - 12) / 2; // vertical mid of description block

    // Description
    doc.setFont('Cormorant', 'normal');
    doc.setFontSize(11.25);
    doc.setTextColor(...DARK);
    doc.text(mainWrapped, C_DESC, ry);

    if (subDesc) {
      doc.setFont('Cormorant', 'italic');
      doc.setFontSize(9);
      doc.setTextColor(...GOLD);
      doc.text(subDesc, C_DESC, ry + mainH + 3);
    }

    // Qty / Rate / Amount — vertically centered on the description block
    doc.setFont('Cormorant', 'normal');
    doc.setFontSize(11.25);
    doc.setTextColor(...DARK);
    doc.text(`${li.quantity} ${li.unit || ''}`.trim(), C_QTY,  numberY);
    doc.text(formatMoney(li.rate,  invoice.currency),  C_RATE, numberY);
    doc.text(formatMoney(li.total, invoice.currency),  C_AMT,  numberY, { align: 'right' });

    y += rowH;
    const isLastItem = li === (invoice.lineItems || [])[invoice.lineItems.length - 1];
    if (!isLastItem) {
      doc.setDrawColor(...ROWDIV);
      doc.setLineWidth(0.5);
      doc.line(ML, y, MR, y);
    }
  }

  // ── Totals (.tot: margin-top 20px→15pt, width 230px→172pt) ───────────────
  y += 15;
  const TOT_L = MR - 172;

  doc.setDrawColor(...HAIR);
  doc.setLineWidth(0.5);
  doc.line(TOT_L, y, MR, y);
  y += 10.5; // padding-top 14px

  // .tr rows: DM Sans 12px→9pt, #999, padding 4px→3pt
  doc.setFont('DMSans', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(...MUTED);
  doc.text('Subtotal', TOT_L, y);
  doc.text(formatMoney(invoice.subtotal, invoice.currency), MR, y, { align: 'right' });
  y += 13.5; // 9pt font + equal top/bottom padding

  doc.text(`Tax (${invoice.taxRate || 0}%)`, TOT_L, y);
  doc.text(formatMoney(invoice.tax || 0, invoice.currency), MR, y, { align: 'right' });
  y += 10.5; // 9pt font + buffer before divider

  // .tf Total: border-top, Cormorant 21px→15.75pt, gold
  doc.setDrawColor(...HAIR);
  doc.line(TOT_L, y, MR, y);
  y += 16; // padding-top — increased from 9 so Total doesn't touch the divider

  doc.setFont('Cormorant', 'normal');
  doc.setFontSize(15.75);
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
    y += 30;
    doc.setDrawColor(...HAIR);
    doc.setLineWidth(0.5);
    doc.line(ML, y, MR, y);
    y += 13.5;

    // Content-sized items with 24pt gap — IBAN block is wider because its value is longer
    let fx = ML;
    const FOOT_GAP = 24;
    footerFields.forEach((f) => {
      doc.setFont('DMSans', 'normal');
      doc.setFontSize(7.5);
      doc.setTextColor(...GOLD);
      doc.text(f.label, fx, y, { charSpace: 1.2 });
      const labelW = doc.getTextWidth(f.label) + (f.label.length - 1) * 1.2;

      doc.setFontSize(9);
      doc.setTextColor(...FTR);
      doc.text(f.value, fx, y + 11); // label height (~7.5pt) + 4px gap (~3pt) ≈ 11pt below
      const valueW = doc.getTextWidth(f.value);

      fx += Math.max(labelW, valueW) + FOOT_GAP;
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
