// src/lib/receiptPdf.ts
// Professional payment receipt PDF, replicating the Namlity General Trading
// receipt template (A5 landscape, bordered box, left company header, dotted
// field leaders, signature + BD/Fils area). Read-only: resolves all data from
// the existing payment → tenant → lease → building/unit → invoice records and
// never mutates anything.

import { jsPDF } from "jspdf";
import { format } from "date-fns";
import { formatPeriodLabel } from "./invoiceGenerator";
import type { Building, Invoice, Lease, Payment, Tenant, Unit } from "@/types";

// ── Company header (from the uploaded receipt template) ──
export const RECEIPT_COMPANY = {
  name: "NAMLITY GENERAL TRADING EST.",
  road: "Palace Road",
  tagline: "IMPORTERS & GENERAL MERCHANTS",
  tel: "Tel. : 17253953 (Office)",
  email: "Email : namlity@gmail.com",
  poBox: "P.O.Box 673",
  city: "Manama",
  country: "Kingdom of Bahrain",
} as const;

export interface ReceiptDataContext {
  invoices: Invoice[];
  leases: Lease[];
  units: Unit[];
  buildings: Building[];
  getTenantById: (id: string) => Tenant | undefined;
}

export interface ReceiptInfo {
  receiptNumber: string;
  /** Payment date formatted DD/MM/YYYY. */
  dateLabel: string;
  tenantName: string;
  tenantPhone: string;
  tenantEmail: string;
  /** Payment amount formatted to 3 decimals (BHD/Fils), e.g. "140.000". */
  amountLabel: string;
  /** Integer dinars part, e.g. "140". */
  bdPart: string;
  /** Fils part (3 digits), e.g. "000". */
  filsPart: string;
  /** "By Cash" / "By Cheque No.: X" / "By Bank Transfer". */
  methodLine: string;
  /** In-settlement-of description built from the invoice / payment record. */
  settlement: string;
  buildingLabel?: string;
  unitLabel?: string;
  contractLabel?: string;
}

/** Format an amount with exactly 3 decimals — Bahraini dinar / fils precision. */
export function formatBhd3(amount: number): string {
  return amount.toLocaleString("en-BH", { minimumFractionDigits: 3, maximumFractionDigits: 3 });
}

/** Build every receipt field from real records — no manual typing required. */
export function resolveReceiptInfo(payment: Payment, ctx: ReceiptDataContext): ReceiptInfo {
  const tenant = ctx.getTenantById(payment.tenantId);
  const invoice = ctx.invoices.find((i) => i.id === payment.invoiceId);
  const lease = invoice
    ? ctx.leases.find((l) => l.id === invoice.leaseId)
    : ctx.leases.find((l) => l.tenantId === payment.tenantId);
  const unit = ctx.units.find(
    (u) => u.id === (invoice?.unitId ?? lease?.unitId),
  );
  const building = ctx.buildings.find(
    (b) => b.id === (unit?.buildingId ?? tenant?.buildingId ?? lease?.buildingNumber),
  );

  // Amount BD / Fils — 3 decimals, never incorrectly rounded.
  const amountLabel = formatBhd3(payment.amount);
  const [bdPart = "0", filsPart = "000"] = amountLabel.split(".");

  // Payment method line — cheque number comes from the payment's reference
  // field (labelled "Reference / Cheque #" in the payment form).
  const reference = (payment.reference ?? "").trim();
  let methodLine: string;
  if (payment.method === "Cash") {
    methodLine = "By Cash";
  } else if (payment.method === "Cheque") {
    methodLine = reference ? `By Cheque No. : ${reference}` : "By Cheque";
  } else {
    methodLine = reference ? `By ${payment.method} — ${reference}` : `By ${payment.method}`;
  }

  // In settlement of — derived from the invoice line items (description +
  // billing period) or the invoice number, falling back to payment notes.
  let settlement = "";
  if (invoice) {
    const descriptions = Array.from(
      new Set(invoice.lineItems.map((li) => li.description.trim()).filter(Boolean)),
    );
    const periodKey = invoice.periodFrom
      ? `${invoice.periodFrom.slice(0, 4)}-${invoice.periodFrom.slice(5, 7)}`
      : "";
    const periodLabel = periodKey ? formatPeriodLabel(periodKey) : "";
    if (descriptions.length > 0) {
      settlement = descriptions.join(", ");
      if (periodLabel && !settlement.toLowerCase().includes(periodLabel.toLowerCase())) {
        settlement = `${settlement} — ${periodLabel}`;
      }
    } else {
      settlement = periodLabel ? `Invoice ${invoice.invoiceNumber} — ${periodLabel}` : `Invoice ${invoice.invoiceNumber}`;
    }
  } else {
    settlement = (payment.notes ?? "").split("\n")[0]?.trim() || "Rent Payment";
  }

  return {
    receiptNumber: payment.receiptNumber,
    dateLabel: format(new Date(payment.paymentDate), "dd/MM/yyyy"),
    tenantName: tenant?.name ?? "—",
    tenantPhone: tenant?.phone ?? "",
    tenantEmail: tenant?.email ?? "",
    amountLabel,
    bdPart,
    filsPart,
    methodLine,
    settlement,
    buildingLabel: building ? (building.buildingNumber || building.name) : undefined,
    unitLabel: unit?.unitNumber,
    contractLabel: lease?.contractNumber,
  };
}

