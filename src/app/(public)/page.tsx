import Image from "next/image";
import Link from "next/link";
import { asc, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { Container, ButtonLink, SectionHeading, Card } from "@/components/ui";
import { formatCents } from "@/lib/money";
import { getSettings } from "@/lib/settings";

const EXPERIENCE_POINTS = [
  {
    number: "01",
    title: "Choose the right service",
    body: "Browse clearly structured services, pricing, and vehicle-size guidance before you book.",
  },
  {
    number: "02",
    title: "Stay informed",
    body: "Receive appointment details and review any additional work before it is approved.",
  },
  {
    number: "03",
    title: "Leave with clarity",
    body: "See an itemized invoice, payment history, and the details tied to your visit.",
  },
];

export default async function HomePage() {
  const [featured, categories, settings] = await Promise.all([
    db()
      .select()
      .from(schema.services)
      .where(eq(schema.services.featured, true))
      .orderBy(asc(schema.services.sort))
      .limit(3),
    db()
      .select()
      .from(schema.serviceCategories)
      .where(eq(schema.serviceCategories.active, true))
      .orderBy(asc(schema.serviceCategories.sort)),
    getSettings(),
  ]);

  return (
    <>
      <section className="relative isolate min-h-[calc(100svh-5rem)] overflow-hidden bg-ink-950">
        <Image
          src="/images/detailing-studio-hero.png"
          alt="A vehicle receiving careful detailing in a professional studio"
          fill
          priority
          sizes="100vw"
          className="object-cover object-[68%_center] sm:object-center"
        />
        <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(6,26,44,0.98)_0%,rgba(6,26,44,0.91)_37%,rgba(6,26,44,0.42)_68%,rgba(6,26,44,0.15)_100%)]" />
        <div className="absolute inset-0 bg-[linear-gradient(0deg,rgba(6,26,44,0.98)_0%,transparent_40%,rgba(6,26,44,0.1)_100%)]" />

        <Container className="relative flex min-h-[calc(100svh-5rem)] flex-col justify-center py-20 sm:py-24">
          <div className="max-w-3xl">
            <p className="mb-6 flex items-center gap-3 text-xs font-semibold uppercase tracking-[0.24em] text-accent-300">
              <span className="h-px w-10 bg-accent-400" aria-hidden="true" />
              Vehicle care in {settings.city}, {settings.province}
            </p>
            <h1 className="font-display text-5xl leading-[0.98] tracking-[-0.035em] text-white sm:text-7xl lg:text-[5.5rem]">
              Precision in every finish.
              <span className="mt-2 block text-ink-200">Care in every detail.</span>
            </h1>
            <p className="mt-7 max-w-xl text-base leading-7 text-ink-200 sm:text-lg sm:leading-8">
              Thoughtful interior and exterior detailing, correction, protection, tinting, and styling—with straightforward booking and clear communication throughout.
            </p>
            <div className="mt-9 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
              <ButtonLink href="/book" className="px-8 py-3.5 text-base">Book an Appointment</ButtonLink>
              <ButtonLink href="/quote" variant="outline" className="px-8 py-3.5 text-base">Request a Quote</ButtonLink>
            </div>
          </div>

          <div className="mt-16 grid max-w-4xl border-y border-white/15 bg-ink-950/30 backdrop-blur-sm sm:grid-cols-3">
            {[
              ["Online booking", "See live availability"],
              ["Photo estimates", "Share vehicle condition"],
              ["Approval controls", "Review added work first"],
            ].map(([title, detail], index) => (
              <div key={title} className={`px-5 py-5 ${index > 0 ? "border-t border-white/15 sm:border-l sm:border-t-0" : ""}`}>
                <p className="text-sm font-semibold text-white">{title}</p>
                <p className="mt-1 text-xs text-ink-400">{detail}</p>
              </div>
            ))}
          </div>
        </Container>
      </section>

      <section className="surface-light py-20 sm:py-28">
        <Container>
          <div className="grid gap-12 lg:grid-cols-[0.85fr_1.4fr] lg:gap-20">
            <SectionHeading
              eyebrow="Featured services"
              title="Care tailored to the vehicle in front of us"
              subtitle="Start with a service that fits your goal. Book directly where pricing is fixed, or request an estimate for condition-dependent work."
              tone="light"
            />
            <div className="grid gap-5 md:grid-cols-3 lg:grid-cols-1 xl:grid-cols-3">
              {featured.map((service, index) => (
                <Card key={service.id} tone="light" className="group flex min-h-64 flex-col overflow-hidden p-0 transition-transform duration-300 hover:-translate-y-1">
                  <div className="h-1 bg-ink-900 transition-colors group-hover:bg-accent-400" />
                  <div className="flex flex-1 flex-col p-6">
                    <p className="text-[0.65rem] font-semibold uppercase tracking-[0.2em] text-accent-600">Service {String(index + 1).padStart(2, "0")}</p>
                    <h2 className="mt-4 font-display text-2xl leading-tight text-[#1C2026]">{service.name}</h2>
                    <p className="mt-3 flex-1 text-sm leading-6 text-slate-600">{service.shortDescription}</p>
                    <div className="mt-6 flex items-end justify-between gap-4 border-t border-slate-200 pt-4">
                      <span className="text-sm font-semibold text-ink-900">
                        {service.basePriceCents !== null ? `From ${formatCents(service.basePriceCents)}` : "By quote"}
                      </span>
                      <Link href={`/services/${service.slug}`} className="rounded-md text-sm font-semibold text-ink-900 transition-colors hover:text-accent-600">
                        Explore <span aria-hidden="true">↗</span>
                      </Link>
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          </div>
          <div className="mt-12 text-center">
            <Link href="/services" className="inline-flex rounded-md border-b border-ink-900 pb-1 text-sm font-semibold text-ink-900 transition-colors hover:border-accent-500 hover:text-accent-600">
              View the complete service menu <span className="ml-2" aria-hidden="true">→</span>
            </Link>
          </div>
        </Container>
      </section>

      <section className="relative overflow-hidden bg-ink-900 py-20 sm:py-28">
        <div className="pointer-events-none absolute -right-40 top-0 size-[32rem] rounded-full border border-accent-400/10" />
        <div className="pointer-events-none absolute -right-24 top-16 size-[20rem] rounded-full border border-accent-400/10" />
        <Container className="relative">
          <SectionHeading
            eyebrow="Explore the studio"
            title="A complete approach to vehicle presentation and protection"
            subtitle="Choose a category to compare the services currently available."
          />
          <div className="grid gap-px overflow-hidden rounded-[1.25rem] border border-white/10 bg-white/10 sm:grid-cols-2 lg:grid-cols-3">
            {categories.map((category, index) => (
              <Link
                key={category.id}
                href={`/services#${category.slug}`}
                className="group min-h-52 bg-ink-900 p-7 transition-colors hover:bg-ink-800"
              >
                <div className="flex items-start justify-between gap-5">
                  <span className="text-xs font-semibold tracking-[0.18em] text-accent-400">{String(index + 1).padStart(2, "0")}</span>
                  <span aria-hidden="true" className="text-xl text-ink-500 transition-transform group-hover:translate-x-1 group-hover:text-accent-300">→</span>
                </div>
                <h3 className="mt-10 font-display text-2xl text-white">{category.name}</h3>
                <p className="mt-3 text-sm leading-6 text-ink-400">{category.description}</p>
              </Link>
            ))}
          </div>
        </Container>
      </section>

      <section className="bg-[#FFFEFB] py-20 text-[#1C2026] sm:py-28">
        <Container>
          <SectionHeading
            eyebrow="What to expect"
            title="A clear process from first click to final invoice"
            subtitle="The customer experience is designed to keep the work, timing, and price easy to understand."
            tone="light"
            align="center"
          />
          <div className="grid gap-10 md:grid-cols-3 md:gap-0">
            {EXPERIENCE_POINTS.map((point, index) => (
              <div key={point.number} className={`relative px-2 md:px-8 ${index > 0 ? "md:border-l md:border-slate-200" : ""}`}>
                <p className="font-display text-5xl text-accent-500/70">{point.number}</p>
                <h3 className="mt-5 text-lg font-semibold text-ink-900">{point.title}</h3>
                <p className="mt-3 text-sm leading-6 text-slate-600">{point.body}</p>
              </div>
            ))}
          </div>
        </Container>
      </section>

      <section className="surface-light pb-20 sm:pb-28">
        <Container>
          <div className="relative overflow-hidden rounded-[1.25rem] bg-ink-900 px-7 py-12 sm:px-12 sm:py-16 lg:px-16">
            <div className="absolute inset-y-0 right-0 hidden w-2/5 bg-[linear-gradient(135deg,transparent,rgba(224,169,59,0.12))] lg:block" />
            <div className="relative grid items-end gap-10 lg:grid-cols-[1.3fr_0.7fr]">
              <div className="max-w-2xl">
                <p className="text-xs font-semibold uppercase tracking-[0.22em] text-accent-300">Commercial vehicle care</p>
                <h2 className="mt-5 font-display text-4xl leading-tight text-white sm:text-5xl">A more organized way to care for a working fleet.</h2>
                <p className="mt-5 max-w-xl text-base leading-7 text-ink-300">
                  Explore recurring service options, fleet records, priority scheduling, and consolidated invoicing for commercial clients.
                </p>
              </div>
              <div className="lg:text-right">
                <ButtonLink href="/fleet">Explore Commercial Services</ButtonLink>
              </div>
            </div>
          </div>
        </Container>
      </section>

      <section className="relative overflow-hidden border-t border-white/10 bg-ink-950 py-24 text-center sm:py-32">
        <div className="hairline-gold absolute inset-x-0 top-0 h-px" />
        <Container>
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-accent-300">Your vehicle, thoughtfully cared for</p>
          <h2 className="mx-auto mt-5 max-w-3xl font-display text-5xl leading-[1.04] text-white sm:text-6xl">Ready for a cleaner, sharper finish?</h2>
          <p className="mx-auto mt-5 max-w-xl text-base leading-7 text-ink-300">Book a listed service online or share a few details for a personalized estimate.</p>
          <div className="mt-9 flex flex-col justify-center gap-3 sm:flex-row">
            <ButtonLink href="/book" className="px-8 text-base">Book an Appointment</ButtonLink>
            <ButtonLink href="/quote" variant="outline" className="px-8 text-base">Request a Quote</ButtonLink>
          </div>
        </Container>
      </section>
    </>
  );
}
