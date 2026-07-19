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
    <Container className="py-16">
      <SectionHeading
        eyebrow="Services"
        title="Our services"
        subtitle="Prices shown are starting points for a standard sedan — larger vehicles and heavier conditions are adjusted transparently during booking. Condition-dependent services are quoted after we see your vehicle or photos."
      />
      <div className="space-y-16">
        {categories.map((cat) => (
          <section key={cat.id} id={cat.slug} className="scroll-mt-24">
            <h2 className="text-2xl font-bold text-white">{cat.name}</h2>
            <p className="mt-1 max-w-2xl text-sm text-ink-400">{cat.description}</p>
            <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {services
                .filter((s) => s.categoryId === cat.id)
                .map((svc) => (
                  <Card key={svc.id} className="flex flex-col">
                    <h3 className="font-semibold text-white">{svc.name}</h3>
                    <p className="mt-2 flex-1 text-sm text-ink-300">{svc.shortDescription}</p>
                    <div className="mt-4 flex items-center justify-between text-sm">
                      <span className="text-accent-300">
                        {svc.basePriceCents !== null
                          ? `From ${formatCents(svc.basePriceCents)}`
                          : "By quote"}
                      </span>
                      <Link
                        href={`/services/${svc.slug}`}
                        className="text-ink-300 hover:text-accent-300"
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
      <div className="mt-16 flex gap-3">
        <ButtonLink href="/book">Book an Appointment</ButtonLink>
        <ButtonLink href="/quote" variant="outline">Request a Quote</ButtonLink>
      </div>
    </Container>
  );
}
