import { Container, SectionHeading, ButtonLink } from "@/components/ui";

export const metadata = { title: "About" };

/**
 * NOTE: The business is under NEW OWNERSHIP. This copy deliberately avoids
 * historical claims (years in business, past staff, past guarantees) — see
 * BUILD.md §1. Owner-approved bio/history can replace the placeholders below.
 */
export default function AboutPage() {
  return (
    <Container className="py-16">
      <SectionHeading eyebrow="About us" title="Detailing done properly, right here in Hamilton" />
      <div className="max-w-2xl space-y-5 text-ink-300">
        <p>
          Personal Touch Car Detailing is a locally owned and operated detailing studio in
          Hamilton, Ontario. We care for every vehicle the way we&apos;d care for our own — with
          honest assessments, professional-grade products, and a process built around doing the
          job right rather than doing it fast.
        </p>
        <p>
          Every vehicle we take in is inspected with you at drop-off, photographed before and
          after, and quality-checked before pickup. If we find something that needs extra
          attention, we&apos;ll always ask before doing additional work — no surprises on your
          invoice.
        </p>
        <p>
          From maintenance details to multi-stage paint correction, ceramic coatings, window
          tinting and styling, our goal is simple: when you get your keys back, it should feel
          like a better car than the one you dropped off.
        </p>
      </div>
      <div className="mt-10 flex gap-3">
        <ButtonLink href="/book">Book an Appointment</ButtonLink>
        <ButtonLink href="/contact" variant="outline">Ask Us Anything</ButtonLink>
      </div>
    </Container>
  );
}
