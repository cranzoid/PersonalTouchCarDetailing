import { describe, expect, it } from "vitest";
import { FESTIVE_COATING_OFFER_CENTS, festiveRegularPrices } from "../src/lib/festive-coating-offer";

/**
 * The festive QR offer advertises one $199 price against Crystal's regular
 * $399 (car) and $499 (SUV, pickup, van). The crossed-out figure is a savings
 * claim, so it must come from what the catalogue actually charges.
 */
describe("festiveRegularPrices", () => {
  const larger = ["suv_small", "suv_large", "pickup", "van"].map((vehicleCategory) => ({ vehicleCategory, priceDeltaCents: 10_000 }));

  it("shows each size its own regular price", () => {
    expect(festiveRegularPrices(39_900, larger)).toEqual({ carCents: 39_900, largeCents: 49_900 });
  });

  it("shows the lowest price in a group, so the saving is never overstated", () => {
    const mixed = [...larger.slice(1), { vehicleCategory: "suv_small", priceDeltaCents: 5_000 }];
    expect(festiveRegularPrices(39_900, mixed).largeCents).toBe(44_900);
  });

  it("drops a regular price that would not be a saving", () => {
    expect(festiveRegularPrices(FESTIVE_COATING_OFFER_CENTS, [])).toEqual({ carCents: null, largeCents: null });
    expect(festiveRegularPrices(15_000, larger)).toEqual({ carCents: null, largeCents: 25_000 });
  });

  it("shows nothing when the package has no list price", () => {
    expect(festiveRegularPrices(null, larger)).toEqual({ carCents: null, largeCents: null });
  });
});
