import { asc, eq, gt } from "drizzle-orm";
import { db, schema } from "@/db";
import { audit } from "@/lib/audit";
import { newId } from "@/lib/id";
import { formatInZone, localDateISO, zonedToUtc } from "@/lib/tz";

/**
 * Booking pauses: "take no more online bookings" for a stretch of time.
 *
 * A pause is enforced in the availability engine for customer paths only (see
 * loadDayContext). It never touches an appointment already booked, and staff
 * can still book into it — so, unlike a closure, it can be put over a day that
 * is already full, which is the day it is for.
 */

export class PauseError extends Error {}

export type PausePreset = "rest_of_today" | "tomorrow";

/** Longest single pause, matching the ceiling on a schedule block. */
const MAX_PAUSE_MS = 366 * 86_400_000;

function localMidnight(timeZone: string, nowMs: number, dayOffset: number): Date {
  const [y, m, d] = localDateISO(timeZone, 0, nowMs).split("-").map(Number);
  // Date.UTC inside zonedToUtc rolls d + 1 past a month end correctly.
  return zonedToUtc(timeZone, y, m, d + dayOffset, 0, 0);
}

/**
 * The window a one-tap preset stands for, worked out on the server in the
 * business timezone so no browser clock is trusted with it.
 */
export function presetWindow(
  preset: PausePreset,
  timeZone: string,
  nowMs = Date.now(),
): { startsAt: Date; endsAt: Date } {
  if (preset === "rest_of_today") {
    return { startsAt: new Date(nowMs), endsAt: localMidnight(timeZone, nowMs, 1) };
  }
  return { startsAt: localMidnight(timeZone, nowMs, 1), endsAt: localMidnight(timeZone, nowMs, 2) };
}

/** "YYYY-MM-DDTHH:MM" as typed into a datetime-local box, in business time. */
export function localDateTimeToUtc(value: string, timeZone: string): Date {
  const [date, time] = value.split("T");
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  return zonedToUtc(timeZone, y, m, d, hh, mm);
}

export async function createBookingPause(input: {
  startsAt: Date;
  endsAt: Date;
  reason?: string;
  staffId: string;
  nowMs?: number;
}): Promise<{ id: string }> {
  const nowMs = input.nowMs ?? Date.now();
  if (input.startsAt >= input.endsAt) throw new PauseError("The pause must end after it starts.");
  if (input.endsAt.getTime() <= nowMs) throw new PauseError("That time has already passed.");
  if (input.endsAt.getTime() - input.startsAt.getTime() > MAX_PAUSE_MS) {
    throw new PauseError("A pause cannot be longer than a year.");
  }
  const reason = input.reason?.trim() || null;
  const id = newId("bps");
  await db().transaction(async (tx) => {
    await tx.insert(schema.bookingPauses).values({
      id,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      reason,
      createdByStaffId: input.staffId,
    });
    await audit(tx, {
      actorType: "staff",
      actorId: input.staffId,
      action: "booking_pause.created",
      entityType: "booking_pause",
      entityId: id,
      after: { startsAt: input.startsAt.toISOString(), endsAt: input.endsAt.toISOString(), reason },
    });
  });
  return { id };
}

/**
 * Lifts a pause. One that has already started is cut short at `now` rather
 * than deleted, so the record of when bookings were off survives; one still
 * in the future simply never happened.
 */
export async function endBookingPause(input: {
  pauseId: string;
  staffId: string;
  nowMs?: number;
}): Promise<void> {
  const now = new Date(input.nowMs ?? Date.now());
  await db().transaction(async (tx) => {
    const [pause] = await tx
      .select()
      .from(schema.bookingPauses)
      .where(eq(schema.bookingPauses.id, input.pauseId))
      .for("update");
    if (!pause || pause.endsAt <= now) throw new PauseError("That pause has already ended.");
    const before = { startsAt: pause.startsAt.toISOString(), endsAt: pause.endsAt.toISOString(), reason: pause.reason };
    if (pause.startsAt <= now) {
      await tx.update(schema.bookingPauses).set({ endsAt: now }).where(eq(schema.bookingPauses.id, pause.id));
      await audit(tx, {
        actorType: "staff",
        actorId: input.staffId,
        action: "booking_pause.ended",
        entityType: "booking_pause",
        entityId: pause.id,
        before,
        after: { ...before, endsAt: now.toISOString() },
      });
    } else {
      await tx.delete(schema.bookingPauses).where(eq(schema.bookingPauses.id, pause.id));
      await audit(tx, {
        actorType: "staff",
        actorId: input.staffId,
        action: "booking_pause.removed",
        entityType: "booking_pause",
        entityId: pause.id,
        before,
      });
    }
  });
}

/** Pauses in force now or still to come, soonest first. */
export async function listCurrentBookingPauses(now = new Date()) {
  return db()
    .select()
    .from(schema.bookingPauses)
    .where(gt(schema.bookingPauses.endsAt, now))
    .orderBy(asc(schema.bookingPauses.startsAt));
}

/**
 * One end of a pause, for people. A pause that runs to midnight would read as
 * "12:00 a.m." on the NEXT day, which looks like a day too many, so an end on
 * midnight says "end of" the day it actually closes.
 */
export function pauseEdgeLabel(date: Date, timeZone: string, isEnd: boolean): string {
  const dayOpts = { weekday: "short", month: "short", day: "numeric" } as const;
  const [y, m, d] = localDateISO(timeZone, 0, date.getTime()).split("-").map(Number);
  if (isEnd && zonedToUtc(timeZone, y, m, d, 0, 0).getTime() === date.getTime()) {
    return `end of ${formatInZone(new Date(date.getTime() - 1), timeZone, dayOpts)}`;
  }
  return formatInZone(date, timeZone, { ...dayOpts, hour: "numeric", minute: "2-digit" });
}
