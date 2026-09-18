import "server-only";

import { randomBytes } from "crypto";
import { and, asc, eq, isNull, lte, ne, or, sql } from "drizzle-orm";
import { db, schema, type Db } from "@/db";
import { audit } from "@/lib/audit";
import { newId } from "@/lib/id";
import { normalizePhone } from "@/lib/phone";
import { formatCents } from "@/lib/money";
import { formatInZone } from "@/lib/tz";
import { sendMessageTemplate } from "@/lib/messaging";
import { unsubscribeToken } from "@/lib/marketing/unsubscribe";
import {
  claimCodeFromBytes,
  claimExpiresAt,
  formatClaimCode,
  normalizeClaimCode,
  normalizePlate,
  washOfferPriceCents,
  type ResolvedWashOffer,
} from "@/lib/wash-offer";
import type { BusinessSettings } from "@/lib/settings";
import type { Attribution } from "@/db/schema";

/**
 * Claim records for the new-customer wash offer: issuing a code, spending it on
 * a booking, and redeeming it against a licence plate at the counter.
 *
 * The money rules are next door in wash-offer.ts and are pure. This module is
 * the part that touches the database, and everything in it is written so the
 * two caps ("one per person", "one per plate") are kept by unique indexes
 * rather than by a check that can lose a race.
 */

export type OfferClaim = typeof schema.offerClaims.$inferSelect;

export type ClaimIssueInput = {
  offer: ResolvedWashOffer;
  firstName: string;
  lastName?: string;
  phone?: string;
  email?: string;
  vehicleSize: "car" | "suv";
  marketingConsent: boolean;
  termsVersion: string;
  attribution?: Attribution;
  nowMs?: number;
};

export type ClaimIssueResult = {
  claim: OfferClaim;
  /** False when this contact already held a code and we handed back the same one. */
  created: boolean;
};

/**
 * Issues a code, or returns the one this contact already holds.
 *
 * RE-CLAIMING IS DELIBERATELY NOT AN ERROR. Two reasons, and the second is the
 * important one:
 *
 *  1. People lose the text. "Here is your code again" is the answer they want.
 *  2. The response is then IDENTICAL whether or not the contact is already on
 *     file, so the form cannot be used to ask "is this number one of your
 *     customers?". DECISIONS.md #14 refused to build that oracle for the first
 *     ad promotion and this must not quietly reintroduce it.
 *
 * Note what is NOT checked here: whether they are an existing customer. That
 * belongs at booking, where `isFirstTimeDetailCustomer` already answers it
 * server-side without telling the browser anything, and at the counter.
 */
