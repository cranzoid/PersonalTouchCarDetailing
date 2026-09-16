"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { audit } from "@/lib/audit";
import { AuthError, requireStaff } from "@/lib/auth/session";
import { newId } from "@/lib/id";
import { checkCampaignCompliance, emailComplianceFooter } from "@/lib/marketing/compliance";
import { withinSendWindow } from "@/lib/marketing/message";
import { normalizeDestination } from "@/lib/marketing/suppressions";
import { sendMessage } from "@/lib/messaging";
import { getSettings, type BusinessSettings } from "@/lib/settings";
import { getAppBaseUrl } from "@/lib/urls";
import { activeWashOffer, type ResolvedWashOffer } from "@/lib/wash-offer";
import {
  MAX_NUDGE_BATCH,
  NUDGE_LIMITS,
  NUDGE_TEMPLATE_KEYS,
  renderNudge,
  unknownNudgePlaceholders,
  type NudgeChannel,
} from "@/lib/wash-offer-nudge-message";
import {
  nudgeProviderReady,
  sampleNudgeValues,
  sendClaimNudges,
  type NudgeOutcome,
} from "@/lib/wash-offer-nudges";

export type NudgeActionResult<T extends object = Record<never, never>> =
  | ({ ok: true } & T)
  | { ok: false; error: string };

const channel = z.enum(["sms", "email"]);

const wordingInput = z.object({
  channel,
  subject: z.string().trim().max(NUDGE_LIMITS.emailSubject).default(""),
  body: z.string().trim().min(1).max(NUDGE_LIMITS.emailBody),
});

const sendInput = wordingInput.extend({
  claimIds: z.array(z.string().trim().min(1).max(64)).min(1).max(MAX_NUDGE_BATCH),
});

const testInput = wordingInput.extend({
  destination: z.string().trim().min(3).max(200),
});

type Wording = z.infer<typeof wordingInput>;

/**
 * The checks every save and send runs, against the wording as a customer would
 * read it. Compliance is judged on the RENDERED text: "{{businessName}}" does
 * not contain the shop's name, the text it becomes does.
 */
function wordingProblem(
  wording: Wording,
  context: { offer: ResolvedWashOffer; settings: BusinessSettings; baseUrl: string },
): string | null {
  if (wording.channel === "sms" && wording.body.length > NUDGE_LIMITS.smsBody) {
    return `A text can be at most ${NUDGE_LIMITS.smsBody} characters.`;
  }
  const unknown = unknownNudgePlaceholders(wording.subject, wording.body);
  if (unknown.length > 0) {
    return `Unknown placeholder${unknown.length > 1 ? "s" : ""}: ${unknown.map((k) => `{{${k}}}`).join(", ")}.`;
  }
  const sample = sampleNudgeValues(context);
  const blocking = checkCampaignCompliance({
    channel: wording.channel,
    subject: wording.channel === "email" ? renderNudge(wording.subject, sample) : null,
    body: renderNudge(wording.body, sample),
    businessName: context.settings.businessName,
  }).filter((issue) => issue.level === "error");
  return blocking[0]?.message ?? null;
}

async function loadContext(): Promise<
  | { ok: true; settings: BusinessSettings; offer: ResolvedWashOffer; baseUrl: string }
  | { ok: false; error: string }
> {
  const settings = await getSettings();
  const offer = activeWashOffer(settings);
  if (!offer) {
    return {
      ok: false,
      error: "The wash offer is switched off, so its booking link does not work — nothing was sent.",
    };
  }
  return { ok: true, settings, offer, baseUrl: getAppBaseUrl() };
}

function providerMissing(target: NudgeChannel): string {
  return target === "sms"
    ? "Twilio is not configured yet — add the credentials in Settings → Integrations."
    : "Email sending is not configured yet — add the Resend credentials in Settings → Integrations.";
}

/**
 * Sends the nudge to the selected people.
 *
 * The body comes from the composer rather than from the saved template, so
 * staff can adjust the wording for one send without changing the default.
 */
