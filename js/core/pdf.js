// Invoice PDF generator using jsPDF
import { byId, formatMoney } from './data.js';
import { state } from './state.js';
import { fmtDate } from './ui.js';

export function generateInvoicePDF(invoice) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const client = byId('clients', invoice.clientId) || {};
  const biz = state.db.settings?.business || {};

  const ownerLabel = invoice.owner === 'rita' ? 'Rita' : invoice.owner === 'you' ? 'Owner' : 'Team';
  const team = (state.db.settings?.team || []).find(t => t.id === invoice.owner);
  const ownerName = team?.name || ownerLabel;

  const margin = 48;
  let y = margin;

  // Header
  doc.setFontSize(28);
  doc.setFont('helvetica', 'bold');
  doc.text('INVOICE', margin, y);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(11);
  doc.text(`#${invoice.number}`, 420, y);
  y += 8;
  doc.setFontSize(9);
  doc.setTextColor(120);
  doc.text(`Issued: ${fmtDate(invoice.issueDate)}`, 420, y + 12);
  doc.text(`Due: ${fmtDate(invoice.dueDate)}`, 420, y + 26);
  doc.setTextColor(0);

  y += 56;

  // From
  doc.setFontSize(9);
  doc.setTextColor(120);
  doc.text('FROM', margin, y);
  doc.setTextColor(0);
  doc.setFontSize(11);
  doc.setFont('helvetica', 'bold');
  doc.text(biz.name || ownerName, margin, y + 16);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  const fromLines = [biz.address, biz.email, biz.vatNumber ? `VAT: ${biz.vatNumber}` : ''].filter(Boolean);
  fromLines.forEach((line, i) => doc.text(line, margin, y + 32 + i * 12));

  // To
  doc.setFontSize(9);
  doc.setTextColor(120);
  doc.text('TO', 320, y);
  doc.setTextColor(0);
  doc.setFontSize(11);
  doc.setFont('helvetica', 'bold');
  doc.text(client.name || '', 320, y + 16);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  const toLines = [client.address, client.email, client.vatNumber ? `VAT: ${client.vatNumber}` : '', client.registrationNumber ? `Reg: ${client.registrationNumber}` : ''].filter(Boolean);
  toLines.forEach((line, i) => doc.text(line, 320, y + 32 + i * 12));

  y += 110;

  // Line items header
  const rowH = 24;
  // Column right-edge x positions (all numeric cols right-aligned)
  const C_DESC_X  = margin + 8;   // left-aligned, maxWidth 245
  const C_DESC_W  = 245;
  const C_QTY_X   = 370;          // right-aligned
  const C_RATE_X  = 460;          // right-aligned
  const C_AMT_X   = 548;          // right-aligned

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

  // Line items
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

  // Totals — labels align with RATE column, values align with AMOUNT column
  doc.setFontSize(10);
  doc.text('Subtotal', C_RATE_X, y, { align: 'right' });
  doc.text(formatMoney(invoice.subtotal, invoice.currency), C_AMT_X, y, { align: 'right' });
  y += 18;
  if (invoice.taxRate) {
    doc.text(`Tax (${invoice.taxRate}%)`, C_RATE_X, y, { align: 'right' });
    doc.text(formatMoney(invoice.tax, invoice.currency), C_AMT_X, y, { align: 'right' });
    y += 18;
  }
  doc.setLineWidth(1.5);
  doc.line(C_RATE_X - 8, y, C_AMT_X, y);
  y += 16;
  doc.setFontSize(13);
  doc.setFont('helvetica', 'bold');
  doc.text('TOTAL', C_RATE_X, y, { align: 'right' });
  doc.text(formatMoney(invoice.total, invoice.currency), C_AMT_X, y, { align: 'right' });
  doc.setFont('helvetica', 'normal');

  y += 40;

  // Footer - payment details
  if (biz.iban || biz.bic) {
    doc.setFontSize(9);
    doc.setTextColor(120);
    doc.text('PAYMENT DETAILS', margin, y);
    doc.setTextColor(0);
    y += 14;
    if (biz.iban) { doc.text(`IBAN: ${biz.iban}`, margin, y); y += 12; }
    if (biz.bic) { doc.text(`BIC: ${biz.bic}`, margin, y); y += 12; }
  }

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

export function downloadInvoicePDF(invoice) {
  const doc = generateInvoicePDF(invoice);
  doc.save(`${invoice.number || 'invoice'}.pdf`);
}
