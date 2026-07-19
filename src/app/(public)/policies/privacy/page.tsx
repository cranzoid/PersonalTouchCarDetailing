import { Container } from "@/components/ui";

export const metadata = { title: "Privacy Policy" };

/**
 * PLACEHOLDER pending legal/owner review — accurate to how the platform
 * actually handles data, but not a substitute for reviewed legal text.
 */
export default function PrivacyPage() {
  return (
    <Container className="prose-invert max-w-3xl py-16">
      <h1 className="text-3xl font-bold text-white">Privacy Policy</h1>
      <p className="mt-2 text-sm text-ink-500">Draft — pending owner and legal review.</p>
      <div className="mt-8 space-y-6 text-ink-300">
        <section>
          <h2 className="text-xl font-semibold text-white">What we collect</h2>
          <p className="mt-2">
            When you book, request a quote or contact us, we collect the contact details you
            provide (name, email, phone), information about your vehicle, and any photos you
            upload. If you arrive from an advertisement or search, we record basic marketing
            attribution (such as the campaign that referred you) to understand how customers find
            us.
          </p>
        </section>
        <section>
          <h2 className="text-xl font-semibold text-white">How we use it</h2>
          <p className="mt-2">
            Your information is used to provide detailing services: preparing quotes, scheduling
            appointments, documenting vehicle condition, invoicing and service-related
            communication. We only send promotional messages if you have explicitly opted in, and
            you can withdraw that consent at any time.
          </p>
        </section>
        <section>
          <h2 className="text-xl font-semibold text-white">Your photos</h2>
          <p className="mt-2">
            Photos of your vehicle are private by default and used only for quotes, inspection
            records and job documentation. We never publish customer vehicle photos in our
            gallery or marketing without your separate, explicit consent.
          </p>
        </section>
        <section>
          <h2 className="text-xl font-semibold text-white">Payment information</h2>
          <p className="mt-2">
            We do not store credit card numbers. Online payments are processed by a payment
            provider; we retain only transaction references and receipts.
          </p>
        </section>
        <section>
          <h2 className="text-xl font-semibold text-white">Correction and deletion</h2>
          <p className="mt-2">
            You may request access to, correction of, or deletion of your personal information by
            contacting us. Financial records are retained as required by law; personal details can
            be anonymized on request.
          </p>
        </section>
      </div>
    </Container>
  );
}
