import { asc, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { Container, SectionHeading } from "@/components/ui";
import { getSettings } from "@/lib/settings";
import { BookingWizard, type WizardAddon, type WizardService } from "./wizard";

export const metadata = { title: "Book an Appointment" };
export const dynamic = "force-dynamic";

export default async function BookPage({
  searchParams,
}: {
  searchParams: Promise<{ service?: string }>;
}) {
  const { service: preselectSlug } = await searchParams;
  const settings = await getSettings();

  const services = await db()
    .select()
    .from(schema.services)
    .where(eq(schema.services.active, true))
    .orderBy(asc(schema.services.sort));
  const categories = await db()
    .select()
    .from(schema.serviceCategories)
    .orderBy(asc(schema.serviceCategories.sort));
  const adjustments = await db().select().from(schema.serviceVehicleAdjustments);
  const addonLinks = await db().select().from(schema.serviceAddons);
  const addons = await db()
    .select()
    .from(schema.addons)
    .where(eq(schema.addons.active, true))
    .orderBy(asc(schema.addons.sort));

  const categoryName = new Map(categories.map((c) => [c.id, c.name]));

  const wizardServices: WizardService[] = services
    .filter((s) => s.bookingMode === "bookable" && s.basePriceCents !== null)
    .map((s) => ({
      id: s.id,
      slug: s.slug,
      name: s.name,
      categoryName: categoryName.get(s.categoryId) ?? "",
      shortDescription: s.shortDescription ?? "",
      basePriceCents: s.basePriceCents!,
      baseDurationMin: s.baseDurationMin,
      adjustments: Object.fromEntries(
        adjustments
          .filter((a) => a.serviceId === s.id)
          .map((a) => [a.vehicleCategory, { priceDeltaCents: a.priceDeltaCents, durationDeltaMin: a.durationDeltaMin }]),
      ),
      addonIds: addonLinks.filter((l) => l.serviceId === s.id).map((l) => l.addonId),
    }));

  const wizardAddons: WizardAddon[] = addons.map((a) => ({
    id: a.id,
    name: a.name,
    description: a.description ?? "",
    priceCents: a.priceCents,
    durationMin: a.durationMin,
  }));

  return (
    <Container className="py-16">
      <SectionHeading
        eyebrow="Online booking"
        title="Book an appointment"
        subtitle="Pick a service, tell us about your vehicle, and choose a time that works. Condition-dependent services (paint correction, coatings, tinting, wraps) are quoted first — use Request a Quote instead."
      />
      <BookingWizard
        services={wizardServices}
        addons={wizardAddons}
        taxRateBp={settings.taxRateBp}
        taxLabel={settings.taxLabel}
        preselectSlug={preselectSlug}
        maxBookingWindowDays={settings.maxBookingWindowDays}
      />
    </Container>
  );
}
