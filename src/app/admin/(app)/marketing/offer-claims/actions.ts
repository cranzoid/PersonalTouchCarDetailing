"use server";

import { revalidatePath } from "next/cache";
import { and, asc, count, eq, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { audit } from "@/lib/audit";
import { AuthError, requireStaff } from "@/lib/auth/session";
import { newId } from "@/lib/id";
import { formatCents } from "@/lib/money";
import { formatPhone, normalizePhone } from "@/lib/phone";
import { getSettings } from "@/lib/settings";
import { formatInZone } from "@/lib/tz";
import {
  activeWashOffer,
  formatClaimCode,
  normalizeClaimCode,
  normalizePlate,
  washOfferPriceCents,
} from "@/lib/wash-offer";
import {
  markClaimLeadCompleted,
  redeemClaimAgainstPlate,
  sendClaimMessages,
  type OfferClaim,
  type PlateRedemptionResult,
} from "@/lib/wash-offer-claims";
import { getAppBaseUrl } from "@/lib/urls";

export type OfferClaimActionResult = { ok: true; message: string } | { ok: false; error: string };

const voidInput = z.object({
  claimId: z.string().trim().min(1).max(64),
  reason: z.string().trim().max(200).optional(),
});

/**
 * Releases a claim.
 *
 * The only way back for somebody who was stopped by the one-per-person cap for
 * a reason that was not their fault — a mistyped number, a duplicate taken at
 * the counter, a booking that was cancelled. Voiding drops the row out of the
 * phone and email unique indexes, so that person can claim again.
 *
 * It deliberately does NOT release a spent plate: `offer_claims_offer_plate_uq`
 * has no status condition, so a vehicle that has had its promotional wash stays
 * spent whatever happens to the claim afterwards.
 */
export async function voidOfferClaimAction(raw: unknown): Promise<OfferClaimActionResult> {
  try {
    const staff = await requireStaff("manage_marketing");
    const parsed = voidInput.safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Invalid request" };

    const [claim] = await db()
      .select()
      .from(schema.offerClaims)
      .where(eq(schema.offerClaims.id, parsed.data.claimId))
      .limit(1);
    if (!claim) return { ok: false, error: "That claim no longer exists." };
    if (claim.status === "void") return { ok: false, error: "That claim is already released." };

    await db().transaction(async (tx) => {
      await tx
        .update(schema.offerClaims)
        .set({
          status: "void",
          voidReason: parsed.data.reason || "Released by staff",
          updatedAt: new Date(),
        })
        .where(eq(schema.offerClaims.id, claim.id));
      await audit(tx, {
        actorType: "staff",
        actorId: staff.id,
        action: "offer_claim.voided",
        entityType: "offer_claim",
        entityId: claim.id,
        before: { status: claim.status },
        after: { status: "void", reason: parsed.data.reason ?? null },
      });
    });

    revalidatePath("/admin/marketing/offer-claims");
    return { ok: true, message: `${claim.code} released. That customer can claim again.` };
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, error: err.message };
    console.error("voidOfferClaimAction failed", err);
    return { ok: false, error: "Something went wrong" };
  }
}

const resendInput = z.object({ claimId: z.string().trim().min(1).max(64) });

/** Sends the code again — the counter answer to "I never got the text". */
export async function resendOfferClaimAction(raw: unknown): Promise<OfferClaimActionResult> {
  try {
    await requireStaff("manage_marketing");
    const parsed = resendInput.safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Invalid request" };

    const settings = await getSettings();
    const offer = activeWashOffer(settings);
    if (!offer) return { ok: false, error: "The wash offer is switched off, so there is nothing to send." };

    const [claim] = await db()
      .select()
      .from(schema.offerClaims)
      .where(eq(schema.offerClaims.id, parsed.data.claimId))
      .limit(1);
    if (!claim) return { ok: false, error: "That claim no longer exists." };
    if (claim.status !== "issued") {
      return { ok: false, error: "That code is no longer live, so it has not been sent again." };
    }

    const sent = await sendClaimMessages({
      claim,
      offer,
      settings,
      variant: "code",
      baseUrl: getAppBaseUrl(),
    });
    return sent.length > 0
      ? { ok: true, message: `Sent again by ${sent.join(" and ")}.` }
      : { ok: false, error: "Nothing could be sent — check the messaging settings in Integrations." };
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, error: err.message };
    console.error("resendOfferClaimAction failed", err);
    return { ok: false, error: "Something went wrong" };
  }
}

