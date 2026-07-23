import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db, getPool, schema } from "../src/db";
import { newId } from "../src/lib/id";
import { sendMessageTemplate } from "../src/lib/messaging";

async function resetDb() {
  await db().execute(sql`TRUNCATE communications, message_templates, customers CASCADE`);
}

async function addTemplate(input: { key: string; channel: string; active?: boolean }) {
  await db().insert(schema.messageTemplates).values({
    id: newId("tpl"),
    key: input.key,
    channel: input.channel,
    subject: "Hello {{firstName}}",
    body: "Hi {{firstName}} from {{businessName}}",
    active: input.active ?? true,
  });
}

describe("sendMessageTemplate", () => {
  afterAll(async () => {
    await getPool().end();
  });

  beforeEach(resetDb);

  it("does not send or record an inactive template", async () => {
    await addTemplate({ key: "lead_ack", channel: "email", active: false });
    const result = await sendMessageTemplate({
      templateKey: "lead_ack",
      recipient: { email: "customer@example.com", phone: "+15551234567" },
      leadId: newId("lead"),
      kind: "lead_ack",
      variables: { firstName: "Ari", businessName: "Personal Touch" },
    });

    expect(result).toEqual({ sent: false, reason: "template_inactive" });
    expect(await db().select().from(schema.communications)).toHaveLength(0);
  });

  it("does not fall back when the configured channel has no destination", async () => {
    await addTemplate({ key: "vehicle_ready", channel: "sms" });
    const result = await sendMessageTemplate({
      templateKey: "vehicle_ready",
      recipient: { email: "customer@example.com" },
      kind: "ready",
      variables: { firstName: "Ari", businessName: "Personal Touch" },
    });

    expect(result).toEqual({ sent: false, channel: "sms", reason: "no_destination" });
    expect(await db().select().from(schema.communications)).toHaveLength(0);
  });

  it("renders and records through the stored channel", async () => {
    await addTemplate({ key: "vehicle_ready", channel: "sms" });
    const result = await sendMessageTemplate({
      templateKey: "vehicle_ready",
      recipient: { email: "customer@example.com", phone: "+15551234567" },
      kind: "ready",
      variables: { firstName: "Ari", businessName: "Personal Touch" },
    });

    expect(result.sent).toBe(true);
    expect(result.channel).toBe("sms");
    const [message] = await db().select().from(schema.communications);
    expect(message.channel).toBe("sms");
    expect(message.subject).toBeNull();
    expect(message.body).toBe("Hi Ari from Personal Touch");
  });

  it("keeps marketing consent enforcement while allowing operational delivery", async () => {
    const customerId = newId("cus");
    await db().insert(schema.customers).values({
      id: customerId,
      firstName: "Ari",
      lastName: "Customer",
      email: "customer@example.com",
      marketingConsent: false,
    });
    await addTemplate({ key: "review_request", channel: "email" });
    await addTemplate({ key: "booking_confirmation", channel: "email" });

    const review = await sendMessageTemplate({
      templateKey: "review_request",
      recipient: { email: "customer@example.com" },
      customerId,
      kind: "review_request",
      variables: { firstName: "Ari", businessName: "Personal Touch" },
    });
    const confirmation = await sendMessageTemplate({
      templateKey: "booking_confirmation",
      recipient: { email: "customer@example.com" },
      customerId,
      kind: "confirmation",
      variables: { firstName: "Ari", businessName: "Personal Touch" },
    });

    expect(review).toMatchObject({ sent: false, reason: "suppressed", channel: "email" });
    expect(confirmation).toMatchObject({ sent: true, channel: "email" });
    const messages = await db().select().from(schema.communications);
    expect(messages).toHaveLength(2);
    expect(messages.map((message) => message.status).sort()).toEqual(["failed", "logged"]);
  });
});
