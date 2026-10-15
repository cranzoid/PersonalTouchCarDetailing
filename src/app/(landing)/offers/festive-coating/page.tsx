import Image from "next/image";
import Link from "next/link";
import type { Metadata } from "next";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { coatingPackage } from "@/lib/ceramic";
import {
  FESTIVE_COATING_OFFER_CENTS,
  FESTIVE_COATING_OFFER_PATH,
  FESTIVE_COATING_SERVICE_SLUG,
  festiveRegularPrices,
} from "@/lib/festive-coating-offer";
import { formatCents } from "@/lib/money";
import { PUBLIC_SITE_URL } from "@/lib/seo";
import { getSettings } from "@/lib/settings";
import { FestiveRequestForm } from "./request-form";

export const dynamic = "force-dynamic";

const PRICE = `$${FESTIVE_COATING_OFFER_CENTS / 100}`;
const TITLE = `Navratri & Diwali Special: Ceramic Coating ${PRICE} | Personal Touch Car Detailing`;
const DESCRIPTION =
  `New car this festive season? Get our Crystal ceramic coating for ${PRICE} — car, SUV, pickup or van. Request a call back in Hamilton.`;

/**
 * Reached only from the QR code, so it is kept out of search: no index, no
 * sitemap entry. The Open Graph tags still matter — the link itself gets pasted
 * into the same WhatsApp groups, and that preview is the first thing seen.
 */
export const metadata: Metadata = {
  title: { absolute: TITLE },
  description: DESCRIPTION,
  robots: { index: false, follow: false },
  openGraph: {
    type: "website",
    locale: "en_CA",
    siteName: "Personal Touch Car Detailing",
    title: `Navratri & Diwali Special — Ceramic Coating ${PRICE}`,
    description: DESCRIPTION,
    url: FESTIVE_COATING_OFFER_PATH,
    images: [{ url: "/images/services/ceramic-coating.png", width: 1448, height: 1086, alt: "A freshly ceramic-coated car with a deep gloss" }],
  },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION, images: ["/images/services/ceramic-coating.png"] },
};

