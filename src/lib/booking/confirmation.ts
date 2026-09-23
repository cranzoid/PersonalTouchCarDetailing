import { asc, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import type { BusinessSettings } from "@/lib/settings";
import { appointmentWhenLabel, type AppointmentTiming } from "@/lib/appointment-time";
import { sendMessageTemplate, type TemplateRecipient } from "@/lib/messaging";
import { formatInZone, localDateISO } from "@/lib/tz";

export type ConfirmationChannel = "email" | "sms";

/**
 * The booking confirmation — the `booking_confirmation` email and the
 * `booking_confirmation_sms` text — for an appointment that is already
 * confirmed. Online booking and the staff booking screen both send it through
 * here, so a customer booked over the phone hears exactly what one who booked
 * online does.
 *
 * It intentionally does not quote a price: it tells the customer what they
 * booked, not what it costs. Returns the channels that actually went out.
 */
export async function sendBookingConfirmation(input: {
  appointmentId: string;
  customerId: string;
  recipient: TemplateRecipient;
  firstName: string;
  appointment: AppointmentTiming;
  /** Line descriptions, in booking order. */
  services: string[];
  vehicle: string;
  settings: BusinessSettings;
}): Promise<ConfirmationChannel[]> {
  const { settings, appointment } = input;
  // Formatted from what was stored, not from what was submitted: a coating
  // is booked date-only whatever start time the request carried, and the
  // customer must be told the same thing the appointment record says.
  const dateLabelOptions = { weekday: "long", month: "long", day: "numeric" } as const;
  const variables = {
    businessName: settings.businessName,
    firstName: input.firstName,
    // The template reads "on {{date}} at {{time}}". A timed booking has
    // always carried the whole thing in {{date}}; a date-only one puts
    // the promise to call where the time would have been.
    date: appointment.timeToBeConfirmed
      ? formatInZone(appointment.startsAt, settings.timezone, dateLabelOptions)
      : appointmentWhenLabel(appointment, settings.timezone, dateLabelOptions),
    time: appointment.timeToBeConfirmed ? "a time we will confirm with you" : "",
    services: input.services.join(", "),
    vehicle: input.vehicle,
  };

  const delivery: ConfirmationChannel[] = [];
  for (const templateKey of ["booking_confirmation", "booking_confirmation_sms"]) {
    const result = await sendMessageTemplate({
      templateKey,
      recipient: input.recipient,
      customerId: input.customerId,
      kind: "confirmation",
      variables,
      relatedEntityType: "appointment",
      relatedEntityId: input.appointmentId,
    });
    if (result.sent && result.channel) delivery.push(result.channel);
  }
  return delivery;
}

/**
 * Whether a booking staff just saved is something to confirm to the customer.
 *
 * Staff also use the booking screen to record a walk-in after the fact, and
 * "your appointment is confirmed" for a visit that already happened is noise.
 * A date-only booking's stored start is that day's opening, so it counts as
 * upcoming for the whole of its day.
 */
export function isUpcomingForConfirmation(
  appointment: AppointmentTiming,
  timeZone: string,
  nowMs = Date.now(),
): boolean {
  if (appointment.timeToBeConfirmed) {
    return localDateISO(timeZone, 0, appointment.startsAt.getTime()) >= localDateISO(timeZone, 0, nowMs);
  }
  return appointment.startsAt.getTime() > nowMs;
}

/**
 * Confirms a booking staff took on the customer's behalf, reading what was
 * booked back from the stored appointment — the staff screen never holds the
 * customer's contact details, and the stored lines are what was actually saved.
 *
 * Only a `confirmed`, upcoming booking is confirmed. A deposit-required one is
 * not: it is not confirmed until the deposit is recorded, and staff arrange
 * that deposit themselves.
 */
export async function sendStaffBookingConfirmation(
  appointmentId: string,
  settings: BusinessSettings,
): Promise<ConfirmationChannel[]> {
  const [row] = await db()
    .select({ appointment: schema.appointments, customer: schema.customers, vehicle: schema.vehicles })
    .from(schema.appointments)
    .innerJoin(schema.customers, eq(schema.appointments.customerId, schema.customers.id))
    .leftJoin(schema.vehicles, eq(schema.appointments.vehicleId, schema.vehicles.id))
    .where(eq(schema.appointments.id, appointmentId))
    .limit(1);
  if (!row || row.appointment.status !== "confirmed") return [];
  if (!isUpcomingForConfirmation(row.appointment, settings.timezone)) return [];

  const lines = await db()
    .select({ description: schema.appointmentServices.description })
    .from(schema.appointmentServices)
    .where(eq(schema.appointmentServices.appointmentId, appointmentId))
    .orderBy(asc(schema.appointmentServices.sort));

  return sendBookingConfirmation({
    appointmentId,
    customerId: row.customer.id,
    recipient: row.customer,
    firstName: row.customer.firstName,
    appointment: row.appointment,
    services: lines.map((line) => line.description),
    vehicle: row.vehicle ? `${row.vehicle.make} ${row.vehicle.model}` : "your vehicle",
    settings,
  });
}
