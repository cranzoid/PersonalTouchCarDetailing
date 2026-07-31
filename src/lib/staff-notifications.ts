import "server-only";

import { asc, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { formatCents } from "@/lib/money";
import { sendMessage } from "@/lib/messaging";
import { getSettings, type BusinessSettings } from "@/lib/settings";
import { formatInZone } from "@/lib/tz";

/**
 * Operational alerts to our own staff — currently "a booking just landed".
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

  const when = formatInZone(appointment.startsAt, settings.timezone, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
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
