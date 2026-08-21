import Link from "next/link";
import { and, asc, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { ButtonLink, Card, Container, SectionHeading } from "@/components/ui";
import { db, schema } from "@/db";
import { pageMetadata, SEO_PAGES, slugifySeoText } from "@/lib/seo";

export const metadata = pageMetadata(SEO_PAGES.results);
export const dynamic = "force-dynamic";

export default async function ResultsPage() {
  const stories = await db()
    .select({
      id: schema.caseStudies.id,
      slug: schema.caseStudies.slug,
      title: schema.caseStudies.title,
      summary: schema.caseStudies.summary,
      outcome: schema.caseStudies.outcome,
      publishedAt: schema.caseStudies.publishedAt,
      serviceName: schema.services.name,
      serviceSlug: schema.services.slug,
    })
    .from(schema.caseStudies)
    .innerJoin(schema.services, and(
      eq(schema.services.id, schema.caseStudies.primaryServiceId),
      eq(schema.services.active, true),
    ))
    .where(eq(schema.caseStudies.status, "published"))
    .orderBy(desc(schema.caseStudies.publishedAt));

  const media = stories.length > 0
    ? await db()
        .select({
          caseStudyId: schema.caseStudyMedia.caseStudyId,
          fileId: schema.caseStudyMedia.fileId,
          altText: schema.caseStudyMedia.altText,
          role: schema.caseStudyMedia.role,
          contentType: schema.files.contentType,
        })
        .from(schema.caseStudyMedia)
        .innerJoin(schema.files, and(eq(schema.files.id, schema.caseStudyMedia.fileId), isNotNull(schema.files.publicConsentAt)))
        .where(inArray(schema.caseStudyMedia.caseStudyId, stories.map((story) => story.id)))
        .orderBy(asc(schema.caseStudyMedia.sort))
    : [];
  const covers = new Map<string, (typeof media)[number]>();
  for (const item of media) if (!covers.has(item.caseStudyId)) covers.set(item.caseStudyId, item);

  return (
    <Container className="py-20 sm:py-28">
      <SectionHeading
        as="h1"
        eyebrow="Documented Hamilton work"
        title={SEO_PAGES.results.h1}
        subtitle="Each story is based on a genuine job and customer-approved media. We explain the starting condition, the work performed, realistic outcomes and practical maintenance—not a one-size-fits-all promise."
      />

      {stories.length > 0 ? (
        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {stories.map((story) => {
            const cover = covers.get(story.id);
            return (
              <article key={story.id} className="overflow-hidden rounded-3xl border border-white/10 bg-white/[0.035] shadow-[0_22px_55px_rgba(0,0,0,0.16)]">
                {cover ? (
                  // Consent is rechecked at request time by the media route.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={mediaUrl(cover)} alt={cover.altText} width={1200} height={900} loading="lazy" className="aspect-[4/3] w-full bg-ink-900 object-cover" />
                ) : <div className="grid aspect-[4/3] place-items-center bg-ink-900 text-sm text-ink-500">Media consent withdrawn</div>}
                <div className="p-6">
                  <Link href={`/services/${story.serviceSlug}`} className="text-xs font-semibold uppercase tracking-[0.16em] text-accent-300 hover:text-accent-200">{story.serviceName}</Link>
                  <h2 className="mt-3 font-display text-2xl leading-tight text-white"><Link className="hover:text-accent-200" href={`/results/${story.slug}`}>{story.title}</Link></h2>
                  <p className="mt-3 line-clamp-4 text-sm leading-6 text-ink-300">{story.summary}</p>
                  <Link href={`/results/${story.slug}`} className="mt-5 inline-flex text-sm font-semibold text-accent-300 hover:text-accent-200">Read the case study →</Link>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <Card className="max-w-3xl border-accent-400/25 bg-accent-400/[0.05] p-8 sm:p-10">
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-accent-300">Stories in preparation</p>
          <h2 className="mt-4 font-display text-3xl text-white">Genuine work comes before content volume.</h2>
          <p className="mt-4 max-w-2xl text-sm leading-7 text-ink-300">We publish only complete, consent-approved stories from real jobs. In the meantime, the gallery contains currently approved result photos.</p>
          <Link className="mt-5 inline-flex text-sm font-semibold text-accent-300" href="/gallery">View the gallery →</Link>
        </Card>
      )}

      <section className="mt-16 flex flex-col items-start justify-between gap-5 border-t border-white/10 pt-9 sm:flex-row sm:items-center">
        <div><h2 className="font-display text-2xl text-white">Have a vehicle that needs the same level of care?</h2><p className="mt-1 text-sm text-ink-400">Choose a service or send photos for a condition-based quote.</p></div>
        <div className="flex flex-wrap gap-3"><ButtonLink href="/book">Book Detailing</ButtonLink><ButtonLink href="/quote" variant="outline">Request a Quote</ButtonLink></div>
      </section>
    </Container>
  );
}

function mediaUrl(item: { fileId: string; contentType: string; role: string }) {
  const extension = item.contentType === "image/png" ? "png" : item.contentType === "image/webp" ? "webp" : "jpg";
  return `/media/results/${item.fileId}/${slugifySeoText(`hamilton-car-detailing-${item.role}`)}-${item.fileId}.${extension}`;
}
