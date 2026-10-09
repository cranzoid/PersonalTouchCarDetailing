import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";

const cookieJar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (cookieJar.has(name) ? { name, value: cookieJar.get(name)! } : undefined),
    set: (name: string, value: string) => cookieJar.set(name, value),
    delete: (name: string) => cookieJar.delete(name),
  }),
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.9" }),
}));
vi.mock("@/lib/rate-limit", () => ({
  consumeRateLimit: vi.fn(async () => ({ allowed: true, remaining: 9, retryAfterSeconds: 0 })),
}));

import { db, getPool, schema } from "../src/db";
import { newId } from "../src/lib/id";
import { accountCustomers, getAccountSession, requestSignInCode, verifySignInCode } from "../src/lib/accounts/session";
import { bookMemberVisit, MemberBookingError } from "../src/lib/memberships/booking";
import { applyMemberBenefitsToAppointment } from "../src/lib/memberships/counter";
import { voidEntitlementsForAppointment } from "../src/lib/memberships/service";
import { createStaffAppointment } from "../src/lib/booking/create";
import { SETTINGS_DEFAULTS } from "../src/lib/settings";
import { zonedToUtc, zonedWeekday } from "../src/lib/tz";

const tz = SETTINGS_DEFAULTS.timezone;
const target = new Date(Date.now() + 10 * 86_400_000);
const [y, m, d] = [target.getUTCFullYear(), target.getUTCMonth() + 1, target.getUTCDate()];
const dateISO = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const nineAm = zonedToUtc(tz, y, m, d, 9, 0).getTime();
const elevenAm = zonedToUtc(tz, y, m, d, 11, 0).getTime();

async function resetDb() {
  cookieJar.clear();
  await db().execute(sql`
    TRUNCATE customer_sessions, customer_login_codes, membership_redemptions, membership_periods, memberships,
             winter_pass_redemptions, winter_passes, appointment_services, appointments, payments, invoices,
             vehicles, customers, communications, audit_log, business_settings, resources, business_hours,
             service_addons, service_vehicle_adjustments, addon_vehicle_adjustments, services, service_categories,
             addons, staff_users CASCADE
  `);
  await db().execute(sql`DELETE FROM membership_plans`);
  await db().insert(schema.resources).values({ id: newId("res"), name: "Bay 1", type: "bay" });
  await db().insert(schema.businessHours).values({ id: newId("blk"), weekday: zonedWeekday(tz, y, m, d), open: "09:00", close: "17:00", closed: false });
  await db().insert(schema.serviceCategories).values({ id: "cat_test", name: "Detailing", slug: "vehicle-detailing" });
  await db().insert(schema.services).values([
    { id: "svc_wash", categoryId: "cat_test", name: "Basic Car Wash", slug: "basic-car-wash", basePriceCents: 3000, baseDurationMin: 60, bookingMode: "bookable" },
    { id: "svc_interior", categoryId: "cat_test", name: "Basic Interior Clean", slug: "basic-interior-clean", basePriceCents: 5000, baseDurationMin: 30, bookingMode: "bookable" },
    { id: "svc_works", categoryId: "cat_test", name: "Signature Detail", slug: "the-works", basePriceCents: 13500, baseDurationMin: 120, bookingMode: "bookable" },
  ]);
  await db().insert(schema.addons).values({ id: "add_glass", name: "Winter Glass Protection", slug: "winter-glass-protection", priceCents: 1499, durationMin: 15 });
  await db().insert(schema.serviceAddons).values({ id: "sa_1", serviceId: "svc_works", addonId: "add_glass" });
  await db().insert(schema.membershipPlans).values({
    id: "mpl_club",
    slug: "winter-shield-club",
    name: "Winter Shield Club",
    monthlyPriceCents: 4900,
    discountBp: 1500,
    includedBenefits: ["wash"],
    rank: 1,
  });
}

async function member() {
  const customerId = newId("cus");
  const vehicleId = newId("veh");
  await db().insert(schema.customers).values({ id: customerId, firstName: "Mia", lastName: "Member", email: "Mia@Example.com", phone: "905-555-0101", phoneNormalized: "9055550101" });
  await db().insert(schema.vehicles).values({ id: vehicleId, customerId, make: "Mazda", model: "CX-5", category: "suv_small" });
  const membershipId = newId("mem");
  const start = new Date(Date.now() - 86_400_000);
  const end = new Date(Date.now() + 30 * 86_400_000);
  await db().insert(schema.memberships).values({
    id: membershipId,
    customerId,
    vehicleId,
    planId: "mpl_club",
    status: "active",
    priceCents: 4900,
    currentPeriodStart: start,
    currentPeriodEnd: end,
  });
  await db().insert(schema.membershipPeriods).values({
    id: newId("mpd"),
    membershipId,
    planId: "mpl_club",
    periodStart: start,
    periodEnd: end,
    amountCents: 4900,
    status: "paid",
  });
  return { customerId, vehicleId, membershipId };
}

beforeEach(resetDb);
afterAll(async () => {
  await getPool().end();
});

