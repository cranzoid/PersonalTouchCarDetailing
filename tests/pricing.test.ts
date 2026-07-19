import { describe, expect, it } from "vitest";
import { computeTotals } from "../src/lib/pricing";
import { taxCents, percentCents } from "../src/lib/money";

describe("taxCents", () => {
  it("computes 13% Ontario HST", () => {
    expect(taxCents(10000, 1300)).toBe(1300); // $100 → $13.00
    expect(taxCents(18900, 1300)).toBe(2457); // $189 → $24.57
  });
  it("rounds half-up to the nearest cent", () => {
    // 3.5 cents → 4
    expect(taxCents(27, 1300)).toBe(4); // 27 * 0.13 = 3.51
    expect(taxCents(11, 1300)).toBe(1); // 1.43 → 1
  });
  it("handles zero rate", () => {
    expect(taxCents(10000, 0)).toBe(0);
  });
});

describe("percentCents", () => {
  it("computes percentage deposits", () => {
    expect(percentCents(30000, 2500)).toBe(7500); // 25% of $300
  });
});

describe("computeTotals", () => {
  const lines = [
    { description: "Full Detailing", priceCents: 29900, durationMin: 300 },
    { description: "Large SUV adjustment", priceCents: 4000, durationMin: 60 },
    { description: "Headlight Restoration", priceCents: 7900, durationMin: 45 },
  ];

  it("sums subtotal, tax, total and duration", () => {
    const t = computeTotals(lines, 1300);
    expect(t.subtotalCents).toBe(41800);
    expect(t.taxCents).toBe(5434);
    expect(t.totalCents).toBe(47234);
    expect(t.durationMin).toBe(405);
  });

  it("passes deposit through", () => {
    const t = computeTotals(lines, 1300, 5000);
    expect(t.depositRequiredCents).toBe(5000);
  });

  it("uses integer cents exclusively", () => {
    const t = computeTotals([{ description: "x", priceCents: 3333, durationMin: 10 }], 1300);
    expect(Number.isInteger(t.taxCents)).toBe(true);
    expect(t.taxCents).toBe(433); // 3333 * 0.13 = 433.29
  });
});
