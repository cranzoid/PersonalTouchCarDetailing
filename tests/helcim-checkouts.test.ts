import { createHash, createHmac } from "crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";

/**
 * A stand-in for Helcim's API: an in-memory ledger of card transactions that
 * the checkout engine can only reach through the same client functions it
 * uses in production. Tests "pay" by adding an approved transaction under a
 * checkout's reference, exactly as Helcim records a HelcimPay.js payment.
 */
const helcim = vi.hoisted(() => {
  const transactions = new Map<string, Record<string, unknown>>();
  let nextId = 900000;
  return {
    transactions,
    secretTokens: [] as string[],
    add(fields: Record<string, unknown>) {
      const id = String(++nextId);
      const tx = { transactionId: id, status: "APPROVED", type: "purchase", currency: "CAD", cardNumber: "4124939999", cardType: "VI", cardToken: `tok_${id}`, ...fields };
      transactions.set(id, tx);
      return tx;
    },
    initialize: vi.fn(),
    purchase: vi.fn(),
    startTerminal: vi.fn(),
    createCustomer: vi.fn(),
    reset() {
      transactions.clear();
      this.secretTokens.length = 0;
    },
  };
});

vi.mock("@/lib/helcim/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/helcim/client")>();
  return {
    ...actual,
    initializeCheckout: helcim.initialize,
    getCardTransaction: async (id: string) => {
      const tx = helcim.transactions.get(id);
      return tx ? actual.normalizeTransaction(tx) : null;
    },
    findCardTransactionsByInvoiceNumber: async (invoiceNumber: string) =>
      [...helcim.transactions.values()].filter((t) => t.invoiceNumber === invoiceNumber).map(actual.normalizeTransaction),
    purchaseWithCardToken: helcim.purchase,
    startTerminalPurchase: helcim.startTerminal,
    createHelcimCustomer: helcim.createCustomer,
  };
});
vi.mock("@/lib/rate-limit", () => ({
  consumeRateLimit: vi.fn(async () => ({ allowed: true, remaining: 9, retryAfterSeconds: 0 })),
}));

import { db, getPool, schema } from "../src/db";
import { newId } from "../src/lib/id";
import { HelcimApiError, normalizeTransaction } from "../src/lib/helcim/client";
import { isValidCheckoutHash, isValidWebhookSignature, phpJsonEncode } from "../src/lib/helcim/verify";
import {
  beginAppointmentCheckout,
  beginInvoicesCheckout,
  chargeCardOnFile,
  confirmOnlineCheckout,
  handleCardTransactionEvent,
  handleTerminalCancelEvent,
  parseCheckoutEventMessage,
  reconcileOpenCheckouts,
  startInvoiceTerminalCheckout,
} from "../src/lib/payments";

async function resetDb() {
  await db().execute(sql`
    TRUNCATE payment_checkouts, payments, webhook_events, access_tokens, invoice_line_items, invoices, appointment_services,
             appointments, vehicles, customers, communications, message_templates, business_settings,
             audit_log, rate_limit_buckets, staff_users, integration_credentials CASCADE
  `);
  helcim.reset();
  helcim.initialize.mockReset();
  helcim.purchase.mockReset();
  helcim.startTerminal.mockReset();
  helcim.createCustomer.mockReset();
  helcim.initialize.mockImplementation(async () => {
    const secretToken = `secret_${helcim.secretTokens.length + 1}`;
    helcim.secretTokens.push(secretToken);
    return { checkoutToken: `checkout_${helcim.secretTokens.length}`, secretToken };
  });
}

async function customer(overrides: Partial<typeof schema.customers.$inferInsert> = {}) {
  const id = newId("cus");
  await db().insert(schema.customers).values({ id, firstName: "Pay", lastName: "Customer", email: `${id}@example.com`, ...overrides });
  return id;
}

let invoiceNumber = 7000;
async function invoice(customerId: string, overrides: Partial<typeof schema.invoices.$inferInsert> = {}) {
  const id = newId("inv");
  await db().insert(schema.invoices).values({
    id,
    number: ++invoiceNumber,
    customerId,
    status: "sent",
    subtotalCents: 10_000,
    taxRateBp: 1300,
    taxCents: 1_300,
    totalCents: 11_300,
    ...overrides,
  });
  return id;
}

