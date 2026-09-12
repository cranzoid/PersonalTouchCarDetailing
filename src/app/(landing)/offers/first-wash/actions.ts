"use server";

import { z } from "zod";
import { getSettings } from "@/lib/settings";
import { consumeRateLimit } from "@/lib/rate-limit";
import { formatCents } from "@/lib/money";
import { formatInZone } from "@/lib/tz";
import { getAppBaseUrl } from "@/lib/urls";
import {
  activeWashOffer,
  formatClaimCode,
  WASH_OFFER_TERMS_VERSION,
  washOfferPriceCents,
} from "@/lib/wash-offer";
import { issueClaim, sendClaimMessages } from "@/lib/wash-offer-claims";
import type { Attribution } from "@/db/schema";

const claimSchema = z.object({
  firstName: z.string().trim().min(1).max(60),
  lastName: z.string().trim().max(60).optional(),
  // Required. The offer's "one per customer" cap is keyed on this, and it is
  // how the shop reaches someone about an appointment.
  phone: z.string().trim().min(7).max(30),
  email: z.string().trim().email().max(200).optional().or(z.literal("").transform(() => undefined)),
  vehicleSize: z.enum(["car", "suv"]),
  marketingConsent: z.boolean().default(false),
  attribution: z.record(z.string(), z.unknown()).optional(),
});

export type ClaimResult =
  | {
      ok: true;
      /** "PTW-7QK2MB" — display form. */
      code: string;
      expiresLabel: string;
      /** Deep link that carries the claim into the booking wizard. */
      bookingPath: string;
      /** False when this contact already held a code and we returned it. */
      isNew: boolean;
      /** The claim has been spent already; the UI says so rather than promising a wash. */
      alreadyUsed: boolean;
      expired: boolean;
      sentBy: ("sms" | "email")[];
      priceLabel: string;
    }
  | { ok: false; error: string };

/**
 * Claims the new-customer wash offer.
 *
 * Note what this does NOT do: tell the browser whether the person is already a
 * customer. Re-claiming returns the code they already hold, so the response is
 * the same either way and the form cannot be used to ask whether a phone number
 * is on our books — the oracle DECISIONS.md #14 refused to build. Eligibility
 * as a *new customer* is settled at booking, server-side, and again at the
 * counter against the licence plate.
 */
export async function claimWashOfferAction(raw: unknown): Promise<ClaimResult> {
  const rate = await consumeRateLimit("wash-offer-claim", { limit: 8, windowMs: 60 * 60_000 });
  if (!rate.allowed) {
    return { ok: false, error: "Too many attempts from this connection. Please try again later, or call us." };
  }
  const parsed = claimSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: "Please check your name and mobile number." };
  }
  const input = parsed.data;

  try {
    const settings = await getSettings();
    const offer = activeWashOffer(settings);
    if (!offer) return { ok: false, error: "This offer has finished. Please see our current prices, or call us." };
    if (!offer.acceptingClaims) {
      return { ok: false, error: "Claims for this offer have closed. Please call us — we may still be able to help." };
    }

    const { claim, created } = await issueClaim({
      offer,
      firstName: input.firstName,
      lastName: input.lastName,
      phone: input.phone,
      email: input.email,
      vehicleSize: input.vehicleSize,
      marketingConsent: input.marketingConsent,
      termsVersion: WASH_OFFER_TERMS_VERSION,
      attribution: (input.attribution ?? undefined) as Attribution | undefined,
    });

    const displayCode = formatClaimCode(claim.code);
    const expiresLabel = formatInZone(claim.expiresAt, settings.timezone, {
      weekday: "long",
      month: "long",
      day: "numeric",
    });
    const alreadyUsed = claim.status === "booked" || claim.status === "redeemed";
    const expired = claim.status === "expired" || claim.expiresAt.getTime() <= Date.now();
    const priceCents = washOfferPriceCents(offer, input.vehicleSize === "suv" ? "suv_small" : "sedan");
    const priceLabel = priceCents === null ? "" : formatCents(priceCents, settings.currency);
    const bookingPath = `/book?service=${encodeURIComponent(offer.serviceSlug)}&offer=${encodeURIComponent(offer.code)}&claim=${encodeURIComponent(claim.code)}`;

    // Delivery is best effort and deliberately secondary: the code is on the
    // screen in front of them. SMS in particular cannot be relied on until the
    // carrier registration is finished, and a funnel that depends on a text
    // arriving is a funnel that stops working the day the provider does.
    let sentBy: ("sms" | "email")[] = [];
    if (created && !alreadyUsed && !expired) {
      sentBy = await sendClaimMessages({
        claim,
        offer,
        settings,
        variant: "code",
        baseUrl: safeBaseUrl(),
      });
    }

    return {
      ok: true,
      code: displayCode,
      expiresLabel,
      bookingPath,
      isNew: created,
      alreadyUsed,
      expired,
      sentBy,
      priceLabel,
    };
  } catch (err) {
    console.error("claimWashOfferAction failed", err);
    return { ok: false, error: "Something went wrong. Please try again, or call us and we will sort it out." };
  }
}

/** The public base URL, falling back to the offer path if it is unconfigured. */
function safeBaseUrl(): string {
  try {
    return getAppBaseUrl();
  } catch {
    return "";
  }
}
