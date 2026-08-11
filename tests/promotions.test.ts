import { describe, expect, it } from "vitest";
import {
  activePromotion,
  allocateDiscount,
  eligibleBaseCents,
  promotionDiscountCents,
  resolveActivePromotion,
} from "../src/lib/promotions";
import { percentCents } from "../src/lib/money";
import { SETTINGS_DEFAULTS } from "../src/lib/settings";

const DETAIL = "svc_detail";
const COATING = "svc_coating";

function settings(overrides: Partial<typeof SETTINGS_DEFAULTS.promotion> = {}) {
  return {
    timezone: "America/Toronto",
    promotion: {
      ...SETTINGS_DEFAULTS.promotion,
      enabled: true,
      code: "FIRST10AUG26",
      percentOffBp: 1000,
      eligibleServiceIds: [DETAIL],
      ...overrides,
    },
  };
}

// 2026-08-11T12:00Z is mid-morning in Toronto, safely inside the same
// calendar day on both sides of the DST boundary.
const NOW = Date.parse("2026-08-11T12:00:00Z");

describe("activePromotion", () => {
  it("returns the offer when it is running", () => {
    expect(activePromotion(settings(), NOW)?.code).toBe("FIRST10AUG26");
  });

  it("fails closed when disabled", () => {
    expect(activePromotion(settings({ enabled: false }), NOW)).toBeNull();
  });

  it("fails closed at zero percent", () => {
    expect(activePromotion(settings({ percentOffBp: 0 }), NOW)).toBeNull();
  });

  it("fails closed when no services are eligible", () => {
    // An empty list must mean "nothing", never "everything".
    expect(activePromotion(settings({ eligibleServiceIds: [] }), NOW)).toBeNull();
  });

  it("stops the day after it expires but runs through the expiry day itself", () => {
    expect(activePromotion(settings({ expiresOn: "2026-08-10" }), NOW)).toBeNull();
    expect(activePromotion(settings({ expiresOn: "2026-08-11" }), NOW)).not.toBeNull();
    expect(activePromotion(settings({ expiresOn: "" }), NOW)).not.toBeNull();
  });

  it("uses the business calendar day, not UTC", () => {
    // 01:30 UTC on the 12th is still 21:30 on the 11th in Toronto, so an
    // offer expiring on the 11th is still live.
    const lateEvening = Date.parse("2026-08-12T01:30:00Z");
    expect(activePromotion(settings({ expiresOn: "2026-08-11" }), lateEvening)).not.toBeNull();
  });
});

describe("resolveActivePromotion", () => {
  it("matches the claimed code case-insensitively", () => {
    expect(resolveActivePromotion(settings(), "first10aug26", NOW)?.code).toBe("FIRST10AUG26");
    expect(resolveActivePromotion(settings(), "  FIRST10AUG26 ", NOW)).not.toBeNull();
  });

  it("ignores a claim for a different or missing code", () => {
    expect(resolveActivePromotion(settings(), "FIRST10", NOW)).toBeNull();
    expect(resolveActivePromotion(settings(), undefined, NOW)).toBeNull();
    expect(resolveActivePromotion(settings(), "", NOW)).toBeNull();
  });
});

describe("eligibleBaseCents", () => {
  it("counts only eligible service lines", () => {
    const lines = [
      { serviceId: DETAIL, priceCents: 28000 },
      { serviceId: COATING, priceCents: 90000 },
    ];
    expect(eligibleBaseCents(lines, [DETAIL])).toBe(28000);
  });

  it("excludes add-ons even alongside an eligible service", () => {
    // Add-on lines carry an addonId, never a serviceId.
    const lines = [
      { serviceId: DETAIL, priceCents: 28000 },
      { priceCents: 6000 },
    ];
    expect(eligibleBaseCents(lines, [DETAIL])).toBe(28000);
  });

  it("is zero when nothing in the cart qualifies", () => {
    expect(eligibleBaseCents([{ serviceId: COATING, priceCents: 90000 }], [DETAIL])).toBe(0);
  });
});

describe("promotionDiscountCents", () => {
  it("rounds exactly like the manual invoice discount", () => {
    // 12345 * 10% = 1234.5 → half-up.
    expect(promotionDiscountCents(12345, 1000)).toBe(percentCents(12345, 1000));
    expect(promotionDiscountCents(12345, 1000)).toBe(1235);
  });

  it("never exceeds the base and never goes negative", () => {
    expect(promotionDiscountCents(5000, 10000)).toBe(5000);
    expect(promotionDiscountCents(0, 1000)).toBe(0);
    expect(promotionDiscountCents(5000, 0)).toBe(0);
  });
});

describe("allocateDiscount", () => {
  const ids = ["a", "b", "c"];

  it("splits proportionally and sums to the discount exactly", () => {
    const lines = [
      { serviceId: "a", priceCents: 3333 },
      { serviceId: "b", priceCents: 3333 },
      { serviceId: "c", priceCents: 3334 },
    ];
    const d = promotionDiscountCents(10000, 1000); // 1000
    const alloc = allocateDiscount(lines, ids, d);
    expect(alloc.reduce((s, n) => s + n, 0)).toBe(d);
  });

  it("hands single leftover cents to the largest remainders", () => {
    const lines = [
      { serviceId: "a", priceCents: 1 },
      { serviceId: "b", priceCents: 1 },
      { serviceId: "c", priceCents: 1 },
    ];
    const alloc = allocateDiscount(lines, ids, 2);
    expect(alloc.reduce((s, n) => s + n, 0)).toBe(2);
    // Ties break towards the earlier line, so the split is stable.
    expect(alloc).toEqual([1, 1, 0]);
  });

  it("gives nothing to ineligible lines or add-ons", () => {
    const lines = [
      { serviceId: "a", priceCents: 10000 },
      { serviceId: "zzz", priceCents: 10000 },
      { priceCents: 5000 },
    ];
    const alloc = allocateDiscount(lines, ["a"], 1000);
    expect(alloc).toEqual([1000, 0, 0]);
  });

  it("is a no-op for a zero discount or an empty base", () => {
    const lines = [{ serviceId: "a", priceCents: 10000 }];
    expect(allocateDiscount(lines, ["a"], 0)).toEqual([0]);
    expect(allocateDiscount(lines, ["zzz"], 500)).toEqual([0]);
  });

  it("is deterministic across repeated runs", () => {
    const lines = [
      { serviceId: "a", priceCents: 1999 },
      { serviceId: "b", priceCents: 2001 },
      { serviceId: "c", priceCents: 3000 },
    ];
    const first = allocateDiscount(lines, ids, 700);
    for (let i = 0; i < 5; i++) {
      expect(allocateDiscount(lines, ids, 700)).toEqual(first);
    }
  });
});