export async function sendWashNudgesAction(
  raw: unknown,
): Promise<NudgeActionResult<{ outcomes: NudgeOutcome[]; sent: number; skipped: number; failed: number }>> {
  try {
    const staff = await requireStaff("manage_marketing");
    const parsed = sendInput.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, error: `Choose between 1 and ${MAX_NUDGE_BATCH} people, and write a message.` };
    }
    const input = parsed.data;

    const context = await loadContext();
    if (!context.ok) return context;
    const problem = wordingProblem(input, context);
    if (problem) return { ok: false, error: problem };

    const window = withinSendWindow(new Date(), context.settings.timezone);
    if (!window.allowed) {
      return {
        ok: false,
        error: `It is ${window.localHour}:00 locally. Nudges only go out between 9am and 8pm.`,
      };
    }
    if (!(await nudgeProviderReady(input.channel))) {
      return { ok: false, error: providerMissing(input.channel) };
    }

    const outcomes = await sendClaimNudges({
      claimIds: input.claimIds,
      channel: input.channel,
      subject: input.subject,
      body: input.body,
      staffId: staff.id,
      settings: context.settings,
      offer: context.offer,
      baseUrl: context.baseUrl,
    });

    for (const outcome of outcomes.filter((o) => o.status === "sent")) {
      await audit(db(), {
        actorType: "staff",
        actorId: staff.id,
        action: "offer_claim.nudged",
        entityType: "offer_claim",
        entityId: outcome.claimId,
        after: { channel: input.channel },
      });
    }

    revalidatePath("/admin/marketing/wash-nudges");
    revalidatePath("/admin/marketing/offer-claims");
    const count = (status: NudgeOutcome["status"]) => outcomes.filter((o) => o.status === status).length;
    return { ok: true, outcomes, sent: count("sent"), skipped: count("skipped"), failed: count("failed") };
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, error: err.message };
    console.error("sendWashNudgesAction failed", err);
    return { ok: false, error: "Something went wrong — check the list before sending again." };
  }
}

/** Saves the composer's wording as the default the screen opens with. */
export async function saveNudgeWordingAction(raw: unknown): Promise<NudgeActionResult> {
  try {
    const staff = await requireStaff("manage_marketing");
    const parsed = wordingInput.safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Write a message before saving." };
    const input = parsed.data;

    const context = await loadContext();
    if (!context.ok) return context;
    const problem = wordingProblem(input, context);
    if (problem) return { ok: false, error: problem };

    const key = NUDGE_TEMPLATE_KEYS[input.channel];
    const subject = input.channel === "email" ? input.subject : null;
    await db().transaction(async (tx) => {
      const [before] = await tx
        .select()
        .from(schema.messageTemplates)
        .where(eq(schema.messageTemplates.key, key))
        .for("update");
      if (before) {
        await tx
          .update(schema.messageTemplates)
          .set({ subject, body: input.body, updatedAt: new Date() })
          .where(eq(schema.messageTemplates.id, before.id));
      } else {
        await tx.insert(schema.messageTemplates).values({
          id: newId("tpl"),
          key,
          channel: input.channel,
          subject,
          body: input.body,
        });
      }
      await audit(tx, {
        actorType: "staff",
        actorId: staff.id,
        action: "message_template.updated",
        entityType: "message_template",
        entityId: before?.id ?? key,
        before: before ? { subject: before.subject, body: before.body } : null,
        after: { subject, body: input.body },
      });
    });

    revalidatePath("/admin/marketing/wash-nudges");
    revalidatePath("/admin/communications");
    return { ok: true };
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, error: err.message };
    console.error("saveNudgeWordingAction failed", err);
    return { ok: false, error: "Something went wrong" };
  }
}

/**
 * Sends the current wording to the person pressing the button, filled in with
 * sample values. Goes out as a `staff_alert` — the owner's own phone has no
 * consent record and should not need one — and outside the send window check,
 * because testing at 10pm bothers nobody else.
 */
export async function sendNudgeTestAction(raw: unknown): Promise<NudgeActionResult> {
  try {
    await requireStaff("manage_marketing");
    const parsed = testInput.safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Enter your own number or email to test with." };
    const input = parsed.data;

    const destination = normalizeDestination(input.channel, input.destination);
    if (!destination) {
      return {
        ok: false,
        error: input.channel === "sms" ? "That is not a usable phone number." : "That is not a usable email address.",
      };
    }

    const context = await loadContext();
    if (!context.ok) return context;
    const problem = wordingProblem(input, context);
    if (problem) return { ok: false, error: problem };
    if (!(await nudgeProviderReady(input.channel))) {
      return { ok: false, error: providerMissing(input.channel) };
    }

    const sample = sampleNudgeValues(context);
    const body = renderNudge(input.body, sample);
    const result = await sendMessage({
      channel: input.channel,
      kind: "staff_alert",
      to: input.destination,
      subject: input.channel === "email" ? `[TEST] ${renderNudge(input.subject, sample)}` : undefined,
      body:
        input.channel === "email"
          ? `${body}\n${emailComplianceFooter(context.settings, `${context.baseUrl}/unsubscribe/sample`)}`
          : body,
    });
    return result.sent
      ? { ok: true }
      : { ok: false, error: "The test could not be sent — check Settings → Integrations." };
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, error: err.message };
    console.error("sendNudgeTestAction failed", err);
    return { ok: false, error: "Something went wrong" };
  }
}
