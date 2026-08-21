import "server-only";

import { createHmac, timingSafeEqual } from "crypto";
import { desc, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { newId } from "@/lib/id";
import { normalizePhone } from "@/lib/phone";
import { addSuppression, removeSuppression } from "./suppressions";

/**
 * Keywords Twilio itself acts on. We mirror the same set so our records agree
 * with what the carrier has already done — Twilio blocks the number on its
 * side the moment it sees one of these, whether or not this endpoint is
 * reachable, and a send to a stopped number then fails with error 21610.
 */
const STOP_KEYWORDS = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"]);
const START_KEYWORDS = new Set(["START", "UNSTOP"]);

/**
 * Phrases that are a person asking to be left alone WITHOUT using an exact
 * keyword. Neither Twilio nor this module may act on these automatically —
 * "stop by the shop on Tuesday" is not an opt-out — but a human must see them,
 * so they are flagged for the replies list.
 */
const OPT_OUT_PHRASES = ["stop", "unsubscribe", "remove me", "opt out", "take me off", "don't text", "do not text"];

/** Exact-keyword match after stripping surrounding punctuation and case. */
export function classifyInboundKeyword(body: string): "stop" | "start" | null {
  const word = body.trim().replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "").toUpperCase();
  if (STOP_KEYWORDS.has(word)) return "stop";
  if (START_KEYWORDS.has(word)) return "start";
  return null;
}

/** True when a reply reads like an opt-out request a person should handle. */
export function looksLikeOptOutRequest(body: string): boolean {
  const text = body.toLowerCase();
  return OPT_OUT_PHRASES.some((phrase) => text.includes(phrase));
}

/**
 * Twilio's request signature: base64 HMAC-SHA1, over the exact URL Twilio was
 * configured with followed by every POST parameter sorted by name and
 * concatenated as key+value.
 *
 * This is the ONLY thing standing between the public internet and a route that
 * writes opt-outs and consent flags. Without it, anyone who guesses the URL can
 * post a STOP for any number, or forge replies into a customer's history.
 */
export function verifyTwilioSignature(input: {
  url: string;
  params: Record<string, string>;
  signature: string | null;
  authToken: string;
}): boolean {
  if (!input.signature) return false;
  const payload = Object.keys(input.params)
    .sort()
    .reduce((acc, key) => acc + key + input.params[key], input.url);
  const expected = createHmac("sha1", input.authToken).update(Buffer.from(payload, "utf8")).digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(input.signature, "base64");
  } catch {
    return false;
  }
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

export type InboundSmsOutcome = {
  /** False when this MessageSid was already processed — Twilio retries. */
  processed: boolean;
  action: "stop" | "start" | "reply";
  matchedLeadId: string | null;
  matchedCustomerId: string | null;
  needsAttention: boolean;
};

/**
 * Records one inbound SMS and applies any opt-out it carries.
 *
 * Deduplicated through `webhook_events` on Twilio's MessageSid, the same way
 * Stripe deliveries are: Twilio retries on any non-2xx response, and a retry
 * must not append a second copy of the reply to the customer's history.
 */
export async function recordInboundSms(input: {
  messageSid: string;
  from: string;
  to: string;
  body: string;
  payload: Record<string, string>;
}): Promise<InboundSmsOutcome> {
  const keyword = classifyInboundKeyword(input.body);
  const action = keyword ?? "reply";
  const normalized = normalizePhone(input.from);

  // Match by normalized phone. A number can belong to both a lead and the
  // customer it converted into; recording both keeps the reply visible from
  // either record rather than picking one and hiding it from the other.
  const [lead] = normalized
    ? await db()
        .select({ id: schema.leads.id })
        .from(schema.leads)
        .where(eq(schema.leads.phoneNormalized, normalized))
        .orderBy(desc(schema.leads.createdAt))
        .limit(1)
    : [];
  const [customer] = normalized
    ? await db()
        .select({ id: schema.customers.id })
        .from(schema.customers)
        .where(eq(schema.customers.phoneNormalized, normalized))
        .orderBy(desc(schema.customers.createdAt))
        .limit(1)
    : [];

  const outcome: InboundSmsOutcome = {
    processed: false,
    action,
    matchedLeadId: lead?.id ?? null,
    matchedCustomerId: customer?.id ?? null,
    needsAttention: action === "reply" && looksLikeOptOutRequest(input.body),
  };

  await db().transaction(async (tx) => {
    await tx
      .insert(schema.webhookEvents)
      .values({
        id: newId("whe"),
        provider: "twilio",
        eventId: input.messageSid,
        eventType: `inbound_sms.${action}`,
        payload: input.payload,
      })
      .onConflictDoNothing({ target: schema.webhookEvents.eventId });

    const [event] = await tx
      .select()
      .from(schema.webhookEvents)
      .where(eq(schema.webhookEvents.eventId, input.messageSid))
      .for("update");
    if (!event) throw new Error("Inbound message could not be recorded");
    if (event.processedAt) return;

    await tx.insert(schema.communications).values({
      id: newId("com"),
      customerId: outcome.matchedCustomerId,
      leadId: outcome.matchedLeadId,
      direction: "inbound",
      channel: "sms",
      kind: action === "reply" ? "reply" : `opt_${action}`,
      body: input.body,
      status: "received",
      providerRef: input.messageSid,
    });

    if (action === "stop") {
      await addSuppression(tx, {
        channel: "sms",
        destination: input.from,
        reason: "stop_reply",
        source: "Twilio inbound SMS",
        note: input.body.slice(0, 200),
      });
      // The suppression list is what binds future sends, but clearing the
      // consent flag too keeps the contact's own record honest — staff looking
      // at the lead should not see "consented" next to someone who said stop.
      if (outcome.matchedLeadId) {
        await tx
          .update(schema.leads)
          .set({ marketingConsent: false, updatedAt: new Date() })
          .where(eq(schema.leads.id, outcome.matchedLeadId));
      }
      if (outcome.matchedCustomerId) {
        await tx
          .update(schema.customers)
          .set({ marketingConsent: false, updatedAt: new Date() })
          .where(eq(schema.customers.id, outcome.matchedCustomerId));
      }
    }

    if (action === "start") {
      // Lifts the block only. Consent is NOT restored automatically: START says
      // "you may text me again", not "I consent to marketing", and the flag has
      // to be re-recorded by a person with a basis for it.
      await removeSuppression(tx, "sms", input.from);
    }

    await tx
      .update(schema.webhookEvents)
      .set({ processedAt: new Date() })
      .where(eq(schema.webhookEvents.id, event.id));
    outcome.processed = true;
  });

  return outcome;
}
