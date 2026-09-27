// src/lib/reportPdf.ts
// Professional multi-page report PDFs (tenant lists, lease lists, portfolio
// summaries, individual tenant/lease reports) built with jsPDF.
// Tables repeat their header on every page, include page numbers and the
// report date, and handle large datasets. Read-only: nothing here mutates data.

import { jsPDF } from "jspdf";

export interface ReportColumn {
  label: string;
  /** Relative width weight (normalized to the printable area). */
  width: number;
  align?: "left" | "center" | "right";
}

export interface ReportSection {
  /** Optional section title. */
  heading?: string;
  /** Key/value rows rendered as a two-column info block. */
  info?: [string, string][];
  /** Table rendered below the heading. */
  columns?: ReportColumn[];
  rows?: string[][];
  /** Totals pairs rendered under the table. */
  totals?: [string, string][];
  /** Message shown when the table has no rows. */
  emptyMessage?: string;
}

export interface ReportPdfOptions {
  /** Report title, e.g. "TENANT LIST". */
  title: string;
  subtitle?: string;
  companyName?: string;
  /** Main table (list reports). */
  columns?: ReportColumn[];
  rows?: string[][];
  /** Info/table sections (individual & portfolio reports). */
  sections?: ReportSection[];
  /** Page orientation — landscape for wide rent-roll tables. */
  orientation?: "portrait" | "landscape";
  footerNote?: string;
}

const PAGE_MARGIN = 40;
const HEADER_BAND = 72;
const NAVY = { r: 15, g: 41, b: 66 } as const;

/** Usable content bottom edge — works for portrait AND landscape pages. */
function bottomLimitOf(doc: jsPDF): number {
  return doc.internal.pageSize.getHeight() - 54;
}

function setNavyFill(doc: jsPDF) {
  doc.setFillColor(NAVY.r, NAVY.g, NAVY.b);
}
function setNavyText(doc: jsPDF) {
  doc.setTextColor(NAVY.r, NAVY.g, NAVY.b);
}

