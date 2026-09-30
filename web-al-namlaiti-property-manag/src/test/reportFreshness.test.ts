// src/test/reportFreshness.test.ts
// End-to-end data-freshness tests: when a record is edited, every report/PDF
// data path must reflect the CURRENT stored values — no lease snapshots, no
// stale invoice balances.
//
// Scenarios mirror the real bug reports:
//  1. Tenant phone 33333333 → 34444444 must appear in Tenant List, Lease List,
//     Building Rent Roll.
//  2. Lease rent 140 → 150 must appear in Lease List, Rent Roll, portfolio
//     summary.
//  3. Payment edit 100 → 150 (invoice 150) must drive balance 50 → 0,
//     status Partial → Paid, and portfolio outstanding to 0.

import { describe, expect, it } from "vitest";
import {
  buildLeaseReportRows,
  buildPortfolioSummary,
  buildTenantReportRows,
} from "@/lib/reportData";
import { buildRentRoll } from "@/lib/rentRoll";
import { recomputeInvoiceFromPayments } from "@/lib/automation";
import type {
  Building,
  Expense,
  Invoice,
  Lease,
  Payment,
  Tenant,
  Unit,
} from "@/types";

const building: Building = {
  id: "bld-1",
  code: "BLD-2026-001",
  buildingNumber: "1337",
  name: "Namlaiti Tower",
  address: "Palace Road, Manama",
  status: "Active",
  ownerId: "own-1",
  floors: 5,
  units: 1,
};

const unit: Unit = {
  id: "u-1",
  buildingId: "bld-1",
  unitNumber: "02",
  floor: 1,
  type: "2BR",
  size: 100,
  bedrooms: 2,
  bathrooms: 1,
  furnished: "Unfurnished",
  status: "Occupied",
  baseRent: 140,
  securityDeposit: 140,
  serviceChargeType: "Flat Amount",
  serviceCharge: 0,
};

const tenant: Tenant = {
  id: "t-1",
  name: "SHARMILA RAMESH",
  email: "sharmila@example.com",
  phone: "33333333",
  type: "Individual",
  status: "Active",
  crNumber: "910000001",
  buildingId: "bld-1",
  leaseCount: 1,
};

const lease: Lease = {
  id: "l-1",
  contractNumber: "LSE-2026-001",
  tenantId: "t-1",
  unitId: "u-1",
  startDate: "2026-01-01",
  endDate: "2026-12-31",
  monthlyRent: 140,
  securityDeposit: 140,
  status: "Active",
  paymentFrequency: "Monthly",
  contractDays: 365,
  buildingNumber: "1337",
  road: "32",
  block: "316",
  location: "Manama",
  // Stored snapshot of tenant data at lease creation — must NOT override
  // the current tenant record in reports.
  cprNumber: "910000001",
  phoneNumber: "33333333",
};

const invoice: Invoice = {
  id: "inv-1",
  invoiceNumber: "INV-2026-001",
  tenantId: "t-1",
  leaseId: "l-1",
  unitId: "u-1",
  issueDate: "2026-09-01",
  dueDate: "2026-09-05",
  periodFrom: "2026-09-01",
  periodTo: "2026-09-30",
  amount: 150,
  balance: 150,
  status: "Sent",
  lineItems: [{ id: "li-1", description: "Rent — September 2026", amount: 150, type: "Rent" }],
  rentAmount: 150,
};

const payment: Payment = {
  id: "p-1",
  receiptNumber: "RCP-2026-000001",
  invoiceId: "inv-1",
  tenantId: "t-1",
  amount: 100,
  paymentDate: "2026-09-10",
  method: "Cheque",
  reference: "12345",
};

const expense: Expense = {
  id: "e-1",
  expenseNumber: "EXP-2026-001",
  category: "Maintenance",
  vendor: "Vendor",
  buildingId: "bld-1",
  amount: 10,
  expenseDate: "2026-09-01",
  status: "Pending",
};

// ── TEST 1: tenant phone edit ──

