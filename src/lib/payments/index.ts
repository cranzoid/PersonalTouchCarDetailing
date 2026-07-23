import { randomBytes } from "crypto";
import Stripe from "stripe";
import { eq } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { audit } from "@/lib/audit";
import { recalculateInvoiceStatus } from "@/lib/invoices";

/**
 * Payment provider abstraction shaped around Stripe's PaymentIntent/Checkout
 * model. Dev uses FakePaymentProvider (no network calls, no credentials
 * needed); setting STRIPE_SECRET_KEY switches to the real provider. No live
 * keys ever live in this repo — see .env.example.
 */

type CheckoutSubject =
  | { invoiceId: string; appointmentId?: never }
  | { appointmentId: string; invoiceId?: never };

export type CheckoutSessionInput = CheckoutSubject & {
  /** Our payments.id row — embedded so the webhook can find it back. */
  paymentId: string;
  amountCents: number;
  currency: string;
  customerEmail?: string;
  description: string;
  successUrl: string;
  cancelUrl: string;
};

export type CheckoutSession = { providerRef: string; url?: string };

export type CheckoutSessionReconcileInput = CheckoutSubject & {
  providerRef: string;
  paymentId: string;
  amountCents: number;
  currency: string;
  /** Used only by the deterministic development provider to reconstruct its URL. */
  successUrl: string;
};

export type CheckoutSessionState = {
  providerRef: string;
  status: "open" | "paid" | "processing" | "expired" | "invalid";
  url?: string;
  amountCents?: number | null;
  paymentStatus?: string;
};

export type RefundPaymentInput = {
  /** Stripe Checkout session reference stored on the succeeded payment row. */
  checkoutSessionId: string;
  /** Server-validated amount read back from the pending refund ledger row. */
  amountCents: number;
  refundPaymentId: string;
  invoiceId: string;
  idempotencyKey: string;
};

export type RefundPaymentResult = {
  providerRef: string;
  amountCents: number;
  status: "pending" | "succeeded" | "failed" | "canceled" | "requires_action";
};

export type VerifiedWebhookEvent = {
  id: string;
  type: string;
  /** Checkout session id, when the event concerns a checkout session. */
  sessionId?: string;
  /** Our payments.id, echoed back via client_reference_id/metadata. */
  paymentId?: string;
  invoiceId?: string;
  appointmentId?: string;
  amountTotal?: number | null;
  currency?: string | null;
  paymentStatus?: string;
  refundId?: string;
  refundPaymentId?: string;
  refundStatus?: string;
  refundAmount?: number;
  raw: unknown;
};

export interface PaymentProvider {
  readonly name: "fake" | "stripe";
  createCheckoutSession(input: CheckoutSessionInput): Promise<CheckoutSession>;
  getCheckoutSession(input: CheckoutSessionReconcileInput): Promise<CheckoutSessionState>;
  refundPayment(input: RefundPaymentInput): Promise<RefundPaymentResult>;
  /** Verifies signature + parses a raw webhook payload. Null when invalid. */
  verifyWebhookEvent(rawBody: string, signature: string | null): VerifiedWebhookEvent | null;
}

/**
 * Dev-only provider: no network calls. The "checkout URL" is our own success
 * URL with a fake session id appended — the portal page finalizes the
 * payment immediately on that return trip (see resolveFakeReturn below),
 * standing in for the webhook a real provider would fire.
 */
export class FakePaymentProvider implements PaymentProvider {
  readonly name = "fake" as const;

  private assertAvailable(): void {
    if (process.env.NODE_ENV === "production") {
      throw new Error("The fake payment provider is disabled in production");
    }
  }

  async createCheckoutSession(input: CheckoutSessionInput): Promise<CheckoutSession> {
    this.assertAvailable();
    const providerRef = `fake_ses_${randomBytes(12).toString("hex")}`;
    const sep = input.successUrl.includes("?") ? "&" : "?";
    const url = `${input.successUrl}${sep}fake_session=${providerRef}&payment_id=${input.paymentId}&amount_cents=${input.amountCents}`;
    return { providerRef, url };
  }

