import { asc, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { EstimateBuilder } from "./builder";
import { requirePageStaff } from "@/lib/auth/page";

export const dynamic = "force-dynamic";

export default async function NewEstimatePage({
  searchParams,
}: {
  searchParams: Promise<{ quoteRequest?: string }>;
}) {
  await requirePageStaff("manage_estimates");
  const { quoteRequest: quoteRequestId } = await searchParams;

  const services = await db()
    .select({
      id: schema.services.id,
      name: schema.services.name,
      basePriceCents: schema.services.basePriceCents,
      baseDurationMin: schema.services.baseDurationMin,
    })
    .from(schema.services)
    .where(eq(schema.services.active, true))
    .orderBy(asc(schema.services.sort));

  // Prefill from a quote request when building from one.
  let prefill: {
    quoteRequestId: string;
    name: string;
    email: string;
    phone: string;
    vehicle: { year?: number; make?: string; model?: string; category?: string } | null;
    requestedServiceIds: string[];
    conditionDescription: string;
  } | null = null;
  if (quoteRequestId) {
    const qr = (
      await db().select().from(schema.quoteRequests).where(eq(schema.quoteRequests.id, quoteRequestId)).limit(1)
    )[0];
    if (qr) {
      const lead = qr.leadId
        ? (await db().select().from(schema.leads).where(eq(schema.leads.id, qr.leadId)).limit(1))[0]
        : undefined;
      prefill = {
        quoteRequestId,
        name: lead?.name ?? "",
        email: lead?.email ?? "",
        phone: lead?.phone ?? "",
        vehicle: qr.vehicleInfo ?? null,
        requestedServiceIds: qr.requestedServiceIds,
        conditionDescription: qr.conditionDescription ?? "",
      };
    }
  }

  return (
    <div className="max-w-3xl">
      <h1 className="text-2xl font-bold text-white">New estimate</h1>
      <p className="mt-1 text-sm text-ink-400">
        Line items can come from the service catalog or be fully custom. Optional items let the
        customer choose; totals are always recomputed on the server.
      </p>
      <EstimateBuilder services={services} prefill={prefill} />
    </div>
  );
}
