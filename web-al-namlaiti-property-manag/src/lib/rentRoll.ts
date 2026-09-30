// src/lib/rentRoll.ts
// Read-only Building Rent Roll / Tenant List data preparation.
// Every value is derived from the records already stored in the shared
// workspace (units, leases, tenants, invoices, payments). NOTHING here
// writes, modifies, or deletes data.

import { format } from "date-fns";
import type { Building, Invoice, Lease, Payment, Tenant, Unit } from "@/types";
import type { ReportColumn } from "./reportPdf";

/** Year-month key of an ISO date, e.g. "2026-10". */
export function ymOf(iso: string): string {
  return (iso ?? "").slice(0, 7);
}

/** "2026-10" → "October 2026". */
export function monthLabelOf(ym: string): string {
  const d = new Date(`${ym}-01T00:00:00`);
  return Number.isNaN(d.getTime()) ? ym : format(d, "MMMM yyyy");
}

/** ISO date → DD/MM/YYYY. */
export function fmtDMY(iso?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${d.getFullYear()}`;
}

/** Unit type → property specification label. */
export function specLabel(type: Unit["type"]): string {
  switch (type) {
    case "Studio":
      return "Studio";
    case "1BR":
      return "1 BHK";
    case "2BR":
      return "2 BHK";
    case "3BR":
      return "3 BHK";
    case "4BR+":
      return "4+ BHK";
    case "Commercial":
      return "Commercial";
    default:
      return type;
  }
}

export interface RentRollRow {
  srNo: number;
  tenantName: string;
  spec: string;
  contact: string;
  unit: string;
  rent: string;
  collected: string;
  month: string;
  outstanding: string;
  leasePeriod: string;
  remarks: string;
  status: string;
  occupied: boolean;
  rentValue: number;
  collectedValue: number;
  outstandingValue: number;
}

export interface RentRollTotals {
  totalUnits: number;
  occupiedUnits: number;
  vacantUnits: number;
  totalRent: number;
  totalCollected: number;
  totalOutstanding: number;
}

export interface RentRollResult {
  rows: RentRollRow[];
  totals: RentRollTotals;
}

const money = (n: number) => n.toFixed(3);

/** Build the complete rent roll for a building — ALL units, one row each. */
export function buildRentRoll(args: {
  building: Building;
  units: Unit[];
  leases: Lease[];
  tenants: Tenant[];
  invoices: Invoice[];
  payments: Payment[];
  monthYm: string;
}): RentRollResult {
  const { building, leases, tenants, invoices, payments, monthYm } = args;
  const buildingUnits = args.units
    .filter((u) => u.buildingId === building.id)
    .sort((a, b) => a.unitNumber.localeCompare(b.unitNumber, undefined, { numeric: true }));

  const shortLabel = format(new Date(`${monthYm}-01T00:00:00`), "MMM yyyy");

  const rows: RentRollRow[] = buildingUnits.map((unit, i) => {
    const srNo = i + 1;
    const spec = specLabel(unit.type);
    const unitLeases = leases.filter((l) => l.unitId === unit.id);
    const lease = unitLeases.find((l) => l.status === "Active") ?? unitLeases[0];

    // Vacant / unleased unit — included so the report shows full occupancy.
    if (!lease) {
      return {
        srNo,
        tenantName: "VACANT",
        spec,
        contact: "",
        unit: unit.unitNumber,
        rent: "—",
        collected: "—",
        month: "—",
        outstanding: "—",
        leasePeriod: "—",
        remarks: (unit.notes ?? "").split("\n")[0] ?? "",
        status: unit.status,
        occupied: unit.status === "Occupied",
        rentValue: 0,
        collectedValue: 0,
        outstandingValue: 0,
      };
    }

    const tenant = tenants.find((t) => t.id === lease.tenantId);
    // Payments actually received in the selected month for this lease:
    // invoiced payments must belong to this lease's invoices; non-invoiced
    // payments match the lease's tenant directly.
    const invIds = new Set(invoices.filter((iv) => iv.leaseId === lease.id).map((iv) => iv.id));
    const monthPayments = payments.filter((p) => {
      if (ymOf(p.paymentDate) !== monthYm) return false;
      if (p.invoiceId) return invIds.has(p.invoiceId);
      return p.tenantId === lease.tenantId;
    });
    const collected = monthPayments.reduce((s, p) => s + (p.amount || 0), 0);
    const outstanding = Math.max(0, (lease.monthlyRent || 0) - collected);
    const remarks = (lease.notes || tenant?.notes || "").split("\n")[0] ?? "";

    return {
      srNo,
      tenantName: tenant?.name ?? lease.phoneNumber ?? "—",
      spec,
      contact: lease.phoneNumber || tenant?.phone || "—",
      unit: unit.unitNumber,
      rent: money(lease.monthlyRent || 0),
      collected: money(collected),
      month: collected > 0 ? shortLabel : "—",
      outstanding: money(outstanding),
      leasePeriod: `${fmtDMY(lease.startDate)} - ${fmtDMY(lease.endDate)}`,
      remarks,
      status: lease.status,
      occupied: lease.status === "Active" || unit.status === "Occupied",
      rentValue: lease.monthlyRent || 0,
      collectedValue: collected,
      outstandingValue: outstanding,
    };
  });

  const totals: RentRollTotals = {
    totalUnits: rows.length,
    occupiedUnits: rows.filter((r) => r.occupied).length,
    vacantUnits: rows.filter((r) => !r.occupied).length,
    totalRent: rows.reduce((s, r) => s + r.rentValue, 0),
    totalCollected: rows.reduce((s, r) => s + r.collectedValue, 0),
    totalOutstanding: rows.reduce((s, r) => s + r.outstandingValue, 0),
  };

  return { rows, totals };
}

export function totalsOfRows(rows: RentRollRow[]): RentRollTotals {
  return {
    totalUnits: rows.length,
    occupiedUnits: rows.filter((r) => r.occupied).length,
    vacantUnits: rows.filter((r) => !r.occupied).length,
    totalRent: rows.reduce((s, r) => s + r.rentValue, 0),
    totalCollected: rows.reduce((s, r) => s + r.collectedValue, 0),
    totalOutstanding: rows.reduce((s, r) => s + r.outstandingValue, 0),
  };
}

export function rentRollSummary(t: RentRollTotals): [string, string][] {
  return [
    ["TOTAL UNITS", String(t.totalUnits)],
    ["OCCUPIED UNITS", String(t.occupiedUnits)],
    ["VACANT UNITS", String(t.vacantUnits)],
    ["TOTAL MONTHLY RENT", `BHD ${t.totalRent.toFixed(3)}`],
    ["TOTAL RENT COLLECTED", `BHD ${t.totalCollected.toFixed(3)}`],
    ["TOTAL OUTSTANDING", `BHD ${t.totalOutstanding.toFixed(3)}`],
  ];
}

export const rentRollColumns: ReportColumn[] = [
  { label: "Sr No.", width: 0.5 },
  { label: "Tenant Name", width: 1.8 },
  { label: "SPEC", width: 0.8 },
  { label: "Contact Number", width: 1.1 },
  { label: "Unit", width: 0.6 },
  { label: "Rent (BHD/mo)", width: 1.0, align: "right" },
  { label: "Rent Collected", width: 1.0, align: "right" },
  { label: "Month", width: 0.8 },
  { label: "Outstanding", width: 1.0, align: "right" },
  { label: "Lease Period", width: 1.6 },
  { label: "Remarks", width: 1.4 },
  { label: "Status", width: 0.8 },
];

export function rentRollRowStrings(rows: RentRollRow[]): string[][] {
  return rows.map((r) => [
    String(r.srNo),
    r.tenantName,
    r.spec,
    r.contact,
    r.unit,
    r.rent,
    r.collected,
    r.month,
    r.outstanding,
    r.leasePeriod,
    r.remarks,
    r.status,
  ]);
}
