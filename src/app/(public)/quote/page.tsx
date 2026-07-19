import { asc, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { Container, SectionHeading } from "@/components/ui";
import { QuoteForm } from "./form";

export const metadata = { title: "Request a Quote" };
export const dynamic = "force-dynamic";

export default async function QuotePage({
  searchParams,
}: {
  searchParams: Promise<{ service?: string }>;
}) {
  const { service: preselectSlug } = await searchParams;
  const services = await db()
    .select({
      id: schema.services.id,
      name: schema.services.name,
      slug: schema.services.slug,
      bookingMode: schema.services.bookingMode,
      photosRequired: schema.services.photosRequiredForQuote,
    })
    .from(schema.services)
    .where(eq(schema.services.active, true))
    .orderBy(asc(schema.services.sort));

  return (
    <Container className="py-16">
      <SectionHeading
        eyebrow="Free quote"
        title="Request a quote"
        subtitle="Tell us about your vehicle and its condition. Photos help us give you an accurate price the first time — especially for paint correction, coatings, tinting and wraps. We'll get back to you within one business day."
      />
      <QuoteForm
        services={services.map((s) => ({
          id: s.id,
          name: s.name,
          slug: s.slug,
          photosRequired: s.photosRequired,
        }))}
        preselectSlug={preselectSlug}
      />
    </Container>
  );
}
