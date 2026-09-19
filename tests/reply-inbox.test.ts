import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db, getPool, schema } from "../src/db";
import { newId } from "../src/lib/id";
import { recordInboundSms } from "../src/lib/marketing/inbound";
import { sendMessage } from "../src/lib/messaging";
import {
  buildReplyThreads,
  countUnreadReplies,
  loadReplyInbox,
  loadUnreadReplies,
  type ReplyMessage,
} from "../src/lib/replies";

async function resetDb() {
  await db().execute(
    sql`TRUNCATE marketing_suppressions, communications, webhook_events, leads, customers CASCADE`,
  );
}

afterAll(async () => {
  await getPool().end();
});

beforeEach(async () => {
  await resetDb();
});

let clock = Date.UTC(2026, 8, 18, 12, 0, 0);
function at(): Date {
  clock += 60_000;
  return new Date(clock);
}

function message(overrides: Partial<ReplyMessage> = {}): ReplyMessage {
  return {
    id: newId("com"),
    customerId: null,
    leadId: null,
    direction: "outbound",
    channel: "sms",
    kind: "confirmation",
    status: "sent",
    subject: null,
    body: "Body",
    contactAddress: null,
    contactAddressNormalized: null,
    readAt: null,
    createdAt: at(),
    ...overrides,
  };
}

describe("buildReplyThreads", () => {
  it("puts a reply next to the message it answers", () => {
    const sent = message({
      contactAddress: "(905) 555-1234",
      contactAddressNormalized: "9055551234",
      body: "Your detail is booked for Friday at 9.",
    });
    const reply = message({
      direction: "inbound",
      kind: "reply",
      status: "received",
      contactAddress: "+19055551234",
      contactAddressNormalized: "9055551234",
      body: "Can we make it Saturday?",
    });

    const [thread, ...rest] = buildReplyThreads([reply, sent]);
    expect(rest).toHaveLength(0);
    expect(thread.messages.map((m) => m.id)).toEqual([sent.id, reply.id]);
    expect(thread.unread).toBe(1);
  });

  it("ignores contacts who have never written to us", () => {
    const sent = message({ contactAddress: "9055559999", contactAddressNormalized: "9055559999" });
    expect(buildReplyThreads([sent])).toEqual([]);
  });

  it("threads a reply that matches no record at all, on its number alone", () => {
    const reply = message({
      direction: "inbound",
      kind: "reply",
      contactAddress: "+19055550000",
      contactAddressNormalized: "9055550000",
      body: "How much for a full detail?",
    });
    const [thread] = buildReplyThreads([reply]);
    expect(thread.customerId).toBeNull();
    expect(thread.leadId).toBeNull();
    expect(thread.address).toBe("+19055550000");
    expect(thread.unread).toBe(1);
  });

  it("keeps a customer's two phones as two conversations", () => {
    const home = message({
      direction: "inbound",
      customerId: "cus_1",
      contactAddress: "9055551111",
      contactAddressNormalized: "9055551111",
    });
    const work = message({
      direction: "inbound",
      customerId: "cus_1",
      contactAddress: "9055552222",
      contactAddressNormalized: "9055552222",
    });
    const threads = buildReplyThreads([home, work]);
    expect(threads).toHaveLength(2);
    expect(threads.map((t) => t.addressNormalized).sort()).toEqual(["9055551111", "9055552222"]);
  });

  it("pulls in older messages that predate the stored number, by customer", () => {
    const legacy = message({ customerId: "cus_1", body: "Reminder: tomorrow at 10." });
    const reply = message({
      direction: "inbound",
      customerId: "cus_1",
      contactAddress: "9055553333",
      contactAddressNormalized: "9055553333",
      body: "See you then",
    });
    const [thread] = buildReplyThreads([legacy, reply]);
    expect(thread.messages.map((m) => m.id)).toEqual([legacy.id, reply.id]);
  });

  it("gains the customer id when a lead's number converts, without splitting", () => {
    const asLead = message({
      direction: "inbound",
      leadId: "lea_1",
      contactAddress: "9055554444",
      contactAddressNormalized: "9055554444",
    });
    const asCustomer = message({
      direction: "inbound",
      leadId: "lea_1",
      customerId: "cus_9",
      contactAddress: "9055554444",
      contactAddressNormalized: "9055554444",
    });
    const threads = buildReplyThreads([asLead, asCustomer]);
    expect(threads).toHaveLength(1);
    expect(threads[0].customerId).toBe("cus_9");
    expect(threads[0].leadId).toBe("lea_1");
  });

  it("counts only unread replies, and flags the ones asking to be left alone", () => {
    const seen = message({
      direction: "inbound",
      kind: "reply",
      contactAddress: "9055555555",
      contactAddressNormalized: "9055555555",
      body: "Thanks!",
      readAt: at(),
    });
    const pleading = message({
      direction: "inbound",
      kind: "reply",
      contactAddress: "9055555555",
      contactAddressNormalized: "9055555555",
      body: "please take me off this list",
    });
    const [thread] = buildReplyThreads([seen, pleading]);
    expect(thread.unread).toBe(1);
    expect(thread.needsAttention).toBe(true);
  });

  it("does not flag a read opt-out request as still needing attention", () => {
    const handled = message({
      direction: "inbound",
      kind: "reply",
      contactAddress: "9055556666",
      contactAddressNormalized: "9055556666",
      body: "remove me please",
      readAt: at(),
    });
    expect(buildReplyThreads([handled])[0].needsAttention).toBe(false);
  });

  it("lets a later START undo an earlier STOP", () => {
    const address = { contactAddress: "9055557777", contactAddressNormalized: "9055557777" };
    const stop = message({ direction: "inbound", kind: "opt_stop", body: "STOP", ...address });
    const start = message({ direction: "inbound", kind: "opt_start", body: "START", ...address });
    expect(buildReplyThreads([stop, start])[0].optedOut).toBe(false);
    expect(buildReplyThreads([stop])[0].optedOut).toBe(true);
  });

  it("puts the most recently answered conversation first", () => {
    const older = message({
      direction: "inbound",
      contactAddress: "9055558888",
      contactAddressNormalized: "9055558888",
    });
    const newer = message({
      direction: "inbound",
      contactAddress: "9055559999",
      contactAddressNormalized: "9055559999",
    });
    expect(buildReplyThreads([older, newer]).map((t) => t.addressNormalized)).toEqual([
      "9055559999",
      "9055558888",
    ]);
  });
});