const redeemInput = z.object({
  claimId: z.string().trim().min(1).max(64),
  plate: z.string().trim().min(2).max(20),
});

/**
 * Records the licence plate a claim was spent on, and writes it onto the
 * vehicle so the plate lives where the rest of the shop already looks for it.
 *
 * This is the counter check the whole offer rests on: it is the first moment
 * anybody has seen the car, and the unique index behind it is what makes "one
 * promotional wash per plate" a fact rather than a hope.
 */
export async function redeemOfferClaimAction(raw: unknown): Promise<OfferClaimActionResult> {
  try {
    const staff = await requireStaff("manage_bookings");
    const parsed = redeemInput.safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Enter the licence plate." };

    const result = await redeemClaimAgainstPlate({
      claimId: parsed.data.claimId,
      rawPlate: parsed.data.plate,
      staffId: staff.id,
    });

    if (!result.ok) {
      return {
        ok: false,
        error: redemptionError(result, 'use "Change packages" to reprice this booking.'),
      };
    }

    // Write the plate onto the vehicle too. Staff are looking at the car, so
    // this is the most reliable moment the record will ever get — but never
    // over the top of a plate somebody already recorded by hand.
    if (result.claim.appointmentId) {
      await recordPlateOnVehicle({
        appointmentId: result.claim.appointmentId,
        customerId: null,
        rawPlate: parsed.data.plate,
        plate: result.claim.redeemedPlateNormalized!,
      });
    }

    await audit(db(), {
      actorType: "staff",
      actorId: staff.id,
      action: "offer_claim.redeemed",
      entityType: "offer_claim",
      entityId: result.claim.id,
      after: {
        plate: result.claim.redeemedPlateNormalized,
        appointmentId: result.claim.appointmentId,
        code: result.claim.code,
      },
    });
    await markClaimLeadCompleted(db(), { claim: result.claim, staffId: staff.id });

    revalidatePath("/admin/marketing/offer-claims");
    revalidatePath("/admin/leads");
    if (result.claim.appointmentId) revalidatePath(`/admin/appointments/${result.claim.appointmentId}`);
    return { ok: true, message: `Offer redeemed against plate ${result.claim.redeemedPlateNormalized}.` };
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, error: err.message };
    console.error("redeemOfferClaimAction failed", err);
    return { ok: false, error: "Something went wrong" };
  }
}

/** Why a plate redemption was refused, in the words staff act on. */
function redemptionError(
  result: Exclude<PlateRedemptionResult, { ok: true }>,
  repriceHint: string,
): string {
  if (result.reason === "plate_used") {
    const when = result.by.redeemedAt ? result.by.redeemedAt.toISOString().slice(0, 10) : "an earlier visit";
    return `Plate ${result.plate} already had the offer on ${when}${result.by.name ? ` (${result.by.name})` : ""}. Charge the regular price — ${repriceHint}`;
  }
  if (result.reason === "already_redeemed") return "This claim has already been redeemed against a plate.";
  if (result.reason === "void") return "This claim has been released and cannot be redeemed.";
  return "That claim no longer exists.";
}

const lookupInput = z.object({ code: z.string().trim().min(3).max(40) });

export type ClaimCustomerMatch = {
  id: string;
  label: string;
  detail: string;
};

export type ClaimLookupResult =
  | {
      ok: true;
      claim: {
        id: string;
        code: string;
        name: string;
        phone: string | null;
        email: string | null;
        /** issued | booked | redeemed | expired | void, with an out-of-date issued code reported as expired. */
        status: string;
        claimedLabel: string;
        expiresLabel: string;
        appointmentId: string | null;
        appointmentLabel: string | null;
        plate: string | null;
        redeemedLabel: string | null;
        customerId: string | null;
        leadId: string | null;
        /** What to charge for the wash, when the offer is still configured. */
        priceLabel: string | null;
        /** Customers already on file with this claim's phone number or email. */
        matches: ClaimCustomerMatch[];
      };
    }
  | { ok: false; error: string };

