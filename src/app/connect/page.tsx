import Image from "next/image";
import type { Metadata, Viewport } from "next";
import { TrackedLink, type ConnectAction } from "./connect-links";
import { getPublicSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Connect",
  description:
    "Book car detailing, explore services, see recent work, read reviews, or contact Personal Touch Car Detailing in Hamilton.",
  alternates: { canonical: "/connect" },
};

export const viewport: Viewport = {
  themeColor: "#061a2c",
  colorScheme: "dark",
};

const MAIN_LINKS: Array<{
  action: ConnectAction;
  href: string;
  title: string;
  description: string;
  number: string;
}> = [
  {
    action: "services",
    href: "/services",
    title: "Explore our services",
    description: "Detailing, coatings, correction, tint and more",
    number: "01",
  },
  {
    action: "gallery",
    href: "/gallery",
    title: "See our work",
    description: "Take a look at recent vehicle transformations",
    number: "02",
  },
  {
    action: "reviews",
    href: "/reviews",
    title: "Read customer reviews",
    description: "See what local drivers have to say",
    number: "03",
  },
  {
    action: "quote",
    href: "/quote",
    title: "Request a quote",
    description: "Tell us what your vehicle needs",
    number: "04",
  },
];

export default async function ConnectPage() {
  const settings = await getPublicSettings();
  const phoneHref = `tel:${settings.phone.replace(/[^\d+]/g, "")}`;
  const address = [
    settings.addressLine1,
    settings.city,
    settings.province,
    settings.postalCode,
  ]
    .filter(Boolean)
    .join(", ");
  const directionsHref = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;

  return (
    <main className="relative isolate min-h-[100svh] overflow-hidden bg-ink-950 text-white">
      <Image
        src="/images/detailing-studio-hero.png"
        alt=""
        fill
        priority
        sizes="100vw"
        className="fixed inset-0 -z-30 object-cover object-[66%_center] opacity-35"
      />
      <div className="fixed inset-0 -z-20 bg-[linear-gradient(180deg,rgba(6,26,44,0.72)_0%,rgba(6,26,44,0.9)_34%,#061a2c_76%)]" />
      <div className="fixed inset-0 -z-10 bg-[radial-gradient(circle_at_50%_0%,rgba(224,169,59,0.2),transparent_36%)]" />

      <div className="mx-auto flex min-h-[100svh] w-full max-w-xl flex-col px-4 pb-8 pt-7 sm:px-6 sm:pb-10 sm:pt-10">
        <section className="text-center">
          <a
            href="/"
            aria-label={`${settings.businessName} home`}
            className="inline-flex rounded-[1.4rem] bg-[#F8F5EE] p-3 shadow-[0_18px_55px_rgba(0,0,0,0.28)] ring-1 ring-white/70 transition-transform duration-200 hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-300"
          >
            <Image
              src="/brand/personal-touch-logo.png"
              alt={settings.businessName}
              width={948}
              height={1074}
              sizes="104px"
              className="h-[6.5rem] w-auto"
              priority
            />
          </a>

          <p className="mt-5 text-[0.68rem] font-semibold uppercase tracking-[0.28em] text-accent-300">
            Hamilton, Ontario
          </p>
          <h1 className="mx-auto mt-3 max-w-md font-display text-[2.5rem] leading-[0.98] tracking-[-0.035em] text-white sm:text-5xl">
            Your vehicle,
            <span className="block text-accent-300">personally cared for.</span>
          </h1>
          <p className="mx-auto mt-4 max-w-sm text-sm leading-6 text-ink-200 sm:text-base">
            Professional detailing and vehicle care. Choose what you need and we&apos;ll take it from here.
          </p>
        </section>

        <TrackedLink
          action="book"
          href="/book"
          className="group mt-7 flex min-h-16 items-center justify-between rounded-2xl border border-accent-300 bg-accent-400 px-5 py-4 text-ink-950 shadow-[0_18px_45px_rgba(224,169,59,0.22)] transition-all duration-200 hover:-translate-y-0.5 hover:bg-accent-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-ink-950"
        >
          <span>
            <span className="block text-[0.68rem] font-bold uppercase tracking-[0.2em] opacity-65">
              Ready when you are
            </span>
            <span className="mt-0.5 block text-lg font-extrabold">Book an appointment</span>
          </span>
          <span
            aria-hidden="true"
            className="flex size-10 items-center justify-center rounded-full bg-ink-950 text-xl text-accent-300 transition-transform duration-200 group-hover:translate-x-0.5"
          >
            →
          </span>
        </TrackedLink>

        <div className="mt-4 grid gap-3">
          {MAIN_LINKS.map((link) => (
            <TrackedLink
              key={link.action}
              action={link.action}
              href={link.href}
              className="group flex min-h-[4.75rem] items-center gap-4 rounded-2xl border border-white/12 bg-white/[0.075] px-4 py-3.5 shadow-[0_12px_32px_rgba(0,0,0,0.12)] backdrop-blur-md transition-all duration-200 hover:-translate-y-0.5 hover:border-accent-400/60 hover:bg-white/[0.11] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-300"
            >
              <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-accent-400/35 bg-accent-400/10 text-xs font-bold tracking-[0.12em] text-accent-300">
                {link.number}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[0.96rem] font-bold text-white">{link.title}</span>
                <span className="mt-0.5 block text-xs leading-5 text-ink-300">{link.description}</span>
              </span>
              <span
                aria-hidden="true"
                className="mr-1 text-lg text-ink-400 transition-all duration-200 group-hover:translate-x-0.5 group-hover:text-accent-300"
              >
                →
              </span>
            </TrackedLink>
          ))}
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3">
          <TrackedLink
            action="call"
            href={phoneHref}
            ariaLabel={`Call ${settings.businessName} at ${settings.phone}`}
            className="flex min-h-[4.75rem] flex-col justify-between rounded-2xl border border-white/12 bg-white/[0.055] p-4 transition-all duration-200 hover:border-accent-400/60 hover:bg-white/[0.095] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-300"
          >
            <span className="text-[0.66rem] font-bold uppercase tracking-[0.18em] text-accent-300">
              Call us
            </span>
            <span className="mt-2 text-sm font-bold text-white">{settings.phone}</span>
          </TrackedLink>
          <TrackedLink
            action="directions"
            href={directionsHref}
            external
            ariaLabel={`Get directions to ${address}`}
            className="flex min-h-[4.75rem] flex-col justify-between rounded-2xl border border-white/12 bg-white/[0.055] p-4 transition-all duration-200 hover:border-accent-400/60 hover:bg-white/[0.095] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-300"
          >
            <span className="text-[0.66rem] font-bold uppercase tracking-[0.18em] text-accent-300">
              Directions
            </span>
            <span className="mt-2 text-sm font-bold text-white">
              {settings.city}, {settings.province} ↗
            </span>
          </TrackedLink>
        </div>

        <div className="mt-7 flex flex-wrap items-center justify-center gap-x-5 gap-y-3 text-xs font-semibold text-ink-300">
          <TrackedLink action="contact" href="/contact" className="min-h-11 content-center hover:text-accent-300">
            Contact
          </TrackedLink>
          <span aria-hidden="true" className="size-1 rounded-full bg-accent-400/70" />
          <TrackedLink action="website" href="/" className="min-h-11 content-center hover:text-accent-300">
            Full website
          </TrackedLink>
        </div>

        <p className="mt-auto border-t border-white/10 pt-5 text-center text-[0.66rem] uppercase tracking-[0.18em] text-ink-500">
          Clean <span className="text-accent-400">•</span> Protect <span className="text-accent-400">•</span> Shine
        </p>
      </div>
    </main>
  );
}
