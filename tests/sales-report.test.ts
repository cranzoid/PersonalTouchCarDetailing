import { describe, expect, it } from "vitest";
import {
  invoiceSettlement,
  summarizePaidUnpaid,
  type SalesInvoiceRow,
} from "../src/lib/sales-report";

const payment = (amountCents: number, kind = "payment", status = "succeeded") => ({
  kind,
  status,
  amountCents,
});

function invoice(status: string, totalCents = 10_000, depositAppliedCents = 0) {
  return { status, totalCents, depositAppliedCents };
}

describe("invoiceSettlement", () => {
  it("calls a draft or sent invoice with no money unpaid", () => {
    for (const status of ["draft", "sent", "overdue"]) {
      expect(invoiceSettlement(invoice(status), [])).toEqual({
        paymentState: "unpaid", paidCents: 0, balanceCents: 10_000,
      });
    }
  });

  it("calls a draft with a booking deposit on it part paid", () => {
    expect(invoiceSettlement(invoice("draft", 10_000, 2_500), [])).toEqual({
      paymentState: "part_paid", paidCents: 2_500, balanceCents: 7_500,
    });
  });

  it("does not count a failed payment", () => {
    expect(invoiceSettlement(invoice("sent"), [payment(10_000, "payment", "failed")]).paymentState)
      .toBe("unpaid");
  });

  it("calls an invoice paid once nothing is owed, by payments or a deposit", () => {
    expect(invoiceSettlement(invoice("paid"), [payment(10_000)]).paymentState).toBe("paid");
    expect(invoiceSettlement(invoice("draft", 10_000, 10_000), []).paymentState).toBe("paid");
  });

  it("owes nothing on a refunded or cancelled invoice", () => {
    const refunds = [payment(10_000), payment(10_000, "refund")];
    expect(invoiceSettlement(invoice("refunded"), refunds)).toEqual({
      paymentState: "refunded", paidCents: 0, balanceCents: 0,
    });
    expect(invoiceSettlement(invoice("cancelled"), []).balanceCents).toBe(0);
  });
});

function row(
  number: number,
  status: string,
  payments: ReturnType<typeof payment>[] = [],
  date = new Date("2026-11-02T12:00:00Z"),
  totalCents = 10_000,
): SalesInvoiceRow {
  return {
    ...invoiceSettlement(invoice(status, totalCents), payments),
    id: `inv_${number}`,
    number,
    date,
    customerName: "Marcus Bell",
    status,
    totalCents,
  };
}

describe("summarizePaidUnpaid", () => {
  it("adds up to the amount invoiced, however the invoices stand", () => {
    const summary = summarizePaidUnpaid([
      row(1, "paid", [payment(10_000)]),
      row(2, "partially_paid", [payment(4_000)]),
      row(3, "draft"),
      row(4, "refunded", [payment(10_000), payment(10_000, "refund")]),
      // Overpaid by $5: the sale is $100, and the extra is owed back.
      row(5, "paid", [payment(15_000)]),
    ]);
    expect(summary.invoicedCents).toBe(50_000);
    expect(summary.paidCents).toBe(24_000);
    expect(summary.unpaidCents).toBe(16_000);
    expect(summary.refundedCents).toBe(10_000);
    expect(summary.paidCents + summary.unpaidCents + summary.refundedCents).toBe(summary.invoicedCents);
    expect(summary.paidInvoiceCount).toBe(2);
    expect(summary.unpaidInvoiceCount).toBe(2);
  });

  it("puts what is owed first, newest first within each group", () => {
    const summary = summarizePaidUnpaid([
      row(1, "paid", [payment(10_000)], new Date("2026-11-05T12:00:00Z")),
      row(2, "sent", [], new Date("2026-11-01T12:00:00Z")),
      row(3, "draft", [], new Date("2026-11-03T12:00:00Z")),
      row(4, "partially_paid", [payment(1_000)], new Date("2026-11-04T12:00:00Z")),
    ]);
    expect(summary.rows.map((r) => r.number)).toEqual([3, 2, 4, 1]);
  });
});
