import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";
import { Container, ButtonLink } from "@/components/ui";
import { AttributionCapture } from "@/components/attribution";
import { getSettings } from "@/lib/settings";

// Public pages read business settings and service data from PostgreSQL. Render
// them at request time so production builds do not depend on an initialized DB.
export const dynamic = "force-dynamic";

const PRIMARY_NAV = [
  { href: "/services", label: "Services" },
  { href: "/gallery", label: "Gallery" },
  { href: "/fleet", label: "Commercial" },
  { href: "/about", label: "About" },
  { href: "/contact", label: "Contact" },
];

const SECONDARY_NAV = [
  { href: "/reviews", label: "Reviews" },
  { href: "/faq", label: "FAQ" },
];

function BrandLogo({ footer = false }: { footer?: boolean }) {
  return (
    <Image
      src="/brand/personal-touch-logo.png"
      alt=""
      width={948}
      height={1074}
      sizes={footer ? "128px" : "64px"}
      className={footer ? "h-32 w-auto" : "h-14 w-auto sm:h-16"}
      priority={!footer}
    />
  );
}

export default async function PublicLayout({ children }: { children: ReactNode }) {
  const settings = await getSettings();
  return (
    <div className="flex min-h-screen flex-col bg-ink-950">
      <AttributionCapture />
      <header className="sticky top-0 z-50 border-b border-[#D8D1C4] bg-[#F8F5EE]/95 shadow-[0_8px_30px_rgba(3,15,27,0.1)] backdrop-blur-xl">
        <Container className="flex h-20 items-center justify-between gap-6">
          <Link href="/" aria-label="Personal Touch Car Detailing home" className="shrink-0 rounded-lg">
            <BrandLogo />
          </Link>

          <nav aria-label="Primary navigation" className="hidden items-center gap-1 lg:flex">
            {PRIMARY_NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="rounded-lg px-3 py-2 text-[0.82rem] font-medium text-[#536477] transition-colors hover:bg-[#0B2A4A]/6 hover:text-[#0B2A4A]"
              >
                {item.label}
              </Link>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-2">
            <ButtonLink href="/book" className="hidden sm:inline-flex">Book Now</ButtonLink>

            <details className="group relative lg:hidden">
              <summary className="flex size-11 cursor-pointer list-none items-center justify-center rounded-xl border border-[#0B2A4A]/20 text-[#0B2A4A] transition-colors hover:border-accent-500 hover:text-accent-600" aria-label="Open navigation menu">
                <span className="sr-only">Menu</span>
                <span aria-hidden="true" className="relative h-4 w-5">
                  <span className="absolute left-0 top-0 h-px w-5 bg-current transition-transform group-open:translate-y-[7px] group-open:rotate-45" />
                  <span className="absolute left-0 top-[7px] h-px w-5 bg-current group-open:opacity-0" />
                  <span className="absolute left-0 top-[14px] h-px w-5 bg-current transition-transform group-open:-translate-y-[7px] group-open:-rotate-45" />
                </span>
              </summary>
              <div className="absolute right-0 top-14 w-[min(22rem,calc(100vw-2rem))] overflow-hidden rounded-2xl border border-white/10 bg-ink-900 p-3 shadow-2xl shadow-black/40">
                <nav aria-label="Mobile navigation" className="grid">
                  {[...PRIMARY_NAV, ...SECONDARY_NAV].map((item) => (
                    <Link
                      key={item.href}
                      href={item.href}
                      className="rounded-xl px-4 py-3 text-sm font-medium text-ink-200 transition-colors hover:bg-white/5 hover:text-accent-300"
                    >
                      {item.label}
                    </Link>
                  ))}
                </nav>
                <div className="mt-2 grid gap-2 border-t border-white/10 pt-3 sm:hidden">
                  <ButtonLink href="/book">Book an Appointment</ButtonLink>
                  <ButtonLink href="/quote" variant="outline">Request a Quote</ButtonLink>
                </div>
              </div>
            </details>
          </div>
        </Container>
      </header>

      <main className="flex-1">{children}</main>

      <footer className="border-t border-[#D8D1C4] bg-[#F2EDE3]">
        <Container className="py-16 sm:py-20">
          <div className="grid gap-12 lg:grid-cols-[1.35fr_0.8fr_0.8fr_1fr]">
            <div className="max-w-sm">
              <Link href="/" aria-label="Personal Touch Car Detailing home" className="inline-flex rounded-lg">
                <BrandLogo footer />
              </Link>
              <p className="mt-5 text-sm leading-6 text-[#5C6876]">
                Professional vehicle care for drivers and commercial clients in {settings.city}, {settings.province}.
              </p>
              <div className="mt-6 h-px w-24 bg-accent-400/70" />
            </div>

            <div>
              <p className="mb-4 text-xs font-semibold uppercase tracking-[0.2em] text-[#0B2A4A]">Explore</p>
              <ul className="space-y-3 text-sm text-[#5C6876]">
                {PRIMARY_NAV.map((item) => (
                  <li key={item.href}><Link href={item.href} className="transition-colors hover:text-accent-600">{item.label}</Link></li>
                ))}
              </ul>
            </div>

            <div>
              <p className="mb-4 text-xs font-semibold uppercase tracking-[0.2em] text-[#0B2A4A]">Client care</p>
              <ul className="space-y-3 text-sm text-[#5C6876]">
                <li><Link href="/book" className="transition-colors hover:text-accent-600">Book online</Link></li>
                <li><Link href="/quote" className="transition-colors hover:text-accent-600">Request a quote</Link></li>
                <li><Link href="/portal" className="transition-colors hover:text-accent-600">Customer access</Link></li>
                <li><Link href="/reviews" className="transition-colors hover:text-accent-600">Customer reviews</Link></li>
                <li><Link href="/faq" className="transition-colors hover:text-accent-600">Questions &amp; answers</Link></li>
              </ul>
            </div>

            <div>
              <p className="mb-4 text-xs font-semibold uppercase tracking-[0.2em] text-[#0B2A4A]">Contact</p>
              <address className="space-y-3 text-sm not-italic leading-6 text-[#5C6876]">
                <p>{settings.addressLine1}<br />{settings.city}, {settings.province} {settings.postalCode}</p>
                {settings.phone && <p><a href={`tel:${settings.phone}`} className="transition-colors hover:text-accent-600">{settings.phone}</a></p>}
                {settings.email && <p className="break-all"><a href={`mailto:${settings.email}`} className="transition-colors hover:text-accent-600">{settings.email}</a></p>}
              </address>
            </div>
          </div>

          <div className="mt-14 flex flex-col gap-4 border-t border-[#D8D1C4] pt-7 text-xs text-[#6B7280] sm:flex-row sm:items-center sm:justify-between">
            <p>© {new Date().getFullYear()} {settings.businessName}. All rights reserved.</p>
            <div className="flex flex-wrap gap-x-5 gap-y-2">
              <Link href="/policies/privacy" className="hover:text-[#0B2A4A]">Privacy</Link>
              <Link href="/policies/cancellation" className="hover:text-[#0B2A4A]">Cancellation</Link>
              <Link href="/policies/terms" className="hover:text-[#0B2A4A]">Service terms</Link>
            </div>
          </div>
        </Container>
      </footer>
    </div>
  );
}
