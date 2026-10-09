"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { audit } from "@/lib/audit";
import { AuthError, requireStaff } from "@/lib/auth/session";
import { newId } from "@/lib/id";
import { emailComplianceFooter } from "@/lib/marketing/compliance";
import { withinSendWindow } from "@/lib/marketing/message";
import { isSuppressed } from "@/lib/marketing/suppressions";
import { unsubscribeUrl } from "@/lib/marketing/unsubscribe";
import { sendMessage } from "@/lib/messaging";
import { normalizePhone } from "@/lib/phone";
import {
  FOLLOW_UP_LIMITS,
  FOLLOW_UP_TEMPLATE_KEYS,
  LOGGED_FOLLOW_UP_METHODS,
  followUpWordingProblem,
  renderFollowUp,
} from "@/lib/quote-follow-up-message";
import {
  followUpBlock,
  loadQuoteForFollowUp,
  localDayToUtc,
  recordFollowUp,
} from "@/lib/quote-follow-ups";
import { getSettings } from "@/lib/settings";

export type FollowUpActionResult = { ok: true } | { ok: false; error: string };

const quoteRequestId = z.string().trim().min(1).max(64);
/** A calendar day from a date input, or null for "nothing scheduled". */
const nextFollowUpOn = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .nullable();

const channel = z.enum(["sms", "email"]);

const sendInput = z.object({
  quoteRequestId,
  channel,
  subject: z.string().trim().max(FOLLOW_UP_LIMITS.emailSubject).default(""),
  body: z.string().trim().min(1).max(FOLLOW_UP_LIMITS.emailBody),
  nextFollowUpOn,
});

const logInput = z.object({
  quoteRequestId,
  method: z.enum(LOGGED_FOLLOW_UP_METHODS),
  note: z.string().trim().max(FOLLOW_UP_LIMITS.note).default(""),
  nextFollowUpOn,
});

const commentInput = z.object({
  quoteRequestId,
  body: z.string().trim().min(1).max(FOLLOW_UP_LIMITS.note),
});

const scheduleInput = z.object({ quoteRequestId, nextFollowUpOn });

const wordingInput = z.object({
  channel,
  subject: z.string().trim().max(FOLLOW_UP_LIMITS.emailSubject).default(""),
  body: z.string().trim().min(1).max(FOLLOW_UP_LIMITS.emailBody),
});

function refresh(id: string) {
  revalidatePath(`/admin/leads/quotes/${id}`);
  revalidatePath("/admin/leads");
  revalidatePath("/admin");
}

function failure(err: unknown, where: string, fallback = "Something went wrong"): FollowUpActionResult {
  if (err instanceof AuthError) return { ok: false, error: err.message };
  console.error(`${where} failed`, err);
  return { ok: false, error: fallback };
}

/**
 * Sends one follow-up text or email to the person behind a quote or callback
 * request, and stamps it as followed up.
 *
 * Sent as `follow_up`, not `marketing`: almost nobody ticks the marketing box
 * on a quote form, and the request itself is what lets us write back. CASL
 * counts an inquiry as implied consent for six months, so that window, the
 * do-not-contact list and the opt-out wording are checked here instead of by
 * sendMessage's marketing gate. The email gets the same address-and-unsubscribe
 * footer campaigns carry, appended here so nobody can edit it away.
 *
 * The body comes from the composer rather than the saved template, so staff
 * can adjust the wording for one person without changing the default.
 */
