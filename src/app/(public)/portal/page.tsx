import { Container, SectionHeading, ButtonLink } from "@/components/ui";

export const metadata = { title: "Customer Access" };

/**
 * Customer access entry. Phase 1: explains the tokened-link model (estimates,
 * invoices and approvals arrive as secure links — no account needed).
 * Phase 7 adds a full portal over the same access_tokens infrastructure.
 */
export default function PortalPage() {
  return (
    <Container className="py-12 sm:py-16">
      <SectionHeading
        eyebrow="Customer access"
        title="Your estimates, approvals and invoices"
        subtitle="No account needed. When we send you an estimate, an approval request or an invoice, it arrives as a secure personal link by email or text."
      />
      <div className="max-w-2xl rounded-[2rem] border border-accent-500/25 bg-gradient-to-br from-[#0B2A4A] to-ink-950 p-6 text-ink-200 shadow-2xl shadow-black/20 sm:p-8">
        <p className="text-sm font-semibold uppercase tracking-[0.18em] text-accent-300">Secure by design</p>
        <div className="mt-4 space-y-4 leading-7">
        <p>
          Each link is unique to you and expires for your security. From it you can view and
          approve estimates, approve additional work, pay deposits and invoices, and download
          receipts.
        </p>
        <p>
          Can&apos;t find your link, or want a copy of your service history? Contact us and
          we&apos;ll send a fresh secure link to the email or phone number on file.
        </p>
        </div>
        <div className="mt-6 flex flex-col gap-3 sm:flex-row">
          <ButtonLink href="/contact" variant="outline" className="min-h-11">Request My Link</ButtonLink>
          <ButtonLink href="/book" className="min-h-11">Book an Appointment</ButtonLink>
        </div>
      </div>
    </Container>
  );
}
