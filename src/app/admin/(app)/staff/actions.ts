"use server";

import { revalidatePath } from "next/cache";
import { and, asc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { audit } from "@/lib/audit";
import { hashPassword } from "@/lib/auth/password";
import { AuthError, requireStaff } from "@/lib/auth/session";
import { newId } from "@/lib/id";
import { validatePayTerms } from "@/lib/payroll";
import { PAY_TYPES, STAFF_ROLES } from "@/lib/types";

export type ActionResult<T extends object = object> =
  | ({ ok: true } & T)
  | { ok: false; error: string };

const passwordSchema = z.string().min(12).max(200);

const createStaffSchema = z.object({
  name: z.string().trim().min(1).max(150),
  email: z.string().trim().toLowerCase().email().max(200),
  role: z.enum(STAFF_ROLES),
  password: passwordSchema,
});

const updateStaffSchema = z.object({
  staffUserId: z.string().min(1),
  role: z.enum(STAFF_ROLES),
  active: z.boolean(),
});

const resetPasswordSchema = z.object({
  staffUserId: z.string().min(1),
  password: passwordSchema,
});

const removeStaffSchema = z.object({
  staffUserId: z.string().min(1),
  confirmation: z.literal("REMOVE"),
});

const moneySchema = z.number().int().min(0).max(100_000_000);

const payTermsSchema = z.object({
  staffUserId: z.string().min(1),
  payType: z.enum(PAY_TYPES),
  hourlyRateCents: moneySchema,
  dailyRateCents: moneySchema,
  monthlySalaryCents: moneySchema,
});

const staffSchedulingSchema = z.object({
  staffUserId: z.string().min(1),
  skills: z.array(z.string().trim().min(1).max(60)).max(30),
  shifts: z.array(z.object({
    weekday: z.number().int().min(0).max(6),
    start: z.string().regex(/^\d{2}:\d{2}$/),
    end: z.string().regex(/^\d{2}:\d{2}$/),
  })).max(7),
});

export async function createStaffAction(raw: unknown): Promise<ActionResult<{ staffUserId: string }>> {
  try {
    const actor = await requireStaff("manage_staff");
    const parsed = createStaffSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, error: "Enter a valid name, email, role and password of at least 12 characters" };
    }
    const input = parsed.data;
    const passwordHash = await hashPassword(input.password);

    const result = await db().transaction(async (tx): Promise<ActionResult<{ staffUserId: string }>> => {
      const staffUserId = newId("usr");
      const inserted = await tx
        .insert(schema.staffUsers)
        .values({
          id: staffUserId,
          name: input.name,
          email: input.email,
          passwordHash,
          role: input.role,
          active: true,
        })
        .onConflictDoNothing({ target: schema.staffUsers.email })
        .returning({ id: schema.staffUsers.id });
      if (!inserted[0]) {
        return { ok: false, error: "A staff user with that email already exists" };
      }

      await audit(tx, {
        actorType: "staff",
        actorId: actor.id,
        action: "staff.created",
        entityType: "staff_user",
        entityId: staffUserId,
        after: { name: input.name, email: input.email, role: input.role, active: true },
      });
      return { ok: true, staffUserId };
    });

    if (result.ok) revalidatePath("/admin/staff");
    return result;
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, error: err.message };
    console.error("createStaffAction failed", err);
    return { ok: false, error: "Something went wrong" };
  }
}