  async getCheckoutSession(input: CheckoutSessionReconcileInput): Promise<CheckoutSessionState> {
    this.assertAvailable();
    if (!input.providerRef.startsWith("fake_ses_")) return { providerRef: input.providerRef, status: "invalid" };
    const sep = input.successUrl.includes("?") ? "&" : "?";
    return {
      providerRef: input.providerRef,
      status: "open",
      url: `${input.successUrl}${sep}fake_session=${input.providerRef}&payment_id=${input.paymentId}&amount_cents=${input.amountCents}`,
      amountCents: input.amountCents,
      paymentStatus: "unpaid",
    };
  }

  async refundPayment(): Promise<RefundPaymentResult> {
    throw new Error("The development payment provider cannot refund a Stripe charge");
  }

  verifyWebhookEvent(): VerifiedWebhookEvent | null {
    // The fake provider never delivers real webhooks — dev finalization
    // happens on the portal return trip instead.
    return null;
  }
}

export class StripeProvider implements PaymentProvider {
  readonly name = "stripe" as const;
  private client: Stripe;

  constructor(client?: Stripe) {
    if (client) {
      this.client = client;
      return;
    }
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error("STRIPE_SECRET_KEY not set");
    this.client = new Stripe(key);
  }

  async createCheckoutSession(input: CheckoutSessionInput): Promise<CheckoutSession> {
    const subjectMetadata: Record<string, string> = input.appointmentId
      ? { appointmentId: input.appointmentId, paymentKind: "appointment_deposit" }
      : { invoiceId: input.invoiceId!, paymentKind: "invoice" };
    const session = await this.client.checkout.sessions.create(
      {
        mode: "payment",
        line_items: [
          {
            price_data: {
              currency: input.currency.toLowerCase(),
              unit_amount: input.amountCents,
              product_data: { name: input.description },
            },
            quantity: 1,
          },
        ],
        customer_email: input.customerEmail,
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        client_reference_id: input.paymentId,
        metadata: { ...subjectMetadata, paymentId: input.paymentId },
      },
      // If the app loses the response after Stripe creates the session, a
      // retry with the same payment row cannot create a second charge.
      { idempotencyKey: input.paymentId },
    );
    return { providerRef: session.id, ...(session.url ? { url: session.url } : {}) };
  }

  async getCheckoutSession(input: CheckoutSessionReconcileInput): Promise<CheckoutSessionState> {
    const session = await this.client.checkout.sessions.retrieve(input.providerRef);
    const expectedSubject = input.appointmentId
      ? session.metadata?.appointmentId === input.appointmentId && session.metadata?.paymentKind === "appointment_deposit"
      : session.metadata?.invoiceId === input.invoiceId && session.metadata?.paymentKind === "invoice";
    const metadataMatches =
      session.id === input.providerRef &&
      session.client_reference_id === input.paymentId &&
      session.metadata?.paymentId === input.paymentId &&
      expectedSubject &&
      session.amount_total === input.amountCents &&
      session.currency?.toLowerCase() === input.currency.toLowerCase();
    if (!metadataMatches) {
      return {
        providerRef: input.providerRef,
        status: "invalid",
        amountCents: session.amount_total,
        paymentStatus: session.payment_status,
      };
    }
    if (session.payment_status === "paid") {
      return {
        providerRef: session.id,
        status: "paid",
        amountCents: session.amount_total,
        paymentStatus: session.payment_status,
      };
    }
    if (session.status === "open" && session.url) {
      return {
        providerRef: session.id,
        status: "open",
        url: session.url,
        amountCents: session.amount_total,
        paymentStatus: session.payment_status,
      };
    }
    if (session.status === "expired" || (session.status as string) === "canceled" || (session.status as string) === "cancelled") {
      return {
        providerRef: session.id,
        status: "expired",
        amountCents: session.amount_total,
        paymentStatus: session.payment_status,
      };
    }
    return {
      providerRef: session.id,
      status: "processing",
      amountCents: session.amount_total,
      paymentStatus: session.payment_status,
    };
  }

