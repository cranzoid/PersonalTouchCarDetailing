"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireStaff, AuthError } from "@/lib/auth/session";
import { audit } from "@/lib/audit";

const leadStatusInput = z.object({
  leadId: z.string().min(1),
  status: z.enum(["new", "contacted", "qualified", "converted", "lost"]),
});

export type ActionResult = { ok: true } | { ok: false; error: string };

export async function setLeadStatusAction(raw: unknown): Promise<ActionResult> {
  try {
    const staff = await requireStaff("manage_customers");
    const parsed = leadStatusInput.safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Invalid request" };
    const { leadId, status } = parsed.data;

    return await db().transaction(async (tx) => {
      const rows = await tx.select().from(schema.leads).where(eq(schema.leads.id, leadId)).for("update");
      const lead = rows[0];
      if (!lead) return { ok: false, error: "Lead not found" };
      await tx.update(schema.leads).set({ status, updatedAt: new Date() }).where(eq(schema.leads.id, leadId));
      await audit(tx, {
        actorType: "staff",
        actorId: staff.id,
        action: "lead.status_changed",
        entityType: "lead",
        entityId: leadId,
        before: { status: lead.status },
        after: { status },
      });
      revalidatePath("/admin/leads");
      return { ok: true };
    });
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, error: err.message };
    console.error("setLeadStatusAction failed", err);
    return { ok: false, error: "Something went wrong" };
  }
}

const quoteStatusInput = z.object({
  quoteRequestId: z.string().min(1),
  status: z.enum(["new", "reviewing", "estimated", "closed"]),
});

export async function setQuoteRequestStatusAction(raw: unknown): Promise<ActionResult> {
  try {
    const staff = await requireStaff("manage_estimates");
    const parsed = quoteStatusInput.safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Invalid request" };
    const { quoteRequestId, status } = parsed.data;
    return await db().transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(schema.quoteRequests)
        .where(eq(schema.quoteRequests.id, quoteRequestId))
        .for("update");
      if (!rows[0]) return { ok: false, error: "Quote request not found" };
      await tx
        .update(schema.quoteRequests)
        .set({ status, updatedAt: new Date() })
        .where(eq(schema.quoteRequests.id, quoteRequestId));
      await audit(tx, {
        actorType: "staff",
        actorId: staff.id,
        action: "quote_request.status_changed",
        entityType: "quote_request",
        entityId: quoteRequestId,
        before: { status: rows[0].status },
        after: { status },
      });
      revalidatePath("/admin/leads");
      return { ok: true };
    });
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, error: err.message };
    console.error("setQuoteRequestStatusAction failed", err);
    return { ok: false, error: "Something went wrong" };
  }
}
