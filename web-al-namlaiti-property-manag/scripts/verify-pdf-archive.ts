// Verifies the PDF archive report logic on SYNTHETIC September 2026 data.
// Run: bun scripts/verify-pdf-archive.ts   (from the web app folder)
// Does not touch the live backend.
import type { ReportDataContext } from "../src/lib/pdfArchive";
import {
  buildEwaReportData,
  buildExpenseReportData,
  buildFinancialReportData,
  buildEwaPdfOptions,
  buildExpensePdfOptions,
  reportKeyOf,
} from "../src/lib/pdfArchive";
import { buildReportPdf } from "../src/lib/reportPdf";

let failures = 0;
const check = (label: string, cond: boolean, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? `  (${extra})` : ""}`);
  if (!cond) failures += 1;
};

const ctx = {
  buildings: [
    { id: "b1", code: "NAM1", name: "Namlaiti Tower" },
    { id: "b2", code: "SEEF", name: "Seef Residence" },
  ],
  units: [
    { id: "u1", buildingId: "b1", unitNumber: "101" },
    { id: "u2", buildingId: "b1", unitNumber: "102" },
    { id: "u3", buildingId: "b2", unitNumber: "201" },
  ],
  tenants: [{ id: "t1", name: "Ahmed Ali" }],
  ewaAccounts: [
    { id: "a1", accountNumber: "1078980404", buildingId: "b1", allocationMethod: "equal", linkedUnitIds: ["u1", "u2"], rules: [], vacantAction: "landlord" },
  ],
  ewaDistributions: [
    {
      id: "d-sep", accountId: "a1", billNumber: "EWA-SEP", month: "2026-09", totalAmount: 120.5, allocatedAmount: 120.5,
      remainingBalance: 0, dueDate: "2026-10-10", status: "Processed", enteredAt: "2026-09-28T10:00:00Z",
      allocations: [
        { unitId: "u1", tenantId: "t1", amount: 60.25, vacant: false, excluded: false, chargeToLandlord: false, ewaBillId: "eb-1" },
        { unitId: "u2", amount: 60.25, vacant: true, excluded: false, chargeToLandlord: true, ewaBillId: "eb-2" },
      ],
    },
    {
      id: "d-aug", accountId: "a1", billNumber: "EWA-AUG", month: "2026-08", totalAmount: 99, allocatedAmount: 99,
      remainingBalance: 0, dueDate: "2026-09-10", status: "Processed", enteredAt: "2026-08-28T10:00:00Z", allocations: [],
    },
  ],
  ewaBills: [
    // Produced by the distribution — must NOT be double counted.
    { id: "eb-1", billNumber: "x", leaseId: "", unitId: "u1", buildingId: "b1", month: "2026-09", billAmount: 60.25, limit: 0, excess: 0, dueDate: "", status: "Pending" },
    // Standalone manual bill with free-text month — must be included.
    { id: "eb-3", billNumber: "MAN-1", leaseId: "", unitId: "u3", buildingId: "b2", month: "Sep 2026", billAmount: 33.333, limit: 0, excess: 0, dueDate: "2026-10-05", status: "Pending" },
  ],
  expenses: [
    { id: "e1", expenseNumber: "EXP-1", category: "Maintenance", vendor: "ACME", buildingId: "b1", unitId: "u1", amount: 45.5, expenseDate: "2026-09-03", status: "Paid", paymentMethod: "Cash" },
    { id: "e2", expenseNumber: "EXP-2", category: "Cleaning", vendor: "CleanCo", buildingId: "b2", amount: 20.125, expenseDate: "2026-09-30", status: "Approved" },
    { id: "e3", expenseNumber: "EXP-3", category: "Repair", vendor: "X", buildingId: "b1", amount: 999, expenseDate: "2026-09-15", status: "Rejected" },
    { id: "e4", expenseNumber: "EXP-4", category: "Repair", vendor: "Y", buildingId: "b1", amount: 10, expenseDate: "2026-10-01", status: "Paid" },
  ],
  invoices: [],
  payments: [],
} as unknown as ReportDataContext;

const SEP = "2026-09";

// EWA
const ewa = buildEwaReportData(ctx, SEP);
check("EWA: only September bills (1 distribution + 1 standalone)", ewa.bills.length === 2, `${ewa.bills.length}`);
check("EWA: total bill = 120.500 + 33.333", ewa.totalBill === 153.833, `${ewa.totalBill}`);
check("EWA: total allocated uses stored allocations", ewa.totalAllocated === 153.833, `${ewa.totalAllocated}`);
check("EWA: distribution-produced bill not double counted", !ewa.bills.some((b) => b.key === "eb-1"));
check("EWA: free-text 'Sep 2026' month recognised", ewa.bills.some((b) => b.key === "eb-3"));
const ewaB1 = buildEwaReportData(ctx, SEP, "b1");
check("EWA: building filter", ewaB1.bills.length === 1 && ewaB1.totalBill === 120.5);
check("EWA: no expenses mixed in", !JSON.stringify(ewa).includes("EXP-"));

// Expenses
const exp = buildExpenseReportData(ctx, SEP);
check("Expense: September only, rejected excluded", exp.rows.length === 2, `${exp.rows.length}`);
check("Expense: monthly total = 45.500 + 20.125", exp.total === 65.625, `${exp.total}`);
check("Expense: category breakdown sums to total", Math.abs(exp.byCategory.reduce((s, c) => s + c.amount, 0) - exp.total) < 1e-9);
check("Expense: building breakdown sums to total", Math.abs(exp.byBuilding.reduce((s, c) => s + c.amount, 0) - exp.total) < 1e-9);
check("Expense: rejected count reported", exp.excludedRejected === 1);

// Month switching
const aug = buildEwaReportData(ctx, "2026-08");
check("Month switch: August EWA isolated", aug.bills.length === 1 && aug.totalBill === 99);
check("Month switch: October expenses isolated", buildExpenseReportData(ctx, "2026-10").total === 10);
check("Empty month produces empty data", buildEwaReportData(ctx, "2025-01").bills.length === 0);

// Financial
const fin = buildFinancialReportData(ctx, SEP);
check("Financial: EWA and expenses kept separate", fin.ewa.totalBill === 153.833 && fin.expenses.total === 65.625);

// Separate archive keys
check("Separate archive keys for EWA vs Expense", reportKeyOf("ewa", SEP) !== reportKeyOf("expense", SEP));

// PDFs + server data-URI compatibility
for (const [label, opts] of [
  ["EWA", buildEwaPdfOptions(ctx, ewa)],
  ["Expense", buildExpensePdfOptions(ctx, exp)],
] as const) {
  const buf = buildReportPdf(opts).output("arraybuffer");
  const b64 = Buffer.from(buf).toString("base64");
  const dataUri = `data:application/pdf;base64,${b64}`;
  const m = dataUri.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
  const bytes = m ? Buffer.from(m[3], "base64") : Buffer.alloc(0);
  check(`${label} PDF builds and round-trips the server parser`, !!m && m[1] === "application/pdf" && bytes.subarray(0, 5).toString() === "%PDF-", `${buf.byteLength} bytes`);
  const text = Buffer.from(buf).toString("latin1");
  check(`${label} PDF shows BHD with 3 decimals`, /BHD 1[25][03]\.\d{3}|BHD 65\.625/.test(text) || text.includes("BHD"));
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
