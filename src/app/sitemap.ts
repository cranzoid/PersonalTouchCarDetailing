import type { MetadataRoute } from "next";
import { asc, desc, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { PUBLIC_SITE_URL } from "@/lib/seo";
import { getSettings } from "@/lib/settings";
import { activeWashOffer, FIRST_WASH_OFFER_PATH } from "@/lib/wash-offer";

// Service URLs come from PostgreSQL and must be resolved after startup
// migrations have initialized the production database.
export const dynamic = "force-dynamic";

const PUBLIC_ROUTES = [
  "",
  "/services",
  "/services/paint-correction",
  // Hand-written overview pages. /services/ceramic-protection is emitted by
  // the catalogue loop below too, so the list is de-duplicated before it is
  // returned; /services/ceramic-coating has no catalogue row behind it.
  "/services/ceramic-coating",
  "/services/ceramic-protection",
  "/offers/ceramic-coating",
  "/blog",
  "/book",
  "/quote",
  "/gallery",
  "/fleet",
  "/about",
  "/reviews",
  "/faq",
  "/contact",
  "/policies/privacy",
  "/policies/cancellation",
  "/policies/terms",
];

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const [services, caseStudies, blogPosts] = await Promise.all([
    db()
      .select({ slug: schema.services.slug, updatedAt: schema.services.updatedAt })
      .from(schema.services)
      .where(eq(schema.services.active, true))
      .orderBy(asc(schema.services.sort)),
    db()
      .select({ slug: schema.caseStudies.slug, updatedAt: schema.caseStudies.updatedAt })
      .from(schema.caseStudies)
      .where(eq(schema.caseStudies.status, "published"))
      .orderBy(desc(schema.caseStudies.publishedAt)),
    db()
      .select({ slug: schema.blogPosts.slug, updatedAt: schema.blogPosts.updatedAt })
      .from(schema.blogPosts)
      .where(eq(schema.blogPosts.status, "published"))
      .orderBy(desc(schema.blogPosts.publishedAt)),
  ]);

  // The wash offer's landing page is advertised only while it is running. It
  // sets its own noindex when switched off, but a sitemap that still lists a
  // page reading "this offer has finished" is pointing crawlers at a dead end.
  const washOffer = activeWashOffer(await getSettings());

  const entries = [
    ...PUBLIC_ROUTES.map((route) => ({
      url: `${PUBLIC_SITE_URL}${route}`,
    })),
    ...(washOffer?.acceptingClaims ? [{ url: `${PUBLIC_SITE_URL}${FIRST_WASH_OFFER_PATH}` }] : []),
    // /results 404s until a case study is published, so it is advertised only
    // once one is. See src/lib/results.ts.
    ...(caseStudies.length > 0 ? [{ url: `${PUBLIC_SITE_URL}/results` }] : []),
    ...services.map((service) => ({
      url: `${PUBLIC_SITE_URL}/services/${service.slug}`,
      lastModified: service.updatedAt,
    })),
    ...caseStudies.map((story) => ({
      url: `${PUBLIC_SITE_URL}/results/${story.slug}`,
      lastModified: story.updatedAt,
    })),
    ...blogPosts.map((post) => ({
      url: `${PUBLIC_SITE_URL}/blog/${post.slug}`,
      lastModified: post.updatedAt,
    })),
  ];

  // A service whose detail page is hand-written appears in both lists. Keep
  // the first occurrence so a URL is never advertised twice.
  const seen = new Set<string>();
  return entries.filter((entry) => !seen.has(entry.url) && seen.add(entry.url));
}
