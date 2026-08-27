import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

const staff = vi.hoisted(() => ({
  id: "usr_appointment_invoice_test",
  name: "Test Owner",
  email: "appointment-invoice@example.com",
  role: "owner" as const,
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({
  requireStaff: vi.fn(async () => staff),
  AuthError: class AuthError extends Error {},
}));

import { db, getPool, schema } from "../src/db";
import { newId } from "../src/lib/id";
import { createInvoiceFromAppointmentAction } from "../src/app/admin/(app)/invoices/actions";

/**
 * The shop finishes most cars with "Mark Arrived" then "Mark Completed", which
 * creates no job — and since invoices hang off jobs, that path could not bill
 * anyone. These cover the job being materialised for the visit and the invoice
 * coming out of it with the booking's money intact.
 */

const MONTH_MS = 30 * 86_400_000;

let customerId: string;
let vehicleId: string;

/** A visit that was marked completed without ever being checked in. */
async function completedAppointment(opts: {
  subtotalCents: number;
  discountCents?: number;
  depositPaidCents?: number;
  taxRateBp?: number;
  promoCode?: string | null;
  promoLabel?: string | null;
  endedMsAgo?: number;
  status?: string;
  lines?: { description: string; priceCents: number }[];
}): Promise<string> {
  const discountCents = opts.discountCents ?? 0;
  const taxRateBp = opts.taxRateBp ?? 1300;
  const taxable = opts.subtotalCents - discountCents;
  const endedMsAgo = opts.endedMsAgo ?? 86_400_000;
  const appointmentId = newId("apt");
  await db().insert(schema.appointments).values({
    id: appointmentId,
    customerId,
    vehicleId,
    status: opts.status ?? "completed",
    startsAt: new Date(Date.now() - endedMsAgo - 3_600_000),
    endsAt: new Date(Date.now() - endedMsAgo),
    subtotalCents: opts.subtotalCents,
    discountCents,
    depositPaidCents: opts.depositPaidCents ?? 0,
    promoCode: opts.promoCode ?? null,
    promoLabel: opts.promoLabel ?? null,
    taxRateBp,
    taxCents: Math.round((taxable * taxRateBp) / 10000),
    totalCents: taxable + Math.round((taxable * taxRateBp) / 10000),
    durationMin: 60,
  });
  const lines = opts.lines ?? [{ description: "Interior Detail", priceCents: opts.subtotalCents }];
  if (lines.length > 0) {
    await db().insert(schema.appointmentServices).values(
      lines.map((line, i) => ({
        id: newId("aps"),
        appointmentId,
        description: line.description,
        priceCents: line.priceCents,
        durationMin: 60,
        sort: i,
      })),
    );
  }
  return appointmentId;
}

beforeEach(async () => {
  await db().execute(
    `TRUNCATE invoice_line_items, invoice_jobs, payments, invoices, additional_work_requests,
     jobs, appointment_services, appointments, vehicles, customers, audit_log, staff_users,
     invoice_counters RESTART IDENTITY CASCADE` as never,
  );
  await db().insert(schema.staffUsers).values({
    id: staff.id,
    name: staff.name,
    email: staff.email,
    passwordHash: "x",
    role: staff.role,
  });
  await db().insert(schema.invoiceCounters).values({ id: "default", nextNumber: 1000 });

  customerId = newId("cus");
  await db().insert(schema.customers).values({
    id: customerId,
    firstName: "Walk",
    lastName: "In",
    email: "walkin@example.com",
  });
  vehicleId = newId("veh");
  await db().insert(schema.vehicles).values({
    id: vehicleId,
    customerId,
    make: "Toyota",
    model: "Corolla",
    category: "sedan",
  });
});

afterAll(async () => {
  await getPool().end();
});

describe("createInvoiceFromAppointmentAction", () => {
  it("records the missing job and invoices the booked lines", async () => {
    const appointmentId = await completedAppointment({ subtotalCents: 20000 });

    const res = await createInvoiceFromAppointmentAction({ appointmentId });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const [job] = await db().select().from(schema.jobs).where(eq(schema.jobs.id, res.jobId));
    expect(job.status).toBe("completed");
    expect(job.appointmentId).toBe(appointmentId);
    expect(job.invoiceId).toBe(res.invoiceId);
    // Dated to the visit, not to the moment the paperwork was done.
    expect(job.completedAt?.getTime()).toBeLessThan(Date.now() - 1000);

    // The appointment now points at its job, which is how the screen finds
    // the invoice it produced.
    const [appt] = await db().select().from(schema.appointments)
      .where(eq(schema.appointments.id, appointmentId));
    expect(appt.jobId).toBe(res.jobId);
    expect(appt.status).toBe("completed"); // untouched

    const [invoice] = await db().select().from(schema.invoices)
      .where(eq(schema.invoices.id, res.invoiceId));
    expect(invoice.subtotalCents).toBe(20000);
    expect(invoice.taxCents).toBe(2600);
    expect(invoice.totalCents).toBe(22600);
    expect(invoice.status).toBe("draft");

    const items = await db().select().from(schema.invoiceLineItems)
      .where(eq(schema.invoiceLineItems.invoiceId, res.invoiceId));
    expect(items.map((i) => i.description)).toEqual(["Interior Detail"]);
  });

  it("bills what the appointment says now, not what was booked", async () => {
    // Standing in for a counter revision: the invoice reads the appointment's
    // CURRENT lines, which is what keeps the two screens in step.
    const appointmentId = await completedAppointment({
      subtotalCents: 30000,
      lines: [
        { description: "Full Detail", priceCents: 25000 },
        { description: "Pet hair removal", priceCents: 5000 },
      ],
    });

    const res = await createInvoiceFromAppointmentAction({ appointmentId });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const items = await db().select().from(schema.invoiceLineItems)
      .where(eq(schema.invoiceLineItems.invoiceId, res.invoiceId));
    expect(items.map((i) => i.description).sort()).toEqual(["Full Detail", "Pet hair removal"]);
    const [invoice] = await db().select().from(schema.invoices)
      .where(eq(schema.invoices.id, res.invoiceId));
    expect(invoice.subtotalCents).toBe(30000);
  });

  it("carries the booking discount, promo provenance and deposit", async () => {
    const appointmentId = await completedAppointment({
      subtotalCents: 28000,
      discountCents: 2800,
      depositPaidCents: 5000,
      promoCode: "FIRST10AUG26",
      promoLabel: "First Detail Offer",
    });

    const res = await createInvoiceFromAppointmentAction({ appointmentId });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const [invoice] = await db().select().from(schema.invoices)
      .where(eq(schema.invoices.id, res.invoiceId));
    expect(invoice.discountCents).toBe(2800);
    expect(invoice.taxCents).toBe(3276); // 13% of 25200, not of 28000
    expect(invoice.depositAppliedCents).toBe(5000);
    expect(invoice.notes).toContain("FIRST10AUG26");
  });

  it("raises the invoice WITH tax — the payment method settles it later", async () => {
    const appointmentId = await completedAppointment({ subtotalCents: 17500 });
    const res = await createInvoiceFromAppointmentAction({ appointmentId });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const [invoice] = await db().select().from(schema.invoices)
      .where(eq(schema.invoices.id, res.invoiceId));
    expect(invoice.taxTreatment).toBe("added");
    expect(invoice.taxExempt).toBe(false);
    expect(invoice.quotedPaymentMethod).toBeNull();
  });

  it("refuses a second invoice for the same visit", async () => {
    const appointmentId = await completedAppointment({ subtotalCents: 20000 });
    const first = await createInvoiceFromAppointmentAction({ appointmentId });
    expect(first.ok).toBe(true);

    const second = await createInvoiceFromAppointmentAction({ appointmentId });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error).toMatch(/already has an invoice/i);

    const invoices = await db().select().from(schema.invoices);
    expect(invoices).toHaveLength(1);
  });

  it("refuses a visit that is not finished", async () => {
    const appointmentId = await completedAppointment({ subtotalCents: 20000, status: "confirmed" });
    const res = await createInvoiceFromAppointmentAction({ appointmentId });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/cannot be invoiced/i);
    expect(await db().select().from(schema.jobs)).toHaveLength(0);
  });

  it("refuses a visit with nothing on it", async () => {
    const appointmentId = await completedAppointment({ subtotalCents: 0, lines: [] });
    const res = await createInvoiceFromAppointmentAction({ appointmentId });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/nothing to invoice/i);
  });

  it("does not queue a maintenance text when back-filling an old visit", async () => {
    // Default reminder window is 4 months; this visit is 6 months old, so the
    // job would be due the instant it appears and the next cron tick would
    // text the customer about a car they brought in long ago.
    const appointmentId = await completedAppointment({
      subtotalCents: 20000,
      endedMsAgo: 6 * MONTH_MS,
    });
    const res = await createInvoiceFromAppointmentAction({ appointmentId });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const [job] = await db().select().from(schema.jobs).where(eq(schema.jobs.id, res.jobId));
    expect(job.maintenanceReminderSentAt).not.toBeNull();
  });

  it("leaves the maintenance reminder live for a visit that just happened", async () => {
    const appointmentId = await completedAppointment({ subtotalCents: 20000 });
    const res = await createInvoiceFromAppointmentAction({ appointmentId });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const [job] = await db().select().from(schema.jobs).where(eq(schema.jobs.id, res.jobId));
    expect(job.maintenanceReminderSentAt).toBeNull();
  });
});
