import Image from "next/image";
import Link from "next/link";
import { and, eq, inArray } from "drizzle-orm";
import { ButtonLink, Card, Container } from "@/components/ui";
import { StructuredData } from "@/components/structured-data";
import { db, schema } from "@/db";
import {
  CERAMIC_BUNDLE_DETAIL_SLUGS,
  CERAMIC_COATING_SLUGS,
  CERAMIC_OFFER_PATH,
  COATING_PACKAGES,
  warrantyLabel,
} from "@/lib/ceramic";
import { formatCents, percentCents } from "@/lib/money";
import { servicePresentation } from "@/lib/public-content";
import { absoluteUrl, BUSINESS_ENTITY_ID, pageMetadata } from "@/lib/seo";
import { getSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";
export const metadata = pageMetadata({
  title: "Ceramic Coating Offers in Hamilton | Personal Touch",
  description: "Save $100 on Ceramic Coating Pro or $150 on Max, then add an eligible detailing package for 50% off. Crystal bundles receive 15% off detailing.",
  path: CERAMIC_OFFER_PATH,
  h1: "Ceramic coating offers in Hamilton",
});

export default async function CeramicCoatingOfferPage() {
  const settings = await getSettings();
  const services = await db()
    .select()
    .from(schema.services)
    .where(and(
      eq(schema.services.active, true),
      inArray(schema.services.slug, [...CERAMIC_COATING_SLUGS, ...CERAMIC_BUNDLE_DETAIL_SLUGS]),
    ));
  const coatingServices = COATING_PACKAGES.flatMap((content) => {
    const service = services.find((item) => item.slug === content.slug);
    return service ? [{ content, service }] : [];
  });
  const detailServices = CERAMIC_BUNDLE_DETAIL_SLUGS.flatMap((slug) => {
    const service = services.find((item) => item.slug === slug && item.basePriceCents !== null);
    return service ? [service] : [];
  });
  const offerRows = coatingServices.length > 0
    ? await db()
        .select()
        .from(schema.serviceBundleOffers)
        .where(and(
          eq(schema.serviceBundleOffers.active, true),
          inArray(schema.serviceBundleOffers.primaryServiceId, coatingServices.map(({ service }) => service.id)),
        ))
    : [];

  /** Basis points, as stored. Divide by 100 before showing a percentage. */
  const bundlePercentBp = (serviceId: string) => {
    const rates = offerRows.filter((row) => row.primaryServiceId === serviceId).map((row) => row.discountPercentBp);
    return rates.length > 0 ? Math.max(...rates) : 0;
  };

  const structuredData = {
    "@context": "https://schema.org",
    "@type": "OfferCatalog",
    name: "Personal Touch ceramic coating offers",
    url: absoluteUrl(CERAMIC_OFFER_PATH),
    provider: { "@id": BUSINESS_ENTITY_ID },
    itemListElement: coatingServices.map(({ content, service }) => ({
      "@type": "Offer",
      name: `Ceramic Coating ${content.tier}`,
      priceCurrency: settings.currency,
      price: (service.basePriceCents! / 100).toFixed(2),
      url: absoluteUrl(`/book?service=${service.slug}`),
      itemOffered: { "@type": "Service", name: service.name },
    })),
  };

  return (
    <>
      <StructuredData data={structuredData} />
      <section className="relative isolate overflow-hidden border-b border-white/10 bg-ink-950">
        <Image src="/images/services/ceramic-coating.png" alt="Ceramic coating being applied carefully to prepared vehicle paint" fill priority sizes="100vw" className="object-cover object-center opacity-35" />
        <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(6,26,44,0.99)_0%,rgba(6,26,44,0.9)_52%,rgba(6,26,44,0.55)_100%)]" />
        <Container className="relative py-20 sm:py-28">
          <nav aria-label="Breadcrumb" className="text-sm text-ink-300"><Link href="/">Home</Link> <span aria-hidden="true">/</span> <span className="text-white">Ceramic offer</span></nav>
          <div className="mt-12 max-w-4xl">
            <p className="text-xs font-bold uppercase tracking-[0.24em] text-accent-300">Current ceramic coating offer</p>
            <h1 className="mt-5 font-display text-5xl leading-[0.98] tracking-[-0.03em] text-white sm:text-7xl">Save on the coating. Save again on your detail.</h1>
            <p className="mt-6 max-w-2xl text-lg leading-8 text-ink-200">Choose the protection level that suits your vehicle, then complete the visit with one of our three main detailing packages at a reduced price.</p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <ButtonLink href="/book?service=ceramic-coating-pro" className="px-8">Build a Pro Package</ButtonLink>
              <ButtonLink href="#compare" variant="outline" className="px-8">Compare All Offers</ButtonLink>
            </div>
            <p className="mt-4 text-sm text-ink-400">No coupon code. Eligible savings appear automatically in your live booking estimate.</p>
          </div>
        </Container>
      </section>

      <section id="compare" className="surface-light scroll-mt-24 py-20 text-ink-900 sm:py-28">
        <Container>
          <div className="max-w-3xl">
            <p className="text-xs font-bold uppercase tracking-[0.22em] text-accent-600">Choose your coating</p>
            <h2 className="mt-4 font-display text-4xl leading-tight sm:text-5xl">Three packages. One clear offer with each.</h2>
            <p className="mt-4 text-base leading-7 text-slate-600">Prices below are for a coupe or sedan, before {settings.taxLabel}. The booking flow calculates the exact vehicle-size price before you confirm.</p>
          </div>
          <div className="mt-10 grid items-stretch gap-5 lg:grid-cols-3">
            {coatingServices.map(({ content, service }) => {
              const percentBp = bundlePercentBp(service.id);
              const directSaving = service.compareAtPriceCents === null ? 0 : service.compareAtPriceCents - service.basePriceCents!;
              return (
                <article key={service.id} className={`relative flex flex-col overflow-hidden rounded-[1.5rem] border bg-white p-6 shadow-[0_18px_50px_rgba(11,42,74,0.08)] sm:p-8 ${content.mostPopular ? "border-accent-500 ring-1 ring-accent-500" : "border-[#DED8CE]"}`}>
                  {content.mostPopular && <span className="absolute right-5 top-5 rounded-full bg-accent-400 px-3 py-1 text-[0.68rem] font-bold uppercase tracking-[0.14em] text-ink-950">Best seller</span>}
                  <p className="text-xs font-bold uppercase tracking-[0.18em] text-accent-600">{warrantyLabel(content.warrantyYears)}</p>
                  <h3 className="mt-3 font-display text-3xl">{content.tier}</h3>
                  <p className="mt-3 min-h-12 text-sm leading-6 text-slate-600">{content.tagline}</p>
                  <div className="mt-6 flex flex-wrap items-end gap-3">
                    {service.compareAtPriceCents !== null && <span className="pb-1 text-lg text-slate-400 line-through">{formatCents(service.compareAtPriceCents)}</span>}
                    <span className="font-display text-4xl text-ink-900">{formatCents(service.basePriceCents!)}</span>
                  </div>
                  {directSaving > 0 && <p className="mt-2 font-bold text-emerald-700">You save {formatCents(directSaving)} on {content.tier}</p>}
                  {percentBp > 0 && (
                    <div className="mt-6 rounded-xl bg-[#F4EFE4] p-4">
                      <p className="text-xs font-bold uppercase tracking-wider text-[#775A1C]">Detailing bundle</p>
                      <p className="mt-1 text-lg font-bold text-[#0B2A4A]">{percentBp / 100}% off an eligible detail</p>
                      <p className="mt-1 text-xs leading-5 text-slate-600">Ultimate, Signature or Interior Detail</p>
                    </div>
                  )}
                  <div className="mt-auto pt-7"><ButtonLink href={`/book?service=${service.slug}`} className="w-full">Choose {content.tier}</ButtonLink></div>
                </article>
              );
            })}
          </div>
        </Container>
      </section>

      <section className="bg-[#F6F2EA] py-20 text-ink-900 sm:py-28">
        <Container>
          <div className="grid gap-10 lg:grid-cols-[0.72fr_1.28fr] lg:items-start">
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.22em] text-accent-600">Bundle value</p>
              <h2 className="mt-4 font-display text-4xl leading-tight">Add the detail your vehicle needs.</h2>
              <p className="mt-4 text-base leading-7 text-slate-600">Pro and Max cut these detailing prices in half. Crystal takes 15% off. The coating price and the detailing saving are both reflected before booking confirmation.</p>
            </div>
            <div className="overflow-x-auto rounded-[1.5rem] border border-[#DCD5CA] bg-white shadow-sm">
              <table className="w-full min-w-[38rem] text-left text-sm">
                <thead><tr className="border-b border-[#E8E1D6] text-xs uppercase tracking-wider text-slate-500"><th className="p-5">Detailing package</th><th className="p-5 text-right">Regular</th><th className="p-5 text-right">With Crystal</th><th className="p-5 text-right">With Pro / Max</th></tr></thead>
                <tbody className="divide-y divide-[#ECE7DE]">
                  {detailServices.map((service) => (
                    <tr key={service.id}>
                      <th className="p-5 font-semibold text-[#0B2A4A]">{servicePresentation(service.slug).publicName}</th>
                      <td className="p-5 text-right text-slate-500 line-through">{formatCents(service.basePriceCents!)}</td>
                      <td className="p-5 text-right font-bold text-[#0B2A4A]">{formatCents(service.basePriceCents! - percentCents(service.basePriceCents!, 1500))}</td>
                      <td className="p-5 text-right font-bold text-emerald-700">{formatCents(service.basePriceCents! - percentCents(service.basePriceCents!, 5000))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="border-t border-[#ECE7DE] px-5 py-4 text-xs leading-5 text-slate-500">Coupe/sedan examples before {settings.taxLabel}. Vehicle-size adjustments are calculated first, then the percentage saving is applied.</p>
            </div>
          </div>
        </Container>
      </section>

      <section className="bg-ink-950 py-20 sm:py-28">
        <Container>
          <div className="grid gap-5 md:grid-cols-3">
            {[
              ["1", "Choose Crystal, Pro or Max", "Your current coating price appears immediately, including the $100 Pro or $150 Max reduction."],
              ["2", "Tell us about your vehicle", "We calculate the correct price for its category before showing any bundle saving."],
              ["3", "Add one detailing package", "Select Ultimate, Signature or Interior Detail. The eligible 15% or 50% saving is automatic."],
            ].map(([number, title, body]) => <Card key={number}><span className="text-sm font-bold text-accent-300">0{number}</span><h3 className="mt-5 font-display text-2xl text-white">{title}</h3><p className="mt-3 text-sm leading-6 text-ink-300">{body}</p></Card>)}
          </div>
          <div className="mt-12 rounded-[1.5rem] border border-white/10 bg-white/[0.04] p-6 sm:p-8">
            <h2 className="font-display text-3xl text-white">Offer details, without the fine-print fog.</h2>
            <ul className="mt-5 grid gap-3 text-sm leading-6 text-ink-300 md:grid-cols-2">
              <li>• Pro and Max current prices already include their $100 and $150 reductions.</li>
              <li>• One eligible detailing package can be added in the online booking flow.</li>
              <li>• Eligible details are Ultimate Detail, Signature Detail and Interior Detail.</li>
              <li>• Offers do not stack on the same service; the better eligible saving is used.</li>
              <li>• Prices are before {settings.taxLabel}; commercial vehicles are quoted individually.</li>
              <li>• Condition-dependent paint correction or preparation is discussed and approved separately.</li>
            </ul>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row"><ButtonLink href="/book?service=ceramic-coating-pro">Start with Pro</ButtonLink><ButtonLink href="/book?service=ceramic-coating-max" variant="outline">Choose Max</ButtonLink></div>
          </div>
        </Container>
      </section>
    </>
  );
}
