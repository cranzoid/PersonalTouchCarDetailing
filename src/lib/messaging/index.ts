import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { newId } from "@/lib/id";

export type OutboundMessage = {
  customerId?: string;
  leadId?: string;
  channel: "email" | "sms";
  kind:
    | "lead_ack"
    | "confirmation"
    | "reminder"
    | "estimate"
    | "approval_request"
    | "deposit_reminder"
    | "delay"
    | "ready"
    | "invoice"
    | "receipt"
    | "review_request"
    | "maintenance"
    | "marketing"
    | "manual";
  to: string;
  subject?: string;
  body: string;
  relatedEntityType?: string;
  relatedEntityId?: string;
};

/** Kinds that are promotional — blocked without explicit marketing consent. */
const MARKETING_KINDS = new Set(["marketing", "review_request", "maintenance"]);

/**
 * Sends (or in dev, logs) an outbound message and records it in the unified
 * communications history. Marketing-consent enforcement lives HERE so no
 * caller can accidentally bypass it. Operational messages (confirmations,
 * reminders, invoices…) are always allowed — booking an appointment is not
 * marketing consent.
 */
export async function sendMessage(msg: OutboundMessage): Promise<{ id: string; sent: boolean }> {
  if (MARKETING_KINDS.has(msg.kind)) {
    if (!msg.customerId) {
      throw new Error(`Marketing-class message "${msg.kind}" requires a customer with recorded consent`);
    }
    const customer = await db()
      .select({ marketingConsent: schema.customers.marketingConsent })
      .from(schema.customers)
      .where(eq(schema.customers.id, msg.customerId))
      .limit(1);
    if (!customer[0]?.marketingConsent) {
      const id = newId("com");
      await db().insert(schema.communications).values({
        id,
        customerId: msg.customerId,
        channel: msg.channel,
        kind: msg.kind,
        subject: msg.subject,
        body: `[SUPPRESSED — no marketing consent] ${msg.body.slice(0, 200)}`,
        relatedEntityType: msg.relatedEntityType,
        relatedEntityId: msg.relatedEntityId,
        status: "failed",
      });
      return { id, sent: false };
    }
  }

  // Dev transport: log to DB + console. Production adapters (Resend/Twilio)
  // plug in here behind the same interface (Phase 5).
  const id = newId("com");
  await db().insert(schema.communications).values({
    id,
    customerId: msg.customerId,
    leadId: msg.leadId,
    channel: msg.channel,
    kind: msg.kind,
    subject: msg.subject,
    body: msg.body,
    relatedEntityType: msg.relatedEntityType,
    relatedEntityId: msg.relatedEntityId,
    status: "logged",
  });
  if (process.env.NODE_ENV !== "production") {
    console.log(`[messaging:${msg.channel}] to=${msg.to} kind=${msg.kind} subject=${msg.subject ?? ""}`);
  }
  return { id, sent: true };
}

/** Simple {{placeholder}} template rendering. */
export function renderTemplate(body: string, vars: Record<string, string>): string {
  return body.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? "");
}
