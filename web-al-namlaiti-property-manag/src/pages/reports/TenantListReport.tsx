// src/pages/reports/TenantListReport.tsx
// Full Tenant List report — every tenant in the system (not just the first
// page), with search, filters, sorting, print and multi-page PDF export.
// Read-only: nothing here modifies data.

import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ReportPrintBlock } from "@/components/reports/ReportPrintBlock";
import { useData } from "@/context/DataContext";
import { buildTenantReportRows } from "@/lib/reportData";
import type { TenantReportRow } from "@/lib/reportData";
import { downloadReportPdf } from "@/lib/reportPdf";
import type { ReportColumn } from "@/lib/reportPdf";
import { openReportPrintWindow } from "@/lib/reportPrint";
import { Download, Eye, FileDown, Printer, Search, X } from "lucide-react";

const pdfColumns: ReportColumn[] = [
  { label: "Tenant Name", width: 2 },
  { label: "Phone", width: 1.5 },
  { label: "Email", width: 2.2 },
  { label: "CPR Number", width: 1.2 },
  { label: "ID Type", width: 1.2 },
  { label: "ID Expiry", width: 1.2 },
  { label: "Nationality", width: 1.4 },
  { label: "Date of Birth", width: 1.2 },
  { label: "Building", width: 1.6 },
  { label: "Tenant Type", width: 1.1 },
  { label: "Status", width: 1 },
];

type SortKey = "name-asc" | "name-desc" | "building" | "status";

const sortOptions: { value: SortKey; label: string }[] = [
  { value: "name-asc", label: "Name (A–Z)" },
  { value: "name-desc", label: "Name (Z–A)" },
  { value: "building", label: "Building" },
  { value: "status", label: "Status" },
];

const selectClass =
  "h-10 rounded-md border border-input bg-background px-3 text-sm text-foreground";

