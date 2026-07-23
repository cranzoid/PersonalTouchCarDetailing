import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";

const webhook = vi.hoisted(() => ({ event: null as null | Record<string, unknown> }));

vi.mock("@/lib/payments", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/payments")>();
  return {
    ...actual,
    getPaymentProvider: () => ({
      name: "stripe" as const,
      createCheckoutSession: vi.fn(),
      refundPayment: vi.fn(),
      verifyWebhookEvent: () => webhook.event,
    }),
  };
});

import { db, getPool, schema } from "../src/db";
import { newId } from "../src/lib/id";
import { POST } from "../src/app/api/webhooks/stripe/route";

async function resetDb() {
  await db().execute(sql`
    TRUNCATE webhook_events, payments, communications, appointment_services, appointments, vehicles,
             customers, audit_log, business_settings CASCADE
  `);
}

describe("appointment deposit Stripe webhook", () => {
  beforeEach(resetDb);

  afterAll(async () => {
    await getPool().end();
  });

  it("confirms the matching appointment once across duplicate webhook delivery", async () => {
    const customerId = newId("cus");
    const vehicleId = newId("veh");
    const appointmentId = newId("apt");
    const paymentId = newId("pay");
    await db().insert(schema.customers).values({
      id: customerId,
      firstName: "Webhook",
      lastName: "Customer",
      email: "webhook@example.com",
    });
    await db().insert(schema.vehicles).values({
      id: vehicleId,
      customerId,
      make: "BMW",
      model: "X3",
      category: "suv_small",
    });
    const startsAt = new Date(Date.now() + 86_400_000);
    await db().insert(schema.appointments).values({
      id: appointmentId,
      customerId,
      vehicleId,
      status: "deposit_required",
      startsAt,
      endsAt: new Date(startsAt.getTime() + 60 * 60_000),
      durationMin: 60,
      totalCents: 20_000,
      depositRequiredCents: 5_000,
    });
    await db().insert(schema.payments).values({
      id: paymentId,
      appointmentId,
      customerId,
      provider: "stripe",
      providerRef: "cs_webhook_deposit",
      idempotencyKey: `webhook_${paymentId}`,
      kind: "deposit",
      amountCents: 5_000,
      status: "pending",
    });
    webhook.event = {
      id: "evt_appointment_deposit",
      type: "checkout.session.completed",
      sessionId: "cs_webhook_deposit",
      paymentId,
      appointmentId,
      amountTotal: 5_000,
      currency: "cad",
      paymentStatus: "paid",
      raw: { id: "evt_appointment_deposit" },
    };

    const request = () => new Request("http://localhost/api/webhooks/stripe", { method: "POST", body: "{}" });
    expect((await POST(request())).status).toBe(200);
    expect((await POST(request())).status).toBe(200);

    const [appointment] = await db()
      .select()
      .from(schema.appointments)
      .where(eq(schema.appointments.id, appointmentId));
    expect(appointment).toMatchObject({ status: "confirmed", depositPaidCents: 5_000 });
    const audits = await db()
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "appointment.deposit_payment_succeeded"));
    expect(audits).toHaveLength(1);
    const [event] = await db()
      .select()
      .from(schema.webhookEvents)
      .where(eq(schema.webhookEvents.eventId, "evt_appointment_deposit"));
    expect(event.processedAt).toBeInstanceOf(Date);
    const confirmations = await db()
      .select()
      .from(schema.communications)
      .where(eq(schema.communications.relatedEntityId, appointmentId));
    expect(confirmations).toHaveLength(1);
    expect(confirmations[0].body).toContain("deposit of $50.00");
    expect(confirmations[0].body).toContain("appointment is now confirmed");
  });
});