export async function issueClaim(input: ClaimIssueInput): Promise<ClaimIssueResult> {
  const nowMs = input.nowMs ?? Date.now();
  const phoneNormalized = normalizePhone(input.phone);
  const emailNormalized = input.email?.trim().toLowerCase() || null;
  if (!phoneNormalized && !emailNormalized) {
    throw new Error("A claim needs a phone number or an email address");
  }

  const existing = await findClaimForContact(input.offer.code, phoneNormalized, emailNormalized);
  if (existing) {
    // A returning claimant may be supplying an email that the earlier version
    // of the form did not require. Keep the same code, but complete its contact
    // record and stamp the newly accepted terms so re-sending reaches both
    // channels and the consent evidence reflects what was actually accepted.
    const consentAt = input.marketingConsent
      ? (existing.marketingConsentAt ?? new Date(nowMs))
      : existing.marketingConsentAt;
    const updates = {
      email: existing.email ?? input.email ?? null,
      emailNormalized: existing.emailNormalized ?? emailNormalized,
      phone: existing.phone ?? input.phone ?? null,
      phoneNormalized: existing.phoneNormalized ?? phoneNormalized,
      marketingConsent: existing.marketingConsent || input.marketingConsent,
      marketingConsentAt: consentAt,
      termsVersion: input.termsVersion,
      updatedAt: new Date(nowMs),
    };

    let refreshed = existing;
    try {
      const [updated] = await db()
        .update(schema.offerClaims)
        .set(updates)
        .where(eq(schema.offerClaims.id, existing.id))
        .returning();
      if (updated) refreshed = updated;
    } catch (error) {
      // If a newly supplied address is already bound to another live claim,
      // do not merge identities. We can still record acceptance against the
      // claim found by the other address without disclosing the collision.
      if (!isUniqueViolation(error)) throw error;
      const [updated] = await db()
        .update(schema.offerClaims)
        .set({
          marketingConsent: existing.marketingConsent || input.marketingConsent,
          marketingConsentAt: consentAt,
          termsVersion: input.termsVersion,
          updatedAt: new Date(nowMs),
        })
        .where(eq(schema.offerClaims.id, existing.id))
        .returning();
      if (updated) refreshed = updated;
    }

    if (existing.leadId) {
      await db()
        .update(schema.leads)
        .set({
          email: refreshed.email,
          phone: refreshed.phone,
          phoneNormalized: refreshed.phoneNormalized,
          marketingConsent: refreshed.marketingConsent,
          marketingConsentAt: refreshed.marketingConsentAt,
          marketingConsentSource: refreshed.marketingConsent ? "public_offer_terms" : null,
          updatedAt: new Date(nowMs),
        })
        .where(eq(schema.leads.id, existing.leadId));
    }
    return { claim: refreshed, created: false };
  }

  // A lead so the claimant lands in the CRM the owners already work from, and
  // so the marketing-consent flag has the home `sendMessage` looks for. Same
  // shape the public quote form writes.
  const leadId = newId("lead");
  const consentAt = input.marketingConsent ? new Date(nowMs) : null;
  await db().insert(schema.leads).values({
    id: leadId,
    name: [input.firstName, input.lastName].filter(Boolean).join(" ").trim(),
    email: input.email ?? null,
    phone: input.phone ?? null,
    phoneNormalized,
    kind: "offer",
    status: "new",
    message: `Claimed the ${input.offer.label} (${input.offer.code}).`,
    attribution: (input.attribution ?? null) as never,
    marketingConsent: input.marketingConsent,
    marketingConsentAt: consentAt,
    marketingConsentSource: input.marketingConsent ? "public_offer_terms" : null,
  });

  // Up to a handful of attempts: a code collision is astronomically unlikely,
  // but a caller must never receive somebody else's claim because of one.
  for (let attempt = 0; attempt < 6; attempt++) {
    const inserted = await db()
      .insert(schema.offerClaims)
      .values({
        id: newId("ofc"),
        offerCode: input.offer.code,
        code: claimCodeFromBytes(randomBytes(8)),
        firstName: input.firstName,
        lastName: input.lastName ?? "",
        email: input.email ?? null,
        phone: input.phone ?? null,
        phoneNormalized,
        emailNormalized,
        vehicleSize: input.vehicleSize,
        marketingConsent: input.marketingConsent,
        marketingConsentAt: consentAt,
        termsVersion: input.termsVersion,
        attribution: (input.attribution ?? null) as never,
        status: "issued",
        expiresAt: claimExpiresAt(input.offer, nowMs),
        leadId,
      })
      // Covers all three unique indexes at once: a duplicate code (retry) and
      // a contact that claimed in the moment between our check and this insert
      // (return theirs).
      .onConflictDoNothing()
      .returning();
    if (inserted[0]) return { claim: inserted[0], created: true };

    const raced = await findClaimForContact(input.offer.code, phoneNormalized, emailNormalized);
    if (raced) return { claim: raced, created: false };
  }
  throw new Error("Could not allocate an offer claim code");
}

/** The live (non-void) claim this contact holds for the campaign, if any. */
async function findClaimForContact(
  offerCode: string,
  phoneNormalized: string | null,
  emailNormalized: string | null,
): Promise<OfferClaim | undefined> {
  const match = or(
    phoneNormalized ? eq(schema.offerClaims.phoneNormalized, phoneNormalized) : undefined,
    emailNormalized ? eq(schema.offerClaims.emailNormalized, emailNormalized) : undefined,
  );
  if (!match) return undefined;
  const [row] = await db()
    .select()
    .from(schema.offerClaims)
    .where(and(eq(schema.offerClaims.offerCode, offerCode), ne(schema.offerClaims.status, "void"), match))
    .orderBy(asc(schema.offerClaims.createdAt))
    .limit(1);
  return row;
}

export type ClaimLookup =
  | { ok: true; claim: OfferClaim }
  | { ok: false; reason: "unknown" | "expired" | "spent" | "void"; claim?: OfferClaim };

/**
 * Resolves a code the browser is carrying.
 *
 * Reads through `runner` so the booking transaction can re-check the claim
 * under the locks it already holds, exactly as the first-time-customer rule is
 * re-checked there.
 */
