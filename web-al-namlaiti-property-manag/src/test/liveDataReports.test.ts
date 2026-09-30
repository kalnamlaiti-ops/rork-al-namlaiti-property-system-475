// src/test/liveDataReports.test.ts
// Regression tests for the stale-report-data bug: every report/PDF data
// builder must read the CURRENT records (tenant phone/CPR, lease rent,
// payment amounts) and never the legacy snapshot copies stored on the
// lease at creation time. Mirrors the user's three debug scenarios.

import { describe, expect, it } from "vitest";
import { buildRentRoll } from "@/lib/rentRoll";
import { buildLeaseReportRows, buildPortfolioSummary, buildTenantReportRows } from "@/lib/reportData";
import type { Building, Invoice, Lease, Payment, Tenant, Unit } from "@/types";

// Real-shaped records mirroring the live workspace relationships:
// Building 1440 → Unit 01 → Lease → Tenant SHARMILA RAMESH → Invoice → Payment.
const building: Building = {
  id: "bld-1783330586869-xvlq0",
  code: "BLD-2026-001",
  name: "Building 1440",
  address: "Road 3801, Block 338, Manama",
  status: "Active",
  ownerId: "own-1",
  floors: 5,
  units: 30,
  buildingNumber: "1440",
};

const unit: Unit = {
  id: "u-1783331014564-wjkxq",
  buildingId: building.id,
  unitNumber: "01",
  floor: 0,
  type: "2BR",
  size: 120,
  bedrooms: 2,
  bathrooms: 2,
  furnished: "Unfurnished",
  status: "Occupied",
  baseRent: 140,
  securityDeposit: 140,
  serviceChargeType: "Flat Amount",
  serviceCharge: 0,
};

const tenant: Tenant = {
  id: "t-sharmila",
  name: "SHARMILA RAMESH",
  email: "sharmila@example.com",
  phone: "35618475",
  type: "Individual",
  status: "Active",
  crNumber: "88123456",
  leaseCount: 1,
};

const lease: Lease = {
  id: "l-1",
  contractNumber: "LSE-2026-001",
  tenantId: tenant.id,
  unitId: unit.id,
  startDate: "2026-01-01",
  endDate: "2026-12-31",
  monthlyRent: 140,
  securityDeposit: 140,
  status: "Active",
  paymentFrequency: "Monthly",
  contractDays: 365,
  buildingNumber: "1440",
  // Legacy snapshots copied onto the lease at creation time — these must
  // NEVER shadow the live tenant record in reports.
  phoneNumber: "33333333",
  cprNumber: "88000000",
};

const invoice: Invoice = {
  id: "inv-1",
  invoiceNumber: "INV-2026-001",
  tenantId: tenant.id,
  leaseId: lease.id,
  unitId: unit.id,
  dueDate: "2026-09-01",
  periodFrom: "2026-09-01",
  periodTo: "2026-09-30",
  amount: 150,
  balance: 150,
  status: "Sent",
  lineItems: [{ id: "li-1", description: "Rent — September 2026", amount: 150, type: "Rent" }],
};

const makePayment = (amount: number): Payment => ({
  id: "p-1",
  receiptNumber: "RCP-2026-000001",
  invoiceId: invoice.id,
  tenantId: tenant.id,
  amount,
  paymentDate: "2026-09-29",
  method: "Cash",
});

const rollCtx = {
  building,
  units: [unit],
  leases: [lease],
  tenants: [tenant],
  invoices: [invoice],
  payments: [] as Payment[],
  monthYm: "2026-09",
};

describe("reports read CURRENT records — no stale snapshots", () => {
  it("TEST 1 — tenant phone edit flows into Building Rent Roll, Lease List and Tenant List", () => {
    const updatedTenant: Tenant = { ...tenant, phone: "37777777" };

    const roll = buildRentRoll({ ...rollCtx, tenants: [updatedTenant] });
    expect(roll.rows[0].contact).toBe("37777777");
    expect(roll.rows[0].contact).not.toBe("33333333");

    const leaseRows = buildLeaseReportRows([lease], [updatedTenant], [unit], [building]);
    expect(leaseRows[0].tenantPhone).toBe("37777777");

    const tenantRows = buildTenantReportRows({
      tenants: [updatedTenant],
      leases: [lease],
      units: [unit],
      buildings: [building],
    });
    expect(tenantRows[0].phone).toBe("37777777");
  });

  it("TEST 1b — tenant CPR edit flows into the Lease List (lease copy is only a fallback)", () => {
    const updatedTenant: Tenant = { ...tenant, crNumber: "88999999" };
    const leaseRows = buildLeaseReportRows([lease], [updatedTenant], [unit], [building]);
    expect(leaseRows[0].cpr).toBe("88999999");
    expect(leaseRows[0].cpr).not.toBe("88000000");
  });

  it("TEST 1c — lease snapshot phone is used only when the tenant record has no phone", () => {
    const ghostTenant: Tenant = { ...tenant, id: "t-ghost", phone: "" };
    const ghostLease: Lease = { ...lease, id: "l-ghost", tenantId: ghostTenant.id };
    const roll = buildRentRoll({
      ...rollCtx,
      tenants: [ghostTenant],
      leases: [ghostLease],
      invoices: [],
    });
    expect(roll.rows[0].contact).toBe("33333333");
  });

  it("TEST 2 — rent change 140 → 150 flows into Lease List, Building Rent Roll and Portfolio totals", () => {
    const updatedLease: Lease = { ...lease, monthlyRent: 150 };

    const leaseRows = buildLeaseReportRows([updatedLease], [tenant], [unit], [building]);
    expect(leaseRows[0].rent).toBe("BHD 150.000");
    expect(leaseRows[0].rentValue).toBe(150);

    const roll = buildRentRoll({ ...rollCtx, leases: [updatedLease] });
    expect(roll.rows[0].rent).toBe("150.000");
    expect(roll.rows[0].rentValue).toBe(150);

    const summary = buildPortfolioSummary([building], [unit], [tenant], [updatedLease], [], [], []);
    expect(summary.monthlyRentalIncome).toBe(150);
  });

  it("TEST 3 — payment 100 → 150 updates Rent Collected, Outstanding and portfolio totals", () => {
    // Rent 150, payment 100 → collected 100, outstanding 50
    const rent150: Lease = { ...lease, monthlyRent: 150 };
    const partial = buildRentRoll({
      ...rollCtx,
      leases: [rent150],
      invoices: [{ ...invoice, amount: 150, balance: 50, status: "Partial" }],
      payments: [makePayment(100)],
    });
    expect(partial.rows[0].collected).toBe("100.000");
    expect(partial.rows[0].outstanding).toBe("50.000");

    // Payment edited to 150 → collected 150, outstanding 0
    const paid = buildRentRoll({
      ...rollCtx,
      leases: [rent150],
      invoices: [{ ...invoice, amount: 150, balance: 0, status: "Paid" }],
      payments: [makePayment(150)],
    });
    expect(paid.rows[0].collected).toBe("150.000");
    expect(paid.rows[0].outstanding).toBe("0.000");

    // Portfolio totals reflect the current payment and invoice balance
    const summary = buildPortfolioSummary(
      [building],
      [unit],
      [tenant],
      [rent150],
      [{ ...invoice, amount: 150, balance: 0, status: "Paid" }],
      [makePayment(150)],
      [],
    );
    expect(summary.totalPayments).toBe(150);
    expect(summary.outstandingInvoices).toBe(0);
  });
});
