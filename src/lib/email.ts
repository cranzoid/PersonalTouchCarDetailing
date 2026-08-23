/**
 * Parsing and validation for the optional CC list on outbound invoice mail.
 *
 * A CC on an invoice hands the recipient a portal token that can *pay* the
 * invoice, so a mistyped address is not a cosmetic problem. Nothing here
 * silently drops a bad entry: callers get the offending address back and show
 * it to the staff member instead of sending to a shorter list than they typed.
 */

/** Enough addresses for a fleet AP chain, few enough that a paste accident is caught. */
export const MAX_CC_RECIPIENTS = 5;

/**
 * Not full RFC 5322 — deliberately the same shape check used for suppression
 * keys (src/lib/marketing/suppressions.ts) so an address can never be valid in
 * one place and unrecognizable in the other.
 */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export type CcParseResult =
  | { ok: true; cc: string[] }
  | { ok: false; error: string };

/**
 * Normalizes a raw CC list typed by staff: splits nothing (the UI already
 * splits), lowercases, drops blanks, removes duplicates and anything equal to
 * the primary recipient, then enforces the cap.
 *
 * `primary` is excluded because Resend would otherwise deliver twice to the
 * same mailbox, and the customer would see their own address in the CC header.
 */
export function parseCcList(raw: readonly string[], primary?: string | null): CcParseResult {
  const primaryKey = primary ? normalizeEmail(primary) : null;
  const seen = new Set<string>();
  const cc: string[] = [];

  for (const entry of raw) {
    const address = normalizeEmail(entry);
    if (!address) continue;
    if (!EMAIL_SHAPE.test(address)) {
      return { ok: false, error: `"${entry.trim()}" is not a valid email address` };
    }
    if (address === primaryKey) continue;
    if (seen.has(address)) continue;
    seen.add(address);
    cc.push(address);
  }

  if (cc.length > MAX_CC_RECIPIENTS) {
    return { ok: false, error: `At most ${MAX_CC_RECIPIENTS} CC addresses can be added` };
  }
  return { ok: true, cc };
}

/** Splits the single free-text field the send panel uses into candidate addresses. */
export function splitCcInput(value: string): string[] {
  return value
    .split(/[,;\n]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}
