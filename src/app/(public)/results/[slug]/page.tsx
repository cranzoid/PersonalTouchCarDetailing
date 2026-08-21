import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { and, asc, eq, inArray, isNotNull } from "drizzle-orm";
import { StructuredData } from "@/components/structured-data";
import { ButtonLink, Card, Container } from "@/components/ui";
import { db, schema } from "@/db";
import { BUSINESS_ENTITY_ID, PUBLIC_SITE_URL, absoluteUrl, pageMetadata, slugifySeoText } from "@/lib/seo";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const [story] = await db()
    .select({ title: schema.caseStudies.title, summary: schema.caseStudies.summary })
    .from(schema.caseStudies)
    .where(and(eq(schema.caseStudies.slug, slug), eq(schema.caseStudies.status, "published")))
    .limit(1);
  if (!story) return pageMetadata({
    title: "Car Detailing Result | Personal Touch Hamilton",
    description: "A car detailing case study from Personal Touch Car Detailing in Hamilton, Ontario.",
    path: `/results/${slug}`,
    h1: "Car detailing result",
    noIndex: true,
  });
  return pageMetadata({
    title: `${story.title} | Hamilton Detailing Result`,
    description: story.summary,
    path: `/results/${slug}`,
    h1: story.title,
  });
}

export default async function ResultDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const [story] = await db()
    .select({
      id: schema.caseStudies.id,
      slug: schema.caseStudies.slug,
      title: schema.caseStudies.title,
      summary: schema.caseStudies.summary,
      challenge: schema.caseStudies.challenge,
      process: schema.caseStudies.process,
      outcome: schema.caseStudies.outcome,
      relatedServiceIds: schema.caseStudies.relatedServiceIds,
      publishedAt: schema.caseStudies.publishedAt,
      updatedAt: schema.caseStudies.updatedAt,
      serviceId: schema.services.id,
      serviceName: schema.services.name,
      serviceSlug: schema.services.slug,
    })
    .from(schema.caseStudies)
    .innerJoin(schema.services, and(eq(schema.services.id, schema.caseStudies.primaryServiceId), eq(schema.services.active, true)))
    .where(and(eq(schema.caseStudies.slug, slug), eq(schema.caseStudies.status, "published")))
    .limit(1);
  if (!story) notFound();

  const [media, related] = await Promise.all([
    db()
      .select({ id: schema.caseStudyMedia.id, fileId: schema.caseStudyMedia.fileId, role: schema.caseStudyMedia.role, caption: schema.caseStudyMedia.caption, altText: schema.caseStudyMedia.altText, contentType: schema.files.contentType })
      .from(schema.caseStudyMedia)
      .innerJoin(schema.files, and(eq(schema.files.id, schema.caseStudyMedia.fileId), isNotNull(schema.files.publicConsentAt)))
      .where(eq(schema.caseStudyMedia.caseStudyId, story.id))
      .orderBy(asc(schema.caseStudyMedia.sort)),
    story.relatedServiceIds.length > 0
      ? db().select({ id: schema.services.id, name: schema.services.name, slug: schema.services.slug }).from(schema.services).where(and(inArray(schema.services.id, story.relatedServiceIds), eq(schema.services.active, true)))
      : Promise.resolve([]),
  ]);

  const canonicalPath = `/results/${story.slug}`;
  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Article",
        "@id": `${absoluteUrl(canonicalPath)}#article`,
        headline: story.title,
        description: story.summary,
        url: absoluteUrl(canonicalPath),
        datePublished: story.publishedAt?.toISOString(),
        dateModified: story.updatedAt.toISOString(),
        author: { "@id": BUSINESS_ENTITY_ID },
        publisher: { "@id": BUSINESS_ENTITY_ID },
        about: { "@type": "Service", name: story.serviceName, url: absoluteUrl(`/services/${story.serviceSlug}`) },
        image: media.map((item) => absoluteUrl(mediaUrl(item))),
        contentLocation: { "@type": "City", name: "Hamilton", containedInPlace: { "@type": "AdministrativeArea", name: "Ontario" } },
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Home", item: PUBLIC_SITE_URL },
          { "@type": "ListItem", position: 2, name: "Results", item: absoluteUrl("/results") },
          { "@type": "ListItem", position: 3, name: story.title, item: absoluteUrl(canonicalPath) },
        ],
      },
    ],
  };

  return (
    <>
      <StructuredData data={jsonLd} />
      <Container className="py-20 sm:py-28">
        <nav aria-label="Breadcrumb" className="text-sm text-ink-400"><ol className="flex flex-wrap items-center gap-2"><li><Link className="hover:text-accent-300" href="/">Home</Link></li><li aria-hidden="true">/</li><li><Link className="hover:text-accent-300" href="/results">Results</Link></li><li aria-hidden="true">/</li><li aria-current="page" className="text-ink-200">{story.title}</li></ol></nav>
        <header className="mt-9 max-w-4xl">
          <Link href={`/services/${story.serviceSlug}`} className="text-xs font-semibold uppercase tracking-[0.2em] text-accent-300 hover:text-accent-200">{story.serviceName} · Hamilton</Link>
          <h1 className="mt-5 font-display text-5xl leading-[1.02] tracking-[-0.03em] text-white sm:text-6xl">{story.title}</h1>
          <p className="mt-6 max-w-3xl text-lg leading-8 text-ink-200">{story.summary}</p>
        </header>

        {media.length > 0 && <section className="mt-12 grid gap-5 sm:grid-cols-2" aria-label="Customer-approved case study photos">{media.map((item) => <figure key={item.id} className={media.length === 1 ? "sm:col-span-2" : ""}>{/* eslint-disable-next-line @next/next/no-img-element */}<img src={mediaUrl(item)} alt={item.altText} width={1200} height={900} className="aspect-[4/3] w-full rounded-3xl border border-white/10 bg-ink-900 object-cover" /><figcaption className="mt-2 text-sm text-ink-500">{item.caption || `${item.role.charAt(0).toUpperCase()}${item.role.slice(1)} view`}</figcaption></figure>)}</section>}

        <div className="mt-16 grid gap-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="space-y-12">
            <StorySection title="The starting condition" body={story.challenge} />
            <StorySection title="What we did" body={story.process} />
            <StorySection title="The result and maintenance" body={story.outcome} />
          </div>
          <aside>
            <Card className="sticky top-28 border-accent-400/25">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent-300">Primary service</p>
              <h2 className="mt-3 font-display text-2xl text-white">{story.serviceName}</h2>
              <p className="mt-3 text-sm leading-6 text-ink-300">Every vehicle starts in a different condition. Review the service, then book or request a vehicle-specific quote.</p>
              <div className="mt-5 grid gap-2"><ButtonLink href={`/services/${story.serviceSlug}`}>Review the Service</ButtonLink><ButtonLink href={`/quote?service=${story.serviceSlug}`} variant="outline">Request a Quote</ButtonLink></div>
            </Card>
          </aside>
        </div>

        {related.length > 0 && <section className="mt-16 border-t border-white/10 pt-10"><h2 className="font-display text-3xl text-white">Related services</h2><div className="mt-5 flex flex-wrap gap-3">{related.map((service) => <Link key={service.id} href={`/services/${service.slug}`} className="rounded-full border border-white/15 px-4 py-2 text-sm text-ink-200 hover:border-accent-400 hover:text-accent-300">{service.name}</Link>)}</div></section>}
        <div className="mt-12 flex flex-wrap gap-3"><ButtonLink href="/book">Book Detailing</ButtonLink><ButtonLink href="/results" variant="outline">More Case Studies</ButtonLink></div>
      </Container>
    </>
  );
}

function StorySection({ title, body }: { title: string; body: string }) { return <section><h2 className="font-display text-3xl text-white">{title}</h2><p className="mt-4 whitespace-pre-line leading-8 text-ink-300">{body}</p></section>; }
function mediaUrl(item: { fileId: string; contentType: string; role: string }) { const extension = item.contentType === "image/png" ? "png" : item.contentType === "image/webp" ? "webp" : "jpg"; return `/media/results/${item.fileId}/${slugifySeoText(`hamilton-detailing-${item.role}`)}-${item.fileId}.${extension}`; }
