import Link from "next/link";
import { asc, desc, eq } from "drizzle-orm";
import { Container } from "@/components/ui";
import { db, schema } from "@/db";
import { summarizePayments } from "@/lib/invoices";
import { formatCents } from "@/lib/money";
import type { BusinessSettings } from "@/lib/settings";

/**
 * One invoice as the customer sees it — shared by the account workspace link
 * and the signed-in account, so both read the same lines, tip and balance.
 * The caller has already checked that the invoice belongs to the viewer.
 */
export async function InvoiceDetail({
  invoice,
  settings,
  backHref,
  backLabel,
  pdfHref,
  footer,
}: {
  invoice: typeof schema.invoices.$inferSelect;
  settings: BusinessSettings;
  backHref: string;
  backLabel: string;
  pdfHref: string;
  footer: string;
}) {
  const [lines, payments] = await Promise.all([
    db().select().from(schema.invoiceLineItems).where(eq(schema.invoiceLineItems.invoiceId, invoice.id)).orderBy(asc(schema.invoiceLineItems.sort)),
    db().select().from(schema.payments).where(eq(schema.payments.invoiceId, invoice.id)).orderBy(desc(schema.payments.createdAt)),
  ]);
  const summary = summarizePayments(invoice.totalCents, invoice.depositAppliedCents, payments);
  const money = (cents: number) => formatCents(cents, settings.currency);
  return (
    <Container className="max-w-2xl py-10 sm:py-14">
      <Link href={backHref} className="inline-flex min-h-11 items-center text-sm text-accent-300 underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-400">← {backLabel}</Link>
      <header className="mt-4 rounded-[2rem] border border-accent-500/25 bg-gradient-to-br from-[#0B2A4A] to-ink-950 p-6 shadow-2xl shadow-black/20 sm:p-8">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-accent-300">{settings.businessName}</p>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-3xl font-bold text-white">Invoice INV-{invoice.number}</h1>
          <span className="rounded-full border border-accent-500/30 bg-ink-950/35 px-3 py-1.5 text-xs capitalize text-ink-200">{invoice.status.replaceAll("_", " ")}</span>
        </div>
        {invoice.dueAt && summary.balanceCents > 0 && (
          <p className="mt-2 text-sm text-ink-500">Due {invoice.dueAt.toLocaleDateString("en-CA", { month: "long", day: "numeric", year: "numeric" })}</p>
        )}
        <a href={pdfHref} target="_blank" rel="noopener noreferrer" className="mt-3 inline-flex min-h-11 items-center text-sm font-medium text-accent-300 underline-offset-4 hover:underline">Download PDF</a>
      </header>
      <div className="mt-6 overflow-x-auto rounded-2xl border border-ink-700 bg-ink-900/60 p-4 shadow-xl shadow-black/10 sm:p-6">
        <table className="w-full min-w-[30rem] text-left text-sm">
          <caption className="sr-only">Invoice line items, payments, and balance</caption>
          <tbody>
            {lines.map((line) => (
              <tr key={line.id} className="border-b border-ink-800">
                <td className="py-3 pr-4 text-ink-200">{line.description}{line.quantity > 1 ? ` × ${line.quantity}` : ""}</td>
                <td className="py-3 text-right text-ink-200">{money(line.quantity * line.unitPriceCents)}</td>
              </tr>
            ))}
            <Row label="Subtotal" value={money(invoice.subtotalCents)} />
            {invoice.discountCents > 0 && <Row label={invoice.discountReason ?? "Discount"} value={`−${money(invoice.discountCents)}`} />}
            <Row label={`${invoice.taxLabel} (${(invoice.taxRateBp / 100).toFixed(2)}%)`} value={money(invoice.taxCents)} />
            {invoice.tipCents > 0 && <Row label="Tip" value={money(invoice.tipCents)} />}
            <Row label="Total" value={money(invoice.totalCents)} strong />
            {invoice.depositAppliedCents + summary.paidCents > 0 && <Row label="Paid" value={`−${money(invoice.depositAppliedCents + summary.paidCents)}`} />}
            {summary.refundedCents > 0 && <Row label="Refunded" value={`+${money(summary.refundedCents)}`} />}
            <Row label="Balance due" value={money(summary.balanceCents)} strong />
          </tbody>
        </table>
      </div>
      <p className="mt-5 text-sm text-ink-400">{footer}</p>
    </Container>
  );
}

function Row({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <tr>
      <td className={`py-2 pr-4 text-right ${strong ? "font-semibold text-white" : "text-ink-400"}`}>{label}</td>
      <td className={`py-2 text-right ${strong ? "font-semibold text-accent-300" : "text-ink-200"}`}>{value}</td>
    </tr>
  );
}
