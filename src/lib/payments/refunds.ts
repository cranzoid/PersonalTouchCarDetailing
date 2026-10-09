import { and, eq } from "drizzle-orm";
import { db, schema, type Db } from "@/db";
import { audit } from "@/lib/audit";
import { recalculateInvoiceStatus } from "@/lib/invoices";
import {
  findCardTransactionsByInvoiceNumber,
  getCardTransaction,
  HelcimApiError,
  idempotencyKeyFor,
  refundCardTransaction,
  reverseCardTransaction,
  type HelcimTransaction,
} from "@/lib/helcim/client";
import { decodeHelcimRefundReference, encodeHelcimRefundReference } from "./refund-reference";

/**
 * Card refunds through Helcim.
 *
 * The refund row is reserved in the ledger FIRST (status pending, amount fixed
 * by the server), then sent. If Helcim's answer is lost, the row stays pending
 * and the same staff request can be retried: within five minutes Helcim's
 * idempotency key makes the retry a no-op, and after that we look for the
 * refund among the source payment's transactions before sending another. A
 * retry therefore never refunds twice.
 */

/** Marks a pending refund row that has been sent at least once. */
const SENT_MARKER = "Sent to Helcim — awaiting confirmation";

export type CardRefundResult = { status: "succeeded" | "failed" | "pending"; message?: string };

async function finalizeCardRefund(
  tx: Db,
  refundPaymentId: string,
  outcome: { approved: true; transaction: HelcimTransaction } | { approved: false; reason: string },
): Promise<CardRefundResult> {
  const [row] = await tx.select().from(schema.payments).where(eq(schema.payments.id, refundPaymentId)).for("update");
  if (!row?.invoiceId || row.kind !== "refund" || row.status !== "pending") {
    return { status: row?.status === "succeeded" ? "succeeded" : "failed" };
  }
  const reference = decodeHelcimRefundReference(row.providerRef);
  if (!reference) return { status: "failed", message: "The refund reservation has invalid provider data" };
  const now = new Date();
  if (outcome.approved) {
    await tx
      .update(schema.payments)
      .set({
        status: "succeeded",
        providerRef: encodeHelcimRefundReference({ ...reference, refundTransactionId: outcome.transaction.transactionId }),
        failureReason: null,
        receivedAt: now,
        updatedAt: now,
      })
      .where(eq(schema.payments.id, row.id));
    const { status } = await recalculateInvoiceStatus(tx, row.invoiceId);
    await audit(tx, {
      actorType: "system",
      action: "invoice.refund_succeeded",
      entityType: "invoice",
      entityId: row.invoiceId,
      after: { refundPaymentId: row.id, amountCents: row.amountCents, provider: row.provider, transactionId: outcome.transaction.transactionId, status },
    });
    return { status: "succeeded" };
  }
  await tx
    .update(schema.payments)
    .set({ status: "failed", failureReason: outcome.reason, updatedAt: now })
    .where(eq(schema.payments.id, row.id));
  await audit(tx, {
    actorType: "system",
    action: "invoice.refund_failed",
    entityType: "invoice",
    entityId: row.invoiceId,
    after: { refundPaymentId: row.id, amountCents: row.amountCents, reason: outcome.reason },
  });
  return { status: "failed", message: outcome.reason };
}

/** A refund already made at Helcim for this row, found after a lost answer. */
async function findPriorRefund(
  row: typeof schema.payments.$inferSelect,
  sourceTransactionId: string,
): Promise<HelcimTransaction | null> {
  const source = await getCardTransaction(sourceTransactionId);
  if (!source?.invoiceNumber) return null;
  const candidates = (await findCardTransactionsByInvoiceNumber(source.invoiceNumber)).filter(
    (t) => (t.type === "refund" || t.type === "reverse") && t.status === "APPROVED" && t.amountCents === row.amountCents,
  );
  if (candidates.length === 0) return null;
  // Refund transactions already recorded against some other refund row are
  // not ours to adopt.
  const others = await db()
    .select({ providerRef: schema.payments.providerRef })
    .from(schema.payments)
    .where(and(eq(schema.payments.kind, "refund"), eq(schema.payments.invoiceId, row.invoiceId!)));
  const claimed = new Set(
    others.map((o) => decodeHelcimRefundReference(o.providerRef)?.refundTransactionId).filter(Boolean) as string[],
  );
  return candidates.find((t) => !claimed.has(t.transactionId)) ?? null;
}

