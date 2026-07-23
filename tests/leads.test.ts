import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";

const auth = vi.hoisted(() => ({
  actor: {
    id: "usr_lead_test_manager",
    name: "Lead Test Manager",
    email: "lead-manager@example.com",
    role: "manager" as const,
  },
  requireStaff: vi.fn(),
}));
auth.requireStaff.mockResolvedValue(auth.actor);

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({
  requireStaff: auth.requireStaff,
  AuthError: class AuthError extends Error {},
}));

import { db, getPool, schema } from "../src/db";
import { newId } from "../src/lib/id";
import {
  assignLeadAction,
  convertLeadAction,
  updateLeadNotesAction,
} from "../src/app/admin/(app)/leads/actions";

async function resetDb() {
  await db().execute(sql`
    TRUNCATE quote_requests, communications, customers, leads, staff_sessions, staff_users, audit_log CASCADE
  `);
  await db().insert(schema.staffUsers).values({
    id: auth.actor.id,
    name: auth.actor.name,
    email: auth.actor.email,
    passwordHash: "not-used-in-tests",
    role: auth.actor.role,
    active: true,
  });
  auth.requireStaff.mockClear();
  auth.requireStaff.mockResolvedValue(auth.actor);
}

async function insertLead(
  input: Partial<typeof schema.leads.$inferInsert> = {},
) {
  const id = input.id ?? newId("lead");
  await db().insert(schema.leads).values({
    id,
    name: "Avery Morgan",
    email: "avery@example.com",
    phone: "+14165550123",
    kind: "quote",
    ...input,
  });
  return id;
}

async function insertStaff(active: boolean) {
  const id = newId("usr");
  await db().insert(schema.staffUsers).values({
    id,
    name: active ? "Active Detailer" : "Former Detailer",
    email: `${id}@example.com`,
    passwordHash: "not-used-in-tests",
    role: "technician",
    active,
  });
  return id;
}

describe("lead operations", () => {
  beforeEach(resetDb);

  afterAll(async () => {
    await getPool().end();
  });

  it("converts a lead once, preserves structured consent, and links its quote", async () => {
    const consentAt = new Date("2026-06-10T14:30:00.000Z");
    const leadId = await insertLead({
      marketingConsent: true,
      marketingConsentAt: consentAt,
      marketingConsentSource: "public_quote_form",
    });
    const quoteRequestId = newId("qr");
    await db().insert(schema.quoteRequests).values({
      id: quoteRequestId,
      leadId,
      vehicleInfo: { year: 2023, make: "BMW", model: "X5" },
      conditionDescription: "Interior and paint correction quote",
    });

    const request = {
      leadId,
      firstName: "Avery",
      lastName: "Morgan",
      customerType: "business" as const,
      companyName: "Morgan Motors",
      preferredContact: "sms" as const,
      marketingConsent: true,
    };
    const first = await convertLeadAction(request);
    const replay = await convertLeadAction(request);

    expect(first.ok).toBe(true);
    expect(replay).toEqual(first);
    if (!first.ok) throw new Error(first.error);

    const customers = await db()
      .select()
      .from(schema.customers)
      .where(eq(schema.customers.sourceLeadId, leadId));
    expect(customers).toHaveLength(1);
    expect(customers[0]).toMatchObject({
      id: first.customerId,
      firstName: "Avery",
      lastName: "Morgan",
      customerType: "business",
      companyName: "Morgan Motors",
      preferredContact: "sms",
      marketingConsent: true,
      marketingConsentSource: "public_quote_form",
      sourceLeadId: leadId,
    });
    expect(customers[0].marketingConsentAt).toEqual(consentAt);

    const [lead] = await db().select().from(schema.leads).where(eq(schema.leads.id, leadId));
    expect(lead).toMatchObject({
      status: "converted",
      convertedCustomerId: first.customerId,
      marketingConsent: true,
      marketingConsentSource: "public_quote_form",
    });
    expect(lead.marketingConsentAt).toEqual(consentAt);

    const [quote] = await db()
      .select()
      .from(schema.quoteRequests)
      .where(eq(schema.quoteRequests.id, quoteRequestId));
    expect(quote.customerId).toBe(first.customerId);

    const audits = await db()
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "lead.converted"));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorId: auth.actor.id, entityId: leadId });
    expect(auth.requireStaff).toHaveBeenCalledWith("manage_customers");
  });

  it("assigns only active staff and saves notes without duplicate replay audits", async () => {
    const leadId = await insertLead();
    const activeStaffId = await insertStaff(true);
    const inactiveStaffId = await insertStaff(false);

    const assignment = { leadId, assignedStaffId: activeStaffId };
    expect(await assignLeadAction(assignment)).toEqual({ ok: true });
    expect(await assignLeadAction(assignment)).toEqual({ ok: true });
    expect(await assignLeadAction({ leadId, assignedStaffId: inactiveStaffId })).toEqual({
      ok: false,
      error: "Choose an active staff member",
    });

    const notes = { leadId, notes: "Call after 4 PM. Interested in recurring service." };
    expect(await updateLeadNotesAction(notes)).toEqual({ ok: true });
    expect(await updateLeadNotesAction(notes)).toEqual({ ok: true });

    const [lead] = await db().select().from(schema.leads).where(eq(schema.leads.id, leadId));
    expect(lead.assignedStaffId).toBe(activeStaffId);
    expect(lead.notes).toBe(notes.notes);

    const audits = await db()
      .select({ action: schema.auditLog.action })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.entityId, leadId));
    expect(audits).toEqual(
      expect.arrayContaining([{ action: "lead.assigned" }, { action: "lead.notes_updated" }]),
    );
    expect(audits).toHaveLength(2);
  });
});
