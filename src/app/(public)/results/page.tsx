import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { and, asc, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { ButtonLink, Container, SectionHeading } from "@/components/ui";
import { GoogleReviewStrip } from "@/components/public-sections";
import { db, schema } from "@/db";
import { getSettings } from "@/lib/settings";
import { pageMetadata, SEO_PAGES, slugifySeoText } from "@/lib/seo";

export const metadata = pageMetadata(SEO_PAGES.results);
export const dynamic = "force-dynamic";

export default async function ResultsPage() {
  const [stories, settings] = await Promise.all([db()
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
    .orderBy(desc(schema.caseStudies.publishedAt)), getSettings()]);

  // Nothing published yet means there is no Results page — not a Results page
  // explaining that there is nothing on it. The publishing workflow lives in
  // Admin → Results; the first published story opens this URL and the nav link
  // that points at it. See src/lib/results.ts.
  if (stories.length === 0) notFound();

  const media = await db()
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
    .orderBy(asc(schema.caseStudyMedia.sort));
  const covers = new Map<string, (typeof media)[number]>();
  for (const item of media) if (!covers.has(item.caseStudyId)) covers.set(item.caseStudyId, item);

  return (
    <>
      <section className="overflow-hidden bg-ink-950 py-20 sm:py-28">
        <Container>
          <div className="grid items-center gap-10 lg:grid-cols-[0.92fr_1.08fr]">
            <div>
              <SectionHeading as="h1" eyebrow="Documented Hamilton work" title={SEO_PAGES.results.h1} subtitle="Real vehicles, customer-approved media and an honest account of the work performed. No stock transformations and no one-size-fits-all promises." />
              <GoogleReviewStrip settings={settings} tone="dark" />
            </div>
            <div className="relative min-h-72 overflow-hidden rounded-[1.5rem] border border-white/10 sm:min-h-[28rem]">
              <Image src="/images/services/hand-wash.png" alt="A vehicle receiving a careful brush-free hand wash" fill priority sizes="(min-width: 1024px) 50vw, 100vw" className="object-cover" />
              <div className="absolute inset-0 bg-[linear-gradient(180deg,transparent_50%,rgba(6,26,44,0.82)_100%)]" />
              <p className="absolute bottom-6 left-6 right-6 text-sm font-semibold text-white">Every case study below is a real Hamilton vehicle, published with the customer&apos;s consent.</p>
            </div>
          </div>
        </Container>
      </section>

      <section className="surface-light py-20 text-ink-900 sm:py-28">
        <Container>
          <SectionHeading eyebrow="Published case studies" title="See the condition, process and outcome." subtitle="Every result below is connected to a genuine CRM job and separately approved for public use." tone="light" />

          <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
            {stories.map((story) => {
              const cover = covers.get(story.id);
              return (
                <article key={story.id} className="overflow-hidden rounded-3xl border border-[#DED8CE] bg-[#FFFEFB] shadow-[0_22px_55px_rgba(11,42,74,0.08)]">
                  {cover ? (
                    // Consent is rechecked at request time by the media route.
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={mediaUrl(cover)} alt={cover.altText} width={1200} height={900} loading="lazy" className="aspect-[4/3] w-full bg-ink-900 object-cover" />
                  ) : <div className="grid aspect-[4/3] place-items-center bg-[#F6F2EA] text-sm text-slate-500">Media consent withdrawn</div>}
                  <div className="p-6">
                    <Link href={`/services/${story.serviceSlug}`} className="text-xs font-semibold uppercase tracking-[0.16em] text-accent-600 hover:text-accent-500">{story.serviceName}</Link>
                    <h2 className="mt-3 font-display text-2xl leading-tight text-ink-900"><Link className="hover:text-accent-600" href={`/results/${story.slug}`}>{story.title}</Link></h2>
                    <p className="mt-3 line-clamp-4 text-sm leading-6 text-slate-600">{story.summary}</p>
                    <Link href={`/results/${story.slug}`} className="mt-5 inline-flex text-sm font-semibold text-accent-600 hover:text-accent-500">Read the case study →</Link>
                  </div>
                </article>
              );
            })}
          </div>

          <div className="mt-16 flex flex-col items-start justify-between gap-5 border-t border-[#DED8CE] pt-9 sm:flex-row sm:items-center">
            <div><h2 className="font-display text-2xl text-ink-900">Have a vehicle that needs the same level of care?</h2><p className="mt-1 text-sm text-slate-600">Choose a service or send photos for a condition-based quote.</p></div>
            <div className="flex flex-wrap gap-3"><ButtonLink href="/book">Book Detailing</ButtonLink><ButtonLink href="/quote" variant="outline" className="!border-ink-900/30 !text-ink-900 hover:!border-accent-500 hover:!text-accent-600">Request a Quote</ButtonLink></div>
          </div>
        </Container>
      </section>
    </>
  );
}

function mediaUrl(item: { fileId: string; contentType: string; role: string }) {
  const extension = item.contentType === "image/png" ? "png" : item.contentType === "image/webp" ? "webp" : "jpg";
  return `/media/results/${item.fileId}/${slugifySeoText(`hamilton-car-detailing-${item.role}`)}-${item.fileId}.${extension}`;
}