/** Receipt_RCP-2026-000001_SHARMILA_RAMESH.pdf */
export function receiptFileName(info: ReceiptInfo): string {
  const tenantSlug = info.tenantName.trim().replace(/[^\p{L}\p{N}]+/gu, "_").replace(/^_+|_+$/g, "");
  return `Receipt_${info.receiptNumber}_${tenantSlug || "Tenant"}.pdf`;
}

const PAGE_W = 595.28; // A5 landscape — same size as the uploaded receipt
const PAGE_H = 425.2;
const BOX_MARGIN = 14;
const INNER = 18; // padding inside the outer box

/**
 * Build the receipt PDF. Single page, exactly matching the uploaded template:
 * outer border, company header left, Date/No. top-right, RECEIPT title between
 * rules, dotted field leaders, signature + BD/Fils block at the bottom.
 */
export function buildReceiptPdf(info: ReceiptInfo, autoPrint = false): jsPDF {
  const doc = new jsPDF({
    orientation: "landscape",
    unit: "pt",
    format: [PAGE_W, PAGE_H] as [number, number],
  });
  if (autoPrint) doc.autoPrint();

  const left = BOX_MARGIN;
  const right = PAGE_W - BOX_MARGIN;
  const contentLeft = left + INNER;
  const contentRight = right - INNER;
  const centerX = PAGE_W / 2;

  // ── Outer border ──
  doc.setLineWidth(1.4);
  doc.rect(left, left, right - left, PAGE_H - left * 2);

  // ── Company header (left block, centered) ──
  const companyCenterX = left + 155;
  let y = 34;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(11.5);
  doc.text(RECEIPT_COMPANY.name, companyCenterX, y, { align: "center" });
  y += 14;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9.5);
  doc.text(RECEIPT_COMPANY.road, companyCenterX, y, { align: "center" });
  y += 13;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9.5);
  doc.text(RECEIPT_COMPANY.tagline, companyCenterX, y, { align: "center" });
  y += 17;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8.5);
  doc.text(RECEIPT_COMPANY.tel, companyCenterX, y, { align: "center" });
  y += 12;
  doc.text(RECEIPT_COMPANY.email, companyCenterX, y, { align: "center" });
  y += 12;
  doc.text(RECEIPT_COMPANY.poBox, companyCenterX, y, { align: "center" });
  y += 12;
  doc.text(RECEIPT_COMPANY.city, companyCenterX, y, { align: "center" });
  y += 12;
  doc.text(RECEIPT_COMPANY.country, companyCenterX, y, { align: "center" });

  // ── Date & Receipt No. (top right) ──
  doc.setFont("helvetica", "normal");
  doc.setFontSize(10.5);
  doc.text(`Date : ${info.dateLabel}`, contentRight, 40, { align: "right" });
  doc.text(`No. : ${info.receiptNumber}`, contentRight, 58, { align: "right" });

  // ── Header divider ──
  doc.setLineWidth(0.9);
  doc.line(contentLeft, 138, contentRight, 138);

  // ── RECEIPT title between rules ──
  doc.setLineWidth(1.1);
  doc.line(contentLeft, 150, contentRight, 150);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(19);
  doc.text("RECEIPT", centerX, 170, { align: "center" });
  doc.setLineWidth(1.1);
  doc.line(contentLeft, 181, contentRight, 181);

  // ── Dotted leader helper ──
  const dottedLine = (fromX: number, toX: number, atY: number) => {
    if (toX - fromX < 14) return;
    doc.setLineWidth(0.7);
    doc.setLineDashPattern([0.8, 2.4], 0);
    doc.line(fromX, atY, toX, atY);
    doc.setLineDashPattern([], 0);
  };

  const labelSize = 11;
  let fy = 210;
  const lineH = 26;

  const field = (label: string, value: string) => {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(labelSize);
    const labelEnd = contentLeft + doc.getTextWidth(`${label} : `);
    doc.text(`${label} : `, contentLeft, fy);
    doc.setFont("helvetica", "bold");
    const valueLines = doc.splitTextToSize(value, contentRight - labelEnd - 24);
    const firstLine = String(valueLines[0] ?? "");
    doc.text(firstLine, labelEnd + 6, fy);
    dottedLine(labelEnd + 12 + doc.getTextWidth(firstLine), contentRight, fy - 2);
    // Wrapped continuation lines keep the dots style of the template.
    for (let i = 1; i < valueLines.length; i += 1) {
      fy += lineH - 4;
      dottedLine(contentLeft, contentRight, fy - 2);
      doc.text(String(valueLines[i]), contentLeft + 6, fy);
    }
    fy += lineH;
  };

  field("Received from", info.tenantName);
  field("Amount BD", info.amountLabel);
  field("By Cash / Cheque No.", info.methodLine);
  field("In settlement of", info.settlement);

  // ── Property reference line (small, under the settlement line) ──
  const propertyParts: string[] = [];
  if (info.buildingLabel) propertyParts.push(`Building: ${info.buildingLabel}`);
  if (info.unitLabel) propertyParts.push(`Unit: ${info.unitLabel}`);
  if (info.contractLabel) propertyParts.push(`Contract: ${info.contractLabel}`);
  if (propertyParts.length > 0) {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.text(propertyParts.join("      "), contentLeft + 6, fy - 8);
  }

  // ── Signature + BD/Fils block (bottom left, like the template) ──
  const sigY = PAGE_H - 58;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(11);
  doc.text("Signature", contentLeft, sigY);
  dottedLine(contentLeft + 58, contentLeft + 250, sigY - 2);

  const amtY = PAGE_H - 32;
  doc.setFontSize(11);
  doc.text("Amount", contentLeft, amtY);
  doc.text("BD.", contentLeft + 70, amtY);
  doc.setFont("helvetica", "bold");
  doc.text(info.bdPart, contentLeft + 94, amtY);
  doc.setFont("helvetica", "normal");
  dottedLine(contentLeft + 100 + doc.getTextWidth(info.bdPart), contentLeft + 200, amtY - 2);
  doc.text("Fils", contentLeft + 212, amtY);
  doc.setFont("helvetica", "bold");
  doc.text(info.filsPart, contentLeft + 236, amtY);
  doc.setFont("helvetica", "normal");
  dottedLine(contentLeft + 242 + doc.getTextWidth(info.filsPart), contentLeft + 340, amtY - 2);

  return doc;
}

/** Receipt PDF as base64 (for WhatsApp / email attachments). */
export function getReceiptPdfBase64(info: ReceiptInfo): string {
  const dataUri = buildReceiptPdf(info).output("datauristring");
  const marker = "base64,";
  const idx = dataUri.indexOf(marker);
  return idx >= 0 ? dataUri.slice(idx + marker.length) : dataUri;
}

/** Generate and immediately download the receipt PDF. */
export function downloadReceiptPdf(info: ReceiptInfo): void {
  buildReceiptPdf(info).save(receiptFileName(info));
}

/**
 * Open a print window containing ONLY the receipt PDF (no dashboard chrome)
 * and trigger the print dialog. Returns false when pop-ups are blocked.
 */
export function printReceiptPdf(info: ReceiptInfo): boolean {
  const doc = buildReceiptPdf(info, true);
  const url = doc.output("bloburl") as unknown as string;
  const win = window.open(url, "_blank");
  return Boolean(win);
}
