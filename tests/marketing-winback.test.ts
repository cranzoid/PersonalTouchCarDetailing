import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";

/**
 * Win-back outreach: the one-screen send that replaced the campaign builder for
 * people whose booking was cancelled or who never turned up.
 *
 * The behaviour worth pinning down is everything the old four-step flow was
 * doing on the way past — recording a consent basis, collapsing one person's
 * two missed bookings into one message, refusing to re-message somebody an
 * earlier send already reached, and leaving a recipient row that says what each
 * person actually got.
 */

const auth = vi.hoisted(() => ({
  actor: {
    id: "usr_winback_test_owner",
    name: "Win-back Test Owner",
    email: "winback-owner@example.com",
    role: "owner" as const,
  },
  requireStaff: vi.fn(),
}));
auth.requireStaff.mockResolvedValue(auth.actor);

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({
  requireStaff: auth.requireStaff,
  AuthError: class AuthError extends Error {},
}));
// The send window is a wall-clock rule; tests run at any hour.
vi.mock("@/lib/marketing/message", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/marketing/message")>();
  return { ...actual, withinSendWindow: () => ({ allowed: true, localHour: 12 }) };
});
// Credentials are encrypted secrets in the real database; the log transport
// used under test never reads them, so "configured" is all the action needs.
vi.mock("@/lib/integrations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/integrations")>();
  return { ...actual, getIntegrationSecret: vi.fn(async () => "configured") };
});

import { db, getPool, schema } from "../src/db";
import { newId } from "../src/lib/id";
import { addSuppression } from "../src/lib/marketing/suppressions";
import { sendWinbackMessages } from "../src/lib/marketing/winback";
import {
  defaultWinbackEmailBody,
  defaultWinbackSms,
  winbackCampaignName,
} from "../src/lib/marketing/winback-message";
import { SETTINGS_DEFAULTS, type BusinessSettings } from "../src/lib/settings";

const settings = { ...SETTINGS_DEFAULTS, businessName: "Personal Touch" } as BusinessSettings;
const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

async function resetDb() {
  await db().execute(
    sql`TRUNCATE outreach_recipients, outreach_campaigns, marketing_suppressions, communications,
        appointment_services, invoices, appointments, vehicles, leads, customers, staff_users CASCADE`,
  );
  await db().insert(schema.staffUsers).values({
    id: auth.actor.id,
    name: auth.actor.name,
    email: auth.actor.email,
    passwordHash: "x",
    role: "owner",
  });
}

async function addCustomer(input: { phone?: string | null; email?: string | null; consent?: boolean } = {}) {
  const id = newId("cus");
  const phone = input.phone === undefined ? "905 555 1234" : input.phone;
  await db().insert(schema.customers).values({
    id,
    firstName: "Dave",
    lastName: "Mitchell",
    email: input.email === undefined ? "dave@example.com" : input.email,
    phone,
    phoneNormalized: phone ? phone.replace(/\D/g, "") : null,
    companyName: "Hamilton Plumbing",
    marketingConsent: input.consent ?? false,
  });
  return id;
}

