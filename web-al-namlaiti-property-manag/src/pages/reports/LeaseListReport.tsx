// src/pages/reports/LeaseListReport.tsx
// Full Lease List report — every lease in the system, with search, filters
// (building / status / tenant / date range), sorting, print and PDF export.
// Read-only: nothing here modifies data.

import { useMemo, useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ReportPrintBlock } from "@/components/reports/ReportPrintBlock";
import { useData } from "@/context/DataContext";
import { buildLeaseReportRows } from "@/lib/reportData";
import type { LeaseReportRow } from "@/lib/reportData";
import { downloadReportPdf } from "@/lib/reportPdf";
import type { ReportColumn } from "@/lib/reportPdf";
import { openReportPrintWindow } from "@/lib/reportPrint";
import { Download, FileDown, Printer, Search, X } from "lucide-react";

const pdfColumns: ReportColumn[] = [
  { label: "Contract Number", width: 1.7 },
  { label: "Tenant Name", width: 1.8 },
  { label: "Tenant Phone", width: 1.4 },
  { label: "CPR Number", width: 1.2 },
  { label: "Building", width: 1.6 },
  { label: "Unit", width: 0.9 },
  { label: "Road", width: 1.5 },
  { label: "Start Date", width: 1.2 },
  { label: "End Date", width: 1.2 },
  { label: "Monthly Rent", width: 1.2, align: "right" },
  { label: "Security Deposit", width: 1.2, align: "right" },
  { label: "Lease Status", width: 1.1 },
];

type SortKey =
  | "contract-asc"
  | "contract-desc"
  | "start-desc"
  | "start-asc"
  | "rent-desc"
  | "rent-asc"
  | "status";

const sortOptions: { value: SortKey; label: string }[] = [
  { value: "contract-asc", label: "Contract # (A–Z)" },
  { value: "contract-desc", label: "Contract # (Z–A)" },
  { value: "start-desc", label: "Start Date (newest)" },
  { value: "start-asc", label: "Start Date (oldest)" },
  { value: "rent-desc", label: "Monthly Rent (high–low)" },
  { value: "rent-asc", label: "Monthly Rent (low–high)" },
  { value: "status", label: "Status" },
];

const selectClass =
  "h-10 rounded-md border border-input bg-background px-3 text-sm text-foreground";

