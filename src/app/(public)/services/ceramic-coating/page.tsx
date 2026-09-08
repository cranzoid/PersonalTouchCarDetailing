import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import { ButtonLink, Card, Container } from "@/components/ui";
import { GoogleReviewStrip } from "@/components/public-sections";
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
  CERAMIC_OFFER_PATH,
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

  const [adjustments, bundleOffers] = await Promise.all([
    db()
      .select()
      .from(schema.serviceVehicleAdjustments)
      .where(inArray(schema.serviceVehicleAdjustments.serviceId, services.map((s) => s.id))),
    db()
      .select()
      .from(schema.serviceBundleOffers)
      .where(and(
        eq(schema.serviceBundleOffers.active, true),
        inArray(schema.serviceBundleOffers.primaryServiceId, services.map((s) => s.id)),
      )),
  ]);

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

  /** The opt-in extra this coating's bundle unlocks, straight from the rule. */
  function bundlePerkLabel(serviceId: string): string | null {
    return bundleOffers.find((offer) => offer.primaryServiceId === serviceId && offer.perkLabel)?.perkLabel ?? null;
  }
  const anyPerk = bundleOffers.some((offer) => offer.perkLabel);

  function bundlePercent(serviceId: string): number | null {
    const rates = bundleOffers
      .filter((offer) => offer.primaryServiceId === serviceId)
      .map((offer) => offer.discountPercentBp);
    return rates.length > 0 ? Math.max(...rates) : null;
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

      {/* The page used to be one unbroken navy column from the breadcrumb to
          the footer, so the packages — the thing the visitor came to compare —
          carried no more visual weight than the FAQ. It is now banded: a
          photographic hero, the offer in full accent, then the packages and
          prices on light ground where they read as the centrepiece. */}
      <section className="relative isolate overflow-hidden border-b border-white/10 bg-ink-950">
        <Image
          src="/images/services/ceramic-coating.png"
          alt="Ceramic coating being applied by hand to prepared vehicle paint"
          fill
          priority
          sizes="100vw"
          className="object-cover object-center opacity-40"
        />
        <div className="absolute inset-0 bg-[linear-gradient(100deg,rgba(6,26,44,0.97)_0%,rgba(6,26,44,0.88)_46%,rgba(6,26,44,0.42)_100%)]" />
        <Container className="relative py-16 sm:py-24">
          <nav aria-label="Breadcrumb" className="text-sm text-ink-300">
            <ol className="flex items-center gap-2">
              <li><Link className="hover:text-accent-300" href="/">Home</Link></li>
              <li aria-hidden="true">/</li>
              <li><Link className="hover:text-accent-300" href="/services">Services</Link></li>
              <li aria-hidden="true">/</li>
              <li aria-current="page" className="text-white">Ceramic coating</li>
            </ol>
          </nav>
          <div className="mt-10 max-w-3xl">
            <p className="text-xs font-bold uppercase tracking-[0.24em] text-accent-300">{definition.eyebrow}</p>
            <h1 className="mt-5 font-display text-5xl leading-[1.0] tracking-[-0.03em] text-white sm:text-6xl">{definition.h1}</h1>
            <p className="mt-6 text-lg leading-8 text-ink-200">{definition.introduction}</p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <ButtonLink href="#packages" className="px-8">Compare the Packages</ButtonLink>
              <ButtonLink href={CERAMIC_OFFER_PATH} variant="outline" className="px-8">See the Current Offer</ButtonLink>
            </div>
          </div>
          <GoogleReviewStrip settings={settings} tone="dark" className="mt-10 max-w-5xl" />
        </Container>
      </section>

      <Link href={CERAMIC_OFFER_PATH} className="group block bg-accent-400 text-ink-950">
        <Container className="flex flex-col gap-3 py-6 sm:flex-row sm:items-center sm:justify-between sm:gap-8">
          <span>
            <span className="text-[0.68rem] font-bold uppercase tracking-[0.2em]">Current ceramic offer</span>
            <span className="mt-1 block font-display text-2xl leading-tight sm:text-3xl">Save on the coating. Save again on a detail.</span>
            <span className="mt-1.5 block text-sm font-semibold text-ink-950/80">
              Pro is $100 off · Max is $150 off · add a detailing package for 50% off, or 15% with Crystal
            </span>
          </span>
          <span className="shrink-0 text-sm font-bold underline decoration-ink-950/40 underline-offset-4 transition group-hover:decoration-ink-950">
            See the offer →
          </span>
        </Container>
      </Link>

      <section id="packages" className="surface-light scroll-mt-24 py-20 text-ink-900 sm:py-28" aria-labelledby="packages-heading">
        <Container>
          {/* Ceramic protection is a different product at a very different
              price. Saying so up front is the whole reason this sits above the
              packages rather than in the FAQ. */}
          <div className="rounded-[1.5rem] border border-[#DED8CE] bg-white p-6 shadow-sm sm:flex sm:items-center sm:justify-between sm:gap-8 sm:p-7">
            <div>
              <h2 className="font-display text-2xl text-[#0B2A4A]">Looking for ceramic protection instead?</h2>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
                Ceramic protection is a single layer of ceramic protection, added to an Ultimate Detail or
                booked on its own. It is a different, lighter service — not one of the coating packages
                below.
              </p>
            </div>
            <Link className="mt-4 inline-flex shrink-0 font-bold text-[#0B2A4A] underline underline-offset-4 hover:text-accent-600 sm:mt-0" href={CERAMIC_PROTECTION_PATH}>
              See ceramic protection →
            </Link>
          </div>

          <div className="mt-14 max-w-3xl">
            <p className="text-xs font-bold uppercase tracking-[0.22em] text-accent-600">Choose your protection level</p>
            <h2 id="packages-heading" className="mt-4 font-display text-4xl leading-tight sm:text-5xl">Three coating packages.</h2>
            <p className="mt-4 text-base leading-7 text-slate-600">
              Prices shown are for a coupe or sedan, before {settings.taxLabel}. Larger vehicles are priced by
              category — the exact figure for your vehicle appears in the booking flow before you confirm.
            </p>
          </div>

          {/* The most popular package is lifted and outlined rather than just
              labelled: a badge alone reads as decoration beside two identical
              cards, and the point is to answer "which one?" at a glance. */}
          <div className="mt-10 grid items-stretch gap-5 lg:grid-cols-3">
            {packages.map(({ content, service }) => (
              <article
                key={content.slug}
                className={`relative flex flex-col rounded-[1.5rem] border bg-white p-6 shadow-[0_18px_50px_rgba(11,42,74,0.08)] sm:p-8 ${
                  content.mostPopular
                    ? "border-accent-500 ring-2 ring-accent-500 lg:-mt-5 lg:pb-10"
                    : "border-[#DED8CE]"
                }`}
              >
                {content.mostPopular && (
                  <span className="absolute -top-3 left-6 rounded-full bg-accent-400 px-3 py-1 text-[0.68rem] font-bold uppercase tracking-[0.14em] text-ink-950 shadow-sm">
                    Most popular
                  </span>
                )}
                <div className={`flex items-start justify-between gap-3 ${content.mostPopular ? "mt-3" : ""}`}>
                  <h3 className="font-display text-3xl text-[#0B2A4A]">{content.tier}</h3>
                  <span
                    className={`shrink-0 rounded-full border px-3 py-1 text-xs font-bold ${
                      content.warrantyYears === null
                        ? "border-[#DED8CE] text-slate-500"
                        : "border-accent-500/40 bg-accent-400/15 text-[#775A1C]"
                    }`}
                  >
                    {warrantyLabel(content.warrantyYears)}
                  </span>
                </div>
                <p className="mt-3 min-h-12 text-sm leading-6 text-slate-600">{content.tagline}</p>
                <div className="mt-6 flex flex-wrap items-end gap-x-3 gap-y-1">
                  {service.compareAtPriceCents !== null && (
                    <span className="pb-1 text-lg text-slate-400 line-through">{formatCents(service.compareAtPriceCents)}</span>
                  )}
                  <span className="font-display text-4xl text-ink-900">{formatCents(service.basePriceCents!)}</span>
                </div>
                {/* No duration: a coating is booked by date and sequenced by
                    hand, so "approx. 5h" answered a question the customer was
                    not being asked and read as a collection time. */}
                <p className="mt-1 text-xs text-slate-500">for a coupe or sedan, before {settings.taxLabel}</p>
                {service.compareAtPriceCents !== null && (
                  <p className="mt-3 inline-flex w-fit rounded-full bg-emerald-50 px-3 py-1 text-xs font-bold text-emerald-700 ring-1 ring-emerald-600/20">
                    Save {formatCents(service.compareAtPriceCents - service.basePriceCents!)}
                  </p>
                )}
                {bundlePercent(service.id) !== null && (
                  <div className="mt-5 rounded-xl bg-[#F4EFE4] p-4">
                    <p className="text-xs font-bold uppercase tracking-wider text-[#775A1C]">Add a detailing package</p>
                    <p className="mt-1 text-base font-bold leading-6 text-[#0B2A4A]">
                      Save {bundlePercent(service.id)! / 100}% on Ultimate, Signature or Interior Detail
                    </p>
                    {bundlePerkLabel(service.id) && (
                      <p className="mt-2 border-t border-[#E3D8BF] pt-2 text-sm font-bold text-emerald-700">
                        + {bundlePerkLabel(service.id)}, if you want it
                      </p>
                    )}
                  </div>
                )}
                <ul className="mt-6 flex-1 space-y-2 text-sm leading-6 text-slate-700">
                  {content.includes.map((item) => (
                    <li key={item} className="flex gap-2.5">
                      <span className="mt-2 size-1.5 shrink-0 rounded-full bg-accent-500" aria-hidden="true" />
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
                <div className="mt-7 flex flex-col gap-2">
                  <ButtonLink
                    href={`/book?service=${content.slug}`}
                    variant={content.mostPopular ? "primary" : "outline"}
                    className={content.mostPopular ? "" : "!border-[#0B2A4A]/25 !text-[#0B2A4A]"}
                  >
                    Book {content.tier}
                  </ButtonLink>
                  <Link className="text-center text-sm font-bold text-[#0B2A4A] hover:text-accent-600" href={`/services/${content.slug}`}>
                    Full {content.tier} details →
                  </Link>
                </div>
              </article>
            ))}
          </div>
        </Container>
      </section>

      <section className="bg-[#F6F2EA] py-20 text-ink-900 sm:py-28" aria-labelledby="pricing-heading">
        <Container>
          <div className="grid gap-10 lg:grid-cols-[0.78fr_1.22fr] lg:items-start">
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.22em] text-accent-600">Pricing by vehicle size</p>
              <h2 id="pricing-heading" className="mt-4 font-display text-4xl leading-tight">Size sets the price, not guesswork.</h2>
              <p className="mt-4 text-base leading-7 text-slate-600">
                Prices are before {settings.taxLabel}, which is added when you book. Commercial vehicles are quoted
                individually. The exact figure for your vehicle is shown before booking confirmation.
              </p>
              <div className="mt-8 rounded-[1.25rem] border border-[#DCD5CA] bg-white p-6">
                <h3 className="font-bold text-[#0B2A4A]">Before we start: paint condition</h3>
                <p className="mt-2 text-sm leading-6 text-slate-600">{CERAMIC_CONDITION_DISCLAIMER}</p>
                <p className="mt-3 text-sm leading-6 text-slate-600">
                  Paint correction is never folded into a coating price. If we think your paint needs{" "}
                  <Link className="font-semibold text-[#0B2A4A] underline underline-offset-2 hover:text-accent-600" href="/services/paint-correction">
                    enhancement or correction
                  </Link>
                  , we quote it separately and wait for your approval before starting.
                </p>
                {anyPerk && (
                  <p className="mt-3 text-sm leading-6 text-slate-600">
                    The free touch-up offered with a detailing bundle is chip touch-up using a colour-matched
                    pen you bring with you. It is not machine paint correction.
                  </p>
                )}
              </div>
            </div>
            <div className="overflow-x-auto rounded-[1.5rem] border border-[#DCD5CA] bg-white shadow-sm">
              <table className="w-full min-w-[34rem] text-sm">
                <caption className="sr-only">Ceramic coating package prices by vehicle category</caption>
                <thead>
                  <tr className="border-b border-[#E8E1D6] text-xs uppercase tracking-wider text-slate-500">
                    <th scope="col" className="p-5 text-left font-semibold">Vehicle</th>
                    {packages.map(({ content }) => (
                      <th key={content.slug} scope="col" className="p-5 text-right font-semibold">{content.tier}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#ECE7DE]">
                  {rows.map((row) => (
                    <tr key={row.label}>
                      <th scope="row" className="p-5 text-left font-semibold text-[#0B2A4A]">{row.label}</th>
                      {packages.map(({ content, service }) => (
                        <td key={content.slug} className="p-5 text-right">
                          {(() => {
                            const price = priceFor(service.id, service.basePriceCents!, row.category);
                            const compare = service.compareAtPriceCents === null
                              ? null
                              : priceFor(service.id, service.compareAtPriceCents, row.category);
                            return price === null
                              ? <span className="text-slate-500">By quote</span>
                              : (
                                <span>
                                  {compare !== null && (
                                    <span className="mr-2 text-xs text-slate-400 line-through">{formatCents(compare)}</span>
                                  )}
                                  <span className="font-bold text-[#0B2A4A]">{formatCents(price)}</span>
                                </span>
                              );
                          })()}
                        </td>
                      ))}
                    </tr>
                  ))}
                  <tr>
                    <th scope="row" className="p-5 text-left font-semibold text-[#0B2A4A]">Warranty</th>
                    {packages.map(({ content }) => (
                      <td key={content.slug} className="p-5 text-right text-slate-600">
                        {content.warrantyYears === null ? "—" : `${content.warrantyYears} years`}
                      </td>
                    ))}
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </Container>
      </section>

      <section className="bg-ink-950 py-20 sm:py-28" aria-labelledby="process-heading">
        <Container>
          <div className="max-w-3xl">
            <p className="text-xs font-bold uppercase tracking-[0.22em] text-accent-300">How the work runs</p>
            <h2 id="process-heading" className="mt-4 font-display text-4xl leading-tight text-white">From drop-off to cured paint.</h2>
          </div>
          <ol className="mt-10 grid gap-5 md:grid-cols-3">
            {definition.process.map((step, index) => (
              <li key={step.title} className="rounded-2xl border border-white/10 bg-white/[0.04] p-6">
                <span className="text-sm font-bold text-accent-300">0{index + 1}</span>
                <h3 className="mt-4 font-display text-2xl text-white">{step.title}</h3>
                <p className="mt-3 text-sm leading-6 text-ink-300">{step.body}</p>
              </li>
            ))}
          </ol>

          <div className="mt-12 grid gap-5 md:grid-cols-2">
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
          </div>

          <section className="mt-16" aria-labelledby="faq-heading">
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

          <section className="mt-16" aria-labelledby="related-heading">
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

          <div className="mt-14 flex flex-wrap gap-3">
            <ButtonLink href="/book">Book a Coating Package</ButtonLink>
            <ButtonLink href="/quote?service=ceramic-coating-crystal" variant="outline">Ask a Question</ButtonLink>
          </div>
        </Container>
      </section>
    </>
  );
}
