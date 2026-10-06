// src/lib/pdfGenerator.ts
// Professional invoice PDF generator using jsPDF.
// Produces a branded, print-ready PDF invoice with full breakdown.

import { jsPDF } from "jspdf";
import type { Building, Invoice, Payment, Tenant, Unit } from "@/types";
import { formatPeriodLabel } from "./invoiceGenerator";
import { computeInvoiceSettlement, displayInvoiceStatus } from "./invoiceSettlement";

export interface PdfContext {
  invoice: Invoice;
  tenant?: Tenant;
  unit?: Unit;
  building?: Building;
  /** Payment records — used to show Paid / Balance Due on the PDF. */
  payments?: Payment[];
  companyName: string;
  companyEmail: string;
  companyPhone: string;
  companyAddress: string;
}

const BHD = (n: number) => `${n.toFixed(2)} BHD`;

/** Business terms for the payment status printed on the PDF. */
const STATUS_LABELS: Record<string, string> = {
  Draft: "DRAFT",
  Sent: "UNPAID",
  Partial: "PARTIALLY PAID",
  Paid: "PAID",
  Overpaid: "OVERPAID",
  Overdue: "OVERDUE",
  Cancelled: "CANCELLED",
  Outstanding: "OUTSTANDING",
};

/** Generate and download a PDF for the given invoice. */
export function generateInvoicePdf(ctx: PdfContext): jsPDF {
  const { invoice, tenant, unit, building, companyName, companyEmail, companyPhone, companyAddress } = ctx;

  // Payment-derived settlement — drives the status line and the
  // Paid / Balance Due rows. Original amounts are never modified.
  const settlement = computeInvoiceSettlement(invoice, ctx.payments ?? []);

  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 40;
  let y = margin;

  // ── Header band ──
  doc.setFillColor(15, 41, 66); // deep navy
  doc.rect(0, 0, pageWidth, 80, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(22);
  doc.text(companyName, margin, 35);
  doc.setFontSize(11);
  doc.setFont("helvetica", "normal");
  doc.text("MONTHLY RENTAL INVOICE", pageWidth - margin, 35, { align: "right" });
  doc.setFontSize(9);
  doc.text(companyAddress, margin, 55);
  doc.text(`${companyEmail}  |  ${companyPhone}`, pageWidth - margin, 55, { align: "right" });

  y = 110;
  doc.setTextColor(20, 20, 20);

  // ── Invoice meta ──
  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);
  doc.text(invoice.invoiceNumber, margin, y);
  doc.setFontSize(10);
  doc.setFont("helvetica", "normal");
  // Payment status (business terms) — right-aligned on the same line.
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.setTextColor(90, 105, 125);
  doc.text(
    `PAYMENT STATUS: ${STATUS_LABELS[displayInvoiceStatus(invoice, settlement)] ?? "—"}`,
    pageWidth - margin,
    y + 4,
    { align: "right" },
  );
  doc.setTextColor(20, 20, 20);
  doc.setFont("helvetica", "normal");
  y += 18;

  const metaY = y;
  doc.text(`Invoice Date: ${formatDate(invoice.issueDate ?? invoice.dueDate)}`, margin, metaY);
  doc.text(`Due Date: ${formatDate(invoice.dueDate)}`, margin, metaY + 14);
  if (invoice.periodFrom) {
    doc.text(`Period: ${formatDate(invoice.periodFrom)} → ${formatDate(invoice.periodTo ?? invoice.periodFrom)}`, margin, metaY + 28);
  }

  // Bill-to block (right side)
  const rightX = pageWidth - margin;
  doc.setFont("helvetica", "bold");
  doc.text("BILL TO", rightX, metaY, { align: "right" });
  doc.setFont("helvetica", "normal");
  doc.text(tenant?.name ?? "—", rightX, metaY + 14, { align: "right" });
  if (tenant?.email) doc.text(tenant.email, rightX, metaY + 28, { align: "right" });
  if (tenant?.phone) doc.text(tenant.phone, rightX, metaY + 42, { align: "right" });

  y = metaY + 50;

  // Unit info
  doc.setFont("helvetica", "bold");
  doc.text(`Unit: ${unit?.unitNumber ?? "—"}  ·  Building: ${building?.name ?? "—"}`, margin, y);
  y += 24;

  // ── Line items table ──
  const tableX = margin;
  const tableW = pageWidth - margin * 2;
  const descW = tableW * 0.6;
  const typeW = tableW * 0.2;
  const amtW = tableW * 0.2;

  // Header row
  doc.setFillColor(240, 244, 248);
  doc.rect(tableX, y, tableW, 24, "F");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.setTextColor(60, 60, 60);
  doc.text("DESCRIPTION", tableX + 8, y + 16);
  doc.text("TYPE", tableX + descW + 8, y + 16);
  doc.text("AMOUNT", tableX + descW + typeW + amtW - 8, y + 16, { align: "right" });
  y += 24;

  // Rows
  doc.setFont("helvetica", "normal");
  doc.setTextColor(20, 20, 20);
  for (const li of invoice.lineItems) {
    if (y > 700) {
      doc.addPage();
      y = margin;
    }
    doc.text(truncate(li.description, 55), tableX + 8, y + 16);
    doc.text(li.type, tableX + descW + 8, y + 16);
    doc.text(BHD(li.amount), tableX + descW + typeW + amtW - 8, y + 16, { align: "right" });
    y += 22;
  }

  // ── Totals box ──
  y += 10;
  const boxX = pageWidth - margin - 220;
  const boxW = 220;
  // Payment deduction rows (Paid / Balance Due) are shown whenever payments
  // exist — the PDF must never imply the tenant still owes the full total.
  const hasPayments = settlement.totalPaid > 0.0005;
  const boxH = hasPayments ? 152 : 110;
  doc.setDrawColor(200, 200, 200);
  doc.setFillColor(250, 250, 252);
  doc.rect(boxX, y, boxW, boxH, "FD");

  let ty = y + 18;
  doc.setFontSize(10);
  doc.text("Subtotal:", boxX + 12, ty);
  doc.text(BHD(invoice.rentAmount ?? invoice.amount), boxX + boxW - 12, ty, { align: "right" });
  ty += 16;
  if (invoice.ewaAmount && invoice.ewaAmount > 0) {
    doc.text("EWA Charges:", boxX + 12, ty);
    doc.text(BHD(invoice.ewaAmount), boxX + boxW - 12, ty, { align: "right" });
    ty += 16;
  }
  if (invoice.maintenanceAmount && invoice.maintenanceAmount > 0) {
    doc.text("Maintenance:", boxX + 12, ty);
    doc.text(BHD(invoice.maintenanceAmount), boxX + boxW - 12, ty, { align: "right" });
    ty += 16;
  }
  if (invoice.previousBalance && invoice.previousBalance > 0) {
    doc.text("Previous Balance:", boxX + 12, ty);
    doc.text(BHD(invoice.previousBalance), boxX + boxW - 12, ty, { align: "right" });
    ty += 16;
  }

  // Invoice total (original amount as issued — never modified by payments)
  ty += 4;
  doc.setFillColor(15, 41, 66);
  doc.rect(boxX, ty - 4, boxW, 26, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(12);
  doc.text("INVOICE TOTAL", boxX + 12, ty + 14);
  doc.text(BHD(settlement.originalAmount), boxX + boxW - 12, ty + 14, { align: "right" });
  doc.setTextColor(20, 20, 20);

  // Payment deduction rows
  if (hasPayments) {
    ty += 6;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.text("Paid:", boxX + 12, ty + 8);
    doc.setTextColor(20, 130, 60);
    doc.text(`−${BHD(settlement.totalPaid)}`, boxX + boxW - 12, ty + 8, { align: "right" });
    ty += 18;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.setTextColor(180, 30, 30);
    doc.text("BALANCE DUE", boxX + 12, ty + 8);
    doc.text(BHD(settlement.remainingBalance), boxX + boxW - 12, ty + 8, { align: "right" });
    doc.setTextColor(20, 20, 20);
  }

  // ── Payment instructions ──
  y = ty + 40;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  doc.text("Payment Instructions", margin, y);
  y += 14;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  const instructions = invoice.paymentInstructions ||
    `Please transfer the total amount to ${companyName} bank account within 5 days of the invoice due date. For any questions, contact us at ${companyEmail}.`;
  const splitInstr = doc.splitTextToSize(instructions, tableW);
  doc.text(splitInstr, margin, y);
  y += splitInstr.length * 12 + 10;

  // ── Footer ──
  doc.setDrawColor(220, 220, 220);
  doc.line(margin, 780, pageWidth - margin, 780);
  doc.setFontSize(8);
  doc.setTextColor(120, 120, 120);
  doc.text(
    `${companyName} — ${companyAddress} — ${companyEmail} — ${companyPhone}`,
    pageWidth / 2,
    795,
    { align: "center" },
  );
  doc.text("Thank you for your business!", pageWidth / 2, 810, { align: "center" });

  return doc;
}

/** Download the PDF as a file. */
export function downloadInvoicePdf(ctx: PdfContext): void {
  const doc = generateInvoicePdf(ctx);
  doc.save(`${ctx.invoice.invoiceNumber}.pdf`);
}

/** Get the PDF as a base64 string (for email attachment). */
export function getInvoicePdfBase64(ctx: PdfContext): string {
  const doc = generateInvoicePdf(ctx);
  const base64 = doc.output("datauristring");
  // datauristring returns "data:application/pdf;filename=...;base64,XXXX"
  const parts = base64.split(",");
  return parts.length > 1 ? parts[parts.length - 1] : base64;
}

function formatDate(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max - 1) + "…" : str;
}
