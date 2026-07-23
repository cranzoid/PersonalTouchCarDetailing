import { randomBytes } from "crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { db, schema, type Db } from "@/db";
import { newId } from "@/lib/id";
import { hashToken } from "@/lib/estimates";
import {
  JOB_TRANSITIONS,
  JOB_STATUSES,
  QC_CHECKLIST_ITEMS,
  type JobStatus,
} from "@/lib/types";

/**
 * Job domain helpers shared by the admin pipeline and the customer
 * additional-work approval portal. Status changes always go through
 * canTransitionJob — the state machine in JOB_TRANSITIONS is the single
 * source of truth, enforced server-side.
 */

export function isJobStatus(value: string): value is JobStatus {
  return (JOB_STATUSES as readonly string[]).includes(value);
}

export function canTransitionJob(from: JobStatus, to: JobStatus): boolean {
  return JOB_TRANSITIONS[from]?.includes(to) ?? false;
}

/** True when every QC checklist item has been ticked. */
export function isQcComplete(items: Record<string, boolean>): boolean {
  return QC_CHECKLIST_ITEMS.every((item) => items[item.key] === true);
}

/**
 * Creates a single-purpose customer token for approving one additional-work
 * request. Returns the RAW token (embed in the link); only the hash is
 * stored. Any previous tokens for the same request are revoked.
 */
export async function createAdditionalWorkAccessToken(
  tx: Pick<Db, "insert" | "update">,
  input: { requestId: string; customerId: string; expiresAt: Date },
): Promise<string> {
  await tx
    .update(schema.accessTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(schema.accessTokens.subjectType, "additional_work_request"),
        eq(schema.accessTokens.subjectId, input.requestId),
        isNull(schema.accessTokens.revokedAt),
      ),
    );
  const raw = randomBytes(32).toString("hex");
  await tx.insert(schema.accessTokens).values({
    id: newId("tok"),
    tokenHash: hashToken(raw),
    purpose: "additional_work",
    subjectType: "additional_work_request",
    subjectId: input.requestId,
    customerId: input.customerId,
    expiresAt: input.expiresAt,
  });
  return raw;
}

/**
 * Resolves a raw portal token to its additional-work request + job, enforcing
 * purpose, expiry and revocation. Returns null rather than throwing — the
 * portal page 404s.
 */
export async function resolveAdditionalWorkToken(rawToken: string) {
  if (!/^[0-9a-f]{64}$/.test(rawToken)) return null;
  const rows = await db()
    .select({
      token: schema.accessTokens,
      request: schema.additionalWorkRequests,
      job: schema.jobs,
    })
    .from(schema.accessTokens)
    .innerJoin(
      schema.additionalWorkRequests,
      eq(schema.accessTokens.subjectId, schema.additionalWorkRequests.id),
    )
    .innerJoin(schema.jobs, eq(schema.additionalWorkRequests.jobId, schema.jobs.id))
    .where(
      and(
        eq(schema.accessTokens.tokenHash, hashToken(rawToken)),
        eq(schema.accessTokens.purpose, "additional_work"),
        eq(schema.accessTokens.subjectType, "additional_work_request"),
        gt(schema.accessTokens.expiresAt, new Date()),
        isNull(schema.accessTokens.revokedAt),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}
