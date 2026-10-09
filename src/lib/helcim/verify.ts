import { createHash, createHmac, timingSafeEqual } from "crypto";

/**
 * Pure checks on what Helcim sends us. No network, no database — these are the
 * two places where a forged message could otherwise move money in our books,
 * so they are kept small enough to test exhaustively.
 */

/**
 * JSON the way Helcim's servers (PHP) encode it: forward slashes escaped and
 * every non-ASCII character written as a \uXXXX escape. Helcim hashes that form,
 * so "Zoë" in a cardholder name only verifies if we escape it the same way.
 */
export function phpJsonEncode(value: unknown): string {
  return JSON.stringify(value)
    .replace(/\//g, "\\/")
    .replace(/[\u007f-￿]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function sameHex(a: string, b: string): boolean {
  const left = Buffer.from(a.toLowerCase(), "utf8");
  const right = Buffer.from(b.toLowerCase(), "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Checks the hash HelcimPay.js returns with a transaction: sha256 over the
 * encoded transaction data followed by the session's secret token.
 *
 * Both encodings are tried because Helcim documents the PHP form but its own
 * Node and Python examples hash plain JSON; for ordinary ASCII data they are
 * the same string. A pass here is a necessary condition only — the caller
 * still re-reads the transaction from Helcim's API before believing it.
 */
export function isValidCheckoutHash(data: unknown, secretToken: string, hash: string): boolean {
  if (!secretToken || !/^[0-9a-f]{64}$/i.test(hash)) return false;
  const candidates = new Set([JSON.stringify(data), phpJsonEncode(data)]);
  for (const encoded of candidates) {
    const digest = createHash("sha256").update(encoded + secretToken).digest("hex");
    if (sameHex(digest, hash)) return true;
  }
  return false;
}

/** How old a signed webhook may be before it is treated as a replay. */
export const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

/**
 * Verifies a Helcim webhook: HMAC-SHA256, keyed with the base64-decoded
 * verifier token, over `${webhook-id}.${webhook-timestamp}.${body}`. The header
 * may carry several space-separated `v1,<base64>` signatures (during a token
 * rotation); any one matching is enough.
 *
 * `body` must be the raw request text, byte for byte. Re-serialising parsed
 * JSON changes the bytes and fails every signature, which is the correct
 * outcome rather than a bug to work around.
 */
export function isValidWebhookSignature(input: {
  id: string | null;
  timestamp: string | null;
  signature: string | null;
  body: string;
  verifierToken: string;
  nowMs?: number;
}): boolean {
  const { id, timestamp, signature, body } = input;
  if (!id || !timestamp || !signature || !input.verifierToken) return false;
  if (!/^\d+$/.test(timestamp)) return false;
  const ageSeconds = Math.abs((input.nowMs ?? Date.now()) / 1000 - Number(timestamp));
  if (ageSeconds > WEBHOOK_TOLERANCE_SECONDS) return false;

  // Some signing services print the key with a "whsec_" prefix; the bytes are
  // what follows it.
  const key = Buffer.from(input.verifierToken.replace(/^whsec_/, ""), "base64");
  if (key.length === 0) return false;
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64");
  const expectedBytes = Buffer.from(expected, "utf8");

  return signature
    .split(" ")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .some((entry) => {
      const comma = entry.indexOf(",");
      const candidate = comma >= 0 ? entry.slice(comma + 1) : entry;
      const candidateBytes = Buffer.from(candidate, "utf8");
      return candidateBytes.length === expectedBytes.length && timingSafeEqual(candidateBytes, expectedBytes);
    });
}
