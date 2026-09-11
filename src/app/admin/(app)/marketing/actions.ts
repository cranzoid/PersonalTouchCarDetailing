"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { audit } from "@/lib/audit";
import { AuthError, requireStaff } from "@/lib/auth/session";
import { newId } from "@/lib/id";
import {
  describeFooting,
  findMissedAppointments,
  type AudienceFilter,
} from "@/lib/marketing/audience";
import { checkCampaignCompliance } from "@/lib/marketing/compliance";
import { checkCampaignHtml, htmlToPlainText } from "@/lib/marketing/html-email";
import { parseContactPaste } from "@/lib/marketing/import";
import {
  MAX_BATCH_SIZE,
  campaignProgress,
  queueRecipients,
  renderOutreachBody,
  sendOutreachBatch,
  unknownMergeFields,
  withinSendWindow,
  type BatchOutcome,
} from "@/lib/marketing/outreach";
import {
  addSuppression,
  normalizeDestination,
  removeSuppression,
  type MarketingChannel,
} from "@/lib/marketing/suppressions";
import { sendMessage } from "@/lib/messaging";
import { normalizePhone } from "@/lib/phone";
import { getSettings } from "@/lib/settings";

export type ActionResult<T extends object = Record<never, never>> =
  | ({ ok: true } & T)
  | { ok: false; error: string };

const channel = z.enum(["email", "sms"]);

/**
 * `body` is no longer required on its own: an email campaign may be a pasted
 * HTML template with the plain-text part derived from it. One of the two has to
 * carry the message, which `hasMessage` enforces below.
 */
const createCampaignInput = z
  .object({
    name: z.string().trim().min(1).max(120),
    channel,
    subject: z.string().trim().max(200).optional(),
    body: z.string().trim().max(4000).default(""),
    /** Email only. Larger cap than `body` — a real template is mostly markup. */
    bodyHtml: z.string().trim().max(200_000).optional(),
  })
  .refine((v) => v.body.length > 0 || (v.channel === "email" && (v.bodyHtml ?? "").length > 0), {
    message: "Write a message or paste an HTML template.",
  });

const updateCampaignInput = createCampaignInput.innerType().extend({
  campaignId: z.string().min(1),
  allowRecontact: z.boolean(),
});

/**
 * Consent bases we are willing to record, in the owner's words. Each maps to a
 * real CASL footing:
 *  - `business_card`: they handed over their details in a business context and
 *    did not say "no unsolicited messages" (implied consent, s.10(9)(b)).
 *  - `verbal`: they said yes when asked (express consent, recorded by staff).
 *  - `existing_customer`: an existing business relationship.
 * There is deliberately no "found it online" option — a scraped address is not
 * a consent basis and this screen will not pretend otherwise.
 */
const CONSENT_BASES = {
  business_card: "Gave us their card or details in person",
  verbal: "Said yes when we asked in person",
  existing_customer: "Existing customer of the shop",
} as const;

