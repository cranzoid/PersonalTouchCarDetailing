import { NextResponse } from "next/server";
import { getIntegrationSecret } from "@/lib/integrations";
import { recordInboundSms, verifyTwilioSignature } from "@/lib/marketing/inbound";
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
 * that we can see the reply, and that the opt-out becomes binding on email and
 * on every future campaign too.
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

  try {
    await recordInboundSms({
      messageSid,
      from,
      to: params.To ?? "",
      body: params.Body ?? "",
      payload: params,
    });
  } catch (error) {
    // Never echo the message body or the sender's number into logs. A non-2xx
    // makes Twilio retry, and the MessageSid dedupe makes that retry safe.
    console.error("[webhooks:twilio] failed to record inbound SMS", error instanceof Error ? error.message : "");
    return new NextResponse("Could not record message", { status: 500 });
  }

  return emptyTwiml();
}
