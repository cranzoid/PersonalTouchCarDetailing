import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { eq } from "drizzle-orm";
import { db, getPool, schema } from "../src/db";
import { getPeriodWindow, monthKeysInPeriod } from "../src/lib/books";
import { newId } from "../src/lib/id";
import {
  addDaysISO,
  computeDayPayCents,
  computePayroll,
  formatMinutesAsHours,
  getPayrollSnapshot,
  getTimesheetWeek,
  validatePayTerms,
  validateTimesheetMinutes,
  weekDays,
  weekLabel,
  weekStartISO,
  workDateToUtc,
  type PayrollStaffLike,
} from "../src/lib/payroll";

const TZ = "America/Toronto";

const HOURLY: PayrollStaffLike = {
  id: "usr_hourly",
  name: "Ash",
  active: true,
  payType: "hourly",
  hourlyRateCents: 2_200, // $22.00/h
  dailyRateCents: 0,
  monthlySalaryCents: 0,
};
const DAILY: PayrollStaffLike = {
  id: "usr_daily",
  name: "Bo",
  active: true,
  payType: "daily_fixed",
  hourlyRateCents: 0,
  dailyRateCents: 18_000, // $180.00/day
  monthlySalaryCents: 0,
};
const SALARIED: PayrollStaffLike = {
  id: "usr_salary",
  name: "Cam",
  active: true,
  payType: "monthly_fixed",
  hourlyRateCents: 0,
  dailyRateCents: 0,
  monthlySalaryCents: 300_000, // $3,000.00/month
};

/* ------------------------------------------------------------------ */
/* Per-day pay (spec §4.3)                                             */
/* ------------------------------------------------------------------ */

