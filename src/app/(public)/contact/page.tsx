import { Container, SectionHeading } from "@/components/ui";
import { ContactForm } from "@/components/contact-form";
import { getSettings } from "@/lib/settings";
import { db, schema } from "@/db";
import { asc } from "drizzle-orm";
import { formatHHMM12 } from "@/lib/tz";
import { pageMetadata, SEO_PAGES } from "@/lib/seo";

export const metadata = pageMetadata(SEO_PAGES.contact);
export const dynamic = "force-dynamic";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export default async function ContactPage() {
  const settings = await getSettings();
  const hours = await db()
    .select()
    .from(schema.businessHours)
    .orderBy(asc(schema.businessHours.weekday));

  return (
    <Container className="py-12 sm:py-16">
      <SectionHeading as="h1" eyebrow="Contact" title={SEO_PAGES.contact.h1} subtitle="Questions, custom work, or anything else — send us a message and we'll reply within one business day." />
      <div className="grid gap-8 lg:grid-cols-[minmax(0,2fr)_minmax(18rem,1fr)] lg:items-start">
        <ContactForm />
        <aside aria-label="Business contact information" className="space-y-7 rounded-[2rem] border border-accent-500/25 bg-gradient-to-br from-[#0B2A4A] to-ink-950 p-6 text-sm shadow-2xl shadow-black/20 sm:p-7">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-accent-300">Visit the studio</p>
            <h2 className="mt-2 text-xl font-semibold text-white">Location</h2>
            <address className="mt-3 not-italic leading-6 text-ink-300">
              {settings.addressLine1 && <span className="block">{settings.addressLine1}</span>}
              <span className="block">
                {settings.city}, {settings.province}
                {settings.postalCode ? ` ${settings.postalCode}` : ""}
              </span>
            </address>
            {settings.addressLine1 && (
              <p className="mt-3">
                <a
                  href={`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(`${settings.addressLine1}, ${settings.city}, ${settings.province} ${settings.postalCode}`)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  data-analytics-event="directions_click"
                  className="inline-flex min-h-11 items-center text-accent-300 underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-400"
                >
                  Get directions
                </a>
              </p>
            )}
            {settings.phone && (
              <p className="mt-3">
                <a href={`tel:${settings.phone}`} className="inline-flex min-h-11 items-center text-accent-300 underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-400">{settings.phone}</a>
              </p>
            )}
            {settings.email && (
              <p className="mt-1">
                <a href={`mailto:${settings.email}`} className="inline-flex min-h-11 items-center break-all text-accent-300 underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-400">{settings.email}</a>
              </p>
            )}
          </div>
          <div className="border-t border-white/10 pt-6">
            <h2 className="font-semibold text-white">Business hours</h2>
            <ul className="mt-3 space-y-2 text-ink-300">
              {hours.map((h) => (
                <li key={h.weekday} className="flex justify-between gap-6">
                  <span>{WEEKDAYS[h.weekday]}</span>
                  <span>
                    {h.closed || !h.open || !h.close
                      ? "Closed"
                      : `${formatHHMM12(h.open)} – ${formatHHMM12(h.close)}`}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </aside>
      </div>
    </Container>
  );
}
