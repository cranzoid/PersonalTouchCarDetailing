import { NextResponse } from "next/server";
import { getIntegrationSecret } from "@/lib/integrations";
import { recordInboundSms, verifyTwilioSignature, type InboundSmsOutcome } from "@/lib/marketing/inbound";
import { notifyStaffOfCustomerReply } from "@/lib/staff-notifications";
import { getAppBaseUrl } from "@/lib/urls";

/**
 * Inbound SMS receiver for the shop's Twilio number.
 *
 * Configure it as the "A MESSAGE COMES IN" webhook (HTTP POST) on the number in
 * the Twilio Console — the URL must match `signatureUrl()` below EXACTLY,
 * including scheme and any trailing path, because Twilio signs the string it
 * was given and a mismatch fails every request as a bad signature.
 *
 * Replies to a marketing campaign land here, as does every STOP. Twilio blocks
 * a stopped number on its own side regardless of this route; what this adds is
 * that we can see the reply, that the opt-out becomes binding on email and on
 * every future campaign too, and that a reply wakes a staff phone instead of
 * waiting for someone to open the inbox.
 */
export const dynamic = "force-dynamic";

/** The exact URL Twilio is configured with, which is what it signs. */
function signatureUrl(): string {
  return `${getAppBaseUrl()}/api/webhooks/twilio/sms`;
}

/** Empty TwiML: accept the message without auto-replying to the sender. */
function emptyTwiml(): NextResponse {
  return new NextResponse('<?xml version="1.0" encoding="UTF-8"?><Response></Response>', {
    status: 200,
    headers: { "Content-Type": "text/xml; charset=utf-8" },
  });
}

export async function POST(req: Request) {
  const authToken = await getIntegrationSecret("twilioAuthToken");
  // Without the token there is no way to tell a real delivery from a forged
  // one, so the route refuses everything rather than trusting the body.
  if (!authToken) return new NextResponse("Messaging provider not configured", { status: 503 });

  let params: Record<string, string>;
  try {
    const form = await req.formData();
    params = Object.fromEntries(
      [...form.entries()].map(([key, value]) => [key, typeof value === "string" ? value : ""]),
    );
  } catch {
    return new NextResponse("Malformed request", { status: 400 });
  }

  const valid = verifyTwilioSignature({
    url: signatureUrl(),
    params,
    signature: req.headers.get("x-twilio-signature"),
    authToken,
  });
  if (!valid) return new NextResponse("Invalid signature", { status: 403 });

  const messageSid = params.MessageSid || params.SmsSid;
  const from = params.From;
  if (!messageSid || !from) return new NextResponse("Missing message fields", { status: 400 });

  const body = params.Body ?? "";
  let outcome: InboundSmsOutcome;
  try {
    outcome = await recordInboundSms({
      messageSid,
      from,
      to: params.To ?? "",
      body,
      payload: params,
    });
  } catch (error) {
    // Never echo the message body or the sender's number into logs. A non-2xx
    // makes Twilio retry, and the MessageSid dedupe makes that retry safe.
    console.error("[webhooks:twilio] failed to record inbound SMS", error instanceof Error ? error.message : "");
    return new NextResponse("Could not record message", { status: 500 });
  }

  // Someone is waiting for an answer, so staff hear about it now rather than
  // the next time somebody opens the inbox. Only for a genuine reply: STOP and
  // START are acted on automatically and must not be texted back.
  //
  // Guarded on `processed` so a Twilio retry — which is deduped into a no-op
  // above — cannot alert twice, and best-effort so a messaging outage leaves
  // the reply recorded rather than provoking retries of a stored message.
  if (outcome.processed && outcome.action === "reply") {
    try {
      await notifyStaffOfCustomerReply({
        from,
        body,
        customerId: outcome.matchedCustomerId,
        leadId: outcome.matchedLeadId,
        needsAttention: outcome.needsAttention,
      });
    } catch {
      console.error("[webhooks:twilio] inbound SMS recorded but staff alert could not be queued");
    }
  }

  return emptyTwiml();
}
