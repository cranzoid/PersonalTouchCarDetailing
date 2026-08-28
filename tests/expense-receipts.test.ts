import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";

const staff = vi.hoisted(() => ({
  id: "usr_receipt_test",
  name: "Test Owner",
  email: "receipts@example.com",
  role: "owner" as const,
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({
  requireStaff: vi.fn(async () => staff),
  AuthError: class AuthError extends Error {},
}));

import { db, getPool, schema } from "../src/db";
import { newId } from "../src/lib/id";
import {
  createExpenseAction,
  deleteExpenseAction,
  deleteExpenseReceiptAction,
  uploadExpenseReceiptsAction,
} from "../src/app/admin/(app)/expenses/actions";
import { RECEIPT_ENTITY_TYPE } from "../src/app/admin/(app)/expenses/receipts";

/**
 * The paperwork behind a number. Receipts ride on the shared `files` table, so
 * these tests care most about the two things that are easy to get wrong there:
 * that a receipt is tagged as an expense's and nothing else's, and that
 * deleting the expense does not leave its paperwork behind.
 */

const CATEGORY = "expcat_receipts";

function receiptFile(name: string, type = "image/png") {
  return new File([new Uint8Array([1, 2, 3, 4])], name, { type });
}

function uploadForm(expenseId: string, files: File[]) {
  const formData = new FormData();
  formData.set("expenseId", expenseId);
  for (const file of files) formData.append("receipts", file);
  return formData;
}

async function anExpense(amountCents = 4500) {
  const result = await createExpenseAction({
    expenseDate: "2026-08-14",
    categoryId: CATEGORY,
    paidTo: "Supply Depot",
    description: "Microfibre towels",
    amountCents,
    taxPaidCents: 0,
    paidBy: "card_terminal",
  });
  if (!result.ok) throw new Error(result.error);
  return result.expenseId;
}

async function receiptsOf(expenseId: string) {
  return db()
    .select()
    .from(schema.files)
    .where(and(eq(schema.files.entityType, RECEIPT_ENTITY_TYPE), eq(schema.files.entityId, expenseId)));
}

beforeEach(async () => {
  await db().execute(
    `TRUNCATE files, expenses, expense_categories, audit_log, staff_users RESTART IDENTITY CASCADE` as never,
  );
  await db().insert(schema.staffUsers).values({
    id: staff.id, name: staff.name, email: staff.email, passwordHash: "x", role: staff.role,
  });
  await db().insert(schema.expenseCategories).values({ id: CATEGORY, name: "Supplies" });
});

afterAll(async () => {
  await getPool().end();
});

describe("expense receipts", () => {
  it("attaches files to the expense they document", async () => {
    const expenseId = await anExpense();
    const result = await uploadExpenseReceiptsAction(
      uploadForm(expenseId, [receiptFile("till.png"), receiptFile("bill.pdf", "application/pdf")]),
    );

    expect(result.ok).toBe(true);
    const rows = await receiptsOf(expenseId);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.kind === "receipt")).toBe(true);
    expect(rows.every((row) => row.uploadedById === staff.id)).toBe(true);
    // The storage key must never be the uploaded filename — two suppliers both
    // sending "invoice.pdf" would otherwise collide.
    expect(rows.every((row) => row.storageKey.startsWith(`expenses/${expenseId}/`))).toBe(true);
    expect(rows.some((row) => row.storageKey.includes("till.png"))).toBe(false);
  });

  it("refuses a file type that is not a receipt", async () => {
    const expenseId = await anExpense();
    const result = await uploadExpenseReceiptsAction(
      uploadForm(expenseId, [receiptFile("notes.txt", "text/plain")]),
    );
    expect(result).toEqual({ ok: false, error: "Receipts must be a JPEG, PNG, WebP, HEIC or PDF" });
    expect(await receiptsOf(expenseId)).toHaveLength(0);
  });

  it("will not attach to an expense that no longer exists", async () => {
    const result = await uploadExpenseReceiptsAction(uploadForm(newId("exp"), [receiptFile("a.png")]));
    expect(result).toEqual({ ok: false, error: "That expense no longer exists" });
  });

  it("detaches a receipt attached to the wrong row", async () => {
    const expenseId = await anExpense();
    await uploadExpenseReceiptsAction(uploadForm(expenseId, [receiptFile("a.png"), receiptFile("b.png")]));
    const [first] = await receiptsOf(expenseId);

    expect(await deleteExpenseReceiptAction({ fileId: first.id })).toEqual({ ok: true });
    const remaining = await receiptsOf(expenseId);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).not.toBe(first.id);
  });

  /**
   * A customer photo must not be reachable — or deletable — through the expense
   * route. The entity_type filter is the whole boundary, so it is worth a test.
   */
  it("refuses to delete a file that is not an expense receipt", async () => {
    const fileId = newId("file");
    await db().insert(schema.files).values({
      id: fileId,
      entityType: "job",
      entityId: newId("job"),
      kind: "after",
      storageKey: "jobs/x/y.jpg",
      contentType: "image/jpeg",
      uploadedByType: "staff",
    });

    expect(await deleteExpenseReceiptAction({ fileId })).toEqual({
      ok: false,
      error: "That receipt no longer exists",
    });
    const [still] = await db().select().from(schema.files).where(eq(schema.files.id, fileId));
    expect(still).toBeDefined();
  });

  it("takes the receipts with it when the expense is deleted", async () => {
    const expenseId = await anExpense();
    await uploadExpenseReceiptsAction(uploadForm(expenseId, [receiptFile("a.png")]));

    expect(await deleteExpenseAction({ expenseId })).toEqual({ ok: true });
    expect(await receiptsOf(expenseId)).toHaveLength(0);

    // The ledger stays reconstructible: the storage keys are in the audit row.
    const [entry] = await db()
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.action, "expense.delete"), eq(schema.auditLog.entityId, expenseId)));
    expect((entry.before as { receipts: string[] }).receipts).toHaveLength(1);
  });
});
