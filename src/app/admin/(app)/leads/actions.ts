"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { and, eq, isNull } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireStaff, AuthError } from "@/lib/auth/session";
import { audit } from "@/lib/audit";
import { newId } from "@/lib/id";

const leadStatusInput = z.object({
  leadId: z.string().min(1),
  status: z.enum(["new", "contacted", "qualified", "converted", "lost"]),
});

export type ActionResult<T extends object = Record<never, never>> =
  | ({ ok: true } & T)
  | { ok: false; error: string };

const assignLeadInput = z.object({
  leadId: z.string().min(1),
  assignedStaffId: z.string().min(1).nullable(),
});

const leadNotesInput = z.object({
  leadId: z.string().min(1),
  notes: z.string().trim().max(4000),
});

const convertLeadInput = z.object({
  leadId: z.string().min(1),
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().max(100),
  customerType: z.enum(["individual", "business"]),
  companyName: z.string().trim().max(160).optional().or(z.literal("").transform(() => undefined)),
  preferredContact: z.enum(["email", "sms", "phone"]),
  marketingConsent: z.boolean(),
});

export async function assignLeadAction(raw: unknown): Promise<ActionResult> {
  try {
    const staff = await requireStaff("manage_customers");
    const parsed = assignLeadInput.safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Invalid assignment" };
    const input = parsed.data;

    const result = await db().transaction(async (tx): Promise<ActionResult> => {
      const lead = (
        await tx.select().from(schema.leads).where(eq(schema.leads.id, input.leadId)).for("update")
      )[0];
      if (!lead) return { ok: false, error: "Lead not found" };

      if (input.assignedStaffId) {
        const assignee = (
          await tx
            .select({ id: schema.staffUsers.id })
            .from(schema.staffUsers)
            .where(and(eq(schema.staffUsers.id, input.assignedStaffId), eq(schema.staffUsers.active, true)))
            .for("update")
        )[0];
        if (!assignee) return { ok: false, error: "Choose an active staff member" };
      }
      if (lead.assignedStaffId === input.assignedStaffId) return { ok: true };

      await tx
        .update(schema.leads)
        .set({ assignedStaffId: input.assignedStaffId, updatedAt: new Date() })
        .where(eq(schema.leads.id, lead.id));
      await audit(tx, {
        actorType: "staff",
        actorId: staff.id,
        action: "lead.assigned",
        entityType: "lead",
        entityId: lead.id,
        before: { assignedStaffId: lead.assignedStaffId },
        after: { assignedStaffId: input.assignedStaffId },
      });
      return { ok: true };
    });

    if (result.ok) {
      revalidatePath("/admin/leads");
      revalidatePath(`/admin/leads/${input.leadId}`);
    }
    return result;
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, error: err.message };
    console.error("assignLeadAction failed", err);
    return { ok: false, error: "Something went wrong" };
  }
}

export async function updateLeadNotesAction(raw: unknown): Promise<ActionResult> {
  try {
    const staff = await requireStaff("manage_customers");
    const parsed = leadNotesInput.safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Notes must be 4,000 characters or fewer" };
    const input = parsed.data;
    const notes = input.notes || null;

    const result = await db().transaction(async (tx): Promise<ActionResult> => {
      const lead = (
        await tx.select().from(schema.leads).where(eq(schema.leads.id, input.leadId)).for("update")
      )[0];
      if (!lead) return { ok: false, error: "Lead not found" };
      if (lead.notes === notes) return { ok: true };

      await tx
        .update(schema.leads)
        .set({ notes, updatedAt: new Date() })
        .where(eq(schema.leads.id, lead.id));
      await audit(tx, {
        actorType: "staff",
        actorId: staff.id,
        action: "lead.notes_updated",
        entityType: "lead",
        entityId: lead.id,
        before: { notes: lead.notes },
        after: { notes },
      });
      return { ok: true };
    });

    if (result.ok) revalidatePath(`/admin/leads/${input.leadId}`);
    return result;
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, error: err.message };
    console.error("updateLeadNotesAction failed", err);
    return { ok: false, error: "Something went wrong" };
  }
}

