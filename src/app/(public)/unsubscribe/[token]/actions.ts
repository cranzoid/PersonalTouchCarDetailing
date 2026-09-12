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

  // A lead-signed token: somebody who gave us their address directly rather
  // than through a campaign. Same right to leave, same one-click link.
  const recipient = recipientId.startsWith("lead_")
    ? await loadLeadRecipient(recipientId)
    : await loadCampaignRecipient(recipientId);
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
        entityType: recipient.entityType,
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

/** The shape both token kinds reduce to, so the suppression path is one path. */
type UnsubscribeTarget = {
  id: string;
  entityType: string;
  destination: string;
  leadId: string | null;
  customerId: string | null;
  campaignId: string | null;
};

async function loadCampaignRecipient(id: string): Promise<UnsubscribeTarget | null> {
  const [row] = await db()
    .select()
    .from(schema.outreachRecipients)
    .where(eq(schema.outreachRecipients.id, id))
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    entityType: "outreach_recipient",
    destination: row.destination,
    leadId: row.leadId,
    customerId: row.customerId,
    campaignId: row.campaignId,
  };
}

async function loadLeadRecipient(id: string): Promise<UnsubscribeTarget | null> {
  const [row] = await db().select().from(schema.leads).where(eq(schema.leads.id, id)).limit(1);
  if (!row?.email) return null;
  return {
    id: row.id,
    entityType: "lead",
    destination: row.email,
    leadId: row.id,
    customerId: row.convertedCustomerId,
    campaignId: null,
  };
}
