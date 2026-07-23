import type { MetadataRoute } from "next";

function origin(): string {
  return new URL(process.env.APP_BASE_URL ?? "http://localhost:3000").origin;
}

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/admin", "/portal", "/api/"],
    },
    sitemap: `${origin()}/sitemap.xml`,
  };
}
