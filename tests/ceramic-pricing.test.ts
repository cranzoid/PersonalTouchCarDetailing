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
  ceramicMenuLinkFor,
  isCeramicServiceSlug,
  mostPopularCoating,
  resolveCeramicMenu,
  warrantyLabel,
} from "../src/lib/ceramic";
import { isQuoteOnlyVehicleCategory } from "../src/lib/types";

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
    { id: "adj_test_crystal", serviceId: CRYSTAL, vehicleCategory: "suv_large", priceDeltaCents: 10000, durationDeltaMin: 30 },
    { id: "adj_test_protection", serviceId: PROTECTION, vehicleCategory: "suv_large", priceDeltaCents: 3000, durationDeltaMin: 30 },
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
    // Owner-confirmed: $229 on a large vehicle, a $30 delta — not the $100 the
    // coating packages carry.
    expect(suv.subtotalCents).toBe(22900);
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
    expect(suv.subtotalCents).toBe(49900);
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

  it("recommends exactly one package, and it is the middle one", () => {
    const popular = mostPopularCoating();
    expect(popular?.tier).toBe("Pro");
    // Two badges would answer nothing, and the highlight is positional on the
    // hub page — the recommended package has to be the one in the middle.
    expect(COATING_PACKAGES.filter((pkg) => pkg.mostPopular)).toHaveLength(1);
    expect(COATING_PACKAGES.findIndex((pkg) => pkg.mostPopular)).toBe(1);
  });

  it("lists the vehicle history registration on the warranty packages only", () => {
    const carfax = (tier: string) =>
      COATING_PACKAGES.find((pkg) => pkg.tier === tier)!.includes.some((line) => line.includes("Carfax"));
    expect(carfax("Pro")).toBe(true);
    expect(carfax("Max")).toBe(true);
    expect(carfax("Crystal")).toBe(false);
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

describe("quote-only vehicle categories", () => {
  it("refuses to price a commercial vehicle from the catalogue", () => {
    // The public price tables and the booking wizard both read this, so a
    // "By quote" cell can never sit beside a wizard that quotes a number.
    expect(isQuoteOnlyVehicleCategory("commercial")).toBe(true);
    for (const category of ["sedan", "coupe", "suv_large", "pickup", "van", "other"]) {
      expect(isQuoteOnlyVehicleCategory(category)).toBe(false);
    }
  });
});

describe("public menu presentation", () => {
  const catalogue = {
    services: [
      { slug: "ceramic-coating-crystal", basePriceCents: 39900, active: true },
      { slug: "ceramic-coating-pro", basePriceCents: 99900, active: true },
      { slug: "ceramic-coating-max", basePriceCents: 139900, active: true },
      { slug: CERAMIC_PROTECTION_SLUG, basePriceCents: 19900, active: true },
    ],
    addons: [{ slug: CERAMIC_PROTECTION_ADDON_SLUG, priceCents: 12000, active: true }],
  };

  it("shows two products, coating first", () => {
    const menu = resolveCeramicMenu(catalogue);
    expect(menu.map((p) => p.name)).toEqual(["Ceramic Coating", "Ceramic Protection"]);
    // The suffixes that appear on bookings and invoices never reach the menu.
    for (const product of menu) {
      // Word-bounded: "Pro" the package, not the "Protection" product name.
      expect(product.name).not.toMatch(/\b(Standalone|Crystal|Pro|Max|Add-On)\b/);
    }
  });

  it("quotes the cheapest coating package and the qualified protection price", () => {
    const [coating, protection] = resolveCeramicMenu(catalogue);
    expect(coating.fromPriceCents).toBe(39900);
    expect(coating.priceNote).toBeNull();
    // $120 is the headline, and it may never appear without its condition.
    expect(protection.fromPriceCents).toBe(12000);
    expect(protection.priceNote).toContain("Ultimate Detail");
  });

  it("falls back to the standalone price when the add-on is unavailable", () => {
    const [, protection] = resolveCeramicMenu({ ...catalogue, addons: [] });
    expect(protection.fromPriceCents).toBe(19900);
    // Nothing conditional is being advertised, so there is nothing to qualify.
    expect(protection.priceNote).toBeNull();
  });

  it("drops a product rather than advertising it at zero", () => {
    const menu = resolveCeramicMenu({
      services: catalogue.services.map((s) => ({ ...s, active: false })),
      addons: [],
    });
    expect(menu).toEqual([]);
  });

  it("routes a package slug to the coating product", () => {
    for (const slug of CERAMIC_COATING_SLUGS) {
      expect(ceramicMenuLinkFor(slug)).toEqual({ name: "Ceramic Coating", href: "/services/ceramic-coating" });
    }
    expect(ceramicMenuLinkFor(CERAMIC_PROTECTION_SLUG)?.name).toBe("Ceramic Protection");
    expect(ceramicMenuLinkFor(ULTIMATE_DETAIL_SLUG)).toBeUndefined();
  });
});

describe("invoice pricing agrees with what staff are shown", () => {
  beforeEach(seed);

  /**
   * The invoice builder quotes a price in the grid and the server resolves one
   * when the invoice is saved. When those disagreed, staff read $120 for an
   * SUV, saved, and got $199 — and the obvious "fix" was to type 120 into the
   * override, which would have made the under-charge real.
   *
   * This asserts the server side of that contract. The grid computes
   * base + priceDeltaByCategory, which is the same arithmetic.
   */
  it("resolves the add-on for the invoice's vehicle, not the base price", async () => {
    const sedan = await resolveCatalogPrices({
      serviceIds: [ULTIMATE],
      addonIds: [CERAMIC_ADDON],
      vehicleCategory: "sedan",
    });
    const suv = await resolveCatalogPrices({
      serviceIds: [ULTIMATE],
      addonIds: [CERAMIC_ADDON],
      vehicleCategory: "suv_large",
    });
    expect(sedan.addons.get(CERAMIC_ADDON)?.priceCents).toBe(12000);
    expect(suv.addons.get(CERAMIC_ADDON)?.priceCents).toBe(19900);
    // The service on the same invoice already moved; the add-on must too, or
    // one line on the document follows the vehicle and the other does not.
    expect(sedan.services.get(ULTIMATE)?.priceCents).toBe(20000);
  });

  it("prices Crystal at the owner-confirmed large-vehicle figure", async () => {
    const suv = await resolveCatalogPrices({
      serviceIds: [CRYSTAL],
      addonIds: [],
      vehicleCategory: "suv_large",
    });
    expect(suv.services.get(CRYSTAL)?.priceCents).toBe(49900);
  });
});
