import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db, getPool, schema } from "../src/db";
import { newId } from "../src/lib/id";
import { SETTINGS_DEFAULTS, setSetting } from "../src/lib/settings";
import { notifyStaff, notifyStaffOfCustomerReply } from "../src/lib/staff-notifications";

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
  // The shipped default copies replies to a further address; the tests below
  // count recipients, so they start from none and opt in where it matters.
  await setSetting("replyCopyEmails", []);
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

  describe("reply copy emails", () => {
    const COPY_EMAIL = "copy@example.com";
    const reply = () =>
      notifyStaffOfCustomerReply({
        from: "+19055551234",
        body: "Can I move Friday to Saturday?",
        customerId: null,
        leadId: null,
        needsAttention: false,
      });

    it("emails the copy address the same alert, and nothing else changes", async () => {
      await setSetting("replyCopyEmails", [COPY_EMAIL]);
      const outcome = await reply();

      expect(outcome).toEqual({ attempted: 3, sent: 3 });
      const rows = await alerts();
      const copy = rows.find((r) => r.contactAddress === COPY_EMAIL);
      expect(copy?.channel).toBe("email");
      expect(copy?.subject).toBe("Reply from Unknown number");
      expect(copy?.body).toContain("Can I move Friday to Saturday?");
      // Staff still get theirs — the copy is added to the fan-out, not swapped in.
      expect(rows.map((r) => r.contactAddress).sort()).toEqual([COPY_EMAIL, STAFF_EMAIL, STAFF_PHONE].sort());
    });

    it("sends one email, not two, to an address that is also a staff alert email", async () => {
      await setSetting("replyCopyEmails", [STAFF_EMAIL.toUpperCase()]);
      const outcome = await reply();

      expect(outcome).toEqual({ attempted: 2, sent: 2 });
      expect((await alerts()).filter((r) => r.channel === "email")).toHaveLength(1);
    });

    it("still alerts the copy address when no staff phone or email is listed", async () => {
      await setSetting("staffNotifyPhones", []);
      await setSetting("staffNotifyEmails", []);
      await setSetting("replyCopyEmails", [COPY_EMAIL]);
      const outcome = await reply();

      expect(outcome).toEqual({ attempted: 1, sent: 1 });
      const [row] = await alerts();
      expect(row.contactAddress).toBe(COPY_EMAIL);
    });

    it("is switched off with the rest of the reply alerts", async () => {
      await setSetting("replyCopyEmails", [COPY_EMAIL]);
      await setSetting("notifyOnCustomerReply", false);

      expect(await reply()).toEqual({ attempted: 0, sent: 0 });
      expect(await alerts()).toHaveLength(0);
    });

    it("ships with a default copy address, in force before anyone saves the setting", async () => {
      await db().execute(sql`TRUNCATE business_settings`);
      await setSetting("staffNotifyPhones", []);
      await setSetting("staffNotifyEmails", []);
      const outcome = await reply();

      expect(SETTINGS_DEFAULTS.replyCopyEmails.length).toBeGreaterThan(0);
      expect(outcome).toEqual({ attempted: SETTINGS_DEFAULTS.replyCopyEmails.length, sent: SETTINGS_DEFAULTS.replyCopyEmails.length });
      expect((await alerts()).map((r) => r.contactAddress)).toEqual(SETTINGS_DEFAULTS.replyCopyEmails);
    });

    it("does not copy a booking alert, which has its own list", async () => {
      await setSetting("replyCopyEmails", [COPY_EMAIL]);
      await notifyStaff({ subject: "Booking", body: "A booking", relatedType: "appointment", relatedId: "apt_1" });

      const rows = await db()
        .select()
        .from(schema.communications)
        .where(eq(schema.communications.kind, "staff_alert"));
      expect(rows.map((r) => r.contactAddress)).not.toContain(COPY_EMAIL);
    });
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
