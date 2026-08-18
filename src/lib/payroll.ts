import { and, asc, eq, gte, lt } from "drizzle-orm";
import { db, schema } from "@/db";
import { monthKeysInPeriod, type Period } from "@/lib/books";
import { getSettings } from "@/lib/settings";
import { zonedToUtc } from "@/lib/tz";
import type { PayType } from "@/lib/types";

/**
 * Labour: what the shop's staff earned, what it has actually paid them, and the
 * difference. The tracker's "Worker Hours" and "Payroll Payout" tabs.
 *
 * Same shape as src/lib/books.ts on purpose — everything above the loaders is
 * pure and unit-tested in tests/payroll.test.ts, with database work confined to
 * the bottom of the file. The two files meet on the Reports screen, where the
 * payroll variance sits under the P&L.
 *
 * WHAT IS EARNED vs WHAT IS PAID. Earned comes from timesheets and salaries;
 * paid comes from `expenses` rows in a category flagged `is_payroll`. Those are
 * two independent records and the report exists to show where they disagree —
 * so nothing here ever writes one from the other. Recording a payout creates a
 * normal expense through the normal expense action.
 *
 * MATCHING IS BY staff_user_id, NEVER BY NAME. The spreadsheet matched payroll
 * on a name typed into "Paid To", so a single typo silently broke the balance
 * and nothing showed that it had.
 */

/* ------------------------------------------------------------------ */
/* Per-day pay                                                         */
/* ------------------------------------------------------------------ */

export type PayTerms = {
  payType: PayType;
  hourlyRateCents: number;
  dailyRateCents: number;
  monthlySalaryCents: number;
};

/**
 * What one day on the shop floor earned, per the spec's §4.3 table.
 *
 * Computed once at save time and frozen into `timesheets.pay_earned_cents`, the
 * same way an invoice snapshots its prices: a raise in October must not rewrite
 * what someone earned in September.
 *
 * `daily_fixed` pays the whole day rate for any time at all — that is the point
 * of a day rate, and the spec is explicit that `minutes > 0` is the test.
 * `monthly_fixed` earns nothing per day; a salary accrues per calendar month
 * whether or not anyone logged hours, which is handled in computePayroll.
 */
export function computeDayPayCents(terms: PayTerms, minutes: number): number {
  if (!Number.isInteger(minutes) || minutes < 0) throw new Error("Minutes must be a whole number of minutes, zero or more");
  if (minutes === 0) return 0;
  switch (terms.payType) {
    case "hourly":
      // minutes / 60 x rate, kept in integer cents and rounded once at the end.
      return Math.round((minutes * terms.hourlyRateCents) / 60);
    case "daily_fixed":
      return terms.dailyRateCents;
    case "monthly_fixed":
      return 0;
  }
}

/**
 * Hours as the shop says them out loud: 450 minutes -> "7.5h", 480 -> "8h".
 * Matches the existing formatHours on the Reports screen, so the two agree.
 */
export function formatMinutesAsHours(minutes: number): string {
  return `${(minutes / 60).toFixed(minutes % 60 === 0 ? 0 : 1)}h`;
}

/* ------------------------------------------------------------------ */
/* Payroll for a period                                                */
/* ------------------------------------------------------------------ */

export type PayrollStaffLike = PayTerms & {
  id: string;
  name: string;
  active: boolean;
};

export type TimesheetLike = {
  staffUserId: string;
  minutes: number;
  payEarnedCents: number;
};

/** A payroll expense row: money that actually left the business. */
export type PayrollPaymentLike = {
  staffUserId: string | null;
  amountCents: number;
};

export type PayrollLine = {
  staffUserId: string;
  name: string;
  active: boolean;
  payType: PayType;
  /** Time logged in the period. Zero for a salary with no timesheet rows. */
  minutes: number;
  /** Days with any time logged — what a `daily_fixed` person is paid for. */
  daysWorked: number;
  /** Frozen timesheet pay in the period. */
  variableEarnedCents: number;
  /** Salary accrued for the calendar months the period covers. */
  fixedAccruedCents: number;
  earnedCents: number;
  paidCents: number;
  /** Positive means the business still owes this person. */
  balanceCents: number;
};

export type PayrollSummary = {
  lines: PayrollLine[];
  /** Timesheet pay: hourly and daily-fixed staff. */
  earnedVariableCents: number;
  /** Monthly salaries accrued over the period. */
  accruedFixedCents: number;
  totalEarnedCents: number;
  paidCents: number;
  /** Positive means wages are still owed; the spec calls this the variance. */
  varianceCents: number;
  /** Payroll expenses that name no staff member, so they match no line. */
  unassignedPaidCents: number;
};

