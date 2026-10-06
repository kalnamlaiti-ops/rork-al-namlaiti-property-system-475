import { useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/StatusBadge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
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
import InvoiceForm from "@/components/forms/InvoiceForm";
import PaymentForm from "@/components/forms/PaymentForm";
import {
  ArrowLeft,
  Pencil,
  CreditCard,
  Plus,
  Send,
  Download,
  CheckCircle,
  RotateCcw,
  XCircle,
  Loader2,
  Mail,
  MessageCircle,
  Printer,
  User,
  Phone,
  Building2,
  Home,
  FileText,
  CalendarDays,
} from "lucide-react";
import { format } from "date-fns";
import { generateInvoicePdf, downloadInvoicePdf } from "@/lib/pdfGenerator";
import { computeInvoiceSettlement, displayInvoiceStatus } from "@/lib/invoiceSettlement";
import type { Invoice } from "@/types";

function formatCurrency(amount: number) {
  return new Intl.NumberFormat("en-BH", {
    style: "currency",
    currency: "BHD",
    minimumFractionDigits: 3,
    maximumFractionDigits: 3,
  }).format(amount);
}

export default function InvoiceDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const {
    invoices,
    payments,
    getInvoiceById,
    getTenantById,
    getUnitById,
    getBuildingById,
    getLeaseById,
    sendInvoice,
    sendInvoiceWhatsAppMessage,
    markInvoicePaid,
    undoInvoicePayment,
    voidInvoice,
    buildPdfContext,
  } = useData();

  const [editDialog, setEditDialog] = useState(false);
  const [paymentDialog, setPaymentDialog] = useState(false);
  const [previewDialog, setPreviewDialog] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendingWa, setSendingWa] = useState(false);
  const [markingPaid, setMarkingPaid] = useState(false);
  const [voiding, setVoiding] = useState(false);
  const [undoDialog, setUndoDialog] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string>("");

  const invoice = id ? getInvoiceById(id) : undefined;
  const tenant = invoice ? getTenantById(invoice.tenantId) : undefined;
  const unit = invoice ? getUnitById(invoice.unitId) : undefined;
  const building = unit ? getBuildingById(unit.buildingId) : undefined;
  const invoicePayments = invoice ? payments.filter((p) => p.invoiceId === invoice.id) : [];

  if (!invoice) {
    return (
      <div className="space-y-6">
        <Button variant="ghost" onClick={() => navigate("/invoices")}>
          <ArrowLeft className="mr-2 h-4 w-4" /> Back
        </Button>
        <p className="text-muted-foreground">Invoice not found.</p>
      </div>
    );
  }

  // Payment-derived settlement — the source of truth for every amount shown
  // on this page (paid, remaining, amount due, status).
  const settlement = computeInvoiceSettlement(invoice, payments);
  const displayStatus = displayInvoiceStatus(invoice, settlement);
  const isFullyPaid = settlement.remainingBalance <= 0.0005;
  const paidPct =
    settlement.originalAmount > 0
      ? Math.min(100, (settlement.totalPaid / settlement.originalAmount) * 100)
      : 0;
  const lease = invoice.leaseId ? getLeaseById(invoice.leaseId) : undefined;

  // Payment history in chronological order with the running remaining balance
  // after each payment (derived from the records — never a stored value).
  const sortedPayments = [...invoicePayments].sort(
    (a, b) => new Date(a.paymentDate).getTime() - new Date(b.paymentDate).getTime() || a.id.localeCompare(b.id),
  );
  let runningBalance = settlement.originalAmount;
  const paymentRows = sortedPayments.map((p) => {
    runningBalance -= p.amount;
    return { payment: p, remainingAfter: Math.max(0, runningBalance) };
  });

  const handleSend = async () => {
    setSending(true);
    try {
      await sendInvoice(invoice.id);
    } finally {
      setSending(false);
    }
  };

  const handleSendWhatsApp = async () => {
    setSendingWa(true);
    try {
      await sendInvoiceWhatsAppMessage(invoice.id);
    } finally {
      setSendingWa(false);
    }
  };

  const handlePreview = () => {
    const ctx = buildPdfContext(invoice);
    const doc = generateInvoicePdf(ctx);
    const url = doc.output("bloburl");
    setPreviewUrl(typeof url === "string" ? url : URL.createObjectURL(doc.output("blob")));
    setPreviewDialog(true);
  };

  const handleDownload = () => {
    const ctx = buildPdfContext(invoice);
    downloadInvoicePdf(ctx);
  };

  const handlePrint = () => {
    const ctx = buildPdfContext(invoice);
    const doc = generateInvoicePdf(ctx);
    doc.autoPrint();
    window.open(doc.output("bloburl"), "_blank");
  };

  const handleMarkPaid = async () => {
    setMarkingPaid(true);
    try {
      markInvoicePaid(invoice.id);
    } finally {
      setMarkingPaid(false);
    }
  };

  const handleUndoPayment = () => {
    setUndoDialog(false);
    undoInvoicePayment(invoice.id);
  };

  const handleVoid = async () => {
    setVoiding(true);
    try {
      voidInvoice(invoice.id);
    } finally {
      setVoiding(false);
    }
  };

  const canEdit = invoice.status === "Draft" || invoice.status === "Sent";
  const isCancelled = invoice.status === "Cancelled";
  // Balance invoices mirror this invoice's remaining amount; on a balance
  // invoice, link back to the original.
  const balanceInvoice = invoices.find(
    (i) => i.originalInvoiceId === invoice.id && i.status !== "Cancelled" && i.status !== "Paid",
  );
  const originalInvoice = invoice.originalInvoiceId
    ? invoices.find((i) => i.id === invoice.originalInvoiceId)
    : undefined;

  return (
    <div className="space-y-6">
      {/* ── Toolbar ── */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button variant="ghost" size="sm" onClick={() => navigate("/invoices")}>
          <ArrowLeft className="mr-2 h-4 w-4" /> Back to Invoices
        </Button>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setPaymentDialog(true)} disabled={isCancelled || isFullyPaid}>
            {isFullyPaid ? (
              <CheckCircle className="mr-2 h-4 w-4" />
            ) : (
              <Plus className="mr-2 h-4 w-4" />
            )}
            {isFullyPaid ? "Fully Paid" : "Record Payment"}
          </Button>
          <Button variant="outline" onClick={handleDownload}>
            <Download className="mr-2 h-4 w-4" /> Download PDF
          </Button>
          <Button variant="outline" onClick={handleSend} disabled={sending || isCancelled}>
            {sending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
            {invoice.emailStatus === "Sent" ? "Resend" : "Send Invoice"}
          </Button>
          <Button
            variant="outline"
            onClick={handleSendWhatsApp}
            disabled={sendingWa || isCancelled || !tenant?.phone}
            title={!tenant?.phone ? "Tenant has no phone number" : "Send via WhatsApp"}
          >
            {sendingWa ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <MessageCircle className="mr-2 h-4 w-4" />}
            WhatsApp
          </Button>
          <Button variant="outline" onClick={handlePreview}>
            <Printer className="mr-2 h-4 w-4" /> Print
          </Button>
          {canEdit && (
            <Button variant="outline" onClick={() => setEditDialog(true)}>
              <Pencil className="mr-2 h-4 w-4" /> Edit
            </Button>
          )}
          {settlement.remainingBalance > 0 && !isCancelled && (
            <Button variant="outline" onClick={handleMarkPaid} disabled={markingPaid} className="text-emerald-600">
              {markingPaid ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CheckCircle className="mr-2 h-4 w-4" />} Mark Paid
            </Button>
          )}
          {invoice.status === "Paid" && (
            <Button variant="outline" onClick={() => setUndoDialog(true)} className="text-amber-600">
              <RotateCcw className="mr-2 h-4 w-4" /> Undo Payment
            </Button>
          )}
          {!isCancelled && (
            <Button variant="outline" onClick={handleVoid} disabled={voiding} className="text-red-600">
              {voiding ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <XCircle className="mr-2 h-4 w-4" />} Void
            </Button>
          )}
        </div>
      </div>

      {/* ── Invoice header & financial summary ── */}
      <Card className="overflow-hidden">
        <CardContent className="p-0">
          <div className="flex flex-wrap items-start justify-between gap-4 border-b p-6">
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Invoice</p>
              <div className="mt-1 flex flex-wrap items-center gap-3">
                <h1 className="text-2xl font-bold tracking-tight text-foreground">{invoice.invoiceNumber}</h1>
                <StatusBadge status={displayStatus} />
                {invoice.generatedAutomatically && (
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">
                    Auto-generated
                  </span>
                )}
              </div>
              <p className="mt-1.5 text-sm text-muted-foreground">
                Tenant: <span className="font-medium text-foreground">{tenant?.name ?? "—"}</span>
                {"  ·  "}Unit {unit?.unitNumber ?? "—"}
                {building ? ` · ${building.name}` : ""}
              </p>
            </div>
            <div className="grid grid-cols-2 gap-x-10 gap-y-1.5 text-sm">
              <p className="text-muted-foreground">Invoice Date</p>
              <p className="font-medium sm:text-right">
                {invoice.issueDate ? format(new Date(invoice.issueDate), "dd MMM yyyy") : "—"}
              </p>
              <p className="text-muted-foreground">Due Date</p>
              <p className="font-medium sm:text-right">{format(new Date(invoice.dueDate), "dd MMM yyyy")}</p>
              {invoice.periodFrom && (
                <>
                  <p className="text-muted-foreground">Billing Period</p>
                  <p className="font-medium sm:text-right">
                    {format(new Date(invoice.periodFrom), "dd MMM yyyy")}
                    {invoice.periodTo ? ` – ${format(new Date(invoice.periodTo), "dd MMM yyyy")}` : ""}
                  </p>
                </>
              )}
            </div>
          </div>

          {/* Financial summary — Balance Due is the most important figure */}
          <div className="grid divide-y border-b bg-muted/30 sm:grid-cols-3 sm:divide-x sm:divide-y-0">
            <div className="p-6">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Original Amount</p>
              <p className="mt-2 text-xl font-semibold tabular-nums text-foreground">
                {formatCurrency(settlement.originalAmount)}
              </p>
            </div>
            <div className="p-6">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Paid</p>
              <p className="mt-2 text-xl font-semibold tabular-nums text-emerald-600">
                {formatCurrency(settlement.totalPaid)}
              </p>
              {settlement.overpaidAmount > 0.0005 && (
                <p className="mt-1 text-xs font-medium text-violet-600">
                  Overpaid by {formatCurrency(settlement.overpaidAmount)}
                </p>
              )}
            </div>
            <div className="p-6">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Balance Due</p>
              <p
                className={`mt-1 text-3xl font-bold tabular-nums ${
                  settlement.remainingBalance > 0.0005 ? "text-red-600" : "text-emerald-600"
                }`}
              >
                {formatCurrency(settlement.remainingBalance)}
              </p>
            </div>
          </div>

          {/* Payment progress */}
          <div className="p-6">
            <div className="mb-2 flex items-center justify-between text-sm">
              <span className="font-medium text-foreground">
                {formatCurrency(settlement.totalPaid)} / {formatCurrency(settlement.originalAmount)} Paid
              </span>
              <span className="text-muted-foreground">{paidPct.toFixed(0)}% Paid</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-all duration-500"
                style={{ width: `${paidPct}%` }}
              />
            </div>
          </div>

          {/* Paid-in-full confirmation */}
          {isFullyPaid && !isCancelled && (
            <div className="flex flex-wrap items-center justify-between gap-4 border-t bg-emerald-50/70 p-6">
              <div className="flex items-center gap-3">
                <span className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-100">
                  <CheckCircle className="h-5 w-5 text-emerald-600" />
                </span>
                <div>
                  <p className="text-sm font-bold uppercase tracking-wider text-emerald-700">Paid in Full</p>
                  <p className="text-xs text-emerald-700/80">
                    {formatCurrency(settlement.totalPaid)} fully settled against this invoice
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap gap-x-10 gap-y-2 text-sm">
                <div>
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">Original Amount</p>
                  <p className="font-semibold tabular-nums">{formatCurrency(settlement.originalAmount)}</p>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">Total Paid</p>
                  <p className="font-semibold tabular-nums text-emerald-600">{formatCurrency(settlement.totalPaid)}</p>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">Balance Due</p>
                  <p className="font-semibold tabular-nums text-emerald-600">{formatCurrency(0)}</p>
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Email status banner */}
      {invoice.emailStatus && invoice.emailStatus !== "Not Sent" && (
        <div className={`flex items-center gap-2 rounded-lg p-3 text-sm ${
          invoice.emailStatus === "Sent" ? "bg-emerald-50 text-emerald-700" :
          invoice.emailStatus === "Failed" ? "bg-red-50 text-red-700" :
          "bg-amber-50 text-amber-700"
        }`}>
          <Mail className="h-4 w-4" />
          <span>
            Email: {invoice.emailStatus}
            {invoice.emailSentAt && ` · ${format(new Date(invoice.emailSentAt), "dd MMM yyyy HH:mm")}`}
            {invoice.emailError && ` · ${invoice.emailError}`}
          </span>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        {/* ── Line items ── */}
        <Card className="lg:col-span-2">
          <CardContent className="p-6">
            <h3 className="mb-4 text-sm font-semibold uppercase tracking-wider text-muted-foreground">Line Items</h3>
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2.5 text-left font-medium">Description</th>
                    <th className="px-4 py-2.5 text-left font-medium">Category</th>
                    <th className="px-4 py-2.5 text-right font-medium">Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {invoice.lineItems.map((li) => (
                    <tr key={li.id} className="hover:bg-muted/30">
                      <td className="px-4 py-2.5">{li.description}</td>
                      <td className="px-4 py-2.5 text-muted-foreground">{li.type}</td>
                      <td className="px-4 py-2.5 text-right font-medium tabular-nums">{formatCurrency(li.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Totals */}
            <div className="ml-auto mt-5 w-full max-w-xs space-y-1.5 text-sm">
              {(invoice.rentAmount ?? 0) > 0 && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Rent</span>
                  <span className="tabular-nums">{formatCurrency(invoice.rentAmount ?? 0)}</span>
                </div>
              )}
              {(invoice.ewaAmount ?? 0) > 0 && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">EWA Charges</span>
                  <span className="tabular-nums">{formatCurrency(invoice.ewaAmount ?? 0)}</span>
                </div>
              )}
              {(invoice.maintenanceAmount ?? 0) > 0 && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Maintenance</span>
                  <span className="tabular-nums">{formatCurrency(invoice.maintenanceAmount ?? 0)}</span>
                </div>
              )}
              {(invoice.otherExpensesAmount ?? 0) > 0 && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Other Expenses</span>
                  <span className="tabular-nums">{formatCurrency(invoice.otherExpensesAmount ?? 0)}</span>
                </div>
              )}
              {(invoice.previousBalance ?? 0) > 0 && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Previous Balance</span>
                  <span className="tabular-nums">{formatCurrency(invoice.previousBalance ?? 0)}</span>
                </div>
              )}
              <div className="flex justify-between font-medium">
                <span>Subtotal</span>
                <span className="tabular-nums">{formatCurrency(settlement.originalAmount)}</span>
              </div>
              {settlement.totalPaid > 0 && (
                <div className="flex justify-between text-emerald-600">
                  <span>Paid</span>
                  <span className="tabular-nums">−{formatCurrency(settlement.totalPaid)}</span>
                </div>
              )}
              <div className="flex items-center justify-between border-t pt-2.5">
                <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Balance Due
                </span>
                <span
                  className={`text-lg font-bold tabular-nums ${
                    settlement.remainingBalance > 0.0005 ? "text-red-600" : "text-emerald-600"
                  }`}
                >
                  {formatCurrency(settlement.remainingBalance)}
                </span>
              </div>
              {originalInvoice && (
                <p className="pt-1 text-xs text-muted-foreground">
                  Balance invoice for{" "}
                  <Link to={`/invoices/${originalInvoice.id}`} className="text-primary hover:underline">
                    {originalInvoice.invoiceNumber}
                  </Link>
                </p>
              )}
              {balanceInvoice && (
                <p className="text-xs text-muted-foreground">
                  Balance invoice:{" "}
                  <Link to={`/invoices/${balanceInvoice.id}`} className="text-primary hover:underline">
                    {balanceInvoice.invoiceNumber}
                  </Link>{" "}
                  ({formatCurrency(balanceInvoice.balance)} outstanding)
                </p>
              )}
            </div>

            {invoice.paymentInstructions && (
              <div className="mt-6 rounded-lg bg-muted/50 p-4">
                <p className="text-sm font-semibold">Payment Instructions</p>
                <p className="mt-1 text-sm text-muted-foreground">{invoice.paymentInstructions}</p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* ── Tenant & property information ── */}
        <Card>
          <CardContent className="p-6">
            <h3 className="mb-4 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              Tenant &amp; Property
            </h3>
            <div className="space-y-4">
              <div className="flex items-start gap-3">
                <User className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">Tenant Name</p>
                  <p className="truncate text-sm font-medium">{tenant?.name ?? "—"}</p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <Phone className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">Phone Number</p>
                  <p className="text-sm font-medium">{tenant?.phone || "—"}</p>
                  {tenant?.email && <p className="truncate text-xs text-muted-foreground">{tenant.email}</p>}
                </div>
              </div>
              <div className="flex items-start gap-3">
                <Building2 className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">Building</p>
                  <p className="text-sm font-medium">{building?.name ?? "—"}</p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <Home className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">Unit</p>
                  <p className="text-sm font-medium">{unit?.unitNumber ?? "—"}</p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <FileText className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">Lease Number</p>
                  <p className="text-sm font-medium">{lease?.contractNumber ?? "—"}</p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <CalendarDays className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">Invoice Date</p>
                  <p className="text-sm font-medium">
                    {invoice.issueDate ? format(new Date(invoice.issueDate), "dd MMM yyyy") : "—"}
                  </p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <CalendarDays className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">Due Date</p>
                  <p className="text-sm font-medium">{format(new Date(invoice.dueDate), "dd MMM yyyy")}</p>
                </div>
              </div>
              {invoice.periodFrom && (
                <div className="flex items-start gap-3">
                  <CalendarDays className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0">
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">Billing Period</p>
                    <p className="text-sm font-medium">
                      {format(new Date(invoice.periodFrom), "dd MMM yyyy")}
                      {invoice.periodTo ? ` – ${format(new Date(invoice.periodTo), "dd MMM yyyy")}` : ""}
                    </p>
                  </div>
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Accounting */}
        {invoice.journalEntryId && (
          <Card>
            <CardContent className="p-5">
              <h3 className="mb-2 text-sm font-semibold uppercase tracking-wider text-muted-foreground">Accounting</h3>
              <p className="text-sm text-muted-foreground">Journal entry posted automatically.</p>
              <p className="mt-1 text-sm font-medium">Entry ID: {invoice.journalEntryId}</p>
            </CardContent>
          </Card>
        )}
      </div>

      {/* ── Payment history ── */}
      <Card>
        <CardContent className="p-6">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Payment History</h3>
            <span className="text-sm text-muted-foreground">
              {invoicePayments.length} payment{invoicePayments.length === 1 ? "" : "s"}
            </span>
          </div>
          {invoicePayments.length === 0 ? (
            <p className="text-sm text-muted-foreground">No payments recorded.</p>
          ) : (
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2.5 text-left font-medium">Date</th>
                    <th className="px-4 py-2.5 text-left font-medium">Receipt #</th>
                    <th className="px-4 py-2.5 text-right font-medium">Amount</th>
                    <th className="px-4 py-2.5 text-left font-medium">Payment Method</th>
                    <th className="px-4 py-2.5 text-left font-medium">Reference</th>
                    <th className="px-4 py-2.5 text-left font-medium">Recorded By</th>
                    <th className="px-4 py-2.5 text-right font-medium">Remaining Balance</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {paymentRows.map(({ payment: p, remainingAfter }) => (
                    <tr key={p.id} className="hover:bg-muted/30">
                      <td className="whitespace-nowrap px-4 py-2.5">{format(new Date(p.paymentDate), "dd/MM/yyyy")}</td>
                      <td className="px-4 py-2.5">
                        <Link to={`/payments/${p.id}`} className="font-medium text-primary hover:underline">
                          {p.receiptNumber}
                        </Link>
                      </td>
                      <td className="px-4 py-2.5 text-right font-semibold tabular-nums text-emerald-600">
                        {formatCurrency(p.amount)}
                      </td>
                      <td className="px-4 py-2.5">{p.method}</td>
                      <td className="px-4 py-2.5 text-muted-foreground">{p.reference || "—"}</td>
                      <td className="px-4 py-2.5 text-muted-foreground">{p.recordedBy || "—"}</td>
                      <td
                        className={`px-4 py-2.5 text-right font-medium tabular-nums ${
                          remainingAfter > 0.0005 ? "text-red-600" : "text-emerald-600"
                        }`}
                      >
                        {formatCurrency(remainingAfter)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Edit Dialog */}
      <Dialog open={editDialog} onOpenChange={setEditDialog}>
        <DialogContent className="max-h-[90vh] max-w-4xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit Invoice</DialogTitle>
            <DialogDescription>Update the invoice details below.</DialogDescription>
          </DialogHeader>
          <InvoiceForm initialData={invoice} onClose={() => setEditDialog(false)} />
        </DialogContent>
      </Dialog>

      {/* Payment Dialog */}
      <Dialog open={paymentDialog} onOpenChange={setPaymentDialog}>
        <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Record Payment</DialogTitle>
            <DialogDescription>Record a payment against this invoice.</DialogDescription>
          </DialogHeader>
          <PaymentForm preselectedInvoiceId={invoice.id} onClose={() => setPaymentDialog(false)} />
        </DialogContent>
      </Dialog>

      {/* PDF Preview Dialog */}
      <Dialog open={previewDialog} onOpenChange={setPreviewDialog}>
        <DialogContent className="max-h-[95vh] max-w-4xl overflow-hidden">
          <DialogHeader>
            <DialogTitle>Invoice Preview — {invoice.invoiceNumber}</DialogTitle>
            <DialogDescription>Preview of the generated PDF invoice.</DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2 pb-2">
            <Button size="sm" variant="outline" onClick={handleDownload}>
              <Download className="mr-1 h-3.5 w-3.5" /> Download
            </Button>
            <Button size="sm" variant="outline" onClick={handleSend} disabled={sending || isCancelled}>
              {sending ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Send className="mr-1 h-3.5 w-3.5" />} Send
            </Button>
          </div>
          {previewUrl && (
            <iframe src={previewUrl} className="h-[70vh] w-full rounded-lg border" title="Invoice PDF" />
          )}
        </DialogContent>
      </Dialog>

      {/* Undo Payment confirmation */}
      <AlertDialog open={undoDialog} onOpenChange={setUndoDialog}>
        <AlertDialogContent className="max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-amber-600">
              <RotateCcw className="h-5 w-5" /> Undo Payment
            </AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to undo this payment? The invoice will be returned to its previous
              unpaid/overdue status.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleUndoPayment} className="bg-amber-600 text-white hover:bg-amber-700">
              Undo Payment
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
