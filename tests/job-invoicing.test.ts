import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

const staff = vi.hoisted(() => ({
  id: "usr_job_invoice_test",
  name: "Test Owner",
  email: "job-invoice@example.com",
  role: "owner" as const,
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({
  requireStaff: vi.fn(async () => staff),
  AuthError: class AuthError extends Error {},
}));

import { db, getPool, schema } from "../src/db";
import { newId } from "../src/lib/id";
import {
  createInvoiceFromJobAction,
  setInvoiceTaxExemptAction,
} from "../src/app/admin/(app)/invoices/actions";

/**
 * The promotional discount only becomes real money here: a booking priced with
 * an offer must produce an invoice that charges the discounted amount. Before
 * this path existed, createInvoiceFromJobAction hardcoded a zero discount and
 * silently re-billed the customer at full price.
 */

let customerId: string;
let vehicleId: string;

/** Books an appointment, works it, and returns the job ready to invoice. */
async function bookedJob(opts: {
  subtotalCents: number;
  discountCents: number;
  taxRateBp?: number;
  promoLabel?: string | null;
  promoCode?: string | null;
}) {
  const taxRateBp = opts.taxRateBp ?? 1300;
  const taxable = opts.subtotalCents - opts.discountCents;
  const appointmentId = newId("apt");
  await db().insert(schema.appointments).values({
    id: appointmentId,
    customerId,
    vehicleId,
    status: "completed",
    startsAt: new Date(Date.now() - 86_400_000),
    endsAt: new Date(Date.now() - 82_800_000),
    subtotalCents: opts.subtotalCents,
    discountCents: opts.discountCents,
    promoCode: opts.promoCode ?? null,
    promoLabel: opts.promoLabel ?? null,
    taxCents: Math.round((taxable * taxRateBp) / 10000),
    taxRateBp,
    totalCents: taxable + Math.round((taxable * taxRateBp) / 10000),
    durationMin: 60,
  });
  await db().insert(schema.appointmentServices).values({
    id: newId("aps"),
    appointmentId,
    description: "Full Detail",
    priceCents: opts.subtotalCents,
    durationMin: 60,
    sort: 0,
  });
  const jobId = newId("job");
  await db().insert(schema.jobs).values({
    id: jobId,
    appointmentId,
    customerId,
    vehicleId,
    status: "completed",
  });
  return { jobId, appointmentId };
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
    firstName: "First",
    lastName: "Timer",
    email: "firsttimer@example.com",
  });
  vehicleId = newId("veh");
  await db().insert(schema.vehicles).values({
    id: vehicleId,
    customerId,
    make: "Honda",
    model: "Civic",
    category: "sedan",
  });
});

afterAll(async () => {
  await getPool().end();
});

describe("createInvoiceFromJobAction with a promotional discount", () => {
  it("carries the locked discount onto the invoice and taxes the net", async () => {
    const { jobId } = await bookedJob({
      subtotalCents: 28000,
      discountCents: 2800,
      promoCode: "FIRST10AUG26",
      promoLabel: "First Detail Offer",
    });
    const res = await createInvoiceFromJobAction({ jobId, paymentMethod: "card_terminal" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const [invoice] = await db().select().from(schema.invoices)
      .where(eq(schema.invoices.id, res.invoiceId));
    expect(invoice.subtotalCents).toBe(28000);
    expect(invoice.discountCents).toBe(2800);
    expect(invoice.taxCents).toBe(3276); // 13% of 25200, not of 28000
    expect(invoice.totalCents).toBe(28476);
    expect(invoice.notes).toContain("First Detail Offer");
    expect(invoice.notes).toContain("FIRST10AUG26");
  });

  it("bills additional work at full price while the discount stays fixed", async () => {
    const { jobId } = await bookedJob({ subtotalCents: 30000, discountCents: 3000 });
    await db().insert(schema.additionalWorkRequests).values({
      id: newId("awr"),
      jobId,
      description: "Engine bay clean",
      priceCents: 5000,
      status: "approved",
    });

    const res = await createInvoiceFromJobAction({ jobId, paymentMethod: "card_terminal" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const [invoice] = await db().select().from(schema.invoices)
      .where(eq(schema.invoices.id, res.invoiceId));
    // Subtotal grew by the extra work; the discount did not.
    expect(invoice.subtotalCents).toBe(35000);
    expect(invoice.discountCents).toBe(3000);
    expect(invoice.taxCents).toBe(Math.round(32000 * 0.13));
  });

  it("leaves the discount alone when the invoice is later marked tax exempt", async () => {
    const { jobId } = await bookedJob({ subtotalCents: 28000, discountCents: 2800 });
    const created = await createInvoiceFromJobAction({ jobId, paymentMethod: "card_terminal" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const exempt = await setInvoiceTaxExemptAction({
      invoiceId: created.invoiceId,
      taxExempt: true,
      reason: "Status Indian — point of sale relief",
    });
    expect(exempt.ok).toBe(true);

    const [invoice] = await db().select().from(schema.invoices)
      .where(eq(schema.invoices.id, created.invoiceId));
    expect(invoice.taxCents).toBe(0);
    expect(invoice.discountCents).toBe(2800);
    expect(invoice.totalCents).toBe(25200); // subtotal - discount, no tax
  });

  it("records a zero discount for an ordinary booking", async () => {
    const { jobId } = await bookedJob({ subtotalCents: 28000, discountCents: 0 });
    const res = await createInvoiceFromJobAction({ jobId, paymentMethod: "card_terminal" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const [invoice] = await db().select().from(schema.invoices)
      .where(eq(schema.invoices.id, res.invoiceId));
    expect(invoice.discountCents).toBe(0);
    expect(invoice.taxCents).toBe(3640);
    expect(invoice.notes).toBeNull();
  });
});
