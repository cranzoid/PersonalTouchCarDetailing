import type { MetadataRoute } from "next";
import { asc, desc, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { PUBLIC_SITE_URL } from "@/lib/seo";

// Service URLs come from PostgreSQL and must be resolved after startup
// migrations have initialized the production database.
export const dynamic = "force-dynamic";

const PUBLIC_ROUTES = [
  "",
  "/services",
  "/services/paint-correction",
  "/book",
  "/quote",
  "/gallery",
  "/results",
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
  const [services, caseStudies] = await Promise.all([
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
  ]);

  return [
    ...PUBLIC_ROUTES.map((route) => ({
      url: `${PUBLIC_SITE_URL}${route}`,
    })),
    ...services.map((service) => ({
      url: `${PUBLIC_SITE_URL}/services/${service.slug}`,
      lastModified: service.updatedAt,
    })),
    ...caseStudies.map((story) => ({
      url: `${PUBLIC_SITE_URL}/results/${story.slug}`,
      lastModified: story.updatedAt,
    })),
  ];
}
