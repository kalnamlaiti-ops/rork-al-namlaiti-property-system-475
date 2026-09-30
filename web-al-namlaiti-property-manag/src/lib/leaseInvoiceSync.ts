// src/lib/leaseInvoiceSync.ts
// Lease-driven automatic invoice synchronization engine.
//
// The LEASE is the source of truth for the future rent schedule:
//   ONE LEASE → ONE MONTHLY INVOICE PER BILLING PERIOD
//   NO DUPLICATES (leaseId + billing month, deterministic invoice ids)
//   PAID HISTORICAL INVOICES → PROTECTED (never modified)
//   FUTURE UNPAID INVOICES → SYNCHRONIZED with the lease
//
// This module is PURE: `planLeaseInvoiceSync` computes a plan of
// creates/updates/cancels with no side effects. The caller (DataContext)
// executes the plan through the existing durable mutation pipeline
// (Worker → Durable Object → SQLite → broadcast), so every change is
// persisted on the backend before it is acknowledged and echoed to all
// connected clients.

import type {
  EWABill,
  Expense,
  Invoice,
  Lease,
  MaintenanceRequest,
  Payment,
} from "@/types";
import { calculateInvoice, formatPeriodLabel } from "@/lib/invoiceGenerator";

export interface BillingPeriod {
  /** Billing month key, e.g. "2026-10". */
  periodKey: string;
  /** Billing period start (YYYY-MM-DD) — lease start date for the first month. */
  periodFrom: string;
  /** Billing period end (YYYY-MM-DD) — lease end date for the last month. */
  periodTo: string;
}

export interface LeaseInvoiceSyncPlan {
  /** Invoices to create (complete records with deterministic ids). */
  create: Invoice[];
  /** Invoices to update (patch only — e.g. rent amount, lease links). */
  update: { id: string; invoiceNumber: string; reason: string; patch: Partial<Invoice> }[];
  /** Unpaid invoices whose billing month is no longer inside the lease. */
  cancel: { id: string; invoiceNumber: string }[];
}

export interface LeaseInvoiceSyncInput {
  lease: Lease;
  invoices: Invoice[];
  payments: Payment[];
  ewaBills: EWABill[];
  maintenanceRequests: MaintenanceRequest[];
  expenses: Expense[];
  /** Building id of the lease's unit — matches building-level expenses. */
  unitBuildingId: string;
  /** Current billing month key ("YYYY-MM") — boundary for rent re-sync. */
  currentPeriodKey: string;
  /** Invoice number generator for the i-th invoice created in this run. */
  nextInvoiceNumber: (index: number) => string;
  /** Standard payment instructions stored on new invoices. */
  paymentInstructions?: string;
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** Parse "YYYY-MM-DD…" into parts without any timezone shifts. */
function parseISODate(iso: string): { y: number; m: number; d: number } | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? "");
  if (!match) return undefined;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (m < 1 || m > 12 || d < 1 || d > 31) return undefined;
  return { y, m, d };
}

const isoOf = (y: number, m: number, d: number): string => `${y}-${pad2(m)}-${pad2(d)}`;

/** Timezone-safe "YYYY-MM" period key from a "YYYY-MM-DD…" string. */
export function periodKeyOf(iso: string | undefined): string {
  const parts = parseISODate(iso ?? "");
  return parts ? `${parts.y}-${pad2(parts.m)}` : "";
}

/** Add days to a "YYYY-MM-DD" string without timezone shifts. */
function addDaysISO(iso: string, days: number): string {
  const p = parseISODate(iso);
  if (!p) return iso;
  const shifted = new Date(Date.UTC(p.y, p.m - 1, p.d + days));
  return isoOf(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate());
}

/**
 * Enumerate the monthly billing periods a lease covers, in order.
 * The first period starts on the lease start date and the last period ends
 * on the lease end date; middle periods use calendar month boundaries.
 * Returns [] when the lease dates are missing or inverted.
 */
