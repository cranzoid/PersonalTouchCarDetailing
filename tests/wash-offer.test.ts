import { describe, expect, it } from "vitest";
import {
  activeWashOffer,
  claimCodeFromBytes,
  claimExpiresAt,
  formatClaimCode,
  normalizeClaimCode,
  normalizePlate,
  resolveWashOfferCode,
  washOfferAllocation,
  washOfferPriceCents,
} from "../src/lib/wash-offer";
import { bestOfAllocations } from "../src/lib/bundle-offers";
import { SETTINGS_DEFAULTS } from "../src/lib/settings";

/**
 * The new-customer wash offer's money and expiry rules.
 *
 * The offer charges $15.99 for a car and $17.99 for anything larger against
 * catalogue prices of $30 and $35. No single percentage produces both figures,
 * which is the whole reason this is a fixed PRICE turned into a discount rather
 * than a rate — so the arithmetic below is the part that must not drift.
 */

const WASH = "svc_wash";
const DETAIL = "svc_detail";

function settings(overrides: Partial<typeof SETTINGS_DEFAULTS.washOffer> = {}) {
  return {
    timezone: "America/Toronto",
    washOffer: { ...SETTINGS_DEFAULTS.washOffer, enabled: true, ...overrides },
  };
}

// Mid-morning in Toronto, safely inside the same calendar day either side of
// the DST boundary — the same fixture the promotion tests use.
const NOW = Date.parse("2026-09-12T12:00:00Z");

describe("activeWashOffer", () => {
  it("returns the offer when it is running", () => {
    expect(activeWashOffer(settings(), NOW)?.code).toBe("FIRSTWASH26");
  });

  it("fails closed when disabled", () => {
    expect(activeWashOffer(settings({ enabled: false }), NOW)).toBeNull();
  });

  it("fails closed with no eligible vehicle price", () => {
    // An empty map must mean "no vehicle qualifies", never "every vehicle".
    expect(activeWashOffer(settings({ priceCentsByCategory: {} }), NOW)).toBeNull();
  });

  it("fails closed without a service to buy", () => {
    expect(activeWashOffer(settings({ serviceSlug: "  " }), NOW)).toBeNull();
  });

  it("fails closed when a code was never configured", () => {
    expect(activeWashOffer(settings({ code: "" }), NOW)).toBeNull();
  });

  it("drops prices that are zero, negative or not whole cents", () => {
    const offer = activeWashOffer(
      settings({ priceCentsByCategory: { sedan: 1599, coupe: 0, van: -100, pickup: 17.5 } }),
      NOW,
    );
    expect(offer?.priceCentsByCategory).toEqual({ sedan: 1599 });
  });

  it("stops NEW claims after the closing day, in the business timezone", () => {
    expect(activeWashOffer(settings({ claimsCloseOn: "2026-09-11" }), NOW)?.acceptingClaims).toBe(false);
    expect(activeWashOffer(settings({ claimsCloseOn: "2026-09-12" }), NOW)?.acceptingClaims).toBe(true);
    // 01:30 UTC on the 13th is still 21:30 on the 12th in Toronto.
    const lateEvening = Date.parse("2026-09-13T01:30:00Z");
    expect(activeWashOffer(settings({ claimsCloseOn: "2026-09-12" }), lateEvening)?.acceptingClaims).toBe(true);
  });

  it("keeps the offer itself alive after claims close", () => {
    // A code already in somebody's hand must still be honoured — withdrawing a
    // coupon from the person holding it is exactly what this must not do.
    expect(activeWashOffer(settings({ claimsCloseOn: "2026-01-01" }), NOW)).not.toBeNull();
  });
});

describe("resolveWashOfferCode", () => {
  it("matches the campaign code case-insensitively", () => {
    expect(resolveWashOfferCode(settings(), "firstwash26", NOW)?.code).toBe("FIRSTWASH26");
  });
  it("ignores a code for a different campaign", () => {
    expect(resolveWashOfferCode(settings(), "SOMETHINGELSE", NOW)).toBeNull();
  });
  it("ignores no code at all", () => {
    expect(resolveWashOfferCode(settings(), undefined, NOW)).toBeNull();
  });
});

describe("washOfferPriceCents", () => {
  const offer = activeWashOffer(settings(), NOW)!;

  it("prices a car and a large vehicle differently", () => {
    expect(washOfferPriceCents(offer, "sedan")).toBe(1599);
    expect(washOfferPriceCents(offer, "coupe")).toBe(1599);
    expect(washOfferPriceCents(offer, "suv_small")).toBe(1799);
    expect(washOfferPriceCents(offer, "suv_large")).toBe(1799);
    expect(washOfferPriceCents(offer, "pickup")).toBe(1799);
    expect(washOfferPriceCents(offer, "van")).toBe(1799);
  });

  it("does not cover a commercial vehicle", () => {
    // The catalogue quotes commercial work individually, so a fixed promo price
    // could not be honest about it.
    expect(washOfferPriceCents(offer, "commercial")).toBeNull();
  });
});

