import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db, getPool, schema } from "../src/db";
import { newId } from "../src/lib/id";
import { SETTINGS_DEFAULTS, type BusinessSettings } from "../src/lib/settings";
import { zonedToUtc, zonedWeekday } from "../src/lib/tz";
import { createAppointment, type BookingRequest } from "../src/lib/booking/create";
import type { BookingPricing } from "../src/lib/pricing";

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
             schedule_blocks, resources, business_hours CASCADE
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
}

describe("createAppointment concurrency", () => {
  afterAll(async () => {
    await getPool().end();
  });

  beforeEach(async () => {
    await resetDb(2);
  });

  it("books a valid slot and snapshots pricing", async () => {
    const res = await createAppointment(request(1));
    expect(res.status).toBe("confirmed");
    const appts = await db().select().from(schema.appointments);
    expect(appts).toHaveLength(1);
    expect(appts[0].totalCents).toBe(11300);
    expect(appts[0].resourceId).not.toBeNull();
    // 90 min total block: 15 setup + 60 work + 15 cleanup
    expect(appts[0].endsAt.getTime() - appts[0].startsAt.getTime()).toBe(90 * 60_000);
    const lines = await db().select().from(schema.appointmentServices);
    expect(lines).toHaveLength(1);
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
