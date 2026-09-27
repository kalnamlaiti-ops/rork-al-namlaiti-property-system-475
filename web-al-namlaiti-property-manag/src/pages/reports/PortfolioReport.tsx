// src/pages/reports/PortfolioReport.tsx
// Property Management Report — a summary of the whole portfolio computed
// from the live system records. Read-only: nothing here modifies data.

import { useMemo } from "react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ReportPrintBlock } from "@/components/reports/ReportPrintBlock";
import { useData } from "@/context/DataContext";
import { buildPortfolioSummary, portfolioSummaryRows, fmtMoney } from "@/lib/reportData";
import { downloadReportPdf } from "@/lib/reportPdf";
import { openReportPrintWindow } from "@/lib/reportPrint";
import {
  Printer,
  FileDown,
  Building2,
  Home,
  DoorOpen,
  Users,
  FileText,
  CalendarX,
  CalendarClock,
  DollarSign,
  Receipt,
  CreditCard,
  Wallet,
} from "lucide-react";

const sectionTitle = "Property Management Report";

export default function PortfolioReport() {
  const { buildings, units, tenants, leases, invoices, payments, expenses } = useData();

  const summary = useMemo(
    () => buildPortfolioSummary(buildings, units, tenants, leases, invoices, payments, expenses),
    [buildings, units, tenants, leases, invoices, payments, expenses],
  );

  const sections = useMemo(
    () => [{ heading: "Portfolio Summary", info: portfolioSummaryRows(summary) }],
    [summary],
  );

  const handlePrint = () => {
    const ok = openReportPrintWindow({ title: sectionTitle, sections });
    if (!ok) {
      // Fall back to the in-page print stylesheet (report area only).
      window.print();
    }
  };

  const handleDownloadPdf = () => {
    downloadReportPdf(
      { title: sectionTitle.toUpperCase(), sections },
      `property-management-report-${new Date().toISOString().split("T")[0]}.pdf`,
    );
  };

  const metrics = [
    { label: "Total Buildings", value: String(summary.totalBuildings), icon: Building2, tone: "bg-indigo-100 text-indigo-600" },
    { label: "Total Units", value: String(summary.totalUnits), icon: Home, tone: "bg-blue-100 text-blue-600" },
    { label: "Occupied Units", value: String(summary.occupiedUnits), icon: DoorOpen, tone: "bg-emerald-100 text-emerald-600" },
    { label: "Vacant Units", value: String(summary.vacantUnits), icon: CalendarX, tone: "bg-slate-100 text-slate-600" },
    { label: "Total Tenants", value: String(summary.totalTenants), icon: Users, tone: "bg-violet-100 text-violet-600" },
    { label: "Active Leases", value: String(summary.activeLeases), icon: FileText, tone: "bg-emerald-100 text-emerald-600" },
    { label: "Expired Leases", value: String(summary.expiredLeases), icon: CalendarClock, tone: "bg-amber-100 text-amber-600" },
    { label: "Monthly Rental Income", value: fmtMoney(summary.monthlyRentalIncome), icon: DollarSign, tone: "bg-emerald-100 text-emerald-600" },
    { label: "Outstanding Invoices", value: fmtMoney(summary.outstandingInvoices), icon: Receipt, tone: "bg-orange-100 text-orange-600" },
    { label: "Total Payments", value: fmtMoney(summary.totalPayments), icon: CreditCard, tone: "bg-blue-100 text-blue-600" },
    { label: "Total Expenses", value: fmtMoney(summary.totalExpenses), icon: Wallet, tone: "bg-red-100 text-red-600" },
  ];

  return (
    <div className="space-y-6">
      <PageHeader title="Property Management Report" subtitle="Portfolio summary computed from live system records" />

      {/* Actions */}
      <div className="flex flex-wrap items-center gap-2 print:hidden">
        <Button variant="outline" onClick={handlePrint}>
          <Printer className="mr-2 h-4 w-4" /> Print
        </Button>
        <Button onClick={handleDownloadPdf}>
          <FileDown className="mr-2 h-4 w-4" /> Download PDF
        </Button>
      </div>

      {/* Summary metrics */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 print:hidden">
        {metrics.map((m) => (
          <Card key={m.label}>
            <CardContent className="flex items-center justify-between p-5">
              <div>
                <p className="text-sm font-medium text-muted-foreground">{m.label}</p>
                <p className="mt-2 text-xl font-bold text-foreground">{m.value}</p>
              </div>
              <div className={`flex h-10 w-10 items-center justify-center rounded-lg ${m.tone}`}>
                <m.icon className="h-5 w-5" />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Print / PDF fallback version (in-page print stylesheet) */}
      <div className="hidden print:block">
        <ReportPrintBlock title={sectionTitle} sections={sections} />
      </div>
    </div>
  );
}