describe("account sign-in", () => {
  it("signs in with the emailed code and sees every record carrying that address", async () => {
    const { customerId } = await member();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(await requestSignInCode({ channel: "email", contact: "  mia@example.COM " })).toEqual({ ok: true, contact: "mia@example.com" });
    const code = String(log.mock.calls.flat().join(" ").match(/: (\d{6})/)?.[1]);
    log.mockRestore();

    expect(await verifySignInCode({ channel: "email", contact: "mia@example.com", code: code === "000000" ? "111111" : "000000" })).toMatchObject({ ok: false });
    expect(await getAccountSession()).toBeNull();
    expect(await verifySignInCode({ channel: "email", contact: "mia@example.com", code })).toEqual({ ok: true });
    const session = await getAccountSession();
    expect(session).toMatchObject({ channel: "email", contact: "mia@example.com" });
    expect((await accountCustomers(session!)).map((c) => c.id)).toEqual([customerId]);
    // A code works once.
    expect(await verifySignInCode({ channel: "email", contact: "mia@example.com", code })).toMatchObject({ ok: false });
  });

  it("locks a code after five wrong guesses, even if the sixth is right", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await requestSignInCode({ channel: "sms", contact: "(905) 555-0101" });
    const code = String(log.mock.calls.flat().join(" ").match(/: (\d{6})/)?.[1]);
    log.mockRestore();
    const wrong = code === "123456" ? "654321" : "123456";
    for (let i = 0; i < 5; i++) await verifySignInCode({ channel: "sms", contact: "9055550101", code: wrong });
    expect(await verifySignInCode({ channel: "sms", contact: "9055550101", code })).toMatchObject({ ok: false });
    expect(await getAccountSession()).toBeNull();
  });
});

describe("booking as a member", () => {
  it("books this month's wash free, once, and gives it back if the booking is cancelled", async () => {
    const { customerId, vehicleId } = await member();
    const first = await bookMemberVisit({
      request: { vehicleId, use: "member", benefits: ["wash"] },
      allowedCustomerIds: [customerId],
      dateISO,
      startMs: nineAm,
    });
    const [appointment] = await db().select().from(schema.appointments).where(eq(schema.appointments.id, first.appointmentId));
    expect(appointment).toMatchObject({ subtotalCents: 3000, discountCents: 3000, totalCents: 0, promoLabel: "Winter Shield Club member benefits" });

    await expect(
      bookMemberVisit({ request: { vehicleId, use: "member", benefits: ["wash"] }, allowedCustomerIds: [customerId], dateISO, startMs: elevenAm }),
    ).rejects.toThrow(/already been used/);

    await db().update(schema.appointments).set({ status: "cancelled" }).where(eq(schema.appointments.id, first.appointmentId));
    await db().transaction((tx) => voidEntitlementsForAppointment(tx, first.appointmentId, "Booking cancelled"));
    await bookMemberVisit({ request: { vehicleId, use: "member", benefits: ["wash"] }, allowedCustomerIds: [customerId], dateISO, startMs: elevenAm });
  });

  it("refuses a benefit the plan does not include, and someone else's car", async () => {
    const { customerId, vehicleId } = await member();
    await expect(
      bookMemberVisit({ request: { vehicleId, use: "member", benefits: ["interior"] }, allowedCustomerIds: [customerId], dateISO, startMs: nineAm }),
    ).rejects.toBeInstanceOf(MemberBookingError);
    await expect(
      bookMemberVisit({ request: { vehicleId, use: "member", benefits: ["wash"] }, allowedCustomerIds: ["cus_someoneelse"], dateISO, startMs: nineAm }),
    ).rejects.toThrow(/your vehicles/);
  });

  it("gives the member discount on a detailing package and its add-on", async () => {
    const { customerId, vehicleId } = await member();
    const booked = await bookMemberVisit({
      request: { vehicleId, use: "package", packageServiceId: "svc_works", addonIds: ["add_glass"] },
      allowedCustomerIds: [customerId],
      dateISO,
      startMs: nineAm,
    });
    const [appointment] = await db().select().from(schema.appointments).where(eq(schema.appointments.id, booked.appointmentId));
    // 15% of $135 + 15% of $14.99, before tax.
    expect(appointment.discountCents).toBe(2025 + 225);
  });
});

describe("applying a membership at the counter", () => {
  it("makes the booked wash free and records the month's wash as used", async () => {
    const { customerId, vehicleId, membershipId } = await member();
    const staffId = newId("usr");
    await db().insert(schema.staffUsers).values({ id: staffId, name: "Front", email: `${staffId}@example.com`, passwordHash: "x", role: "owner" });
    const created = await createStaffAppointment({
      customerId,
      vehicleId,
      serviceIds: ["svc_wash"],
      addonIds: [],
      dateISO,
      startMs: nineAm,
      settings: SETTINGS_DEFAULTS,
      staffId,
    });
    const applied = await applyMemberBenefitsToAppointment({ appointmentId: created.appointmentId, staffId, spendBenefits: ["wash"], spendPassWash: false });
    expect(applied).toEqual({ ok: true, discountCents: 3000 });
    const [appointment] = await db().select().from(schema.appointments).where(eq(schema.appointments.id, created.appointmentId));
    expect(appointment.totalCents).toBe(0);
    const redemptions = await db().select().from(schema.membershipRedemptions).where(eq(schema.membershipRedemptions.membershipId, membershipId));
    expect(redemptions).toHaveLength(1);
    expect(
      await applyMemberBenefitsToAppointment({ appointmentId: created.appointmentId, staffId, spendBenefits: ["wash"], spendPassWash: false }),
    ).toMatchObject({ ok: false });
  });
});