export async function lookupClaim(
  runner: Pick<Db, "select">,
  offerCode: string,
  rawCode: string | null | undefined,
  nowMs: number = Date.now(),
): Promise<ClaimLookup> {
  const code = normalizeClaimCode(rawCode);
  if (!code) return { ok: false, reason: "unknown" };
  const [claim] = await runner
    .select()
    .from(schema.offerClaims)
    .where(and(eq(schema.offerClaims.code, code), eq(schema.offerClaims.offerCode, offerCode)))
    .limit(1);
  if (!claim) return { ok: false, reason: "unknown" };
  if (claim.status === "void") return { ok: false, reason: "void", claim };
  // A claim already spent on a booking or a wash cannot buy a second one. The
  // booking it was spent on may since have been cancelled — staff release the
  // claim from the admin screen in that case, rather than it silently freeing
  // itself and handing out a second discounted wash.
  if (claim.status === "booked" || claim.status === "redeemed") {
    return { ok: false, reason: "spent", claim };
  }
  if (claim.expiresAt.getTime() <= nowMs) return { ok: false, reason: "expired", claim };
  return { ok: true, claim };
}

/**
 * True when this claim belongs to the person filling in the booking form.
 *
 * The code is not a bearer token: it is worth nothing without the phone number
 * it was issued to. That is what stops one code posted in a Facebook group
 * from buying fifty discounted washes — and it costs the real claimant nothing,
 * because the booking form arrives pre-filled from their own claim.
 *
 * Email is accepted as the match only when the claim carries no phone number,
 * so a claim made by phone cannot be redirected with a guessed address.
 */
export function claimBelongsTo(
  claim: OfferClaim,
  contact: { phone?: string | null; email?: string | null },
): boolean {
  if (claim.phoneNormalized) return normalizePhone(contact.phone) === claim.phoneNormalized;
  if (claim.emailNormalized) {
    return (contact.email?.trim().toLowerCase() || null) === claim.emailNormalized;
  }
  return false;
}

/**
 * Spends the claim on an appointment, inside the booking transaction.
 *
 * Conditional on the row still being `issued`, so two bookings racing on one
 * code cannot both win: the loser updates nothing, and the caller treats that
 * exactly as it treats losing the first-time re-check — roll back, re-price,
 * let the customer confirm the real total.
 */
export async function markClaimBooked(
  tx: Pick<Db, "update">,
  claimId: string,
  input: { appointmentId: string; customerId: string; nowMs?: number },
): Promise<boolean> {
  const now = new Date(input.nowMs ?? Date.now());
  const updated = await tx
    .update(schema.offerClaims)
    .set({
      status: "booked",
      appointmentId: input.appointmentId,
      customerId: input.customerId,
      bookedAt: now,
      updatedAt: now,
    })
    .where(and(eq(schema.offerClaims.id, claimId), eq(schema.offerClaims.status, "issued")))
    .returning({ id: schema.offerClaims.id });
  return updated.length > 0;
}

export type PlateRedemptionResult =
  | { ok: true; claim: OfferClaim }
  | { ok: false; reason: "not_found" | "already_redeemed" | "void" }
  | {
      /** Another claim already spent this offer on this plate. */
      ok: false;
      reason: "plate_used";
      plate: string;
      by: { code: string; name: string; redeemedAt: Date | null };
    };

/**
 * Records the licence plate this offer was spent on — the counter check.
 *
 * The plate is never asked for online. A plate typed by a stranger proves
 * nothing, and asking for one costs claims. It is entered here, with the car in
 * front of the person typing, which is the first moment it is a fact.
 *
 * "One promotional wash per plate" is then kept by the partial unique index,
 * not by the SELECT above it: two staff checking in two cars at once would both
 * pass a query-based check and both be wrong.
 */
export async function redeemClaimAgainstPlate(input: {
  claimId: string;
  rawPlate: string;
  staffId: string;
  /**
   * The customer this wash was for, when staff linked one at the counter. Only
   * fills a gap: a claim spent on a booking already names its customer, and
   * that link is never overwritten.
   */
  customerId?: string;
  nowMs?: number;
}): Promise<PlateRedemptionResult> {
  const plate = normalizePlate(input.rawPlate);
  if (!plate) return { ok: false, reason: "not_found" };
  const now = new Date(input.nowMs ?? Date.now());

  const [claim] = await db()
    .select()
    .from(schema.offerClaims)
    .where(eq(schema.offerClaims.id, input.claimId))
    .limit(1);
  if (!claim) return { ok: false, reason: "not_found" };
  if (claim.status === "void") return { ok: false, reason: "void" };
  if (claim.redeemedPlateNormalized) return { ok: false, reason: "already_redeemed" };

  try {
    const [updated] = await db()
      .update(schema.offerClaims)
      .set({
        status: "redeemed",
        redeemedPlateNormalized: plate,
        redeemedAt: now,
        redeemedByStaffId: input.staffId,
        customerId: claim.customerId ?? input.customerId ?? null,
        updatedAt: now,
      })
      .where(and(eq(schema.offerClaims.id, input.claimId), isNull(schema.offerClaims.redeemedPlateNormalized)))
      .returning();
    if (!updated) return { ok: false, reason: "already_redeemed" };
    return { ok: true, claim: updated };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const [owner] = await db()
      .select()
      .from(schema.offerClaims)
      .where(
        and(
          eq(schema.offerClaims.offerCode, claim.offerCode),
          eq(schema.offerClaims.redeemedPlateNormalized, plate),
        ),
      )
      .limit(1);
    return {
      ok: false,
      reason: "plate_used",
      plate,
      by: {
        code: owner?.code ?? "",
        name: [owner?.firstName, owner?.lastName].filter(Boolean).join(" ").trim(),
        redeemedAt: owner?.redeemedAt ?? null,
      },
    };
  }
}

