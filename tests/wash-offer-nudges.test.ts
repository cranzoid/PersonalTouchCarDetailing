import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";

/**
 * The two things added around the live first-wash offer without touching how a
 * code is claimed or booked:
 *
 *  - nudges staff send by hand to people holding an unbooked code, which must
 *    respect consent and STOP, never text the same person twice in a day, and
 *    count only what actually went out;
 *  - redeeming a code for somebody who walked in with it, which must spend the
 *    plate through the same unique index as the booking path and mark the lead
 *    Completed.
 */

const auth = vi.hoisted(() => ({
  actor: {
    id: "usr_nudge_test_owner",
    name: "Nudge Test Owner",
    email: "nudge-owner@example.com",
    role: "owner" as const,
  },
  requireStaff: vi.fn(),
}));
auth.requireStaff.mockResolvedValue(auth.actor);

const messaging = vi.hoisted(() => ({ fail: false }));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({
  requireStaff: auth.requireStaff,
  AuthError: class AuthError extends Error {},
}));
vi.mock("@/lib/messaging", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/messaging")>();
  return {
    ...actual,
    sendMessage: vi.fn(async (msg: Parameters<typeof actual.sendMessage>[0]) =>
      messaging.fail
        ? { id: "com_forced_failure", sent: false, reason: "provider_error" as const }
        : actual.sendMessage(msg),
    ),
  };
});
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
import { SETTINGS_DEFAULTS, type BusinessSettings } from "../src/lib/settings";
import { activeWashOffer } from "../src/lib/wash-offer";
import { issueClaim, redeemClaimAgainstPlate } from "../src/lib/wash-offer-claims";
import { smsSegments } from "../src/lib/marketing/message";
import {
  daysLeftLabel,
  DEFAULT_NUDGE_EMAIL_BODY,
  DEFAULT_NUDGE_EMAIL_SUBJECT,
  DEFAULT_NUDGE_SMS,
  NUDGE_COOLDOWN_MS,
  renderNudge,
  unknownNudgePlaceholders,
} from "../src/lib/wash-offer-nudge-message";
import { sendClaimNudges } from "../src/lib/wash-offer-nudges";
import {
  findOfferClaimAction,
  redeemOfferClaimAction,
  redeemWalkInClaimAction,
} from "../src/app/admin/(app)/marketing/offer-claims/actions";
import { sendWashNudgesAction } from "../src/app/admin/(app)/marketing/wash-nudges/actions";
import { setLeadStatusAction } from "../src/app/admin/(app)/leads/actions";

const settings: BusinessSettings = {
  ...SETTINGS_DEFAULTS,
  washOffer: { ...SETTINGS_DEFAULTS.washOffer, enabled: true },
};
const offer = activeWashOffer(settings)!;
const BASE = "https://shop.example";

async function resetDb() {
  await db().execute(sql`
    TRUNCATE offer_claims, appointment_services, appointments, jobs, invoices, vehicles, customers, leads,
             communications, marketing_suppressions, message_templates, audit_log, staff_users,
             business_settings CASCADE
  `);
  await db().insert(schema.staffUsers).values({
    id: auth.actor.id,
    name: auth.actor.name,
    email: auth.actor.email,
    passwordHash: "not-used-in-tests",
    role: auth.actor.role,
    active: true,
  });
  await db().insert(schema.businessSettings).values({ key: "washOffer", value: settings.washOffer });
  messaging.fail = false;
  auth.requireStaff.mockClear();
  auth.requireStaff.mockResolvedValue(auth.actor);
}

async function claim(input: { firstName?: string; phone?: string; email?: string; consent?: boolean } = {}) {
  const { claim } = await issueClaim({
    offer,
    firstName: input.firstName ?? "Priya",
    lastName: "Shah",
    phone: input.phone ?? "905-555-0142",
    email: input.email ?? "priya@example.com",
    vehicleSize: "car",
    marketingConsent: input.consent ?? true,
    termsVersion: "test",
  });
  return claim;
}

