import { NextResponse } from "next/server";
import { db } from "@/db";
import { getSettings } from "@/lib/settings";
import { activeWashOffer, FIRST_WASH_OFFER_PATH, normalizeClaimCode } from "@/lib/wash-offer";
import { lookupClaim } from "@/lib/wash-offer-claims";

export const dynamic = "force-dynamic";

/**
 * Short link for a wash-offer code: /w/PTW7QK2MB.
 *
 * Exists because the full booking deep link is ~110 characters and an SMS is
 * priced and read in segments — the long form pushed every code text to two
 * messages and made the useful part of it invisible on a phone.
 *
 * Resolves nothing sensitive: a code that does not exist simply lands on the
 * offer page, which is also the right answer for a mistyped one.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ code: string }> },
) {
  const { code } = await params;
  const canonical = normalizeClaimCode(code);
  const settings = await getSettings();
  const offer = activeWashOffer(settings);

  if (offer && canonical) {
    const lookup = await lookupClaim(db(), offer.code, canonical);
    if (lookup.ok) {
      const destination = `/book?service=${encodeURIComponent(offer.serviceSlug)}&offer=${encodeURIComponent(offer.code)}&claim=${encodeURIComponent(lookup.claim.code)}`;
      return NextResponse.redirect(new URL(destination, _request.url), 302);
    }
  }
  // Expired, spent, unknown, or the offer is over: the landing page explains
  // whichever of those it is far better than a 404 does.
  return NextResponse.redirect(new URL(FIRST_WASH_OFFER_PATH, _request.url), 302);
}
