"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { and, eq, gt, inArray, lt, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireStaff, AuthError } from "@/lib/auth/session";
import { audit } from "@/lib/audit";
import { getSettings, setSetting, type BusinessSettings } from "@/lib/settings";
import { newId } from "@/lib/id";
import { APPOINTMENT_BLOCKING_STATUSES } from "@/lib/types";
import { zonedToUtc } from "@/lib/tz";

const settingsInput = z.object({
  businessName: z.string().trim().min(1).max(200),
  addressLine1: z.string().trim().max(300),
  city: z.string().trim().max(100),
  province: z.string().trim().max(10),
  postalCode: z.string().trim().max(10),
  phone: z.string().trim().max(30),
  email: z.string().trim().email().max(200).or(z.literal("")),
  googleReviewUrl: z.string().trim().url().max(500).or(z.literal("")),
  taxRateBp: z.number().int().min(0).max(3000),
  taxRegistrationNumber: z.string().trim().max(50),
  slotGranularityMin: z.number().int().min(15).max(120),
  setupBufferMin: z.number().int().min(0).max(120),
  cleanupBufferMin: z.number().int().min(0).max(120),
  minBookingNoticeHours: z.number().int().min(0).max(24 * 14),
  maxBookingWindowDays: z.number().int().min(1).max(365),
  cancellationNoticeHours: z.number().int().min(0).max(24 * 14),
  reminderLeadHours: z.number().int().min(1).max(24 * 7),
  reviewRequestDelayHours: z.number().int().min(0).max(24 * 30),
  maintenanceReminderMonths: z.number().int().min(1).max(24),
});

export type ActionResult = { ok: true } | { ok: false; error: string };

const hoursInput = z
  .array(
    z.object({
      weekday: z.number().int().min(0).max(6),
      closed: z.boolean(),
      open: z.string().regex(/^\d{2}:\d{2}$/).nullable(),
      close: z.string().regex(/^\d{2}:\d{2}$/).nullable(),
    }),
  )
  .length(7);

export async function updateBusinessHoursAction(raw: unknown): Promise<ActionResult> {
  try {
    const staff = await requireStaff("manage_settings");
    const parsed = hoursInput.safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Invalid hours — use HH:MM times" };
    for (const day of parsed.data) {
      if (!day.closed && (!day.open || !day.close || day.open >= day.close)) {
        return { ok: false, error: "Open time must be before close time on open days" };
      }
    }

    await db().transaction(async (tx) => {
      const before = await tx.select().from(schema.businessHours);
      for (const day of parsed.data) {
        await tx
          .update(schema.businessHours)
          .set({
            closed: day.closed,
            open: day.closed ? null : day.open,
            close: day.closed ? null : day.close,
            updatedAt: new Date(),
          })
          .where(eq(schema.businessHours.weekday, day.weekday));
      }
      await audit(tx, {
        actorType: "staff",
        actorId: staff.id,
        action: "business_hours.updated",
        entityType: "business_hours",
        entityId: "default",
        before: before.map((h) => ({ weekday: h.weekday, closed: h.closed, open: h.open, close: h.close })),
        after: parsed.data,
      });
    });

    revalidatePath("/", "layout");
    return { ok: true };
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, error: err.message };
    console.error("updateBusinessHoursAction failed", err);
    return { ok: false, error: "Something went wrong" };
  }
}

export async function updateSettingsAction(raw: unknown): Promise<ActionResult> {
  try {
    const staff = await requireStaff("manage_settings");
    const parsed = settingsInput.safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Invalid values — please check the fields" };
    const input = parsed.data;

    const before = await getSettings();
    for (const [key, value] of Object.entries(input) as [keyof BusinessSettings, never][]) {
      await setSetting(key, value, staff.id);
    }
    // Tax and business-identity changes are sensitive; audit the whole diff.
    await audit(db(), {
      actorType: "staff",
      actorId: staff.id,
      action: "settings.updated",
      entityType: "business_settings",
      entityId: "default",
      before: Object.fromEntries(Object.keys(input).map((k) => [k, before[k as keyof BusinessSettings]])),
      after: input,
    });

    revalidatePath("/", "layout");
    return { ok: true };
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, error: err.message };
    console.error("updateSettingsAction failed", err);
    return { ok: false, error: "Something went wrong" };
  }
}

const blockInput = z.object({
  type: z.enum(["closure", "bay", "staff"]),
  targetId: z.string().trim().optional(),
  startsLocal: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/),
  endsLocal: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/),
  reason: z.string().trim().min(1).max(500),
});

function localDateTime(value: string, timezone: string): Date {
  const [date, time] = value.split("T");
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  return zonedToUtc(timezone, y, m, d, hh, mm);
}

