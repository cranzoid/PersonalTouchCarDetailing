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

export type PricedLine = {
  serviceId?: string;
  addonId?: string;
  description: string;
  priceCents: number;
  durationMin: number;
};

/**
 * A staff-authored line with no catalog entry behind it — a ceramic coating or
 * any other quote-only job, priced at the counter. Only reachable from the
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
   * Staff-supplied lines for work the catalog cannot price — a ceramic coating
   * quoted at the counter. The caller is responsible for restricting these to
   * staff; the public booking actions never pass them.
   */
  customLines?: CustomBookingLine[];
}): Promise<BookingPricing> {
  const { serviceIds, addonIds, vehicleCategory, settings, promo } = input;
  const customLines = input.customLines ?? [];
  // A booking may be entirely custom — a coating with no package attached — so
  // the requirement is one line of some kind, not one catalog service.
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
    lines.push({
      addonId: addon.id,
      description: addon.name,
      priceCents: addon.priceCents,
      durationMin: addon.durationMin,
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

  // The discount is computed once, over the eligible slice of the cart, and
  // then apportioned back onto those lines purely so percentage deposits can
  // be charged on what the customer actually owes.
  const discountCents = promo
    ? promotionDiscountCents(eligibleBaseCents(lines, promo.eligibleServiceIds), promo.percentOffBp)
    : 0;
  const allocation = promo
    ? allocateDiscount(lines, promo.eligibleServiceIds, discountCents)
    : new Array(lines.length).fill(0);

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

  return {
    ...computeTotals(lines, settings.taxRateBp, depositRequiredCents, {
      cents: discountCents,
      code: promo?.code ?? null,
      label: promo?.label ?? null,
    }),
    requiredSkills: [...new Set(services.flatMap((service) => service.requiredSkills.map(normalizeSkill)).filter(Boolean))],
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
    for (const addon of rows) {
      addons.set(addon.id, {
        description: addon.name,
        priceCents: addon.priceCents,
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
  };
}

function normalizeSkill(skill: string): string {
  return skill.trim().toLowerCase();
}
