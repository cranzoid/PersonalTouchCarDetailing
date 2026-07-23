import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { asc, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import { Container, ButtonLink, Card } from "@/components/ui";
import { formatCents } from "@/lib/money";
import { VEHICLE_CATEGORY_LABELS, type VehicleCategory } from "@/lib/types";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const [service] = await db()
    .select({ name: schema.services.name, description: schema.services.shortDescription })
    .from(schema.services)
    .where(eq(schema.services.slug, slug))
    .limit(1);
  return service
    ? { title: service.name, description: service.description ?? undefined }
    : { title: "Service" };
}

export default async function ServiceDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const rows = await db()
    .select()
    .from(schema.services)
    .where(eq(schema.services.slug, slug))
    .limit(1);
  const svc = rows[0];
  if (!svc || !svc.active) notFound();

  const adjustments = await db()
    .select()
    .from(schema.serviceVehicleAdjustments)
    .where(eq(schema.serviceVehicleAdjustments.serviceId, svc.id));

  const addonLinks = await db()
    .select()
    .from(schema.serviceAddons)
    .where(eq(schema.serviceAddons.serviceId, svc.id));
  const addonRows =
    addonLinks.length > 0
      ? await db()
          .select()
          .from(schema.addons)
          .where(inArray(schema.addons.id, addonLinks.map((l) => l.addonId)))
          .orderBy(asc(schema.addons.sort))
      : [];

  const bookable = svc.bookingMode === "bookable" && svc.basePriceCents !== null;
  const quotePath = svc.bookingMode === "contact_only" ? "/contact" : `/quote?service=${svc.slug}`;

  return (
    <Container className="py-20 sm:py-28">
      <div className="grid gap-14 lg:grid-cols-[minmax(0,1.45fr)_minmax(19rem,0.55fr)]">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-accent-300">Detailing service</p>
          <h1 className="mt-5 max-w-3xl font-display text-5xl leading-[1.02] tracking-[-0.03em] text-white sm:text-6xl">{svc.name}</h1>
          <p className="mt-6 max-w-2xl text-lg leading-8 text-ink-200">{svc.shortDescription}</p>
          {svc.longDescription && <p className="mt-5 max-w-2xl leading-7 text-ink-300">{svc.longDescription}</p>}

          {!bookable && (
            <Card className="mt-8 border-accent-500/30">
              <h2 className="font-semibold text-accent-300">
                {svc.bookingMode === "contact_only"
                  ? "Contact us about this service"
                  : "This service is quoted individually"}
              </h2>
              <p className="mt-2 text-sm text-ink-300">
                {svc.bookingMode === "inspection_required"
                  ? "Results depend on your vehicle's paint and condition, so we review photos or inspect the vehicle before giving you an exact price and timeline."
                  : svc.bookingMode === "quote_required"
                    ? "Pricing depends on your vehicle's condition. Send us a few details — and photos if you can — and we'll reply with a personalized estimate."
                    : "Tell us about your project and we'll get back to you with options."}
              </p>
            </Card>
          )}

          {bookable && adjustments.length > 0 && (
            <div className="mt-10">
              <h2 className="font-display text-2xl text-white">Pricing by vehicle size</h2>
              <div className="mt-4 overflow-x-auto">
                <table className="w-full max-w-lg overflow-hidden rounded-2xl text-sm">
                  <caption className="sr-only">Price adjustments by vehicle category</caption>
                  <tbody>
                    <tr className="border-b border-white/10">
                      <td className="py-2 text-ink-300">Coupe / Sedan</td>
                      <td className="py-2 text-right text-accent-300">
                        {formatCents(svc.basePriceCents!)}
                      </td>
                    </tr>
                    {adjustments.map((adj) => (
                      <tr key={adj.id} className="border-b border-white/10">
                        <td className="py-2 text-ink-300">
                          {VEHICLE_CATEGORY_LABELS[adj.vehicleCategory as VehicleCategory] ??
                            adj.vehicleCategory}
                        </td>
                        <td className="py-2 text-right text-accent-300">
                          {formatCents(svc.basePriceCents! + adj.priceDeltaCents)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-2 text-xs text-ink-500">
                Final pricing is confirmed at booking. Heavily soiled vehicles may require
                additional time, always discussed with you first.
              </p>
            </div>
          )}

          {addonRows.length > 0 && (
            <div className="mt-10">
              <h2 className="font-display text-2xl text-white">Popular add-ons</h2>
              <ul className="mt-4 grid max-w-xl gap-2 sm:grid-cols-2">
                {addonRows.map((a) => (
                  <li key={a.id} className="flex min-h-12 items-center justify-between rounded-xl border border-white/10 bg-white/[0.03] px-4 py-2 text-sm">
                    <span className="text-ink-200">{a.name}</span>
                    <span className="text-accent-300">{formatCents(a.priceCents)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <aside>
          <Card className="sticky top-28 border-accent-400/25 p-7">
            <p className="text-sm uppercase tracking-wider text-ink-400">
              {bookable ? "Starting at" : "Pricing"}
            </p>
            <p className="mt-2 font-display text-4xl text-white">
              {bookable ? formatCents(svc.basePriceCents!) : "By quote"}
            </p>
            <p className="mt-1 text-sm text-ink-400">
              Approx. {Math.round(svc.baseDurationMin / 60)}h {svc.baseDurationMin % 60 || ""}
              {svc.baseDurationMin % 60 ? "m" : ""} for a standard vehicle
            </p>
            <div className="mt-6 flex flex-col gap-2">
              {bookable ? (
                <>
                  <ButtonLink href={`/book?service=${svc.slug}`}>Book This Service</ButtonLink>
                  <ButtonLink href="/quote" variant="outline">Ask a Question</ButtonLink>
                </>
              ) : (
                <ButtonLink href={quotePath}>
                  {svc.bookingMode === "contact_only" ? "Contact Us" : "Request a Quote"}
                </ButtonLink>
              )}
            </div>
          </Card>
        </aside>
      </div>
    </Container>
  );
}
