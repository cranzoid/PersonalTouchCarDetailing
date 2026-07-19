/**
 * All money is integer cents; tax rates are basis points (13% HST = 1300 bp).
 * Floats never touch financial math.
 */

export function formatCents(cents: number, currency = "CAD"): string {
  return new Intl.NumberFormat("en-CA", {
    style: "currency",
    currency,
  }).format(cents / 100);
}

/** Tax on a subtotal, rounded half-up to the nearest cent. */
export function taxCents(subtotalCents: number, rateBp: number): number {
  return Math.round((subtotalCents * rateBp) / 10000);
}

/** Percentage of an amount in basis points, rounded half-up. */
export function percentCents(amountCents: number, bp: number): number {
  return Math.round((amountCents * bp) / 10000);
}
