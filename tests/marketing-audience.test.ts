import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db, getPool, schema } from "../src/db";
import { newId } from "../src/lib/id";
import {
  FOOTING_WINDOW_DAYS,
  findMissedAppointments,
  resolveFooting,
} from "../src/lib/marketing/audience";
import { addSuppression } from "../src/lib/marketing/suppressions";

const TZ = "America/Toronto";
const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

async function resetDb() {
  await db().execute(
    sql`TRUNCATE outreach_recipients, outreach_campaigns, marketing_suppressions, communications,
        appointment_services, invoices, appointments, vehicles, leads, customers CASCADE`,
  );
}

async function addCustomer(input: {
  firstName?: string;
  email?: string | null;
  phone?: string | null;
  consent?: boolean;
}) {
  const id = newId("cus");
  await db().insert(schema.customers).values({
    id,
    firstName: input.firstName ?? "Dave",
    lastName: "Mitchell",
    email: input.email === undefined ? "dave@example.com" : input.email,
    phone: input.phone === undefined ? "905 555 1234" : input.phone,
    phoneNormalized: input.phone === null ? null : (input.phone ?? "905 555 1234").replace(/\D/g, ""),
    marketingConsent: input.consent ?? false,
  });
  return id;
}

async function addMissedAppointment(input: {
  customerId: string;
  status: "cancelled" | "no_show";
  startsAt: Date;
  cancellationReason?: string;
  noShowNote?: string;
  service?: string;
}) {
  const vehicleId = newId("veh");
  await db().insert(schema.vehicles).values({
    id: vehicleId,
    customerId: input.customerId,
    make: "Toyota",
    model: "Corolla",
    category: "sedan",
  });
  const id = newId("apt");
  await db().insert(schema.appointments).values({
    id,
    customerId: input.customerId,
    vehicleId,
    status: input.status,
    startsAt: input.startsAt,
    endsAt: new Date(input.startsAt.getTime() + 2 * 60 * 60 * 1000),
    durationMin: 120,
    totalCents: 19900,
    cancellationReason: input.cancellationReason,
    noShowNote: input.noShowNote,
  });
  if (input.service) {
    await db().insert(schema.appointmentServices).values({
      id: newId("aps"),
      appointmentId: id,
      description: input.service,
      priceCents: 19900,
      durationMin: 120,
    });
  }
  return id;
}

async function addPaidInvoice(customerId: string, paidAt: Date) {
  await db().insert(schema.invoices).values({
    id: newId("inv"),
    customerId,
    status: "paid",
    paidAt,
    taxRateBp: 1300,
    number: Math.floor(Math.random() * 1_000_000),
  });
}

afterAll(async () => {
  await getPool().end();
});

describe("resolveFooting", () => {
  it("prefers consent already on file over any implied window", () => {
    expect(
      resolveFooting({ expressConsent: true, purchasedAt: null, inquiredAt: daysAgo(900) }),
    ).toBe("express");
  });

  it("treats a purchase inside two years as an existing business relationship", () => {
    expect(
      resolveFooting({
        expressConsent: false,
        purchasedAt: daysAgo(FOOTING_WINDOW_DAYS.existing_customer - 10),
        inquiredAt: daysAgo(900),
      }),
    ).toBe("existing_customer");
  });

  it("treats a recent booking as an inquiry, which is the shorter window", () => {
    expect(
      resolveFooting({ expressConsent: false, purchasedAt: null, inquiredAt: daysAgo(30) }),
    ).toBe("inquiry");
  });

  it("gives no footing once both windows have closed", () => {
    expect(
      resolveFooting({
        expressConsent: false,
        purchasedAt: daysAgo(FOOTING_WINDOW_DAYS.existing_customer + 1),
        inquiredAt: daysAgo(FOOTING_WINDOW_DAYS.inquiry + 1),
      }),
    ).toBe("none");
  });

  it("closes the inquiry window the day after it expires", () => {
    expect(
      resolveFooting({
        expressConsent: false,
        purchasedAt: null,
        inquiredAt: daysAgo(FOOTING_WINDOW_DAYS.inquiry + 1),
      }),
    ).toBe("none");
  });
});

