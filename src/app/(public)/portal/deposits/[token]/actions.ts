"use server";

import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import {
  resolveAppointmentDepositToken,
  sendAppointmentDepositConfirmation,
} from "@/lib/appointment-deposits";
import { newId } from "@/lib/id";
import {
  finalizeSucceededAppointmentDeposit,
  getPaymentProvider,
  isRecoverableCheckoutFailure,
  type PaymentProvider,
} from "@/lib/payments";
import { consumeRateLimit } from "@/lib/rate-limit";
import { getSettings } from "@/lib/settings";
import { getAppBaseUrl } from "@/lib/urls";

export type DepositCheckoutResult = { ok: true; url: string } | { ok: false; error: string };

type PaymentRow = typeof schema.payments.$inferSelect;

function isUnreconciledDeposit(payment: PaymentRow): boolean {
  return (
    payment.kind === "deposit" &&
    (payment.provider === "stripe" || payment.provider === "fake") &&
    (payment.status === "pending" || (payment.status === "failed" && isRecoverableCheckoutFailure(payment.failureReason)))
  );
}

async function claimDepositCheckout(input: {
  appointmentId: string;
  customerId: string;
  providerName: PaymentProvider["name"];
}) {
  return db().transaction(async (tx) => {
    const [appointment] = await tx
      .select()
      .from(schema.appointments)
      .where(eq(schema.appointments.id, input.appointmentId))
      .for("update");
    if (!appointment || appointment.customerId !== input.customerId) {
      return { ok: false as const, error: "This deposit link is no longer valid." };
    }
    if (appointment.status === "cancelled") {
      return { ok: false as const, error: "This appointment was cancelled and is no longer payable." };
    }

    const payments = await tx.select().from(schema.payments).where(eq(schema.payments.appointmentId, appointment.id));
    const unresolved = payments.filter(isUnreconciledDeposit);
    if (unresolved.length > 1) {
      return { ok: false as const, error: "Multiple deposit sessions need reconciliation. Please contact us before paying again." };
    }
    if (unresolved[0]) return { ok: true as const, appointment, payment: unresolved[0] };

    const outstandingCents = Math.max(0, appointment.depositRequiredCents - appointment.depositPaidCents);
    if (outstandingCents <= 0 || appointment.status === "confirmed") {
      return { ok: false as const, error: "This deposit has already been paid." };
    }
    if (appointment.status !== "deposit_required") {
      return { ok: false as const, error: "This appointment is not awaiting a deposit." };
    }

    const paymentId = newId("pay");
    const [payment] = await tx
      .insert(schema.payments)
      .values({
        id: paymentId,
        appointmentId: appointment.id,
        customerId: appointment.customerId,
        provider: input.providerName,
        idempotencyKey: `appointment_deposit_checkout_${paymentId}`,
        kind: "deposit",
        amountCents: outstandingCents,
        status: "pending",
      })
      .returning();
    return { ok: true as const, appointment, payment };
  });
}

