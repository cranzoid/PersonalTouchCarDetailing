import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { newId } from "@/lib/id";
import {
  getPaymentProvider,
  finalizeStripeRefund,
  finalizeSucceededAppointmentDeposit,
  finalizeSucceededPayment,
} from "@/lib/payments";
import { sendInvoiceReceipt } from "@/lib/invoices";
import { sendAppointmentDepositConfirmation } from "@/lib/appointment-deposits";

/**
 * Stripe webhook receiver. Only reachable when STRIPE_SECRET_KEY /
 * STRIPE_WEBHOOK_SECRET are configured — the fake dev provider never calls
 * this route (see the portal invoice page's return-trip finalization).
 * Every event is recorded in webhook_events keyed by Stripe's event id;
 * duplicate deliveries (Stripe retries on any non-2xx) are no-ops.
 */
export async function POST(req: Request) {
  let provider;
  try {
    provider = getPaymentProvider();
  } catch {
    return new NextResponse("Payment provider not configured", { status: 503 });
  }
  if (provider.name !== "stripe") {
    return new NextResponse("Payment provider not configured", { status: 400 });
  }

  const rawBody = await req.text();
  const signature = req.headers.get("stripe-signature");
  const event = provider.verifyWebhookEvent(rawBody, signature);
  if (!event) return new NextResponse("Invalid signature", { status: 400 });

  try {
    const outcome = await db().transaction(async (tx) => {
      await tx
        .insert(schema.webhookEvents)
        .values({
          id: newId("whe"),
          provider: "stripe",
          eventId: event.id,
          eventType: event.type,
          payload: event.raw as object,
        })
        .onConflictDoNothing({ target: schema.webhookEvents.eventId });

      const [webhookRow] = await tx
        .select()
        .from(schema.webhookEvents)
        .where(eq(schema.webhookEvents.eventId, event.id))
        .for("update");
      if (!webhookRow) throw new Error("Webhook event could not be recorded");
      if (webhookRow.processedAt) {
        return { alreadyProcessed: true as const, payment: null, appointmentDeposit: null, refund: null };
      }

      let payment: Awaited<ReturnType<typeof finalizeSucceededPayment>> = null;
      let appointmentDeposit: Awaited<ReturnType<typeof finalizeSucceededAppointmentDeposit>> = null;
      let refund: Awaited<ReturnType<typeof finalizeStripeRefund>> = null;
      if (event.type === "checkout.session.completed") {
        if (!event.paymentId || !event.sessionId) throw new Error("Checkout event is missing payment references");
        if (Boolean(event.invoiceId) === Boolean(event.appointmentId)) {
          throw new Error("Checkout event must identify exactly one payable subject");
        }
        if (event.appointmentId) {
          if (event.amountTotal == null) throw new Error("Deposit checkout event is missing its amount");
          appointmentDeposit = await finalizeSucceededAppointmentDeposit(tx, {
            paymentId: event.paymentId,
            appointmentId: event.appointmentId,
            provider: "stripe",
            providerRef: event.sessionId,
            amountCents: event.amountTotal,
            paymentStatus: event.paymentStatus,
          });
          if (!appointmentDeposit) throw new Error("Checkout event did not match the pending appointment deposit");
        } else {
          payment = await finalizeSucceededPayment(tx, {
            paymentId: event.paymentId,
            provider: "stripe",
            providerRef: event.sessionId,
            invoiceId: event.invoiceId,
            amountCents: event.amountTotal,
            paymentStatus: event.paymentStatus,
          });
          if (!payment) throw new Error("Checkout event did not match the pending invoice payment");
        }
      }
      if (event.type === "refund.created" || event.type === "refund.updated" || event.type === "refund.failed") {
        if (!event.refundPaymentId || !event.refundId || event.refundAmount == null || !event.refundStatus) {
          throw new Error("Refund event is missing ledger references");
        }
        refund = await finalizeStripeRefund(tx, {
          refundPaymentId: event.refundPaymentId,
          providerRef: event.refundId,
          amountCents: event.refundAmount,
          providerStatus: event.refundStatus as "pending" | "succeeded" | "failed" | "canceled" | "requires_action",
        });
        if (!refund) throw new Error("Refund event did not match the pending refund");
      }

      await tx
        .update(schema.webhookEvents)
        .set({ processedAt: new Date(), error: null })
        .where(eq(schema.webhookEvents.id, webhookRow.id));
      return { alreadyProcessed: false as const, payment, appointmentDeposit, refund };
    });

    // Delivery is a separate side effect. A provider outage must not roll
    // back or repeatedly reprocess an already-settled financial webhook.
    if (!outcome.alreadyProcessed && outcome.payment && !outcome.payment.alreadyProcessed) {
      try {
        await sendInvoiceReceipt(outcome.payment.invoiceId, outcome.payment.amountCents);
      } catch {
        console.error("Invoice receipt could not be queued after Stripe payment");
      }
    }
    if (!outcome.alreadyProcessed && outcome.appointmentDeposit && !outcome.appointmentDeposit.alreadyProcessed) {
      try {
        await sendAppointmentDepositConfirmation(
          outcome.appointmentDeposit.appointmentId,
          outcome.appointmentDeposit.amountCents,
        );
      } catch {
        console.error("Appointment deposit confirmation could not be queued after Stripe payment");
      }
    }
    return new NextResponse("ok", { status: 200 });
  } catch (err) {
    console.error("stripe webhook handling failed", err);
    // Keep the row unprocessed so Stripe's retry can safely attempt it again.
    await db()
      .update(schema.webhookEvents)
      .set({ error: err instanceof Error ? err.message : "unknown error" })
      .where(eq(schema.webhookEvents.eventId, event.id));
    return new NextResponse("Internal error", { status: 500 });
  }
}
