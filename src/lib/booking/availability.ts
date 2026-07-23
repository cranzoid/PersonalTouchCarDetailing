import { and, eq, gt, lt, inArray, ne } from "drizzle-orm";
import { db, schema } from "@/db";
import type { BusinessSettings } from "@/lib/settings";
import { APPOINTMENT_BLOCKING_STATUSES } from "@/lib/types";
import { parseHHMM, zonedToUtc, zonedWeekday } from "@/lib/tz";

export type Interval = { start: number; end: number }; // epoch ms, [start, end)

export type StaffCapacity = {
  id: string;
  skills: string[];
  shifts: Interval[];
  busy: Interval[];
};

export function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && a.end > b.start;
}

export type DayContext = {
  /** UTC open/close for the requested business-local day; null when closed. */
  openMs: number | null;
  closeMs: number | null;
  granularityMin: number;
  /** Full block the appointment occupies: setup + work + cleanup. */
  totalDurationMin: number;
  nowMs: number;
  minNoticeHours: number;
  maxBookingWindowDays: number;
  /** Busy intervals per bay (existing appointments + bay-specific blocks). */
  busyByBay: Interval[][];
  /** Blocking appointments not assigned to any bay — consume one bay of capacity each. */
  unassignedBusy: Interval[];
  /** Whole-business closures (holidays etc.). */
  globalBlocks: Interval[];
  /** False only when the installation has no weekly staff schedule rows. */
  staffingConfigured: boolean;
  /** Skill-matched staff who have at least one shift on this local weekday. */
  staffCapacity: StaffCapacity[];
  /** Legacy/unassigned appointments conservatively consume one staff slot. */
  unassignedStaffBusy: Interval[];
  requiredSkills: string[];
};

/**
 * Pure slot computation (unit-tested). A slot is offered when at least one bay
 * is free for the entire window after accounting for unassigned appointments,
 * and the window violates no block, notice, or booking-window rule.
 *
 * This is ADVISORY — the booking transaction re-checks under a row lock
 * (see createAppointment) and is the only authority.
 */
export function computeDaySlots(ctx: DayContext): Interval[] {
  if (ctx.openMs === null || ctx.closeMs === null) return [];
  const out: Interval[] = [];
  const durMs = ctx.totalDurationMin * 60_000;
  const stepMs = ctx.granularityMin * 60_000;
  const earliest = ctx.nowMs + ctx.minNoticeHours * 3600_000;
  const latest = ctx.nowMs + ctx.maxBookingWindowDays * 86_400_000;

  for (let start = ctx.openMs; start + durMs <= ctx.closeMs; start += stepMs) {
    const window: Interval = { start, end: start + durMs };
    if (start < earliest || start > latest) continue;
    if (ctx.globalBlocks.some((b) => overlaps(b, window))) continue;
    if (!hasFreeBay(ctx, window)) continue;
    if (ctx.staffingConfigured && pickFreeStaff(ctx, window) === null) continue;
    out.push(window);
  }
  return out;
}

export function normalizeSkill(skill: string): string {
  return skill.trim().toLowerCase();
}

export function hasRequiredSkills(staffSkills: string[], requiredSkills: string[]): boolean {
  const available = new Set(staffSkills.map(normalizeSkill));
  return requiredSkills.map(normalizeSkill).every((skill) => available.has(skill));
}

/**
 * Returns an eligible on-shift, non-busy staff id. `undefined` means staffing
 * is not configured and callers should preserve the legacy bay-only fallback;
 * `null` means configured but no eligible staff is available.
 */
export function pickFreeStaff(
  ctx: Pick<DayContext, "staffingConfigured" | "staffCapacity" | "unassignedStaffBusy" | "requiredSkills">,
  window: Interval,
): string | null | undefined {
  if (!ctx.staffingConfigured) return undefined;
  const free = ctx.staffCapacity.filter((staff) =>
    hasRequiredSkills(staff.skills, ctx.requiredSkills) &&
    staff.shifts.some((shift) => shift.start <= window.start && shift.end >= window.end) &&
    !staff.busy.some((busy) => overlaps(busy, window)),
  );
  const unassignedOverlap = ctx.unassignedStaffBusy.filter((busy) => overlaps(busy, window)).length;
  if (free.length - unassignedOverlap < 1) return null;
  return free[free.length - 1].id;
}

