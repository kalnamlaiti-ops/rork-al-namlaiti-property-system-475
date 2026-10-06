import { describe, expect, it } from "vitest";
import {
  classifyEwaBill,
  ewaLineDescription,
  monthKeyOf,
  resolveEwaCharge,
  round3,
} from "@/lib/ewaInvoiceLookup";
import type {
  EWAAccount,
  EWABill,
  EWADistribution,
  Invoice,
  Lease,
  Tenant,
  Unit,
} from "@/types";

// ─── Exact user scenario ────────────────────────────────────────────────────
//
//   EWA Account 1042833804 — linked Units 12 + 13, equal split
//   EWA Bill BHD 112.49 for October 2026 (Unit 12 = vacant / landlord share,
//   Unit 13 = occupied by the tenant)
//
//   Invoice for Unit 13 (rent BHD 160.000), billing period October 2026.
//   Selecting "EWA" on a line item must auto-fill, with nothing typed:
//     Description: "EWA - October 2026"
//     Amount:      BHD 56.245
//   → invoice total 160.000 + 56.245 = 216.245

const unit12 = { id: "u12", unitNumber: "12", buildingId: "b1", status: "Vacant" } as unknown as Unit;
const unit13 = { id: "u13", unitNumber: "13", buildingId: "b1", status: "Occupied" } as unknown as Unit;
const tenant = { id: "t1", name: "NAINESH NANDKUMAR GULEKA" } as unknown as Tenant;
const lease13 = {
  id: "L13",
  unitId: "u13",
  tenantId: "t1",
  status: "Active",
  monthlyRent: 160,
  contractNumber: "L-13",
  startDate: "2026-01-01",
  endDate: "2027-01-01",
} as unknown as Lease;
const account = {
  id: "acc1",
  accountNumber: "1042833804",
  buildingId: "b1",
  status: "Active",
  allocationMethod: "equal",
  linkedUnitIds: ["u12", "u13"],
  rules: [],
  vacantAction: "landlord",
  createdAt: "2026-01-01",
} as unknown as EWAAccount;

const manualBill = (over: Partial<EWABill> = {}): EWABill => ({
  id: "bill1",
  billNumber: "EWA-0001",
  leaseId: "L13",
  unitId: "u13",
  buildingId: "b1",
  month: "October 2026",
  billAmount: 112.49,
  limit: 0,
  excess: 112.49,
  dueDate: "2026-10-15",
  status: "Pending",
  ewaAccountId: "acc1",
  ...over,
});

/** Distribution-processed per-unit bill for Unit 13 (share already computed). */
const distBill13 = manualBill({
  id: "bill2",
  billNumber: "EWA-0002",
  billAmount: 56.245,
  month: "2026-10",
});
const distribution = {
  id: "d1",
  accountId: "acc1",
  billNumber: "EWA-DIST-1",
  month: "2026-10",
  totalAmount: 112.49,
  dueDate: "2026-10-15",
  allocations: [
    { unitId: "u12", amount: 56.245, vacant: true, excluded: false, chargeToLandlord: true, ewaBillId: "bill3" },
    { unitId: "u13", amount: 56.245, vacant: false, excluded: false, chargeToLandlord: false, ewaBillId: "bill2" },
  ],
} as unknown as EWADistribution;

const baseData = {
  units: [unit12, unit13],
  leases: [lease13],
  tenants: [tenant],
  ewaAccounts: [account],
  ewaBills: [manualBill()],
  ewaDistributions: [] as EWADistribution[],
  invoices: [] as Invoice[],
};

const lookupInput = (over: Record<string, unknown> = {}) => ({
  leaseId: "L13",
  periodFrom: "2026-10-01",
  ...baseData,
  ...over,
});