/**
 * Marks the claimant's lead Completed once the wash has actually happened.
 *
 * The claim form puts everyone into Leads as "new", and until now nothing
 * moved them on — so a lead list full of people who had already been washed
 * read exactly like one full of people nobody had called. Called after a
 * successful plate redemption, by the booking path and the walk-in path alike.
 *
 * Links the customer too when the lead has none yet, which is what lets the
 * lead funnel in Reports follow the lead to its invoice. An existing link is
 * left alone: it was made on purpose, by a conversion or a booking.
 */
export async function markClaimLeadCompleted(
  runner: Pick<Db, "select" | "update" | "insert">,
  input: { claim: OfferClaim; customerId?: string | null; staffId: string; nowMs?: number },
): Promise<boolean> {
  const leadId = input.claim.leadId;
  if (!leadId) return false;
  const [lead] = await runner
    .select({
      id: schema.leads.id,
      status: schema.leads.status,
      convertedCustomerId: schema.leads.convertedCustomerId,
      anonymizedAt: schema.leads.anonymizedAt,
    })
    .from(schema.leads)
    .where(eq(schema.leads.id, leadId))
    .limit(1);
  if (!lead || lead.anonymizedAt) return false;

  const customerId = lead.convertedCustomerId ?? input.customerId ?? input.claim.customerId ?? null;
  if (lead.status === "completed" && lead.convertedCustomerId === customerId) return false;

  const now = new Date(input.nowMs ?? Date.now());
  await runner
    .update(schema.leads)
    .set({ status: "completed", convertedCustomerId: customerId, updatedAt: now })
    .where(eq(schema.leads.id, lead.id));
  await audit(runner, {
    actorType: "staff",
    actorId: input.staffId,
    action: "lead.status_changed",
    entityType: "lead",
    entityId: lead.id,
    before: { status: lead.status, convertedCustomerId: lead.convertedCustomerId },
    after: { status: "completed", convertedCustomerId: customerId },
    reason: `First-wash code ${formatClaimCode(input.claim.code)} redeemed`,
  });
  return true;
}

/**
 * Postgres unique violation, found anywhere in the cause chain.
 *
 * Drizzle wraps the driver error in its own, so the SQLSTATE that matters
 * ("23505") sits on `error.cause` rather than on the error itself. Checking
 * only the outer object silently turns a caught, explainable conflict back into
 * a 500 — which is exactly the plate collision this whole path exists to
 * report politely.
 */
