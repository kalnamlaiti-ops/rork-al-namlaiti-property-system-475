// src/lib/reportData.ts
// Read-only report data preparation for Reports & Documents.
// Every function here derives rows/summaries from the records already stored
// in the shared workspace. NOTHING in this module writes, modifies, or deletes
// data — reports are strictly read-only.

import type {
  Building,
  Expense,
  Invoice,
  Lease,
  Payment,
  Tenant,
  Unit,
} from "@/types";

// ── Formatting helpers ──

export function fmtDate(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

export function fmtMoney(amount: number): string {
  return `BHD ${amount.toFixed(3)}`;
}

export function reportDate(): string {
  return new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "long", year: "numeric" });
}

/** Pull "Nationality: X" out of legacy tenant notes (older records stored it there). */
function nationalityFromNotes(notes?: string): string {
  if (!notes) return "";
  const m = notes.match(/^Nationality:\s*(.+)$/m);
  return m ? m[1].trim() : "";
}

// ── Full Tenant List ──

export interface TenantReportRow {
  name: string;
  phone: string;
  email: string;
  cpr: string;
  idType: string;
  idExpiry: string;
  nationality: string;
  dob: string;
  building: string;
  type: string;
  status: string;
}

export interface TenantReportContext {
  tenants: Tenant[];
  leases: Lease[];
  units: Unit[];
  buildings: Building[];
}

/** Derive a tenant's primary building: explicit link first, else their active lease's unit building. */
export function tenantBuildingId(tenant: Tenant, leases: Lease[], units: Unit[]): string | undefined {
  if (tenant.buildingId) return tenant.buildingId;
  const lease = leases.find((l) => l.tenantId === tenant.id);
  if (!lease) return undefined;
  return units.find((u) => u.id === lease.unitId)?.buildingId;
}

export function buildTenantReportRows(ctx: TenantReportContext): TenantReportRow[] {
  const { tenants, leases, units, buildings } = ctx;
  return tenants.map((t) => {
    const bId = tenantBuildingId(t, leases, units);
    const building = bId ? buildings.find((b) => b.id === bId) : undefined;
    return {
      name: t.name || "—",
      phone: t.phone || "—",
      email: t.email || "—",
      cpr: t.crNumber || "—",
      idType: t.idType || "—",
      idExpiry: t.idExpiry ? fmtDate(t.idExpiry) : "—",
      nationality: t.nationality || nationalityFromNotes(t.notes) || "—",
      dob: t.dateOfBirth ? fmtDate(t.dateOfBirth) : "—",
      building: building?.name ?? "—",
      type: t.type || "—",
      status: t.status || "—",
    };
  });
}

// ── Full Lease List ──

export interface LeaseReportRow {
  contractNumber: string;
  tenantName: string;
  tenantPhone: string;
  cpr: string;
  building: string;
  unit: string;
  road: string;
  startDate: string;
  endDate: string;
  /** Raw ISO start date (for date-range filters and sorting). */
  startIso: string;
  rent: string;
  deposit: string;
  /** Raw monthly rent value (for sorting). */
  rentValue: number;
  status: string;
}

export function buildLeaseReportRows(
  leases: Lease[],
  tenants: Tenant[],
  units: Unit[],
  buildings: Building[],
): LeaseReportRow[] {
  return leases.map((l) => {
    const tenant = tenants.find((t) => t.id === l.tenantId);
    const unit = units.find((u) => u.id === l.unitId);
    const building = unit ? buildings.find((b) => b.id === unit.buildingId) : undefined;
    return {
      contractNumber: l.contractNumber || "—",
      tenantName: tenant?.name ?? "—",
      // Phone/CPR resolve from the CURRENT tenant record — the lease's stored
      // copy is only a fallback for records without a linked tenant, so edits
      // to a tenant always flow into this report.
      tenantPhone: tenant?.phone || l.phoneNumber || "—",
      cpr: tenant?.crNumber || l.cprNumber || "—",
      building: building?.name ?? (l.buildingNumber ? `Building ${l.buildingNumber}` : "—"),
      unit: unit?.unitNumber ?? "—",
      road: l.road || building?.address || "—",
      startDate: fmtDate(l.startDate),
      endDate: fmtDate(l.endDate),
      startIso: l.startDate,
      rent: fmtMoney(l.monthlyRent),
      deposit: fmtMoney(l.securityDeposit),
      rentValue: l.monthlyRent || 0,
      status: l.status,
    };
  });
}

// ── Property Management (portfolio) Report ──

export interface PortfolioSummary {
  totalBuildings: number;
  totalUnits: number;
  occupiedUnits: number;
  vacantUnits: number;
  totalTenants: number;
  activeLeases: number;
  expiredLeases: number;
  monthlyRentalIncome: number;
  outstandingInvoices: number;
  totalPayments: number;
  totalExpenses: number;
}