export function getLeaseBillingPeriods(lease: Lease): BillingPeriod[] {
  const start = parseISODate(lease.startDate);
  const end = parseISODate(lease.endDate);
  if (!start || !end) return [];
  if (end.y * 12 + end.m < start.y * 12 + start.m) return [];
  const periods: BillingPeriod[] = [];
  let y = start.y;
  let m = start.m;
  while (y * 12 + m <= end.y * 12 + end.m) {
    const monthLastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const isFirst = y === start.y && m === start.m;
    const isLast = y === end.y && m === end.m;
    periods.push({
      periodKey: `${y}-${pad2(m)}`,
      periodFrom: isFirst ? lease.startDate.slice(0, 10) : isoOf(y, m, 1),
      periodTo: isLast ? lease.endDate.slice(0, 10) : isoOf(y, m, monthLastDay),
    });
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return periods;
}

/**
 * Deterministic auto-invoice id. The Durable Object upserts "add" mutations
 * by id, so even if two clients run the same synchronization concurrently,
 * the second write replaces the first — a duplicate record can never exist.
 */
export function autoInvoiceId(leaseId: string, periodKey: string): string {
  return `inv-auto-${leaseId}-${periodKey}`;
}

/**
 * An invoice is financially protected once it is Paid/Partially Paid or has
 * any payment recorded against it — synchronization never modifies it.
 */
export function isInvoiceFinanciallyProtected(invoice: Invoice, payments: Payment[]): boolean {
  if (invoice.status === "Paid" || invoice.status === "Partial") return true;
  return payments.some((p) => p.invoiceId === invoice.id && (p.amount ?? 0) > 0);
}

/**
 * Find the invoice that owns a lease + billing period (any status, including
 * Cancelled — a cancelled month must not be silently re-created).
 */
export function findInvoiceForPeriod(
  invoices: Invoice[],
  leaseId: string,
  periodKey: string,
): Invoice | undefined {
  return invoices.find((inv) => {
    if (inv.leaseId !== leaseId) return false;
    return periodKeyOf(inv.periodFrom ?? inv.dueDate) === periodKey;
  });
}

/**
 * Compute the synchronization plan for one lease.
 *
 * - Missing billing months → create (status Draft = Unpaid; due date anchored
 *   deterministically to the billing month so repeated runs never drift).
 * - Existing unpaid invoices from the current month onward → re-sync the rent
 *   amount (rent line only — EWA/maintenance/expense lines are preserved) and
 *   re-link tenant/unit if the lease moved.
 * - Older manually-created invoices without a leaseId that match the lease's
 *   tenant/unit/month → adopted (linked) instead of duplicated.
 * - Unpaid invoices whose month is outside the lease → Cancelled (record is
 *   kept; financial history is never destroyed).
 * - Paid / partially paid invoices → untouched, always.
 */
export function planLeaseInvoiceSync(input: LeaseInvoiceSyncInput): LeaseInvoiceSyncPlan {
  const {
    lease,
    invoices,
    payments,
    ewaBills,
    maintenanceRequests,
    expenses,
    unitBuildingId,
    currentPeriodKey,
    nextInvoiceNumber,
    paymentInstructions,
  } = input;

  const plan: LeaseInvoiceSyncPlan = { create: [], update: [], cancel: [] };
  const periods = getLeaseBillingPeriods(lease);
  const expectedKeys = new Set(periods.map((p) => p.periodKey));

  const paidFor = (invoiceId: string): number =>
    payments.filter((p) => p.invoiceId === invoiceId).reduce((sum, p) => sum + (p.amount || 0), 0);

  // ── 1. Ensure every billing month of the lease has exactly one invoice ──
  for (const period of periods) {
    let existing = findInvoiceForPeriod(invoices, lease.id, period.periodKey);

    // Adoption: a legacy invoice created manually without a leaseId that
    // matches the lease's tenant + unit + billing month is linked instead of
    // duplicated.
    let adoption = false;
    if (!existing) {
      const candidate = invoices.find(
        (inv) =>
          !inv.leaseId &&
          inv.tenantId === lease.tenantId &&
          inv.unitId === lease.unitId &&
          periodKeyOf(inv.periodFrom ?? inv.dueDate) === period.periodKey,
      );
      if (candidate) {
        existing = candidate;
        adoption = true;
      }
    }

    if (!existing) {
      // Create the missing monthly invoice from the CURRENT lease records.
      const calc = calculateInvoice({
        lease,
        ewaBills,
        maintenanceRequests,
        expenses,
        previousInvoices: invoices,
        periodKey: period.periodKey,
        unitBuildingId,
      });
      if (calc.total <= 0) continue;
      plan.create.push({
        id: autoInvoiceId(lease.id, period.periodKey),
        invoiceNumber: nextInvoiceNumber(plan.create.length),
        tenantId: lease.tenantId,
        leaseId: lease.id,
        unitId: lease.unitId,
        issueDate: period.periodFrom,
        dueDate: addDaysISO(period.periodFrom, 5),
        periodFrom: period.periodFrom,
        periodTo: period.periodTo,
        amount: calc.total,
        balance: calc.total,
        status: "Draft",
        lineItems: calc.lineItems,
        rentAmount: calc.rentAmount,
        ewaAmount: calc.ewaAmount,
        maintenanceAmount: calc.maintenanceAmount,
        otherExpensesAmount: calc.otherExpensesAmount,
        previousBalance: calc.previousBalance,
        taxRate: 0,
        taxAmount: calc.taxAmount,
        emailStatus: "Not Sent",
        generatedAutomatically: true,
        paymentInstructions,
      });
      continue;
    }

    // ── 2. Existing invoice — protected records are never touched ──
    if (isInvoiceFinanciallyProtected(existing, payments)) continue;

    const patch: Partial<Invoice> = {};
    const reasons: string[] = [];

    if (adoption) {
      patch.leaseId = lease.id;
      reasons.push("linked to lease");
    }

    // Keep future unpaid invoices linked to the lease's current tenant/unit.
    if (existing.tenantId !== lease.tenantId) {
      patch.tenantId = lease.tenantId;
      reasons.push("tenant updated");
    }
    if (existing.unitId !== lease.unitId) {
      patch.unitId = lease.unitId;
      reasons.push("unit updated");
    }

    // Rent re-sync applies from the current billing month onward — past
    // unpaid invoices are historical records of the previously agreed rent.
    if (period.periodKey >= currentPeriodKey) {
      const rentLine = existing.lineItems.find((li) => li.type === "Rent");
      if (rentLine && (lease.monthlyRent || 0) > 0 && rentLine.amount !== lease.monthlyRent) {
        const lineItems: Invoice["lineItems"] = existing.lineItems.map((li) =>
          li.type === "Rent"
            ? { ...li, amount: lease.monthlyRent, description: `Monthly Rent — ${formatPeriodLabel(period.periodKey)}` }
            : li,
        );
        const subtotal = lineItems.reduce((sum, li) => sum + li.amount, 0);
        const taxRate = existing.taxRate ?? 0;
        const taxAmount = Math.round(subtotal * (taxRate / 100) * 1000) / 1000;
        const amount = Math.round((subtotal + taxAmount) * 1000) / 1000;
        patch.lineItems = lineItems;
        patch.rentAmount = lease.monthlyRent;
        patch.taxAmount = taxAmount;
        patch.amount = amount;
        patch.balance = Math.max(0, Math.round((amount - paidFor(existing.id)) * 1000) / 1000);
        reasons.push(`rent updated to ${lease.monthlyRent.toFixed(3)}`);
      }
    }

    if (Object.keys(patch).length > 0) {
      plan.update.push({
        id: existing.id,
        invoiceNumber: existing.invoiceNumber,
        reason: reasons.join(", "),
        patch,
      });
    }
  }

  // ── 3. Unpaid invoices outside the lease period → Cancelled (records kept) ──
  for (const invoice of invoices) {
    if (invoice.leaseId !== lease.id) continue;
    const key = periodKeyOf(invoice.periodFrom ?? invoice.dueDate);
    if (!key || expectedKeys.has(key)) continue;
    if (isInvoiceFinanciallyProtected(invoice, payments)) continue;
    if (invoice.status === "Cancelled") continue;
    plan.cancel.push({ id: invoice.id, invoiceNumber: invoice.invoiceNumber });
  }

  return plan;
}
