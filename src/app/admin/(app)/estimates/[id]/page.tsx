import Link from "next/link";
import { notFound } from "next/navigation";
import { asc, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { formatCents } from "@/lib/money";
import { computeEstimateTotals } from "@/lib/estimates";
import { StatusBadge } from "@/components/admin";
import { EstimateActions } from "./estimate-actions";
import { requirePageStaff } from "@/lib/auth/page";

export const dynamic = "force-dynamic";

export default async function EstimateDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requirePageStaff("manage_estimates");
  const { id } = await params;
  const rows = await db().select().from(schema.estimates).where(eq(schema.estimates.id, id)).limit(1);
  const estimate = rows[0];
  if (!estimate) notFound();

  const customer = (
    await db().select().from(schema.customers).where(eq(schema.customers.id, estimate.customerId)).limit(1)
  )[0];
  const vehicle = estimate.vehicleId
    ? (await db().select().from(schema.vehicles).where(eq(schema.vehicles.id, estimate.vehicleId)).limit(1))[0]
    : undefined;
  const lines = await db()
    .select()
    .from(schema.estimateLineItems)
    .where(eq(schema.estimateLineItems.estimateId, id))
    .orderBy(asc(schema.estimateLineItems.sort));

  const totals = computeEstimateTotals(
    lines.filter((l) => !l.isOptional || l.isSelected),
    estimate.discountCents,
    estimate.taxRateBp,
  );

  // Suggested appointment duration: current base durations of service lines.
  let suggestedDurationMin = 0;
  for (const line of lines.filter((l) => (!l.isOptional || l.isSelected) && l.serviceId)) {
    const svc = (
      await db()
        .select({ d: schema.services.baseDurationMin })
        .from(schema.services)
        .where(eq(schema.services.id, line.serviceId!))
        .limit(1)
    )[0];
    if (svc) suggestedDurationMin += svc.d * line.quantity;
  }
  if (suggestedDurationMin === 0) suggestedDurationMin = 120;

  return (
    <div className="max-w-3xl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="font-mono text-xs text-ink-500">{estimate.id}</p>
          <h1 className="text-2xl font-bold text-white">Estimate EST-{estimate.number}</h1>
        </div>
        <StatusBadge status={estimate.status} />
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
          <h2 className="text-xs font-semibold uppercase tracking-wider text-ink-400">Vehicle</h2>
          <p className="mt-2 text-ink-300">
            {vehicle ? [vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(" ") : "None on file"}
          </p>
          {estimate.quoteRequestId && (
            <p className="mt-2 text-xs">
              <Link href={`/admin/leads/quotes/${estimate.quoteRequestId}`} className="text-accent-300">
                View originating quote request →
              </Link>
            </p>
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
                <td className="px-4 py-3 text-ink-200">
                  {l.description}
                  {l.isOptional && (
                    <span className="ml-2 rounded-full bg-ink-800 px-2 py-0.5 text-xs text-ink-400">
                      optional{l.isSelected ? " · selected" : " · not selected"}
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 text-ink-300">{l.quantity}</td>
                <td className="px-4 py-3 text-ink-300">{formatCents(l.unitPriceCents)}</td>
                <td className="px-4 py-3 text-ink-200">{formatCents(l.quantity * l.unitPriceCents)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot className="text-sm">
            <tr><td colSpan={3} className="px-4 py-2 text-right text-ink-400">Subtotal</td>
              <td className="px-4 py-2 text-ink-200">{formatCents(totals.subtotalCents)}</td></tr>
            {totals.discountCents > 0 && (
              <tr><td colSpan={3} className="px-4 py-2 text-right text-ink-400">Discount</td>
                <td className="px-4 py-2 text-ink-200">−{formatCents(totals.discountCents)}</td></tr>
            )}
            <tr><td colSpan={3} className="px-4 py-2 text-right text-ink-400">
                {estimate.taxLabel} ({(estimate.taxRateBp / 100).toFixed(2)}%)</td>
              <td className="px-4 py-2 text-ink-200">{formatCents(totals.taxCents)}</td></tr>
            <tr><td colSpan={3} className="px-4 py-3 text-right font-semibold text-white">Total</td>
              <td className="px-4 py-3 font-semibold text-accent-300">{formatCents(totals.totalCents)}</td></tr>
            {estimate.depositRequiredCents > 0 && (
              <tr><td colSpan={3} className="px-4 py-2 text-right text-ink-400">Deposit required</td>
                <td className="px-4 py-2 text-ink-200">{formatCents(estimate.depositRequiredCents)}</td></tr>
            )}
          </tfoot>
        </table>
      </section>

      {estimate.customerMessage && (
        <section className="mt-6 rounded-xl border border-ink-800 p-5 text-sm">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-ink-400">Message to customer</h2>
          <p className="mt-2 whitespace-pre-wrap text-ink-300">{estimate.customerMessage}</p>
        </section>
      )}
      {estimate.internalNotes && (
        <section className="mt-6 rounded-xl border border-ink-800 p-5 text-sm">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-ink-400">Internal notes</h2>
          <p className="mt-2 whitespace-pre-wrap text-ink-300">{estimate.internalNotes}</p>
        </section>
      )}

      <section className="mt-6 rounded-xl border border-ink-800 p-5 text-sm text-ink-400">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-ink-400">Timeline</h2>
        <ul className="mt-2 space-y-1">
          <li>Created {estimate.createdAt.toLocaleString("en-CA")}</li>
          {estimate.expiresAt && <li>Expires {estimate.expiresAt.toLocaleString("en-CA")}</li>}
          {estimate.sentAt && <li>Sent {estimate.sentAt.toLocaleString("en-CA")}</li>}
          {estimate.viewedAt && <li>Viewed by customer {estimate.viewedAt.toLocaleString("en-CA")}</li>}
          {estimate.decidedAt && (
            <li>
              {estimate.status === "approved" || estimate.status === "converted" ? "Approved" : "Decision"}{" "}
              {estimate.decidedAt.toLocaleString("en-CA")}
              {estimate.approvalName && <> — signed “{estimate.approvalName}”</>}
              {estimate.approvalIp && <> from {estimate.approvalIp}</>}
            </li>
          )}
          {estimate.changeRequestMessage && (
            <li className="text-amber-300">Change request: {estimate.changeRequestMessage}</li>
          )}
          {estimate.convertedToType === "appointment" && estimate.convertedToId && (
            <li>
              Converted to{" "}
              <Link href={`/admin/appointments/${estimate.convertedToId}`} className="text-accent-300">
                appointment →
              </Link>
            </li>
          )}
        </ul>
      </section>

      <EstimateActions
        estimateId={estimate.id}
        status={estimate.status}
        suggestedDurationMin={suggestedDurationMin}
        hasVehicle={Boolean(vehicle)}
      />
    </div>
  );
}
