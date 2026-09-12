import Link from "next/link";
import type { Metadata } from "next";
import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import { StructuredData } from "@/components/structured-data";
import { formatCents, withTaxCents } from "@/lib/money";
import { absoluteUrl, BUSINESS_ENTITY_ID, PUBLIC_SITE_URL } from "@/lib/seo";
import { getSettings } from "@/lib/settings";
import { formatInZone } from "@/lib/tz";
import {
  activeWashOffer,
  FIRST_WASH_OFFER_PATH,
  washOfferPriceCents,
  washOfferTerms,
} from "@/lib/wash-offer";
import { ClaimForm } from "./claim-form";

export const dynamic = "force-dynamic";

const TITLE = "First Wash $15.99 in Hamilton | Personal Touch Car Detailing";
const DESCRIPTION =
  "New customers: your first 100% hand wash for $15.99 (SUVs, pickups and vans $17.99). No automatic brushes. Claim your code and book online in Hamilton, Ontario.";

/**
 * Indexable only while the offer is actually running. An advert for a finished
 * promotion is worse than no page at all, and this one can be switched off by
 * the owner at any moment without a deploy.
 */
export async function generateMetadata(): Promise<Metadata> {
  const settings = await getSettings();
  const offer = activeWashOffer(settings);
  return {
    title: { absolute: TITLE },
    description: DESCRIPTION,
    alternates: { canonical: FIRST_WASH_OFFER_PATH },
    robots: offer?.acceptingClaims ? { index: true, follow: true } : { index: false, follow: true },
    openGraph: {
      type: "website",
      locale: "en_CA",
      siteName: "Personal Touch Car Detailing",
      title: TITLE,
      description: DESCRIPTION,
      url: FIRST_WASH_OFFER_PATH,
      images: [{ url: "/og.png", width: 1200, height: 628, alt: "First wash offer — Personal Touch Car Detailing" }],
    },
    twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION, images: ["/og.png"] },
  };
}

/** The two sizes the page quotes, named as the catalogue names them. */
const CAR_CATEGORY = "sedan" as const;
const LARGE_CATEGORY = "suv_small" as const;

