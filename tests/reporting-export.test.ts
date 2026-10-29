import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

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
    const snapshot = await getReportingSnapshot({ days: 30 });
    expect(snapshot.tax.invoiceCount).toBe(2); // draft excluded
    expect(snapshot.tax.taxCollectedCents).toBe(2600);
    expect(snapshot.tax.exemptInvoiceCount).toBe(1);
    expect(snapshot.tax.exemptReasons[0].reason).toBe("Cash sale");
    expect(snapshot.paymentMethods.map((m) => m.provider).sort()).toEqual(["cash", "cheque"]);
  });

  it("builds a summary CSV with a BOM, CRLF rows and the tax block", async () => {
    const snapshot = await getReportingSnapshot({ days: 30 });
    const csv = await buildReportCsv("summary", snapshot);
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv).toContain("\r\n");
    expect(csv).toContain("Tax collected,26.00");
    expect(csv).toContain("Cash sale");
  });

  it("builds an invoice CSV with one row per issued invoice", async () => {
    const snapshot = await getReportingSnapshot({ days: 30 });
    const csv = await buildReportCsv("invoices", snapshot);
    const lines = csv.replace("﻿", "").trim().split("\r\n");
    expect(lines[0]).toContain("Invoice,Date,Status,Customer");
    // Header + 3 invoices; drafts still belong in the working paper.
    expect(lines).toHaveLength(4);
    expect(csv).toContain("INV-2002");
    expect(csv).toContain("Yes,Cash sale");
  });

  it("shows what was paid and what is still owed on a part-paid invoice", async () => {
    const snapshot = await getReportingSnapshot({ days: 30 });
    const csv = await buildReportCsv("invoices", snapshot);
    const lines = csv.replace("\uFEFF", "").trim().split("\r\n");
    expect(lines[0].endsWith(",Total,Paid,Balance")).toBe(true);
    // $226.00 invoice with a $50.00 payment: $176.00 still owed, not $226.00.
    expect(lines.find((l) => l.startsWith("INV-2001"))).toMatch(/,226\.00,50\.00,176\.00$/);
    // The draft has no payments, so its whole total is the balance.
    expect(lines.find((l) => l.startsWith("INV-2003"))).toMatch(/,226\.00,0\.00,226\.00$/);
  });

  it("counts refunds and an applied deposit, and owes nothing on a cancelled invoice", async () => {
    const [inv2002] = await db().select().from(schema.invoices).where(eq(schema.invoices.number, 2002));
    await db().update(schema.invoices).set({ depositAppliedCents: 2500 }).where(eq(schema.invoices.id, inv2002.id));
    await db().insert(schema.payments).values({
      id: newId("pay"), invoiceId: inv2002.id, provider: "cash", idempotencyKey: newId("pay"),
      amountCents: 1000, kind: "refund", status: "succeeded", receivedAt: new Date(),
    });
    await db().update(schema.invoices).set({ status: "cancelled" }).where(eq(schema.invoices.number, 2001));
    const snapshot = await getReportingSnapshot({ days: 30 });
    const csv = await buildReportCsv("invoices", snapshot);
    const lines = csv.replace("\uFEFF", "").trim().split("\r\n");
    // $200.00: $50 paid - $10 refunded + $25 deposit = $65 paid, $135 owed.
    expect(lines.find((l) => l.startsWith("INV-2002"))).toMatch(/,200\.00,65\.00,135\.00$/);
    expect(lines.find((l) => l.startsWith("INV-2001"))).toMatch(/,226\.00,50\.00,0\.00$/);
  });

  it("signs refunds in the payments CSV so a column sum is the net", async () => {
    const snapshot = await getReportingSnapshot({ days: 30 });
    const csv = await buildReportCsv("payments", snapshot);
    expect(csv).toContain("Cheque");
    expect(csv).toContain("50.00");
  });

  it("leaves a negative money figure as a number Excel can still sum", async () => {
    // The formula guard escapes anything starting with "-", which would turn a
    // refund into the text "'-30.00" and silently break the accountant's column
    // total. Plain numbers must pass through untouched.
    await db().insert(schema.payments).values({
      id: newId("pay"),
      provider: "cash",
      idempotencyKey: newId("pay"),
      amountCents: 3000,
      kind: "refund",
      status: "succeeded",
      receivedAt: new Date(),
    });
    const snapshot = await getReportingSnapshot({ days: 30 });
    const csv = await buildReportCsv("payments", snapshot);
    expect(csv).toContain("-30.00");
    expect(csv).not.toContain("'-30.00");
  });

  it("neutralises spreadsheet formula injection in text fields", async () => {
    await db().insert(schema.customers).values({
      id: newId("cus"), firstName: "=cmd|calc", lastName: "Exploit",
      phone: "905-555-0000", preferredContact: "phone",
    });
    const snapshot = await getReportingSnapshot({ days: 30 });
    const csv = await buildReportCsv("invoices", snapshot);
    expect(csv).not.toMatch(/(^|,)=cmd/);
  });

  it("still escapes a formula that merely looks numeric at the start", async () => {
    await db().insert(schema.customers).values({
      id: newId("cus"), firstName: "-2+3+cmd", lastName: "Exploit",
      phone: "905-555-0001", preferredContact: "phone",
    });
    const snapshot = await getReportingSnapshot({ days: 30 });
    const csv = await buildReportCsv("invoices", snapshot);
    expect(csv).not.toMatch(/(^|,)-2\+3/);
  });
});
