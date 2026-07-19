import { Container, SectionHeading } from "@/components/ui";
import { ContactForm } from "@/components/contact-form";
import { getSettings } from "@/lib/settings";
import { db, schema } from "@/db";
import { asc } from "drizzle-orm";

export const metadata = { title: "Contact" };
export const dynamic = "force-dynamic";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export default async function ContactPage() {
  const settings = await getSettings();
  const hours = await db()
    .select()
    .from(schema.businessHours)
    .orderBy(asc(schema.businessHours.weekday));

  return (
    <Container className="py-16">
      <SectionHeading eyebrow="Contact" title="Get in touch" subtitle="Questions, custom work, or anything else — send us a message and we'll reply within one business day." />
      <div className="grid gap-12 lg:grid-cols-[2fr_1fr]">
        <ContactForm />
        <aside className="space-y-6 text-sm">
          <div>
            <h3 className="font-semibold text-white">Location</h3>
            <p className="mt-1 text-ink-400">
              {settings.city}, {settings.province}
              {settings.postalCode ? ` ${settings.postalCode}` : ""}
            </p>
            {settings.phone && (
              <p className="mt-1">
                <a href={`tel:${settings.phone}`} className="text-accent-300">{settings.phone}</a>
              </p>
            )}
            {settings.email && (
              <p className="mt-1">
                <a href={`mailto:${settings.email}`} className="text-accent-300">{settings.email}</a>
              </p>
            )}
          </div>
          <div>
            <h3 className="font-semibold text-white">Hours</h3>
            <ul className="mt-2 space-y-1 text-ink-400">
              {hours.map((h) => (
                <li key={h.weekday} className="flex justify-between gap-6">
                  <span>{WEEKDAYS[h.weekday]}</span>
                  <span>{h.closed ? "Closed" : `${h.open} – ${h.close}`}</span>
                </li>
              ))}
            </ul>
          </div>
        </aside>
      </div>
    </Container>
  );
}