describe("washOfferAllocation", () => {
  const lines = [
    { serviceId: WASH, priceCents: 3000 },
    { serviceId: DETAIL, priceCents: 20000 },
  ];

  it("discounts the catalogue price down to the promo price", () => {
    const { allocation, applies } = washOfferAllocation(lines, { serviceId: WASH, promoPriceCents: 1599 });
    expect(applies).toBe(true);
    expect(allocation).toEqual([1401, 0]);
    // The point of the whole exercise: the customer pays the advertised figure.
    expect(lines[0].priceCents - allocation[0]).toBe(1599);
  });

  it("reaches $17.99 from the large-vehicle catalogue price", () => {
    const large = [{ serviceId: WASH, priceCents: 3500 }];
    const { allocation } = washOfferAllocation(large, { serviceId: WASH, promoPriceCents: 1799 });
    expect(large[0].priceCents - allocation[0]).toBe(1799);
  });

  it("touches nothing when the wash is not in the cart", () => {
    const { allocation, applies } = washOfferAllocation(
      [{ serviceId: DETAIL, priceCents: 20000 }],
      { serviceId: WASH, promoPriceCents: 1599 },
    );
    expect(applies).toBe(false);
    expect(allocation).toEqual([0]);
  });

  it("never goes negative when the catalogue price is already lower", () => {
    const cheap = [{ serviceId: WASH, priceCents: 1000 }];
    const { allocation, applies } = washOfferAllocation(cheap, { serviceId: WASH, promoPriceCents: 1599 });
    expect(applies).toBe(false);
    expect(allocation).toEqual([0]);
  });

  it("buys one wash, not every wash line in the cart", () => {
    const two = [
      { serviceId: WASH, priceCents: 3000 },
      { serviceId: WASH, priceCents: 3000 },
    ];
    const { allocation } = washOfferAllocation(two, { serviceId: WASH, promoPriceCents: 1599 });
    expect(allocation).toEqual([1401, 0]);
  });

  it("ignores add-on lines, which carry no service id", () => {
    const withAddon = [
      { serviceId: WASH, priceCents: 3000 },
      { priceCents: 12000 },
    ];
    const { allocation } = washOfferAllocation(withAddon, { serviceId: WASH, promoPriceCents: 1599 });
    expect(allocation).toEqual([1401, 0]);
  });
});

describe("bestOfAllocations", () => {
  it("takes the single largest saving per line — offers never stack", () => {
    const resolved = bestOfAllocations([
      { key: "wash", allocation: [1401, 0] },
      { key: "bundle", allocation: [0, 10000] },
      { key: "campaign", allocation: [300, 2000] },
    ]);
    expect(resolved.allocation).toEqual([1401, 10000]);
    expect([...resolved.contributing].sort()).toEqual(["bundle", "wash"]);
  });

  it("gives a tie to the earlier source, so precedence is the caller's choice", () => {
    const resolved = bestOfAllocations([
      { key: "wash", allocation: [500] },
      { key: "campaign", allocation: [500] },
    ]);
    expect(resolved.allocation).toEqual([500]);
    expect([...resolved.contributing]).toEqual(["wash"]);
  });

  it("reports nothing contributing when every offer is worth zero", () => {
    const resolved = bestOfAllocations([{ key: "wash", allocation: [0, 0] }]);
    expect(resolved.allocation).toEqual([0, 0]);
    expect(resolved.contributing.size).toBe(0);
  });
});

describe("claimExpiresAt", () => {
  it("runs for the configured number of days", () => {
    const offer = activeWashOffer(settings({ claimValidDays: 14 }), NOW)!;
    expect(claimExpiresAt(offer, NOW).getTime()).toBe(NOW + 14 * 86_400_000);
  });
});

describe("codes and plates", () => {
  it("builds a readable code with no ambiguous characters", () => {
    const code = claimCodeFromBytes(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]));
    expect(code).toMatch(/^PTW[23456789ABCDEFGHJKMNPQRTVWXYZ]{6}$/);
    // The characters a customer would misread off a phone screen are absent.
    expect(code).not.toMatch(/[ILOSU01]/);
  });

  it("formats for reading and normalizes for matching", () => {
    expect(formatClaimCode("PTW7QK2MB")).toBe("PTW-7QK2MB");
    expect(normalizeClaimCode("ptw-7qk2mb")).toBe("PTW7QK2MB");
    expect(normalizeClaimCode(" ptw 7qk2mb ")).toBe("PTW7QK2MB");
    expect(normalizeClaimCode("no")).toBeNull();
    expect(normalizeClaimCode(null)).toBeNull();
  });

  it("treats one plate written three ways as one plate", () => {
    expect(normalizePlate("CABC 123")).toBe("CABC123");
    expect(normalizePlate("cabc-123")).toBe("CABC123");
    expect(normalizePlate(" CABC123 ")).toBe("CABC123");
  });

  it("returns null for a plate with nothing in it", () => {
    expect(normalizePlate("   ")).toBeNull();
    expect(normalizePlate("---")).toBeNull();
    expect(normalizePlate(undefined)).toBeNull();
  });
});
