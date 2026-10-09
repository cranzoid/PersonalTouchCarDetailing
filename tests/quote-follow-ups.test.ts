import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";

const staff = vi.hoisted(() => ({
  id: "usr_follow_up_actor",
  name: "Follow-up Tester",
  email: "follow-ups@example.com",
  role: "owner" as const,
}));
const clock = vi.hoisted(() => ({ window: { allowed: true, localHour: 12 } }));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({
  requireStaff: vi.fn(async () => staff),
  AuthError: class AuthError extends Error {},
}));
vi.mock("@/lib/rate-limit", () => ({
  consumeRateLimit: vi.fn(async () => ({ allowed: true, remaining: 5 })),
}));
// The send window is a wall-clock rule; tests run at any hour.
vi.mock("@/lib/marketing/message", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/marketing/message")>();
  return { ...actual, withinSendWindow: () => clock.window };
});

import { db, getPool, schema } from "../src/db";
import { submitQuoteAction } from "../src/app/(public)/quote/actions";
import {
  addQuoteCommentAction,
  logQuoteFollowUpAction,
  sendQuoteFollowUpAction,
  setQuoteNextFollowUpAction,
} from "../src/app/admin/(app)/leads/quotes/[id]/actions";
import { DEFAULT_FOLLOW_UP_EMAIL_BODY, DEFAULT_FOLLOW_UP_EMAIL_SUBJECT, DEFAULT_FOLLOW_UP_SMS } from "../src/lib/quote-follow-up-message";
import { followUpBlock, loadDueFollowUps, localDayToUtc } from "../src/lib/quote-follow-ups";

const TZ = "America/Toronto";

beforeEach(async () => {
  clock.window = { allowed: true, localHour: 12 };
  await db().execute(
    sql`TRUNCATE quote_request_activities, quote_requests, marketing_suppressions, communications, leads,
        customers, audit_log, business_settings, staff_sessions, staff_users CASCADE`,
  );
  await db()
    .insert(schema.staffUsers)
    .values({ id: staff.id, name: staff.name, email: staff.email, passwordHash: "x", role: "owner" });
});

afterAll(async () => {
  await getPool().end();
});

async function seedRequest(
  options: {
    lead?: Partial<typeof schema.leads.$inferInsert>;
    quote?: Partial<typeof schema.quoteRequests.$inferInsert>;
  } = {},
) {
  const leadId = `lead_${Math.random().toString(36).slice(2, 10)}`;
  const quoteId = `qr_${Math.random().toString(36).slice(2, 10)}`;
  await db().insert(schema.leads).values({
    id: leadId,
    name: "Jordan Lee",
    email: "jordan@example.com",
    phone: "(905) 555-0142",
    kind: "quote",
    ...options.lead,
  });
  await db().insert(schema.quoteRequests).values({
    id: quoteId,
    leadId,
    vehicleInfo: { year: 2021, make: "Honda", model: "Civic" },
    conditionDescription: "Swirls on the hood",
    ...options.quote,
  });
  return { leadId, quoteId };
}

describe("followUpBlock", () => {
  const lead = { email: "a@example.com", phone: "9055550142", marketingConsent: false, anonymizedAt: null };
  const now = new Date("2026-10-10T15:00:00Z");

  it("allows a recent request without marketing consent", () => {
    expect(
      followUpBlock({ channel: "sms", lead, requestedAt: new Date("2026-06-01T00:00:00Z"), now, suppressed: false }),
    ).toBeNull();
  });

  it("refuses once CASL's six months from the request have passed, unless they consented", () => {
    const requestedAt = new Date("2026-04-09T00:00:00Z");
    expect(followUpBlock({ channel: "email", lead, requestedAt, now, suppressed: false })).toMatch(/six months/);
    expect(
      followUpBlock({ channel: "email", lead: { ...lead, marketingConsent: true }, requestedAt, now, suppressed: false }),
    ).toBeNull();
  });

  it("explains a missing destination, an opt-out and an erased contact", () => {
    const requestedAt = now;
    expect(followUpBlock({ channel: "sms", lead: { ...lead, phone: null }, requestedAt, now, suppressed: false })).toMatch(/no phone/);
    expect(followUpBlock({ channel: "sms", lead, requestedAt, now, suppressed: true })).toMatch(/STOP/);
    expect(followUpBlock({ channel: "email", lead, requestedAt, now, suppressed: true })).toMatch(/unsubscribed/);
    expect(
      followUpBlock({ channel: "sms", lead: { ...lead, anonymizedAt: now }, requestedAt, now, suppressed: false }),
    ).toMatch(/erased/);
  });
});

