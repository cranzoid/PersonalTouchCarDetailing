import { eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import { invoiceIssuedInWindow, SALES_INVOICE_STATUSES } from "@/lib/books";
import { summarizePayments } from "@/lib/invoices";

/**
 * Which invoices have been paid and which have not, for the reports screen and
 * the invoices export.
 *
 * Every figure here is a full invoice total, with tax and tips, because that is
 * what a customer owes. Net sales is before tax, so the two are not the same
 * number and must not be subtracted from one another.
 */

export type InvoicePaymentState = "paid" | "part_paid" | "unpaid" | "refunded" | "cancelled";

export const INVOICE_PAYMENT_LABELS: Record<InvoicePaymentState, string> = {
  paid: "Paid",
  part_paid: "Part paid",
  unpaid: "Unpaid",
  refunded: "Refunded",
  cancelled: "Cancelled",
};

type InvoicePayments = { kind: string; status: string; amountCents: number };

export type InvoiceSettlement = {
  paymentState: InvoicePaymentState;
  /** Money held against the invoice, deposits included, refunds taken off. */
  paidCents: number;
  /** What the customer still owes. Nothing on a cancelled or refunded invoice. */
  balanceCents: number;
};

/** Uses summarizePayments, so it agrees with the invoice page and the PDF. */
export function invoiceSettlement(
  invoice: { status: string; totalCents: number; depositAppliedCents: number },
  payments: InvoicePayments[],
): InvoiceSettlement {
  const { netPaidCents, balanceCents } = summarizePayments(
    invoice.totalCents,
    invoice.depositAppliedCents,
    payments,
  );
  if (invoice.status === "cancelled" || invoice.status === "refunded") {
    return { paymentState: invoice.status, paidCents: netPaidCents, balanceCents: 0 };
  }
  if (balanceCents <= 0) return { paymentState: "paid", paidCents: netPaidCents, balanceCents: 0 };
  return {
    paymentState: netPaidCents > 0 ? "part_paid" : "unpaid",
    paidCents: netPaidCents,
    balanceCents,
  };
}

export type SalesInvoiceRow = InvoiceSettlement & {
  id: string;
  number: number;
  date: Date;
  customerName: string;
  status: string;
  totalCents: number;
};

export type PaidUnpaidSummary = {
  /** Invoice totals, unpaid first and then newest first. */
  rows: SalesInvoiceRow[];
  invoicedCents: number;
  paidCents: number;
  unpaidCents: number;
  refundedCents: number;
  paidInvoiceCount: number;
  unpaidInvoiceCount: number;
};

const STATE_ORDER: Record<InvoicePaymentState, number> = {
  unpaid: 0,
  part_paid: 1,
  paid: 2,
  refunded: 3,
  cancelled: 4,
};

/**
 * Paid + unpaid + refunded always adds up to invoiced. An overpaid invoice
 * counts its total as paid rather than the larger amount taken, because the
 * extra is a refund owed, not a sale; the attention queue already flags it.
 */
export function summarizePaidUnpaid(rows: readonly SalesInvoiceRow[]): PaidUnpaidSummary {
  const summary: PaidUnpaidSummary = {
    rows: [...rows].sort(
      (a, b) =>
        STATE_ORDER[a.paymentState] - STATE_ORDER[b.paymentState] ||
        b.date.getTime() - a.date.getTime() ||
        b.number - a.number,
    ),
    invoicedCents: 0,
    paidCents: 0,
    unpaidCents: 0,
    refundedCents: 0,
    paidInvoiceCount: 0,
    unpaidInvoiceCount: 0,
  };
  for (const row of rows) {
    summary.invoicedCents += row.totalCents;
    if (row.paymentState === "refunded") {
      summary.refundedCents += row.totalCents;
      continue;
    }
    summary.paidCents += row.totalCents - row.balanceCents;
    summary.unpaidCents += row.balanceCents;
    if (row.paymentState === "paid") summary.paidInvoiceCount += 1;
    else summary.unpaidInvoiceCount += 1;
  }
  return summary;
}

/** The invoices behind Net sales for a date range, with what each has had paid. */
export async function getPaidUnpaid(start: Date, end: Date): Promise<PaidUnpaidSummary> {
  const invoices = (
    await db()
      .select({
        id: schema.invoices.id,
        number: schema.invoices.number,
        status: schema.invoices.status,
        invoiceDate: schema.invoices.invoiceDate,
        createdAt: schema.invoices.createdAt,
        totalCents: schema.invoices.totalCents,
        depositAppliedCents: schema.invoices.depositAppliedCents,
        firstName: schema.customers.firstName,
        lastName: schema.customers.lastName,
        companyName: schema.customers.companyName,
      })
      .from(schema.invoices)
      .leftJoin(schema.customers, eq(schema.invoices.customerId, schema.customers.id))
      .where(invoiceIssuedInWindow(start, end))
  ).filter((invoice) => SALES_INVOICE_STATUSES.has(invoice.status));

  const payments = invoices.length
    ? await db()
        .select({
          invoiceId: schema.payments.invoiceId,
          kind: schema.payments.kind,
          status: schema.payments.status,
          amountCents: schema.payments.amountCents,
        })
        .from(schema.payments)
        .where(inArray(schema.payments.invoiceId, invoices.map((invoice) => invoice.id)))
    : [];
  const paymentsByInvoice = groupPaymentsByInvoice(payments);

  return summarizePaidUnpaid(
    invoices.map((invoice) => ({
      ...invoiceSettlement(invoice, paymentsByInvoice.get(invoice.id) ?? []),
      id: invoice.id,
      number: invoice.number,
      date: invoice.invoiceDate ?? invoice.createdAt,
      customerName:
        invoice.companyName || `${invoice.firstName ?? ""} ${invoice.lastName ?? ""}`.trim(),
      status: invoice.status,
      totalCents: invoice.totalCents,
    })),
  );
}

export function groupPaymentsByInvoice<T extends { invoiceId: string | null }>(
  payments: readonly T[],
): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const payment of payments) {
    if (!payment.invoiceId) continue;
    const current = grouped.get(payment.invoiceId);
    if (current) current.push(payment);
    else grouped.set(payment.invoiceId, [payment]);
  }
  return grouped;
}
