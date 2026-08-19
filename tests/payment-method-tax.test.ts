import { describe, expect, it } from "vitest";
import {
  computeInvoiceTotals,
  isPaymentMethodTaxable,
  noTaxReasonForMethod,
  paymentMethodConflict,
  resolvePaymentTax,
} from "../src/lib/invoices";
import { PAYMENT_METHOD_TAXABLE, QUOTED_PAYMENT_METHODS } from "../src/lib/types";
import { buildAttentionQueue } from "../src/lib/attention";
import { duplicatePhoneNumbers, formatPhone, normalizePhone } from "../src/lib/phone";
import { dualPriceLabel, formatCents, withTaxCents } from "../src/lib/money";

const HST = 1300;

describe("PAYMENT_METHOD_TAXABLE", () => {
  it("matches the owner's rule: cash and Interac untaxed, credit and cheque taxed", () => {
    expect(PAYMENT_METHOD_TAXABLE).toEqual({
      cash: false,
      etransfer: false,
      card_terminal: true,
      stripe: true,
      cheque: true,
    });
  });

  it("covers every method staff can choose, so no invoice falls through the map", () => {
    for (const method of QUOTED_PAYMENT_METHODS) {
      expect(PAYMENT_METHOD_TAXABLE[method]).toBeTypeOf("boolean");
    }
  });

  it("treats an unknown provider as taxable, because under-reporting HST is the worse error", () => {
    expect(isPaymentMethodTaxable("fake")).toBe(true);
    expect(isPaymentMethodTaxable("crypto_someday")).toBe(true);
  });

  it("reads Interac as e-transfer, not as debit at the card terminal", () => {
    expect(isPaymentMethodTaxable("etransfer")).toBe(false);
    expect(isPaymentMethodTaxable("card_terminal")).toBe(true);
  });
});

const LINES = [
  { quantity: 1, unitPriceCents: 17500 }, // Package #2, sedan
  { quantity: 1, unitPriceCents: 12000 }, // Wax / Buff add-on
];
const DISCOUNT = 2950; // 10% of 29500

/** An invoice as issued: full price, tax on, nobody has paid yet. */
const issued = {
  taxCents: 3452,
  totalCents: 30002,
  taxExempt: false,
  taxTreatment: "added",
  quotedPaymentMethod: null as string | null,
};

