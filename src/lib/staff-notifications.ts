import "server-only";

import { and, asc, eq, gt } from "drizzle-orm";
import { db, schema } from "@/db";
import { appointmentWhenLabel } from "@/lib/appointment-time";
import { formatCents } from "@/lib/money";
import { sendMessage } from "@/lib/messaging";
import { formatPhone, normalizePhone } from "@/lib/phone";
import { getSettings, type BusinessSettings } from "@/lib/settings";
import { getAppBaseUrl } from "@/lib/urls";

/**
 * Operational alerts to our own staff — a booking just landed, or a customer
 * just texted back.
 *
 * Deliberately addressed to plain phone numbers and email addresses from
 * settings rather than staff_users rows: the manager login is shared between
 * several people who each want the message on their own phone.
 *
 * Every function here is best-effort. Callers invoke them after the booking
 * transaction has committed, and a messaging outage must never fail or
 * duplicate a booking.
 */

export type StaffAlertOutcome = { attempted: number; sent: number };

type Recipient = { channel: "sms" | "email"; to: string };

function recipients(settings: BusinessSettings): Recipient[] {
  return [
    ...settings.staffNotifyPhones.map((to) => ({ channel: "sms" as const, to })),
    ...settings.staffNotifyEmails.map((to) => ({ channel: "email" as const, to })),
  ];
}

/**
 * Fans out one alert per recipient. Sends run independently so a single bad
 * number cannot stop the rest, and `sendMessage` already records each attempt
 * in the communications log.
 */
async function fanOut(
  settings: BusinessSettings,
  subject: string,
  body: string,
  related: { type: string; id: string },
  customerId?: string,
): Promise<StaffAlertOutcome> {
  const targets = recipients(settings);
  if (targets.length === 0) return { attempted: 0, sent: 0 };

  const results = await Promise.allSettled(
    targets.map((target) =>
      sendMessage({
        channel: target.channel,
        kind: "staff_alert",
        to: target.to,
        subject: target.channel === "email" ? subject : undefined,
        body,
        customerId,
        relatedEntityType: related.type,
        relatedEntityId: related.id,
      }),
    ),
  );

  const sent = results.filter((r) => r.status === "fulfilled" && r.value.sent).length;
  if (sent < targets.length) {
    // Recipient addresses are PII — log counts only.
    console.error(`[staff-alert] ${targets.length - sent}/${targets.length} staff alerts failed to send`);
  }
  return { attempted: targets.length, sent };
}

/**
 * Alerts staff that a new appointment exists. Safe to call for both the public
 * booking flow and admin-created bookings; returns a zero outcome when the
 * feature is switched off or no recipients are configured.
 */