export async function createScheduleBlockAction(raw: unknown): Promise<ActionResult> {
  try {
    const actor = await requireStaff("manage_settings");
    const parsed = blockInput.safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Check the block type, dates and reason" };
    const input = parsed.data;
    if (input.type !== "closure" && !input.targetId) return { ok: false, error: "Choose a staff member or bay" };
    const settings = await getSettings();
    const startsAt = localDateTime(input.startsLocal, settings.timezone);
    const endsAt = localDateTime(input.endsLocal, settings.timezone);
    if (startsAt >= endsAt) return { ok: false, error: "Block end must be after its start" };
    if (endsAt <= new Date()) return { ok: false, error: "A schedule block must end in the future" };
    if (endsAt.getTime() - startsAt.getTime() > 366 * 86_400_000) {
      return { ok: false, error: "A schedule block cannot exceed one year" };
    }

    const result = await db().transaction(async (tx): Promise<ActionResult> => {
      let staffUserId: string | null = null;
      let resourceId: string | null = null;

      // Booking transactions take resource → staff locks in this same order.
      if (input.type === "closure") {
        await tx.execute(sql`SELECT id FROM resources WHERE type = 'bay' AND active = true ORDER BY id FOR UPDATE`);
        await tx.execute(sql`SELECT id FROM staff_users WHERE active = true ORDER BY id FOR UPDATE`);
      } else if (input.type === "bay") {
        const [resource] = await tx.select().from(schema.resources)
          .where(eq(schema.resources.id, input.targetId!)).for("update");
        if (!resource || !resource.active || resource.type !== "bay") return { ok: false, error: "Active bay not found" };
        resourceId = resource.id;
      } else {
        const [staff] = await tx.select().from(schema.staffUsers)
          .where(eq(schema.staffUsers.id, input.targetId!)).for("update");
        if (!staff || !staff.active) return { ok: false, error: "Active staff member not found" };
        staffUserId = staff.id;
      }

      const overlapping = await tx.select({ id: schema.appointments.id }).from(schema.appointments)
        .where(and(
          inArray(schema.appointments.status, APPOINTMENT_BLOCKING_STATUSES),
          lt(schema.appointments.startsAt, endsAt),
          gt(schema.appointments.endsAt, startsAt),
          resourceId ? eq(schema.appointments.resourceId, resourceId) : undefined,
          staffUserId ? eq(schema.appointments.assignedStaffId, staffUserId) : undefined,
        )).limit(1);
      if (overlapping.length > 0) {
        return { ok: false, error: "This block overlaps an existing appointment. Reschedule it first." };
      }

      const blockId = newId("blk");
      await tx.insert(schema.scheduleBlocks).values({
        id: blockId,
        staffUserId,
        resourceId,
        startsAt,
        endsAt,
        reason: input.reason,
      });
      await audit(tx, {
        actorType: "staff",
        actorId: actor.id,
        action: "schedule_block.created",
        entityType: "schedule_block",
        entityId: blockId,
        after: { type: input.type, staffUserId, resourceId, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), reason: input.reason },
      });
      return { ok: true };
    });
    if (result.ok) {
      revalidatePath("/admin/settings");
      revalidatePath("/admin/appointments");
    }
    return result;
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, error: err.message };
    console.error("createScheduleBlockAction failed", err);
    return { ok: false, error: "Something went wrong" };
  }
}

export async function removeScheduleBlockAction(raw: unknown): Promise<ActionResult> {
  try {
    const actor = await requireStaff("manage_settings");
    const parsed = z.object({ blockId: z.string().min(1) }).safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Invalid schedule block" };
    const result = await db().transaction(async (tx): Promise<ActionResult> => {
      const [block] = await tx.select().from(schema.scheduleBlocks)
        .where(eq(schema.scheduleBlocks.id, parsed.data.blockId)).for("update");
      if (!block) return { ok: false, error: "Schedule block not found" };
      await tx.delete(schema.scheduleBlocks).where(eq(schema.scheduleBlocks.id, block.id));
      await audit(tx, {
        actorType: "staff",
        actorId: actor.id,
        action: "schedule_block.removed",
        entityType: "schedule_block",
        entityId: block.id,
        before: {
          staffUserId: block.staffUserId,
          resourceId: block.resourceId,
          startsAt: block.startsAt.toISOString(),
          endsAt: block.endsAt.toISOString(),
          reason: block.reason,
        },
      });
      return { ok: true };
    });
    if (result.ok) {
      revalidatePath("/admin/settings");
      revalidatePath("/admin/appointments");
    }
    return result;
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, error: err.message };
    console.error("removeScheduleBlockAction failed", err);
    return { ok: false, error: "Something went wrong" };
  }
}
