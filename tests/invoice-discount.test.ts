import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";

const staff = vi.hoisted(() => ({
  id: "usr_invoice_discount_test",
  name: "Test Manager",
  email: "invoice-discount@example.com",
  role: "owner" as const,
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({
  requireStaff: vi.fn(async () => staff),
  AuthError: class AuthError extends Error {},
}));
vi.mock("@/lib/messaging", () => ({ sendMessageTemplate: vi.fn(async () => undefined) }));
// Helcim is not reachable from a test; an unfinished session stays unfinished.
vi.mock("@/lib/payments", async (original) => ({
  ...(await original<typeof import("../src/lib/payments")>()),
  reconcileCheckout: vi.fn(async () => undefined),
}));

import { db, getPool, schema } from "../src/db";
import { newId } from "../src/lib/id";
import { computeInvoiceTotals } from "../src/lib/invoices";
import { insertCheckout } from "../src/lib/payments/checkouts";
import {
  recordPaymentAction,
  setInvoiceDiscountAction,
  setInvoiceTipAction,
} from "../src/app/admin/(app)/invoices/actions";

async function resetDb() {
  await db().execute(sql`
    TRUNCATE payment_checkouts, payments, invoices, customers, staff_users, audit_log CASCADE
  `);
  await db().insert(schema.staffUsers).values({
    id: staff.id,
    name: staff.name,
    email: staff.email,
    passwordHash: "not-used-in-tests",
    role: staff.role,
  });
}

/** A $200.00 invoice with HST, as the shop would raise one. */
async function createInvoice(input: { status?: string; depositAppliedCents?: number; notes?: string } = {}) {
  const customerId = newId("cus");
  await db().insert(schema.customers).values({
    id: customerId,
    firstName: "Discount",
    lastName: "Test",
    email: "discount@example.com",
  });
  const totals = computeInvoiceTotals([{ quantity: 1, unitPriceCents: 20_000 }], 0, 1300);
  const id = newId("inv");
  await db().insert(schema.invoices).values({
    id,
    number: Math.floor(Math.random() * 1_000_000),
    customerId,
    status: input.status ?? "draft",
    subtotalCents: totals.subtotalCents,
    taxRateBp: 1300,
    taxCents: totals.taxCents,
    totalCents: totals.totalCents,
    depositAppliedCents: input.depositAppliedCents ?? 0,
    notes: input.notes,
  });
  return { invoiceId: id, customerId, totals };
}

const read = async (id: string) =>
  (await db().select().from(schema.invoices).where(eq(schema.invoices.id, id)).limit(1))[0];

describe("setInvoiceDiscountAction", () => {
  beforeEach(resetDb);
  afterAll(async () => {
    await getPool().end();
  });

  it("takes a dollar discount off before HST and records the reason", async () => {
    const { invoiceId } = await createInvoice();
    expect(await setInvoiceDiscountAction({ invoiceId, discountCents: 5_000, reason: "Repeat" })).toEqual({ ok: true });
    expect(await read(invoiceId)).toMatchObject({
      status: "draft",
      subtotalCents: 20_000,
      discountCents: 5_000,
      discountReason: "Repeat",
      taxCents: 1_950,
      totalCents: 16_950,
    });
  });

  it("takes a percentage off the subtotal, and removes it again", async () => {
    const { invoiceId, totals } = await createInvoice({ status: "sent" });
    await setInvoiceDiscountAction({ invoiceId, discountPercentBp: 1000 });
    expect(await read(invoiceId)).toMatchObject({ discountCents: 2_000, totalCents: 20_340, status: "sent" });

    await setInvoiceDiscountAction({ invoiceId, discountCents: 0, reason: "ignored" });
    expect(await read(invoiceId)).toMatchObject({
      discountCents: 0,
      discountReason: null,
      totalCents: totals.totalCents,
    });
  });

  it("is allowed with a booking deposit applied, and keeps the deposit", async () => {
    const { invoiceId } = await createInvoice({ status: "sent", depositAppliedCents: 5_000 });
    expect(await setInvoiceDiscountAction({ invoiceId, discountCents: 2_000 })).toEqual({ ok: true });
    expect(await read(invoiceId)).toMatchObject({ depositAppliedCents: 5_000, status: "sent" });
  });

  it("caps the deposit at a smaller total and settles an issued invoice it covers", async () => {
    const { invoiceId } = await createInvoice({ status: "sent", depositAppliedCents: 5_000 });
    await setInvoiceDiscountAction({ invoiceId, discountCents: 18_000 });
    expect(await read(invoiceId)).toMatchObject({ totalCents: 2_260, depositAppliedCents: 2_260, status: "paid" });
  });

  it("recomputes a percentage tip and leaves a typed one alone", async () => {
    const percent = await createInvoice();
    await setInvoiceTipAction({ invoiceId: percent.invoiceId, basisPoints: 1500 });
    await setInvoiceDiscountAction({ invoiceId: percent.invoiceId, discountCents: 10_000 });
    expect(await read(percent.invoiceId)).toMatchObject({ tipCents: 1_500, totalCents: 12_800 });

    const typed = await createInvoice();
    await setInvoiceTipAction({ invoiceId: typed.invoiceId, tipCents: 2_500 });
    await setInvoiceDiscountAction({ invoiceId: typed.invoiceId, discountCents: 10_000 });
    expect(await read(typed.invoiceId)).toMatchObject({ tipCents: 2_500, totalCents: 13_800 });
  });

  it("drops the booking-offer note once less than that offer is given", async () => {
    const { invoiceId } = await createInvoice({ notes: "Fall offer applied at booking." });
    await setInvoiceDiscountAction({ invoiceId, discountCents: 2_000 });
    expect((await read(invoiceId)).notes).toBe("Fall offer applied at booking.");
    await setInvoiceDiscountAction({ invoiceId, discountCents: 0 });
    expect((await read(invoiceId)).notes).toBeNull();
  });

  it("refuses once a payment is recorded", async () => {
    const { invoiceId } = await createInvoice({ status: "sent" });
    await recordPaymentAction({
      invoiceId,
      method: "card_terminal",
      amountCents: 1_000,
      idempotencyKey: "discount_test_part_0001",
    });
    const res = await setInvoiceDiscountAction({ invoiceId, discountCents: 2_000 });
    expect(res.ok).toBe(false);
    expect((await read(invoiceId)).discountCents).toBe(0);
  });

  it("refuses a discount above the subtotal, or one given both ways", async () => {
    const { invoiceId } = await createInvoice();
    expect((await setInvoiceDiscountAction({ invoiceId, discountCents: 20_001 })).ok).toBe(false);
    expect((await setInvoiceDiscountAction({ invoiceId, discountCents: 1, discountPercentBp: 1 })).ok).toBe(false);
    expect((await setInvoiceDiscountAction({ invoiceId })).ok).toBe(false);
  });

  it.each(["online", "terminal"] as const)("handles an open %s card checkout", async (channel) => {
    const { invoiceId, customerId, totals } = await createInvoice({ status: "sent" });
    const checkout = await insertCheckout(db(), {
      kind: channel === "terminal" ? "terminal" : "invoices",
      channel,
      customerId,
      amountCents: totals.totalCents,
      currency: "CAD",
      subject: { allocations: [{ invoiceId, amountCents: totals.totalCents }] },
      payments: [{ customerId, invoiceId, kind: "payment", amountCents: totals.totalCents }],
    });

    const res = await setInvoiceDiscountAction({ invoiceId, discountCents: 2_000 });

    const [after] = await db().select().from(schema.paymentCheckouts).where(eq(schema.paymentCheckouts.id, checkout.id));
    // The online session is closed with the old amount; the terminal is left to finish.
    expect(res.ok).toBe(channel === "online");
    expect(after.status).toBe(channel === "online" ? "expired" : "open");
    expect((await read(invoiceId)).discountCents).toBe(channel === "online" ? 2_000 : 0);
  });
});