async function addMissedAppointment(input: {
  customerId: string;
  status?: "cancelled" | "no_show";
  startsAt?: Date;
  reason?: string;
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
  const startsAt = input.startsAt ?? daysAgo(20);
  await db().insert(schema.appointments).values({
    id,
    customerId: input.customerId,
    vehicleId,
    status: input.status ?? "no_show",
    startsAt,
    endsAt: new Date(startsAt.getTime() + 2 * 60 * 60 * 1000),
    durationMin: 120,
    totalCents: 19900,
    noShowNote: input.status === "cancelled" ? undefined : input.reason,
    cancellationReason: input.status === "cancelled" ? input.reason : undefined,
  });
  return id;
}

function send(input: {
  appointmentIds: string[];
  channel?: "sms" | "email";
  body?: string;
  allowRecontact?: boolean;
}) {
  return sendWinbackMessages({
    appointmentIds: input.appointmentIds,
    filter: "missed",
    withinDays: 365,
    channel: input.channel ?? "sms",
    subject: "Shall we find you another time?",
    body: input.body ?? defaultWinbackSms(settings.businessName),
    allowRecontact: input.allowRecontact ?? false,
    staffId: auth.actor.id,
    settings,
  });
}

afterAll(async () => {
  await getPool().end();
});

describe("the default wording", () => {
  it("ships a text that can be sent as it stands", () => {
    const body = defaultWinbackSms("Personal Touch");
    expect(body).toContain("Personal Touch");
    expect(body).toMatch(/\bSTOP\b/);
    expect(body).toContain("{{FirstName}}");
    // Curly quotes and em dashes halve what fits in an SMS segment.
    expect(body).not.toMatch(/[‘’“”—]/);
  });

  it("names the shop in the email, from settings rather than hard-coded", () => {
    expect(defaultWinbackEmailBody("Ancaster Detail")).toContain("Ancaster Detail");
  });

  it("names a send after what it was", () => {
    expect(
      winbackCampaignName({ channel: "sms", audienceLabel: "No-show win-back", atLabel: "18 Sep, 2:45 p.m." }),
    ).toBe("No-show win-back text · 18 Sep, 2:45 p.m.");
  });
});

describe("sending a win-back", () => {
  beforeEach(resetDb);

  it("texts the person, records the basis, and leaves a recipient row", async () => {
    const customerId = await addCustomer();
    const appointmentId = await addMissedAppointment({ customerId, reason: "Car wouldn't start" });

    const { campaignId, outcomes } = await send({ appointmentIds: [appointmentId] });

    expect(outcomes).toEqual([expect.objectContaining({ appointmentId, status: "sent" })]);

    // Implied consent from the missed booking itself, written down rather than
    // assumed — the send would be refused without it.
    const [customer] = await db()
      .select()
      .from(schema.customers)
      .where(eq(schema.customers.id, customerId));
    expect(customer.marketingConsent).toBe(true);
    expect(customer.marketingConsentSource).toBe("winback:inquiry");

    const [recipient] = await db()
      .select()
      .from(schema.outreachRecipients)
      .where(eq(schema.outreachRecipients.campaignId, campaignId!));
    expect(recipient.status).toBe("sent");
    expect(recipient.appointmentId).toBe(appointmentId);
    expect(recipient.contextNote).toContain("Car wouldn't start");
    expect(recipient.renderedBody).toContain("Dave");
    expect(recipient.renderedBody).not.toContain("{{FirstName}}");

    const [campaign] = await db()
      .select()
      .from(schema.outreachCampaigns)
      .where(eq(schema.outreachCampaigns.id, campaignId!));
    expect(campaign.status).toBe("completed");
    expect(campaign.audience).toBe("missed");
  });

  it("fills in the date of the booking they missed", async () => {
    const customerId = await addCustomer();
    const appointmentId = await addMissedAppointment({ customerId });
    await send({
      appointmentIds: [appointmentId],
      body: "Hi {{FirstName}}, we missed you on {{LastVisit}}. Personal Touch. Reply STOP to opt out.",
    });

    const [recipient] = await db().select().from(schema.outreachRecipients);
    expect(recipient.renderedBody).toContain(recipient.lastVisitLabel!);
    expect(recipient.renderedBody).not.toContain("{{LastVisit}}");
  });

  it("collapses one person's two missed bookings into a single message", async () => {
    const customerId = await addCustomer();
    const first = await addMissedAppointment({ customerId, startsAt: daysAgo(20) });
    const second = await addMissedAppointment({ customerId, startsAt: daysAgo(40) });

    const { outcomes } = await send({ appointmentIds: [first, second] });

    expect(outcomes.filter((o) => o.status === "sent")).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === "skipped")).toHaveLength(1);
    expect(await countRecipients()).toBe(1);
  });

  it("skips anyone who replied STOP, and never writes them a message", async () => {
    const customerId = await addCustomer();
    const appointmentId = await addMissedAppointment({ customerId });
    await addSuppression(db(), { channel: "sms", destination: "905 555 1234", reason: "stop_reply" });

    const { campaignId, outcomes } = await send({ appointmentIds: [appointmentId] });

    expect(campaignId).toBeNull();
    expect(outcomes[0]).toMatchObject({ status: "skipped", reason: "On the do-not-contact list" });
    expect(await countRecipients()).toBe(0);
  });

  it("skips someone with no number when the message is a text", async () => {
    const customerId = await addCustomer({ phone: null });
    const appointmentId = await addMissedAppointment({ customerId });

    const { outcomes } = await send({ appointmentIds: [appointmentId] });
    expect(outcomes[0]).toMatchObject({ status: "skipped", reason: "No mobile number on file" });
  });

  it("refuses a booking that is no longer on the list", async () => {
    const customerId = await addCustomer();
    const appointmentId = await addMissedAppointment({ customerId });
    await db()
      .update(schema.appointments)
      .set({ status: "confirmed" })
      .where(eq(schema.appointments.id, appointmentId));

    const { campaignId, outcomes } = await send({ appointmentIds: [appointmentId] });
    expect(campaignId).toBeNull();
    expect(outcomes[0]).toMatchObject({ status: "skipped" });
    expect(outcomes[0].reason).toContain("No longer on the list");
  });

  it("will not message someone an earlier send already reached", async () => {
    const customerId = await addCustomer();
    const first = await addMissedAppointment({ customerId, startsAt: daysAgo(20) });
    await send({ appointmentIds: [first] });

    const second = await addMissedAppointment({ customerId, startsAt: daysAgo(10) });
    const { outcomes } = await send({ appointmentIds: [second] });

    expect(outcomes[0]).toMatchObject({ status: "skipped" });
    expect(await countSent()).toBe(1);
  });

  it("messages them again when the owner deliberately allows it", async () => {
    const customerId = await addCustomer();
    const first = await addMissedAppointment({ customerId, startsAt: daysAgo(20) });
    await send({ appointmentIds: [first] });

    const second = await addMissedAppointment({ customerId, startsAt: daysAgo(10) });
    const { outcomes } = await send({ appointmentIds: [second], allowRecontact: true });

    expect(outcomes[0]).toMatchObject({ status: "sent" });
    expect(await countSent()).toBe(2);
  });

  it("appends the address and a working unsubscribe link to an email", async () => {
    const customerId = await addCustomer();
    const appointmentId = await addMissedAppointment({ customerId });

    const { campaignId } = await send({
      appointmentIds: [appointmentId],
      channel: "email",
      body: defaultWinbackEmailBody(settings.businessName),
    });

    const [recipient] = await db()
      .select()
      .from(schema.outreachRecipients)
      .where(eq(schema.outreachRecipients.campaignId, campaignId!));
    expect(recipient.renderedBody).toContain("Unsubscribe:");
    expect(recipient.renderedBody).toContain(settings.businessName);
  });

  it("leaves express consent alone rather than downgrading it", async () => {
    const customerId = await addCustomer({ consent: true });
    const appointmentId = await addMissedAppointment({ customerId });
    await send({ appointmentIds: [appointmentId] });

    const [customer] = await db()
      .select()
      .from(schema.customers)
      .where(eq(schema.customers.id, customerId));
    expect(customer.marketingConsentSource).toBeNull();
  });
});

async function countRecipients(): Promise<number> {
  const [row] = await db()
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.outreachRecipients);
  return row.n;
}

async function countSent(): Promise<number> {
  const [row] = await db()
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.outreachRecipients)
    .where(eq(schema.outreachRecipients.status, "sent"));
  return row.n;
}
