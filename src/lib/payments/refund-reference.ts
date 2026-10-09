/**
 * The provider reference stored on a pending or completed card refund row.
 * Its own module so both the ledger rules and the refund executor can read it
 * without importing each other.
 */

const HELCIM_REFUND_REF_PREFIX = "helcim_refund_v1";

/**
 * What a pending card refund row points at: the payment it returns money from,
 * that payment's Helcim transaction, and — once Helcim has answered — the
 * refund transaction itself. Packed into `payments.provider_ref` so a refund
 * row stays self-describing without another column.
 */
export type HelcimRefundReference = {
  sourcePaymentId: string;
  sourceTransactionId: string;
  refundTransactionId?: string;
};

export function encodeHelcimRefundReference(reference: HelcimRefundReference): string {
  return [
    HELCIM_REFUND_REF_PREFIX,
    reference.sourcePaymentId,
    reference.sourceTransactionId,
    reference.refundTransactionId ?? "",
  ].join("|");
}

export function decodeHelcimRefundReference(value: string | null): HelcimRefundReference | null {
  if (!value) return null;
  const [prefix, sourcePaymentId, sourceTransactionId, refundTransactionId, ...extra] = value.split("|");
  if (prefix !== HELCIM_REFUND_REF_PREFIX || !sourcePaymentId || !sourceTransactionId || extra.length > 0) return null;
  return { sourcePaymentId, sourceTransactionId, ...(refundTransactionId ? { refundTransactionId } : {}) };
}
