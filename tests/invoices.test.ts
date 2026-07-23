import { describe, expect, it } from "vitest";
import {
  buildConsolidatedInvoiceLines,
  computeInvoiceTotals,
  summarizePayments,
  deriveInvoiceStatus,
} from "../src/lib/invoices";

const line = (unitPriceCents: number, quantity = 1) => ({ quantity, unitPriceCents });

describe("computeInvoiceTotals", () => {
  it("sums lines with quantity and applies HST", () => {
    const t = computeInvoiceTotals([line(15000), line(5000, 2)], 0, 1300);
    expect(t.subtotalCents).toBe(25000);
    expect(t.taxCents).toBe(3250);
    expect(t.totalCents).toBe(28250);
  });

  it("applies discount before tax and clamps it to the subtotal", () => {
    const t = computeInvoiceTotals([line(10000)], 2500, 1300);
    expect(t.discountCents).toBe(2500);
    expect(t.taxCents).toBe(975);
    expect(t.totalCents).toBe(8475);

    const clamped = computeInvoiceTotals([line(1000)], 99999, 1300);
    expect(clamped.discountCents).toBe(1000);
    expect(clamped.totalCents).toBe(0);
  });

  it("never produces a negative discount", () => {
    const t = computeInvoiceTotals([line(1000)], -500, 1300);
    expect(t.discountCents).toBe(0);
    expect(t.totalCents).toBe(1130);
  });
});

describe("buildConsolidatedInvoiceLines", () => {
  it("preserves job order and labels services and approved work by vehicle", () => {
    const lines = buildConsolidatedInvoiceLines([
      {
        jobId: "job_one",
        vehicleLabel: "2021 Ford Transit",
        appointmentLines: [{ serviceId: "svc_1", description: "Interior detail", priceCents: 12000 }],
        approvedAdditionalWork: [{ description: "Pet hair removal", priceCents: 5000 }],
      },
      {
        jobId: "job_two",
        vehicleLabel: "2023 Ram ProMaster",
        appointmentLines: [{ description: "Exterior wash", priceCents: 8000 }],
        approvedAdditionalWork: [],
      },
    ]);

    expect(lines).toEqual([
      { serviceId: "svc_1", description: "2021 Ford Transit — Interior detail", quantity: 1, unitPriceCents: 12000 },
      { serviceId: null, description: "2021 Ford Transit — Pet hair removal", quantity: 1, unitPriceCents: 5000 },
      { serviceId: null, description: "2023 Ram ProMaster — Exterior wash", quantity: 1, unitPriceCents: 8000 },
    ]);
  });

  it("returns no lines for an empty job selection", () => {
    expect(buildConsolidatedInvoiceLines([])).toEqual([]);
  });
});

describe("summarizePayments", () => {
  const p = (kind: string, amountCents: number, status = "succeeded") => ({ kind, amountCents, status });

  it("nets a deposit and a payment against the total", () => {
    const s = summarizePayments(10000, 0, [p("payment", 4000)]);
    expect(s.paidCents).toBe(4000);
    expect(s.balanceCents).toBe(6000);
  });

  it("credits an up-front deposit even with no payments table rows", () => {
    const s = summarizePayments(10000, 2000, []);
    expect(s.netPaidCents).toBe(2000);
    expect(s.balanceCents).toBe(8000);
  });

  it("clamps a deposit that exceeds the total", () => {
    const s = summarizePayments(1000, 5000, []);
    expect(s.balanceCents).toBe(0);
  });

  it("ignores pending and failed payments", () => {
    const s = summarizePayments(10000, 0, [p("payment", 4000, "pending"), p("payment", 3000, "failed")]);
    expect(s.paidCents).toBe(0);
    expect(s.balanceCents).toBe(10000);
  });

  it("nets a refund against prior payments", () => {
    const s = summarizePayments(10000, 0, [p("payment", 10000), p("refund", 4000)]);
    expect(s.paidCents).toBe(10000);
    expect(s.refundedCents).toBe(4000);
    expect(s.netPaidCents).toBe(6000);
    expect(s.balanceCents).toBe(4000);
  });

  it("never lets the balance go negative on an overpayment", () => {
    const s = summarizePayments(10000, 0, [p("payment", 15000)]);
    expect(s.balanceCents).toBe(0);
  });
});

describe("deriveInvoiceStatus", () => {
  it("stays at the fallback while nothing has been paid", () => {
    expect(deriveInvoiceStatus({ totalCents: 10000, netPaidCents: 0, refundedCents: 0, fallback: "sent" })).toBe("sent");
  });

  it("moves to partially_paid on a partial payment", () => {
    expect(deriveInvoiceStatus({ totalCents: 10000, netPaidCents: 4000, refundedCents: 0, fallback: "sent" })).toBe("partially_paid");
  });

  it("moves to paid once the balance is covered", () => {
    expect(deriveInvoiceStatus({ totalCents: 10000, netPaidCents: 10000, refundedCents: 0, fallback: "sent" })).toBe("paid");
    expect(deriveInvoiceStatus({ totalCents: 10000, netPaidCents: 12000, refundedCents: 0, fallback: "sent" })).toBe("paid");
  });

  it("moves to refunded when a full refund brings net paid back to zero", () => {
    expect(deriveInvoiceStatus({ totalCents: 10000, netPaidCents: 0, refundedCents: 10000, fallback: "paid" })).toBe("refunded");
  });

  it("stays partially_paid after a partial refund that still leaves money paid", () => {
    expect(deriveInvoiceStatus({ totalCents: 10000, netPaidCents: 6000, refundedCents: 4000, fallback: "paid" })).toBe("partially_paid");
  });
});
