import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useData, generateCode } from "@/context/DataContext";
import { formatPeriodLabel } from "@/lib/invoiceGenerator";
import {
  classifyEwaBill,
  ewaLineDescription,
  findUnitEwaAccount,
  monthKeyOf,
  resolveEwaCharge,
  type EwaCandidate,
} from "@/lib/ewaInvoiceLookup";
import type { Invoice, InvoiceLineItem } from "@/types";

interface InvoiceFormProps {
  initialData?: Invoice;
  onClose: () => void;
}

const lineItemTypes: InvoiceLineItem["type"][] = ["Rent", "Service Charge", "EWA", "Other"];

/**
 * Initial line items. Legacy invoices stored EWA linkage only at invoice
 * level (ewaBillIds) — attach those bills to their EWA lines so the
 * automatic recalculation works on them too.
 */
function initLineItems(initialData?: Invoice): InvoiceLineItem[] {
  if (!initialData) {
    return [{ id: "li-new", description: "Rent", amount: 0, type: "Rent" }];
  }
  const billIds = initialData.ewaBillIds ?? [];
  const ewaLines = initialData.lineItems.filter((li) => li.type === "EWA");
  return initialData.lineItems.map((li) => {
    if (li.type !== "EWA" || li.ewaBillId) return { ...li };
    const idx = ewaLines.findIndex((l) => l.id === li.id);
    return { ...li, ...(billIds[idx] ? { ewaBillId: billIds[idx] } : {}) };
  });
}

