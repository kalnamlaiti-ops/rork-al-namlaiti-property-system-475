// src/components/reports/ReportPrintBlock.tsx
// Print-friendly report rendering shared by report pages and dialogs.
// The .report-print-area class is picked up by the global print stylesheet:
// when printing, everything else on the page is hidden and only this block
// (header, info tables, data tables with repeated headers) is printed.

import { cn } from "@/lib/utils";
import type { ReportSection } from "@/lib/reportPdf";

interface ReportPrintBlockProps {
  title: string;
  subtitle?: string;
  companyName?: string;
  sections: ReportSection[];
  className?: string;
}

function Section({ section }: { section: ReportSection }) {
  return (
    <div>
      {section.heading && (
        <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-slate-800">{section.heading}</h2>
      )}
      {section.info && section.info.length > 0 && (
        <div className="mb-3 overflow-hidden rounded-md border border-slate-200">
          <table className="w-full text-sm">
            <tbody>
              {section.info.map(([label, value], i) => (
                <tr key={`${label}-${i}`} className={i % 2 === 1 ? "bg-slate-50" : ""}>
                  <td className="w-1/3 px-3 py-2 align-top font-medium text-slate-600">{label}</td>
                  <td className="px-3 py-2 text-slate-900">{value || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {section.columns && section.rows && (
        <>
          {section.rows.length === 0 ? (
            <p className="text-sm text-slate-500">{section.emptyMessage ?? "No records found."}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-xs">
                <thead>
                  <tr>
                    {section.columns.map((c, ci) => (
                      <th
                        key={`${c.label}-${ci}`}
                        className={cn(
                          "border border-slate-300 bg-slate-100 px-2 py-1.5 text-left font-semibold text-slate-700",
                          c.align === "right" && "text-right",
                          c.align === "center" && "text-center",
                        )}
                      >
                        {c.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {section.rows.map((row, ri) => (
                    <tr key={ri} className={ri % 2 === 1 ? "bg-slate-50" : ""}>
                      {row.map((cell, ci) => (
                        <td
                          key={ci}
                          className={cn(
                            "border border-slate-200 px-2 py-1.5 text-slate-900",
                            section.columns![ci]?.align === "right" && "text-right",
                            section.columns![ci]?.align === "center" && "text-center",
                          )}
                        >
                          {cell || "—"}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      {section.totals && section.totals.length > 0 && (
        <div className="mt-2 flex justify-end">
          <table className="text-xs">
            <tbody>
              {section.totals.map(([label, value], ti) => (
                <tr key={label}>
                  <td className="px-3 py-1 text-right font-medium text-slate-600">{label}</td>
                  <td
                    className={cn(
                      "px-3 py-1 text-right",
                      ti === section.totals!.length - 1 ? "font-bold text-slate-900" : "text-slate-700",
                    )}
                  >
                    {value}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function ReportPrintBlock({
  title,
  subtitle,
  companyName = "AL NAMLAITI PROPERTY MANAGEMENT SYSTEM",
  sections,
  className,
}: ReportPrintBlockProps) {
  const today = new Date().toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "long",
    year: "numeric",
  });

  return (
    <div className={cn("report-print-area space-y-5", className)}>
      <div className="border-b-2 border-slate-800 pb-4">
        <p className="text-xs font-semibold uppercase tracking-widest text-slate-500">{companyName}</p>
        <h1 className="mt-1 text-xl font-bold uppercase text-slate-900">{title}</h1>
        {subtitle && <p className="text-sm text-slate-600">{subtitle}</p>}
        <p className="mt-1 text-xs text-slate-500">Report Date: {today}</p>
      </div>

      {sections.map((section, si) => (
        <Section key={`${section.heading ?? "section"}-${si}`} section={section} />
      ))}
    </div>
  );
}
