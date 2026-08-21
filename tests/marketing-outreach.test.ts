import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db, getPool, schema } from "../src/db";
import { newId } from "../src/lib/id";
import {
  campaignProgress,
  queueRecipients,
  sendOutreachBatch,
} from "../src/lib/marketing/outreach";
import { addSuppression, isSuppressed } from "../src/lib/marketing/suppressions";
import { sendMessage } from "../src/lib/messaging";

async function resetDb() {
  await db().execute(
    sql`TRUNCATE outreach_recipients, outreach_campaigns, marketing_suppressions, communications, leads, customers CASCADE`,
  );
}

async function addLead(input: { consent: boolean; phone?: string; email?: string }) {
  const id = newId("lead");
  await db().insert(schema.leads).values({
    id,
    name: "Dave Mitchell",
    phone: input.phone ?? "905 555 1234",
    phoneNormalized: (input.phone ?? "905 555 1234").replace(/\D/g, ""),
    email: input.email ?? null,
    companyName: "Hamilton Plumbing",
    kind: "fleet",
    marketingConsent: input.consent,
  });
  return id;
}

async function addCampaign(input: { channel: "sms" | "email"; allowRecontact?: boolean }) {
  const id = newId("ocm");
  await db().insert(schema.outreachCampaigns).values({
    id,
    name: "Fleet outreach",
    channel: input.channel,
    subject: input.channel === "email" ? "Fleet detailing" : null,
    body: "Hi {{FirstName}} at {{Company}} — reply STOP to opt out.",
    status: "sending",
    allowRecontact: input.allowRecontact ?? false,
  });
  const [campaign] = await db()
    .select()
    .from(schema.outreachCampaigns)
    .where(eq(schema.outreachCampaigns.id, id));
  return { ...campaign, channel: campaign.channel as "sms" | "email" };
}

// One pool for the file: ending it inside a describe would close it for the
// blocks that follow.
afterAll(async () => {
  await getPool().end();
});

describe("marketing consent gate", () => {
  beforeEach(resetDb);

  it("refuses a marketing message to a lead with no recorded consent", async () => {
    const leadId = await addLead({ consent: false });
    const result = await sendMessage({
      leadId,
      channel: "sms",
      kind: "marketing",
      to: "905 555 1234",
      body: "Fleet quote?",
    });

    expect(result).toMatchObject({ sent: false, reason: "suppressed" });
    const [row] = await db().select().from(schema.communications);
    expect(row.body).toContain("[SUPPRESSED — no marketing consent]");
    expect(row.status).toBe("failed");
  });

  it("sends to a lead whose consent was recorded", async () => {
    const leadId = await addLead({ consent: true });
    const result = await sendMessage({
      leadId,
      channel: "sms",
      kind: "marketing",
      to: "905 555 1234",
      body: "Fleet quote?",
    });

    expect(result.sent).toBe(true);
    const [row] = await db().select().from(schema.communications);
    expect(row.leadId).toBe(leadId);
    expect(row.body).not.toContain("SUPPRESSED");
  });

  it("still refuses when the contact has opted out, consent or not", async () => {
    const leadId = await addLead({ consent: true });
    await addSuppression(db(), { channel: "sms", destination: "+1 905 555 1234", reason: "stop_reply" });

    const result = await sendMessage({
      leadId,
      channel: "sms",
      kind: "marketing",
      to: "(905) 555-1234",
      body: "Fleet quote?",
    });

    expect(result).toMatchObject({ sent: false, reason: "suppressed" });
    const [row] = await db().select().from(schema.communications);
    expect(row.body).toContain("[SUPPRESSED — opted out]");
  });

  it("matches an opt-out however the number was typed", async () => {
    await addSuppression(db(), { channel: "sms", destination: "9055551234", reason: "manual" });
    expect(await isSuppressed("sms", "+1 (905) 555-1234")).toBe(true);
    expect(await isSuppressed("sms", "905 555 9999")).toBe(false);
  });

  it("lets operational messages through to someone who opted out of marketing", async () => {
    const leadId = await addLead({ consent: false });
    await addSuppression(db(), { channel: "sms", destination: "9055551234", reason: "stop_reply" });

    const result = await sendMessage({
      leadId,
      channel: "sms",
      kind: "confirmation",
      to: "905 555 1234",
      body: "Your appointment is confirmed for Tuesday at 9am.",
    });

    expect(result.sent).toBe(true);
  });

  it("refuses a marketing message with no party attached at all", async () => {
    await expect(
      sendMessage({ channel: "sms", kind: "marketing", to: "905 555 1234", body: "Hi" }),
    ).rejects.toThrow(/requires a customer or lead/);
  });
});