describe("the spec §4.1 worked example", () => {
  it("issues at 300.02 — discount before tax, tax on, because nobody has paid yet", () => {
    const totals = computeInvoiceTotals(LINES, DISCOUNT, HST);
    expect(totals.subtotalCents).toBe(29500);
    expect(totals.discountCents).toBe(2950);
    expect(totals.taxCents).toBe(3452);
    expect(totals.totalCents).toBe(30002);
    // Taxing the gross first would give 3835 and the customer would overpay.
  });

  it("drops to 265.50 the moment the customer pays cash", () => {
    const outcome = resolvePaymentTax({
      invoice: issued, method: "cash", taxLabel: "HST", alreadyPaidAgainst: false,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.totalCents).toBe(26550);
    expect(outcome.changes).toEqual({
      taxRateBp: 0,
      taxCents: 0,
      totalCents: 26550,
      taxExempt: true,
      taxExemptReason: "Cash sale — no HST charged",
      taxTreatment: "none",
      quotedPaymentMethod: "cash",
    });
  });

  it("stays at 300.02 when they pay by card", () => {
    const outcome = resolvePaymentTax({
      invoice: issued, method: "card_terminal", taxLabel: "HST", alreadyPaidAgainst: false,
    });
    if (!outcome.ok) return expect.fail("should not conflict");
    expect(outcome.totalCents).toBe(30002);
    // Only the method is stamped — the rate the invoice was issued at is not
    // ours to substitute, so a zero-rated appointment stays zero-rated.
    expect(outcome.changes).toEqual({ taxTreatment: "added", quotedPaymentMethod: "card_terminal" });
  });
});

describe("resolvePaymentTax", () => {
  it("treats e-transfer exactly like cash, and cheque exactly like card", () => {
    for (const method of ["cash", "etransfer"] as const) {
      const o = resolvePaymentTax({ invoice: issued, method, taxLabel: "HST", alreadyPaidAgainst: false });
      expect(o.ok && o.totalCents).toBe(26550);
    }
    for (const method of ["cheque", "card_terminal", "stripe"] as const) {
      const o = resolvePaymentTax({ invoice: issued, method, taxLabel: "HST", alreadyPaidAgainst: false });
      expect(o.ok && o.totalCents).toBe(30002);
    }
  });

  it("strips tax by subtracting the snapshot, so an invoice with no lines is never zeroed", () => {
    // Recomputing from line items would write $0.00 onto a real document if the
    // lines were ever missing. total − tax is exact and cannot do that.
    const noLines = { ...issued, taxCents: 3452, totalCents: 30002 };
    const o = resolvePaymentTax({ invoice: noLines, method: "cash", taxLabel: "HST", alreadyPaidAgainst: false });
    expect(o.ok && o.totalCents).toBe(26550);
  });

  it("never re-prices an invoice that already has a payment against it", () => {
    // Re-pricing underneath a customer who has paid part of a taxed total is
    // worse than the inconsistency it fixes. Also covers every invoice
    // part-paid before this rule existed.
    const outcome = resolvePaymentTax({
      invoice: issued, method: "cash", taxLabel: "HST", alreadyPaidAgainst: true,
    });
    if (!outcome.ok) return expect.fail("legacy part-paid invoices must not be blocked");
    expect(outcome.totalCents).toBe(30002);
    expect(outcome.changes).toBeNull();
  });

  it("leaves a staff exemption alone and binds nobody to a method", () => {
    const exempt = { ...issued, taxExempt: true, taxTreatment: "none", taxCents: 0, totalCents: 26550 };
    const outcome = resolvePaymentTax({
      invoice: exempt, method: "card_terminal", taxLabel: "HST", alreadyPaidAgainst: false,
    });
    if (!outcome.ok) return expect.fail("a staff exemption must not block any method");
    expect(outcome.changes).toBeNull();
    // Keeps the restatement query pointed at payment-method sales only.
    expect(exempt.quotedPaymentMethod).toBeNull();
  });

  it("holds the answer steady once a first payment has settled it", () => {
    const settledCash = { ...issued, taxTreatment: "none", taxCents: 0, totalCents: 26550, quotedPaymentMethod: "cash" };
    const blocked = resolvePaymentTax({
      invoice: settledCash, method: "card_terminal", taxLabel: "HST", alreadyPaidAgainst: true,
    });
    expect(blocked.ok).toBe(false);
    if (blocked.ok) return;
    expect(blocked.conflict).toContain("already part-paid");

    const allowed = resolvePaymentTax({
      invoice: settledCash, method: "etransfer", taxLabel: "HST", alreadyPaidAgainst: true,
    });
    expect(allowed.ok).toBe(true);
  });

  it("names the method in the reason so the tax report separates cash from e-transfer", () => {
    expect(noTaxReasonForMethod("cash", "HST")).toBe("Cash sale — no HST charged");
    expect(noTaxReasonForMethod("etransfer", "HST")).toBe("Interac e-transfer sale — no HST charged");
  });
});

describe("paymentMethodConflict", () => {
  it("says nothing about an invoice nobody has paid yet — the method is still free", () => {
    expect(paymentMethodConflict({ taxTreatment: "added", quotedPaymentMethod: null }, "cash", "HST")).toBeNull();
  });

  it("blocks the opposite method once one has settled it, in both directions", () => {
    const cash = { taxTreatment: "none", quotedPaymentMethod: "cash" };
    const card = { taxTreatment: "added", quotedPaymentMethod: "card_terminal" };
    expect(paymentMethodConflict(cash, "cheque", "HST")).toContain("already part-paid");
    expect(paymentMethodConflict(card, "cash", "HST")).toContain("already part-paid");
    expect(paymentMethodConflict(cash, "etransfer", "HST")).toBeNull();
    expect(paymentMethodConflict(card, "stripe", "HST")).toBeNull();
  });

  it("leaves pre-Release-3 invoices alone, so open invoices stay payable across the swap", () => {
    const legacy = { taxTreatment: "added", quotedPaymentMethod: null };
    for (const method of QUOTED_PAYMENT_METHODS) {
      expect(paymentMethodConflict(legacy, method, "HST")).toBeNull();
    }
  });
});

describe("dual pricing", () => {
  it("shows Package #2 on a sedan as $175.00 cash and $197.75 card", () => {
    expect(formatCents(17500)).toBe("$175.00");
    expect(formatCents(withTaxCents(17500, HST))).toBe("$197.75");
    expect(dualPriceLabel(17500, HST)).toBe("$175.00 cash · $197.75 card");
  });

  it("collapses to one price when nothing is taxed", () => {
    expect(dualPriceLabel(17500, 0)).toBe("$175.00");
  });
});

describe("normalizePhone", () => {
  it("reduces every way a Hamilton number gets typed to the same digits", () => {
    for (const raw of ["(905) 555-1234", "905-555-1234", "905.555.1234", "9055551234", "905 555 1234"]) {
      expect(normalizePhone(raw)).toBe("9055551234");
    }
  });

  it("drops a leading North American country code so +1 forms match", () => {
    expect(normalizePhone("+1 905 555 1234")).toBe("9055551234");
    expect(normalizePhone("1-905-555-1234")).toBe("9055551234");
  });

  it("leaves a number that is not ten-plus-one digits as bare digits", () => {
    expect(normalizePhone("555-1234")).toBe("5551234");
    expect(normalizePhone("011 44 20 7946 0958")).toBe("011442079460958");
  });

  it("returns null for nothing, so two blank records never match each other", () => {
    expect(normalizePhone(null)).toBeNull();
    expect(normalizePhone("")).toBeNull();
    expect(normalizePhone("   ")).toBeNull();
    expect(normalizePhone("no digits here")).toBeNull();
  });

  it("formats a ten-digit number for display and passes anything else through", () => {
    expect(formatPhone("9055551234")).toBe("(905) 555-1234");
    expect(formatPhone("+1 905 555 1234")).toBe("(905) 555-1234");
    expect(formatPhone("555-1234")).toBe("555-1234");
    expect(formatPhone(null)).toBe("");
  });
});

describe("duplicatePhoneNumbers", () => {
  it("flags a number held by two live customers", () => {
    const dupes = duplicatePhoneNumbers([
      { phoneNormalized: "9055551234" },
      { phoneNormalized: "9055551234" },
      { phoneNormalized: "9055559999" },
    ]);
    expect([...dupes]).toEqual(["9055551234"]);
  });

  it("ignores anonymized records and customers with no number", () => {
    const dupes = duplicatePhoneNumbers([
      { phoneNormalized: "9055551234" },
      { phoneNormalized: "9055551234", anonymizedAt: new Date() },
      { phoneNormalized: null },
      { phoneNormalized: null },
    ]);
    expect(dupes.size).toBe(0);
  });
});

describe("buildAttentionQueue", () => {
  it("lists cars handed back but never invoiced — money not yet asked for", () => {
    const queue = buildAttentionQueue({
      uninvoicedJobs: [{ id: "job_1", vehicleLabel: "2021 Toyota Highlander", readySinceLabel: "Aug 14" }],
    });
    expect(queue.total).toBe(1);
    expect(queue.items[0]!.kind).toBe("uninvoiced_job");
    expect(queue.items[0]!.label).toContain("never invoiced");
    expect(queue.items[0]!.href).toBe("/admin/jobs/job_1");
  });

  it("is empty when the shop is tidy, so the card does not render at all", () => {
    const queue = buildAttentionQueue({ uninvoicedJobs: [] });
    expect(queue.total).toBe(0);
    expect(queue.items).toEqual([]);
  });

  it("never flags a discount, however large and however unexplained", () => {
    // Built, shipped and withdrawn the same day: the owner does not record why
    // a discount was given, so the rule flagged every discounted invoice in the
    // shop and the card opened with ten rows nobody could act on.
    const queue = buildAttentionQueue({ uninvoicedJobs: [] });
    expect(queue.items.some((item) => item.label.includes("reason"))).toBe(false);
    expect(Object.keys(queue)).toEqual(["items", "uninvoicedJobs", "total"]);
  });
});
