import Link from "next/link";
import { notFound } from "next/navigation";
import { and, asc, eq, ne } from "drizzle-orm";
import { Container } from "@/components/ui";
import { db, schema } from "@/db";
import { computeEstimateTotals } from "@/lib/estimates";
import { formatCents } from "@/lib/money";
import { portalOwnsCustomer, resolveCustomerPortalToken } from "@/lib/portal";
import { getSettings } from "@/lib/settings";

export const metadata = { title: "Estimate Details" };
export const dynamic = "force-dynamic";

export default async function PortalEstimateDetailPage({ params }: { params: Promise<{ token: string; id: string }> }) {
  const { token, id } = await params;
  const resolved = await resolveCustomerPortalToken(token);
  if (!resolved) notFound();
  const [estimate] = await db().select().from(schema.estimates).where(and(
    eq(schema.estimates.id, id),
    eq(schema.estimates.customerId, resolved.customer.id),
    ne(schema.estimates.status, "draft"),
  )).limit(1);
  if (!estimate || !portalOwnsCustomer(resolved.customer.id, estimate.customerId)) notFound();
  const lines = await db().select().from(schema.estimateLineItems)
    .where(eq(schema.estimateLineItems.estimateId, estimate.id)).orderBy(asc(schema.estimateLineItems.sort));
  const visibleLines = lines.filter((line) => !line.isOptional || line.isSelected);
  const totals = computeEstimateTotals(visibleLines, estimate.discountCents, estimate.taxRateBp);
  const settings = await getSettings();

  return (
    <Container className="max-w-2xl py-10 sm:py-14">
      <Link href={`/portal/${token}`} className="inline-flex min-h-11 items-center text-sm text-accent-300 underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-400">← Customer portal</Link>
      <header className="mt-4 rounded-[2rem] border border-accent-500/25 bg-gradient-to-br from-[#0B2A4A] to-ink-950 p-6 shadow-2xl shadow-black/20 sm:p-8">
      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-accent-300">{settings.businessName}</p>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-3xl font-bold text-white">Estimate EST-{estimate.number}</h1>
        <span className="rounded-full border border-accent-500/30 bg-ink-950/35 px-3 py-1.5 text-xs capitalize text-ink-200">{estimate.status.replaceAll("_", " ")}</span>
      </div>
      </header>
      {estimate.customerMessage && <p className="mt-5 whitespace-pre-wrap rounded-2xl border border-ink-700 bg-ink-900/60 p-5 text-sm leading-6 text-ink-300">{estimate.customerMessage}</p>}
      <div className="mt-6 overflow-x-auto rounded-2xl border border-ink-700 bg-ink-900/60 p-4 shadow-xl shadow-black/10 sm:p-6">
        <table className="min-w-[30rem] w-full text-left text-sm"><caption className="sr-only">Estimate line items and totals</caption><tbody>
          {visibleLines.map((line) => <tr key={line.id} className="border-b border-ink-800"><td className="py-3 pr-4 text-ink-200">{line.description}{line.quantity > 1 ? ` × ${line.quantity}` : ""}</td><td className="py-3 text-right text-ink-200">{formatCents(line.quantity * line.unitPriceCents, settings.currency)}</td></tr>)}
          <MoneyRow label="Subtotal" value={totals.subtotalCents} currency={settings.currency} />
          {totals.discountCents > 0 && <MoneyRow label="Discount" value={-totals.discountCents} currency={settings.currency} />}
          <MoneyRow label={`${estimate.taxLabel} (${(estimate.taxRateBp / 100).toFixed(2)}%)`} value={totals.taxCents} currency={settings.currency} />
          <tr><td className="py-3 text-right font-semibold text-white">Total</td><td className="py-3 text-right font-semibold text-accent-300">{formatCents(totals.totalCents, settings.currency)}</td></tr>
        </tbody></table>
      </div>
      <p className="mt-5 text-sm text-ink-400">This dashboard view is read-only. To approve, decline or request changes, use the approval link sent with the estimate or contact us.</p>
    </Container>
  );
}

function MoneyRow({ label, value, currency }: { label: string; value: number; currency: string }) {
  return <tr><td className="py-2 text-right text-ink-400">{label}</td><td className="py-2 text-right text-ink-200">{value < 0 ? "−" : ""}{formatCents(Math.abs(value), currency)}</td></tr>;
}