export async function convertLeadAction(raw: unknown): Promise<ActionResult<{ customerId: string }>> {
  try {
    const staff = await requireStaff("manage_customers");
    const parsed = convertLeadInput.safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Please check the customer details" };
    const input = parsed.data;
    if (input.customerType === "business" && !input.companyName) {
      return { ok: false, error: "Business customers need a company name" };
    }

    const result = await db().transaction(async (tx): Promise<ActionResult<{ customerId: string }>> => {
      const lead = (
        await tx.select().from(schema.leads).where(eq(schema.leads.id, input.leadId)).for("update")
      )[0];
      if (!lead || lead.anonymizedAt) return { ok: false, error: "Lead not found" };

      // The lead row is the idempotency boundary. A replay after a successful
      // conversion returns the original customer instead of creating another.
      if (lead.convertedCustomerId) {
        return { ok: true, customerId: lead.convertedCustomerId };
      }
      if (!lead.email && !lead.phone) return { ok: false, error: "Lead needs an email address or phone number" };
      if (input.preferredContact === "email" && !lead.email) {
        return { ok: false, error: "Preferred email requires an email address" };
      }
      if (input.preferredContact !== "email" && !lead.phone) {
        return { ok: false, error: "Preferred phone contact requires a phone number" };
      }

      const now = new Date();
      const customerId = newId("cus");
      const consentAt = input.marketingConsent ? lead.marketingConsentAt ?? now : null;
      const consentSource = input.marketingConsent
        ? lead.marketingConsentSource ?? "staff_lead_conversion"
        : null;
      await tx.insert(schema.customers).values({
        id: customerId,
        firstName: input.firstName,
        lastName: input.lastName,
        email: lead.email,
        phone: lead.phone,
        preferredContact: input.preferredContact,
        customerType: input.customerType,
        companyName: input.customerType === "business" ? input.companyName ?? null : null,
        marketingConsent: input.marketingConsent,
        marketingConsentAt: consentAt,
        marketingConsentSource: consentSource,
        sourceLeadId: lead.id,
      });
      await tx
        .update(schema.leads)
        .set({
          status: "converted",
          convertedCustomerId: customerId,
          marketingConsent: input.marketingConsent,
          marketingConsentAt: consentAt,
          marketingConsentSource: consentSource,
          updatedAt: now,
        })
        .where(eq(schema.leads.id, lead.id));
      const linkedQuotes = await tx
        .update(schema.quoteRequests)
        .set({ customerId, updatedAt: now })
        .where(and(eq(schema.quoteRequests.leadId, lead.id), isNull(schema.quoteRequests.customerId)))
        .returning({ id: schema.quoteRequests.id });

      await audit(tx, {
        actorType: "staff",
        actorId: staff.id,
        action: "lead.converted",
        entityType: "lead",
        entityId: lead.id,
        before: {
          status: lead.status,
          convertedCustomerId: lead.convertedCustomerId,
          marketingConsent: lead.marketingConsent,
        },
        after: {
          status: "converted",
          customerId,
          customerType: input.customerType,
          preferredContact: input.preferredContact,
          marketingConsent: input.marketingConsent,
          linkedQuoteRequests: linkedQuotes.length,
        },
      });
      return { ok: true, customerId };
    });

    if (result.ok) {
      revalidatePath("/admin/leads");
      revalidatePath(`/admin/leads/${input.leadId}`);
      revalidatePath("/admin/customers");
    }
    return result;
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, error: err.message };
    console.error("convertLeadAction failed", err);
    return { ok: false, error: "Something went wrong" };
  }
}

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
      if (status === "converted" && !lead.convertedCustomerId) {
        return { ok: false, error: "Use the conversion workflow to create the linked customer" };
      }
      if (lead.convertedCustomerId && status !== "converted") {
        return { ok: false, error: "Converted leads must remain linked to their customer" };
      }
      if (lead.status === status) return { ok: true };
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
      revalidatePath(`/admin/leads/${leadId}`);
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
