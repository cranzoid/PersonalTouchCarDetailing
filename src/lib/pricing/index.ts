import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import { percentCents, taxCents } from "@/lib/money";
import {
  allocateDiscount,
  eligibleBaseCents,
  promotionDiscountCents,
  type ResolvedPromotion,
} from "@/lib/promotions";
import type { BusinessSettings } from "@/lib/settings";
import type { VehicleCategory } from "@/lib/types";
import { bestOfAllocations, bundleDiscountAllocations, bundlePerkFor } from "@/lib/bundle-offers";
import { washOfferAllocation, washOfferPriceCents, type ResolvedWashOffer } from "@/lib/wash-offer";

export type PricedLine = {
  serviceId?: string;
  addonId?: string;
  description: string;
  priceCents: number;
  durationMin: number;
};

/**
 * A staff-authored line with no catalog entry behind it — a paint correction
 * or any other quote-only job, priced at the counter. Only reachable from the
 * staff booking path: the price is supplied rather than looked up, so the
 * public booking flow must never be able to pass one.
 */
export type CustomBookingLine = {
  description: string;
  priceCents: number;
  /** Chair time this line needs, so the scheduler can block the bay for it. */
  durationMin: number;
};

export type BookingPricing = {
  lines: PricedLine[];
  /** Always gross — the sum of the lines, before any discount. */
  subtotalCents: number;
  /**
   * Promotional discount, applied to the subtotal BEFORE tax. Required rather
   * than optional so every construction site has to decide.
   */
  discountCents: number;
  promoCode: string | null;
  promoLabel: string | null;
  taxCents: number;
  taxRateBp: number;
  totalCents: number;
  depositRequiredCents: number;
  /** Work duration only; buffers are added by the availability engine. */
  durationMin: number;
  /** Normalized union of skills required by every selected service. */
  requiredSkills: string[];
  /**
   * Catalogue slugs of the selected services, in line order. Carried so the
   * booking transaction can answer questions the cents cannot — whether this
   * is a service the shop schedules by hand (see `isDateOnlyBookingSlug`) —
   * from the same rows the price came from, rather than re-reading the
   * catalogue and risking a different answer.
   */
  serviceSlugs: string[];
};

/** A resolved discount, ready to apply. `cents` is authoritative. */
export type AppliedDiscount = {
  cents: number;
  code?: string | null;
  label?: string | null;
  /** Per-line split of `cents`, used only to compute percentage deposits. */
  allocation?: number[];
};

export class PricingError extends Error {}

/**
 * Server-side price/duration computation for a booking. Client-supplied prices
 * are never trusted — this is the only authority. Pure math is split out in
 * computeTotals() for unit testing.
 */
