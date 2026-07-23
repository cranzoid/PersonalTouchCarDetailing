import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { Container } from "@/components/ui";
import { formatCents } from "@/lib/money";
import { getSettings } from "@/lib/settings";
import { resolveAdditionalWorkToken } from "@/lib/jobs";
import { DecisionForm } from "./decision-form";

export const metadata = { title: "Approval Needed" };
export const dynamic = "force-dynamic";

/**
 * Customer mid-job additional-work approval, authenticated only by the
 * single-purpose hashed access token in the URL — mirrors the estimate portal.
 */
export default async function PortalWorkPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const resolved = await resolveAdditionalWorkToken(token);
  if (!resolved) notFound();
  const { request, job } = resolved;

  const settings = await getSettings();
  const [customer] = await db().select().from(schema.customers).where(eq(schema.customers.id, job.customerId)).limit(1);
  const [vehicle] = await db().select().from(schema.vehicles).where(eq(schema.vehicles.id, job.vehicleId)).limit(1);

  const decided = request.status !== "pending";

  return (
    <Container className="max-w-2xl py-10 sm:py-16">
      <header className="rounded-[2rem] border border-accent-500/25 bg-gradient-to-br from-[#0B2A4A] to-ink-950 p-6 shadow-2xl shadow-black/20 sm:p-8">
      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-accent-300">{settings.businessName}</p>
      <h1 className="mt-3 text-3xl font-bold text-white sm:text-4xl">Additional work approval</h1>
      <p className="mt-2 text-sm text-ink-400">
        For {customer?.firstName} {customer?.lastName}
        {vehicle && <> — {[vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(" ")}</>}
      </p>
      </header>

      <div className="mt-6 rounded-2xl border border-ink-700 bg-ink-900/60 p-6 shadow-xl shadow-black/10">
        <p className="text-sm text-ink-400">While working on your vehicle, we found:</p>
        <p className="mt-2 whitespace-pre-wrap text-ink-200">{request.description}</p>
        <div className="mt-4 flex items-baseline justify-between border-t border-ink-800 pt-4">
          <span className="text-sm text-ink-400">Price for this work</span>
          <span className="text-xl font-semibold text-accent-300">
            {formatCents(request.priceCents)}
            <span className="ml-1 text-sm font-normal text-ink-400">+ {settings.taxLabel}</span>
          </span>
        </div>
        {request.extraMinutes > 0 && (
          <p className="mt-1 text-right text-sm text-ink-500">
            Adds about {request.extraMinutes} minutes to your service
          </p>
        )}
      </div>

      {decided ? (
        <div role="status" className="mt-6 rounded-2xl border border-ink-700 bg-ink-900/60 p-6">
          {["approved", "override_approved"].includes(request.status) ? (
            <p className="text-emerald-300">
              This work was approved
              {request.decidedAt && <> on {request.decidedAt.toLocaleDateString("en-CA")}</>}. It
              will appear on your final invoice.
            </p>
          ) : (
            <p className="text-ink-300">
              This work was declined
              {request.decidedAt && <> on {request.decidedAt.toLocaleDateString("en-CA")}</>}. We
              are continuing with the originally approved services only.
            </p>
          )}
        </div>
      ) : (
        <DecisionForm token={token} />
      )}

      <p className="mt-10 text-xs text-ink-500">
        Questions? Call {settings.phone} or email {settings.email}. This link is personal to you —
        please don&apos;t share it.
      </p>
    </Container>
  );
}
