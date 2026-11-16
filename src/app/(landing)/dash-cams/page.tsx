import Image from "next/image";
import Link from "next/link";
import type { Metadata } from "next";
import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import {
  DASH_CAM_FROM_CENTS,
  DASH_CAM_PAGE_PATH,
  DASH_CAM_POINTS,
} from "@/lib/dash-cam-offer";
import { membershipSettings } from "@/lib/memberships/config";
import { formatCents } from "@/lib/money";
import { POPULAR_SERVICE_SLUGS, SERVICE_PRESENTATION } from "@/lib/public-content";
import { PUBLIC_SITE_URL } from "@/lib/seo";
import { getSettings } from "@/lib/settings";
import { DashCamRequestForm } from "./request-form";

export const dynamic = "force-dynamic";

const TITLE = "Dash Cam Installation in Hamilton | From $99, Free Installation | Personal Touch Car Detailing";
const DESCRIPTION =
  "Dash cam installation in Hamilton from $99, with free installation included. Professionally installed. Request a call back.";
const HERO_IMAGE = "/images/services/dash-cams.jpg";

/**
 * A paid-traffic landing page, so it is kept out of search (no index, no
 * sitemap entry) and out of the site chrome: the (landing) layout carries the
 * measurement tags and nothing else.
 */
export const metadata: Metadata = {
  title: { absolute: TITLE },
  description: DESCRIPTION,
  robots: { index: false, follow: false },
  openGraph: {
    type: "website",
    locale: "en_CA",
    siteName: "Personal Touch Car Detailing",
    title: "Dash Cam Installation in Hamilton — From $99",
    description: DESCRIPTION,
    url: DASH_CAM_PAGE_PATH,
    images: [{ url: HERO_IMAGE, width: 1600, height: 631, alt: "Dash cams mounted on a car windscreen" }],
  },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION, images: [HERO_IMAGE] },
};

