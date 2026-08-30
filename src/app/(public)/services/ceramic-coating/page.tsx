import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import { ButtonLink, Card, Container } from "@/components/ui";
import { GoogleReviewStrip, ServiceImage } from "@/components/public-sections";
import { StructuredData } from "@/components/structured-data";
import { formatCents } from "@/lib/money";
import { hasPublishedResults } from "@/lib/results";
import { getSettings } from "@/lib/settings";
import { BUSINESS_ENTITY_ID, PUBLIC_SITE_URL, absoluteUrl, pageMetadata } from "@/lib/seo";
import { SERVICE_SEO } from "@/lib/service-seo";
import {
  VEHICLE_CATEGORIES,
  VEHICLE_CATEGORY_LABELS,
  isQuoteOnlyVehicleCategory,
  type VehicleCategory,
} from "@/lib/types";
import {
  CERAMIC_COATING_SLUGS,
  CERAMIC_CONDITION_DISCLAIMER,
  CERAMIC_PROTECTION_PATH,
  COATING_PACKAGES,
  warrantyLabel,
} from "@/lib/ceramic";

/**
 * Hand-written hub for the three ceramic coating packages.
 *
 * A static route, so it takes precedence over /services/[slug]: the catalogue
 * no longer holds a service called "ceramic-coating" — Crystal, Pro and Max
 * are the sellable things — and this page is what that URL should now show.
 *
 * Prices are read from the catalogue on every request, never hard-coded here,
 * so editing a price in Admin → Services moves this page too.
 */
const definition = SERVICE_SEO["ceramic-coating"];

export const metadata = pageMetadata(definition);