async function reload(claimId: string) {
  const [row] = await db().select().from(schema.offerClaims).where(eq(schema.offerClaims.id, claimId));
  return row;
}

function nudge(claimIds: string[], extra: Partial<Parameters<typeof sendClaimNudges>[0]> = {}) {
  return sendClaimNudges({
    claimIds,
    channel: "sms",
    body: DEFAULT_NUDGE_SMS,
    staffId: auth.actor.id,
    settings,
    offer,
    baseUrl: BASE,
    ...extra,
  });
}

beforeEach(resetDb);
afterAll(async () => {
  await getPool().end();
});

describe("nudge wording", () => {
  it("ships a default text that can be sent as it stands", () => {
    expect(DEFAULT_NUDGE_SMS).toMatch(/Reply STOP/);
    expect(DEFAULT_NUDGE_SMS).toContain("{{businessName}}");
    expect(unknownNudgePlaceholders(DEFAULT_NUDGE_SMS, DEFAULT_NUDGE_EMAIL_SUBJECT, DEFAULT_NUDGE_EMAIL_BODY)).toEqual([]);
    // One curly quote or em dash would halve every segment and double the bill.
    expect(smsSegments(DEFAULT_NUDGE_SMS).encoding).toBe("GSM-7");
  });

  it("fills known placeholders and leaves unknown ones visible", () => {
    const values = {
      firstName: "Sam",
      code: "PTW-7QK2MB",
      price: "$15.99",
      expires: "Friday, September 25",
      daysLeft: "3 days",
      link: "https://x/w/PTW7QK2MB",
      phone: "905-555-0100",
      businessName: "Shop",
    };
    expect(renderNudge("Hi {{firstName}}, {{code}} {{nope}}", values)).toBe("Hi Sam, PTW-7QK2MB {{nope}}");
    expect(unknownNudgePlaceholders("{{firstName}} {{FirstName}} {{nope}}")).toEqual(["FirstName", "nope"]);
  });

  it("counts days left the way a customer reads them", () => {
    const now = Date.UTC(2026, 8, 17, 12);
    expect(daysLeftLabel(new Date(now + 5 * 86_400_000), now)).toBe("5 days");
    expect(daysLeftLabel(new Date(now + 3_600_000), now)).toBe("1 day");
    expect(daysLeftLabel(new Date(now - 1), now)).toBe("today");
  });
});

