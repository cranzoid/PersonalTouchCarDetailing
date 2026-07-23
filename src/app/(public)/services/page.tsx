import Link from "next/link";
import { asc, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { Container, SectionHeading, Card, ButtonLink } from "@/components/ui";
import { formatCents } from "@/lib/money";

export const metadata = { title: "Services" };

export default async function ServicesPage() {
  const categories = await db()
    .select()
    .from(schema.serviceCategories)
    .where(eq(schema.serviceCategories.active, true))
    .orderBy(asc(schema.serviceCategories.sort));
  const services = await db()
    .select()
    .from(schema.services)
    .where(eq(schema.services.active, true))
    .orderBy(asc(schema.services.sort));

  return (
    <Container className="py-20 sm:py-28">
      <SectionHeading
        eyebrow="Service menu"
        title="Care designed around your vehicle"
        subtitle="Prices shown are starting points for a standard sedan — larger vehicles and heavier conditions are adjusted transparently during booking. Condition-dependent services are quoted after we see your vehicle or photos."
      />
      <div className="space-y-20">
        {categories.map((cat) => (
          <section key={cat.id} id={cat.slug} className="scroll-mt-24">
            <div className="flex flex-col gap-3 border-t border-white/10 pt-7 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <h2 className="font-display text-3xl text-white">{cat.name}</h2>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-ink-400">{cat.description}</p>
              </div>
              <span className="text-xs font-semibold uppercase tracking-[0.2em] text-accent-300">
                {services.filter((service) => service.categoryId === cat.id).length} options
              </span>
            </div>
            <div className="mt-7 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {services
                .filter((s) => s.categoryId === cat.id)
                .map((svc) => (
                  <Card key={svc.id} className="flex flex-col">
                    <h3 className="font-display text-2xl text-white">{svc.name}</h3>
                    <p className="mt-3 flex-1 text-sm leading-6 text-ink-300">{svc.shortDescription}</p>
                    <div className="mt-6 flex items-center justify-between border-t border-white/10 pt-4 text-sm">
                      <span className="text-accent-300">
                        {svc.basePriceCents !== null
                          ? `From ${formatCents(svc.basePriceCents)}`
                          : "By quote"}
                      </span>
                      <Link
                        href={`/services/${svc.slug}`}
                        className="font-semibold text-ink-200 hover:text-accent-300"
                      >
                        Details →
                      </Link>
                    </div>
                  </Card>
                ))}
            </div>
          </section>
        ))}
      </div>
      <div className="mt-20 flex flex-col items-start justify-between gap-6 rounded-[1.25rem] border border-accent-400/25 bg-accent-400/[0.055] p-7 sm:flex-row sm:items-center sm:p-10">
        <div>
          <h2 className="font-display text-3xl text-white">Not sure where to start?</h2>
          <p className="mt-2 text-sm text-ink-300">Book a package directly, or send photos for condition-dependent work.</p>
        </div>
        <div className="flex flex-wrap gap-3">
          <ButtonLink href="/book">Book an Appointment</ButtonLink>
          <ButtonLink href="/quote" variant="outline">Request a Quote</ButtonLink>
        </div>
      </div>
    </Container>
  );
}