export default async function DashCamPage() {
  const settings = await getSettings();
  const config = membershipSettings(settings);
  const money = (cents: number) => formatCents(cents, settings.currency).replace(/\.00$/, "");
  const priceLabel = money(DASH_CAM_FROM_CENTS);
  const tel = `tel:${settings.phone.replace(/[^\d+]/g, "")}`;
  const address = `${settings.addressLine1}, ${settings.city}, ${settings.province} ${settings.postalCode}`;

  // Read live, so a price changed in Admin changes the page. The slugs are the
  // stable key: owners rename services, they do not change slugs.
  const rows = await db()
    .select({ slug: schema.services.slug, basePriceCents: schema.services.basePriceCents })
    .from(schema.services)
    .where(and(eq(schema.services.active, true), inArray(schema.services.slug, [...POPULAR_SERVICE_SLUGS])));
  const packages = POPULAR_SERVICE_SLUGS.flatMap((slug) => {
    const row = rows.find((r) => r.slug === slug);
    const presentation = SERVICE_PRESENTATION[slug];
    return row && row.basePriceCents !== null && presentation
      ? [{ slug, name: presentation.publicName, priceCents: row.basePriceCents, highlights: presentation.highlights }]
      : [];
  });

  return (
    <div className="min-h-screen bg-[#F6F3EC] text-[#0B2A4A]">
      <header className="bg-[#07203A] text-white">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3 sm:px-7">
          <p className="text-xs font-black uppercase tracking-[0.16em] sm:text-sm">{settings.businessName}</p>
          <a href={tel} className="shrink-0 rounded-full border border-[#E0A93B]/60 px-4 py-2 text-xs font-bold text-[#F3D58F] transition hover:bg-[#E0A93B] hover:text-[#07203A] sm:text-sm">
            Call {settings.phone}
          </a>
        </div>
      </header>

      <main>
        <section className="relative isolate overflow-hidden bg-gradient-to-br from-[#0B2A4A] via-[#0A1E36] to-[#07142A] text-white">
          <div aria-hidden="true" className="absolute inset-0 -z-10 bg-[radial-gradient(circle_at_85%_10%,rgba(224,169,59,0.22),transparent_40%)]" />
          <div className="mx-auto grid max-w-7xl gap-9 px-4 pb-14 pt-12 sm:px-7 sm:pb-20 sm:pt-16 lg:grid-cols-[minmax(0,1.15fr)_minmax(22rem,0.85fr)] lg:items-start lg:gap-x-12 lg:gap-y-8">
            <div className="lg:col-start-1 lg:row-start-1">
              <span className="inline-flex rounded-full bg-[#E0A93B] px-3 py-1.5 text-[0.68rem] font-black uppercase tracking-[0.14em] text-[#07203A]">
                Dash cam installation · Hamilton
              </span>
              <h1 className="mt-6 max-w-3xl text-[clamp(2.4rem,8vw,4.8rem)] font-black leading-[0.95] tracking-[-0.045em]">
                Dash cams, <span className="text-[#F3C766]">professionally installed.</span>
              </h1>
              <div className="mt-7 flex flex-wrap items-end gap-x-6 gap-y-2">
                <p className="text-[clamp(3.6rem,14vw,7rem)] font-black leading-[0.85] tracking-[-0.06em] text-[#F3C766]">
                  <span className="mr-2 align-top text-[0.28em] font-bold uppercase tracking-[0.1em] text-white/70">From</span>
                  {priceLabel}
                </p>
                <p className="pb-1 text-xl font-bold leading-tight text-white sm:text-2xl">
                  Free installation
                  <span className="block text-sm font-semibold text-white/65">Prices are before {settings.taxLabel}</span>
                </p>
              </div>
              <ul className="mt-7 max-w-xl space-y-2 text-base text-white/85 sm:text-lg">
                {DASH_CAM_POINTS.map((point) => (
                  <li key={point} className="flex gap-2.5"><span aria-hidden="true" className="text-[#F3C766]">✓</span>{point}</li>
                ))}
              </ul>
            </div>

            <aside className="lg:sticky lg:top-6 lg:col-start-2 lg:row-span-2 lg:row-start-1">
              <DashCamRequestForm priceLabel={priceLabel} phone={settings.phone} />
              <div className="mt-4 grid grid-cols-3 gap-2 text-center text-[0.66rem] font-bold text-white/75 sm:text-xs">
                <p className="rounded-xl border border-white/10 bg-white/[0.05] px-2 py-3"><span className="block text-base text-[#F3C766]">★ {settings.googleReviewRating}</span>{settings.googleReviewCount} reviews</p>
                <p className="rounded-xl border border-white/10 bg-white/[0.05] px-2 py-3"><span className="block text-base text-[#F3C766]">{settings.yearsInBusinessLabel}</span>local care</p>
                <p className="rounded-xl border border-white/10 bg-white/[0.05] px-2 py-3"><span className="block text-base text-[#F3C766]">{priceLabel}</span>from, installed</p>
              </div>
            </aside>

            {/* After the form on a phone, where most ad clicks land; under the copy on desktop. */}
            <div className="overflow-hidden rounded-[1.5rem] border border-white/15 shadow-[0_32px_80px_-35px_rgba(0,0,0,0.9)] lg:col-start-1 lg:row-start-2">
              <Image
                src={HERO_IMAGE}
                alt="Two dash cams mounted on a car windscreen"
                width={1600}
                height={631}
                priority
                sizes="(min-width: 1024px) 58vw, 100vw"
                className="aspect-[5/2] w-full object-cover object-center"
              />
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-7xl px-4 py-14 sm:px-7 sm:py-20">
          <p className="text-xs font-black uppercase tracking-[0.18em] text-[#80570F]">How it works</p>
          <h2 className="mt-3 text-3xl font-black tracking-[-0.035em] sm:text-4xl">Three easy steps.</h2>
          <div className="mt-8 grid gap-3 sm:grid-cols-3">
            {[
              ["01", "Request a call back", "Your vehicle type, name and phone number. It takes less than a minute."],
              ["02", "We call you", "We confirm the details and arrange a time. No payment upfront."],
              ["03", "We install it", `Professionally installed, with installation included. Dash cams from ${priceLabel} plus ${settings.taxLabel}.`],
            ].map(([number, title, body]) => (
              <article key={number} className="rounded-2xl border border-[#E4DCCB] bg-white p-5 shadow-[0_16px_45px_-35px_rgba(11,42,74,0.5)]">
                <span className="text-sm font-black text-[#80570F]">{number}</span>
                <h3 className="mt-8 text-xl font-black">{title}</h3>
                <p className="mt-2 text-sm leading-6 text-slate-600">{body}</p>
              </article>
            ))}
          </div>
          <a href="#request" className="mt-8 inline-flex min-h-12 items-center rounded-full bg-[#0B2A4A] px-6 font-black text-white transition hover:bg-[#143E69]">
            Request my call back ↑
          </a>
        </section>

        {(packages.length > 0 || config.winterPass.priceCents > 0) && (
          <section className="border-y border-[#E4DCCB] bg-white">
            <div className="mx-auto max-w-7xl px-4 py-14 sm:px-7 sm:py-20">
              <p className="text-xs font-black uppercase tracking-[0.18em] text-[#80570F]">While you’re here</p>
              <h2 className="mt-3 text-3xl font-black tracking-[-0.035em] sm:text-4xl">Keep the car looking as good as the footage.</h2>
              <p className="mt-3 max-w-2xl text-slate-600">Prices are before {settings.taxLabel}.</p>
              <div className="mt-8 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
                {packages.map((pkg) => (
                  <article key={pkg.slug} className="flex flex-col rounded-2xl border border-[#E4DCCB] bg-[#FBF9F4] p-5">
                    <h3 className="text-lg font-black">{pkg.name}</h3>
                    <p className="mt-1 text-2xl font-black text-[#80570F]">
                      <span className="mr-1 text-xs font-bold uppercase tracking-[0.12em] text-slate-500">From</span>
                      {money(pkg.priceCents)}
                    </p>
                    <ul className="mt-3 flex-1 space-y-1 text-sm text-slate-600">
                      {pkg.highlights.map((point) => (
                        <li key={point} className="flex gap-2"><span aria-hidden="true" className="text-[#80570F]">✓</span>{point}</li>
                      ))}
                    </ul>
                    <Link href={`/book?service=${pkg.slug}`} className="mt-4 inline-flex min-h-11 items-center text-sm font-bold underline underline-offset-4">
                      Book {pkg.name} →
                    </Link>
                  </article>
                ))}
                {config.winterPass.priceCents > 0 && (
                  <article className="flex flex-col rounded-2xl border border-[#E0A93B]/70 bg-[#FFF7E3] p-5">
                    <h3 className="text-lg font-black">{config.winterPass.name}</h3>
                    <p className="mt-1 text-2xl font-black text-[#80570F]">{money(config.winterPass.priceCents)}</p>
                    <p className="mt-3 flex-1 text-sm text-slate-700">{config.winterPass.washesTotal} winter hand washes for one car.</p>
                    <Link href="/winter#plans" className="mt-4 inline-flex min-h-11 items-center text-sm font-bold underline underline-offset-4">
                      See the Winter Pass →
                    </Link>
                  </article>
                )}
              </div>
            </div>
          </section>
        )}

        <section className="mx-auto max-w-4xl px-4 py-14 sm:px-7 sm:py-20">
          <h2 className="text-center text-3xl font-black tracking-[-0.035em] sm:text-4xl">Quick questions</h2>
          <div className="mt-8 space-y-2.5">
            {[
              ["What does it cost?", `Dash cams start from ${priceLabel} plus ${settings.taxLabel}, and installation is free.`],
              ["Who installs it?", "Our team installs it professionally. We go over the details with you on the phone before anything is booked."],
              ["Do I pay now?", "No. Requesting a call back costs nothing and doesn’t reserve a time. We’ll arrange one with you when we call."],
            ].map(([question, answer]) => (
              <details key={question} className="group rounded-2xl border border-[#E4DCCB] bg-white px-5 py-4 open:border-[#E0A93B]">
                <summary className="cursor-pointer list-none font-black">{question}<span aria-hidden="true" className="float-right text-[#80570F] transition group-open:rotate-45">+</span></summary>
                <p className="mt-3 pr-6 text-sm leading-6 text-slate-600">{answer}</p>
              </details>
            ))}
          </div>
        </section>
      </main>

      <footer className="bg-[#07203A] text-white/65">
        <div className="mx-auto flex max-w-7xl flex-col justify-between gap-5 px-4 py-9 text-xs sm:flex-row sm:px-7">
          <div><p className="font-black text-white">{settings.businessName}</p><p className="mt-1">{address}</p></div>
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            <Link href="/policies/terms" className="hover:text-[#F3C766]">Terms</Link>
            <Link href="/policies/privacy" className="hover:text-[#F3C766]">Privacy</Link>
            <a href={PUBLIC_SITE_URL} className="hover:text-[#F3C766]">Main site</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
