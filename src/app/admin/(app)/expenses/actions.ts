"use server";

import { randomBytes } from "crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { and, eq, isNull } from "drizzle-orm";
import { db, schema } from "@/db";
import { audit } from "@/lib/audit";
import { requireStaff } from "@/lib/auth/session";
import { validateExpenseInput } from "@/lib/books";
import { newId } from "@/lib/id";
import { getSettings } from "@/lib/settings";
import { deletePrivateFile, putPrivateFile } from "@/lib/storage";
import {
  MAX_RECEIPTS_PER_UPLOAD,
  MAX_RECEIPT_BYTES,
  RECEIPT_ENTITY_TYPE,
  RECEIPT_TYPES,
  type ExpenseReceipt,
} from "./receipts";
import { zonedToUtc } from "@/lib/tz";
import { EXPENSE_PAYMENT_METHODS } from "@/lib/types";

export type ActionResult<T = object> = ({ ok: true } & T) | { ok: false; error: string };

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

export async function createExpenseAction(
  raw: unknown,
): Promise<ActionResult<{ expenseId: string }>> {
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
    return { ok: true, expenseId: id };
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

    const result = await db().transaction(async (tx): Promise<ActionResult<{ storageKeys: string[] }>> => {
      const [before] = await tx
        .select()
        .from(schema.expenses)
        .where(eq(schema.expenses.id, parsed.data.expenseId))
        .limit(1);
      if (!before) return { ok: false, error: "That expense no longer exists" };

      // Receipts go with the row they document. The storage keys ride into
      // audit_log.before alongside the expense itself, so a deletion is still
      // reconstructible from the ledger.
      const receipts = await tx
        .select()
        .from(schema.files)
        .where(and(eq(schema.files.entityType, RECEIPT_ENTITY_TYPE), eq(schema.files.entityId, before.id)));

      await audit(tx, {
        actorType: "staff",
        actorId: staff.id,
        action: "expense.delete",
        entityType: "expense",
        entityId: before.id,
        before: { ...before, receipts: receipts.map((file) => file.storageKey) },
      });
      if (receipts.length > 0) {
        await tx.delete(schema.files).where(
          and(eq(schema.files.entityType, RECEIPT_ENTITY_TYPE), eq(schema.files.entityId, before.id)),
        );
      }
      await tx.delete(schema.expenses).where(eq(schema.expenses.id, before.id));
      return { ok: true, storageKeys: receipts.map((file) => file.storageKey) };
    });

    // Outside the transaction on purpose: object storage cannot roll back, so
    // the blobs only go once the ledger row is definitely gone.
    if (result.ok) await removeStoredFiles(result.storageKeys);

    revalidate();
    return result.ok ? { ok: true } : result;
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

/* ------------------------------------------------------------------ */
/* Receipts                                                            */
/* ------------------------------------------------------------------ */

/** Blob removal is best-effort: an orphaned object must never fail a ledger write. */
async function removeStoredFiles(storageKeys: string[]): Promise<void> {
  for (const key of storageKeys) {
    try {
      await deletePrivateFile(key);
    } catch (err) {
      console.error("expense receipt blob delete failed", key, err);
    }
  }
}

/**
 * Attaches one or more receipt images/PDFs to an existing expense.
 *
 * FormData rather than a plain object because the files have to survive the
 * server-action boundary, the same shape uploadJobPhotosAction uses.
 */
export async function uploadExpenseReceiptsAction(
  formData: FormData,
): Promise<ActionResult<{ receipts: ExpenseReceipt[] }>> {
  try {
    const staff = await requireStaff("manage_expenses");
    const expenseId = String(formData.get("expenseId") ?? "");
    if (!expenseId) return { ok: false, error: "Please pick an expense" };

    const files = formData
      .getAll("receipts")
      .filter((entry): entry is File => entry instanceof File && entry.size > 0);
    if (files.length === 0) return { ok: false, error: "Choose at least one file" };
    if (files.length > MAX_RECEIPTS_PER_UPLOAD) {
      return { ok: false, error: `At most ${MAX_RECEIPTS_PER_UPLOAD} files at a time` };
    }
    for (const file of files) {
      if (!RECEIPT_TYPES[file.type]) {
        return { ok: false, error: "Receipts must be a JPEG, PNG, WebP, HEIC or PDF" };
      }
      if (file.size > MAX_RECEIPT_BYTES) return { ok: false, error: "Each file must be under 10 MB" };
    }

    const [expense] = await db()
      .select({ id: schema.expenses.id })
      .from(schema.expenses)
      .where(eq(schema.expenses.id, expenseId))
      .limit(1);
    if (!expense) return { ok: false, error: "That expense no longer exists" };

    const receipts: ExpenseReceipt[] = [];
    for (const file of files) {
      // Random filename, never the uploaded one: the customer-facing rule in
      // storeJobPhotos, applied here so a receipt called "invoice.pdf" from two
      // different suppliers cannot collide or leak a name into a URL.
      const key = `expenses/${expenseId}/${randomBytes(8).toString("hex")}.${RECEIPT_TYPES[file.type]}`;
      await putPrivateFile(key, Buffer.from(await file.arrayBuffer()), file.type);
      const id = newId("file");
      const createdAt = new Date();
      await db().transaction(async (tx) => {
        await tx.insert(schema.files).values({
          id,
          entityType: RECEIPT_ENTITY_TYPE,
          entityId: expenseId,
          kind: "receipt",
          storageKey: key,
          contentType: file.type,
          sizeBytes: file.size,
          uploadedByType: "staff",
          uploadedById: staff.id,
          createdAt,
        });
        await audit(tx, {
          actorType: "staff",
          actorId: staff.id,
          action: "expense.receipt_added",
          entityType: "expense",
          entityId: expenseId,
          after: { fileId: id, contentType: file.type, sizeBytes: file.size },
        });
      });
      receipts.push({
        id,
        contentType: file.type,
        sizeBytes: file.size,
        createdAt: createdAt.toISOString(),
      });
    }

    revalidate();
    return { ok: true, receipts };
  } catch (err) {
    console.error("uploadExpenseReceiptsAction failed", err);
    return { ok: false, error: "Something went wrong uploading the receipt" };
  }
}

/** Detaches a receipt attached to the wrong row, and removes the stored file. */
export async function deleteExpenseReceiptAction(raw: unknown): Promise<ActionResult> {
  try {
    const staff = await requireStaff("manage_expenses");
    const parsed = z.object({ fileId: z.string().min(1) }).safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Please pick a receipt" };

    const result = await db().transaction(async (tx): Promise<ActionResult<{ storageKey: string }>> => {
      const [file] = await tx
        .select()
        .from(schema.files)
        .where(and(eq(schema.files.id, parsed.data.fileId), eq(schema.files.entityType, RECEIPT_ENTITY_TYPE)))
        .limit(1);
      if (!file) return { ok: false, error: "That receipt no longer exists" };

      await audit(tx, {
        actorType: "staff",
        actorId: staff.id,
        action: "expense.receipt_removed",
        entityType: "expense",
        entityId: file.entityId,
        before: { fileId: file.id, storageKey: file.storageKey, contentType: file.contentType },
      });
      await tx.delete(schema.files).where(eq(schema.files.id, file.id));
      return { ok: true, storageKey: file.storageKey };
    });

    if (result.ok) await removeStoredFiles([result.storageKey]);

    revalidate();
    return result.ok ? { ok: true } : result;
  } catch (err) {
    console.error("deleteExpenseReceiptAction failed", err);
    return { ok: false, error: "Something went wrong removing the receipt" };
  }
}
