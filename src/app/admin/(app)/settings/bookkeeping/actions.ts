"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { audit } from "@/lib/audit";
import { requireStaff } from "@/lib/auth/session";
import { newId } from "@/lib/id";
import { EXPENSE_PAYMENT_METHODS } from "@/lib/types";

export type ActionResult = { ok: true } | { ok: false; error: string };

/**
 * Owner-editable bookkeeping configuration: the expense categories money is
 * sorted into, and the bills that repeat every month.
 *
 * Categories are never deleted — expenses reference them, and removing one
 * would orphan history. Deactivating hides it from the picker while every past
 * expense keeps reporting under its name.
 */

const monthSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Use a month like 2026-08");

function revalidate() {
  revalidatePath("/admin/settings/bookkeeping");
  revalidatePath("/admin/expenses");
  revalidatePath("/admin/reports");
  revalidatePath("/admin");
}

/* ---------------------------- categories ---------------------------- */

export async function createExpenseCategoryAction(raw: unknown): Promise<ActionResult> {
  try {
    const staff = await requireStaff("manage_expenses");
    const parsed = z
      .object({
        name: z.string().trim().min(1).max(120),
        isPayroll: z.boolean(),
      })
      .safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Give the category a name" };

    const id = newId("exc");
    await db().transaction(async (tx) => {
      const [{ next }] = await tx
        .select({ next: sql<number>`coalesce(max(${schema.expenseCategories.sort}), -1) + 1` })
        .from(schema.expenseCategories);
      await tx.insert(schema.expenseCategories).values({
        id,
        name: parsed.data.name,
        isPayroll: parsed.data.isPayroll,
        sort: next,
      });
      await audit(tx, {
        actorType: "staff",
        actorId: staff.id,
        action: "expense_category.create",
        entityType: "expense_category",
        entityId: id,
        after: parsed.data,
      });
    });

    revalidate();
    return { ok: true };
  } catch (err) {
    console.error("createExpenseCategoryAction failed", err);
    return { ok: false, error: "Something went wrong" };
  }
}

export async function updateExpenseCategoryAction(raw: unknown): Promise<ActionResult> {
  try {
    const staff = await requireStaff("manage_expenses");
    const parsed = z
      .object({
        categoryId: z.string().min(1),
        name: z.string().trim().min(1).max(120),
        isPayroll: z.boolean(),
        active: z.boolean(),
      })
      .safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Please check the category" };
    const input = parsed.data;

    const result = await db().transaction(async (tx): Promise<ActionResult> => {
      const [before] = await tx
        .select()
        .from(schema.expenseCategories)
        .where(eq(schema.expenseCategories.id, input.categoryId))
        .limit(1);
      if (!before) return { ok: false, error: "That category no longer exists" };

      await tx
        .update(schema.expenseCategories)
        .set({
          name: input.name,
          isPayroll: input.isPayroll,
          active: input.active,
          updatedAt: new Date(),
        })
        .where(eq(schema.expenseCategories.id, input.categoryId));
      await audit(tx, {
        actorType: "staff",
        actorId: staff.id,
        action: "expense_category.update",
        entityType: "expense_category",
        entityId: input.categoryId,
        before,
        after: input,
      });
      return { ok: true };
    });

    revalidate();
    return result;
  } catch (err) {
    console.error("updateExpenseCategoryAction failed", err);
    return { ok: false, error: "Something went wrong" };
  }
}

/* -------------------------- recurring bills -------------------------- */

const billFields = {
  name: z.string().trim().min(1).max(120),
  categoryId: z.string().min(1),
  amountCents: z.number().int().min(0).max(100_000_000),
  startMonth: monthSchema,
  endMonth: monthSchema.nullable().optional(),
  paidBy: z.enum(EXPENSE_PAYMENT_METHODS),
  active: z.boolean(),
  notes: z.string().trim().max(500).optional(),
};

/** A bill that ends before it starts would silently never generate. */
function monthOrderProblem(startMonth: string, endMonth?: string | null): string | null {
  return endMonth && endMonth < startMonth ? "The end month is before the start month" : null;
}

