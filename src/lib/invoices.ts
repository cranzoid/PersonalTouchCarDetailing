import { randomBytes } from "crypto";
import { and, eq, gt, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { db, schema, type Db } from "@/db";
import { newId } from "@/lib/id";
import { taxCents, formatCents } from "@/lib/money";
import { hashToken } from "@/lib/estimates";
import { getSettings } from "@/lib/settings";
import { sendMessageTemplate } from "@/lib/messaging";
import { audit } from "@/lib/audit";
import type { InvoiceStatus } from "@/lib/types";

/**
 * Invoice domain helpers shared by the admin invoicing screens, the customer
 * pay portal, and the payment webhook handler. Totals are always recomputed
 * server-side from line items — stored totals are a snapshot, never trusted
 * as an input.
 */

export type InvoiceLineInput = {
  serviceId?: string | null;
  description: string;
  quantity: number;
  unitPriceCents: number;
};

export type InvoiceTotals = {
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  totalCents: number;
};

export type ConsolidatedJobInvoiceSource = {
  jobId: string;
  vehicleLabel: string;
  appointmentLines: Array<{
    serviceId?: string | null;
    description: string;
    priceCents: number;
  }>;
  approvedAdditionalWork: Array<{ description: string; priceCents: number }>;
};

/** Builds deterministic, vehicle-labelled lines for a multi-job fleet bill. */
export function buildConsolidatedInvoiceLines(
  sources: ConsolidatedJobInvoiceSource[],
): InvoiceLineInput[] {
  return sources.flatMap((source) => [
    ...source.appointmentLines.map((line) => ({
      serviceId: line.serviceId ?? null,
      description: `${source.vehicleLabel} — ${line.description}`,
      quantity: 1,
      unitPriceCents: line.priceCents,
    })),
    ...source.approvedAdditionalWork.map((line) => ({
      serviceId: null,
      description: `${source.vehicleLabel} — ${line.description}`,
      quantity: 1,
      unitPriceCents: line.priceCents,
    })),
  ]);
}

/** Pure totals math — mirrors computeEstimateTotals minus the optional-line concept. */
export function computeInvoiceTotals(
  lines: Pick<InvoiceLineInput, "quantity" | "unitPriceCents">[],
  discountCents: number,
  taxRateBp: number,
): InvoiceTotals {
  const subtotalCents = lines.reduce((sum, l) => sum + l.quantity * l.unitPriceCents, 0);
  const discount = Math.min(Math.max(0, discountCents), subtotalCents);
  const taxable = subtotalCents - discount;
  const tax = taxCents(taxable, taxRateBp);
  return { subtotalCents, discountCents: discount, taxCents: tax, totalCents: taxable + tax };
}

/** Atomically allocates the next invoice number. */
export async function nextInvoiceNumber(tx: Pick<Db, "update">): Promise<number> {
  const rows = await tx
    .update(schema.invoiceCounters)
    .set({ nextNumber: sql`${schema.invoiceCounters.nextNumber} + 1` })
    .where(eq(schema.invoiceCounters.id, "default"))
    .returning({ allocated: schema.invoiceCounters.nextNumber });
  if (!rows[0]) throw new Error("Invoice counter row missing — run db:seed");
  return rows[0].allocated - 1;
}

/**
 * Creates a single-purpose customer access token for viewing/paying an
 * invoice. Returns the RAW token (embed in the link); only the hash is
 * stored. Any previous tokens for the same invoice are revoked.
 */
export async function createInvoiceAccessToken(
  tx: Pick<Db, "insert" | "update">,
  input: { invoiceId: string; customerId: string; expiresAt: Date },
): Promise<string> {
  await tx
    .update(schema.accessTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(schema.accessTokens.subjectType, "invoice"),
        eq(schema.accessTokens.subjectId, input.invoiceId),
        isNull(schema.accessTokens.revokedAt),
      ),
    );
  const raw = randomBytes(32).toString("hex");
  await tx.insert(schema.accessTokens).values({
    id: newId("tok"),
    tokenHash: hashToken(raw),
    purpose: "invoice_pay",
    subjectType: "invoice",
    subjectId: input.invoiceId,
    customerId: input.customerId,
    expiresAt: input.expiresAt,
  });
  return raw;
}

