// src/test/leaseInvoiceSync.test.ts
// Acceptance tests for lease-driven automatic invoice synchronization.
// Mirrors the user's acceptance scenarios TEST 1–6 against the pure sync
// engine, applying each plan exactly like the Durable Object's applyMutate
// (add = upsert by id, update = merge patch) so duplicate protection and
// idempotency are verified end-to-end.

import { describe, expect, it } from "vitest";
import {
  getLeaseBillingPeriods,
  planLeaseInvoiceSync,
  type LeaseInvoiceSyncPlan,
} from "@/lib/leaseInvoiceSync";
import type { Invoice, Lease, Payment } from "@/types";

const lease: Lease = {
  id: "l-1",
  contractNumber: "LSE-2026-001",
  tenantId: "t-1",
  unitId: "u-1",
  startDate: "2026-10-01",
  endDate: "2027-09-30",
  monthlyRent: 150,
  securityDeposit: 150,
  status: "Active",
  paymentFrequency: "Monthly",
  contractDays: 365,
};

interface Store {
  invoices: Invoice[];
  payments: Payment[];
}

/** Apply a plan exactly like the Durable Object's applyMutate does. */
function applyPlan(store: Store, plan: LeaseInvoiceSyncPlan): void {
  for (const invoice of plan.create) {
    const idx = store.invoices.findIndex((i) => i.id === invoice.id);
    if (idx >= 0) store.invoices[idx] = invoice;
    else store.invoices.push(invoice);
  }
  for (const upd of plan.update) {
    const idx = store.invoices.findIndex((i) => i.id === upd.id);
    if (idx >= 0) store.invoices[idx] = { ...store.invoices[idx], ...upd.patch, id: upd.id };
  }
  for (const cancel of plan.cancel) {
    const idx = store.invoices.findIndex((i) => i.id === cancel.id);
    if (idx >= 0) store.invoices[idx] = { ...store.invoices[idx], status: "Cancelled", balance: 0 };
  }
}

function runSync(store: Store, leaseToSync: Lease): LeaseInvoiceSyncPlan {
  const plan = planLeaseInvoiceSync({
    lease: leaseToSync,
    invoices: store.invoices,
    payments: store.payments,
    ewaBills: [],
    maintenanceRequests: [],
    expenses: [],
    unitBuildingId: "bld-1",
    currentPeriodKey: "2026-09",
    nextInvoiceNumber: (i: number) =>
      `INV-2026-${String(store.invoices.length + i + 1).padStart(6, "0")}`,
  });
  applyPlan(store, plan);
  return plan;
}

const paidPayment = (invoiceId: string, amount: number): Payment => ({
  id: `p-${invoiceId}`,
  receiptNumber: `RCP-${invoiceId}`,
  invoiceId,
  tenantId: "t-1",
  amount,
  paymentDate: "2026-09-29",
  method: "Cash",
});

