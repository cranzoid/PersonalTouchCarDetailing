import Image from "next/image";
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
  "New customers: your first 100% hand wash for $15.99 — car, SUV, pickup or van, one price. Claim your code and book online in Hamilton, Ontario.";

export async function generateMetadata(): Promise<Metadata> {
  const offer = activeWashOffer(await getSettings());
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
      images: [{ url: "/images/services/hand-wash.png", width: 1450, height: 1086, alt: "Hand washing a vehicle" }],
    },
    twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION, images: ["/images/services/hand-wash.png"] },
  };
}

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

  const adjustments = service
    ? await db()
        .select()
        .from(schema.serviceVehicleAdjustments)
        .where(and(eq(schema.serviceVehicleAdjustments.serviceId, service.id), inArray(schema.serviceVehicleAdjustments.vehicleCategory, [CAR_CATEGORY, LARGE_CATEGORY])))
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
  const onePrice = carOfferCents === largeOfferCents;
  const offerCents = Math.max(carOfferCents, largeOfferCents);
  const offerLabel = money(offerCents);
  const savings = [carRegularCents - carOfferCents, largeRegularCents - largeOfferCents].map((value) => Math.max(0, value));
  const savingLabel = savings[0] === savings[1] ? `Save ${money(savings[0])}` : `Save ${money(savings[0])}–${money(savings[1])}`;
  const address = `${settings.addressLine1}, ${settings.city}, ${settings.province} ${settings.postalCode}`;

  const terms = washOfferTerms({
    businessName: settings.businessName,
    carRegularLabel: money(carRegularCents),
    carOfferLabel: money(carOfferCents),
    largeRegularLabel: money(largeRegularCents),
    largeOfferLabel: money(largeOfferCents),
    claimValidDays: offer.claimValidDays,
    taxLabel: settings.taxLabel,
    priceWithTaxLabel: money(withTaxCents(offerCents, settings.taxRateBp)),
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
    areaServed: { "@type": "City", name: settings.city },
    itemOffered: { "@type": "Service", name: "Exterior hand wash" },
  };

  return (
    <div className="min-h-screen bg-[#F2F6F5] text-[#071419]">
      <StructuredData data={structuredData} />

      <header className="bg-[#071419] text-white">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3 sm:px-7">
          <p className="text-xs font-black uppercase tracking-[0.16em] sm:text-sm">{settings.businessName}</p>
          <a href={`tel:${settings.phone}`} className="rounded-full border border-[#4DE3F2]/60 px-4 py-2 text-xs font-bold text-[#BDF8FE] transition hover:bg-[#4DE3F2] hover:text-[#071419] sm:text-sm">
            Call {settings.phone}
          </a>
        </div>
      </header>

      <main>
        <section className="relative isolate overflow-hidden bg-[#0B2429] text-white">
          <div aria-hidden="true" className="absolute inset-0 bg-[radial-gradient(circle_at_15%_8%,rgba(77,227,242,0.2),transparent_34%),radial-gradient(circle_at_85%_68%,rgba(223,255,69,0.13),transparent_30%)]" />
          <div className="relative mx-auto grid max-w-7xl gap-8 px-4 pb-12 pt-8 sm:px-7 sm:pb-16 sm:pt-12 lg:grid-cols-[minmax(0,1.15fr)_minmax(23rem,0.85fr)] lg:items-start lg:gap-10">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-full bg-[#DFFF45] px-3 py-1.5 text-[0.68rem] font-black uppercase tracking-[0.14em] text-[#071419]">New customers</span>
                <span className="rounded-full border border-white/20 px-3 py-1.5 text-[0.68rem] font-black uppercase tracking-[0.14em] text-white/80">Hamilton only</span>
              </div>

              <h1 className="mt-5 max-w-3xl text-[clamp(2.7rem,9vw,6.6rem)] font-black leading-[0.86] tracking-[-0.065em]">
                Your car called.
                <span className="block text-[#4DE3F2]">It wants a wash.</span>
              </h1>

              <div className="mt-7 flex flex-wrap items-end gap-x-5 gap-y-3">
                <p className="text-[clamp(4.5rem,16vw,8.5rem)] font-black leading-[0.72] tracking-[-0.08em] text-[#DFFF45]">{offerLabel}</p>
                <div className="pb-1 text-sm font-bold text-white/70 sm:text-base">
                  <p className="line-through">Regularly {money(carRegularCents)}–{money(largeRegularCents)}</p>
                  <p className="mt-1 text-[#DFFF45]">{savingLabel} · first visit</p>
                </div>
              </div>

              <p className="mt-6 max-w-2xl text-xl font-bold leading-snug sm:text-2xl">
                {onePrice ? "Car, SUV, pickup or van. One simple price." : `${money(carOfferCents)} for a car. ${money(largeOfferCents)} for an SUV, pickup or van.`}
              </p>
              <p className="mt-2 text-base text-white/70">100% hand washed. No tunnel. No brushes. No membership.</p>

              <div className="relative mt-8 overflow-hidden rounded-[1.75rem] border border-white/15 shadow-[0_32px_80px_-35px_rgba(0,0,0,0.9)]">
                <Image
                  src="/images/services/hand-wash.png"
                  alt="A vehicle being carefully washed by hand"
                  width={1450}
                  height={1086}
                  priority
                  sizes="(min-width: 1024px) 58vw, 100vw"
                  className="aspect-[16/10] w-full object-cover object-center"
                />
                <div className="absolute inset-x-0 bottom-0 flex flex-wrap justify-between gap-2 bg-gradient-to-t from-black/90 via-black/55 to-transparent px-5 pb-5 pt-16 text-xs font-bold sm:px-6 sm:pb-6 sm:text-sm">
                  <span>✓ Exterior hand wash</span>
                  <span>✓ Hand dry</span>
                  <span>✓ Wheels &amp; tyres rinsed</span>
                </div>
              </div>
            </div>

            <aside className="lg:sticky lg:top-5">
              <ClaimForm copy={{
                flow: offer.flow,
                priceLabel: offerLabel,
                priceWithTaxLabel: money(withTaxCents(offerCents, settings.taxRateBp)),
                priceValue: offerCents / 100,
                currency: settings.currency,
                claimValidDays: offer.claimValidDays,
                phone: settings.phone,
                businessName: settings.businessName,
                email: settings.email,
                address,
                taxLabel: settings.taxLabel,
                timezone: settings.timezone,
                maxBookingWindowDays: settings.maxBookingWindowDays,
                offerTerms: terms,
              }} />
              <div className="mt-4 grid grid-cols-3 gap-2 text-center text-[0.66rem] font-bold text-white/75 sm:text-xs">
                <p className="rounded-xl border border-white/10 bg-white/[0.04] px-2 py-3"><span className="block text-base text-[#4DE3F2]">★ {settings.googleReviewRating}</span>{settings.googleReviewCount} reviews</p>
                <p className="rounded-xl border border-white/10 bg-white/[0.04] px-2 py-3"><span className="block text-base text-[#4DE3F2]">{settings.yearsInBusinessLabel}</span>local care</p>
                <p className="rounded-xl border border-white/10 bg-white/[0.04] px-2 py-3"><span className="block text-base text-[#4DE3F2]">100%</span>hand wash</p>
              </div>
            </aside>
          </div>
        </section>

        <section className="mx-auto max-w-7xl px-4 py-12 sm:px-7 sm:py-16">
          <div className="grid gap-8 lg:grid-cols-[0.75fr_1.25fr] lg:items-start">
            <div>
              <p className="text-xs font-black uppercase tracking-[0.18em] text-[#087B87]">Nothing hidden</p>
              <h2 className="mt-3 text-4xl font-black leading-none tracking-[-0.045em] sm:text-5xl">A clean car.<br />A clear deal.</h2>
              <p className="mt-5 max-w-md leading-7 text-[#526267]">We want you to try us once. That is the whole offer—no subscription and no awkward upsell when you arrive.</p>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              {(offer.flow === "book_first"
                ? [
                    ["01", "Tell us about you", "Your name, number and whether you drive a car or something bigger."],
                    ["02", "Pick your time", `Choose from what is actually free. The ${offerLabel} price is shown before you confirm.`],
                    ["03", "Drive in", "Show the code on your phone. We wash by hand, and you pay when it is finished."],
                  ]
                : [
                    ["01", "Claim the code", "Enter your details. The code appears immediately and arrives by text and email."],
                    ["02", "Choose a time", `Continue to booking. The ${offerLabel} price is applied before you confirm.`],
                    ["03", "Drive in", "We wash by hand. Pay when it is finished."],
                  ]
              ).map(([number, title, body]) => (
                <article key={number} className="rounded-2xl border border-[#D5DFE0] bg-white p-5 shadow-[0_16px_45px_-35px_rgba(7,20,25,0.7)]">
                  <span className="text-sm font-black text-[#087B87]">{number}</span>
                  <h3 className="mt-8 text-xl font-black">{title}</h3>
                  <p className="mt-2 text-sm leading-6 text-[#526267]">{body}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="bg-[#C8F8FB]">
          <div className="mx-auto grid max-w-7xl gap-8 px-4 py-12 sm:px-7 sm:py-16 lg:grid-cols-2">
            <div className="rounded-[1.5rem] bg-[#071419] p-6 text-white sm:p-8">
              <p className="text-xs font-black uppercase tracking-[0.18em] text-[#4DE3F2]">Included</p>
              <h2 className="mt-3 text-3xl font-black">The essentials, done by hand.</h2>
              <ul className="mt-6 grid gap-3 text-sm sm:grid-cols-2">
                {["Full exterior hand wash", "Careful hand dry", "Wheels and tyres rinsed"].map((item) => (
                  <li key={item} className="flex gap-2"><span className="text-[#DFFF45]">●</span>{item}</li>
                ))}
              </ul>
            </div>
            <div className="p-1 sm:p-5">
              <p className="text-xs font-black uppercase tracking-[0.18em] text-[#087B87]">Good to know</p>
              <h2 className="mt-3 text-3xl font-black">No surprise extras.</h2>
              <p className="mt-4 leading-7 text-[#3E5055]">Floor-mat and other interior cleaning, waxing, paint correction and engine-bay cleaning are not included. You can add services during booking and see their prices first. Commercial vehicles are quoted separately.</p>
              <a href="#claim" className="mt-6 inline-flex min-h-12 items-center rounded-full bg-[#071419] px-6 font-black text-white transition hover:bg-[#14373D]">
                {offer.flow === "book_first" ? "Book my wash ↑" : "Claim my code ↑"}
              </a>
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-4xl px-4 py-12 sm:px-7 sm:py-16">
          <h2 className="text-center text-3xl font-black tracking-[-0.035em] sm:text-4xl">Quick questions</h2>
          <div className="mt-7 space-y-2.5">
            {[
              ["Is this really the full price?", `Yes—${offerLabel} before ${settings.taxLabel}.`],
              ["Is an SUV or truck more?", onePrice ? "No. The offer price is the same for a coupe, sedan, SUV, pickup or van." : `SUVs, pickups and vans are ${money(largeOfferCents)}; coupes and sedans are ${money(carOfferCents)}.`],
              ["How long does it take?", "About 15 minutes for a standard vehicle. You choose an appointment time, so there is no wash-line wait."],
              ["Can I use it on a second car?", "The promotion is one wash per new customer and per vehicle. Additional vehicles are welcome at regular prices."],
            ].map(([question, answer]) => (
              <details key={question} className="group rounded-2xl border border-[#D5DFE0] bg-white px-5 py-4 open:border-[#75CCD3]">
                <summary className="cursor-pointer list-none font-black">{question}<span aria-hidden="true" className="float-right text-[#087B87] group-open:rotate-45">+</span></summary>
                <p className="mt-3 pr-6 text-sm leading-6 text-[#526267]">{answer}</p>
              </details>
            ))}
          </div>
        </section>
      </main>

      <footer className="bg-[#071419] text-white/65">
        <div className="mx-auto flex max-w-7xl flex-col justify-between gap-5 px-4 py-9 text-xs sm:flex-row sm:px-7">
          <div><p className="font-black text-white">{settings.businessName}</p><p className="mt-1">{address}</p></div>
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            <Link href="/policies/terms" className="hover:text-[#4DE3F2]">Terms</Link>
            <Link href="/policies/privacy" className="hover:text-[#4DE3F2]">Privacy</Link>
            <Link href="/policies/cancellation" className="hover:text-[#4DE3F2]">Cancellation</Link>
            <a href={PUBLIC_SITE_URL} className="hover:text-[#4DE3F2]">Main site</a>
          </div>
        </div>
      </footer>
    </div>
  );
}

function OfferClosed({ phone }: { phone: string }) {
  return (
    <main className="grid min-h-screen place-items-center bg-[#071419] px-5 py-16 text-center text-white">
      <div className="max-w-md">
        <p className="text-xs font-black uppercase tracking-[0.18em] text-[#4DE3F2]">Offer update</p>
        <h1 className="mt-4 text-4xl font-black leading-tight">This offer has finished</h1>
        <p className="mt-4 leading-7 text-white/70">Our full wash and detailing menu is still available online.</p>
        <div className="mt-8 grid gap-2.5">
          <Link href="/book" className="inline-flex min-h-14 items-center justify-center rounded-xl bg-[#DFFF45] px-6 text-lg font-black text-[#071419]">Book a wash</Link>
          <a href={`tel:${phone}`} className="inline-flex min-h-14 items-center justify-center rounded-xl border border-white/30 px-6 font-bold">Call {phone}</a>
        </div>
      </div>
    </main>
  );
}
