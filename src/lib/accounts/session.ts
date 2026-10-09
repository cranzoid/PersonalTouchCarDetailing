import "server-only";

import { randomBytes, randomInt, timingSafeEqual } from "crypto";
import { cookies } from "next/headers";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { hashToken } from "@/lib/estimates";
import { newId } from "@/lib/id";
import { sendMessage } from "@/lib/messaging";
import { normalizePhone } from "@/lib/phone";
import { consumeRateLimit } from "@/lib/rate-limit";
import { getSettings } from "@/lib/settings";

/**
 * Customer accounts: sign in with a six-digit code sent to an email address
 * or phone number. No passwords.
 *
 * DECISIONS #14 forbids the public site from looking anyone up by phone
 * number, because a stranger who types a number could then see a stranger's
 * records. This keeps that rule: nothing is looked up — and nothing is shown —
 * until the visitor has PROVED they receive messages at that address. The
 * code is sent whether or not the address is on file, so the form also never
 * reveals who is a customer.
 */

const COOKIE_NAME = "ptcd_account";
const SESSION_DAYS = 30;
const CODE_TTL_MS = 10 * 60_000;
const MAX_ATTEMPTS = 5;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type AccountChannel = "email" | "sms";
export type AccountSession = { id: string; channel: AccountChannel; contact: string };

/** The key a contact is stored and matched under, or null if it is not one. */
export function normalizeContact(channel: AccountChannel, raw: string): string | null {
  if (channel === "email") {
    const email = raw.trim().toLowerCase();
    return EMAIL.test(email) && email.length <= 254 ? email : null;
  }
  const phone = normalizePhone(raw);
  return phone && phone.length === 10 ? phone : null;
}

function hashCode(codeId: string, code: string): string {
  return hashToken(`${codeId}:${code}`);
}

function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Sends a sign-in code. Always reports success to the caller (unless rate
 * limited) so the form cannot be used to test which addresses are on file.
 */
export async function requestSignInCode(input: {
  channel: AccountChannel;
  contact: string;
}): Promise<{ ok: true; contact: string } | { ok: false; error: string }> {
  const contact = normalizeContact(input.channel, input.contact);
  if (!contact) {
    return {
      ok: false,
      error: input.channel === "email" ? "Enter a valid email address." : "Enter a 10-digit phone number.",
    };
  }
  const byIp = await consumeRateLimit("account-code-ip", { limit: 10, windowMs: 60 * 60_000 });
  const byContact = await consumeRateLimit("account-code-contact", {
    limit: 5,
    windowMs: 60 * 60_000,
    identity: `${input.channel}:${contact}`,
  });
  if (!byIp.allowed || !byContact.allowed) {
    return { ok: false, error: "Too many codes requested. Please wait a few minutes and try again." };
  }

  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const id = newId("lgc");
  await db().insert(schema.customerLoginCodes).values({
    id,
    channel: input.channel,
    contact,
    codeHash: hashCode(id, code),
    expiresAt: new Date(Date.now() + CODE_TTL_MS),
  });
  const settings = await getSettings();
  const result = await sendMessage({
    channel: input.channel,
    kind: "sign_in_code",
    to: input.channel === "email" ? contact : input.contact.trim(),
    subject: input.channel === "email" ? `Your ${settings.businessName} sign-in code: ${code}` : undefined,
    body:
      input.channel === "email"
        ? [
            `Your sign-in code is ${code}.`,
            "",
            "It expires in 10 minutes. If you didn't ask for it, you can ignore this email.",
            "",
            `— ${settings.businessName}`,
          ].join("\n")
        : `${settings.businessName}: your sign-in code is ${code}. It expires in 10 minutes.`,
    relatedEntityType: "customer_login_code",
    relatedEntityId: id,
  });
  if (!result.sent && process.env.NODE_ENV === "production") {
    console.error(`[accounts] sign-in code could not be delivered by ${input.channel}`);
  }
  // In development nothing leaves the machine, so print the code to the
  // server log where the developer can read it.
  if (process.env.NODE_ENV !== "production") console.log(`[accounts] sign-in code for ${contact}: ${code}`);
  return { ok: true, contact };
}