/**
 * The payroll position for a period, per staff member and in total.
 *
 * The totals are the sum of the lines rather than three independent queries, so
 * the "who is owed what" table and the variance under the P&L can never
 * disagree by construction.
 *
 * `monthsSpanned` is how many calendar months the period covers — 1 for a
 * month, 3 for a quarter, 12 for a year — from `monthKeysInPeriod`.
 *
 * FIXES THE SPREADSHEET'S ACCRUAL BUG. `Monthly Summary!B36` posted the entire
 * monthly salary if any single row existed for that month, so one job logged on
 * the 2nd accrued the full $3,000 and a month nobody logged accrued nothing. A
 * salary is owed for the month regardless of what was written down, so it
 * accrues here for every active monthly-fixed staff member, independent of
 * activity. tests/payroll.test.ts pins a month with zero timesheet rows.
 */
export function computePayroll(input: {
  staff: readonly PayrollStaffLike[];
  /** One entry per timesheet row in the period. */
  timesheets: readonly TimesheetLike[];
  /** Expenses in the period whose category is flagged is_payroll. */
  payments: readonly PayrollPaymentLike[];
  monthsSpanned: number;
}): PayrollSummary {
  const { staff, timesheets, payments, monthsSpanned } = input;
  if (!Number.isInteger(monthsSpanned) || monthsSpanned < 1) {
    throw new Error("A period spans at least one calendar month");
  }

  const byStaff = new Map<string, PayrollLine>();
  const lineFor = (person: PayrollStaffLike): PayrollLine => {
    const existing = byStaff.get(person.id);
    if (existing) return existing;
    // An inactive monthly-fixed person accrues nothing further: the salary is
    // the cost of employing them, and they are no longer employed. Their past
    // timesheets and payouts still report below.
    const fixedAccruedCents =
      person.payType === "monthly_fixed" && person.active
        ? person.monthlySalaryCents * monthsSpanned
        : 0;
    const line: PayrollLine = {
      staffUserId: person.id,
      name: person.name,
      active: person.active,
      payType: person.payType,
      minutes: 0,
      daysWorked: 0,
      variableEarnedCents: 0,
      fixedAccruedCents,
      earnedCents: fixedAccruedCents,
      paidCents: 0,
      balanceCents: fixedAccruedCents,
    };
    byStaff.set(person.id, line);
    return line;
  };

  for (const person of staff) lineFor(person);

  for (const row of timesheets) {
    const line = byStaff.get(row.staffUserId);
    // A timesheet always references a real staff row (foreign key), so a miss
    // here means the caller filtered the staff list. Skipping keeps the totals
    // honest for the people it did ask about.
    if (!line) continue;
    line.minutes += row.minutes;
    if (row.minutes > 0) line.daysWorked += 1;
    line.variableEarnedCents += row.payEarnedCents;
  }

  let unassignedPaidCents = 0;
  for (const payment of payments) {
    const line = payment.staffUserId ? byStaff.get(payment.staffUserId) : undefined;
    if (!line) {
      // A payroll expense with no staff member cannot be attributed to anyone.
      // validateExpenseInput blocks creating one, so this is legacy or edited
      // data — surfaced rather than silently dropped from the total paid.
      unassignedPaidCents += payment.amountCents;
      continue;
    }
    line.paidCents += payment.amountCents;
  }

  const lines = [...byStaff.values()].map((line) => {
    const earnedCents = line.variableEarnedCents + line.fixedAccruedCents;
    return { ...line, earnedCents, balanceCents: earnedCents - line.paidCents };
  });

  // Owed first, then the busiest — the report is read to decide who to pay.
  lines.sort(
    (a, b) =>
      Number(b.active) - Number(a.active) ||
      b.balanceCents - a.balanceCents ||
      a.name.localeCompare(b.name),
  );

  const sum = (pick: (line: PayrollLine) => number) =>
    lines.reduce((total, line) => total + pick(line), 0);
  const earnedVariableCents = sum((line) => line.variableEarnedCents);
  const accruedFixedCents = sum((line) => line.fixedAccruedCents);
  const totalEarnedCents = earnedVariableCents + accruedFixedCents;
  const paidCents = sum((line) => line.paidCents) + unassignedPaidCents;

  return {
    lines,
    earnedVariableCents,
    accruedFixedCents,
    totalEarnedCents,
    paidCents,
    varianceCents: totalEarnedCents - paidCents,
    unassignedPaidCents,
  };
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

export type PayTermsInput = PayTerms;

/**
 * Blocking rules for a staff member's pay terms, in the owner's words.
 *
 * Only the rate the pay type actually uses is checked. The other two columns
 * keep whatever was last entered so switching a person from hourly to salaried
 * and back does not silently erase their hourly rate.
 */
export function validatePayTerms(input: PayTermsInput): string | null {
  const rates = [input.hourlyRateCents, input.dailyRateCents, input.monthlySalaryCents];
  if (rates.some((rate) => !Number.isInteger(rate) || rate < 0)) {
    return "Pay rates cannot be negative";
  }
  if (rates.some((rate) => rate > 100_000_000)) return "That pay rate looks too large";
  return null;
}

/** The maximum minutes a single day can hold, so a typo cannot book 400 hours. */
export const MAX_TIMESHEET_MINUTES = 24 * 60;

export function validateTimesheetMinutes(minutes: number): string | null {
  if (!Number.isInteger(minutes) || minutes < 0) return "Enter hours as a number";
  if (minutes > MAX_TIMESHEET_MINUTES) return "A day cannot be longer than 24 hours";
  return null;
}

/* ------------------------------------------------------------------ */
/* Days                                                                */
/* ------------------------------------------------------------------ */

/**
 * A calendar day as the instant stored in `timesheets.work_date`.
 *
 * Noon business-local, matching `expenses.expense_date`: it sits unambiguously
 * inside the day in UTC, cannot drift into the neighbouring day at a period
 * boundary, and is deterministic — which is what lets the unique index on
 * (staff_user_id, work_date) actually mean "one row per person per day".
 */
export function workDateToUtc(day: string, timeZone: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`Invalid work date: ${day}`);
  const [year, month, date] = day.split("-").map(Number);
  return zonedToUtc(timeZone, year, month, date, 12, 0);
}

