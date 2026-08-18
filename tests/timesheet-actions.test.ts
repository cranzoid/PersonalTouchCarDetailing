import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

const staff = vi.hoisted(() => ({
  id: "usr_timesheet_test_actor",
  name: "Test Owner",
  email: "timesheets@example.com",
  role: "owner" as const,
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({
  requireStaff: vi.fn(async () => staff),
  AuthError: class AuthError extends Error {},
}));

import { db, getPool, schema } from "../src/db";
import { newId } from "../src/lib/id";
import { getPeriodWindow } from "../src/lib/books";
import { getPayrollSnapshot, workDateToUtc } from "../src/lib/payroll";
import { saveTimesheetWeekAction } from "../src/app/admin/(app)/timesheets/actions";

const TZ = "America/Toronto";

let hourlyId: string;
let dailyId: string;

beforeEach(async () => {
  await db().execute(
    `TRUNCATE timesheets, expenses, recurring_bills, expense_categories, invoice_line_items,
     invoice_jobs, payments, invoices, vehicles, customers, audit_log, staff_sessions,
     staff_schedules, staff_users, invoice_counters RESTART IDENTITY CASCADE` as never,
  );
  hourlyId = newId("usr");
  dailyId = newId("usr");
  await db().insert(schema.staffUsers).values([
    { id: staff.id, name: staff.name, email: staff.email, passwordHash: "x", role: "owner" },
    {
      id: hourlyId,
      name: "Ash",
      email: "ash-actions@ptcd.test",
      passwordHash: "x",
      role: "technician",
      payType: "hourly",
      hourlyRateCents: 2_200,
    },
    {
      id: dailyId,
      name: "Bo",
      email: "bo-actions@ptcd.test",
      passwordHash: "x",
      role: "technician",
      payType: "daily_fixed",
      dailyRateCents: 18_000,
    },
  ]);
});

afterAll(async () => {
  await getPool().end();
});

const rows = () => db().select().from(schema.timesheets);

describe("saveTimesheetWeekAction", () => {
  it("freezes the pay it computed from the rate at save time", async () => {
    const result = await saveTimesheetWeekAction({
      entries: [
        { staffUserId: hourlyId, workDate: "2026-08-19", minutes: 480 },
        { staffUserId: dailyId, workDate: "2026-08-19", minutes: 45 },
      ],
    });
    expect(result).toEqual({ ok: true, saved: 2 });

    const saved = await rows();
    const byStaff = new Map(saved.map((row) => [row.staffUserId, row]));
    expect(byStaff.get(hourlyId)!.payEarnedCents).toBe(17_600);
    // 45 minutes is still a whole day at a day rate.
    expect(byStaff.get(dailyId)!.payEarnedCents).toBe(18_000);
    expect(saved.every((row) => row.createdByStaffId === staff.id)).toBe(true);
  });

  it("upserts the same day instead of double-counting it", async () => {
    await saveTimesheetWeekAction({
      entries: [{ staffUserId: hourlyId, workDate: "2026-08-19", minutes: 480 }],
    });
    // The same week saved again from a second phone, with a correction.
    await saveTimesheetWeekAction({
      entries: [{ staffUserId: hourlyId, workDate: "2026-08-19", minutes: 240 }],
    });

    const saved = await rows();
    expect(saved).toHaveLength(1);
    expect(saved[0].minutes).toBe(240);
    expect(saved[0].payEarnedCents).toBe(8_800);
  });

  it("clears a day set back to zero rather than storing an empty shift", async () => {
    await saveTimesheetWeekAction({
      entries: [{ staffUserId: dailyId, workDate: "2026-08-19", minutes: 480 }],
    });
    await saveTimesheetWeekAction({
      entries: [{ staffUserId: dailyId, workDate: "2026-08-19", minutes: 0 }],
    });

    expect(await rows()).toHaveLength(0);
    // A zero row left behind would still read as a day worked, and a day rate
    // pays by the day — the balance would never return to zero.
    const snapshot = await getPayrollSnapshot(getPeriodWindow("month", 2026, 8, TZ));
    expect(snapshot.payroll.lines.find((line) => line.staffUserId === dailyId)!.daysWorked).toBe(0);
    expect(snapshot.payroll.totalEarnedCents).toBe(0);
  });

  it("does not rewrite an earlier day's pay when the rate later changes", async () => {
    await saveTimesheetWeekAction({
      entries: [{ staffUserId: hourlyId, workDate: "2026-08-19", minutes: 480 }],
    });
    await db()
      .update(schema.staffUsers)
      .set({ hourlyRateCents: 3_000 })
      .where(eq(schema.staffUsers.id, hourlyId));

    // A later, unrelated day is saved at the new rate.
    await saveTimesheetWeekAction({
      entries: [{ staffUserId: hourlyId, workDate: "2026-09-02", minutes: 480 }],
    });

    const saved = await rows();
    const august = saved.find((row) => row.workDate.getTime() === workDateToUtc("2026-08-19", TZ).getTime())!;
    const september = saved.find((row) => row.workDate.getTime() === workDateToUtc("2026-09-02", TZ).getTime())!;
    expect(august.payEarnedCents).toBe(17_600); // still $22/h
    expect(september.payEarnedCents).toBe(24_000); // $30/h from here on
  });

  it("rejects a day longer than a day, saving nothing", async () => {
    const result = await saveTimesheetWeekAction({
      entries: [
        { staffUserId: hourlyId, workDate: "2026-08-19", minutes: 480 },
        { staffUserId: hourlyId, workDate: "2026-08-20", minutes: 2_000 },
      ],
    });
    expect(result.ok).toBe(false);
    expect(await rows()).toHaveLength(0);
  });

  it("rejects the same day sent twice in one submission", async () => {
    const result = await saveTimesheetWeekAction({
      entries: [
        { staffUserId: hourlyId, workDate: "2026-08-19", minutes: 480 },
        { staffUserId: hourlyId, workDate: "2026-08-19", minutes: 60 },
      ],
    });
    expect(result).toEqual({ ok: false, error: "The same day was sent twice" });
    expect(await rows()).toHaveLength(0);
  });

  it("rejects an unknown staff member", async () => {
    const result = await saveTimesheetWeekAction({
      entries: [{ staffUserId: "usr_does_not_exist", workDate: "2026-08-19", minutes: 480 }],
    });
    expect(result.ok).toBe(false);
    expect(await rows()).toHaveLength(0);
  });

  it("writes an audit entry for every day it touches", async () => {
    await saveTimesheetWeekAction({
      entries: [
        { staffUserId: hourlyId, workDate: "2026-08-19", minutes: 480 },
        { staffUserId: hourlyId, workDate: "2026-08-20", minutes: 240 },
      ],
    });
    const entries = await db()
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.entityType, "timesheet"));
    expect(entries).toHaveLength(2);
    expect(entries.every((entry) => entry.actorId === staff.id)).toBe(true);
  });
});
