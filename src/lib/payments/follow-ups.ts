import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { sendAppointmentDepositConfirmation } from "@/lib/appointment-deposits";
import { sendInvoiceReceipt } from "@/lib/invoices";
import {
  sendMembershipCardUpdated,
  sendMembershipWelcome,
  sendWinterPassConfirmation,
} from "@/lib/memberships/notify";

/**
 * Messages owed once a checkout has COMMITTED as paid. Runs after the ledger
 * transaction, never inside it: a mail provider being down must not roll back
 * money that was taken. Each send is independent so one failure does not
 * swallow the rest.
 *
 * Membership month and upgrade charges are told to the member by the billing
 * engine itself, which knows whether it was a renewal or an upgrade.
 */
export async function sendCheckoutFollowUps(checkoutId: string): Promise<void> {
  const [checkout] = await db()
    .select()
    .from(schema.paymentCheckouts)
    .where(eq(schema.paymentCheckouts.id, checkoutId))
    .limit(1);
  if (!checkout || checkout.status !== "succeeded") return;
  const rows = await db().select().from(schema.payments).where(eq(schema.payments.checkoutId, checkoutId));

  const attempt = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (error) {
      console.error(`[checkout ${checkoutId}] ${label} could not be sent`, error);
    }
  };

  switch (checkout.kind) {
    case "invoices":
    case "terminal":
    case "membership_charge":
    case "membership_upgrade":
      for (const row of rows) {
        if (row.invoiceId && row.status === "succeeded") {
          await attempt("receipt", () => sendInvoiceReceipt(row.invoiceId!, row.amountCents));
        }
      }
      break;
    case "appointment_deposit":
    case "appointment_prepay":
      for (const row of rows) {
        if (row.appointmentId && row.status === "succeeded") {
          await attempt("deposit confirmation", () =>
            sendAppointmentDepositConfirmation(row.appointmentId!, row.amountCents, {
              prepaid: checkout.kind === "appointment_prepay",
            }),
          );
        }
      }
      break;
    case "winter_pass":
      if (checkout.subject.passId) await attempt("pass confirmation", () => sendWinterPassConfirmation(checkout.subject.passId!));
      break;
    case "membership_signup":
      if (checkout.subject.membershipId) {
        await attempt("membership welcome", () => sendMembershipWelcome(checkout.subject.membershipId!));
      }
      break;
    case "card_update":
      if (checkout.subject.membershipId) {
        await attempt("card updated", () => sendMembershipCardUpdated(checkout.subject.membershipId!));
      }
      break;
  }
}
