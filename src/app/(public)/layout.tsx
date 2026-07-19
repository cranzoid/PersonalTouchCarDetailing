import Link from "next/link";
import type { ReactNode } from "react";
import { Container, ButtonLink } from "@/components/ui";
import { AttributionCapture } from "@/components/attribution";
import { getSettings } from "@/lib/settings";

const NAV = [
  { href: "/services", label: "Services" },
  { href: "/gallery", label: "Gallery" },
  { href: "/fleet", label: "Fleet & Commercial" },
  { href: "/about", label: "About" },
  { href: "/reviews", label: "Reviews" },
  { href: "/faq", label: "FAQ" },
  { href: "/contact", label: "Contact" },
];

export default async function PublicLayout({ children }: { children: ReactNode }) {
  const settings = await getSettings();
  return (
    <div className="flex min-h-screen flex-col">
      <AttributionCapture />
      <header className="sticky top-0 z-40 border-b border-ink-800 bg-ink-950/90 backdrop-blur">
        <Container className="flex h-16 items-center justify-between gap-4">
          <Link href="/" className="shrink-0 text-lg font-bold tracking-tight text-white">
            Personal <span className="text-accent-400">Touch</span>
            <span className="ml-2 hidden text-xs font-normal uppercase tracking-widest text-ink-400 sm:inline">
              Car Detailing
            </span>
          </Link>
          <nav className="hidden items-center gap-6 lg:flex">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="text-sm text-ink-300 transition-colors hover:text-accent-300"
              >
                {item.label}
              </Link>
            ))}
          </nav>
          <div className="flex items-center gap-2">
            {settings.phone && (
              <a
                href={`tel:${settings.phone}`}
                className="hidden rounded-lg border border-ink-600 px-4 py-2 text-sm text-ink-100 hover:border-accent-400 sm:inline-flex"
              >
                Call Now
              </a>
            )}
            <ButtonLink href="/quote" variant="outline" className="hidden md:inline-flex">
              Request a Quote
            </ButtonLink>
            <ButtonLink href="/book">Book Now</ButtonLink>
          </div>
        </Container>
        {/* Mobile nav */}
        <nav className="flex gap-4 overflow-x-auto border-t border-ink-800/60 px-4 py-2 lg:hidden">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="whitespace-nowrap text-sm text-ink-300 hover:text-accent-300"
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </header>

      <main className="flex-1">{children}</main>

      <footer className="border-t border-ink-800 bg-ink-900/40">
        <Container className="grid gap-10 py-14 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <p className="text-lg font-bold text-white">
              Personal <span className="text-accent-400">Touch</span>
            </p>
            <p className="mt-2 text-sm text-ink-400">
              Professional car detailing in {settings.city}, {settings.province}. Locally owned and
              operated.
            </p>
          </div>
          <div>
            <p className="mb-3 text-sm font-semibold uppercase tracking-wider text-ink-300">
              Explore
            </p>
            <ul className="space-y-2 text-sm text-ink-400">
              {NAV.map((item) => (
                <li key={item.href}>
                  <Link href={item.href} className="hover:text-accent-300">
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <p className="mb-3 text-sm font-semibold uppercase tracking-wider text-ink-300">
              Get started
            </p>
            <ul className="space-y-2 text-sm text-ink-400">
              <li><Link href="/book" className="hover:text-accent-300">Book an Appointment</Link></li>
              <li><Link href="/quote" className="hover:text-accent-300">Request a Quote</Link></li>
              <li><Link href="/portal" className="hover:text-accent-300">Customer Access</Link></li>
            </ul>
          </div>
          <div>
            <p className="mb-3 text-sm font-semibold uppercase tracking-wider text-ink-300">
              Policies
            </p>
            <ul className="space-y-2 text-sm text-ink-400">
              <li><Link href="/policies/privacy" className="hover:text-accent-300">Privacy Policy</Link></li>
              <li><Link href="/policies/cancellation" className="hover:text-accent-300">Cancellation Policy</Link></li>
              <li><Link href="/policies/terms" className="hover:text-accent-300">Service Terms</Link></li>
            </ul>
          </div>
        </Container>
        <div className="border-t border-ink-800/60 py-5 text-center text-xs text-ink-500">
          © {new Date().getFullYear()} {settings.businessName}. {settings.city},{" "}
          {settings.province}, Canada.
        </div>
      </footer>
    </div>
  );
}
