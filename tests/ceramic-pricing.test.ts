import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db, getPool, schema } from "../src/db";
import { priceBooking, PricingError, resolveCatalogPrices } from "../src/lib/pricing";
import { SETTINGS_DEFAULTS, type BusinessSettings } from "../src/lib/settings";
import {
  CERAMIC_COATING_SLUGS,
  CERAMIC_PROTECTION_ADDON_SLUG,
  CERAMIC_PROTECTION_SLUG,
  COATING_PACKAGES,
  ULTIMATE_DETAIL_SLUG,
  isCeramicServiceSlug,
  warrantyLabel,
} from "../src/lib/ceramic";

/**
 * Ceramic protection and ceramic coating are two different products with two
 * different pricing shapes, and both go through the ordinary catalogue. These
 * tests pin the rules that would cost the shop money if they broke:
 *
 *  - the discounted ceramic protection price is unreachable without Ultimate
 *    Detail, enforced on the server rather than in the booking UI
 *  - add-ons take a vehicle-size delta, so an SUV is not charged sedan money
 *  - an invoice raised later prices the same add-on the same way
 */

const settings: BusinessSettings = { ...SETTINGS_DEFAULTS };

const ULTIMATE = "svc_test_ultimate";
const INTERIOR = "svc_test_interior";
const CRYSTAL = "svc_test_crystal";
const PROTECTION = "svc_test_protection";
const CERAMIC_ADDON = "add_test_ceramic";
const PET_HAIR_ADDON = "add_test_pethair";

async function seed() {
  await db().execute(sql`
    TRUNCATE appointment_services, appointments, vehicles, customers, audit_log,
             service_addons, addon_vehicle_adjustments, service_vehicle_adjustments,
             services, service_categories, addons CASCADE
  `);
  await db().insert(schema.serviceCategories).values({
    id: "cat_test_ceramic",
    name: "Test Catalogue",
    slug: "test-catalogue",
  });
  await db().insert(schema.services).values([
    { id: ULTIMATE, categoryId: "cat_test_ceramic", name: "Ultimate Detail", slug: ULTIMATE_DETAIL_SLUG, basePriceCents: 20000, baseDurationMin: 150, bookingMode: "bookable" },
    { id: INTERIOR, categoryId: "cat_test_ceramic", name: "Interior Detail", slug: "interior-detail", basePriceCents: 15000, baseDurationMin: 90, bookingMode: "bookable" },
    { id: CRYSTAL, categoryId: "cat_test_ceramic", name: "Ceramic Coating - Crystal", slug: "ceramic-coating-crystal", basePriceCents: 39900, baseDurationMin: 300, bookingMode: "bookable" },
    { id: PROTECTION, categoryId: "cat_test_ceramic", name: "Ceramic Protection - Standalone", slug: CERAMIC_PROTECTION_SLUG, basePriceCents: 19900, baseDurationMin: 120, bookingMode: "bookable" },
  ]);
  await db().insert(schema.serviceVehicleAdjustments).values([
    { id: "adj_test_crystal", serviceId: CRYSTAL, vehicleCategory: "suv_large", priceDeltaCents: 2000, durationDeltaMin: 30 },
    { id: "adj_test_protection", serviceId: PROTECTION, vehicleCategory: "suv_large", priceDeltaCents: 10000, durationDeltaMin: 30 },
  ]);
  await db().insert(schema.addons).values([
    { id: CERAMIC_ADDON, name: "Ceramic Protection - Ultimate Detail Add-On", slug: CERAMIC_PROTECTION_ADDON_SLUG, priceCents: 12000, durationMin: 45 },
    { id: PET_HAIR_ADDON, name: "Dog Hair Clean", slug: null, priceCents: 5000, durationMin: 30 },
  ]);
  await db().insert(schema.addonVehicleAdjustments).values({
    id: "aja_test_ceramic",
    addonId: CERAMIC_ADDON,
    vehicleCategory: "suv_large",
    priceDeltaCents: 7900,
    durationDeltaMin: 15,
  });
  // The ceramic add-on hangs off Ultimate Detail alone. The interior extra is
  // offered on the detailing packages but deliberately NOT on the coating.
  await db().insert(schema.serviceAddons).values([
    { id: "lnk_test_ceramic", serviceId: ULTIMATE, addonId: CERAMIC_ADDON },
    { id: "lnk_test_pethair_u", serviceId: ULTIMATE, addonId: PET_HAIR_ADDON },
    { id: "lnk_test_pethair_i", serviceId: INTERIOR, addonId: PET_HAIR_ADDON },
  ]);
}

// File-level, so the pool outlives every describe block in this file.
afterAll(async () => {
  await getPool().end();
});

