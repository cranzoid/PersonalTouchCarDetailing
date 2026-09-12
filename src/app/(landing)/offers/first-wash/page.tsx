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
  "New customers: your first 100% hand wash for $15.99 — car, SUV, pickup or van, one price. No automatic brushes. Claim your code and book online in Hamilton, Ontario.";

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

/**
 * The two sizes the page quotes, named as the catalogue names them. The offer
 * charges one price for both, but the catalogue does not — $30 and $35 — and a
 * savings claim has to be measured against each.
 */
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

  // One price whatever you drive — the decision this page is built around. It
  // is still READ from the per-size map rather than assumed, because those
  // prices are editable in Admin: if somebody ever sets them apart again, the
  // page quotes the HIGHER figure and drops the "any vehicle" claim, so the
  // advertised price stays one nobody can be charged above.
  const onePrice = carOfferCents === largeOfferCents;
  const offerCents = Math.max(carOfferCents, largeOfferCents);
  const offerLabel = money(offerCents);
  const carSavingCents = Math.max(0, carRegularCents - carOfferCents);
  const largeSavingCents = Math.max(0, largeRegularCents - largeOfferCents);
  const savingLabel =
    carSavingCents === largeSavingCents
      ? `Save ${money(carSavingCents)}`
      : `Save ${money(carSavingCents)}–${money(largeSavingCents)}`;

  const terms = washOfferTerms({
    businessName: settings.businessName,
    carRegularLabel: money(carRegularCents),
    carOfferLabel: money(carOfferCents),
    largeRegularLabel: money(largeRegularCents),
    largeOfferLabel: money(largeOfferCents),
    claimValidDays: offer.claimValidDays,
    taxLabel: settings.taxLabel,
    cardPriceLabel: money(withTaxCents(offerCents, settings.taxRateBp)),
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
    price: (offerCents / 100).toFixed(2),
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
      <header className="border-b border-white/10 bg-ink-950">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-5 py-4 sm:px-8">
          <p className="text-sm font-semibold uppercase leading-tight tracking-[0.16em] text-white sm:text-base">
            {settings.businessName}
          </p>
          <a
            href={`tel:${settings.phone}`}
            className="min-h-11 shrink-0 rounded-lg border border-accent-400 px-3.5 py-2 text-sm font-semibold text-accent-300 transition hover:bg-accent-400 hover:text-ink-950 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-accent-500/60"
          >
            {settings.phone}
          </a>
        </div>
      </header>

      <main className="bg-ink-950 text-ink-100">
        {/* The gold wash behind the hero is the site's own accent, kept faint:
            it lifts the fold without competing with the ivory form card. */}
        <section className="relative isolate overflow-hidden">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 bg-[radial-gradient(1100px_520px_at_12%_-10%,rgba(224,169,59,0.16),transparent_62%),linear-gradient(180deg,#0B2A4A_0%,#061A2C_58%)]"
          />
          <div className="relative mx-auto w-full max-w-6xl px-5 py-10 sm:px-8 sm:py-14">
            <div className="grid gap-10 lg:grid-cols-[1.05fr_minmax(23rem,1fr)] lg:items-start lg:gap-14">
              <div>
                <p className="flex items-center gap-3 text-xs font-semibold uppercase tracking-[0.24em] text-accent-300">
                  <span aria-hidden="true" className="h-px w-10 bg-accent-400" />
                  New customers only · Hamilton
                </p>

                <h1 className="mt-5 font-display text-[3rem] leading-[0.95] tracking-[-0.035em] text-white sm:text-6xl lg:text-[4.5rem]">
                  Your first hand wash,
                  <span className="mt-1 block text-accent-300">{offerLabel}</span>
                </h1>

                {onePrice ? (
                  <p className="mt-5 text-xl font-semibold text-white sm:text-2xl">
                    Car, SUV, pickup or van — one price.
                  </p>
                ) : (
                  <p className="mt-5 text-xl font-semibold text-white sm:text-2xl">
                    {money(carOfferCents)} for a car, {money(largeOfferCents)} for an SUV, pickup or van.
                  </p>
                )}

                <p className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-lg text-ink-200">
                  <span className="text-ink-300 line-through">{money(carRegularCents)} car</span>
                  <span className="text-ink-300 line-through">{money(largeRegularCents)} SUV</span>
                  <span className="rounded-full bg-accent-400/15 px-3 py-1 text-base font-semibold text-accent-300">
                    {savingLabel}
                  </span>
                </p>

                <ul className="mt-7 space-y-2.5 text-lg">
                  {[
                    "100% hand wash — no automatic brushes, ever",
                    "Exterior wash, dry and mats cleaned",
                    "Same price whatever you drive",
                    `${settings.yearsInBusinessLabel} on Upper James Street`,
                  ].map((line) => (
                    <li key={line} className="flex items-start gap-3">
                      <span
                        aria-hidden="true"
                        className="mt-1 grid size-5 shrink-0 place-items-center rounded-full bg-accent-400 text-[0.7rem] font-black text-ink-950"
                      >
                        ✓
                      </span>
                      <span className="text-ink-100">{line}</span>
                    </li>
                  ))}
                </ul>

                <div className="mt-7 flex flex-wrap items-center gap-x-6 gap-y-3 border-t border-white/10 pt-6 text-sm">
                  <span className="font-semibold text-white">
                    <span className="text-accent-300">★ {settings.googleReviewRating}</span> from{" "}
                    {settings.googleReviewCount} Google reviews
                  </span>
                  <span className="text-ink-300">
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
                    priceLabel: offerLabel,
                    claimValidDays: offer.claimValidDays,
                    phone: settings.phone,
                    privacyNote:
                      "We use your name and number only to send this code and arrange your wash.",
                  }}
                />
              </div>
            </div>
          </div>
        </section>

        {/* -------------------------------------------------------------- */}
        {/* What the price does and does not buy. Said plainly, because a   */}
        {/* cheap wash that turns into an upsell at the counter is how a    */}
        {/* first visit becomes the last one.                              */}
        {/* -------------------------------------------------------------- */}
        <section className="surface-light">
          <div className="mx-auto w-full max-w-6xl px-5 py-14 sm:px-8 sm:py-20">
            <p className="flex items-center gap-3 text-xs font-semibold uppercase tracking-[0.24em] text-accent-600">
              <span aria-hidden="true" className="h-px w-10 bg-accent-500" />
              No surprises
            </p>
            <h2 className="mt-4 font-display text-4xl leading-tight tracking-[-0.02em] text-ink-950 sm:text-5xl">
              Exactly what you get
            </h2>
            <div className="mt-8 grid gap-4 sm:grid-cols-2">
              <div className="rounded-2xl border-t-4 border-accent-400 bg-white p-6 shadow-[0_18px_40px_-28px_rgba(6,26,44,0.6)]">
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-accent-600">Included</p>
                <ul className="mt-4 space-y-2.5 text-ink-900">
                  {[
                    "Full exterior hand wash",
                    "Hand dry — no drying tunnel",
                    "Floor mats cleaned",
                    "Wheels and tyres rinsed",
                  ].map((item) => (
                    <li key={item} className="flex gap-3">
                      <span
                        aria-hidden="true"
                        className="mt-1 grid size-5 shrink-0 place-items-center rounded-full bg-accent-400 text-[0.7rem] font-black text-ink-950"
                      >
                        ✓
                      </span>
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
              <div className="rounded-2xl border-t-4 border-ink-300 bg-white/60 p-6">
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-ink-500">Not included</p>
                <ul className="mt-4 space-y-2.5 text-ink-700">
                  {[
                    "Interior cleaning or vacuuming",
                    "Wax, polish or paint correction",
                    "Engine bay cleaning",
                    "Commercial vehicles (quoted individually)",
                  ].map((item) => (
                    <li key={item} className="flex gap-3">
                      <span aria-hidden="true" className="font-semibold text-ink-400">—</span>
                      {item}
                    </li>
                  ))}
                </ul>
                <p className="mt-5 text-sm leading-6 text-ink-500">
                  Want any of these? Add them when you book and you will see the price before you
                  confirm. Nothing is ever added at the counter without asking you first.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* -------------------------------------------------------------- */}
        <section className="bg-ink-900">
          <div className="mx-auto w-full max-w-6xl px-5 py-14 sm:px-8 sm:py-20">
            <h2 className="font-display text-4xl leading-tight tracking-[-0.02em] text-white sm:text-5xl">
              How it works
            </h2>
            <ol className="mt-8 grid gap-4 sm:grid-cols-3">
              {[
                ["1", "Claim your code", "Name and mobile number. Your code appears straight away, and we text a copy."],
                ["2", "Pick your time", `Book online with the code. Your ${offerLabel} price is applied automatically before you confirm.`],
                ["3", "Bring it in", "We wash it by hand while you wait or leave it with us. Pay when it is done."],
              ].map(([step, title, body]) => (
                <li key={step} className="rounded-2xl border border-white/12 bg-white/[0.04] p-6">
                  <span className="inline-grid size-10 place-items-center rounded-full bg-accent-400 font-display text-xl text-ink-950">
                    {step}
                  </span>
                  <h3 className="mt-4 font-display text-2xl leading-tight text-white">{title}</h3>
                  <p className="mt-2 text-sm leading-6 text-ink-200">{body}</p>
                </li>
              ))}
            </ol>

            <div className="mt-10 rounded-2xl border-l-4 border-accent-400 bg-ink-950/60 p-6 sm:p-8">
              <h2 className="font-display text-3xl leading-tight text-white">Why {offerLabel}?</h2>
              <p className="mt-3 max-w-3xl text-base leading-7 text-ink-200">
                Because the hardest part of our business is getting you to try us once. We have washed
                cars on Upper James for {settings.yearsInBusinessLabel.toLowerCase()}, entirely by hand,
                and the people who come once tend to come back. This is the cost of introducing
                ourselves — there is no catch, no membership, and nothing to cancel.
                {onePrice
                  ? " An SUV takes us longer than a car and always has, which is why the catalogue charges more for one. On this wash we are not charging you for the difference."
                  : ""}
              </p>
            </div>
          </div>
        </section>

        {/* -------------------------------------------------------------- */}
        <section className="surface-light">
          <div className="mx-auto w-full max-w-6xl px-5 py-14 sm:px-8 sm:py-20">
            <h2 className="font-display text-4xl leading-tight tracking-[-0.02em] text-ink-950 sm:text-5xl">
              Questions
            </h2>
            <div className="mt-8 grid gap-3 lg:grid-cols-2">
              {[
                [
                  "Is this really the full price?",
                  `Yes. ${offerLabel} for a coupe, sedan, SUV, pickup or van, before ${settings.taxLabel}. Cash and Interac e-transfer pay exactly that; card and cheque add ${settings.taxLabel}. You see the total before you confirm the booking.`,
                ],
                [
                  "Is an SUV or truck more?",
                  onePrice
                    ? "Not on this offer. Our regular prices do charge more for a larger vehicle, because it takes longer — but your first wash with us is the same price whatever you drive."
                    : `An SUV, pickup or van is ${money(largeOfferCents)} on this offer, against ${money(carOfferCents)} for a coupe or sedan.`,
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
                <details
                  key={question}
                  className="group rounded-xl border border-ink-300 bg-white p-5 open:border-accent-400"
                >
                  <summary className="cursor-pointer list-none text-lg font-semibold text-ink-950 marker:hidden focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-accent-500/50">
                    {question}
                    <span aria-hidden="true" className="float-right text-accent-600 transition group-open:rotate-45">
                      +
                    </span>
                  </summary>
                  <p className="mt-3 text-sm leading-6 text-ink-700">{answer}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        {/* -------------------------------------------------------------- */}
        {/* The offer's material terms. Required, and written to be read.   */}
        {/* -------------------------------------------------------------- */}
        <section className="mx-auto w-full max-w-6xl px-5 py-14 sm:px-8 sm:py-16">
          <h2 className="font-display text-3xl text-white">Offer terms</h2>
          <ul className="mt-5 grid gap-2.5 text-sm leading-6 text-ink-300 lg:grid-cols-2">
            {terms.map((term) => (
              <li key={term} className="flex gap-3">
                <span aria-hidden="true" className="text-accent-500">•</span>
                <span>{term}</span>
              </li>
            ))}
          </ul>
        </section>
      </main>

      {/* CASL and plain trust: who is offering this, where they are, and how */}
      {/* to reach them, on the same page as the offer itself.               */}
      <footer className="border-t border-white/10 bg-ink-900">
        <div className="mx-auto w-full max-w-6xl px-5 py-10 text-sm text-ink-300 sm:px-8">
          <p className="font-semibold text-white">{settings.businessName}</p>
          {settings.legalEntityName && <p className="mt-1">{settings.legalEntityName}</p>}
          <address className="mt-2 not-italic leading-6">
            {settings.addressLine1}, {settings.city}, {settings.province} {settings.postalCode}
            <br />
            <a href={`tel:${settings.phone}`} className="hover:text-accent-300">{settings.phone}</a>
            {settings.email && (
              <>
                {" · "}
                <a href={`mailto:${settings.email}`} className="break-all hover:text-accent-300">{settings.email}</a>
              </>
            )}
          </address>
          <div className="mt-5 flex flex-wrap gap-x-5 gap-y-2">
            <Link href="/policies/privacy" className="hover:text-accent-300">Privacy</Link>
            <Link href="/policies/terms" className="hover:text-accent-300">Service terms</Link>
            <Link href="/policies/cancellation" className="hover:text-accent-300">Cancellation</Link>
            <Link href="/services" className="hover:text-accent-300">All services</Link>
            <a href={PUBLIC_SITE_URL} className="hover:text-accent-300">Main site</a>
          </div>
          <p className="mt-5 text-xs text-ink-400">
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
    <main className="grid min-h-screen place-items-center bg-ink-950 px-5 py-16 text-center text-ink-100">
      <div className="max-w-md">
        <h1 className="font-display text-4xl leading-tight text-white">This offer has finished</h1>
        <p className="mt-4 text-base leading-7 text-ink-200">
          Our new-customer wash promotion is not running at the moment. We would still be glad to
          look after your vehicle — our full price list is online, and you can book in a minute.
        </p>
        <div className="mt-8 grid gap-2.5">
          <Link
            href="/book"
            className="inline-flex min-h-14 items-center justify-center rounded-xl bg-accent-400 px-6 text-lg font-bold text-ink-950 transition hover:bg-accent-300"
          >
            Book a wash
          </Link>
          <a
            href={`tel:${phone}`}
            className="inline-flex min-h-14 items-center justify-center rounded-xl border border-ink-500 px-6 text-base font-semibold text-ink-100 transition hover:border-accent-400 hover:text-accent-300"
          >
            Call {phone}
          </a>
        </div>
      </div>
    </main>
  );
}
