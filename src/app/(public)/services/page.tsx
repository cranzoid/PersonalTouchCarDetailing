import Image from "next/image";
import Link from "next/link";
import { asc, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { ButtonLink, Card, Container, SectionHeading } from "@/components/ui";
import { CheckList, GoogleReviewStrip, ServiceImage } from "@/components/public-sections";
import { formatCents, withTaxCents } from "@/lib/money";
import { getSettings } from "@/lib/settings";
import { pageMetadata, SEO_PAGES } from "@/lib/seo";
import { isCeramicServiceSlug, resolveCeramicMenu } from "@/lib/ceramic";
import { POPULAR_SERVICE_SLUGS, servicePresentation } from "@/lib/public-content";

export const metadata = pageMetadata(SEO_PAGES.services);

const CATEGORY_PAGE: Record<string, string> = {
  "paint-correction": "/services/paint-correction",
};

const CATEGORY_GUIDES: Record<string, { href: string; label: string }[]> = {
  "paint-correction": [{ href: "/services/paint-correction", label: "Compare correction levels" }],
};

const COMPARISON_ROWS = [
  ["Brush-free exterior hand wash", true, true, false],
  ["Interior deep clean", true, true, true],
  ["Seats, carpets and mats", true, true, true],
  ["Rims cleaned and tires dressed", true, true, false],
  ["Engine bay fine detail", true, false, false],
] as const;

export default async function ServicesPage() {
  const settings = await getSettings();
  const [categories, services, addons, addonLinks] = await Promise.all([
    db().select().from(schema.serviceCategories).where(eq(schema.serviceCategories.active, true)).orderBy(asc(schema.serviceCategories.sort)),
    db().select().from(schema.services).where(eq(schema.services.active, true)).orderBy(asc(schema.services.sort)),
    db().select().from(schema.addons).where(eq(schema.addons.active, true)).orderBy(asc(schema.addons.sort)),
    db().select().from(schema.serviceAddons),
  ]);

  const ceramicMenu = resolveCeramicMenu({ services, addons });
  const ceramicCategoryId = services.find((service) => isCeramicServiceSlug(service.slug))?.categoryId ?? null;
  const popularServices = POPULAR_SERVICE_SLUGS.map((slug) => services.find((service) => service.slug === slug)).filter(Boolean);
  const compareServices = ["complete-detail-engine", "the-works", "interior-detail"].map((slug) => services.find((service) => service.slug === slug)).filter(Boolean);
  const serviceById = new Map(services.map((service) => [service.id, service]));

  return (
    <>
      <section className="relative overflow-hidden bg-ink-950 py-20 sm:py-28">
        <div className="pointer-events-none absolute -right-40 -top-40 size-[32rem] rounded-full border border-accent-400/10" />
        <Container className="relative">
          <div className="grid items-end gap-10 lg:grid-cols-[1fr_0.72fr]">
            <SectionHeading
              as="h1"
              eyebrow="Service menu"
              title="A clearer way to choose your detail."
              subtitle="Start with our four most requested services, compare what is included, then book with vehicle-size pricing shown before checkout."
            />
            <div className="lg:pb-2">
              <GoogleReviewStrip settings={settings} tone="dark" />
              <p className="mt-4 text-sm leading-6 text-ink-400">Standard online prices include {settings.taxLabel}. Condition-dependent work is quoted after we review the vehicle or photos.</p>
            </div>
          </div>
        </Container>
      </section>

      <section className="surface-light py-20 sm:py-28">
        <Container>
          <SectionHeading
            eyebrow="Popular packages"
            title="The services most drivers start with."
            subtitle="The essentials are easy to scan. Open a service for the complete checklist, vehicle-size pricing, FAQs and relevant extras."
            tone="light"
          />
          <div className="grid gap-6 md:grid-cols-2">
            {popularServices.map((service, index) => {
              if (!service) return null;
              const presentation = servicePresentation(service.slug);
              const ceramic = service.slug === "ceramic-coating-crystal" ? ceramicMenu[0] : undefined;
              const price = ceramic?.fromPriceCents ?? service.basePriceCents;
              const href = ceramic?.href ?? `/services/${service.slug}`;
              return (
                <article key={service.id} className="group overflow-hidden rounded-[1.5rem] border border-[#DED8CE] bg-[#FFFEFB] shadow-[0_18px_50px_rgba(11,42,74,0.085)]">
                  <ServiceImage slug={service.slug} name={presentation.publicName} className="aspect-[16/9]" />
                  <div className="p-6 sm:p-8">
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-accent-600">Most requested {String(index + 1).padStart(2, "0")}</p>
                        <h2 className="mt-3 font-display text-[2rem] leading-tight text-ink-900">{presentation.publicName}</h2>
                      </div>
                      <span className="rounded-full bg-ink-900 px-4 py-2 text-sm font-semibold text-white">
                        {price !== null ? `From ${formatCents(withTaxCents(price, settings.taxRateBp))}` : "By quote"}
                      </span>
                    </div>
                    <div className="mt-6"><CheckList items={presentation.highlights} tone="light" /></div>
                    <div className="mt-7 flex flex-wrap gap-3 border-t border-[#E5E0D7] pt-5">
                      <ButtonLink href={href}>See What&apos;s Included</ButtonLink>
                      {service.bookingMode === "bookable" && <ButtonLink href={`/book?service=${service.slug}`} variant="ghost" className="!text-ink-900 hover:!text-accent-600">Book Now →</ButtonLink>}
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        </Container>
      </section>

      <section className="bg-[#F6F2EA] py-20 text-ink-900 sm:py-28">
        <Container>
          <SectionHeading eyebrow="Compare packages" title="See what changes as you move up." subtitle="A quick comparison of our three core detailing packages. Full descriptions remain available on each service page." tone="light" />
          <div className="overflow-x-auto rounded-[1.5rem] border border-[#DCD5CA] bg-[#FFFEFB] shadow-[0_18px_48px_rgba(11,42,74,0.06)]">
            <table className="w-full min-w-[46rem] text-left">
              <thead>
                <tr className="border-b border-[#E2DDD4]">
                  <th className="p-5 text-sm font-semibold text-slate-500 sm:p-6">Included</th>
                  {compareServices.map((service) => service && (
                    <th key={service.id} className="p-5 sm:p-6">
                      <span className="block font-display text-2xl text-ink-900">{servicePresentation(service.slug).publicName}</span>
                      <span className="mt-1 block text-sm font-semibold text-accent-600">{service.basePriceCents !== null ? `From ${formatCents(withTaxCents(service.basePriceCents, settings.taxRateBp))}` : "By quote"}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {COMPARISON_ROWS.map(([label, ultimate, signature, interior]) => (
                  <tr key={label} className="border-b border-[#ECE7DE] last:border-0">
                    <th scope="row" className="p-5 text-sm font-medium text-slate-700 sm:p-6">{label}</th>
                    {[ultimate, signature, interior].map((included, index) => (
                      <td key={index} className="p-5 text-center sm:p-6"><span className={included ? "text-lg font-black text-accent-600" : "text-slate-300"} aria-label={included ? "Included" : "Not included"}>{included ? "✓" : "—"}</span></td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Container>
      </section>

      <section className="bg-ink-900 py-20 sm:py-28">
        <Container>
          <div className="grid gap-10 lg:grid-cols-[0.78fr_1.22fr] lg:items-center">
            <div>
              <SectionHeading eyebrow="Useful extras" title="Add only what this service needs." subtitle="Extras are now matched to the selected package. Interior cleanup options no longer appear beside an exterior-only wash." />
              <ButtonLink href="/book" variant="outline">Build Your Appointment</ButtonLink>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              {addons.map((addon) => {
                const linkedNames = addonLinks.filter((link) => link.addonId === addon.id).map((link) => serviceById.get(link.serviceId)).filter(Boolean).map((service) => servicePresentation(service!.slug).publicName);
                return (
                  <Card key={addon.id} className="p-6">
                    <div className="flex items-start justify-between gap-4"><h3 className="text-lg font-semibold text-white">{addon.name.replace(" - Ultimate Detail Add-On", "")}</h3><span className="shrink-0 text-sm font-semibold text-accent-300">+{formatCents(withTaxCents(addon.priceCents, settings.taxRateBp))}</span></div>
                    <p className="mt-3 text-sm leading-6 text-ink-300">{addon.description}</p>
                    {linkedNames.length > 0 && <p className="mt-4 border-t border-white/10 pt-4 text-xs leading-5 text-ink-500">Available with {unique(linkedNames).join(", ")}.</p>}
                  </Card>
                );
              })}
            </div>
          </div>
        </Container>
      </section>

      <section className="surface-light py-20 sm:py-28">
        <Container>
          <SectionHeading eyebrow="How the work looks" title="Careful hands. Clear stages." subtitle="From brush-free washing to deep interior cleaning and paint protection, each step is carried out for the surface in front of us." tone="light" />
          <div className="grid gap-5 md:grid-cols-3">
            {[
              ["/images/services/hand-wash.png", "Brush-free hand wash", "Hand washing keeps automatic brushes away from the finish."],
              ["/images/services/interior-detail.png", "Interior deep clean", "Focused tools and products reach seats, carpets, trim and tight cabin areas."],
              ["/images/services/ceramic-coating.png", "Ceramic application", "Prepared paint receives a precise, panel-by-panel protective application."],
            ].map(([src, title, body]) => (
              <figure key={title} className="overflow-hidden rounded-[1.25rem] border border-[#DED8CE] bg-[#FFFEFB]">
                <div className="relative aspect-[4/3]"><Image src={src} alt={title} fill sizes="(min-width: 768px) 33vw, 100vw" className="object-cover" /></div>
                <figcaption className="p-6"><h3 className="font-display text-2xl text-ink-900">{title}</h3><p className="mt-2 text-sm leading-6 text-slate-600">{body}</p></figcaption>
              </figure>
            ))}
          </div>
        </Container>
      </section>

      <section className="bg-ink-950 py-20 sm:py-28">
        <Container>
          <SectionHeading eyebrow="Complete menu" title="More ways to care for your vehicle." subtitle="Explore focused cleaning, paint correction, protection, tint removal and replacement, styling, and commercial programs." />
          <div className="space-y-16">
            {categories.filter((category) => category.slug !== "detailing-packages").map((category) => {
              const categoryServices = services.filter((service) => service.categoryId === category.id && service.slug !== "vehicle-tinting" && !isCeramicServiceSlug(service.slug));
              const includeCeramic = category.id === ceramicCategoryId;
              if (categoryServices.length === 0 && !includeCeramic) return null;
              const categoryName = category.slug === "window-tinting" ? "Tint Removal & Replacement" : category.name;
              const categoryDescription = category.slug === "window-tinting" ? "Removal of old or damaged film, with replacement available by quote." : category.description;
              return (
                <section key={category.id} id={category.slug} className="scroll-mt-28 border-t border-white/10 pt-7">
                  <div className="grid gap-3 md:grid-cols-[0.72fr_1.28fr]">
                    <div>
                      <h2 className="font-display text-[2rem] text-white">{CATEGORY_PAGE[category.slug] ? <Link href={CATEGORY_PAGE[category.slug]} className="hover:text-accent-300">{categoryName}</Link> : categoryName}</h2>
                      <p className="mt-3 max-w-md text-sm leading-6 text-ink-400">{categoryDescription}</p>
                      {(CATEGORY_GUIDES[category.slug] ?? []).map((guide) => <Link key={guide.href} href={guide.href} className="mt-3 inline-flex text-sm font-semibold text-accent-300 hover:text-accent-200">{guide.label} →</Link>)}
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      {includeCeramic && ceramicMenu.map((product) => <CompactService key={product.key} href={product.href} name={product.name} description={product.shortDescription} price={formatCents(withTaxCents(product.fromPriceCents, settings.taxRateBp))} />)}
                      {categoryServices.map((service) => <CompactService key={service.id} href={`/services/${service.slug}`} name={service.name} description={service.shortDescription ?? "See service details and request options."} price={service.basePriceCents !== null ? formatCents(withTaxCents(service.basePriceCents, settings.taxRateBp)) : null} />)}
                    </div>
                  </div>
                </section>
              );
            })}
          </div>
          <div className="mt-20 flex flex-col items-start justify-between gap-6 rounded-[1.25rem] border border-accent-400/25 bg-accent-400/[0.055] p-7 sm:flex-row sm:items-center sm:p-10">
            <div><h2 className="font-display text-3xl text-white">Not sure where to start?</h2><p className="mt-2 text-base text-ink-300">Book a package directly, or send photos for condition-dependent work.</p></div>
            <div className="flex flex-wrap gap-3"><ButtonLink href="/book">Book an Appointment</ButtonLink><ButtonLink href="/quote" variant="outline">Request a Quote</ButtonLink></div>
          </div>
        </Container>
      </section>
    </>
  );
}

function CompactService({ href, name, description, price }: { href: string; name: string; description: string; price: string | null }) {
  return (
    <Link href={href} className="group rounded-2xl border border-white/10 bg-white/[0.035] p-5 transition hover:border-accent-400/45 hover:bg-white/[0.055]">
      <div className="flex items-start justify-between gap-4"><h3 className="text-lg font-semibold text-white">{name}</h3><span aria-hidden="true" className="text-ink-500 transition group-hover:translate-x-1 group-hover:text-accent-300">→</span></div>
      <p className="mt-2 line-clamp-2 text-sm leading-6 text-ink-400">{description}</p>
      <p className="mt-4 text-sm font-semibold text-accent-300">{price ? `From ${price}` : "Request a quote"}</p>
    </Link>
  );
}

function unique(values: string[]) {
  return [...new Set(values)];
}
