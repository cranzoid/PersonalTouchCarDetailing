import { Container, SectionHeading, ButtonLink } from "@/components/ui";

export const metadata = { title: "Customer Access" };

/**
 * Customer access entry. Phase 1: explains the tokened-link model (estimates,
 * invoices and approvals arrive as secure links — no account needed).
 * Phase 7 adds a full portal over the same access_tokens infrastructure.
 */
export default function PortalPage() {
  return (
    <Container className="py-16">
      <SectionHeading
        eyebrow="Customer access"
        title="Your estimates, approvals and invoices"
        subtitle="No account needed. When we send you an estimate, an approval request or an invoice, it arrives as a secure personal link by email or text."
      />
      <div className="max-w-xl space-y-4 text-ink-300">
        <p>
          Each link is unique to you and expires for your security. From it you can view and
          approve estimates, approve additional work, pay deposits and invoices, and download
          receipts.
        </p>
        <p>
          Can&apos;t find your link, or want a copy of your service history? Contact us and
          we&apos;ll send a fresh secure link to the email or phone number on file.
        </p>
        <div className="flex gap-3 pt-2">
          <ButtonLink href="/contact" variant="outline">Request My Link</ButtonLink>
          <ButtonLink href="/book">Book an Appointment</ButtonLink>
        </div>
      </div>
    </Container>
  );
}
