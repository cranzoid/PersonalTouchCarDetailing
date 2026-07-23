import { describe, expect, it, vi } from "vitest";
import {
  decodeStripeRefundReference,
  encodeStripeRefundReference,
  getRefundAvailability,
  StripeProvider,
} from "../src/lib/payments";

describe("StripeProvider checkout reconciliation", () => {
  it("resumes only when provider metadata, subject, amount, and currency all match", async () => {
    const retrieve = vi.fn(async () => ({
      id: "cs_resume_123",
      status: "open",
      payment_status: "unpaid",
      url: "https://checkout.stripe.test/resume",
      client_reference_id: "pay_resume_123",
      metadata: { paymentId: "pay_resume_123", invoiceId: "inv_resume_123", paymentKind: "invoice" },
      amount_total: 7_500,
      currency: "cad",
    }));
    const provider = new StripeProvider({ checkout: { sessions: { retrieve } } } as never);
    const base = {
      invoiceId: "inv_resume_123",
      providerRef: "cs_resume_123",
      paymentId: "pay_resume_123",
      amountCents: 7_500,
      currency: "CAD",
      successUrl: "https://example.com/return",
    } as const;

    await expect(provider.getCheckoutSession(base)).resolves.toMatchObject({
      providerRef: "cs_resume_123",
      status: "open",
      url: "https://checkout.stripe.test/resume",
    });
    await expect(provider.getCheckoutSession({ ...base, amountCents: 7_499 })).resolves.toMatchObject({
      status: "invalid",
    });
    expect(retrieve).toHaveBeenCalledWith("cs_resume_123");
  });
});

describe("StripeProvider refunds", () => {
  it("binds appointment deposit checkout metadata to the appointment and payment", async () => {
    const create = vi.fn(async () => ({ id: "cs_deposit_123", url: "https://checkout.example/deposit" }));
    const provider = new StripeProvider({ checkout: { sessions: { create } } } as never);

    await expect(
      provider.createCheckoutSession({
        appointmentId: "apt_deposit_123",
        paymentId: "pay_deposit_123",
        amountCents: 5_000,
        currency: "CAD",
        customerEmail: "customer@example.com",
        description: "Appointment deposit",
        successUrl: "https://example.com/success",
        cancelUrl: "https://example.com/cancel",
      }),
    ).resolves.toEqual({ providerRef: "cs_deposit_123", url: "https://checkout.example/deposit" });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        client_reference_id: "pay_deposit_123",
        metadata: {
          appointmentId: "apt_deposit_123",
          paymentId: "pay_deposit_123",
          paymentKind: "appointment_deposit",
        },
      }),
      { idempotencyKey: "pay_deposit_123" },
    );
  });

  it("resolves the Checkout payment intent and sends the exact amount with a stable idempotency key", async () => {
    const retrieve = vi.fn(async () => ({ payment_intent: "pi_exact_123" }));
    const create = vi.fn(async () => ({ id: "re_exact_123", amount: 4_250, status: "succeeded" }));
    const provider = new StripeProvider({
      checkout: { sessions: { retrieve } },
      refunds: { create },
    } as never);

    await expect(
      provider.refundPayment({
        checkoutSessionId: "cs_exact_123",
        amountCents: 4_250,
        refundPaymentId: "pay_refund_123",
        invoiceId: "inv_123",
        idempotencyKey: "stripe_refund_pay_refund_123",
      }),
    ).resolves.toEqual({ providerRef: "re_exact_123", amountCents: 4_250, status: "succeeded" });
    expect(retrieve).toHaveBeenCalledWith("cs_exact_123");
    expect(create).toHaveBeenCalledWith(
      {
        payment_intent: "pi_exact_123",
        amount: 4_250,
        reason: "requested_by_customer",
        metadata: { invoiceId: "inv_123", refundPaymentId: "pay_refund_123" },
      },
      { idempotencyKey: "stripe_refund_pay_refund_123" },
    );
  });

  it("refuses a Checkout session without a payment intent", async () => {
    const create = vi.fn();
    const provider = new StripeProvider({
      checkout: { sessions: { retrieve: vi.fn(async () => ({ payment_intent: null })) } },
      refunds: { create },
    } as never);

    await expect(
      provider.refundPayment({
        checkoutSessionId: "cs_unpaid",
        amountCents: 1_000,
        refundPaymentId: "pay_refund_unpaid",
        invoiceId: "inv_unpaid",
        idempotencyKey: "stripe_refund_pay_refund_unpaid",
      }),
    ).rejects.toThrow(/no refundable payment intent/);
    expect(create).not.toHaveBeenCalled();
  });
});

describe("refund allocation", () => {
  it("reserves pending Stripe refunds against their exact source charge", () => {
    const reference = encodeStripeRefundReference({
      sourcePaymentId: "pay_charge_1",
      checkoutSessionId: "cs_charge_1",
      refundId: "re_1",
    });
    expect(decodeStripeRefundReference(reference)).toEqual({
      sourcePaymentId: "pay_charge_1",
      checkoutSessionId: "cs_charge_1",
      refundId: "re_1",
    });

    expect(
      getRefundAvailability([
        { id: "pay_charge_1", kind: "payment", provider: "stripe", providerRef: "cs_charge_1", amountCents: 10_000, status: "succeeded" },
        { id: "pay_refund_1", kind: "refund", provider: "stripe", providerRef: reference, amountCents: 2_500, status: "pending" },
        { id: "pay_cash_1", kind: "payment", provider: "cash", providerRef: null, amountCents: 3_000, status: "succeeded" },
      ], 1_000),
    ).toEqual({
      stripeRefundableCents: 7_500,
      manualRefundableCents: 4_000,
      stripeSources: [{ paymentId: "pay_charge_1", checkoutSessionId: "cs_charge_1", refundableCents: 7_500 }],
    });
  });
});