export default async function FestiveCoatingOfferPage() {
  const settings = await getSettings();
  const [service] = await db()
    .select({ id: schema.services.id, basePriceCents: schema.services.basePriceCents })
    .from(schema.services)
    .where(and(eq(schema.services.slug, FESTIVE_COATING_SERVICE_SLUG), eq(schema.services.active, true)))
    .limit(1);
  const adjustments = service
    ? await db()
        .select({
          vehicleCategory: schema.serviceVehicleAdjustments.vehicleCategory,
          priceDeltaCents: schema.serviceVehicleAdjustments.priceDeltaCents,
        })
        .from(schema.serviceVehicleAdjustments)
        .where(eq(schema.serviceVehicleAdjustments.serviceId, service.id))
    : [];
  const regular = festiveRegularPrices(service?.basePriceCents ?? null, adjustments);

  const money = (cents: number) => formatCents(cents, settings.currency).replace(/\.00$/, "");
  const offerLabel = money(FESTIVE_COATING_OFFER_CENTS);
  const savings = [regular.carCents, regular.largeCents]
    .filter((cents): cents is number => cents !== null)
    .map((cents) => cents - FESTIVE_COATING_OFFER_CENTS);
  const savingLabel =
    savings.length === 0
      ? null
      : Math.min(...savings) === Math.max(...savings)
        ? `Save ${money(savings[0])}`
        : `Save ${money(Math.min(...savings))}–${money(Math.max(...savings))}`;
  const crystal = coatingPackage(FESTIVE_COATING_SERVICE_SLUG);
  const address = `${settings.addressLine1}, ${settings.city}, ${settings.province} ${settings.postalCode}`;

  return (
    <div className="min-h-screen bg-[#FFF8EC] text-[#14112B]">
      <header className="bg-[#0D0A24] text-white">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3 sm:px-7">
          <p className="text-xs font-black uppercase tracking-[0.16em] sm:text-sm">{settings.businessName}</p>
          <a href={`tel:${settings.phone}`} className="shrink-0 rounded-full border border-[#F2B83B]/60 px-4 py-2 text-xs font-bold text-[#FFE3A3] transition hover:bg-[#F2B83B] hover:text-[#0D0A24] sm:text-sm">
            Call {settings.phone}
          </a>
        </div>
      </header>

      <main>
        <section className="relative isolate overflow-hidden bg-[#140F33] text-white">
          <Toran />
          <div aria-hidden="true" className="absolute inset-0 -z-10 bg-[radial-gradient(circle_at_18%_28%,rgba(247,169,40,0.28),transparent_38%),radial-gradient(circle_at_88%_8%,rgba(214,51,108,0.25),transparent_34%),radial-gradient(circle_at_70%_95%,rgba(91,61,214,0.35),transparent_40%)]" />
          <Mandala className="pointer-events-none absolute -left-40 top-24 -z-10 size-[34rem] text-[#F2B83B] opacity-[0.13] sm:-left-24" />
          <Mandala className="pointer-events-none absolute -right-48 bottom-0 -z-10 hidden size-[30rem] text-[#F7A8C4] opacity-[0.1] lg:block" />
          <Sparkles />

          <div className="relative mx-auto grid max-w-7xl gap-9 px-4 pb-14 pt-12 sm:px-7 sm:pb-20 sm:pt-16 lg:grid-cols-[minmax(0,1.15fr)_minmax(22rem,0.85fr)] lg:items-start lg:gap-x-12 lg:gap-y-8">
            <div className="lg:col-start-1 lg:row-start-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1.5 rounded-full bg-gradient-to-r from-[#FFC94D] to-[#F08A24] px-3 py-1.5 text-[0.68rem] font-black uppercase tracking-[0.14em] text-[#14112B]">
                  <Diya className="size-4" /> Navratri &amp; Diwali special
                </span>
                <span className="rounded-full border border-white/25 px-3 py-1.5 text-[0.68rem] font-black uppercase tracking-[0.14em] text-white/85">New vehicles only</span>
              </div>

              <h1 className="mt-6 max-w-3xl text-[clamp(2.4rem,8.5vw,5.2rem)] font-black leading-[0.9] tracking-[-0.055em]">
                New car this festive season?
                <span className="mt-1 block bg-gradient-to-r from-[#FFE08A] via-[#F7A928] to-[#F0703A] bg-clip-text pb-2 text-transparent">Make the shine last.</span>
              </h1>

              <div className="mt-7 flex flex-wrap items-end gap-x-6 gap-y-3">
                <p className="bg-gradient-to-b from-[#FFF1C4] via-[#FFC94D] to-[#E08A1E] bg-clip-text text-[clamp(5rem,18vw,9rem)] font-black leading-[0.8] tracking-[-0.07em] text-transparent drop-shadow-[0_8px_30px_rgba(247,169,40,0.35)]">
                  {offerLabel}
                </p>
                {(regular.carCents !== null || regular.largeCents !== null) && (
                  <div className="pb-2 text-sm font-bold text-white/70 sm:text-base">
                    {regular.carCents !== null && <p><span className="line-through decoration-[#F0703A] decoration-2">{money(regular.carCents)}</span> for a car</p>}
                    {regular.largeCents !== null && <p className="mt-0.5"><span className="line-through decoration-[#F0703A] decoration-2">{money(regular.largeCents)}</span> for an SUV, pickup or van</p>}
                    {savingLabel && <p className="mt-1.5 text-[#FFD36B]">{savingLabel} · festive price</p>}
                  </div>
                )}
              </div>

              <p className="mt-6 max-w-2xl text-xl font-bold leading-snug sm:text-2xl">
                Our Crystal ceramic coating, for any new coupe, sedan, SUV, pickup or van. One price.
              </p>
              <p className="mt-2 text-base text-white/70">Applied by hand, panel by panel. Deep gloss, and a car that washes clean in minutes.</p>
            </div>

            <aside className="lg:sticky lg:top-6 lg:col-start-2 lg:row-span-2 lg:row-start-1">
              <FestiveRequestForm serviceId={service?.id ?? null} offerLabel={offerLabel} phone={settings.phone} />
              <div className="mt-4 grid grid-cols-3 gap-2 text-center text-[0.66rem] font-bold text-white/75 sm:text-xs">
                <p className="rounded-xl border border-white/10 bg-white/[0.05] px-2 py-3"><span className="block text-base text-[#FFD36B]">★ {settings.googleReviewRating}</span>{settings.googleReviewCount} reviews</p>
                <p className="rounded-xl border border-white/10 bg-white/[0.05] px-2 py-3"><span className="block text-base text-[#FFD36B]">{settings.yearsInBusinessLabel}</span>local care</p>
                <p className="rounded-xl border border-white/10 bg-white/[0.05] px-2 py-3"><span className="block text-base text-[#FFD36B]">{offerLabel}</span>any size</p>
              </div>
            </aside>

            {/* After the form on a phone, where nearly every QR scan lands; under the copy on desktop. */}
            <div className="relative overflow-hidden rounded-[1.75rem] border border-[#F2B83B]/30 shadow-[0_32px_80px_-35px_rgba(0,0,0,0.9)] lg:col-start-1 lg:row-start-2">
              <Image
                src="/images/services/ceramic-coating.png"
                alt="A freshly ceramic-coated car with a deep, reflective gloss"
                width={1448}
                height={1086}
                priority
                sizes="(min-width: 1024px) 58vw, 100vw"
                className="aspect-[16/10] w-full object-cover object-center"
              />
              <div className="absolute inset-x-0 bottom-0 flex flex-wrap justify-between gap-2 bg-gradient-to-t from-black/90 via-black/55 to-transparent px-5 pb-5 pt-16 text-xs font-bold sm:px-6 sm:pb-6 sm:text-sm">
                <span>✦ Hand applied</span>
                <span>✦ Deep gloss</span>
                <span>✦ Easier washing</span>
              </div>
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-7xl px-4 py-14 sm:px-7 sm:py-20">
          <div className="grid gap-10 lg:grid-cols-[0.8fr_1.2fr] lg:items-start">
            <div>
              <p className="text-xs font-black uppercase tracking-[0.18em] text-[#B45309]">Made for new paint</p>
              <h2 className="mt-3 text-4xl font-black leading-none tracking-[-0.045em] sm:text-5xl">Protect it while it’s perfect.</h2>
              <p className="mt-5 max-w-md leading-7 text-[#5A5470]">
                A new car’s paint is at its best the day you bring it home. Coating it now locks in that finish, before road salt, bird droppings and winter grime get a chance at it.
              </p>
            </div>
            <div className="rounded-[1.75rem] bg-[#14112B] p-6 text-white shadow-[0_30px_70px_-40px_rgba(20,17,43,0.9)] sm:p-8">
              <p className="text-xs font-black uppercase tracking-[0.18em] text-[#FFD36B]">What’s included</p>
              <h3 className="mt-3 text-2xl font-black sm:text-3xl">Crystal ceramic coating</h3>
              <ul className="mt-6 grid gap-3 text-sm sm:grid-cols-2">
                {(crystal?.includes ?? []).map((item) => (
                  <li key={item} className="flex gap-2.5"><span aria-hidden="true" className="text-[#F7A928]">✦</span>{item}</li>
                ))}
              </ul>
              <p className="mt-6 border-t border-white/10 pt-4 text-xs leading-5 text-white/60">Crystal is offered without a warranty. Paint correction is not included.</p>
            </div>
          </div>
        </section>

        <section className="bg-gradient-to-br from-[#FFE7B8] via-[#FFF1D6] to-[#FFD9C2]">
          <div className="mx-auto max-w-7xl px-4 py-14 sm:px-7 sm:py-20">
            <p className="text-xs font-black uppercase tracking-[0.18em] text-[#B45309]">How it works</p>
            <h2 className="mt-3 text-3xl font-black tracking-[-0.035em] sm:text-4xl">Three easy steps.</h2>
            <div className="mt-8 grid gap-3 sm:grid-cols-3">
              {[
                ["01", "Request a call back", "Your name, number and email. It takes less than a minute."],
                ["02", "We call you", "We confirm your vehicle and pick a day that suits you. No payment upfront."],
                ["03", "Drop it off", `We coat it by hand and you collect a protected car. ${offerLabel} plus ${settings.taxLabel}.`],
              ].map(([number, title, body]) => (
                <article key={number} className="rounded-2xl border border-[#EBCB8F] bg-white/80 p-5 shadow-[0_16px_45px_-35px_rgba(20,17,43,0.6)]">
                  <span className="text-sm font-black text-[#B45309]">{number}</span>
                  <h3 className="mt-8 text-xl font-black">{title}</h3>
                  <p className="mt-2 text-sm leading-6 text-[#5A5470]">{body}</p>
                </article>
              ))}
            </div>
            <a href="#request" className="mt-8 inline-flex min-h-12 items-center rounded-full bg-[#14112B] px-6 font-black text-white transition hover:bg-[#2A2350]">
              Request my call back ↑
            </a>
          </div>
        </section>

        <section className="mx-auto max-w-4xl px-4 py-14 sm:px-7 sm:py-20">
          <h2 className="text-center text-3xl font-black tracking-[-0.035em] sm:text-4xl">Quick questions</h2>
          <div className="mt-8 space-y-2.5">
            {[
              [`Is ${offerLabel} really the full price?`, `Yes. ${offerLabel} plus ${settings.taxLabel} for the Crystal ceramic coating, whatever size your vehicle is.`],
              ["Which vehicles qualify?", "New coupes, sedans, SUVs, pickups and vans. We confirm your vehicle’s details when we call, before anything is booked. Commercial vehicles are quoted separately."],
              ["Does it come with a warranty?", "Crystal has no warranty. If you’d like one, ask us about our Pro (6-year warranty) and Max (10-year warranty) coatings when we call."],
              ["Is paint correction included?", "No. New paint rarely needs it. If yours does, we’ll tell you and quote it separately first. Nothing is added without your approval."],
              ["How long will you need the car?", "Coatings are booked by the day. We’ll arrange a drop-off time with you on the phone."],
            ].map(([question, answer]) => (
              <details key={question} className="group rounded-2xl border border-[#EBDDC2] bg-white px-5 py-4 open:border-[#F2B83B]">
                <summary className="cursor-pointer list-none font-black">{question}<span aria-hidden="true" className="float-right text-[#B45309] transition group-open:rotate-45">+</span></summary>
                <p className="mt-3 pr-6 text-sm leading-6 text-[#5A5470]">{answer}</p>
              </details>
            ))}
          </div>
          <p className="mx-auto mt-10 max-w-2xl text-center text-xs leading-5 text-[#7A7390]">
            Offer: Crystal ceramic coating for {offerLabel} plus {settings.taxLabel}, on new coupes, sedans, SUVs, pickups and vans. One coating per vehicle. Paint correction not included. Commercial vehicles quoted separately. {settings.businessName} may end this offer at any time; requests received before then will be honoured.
          </p>
        </section>
      </main>

      <footer className="bg-[#0D0A24] text-white/65">
        <div className="mx-auto flex max-w-7xl flex-col justify-between gap-5 px-4 py-9 text-xs sm:flex-row sm:px-7">
          <div><p className="font-black text-white">{settings.businessName}</p><p className="mt-1">{address}</p></div>
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            <Link href="/policies/terms" className="hover:text-[#FFD36B]">Terms</Link>
            <Link href="/policies/privacy" className="hover:text-[#FFD36B]">Privacy</Link>
            <a href={PUBLIC_SITE_URL} className="hover:text-[#FFD36B]">Main site</a>
          </div>
        </div>
      </footer>
    </div>
  );
}

