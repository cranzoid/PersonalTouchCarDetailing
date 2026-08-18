import Link from "next/link";
import { asc } from "drizzle-orm";
import { db, schema } from "@/db";
import { requirePageStaff } from "@/lib/auth/page";
import { monthKey } from "@/lib/books";
import { getSettings } from "@/lib/settings";
import { BookkeepingManager } from "./bookkeeping-manager";

export const dynamic = "force-dynamic";

export default async function BookkeepingSettingsPage() {
  await requirePageStaff("manage_expenses");
  const settings = await getSettings();

  const [categories, bills] = await Promise.all([
    db()
      .select()
      .from(schema.expenseCategories)
      .orderBy(asc(schema.expenseCategories.sort), asc(schema.expenseCategories.name)),
    db().select().from(schema.recurringBills).orderBy(asc(schema.recurringBills.name)),
  ]);

  return (
    <div className="max-w-5xl">
      <h1 className="text-2xl font-bold text-white">Expense categories &amp; monthly bills</h1>
      <p className="mt-1 text-sm text-ink-400">
        How spending is sorted on the{" "}
        <Link href="/admin/expenses" className="text-accent-300 hover:underline">
          Expenses
        </Link>{" "}
        screen and in Reports. Everything here is yours to rename, add to and switch off — changes
        are audited.
      </p>

      <BookkeepingManager
        currency={settings.currency}
        thisMonth={monthKey(new Date(), settings.timezone)}
        categories={categories.map((category) => ({
          id: category.id,
          name: category.name,
          isPayroll: category.isPayroll,
          active: category.active,
        }))}
        bills={bills.map((bill) => ({
          id: bill.id,
          name: bill.name,
          categoryId: bill.categoryId,
          amountCents: bill.amountCents,
          startMonth: bill.startMonth,
          endMonth: bill.endMonth,
          paidBy: bill.paidBy,
          active: bill.active,
          notes: bill.notes,
        }))}
      />
    </div>
  );
}