/** All values computed from real records — nothing is hardcoded. */
export function buildPortfolioSummary(
  buildings: Building[],
  units: Unit[],
  tenants: Tenant[],
  leases: Lease[],
  invoices: Invoice[],
  payments: Payment[],
  expenses: Expense[],
): PortfolioSummary {
  return {
    totalBuildings: buildings.length,
    totalUnits: units.length,
    occupiedUnits: units.filter((u) => u.status === "Occupied").length,
    vacantUnits: units.filter((u) => u.status === "Vacant").length,
    totalTenants: tenants.length,
    activeLeases: leases.filter((l) => l.status === "Active").length,
    expiredLeases: leases.filter((l) => l.status === "Expired").length,
    // Monthly rental income = sum of ACTIVE lease rents only.
    monthlyRentalIncome: leases
      .filter((l) => l.status === "Active")
      .reduce((sum, l) => sum + (l.monthlyRent || 0), 0),
    // Outstanding = remaining balance on invoices that are not Paid/Cancelled.
    outstandingInvoices: invoices
      .filter((i) => i.status !== "Paid" && i.status !== "Cancelled")
      .reduce((sum, i) => sum + Math.max(0, i.balance || 0), 0),
    totalPayments: payments.reduce((sum, p) => sum + (p.amount || 0), 0),
    totalExpenses: expenses.reduce((sum, e) => sum + (e.amount || 0), 0),
  };
}

export function portfolioSummaryRows(s: PortfolioSummary): [string, string][] {
  return [
    ["Total Buildings", String(s.totalBuildings)],
    ["Total Units", String(s.totalUnits)],
    ["Occupied Units", String(s.occupiedUnits)],
    ["Vacant Units", String(s.vacantUnits)],
    ["Total Tenants", String(s.totalTenants)],
    ["Active Leases", String(s.activeLeases)],
    ["Expired Leases", String(s.expiredLeases)],
    ["Monthly Rental Income", fmtMoney(s.monthlyRentalIncome)],
    ["Outstanding Invoices", fmtMoney(s.outstandingInvoices)],
    ["Total Payments", fmtMoney(s.totalPayments)],
    ["Total Expenses", fmtMoney(s.totalExpenses)],
  ];
}

// ── Individual Tenant Report ──

export interface TenantDetailReport {
  info: [string, string][];
  leases: {
    columns: { label: string; width: number }[];
    rows: string[][];
  };
  invoices: { columns: { label: string; width: number }[]; rows: string[][] };
  payments: { columns: { label: string; width: number }[]; rows: string[][] };
  financialTotals: [string, string][];
}

export function buildTenantDetailReport(
  tenant: Tenant,
  ctx: TenantReportContext,
  invoices: Invoice[],
  payments: Payment[],
): TenantDetailReport {
  const { leases, units, buildings } = ctx;
  const tenantLeases = leases.filter((l) => l.tenantId === tenant.id);

  const info: [string, string][] = [
    ["Full Name", tenant.name || "—"],
    ["Phone", tenant.phone || "—"],
    ["Email", tenant.email || "—"],
    ["CPR", tenant.crNumber || "—"],
    ["ID Type", tenant.idType || "—"],
    ["ID Expiry", tenant.idExpiry ? fmtDate(tenant.idExpiry) : "—"],
    ["Nationality", tenant.nationality || nationalityFromNotes(tenant.notes) || "—"],
    ["Date of Birth", tenant.dateOfBirth ? fmtDate(tenant.dateOfBirth) : "—"],
  ];

  // Building & unit come from the tenant's (most recent) lease.
  const primaryLease =
    tenantLeases.find((l) => l.status === "Active") ?? tenantLeases[0];
  const primaryUnit = primaryLease ? units.find((u) => u.id === primaryLease.unitId) : undefined;
  const primaryBuilding = primaryUnit
    ? buildings.find((b) => b.id === primaryUnit.buildingId)
    : undefined;
  info.push(["Building", primaryBuilding?.name ?? "—"]);
  info.push(["Unit", primaryUnit?.unitNumber ?? "—"]);

  const leaseColumns = [
    { label: "Contract #", width: 2 },
    { label: "Unit", width: 1.2 },
    { label: "Start", width: 1.6 },
    { label: "End", width: 1.6 },
    { label: "Monthly Rent", width: 1.8 },
    { label: "Deposit", width: 1.6 },
    { label: "Status", width: 1.4 },
  ];
  const leaseRows = tenantLeases.map((l) => {
    const unit = units.find((u) => u.id === l.unitId);
    return [
      l.contractNumber,
      unit?.unitNumber ?? "—",
      fmtDate(l.startDate),
      fmtDate(l.endDate),
      fmtMoney(l.monthlyRent),
      fmtMoney(l.securityDeposit),
      l.status,
    ];
  });

  const tenantInvoices = invoices.filter((i) => i.tenantId === tenant.id);
  const tenantPayments = payments.filter((p) => p.tenantId === tenant.id);

  const invoiceColumns = [
    { label: "Invoice #", width: 2 },
    { label: "Issued", width: 1.6 },
    { label: "Due", width: 1.6 },
    { label: "Total", width: 1.6 },
    { label: "Balance", width: 1.6 },
    { label: "Status", width: 1.4 },
  ];
  const invoiceRows = tenantInvoices.map((i) => [
    i.invoiceNumber,
    fmtDate(i.issueDate ?? i.dueDate),
    fmtDate(i.dueDate),
    fmtMoney(i.amount),
    fmtMoney(i.balance),
    i.status,
  ]);

  const paymentColumns = [
    { label: "Receipt #", width: 2 },
    { label: "Date", width: 1.6 },
    { label: "Method", width: 1.6 },
    { label: "Amount", width: 1.6 },
  ];
  const paymentRows = tenantPayments.map((p) => [
    p.receiptNumber,
    fmtDate(p.paymentDate),
    p.method,
    fmtMoney(p.amount),
  ]);

  const totalInvoiced = tenantInvoices.reduce((s, i) => s + i.amount, 0);
  const totalPaid = tenantPayments.reduce((s, p) => s + p.amount, 0);
  const outstanding = tenantInvoices.reduce(
    (s, i) => s + (i.status === "Paid" || i.status === "Cancelled" ? 0 : Math.max(0, i.balance)),
    0,
  );

  return {
    info,
    leases: { columns: leaseColumns, rows: leaseRows },
    invoices: { columns: invoiceColumns, rows: invoiceRows },
    payments: { columns: paymentColumns, rows: paymentRows },
    financialTotals: [
      ["Total Invoiced", fmtMoney(totalInvoiced)],
      ["Total Paid", fmtMoney(totalPaid)],
      ["Outstanding Balance", fmtMoney(outstanding)],
    ],
  };
}

