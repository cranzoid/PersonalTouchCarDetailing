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

export type MessageResult = {
  id: string;
  sent: boolean;
  /** Machine-readable enough for callers to decide whether a retry is useful. */
  reason?: "suppressed" | "not_configured" | "provider_error";
};

export type TemplateRecipient = {
  email?: string | null;
  phone?: string | null;
};

export type TemplateDeliveryReason =
  | "template_missing"
  | "template_inactive"
  | "unsupported_channel"
  | "no_destination"
  | NonNullable<MessageResult["reason"]>;

export type TemplateDeliveryResult = {
  sent: boolean;
  channel?: OutboundMessage["channel"];
  id?: string;
  reason?: TemplateDeliveryReason;
};

type TemplateMessageInput = Omit<OutboundMessage, "channel" | "to" | "subject" | "body"> & {
  templateKey: string;
  recipient: TemplateRecipient;
  variables: Record<string, string>;
};

export function resolveTemplateDestination(
  channel: string,
  recipient: TemplateRecipient,
): { channel: OutboundMessage["channel"]; to: string } | null {
  if (channel === "email") {
    const to = recipient.email?.trim();
    return to ? { channel, to } : null;
  }
  if (channel === "sms") {
    const to = recipient.phone?.trim();
    return to ? { channel, to } : null;
  }
  return null;
}

/** Kinds that are promotional — blocked without explicit marketing consent. */
const MARKETING_KINDS = new Set(["marketing", "review_request", "maintenance"]);

/**
 * Sends (or in dev, logs) an outbound message and records it in the unified
 * communications history. Marketing-consent enforcement lives HERE so no
 * caller can accidentally bypass it. Operational messages (confirmations,
 * reminders, invoices…) are always allowed — booking an appointment is not
 * marketing consent.
 */
export async function sendMessage(msg: OutboundMessage): Promise<MessageResult> {
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
      return { id, sent: false, reason: "suppressed" };
    }
  }

  // Local development is deliberately side-effect free. Production never
  // silently falls back to this transport: missing provider credentials are
  // recorded as a failed communication so automations can retry after the
  // deployment is fixed.
  const id = newId("com");
  const logOnly = process.env.NODE_ENV !== "production" || process.env.MESSAGING_MODE === "log";
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
    status: logOnly ? "logged" : "queued",
  });
  if (logOnly) {
    // Never put recipient PII or message bodies in application logs.
    console.log(`[messaging:${msg.channel}] id=${id} kind=${msg.kind}`);
    return { id, sent: true };
  }

  try {
    const providerRef =
      msg.channel === "email" ? await sendWithResend(msg) : await sendWithTwilio(msg);
    if (!providerRef) {
      await db()
        .update(schema.communications)
        .set({ status: "failed" })
        .where(eq(schema.communications.id, id));
      return { id, sent: false, reason: "not_configured" };
    }
    await db()
      .update(schema.communications)
      .set({ status: "sent", providerRef })
      .where(eq(schema.communications.id, id));
    return { id, sent: true };
  } catch (error) {
    // Provider error details can include request metadata; keep them out of the
    // customer-facing communication row and application logs.
    console.error(`[messaging:${msg.channel}] provider delivery failed for ${id}`);
    await db()
      .update(schema.communications)
      .set({ status: "failed" })
      .where(eq(schema.communications.id, id));
    return { id, sent: false, reason: "provider_error" };
  }
}

/**
 * Delivers an active stored template through the channel configured on that
 * template. There is deliberately no cross-channel fallback: an email
 * template without an email address (or an SMS template without a phone
 * number) is a safe, explicit non-delivery.
 */
export async function sendMessageTemplate(input: TemplateMessageInput): Promise<TemplateDeliveryResult> {
  const [template] = await db()
    .select()
    .from(schema.messageTemplates)
    .where(eq(schema.messageTemplates.key, input.templateKey))
    .limit(1);

  if (!template) return { sent: false, reason: "template_missing" };
  if (!template.active) return { sent: false, reason: "template_inactive" };
  if (template.channel !== "email" && template.channel !== "sms") return { sent: false, reason: "unsupported_channel" };
  const destination = resolveTemplateDestination(template.channel, input.recipient);
  if (!destination) return { sent: false, channel: template.channel, reason: "no_destination" };
  const { channel, to } = destination;

  const result = await sendMessage({
    customerId: input.customerId,
    leadId: input.leadId,
    channel,
    kind: input.kind,
    to,
    subject: channel === "email" ? renderTemplate(template.subject ?? "", input.variables) : undefined,
    body: renderTemplate(template.body, input.variables),
    relatedEntityType: input.relatedEntityType,
    relatedEntityId: input.relatedEntityId,
  });
  return { ...result, channel };
}

/** Non-retryable outcomes for cron jobs that stamp a due item as handled. */
export function isTerminalTemplateDelivery(result: TemplateDeliveryResult): boolean {
  return (
    result.sent ||
    result.reason === "template_missing" ||
    result.reason === "template_inactive" ||
    result.reason === "unsupported_channel" ||
    result.reason === "no_destination" ||
    result.reason === "suppressed"
  );
}

async function sendWithResend(msg: OutboundMessage): Promise<string | null> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (!apiKey || !from) return null;
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [msg.to],
      subject: msg.subject ?? "Message from Personal Touch Car Detailing",
      text: msg.body,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Resend returned ${response.status}`);
  const payload = (await response.json()) as { id?: string };
  if (!payload.id) throw new Error("Resend response had no message id");
  return payload.id;
}

async function sendWithTwilio(msg: OutboundMessage): Promise<string | null> {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER;
  if (!accountSid || !authToken || !from) return null;
  const form = new URLSearchParams({ To: msg.to, From: from, Body: msg.body });
  const response = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form,
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!response.ok) throw new Error(`Twilio returned ${response.status}`);
  const payload = (await response.json()) as { sid?: string };
  if (!payload.sid) throw new Error("Twilio response had no message id");
  return payload.sid;
}

/** Simple {{placeholder}} template rendering. */
export function renderTemplate(body: string, vars: Record<string, string>): string {
  return body.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? "");
}
