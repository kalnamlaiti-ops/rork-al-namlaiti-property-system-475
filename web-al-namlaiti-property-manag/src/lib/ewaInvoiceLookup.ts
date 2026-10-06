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
  /** True when this unit's share is absorbed by the landlord (vacant unit). */
  landlord: boolean;
  /** False when the bill is a per-unit bill belonging to a different unit —
   *  irrelevant for this lookup (there is simply no bill for this unit). */
  belongs: boolean;
}

/** Values of the full lookup chain — used for the temporary debug log. */
interface EwaDebugInfo {
  leaseId?: string;
  unitId?: string;
  unitNumber?: string;
  accountId?: string;
  accountNumber?: string;
  billId?: string;
  billMonth?: string;
  billTotal?: number;
  allocationUnitId?: string;
  allocationAmount?: number;
  periodFrom?: string;
  periodTo?: string;
  finalAmount?: number;
}

const debugValue = (v: unknown): string =>
  v === undefined || v === null || v === "" ? "(not found)" : String(v);

/**
 * TEMPORARY: logs the complete Lease → Unit → EWA Account → EWA Bill →
 * allocation chain so a broken relationship is immediately visible in the
 * console. Remove once the EWA invoice flow is confirmed stable.
 */
function logEwaDebug(info: EwaDebugInfo, extra?: string[]): void {
  const lines = [
    "[EWA INVOICE DEBUG]",
    `LEASE ID: ${debugValue(info.leaseId)}`,
    `UNIT ID: ${debugValue(info.unitId)}`,
    `UNIT NUMBER: ${debugValue(info.unitNumber)}`,
    `EWA ACCOUNT ID: ${debugValue(info.accountId)}`,
    `EWA ACCOUNT NUMBER: ${debugValue(info.accountNumber)}`,
    `EWA BILL ID: ${debugValue(info.billId)}`,
    `EWA BILL MONTH: ${debugValue(info.billMonth)}`,
    `EWA BILL TOTAL: ${info.billTotal === undefined ? "(not found)" : info.billTotal.toFixed(3)}`,
    `ALLOCATION UNIT ID: ${debugValue(info.allocationUnitId)}`,
    `ALLOCATION AMOUNT: ${info.allocationAmount === undefined ? "(not found)" : info.allocationAmount.toFixed(3)}`,
    `INVOICE PERIOD FROM: ${debugValue(info.periodFrom)}`,
    `INVOICE PERIOD TO: ${debugValue(info.periodTo)}`,
    `FINAL EWA AMOUNT: ${info.finalAmount === undefined ? "(none)" : info.finalAmount.toFixed(3)}`,
  ];
  if (extra?.length) lines.push(...extra);
  console.log(lines.join("\n"));
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
      return { share: 0, perUnit: true, chargeable: false, landlord: false, belongs: false };
    }
    const chargeable = !distAlloc.excluded && !distAlloc.chargeToLandlord && distAlloc.amount > 0;
    return {
      share: round3(bill.billAmount || 0),
      perUnit: true,
      chargeable,
      landlord: chargeable ? false : distAlloc.chargeToLandlord,
      belongs: true,
    };
  }

  if (!account) return { share: 0, perUnit: false, chargeable: false, landlord: false, belongs: false };

  const result = computeAllocation({
    account,
    totalAmount: bill.billAmount || 0,
    units: data.units,
    leases: data.leases,
    tenants: data.tenants,
  });
  const allocation = result.allocations.find((a) => a.unitId === unitId);
  if (!allocation) {
    return { share: 0, perUnit: false, chargeable: false, landlord: false, belongs: true };
  }
  if (allocation.chargeToLandlord) {
    return { share: 0, perUnit: false, chargeable: false, landlord: true, belongs: true };
  }
  if (allocation.excluded || allocation.amount <= 0) {
    return { share: 0, perUnit: false, chargeable: false, landlord: false, belongs: true };
  }
  return { share: round3(allocation.amount), perUnit: false, chargeable: true, landlord: false, belongs: true };
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
  /** Invoice billing period end — logged for debugging. */
  periodTo?: string;
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
  const { leaseId, periodFrom, periodTo, usedBillIds = [] } = input;
  const periodKey = monthKeyOf(periodFrom);

  const lease = input.leases.find((l) => l.id === leaseId);
  if (!lease) {
    logEwaDebug({ leaseId, periodFrom, periodTo });
    return {
      status: "none",
      message: leaseId ? "Lease could not be found." : "Select a lease first.",
    };
  }

  const unit = input.units.find((u) => u.id === lease.unitId);
  if (!unit) {
    logEwaDebug({ leaseId: lease.id, unitId: lease.unitId, periodFrom, periodTo });
    return { status: "none", message: "Lease has no Unit." };
  }

  const account = findUnitEwaAccount(unit.id, input.ewaAccounts);
  if (!account) {
    logEwaDebug({
      leaseId: lease.id,
      unitId: unit.id,
      unitNumber: unit.unitNumber,
      periodFrom,
      periodTo,
    });
    return { status: "none", message: "No EWA Account linked to this Unit." };
  }

  // Bills belonging to the shared account; fall back to unit/lease-linked
  // bills that predate account linking.
  const matched = input.ewaBills.filter(
    (b) =>
      monthKeyOf(b.month) === periodKey &&
      (b.ewaAccountId === account.id ||
        (!b.ewaAccountId && (b.unitId === unit.id || b.leaseId === lease.id))),
  );
  if (matched.length === 0) {
    logEwaDebug({
      leaseId: lease.id,
      unitId: unit.id,
      unitNumber: unit.unitNumber,
      accountId: account.id,
      accountNumber: account.accountNumber,
      periodFrom,
      periodTo,
    });
    return { status: "none", message: "No EWA Bill found for this Unit and billing period." };
  }

  const used = new Set(usedBillIds);
  const duplicates: EWABill[] = [];
  const invoiced: EWABill[] = [];
  const landlordBills: EWABill[] = [];
  const notChargeable: EWABill[] = [];
  const available: EwaCandidate[] = [];
  const candidateNotes: string[] = [];

  for (const bill of matched) {
    if (used.has(bill.id)) {
      duplicates.push(bill);
      candidateNotes.push(`CANDIDATE: ${bill.billNumber} — already on this invoice`);
      continue;
    }
    if (bill.invoiceId || bill.status === "Invoiced") {
      invoiced.push(bill);
      candidateNotes.push(`CANDIDATE: ${bill.billNumber} — already invoiced`);
      continue;
    }
    const cls = classifyEwaBill(bill, unit.id, account, input);
    if (!cls.belongs) continue; // another unit's per-unit bill
    if (!cls.chargeable) {
      if (cls.landlord) landlordBills.push(bill);
      else notChargeable.push(bill);
      candidateNotes.push(
        `CANDIDATE: ${bill.billNumber} — ${cls.landlord ? "charged to landlord" : "no allocation for this unit"}`,
      );
      continue;
    }
    available.push({ bill, account, share: cls.share, perUnit: cls.perUnit });
    candidateNotes.push(
      `CANDIDATE: ${bill.billNumber} — allocation ${cls.share.toFixed(3)} BHD`,
    );
  }

  const first = matched[0];
  const debugBase = {
    leaseId: lease.id,
    unitId: unit.id,
    unitNumber: unit.unitNumber,
    accountId: account.id,
    accountNumber: account.accountNumber,
    billId: first.id,
    billMonth: first.month,
    billTotal: first.billAmount,
    allocationUnitId: unit.id,
    periodFrom,
    periodTo,
  };

  if (available.length === 0) {
    if (duplicates.length > 0) {
      logEwaDebug({ ...debugBase, finalAmount: undefined }, candidateNotes);
      return { status: "none", message: "EWA already added to this invoice." };
    }
    if (invoiced.length > 0) {
      logEwaDebug({ ...debugBase, finalAmount: undefined }, candidateNotes);
      return { status: "none", message: "EWA Bill already invoiced." };
    }
    if (landlordBills.length > 0) {
      logEwaDebug({ ...debugBase, finalAmount: undefined }, candidateNotes);
      return {
        status: "none",
        message: "This unit's EWA share for this period is charged to the landlord.",
      };
    }
    if (notChargeable.length > 0) {
      logEwaDebug({ ...debugBase, finalAmount: undefined }, candidateNotes);
      return { status: "none", message: "No EWA allocation found for this Unit." };
    }
    // Everything matched was another unit's per-unit bill (or otherwise not
    // for this unit) — from this unit's perspective there is simply no bill.
    logEwaDebug({ ...debugBase, finalAmount: undefined }, candidateNotes);
    return { status: "none", message: "No EWA Bill found for this Unit and billing period." };
  }

  // Per-unit distribution bills are the most precise source — offer them first.
  available.sort((a, b) => {
    if (a.perUnit !== b.perUnit) return a.perUnit ? -1 : 1;
    return a.bill.billNumber.localeCompare(b.bill.billNumber);
  });

  if (available.length === 1) {
    logEwaDebug(
      { ...debugBase, allocationAmount: available[0].share, finalAmount: available[0].share },
      candidateNotes,
    );
    return { status: "ok", candidate: available[0] };
  }
  logEwaDebug({ ...debugBase, finalAmount: undefined }, candidateNotes);
  return { status: "choice", candidates: available };
}

/** Auto-generated description for an EWA line, e.g. "EWA - October 2026". */
export function ewaLineDescription(bill: EWABill): string {
  return `EWA - ${formatPeriodLabel(monthKeyOf(bill.month))}`;
}
