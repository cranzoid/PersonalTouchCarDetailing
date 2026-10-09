import { Container } from "@/components/ui";
import { pageMetadata, SEO_PAGES } from "@/lib/seo";

export const metadata = pageMetadata(SEO_PAGES.terms);

/** Deliberately avoids inherited warranties; final counsel review remains an
 * owner-side launch-governance item. */
export default function TermsPage() {
  return (
    <Container className="max-w-4xl py-20 sm:py-28">
      <article className="rounded-[2rem] bg-[#F4F6FA] p-7 text-[#1C2026] shadow-[0_25px_80px_rgba(0,0,0,0.18)] sm:p-12">
      <p className="text-xs font-semibold uppercase tracking-[0.22em] text-accent-600">Before your service</p>
      <h1 className="mt-4 font-display text-4xl text-[#0B2A4A] sm:text-5xl">Service Terms</h1>
      <p className="mt-3 text-sm text-slate-500">Last updated October 8, 2026</p>
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
            to reserve time, as shown during booking. You may also pay ahead online. Card payments
            online are processed by Helcim; we never see or store your full card number.
          </p>
        </section>
        <section id="memberships">
          <h2 className="font-display text-2xl text-[#0B2A4A]">Memberships</h2>
          <ul className="mt-2 list-disc space-y-2 pl-5">
            <li>
              A membership covers one vehicle. Its benefits cannot be used on another vehicle or
              shared.
            </li>
            <li>
              Membership prices are shown before HST; HST is added to each monthly charge. By
              joining you authorize us to charge your card on file each month, on the day you
              joined, until you cancel.
            </li>
            <li>
              Monthly benefits — such as the included hand wash and, where your plan includes it,
              the basic interior clean — are for that month only and do not roll over.
            </li>
            <li>
              Member discounts apply to the detailing packages and add-ons named on your plan. They
              do not combine with other offers; the better discount applies.
            </li>
            <li>
              You can cancel any time from your account or by contacting us. Cancellation takes
              effect at the end of the month you have already paid for, and your benefits continue
              until then. Payments already made are not refunded.
            </li>
            <li>
              If a monthly payment fails, benefits pause until it is collected. We will retry the
              card and let you know; if we cannot collect it, the membership ends.
            </li>
            <li>
              An upgrade takes effect immediately: we charge the difference between the two monthly
              prices that day, and the new price applies from your next billing date.
            </li>
            <li>
              We may change a plan, for example when the season changes. We will tell you before a
              change takes effect, and you may cancel before then.
            </li>
          </ul>
        </section>
        <section id="winter-pass">
          <h2 className="font-display text-2xl text-[#0B2A4A]">Winter Pass</h2>
          <p className="mt-2">
            The Winter Pass is prepaid and covers one vehicle for the number of hand washes shown at
            purchase, to be used within the season stated on it. Washes not used by the end of the
            season expire.
          </p>
        </section>
      </div>
      </article>
    </Container>
  );
}