export async function updateStaffAction(raw: unknown): Promise<ActionResult> {
  try {
    const actor = await requireStaff("manage_staff");
    const parsed = updateStaffSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Invalid staff update" };
    const input = parsed.data;

    const result = await db().transaction(async (tx): Promise<ActionResult> => {
      // Every role/status update takes the active-owner locks in the same order.
      // Concurrent demotions therefore cannot both observe a different owner
      // and accidentally leave the business without an active owner.
      const activeOwners = await tx
        .select({ id: schema.staffUsers.id })
        .from(schema.staffUsers)
        .where(and(
          eq(schema.staffUsers.role, "owner"),
          eq(schema.staffUsers.active, true),
          isNull(schema.staffUsers.removedAt),
        ))
        .orderBy(asc(schema.staffUsers.id))
        .for("update");
      const target = (
        await tx
          .select()
          .from(schema.staffUsers)
          .where(eq(schema.staffUsers.id, input.staffUserId))
          .for("update")
      )[0];
      if (!target || target.removedAt) return { ok: false, error: "Staff user not found" };
      if (target.id === actor.id && !input.active) {
        return { ok: false, error: "You cannot deactivate your own account" };
      }

      const removesActiveOwner =
        target.active && target.role === "owner" && (!input.active || input.role !== "owner");
      if (removesActiveOwner && activeOwners.length <= 1) {
        return { ok: false, error: "At least one active owner account is required" };
      }
      if (target.role === input.role && target.active === input.active) return { ok: true };

      await tx
        .update(schema.staffUsers)
        .set({ role: input.role, active: input.active, updatedAt: new Date() })
        .where(eq(schema.staffUsers.id, target.id));

      let revokedSessions = 0;
      if (target.active && !input.active) {
        const revoked = await tx
          .update(schema.staffSessions)
          .set({ revokedAt: new Date() })
          .where(and(eq(schema.staffSessions.staffUserId, target.id), isNull(schema.staffSessions.revokedAt)))
          .returning({ id: schema.staffSessions.id });
        revokedSessions = revoked.length;
      }

      await audit(tx, {
        actorType: "staff",
        actorId: actor.id,
        action: "staff.updated",
        entityType: "staff_user",
        entityId: target.id,
        before: { role: target.role, active: target.active },
        after: { role: input.role, active: input.active, revokedSessions },
      });
      return { ok: true };
    });

    if (result.ok) revalidatePath("/admin/staff");
    return result;
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, error: err.message };
    console.error("updateStaffAction failed", err);
    return { ok: false, error: "Something went wrong" };
  }
}

export async function resetStaffPasswordAction(raw: unknown): Promise<ActionResult> {
  try {
    const actor = await requireStaff("manage_staff");
    const parsed = resetPasswordSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Password must be between 12 and 200 characters" };
    const input = parsed.data;
    const passwordHash = await hashPassword(input.password);

    const result = await db().transaction(async (tx): Promise<ActionResult> => {
      const target = (
        await tx
          .select({ id: schema.staffUsers.id, removedAt: schema.staffUsers.removedAt })
          .from(schema.staffUsers)
          .where(eq(schema.staffUsers.id, input.staffUserId))
          .for("update")
      )[0];
      if (!target || target.removedAt) return { ok: false, error: "Staff user not found" };

      await tx
        .update(schema.staffUsers)
        .set({ passwordHash, updatedAt: new Date() })
        .where(eq(schema.staffUsers.id, target.id));
      const revoked = await tx
        .update(schema.staffSessions)
        .set({ revokedAt: new Date() })
        .where(and(eq(schema.staffSessions.staffUserId, target.id), isNull(schema.staffSessions.revokedAt)))
        .returning({ id: schema.staffSessions.id });

      await audit(tx, {
        actorType: "staff",
        actorId: actor.id,
        action: "staff.password_reset",
        entityType: "staff_user",
        entityId: target.id,
        after: { revokedSessions: revoked.length },
      });
      return { ok: true };
    });

    if (result.ok) revalidatePath("/admin/staff");
    return result;
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, error: err.message };
    console.error("resetStaffPasswordAction failed", err);
    return { ok: false, error: "Something went wrong" };
  }
}

/**
 * Removes sign-in access without deleting historical staff attribution. The
 * original email is moved onto an inert tombstone so it can be used for a
 * corrected/re-created account immediately.
 */