describe("queueRecipients", () => {
  beforeEach(resetDb);

  it("collapses the same number entered twice in one paste", async () => {
    const campaign = await addCampaign({ channel: "sms" });
    const result = await queueRecipients(db(), campaign, [
      { destination: "905 555 1234", firstName: "Dave", companyName: "Acme" },
      { destination: "+1 (905) 555-1234", firstName: "Dave", companyName: "Acme" },
    ]);

    expect(result.queued).toBe(1);
    expect(result.duplicates).toBe(1);
  });

  it("does not add someone who is already on the campaign", async () => {
    const campaign = await addCampaign({ channel: "sms" });
    await queueRecipients(db(), campaign, [
      { destination: "905 555 1234", firstName: "Dave", companyName: "Acme" },
    ]);
    const second = await queueRecipients(db(), campaign, [
      { destination: "9055551234", firstName: "Dave", companyName: "Acme" },
    ]);

    expect(second.queued).toBe(0);
    expect(second.duplicates).toBe(1);
    expect(await db().select().from(schema.outreachRecipients)).toHaveLength(1);
  });

  it("counts a destination it cannot use", async () => {
    const campaign = await addCampaign({ channel: "email" });
    const result = await queueRecipients(db(), campaign, [
      { destination: "not-an-address", firstName: "Dave", companyName: "Acme" },
    ]);
    expect(result).toEqual({ queued: 0, duplicates: 0, invalid: 1 });
  });
});

describe("sendOutreachBatch", () => {
  beforeEach(resetDb);

  it("sends only as many as the batch allows and leaves the rest waiting", async () => {
    const campaign = await addCampaign({ channel: "sms" });
    for (let i = 0; i < 5; i++) {
      const leadId = await addLead({ consent: true, phone: `90555512${10 + i}` });
      await queueRecipients(db(), campaign, [
        { leadId, destination: `90555512${10 + i}`, firstName: "Dave", companyName: "Acme" },
      ]);
    }

    const outcome = await sendOutreachBatch(campaign, 2);
    expect(outcome).toMatchObject({ attempted: 2, sent: 2, failed: 0, skipped: 0 });
    expect(await campaignProgress(campaign.id)).toMatchObject({ sent: 2, pending: 3 });
  });

  it("records the message each contact actually received", async () => {
    const campaign = await addCampaign({ channel: "sms" });
    const leadId = await addLead({ consent: true });
    await queueRecipients(db(), campaign, [
      { leadId, destination: "905 555 1234", firstName: "Dave", companyName: "Hamilton Plumbing" },
    ]);

    await sendOutreachBatch(campaign, 5);
    const [recipient] = await db().select().from(schema.outreachRecipients);
    expect(recipient.status).toBe("sent");
    expect(recipient.renderedBody).toBe("Hi Dave at Hamilton Plumbing — reply STOP to opt out.");
    expect(recipient.sentAt).not.toBeNull();
    expect(recipient.communicationId).not.toBeNull();
  });

  it("skips rather than sends when the contact has opted out", async () => {
    const campaign = await addCampaign({ channel: "sms" });
    const leadId = await addLead({ consent: true });
    await addSuppression(db(), { channel: "sms", destination: "9055551234", reason: "stop_reply" });
    await queueRecipients(db(), campaign, [
      { leadId, destination: "905 555 1234", firstName: "Dave", companyName: "Acme" },
    ]);

    const outcome = await sendOutreachBatch(campaign, 5);
    expect(outcome).toMatchObject({ sent: 0, skipped: 1, failed: 0 });
    const [recipient] = await db().select().from(schema.outreachRecipients);
    expect(recipient.status).toBe("skipped");
    expect(recipient.skipReason).toBe("Opted out or consent not recorded");
  });

  it("will not message someone a previous campaign already reached", async () => {
    const first = await addCampaign({ channel: "sms" });
    const leadId = await addLead({ consent: true });
    await queueRecipients(db(), first, [
      { leadId, destination: "905 555 1234", firstName: "Dave", companyName: "Acme" },
    ]);
    await sendOutreachBatch(first, 5);

    const second = await addCampaign({ channel: "sms" });
    await queueRecipients(db(), second, [
      { leadId, destination: "905 555 1234", firstName: "Dave", companyName: "Acme" },
    ]);
    const outcome = await sendOutreachBatch(second, 5);

    expect(outcome).toMatchObject({ sent: 0, skipped: 1 });
    const rows = await db()
      .select()
      .from(schema.outreachRecipients)
      .where(eq(schema.outreachRecipients.campaignId, second.id));
    expect(rows[0].skipReason).toBe("Already messaged in an earlier campaign");
  });

  it("messages them again when the campaign deliberately allows it", async () => {
    const first = await addCampaign({ channel: "sms" });
    const leadId = await addLead({ consent: true });
    await queueRecipients(db(), first, [
      { leadId, destination: "905 555 1234", firstName: "Dave", companyName: "Acme" },
    ]);
    await sendOutreachBatch(first, 5);

    const second = await addCampaign({ channel: "sms", allowRecontact: true });
    await queueRecipients(db(), second, [
      { leadId, destination: "905 555 1234", firstName: "Dave", companyName: "Acme" },
    ]);

    expect(await sendOutreachBatch(second, 5)).toMatchObject({ sent: 1, skipped: 0 });
  });

  it("does nothing when there is nobody left to send to", async () => {
    const campaign = await addCampaign({ channel: "sms" });
    expect(await sendOutreachBatch(campaign, 10)).toMatchObject({ attempted: 0, sent: 0 });
  });
});