  async refundPayment(input: RefundPaymentInput): Promise<RefundPaymentResult> {
    const session = await this.client.checkout.sessions.retrieve(input.checkoutSessionId);
    const paymentIntent =
      typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id;
    if (!paymentIntent) throw new Error("Stripe Checkout session has no refundable payment intent");

    const refund = await this.client.refunds.create(
      {
        payment_intent: paymentIntent,
        amount: input.amountCents,
        reason: "requested_by_customer",
        metadata: {
          invoiceId: input.invoiceId,
          refundPaymentId: input.refundPaymentId,
        },
      },
      { idempotencyKey: input.idempotencyKey },
    );
    return {
      providerRef: refund.id,
      amountCents: refund.amount,
      status: normalizeRefundStatus(refund.status),
    };
  }

  verifyWebhookEvent(rawBody: string, signature: string | null): VerifiedWebhookEvent | null {
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret || !signature) return null;
    try {
      const event = this.client.webhooks.constructEvent(rawBody, signature, secret);
      if (event.type === "checkout.session.completed") {
        const session = event.data.object as Stripe.Checkout.Session;
        return {
          id: event.id,
          type: event.type,
          sessionId: session.id,
          paymentId: session.client_reference_id ?? session.metadata?.paymentId,
          invoiceId: session.metadata?.invoiceId,
          appointmentId: session.metadata?.appointmentId,
          amountTotal: session.amount_total,
          currency: session.currency,
          paymentStatus: session.payment_status,
          raw: event,
        };
      }
      if (event.type === "refund.created" || event.type === "refund.updated" || event.type === "refund.failed") {
        const refund = event.data.object as Stripe.Refund;
        return {
          id: event.id,
          type: event.type,
          refundId: refund.id,
          refundPaymentId: refund.metadata?.refundPaymentId,
          invoiceId: refund.metadata?.invoiceId,
          refundStatus: normalizeRefundStatus(refund.status),
          refundAmount: refund.amount,
          raw: event,
        };
      }
      return { id: event.id, type: event.type, raw: event };
    } catch (err) {
      console.error("Stripe webhook signature verification failed", err);
      return null;
    }
  }
}

function normalizeRefundStatus(status: string | null): RefundPaymentResult["status"] {
  if (status === "succeeded" || status === "failed" || status === "canceled" || status === "requires_action") {
    return status;
  }
  return "pending";
}

const STRIPE_REFUND_REF_PREFIX = "stripe_refund_v1";

export type StripeRefundReference = {
  sourcePaymentId: string;
  checkoutSessionId: string;
  refundId?: string;
};

export function encodeStripeRefundReference(reference: StripeRefundReference): string {
  return [
    STRIPE_REFUND_REF_PREFIX,
    reference.sourcePaymentId,
    reference.checkoutSessionId,
    reference.refundId ?? "",
  ].join("|");
}

export function decodeStripeRefundReference(value: string | null): StripeRefundReference | null {
  if (!value) return null;
  const [prefix, sourcePaymentId, checkoutSessionId, refundId, ...extra] = value.split("|");
  if (prefix !== STRIPE_REFUND_REF_PREFIX || !sourcePaymentId || !checkoutSessionId || extra.length > 0) return null;
  return { sourcePaymentId, checkoutSessionId, ...(refundId ? { refundId } : {}) };
}

type RefundLedgerEntry = {
  id: string;
  kind: string;
  provider: string;
  providerRef: string | null;
  amountCents: number;
  status: string;
};

