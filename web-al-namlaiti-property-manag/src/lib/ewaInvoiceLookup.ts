// src/lib/ewaInvoiceLookup.ts
// EWA invoice lookup — the exact chain the invoice form follows when a line
// item's category is set to EWA:
//
//   Invoice (billing period) → Lease → Unit → EWA Account → EWA Bill
//     → unit allocation → EWA amount
//
// Pure functions (no React, no side effects) so the form and the tests share
// the exact same logic. The unit's share always comes from the real EWA bill
// and the account's allocation engine — it is never typed or guessed.

import { computeAllocation } from "@/lib/ewaAllocation";
import { formatPeriodLabel } from "@/lib/invoiceGenerator";
import type {
  EWAAccount,
  EWABill,
  EWADistribution,
  Invoice,
  Lease,
  Tenant,
  Unit,
} from "@/types";

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Round to BHD's 3-decimal precision (112.49 / 2 = 56.245 — never 56.25). */
export function round3(n: number): number {
  return Math.round((n + Number.EPSILON) * 1000) / 1000;
}

/**
 * Timezone-safe billing month key (YYYY-MM) from any stored month value:
 * "2026-10", "2026-10-01", "October 2026", "Oct 2026", "10/2026", "2026 Oct".
 *
 * Structured formats are parsed with regex — never round-tripped through
 * `new Date()` + local-time getters, which shift the month depending on the
 * browser timezone (e.g. a UTC-negative browser turns "2026-10" into
 * September) and break bill matching.
 */
