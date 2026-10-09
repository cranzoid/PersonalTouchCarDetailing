import Image from "next/image";
import Link from "next/link";
import type { Metadata } from "next";
import { inArray } from "drizzle-orm";
import { ButtonLink, Container } from "@/components/ui";
import { db, schema } from "@/db";
import { membershipSettings } from "@/lib/memberships/config";
import { passValidityWindow } from "@/lib/memberships/passes";
import { listPlans } from "@/lib/memberships/service";
import { formatCents } from "@/lib/money";
import { getPublicSettings } from "@/lib/settings";
import { formatInZone } from "@/lib/tz";

export const dynamic = "force-dynamic";

const TITLE = "Winter Car Care in Hamilton — Winter Pass & Winter Shield | Personal Touch Car Detailing";
const DESCRIPTION =
  "Protect your car from salt and slush this winter. Winter Pass: 4 hand washes for $99. Winter Shield Club from $49/month. Detailing, ceramic protection and winter tire swaps in Hamilton.";

export const metadata: Metadata = {
  title: { absolute: TITLE },
  description: DESCRIPTION,
  alternates: { canonical: "/winter" },
  openGraph: { title: TITLE, description: DESCRIPTION, url: "/winter", images: [{ url: "/images/services/hand-wash.png" }] },
};

/**
 * The winter offer, as on the 2026-10-06 flyer (its QR code lands here). The
 * flyer is the brief: the two sides of it are the two halves of this page.
 * Every price shown comes from the catalogue or Memberships → Settings, so a
 * price change in admin changes the page; the two products that are not yet
 * bookable (PPF, dash cams) are the only figures written here.
 */
