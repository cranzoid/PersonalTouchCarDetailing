"use server";

import { revalidatePath } from "next/cache";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { audit } from "@/lib/audit";
import { AuthError, requireStaff } from "@/lib/auth/session";
import { getSettings } from "@/lib/settings";
import { activeWashOffer, normalizeClaimCode } from "@/lib/wash-offer";
import { redeemClaimAgainstPlate, sendClaimMessages } from "@/lib/wash-offer-claims";
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
      if (result.reason === "plate_used") {
        const when = result.by.redeemedAt
          ? result.by.redeemedAt.toISOString().slice(0, 10)
          : "an earlier visit";
        return {
          ok: false,
          error: `Plate ${result.plate} already had the offer on ${when}${result.by.name ? ` (${result.by.name})` : ""}. Charge the regular price — use "Change packages" to reprice this booking.`,
        };
      }
      if (result.reason === "already_redeemed") {
        return { ok: false, error: "This claim has already been redeemed against a plate." };
      }
      if (result.reason === "void") return { ok: false, error: "This claim has been released and cannot be redeemed." };
      return { ok: false, error: "That claim no longer exists." };
    }

    // Write the plate onto the vehicle too. Staff are looking at the car, so
    // this is the most reliable moment the record will ever get — but never
    // over the top of a plate somebody already recorded by hand.
    if (result.claim.appointmentId) {
      const [appointment] = await db()
        .select({ vehicleId: schema.appointments.vehicleId })
        .from(schema.appointments)
        .where(eq(schema.appointments.id, result.claim.appointmentId))
        .limit(1);
      if (appointment) {
        await db()
          .update(schema.vehicles)
          .set({ licencePlate: parsed.data.plate.trim().toUpperCase(), updatedAt: new Date() })
          .where(and(eq(schema.vehicles.id, appointment.vehicleId), isNull(schema.vehicles.licencePlate)));
      }
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

    revalidatePath("/admin/marketing/offer-claims");
    if (result.claim.appointmentId) revalidatePath(`/admin/appointments/${result.claim.appointmentId}`);
    return { ok: true, message: `Offer redeemed against plate ${result.claim.redeemedPlateNormalized}.` };
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, error: err.message };
    console.error("redeemOfferClaimAction failed", err);
    return { ok: false, error: "Something went wrong" };
  }
}

const lookupInput = z.object({ code: z.string().trim().min(3).max(40) });

export type ClaimLookupResult =
  | {
      ok: true;
      claim: {
        id: string;
        code: string;
        name: string;
        phone: string | null;
        status: string;
        expiresLabel: string;
        appointmentId: string | null;
        plate: string | null;
      };
    }
  | { ok: false; error: string };

/** Counter lookup: "they have a code, is it good?" */
export async function findOfferClaimAction(raw: unknown): Promise<ClaimLookupResult> {
  try {
    await requireStaff("manage_bookings");
    const parsed = lookupInput.safeParse(raw);
    const code = parsed.success ? normalizeClaimCode(parsed.data.code) : null;
    if (!code) return { ok: false, error: "Enter the code from the customer's text or email." };

    const [claim] = await db()
      .select()
      .from(schema.offerClaims)
      .where(eq(schema.offerClaims.code, code))
      .limit(1);
    if (!claim) return { ok: false, error: "No claim found for that code." };

    const settings = await getSettings();
    return {
      ok: true,
      claim: {
        id: claim.id,
        code: claim.code,
        name: [claim.firstName, claim.lastName].filter(Boolean).join(" ").trim(),
        phone: claim.phone,
        status: claim.expiresAt.getTime() <= Date.now() && claim.status === "issued" ? "expired" : claim.status,
        expiresLabel: claim.expiresAt.toLocaleDateString("en-CA", { timeZone: settings.timezone }),
        appointmentId: claim.appointmentId,
        plate: claim.redeemedPlateNormalized,
      },
    };
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, error: err.message };
    console.error("findOfferClaimAction failed", err);
    return { ok: false, error: "Something went wrong" };
  }
}
