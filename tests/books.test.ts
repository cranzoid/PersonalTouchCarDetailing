import { describe, expect, it } from "vitest";
import {
  computeProfitAndLoss,
  computeTaxPosition,
  dueRecurringBills,
  getPeriodWindow,
  monthKey,
  monthKeysInPeriod,
  monthStartDate,
  priorYearPeriod,
  summarizeExpenses,
  taxIncludedInCents,
  validateExpenseInput,
} from "../src/lib/books";

const TZ = "America/Toronto";

const CATEGORIES = [
  { id: "exc_rent", name: "Rent", isPayroll: false },
  { id: "exc_wages", name: "Worker Pay", isPayroll: true },
  { id: "exc_supplies", name: "Vendor / Supplies", isPayroll: false },
];

describe("getPeriodWindow", () => {
  it("spans a whole business-local month as a half-open range", () => {
    const august = getPeriodWindow("month", 2026, 8, TZ);
    expect(august.label).toBe("August 2026");
    // Midnight local on 1 Aug is 04:00 UTC during EDT.
    expect(august.start.toISOString()).toBe("2026-08-01T04:00:00.000Z");
    expect(august.end.toISOString()).toBe("2026-09-01T04:00:00.000Z");
  });

  it("rolls December into the next year", () => {
    const december = getPeriodWindow("month", 2026, 12, TZ);
    expect(december.end.toISOString()).toBe("2027-01-01T05:00:00.000Z");
  });

  it("keeps both ends at true local midnight across a DST change", () => {
    // March 2026 contains the spring-forward, so the month is 743 hours, not 744.
    const march = getPeriodWindow("month", 2026, 3, TZ);
    expect(march.start.toISOString()).toBe("2026-03-01T05:00:00.000Z");
    expect(march.end.toISOString()).toBe("2026-04-01T04:00:00.000Z");
    const hours = (march.end.getTime() - march.start.getTime()) / 3_600_000;
    expect(hours).toBe(743);
  });

  it("builds calendar quarters and years", () => {
    const q4 = getPeriodWindow("quarter", 2026, 4, TZ);
    expect(q4.label).toBe("Q4 2026");
    expect(q4.start.toISOString()).toBe("2026-10-01T04:00:00.000Z");
    expect(q4.end.toISOString()).toBe("2027-01-01T05:00:00.000Z");

    const year = getPeriodWindow("year", 2026, 1, TZ);
    expect(year.label).toBe("2026");
    expect(year.start.toISOString()).toBe("2026-01-01T05:00:00.000Z");
    expect(year.end.toISOString()).toBe("2027-01-01T05:00:00.000Z");
  });

  it("rejects out-of-range indexes", () => {
    expect(() => getPeriodWindow("month", 2026, 13, TZ)).toThrow();
    expect(() => getPeriodWindow("quarter", 2026, 5, TZ)).toThrow();
  });

  it("steps back exactly one year for comparison", () => {
    const previous = priorYearPeriod(getPeriodWindow("month", 2026, 8, TZ), TZ);
    expect(previous.label).toBe("August 2025");
  });

  it("enumerates the months a period covers", () => {
    expect(monthKeysInPeriod(getPeriodWindow("month", 2026, 8, TZ))).toEqual(["2026-08"]);
    expect(monthKeysInPeriod(getPeriodWindow("quarter", 2026, 2, TZ))).toEqual([
      "2026-04", "2026-05", "2026-06",
    ]);
    expect(monthKeysInPeriod(getPeriodWindow("year", 2026, 1, TZ))).toHaveLength(12);
  });

  it("derives the month key from business-local time, not UTC", () => {
    // 31 Aug 2026 21:00 EDT is 1 Sep 01:00 UTC — the month must still be August.
    expect(monthKey(new Date("2026-09-01T01:00:00Z"), TZ)).toBe("2026-08");
  });

  it("puts a generated bill on the first local day of its month", () => {
    expect(monthStartDate("2026-08", TZ).toISOString()).toBe("2026-08-01T04:00:00.000Z");
  });
});

describe("summarizeExpenses", () => {
  it("totals by category and sums input tax credits", () => {
    const summary = summarizeExpenses(
      [
        { categoryId: "exc_rent", amountCents: 250_000, taxPaidCents: 0 },
        { categoryId: "exc_supplies", amountCents: 11_300, taxPaidCents: 1_300 },
        { categoryId: "exc_supplies", amountCents: 5_650, taxPaidCents: 650 },
        { categoryId: "exc_wages", amountCents: 90_000, taxPaidCents: 0 },
      ],
      CATEGORIES,
    );

    expect(summary.totalCents).toBe(356_950);
    expect(summary.inputTaxCreditCents).toBe(1_950);
    expect(summary.count).toBe(4);
    expect(summary.byCategory[0]).toMatchObject({ name: "Rent", amountCents: 250_000 });
    expect(summary.byCategory.find((c) => c.name === "Vendor / Supplies")).toMatchObject({
      amountCents: 16_950,
      taxPaidCents: 1_950,
      count: 2,
    });
  });

  it("still reports an expense whose category was deleted or renamed away", () => {
    const summary = summarizeExpenses(
      [{ categoryId: "exc_gone", amountCents: 4_200, taxPaidCents: 0 }],
      CATEGORIES,
    );
    expect(summary.totalCents).toBe(4_200);
    expect(summary.byCategory[0].name).toBe("Uncategorized");
  });
});

