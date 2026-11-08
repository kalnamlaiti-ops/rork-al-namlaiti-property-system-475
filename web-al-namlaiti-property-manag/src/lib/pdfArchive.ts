// src/lib/pdfArchive.ts
// Monthly PDF reports (EWA, Expenses, Monthly Financial) + archive upload.
//
// Rules:
// - Reports cover a BILLING month (YYYY-MM), never the generation date.
// - EWA and expenses are never mixed: each has its own report.
// - Stored EWA allocations are used as-is (never recalculated).
// - Read-only over financial records: nothing here mutates data.
// - Missing data is shown as "Not recorded" / "—", never invented.
// - Every generation is a NEW immutable archive record (new id + version).

import type {
  Building,
  EWAAccount,
  EWABill,
  EWADistribution,
  Expense,
  Invoice,
  Payment,
  PdfReport,
  PdfReportType,
  Tenant,
  Unit,
} from "@/types";
import { buildReportPdf, type ReportPdfOptions } from "./reportPdf";
import { monthKeyOf } from "./ewaInvoiceLookup";
import { backendHttpUrl, newHttpMutationId, resolveFileUrl } from "./syncClient";
import { getToken } from "./authClient";

export const COMPANY_NAME = "AL NAMLAITI PROPERTY";
export const NOT_RECORDED = "Not recorded";

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export const REPORT_TYPE_LABELS: Record<PdfReportType, string> = {
  ewa: "EWA Report",
  expense: "Expense Report",
  "monthly-financial": "Monthly Financial Report",
  other: "Other Report",
};

export const REPORT_CATEGORY_LABELS: Record<PdfReportType, string> = {
  ewa: "EWA Reports",
  expense: "Expense Reports",
  "monthly-financial": "Monthly Financial Reports",
  other: "Other Reports",
};

const TYPE_CODE: Record<PdfReportType, string> = {
  ewa: "EWA",
  expense: "EXP",
  "monthly-financial": "FIN",
  other: "OTH",
};

// ── Formatting ──────────────────────────────────────────────────────────────

const round3 = (n: number) => Math.round((Number(n) || 0) * 1000) / 1000;

/** "BHD 1,234.500" — always 3 decimals. */
export function formatBHD(amount: number | undefined | null): string {
  const n = Number(amount) || 0;
  return `BHD ${n.toLocaleString("en-US", { minimumFractionDigits: 3, maximumFractionDigits: 3 })}`;
}

export function monthLabel(ym: string): string {
  const m = ym.match(/^(\d{4})-(\d{2})$/);
  if (!m) return ym;
  return `${MONTH_NAMES[Number(m[2]) - 1] ?? m[2]} ${m[1]}`;
}

