import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db, getPool, schema } from "../src/db";
import {
  createAppointmentDepositAccessToken,
  resolveAppointmentDepositToken,
} from "../src/lib/appointment-deposits";
import { hashToken } from "../src/lib/estimates";
import { newId } from "../src/lib/id";

// Paying a deposit (and prepaying a booking) through Helcim is covered in
// helcim-checkouts.test.ts. This file keeps the access-token rules.

async function resetDb() {
  await db().execute(sql`
    TRUNCATE payments, access_tokens, appointment_services, appointments, vehicles, customers, audit_log,
             rate_limit_buckets CASCADE
  `);
}

async function createDepositAppointment(input: { required?: number; paid?: number; customerId?: string } = {}) {
  const customerId = input.customerId ?? newId("cus");
  if (!input.customerId) {
    await db().insert(schema.customers).values({
      id: customerId,
      firstName: "Deposit",
      lastName: "Customer",
      email: `${customerId}@example.com`,
    });
  }
  const vehicleId = newId("veh");
  await db().insert(schema.vehicles).values({
    id: vehicleId,
    customerId,
    make: "Honda",
    model: "Civic",
    category: "sedan",
  });
  const appointmentId = newId("apt");
  const startsAt = new Date(Date.now() + 3 * 86_400_000);
  const required = input.required ?? 5_000;
  const paid = input.paid ?? 0;
  await db().insert(schema.appointments).values({
    id: appointmentId,
    customerId,
    vehicleId,
    status: paid >= required ? "confirmed" : "deposit_required",
    startsAt,
    endsAt: new Date(startsAt.getTime() + 60 * 60_000),
    durationMin: 60,
    totalCents: 15_000,
    depositRequiredCents: required,
    depositPaidCents: paid,
  });
  return { appointmentId, customerId };
}

describe("appointment deposit payments", () => {
  beforeEach(resetDb);

  afterAll(async () => {
    await getPool().end();
  });

  it("stores only a token hash and rejects expired or cross-customer tokens", async () => {
    const first = await createDepositAppointment();
    const raw = await createAppointmentDepositAccessToken(db(), {
      appointmentId: first.appointmentId,
      customerId: first.customerId,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const [stored] = await db()
      .select()
      .from(schema.accessTokens)
      .where(eq(schema.accessTokens.tokenHash, hashToken(raw)));
    expect(stored.tokenHash).toBe(hashToken(raw));
    expect(stored.tokenHash).not.toBe(raw);
    expect((await resolveAppointmentDepositToken(raw))?.appointment.id).toBe(first.appointmentId);

    const expired = await createDepositAppointment();
    const expiredRaw = await createAppointmentDepositAccessToken(db(), {
      appointmentId: expired.appointmentId,
      customerId: expired.customerId,
      expiresAt: new Date(Date.now() - 1_000),
    });
    expect(await resolveAppointmentDepositToken(expiredRaw)).toBeNull();

    const otherCustomerId = newId("cus");
    await db().insert(schema.customers).values({ id: otherCustomerId, firstName: "Other", lastName: "Customer" });
    const mismatchedRaw = await createAppointmentDepositAccessToken(db(), {
      appointmentId: first.appointmentId,
      customerId: otherCustomerId,
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(await resolveAppointmentDepositToken(mismatchedRaw)).toBeNull();
  });

});