export async function priceBooking(input: {
  serviceIds: string[];
  addonIds: string[];
  vehicleCategory: VehicleCategory;
  settings: BusinessSettings;
  /**
   * Server-resolved promotion. The discount is computed here from the catalog
   * prices — a caller can never supply an amount.
   */
  promo?: ResolvedPromotion | null;
  /**
   * Staff-supplied lines for work the catalog cannot price — paint correction
   * quoted at the counter after inspection. The caller is responsible for
   * restricting these to staff; the public booking actions never pass them.
   */
  customLines?: CustomBookingLine[];
  /**
   * The customer asked for the extra their bundle unlocks. Honoured only if
   * the catalogue actually attaches one to the pairing they selected, so a
   * hand-built request cannot add a free line to any booking it likes.
   */
  perkOptIn?: boolean;
  /**
   * Server-resolved new-customer wash offer, passed only once the caller has
   * checked that the visitor holds a live claim for it. Like `promo`, the
   * amount is never supplied — the promo price comes from settings and the
   * discount is the difference from the catalogue price computed here.
   */
  washOffer?: ResolvedWashOffer | null;
}): Promise<BookingPricing> {
  const { serviceIds, addonIds, vehicleCategory, settings, promo } = input;
  const customLines = input.customLines ?? [];
  // A booking may be entirely custom — correction work with no catalogue
  // package attached — so the requirement is one line of some kind, not one
  // catalog service.
  if (serviceIds.length === 0 && customLines.length === 0) {
    throw new PricingError("Select at least one service, or add a custom line");
  }

  const services = serviceIds.length > 0
    ? await db()
        .select()
        .from(schema.services)
        .where(and(inArray(schema.services.id, serviceIds), eq(schema.services.active, true)))
    : [];
  if (services.length !== serviceIds.length) {
    throw new PricingError("One or more services are unavailable");
  }

  // Database result order is not guaranteed. Keep quote lines aligned with the
  // customer's selection so the primary service always remains first.
  services.sort((left, right) => serviceIds.indexOf(left.id) - serviceIds.indexOf(right.id));
  for (const svc of services) {
    if (svc.bookingMode !== "bookable" || svc.basePriceCents === null) {
      throw new PricingError(`"${svc.name}" requires a quote and cannot be booked directly`);
    }
  }

  const adjustments = serviceIds.length > 0
    ? await db()
        .select()
        .from(schema.serviceVehicleAdjustments)
        .where(
          and(
            inArray(schema.serviceVehicleAdjustments.serviceId, serviceIds),
            eq(schema.serviceVehicleAdjustments.vehicleCategory, vehicleCategory),
          ),
        )
    : [];
  const adjByService = new Map(adjustments.map((a) => [a.serviceId, a]));

  let addonRows: (typeof schema.addons.$inferSelect)[] = [];
  if (addonIds.length > 0) {
    // Add-ons must be active AND linked to at least one selected service. A
    // custom line is not a service, so it cannot carry add-ons — price the
    // extra as a second custom line instead.
    if (serviceIds.length === 0) {
      throw new PricingError("Selected add-on is not available for this service");
    }
    const links = await db()
      .select()
      .from(schema.serviceAddons)
      .where(
        and(
          inArray(schema.serviceAddons.serviceId, serviceIds),
          inArray(schema.serviceAddons.addonId, addonIds),
        ),
      );
    const allowed = new Set(links.map((l) => l.addonId));
    for (const id of addonIds) {
      if (!allowed.has(id)) throw new PricingError("Selected add-on is not available for this service");
    }
    addonRows = await db()
      .select()
      .from(schema.addons)
      .where(and(inArray(schema.addons.id, addonIds), eq(schema.addons.active, true)));
    if (addonRows.length !== addonIds.length) throw new PricingError("One or more add-ons are unavailable");
  }

  // Add-ons take a vehicle-size delta exactly as services do — ceramic
  // protection costs more on an SUV whether it is bought on its own or
  // alongside a detail, and one rule has to explain both.
  const addonAdjustments = addonIds.length > 0
    ? await db()
        .select()
        .from(schema.addonVehicleAdjustments)
        .where(
          and(
            inArray(schema.addonVehicleAdjustments.addonId, addonIds),
            eq(schema.addonVehicleAdjustments.vehicleCategory, vehicleCategory),
          ),
        )
    : [];
  const adjByAddon = new Map(addonAdjustments.map((a) => [a.addonId, a]));

  const lines: PricedLine[] = [];
  for (const svc of services) {
    const adj = adjByService.get(svc.id);
    lines.push({
      serviceId: svc.id,
      description: svc.name,
      priceCents: svc.basePriceCents! + (adj?.priceDeltaCents ?? 0),
      durationMin: svc.baseDurationMin + (adj?.durationDeltaMin ?? 0),
    });
  }
  const serviceLineCount = lines.length;
  for (const addon of addonRows) {
    const adj = adjByAddon.get(addon.id);
    lines.push({
      addonId: addon.id,
      description: addon.name,
      priceCents: addon.priceCents + (adj?.priceDeltaCents ?? 0),
      durationMin: addon.durationMin + (adj?.durationDeltaMin ?? 0),
    });
  }
  // Appended last so the deposit loop below still walks only catalog service
  // lines, and so a promotion can never reach a hand-priced line.
  for (const custom of customLines) {
    lines.push({
      description: custom.description,
      priceCents: custom.priceCents,
      durationMin: custom.durationMin,
    });
  }

  // Campaign-code discount: computed over its eligible portion of the cart,
  // then apportioned for percentage-deposit math.
  const campaignDiscountCents = promo
    ? promotionDiscountCents(eligibleBaseCents(lines, promo.eligibleServiceIds), promo.percentOffBp)
    : 0;
  const campaignAllocation = promo
    ? allocateDiscount(lines, promo.eligibleServiceIds, campaignDiscountCents)
    : new Array(lines.length).fill(0);

  // Automatic bundle offers are catalogue relationships, not browser claims.
  // Load only relationships whose two services are actually selected.
  const bundleRows = serviceIds.length > 1
    ? await db()
        .select({
          primaryServiceId: schema.serviceBundleOffers.primaryServiceId,
          bundledServiceId: schema.serviceBundleOffers.bundledServiceId,
          discountPercentBp: schema.serviceBundleOffers.discountPercentBp,
          label: schema.serviceBundleOffers.label,
          perkLabel: schema.serviceBundleOffers.perkLabel,
          perkNote: schema.serviceBundleOffers.perkNote,
        })
        .from(schema.serviceBundleOffers)
        .where(and(
          eq(schema.serviceBundleOffers.active, true),
          inArray(schema.serviceBundleOffers.primaryServiceId, serviceIds),
          inArray(schema.serviceBundleOffers.bundledServiceId, serviceIds),
        ))
    : [];
  const bundle = bundleDiscountAllocations(lines, bundleRows);

  // New-customer wash offer: a fixed promo PRICE, turned into a discount off
  // the catalogue price of the one service it buys. Fails closed everywhere —
  // no offer, the service not in the cart, or a vehicle category the offer does
  // not price (commercial) all produce nothing.
  const washService = input.washOffer
    ? services.find((service) => service.slug === input.washOffer!.serviceSlug)
    : undefined;
  const washPriceCents = input.washOffer
    ? washOfferPriceCents(input.washOffer, vehicleCategory)
    : null;
  const wash = washService && washPriceCents !== null
    ? washOfferAllocation(lines, { serviceId: washService.id, promoPriceCents: washPriceCents })
    : { allocation: new Array(lines.length).fill(0) as number[], applies: false };

  // Precedence by order: the claim-backed wash offer first, because it is the
  // one the customer was shown a specific dollar price for and the one whose
  // code has to end up on the appointment. In practice they cannot collide —
  // the wash is not a bundle service and is not on the campaign's list.
  const resolved = bestOfAllocations([
    { key: "wash", allocation: wash.allocation },
    { key: "bundle", allocation: bundle.allocation },
    { key: "campaign", allocation: campaignAllocation },
  ]);
  const allocation = resolved.allocation;
  const discountCents = allocation.reduce((sum, cents) => sum + cents, 0);

  const washContributes = resolved.contributing.has("wash");
  const campaignContributes = resolved.contributing.has("campaign");
  const contributingLabels = [
    ...(washContributes && input.washOffer ? [input.washOffer.label] : []),
    ...(resolved.contributing.has("bundle") ? bundle.labels : []),
    ...(campaignContributes && promo ? [promo.label] : []),
  ];
  const discountLabel = contributingLabels.length > 1
    ? "Best available offers"
    : contributingLabels[0] ?? null;

  let depositRequiredCents = 0;
  for (let i = 0; i < serviceLineCount; i++) {
    const svc = services.find((s) => s.id === lines[i].serviceId)!;
    if (svc.depositType === "fixed") {
      // A flat deposit is a no-show hold, not a share of the price, so a
      // promotion does not shrink it.
      depositRequiredCents += svc.depositValue;
    } else if (svc.depositType === "percent") {
      depositRequiredCents += percentCents(lines[i].priceCents - allocation[i], svc.depositValue);
    }
  }

  // Appended after the discount allocation and the deposit maths, both of
  // which index `lines` positionally. It is free and takes no scheduled time,
  // so it changes no total — it exists so the customer sees what they asked
  // for and the shop has it on the booking.
  const perk = input.perkOptIn ? bundlePerkFor(serviceIds, bundleRows) : null;
  if (perk) {
    lines.push({ description: perk.label, priceCents: 0, durationMin: 0 });
  }

  return {
    ...computeTotals(lines, settings.taxRateBp, depositRequiredCents, {
      cents: discountCents,
      // A code is recorded only if it contributed money. In the common ceramic
      // bundle case the larger bundle percentage wins, so a returning customer
      // is not incorrectly subjected to first-time checks. The wash offer takes
      // the column when it paid, because its claim has to be traceable from the
      // appointment back to the person who spent it.
      code: washContributes
        ? (input.washOffer?.code ?? null)
        : campaignContributes
          ? (promo?.code ?? null)
          : null,
      label: discountLabel,
    }),
    requiredSkills: [...new Set(services.flatMap((service) => service.requiredSkills.map(normalizeSkill)).filter(Boolean))],
    serviceSlugs: services.map((service) => service.slug),
  };
}

