import { asc, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { Container, SectionHeading } from "@/components/ui";
import { getSettings } from "@/lib/settings";
import { activePromotion } from "@/lib/promotions";
import { BookingWizard, type WizardAddon, type WizardService } from "./wizard";
import { pageMetadata, SEO_PAGES } from "@/lib/seo";
import {
  CERAMIC_CONDITION_DISCLAIMER_SHORT,
  CERAMIC_PROTECTION_ADDON_QUALIFIER,
  CERAMIC_PROTECTION_ADDON_SLUG,
  hidesWorkDuration,
  isCeramicServiceSlug,
  isDateOnlyBookingSlug,
} from "@/lib/ceramic";

export const metadata = pageMetadata(SEO_PAGES.book);
export const dynamic = "force-dynamic";

export default async function BookPage({
  searchParams,
}: {
  // `addon` lets a campaign land the visitor on a fully-configured cart, e.g.
  // /book?service=complete-detail-engine&addon=ceramic-protection-ultimate.
  // It is only a suggestion: priceBooking still refuses any add-on that is not
  // linked to the chosen service, so a stale ad URL cannot buy the discounted
  // price without the qualifying package.
  searchParams: Promise<{ service?: string; offer?: string; addon?: string }>;
}) {
  const { service: preselectSlug, offer, addon: preselectAddonSlug } = await searchParams;
  const settings = await getSettings();
  // Resolved server-side so the page can never advertise something the server
  // would refuse to honour. The wizard decides whether this visitor *claims*
  // it — from the URL, or from a code stored when they landed on an earlier
  // page — but the percentage and eligible services always come from here.
  const promo = activePromotion(settings);

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
  const addonAdjustments = await db().select().from(schema.addonVehicleAdjustments);
  const addonLinks = await db().select().from(schema.serviceAddons);
  const addons = await db()
    .select()
    .from(schema.addons)
    .where(eq(schema.addons.active, true))
    .orderBy(asc(schema.addons.sort));

  const categoryName = new Map(categories.map((c) => [c.id, c.name]));
  // `services.sort` orders services WITHIN a category, so ordering by it alone
  // interleaved the catalogue: ceramic protection, then Ultimate Detail, then
  // a coating package, then Signature Detail. Sorting by the category first
  // keeps each category's services together, which is what lets the wizard
  // render them under one heading.
  const categorySort = new Map(categories.map((c, index) => [c.id, index]));

  const wizardServices: WizardService[] = services
    .filter((s) => s.bookingMode === "bookable" && s.basePriceCents !== null)
    .sort(
      (a, b) =>
        (categorySort.get(a.categoryId) ?? Number.MAX_SAFE_INTEGER) -
          (categorySort.get(b.categoryId) ?? Number.MAX_SAFE_INTEGER) || a.sort - b.sort,
    )
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
      // Ceramic prices cover the coating for the vehicle category and nothing
      // else; preparation is condition-dependent and approved separately.
      conditionNotice: isCeramicServiceSlug(s.slug) ? CERAMIC_CONDITION_DISCLAIMER_SHORT : null,
      // Same answer the booking transaction reaches from the same slug, so the
      // step the customer sees and the record that gets written cannot differ.
      dateOnly: isDateOnlyBookingSlug(s.slug),
      // A coating's hours are a scheduling fact, not a promise to the
      // customer — the same reason the booking is date-only.
      hideDuration: hidesWorkDuration(s.slug),
    }));

  const wizardAddons: WizardAddon[] = addons.map((a) => ({
    id: a.id,
    slug: a.slug,
    name: a.name,
    description: a.description ?? "",
    priceCents: a.priceCents,
    durationMin: a.durationMin,
    adjustments: Object.fromEntries(
      addonAdjustments
        .filter((adj) => adj.addonId === a.id)
        .map((adj) => [adj.vehicleCategory, { priceDeltaCents: adj.priceDeltaCents, durationDeltaMin: adj.durationDeltaMin }]),
    ),
    // The discounted ceramic protection price is never allowed to appear
    // without the sentence that says what it depends on.
    qualifier: a.slug === CERAMIC_PROTECTION_ADDON_SLUG ? CERAMIC_PROTECTION_ADDON_QUALIFIER : null,
  }));

  return (
    <Container className="py-12 sm:py-16">
      <SectionHeading
        as="h1"
        eyebrow="Online booking"
        title={SEO_PAGES.book.h1}
        subtitle="Choose a service, tell us about your vehicle, and reserve a convenient time. You’ll see a clear estimate before confirming. Condition-dependent work is quoted first."
      />
      <BookingWizard
        services={wizardServices}
        addons={wizardAddons}
        taxRateBp={settings.taxRateBp}
        taxLabel={settings.taxLabel}
        preselectSlug={preselectSlug}
        maxBookingWindowDays={settings.maxBookingWindowDays}
        timezone={settings.timezone}
        promo={
          promo
            ? {
                code: promo.code,
                label: promo.label,
                percentOffBp: promo.percentOffBp,
                eligibleServiceIds: promo.eligibleServiceIds,
              }
            : null
        }
        offerFromUrl={offer}
        preselectAddonSlug={preselectAddonSlug}
      />
    </Container>
  );
}