export async function removeStaffAction(raw: unknown): Promise<ActionResult> {
  try {
    const actor = await requireStaff("manage_staff");
    const parsed = removeStaffSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Invalid staff removal request" };
    const input = parsed.data;

    const result = await db().transaction(async (tx): Promise<ActionResult> => {
      const activeOwners = await tx
        .select({ id: schema.staffUsers.id })
        .from(schema.staffUsers)
        .where(and(
          eq(schema.staffUsers.role, "owner"),
          eq(schema.staffUsers.active, true),
          isNull(schema.staffUsers.removedAt),
        ))
        .orderBy(asc(schema.staffUsers.id))
        .for("update");
      const [target] = await tx
        .select()
        .from(schema.staffUsers)
        .where(eq(schema.staffUsers.id, input.staffUserId))
        .for("update");
      if (!target || target.removedAt) return { ok: false, error: "Staff user not found" };
      if (target.id === actor.id) return { ok: false, error: "You cannot remove your own account" };
      if (target.active && target.role === "owner" && activeOwners.length <= 1) {
        return { ok: false, error: "At least one active owner account is required" };
      }

      const removedAt = new Date();
      const revoked = await tx
        .update(schema.staffSessions)
        .set({ revokedAt: removedAt })
        .where(and(eq(schema.staffSessions.staffUserId, target.id), isNull(schema.staffSessions.revokedAt)))
        .returning({ id: schema.staffSessions.id });
      const removedSchedules = await tx
        .delete(schema.staffSchedules)
        .where(eq(schema.staffSchedules.staffUserId, target.id))
        .returning({ id: schema.staffSchedules.id });
      await tx
        .update(schema.staffUsers)
        .set({
          active: false,
          removedAt,
          email: `removed.${target.id}@deleted.invalid`,
          skills: [],
          updatedAt: removedAt,
        })
        .where(eq(schema.staffUsers.id, target.id));
      await audit(tx, {
        actorType: "staff",
        actorId: actor.id,
        action: "staff.removed",
        entityType: "staff_user",
        entityId: target.id,
        before: {
          name: target.name,
          email: target.email,
          role: target.role,
          active: target.active,
        },
        after: {
          active: false,
          removedAt: removedAt.toISOString(),
          revokedSessions: revoked.length,
          removedSchedules: removedSchedules.length,
        },
      });
      return { ok: true };
    });

    if (result.ok) {
      revalidatePath("/admin/staff");
      revalidatePath("/admin/appointments");
      revalidatePath("/admin/timesheets");
      revalidatePath("/admin/reports/payroll");
    }
    return result;
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, error: err.message };
    console.error("removeStaffAction failed", err);
    return { ok: false, error: "Something went wrong" };
  }
}