export default function TenantListReport() {
  const { tenants, leases, units, buildings } = useData();
  const [search, setSearch] = useState("");
  const [buildingFilter, setBuildingFilter] = useState("All");
  const [statusFilter, setStatusFilter] = useState("All");
  const [typeFilter, setTypeFilter] = useState("All");
  const [sortKey, setSortKey] = useState<SortKey>("name-asc");

  // Complete unfiltered list — always built from ALL tenants.
  const allRows = useMemo(
    () => buildTenantReportRows({ tenants, leases, units, buildings }),
    [tenants, leases, units, buildings],
  );

  // Pair each row with its tenant id (buildTenantReportRows preserves order).
  const allEntries = useMemo(
    () => allRows.map((row, i) => ({ row, id: tenants[i]?.id ?? "" })),
    [allRows, tenants],
  );

  const filteredEntries = useMemo(() => {
    const q = search.trim().toLowerCase();
    const entries = allEntries.filter(({ row }) => {
      const matchesSearch =
        !q ||
        row.name.toLowerCase().includes(q) ||
        row.phone.toLowerCase().includes(q) ||
        row.email.toLowerCase().includes(q) ||
        row.cpr.toLowerCase().includes(q);
      const matchesBuilding = buildingFilter === "All" || row.building === buildingFilter;
      const matchesStatus = statusFilter === "All" || row.status === statusFilter;
      const matchesType = typeFilter === "All" || row.type === typeFilter;
      return matchesSearch && matchesBuilding && matchesStatus && matchesType;
    });
    const sorted = [...entries];
    switch (sortKey) {
      case "name-desc":
        sorted.sort((a, b) => b.row.name.localeCompare(a.row.name));
        break;
      case "building":
        sorted.sort((a, b) => a.row.building.localeCompare(b.row.building) || a.row.name.localeCompare(b.row.name));
        break;
      case "status":
        sorted.sort((a, b) => a.row.status.localeCompare(b.row.status) || a.row.name.localeCompare(b.row.name));
        break;
      default:
        sorted.sort((a, b) => a.row.name.localeCompare(b.row.name));
    }
    return sorted;
  }, [allEntries, search, buildingFilter, statusFilter, typeFilter, sortKey]);

  const filteredRows = useMemo(() => filteredEntries.map((e) => e.row), [filteredEntries]);

  const hasFilters =
    search.trim() !== "" || buildingFilter !== "All" || statusFilter !== "All" || typeFilter !== "All";

  const clearFilters = () => {
    setSearch("");
    setBuildingFilter("All");
    setStatusFilter("All");
    setTypeFilter("All");
    setSortKey("name-asc");
  };

  const rowsToStrings = (rows: TenantReportRow[]) =>
    rows.map((r) => [
      r.name,
      r.phone,
      r.email,
      r.cpr,
      r.idType,
      r.idExpiry,
      r.nationality,
      r.dob,
      r.building,
      r.type,
      r.status,
    ]);

  const subtitleFor = (rows: TenantReportRow[], scope: string) =>
    `${rows.length} tenant(s) — ${scope}`;

  /** Print the given rows through a clean pop-up print window (report only). */
  const handlePrint = (rows: TenantReportRow[], scope: string) => {
    const ok = openReportPrintWindow({
      title: "Tenant List",
      subtitle: subtitleFor(rows, scope),
      sections: [{ columns: pdfColumns, rows: rowsToStrings(rows) }],
    });
    if (!ok) {
      // Fall back to the in-page print stylesheet (report area only).
      window.print();
    }
  };

  const handleDownloadPdf = (rows: TenantReportRow[], scope: string) => {
    downloadReportPdf(
      {
        title: "TENANT LIST",
        subtitle: subtitleFor(rows, scope),
        columns: pdfColumns,
        rows: rowsToStrings(rows),
        footerNote: "Generated by Al Namlaiti Property Management System",
      },
      `tenant-list-${new Date().toISOString().split("T")[0]}.pdf`,
    );
  };

  return (
    <div className="space-y-6">
      <PageHeader title="Full Tenant List" subtitle="Complete list of all tenants stored in the system" />

      {/* Actions */}
      <div className="flex flex-wrap items-center gap-2 print:hidden">
        <Button variant="outline" onClick={() => handlePrint(filteredRows, hasFilters ? "filtered" : "all tenants")}>
          <Printer className="mr-2 h-4 w-4" /> Print
        </Button>
        <Button onClick={() => handleDownloadPdf(filteredRows, hasFilters ? "filtered" : "all tenants")}>
          <FileDown className="mr-2 h-4 w-4" /> Download PDF
        </Button>
        <Button variant="secondary" onClick={() => handleDownloadPdf(allRows, "complete list")}>
          <Download className="mr-2 h-4 w-4" /> Export All
        </Button>
        <span className="ml-auto text-sm text-muted-foreground">
          Showing {filteredRows.length} of {tenants.length} tenant(s)
        </span>
      </div>

      {/* Filters */}
      <Card className="print:hidden">
        <CardContent className="flex flex-col gap-3 p-4 lg:flex-row lg:items-center">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search name, phone, email, CPR..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>
          <select value={buildingFilter} onChange={(e) => setBuildingFilter(e.target.value)} className={selectClass}>
            <option value="All">All Buildings</option>
            {buildings.map((b) => (
              <option key={b.id} value={b.name}>
                {b.name}
              </option>
            ))}
          </select>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className={selectClass}>
            <option value="All">All Statuses</option>
            <option value="Active">Active</option>
            <option value="Inactive">Inactive</option>
          </select>
          <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} className={selectClass}>
            <option value="All">All Types</option>
            <option value="Individual">Individual</option>
            <option value="Company">Company</option>
          </select>
          <select value={sortKey} onChange={(e) => setSortKey(e.target.value as SortKey)} className={selectClass}>
            {sortOptions.map((o) => (
              <option key={o.value} value={o.value}>
                Sort: {o.label}
              </option>
            ))}
          </select>
          <Button variant="ghost" onClick={clearFilters} disabled={!hasFilters}>
            <X className="mr-2 h-4 w-4" /> Clear Filters
          </Button>
        </CardContent>
      </Card>

      {/* On-screen results — the complete filtered list (no pagination) */}
      <Card className="print:hidden">
        <CardContent className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr>
                <th className="px-3 py-3 text-left font-medium">Tenant Name</th>
                <th className="px-3 py-3 text-left font-medium">Phone</th>
                <th className="px-3 py-3 text-left font-medium">Email</th>
                <th className="px-3 py-3 text-left font-medium">CPR Number</th>
                <th className="px-3 py-3 text-left font-medium">ID Type</th>
                <th className="px-3 py-3 text-left font-medium">ID Expiry</th>
                <th className="px-3 py-3 text-left font-medium">Nationality</th>
                <th className="px-3 py-3 text-left font-medium">Date of Birth</th>
                <th className="px-3 py-3 text-left font-medium">Building</th>
                <th className="px-3 py-3 text-left font-medium">Tenant Type</th>
                <th className="px-3 py-3 text-left font-medium">Status</th>
                <th className="px-3 py-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {filteredEntries.length === 0 ? (
                <tr>
                  <td colSpan={12} className="px-4 py-12 text-center text-muted-foreground">
                    No tenants match the current filters.
                  </td>
                </tr>
              ) : (
                filteredEntries.map(({ id, row }) => (
                  <tr key={id || row.name} className="hover:bg-muted/30">
                    <td className="px-3 py-2.5 font-medium">{row.name}</td>
                    <td className="px-3 py-2.5">{row.phone}</td>
                    <td className="px-3 py-2.5">{row.email}</td>
                    <td className="px-3 py-2.5">{row.cpr}</td>
                    <td className="px-3 py-2.5">{row.idType}</td>
                    <td className="px-3 py-2.5">{row.idExpiry}</td>
                    <td className="px-3 py-2.5">{row.nationality}</td>
                    <td className="px-3 py-2.5">{row.dob}</td>
                    <td className="px-3 py-2.5">{row.building}</td>
                    <td className="px-3 py-2.5">{row.type}</td>
                    <td className="px-3 py-2.5">{row.status}</td>
                    <td className="px-3 py-2.5 text-right">
                      <Link
                        to={`/tenants/${id}`}
                        className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                      >
                        <Eye className="h-3.5 w-3.5" /> View
                      </Link>
                    </td>
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
          title="Tenant List"
          subtitle={subtitleFor(filteredRows, hasFilters ? "filtered" : "all tenants")}
          sections={[{ columns: pdfColumns, rows: rowsToStrings(filteredRows), totals: [["Total Records", String(filteredRows.length)] as [string, string]] }]}
        />
      </div>
    </div>
  );
}
