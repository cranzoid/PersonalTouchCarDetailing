import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";

/**
 * Whether the site has anything to show on /results yet.
 *
 * The Results page used to fill an empty library with a three-step explanation
 * of how publishing works. That is a note to ourselves, not a page a customer
 * should land on from the main navigation — it reads as an unfinished site. So
 * the whole surface is gated on real content: no published case study, no
 * Results link, no Results page, no sitemap entry.
 *
 * There is no separate switch to forget to flip. Publishing a case study in
 * Admin → Results IS the switch, and unpublishing the last one closes the page
 * again. The condition is deliberately identical to the page's own query, so a
 * story that would not render can never light up the link.
 */
const RESULTS_TTL_MS = 60_000;

let cache: { expiresAt: number; value: Promise<boolean> } | undefined;

async function loadHasPublishedResults(): Promise<boolean> {
  const rows = await db()
    .select({ id: schema.caseStudies.id })
    .from(schema.caseStudies)
    .innerJoin(
      schema.services,
      and(
        eq(schema.services.id, schema.caseStudies.primaryServiceId),
        eq(schema.services.active, true),
      ),
    )
    .where(eq(schema.caseStudies.status, "published"))
    .limit(1);
  return rows.length > 0;
}

/** Cached because the public layout asks on every page render. */
export function hasPublishedResults(): Promise<boolean> {
  const now = Date.now();
  if (!cache || cache.expiresAt <= now) {
    const pending = loadHasPublishedResults();
    const cached = pending.catch((error) => {
      if (cache?.value === cached) cache = undefined;
      throw error;
    });
    cache = { expiresAt: now + RESULTS_TTL_MS, value: cached };
  }
  return cache.value;
}

export function invalidatePublishedResultsCache(): void {
  cache = undefined;
}
