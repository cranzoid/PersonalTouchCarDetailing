"use server";

import { headers } from "next/headers";
import { z } from "zod";
import { and, eq, gt, inArray, isNull } from "drizzle-orm";
import { db, schema } from "@/db";
import { audit } from "@/lib/audit";
import { hashToken } from "@/lib/estimates";
import { consumeRateLimit } from "@/lib/rate-limit";

export type PortalActionResult = { ok: true } | { ok: false; error: string };

const decisionSchema = z.object({
  token: z.string().min(1),
  decision: z.enum(["approve", "decline"]),
  /** Typed name acts as the customer's signature on approval. */
  name: z.string().trim().min(1).max(150),
  /** Line-item ids of OPTIONAL items the customer chose to include. */
  selectedOptionalLineIds: z.array(z.string()).max(50).default([]),
  message: z.string().trim().max(2000).optional(),
});

/**
 * Customer approval/decline via tokened link. The token is re-validated here —
 * the page having rendered is not an authorization. Decision, name and IP are
 * stored on the estimate and in the audit log.
 */
export async function decideEstimateAction(raw: unknown): Promise<PortalActionResult> {
  const rate = await consumeRateLimit("estimate-decision", { limit: 10, windowMs: 60 * 60_000 });
  if (!rate.allowed) return { ok: false, error: "Too many attempts. Please wait and try again." };
  const parsed = decisionSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Please enter your name to continue." };
  const input = parsed.data;

  if (!/^[0-9a-f]{64}$/.test(input.token)) return { ok: false, error: "This link is no longer valid." };

  const hdrs = await headers();
  const ip = (hdrs.get("x-forwarded-for") ?? "").split(",")[0].trim() || null;
  const userAgent = hdrs.get("user-agent");

  try {
    return await db().transaction(async (tx): Promise<PortalActionResult> => {
      const [token] = await tx
        .select()
        .from(schema.accessTokens)
        .where(
          and(
            eq(schema.accessTokens.tokenHash, hashToken(input.token)),
            eq(schema.accessTokens.purpose, "estimate_view"),
            eq(schema.accessTokens.subjectType, "estimate"),
            gt(schema.accessTokens.expiresAt, new Date()),
            isNull(schema.accessTokens.revokedAt),
            isNull(schema.accessTokens.usedAt),
          ),
        )
        .for("update");
      if (!token) return { ok: false, error: "This link is no longer valid." };

      const [estimate] = await tx
        .select()
        .from(schema.estimates)
        .where(eq(schema.estimates.id, token.subjectId))
        .for("update");
      if (!estimate || estimate.customerId !== token.customerId) {
        return { ok: false, error: "This link is no longer valid." };
      }
      if (!["sent", "viewed", "changes_requested"].includes(estimate.status)) {
        return { ok: false, error: "This estimate can no longer be changed." };
      }
      if (estimate.expiresAt && estimate.expiresAt < new Date()) {
        return { ok: false, error: "This estimate has expired — please contact us for a refresh." };
      }

      const lines = await tx
        .select()
        .from(schema.estimateLineItems)
        .where(eq(schema.estimateLineItems.estimateId, estimate.id));
      const optionalIds = lines.filter((l) => l.isOptional).map((l) => l.id);
      const chosen = new Set(input.selectedOptionalLineIds.filter((id) => optionalIds.includes(id)));

      if (input.decision === "approve" && optionalIds.length > 0) {
        const toSelect = optionalIds.filter((id) => chosen.has(id));
        const toDeselect = optionalIds.filter((id) => !chosen.has(id));
        if (toSelect.length > 0) {
          await tx
            .update(schema.estimateLineItems)
            .set({ isSelected: true })
            .where(inArray(schema.estimateLineItems.id, toSelect));
        }
        if (toDeselect.length > 0) {
          await tx
            .update(schema.estimateLineItems)
            .set({ isSelected: false })
            .where(inArray(schema.estimateLineItems.id, toDeselect));
        }
      }

      const newStatus = input.decision === "approve" ? "approved" : "declined";
      await tx
        .update(schema.estimates)
        .set({
          status: newStatus,
          decidedAt: new Date(),
          approvalName: input.name,
          approvalIp: ip,
          approvalUserAgent: userAgent,
          changeRequestMessage: input.message || null,
          updatedAt: new Date(),
        })
        .where(eq(schema.estimates.id, estimate.id));

      // The link has served its purpose; single-use for decisions.
      await tx
        .update(schema.accessTokens)
        .set({ usedAt: new Date() })
        .where(eq(schema.accessTokens.id, token.id));

      await audit(tx, {
        actorType: "customer",
        actorId: estimate.customerId,
        action: `estimate.${newStatus}`,
        entityType: "estimate",
        entityId: estimate.id,
        before: { status: estimate.status },
        after: {
          status: newStatus,
          approvalName: input.name,
          selectedOptionalLineIds: [...chosen],
        },
        reason: input.message,
        ip: ip ?? undefined,
      });
      return { ok: true };
    });
  } catch (err) {
    console.error("decideEstimateAction failed", err);
    return { ok: false, error: "Something went wrong. Please try again or call us." };
  }
}
