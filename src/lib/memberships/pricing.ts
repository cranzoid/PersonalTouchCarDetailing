import { inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import { percentCents } from "@/lib/money";
import type { PricedLine } from "@/lib/pricing";
import { getSettings } from "@/lib/settings";
import { MEMBERSHIP_BENEFITS, WINTER_PASS_SERVICE_SLUG, membershipSettings, type MembershipBenefit } from "./config";
import { getVehicleEntitlements } from "./service";

/** A prepaid entitlement a booking spends: this month's benefit, or a pass wash. */
export type AppliedEntitlement =
  | { type: "membership_benefit"; membershipId: string; benefit: MembershipBenefit }
  | { type: "pass_wash"; passId: string };

/**
 * What a member's car is entitled to on one booking, resolved on the server.
 * The booking flows pass this to priceBooking; a client can never supply it.
 */
export type MemberPricing = {
  /** Shown as the discount label, e.g. "Winter Shield Club member benefits". */
  label: string;
  discountBp: number;
  discountServiceIds: string[];
  discountAddons: boolean;
  /** Services made free by an entitlement, each usable once. */
  free: { serviceId: string; entitlement: AppliedEntitlement }[];
};

/**
 * The member's discount per line, in the same shape as every other offer's
 * allocation so `bestOfAllocations` can pick the best one per line — a member
 * discount never stacks on a bundle or campaign discount on the same line.
 *
 *  - an included service (this month's wash, a pass wash) → the whole line
 *  - a detailing package on the eligible list → the plan's percentage
 *  - an add-on → the percentage too, but only when an eligible package is in
 *    the same booking ("with a detailing package they get it on add-ons")
 */
export function memberAllocation(
  lines: readonly PricedLine[],
  member: MemberPricing,
): { allocation: number[]; entitlements: AppliedEntitlement[] } {
  const eligible = new Set(member.discountServiceIds);
  const hasEligiblePackage = lines.some((line) => line.serviceId && eligible.has(line.serviceId));
  const unused = [...member.free];
  const entitlements: AppliedEntitlement[] = [];
  const allocation = lines.map((line) => {
    if (line.serviceId) {
      const index = unused.findIndex((entry) => entry.serviceId === line.serviceId);
      if (index >= 0) {
        entitlements.push(unused[index].entitlement);
        unused.splice(index, 1);
        return line.priceCents;
      }
      if (eligible.has(line.serviceId) && member.discountBp > 0) return percentCents(line.priceCents, member.discountBp);
      return 0;
    }
    if (line.addonId && member.discountAddons && hasEligiblePackage && member.discountBp > 0) {
      return percentCents(line.priceCents, member.discountBp);
    }
    return 0;
  });
  return { allocation, entitlements };
}

/**
 * Builds the pricing context for a car: its membership discount, and the
 * entitlements the caller asks to spend (only those actually available).
 * Null when the car has nothing to apply.
 */
export async function resolveMemberPricing(input: {
  vehicleId: string;
  spendBenefits?: MembershipBenefit[];
  spendPassWash?: boolean;
  at?: Date;
}): Promise<MemberPricing | null> {
  const now = new Date();
  const at = input.at ?? now;
  // The membership is judged as it stands today — a member in good standing
  // gets their discount on a package booked a few weeks out. A pass wash is
  // judged on the visit date, because that is when the season rules apply.
  const { membership, passes: passesNow } = await getVehicleEntitlements(input.vehicleId, now);
  const passes = at.getTime() === now.getTime() ? passesNow : (await getVehicleEntitlements(input.vehicleId, at)).passes;
  const settings = await getSettings();
  const config = membershipSettings(settings);

  const wantedSlugs = new Set<string>([...config.discountServiceSlugs, WINTER_PASS_SERVICE_SLUG]);
  for (const benefit of input.spendBenefits ?? []) wantedSlugs.add(MEMBERSHIP_BENEFITS[benefit].serviceSlug);
  const services = await db()
    .select({ id: schema.services.id, slug: schema.services.slug })
    .from(schema.services)
    .where(inArray(schema.services.slug, [...wantedSlugs]));
  const idBySlug = new Map(services.map((s) => [s.slug, s.id]));

  const free: MemberPricing["free"] = [];
  if (membership) {
    for (const benefit of input.spendBenefits ?? []) {
      const serviceId = idBySlug.get(MEMBERSHIP_BENEFITS[benefit].serviceSlug);
      if (serviceId && membership.available.includes(benefit)) {
        free.push({ serviceId, entitlement: { type: "membership_benefit", membershipId: membership.membershipId, benefit } });
      }
    }
  }
  if (input.spendPassWash) {
    const pass = passes.find((p) => p.usableNow);
    const serviceId = idBySlug.get(WINTER_PASS_SERVICE_SLUG);
    if (pass && serviceId) free.push({ serviceId, entitlement: { type: "pass_wash", passId: pass.passId } });
  }
  const discountBp = membership?.discountBp ?? 0;
  if (free.length === 0 && discountBp <= 0) return null;

  const label = membership
    ? `${membership.planName} member benefits`
    : free.some((f) => f.entitlement.type === "pass_wash")
      ? `${config.winterPass.name} wash`
      : "Member benefits";
  return {
    label,
    discountBp,
    discountServiceIds: config.discountServiceSlugs.map((slug) => idBySlug.get(slug)).filter((id): id is string => Boolean(id)),
    discountAddons: config.discountAddons,
    free,
  };
}
