import { ButtonLink, Container, SectionHeading } from "@/components/ui";
import { GoogleReviewCarousel, GoogleReviewStrip } from "@/components/public-sections";
import { getSettings } from "@/lib/settings";
import { pageMetadata, SEO_PAGES } from "@/lib/seo";

export const metadata = pageMetadata(SEO_PAGES.reviews);
export const dynamic = "force-dynamic";

export default async function ReviewsPage() {
  const settings = await getSettings();
  return (
    <>
      <section className="bg-ink-950 py-20 sm:py-28">
        <Container>
          <div className="grid gap-12 lg:grid-cols-[1.04fr_0.96fr] lg:items-end">
            <SectionHeading as="h1" eyebrow="Customer feedback" title={SEO_PAGES.reviews.h1} subtitle="See the current Google rating, read selected public excerpts, or open the complete listing for the newest customer feedback." />
            <div>
              <GoogleReviewStrip settings={settings} tone="dark" />
              <p className="mt-4 text-sm leading-6 text-ink-400">Rating and review count are editable in CRM settings so the website can stay current without a public API key.</p>
            </div>
          </div>
        </Container>
      </section>

      <GoogleReviewCarousel settings={settings} />

      <section className="bg-[#F6F2EA] py-20 text-ink-900 sm:py-28">
        <Container className="grid gap-8 lg:grid-cols-[0.8fr_1.2fr] lg:items-center">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-accent-600">Our commitment</p>
            <h2 className="mt-4 font-display text-4xl leading-tight text-ink-900">Verified public feedback, linked to its source.</h2>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            {["Public Google excerpts", "Direct link to the full listing", "Clear follow-up after every visit"].map((item) => (
              <div key={item} className="rounded-2xl border border-[#DED8CE] bg-[#FFFEFB] p-5 text-sm font-semibold leading-6 text-ink-900 shadow-[0_12px_35px_rgba(11,42,74,0.06)]">{item}</div>
            ))}
          </div>
        </Container>
      </section>

      <Container className="py-20 text-center sm:py-28">
        <h2 className="font-display text-4xl text-white sm:text-5xl">Ready to form your own opinion?</h2>
        <p className="mx-auto mt-4 max-w-xl text-base leading-7 text-ink-300">Choose a package online, or request a tailored quote for condition-dependent work.</p>
        <div className="mt-7 flex flex-wrap justify-center gap-3"><ButtonLink href="/book">Book an Appointment</ButtonLink><ButtonLink href={settings.googleReviewUrl} variant="outline">Review us on Google</ButtonLink></div>
      </Container>
    </>
  );
}