export default async function CeramicCoatingPage() {
  const [settings, resultsPublished] = await Promise.all([getSettings(), hasPublishedResults()]);

  const services = await db()
    .select()
    .from(schema.services)
    .where(and(
      eq(schema.services.active, true),
      inArray(schema.services.slug, [...CERAMIC_COATING_SLUGS]),
    ));
  // Every package deactivated is a catalogue state, not a broken URL, but
  // there is then nothing to compare — 404 rather than show an empty page.
  if (services.length === 0) notFound();

  const adjustments = await db()
    .select()
    .from(schema.serviceVehicleAdjustments)
    .where(inArray(schema.serviceVehicleAdjustments.serviceId, services.map((s) => s.id)));

  /** Packages in Crystal → Pro → Max order, each with its catalogue row. */
  const packages = COATING_PACKAGES.flatMap((content) => {
    const service = services.find((s) => s.slug === content.slug);
    return service ? [{ content, service }] : [];
  });

  /**
   * The listed, tax-exclusive price. Null for a category we refuse to put a
   * number against — a commercial vehicle is quoted, never priced from a sedan
   * plus a delta.
   */
  function priceFor(serviceId: string, base: number, category: VehicleCategory | null): number | null {
    if (!category) return base;
    if (isQuoteOnlyVehicleCategory(category)) return null;
    const adj = adjustments.find((a) => a.serviceId === serviceId && a.vehicleCategory === category);
    return base + (adj?.priceDeltaCents ?? 0);
  }

  /**
   * Category rows for the comparison table: the base row first, then every
   * category any package actually adjusts, in the canonical order. Derived
   * rather than assumed, so a category priced differently later still appears.
   */
  const adjustedCategories = VEHICLE_CATEGORIES.filter((category) =>
    adjustments.some((a) => a.vehicleCategory === category),
  );
  const rows: { label: string; category: VehicleCategory | null }[] = [
    { label: "Coupe / Sedan", category: null },
    ...adjustedCategories.map((category) => ({ label: VEHICLE_CATEGORY_LABELS[category], category })),
  ];

  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Service",
        "@id": `${absoluteUrl(definition.path)}#service`,
        name: "Ceramic coating",
        description: definition.description,
        url: absoluteUrl(definition.path),
        provider: { "@id": BUSINESS_ENTITY_ID },
        areaServed: { "@type": "City", name: "Hamilton", containedInPlace: { "@type": "AdministrativeArea", name: "Ontario" } },
        hasOfferCatalog: {
          "@type": "OfferCatalog",
          name: "Ceramic coating packages",
          itemListElement: packages.map(({ content, service }) => ({
            "@type": "Offer",
            priceCurrency: settings.currency,
            price: (service.basePriceCents! / 100).toFixed(2),
            url: absoluteUrl(`/services/${content.slug}`),
            itemOffered: {
              "@type": "Service",
              name: service.name,
              url: absoluteUrl(`/services/${content.slug}`),
            },
          })),
        },
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Home", item: PUBLIC_SITE_URL },
          { "@type": "ListItem", position: 2, name: "Services", item: absoluteUrl("/services") },
          { "@type": "ListItem", position: 3, name: "Ceramic coating", item: absoluteUrl(definition.path) },
        ],
      },
      {
        "@type": "FAQPage",
        mainEntity: definition.faqs.map((faq) => ({
          "@type": "Question",
          name: faq.question,
          acceptedAnswer: { "@type": "Answer", text: faq.answer },
        })),
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
            <li aria-current="page" className="text-ink-200">Ceramic coating</li>
          </ol>
        </nav>

        <div className="mt-8 max-w-3xl">
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-accent-300">{definition.eyebrow}</p>
          <h1 className="mt-5 font-display text-5xl leading-[1.02] tracking-[-0.03em] text-white sm:text-6xl">{definition.h1}</h1>
          <p className="mt-6 text-lg leading-8 text-ink-200">{definition.introduction}</p>
        </div>
        <div className="group mt-9 max-w-5xl overflow-hidden rounded-[1.5rem] border border-white/10">
          <ServiceImage slug="ceramic-coating-crystal" name="Ceramic coating" priority className="aspect-[16/8]" />
        </div>
        <GoogleReviewStrip settings={settings} tone="dark" className="mt-5 max-w-5xl" />

        {/* Ceramic protection is a different product at a very different
            price. Saying so up front is the whole reason this sits above the
            packages rather than in the FAQ. */}
        <Card className="mt-10 max-w-3xl border-accent-400/25">
          <h2 className="font-display text-2xl text-white">Looking for ceramic protection instead?</h2>
          <p className="mt-3 text-sm leading-6 text-ink-300">
            Ceramic protection is a single layer of ceramic protection, added to an Ultimate Detail or
            booked on its own. It is a different, lighter service — not one of the coating packages
            below.
          </p>
          <Link className="mt-4 inline-flex text-sm font-semibold text-accent-300 hover:text-accent-200" href={CERAMIC_PROTECTION_PATH}>
            See ceramic protection →
          </Link>
        </Card>

        <section className="mt-14" aria-labelledby="packages-heading">
          <h2 id="packages-heading" className="font-display text-3xl text-white">Three coating packages</h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-ink-400">
            Prices shown are for a coupe or sedan, before {settings.taxLabel}. Larger vehicles are priced by
            category — the exact figure for your vehicle appears in the booking flow before you confirm.
          </p>
          {/* The most popular package is lifted and outlined rather than just
              labelled: a badge alone reads as decoration beside two identical
              cards, and the point is to answer "which one?" at a glance. */}
          <div className="mt-6 grid items-start gap-5 lg:grid-cols-3">
            {packages.map(({ content, service }) => (
              <Card
                key={content.slug}
                className={`relative flex flex-col ${
                  content.mostPopular
                    ? "border-accent-400/60 bg-accent-400/[0.07] shadow-[0_22px_60px_rgba(224,169,59,0.14)] lg:-mt-4 lg:pb-8"
                    : ""
                }`}
              >
                {content.mostPopular && (
                  <span className="absolute -top-3 left-6 rounded-full bg-accent-400 px-3 py-1 text-[0.68rem] font-bold uppercase tracking-[0.14em] text-ink-950">
                    Most popular
                  </span>
                )}
                <div className={`flex items-start justify-between gap-3 ${content.mostPopular ? "mt-3" : ""}`}>
                  <h3 className="font-display text-2xl text-white">{content.tier}</h3>
                  <span
                    className={`shrink-0 rounded-full border px-3 py-1 text-xs font-semibold ${
                      content.warrantyYears === null
                        ? "border-white/15 text-ink-400"
                        : "border-accent-400/30 bg-accent-400/10 text-accent-200"
                    }`}
                  >
                    {warrantyLabel(content.warrantyYears)}
                  </span>
                </div>
                <p className="mt-3 text-sm leading-6 text-ink-300">{content.tagline}</p>
                <p className="mt-5 font-display text-4xl text-white">
                  {formatCents(service.basePriceCents!)}
                </p>
                <p className="mt-1 text-xs text-ink-500">
                  for a coupe or sedan, before {settings.taxLabel} · approx. {formatDuration(service.baseDurationMin)}
                </p>
                <ul className="mt-5 flex-1 space-y-2 text-sm leading-6 text-ink-300">
                  {content.includes.map((item) => <li key={item}>• {item}</li>)}
                </ul>
                <div className="mt-6 flex flex-col gap-2">
                  <ButtonLink href={`/book?service=${content.slug}`} variant={content.mostPopular ? "primary" : "outline"}>
                    Book {content.tier}
                  </ButtonLink>
                  <Link className="text-center text-sm font-semibold text-ink-200 hover:text-accent-300" href={`/services/${content.slug}`}>
                    Full {content.tier} details →
                  </Link>
                </div>
              </Card>
            ))}
          </div>
        </section>

        <section className="mt-14" aria-labelledby="pricing-heading">
          <h2 id="pricing-heading" className="font-display text-3xl text-white">Pricing by vehicle size</h2>
          <div className="mt-5 overflow-x-auto">
            <table className="w-full min-w-[34rem] text-sm">
              <caption className="sr-only">Ceramic coating package prices by vehicle category</caption>
              <thead>
                <tr className="border-b border-white/10 text-xs uppercase tracking-wider text-ink-500">
                  <th scope="col" className="py-2 text-left font-medium">Vehicle</th>
                  {packages.map(({ content }) => (
                    <th key={content.slug} scope="col" className="py-2 text-right font-medium">{content.tier}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.label} className="border-b border-white/10">
                    <th scope="row" className="py-2 text-left font-normal text-ink-300">{row.label}</th>
                    {packages.map(({ content, service }) => (
                      <td key={content.slug} className="py-2 text-right text-accent-300">
                        {(() => {
                          const price = priceFor(service.id, service.basePriceCents!, row.category);
                          return price === null ? <span className="text-ink-400">By quote</span> : formatCents(price);
                        })()}
                      </td>
                    ))}
                  </tr>
                ))}
                <tr>
                  <th scope="row" className="py-2 text-left font-normal text-ink-300">Warranty</th>
                  {packages.map(({ content }) => (
                    <td key={content.slug} className="py-2 text-right text-ink-300">
                      {content.warrantyYears === null ? "—" : `${content.warrantyYears} years`}
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-ink-500">
            Prices are before {settings.taxLabel}, which is added when you book. Commercial vehicles are quoted
            individually. The exact figure for your vehicle is shown before booking confirmation.
          </p>
        </section>

        <Card className="mt-12 border-accent-500/30">
          <h2 className="font-semibold text-accent-300">Before we start: paint condition</h2>
          <p className="mt-2 text-sm leading-6 text-ink-300">{CERAMIC_CONDITION_DISCLAIMER}</p>
          <p className="mt-3 text-sm leading-6 text-ink-400">
            Paint correction is never folded into a coating price. If we think your paint needs{" "}
            <Link className="text-accent-300 hover:text-accent-200" href="/services/paint-correction">
              enhancement or correction
            </Link>
            , we quote it separately and wait for your approval before starting.
          </p>
        </Card>

        <section className="mt-14" aria-labelledby="process-heading">
          <h2 id="process-heading" className="font-display text-3xl text-white">How the work runs</h2>
          <ol className="mt-5 grid gap-4 md:grid-cols-3">
            {definition.process.map((step, index) => (
              <li key={step.title} className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
                <span className="text-xs font-semibold uppercase tracking-wider text-accent-300">Step {index + 1}</span>
                <h3 className="mt-2 font-semibold text-white">{step.title}</h3>
                <p className="mt-2 text-sm leading-6 text-ink-300">{step.body}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="mt-14 grid gap-5 md:grid-cols-2">
          <Card>
            <h2 className="font-display text-2xl text-white">Who a coating suits</h2>
            <ul className="mt-4 space-y-2 text-sm leading-6 text-ink-300">
              {definition.idealFor.map((item) => <li key={item}>• {item}</li>)}
            </ul>
          </Card>
          <Card>
            <h2 className="font-display text-2xl text-white">Curing and aftercare</h2>
            <p className="mt-4 text-sm leading-6 text-ink-300">{definition.aftercare}</p>
          </Card>
        </section>

        <section className="mt-14" aria-labelledby="faq-heading">
          <h2 id="faq-heading" className="font-display text-3xl text-white">Frequently asked questions</h2>
          <div className="mt-5 space-y-3">
            {definition.faqs.map((faq) => (
              <details key={faq.question} className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
                <summary className="cursor-pointer font-semibold text-white">{faq.question}</summary>
                <p className="mt-3 max-w-3xl text-sm leading-6 text-ink-300">{faq.answer}</p>
              </details>
            ))}
          </div>
        </section>

        <section className="mt-14" aria-labelledby="related-heading">
          <h2 id="related-heading" className="font-display text-3xl text-white">Related Hamilton vehicle-care services</h2>
          <div className="mt-5 flex flex-wrap gap-3">
            {definition.relatedServices.map((service) => (
              <Link key={service.slug} href={`/services/${service.slug}`} className="rounded-full border border-white/15 px-4 py-2 text-sm text-ink-200 transition hover:border-accent-400 hover:text-accent-300">
                {service.label}
              </Link>
            ))}
            {resultsPublished && <Link href="/results" className="rounded-full border border-white/15 px-4 py-2 text-sm text-ink-200 transition hover:border-accent-400 hover:text-accent-300">View real results</Link>}
          </div>
        </section>

        <div className="mt-12 flex flex-wrap gap-3">
          <ButtonLink href="/book">Book a Coating Package</ButtonLink>
          <ButtonLink href="/quote?service=ceramic-coating-crystal" variant="outline">Ask a Question</ButtonLink>
        </div>
      </Container>
    </>
  );
}

function formatDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const remaining = minutes % 60;
  return [hours ? `${hours}h` : "", remaining ? `${remaining}m` : ""].filter(Boolean).join(" ");
}