/**
 * Calendar-date arithmetic on a bare "YYYY-MM-DD".
 *
 * Deliberately UTC: no timezone is involved in "the day after Monday", and
 * doing this in local time would drop or repeat a day at a DST boundary. The
 * business timezone only enters when a date becomes an instant, in
 * workDateToUtc.
 */
export function addDaysISO(dayISO: string, days: number): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dayISO)) throw new Error(`Invalid date: ${dayISO}`);
  const [year, month, day] = dayISO.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/** The seven "YYYY-MM-DD" days of the week beginning `mondayISO`. */
export function weekDays(mondayISO: string): string[] {
  return Array.from({ length: 7 }, (_, offset) => addDaysISO(mondayISO, offset));
}

/** The Monday on or before `dayISO`, so any date resolves to one week grid. */
export function weekStartISO(dayISO: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dayISO)) throw new Error(`Invalid date: ${dayISO}`);
  // getUTCDay is 0 for Sunday, which is 6 days after the Monday that starts it.
  const weekday = new Date(`${dayISO}T00:00:00Z`).getUTCDay();
  return addDaysISO(dayISO, -((weekday + 6) % 7));
}

const SHORT_MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/**
 * A readable "17 – 23 Aug 2026" for a week grid header, dropping the month when
 * both ends share it.
 *
 * Assembled by hand rather than through Intl: en-CA formats a day-and-month as
 * "Aug 23", which reads badly on the left of a range, and the parts are just a
 * number and a month name.
 */
export function weekLabel(mondayISO: string): string {
  const days = weekDays(mondayISO);
  const part = (iso: string) => {
    const [year, month, day] = iso.split("-").map(Number);
    return { year, month: SHORT_MONTHS[month - 1], day };
  };
  const start = part(days[0]);
  const end = part(days[6]);
  const from = start.month === end.month ? `${start.day}` : `${start.day} ${start.month}`;
  return `${from} – ${end.day} ${end.month} ${end.year}`;
}

/* ------------------------------------------------------------------ */
/* Loaders                                                             */
/* ------------------------------------------------------------------ */

/** Staff with their pay terms, active first. Inactive rows are kept: a past
 * payroll expense still points at them and must keep reporting. */