export type CatalogPrice = {
  /** Catalog name, used as the invoice line description. */
  description: string;
  /** Base price plus the adjustment for the vehicle category, in cents. */
  priceCents: number;
  /** True when the service is quote-only, so staff must supply the price. */
  requiresManualPrice: boolean;
};

/**
 * Resolves current catalog prices for invoice lines, applying the same
 * vehicle-category adjustment the booking flow uses — a large SUV costs more
 * than a sedan for the same package.
 *
 * Deliberately more permissive than priceBooking(): an invoice records work
 * that has already happened, so quote-only and inactive services are allowed
 * (staff supply the price for quote-only ones). Booking still refuses them.
 */
export async function resolveCatalogPrices(input: {
  serviceIds: string[];
  addonIds: string[];
  vehicleCategory: VehicleCategory | null;
}): Promise<{ services: Map<string, CatalogPrice>; addons: Map<string, CatalogPrice> }> {
  const services = new Map<string, CatalogPrice>();
  const addons = new Map<string, CatalogPrice>();

  if (input.serviceIds.length > 0) {
    const rows = await db()
      .select()
      .from(schema.services)
      .where(inArray(schema.services.id, input.serviceIds));

    // Only look up adjustments when we know the vehicle; without one the base
    // price is the honest answer rather than a guess at the size.
    const adjustments = input.vehicleCategory
      ? await db()
          .select()
          .from(schema.serviceVehicleAdjustments)
          .where(
            and(
              inArray(schema.serviceVehicleAdjustments.serviceId, input.serviceIds),
              eq(schema.serviceVehicleAdjustments.vehicleCategory, input.vehicleCategory),
            ),
          )
      : [];
    const adjByService = new Map(adjustments.map((a) => [a.serviceId, a]));

    for (const svc of rows) {
      const adj = adjByService.get(svc.id);
      services.set(svc.id, {
        description: svc.name,
        priceCents: (svc.basePriceCents ?? 0) + (adj?.priceDeltaCents ?? 0),
        requiresManualPrice: svc.basePriceCents === null,
      });
    }
  }

  if (input.addonIds.length > 0) {
    const rows = await db().select().from(schema.addons).where(inArray(schema.addons.id, input.addonIds));
    // Same reasoning as services above: only size-adjust when the vehicle is
    // known, so an invoice raised without one records the honest base price.
    const adjustments = input.vehicleCategory
      ? await db()
          .select()
          .from(schema.addonVehicleAdjustments)
          .where(
            and(
              inArray(schema.addonVehicleAdjustments.addonId, input.addonIds),
              eq(schema.addonVehicleAdjustments.vehicleCategory, input.vehicleCategory),
            ),
          )
      : [];
    const adjByAddon = new Map(adjustments.map((a) => [a.addonId, a]));

    for (const addon of rows) {
      addons.set(addon.id, {
        description: addon.name,
        priceCents: addon.priceCents + (adjByAddon.get(addon.id)?.priceDeltaCents ?? 0),
        requiresManualPrice: false,
      });
    }
  }

  return { services, addons };
}

