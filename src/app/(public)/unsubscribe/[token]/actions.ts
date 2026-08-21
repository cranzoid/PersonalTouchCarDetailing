"use server";

import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { audit } from "@/lib/audit";
import { addSuppression } from "@/lib/marketing/suppressions";
import { verifyUnsubscribeToken } from "@/lib/marketing/unsubscribe";

export type UnsubscribeResult = { ok: true } | { ok: false; error: string };

/**
 * Honours an unsubscribe. Reached only from the confirm button on the page —
 * never on page load, because mail scanners and link-preview bots follow every
 * URL in an email and would otherwise unsubscribe people who never clicked.
 */
export async function confirmUnsubscribeAction(token: unknown): Promise<UnsubscribeResult> {
  if (typeof token !== "string") return { ok: false, error: "This link is not valid." };
  const recipientId = verifyUnsubscribeToken(token);
  if (!recipientId) return { ok: false, error: "This link is not valid." };

  const [recipient] = await db()
    .select()
    .from(schema.outreachRecipients)
    .where(eq(schema.outreachRecipients.id, recipientId))
    .limit(1);
  if (!recipient) return { ok: false, error: "This link is not valid." };

  try {
    await db().transaction(async (tx) => {
      await addSuppression(tx, {
        channel: "email",
        destination: recipient.destination,
        reason: "unsubscribe_link",
        source: "Email unsubscribe link",
      });
      // Same reasoning as an SMS STOP: the suppression list is what binds, but
      // the contact's own record should not still read "consented".
      if (recipient.leadId) {
        await tx
          .update(schema.leads)
          .set({ marketingConsent: false, updatedAt: new Date() })
          .where(eq(schema.leads.id, recipient.leadId));
      }
      if (recipient.customerId) {
        await tx
          .update(schema.customers)
          .set({ marketingConsent: false, updatedAt: new Date() })
          .where(eq(schema.customers.id, recipient.customerId));
      }
      await audit(tx, {
        actorType: "customer",
        action: "marketing.unsubscribed",
        entityType: "outreach_recipient",
        entityId: recipient.id,
        after: { channel: "email", campaignId: recipient.campaignId },
      });
    });
  } catch (error) {
    console.error("confirmUnsubscribeAction failed", error);
    return { ok: false, error: "Something went wrong. Please email us and we will remove you." };
  }

  return { ok: true };
}