export async function executeCardRefund(input: { refundPaymentId: string; ipAddress: string }): Promise<CardRefundResult> {
  const [row] = await db().select().from(schema.payments).where(eq(schema.payments.id, input.refundPaymentId)).limit(1);
  if (!row || row.kind !== "refund" || !row.invoiceId) return { status: "failed", message: "Refund not found" };
  if (row.status === "succeeded") return { status: "succeeded" };
  if (row.status !== "pending") return { status: "failed", message: row.failureReason ?? "This refund attempt failed" };
  const reference = decodeHelcimRefundReference(row.providerRef);
  if (!reference) return { status: "failed", message: "The refund reservation has invalid provider data" };

  // Sent before and the answer was lost: look before sending again.
  if (row.failureReason === SENT_MARKER) {
    try {
      const prior = await findPriorRefund(row, reference.sourceTransactionId);
      if (prior) return db().transaction((tx) => finalizeCardRefund(tx, row.id, { approved: true, transaction: prior }));
    } catch (error) {
      console.error(`[refund ${row.id}] could not check for an earlier refund`, error);
      return { status: "pending", message: "Helcim could not be reached to check this refund. Try again shortly." };
    }
  }
  await db()
    .update(schema.payments)
    .set({ failureReason: SENT_MARKER, updatedAt: new Date() })
    .where(and(eq(schema.payments.id, row.id), eq(schema.payments.status, "pending")));

  let transaction: HelcimTransaction;
  try {
    transaction = await refundCardTransaction({
      originalTransactionId: reference.sourceTransactionId,
      amountCents: row.amountCents,
      idempotencyKey: idempotencyKeyFor(`refund:${row.id}`),
      ipAddress: input.ipAddress,
    });
  } catch (error) {
    if (!(error instanceof HelcimApiError) || error.status >= 500) {
      console.error(`[refund ${row.id}] outcome unknown`, error);
      return { status: "pending", message: "Helcim did not confirm the refund. Retry the same request safely." };
    }
    // A refund is refused on a transaction whose batch has not settled yet;
    // the same-day equivalent is a reversal, which is all-or-nothing.
    const source = await getCardTransaction(reference.sourceTransactionId).catch(() => null);
    if (source && source.amountCents === row.amountCents) {
      try {
        transaction = await reverseCardTransaction({
          transactionId: reference.sourceTransactionId,
          idempotencyKey: idempotencyKeyFor(`reverse:${row.id}`),
          ipAddress: input.ipAddress,
        });
      } catch (reverseError) {
        if (reverseError instanceof HelcimApiError && reverseError.status < 500) {
          return db().transaction((tx) =>
            finalizeCardRefund(tx, row.id, { approved: false, reason: `Helcim refused the refund: ${error.message}` }),
          );
        }
        return { status: "pending", message: "Helcim did not confirm the refund. Retry the same request safely." };
      }
    } else {
      return db().transaction((tx) =>
        finalizeCardRefund(tx, row.id, { approved: false, reason: `Helcim refused the refund: ${error.message}` }),
      );
    }
  }
  if (transaction.status !== "APPROVED") {
    return db().transaction((tx) => finalizeCardRefund(tx, row.id, { approved: false, reason: "Helcim declined the refund" }));
  }
  return db().transaction((tx) => finalizeCardRefund(tx, row.id, { approved: true, transaction }));
}
