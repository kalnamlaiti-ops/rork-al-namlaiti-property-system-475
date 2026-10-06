import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useData } from "@/context/DataContext";
import { computeInvoiceSettlement } from "@/lib/invoiceSettlement";
import type { Payment } from "@/types";

interface PaymentFormProps {
  initialData?: Payment;
  preselectedInvoiceId?: string;
  onClose: () => void;
}

const paymentMethods: Payment["method"][] = ["Bank Transfer", "Cash", "Cheque", "Card", "Online"];

export default function PaymentForm({ initialData, preselectedInvoiceId, onClose }: PaymentFormProps) {
  const { addPayment, updatePayment, invoices, payments, getTenantById } = useData();
  const isEdit = Boolean(initialData);

  const [form, setForm] = useState({
    invoiceId: initialData?.invoiceId ?? preselectedInvoiceId ?? "",
    paymentDate: initialData?.paymentDate ?? new Date().toISOString().split("T")[0],
    amount: initialData?.amount ?? 0,
    method: initialData?.method ?? "Cheque",
    reference: initialData?.reference ?? "",
    bank: "",
    chequeDate: new Date().toISOString().split("T")[0],
    notes: initialData?.notes ?? "",
  });

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [confirmOverpay, setConfirmOverpay] = useState(false);

  // Unique receipt number — RCP-<year>-<6 digits>, checked against every
  // existing payment so numbers are never duplicated.
  const generateUniqueReceiptNumber = () => {
    const year = new Date().getFullYear();
    const existing = new Set(payments.map((p) => p.receiptNumber));
    let n = payments.length + 1;
    let candidate = `RCP-${year}-${String(n).padStart(6, "0")}`;
    while (existing.has(candidate)) {
      n += 1;
      candidate = `RCP-${year}-${String(n).padStart(6, "0")}`;
    }
    return candidate;
  };

  const selectedInvoice = invoices.find((i) => i.id === form.invoiceId);
  const tenant = selectedInvoice ? getTenantById(selectedInvoice.tenantId) : undefined;

  // Outstanding balance derived from the ACTUAL payment records — never a
  // stored value — so it is always current. When editing, the payment's own
  // current amount is already reflected in the computed outstanding — add it
  // back so the comparison shows what is actually available to allocate.
  const selectedSettlement = selectedInvoice ? computeInvoiceSettlement(selectedInvoice, payments) : undefined;
  const outstanding = selectedSettlement ? selectedSettlement.remainingBalance : 0;
  const effectiveOutstanding =
    selectedInvoice && initialData && initialData.invoiceId === selectedInvoice.id
      ? outstanding + (initialData.amount || 0)
      : outstanding;
  const isOverpayment = Number(form.amount) > effectiveOutstanding + 0.0005;
  const remainingAfter = Math.max(0, outstanding - Number(form.amount || 0));

  // Default the amount to the invoice's CURRENT remaining balance whenever a
  // different invoice is selected (new payments only — edits keep their value).
  const lastAutoFilledInvoice = useRef<string>("");
  useEffect(() => {
    if (isEdit || !selectedInvoice || selectedInvoice.id === lastAutoFilledInvoice.current) return;
    lastAutoFilledInvoice.current = selectedInvoice.id;
    const remaining = computeInvoiceSettlement(selectedInvoice, payments).remainingBalance;
    setForm((prev) => ({ ...prev, amount: Number(remaining.toFixed(3)) }));
  }, [isEdit, selectedInvoice, payments]);

  const update = (field: keyof typeof form, value: string | number) => {
    setForm((prev) => ({ ...prev, [field]: value }));
    if (errors[field]) {
      setErrors((prev) => ({ ...prev, [field]: "" }));
    }
  };

  const validate = () => {
    const next: Record<string, string> = {};
    if (!form.invoiceId) next.invoiceId = "Invoice is required";
    if (!form.paymentDate) next.paymentDate = "Payment date is required";
    if (form.amount <= 0) next.amount = "Amount must be greater than 0";
    if (!form.method) next.method = "Payment method is required";
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const submitPayment = () => {
    if (!selectedInvoice || !tenant) return;

    const receiptNumber = initialData?.receiptNumber ?? generateUniqueReceiptNumber();

    const payload = {
      receiptNumber,
      invoiceId: selectedInvoice.id,
      tenantId: tenant.id,
      amount: Number(form.amount),
      paymentDate: form.paymentDate,
      method: form.method as Payment["method"],
      reference: form.reference,
      notes: [form.notes, form.bank && `Bank: ${form.bank}`, form.chequeDate && form.method === "Cheque" && `Cheque date: ${form.chequeDate}`].filter(Boolean).join("\n"),
    };

    if (initialData) {
      updatePayment(initialData.id, payload);
    } else {
      addPayment(payload);
    }
    onClose();
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!validate() || !selectedInvoice || !tenant) return;
    // Overpayment protection — paying more than the outstanding balance
    // requires explicit confirmation before it is accepted.
    if (isOverpayment) {
      setConfirmOverpay(true);
      return;
    }
    submitPayment();
  };

  return (
    <>
    <form onSubmit={handleSubmit} className="space-y-6">
      {selectedSettlement && (
        <div className="flex items-center justify-between rounded-lg border bg-muted/40 px-4 py-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Amount Due</p>
            <p className="text-sm text-muted-foreground">
              {selectedInvoice?.invoiceNumber}
              {tenant ? ` — ${tenant.name}` : ""}
            </p>
          </div>
          <p className={`text-2xl font-bold tabular-nums ${outstanding > 0.0005 ? "text-red-600" : "text-emerald-600"}`}>
            {outstanding.toFixed(3)} BHD
          </p>
        </div>
      )}
      <div className="rounded-lg border bg-card p-6">
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2 md:col-span-2">
            <Label htmlFor="invoiceId">Invoice *</Label>
            <select
              id="invoiceId"
              value={form.invoiceId}
              onChange={(e) => update("invoiceId", e.target.value)}
              className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
              disabled={Boolean(preselectedInvoiceId) && !isEdit}
            >
              <option value="">Select invoice</option>
              {invoices
                // Balance invoices mirror an original's remaining amount — record
                // payments on the original so nothing is double-counted.
                .filter((i) => !i.originalInvoiceId && i.status !== "Cancelled")
                .map((i) => {
                  const t = getTenantById(i.tenantId);
                  const due = computeInvoiceSettlement(i, payments).remainingBalance;
                  return (
                    <option key={i.id} value={i.id}>
                      {i.invoiceNumber} — {t?.name} (Due: BHD {due.toFixed(3)})
                    </option>
                  );
                })}
            </select>
            {errors.invoiceId && <p className="text-xs text-red-500">{errors.invoiceId}</p>}
          </div>
          <div className="space-y-2">
            <Label htmlFor="paymentDate">Payment Date *</Label>
            <Input id="paymentDate" type="date" value={form.paymentDate} onChange={(e) => update("paymentDate", e.target.value)} />
            {errors.paymentDate && <p className="text-xs text-red-500">{errors.paymentDate}</p>}
          </div>
          <div className="space-y-2">
            <Label htmlFor="amount">Amount (BHD) *</Label>
            <Input id="amount" type="number" value={form.amount} onChange={(e) => update("amount", e.target.value)} />
            {errors.amount && <p className="text-xs text-red-500">{errors.amount}</p>}
            {selectedInvoice && !errors.amount && (
              <p className="text-xs text-muted-foreground">
                Outstanding: BHD {outstanding.toFixed(3)} · Remaining after this payment: BHD {remainingAfter.toFixed(3)}
              </p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="method">Payment Method *</Label>
            <select
              id="method"
              value={form.method}
              onChange={(e) => update("method", e.target.value)}
              className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
            >
              {paymentMethods.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            {errors.method && <p className="text-xs text-red-500">{errors.method}</p>}
          </div>
          <div className="space-y-2">
            <Label htmlFor="reference">Reference / Cheque #</Label>
            <Input id="reference" value={form.reference} onChange={(e) => update("reference", e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="bank">Bank</Label>
            <Input id="bank" value={form.bank} onChange={(e) => update("bank", e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="chequeDate">Cheque Date</Label>
            <Input id="chequeDate" type="date" value={form.chequeDate} onChange={(e) => update("chequeDate", e.target.value)} />
          </div>
          <div className="space-y-2 md:col-span-2">
            <Label htmlFor="notes">Notes</Label>
            <Textarea id="notes" value={form.notes} onChange={(e) => update("notes", e.target.value)} />
          </div>
        </div>
      </div>

      <div className="flex justify-end gap-3">
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit">{isEdit ? "Save Changes" : "Record Payment"}</Button>
      </div>
    </form>

    <AlertDialog open={confirmOverpay} onOpenChange={setConfirmOverpay}>
      <AlertDialogContent className="max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>Overpayment</AlertDialogTitle>
          <AlertDialogDescription>
            Payment exceeds the outstanding balance. Outstanding: BHD {effectiveOutstanding.toFixed(3)} — entered: BHD{" "}
            {Number(form.amount || 0).toFixed(3)}. Do you want to accept this overpayment?
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              setConfirmOverpay(false);
              submitPayment();
            }}
            className="bg-amber-600 text-white hover:bg-amber-700"
          >
            Accept Overpayment
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    </>
  );
}
