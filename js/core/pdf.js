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
  doc.setFillColor(243, 244, 246);
  doc.rect(margin, y, 500, rowH, 'F');
  doc.setFontSize(9);
  doc.setTextColor(80);
  doc.setFont('helvetica', 'bold');
  doc.text('DESCRIPTION', margin + 8, y + 16);
  doc.text('QTY', 330, y + 16);
  doc.text('RATE', 390, y + 16, { align: 'right' });
  doc.text('AMOUNT', 536, y + 16, { align: 'right' });
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(0);
  doc.setDrawColor(180);
  doc.setLineWidth(0.5);
  doc.line(margin, y + rowH, 548, y + rowH);
  y += rowH;

  // Line items
  doc.setFontSize(10);
  for (const li of invoice.lineItems || []) {
    if (y + rowH > 720) { doc.addPage(); y = margin; }
    doc.text(li.description || '', margin + 8, y + 16);
    doc.text(`${li.quantity} ${li.unit || ''}`, 330, y + 16);
    doc.text(formatMoney(li.rate, invoice.currency), 390, y + 16, { align: 'right' });
    doc.text(formatMoney(li.total, invoice.currency), 536, y + 16, { align: 'right' });
    y += rowH;
    doc.setDrawColor(230);
    doc.line(margin, y, 548, y);
  }

  y += 16;

  // Totals
  const totalsX = 390;
  doc.setFontSize(10);
  doc.text('Subtotal', totalsX, y, { align: 'right' });
  doc.text(formatMoney(invoice.subtotal, invoice.currency), 536, y, { align: 'right' });
  y += 18;
  if (invoice.taxRate) {
    doc.text(`Tax (${invoice.taxRate}%)`, totalsX, y, { align: 'right' });
    doc.text(formatMoney(invoice.tax, invoice.currency), 536, y, { align: 'right' });
    y += 18;
  }
  doc.setLineWidth(1.5);
  doc.line(totalsX - 8, y, 548, y);
  y += 16;
  doc.setFontSize(13);
  doc.setFont('helvetica', 'bold');
  doc.text('TOTAL', totalsX, y, { align: 'right' });
  doc.text(formatMoney(invoice.total, invoice.currency), 536, y, { align: 'right' });
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
