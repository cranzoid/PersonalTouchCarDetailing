import { createHash, randomBytes } from "crypto";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { db, schema, type Db } from "@/db";
import { newId } from "@/lib/id";
import { taxCents } from "@/lib/money";

/**
 * Estimate domain helpers shared by the admin builder and the customer
 * approval portal. Totals are always recomputed server-side from line items —
 * stored client-facing totals are never trusted.
 */

export type EstimateLineInput = {
  serviceId?: string | null;
  description: string;
  quantity: number;
  unitPriceCents: number;
  isOptional: boolean;
  isSelected: boolean;
};

export type EstimateTotals = {
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  totalCents: number;
};

/**
 * Pure totals math. Optional lines only count when selected; the discount is
 * clamped to the subtotal so tax is never computed on a negative base.
 */
export function computeEstimateTotals(
  lines: Pick<EstimateLineInput, "quantity" | "unitPriceCents" | "isOptional" | "isSelected">[],
  discountCents: number,
  taxRateBp: number,
): EstimateTotals {
  const subtotalCents = lines
    .filter((l) => !l.isOptional || l.isSelected)
    .reduce((sum, l) => sum + l.quantity * l.unitPriceCents, 0);
  const discount = Math.min(Math.max(0, discountCents), subtotalCents);
  const taxable = subtotalCents - discount;
  const tax = taxCents(taxable, taxRateBp);
  return { subtotalCents, discountCents: discount, taxCents: tax, totalCents: taxable + tax };
}

/** Atomically allocates the next estimate number. */
export async function nextEstimateNumber(tx: Pick<Db, "update">): Promise<number> {
  const rows = await tx
    .update(schema.estimateCounters)
    .set({ nextNumber: sql`${schema.estimateCounters.nextNumber} + 1` })
    .where(eq(schema.estimateCounters.id, "default"))
    .returning({ allocated: schema.estimateCounters.nextNumber });
  if (!rows[0]) throw new Error("Estimate counter row missing — run db:seed");
  return rows[0].allocated - 1;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Creates a single-purpose customer access token for viewing/approving an
 * estimate. Returns the RAW token (embed in the link); only the hash is
 * stored. Any previous tokens for the same estimate are revoked.
 */
export async function createEstimateAccessToken(
  tx: Pick<Db, "insert" | "update">,
  input: { estimateId: string; customerId: string; expiresAt: Date },
): Promise<string> {
  await tx
    .update(schema.accessTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(schema.accessTokens.subjectType, "estimate"),
        eq(schema.accessTokens.subjectId, input.estimateId),
        isNull(schema.accessTokens.revokedAt),
      ),
    );
  const raw = randomBytes(32).toString("hex");
  await tx.insert(schema.accessTokens).values({
    id: newId("tok"),
    tokenHash: hashToken(raw),
    purpose: "estimate_view",
    subjectType: "estimate",
    subjectId: input.estimateId,
    customerId: input.customerId,
    expiresAt: input.expiresAt,
  });
  return raw;
}

/**
 * Resolves a raw portal token to its estimate, enforcing purpose, expiry and
 * revocation. Returns null rather than throwing — the portal page 404s.
 */
export async function resolveEstimateToken(rawToken: string) {
  if (!/^[0-9a-f]{64}$/.test(rawToken)) return null;
  const rows = await db()
    .select({
      token: schema.accessTokens,
      estimate: schema.estimates,
    })
    .from(schema.accessTokens)
    .innerJoin(schema.estimates, eq(schema.accessTokens.subjectId, schema.estimates.id))
    .where(
      and(
        eq(schema.accessTokens.tokenHash, hashToken(rawToken)),
        eq(schema.accessTokens.purpose, "estimate_view"),
        eq(schema.accessTokens.subjectType, "estimate"),
        gt(schema.accessTokens.expiresAt, new Date()),
        isNull(schema.accessTokens.revokedAt),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}
