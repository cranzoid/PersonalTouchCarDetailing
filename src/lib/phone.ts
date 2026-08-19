/**
 * Phone numbers as typed by humans, reduced to something staff can search on.
 *
 * `customers.phone` is raw text — "(905) 555-1234", "905.555.1234" and
 * "+1 905 555 1234" are all the same number and all appear in live data. The
 * normalized form is stored alongside the original; the original is what gets
 * displayed, because it is what the customer gave us.
 *
 * STAFF-SIDE ONLY. The public booking path deliberately does NOT look a caller
 * up by phone number: doing so would let a stranger who guesses a number attach
 * themselves to somebody else's record — a customer enumeration oracle.
 * DECISIONS.md #14 refused exactly that, and Release 3 does not reopen it.
 */

/**
 * Bare digits, with a leading North American country code dropped so
 * "+1 905 555 1234" and "905-555-1234" match. Returns null for anything with no
 * digits at all, so an empty field never matches another empty field.
 *
 * Kept byte-identical to the SQL backfill in drizzle/0008_tax_treatment.sql.
 */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 0) return null;
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits;
}

/** Display form for a 10-digit North American number; anything else unchanged. */
export function formatPhone(raw: string | null | undefined): string {
  if (!raw) return "";
  const digits = normalizePhone(raw);
  if (digits?.length !== 10) return raw;
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

/**
 * Groups customer rows by normalized phone and returns the numbers held by more
 * than one live customer. Feeds the "possible duplicate" hint in the admin
 * customer list — a prompt for a human to merge, never an automatic match.
 */
export function duplicatePhoneNumbers(
  rows: readonly { phoneNormalized: string | null; anonymizedAt?: Date | null }[],
): Set<string> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (!row.phoneNormalized || row.anonymizedAt) continue;
    counts.set(row.phoneNormalized, (counts.get(row.phoneNormalized) ?? 0) + 1);
  }
  return new Set([...counts.entries()].filter(([, n]) => n > 1).map(([phone]) => phone));
}
