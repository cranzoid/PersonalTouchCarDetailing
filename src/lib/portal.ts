import { randomBytes } from "crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { db, schema, type Db } from "@/db";
import { hashToken } from "@/lib/estimates";
import { newId } from "@/lib/id";

/** Reusable customer portal token. Only its SHA-256 hash is persisted. */
export async function createCustomerPortalToken(
  tx: Pick<Db, "insert" | "update">,
  input: { customerId: string; expiresAt: Date },
): Promise<string> {
  await tx
    .update(schema.accessTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(schema.accessTokens.purpose, "portal"),
        eq(schema.accessTokens.subjectType, "customer"),
        eq(schema.accessTokens.subjectId, input.customerId),
        isNull(schema.accessTokens.revokedAt),
      ),
    );

  const raw = randomBytes(32).toString("hex");
  await tx.insert(schema.accessTokens).values({
    id: newId("tok"),
    tokenHash: hashToken(raw),
    purpose: "portal",
    subjectType: "customer",
    subjectId: input.customerId,
    customerId: input.customerId,
    expiresAt: input.expiresAt,
  });
  return raw;
}

/**
 * Resolves a reusable portal token and binds it to exactly one active
 * customer. `usedAt` is deliberately ignored: dashboard links may be opened
 * repeatedly until they expire or an administrator issues a replacement.
 */
export async function resolveCustomerPortalToken(rawToken: string) {
  if (!/^[0-9a-f]{64}$/.test(rawToken)) return null;
  const rows = await db()
    .select({ token: schema.accessTokens, customer: schema.customers })
    .from(schema.accessTokens)
    .innerJoin(
      schema.customers,
      and(
        eq(schema.accessTokens.subjectId, schema.customers.id),
        eq(schema.accessTokens.customerId, schema.customers.id),
      ),
    )
    .where(
      and(
        eq(schema.accessTokens.tokenHash, hashToken(rawToken)),
        eq(schema.accessTokens.purpose, "portal"),
        eq(schema.accessTokens.subjectType, "customer"),
        gt(schema.accessTokens.expiresAt, new Date()),
        isNull(schema.accessTokens.revokedAt),
        isNull(schema.customers.anonymizedAt),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/** Explicit guard used by every nested portal resource read. */
export function portalOwnsCustomer(portalCustomerId: string, entityCustomerId: string): boolean {
  return portalCustomerId === entityCustomerId;
}
