import { describe, expect, it } from "vitest";
import { computeTotals } from "../src/lib/pricing";
import { computeInvoiceTotals } from "../src/lib/invoices";
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

  it("applies a discount before tax, not after", () => {
    const t = computeTotals(lines, 1300, 0, { cents: 4180 }); // 10% of 41800
    expect(t.subtotalCents).toBe(41800); // subtotal stays gross
    expect(t.discountCents).toBe(4180);
    expect(t.taxCents).toBe(4891); // 13% of 37620
    // The whole point: taxing the gross would give 5434.
    expect(t.taxCents).not.toBe(5434);
    expect(t.totalCents).toBe(42511);
  });

  it("clamps a discount larger than the subtotal", () => {
    const t = computeTotals(lines, 1300, 0, { cents: 999_999 });
    expect(t.discountCents).toBe(41800);
    expect(t.taxCents).toBe(0);
    expect(t.totalCents).toBe(0);
  });

  it("never lets the deposit exceed what is owed", () => {
    // A fixed deposit larger than a heavily discounted total.
    const t = computeTotals(lines, 1300, 50000, { cents: 41800 });
    expect(t.totalCents).toBe(0);
    expect(t.depositRequiredCents).toBe(0);
  });

  it("carries the promo code and label through", () => {
    const t = computeTotals(lines, 1300, 0, { cents: 100, code: "FIRST10AUG26", label: "First Detail Offer" });
    expect(t.promoCode).toBe("FIRST10AUG26");
    expect(t.promoLabel).toBe("First Detail Offer");
  });

  it("defaults to no discount so existing callers are unaffected", () => {
    const t = computeTotals(lines, 1300);
    expect(t.discountCents).toBe(0);
    expect(t.promoCode).toBeNull();
    expect(t.totalCents).toBe(47234);
  });
});

/**
 * The booking total and the invoice it later becomes must agree to the cent —
 * otherwise a deposit paid against the appointment cannot reconcile with the
 * final bill. This pins the two implementations together permanently.
 */
describe("booking/invoice parity", () => {
  const cases = [
    { price: 41800, discount: 4180, rate: 1300 },
    { price: 29900, discount: 0, rate: 1300 },
    { price: 3333, discount: 333, rate: 1300 },
    { price: 12500, discount: 12500, rate: 1300 },
    { price: 50000, discount: 5000, rate: 0 },
  ];

  for (const { price, discount, rate } of cases) {
    it(`agrees for ${price} less ${discount} at ${rate}bp`, () => {
      const booking = computeTotals(
        [{ description: "Service", priceCents: price, durationMin: 60 }],
        rate,
        0,
        { cents: discount },
      );
      const invoice = computeInvoiceTotals([{ quantity: 1, unitPriceCents: price }], discount, rate);
      expect(booking.subtotalCents).toBe(invoice.subtotalCents);
      expect(booking.discountCents).toBe(invoice.discountCents);
      expect(booking.taxCents).toBe(invoice.taxCents);
      expect(booking.totalCents).toBe(invoice.totalCents);
    });
  }
});
