import { Container, SectionHeading, Card } from "@/components/ui";
import { ContactForm } from "@/components/contact-form";

export const metadata = { title: "Fleet & Commercial" };

export default function FleetPage() {
  return (
    <Container className="py-16">
      <SectionHeading
        eyebrow="Fleet & Commercial"
        title="Keep your fleet looking professional"
        subtitle="Recurring programs for company fleets, dealerships and rideshare vehicles — with priority scheduling and consolidated billing."
      />
      <div className="mb-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[
          ["Fleet cleaning", "Scheduled washes and interior cleaning for company vehicles."],
          ["Dealership services", "Lot washes, delivery preps and reconditioning support."],
          ["Rideshare packages", "Fast interior turnarounds to keep your ratings high."],
          ["Recurring programs", "Weekly, bi-weekly or monthly schedules with one invoice."],
        ].map(([title, body]) => (
          <Card key={title}>
            <h3 className="font-semibold text-white">{title}</h3>
            <p className="mt-2 text-sm text-ink-400">{body}</p>
          </Card>
        ))}
      </div>
      <div className="max-w-2xl">
        <h2 className="mb-4 text-xl font-bold text-white">Request a fleet consultation</h2>
        <ContactForm kind="fleet" />
      </div>
    </Container>
  );
}