/** Checks a code and, if right, signs the visitor in. */
export async function verifySignInCode(input: {
  channel: AccountChannel;
  contact: string;
  code: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const contact = normalizeContact(input.channel, input.contact);
  const code = input.code.replace(/\D/g, "");
  if (!contact || code.length !== 6) return { ok: false, error: "Enter the 6-digit code we sent you." };
  const rate = await consumeRateLimit("account-verify", { limit: 20, windowMs: 15 * 60_000 });
  if (!rate.allowed) return { ok: false, error: "Too many attempts. Please wait a few minutes and try again." };

  const [row] = await db()
    .select()
    .from(schema.customerLoginCodes)
    .where(
      and(
        eq(schema.customerLoginCodes.channel, input.channel),
        eq(schema.customerLoginCodes.contact, contact),
        isNull(schema.customerLoginCodes.consumedAt),
        gt(schema.customerLoginCodes.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(schema.customerLoginCodes.createdAt))
    .limit(1);
  if (!row || row.attempts >= MAX_ATTEMPTS) {
    return { ok: false, error: "That code has expired. Request a new one." };
  }
  // Count the attempt before comparing, atomically, so parallel guesses
  // cannot all slip under the limit.
  const [counted] = await db()
    .update(schema.customerLoginCodes)
    .set({ attempts: sql`${schema.customerLoginCodes.attempts} + 1` })
    .where(and(eq(schema.customerLoginCodes.id, row.id), isNull(schema.customerLoginCodes.consumedAt)))
    .returning({ attempts: schema.customerLoginCodes.attempts });
  if (!counted || counted.attempts > MAX_ATTEMPTS) return { ok: false, error: "That code has expired. Request a new one." };
  if (!sameHash(row.codeHash, hashCode(row.id, code))) return { ok: false, error: "That code isn't right. Check it and try again." };

  const consumed = await db()
    .update(schema.customerLoginCodes)
    .set({ consumedAt: new Date() })
    .where(and(eq(schema.customerLoginCodes.id, row.id), isNull(schema.customerLoginCodes.consumedAt)))
    .returning({ id: schema.customerLoginCodes.id });
  if (consumed.length === 0) return { ok: false, error: "That code was already used. Request a new one." };

  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  await db().insert(schema.customerSessions).values({
    id: newId("cse"),
    tokenHash: hashToken(token),
    channel: input.channel,
    contact,
    expiresAt,
  });
  const store = await cookies();
  store.set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
  return { ok: true };
}

export async function getAccountSession(): Promise<AccountSession | null> {
  const store = await cookies();
  const token = store.get(COOKIE_NAME)?.value;
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const [row] = await db()
    .select()
    .from(schema.customerSessions)
    .where(and(eq(schema.customerSessions.tokenHash, hashToken(token)), gt(schema.customerSessions.expiresAt, new Date())))
    .limit(1);
  if (!row) return null;
  return { id: row.id, channel: row.channel as AccountChannel, contact: row.contact };
}

export async function signOutAccount(): Promise<void> {
  const store = await cookies();
  const token = store.get(COOKIE_NAME)?.value;
  if (token) {
    await db()
      .update(schema.customerSessions)
      .set({ expiresAt: new Date() })
      .where(eq(schema.customerSessions.tokenHash, hashToken(token)));
  }
  store.delete(COOKIE_NAME);
}

/**
 * Every customer record carrying the proved contact. The CRM holds duplicates
 * (one person booked twice, staff added them again), and a person's history is
 * theirs wherever it landed — but only records with THIS exact contact.
 */
export async function accountCustomers(session: AccountSession) {
  const match =
    session.channel === "email"
      ? sql`lower(trim(${schema.customers.email})) = ${session.contact}`
      : eq(schema.customers.phoneNormalized, session.contact);
  return db()
    .select()
    .from(schema.customers)
    .where(and(match, isNull(schema.customers.anonymizedAt)))
    .orderBy(desc(schema.customers.createdAt));
}