// ── Individual Lease Report ──

export interface LeaseDetailReport {
  info: [string, string][];
  invoices: { columns: { label: string; width: number }[]; rows: string[][] };
  payments: { columns: { label: string; width: number }[]; rows: string[][] };
  totals: [string, string][];
}

export function buildLeaseDetailReport(
  lease: Lease,
  tenants: Tenant[],
  units: Unit[],
  buildings: Building[],
  invoices: Invoice[],
  payments: Payment[],
): LeaseDetailReport {
  const tenant = tenants.find((t) => t.id === lease.tenantId);
  const unit = units.find((u) => u.id === lease.unitId);
  const building = unit ? buildings.find((b) => b.id === unit.buildingId) : undefined;

  const info: [string, string][] = [
    ["Contract Number", lease.contractNumber || "—"],
    ["Tenant Name", tenant?.name ?? "—"],
    // Current tenant record first — lease copy is a fallback only.
    ["Tenant Phone", tenant?.phone || lease.phoneNumber || "—"],
    ["CPR Number", tenant?.crNumber || lease.cprNumber || "—"],
    ["Building", building?.name ?? (lease.buildingNumber ? `Building ${lease.buildingNumber}` : "—")],
    ["Unit", unit?.unitNumber ?? "—"],
    ["Road", lease.road || "—"],
    ["Block", lease.block || "—"],
    ["Location", lease.location || "—"],
    ["Start Date", fmtDate(lease.startDate)],
    ["End Date", fmtDate(lease.endDate)],
    ["Monthly Rent", fmtMoney(lease.monthlyRent)],
    ["Security Deposit", fmtMoney(lease.securityDeposit)],
    ["Payment Frequency", lease.paymentFrequency],
    ["Lease Status", lease.status],
  ];

  const leaseInvoices = invoices.filter((i) => i.leaseId === lease.id);
  const invoiceIds = new Set(leaseInvoices.map((i) => i.id));
  const leasePayments = payments.filter((p) => invoiceIds.has(p.invoiceId));

  const invoiceColumns = [
    { label: "Invoice #", width: 2 },
    { label: "Issued", width: 1.6 },
    { label: "Due", width: 1.6 },
    { label: "Total", width: 1.6 },
    { label: "Balance", width: 1.6 },
    { label: "Status", width: 1.4 },
  ];
  const invoiceRows = leaseInvoices.map((i) => [
    i.invoiceNumber,
    fmtDate(i.issueDate ?? i.dueDate),
    fmtDate(i.dueDate),
    fmtMoney(i.amount),
    fmtMoney(i.balance),
    i.status,
  ]);

  const paymentColumns = [
    { label: "Receipt #", width: 2 },
    { label: "Date", width: 1.6 },
    { label: "Method", width: 1.6 },
    { label: "Amount", width: 1.6 },
  ];
  const paymentRows = leasePayments.map((p) => [
    p.receiptNumber,
    fmtDate(p.paymentDate),
    p.method,
    fmtMoney(p.amount),
  ]);

  const totalInvoiced = leaseInvoices.reduce((s, i) => s + i.amount, 0);
  const totalPaid = leasePayments.reduce((s, p) => s + p.amount, 0);
  const outstanding = leaseInvoices.reduce(
    (s, i) => s + (i.status === "Paid" || i.status === "Cancelled" ? 0 : Math.max(0, i.balance)),
    0,
  );

  return {
    info,
    invoices: { columns: invoiceColumns, rows: invoiceRows },
    payments: { columns: paymentColumns, rows: paymentRows },
    totals: [
      ["Total Invoiced", fmtMoney(totalInvoiced)],
      ["Total Paid", fmtMoney(totalPaid)],
      ["Outstanding Balance", fmtMoney(outstanding)],
    ],
  };
}
