import { percentCents } from "@/lib/money";

export type BundleOfferRule = {
  primaryServiceId: string;
  bundledServiceId: string;
  discountPercentBp: number;
  label: string;
  /** A zero-priced extra this pairing unlocks, if any. Opt-in, never automatic. */
  perkLabel?: string | null;
  perkNote?: string | null;
};

export type BundlePerk = { label: string; note: string | null };

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

export type DiscountSource = { key: string; allocation: readonly number[] };

/**
 * Chooses the single best discount on each line, across any number of competing
 * offers. Offers never stack: one line takes one saving, the largest available.
 *
 * Ties go to the EARLIER source in the list, so the caller decides precedence
 * by ordering rather than by luck.
 */
export function bestOfAllocations(sources: readonly DiscountSource[]): {
  allocation: number[];
  /** Which sources actually paid for at least one line. */
  contributing: Set<string>;
} {
  const contributing = new Set<string>();
  const length = sources.reduce((max, source) => Math.max(max, source.allocation.length), 0);
  const allocation = Array.from({ length }, (_, index) => {
    let bestCents = 0;
    let bestKey: string | null = null;
    for (const source of sources) {
      const cents = source.allocation[index] ?? 0;
      if (cents > bestCents) {
        bestCents = cents;
        bestKey = source.key;
      }
    }
    if (bestKey) contributing.add(bestKey);
    return bestCents;
  });
  return { allocation, contributing };
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
  const resolved = bestOfAllocations([
    { key: "bundle", allocation: bundle },
    { key: "campaign", allocation: campaign },
  ]);
  return {
    allocation: resolved.allocation,
    bundleContributes: resolved.contributing.has("bundle"),
    campaignContributes: resolved.contributing.has("campaign"),
  };
}

/**
 * The opt-in extra the selected pairing unlocks, if any.
 *
 * Deliberately independent of which discount ended up winning the line: the
 * extra is attached to the combination the customer bought, so a campaign code
 * that happens to beat the bundle percentage must not also take the extra away.
 */
export function bundlePerkFor(
  serviceIds: readonly string[],
  offers: readonly BundleOfferRule[],
): BundlePerk | null {
  const selected = new Set(serviceIds);
  const offer = offers.find((candidate) =>
    !!candidate.perkLabel &&
    selected.has(candidate.primaryServiceId) &&
    selected.has(candidate.bundledServiceId),
  );
  return offer ? { label: offer.perkLabel!, note: offer.perkNote ?? null } : null;
}
