import { Container, SectionHeading, ButtonLink, Card } from "@/components/ui";

export const metadata = { title: "About" };

/**
 * Owner asked us to draft this copy (2026-07-19) and will adjust if needed.
 * The shop location has served Hamilton for over two decades under the
 * Personal Touch name; the business is under new ownership, so the copy
 * references the location's history without inheriting past guarantees.
 */
export default function AboutPage() {
  return (
    <>
      <Container className="py-20 sm:py-28">
        <div className="grid items-end gap-12 lg:grid-cols-[1.15fr_0.85fr]">
          <SectionHeading
            eyebrow="About Personal Touch"
            title="A familiar Hamilton name, thoughtfully renewed"
            subtitle="Under new ownership, we are pairing personal attention with a clear, modern service process—from the first quote to the final quality check."
          />
          <div className="border-l border-accent-400/60 pl-6 text-lg leading-8 text-ink-200">
            Every recommendation should be understandable. Every added service should be approved.
            Every vehicle should leave feeling genuinely cared for.
          </div>
        </div>

        <div className="mt-8 grid gap-6 lg:grid-cols-[1.35fr_0.65fr]">
          <div className="space-y-5 text-base leading-8 text-ink-300">
            <p>
              Personal Touch has been a familiar name for car care on Upper James Street for more
              than two decades. Today, under new ownership, we&apos;re carrying that name forward with
              a refreshed shop, modern products and close attention to every vehicle.
            </p>
            <p>
              We&apos;re a Hamilton detailing studio at Upper James and Dickenson Road. Our approach is
              practical: honest assessments, professional-grade products, and a process built around
              doing the job correctly—not rushing it through.
            </p>
            <p>
              From maintenance details to paint correction, ceramic coatings, window tinting and
              styling, our goal is simple: when you get your keys back, it should feel like a better
              car than the one you dropped off.
            </p>
          </div>
          <Card className="h-fit border-accent-400/25 bg-accent-400/[0.06]">
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-accent-300">Our standard</p>
            <ul className="mt-5 space-y-4 text-sm leading-6 text-ink-200">
              <li>Condition documented at check-in</li>
              <li>Additional work approved before it begins</li>
              <li>Quality control completed before pickup</li>
              <li>Clear service and payment history</li>
            </ul>
          </Card>
        </div>

        <div className="mt-12 flex flex-wrap gap-3">
          <ButtonLink href="/book">Book an Appointment</ButtonLink>
          <ButtonLink href="/contact" variant="outline">Talk With Our Team</ButtonLink>
        </div>
      </Container>

      <section className="surface-light py-20">
        <Container>
          <SectionHeading
            tone="light"
            eyebrow="The experience"
            title="Care you can follow from arrival to pickup"
          />
          <div className="grid gap-5 md:grid-cols-3">
            {[
              ["Inspect together", "We record the vehicle's condition and the areas that matter most to you."],
              ["Stay in control", "If we uncover extra work, you receive the details and price before deciding."],
              ["Leave with clarity", "Your completed work, payment and aftercare stay organized and easy to understand."],
            ].map(([title, body], index) => (
              <Card key={title} tone="light">
                <span className="text-xs font-semibold tracking-[0.2em] text-accent-600">0{index + 1}</span>
                <h2 className="mt-5 font-display text-2xl text-[#0B2A4A]">{title}</h2>
                <p className="mt-3 text-sm leading-6 text-slate-600">{body}</p>
              </Card>
            ))}
          </div>
        </Container>
      </section>
    </>
  );
}