export async function createRecurringBillAction(raw: unknown): Promise<ActionResult> {
  try {
    const staff = await requireStaff("manage_expenses");
    const parsed = z.object(billFields).safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Please check the bill details" };
    const input = parsed.data;
    const problem = monthOrderProblem(input.startMonth, input.endMonth);
    if (problem) return { ok: false, error: problem };

    const id = newId("rbl");
    await db().transaction(async (tx) => {
      await tx.insert(schema.recurringBills).values({
        id,
        name: input.name,
        categoryId: input.categoryId,
        amountCents: input.amountCents,
        startMonth: input.startMonth,
        endMonth: input.endMonth ?? null,
        paidBy: input.paidBy,
        active: input.active,
        notes: input.notes || null,
      });
      await audit(tx, {
        actorType: "staff",
        actorId: staff.id,
        action: "recurring_bill.create",
        entityType: "recurring_bill",
        entityId: id,
        after: input,
      });
    });

    revalidate();
    return { ok: true };
  } catch (err) {
    console.error("createRecurringBillAction failed", err);
    return { ok: false, error: "Something went wrong" };
  }
}

export async function updateRecurringBillAction(raw: unknown): Promise<ActionResult> {
  try {
    const staff = await requireStaff("manage_expenses");
    const parsed = z.object({ ...billFields, billId: z.string().min(1) }).safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Please check the bill details" };
    const input = parsed.data;
    const problem = monthOrderProblem(input.startMonth, input.endMonth);
    if (problem) return { ok: false, error: problem };

    const result = await db().transaction(async (tx): Promise<ActionResult> => {
      const [before] = await tx
        .select()
        .from(schema.recurringBills)
        .where(eq(schema.recurringBills.id, input.billId))
        .limit(1);
      if (!before) return { ok: false, error: "That bill no longer exists" };

      await tx
        .update(schema.recurringBills)
        .set({
          name: input.name,
          categoryId: input.categoryId,
          amountCents: input.amountCents,
          startMonth: input.startMonth,
          endMonth: input.endMonth ?? null,
          paidBy: input.paidBy,
          active: input.active,
          notes: input.notes || null,
          updatedAt: new Date(),
        })
        .where(eq(schema.recurringBills.id, input.billId));
      await audit(tx, {
        actorType: "staff",
        actorId: staff.id,
        action: "recurring_bill.update",
        entityType: "recurring_bill",
        entityId: input.billId,
        before,
        after: input,
      });
      return { ok: true };
    });

    revalidate();
    return result;
  } catch (err) {
    console.error("updateRecurringBillAction failed", err);
    return { ok: false, error: "Something went wrong" };
  }
}

/**
 * Stopping a bill sets an end month rather than deleting the row: the expenses
 * it already generated point at it, and the history of what the shop used to
 * pay is worth keeping.
 */
export async function stopRecurringBillAction(raw: unknown): Promise<ActionResult> {
  try {
    const staff = await requireStaff("manage_expenses");
    const parsed = z
      .object({ billId: z.string().min(1), endMonth: monthSchema })
      .safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Pick the last month to bill" };

    const result = await db().transaction(async (tx): Promise<ActionResult> => {
      const [before] = await tx
        .select()
        .from(schema.recurringBills)
        .where(eq(schema.recurringBills.id, parsed.data.billId))
        .limit(1);
      if (!before) return { ok: false, error: "That bill no longer exists" };
      if (parsed.data.endMonth < before.startMonth) {
        return { ok: false, error: "The end month is before the start month" };
      }

      await tx
        .update(schema.recurringBills)
        .set({ endMonth: parsed.data.endMonth, active: false, updatedAt: new Date() })
        .where(eq(schema.recurringBills.id, parsed.data.billId));
      await audit(tx, {
        actorType: "staff",
        actorId: staff.id,
        action: "recurring_bill.stop",
        entityType: "recurring_bill",
        entityId: parsed.data.billId,
        before,
        after: { endMonth: parsed.data.endMonth, active: false },
      });
      return { ok: true };
    });

    revalidate();
    return result;
  } catch (err) {
    console.error("stopRecurringBillAction failed", err);
    return { ok: false, error: "Something went wrong" };
  }
}
