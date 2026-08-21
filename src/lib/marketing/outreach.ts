import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { db, schema, type Db } from "@/db";
import { newId } from "@/lib/id";
import { sendMessage } from "@/lib/messaging";
import { getPublicSettings } from "@/lib/settings";
import { emailComplianceFooter } from "./compliance";
import { MAX_BATCH_SIZE, renderOutreachBody } from "./message";
import { normalizeDestination, type MarketingChannel } from "./suppressions";
import { unsubscribeUrl } from "./unsubscribe";

/**
 * Re-exported so server callers have one import for outreach. The definitions
 * live in ./message because the admin composer runs them in the browser too.
 */
export {
  OUTREACH_MERGE_FIELDS,
  SEND_WINDOW,
  renderOutreachBody,
  smsSegments,
  unknownMergeFields,
  withinSendWindow,
  type OutreachMergeValues,
} from "./message";

export { MAX_BATCH_SIZE };

export type OutreachRecipientRow = typeof schema.outreachRecipients.$inferSelect;

/* ------------------------------------------------------------------ */
/* Queueing                                                            */
/* ------------------------------------------------------------------ */

export type QueueCandidate = {
  leadId?: string;
  customerId?: string;
  destination: string;
  firstName: string;
  companyName: string;
};

/**
 * Adds people to a campaign. Returns how many were added and which were
 * dropped, because a silent drop is indistinguishable from a bug when the
 * owner counts thirty rows after pasting fifty.
 */
export async function queueRecipients(
  tx: Pick<Db, "insert">,
  campaign: { id: string; channel: MarketingChannel },
  candidates: readonly QueueCandidate[],
): Promise<{ queued: number; duplicates: number; invalid: number }> {
  let duplicates = 0;
  let invalid = 0;
  const seen = new Set<string>();
  const rows: (typeof schema.outreachRecipients.$inferInsert)[] = [];

  for (const candidate of candidates) {
    const normalized = normalizeDestination(campaign.channel, candidate.destination);
    if (!normalized) {
      invalid += 1;
      continue;
    }
    // Within one paste as well as against what is already on the campaign: the
    // unique index catches the second case, this catches the first.
    if (seen.has(normalized)) {
      duplicates += 1;
      continue;
    }
    seen.add(normalized);
    rows.push({
      id: newId("orc"),
      campaignId: campaign.id,
      leadId: candidate.leadId,
      customerId: candidate.customerId,
      destination: candidate.destination.trim(),
      destinationNormalized: normalized,
      firstName: candidate.firstName.trim(),
      companyName: candidate.companyName.trim(),
      status: "pending",
    });
  }

  if (rows.length === 0) return { queued: 0, duplicates, invalid };
  const inserted = await tx
    .insert(schema.outreachRecipients)
    .values(rows)
    .onConflictDoNothing({
      target: [schema.outreachRecipients.campaignId, schema.outreachRecipients.destinationNormalized],
    })
    .returning({ id: schema.outreachRecipients.id });
  return {
    queued: inserted.length,
    duplicates: duplicates + (rows.length - inserted.length),
    invalid,
  };
}

/* ------------------------------------------------------------------ */
/* Batching                                                            */
/* ------------------------------------------------------------------ */

/**
 * BATCHING. Sending is deliberately split into a short claiming transaction and
 * the provider calls that follow it, rather than one long transaction:
 *
 *  - Holding row locks across ~10 HTTP calls to Twilio would keep a database
 *    transaction open for seconds at a time against the production pool.
 *  - A transaction that rolls back AFTER the provider accepted a message would
 *    lose the record of a text that is already on its way to a real phone.
 *
 * `SKIP LOCKED` plus the status flip means two staff pressing "send next 10"
 * simultaneously claim disjoint rows instead of double-texting ten people.
 */
async function claimBatch(campaignId: string, limit: number): Promise<OutreachRecipientRow[]> {
  return db().transaction(async (tx) => {
    const claimable = await tx
      .select({ id: schema.outreachRecipients.id })
      .from(schema.outreachRecipients)
      .where(
        and(
          eq(schema.outreachRecipients.campaignId, campaignId),
          eq(schema.outreachRecipients.status, "pending"),
        ),
      )
      .orderBy(schema.outreachRecipients.createdAt)
      .limit(limit)
      .for("update", { skipLocked: true });
    if (claimable.length === 0) return [];
    const ids = claimable.map((r) => r.id);
    return tx
      .update(schema.outreachRecipients)
      .set({ status: "claimed", claimedAt: new Date(), updatedAt: new Date() })
      .where(inArray(schema.outreachRecipients.id, ids))
      .returning();
  });
}

/**
 * Destinations from this batch that a DIFFERENT campaign has already messaged.
 * The per-campaign unique index cannot see across campaigns, and "don't text
 * the same person twice" has to hold across the whole account, not one list.
 */
