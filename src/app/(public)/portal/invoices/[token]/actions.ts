"use server";

import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { newId } from "@/lib/id";
import { resolveInvoiceToken, sendInvoiceReceipt, summarizePayments } from "@/lib/invoices";
import {
  finalizeSucceededPayment,
  getPaymentProvider,
  isRecoverableCheckoutFailure,
  type PaymentProvider,
} from "@/lib/payments";
import { consumeRateLimit } from "@/lib/rate-limit";
import { getSettings } from "@/lib/settings";
import { getAppBaseUrl } from "@/lib/urls";

export type PortalActionResult = { ok: true; url: string } | { ok: false; error: string };

type InvoiceRow = typeof schema.invoices.$inferSelect;
type PaymentRow = typeof schema.payments.$inferSelect;

function isUnreconciledCheckout(payment: PaymentRow): boolean {
  return (
    payment.kind === "payment" &&
    (payment.provider === "stripe" || payment.provider === "fake") &&
    (payment.status === "pending" || (payment.status === "failed" && isRecoverableCheckoutFailure(payment.failureReason)))
  );
}

async function claimInvoiceCheckout(input: {
  invoiceId: string;
  customerId: string;
  providerName: PaymentProvider["name"];
}) {
  return db().transaction(async (tx) => {
    const [invoice] = await tx.select().from(schema.invoices).where(eq(schema.invoices.id, input.invoiceId)).for("update");
    if (!invoice || invoice.customerId !== input.customerId) {
      return { ok: false as const, error: "This link is no longer valid." };
    }
    if (invoice.status === "cancelled" || invoice.status === "refunded") {
      return { ok: false as const, error: `This invoice was ${invoice.status}.` };
    }

    const payments = await tx.select().from(schema.payments).where(eq(schema.payments.invoiceId, invoice.id));
    const unresolved = payments.filter(isUnreconciledCheckout);
    if (unresolved.length > 1) {
      return { ok: false as const, error: "Multiple payment sessions need reconciliation. Please contact us before paying again." };
    }
    if (unresolved[0]) return { ok: true as const, invoice, payment: unresolved[0], created: false as const };

    const { balanceCents } = summarizePayments(invoice.totalCents, invoice.depositAppliedCents, payments);
    if (balanceCents <= 0) return { ok: false as const, error: "This invoice is already paid in full." };

    const paymentId = newId("pay");
    const [payment] = await tx
      .insert(schema.payments)
      .values({
        id: paymentId,
        invoiceId: invoice.id,
        customerId: invoice.customerId,
        provider: input.providerName,
        idempotencyKey: `checkout_${paymentId}`,
        kind: "payment",
        amountCents: balanceCents,
        status: "pending",
      })
      .returning();
    return { ok: true as const, invoice, payment, created: true as const };
  });
}

async function storeCreatedSession(input: {
  invoiceId: string;
  customerId: string;
  payment: PaymentRow;
  providerRef: string;
}): Promise<"open" | "paid" | "conflict"> {
  return db().transaction(async (tx) => {
    const [invoice] = await tx.select().from(schema.invoices).where(eq(schema.invoices.id, input.invoiceId)).for("update");
    const [payment] = await tx.select().from(schema.payments).where(eq(schema.payments.id, input.payment.id)).for("update");
    if (!invoice || invoice.customerId !== input.customerId || !payment || payment.invoiceId !== invoice.id) return "conflict";
    if (payment.status === "succeeded") return "paid";
    const mutable =
      payment.status === "pending" || (payment.status === "failed" && isRecoverableCheckoutFailure(payment.failureReason));
    if (!mutable || payment.provider !== input.payment.provider || payment.amountCents !== input.payment.amountCents) {
      return "conflict";
    }
    if (payment.providerRef && payment.providerRef !== input.providerRef) return "conflict";
    if (!payment.providerRef) {
      await tx
        .update(schema.payments)
        .set({ status: "pending", providerRef: input.providerRef, failureReason: null, updatedAt: new Date() })
        .where(eq(schema.payments.id, payment.id));
    }
    return "open";
  });
}

async function updateReconciledInvoiceCheckout(input: {
  invoiceId: string;
  customerId: string;
  paymentId: string;
  providerRef: string;
  status: "open" | "expired";
}): Promise<void> {
  await db().transaction(async (tx) => {
    const [invoice] = await tx.select().from(schema.invoices).where(eq(schema.invoices.id, input.invoiceId)).for("update");
    const [payment] = await tx.select().from(schema.payments).where(eq(schema.payments.id, input.paymentId)).for("update");
    if (
      !invoice ||
      invoice.customerId !== input.customerId ||
      !payment ||
      payment.invoiceId !== invoice.id ||
      payment.providerRef !== input.providerRef ||
      !isUnreconciledCheckout(payment)
    ) {
      return;
    }
    await tx
      .update(schema.payments)
      .set(
        input.status === "open"
          ? { status: "pending", failureReason: null, updatedAt: new Date() }
          : { status: "failed", failureReason: "Provider confirmed checkout expired", updatedAt: new Date() },
      )
      .where(eq(schema.payments.id, payment.id));
  });
}