describe("sendQuoteFollowUpAction", () => {
  it("texts the request, stamps it followed up, and moves a new lead to contacted", async () => {
    const { leadId, quoteId } = await seedRequest();

    const result = await sendQuoteFollowUpAction({
      quoteRequestId: quoteId,
      channel: "sms",
      body: DEFAULT_FOLLOW_UP_SMS,
      nextFollowUpOn: "2026-10-14",
    });
    expect(result).toEqual({ ok: true });

    const [message] = await db().select().from(schema.communications);
    expect(message).toMatchObject({
      leadId,
      channel: "sms",
      kind: "follow_up",
      relatedEntityType: "quote_request",
      relatedEntityId: quoteId,
      createdByStaffId: staff.id,
      contactAddressNormalized: "9055550142",
    });
    // Placeholders are filled from the request, not sent raw.
    expect(message.body).toContain("Hi Jordan");
    expect(message.body).toContain("2021 Honda Civic");
    expect(message.body).not.toContain("{{");

    const [activity] = await db().select().from(schema.quoteRequestActivities);
    expect(activity).toMatchObject({ kind: "follow_up", method: "sms", communicationId: message.id, staffId: staff.id });

    const [quote] = await db().select().from(schema.quoteRequests).where(eq(schema.quoteRequests.id, quoteId));
    expect(quote.lastFollowedUpAt).not.toBeNull();
    expect(quote.nextFollowUpAt?.toISOString()).toBe(localDayToUtc(TZ, "2026-10-14").toISOString());

    const [lead] = await db().select().from(schema.leads).where(eq(schema.leads.id, leadId));
    expect(lead.status).toBe("contacted");
    // So their reply to this text is filed against them.
    expect(lead.phoneNormalized).toBe("9055550142");
  });

  it("emails with the address and unsubscribe footer appended, and can leave nothing scheduled", async () => {
    const { leadId, quoteId } = await seedRequest({ quote: { nextFollowUpAt: new Date("2026-10-01T04:00:00Z") } });

    const result = await sendQuoteFollowUpAction({
      quoteRequestId: quoteId,
      channel: "email",
      subject: DEFAULT_FOLLOW_UP_EMAIL_SUBJECT,
      body: DEFAULT_FOLLOW_UP_EMAIL_BODY,
      nextFollowUpOn: null,
    });
    expect(result).toEqual({ ok: true });

    const [message] = await db().select().from(schema.communications);
    expect(message.kind).toBe("follow_up");
    expect(message.subject).toMatch(/^Following up on your request/);
    expect(message.body).toContain(`/unsubscribe/${leadId}.`);
    expect(message.body).toContain("you asked us about detailing your vehicle");

    const [quote] = await db().select().from(schema.quoteRequests).where(eq(schema.quoteRequests.id, quoteId));
    expect(quote.nextFollowUpAt).toBeNull();
  });

  it("refuses a number that replied STOP, and records nothing", async () => {
    const { quoteId } = await seedRequest();
    await db().insert(schema.marketingSuppressions).values({
      id: "sup_follow_up_test",
      channel: "sms",
      destination: "9055550142",
      reason: "stop_reply",
    });

    const result = await sendQuoteFollowUpAction({
      quoteRequestId: quoteId,
      channel: "sms",
      body: DEFAULT_FOLLOW_UP_SMS,
      nextFollowUpOn: null,
    });
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/STOP/) });
    expect(await db().select().from(schema.communications)).toHaveLength(0);
    expect(await db().select().from(schema.quoteRequestActivities)).toHaveLength(0);
  });

  it("refuses a text without the opt-out line, and a text outside the send window", async () => {
    const { quoteId } = await seedRequest();

    const noStop = await sendQuoteFollowUpAction({
      quoteRequestId: quoteId,
      channel: "sms",
      body: "Hi {{firstName}}, still interested?",
      nextFollowUpOn: null,
    });
    expect(noStop).toMatchObject({ ok: false, error: expect.stringMatching(/STOP/) });

    clock.window = { allowed: false, localHour: 21 };
    const late = await sendQuoteFollowUpAction({
      quoteRequestId: quoteId,
      channel: "sms",
      body: DEFAULT_FOLLOW_UP_SMS,
      nextFollowUpOn: null,
    });
    expect(late).toMatchObject({ ok: false, error: expect.stringMatching(/9am and 8pm/) });
    expect(await db().select().from(schema.communications)).toHaveLength(0);
  });

  it("refuses an unknown placeholder rather than sending it raw", async () => {
    const { quoteId } = await seedRequest();
    const result = await sendQuoteFollowUpAction({
      quoteRequestId: quoteId,
      channel: "email",
      subject: "Hi {{firstname}}",
      body: "Following up. {{businessName}}",
      nextFollowUpOn: null,
    });
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/firstname/) });
  });
});