function isUniqueViolation(error: unknown): boolean {
  for (let current = error, depth = 0; current && depth < 5; depth++) {
    if (typeof current === "object" && (current as { code?: string }).code === "23505") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Marks codes nobody used as expired. Cosmetic — `lookupClaim` already refuses
 * an out-of-date claim by its timestamp — but it is what makes the admin list
 * and the reminder query tell the truth without every reader repeating the
 * comparison.
 */
export async function expireStaleClaims(now: Date = new Date()): Promise<number> {
  const expired = await db()
    .update(schema.offerClaims)
    .set({ status: "expired", updatedAt: now })
    .where(and(eq(schema.offerClaims.status, "issued"), lte(schema.offerClaims.expiresAt, now)))
    .returning({ id: schema.offerClaims.id });
  return expired.length;
}

/**
 * Claims still holding an unbooked code that are due their next nudge.
 *
 * The schedule is expressed as "days since the claim", and a claim is only ever
 * one reminder further along, so a cron outage cannot fire three at once: the
 * `remindersSent` counter decides which message is next, and only one is sent
 * per tick per claim.
 */
export async function claimsDueReminder(
  schedule: readonly number[],
  now: Date = new Date(),
): Promise<OfferClaim[]> {
  if (schedule.length === 0) return [];
  const rows = await db()
    .select()
    .from(schema.offerClaims)
    .where(and(eq(schema.offerClaims.status, "issued"), sql`${schema.offerClaims.expiresAt} > ${now}`))
    .orderBy(asc(schema.offerClaims.createdAt));
  return rows.filter((claim) => {
    const next = schedule[claim.remindersSent];
    if (next === undefined) return false;
    const dueAt = claim.createdAt.getTime() + next * 86_400_000;
    return dueAt <= now.getTime() && claim.expiresAt.getTime() > now.getTime();
  });
}

/** Stamps a nudge as sent, so the next tick moves to the following one. */
export async function recordClaimReminder(claimId: string, now: Date = new Date()): Promise<void> {
  await db()
    .update(schema.offerClaims)
    .set({
      remindersSent: sql`${schema.offerClaims.remindersSent} + 1`,
      lastReminderAt: now,
      updatedAt: now,
    })
    .where(eq(schema.offerClaims.id, claimId));
}

/* ------------------------------------------------------------------ */
/* Delivering a code                                                   */
/* ------------------------------------------------------------------ */

/**
 * Sends a claim's code, by text and by email, in whichever of the two we have
 * an address for.
 *
 * Classified as a `confirmation`, not marketing: this is the thing the customer
 * just asked for, and the reminder is about that same outstanding request. It
 * therefore passes the consent gate in sendMessage — but every body still names
 * the sender, gives a phone number and offers a way out, because CASL requires
 * all three of a commercial message however it was prompted.
 *
 * Delivery is best effort by design. The code is already on the screen in front
 * of the customer, so a provider outage costs a convenience rather than the
 * claim.
 */
export async function sendClaimMessages(input: {
  claim: OfferClaim;
  offer: ResolvedWashOffer;
  settings: BusinessSettings;
  /**
   * `booked` is the book-first arm's single message: it confirms the
   * appointment AND carries the code, because in that flow the two facts
   * arrive together and two texts saying half of it each would be worse than
   * one saying all of it.
   */
  variant: "code" | "reminder" | "booked";
  baseUrl: string;
  /**
   * Extra placeholders for this variant — the appointment's date and time for
   * `booked`. Merged over nothing: it cannot overwrite the code, price or
   * expiry every message is written from.
   */
  extraVariables?: Record<string, string>;
}): Promise<("sms" | "email")[]> {
  const { claim, offer, settings, baseUrl } = input;
  const variables = {
    ...input.extraVariables,
    ...claimMessageVariables({ claim, offer, settings, baseUrl }),
  };

  const sent: ("sms" | "email")[] = [];
  for (const channel of ["sms", "email"] as const) {
    try {
      const delivery = await sendMessageTemplate({
        templateKey: `offer_claim_${input.variant}_${channel}`,
        recipient: { phone: claim.phone, email: claim.email },
        leadId: claim.leadId ?? undefined,
        kind: "confirmation",
        variables,
        relatedEntityType: "offer_claim",
        relatedEntityId: claim.id,
      });
      if (delivery.sent) sent.push(channel);
    } catch {
      console.error(`Offer claim ${input.variant} could not be queued on ${channel}`);
    }
  }
  return sent;
}

/**
 * The values every message about a claim is written from — the code texts, the
 * automatic reminders and the nudges staff send by hand — so all three always
 * quote the same code, price, expiry and link.
 */
export function claimMessageVariables(input: {
  claim: OfferClaim;
  offer: ResolvedWashOffer;
  settings: BusinessSettings;
  baseUrl: string;
}): Record<string, string> {
  const { claim, offer, settings, baseUrl } = input;
  const priceCents = washOfferPriceCents(offer, claim.vehicleSize === "suv" ? "suv_small" : "sedan");
  return {
    businessName: settings.businessName,
    firstName: claim.firstName,
    code: formatClaimCode(claim.code),
    price: priceCents === null ? "" : formatCents(priceCents, settings.currency),
    expires: formatInZone(claim.expiresAt, settings.timezone, {
      weekday: "long",
      month: "long",
      day: "numeric",
    }),
    // The short form. A full booking deep link is about 110 characters, which
    // pushes every code text into a second segment and buries the code itself.
    link: `${baseUrl}/w/${claim.code}`,
    phone: settings.phone,
    email: settings.email,
    address: [settings.addressLine1, `${settings.city}, ${settings.province} ${settings.postalCode}`]
      .filter((part) => part.trim().length > 0)
      .join(", "),
    offerLabel: offer.label,
    // CASL's unsubscribe, valid for at least 60 days because it is a signature
    // over the lead id rather than a stored row (see marketing/unsubscribe.ts).
    unsubscribe: claim.leadId ? `${baseUrl}/unsubscribe/${unsubscribeToken(claim.leadId)}` : baseUrl,
  };
}
