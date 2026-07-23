import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db, getPool, schema } from "../src/db";
import { newId } from "../src/lib/id";
import { SETTINGS_DEFAULTS, type BusinessSettings } from "../src/lib/settings";
import { zonedToUtc, zonedWeekday } from "../src/lib/tz";
import { createAppointment, createStaffAppointment, type BookingRequest } from "../src/lib/booking/create";
import { rescheduleAppointment } from "../src/lib/booking/reschedule";
import type { BookingPricing } from "../src/lib/pricing";
import {
  createCustomerPortalToken,
  portalOwnsCustomer,
  resolveCustomerPortalToken,
} from "../src/lib/portal";

/**
 * Integration tests against the real test database (TEST_DATABASE_URL):
 * verifies the FOR UPDATE locking strategy actually prevents double-booking
 * under concurrency.
 */

const settings: BusinessSettings = { ...SETTINGS_DEFAULTS };
const tz = settings.timezone;

// A booking date ~10 days out (inside notice + window rules).
const target = new Date(Date.now() + 10 * 86_400_000);
const y = target.getUTCFullYear();
const m = target.getUTCMonth() + 1;
const d = target.getUTCDate();
const dateISO = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const weekday = zonedWeekday(tz, y, m, d);
const openUtc = zonedToUtc(tz, y, m, d, 9, 0);

const pricing: BookingPricing = {
  lines: [{ description: "Test Detail", priceCents: 10000, durationMin: 60 }],
  subtotalCents: 10000,
  taxCents: 1300,
  taxRateBp: 1300,
  totalCents: 11300,
  depositRequiredCents: 0,
  durationMin: 60, // + 15 setup + 15 cleanup = 90 total
  requiredSkills: [],
};

function request(n: number): BookingRequest {
  return {
    customer: { firstName: "Test", lastName: `Customer${n}`, email: `t${n}@example.com` },
    vehicle: { make: "Honda", model: "Civic", category: "sedan" },
    pricing,
    dateISO,
    startMs: openUtc.getTime(),
    policiesAccepted: true,
    settings,
  };
}

async function resetDb(bayCount: number) {
  await db().execute(sql`
    TRUNCATE appointment_services, appointments, vehicles, customers, audit_log,
             schedule_blocks, staff_schedules, staff_users, resources, business_hours, service_addons,
             service_vehicle_adjustments, services, service_categories, addons CASCADE
  `);
  for (let i = 0; i < bayCount; i++) {
    await db().insert(schema.resources).values({ id: newId("res"), name: `Bay ${i + 1}`, type: "bay" });
  }
  await db().insert(schema.businessHours).values({
    id: newId("blk"),
    weekday,
    open: "09:00",
    close: "17:00",
    closed: false,
  });
  await db().insert(schema.serviceCategories).values({ id: "cat_booking_test", name: "Booking Test", slug: "booking-test" });
  await db().insert(schema.services).values({
    id: "svc_booking_test",
    categoryId: "cat_booking_test",
    name: "Test Detail",
    slug: "test-detail",
    basePriceCents: 10000,
    baseDurationMin: 60,
    bookingMode: "bookable",
  });
}

