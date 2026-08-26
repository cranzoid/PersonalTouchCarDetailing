import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

const staff = vi.hoisted(() => ({
  id: "usr_revision_test",
  name: "Test Owner",
  email: "revision@example.com",
  role: "owner" as const,
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({
  requireStaff: vi.fn(async () => staff),
  AuthError: class AuthError extends Error {},
}));

import { db, getPool, schema } from "../src/db";
import { newId } from "../src/lib/id";
import { buildAttentionQueue } from "../src/lib/attention";
import { reviseDiscountCents, revisionDiscountReason } from "../src/lib/booking/revise";
import {
  refundAppointmentDepositAction,
  reviseAppointmentLinesAction,
} from "../src/app/admin/(app)/appointments/actions";
import { createInvoiceFromJobAction } from "../src/app/admin/(app)/invoices/actions";
import { SETTINGS_DEFAULTS } from "../src/lib/settings";

/**
 * A customer books Package 2 online with the ad's 10% offer, then changes their
 * mind at the counter. Before this existed the booked lines were frozen: an
 * upgrade had to be billed as a bolt-on and a downgrade had no path at all.
 */

const PKG1 = "svc_pkg1_rev";
const PKG2 = "svc_pkg2_rev";
const COATING = "svc_coating_rev";
const CATEGORY = "cat_rev";

let customerId: string;
let vehicleId: string;

async function bookedAppointment(opts: {
  serviceId: string;
  priceCents: number;
  discountCents?: number;
  depositPaidCents?: number;
  status?: string;
  taxRateBp?: number;
}) {
  const taxRateBp = opts.taxRateBp ?? 1300;
  const discountCents = opts.discountCents ?? 0;
  const taxable = opts.priceCents - discountCents;
  const taxCents = Math.round((taxable * taxRateBp) / 10000);
  const appointmentId = newId("apt");
  const startsAt = new Date(Date.now() + 3_600_000);
  await db().insert(schema.appointments).values({
    id: appointmentId,
    customerId,
    vehicleId,
    status: opts.status ?? "arrived",
    startsAt,
    // 15 + 60 + 15 of buffers/work, matching SETTINGS_DEFAULTS.
    endsAt: new Date(startsAt.getTime() + 90 * 60_000),
    subtotalCents: opts.priceCents,
    discountCents,
    promoCode: "FIRST10AUG26",
    promoLabel: "First Detail Offer",
    taxCents,
    taxRateBp,
    totalCents: taxable + taxCents,
    depositPaidCents: opts.depositPaidCents ?? 0,
    durationMin: 60,
  });
  await db().insert(schema.appointmentServices).values({
    id: newId("aps"),
    appointmentId,
    serviceId: opts.serviceId,
    description: "Booked package",
    priceCents: opts.priceCents,
    durationMin: 60,
    sort: 0,
  });
  return appointmentId;
}

async function jobFor(appointmentId: string, status = "in_progress") {
  const jobId = newId("job");
  await db().insert(schema.jobs).values({
    id: jobId,
    appointmentId,
    customerId,
    vehicleId,
    status,
  });
  return jobId;
}

beforeEach(async () => {
  await db().execute(
    `TRUNCATE invoice_line_items, invoice_jobs, payments, invoices, additional_work_requests,
     jobs, appointment_services, appointments, vehicles, customers, audit_log, staff_users,
     invoice_counters, service_addons, addons, services, service_categories,
     business_settings RESTART IDENTITY CASCADE` as never,
  );
  await db().insert(schema.staffUsers).values({
    id: staff.id, name: staff.name, email: staff.email, passwordHash: "x", role: staff.role,
  });
  await db().insert(schema.invoiceCounters).values({ id: "default", nextNumber: 2000 });

  // The offer covers the two packages but deliberately NOT the coating, which
  // is what makes the "new package is not eligible" case testable.
  await db().insert(schema.businessSettings).values({
    key: "promotion",
    value: {
      ...SETTINGS_DEFAULTS.promotion,
      enabled: true,
      code: "FIRST10AUG26",
      label: "First Detail Offer",
      percentOffBp: 1000,
      eligibleServiceIds: [PKG1, PKG2],
      expiresOn: "",
    },
  } as never);

  await db().insert(schema.serviceCategories).values({ id: CATEGORY, name: "Packages", slug: "packages" });
  await db().insert(schema.services).values([
    { id: PKG1, categoryId: CATEGORY, name: "Package 1", slug: "package-1", basePriceCents: 9000, baseDurationMin: 60, bookingMode: "bookable", active: true },
    { id: PKG2, categoryId: CATEGORY, name: "Package 2", slug: "package-2", basePriceCents: 17500, baseDurationMin: 60, bookingMode: "bookable", active: true },
    { id: COATING, categoryId: CATEGORY, name: "Ceramic Coating", slug: "ceramic", basePriceCents: 80000, baseDurationMin: 240, bookingMode: "bookable", active: true },
  ] as never);

  customerId = newId("cus");
  await db().insert(schema.customers).values({
    id: customerId, firstName: "First", lastName: "Timer", email: "revision@example.com",
  });
  vehicleId = newId("veh");
  await db().insert(schema.vehicles).values({
    id: vehicleId, customerId, make: "Honda", model: "Civic", category: "sedan",
  });
});

afterAll(async () => {
  await getPool().end();
});

describe("reviseDiscountCents", () => {
  it("re-applies the offer to the new package", () => {
    expect(
      reviseDiscountCents({ mode: "reapply", reappliedCents: 2550, originalCents: 1750, newSubtotalCents: 25500 }),
    ).toBe(2550);
  });

  it("drops the discount when the new package is not on the offer", () => {
    expect(
      reviseDiscountCents({ mode: "reapply", reappliedCents: 0, originalCents: 1750, newSubtotalCents: 80000 }),
    ).toBe(0);
  });

  it("keeps the original cents as goodwill when asked", () => {
    expect(
      reviseDiscountCents({ mode: "keep", reappliedCents: 900, originalCents: 1750, newSubtotalCents: 9000 }),
    ).toBe(1750);
  });

  it("clamps a kept discount to the smaller new subtotal", () => {
    // The whole point of the clamp: $30 off a $9 package is not $-21.
    expect(
      reviseDiscountCents({ mode: "keep", reappliedCents: 0, originalCents: 3000, newSubtotalCents: 900 }),
    ).toBe(900);
  });

  it("removes the discount entirely", () => {
    expect(
      reviseDiscountCents({ mode: "remove", reappliedCents: 2550, originalCents: 1750, newSubtotalCents: 25500 }),
    ).toBe(0);
  });
});

describe("revisionDiscountReason", () => {
  it("records which choice a staff member made", () => {
    expect(revisionDiscountReason("reapply", "First Detail Offer", "upgraded at counter"))
      .toBe("First Detail Offer — re-applied to revised package (upgraded at counter)");
    expect(revisionDiscountReason("keep", "First Detail Offer", "goodwill"))
      .toBe("First Detail Offer — original amount kept on revised package (goodwill)");
    expect(revisionDiscountReason("remove", "First Detail Offer", "n/a")).toBeNull();
  });
});

describe("buildAttentionQueue", () => {
  it("surfaces a deposit a downgrade left the shop holding", () => {
    const queue = buildAttentionQueue({
      uninvoicedJobs: [],
      refundableDeposits: [{ id: "apt_1", vehicleLabel: "Honda Civic", refundableCents: 4830 }],
    });
    expect(queue.refundableDeposits).toBe(1);
    expect(queue.total).toBe(1);
    expect(queue.items[0].detail).toContain("$48.30");
    expect(queue.items[0].href).toBe("/admin/appointments/apt_1");
  });
});

describe("reviseAppointmentLinesAction", () => {
  it("upgrades the package and re-prices the offer against the new price", async () => {
    const appointmentId = await bookedAppointment({ serviceId: PKG1, priceCents: 9000, discountCents: 900 });
    await jobFor(appointmentId);

    const res = await reviseAppointmentLinesAction({
      appointmentId, serviceIds: [PKG2], addonIds: [], customLines: [],
      discountMode: "reapply", reason: "customer upgraded at the counter",
    });
    expect(res.ok).toBe(true);

    const [appt] = await db().select().from(schema.appointments).where(eq(schema.appointments.id, appointmentId));
    expect(appt.subtotalCents).toBe(17500);
    // 10% of the NEW price, not the $9.00 locked against Package 1.
    expect(appt.discountCents).toBe(1750);
    expect(appt.taxCents).toBe(2048); // 13% of $157.50
    expect(appt.totalCents).toBe(17798);
    // The ad that produced the booking is untouched by the package change.
    expect(appt.promoCode).toBe("FIRST10AUG26");
    expect(appt.revisedAt).not.toBeNull();
    expect(appt.originalSubtotalCents).toBe(9000);

    const lines = await db().select().from(schema.appointmentServices)
      .where(eq(schema.appointmentServices.appointmentId, appointmentId));
    expect(lines).toHaveLength(1);
    expect(lines[0].serviceId).toBe(PKG2);
  });

  it("drops the discount when the customer swaps to a package the offer never covered", async () => {
    const appointmentId = await bookedAppointment({ serviceId: PKG2, priceCents: 17500, discountCents: 1750 });
    await jobFor(appointmentId);

    const res = await reviseAppointmentLinesAction({
      appointmentId, serviceIds: [COATING], addonIds: [], customLines: [],
      discountMode: "reapply", reason: "switched to coating",
    });
    expect(res.ok).toBe(true);

    const [appt] = await db().select().from(schema.appointments).where(eq(schema.appointments.id, appointmentId));
    expect(appt.subtotalCents).toBe(80000);
    expect(appt.discountCents).toBe(0);
  });

  it("keeps a zero-rated booking zero-rated through a revision", async () => {
    // The `??`-not-`||` trap: settings say 13%, this appointment says 0.
    const appointmentId = await bookedAppointment({ serviceId: PKG1, priceCents: 9000, taxRateBp: 0 });
    await jobFor(appointmentId);

    const res = await reviseAppointmentLinesAction({
      appointmentId, serviceIds: [PKG2], addonIds: [], customLines: [],
      discountMode: "remove", reason: "upgraded",
    });
    expect(res.ok).toBe(true);

    const [appt] = await db().select().from(schema.appointments).where(eq(schema.appointments.id, appointmentId));
    expect(appt.taxRateBp).toBe(0);
    expect(appt.taxCents).toBe(0);
    expect(appt.totalCents).toBe(17500);
  });

  it("rebuilds an existing draft invoice in place, keeping its number", async () => {
    const appointmentId = await bookedAppointment({ serviceId: PKG2, priceCents: 17500, discountCents: 1750 });
    const jobId = await jobFor(appointmentId, "ready_for_pickup");
    const invoiceRes = await createInvoiceFromJobAction({ jobId });
    expect(invoiceRes.ok).toBe(true);
    if (!invoiceRes.ok) return;
    const [before] = await db().select().from(schema.invoices).where(eq(schema.invoices.id, invoiceRes.invoiceId));

    const res = await reviseAppointmentLinesAction({
      appointmentId, serviceIds: [PKG1], addonIds: [], customLines: [],
      discountMode: "reapply", reason: "downgraded at the counter",
    });
    expect(res.ok).toBe(true);

    const [after] = await db().select().from(schema.invoices).where(eq(schema.invoices.id, invoiceRes.invoiceId));
    expect(after.number).toBe(before.number);
    expect(after.subtotalCents).toBe(9000);
    expect(after.discountCents).toBe(900);
    expect(after.totalCents).toBe(9153); // $90 − $9 + 13%
    expect(after.discountReason).toContain("re-applied to revised package");

    const lines = await db().select().from(schema.invoiceLineItems)
      .where(eq(schema.invoiceLineItems.invoiceId, invoiceRes.invoiceId));
    expect(lines).toHaveLength(1);
    expect(lines[0].unitPriceCents).toBe(9000);

    // The job link survives, which is the whole reason for rebuilding rather
    // than raising a fresh manual invoice.
    const joins = await db().select().from(schema.invoiceJobs)
      .where(eq(schema.invoiceJobs.invoiceId, invoiceRes.invoiceId));
    expect(joins).toHaveLength(1);
  });

  it("refuses to change packages once the invoice has been sent", async () => {
    const appointmentId = await bookedAppointment({ serviceId: PKG2, priceCents: 17500 });
    const jobId = await jobFor(appointmentId, "ready_for_pickup");
    const invoiceRes = await createInvoiceFromJobAction({ jobId });
    if (!invoiceRes.ok) return;
    await db().update(schema.invoices).set({ status: "sent" })
      .where(eq(schema.invoices.id, invoiceRes.invoiceId));

    const res = await reviseAppointmentLinesAction({
      appointmentId, serviceIds: [PKG1], addonIds: [], customLines: [],
      discountMode: "reapply", reason: "downgraded",
    });
    expect(res.ok).toBe(false);
    if (res.ok || "needsOverlapConfirm" in res) return;
    expect(res.error).toContain("cancel it before changing the packages");
  });

  it("reports the deposit a downgrade leaves stranded", async () => {
    const appointmentId = await bookedAppointment({
      serviceId: PKG2, priceCents: 17500, depositPaidCents: 15000,
    });
    await jobFor(appointmentId);

    const res = await reviseAppointmentLinesAction({
      appointmentId, serviceIds: [PKG1], addonIds: [], customLines: [],
      discountMode: "remove", reason: "downgraded to package 1",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // $90 + 13% = $101.70 owed against $150.00 held.
    expect(res.depositRefundableCents).toBe(4830);
    expect(res.warnings.join(" ")).toContain("refund is owed");
  });

  it("warns rather than blocks when the longer job runs into the next booking", async () => {
    const bayId = newId("res");
    await db().insert(schema.resources).values({ id: bayId, name: "Bay 1", type: "bay", active: true } as never);
    const appointmentId = await bookedAppointment({ serviceId: PKG1, priceCents: 9000 });
    await db().update(schema.appointments).set({ resourceId: bayId })
      .where(eq(schema.appointments.id, appointmentId));
    await jobFor(appointmentId);

    // The next car in the same bay, starting right after the current booking.
    const [current] = await db().select().from(schema.appointments)
      .where(eq(schema.appointments.id, appointmentId));
    const nextId = newId("apt");
    await db().insert(schema.appointments).values({
      id: nextId, customerId, vehicleId, status: "confirmed", resourceId: bayId,
      startsAt: current.endsAt,
      endsAt: new Date(current.endsAt.getTime() + 90 * 60_000),
      subtotalCents: 9000, taxCents: 1170, taxRateBp: 1300, totalCents: 10170, durationMin: 60,
    });

    // Coating is 240 minutes — far past the next booking's start.
    const blocked = await reviseAppointmentLinesAction({
      appointmentId, serviceIds: [COATING], addonIds: [], customLines: [],
      discountMode: "remove", reason: "upgraded to coating",
    });
    expect(blocked.ok).toBe(false);
    if (blocked.ok || !("needsOverlapConfirm" in blocked)) throw new Error("expected an overlap warning");
    expect(blocked.warnings.join(" ")).toContain("next booking");

    // Nothing was written by the refused attempt.
    const [untouched] = await db().select().from(schema.appointments)
      .where(eq(schema.appointments.id, appointmentId));
    expect(untouched.subtotalCents).toBe(9000);

    const confirmed = await reviseAppointmentLinesAction({
      appointmentId, serviceIds: [COATING], addonIds: [], customLines: [],
      discountMode: "remove", reason: "upgraded to coating", confirmOverlap: true,
    });
    expect(confirmed.ok).toBe(true);
    const [revised] = await db().select().from(schema.appointments)
      .where(eq(schema.appointments.id, appointmentId));
    expect(revised.subtotalCents).toBe(80000);
  });

  it("preserves hand-priced custom lines the panel carries forward", async () => {
    const appointmentId = await bookedAppointment({ serviceId: PKG1, priceCents: 9000 });
    await jobFor(appointmentId);

    const res = await reviseAppointmentLinesAction({
      appointmentId,
      serviceIds: [PKG2],
      addonIds: [],
      customLines: [{ description: "Pet hair removal", priceCents: 4000, durationMin: 30 }],
      discountMode: "reapply",
      reason: "upgraded plus extra",
    });
    expect(res.ok).toBe(true);

    const lines = await db().select().from(schema.appointmentServices)
      .where(eq(schema.appointmentServices.appointmentId, appointmentId));
    expect(lines).toHaveLength(2);
    const custom = lines.find((l) => l.serviceId === null);
    expect(custom?.description).toBe("Pet hair removal");
    // The promotion matches on service_id, so it can never reach a custom line:
    // 10% of $175, not of $215.
    const [appt] = await db().select().from(schema.appointments)
      .where(eq(schema.appointments.id, appointmentId));
    expect(appt.subtotalCents).toBe(21500);
    expect(appt.discountCents).toBe(1750);
  });
});

describe("refundAppointmentDepositAction", () => {
  it("refunds against the appointment and leaves the invoice settled", async () => {
    const appointmentId = await bookedAppointment({
      serviceId: PKG2, priceCents: 17500, depositPaidCents: 15000,
    });
    const jobId = await jobFor(appointmentId, "ready_for_pickup");
    await reviseAppointmentLinesAction({
      appointmentId, serviceIds: [PKG1], addonIds: [], customLines: [],
      discountMode: "remove", reason: "downgraded",
    });
    const invoiceRes = await createInvoiceFromJobAction({ jobId });
    expect(invoiceRes.ok).toBe(true);
    if (!invoiceRes.ok) return;

    const refund = await refundAppointmentDepositAction({
      appointmentId, method: "cash", amountCents: 4830,
      reason: "downgrade at counter", idempotencyKey: "revision-refund-test-1",
    });
    expect(refund.ok).toBe(true);

    const [appt] = await db().select().from(schema.appointments)
      .where(eq(schema.appointments.id, appointmentId));
    expect(appt.depositPaidCents).toBe(10170);

    // The refund row belongs to the appointment, NOT the invoice. Routing it
    // through the invoice would drive netPaidCents below the total and reopen
    // a settled document.
    const [payment] = await db().select().from(schema.payments)
      .where(eq(schema.payments.appointmentId, appointmentId));
    expect(payment.kind).toBe("refund");
    expect(payment.invoiceId).toBeNull();

    const [invoice] = await db().select().from(schema.invoices)
      .where(eq(schema.invoices.id, invoiceRes.invoiceId));
    expect(invoice.depositAppliedCents).toBe(10170);
    expect(invoice.totalCents).toBe(10170);
  });

  it("is idempotent on a double press", async () => {
    const appointmentId = await bookedAppointment({
      serviceId: PKG2, priceCents: 17500, depositPaidCents: 15000,
    });
    const args = {
      appointmentId, method: "cash" as const, amountCents: 1000,
      reason: "overpaid", idempotencyKey: "revision-refund-test-2",
    };
    expect((await refundAppointmentDepositAction(args)).ok).toBe(true);
    expect((await refundAppointmentDepositAction(args)).ok).toBe(true);

    const [appt] = await db().select().from(schema.appointments)
      .where(eq(schema.appointments.id, appointmentId));
    expect(appt.depositPaidCents).toBe(14000);
  });

  it("refuses to refund more deposit than is held", async () => {
    const appointmentId = await bookedAppointment({
      serviceId: PKG2, priceCents: 17500, depositPaidCents: 5000,
    });
    const res = await refundAppointmentDepositAction({
      appointmentId, method: "cash", amountCents: 9000,
      reason: "typo", idempotencyKey: "revision-refund-test-3",
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("more than the deposit");
  });
});
