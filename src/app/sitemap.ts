import type { MetadataRoute } from "next";
import { asc, eq } from "drizzle-orm";
import { db, schema } from "@/db";

const PUBLIC_ROUTES = [
  "",
  "/services",
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
  const base = new URL(process.env.APP_BASE_URL ?? "http://localhost:3000").origin;
  const services = await db()
    .select({ slug: schema.services.slug, updatedAt: schema.services.updatedAt })
    .from(schema.services)
    .where(eq(schema.services.active, true))
    .orderBy(asc(schema.services.sort));
  const now = new Date();

  return [
    ...PUBLIC_ROUTES.map((route) => ({
      url: `${base}${route}`,
      lastModified: now,
      changeFrequency: route === "" ? ("weekly" as const) : ("monthly" as const),
      priority: route === "" ? 1 : route === "/services" || route === "/book" ? 0.9 : 0.6,
    })),
    ...services.map((service) => ({
      url: `${base}/services/${service.slug}`,
      lastModified: service.updatedAt,
      changeFrequency: "monthly" as const,
      priority: 0.7,
    })),
  ];
}
