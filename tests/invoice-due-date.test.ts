import { describe, expect, it } from "vitest";
import { INVOICE_DUE_DAYS, invoiceDueDate } from "../src/lib/invoices";

describe("invoice due date", () => {
  it("falls due 30 days after the invoice is sent", () => {
    expect(INVOICE_DUE_DAYS).toBe(30);
    const sent = new Date("2026-10-23T15:00:00Z");
    expect(invoiceDueDate(sent).toISOString()).toBe("2026-11-22T15:00:00.000Z");
  });
});