export default async function FirstWashOfferPage() {
  const settings = await getSettings();
  const offer = activeWashOffer(settings);

  const service = offer
    ? (
        await db()
          .select()
          .from(schema.services)
          .where(and(eq(schema.services.slug, offer.serviceSlug), eq(schema.services.active, true)))
          .limit(1)
      )[0]
    : undefined;

  // The regular prices come from the CATALOGUE, never from copy typed into this
  // page. A struck-through price is a savings claim, and Canadian advertising
  // law measures it against the price the business actually charges — so the
  // only safe source is the row the booking flow prices from.
  const adjustments = service
    ? await db()
        .select()
        .from(schema.serviceVehicleAdjustments)
        .where(
          and(
            eq(schema.serviceVehicleAdjustments.serviceId, service.id),
            inArray(schema.serviceVehicleAdjustments.vehicleCategory, [CAR_CATEGORY, LARGE_CATEGORY]),
          ),
        )
    : [];

  const carOfferCents = offer ? washOfferPriceCents(offer, CAR_CATEGORY) : null;
  const largeOfferCents = offer ? washOfferPriceCents(offer, LARGE_CATEGORY) : null;

  if (!offer || !service || service.basePriceCents === null || carOfferCents === null || largeOfferCents === null) {
    return <OfferClosed phone={settings.phone} />;
  }

  const regularFor = (category: string) =>
    service.basePriceCents! +
    (adjustments.find((row) => row.vehicleCategory === category)?.priceDeltaCents ?? 0);
  const carRegularCents = regularFor(CAR_CATEGORY);
  const largeRegularCents = regularFor(LARGE_CATEGORY);

  const money = (cents: number) => formatCents(cents, settings.currency);
  const carOffer = money(carOfferCents);
  const largeOffer = money(largeOfferCents);
  const carSaving = money(Math.max(0, carRegularCents - carOfferCents));

  const terms = washOfferTerms({
    businessName: settings.businessName,
    carRegularLabel: money(carRegularCents),
    carOfferLabel: carOffer,
    largeRegularLabel: money(largeRegularCents),
    largeOfferLabel: largeOffer,
    claimValidDays: offer.claimValidDays,
    taxLabel: settings.taxLabel,
    cardPriceLabel: money(withTaxCents(carOfferCents, settings.taxRateBp)),
    // Read from the raw setting: the resolved offer carries only whether claims
    // are still open, and the terms have to name the day.
    claimsCloseLabel: settings.washOffer.claimsCloseOn
      ? formatInZone(new Date(`${settings.washOffer.claimsCloseOn}T12:00:00Z`), settings.timezone, {
          weekday: "long",
          month: "long",
          day: "numeric",
        })
      : null,
  });

  const structuredData = {
    "@context": "https://schema.org",
    "@type": "Offer",
    name: offer.label,
    description: DESCRIPTION,
    url: absoluteUrl(FIRST_WASH_OFFER_PATH),
    priceCurrency: settings.currency,
    price: (carOfferCents / 100).toFixed(2),
    eligibleCustomerType: "https://schema.org/NewCustomer",
    availability: "https://schema.org/LimitedAvailability",
    offeredBy: { "@id": BUSINESS_ENTITY_ID },
    areaServed: { "@type": "City", name: "Hamilton" },
    itemOffered: { "@type": "Service", name: "Exterior hand wash" },
  };

  return (
    <>
      <StructuredData data={structuredData} />

      {/* ---------------------------------------------------------------- */}
      {/* Hero + the form. One screen, one decision.                        */}
      {/* ---------------------------------------------------------------- */}
      <header className="border-b border-white/10 bg-[#0A0A0B]">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-5 py-4 sm:px-8">
          <p className="text-sm font-black uppercase leading-tight tracking-[0.1em] text-white sm:text-base">
            {settings.businessName}
          </p>
          <a
            href={`tel:${settings.phone}`}
            className="min-h-11 shrink-0 rounded-lg border-2 border-[#FFE500] px-3 py-2 text-sm font-black text-[#FFE500] hover:bg-[#FFE500] hover:text-[#0A0A0B] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[#FFE500]/70"
          >
            {settings.phone}
          </a>
        </div>
      </header>

      <main className="bg-[#0A0A0B] text-white">
        <section className="mx-auto w-full max-w-6xl px-5 py-10 sm:px-8 sm:py-14">
          <div className="grid gap-10 lg:grid-cols-[1.05fr_minmax(23rem,1fr)] lg:items-start lg:gap-14">
            <div>
              <p className="inline-flex items-center rounded-full bg-[#E01B24] px-3.5 py-1.5 text-xs font-black uppercase tracking-[0.14em] text-white">
                New customers only · Hamilton
              </p>

              <h1 className="mt-5 text-[2.6rem] font-black leading-[0.95] tracking-[-0.03em] sm:text-6xl lg:text-[4.25rem]">
                Your first hand wash,
                <span className="mt-2 block text-[#FFE500]">{carOffer}</span>
              </h1>

              <p className="mt-5 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-lg text-white/70">
                <span className="text-2xl text-white/45 line-through">{money(carRegularCents)}</span>
                <span className="font-bold text-white">Save {carSaving} on a car.</span>
              </p>
              <p className="mt-2 text-lg leading-7 text-white/70">
                SUVs, pickups and vans <span className="font-bold text-white">{largeOffer}</span>{" "}
                <span className="text-white/45 line-through">{money(largeRegularCents)}</span>
              </p>

              <ul className="mt-7 space-y-2.5 text-lg">
                {[
                  "100% hand wash — no automatic brushes, ever",
                  "Exterior wash, dry and mats cleaned",
                  `${settings.yearsInBusinessLabel} on Upper James Street`,
                  "Book a real time online, no queueing",
                ].map((line) => (
                  <li key={line} className="flex items-start gap-3">
                    <span aria-hidden="true" className="mt-1 text-xl font-black text-[#FFE500]">
                      ✓
                    </span>
                    <span className="text-white/85">{line}</span>
                  </li>
                ))}
              </ul>

              <div className="mt-7 flex flex-wrap items-center gap-x-6 gap-y-3 border-t border-white/10 pt-6 text-sm">
                <span className="font-bold text-white">
                  <span className="text-[#FFE500]">★ {settings.googleReviewRating}</span> from{" "}
                  {settings.googleReviewCount} Google reviews
                </span>
                <span className="text-white/55">
                  {settings.addressLine1}, {settings.city}
                </span>
              </div>
            </div>

            {/*
              The form is the page. It sits in the first screen on every size
              rather than behind a "claim now" button that scrolls somewhere —
              a second tap before the first field is a second chance to leave.
            */}
            <div className="lg:sticky lg:top-8">
              <ClaimForm
                copy={{
                  carPriceLabel: carOffer,
                  largePriceLabel: largeOffer,
                  claimValidDays: offer.claimValidDays,
                  phone: settings.phone,
                  privacyNote:
                    "We use your name and number only to send this code and arrange your wash.",
                }}
              />
            </div>
          </div>
        </section>

        {/* -------------------------------------------------------------- */}
        {/* What the price does and does not buy. Said plainly, because a   */}
        {/* cheap wash that turns into an upsell at the counter is how a    */}
        {/* first visit becomes the last one.                              */}
        {/* -------------------------------------------------------------- */}
        <section className="border-y border-white/10 bg-[#121214]">
          <div className="mx-auto w-full max-w-6xl px-5 py-12 sm:px-8 sm:py-16">
            <h2 className="text-3xl font-black tracking-tight sm:text-4xl">Exactly what you get</h2>
            <div className="mt-8 grid gap-4 sm:grid-cols-2">
              <div className="rounded-2xl border-2 border-[#FFE500]/30 bg-[#FFE500]/[0.05] p-6">
                <p className="text-sm font-black uppercase tracking-[0.14em] text-[#FFE500]">Included</p>
                <ul className="mt-4 space-y-2.5 text-white/85">
                  {[
                    "Full exterior hand wash",
                    "Hand dry — no drying tunnel",
                    "Floor mats cleaned",
                    "Wheels and tyres rinsed",
                  ].map((item) => (
                    <li key={item} className="flex gap-3">
                      <span aria-hidden="true" className="font-black text-[#FFE500]">✓</span>
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
              <div className="rounded-2xl border-2 border-white/12 bg-white/[0.03] p-6">
                <p className="text-sm font-black uppercase tracking-[0.14em] text-white/55">Not included</p>
                <ul className="mt-4 space-y-2.5 text-white/65">
                  {[
                    "Interior cleaning or vacuuming",
                    "Wax, polish or paint correction",
                    "Engine bay cleaning",
                    "Commercial vehicles (quoted individually)",
                  ].map((item) => (
                    <li key={item} className="flex gap-3">
                      <span aria-hidden="true" className="font-black text-white/35">—</span>
                      {item}
                    </li>
                  ))}
                </ul>
                <p className="mt-5 text-sm leading-6 text-white/50">
                  Want any of these? Add them when you book and you will see the price before you
                  confirm. Nothing is ever added at the counter without asking you first.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* -------------------------------------------------------------- */}
        <section className="mx-auto w-full max-w-6xl px-5 py-12 sm:px-8 sm:py-16">
          <h2 className="text-3xl font-black tracking-tight sm:text-4xl">How it works</h2>
          <ol className="mt-8 grid gap-4 sm:grid-cols-3">
            {[
              ["1", "Claim your code", "Name and mobile number. Your code appears straight away, and we text a copy."],
              ["2", "Pick your time", `Book online with the code. Your ${carOffer} price is applied automatically before you confirm.`],
              ["3", "Bring it in", "We wash it by hand while you wait or leave it with us. Pay when it is done."],
            ].map(([step, title, body]) => (
              <li key={step} className="rounded-2xl border-2 border-white/12 bg-white/[0.03] p-6">
                <span className="inline-grid size-10 place-items-center rounded-full bg-[#FFE500] text-lg font-black text-[#0A0A0B]">
                  {step}
                </span>
                <h3 className="mt-4 text-xl font-black">{title}</h3>
                <p className="mt-2 text-sm leading-6 text-white/65">{body}</p>
              </li>
            ))}
          </ol>

          <div className="mt-10 rounded-2xl border-2 border-white/12 bg-white/[0.03] p-6 sm:p-8">
            <h2 className="text-2xl font-black">Why {carOffer}?</h2>
            <p className="mt-3 max-w-3xl text-base leading-7 text-white/70">
              Because the hardest part of our business is getting you to try us once. We have washed
              cars on Upper James for {settings.yearsInBusinessLabel.toLowerCase()}, entirely by hand,
              and the people who come once tend to come back. This is the cost of introducing
              ourselves — there is no catch, no membership, and nothing to cancel.
            </p>
          </div>
        </section>

        {/* -------------------------------------------------------------- */}
        <section className="border-t border-white/10 bg-[#121214]">
          <div className="mx-auto w-full max-w-6xl px-5 py-12 sm:px-8 sm:py-16">
            <h2 className="text-3xl font-black tracking-tight sm:text-4xl">Questions</h2>
            <div className="mt-8 grid gap-3 lg:grid-cols-2">
              {[
                [
                  "Is this really the full price?",
                  `Yes. ${carOffer} for a car, ${largeOffer} for an SUV, pickup or van, before ${settings.taxLabel}. Cash and Interac e-transfer pay exactly that; card and cheque add ${settings.taxLabel}. You see the total before you confirm the booking.`,
                ],
                [
                  "Do I have to buy anything else?",
                  "No. Extras are shown as optional choices while you book, with their prices. If we spot something worth mentioning we will tell you — we never add work without your say-so.",
                ],
                [
                  "How long does it take?",
                  "About an hour for a standard vehicle. You choose a real appointment time, so there is no waiting in a queue.",
                ],
                [
                  "Can I use it on a second car?",
                  "It is one promotional wash per customer and per vehicle — we record the plate at the shop. Your second car is very welcome at our normal prices.",
                ],
                [
                  "What if my car is filthy?",
                  "That is usually fine. If it needs noticeably more time we will say so before we start, and you decide.",
                ],
                [
                  "Do you use automatic brushes?",
                  "Never — not on this wash and not on any other. Everything here is washed by hand, which is the whole reason the shop exists.",
                ],
              ].map(([question, answer]) => (
                <details key={question} className="group rounded-xl border-2 border-white/12 bg-white/[0.03] p-5 open:border-[#FFE500]/40">
                  <summary className="cursor-pointer list-none text-lg font-bold marker:hidden focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[#FFE500]/70">
                    {question}
                    <span aria-hidden="true" className="float-right text-[#FFE500] transition group-open:rotate-45">
                      +
                    </span>
                  </summary>
                  <p className="mt-3 text-sm leading-6 text-white/65">{answer}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        {/* -------------------------------------------------------------- */}
        {/* The offer's material terms. Required, and written to be read.   */}
        {/* -------------------------------------------------------------- */}
        <section className="mx-auto w-full max-w-6xl px-5 py-12 sm:px-8 sm:py-16">
          <h2 className="text-2xl font-black">Offer terms</h2>
          <ul className="mt-5 grid gap-2.5 text-sm leading-6 text-white/60 lg:grid-cols-2">
            {terms.map((term) => (
              <li key={term} className="flex gap-3">
                <span aria-hidden="true" className="text-white/30">•</span>
                <span>{term}</span>
              </li>
            ))}
          </ul>
        </section>
      </main>

      {/* CASL and plain trust: who is offering this, where they are, and how */}
      {/* to reach them, on the same page as the offer itself.               */}
      <footer className="border-t border-white/10 bg-[#0A0A0B]">
        <div className="mx-auto w-full max-w-6xl px-5 py-10 text-sm text-white/50 sm:px-8">
          <p className="font-bold text-white">{settings.businessName}</p>
          {settings.legalEntityName && <p className="mt-1">{settings.legalEntityName}</p>}
          <address className="mt-2 not-italic leading-6">
            {settings.addressLine1}, {settings.city}, {settings.province} {settings.postalCode}
            <br />
            <a href={`tel:${settings.phone}`} className="hover:text-white">{settings.phone}</a>
            {settings.email && (
              <>
                {" · "}
                <a href={`mailto:${settings.email}`} className="break-all hover:text-white">{settings.email}</a>
              </>
            )}
          </address>
          <div className="mt-5 flex flex-wrap gap-x-5 gap-y-2">
            <Link href="/policies/privacy" className="hover:text-white">Privacy</Link>
            <Link href="/policies/terms" className="hover:text-white">Service terms</Link>
            <Link href="/policies/cancellation" className="hover:text-white">Cancellation</Link>
            <Link href="/services" className="hover:text-white">All services</Link>
            <a href={PUBLIC_SITE_URL} className="hover:text-white">Main site</a>
          </div>
          <p className="mt-5 text-xs">
            © {new Date().getFullYear()} {settings.businessName}. All rights reserved.
          </p>
        </div>
      </footer>
    </>
  );
}

/**
 * The offer is switched off, or the catalogue cannot price it. Shown rather
 * than 404ing, because the ad that sent this visitor here may still be live for
 * hours after the owner flips the switch, and a dead end is a wasted click.
 */
function OfferClosed({ phone }: { phone: string }) {
  return (
    <main className="grid min-h-screen place-items-center bg-[#0A0A0B] px-5 py-16 text-center text-white">
      <div className="max-w-md">
        <h1 className="text-3xl font-black">This offer has finished</h1>
        <p className="mt-4 text-base leading-7 text-white/65">
          Our new-customer wash promotion is not running at the moment. We would still be glad to
          look after your vehicle — our full price list is online, and you can book in a minute.
        </p>
        <div className="mt-8 grid gap-2.5">
          <Link
            href="/book"
            className="inline-flex min-h-14 items-center justify-center rounded-xl bg-[#FFE500] px-6 text-lg font-black text-[#0A0A0B]"
          >
            Book a wash
          </Link>
          <a
            href={`tel:${phone}`}
            className="inline-flex min-h-14 items-center justify-center rounded-xl border-2 border-white/25 px-6 text-base font-bold text-white"
          >
            Call {phone}
          </a>
        </div>
      </div>
    </main>
  );
}
