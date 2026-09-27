// EWA Accounts search — READ-ONLY filtering helper.
// Traverses the real relationships: EWA Account → linkedUnitIds → Unit record
// → Unit Number, and Unit → Lease → Tenant name. Nothing here mutates data.
import type { Building, EWAAccount, Lease, Tenant, Unit } from "@/types";

/** Digits only, leading zeros stripped ("01" → "1", "0010" → "10", "0" → "0"). */
export function normalizeUnitDigits(value: string): string {
  const digits = (value ?? "").replace(/\D/g, "");
  return digits.replace(/^0+(?=\d)/, "");
}

/**
 * Normalize the search text: trim/lowercase, and drop a leading
 * "unit"/"flat"/"apartment" word so "Unit 01" and "unit01" → "01".
 * Words that merely start with "unit" (e.g. "unity") are left untouched.
 */
export function normalizeSearchTerm(raw: string): string {
  const t = (raw ?? "").trim().toLowerCase();
  const spaced = t.match(/^(?:unit|flat|apartment|apt)\s+(.+)$/);
  if (spaced?.[1]) return spaced[1].trim();
  const glued = t.match(/^(?:unit|flat)(\d+)$/);
  if (glued?.[1]) return glued[1];
  return t;
}

export interface EwaSearchContext {
  units: Unit[];
  leases: Lease[];
  tenants: Tenant[];
  getBuildingById: (id: string) => Building | undefined;
}

/**
 * Filter EWA accounts by the existing single search box. Matches:
 * account number (partial), nickname, building name, building number,
 * ANY linked unit's visible unit number, and ANY linked unit's tenant name.
 *
 * Unit-number matching for numeric queries is exact-after-zero-stripping or
 * prefix-partial — never a loose substring, so searching "01" matches Unit 01
 * but never Unit 10 / 201. Text queries use case-insensitive substring.
 */
export function filterEwaAccounts(accounts: EWAAccount[], search: string, ctx: EwaSearchContext): EWAAccount[] {
  const q = normalizeSearchTerm(search);
  if (!q) return accounts;
  const isNumeric = /^\d+$/.test(q);
  const qDigits = normalizeUnitDigits(q);

  const unitById = new Map<string, Unit>();
  for (const u of ctx.units) unitById.set(u.id, u);

  // Unit → tenant name(s), resolved through leases (Lease.unitId + Lease.tenantId).
  const tenantNamesByUnitId = new Map<string, string>();
  for (const l of ctx.leases) {
    const t = ctx.tenants.find((x) => x.id === l.tenantId);
    if (!t) continue;
    const prev = tenantNamesByUnitId.get(l.unitId);
    tenantNamesByUnitId.set(l.unitId, prev ? `${prev}, ${t.name}` : t.name);
  }

  return accounts.filter((a) => {
    const building = ctx.getBuildingById(a.buildingId);
    // Real, user-facing building number only (e.g. "1440"). The internal building
    // `code` is deliberately NOT searched — codes like "BLD-2026-001" are shared
    // across buildings and would pollute numeric searches ("01", "02", …).
    const buildingNo = building?.buildingNumber ?? "";

    if (a.accountNumber.toLowerCase().includes(q)) return true;
    if ((a.nickname ?? "").toLowerCase().includes(q)) return true;
    if ((building?.name ?? "").toLowerCase().includes(q)) return true;
    if (buildingNo.toLowerCase().includes(q)) return true;

    for (const uid of a.linkedUnitIds) {
      const unit = unitById.get(uid);
      if (unit) {
        const un = (unit.unitNumber ?? "").toLowerCase();
        if (isNumeric) {
          // Exact match ignoring leading zeros, or prefix-partial ("02" → "025").
          // Loose substring is intentionally avoided so "01" ≠ Unit 10/201.
          if (normalizeUnitDigits(un) === qDigits || un.startsWith(q)) return true;
        } else if (un.includes(q)) {
          return true;
        }
      }
      const names = tenantNamesByUnitId.get(uid);
      if (names && names.toLowerCase().includes(q)) return true;
    }
    return false;
  });
}

/** Visible unit numbers for an account's linked units (for row subtext). */
export function linkedUnitLabels(account: EWAAccount, units: Unit[]): string[] {
  const unitById = new Map<string, string>();
  for (const u of units) unitById.set(u.id, u.unitNumber);
  return account.linkedUnitIds
    .map((uid) => unitById.get(uid))
    .filter((v): v is string => Boolean(v));
}

/** Unique tenant names across an account's linked units (for row subtext). */
export function linkedTenantNames(account: EWAAccount, leases: Lease[], tenants: Tenant[]): string[] {
  const nameById = new Map<string, string>();
  for (const t of tenants) nameById.set(t.id, t.name);
  const names = account.linkedUnitIds.flatMap((uid) =>
    leases.filter((l) => l.unitId === uid).map((l) => nameById.get(l.tenantId) ?? ""),
  );
  return [...new Set(names.filter(Boolean))];
}