describe("createAppointment concurrency", () => {
  afterAll(async () => {
    await getPool().end();
  });

  beforeEach(async () => {
    await resetDb(2);
  });

  it("creates and resolves a reusable customer portal token", async () => {
    const customerId = newId("cus");
    await db().insert(schema.customers).values({
      id: customerId,
      firstName: "Fleet",
      lastName: "Manager",
      email: "fleet@example.com",
    });
    const raw = await createCustomerPortalToken(db(), {
      customerId,
      expiresAt: new Date(Date.now() + 86_400_000),
    });

    const first = await resolveCustomerPortalToken(raw);
    const second = await resolveCustomerPortalToken(raw);
    expect(first?.customer.id).toBe(customerId);
    expect(second?.customer.id).toBe(customerId);
    expect(first?.token.usedAt).toBeNull();
  });

  it("revokes prior portal tokens and rejects cross-customer ownership", async () => {
    const customerId = newId("cus");
    await db().insert(schema.customers).values({ id: customerId, firstName: "A", lastName: "Customer" });
    const oldToken = await createCustomerPortalToken(db(), {
      customerId,
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    const currentToken = await createCustomerPortalToken(db(), {
      customerId,
      expiresAt: new Date(Date.now() + 86_400_000),
    });

    expect(await resolveCustomerPortalToken(oldToken)).toBeNull();
    expect((await resolveCustomerPortalToken(currentToken))?.customer.id).toBe(customerId);
    expect(portalOwnsCustomer(customerId, customerId)).toBe(true);
    expect(portalOwnsCustomer(customerId, newId("cus"))).toBe(false);
  });

  it("rejects expired customer portal tokens", async () => {
    const customerId = newId("cus");
    await db().insert(schema.customers).values({ id: customerId, firstName: "Expired", lastName: "Link" });
    const raw = await createCustomerPortalToken(db(), {
      customerId,
      expiresAt: new Date(Date.now() - 1_000),
    });
    expect(await resolveCustomerPortalToken(raw)).toBeNull();
  });

  it("books a valid slot and snapshots pricing", async () => {
    const res = await createAppointment(request(1));
    expect(res.status).toBe("confirmed");
    const appts = await db().select().from(schema.appointments);
    expect(appts).toHaveLength(1);
    expect(appts[0].totalCents).toBe(11300);
    expect(appts[0].resourceId).not.toBeNull();
    expect(appts[0].assignedStaffId).toBeNull();
    // 90 min total block: 15 setup + 60 work + 15 cleanup
    expect(appts[0].endsAt.getTime() - appts[0].startsAt.getTime()).toBe(90 * 60_000);
    const lines = await db().select().from(schema.appointmentServices);
    expect(lines).toHaveLength(1);
  });

  it("assigns an on-shift staff member with every required service skill", async () => {
    await db().update(schema.services).set({ requiredSkills: ["ceramic", "polishing"] });
    const partialId = newId("usr");
    const eligibleId = newId("usr");
    await db().insert(schema.staffUsers).values([
      {
        id: partialId,
        name: "Partial Technician",
        email: `${partialId}@example.com`,
        passwordHash: "test-only",
        role: "technician",
        skills: ["ceramic"],
      },
      {
        id: eligibleId,
        name: "Eligible Technician",
        email: `${eligibleId}@example.com`,
        passwordHash: "test-only",
        role: "technician",
        skills: ["polishing", "ceramic"],
      },
    ]);
    await db().insert(schema.staffSchedules).values([
      { id: newId("sch"), staffUserId: partialId, weekday, start: "09:00", end: "17:00" },
      { id: newId("sch"), staffUserId: eligibleId, weekday, start: "09:00", end: "17:00" },
    ]);

    const customerId = newId("cus");
    const vehicleId = newId("veh");
    await db().insert(schema.customers).values({
      id: customerId,
      firstName: "Skill",
      lastName: "Match",
      email: "skills@example.com",
    });
    await db().insert(schema.vehicles).values({
      id: vehicleId,
      customerId,
      make: "Honda",
      model: "Civic",
      category: "sedan",
    });

    const result = await createStaffAppointment({
      customerId,
      vehicleId,
      serviceIds: ["svc_booking_test"],
      addonIds: [],
      dateISO,
      startMs: openUtc.getTime(),
      settings,
      staffId: "usr_staff_test",
    });
    const [appointment] = await db().select().from(schema.appointments)
      .where(sql`${schema.appointments.id} = ${result.appointmentId}`);
    expect(appointment.assignedStaffId).toBe(eligibleId);
    const [entry] = await db().select().from(schema.auditLog)
      .where(sql`${schema.auditLog.entityId} = ${result.appointmentId}`);
    expect(entry.after).toMatchObject({
      assignedStaffId: eligibleId,
      requiredSkills: ["ceramic", "polishing"],
    });
  });

  it("serializes configured staff capacity so one technician cannot receive two simultaneous jobs", async () => {
    const technicianId = newId("usr");
    await db().insert(schema.staffUsers).values({
      id: technicianId,
      name: "Ceramic Technician",
      email: `${technicianId}@example.com`,
      passwordHash: "test-only",
      role: "technician",
      skills: ["ceramic"],
    });
    await db().insert(schema.staffSchedules).values({
      id: newId("sch"),
      staffUserId: technicianId,
      weekday,
      start: "09:00",
      end: "17:00",
    });
    const staffedPricing = { ...pricing, requiredSkills: ["ceramic"] };
    const attempts = await Promise.allSettled([
      createAppointment({ ...request(1), pricing: staffedPricing }),
      createAppointment({ ...request(2), pricing: staffedPricing }),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
    const appointments = await db().select().from(schema.appointments);
    expect(appointments).toHaveLength(1);
    expect(appointments[0].assignedStaffId).toBe(technicianId);
  });

  it("does not offer an otherwise eligible technician during approved time off", async () => {
    const technicianId = newId("usr");
    await db().insert(schema.staffUsers).values({
      id: technicianId,
      name: "Unavailable Technician",
      email: `${technicianId}@example.com`,
      passwordHash: "test-only",
      role: "technician",
      skills: ["ceramic"],
    });
    await db().insert(schema.staffSchedules).values({
      id: newId("sch"),
      staffUserId: technicianId,
      weekday,
      start: "09:00",
      end: "17:00",
    });
    await db().insert(schema.scheduleBlocks).values({
      id: newId("blk"),
      staffUserId: technicianId,
      startsAt: openUtc,
      endsAt: new Date(openUtc.getTime() + 2 * 60 * 60_000),
      reason: "Approved time off",
    });

    await expect(createAppointment({
      ...request(1),
      pricing: { ...pricing, requiredSkills: ["ceramic"] },
    })).rejects.toThrow(/no longer available/);
  });

  it("creates a staff booking for an existing customer and leaves policy acceptance null", async () => {
    const customerId = newId("cus");
    const vehicleId = newId("veh");
    await db().insert(schema.customers).values({ id: customerId, firstName: "Walk-in", lastName: "Customer" });
    await db().insert(schema.vehicles).values({
      id: vehicleId,
      customerId,
      make: "Ford",
      model: "Escape",
      category: "suv_small",
    });
    const result = await createStaffAppointment({
      customerId,
      vehicleId,
      serviceIds: ["svc_booking_test"],
      addonIds: [],
      dateISO,
      startMs: openUtc.getTime(),
      settings,
      staffId: "usr_staff_test",
    });

    const [appointment] = await db().select().from(schema.appointments).where(sql`${schema.appointments.id} = ${result.appointmentId}`);
    expect(appointment.customerId).toBe(customerId);
    expect(appointment.vehicleId).toBe(vehicleId);
    expect(appointment.policiesAcceptedAt).toBeNull();
    expect(appointment.totalCents).toBe(11300);
    const [entry] = await db().select().from(schema.auditLog).where(sql`${schema.auditLog.entityId} = ${result.appointmentId}`);
    expect(entry.actorType).toBe("staff");
    expect(entry.actorId).toBe("usr_staff_test");
  });

  it("rejects a staff booking when the vehicle belongs to another customer", async () => {
    const customerId = newId("cus");
    const otherCustomerId = newId("cus");
    const vehicleId = newId("veh");
    await db().insert(schema.customers).values([
      { id: customerId, firstName: "First", lastName: "Customer" },
      { id: otherCustomerId, firstName: "Other", lastName: "Customer" },
    ]);
    await db().insert(schema.vehicles).values({ id: vehicleId, customerId: otherCustomerId, make: "Honda", model: "Civic", category: "sedan" });
    await expect(createStaffAppointment({
      customerId,
      vehicleId,
      serviceIds: ["svc_booking_test"],
      addonIds: [],
      dateISO,
      startMs: openUtc.getTime(),
      settings,
      staffId: "usr_staff_test",
    })).rejects.toThrow(/does not belong/);
  });

  it("reschedules into its current slot by excluding itself and clears the reminder", async () => {
    const created = await createAppointment(request(1));
    await db().update(schema.appointments).set({ reminderSentAt: new Date() }).where(sql`${schema.appointments.id} = ${created.appointmentId}`);
    const moved = await rescheduleAppointment({
      appointmentId: created.appointmentId,
      dateISO,
      startMs: openUtc.getTime(),
      settings,
      staffId: "usr_staff_test",
    });
    const [appointment] = await db().select().from(schema.appointments).where(sql`${schema.appointments.id} = ${created.appointmentId}`);
    expect(moved.startsAt.getTime()).toBe(openUtc.getTime());
    expect(appointment.reminderSentAt).toBeNull();
    expect(appointment.status).toBe("confirmed");
    expect(appointment.policiesAcceptedAt).not.toBeNull();
    const entries = await db().select().from(schema.auditLog).where(sql`${schema.auditLog.entityId} = ${created.appointmentId}`);
    expect(entries.some((entry) => entry.action === "appointment.rescheduled" && entry.actorId === "usr_staff_test")).toBe(true);
  });

  it("rejects rescheduling over another appointment on a single bay", async () => {
    await resetDb(1);
    await createAppointment(request(1));
    const second = await createAppointment({
      ...request(2),
      startMs: zonedToUtc(tz, y, m, d, 10, 30).getTime(),
    });
    await expect(rescheduleAppointment({
      appointmentId: second.appointmentId,
      dateISO,
      startMs: openUtc.getTime(),
      settings,
      staffId: "usr_staff_test",
    })).rejects.toThrow(/no longer available/);
  });

  it("serializes concurrent reschedules so only one wins the last bay", async () => {
    await resetDb(1);
    const first = await createAppointment(request(1));
    const second = await createAppointment({
      ...request(2),
      startMs: zonedToUtc(tz, y, m, d, 10, 30).getTime(),
    });
    const targetMs = zonedToUtc(tz, y, m, d, 13, 0).getTime();
    const attempts = await Promise.allSettled([first.appointmentId, second.appointmentId].map((appointmentId) =>
      rescheduleAppointment({ appointmentId, dateISO, startMs: targetMs, settings, staffId: "usr_staff_test" }),
    ));
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
  });

  it("rejects a slot outside business hours", async () => {
    const bad = { ...request(1), startMs: zonedToUtc(tz, y, m, d, 6, 0).getTime() };
    await expect(createAppointment(bad)).rejects.toThrow(/no longer available/);
  });

  it("allows exactly as many concurrent bookings as there are bays", async () => {
    const attempts = await Promise.allSettled([1, 2, 3, 4, 5].map((n) => createAppointment(request(n))));
    const succeeded = attempts.filter((a) => a.status === "fulfilled");
    const failed = attempts.filter((a) => a.status === "rejected");
    expect(succeeded).toHaveLength(2); // 2 bays
    expect(failed).toHaveLength(3);
    const appts = await db().select().from(schema.appointments);
    expect(appts).toHaveLength(2);
    // Each booking got a distinct bay.
    expect(new Set(appts.map((a) => a.resourceId)).size).toBe(2);
  });

  it("serializes single-bay contention to exactly one booking", async () => {
    await resetDb(1);
    const attempts = await Promise.allSettled([1, 2, 3].map((n) => createAppointment(request(n))));
    expect(attempts.filter((a) => a.status === "fulfilled")).toHaveLength(1);
    expect(await db().select().from(schema.appointments)).toHaveLength(1);
  });

  it("rejects an overlapping later booking but allows an adjacent one", async () => {
    await resetDb(1);
    await createAppointment(request(1));
    // Overlaps the 9:00–10:30 block
    await expect(
      createAppointment({ ...request(2), startMs: zonedToUtc(tz, y, m, d, 10, 0).getTime() }),
    ).rejects.toThrow(/no longer available/);
    // 10:30 starts exactly at the previous block's end — allowed
    const adjacent = await createAppointment({
      ...request(3),
      startMs: zonedToUtc(tz, y, m, d, 10, 30).getTime(),
    });
    expect(adjacent.status).toBe("confirmed");
  });
});
