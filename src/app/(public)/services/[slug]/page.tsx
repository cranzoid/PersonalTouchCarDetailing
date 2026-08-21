import { notFound } from "next/navigation";
import Link from "next/link";
import type { Metadata } from "next";
import { and, asc, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import { Container, ButtonLink, Card } from "@/components/ui";
import { StructuredData } from "@/components/structured-data";
import { formatCents, withTaxCents } from "@/lib/money";
import { BUSINESS_ENTITY_ID, PUBLIC_SITE_URL, absoluteUrl, pageMetadata } from "@/lib/seo";
import { SERVICE_SEO } from "@/lib/service-seo";
import { getSettings } from "@/lib/settings";
import { VEHICLE_CATEGORY_LABELS, type VehicleCategory } from "@/lib/types";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const [service] = await db()
    .select({ name: schema.services.name, description: schema.services.shortDescription })
    .from(schema.services)
    .where(eq(schema.services.slug, slug))
    .limit(1);
  if (!service) return pageMetadata({
    title: "Car Detailing Service | Personal Touch Hamilton",
    description: "Car detailing services from Personal Touch Car Detailing in Hamilton, Ontario.",
    path: `/services/${slug}`,
    h1: "Car detailing service in Hamilton",
    noIndex: true,
  });

  return pageMetadata(SERVICE_SEO[slug] ?? {
    title: `${service.name} in Hamilton, ON | Personal Touch`,
    description: service.description
      ? `${service.description} Available from Personal Touch Car Detailing in Hamilton, Ontario.`
      : `Learn about ${service.name.toLowerCase()} from Personal Touch Car Detailing in Hamilton, Ontario.`,
    path: `/services/${slug}`,
    h1: `${service.name} in Hamilton`,
  });
}