/** Pure totals math (unit-tested in tests/pricing.test.ts). */
export function computeTotals(
  lines: PricedLine[],
  taxRateBp: number,
  depositRequiredCents = 0,
  discount: AppliedDiscount = { cents: 0 },
): BookingPricing {
  const subtotalCents = lines.reduce((sum, l) => sum + l.priceCents, 0);
  const durationMin = lines.reduce((sum, l) => sum + l.durationMin, 0);
  // Discount before tax, clamped to the subtotal — the same ordering and the
  // same clamp as computeInvoiceTotals, so an appointment and the invoice it
  // becomes agree to the cent.
  const discountCents = Math.min(Math.max(0, discount.cents), subtotalCents);
  const taxableCents = subtotalCents - discountCents;
  const tax = taxCents(taxableCents, taxRateBp);
  const totalCents = taxableCents + tax;
  return {
    lines,
    subtotalCents,
    discountCents,
    promoCode: discount.code ?? null,
    promoLabel: discount.label ?? null,
    taxCents: tax,
    taxRateBp,
    totalCents,
    // A deposit can never exceed what is owed. This also closes a pre-existing
    // hole where a fixed deposit could outrun a small job's total.
    depositRequiredCents: Math.min(depositRequiredCents, totalCents),
    durationMin,
    requiredSkills: [],
    // Pure math over lines that are already priced — it never looked the
    // catalogue up, so it has no slugs to report. priceBooking, which did,
    // fills both of these in.
    serviceSlugs: [],
  };
}

function normalizeSkill(skill: string): string {
  return skill.trim().toLowerCase();
}
