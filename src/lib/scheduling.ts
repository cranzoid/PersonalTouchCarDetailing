import { and, eq, gt, inArray, isNull } from "drizzle-orm";
import { db, schema } from "@/db";
import { getSettings } from "@/lib/settings";
import { isTerminalTemplateDelivery, sendMessageTemplate } from "@/lib/messaging";
import { formatInZone } from "@/lib/tz";
import { getAppBaseUrl } from "@/lib/urls";

/**
 * Time-driven background sends (Phase 5): appointment reminders, post-payment
 * review requests, and maintenance reminders. Nothing here has an on-read
 * trigger the way invoice overdue-flipping does — a page view doesn't imply
 * "it's now the right time to text this customer" — so these only run from
 * /api/cron/tick. Each function is a thin DB wrapper around a pure, unit-
 * tested "is this due" predicate so the cadence math has one source of truth.
 */

export function isAppointmentReminderDue(
  appt: { status: string; reminderSentAt: Date | null; startsAt: Date },
  now: Date,
  leadHours: number,
): boolean {
  if (appt.status !== "confirmed") return false;
  if (appt.reminderSentAt) return false;
  if (appt.startsAt <= now) return false;
  const windowEnd = new Date(now.getTime() + leadHours * 3600_000);
  return appt.startsAt <= windowEnd;
}

export function isReviewRequestDue(
  invoice: { status: string; paidAt: Date | null; reviewRequestSentAt: Date | null },
  now: Date,
  delayHours: number,
): boolean {
  if (invoice.status !== "paid") return false;
  if (!invoice.paidAt) return false;
  if (invoice.reviewRequestSentAt) return false;
  return now.getTime() - invoice.paidAt.getTime() >= delayHours * 3600_000;
}

export function isMaintenanceReminderDue(
  job: { status: string; completedAt: Date | null; maintenanceReminderSentAt: Date | null },
  now: Date,
  months: number,
): boolean {
  if (job.status !== "completed") return false;
  if (!job.completedAt) return false;
  if (job.maintenanceReminderSentAt) return false;
  const dueAt = new Date(job.completedAt);
  dueAt.setMonth(dueAt.getMonth() + months);
  return now >= dueAt;
}

/**
 * Sends the `appointment_reminder` template to customers whose confirmed
 * appointment starts within the configured lead time. Operational, not
 * marketing (consistent with messaging.ts — booking isn't marketing
 * consent), so it's never consent-gated. Stamps reminderSentAt whether or
 * not a message actually went out (e.g. configured destination unavailable) so a broken record
 * doesn't get re-evaluated on every tick.
 */
export async function sendDueAppointmentReminders(): Promise<number> {
  const settings = await getSettings();
  const now = new Date();
  const candidates = await db()
    .select({ appointment: schema.appointments, customer: schema.customers })
    .from(schema.appointments)
    .innerJoin(schema.customers, eq(schema.appointments.customerId, schema.customers.id))
    .where(and(eq(schema.appointments.status, "confirmed"), isNull(schema.appointments.reminderSentAt), gt(schema.appointments.startsAt, now)));

  const due = candidates.filter(({ appointment }) => isAppointmentReminderDue(appointment, now, settings.reminderLeadHours));
  if (due.length === 0) return 0;

  let sent = 0;
  for (const { appointment, customer } of due) {
    const result = await sendMessageTemplate({
      templateKey: "appointment_reminder",
      recipient: customer,
      customerId: customer.id,
      kind: "reminder",
      variables: {
        businessName: settings.businessName,
        date: formatInZone(appointment.startsAt, settings.timezone, { weekday: "short", month: "short", day: "numeric" }),
        time: formatInZone(appointment.startsAt, settings.timezone, { hour: "numeric", minute: "2-digit" }),
      },
      relatedEntityType: "appointment",
      relatedEntityId: appointment.id,
    });
    if (result.sent) sent++;
    if (isTerminalTemplateDelivery(result)) {
      await db().update(schema.appointments).set({ reminderSentAt: now }).where(eq(schema.appointments.id, appointment.id));
    }
  }
  return sent;
}

/**
 * Sends the `review_request` template once a paid invoice has sat settled
 * for the configured delay. Marketing-class (see messaging.ts) — sendMessage
 * suppresses it without consent, but reviewRequestSentAt is still stamped so
 * a non-consenting customer's invoice isn't re-checked forever.
 */
