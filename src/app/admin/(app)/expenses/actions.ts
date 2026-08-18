"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { and, eq, isNull } from "drizzle-orm";
import { db, schema } from "@/db";
import { audit } from "@/lib/audit";
import { requireStaff } from "@/lib/auth/session";
import { validateExpenseInput } from "@/lib/books";
import { newId } from "@/lib/id";
import { getSettings } from "@/lib/settings";
import { zonedToUtc } from "@/lib/tz";
import { EXPENSE_PAYMENT_METHODS } from "@/lib/types";

export type ActionResult = { ok: true } | { ok: false; error: string };

/**
 * Expense entry. Every write is audited, and the blocking rules live in the
 * pure validateExpenseInput so the form and the server agree on the wording the
 * owner sees.
 */

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a date");

const expenseFields = {
  expenseDate: dateSchema,
  categoryId: z.string().min(1),
  paidTo: z.string().trim().max(200).optional(),
  staffUserId: z.string().min(1).nullable().optional(),
  description: z.string().trim().max(500).optional(),
  amountCents: z.number().int().min(0).max(100_000_000),
  taxPaidCents: z.number().int().min(0).max(100_000_000),
  paidBy: z.enum(EXPENSE_PAYMENT_METHODS),
  reference: z.string().trim().max(120).optional(),
  notes: z.string().trim().max(1000).optional(),
};

const createInput = z.object(expenseFields);
const updateInput = z.object({ ...expenseFields, expenseId: z.string().min(1) });

/**
 * A date input gives a calendar day with no time. Noon business-local puts the
 * row unambiguously inside that day in UTC, so it cannot drift into the
 * neighbouring month at a period boundary.
 */
function expenseDateToUtc(day: string, timeZone: string): Date {
  const [year, month, date] = day.split("-").map(Number);
  return zonedToUtc(timeZone, year, month, date, 12, 0);
}

async function loadCategory(categoryId: string) {
  const [category] = await db()
    .select()
    .from(schema.expenseCategories)
    .where(eq(schema.expenseCategories.id, categoryId))
    .limit(1);
  return category;
}

function revalidate() {
  revalidatePath("/admin/expenses");
  revalidatePath("/admin/reports");
  revalidatePath("/admin");
}

export async function createExpenseAction(raw: unknown): Promise<ActionResult> {
  try {
    const staff = await requireStaff("manage_expenses");
    const parsed = createInput.safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Please check the expense details" };
    const input = parsed.data;

    const category = await loadCategory(input.categoryId);
    const problem = validateExpenseInput(
      { ...input, staffUserId: input.staffUserId ?? null },
      category,
    );
    if (problem) return { ok: false, error: problem };

    const settings = await getSettings();
    const id = newId("exp");
    await db().transaction(async (tx) => {
      await tx.insert(schema.expenses).values({
        id,
        expenseDate: expenseDateToUtc(input.expenseDate, settings.timezone),
        categoryId: input.categoryId,
        paidTo: input.paidTo || null,
        staffUserId: input.staffUserId ?? null,
        description: input.description || null,
        amountCents: input.amountCents,
        taxPaidCents: input.taxPaidCents,
        paidBy: input.paidBy,
        reference: input.reference || null,
        notes: input.notes || null,
        createdByStaffId: staff.id,
      });
      await audit(tx, {
        actorType: "staff",
        actorId: staff.id,
        action: "expense.create",
        entityType: "expense",
        entityId: id,
        after: { ...input, categoryName: category?.name },
      });
    });

    revalidate();
    return { ok: true };
  } catch (err) {
    console.error("createExpenseAction failed", err);
    return { ok: false, error: "Something went wrong" };
  }
}