/**
 * Starts or resumes a checkout for the outstanding invoice balance. Provider
 * calls happen outside transactions; every resulting mutation re-locks and
 * revalidates the invoice/payment pair.
 */
export async function createInvoiceCheckoutAction(raw: unknown): Promise<PortalActionResult> {
  const rate = await consumeRateLimit("invoice-checkout", { limit: 10, windowMs: 15 * 60_000 });
  if (!rate.allowed) return { ok: false, error: "Too many checkout attempts. Please wait and try again." };
  if (typeof raw !== "object" || raw === null || typeof (raw as { token?: unknown }).token !== "string") {
    return { ok: false, error: "Invalid request" };
  }
  const token = (raw as { token: string }).token;
  const resolved = await resolveInvoiceToken(token);
  if (!resolved) return { ok: false, error: "This link is no longer valid." };

  let provider: PaymentProvider;
  try {
    provider = getPaymentProvider();
  } catch {
    return { ok: false, error: "Online payment is temporarily unavailable. Please contact us." };
  }
  const settings = await getSettings();
  const [customer] = await db()
    .select()
    .from(schema.customers)
    .where(eq(schema.customers.id, resolved.invoice.customerId))
    .limit(1);
  const returnUrl = `${getAppBaseUrl()}/portal/invoices/${token}`;

  // One retry is enough after an authenticated expiry: the second claim sees
  // either the replacement created by this request or one created concurrently.
  for (let attempt = 0; attempt < 3; attempt++) {
    const claim = await claimInvoiceCheckout({
      invoiceId: resolved.invoice.id,
      customerId: resolved.invoice.customerId,
      providerName: provider.name,
    });
    if (!claim.ok) return claim;
    const { invoice, payment } = claim;
    if (payment.provider !== provider.name) {
      return { ok: false, error: "The existing payment session cannot be reconciled by the configured provider." };
    }

    if (!payment.providerRef) {
      try {
        const session = await provider.createCheckoutSession({
          invoiceId: invoice.id,
          paymentId: payment.id,
          amountCents: payment.amountCents,
          currency: settings.currency,
          customerEmail: customer?.email ?? undefined,
          description: `Invoice INV-${invoice.number} — ${settings.businessName}`,
          successUrl: returnUrl,
          cancelUrl: returnUrl,
        });
        const stored = await storeCreatedSession({
          invoiceId: invoice.id,
          customerId: invoice.customerId,
          payment,
          providerRef: session.providerRef,
        });
        if (stored === "conflict") return { ok: false, error: "The payment state changed. Please refresh before trying again." };
        if (stored === "paid") return { ok: true, url: returnUrl };
        if (session.url) return { ok: true, url: session.url };
        continue;
      } catch (error) {
        console.error("createInvoiceCheckoutAction could not confirm checkout creation", error);
        // Ambiguous provider failures remain pending. A retry uses the same
        // payment ID and therefore the same Stripe idempotency key.
        return { ok: false, error: "Could not confirm checkout creation. Retry safely in a moment." };
      }
    }

    let session;
    try {
      session = await provider.getCheckoutSession({
        invoiceId: invoice.id,
        providerRef: payment.providerRef,
        paymentId: payment.id,
        amountCents: payment.amountCents,
        currency: settings.currency,
        successUrl: returnUrl,
      });
    } catch (error) {
      console.error("createInvoiceCheckoutAction could not reconcile checkout", error);
      return { ok: false, error: "Could not verify the existing checkout. Please try again." };
    }
    if (session.status === "invalid") {
      return { ok: false, error: "The payment provider session did not match this invoice. Please contact us." };
    }
    if (session.status === "open" && session.url) {
      if (payment.status === "failed") {
        await updateReconciledInvoiceCheckout({
          invoiceId: invoice.id,
          customerId: invoice.customerId,
          paymentId: payment.id,
          providerRef: payment.providerRef,
          status: "open",
        });
      }
      return { ok: true, url: session.url };
    }
    if (session.status === "processing") {
      return { ok: false, error: "Your existing payment is still processing. Please wait before trying again." };
    }
    if (session.status === "paid") {
      const outcome = await db().transaction((tx) =>
        finalizeSucceededPayment(tx, {
          paymentId: payment.id,
          provider: payment.provider as "fake" | "stripe",
          providerRef: payment.providerRef!,
          invoiceId: invoice.id,
          amountCents: payment.amountCents,
          paymentStatus: "paid",
        }),
      );
      if (!outcome) return { ok: false, error: "The paid session did not match the invoice ledger. Please contact us." };
      if (!outcome.alreadyProcessed) {
        try {
          await sendInvoiceReceipt(outcome.invoiceId, outcome.amountCents);
        } catch {
          console.error("Invoice receipt could not be queued after checkout reconciliation");
        }
      }
      return { ok: true, url: returnUrl };
    }

    await updateReconciledInvoiceCheckout({
      invoiceId: invoice.id,
      customerId: invoice.customerId,
      paymentId: payment.id,
      providerRef: payment.providerRef,
      status: "expired",
    });
  }
  return { ok: false, error: "Could not safely establish a payment session. Please contact us." };
}
