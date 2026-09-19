"use server";

import { revalidatePath } from "next/cache";
import { and, desc, eq, isNull, type SQL } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { audit } from "@/lib/audit";
import { AuthError, requireStaff } from "@/lib/auth/session";
import { isSuppressed, normalizeDestination } from "@/lib/marketing/suppressions";
import { sendMessage } from "@/lib/messaging";
import { normalizePhone } from "@/lib/phone";
import { REPLY_SMS_LIMIT } from "@/lib/reply-message";

export type ReplyActionResult = { ok: true } | { ok: false; error: string };

const threadInput = z.object({
  address: z.string().trim().min(3).max(200),
});

const replyInput = threadInput.extend({
  body: z.string().trim().min(1).max(REPLY_SMS_LIMIT),
});

/**
 * Every message in one conversation.
 *
 * Keyed on the NORMALIZED number, never on ids sent by the browser: the ids a
 * thread displays came from the server, but an action must not take a client's
 * word for whose history it is writing to or marking read.
 */
function threadReach(addressNormalized: string): SQL {
  return eq(schema.communications.contactAddressNormalized, addressNormalized);
}

/**
 * The contact this number belongs to, resolved here rather than trusted from
 * the client. Same matching rule the inbound webhook uses, so a reply we send
 * lands in exactly the record the reply we answer landed in.
 */
async function contactFor(addressNormalized: string): Promise<{
  customerId: string | null;
  leadId: string | null;
  /** The number exactly as it reached us, which is what we dial back. */
  address: string | null;
  hasInbound: boolean;
}> {
  const [inbound] = await db()
    .select({
      customerId: schema.communications.customerId,
      leadId: schema.communications.leadId,
      address: schema.communications.contactAddress,
    })
    .from(schema.communications)
    .where(and(eq(schema.communications.direction, "inbound"), threadReach(addressNormalized)))
    .orderBy(desc(schema.communications.createdAt))
    .limit(1);

  const [customer] = await db()
    .select({ id: schema.customers.id })
    .from(schema.customers)
    .where(eq(schema.customers.phoneNormalized, addressNormalized))
    .orderBy(desc(schema.customers.createdAt))
    .limit(1);
  const [lead] = await db()
    .select({ id: schema.leads.id })
    .from(schema.leads)
    .where(eq(schema.leads.phoneNormalized, addressNormalized))
    .orderBy(desc(schema.leads.createdAt))
    .limit(1);

  return {
    customerId: inbound?.customerId ?? customer?.id ?? null,
    leadId: inbound?.leadId ?? lead?.id ?? null,
    address: inbound?.address ?? null,
    hasInbound: Boolean(inbound),
  };
}

function normalizedOrNull(address: string): string | null {
  return normalizeDestination("sms", address) ?? normalizePhone(address);
}

/** Stamps every unread reply in one conversation as seen, and by whom. */
export async function markThreadReadAction(raw: unknown): Promise<ReplyActionResult> {
  try {
    const staff = await requireStaff("manage_customers");
    const parsed = threadInput.safeParse(raw);
    if (!parsed.success) return { ok: false, error: "That conversation could not be found." };
    const address = normalizedOrNull(parsed.data.address);
    if (!address) return { ok: false, error: "That conversation could not be found." };

    await db()
      .update(schema.communications)
      .set({ readAt: new Date(), readByStaffId: staff.id })
      .where(
        and(
          eq(schema.communications.direction, "inbound"),
          isNull(schema.communications.readAt),
          threadReach(address),
        ),
      );

    revalidatePath("/admin/messages");
    revalidatePath("/admin");
    return { ok: true };
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, error: err.message };
    console.error("markThreadReadAction failed", err);
    return { ok: false, error: "Something went wrong" };
  }
}

/**
 * Puts a whole conversation back in the unread queue.
 *
 * The whole conversation, not the last message: "I have not dealt with this"
 * is a statement about the thread, and leaving half of it read would only
 * hide the part that explains the rest.
 */
