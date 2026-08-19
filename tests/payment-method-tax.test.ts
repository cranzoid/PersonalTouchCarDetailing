import { describe, expect, it } from "vitest";
import {
  computeInvoiceTotals,
  isPaymentMethodTaxable,
  noTaxReasonForMethod,
  paymentMethodConflict,
  resolveInvoiceTax,
  taxTreatmentForMethod,
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

describe("the spec §4.1 worked example", () => {
  // Sedan, Package #2 ($175), Wax/Buff add-on ($120), 10% discount, paid Credit
  const lines = [
    { quantity: 1, unitPriceCents: 17500 },
    { quantity: 1, unitPriceCents: 12000 },
  ];
  const discountCents = 2950; // 10% of 29500

  it("bills 300.02 on credit", () => {
    const tax = resolveInvoiceTax({ method: "card_terminal", baseTaxRateBp: HST, taxLabel: "HST" });
    const totals = computeInvoiceTotals(lines, discountCents, tax.taxRateBp);
    expect(totals.subtotalCents).toBe(29500);
    expect(totals.discountCents).toBe(2950);
    expect(totals.taxCents).toBe(3452);
    expect(totals.totalCents).toBe(30002);
  });

  it("bills 265.50 for the same job in cash", () => {
    const tax = resolveInvoiceTax({ method: "cash", baseTaxRateBp: HST, taxLabel: "HST" });
    const totals = computeInvoiceTotals(lines, discountCents, tax.taxRateBp);
    expect(totals.taxCents).toBe(0);
    expect(totals.totalCents).toBe(26550);
  });

  it("discounts before tax, never after", () => {
    const totals = computeInvoiceTotals(lines, discountCents, HST);
    // Taxing the gross first would give 3835, and the customer would overpay.
    expect(totals.taxCents).toBe(3452);
  });
});

describe("resolveInvoiceTax", () => {
  it("records a cash sale as exempt with a reason the tax report can group on", () => {
    const tax = resolveInvoiceTax({ method: "cash", baseTaxRateBp: HST, taxLabel: "HST" });
    expect(tax).toEqual({
      taxRateBp: 0,
      taxTreatment: "none",
      quotedPaymentMethod: "cash",
      taxExempt: true,
      taxExemptReason: "Cash sale — no HST charged",
    });
  });

  it("keeps a card sale fully taxed with no exemption to explain away", () => {
    const tax = resolveInvoiceTax({ method: "stripe", baseTaxRateBp: HST, taxLabel: "HST" });
    expect(tax.taxRateBp).toBe(HST);
    expect(tax.taxTreatment).toBe("added");
    expect(tax.taxExempt).toBe(false);
    expect(tax.taxExemptReason).toBeNull();
  });

  it("preserves a legitimately zero-rated appointment rather than substituting the settings rate", () => {
    const tax = resolveInvoiceTax({ method: "cheque", baseTaxRateBp: 0, taxLabel: "HST" });
    expect(tax.taxRateBp).toBe(0);
    expect(tax.taxTreatment).toBe("added");
  });

  it("lets a staff exemption outrank the payment method, and leaves no method bound to the invoice", () => {
    const tax = resolveInvoiceTax({
      method: "card_terminal",
      baseTaxRateBp: HST,
      taxLabel: "HST",
      staffExempt: true,
      staffExemptReason: "Out-of-province customer",
    });
    expect(tax.taxRateBp).toBe(0);
    expect(tax.taxTreatment).toBe("none");
    expect(tax.taxExemptReason).toBe("Out-of-province customer");
    // The restatement query is `tax_treatment = 'none' AND quoted_payment_method
    // IS NOT NULL`, so a staff exemption must NOT be swept into it.
    expect(tax.quotedPaymentMethod).toBeNull();
  });

  it("names the method in the reason so the tax report separates cash from e-transfer", () => {
    expect(noTaxReasonForMethod("cash", "HST")).toBe("Cash sale — no HST charged");
    expect(noTaxReasonForMethod("etransfer", "HST")).toBe("Interac e-transfer sale — no HST charged");
    expect(taxTreatmentForMethod("cheque")).toBe("added");
    expect(taxTreatmentForMethod("etransfer")).toBe("none");
  });
});

describe("paymentMethodConflict", () => {
  const cashInvoice = { taxTreatment: "none", quotedPaymentMethod: "cash" };
  const cardInvoice = { taxTreatment: "added", quotedPaymentMethod: "card_terminal" };

  it("lets a matching method through", () => {
    expect(paymentMethodConflict(cashInvoice, "cash", "HST")).toBeNull();
    expect(paymentMethodConflict(cashInvoice, "etransfer", "HST")).toBeNull();
    expect(paymentMethodConflict(cardInvoice, "cheque", "HST")).toBeNull();
    expect(paymentMethodConflict(cardInvoice, "stripe", "HST")).toBeNull();
  });

  it("blocks a card payment on an untaxed invoice and says to re-issue", () => {
    const message = paymentMethodConflict(cashInvoice, "card_terminal", "HST");
    expect(message).toContain("cancel this invoice and re-issue");
    expect(message).toContain("no HST");
  });

  it("blocks a cash payment on a taxed invoice", () => {
    expect(paymentMethodConflict(cardInvoice, "cash", "HST")).toContain("cancel this invoice and re-issue");
  });

  it("leaves pre-Release-3 invoices alone, so open invoices stay payable across the swap", () => {
    // Every invoice raised before 0008 defaults to tax_treatment 'added' with
    // no quoted method. Enforcing against those would have stopped the shop
    // taking cash on anything already open.
    const legacy = { taxTreatment: "added", quotedPaymentMethod: null };
    for (const method of QUOTED_PAYMENT_METHODS) {
      expect(paymentMethodConflict(legacy, method, "HST")).toBeNull();
    }
  });

  it("stays quiet once a staff exemption has cleared the quoted method", () => {
    const exempted = { taxTreatment: "none", quotedPaymentMethod: null };
    expect(paymentMethodConflict(exempted, "card_terminal", "HST")).toBeNull();
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
  const money = (cents: number) => formatCents(cents);

  it("puts uninvoiced cars above unexplained discounts — that is money not yet asked for", () => {
    const queue = buildAttentionQueue({
      discountedInvoices: [{ id: "inv_1", number: 1042, discountCents: 2500, customerName: "Dana Q" }],
      uninvoicedJobs: [{ id: "job_1", vehicleLabel: "2021 Toyota Highlander", readySinceLabel: "Aug 14" }],
      formatMoney: money,
    });
    expect(queue.total).toBe(2);
    expect(queue.items[0]!.kind).toBe("uninvoiced_job");
    expect(queue.items[1]!.label).toContain("$25.00 off with no reason");
    expect(queue.items[1]!.href).toBe("/admin/invoices/inv_1");
  });

  it("is empty when the shop is tidy, so the card does not render at all", () => {
    const queue = buildAttentionQueue({ discountedInvoices: [], uninvoicedJobs: [], formatMoney: money });
    expect(queue.total).toBe(0);
    expect(queue.items).toEqual([]);
  });

  it("counts each rule separately", () => {
    const queue = buildAttentionQueue({
      discountedInvoices: [
        { id: "a", number: 1, discountCents: 100, customerName: "A" },
        { id: "b", number: 2, discountCents: 200, customerName: "B" },
      ],
      uninvoicedJobs: [{ id: "j", vehicleLabel: "Van", readySinceLabel: "Aug 1" }],
      formatMoney: money,
    });
    expect(queue.discountWithoutReason).toBe(2);
    expect(queue.uninvoicedJobs).toBe(1);
    expect(queue.total).toBe(3);
  });
});
