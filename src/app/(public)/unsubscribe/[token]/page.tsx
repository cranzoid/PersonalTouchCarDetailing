import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { Container } from "@/components/ui";
import { db, schema } from "@/db";
import { verifyUnsubscribeToken } from "@/lib/marketing/unsubscribe";
import { UnsubscribeForm } from "./unsubscribe-form";

export const metadata = { title: "Unsubscribe", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

/** j***@example.com — enough to recognise, not enough to harvest. */
function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain) return "this address";
  return `${local.slice(0, 1)}${"*".repeat(Math.max(local.length - 1, 1))}@${domain}`;
}

export default async function UnsubscribePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const recipientId = verifyUnsubscribeToken(token);
  if (!recipientId) notFound();

  // Two kinds of id sign the same way. An outreach recipient is one row of one
  // campaign; a lead is somebody who gave us their address directly — claiming
  // the wash offer, say — and CASL gives them the same right to leave, from the
  // same link, whether or not a campaign has ever been built around them.
  const destination = recipientId.startsWith("lead_")
    ? (
        await db()
          .select({ destination: schema.leads.email })
          .from(schema.leads)
          .where(eq(schema.leads.id, recipientId))
          .limit(1)
      )[0]?.destination
    : (
        await db()
          .select({ destination: schema.outreachRecipients.destination })
          .from(schema.outreachRecipients)
          .where(eq(schema.outreachRecipients.id, recipientId))
          .limit(1)
      )[0]?.destination;
  if (!destination) notFound();

  return (
    <Container className="py-16">
      <div className="mx-auto max-w-xl">
        <h1 className="text-2xl font-bold text-white">Unsubscribe</h1>
        <p className="mt-2 text-sm text-ink-400">
          One click and you are off our marketing list for good.
        </p>
        <div className="mt-6">
          <UnsubscribeForm token={token} maskedEmail={maskEmail(destination)} />
        </div>
      </div>
    </Container>
  );
}
