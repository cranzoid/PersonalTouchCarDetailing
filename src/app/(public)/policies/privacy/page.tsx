import { Container } from "@/components/ui";

export const metadata = { title: "Privacy Policy" };

/** Accurate to the platform's implemented data flows. Owner/legal review is
 * still tracked as a launch-governance item rather than exposed as draft copy
 * on the customer-facing page. */
export default function PrivacyPage() {
  return (
    <Container className="max-w-4xl py-20 sm:py-28">
      <article className="rounded-[2rem] bg-[#F4F6FA] p-7 text-[#1C2026] shadow-[0_25px_80px_rgba(0,0,0,0.18)] sm:p-12">
      <p className="text-xs font-semibold uppercase tracking-[0.22em] text-accent-600">Your information</p>
      <h1 className="mt-4 font-display text-4xl text-[#0B2A4A] sm:text-5xl">Privacy Policy</h1>
      <p className="mt-3 text-sm text-slate-500">Last updated July 23, 2026</p>
      <div className="mt-10 space-y-8 text-sm leading-7 text-slate-700 sm:text-base">
        <section>
          <h2 className="font-display text-2xl text-[#0B2A4A]">What we collect</h2>
          <p className="mt-2">
            When you book, request a quote or contact us, we collect the contact details you
            provide (name, email, phone), information about your vehicle, and any photos you
            upload. If you arrive from an advertisement or search, we record basic marketing
            attribution (such as the campaign that referred you) to understand how customers find
            us.
          </p>
        </section>
        <section>
          <h2 className="font-display text-2xl text-[#0B2A4A]">How we use it</h2>
          <p className="mt-2">
            Your information is used to provide detailing services: preparing quotes, scheduling
            appointments, documenting vehicle condition, invoicing and service-related
            communication. We only send promotional messages if you have explicitly opted in, and
            you can withdraw that consent at any time.
          </p>
        </section>
        <section>
          <h2 className="font-display text-2xl text-[#0B2A4A]">Your photos</h2>
          <p className="mt-2">
            Photos of your vehicle are private by default and used only for quotes, inspection
            records and job documentation. We never publish customer vehicle photos in our
            gallery or marketing without your separate, explicit consent.
          </p>
        </section>
        <section>
          <h2 className="font-display text-2xl text-[#0B2A4A]">Payment information</h2>
          <p className="mt-2">
            We do not store credit card numbers. Online payments are processed by a payment
            provider; we retain only transaction references and receipts.
          </p>
        </section>
        <section>
          <h2 className="font-display text-2xl text-[#0B2A4A]">Correction and deletion</h2>
          <p className="mt-2">
            You may request access to, correction of, or deletion of your personal information by
            contacting us. Financial records are retained as required by law; personal details can
            be anonymized on request.
          </p>
        </section>
      </div>
      </article>
    </Container>
  );
}
