// src/lib/permissions.ts
// Role-based access for the 4 roles: Owner, Admin, Accountant, Staff.
// View rules gate navigation and pages; edit rules gate create/edit/delete
// affordances (PageHeader action + the DataContext mutation guard).

import type { Role } from "./authClient";

export type { Role };

export const ROLES: Role[] = ["Owner", "Admin", "Accountant", "Staff"];

const ALL: Role[] = ["Owner", "Admin", "Accountant", "Staff"];
const MANAGEMENT: Role[] = ["Owner", "Admin"];
const FINANCE: Role[] = ["Owner", "Admin", "Accountant"];
const OWNER_ONLY: Role[] = ["Owner"];

interface PageRule {
  view: Role[];
  edit: Role[];
}

/**
 * Page ids mirror the first URL segment (list + detail routes share rules).
 * Anything not listed falls back to `FALLBACK_RULE`.
 */
const PAGE_RULES: Record<string, PageRule> = {
  dashboard: { view: ALL, edit: ALL },
  owners: { view: ALL, edit: MANAGEMENT },
  buildings: { view: ALL, edit: MANAGEMENT },
  units: { view: ALL, edit: MANAGEMENT },
  tenants: { view: ALL, edit: MANAGEMENT },
  leases: { view: ALL, edit: MANAGEMENT },
  vendors: { view: ALL, edit: MANAGEMENT },
  assets: { view: ALL, edit: MANAGEMENT },
  documents: { view: ALL, edit: MANAGEMENT },
  complaints: { view: ALL, edit: ["Owner", "Admin", "Staff"] },
  maintenance: { view: ALL, edit: ["Owner", "Admin", "Staff"] },
  invoices: { view: ALL, edit: FINANCE },
  payments: { view: ALL, edit: ALL },
  expenses: { view: ALL, edit: FINANCE },
  "ewa-bills": { view: ALL, edit: FINANCE },
  "ewa-accounts": { view: ALL, edit: FINANCE },
  "chart-of-accounts": { view: ALL, edit: FINANCE },
  "journal-entries": { view: ALL, edit: FINANCE },
  distributions: { view: ALL, edit: FINANCE },
  reports: { view: ["Owner", "Admin", "Accountant"], edit: ["Owner", "Admin", "Accountant"] },
  users: { view: OWNER_ONLY, edit: OWNER_ONLY },
  whatsapp: { view: OWNER_ONLY, edit: OWNER_ONLY },
  "lease-template-calibration": { view: OWNER_ONLY, edit: OWNER_ONLY },
  history: { view: OWNER_ONLY, edit: OWNER_ONLY },
};

const FALLBACK_RULE: PageRule = { view: ALL, edit: MANAGEMENT };

/** "invoices/INV-2026-014" → "invoices"; "/reports/rent-roll" → "reports". */
export function pageIdFromPath(pathname: string): string {
  const first = pathname.replace(/^\/+/, "").split("/")[0] ?? "dashboard";
  return first === "" ? "dashboard" : first;
}

export function canViewPageId(role: Role | undefined | null, pageId: string): boolean {
  if (!role) return false;
  const rule = PAGE_RULES[pageId] ?? FALLBACK_RULE;
  return rule.view.includes(role);
}

export function canEditPageId(role: Role | undefined | null, pageId: string): boolean {
  if (!role) return false;
  const rule = PAGE_RULES[pageId] ?? FALLBACK_RULE;
  return rule.edit.includes(role);
}

export function canViewPath(role: Role | undefined | null, pathname: string): boolean {
  return canViewPageId(role, pageIdFromPath(pathname));
}

export function canEditPath(role: Role | undefined | null, pathname: string): boolean {
  return canEditPageId(role, pageIdFromPath(pathname));
}

/** Collection keys in the data store → page id (for the mutation guard). */
export function pageIdFromCollection(collection: string): string {
  const map: Record<string, string> = {
    ewaBills: "ewa-bills",
    ewaAccounts: "ewa-accounts",
    ewaDistributions: "ewa-bills",
    chartOfAccounts: "chart-of-accounts",
    journalEntries: "journal-entries",
    maintenanceRequests: "maintenance",
    leaseAgreements: "leases",
    whatsappLogs: "whatsapp",
    whatsappSettings: "whatsapp",
    leaseTemplateFields: "lease-template-calibration",
  };
  return map[collection] ?? collection;
}
