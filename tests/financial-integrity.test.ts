import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";

const staff = vi.hoisted(() => ({
  id: "usr_financial_integrity_test",
  name: "Test Accountant",
  email: "financial-integrity@example.com",
  role: "owner" as const,
}));
const helcim = vi.hoisted(() => ({
  refund: vi.fn(),
  reverse: vi.fn(),
  getTransaction: vi.fn(),
  findByInvoiceNumber: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({
  requireStaff: vi.fn(async () => staff),
  AuthError: class AuthError extends Error {},
}));
vi.mock("@/lib/helcim/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/helcim/client")>();
  return {
    ...actual,
    refundCardTransaction: helcim.refund,
    reverseCardTransaction: helcim.reverse,
    getCardTransaction: helcim.getTransaction,
    findCardTransactionsByInvoiceNumber: helcim.findByInvoiceNumber,
  };
});

import { db, getPool, schema } from "../src/db";
import { newId } from "../src/lib/id";
import { syncOverdueInvoices } from "../src/lib/invoices";
import { recordAppointmentDepositAction } from "../src/app/admin/(app)/appointments/actions";
import { issueRefundAction, recordPaymentAction } from "../src/app/admin/(app)/invoices/actions";
import { normalizeTransaction, HelcimApiError } from "../src/lib/helcim/client";

function helcimTx(fields: Record<string, unknown>) {
  return normalizeTransaction({ status: "APPROVED", currency: "CAD", ...fields });
}

async function resetDb() {
  await db().execute(sql`
    TRUNCATE payments, invoices, appointments, vehicles, customers, staff_users, audit_log CASCADE
  `);
  await db().insert(schema.staffUsers).values({
    id: staff.id,
    name: staff.name,
    email: staff.email,
    passwordHash: "not-used-in-tests",
    role: staff.role,
  });
}

async function createCustomerAndVehicle() {
  const customerId = newId("cus");
  const vehicleId = newId("veh");
  await db().insert(schema.customers).values({
    id: customerId,
    firstName: "Financial",
    lastName: "Test",
    email: "financial@example.com",
  });
  await db().insert(schema.vehicles).values({
    id: vehicleId,
    customerId,
    make: "Honda",
    model: "Civic",
    category: "sedan",
  });
  return { customerId, vehicleId };
}

async function createDepositAppointment(depositRequiredCents = 5_000, depositPaidCents = 0) {
  const { customerId, vehicleId } = await createCustomerAndVehicle();
  const appointmentId = newId("apt");
  const startsAt = new Date(Date.now() + 86_400_000);
  await db().insert(schema.appointments).values({
    id: appointmentId,
    customerId,
    vehicleId,
    status: "deposit_required",
    startsAt,
    endsAt: new Date(startsAt.getTime() + 60 * 60_000),
    durationMin: 60,
    depositRequiredCents,
    depositPaidCents,
  });
  return { appointmentId, customerId };
}

async function createInvoice(input: {
  customerId: string;
  number: number;
  status: string;
  totalCents?: number;
  dueAt?: Date | null;
}) {
  const id = newId("inv");
  await db().insert(schema.invoices).values({
    id,
    number: input.number,
    customerId: input.customerId,
    status: input.status,
    subtotalCents: input.totalCents ?? 10_000,
    taxRateBp: 0,
    totalCents: input.totalCents ?? 10_000,
    dueAt: input.dueAt ?? null,
  });
  return id;
}