describe("sending a nudge", () => {
  it("texts an open code, fills in the placeholders and counts it", async () => {
    const c = await claim();
    const [outcome] = await nudge([c.id]);
    expect(outcome.status).toBe("sent");

    const after = await reload(c.id);
    expect(after.smsNudgesSent).toBe(1);
    expect(after.emailNudgesSent).toBe(0);
    expect(after.lastSmsNudgeAt).not.toBeNull();
    // The automatic schedule is untouched by a manual nudge.
    expect(after.remindersSent).toBe(0);

    const [message] = await db()
      .select()
      .from(schema.communications)
      .where(and(eq(schema.communications.relatedEntityId, c.id), eq(schema.communications.kind, "marketing")));
    expect(message.channel).toBe("sms");
    expect(message.leadId).toBe(c.leadId);
    expect(message.createdByStaffId).toBe(auth.actor.id);
    expect(message.body).toContain("Hi Priya");
    expect(message.body).toContain("PTW-");
    expect(message.body).toContain("$15.99");
    expect(message.body).toContain(`${BASE}/w/${c.code}`);
    expect(message.body).not.toMatch(/\{\{/);
  });

  it("never nudges the same person twice on one channel inside the cooldown", async () => {
    const c = await claim();
    const now = Date.now();
    expect((await nudge([c.id], { nowMs: now }))[0].status).toBe("sent");

    const again = await nudge([c.id], { nowMs: now + 60_000 });
    expect(again[0]).toMatchObject({ status: "skipped", reason: "Texted in the last 20 hours" });

    // Email is its own channel, with its own day.
    const email = await nudge([c.id], { nowMs: now + 60_000, channel: "email", subject: "Hi {{firstName}}" });
    expect(email[0].status).toBe("sent");

    const nextDay = await nudge([c.id], { nowMs: now + NUDGE_COOLDOWN_MS + 60_000 });
    expect(nextDay[0].status).toBe("sent");

    const after = await reload(c.id);
    expect(after.smsNudgesSent).toBe(2);
    expect(after.emailNudgesSent).toBe(1);
  });

  it("sends once when two staff press send on the same person together", async () => {
    const c = await claim();
    const results = await Promise.all([nudge([c.id]), nudge([c.id]), nudge([c.id])]);
    const sent = results.flat().filter((o) => o.status === "sent");
    expect(sent).toHaveLength(1);
    expect((await reload(c.id)).smsNudgesSent).toBe(1);
  });

  it("appends the address and a working unsubscribe link to an email", async () => {
    const c = await claim();
    const [outcome] = await nudge([c.id], {
      channel: "email",
      subject: "{{firstName}}, your {{price}} wash",
      body: "Your code {{code}} is waiting.",
    });
    expect(outcome.status).toBe("sent");

    const [message] = await db()
      .select()
      .from(schema.communications)
      .where(eq(schema.communications.relatedEntityId, c.id));
    expect(message.subject).toBe("Priya, your $15.99 wash");
    expect(message.body).toContain("Your code PTW-");
    expect(message.body).toContain(`${BASE}/unsubscribe/${c.leadId}.`);
    expect(message.body).toContain(settings.businessName);
  });

  it("skips anyone who replied STOP, without writing a message", async () => {
    const c = await claim();
    await addSuppression(db(), { channel: "sms", destination: "905-555-0142", reason: "stop_reply" });

    const [outcome] = await nudge([c.id]);
    expect(outcome).toMatchObject({ status: "skipped", reason: "Replied STOP" });
    expect((await reload(c.id)).lastSmsNudgeAt).toBeNull();
    expect(await db().select().from(schema.communications)).toHaveLength(0);
  });

  it("skips a claimant with no message consent on file", async () => {
    const c = await claim({ consent: false });
    const [outcome] = await nudge([c.id]);
    expect(outcome).toMatchObject({ status: "skipped", reason: "No message consent on file" });
  });

  it("only nudges open codes — not booked, washed, released or expired ones", async () => {
    const booked = await claim({ phone: "905-555-0201", email: "a@example.com" });
    const washed = await claim({ phone: "905-555-0202", email: "b@example.com" });
    const released = await claim({ phone: "905-555-0203", email: "c@example.com" });
    const expired = await claim({ phone: "905-555-0204", email: "d@example.com" });
    await db().update(schema.offerClaims).set({ status: "booked" }).where(eq(schema.offerClaims.id, booked.id));
    await redeemClaimAgainstPlate({ claimId: washed.id, rawPlate: "CABC 101", staffId: auth.actor.id });
    await db().update(schema.offerClaims).set({ status: "void" }).where(eq(schema.offerClaims.id, released.id));
    await db()
      .update(schema.offerClaims)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.offerClaims.id, expired.id));

    const outcomes = await nudge([booked.id, washed.id, released.id, expired.id]);
    expect(outcomes.map((o) => [o.status, o.reason])).toEqual([
      ["skipped", "Already booked"],
      ["skipped", "Already washed"],
      ["skipped", "Released"],
      ["skipped", "Code has expired"],
    ]);
    expect(await db().select().from(schema.communications)).toHaveLength(0);
  });

  it("gives the day back when the provider refuses the message", async () => {
    const c = await claim();
    messaging.fail = true;
    const [outcome] = await nudge([c.id]);
    expect(outcome.status).toBe("failed");

    const after = await reload(c.id);
    expect(after.smsNudgesSent).toBe(0);
    expect(after.lastSmsNudgeAt).toBeNull();

    messaging.fail = false;
    expect((await nudge([c.id]))[0].status).toBe("sent");
  });
});

