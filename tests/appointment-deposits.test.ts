import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";

const checkout = vi.hoisted(() => vi.fn());
const reconcile = vi.hoisted(() => vi.fn());

vi.mock("@/lib/rate-limit", () => ({
  consumeRateLimit: vi.fn(async () => ({ allowed: true, remaining: 9, resetAt: new Date() })),
}));
vi.mock("@/lib/payments", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/payments")>();
  return {
    ...actual,
    getPaymentProvider: () => ({
      name: "stripe" as const,
      createCheckoutSession: checkout,
      getCheckoutSession: reconcile,
      refundPayment: vi.fn(),
      verifyWebhookEvent: vi.fn(),
    }),
  };
});

import { db, getPool, schema } from "../src/db";
import {
  createAppointmentDepositAccessToken,
  resolveAppointmentDepositToken,
} from "../src/lib/appointment-deposits";
import { hashToken } from "../src/lib/estimates";
import { newId } from "../src/lib/id";
import { finalizeSucceededAppointmentDeposit } from "../src/lib/payments";
import { createAppointmentDepositCheckoutAction } from "../src/app/(public)/portal/deposits/[token]/actions";

async function resetDb() {
  await db().execute(sql`
    TRUNCATE payments, access_tokens, appointment_services, appointments, vehicles, customers, audit_log,
             rate_limit_buckets CASCADE
  `);
  checkout.mockReset();
  reconcile.mockReset();
  checkout.mockResolvedValue({ providerRef: "cs_appointment_deposit", url: "https://checkout.example/deposit" });
  reconcile.mockResolvedValue({
    providerRef: "cs_appointment_deposit",
    status: "open",
    url: "https://checkout.example/deposit",
    amountCents: 5_000,
    paymentStatus: "unpaid",
  });
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

async function createPendingPayment(input: {
  appointmentId: string;
  customerId: string;
  amountCents?: number;
  provider?: string;
  providerRef?: string | null;
  status?: string;
  failureReason?: string;
}) {
  const id = newId("pay");
  await db().insert(schema.payments).values({
    id,
    appointmentId: input.appointmentId,
    customerId: input.customerId,
    provider: input.provider ?? "stripe",
    providerRef: input.providerRef === undefined ? "cs_deposit_exact" : input.providerRef,
    idempotencyKey: `deposit_${id}`,
    kind: "deposit",
    amountCents: input.amountCents ?? 5_000,
    status: input.status ?? "pending",
    failureReason: input.failureReason,
  });
  return id;
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

  it("derives the exact outstanding deposit and makes concurrent retries share one reservation", async () => {
    const appointment = await createDepositAppointment({ required: 5_000, paid: 1_000 });
    const token = await createAppointmentDepositAccessToken(db(), {
      ...appointment,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const results = await Promise.all([
      createAppointmentDepositCheckoutAction({ token }),
      createAppointmentDepositCheckoutAction({ token }),
    ]);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(results.map((result) => result.ok && result.url)).toEqual([
      "https://checkout.example/deposit",
      "https://checkout.example/deposit",
    ]);
    expect(checkout).toHaveBeenCalledWith(expect.objectContaining({
      appointmentId: appointment.appointmentId,
      amountCents: 4_000,
    }));

    const payments = await db()
      .select()
      .from(schema.payments)
      .where(eq(schema.payments.appointmentId, appointment.appointmentId));
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ kind: "deposit", amountCents: 4_000, status: "pending" });
    expect(new Set(checkout.mock.calls.map((call) => call[0].paymentId))).toEqual(new Set([payments[0].id]));
  });

  it("resumes an authenticated open Stripe session instead of creating another", async () => {
    const appointment = await createDepositAppointment();
    const token = await createAppointmentDepositAccessToken(db(), { ...appointment, expiresAt: new Date(Date.now() + 60_000) });
    const paymentId = await createPendingPayment({ ...appointment, providerRef: "cs_open_deposit" });
    reconcile.mockResolvedValueOnce({
      providerRef: "cs_open_deposit",
      status: "open",
      url: "https://checkout.example/resume-deposit",
      amountCents: 5_000,
      paymentStatus: "unpaid",
    });

    expect(await createAppointmentDepositCheckoutAction({ token })).toEqual({
      ok: true,
      url: "https://checkout.example/resume-deposit",
    });
    expect(checkout).not.toHaveBeenCalled();
    expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({
      providerRef: "cs_open_deposit",
      paymentId,
      appointmentId: appointment.appointmentId,
      amountCents: 5_000,
    }));
  });

  it("finalizes a delayed paid Stripe session even after the legacy local timeout", async () => {
    const appointment = await createDepositAppointment();
    const token = await createAppointmentDepositAccessToken(db(), { ...appointment, expiresAt: new Date(Date.now() + 60_000) });
    const paymentId = await createPendingPayment({
      ...appointment,
      providerRef: "cs_delayed_paid_deposit",
      status: "failed",
      failureReason: "Checkout session expired",
    });
    reconcile.mockResolvedValueOnce({
      providerRef: "cs_delayed_paid_deposit",
      status: "paid",
      amountCents: 5_000,
      paymentStatus: "paid",
    });

    const result = await createAppointmentDepositCheckoutAction({ token });
    expect(result.ok).toBe(true);
    expect(checkout).not.toHaveBeenCalled();
    const [payment] = await db().select().from(schema.payments).where(eq(schema.payments.id, paymentId));
    const [updatedAppointment] = await db()
      .select()
      .from(schema.appointments)
      .where(eq(schema.appointments.id, appointment.appointmentId));
    expect(payment.status).toBe("succeeded");
    expect(updatedAppointment).toMatchObject({ status: "confirmed", depositPaidCents: 5_000 });
  });

  it("replaces a checkout only after Stripe authenticates it as expired", async () => {
    const appointment = await createDepositAppointment();
    const token = await createAppointmentDepositAccessToken(db(), { ...appointment, expiresAt: new Date(Date.now() + 60_000) });
    const oldPaymentId = await createPendingPayment({ ...appointment, providerRef: "cs_expired_deposit" });
    reconcile.mockResolvedValueOnce({
      providerRef: "cs_expired_deposit",
      status: "expired",
      amountCents: 5_000,
      paymentStatus: "unpaid",
    });
    checkout.mockResolvedValueOnce({ providerRef: "cs_replacement_deposit", url: "https://checkout.example/new-deposit" });

    expect(await createAppointmentDepositCheckoutAction({ token })).toEqual({
      ok: true,
      url: "https://checkout.example/new-deposit",
    });
    const payments = await db()
      .select()
      .from(schema.payments)
      .where(eq(schema.payments.appointmentId, appointment.appointmentId));
    expect(payments).toHaveLength(2);
    expect(payments.find((payment) => payment.id === oldPaymentId)).toMatchObject({
      status: "failed",
      failureReason: "Provider confirmed checkout expired",
    });
    expect(payments.find((payment) => payment.id !== oldPaymentId)).toMatchObject({
      status: "pending",
      providerRef: "cs_replacement_deposit",
      amountCents: 5_000,
    });
  });

  it("rejects appointment, provider, reference, amount, and payment-status mismatches", async () => {
    const appointment = await createDepositAppointment();
    const other = await createDepositAppointment();
    const paymentId = await createPendingPayment({ ...appointment });

    const base = {
      paymentId,
      appointmentId: appointment.appointmentId,
      provider: "stripe" as const,
      providerRef: "cs_deposit_exact",
      amountCents: 5_000,
      paymentStatus: "paid",
    };
    expect(await db().transaction((tx) => finalizeSucceededAppointmentDeposit(tx, { ...base, appointmentId: other.appointmentId }))).toBeNull();
    expect(await db().transaction((tx) => finalizeSucceededAppointmentDeposit(tx, { ...base, provider: "fake" }))).toBeNull();
    expect(await db().transaction((tx) => finalizeSucceededAppointmentDeposit(tx, { ...base, providerRef: "cs_wrong" }))).toBeNull();
    expect(await db().transaction((tx) => finalizeSucceededAppointmentDeposit(tx, { ...base, amountCents: 4_999 }))).toBeNull();
    expect(await db().transaction((tx) => finalizeSucceededAppointmentDeposit(tx, { ...base, paymentStatus: "unpaid" }))).toBeNull();

    const [unchangedAppointment] = await db()
      .select()
      .from(schema.appointments)
      .where(eq(schema.appointments.id, appointment.appointmentId));
    const [unchangedPayment] = await db().select().from(schema.payments).where(eq(schema.payments.id, paymentId));
    expect(unchangedAppointment).toMatchObject({ status: "deposit_required", depositPaidCents: 0 });
    expect(unchangedPayment.status).toBe("pending");
  });

  it("increments and confirms exactly once when finalization is replayed", async () => {
    const appointment = await createDepositAppointment();
    const paymentId = await createPendingPayment({ ...appointment });
    const input = {
      paymentId,
      appointmentId: appointment.appointmentId,
      provider: "stripe" as const,
      providerRef: "cs_deposit_exact",
      amountCents: 5_000,
      paymentStatus: "paid",
    };

    const first = await db().transaction((tx) => finalizeSucceededAppointmentDeposit(tx, input));
    const replay = await db().transaction((tx) => finalizeSucceededAppointmentDeposit(tx, input));
    expect(first).toMatchObject({ appointmentId: appointment.appointmentId, amountCents: 5_000, alreadyProcessed: false });
    expect(replay).toMatchObject({ appointmentId: appointment.appointmentId, amountCents: 5_000, alreadyProcessed: true });

    const [updatedAppointment] = await db()
      .select()
      .from(schema.appointments)
      .where(eq(schema.appointments.id, appointment.appointmentId));
    const [updatedPayment] = await db().select().from(schema.payments).where(eq(schema.payments.id, paymentId));
    expect(updatedAppointment).toMatchObject({ status: "confirmed", depositPaidCents: 5_000 });
    expect(updatedPayment.status).toBe("succeeded");
    const audits = await db()
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "appointment.deposit_payment_succeeded"));
    expect(audits).toHaveLength(1);
  });
});
