import Link from "next/link";
import { and, asc, eq, inArray } from "drizzle-orm";
import { StructuredData } from "@/components/structured-data";
import { ButtonLink, Card, Container } from "@/components/ui";
import { db, schema } from "@/db";
import { hasPublishedResults } from "@/lib/results";
import { BUSINESS_ENTITY_ID, PUBLIC_SITE_URL, absoluteUrl, pageMetadata } from "@/lib/seo";

const definition = {
  title: "Paint Correction Hamilton, ON | Personal Touch",
  description:
    "Paint correction in Hamilton for swirls, oxidation and paint defects, from gloss enhancement to multi-stage correction. Request a condition-based quote.",
  path: "/services/paint-correction" as const,
  h1: "Paint correction in Hamilton",
};

export const metadata = pageMetadata(definition);

const CORRECTION_SLUGS = [
  "paint-enhancement",
  "one-stage-correction",
  "multi-stage-correction",
  "scratch-swirl-reduction",
];

const EXPLANATIONS: Record<string, string> = {
  "paint-enhancement": "A measured single-step polish intended to improve gloss and reduce lighter defects without promising full removal.",
  "one-stage-correction": "A balanced correction for vehicles with visible swirls and wash marks where a substantial improvement is the goal.",
  "multi-stage-correction": "A more intensive process for heavier defects, quoted only after the paint and available clear coat are assessed.",
  "scratch-swirl-reduction": "Focused work on specific defects where isolated correction is safer and more appropriate than treating every panel.",
};

export default async function PaintCorrectionPage() {
  const resultsPublished = await hasPublishedResults();
  const services = await db()
    .select({
      slug: schema.services.slug,
      name: schema.services.name,
      shortDescription: schema.services.shortDescription,
    })
    .from(schema.services)
    .where(and(eq(schema.services.active, true), inArray(schema.services.slug, CORRECTION_SLUGS)))
    .orderBy(asc(schema.services.sort));

  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Service",
        "@id": `${absoluteUrl(definition.path)}#service`,
        name: "Paint correction",
        description: definition.description,
        url: absoluteUrl(definition.path),
        provider: { "@id": BUSINESS_ENTITY_ID },
        areaServed: { "@type": "City", name: "Hamilton", containedInPlace: { "@type": "AdministrativeArea", name: "Ontario" } },
        hasOfferCatalog: {
          "@type": "OfferCatalog",
          name: "Paint correction options",
          itemListElement: services.map((service) => ({
            "@type": "Offer",
            itemOffered: {
              "@type": "Service",
              name: service.name,
              url: absoluteUrl(`/services/${service.slug}`),
            },
          })),
        },
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Home", item: PUBLIC_SITE_URL },
          { "@type": "ListItem", position: 2, name: "Services", item: absoluteUrl("/services") },
          { "@type": "ListItem", position: 3, name: "Paint correction", item: absoluteUrl(definition.path) },
        ],
      },
    ],
  };

  return (
    <>
      <StructuredData data={jsonLd} />
      <Container className="py-20 sm:py-28">
        <nav aria-label="Breadcrumb" className="text-sm text-ink-400">
          <ol className="flex items-center gap-2">
            <li><Link className="hover:text-accent-300" href="/">Home</Link></li>
            <li aria-hidden="true">/</li>
            <li><Link className="hover:text-accent-300" href="/services">Services</Link></li>
            <li aria-hidden="true">/</li>
            <li aria-current="page" className="text-ink-200">Paint correction</li>
          </ol>
        </nav>

        <div className="mt-8 max-w-3xl">
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-accent-300">Paint restoration</p>
          <h1 className="mt-5 font-display text-5xl leading-[1.02] tracking-[-0.03em] text-white sm:text-6xl">{definition.h1}</h1>
          <p className="mt-6 text-lg leading-8 text-ink-200">
            Paint correction uses measured machine polishing to reduce visible defects and improve gloss. Hamilton winter film, automatic washes and improper hand washing can all contribute to swirls, but the safe result depends on paint history, defect depth and remaining clear coat.
          </p>
          <p className="mt-5 leading-7 text-ink-300">
            We inspect before recommending a level of correction. Deep scratches, stone chips, failing clear coat and previous repairs cannot always be polished away safely, so the quote is based on the vehicle in front of us—not a universal removal percentage.
          </p>
        </div>

        <section className="mt-14" aria-labelledby="correction-options">
          <h2 id="correction-options" className="font-display text-3xl text-white">Choose the right correction approach</h2>
          <div className="mt-6 grid gap-5 md:grid-cols-2">
            {services.map((service) => (
              <Card key={service.slug} className="flex flex-col">
                <h3 className="font-display text-2xl text-white">{service.name}</h3>
                <p className="mt-3 flex-1 text-sm leading-6 text-ink-300">
                  {EXPLANATIONS[service.slug] ?? service.shortDescription}
                </p>
                <Link className="mt-5 text-sm font-semibold text-accent-300 hover:text-accent-200" href={`/services/${service.slug}`}>
                  Review this service →
                </Link>
              </Card>
            ))}
          </div>
        </section>

        <section className="mt-14 grid gap-5 md:grid-cols-2">
          <Card>
            <h2 className="font-display text-2xl text-white">What changes the outcome</h2>
            <p className="mt-3 text-sm leading-6 text-ink-300">Paint thickness, clear-coat condition, prior repairs, defect depth, panel material and the owner’s finish goals all affect what can be achieved responsibly.</p>
          </Card>
          <Card>
            <h2 className="font-display text-2xl text-white">Protecting corrected paint</h2>
            <p className="mt-3 text-sm leading-6 text-ink-300">Safe washing matters after correction. Depending on how the vehicle is used, a sealant, ceramic coating or paint protection film may form part of the maintenance plan.</p>
            <div className="mt-4 flex flex-wrap gap-3 text-sm">
              <Link className="text-accent-300 hover:text-accent-200" href="/services/ceramic-coating">Ceramic coating</Link>
              <Link className="text-accent-300 hover:text-accent-200" href="/services/paint-protection-film">Paint protection film</Link>
              {resultsPublished && <Link className="text-accent-300 hover:text-accent-200" href="/results">Real results</Link>}
            </div>
          </Card>
        </section>

        <div className="mt-12 flex flex-wrap gap-3">
          <ButtonLink href="/quote?service=paint-correction">Request a Paint Assessment</ButtonLink>
          <ButtonLink href="/services" variant="outline">Compare All Services</ButtonLink>
        </div>
      </Container>
    </>
  );
}
