// Single source of truth for how much of an invoice is still owed.
// Every screen (invoice detail, list, dashboard, PDF, payment form) derives
// amounts from the ACTUAL payment records — never from a manually stored
// value — so adding, editing, deleting, or undoing a payment is reflected
// immediately and consistently.

import type { Invoice, Payment } from "@/types";

export type PaymentDerivedStatus = "Unpaid" | "Partially Paid" | "Paid" | "Overpaid";

export interface InvoiceSettlement {
  /** The invoice total as issued — never overwritten by payments. */
  originalAmount: number;
  /** SUM of all valid payment records for this invoice. */
  totalPaid: number;
  /** originalAmount - totalPaid (floored at 0). The live "Amount Due". */
  remainingBalance: number;
  /** How much was paid beyond the original amount, if any. */
  overpaidAmount: number;
  /** Status derived purely from the payment records. */
  paymentStatus: PaymentDerivedStatus;
}

const EPSILON = 0.0005;

/**
 * Compute the payment settlement of an invoice from its payment records:
 * totalPaid = SUM(payments), remaining = originalAmount - totalPaid, and the
 * derived status (Unpaid / Partially Paid / Paid / Overpaid).
 */
export function computeInvoiceSettlement(invoice: Invoice, payments: Payment[]): InvoiceSettlement {
  const totalPaid = payments
    .filter((p) => p.invoiceId === invoice.id)
    .reduce((s, p) => s + (p.amount || 0), 0);
  const originalAmount = invoice.amount || 0;
  const remainingBalance = Math.max(0, originalAmount - totalPaid);
  const overpaidAmount = Math.max(0, totalPaid - originalAmount);
  let paymentStatus: PaymentDerivedStatus;
  if (totalPaid <= EPSILON) {
    paymentStatus = "Unpaid";
  } else if (overpaidAmount > EPSILON) {
    paymentStatus = "Overpaid";
  } else if (remainingBalance > EPSILON) {
    paymentStatus = "Partially Paid";
  } else {
    paymentStatus = "Paid";
  }
  return { originalAmount, totalPaid, remainingBalance, overpaidAmount, paymentStatus };
}

/**
 * The invoice status to DISPLAY: payment-derived for the paid/unpaid family,
 * while workflow statuses (Draft, Overdue, Cancelled) are preserved as stored.
 */
export function displayInvoiceStatus(invoice: Invoice, settlement: InvoiceSettlement): Invoice["status"] {
  if (invoice.status === "Draft" || invoice.status === "Overdue" || invoice.status === "Cancelled") {
    return invoice.status;
  }
  switch (settlement.paymentStatus) {
    case "Unpaid":
      return "Sent";
    case "Partially Paid":
      return "Partial";
    case "Paid":
      return "Paid";
    case "Overpaid":
      return "Overpaid";
  }
}