describe("ceramic protection pricing", () => {
  beforeEach(seed);

  it("prices the Ultimate Detail add-on at the discounted sedan price", async () => {
    const pricing = await priceBooking({
      serviceIds: [ULTIMATE],
      addonIds: [CERAMIC_ADDON],
      vehicleCategory: "sedan",
      settings,
    });
    expect(pricing.subtotalCents).toBe(20000 + 12000);
    const line = pricing.lines.find((l) => l.addonId === CERAMIC_ADDON);
    expect(line?.priceCents).toBe(12000);
    // The line keeps its own name, so the appointment, estimate, invoice and
    // receipt it becomes all say what was actually sold.
    expect(line?.description).toBe("Ceramic Protection - Ultimate Detail Add-On");
  });

  it("charges the larger vehicle price for the same add-on", async () => {
    const pricing = await priceBooking({
      serviceIds: [ULTIMATE],
      addonIds: [CERAMIC_ADDON],
      vehicleCategory: "suv_large",
      settings,
    });
    const line = pricing.lines.find((l) => l.addonId === CERAMIC_ADDON);
    expect(line?.priceCents).toBe(19900); // 120 + 79
    expect(line?.durationMin).toBe(60); // 45 + 15
    expect(pricing.subtotalCents).toBe(20000 + 19900);
  });

  it("refuses the discounted add-on without Ultimate Detail", async () => {
    // The whole point of the $120 rule: it is not purchasable on its own, and
    // the server says so rather than relying on the booking UI hiding it.
    await expect(
      priceBooking({
        serviceIds: [INTERIOR],
        addonIds: [CERAMIC_ADDON],
        vehicleCategory: "sedan",
        settings,
      }),
    ).rejects.toBeInstanceOf(PricingError);
  });

  it("refuses the discounted add-on on a coating package too", async () => {
    await expect(
      priceBooking({
        serviceIds: [CRYSTAL],
        addonIds: [CERAMIC_ADDON],
        vehicleCategory: "sedan",
        settings,
      }),
    ).rejects.toBeInstanceOf(PricingError);
  });

  it("prices the standalone service well above the add-on", async () => {
    const sedan = await priceBooking({
      serviceIds: [PROTECTION],
      addonIds: [],
      vehicleCategory: "sedan",
      settings,
    });
    const suv = await priceBooking({
      serviceIds: [PROTECTION],
      addonIds: [],
      vehicleCategory: "suv_large",
      settings,
    });
    expect(sedan.subtotalCents).toBe(19900);
    expect(suv.subtotalCents).toBe(29900);
    // Standalone must never undercut the qualified add-on price, or the
    // Ultimate Detail condition stops meaning anything.
    expect(sedan.subtotalCents).toBeGreaterThan(12000);
  });

  it("prices an invoice line the same way the booking did", async () => {
    const { addons } = await resolveCatalogPrices({
      serviceIds: [],
      addonIds: [CERAMIC_ADDON],
      vehicleCategory: "suv_large",
    });
    expect(addons.get(CERAMIC_ADDON)?.priceCents).toBe(19900);

    const noVehicle = await resolveCatalogPrices({
      serviceIds: [],
      addonIds: [CERAMIC_ADDON],
      vehicleCategory: null,
    });
    // Without a vehicle the base price is the honest answer, not a guess.
    expect(noVehicle.addons.get(CERAMIC_ADDON)?.priceCents).toBe(12000);
  });
});

describe("ceramic coating packages", () => {
  beforeEach(seed);

  it("adjusts the package price by vehicle category", async () => {
    const sedan = await priceBooking({
      serviceIds: [CRYSTAL],
      addonIds: [],
      vehicleCategory: "sedan",
      settings,
    });
    const suv = await priceBooking({
      serviceIds: [CRYSTAL],
      addonIds: [],
      vehicleCategory: "suv_large",
      settings,
    });
    expect(sedan.subtotalCents).toBe(39900);
    expect(suv.subtotalCents).toBe(41900);
    expect(suv.durationMin).toBe(330);
  });

  it("keeps the whole appointment inside one working day", async () => {
    // Business hours are 09:00-17:00 and the availability engine adds the
    // setup and cleanup buffers before looking for a slot. A package that
    // does not fit is offered no times at all, which reads to a customer as
    // "never available" rather than "too long".
    const suv = await priceBooking({
      serviceIds: [CRYSTAL],
      addonIds: [],
      vehicleCategory: "suv_large",
      settings,
    });
    const blockMin = suv.durationMin + settings.setupBufferMin + settings.cleanupBufferMin;
    expect(blockMin).toBeLessThanOrEqual(8 * 60);
  });

  it("offers no interior extras on a coating booking", async () => {
    await expect(
      priceBooking({
        serviceIds: [CRYSTAL],
        addonIds: [PET_HAIR_ADDON],
        vehicleCategory: "sedan",
        settings,
      }),
    ).rejects.toBeInstanceOf(PricingError);
  });
});

describe("ceramic catalogue definitions", () => {
  it("treats protection and coating as different products", () => {
    expect(CERAMIC_COATING_SLUGS).not.toContain(CERAMIC_PROTECTION_SLUG);
    expect(isCeramicServiceSlug(CERAMIC_PROTECTION_SLUG)).toBe(true);
    for (const slug of CERAMIC_COATING_SLUGS) expect(isCeramicServiceSlug(slug)).toBe(true);
    expect(isCeramicServiceSlug(ULTIMATE_DETAIL_SLUG)).toBe(false);
  });

  it("carries a warranty on Pro and Max only", () => {
    const byTier = Object.fromEntries(COATING_PACKAGES.map((p) => [p.tier, p.warrantyYears]));
    expect(byTier.Crystal).toBeNull();
    expect(byTier.Pro).toBe(6);
    expect(byTier.Max).toBe(10);
    expect(warrantyLabel(null)).toBe("No warranty");
    expect(warrantyLabel(6)).toBe("6-year warranty");
  });

  it("never names a coating brand in customer-facing copy", async () => {
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../src/lib/ceramic.ts", import.meta.url), "utf8"),
    );
    // Word-bounded: "Ceramic Pro" as a brand, not the "Ceramic Protection"
    // product name that legitimately runs all through this file.
    for (const brand of [/\bSystem X\b/, /\bCeramic Pro\b/, /\bGtechniq\b/, /\bCQuartz\b/, /\bOpti-Coat\b/]) {
      expect(source).not.toMatch(brand);
    }
  });
});