/**
 * Resolves a raw portal token to its invoice, enforcing purpose, expiry and
 * revocation. Returns null rather than throwing — the portal page 404s.
 * Unlike estimate tokens, invoice pay links are NOT single-use — a customer
 * may return to pay a balance or view a receipt after paying.
 */
export async function resolveInvoiceToken(rawToken: string) {
  if (!/^[0-9a-f]{64}$/.test(rawToken)) return null;
  const rows = await db()
    .select({
      token: schema.accessTokens,
      invoice: schema.invoices,
    })
    .from(schema.accessTokens)
    .innerJoin(schema.invoices, eq(schema.accessTokens.subjectId, schema.invoices.id))
    .where(
      and(
        eq(schema.accessTokens.tokenHash, hashToken(rawToken)),
        eq(schema.accessTokens.purpose, "invoice_pay"),
        eq(schema.accessTokens.subjectType, "invoice"),
        gt(schema.accessTokens.expiresAt, new Date()),
        isNull(schema.accessTokens.revokedAt),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export type PaymentSummary = {
  paidCents: number;
  refundedCents: number;
  netPaidCents: number;
  balanceCents: number;
};

/**
 * Rolls up a payments list (succeeded rows only) into what's actually owed.
 * depositAppliedCents is credited once, up front — money collected before
 * the invoice existed (e.g. a booking deposit).
 */
export function summarizePayments(
  totalCents: number,
  depositAppliedCents: number,
  payments: { kind: string; status: string; amountCents: number }[],
): PaymentSummary {
  const succeeded = payments.filter((p) => p.status === "succeeded");
  const paidCents = succeeded
    .filter((p) => p.kind === "deposit" || p.kind === "payment")
    .reduce((sum, p) => sum + p.amountCents, 0);
  const refundedCents = succeeded
    .filter((p) => p.kind === "refund")
    .reduce((sum, p) => sum + p.amountCents, 0);
  const netPaidCents = paidCents - refundedCents + Math.min(depositAppliedCents, totalCents);
  const balanceCents = Math.max(0, totalCents - netPaidCents);
  return { paidCents, refundedCents, netPaidCents, balanceCents };
}

/**
 * Derives the invoice status from its payment history. Draft/cancelled are
 * never touched here — those are explicit staff actions, not payment-driven.
 */
export function deriveInvoiceStatus(input: {
  totalCents: number;
  netPaidCents: number;
  refundedCents: number;
  fallback: InvoiceStatus;
}): InvoiceStatus {
  if (input.refundedCents > 0 && input.netPaidCents <= 0) return "refunded";
  if (input.totalCents > 0 && input.netPaidCents >= input.totalCents) return "paid";
  if (input.netPaidCents > 0) return "partially_paid";
  return input.fallback;
}

/**
 * Locks the invoice row, recomputes its status from the current payments
 * table, and persists it. Callers insert/update a payment row first (in the
 * same transaction), then call this. A no-op for cancelled invoices —
 * payments never resurrect a cancelled invoice automatically.
 */
export async function recalculateInvoiceStatus(
  tx: Pick<Db, "select" | "update">,
  invoiceId: string,
): Promise<{ status: InvoiceStatus; balanceCents: number }> {
  const rows = await tx.select().from(schema.invoices).where(eq(schema.invoices.id, invoiceId)).for("update");
  const invoice = rows[0];
  if (!invoice) throw new Error("Invoice not found");
  if (invoice.status === "cancelled") {
    return { status: "cancelled", balanceCents: 0 };
  }

  const payments = await tx.select().from(schema.payments).where(eq(schema.payments.invoiceId, invoiceId));
  const summary = summarizePayments(invoice.totalCents, invoice.depositAppliedCents, payments);
  const status = deriveInvoiceStatus({
    totalCents: invoice.totalCents,
    netPaidCents: summary.netPaidCents,
    refundedCents: summary.refundedCents,
    fallback: invoice.status as InvoiceStatus,
  });
  await tx
    .update(schema.invoices)
    .set({
      status,
      paidAt: status === "paid" ? (invoice.paidAt ?? new Date()) : invoice.paidAt,
      updatedAt: new Date(),
    })
    .where(eq(schema.invoices.id, invoiceId));

  return { status, balanceCents: summary.balanceCents };
}

/**
 * Flips `sent`/`partially_paid` invoices to `overdue` once their `dueAt` has
 * passed. Those two statuses only ever exist when there's still a balance
 * owing (deriveInvoiceStatus would have already reported `paid`), so no
 * payments lookup is needed here — the status alone is enough to select
 * candidates. Idempotent: re-running only touches rows that haven't already
 * flipped. Safe to call opportunistically on page reads as well as from a
 * scheduled job — see /api/cron/invoices-overdue.
 */
export async function syncOverdueInvoices(): Promise<string[]> {
  const now = new Date();
  return db().transaction(async (tx) => {
    // Lock the still-eligible rows before changing them. Payment finalization
    // locks the same invoice row, so whichever operation wins the lock is
    // observed by the other; a paid invoice can never be overwritten as
    // overdue by a stale select/update pair.
    const candidates = await tx
      .select({ id: schema.invoices.id, status: schema.invoices.status })
      .from(schema.invoices)
      .where(
        and(
          inArray(schema.invoices.status, ["sent", "partially_paid"]),
          isNotNull(schema.invoices.dueAt),
          lt(schema.invoices.dueAt, now),
        ),
      )
      .for("update");
    if (candidates.length === 0) return [];

    const ids = candidates.map((c) => c.id);
    const updated = await tx
      .update(schema.invoices)
      .set({ status: "overdue", updatedAt: now })
      .where(
        and(
          inArray(schema.invoices.id, ids),
          inArray(schema.invoices.status, ["sent", "partially_paid"]),
          isNotNull(schema.invoices.dueAt),
          lt(schema.invoices.dueAt, now),
        ),
      )
      .returning({ id: schema.invoices.id });
    const updatedIds = new Set(updated.map((row) => row.id));

    for (const candidate of candidates) {
      if (!updatedIds.has(candidate.id)) continue;
      await audit(tx, {
        actorType: "system",
        action: "invoice.overdue",
        entityType: "invoice",
        entityId: candidate.id,
        before: { status: candidate.status },
        after: { status: "overdue" },
      });
    }
    return updated.map((row) => row.id);
  });
}

/**
 * Sends the "receipt" template for a payment through its configured channel. Shared by the manual-payment
 * admin action and the online-checkout finalization paths (fake dev
 * provider + Stripe webhook) so every successful payment sends the same
 * receipt regardless of payment channel. Safely no-ops if the active
 * template's configured destination is unavailable — payment finalization must not
 * fail because a receipt couldn't be sent.
 */
export async function sendInvoiceReceipt(invoiceId: string, amountCents: number): Promise<void> {
  const [invoice] = await db().select().from(schema.invoices).where(eq(schema.invoices.id, invoiceId)).limit(1);
  if (!invoice) return;
  const [customer] = await db()
    .select()
    .from(schema.customers)
    .where(eq(schema.customers.id, invoice.customerId))
    .limit(1);
  if (!customer) return;

  const settings = await getSettings();
  const payments = await db().select().from(schema.payments).where(eq(schema.payments.invoiceId, invoiceId));
  const { balanceCents } = summarizePayments(invoice.totalCents, invoice.depositAppliedCents, payments);
  await sendMessageTemplate({
    templateKey: "receipt",
    recipient: customer,
    customerId: customer.id,
    kind: "receipt",
    variables: {
      businessName: settings.businessName,
      firstName: customer.firstName,
      invoiceNumber: String(invoice.number),
      amount: formatCents(amountCents, settings.currency),
      balanceLine:
        balanceCents > 0
          ? `Remaining balance: ${formatCents(balanceCents, settings.currency)}.\n`
          : "Your invoice is now paid in full.\n",
    },
    relatedEntityType: "invoice",
    relatedEntityId: invoiceId,
  });
}
