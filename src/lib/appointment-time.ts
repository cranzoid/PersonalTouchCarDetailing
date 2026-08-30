import { formatInZone } from "@/lib/tz";

/**
 * How an appointment's time is written wherever one is displayed.
 *
 * A date-only booking (`time_to_be_confirmed`) still carries a `starts_at` —
 * that day's opening time — so it sorts and groups by day like every other
 * appointment. That stored time is scaffolding, never a promise: printing it
 * would tell a customer to arrive at 9am for a slot nobody has agreed to, and
 * would tell the shop it has a car in the bay at 9am when it has not decided
 * yet. Every surface goes through these helpers so the two can never disagree.
 */

export const TIME_TO_BE_CONFIRMED_LABEL = "Time to be confirmed";

export type AppointmentTiming = {
  startsAt: Date;
  timeToBeConfirmed: boolean;
};

const TIME_OPTIONS: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };

/** For a column that shows only a time. */
export function appointmentTimeLabel(appointment: AppointmentTiming, timeZone: string): string {
  return appointment.timeToBeConfirmed
    ? TIME_TO_BE_CONFIRMED_LABEL
    : formatInZone(appointment.startsAt, timeZone, TIME_OPTIONS);
}

/**
 * Date plus time, in whatever date style the surface already used. The time
 * half is replaced — not appended to — so the sentence stays readable:
 * "Sat, Sep 12 · time to be confirmed".
 */
export function appointmentWhenLabel(
  appointment: AppointmentTiming,
  timeZone: string,
  dateOptions: Intl.DateTimeFormatOptions,
): string {
  const date = formatInZone(appointment.startsAt, timeZone, dateOptions);
  return appointment.timeToBeConfirmed
    ? `${date} · ${TIME_TO_BE_CONFIRMED_LABEL.toLowerCase()}`
    : `${date}, ${formatInZone(appointment.startsAt, timeZone, TIME_OPTIONS)}`;
}
