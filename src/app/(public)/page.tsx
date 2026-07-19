import Link from "next/link";
import { asc, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { Container, ButtonLink, SectionHeading, Card } from "@/components/ui";
import { formatCents } from "@/lib/money";

export default async function HomePage() {
  const featured = await db()
    .select()
    .from(schema.services)
    .where(eq(schema.services.featured, true))
    .orderBy(asc(schema.services.sort))
    .limit(3);
  const categories = await db()
    .select()
    .from(schema.serviceCategories)
    .where(eq(schema.serviceCategories.active, true))
    .orderBy(asc(schema.serviceCategories.sort));

  return (
    <>
      {/* Hero */}
      <section className="relative overflow-hidden">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,rgba(246,185,59,0.12),transparent_55%)]" />
        <Container className="relative py-24 sm:py-32">
          <p className="mb-4 text-sm font-semibold uppercase tracking-widest text-accent-400">
            Hamilton, Ontario
          </p>
          <h1 className="max-w-3xl text-4xl font-bold leading-tight tracking-tight text-white sm:text-6xl">
            Detailing that treats your car with a{" "}
            <span className="text-accent-400">personal touch</span>.
          </h1>
          <p className="mt-6 max-w-2xl text-lg text-ink-300">
            Interior and exterior detailing, paint correction, ceramic coating, window tinting and
            vehicle styling — delivered with meticulous care and honest, up-front pricing.
          </p>
          <div className="mt-10 flex flex-wrap gap-3">
            <ButtonLink href="/book" className="px-7 py-4 text-base">Book an Appointment</ButtonLink>
            <ButtonLink href="/quote" variant="outline" className="px-7 py-4 text-base">
              Request a Quote
            </ButtonLink>
            <ButtonLink href="/services" variant="ghost" className="px-4 py-4 text-base">
              View Services →
            </ButtonLink>
          </div>
          <div className="mt-14 grid max-w-3xl grid-cols-1 gap-4 sm:grid-cols-3">
            {[
              ["Book online in minutes", "Real-time availability, instant confirmation."],
              ["Condition-honest quotes", "Photo-based estimates for correction & coating work."],
              ["Locally owned & operated", "Serving Hamilton and the surrounding area."],
            ].map(([title, body]) => (
              <div key={title} className="rounded-xl border border-ink-800 bg-ink-900/40 p-4">
                <p className="text-sm font-semibold text-white">{title}</p>
                <p className="mt-1 text-xs text-ink-400">{body}</p>
              </div>
            ))}
          </div>
        </Container>
      </section>

      {/* Featured services */}
      <section className="border-t border-ink-800/60 py-20">
        <Container>
          <SectionHeading
            eyebrow="Popular services"
            title="Detailing packages built around your vehicle"
            subtitle="Transparent pricing that adjusts to your vehicle's size and condition."
          />
          <div className="grid gap-6 md:grid-cols-3">
            {featured.map((svc) => (
              <Card key={svc.id} className="flex flex-col">
                <h3 className="text-lg font-semibold text-white">{svc.name}</h3>
                <p className="mt-2 flex-1 text-sm text-ink-300">{svc.shortDescription}</p>
                <div className="mt-4 flex items-center justify-between">
                  <span className="text-accent-300">
                    {svc.basePriceCents !== null ? `From ${formatCents(svc.basePriceCents)}` : "By quote"}
                  </span>
                  <Link href={`/services/${svc.slug}`} className="text-sm text-ink-300 hover:text-accent-300">
                    Details →
                  </Link>
                </div>
              </Card>
            ))}
          </div>
        </Container>
      </section>

      {/* Categories */}
      <section className="py-20">
        <Container>
          <SectionHeading eyebrow="Everything we do" title="From maintenance washes to full transformations" />
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {categories.map((cat) => (
              <Link
                key={cat.id}
                href={`/services#${cat.slug}`}
                className="group rounded-2xl border border-ink-800 bg-ink-900/30 p-6 transition-colors hover:border-accent-500/50"
              >
                <h3 className="font-semibold text-white group-hover:text-accent-300">{cat.name}</h3>
                <p className="mt-2 text-sm text-ink-400">{cat.description}</p>
              </Link>
            ))}
          </div>
        </Container>
      </section>

      {/* How it works */}
      <section className="border-t border-ink-800/60 py-20">
        <Container>
          <SectionHeading eyebrow="How it works" title="Three simple steps" />
          <div className="grid gap-6 md:grid-cols-3">
            {[
              ["1. Book or request a quote", "Pick a service and time online, or send photos for condition-dependent work like correction and coating."],
              ["2. We detail with care", "Your vehicle is checked in, inspected with you, and any extra work is only done with your approval."],
              ["3. Drive away impressed", "Quality-checked, photographed, and backed by clear aftercare guidance."],
            ].map(([title, body]) => (
              <div key={title}>
                <h3 className="font-semibold text-accent-300">{title}</h3>
                <p className="mt-2 text-sm text-ink-300">{body}</p>
              </div>
            ))}
          </div>
        </Container>
      </section>

      {/* Fleet strip */}
      <section className="py-20">
        <Container>
          <div className="rounded-3xl border border-ink-700 bg-gradient-to-br from-ink-900 to-ink-800 p-10 sm:p-14">
            <div className="max-w-2xl">
              <h2 className="text-2xl font-bold text-white sm:text-3xl">
                Fleet, dealership or rideshare?
              </h2>
              <p className="mt-3 text-ink-300">
                Recurring programs, priority scheduling and consolidated billing for commercial
                clients across Hamilton.
              </p>
              <div className="mt-6">
                <ButtonLink href="/fleet">Explore Commercial Services</ButtonLink>
              </div>
            </div>
          </div>
        </Container>
      </section>

      {/* Final CTA */}
      <section className="border-t border-ink-800/60 py-24 text-center">
        <Container>
          <h2 className="text-3xl font-bold text-white sm:text-4xl">Ready when you are.</h2>
          <p className="mx-auto mt-3 max-w-xl text-ink-300">
            Book online in minutes, or send us photos for a personalized quote.
          </p>
          <div className="mt-8 flex justify-center gap-3">
            <ButtonLink href="/book" className="px-7 py-4 text-base">Book an Appointment</ButtonLink>
            <ButtonLink href="/quote" variant="outline" className="px-7 py-4 text-base">
              Request a Quote
            </ButtonLink>
          </div>
        </Container>
      </section>
    </>
  );
}