function drawPageHeader(doc: jsPDF, o: ReportPdfOptions, dateLabel: string) {
  const pageWidth = doc.internal.pageSize.getWidth();
  const company = o.companyName ?? "AL NAMLAITI PROPERTY MANAGEMENT SYSTEM";

  setNavyFill(doc);
  doc.rect(0, 0, pageWidth, HEADER_BAND, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(15);
  doc.text(company, PAGE_MARGIN, 32);
  doc.setFontSize(10);
  doc.setFont("helvetica", "normal");
  doc.text(dateLabel, pageWidth - PAGE_MARGIN, 32, { align: "right" });
  doc.setFont("helvetica", "bold");
  doc.setFontSize(13);
  doc.text(o.title.toUpperCase(), PAGE_MARGIN, 52);
  if (o.subtitle) {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor(220, 224, 230);
    doc.text(o.subtitle, PAGE_MARGIN, 64);
  }
  doc.setTextColor(20, 20, 20);
}

function drawFooters(doc: jsPDF, o: ReportPdfOptions, dateLabel: string) {
  const pageWidth = doc.internal.pageSize.getWidth();
  const total = doc.getNumberOfPages();
  for (let i = 1; i <= total; i += 1) {
    doc.setPage(i);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(120, 120, 120);
    doc.setDrawColor(215, 215, 215);
    const pageHeight = doc.internal.pageSize.getHeight();
    doc.line(PAGE_MARGIN, pageHeight - 42, pageWidth - PAGE_MARGIN, pageHeight - 42);
    doc.text(`Report date: ${dateLabel}`, PAGE_MARGIN, pageHeight - 30);
    doc.text(`Page ${i} of ${total}`, pageWidth - PAGE_MARGIN, pageHeight - 30, { align: "right" });
    if (o.footerNote) {
      doc.text(doc.splitTextToSize(o.footerNote, pageWidth - PAGE_MARGIN * 2 - 120)[0] ?? o.footerNote, pageWidth / 2, pageHeight - 30, {
        align: "center",
      });
    }
  }
}

/** Normalize column weights into absolute widths inside the printable area. */
function columnWidths(doc: jsPDF, columns: ReportColumn[]): number[] {
  const tableW = doc.internal.pageSize.getWidth() - PAGE_MARGIN * 2;
  const totalWeight = columns.reduce((s, c) => s + (c.width || 1), 0) || 1;
  return columns.map((c) => (tableW * (c.width || 1)) / totalWeight);
}

function drawTable(
  doc: jsPDF,
  columns: ReportColumn[],
  rows: string[][],
  startY: number,
): number {
  let y = startY;
  const pageWidth = doc.internal.pageSize.getWidth();
  const tableW = pageWidth - PAGE_MARGIN * 2;
  const widths = columnWidths(doc, columns);
  const lineH = 11;

  const drawHeaderRow = () => {
    doc.setFillColor(238, 242, 247);
    doc.rect(PAGE_MARGIN, y, tableW, 20, "F");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(8);
    doc.setTextColor(55, 65, 81);
    let x = PAGE_MARGIN;
    columns.forEach((c, i) => {
      const w = widths[i];
      const labelX = c.align === "right" ? x + w - 5 : c.align === "center" ? x + w / 2 : x + 5;
      doc.text(c.label, labelX, y + 13, {
        align: c.align === "right" ? "right" : c.align === "center" ? "center" : "left",
      });
      x += w;
    });
    doc.setTextColor(20, 20, 20);
    y += 20;
  };

  drawHeaderRow();
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);

  rows.forEach((row, rowIndex) => {
    // Wrapped cell lines per column.
    const cellLines = row.map((cell, i) =>
      doc.splitTextToSize(cell ?? "—", widths[i] - 10),
    );
    const maxLines = Math.max(1, ...cellLines.map((l) => l.length));
    const rowH = maxLines * lineH + 8;

    if (y + rowH > bottomLimitOf(doc)) {
      doc.addPage();
      y = HEADER_BAND + 24;
      drawHeaderRow();
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8);
    }

    if (rowIndex % 2 === 1) {
      doc.setFillColor(247, 249, 252);
      doc.rect(PAGE_MARGIN, y, tableW, rowH, "F");
    }

    let x = PAGE_MARGIN;
    columns.forEach((c, i) => {
      const w = widths[i];
      const lines = cellLines[i];
      const textX = c.align === "right" ? x + w - 5 : c.align === "center" ? x + w / 2 : x + 5;
      doc.text(lines, textX, y + 12, {
        align: c.align === "right" ? "right" : c.align === "center" ? "center" : "left",
      });
      x += w;
    });

    doc.setDrawColor(226, 230, 236);
    doc.line(PAGE_MARGIN, y + rowH, pageWidth - PAGE_MARGIN, y + rowH);
    y += rowH;
  });

  return y;
}

function drawInfoBlock(doc: jsPDF, info: [string, string][], startY: number): number {
  let y = startY;
  const pageWidth = doc.internal.pageSize.getWidth();
  const tableW = pageWidth - PAGE_MARGIN * 2;
  const labelW = Math.min(170, tableW * 0.32);
  const lineH = 14;

  doc.setDrawColor(226, 230, 236);
  info.forEach(([label, value], idx) => {
    const valueLines = doc.splitTextToSize(value || "—", tableW - labelW - 14);
    const rowH = Math.max(lineH, valueLines.length * lineH + 2);
    if (y + rowH > bottomLimitOf(doc)) {
      doc.addPage();
      y = HEADER_BAND + 24;
    }
    if (idx % 2 === 0) {
      doc.setFillColor(247, 249, 252);
      doc.rect(PAGE_MARGIN, y, tableW, rowH, "F");
    }
    doc.setFont("helvetica", "bold");
    doc.setFontSize(8.5);
    doc.setTextColor(75, 85, 99);
    doc.text(label, PAGE_MARGIN + 6, y + 11);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(20, 20, 20);
    doc.text(valueLines, PAGE_MARGIN + labelW + 6, y + 11);
    y += rowH;
  });

  return y;
}

