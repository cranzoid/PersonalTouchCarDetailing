import { Container, SectionHeading, Card } from "@/components/ui";
import { ContactForm } from "@/components/contact-form";

export const metadata = { title: "Fleet & Commercial" };

export default function FleetPage() {
  return (
    <>
      <Container className="py-20 sm:py-28">
        <div className="grid gap-12 lg:grid-cols-[1.15fr_0.85fr] lg:items-end">
          <SectionHeading
            eyebrow="Fleet & commercial"
            title="A cleaner fleet, without the administrative drag"
            subtitle="Recurring care for company fleets, dealerships and rideshare vehicles—with priority scheduling, company records and consolidated billing."
          />
          <div className="grid grid-cols-2 gap-3 text-center text-sm">
            {["One company profile", "Multiple vehicles", "Job history", "Consolidated invoices"].map((item) => (
              <div key={item} className="rounded-2xl border border-white/10 bg-white/[0.04] px-3 py-4 font-medium text-ink-200">{item}</div>
            ))}
          </div>
        </div>
      </Container>

      <section className="surface-light py-20">
        <Container>
          <SectionHeading tone="light" eyebrow="Programs" title="Built around the way your vehicles work" />
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {[
              ["Fleet cleaning", "Scheduled exterior and interior care for company vehicles."],
              ["Dealership support", "Lot washes, delivery preparation and reconditioning support."],
              ["Rideshare care", "Focused interior turnarounds for busy driver schedules."],
              ["Recurring programs", "Flexible service cadence with consolidated account billing."],
            ].map(([title, body], index) => (
              <Card key={title} tone="light">
                <span className="text-xs font-semibold tracking-[0.2em] text-accent-600">0{index + 1}</span>
                <h3 className="mt-5 font-display text-2xl text-[#0B2A4A]">{title}</h3>
                <p className="mt-3 text-sm leading-6 text-slate-600">{body}</p>
              </Card>
            ))}
          </div>
        </Container>
      </section>

      <Container className="py-20 sm:py-24">
        <div className="grid gap-12 lg:grid-cols-[0.7fr_1.3fr]">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-accent-300">Start a conversation</p>
            <h2 className="mt-4 font-display text-4xl leading-tight text-white">Request a fleet consultation</h2>
            <p className="mt-4 text-sm leading-7 text-ink-300">Tell us how many vehicles you manage, how they are used and the cadence you need. We&apos;ll reply with a practical service plan.</p>
          </div>
          <Card className="p-6 sm:p-8"><ContactForm kind="fleet" /></Card>
        </div>
      </Container>
    </>
  );
}
