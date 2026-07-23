import { Container, SectionHeading, ButtonLink } from "@/components/ui";
import { getSettings } from "@/lib/settings";

export const metadata = { title: "Reviews" };
export const dynamic = "force-dynamic";

/**
 * No fabricated testimonials. Real reviews will be surfaced here once
 * collected. Automated review requests are active; the Google review
 * destination remains owner-configurable in Admin → Settings.
 */
export default async function ReviewsPage() {
  const settings = await getSettings();
  return (
    <>
      <Container className="py-20 sm:py-28">
        <div className="grid gap-12 lg:grid-cols-[1.1fr_0.9fr] lg:items-end">
          <SectionHeading
            eyebrow="Customer feedback"
            title="The work should speak for itself"
            subtitle="We only publish feedback we can verify. Our review collection is growing as customers complete services under the new ownership."
          />
          <div className="rounded-[2rem] border border-accent-400/25 bg-accent-400/[0.06] p-7 sm:p-9">
            <p className="font-display text-2xl leading-9 text-white">
              Recently visited us? Your candid feedback helps us improve and helps Hamilton drivers choose with confidence.
            </p>
            <div className="mt-7 flex flex-wrap gap-3">
              {settings.googleReviewUrl && (
                <ButtonLink href={settings.googleReviewUrl}>Review us on Google</ButtonLink>
              )}
              <ButtonLink href="/contact" variant="outline">Send Feedback</ButtonLink>
            </div>
          </div>
        </div>
      </Container>

      <section className="surface-light py-20">
        <Container className="grid gap-8 lg:grid-cols-[0.8fr_1.2fr] lg:items-center">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-accent-600">Our commitment</p>
            <h2 className="mt-4 font-display text-4xl leading-tight text-[#0B2A4A]">No invented praise. No polished-up stories.</h2>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            {["Verified customer feedback", "Transparent service approvals", "Clear follow-up after every visit"].map((item) => (
              <div key={item} className="rounded-2xl border border-slate-200 bg-white p-5 text-sm font-semibold leading-6 text-[#1C2026] shadow-[0_12px_35px_rgba(11,42,74,0.06)]">
                {item}
              </div>
            ))}
          </div>
        </Container>
      </section>

      <Container className="py-20 text-center">
        <h2 className="font-display text-4xl text-white">Ready to form your own opinion?</h2>
        <p className="mx-auto mt-4 max-w-xl text-ink-300">Choose a package online, or request a tailored quote for condition-dependent work.</p>
        <div className="mt-7"><ButtonLink href="/book">Book an Appointment</ButtonLink></div>
      </Container>
    </>
  );
}
