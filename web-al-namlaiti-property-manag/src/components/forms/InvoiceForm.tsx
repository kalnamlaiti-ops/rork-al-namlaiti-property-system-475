import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useData, generateCode } from "@/context/DataContext";
import { formatPeriodLabel, toPeriodKey } from "@/lib/invoiceGenerator";
import type { EWABill, Invoice, InvoiceLineItem } from "@/types";

interface InvoiceFormProps {
  initialData?: Invoice;
  onClose: () => void;
}

const lineItemTypes: InvoiceLineItem["type"][] = ["Rent", "Service Charge", "EWA", "Other"];

/** Result of resolving the EWA charge for a unit + billing period. */
interface EwaLookupResult {
  bill?: EWABill;
  message?: string;
}

export default function InvoiceForm({ initialData, onClose }: InvoiceFormProps) {
  const {
    addInvoice,
    updateInvoice,
    leases,
    invoices,
    ewaBills,
    ewaAccounts,
    getTenantById,
    getUnitById,
    markEwaBillsInvoiced,
  } = useData();
  const isEdit = Boolean(initialData);

  const [form, setForm] = useState({
    leaseId: initialData?.leaseId ?? "",
    invoiceDate: new Date().toISOString().split("T")[0],
    dueDate: initialData?.dueDate ?? new Date().toISOString().split("T")[0],
    periodFrom: initialData?.periodFrom ?? new Date().toISOString().split("T")[0],
    periodTo: initialData?.periodTo ?? new Date().toISOString().split("T")[0],
    notes: initialData?.notes ?? "",
    lineItems: initialData?.lineItems ?? [{ id: "li-new", description: "Rent", amount: 0, type: "Rent" as InvoiceLineItem["type"] }],
  });

  const [errors, setErrors] = useState<Record<string, string>>({});
  /** EWA line id → the EWA bill it was filled from (for DB linking & duplicate prevention). */
  const [ewaLineBills, setEwaLineBills] = useState<Record<string, string>>({});
  /** EWA line id → lookup message when no valid EWA bill could be resolved. */
  const [ewaLineMessages, setEwaLineMessages] = useState<Record<string, string>>({});

  // Lines that existed when the form opened keep working without re-lookup.
  const preexistingLineIds = new Set((initialData?.lineItems ?? []).map((li) => li.id));

  const selectedLease = leases.find((l) => l.id === form.leaseId);
  const tenant = selectedLease ? getTenantById(selectedLease.tenantId) : undefined;
  const unit = selectedLease ? getUnitById(selectedLease.unitId) : undefined;

  const subtotal = form.lineItems.reduce((sum, li) => sum + (Number(li.amount) || 0), 0);
  const total = subtotal;

  /**
   * Resolve the EWA charge for a lease in a billing period:
   * Lease → Unit → Linked EWA account → EWA bill for that period.
   * The bill's amount IS the unit's allocated share (computed by the
   * distribution) — it is never re-divided here.
   */
  const resolveEwaBill = (leaseId: string, periodKey: string, excludeLineId: string): EwaLookupResult => {
    const lease = leases.find((l) => l.id === leaseId);
    if (!lease) return { message: "Select a lease first." };
    const leaseUnit = getUnitById(lease.unitId);
    if (!leaseUnit) return { message: "No unit found for this lease." };

    const account = ewaAccounts.find((a) => a.status === "Active" && a.linkedUnitIds.includes(leaseUnit.id));
    if (!account) return { message: "No EWA account is linked to this unit." };

    // Bills already claimed by other EWA lines on this invoice can't be reused.
    const usedOnOtherLines = Object.entries(ewaLineBills)
      .filter(([lineId]) => lineId !== excludeLineId)
      .map(([, billId]) => billId);

    const candidates = ewaBills.filter(
      (b) =>
        (b.leaseId === lease.id || (!b.leaseId && b.unitId === leaseUnit.id)) &&
        toPeriodKey(b.month) === periodKey,
    );
    if (candidates.length === 0) {
      return { message: `No EWA bill found for this unit and billing period (${formatPeriodLabel(periodKey)}).` };
    }

    const available = candidates.find(
      (b) => !b.invoiceId && b.status !== "Invoiced" && !usedOnOtherLines.includes(b.id),
    );
    if (!available) {
      if (candidates.some((b) => usedOnOtherLines.includes(b.id))) {
        return { message: "This EWA bill is already added to this invoice." };
      }
      const invoicedBill = candidates.find((b) => b.invoiceId || b.status === "Invoiced") ?? candidates[0];
      const existingInvoice = invoicedBill.invoiceId
        ? invoices.find((i) => i.id === invoicedBill.invoiceId)
        : undefined;
      return {
        message: `EWA bill already invoiced${existingInvoice ? ` on ${existingInvoice.invoiceNumber}` : ""}.`,
      };
    }
    return { bill: available };
  };

  /** Run the EWA lookup for one line item and fill (or clear) it accordingly. */
  const applyEwaLookup = (lineId: string, ctx?: { leaseId?: string; periodKey?: string }) => {
    const leaseId = ctx?.leaseId ?? selectedLease?.id ?? "";
    const periodKey = ctx?.periodKey ?? toPeriodKey(form.periodFrom);
    const result = resolveEwaBill(leaseId, periodKey, lineId);

    setEwaLineMessages((prev) => ({ ...prev, [lineId]: result.message ?? "" }));
    setEwaLineBills((prev) => {
      const next = { ...prev };
      if (result.bill) next[lineId] = result.bill.id;
      else delete next[lineId];
      return next;
    });

    if (result.bill) {
      // Auto-populate description + the unit's allocated amount — never typed by hand.
      const bill = result.bill;
      setForm((prev) => ({
        ...prev,
        lineItems: prev.lineItems.map((li) =>
          li.id === lineId
            ? {
                ...li,
                description: `EWA — ${formatPeriodLabel(toPeriodKey(bill.month))}`,
                amount: Number((bill.billAmount || 0).toFixed(3)),
              }
            : li,
        ),
      }));
    } else {
      // No valid bill — leave the amount empty; validation blocks saving the line.
      setForm((prev) => ({
        ...prev,
        lineItems: prev.lineItems.map((li) => (li.id === lineId ? { ...li, amount: 0 } : li)),
      }));
    }
  };

  const clearEwaLink = (lineId: string) => {
    setEwaLineBills((prev) => {
      const next = { ...prev };
      delete next[lineId];
      return next;
    });
    setEwaLineMessages((prev) => {
      const next = { ...prev };
      delete next[lineId];
      return next;
    });
  };

  const update = (field: keyof typeof form, value: string | number | InvoiceLineItem[]) => {
    setForm((prev) => ({ ...prev, [field]: value }));
    if (errors[field]) {
      setErrors((prev) => ({ ...prev, [field]: "" }));
    }
    // Keep existing EWA lines valid when the billing period or lease changes —
    // this only re-resolves lines the user explicitly added as EWA.
    if (field === "periodFrom") {
      const periodKey = toPeriodKey(String(value));
      form.lineItems
        .filter((li) => li.type === "EWA")
        .forEach((li) => applyEwaLookup(li.id, { periodKey }));
    }
    if (field === "leaseId") {
      form.lineItems
        .filter((li) => li.type === "EWA")
        .forEach((li) => applyEwaLookup(li.id, { leaseId: String(value) }));
    }
  };

  const updateLineItem = (index: number, field: keyof InvoiceLineItem, value: string | number) => {
    const lineId = form.lineItems[index]?.id;
    setForm((prev) => ({
      ...prev,
      lineItems: prev.lineItems.map((li, i) => (i === index ? { ...li, [field]: value } : li)),
    }));
    // Selecting EWA on a line triggers the automatic EWA lookup.
    if (field === "type" && lineId) {
      if (value === "EWA") {
        applyEwaLookup(lineId);
      } else {
        clearEwaLink(lineId);
      }
    }
  };

  const addLineItem = () => {
    setForm((prev) => ({
      ...prev,
      lineItems: [...prev.lineItems, { id: `li-${Date.now()}`, description: "", amount: 0, type: "Other" }],
    }));
  };

  const removeLineItem = (index: number) => {
    const lineId = form.lineItems[index]?.id;
    setForm((prev) => ({
      ...prev,
      lineItems: prev.lineItems.filter((_, i) => i !== index),
    }));
    if (lineId) clearEwaLink(lineId);
  };

  const validate = () => {
    const next: Record<string, string> = {};
    if (!form.leaseId) next.leaseId = "Lease is required";
    if (!form.dueDate) next.dueDate = "Due date is required";
    if (form.lineItems.length === 0) next.lineItems = "Add at least one line item";
    // Every EWA line must resolve to a real, un-invoiced EWA bill —
    // invalid EWA items (no bill / already invoiced) can't be saved.
    const invalidEwaLine = form.lineItems.find(
      (li) => li.type === "EWA" && !preexistingLineIds.has(li.id) && !ewaLineBills[li.id],
    );
    if (invalidEwaLine) {
      next.lineItems = ewaLineMessages[invalidEwaLine.id] ?? "EWA line item has no valid EWA bill.";
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!validate()) return;

    if (!selectedLease || !tenant || !unit) return;

    const invoiceNumber = initialData?.invoiceNumber ?? generateCode("INV", invoices.length);
    const status = initialData?.status ?? "Draft";

    const sumByType = (type: InvoiceLineItem["type"]) =>
      form.lineItems.filter((li) => li.type === type).reduce((sum, li) => sum + (Number(li.amount) || 0), 0);
    const rentAmount = sumByType("Rent");
    const ewaAmount = sumByType("EWA");
    const maintenanceAmount = sumByType("Service Charge");

    // Every EWA line stays linked to its EWA bill so the same charge can
    // never be billed twice (already-invoiced bills are never linked here).
    const lineEwaBillIds = form.lineItems
      .filter((li) => li.type === "EWA" && ewaLineBills[li.id])
      .map((li) => ewaLineBills[li.id]);
    const ewaBillIds = [...new Set([...(initialData?.ewaBillIds ?? []), ...lineEwaBillIds])];

    const payload = {
      invoiceNumber,
      tenantId: tenant.id,
      leaseId: selectedLease.id,
      unitId: unit.id,
      issueDate: form.invoiceDate,
      dueDate: form.dueDate,
      periodFrom: form.periodFrom,
      periodTo: form.periodTo,
      amount: total,
      balance: total,
      status,
      lineItems: form.lineItems.map((li) => ({ ...li, amount: Number(li.amount) })),
      notes: form.notes,
      ewaBillIds,
      ...(rentAmount > 0 ? { rentAmount } : {}),
      ...(ewaAmount > 0 ? { ewaAmount } : {}),
      ...(maintenanceAmount > 0 ? { maintenanceAmount } : {}),
    };

    if (initialData) {
      updateInvoice(initialData.id, payload);
    } else {
      const created = addInvoice(payload);
      // Cascade (same as the automation path): mark the used EWA bills as
      // Invoiced so they can never be billed twice.
      markEwaBillsInvoiced(ewaBillIds, created.id, created.invoiceNumber);
    }
    onClose();
  };

  const ewaAccountForLine = (lineId: string): string | undefined => {
    const bill = ewaBills.find((b) => b.id === ewaLineBills[lineId]);
    if (!bill) return undefined;
    return ewaAccounts.find((a) => a.id === bill.ewaAccountId)?.accountNumber;
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div className="rounded-lg border bg-card p-6">
        <h3 className="mb-4 text-base font-semibold">Invoice Info</h3>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="leaseId">Lease *</Label>
            <select
              id="leaseId"
              value={form.leaseId}
              onChange={(e) => update("leaseId", e.target.value)}
              className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value="">Select lease</option>
              {leases.map((l) => {
                const t = getTenantById(l.tenantId);
                const u = getUnitById(l.unitId);
                return (
                  <option key={l.id} value={l.id}>
                    {l.contractNumber} — {t?.name} / {u?.unitNumber}
                  </option>
                );
              })}
            </select>
            {errors.leaseId && <p className="text-xs text-red-500">{errors.leaseId}</p>}
          </div>
          <div className="space-y-2">
            <Label htmlFor="invoiceDate">Invoice Date *</Label>
            <Input id="invoiceDate" type="date" value={form.invoiceDate} onChange={(e) => update("invoiceDate", e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="dueDate">Due Date *</Label>
            <Input id="dueDate" type="date" value={form.dueDate} onChange={(e) => update("dueDate", e.target.value)} />
            {errors.dueDate && <p className="text-xs text-red-500">{errors.dueDate}</p>}
          </div>
          <div className="space-y-2">
            <Label htmlFor="periodFrom">Period From</Label>
            <Input id="periodFrom" type="date" value={form.periodFrom} onChange={(e) => update("periodFrom", e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="periodTo">Period To</Label>
            <Input id="periodTo" type="date" value={form.periodTo} onChange={(e) => update("periodTo", e.target.value)} />
          </div>
          <div className="space-y-2 md:col-span-2">
            <Label htmlFor="notes">Notes</Label>
            <Textarea id="notes" value={form.notes} onChange={(e) => update("notes", e.target.value)} />
          </div>
        </div>
      </div>

      <div className="rounded-lg border bg-card p-6">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-base font-semibold">Line Items</h3>
          <Button type="button" variant="ghost" onClick={addLineItem}>
            + Add Item
          </Button>
        </div>
        <div className="space-y-3">
          {form.lineItems.map((li, idx) => {
            const isEwa = li.type === "EWA";
            const ewaMessage = isEwa ? ewaLineMessages[li.id] : undefined;
            const hasLinkedBill = Boolean(ewaLineBills[li.id]);
            const accountNumber = isEwa ? ewaAccountForLine(li.id) : undefined;
            return (
              <div key={li.id}>
                <div className="grid gap-2 md:grid-cols-12 items-end">
                  <div className="md:col-span-5">
                    <Input
                      placeholder="Description"
                      value={li.description}
                      onChange={(e) => updateLineItem(idx, "description", e.target.value)}
                    />
                  </div>
                  <div className="md:col-span-2">
                    <Input
                      type="number"
                      placeholder="Amount"
                      value={isEwa ? (li.amount || "") : li.amount}
                      disabled={isEwa}
                      readOnly={isEwa}
                      onChange={(e) => updateLineItem(idx, "amount", e.target.value)}
                    />
                  </div>
                  <div className="md:col-span-3">
                    <select
                      value={li.type}
                      onChange={(e) => updateLineItem(idx, "type", e.target.value)}
                      className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                    >
                      {lineItemTypes.map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="md:col-span-2 flex justify-end">
                    <Button type="button" variant="ghost" size="sm" onClick={() => removeLineItem(idx)} disabled={form.lineItems.length <= 1}>
                      Remove
                    </Button>
                  </div>
                </div>
                {isEwa && hasLinkedBill && (
                  <p className="mt-1 text-xs text-emerald-700">
                    Auto-filled from EWA bill{accountNumber ? ` · Account ${accountNumber}` : ""} — allocated share, not editable.
                  </p>
                )}
                {isEwa && ewaMessage && (
                  <p className="mt-1 text-xs text-red-500">{ewaMessage}</p>
                )}
              </div>
            );
          })}
        </div>
        {errors.lineItems && <p className="text-xs text-red-500">{errors.lineItems}</p>}
        <div className="mt-4 space-y-1 text-right text-sm">
          <p>Subtotal: BHD {subtotal.toFixed(3)}</p>
          <p className="font-semibold">Total: BHD {total.toFixed(3)}</p>
        </div>
      </div>

      <div className="flex justify-end gap-3">
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit">{isEdit ? "Save Changes" : "Create Invoice"}</Button>
      </div>
    </form>
  );
}
