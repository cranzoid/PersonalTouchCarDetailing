import { Container } from "@/components/ui";

export const metadata = { title: "Service Terms" };

/** PLACEHOLDER pending owner/legal review. Deliberately avoids inherited warranties. */
export default function TermsPage() {
  return (
    <Container className="max-w-3xl py-16">
      <h1 className="text-3xl font-bold text-white">Service Terms</h1>
      <p className="mt-2 text-sm text-ink-500">Draft — pending owner and legal review.</p>
      <div className="mt-8 space-y-6 text-ink-300">
        <section>
          <h2 className="text-xl font-semibold text-white">Estimates and pricing</h2>
          <p className="mt-2">
            Online prices are starting points for vehicles in standard condition. Final pricing is
            confirmed at check-in after we inspect the vehicle with you. Any additional work is
            only performed with your recorded approval.
          </p>
        </section>
        <section>
          <h2 className="text-xl font-semibold text-white">Vehicle condition</h2>
          <p className="mt-2">
            Pre-existing damage (scratches, dents, worn surfaces, prior paint work) is documented
            during check-in. We are not responsible for conditions present before service or for
            defects revealed by cleaning (e.g. paint damage hidden under dirt), which we will
            bring to your attention when found.
          </p>
        </section>
        <section>
          <h2 className="text-xl font-semibold text-white">Personal belongings</h2>
          <p className="mt-2">
            Please remove valuables before your appointment. Items found during service are set
            aside and returned at pickup.
          </p>
        </section>
        <section>
          <h2 className="text-xl font-semibold text-white">Service-specific care</h2>
          <p className="mt-2">
            Coatings, films and correction work carry the product manufacturers&apos; care
            requirements, which we provide as aftercare instructions. Documentation for any
            product warranty offered with your service is provided in writing at completion.
          </p>
        </section>
        <section>
          <h2 className="text-xl font-semibold text-white">Payment</h2>
          <p className="mt-2">
            Payment is due at pickup unless otherwise arranged. Some services require a deposit
            to reserve time, as shown during booking.
          </p>
        </section>
      </div>
    </Container>
  );
}
