"use server";

import { resolveAppointmentDepositToken } from "@/lib/appointment-deposits";
import { beginAppointmentCheckout, confirmOnlineCheckout, toConfirmResult } from "@/lib/payments";
import { consumeRateLimit } from "@/lib/rate-limit";
import type { CheckoutConfirmResult, CheckoutStartResult } from "@/components/helcim-checkout";

/**
 * Pays a booking's deposit, or prepays the whole visit, from the secure link
 * sent at booking. The amount is always read from the appointment.
 */
export async function startAppointmentPaymentAction(
  token: string,
  purpose: "deposit" | "prepay",
): Promise<CheckoutStartResult> {
  const rate = await consumeRateLimit("appointment-deposit-checkout", { limit: 10, windowMs: 15 * 60_000 });
  if (!rate.allowed) return { ok: false, error: "Too many checkout attempts. Please wait and try again." };
  if (typeof token !== "string" || (purpose !== "deposit" && purpose !== "prepay")) {
    return { ok: false, error: "Invalid request" };
  }
  const resolved = await resolveAppointmentDepositToken(token);
  if (!resolved) return { ok: false, error: "This payment link is no longer valid." };
  return beginAppointmentCheckout({
    appointmentId: resolved.appointment.id,
    customerId: resolved.appointment.customerId,
    purpose,
  });
}

export async function confirmAppointmentPaymentAction(
  token: string,
  checkoutId: string,
  eventMessage: string,
): Promise<CheckoutConfirmResult> {
  if (typeof token !== "string" || typeof checkoutId !== "string") return { ok: false, error: "Invalid request" };
  const resolved = await resolveAppointmentDepositToken(token);
  if (!resolved) return { ok: false, error: "This payment link is no longer valid." };
  return toConfirmResult(
    await confirmOnlineCheckout({
      checkoutId,
      eventMessage,
      allowedCustomerIds: [resolved.appointment.customerId],
    }),
  );
}