describe("computeDayPayCents", () => {
  it("pays an hourly worker for the minutes they logged", () => {
    expect(computeDayPayCents(HOURLY, 480)).toBe(17_600); // 8h x $22
    expect(computeDayPayCents(HOURLY, 450)).toBe(16_500); // 7.5h
    expect(computeDayPayCents(HOURLY, 0)).toBe(0);
  });

  it("rounds an awkward hourly split to the cent, once", () => {
    // 25 minutes at $22.00/h is $9.1666…; the cent is decided here, not later.
    expect(computeDayPayCents(HOURLY, 25)).toBe(917);
    // Three such days sum to 2751 cents, not a re-rounded 2750 — rounding
    // happens per day because that is the figure each row freezes.
    expect(computeDayPayCents(HOURLY, 25) * 3).toBe(2_751);
  });

  it("pays a daily-fixed worker the full day rate for any time at all", () => {
    expect(computeDayPayCents(DAILY, 1)).toBe(18_000);
    expect(computeDayPayCents(DAILY, 480)).toBe(18_000);
    expect(computeDayPayCents(DAILY, 720)).toBe(18_000);
    expect(computeDayPayCents(DAILY, 0)).toBe(0);
  });

  it("accrues nothing per day for a monthly salary", () => {
    expect(computeDayPayCents(SALARIED, 480)).toBe(0);
    expect(computeDayPayCents(SALARIED, 0)).toBe(0);
  });

  it("rejects a nonsense day", () => {
    expect(() => computeDayPayCents(HOURLY, -30)).toThrow();
    expect(() => computeDayPayCents(HOURLY, 7.5)).toThrow();
  });

  it("earns nothing when no rate has been entered yet", () => {
    // The migration defaults everyone to hourly at zero, so an owner who has
    // not filled in rates cannot have payroll invented for them.
    const unset = { ...HOURLY, hourlyRateCents: 0 };
    expect(computeDayPayCents(unset, 480)).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* Monthly reconciliation (spec §4.4) and payout (spec §4.6)           */
/* ------------------------------------------------------------------ */

const august = getPeriodWindow("month", 2026, 8, TZ);
const monthsIn = (period: ReturnType<typeof getPeriodWindow>) => monthKeysInPeriod(period).length;

function payrollFor(overrides: Partial<Parameters<typeof computePayroll>[0]> = {}) {
  return computePayroll({
    staff: [HOURLY, DAILY, SALARIED],
    timesheets: [],
    payments: [],
    monthsSpanned: monthsIn(august),
    ...overrides,
  });
}

describe("computePayroll", () => {
  it("splits earnings into timesheet pay and accrued salary", () => {
    const result = payrollFor({
      timesheets: [
        { staffUserId: HOURLY.id, minutes: 480, payEarnedCents: 17_600 },
        { staffUserId: HOURLY.id, minutes: 240, payEarnedCents: 8_800 },
        { staffUserId: DAILY.id, minutes: 300, payEarnedCents: 18_000 },
      ],
    });
    expect(result.earnedVariableCents).toBe(44_400);
    expect(result.accruedFixedCents).toBe(300_000);
    expect(result.totalEarnedCents).toBe(344_400);
    expect(result.paidCents).toBe(0);
    expect(result.varianceCents).toBe(344_400);
  });

  it("accrues a monthly salary in a month with ZERO timesheet rows", () => {
    // The spreadsheet's Monthly Summary!B36 posted the salary only if some row
    // existed for the month, so a quiet month accrued nothing and one job
    // logged on the 2nd accrued the whole $3,000. Both halves are wrong.
    const result = payrollFor({ staff: [SALARIED], timesheets: [] });
    expect(result.accruedFixedCents).toBe(300_000);
    expect(result.totalEarnedCents).toBe(300_000);
    expect(result.lines[0]).toMatchObject({
      staffUserId: SALARIED.id,
      minutes: 0,
      daysWorked: 0,
      earnedCents: 300_000,
    });
  });

  it("accrues the same salary whether one day or twenty were logged", () => {
    const quiet = payrollFor({ staff: [SALARIED] });
    const busy = payrollFor({
      staff: [SALARIED],
      timesheets: Array.from({ length: 20 }, () => ({
        staffUserId: SALARIED.id,
        minutes: 480,
        payEarnedCents: 0,
      })),
    });
    expect(busy.totalEarnedCents).toBe(quiet.totalEarnedCents);
    expect(busy.lines[0].minutes).toBe(9_600);
  });

  it("multiplies a salary by the months a quarter or year covers", () => {
    const quarter = getPeriodWindow("quarter", 2026, 3, TZ);
    const year = getPeriodWindow("year", 2026, 1, TZ);
    expect(payrollFor({ staff: [SALARIED], monthsSpanned: monthsIn(quarter) }).accruedFixedCents).toBe(900_000);
    expect(payrollFor({ staff: [SALARIED], monthsSpanned: monthsIn(year) }).accruedFixedCents).toBe(3_600_000);
  });

  it("stops accruing salary for a deactivated staff member", () => {
    const result = payrollFor({ staff: [{ ...SALARIED, active: false }] });
    expect(result.accruedFixedCents).toBe(0);
  });

  it("returns a zero balance once the payout is recorded", () => {
    const result = payrollFor({
      staff: [HOURLY],
      timesheets: [{ staffUserId: HOURLY.id, minutes: 480, payEarnedCents: 17_600 }],
      payments: [{ staffUserId: HOURLY.id, amountCents: 17_600 }],
    });
    expect(result.lines[0].balanceCents).toBe(0);
    expect(result.varianceCents).toBe(0);
  });

  it("reports a negative variance when someone was paid ahead", () => {
    const result = payrollFor({
      staff: [HOURLY],
      timesheets: [{ staffUserId: HOURLY.id, minutes: 480, payEarnedCents: 17_600 }],
      payments: [{ staffUserId: HOURLY.id, amountCents: 20_000 }],
    });
    expect(result.varianceCents).toBe(-2_400);
  });

  it("matches payouts by staff id, so two people can share a name", () => {
    const twin = { ...HOURLY, id: "usr_twin", name: "Ash" };
    const result = payrollFor({
      staff: [HOURLY, twin],
      timesheets: [
        { staffUserId: HOURLY.id, minutes: 480, payEarnedCents: 17_600 },
        { staffUserId: twin.id, minutes: 480, payEarnedCents: 17_600 },
      ],
      payments: [{ staffUserId: twin.id, amountCents: 17_600 }],
    });
    const byId = new Map(result.lines.map((line) => [line.staffUserId, line]));
    expect(byId.get(HOURLY.id)!.balanceCents).toBe(17_600);
    expect(byId.get(twin.id)!.balanceCents).toBe(0);
  });

  it("counts a payroll expense naming nobody without hiding it", () => {
    const result = payrollFor({
      staff: [HOURLY],
      payments: [{ staffUserId: null, amountCents: 5_000 }],
    });
    expect(result.unassignedPaidCents).toBe(5_000);
    expect(result.paidCents).toBe(5_000);
    expect(result.lines.every((line) => line.paidCents === 0)).toBe(true);
  });

  it("keeps the totals equal to the sum of its lines", () => {
    const result = payrollFor({
      timesheets: [
        { staffUserId: HOURLY.id, minutes: 455, payEarnedCents: 16_683 },
        { staffUserId: DAILY.id, minutes: 60, payEarnedCents: 18_000 },
      ],
      payments: [{ staffUserId: SALARIED.id, amountCents: 150_000 }],
    });
    const sum = (pick: (line: (typeof result.lines)[number]) => number) =>
      result.lines.reduce((total, line) => total + pick(line), 0);
    expect(sum((line) => line.earnedCents)).toBe(result.totalEarnedCents);
    expect(sum((line) => line.paidCents) + result.unassignedPaidCents).toBe(result.paidCents);
    expect(result.totalEarnedCents - result.paidCents).toBe(result.varianceCents);
  });

  it("counts days worked, not rows, for a daily-rate worker", () => {
    const result = payrollFor({
      staff: [DAILY],
      timesheets: [
        { staffUserId: DAILY.id, minutes: 300, payEarnedCents: 18_000 },
        { staffUserId: DAILY.id, minutes: 0, payEarnedCents: 0 },
        { staffUserId: DAILY.id, minutes: 480, payEarnedCents: 18_000 },
      ],
    });
    expect(result.lines[0].daysWorked).toBe(2);
    expect(result.lines[0].earnedCents).toBe(36_000);
  });

  it("rejects a period that spans no month", () => {
    expect(() => payrollFor({ monthsSpanned: 0 })).toThrow();
  });
});

/* ------------------------------------------------------------------ */
/* Validation and formatting                                           */
/* ------------------------------------------------------------------ */

describe("validation", () => {
  it("blocks negative and absurd pay rates", () => {
    expect(validatePayTerms(HOURLY)).toBeNull();
    expect(validatePayTerms({ ...HOURLY, hourlyRateCents: -1 })).toBe("Pay rates cannot be negative");
    expect(validatePayTerms({ ...HOURLY, monthlySalaryCents: 200_000_000 })).toBe("That pay rate looks too large");
  });

  it("blocks a day longer than a day", () => {
    expect(validateTimesheetMinutes(480)).toBeNull();
    expect(validateTimesheetMinutes(1_440)).toBeNull();
    expect(validateTimesheetMinutes(1_441)).toBe("A day cannot be longer than 24 hours");
    expect(validateTimesheetMinutes(-1)).toBe("Enter hours as a number");
  });

  it("shows minutes as the hours the shop says out loud", () => {
    expect(formatMinutesAsHours(480)).toBe("8h");
    expect(formatMinutesAsHours(450)).toBe("7.5h");
    expect(formatMinutesAsHours(0)).toBe("0h");
  });
});

/* ------------------------------------------------------------------ */
/* Calendar helpers                                                    */
/* ------------------------------------------------------------------ */

describe("week helpers", () => {
  it("resolves any day to the Monday that starts its week", () => {
    expect(weekStartISO("2026-08-19")).toBe("2026-08-17"); // Wednesday
    expect(weekStartISO("2026-08-17")).toBe("2026-08-17"); // Monday itself
    expect(weekStartISO("2026-08-23")).toBe("2026-08-17"); // Sunday ends it
  });

  it("enumerates seven days and rolls over a month end", () => {
    expect(weekDays("2026-08-31")).toEqual([
      "2026-08-31", "2026-09-01", "2026-09-02", "2026-09-03",
      "2026-09-04", "2026-09-05", "2026-09-06",
    ]);
  });

  it("steps across the spring-forward without losing a day", () => {
    // 8 March 2026 is the DST change in Toronto; local-time arithmetic here
    // would produce a 23-hour "day" and repeat or skip a date.
    expect(weekDays("2026-03-02")).toEqual([
      "2026-03-02", "2026-03-03", "2026-03-04", "2026-03-05",
      "2026-03-06", "2026-03-07", "2026-03-08",
    ]);
    expect(addDaysISO("2026-03-07", 1)).toBe("2026-03-08");
  });

  it("labels a week, dropping the repeated month", () => {
    expect(weekLabel("2026-08-17")).toBe("17 – 23 Aug 2026");
    expect(weekLabel("2026-08-31")).toBe("31 Aug – 6 Sep 2026");
  });

  it("pins a work date to noon business-local so it cannot drift", () => {
    // Midnight-local would be 04:00 UTC in EDT; noon is unambiguously inside
    // the day whichever way the offset moves.
    expect(workDateToUtc("2026-08-19", TZ).toISOString()).toBe("2026-08-19T16:00:00.000Z");
    expect(workDateToUtc("2026-01-19", TZ).toISOString()).toBe("2026-01-19T17:00:00.000Z");
  });
});

/* ------------------------------------------------------------------ */
/* Against the database                                                */
/* ------------------------------------------------------------------ */

let hourlyId: string;
let salariedId: string;
let payrollCategoryId: string;
let suppliesCategoryId: string;

beforeEach(async () => {
  await db().execute(
    `TRUNCATE timesheets, expenses, recurring_bills, expense_categories, invoice_line_items,
     invoice_jobs, payments, invoices, vehicles, customers, audit_log, staff_sessions,
     staff_schedules, staff_users, invoice_counters RESTART IDENTITY CASCADE` as never,
  );
  hourlyId = newId("usr");
  salariedId = newId("usr");
  await db().insert(schema.staffUsers).values([
    {
      id: hourlyId,
      name: "Ash",
      email: "ash@ptcd.test",
      passwordHash: "x",
      role: "technician",
      payType: "hourly",
      hourlyRateCents: 2_200,
    },
    {
      id: salariedId,
      name: "Cam",
      email: "cam@ptcd.test",
      passwordHash: "x",
      role: "manager",
      payType: "monthly_fixed",
      monthlySalaryCents: 300_000,
    },
  ]);
  payrollCategoryId = newId("exc");
  suppliesCategoryId = newId("exc");
  await db().insert(schema.expenseCategories).values([
    { id: payrollCategoryId, name: "Worker Pay", isPayroll: true, sort: 0 },
    { id: suppliesCategoryId, name: "Vendor / Supplies", isPayroll: false, sort: 1 },
  ]);
});

afterAll(async () => {
  await getPool().end();
});

async function logDay(staffUserId: string, day: string, minutes: number, payEarnedCents: number) {
  await db().insert(schema.timesheets).values({
    id: newId("tsh"),
    workDate: workDateToUtc(day, TZ),
    staffUserId,
    minutes,
    payEarnedCents,
  });
}

describe("timesheets in the database", () => {
  it("rejects a second row for the same person on the same day", async () => {
    await logDay(hourlyId, "2026-08-19", 480, 17_600);
    // Drizzle wraps the driver error, so the constraint is named on the cause.
    const conflict = await logDay(hourlyId, "2026-08-19", 240, 8_800).catch((err) => err);
    expect(conflict).toBeInstanceOf(Error);
    expect(String((conflict as { cause?: unknown }).cause)).toMatch(/timesheets_staff_day_uq/);

    const rows = await db().select().from(schema.timesheets);
    expect(rows).toHaveLength(1);
    expect(rows[0].minutes).toBe(480);
  });

  it("lets two people log the same day", async () => {
    await logDay(hourlyId, "2026-08-19", 480, 17_600);
    await logDay(salariedId, "2026-08-19", 480, 0);
    expect(await db().select().from(schema.timesheets)).toHaveLength(2);
  });

  it("keeps frozen pay when the staff member's rate later changes", async () => {
    await logDay(hourlyId, "2026-08-19", 480, 17_600);

    // Ash gets a raise to $30/h in September.
    await db()
      .update(schema.staffUsers)
      .set({ hourlyRateCents: 3_000 })
      .where(eq(schema.staffUsers.id, hourlyId));

    const snapshot = await getPayrollSnapshot(august);
    const line = snapshot.payroll.lines.find((row) => row.staffUserId === hourlyId)!;
    // Still $176.00 — August's shift was settled at August's rate, exactly the
    // way an invoice keeps the price it was issued at.
    expect(line.variableEarnedCents).toBe(17_600);
    expect(line.earnedCents).toBe(17_600);
  });
});

describe("getPayrollSnapshot", () => {
  it("counts only payroll-category expenses as paid", async () => {
    await logDay(hourlyId, "2026-08-19", 480, 17_600);
    await db().insert(schema.expenses).values([
      {
        id: newId("exp"),
        expenseDate: workDateToUtc("2026-08-20", TZ),
        categoryId: payrollCategoryId,
        staffUserId: hourlyId,
        amountCents: 10_000,
      },
      {
        // Same staff member, but supplies — must not count against wages owed.
        id: newId("exp"),
        expenseDate: workDateToUtc("2026-08-20", TZ),
        categoryId: suppliesCategoryId,
        staffUserId: hourlyId,
        amountCents: 4_000,
      },
    ]);

    const snapshot = await getPayrollSnapshot(august);
    const line = snapshot.payroll.lines.find((row) => row.staffUserId === hourlyId)!;
    expect(line.paidCents).toBe(10_000);
    expect(line.balanceCents).toBe(7_600);
    expect(snapshot.payrollCategories.map((category) => category.id)).toEqual([payrollCategoryId]);
  });

  it("keeps a day at a month boundary in the month it was worked", async () => {
    // 31 Aug at noon Toronto is 1 Sep 00:00 UTC only if the date is mishandled;
    // stored as noon local it stays inside August's window.
    await logDay(hourlyId, "2026-08-31", 480, 17_600);
    await logDay(hourlyId, "2026-09-01", 480, 17_600);

    const augustPayroll = await getPayrollSnapshot(august);
    const september = await getPayrollSnapshot(getPeriodWindow("month", 2026, 9, TZ));
    expect(augustPayroll.payroll.earnedVariableCents).toBe(17_600);
    expect(september.payroll.earnedVariableCents).toBe(17_600);
  });

  it("accrues the salary for a month with no activity at all", async () => {
    const snapshot = await getPayrollSnapshot(getPeriodWindow("month", 2026, 7, TZ));
    expect(snapshot.payroll.accruedFixedCents).toBe(300_000);
    expect(snapshot.payroll.varianceCents).toBe(300_000);
  });
});

describe("getTimesheetWeek", () => {
  it("returns each day under its business-local calendar date", async () => {
    await logDay(hourlyId, "2026-08-17", 480, 17_600);
    await logDay(hourlyId, "2026-08-23", 240, 8_800);
    // The Monday of the next week must not leak into this grid.
    await logDay(hourlyId, "2026-08-24", 480, 17_600);

    const week = await getTimesheetWeek("2026-08-17");
    expect(week.days).toHaveLength(7);
    expect(Object.keys(week.entries[hourlyId])).toEqual(["2026-08-17", "2026-08-23"]);
    expect(week.entries[hourlyId]["2026-08-17"].minutes).toBe(480);
  });
});