describe("tenant phone edit flows into every report", () => {
  const editedTenant: Tenant = { ...tenant, phone: "34444444" };

  it("Full Tenant List shows the new phone", () => {
    const rows = buildTenantReportRows({
      tenants: [editedTenant],
      leases: [lease],
      units: [unit],
      buildings: [building],
    });
    expect(rows[0].phone).toBe("34444444");
    expect(rows[0].cpr).toBe("910000001");
  });

  it("Full Lease List shows the new phone (not the lease snapshot)", () => {
    const rows = buildLeaseReportRows([lease], [editedTenant], [unit], [building]);
    expect(rows[0].tenantPhone).toBe("34444444");
    expect(rows[0].tenantPhone).not.toBe("33333333");
  });

  it("Building Rent Roll shows the new phone (not the lease snapshot)", () => {
    const { rows } = buildRentRoll({
      building,
      units: [unit],
      leases: [lease],
      tenants: [editedTenant],
      invoices: [invoice],
      payments: [payment],
      monthYm: "2026-09",
    });
    const row = rows.find((r) => r.unit === "02");
    expect(row?.contact).toBe("34444444");
    expect(row?.contact).not.toBe("33333333");
  });

  it("Lease snapshot fallback still works when tenant record is missing", () => {
    const rows = buildLeaseReportRows([lease], [], [unit], [building]);
    expect(rows[0].tenantPhone).toBe("33333333");
  });
});

// ── TEST 2: lease rent edit ──

describe("lease rent edit flows into every report", () => {
  const editedLease: Lease = { ...lease, monthlyRent: 150 };

  it("Full Lease List shows the new rent", () => {
    const rows = buildLeaseReportRows([editedLease], [tenant], [unit], [building]);
    expect(rows[0].rent).toBe("BHD 150.000");
  });

  it("Building Rent Roll shows the new rent", () => {
    const { rows, totals } = buildRentRoll({
      building,
      units: [unit],
      leases: [editedLease],
      tenants: [tenant],
      invoices: [invoice],
      payments: [payment],
      monthYm: "2026-09",
    });
    const row = rows.find((r) => r.unit === "02");
    expect(row?.rent).toBe("150.000");
    expect(totals.totalRent).toBe(150);
  });

  it("Property Management Report monthly income uses the new rent", () => {
    const summary = buildPortfolioSummary(
      [building],
      [unit],
      [tenant],
      [editedLease],
      [invoice],
      [payment],
      [expense],
    );
    expect(summary.monthlyRentalIncome).toBe(150);
  });
});

// ── TEST 3: payment edit/delete rebalances the invoice ──

describe("payment changes recompute invoice balance from payment records", () => {
  it("adding a payment of 100 on a 150 invoice leaves 50 outstanding", () => {
    const result = recomputeInvoiceFromPayments(invoice, [payment]);
    expect(result).toEqual({ balance: 50, status: "Partial" });
  });

  it("editing the payment 100 → 150 settles the invoice", () => {
    const editedPayment: Payment = { ...payment, amount: 150 };
    const result = recomputeInvoiceFromPayments(invoice, [editedPayment]);
    expect(result).toEqual({ balance: 0, status: "Paid" });
  });

  it("deleting the payment restores the full balance", () => {
    const result = recomputeInvoiceFromPayments(invoice, []);
    expect(result).toEqual({ balance: 150, status: "Sent" });
  });

  it("Property Management Report outstanding follows the recomputed balance", () => {
    // Before edit: balance 50 → outstanding 50.
    const partialInvoice: Invoice = { ...invoice, balance: 50, status: "Partial" };
    const before = buildPortfolioSummary(
      [building],
      [unit],
      [tenant],
      [lease],
      [partialInvoice],
      [payment],
      [expense],
    );
    expect(before.outstandingInvoices).toBe(50);

    // After edit: balance 0 → outstanding 0.
    const paidInvoice: Invoice = { ...invoice, balance: 0, status: "Paid" };
    const after = buildPortfolioSummary(
      [building],
      [unit],
      [tenant],
      [lease],
      [paidInvoice],
      [{ ...payment, amount: 150 }],
      [expense],
    );
    expect(after.outstandingInvoices).toBe(0);
    expect(after.totalPayments).toBe(150);
  });

  it("cancelled invoices are never auto-reopened", () => {
    const cancelled: Invoice = { ...invoice, status: "Cancelled", balance: 0 };
    expect(recomputeInvoiceFromPayments(cancelled, [])).toBeUndefined();
  });
});
