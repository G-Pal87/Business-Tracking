// Invoice PDF generator using jsPDF
import { byId, formatMoney } from './data.js';
import { state } from './state.js';
import { fmtDate } from './ui.js';

function getInvoiceName(invoice) {
  const client = byId('clients', invoice.clientId);
  const clientPart = client ? String(client.name).replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 20) : 'CLIENT';
  const [y, m, d] = (invoice.issueDate || '').split('-');
  const dateFmt = `${d || ''}${m || ''}${(y || '').slice(2)}`;
  return `${invoice.number || invoice.id}_${clientPart}_${dateFmt}`;
}

export function generateInvoicePDF(invoice) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const client = byId('clients', invoice.clientId) || {};
  const biz = state.db.settings?.business || {};
  const team = (state.db.settings?.team || []).find(t => t.id === invoice.owner);
  const ownerName = team?.name || (invoice.owner === 'rita' ? 'Rita' : invoice.owner === 'you' ? 'Owner' : 'Team');

  const margin = 48;
  const rightX = 320;

  // ── Header ────────────────────────────────────────────────────────────────────
  let y = margin;
  let ry = margin;

  // Left: INVOICE title + business info
  doc.setFontSize(28);
  doc.setFont('helvetica', 'bold');
  doc.text('INVOICE', margin, y);
  y += 20;
  doc.setFontSize(11);
  doc.text(biz.name || ownerName, margin, y);
  y += 16;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  const bizLines = [
    biz.address,
    biz.registrationNumber ? `Reg: ${biz.registrationNumber}` : '',
    biz.vatNumber ? `VAT: ${biz.vatNumber}` : '',
    biz.iban ? `IBAN: ${biz.iban}` : '',
    biz.bic ? `BIC: ${biz.bic}` : '',
  ].filter(Boolean);
  bizLines.forEach(line => { doc.text(line, margin, y); y += 12; });

  // Right: Invoice No, Invoice Name, dates
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
  doc.text('Invoice Name', rightX, ry);
  doc.setTextColor(80);
  doc.text(getInvoiceName(invoice), rightX, ry + 12);
  ry += 28;

  doc.setTextColor(120);
  doc.text('Issued', rightX, ry);
  doc.setTextColor(0);
  doc.text(fmtDate(invoice.issueDate), rightX, ry + 12);
  ry += 24;

  doc.setTextColor(120);
  doc.text('Due', rightX, ry);
  doc.setTextColor(0);
  doc.text(fmtDate(invoice.dueDate), rightX, ry + 12);
  ry += 12;
  doc.setTextColor(0);

  // Separator after both columns
  y = Math.max(y, ry) + 20;
  doc.setDrawColor(200);
  doc.setLineWidth(0.5);
  doc.line(margin, y, 548, y);
  y += 16;

  // ── Bill To ───────────────────────────────────────────────────────────────────
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
  const toLines = [
    client.address,
    client.email,
    client.vatNumber ? `VAT: ${client.vatNumber}` : '',
    client.registrationNumber ? `Reg: ${client.registrationNumber}` : '',
  ].filter(Boolean);
  toLines.forEach(line => { doc.text(line, margin, y); y += 12; });
  y += 24;

  // ── Line items ────────────────────────────────────────────────────────────────
  const rowH = 24;
  const C_DESC_X = margin + 8;
  const C_DESC_W = 245;
  const C_QTY_X  = 370;
  const C_RATE_X = 460;
  const C_AMT_X  = 548;

  doc.setFillColor(243, 244, 246);
  doc.rect(margin, y, 500, rowH, 'F');
  doc.setFontSize(9);
  doc.setTextColor(80);
  doc.setFont('helvetica', 'bold');
  doc.text('DESCRIPTION', C_DESC_X, y + 16);
  doc.text('QTY',    C_QTY_X,  y + 16, { align: 'right' });
  doc.text('RATE',   C_RATE_X, y + 16, { align: 'right' });
  doc.text('AMOUNT', C_AMT_X,  y + 16, { align: 'right' });
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(0);
  doc.setDrawColor(180);
  doc.setLineWidth(0.5);
  doc.line(margin, y + rowH, 548, y + rowH);
  y += rowH;

  doc.setFontSize(10);
  for (const li of invoice.lineItems || []) {
    const descLines = doc.splitTextToSize(li.description || '', C_DESC_W);
    const itemH = Math.max(rowH, descLines.length * 14 + 8);
    if (y + itemH > 720) { doc.addPage(); y = margin; }
    const midY = y + 16;
    doc.text(descLines, C_DESC_X, midY);
    doc.text(`${li.quantity} ${li.unit || ''}`.trim(), C_QTY_X,  midY, { align: 'right' });
    doc.text(formatMoney(li.rate,  invoice.currency),  C_RATE_X, midY, { align: 'right' });
    doc.text(formatMoney(li.total, invoice.currency),  C_AMT_X,  midY, { align: 'right' });
    y += itemH;
    doc.setDrawColor(230);
    doc.line(margin, y, 548, y);
  }

  y += 16;

  // ── Totals ────────────────────────────────────────────────────────────────────
  doc.setFontSize(10);
  doc.text('Subtotal', C_RATE_X, y, { align: 'right' });
  doc.text(formatMoney(invoice.subtotal, invoice.currency), C_AMT_X, y, { align: 'right' });
  y += 18;
  doc.text(`Tax (${invoice.taxRate || 0}%)`, C_RATE_X, y, { align: 'right' });
  doc.text(formatMoney(invoice.tax || 0, invoice.currency), C_AMT_X, y, { align: 'right' });
  y += 18;
  doc.setLineWidth(1.5);
  const totalLineX = C_RATE_X - doc.getTextWidth('TOTAL');
  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.line(totalLineX, y, C_AMT_X, y);
  y += 16;
  doc.setFontSize(13);
  doc.setFont('helvetica', 'bold');
  doc.text('TOTAL', C_RATE_X, y, { align: 'right' });
  doc.text(formatMoney(invoice.total, invoice.currency), C_AMT_X, y, { align: 'right' });
  doc.setFont('helvetica', 'normal');

  y += 40;

  if (invoice.notes) {
    y += 16;
    doc.setFontSize(9);
    doc.setTextColor(120);
    doc.text('NOTES', margin, y);
    doc.setTextColor(0);
    y += 14;
    const lines = doc.splitTextToSize(invoice.notes, 500);
    doc.text(lines, margin, y);
  }

  return doc;
}

export function downloadInvoicePDF(invoice, filename) {
  const doc = generateInvoicePDF(invoice);
  doc.save(filename || `${invoice.number || 'invoice'}.pdf`);
}
