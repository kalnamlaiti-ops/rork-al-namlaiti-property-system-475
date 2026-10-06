// REAL UI TEST — the exact flow the user performs:
//
//   Invoices → New Invoice → select lease (Unit 13) → Period = September 2026
//   → + Add Item → Category = EWA
//
// The REAL InvoiceForm component renders; only the DataContext is stubbed
// (with the real record shapes: account 1042833804, Units 12+13, bill
// 112.49 for September 2026). Native select/fireEvent semantics, real state
// flow, real lookup engine. No amounts are typed anywhere.
import { render } from "vitest-browser-react";
import { userEvent } from "@vitest/browser/context";
import { expect, test, vi } from "vitest";

import InvoiceForm from "@/components/forms/InvoiceForm";

const dataset = vi.hoisted(() => {
  const unit12 = { id: "u12", unitNumber: "12", buildingId: "b1", status: "Vacant" };
  const unit13 = { id: "u13", unitNumber: "13", buildingId: "b1", status: "Occupied" };
  const tenant = { id: "t1", name: "NAINESH NANDKUMAR GULEKA" };
  const lease13 = {
    id: "lease-u13",
    contractNumber: "L-13",
    unitId: "u13",
    tenantId: "t1",
    status: "Active",
    monthlyRent: 160,
  };
  const account = {
    id: "acc-1042833804",
    accountNumber: "1042833804",
    buildingId: "b1",
    status: "Active",
    allocationMethod: "equal",
    linkedUnitIds: ["u12", "u13"],
    rules: [],
    vacantAction: "landlord",
    createdAt: "2026-01-01",
  };
  const bill = {
    id: "bill-sep-2026",
    billNumber: "EWA-1042833804-0926",
    leaseId: "",
    unitId: "",
    buildingId: "b1",
    month: "2026-09",
    billAmount: 112.49,
    limit: 0,
    excess: 112.49,
    dueDate: "2026-09-15",
    status: "Pending",
    ewaAccountId: "acc-1042833804",
  };
  const units = [unit12, unit13];
  const tenants = [tenant];
  const leases = [lease13];
  return {
    leases,
    units,
    tenants,
    ewaAccounts: [account],
    ewaBills: [bill],
    ewaDistributions: [],
    invoices: [],
    getTenantById: (id: string) => tenants.find((t) => t.id === id),
    getUnitById: (id: string) => units.find((u) => u.id === id),
    addInvoice: (payload: Record<string, unknown>) => ({
      id: "inv-created",
      invoiceNumber: "INV-2026-000001",
      ...payload,
    }),
    updateInvoice: () => undefined,
    markEwaBillsInvoiced: () => undefined,
    releaseEwaBills: () => undefined,
  };
});

vi.mock("@/context/DataContext", () => ({
  generateCode: (prefix: string, count: number) => `${prefix}-${count + 1}`,
  useData: () => dataset,
}));

const leaseSelect = (container: HTMLElement) =>
  container.querySelector("select#leaseId") as HTMLSelectElement;
const periodFromInput = (container: HTMLElement) =>
  container.querySelector("input#periodFrom") as HTMLInputElement;
const rowTypeSelects = (container: HTMLElement) =>
  Array.from(container.querySelectorAll("select")).filter(
    (s) => s.id !== "leaseId",
  ) as HTMLSelectElement[];
const descriptionInputs = (container: HTMLElement) =>
  Array.from(
    container.querySelectorAll('input[placeholder="Description"]'),
  ) as HTMLInputElement[];
const amountInputs = (container: HTMLElement) =>
  Array.from(
    container.querySelectorAll('input[placeholder="Amount"]'),
  ) as HTMLInputElement[];

type RenderedForm = Awaited<ReturnType<typeof render>>;

const addItemClick = async (screen: RenderedForm) =>
  userEvent.click(screen.getByRole("button", { name: "+ Add Item" }));

test("lease → period September → + Add Item → Category EWA auto-fills 56.245, total 216.245", async () => {
  const screen = await render(<InvoiceForm onClose={() => {}} />);
  const c = screen.container;

  await userEvent.selectOptions(leaseSelect(c), "lease-u13");
  await userEvent.fill(periodFromInput(c), "2026-09-01");
  await userEvent.fill(amountInputs(c)[0], "160");
  await addItemClick(screen);

  const selects = rowTypeSelects(c);
  await userEvent.selectOptions(selects[selects.length - 1], "EWA");

  // Line description + amount filled automatically — nothing typed.
  await vi.waitFor(
    () => {
      expect(descriptionInputs(c)[1].value).toBe("EWA - September 2026");
    },
    { timeout: 3000 },
  );
  const ewaAmount = amountInputs(c)[1];
  expect(ewaAmount.disabled).toBe(true);
  await vi.waitFor(
    () => {
      expect(ewaAmount.value).toBe("56.245");
    },
    { timeout: 3000 },
  );

  // Source indicator proves which records were used.
  await expect.element(
    screen.getByText(/EWA Account: 1042833804 .*Unit: 13 .*Allocation: 56\.245 BHD/),
  ).toBeInTheDocument();

  // Total: 160.000 rent + 56.245 EWA = 216.245
  await expect.element(screen.getByText(/^Total: BHD 216\.245$/)).toBeInTheDocument();
});

test("EWA selected BEFORE the billing period still fills once the period matches", async () => {
  const screen = await render(<InvoiceForm onClose={() => {}} />);
  const c = screen.container;

  await userEvent.selectOptions(leaseSelect(c), "lease-u13");
  // October period first — the bill is September, so the lookup fails…
  await userEvent.fill(periodFromInput(c), "2026-10-06");
  await addItemClick(screen);
  const selects = rowTypeSelects(c);
  await userEvent.selectOptions(selects[selects.length - 1], "EWA");

  // …the exact reason is shown and the row STAYS (no silent empty line).
  await expect.element(
    screen.getByText("No EWA Bill found for this Unit and billing period."),
  ).toBeInTheDocument();

  // Fixing the billing period re-runs the lookup by itself — the EWA row is
  // not touched again, no amount is typed.
  await userEvent.fill(periodFromInput(c), "2026-09-01");

  await vi.waitFor(
    () => {
      expect(descriptionInputs(c)[1].value).toBe("EWA - September 2026");
    },
    { timeout: 3000 },
  );
  await vi.waitFor(
    () => {
      expect(amountInputs(c)[1].value).toBe("56.245");
    },
    { timeout: 3000 },
  );
  await expect.element(
    screen.getByText(/EWA Account: 1042833804 .*Unit: 13 .*Allocation: 56\.245 BHD/),
  ).toBeInTheDocument();
});