describe("the inbox over real rows", () => {
  it("shows a reply from an unknown number, with its number recorded", async () => {
    await recordInboundSms({
      messageSid: "SM-unknown-1",
      from: "+19055551234",
      to: "+19055559999",
      body: "Do you do ceramic coating?",
      payload: { From: "+19055551234", Body: "Do you do ceramic coating?" },
    });

    const [row] = await db().select().from(schema.communications);
    expect(row.contactAddress).toBe("+19055551234");
    expect(row.contactAddressNormalized).toBe("9055551234");

    const { threads, unread } = await loadReplyInbox();
    expect(unread).toBe(1);
    expect(threads).toHaveLength(1);
    expect(threads[0].contact.name).toBe("(905) 555-1234");
    expect(threads[0].contact.customerId).toBeNull();
  });

  it("names the customer and carries the whole thread", async () => {
    const customerId = newId("cus");
    await db().insert(schema.customers).values({
      id: customerId,
      firstName: "Dana",
      lastName: "Okafor",
      phone: "(905) 555-4321",
      phoneNormalized: "9055554321",
    });

    await sendMessage({
      customerId,
      channel: "sms",
      kind: "confirmation",
      to: "(905) 555-4321",
      body: "You're booked for Friday at 9.",
    });
    await recordInboundSms({
      messageSid: "SM-known-1",
      from: "+19055554321",
      to: "+19055559999",
      body: "Can I move it to Saturday?",
      payload: { From: "+19055554321", Body: "Can I move it to Saturday?" },
    });

    const { threads } = await loadReplyInbox();
    expect(threads).toHaveLength(1);
    expect(threads[0].contact.name).toBe("Dana Okafor");
    expect(threads[0].contact.customerId).toBe(customerId);
    expect(threads[0].messages.map((m) => m.direction)).toEqual(["outbound", "inbound"]);
    expect(threads[0].unread).toBe(1);
  });

  it("marks a STOP thread opted out from the suppression list", async () => {
    await recordInboundSms({
      messageSid: "SM-stop-1",
      from: "+19055557777",
      to: "+19055559999",
      body: "STOP",
      payload: { From: "+19055557777", Body: "STOP" },
    });
    const { threads } = await loadReplyInbox();
    expect(threads[0].optedOut).toBe(true);
    expect(threads[0].needsAttention).toBe(true);
  });

  it("counts and lists what nobody has read", async () => {
    await recordInboundSms({
      messageSid: "SM-count-1",
      from: "+19055551111",
      to: "+19055559999",
      body: "Are you open Sunday?",
      payload: { From: "+19055551111", Body: "Are you open Sunday?" },
    });
    await recordInboundSms({
      messageSid: "SM-count-2",
      from: "+19055552222",
      to: "+19055559999",
      body: "Thanks, see you then",
      payload: { From: "+19055552222", Body: "Thanks, see you then" },
    });
    expect(await countUnreadReplies()).toBe(2);

    const unread = await loadUnreadReplies();
    expect(unread.total).toBe(2);
    expect(unread.items[0].name).toBe("(905) 555-2222");

    // Reading one takes it out of the count, and an outbound message never
    // enters it however many are sent.
    await db()
      .update(schema.communications)
      .set({ readAt: new Date() })
      .where(
        and(eq(schema.communications.direction, "inbound"), isNull(schema.communications.readAt)),
      );
    expect(await countUnreadReplies()).toBe(0);
  });
});