export function getRefundAvailability(entries: RefundLedgerEntry[], depositAppliedCents = 0): {
  stripeRefundableCents: number;
  manualRefundableCents: number;
  stripeSources: Array<{ paymentId: string; checkoutSessionId: string; refundableCents: number }>;
} {
  const succeededPayments = entries.filter((entry) => entry.kind === "payment" && entry.status === "succeeded");
  const reservedRefunds = entries.filter(
    (entry) => entry.kind === "refund" && (entry.status === "pending" || entry.status === "succeeded"),
  );
  const stripeRefundedCents = reservedRefunds
    .filter((entry) => entry.provider === "stripe")
    .reduce((sum, entry) => sum + entry.amountCents, 0);
  const manualRefundedCents = reservedRefunds
    .filter((entry) => entry.provider !== "stripe")
    .reduce((sum, entry) => sum + entry.amountCents, 0);

  const reservedByStripePayment = new Map<string, number>();
  for (const refund of reservedRefunds.filter((entry) => entry.provider === "stripe")) {
    const reference = decodeStripeRefundReference(refund.providerRef);
    if (!reference) continue;
    reservedByStripePayment.set(
      reference.sourcePaymentId,
      (reservedByStripePayment.get(reference.sourcePaymentId) ?? 0) + refund.amountCents,
    );
  }
  const stripeSources = succeededPayments
    .filter((entry) => entry.provider === "stripe" && Boolean(entry.providerRef))
    .map((entry) => ({
      paymentId: entry.id,
      checkoutSessionId: entry.providerRef!,
      refundableCents: Math.max(0, entry.amountCents - (reservedByStripePayment.get(entry.id) ?? 0)),
    }))
    .filter((entry) => entry.refundableCents > 0);
  const stripePaidCents = succeededPayments
    .filter((entry) => entry.provider === "stripe")
    .reduce((sum, entry) => sum + entry.amountCents, 0);
  const manualPaidCents =
    Math.max(0, depositAppliedCents) +
    succeededPayments
      .filter((entry) => entry.provider !== "stripe")
      .reduce((sum, entry) => sum + entry.amountCents, 0);

  return {
    stripeRefundableCents: Math.max(0, stripePaidCents - stripeRefundedCents),
    manualRefundableCents: Math.max(0, manualPaidCents - manualRefundedCents),
    stripeSources,
  };
}

let cachedProvider: PaymentProvider | null = null;

const LEGACY_AMBIGUOUS_CHECKOUT_FAILURES = new Set([
  "Checkout session expired",
  "Could not create checkout session",
]);

/** Legacy local failures that were recorded without authenticated provider state. */
export function isRecoverableCheckoutFailure(reason: string | null): boolean {
  return Boolean(reason && LEGACY_AMBIGUOUS_CHECKOUT_FAILURES.has(reason));
}

export function getPaymentProvider(): PaymentProvider {
  if (cachedProvider) return cachedProvider;
  if (process.env.STRIPE_SECRET_KEY) {
    cachedProvider = new StripeProvider();
  } else {
    if (process.env.NODE_ENV === "production") {
      throw new Error("Online payments are unavailable: STRIPE_SECRET_KEY is not configured");
    }
    cachedProvider = new FakePaymentProvider();
  }
  return cachedProvider;
}

/**
 * Idempotently marks a pending payment as succeeded and rolls the invoice
 * status forward. Shared by the Stripe webhook route and the dev fake-return
 * flow so both paths behave identically. Safe to call twice — a
 * already-succeeded payment is a no-op.
 */
export async function finalizeSucceededPayment(
  tx: Db,
  input: {
    paymentId: string;
    provider: "fake" | "stripe";
    providerRef: string;
    invoiceId?: string;
    amountCents?: number | null;
    paymentStatus?: string;
  },
): Promise<{ invoiceId: string; amountCents: number; alreadyProcessed: boolean } | null> {
  const rows = await tx.select().from(schema.payments).where(eq(schema.payments.id, input.paymentId)).for("update");
  const payment = rows[0];
  if (!payment) return null;
  if (!payment.invoiceId || payment.provider !== input.provider) return null;
  if (input.invoiceId && input.invoiceId !== payment.invoiceId) return null;
  if (payment.providerRef && payment.providerRef !== input.providerRef) return null;
  if (input.amountCents != null && input.amountCents !== payment.amountCents) return null;
  if (input.provider === "stripe" && input.paymentStatus !== "paid") return null;
  if (payment.status === "succeeded") {
    return { invoiceId: payment.invoiceId, amountCents: payment.amountCents, alreadyProcessed: true };
  }
  if (payment.status !== "pending" && !(payment.status === "failed" && input.provider === "stripe" && isRecoverableCheckoutFailure(payment.failureReason))) {
    return null;
  }

  await tx
    .update(schema.payments)
    .set({
      status: "succeeded",
      receivedAt: new Date(),
      providerRef: input.providerRef,
      updatedAt: new Date(),
    })
    .where(eq(schema.payments.id, payment.id));

  const { status } = await recalculateInvoiceStatus(tx, payment.invoiceId);

  await audit(tx, {
    actorType: "system",
    action: "invoice.payment_succeeded",
    entityType: "invoice",
    entityId: payment.invoiceId,
    after: { paymentId: payment.id, amountCents: payment.amountCents, provider: payment.provider, status },
  });

  return { invoiceId: payment.invoiceId, amountCents: payment.amountCents, alreadyProcessed: false };
}

