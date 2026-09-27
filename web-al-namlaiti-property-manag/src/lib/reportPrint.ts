// src/lib/reportPrint.ts
// Browser print support for reports. Opens a clean print window containing
// ONLY the report (no dashboard chrome), with repeated table headers and
// proper A4 margins. Returns false when pop-ups are blocked so callers can
// fall back to the in-page print stylesheet or the PDF download.

import type { ReportSection } from "./reportPdf";

export interface ReportPrintOptions {
  title: string;
  subtitle?: string;
  companyName?: string;
  sections: ReportSection[];
}

function esc(value: string): string {
  return (value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function sectionHtml(section: ReportSection): string {
  let html = "";
  if (section.heading) {
    html += `<h2 class="section-heading">${esc(section.heading)}</h2>`;
  }
  if (section.info && section.info.length > 0) {
    html += `<table class="info-table"><tbody>`;
    section.info.forEach(([label, value], i) => {
      html += `<tr class="${i % 2 === 1 ? "alt" : ""}"><td class="label">${esc(label)}</td><td>${esc(value || "—")}</td></tr>`;
    });
    html += `</tbody></table>`;
  }
  if (section.columns && section.rows) {
    if (section.rows.length === 0) {
      html += `<p class="empty">${esc(section.emptyMessage ?? "No records found.")}</p>`;
    } else {
      const totalWeight = section.columns.reduce((s, c) => s + (c.width || 1), 0) || 1;
      html += `<table class="data-table"><colgroup>${section.columns
        .map((c) => `<col style="width:${((c.width || 1) / totalWeight) * 100}%" />`)
        .join("")}</colgroup>`;
      html += `<thead><tr>${section.columns
        .map(
          (c) =>
            `<th class="${c.align === "right" ? "right" : c.align === "center" ? "center" : ""}">${esc(c.label)}</th>`,
        )
        .join("")}</tr></thead><tbody>`;
      section.rows.forEach((row, ri) => {
        html += `<tr class="${ri % 2 === 1 ? "alt" : ""}">${row
          .map(
            (cell, ci) =>
              `<td class="${section.columns![ci]?.align === "right" ? "right" : section.columns![ci]?.align === "center" ? "center" : ""}">${esc(cell || "—")}</td>`,
          )
          .join("")}</tr>`;
      });
      html += `</tbody></table>`;
    }
  }
  if (section.totals && section.totals.length > 0) {
    html += `<table class="totals"><tbody>`;
    section.totals.forEach(([label, value], i) => {
      const last = i === section.totals!.length - 1;
      html += `<tr><td class="label">${esc(label)}</td><td class="${last ? "grand" : "value"}">${esc(value)}</td></tr>`;
    });
    html += `</tbody></table>`;
  }
  return html;
}

export function buildReportPrintHtml(o: ReportPrintOptions): string {
  const company = o.companyName ?? "AL NAMLAITI PROPERTY MANAGEMENT SYSTEM";
  const today = new Date().toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "long",
    year: "numeric",
  });

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>${esc(o.title)}</title>
<style>
  @page { size: A4; margin: 14mm 12mm; }
  * { box-sizing: border-box; }
  body { font-family: "Segoe UI", Arial, Helvetica, sans-serif; color: #111827; margin: 0; font-size: 11px; }
  .report-header { border-bottom: 2px solid #0f2942; padding-bottom: 10px; margin-bottom: 16px; }
  .report-header .company { font-size: 10px; font-weight: 700; letter-spacing: 1.5px; color: #6b7280; text-transform: uppercase; }
  .report-header h1 { font-size: 18px; margin: 4px 0 2px; text-transform: uppercase; color: #0f2942; }
  .report-header .subtitle { font-size: 11px; color: #374151; }
  .report-header .date { font-size: 10px; color: #6b7280; margin-top: 2px; }
  h2.section-heading { font-size: 12px; color: #0f2942; text-transform: uppercase; letter-spacing: 0.5px; margin: 18px 0 6px; border-bottom: 1.5px solid #0f2942; display: inline-block; padding-bottom: 2px; }
  table { width: 100%; border-collapse: collapse; }
  .info-table td { border: 1px solid #d1d5db; padding: 4px 8px; font-size: 11px; }
  .info-table td.label { font-weight: 600; color: #4b5563; width: 32%; background: #f9fafb; }
  .info-table tr.alt td { background: #f3f4f6; }
  .data-table th { background: #eef2f7; border: 1px solid #cbd5e1; padding: 5px 6px; text-align: left; font-size: 10px; color: #374151; }
  .data-table th.right { text-align: right; }
  .data-table th.center { text-align: center; }
  .data-table td { border: 1px solid #e2e8f0; padding: 4px 6px; font-size: 10.5px; }
  .data-table td.right { text-align: right; }
  .data-table td.center { text-align: center; }
  .data-table tr.alt td { background: #f7f9fc; }
  .data-table thead { display: table-header-group; }
  .data-table tr { page-break-inside: avoid; }
  .empty { color: #6b7280; font-style: italic; }
  table.totals { width: auto; margin-left: auto; margin-top: 8px; }
  table.totals td { padding: 4px 10px; font-size: 11px; }
  table.totals td.label { text-align: right; color: #4b5563; font-weight: 600; }
  table.totals td.value { text-align: right; font-weight: 600; }
  table.totals td.grand { background: #0f2942; color: #ffffff; font-weight: 700; }
  .report-footer { margin-top: 18px; border-top: 1px solid #d1d5db; padding-top: 6px; font-size: 9px; color: #6b7280; }
</style>
</head>
<body>
  <div class="report-header">
    <div class="company">${esc(company)}</div>
    <h1>${esc(o.title)}</h1>
    ${o.subtitle ? `<div class="subtitle">${esc(o.subtitle)}</div>` : ""}
    <div class="date">Report Date: ${esc(today)}</div>
  </div>
  ${(o.sections ?? []).map(sectionHtml).join("\n")}
  <div class="report-footer">${esc(company)} — generated ${esc(today)}</div>
</body>
</html>`;
}

/**
 * Open a print-friendly window with only the report and trigger the browser
 * print dialog. Returns false when the pop-up is blocked.
 */
export function openReportPrintWindow(o: ReportPrintOptions): boolean {
  const win = window.open("", "_blank", "width=1000,height=760");
  if (!win) return false;

  win.document.open();
  win.document.write(buildReportPrintHtml(o));
  win.document.close();
  win.focus();

  const trigger = () => {
    window.setTimeout(() => {
      try {
        win.focus();
        win.print();
      } catch {
        // Printing is best-effort; the user can still print manually (Ctrl+P).
      }
    }, 200);
  };
  if (win.document.readyState === "complete") trigger();
  else win.addEventListener("load", trigger);
  return true;
}