/** "YYYY-MM" from a YYYY-MM-DD / ISO date string — timezone safe. */
function dateMonthKey(value: string | undefined): string {
  if (!value) return "";
  const m = String(value).match(/^(\d{4})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}` : monthKeyOf(value);
}

/** "15 Sep 2026" from YYYY-MM-DD / ISO; "—" when missing. */
export function formatDate(value: string | undefined): string {
  if (!value) return "—";
  const m = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return value;
  return `${m[3]} ${MONTH_NAMES[Number(m[2]) - 1]?.slice(0, 3) ?? m[2]} ${m[1]}`;
}

export function formatFileSize(bytes: number): string {
  if (!bytes) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function billingPeriodOf(ym: string): string {
  const m = ym.match(/^(\d{4})-(\d{2})$/);
  if (!m) return ym;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const short = MONTH_NAMES[mo - 1].slice(0, 3);
  return `01 ${short} ${y} – ${last} ${short} ${y}`;
}

const ALLOCATION_METHOD_LABEL: Record<string, string> = {
  equal: "Equal split",
  percentage: "Percentage",
  fixed: "Fixed amount",
  meter: "Meter reading",
};

// ── Shared context ──────────────────────────────────────────────────────────

export interface ReportDataContext {
  buildings: Building[];
  units: Unit[];
  tenants: Tenant[];
  ewaAccounts: EWAAccount[];
  ewaDistributions: EWADistribution[];
  ewaBills: EWABill[];
  expenses: Expense[];
  invoices: Invoice[];
  payments: Payment[];
}

function lookups(ctx: ReportDataContext) {
  const buildingById = new Map(ctx.buildings.map((b) => [b.id, b]));
  const unitById = new Map(ctx.units.map((u) => [u.id, u]));
  const tenantById = new Map(ctx.tenants.map((t) => [t.id, t]));
  const accountById = new Map(ctx.ewaAccounts.map((a) => [a.id, a]));
  const buildingName = (id: string | undefined) => (id ? buildingById.get(id)?.name ?? NOT_RECORDED : NOT_RECORDED);
  const unitLabel = (id: string | undefined) => (id ? unitById.get(id)?.unitNumber ?? NOT_RECORDED : "—");
  return { buildingById, unitById, tenantById, accountById, buildingName, unitLabel };
}

// ── EWA report data ─────────────────────────────────────────────────────────

export interface EwaReportBill {
  key: string;
  accountNumber: string;
  buildingId?: string;
  buildingName: string;
  billNumber: string;
  billAmount: number;
  allocatedAmount: number;
  billDate: string;
  dueDate: string;
  billingPeriod: string;
  allocationMethod: string;
  allocations: { unit: string; tenant: string; amount: number; note: string }[];
}

export interface EwaReportData {
  month: string;
  bills: EwaReportBill[];
  totalBill: number;
  totalAllocated: number;
  buildingIds: string[];
}

export function buildEwaReportData(ctx: ReportDataContext, month: string, buildingId?: string): EwaReportData {
  const L = lookups(ctx);
  const bills: EwaReportBill[] = [];

  // 1. Shared-account distributions for this billing month (stored allocations).
  const distributions = ctx.ewaDistributions.filter((d) => monthKeyOf(d.month) === month);
  const referencedBillIds = new Set<string>();
  for (const d of ctx.ewaDistributions) {
    for (const a of d.allocations ?? []) if (a.ewaBillId) referencedBillIds.add(a.ewaBillId);
  }

  for (const d of distributions) {
    const account = L.accountById.get(d.accountId);
    const bId = account?.buildingId;
    if (buildingId && bId !== buildingId) continue;
    bills.push({
      key: d.id,
      accountNumber: account?.accountNumber || NOT_RECORDED,
      buildingId: bId,
      buildingName: L.buildingName(bId),
      billNumber: d.billNumber || NOT_RECORDED,
      billAmount: round3(d.totalAmount),
      allocatedAmount: round3(d.allocatedAmount),
      billDate: formatDate(d.enteredAt),
      dueDate: formatDate(d.dueDate),
      billingPeriod: billingPeriodOf(month),
      allocationMethod: account ? ALLOCATION_METHOD_LABEL[account.allocationMethod] ?? account.allocationMethod : NOT_RECORDED,
      allocations: (d.allocations ?? []).map((a) => {
        const notes: string[] = [];
        if (a.vacant) notes.push("Vacant");
        if (a.excluded) notes.push("Excluded");
        if (a.chargeToLandlord) notes.push("Landlord");
        return {
          unit: L.unitLabel(a.unitId),
          tenant: a.tenantId ? L.tenantById.get(a.tenantId)?.name ?? NOT_RECORDED : "—",
          amount: round3(a.amount),
          note: notes.join(", ") || "Tenant",
        };
      }),
    });
  }

  // 2. Standalone per-unit EWA bills not produced by a distribution
  //    (avoids double counting the same money).
  for (const b of ctx.ewaBills) {
    if (referencedBillIds.has(b.id)) continue;
    if (monthKeyOf(b.month) !== month) continue;
    if (buildingId && b.buildingId !== buildingId) continue;
    const account = b.ewaAccountId ? L.accountById.get(b.ewaAccountId) : undefined;
    bills.push({
      key: b.id,
      accountNumber: account?.accountNumber || NOT_RECORDED,
      buildingId: b.buildingId,
      buildingName: L.buildingName(b.buildingId),
      billNumber: b.billNumber || NOT_RECORDED,
      billAmount: round3(b.billAmount),
      allocatedAmount: round3(b.billAmount),
      billDate: NOT_RECORDED,
      dueDate: formatDate(b.dueDate),
      billingPeriod: billingPeriodOf(month),
      allocationMethod: "Single unit (direct bill)",
      allocations: [
        {
          unit: L.unitLabel(b.unitId),
          tenant: "—",
          amount: round3(b.billAmount),
          note: "Direct",
        },
      ],
    });
  }

  bills.sort((a, b) => a.buildingName.localeCompare(b.buildingName) || a.accountNumber.localeCompare(b.accountNumber));
  const totalBill = round3(bills.reduce((s, b) => s + b.billAmount, 0));
  const totalAllocated = round3(bills.reduce((s, b) => s + b.allocatedAmount, 0));
  const buildingIds = [...new Set(bills.map((b) => b.buildingId).filter((x): x is string => !!x))];
  return { month, bills, totalBill, totalAllocated, buildingIds };
}

// ── Expense report data ─────────────────────────────────────────────────────

export interface ExpenseReportData {
  month: string;
  rows: Expense[];
  total: number;
  byCategory: { category: string; count: number; amount: number }[];
  byBuilding: { buildingId?: string; building: string; count: number; amount: number }[];
  excludedRejected: number;
  buildingIds: string[];
}

export function buildExpenseReportData(ctx: ReportDataContext, month: string, buildingId?: string): ExpenseReportData {
  const L = lookups(ctx);
  const inMonth = ctx.expenses.filter(
    (e) => dateMonthKey(e.expenseDate) === month && (!buildingId || e.buildingId === buildingId),
  );
  const rows = inMonth
    .filter((e) => e.status !== "Rejected")
    .sort((a, b) => (a.expenseDate || "").localeCompare(b.expenseDate || ""));
  const total = round3(rows.reduce((s, e) => s + (Number(e.amount) || 0), 0));

  const catMap = new Map<string, { count: number; amount: number }>();
  const bldMap = new Map<string, { buildingId?: string; count: number; amount: number }>();
  for (const e of rows) {
    const cat = e.category || NOT_RECORDED;
    const c = catMap.get(cat) ?? { count: 0, amount: 0 };
    c.count += 1;
    c.amount += Number(e.amount) || 0;
    catMap.set(cat, c);
    const bKey = e.buildingId ?? "__none";
    const b = bldMap.get(bKey) ?? { buildingId: e.buildingId, count: 0, amount: 0 };
    b.count += 1;
    b.amount += Number(e.amount) || 0;
    bldMap.set(bKey, b);
  }
  return {
    month,
    rows,
    total,
    byCategory: [...catMap.entries()]
      .map(([category, v]) => ({ category, count: v.count, amount: round3(v.amount) }))
      .sort((a, b) => b.amount - a.amount),
    byBuilding: [...bldMap.values()]
      .map((v) => ({ buildingId: v.buildingId, building: L.buildingName(v.buildingId), count: v.count, amount: round3(v.amount) }))
      .sort((a, b) => b.amount - a.amount),
    excludedRejected: inMonth.length - rows.length,
    buildingIds: [...new Set(rows.map((e) => e.buildingId).filter((x): x is string => !!x))],
  };
}

// ── Monthly financial data ──────────────────────────────────────────────────

function invoiceMonth(inv: Invoice): string {
  return dateMonthKey(inv.periodFrom) || dateMonthKey(inv.issueDate) || dateMonthKey(inv.dueDate);
}

export interface FinancialReportData {
  month: string;
  invoices: Invoice[];
  payments: Payment[];
  invoiced: number;
  collected: number;
  outstanding: number;
  expenses: ExpenseReportData;
  ewa: EwaReportData;
  net: number;
  buildingIds: string[];
}

export function buildFinancialReportData(ctx: ReportDataContext, month: string, buildingId?: string): FinancialReportData {
  const L = lookups(ctx);
  const buildingOfUnit = (unitId: string | undefined) => (unitId ? L.unitById.get(unitId)?.buildingId : undefined);
  const invoices = ctx.invoices
    .filter((i) => invoiceMonth(i) === month)
    .filter((i) => !buildingId || buildingOfUnit(i.unitId) === buildingId);
  const invoiceById = new Map(ctx.invoices.map((i) => [i.id, i]));
  const payments = ctx.payments
    .filter((p) => dateMonthKey(p.paymentDate) === month)
    .filter((p) => !buildingId || buildingOfUnit(invoiceById.get(p.invoiceId)?.unitId) === buildingId);
  const invoiced = round3(invoices.reduce((s, i) => s + (Number(i.amount) || 0), 0));
  const collected = round3(payments.reduce((s, p) => s + (Number(p.amount) || 0), 0));
  const outstanding = round3(invoices.reduce((s, i) => s + (Number(i.balance) || 0), 0));
  const expenses = buildExpenseReportData(ctx, month, buildingId);
  const ewa = buildEwaReportData(ctx, month, buildingId);
  const net = round3(collected - expenses.total);
  const buildingIds = [
    ...new Set([
      ...invoices.map((i) => buildingOfUnit(i.unitId)),
      ...expenses.buildingIds,
      ...ewa.buildingIds,
    ].filter((x): x is string => !!x)),
  ];
  return { month, invoices, payments, invoiced, collected, outstanding, expenses, ewa, net, buildingIds };
}

// ── PDF builders ────────────────────────────────────────────────────────────

function scopeLabel(ctx: ReportDataContext, buildingId?: string): string {
  if (!buildingId) return "All buildings";
  return ctx.buildings.find((b) => b.id === buildingId)?.name ?? NOT_RECORDED;
}

export function buildEwaPdfOptions(ctx: ReportDataContext, data: EwaReportData, buildingId?: string): ReportPdfOptions {
  const sections: ReportPdfOptions["sections"] = [
    {
      heading: "Report Summary",
      info: [
        ["Company", "Al Namlaiti Property"],
        ["Report Month", monthLabel(data.month)],
        ["Scope", scopeLabel(ctx, buildingId)],
        ["EWA Bills", String(data.bills.length)],
        ["Total Bill Amount", formatBHD(data.totalBill)],
        ["Total Allocated", formatBHD(data.totalAllocated)],
      ],
    },
  ];
  if (data.bills.length === 0) {
    sections.push({ heading: "EWA Bills", info: [["Status", `No EWA bills recorded for ${monthLabel(data.month)}.`]] });
  }
  data.bills.forEach((b, i) => {
    sections.push({
      heading: `${i + 1}. EWA Account ${b.accountNumber} — ${b.buildingName}`,
      info: [
        ["EWA Account Number", b.accountNumber],
        ["Building", b.buildingName],
        ["Bill Number", b.billNumber],
        ["Bill Amount", formatBHD(b.billAmount)],
        ["Bill Date", b.billDate],
        ["Due Date", b.dueDate],
        ["Billing Period", b.billingPeriod],
        ["Allocation Method", b.allocationMethod],
        ["Linked Units", b.allocations.map((a) => a.unit).join(", ") || "—"],
      ],
      columns: [
        { label: "Unit", width: 1.2 },
        { label: "Tenant", width: 2.2 },
        { label: "Charged To", width: 1.4 },
        { label: "Allocated Amount", width: 1.6, align: "right" },
      ],
      rows: b.allocations.map((a) => [a.unit, a.tenant, a.note, formatBHD(a.amount)]),
      totals: [
        ["Total Bill", formatBHD(b.billAmount)],
        ["Total Allocated", formatBHD(b.allocatedAmount)],
      ],
    });
  });
  sections.push({
    heading: "Month Totals",
    totals: [
      ["Total Bill (all accounts)", formatBHD(data.totalBill)],
      ["Total Allocated (all accounts)", formatBHD(data.totalAllocated)],
    ],
  });
  return {
    title: `EWA Report — ${monthLabel(data.month)}`,
    subtitle: `Billing month ${monthLabel(data.month)} · ${scopeLabel(ctx, buildingId)} · Stored allocations`,
    companyName: COMPANY_NAME,
    sections,
    footerNote: "EWA only — expenses are reported separately.",
  };
}

export function buildExpensePdfOptions(ctx: ReportDataContext, data: ExpenseReportData, buildingId?: string): ReportPdfOptions {
  const L = lookups(ctx);
  return {
    title: `Expense Report — ${monthLabel(data.month)}`,
    subtitle: `Expense month ${monthLabel(data.month)} · ${scopeLabel(ctx, buildingId)}`,
    companyName: COMPANY_NAME,
    orientation: "landscape",
    footerNote: "Expenses only — EWA is reported separately. Rejected expenses are excluded.",
    sections: [
      {
        heading: "Report Summary",
        info: [
          ["Company", "Al Namlaiti Property"],
          ["Report Month", monthLabel(data.month)],
          ["Scope", scopeLabel(ctx, buildingId)],
          ["Expenses", String(data.rows.length)],
          ["Monthly Total", formatBHD(data.total)],
          ...(data.excludedRejected > 0
            ? ([["Excluded", `${data.excludedRejected} rejected expense(s) not counted`]] as [string, string][])
            : []),
        ],
      },
      {
        heading: "Expenses",
        columns: [
          { label: "Date", width: 1.1 },
          { label: "Building", width: 1.6 },
          { label: "Unit", width: 0.8 },
          { label: "Category", width: 1.1 },
          { label: "Description", width: 2.6 },
          { label: "Payment Method", width: 1.2 },
          { label: "Amount", width: 1.2, align: "right" },
        ],
        rows: data.rows.map((e) => [
          formatDate(e.expenseDate),
          e.buildingId ? L.buildingName(e.buildingId) : NOT_RECORDED,
          L.unitLabel(e.unitId),
          e.category || NOT_RECORDED,
          [e.vendor, e.description].filter(Boolean).join(" — ") || NOT_RECORDED,
          e.paymentMethod ?? NOT_RECORDED,
          formatBHD(e.amount),
        ]),
        totals: [["Monthly Total", formatBHD(data.total)]],
      },
      {
        heading: "Breakdown by Category",
        columns: [
          { label: "Category", width: 3 },
          { label: "Count", width: 1, align: "right" },
          { label: "Amount", width: 1.5, align: "right" },
        ],
        rows: data.byCategory.map((c) => [c.category, String(c.count), formatBHD(c.amount)]),
        totals: [["Total", formatBHD(data.total)]],
      },
      {
        heading: "Breakdown by Building",
        columns: [
          { label: "Building", width: 3 },
          { label: "Count", width: 1, align: "right" },
          { label: "Amount", width: 1.5, align: "right" },
        ],
        rows: data.byBuilding.map((b) => [b.building, String(b.count), formatBHD(b.amount)]),
        totals: [["Total", formatBHD(data.total)]],
      },
    ],
  };
}

export function buildFinancialPdfOptions(ctx: ReportDataContext, data: FinancialReportData, buildingId?: string): ReportPdfOptions {
  const L = lookups(ctx);
  const tenantName = (id: string) => L.tenantById.get(id)?.name ?? NOT_RECORDED;
  const invoiceNo = new Map(ctx.invoices.map((i) => [i.id, i.invoiceNumber]));
  return {
    title: `Monthly Financial Report — ${monthLabel(data.month)}`,
    subtitle: `Billing month ${monthLabel(data.month)} · ${scopeLabel(ctx, buildingId)}`,
    companyName: COMPANY_NAME,
    footerNote: "EWA and expenses are listed separately and never combined.",
    sections: [
      {
        heading: "Summary",
        info: [
          ["Company", "Al Namlaiti Property"],
          ["Report Month", monthLabel(data.month)],
          ["Scope", scopeLabel(ctx, buildingId)],
        ],
        totals: [
          ["Invoiced (billing month)", formatBHD(data.invoiced)],
          ["Outstanding on these invoices", formatBHD(data.outstanding)],
          ["Collected (payments in month)", formatBHD(data.collected)],
          ["Expenses (excl. rejected)", formatBHD(data.expenses.total)],
          ["EWA bills (total)", formatBHD(data.ewa.totalBill)],
          ["EWA allocated", formatBHD(data.ewa.totalAllocated)],
          ["Net (collected − expenses)", formatBHD(data.net)],
        ],
      },
      {
        heading: "Invoices",
        columns: [
          { label: "Invoice #", width: 1.3 },
          { label: "Tenant", width: 2 },
          { label: "Unit", width: 0.8 },
          { label: "Status", width: 1 },
          { label: "Amount", width: 1.2, align: "right" },
          { label: "Balance", width: 1.2, align: "right" },
        ],
        rows: data.invoices.map((i) => [
          i.invoiceNumber,
          tenantName(i.tenantId),
          L.unitLabel(i.unitId),
          i.status,
          formatBHD(i.amount),
          formatBHD(i.balance),
        ]),
        totals: [["Total Invoiced", formatBHD(data.invoiced)]],
      },
      {
        heading: "Payments Collected",
        columns: [
          { label: "Receipt #", width: 1.3 },
          { label: "Date", width: 1.1 },
          { label: "Tenant", width: 2 },
          { label: "Invoice #", width: 1.2 },
          { label: "Method", width: 1.1 },
          { label: "Amount", width: 1.2, align: "right" },
        ],
        rows: data.payments.map((p) => [
          p.receiptNumber,
          formatDate(p.paymentDate),
          tenantName(p.tenantId),
          invoiceNo.get(p.invoiceId) ?? NOT_RECORDED,
          p.method ?? NOT_RECORDED,
          formatBHD(p.amount),
        ]),
        totals: [["Total Collected", formatBHD(data.collected)]],
      },
      {
        heading: "Expenses by Category",
        columns: [
          { label: "Category", width: 3 },
          { label: "Count", width: 1, align: "right" },
          { label: "Amount", width: 1.5, align: "right" },
        ],
        rows: data.expenses.byCategory.map((c) => [c.category, String(c.count), formatBHD(c.amount)]),
        totals: [["Total Expenses", formatBHD(data.expenses.total)]],
      },
      {
        heading: "EWA by Account",
        columns: [
          { label: "Account", width: 1.5 },
          { label: "Building", width: 2 },
          { label: "Bill Amount", width: 1.3, align: "right" },
          { label: "Allocated", width: 1.3, align: "right" },
        ],
        rows: data.ewa.bills.map((b) => [b.accountNumber, b.buildingName, formatBHD(b.billAmount), formatBHD(b.allocatedAmount)]),
        totals: [["Total EWA", formatBHD(data.ewa.totalBill)]],
      },
    ],
  };
}

// ── Archive ─────────────────────────────────────────────────────────────────

export function reportKeyOf(type: PdfReportType, month: string, buildingId?: string): string {
  return `${type}:${month}:${buildingId ?? "all"}`;
}

function newReportId(): string {
  const rand =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `pdfr-${Date.now()}-${rand}`;
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export interface GenerateArgs {
  type: Exclude<PdfReportType, "other">;
  month: string;
  buildingId?: string;
  ctx: ReportDataContext;
  existing: PdfReport[];
  generatedBy: string;
}

/** Build the PDF, upload it to the archive as a NEW version, return the record. */
export async function generateAndArchiveReport(args: GenerateArgs): Promise<PdfReport> {
  const { type, month, buildingId, ctx, existing, generatedBy } = args;
  let options: ReportPdfOptions;
  let totals: PdfReport["totals"];
  let buildingIds: string[];

  if (type === "ewa") {
    const data = buildEwaReportData(ctx, month, buildingId);
    options = buildEwaPdfOptions(ctx, data, buildingId);
    totals = { total: data.totalBill, allocated: data.totalAllocated, count: data.bills.length };
    buildingIds = data.buildingIds;
  } else if (type === "expense") {
    const data = buildExpenseReportData(ctx, month, buildingId);
    options = buildExpensePdfOptions(ctx, data, buildingId);
    totals = { total: data.total, count: data.rows.length };
    buildingIds = data.buildingIds;
  } else {
    const data = buildFinancialReportData(ctx, month, buildingId);
    options = buildFinancialPdfOptions(ctx, data, buildingId);
    totals = { total: data.net, count: data.invoices.length + data.payments.length + data.expenses.rows.length };
    buildingIds = data.buildingIds;
  }

  const reportKey = reportKeyOf(type, month, buildingId);
  const versions = existing.filter((r) => r.reportKey === reportKey);
  const latest = versions.reduce<PdfReport | undefined>((acc, r) => (!acc || r.version > acc.version ? r : acc), undefined);
  const version = (latest?.version ?? 0) + 1;

  const building = buildingId ? ctx.buildings.find((b) => b.id === buildingId) : undefined;
  const scopeCode = building ? (building.code || building.name).replace(/[^A-Za-z0-9]+/g, "").toUpperCase().slice(0, 10) || "BLD" : "ALL";
  const reportCode = `${TYPE_CODE[type]}-${month}-${scopeCode}-v${version}`;
  const fileName = `${REPORT_TYPE_LABELS[type].replace(/\s+/g, "-")}_${month}_${scopeCode}_v${version}.pdf`;

  const doc = buildReportPdf(options);
  const buf = doc.output("arraybuffer");
  const dataUri = `data:application/pdf;base64,${arrayBufferToBase64(buf)}`;

  const record: PdfReport = {
    id: newReportId(),
    reportKey,
    reportCode,
    reportType: type,
    name: `${REPORT_TYPE_LABELS[type]} — ${monthLabel(month)}${building ? ` — ${building.name}` : ""}`,
    month,
    year: Number(month.slice(0, 4)),
    ...(buildingId ? { buildingId } : {}),
    buildingIds: buildingId ? [buildingId] : buildingIds,
    version,
    ...(latest ? { previousVersionId: latest.id } : {}),
    generatedAt: new Date().toISOString(),
    generatedBy,
    fileSize: buf.byteLength,
    fileName,
    totals,
  };

  const token = getToken();
  const mutationId = newHttpMutationId();
  let lastError = "";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const res = await fetch(backendHttpUrl("/documents/upload"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ mutationId, collection: "pdfReports", record, dataUri }),
      });
      if (res.ok) return { ...record, fileUrl: `/documents/${record.id}` };
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      lastError = body.error ?? `HTTP ${res.status}`;
      if (res.status < 500) break;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 1200 * 2 ** attempt));
  }
  throw new Error(lastError || "Upload failed");
}

/** Absolute URL to view (inline) or download a stored report. */
export function reportFileUrl(report: PdfReport, download: boolean): string | undefined {
  const base = resolveFileUrl(report.fileUrl ?? `/documents/${report.id}`);
  if (!base) return undefined;
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}name=${encodeURIComponent(report.fileName)}${download ? "&download=1" : ""}`;
}
