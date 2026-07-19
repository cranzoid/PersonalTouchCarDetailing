import { Container, SectionHeading, ButtonLink } from "@/components/ui";

export const metadata = { title: "Gallery" };

/**
 * Gallery placeholder. Real before/after photos are published ONLY from jobs
 * whose photos carry explicit public-use consent (files.public_consent_at) —
 * a consent-gated gallery feed is planned in Phase 3.
 */
export default function GalleryPage() {
  return (
    <Container className="py-16">
      <SectionHeading
        eyebrow="Our work"
        title="Before & after gallery"
        subtitle="We're building our gallery with real results from real customer vehicles — published only with each customer's consent."
      />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="flex aspect-[4/3] items-center justify-center rounded-2xl border border-dashed border-ink-700 bg-ink-900/40"
          >
            <p className="px-6 text-center text-sm text-ink-500">
              Before &amp; after photos coming soon
            </p>
          </div>
        ))}
      </div>
      <div className="mt-12 text-center">
        <p className="mb-4 text-ink-300">Want your car to be our next transformation?</p>
        <ButtonLink href="/book">Book an Appointment</ButtonLink>
      </div>
    </Container>
  );
}
