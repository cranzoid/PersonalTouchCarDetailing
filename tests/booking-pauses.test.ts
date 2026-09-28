import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db, getPool, schema } from "../src/db";
import { newId } from "../src/lib/id";
import { SETTINGS_DEFAULTS, type BusinessSettings } from "../src/lib/settings";
import { zonedToUtc, zonedWeekday } from "../src/lib/tz";
import { createAppointment, createStaffAppointment } from "../src/lib/booking/create";
import { computeDaySlots, getAvailableSlots, type DayContext } from "../src/lib/booking/availability";
import {
  createBookingPause,
  endBookingPause,
  listCurrentBookingPauses,
  pauseEdgeLabel,
  PauseError,
  presetWindow,
} from "../src/lib/booking/pauses";
import { priceBooking } from "../src/lib/pricing";

/**
 * A booking pause is "take no more online bookings". What would cost the shop
 * if it broke:
 *
 *  - a customer can still book into a paused time (the whole point)
 *  - it can be put over a day that is already full (a closure cannot)
 *  - it stops staff booking, or touches an appointment already made
 */

const settings: BusinessSettings = { ...SETTINGS_DEFAULTS };
const tz = settings.timezone;
const HOUR = 3_600_000;

const target = new Date(Date.now() + 10 * 86_400_000);
const y = target.getUTCFullYear();
const m = target.getUTCMonth() + 1;
const d = target.getUTCDate();
const dateISO = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const weekday = zonedWeekday(tz, y, m, d);
const open = zonedToUtc(tz, y, m, d, 9, 0).getTime();
const close = zonedToUtc(tz, y, m, d, 18, 0).getTime();

const STAFF = "usr_pause_test";
const DETAIL = "svc_pause_detail";
const COATING = "svc_pause_coating";

async function seed() {
  await db().execute(sql`
    TRUNCATE booking_pauses, appointment_services, appointments, vehicles, customers, audit_log,
             schedule_blocks, staff_schedules, staff_users, resources, business_hours,
             service_addons, service_vehicle_adjustments, services, service_categories,
             addons CASCADE
  `);
  await db().insert(schema.staffUsers).values({
    id: STAFF,
    name: "Counter",
    email: "counter@example.com",
    passwordHash: "x",
    role: "reception",
  });
  await db().insert(schema.resources).values({ id: newId("res"), name: "Bay 1", type: "bay" });
  await db().insert(schema.businessHours).values({
    id: newId("blk"),
    weekday,
    open: "09:00",
    close: "18:00",
    closed: false,
  });
  await db().insert(schema.serviceCategories).values({ id: "cat_pause_test", name: "Pause Test", slug: "pause-test" });
  await db().insert(schema.services).values([
    {
      id: DETAIL,
      categoryId: "cat_pause_test",
      name: "Test Detail",
      slug: "test-detail",
      basePriceCents: 10000,
      baseDurationMin: 60,
      bookingMode: "bookable",
    },
    {
      id: COATING,
      categoryId: "cat_pause_test",
      name: "Ceramic Coating - Pro",
      slug: "ceramic-coating-pro",
      basePriceCents: 99900,
      baseDurationMin: 420,
      bookingMode: "bookable",
    },
  ]);
}

async function customerBooks(serviceId: string, n: number, startMs: number | null) {
  const pricing = await priceBooking({ serviceIds: [serviceId], addonIds: [], vehicleCategory: "sedan", settings });
  return createAppointment({
    customer: { firstName: "Pause", lastName: `Customer${n}`, email: `p${n}@example.com` },
    vehicle: { make: "Honda", model: "Civic", category: "sedan" },
    pricing,
    dateISO,
    startMs,
    policiesAccepted: true,
    settings,
  });
}

async function staffBooks(startMs: number) {
  const customerId = newId("cus");
  const vehicleId = newId("veh");
  await db().insert(schema.customers).values({ id: customerId, firstName: "Walk", lastName: "In" });
  await db().insert(schema.vehicles).values({ id: vehicleId, customerId, make: "Ford", model: "F-150", category: "sedan" });
  return createStaffAppointment({
    customerId,
    vehicleId,
    serviceIds: [DETAIL],
    addonIds: [],
    dateISO,
    startMs,
    settings,
    staffId: STAFF,
  });
}

function slotsFor(extra: Partial<DayContext>): number[] {
  return computeDaySlots({
    openMs: open,
    closeMs: close,
    granularityMin: 60,
    totalDurationMin: 60,
    nowMs: open - 48 * HOUR,
    minNoticeHours: 0,
    maxBookingWindowDays: 60,
    busyByBay: [[]],
    unassignedBusy: [],
    globalBlocks: [],
    staffingConfigured: false,
    staffCapacity: [],
    unassignedStaffBusy: [],
    requiredSkills: [],
    ...extra,
  }).map((slot) => slot.start);
}

