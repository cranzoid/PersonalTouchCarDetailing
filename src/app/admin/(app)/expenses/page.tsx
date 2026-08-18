import { asc, desc } from "drizzle-orm";
import { db, schema } from "@/db";
import { requirePageStaff } from "@/lib/auth/page";
import {
  getPeriodWindow,
  listExpenses,
  summarizeExpenses,
  type PeriodKind,
} from "@/lib/books";
import { getSettings } from "@/lib/settings";
import { localDateISO } from "@/lib/tz";
import { ExpenseManager } from "./expense-manager";

export const dynamic = "force-dynamic";

const KINDS: PeriodKind[] = ["month", "quarter", "year"];

/** Reads the period off the query string, defaulting to the current month. */
function resolvePeriod(
  params: Record<string, string | string[] | undefined>,
  timeZone: string,
) {
  const single = (key: string) => {
    const value = params[key];
    return Array.isArray(value) ? value[0] : value;
  };
  const today = localDateISO(timeZone);
  const [thisYear, thisMonth] = today.split("-").map(Number);

  const kind = KINDS.includes(single("kind") as PeriodKind)
    ? (single("kind") as PeriodKind)
    : "month";
  const year = Number(single("y")) || thisYear;
  const index = Number(single("i")) || (kind === "month" ? thisMonth : kind === "quarter" ? Math.ceil(thisMonth / 3) : 1);
  try {
    return getPeriodWindow(kind, year, index, timeZone);
  } catch {
    return getPeriodWindow("month", thisYear, thisMonth, timeZone);
  }
}

export default async function ExpensesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requirePageStaff("manage_expenses");
  const settings = await getSettings();
  const params = await searchParams;
  const period = resolvePeriod(params, settings.timezone);

  const [categories, staff, rows] = await Promise.all([
    db()
      .select({
        id: schema.expenseCategories.id,
        name: schema.expenseCategories.name,
        isPayroll: schema.expenseCategories.isPayroll,
        active: schema.expenseCategories.active,
      })
      .from(schema.expenseCategories)
      .orderBy(asc(schema.expenseCategories.sort), asc(schema.expenseCategories.name)),
    // Deactivated staff are included: a past payroll expense still points at
    // them, and dropping them from the options would blank the link the moment
    // anyone opened that row to edit it.
    db()
      .select({
        id: schema.staffUsers.id,
        name: schema.staffUsers.name,
        active: schema.staffUsers.active,
      })
      .from(schema.staffUsers)
      .orderBy(desc(schema.staffUsers.active), asc(schema.staffUsers.name)),
    listExpenses(period),
  ]);

  const summary = summarizeExpenses(rows, categories);

  return (
    <ExpenseManager
      period={{
        kind: period.kind,
        year: period.year,
        index: period.index,
        label: period.label,
      }}
      today={localDateISO(settings.timezone)}
      currency={settings.currency}
      taxRateBp={settings.taxRateBp}
      taxLabel={settings.taxLabel}
      timezone={settings.timezone}
      categories={categories}
      staff={staff}
      summary={{
        totalCents: summary.totalCents,
        inputTaxCreditCents: summary.inputTaxCreditCents,
        count: summary.count,
        byCategory: summary.byCategory,
      }}
      expenses={rows.map((row) => ({
        ...row,
        expenseDate: row.expenseDate.toISOString(),
        confirmedAt: row.confirmedAt?.toISOString() ?? null,
      }))}
    />
  );
}
