import Image from "next/image";
import Link from "next/link";
import { and, desc, inArray, isNotNull } from "drizzle-orm";
import { Container, ButtonLink, SectionHeading } from "@/components/ui";
import {
  GoogleReviewCarousel,
  GoogleReviewStrip,
  ServiceImage,
} from "@/components/public-sections";
import { db, schema } from "@/db";
import { formatCents } from "@/lib/money";
import { getPublicHomeCatalog } from "@/lib/public-catalog";
import { CERAMIC_COATING_HUB_PATH, CERAMIC_PROTECTION_PATH } from "@/lib/ceramic";
import { POPULAR_SERVICE_SLUGS, servicePresentation } from "@/lib/public-content";
import { hasPublishedResults } from "@/lib/results";
import { getPublicSettings } from "@/lib/settings";
import { pageMetadata, SEO_PAGES, slugifySeoText } from "@/lib/seo";

export const metadata = pageMetadata(SEO_PAGES.home);

const EXPERIENCE_POINTS = [
  {
    number: "01",
    title: "Choose the right service",
    body: "Compare clear inclusions, vehicle-size pricing and relevant add-ons before you book.",
  },
  {
    number: "02",
    title: "Stay informed",
    body: "Receive appointment details and review any additional work before it is approved.",
  },
  {
    number: "03",
    title: "Leave with clarity",
    body: "See an itemized invoice, payment history and the details tied to your visit.",
  },
];

