import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db, getPool, schema } from "../src/db";
import { newId } from "../src/lib/id";
import { SETTINGS_DEFAULTS, type BusinessSettings } from "../src/lib/settings";
import { localDateISO, zonedToUtc, zonedWeekday } from "../src/lib/tz";
import { createAppointment, createStaffAppointment } from "../src/lib/booking/create";
import { rescheduleAppointment } from "../src/lib/booking/reschedule";
import { getAvailableSlots } from "../src/lib/booking/availability";
import { priceBooking } from "../src/lib/pricing";
import {
  appointmentTimeLabel,
  appointmentWhenLabel,
  TIME_TO_BE_CONFIRMED_LABEL,
} from "../src/lib/appointment-time";
import { hidesWorkDuration, isDateOnlyBookingSlug } from "../src/lib/ceramic";

/**
 * Ceramic coating is booked by DATE; the shop rings the customer to agree the
 * time. The rules that would cost the shop money or double-sell the bay if
 * they broke:
 *
 *  - the customer path never books a coating into a slot, whatever it submits
 *  - a coating reserves nothing, so the date has no ceiling and a detail can
 *    still be booked that morning
 *  - omitting the time is not a way to skip the availability check on an
 *    ordinary service
 *  - once staff agree a time, the booking becomes an ordinary one and holds
 *    the bay like any other
 */

const settings: BusinessSettings = { ...SETTINGS_DEFAULTS };
const tz = settings.timezone;

// Ten days out: comfortably inside the notice and booking-window rules.
const target = new Date(Date.now() + 10 * 86_400_000);
const y = target.getUTCFullYear();
const m = target.getUTCMonth() + 1;
const d = target.getUTCDate();
const dateISO = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const weekday = zonedWeekday(tz, y, m, d);
const openUtc = zonedToUtc(tz, y, m, d, 9, 0);

const COATING = "svc_coating_test";
const DETAIL = "svc_detail_test";

async function seed() {
  await db().execute(sql`
    TRUNCATE appointment_services, appointments, vehicles, customers, audit_log,
             schedule_blocks, staff_schedules, staff_users, resources, business_hours,
             service_addons, service_vehicle_adjustments, services, service_categories,
             addons CASCADE
  `);
  await db().insert(schema.resources).values({ id: newId("res"), name: "Bay 1", type: "bay" });
  await db().insert(schema.businessHours).values({
    id: newId("blk"),
    weekday,
    open: "09:00",
    close: "18:00",
    closed: false,
  });
  await db().insert(schema.serviceCategories).values({
    id: "cat_date_only_test",
    name: "Date-only Test",
    slug: "date-only-test",
  });
  await db().insert(schema.services).values([
    {
      id: COATING,
      categoryId: "cat_date_only_test",
      name: "Ceramic Coating - Pro",
      slug: "ceramic-coating-pro",
      basePriceCents: 99900,
      baseDurationMin: 420,
      bookingMode: "bookable",
    },
    {
      id: DETAIL,
      categoryId: "cat_date_only_test",
      name: "Test Detail",
      slug: "test-detail",
      basePriceCents: 10000,
      baseDurationMin: 60,
      bookingMode: "bookable",
    },
  ]);
}

async function book(serviceId: string, n: number, startMs: number | null) {
  const pricing = await priceBooking({
    serviceIds: [serviceId],
    addonIds: [],
    vehicleCategory: "sedan",
    settings,
  });
  return createAppointment({
    customer: { firstName: "Coating", lastName: `Customer${n}`, email: `c${n}@example.com` },
    vehicle: { make: "Honda", model: "Civic", category: "sedan" },
    pricing,
    dateISO,
    startMs,
    policiesAccepted: true,
    settings,
  });
}

async function appointmentRow(id: string) {
  const [row] = await db()
    .select()
    .from(schema.appointments)
    .where(sql`${schema.appointments.id} = ${id}`);
  return row;
}