/**
 * Counter lookup: "they have a code, is it good?"
 *
 * Staff-only, so it may say what the public claim form deliberately never does
 * — whether this phone number or email already belongs to a customer. That is
 * the question the counter needs answered before honouring a new-customer
 * offer, and the answer never leaves the admin.
 */
export async function findOfferClaimAction(raw: unknown): Promise<ClaimLookupResult> {
  try {
    await requireStaff("manage_bookings");
    const parsed = lookupInput.safeParse(raw);
    const code = parsed.success ? normalizeClaimCode(parsed.data.code) : null;
    if (!code) return { ok: false, error: "Enter the code from the customer's text or email." };

    // Codes are printed "PTW-7QK2MB", and people read out only the part after
    // the dash. Accept either.
    const candidates = code.startsWith("PTW") ? [code] : [code, `PTW${code}`];
    const [row] = await db()
      .select({ claim: schema.offerClaims, appointmentStartsAt: schema.appointments.startsAt })
      .from(schema.offerClaims)
      .leftJoin(schema.appointments, eq(schema.appointments.id, schema.offerClaims.appointmentId))
      .where(or(...candidates.map((c) => eq(schema.offerClaims.code, c))))
      .limit(1);
    if (!row) return { ok: false, error: "No claim found for that code. Check it letter by letter." };
    const claim = row.claim;

    const settings = await getSettings();
    const offer = activeWashOffer(settings);
    const priceCents = offer
      ? washOfferPriceCents(offer, claim.vehicleSize === "suv" ? "suv_small" : "sedan")
      : null;
    const day = (value: Date) =>
      formatInZone(value, settings.timezone, { weekday: "short", month: "short", day: "numeric", year: "numeric" });

    return {
      ok: true,
      claim: {
        id: claim.id,
        code: formatClaimCode(claim.code),
        name: [claim.firstName, claim.lastName].filter(Boolean).join(" ").trim(),
        phone: claim.phone ? formatPhone(claim.phone) : null,
        email: claim.email,
        status: claimIsExpired(claim) ? "expired" : claim.status,
        claimedLabel: day(claim.createdAt),
        expiresLabel: day(claim.expiresAt),
        appointmentId: claim.appointmentId,
        appointmentLabel: row.appointmentStartsAt
          ? formatInZone(row.appointmentStartsAt, settings.timezone, {
              weekday: "short",
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
            })
          : null,
        plate: claim.redeemedPlateNormalized,
        redeemedLabel: claim.redeemedAt ? day(claim.redeemedAt) : null,
        customerId: claim.customerId,
        leadId: claim.leadId,
        priceLabel: priceCents === null ? null : formatCents(priceCents, settings.currency),
        matches: await customersMatching(claim, settings.timezone),
      },
    };
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, error: err.message };
    console.error("findOfferClaimAction failed", err);
    return { ok: false, error: "Something went wrong" };
  }
}

function claimIsExpired(claim: OfferClaim, nowMs: number = Date.now()): boolean {
  return claim.status === "expired" || (claim.status === "issued" && claim.expiresAt.getTime() <= nowMs);
}

/** Customers on file with the claim's phone or email, with enough history to judge "new". */
async function customersMatching(claim: OfferClaim, timezone: string): Promise<ClaimCustomerMatch[]> {
  const match = or(
    claim.phoneNormalized ? eq(schema.customers.phoneNormalized, claim.phoneNormalized) : undefined,
    claim.emailNormalized ? sql`lower(${schema.customers.email}) = ${claim.emailNormalized}` : undefined,
  );
  if (!match) return [];
  const customers = await db()
    .select()
    .from(schema.customers)
    .where(and(isNull(schema.customers.anonymizedAt), match))
    .orderBy(asc(schema.customers.createdAt))
    .limit(5);

  const matches: ClaimCustomerMatch[] = [];
  for (const customer of customers) {
    const [[appointments], [invoices]] = await Promise.all([
      db()
        .select({ total: count() })
        .from(schema.appointments)
        .where(eq(schema.appointments.customerId, customer.id)),
      db()
        .select({ total: count() })
        .from(schema.invoices)
        .where(eq(schema.invoices.customerId, customer.id)),
    ]);
    const since = formatInZone(customer.createdAt, timezone, { month: "short", day: "numeric", year: "numeric" });
    matches.push({
      id: customer.id,
      label:
        customer.customerType === "business" && customer.companyName
          ? `${customer.companyName} — ${customer.firstName} ${customer.lastName}`.trim()
          : `${customer.firstName} ${customer.lastName}`.trim(),
      detail: `On file since ${since} · ${appointments?.total ?? 0} appointment${appointments?.total === 1 ? "" : "s"} · ${invoices?.total ?? 0} invoice${invoices?.total === 1 ? "" : "s"}`,
    });
  }
  return matches;
}