export async function sendDueReviewRequests(): Promise<number> {
  const settings = await getSettings();
  const now = new Date();
  const candidates = await db()
    .select({ invoice: schema.invoices, customer: schema.customers })
    .from(schema.invoices)
    .innerJoin(schema.customers, eq(schema.invoices.customerId, schema.customers.id))
    .where(and(eq(schema.invoices.status, "paid"), isNull(schema.invoices.reviewRequestSentAt)));

  const due = candidates.filter(({ invoice }) => isReviewRequestDue(invoice, now, settings.reviewRequestDelayHours));
  if (due.length === 0) return 0;

  let sent = 0;
  for (const { invoice, customer } of due) {
    const result = await sendMessageTemplate({
      templateKey: "review_request",
      recipient: customer,
      customerId: customer.id,
      kind: "review_request",
      variables: {
        businessName: settings.businessName,
        firstName: customer.firstName,
        reviewUrl: settings.googleReviewUrl,
      },
      relatedEntityType: "invoice",
      relatedEntityId: invoice.id,
    });
    if (result.sent) sent++;
    if (isTerminalTemplateDelivery(result)) {
      await db().update(schema.invoices).set({ reviewRequestSentAt: now }).where(eq(schema.invoices.id, invoice.id));
    }
  }
  return sent;
}

/**
 * Sends the `maintenance` template once a vehicle's most recent completed
 * job is old enough to suggest booking the next visit. Only the LATEST
 * completed job per vehicle can trigger this — older completed jobs for a
 * vehicle that's since been serviced again are stamped as handled without
 * sending, so they stop being re-evaluated. Marketing-class, consent-gated.
 */
export async function sendDueMaintenanceReminders(): Promise<number> {
  const settings = await getSettings();
  const now = new Date();
  const candidates = await db()
    .select({ job: schema.jobs, customer: schema.customers, vehicle: schema.vehicles })
    .from(schema.jobs)
    .innerJoin(schema.customers, eq(schema.jobs.customerId, schema.customers.id))
    .innerJoin(schema.vehicles, eq(schema.jobs.vehicleId, schema.vehicles.id))
    .where(and(eq(schema.jobs.status, "completed"), isNull(schema.jobs.maintenanceReminderSentAt)));

  const dueByTime = candidates.filter(({ job }) => isMaintenanceReminderDue(job, now, settings.maintenanceReminderMonths));
  if (dueByTime.length === 0) return 0;

  const vehicleIds = [...new Set(dueByTime.map((c) => c.job.vehicleId))];
  const allCompletedForVehicles = await db()
    .select({ vehicleId: schema.jobs.vehicleId, completedAt: schema.jobs.completedAt })
    .from(schema.jobs)
    .where(and(eq(schema.jobs.status, "completed"), inArray(schema.jobs.vehicleId, vehicleIds)));
  const latestByVehicle = new Map<string, number>();
  for (const row of allCompletedForVehicles) {
    if (!row.completedAt) continue;
    const t = row.completedAt.getTime();
    if (t > (latestByVehicle.get(row.vehicleId) ?? 0)) latestByVehicle.set(row.vehicleId, t);
  }

  const bookingUrl = `${getAppBaseUrl()}/book`;

  let sent = 0;
  for (const { job, customer, vehicle } of dueByTime) {
    const isLatestVisit = job.completedAt && job.completedAt.getTime() === latestByVehicle.get(job.vehicleId);
    let handled = !isLatestVisit;
    if (isLatestVisit) {
      const result = await sendMessageTemplate({
        templateKey: "maintenance",
        recipient: customer,
        customerId: customer.id,
        kind: "maintenance",
        variables: {
          businessName: settings.businessName,
          firstName: customer.firstName,
          vehicle: [vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(" "),
          bookingUrl,
        },
        relatedEntityType: "job",
        relatedEntityId: job.id,
      });
      if (result.sent) sent++;
      handled = isTerminalTemplateDelivery(result);
    }
    if (handled) {
      await db().update(schema.jobs).set({ maintenanceReminderSentAt: now }).where(eq(schema.jobs.id, job.id));
    }
  }
  return sent;
}