export default function InvoiceForm({ initialData, onClose }: InvoiceFormProps) {
  const {
    addInvoice,
    updateInvoice,
    leases,
    invoices,
    units,
    tenants,
    ewaBills,
    ewaAccounts,
    ewaDistributions,
    getTenantById,
    getUnitById,
    markEwaBillsInvoiced,
    releaseEwaBills,
  } = useData();
  const isEdit = Boolean(initialData);

  const [form, setForm] = useState({
    leaseId: initialData?.leaseId ?? "",
    invoiceDate: new Date().toISOString().split("T")[0],
    dueDate: initialData?.dueDate ?? new Date().toISOString().split("T")[0],
    periodFrom: initialData?.periodFrom ?? new Date().toISOString().split("T")[0],
    periodTo: initialData?.periodTo ?? new Date().toISOString().split("T")[0],
    notes: initialData?.notes ?? "",
    lineItems: initLineItems(initialData),
  });

  const [errors, setErrors] = useState<Record<string, string>>({});
  /** Per-line messages: lookup problems shown under the line item. */
  const [ewaMessages, setEwaMessages] = useState<Record<string, string>>({});
  /** More than one EWA bill matches — let the user pick instead of guessing. */
  const [pendingPick, setPendingPick] = useState<{ lineId: string; candidates: EwaCandidate[] } | null>(null);
  /** Line state before its type was switched to EWA (for revert on failure). */
  const lineBeforeEwa = useRef<Record<string, InvoiceLineItem>>({});

  // Lines that existed when the form opened keep working without re-lookup.
  const preexistingLineIds = new Set((initialData?.lineItems ?? []).map((li) => li.id));

  const selectedLease = leases.find((l) => l.id === form.leaseId);
  const tenant = selectedLease ? getTenantById(selectedLease.tenantId) : undefined;
  const selectedUnit = selectedLease ? getUnitById(selectedLease.unitId) : undefined;

  const subtotal = form.lineItems.reduce((sum, li) => sum + (Number(li.amount) || 0), 0);
  const total = subtotal;

  /** EWA bills claimed by other EWA lines on this invoice (duplicate guard). */
  const usedBillIdsFor = (excludeLineId: string): string[] =>
    form.lineItems
      .filter((li) => li.type === "EWA" && li.id !== excludeLineId && li.ewaBillId)
      .map((li) => li.ewaBillId as string);

  /** Fill an EWA line from a resolved bill — description, amount and linkage. */
  const fillEwaLine = (lineId: string, candidate: EwaCandidate) => {
    delete lineBeforeEwa.current[lineId];
    setForm((prev) => {
      const lease = leases.find((l) => l.id === prev.leaseId);
      const leaseUnit = lease ? getUnitById(lease.unitId) : undefined;
      return {
        ...prev,
        lineItems: prev.lineItems.map((li) =>
          li.id === lineId
            ? {
                ...li,
                type: "EWA" as const,
                description: ewaLineDescription(candidate.bill),
                amount: candidate.share,
                ewaBillId: candidate.bill.id,
                ewaAccountId: candidate.bill.ewaAccountId ?? candidate.account.id,
                buildingId: leaseUnit?.buildingId ?? li.buildingId,
                billingPeriod: monthKeyOf(candidate.bill.month),
              }
            : li,
        ),
      };
    });
    setEwaMessages((prev) => {
      if (!(lineId in prev)) return prev;
      const next = { ...prev };
      delete next[lineId];
      return next;
    });
    setPendingPick(null);
  };

  /** Revert a fresh/edited row after a failed EWA lookup; keep saved lines visible. */
  const revertEwaLine = (lineId: string): "removed" | "reverted" | "kept" => {
    const savedEwaLine =
      preexistingLineIds.has(lineId) &&
      Boolean(initialData?.lineItems.some((li) => li.id === lineId && li.type === "EWA"));
    if (savedEwaLine) {
      // Never silently destroy a saved EWA charge — keep it and block saving
      // until the user resolves the problem.
      return "kept";
    }
    const before = lineBeforeEwa.current[lineId];
    const wasFreshRow = !before || (!before.description && !before.amount && before.type !== "EWA");
    setForm((prev) => ({
      ...prev,
      lineItems: wasFreshRow
        ? prev.lineItems.filter((li) => li.id !== lineId)
        : prev.lineItems.map((li) => (li.id === lineId ? before : li)),
    }));
    delete lineBeforeEwa.current[lineId];
    return wasFreshRow ? "removed" : "reverted";
  };

  /** Failed lookup — no EWA line item is created; explain exactly why. */
  const failEwaLine = (lineId: string, message: string) => {
    setPendingPick((p) => (p?.lineId === lineId ? null : p));
    toast.error(message);
    const outcome = revertEwaLine(lineId);
    if (outcome === "kept") {
      setEwaMessages((prev) => ({ ...prev, [lineId]: message }));
    } else {
      setEwaMessages((prev) => {
        if (!(lineId in prev)) return prev;
        const next = { ...prev };
        delete next[lineId];
        return next;
      });
    }
  };

  /** Run the automatic EWA lookup for one line (Lease → Unit → Account → Bill). */
  const runEwa = (lineId: string, ctx?: { leaseId?: string; periodFrom?: string }) => {
    const result = resolveEwaCharge({
      leaseId: ctx?.leaseId ?? form.leaseId,
      periodFrom: ctx?.periodFrom ?? form.periodFrom,
      units,
      leases,
      tenants,
      ewaAccounts,
      ewaBills,
      ewaDistributions,
      invoices,
      usedBillIds: usedBillIdsFor(lineId),
    });
    if (result.status === "ok") {
      fillEwaLine(lineId, result.candidate);
    } else if (result.status === "choice") {
      setPendingPick({ lineId, candidates: result.candidates });
      setEwaMessages((prev) => ({
        ...prev,
        [lineId]: "Multiple EWA bills match this unit and billing period — select one below.",
      }));
    } else {
      failEwaLine(lineId, result.message);
    }
  };

  const clearEwaLine = (lineId: string) => {
    delete lineBeforeEwa.current[lineId];
    setPendingPick((p) => (p?.lineId === lineId ? null : p));
    setForm((prev) => ({
      ...prev,
      lineItems: prev.lineItems.map((li) =>
        li.id === lineId ? { id: li.id, description: li.description, amount: li.amount, type: li.type } : li,
      ),
    }));
    setEwaMessages((prev) => {
      if (!(lineId in prev)) return prev;
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
    if (field === "periodFrom" || field === "leaseId") {
      // Lease or billing period changed — re-run the automatic lookup for
      // every existing EWA line against the new period.
      const ewaLines = form.lineItems.filter((li) => li.type === "EWA");
      const reIds = new Set(ewaLines.map((li) => li.id));
      const used: string[] = form.lineItems
        .filter((li) => li.type === "EWA" && li.ewaBillId && !reIds.has(li.id))
        .map((li) => li.ewaBillId as string);
      for (const li of ewaLines) {
        const result = resolveEwaCharge({
          leaseId: field === "leaseId" ? String(value) : form.leaseId,
          periodFrom: field === "periodFrom" ? String(value) : form.periodFrom,
          units,
          leases,
          tenants,
          ewaAccounts,
          ewaBills,
          ewaDistributions,
          invoices,
          usedBillIds: used,
        });
        if (result.status === "ok") {
          fillEwaLine(li.id, result.candidate);
          used.push(result.candidate.bill.id);
        } else if (result.status === "choice") {
          setPendingPick({ lineId: li.id, candidates: result.candidates });
          setEwaMessages((prev) => ({
            ...prev,
            [li.id]: "Multiple EWA bills match this unit and billing period — select one below.",
          }));
          break;
        } else {
          failEwaLine(li.id, result.message);
        }
      }
    }
  };

  const updateLineItem = (index: number, field: keyof InvoiceLineItem, value: string | number) => {
    const line = form.lineItems[index];
    if (!line) return;
    if (field === "type") {
      const nextType = value as InvoiceLineItem["type"];
      if (nextType === "EWA" && line.type !== "EWA") {
        lineBeforeEwa.current[line.id] = line;
      }
      setForm((prev) => ({
        ...prev,
        lineItems: prev.lineItems.map((li, i) => (i === index ? { ...li, type: nextType } : li)),
      }));
      // Selecting EWA is the trigger — the amount fills itself from the
      // linked EWA bill's allocation for the invoice billing period.
      if (nextType === "EWA") {
        runEwa(line.id);
      } else {
        clearEwaLine(line.id);
      }
      return;
    }
    setForm((prev) => ({
      ...prev,
      lineItems: prev.lineItems.map((li, i) => (i === index ? { ...li, [field]: value } : li)),
    }));
  };

  const addLineItem = () => {
    setForm((prev) => ({
      ...prev,
      lineItems: [...prev.lineItems, { id: `li-${Date.now()}`, description: "", amount: 0, type: "Other" }],
    }));
  };

  const removeLineItem = (index: number) => {
    const line = form.lineItems[index];
    if (!line) return;
    delete lineBeforeEwa.current[line.id];
    setPendingPick((p) => (p?.lineId === line.id ? null : p));
    setEwaMessages((prev) => {
      if (!(line.id in prev)) return prev;
      const next = { ...prev };
      delete next[line.id];
      return next;
    });
    setForm((prev) => ({ ...prev, lineItems: prev.lineItems.filter((li) => li.id !== line.id) }));
  };

  const pickCandidate = (candidate: EwaCandidate) => {
    if (!pendingPick) return;
    const lineId = pendingPick.lineId;
    const usedElsewhere = form.lineItems.some(
      (li) => li.type === "EWA" && li.id !== lineId && li.ewaBillId === candidate.bill.id,
    );
    if (usedElsewhere) {
      toast.error("EWA already added to this invoice.");
      return;
    }
    fillEwaLine(lineId, candidate);
  };

  const cancelPick = () => {
    if (!pendingPick) return;
    const lineId = pendingPick.lineId;
    setPendingPick(null);
    const outcome = revertEwaLine(lineId);
    if (outcome === "removed" || outcome === "reverted") {
      setEwaMessages((prev) => {
        if (!(lineId in prev)) return prev;
        const next = { ...prev };
        delete next[lineId];
        return next;
      });
    }
  };

  // If the underlying EWA bill changes (edited/recalculated), the invoice EWA
  // amount follows the bill's allocation automatically.
  const selectedUnitId = selectedLease?.unitId;
  useEffect(() => {
    if (!selectedUnitId) return;
    const leaseUnit = getUnitById(selectedUnitId);
    if (!leaseUnit) return;
    setForm((prev) => {
      let changed = false;
      const lineItems = prev.lineItems.map((li) => {
        if (li.type !== "EWA" || !li.ewaBillId || !li.billingPeriod) return li;
        const bill = ewaBills.find((b) => b.id === li.ewaBillId);
        if (!bill) return li;
        const account =
          ewaAccounts.find((a) => a.id === (bill.ewaAccountId ?? li.ewaAccountId)) ??
          findUnitEwaAccount(leaseUnit.id, ewaAccounts);
        if (!account) return li;
        const cls = classifyEwaBill(bill, leaseUnit.id, account, { units, leases, tenants, ewaDistributions });
        if (!cls.chargeable) return li;
        const description = ewaLineDescription(bill);
        const period = monthKeyOf(bill.month);
        if (cls.share !== li.amount || description !== li.description || li.billingPeriod !== period) {
          changed = true;
          return { ...li, amount: cls.share, description, billingPeriod: period };
        }
        return li;
      });
      return changed ? { ...prev, lineItems } : prev;
    });
  }, [ewaBills, ewaAccounts, units, leases, tenants, ewaDistributions, selectedUnitId, getUnitById]);

  /** Derived warning for a linked bill that vanished or got invoiced elsewhere. */
  const lineWarning = (li: InvoiceLineItem): string | undefined => {
    if (li.type !== "EWA" || !li.ewaBillId) return undefined;
    const bill = ewaBills.find((b) => b.id === li.ewaBillId);
    if (!bill) return "The linked EWA bill is no longer available — it may have been deleted.";
    if (bill.invoiceId && bill.invoiceId !== initialData?.id) {
      const inv = invoices.find((i) => i.id === bill.invoiceId);
      return `EWA bill already invoiced${inv ? ` on ${inv.invoiceNumber}` : ""} — remove this EWA line.`;
    }
    return undefined;
  };

  const validate = () => {
    const next: Record<string, string> = {};
    if (!form.leaseId) next.leaseId = "Lease is required";
    if (!form.dueDate) next.dueDate = "Due date is required";
    if (form.lineItems.length === 0) next.lineItems = "Add at least one line item";
    for (const li of form.lineItems) {
      if (li.type !== "EWA") continue;
      if (pendingPick?.lineId === li.id) {
        next.lineItems = "Select the EWA bill to use for this line.";
        break;
      }
      const problem = ewaMessages[li.id] ?? lineWarning(li);
      if (problem) {
        next.lineItems = problem;
        break;
      }
      if (!li.ewaBillId) {
        next.lineItems = "EWA line item has no valid EWA bill.";
        break;
      }
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!validate()) return;

    if (!selectedLease || !tenant || !selectedUnit) return;

    const invoiceNumber = initialData?.invoiceNumber ?? generateCode("INV", invoices.length);
    const status = initialData?.status ?? "Draft";

    const sumByType = (type: InvoiceLineItem["type"]) =>
      form.lineItems.filter((li) => li.type === type).reduce((sum, li) => sum + (Number(li.amount) || 0), 0);
    const rentAmount = sumByType("Rent");
    const ewaAmount = sumByType("EWA");
    const maintenanceAmount = sumByType("Service Charge");

    // Every EWA line stays linked to its actual EWA bill / account, so the
    // same charge can never be billed twice.
    const lineEwaBillIds = form.lineItems
      .filter((li) => li.type === "EWA" && li.ewaBillId)
      .map((li) => li.ewaBillId as string);
    const ewaBillIds = [...new Set([...(initialData?.ewaBillIds ?? []), ...lineEwaBillIds])];

    const payload = {
      invoiceNumber,
      tenantId: tenant.id,
      leaseId: selectedLease.id,
      unitId: selectedUnit.id,
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
      // Bills whose EWA lines were removed during the edit become invoiceable again.
      releaseEwaBills((initialData.ewaBillIds ?? []).filter((id) => !ewaBillIds.includes(id)));
    } else {
      const created = addInvoice(payload);
      markEwaBillsInvoiced(ewaBillIds, created.id, created.invoiceNumber);
    }
    onClose();
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
            const linkedBill = isEwa && li.ewaBillId ? ewaBills.find((b) => b.id === li.ewaBillId) : undefined;
            const linkedAccount = linkedBill
              ? ewaAccounts.find((a) => a.id === (linkedBill.ewaAccountId ?? li.ewaAccountId))
              : undefined;
            const warning = lineWarning(li);
            const message = ewaMessages[li.id] ?? warning;
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
                {isEwa && linkedBill && !warning && (
                  <p className="mt-1 text-xs text-emerald-700">
                    Auto-filled from EWA bill {linkedBill.billNumber}
                    {linkedAccount ? ` · Account ${linkedAccount.accountNumber}` : ""}
                    {selectedUnit ? ` · Unit ${selectedUnit.unitNumber}` : ""}
                    {` · ${formatPeriodLabel(monthKeyOf(linkedBill.month))}`} — allocated share, read-only.
                  </p>
                )}
                {isEwa && message && <p className="mt-1 text-xs text-red-500">{message}</p>}
                {pendingPick?.lineId === li.id && (
                  <div className="mt-2 space-y-1 rounded-md border bg-muted/40 p-2">
                    <p className="text-xs font-medium">Multiple EWA bills match — select one:</p>
                    {pendingPick.candidates.map((c) => (
                      <div
                        key={c.bill.id}
                        className="flex items-center justify-between gap-2 rounded border bg-background px-2 py-1.5"
                      >
                        <span className="text-xs">
                          Bill {c.bill.billNumber} · {formatPeriodLabel(monthKeyOf(c.bill.month))} ·{" "}
                          <strong>{c.share.toFixed(3)} BHD</strong> · due {c.bill.dueDate}
                        </span>
                        <Button type="button" size="sm" variant="outline" onClick={() => pickCandidate(c)}>
                          Use
                        </Button>
                      </div>
                    ))}
                    <Button type="button" size="sm" variant="ghost" onClick={cancelPick}>
                      Cancel
                    </Button>
                  </div>
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
