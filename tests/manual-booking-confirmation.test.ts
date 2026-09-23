import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";

const staff = vi.hoisted(() => ({
  id: "usr_manual_confirm_test",
  name: "Test Owner",
  email: "manual-confirm@example.com",
  role: "owner" as const,
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({
  requireStaff: vi.fn(async () => staff),
  AuthError: class AuthError extends Error {},
}));

import { db, getPool, schema } from "../src/db";
import { newId } from "../src/lib/id";
import { SETTINGS_DEFAULTS } from "../src/lib/settings";
import { zonedToUtc, zonedWeekday } from "../src/lib/tz";
import { createManualAppointmentAction } from "../src/app/admin/(app)/appointments/actions";
import { isUpcomingForConfirmation, sendStaffBookingConfirmation } from "../src/lib/booking/confirmation";

/**
 * A booking staff take over the phone has to reach the customer the same way
 * an online booking does. Before this, the staff screen alerted staff and
 * nobody else, so the customer heard nothing until the day-before reminder.
 *
 * Sends are log-only outside production, so every assertion reads the
 * communications rows a send writes.
 */

const settings = { ...SETTINGS_DEFAULTS };
const tz = settings.timezone;

// Ten days out: inside the notice and booking-window rules.
const target = new Date(Date.now() + 10 * 86_400_000);
const y = target.getUTCFullYear();
const m = target.getUTCMonth() + 1;
const d = target.getUTCDate();
const dateISO = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const openUtc = zonedToUtc(tz, y, m, d, 9, 0);

let customerId: string;
let vehicleId: string;

beforeEach(async () => {
  await db().execute(sql`
    TRUNCATE communications, message_templates, appointment_services, appointments, vehicles, customers,
             audit_log, schedule_blocks, staff_schedules, staff_users, resources, business_hours,
             service_addons, service_vehicle_adjustments, services, service_categories, addons,
             business_settings CASCADE
  `);
  await db().insert(schema.staffUsers).values({
    id: staff.id, name: staff.name, email: staff.email, passwordHash: "x", role: staff.role,
  });
  await db().insert(schema.resources).values({ id: newId("res"), name: "Bay 1", type: "bay" });
  await db().insert(schema.businessHours).values({
    id: newId("blk"), weekday: zonedWeekday(tz, y, m, d), open: "09:00", close: "17:00", closed: false,
  });
  await db().insert(schema.serviceCategories).values({ id: "cat_confirm", name: "Packages", slug: "packages" });
  await db().insert(schema.services).values({
    id: "svc_confirm", categoryId: "cat_confirm", name: "Package 2", slug: "package-2",
    basePriceCents: 17500, baseDurationMin: 60, bookingMode: "bookable",
  });
  // The live wording, as seeded.
  await db().insert(schema.messageTemplates).values([
    {
      id: newId("tpl"), key: "booking_confirmation", channel: "email",
      subject: "Booking confirmed — {{businessName}}",
      body: "Hi {{firstName}},\n\nYour appointment on {{date}} at {{time}} is confirmed.\n\nService: {{services}}\nVehicle: {{vehicle}}",
    },
    {
      id: newId("tpl"), key: "booking_confirmation_sms", channel: "sms", subject: null,
      body: "{{businessName}}: your appointment on {{date}} at {{time}} is confirmed. Service: {{services}}. Vehicle: {{vehicle}}. Reply to reschedule.",
    },
  ]);

  customerId = newId("cus");
  await db().insert(schema.customers).values({
    id: customerId, firstName: "Dana", lastName: "Reyes",
    email: "dana@example.com", phone: "(905) 555-1234", phoneNormalized: "9055551234",
  });
  vehicleId = newId("veh");
  await db().insert(schema.vehicles).values({
    id: vehicleId, customerId, make: "Honda", model: "Civic", category: "sedan",
  });
});

afterAll(async () => {
  await getPool().end();
});

async function confirmations(appointmentId: string) {
  return db().select().from(schema.communications).where(and(
    eq(schema.communications.kind, "confirmation"),
    eq(schema.communications.relatedEntityId, appointmentId),
  ));
}

function book(extra: Record<string, unknown> = {}) {
  return createManualAppointmentAction({
    customerId,
    vehicleId,
    serviceIds: ["svc_confirm"],
    addonIds: [],
    dateISO,
    startMs: openUtc.getTime(),
    ...extra,
  });
}

describe("createManualAppointmentAction customer confirmation", () => {
  it("texts and emails the customer what they were booked for", async () => {
    const result = await book();
    expect(result).toMatchObject({ ok: true });
    const appointmentId = (result as { appointmentId: string }).appointmentId;

    const rows = await confirmations(appointmentId);
    expect(rows.map((row) => row.channel).sort()).toEqual(["email", "sms"]);
    const sms = rows.find((row) => row.channel === "sms")!;
    expect(sms.customerId).toBe(customerId);
    expect(sms.contactAddress).toBeTruthy();
    expect(sms.body).toContain("Package 2");
    expect(sms.body).toContain("Honda Civic");
    expect(sms.body).toContain("is confirmed");
    // Never a price — the online confirmation does not quote one either.
    expect(sms.body).not.toMatch(/\$/);
    expect(rows.find((row) => row.channel === "email")!.body).toContain("Hi Dana");
  });

  it("sends nothing when staff untick the confirmation", async () => {
    const result = await book({ notifyCustomer: false });
    expect(result).toMatchObject({ ok: true });
    expect(await confirmations((result as { appointmentId: string }).appointmentId)).toHaveLength(0);
  });

  it("still books when the customer has no phone or email", async () => {
    await db().update(schema.customers)
      .set({ email: null, phone: null, phoneNormalized: null })
      .where(eq(schema.customers.id, customerId));
    const result = await book();
    expect(result).toMatchObject({ ok: true });
    expect(await confirmations((result as { appointmentId: string }).appointmentId)).toHaveLength(0);
  });
});

describe("sendStaffBookingConfirmation", () => {
  async function appointment(status: string, startsAt: Date, timeToBeConfirmed = false) {
    const id = newId("apt");
    await db().insert(schema.appointments).values({
      id, customerId, vehicleId, status, startsAt, timeToBeConfirmed,
      endsAt: new Date(startsAt.getTime() + 90 * 60_000),
      subtotalCents: 17500, discountCents: 0, taxCents: 2275, taxRateBp: 1300, totalCents: 19775,
      durationMin: 60,
    });
    return id;
  }

  it("does not confirm a booking still waiting on its deposit", async () => {
    const id = await appointment("deposit_required", openUtc);
    expect(await sendStaffBookingConfirmation(id, settings)).toEqual([]);
    expect(await confirmations(id)).toHaveLength(0);
  });

  it("does not confirm a walk-in recorded after it happened", async () => {
    const id = await appointment("confirmed", new Date(Date.now() - 3 * 3_600_000));
    expect(await sendStaffBookingConfirmation(id, settings)).toEqual([]);
    expect(await confirmations(id)).toHaveLength(0);
  });

  it("promises a call rather than a time for a date-only booking", async () => {
    const id = await appointment("confirmed", openUtc, true);
    expect((await sendStaffBookingConfirmation(id, settings)).sort()).toEqual(["email", "sms"]);
    const [sms] = (await confirmations(id)).filter((row) => row.channel === "sms");
    expect(sms.body).toContain("a time we will confirm with you");
  });
});

describe("isUpcomingForConfirmation", () => {
  const now = zonedToUtc(tz, 2026, 9, 24, 14, 0).getTime();

  it("treats a date-only booking as upcoming for all of its day", () => {
    const opening = zonedToUtc(tz, 2026, 9, 24, 9, 0);
    expect(isUpcomingForConfirmation({ startsAt: opening, timeToBeConfirmed: true }, tz, now)).toBe(true);
    expect(isUpcomingForConfirmation({ startsAt: opening, timeToBeConfirmed: false }, tz, now)).toBe(false);
  });

  it("drops a date-only booking from a day already gone", () => {
    const yesterday = zonedToUtc(tz, 2026, 9, 23, 9, 0);
    expect(isUpcomingForConfirmation({ startsAt: yesterday, timeToBeConfirmed: true }, tz, now)).toBe(false);
  });
});
