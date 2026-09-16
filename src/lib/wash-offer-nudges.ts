import "server-only";

import { and, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { getIntegrationSecret } from "@/lib/integrations";
import { emailComplianceFooter } from "@/lib/marketing/compliance";
import { findSuppressed, normalizeDestination } from "@/lib/marketing/suppressions";
import { sendMessage, type MessageResult } from "@/lib/messaging";
import type { BusinessSettings } from "@/lib/settings";
import type { ResolvedWashOffer } from "@/lib/wash-offer";
import { claimMessageVariables, type OfferClaim } from "@/lib/wash-offer-claims";
import {
  daysLeftLabel,
  NUDGE_COOLDOWN_MS,
  renderNudge,
  type NudgeChannel,
  type NudgeValues,
} from "@/lib/wash-offer-nudge-message";

/**
 * Nudges staff send by hand to people holding an unbooked wash code.
 *
 * Deliberately NOT a marketing campaign. A campaign is a list somebody pasted,
 * queued and worked through in batches; this is a live view over the claims
 * table, where the list is "whoever has a code and has not used it" and
 * changes by the hour. What it shares with campaigns is everything that keeps
 * the shop out of trouble:
 *
 *  - Sent as `marketing`, so sendMessage's consent gate and the do-not-contact
 *    list apply exactly as they do to a campaign. Everyone who claimed on the
 *    live form accepted electronic messages as part of the offer terms, and
 *    anyone who has since replied STOP is skipped, not texted.
 *  - The email footer (address + unsubscribe) is appended here, not left to
 *    the editable body.
 *  - At most one nudge per person per channel per day, enforced by a
 *    conditional UPDATE before the provider is called — the same
 *    claim-then-send shape the campaign batches use, so two staff pressing
 *    send together cannot text somebody twice.
 *
 * Only a live, unbooked code can be nudged. A booked claim already gets the
 * appointment reminder, and the short link in a nudge only works for a code
 * that can still be booked.
 */

export type NudgeOutcome = {
  claimId: string;
  name: string;
  status: "sent" | "skipped" | "failed";
  reason?: string;
};

type ClaimWithLead = {
  claim: OfferClaim;
  leadConsent: boolean | null;
  leadAnonymizedAt: Date | null;
};

/** The values a nudge is written from, for one claim. */
export function nudgeValuesFor(input: {
  claim: OfferClaim;
  offer: ResolvedWashOffer;
  settings: BusinessSettings;
  baseUrl: string;
  nowMs?: number;
}): NudgeValues {
  const vars = claimMessageVariables(input);
  return {
    firstName: vars.firstName,
    code: vars.code,
    price: vars.price,
    expires: vars.expires,
    daysLeft: daysLeftLabel(input.claim.expiresAt, input.nowMs),
    link: vars.link,
    phone: vars.phone,
    businessName: vars.businessName,
  };
}

/**
 * Stand-in values for a preview or a test send. Real shop details and the real
 * offer price, so the length and the wording are what a customer would see;
 * an obviously fake name and code, so nobody mistakes the test for a real one.
 */
export function sampleNudgeValues(input: {
  offer: ResolvedWashOffer;
  settings: BusinessSettings;
  baseUrl: string;
  nowMs?: number;
}): NudgeValues {
  const nowMs = input.nowMs ?? Date.now();
  const expiresAt = new Date(nowMs + input.offer.claimValidDays * 86_400_000);
  const sample = claimMessageVariables({
    claim: {
      firstName: "Sample",
      code: "PTWSAMPLE",
      vehicleSize: "car",
      expiresAt,
      leadId: null,
    } as OfferClaim,
    offer: input.offer,
    settings: input.settings,
    baseUrl: input.baseUrl,
  });
  return {
    firstName: sample.firstName,
    code: sample.code,
    price: sample.price,
    expires: sample.expires,
    daysLeft: daysLeftLabel(expiresAt, nowMs),
    link: sample.link,
    phone: sample.phone,
    businessName: sample.businessName,
  };
}

/**
 * Why this claim cannot be nudged on this channel right now, or null.
 * Shared by the screen (to grey the row out) and the sender (to refuse it).
 */
export function nudgeBlockReason(input: {
  claim: OfferClaim;
  channel: NudgeChannel;
  offerCode: string;
  leadConsent: boolean | null;
  leadAnonymizedAt: Date | null;
  suppressed: boolean;
  nowMs: number;
}): string | null {
  const { claim, channel, nowMs } = input;
  if (claim.offerCode !== input.offerCode) return "Belongs to an earlier offer";
  if (claim.status === "booked") return "Already booked";
  if (claim.status === "redeemed") return "Already washed";
  if (claim.status === "void") return "Released";
  if (claim.status === "expired" || claim.expiresAt.getTime() <= nowMs) return "Code has expired";
  if (claim.status !== "issued") return "Not an open code";
  if (!claim.leadId || input.leadAnonymizedAt) return "No contact record";
  if (channel === "sms" && !normalizeDestination("sms", claim.phone)) return "No mobile number";
  if (channel === "email" && !normalizeDestination("email", claim.email)) return "No email address";
  if (!input.leadConsent) return "No message consent on file";
  if (input.suppressed) return channel === "sms" ? "Replied STOP" : "Unsubscribed";
  const last = channel === "sms" ? claim.lastSmsNudgeAt : claim.lastEmailNudgeAt;
  if (last && nowMs - last.getTime() < NUDGE_COOLDOWN_MS) {
    return channel === "sms" ? "Texted in the last 20 hours" : "Emailed in the last 20 hours";
  }
  return null;
}

export async function sendClaimNudges(input: {
  claimIds: readonly string[];
  channel: NudgeChannel;
  subject?: string;
  body: string;
  staffId: string;
  settings: BusinessSettings;
  offer: ResolvedWashOffer;
  baseUrl: string;
  nowMs?: number;
}): Promise<NudgeOutcome[]> {
  const nowMs = input.nowMs ?? Date.now();
  const ids = [...new Set(input.claimIds)];
  if (ids.length === 0) return [];

  const rows: ClaimWithLead[] = await db()
    .select({
      claim: schema.offerClaims,
      leadConsent: schema.leads.marketingConsent,
      leadAnonymizedAt: schema.leads.anonymizedAt,
    })
    .from(schema.offerClaims)
    .leftJoin(schema.leads, eq(schema.leads.id, schema.offerClaims.leadId))
    .where(inArray(schema.offerClaims.id, ids));
  const byId = new Map(rows.map((row) => [row.claim.id, row]));

  const destinations = rows
    .map((row) => normalizeDestination(input.channel, input.channel === "sms" ? row.claim.phone : row.claim.email))
    .filter((d): d is string => Boolean(d));
  const suppressed = await findSuppressed(db(), input.channel, destinations);

  const outcomes: NudgeOutcome[] = [];
  for (const id of ids) {
    const row = byId.get(id);
    if (!row) {
      outcomes.push({ claimId: id, name: "Unknown", status: "skipped", reason: "No longer exists" });
      continue;
    }
    outcomes.push(await nudgeOne(row, suppressed, input, nowMs));
  }
  return outcomes;
}

async function nudgeOne(
  row: ClaimWithLead,
  suppressed: Set<string>,
  input: Parameters<typeof sendClaimNudges>[0],
  nowMs: number,
): Promise<NudgeOutcome> {
  const { claim } = row;
  const { channel } = input;
  const name = [claim.firstName, claim.lastName].filter(Boolean).join(" ").trim() || "Customer";
  const rawDestination = channel === "sms" ? claim.phone : claim.email;
  const destination = normalizeDestination(channel, rawDestination);

  const blocked = nudgeBlockReason({
    claim,
    channel,
    offerCode: input.offer.code,
    leadConsent: row.leadConsent,
    leadAnonymizedAt: row.leadAnonymizedAt,
    suppressed: destination ? suppressed.has(destination) : false,
    nowMs,
  });
  if (blocked || !rawDestination || !claim.leadId) {
    return { claimId: claim.id, name, status: "skipped", reason: blocked ?? "No contact record" };
  }

  // Claim the send. Conditional on the row still being an open code that has
  // not been nudged on this channel inside the cooldown — the SELECT above can
  // be stale by the time we get here, this cannot.
  const now = new Date(nowMs);
  const cutoff = new Date(nowMs - NUDGE_COOLDOWN_MS);
  const stampColumn = channel === "sms" ? schema.offerClaims.lastSmsNudgeAt : schema.offerClaims.lastEmailNudgeAt;
  const previous = channel === "sms" ? claim.lastSmsNudgeAt : claim.lastEmailNudgeAt;
  const claimed = await db()
    .update(schema.offerClaims)
    .set(channel === "sms" ? { lastSmsNudgeAt: now } : { lastEmailNudgeAt: now })
    .where(
      and(
        eq(schema.offerClaims.id, claim.id),
        eq(schema.offerClaims.status, "issued"),
        or(isNull(stampColumn), lte(stampColumn, cutoff)),
      ),
    )
    .returning({ id: schema.offerClaims.id });
  if (claimed.length === 0) {
    return { claimId: claim.id, name, status: "skipped", reason: "Just nudged by someone else" };
  }

  const values = nudgeValuesFor({ claim, offer: input.offer, settings: input.settings, baseUrl: input.baseUrl, nowMs });
  const unsubscribe = claimMessageVariables({
    claim,
    offer: input.offer,
    settings: input.settings,
    baseUrl: input.baseUrl,
  }).unsubscribe;
  const body =
    channel === "email"
      ? `${renderNudge(input.body, values)}\n${emailComplianceFooter(input.settings, unsubscribe)}`
      : renderNudge(input.body, values);

  let result: MessageResult | null = null;
  try {
    result = await sendMessage({
      leadId: claim.leadId,
      channel,
      kind: "marketing",
      to: rawDestination,
      subject: channel === "email" ? renderNudge(input.subject ?? "", values) : undefined,
      body,
      relatedEntityType: "offer_claim",
      relatedEntityId: claim.id,
    });
  } catch {
    console.error(`[wash-nudge:${channel}] send failed for ${claim.id}`);
  }

  if (result) {
    // sendMessage does not know who pressed the button; the history should.
    await db()
      .update(schema.communications)
      .set({ createdByStaffId: input.staffId })
      .where(eq(schema.communications.id, result.id));
  }

  if (result?.sent) {
    await db()
      .update(schema.offerClaims)
      .set(
        channel === "sms"
          ? { smsNudgesSent: sql`${schema.offerClaims.smsNudgesSent} + 1`, updatedAt: now }
          : { emailNudgesSent: sql`${schema.offerClaims.emailNudgesSent} + 1`, updatedAt: now },
      )
      .where(eq(schema.offerClaims.id, claim.id));
    return { claimId: claim.id, name, status: "sent" };
  }

  // Nothing went out, so give the day back: the person can be tried again as
  // soon as whatever stopped it is fixed. Only our own stamp is undone.
  await db()
    .update(schema.offerClaims)
    .set(channel === "sms" ? { lastSmsNudgeAt: previous } : { lastEmailNudgeAt: previous })
    .where(and(eq(schema.offerClaims.id, claim.id), eq(stampColumn, now)));

  const reason =
    result?.reason === "suppressed"
      ? "Opted out, or no message consent on file"
      : result?.reason === "not_configured"
        ? channel === "sms"
          ? "Twilio is not set up"
          : "Email sending is not set up"
        : "The provider refused it";
  return { claimId: claim.id, name, status: result?.reason === "suppressed" ? "skipped" : "failed", reason };
}

/** True when the provider for this channel has credentials to send with. */
export async function nudgeProviderReady(channel: NudgeChannel): Promise<boolean> {
  if (channel === "sms") {
    const [sid, token, from] = await Promise.all([
      getIntegrationSecret("twilioAccountSid"),
      getIntegrationSecret("twilioAuthToken"),
      getIntegrationSecret("twilioFromNumber"),
    ]);
    return Boolean(sid && token && from);
  }
  const [apiKey, from] = await Promise.all([
    getIntegrationSecret("resendApiKey"),
    getIntegrationSecret("emailFrom"),
  ]);
  return Boolean(apiKey && from);
}
