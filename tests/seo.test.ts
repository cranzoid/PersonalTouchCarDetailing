import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import robots from "@/app/robots";
import { middleware } from "@/middleware";
import { pageMetadata, SEO_PAGES } from "@/lib/seo";
import { SERVICE_SEO } from "@/lib/service-seo";
import { publicationErrors } from "@/lib/case-studies";

const previousIndexable = process.env.SEO_INDEXABLE;

afterEach(() => {
  if (previousIndexable === undefined) delete process.env.SEO_INDEXABLE;
  else process.env.SEO_INDEXABLE = previousIndexable;
});

describe("SEO metadata", () => {
  it("keeps every code-managed page title and description unique", () => {
    const definitions = Object.values(SEO_PAGES).filter((page) => !("noIndex" in page && page.noIndex));
    expect(new Set(definitions.map((page) => page.title)).size).toBe(definitions.length);
    expect(new Set(definitions.map((page) => page.description)).size).toBe(definitions.length);
  });

  it("generates clean self-canonicals and public Open Graph URLs", () => {
    const metadata = pageMetadata(SEO_PAGES.book);
    expect(metadata.alternates?.canonical).toBe("/book");
    expect(metadata.openGraph && "url" in metadata.openGraph ? metadata.openGraph.url : undefined).toBe("/book");
    expect(JSON.stringify(metadata)).not.toMatch(/localhost|azurewebsites\.net/i);
  });

  it("defines original priority-service content and unique metadata", () => {
    const required = ["interior-detail", "ceramic-coating", "paint-protection-film", "vehicle-tinting"];
    for (const slug of required) {
      const service = SERVICE_SEO[slug];
      expect(service.path).toBe(`/services/${slug}`);
      expect(service.h1.toLowerCase()).toContain("hamilton");
      expect(service.benefits.length).toBeGreaterThanOrEqual(3);
      expect(service.process.length).toBeGreaterThanOrEqual(3);
      expect(service.faqs.length).toBeGreaterThanOrEqual(3);
    }
    expect(new Set(required.map((slug) => SERVICE_SEO[slug].title)).size).toBe(required.length);
  });
});

describe("crawl environment controls", () => {
  it("blocks all crawling outside production", () => {
    process.env.SEO_INDEXABLE = "false";
    expect(robots()).toEqual({ rules: { userAgent: "*", disallow: "/" } });
    const response = middleware(new NextRequest("https://staging.example.invalid/services"));
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow, noarchive");
  });

  it("redirects a production noncanonical host and preserves the route and query", () => {
    process.env.SEO_INDEXABLE = "true";
    const response = middleware(new NextRequest("https://app.example.invalid/book?service=interior-detail&utm_source=gbp"));
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe("https://www.personaltouchcardetailing.ca/book?service=interior-detail&utm_source=gbp");
  });

  it("keeps the Azure staging hostname healthy and noindex during swap warm-up", () => {
    process.env.SEO_INDEXABLE = "true";
    const response = middleware(
      new NextRequest("https://app-ptcd-prod-7mutra-staging.azurewebsites.net/api/health"),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow, noarchive");
  });

  it("publishes the canonical production sitemap location", () => {
    process.env.SEO_INDEXABLE = "true";
    const result = robots();
    expect(result.sitemap).toBe("https://www.personaltouchcardetailing.ca/sitemap.xml");
    expect(JSON.stringify(result)).not.toMatch(/localhost|azurewebsites\.net/i);
  });
});

describe("case-study publication validation", () => {
  const complete = {
    slug: "winter-interior-reset",
    title: "Winter interior reset for a Hamilton daily driver",
    summary: "A salt-marked daily-driver cabin received a documented, condition-aware interior reset.",
    challenge: "Winter salt residue, embedded dry debris and several older marks were visible through the footwells and seating areas before work began.",
    process: "The cabin was inspected first, then loose debris was removed before material-appropriate cleaning of the carpet, seats, mats, trim and glass.",
    outcome: "The cabin presented substantially cleaner and more consistent, while one permanent material mark was documented rather than described as removed.",
    primaryServiceId: "svc_interior",
    consentConfirmedAt: new Date(),
    privacyCheckedAt: new Date(),
    approvedMediaCount: 2,
  };

  it("accepts a complete, consent-checked genuine story", () => {
    expect(publicationErrors(complete)).toEqual([]);
  });

  it("rejects missing consent, privacy review and approved images", () => {
    const errors = publicationErrors({ ...complete, consentConfirmedAt: null, privacyCheckedAt: null, approvedMediaCount: 0 });
    expect(errors.join(" ")).toMatch(/customer approved/i);
    expect(errors.join(" ")).toMatch(/identifiers/i);
    expect(errors.join(" ")).toMatch(/at least one image/i);
  });
});
