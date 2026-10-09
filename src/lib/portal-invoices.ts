import { and, desc, inArray, ne } from "drizzle-orm";
import { db, schema } from "@/db";
import { summarizePayments } from "@/lib/invoices";
import { formatCents } from "@/lib/money";
import { onlinePayBlocker } from "@/lib/payments";
import type { BusinessSettings } from "@/lib/settings";
import { formatInZone } from "@/lib/tz";

/** One invoice as a customer sees it in their workspace or account. */
export type PortalInvoice = {
  id: string;
  number: number;
  dateLabel: string;
  dueLabel: string | null;
  status: string;
  totalLabel: string;
  balanceCents: number;
  balanceLabel: string;
  /** Why it cannot be ticked for card payment, or null if it can. */
  blocker: string | null;
  /** "cheque" | "in_person" when the customer has already told us. */
  payIntent: string | null;
};

/**
 * Every issued invoice for these customer records, newest first, with its
 * balance read from the ledger. Drafts are the shop's own working copies and
 * are never shown.
 */
export async function loadPortalInvoices(customerIds: string[], settings: BusinessSettings): Promise<PortalInvoice[]> {
  if (customerIds.length === 0) return [];
  const invoices = await db()
    .select()
    .from(schema.invoices)
    .where(and(inArray(schema.invoices.customerId, customerIds), ne(schema.invoices.status, "draft")))
    .orderBy(desc(schema.invoices.createdAt))
    .limit(200);
  if (invoices.length === 0) return [];
  const payments = await db()
    .select()
    .from(schema.payments)
    .where(inArray(schema.payments.invoiceId, invoices.map((i) => i.id)));
  const byInvoice = new Map<string, typeof payments>();
  for (const payment of payments) {
    if (!payment.invoiceId) continue;
    byInvoice.set(payment.invoiceId, [...(byInvoice.get(payment.invoiceId) ?? []), payment]);
  }
  const day = (d: Date) => formatInZone(d, settings.timezone, { month: "short", day: "numeric", year: "numeric" });
  return invoices
    .filter((invoice) => invoice.status !== "cancelled")
    .map((invoice) => {
      const { balanceCents } = summarizePayments(invoice.totalCents, invoice.depositAppliedCents, byInvoice.get(invoice.id) ?? []);
      return {
        id: invoice.id,
        number: invoice.number,
        dateLabel: day(invoice.invoiceDate ?? invoice.createdAt),
        dueLabel: invoice.dueAt && balanceCents > 0 ? day(invoice.dueAt) : null,
        status: invoice.status,
        totalLabel: formatCents(invoice.totalCents, settings.currency),
        balanceCents,
        balanceLabel: formatCents(balanceCents, settings.currency),
        blocker: onlinePayBlocker(invoice, balanceCents),
        payIntent: invoice.customerPayIntent,
      };
    });
}
