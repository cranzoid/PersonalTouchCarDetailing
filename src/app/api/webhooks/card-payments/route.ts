import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { newId } from "@/lib/id";
import { getIntegrationSecret } from "@/lib/integrations";
import { isValidWebhookSignature } from "@/lib/helcim/verify";
import { handleCardTransactionEvent, handleTerminalCancelEvent } from "@/lib/payments";

/**
 * Helcim webhook receiver (Integrations → Webhooks in Helcim). The path must
 * not contain the word "helcim" — Helcim refuses to save such a URL — and it
 * must be the canonical www host, because the apex answers with a redirect a
 * webhook sender will not follow.
 *
 * A webhook is only a nudge. `cardTransaction` carries nothing but a
 * transaction id; the handler fetches the transaction from Helcim's API and
 * settles the matching checkout exactly as the browser and the hourly
 * reconciliation would. So a webhook that never arrives costs at most an
 * hour's delay, and a forged one — even past the signature — moves nothing.
 *
 * Each delivery is recorded in webhook_events under Helcim's message id, so a
 * retried delivery is a no-op once processed.
 */
export async function POST(req: Request) {
  const verifierToken = await getIntegrationSecret("helcimWebhookVerifierToken");
  if (!verifierToken) return new NextResponse("Webhook verification is not configured", { status: 503 });

  const body = await req.text();
  const messageId = req.headers.get("webhook-id");
  const valid = isValidWebhookSignature({
    id: messageId,
    timestamp: req.headers.get("webhook-timestamp"),
    signature: req.headers.get("webhook-signature"),
    body,
    verifierToken,
  });
  if (!valid || !messageId) return new NextResponse("Invalid signature", { status: 401 });

  let payload: { id?: unknown; type?: unknown; data?: Record<string, unknown> };
  try {
    payload = JSON.parse(body);
  } catch {
    return new NextResponse("Invalid body", { status: 400 });
  }
  const type = typeof payload.type === "string" ? payload.type : "unknown";

  await db()
    .insert(schema.webhookEvents)
    .values({ id: newId("whe"), provider: "helcim", eventId: messageId, eventType: type, payload })
    .onConflictDoNothing({ target: schema.webhookEvents.eventId });
  const [event] = await db()
    .select()
    .from(schema.webhookEvents)
    .where(eq(schema.webhookEvents.eventId, messageId))
    .limit(1);
  if (event?.processedAt) return new NextResponse("ok", { status: 200 });

  try {
    let result = "ignored";
    if (type === "cardTransaction" && payload.id != null) {
      result = await handleCardTransactionEvent(String(payload.id));
    } else if (type === "terminalCancel" && payload.data) {
      result = await handleTerminalCancelEvent(payload.data as Parameters<typeof handleTerminalCancelEvent>[0]);
    }
    await db()
      .update(schema.webhookEvents)
      .set({ processedAt: new Date(), error: null })
      .where(eq(schema.webhookEvents.eventId, messageId));
    return NextResponse.json({ ok: true, result });
  } catch (error) {
    console.error("[card-payments webhook] handling failed", error);
    // Left unprocessed so Helcim's retry schedule tries again.
    await db()
      .update(schema.webhookEvents)
      .set({ error: error instanceof Error ? error.message.slice(0, 500) : "unknown error" })
      .where(eq(schema.webhookEvents.eventId, messageId));
    return new NextResponse("Internal error", { status: 500 });
  }
}
