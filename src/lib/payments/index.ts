/**
 * Card payments. Helcim is the only processor: HelcimPay.js on our own pages
 * for customers, the Smart Terminal at the counter, and cards on file for
 * memberships. The checkout engine lives in ./checkouts; this file holds the
 * ledger rules that do not depend on how the money arrived.
 *
 * Stripe was removed on 2026-10-08. Rows it wrote (`provider` "stripe", and
 * "fake" from development) are still read and labelled, never written.
 */

export * from "./checkouts";
export * from "./refund-reference";
export { executeCardRefund, type CardRefundResult } from "./refunds";
import { decodeHelcimRefundReference } from "./refund-reference";

/** Providers whose payments can be refunded to the card through Helcim's API. */
export const CARD_PROVIDERS: ReadonlySet<string> = new Set(["helcim", "helcim_terminal"]);

type RefundLedgerEntry = {
  id: string;
  kind: string;
  provider: string;
  providerRef: string | null;
  amountCents: number;
  status: string;
};

/**
 * How much of an invoice can go back to the card through Helcim, and how much
 * only by hand (cash, e-transfer, cheque — or a deposit, which was taken
 * against the appointment and is refunded there).
 *
 * Card money is tracked per source transaction, because a refund is always
 * against one specific Helcim transaction and can never exceed it.
 */
export function getRefundAvailability(entries: RefundLedgerEntry[], depositAppliedCents = 0): {
  cardRefundableCents: number;
  manualRefundableCents: number;
  cardSources: Array<{ paymentId: string; transactionId: string; refundableCents: number }>;
} {
  const succeededPayments = entries.filter((entry) => entry.kind === "payment" && entry.status === "succeeded");
  const reservedRefunds = entries.filter(
    (entry) => entry.kind === "refund" && (entry.status === "pending" || entry.status === "succeeded"),
  );
  const isCardRefund = (entry: RefundLedgerEntry) => CARD_PROVIDERS.has(entry.provider);
  const cardRefundedCents = reservedRefunds.filter(isCardRefund).reduce((sum, entry) => sum + entry.amountCents, 0);
  const manualRefundedCents = reservedRefunds
    .filter((entry) => !isCardRefund(entry))
    .reduce((sum, entry) => sum + entry.amountCents, 0);

  const reservedBySource = new Map<string, number>();
  for (const refund of reservedRefunds.filter(isCardRefund)) {
    const reference = decodeHelcimRefundReference(refund.providerRef);
    if (!reference) continue;
    reservedBySource.set(
      reference.sourcePaymentId,
      (reservedBySource.get(reference.sourcePaymentId) ?? 0) + refund.amountCents,
    );
  }
  const cardSources = succeededPayments
    .filter((entry) => CARD_PROVIDERS.has(entry.provider) && Boolean(entry.providerRef))
    .map((entry) => ({
      paymentId: entry.id,
      transactionId: entry.providerRef!,
      refundableCents: Math.max(0, entry.amountCents - (reservedBySource.get(entry.id) ?? 0)),
    }))
    .filter((entry) => entry.refundableCents > 0);
  const cardPaidCents = succeededPayments
    .filter((entry) => CARD_PROVIDERS.has(entry.provider))
    .reduce((sum, entry) => sum + entry.amountCents, 0);
  // Payments by any other route — including the retired Stripe checkout, whose
  // charges can no longer be refunded through an API we hold — come back by
  // hand.
  const manualPaidCents =
    Math.max(0, depositAppliedCents) +
    succeededPayments
      .filter((entry) => !CARD_PROVIDERS.has(entry.provider))
      .reduce((sum, entry) => sum + entry.amountCents, 0);

  return {
    cardRefundableCents: Math.max(0, cardPaidCents - cardRefundedCents),
    manualRefundableCents: Math.max(0, manualPaidCents - manualRefundedCents),
    cardSources,
  };
}
