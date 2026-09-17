import "server-only";

import { asc, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { audit } from "@/lib/audit";
import { newId } from "@/lib/id";
import { formatInZone } from "@/lib/tz";
import type { BusinessSettings } from "@/lib/settings";
import {
  describeFooting,
  findMissedAppointments,
  type AudienceFilter,
} from "./audience";
import { campaignProgress, queueRecipients, sendOutreachBatch } from "./outreach";
import type { MarketingChannel } from "./suppressions";
import { winbackCampaignName } from "./winback-message";

/**
 * Win-back outreach: staff pick the people whose booking was cancelled or who
 * never turned up, write one message, and send it — on one screen, the way
 * first-wash nudges already work.
 *
 * The old route to the same place was a four-step build: create a campaign,
 * pick an audience, queue it, then work through it in batches. Everything past
 * the first step was bookkeeping the owner had to do by hand for a send that
 * is always "these twelve people, this message, now".
 *
 * WHAT THIS IS NOT is a second sending path. Underneath, one press of send is
 * still exactly one campaign: the rows go through `queueRecipients` and
 * `sendOutreachBatch` unchanged, so every guarantee those carry comes with
 * them —
 *
 *  - the per-campaign unique index on the destination, so the same number
 *    typed twice is one message;
 *  - the cross-campaign "already messaged" check, so a second send cannot
 *    quietly re-text everyone from the first;
 *  - `sendMessage`'s consent gate and do-not-contact list (DECISIONS.md #8);
 *  - the CASL footer and a working unsubscribe link, appended per recipient
 *    rather than typed into the body;
 *  - a recipient row recording what each person was actually sent.
 *
 * The campaign it creates is named after the send and shows up in the history
 * list, so "what went out on Tuesday" is still answerable.
 */

export type WinbackOutcome = {
  appointmentId: string;
  name: string;
  status: "sent" | "skipped" | "failed";
  reason?: string;
};

const AUDIENCE_LABELS: Record<AudienceFilter, string> = {
  no_show: "No-show win-back",
  cancelled: "Cancellation win-back",
  missed: "Win-back",
};

export async function sendWinbackMessages(input: {
  appointmentIds: readonly string[];
  filter: AudienceFilter;
  withinDays: number;
  channel: MarketingChannel;
  subject: string;
  body: string;
  /** Deliberate follow-up to people an earlier send already reached. */
  allowRecontact: boolean;
  staffId: string;
  settings: BusinessSettings;
}): Promise<{ campaignId: string | null; outcomes: WinbackOutcome[] }> {
  const wanted = new Set(input.appointmentIds);

  // The ids arrive from a list the browser rendered some minutes ago. An
  // appointment that has since been rebooked, or a customer who has since
  // opted out, must not be messaged because a stale checkbox said so.
  const { candidates } = await findMissedAppointments({
    filter: input.filter,
    channel: input.channel,
    withinDays: input.withinDays,
    timezone: input.settings.timezone,
    limit: 1000,
  });
  const selected = candidates.filter((c) => wanted.has(c.appointmentId));

  const outcomes: WinbackOutcome[] = [];
  const nameOf = (c: (typeof candidates)[number]) =>
    [c.firstName, c.companyName].filter(Boolean).join(" · ") || "Customer";

  for (const appointmentId of wanted) {
    if (!selected.some((c) => c.appointmentId === appointmentId)) {
      outcomes.push({
        appointmentId,
        name: "Customer",
        status: "skipped",
        reason: "No longer on the list — reload before sending again",
      });
    }
  }

  const queueable = selected.filter((candidate) => {
    if (!candidate.blockedReason) return true;
    outcomes.push({
      appointmentId: candidate.appointmentId,
      name: nameOf(candidate),
      status: "skipped",
      reason: candidate.blockedReason,
    });
    return false;
  });
  if (queueable.length === 0) return { campaignId: null, outcomes };

  const now = new Date();
  const campaignId = newId("ocm");
  const campaignName = winbackCampaignName({
    channel: input.channel,
    audienceLabel: AUDIENCE_LABELS[input.filter],
    atLabel: formatInZone(now, input.settings.timezone, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }),
  });

  await db().transaction(async (tx) => {
    await tx.insert(schema.outreachCampaigns).values({
      id: campaignId,
      name: campaignName,
      channel: input.channel,
      subject: input.channel === "email" ? input.subject : null,
      body: input.body,
      audience: input.filter,
      status: "sending",
      allowRecontact: input.allowRecontact,
      createdByStaffId: input.staffId,
    });

    for (const candidate of queueable) {
      // CONSENT IS RECORDED, NOT ASSUMED. `sendMessage` refuses a marketing
      // message to anyone without `marketing_consent`, so sending these rows
      // without writing down a basis would produce a send where every row comes
      // back "skipped" — technically safe, completely useless. The basis is the
      // one the audience builder computed from the shop's own records.
      //
      // Express consent already on file is left exactly as it is: overwriting
      // it with a weaker implied basis would lose the stronger record.
      if (candidate.footing !== "express") {
        await tx
          .update(schema.customers)
          .set({
            marketingConsent: true,
            marketingConsentAt: now,
            marketingConsentSource: `winback:${candidate.footing}`,
            updatedAt: now,
          })
          .where(eq(schema.customers.id, candidate.customerId));
      }
    }

    await queueRecipients(
      tx,
      { id: campaignId, channel: input.channel },
      queueable.map((candidate) => ({
        customerId: candidate.customerId,
        destination: candidate.destination,
        firstName: candidate.firstName,
        companyName: candidate.companyName,
        appointmentId: candidate.appointmentId,
        contextNote: [
          candidate.outcome === "no_show" ? "No-show" : "Cancelled",
          candidate.missedOnLabel,
          candidate.reason ? `— ${candidate.reason}` : "— no reason recorded",
        ].join(" "),
        lastVisitLabel: candidate.missedOnLabel,
      })),
    );

    await audit(tx, {
      actorType: "staff",
      actorId: input.staffId,
      action: "outreach_campaign.created",
      entityType: "outreach_campaign",
      entityId: campaignId,
      after: {
        name: campaignName,
        channel: input.channel,
        source: "winback",
        filter: input.filter,
        withinDays: input.withinDays,
        selected: queueable.length,
        bases: [...new Set(queueable.map((c) => describeFooting(c.footing)))],
      },
    });
  });

  const recipients = await db()
    .select({
      id: schema.outreachRecipients.id,
      appointmentId: schema.outreachRecipients.appointmentId,
      firstName: schema.outreachRecipients.firstName,
      companyName: schema.outreachRecipients.companyName,
    })
    .from(schema.outreachRecipients)
    .where(eq(schema.outreachRecipients.campaignId, campaignId))
    .orderBy(asc(schema.outreachRecipients.createdAt));

  // Two missed appointments for the same person are one message — the unique
  // index on the destination collapsed them at queue time. Say so rather than
  // leaving a ticked row with no outcome beside it.
  const queuedAppointments = new Set(recipients.map((r) => r.appointmentId));
  for (const candidate of queueable) {
    if (!queuedAppointments.has(candidate.appointmentId)) {
      outcomes.push({
        appointmentId: candidate.appointmentId,
        name: nameOf(candidate),
        status: "skipped",
        reason: "Same person as another booking on this send",
      });
    }
  }

  const [campaign] = await db()
    .select()
    .from(schema.outreachCampaigns)
    .where(eq(schema.outreachCampaigns.id, campaignId))
    .limit(1);
  const batch = await sendOutreachBatch(campaign, recipients.length);

  const byRecipient = new Map(recipients.map((r) => [r.id, r]));
  for (const result of batch.results) {
    const recipient = byRecipient.get(result.recipientId);
    if (!recipient?.appointmentId) continue;
    outcomes.push({
      appointmentId: recipient.appointmentId,
      name: [recipient.firstName, recipient.companyName].filter(Boolean).join(" · ") || "Customer",
      status: result.status === "sent" ? "sent" : result.status === "skipped" ? "skipped" : "failed",
      reason: result.reason,
    });
  }

  const progress = await campaignProgress(campaignId);
  if ((progress.pending ?? 0) === 0 && (progress.claimed ?? 0) === 0) {
    await db()
      .update(schema.outreachCampaigns)
      .set({ status: "completed", updatedAt: new Date() })
      .where(eq(schema.outreachCampaigns.id, campaignId));
  }

  await db().transaction((tx) =>
    audit(tx, {
      actorType: "staff",
      actorId: input.staffId,
      action: "outreach_campaign.batch_sent",
      entityType: "outreach_campaign",
      entityId: campaignId,
      after: { attempted: batch.attempted, sent: batch.sent, failed: batch.failed, skipped: batch.skipped },
    }),
  );

  return { campaignId, outcomes };
}

/** True when the provider for this channel has credentials to send with. */
export async function outreachProviderReady(channel: MarketingChannel): Promise<boolean> {
  const { getIntegrationSecret } = await import("@/lib/integrations");
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