export async function listPayrollStaff(): Promise<PayrollStaffLike[]> {
  const rows = await db()
    .select({
      id: schema.staffUsers.id,
      name: schema.staffUsers.name,
      active: schema.staffUsers.active,
      payType: schema.staffUsers.payType,
      hourlyRateCents: schema.staffUsers.hourlyRateCents,
      dailyRateCents: schema.staffUsers.dailyRateCents,
      monthlySalaryCents: schema.staffUsers.monthlySalaryCents,
    })
    .from(schema.staffUsers)
    .orderBy(asc(schema.staffUsers.name));
  return rows.map((row) => ({ ...row, payType: row.payType as PayType }));
}

export type PayrollSnapshot = {
  period: Period;
  timezone: string;
  currency: string;
  payroll: PayrollSummary;
  /** Payroll categories a payout can be booked to, for the "Record payout" form. */
  payrollCategories: { id: string; name: string }[];
};

/** Timesheet pay, salary accrual and payroll expenses for one calendar period. */
export async function getPayrollSnapshot(period: Period): Promise<PayrollSnapshot> {
  const settings = await getSettings();
  const [staff, timesheetRows, paymentRows, payrollCategories] = await Promise.all([
    listPayrollStaff(),
    db()
      .select({
        staffUserId: schema.timesheets.staffUserId,
        minutes: schema.timesheets.minutes,
        payEarnedCents: schema.timesheets.payEarnedCents,
      })
      .from(schema.timesheets)
      .where(
        and(gte(schema.timesheets.workDate, period.start), lt(schema.timesheets.workDate, period.end)),
      ),
    // Paid is "expenses in a payroll category", exactly as the P&L counts them,
    // so the payroll block and the expense block cannot tell different stories.
    db()
      .select({
        staffUserId: schema.expenses.staffUserId,
        amountCents: schema.expenses.amountCents,
      })
      .from(schema.expenses)
      .innerJoin(
        schema.expenseCategories,
        eq(schema.expenses.categoryId, schema.expenseCategories.id),
      )
      .where(
        and(
          eq(schema.expenseCategories.isPayroll, true),
          gte(schema.expenses.expenseDate, period.start),
          lt(schema.expenses.expenseDate, period.end),
        ),
      ),
    db()
      .select({ id: schema.expenseCategories.id, name: schema.expenseCategories.name })
      .from(schema.expenseCategories)
      .where(
        and(eq(schema.expenseCategories.isPayroll, true), eq(schema.expenseCategories.active, true)),
      )
      .orderBy(asc(schema.expenseCategories.sort), asc(schema.expenseCategories.name)),
  ]);

  return {
    period,
    timezone: settings.timezone,
    currency: settings.currency,
    payroll: computePayroll({
      staff,
      timesheets: timesheetRows,
      payments: paymentRows,
      monthsSpanned: monthKeysInPeriod(period).length,
    }),
    payrollCategories,
  };
}

export type TimesheetCell = { minutes: number; payEarnedCents: number; notes: string | null };
export type TimesheetWeek = {
  weekStart: string;
  days: string[];
  staff: PayrollStaffLike[];
  /** `entries[staffUserId][dayISO]`, present only for days already recorded. */
  entries: Record<string, Record<string, TimesheetCell>>;
};

/** One week of the hours grid: every staff member, seven days, what is on file. */
export async function getTimesheetWeek(mondayISO: string): Promise<TimesheetWeek> {
  const settings = await getSettings();
  const days = weekDays(mondayISO);
  const start = workDateToUtc(days[0], settings.timezone);
  // Half-open up to noon on the Monday after: contains every noon-local instant
  // in the week and nothing outside it, whatever DST does in between.
  const end = workDateToUtc(addDaysISO(days[6], 1), settings.timezone);

  const [staff, rows] = await Promise.all([
    listPayrollStaff(),
    db()
      .select({
        staffUserId: schema.timesheets.staffUserId,
        workDate: schema.timesheets.workDate,
        minutes: schema.timesheets.minutes,
        payEarnedCents: schema.timesheets.payEarnedCents,
        notes: schema.timesheets.notes,
      })
      .from(schema.timesheets)
      .where(and(gte(schema.timesheets.workDate, start), lt(schema.timesheets.workDate, end))),
  ]);

  const entries: Record<string, Record<string, TimesheetCell>> = {};
  const dayOf = new Intl.DateTimeFormat("en-CA", {
    timeZone: settings.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  for (const row of rows) {
    const day = dayOf.format(row.workDate);
    entries[row.staffUserId] ??= {};
    entries[row.staffUserId][day] = {
      minutes: row.minutes,
      payEarnedCents: row.payEarnedCents,
      notes: row.notes,
    };
  }

  return { weekStart: days[0], days, staff, entries };
}