export async function notifyStaffOfNewAppointment(appointmentId: string): Promise<StaffAlertOutcome> {
  const settings = await getSettings();
  if (!settings.notifyOnNewAppointment) return { attempted: 0, sent: 0 };
  if (recipients(settings).length === 0) return { attempted: 0, sent: 0 };

  const [appointment] = await db()
    .select()
    .from(schema.appointments)
    .where(eq(schema.appointments.id, appointmentId))
    .limit(1);
  if (!appointment) return { attempted: 0, sent: 0 };

  const [customer] = await db()
    .select()
    .from(schema.customers)
    .where(eq(schema.customers.id, appointment.customerId))
    .limit(1);
  const vehicle = appointment.vehicleId
    ? (
        await db()
          .select()
          .from(schema.vehicles)
          .where(eq(schema.vehicles.id, appointment.vehicleId))
          .limit(1)
      )[0]
    : undefined;
  const lines = await db()
    .select({ description: schema.appointmentServices.description })
    .from(schema.appointmentServices)
    .where(eq(schema.appointmentServices.appointmentId, appointmentId))
    .orderBy(asc(schema.appointmentServices.sort));

  // A date-only booking arrives with an unanswered question, so the alert that
  // wakes the owner's phone says so — this is the prompt to call the customer.
  const when = appointmentWhenLabel(appointment, settings.timezone, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  const who = customer ? `${customer.firstName} ${customer.lastName}`.trim() : "Unknown customer";
  const what = lines.map((l) => l.description).join(", ") || "No services listed";
  const car = vehicle ? [vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(" ") : null;

  const body = [
    `New booking: ${who}`,
    when,
    car,
    what,
    `Total ${formatCents(appointment.totalCents, settings.currency)}`,
    customer?.phone ?? customer?.email ?? null,
  ]
    .filter(Boolean)
    .join("\n");

  return fanOut(
    settings,
    `New booking — ${who}, ${when}`,
    body,
    { type: "appointment", id: appointmentId },
    appointment.customerId,
  );
}

/**
 * How long one contact's replies stay under a single alert.
 *
 * Someone typing three lines in a row is one conversation, not three things to
 * be woken for, and a campaign send can bring several replies at once. The
 * window is per contact, so a second person writing in still gets through
 * immediately.
 */
const REPLY_ALERT_WINDOW_MIN = 10;

/** Ties an alert back to the conversation it is about, and throttles on it. */
const REPLY_ALERT_ENTITY = "customer_reply";

const NOTHING: StaffAlertOutcome = { attempted: 0, sent: 0 };

/** The contact's own name, when the reply matched a record we hold. */
async function replyContactName(input: {
  customerId: string | null;
  leadId: string | null;
}): Promise<string | null> {
  if (input.customerId) {
    const [customer] = await db()
      .select({ firstName: schema.customers.firstName, lastName: schema.customers.lastName })
      .from(schema.customers)
      .where(eq(schema.customers.id, input.customerId))
      .limit(1);
    const name = customer ? `${customer.firstName} ${customer.lastName}`.trim() : "";
    if (name) return name;
  }
  if (input.leadId) {
    const [lead] = await db()
      .select({ name: schema.leads.name })
      .from(schema.leads)
      .where(eq(schema.leads.id, input.leadId))
      .limit(1);
    const name = lead?.name.trim();
    if (name) return name;
  }
  return null;
}

/**
 * Alerts staff that a customer has written back.
 *
 * The reply itself is already recorded and readable in Admin -> Messages by
 * the time this runs; what this adds is that somebody knows to go and answer
 * it while the customer is still holding their phone. Call it AFTER the
 * inbound message has committed and treat it as best-effort: an alert that
 * cannot be sent must never cost us the reply.
 *
 * Deliberately not called for STOP or START. Those are acted on automatically,
 * the carrier has already blocked the number, and a staff member texting back
 * "no problem" would be a send to a number that just opted out.
 */
export async function notifyStaffOfCustomerReply(input: {
  /** The sender's number, exactly as it arrived. */
  from: string;
  body: string;
  customerId: string | null;
  leadId: string | null;
  /** The reply reads like an opt-out request without using the keyword. */
  needsAttention: boolean;
}): Promise<StaffAlertOutcome> {
  const settings = await getSettings();
  if (!settings.notifyOnCustomerReply) return NOTHING;
  if (recipients(settings).length === 0) return NOTHING;

  const normalized = normalizePhone(input.from);

  // A staff member texting the shop number is not a customer reply. Alerting
  // them about their own message is also how an alert loop starts: the alert
  // goes out from the same number they just wrote to.
  if (normalized && settings.staffNotifyPhones.some((phone) => normalizePhone(phone) === normalized)) {
    return NOTHING;
  }

  const threadKey = normalized ?? input.from.trim();
  const [recent] = await db()
    .select({ id: schema.communications.id })
    .from(schema.communications)
    .where(
      and(
        eq(schema.communications.kind, "staff_alert"),
        eq(schema.communications.relatedEntityType, REPLY_ALERT_ENTITY),
        eq(schema.communications.relatedEntityId, threadKey),
        gt(schema.communications.createdAt, new Date(Date.now() - REPLY_ALERT_WINDOW_MIN * 60_000)),
      ),
    )
    .limit(1);
  if (recent) return NOTHING;

  const who = (await replyContactName(input)) ?? "Unknown number";
  const number = formatPhone(input.from) || input.from;
  const text = input.body.trim().replace(/\s+/g, " ");
  // Kept short on purpose: this is an SMS to the owner's phone, and the whole
  // message is in the inbox anyway.
  const excerpt = text.length > 160 ? `${text.slice(0, 159)}…` : text;

  const body = [
    `Reply from ${who} — ${number}`,
    excerpt ? `"${excerpt}"` : "(no message text)",
    input.needsAttention ? "Reads like an opt-out request — check before texting again." : null,
    `Answer: ${getAppBaseUrl()}/admin/messages`,
  ]
    .filter(Boolean)
    .join("\n");

  return fanOut(
    settings,
    `Reply from ${who}`,
    body,
    { type: REPLY_ALERT_ENTITY, id: threadKey },
    input.customerId ?? undefined,
  );
}
