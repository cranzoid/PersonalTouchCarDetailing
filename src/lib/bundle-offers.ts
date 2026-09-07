import { percentCents } from "@/lib/money";

export type BundleOfferRule = {
  primaryServiceId: string;
  bundledServiceId: string;
  discountPercentBp: number;
  label: string;
};

type DiscountLine = { serviceId?: string; priceCents: number };

/**
 * Resolves active bundle rules into one discount per priced line.
 *
 * A rule applies only when both services are present. If several rules could
 * reach the same line, the customer receives the single highest percentage;
 * offers never compound accidentally.
 */
export function bundleDiscountAllocations(
  lines: readonly DiscountLine[],
  offers: readonly BundleOfferRule[],
): { allocation: number[]; labels: string[] } {
  const selected = new Set(lines.flatMap((line) => line.serviceId ? [line.serviceId] : []));
  const labels = new Set<string>();
  const allocation = lines.map((line) => {
    if (!line.serviceId || line.priceCents <= 0) return 0;
    const best = offers
      .filter((offer) =>
        offer.bundledServiceId === line.serviceId &&
        selected.has(offer.primaryServiceId) &&
        selected.has(offer.bundledServiceId) &&
        offer.discountPercentBp > 0,
      )
      .sort((a, b) => b.discountPercentBp - a.discountPercentBp)[0];
    if (!best) return 0;
    labels.add(best.label);
    return Math.min(line.priceCents, percentCents(line.priceCents, best.discountPercentBp));
  });
  return { allocation, labels: [...labels] };
}

/**
 * Chooses the better discount on each line. This lets a claimed campaign code
 * coexist with an automatic bundle without stacking two percentages onto the
 * same service.
 */
export function bestAllocation(
  bundle: readonly number[],
  campaign: readonly number[],
): { allocation: number[]; bundleContributes: boolean; campaignContributes: boolean } {
  let bundleContributes = false;
  let campaignContributes = false;
  const length = Math.max(bundle.length, campaign.length);
  const allocation = Array.from({ length }, (_, index) => {
    const bundleCents = bundle[index] ?? 0;
    const campaignCents = campaign[index] ?? 0;
    if (bundleCents >= campaignCents && bundleCents > 0) {
      bundleContributes = true;
      return bundleCents;
    }
    if (campaignCents > 0) campaignContributes = true;
    return campaignCents;
  });
  return { allocation, bundleContributes, campaignContributes };
}
