import Link from "next/link";
import { notFound } from "next/navigation";
import { asc, desc, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { formatCents } from "@/lib/money";
import { QUOTED_PAYMENT_METHOD_LABELS, type QuotedPaymentMethod } from "@/lib/types";
import { PAYMENT_PROVIDER_LABELS } from "@/lib/payment-labels";
import { formatInZone } from "@/lib/tz";
import { getSettings } from "@/lib/settings";
import { summarizePayments, syncOverdueInvoices } from "@/lib/invoices";
import { StatusBadge } from "@/components/admin";
import { InvoiceActions } from "./invoice-actions";
import { requirePageStaff } from "@/lib/auth/page";
import { getRefundAvailability } from "@/lib/payments";

export const dynamic = "force-dynamic";

// Shared with the PDF renderer so both surfaces name a payment the same way.
const PROVIDER_LABELS = PAYMENT_PROVIDER_LABELS;

export default async function InvoiceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePageStaff("record_payments");
  const { id } = await params;
  await syncOverdueInvoices();
  const settings = await getSettings();

  const [invoice] = await db().select().from(schema.invoices).where(eq(schema.invoices.id, id)).limit(1);
  if (!invoice) notFound();

  const [customer] = await db().select().from(schema.customers).where(eq(schema.customers.id, invoice.customerId)).limit(1);
  const vehicle = invoice.vehicleId
    ? (await db().select().from(schema.vehicles).where(eq(schema.vehicles.id, invoice.vehicleId)).limit(1))[0]
    : undefined;
  const lines = await db()
    .select()
    .from(schema.invoiceLineItems)
    .where(eq(schema.invoiceLineItems.invoiceId, id))
    .orderBy(asc(schema.invoiceLineItems.sort));
  const payments = await db()
    .select()
    .from(schema.payments)
    .where(eq(schema.payments.invoiceId, id))
    .orderBy(desc(schema.payments.createdAt));
  const linkedJobs = await db()
    .select({ jobId: schema.invoiceJobs.jobId })
    .from(schema.invoiceJobs)
    .where(eq(schema.invoiceJobs.invoiceId, id));

  const summary = summarizePayments(invoice.totalCents, invoice.depositAppliedCents, payments);
  // The tax on an unpaid invoice is not settled until someone pays it: cash or
  // e-transfer strips it, card or cheque keeps it. Both balances are handed to
  // the payment form so the "pay in full" button tenders the right figure for
  // the method chosen. Mirrors resolvePaymentTax's rules exactly.
  const taxSettled =
    invoice.quotedPaymentMethod !== null ||
    invoice.taxExempt ||
    payments.some((p) => p.status === "succeeded");
  const untaxedSummary = taxSettled
    ? summary
    : summarizePayments(invoice.totalCents - invoice.taxCents, invoice.depositAppliedCents, payments);
  const refundAvailability = getRefundAvailability(payments, invoice.depositAppliedCents);

  // Deposit taken against the originating appointment that this invoice's total
  // cannot absorb — the signature of a downgrade at the counter. Derived here
  // rather than stored so it can never drift from the two figures it sits
  // between. The refund itself is issued from the appointment, not here: a
  // refund row against the invoice would push netPaidCents below the total and
  // reopen a settled invoice.
  const [depositSourceAppointment] = linkedJobs.length > 0
    ? await db()
        .select({
          id: schema.appointments.id,
          depositPaidCents: schema.appointments.depositPaidCents,
        })
        .from(schema.appointments)
        .innerJoin(schema.jobs, eq(schema.jobs.appointmentId, schema.appointments.id))
        .where(eq(schema.jobs.id, linkedJobs[0].jobId))
        .limit(1)
    : [];
  const depositRefundableCents = depositSourceAppointment
    ? Math.max(0, depositSourceAppointment.depositPaidCents - invoice.depositAppliedCents)
    : 0;

  return (
    <div className="max-w-3xl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="font-mono text-xs text-ink-500">{invoice.id}</p>
          <h1 className="text-2xl font-bold text-white">Invoice INV-{invoice.number}</h1>
        </div>
        <div className="flex items-center gap-3">
          <a
            href={`/api/invoices/${invoice.id}/pdf`}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-lg border border-ink-700 px-3 py-1.5 text-xs font-medium text-ink-300 hover:border-accent-400 hover:text-accent-300"
          >
            Download PDF
          </a>
          <StatusBadge status={invoice.status} />
        </div>
      </div>

      <div className="mt-6 grid gap-6 sm:grid-cols-2">
        <section className="rounded-xl border border-ink-800 p-5 text-sm">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-ink-400">Customer</h2>
          {customer ? (
            <div className="mt-2 space-y-1 text-ink-300">
              <p className="font-medium text-white">
                <Link href={`/admin/customers/${customer.id}`} className="hover:text-accent-300">
                  {customer.firstName} {customer.lastName}
                </Link>
              </p>
              {customer.email && <p>{customer.email}</p>}
              {customer.phone && <p>{customer.phone}</p>}
            </div>
          ) : (
            <p className="mt-2 text-ink-500">Missing</p>
          )}
        </section>
        <section className="rounded-xl border border-ink-800 p-5 text-sm">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-ink-400">Vehicle &amp; job</h2>
          <p className="mt-2 text-ink-300">
            {vehicle ? [vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(" ") : "None on file"}
          </p>
          {(linkedJobs.length > 0 || invoice.jobId) && (
            <div className="mt-2 space-y-1 text-xs">
              {(linkedJobs.length > 0 ? linkedJobs.map((link) => link.jobId) : [invoice.jobId!]).map((jobId, index) => (
                <p key={jobId}><Link href={`/admin/jobs/${jobId}`} className="text-accent-300">View job{linkedJobs.length > 1 ? ` ${index + 1}` : ""} →</Link></p>
              ))}
            </div>
          )}
        </section>
      </div>

      <section className="mt-6 overflow-x-auto rounded-xl border border-ink-800">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-ink-800 text-xs uppercase tracking-wider text-ink-400">
            <tr>
              <th className="px-4 py-3">Item</th>
              <th className="px-4 py-3">Qty</th>
              <th className="px-4 py-3">Unit</th>
              <th className="px-4 py-3">Amount</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.id} className="border-b border-ink-800/60">
                <td className="px-4 py-3 text-ink-200">{l.description}</td>
                <td className="px-4 py-3 text-ink-300">{l.quantity}</td>
                <td className="px-4 py-3 text-ink-300">{formatCents(l.unitPriceCents, settings.currency)}</td>
                <td className="px-4 py-3 text-ink-200">{formatCents(l.quantity * l.unitPriceCents, settings.currency)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot className="text-sm">
            <tr><td colSpan={3} className="px-4 py-2 text-right text-ink-400">Subtotal</td>
              <td className="px-4 py-2 text-ink-200">{formatCents(invoice.subtotalCents, settings.currency)}</td></tr>
            {invoice.discountCents > 0 && (
              <tr><td colSpan={3} className="px-4 py-2 text-right text-ink-400">
                  Discount
                  {invoice.discountReason && (
                    <span className="block text-xs font-normal text-ink-500">{invoice.discountReason}</span>
                  )}
                </td>
                <td className="px-4 py-2 text-ink-200">−{formatCents(invoice.discountCents, settings.currency)}</td></tr>
            )}
            <tr><td colSpan={3} className="px-4 py-2 text-right text-ink-400">
                {invoice.taxLabel} ({(invoice.taxRateBp / 100).toFixed(2)}%)</td>
              <td className="px-4 py-2 text-ink-200">{formatCents(invoice.taxCents, settings.currency)}</td></tr>
            {invoice.quotedPaymentMethod && (
              <tr><td colSpan={4} className={`px-4 py-2 text-xs ${invoice.taxTreatment === "none" ? "text-amber-300" : "text-ink-500"}`}>
                  {`Paid by ${
                    QUOTED_PAYMENT_METHOD_LABELS[invoice.quotedPaymentMethod as QuotedPaymentMethod] ??
                    invoice.quotedPaymentMethod
                  }${
                    invoice.taxTreatment === "none"
                      ? `, so no ${invoice.taxLabel} was charged. The balance cannot now be settled by card or cheque.`
                      : `, so ${invoice.taxLabel} stands. The balance cannot now be settled by cash or e-transfer.`
                  }`}
                </td></tr>
            )}
            <tr><td colSpan={3} className="px-4 py-3 text-right font-semibold text-white">Total</td>
              <td className="px-4 py-3 font-semibold text-accent-300">{formatCents(invoice.totalCents, settings.currency)}</td></tr>
            {invoice.depositAppliedCents > 0 && (
              <tr><td colSpan={3} className="px-4 py-2 text-right text-ink-400">Deposit applied</td>
                <td className="px-4 py-2 text-ink-200">−{formatCents(invoice.depositAppliedCents, settings.currency)}</td></tr>
            )}
            {depositRefundableCents > 0 && depositSourceAppointment && (
              <tr><td colSpan={4} className="px-4 py-2 text-xs text-amber-300">
                  {`${formatCents(depositRefundableCents, settings.currency)} of the deposit taken is more than this invoice can absorb and is owed back. `}
                  <Link href={`/admin/appointments/${depositSourceAppointment.id}`} className="underline">
                    Refund it on the appointment
                  </Link>
                  {" — refunding it here would reopen this invoice."}
                </td></tr>
            )}
            {summary.paidCents > 0 && (
              <tr><td colSpan={3} className="px-4 py-2 text-right text-ink-400">Paid</td>
                <td className="px-4 py-2 text-ink-200">−{formatCents(summary.paidCents, settings.currency)}</td></tr>
            )}
            {summary.refundedCents > 0 && (
              <tr><td colSpan={3} className="px-4 py-2 text-right text-ink-400">Refunded</td>
                <td className="px-4 py-2 text-ink-200">+{formatCents(summary.refundedCents, settings.currency)}</td></tr>
            )}
            <tr><td colSpan={3} className="px-4 py-3 text-right font-semibold text-white">Balance due</td>
              <td className="px-4 py-3 font-semibold text-accent-300">{formatCents(summary.balanceCents, settings.currency)}</td></tr>
          </tfoot>
        </table>
      </section>

      {payments.length > 0 && (
        <section className="mt-6 overflow-x-auto rounded-xl border border-ink-800">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-ink-800 text-xs uppercase tracking-wider text-ink-400">
              <tr>
                <th className="px-4 py-3">Date</th>
                <th className="px-4 py-3">Method</th>
                <th className="px-4 py-3">Kind</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Amount</th>
              </tr>
            </thead>
            <tbody>
              {payments.map((p) => (
                <tr key={p.id} className="border-b border-ink-800/60">
                  <td className="px-4 py-3 text-ink-400">
                    {(p.receivedAt ?? p.createdAt).toLocaleString("en-CA")}
                  </td>
                  <td className="px-4 py-3 text-ink-200">{PROVIDER_LABELS[p.provider] ?? p.provider}</td>
                  <td className="px-4 py-3 capitalize text-ink-300">{p.kind}</td>
                  <td className="px-4 py-3"><StatusBadge status={p.status} /></td>
                  <td className="px-4 py-3 text-ink-200">
                    {p.kind === "refund" ? "−" : ""}{formatCents(p.amountCents, settings.currency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {invoice.notes && (
        <section className="mt-6 rounded-xl border border-ink-800 p-5 text-sm">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-ink-400">Notes</h2>
          <p className="mt-2 whitespace-pre-wrap text-ink-300">{invoice.notes}</p>
        </section>
      )}
      {invoice.status === "cancelled" && invoice.cancellationReason && (
        <section className="mt-6 rounded-xl border border-ink-800 p-5 text-sm text-amber-300">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-ink-400">Cancellation reason</h2>
          <p className="mt-2 whitespace-pre-wrap">{invoice.cancellationReason}</p>
        </section>
      )}

      <section className="mt-6 rounded-xl border border-ink-800 p-5 text-sm text-ink-400">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-ink-400">Timeline</h2>
        <ul className="mt-2 space-y-1">
          <li>Created {formatInZone(invoice.createdAt, settings.timezone, { month: "short", day: "numeric", year: "numeric" })}</li>
          {invoice.sentAt && (
            <li>Sent {formatInZone(invoice.sentAt, settings.timezone, { month: "short", day: "numeric", year: "numeric" })}</li>
          )}
          {invoice.dueAt && (
            <li>Due {formatInZone(invoice.dueAt, settings.timezone, { month: "short", day: "numeric", year: "numeric" })}</li>
          )}
          {invoice.paidAt && (
            <li>Paid in full {formatInZone(invoice.paidAt, settings.timezone, { month: "short", day: "numeric", year: "numeric" })}</li>
          )}
          {invoice.cancelledAt && (
            <li>Cancelled {formatInZone(invoice.cancelledAt, settings.timezone, { month: "short", day: "numeric", year: "numeric" })}</li>
          )}
        </ul>
      </section>

      <InvoiceActions
        invoiceId={invoice.id}
        initialCc={invoice.ccEmails}
        status={invoice.status}
        balanceCents={summary.balanceCents}
        untaxedBalanceCents={untaxedSummary.balanceCents}
        taxSettled={taxSettled}
        currency={settings.currency}
        netPaidCents={summary.netPaidCents}
        stripeRefundableCents={refundAvailability.stripeRefundableCents}
        manualRefundableCents={refundAvailability.manualRefundableCents}
        taxExempt={invoice.taxExempt}
        taxLabel={invoice.taxLabel}
      />
    </div>
  );
}