/** A marigold-and-mango-leaf toran strung along the top of the hero. */
function Toran() {
  return (
    <div aria-hidden="true" className="absolute inset-x-0 top-0 h-7 overflow-hidden">
      <div className="absolute inset-x-0 top-0 h-px bg-[#5E8C31]" />
      <div className="absolute inset-x-0 top-0 h-6 bg-[radial-gradient(circle_at_14px_9px,#FFD23F_0_4px,#FFA41B_4px_7px,#F07A1A_7px_8px,transparent_8.5px),radial-gradient(ellipse_5px_9px_at_42px_10px,#4F8A2B_0_100%,transparent_100%)] bg-[length:56px_24px] bg-repeat-x" />
    </div>
  );
}

/** A rangoli rosette: three rings of petals around a centre. */
function Mandala({ className }: { className?: string }) {
  const ring = (count: number, rx: number, ry: number, cy: number) =>
    Array.from({ length: count }, (_, i) => (
      <ellipse key={`${count}-${i}`} cx="100" cy={cy} rx={rx} ry={ry} transform={`rotate(${(360 / count) * i} 100 100)`} />
    ));
  return (
    <svg viewBox="0 0 200 200" fill="none" stroke="currentColor" strokeWidth="0.8" className={className} aria-hidden="true">
      <circle cx="100" cy="100" r="96" />
      <circle cx="100" cy="100" r="88" strokeDasharray="2 3" />
      {ring(24, 6, 16, 22)}
      {ring(16, 8, 20, 46)}
      {ring(8, 9, 18, 70)}
      <circle cx="100" cy="100" r="12" />
      <circle cx="100" cy="100" r="5" fill="currentColor" />
    </svg>
  );
}

function Diya({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path d="M12 2.5c1.8 2.3 2.6 4 2.6 5.3a2.6 2.6 0 0 1-5.2 0c0-1.3.8-3 2.6-5.3Z" fill="#7A2E0E" />
      <path d="M3 13.5h18c-.6 3.8-4.4 6.5-9 6.5s-8.4-2.7-9-6.5Z" fill="#14112B" />
      <path d="M2 12.5h20" stroke="#14112B" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

/** Small glowing points, like diyas seen from a distance. */
function Sparkles() {
  const points = [
    ["8%", "18%", 6], ["22%", "62%", 4], ["35%", "12%", 5], ["48%", "40%", 3], ["61%", "8%", 6],
    ["74%", "30%", 4], ["90%", "18%", 5], ["84%", "70%", 3], ["12%", "88%", 5], ["55%", "92%", 4],
  ] as const;
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10">
      {points.map(([left, top, size]) => (
        <span
          key={`${left}-${top}`}
          className="absolute rounded-full bg-[#FFD36B] shadow-[0_0_14px_4px_rgba(255,190,80,0.55)]"
          style={{ left, top, width: size, height: size }}
        />
      ))}
    </div>
  );
}