export async function sendQuoteFollowUpAction(raw: unknown): Promise<FollowUpActionResult> {
  try {
    const staff = await requireStaff("manage_estimates");
    const parsed = sendInput.safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Write a message before sending." };
    const input = parsed.data;

    const context = await loadQuoteForFollowUp(input.quoteRequestId);
    if (!context) return { ok: false, error: "Quote request not found." };
    const { quote, lead, settings, values } = context;
    if (!lead) return { ok: false, error: "This request has no contact details to follow up with." };

    const problem = followUpWordingProblem({
      channel: input.channel,
      subject: input.subject,
      body: input.body,
      values,
      businessName: settings.businessName,
    });
    if (problem) return { ok: false, error: problem };

    const to = (input.channel === "sms" ? lead.phone : lead.email)?.trim() ?? "";
    const now = new Date();
    const blocked = followUpBlock({
      channel: input.channel,
      lead,
      requestedAt: quote.createdAt,
      now,
      suppressed: to ? await isSuppressed(input.channel, to) : false,
    });
    if (blocked) return { ok: false, error: blocked };

    // Texts only: an email at 9pm waits in an inbox, a text buzzes a phone.
    if (input.channel === "sms") {
      const window = withinSendWindow(now, settings.timezone);
      if (!window.allowed) {
        return {
          ok: false,
          error: `It is ${window.localHour}:00 locally. Follow-up texts only go out between 9am and 8pm — send an email, or text them in the morning.`,
        };
      }
    }

    const body = renderFollowUp(input.body, values);
    const result = await sendMessage({
      leadId: lead.id,
      customerId: quote.customerId ?? lead.convertedCustomerId ?? undefined,
      channel: input.channel,
      kind: "follow_up",
      to,
      subject: input.channel === "email" ? renderFollowUp(input.subject, values) : undefined,
      body:
        input.channel === "email"
          ? `${body}\n${emailComplianceFooter(
              settings,
              unsubscribeUrl(lead.id),
              "You are receiving this because you asked us about detailing your vehicle.",
            )}`
          : body,
      relatedEntityType: "quote_request",
      relatedEntityId: quote.id,
    });
    if (!result.sent) {
      return {
        ok: false,
        error:
          result.reason === "not_configured"
            ? input.channel === "sms"
              ? "Texting is not configured yet — add the Twilio credentials in Settings → Integrations."
              : "Email sending is not configured yet — add the Resend credentials in Settings → Integrations."
            : "The message could not be sent. Nothing was recorded — try again in a moment.",
      };
    }

    await db().transaction(async (tx) => {
      await tx
        .update(schema.communications)
        .set({ createdByStaffId: staff.id })
        .where(eq(schema.communications.id, result.id));
      // Leads from the public forms used to be saved without this, so a reply
      // to this text would have matched nobody. Fill it in on the way past.
      if (input.channel === "sms" && !lead.phoneNormalized) {
        await tx
          .update(schema.leads)
          .set({ phoneNormalized: normalizePhone(lead.phone) })
          .where(eq(schema.leads.id, lead.id));
      }
      await recordFollowUp(tx, {
        quoteRequestId: quote.id,
        leadId: lead.id,
        method: input.channel,
        note: null,
        communicationId: result.id,
        staffId: staff.id,
        nextFollowUpAt: input.nextFollowUpOn ? localDayToUtc(settings.timezone, input.nextFollowUpOn) : null,
        now,
      });
    });

    refresh(quote.id);
    revalidatePath(`/admin/leads/${lead.id}`);
    return { ok: true };
  } catch (err) {
    return failure(err, "sendQuoteFollowUpAction", "Something went wrong — check the activity before sending again.");
  }
}

/** Records a follow-up that happened outside the CRM — usually a phone call. */
export async function logQuoteFollowUpAction(raw: unknown): Promise<FollowUpActionResult> {
  try {
    const staff = await requireStaff("manage_estimates");
    const parsed = logInput.safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Choose how you followed up." };
    const input = parsed.data;

    const [quote] = await db()
      .select({ id: schema.quoteRequests.id, leadId: schema.quoteRequests.leadId })
      .from(schema.quoteRequests)
      .where(eq(schema.quoteRequests.id, input.quoteRequestId))
      .limit(1);
    if (!quote) return { ok: false, error: "Quote request not found." };
    const settings = await getSettings();

    await db().transaction(async (tx) => {
      await recordFollowUp(tx, {
        quoteRequestId: quote.id,
        leadId: quote.leadId,
        method: input.method,
        note: input.note || null,
        communicationId: null,
        staffId: staff.id,
        nextFollowUpAt: input.nextFollowUpOn ? localDayToUtc(settings.timezone, input.nextFollowUpOn) : null,
        now: new Date(),
      });
    });

    refresh(quote.id);
    if (quote.leadId) revalidatePath(`/admin/leads/${quote.leadId}`);
    return { ok: true };
  } catch (err) {
    return failure(err, "logQuoteFollowUpAction");
  }
}

