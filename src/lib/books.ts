import { and, asc, desc, eq, gte, isNotNull, isNull, lt, or } from "drizzle-orm";
import { db, schema } from "@/db";
import { newId } from "@/lib/id";
import { getSettings } from "@/lib/settings";
import { zonedToUtc } from "@/lib/tz";

/**
 * The cost side of the business: expenses, recurring bills, and the monthly
 * profit-and-loss that pairs them with invoiced sales.
 *
 * Deliberately separate from src/lib/reporting.ts, which owns the revenue and
 * operations side. The two meet only in computeProfitAndLoss, which takes both
 * as plain arrays — every calculation in this file is pure and unit-tested in
 * tests/books.test.ts, with the database work confined to the loaders at the
 * bottom.
 *
 * ACCOUNTING BASIS (stated on the report screen, because the two halves differ):
 * sales are ACCRUAL — invoices issued in the period, the same set summarizeTax
 * builds an HST return from, so the P&L and the tax report can never disagree.
 * Expenses count on the date they were paid. This mirrors how the shop's
 * spreadsheet already worked and how a small business actually files.
 */

/* ------------------------------------------------------------------ */
/* Calendar periods                                                    */
/* ------------------------------------------------------------------ */

export const PERIOD_KINDS = ["month", "quarter", "year"] as const;
export type PeriodKind = (typeof PERIOD_KINDS)[number];

export type Period = {
  kind: PeriodKind;
  /** Business-local calendar year. */
  year: number;
  /** 1-12 for a month, 1-4 for a quarter, ignored for a year. */
  index: number;
  label: string;
  /** Half-open [start, end) in UTC. */
  start: Date;
  end: Date;
};

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * A whole calendar period in business-local time, as a half-open UTC range.
 *
 * Built on zonedToUtc rather than plain Date arithmetic so a period boundary
 * that lands on a DST change stays a true local midnight — March's window in
 * America/Toronto is 743 hours, not 744, and both ends must still be midnight.
 */
export function getPeriodWindow(
  kind: PeriodKind,
  year: number,
  index: number,
  timeZone: string,
): Period {
  if (!Number.isInteger(year) || year < 2000 || year > 2200) {
    throw new Error("Period year is out of range");
  }
  const midnight = (y: number, m: number) => zonedToUtc(timeZone, y, m, 1, 0, 0);

  if (kind === "year") {
    return {
      kind, year, index: 1,
      label: String(year),
      start: midnight(year, 1),
      end: midnight(year + 1, 1),
    };
  }
  if (kind === "quarter") {
    if (!Number.isInteger(index) || index < 1 || index > 4) throw new Error("Quarter must be 1-4");
    const firstMonth = (index - 1) * 3 + 1;
    const endMonth = firstMonth + 3;
    return {
      kind, year, index,
      label: `Q${index} ${year}`,
      start: midnight(year, firstMonth),
      end: endMonth > 12 ? midnight(year + 1, endMonth - 12) : midnight(year, endMonth),
    };
  }
  if (!Number.isInteger(index) || index < 1 || index > 12) throw new Error("Month must be 1-12");
  return {
    kind, year, index,
    label: `${MONTH_NAMES[index - 1]} ${year}`,
    start: midnight(year, index),
    end: index === 12 ? midnight(year + 1, 1) : midnight(year, index + 1),
  };
}

/** The same period one year earlier, for year-over-year comparison. */
export function priorYearPeriod(period: Period, timeZone: string): Period {
  return getPeriodWindow(period.kind, period.year - 1, period.index, timeZone);
}