async function checkoutRow(id: string) {
  return (await db().select().from(schema.paymentCheckouts).where(eq(schema.paymentCheckouts.id, id)))[0];
}

async function invoiceRow(id: string) {
  return (await db().select().from(schema.invoices).where(eq(schema.invoices.id, id)))[0];
}

/** What the HelcimPay.js iframe posts back on SUCCESS for a transaction. */
function successMessage(tx: Record<string, unknown>, secretToken: string) {
  const data = { ...tx };
  const hash = createHash("sha256").update(JSON.stringify(data) + secretToken).digest("hex");
  return JSON.stringify({ hash, data });
}

beforeEach(resetDb);
afterAll(async () => {
  await getPool().end();
});

describe("Helcim response and webhook verification", () => {
  it("accepts a hash made with the session's secret token and rejects any change", () => {
    const data = { transactionId: "1", amount: "113.00", cardHolderName: "Zoë Smith", invoiceNumber: "PTCX/1" };
    const phpHash = createHash("sha256").update(phpJsonEncode(data) + "s3cret").digest("hex");
    expect(phpJsonEncode(data)).toContain("Zo\\u00eb");
    expect(phpJsonEncode(data)).toContain("PTCX\\/1");
    expect(isValidCheckoutHash(data, "s3cret", phpHash)).toBe(true);
    expect(isValidCheckoutHash({ ...data, amount: "1.00" }, "s3cret", phpHash)).toBe(false);
    expect(isValidCheckoutHash(data, "other", phpHash)).toBe(false);
    expect(isValidCheckoutHash(data, "s3cret", "not-a-hash")).toBe(false);
  });

  it("verifies Svix-style webhook signatures, including rotation and replay windows", () => {
    const verifierToken = Buffer.from("verifier-key-bytes").toString("base64");
    const body = '{"id":"25764674","type":"cardTransaction"}';
    const id = "msg_1";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHashHmac(verifierToken, `${id}.${timestamp}.${body}`);
    expect(isValidWebhookSignature({ id, timestamp, signature: `v1,${signature}`, body, verifierToken })).toBe(true);
    expect(isValidWebhookSignature({ id, timestamp, signature: `v1,wrong v1,${signature}`, body, verifierToken })).toBe(true);
    expect(isValidWebhookSignature({ id, timestamp, signature: `v1,${signature}`, body: body + " ", verifierToken })).toBe(false);
    expect(
      isValidWebhookSignature({ id, timestamp, signature: `v1,${signature}`, body, verifierToken, nowMs: Date.now() + 10 * 60_000 }),
    ).toBe(false);
  });

  it("reads the iframe's message whether it arrives as a string, an object, or wrapped once more", () => {
    const inner = { hash: "a".repeat(64), data: { transactionId: "5" } };
    expect(parseCheckoutEventMessage(JSON.stringify(inner)).data?.transactionId).toBe("5");
    expect(parseCheckoutEventMessage(inner).hash).toBe("a".repeat(64));
    expect(parseCheckoutEventMessage({ data: inner }).data?.transactionId).toBe("5");
    expect(parseCheckoutEventMessage("not json")).toEqual({ data: null, hash: null });
  });
});

function createHashHmac(base64Key: string, content: string) {
  return createHmac("sha256", Buffer.from(base64Key, "base64")).update(content).digest("base64");
}

