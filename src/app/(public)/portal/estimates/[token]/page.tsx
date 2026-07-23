import { notFound } from "next/navigation";
import { asc, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { Container } from "@/components/ui";
import { formatCents } from "@/lib/money";
import { getSettings } from "@/lib/settings";
import { resolveEstimateToken, computeEstimateTotals } from "@/lib/estimates";
import { ApprovalForm } from "./approval-form";

export const metadata = { title: "Your Estimate" };
export const dynamic = "force-dynamic";

/**
 * Customer estimate view + approval, authenticated only by the single-purpose
 * hashed access token in the URL. No account required; the token expires and
 * is revoked when a new one is issued.
 */
export default async function PortalEstimatePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const resolved = await resolveEstimateToken(token);
  if (!resolved) notFound();
  const { estimate } = resolved;

  const settings = await getSettings();
  const customer = (
    await db().select().from(schema.customers).where(eq(schema.customers.id, estimate.customerId)).limit(1)
  )[0];
  const vehicle = estimate.vehicleId
    ? (await db().select().from(schema.vehicles).where(eq(schema.vehicles.id, estimate.vehicleId)).limit(1))[0]
    : undefined;
  const lines = await db()
    .select()
    .from(schema.estimateLineItems)
    .where(eq(schema.estimateLineItems.estimateId, estimate.id))
    .orderBy(asc(schema.estimateLineItems.sort));

  // First open marks the estimate as viewed (audit-visible to staff).
  if (estimate.status === "sent") {
    await db()
      .update(schema.estimates)
      .set({ status: "viewed", viewedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.estimates.id, estimate.id));
    estimate.status = "viewed";
  }

  const expired =
    estimate.status === "expired" ||
    (estimate.expiresAt !== null && estimate.expiresAt < new Date() && !["approved", "declined", "converted"].includes(estimate.status));
  const decided = ["approved", "declined", "converted"].includes(estimate.status);
  const totals = computeEstimateTotals(
    lines.filter((l) => !l.isOptional || l.isSelected),
    estimate.discountCents,
    estimate.taxRateBp,
  );

  return (
    <Container className="max-w-2xl py-10 sm:py-16">
      <header className="rounded-[2rem] border border-accent-500/25 bg-gradient-to-br from-[#0B2A4A] to-ink-950 p-6 shadow-2xl shadow-black/20 sm:p-8">
      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-accent-300">{settings.businessName}</p>
      <h1 className="mt-3 text-3xl font-bold text-white sm:text-4xl">Estimate EST-{estimate.number}</h1>
      <p className="mt-2 text-sm text-ink-400">
        Prepared for {customer?.firstName} {customer?.lastName}
        {vehicle && <> — {[vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(" ")}</>}
      </p>
      {estimate.expiresAt && !decided && (
        <p className="mt-1 text-sm text-ink-500">
          Valid until {estimate.expiresAt.toLocaleDateString("en-CA", { month: "long", day: "numeric", year: "numeric" })}
        </p>
      )}
      </header>

      {estimate.customerMessage && (
        <div className="mt-6 rounded-2xl border border-ink-700 bg-ink-900/60 p-5 text-sm leading-6 text-ink-300">
          <p className="whitespace-pre-wrap">{estimate.customerMessage}</p>
        </div>
      )}

      {decided ? (
        <div className="mt-8 rounded-2xl border border-ink-700 bg-ink-900/60 p-6 shadow-xl shadow-black/10">
          {estimate.status === "declined" ? (
            <p className="text-ink-300">
              This estimate was declined
              {estimate.decidedAt && <> on {estimate.decidedAt.toLocaleDateString("en-CA")}</>}. If
              you changed your mind or want an adjusted quote, just contact us.
            </p>
          ) : (
            <p className="text-emerald-300">
              This estimate was approved
              {estimate.decidedAt && <> on {estimate.decidedAt.toLocaleDateString("en-CA")}</>}.
              We&apos;ll be in touch to schedule your appointment — or call us at {settings.phone}.
            </p>
          )}
          <EstimateTable lines={lines.filter((l) => !l.isOptional || l.isSelected)} totals={totals} taxLabel={estimate.taxLabel} taxRateBp={estimate.taxRateBp} depositRequiredCents={estimate.depositRequiredCents} />
        </div>
      ) : expired ? (
        <div className="mt-8 rounded-2xl border border-ink-700 bg-ink-900/60 p-6 text-ink-300 shadow-xl shadow-black/10">
          <p>
            This estimate has expired. Prices may have changed — contact us at {settings.phone} or{" "}
            {settings.email} and we&apos;ll refresh it for you.
          </p>
        </div>
      ) : (
        <ApprovalForm
          token={token}
          lines={lines.map((l) => ({
            id: l.id,
            description: l.description,
            quantity: l.quantity,
            unitPriceCents: l.unitPriceCents,
            isOptional: l.isOptional,
            isSelected: l.isSelected,
          }))}
          discountCents={estimate.discountCents}
          taxRateBp={estimate.taxRateBp}
          taxLabel={estimate.taxLabel}
          depositRequiredCents={estimate.depositRequiredCents}
        />
      )}

      <p className="mt-10 text-xs text-ink-500">
        Questions? Call {settings.phone} or email {settings.email}. This link is personal to you —
        please don&apos;t share it.
      </p>
    </Container>
  );
}

function EstimateTable({
  lines,
  totals,
  taxLabel,
  taxRateBp,
  depositRequiredCents,
}: {
  lines: { id: string; description: string; quantity: number; unitPriceCents: number }[];
  totals: { subtotalCents: number; discountCents: number; taxCents: number; totalCents: number };
  taxLabel: string;
  taxRateBp: number;
  depositRequiredCents: number;
}) {
  return (
    <div className="mt-4 overflow-x-auto">
      <table className="w-full min-w-[30rem] text-left text-sm">
        <caption className="sr-only">Approved estimate line items and totals</caption>
        <tbody>
          {lines.map((l) => (
            <tr key={l.id} className="border-b border-ink-800/60">
              <td className="py-2 pr-4 text-ink-200">
                {l.description}
                {l.quantity > 1 && <span className="text-ink-500"> × {l.quantity}</span>}
              </td>
              <td className="py-2 text-right text-ink-200">{formatCents(l.quantity * l.unitPriceCents)}</td>
            </tr>
          ))}
          <tr><td className="py-2 pr-4 text-right text-ink-400">Subtotal</td>
            <td className="py-2 text-right text-ink-200">{formatCents(totals.subtotalCents)}</td></tr>
          {totals.discountCents > 0 && (
            <tr><td className="py-2 pr-4 text-right text-ink-400">Discount</td>
              <td className="py-2 text-right text-ink-200">−{formatCents(totals.discountCents)}</td></tr>
          )}
          <tr><td className="py-2 pr-4 text-right text-ink-400">{taxLabel} ({(taxRateBp / 100).toFixed(2)}%)</td>
            <td className="py-2 text-right text-ink-200">{formatCents(totals.taxCents)}</td></tr>
          <tr><td className="py-3 pr-4 text-right font-semibold text-white">Total</td>
            <td className="py-3 text-right font-semibold text-accent-300">{formatCents(totals.totalCents)}</td></tr>
          {depositRequiredCents > 0 && (
            <tr><td className="py-2 pr-4 text-right text-ink-400">Deposit due at booking</td>
              <td className="py-2 text-right text-ink-200">{formatCents(depositRequiredCents)}</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
