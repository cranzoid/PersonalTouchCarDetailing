import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, desc, eq, isNull, sql } from "drizzle-orm";

const staff = vi.hoisted(() => ({
  id: "usr_reply_test_actor",
  name: "Test Owner",
  email: "replies@example.com",
  role: "owner" as const,
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({
  requireStaff: vi.fn(async () => staff),
  AuthError: class AuthError extends Error {},
}));

import { db, getPool, schema } from "../src/db";
import { recordInboundSms } from "../src/lib/marketing/inbound";
import {
  markThreadReadAction,
  markThreadUnreadAction,
  sendReplyAction,
} from "../src/app/admin/(app)/messages/actions";

const THEIR_NUMBER = "+19055554321";

beforeEach(async () => {
  await db().execute(
    sql`TRUNCATE marketing_suppressions, communications, webhook_events, leads, customers,
        audit_log, staff_sessions, staff_users CASCADE`,
  );
  await db()
    .insert(schema.staffUsers)
    .values({ id: staff.id, name: staff.name, email: staff.email, passwordHash: "x", role: "owner" });
});

afterAll(async () => {
  await getPool().end();
});

async function theyText(body: string, from = THEIR_NUMBER, sid = `SM-${Math.random()}`) {
  await recordInboundSms({
    messageSid: sid,
    from,
    to: "+19055559999",
    body,
    payload: { From: from, Body: body },
  });
}

describe("sendReplyAction", () => {
  it("answers a conversation and files the reply on the customer", async () => {
    const customerId = "cus_reply_target";
    await db().insert(schema.customers).values({
      id: customerId,
      firstName: "Dana",
      lastName: "Okafor",
      phone: "(905) 555-4321",
      phoneNormalized: "9055554321",
    });
    await theyText("Can I move it to Saturday?");

    const result = await sendReplyAction({
      address: THEIR_NUMBER,
      body: "Saturday at 10 works — booked you in.",
    });
    expect(result).toEqual({ ok: true });

    const [sent] = await db()
      .select()
      .from(schema.communications)
      .where(eq(schema.communications.direction, "outbound"));
    expect(sent.customerId).toBe(customerId);
    expect(sent.kind).toBe("manual");
    expect(sent.contactAddressNormalized).toBe("9055554321");
    expect(sent.createdByStaffId).toBe(staff.id);

    // Answering it is reading it.
    const unread = await db()
      .select()
      .from(schema.communications)
      .where(and(eq(schema.communications.direction, "inbound"), isNull(schema.communications.readAt)));
    expect(unread).toHaveLength(0);
  });

  it("refuses a number that has never texted the shop", async () => {
    const result = await sendReplyAction({ address: "+14165550000", body: "Hello there" });
    expect(result).toEqual({
      ok: false,
      error: "This number has not texted the shop, so there is nothing to reply to.",
    });
    const rows = await db().select().from(schema.communications);
    expect(rows).toHaveLength(0);
  });

  it("refuses a number that replied STOP", async () => {
    await theyText("STOP");
    const result = await sendReplyAction({ address: THEIR_NUMBER, body: "Just one more thing" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toContain("replied STOP");

    const outbound = await db()
      .select()
      .from(schema.communications)
      .where(eq(schema.communications.direction, "outbound"));
    expect(outbound).toHaveLength(0);
  });

  it("refuses an empty reply", async () => {
    await theyText("Hi");
    const result = await sendReplyAction({ address: THEIR_NUMBER, body: "   " });
    expect(result.ok).toBe(false);
  });

  it("finds the conversation however the number is spelled", async () => {
    await theyText("Are you open Sunday?");
    const result = await sendReplyAction({ address: "(905) 555-4321", body: "We are, 10 to 4." });
    expect(result).toEqual({ ok: true });

    const [sent] = await db()
      .select()
      .from(schema.communications)
      .where(eq(schema.communications.direction, "outbound"));
    // Sent to the number as it reached us, not as the browser spelled it.
    expect(sent.contactAddress).toBe(THEIR_NUMBER);
  });
});

describe("read state", () => {
  it("marks a conversation read and back to unread", async () => {
    await theyText("First question");
    await theyText("Second question");

    expect(await markThreadReadAction({ address: THEIR_NUMBER })).toEqual({ ok: true });
    const read = await db()
      .select()
      .from(schema.communications)
      .orderBy(desc(schema.communications.createdAt));
    expect(read.every((row) => row.readAt !== null)).toBe(true);
    expect(read.every((row) => row.readByStaffId === staff.id)).toBe(true);

    expect(await markThreadUnreadAction({ address: THEIR_NUMBER })).toEqual({ ok: true });
    const unread = await db().select().from(schema.communications);
    expect(unread.every((row) => row.readAt === null)).toBe(true);
  });

  it("leaves other conversations alone", async () => {
    await theyText("Mine", THEIR_NUMBER, "SM-a");
    await theyText("Theirs", "+14165550199", "SM-b");

    await markThreadReadAction({ address: THEIR_NUMBER });
    const [other] = await db()
      .select()
      .from(schema.communications)
      .where(eq(schema.communications.contactAddressNormalized, "4165550199"));
    expect(other.readAt).toBeNull();
  });
});