export default async function ServiceDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const settings = await getSettings();
  const rows = await db()
    .select()
    .from(schema.services)
    .where(eq(schema.services.slug, slug))
    .limit(1);
  const svc = rows[0];
  if (!svc || !svc.active) notFound();
  const seo = SERVICE_SEO[slug];

  const adjustments = await db()
    .select()
    .from(schema.serviceVehicleAdjustments)
    .where(eq(schema.serviceVehicleAdjustments.serviceId, svc.id));

  const addonLinks = await db()
    .select()
    .from(schema.serviceAddons)
    .where(eq(schema.serviceAddons.serviceId, svc.id));
  const addonRows =
    addonLinks.length > 0
      ? await db()
          .select()
          .from(schema.addons)
          .where(inArray(schema.addons.id, addonLinks.map((l) => l.addonId)))
          .orderBy(asc(schema.addons.sort))
      : [];

  const relatedServices = seo?.relatedServices.length
    ? await db()
        .select({ slug: schema.services.slug, name: schema.services.name })
        .from(schema.services)
        .where(and(
          eq(schema.services.active, true),
          inArray(schema.services.slug, seo.relatedServices.map((service) => service.slug)),
        ))
    : [];

  const bookable = svc.bookingMode === "bookable" && svc.basePriceCents !== null;
  const quotePath = svc.bookingMode === "contact_only" ? "/contact" : `/quote?service=${svc.slug}`;

  const canonicalPath = `/services/${svc.slug}`;
  const serviceSchema = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Service",
        "@id": `${absoluteUrl(canonicalPath)}#service`,
        name: svc.name,
        description: seo?.description ?? svc.shortDescription,
        url: absoluteUrl(canonicalPath),
        provider: { "@id": BUSINESS_ENTITY_ID },
        areaServed: { "@type": "City", name: "Hamilton", containedInPlace: { "@type": "AdministrativeArea", name: "Ontario" } },
        serviceType: svc.name,
        ...(svc.basePriceCents !== null
          ? { offers: { "@type": "Offer", priceCurrency: "CAD", price: (svc.basePriceCents / 100).toFixed(2), url: absoluteUrl(`/book?service=${svc.slug}`) } }
          : {}),
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Home", item: PUBLIC_SITE_URL },
          { "@type": "ListItem", position: 2, name: "Services", item: absoluteUrl("/services") },
          { "@type": "ListItem", position: 3, name: svc.name, item: absoluteUrl(canonicalPath) },
        ],
      },
      ...(seo?.faqs.length
        ? [{
            "@type": "FAQPage",
            mainEntity: seo.faqs.map((faq) => ({
              "@type": "Question",
              name: faq.question,
              acceptedAnswer: { "@type": "Answer", text: faq.answer },
            })),
          }]
        : []),
    ],
  };

  return (
    <>
      <StructuredData data={serviceSchema} />
      <Container className="py-20 sm:py-28">
      <nav aria-label="Breadcrumb" className="mb-8 text-sm text-ink-400">
        <ol className="flex flex-wrap items-center gap-2">
          <li><Link className="hover:text-accent-300" href="/">Home</Link></li>
          <li aria-hidden="true">/</li>
          <li><Link className="hover:text-accent-300" href="/services">Services</Link></li>
          <li aria-hidden="true">/</li>
          <li aria-current="page" className="text-ink-200">{svc.name}</li>
        </ol>
      </nav>
      <div className="grid gap-14 lg:grid-cols-[minmax(0,1.45fr)_minmax(19rem,0.55fr)]">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-accent-300">{seo?.eyebrow ?? "Detailing service"}</p>
          <h1 className="mt-5 max-w-3xl font-display text-5xl leading-[1.02] tracking-[-0.03em] text-white sm:text-6xl">{seo?.h1 ?? `${svc.name} in Hamilton`}</h1>
          <p className="mt-6 max-w-2xl text-lg leading-8 text-ink-200">{seo?.introduction ?? svc.shortDescription}</p>
          {svc.longDescription && <p className="mt-5 max-w-2xl leading-7 text-ink-300">{svc.longDescription}</p>}

          {seo && (
            <section className="mt-12" aria-labelledby="benefits-heading">
              <h2 id="benefits-heading" className="font-display text-3xl text-white">What this service is designed to do</h2>
              <div className="mt-5 grid gap-4 md:grid-cols-3">
                {seo.benefits.map((benefit) => (
                  <Card key={benefit.title} className="p-5">
                    <h3 className="font-semibold text-white">{benefit.title}</h3>
                    <p className="mt-2 text-sm leading-6 text-ink-300">{benefit.body}</p>
                  </Card>
                ))}
              </div>
            </section>
          )}

          {!bookable && (
            <Card className="mt-8 border-accent-500/30">
              <h2 className="font-semibold text-accent-300">
                {svc.bookingMode === "contact_only"
                  ? "Contact us about this service"
                  : "This service is quoted individually"}
              </h2>
              <p className="mt-2 text-sm text-ink-300">
                {svc.bookingMode === "inspection_required"
                  ? "Results depend on your vehicle's paint and condition, so we review photos or inspect the vehicle before giving you an exact price and timeline."
                  : svc.bookingMode === "quote_required"
                    ? "Pricing depends on your vehicle's condition. Send us a few details — and photos if you can — and we'll reply with a personalized estimate."
                    : "Tell us about your project and we'll get back to you with options."}
              </p>
            </Card>
          )}

          {bookable && adjustments.length > 0 && (
            <div className="mt-10">
              <h2 className="font-display text-2xl text-white">Pricing by vehicle size</h2>
              <div className="mt-4 overflow-x-auto">
                <table className="w-full max-w-lg overflow-hidden rounded-2xl text-sm">
                  <caption className="sr-only">Price adjustments by vehicle category</caption>
                  <thead>
                    <tr className="border-b border-white/10 text-xs uppercase tracking-wider text-ink-500">
                      <th scope="col" className="py-2 text-left font-medium">Vehicle</th>
                      <th scope="col" className="py-2 text-right font-medium">Cash / e-transfer</th>
                      <th scope="col" className="py-2 text-right font-medium">Card / cheque</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="border-b border-white/10">
                      <td className="py-2 text-ink-300">Coupe / Sedan</td>
                      <td className="py-2 text-right text-accent-300">
                        {formatCents(svc.basePriceCents!)}
                      </td>
                      <td className="py-2 text-right text-ink-300">
                        {formatCents(withTaxCents(svc.basePriceCents!, settings.taxRateBp))}
                      </td>
                    </tr>
                    {adjustments.map((adj) => (
                      <tr key={adj.id} className="border-b border-white/10">
                        <td className="py-2 text-ink-300">
                          {VEHICLE_CATEGORY_LABELS[adj.vehicleCategory as VehicleCategory] ??
                            adj.vehicleCategory}
                        </td>
                        <td className="py-2 text-right text-accent-300">
                          {formatCents(svc.basePriceCents! + adj.priceDeltaCents)}
                        </td>
                        <td className="py-2 text-right text-ink-300">
                          {formatCents(
                            withTaxCents(svc.basePriceCents! + adj.priceDeltaCents, settings.taxRateBp),
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-2 text-xs text-ink-500">
                Final pricing is confirmed at booking. Heavily soiled vehicles may require
                additional time, always discussed with you first. Listed prices are what you pay in
                cash or by Interac e-transfer; card and cheque add {settings.taxLabel}.
              </p>
            </div>
          )}

          {addonRows.length > 0 && (
            <div className="mt-10">
              <h2 className="font-display text-2xl text-white">Popular add-ons</h2>
              <ul className="mt-4 grid max-w-xl gap-2 sm:grid-cols-2">
                {addonRows.map((a) => (
                  <li key={a.id} className="flex min-h-12 items-center justify-between rounded-xl border border-white/10 bg-white/[0.03] px-4 py-2 text-sm">
                    <span className="text-ink-200">{a.name}</span>
                    <span className="text-right text-accent-300">
                      {formatCents(a.priceCents)}
                      <span className="block text-xs text-ink-500">+{formatDuration(a.durationMin)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {seo && (
            <>
              <section className="mt-14" aria-labelledby="process-heading">
                <h2 id="process-heading" className="font-display text-3xl text-white">How we approach the work</h2>
                <ol className="mt-5 grid gap-4 md:grid-cols-3">
                  {seo.process.map((step, index) => (
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
                    {seo.idealFor.map((item) => <li key={item}>• {item}</li>)}
                  </ul>
                </Card>
                <Card>
                  <h2 className="font-display text-2xl text-white">Aftercare</h2>
                  <p className="mt-4 text-sm leading-6 text-ink-300">{seo.aftercare}</p>
                </Card>
              </section>

              <section className="mt-14" aria-labelledby="faq-heading">
                <h2 id="faq-heading" className="font-display text-3xl text-white">Frequently asked questions</h2>
                <div className="mt-5 space-y-3">
                  {seo.faqs.map((faq) => (
                    <details key={faq.question} className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
                      <summary className="cursor-pointer font-semibold text-white">{faq.question}</summary>
                      <p className="mt-3 max-w-3xl text-sm leading-6 text-ink-300">{faq.answer}</p>
                    </details>
                  ))}
                </div>
              </section>

              {relatedServices.length > 0 && (
                <section className="mt-14" aria-labelledby="related-services-heading">
                  <h2 id="related-services-heading" className="font-display text-3xl text-white">Related Hamilton vehicle-care services</h2>
                  <div className="mt-5 flex flex-wrap gap-3">
                    {relatedServices.map((service) => (
                      <Link key={service.slug} href={`/services/${service.slug}`} className="rounded-full border border-white/15 px-4 py-2 text-sm text-ink-200 transition hover:border-accent-400 hover:text-accent-300">
                        {service.name}
                      </Link>
                    ))}
                    <Link href="/results" className="rounded-full border border-white/15 px-4 py-2 text-sm text-ink-200 transition hover:border-accent-400 hover:text-accent-300">View real results</Link>
                  </div>
                </section>
              )}
            </>
          )}
        </div>

        <aside>
          <Card className="sticky top-28 border-accent-400/25 p-7">
            <p className="text-sm uppercase tracking-wider text-ink-400">
              {bookable ? "Starting at" : "Pricing"}
            </p>
            <p className="mt-2 font-display text-4xl text-white">
              {bookable ? formatCents(svc.basePriceCents!) : "By quote"}
            </p>
            {bookable && settings.taxRateBp > 0 && (
              <p className="mt-1 text-sm text-ink-400">
                in cash or by Interac e-transfer ·{" "}
                {formatCents(withTaxCents(svc.basePriceCents!, settings.taxRateBp))} by card or cheque
              </p>
            )}
            <p className="mt-1 text-sm text-ink-400">
              Approx. {formatDuration(svc.baseDurationMin)} for a standard vehicle
            </p>
            <div className="mt-6 flex flex-col gap-2">
              {bookable ? (
                <>
                  <ButtonLink href={`/book?service=${svc.slug}`}>Book This Service</ButtonLink>
                  <ButtonLink href="/quote" variant="outline">Ask a Question</ButtonLink>
                </>
              ) : (
                <ButtonLink href={quotePath}>
                  {svc.bookingMode === "contact_only" ? "Contact Us" : "Request a Quote"}
                </ButtonLink>
              )}
            </div>
          </Card>
        </aside>
      </div>
      </Container>
    </>
  );
}

function formatDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const remaining = minutes % 60;
  return [
    hours ? `${hours}h` : "",
    remaining ? `${remaining}m` : "",
  ].filter(Boolean).join(" ");
}
