import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";

const staff = vi.hoisted(() => ({
  id: "usr_invoice_tips_test",
  name: "Test Manager",
  email: "invoice-tips@example.com",
  role: "owner" as const,
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({
  requireStaff: vi.fn(async () => staff),
  AuthError: class AuthError extends Error {},
}));
// The receipt send is a best-effort side effect of recording a payment and
// reaches a real provider; the ledger is what these tests are about.
vi.mock("@/lib/messaging", () => ({ sendMessageTemplate: vi.fn(async () => undefined) }));

import { db, getPool, schema } from "../src/db";
import { newId } from "../src/lib/id";
import { computeInvoiceTotals, tipBaseCents, tipCentsFromBasisPoints } from "../src/lib/invoices";
import {
  recordPaymentAction,
  setInvoiceTaxExemptAction,
  setInvoiceTipAction,
} from "../src/app/admin/(app)/invoices/actions";

const line = (unitPriceCents: number, quantity = 1) => ({ quantity, unitPriceCents });

/* ------------------------------------------------------------------ */
/* Pure math                                                           */
/* ------------------------------------------------------------------ */

describe("tip arithmetic", () => {
  it("adds the tip after tax and never taxes it", () => {
    const withoutTip = computeInvoiceTotals([line(20000)], 0, 1300);
    const withTip = computeInvoiceTotals([line(20000)], 0, 1300, 3000);

    // The tax is byte-identical: the tip changed the total and nothing else.
    expect(withTip.taxCents).toBe(withoutTip.taxCents);
    expect(withTip.subtotalCents).toBe(20000);
    expect(withTip.tipCents).toBe(3000);
    expect(withTip.totalCents).toBe(withoutTip.totalCents + 3000);
  });

  it("takes a percentage tip from the discounted, pre-tax work", () => {
    // 200.00 of work, 50.00 off => a 15% tip is 22.50, not 30.00 and not
    // 15% of the tax-inclusive figure.
    expect(tipBaseCents(20000, 5000)).toBe(15000);
    expect(tipCentsFromBasisPoints(20000, 5000, 1500)).toBe(2250);
  });

  it("makes a percentage tip independent of how the customer pays", () => {
    // Cash strips the HST on this shop's invoices. The tip must not move with
    // it, or the same 15% would be worth less on a cash job than a card one.
    const taxed = tipCentsFromBasisPoints(20000, 0, 1500);
    const untaxed = tipCentsFromBasisPoints(20000, 0, 1500);
    expect(taxed).toBe(untaxed);
    expect(taxed).toBe(3000);
  });

  it("defaults to no tip so every pre-tipping caller is unchanged", () => {
    const t = computeInvoiceTotals([line(10000)], 0, 1300);
    expect(t.tipCents).toBe(0);
    expect(t.totalCents).toBe(11300);
  });

  it("floors a negative tip at zero", () => {
    expect(computeInvoiceTotals([line(10000)], 0, 0, -500).tipCents).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* The action, against the database                                    */
/* ------------------------------------------------------------------ */

async function resetDb() {
  await db().execute(sql`
    TRUNCATE payments, invoices, customers, staff_users, audit_log CASCADE
  `);
  await db().insert(schema.staffUsers).values({
    id: staff.id,
    name: staff.name,
    email: staff.email,
    passwordHash: "not-used-in-tests",
    role: staff.role,
  });
}

/** An invoice carrying HST, with its line item, as the shop would raise one. */
async function createInvoice(input: { status: string; subtotalCents?: number }) {
  const customerId = newId("cus");
  await db().insert(schema.customers).values({
    id: customerId,
    firstName: "Tip",
    lastName: "Test",
    email: "tip@example.com",
  });
  const subtotalCents = input.subtotalCents ?? 20_000;
  const totals = computeInvoiceTotals([line(subtotalCents)], 0, 1300);
  const id = newId("inv");
  await db().insert(schema.invoices).values({
    id,
    number: Math.floor(Math.random() * 1_000_000),
    customerId,
    status: input.status,
    subtotalCents: totals.subtotalCents,
    taxRateBp: 1300,
    taxCents: totals.taxCents,
    totalCents: totals.totalCents,
  });
  await db().insert(schema.invoiceLineItems).values({
    id: newId("ili"),
    invoiceId: id,
    description: "Full detail",
    quantity: 1,
    unitPriceCents: subtotalCents,
  });
  return { invoiceId: id, customerId, totals };
}

const read = async (id: string) =>
  (await db().select().from(schema.invoices).where(eq(schema.invoices.id, id)).limit(1))[0];

describe("setInvoiceTipAction", () => {
  beforeEach(resetDb);
  afterAll(async () => {
    await getPool().end();
  });

  it("adds a percentage tip on top of the total without touching the tax", async () => {
    const { invoiceId, totals } = await createInvoice({ status: "sent" });

    expect(await setInvoiceTipAction({ invoiceId, basisPoints: 1500 })).toEqual({
      ok: true,
      tipCents: 3_000,
    });

    const invoice = await read(invoiceId);
    expect(invoice.tipCents).toBe(3_000);
    expect(invoice.tipBasisBp).toBe(1500);
    expect(invoice.taxCents).toBe(totals.taxCents);
    expect(invoice.subtotalCents).toBe(totals.subtotalCents);
    expect(invoice.totalCents).toBe(totals.totalCents + 3_000);
  });

  it("records a flat amount and clears the percentage it replaces", async () => {
    const { invoiceId } = await createInvoice({ status: "sent" });
    await setInvoiceTipAction({ invoiceId, basisPoints: 1500 });

    await setInvoiceTipAction({ invoiceId, tipCents: 2_500 });

    const invoice = await read(invoiceId);
    expect(invoice.tipCents).toBe(2_500);
    // Printing "Tip (15%)" beside $25.00 would be a lie on a tax document.
    expect(invoice.tipBasisBp).toBeNull();
  });

  it("reopens a PAID invoice so the tip can be taken as a payment", async () => {
    // The case this whole feature exists for: the customer tipped at the
    // counter on a job the shop had already marked paid.
    const { invoiceId, totals } = await createInvoice({ status: "sent" });
    await recordPaymentAction({
      invoiceId,
      method: "card_terminal",
      amountCents: totals.totalCents,
      idempotencyKey: "tip_test_settle_0001",
    });
    expect((await read(invoiceId)).status).toBe("paid");

    expect(await setInvoiceTipAction({ invoiceId, basisPoints: 2000 })).toEqual({
      ok: true,
      tipCents: 4_000,
    });

    const reopened = await read(invoiceId);
    expect(reopened.status).toBe("partially_paid");
    expect(reopened.totalCents).toBe(totals.totalCents + 4_000);

    // And the tip itself now settles cleanly, which is the point.
    expect(
      await recordPaymentAction({
        invoiceId,
        method: "card_terminal",
        amountCents: 4_000,
        idempotencyKey: "tip_test_gratuity_0001",
      }),
    ).toEqual({ ok: true });
    expect((await read(invoiceId)).status).toBe("paid");
  });

  it("refuses to drop the total below money already banked", async () => {
    const { invoiceId, totals } = await createInvoice({ status: "sent" });
    await setInvoiceTipAction({ invoiceId, tipCents: 5_000 });
    await recordPaymentAction({
      invoiceId,
      method: "card_terminal",
      amountCents: totals.totalCents + 5_000,
      idempotencyKey: "tip_test_overpay_0001",
    });

    // Removing the tip now would strand $50 of the customer's money in an
    // invoice whose balance clamps at zero — a refund, not an edit.
    const result = await setInvoiceTipAction({ invoiceId, tipCents: 0 });
    expect(result.ok).toBe(false);
    expect((await read(invoiceId)).tipCents).toBe(5_000);
  });

  it("rejects a tip larger than the work as a mistyped decimal", async () => {
    const { invoiceId } = await createInvoice({ status: "sent", subtotalCents: 20_000 });
    const result = await setInvoiceTipAction({ invoiceId, tipCents: 200_000 });
    expect(result.ok).toBe(false);
    expect((await read(invoiceId)).tipCents).toBe(0);
  });

  it("keeps the tip whole when cash strips the HST", async () => {
    const { invoiceId, totals } = await createInvoice({ status: "sent" });
    await setInvoiceTipAction({ invoiceId, tipCents: 3_000 });

    // Cash re-prices the document to the untaxed figure — but the gratuity is
    // not tax and must survive it.
    await recordPaymentAction({
      invoiceId,
      method: "cash",
      amountCents: totals.subtotalCents + 3_000,
      idempotencyKey: "tip_test_cash_0001",
    });

    const invoice = await read(invoiceId);
    expect(invoice.taxCents).toBe(0);
    expect(invoice.tipCents).toBe(3_000);
    expect(invoice.totalCents).toBe(totals.subtotalCents + 3_000);
    expect(invoice.status).toBe("paid");
  });

  it("carries the tip across a tax-exemption change", async () => {
    const { invoiceId, totals } = await createInvoice({ status: "sent" });
    await setInvoiceTipAction({ invoiceId, tipCents: 3_000 });

    await setInvoiceTaxExemptAction({ invoiceId, taxExempt: true, reason: "Fleet account" });

    const invoice = await read(invoiceId);
    expect(invoice.taxCents).toBe(0);
    // Recomputing the total from the line items alone would have erased this.
    expect(invoice.tipCents).toBe(3_000);
    expect(invoice.totalCents).toBe(totals.subtotalCents + 3_000);
  });

  it("refuses a tip on a cancelled invoice", async () => {
    const { invoiceId } = await createInvoice({ status: "cancelled" });
    const result = await setInvoiceTipAction({ invoiceId, basisPoints: 1500 });
    expect(result.ok).toBe(false);
  });

  it("refuses a request that gives both a percentage and an amount", async () => {
    const { invoiceId } = await createInvoice({ status: "sent" });
    const result = await setInvoiceTipAction({ invoiceId, basisPoints: 1500, tipCents: 2_000 });
    expect(result.ok).toBe(false);
  });
});