describe("date-only booking", () => {
  afterAll(async () => {
    await getPool().end();
  });

  beforeEach(async () => {
    await seed();
  });

  it("treats coating packages, and only coating packages, as date-only", () => {
    expect(isDateOnlyBookingSlug("ceramic-coating-crystal")).toBe(true);
    expect(isDateOnlyBookingSlug("ceramic-coating-pro")).toBe(true);
    expect(isDateOnlyBookingSlug("ceramic-coating-max")).toBe(true);
    // Ceramic protection is a two-hour job that still fits an ordinary slot.
    expect(isDateOnlyBookingSlug("ceramic-protection")).toBe(false);
    expect(isDateOnlyBookingSlug("complete-detail-engine")).toBe(false);
  });

  it("quotes no working duration for a coating, and still quotes one elsewhere", () => {
    // The hours behind a coating are a scheduling fact: the day is sequenced
    // by hand, so printing "approx. 7h of work" beside the price reads as a
    // collection time nobody promised.
    for (const slug of ["ceramic-coating-crystal", "ceramic-coating-pro", "ceramic-coating-max"]) {
      expect(hidesWorkDuration(slug)).toBe(true);
    }
    expect(hidesWorkDuration("ceramic-protection")).toBe(false);
    expect(hidesWorkDuration("complete-detail-engine")).toBe(false);
  });

  it("books a coating against the date, holding no bay and no time", async () => {
    const result = await book(COATING, 1, null);
    expect(result.timeToBeConfirmed).toBe(true);

    const appointment = await appointmentRow(result.appointmentId);
    expect(appointment.timeToBeConfirmed).toBe(true);
    expect(appointment.resourceId).toBeNull();
    expect(appointment.assignedStaffId).toBeNull();
    // Stored at opening purely so the row sits on the right calendar day.
    expect(appointment.startsAt.getTime()).toBe(openUtc.getTime());
    expect(appointment.status).toBe("confirmed");
  });

  it("ignores a start time submitted for a coating rather than honouring it", async () => {
    // A hand-built request, or a stale tab: the catalogue decides, not the form.
    const result = await book(COATING, 2, openUtc.getTime() + 3 * 3600_000);
    expect(result.timeToBeConfirmed).toBe(true);
    const appointment = await appointmentRow(result.appointmentId);
    expect(appointment.startsAt.getTime()).toBe(openUtc.getTime());
    expect(appointment.resourceId).toBeNull();
  });

  it("takes as many coatings on one date as the shop is offered", async () => {
    // One bay, and a 450-minute block that would otherwise leave room for a
    // single coating in the day.
    for (let n = 0; n < 4; n++) {
      const result = await book(COATING, 10 + n, null);
      expect(result.timeToBeConfirmed).toBe(true);
    }
    const rows = await db().select().from(schema.appointments);
    expect(rows).toHaveLength(4);
    expect(rows.every((row) => row.timeToBeConfirmed)).toBe(true);
  });

  it("leaves the day's real availability untouched", async () => {
    const before = await getAvailableSlots({ dateISO, workDurationMin: 60, settings });
    await book(COATING, 20, null);
    await book(COATING, 21, null);
    const after = await getAvailableSlots({ dateISO, workDurationMin: 60, settings });

    expect(before.length).toBeGreaterThan(0);
    expect(after.map((slot) => slot.start)).toEqual(before.map((slot) => slot.start));

    // And a detail can still be booked into the morning the coatings nominally
    // start in — they were never holding it.
    const detail = await book(DETAIL, 22, openUtc.getTime());
    const row = await appointmentRow(detail.appointmentId);
    expect(row.timeToBeConfirmed).toBe(false);
    expect(row.resourceId).not.toBeNull();
  });

  it("refuses an ordinary service submitted without a time", async () => {
    // Otherwise dropping the field would be a way past the slot check.
    await expect(book(DETAIL, 30, null)).rejects.toThrow(/choose an appointment time/i);
  });

  it("refuses a coating on a day the shop is closed", async () => {
    await db().update(schema.businessHours).set({ closed: true });
    await expect(book(COATING, 40, null)).rejects.toThrow(/closed on that date/i);
  });

  it("refuses a coating date that is not still ahead", async () => {
    const today = localDateISO(tz, 0);
    const [ty, tm, td] = today.split("-").map(Number);
    await db().update(schema.businessHours).set({ weekday: zonedWeekday(tz, ty, tm, td) });
    const pricing = await priceBooking({
      serviceIds: [COATING],
      addonIds: [],
      vehicleCategory: "sedan",
      settings,
    });
    await expect(
      createAppointment({
        customer: { firstName: "Same", lastName: "Day", email: "sameday@example.com" },
        vehicle: { make: "Honda", model: "Civic", category: "sedan" },
        pricing,
        dateISO: today,
        startMs: null,
        policiesAccepted: true,
        settings,
      }),
    ).rejects.toThrow(/from tomorrow onwards/i);
  });

  it("refuses a coating on a date blocked out for the whole working day", async () => {
    await db().insert(schema.scheduleBlocks).values({
      id: newId("blk"),
      startsAt: zonedToUtc(tz, y, m, d, 0, 0),
      endsAt: zonedToUtc(tz, y, m, d, 23, 59),
      reason: "Statutory holiday",
    });
    await expect(book(COATING, 50, null)).rejects.toThrow(/closed on that date/i);
  });

  it("becomes an ordinary booking once staff agree a time", async () => {
    const result = await book(COATING, 60, null);
    const moved = await rescheduleAppointment({
      appointmentId: result.appointmentId,
      dateISO,
      startMs: openUtc.getTime(),
      settings,
      staffId: "usr_staff_test",
    });

    const appointment = await appointmentRow(moved.appointmentId);
    expect(appointment.timeToBeConfirmed).toBe(false);
    expect(appointment.resourceId).not.toBeNull();
    expect(appointment.startsAt.getTime()).toBe(openUtc.getTime());

    // Now that it holds the bay, that morning is genuinely gone.
    await expect(book(DETAIL, 61, openUtc.getTime())).rejects.toThrow(/no longer available/i);
  });

  it("lets staff book a coating into a real slot they have already agreed", async () => {
    const customerId = newId("cus");
    const vehicleId = newId("veh");
    await db().insert(schema.customers).values({ id: customerId, firstName: "Booked", lastName: "ByPhone" });
    await db().insert(schema.vehicles).values({
      id: vehicleId,
      customerId,
      make: "Tesla",
      model: "Model 3",
      category: "sedan",
    });
    const result = await createStaffAppointment({
      customerId,
      vehicleId,
      serviceIds: [COATING],
      addonIds: [],
      dateISO,
      startMs: openUtc.getTime(),
      settings,
      staffId: "usr_staff_test",
    });

    const appointment = await appointmentRow(result.appointmentId);
    expect(appointment.timeToBeConfirmed).toBe(false);
    expect(appointment.resourceId).not.toBeNull();
  });
});

describe("appointment time labels", () => {
  const startsAt = zonedToUtc(tz, 2026, 9, 12, 14, 0);

  it("prints the time only when there is one to print", () => {
    expect(appointmentTimeLabel({ startsAt, timeToBeConfirmed: false }, tz)).toMatch(/2:00/);
    expect(appointmentTimeLabel({ startsAt, timeToBeConfirmed: true }, tz)).toBe(
      TIME_TO_BE_CONFIRMED_LABEL,
    );
  });

  it("keeps the date and replaces the time in a combined label", () => {
    const dateOptions = { month: "short", day: "numeric" } as const;
    expect(appointmentWhenLabel({ startsAt, timeToBeConfirmed: false }, tz, dateOptions)).toMatch(
      /Sep 12, 2:00/,
    );
    const pending = appointmentWhenLabel({ startsAt, timeToBeConfirmed: true }, tz, dateOptions);
    expect(pending).toContain("Sep 12");
    expect(pending).toContain("time to be confirmed");
    expect(pending).not.toMatch(/2:00/);
  });
});