describe("booking pause windows", () => {
  it("refuses any slot that overlaps a pause, and nothing else", () => {
    const all = slotsFor({});
    const paused = slotsFor({ bookingPauses: [{ start: open + 3 * HOUR, end: open + 5 * HOUR }] });
    expect(all).toHaveLength(9);
    expect(paused).toEqual(all.filter((start) => start < open + 3 * HOUR || start >= open + 5 * HOUR));
  });

  it("pauses the rest of today up to local midnight, and tomorrow as a whole local day", () => {
    const now = zonedToUtc(tz, 2026, 9, 28, 14, 30).getTime();
    const today = presetWindow("rest_of_today", tz, now);
    expect(today.startsAt.getTime()).toBe(now);
    expect(today.endsAt.getTime()).toBe(zonedToUtc(tz, 2026, 9, 29, 0, 0).getTime());

    const tomorrow = presetWindow("tomorrow", tz, now);
    expect(tomorrow.startsAt.getTime()).toBe(zonedToUtc(tz, 2026, 9, 29, 0, 0).getTime());
    expect(tomorrow.endsAt.getTime()).toBe(zonedToUtc(tz, 2026, 9, 30, 0, 0).getTime());
  });

  it("rolls over a month end", () => {
    const now = zonedToUtc(tz, 2026, 9, 30, 23, 0).getTime();
    expect(presetWindow("rest_of_today", tz, now).endsAt.getTime()).toBe(zonedToUtc(tz, 2026, 10, 1, 0, 0).getTime());
  });

  it("labels a midnight end as the end of the day before it", () => {
    expect(pauseEdgeLabel(zonedToUtc(tz, 2026, 9, 29, 0, 0), tz, true)).toMatch(/^end of Mon, Sep 28/);
    expect(pauseEdgeLabel(zonedToUtc(tz, 2026, 9, 29, 15, 0), tz, true)).toMatch(/Sep 29, 3:00/);
  });
});

describe("booking pauses", () => {
  afterAll(async () => {
    await db().execute(sql`TRUNCATE booking_pauses`);
    await getPool().end();
  });

  beforeEach(async () => {
    await seed();
  });

  it("can be put over time that already has an appointment, which stays booked", async () => {
    const booked = await customerBooks(DETAIL, 1, open);
    await createBookingPause({ startsAt: new Date(open), endsAt: new Date(close), staffId: STAFF });

    const [row] = await db().select().from(schema.appointments).where(eq(schema.appointments.id, booked.appointmentId));
    expect(row.status).toBe("confirmed");
    expect(row.startsAt.getTime()).toBe(open);
  });

  it("hides paused times from customers and refuses a customer booking into them", async () => {
    await createBookingPause({ startsAt: new Date(open + 2 * HOUR), endsAt: new Date(close), staffId: STAFF });

    const slots = await getAvailableSlots({ dateISO, workDurationMin: 60, settings });
    expect(slots.length).toBeGreaterThan(0);
    expect(slots.every((slot) => slot.end <= open + 2 * HOUR)).toBe(true);

    await expect(customerBooks(DETAIL, 2, open + 4 * HOUR)).rejects.toThrow(/no longer available/i);
    await expect(customerBooks(DETAIL, 3, open)).resolves.toMatchObject({ status: "confirmed" });
  });

  it("does not stop staff", async () => {
    await createBookingPause({ startsAt: new Date(open), endsAt: new Date(close), staffId: STAFF });

    const staffSlots = await getAvailableSlots({ dateISO, workDurationMin: 60, settings, ignoreBookingPauses: true });
    expect(staffSlots.length).toBeGreaterThan(0);
    await expect(staffBooks(open + 4 * HOUR)).resolves.toMatchObject({ status: "confirmed" });
  });

  it("stops a date-only coating only when it covers the whole working day", async () => {
    await createBookingPause({ startsAt: new Date(open + 4 * HOUR), endsAt: new Date(close), staffId: STAFF });
    await expect(customerBooks(COATING, 4, null)).resolves.toMatchObject({ timeToBeConfirmed: true });

    await createBookingPause({ startsAt: new Date(open), endsAt: new Date(close), staffId: STAFF });
    await expect(customerBooks(COATING, 5, null)).rejects.toThrow(/fully booked/i);
  });

  it("cuts a running pause short, keeping its record, and deletes one not yet started", async () => {
    const now = Date.now();
    const running = await createBookingPause({ startsAt: new Date(now - HOUR), endsAt: new Date(now + HOUR), staffId: STAFF });
    const upcoming = await createBookingPause({ startsAt: new Date(open), endsAt: new Date(close), staffId: STAFF });

    await endBookingPause({ pauseId: running.id, staffId: STAFF, nowMs: now });
    await endBookingPause({ pauseId: upcoming.id, staffId: STAFF, nowMs: now });

    const rows = await db().select().from(schema.bookingPauses);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(running.id);
    expect(rows[0].endsAt.getTime()).toBe(now);
    expect(await listCurrentBookingPauses(new Date(now))).toHaveLength(0);
    await expect(endBookingPause({ pauseId: running.id, staffId: STAFF, nowMs: now })).rejects.toThrow(PauseError);

    const actions = await db().select({ action: schema.auditLog.action }).from(schema.auditLog);
    expect(actions.map((a) => a.action).sort()).toEqual([
      "booking_pause.created",
      "booking_pause.created",
      "booking_pause.ended",
      "booking_pause.removed",
    ]);
  });

  it("refuses a pause that is backwards or already over", async () => {
    await expect(
      createBookingPause({ startsAt: new Date(close), endsAt: new Date(open), staffId: STAFF }),
    ).rejects.toThrow(PauseError);
    await expect(
      createBookingPause({ startsAt: new Date(Date.now() - 2 * HOUR), endsAt: new Date(Date.now() - HOUR), staffId: STAFF }),
    ).rejects.toThrow(PauseError);
  });
});