describe("the nudge action", () => {
  it("refuses a text without an opt-out line", async () => {
    const c = await claim();
    const result = await sendWashNudgesAction({
      claimIds: [c.id],
      channel: "sms",
      body: "Hi {{firstName}}, come get your wash!",
    });
    expect(result.ok).toBe(false);
    expect(await db().select().from(schema.communications)).toHaveLength(0);
  });

  it("refuses a placeholder it cannot fill", async () => {
    const c = await claim();
    const result = await sendWashNudgesAction({
      claimIds: [c.id],
      channel: "sms",
      body: "Hi {{firstname}} from {{businessName}}. Reply STOP to opt out.",
    });
    expect(result).toEqual({ ok: false, error: "Unknown placeholder: {{firstname}}." });
  });

  it("sends and reports each person's outcome", async () => {
    const open = await claim({ phone: "905-555-0301", email: "e@example.com" });
    const noConsent = await claim({ phone: "905-555-0302", email: "f@example.com", consent: false });
    const result = await sendWashNudgesAction({
      claimIds: [open.id, noConsent.id],
      channel: "sms",
      body: DEFAULT_NUDGE_SMS,
    });
    expect(result).toMatchObject({ ok: true, sent: 1, skipped: 1, failed: 0 });

    const audits = await db()
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "offer_claim.nudged"));
    expect(audits.map((a) => a.entityId)).toEqual([open.id]);
  });
});