export function hasFreeBay(
  ctx: Pick<DayContext, "busyByBay" | "unassignedBusy">,
  window: Interval,
): boolean {
  return pickFreeBay(ctx, window) !== null;
}

/**
 * Returns the index of a bay free for the window, or null. Capacity model:
 * unassigned blocking appointments each consume one otherwise-free bay
 * (conservative — bays partially busy in the window count as busy).
 */
export function pickFreeBay(
  ctx: Pick<DayContext, "busyByBay" | "unassignedBusy">,
  window: Interval,
): number | null {
  const freeBays: number[] = [];
  for (let i = 0; i < ctx.busyByBay.length; i++) {
    if (!ctx.busyByBay[i].some((b) => overlaps(b, window))) freeBays.push(i);
  }
  const unassignedOverlap = ctx.unassignedBusy.filter((b) => overlaps(b, window)).length;
  if (freeBays.length - unassignedOverlap < 1) return null;
  return freeBays[freeBays.length - 1]; // later bays first; unassigned appts conceptually fill earlier ones
}

/* ------------------------------------------------------------------ */
/* DB-backed context loading                                           */
/* ------------------------------------------------------------------ */

export async function loadDayContext(input: {
  dateISO: string; // "YYYY-MM-DD" in business-local calendar
  workDurationMin: number;
  settings: BusinessSettings;
  now?: Date;
  /** Used while rescheduling so the appointment does not block itself. */
  excludeAppointmentId?: string;
  requiredSkills?: string[];
}): Promise<{ ctx: DayContext; bayIds: string[] }> {
  const { settings } = input;
  const [y, m, d] = input.dateISO.split("-").map(Number);
  const tz = settings.timezone;
  const weekday = zonedWeekday(tz, y, m, d);

  const hours = await db()
    .select()
    .from(schema.businessHours)
    .where(eq(schema.businessHours.weekday, weekday));
  const dayHours = hours[0];

  let openMs: number | null = null;
  let closeMs: number | null = null;
  if (dayHours && !dayHours.closed && dayHours.open && dayHours.close) {
    const o = parseHHMM(dayHours.open);
    const c = parseHHMM(dayHours.close);
    openMs = zonedToUtc(tz, y, m, d, o.hh, o.mm).getTime();
    closeMs = zonedToUtc(tz, y, m, d, c.hh, c.mm).getTime();
  }

  const bays = await db()
    .select()
    .from(schema.resources)
    .where(and(eq(schema.resources.type, "bay"), eq(schema.resources.active, true)))
    .orderBy(schema.resources.name);
  const bayIds = bays.map((b) => b.id);

  const busyByBay: Interval[][] = bayIds.map(() => []);
  const unassignedBusy: Interval[] = [];
  const globalBlocks: Interval[] = [];
  const unassignedStaffBusy: Interval[] = [];

  // Compatibility fallback: an install with zero weekly schedule rows keeps
  // the historic bay-only behavior. Once the owner saves any shift, staffing
  // becomes authoritative for every day and service.
  const staffingConfigured = (
    await db().select({ id: schema.staffSchedules.id }).from(schema.staffSchedules).limit(1)
  ).length > 0;
  const staffCapacity: StaffCapacity[] = [];
  if (staffingConfigured) {
    const [activeStaff, daySchedules] = await Promise.all([
      db().select({ id: schema.staffUsers.id, skills: schema.staffUsers.skills })
        .from(schema.staffUsers).where(eq(schema.staffUsers.active, true)),
      db().select().from(schema.staffSchedules).where(eq(schema.staffSchedules.weekday, weekday)),
    ]);
    const activeById = new Map(activeStaff.map((staff) => [staff.id, staff]));
    for (const schedule of daySchedules) {
      const staff = activeById.get(schedule.staffUserId);
      if (!staff) continue;
      let capacity = staffCapacity.find((candidate) => candidate.id === staff.id);
      if (!capacity) {
        capacity = { id: staff.id, skills: staff.skills, shifts: [], busy: [] };
        staffCapacity.push(capacity);
      }
      const start = parseHHMM(schedule.start);
      const end = parseHHMM(schedule.end);
      capacity.shifts.push({
        start: zonedToUtc(tz, y, m, d, start.hh, start.mm).getTime(),
        end: zonedToUtc(tz, y, m, d, end.hh, end.mm).getTime(),
      });
    }
  }

  if (openMs !== null && closeMs !== null) {
    const dayStart = new Date(openMs - 12 * 3600_000);
    const dayEnd = new Date(closeMs + 12 * 3600_000);

    const appts = await db()
      .select({
        startsAt: schema.appointments.startsAt,
        endsAt: schema.appointments.endsAt,
        resourceId: schema.appointments.resourceId,
        assignedStaffId: schema.appointments.assignedStaffId,
      })
      .from(schema.appointments)
      .where(
        and(
          inArray(schema.appointments.status, APPOINTMENT_BLOCKING_STATUSES),
          input.excludeAppointmentId
            ? ne(schema.appointments.id, input.excludeAppointmentId)
            : undefined,
          lt(schema.appointments.startsAt, dayEnd),
          gt(schema.appointments.endsAt, dayStart),
        ),
      );
    for (const a of appts) {
      const iv = { start: a.startsAt.getTime(), end: a.endsAt.getTime() };
      const idx = a.resourceId ? bayIds.indexOf(a.resourceId) : -1;
      if (idx >= 0) busyByBay[idx].push(iv);
      else unassignedBusy.push(iv);
      if (staffingConfigured) {
        const assigned = a.assignedStaffId
          ? staffCapacity.find((candidate) => candidate.id === a.assignedStaffId)
          : undefined;
        if (assigned) assigned.busy.push(iv);
        else unassignedStaffBusy.push(iv);
      }
    }

    const blocks = await db()
      .select()
      .from(schema.scheduleBlocks)
      .where(
        and(lt(schema.scheduleBlocks.startsAt, dayEnd), gt(schema.scheduleBlocks.endsAt, dayStart)),
      );
    for (const b of blocks) {
      const iv = { start: b.startsAt.getTime(), end: b.endsAt.getTime() };
      if (b.resourceId) {
        const idx = bayIds.indexOf(b.resourceId);
        if (idx >= 0) busyByBay[idx].push(iv);
      } else if (!b.staffUserId) {
        globalBlocks.push(iv); // whole-business closure
      }
      if (staffingConfigured && b.staffUserId) {
        staffCapacity.find((candidate) => candidate.id === b.staffUserId)?.busy.push(iv);
      }
    }
  }

  const ctx: DayContext = {
    openMs,
    closeMs,
    granularityMin: settings.slotGranularityMin,
    totalDurationMin: settings.setupBufferMin + input.workDurationMin + settings.cleanupBufferMin,
    nowMs: (input.now ?? new Date()).getTime(),
    minNoticeHours: settings.minBookingNoticeHours,
    maxBookingWindowDays: settings.maxBookingWindowDays,
    busyByBay,
    unassignedBusy,
    globalBlocks,
    staffingConfigured,
    staffCapacity,
    unassignedStaffBusy,
    requiredSkills: [...new Set((input.requiredSkills ?? []).map(normalizeSkill).filter(Boolean))],
  };
  return { ctx, bayIds };
}

export async function getAvailableSlots(input: {
  dateISO: string;
  workDurationMin: number;
  settings: BusinessSettings;
  now?: Date;
  excludeAppointmentId?: string;
  requiredSkills?: string[];
}): Promise<Interval[]> {
  const { ctx } = await loadDayContext(input);
  return computeDaySlots(ctx);
}