describe("EWA invoice lookup — Lease → Unit → EWA Account → EWA Bill → allocation", () => {
  it("auto-fills Unit 13's equal share of the account bill (112.49 → 56.245)", () => {
    const result = resolveEwaCharge(lookupInput());
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.candidate.bill.id).toBe("bill1");
    expect(result.candidate.share).toBe(56.245);
    expect(result.candidate.share.toFixed(3)).toBe("56.245");
    expect(result.candidate.account.accountNumber).toBe("1042833804");
  });

  it("generates the description from the bill's month: EWA - October 2026", () => {
    expect(ewaLineDescription(manualBill())).toBe("EWA - October 2026");
  });

  it("totals rent + EWA to 216.245 at 3-decimal BHD precision", () => {
    const result = resolveEwaCharge(lookupInput());
    if (result.status !== "ok") throw new Error("expected ok");
    expect(round3(160 + result.candidate.share).toFixed(3)).toBe("216.245");
  });

  it("never re-splits a distribution-created per-unit bill", () => {
    const cls = classifyEwaBill(distBill13, "u13", account, {
      units: baseData.units,
      leases: baseData.leases,
      tenants: baseData.tenants,
      ewaDistributions: [distribution],
    });
    expect(cls.perUnit).toBe(true);
    expect(cls.share).toBe(56.245); // not 112.49 and not re-split to ~28.12
    expect(cls.chargeable).toBe(true);
  });

  it("lists the per-unit distribution bill first when multiple bills match", () => {
    const result = resolveEwaCharge(
      lookupInput({ ewaBills: [manualBill(), distBill13], ewaDistributions: [distribution] }),
    );
    expect(result.status).toBe("choice");
    if (result.status !== "choice") return;
    expect(result.candidates[0].bill.id).toBe("bill2");
    expect(result.candidates[0].perUnit).toBe(true);
    expect(result.candidates[0].share).toBe(56.245);
    expect(result.candidates[1].share).toBe(56.245);
  });

  it("offers a selection list when multiple valid bills match", () => {
    const result = resolveEwaCharge(
      lookupInput({ ewaBills: [manualBill(), distBill13], ewaDistributions: [distribution] }),
    );
    expect(result.status).toBe("choice");
    if (result.status !== "choice") return;
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[0].perUnit).toBe(true);
    expect(result.candidates[0].share).toBe(56.245);
    expect(result.candidates[1].share).toBe(56.245);
  });

  it("blocks a bill already added to this invoice (one EWA charge per bill)", () => {
    const result = resolveEwaCharge(lookupInput({ usedBillIds: ["bill1"] }));
    expect(result.status).toBe("none");
    if (result.status !== "none") return;
    expect(result.message).toBe("EWA already added to this invoice.");
  });

  it("shows the exact failure when the lease id does not resolve", () => {
    const missing = resolveEwaCharge(lookupInput({ leaseId: "lease-gone" }));
    expect(missing.status).toBe("none");
    if (missing.status !== "none") return;
    expect(missing.message).toBe("Lease could not be found.");

    const none = resolveEwaCharge(lookupInput({ leaseId: "" }));
    if (none.status !== "none") throw new Error("expected none");
    expect(none.message).toBe("Select a lease first.");
  });

  it("shows the exact failure when the lease has no unit", () => {
    const orphanLease = { id: "L-orph", unitId: "u-missing", tenantId: "t1", status: "Active" } as unknown as Lease;
    const result = resolveEwaCharge(lookupInput({ leaseId: "L-orph", leases: [orphanLease] }));
    expect(result.status).toBe("none");
    if (result.status !== "none") return;
    expect(result.message).toBe("Lease has no Unit.");
  });

  it("blocks already-invoiced bills", () => {
    const result = resolveEwaCharge(
      lookupInput({
        ewaBills: [manualBill({ status: "Invoiced", invoiceId: "inv9" })],
        invoices: [{ id: "inv9", invoiceNumber: "INV-2026-000001" } as unknown as Invoice],
      }),
    );
    expect(result.status).toBe("none");
    if (result.status !== "none") return;
    expect(result.message).toBe("EWA Bill already invoiced.");
  });

  it("reports no bill when the billing period has none", () => {
    const result = resolveEwaCharge(
      lookupInput({ ewaBills: [manualBill({ month: "September 2026" })] }),
    );
    expect(result.status).toBe("none");
    if (result.status !== "none") return;
    expect(result.message).toBe("No EWA Bill found for this Unit and billing period.");
  });

  it("treats another unit's per-unit bill as no bill for this unit", () => {
    const result = resolveEwaCharge(
      lookupInput({
        ewaBills: [manualBill({ id: "bill3", billNumber: "EWA-0003", unitId: "u12", billAmount: 56.245 })],
        ewaDistributions: [distribution],
      }),
    );
    expect(result.status).toBe("none");
    if (result.status !== "none") return;
    expect(result.message).toBe("No EWA Bill found for this Unit and billing period.");
  });

  it("reports when no EWA account is linked to the unit", () => {
    const result = resolveEwaCharge(lookupInput({ ewaAccounts: [] }));
    expect(result.status).toBe("none");
    if (result.status !== "none") return;
    expect(result.message).toBe("No EWA Account linked to this Unit.");
  });

  it("reports when the bill exists but the unit's allocation is zero", () => {
    const zeroPctAccount = {
      ...account,
      id: "acc-zero",
      accountNumber: "0000000000",
      allocationMethod: "percentage",
      rules: [{ unitId: "u13", percentage: 0 }],
    } as unknown as EWAAccount;
    const result = resolveEwaCharge(
      lookupInput({ ewaAccounts: [zeroPctAccount], ewaBills: [manualBill({ ewaAccountId: "acc-zero" })] }),
    );
    expect(result.status).toBe("none");
    if (result.status !== "none") return;
    expect(result.message).toBe("No EWA allocation found for this Unit.");
  });

  it("flags a vacant unit's landlord-charged share as not chargeable", () => {
    // Unit 12 is vacant; the account charges vacant units to the landlord.
    const cls = classifyEwaBill(manualBill(), "u12", account, {
      units: baseData.units,
      leases: baseData.leases.filter((l) => l.unitId !== "u12"),
      tenants: baseData.tenants,
      ewaDistributions: [],
    });
    expect(cls.chargeable).toBe(false);
    expect(cls.landlord).toBe(true);
  });

  it("falls back to the unit's allocation when only the other unit's bill was distribution-created", () => {
    // Bill logged on Unit 12, NOT from a distribution → it is the account's
    // bill; Unit 13's share must still come out as the allocation (56.245).
    const cls = classifyEwaBill(manualBill({ unitId: "u12", leaseId: "L12" }), "u13", account, {
      units: baseData.units,
      leases: baseData.leases,
      tenants: baseData.tenants,
      ewaDistributions: [],
    });
    expect(cls.belongs).toBe(true);
    expect(cls.share).toBe(56.245);
  });
});

describe("timezone-safe billing month matching", () => {
  it("parses every stored month format to the same YYYY-MM key", () => {
    expect(monthKeyOf("2026-10")).toBe("2026-10");
    expect(monthKeyOf("2026-10-01")).toBe("2026-10");
    expect(monthKeyOf("October 2026")).toBe("2026-10");
    expect(monthKeyOf("Oct 2026")).toBe("2026-10");
    expect(monthKeyOf("10/2026")).toBe("2026-10");
    expect(monthKeyOf("2026 Oct")).toBe("2026-10");
    expect(monthKeyOf("Jun 2025")).toBe("2025-06");
    expect(monthKeyOf("")).toBe("");
  });

  it("matches invoice period (2026-10-01) against free-text bill month (October 2026)", () => {
    // This equality is what broke before: local-timezone Date parsing could
    // shift "2026-10" into September on UTC-negative browsers.
    expect(monthKeyOf("2026-10-01")).toBe(monthKeyOf("October 2026"));
  });
});