async function alreadyContacted(
  campaignId: string,
  destinations: readonly string[],
): Promise<Set<string>> {
  if (destinations.length === 0) return new Set();
  const rows = await db()
    .select({ destination: schema.outreachRecipients.destinationNormalized })
    .from(schema.outreachRecipients)
    .where(
      and(
        ne(schema.outreachRecipients.campaignId, campaignId),
        eq(schema.outreachRecipients.status, "sent"),
        inArray(schema.outreachRecipients.destinationNormalized, [...new Set(destinations)]),
      ),
    );
  return new Set(rows.map((r) => r.destination));
}

export type BatchOutcome = {
  attempted: number;
  sent: number;
  failed: number;
  skipped: number;
  /** Per-row detail for the results panel, newest batch first in the UI. */
  results: { recipientId: string; destination: string; status: string; reason?: string }[];
};

/**
 * Sends up to `limit` pending recipients. Every row it claims reaches a
 * terminal status before this returns, including on a provider error — a row
 * left in `claimed` means the process died mid-batch and wants a human, so it
 * is never picked up again automatically.
 */
export async function sendOutreachBatch(
  campaign: typeof schema.outreachCampaigns.$inferSelect,
  limit: number,
): Promise<BatchOutcome> {
  const size = Math.max(1, Math.min(limit, MAX_BATCH_SIZE));
  const claimed = await claimBatch(campaign.id, size);
  const outcome: BatchOutcome = { attempted: claimed.length, sent: 0, failed: 0, skipped: 0, results: [] };
  if (claimed.length === 0) return outcome;

  const contactedElsewhere = campaign.allowRecontact
    ? new Set<string>()
    : await alreadyContacted(campaign.id, claimed.map((r) => r.destinationNormalized));
  // Sender identity and the unsubscribe link are appended per recipient, never
  // typed into the campaign body — see compliance.ts for why.
  const settings = campaign.channel === "email" ? await getPublicSettings() : null;

  for (const recipient of claimed) {
    const merged = renderOutreachBody(campaign.body, {
      firstName: recipient.firstName,
      companyName: recipient.companyName,
    });
    const body = settings
      ? merged + "\n" + emailComplianceFooter(settings, unsubscribeUrl(recipient.id))
      : merged;

    if (contactedElsewhere.has(recipient.destinationNormalized)) {
      await finalize(recipient.id, {
        status: "skipped",
        skipReason: "Already messaged in an earlier campaign",
        renderedBody: body,
      });
      outcome.skipped += 1;
      outcome.results.push({
        recipientId: recipient.id,
        destination: recipient.destination,
        status: "skipped",
        reason: "Already messaged in an earlier campaign",
      });
      continue;
    }

    // Consent and opt-out are NOT re-checked here on purpose: sendMessage owns
    // both gates, so an outreach batch cannot drift from what the automations
    // enforce (DECISIONS.md #8).
    const result = await sendMessage({
      customerId: recipient.customerId ?? undefined,
      leadId: recipient.leadId ?? undefined,
      channel: campaign.channel === "email" ? "email" : "sms",
      kind: "marketing",
      to: recipient.destination,
      subject: campaign.channel === "email" ? (campaign.subject ?? undefined) : undefined,
      body,
      relatedEntityType: "outreach_campaign",
      relatedEntityId: campaign.id,
    });

    if (result.sent) {
      await finalize(recipient.id, {
        status: "sent",
        sentAt: new Date(),
        communicationId: result.id,
        renderedBody: body,
      });
      outcome.sent += 1;
      outcome.results.push({ recipientId: recipient.id, destination: recipient.destination, status: "sent" });
      continue;
    }

    const reason = describeFailure(result.reason);
    // A suppressed row is a correct outcome, not an error to retry.
    const status = result.reason === "suppressed" ? "skipped" : "failed";
    await finalize(recipient.id, {
      status,
      skipReason: reason,
      communicationId: result.id,
      renderedBody: body,
    });
    if (status === "skipped") outcome.skipped += 1;
    else outcome.failed += 1;
    outcome.results.push({
      recipientId: recipient.id,
      destination: recipient.destination,
      status,
      reason,
    });
  }

  return outcome;
}

function describeFailure(reason: string | undefined): string {
  switch (reason) {
    case "suppressed":
      return "Opted out or consent not recorded";
    case "not_configured":
      return "Provider credentials are not configured";
    case "provider_error":
      return "The provider rejected the message";
    default:
      return "Not sent";
  }
}

async function finalize(
  recipientId: string,
  patch: Partial<typeof schema.outreachRecipients.$inferInsert>,
): Promise<void> {
  await db()
    .update(schema.outreachRecipients)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(schema.outreachRecipients.id, recipientId));
}

/** Counts per status for one campaign, for the progress bar and the send gate. */
export async function campaignProgress(campaignId: string): Promise<Record<string, number>> {
  const rows = await db()
    .select({ status: schema.outreachRecipients.status, count: sql<number>`count(*)::int` })
    .from(schema.outreachRecipients)
    .where(eq(schema.outreachRecipients.campaignId, campaignId))
    .groupBy(schema.outreachRecipients.status);
  return Object.fromEntries(rows.map((r) => [r.status, r.count]));
}