describe("computeProfitAndLoss", () => {
  const expenses = summarizeExpenses(
    [{ categoryId: "exc_rent", amountCents: 250_000, taxPaidCents: 0 }],
    CATEGORIES,
  );

  it("nets sales of tax, subtracts expenses, and reports margin", () => {
    const pnl = computeProfitAndLoss(
      [
        // 500.00 of work, 50.00 off, 58.50 HST on the 450.00 balance.
        { status: "paid", subtotalCents: 50_000, discountCents: 5_000, taxCents: 5_850 },
        { status: "sent", subtotalCents: 30_000, discountCents: 0, taxCents: 3_900 },
      ],
      expenses,
    );

    expect(pnl.netSalesCents).toBe(75_000);
    expect(pnl.taxCollectedCents).toBe(9_750);
    expect(pnl.grossSalesCents).toBe(84_750);
    expect(pnl.discountsGivenCents).toBe(5_000);
    expect(pnl.netProfitCents).toBe(75_000 - 250_000);
    expect(pnl.profitMargin).toBeCloseTo(-2.3333, 4);
  });

  it("ignores draft and cancelled invoices", () => {
    const pnl = computeProfitAndLoss(
      [
        { status: "draft", subtotalCents: 99_999, discountCents: 0, taxCents: 9_999 },
        { status: "cancelled", subtotalCents: 88_888, discountCents: 0, taxCents: 8_888 },
        { status: "paid", subtotalCents: 10_000, discountCents: 0, taxCents: 1_300 },
      ],
      expenses,
    );
    expect(pnl.invoiceCount).toBe(1);
    expect(pnl.netSalesCents).toBe(10_000);
  });

  it("reports no margin rather than 0% when nothing was sold", () => {
    const pnl = computeProfitAndLoss([], expenses);
    expect(pnl.netSalesCents).toBe(0);
    expect(pnl.profitMargin).toBeNull();
    expect(pnl.netProfitCents).toBe(-250_000);
  });

  it("nets tax collected against input credits, and reports a refund as negative", () => {
    const owing = computeTaxPosition(
      computeProfitAndLoss([{ status: "paid", subtotalCents: 10_000, discountCents: 0, taxCents: 1_300 }], expenses),
    );
    expect(owing.netOwingCents).toBe(1_300);

    const refund = computeTaxPosition(
      computeProfitAndLoss(
        [],
        summarizeExpenses([{ categoryId: "exc_supplies", amountCents: 11_300, taxPaidCents: 1_300 }], CATEGORIES),
      ),
    );
    expect(refund.collectedCents).toBe(0);
    expect(refund.netOwingCents).toBe(-1_300);
  });
});

describe("dueRecurringBills", () => {
  const bills = [
    { id: "a", active: true, startMonth: "2026-01", endMonth: null },
    { id: "b", active: false, startMonth: "2026-01", endMonth: null },
    { id: "c", active: true, startMonth: "2026-09", endMonth: null },
    { id: "d", active: true, startMonth: "2026-01", endMonth: "2026-07" },
    { id: "e", active: true, startMonth: "2026-08", endMonth: "2026-08" },
  ];

  it("returns only active bills whose window covers the month", () => {
    expect(dueRecurringBills(bills, "2026-08").map((bill) => bill.id)).toEqual(["a", "e"]);
  });

  it("excludes a bill that has not started and one that has ended", () => {
    expect(dueRecurringBills(bills, "2026-07").map((bill) => bill.id)).toEqual(["a", "d"]);
    expect(dueRecurringBills(bills, "2026-09").map((bill) => bill.id)).toEqual(["a", "c"]);
  });

  it("rejects a malformed month key rather than silently matching nothing", () => {
    expect(() => dueRecurringBills(bills, "2026-13")).toThrow();
    expect(() => dueRecurringBills(bills, "2026-8")).toThrow();
  });
});

describe("validateExpenseInput", () => {
  const rent = { isPayroll: false };
  const wages = { isPayroll: true };
  const base = { categoryId: "exc_rent", amountCents: 1_000, taxPaidCents: 0, staffUserId: null };

  it("accepts a well-formed expense", () => {
    expect(validateExpenseInput(base, rent)).toBeNull();
  });

  it("blocks a missing category, a zero amount and a negative amount", () => {
    expect(validateExpenseInput(base, undefined)).toBe("Pick a category");
    expect(validateExpenseInput({ ...base, amountCents: 0 }, rent)).toBe("Enter an amount");
    expect(validateExpenseInput({ ...base, amountCents: -1 }, rent)).toBe("Enter an amount");
  });

  it("requires a staff member on a payroll expense", () => {
    expect(validateExpenseInput(base, wages)).toBe("Who was paid?");
    expect(validateExpenseInput({ ...base, staffUserId: "usr_1" }, wages)).toBeNull();
  });

  it("refuses tax larger than the amount it was paid on", () => {
    expect(validateExpenseInput({ ...base, taxPaidCents: 1_001 }, rent)).toBe(
      "Tax paid cannot exceed the amount",
    );
    expect(validateExpenseInput({ ...base, taxPaidCents: -1 }, rent)).toBe(
      "Tax paid cannot be negative",
    );
  });
});

describe("taxIncludedInCents", () => {
  it("backs HST out of a tax-inclusive receipt total", () => {
    // $113.00 paid at 13% contains $13.00 of HST, not $14.69.
    expect(taxIncludedInCents(11_300, 1_300)).toBe(1_300);
    expect(taxIncludedInCents(25_000, 1_300)).toBe(2_876);
  });

  it("is zero for a zero amount or an untaxed purchase", () => {
    expect(taxIncludedInCents(0, 1_300)).toBe(0);
    expect(taxIncludedInCents(11_300, 0)).toBe(0);
    expect(taxIncludedInCents(-500, 1_300)).toBe(0);
  });
});
