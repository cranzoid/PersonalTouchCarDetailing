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

/**
 * A tax-exclusive price with tax added — the second half of the shop's two
 * customer-facing prices. All listed prices are tax-exclusive and cash or
 * e-transfer pays exactly that; credit and cheque pay this.
 * See PAYMENT_METHOD_TAXABLE in src/lib/types.ts.
 */
export function withTaxCents(cents: number, rateBp: number): number {
  return cents + taxCents(cents, rateBp);
}

/**
 * "$175.00 cash · $197.75 card" — the pair shown wherever a price is quoted
 * before an invoice exists. The invoice remains the tax document; this is a
 * quote, and `priceBooking` still quotes the tax-added figure as the
 * conservative default.
 */
export function dualPriceLabel(cents: number, rateBp: number, currency = "CAD"): string {
  if (rateBp <= 0) return formatCents(cents, currency);
  return `${formatCents(cents, currency)} cash · ${formatCents(withTaxCents(cents, rateBp), currency)} card`;
}