describe("paying invoices online", () => {
  it("charges exactly the ledger balance and shares one session between concurrent clicks", async () => {
    const customerId = await customer();
    const invoiceId = await invoice(customerId);
    const [first, second] = await Promise.all([
      beginInvoicesCheckout({ invoiceIds: [invoiceId], allowedCustomerIds: [customerId] }),
      beginInvoicesCheckout({ invoiceIds: [invoiceId], allowedCustomerIds: [customerId] }),
    ]);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.checkoutId).toBe(second.checkoutId);
    expect(first.amountCents).toBe(11_300);
    const pending = await db().select().from(schema.payments).where(eq(schema.payments.invoiceId, invoiceId));
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ status: "pending", amountCents: 11_300, provider: "helcim", checkoutId: first.checkoutId });
    expect(helcim.initialize).toHaveBeenCalledWith(
      expect.objectContaining({ paymentType: "purchase", amountCents: 11_300, invoiceNumber: (await checkoutRow(first.checkoutId)).reference }),
    );
  });

  it("refuses invoices the caller does not own, and cash-priced invoices", async () => {
    const mine = await customer();
    const theirs = await customer();
    const theirInvoice = await invoice(theirs);
    expect(await beginInvoicesCheckout({ invoiceIds: [theirInvoice], allowedCustomerIds: [mine] })).toMatchObject({ ok: false });
    const cashPriced = await invoice(mine, { taxTreatment: "none", quotedPaymentMethod: "cash", taxCents: 0, totalCents: 10_000 });
    const result = await beginInvoicesCheckout({ invoiceIds: [cashPriced], allowedCustomerIds: [mine] });
    expect(result).toMatchObject({ ok: false });
    expect(helcim.initialize).not.toHaveBeenCalled();
  });

  it("marks the invoice paid only after Helcim confirms the transaction, and only once", async () => {
    const customerId = await customer();
    const invoiceId = await invoice(customerId);
    const started = await beginInvoicesCheckout({ invoiceIds: [invoiceId], allowedCustomerIds: [customerId] });
    if (!started.ok) throw new Error(started.error);
    const checkout = await checkoutRow(started.checkoutId);
    const tx = helcim.add({ amount: "113.00", invoiceNumber: checkout.reference });
    const message = successMessage(tx, checkout.secretToken!);

    expect(await confirmOnlineCheckout({ checkoutId: checkout.id, eventMessage: message, allowedCustomerIds: [customerId] })).toMatchObject({
      status: "succeeded",
      alreadyProcessed: false,
    });
    expect(await confirmOnlineCheckout({ checkoutId: checkout.id, eventMessage: message, allowedCustomerIds: [customerId] })).toMatchObject({
      status: "succeeded",
      alreadyProcessed: true,
    });
    expect((await invoiceRow(invoiceId)).status).toBe("paid");
    const payments = await db().select().from(schema.payments).where(eq(schema.payments.invoiceId, invoiceId));
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ status: "succeeded", providerRef: tx.transactionId });
    expect((await checkoutRow(checkout.id)).status).toBe("succeeded");
  });

  it("ignores a forged success that points at someone else's real payment", async () => {
    const customerId = await customer();
    const invoiceId = await invoice(customerId);
    const started = await beginInvoicesCheckout({ invoiceIds: [invoiceId], allowedCustomerIds: [customerId] });
    if (!started.ok) throw new Error(started.error);
    // A genuine approved transaction for the same amount — but another sale.
    const elsewhere = helcim.add({ amount: "113.00", invoiceNumber: "SOMEONEELSE" });
    const forged = JSON.stringify({ hash: "0".repeat(64), data: elsewhere });
    const outcome = await confirmOnlineCheckout({ checkoutId: started.checkoutId, eventMessage: forged });
    expect(outcome.status).not.toBe("succeeded");
    expect((await invoiceRow(invoiceId)).status).toBe("sent");
  });

  it("accepts a hash-verified payment even if Helcim did not echo our reference", async () => {
    const customerId = await customer();
    const invoiceId = await invoice(customerId);
    const started = await beginInvoicesCheckout({ invoiceIds: [invoiceId], allowedCustomerIds: [customerId] });
    if (!started.ok) throw new Error(started.error);
    const checkout = await checkoutRow(started.checkoutId);
    const tx = helcim.add({ amount: "113.00", invoiceNumber: "" });
    const outcome = await confirmOnlineCheckout({ checkoutId: checkout.id, eventMessage: successMessage(tx, checkout.secretToken!) });
    expect(outcome.status).toBe("succeeded");
    expect((await invoiceRow(invoiceId)).status).toBe("paid");
  });

  it("pays several invoices in one transaction, each to the cent", async () => {
    const customerId = await customer({ customerType: "business", companyName: "Fleet Co" });
    const a = await invoice(customerId);
    const b = await invoice(customerId, { subtotalCents: 5_000, taxCents: 650, totalCents: 5_650 });
    const started = await beginInvoicesCheckout({ invoiceIds: [a, b], allowedCustomerIds: [customerId] });
    if (!started.ok) throw new Error(started.error);
    expect(started.amountCents).toBe(16_950);
    const checkout = await checkoutRow(started.checkoutId);
    helcim.add({ amount: "169.50", invoiceNumber: checkout.reference });
    // The browser closed before posting back: the hourly reconciliation finds it.
    await db()
      .update(schema.paymentCheckouts)
      .set({ createdAt: new Date(Date.now() - 10 * 60_000) })
      .where(eq(schema.paymentCheckouts.id, checkout.id));
    expect(await reconcileOpenCheckouts()).toMatchObject({ succeeded: 1 });
    expect((await invoiceRow(a)).status).toBe("paid");
    expect((await invoiceRow(b)).status).toBe("paid");
  });

  it("closes an unpaid session once it has expired, and still records a late payment", async () => {
    const customerId = await customer();
    const invoiceId = await invoice(customerId);
    const started = await beginInvoicesCheckout({ invoiceIds: [invoiceId], allowedCustomerIds: [customerId] });
    if (!started.ok) throw new Error(started.error);
    await db()
      .update(schema.paymentCheckouts)
      .set({ createdAt: new Date(Date.now() - 3 * 3_600_000), expiresAt: new Date(Date.now() - 2 * 3_600_000) })
      .where(eq(schema.paymentCheckouts.id, started.checkoutId));
    expect(await reconcileOpenCheckouts()).toMatchObject({ closed: 1 });
    const checkout = await checkoutRow(started.checkoutId);
    expect(checkout.status).toBe("expired");

    // Then the customer's card turns out to have been charged after all.
    const tx = helcim.add({ amount: "113.00", invoiceNumber: checkout.reference });
    expect(await handleCardTransactionEvent(String(tx.transactionId))).toBe("succeeded");
    expect((await invoiceRow(invoiceId)).status).toBe("paid");
  });

  it("replaces an open session when the selection changes", async () => {
    const customerId = await customer();
    const a = await invoice(customerId);
    const b = await invoice(customerId);
    const first = await beginInvoicesCheckout({ invoiceIds: [a], allowedCustomerIds: [customerId] });
    const second = await beginInvoicesCheckout({ invoiceIds: [a, b], allowedCustomerIds: [customerId] });
    if (!first.ok || !second.ok) throw new Error("checkout failed");
    expect(second.checkoutId).not.toBe(first.checkoutId);
    expect((await checkoutRow(first.checkoutId)).status).toBe("expired");
  });
});

