import { Container } from "@/components/ui";

export const metadata = { title: "Service Terms" };

/** Deliberately avoids inherited warranties; final counsel review remains an
 * owner-side launch-governance item. */
export default function TermsPage() {
  return (
    <Container className="max-w-4xl py-20 sm:py-28">
      <article className="rounded-[2rem] bg-[#F4F6FA] p-7 text-[#1C2026] shadow-[0_25px_80px_rgba(0,0,0,0.18)] sm:p-12">
      <p className="text-xs font-semibold uppercase tracking-[0.22em] text-accent-600">Before your service</p>
      <h1 className="mt-4 font-display text-4xl text-[#0B2A4A] sm:text-5xl">Service Terms</h1>
      <p className="mt-3 text-sm text-slate-500">Last updated July 23, 2026</p>
      <div className="mt-10 space-y-8 text-sm leading-7 text-slate-700 sm:text-base">
        <section>
          <h2 className="font-display text-2xl text-[#0B2A4A]">Estimates and pricing</h2>
          <p className="mt-2">
            Online prices are starting points for vehicles in standard condition. Final pricing is
            confirmed at check-in after we inspect the vehicle with you. Any additional work is
            only performed with your recorded approval.
          </p>
        </section>
        <section>
          <h2 className="font-display text-2xl text-[#0B2A4A]">Vehicle condition</h2>
          <p className="mt-2">
            Pre-existing damage (scratches, dents, worn surfaces, prior paint work) is documented
            during check-in. We are not responsible for conditions present before service or for
            defects revealed by cleaning (e.g. paint damage hidden under dirt), which we will
            bring to your attention when found.
          </p>
        </section>
        <section>
          <h2 className="font-display text-2xl text-[#0B2A4A]">Personal belongings</h2>
          <p className="mt-2">
            Please remove valuables before your appointment. Items found during service are set
            aside and returned at pickup.
          </p>
        </section>
        <section>
          <h2 className="font-display text-2xl text-[#0B2A4A]">Service-specific care</h2>
          <p className="mt-2">
            Coatings, films and correction work carry the product manufacturers&apos; care
            requirements, which we provide as aftercare instructions. Documentation for any
            product warranty offered with your service is provided in writing at completion.
          </p>
        </section>
        <section>
          <h2 className="font-display text-2xl text-[#0B2A4A]">Payment</h2>
          <p className="mt-2">
            Payment is due at pickup unless otherwise arranged. Some services require a deposit
            to reserve time, as shown during booking.
          </p>
        </section>
      </div>
      </article>
    </Container>
  );
}