describe("lease invoice synchronization — acceptance tests", () => {
  it("TEST 1 — new lease 01/10/2026 → 30/09/2027 @ 150 creates exactly 12 invoices", () => {
    const store: Store = { invoices: [], payments: [] };
    const plan = runSync(store, lease);

    expect(plan.create).toHaveLength(12);
    expect(store.invoices).toHaveLength(12);
    // One invoice per month, each 150.000, total scheduled 1,800.000
    const amounts = store.invoices.map((i) => i.amount);
    expect(amounts.every((a) => a === 150)).toBe(true);
    expect(amounts.reduce((s, a) => s + a, 0)).toBe(1800);
    // Linked to the lease (Lease ID is the primary relationship)
    expect(store.invoices.every((i) => i.leaseId === lease.id && i.tenantId === "t-1" && i.unitId === "u-1")).toBe(true);
    // New invoices start Unpaid (Draft in existing terminology)
    expect(store.invoices.every((i) => i.status === "Draft" && i.balance === i.amount)).toBe(true);
    // Billing months October 2026 → September 2027
    const keys = store.invoices.map((i) => (i.periodFrom ?? "").slice(0, 7)).sort();
    expect(keys[0]).toBe("2026-10");
    expect(keys[11]).toBe("2027-09");
    // First period starts on the lease start date; last ends on the lease end date
    const oct = store.invoices.find((i) => (i.periodFrom ?? "").startsWith("2026-10"));
    const sep = store.invoices.find((i) => (i.periodFrom ?? "").startsWith("2027-09"));
    expect(oct?.periodFrom).toBe("2026-10-01");
    expect(sep?.periodTo).toBe("2027-09-30");
  });

  it("TEST 2 — running the workflow again creates no duplicates (still exactly 12)", () => {
    const store: Store = { invoices: [], payments: [] };
    runSync(store, lease);
    const plan2 = runSync(store, lease);
    expect(plan2.create).toHaveLength(0);
    expect(plan2.update).toHaveLength(0);
    expect(plan2.cancel).toHaveLength(0);
    expect(store.invoices).toHaveLength(12);
    expect(new Set(store.invoices.map((i) => i.id)).size).toBe(12);

    // Simulate a second client running the same sync concurrently with
    // different invoice numbers — deterministic ids + DO upsert keep 12.
    const concurrentPlan = planLeaseInvoiceSync({
      lease,
      invoices: [],
      payments: [],
      ewaBills: [],
      maintenanceRequests: [],
      expenses: [],
      unitBuildingId: "bld-1",
      currentPeriodKey: "2026-09",
      nextInvoiceNumber: (i: number) => `INV-OTHER-${String(i + 1).padStart(6, "0")}`,
    });
    applyPlan(store, concurrentPlan);
    expect(store.invoices).toHaveLength(12);
    expect(new Set(store.invoices.map((i) => i.id)).size).toBe(12);
  });

  it("TEST 3 — rent 150 → 175 updates future unpaid invoices; paid invoices are protected", () => {
    const store: Store = { invoices: [], payments: [] };
    runSync(store, lease);

    // Tenant pays October at the old rent BEFORE the lease is edited.
    const oct = store.invoices.find((i) => (i.periodFrom ?? "").startsWith("2026-10")) as Invoice;
    oct.status = "Paid";
    oct.balance = 0;
    store.payments.push(paidPayment(oct.id, 150));

    const plan = runSync(store, { ...lease, monthlyRent: 175 });
    expect(plan.create).toHaveLength(0);
    expect(plan.cancel).toHaveLength(0);
    // 11 future unpaid invoices updated; the paid October invoice untouched
    expect(plan.update).toHaveLength(11);
    expect(plan.update.map((u) => u.id)).not.toContain(oct.id);
    expect(store.invoices).toHaveLength(12);
    expect(oct.amount).toBe(150);
    expect(oct.status).toBe("Paid");
    const updated = store.invoices.filter((i) => i.id !== oct.id);
    expect(updated.every((i) => i.amount === 175 && i.rentAmount === 175)).toBe(true);
    // No duplicate invoices
    expect(new Set(store.invoices.map((i) => i.id)).size).toBe(12);
  });

  it("TEST 4 — extending the lease to 30/11/2027 adds exactly 2 invoices (14 total)", () => {
    const store: Store = { invoices: [], payments: [] };
    runSync(store, lease);

    const plan = runSync(store, { ...lease, endDate: "2027-11-30" });
    expect(plan.create).toHaveLength(2);
    const createdKeys = plan.create.map((i) => (i.periodFrom ?? "").slice(0, 7)).sort();
    expect(createdKeys).toEqual(["2027-10", "2027-11"]);
    expect(store.invoices).toHaveLength(14);
    expect(store.invoices.filter((i) => i.amount === 175 || i.amount === 150)).toHaveLength(14);
    // No duplicates for the original 12 months
    expect(new Set(store.invoices.map((i) => `${i.leaseId}:${(i.periodFrom ?? "").slice(0, 7)}`)).size).toBe(14);
  });

  it("TEST 5 — shortening the lease cancels future unpaid months; paid history untouched", () => {
    const store: Store = { invoices: [], payments: [] };
    runSync(store, lease);

    const plan = runSync(store, { ...lease, endDate: "2027-06-30" });
    // July/August/September 2027 are no longer within the lease period
    expect(plan.cancel).toHaveLength(3);
    const cancelled = store.invoices.filter((i) => i.status === "Cancelled");
    expect(cancelled.map((i) => (i.periodFrom ?? "").slice(0, 7)).sort()).toEqual([
      "2027-07",
      "2027-08",
      "2027-09",
    ]);
    // Financial records are NOT destroyed — the 12 records remain in the store
    expect(store.invoices).toHaveLength(12);
    // Scheduled (non-cancelled) invoices now end with June 2027
    const scheduled = store.invoices.filter((i) => i.status !== "Cancelled");
    expect(scheduled).toHaveLength(9);
    // Re-running must not resurrect cancelled months
    const plan2 = runSync(store, { ...lease, endDate: "2027-06-30" });
    expect(plan2.create).toHaveLength(0);
    expect(plan2.cancel).toHaveLength(0);
    expect(store.invoices).toHaveLength(12);
  });

  it("TEST 5b — a partially paid invoice outside the shortened period is protected", () => {
    const store: Store = { invoices: [], payments: [] };
    runSync(store, lease);

    const jul = store.invoices.find((i) => (i.periodFrom ?? "").startsWith("2027-07")) as Invoice;
    jul.status = "Partial";
    jul.balance = 50;
    store.payments.push(paidPayment(jul.id, 100));

    const plan = runSync(store, { ...lease, endDate: "2027-06-30" });
    expect(plan.cancel.map((c) => c.id)).not.toContain(jul.id);
    expect(plan.cancel).toHaveLength(2);
    expect(jul.status).toBe("Partial");
    expect(store.invoices).toHaveLength(12);
  });

  it("TEST 6 — all changes persist across a reload/re-sync (idempotent, nothing lost)", () => {
    const store: Store = { invoices: [], payments: [] };
    runSync(store, lease);
    runSync(store, { ...lease, monthlyRent: 175 });
    runSync(store, { ...lease, monthlyRent: 175, endDate: "2027-11-30" });
    runSync(store, { ...lease, monthlyRent: 175, endDate: "2027-06-30" });

    // "Reload": a fresh sync against the same persisted store changes nothing
    const plan = runSync(store, { ...lease, monthlyRent: 175, endDate: "2027-06-30" });
    expect(plan.create).toHaveLength(0);
    expect(plan.update).toHaveLength(0);
    expect(plan.cancel).toHaveLength(0);
    // Records are NEVER destroyed — the 14 created records (12 original + 2
    // extension months) all remain, the out-of-period ones marked Cancelled.
    expect(store.invoices).toHaveLength(14);
    expect(store.invoices.filter((i) => i.status === "Cancelled")).toHaveLength(5);
    // Rent change persisted on all scheduled invoices
    expect(store.invoices.filter((i) => i.status !== "Cancelled").every((i) => i.amount === 175)).toBe(true);
  });

  it("TEST 7 — legacy invoices without a leaseId are adopted, not duplicated", () => {
    const store: Store = {
      invoices: [
        {
          id: "inv-legacy-1",
          invoiceNumber: "INV-2026-000001",
          tenantId: "t-1",
          leaseId: "",
          unitId: "u-1",
          dueDate: "2026-10-06",
          periodFrom: "2026-10-01",
          periodTo: "2026-10-31",
          amount: 150,
          balance: 150,
          status: "Draft",
          lineItems: [{ id: "li-1", description: "Monthly Rent — October 2026", amount: 150, type: "Rent" }],
        },
      ],
      payments: [],
    };
    const plan = runSync(store, lease);
    // The legacy invoice is linked instead of a second one being created for October
    expect(plan.create.find((i) => (i.periodFrom ?? "").startsWith("2026-10"))).toBeUndefined();
    const octInvoices = store.invoices.filter(
      (i) => i.leaseId === lease.id && (i.periodFrom ?? "").startsWith("2026-10"),
    );
    expect(octInvoices).toHaveLength(1);
    expect(octInvoices[0].id).toBe("inv-legacy-1");
    expect(store.invoices).toHaveLength(12);
  });

  it("TEST 8 — start date change re-schedules the billing months (old schedule cleaned up)", () => {
    const store: Store = { invoices: [], payments: [] };
    runSync(store, lease);

    // Start moves 01/10 → 01/11: October 2026 falls outside the lease and is
    // cancelled; November 2026 (already scheduled) becomes the first month.
    const plan = runSync(store, { ...lease, startDate: "2026-11-01" });
    const cancelledKeys = plan.cancel.map((c) => (store.invoices.find((i) => i.id === c.id)?.periodFrom ?? "").slice(0, 7));
    expect(cancelledKeys).toEqual(["2026-10"]);
    expect(plan.create).toEqual([]);
    const scheduled = store.invoices.filter((i) => i.status !== "Cancelled");
    expect(scheduled).toHaveLength(11);
    const scheduledKeys = new Set(scheduled.map((i) => (i.periodFrom ?? "").slice(0, 7)));
    expect(scheduledKeys.has("2026-10")).toBe(false);
    expect(scheduledKeys.has("2026-11")).toBe(true);
    // The cancelled October record is kept (not destroyed)
    expect(store.invoices).toHaveLength(12);

    // Back-dating the start creates the missing earlier month instead
    const plan2 = runSync(store, { ...lease, startDate: "2026-09-01" });
    expect(plan2.create.map((i) => (i.periodFrom ?? "").slice(0, 7))).toEqual(["2026-09"]);
    const scheduled2 = store.invoices.filter((i) => i.status !== "Cancelled");
    expect(scheduled2).toHaveLength(12);
    expect(scheduled2.every((i) => (i.periodFrom ?? "").slice(0, 7) >= "2026-09")).toBe(true);
  });

  it("TEST 9 — rent re-sync only touches the rent line; other charges are preserved", () => {
    const store: Store = { invoices: [], payments: [] };
    runSync(store, lease);
    // Simulate a current-month invoice that already carries an EWA charge
    const oct = store.invoices.find((i) => (i.periodFrom ?? "").startsWith("2026-10")) as Invoice;
    oct.lineItems = [
      ...oct.lineItems,
      { id: "li-ewa", description: "EWA Utility Charges — October 2026", amount: 20, type: "EWA" },
    ];
    oct.ewaAmount = 20;
    oct.amount = 170;

    const plan = runSync(store, { ...lease, monthlyRent: 175 });
    expect(plan.update.map((u) => u.id)).toContain(oct.id);
    // applyPlan merges patches into NEW objects — re-read from the store
    const synced = store.invoices.find((i) => i.id === oct.id) as Invoice;
    expect(synced.rentAmount).toBe(175);
    expect(synced.amount).toBe(195); // 175 rent + 20 EWA
    expect(synced.lineItems.find((li) => li.type === "EWA")?.amount).toBe(20);
    expect(synced.lineItems.find((li) => li.type === "Rent")?.amount).toBe(175);
  });

  it("getLeaseBillingPeriods — boundaries, invalid and inverted ranges", () => {
    const periods = getLeaseBillingPeriods(lease);
    expect(periods).toHaveLength(12);
    expect(periods[0]).toEqual({ periodKey: "2026-10", periodFrom: "2026-10-01", periodTo: "2026-10-31" });
    expect(periods[11]).toEqual({ periodKey: "2027-09", periodFrom: "2027-09-01", periodTo: "2027-09-30" });
    expect(getLeaseBillingPeriods({ ...lease, endDate: "2026-09-30" })).toEqual([]);
    expect(getLeaseBillingPeriods({ ...lease, startDate: "", endDate: "" })).toEqual([]);
  });
});