const walkInInput = z.object({
  claimId: z.string().trim().min(1).max(64),
  plate: z.string().trim().min(2).max(20),
  /** An existing customer's id, "new" to create one from the claim, or "none". */
  customer: z.union([z.literal("new"), z.literal("none"), z.string().trim().min(1).max(64)]),
  honourExpired: z.boolean().default(false),
});

export type WalkInRedemptionResult =
  | { ok: true; message: string; customerId: string | null; createdCustomer: boolean }
  | { ok: false; error: string; customerId?: string | null; createdCustomer?: boolean };

/**
 * Redeems a code for somebody who walked in with it instead of booking.
 *
 * The booking wizard is where a code is normally spent, and the plate is then
 * recorded on the appointment. A walk-in skips the wizard, so until now the
 * shop could wash the car, invoice it and still leave the code live and the
 * plate unrecorded — free to be used again. This is that missing step.
 *
 * Money is not touched here, exactly as on the appointment path: staff charge
 * the offer price on the invoice as they would any walk-in. What this records
 * is the part that has to be a fact — which plate had the promotional wash —
 * and it goes through the same partial unique index, so a plate that has
 * already had it is refused however the car arrived.
 *
 * The customer is created before the plate is checked, on purpose: the car is
 * being washed either way, at the offer price or the regular one, and the
 * record is needed for the invoice whichever it turns out to be.
 */
export async function redeemWalkInClaimAction(raw: unknown): Promise<WalkInRedemptionResult> {
  try {
    const staff = await requireStaff("manage_bookings");
    const parsed = walkInInput.safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Enter the licence plate." };
    const input = parsed.data;
    if (!normalizePlate(input.plate)) return { ok: false, error: "Enter the licence plate." };

    const [claim] = await db()
      .select()
      .from(schema.offerClaims)
      .where(eq(schema.offerClaims.id, input.claimId))
      .limit(1);
    if (!claim) return { ok: false, error: "That claim no longer exists." };
    if (claim.status === "void") return { ok: false, error: "This code was released and cannot be used." };
    if (claim.redeemedPlateNormalized) {
      return { ok: false, error: `This code was already used, on plate ${claim.redeemedPlateNormalized}.` };
    }
    if (claimIsExpired(claim) && !input.honourExpired) {
      return {
        ok: false,
        error: "This code has expired. Tick “Honour it anyway” if you have decided to accept it.",
      };
    }

    let customerId: string | null = null;
    let createdCustomer = false;
    if (input.customer === "new") {
      await requireStaff("manage_customers");
      customerId = await createCustomerFromClaim(claim, staff.id);
      createdCustomer = true;
    } else if (input.customer !== "none") {
      const [customer] = await db()
        .select({ id: schema.customers.id })
        .from(schema.customers)
        .where(and(eq(schema.customers.id, input.customer), isNull(schema.customers.anonymizedAt)))
        .limit(1);
      if (!customer) return { ok: false, error: "That customer could not be found — pick them again." };
      customerId = customer.id;
    }

    const result = await redeemClaimAgainstPlate({
      claimId: claim.id,
      rawPlate: input.plate,
      staffId: staff.id,
      customerId: customerId ?? undefined,
    });
    if (!result.ok) {
      if (createdCustomer) revalidatePath("/admin/customers");
      return {
        ok: false,
        error: redemptionError(result, "raise the invoice at the normal price."),
        customerId,
        createdCustomer,
      };
    }

    const plate = result.claim.redeemedPlateNormalized!;
    const linkedCustomerId = result.claim.customerId;
    await recordPlateOnVehicle({
      appointmentId: result.claim.appointmentId,
      customerId: linkedCustomerId,
      rawPlate: input.plate,
      plate,
    });

    await audit(db(), {
      actorType: "staff",
      actorId: staff.id,
      action: "offer_claim.redeemed",
      entityType: "offer_claim",
      entityId: result.claim.id,
      after: {
        plate,
        via: "counter",
        appointmentId: result.claim.appointmentId,
        customerId: linkedCustomerId,
        createdCustomer,
        honouredExpired: claimIsExpired(claim),
        code: result.claim.code,
      },
    });
    await markClaimLeadCompleted(db(), { claim: result.claim, customerId: linkedCustomerId, staffId: staff.id });

    revalidatePath("/admin/marketing/offer-claims");
    revalidatePath("/admin/marketing/wash-nudges");
    revalidatePath("/admin/leads");
    if (linkedCustomerId) revalidatePath(`/admin/customers/${linkedCustomerId}`);
    if (result.claim.appointmentId) revalidatePath(`/admin/appointments/${result.claim.appointmentId}`);
    return {
      ok: true,
      message: `Code ${formatClaimCode(result.claim.code)} redeemed on plate ${plate}. That plate cannot get the offer again.`,
      customerId: linkedCustomerId,
      createdCustomer,
    };
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, error: err.message };
    console.error("redeemWalkInClaimAction failed", err);
    return { ok: false, error: "Something went wrong" };
  }
}

