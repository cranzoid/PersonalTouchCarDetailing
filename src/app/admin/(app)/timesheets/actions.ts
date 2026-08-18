"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { audit } from "@/lib/audit";
import { AuthError, requireStaff } from "@/lib/auth/session";
import { newId } from "@/lib/id";
import {
  MAX_TIMESHEET_MINUTES,
  computeDayPayCents,
  validateTimesheetMinutes,
  workDateToUtc,
} from "@/lib/payroll";
import { getSettings } from "@/lib/settings";
import type { PayType } from "@/lib/types";

export type ActionResult = { ok: true; saved: number } | { ok: false; error: string };

/**
 * Hours entry. One row per staff member per day, saved a week at a time from
 * the grid, because that is how the shop actually fills it in — standing at the
 * bay at the end of a shift, not one form submission per person per day.
 */

const dayCell = z.object({
  staffUserId: z.string().min(1),
  workDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  minutes: z.number().int().min(0).max(MAX_TIMESHEET_MINUTES),
  notes: z.string().trim().max(500).optional(),
});

// A week grid is 7 days x however many staff the shop has; 200 is generous
// headroom over that and still bounds a single submission.
const saveInput = z.object({ entries: z.array(dayCell).min(1).max(200) });

/**
 * Save a week of hours.
 *
 * Pay is computed HERE, from the staff member's rate as it stands today, and
 * frozen into the row — the same discipline invoices use for prices. A later
 * raise never rewrites what someone earned last month.
 *
 * Zero minutes deletes the day rather than storing a zero row: an empty cell in
 * the grid means "did not work", and keeping zero rows would make `daysWorked`
 * meaningless for a daily-rate person.
 *
 * The upsert targets the unique index on (staff_user_id, work_date), so two
 * people saving the same week from different phones converge on one row per day
 * instead of double-counting it.
 */
export async function saveTimesheetWeekAction(raw: unknown): Promise<ActionResult> {
  try {
    const actor = await requireStaff("manage_timesheets");
    const parsed = saveInput.safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Check the hours entered" };
    const entries = parsed.data.entries;

    for (const entry of entries) {
      const problem = validateTimesheetMinutes(entry.minutes);
      if (problem) return { ok: false, error: problem };
    }
    const seen = new Set(entries.map((entry) => `${entry.staffUserId}|${entry.workDate}`));
    if (seen.size !== entries.length) return { ok: false, error: "The same day was sent twice" };

    const settings = await getSettings();
    const staffRows = await db()
      .select({
        id: schema.staffUsers.id,
        payType: schema.staffUsers.payType,
        hourlyRateCents: schema.staffUsers.hourlyRateCents,
        dailyRateCents: schema.staffUsers.dailyRateCents,
        monthlySalaryCents: schema.staffUsers.monthlySalaryCents,
      })
      .from(schema.staffUsers);
    const terms = new Map(staffRows.map((row) => [row.id, row]));
    if (entries.some((entry) => !terms.has(entry.staffUserId))) {
      return { ok: false, error: "One of those staff members no longer exists" };
    }

    const changes: { staffUserId: string; workDate: string; minutes: number; payEarnedCents: number }[] = [];
    await db().transaction(async (tx) => {
      for (const entry of entries) {
        const workDate = workDateToUtc(entry.workDate, settings.timezone);
        const person = terms.get(entry.staffUserId)!;

        if (entry.minutes === 0 && !entry.notes) {
          const removed = await tx
            .delete(schema.timesheets)
            .where(
              and(
                eq(schema.timesheets.staffUserId, entry.staffUserId),
                eq(schema.timesheets.workDate, workDate),
              ),
            )
            .returning({ id: schema.timesheets.id, minutes: schema.timesheets.minutes });
          if (removed.length === 0) continue;
          changes.push({ ...entry, payEarnedCents: 0 });
          await audit(tx, {
            actorType: "staff",
            actorId: actor.id,
            action: "timesheet.clear",
            entityType: "timesheet",
            entityId: removed[0].id,
            before: { staffUserId: entry.staffUserId, workDate: entry.workDate, minutes: removed[0].minutes },
          });
          continue;
        }

        const payEarnedCents = computeDayPayCents(
          { ...person, payType: person.payType as PayType },
          entry.minutes,
        );
        const [row] = await tx
          .insert(schema.timesheets)
          .values({
            id: newId("tsh"),
            workDate,
            staffUserId: entry.staffUserId,
            minutes: entry.minutes,
            payEarnedCents,
            notes: entry.notes || null,
            createdByStaffId: actor.id,
          })
          .onConflictDoUpdate({
            target: [schema.timesheets.staffUserId, schema.timesheets.workDate],
            set: {
              minutes: entry.minutes,
              payEarnedCents,
              notes: entry.notes || null,
              updatedAt: new Date(),
            },
          })
          .returning({ id: schema.timesheets.id });

        changes.push({ ...entry, payEarnedCents });
        await audit(tx, {
          actorType: "staff",
          actorId: actor.id,
          action: "timesheet.save",
          entityType: "timesheet",
          entityId: row.id,
          after: {
            staffUserId: entry.staffUserId,
            workDate: entry.workDate,
            minutes: entry.minutes,
            payEarnedCents,
          },
        });
      }
    });

    revalidatePath("/admin/timesheets");
    revalidatePath("/admin/reports/payroll");
    revalidatePath("/admin/reports");
    return { ok: true, saved: changes.length };
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, error: err.message };
    console.error("saveTimesheetWeekAction failed", err);
    return { ok: false, error: "Something went wrong" };
  }
}