function drawSectionHeading(doc: jsPDF, text: string, startY: number): number {
  let y = startY;
  if (y + 34 > bottomLimitOf(doc)) {
    doc.addPage();
    y = HEADER_BAND + 24;
  }
  setNavyText(doc);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.text(text, PAGE_MARGIN, y + 12);
  doc.setDrawColor(NAVY.r, NAVY.g, NAVY.b);
  doc.line(PAGE_MARGIN, y + 17, PAGE_MARGIN + doc.getTextWidth(text), y + 17);
  doc.setTextColor(20, 20, 20);
  return y + 26;
}

function drawTotals(doc: jsPDF, totals: [string, string][], startY: number): number {
  let y = startY + 6;
  const pageWidth = doc.internal.pageSize.getWidth();
  const boxX = pageWidth - PAGE_MARGIN - 240;
  totals.forEach(([label, value], idx) => {
    const isLast = idx === totals.length - 1;
    if (y + 20 > bottomLimitOf(doc)) {
      doc.addPage();
      y = HEADER_BAND + 24;
    }
    if (isLast) {
      setNavyFill(doc);
      doc.rect(boxX, y, 240, 20, "F");
      doc.setTextColor(255, 255, 255);
      doc.setFont("helvetica", "bold");
    } else {
      doc.setFillColor(247, 249, 252);
      doc.rect(boxX, y, 240, 20, "F");
      doc.setTextColor(20, 20, 20);
      doc.setFont("helvetica", "normal");
    }
    doc.setFontSize(9);
    doc.text(label, boxX + 8, y + 13);
    doc.text(value, boxX + 232, y + 13, { align: "right" });
    y += 20;
  });
  doc.setTextColor(20, 20, 20);
  return y;
}

/** Build the report PDF (multi-page, repeated table headers, page numbers). */
export function buildReportPdf(o: ReportPdfOptions): jsPDF {
  const doc = new jsPDF({ unit: "pt", format: "a4", orientation: o.orientation ?? "portrait" });
  const dateLabel = new Date().toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "long",
    year: "numeric",
  });

  drawPageHeader(doc, o, dateLabel);
  let y = HEADER_BAND + 30;

  if (o.columns && o.rows) {
    if (o.rows.length === 0) {
      doc.setFont("helvetica", "normal");
      doc.setFontSize(10);
      doc.setTextColor(110, 118, 130);
      doc.text("No records found for the selected filters.", PAGE_MARGIN, y + 10);
      doc.setTextColor(20, 20, 20);
    } else {
      y = drawTable(doc, o.columns, o.rows, y);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(9);
      doc.setTextColor(75, 85, 99);
      y = drawTotals(doc, [["Total Records", String(o.rows.length)]], y + 8);
      doc.setTextColor(20, 20, 20);
    }
  }

  for (const section of o.sections ?? []) {
    if (section.heading) {
      y = drawSectionHeading(doc, section.heading, y);
    }
    if (section.info) {
      y = drawInfoBlock(doc, section.info, y) + 14;
    }
    if (section.columns && section.rows) {
      if (section.rows.length === 0) {
        doc.setFont("helvetica", "normal");
        doc.setFontSize(9);
        doc.setTextColor(110, 118, 130);
        doc.text("No records found.", PAGE_MARGIN, y + 6);
        doc.setTextColor(20, 20, 20);
        y += 22;
      } else {
        y = drawTable(doc, section.columns, section.rows, y);
      }
    }
    if (section.totals) {
      y = drawTotals(doc, section.totals, y) + 12;
    } else {
      y += 10;
    }
  }

  drawFooters(doc, o, dateLabel);
  return doc;
}

/** Generate and download the report PDF. */
export function downloadReportPdf(o: ReportPdfOptions, fileName: string): void {
  buildReportPdf(o).save(fileName);
}