/**
 * Finalizes an online appointment deposit against the server-reserved ledger
 * row. Both the appointment and payment are locked, and every provider value
 * must match before the deposit snapshot or appointment status can move.
 */
export async function finalizeSucceededAppointmentDeposit(
  tx: Db,
  input: {
    paymentId: string;
    appointmentId: string;
    provider: "fake" | "stripe";
    providerRef: string;
    amountCents: number;
    paymentStatus?: string;
  },
): Promise<{ appointmentId: string; amountCents: number; alreadyProcessed: boolean } | null> {
  const [peek] = await tx.select().from(schema.payments).where(eq(schema.payments.id, input.paymentId)).limit(1);
  if (!peek?.appointmentId || peek.appointmentId !== input.appointmentId) return null;

  // Checkout claims lock appointments before inspecting payments. Matching
  // that order here avoids deadlocks between checkout and webhook delivery.
  const [appointment] = await tx
    .select()
    .from(schema.appointments)
    .where(eq(schema.appointments.id, input.appointmentId))
    .for("update");
  const [payment] = await tx
    .select()
    .from(schema.payments)
    .where(eq(schema.payments.id, input.paymentId))
    .for("update");
  if (!appointment || !payment) return null;
  if (
    payment.appointmentId !== appointment.id ||
    payment.invoiceId !== null ||
    payment.customerId !== appointment.customerId ||
    payment.kind !== "deposit" ||
    payment.provider !== input.provider ||
    payment.amountCents !== input.amountCents
  ) {
    return null;
  }
  if (payment.providerRef && payment.providerRef !== input.providerRef) return null;
  if (input.provider === "stripe" && input.paymentStatus !== "paid") return null;

  if (payment.status === "succeeded") {
    if (appointment.depositPaidCents < payment.amountCents) return null;
    return { appointmentId: appointment.id, amountCents: payment.amountCents, alreadyProcessed: true };
  }
  const recoverableFailed =
    payment.status === "failed" && input.provider === "stripe" && isRecoverableCheckoutFailure(payment.failureReason);
  if (payment.status !== "pending" && !recoverableFailed) return null;
  const outstanding = Math.max(0, appointment.depositRequiredCents - appointment.depositPaidCents);
  if (appointment.status === "deposit_required" && (outstanding <= 0 || outstanding !== payment.amountCents)) return null;
  if (appointment.status !== "deposit_required" && !recoverableFailed) return null;

  const now = new Date();
  await tx
    .update(schema.payments)
    .set({
      status: "succeeded",
      receivedAt: now,
      providerRef: input.providerRef,
      failureReason: null,
      updatedAt: now,
    })
    .where(eq(schema.payments.id, payment.id));
  await tx
    .update(schema.appointments)
    .set({
      depositPaidCents: appointment.depositPaidCents + payment.amountCents,
      status: appointment.status === "deposit_required" ? "confirmed" : appointment.status,
      updatedAt: now,
    })
    .where(eq(schema.appointments.id, appointment.id));
  await audit(tx, {
    actorType: "system",
    action: "appointment.deposit_payment_succeeded",
    entityType: "appointment",
    entityId: appointment.id,
    before: { status: appointment.status, depositPaidCents: appointment.depositPaidCents },
    after: {
      status: appointment.status === "deposit_required" ? "confirmed" : appointment.status,
      depositPaidCents: appointment.depositPaidCents + payment.amountCents,
      paymentId: payment.id,
      amountCents: payment.amountCents,
      provider: payment.provider,
    },
  });
  return { appointmentId: appointment.id, amountCents: payment.amountCents, alreadyProcessed: false };
}

