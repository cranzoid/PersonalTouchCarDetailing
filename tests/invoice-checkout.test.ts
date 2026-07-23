import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";

const checkout = vi.hoisted(() => vi.fn());
const reconcile = vi.hoisted(() => vi.fn());

vi.mock("@/lib/rate-limit", () => ({
  consumeRateLimit: vi.fn(async () => ({ allowed: true, remaining: 9, resetAt: new Date() })),
}));
vi.mock("@/lib/payments", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/payments")>();
  return {
    ...actual,
    getPaymentProvider: () => ({
      name: "stripe" as const,
      createCheckoutSession: checkout,
      getCheckoutSession: reconcile,
      refundPayment: vi.fn(),
      verifyWebhookEvent: vi.fn(),
    }),
  };
});

import { db, getPool, schema } from "../src/db";
import { newId } from "../src/lib/id";
import { createInvoiceAccessToken } from "../src/lib/invoices";
import { createInvoiceCheckoutAction } from "../src/app/(public)/portal/invoices/[token]/actions";

async function resetDb() {
  await db().execute(sql`
    TRUNCATE payments, access_tokens, invoices, customers, communications, message_templates,
             business_settings, audit_log, rate_limit_buckets CASCADE
  `);
  checkout.mockReset();
  reconcile.mockReset();
  checkout.mockResolvedValue({ providerRef: "cs_invoice_shared", url: "https://checkout.example/invoice" });
  reconcile.mockResolvedValue({
    providerRef: "cs_invoice_shared",
    status: "open",
    url: "https://checkout.example/invoice",
    amountCents: 10_000,
    paymentStatus: "unpaid",
  });
}

async function createInvoiceFixture() {
  const customerId = newId("cus");
  const invoiceId = newId("inv");
  await db().insert(schema.customers).values({
    id: customerId,
    firstName: "Invoice",
    lastName: "Customer",
    email: "invoice@example.com",
  });
  await db().insert(schema.invoices).values({
    id: invoiceId,
    number: 8101,
    customerId,
    status: "sent",
    subtotalCents: 10_000,
    taxRateBp: 0,
    totalCents: 10_000,
  });
  const token = await createInvoiceAccessToken(db(), {
    invoiceId,
    customerId,
    expiresAt: new Date(Date.now() + 60_000),
  });
  return { customerId, invoiceId, token };
}

async function addCheckout(input: {
  customerId: string;
  invoiceId: string;
  providerRef?: string | null;
  status?: string;
  failureReason?: string;
}) {
  const id = newId("pay");
  await db().insert(schema.payments).values({
    id,
    invoiceId: input.invoiceId,
    customerId: input.customerId,
    provider: "stripe",
    providerRef: input.providerRef === undefined ? "cs_invoice_existing" : input.providerRef,
    idempotencyKey: `checkout_${id}`,
    kind: "payment",
    amountCents: 10_000,
    status: input.status ?? "pending",
    failureReason: input.failureReason,
  });
  return id;
}

describe("invoice checkout reconciliation", () => {
  beforeEach(resetDb);

  afterAll(async () => {
    await getPool().end();
  });

  it("resumes an authenticated open session", async () => {
    const fixture = await createInvoiceFixture();
    const paymentId = await addCheckout({ ...fixture, providerRef: "cs_invoice_open" });
    reconcile.mockResolvedValueOnce({
      providerRef: "cs_invoice_open",
      status: "open",
      url: "https://checkout.example/resume-invoice",
      amountCents: 10_000,
      paymentStatus: "unpaid",
    });

    expect(await createInvoiceCheckoutAction({ token: fixture.token })).toEqual({
      ok: true,
      url: "https://checkout.example/resume-invoice",
    });
    expect(checkout).not.toHaveBeenCalled();
    expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({
      paymentId,
      invoiceId: fixture.invoiceId,
      providerRef: "cs_invoice_open",
      amountCents: 10_000,
    }));
  });

  it("finalizes a delayed paid session after a legacy local timeout", async () => {
    const fixture = await createInvoiceFixture();
    const paymentId = await addCheckout({
      ...fixture,
      providerRef: "cs_invoice_delayed_paid",
      status: "failed",
      failureReason: "Checkout session expired",
    });
    reconcile.mockResolvedValueOnce({
      providerRef: "cs_invoice_delayed_paid",
      status: "paid",
      amountCents: 10_000,
      paymentStatus: "paid",
    });

    expect((await createInvoiceCheckoutAction({ token: fixture.token })).ok).toBe(true);
    const [payment] = await db().select().from(schema.payments).where(eq(schema.payments.id, paymentId));
    const [invoice] = await db().select().from(schema.invoices).where(eq(schema.invoices.id, fixture.invoiceId));
    expect(payment.status).toBe("succeeded");
    expect(invoice.status).toBe("paid");
    expect(checkout).not.toHaveBeenCalled();
  });

  it("replaces a checkout only after authenticated expiry", async () => {
    const fixture = await createInvoiceFixture();
    const oldPaymentId = await addCheckout({ ...fixture, providerRef: "cs_invoice_expired" });
    reconcile.mockResolvedValueOnce({
      providerRef: "cs_invoice_expired",
      status: "expired",
      amountCents: 10_000,
      paymentStatus: "unpaid",
    });
    checkout.mockResolvedValueOnce({ providerRef: "cs_invoice_replacement", url: "https://checkout.example/new-invoice" });

    expect(await createInvoiceCheckoutAction({ token: fixture.token })).toEqual({
      ok: true,
      url: "https://checkout.example/new-invoice",
    });
    const payments = await db().select().from(schema.payments).where(eq(schema.payments.invoiceId, fixture.invoiceId));
    expect(payments).toHaveLength(2);
    expect(payments.find((payment) => payment.id === oldPaymentId)).toMatchObject({
      status: "failed",
      failureReason: "Provider confirmed checkout expired",
    });
    expect(payments.find((payment) => payment.id !== oldPaymentId)).toMatchObject({
      status: "pending",
      providerRef: "cs_invoice_replacement",
      amountCents: 10_000,
    });
  });

  it("makes concurrent retries share one payment reservation and provider idempotency key", async () => {
    const fixture = await createInvoiceFixture();
    const results = await Promise.all([
      createInvoiceCheckoutAction({ token: fixture.token }),
      createInvoiceCheckoutAction({ token: fixture.token }),
    ]);

    expect(results.every((result) => result.ok)).toBe(true);
    const payments = await db().select().from(schema.payments).where(eq(schema.payments.invoiceId, fixture.invoiceId));
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ status: "pending", amountCents: 10_000, providerRef: "cs_invoice_shared" });
    expect(new Set(checkout.mock.calls.map((call) => call[0].paymentId))).toEqual(new Set([payments[0].id]));
  });
});
