import { Container, SectionHeading, ButtonLink } from "@/components/ui";

export const metadata = { title: "Reviews" };

/**
 * No fabricated testimonials. Real reviews will be surfaced here once
 * collected (review-request automation is planned in Phase 5); a Google
 * Business Profile embed/link can be configured by the owner.
 */
export default function ReviewsPage() {
  return (
    <Container className="py-16">
      <SectionHeading
        eyebrow="Reviews"
        title="What our customers say"
        subtitle="We're collecting reviews from recent customers and will feature them here. In the meantime, you can find us on Google."
      />
      <div className="max-w-xl rounded-2xl border border-ink-700 bg-ink-900/50 p-8">
        <p className="text-ink-300">
          Recently visited us? We&apos;d love your feedback — it helps other Hamilton drivers find
          detailing they can trust.
        </p>
        <div className="mt-6 flex gap-3">
          <ButtonLink href="/contact" variant="outline">Share Feedback</ButtonLink>
          <ButtonLink href="/book">Book an Appointment</ButtonLink>
        </div>
      </div>
    </Container>
  );
}
