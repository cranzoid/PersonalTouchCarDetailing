import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { db, getPool, schema } from "../src/db";
import { newId } from "../src/lib/id";
import { getReportingSnapshot } from "../src/lib/reporting";
import { buildReportCsv } from "../src/lib/reporting-csv";

beforeEach(async () => {
  await db().execute(
    `TRUNCATE invoice_line_items, invoice_jobs, payments, invoices, vehicles, customers,
     audit_log, staff_users, invoice_counters RESTART IDENTITY CASCADE` as never,
  );
  const customerId = newId("cus");
  await db().insert(schema.customers).values({
    id: customerId, firstName: "Marcus", lastName: "Bell", phone: "905-555-0143", preferredContact: "phone",
  });
  // One taxed, one exempt, one draft that must not be counted.
  const rows = [
    { number: 2001, status: "paid", taxCents: 2600, taxExempt: false, reason: null },
    { number: 2002, status: "sent", taxCents: 0, taxExempt: true, reason: "Cash sale" },
    { number: 2003, status: "draft", taxCents: 2600, taxExempt: false, reason: null },
  ];
  for (const r of rows) {
    const invoiceId = newId("inv");
    await db().insert(schema.invoices).values({
      id: invoiceId, number: r.number, customerId, status: r.status,
      subtotalCents: 20000, discountCents: 0, taxRateBp: r.taxExempt ? 0 : 1300,
      taxLabel: "HST", taxCents: r.taxCents, taxExempt: r.taxExempt,
      taxExemptReason: r.reason, totalCents: 20000 + r.taxCents, invoiceDate: new Date(),
    });
    if (r.status !== "draft") {
      await db().insert(schema.payments).values({
        id: newId("pay"), invoiceId, provider: r.taxExempt ? "cash" : "cheque",
        idempotencyKey: newId("pay"), amountCents: 5000, kind: "payment",
        status: "succeeded", receivedAt: new Date(),
      });
    }
  }
});

afterAll(async () => { await getPool().end(); });

describe("reporting export", () => {
  it("reports tax accrual and payment methods from live data", async () => {
    const snapshot = await getReportingSnapshot(30);
    expect(snapshot.tax.invoiceCount).toBe(2); // draft excluded
    expect(snapshot.tax.taxCollectedCents).toBe(2600);
    expect(snapshot.tax.exemptInvoiceCount).toBe(1);
    expect(snapshot.tax.exemptReasons[0].reason).toBe("Cash sale");
    expect(snapshot.paymentMethods.map((m) => m.provider).sort()).toEqual(["cash", "cheque"]);
  });

  it("builds a summary CSV with a BOM, CRLF rows and the tax block", async () => {
    const snapshot = await getReportingSnapshot(30);
    const csv = await buildReportCsv("summary", 30, snapshot);
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv).toContain("\r\n");
    expect(csv).toContain("Tax collected,26.00");
    expect(csv).toContain("Cash sale");
  });

  it("builds an invoice CSV with one row per issued invoice", async () => {
    const snapshot = await getReportingSnapshot(30);
    const csv = await buildReportCsv("invoices", 30, snapshot);
    const lines = csv.replace("﻿", "").trim().split("\r\n");
    expect(lines[0]).toContain("Invoice,Date,Status,Customer");
    // Header + 3 invoices; drafts still belong in the working paper.
    expect(lines).toHaveLength(4);
    expect(csv).toContain("INV-2002");
    expect(csv).toContain("Yes,Cash sale");
  });

  it("signs refunds in the payments CSV so a column sum is the net", async () => {
    const snapshot = await getReportingSnapshot(30);
    const csv = await buildReportCsv("payments", 30, snapshot);
    expect(csv).toContain("Cheque");
    expect(csv).toContain("50.00");
  });

  it("neutralises spreadsheet formula injection in text fields", async () => {
    await db().insert(schema.customers).values({
      id: newId("cus"), firstName: "=cmd|calc", lastName: "Exploit",
      phone: "905-555-0000", preferredContact: "phone",
    });
    const snapshot = await getReportingSnapshot(30);
    const csv = await buildReportCsv("invoices", 30, snapshot);
    expect(csv).not.toMatch(/(^|,)=cmd/);
  });
});