/** Owner-managed skill profile and one weekly shift per weekday. */
export async function updateStaffSchedulingAction(raw: unknown): Promise<ActionResult> {
  try {
    const actor = await requireStaff("manage_staff");
    const parsed = staffSchedulingSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Check the skills and weekly shift times" };
    const input = parsed.data;
    if (new Set(input.shifts.map((shift) => shift.weekday)).size !== input.shifts.length) {
      return { ok: false, error: "Only one shift per weekday is supported" };
    }
    if (input.shifts.some((shift) => shift.start >= shift.end)) {
      return { ok: false, error: "Every shift start must be before its end" };
    }
    const skills = [...new Set(input.skills.map((skill) => skill.trim().toLowerCase()).filter(Boolean))].sort();

    const result = await db().transaction(async (tx): Promise<ActionResult> => {
      // Booking assignment also locks active staff rows. Updating the profile
      // under this row lock makes schedule reads and final assignment atomic.
      const [target] = await tx.select().from(schema.staffUsers)
        .where(eq(schema.staffUsers.id, input.staffUserId)).for("update");
      if (!target || target.removedAt) return { ok: false, error: "Staff user not found" };
      const beforeShifts = await tx.select().from(schema.staffSchedules)
        .where(eq(schema.staffSchedules.staffUserId, target.id));

      await tx.update(schema.staffUsers).set({ skills, updatedAt: new Date() })
        .where(eq(schema.staffUsers.id, target.id));
      await tx.delete(schema.staffSchedules).where(eq(schema.staffSchedules.staffUserId, target.id));
      if (input.shifts.length > 0) {
        await tx.insert(schema.staffSchedules).values(input.shifts.map((shift) => ({
          id: newId("sch"),
          staffUserId: target.id,
          weekday: shift.weekday,
          start: shift.start,
          end: shift.end,
        })));
      }
      await audit(tx, {
        actorType: "staff",
        actorId: actor.id,
        action: "staff.scheduling_updated",
        entityType: "staff_user",
        entityId: target.id,
        before: {
          skills: target.skills,
          shifts: beforeShifts.map((shift) => ({ weekday: shift.weekday, start: shift.start, end: shift.end })),
        },
        after: { skills, shifts: input.shifts },
      });
      return { ok: true };
    });
    if (result.ok) {
      revalidatePath("/admin/staff");
      revalidatePath("/admin/appointments");
    }
    return result;
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, error: err.message };
    console.error("updateStaffSchedulingAction failed", err);
    return { ok: false, error: "Something went wrong" };
  }
}

/**
 * Pay type and rates. Owner-only, like every other change on this screen.
 *
 * Changing a rate is deliberately NOT retroactive: `timesheets.pay_earned_cents`
 * was frozen the day each shift was saved, exactly as an invoice freezes its
 * prices, so a raise today cannot rewrite what someone earned last month. Only
 * days recorded from here on use the new rate.
 *
 * All three rate columns are stored whatever the pay type is, so moving someone
 * from hourly to salaried and back does not silently erase their hourly rate.
 * Only the rate the pay type uses is ever read — see computeDayPayCents.
 */
export async function updateStaffPayAction(raw: unknown): Promise<ActionResult> {
  try {
    const actor = await requireStaff("manage_staff");
    const parsed = payTermsSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Check the pay type and rate" };
    const input = parsed.data;
    const problem = validatePayTerms(input);
    if (problem) return { ok: false, error: problem };

    const result = await db().transaction(async (tx): Promise<ActionResult> => {
      const [target] = await tx
        .select()
        .from(schema.staffUsers)
        .where(eq(schema.staffUsers.id, input.staffUserId))
        .for("update");
      if (!target || target.removedAt) return { ok: false, error: "Staff user not found" };

      await tx
        .update(schema.staffUsers)
        .set({
          payType: input.payType,
          hourlyRateCents: input.hourlyRateCents,
          dailyRateCents: input.dailyRateCents,
          monthlySalaryCents: input.monthlySalaryCents,
          updatedAt: new Date(),
        })
        .where(eq(schema.staffUsers.id, target.id));

      await audit(tx, {
        actorType: "staff",
        actorId: actor.id,
        action: "staff.pay_updated",
        entityType: "staff_user",
        entityId: target.id,
        before: {
          payType: target.payType,
          hourlyRateCents: target.hourlyRateCents,
          dailyRateCents: target.dailyRateCents,
          monthlySalaryCents: target.monthlySalaryCents,
        },
        after: {
          payType: input.payType,
          hourlyRateCents: input.hourlyRateCents,
          dailyRateCents: input.dailyRateCents,
          monthlySalaryCents: input.monthlySalaryCents,
        },
      });
      return { ok: true };
    });

    if (result.ok) {
      revalidatePath("/admin/staff");
      revalidatePath("/admin/timesheets");
      revalidatePath("/admin/reports/payroll");
    }
    return result;
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, error: err.message };
    console.error("updateStaffPayAction failed", err);
    return { ok: false, error: "Something went wrong" };
  }
}