const importContactsInput = z.object({
  campaignId: z.string().min(1),
  paste: z.string().min(1).max(200_000),
  consentBasis: z.enum(["business_card", "verbal", "existing_customer"]),
  /** Business-local YYYY-MM-DD the contact was actually met. */
  metOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

const sendBatchInput = z.object({
  campaignId: z.string().min(1),
  size: z.number().int().min(1).max(MAX_BATCH_SIZE),
  /** Set only after the composer showed the warnings and a person accepted them. */
  acknowledgeWarnings: z.boolean().default(false),
});

const sendTestInput = z.object({
  campaignId: z.string().min(1),
  destination: z.string().trim().min(3).max(200),
});

const suppressionInput = z.object({
  channel,
  destination: z.string().trim().min(3).max(200),
  note: z.string().trim().max(500).optional(),
});

async function loadCampaign(campaignId: string) {
  const [campaign] = await db()
    .select()
    .from(schema.outreachCampaigns)
    .where(eq(schema.outreachCampaigns.id, campaignId))
    .limit(1);
  return campaign ?? null;
}

/**
 * Compliance + merge-field checks shared by save, test send and batch send.
 *
 * For an HTML campaign the CASL body rules run against the READABLE TEXT of the
 * template, not its markup: "does this name the sender" has to look at what the
 * recipient sees, and a business name sitting in a CSS class would otherwise
 * pass a check it should fail.
 */
async function validateCampaignContent(input: {
  channel: MarketingChannel;
  subject: string | null;
  body: string;
  bodyHtml?: string | null;
}): Promise<{ errors: string[]; warnings: string[] }> {
  const settings = await getSettings();
  const html = input.channel === "email" ? (input.bodyHtml ?? "").trim() : "";
  const readable = input.body.trim().length > 0 ? input.body : htmlToPlainText(html);

  const issues = checkCampaignCompliance({
    channel: input.channel,
    subject: input.subject,
    body: readable,
    businessName: settings.businessName,
  });
  const errors = issues.filter((i) => i.level === "error").map((i) => i.message);
  const warnings = issues.filter((i) => i.level === "warning").map((i) => i.message);

  if (html.length > 0) {
    for (const issue of checkCampaignHtml(html)) {
      (issue.level === "error" ? errors : warnings).push(issue.message);
    }
  }

  // Both parts are merged with the same placeholders, so both are checked.
  const unknown = [...new Set([...unknownMergeFields(input.body), ...unknownMergeFields(html)])];
  if (unknown.length > 0) {
    errors.push(
      `Unknown placeholder${unknown.length > 1 ? "s" : ""} ${unknown.map((f) => `{{${f}}}`).join(", ")} — only {{FirstName}}, {{Company}} and {{LastVisit}} can be filled in.`,
    );
  }
  return { errors, warnings };
}

export async function createCampaignAction(raw: unknown): Promise<ActionResult<{ campaignId: string }>> {
  try {
    const staff = await requireStaff("manage_marketing");
    const parsed = createCampaignInput.safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Check the campaign name, channel and message." };
    const input = parsed.data;

    const subject = input.channel === "email" ? (input.subject ?? "") : null;
    const bodyHtml = input.channel === "email" ? (input.bodyHtml?.trim() || null) : null;
    const { errors } = await validateCampaignContent({
      channel: input.channel,
      subject,
      body: input.body,
      bodyHtml,
    });
    if (errors.length > 0) return { ok: false, error: errors[0] };

    const campaignId = newId("ocm");
    await db().transaction(async (tx) => {
      await tx.insert(schema.outreachCampaigns).values({
        id: campaignId,
        name: input.name,
        channel: input.channel,
        subject,
        body: input.body,
        bodyHtml,
        status: "draft",
        createdByStaffId: staff.id,
      });
      await audit(tx, {
        actorType: "staff",
        actorId: staff.id,
        action: "outreach_campaign.created",
        entityType: "outreach_campaign",
        entityId: campaignId,
        after: { name: input.name, channel: input.channel },
      });
    });

    revalidatePath("/admin/marketing");
    return { ok: true, campaignId };
  } catch (error) {
    if (error instanceof AuthError) return { ok: false, error: error.message };
    console.error("createCampaignAction failed", error);
    return { ok: false, error: "Something went wrong creating the campaign." };
  }
}

export async function updateCampaignAction(raw: unknown): Promise<ActionResult<{ warnings: string[] }>> {
  try {
    const staff = await requireStaff("manage_marketing");
    const parsed = updateCampaignInput.safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Check the campaign name, channel and message." };
    const input = parsed.data;

    const result = await db().transaction(async (tx): Promise<ActionResult<{ warnings: string[] }>> => {
      const [before] = await tx
        .select()
        .from(schema.outreachCampaigns)
        .where(eq(schema.outreachCampaigns.id, input.campaignId))
        .for("update");
      if (!before) return { ok: false, error: "Campaign not found." };

      // Editing the message after part of the list has gone out would leave two
      // different messages filed under one campaign name, and the earlier
      // recipients' copy would no longer match what the record says was sent.
      const [alreadySent] = await tx
        .select({ id: schema.outreachRecipients.id })
        .from(schema.outreachRecipients)
        .where(
          and(
            eq(schema.outreachRecipients.campaignId, input.campaignId),
            eq(schema.outreachRecipients.status, "sent"),
          ),
        )
        .limit(1);
      const contentChanged =
        before.body !== input.body ||
        before.channel !== input.channel ||
        (before.subject ?? "") !== (input.subject ?? "") ||
        (before.bodyHtml ?? "") !== (input.bodyHtml?.trim() ?? "");
      if (alreadySent && contentChanged) {
        return {
          ok: false,
          error:
            "This campaign has already gone out to some contacts — the message can no longer be edited. Create a new campaign instead.",
        };
      }

      const subject = input.channel === "email" ? (input.subject ?? "") : null;
      const bodyHtml = input.channel === "email" ? (input.bodyHtml?.trim() || null) : null;
      const { errors, warnings } = await validateCampaignContent({
        channel: input.channel,
        subject,
        body: input.body,
        bodyHtml,
      });
      if (errors.length > 0) return { ok: false, error: errors[0] };

      await tx
        .update(schema.outreachCampaigns)
        .set({
          name: input.name,
          channel: input.channel,
          subject,
          body: input.body,
          bodyHtml,
          allowRecontact: input.allowRecontact,
          updatedAt: new Date(),
        })
        .where(eq(schema.outreachCampaigns.id, input.campaignId));
      await audit(tx, {
        actorType: "staff",
        actorId: staff.id,
        action: "outreach_campaign.updated",
        entityType: "outreach_campaign",
        entityId: input.campaignId,
        before: { name: before.name, channel: before.channel, body: before.body, allowRecontact: before.allowRecontact },
        after: { name: input.name, channel: input.channel, body: input.body, allowRecontact: input.allowRecontact },
      });
      return { ok: true, warnings };
    });

    revalidatePath(`/admin/marketing/${input.campaignId}`);
    return result;
  } catch (error) {
    if (error instanceof AuthError) return { ok: false, error: error.message };
    console.error("updateCampaignAction failed", error);
    return { ok: false, error: "Something went wrong saving the campaign." };
  }
}

/**
 * Turns a paste of contacts into leads on this campaign.
 *
 * Two things happen here that are worth being deliberate about. Contacts that
 * already exist are MATCHED rather than duplicated, so a fleet manager who is
 * already a customer does not end up as a second record. And consent is
 * recorded on each contact with its basis and the date it was obtained —
 * without that, `sendMessage` refuses to send to them at all, which is the
 * design working as intended (DECISIONS.md #8).
 */
export async function importContactsAction(raw: unknown): Promise<
  ActionResult<{
    queued: number;
    created: number;
    matched: number;
    duplicates: number;
    invalid: number;
    skippedNoDestination: number;
    errors: { line: number; text: string; problem: string }[];
  }>
> {
  try {
    const staff = await requireStaff("manage_marketing");
    const parsed = importContactsInput.safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Check the pasted contacts, the consent basis and the date." };
    const input = parsed.data;

    const campaign = await loadCampaign(input.campaignId);
    if (!campaign) return { ok: false, error: "Campaign not found." };
    if (campaign.status === "completed" || campaign.status === "cancelled") {
      return { ok: false, error: "This campaign is closed — create a new one to message more contacts." };
    }
    const campaignChannel = campaign.channel as MarketingChannel;

    const { contacts, errors } = parseContactPaste(input.paste);
    if (contacts.length === 0) {
      return {
        ok: false,
        error:
          errors.length > 0
            ? `Could not read any contacts. First problem: line ${errors[0].line} — ${errors[0].problem}.`
            : "No contacts found in what was pasted.",
      };
    }

    const [year, month, day] = input.metOn.split("-").map(Number);
    // Noon business-local, the same convention as expense dates: a calendar day
    // that cannot drift into its neighbour when read back in another zone.
    const consentAt = new Date(Date.UTC(year, month - 1, day, 12, 0));
    if (consentAt.getTime() > Date.now() + 24 * 60 * 60 * 1000) {
      return { ok: false, error: "The date you met these contacts cannot be in the future." };
    }

    const outcome = await db().transaction(async (tx) => {
      let created = 0;
      let matched = 0;
      let skippedNoDestination = 0;
      const candidates: Parameters<typeof queueRecipients>[2][number][] = [];

      for (const contact of contacts) {
        const rawDestination = campaignChannel === "sms" ? contact.phone : contact.email;
        const destination = normalizeDestination(campaignChannel, rawDestination);
        if (!destination) {
          skippedNoDestination += 1;
          errors.push({
            line: contact.line,
            text: [contact.firstName, contact.companyName].filter(Boolean).join(" — "),
            problem: campaignChannel === "sms" ? "No phone number" : "No email address",
          });
          continue;
        }

        const consentPatch = {
          marketingConsent: true,
          marketingConsentAt: consentAt,
          marketingConsentSource: input.consentBasis,
          updatedAt: new Date(),
        };

        // Match an existing customer first — they are the richer record, and a
        // fleet manager we already work for should not become a lead again.
        const [customer] = campaignChannel === "sms"
          ? await tx
              .select({ id: schema.customers.id })
              .from(schema.customers)
              .where(eq(schema.customers.phoneNormalized, destination))
              .limit(1)
          : await tx
              .select({ id: schema.customers.id })
              .from(schema.customers)
              // Case-insensitive: "Dave@Example.com" in an existing record and
              // "dave@example.com" on a business card are the same person, and
              // an exact match would quietly create a duplicate for them.
              .where(sql`lower(${schema.customers.email}) = ${destination}`)
              .limit(1);

        if (customer) {
          await tx.update(schema.customers).set(consentPatch).where(eq(schema.customers.id, customer.id));
          matched += 1;
          candidates.push({
            customerId: customer.id,
            destination: rawDestination,
            firstName: contact.firstName,
            companyName: contact.companyName,
          });
          continue;
        }

        const [lead] = campaignChannel === "sms"
          ? await tx
              .select({ id: schema.leads.id })
              .from(schema.leads)
              .where(eq(schema.leads.phoneNormalized, destination))
              .limit(1)
          : await tx
              .select({ id: schema.leads.id })
              .from(schema.leads)
              .where(sql`lower(${schema.leads.email}) = ${destination}`)
              .limit(1);

        if (lead) {
          await tx
            .update(schema.leads)
            .set({
              ...consentPatch,
              companyName: contact.companyName || undefined,
            })
            .where(eq(schema.leads.id, lead.id));
          matched += 1;
          candidates.push({
            leadId: lead.id,
            destination: rawDestination,
            firstName: contact.firstName,
            companyName: contact.companyName,
          });
          continue;
        }

        const leadId = newId("lead");
        await tx.insert(schema.leads).values({
          id: leadId,
          name: [contact.firstName, contact.lastName].filter(Boolean).join(" ") || contact.companyName,
          email: contact.email || null,
          phone: contact.phone || null,
          phoneNormalized: normalizePhone(contact.phone),
          companyName: contact.companyName || null,
          kind: "fleet",
          status: "new",
          attribution: { source: "fleet", manualSource: `outreach:${input.consentBasis}` },
          notes: `Added from ${campaign.name} — ${CONSENT_BASES[input.consentBasis]}, ${input.metOn}.`,
          ...consentPatch,
        });
        created += 1;
        candidates.push({
          leadId,
          destination: rawDestination,
          firstName: contact.firstName,
          companyName: contact.companyName,
        });
      }

      const queueResult = await queueRecipients(tx, { id: campaign.id, channel: campaignChannel }, candidates);

      await audit(tx, {
        actorType: "staff",
        actorId: staff.id,
        action: "outreach_campaign.contacts_imported",
        entityType: "outreach_campaign",
        entityId: campaign.id,
        after: {
          queued: queueResult.queued,
          created,
          matched,
          consentBasis: input.consentBasis,
          consentAt: input.metOn,
        },
      });

      return { ...queueResult, created, matched, skippedNoDestination };
    });

    revalidatePath(`/admin/marketing/${input.campaignId}`);
    return { ok: true, ...outcome, errors };
  } catch (error) {
    if (error instanceof AuthError) return { ok: false, error: error.message };
    console.error("importContactsAction failed", error);
    return { ok: false, error: "Something went wrong importing those contacts." };
  }
}

/* ------------------------------------------------------------------ */
/* Win-back audience                                                   */
/* ------------------------------------------------------------------ */

const queueAudienceInput = z.object({
  campaignId: z.string().min(1),
  filter: z.enum(["cancelled", "no_show", "missed"]),
  withinDays: z.number().int().min(1).max(1095),
  /** The rows the owner actually ticked. Never "everything that matched". */
  appointmentIds: z.array(z.string().min(1)).min(1).max(500),
});

/**
 * Adds the selected cancelled / no-show customers to a campaign.
 *
 * Two things deserve to be deliberate here.
 *
 * CONSENT IS RECORDED, NOT ASSUMED. `sendMessage` refuses a marketing message
 * to anyone without `marketing_consent` (DECISIONS.md #8), so queueing these
 * rows without recording a basis would produce a campaign where every row comes
 * back "skipped" — technically safe, completely useless. The basis written here
 * is the one the audience builder computed from the shop's own records: a
 * purchase inside two years, or the missed booking itself inside six months.
 * Rows with no footing are refused rather than consented into existence.
 *
 * THE SELECTION IS RE-CHECKED SERVER-SIDE. The ids arrive from a list the
 * browser rendered some minutes ago; an appointment that has since been
 * rebooked, or a customer who has since opted out, must not be queued because
 * a stale checkbox said so.
 */
export async function queueAudienceAction(raw: unknown): Promise<
  ActionResult<{
    queued: number;
    duplicates: number;
    invalid: number;
    refused: { name: string; reason: string }[];
  }>
> {
  try {
    const staff = await requireStaff("manage_marketing");
    const parsed = queueAudienceInput.safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Select at least one contact to add." };
    const input = parsed.data;

    const campaign = await loadCampaign(input.campaignId);
    if (!campaign) return { ok: false, error: "Campaign not found." };
    if (campaign.status === "completed" || campaign.status === "cancelled") {
      return { ok: false, error: "This campaign is closed — create a new one to message more contacts." };
    }
    const campaignChannel = campaign.channel as MarketingChannel;
    const settings = await getSettings();

    const { candidates } = await findMissedAppointments({
      filter: input.filter as AudienceFilter,
      channel: campaignChannel,
      withinDays: input.withinDays,
      timezone: settings.timezone,
      limit: 1000,
    });

    const wanted = new Set(input.appointmentIds);
    const selected = candidates.filter((c) => wanted.has(c.appointmentId));
    if (selected.length === 0) {
      return { ok: false, error: "Those bookings are no longer on the list — reload and try again." };
    }

    const refused: { name: string; reason: string }[] = [];
    const outcome = await db().transaction(async (tx) => {
      const queueable: Parameters<typeof queueRecipients>[2][number][] = [];
      const now = new Date();

      for (const candidate of selected) {
        if (candidate.blockedReason) {
          refused.push({ name: candidate.firstName, reason: candidate.blockedReason });
          continue;
        }

        // Express consent already on file is left exactly as it is — overwriting
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

        queueable.push({
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
        });
      }

      const queueResult = await queueRecipients(
        tx,
        { id: campaign.id, channel: campaignChannel },
        queueable,
      );

      if (!campaign.audience) {
        await tx
          .update(schema.outreachCampaigns)
          .set({ audience: input.filter, updatedAt: now })
          .where(eq(schema.outreachCampaigns.id, campaign.id));
      }

      await audit(tx, {
        actorType: "staff",
        actorId: staff.id,
        action: "outreach_campaign.audience_queued",
        entityType: "outreach_campaign",
        entityId: campaign.id,
        after: {
          filter: input.filter,
          withinDays: input.withinDays,
          selected: selected.length,
          queued: queueResult.queued,
          refused: refused.length,
          bases: [...new Set(selected.map((c) => describeFooting(c.footing)))],
        },
      });

      return queueResult;
    });

    revalidatePath(`/admin/marketing/${input.campaignId}`);
    return { ok: true, ...outcome, refused };
  } catch (error) {
    if (error instanceof AuthError) return { ok: false, error: error.message };
    console.error("queueAudienceAction failed", error);
    return { ok: false, error: "Something went wrong adding those contacts." };
  }
}

/** Confirms the provider this campaign needs is actually configured. */
async function providerReady(campaignChannel: MarketingChannel): Promise<boolean> {
  const { getIntegrationSecret } = await import("@/lib/integrations");
  if (campaignChannel === "sms") {
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

/**
 * Sends the campaign to yourself before it goes to anyone else.
 *
 * Sent as a `staff_alert`, which sits outside the marketing-consent gate by
 * design — the owner's own phone has no consent record and should not need one.
 * Merge fields render with obvious sample values so a missing {{FirstName}}
 * shows up as a hole rather than as a plausible-looking blank.
 */
export type TestSendResult = { ok: true } | { ok: false; error: string; detail?: string };

export async function sendTestAction(raw: unknown): Promise<TestSendResult> {
  try {
    await requireStaff("manage_marketing");
    const parsed = sendTestInput.safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Enter a phone number or email address to test with." };
    const input = parsed.data;

    const campaign = await loadCampaign(input.campaignId);
    if (!campaign) return { ok: false, error: "Campaign not found." };
    const campaignChannel = campaign.channel as MarketingChannel;

    const destination = normalizeDestination(campaignChannel, input.destination);
    if (!destination) {
      return {
        ok: false,
        error: campaignChannel === "sms" ? "That is not a usable phone number." : "That is not a usable email address.",
      };
    }
    if (!(await providerReady(campaignChannel))) {
      return {
        ok: false,
        error:
          campaignChannel === "sms"
            ? "Twilio is not configured yet — add the credentials in Settings → Integrations."
            : "Resend is not configured yet — add the credentials in Settings → Integrations.",
      };
    }

    // Obvious sample values, so a missing {{FirstName}} shows up as a hole
    // rather than as a plausible-looking blank.
    const sample = { firstName: "Sample", companyName: "Sample Company", lastVisit: "3 Aug 2026" };
    const html = campaign.bodyHtml ? renderOutreachBody(campaign.bodyHtml, sample) : null;
    const body = campaign.body.trim().length > 0
      ? renderOutreachBody(campaign.body, sample)
      : htmlToPlainText(html ?? "");
    const result = await sendMessage({
      channel: campaignChannel,
      kind: "staff_alert",
      to: input.destination,
      subject: campaignChannel === "email" ? `[TEST] ${campaign.subject ?? campaign.name}` : undefined,
      body: campaignChannel === "sms" ? body : `${body}\n\n— test send, footer omitted —`,
      // The test has to exercise the SAME markup that will go out, or it proves
      // nothing about how the template renders in a real inbox.
      ...(html ? { html } : {}),
      relatedEntityType: "outreach_campaign",
      relatedEntityId: campaign.id,
    });
    if (!result.sent) {
      // `detail` is the provider's own words (Twilio 21212 = bad From number,
      // 20003 = credentials rejected). It reaches this owner-only screen and
      // nowhere else — never a log, never a stored row.
      return { ok: false, error: "The test message could not be sent.", detail: result.detail };
    }
    return { ok: true };
  } catch (error) {
    if (error instanceof AuthError) return { ok: false, error: error.message };
    console.error("sendTestAction failed", error);
    return { ok: false, error: "Something went wrong sending the test." };
  }
}

/**
 * Releases the next few recipients. There is no "send to everyone" — the batch
 * size is capped so that a mistake in the wording costs five texts to look at
 * and stop, not fifty already delivered.
 */
export async function sendBatchAction(raw: unknown): Promise<ActionResult<{ outcome: BatchOutcome; remaining: number }>> {
  try {
    const staff = await requireStaff("manage_marketing");
    const parsed = sendBatchInput.safeParse(raw);
    if (!parsed.success) return { ok: false, error: `Choose a batch size between 1 and ${MAX_BATCH_SIZE}.` };
    const input = parsed.data;

    const campaign = await loadCampaign(input.campaignId);
    if (!campaign) return { ok: false, error: "Campaign not found." };
    if (campaign.status === "paused") return { ok: false, error: "This campaign is paused. Resume it first." };
    if (campaign.status === "cancelled" || campaign.status === "completed") {
      return { ok: false, error: "This campaign is closed." };
    }
    const campaignChannel = campaign.channel as MarketingChannel;

    const settings = await getSettings();
    const window = withinSendWindow(new Date(), settings.timezone);
    if (!window.allowed) {
      return {
        ok: false,
        error: `It is ${window.localHour}:00 locally — marketing messages only go out between 9am and 8pm. Try again during the day.`,
      };
    }

    const { errors, warnings } = await validateCampaignContent({
      channel: campaignChannel,
      subject: campaign.subject,
      body: campaign.body,
      bodyHtml: campaign.bodyHtml,
    });
    if (errors.length > 0) return { ok: false, error: errors[0] };
    if (warnings.length > 0 && !input.acknowledgeWarnings) {
      return { ok: false, error: `${warnings[0]} Review the message, then send again to confirm.` };
    }

    // Checked BEFORE any row is claimed: a missing credential would otherwise
    // burn a batch of recipients into `failed` for a reason that has nothing to
    // do with them.
    if (!(await providerReady(campaignChannel))) {
      return {
        ok: false,
        error:
          campaignChannel === "sms"
            ? "Twilio is not configured yet — add the credentials in Settings → Integrations."
            : "Resend is not configured yet — add the credentials in Settings → Integrations.",
      };
    }

    if (campaign.status === "draft") {
      await db()
        .update(schema.outreachCampaigns)
        .set({ status: "sending", updatedAt: new Date() })
        .where(eq(schema.outreachCampaigns.id, campaign.id));
    }

    const outcome = await sendOutreachBatch({ ...campaign, status: "sending" }, input.size);
    const progress = await campaignProgress(campaign.id);
    const remaining = progress.pending ?? 0;

    if (remaining === 0 && (progress.claimed ?? 0) === 0) {
      await db()
        .update(schema.outreachCampaigns)
        .set({ status: "completed", updatedAt: new Date() })
        .where(eq(schema.outreachCampaigns.id, campaign.id));
    }

    await db().transaction((tx) =>
      audit(tx, {
        actorType: "staff",
        actorId: staff.id,
        action: "outreach_campaign.batch_sent",
        entityType: "outreach_campaign",
        entityId: campaign.id,
        after: { attempted: outcome.attempted, sent: outcome.sent, failed: outcome.failed, skipped: outcome.skipped },
      }),
    );

    revalidatePath(`/admin/marketing/${campaign.id}`);
    return { ok: true, outcome, remaining };
  } catch (error) {
    if (error instanceof AuthError) return { ok: false, error: error.message };
    console.error("sendBatchAction failed", error);
    return { ok: false, error: "Something went wrong sending that batch." };
  }
}

const campaignStatusInput = z.object({
  campaignId: z.string().min(1),
  status: z.enum(["sending", "paused", "cancelled"]),
});

export async function setCampaignStatusAction(raw: unknown): Promise<ActionResult> {
  try {
    const staff = await requireStaff("manage_marketing");
    const parsed = campaignStatusInput.safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Invalid status." };
    const input = parsed.data;

    const result = await db().transaction(async (tx): Promise<ActionResult> => {
      const [campaign] = await tx
        .select()
        .from(schema.outreachCampaigns)
        .where(eq(schema.outreachCampaigns.id, input.campaignId))
        .for("update");
      if (!campaign) return { ok: false, error: "Campaign not found." };
      if (campaign.status === "completed") return { ok: false, error: "This campaign has already finished." };
      if (campaign.status === "cancelled") return { ok: false, error: "This campaign was cancelled." };

      await tx
        .update(schema.outreachCampaigns)
        .set({ status: input.status, updatedAt: new Date() })
        .where(eq(schema.outreachCampaigns.id, campaign.id));
      await audit(tx, {
        actorType: "staff",
        actorId: staff.id,
        action: `outreach_campaign.${input.status}`,
        entityType: "outreach_campaign",
        entityId: campaign.id,
        before: { status: campaign.status },
        after: { status: input.status },
      });
      return { ok: true };
    });

    revalidatePath(`/admin/marketing/${input.campaignId}`);
    return result;
  } catch (error) {
    if (error instanceof AuthError) return { ok: false, error: error.message };
    console.error("setCampaignStatusAction failed", error);
    return { ok: false, error: "Something went wrong updating the campaign." };
  }
}

const removeRecipientsInput = z.object({
  campaignId: z.string().min(1),
  recipientIds: z.array(z.string().min(1)).min(1).max(500),
});

/** Takes people off a campaign before it reaches them. Sent rows are untouched. */
export async function removeRecipientsAction(raw: unknown): Promise<ActionResult<{ removed: number }>> {
  try {
    const staff = await requireStaff("manage_marketing");
    const parsed = removeRecipientsInput.safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Nothing selected." };
    const input = parsed.data;

    const removed = await db()
      .delete(schema.outreachRecipients)
      .where(
        and(
          eq(schema.outreachRecipients.campaignId, input.campaignId),
          eq(schema.outreachRecipients.status, "pending"),
          inArray(schema.outreachRecipients.id, input.recipientIds),
        ),
      )
      .returning({ id: schema.outreachRecipients.id });

    if (removed.length > 0) {
      await db().transaction((tx) =>
        audit(tx, {
          actorType: "staff",
          actorId: staff.id,
          action: "outreach_campaign.recipients_removed",
          entityType: "outreach_campaign",
          entityId: input.campaignId,
          after: { removed: removed.length },
        }),
      );
    }

    revalidatePath(`/admin/marketing/${input.campaignId}`);
    return { ok: true, removed: removed.length };
  } catch (error) {
    if (error instanceof AuthError) return { ok: false, error: error.message };
    console.error("removeRecipientsAction failed", error);
    return { ok: false, error: "Something went wrong removing those contacts." };
  }
}

/** Manual do-not-contact entry, for someone who asks in person or by phone. */
export async function addSuppressionAction(raw: unknown): Promise<ActionResult> {
  try {
    const staff = await requireStaff("manage_marketing");
    const parsed = suppressionInput.safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Enter a phone number or email address." };
    const input = parsed.data;
    if (!normalizeDestination(input.channel, input.destination)) {
      return { ok: false, error: "That is not a usable phone number or email address." };
    }

    await db().transaction(async (tx) => {
      await addSuppression(tx, {
        channel: input.channel,
        destination: input.destination,
        reason: "manual",
        source: `Added by ${staff.name}`,
        note: input.note,
      });
      await audit(tx, {
        actorType: "staff",
        actorId: staff.id,
        action: "marketing.suppression_added",
        entityType: "marketing_suppression",
        entityId: `${input.channel}:${normalizeDestination(input.channel, input.destination)}`,
        after: { channel: input.channel, reason: "manual" },
      });
    });

    revalidatePath("/admin/marketing/do-not-contact");
    return { ok: true };
  } catch (error) {
    if (error instanceof AuthError) return { ok: false, error: error.message };
    console.error("addSuppressionAction failed", error);
    return { ok: false, error: "Something went wrong adding that entry." };
  }
}

/** Lifts a do-not-contact entry. Only ever at the contact's own request. */
export async function removeSuppressionAction(raw: unknown): Promise<ActionResult> {
  try {
    const staff = await requireStaff("manage_marketing");
    const parsed = suppressionInput.omit({ note: true }).safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Invalid entry." };
    const input = parsed.data;

    const result = await db().transaction(async (tx): Promise<ActionResult> => {
      const lifted = await removeSuppression(tx, input.channel, input.destination);
      if (!lifted) return { ok: false, error: "That entry is no longer on the list." };
      await audit(tx, {
        actorType: "staff",
        actorId: staff.id,
        action: "marketing.suppression_removed",
        entityType: "marketing_suppression",
        entityId: `${input.channel}:${normalizeDestination(input.channel, input.destination)}`,
        before: { channel: input.channel },
      });
      return { ok: true };
    });

    revalidatePath("/admin/marketing/do-not-contact");
    return result;
  } catch (error) {
    if (error instanceof AuthError) return { ok: false, error: error.message };
    console.error("removeSuppressionAction failed", error);
    return { ok: false, error: "Something went wrong removing that entry." };
  }
}
