import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { newId } from "@/lib/id";
import { getIntegrationSecret } from "@/lib/integrations";
import { isSuppressed, type MarketingChannel } from "@/lib/marketing/suppressions";

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
    | "manual"
    /**
     * Operational alert to our own staff (new booking, connectivity test) —
     * never customer-facing, and deliberately outside MARKETING_KINDS: staff
     * are not customers and have no consent record to check.
     */
    | "staff_alert";
  to: string;
  /**
   * Extra addresses copied on the message. Email only — SMS has no CC, and
   * sendMessage strips it rather than silently addressing a second number.
   * Callers are expected to have run the list through parseCcList first.
   */
  cc?: string[];
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
  /**
   * Provider error text, returned to the caller only — never logged and never
   * written to the communications row. Exists so the owner-only integrations
   * screen can show why a test send failed instead of a bare "provider error".
   */
  detail?: string;
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
 * Why a marketing-class message must not go out, or null if it may.
 *
 * Two independent gates, both of which have to pass:
 *  - CONSENT, recorded on whichever party the message is addressed to. A lead
 *    counts: a fleet contact who handed over a card at their shop is a real
 *    consent basis (recorded on the lead), and they are deliberately not a
 *    customer until they buy something.
 *  - SUPPRESSION, keyed on the destination itself. This one outlives the record
 *    — converting a lead to a customer, or re-entering the same number as a new
 *    lead, must never resurrect a number that replied STOP.
 */
async function marketingDenial(msg: OutboundMessage): Promise<string | null> {
  if (!msg.customerId && !msg.leadId) {
    throw new Error(
      `Marketing-class message "${msg.kind}" requires a customer or lead with recorded consent`,
    );
  }

  const consented = msg.customerId
    ? (
        await db()
          .select({ marketingConsent: schema.customers.marketingConsent })
          .from(schema.customers)
          .where(eq(schema.customers.id, msg.customerId))
          .limit(1)
      )[0]?.marketingConsent
    : (
        await db()
          .select({ marketingConsent: schema.leads.marketingConsent })
          .from(schema.leads)
          .where(eq(schema.leads.id, msg.leadId!))
          .limit(1)
      )[0]?.marketingConsent;
  if (!consented) return "no marketing consent";

  if (msg.channel === "email" || msg.channel === "sms") {
    if (await isSuppressed(msg.channel as MarketingChannel, msg.to)) return "opted out";
  }
  return null;
}

/**
 * Sends (or in dev, logs) an outbound message and records it in the unified
 * communications history. Marketing-consent enforcement lives HERE so no
 * caller can accidentally bypass it. Operational messages (confirmations,
 * reminders, invoices…) are always allowed — booking an appointment is not
 * marketing consent.
 */
export async function sendMessage(msg: OutboundMessage): Promise<MessageResult> {
  if (MARKETING_KINDS.has(msg.kind)) {
    const denial = await marketingDenial(msg);
    if (denial) {
      const id = newId("com");
      await db().insert(schema.communications).values({
        id,
        customerId: msg.customerId,
        leadId: msg.leadId,
        channel: msg.channel,
        kind: msg.kind,
        subject: msg.subject,
        body: `[SUPPRESSED — ${denial}] ${msg.body.slice(0, 200)}`,
        relatedEntityType: msg.relatedEntityType,
        relatedEntityId: msg.relatedEntityId,
        status: "failed",
      });
      return { id, sent: false, reason: "suppressed" };
    }
  }

  // A CC is only meaningful on email, and it must never become a back door
  // around the consent gate above: marketing-class mail goes to the consenting
  // party alone, whatever the caller passed.
  const cc =
    msg.channel === "email" && !MARKETING_KINDS.has(msg.kind) ? (msg.cc ?? []) : [];

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
    cc,
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
      msg.channel === "email" ? await sendWithResend(msg, cc) : await sendWithTwilio(msg);
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
    return {
      id,
      sent: false,
      reason: "provider_error",
      detail: error instanceof Error ? error.message : String(error),
    };
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
    cc: input.cc,
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

async function sendWithResend(msg: OutboundMessage, cc: readonly string[]): Promise<string | null> {
  const [apiKey, from] = await Promise.all([
    getIntegrationSecret("resendApiKey"),
    getIntegrationSecret("emailFrom"),
  ]);
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
      ...(cc.length > 0 ? { cc: [...cc] } : {}),
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
  const [accountSid, authToken, from] = await Promise.all([
    getIntegrationSecret("twilioAccountSid"),
    getIntegrationSecret("twilioAuthToken"),
    getIntegrationSecret("twilioFromNumber"),
  ]);
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
  if (!response.ok) {
    // Twilio names the actual problem in the body (20003 = credentials
    // rejected, 21212 = bad From number); the bare status does not. It echoes
    // no secrets, and this text reaches only the owner-only integrations
    // screen through MessageResult.detail — never a log or a stored row.
    throw new Error(`Twilio returned ${response.status}${await twilioFailureReason(response)}`);
  }
  const payload = (await response.json()) as { sid?: string };
  if (!payload.sid) throw new Error("Twilio response had no message id");
  return payload.sid;
}

async function twilioFailureReason(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { code?: number; message?: string };
    if (!body.message) return "";
    return body.code ? ` — ${body.message} (code ${body.code})` : ` — ${body.message}`;
  } catch {
    return "";
  }
}

/** Simple {{placeholder}} template rendering. */
export function renderTemplate(body: string, vars: Record<string, string>): string {
  return body.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? "");
}
