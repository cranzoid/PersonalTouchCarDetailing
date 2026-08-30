import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { ButtonLink, Card, Container } from "@/components/ui";
import { GoogleReviewStrip, ServiceImage } from "@/components/public-sections";
import { StructuredData } from "@/components/structured-data";
import { formatCents, withTaxCents } from "@/lib/money";
import { getSettings } from "@/lib/settings";
import { BUSINESS_ENTITY_ID, PUBLIC_SITE_URL, absoluteUrl, pageMetadata } from "@/lib/seo";
import { SERVICE_SEO } from "@/lib/service-seo";
import { VEHICLE_CATEGORIES, VEHICLE_CATEGORY_LABELS, type VehicleCategory } from "@/lib/types";
import {
  CERAMIC_COATING_HUB_PATH,
  CERAMIC_PROTECTION_ADDON_SLUG,
  CERAMIC_PROTECTION_SLUG,
  ULTIMATE_DETAIL_LABEL,
  ULTIMATE_DETAIL_SLUG,
} from "@/lib/ceramic";

/**
 * Hand-written page for ceramic protection — ONE layer of ceramic protection,
 * and deliberately never presented as a ceramic coating package.
 *
 * A static route, so it takes precedence over /services/[slug] for the
 * standalone service. It exists because the product has two prices with a
 * condition attached to the cheaper one, and the generic service template has
 * nowhere to put that condition beside the number.
 *
 * Both prices come from the catalogue on every request: the standalone service
 * row and the Ultimate Detail add-on row, each with its vehicle adjustments.
 */
const definition = SERVICE_SEO["ceramic-protection"];

export const metadata = pageMetadata(definition);