/**
 * A customer record from the details the claimant typed on the landing page.
 * Consent is carried across with its original date and source rather than
 * re-stamped: the evidence is the claim form, not this button.
 */
async function createCustomerFromClaim(claim: OfferClaim, staffId: string): Promise<string> {
  const customerId = newId("cus");
  await db().transaction(async (tx) => {
    await tx.insert(schema.customers).values({
      id: customerId,
      firstName: claim.firstName,
      lastName: claim.lastName,
      email: claim.email,
      phone: claim.phone,
      phoneNormalized: normalizePhone(claim.phone),
      preferredContact: claim.phone ? "sms" : "email",
      marketingConsent: claim.marketingConsent,
      marketingConsentAt: claim.marketingConsent ? (claim.marketingConsentAt ?? claim.createdAt) : null,
      marketingConsentSource: claim.marketingConsent ? "public_offer_terms" : null,
      sourceLeadId: claim.leadId,
    });
    await audit(tx, {
      actorType: "staff",
      actorId: staffId,
      action: "customer.created",
      entityType: "customer",
      entityId: customerId,
      after: {
        source: "wash_offer_counter",
        offerClaimId: claim.id,
        marketingConsent: claim.marketingConsent,
      },
    });
  });
  return customerId;
}

/**
 * Puts the plate on the vehicle record, where the rest of the shop looks for
 * it — but only where the right vehicle is unambiguous, and never over a plate
 * somebody already typed.
 */
async function recordPlateOnVehicle(input: {
  appointmentId: string | null;
  customerId: string | null;
  rawPlate: string;
  plate: string;
}): Promise<void> {
  const display = input.rawPlate.trim().toUpperCase();
  if (input.appointmentId) {
    const [appointment] = await db()
      .select({ vehicleId: schema.appointments.vehicleId })
      .from(schema.appointments)
      .where(eq(schema.appointments.id, input.appointmentId))
      .limit(1);
    if (appointment) {
      await db()
        .update(schema.vehicles)
        .set({ licencePlate: display, updatedAt: new Date() })
        .where(and(eq(schema.vehicles.id, appointment.vehicleId), isNull(schema.vehicles.licencePlate)));
    }
    return;
  }
  if (!input.customerId) return;
  const vehicles = await db()
    .select({ id: schema.vehicles.id, licencePlate: schema.vehicles.licencePlate })
    .from(schema.vehicles)
    .where(eq(schema.vehicles.customerId, input.customerId));
  if (vehicles.some((v) => normalizePlate(v.licencePlate) === input.plate)) return;
  if (vehicles.length === 1 && !vehicles[0].licencePlate) {
    await db()
      .update(schema.vehicles)
      .set({ licencePlate: display, updatedAt: new Date() })
      .where(and(eq(schema.vehicles.id, vehicles[0].id), isNull(schema.vehicles.licencePlate)));
  }
}