async function storeCreatedDepositSession(input: {
  appointmentId: string;
  customerId: string;
  payment: PaymentRow;
  providerRef: string;
}): Promise<"open" | "paid" | "conflict"> {
  return db().transaction(async (tx) => {
    const [appointment] = await tx
      .select()
      .from(schema.appointments)
      .where(eq(schema.appointments.id, input.appointmentId))
      .for("update");
    const [payment] = await tx.select().from(schema.payments).where(eq(schema.payments.id, input.payment.id)).for("update");
    if (!appointment || appointment.customerId !== input.customerId || !payment || payment.appointmentId !== appointment.id) {
      return "conflict";
    }
    if (payment.status === "succeeded") return "paid";
    const mutable =
      payment.status === "pending" || (payment.status === "failed" && isRecoverableCheckoutFailure(payment.failureReason));
    if (
      !mutable ||
      payment.provider !== input.payment.provider ||
      payment.amountCents !== input.payment.amountCents
    ) {
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

async function updateReconciledDeposit(input: {
  appointmentId: string;
  customerId: string;
  paymentId: string;
  providerRef: string;
  status: "open" | "expired";
}): Promise<void> {
  await db().transaction(async (tx) => {
    const [appointment] = await tx
      .select()
      .from(schema.appointments)
      .where(eq(schema.appointments.id, input.appointmentId))
      .for("update");
    const [payment] = await tx.select().from(schema.payments).where(eq(schema.payments.id, input.paymentId)).for("update");
    if (
      !appointment ||
      appointment.customerId !== input.customerId ||
      !payment ||
      payment.appointmentId !== appointment.id ||
      payment.providerRef !== input.providerRef ||
      !isUnreconciledDeposit(payment)
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

export async function createAppointmentDepositCheckoutAction(raw: unknown): Promise<DepositCheckoutResult> {
  const rate = await consumeRateLimit("appointment-deposit-checkout", { limit: 10, windowMs: 15 * 60_000 });
  if (!rate.allowed) return { ok: false, error: "Too many checkout attempts. Please wait and try again." };
  if (typeof raw !== "object" || raw === null || typeof (raw as { token?: unknown }).token !== "string") {
    return { ok: false, error: "Invalid request" };
  }
  const token = (raw as { token: string }).token;
  const resolved = await resolveAppointmentDepositToken(token);
  if (!resolved) return { ok: false, error: "This deposit link is no longer valid." };

  let provider: PaymentProvider;
  try {
    provider = getPaymentProvider();
  } catch {
    return { ok: false, error: "Online payment is temporarily unavailable. Please contact us." };
  }
  const [[customer], settings] = await Promise.all([
    db().select().from(schema.customers).where(eq(schema.customers.id, resolved.appointment.customerId)).limit(1),
    getSettings(),
  ]);
  const returnUrl = `${getAppBaseUrl()}/portal/deposits/${token}`;

  for (let attempt = 0; attempt < 3; attempt++) {
    const claim = await claimDepositCheckout({
      appointmentId: resolved.appointment.id,
      customerId: resolved.appointment.customerId,
      providerName: provider.name,
    });
    if (!claim.ok) return claim;
    const { appointment, payment } = claim;
    if (payment.provider !== provider.name) {
      return { ok: false, error: "The existing deposit session cannot be reconciled by the configured provider." };
    }

    if (!payment.providerRef) {
      try {
        const session = await provider.createCheckoutSession({
          appointmentId: appointment.id,
          paymentId: payment.id,
          amountCents: payment.amountCents,
          currency: settings.currency,
          customerEmail: customer?.email ?? undefined,
          description: `Appointment deposit — ${settings.businessName}`,
          successUrl: returnUrl,
          cancelUrl: returnUrl,
        });
        const stored = await storeCreatedDepositSession({
          appointmentId: appointment.id,
          customerId: appointment.customerId,
          payment,
          providerRef: session.providerRef,
        });
        if (stored === "conflict") return { ok: false, error: "The deposit state changed. Please refresh before trying again." };
        if (stored === "paid") return { ok: true, url: returnUrl };
        if (session.url) return { ok: true, url: session.url };
        continue;
      } catch (error) {
        console.error("createAppointmentDepositCheckoutAction could not confirm checkout creation", error);
        return { ok: false, error: "Could not confirm checkout creation. Retry safely in a moment." };
      }
    }

    let session;
    try {
      session = await provider.getCheckoutSession({
        appointmentId: appointment.id,
        providerRef: payment.providerRef,
        paymentId: payment.id,
        amountCents: payment.amountCents,
        currency: settings.currency,
        successUrl: returnUrl,
      });
    } catch (error) {
      console.error("createAppointmentDepositCheckoutAction could not reconcile checkout", error);
      return { ok: false, error: "Could not verify the existing deposit checkout. Please try again." };
    }
    if (session.status === "invalid") {
      return { ok: false, error: "The payment provider session did not match this appointment. Please contact us." };
    }
    if (session.status === "open" && session.url) {
      if (payment.status === "failed") {
        await updateReconciledDeposit({
          appointmentId: appointment.id,
          customerId: appointment.customerId,
          paymentId: payment.id,
          providerRef: payment.providerRef,
          status: "open",
        });
      }
      return { ok: true, url: session.url };
    }
    if (session.status === "processing") {
      return { ok: false, error: "Your existing deposit payment is still processing. Please wait before trying again." };
    }
    if (session.status === "paid") {
      const outcome = await db().transaction((tx) =>
        finalizeSucceededAppointmentDeposit(tx, {
          paymentId: payment.id,
          appointmentId: appointment.id,
          provider: payment.provider as "fake" | "stripe",
          providerRef: payment.providerRef!,
          amountCents: payment.amountCents,
          paymentStatus: "paid",
        }),
      );
      if (!outcome) return { ok: false, error: "The paid session did not match the deposit ledger. Please contact us." };
      if (!outcome.alreadyProcessed) {
        try {
          await sendAppointmentDepositConfirmation(outcome.appointmentId, outcome.amountCents);
        } catch {
          console.error("Appointment deposit confirmation could not be queued after checkout reconciliation");
        }
      }
      return { ok: true, url: returnUrl };
    }

    await updateReconciledDeposit({
      appointmentId: appointment.id,
      customerId: appointment.customerId,
      paymentId: payment.id,
      providerRef: payment.providerRef,
      status: "expired",
    });
  }
  return { ok: false, error: "Could not safely establish a deposit session. Please contact us." };
}