describe("logging, comments and scheduling", () => {
  it("logs a call with its note and counts it as a follow-up", async () => {
    const { leadId, quoteId } = await seedRequest({ lead: { status: "qualified" } });

    const result = await logQuoteFollowUpAction({
      quoteRequestId: quoteId,
      method: "voicemail",
      note: "Left a message about Saturday.",
      nextFollowUpOn: "2026-10-20",
    });
    expect(result).toEqual({ ok: true });

    const [activity] = await db().select().from(schema.quoteRequestActivities);
    expect(activity).toMatchObject({ kind: "follow_up", method: "voicemail", body: "Left a message about Saturday." });
    const [quote] = await db().select().from(schema.quoteRequests).where(eq(schema.quoteRequests.id, quoteId));
    expect(quote.lastFollowedUpAt).not.toBeNull();
    // Only "new" moves to "contacted"; a lead further along is left alone.
    const [lead] = await db().select().from(schema.leads).where(eq(schema.leads.id, leadId));
    expect(lead.status).toBe("qualified");
  });

  it("adds a comment without counting it as a follow-up", async () => {
    const { quoteId } = await seedRequest();
    expect(await addQuoteCommentAction({ quoteRequestId: quoteId, body: "Wants a mobile visit." })).toEqual({ ok: true });

    const [activity] = await db().select().from(schema.quoteRequestActivities);
    expect(activity).toMatchObject({ kind: "comment", body: "Wants a mobile visit.", staffId: staff.id });
    const [quote] = await db().select().from(schema.quoteRequests).where(eq(schema.quoteRequests.id, quoteId));
    expect(quote.lastFollowedUpAt).toBeNull();
  });

  it("moves and clears the next follow-up date", async () => {
    const { quoteId } = await seedRequest();
    await setQuoteNextFollowUpAction({ quoteRequestId: quoteId, nextFollowUpOn: "2026-11-02" });
    let [quote] = await db().select().from(schema.quoteRequests).where(eq(schema.quoteRequests.id, quoteId));
    expect(quote.nextFollowUpAt?.toISOString()).toBe(localDayToUtc(TZ, "2026-11-02").toISOString());

    await setQuoteNextFollowUpAction({ quoteRequestId: quoteId, nextFollowUpOn: null });
    [quote] = await db().select().from(schema.quoteRequests).where(eq(schema.quoteRequests.id, quoteId));
    expect(quote.nextFollowUpAt).toBeNull();
  });
});

describe("due follow-ups", () => {
  it("lists requests whose day has come, oldest first, and never closed ones", async () => {
    const now = new Date("2026-10-10T15:00:00Z");
    const overdue = await seedRequest({ quote: { nextFollowUpAt: new Date("2026-10-05T04:00:00Z") } });
    const today = await seedRequest({ quote: { nextFollowUpAt: new Date("2026-10-10T04:00:00Z") } });
    await seedRequest({ quote: { nextFollowUpAt: new Date("2026-10-11T04:00:00Z") } });
    await seedRequest({ quote: { nextFollowUpAt: new Date("2026-10-01T04:00:00Z"), status: "closed" } });
    await seedRequest();

    const due = await loadDueFollowUps(now);
    expect(due.total).toBe(2);
    expect(due.items.map((item) => item.id)).toEqual([overdue.quoteId, today.quoteId]);
    expect(due.items[0]).toMatchObject({ name: "Jordan Lee", vehicle: "2021 Honda Civic", callback: false });
  });

  it("makes a new public request due the day it arrives, and keeps the caller's phone matchable", async () => {
    const fd = new FormData();
    fd.set(
      "payload",
      JSON.stringify({
        name: "Callback Caller",
        phone: "+1 (905) 555-0177",
        serviceIds: [],
        conditionDescription: "Ceramic protection callback request.",
        marketingConsent: false,
        attribution: { enquiryType: "ceramic_callback" },
      }),
    );
    const response = await submitQuoteAction(fd);
    expect(response.ok).toBe(true);
    if (!response.ok) return;

    const [quote] = await db()
      .select()
      .from(schema.quoteRequests)
      .where(eq(schema.quoteRequests.id, response.reference));
    expect(quote.nextFollowUpAt).not.toBeNull();
    expect(quote.nextFollowUpAt!.getTime()).toBeLessThanOrEqual(Date.now());
    const [lead] = await db().select().from(schema.leads).where(eq(schema.leads.id, quote.leadId!));
    expect(lead.phoneNormalized).toBe("9055550177");

    const due = await loadDueFollowUps(new Date());
    expect(due.items).toEqual([expect.objectContaining({ id: quote.id, callback: true })]);
  });
});
