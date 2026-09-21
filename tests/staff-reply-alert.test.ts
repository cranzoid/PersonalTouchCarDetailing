import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db, getPool, schema } from "../src/db";
import { newId } from "../src/lib/id";
import { setSetting } from "../src/lib/settings";
import { notifyStaffOfCustomerReply } from "../src/lib/staff-notifications";

/**
 * The alert that sends staff to the replies inbox. Sends are log-only outside
 * production, so every assertion here reads the communications rows the fan-out
 * writes — one per configured recipient.
 */

const STAFF_PHONE = "+19055559000";
const STAFF_EMAIL = "owner@example.com";

async function resetDb() {
  await db().execute(
    sql`TRUNCATE business_settings, communications, webhook_events, leads, customers CASCADE`,
  );
  await setSetting("staffNotifyPhones", [STAFF_PHONE]);
  await setSetting("staffNotifyEmails", [STAFF_EMAIL]);
}

async function addCustomer() {
  const id = newId("cus");
  await db().insert(schema.customers).values({
    id,
    firstName: "Dana",
    lastName: "Reyes",
    phone: "(905) 555-1234",
    phoneNormalized: "9055551234",
  });
  return id;
}

/** The staff alerts written so far, newest last. */
async function alerts() {
  return db()
    .select()
    .from(schema.communications)
    .where(
      and(
        eq(schema.communications.kind, "staff_alert"),
        eq(schema.communications.relatedEntityType, "customer_reply"),
      ),
    );
}

afterAll(async () => {
  await getPool().end();
});

describe("notifyStaffOfCustomerReply", () => {
  beforeEach(resetDb);

  it("tells every configured recipient who wrote in and what they said", async () => {
    const customerId = await addCustomer();
    const outcome = await notifyStaffOfCustomerReply({
      from: "+19055551234",
      body: "Can I move Friday to Saturday?",
      customerId,
      leadId: null,
      needsAttention: false,
    });

    expect(outcome).toEqual({ attempted: 2, sent: 2 });
    const rows = await alerts();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.channel).sort()).toEqual(["email", "sms"]);
    for (const row of rows) {
      expect(row.body).toContain("Dana Reyes");
      expect(row.body).toContain("Can I move Friday to Saturday?");
      expect(row.body).toContain("/admin/messages");
      // Threaded on the number, which is what the throttle keys on too.
      expect(row.relatedEntityId).toBe("9055551234");
    }
  });

  it("names the number when the sender matches nothing we hold", async () => {
    await notifyStaffOfCustomerReply({
      from: "+16135550000",
      body: "how much for a full detail",
      customerId: null,
      leadId: null,
      needsAttention: false,
    });

    const [row] = await alerts();
    expect(row.body).toContain("Unknown number");
    expect(row.body).toContain("(613) 555-0000");
  });

  it("flags a reply that reads like an opt-out so nobody texts back blindly", async () => {
    await notifyStaffOfCustomerReply({
      from: "+19055551234",
      body: "please take me off your list",
      customerId: null,
      leadId: null,
      needsAttention: true,
    });

    const [row] = await alerts();
    expect(row.body).toContain("opt-out request");
  });

  it("does not wake anyone twice for one conversation", async () => {
    const customerId = await addCustomer();
    const first = await notifyStaffOfCustomerReply({
      from: "+19055551234",
      body: "Hi",
      customerId,
      leadId: null,
      needsAttention: false,
    });
    const second = await notifyStaffOfCustomerReply({
      from: "(905) 555-1234",
      body: "sorry, meant to ask about Saturday",
      customerId,
      leadId: null,
      needsAttention: false,
    });

    expect(first.sent).toBe(2);
    expect(second).toEqual({ attempted: 0, sent: 0 });
    expect(await alerts()).toHaveLength(2);
  });

  it("still alerts when a different person writes in during the window", async () => {
    await notifyStaffOfCustomerReply({
      from: "+19055551234",
      body: "Hi",
      customerId: null,
      leadId: null,
      needsAttention: false,
    });
    const other = await notifyStaffOfCustomerReply({
      from: "+16135550000",
      body: "Hi",
      customerId: null,
      leadId: null,
      needsAttention: false,
    });

    expect(other).toEqual({ attempted: 2, sent: 2 });
  });

  it("ignores a text from one of the alert phones, rather than alerting it about itself", async () => {
    const outcome = await notifyStaffOfCustomerReply({
      from: STAFF_PHONE,
      body: "testing the number",
      customerId: null,
      leadId: null,
      needsAttention: false,
    });

    expect(outcome).toEqual({ attempted: 0, sent: 0 });
    expect(await alerts()).toHaveLength(0);
  });

  it("sends nothing when the owners switch reply alerts off", async () => {
    await setSetting("notifyOnCustomerReply", false);
    const outcome = await notifyStaffOfCustomerReply({
      from: "+19055551234",
      body: "Hi",
      customerId: null,
      leadId: null,
      needsAttention: false,
    });

    expect(outcome).toEqual({ attempted: 0, sent: 0 });
    expect(await alerts()).toHaveLength(0);
  });

  it("sends nothing when no recipients are configured", async () => {
    await setSetting("staffNotifyPhones", []);
    await setSetting("staffNotifyEmails", []);
    const outcome = await notifyStaffOfCustomerReply({
      from: "+19055551234",
      body: "Hi",
      customerId: null,
      leadId: null,
      needsAttention: false,
    });

    expect(outcome).toEqual({ attempted: 0, sent: 0 });
    expect(await alerts()).toHaveLength(0);
  });
});
