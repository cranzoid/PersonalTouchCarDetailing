import { describe, expect, it } from "vitest";
import { computeEstimateTotals } from "../src/lib/estimates";

const line = (unitPriceCents: number, opts: Partial<{ quantity: number; isOptional: boolean; isSelected: boolean }> = {}) => ({
  quantity: opts.quantity ?? 1,
  unitPriceCents,
  isOptional: opts.isOptional ?? false,
  isSelected: opts.isSelected ?? true,
});

describe("computeEstimateTotals", () => {
  it("sums required lines with quantity and applies HST", () => {
    const t = computeEstimateTotals([line(15000), line(5000, { quantity: 2 })], 0, 1300);
    expect(t.subtotalCents).toBe(25000);
    expect(t.taxCents).toBe(3250);
    expect(t.totalCents).toBe(28250);
  });

  it("excludes optional lines that are not selected", () => {
    const t = computeEstimateTotals(
      [line(10000), line(5000, { isOptional: true, isSelected: false }), line(2000, { isOptional: true, isSelected: true })],
      0,
      1300,
    );
    expect(t.subtotalCents).toBe(12000);
  });

  it("applies discount before tax and clamps it to the subtotal", () => {
    const t = computeEstimateTotals([line(10000)], 2500, 1300);
    expect(t.discountCents).toBe(2500);
    expect(t.taxCents).toBe(975); // 13% of 7500
    expect(t.totalCents).toBe(8475);

    const clamped = computeEstimateTotals([line(1000)], 99999, 1300);
    expect(clamped.discountCents).toBe(1000);
    expect(clamped.totalCents).toBe(0);
  });

  it("never produces a negative discount", () => {
    const t = computeEstimateTotals([line(1000)], -500, 1300);
    expect(t.discountCents).toBe(0);
    expect(t.totalCents).toBe(1130);
  });

  it("rounds tax half-up per total, not per line", () => {
    // 3 lines of $0.05 → subtotal 15¢ → 13% = 1.95¢ → rounds to 2¢
    const t = computeEstimateTotals([line(5), line(5), line(5)], 0, 1300);
    expect(t.taxCents).toBe(2);
  });
});