export default async function CeramicProtectionPage() {
  const settings = await getSettings();

  const [standalone] = await db()
    .select()
    .from(schema.services)
    .where(eq(schema.services.slug, CERAMIC_PROTECTION_SLUG))
    .limit(1);
  const [addon] = await db()
    .select()
    .from(schema.addons)
    .where(eq(schema.addons.slug, CERAMIC_PROTECTION_ADDON_SLUG))
    .limit(1);
  const [ultimateDetail] = await db()
    .select()
    .from(schema.services)
    .where(eq(schema.services.slug, ULTIMATE_DETAIL_SLUG))
    .limit(1);

  if (!standalone?.active || standalone.basePriceCents === null) notFound();

  const serviceAdjustments = await db()
    .select()
    .from(schema.serviceVehicleAdjustments)
    .where(eq(schema.serviceVehicleAdjustments.serviceId, standalone.id));
  const addonAdjustments = addon
    ? await db()
        .select()
        .from(schema.addonVehicleAdjustments)
        .where(eq(schema.addonVehicleAdjustments.addonId, addon.id))
    : [];

  /**
   * The offer exists only while the add-on is actually linked to Ultimate
   * Detail, because that link is what priceBooking checks. If the owner
   * unlinks or deactivates either side, this page stops advertising a price
   * the booking flow would refuse rather than promising one it cannot honour.
   */
  const addonLinked = addon && ultimateDetail
    ? (
        await db()
          .select({ id: schema.serviceAddons.id })
          .from(schema.serviceAddons)
          .where(and(
            eq(schema.serviceAddons.addonId, addon.id),
            eq(schema.serviceAddons.serviceId, ultimateDetail.id),
          ))
          .limit(1)
      ).length > 0
    : false;
  const offerAvailable = !!addon && addon.active && !!ultimateDetail?.active && addonLinked;

  const standalonePrice = (category: VehicleCategory | null) => withTaxCents(
    standalone.basePriceCents! +
    (category
      ? serviceAdjustments.find((a) => a.vehicleCategory === category)?.priceDeltaCents ?? 0
      : 0),
    settings.taxRateBp,
  );
  const addonPrice = (category: VehicleCategory | null) => withTaxCents(
    (addon?.priceCents ?? 0) +
    (category
      ? addonAdjustments.find((a) => a.vehicleCategory === category)?.priceDeltaCents ?? 0
      : 0),
    settings.taxRateBp,
  );

  // Base row plus every category either price actually adjusts, in canonical
  // order — derived rather than assumed, so a later price change still shows.
  const adjustedCategories = VEHICLE_CATEGORIES.filter(
    (category) =>
      serviceAdjustments.some((a) => a.vehicleCategory === category) ||
      addonAdjustments.some((a) => a.vehicleCategory === category),
  );
  const rows: { label: string; category: VehicleCategory | null }[] = [
    { label: "Coupe / Sedan", category: null },
    ...adjustedCategories.map((category) => ({ label: VEHICLE_CATEGORY_LABELS[category], category })),
  ];

  const addonBookUrl = `/book?service=${ULTIMATE_DETAIL_SLUG}&addon=${CERAMIC_PROTECTION_ADDON_SLUG}`;
  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Service",
        "@id": `${absoluteUrl(definition.path)}#service`,
        name: "Ceramic protection",
        description: definition.description,
        url: absoluteUrl(definition.path),
        provider: { "@id": BUSINESS_ENTITY_ID },
        areaServed: { "@type": "City", name: "Hamilton", containedInPlace: { "@type": "AdministrativeArea", name: "Ontario" } },
        // The standalone price is the one a visitor can buy unconditionally,
        // so it is the one advertised in structured data. The add-on price
        // depends on another purchase and would be misleading here.
        offers: {
          "@type": "Offer",
          priceCurrency: settings.currency,
          price: (withTaxCents(standalone.basePriceCents!, settings.taxRateBp) / 100).toFixed(2),
          url: absoluteUrl(`/book?service=${CERAMIC_PROTECTION_SLUG}`),
        },
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Home", item: PUBLIC_SITE_URL },
          { "@type": "ListItem", position: 2, name: "Services", item: absoluteUrl("/services") },
          { "@type": "ListItem", position: 3, name: "Ceramic protection", item: absoluteUrl(definition.path) },
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
            <li aria-current="page" className="text-ink-200">Ceramic protection</li>
          </ol>
        </nav>

        <div className="mt-8 max-w-3xl">
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-accent-300">{definition.eyebrow}</p>
          <h1 className="mt-5 font-display text-5xl leading-[1.02] tracking-[-0.03em] text-white sm:text-6xl">{definition.h1}</h1>
          <p className="mt-6 text-lg leading-8 text-ink-200">{definition.introduction}</p>
        </div>
        <div className="group mt-9 max-w-5xl overflow-hidden rounded-[1.5rem] border border-white/10">
          <ServiceImage slug="ceramic-protection" name="Ceramic protection" priority className="aspect-[16/8]" />
        </div>
        <GoogleReviewStrip settings={settings} tone="dark" className="mt-5 max-w-5xl" />

        <section className="mt-12" aria-labelledby="ways-heading">
          <h2 id="ways-heading" className="font-display text-3xl text-white">Two ways to buy it</h2>
          <div className="mt-6 grid gap-5 md:grid-cols-2">
            {offerAvailable && (
              <Card className="flex flex-col border-accent-400/25">
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-accent-300">
                  Added to an {ULTIMATE_DETAIL_LABEL}
                </p>
                <p className="mt-4 font-display text-5xl text-white">
                  {formatCents(addonPrice(null))}
                  <span aria-hidden="true" className="align-super text-2xl text-accent-300">*</span>
                </p>
                {/* The asterisk is answered immediately, in the same card. The
                    price is never allowed to travel without this sentence. */}
                <p className="mt-3 text-sm leading-6 text-ink-300">
                  <span aria-hidden="true">*</span> Available at this price when added to an{" "}
                  {ULTIMATE_DETAIL_LABEL}. Shown for a coupe or sedan; larger vehicles are{" "}
                  {formatCents(addonPrice("suv_large"))}.
                </p>
                <p className="mt-3 flex-1 text-sm leading-6 text-ink-400">
                  Your vehicle is already washed and prepared as part of the detail, so the layer goes
                  on at the point it works best — and costs less than booking it on its own.
                </p>
                <ButtonLink className="mt-6" href={addonBookUrl}>
                  Add to Your {ULTIMATE_DETAIL_LABEL}
                </ButtonLink>
              </Card>
            )}
            <Card className="flex flex-col">
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-accent-300">On its own</p>
              <p className="mt-4 font-display text-5xl text-white">{formatCents(standalonePrice(null))}</p>
              <p className="mt-3 text-sm leading-6 text-ink-300">
                For a coupe or sedan; larger vehicles are {formatCents(standalonePrice("suv_large"))}.
              </p>
              <p className="mt-3 flex-1 text-sm leading-6 text-ink-400">
                Booked without a detailing package. The preparation has to be done from scratch, which
                is why the standalone price is higher than the add-on.
              </p>
              <ButtonLink className="mt-6" href={`/book?service=${CERAMIC_PROTECTION_SLUG}`}>
                Book Ceramic Protection
              </ButtonLink>
            </Card>
          </div>
        </section>

        <section className="mt-14" aria-labelledby="pricing-heading">
          <h2 id="pricing-heading" className="font-display text-3xl text-white">Pricing by vehicle size</h2>
          <div className="mt-5 overflow-x-auto">
            <table className="w-full min-w-[30rem] max-w-2xl text-sm">
              <caption className="sr-only">Ceramic protection prices by vehicle category</caption>
              <thead>
                <tr className="border-b border-white/10 text-xs uppercase tracking-wider text-ink-500">
                  <th scope="col" className="py-2 text-left font-medium">Vehicle</th>
                  {offerAvailable && (
                    <th scope="col" className="py-2 text-right font-medium">
                      With an {ULTIMATE_DETAIL_LABEL}
                    </th>
                  )}
                  <th scope="col" className="py-2 text-right font-medium">Standalone</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.label} className="border-b border-white/10">
                    <th scope="row" className="py-2 text-left font-normal text-ink-300">{row.label}</th>
                    {offerAvailable && (
                      <td className="py-2 text-right text-accent-300">{formatCents(addonPrice(row.category))}</td>
                    )}
                    <td className="py-2 text-right text-accent-300">{formatCents(standalonePrice(row.category))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-ink-500">
            {offerAvailable && (
              <>
                The {ULTIMATE_DETAIL_LABEL} column applies only when ceramic protection is added to an{" "}
                {ULTIMATE_DETAIL_LABEL} booking; the package itself is priced separately.{" "}
              </>
            )}
            Prices include {settings.taxLabel}. The exact figure for your vehicle is shown before booking confirmation.
          </p>
        </section>

        {/* The single most important distinction on the site: this is not a
            ceramic coating, and the $120 figure is not a coating price. */}
        <Card className="mt-12 border-accent-500/30">
          <h2 className="font-semibold text-accent-300">Ceramic protection is not a ceramic coating</h2>
          <p className="mt-2 text-sm leading-6 text-ink-300">
            Ceramic protection is a single layer of ceramic protection. Our ceramic coating packages —
            Crystal, Pro and Max — are a separate, more involved service with dedicated preparation, a
            considerably longer service life, and a warranty on Pro and Max. If you want multi-year
            protection, compare the coating packages instead.
          </p>
          <Link className="mt-4 inline-flex text-sm font-semibold text-accent-300 hover:text-accent-200" href={CERAMIC_COATING_HUB_PATH}>
            Compare ceramic coating packages →
          </Link>
        </Card>

        <section className="mt-14" aria-labelledby="benefits-heading">
          <h2 id="benefits-heading" className="font-display text-3xl text-white">What ceramic protection does</h2>
          <div className="mt-5 grid gap-4 md:grid-cols-3">
            {definition.benefits.map((benefit) => (
              <Card key={benefit.title} className="p-5">
                <h3 className="font-semibold text-white">{benefit.title}</h3>
                <p className="mt-2 text-sm leading-6 text-ink-300">{benefit.body}</p>
              </Card>
            ))}
          </div>
        </section>

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
            <h2 className="font-display text-2xl text-white">Who it is a good fit for</h2>
            <ul className="mt-4 space-y-2 text-sm leading-6 text-ink-300">
              {definition.idealFor.map((item) => <li key={item}>• {item}</li>)}
            </ul>
          </Card>
          <Card>
            <h2 className="font-display text-2xl text-white">Aftercare</h2>
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
            <Link href="/results" className="rounded-full border border-white/15 px-4 py-2 text-sm text-ink-200 transition hover:border-accent-400 hover:text-accent-300">View real results</Link>
          </div>
        </section>

        <div className="mt-12 flex flex-wrap gap-3">
          <ButtonLink href={`/book?service=${CERAMIC_PROTECTION_SLUG}`}>Book Ceramic Protection</ButtonLink>
          <ButtonLink href={`/quote?service=${CERAMIC_PROTECTION_SLUG}`} variant="outline">Ask a Question</ButtonLink>
        </div>
      </Container>
    </>
  );
}
