import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import { percentCents, taxCents } from "@/lib/money";
import type { BusinessSettings } from "@/lib/settings";
import type { VehicleCategory } from "@/lib/types";

export type PricedLine = {
  serviceId?: string;
  addonId?: string;
  description: string;
  priceCents: number;
  durationMin: number;
};

export type BookingPricing = {
  lines: PricedLine[];
  subtotalCents: number;
  taxCents: number;
  taxRateBp: number;
  totalCents: number;
  depositRequiredCents: number;
  /** Work duration only; buffers are added by the availability engine. */
  durationMin: number;
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
}): Promise<BookingPricing> {
  const { serviceIds, addonIds, vehicleCategory, settings } = input;
  if (serviceIds.length === 0) throw new PricingError("Select at least one service");

  const services = await db()
    .select()
    .from(schema.services)
    .where(and(inArray(schema.services.id, serviceIds), eq(schema.services.active, true)));
  if (services.length !== serviceIds.length) {
    throw new PricingError("One or more services are unavailable");
  }
  for (const svc of services) {
    if (svc.bookingMode !== "bookable" || svc.basePriceCents === null) {
      throw new PricingError(`"${svc.name}" requires a quote and cannot be booked directly`);
    }
  }

  const adjustments = await db()
    .select()
    .from(schema.serviceVehicleAdjustments)
    .where(
      and(
        inArray(schema.serviceVehicleAdjustments.serviceId, serviceIds),
        eq(schema.serviceVehicleAdjustments.vehicleCategory, vehicleCategory),
      ),
    );
  const adjByService = new Map(adjustments.map((a) => [a.serviceId, a]));

  let addonRows: (typeof schema.addons.$inferSelect)[] = [];
  if (addonIds.length > 0) {
    // Add-ons must be active AND linked to at least one selected service.
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
  let depositRequiredCents = 0;

  for (const svc of services) {
    const adj = adjByService.get(svc.id);
    const priceCents = svc.basePriceCents! + (adj?.priceDeltaCents ?? 0);
    const durationMin = svc.baseDurationMin + (adj?.durationDeltaMin ?? 0);
    lines.push({ serviceId: svc.id, description: svc.name, priceCents, durationMin });
    if (svc.depositType === "fixed") depositRequiredCents += svc.depositValue;
    else if (svc.depositType === "percent") depositRequiredCents += percentCents(priceCents, svc.depositValue);
  }
  for (const addon of addonRows) {
    lines.push({
      addonId: addon.id,
      description: addon.name,
      priceCents: addon.priceCents,
      durationMin: addon.durationMin,
    });
  }

  return computeTotals(lines, settings.taxRateBp, depositRequiredCents);
}

/** Pure totals math (unit-tested in tests/pricing.test.ts). */
export function computeTotals(
  lines: PricedLine[],
  taxRateBp: number,
  depositRequiredCents = 0,
): BookingPricing {
  const subtotalCents = lines.reduce((sum, l) => sum + l.priceCents, 0);
  const durationMin = lines.reduce((sum, l) => sum + l.durationMin, 0);
  const tax = taxCents(subtotalCents, taxRateBp);
  return {
    lines,
    subtotalCents,
    taxCents: tax,
    taxRateBp,
    totalCents: subtotalCents + tax,
    depositRequiredCents,
    durationMin,
  };
}