describe("deposits and prepayment", () => {
  async function appointment(input: { required: number; paid?: number; total?: number }) {
    const customerId = await customer();
    const vehicleId = newId("veh");
    await db().insert(schema.vehicles).values({ id: vehicleId, customerId, make: "Honda", model: "Civic", category: "sedan" });
    const id = newId("apt");
    const startsAt = new Date(Date.now() + 3 * 86_400_000);
    await db().insert(schema.appointments).values({
      id,
      customerId,
      vehicleId,
      status: input.required > (input.paid ?? 0) ? "deposit_required" : "confirmed",
      startsAt,
      endsAt: new Date(startsAt.getTime() + 3_600_000),
      durationMin: 60,
      totalCents: input.total ?? 15_000,
      depositRequiredCents: input.required,
      depositPaidCents: input.paid ?? 0,
    });
    return { id, customerId };
  }

  it("takes the outstanding deposit and confirms the booking", async () => {
    const apt = await appointment({ required: 5_000, paid: 1_000 });
    const started = await beginAppointmentCheckout({ appointmentId: apt.id, customerId: apt.customerId, purpose: "deposit" });
    if (!started.ok) throw new Error(started.error);
    expect(started.amountCents).toBe(4_000);
    const checkout = await checkoutRow(started.checkoutId);
    const tx = helcim.add({ amount: "40.00", invoiceNumber: checkout.reference });
    await confirmOnlineCheckout({ checkoutId: checkout.id, eventMessage: successMessage(tx, checkout.secretToken!) });
    const [row] = await db().select().from(schema.appointments).where(eq(schema.appointments.id, apt.id));
    expect(row).toMatchObject({ status: "confirmed", depositPaidCents: 5_000 });
  });

  it("prepays the whole remaining total of a booking with no deposit", async () => {
    const apt = await appointment({ required: 0, total: 9_040 });
    const started = await beginAppointmentCheckout({ appointmentId: apt.id, customerId: apt.customerId, purpose: "prepay" });
    if (!started.ok) throw new Error(started.error);
    expect(started.amountCents).toBe(9_040);
    expect(await beginAppointmentCheckout({ appointmentId: apt.id, customerId: apt.customerId, purpose: "deposit" })).toMatchObject({
      ok: false,
    });
    const checkout = await checkoutRow(started.checkoutId);
    const tx = helcim.add({ amount: 90.4, invoiceNumber: checkout.reference });
    await confirmOnlineCheckout({ checkoutId: checkout.id, eventMessage: successMessage(tx, checkout.secretToken!) });
    const [row] = await db().select().from(schema.appointments).where(eq(schema.appointments.id, apt.id));
    expect(row.depositPaidCents).toBe(9_040);
    expect(await beginAppointmentCheckout({ appointmentId: apt.id, customerId: apt.customerId, purpose: "prepay" })).toMatchObject({
      ok: false,
      error: "This appointment is already paid in full.",
    });
  });
});

