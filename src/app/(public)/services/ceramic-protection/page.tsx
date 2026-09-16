import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { ButtonLink, Container } from "@/components/ui";
import { GoogleReviewStrip, ServiceImage } from "@/components/public-sections";
import { StructuredData } from "@/components/structured-data";
import { CeramicEnquiry } from "./enquiry";
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
  const [settings, resultsPublished] = await Promise.all([getSettings(), hasPublishedResults()]);

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

  // Listed, tax-exclusive prices. Null for a category we refuse to put a number
  // against — a commercial vehicle is quoted, never priced as a sedan plus a
  // delta. See QUOTE_ONLY_VEHICLE_CATEGORIES.
  const standalonePrice = (category: VehicleCategory | null): number | null => {
    if (category && isQuoteOnlyVehicleCategory(category)) return null;
    return standalone.basePriceCents! +
      (category
        ? serviceAdjustments.find((a) => a.vehicleCategory === category)?.priceDeltaCents ?? 0
        : 0);
  };
  const addonPrice = (category: VehicleCategory | null): number | null => {
    if (category && isQuoteOnlyVehicleCategory(category)) return null;
    return (addon?.priceCents ?? 0) +
      (category
        ? addonAdjustments.find((a) => a.vehicleCategory === category)?.priceDeltaCents ?? 0
        : 0);
  };
  const vehiclePrices = VEHICLE_CATEGORIES.map((category) => ({
    category,
    label: VEHICLE_CATEGORY_LABELS[category],
    priceCents: standalonePrice(category),
  }));
  const price = (cents: number) => formatCents(cents, settings.currency).replace(/\.00$/, "");
  const faqs = [
    { question: `What does the ${price(standalone.basePriceCents)} starting price include?`, answer: `For a coupe or sedan, the standalone service includes washing and drying the paint, one layer of ceramic protection applied by hand, and initial setting before collection. No detailing package purchase is required. Prices are before ${settings.taxLabel}.` },
    { question: "Is this a multi-year ceramic coating?", answer: "This service applies a single layer of ceramic protection for water beading and easier washing. Our Crystal, Pro and Max ceramic coating packages are separate services with more preparation and longer protection; Pro and Max include warranties. No multi-year warranty is included with this service." },
    { question: "Will it remove scratches or swirl marks?", answer: "Ceramic protection adds a protective layer; it does not correct scratches or swirl marks. If your paint needs extra preparation or correction, we discuss the work and price with you before it begins." },
    { question: "What happens after I request a callback?", answer: "We contact you about your vehicle, confirm the appropriate price and discuss available appointments. A callback request does not reserve a time or require payment. You can also book online if you are ready to choose an appointment." },
    { question: "How long does the protection last?", answer: "Durability depends on your vehicle, exposure and wash routine. We will explain the protection and suitable aftercare for your vehicle before you book. This service is not sold with a multi-year protection promise." },
    { question: "How should I look after it?", answer: definition.aftercare },
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
          price: (standalone.basePriceCents! / 100).toFixed(2),
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
        mainEntity: faqs.map((faq) => ({
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
      <div className="pb-24 md:pb-0">
        <section className="relative overflow-hidden bg-[#0B2A4A]" aria-labelledby="ceramic-title">
          <Container className="relative py-8 sm:py-12 lg:py-16">
            <nav aria-label="Breadcrumb" className="mb-7 text-xs text-ink-300">
              <Link href="/services" className="hover:text-white">Services</Link><span aria-hidden="true"> / </span><span>Ceramic protection</span>
            </nav>
            <div className="grid items-start gap-8 lg:grid-cols-[1.12fr_0.88fr] lg:gap-14">
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.2em] text-accent-300">Hamilton, Ontario · {settings.yearsInBusinessLabel} of car care</p>
                <h1 id="ceramic-title" className="mt-4 text-[2.65rem] font-extrabold leading-[1.08] tracking-[-0.045em] text-white sm:text-6xl">
                  Ceramic protection.<br />
                  <span className="text-accent-300">From {price(standalone.basePriceCents)}.</span>
                </h1>
                <p className="mt-3 text-sm font-semibold text-ink-200">Coupe / sedan · {settings.currency} · before {settings.taxLabel}</p>
                <p className="mt-5 max-w-xl text-lg leading-7 text-ink-100">Water that beads. Easier washes. A freshly protected finish.</p>
                <p className="mt-3 max-w-xl text-sm leading-6 text-ink-300">One layer of ceramic protection, applied by hand to clean paint. Wash and preparation included. No detailing package required.</p>
                <div className="mt-6 flex flex-wrap gap-3">
                  <ButtonLink href="#ceramic-enquiry">Get my price &amp; availability →</ButtonLink>
                  <a href={`tel:${settings.phone}`} className="inline-flex min-h-12 items-center px-2 text-sm font-semibold text-white">Call {settings.phone}</a>
                </div>
                <p className="mt-3 text-xs leading-5 text-ink-300">Single-layer protection. Multi-year ceramic coating packages are a separate service.</p>
                <div className="group relative mt-7 hidden overflow-hidden rounded-2xl border border-white/15 lg:block">
                  <ServiceImage slug="ceramic-protection" name="Ceramic protection application" priority className="aspect-[16/8]" />
                  <p className="absolute bottom-4 left-5 text-xs font-semibold text-white">Clean paint. Careful application. Personal touch.</p>
                </div>
              </div>
              <CeramicEnquiry serviceId={standalone.id} vehiclePrices={vehiclePrices} taxLabel={settings.taxLabel} currency={settings.currency} phone={settings.phone} bookable={standalone.bookingMode === "bookable"} />
            </div>
            <GoogleReviewStrip settings={settings} tone="dark" className="mt-8" />
          </Container>
        </section>

        <section className="bg-[#F8F5EE] py-12 text-[#1C2026] sm:py-16" aria-labelledby="included-heading">
          <Container>
            <div className="grid items-start gap-8 lg:grid-cols-[0.8fr_1.2fr] lg:gap-16">
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.2em] text-[#80570F]">A straightforward service</p>
                <h2 id="included-heading" className="mt-3 text-3xl font-bold leading-tight tracking-tight sm:text-4xl">Everyday protection.<br />Without the guesswork.</h2>
                <p className="mt-4 text-base leading-7 text-slate-600">For drivers who want water beading and easier maintenance, with a clear price before booking.</p>
                <p className="mt-4 text-sm leading-6 text-slate-600">Paint correction and condition-dependent extra preparation are quoted separately and approved by you before work begins.</p>
                {resultsPublished && <Link href="/results" className="mt-5 inline-flex min-h-11 items-center font-semibold text-[#0B2A4A] underline underline-offset-4">See our customer vehicles →</Link>}
              </div>
              <ol className="grid gap-4 sm:grid-cols-3">
                {definition.process.map((step, index) => (
                  <li key={step.title} className="rounded-2xl border border-[#DED8CE] bg-white p-5">
                    <span className="flex size-10 items-center justify-center rounded-full bg-[#F7EACA] text-sm font-bold text-[#0B2A4A]">0{index + 1}</span>
                    <h3 className="mt-5 text-lg font-bold text-[#0B2A4A]">{step.title}</h3>
                    <p className="mt-3 text-sm leading-6 text-slate-600">{step.body}</p>
                  </li>
                ))}
              </ol>
            </div>
          </Container>
        </section>

        <section className="bg-white py-12 text-[#1C2026] sm:py-16" aria-labelledby="pricing-heading">
          <Container>
            <div className="grid gap-8 lg:grid-cols-2 lg:gap-16">
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.2em] text-[#80570F]">Your vehicle. Your price.</p>
                <h2 id="pricing-heading" className="mt-3 text-3xl font-bold tracking-tight">Ceramic protection on its own</h2>
                <p className="mt-3 text-sm leading-6 text-slate-600">No package purchase needed. Prices in {settings.currency}, before {settings.taxLabel}. Your vehicle category and any extra preparation are confirmed before booking.</p>
                <dl className="mt-5 divide-y divide-[#DED8CE]">
                  {vehiclePrices.map((row) => (
                    <div key={row.category} className="flex items-center justify-between gap-4 py-3 text-sm">
                      <dt>{row.label}</dt><dd className="shrink-0 font-bold text-[#0B2A4A]">{row.priceCents === null ? "By quote" : price(row.priceCents)}</dd>
                    </div>
                  ))}
                </dl>
              </div>
              <div className="space-y-5">
                {offerAvailable && (
                  <div className="rounded-2xl border border-[#DED8CE] bg-[#F8F5EE] p-6 sm:p-8">
                    <p className="text-xs font-bold uppercase tracking-[0.15em] text-[#80570F]">Already planning a full detail?</p>
                    <h3 className="mt-3 text-2xl font-bold text-[#0B2A4A]">Add protection for {price(addonPrice(null)!)}*</h3>
                    <p className="mt-3 text-sm leading-6 text-slate-600">*Coupe / sedan, only with an {ULTIMATE_DETAIL_LABEL} purchase. The detail costs extra. Larger vehicles: {price(addonPrice("suv_large")!)} for the add-on. Before {settings.taxLabel}.</p>
                    <Link href={addonBookUrl} className="mt-4 inline-flex min-h-12 items-center font-bold text-[#0B2A4A] underline underline-offset-4">Build my detail + protection →</Link>
                  </div>
                )}
                <div className="rounded-2xl border border-[#DED8CE] p-6 sm:p-8">
                  <h3 className="text-xl font-bold text-[#0B2A4A]">Looking for multi-year protection?</h3>
                  <p className="mt-3 text-sm leading-6 text-slate-600">Explore Crystal, Pro and Max ceramic coatings. These have dedicated preparation and longer protection, with warranties on Pro and Max.</p>
                  <Link href={CERAMIC_COATING_HUB_PATH} className="mt-4 inline-flex min-h-11 items-center font-semibold text-[#0B2A4A] underline underline-offset-4">Compare ceramic coatings →</Link>
                </div>
              </div>
            </div>
          </Container>
        </section>

        <section className="bg-[#F8F5EE] py-12 text-[#1C2026] sm:py-16" aria-labelledby="faq-heading">
          <Container>
            <div className="mx-auto max-w-3xl">
              <h2 id="faq-heading" className="text-3xl font-bold tracking-tight">A few things you might be wondering</h2>
              <div className="mt-6 space-y-3">
                {faqs.map((faq) => (
                  <details key={faq.question} className="group rounded-xl border border-[#DED8CE] bg-white p-5">
                    <summary className="flex min-h-8 cursor-pointer items-center justify-between gap-4 font-semibold text-[#0B2A4A]">{faq.question}<span aria-hidden="true" className="text-xl group-open:rotate-45">+</span></summary>
                    <p className="mt-3 text-sm leading-7 text-slate-600">{faq.answer}</p>
                  </details>
                ))}
              </div>
            </div>
          </Container>
        </section>

        <section className="bg-[#0B2A4A] py-12 text-center sm:py-16">
          <Container>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-accent-300">Personal Touch Car Detailing · Hamilton</p>
            <h2 className="mt-4 text-3xl font-bold text-white sm:text-4xl">Ready for that freshly protected feeling?</h2>
            <p className="mt-4 text-ink-200">{settings.addressLine1}, {settings.city} · {settings.phone}</p>
            <div className="mt-6 flex flex-wrap justify-center gap-3">
              <ButtonLink href="#ceramic-enquiry">Get my price &amp; availability →</ButtonLink>
              <ButtonLink href={`/book?service=${CERAMIC_PROTECTION_SLUG}`} variant="outline">Book online</ButtonLink>
            </div>
          </Container>
        </section>
        <div className="fixed inset-x-0 bottom-0 z-40 flex items-center gap-3 border-t border-[#DED8CE] bg-white px-5 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-[0_-4px_24px_#00000015] md:hidden">
          <div className="shrink-0 text-[#0B2A4A]"><p className="text-xs">Ceramic protection</p><p className="text-lg font-extrabold">From {price(standalone.basePriceCents)} <span className="text-xs font-normal">+ {settings.taxLabel}</span></p><p className="text-[10px]">Coupe / sedan · {settings.currency}</p></div>
          <ButtonLink href="#ceramic-enquiry" className="flex-1 px-3 text-center text-sm">Get started →</ButtonLink>
        </div>
      </div>
    </>
  );
}
