import Link from "next/link";
import { asc, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { Container, SectionHeading, Card, ButtonLink } from "@/components/ui";
import { formatCents, withTaxCents } from "@/lib/money";
import { getSettings } from "@/lib/settings";
import { pageMetadata, SEO_PAGES } from "@/lib/seo";
import {
  CERAMIC_COATING_HUB_PATH,
  CERAMIC_PROTECTION_PATH,
  isCeramicServiceSlug,
} from "@/lib/ceramic";

export const metadata = pageMetadata(SEO_PAGES.services);

/**
 * Categories whose own name links to a hand-written overview page, and the
 * guides offered underneath them. These pages compare options that a grid of
 * service cards cannot explain on its own — correction levels, and the
 * difference between ceramic protection and the ceramic coating packages.
 */
const CATEGORY_PAGE: Record<string, string> = {
  "paint-correction": "/services/paint-correction",
};

const CATEGORY_GUIDES: Record<string, { href: string; label: string }[]> = {
  "paint-correction": [{ href: "/services/paint-correction", label: "Compare correction levels" }],
  "paint-protection": [
    { href: CERAMIC_COATING_HUB_PATH, label: "Compare ceramic coating packages" },
    { href: CERAMIC_PROTECTION_PATH, label: "What ceramic protection covers" },
  ],
};

export default async function ServicesPage() {
  const settings = await getSettings();
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
        as="h1"
        eyebrow="Service menu"
        title={SEO_PAGES.services.h1}
        subtitle={`Prices shown are starting points for a standard sedan — larger vehicles and heavier conditions are adjusted transparently during booking. Condition-dependent services are quoted after we see your vehicle or photos. Listed prices are what you pay in cash or by Interac e-transfer; card and cheque add ${settings.taxLabel}.`}
      />
      <div className="space-y-20">
        {categories.map((cat) => (
          <section key={cat.id} id={cat.slug} className="scroll-mt-24">
            <div className="flex flex-col gap-3 border-t border-white/10 pt-7 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <h2 className="font-display text-3xl text-white">
                  {CATEGORY_PAGE[cat.slug] ? (
                    <Link className="hover:text-accent-300" href={CATEGORY_PAGE[cat.slug]}>{cat.name}</Link>
                  ) : cat.name}
                </h2>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-ink-400">{cat.description}</p>
                {(CATEGORY_GUIDES[cat.slug] ?? []).length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2">
                    {CATEGORY_GUIDES[cat.slug].map((guide) => (
                      <Link key={guide.href} className="text-sm font-semibold text-accent-300 hover:text-accent-200" href={guide.href}>
                        {guide.label} →
                      </Link>
                    ))}
                  </div>
                )}
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
                        {svc.basePriceCents !== null ? (
                          <>
                            From {formatCents(svc.basePriceCents)}
                            {/* Ceramic cards quote one figure. These prices are
                                read next to three other packages, and a second
                                number per card turns the comparison into noise.
                                The service page states the payment terms. */}
                            {settings.taxRateBp > 0 && !isCeramicServiceSlug(svc.slug) && (
                              <span className="block text-xs text-ink-500">
                                {formatCents(withTaxCents(svc.basePriceCents, settings.taxRateBp))} by
                                card or cheque
                              </span>
                            )}
                          </>
                        ) : (
                          "By quote"
                        )}
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
