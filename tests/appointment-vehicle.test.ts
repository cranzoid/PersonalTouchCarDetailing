import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

const staff = vi.hoisted(() => ({
  id: "usr_vehicle_change_test",
  name: "Test Owner",
  email: "vehicle-change@example.com",
  role: "owner" as const,
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({
  requireStaff: vi.fn(async () => staff),
  AuthError: class AuthError extends Error {},
}));

import { db, getPool, schema } from "../src/db";
import { newId } from "../src/lib/id";
import { updateAppointmentVehicleAction } from "../src/app/admin/(app)/appointments/actions";

/**
 * The customer picks their own vehicle size on the public booking form, and
 * gets it wrong. A large SUV booked as a sedan is PRICED as a sedan, because
 * package prices come from service_vehicle_adjustments keyed on that category.
 *
 * Correcting the vehicle therefore has to do two things at once: fix the car on
 * the customer's record, and re-price the packages already on the booking for
 * the size it really is — without changing WHICH packages were chosen.
 */

const CATEGORY = "cat_vehicle_change";
const PKG = "svc_pkg_vehicle_change";
const SUV_DELTA = 4000;

let customerId: string;
let sedanId: string;

async function bookedAppointment(status = "converted") {
  const appointmentId = newId("apt");
  const startsAt = new Date(Date.now() + 3_600_000);
  await db().insert(schema.appointments).values({
    id: appointmentId,
    customerId,
    vehicleId: sedanId,
    status,
    startsAt,
    endsAt: new Date(startsAt.getTime() + 90 * 60_000),
    subtotalCents: 17500,
    discountCents: 0,
    taxCents: 2275,
    taxRateBp: 1300,
    totalCents: 19775,
    durationMin: 60,
  });
  await db().insert(schema.appointmentServices).values({
    id: newId("aps"),
    appointmentId,
    serviceId: PKG,
    description: "Package 2",
    priceCents: 17500,
    durationMin: 60,
    sort: 0,
  });
  return appointmentId;
}

async function anotherVehicle(category: string) {
  const id = newId("veh");
  await db().insert(schema.vehicles).values({
    id, customerId, make: "Ford", model: "F-150", category,
  });
  return id;
}

const suvDetails = {
  make: "Honda",
  model: "Pilot",
  category: "suv_large" as const,
};

beforeEach(async () => {
  await db().execute(
    `TRUNCATE invoice_line_items, invoice_jobs, payments, invoices, jobs, appointment_services,
     appointments, vehicles, customers, audit_log, staff_users, invoice_counters,
     service_vehicle_adjustments, service_addons, addons, services, service_categories,
     business_settings RESTART IDENTITY CASCADE` as never,
  );
  await db().insert(schema.staffUsers).values({
    id: staff.id, name: staff.name, email: staff.email, passwordHash: "x", role: staff.role,
  });
  await db().insert(schema.invoiceCounters).values({ id: "default", nextNumber: 3000 });
  await db().insert(schema.serviceCategories).values({ id: CATEGORY, name: "Packages", slug: "packages" });
  await db().insert(schema.services).values({
    id: PKG, categoryId: CATEGORY, name: "Package 2", slug: "package-2",
    basePriceCents: 17500, baseDurationMin: 60, bookingMode: "bookable", active: true,
  } as never);
  // A large SUV costs $40 more and takes half an hour longer than a sedan.
  await db().insert(schema.serviceVehicleAdjustments).values({
    id: newId("adj"), serviceId: PKG, vehicleCategory: "suv_large",
    priceDeltaCents: SUV_DELTA, durationDeltaMin: 30,
  });

  customerId = newId("cus");
  await db().insert(schema.customers).values({
    id: customerId, firstName: "Wrong", lastName: "Size", email: "size@example.com",
  });
  sedanId = newId("veh");
  await db().insert(schema.vehicles).values({
    id: sedanId, customerId, make: "Honda", model: "Civic", category: "sedan",
  });
});

afterAll(async () => {
  await getPool().end();
});

describe("updateAppointmentVehicleAction", () => {
  it("re-prices the booked package when the size is corrected", async () => {
    const appointmentId = await bookedAppointment();

    const result = await updateAppointmentVehicleAction({
      appointmentId,
      vehicleId: sedanId,
      details: suvDetails,
    });

    expect(result).toMatchObject({ ok: true, repriced: true });

    const [vehicle] = await db().select().from(schema.vehicles).where(eq(schema.vehicles.id, sedanId));
    expect(vehicle.category).toBe("suv_large");
    expect(vehicle.model).toBe("Pilot");

    const [appointment] = await db()
      .select().from(schema.appointments).where(eq(schema.appointments.id, appointmentId));
    expect(appointment.subtotalCents).toBe(17500 + SUV_DELTA);
    // Tax follows the new subtotal at the booking's own rate, not settings'.
    expect(appointment.taxCents).toBe(Math.round((17500 + SUV_DELTA) * 1300 / 10000));
    // The longer job needs more of the bay.
    expect(appointment.durationMin).toBe(90);
    // What the customer originally booked survives.
    expect(appointment.originalSubtotalCents).toBe(17500);
  });

  it("keeps the same packages — only their prices move", async () => {
    const appointmentId = await bookedAppointment();
    await updateAppointmentVehicleAction({ appointmentId, vehicleId: sedanId, details: suvDetails });

    const lines = await db()
      .select().from(schema.appointmentServices)
      .where(eq(schema.appointmentServices.appointmentId, appointmentId));
    expect(lines).toHaveLength(1);
    expect(lines[0].serviceId).toBe(PKG);
    expect(lines[0].priceCents).toBe(17500 + SUV_DELTA);
  });

  it("corrects colour and plate without touching the money", async () => {
    const appointmentId = await bookedAppointment();

    const result = await updateAppointmentVehicleAction({
      appointmentId,
      vehicleId: sedanId,
      details: { make: "Honda", model: "Civic", category: "sedan", colour: "Silver", licencePlate: "ABCD123" },
    });

    expect(result).toMatchObject({ ok: true, repriced: false });
    const [appointment] = await db()
      .select().from(schema.appointments).where(eq(schema.appointments.id, appointmentId));
    expect(appointment.subtotalCents).toBe(17500);
    // No revision happened at all, so the booking is not marked as revised.
    expect(appointment.revisedAt).toBeNull();
    const [vehicle] = await db().select().from(schema.vehicles).where(eq(schema.vehicles.id, sedanId));
    expect(vehicle.colour).toBe("Silver");
    expect(vehicle.licencePlate).toBe("ABCD123");
  });

  it("moves the booking, its job and its draft invoice onto another car", async () => {
    const appointmentId = await bookedAppointment();
    const truckId = await anotherVehicle("pickup");
    const jobId = newId("job");
    const invoiceId = newId("inv");
    await db().insert(schema.jobs).values({
      id: jobId, appointmentId, customerId, vehicleId: sedanId, status: "in_progress",
    });
    await db().insert(schema.invoices).values({
      id: invoiceId, number: 3001, customerId, vehicleId: sedanId, jobId, status: "draft",
      subtotalCents: 17500, taxRateBp: 1300, taxCents: 2275, totalCents: 19775,
    });
    await db().update(schema.jobs).set({ invoiceId }).where(eq(schema.jobs.id, jobId));

    const result = await updateAppointmentVehicleAction({ appointmentId, vehicleId: truckId });
    expect(result).toMatchObject({ ok: true });

    const [appointment] = await db()
      .select().from(schema.appointments).where(eq(schema.appointments.id, appointmentId));
    expect(appointment.vehicleId).toBe(truckId);
    const [job] = await db().select().from(schema.jobs).where(eq(schema.jobs.id, jobId));
    expect(job.vehicleId).toBe(truckId);
    // The invoice must not go out describing a car that was never here.
    const [invoice] = await db().select().from(schema.invoices).where(eq(schema.invoices.id, invoiceId));
    expect(invoice.vehicleId).toBe(truckId);
  });

  it("saves the correction but leaves a settled sale's prices alone", async () => {
    const appointmentId = await bookedAppointment("completed");
    const jobId = newId("job");
    const invoiceId = newId("inv");
    await db().insert(schema.jobs).values({
      id: jobId, appointmentId, customerId, vehicleId: sedanId, status: "ready_for_pickup",
    });
    await db().insert(schema.invoices).values({
      id: invoiceId, number: 3002, customerId, vehicleId: sedanId, jobId, status: "paid",
      subtotalCents: 17500, taxRateBp: 1300, taxCents: 2275, totalCents: 19775,
    });
    await db().update(schema.jobs).set({ invoiceId }).where(eq(schema.jobs.id, jobId));

    const result = await updateAppointmentVehicleAction({
      appointmentId, vehicleId: sedanId, details: suvDetails,
    });

    expect(result).toMatchObject({ ok: true, repriced: false });
    if (!result.ok) throw new Error("expected ok");
    expect(result.warnings.join(" ")).toContain("#3002");

    // The car really is an SUV whether or not the sale can be re-priced.
    const [vehicle] = await db().select().from(schema.vehicles).where(eq(schema.vehicles.id, sedanId));
    expect(vehicle.category).toBe("suv_large");
    const [appointment] = await db()
      .select().from(schema.appointments).where(eq(schema.appointments.id, appointmentId));
    expect(appointment.subtotalCents).toBe(17500);
  });

  it("refuses a vehicle belonging to somebody else", async () => {
    const appointmentId = await bookedAppointment();
    const strangerId = newId("cus");
    await db().insert(schema.customers).values({ id: strangerId, firstName: "Some", lastName: "One" });
    const strangerVehicle = newId("veh");
    await db().insert(schema.vehicles).values({
      id: strangerVehicle, customerId: strangerId, make: "Kia", model: "Rio", category: "sedan",
    });

    const result = await updateAppointmentVehicleAction({ appointmentId, vehicleId: strangerVehicle });
    expect(result).toEqual({ ok: false, error: "Vehicle does not belong to this customer" });

    const [appointment] = await db()
      .select().from(schema.appointments).where(eq(schema.appointments.id, appointmentId));
    expect(appointment.vehicleId).toBe(sedanId);
  });

  it("records the size change in the audit log", async () => {
    const appointmentId = await bookedAppointment();
    await updateAppointmentVehicleAction({ appointmentId, vehicleId: sedanId, details: suvDetails });

    const [entry] = await db()
      .select().from(schema.auditLog)
      .where(eq(schema.auditLog.action, "appointment.vehicle_updated"));
    expect(entry.before).toMatchObject({ category: "sedan" });
    expect(entry.after).toMatchObject({ category: "suv_large", repriced: true });
  });
});