export async function markThreadUnreadAction(raw: unknown): Promise<ReplyActionResult> {
  try {
    await requireStaff("manage_customers");
    const parsed = threadInput.safeParse(raw);
    if (!parsed.success) return { ok: false, error: "That conversation could not be found." };
    const address = normalizedOrNull(parsed.data.address);
    if (!address) return { ok: false, error: "That conversation could not be found." };

    await db()
      .update(schema.communications)
      .set({ readAt: null, readByStaffId: null })
      .where(and(eq(schema.communications.direction, "inbound"), threadReach(address)));

    revalidatePath("/admin/messages");
    revalidatePath("/admin");
    return { ok: true };
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, error: err.message };
    console.error("markThreadUnreadAction failed", err);
    return { ok: false, error: "Something went wrong" };
  }
}

/**
 * Answers one conversation by text.
 *
 * Deliberately NOT a general "send a text to a number" endpoint: the number
 * must already have written to us, which is what makes this a reply. Without
 * that check, every user who can open a customer record would have an
 * unlogged, unbudgeted way to text anyone in Canada from the shop's number.
 *
 * Sent as `manual`, so it is not marketing and carries no consent requirement —
 * answering someone who just texted the shop is a conversation they started.
 * The opt-out list is still honoured: a number that replied STOP is blocked on
 * Twilio's side anyway, and attempting it would fail with error 21610.
 *
 * There is no send-window rule here either, unlike campaigns. Somebody texting
 * at 9pm is waiting for an answer at 9pm.
 */
export async function sendReplyAction(raw: unknown): Promise<ReplyActionResult> {
  try {
    const staff = await requireStaff("manage_customers");
    const parsed = replyInput.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, error: `Write a reply of up to ${REPLY_SMS_LIMIT} characters.` };
    }
    const address = normalizedOrNull(parsed.data.address);
    if (!address) return { ok: false, error: "That is not a usable phone number." };

    const contact = await contactFor(address);
    if (!contact.hasInbound) {
      return { ok: false, error: "This number has not texted the shop, so there is nothing to reply to." };
    }
    if (await isSuppressed("sms", address)) {
      return {
        ok: false,
        error: "This number replied STOP. Texting it is blocked by the carrier — call them instead.",
      };
    }

    const result = await sendMessage({
      customerId: contact.customerId ?? undefined,
      leadId: contact.leadId ?? undefined,
      channel: "sms",
      kind: "manual",
      // The number as it reached us, not as the browser spelled it. Both
      // normalize to the same thing — that was checked above — but the stored
      // form is the one Twilio has already delivered to.
      to: contact.address ?? parsed.data.address,
      body: parsed.data.body,
      relatedEntityType: "reply_thread",
      relatedEntityId: address,
    });
    if (!result.sent) {
      return {
        ok: false,
        error:
          result.reason === "not_configured"
            ? "Texting is not configured yet — add the Twilio credentials in Settings → Integrations."
            : "The reply could not be sent. Try again in a moment.",
      };
    }

    // The staff member who answered it has, by definition, read it.
    await db()
      .update(schema.communications)
      .set({ readAt: new Date(), readByStaffId: staff.id })
      .where(
        and(
          eq(schema.communications.direction, "inbound"),
          isNull(schema.communications.readAt),
          threadReach(address),
        ),
      );
    await db()
      .update(schema.communications)
      .set({ createdByStaffId: staff.id })
      .where(eq(schema.communications.id, result.id));

    await audit(db(), {
      actorType: "staff",
      actorId: staff.id,
      action: "reply.sent",
      entityType: "communication",
      entityId: result.id,
      after: { customerId: contact.customerId, leadId: contact.leadId },
    });

    revalidatePath("/admin/messages");
    revalidatePath("/admin");
    return { ok: true };
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, error: err.message };
    console.error("sendReplyAction failed", err);
    return { ok: false, error: "Something went wrong — the reply may not have been sent." };
  }
}

/** Marks every unread reply as seen. For clearing a backlog in one go. */
export async function markAllRepliesReadAction(): Promise<ReplyActionResult> {
  try {
    const staff = await requireStaff("manage_customers");
    await db()
      .update(schema.communications)
      .set({ readAt: new Date(), readByStaffId: staff.id })
      .where(and(eq(schema.communications.direction, "inbound"), isNull(schema.communications.readAt)));
    revalidatePath("/admin/messages");
    revalidatePath("/admin");
    return { ok: true };
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, error: err.message };
    console.error("markAllRepliesReadAction failed", err);
    return { ok: false, error: "Something went wrong" };
  }
}