export default async function HomePage() {
  const [{ featured, categories, ceramicMenu }, settings, proofPhotos, resultsPublished] = await Promise.all([
    getPublicHomeCatalog(),
    getPublicSettings(),
    db()
      .select({ id: schema.files.id, kind: schema.files.kind, contentType: schema.files.contentType })
      .from(schema.files)
      .where(and(
        isNotNull(schema.files.publicConsentAt),
        inArray(schema.files.kind, ["before", "after"]),
        inArray(schema.files.contentType, ["image/jpeg", "image/png", "image/webp"]),
      ))
      .orderBy(desc(schema.files.createdAt))
      .limit(3),
    hasPublishedResults(),
  ]);

  // Two decisions, not four packages. The home page names what the shop sells
  // — detailing, and ceramic — and each service page carries the detail; a
  // four-card price list here made the page long without helping anyone
  // choose. The ceramic half is the same two products `/services` shows,
  // resolved by the one menu resolver so a price can never differ by page.
  const detailingProducts = featured
    .sort((a, b) => {
      const aIndex = POPULAR_SERVICE_SLUGS.indexOf(a.slug as (typeof POPULAR_SERVICE_SLUGS)[number]);
      const bIndex = POPULAR_SERVICE_SLUGS.indexOf(b.slug as (typeof POPULAR_SERVICE_SLUGS)[number]);
      return aIndex - bIndex;
    })
    .map((service) => ({
      key: service.id,
      name: servicePresentation(service.slug).publicName,
      href: `/services/${service.slug}`,
      priceCents: service.basePriceCents,
      priceNote: null,
    }));

  const ceramicProducts = ceramicMenu.map((product) => ({
    key: product.key,
    name: product.name,
    href: product.href,
    priceCents: product.fromPriceCents,
    priceNote: product.priceNote,
  }));

  const visibleCategories = categories.filter((category) => category.slug !== "window-tinting");

  return (
    <>
      <section className="relative isolate min-h-[calc(100svh-5rem)] overflow-hidden bg-ink-950">
        <Image
          src="/images/detailing-studio-hero.png"
          alt="A vehicle receiving careful detailing in a professional studio"
          fill
          priority
          sizes="100vw"
          className="object-cover object-[68%_center] sm:object-center"
        />
        <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(6,26,44,0.985)_0%,rgba(6,26,44,0.92)_39%,rgba(6,26,44,0.45)_72%,rgba(6,26,44,0.16)_100%)]" />
        <div className="absolute inset-0 bg-[linear-gradient(0deg,rgba(6,26,44,0.98)_0%,transparent_44%,rgba(6,26,44,0.08)_100%)]" />

        <Container className="relative flex min-h-[calc(100svh-5rem)] flex-col justify-center py-16 sm:py-20">
          <div className="max-w-3xl">
            <p className="mb-5 flex items-center gap-3 text-xs font-semibold uppercase tracking-[0.24em] text-accent-300">
              <span className="h-px w-10 bg-accent-400" aria-hidden="true" />
              Vehicle care in {settings.city}, {settings.province}
            </p>
            <h1 className="font-display text-[3.4rem] leading-[0.96] tracking-[-0.035em] text-white sm:text-7xl lg:text-[5.35rem]">
              Hamilton car detailing,
              <span className="mt-2 block text-ink-200">finished with precision.</span>
            </h1>

            <ul className="mt-7 grid max-w-2xl gap-2.5 text-[1.02rem] leading-7 text-ink-100 sm:grid-cols-2">
              {[
                "Interior and exterior detailing",
                "Ceramic coating and paint care",
                "Brush-free hand wash",
                "Straightforward online booking",
              ].map((item) => (
                <li key={item} className="flex items-center gap-3">
                  <span aria-hidden="true" className="grid size-5 shrink-0 place-items-center rounded-full bg-accent-400 text-[0.7rem] font-black text-ink-950">✓</span>
                  {item}
                </li>
              ))}
            </ul>

            <div className="mt-9 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
              <ButtonLink href="/book" className="px-10 py-4 text-base">Book an Appointment</ButtonLink>
              <ButtonLink href="/quote" variant="outline" className="px-10 py-4 text-base">Request a Quote</ButtonLink>
            </div>

            <GoogleReviewStrip settings={settings} tone="dark" className="mt-8 max-w-2xl" />
          </div>

          <div className="mt-12 grid max-w-4xl overflow-hidden rounded-2xl border border-white/15 bg-ink-950/45 backdrop-blur-sm sm:grid-cols-3">
            {[
              [`${settings.googleReviewRating.toFixed(1)} / 5`, `${settings.googleReviewCount} Google reviews`],
              [settings.yearsInBusinessLabel, "Serving local drivers"],
              ["Hand wash", "No automatic brushes"],
            ].map(([title, detail], index) => (
              <div key={title} className={`px-6 py-5 ${index > 0 ? "border-t border-white/15 sm:border-l sm:border-t-0" : ""}`}>
                <p className="font-display text-[1.8rem] leading-none text-white">{title}</p>
                <p className="mt-2 text-sm text-ink-300">{detail}</p>
              </div>
            ))}
          </div>
        </Container>
      </section>

      <GoogleReviewCarousel settings={settings} />

      <section className="surface-light py-20 sm:py-28">
        <Container>
          <SectionHeading
            eyebrow="Most requested"
            title="Detailing, and long-term paint protection."
            subtitle="Two places to start. Open either one for the full checklist, vehicle-size pricing and online booking."
            tone="light"
          />
          <div className="grid gap-6 md:grid-cols-2">
            <MenuCard
              imageSlug="complete-detail-engine"
              eyebrow="Cleaning & detailing"
              title="Our Detailing Packages"
              blurb="A complete inside-and-out reset, a hand-washed full detail, or a focused interior clean — each priced for your vehicle size."
              products={detailingProducts}
              primary={{ href: "/services", label: "Compare Packages" }}
              secondary={{ href: "/book", label: "Book a Detail →" }}
            />
            <MenuCard
              imageSlug="ceramic-coating-crystal"
              eyebrow="Long-term protection"
              title="Ceramic Coating & Protection"
              blurb="Our coating packages — Crystal, Pro and Max, with warranty options — or a single layer of ceramic protection on its own."
              products={ceramicProducts}
              primary={{ href: CERAMIC_COATING_HUB_PATH, label: "Explore Ceramic Coating" }}
              secondary={{ href: CERAMIC_PROTECTION_PATH, label: "Ceramic Protection →" }}
            />
          </div>
        </Container>
      </section>

      <section className="relative overflow-hidden bg-ink-900 py-20 sm:py-28">
        <div className="pointer-events-none absolute -right-40 top-0 size-[32rem] rounded-full border border-accent-400/10" />
        <Container className="relative">
          <SectionHeading
            eyebrow="Explore the studio"
            title="Detailing first. Protection when your vehicle needs it."
            subtitle="Browse the complete menu by what your vehicle needs, from a full reset to focused paint care, tint correction and commercial upkeep."
          />
          <div className="grid gap-px overflow-hidden rounded-[1.25rem] border border-white/10 bg-white/10 sm:grid-cols-2 lg:grid-cols-3">
            {visibleCategories.map((category, index) => (
              <Link key={category.id} href={`/services#${category.slug}`} className="group min-h-52 bg-ink-900 p-7 transition-colors hover:bg-ink-800">
                <div className="flex items-start justify-between gap-5">
                  <span className="text-xs font-semibold tracking-[0.18em] text-accent-400">{String(index + 1).padStart(2, "0")}</span>
                  <span aria-hidden="true" className="text-xl text-ink-500 transition-transform group-hover:translate-x-1 group-hover:text-accent-300">→</span>
                </div>
                <h3 className="mt-10 font-display text-[1.9rem] leading-tight text-white">{category.name}</h3>
                <p className="mt-3 text-base leading-7 text-ink-300">{category.description}</p>
              </Link>
            ))}
          </div>
        </Container>
      </section>

      {/* Shown only once there is customer-approved work to show. An empty
          results section explaining that the results are coming reads as an
          unfinished site, so it is absent rather than promissory. */}
      {proofPhotos.length > 0 && (
        <section className="bg-[#FFFEFB] py-20 text-[#1C2026] sm:py-28">
          <Container>
            <SectionHeading
              eyebrow="Real results"
              title="The finish should speak for itself."
              subtitle="Customer-approved work from the CRM appears here automatically. Photos stay private until separate marketing consent is recorded."
              tone="light"
            />
            <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {proofPhotos.map((photo) => (
                <figure key={photo.id} className="overflow-hidden rounded-[1.25rem] border border-[#DED8CE] bg-[#F8F5EE]">
                  {/* Consent is rechecked by the media route on every request. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={mediaUrl(photo)} alt={`Customer-approved ${photo.kind.replaceAll("_", " ")} detailing result`} className="aspect-[4/3] w-full object-cover" />
                  <figcaption className="px-5 py-4 text-sm capitalize text-slate-600">Customer-approved {photo.kind.replaceAll("_", " ")} view</figcaption>
                </figure>
              ))}
            </div>
            {resultsPublished && (
              <div className="mt-10">
                <Link href="/results" className="inline-flex border-b border-ink-900 pb-1 text-base font-semibold text-ink-900 transition-colors hover:border-accent-500 hover:text-accent-600">
                  Read the case studies <span className="ml-2" aria-hidden="true">→</span>
                </Link>
              </div>
            )}
          </Container>
        </section>
      )}

      <section className="bg-[#F6F2EA] py-20 text-[#1C2026] sm:py-28">
        <Container>
          <SectionHeading
            eyebrow="What to expect"
            title="A clear process from first click to final invoice."
            subtitle="The customer experience keeps the work, timing and price easy to understand."
            tone="light"
            align="center"
          />
          <div className="grid gap-10 md:grid-cols-3 md:gap-0">
            {EXPERIENCE_POINTS.map((point, index) => (
              <div key={point.number} className={`relative px-2 md:px-8 ${index > 0 ? "md:border-l md:border-slate-300" : ""}`}>
                <p className="font-display text-5xl text-accent-500/70">{point.number}</p>
                <h3 className="mt-5 text-xl font-semibold text-ink-900">{point.title}</h3>
                <p className="mt-3 text-base leading-7 text-slate-600">{point.body}</p>
              </div>
            ))}
          </div>
        </Container>
      </section>

      <section className="surface-light pb-20 sm:pb-28">
        <Container>
          <div className="relative overflow-hidden rounded-[1.25rem] bg-ink-900 px-7 py-12 sm:px-12 sm:py-16 lg:px-16">
            <div className="absolute inset-y-0 right-0 hidden w-2/5 bg-[linear-gradient(135deg,transparent,rgba(224,169,59,0.12))] lg:block" />
            <div className="relative grid items-end gap-10 lg:grid-cols-[1.3fr_0.7fr]">
              <div className="max-w-2xl">
                <p className="text-xs font-semibold uppercase tracking-[0.22em] text-accent-300">Commercial vehicle care</p>
                <h2 className="mt-5 font-display text-[2.9rem] leading-tight text-white sm:text-[3.5rem]">A more organized way to care for a working fleet.</h2>
                <p className="mt-5 max-w-xl text-[1.05rem] leading-8 text-ink-300">Explore recurring service options, fleet records, priority scheduling and consolidated invoicing for commercial clients.</p>
              </div>
              <div className="lg:text-right"><ButtonLink href="/fleet">Explore Commercial Services</ButtonLink></div>
            </div>
          </div>
        </Container>
      </section>

      <section className="relative overflow-hidden border-t border-white/10 bg-ink-950 py-24 text-center sm:py-32">
        <div className="hairline-gold absolute inset-x-0 top-0 h-px" />
        <Container>
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-accent-300">Your vehicle, thoughtfully cared for</p>
          <h2 className="mx-auto mt-5 max-w-3xl font-display text-5xl leading-[1.04] text-white sm:text-6xl">Ready for a cleaner, sharper finish?</h2>
          <p className="mx-auto mt-5 max-w-xl text-[1.05rem] leading-8 text-ink-300">Book a listed service online or share a few details for a personalized estimate.</p>
          <div className="mt-9 flex flex-col justify-center gap-3 sm:flex-row">
            <ButtonLink href="/book" className="px-9">Book an Appointment</ButtonLink>
            <ButtonLink href="/quote" variant="outline" className="px-9">Request a Quote</ButtonLink>
          </div>
        </Container>
      </section>
    </>
  );
}

/**
 * One half of the menu: what the group is, the products inside it, and the
 * two ways in. Both cards render from this so the detailing half and the
 * ceramic half cannot drift into looking like different kinds of offer.
 */
function MenuCard({
  imageSlug,
  eyebrow,
  title,
  blurb,
  products,
  primary,
  secondary,
}: {
  imageSlug: string;
  eyebrow: string;
  title: string;
  blurb: string;
  products: {
    key: string;
    name: string;
    href: string;
    priceCents: number | null;
    /** Condition the price depends on. Never rendered apart from the price. */
    priceNote: string | null;
  }[];
  primary: { href: string; label: string };
  secondary: { href: string; label: string };
}) {
  const notes = products.filter((product) => product.priceNote);
  return (
    <article className="group flex flex-col overflow-hidden rounded-[1.5rem] border border-[#DED8CE] bg-[#FFFEFB] shadow-[0_18px_50px_rgba(11,42,74,0.085)]">
      <ServiceImage slug={imageSlug} name={title} className="aspect-[16/9]" />
      <div className="flex flex-1 flex-col p-6 sm:p-8">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-accent-600">{eyebrow}</p>
        <h2 className="mt-3 font-display text-[2rem] leading-tight text-[#1C2026]">{title}</h2>
        <p className="mt-4 text-base leading-7 text-slate-600">{blurb}</p>
        <ul className="mt-6 divide-y divide-[#ECE7DE] border-y border-[#ECE7DE]">
          {products.map((product) => (
            <li key={product.key}>
              <Link
                href={product.href}
                className="flex items-center justify-between gap-4 py-3.5 transition-colors hover:text-accent-600"
              >
                <span className="font-semibold text-ink-900">{product.name}</span>
                <span className="shrink-0 text-sm font-semibold text-slate-600">
                  {product.priceCents !== null ? `From ${formatCents(product.priceCents)}` : "By quote"}
                  {product.priceNote && <span aria-hidden="true">*</span>}
                </span>
              </Link>
            </li>
          ))}
        </ul>
        {/* A conditional price never appears without the condition beside it. */}
        {notes.map((product) => (
          <p key={product.key} className="mt-4 text-xs leading-5 text-slate-500">
            *{product.priceNote}
          </p>
        ))}
        <div className="mt-auto flex flex-wrap gap-3 pt-7">
          <ButtonLink href={primary.href}>{primary.label}</ButtonLink>
          <ButtonLink href={secondary.href} variant="ghost" className="!text-ink-900 hover:!text-accent-600">
            {secondary.label}
          </ButtonLink>
        </div>
      </div>
    </article>
  );
}

function mediaUrl(item: { id: string; kind: string; contentType: string }) {
  const extension = item.contentType === "image/png" ? "png" : item.contentType === "image/webp" ? "webp" : "jpg";
  return `/media/results/${item.id}/${slugifySeoText(`hamilton-car-detailing-${item.kind}`)}-${item.id}.${extension}`;
}