/**
 * Applies a Stripe refund outcome to the pending local refund reservation.
 * The amount is never taken from the provider response on faith: it must
 * exactly match the server-created ledger row before invoice totals move.
 */
export async function finalizeStripeRefund(
  tx: Db,
  input: {
    refundPaymentId: string;
    providerRef: string;
    amountCents: number;
    providerStatus: RefundPaymentResult["status"];
  },
): Promise<{
  invoiceId: string;
  amountCents: number;
  status: "pending" | "succeeded" | "failed";
  alreadyProcessed: boolean;
} | null> {
  const [refundPayment] = await tx
    .select()
    .from(schema.payments)
    .where(eq(schema.payments.id, input.refundPaymentId))
    .for("update");
  if (!refundPayment?.invoiceId || refundPayment.kind !== "refund" || refundPayment.provider !== "stripe") return null;
  if (refundPayment.amountCents !== input.amountCents) return null;

  const reference = decodeStripeRefundReference(refundPayment.providerRef);
  if (!reference) return null;
  if (refundPayment.status === "succeeded") {
    if (reference.refundId && reference.refundId !== input.providerRef) return null;
    return {
      invoiceId: refundPayment.invoiceId,
      amountCents: refundPayment.amountCents,
      status: "succeeded",
      alreadyProcessed: true,
    };
  }
  if (refundPayment.status === "failed") {
    return {
      invoiceId: refundPayment.invoiceId,
      amountCents: refundPayment.amountCents,
      status: "failed",
      alreadyProcessed: true,
    };
  }
  if (refundPayment.status !== "pending") return null;

  const providerRef = encodeStripeRefundReference({ ...reference, refundId: input.providerRef });
  if (input.providerStatus === "succeeded") {
    await tx
      .update(schema.payments)
      .set({
        status: "succeeded",
        providerRef,
        failureReason: null,
        receivedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(schema.payments.id, refundPayment.id));
    const { status } = await recalculateInvoiceStatus(tx, refundPayment.invoiceId);
    await audit(tx, {
      actorType: "system",
      action: "invoice.refund_succeeded",
      entityType: "invoice",
      entityId: refundPayment.invoiceId,
      after: {
        refundPaymentId: refundPayment.id,
        amountCents: refundPayment.amountCents,
        provider: "stripe",
        providerRef: input.providerRef,
        status,
      },
    });
    return {
      invoiceId: refundPayment.invoiceId,
      amountCents: refundPayment.amountCents,
      status: "succeeded",
      alreadyProcessed: false,
    };
  }

  if (input.providerStatus === "failed" || input.providerStatus === "canceled" || input.providerStatus === "requires_action") {
    await tx
      .update(schema.payments)
      .set({
        status: "failed",
        providerRef,
        failureReason: `Stripe refund ${input.providerStatus}`,
        updatedAt: new Date(),
      })
      .where(eq(schema.payments.id, refundPayment.id));
    await audit(tx, {
      actorType: "system",
      action: "invoice.refund_failed",
      entityType: "invoice",
      entityId: refundPayment.invoiceId,
      after: {
        refundPaymentId: refundPayment.id,
        amountCents: refundPayment.amountCents,
        provider: "stripe",
        providerRef: input.providerRef,
        providerStatus: input.providerStatus,
      },
    });
    return {
      invoiceId: refundPayment.invoiceId,
      amountCents: refundPayment.amountCents,
      status: "failed",
      alreadyProcessed: false,
    };
  }

  await tx
    .update(schema.payments)
    .set({ providerRef, updatedAt: new Date() })
    .where(eq(schema.payments.id, refundPayment.id));
  return {
    invoiceId: refundPayment.invoiceId,
    amountCents: refundPayment.amountCents,
    status: "pending",
    alreadyProcessed: false,
  };
}