export default function LeaseListReport() {
  const { leases, tenants, units, buildings } = useData();
  const [search, setSearch] = useState("");
  const [buildingFilter, setBuildingFilter] = useState("All");
  const [statusFilter, setStatusFilter] = useState("All");
  const [tenantFilter, setTenantFilter] = useState("All");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("contract-asc");

  // Complete unfiltered list — built from ALL leases.
  const allRows = useMemo(
    () => buildLeaseReportRows(leases, tenants, units, buildings),
    [leases, tenants, units, buildings],
  );

  const buildingNames = useMemo(
    () => Array.from(new Set(buildings.map((b) => b.name))).sort(),
    [buildings],
  );
  const tenantNames = useMemo(
    () => Array.from(new Set(tenants.map((t) => t.name))).sort(),
    [tenants],
  );

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const rows = allRows.filter((r) => {
      const matchesSearch =
        !q ||
        r.contractNumber.toLowerCase().includes(q) ||
        r.tenantName.toLowerCase().includes(q) ||
        r.tenantPhone.toLowerCase().includes(q) ||
        r.cpr.toLowerCase().includes(q) ||
        r.unit.toLowerCase().includes(q);
      const matchesBuilding = buildingFilter === "All" || r.building === buildingFilter;
      const matchesStatus = statusFilter === "All" || r.status === statusFilter;
      const matchesTenant = tenantFilter === "All" || r.tenantName === tenantFilter;
      const matchesFrom = !dateFrom || r.startIso >= dateFrom;
      const matchesTo = !dateTo || r.startIso <= dateTo;
      return matchesSearch && matchesBuilding && matchesStatus && matchesTenant && matchesFrom && matchesTo;
    });
    const sorted = [...rows];
    switch (sortKey) {
      case "contract-desc":
        sorted.sort((a, b) => b.contractNumber.localeCompare(a.contractNumber));
        break;
      case "start-desc":
        sorted.sort((a, b) => b.startIso.localeCompare(a.startIso));
        break;
      case "start-asc":
        sorted.sort((a, b) => a.startIso.localeCompare(b.startIso));
        break;
      case "rent-desc":
        sorted.sort((a, b) => b.rentValue - a.rentValue);
        break;
      case "rent-asc":
        sorted.sort((a, b) => a.rentValue - b.rentValue);
        break;
      case "status":
        sorted.sort((a, b) => a.status.localeCompare(b.status) || a.contractNumber.localeCompare(b.contractNumber));
        break;
      default:
        sorted.sort((a, b) => a.contractNumber.localeCompare(b.contractNumber));
    }
    return sorted;
  }, [allRows, search, buildingFilter, statusFilter, tenantFilter, dateFrom, dateTo, sortKey]);

  const hasFilters =
    search.trim() !== "" ||
    buildingFilter !== "All" ||
    statusFilter !== "All" ||
    tenantFilter !== "All" ||
    dateFrom !== "" ||
    dateTo !== "";

  const clearFilters = () => {
    setSearch("");
    setBuildingFilter("All");
    setStatusFilter("All");
    setTenantFilter("All");
    setDateFrom("");
    setDateTo("");
    setSortKey("contract-asc");
  };

  const rowsToStrings = (rows: LeaseReportRow[]) =>
    rows.map((r) => [
      r.contractNumber,
      r.tenantName,
      r.tenantPhone,
      r.cpr,
      r.building,
      r.unit,
      r.road,
      r.startDate,
      r.endDate,
      r.rent,
      r.deposit,
      r.status,
    ]);

  const subtitleFor = (rows: LeaseReportRow[], scope: string) => `${rows.length} lease(s) — ${scope}`;

  const handlePrint = (rows: LeaseReportRow[], scope: string) => {
    const ok = openReportPrintWindow({
      title: "Lease List",
      subtitle: subtitleFor(rows, scope),
      sections: [{ columns: pdfColumns, rows: rowsToStrings(rows) }],
    });
    if (!ok) window.print();
  };

  const handleDownloadPdf = (rows: LeaseReportRow[], scope: string) => {
    downloadReportPdf(
      {
        title: "LEASE LIST",
        subtitle: subtitleFor(rows, scope),
        columns: pdfColumns,
        rows: rowsToStrings(rows),
        footerNote: "Generated by Al Namlaiti Property Management System",
      },
      `lease-list-${new Date().toISOString().split("T")[0]}.pdf`,
    );
  };

  return (
    <div className="space-y-6">
      <PageHeader title="Full Lease List" subtitle="Complete list of all leases stored in the system" />

      {/* Actions */}
      <div className="flex flex-wrap items-center gap-2 print:hidden">
        <Button variant="outline" onClick={() => handlePrint(filteredRows, hasFilters ? "filtered" : "all leases")}>
          <Printer className="mr-2 h-4 w-4" /> Print
        </Button>
        <Button onClick={() => handleDownloadPdf(filteredRows, hasFilters ? "filtered" : "all leases")}>
          <FileDown className="mr-2 h-4 w-4" /> Download PDF
        </Button>
        <Button variant="secondary" onClick={() => handleDownloadPdf(allRows, "complete list")}>
          <Download className="mr-2 h-4 w-4" /> Export All
        </Button>
        <span className="ml-auto text-sm text-muted-foreground">
          Showing {filteredRows.length} of {leases.length} lease(s)
        </span>
      </div>

      {/* Filters */}
      <Card className="print:hidden">
        <CardContent className="flex flex-col gap-3 p-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search contract, tenant, phone, CPR, unit..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-9"
              />
            </div>
            <select value={buildingFilter} onChange={(e) => setBuildingFilter(e.target.value)} className={selectClass}>
              <option value="All">All Buildings</option>
              {buildingNames.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className={selectClass}>
              <option value="All">All Statuses</option>
              <option value="Active">Active</option>
              <option value="Expired">Expired</option>
              <option value="Terminating">Terminating</option>
              <option value="Draft">Draft</option>
            </select>
            <select value={tenantFilter} onChange={(e) => setTenantFilter(e.target.value)} className={selectClass}>
              <option value="All">All Tenants</option>
              {tenantNames.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">Start date from</span>
              <Input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="w-40" />
              <span className="text-sm text-muted-foreground">to</span>
              <Input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="w-40" />
            </div>
            <select value={sortKey} onChange={(e) => setSortKey(e.target.value as SortKey)} className={selectClass}>
              {sortOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  Sort: {o.label}
                </option>
              ))}
            </select>
            <Button variant="ghost" onClick={clearFilters} disabled={!hasFilters} className="lg:ml-auto">
              <X className="mr-2 h-4 w-4" /> Clear Filters
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* On-screen results — the complete filtered list (no pagination) */}
      <Card className="print:hidden">
        <CardContent className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr>
                <th className="px-3 py-3 text-left font-medium">Contract Number</th>
                <th className="px-3 py-3 text-left font-medium">Tenant Name</th>
                <th className="px-3 py-3 text-left font-medium">Tenant Phone</th>
                <th className="px-3 py-3 text-left font-medium">CPR Number</th>
                <th className="px-3 py-3 text-left font-medium">Building</th>
                <th className="px-3 py-3 text-left font-medium">Unit</th>
                <th className="px-3 py-3 text-left font-medium">Road</th>
                <th className="px-3 py-3 text-left font-medium">Start Date</th>
                <th className="px-3 py-3 text-left font-medium">End Date</th>
                <th className="px-3 py-3 text-right font-medium">Monthly Rent</th>
                <th className="px-3 py-3 text-right font-medium">Security Deposit</th>
                <th className="px-3 py-3 text-left font-medium">Lease Status</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {filteredRows.length === 0 ? (
                <tr>
                  <td colSpan={12} className="px-4 py-12 text-center text-muted-foreground">
                    No leases match the current filters.
                  </td>
                </tr>
              ) : (
                filteredRows.map((r, i) => (
                  <tr key={`${r.contractNumber}-${i}`} className="hover:bg-muted/30">
                    <td className="px-3 py-2.5 font-medium">{r.contractNumber}</td>
                    <td className="px-3 py-2.5">{r.tenantName}</td>
                    <td className="px-3 py-2.5">{r.tenantPhone}</td>
                    <td className="px-3 py-2.5">{r.cpr}</td>
                    <td className="px-3 py-2.5">{r.building}</td>
                    <td className="px-3 py-2.5">{r.unit}</td>
                    <td className="px-3 py-2.5">{r.road}</td>
                    <td className="px-3 py-2.5">{r.startDate}</td>
                    <td className="px-3 py-2.5">{r.endDate}</td>
                    <td className="px-3 py-2.5 text-right">{r.rent}</td>
                    <td className="px-3 py-2.5 text-right">{r.deposit}</td>
                    <td className="px-3 py-2.5">{r.status}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {/* Print / PDF fallback version of the filtered report (in-page print stylesheet) */}
      <div className="hidden print:block">
        <ReportPrintBlock
          title="Lease List"
          subtitle={subtitleFor(filteredRows, hasFilters ? "filtered" : "all leases")}
          sections={[{ columns: pdfColumns, rows: rowsToStrings(filteredRows), totals: [["Total Records", String(filteredRows.length)] as [string, string]] }]}
        />
      </div>
    </div>
  );
}