describe("Smart Terminal", () => {
  beforeEach(() => {
    process.env.HELCIM_TERMINAL_DEVICE_CODE = "AB12";
  });

  async function staff() {
    const id = newId("usr");
    await db().insert(schema.staffUsers).values({ id, name: "Front", email: `${id}@example.com`, passwordHash: "x", role: "owner" });
    return id;
  }

  it("pushes the balance to the terminal and records a tip added on the device", async () => {
    const staffId = await staff();
    const customerId = await customer();
    const invoiceId = await invoice(customerId);
    const started = await startInvoiceTerminalCheckout({ invoiceId, staffId });
    if (!started.ok) throw new Error(started.error);
    const checkout = await checkoutRow(started.checkoutId);
    expect(helcim.startTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ deviceCode: "AB12", amountCents: 11_300, invoiceNumber: checkout.reference }),
    );
    // A second push while the first is open is refused rather than dropped by the device.
    expect(await startInvoiceTerminalCheckout({ invoiceId, staffId })).toMatchObject({ ok: false });

    const tx = helcim.add({ amount: "133.00", invoiceNumber: checkout.reference });
    expect(await handleCardTransactionEvent(String(tx.transactionId))).toBe("succeeded");
    const paid = await invoiceRow(invoiceId);
    expect(paid).toMatchObject({ status: "paid", tipCents: 2_000, totalCents: 13_300, taxCents: 1_300 });
    const [payment] = await db().select().from(schema.payments).where(eq(schema.payments.invoiceId, invoiceId));
    expect(payment).toMatchObject({ provider: "helcim_terminal", amountCents: 13_300, status: "succeeded" });
  });

  it("fails cleanly when the terminal is off, and when the customer cancels on it", async () => {
    const staffId = await staff();
    const customerId = await customer();
    const invoiceId = await invoice(customerId);
    helcim.startTerminal.mockRejectedValueOnce(new HelcimApiError(409, ["Device Not Listening"]));
    expect(await startInvoiceTerminalCheckout({ invoiceId, staffId })).toMatchObject({
      ok: false,
      error: expect.stringContaining("isn't listening"),
    });

    const started = await startInvoiceTerminalCheckout({ invoiceId, staffId });
    if (!started.ok) throw new Error(started.error);
    const checkout = await checkoutRow(started.checkoutId);
    expect(await handleTerminalCancelEvent({ invoiceNumber: checkout.reference, deviceCode: "AB12", transactionAmount: 113 })).toBe(
      "cancelled",
    );
    expect((await checkoutRow(checkout.id)).status).toBe("failed");
    expect((await invoiceRow(invoiceId)).status).toBe("sent");
  });
});