describe("findMissedAppointments", () => {
  beforeEach(resetDb);

  it("finds a no-show and reports that nobody gave a reason", async () => {
    const customerId = await addCustomer({});
    await addMissedAppointment({ customerId, status: "no_show", startsAt: daysAgo(10) });

    const { candidates, totals } = await findMissedAppointments({
      filter: "missed",
      channel: "sms",
      withinDays: 90,
      timezone: TZ,
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      outcome: "no_show",
      reason: null,
      blockedReason: null,
      footing: "inquiry",
    });
    expect(totals).toMatchObject({ eligible: 1, blocked: 0 });
  });

  it("surfaces the reason a cancellation was given", async () => {
    const customerId = await addCustomer({});
    await addMissedAppointment({
      customerId,
      status: "cancelled",
      startsAt: daysAgo(5),
      cancellationReason: "Car sold before the appointment",
    });

    const { candidates } = await findMissedAppointments({
      filter: "cancelled",
      channel: "sms",
      withinDays: 90,
      timezone: TZ,
    });
    expect(candidates[0].reason).toBe("Car sold before the appointment");
  });

  it("surfaces a no-show note now that one can be recorded", async () => {
    const customerId = await addCustomer({});
    await addMissedAppointment({
      customerId,
      status: "no_show",
      startsAt: daysAgo(5),
      noShowNote: "Called later — had a family emergency",
    });

    const { candidates } = await findMissedAppointments({
      filter: "no_show",
      channel: "sms",
      withinDays: 90,
      timezone: TZ,
    });
    expect(candidates[0].reason).toBe("Called later — had a family emergency");
  });

  it("separates the two outcomes when asked for one of them", async () => {
    const a = await addCustomer({ phone: "905 555 0001", email: "a@example.com" });
    const b = await addCustomer({ phone: "905 555 0002", email: "b@example.com" });
    await addMissedAppointment({ customerId: a, status: "no_show", startsAt: daysAgo(3) });
    await addMissedAppointment({ customerId: b, status: "cancelled", startsAt: daysAgo(4) });

    const base = { channel: "sms", withinDays: 90, timezone: TZ } as const;
    expect((await findMissedAppointments({ ...base, filter: "no_show" })).candidates).toHaveLength(1);
    expect((await findMissedAppointments({ ...base, filter: "cancelled" })).candidates).toHaveLength(1);
    expect((await findMissedAppointments({ ...base, filter: "missed" })).candidates).toHaveLength(2);
  });

  it("ignores appointments outside the window the owner asked for", async () => {
    const customerId = await addCustomer({});
    await addMissedAppointment({ customerId, status: "no_show", startsAt: daysAgo(200) });

    const { candidates } = await findMissedAppointments({
      filter: "missed",
      channel: "sms",
      withinDays: 90,
      timezone: TZ,
    });
    expect(candidates).toHaveLength(0);
  });

  it("blocks someone who has opted out, and says so", async () => {
    const customerId = await addCustomer({ phone: "905 555 1234" });
    await addMissedAppointment({ customerId, status: "no_show", startsAt: daysAgo(10) });
    await addSuppression(db(), {
      channel: "sms",
      destination: "905 555 1234",
      reason: "stop_reply",
    });

    const { candidates, totals } = await findMissedAppointments({
      filter: "missed",
      channel: "sms",
      withinDays: 90,
      timezone: TZ,
    });
    expect(candidates[0].blockedReason).toBe("On the do-not-contact list");
    expect(totals).toMatchObject({ eligible: 0, blocked: 1 });
  });

  it("blocks a customer with no address on the channel being used", async () => {
    const customerId = await addCustomer({ email: null });
    await addMissedAppointment({ customerId, status: "no_show", startsAt: daysAgo(10) });

    const { candidates } = await findMissedAppointments({
      filter: "missed",
      channel: "email",
      withinDays: 90,
      timezone: TZ,
    });
    expect(candidates[0].blockedReason).toBe("No email address on file");
  });

  it("blocks an old booking with no purchase behind it", async () => {
    const customerId = await addCustomer({});
    await addMissedAppointment({
      customerId,
      status: "cancelled",
      startsAt: daysAgo(FOOTING_WINDOW_DAYS.inquiry + 30),
    });

    const { candidates } = await findMissedAppointments({
      filter: "missed",
      channel: "sms",
      withinDays: 365,
      timezone: TZ,
    });
    expect(candidates[0].footing).toBe("none");
    expect(candidates[0].blockedReason).toContain("CASL");
  });

  it("allows that same old booking once the customer has actually bought something", async () => {
    const customerId = await addCustomer({});
    await addMissedAppointment({
      customerId,
      status: "cancelled",
      startsAt: daysAgo(FOOTING_WINDOW_DAYS.inquiry + 30),
    });
    await addPaidInvoice(customerId, daysAgo(120));

    const { candidates } = await findMissedAppointments({
      filter: "missed",
      channel: "sms",
      withinDays: 365,
      timezone: TZ,
    });
    expect(candidates[0].footing).toBe("existing_customer");
    expect(candidates[0].blockedReason).toBeNull();
  });

  it("does not let an unpaid invoice open the two-year window", async () => {
    const customerId = await addCustomer({});
    await addMissedAppointment({
      customerId,
      status: "cancelled",
      startsAt: daysAgo(FOOTING_WINDOW_DAYS.inquiry + 30),
    });
    await db().insert(schema.invoices).values({
      id: newId("inv"),
      customerId,
      status: "issued",
      taxRateBp: 1300,
      number: 4242,
    });

    const { candidates } = await findMissedAppointments({
      filter: "missed",
      channel: "sms",
      withinDays: 365,
      timezone: TZ,
    });
    expect(candidates[0].footing).toBe("none");
  });

  it("flags someone an earlier campaign already reached", async () => {
    const customerId = await addCustomer({ phone: "905 555 1234" });
    await addMissedAppointment({ customerId, status: "no_show", startsAt: daysAgo(10) });

    const campaignId = newId("ocm");
    await db().insert(schema.outreachCampaigns).values({
      id: campaignId,
      name: "Earlier",
      channel: "sms",
      body: "Hi. Reply STOP to opt out.",
      status: "completed",
    });
    await db().insert(schema.outreachRecipients).values({
      id: newId("orc"),
      campaignId,
      destination: "905 555 1234",
      destinationNormalized: "9055551234",
      status: "sent",
    });

    const { candidates } = await findMissedAppointments({
      filter: "missed",
      channel: "sms",
      withinDays: 90,
      timezone: TZ,
    });
    expect(candidates[0].alreadyContacted).toBe(true);
  });

  it("carries the booked work through for the list", async () => {
    const customerId = await addCustomer({});
    await addMissedAppointment({
      customerId,
      status: "no_show",
      startsAt: daysAgo(10),
      service: "Full Detail",
    });

    const { candidates } = await findMissedAppointments({
      filter: "missed",
      channel: "sms",
      withinDays: 90,
      timezone: TZ,
    });
    expect(candidates[0].services).toBe("Full Detail");
    expect(candidates[0].missedOnLabel).toMatch(/\d{4}/);
  });
});
