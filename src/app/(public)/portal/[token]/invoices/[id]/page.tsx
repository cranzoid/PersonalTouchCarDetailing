import Link from "next/link";
import { notFound } from "next/navigation";
import { and, asc, desc, eq, ne } from "drizzle-orm";
import { Container } from "@/components/ui";
import { db, schema } from "@/db";
import { summarizePayments } from "@/lib/invoices";
import { formatCents } from "@/lib/money";
import { portalOwnsCustomer, resolveCustomerPortalToken } from "@/lib/portal";
import { getSettings } from "@/lib/settings";

export const metadata = { title: "Invoice Details" };
export const dynamic = "force-dynamic";

export default async function PortalInvoiceDetailPage({ params }: { params: Promise<{ token: string; id: string }> }) {
  const { token, id } = await params;
  const resolved = await resolveCustomerPortalToken(token);
  if (!resolved) notFound();
  const [invoice] = await db().select().from(schema.invoices).where(and(
    eq(schema.invoices.id, id),
    eq(schema.invoices.customerId, resolved.customer.id),
    ne(schema.invoices.status, "draft"),
  )).limit(1);
  if (!invoice || !portalOwnsCustomer(resolved.customer.id, invoice.customerId)) notFound();
  const [lines, payments, settings] = await Promise.all([
    db().select().from(schema.invoiceLineItems).where(eq(schema.invoiceLineItems.invoiceId, invoice.id)).orderBy(asc(schema.invoiceLineItems.sort)),
    db().select().from(schema.payments).where(eq(schema.payments.invoiceId, invoice.id)).orderBy(desc(schema.payments.createdAt)),
    getSettings(),
  ]);
  const summary = summarizePayments(invoice.totalCents, invoice.depositAppliedCents, payments);

  return (
    <Container className="max-w-2xl py-10 sm:py-14">
      <Link href={`/portal/${token}`} className="inline-flex min-h-11 items-center text-sm text-accent-300 underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-400">← Customer portal</Link>
      <header className="mt-4 rounded-[2rem] border border-accent-500/25 bg-gradient-to-br from-[#0B2A4A] to-ink-950 p-6 shadow-2xl shadow-black/20 sm:p-8">
      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-accent-300">{settings.businessName}</p>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-3xl font-bold text-white">Invoice INV-{invoice.number}</h1>
        <span className="rounded-full border border-accent-500/30 bg-ink-950/35 px-3 py-1.5 text-xs capitalize text-ink-200">{invoice.status.replaceAll("_", " ")}</span>
      </div>
      {invoice.dueAt && <p className="mt-2 text-sm text-ink-500">Due {invoice.dueAt.toLocaleDateString("en-CA", { month: "long", day: "numeric", year: "numeric" })}</p>}
      </header>
      <div className="mt-6 overflow-x-auto rounded-2xl border border-ink-700 bg-ink-900/60 p-4 shadow-xl shadow-black/10 sm:p-6">
        <table className="min-w-[30rem] w-full text-left text-sm"><caption className="sr-only">Invoice line items, payments, and balance</caption><tbody>
          {lines.map((line) => <tr key={line.id} className="border-b border-ink-800"><td className="py-3 pr-4 text-ink-200">{line.description}{line.quantity > 1 ? ` × ${line.quantity}` : ""}</td><td className="py-3 text-right text-ink-200">{formatCents(line.quantity * line.unitPriceCents, settings.currency)}</td></tr>)}
          <MoneyRow label="Subtotal" value={invoice.subtotalCents} currency={settings.currency} />
          {invoice.discountCents > 0 && <MoneyRow label="Discount" value={-invoice.discountCents} currency={settings.currency} />}
          <MoneyRow label={`${invoice.taxLabel} (${(invoice.taxRateBp / 100).toFixed(2)}%)`} value={invoice.taxCents} currency={settings.currency} />
          <tr><td className="py-3 text-right font-semibold text-white">Total</td><td className="py-3 text-right font-semibold text-accent-300">{formatCents(invoice.totalCents, settings.currency)}</td></tr>
          {(invoice.depositAppliedCents + summary.paidCents) > 0 && <MoneyRow label="Paid" value={-(invoice.depositAppliedCents + summary.paidCents)} currency={settings.currency} />}
          {summary.refundedCents > 0 && <MoneyRow label="Refunded" value={summary.refundedCents} currency={settings.currency} />}
          <tr><td className="py-3 text-right font-semibold text-white">Balance due</td><td className="py-3 text-right font-semibold text-accent-300">{formatCents(summary.balanceCents, settings.currency)}</td></tr>
        </tbody></table>
      </div>
      <p className="mt-5 text-sm text-ink-400">This dashboard view is read-only. Use the secure payment link sent with the invoice to pay online, or contact us for help.</p>
    </Container>
  );
}

function MoneyRow({ label, value, currency }: { label: string; value: number; currency: string }) {
  return <tr><td className="py-2 text-right text-ink-400">{label}</td><td className="py-2 text-right text-ink-200">{value < 0 ? "−" : value > 0 && label === "Refunded" ? "+" : ""}{formatCents(Math.abs(value), currency)}</td></tr>;
}
