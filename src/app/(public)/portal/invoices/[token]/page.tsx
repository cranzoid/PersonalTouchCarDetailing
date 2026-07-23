import { notFound, redirect } from "next/navigation";
import { asc, desc, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { Container } from "@/components/ui";
import { formatCents } from "@/lib/money";
import { getSettings } from "@/lib/settings";
import { resolveInvoiceToken, sendInvoiceReceipt, summarizePayments, syncOverdueInvoices } from "@/lib/invoices";
import { finalizeSucceededPayment } from "@/lib/payments";
import { PayButton } from "./pay-button";

export const metadata = { title: "Your Invoice" };
export const dynamic = "force-dynamic";

/**
 * Customer invoice view + pay, authenticated only by the single-purpose
 * hashed access token in the URL — mirrors the estimate portal. Unlike the
 * estimate token, this one is not single-use: the customer may return to pay
 * a balance or just look at a receipt.
 */
export default async function PortalInvoicePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ fake_session?: string; payment_id?: string }>;
}) {
  const { token } = await params;
  await syncOverdueInvoices();
  const resolved = await resolveInvoiceToken(token);
  if (!resolved) notFound();
  const { invoice } = resolved;

  // Dev-only: the fake payment provider redirects here instead of firing a
  // real webhook. Finalize only if the session ref matches a pending payment
  // on THIS invoice using the fake provider — never trusts the query alone.
  const { fake_session: fakeSession, payment_id: paymentId } = await searchParams;
  if (fakeSession && paymentId && process.env.NODE_ENV !== "production") {
    const [payment] = await db().select().from(schema.payments).where(eq(schema.payments.id, paymentId)).limit(1);
    if (
      payment &&
      payment.invoiceId === invoice.id &&
      payment.provider === "fake" &&
      payment.providerRef === fakeSession
    ) {
      const result = await db().transaction((tx) =>
        finalizeSucceededPayment(tx, {
          paymentId: payment.id,
          provider: "fake",
          providerRef: fakeSession,
          invoiceId: invoice.id,
        }),
      );
      if (result && !result.alreadyProcessed) {
        await sendInvoiceReceipt(result.invoiceId, result.amountCents);
      }
    }
    redirect(`/portal/invoices/${token}`);
  }

  const settings = await getSettings();
  const customer = (
    await db().select().from(schema.customers).where(eq(schema.customers.id, invoice.customerId)).limit(1)
  )[0];
  const vehicle = invoice.vehicleId
    ? (await db().select().from(schema.vehicles).where(eq(schema.vehicles.id, invoice.vehicleId)).limit(1))[0]
    : undefined;
  const lines = await db()
    .select()
    .from(schema.invoiceLineItems)
    .where(eq(schema.invoiceLineItems.invoiceId, invoice.id))
    .orderBy(asc(schema.invoiceLineItems.sort));
  const payments = await db()
    .select()
    .from(schema.payments)
    .where(eq(schema.payments.invoiceId, invoice.id))
    .orderBy(desc(schema.payments.createdAt));

  const summary = summarizePayments(invoice.totalCents, invoice.depositAppliedCents, payments);
  const cancelled = invoice.status === "cancelled";
  const refunded = invoice.status === "refunded";
  const paidInFull = invoice.status === "paid" || (invoice.status === "refunded" && summary.balanceCents <= 0);

  return (
    <Container className="max-w-2xl py-10 sm:py-16">
      <header className="rounded-[2rem] border border-accent-500/25 bg-gradient-to-br from-[#0B2A4A] to-ink-950 p-6 shadow-2xl shadow-black/20 sm:p-8">
      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-accent-300">{settings.businessName}</p>
      <h1 className="mt-3 text-3xl font-bold text-white sm:text-4xl">Invoice INV-{invoice.number}</h1>
      <p className="mt-2 text-sm text-ink-400">
        Prepared for {customer?.firstName} {customer?.lastName}
        {vehicle && <> — {[vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(" ")}</>}
      </p>
      <a
        href={`/portal/invoices/${token}/pdf`}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-3 inline-flex min-h-11 items-center text-sm font-medium text-accent-300 underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-400"
      >
        Download PDF
      </a>
      {invoice.dueAt && !cancelled && (
        <p className="mt-1 text-sm text-ink-500">
          Due {invoice.dueAt.toLocaleDateString("en-CA", { month: "long", day: "numeric", year: "numeric" })}
        </p>
      )}
      </header>

      <div className="mt-6 overflow-x-auto rounded-2xl border border-ink-700 bg-ink-900/60 p-4 shadow-xl shadow-black/10 sm:p-6">
        <table className="w-full min-w-[30rem] text-left text-sm">
          <caption className="sr-only">Invoice line items, payments, and balance due</caption>
          <tbody>
            {lines.map((l) => (
              <tr key={l.id} className="border-b border-ink-800/60">
                <td className="py-2 pr-4 text-ink-200">
                  {l.description}
                  {l.quantity > 1 && <span className="text-ink-500"> × {l.quantity}</span>}
                </td>
                <td className="py-2 text-right text-ink-200">
                  {formatCents(l.quantity * l.unitPriceCents, settings.currency)}
                </td>
              </tr>
            ))}
            <tr><td className="py-2 pr-4 text-right text-ink-400">Subtotal</td>
              <td className="py-2 text-right text-ink-200">{formatCents(invoice.subtotalCents, settings.currency)}</td></tr>
            {invoice.discountCents > 0 && (
              <tr><td className="py-2 pr-4 text-right text-ink-400">Discount</td>
                <td className="py-2 text-right text-ink-200">−{formatCents(invoice.discountCents, settings.currency)}</td></tr>
            )}
            <tr><td className="py-2 pr-4 text-right text-ink-400">{invoice.taxLabel} ({(invoice.taxRateBp / 100).toFixed(2)}%)</td>
              <td className="py-2 text-right text-ink-200">{formatCents(invoice.taxCents, settings.currency)}</td></tr>
            <tr><td className="py-3 pr-4 text-right font-semibold text-white">Total</td>
              <td className="py-3 text-right font-semibold text-accent-300">{formatCents(invoice.totalCents, settings.currency)}</td></tr>
            {(invoice.depositAppliedCents > 0 || summary.paidCents > 0) && (
              <tr><td className="py-2 pr-4 text-right text-ink-400">Paid</td>
                <td className="py-2 text-right text-ink-200">
                  −{formatCents(invoice.depositAppliedCents + summary.paidCents, settings.currency)}
                </td></tr>
            )}
            {summary.refundedCents > 0 && (
              <tr><td className="py-2 pr-4 text-right text-ink-400">Refunded</td>
                <td className="py-2 text-right text-ink-200">+{formatCents(summary.refundedCents, settings.currency)}</td></tr>
            )}
            <tr><td className="py-3 pr-4 text-right font-semibold text-white">Balance due</td>
              <td className="py-3 text-right font-semibold text-accent-300">{formatCents(summary.balanceCents, settings.currency)}</td></tr>
          </tbody>
        </table>
      </div>

      {cancelled ? (
        <div role="status" className="mt-6 rounded-2xl border border-ink-700 bg-ink-900/60 p-6 text-ink-300">
          <p>This invoice was cancelled. Contact us at {settings.phone} if you have questions.</p>
        </div>
      ) : refunded ? (
        <div role="status" className="mt-6 rounded-2xl border border-ink-700 bg-ink-900/60 p-6 text-ink-300">
          <p>This invoice has been refunded and is no longer payable. Contact us at {settings.phone} if you have questions.</p>
        </div>
      ) : summary.balanceCents <= 0 ? (
        <div role="status" className="mt-6 rounded-2xl border border-emerald-500/25 bg-emerald-950/20 p-6">
          <p className="text-emerald-300">
            {paidInFull ? "Paid in full — thank you!" : "This invoice is settled."}
          </p>
        </div>
      ) : (
        <div className="mt-6 rounded-[2rem] border border-accent-500/25 bg-gradient-to-br from-[#0B2A4A]/80 to-ink-950 p-6 shadow-xl shadow-black/15">
          <PayButton token={token} />
          <p className="mt-3 text-center text-xs text-ink-500">
            Secure checkout. You can also pay in person by cash, e-transfer or card.
          </p>
        </div>
      )}

      <p className="mt-10 text-xs text-ink-500">
        Questions? Call {settings.phone} or email {settings.email}. This link is personal to you —
        please don&apos;t share it.
      </p>
    </Container>
  );
}
