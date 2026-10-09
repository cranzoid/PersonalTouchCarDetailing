"use server";

import { and, eq, inArray, ne } from "drizzle-orm";
import { db, schema } from "@/db";
import { audit } from "@/lib/audit";
import { formatCents } from "@/lib/money";
import { beginInvoicesCheckout, confirmOnlineCheckout, toConfirmResult } from "@/lib/payments";
import { resolveCustomerPortalToken } from "@/lib/portal";
import { consumeRateLimit } from "@/lib/rate-limit";
import { getSettings } from "@/lib/settings";
import { notifyStaff } from "@/lib/staff-notifications";
import type { CheckoutConfirmResult, CheckoutStartResult } from "@/components/helcim-checkout";

/**
 * The account workspace link (fleet accounts especially): pay any selection of
 * open invoices in one card payment, or tell the shop a cheque is coming. No
 * login — the long-lived link is the credential, scoped to one customer.
 */

function cleanIds(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 50) return null;
  const ids = raw.filter((id): id is string => typeof id === "string" && /^inv_[a-z0-9]{20}$/.test(id));
  return ids.length === raw.length ? ids : null;
}

export async function startWorkspacePaymentAction(token: string, invoiceIds: unknown): Promise<CheckoutStartResult> {
  const rate = await consumeRateLimit("workspace-checkout", { limit: 15, windowMs: 15 * 60_000 });
  if (!rate.allowed) return { ok: false, error: "Too many checkout attempts. Please wait and try again." };
  const ids = cleanIds(invoiceIds);
  if (typeof token !== "string" || !ids) return { ok: false, error: "Choose at least one invoice to pay." };
  const resolved = await resolveCustomerPortalToken(token);
  if (!resolved) return { ok: false, error: "This link is no longer valid." };
  return beginInvoicesCheckout({ invoiceIds: ids, allowedCustomerIds: [resolved.customer.id] });
}

export async function confirmWorkspacePaymentAction(
  token: string,
  checkoutId: string,
  eventMessage: string,
): Promise<CheckoutConfirmResult> {
  if (typeof token !== "string" || typeof checkoutId !== "string") return { ok: false, error: "Invalid request" };
  const resolved = await resolveCustomerPortalToken(token);
  if (!resolved) return { ok: false, error: "This link is no longer valid." };
  return toConfirmResult(
    await confirmOnlineCheckout({ checkoutId, eventMessage, allowedCustomerIds: [resolved.customer.id] }),
  );
}

/**
 * Records "we'll pay by cheque / in person" on the chosen invoices and tells
 * the shop. Moves no status: a promise to pay is not a payment.
 */
export async function setWorkspacePayIntentAction(
  token: string,
  invoiceIds: unknown,
  intent: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const rate = await consumeRateLimit("workspace-pay-intent", { limit: 10, windowMs: 15 * 60_000 });
  if (!rate.allowed) return { ok: false, error: "Please wait a moment and try again." };
  const ids = cleanIds(invoiceIds);
  if (typeof token !== "string" || !ids || (intent !== "cheque" && intent !== "in_person")) {
    return { ok: false, error: "Choose at least one invoice." };
  }
  const resolved = await resolveCustomerPortalToken(token);
  if (!resolved) return { ok: false, error: "This link is no longer valid." };
  const customer = resolved.customer;

  const updated = await db().transaction(async (tx) => {
    const rows = await tx
      .update(schema.invoices)
      .set({ customerPayIntent: intent, customerPayIntentAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          inArray(schema.invoices.id, ids),
          eq(schema.invoices.customerId, customer.id),
          inArray(schema.invoices.status, ["sent", "partially_paid", "overdue"]),
          ne(schema.invoices.status, "draft"),
        ),
      )
      .returning({ id: schema.invoices.id, number: schema.invoices.number, totalCents: schema.invoices.totalCents });
    for (const row of rows) {
      await audit(tx, {
        actorType: "customer",
        action: "invoice.customer_pay_intent",
        entityType: "invoice",
        entityId: row.id,
        after: { intent },
      });
    }
    return rows;
  });
  if (updated.length === 0) return { ok: false, error: "Those invoices are no longer open." };

  const settings = await getSettings();
  const name = customer.companyName ?? `${customer.firstName} ${customer.lastName}`.trim();
  const list = updated.map((row) => `INV-${row.number} (${formatCents(row.totalCents, settings.currency)})`).join(", ");
  try {
    await notifyStaff({
      subject: `${name}: paying ${intent === "cheque" ? "by cheque" : "in person"}`,
      body: `${name} says they will pay ${intent === "cheque" ? "by cheque" : "in person"} for ${list}.`,
      relatedType: "customer",
      relatedId: customer.id,
      customerId: customer.id,
    });
  } catch {
    console.error("pay-intent staff alert could not be sent");
  }
  return { ok: true };
}
