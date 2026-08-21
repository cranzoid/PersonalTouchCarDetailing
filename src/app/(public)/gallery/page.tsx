import { desc, isNotNull } from "drizzle-orm";
import { Container, SectionHeading, ButtonLink, Card } from "@/components/ui";
import { db, schema } from "@/db";
import { pageMetadata, SEO_PAGES, slugifySeoText } from "@/lib/seo";

export const metadata = pageMetadata(SEO_PAGES.gallery);

/**
 * Consent-gated gallery. The image route repeats the consent check, so a file
 * cannot be exposed by guessing its id after consent is revoked.
 */
export const dynamic = "force-dynamic";

export default async function GalleryPage() {
  const photos = await db()
    .select()
    .from(schema.files)
    .where(isNotNull(schema.files.publicConsentAt))
    .orderBy(desc(schema.files.createdAt))
    .limit(24);
  return (
    <Container className="py-20 sm:py-28">
      <SectionHeading
        as="h1"
        eyebrow="Documented results"
        title={SEO_PAGES.gallery.h1}
        subtitle="Our gallery is built from customer-approved job photos. Consent is separate from service, private by default, and can be withdrawn."
      />
      {photos.length > 0 ? (
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {photos.map((photo) => {
            const label = photo.kind.replaceAll("_", " ");
            const extension = photo.contentType === "image/png" ? "png" : photo.contentType === "image/webp" ? "webp" : "jpg";
            const filename = `${slugifySeoText(`hamilton-car-detailing-${label}`)}-${photo.id}.${extension}`;
            return (
              <figure key={photo.id}>
                {/* Consent is rechecked by the public media route on every request. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`/media/results/${photo.id}/${filename}`}
                  alt={`Customer-approved ${label} photo from a car detailing job in Hamilton`}
                  loading="lazy"
                  width={1200}
                  height={900}
                  className="aspect-[4/3] w-full rounded-2xl border border-white/10 bg-ink-900 object-cover shadow-[0_18px_48px_rgba(0,0,0,0.18)]"
                />
                <figcaption className="mt-2 text-xs capitalize text-ink-500">Customer-approved {label} photo</figcaption>
              </figure>
            );
          })}
        </div>
      ) : (
        <Card className="max-w-3xl border-accent-400/25 bg-accent-400/[0.05] p-8 sm:p-10">
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-accent-300">Gallery in progress</p>
          <h2 className="mt-4 font-display text-3xl text-white">Privacy comes before a full gallery.</h2>
          <p className="mt-4 max-w-2xl text-sm leading-7 text-ink-300">
            We only publish vehicle photos after the customer gives separate, recorded permission.
            Our approved before-and-after collection is being prepared as completed jobs earn that consent.
          </p>
        </Card>
      )}
      <div className="mt-14 flex flex-col items-start justify-between gap-5 border-t border-white/10 pt-8 sm:flex-row sm:items-center">
        <div>
          <p className="font-display text-2xl text-white">Your vehicle, carefully transformed.</p>
          <p className="mt-1 text-sm text-ink-400">Book a transparent, documented detailing experience.</p>
        </div>
        <ButtonLink href="/book">Book an Appointment</ButtonLink>
      </div>
    </Container>
  );
}
