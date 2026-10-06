// src/components/receipts/PaymentReceiptDialog.tsx
// View / Download / Print / Send payment receipt. The preview mirrors the
// Namlity General Trading receipt template; the PDF (lib/receiptPdf.ts) is the
// print-ready version of the same layout. Read-only — sending records only the
// existing receiptEmailSent flag on the payment after a confirmed send.

import { useMemo, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useData } from "@/context/DataContext";
import {
  RECEIPT_COMPANY,
  resolveReceiptInfo,
  downloadReceiptPdf,
  printReceiptPdf,
  getReceiptPdfBase64,
  receiptFileName,
  type ReceiptInfo,
} from "@/lib/receiptPdf";
import { sendDocumentWhatsApp } from "@/lib/whatsappClient";
import { sendEmailWithAttachment } from "@/lib/emailClient";
import { Download, Printer, Send, MessageCircle, Mail, Loader2, CheckCircle2, XCircle } from "lucide-react";
import type { Payment } from "@/types";

interface PaymentReceiptDialogProps {
  payment: Payment;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function esc(value: string): string {
  return (value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** HTML replica of the PDF receipt layout for the in-app preview. */
function ReceiptPreview({ info }: { info: ReceiptInfo }) {
  const fields: [string, string][] = [
    ["Received from", info.tenantName],
    ["Amount BD", info.amountLabel],
    ["By Cash / Cheque No.", info.methodLine],
    ["In settlement of", info.settlement],
  ];

  return (
    <div className="receipt-sheet mx-auto w-full max-w-3xl border-2 border-black bg-white p-4 font-serif text-black">
      <div className="flex items-start justify-between gap-4">
        <div className="w-1/2 text-center">
          <p className="text-sm font-bold uppercase tracking-wide">{RECEIPT_COMPANY.name}</p>
          <p className="text-xs">{RECEIPT_COMPANY.road}</p>
          <p className="text-xs font-bold uppercase">{RECEIPT_COMPANY.tagline}</p>
          <p className="mt-2 text-[11px] leading-4">
            {RECEIPT_COMPANY.tel}
            <br />
            {RECEIPT_COMPANY.email}
            <br />
            {RECEIPT_COMPANY.poBox}
            <br />
            {RECEIPT_COMPANY.city}
            <br />
            {RECEIPT_COMPANY.country}
          </p>
        </div>
        <div className="w-1/2 space-y-1 text-right text-xs">
          <p>Date : {esc(info.dateLabel)}</p>
          <p>No. : {esc(info.receiptNumber)}</p>
        </div>
      </div>

      <div className="mt-3 border-t border-black" />
      <div className="mt-1 border-t border-black" />
      <p className="my-1.5 text-center text-xl font-bold tracking-[0.3em]">RECEIPT</p>
      <div className="mb-3 border-t border-black" />

      <div className="space-y-3 px-2">
        {fields.map(([label, value]) => (
          <div key={label} className="flex items-end gap-2 text-sm">
            <span className="whitespace-nowrap">{esc(label)} :</span>
            <span className="whitespace-pre-wrap font-semibold">{esc(value)}</span>
            <span className="mb-[3px] min-w-6 flex-1 border-b border-dotted border-black" />
          </div>
        ))}
        {(info.buildingLabel || info.unitLabel || info.contractLabel) && (
          <p className="pl-1 text-[11px]">
            {[
              info.buildingLabel && `Building: ${info.buildingLabel}`,
              info.unitLabel && `Unit: ${info.unitLabel}`,
              info.contractLabel && `Contract: ${info.contractLabel}`,
            ]
              .filter(Boolean)
              .join("      ")}
          </p>
        )}
      </div>

      <div className="mt-8 px-2 text-sm">
        <div className="flex items-end gap-2">
          <span>Signature</span>
          <span className="mb-[3px] w-52 border-b border-dotted border-black" />
        </div>
        <div className="mt-3 flex items-end gap-2">
          <span>Amount</span>
          <span className="ml-4">BD.</span>
          <span className="font-semibold">{esc(info.bdPart)}</span>
          <span className="mb-[3px] w-16 border-b border-dotted border-black" />
          <span className="ml-2">Fils</span>
          <span className="font-semibold">{esc(info.filsPart)}</span>
          <span className="mb-[3px] w-16 border-b border-dotted border-black" />
        </div>
      </div>
    </div>
  );
}

export default function PaymentReceiptDialog({ payment, open, onOpenChange }: PaymentReceiptDialogProps) {
  const { invoices, leases, units, buildings, payments, getTenantById, updatePayment } = useData();
  const [sendPanelOpen, setSendPanelOpen] = useState(false);
  const [sending, setSending] = useState<"whatsapp" | "email" | null>(null);
  const [sendResult, setSendResult] = useState<{ ok: boolean; message: string } | null>(null);

  const info = useMemo(
    () =>
      resolveReceiptInfo(payment, {
        invoices,
        leases,
        units,
        buildings,
        getTenantById,
        payments,
      }),
    [payment, invoices, leases, units, buildings, getTenantById],
  );

  const buildMessage = (i: ReceiptInfo) =>
    `Dear ${i.tenantName},\n\nPlease find attached your payment receipt.\n\nReceipt No: ${i.receiptNumber}\nAmount: BHD ${i.amountLabel}\nDate: ${i.dateLabel}\n\nThank you.`;

  const handleWhatsApp = async () => {
    if (!info.tenantPhone) {
      setSendResult({ ok: false, message: "Tenant has no phone number on record" });
      return;
    }
    setSending("whatsapp");
    setSendResult(null);
    try {
      const result = await sendDocumentWhatsApp({
        to: info.tenantPhone,
        body: buildMessage(info),
        fileName: receiptFileName(info),
        pdfBase64: getReceiptPdfBase64(info),
      });
      setSendResult({ ok: result.success, message: result.message });
      if (result.success) updatePayment(payment.id, { receiptEmailSent: true });
    } finally {
      setSending(null);
    }
  };

  const handleEmail = async () => {
    if (!info.tenantEmail) {
      setSendResult({ ok: false, message: "Tenant has no email address on record" });
      return;
    }
    setSending("email");
    setSendResult(null);
    try {
      const result = await sendEmailWithAttachment({
        to: info.tenantEmail,
        subject: `Payment Receipt — ${info.receiptNumber}`,
        body: buildMessage(info),
        fileName: receiptFileName(info),
        pdfBase64: getReceiptPdfBase64(info),
      });
      setSendResult({ ok: result.success, message: result.message });
      if (result.success) updatePayment(payment.id, { receiptEmailSent: true });
    } finally {
      setSending(null);
    }
  };

  const handlePrint = () => {
    const opened = printReceiptPdf(info);
    if (!opened) {
      // Pop-up blocked — fall back to the direct PDF download so the user
      // still gets a print-ready receipt.
      downloadReceiptPdf(info);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Payment Receipt — {payment.receiptNumber}</DialogTitle>
          <DialogDescription>
            Preview the receipt, download the PDF, print it, or send it to the tenant.
          </DialogDescription>
        </DialogHeader>

        <ReceiptPreview info={info} />

        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => downloadReceiptPdf(info)}>
            <Download className="mr-1.5 h-4 w-4" /> Download PDF
          </Button>
          <Button size="sm" variant="outline" onClick={handlePrint}>
            <Printer className="mr-1.5 h-4 w-4" /> Print
          </Button>
          <Button size="sm" variant="outline" onClick={() => setSendPanelOpen((v) => !v)}>
            <Send className="mr-1.5 h-4 w-4" /> Send to Tenant
          </Button>
        </div>

        {sendPanelOpen && (
          <div className="space-y-3 rounded-lg border bg-muted/40 p-4">
            <p className="text-xs text-muted-foreground">
              Uses the tenant record — {info.tenantPhone ? `📞 ${info.tenantPhone}` : "no phone on file"}
              {info.tenantEmail ? ` · ✉️ ${info.tenantEmail}` : " · no email on file"}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700" disabled={sending !== null} onClick={handleWhatsApp}>
                {sending === "whatsapp" ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <MessageCircle className="mr-1.5 h-4 w-4" />}
                Send by WhatsApp
              </Button>
              <Button size="sm" disabled={sending !== null} onClick={handleEmail}>
                {sending === "email" ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Mail className="mr-1.5 h-4 w-4" />}
                Send by Email
              </Button>
            </div>
            {sendResult && (
              <p className={`flex items-start gap-1.5 text-xs ${sendResult.ok ? "text-emerald-600" : "text-red-600"}`}>
                {sendResult.ok ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
                {sendResult.message}
              </p>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