export async function updateExpenseAction(raw: unknown): Promise<ActionResult> {
  try {
    const staff = await requireStaff("manage_expenses");
    const parsed = updateInput.safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Please check the expense details" };
    const input = parsed.data;

    const category = await loadCategory(input.categoryId);
    const problem = validateExpenseInput(
      { ...input, staffUserId: input.staffUserId ?? null },
      category,
    );
    if (problem) return { ok: false, error: problem };

    const settings = await getSettings();
    const result = await db().transaction(async (tx): Promise<ActionResult> => {
      const [before] = await tx
        .select()
        .from(schema.expenses)
        .where(eq(schema.expenses.id, input.expenseId))
        .limit(1);
      if (!before) return { ok: false, error: "That expense no longer exists" };

      await tx
        .update(schema.expenses)
        .set({
          expenseDate: expenseDateToUtc(input.expenseDate, settings.timezone),
          categoryId: input.categoryId,
          paidTo: input.paidTo || null,
          staffUserId: input.staffUserId ?? null,
          description: input.description || null,
          amountCents: input.amountCents,
          taxPaidCents: input.taxPaidCents,
          paidBy: input.paidBy,
          reference: input.reference || null,
          notes: input.notes || null,
          // Editing a generated bill is the owner confirming it: they have the
          // real figure in front of them, so it should leave the "to confirm"
          // card rather than sit there after being corrected.
          confirmedAt: before.autoGenerated ? (before.confirmedAt ?? new Date()) : before.confirmedAt,
          confirmedByStaffId: before.autoGenerated ? (before.confirmedByStaffId ?? staff.id) : before.confirmedByStaffId,
          updatedAt: new Date(),
        })
        .where(eq(schema.expenses.id, input.expenseId));

      await audit(tx, {
        actorType: "staff",
        actorId: staff.id,
        action: "expense.update",
        entityType: "expense",
        entityId: input.expenseId,
        before,
        after: input,
      });
      return { ok: true };
    });

    revalidate();
    return result;
  } catch (err) {
    console.error("updateExpenseAction failed", err);
    return { ok: false, error: "Something went wrong" };
  }
}

/**
 * A real DELETE, unlike invoices and payments. An expense is internal
 * bookkeeping rather than a document issued to a customer, and the owners
 * expect a mistyped row to disappear the way a spreadsheet row does. The whole
 * row goes into audit_log.before first, so the ledger stays reconstructible.
 */
export async function deleteExpenseAction(raw: unknown): Promise<ActionResult> {
  try {
    const staff = await requireStaff("manage_expenses");
    const parsed = z.object({ expenseId: z.string().min(1) }).safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Please pick an expense" };

    const result = await db().transaction(async (tx): Promise<ActionResult> => {
      const [before] = await tx
        .select()
        .from(schema.expenses)
        .where(eq(schema.expenses.id, parsed.data.expenseId))
        .limit(1);
      if (!before) return { ok: false, error: "That expense no longer exists" };

      await audit(tx, {
        actorType: "staff",
        actorId: staff.id,
        action: "expense.delete",
        entityType: "expense",
        entityId: before.id,
        before,
      });
      await tx.delete(schema.expenses).where(eq(schema.expenses.id, before.id));
      return { ok: true };
    });

    revalidate();
    return result;
  } catch (err) {
    console.error("deleteExpenseAction failed", err);
    return { ok: false, error: "Something went wrong" };
  }
}

/** Ticks a generated bill off the Home card without changing its amount. */
export async function confirmBillsAction(raw: unknown): Promise<ActionResult> {
  try {
    const staff = await requireStaff("manage_expenses");
    const parsed = z
      .object({ expenseIds: z.array(z.string().min(1)).min(1).max(100) })
      .safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Nothing to confirm" };

    const now = new Date();
    await db().transaction(async (tx) => {
      for (const expenseId of parsed.data.expenseIds) {
        const updated = await tx
          .update(schema.expenses)
          .set({ confirmedAt: now, confirmedByStaffId: staff.id, updatedAt: now })
          .where(and(eq(schema.expenses.id, expenseId), isNull(schema.expenses.confirmedAt)))
          .returning({ id: schema.expenses.id });
        if (updated.length === 0) continue;
        await audit(tx, {
          actorType: "staff",
          actorId: staff.id,
          action: "expense.confirm",
          entityType: "expense",
          entityId: expenseId,
          after: { confirmedAt: now.toISOString() },
        });
      }
    });

    revalidate();
    return { ok: true };
  } catch (err) {
    console.error("confirmBillsAction failed", err);
    return { ok: false, error: "Something went wrong" };
  }
}