export default async function WinterPage() {
  const settings = await getPublicSettings();
  const config = membershipSettings(settings);
  const plans = await listPlans({ activeOnly: true });
  const services = await db()
    .select({ slug: schema.services.slug, basePriceCents: schema.services.basePriceCents, active: schema.services.active })
    .from(schema.services)
    .where(inArray(schema.services.slug, ["interior-detail", "ceramic-protection", "winter-tire-swap"]));
  const [glass] = await db()
    .select({ priceCents: schema.addons.priceCents, active: schema.addons.active })
    .from(schema.addons)
    .where(inArray(schema.addons.slug, ["winter-glass-protection"]));
  const price = (slug: string) => services.find((s) => s.slug === slug && s.active)?.basePriceCents ?? null;
  const money = (cents: number) =>
    formatCents(cents, settings.currency).replace(/\.00$/, "");
  const window = passValidityWindow(config.winterPass, settings.timezone);
  const month = (d: Date) => formatInZone(d, settings.timezone, { month: "long" });

  const winterServices = [
    {
      title: "Interior Detailing",
      price: price("interior-detail"),
      from: true,
      points: ["Seats, carpets and mats detailed", "Interior surfaces cleaned and polished", "Interior glass cleaned", "Air vents cleaned", "Trunk vacuumed"],
      href: "/book?service=interior-detail",
      cta: "Book",
    },
    {
      title: "Ceramic Protection",
      price: price("ceramic-protection"),
      from: true,
      points: ["Water-beading protection", "Vehicle wash and paint preparation included", "Helps maintain a clean, glossy finish", "Added protection from winter grime, moisture and road contamination"],
      href: "/services/ceramic-protection",
      cta: "Learn more",
    },
    {
      title: "Winter Tire Swap",
      price: price("winter-tire-swap"),
      from: true,
      points: ["Seasonal winter tire swap", "Quick, professional service", "Convenient to combine with another appointment"],
      href: "/book?service=winter-tire-swap",
      cta: "Book",
    },
    {
      title: "Winter Glass Protection",
      price: glass?.active ? glass.priceCents : null,
      from: false,
      points: ["Exterior glass treatment", "Better water beading", "Helps make wet-weather and winter driving easier", "Easier cleaning of winter grime"],
      href: "/book?service=basic-car-wash&addon=winter-glass-protection",
      cta: "Add to a wash",
    },
    {
      title: "PPF — Front Body",
      price: 119900,
      from: true,
      points: ["Hood, bumper, fenders and mirrors — full panels, never partial", "Stone-chip and road-debris protection", "Clear protective film that helps preserve original paint"],
      href: null,
      cta: "Call to book",
    },
    {
      title: "Dash Cams",
      price: 9900,
      from: true,
      points: ["Free installation included", "Professionally installed", "Helps record drives and unexpected road incidents"],
      href: null,
      cta: "Call to book",
    },
  ];

  return (
    <>
      <section className="relative overflow-hidden border-b border-ink-800 bg-gradient-to-br from-[#0B2A4A] via-ink-950 to-ink-950">
        <Container className="grid gap-10 py-14 sm:py-20 lg:grid-cols-[1.1fr_0.9fr] lg:items-center">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.24em] text-accent-300">Winter detailing, protection &amp; seasonal services in Hamilton</p>
            <h1 className="mt-4 font-display text-[clamp(2.6rem,7vw,4.6rem)] leading-[1.02] tracking-[-0.02em] text-white">
              Protect your car <span className="text-accent-300">this winter</span>
            </h1>
            <p className="mt-5 max-w-xl text-lg leading-8 text-ink-300">
              Road salt, slush, moisture and winter grime can wear down your vehicle. Keep it clean, protected and road-ready all season long.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <ButtonLink href="#plans">See winter plans</ButtonLink>
              <ButtonLink href="#services" variant="outline">Winter services</ButtonLink>
            </div>
          </div>
          <div className="overflow-hidden rounded-[2rem] border border-white/10 shadow-2xl shadow-black/40">
            <Image src="/images/services/hand-wash.png" alt="A car being hand washed" width={1450} height={1086} priority sizes="(min-width: 1024px) 40vw, 100vw" className="aspect-[4/3] w-full object-cover" />
          </div>
        </Container>
      </section>

      <section id="plans" aria-labelledby="plans-heading" className="py-14 sm:py-20">
        <Container>
          <h2 id="plans-heading" className="font-display text-4xl tracking-[-0.02em] text-white sm:text-5xl">Winter plans</h2>
          <p className="mt-3 max-w-2xl text-ink-300">Prices are before {settings.taxLabel}. Each plan is for one car.</p>
          <div className="mt-10 grid gap-6 lg:grid-cols-3">
            <article className="flex flex-col rounded-[2rem] border border-accent-400/50 bg-gradient-to-br from-[#0B2A4A] to-ink-950 p-7 shadow-xl shadow-black/20">
              <p className="w-fit rounded-full bg-accent-400 px-3 py-1 text-xs font-bold uppercase tracking-[0.14em] text-ink-950">Best value for winter</p>
              <h3 className="mt-5 text-2xl font-bold text-white">{config.winterPass.name}</h3>
              <p className="mt-2 text-ink-300">{config.winterPass.washesTotal} winter hand washes for</p>
              <p className="mt-1 text-5xl font-black text-white">{money(config.winterPass.priceCents)}</p>
              <ul className="mt-6 flex-1 space-y-2 text-sm text-ink-200">
                {config.winterPass.features.map((feature) => (
                  <li key={feature} className="flex gap-2"><span aria-hidden="true" className="text-accent-300">✓</span>{feature}</li>
                ))}
              </ul>
              <p className="mt-4 text-xs text-ink-500">Use from {month(window.validFrom)} through {month(window.validUntil)}.</p>
              <div className="mt-6">
                {config.passSalesOpen ? (
                  <ButtonLink href="/account/winter-pass" className="w-full">Buy the Winter Pass</ButtonLink>
                ) : (
                  <ButtonLink href={`tel:${settings.phone.replace(/[^\d+]/g, "")}`} variant="outline" className="w-full">Call {settings.phone} to buy</ButtonLink>
                )}
              </div>
            </article>
            {plans.map((plan) => (
              <article key={plan.id} className="flex flex-col rounded-[2rem] border border-ink-700 bg-ink-900/70 p-7 shadow-xl shadow-black/15">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent-300">Monthly plan</p>
                <h3 className="mt-3 text-2xl font-bold text-white">{plan.name}</h3>
                <p className="mt-3 text-5xl font-black text-white">
                  {money(plan.monthlyPriceCents)}
                  <span className="text-lg font-semibold text-ink-300">/month</span>
                </p>
                {plan.tagline && <p className="mt-2 text-sm text-ink-400">{plan.tagline}</p>}
                <ul className="mt-6 flex-1 space-y-2 text-sm text-ink-200">
                  {plan.features.map((feature) => (
                    <li key={feature} className="flex gap-2"><span aria-hidden="true" className="text-accent-300">✓</span>{feature}</li>
                  ))}
                </ul>
                <div className="mt-6">
                  {config.salesOpen ? (
                    <ButtonLink href={`/account/join?plan=${plan.slug}`} className="w-full">Join {plan.name}</ButtonLink>
                  ) : (
                    <p className="rounded-xl border border-ink-700 px-4 py-3 text-center text-sm text-ink-300">
                      Online sign-up opens soon — call {settings.phone}
                    </p>
                  )}
                </div>
              </article>
            ))}
          </div>
          <p className="mt-6 text-sm text-ink-400">
            Already a member?{" "}
            <Link href="/account" className="text-accent-300 underline-offset-4 hover:underline">Sign in to your account</Link>{" "}
            to book your monthly wash or manage your plan.
          </p>
        </Container>
      </section>

      <section id="services" aria-labelledby="services-heading" className="border-t border-ink-800 bg-ink-900/30 py-14 sm:py-20">
        <Container>
          <h2 id="services-heading" className="font-display text-4xl tracking-[-0.02em] text-white sm:text-5xl">Our winter services</h2>
          <p className="mt-3 max-w-2xl text-ink-300">Detailing, protection and seasonal care for your vehicle in Hamilton.</p>
          <div className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {winterServices.map((service) => (
              <article key={service.title} className="flex flex-col rounded-[1.5rem] border border-ink-700 bg-ink-950/60 p-6">
                <h3 className="text-xl font-bold text-white">{service.title}</h3>
                {service.price !== null && (
                  <p className="mt-2 text-3xl font-black text-accent-300">
                    {service.from && <span className="mr-1 text-sm font-semibold uppercase tracking-[0.14em] text-ink-400">From</span>}
                    {money(service.price)}
                  </p>
                )}
                <ul className="mt-4 flex-1 space-y-1.5 text-sm text-ink-300">
                  {service.points.map((point) => (
                    <li key={point} className="flex gap-2"><span aria-hidden="true" className="text-accent-300">✓</span>{point}</li>
                  ))}
                </ul>
                <div className="mt-5">
                  {service.href ? (
                    <ButtonLink href={service.href} variant="outline" className="w-full">{service.cta}</ButtonLink>
                  ) : (
                    <ButtonLink href={`tel:${settings.phone.replace(/[^\d+]/g, "")}`} variant="outline" className="w-full">
                      {service.cta} — {settings.phone}
                    </ButtonLink>
                  )}
                </div>
              </article>
            ))}
          </div>
        </Container>
      </section>

      <section aria-label="Why Personal Touch" className="py-12">
        <Container>
          <ul className="grid grid-cols-2 gap-3 text-center text-sm text-ink-200 sm:grid-cols-3 lg:grid-cols-6">
            {["Professional hand wash", "Winter-focused vehicle care", "Detailing and ceramic protection", "Winter tire swaps", "Cars, SUVs & trucks", "Local Hamilton business"].map((item) => (
              <li key={item} className="rounded-2xl border border-ink-700 bg-ink-900/50 px-3 py-4">{item}</li>
            ))}
          </ul>
          <div className="mt-10 flex flex-col items-start justify-between gap-4 rounded-[2rem] border border-accent-500/25 bg-gradient-to-br from-[#0B2A4A] to-ink-950 p-7 sm:flex-row sm:items-center">
            <div>
              <p className="font-display text-3xl text-white">Book your winter service today</p>
              <p className="mt-1 text-ink-300">
                {settings.addressLine1}, {settings.city}, {settings.province} {settings.postalCode}
              </p>
            </div>
            <div className="flex flex-wrap gap-3">
              <ButtonLink href="/book">Book online</ButtonLink>
              <ButtonLink href={`tel:${settings.phone.replace(/[^\d+]/g, "")}`} variant="outline">Call {settings.phone}</ButtonLink>
            </div>
          </div>
        </Container>
      </section>
    </>
  );
}