describe("redeeming a walk-in", () => {
  it("creates the customer from the claim, spends the plate and completes the lead", async () => {
    const c = await claim();
    const result = await redeemWalkInClaimAction({ claimId: c.id, plate: "cabc 123", customer: "new" });
    expect(result).toMatchObject({ ok: true, createdCustomer: true });
    if (!result.ok) throw new Error("expected success");

    const [customer] = await db().select().from(schema.customers).where(eq(schema.customers.id, result.customerId!));
    expect(customer).toMatchObject({
      firstName: "Priya",
      lastName: "Shah",
      phoneNormalized: "9055550142",
      email: "priya@example.com",
      marketingConsent: true,
      marketingConsentSource: "public_offer_terms",
      sourceLeadId: c.leadId,
    });

    const after = await reload(c.id);
    expect(after).toMatchObject({ status: "redeemed", redeemedPlateNormalized: "CABC123", customerId: customer.id });
    expect(after.appointmentId).toBeNull();

    const [lead] = await db().select().from(schema.leads).where(eq(schema.leads.id, c.leadId!));
    expect(lead).toMatchObject({ status: "completed", convertedCustomerId: customer.id });

    // The code is now spent for booking too.
    const lookup = await findOfferClaimAction({ code: c.code });
    expect(lookup.ok && lookup.claim.status).toBe("redeemed");
  });

  it("refuses a plate that already had the offer — and keeps the customer it created", async () => {
    const first = await claim({ phone: "905-555-0401", email: "g@example.com" });
    const second = await claim({ phone: "905-555-0402", email: "h@example.com", firstName: "Jon" });
    expect((await redeemWalkInClaimAction({ claimId: first.id, plate: "CABC123", customer: "none" })).ok).toBe(true);

    const result = await redeemWalkInClaimAction({ claimId: second.id, plate: "cabc-123", customer: "new" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.error).toContain("Plate CABC123 already had the offer");
    expect(result.createdCustomer).toBe(true);

    expect((await reload(second.id)).status).toBe("issued");
    const [lead] = await db().select().from(schema.leads).where(eq(schema.leads.id, second.leadId!));
    expect(lead.status).toBe("new");
  });

  it("links an existing customer, finds them by phone, and puts the plate on their only car", async () => {
    const c = await claim();
    const customerId = newId("cus");
    await db().insert(schema.customers).values({
      id: customerId,
      firstName: "Priya",
      lastName: "Shah",
      phone: "(905) 555-0142",
      phoneNormalized: "9055550142",
    });
    const vehicleId = newId("veh");
    await db().insert(schema.vehicles).values({
      id: vehicleId,
      customerId,
      make: "Honda",
      model: "Civic",
      category: "sedan",
    });

    // Staff type just the part after the dash, as it is read aloud.
    const lookup = await findOfferClaimAction({ code: c.code.slice(3) });
    expect(lookup.ok).toBe(true);
    if (!lookup.ok) throw new Error("expected a claim");
    expect(lookup.claim.matches.map((m) => m.id)).toEqual([customerId]);
    expect(lookup.claim.priceLabel).toBe("$15.99");

    const result = await redeemWalkInClaimAction({ claimId: c.id, plate: "cvbn 456", customer: customerId });
    expect(result).toMatchObject({ ok: true, customerId, createdCustomer: false });

    const [vehicle] = await db().select().from(schema.vehicles).where(eq(schema.vehicles.id, vehicleId));
    expect(vehicle.licencePlate).toBe("CVBN 456");
    expect(await db().select().from(schema.customers)).toHaveLength(1);
  });

  it("will not honour an expired code unless staff say so", async () => {
    const c = await claim();
    await db()
      .update(schema.offerClaims)
      .set({ expiresAt: new Date(Date.now() - 86_400_000) })
      .where(eq(schema.offerClaims.id, c.id));

    const refused = await redeemWalkInClaimAction({ claimId: c.id, plate: "CABC123", customer: "none" });
    expect(refused.ok).toBe(false);
    expect((await reload(c.id)).redeemedPlateNormalized).toBeNull();

    const honoured = await redeemWalkInClaimAction({
      claimId: c.id,
      plate: "CABC123",
      customer: "none",
      honourExpired: true,
    });
    expect(honoured.ok).toBe(true);
  });

  it("refuses a released code and a code already used", async () => {
    const released = await claim({ phone: "905-555-0501", email: "i@example.com" });
    await db().update(schema.offerClaims).set({ status: "void" }).where(eq(schema.offerClaims.id, released.id));
    expect((await redeemWalkInClaimAction({ claimId: released.id, plate: "AAA111", customer: "none" })).ok).toBe(false);

    const used = await claim({ phone: "905-555-0502", email: "j@example.com" });
    expect((await redeemWalkInClaimAction({ claimId: used.id, plate: "BBB222", customer: "none" })).ok).toBe(true);
    const again = await redeemWalkInClaimAction({ claimId: used.id, plate: "CCC333", customer: "none" });
    expect(again).toMatchObject({ ok: false, error: "This code was already used, on plate BBB222." });
  });

  it("completes the lead when the plate is recorded on a booking too", async () => {
    const c = await claim();
    const customerId = newId("cus");
    await db().insert(schema.customers).values({ id: customerId, firstName: "Priya", phone: "9055550142" });
    await db()
      .update(schema.offerClaims)
      .set({ status: "booked", customerId })
      .where(eq(schema.offerClaims.id, c.id));

    expect((await redeemOfferClaimAction({ claimId: c.id, plate: "CABC123" })).ok).toBe(true);
    const [lead] = await db().select().from(schema.leads).where(eq(schema.leads.id, c.leadId!));
    expect(lead).toMatchObject({ status: "completed", convertedCustomerId: customerId });
  });
});

describe("the completed lead status", () => {
  it("can be chosen by hand, and a converted lead may move to it but not back to new", async () => {
    const leadId = newId("lead");
    const customerId = newId("cus");
    await db().insert(schema.customers).values({ id: customerId, firstName: "Avery" });
    await db().insert(schema.leads).values({
      id: leadId,
      name: "Avery",
      kind: "quote",
      status: "converted",
      convertedCustomerId: customerId,
    });

    expect(await setLeadStatusAction({ leadId, status: "completed" })).toEqual({ ok: true });
    expect(await setLeadStatusAction({ leadId, status: "new" })).toMatchObject({ ok: false });
    expect(await setLeadStatusAction({ leadId, status: "converted" })).toEqual({ ok: true });

    const plain = newId("lead");
    await db().insert(schema.leads).values({ id: plain, name: "Blake", kind: "general" });
    expect(await setLeadStatusAction({ leadId: plain, status: "completed" })).toEqual({ ok: true });
  });
});