/** Business-local "YYYY-MM" for an instant. */
export function monthKey(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit" })
    .formatToParts(date);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}`;
}

/** Every "YYYY-MM" the period touches, in order. */
export function monthKeysInPeriod(period: Period): string[] {
  const count = period.kind === "month" ? 1 : period.kind === "quarter" ? 3 : 12;
  const first = period.kind === "month"
    ? period.index
    : period.kind === "quarter"
      ? (period.index - 1) * 3 + 1
      : 1;
  return Array.from({ length: count }, (_, offset) => {
    const month = first + offset;
    return `${period.year}-${String(month).padStart(2, "0")}`;
  });
}

/* ------------------------------------------------------------------ */
/* Expenses                                                            */
/* ------------------------------------------------------------------ */

export type ExpenseLike = {
  categoryId: string;
  amountCents: number;
  taxPaidCents: number;
};

export type CategoryTotal = {
  categoryId: string;
  name: string;
  isPayroll: boolean;
  amountCents: number;
  taxPaidCents: number;
  count: number;
};

export type ExpenseSummary = {
  totalCents: number;
  /** HST paid on purchases — the input tax credit side of an HST return. */
  inputTaxCreditCents: number;
  count: number;
  byCategory: CategoryTotal[];
};

export function summarizeExpenses(
  rows: readonly ExpenseLike[],
  categories: readonly { id: string; name: string; isPayroll: boolean }[],
): ExpenseSummary {
  const byId = new Map(categories.map((category) => [category.id, category]));
  const totals = new Map<string, CategoryTotal>();

  for (const row of rows) {
    const category = byId.get(row.categoryId);
    const entry = totals.get(row.categoryId) ?? {
      categoryId: row.categoryId,
      // A category can be renamed or deactivated after expenses reference it;
      // the row must still report rather than vanish from the P&L.
      name: category?.name ?? "Uncategorized",
      isPayroll: category?.isPayroll ?? false,
      amountCents: 0,
      taxPaidCents: 0,
      count: 0,
    };
    entry.amountCents += row.amountCents;
    entry.taxPaidCents += row.taxPaidCents;
    entry.count += 1;
    totals.set(row.categoryId, entry);
  }

  const byCategory = [...totals.values()].sort(
    (a, b) => b.amountCents - a.amountCents || a.name.localeCompare(b.name),
  );
  return {
    totalCents: byCategory.reduce((sum, entry) => sum + entry.amountCents, 0),
    inputTaxCreditCents: byCategory.reduce((sum, entry) => sum + entry.taxPaidCents, 0),
    count: rows.length,
    byCategory,
  };
}

/* ------------------------------------------------------------------ */
/* Profit and loss                                                     */
/* ------------------------------------------------------------------ */

/** Statuses that mean an invoice was actually issued — mirrors reporting.ts. */
const ISSUED_INVOICE_STATUSES = new Set(["sent", "partially_paid", "paid", "overdue", "refunded"]);

export type PnlInvoiceLike = {
  status: string;
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
};

export type ProfitAndLoss = {
  /** Invoiced including tax. */
  grossSalesCents: number;
  taxCollectedCents: number;
  /** What the business actually earned: gross less the tax it is holding for the CRA. */
  netSalesCents: number;
  discountsGivenCents: number;
  invoiceCount: number;
  expenses: ExpenseSummary;
  netProfitCents: number;
  /** Null rather than 0 when there were no sales — a margin on nothing is not 0%. */
  profitMargin: number | null;
};

/**
 * Net sales less expenses, per the tracker's Monthly Summary tab.
 *
 * Recurring bills are NOT added separately: the generator has already turned
 * them into real expense rows, so adding them again would double-count. This is
 * the one place the CRM deliberately differs from the spreadsheet's arithmetic.
 */
export function computeProfitAndLoss(
  invoices: readonly PnlInvoiceLike[],
  expenses: ExpenseSummary,
): ProfitAndLoss {
  const issued = invoices.filter((invoice) => ISSUED_INVOICE_STATUSES.has(invoice.status));
  const taxCollectedCents = issued.reduce((sum, invoice) => sum + invoice.taxCents, 0);
  const discountsGivenCents = issued.reduce((sum, invoice) => sum + invoice.discountCents, 0);
  const netSalesCents = issued.reduce(
    (sum, invoice) => sum + invoice.subtotalCents - invoice.discountCents,
    0,
  );
  const netProfitCents = netSalesCents - expenses.totalCents;
  return {
    grossSalesCents: netSalesCents + taxCollectedCents,
    taxCollectedCents,
    netSalesCents,
    discountsGivenCents,
    invoiceCount: issued.length,
    expenses,
    netProfitCents,
    profitMargin: netSalesCents === 0 ? null : netProfitCents / netSalesCents,
  };
}

/** Tax position for a period: what was charged, less what was paid on purchases. */
export type TaxPosition = {
  collectedCents: number;
  inputCreditCents: number;
  /** Negative means a refund is due. */
  netOwingCents: number;
};

export function computeTaxPosition(pnl: ProfitAndLoss): TaxPosition {
  return {
    collectedCents: pnl.taxCollectedCents,
    inputCreditCents: pnl.expenses.inputTaxCreditCents,
    netOwingCents: pnl.taxCollectedCents - pnl.expenses.inputTaxCreditCents,
  };
}

/* ------------------------------------------------------------------ */
/* Recurring bills                                                     */
/* ------------------------------------------------------------------ */

export type RecurringBillLike = {
  id: string;
  active: boolean;
  startMonth: string;
  endMonth: string | null;
};

/**
 * Which bills should have produced an expense row for `month` ("YYYY-MM").
 *
 * String comparison is safe and intentional: zero-padded "YYYY-MM" sorts
 * lexicographically in the same order as chronologically, so no date parsing —
 * and no timezone — is involved in deciding what a month contains.
 */
export function dueRecurringBills<T extends RecurringBillLike>(
  bills: readonly T[],
  month: string,
): T[] {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error(`Invalid month key: ${month}`);
  return bills.filter(
    (bill) =>
      bill.active &&
      bill.startMonth <= month &&
      (bill.endMonth === null || bill.endMonth >= month),
  );
}

/** First business-local day of a "YYYY-MM", as the expense date for generated rows. */
export function monthStartDate(month: string, timeZone: string): Date {
  const [year, index] = month.split("-").map(Number);
  return zonedToUtc(timeZone, year, index, 1, 0, 0);
}

/**
 * The tax hiding inside a tax-INCLUSIVE total, rounded half-up.
 *
 * A supplier receipt shows one number — $113.00 — and the input tax credit
 * needs the $13.00 within it. That is amount x rate / (100% + rate), not
 * amount x rate, which is the single easiest way to overstate a credit.
 */
export function taxIncludedInCents(amountCents: number, taxRateBp: number): number {
  if (amountCents <= 0 || taxRateBp <= 0) return 0;
  return Math.round((amountCents * taxRateBp) / (10_000 + taxRateBp));
}

/* ------------------------------------------------------------------ */
/* Validation (ports the tracker's CHECK columns)                      */
/* ------------------------------------------------------------------ */

export type ExpenseInput = {
  categoryId: string;
  amountCents: number;
  taxPaidCents: number;
  staffUserId: string | null;
};

/**
 * Blocking rules — an expense that fails one cannot be saved. Returns the
 * owner-facing message from the spec's validation table, or null when valid.
 */
export function validateExpenseInput(
  input: ExpenseInput,
  category: { isPayroll: boolean } | undefined,
): string | null {
  if (!category) return "Pick a category";
  if (input.amountCents <= 0) return "Enter an amount";
  // The spreadsheet matched payroll to a typed name in "Paid To", so one typo
  // silently broke the payroll balance. Here it is a staff id or nothing.
  if (category.isPayroll && !input.staffUserId) return "Who was paid?";
  if (input.taxPaidCents < 0) return "Tax paid cannot be negative";
  if (input.taxPaidCents > input.amountCents) return "Tax paid cannot exceed the amount";
  return null;
}

/* ------------------------------------------------------------------ */
/* Loaders                                                             */
/* ------------------------------------------------------------------ */

export type BooksSnapshot = {
  period: Period;
  timezone: string;
  currency: string;
  pnl: ProfitAndLoss;
  tax: TaxPosition;
  /** Same period one year earlier; null when there is nothing to compare to. */
  priorYear: { period: Period; pnl: ProfitAndLoss } | null;
};

/** Invoices are reported against invoice_date, falling back to created_at. */
function invoiceIssuedInWindow(start: Date, end: Date) {
  return or(
    and(
      isNotNull(schema.invoices.invoiceDate),
      gte(schema.invoices.invoiceDate, start),
      lt(schema.invoices.invoiceDate, end),
    ),
    and(
      isNull(schema.invoices.invoiceDate),
      gte(schema.invoices.createdAt, start),
      lt(schema.invoices.createdAt, end),
    ),
  );
}

async function loadPnl(
  start: Date,
  end: Date,
  categories: readonly { id: string; name: string; isPayroll: boolean }[],
): Promise<ProfitAndLoss> {
  const [invoiceRows, expenseRows] = await Promise.all([
    db()
      .select({
        status: schema.invoices.status,
        subtotalCents: schema.invoices.subtotalCents,
        discountCents: schema.invoices.discountCents,
        taxCents: schema.invoices.taxCents,
      })
      .from(schema.invoices)
      .where(invoiceIssuedInWindow(start, end)),
    db()
      .select({
        categoryId: schema.expenses.categoryId,
        amountCents: schema.expenses.amountCents,
        taxPaidCents: schema.expenses.taxPaidCents,
      })
      .from(schema.expenses)
      .where(and(gte(schema.expenses.expenseDate, start), lt(schema.expenses.expenseDate, end))),
  ]);
  return computeProfitAndLoss(invoiceRows, summarizeExpenses(expenseRows, categories));
}

/** One complete P&L + tax position for a calendar period, with YoY comparison. */
export async function getBooksSnapshot(
  kind: PeriodKind,
  year: number,
  index: number,
): Promise<BooksSnapshot> {
  const settings = await getSettings();
  const period = getPeriodWindow(kind, year, index, settings.timezone);
  const categories = await db()
    .select({
      id: schema.expenseCategories.id,
      name: schema.expenseCategories.name,
      isPayroll: schema.expenseCategories.isPayroll,
    })
    .from(schema.expenseCategories);

  const previous = priorYearPeriod(period, settings.timezone);
  const [pnl, priorPnl] = await Promise.all([
    loadPnl(period.start, period.end, categories),
    loadPnl(previous.start, previous.end, categories),
  ]);

  return {
    period,
    timezone: settings.timezone,
    currency: settings.currency,
    pnl,
    tax: computeTaxPosition(pnl),
    // Hide an all-zero prior year rather than showing a meaningless "-100%".
    priorYear:
      priorPnl.invoiceCount === 0 && priorPnl.expenses.count === 0
        ? null
        : { period: previous, pnl: priorPnl },
  };
}

export type ExpenseListRow = {
  id: string;
  expenseDate: Date;
  categoryId: string;
  categoryName: string;
  paidTo: string | null;
  staffUserId: string | null;
  staffName: string | null;
  description: string | null;
  amountCents: number;
  taxPaidCents: number;
  paidBy: string;
  reference: string | null;
  autoGenerated: boolean;
  confirmedAt: Date | null;
  notes: string | null;
};

/** Expenses in a period, newest first, with category and staff names resolved. */
export async function listExpenses(period: Period, categoryId?: string): Promise<ExpenseListRow[]> {
  const rows = await db()
    .select({
      id: schema.expenses.id,
      expenseDate: schema.expenses.expenseDate,
      categoryId: schema.expenses.categoryId,
      categoryName: schema.expenseCategories.name,
      paidTo: schema.expenses.paidTo,
      staffUserId: schema.expenses.staffUserId,
      staffName: schema.staffUsers.name,
      description: schema.expenses.description,
      amountCents: schema.expenses.amountCents,
      taxPaidCents: schema.expenses.taxPaidCents,
      paidBy: schema.expenses.paidBy,
      reference: schema.expenses.reference,
      autoGenerated: schema.expenses.autoGenerated,
      confirmedAt: schema.expenses.confirmedAt,
      notes: schema.expenses.notes,
    })
    .from(schema.expenses)
    .innerJoin(schema.expenseCategories, eq(schema.expenses.categoryId, schema.expenseCategories.id))
    .leftJoin(schema.staffUsers, eq(schema.expenses.staffUserId, schema.staffUsers.id))
    .where(
      and(
        gte(schema.expenses.expenseDate, period.start),
        lt(schema.expenses.expenseDate, period.end),
        ...(categoryId ? [eq(schema.expenses.categoryId, categoryId)] : []),
      ),
    )
    .orderBy(desc(schema.expenses.expenseDate), desc(schema.expenses.createdAt));
  return rows;
}

/** Generated bills for the current month the owner has not ticked off yet. */
export async function listUnconfirmedBills(now = new Date()) {
  const settings = await getSettings();
  const month = monthKey(now, settings.timezone);
  return db()
    .select({
      id: schema.expenses.id,
      name: schema.expenseCategories.name,
      description: schema.expenses.description,
      amountCents: schema.expenses.amountCents,
      expenseDate: schema.expenses.expenseDate,
    })
    .from(schema.expenses)
    .innerJoin(schema.expenseCategories, eq(schema.expenses.categoryId, schema.expenseCategories.id))
    .where(
      and(
        eq(schema.expenses.autoGenerated, true),
        eq(schema.expenses.periodMonth, month),
        isNull(schema.expenses.confirmedAt),
      ),
    )
    .orderBy(asc(schema.expenseCategories.sort), asc(schema.expenses.createdAt));
}

/* ------------------------------------------------------------------ */
/* Monthly bill generation                                             */
/* ------------------------------------------------------------------ */

/**
 * Turns this month's active recurring bills into real `expenses` rows.
 *
 * Called from /api/cron/tick, which runs hourly — so this must be, and is,
 * idempotent. `onConflictDoNothing` against expenses_recurring_period_uq means
 * the second and every later run of a month is a no-op, and two app instances
 * racing produce one row, not two. That guarantee lives in the database rather
 * than in a "have we run this month?" flag that could drift.
 *
 * Rows land unconfirmed: they show on the Home "bills to confirm" card, where
 * the owner adjusts the amount (hydro varies) or deletes one that did not
 * arrive.
 */
export async function generateRecurringBills(now = new Date()): Promise<number> {
  const settings = await getSettings();
  const month = monthKey(now, settings.timezone);
  const bills = await db()
    .select()
    .from(schema.recurringBills)
    .where(eq(schema.recurringBills.active, true));

  const due = dueRecurringBills(bills, month);
  if (due.length === 0) return 0;

  const expenseDate = monthStartDate(month, settings.timezone);
  const inserted = await db()
    .insert(schema.expenses)
    .values(
      due.map((bill) => ({
        id: newId("exp"),
        expenseDate,
        categoryId: bill.categoryId,
        paidTo: bill.name,
        description: bill.name,
        amountCents: bill.amountCents,
        // The generator cannot know the HST on a bill that has not arrived.
        // The owner sets it when confirming, so an unconfirmed bill claims no
        // input tax credit it has not evidenced.
        taxPaidCents: 0,
        paidBy: bill.paidBy,
        autoGenerated: true,
        recurringBillId: bill.id,
        periodMonth: month,
        notes: bill.notes,
      })),
    )
    .onConflictDoNothing({ target: [schema.expenses.recurringBillId, schema.expenses.periodMonth] })
    .returning({ id: schema.expenses.id });

  return inserted.length;
}