describe("cards on file", () => {
  it("records an approved charge, fails a decline, and settles an unanswered one later", async () => {
    const customerId = await customer();
    const approvedInvoice = await invoice(customerId);
    helcim.purchase.mockImplementationOnce(async (input: { invoiceNumber: string }) =>
      normalizeTransaction(helcim.add({ amount: "113.00", invoiceNumber: input.invoiceNumber })),
    );
    const base = { kind: "membership_charge" as const, customerId, amountCents: 11_300, cardToken: "tok", helcimCustomerCode: "PTC-1", description: "Plan", subject: {}, ipAddress: "127.0.0.1" };
    expect(await chargeCardOnFile({ ...base, invoiceId: approvedInvoice })).toMatchObject({ status: "approved" });
    expect((await invoiceRow(approvedInvoice)).status).toBe("paid");

    const declinedInvoice = await invoice(customerId);
    helcim.purchase.mockImplementationOnce(async (input: { invoiceNumber: string }) =>
      normalizeTransaction(helcim.add({ amount: "113.00", invoiceNumber: input.invoiceNumber, status: "DECLINED" })),
    );
    expect(await chargeCardOnFile({ ...base, invoiceId: declinedInvoice })).toMatchObject({ status: "declined" });
    expect((await invoiceRow(declinedInvoice)).status).toBe("sent");

    const lostInvoice = await invoice(customerId);
    let reference = "";
    helcim.purchase.mockImplementationOnce(async (input: { invoiceNumber: string }) => {
      reference = input.invoiceNumber;
      helcim.add({ amount: "113.00", invoiceNumber: input.invoiceNumber });
      throw new Error("socket hang up");
    });
    const lost = await chargeCardOnFile({ ...base, invoiceId: lostInvoice });
    expect(lost.status).toBe("pending");
    expect((await invoiceRow(lostInvoice)).status).toBe("sent");
    expect(reference).not.toBe("");
    await db()
      .update(schema.paymentCheckouts)
      .set({ createdAt: new Date(Date.now() - 5 * 60_000) })
      .where(eq(schema.paymentCheckouts.id, lost.checkoutId));
    await reconcileOpenCheckouts();
    expect((await invoiceRow(lostInvoice)).status).toBe("paid");
  });
});

describe("webhook route", () => {
  it("settles a signed cardTransaction once, ignores a repeat delivery and rejects a forgery", async () => {
    const verifierToken = Buffer.from("route-test-verifier").toString("base64");
    process.env.HELCIM_WEBHOOK_VERIFIER_TOKEN = verifierToken;
    const { POST } = await import("../src/app/api/webhooks/card-payments/route");
    const customerId = await customer();
    const invoiceId = await invoice(customerId);
    const started = await beginInvoicesCheckout({ invoiceIds: [invoiceId], allowedCustomerIds: [customerId] });
    if (!started.ok) throw new Error(started.error);
    const checkout = await checkoutRow(started.checkoutId);
    const tx = helcim.add({ amount: "113.00", invoiceNumber: checkout.reference });

    const body = JSON.stringify({ id: tx.transactionId, type: "cardTransaction" });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signed = (id: string, signature = createHashHmac(verifierToken, `${id}.${timestamp}.${body}`)) =>
      new Request("https://www.example.test/api/webhooks/card-payments", {
        method: "POST",
        body,
        headers: { "webhook-id": id, "webhook-timestamp": timestamp, "webhook-signature": `v1,${signature}` },
      });

    expect((await POST(signed("msg_forged", "bm90LWEtc2lnbmF0dXJl"))).status).toBe(401);
    expect((await invoiceRow(invoiceId)).status).toBe("sent");
    const first = await POST(signed("msg_real"));
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ result: "succeeded" });
    expect((await POST(signed("msg_real"))).status).toBe(200);
    expect((await invoiceRow(invoiceId)).status).toBe("paid");
    const payments = await db().select().from(schema.payments).where(eq(schema.payments.invoiceId, invoiceId));
    expect(payments.filter((p) => p.status === "succeeded")).toHaveLength(1);
    delete process.env.HELCIM_WEBHOOK_VERIFIER_TOKEN;
  });
});