describe("financial integrity", () => {
  beforeEach(async () => {
    await resetDb();
    for (const fn of Object.values(helcim)) fn.mockReset();
  });

  afterAll(async () => {
    await getPool().end();
  });

  it("records an exact appointment deposit once and confirms atomically", async () => {
    const { appointmentId } = await createDepositAppointment();
    const request = {
      appointmentId,
      method: "etransfer" as const,
      amountCents: 5_000,
      idempotencyKey: "deposit_retry_key_001",
    };

    expect(await recordAppointmentDepositAction(request)).toEqual({ ok: true });
    expect(await recordAppointmentDepositAction(request)).toEqual({ ok: true });

    const [appointment] = await db()
      .select()
      .from(schema.appointments)
      .where(eq(schema.appointments.id, appointmentId));
    expect(appointment.status).toBe("confirmed");
    expect(appointment.depositPaidCents).toBe(5_000);

    const payments = await db()
      .select()
      .from(schema.payments)
      .where(eq(schema.payments.appointmentId, appointmentId));
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({
      invoiceId: null,
      kind: "deposit",
      provider: "etransfer",
      amountCents: 5_000,
      status: "succeeded",
      idempotencyKey: request.idempotencyKey,
    });

    const audits = await db()
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "appointment.deposit_recorded"));
    expect(audits).toHaveLength(1);
  });

  it("rejects a deposit amount that is not the exact remaining balance", async () => {
    const { appointmentId } = await createDepositAppointment(5_000, 1_000);
    const result = await recordAppointmentDepositAction({
      appointmentId,
      method: "cash",
      amountCents: 3_000,
      idempotencyKey: "deposit_wrong_amount_001",
    });

    expect(result).toEqual({ ok: false, error: "The remaining deposit is 40.00 CAD" });
    expect(await db().select().from(schema.payments)).toHaveLength(0);
    const [appointment] = await db()
      .select()
      .from(schema.appointments)
      .where(eq(schema.appointments.id, appointmentId));
    expect(appointment).toMatchObject({ status: "deposit_required", depositPaidCents: 1_000 });
  });

  it("deduplicates retried manual payments and refunds by client key", async () => {
    const { customerId } = await createCustomerAndVehicle();
    const invoiceId = await createInvoice({ customerId, number: 9001, status: "sent" });
    const payment = {
      invoiceId,
      method: "cash" as const,
      amountCents: 10_000,
      idempotencyKey: "manual_payment_retry_001",
    };

    expect(await recordPaymentAction(payment)).toEqual({ ok: true });
    expect(await recordPaymentAction(payment)).toEqual({ ok: true });

    const refund = {
      invoiceId,
      amountCents: 2_000,
      reason: "Customer adjustment",
      idempotencyKey: "manual_refund_retry_001",
    };
    expect(await issueRefundAction(refund)).toMatchObject({ ok: true });
    expect(await issueRefundAction(refund)).toMatchObject({ ok: true });

    const payments = await db()
      .select()
      .from(schema.payments)
      .where(eq(schema.payments.invoiceId, invoiceId));
    expect(payments).toHaveLength(2);
    expect(payments.map((row) => row.kind).sort()).toEqual(["payment", "refund"]);

    const [invoice] = await db().select().from(schema.invoices).where(eq(schema.invoices.id, invoiceId));
    expect(invoice.status).toBe("partially_paid");

    const audits = await db()
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.entityId, invoiceId));
    expect(audits.filter((row) => row.action === "invoice.payment_recorded")).toHaveLength(1);
    expect(audits.filter((row) => row.action === "invoice.refunded")).toHaveLength(1);
  });

  it("refunds to the card through Helcim once, from the server-reserved ledger amount", async () => {
    const { customerId } = await createCustomerAndVehicle();
    const invoiceId = await createInvoice({ customerId, number: 9002, status: "paid" });
    await db().insert(schema.payments).values({
      id: newId("pay"),
      invoiceId,
      customerId,
      provider: "helcim",
      providerRef: "70001",
      idempotencyKey: "checkout_helcim_refundable_001",
      kind: "payment",
      amountCents: 10_000,
      status: "succeeded",
      receivedAt: new Date(),
    });
    helcim.refund.mockResolvedValue(helcimTx({ transactionId: "70002", type: "refund", amount: 40 }));
    const request = {
      invoiceId,
      amountCents: 4_000,
      reason: "Customer adjustment",
      method: "card" as const,
      idempotencyKey: "card_refund_retry_001",
    };

    expect(await issueRefundAction(request)).toEqual({ ok: true, status: "succeeded" });
    expect(await issueRefundAction(request)).toEqual({ ok: true, status: "succeeded" });
    expect(helcim.refund).toHaveBeenCalledTimes(1);
    expect(helcim.refund).toHaveBeenCalledWith(expect.objectContaining({ originalTransactionId: "70001", amountCents: 4_000 }));

    const refunds = (await db().select().from(schema.payments).where(eq(schema.payments.invoiceId, invoiceId)))
      .filter((payment) => payment.kind === "refund");
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({ provider: "helcim", amountCents: 4_000, status: "succeeded" });
    expect(refunds[0].providerRef).toContain("|70002");
    const [invoice] = await db().select().from(schema.invoices).where(eq(schema.invoices.id, invoiceId));
    expect(invoice.status).toBe("partially_paid");
  });

  it("keeps a refund pending when Helcim's answer is lost, and finds it rather than refunding twice", async () => {
    const { customerId } = await createCustomerAndVehicle();
    const invoiceId = await createInvoice({ customerId, number: 9003, status: "paid" });
    await db().insert(schema.payments).values({
      id: newId("pay"),
      invoiceId,
      customerId,
      provider: "helcim",
      providerRef: "71001",
      idempotencyKey: "checkout_helcim_retry_safe_001",
      kind: "payment",
      amountCents: 10_000,
      status: "succeeded",
      receivedAt: new Date(),
    });
    const request = {
      invoiceId,
      amountCents: 4_000,
      reason: "Retry safety",
      method: "card" as const,
      idempotencyKey: "card_refund_ambiguous_001",
    };
    helcim.refund.mockRejectedValueOnce(new Error("network timeout"));

    expect(await issueRefundAction(request)).toEqual({
      ok: false,
      error: "Helcim did not confirm the refund. Retry the same request safely.",
    });
    let [refund] = (await db().select().from(schema.payments).where(eq(schema.payments.invoiceId, invoiceId)))
      .filter((payment) => payment.kind === "refund");
    expect(refund.status).toBe("pending");

    // The refund DID happen at Helcim; the retry must find it, not send another.
    helcim.getTransaction.mockResolvedValue(helcimTx({ transactionId: "71001", type: "purchase", amount: 100, invoiceNumber: "PTCREFUNDSRC" }));
    helcim.findByInvoiceNumber.mockResolvedValue([
      helcimTx({ transactionId: "71001", type: "purchase", amount: 100, invoiceNumber: "PTCREFUNDSRC" }),
      helcimTx({ transactionId: "71002", type: "refund", amount: 40, invoiceNumber: "PTCREFUNDSRC" }),
    ]);
    expect(await issueRefundAction(request)).toEqual({ ok: true, status: "succeeded" });
    expect(helcim.refund).toHaveBeenCalledTimes(1);
    [refund] = (await db().select().from(schema.payments).where(eq(schema.payments.invoiceId, invoiceId)))
      .filter((payment) => payment.kind === "refund");
    expect(refund.status).toBe("succeeded");
    expect(refund.providerRef).toContain("|71002");
  });

  it("records a refund Helcim refuses as failed and leaves the invoice paid", async () => {
    const { customerId } = await createCustomerAndVehicle();
    const invoiceId = await createInvoice({ customerId, number: 9004, status: "paid" });
    await db().insert(schema.payments).values({
      id: newId("pay"),
      invoiceId,
      customerId,
      provider: "helcim",
      providerRef: "72001",
      idempotencyKey: "checkout_helcim_refused_001",
      kind: "payment",
      amountCents: 10_000,
      status: "succeeded",
      receivedAt: new Date(),
    });
    helcim.refund.mockRejectedValueOnce(new HelcimApiError(400, ["Transaction is not settled"]));
    helcim.getTransaction.mockResolvedValue(helcimTx({ transactionId: "72001", type: "purchase", amount: 100 }));

    const result = await issueRefundAction({
      invoiceId,
      amountCents: 3_000,
      reason: "Refused provider test",
      method: "card",
      idempotencyKey: "card_refund_refused_001",
    });
    expect(result).toEqual({ ok: false, error: "Helcim refused the refund: Transaction is not settled" });
    // A partial amount cannot fall back to a full reversal.
    expect(helcim.reverse).not.toHaveBeenCalled();
    const refund = (await db().select().from(schema.payments).where(eq(schema.payments.invoiceId, invoiceId)))
      .find((payment) => payment.kind === "refund")!;
    expect(refund.status).toBe("failed");
    const [invoice] = await db().select().from(schema.invoices).where(eq(schema.invoices.id, invoiceId));
    expect(invoice.status).toBe("paid");
  });

  it("atomically marks only eligible invoices overdue and audits once", async () => {
    const { customerId } = await createCustomerAndVehicle();
    const past = new Date(Date.now() - 60_000);
    const future = new Date(Date.now() + 60_000);
    const sentId = await createInvoice({ customerId, number: 9101, status: "sent", dueAt: past });
    const partialId = await createInvoice({ customerId, number: 9102, status: "partially_paid", dueAt: past });
    const paidId = await createInvoice({ customerId, number: 9103, status: "paid", dueAt: past });
    const futureId = await createInvoice({ customerId, number: 9104, status: "sent", dueAt: future });

    expect(new Set(await syncOverdueInvoices())).toEqual(new Set([sentId, partialId]));
    expect(await syncOverdueInvoices()).toEqual([]);

    const rows = await db().select().from(schema.invoices);
    expect(rows.find((row) => row.id === sentId)?.status).toBe("overdue");
    expect(rows.find((row) => row.id === partialId)?.status).toBe("overdue");
    expect(rows.find((row) => row.id === paidId)?.status).toBe("paid");
    expect(rows.find((row) => row.id === futureId)?.status).toBe("sent");

    const audits = await db()
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "invoice.overdue"));
    expect(audits).toHaveLength(2);
    expect(new Set(audits.map((row) => (row.before as { status: string }).status))).toEqual(
      new Set(["sent", "partially_paid"]),
    );
  });
});
