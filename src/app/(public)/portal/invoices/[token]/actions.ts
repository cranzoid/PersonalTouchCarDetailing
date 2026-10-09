"use server";

import { resolveInvoiceToken } from "@/lib/invoices";
import { beginInvoicesCheckout, confirmOnlineCheckout, toConfirmResult } from "@/lib/payments";
import { consumeRateLimit } from "@/lib/rate-limit";
import type { CheckoutConfirmResult, CheckoutStartResult } from "@/components/helcim-checkout";

/**
 * Starts (or resumes) the Helcim checkout for this invoice's balance. The
 * token is the customer's only credential; the amount always comes from the
 * ledger, never from the browser.
 */
export async function startInvoicePaymentAction(token: string): Promise<CheckoutStartResult> {
  const rate = await consumeRateLimit("invoice-checkout", { limit: 10, windowMs: 15 * 60_000 });
  if (!rate.allowed) return { ok: false, error: "Too many checkout attempts. Please wait and try again." };
  if (typeof token !== "string") return { ok: false, error: "Invalid request" };
  const resolved = await resolveInvoiceToken(token);
  if (!resolved) return { ok: false, error: "This link is no longer valid." };
  return beginInvoicesCheckout({
    invoiceIds: [resolved.invoice.id],
    allowedCustomerIds: [resolved.invoice.customerId],
  });
}

export async function confirmInvoicePaymentAction(
  token: string,
  checkoutId: string,
  eventMessage: string,
): Promise<CheckoutConfirmResult> {
  if (typeof token !== "string" || typeof checkoutId !== "string") return { ok: false, error: "Invalid request" };
  const resolved = await resolveInvoiceToken(token);
  if (!resolved) return { ok: false, error: "This link is no longer valid." };
  const outcome = await confirmOnlineCheckout({
    checkoutId,
    eventMessage,
    allowedCustomerIds: [resolved.invoice.customerId],
  });
  return toConfirmResult(outcome);
}
