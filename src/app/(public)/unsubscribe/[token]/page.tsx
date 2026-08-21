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

  const [recipient] = await db()
    .select({ destination: schema.outreachRecipients.destination })
    .from(schema.outreachRecipients)
    .where(eq(schema.outreachRecipients.id, recipientId))
    .limit(1);
  if (!recipient) notFound();

  return (
    <Container className="py-16">
      <div className="mx-auto max-w-xl">
        <h1 className="text-2xl font-bold text-white">Unsubscribe</h1>
        <p className="mt-2 text-sm text-ink-400">
          One click and you are off our marketing list for good.
        </p>
        <div className="mt-6">
          <UnsubscribeForm token={token} maskedEmail={maskEmail(recipient.destination)} />
        </div>
      </div>
    </Container>
  );
}
