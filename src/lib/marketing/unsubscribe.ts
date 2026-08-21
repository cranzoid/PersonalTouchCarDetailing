import "server-only";

import { createHmac, timingSafeEqual } from "crypto";
import { getAppBaseUrl } from "@/lib/urls";

/**
 * Unsubscribe links for marketing email.
 *
 * The token is an HMAC over the recipient row id, not the email address: the
 * address never appears in a URL that ends up in mail logs, browser history or
 * a Referer header. Stateless by design — CASL requires the link to keep
 * working for at least 60 days, and a signature has no expiry to get wrong and
 * no row that a cleanup job can delete out from under it.
 */
function signingKey(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("SESSION_SECRET must contain at least 32 characters in production");
    }
    return "ptcd-local-unsubscribe-key";
  }
  return secret;
}

function sign(recipientId: string): string {
  return createHmac("sha256", signingKey())
    .update(`unsubscribe:${recipientId}`)
    .digest("base64url");
}

export function unsubscribeToken(recipientId: string): string {
  return `${recipientId}.${sign(recipientId)}`;
}

export function unsubscribeUrl(recipientId: string): string {
  return `${getAppBaseUrl()}/unsubscribe/${unsubscribeToken(recipientId)}`;
}

/** Recipient id from a token, or null if the signature does not verify. */
export function verifyUnsubscribeToken(token: string): string | null {
  const separator = token.lastIndexOf(".");
  if (separator <= 0) return null;
  const recipientId = token.slice(0, separator);
  const provided = Buffer.from(token.slice(separator + 1), "base64url");
  const expected = Buffer.from(sign(recipientId), "base64url");
  if (provided.length !== expected.length) return null;
  return timingSafeEqual(provided, expected) ? recipientId : null;
}