export function monthKeyOf(value: string | undefined): string {
  if (!value) return "";
  const v = String(value).trim();

  let m = v.match(/^(\d{4})[-/.](\d{1,2})(?:[-/.].*)?$/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}`;

  m = v.match(/^(\d{1,2})[-/.](\d{4})$/);
  if (m) {
    const mo = Number(m[1]);
    if (mo >= 1 && mo <= 12) return `${m[2]}-${String(mo).padStart(2, "0")}`;
  }

  m = v.match(/^([A-Za-z]{3,})[-\s./]+(\d{4})/);
  if (m) {
    const idx = MONTHS.findIndex((mo) => m![1].toLowerCase().startsWith(mo));
    if (idx >= 0) return `${m[2]}-${String(idx + 1).padStart(2, "0")}`;
  }

  m = v.match(/^(\d{4})[-\s./]+([A-Za-z]{3,})/);
  if (m) {
    const idx = MONTHS.findIndex((mo) => m![2].toLowerCase().startsWith(mo));
    if (idx >= 0) return `${m[1]}-${String(idx + 1).padStart(2, "0")}`;
  }

  const d = new Date(v);
  if (!Number.isNaN(d.getTime())) {
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  }
  return v;
}

/** Workspace data needed to classify a bill and run the allocation engine. */
export interface EwaLookupData {
  units: Unit[];
  leases: Lease[];
  tenants: Tenant[];
  ewaAccounts: EWAAccount[];
  ewaBills: EWABill[];
  ewaDistributions: EWADistribution[];
  invoices: Invoice[];
}

export interface EwaClassifyResult {
  /** The unit's share of the bill in BHD (3 decimals). */
  share: number;
  /** True when the bill is a per-unit bill created by a distribution — its
   *  billAmount already IS this unit's share and is never re-divided. */
  perUnit: boolean;
  /** False when this unit's share is excluded or charged to the landlord. */
  chargeable: boolean;
  /** False when the bill is a per-unit bill belonging to a different unit —
   *  irrelevant for this lookup (there is simply no bill for this unit). */
  belongs: boolean;
}

/**
 * The selected unit's share of one EWA bill.
 *
 * - Distribution-created bill (linked from a distribution allocation):
 *   billAmount is already the unit's allocated share — used as-is.
 * - Any other bill (e.g. the shared account's total bill logged manually):
 *   the unit's share comes from the account's allocation engine
 *   (equal / percentage / fixed / meter, including vacancy handling), so no
 *   distribution processing is required first.
 */
export function classifyEwaBill(
  bill: EWABill,
  unitId: string,
  account: EWAAccount | undefined,
  data: Pick<EwaLookupData, "units" | "leases" | "tenants" | "ewaDistributions">,
): EwaClassifyResult {
  const distAlloc = data.ewaDistributions
    .flatMap((d) => d.allocations ?? [])
    .find((a) => a.ewaBillId === bill.id);

  if (distAlloc) {
    if (distAlloc.unitId !== unitId) {
      // The bill is another unit's per-unit bill — no bill for this unit.
      return { share: 0, perUnit: true, chargeable: false, belongs: false };
    }
    const chargeable = !distAlloc.excluded && !distAlloc.chargeToLandlord && distAlloc.amount > 0;
    return { share: round3(bill.billAmount || 0), perUnit: true, chargeable, belongs: true };
  }

  if (!account) return { share: 0, perUnit: false, chargeable: false, belongs: false };

  const result = computeAllocation({
    account,
    totalAmount: bill.billAmount || 0,
    units: data.units,
    leases: data.leases,
    tenants: data.tenants,
  });
  const allocation = result.allocations.find((a) => a.unitId === unitId);
  if (!allocation || allocation.excluded || allocation.chargeToLandlord || allocation.amount <= 0) {
    return { share: 0, perUnit: false, chargeable: false, belongs: true };
  }
  return { share: round3(allocation.amount), perUnit: false, chargeable: true, belongs: true };
}

/** The EWA account serving a unit (Active first, any linked account as fallback). */
export function findUnitEwaAccount(unitId: string, ewaAccounts: EWAAccount[]): EWAAccount | undefined {
  return (
    ewaAccounts.find((a) => a.status === "Active" && a.linkedUnitIds.includes(unitId)) ??
    ewaAccounts.find((a) => a.linkedUnitIds.includes(unitId))
  );
}

/** One selectable EWA bill with the unit's already-computed share. */
export interface EwaCandidate {
  bill: EWABill;
  account: EWAAccount;
  /** Unit's allocated share in BHD (3 decimals) — auto-fills the line amount. */
  share: number;
  perUnit: boolean;
}

export type EwaResolution =
  | { status: "ok"; candidate: EwaCandidate }
  | { status: "choice"; candidates: EwaCandidate[] }
  | { status: "none"; message: string };

export interface EwaLookupInput extends EwaLookupData {
  leaseId: string;
  /** Invoice billing period start (e.g. "2026-10-01") — determines the month. */
  periodFrom: string;
  /** EWA bills already attached to other EWA lines on this invoice. */
  usedBillIds?: string[];
}

/**
 * Resolve the EWA charge for a lease/unit and billing period.
 *
 * Preference order for candidates: same account → same unit → same billing
 * period. Exactly one match resolves automatically; several matches produce a
 * "choice" so the user picks instead of the system guessing.
 */
export function resolveEwaCharge(input: EwaLookupInput): EwaResolution {
  const { leaseId, periodFrom, usedBillIds = [] } = input;
  const lease = input.leases.find((l) => l.id === leaseId);
  if (!lease) return { status: "none", message: "Select a lease first." };

  const unit = input.units.find((u) => u.id === lease.unitId);
  if (!unit) return { status: "none", message: "No unit found for this lease." };

  const account = findUnitEwaAccount(unit.id, input.ewaAccounts);
  if (!account) return { status: "none", message: "No EWA account is linked to this unit." };

  const periodKey = monthKeyOf(periodFrom);

  // Bills belonging to the shared account; fall back to unit/lease-linked
  // bills that predate account linking.
  const matched = input.ewaBills.filter(
    (b) =>
      monthKeyOf(b.month) === periodKey &&
      (b.ewaAccountId === account.id ||
        (!b.ewaAccountId && (b.unitId === unit.id || b.leaseId === lease.id))),
  );
  if (matched.length === 0) {
    return { status: "none", message: "No EWA bill found for this unit and billing period." };
  }

  const used = new Set(usedBillIds);
  const duplicates: EWABill[] = [];
  const invoiced: EWABill[] = [];
  const notChargeable: EWABill[] = [];
  const available: EwaCandidate[] = [];

  for (const bill of matched) {
    if (used.has(bill.id)) {
      duplicates.push(bill);
      continue;
    }
    if (bill.invoiceId || bill.status === "Invoiced") {
      invoiced.push(bill);
      continue;
    }
    const cls = classifyEwaBill(bill, unit.id, account, input);
    if (!cls.belongs) continue; // another unit's per-unit bill
    if (!cls.chargeable) {
      notChargeable.push(bill);
      continue;
    }
    available.push({ bill, account, share: cls.share, perUnit: cls.perUnit });
  }

  if (available.length === 0) {
    if (duplicates.length > 0) {
      return { status: "none", message: "EWA already added to this invoice." };
    }
    if (invoiced.length > 0) {
      const first = invoiced[0];
      const existingInvoice = first.invoiceId
        ? input.invoices.find((i) => i.id === first.invoiceId)
        : undefined;
      return {
        status: "none",
        message: `EWA bill already invoiced${existingInvoice ? ` on ${existingInvoice.invoiceNumber}` : ""}.`,
      };
    }
    if (notChargeable.length > 0) {
      return {
        status: "none",
        message: "This unit's EWA share for this period is charged to the landlord.",
      };
    }
    return { status: "none", message: "No EWA bill found for this unit and billing period." };
  }

  // Per-unit distribution bills are the most precise source — offer them first.
  available.sort((a, b) => {
    if (a.perUnit !== b.perUnit) return a.perUnit ? -1 : 1;
    return a.bill.billNumber.localeCompare(b.bill.billNumber);
  });

  if (available.length === 1) return { status: "ok", candidate: available[0] };
  return { status: "choice", candidates: available };
}

/** Auto-generated description for an EWA line, e.g. "EWA - October 2026". */
export function ewaLineDescription(bill: EWABill): string {
  return `EWA - ${formatPeriodLabel(monthKeyOf(bill.month))}`;
}
