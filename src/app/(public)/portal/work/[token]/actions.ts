"use server";

import { headers } from "next/headers";
import { z } from "zod";
import { and, eq, gt, isNull } from "drizzle-orm";
import { db, schema } from "@/db";
import { audit } from "@/lib/audit";
import { hashToken } from "@/lib/estimates";
import { consumeRateLimit } from "@/lib/rate-limit";

export type PortalActionResult = { ok: true } | { ok: false; error: string };

const decisionSchema = z.object({
  token: z.string().min(1),
  decision: z.enum(["approve", "decline"]),
  /** Typed name acts as the customer's signature on the decision. */
  name: z.string().trim().min(1).max(150),
});

/**
 * Customer approval/decline of mid-job additional work via tokened link. The
 * token is re-validated here — the page having rendered is not an
 * authorization. Name and IP go to the audit log.
 */
export async function decideAdditionalWorkAction(raw: unknown): Promise<PortalActionResult> {
  const rate = await consumeRateLimit("work-decision", { limit: 10, windowMs: 60 * 60_000 });
  if (!rate.allowed) return { ok: false, error: "Too many attempts. Please wait and try again." };
  const parsed = decisionSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Please enter your name to continue." };
  const input = parsed.data;

  if (!/^[0-9a-f]{64}$/.test(input.token)) return { ok: false, error: "This link is no longer valid." };

  const hdrs = await headers();
  const ip = (hdrs.get("x-forwarded-for") ?? "").split(",")[0].trim() || null;

  try {
    return await db().transaction(async (tx): Promise<PortalActionResult> => {
      const [token] = await tx
        .select()
        .from(schema.accessTokens)
        .where(
          and(
            eq(schema.accessTokens.tokenHash, hashToken(input.token)),
            eq(schema.accessTokens.purpose, "additional_work"),
            eq(schema.accessTokens.subjectType, "additional_work_request"),
            gt(schema.accessTokens.expiresAt, new Date()),
            isNull(schema.accessTokens.revokedAt),
            isNull(schema.accessTokens.usedAt),
          ),
        )
        .for("update");
      if (!token) return { ok: false, error: "This link is no longer valid." };

      const [request] = await tx
        .select()
        .from(schema.additionalWorkRequests)
        .where(eq(schema.additionalWorkRequests.id, token.subjectId))
        .for("update");
      if (!request || request.status !== "pending") {
        return { ok: false, error: "This request was already decided." };
      }
      const [job] = await tx.select().from(schema.jobs).where(eq(schema.jobs.id, request.jobId)).limit(1);
      if (!job || job.customerId !== token.customerId) {
        return { ok: false, error: "This link is no longer valid." };
      }

      const newStatus = input.decision === "approve" ? "approved" : "declined";
      await tx
        .update(schema.additionalWorkRequests)
        .set({
          status: newStatus,
          decidedAt: new Date(),
          decidedVia: "customer_link",
          updatedAt: new Date(),
        })
        .where(eq(schema.additionalWorkRequests.id, request.id));

      // The link has served its purpose; single-use for decisions.
      await tx
        .update(schema.accessTokens)
        .set({ usedAt: new Date() })
        .where(eq(schema.accessTokens.id, token.id));

      await audit(tx, {
        actorType: "customer",
        actorId: job.customerId,
        action: `additional_work.${newStatus}`,
        entityType: "additional_work_request",
        entityId: request.id,
        before: { status: request.status },
        after: { status: newStatus, decidedVia: "customer_link", approvalName: input.name },
        ip: ip ?? undefined,
      });
      return { ok: true };
    });
  } catch (err) {
    console.error("decideAdditionalWorkAction failed", err);
    return { ok: false, error: "Something went wrong. Please try again or call us." };
  }
}