/** A staff comment on the request. Changes nothing else about it. */
export async function addQuoteCommentAction(raw: unknown): Promise<FollowUpActionResult> {
  try {
    const staff = await requireStaff("manage_estimates");
    const parsed = commentInput.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, error: `Write a comment of up to ${FOLLOW_UP_LIMITS.note.toLocaleString()} characters.` };
    }
    const input = parsed.data;

    const [quote] = await db()
      .select({ id: schema.quoteRequests.id })
      .from(schema.quoteRequests)
      .where(eq(schema.quoteRequests.id, input.quoteRequestId))
      .limit(1);
    if (!quote) return { ok: false, error: "Quote request not found." };

    await db().insert(schema.quoteRequestActivities).values({
      id: newId("qra"),
      quoteRequestId: quote.id,
      kind: "comment",
      body: input.body,
      staffId: staff.id,
    });

    refresh(quote.id);
    return { ok: true };
  } catch (err) {
    return failure(err, "addQuoteCommentAction");
  }
}

/** Moves or clears the next follow-up date without recording a follow-up. */
export async function setQuoteNextFollowUpAction(raw: unknown): Promise<FollowUpActionResult> {
  try {
    const staff = await requireStaff("manage_estimates");
    const parsed = scheduleInput.safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Choose a valid date." };
    const input = parsed.data;
    const settings = await getSettings();
    const next = input.nextFollowUpOn ? localDayToUtc(settings.timezone, input.nextFollowUpOn) : null;

    const result = await db().transaction(async (tx): Promise<FollowUpActionResult> => {
      const [quote] = await tx
        .select()
        .from(schema.quoteRequests)
        .where(eq(schema.quoteRequests.id, input.quoteRequestId))
        .for("update");
      if (!quote) return { ok: false, error: "Quote request not found." };
      if ((quote.nextFollowUpAt?.getTime() ?? null) === (next?.getTime() ?? null)) return { ok: true };
      await tx
        .update(schema.quoteRequests)
        .set({ nextFollowUpAt: next, updatedAt: new Date() })
        .where(eq(schema.quoteRequests.id, quote.id));
      await audit(tx, {
        actorType: "staff",
        actorId: staff.id,
        action: "quote_request.follow_up_scheduled",
        entityType: "quote_request",
        entityId: quote.id,
        before: { nextFollowUpAt: quote.nextFollowUpAt?.toISOString() ?? null },
        after: { nextFollowUpAt: next?.toISOString() ?? null },
      });
      return { ok: true };
    });

    if (result.ok) refresh(input.quoteRequestId);
    return result;
  } catch (err) {
    return failure(err, "setQuoteNextFollowUpAction");
  }
}

/**
 * Saves the composer's wording as the default every request opens with.
 * Behind manage_settings, like the template editor in Admin → Communications:
 * this changes what everybody sends, not just this one message.
 */
export async function saveFollowUpWordingAction(raw: unknown): Promise<FollowUpActionResult> {
  try {
    const staff = await requireStaff("manage_settings");
    const parsed = wordingInput.safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Write a message before saving." };
    const input = parsed.data;
    const settings = await getSettings();

    // Checked against placeholder-shaped sample values: the default is not
    // written for anybody in particular.
    const problem = followUpWordingProblem({
      ...input,
      values: {
        firstName: "Sam",
        vehicle: "2021 Honda Civic",
        services: "ceramic protection",
        requestedOn: "Oct 8",
        bookingLink: "https://example.com/book",
        phone: settings.phone,
        businessName: settings.businessName,
      },
      businessName: settings.businessName,
    });
    if (problem) return { ok: false, error: problem };

    const key = FOLLOW_UP_TEMPLATE_KEYS[input.channel];
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

    revalidatePath("/admin/communications");
    return { ok: true };
  } catch (err) {
    return failure(err, "saveFollowUpWordingAction");
  }
}
