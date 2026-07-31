/**
 * Display names for `payments.provider`. Single source of truth — this map was
 * previously duplicated in the PDF renderer and the admin invoice page with
 * subtly different wording ("Card" vs "Card (Stripe)") for the same payment.
 */
export const PAYMENT_PROVIDER_LABELS: Record<string, string> = {
  fake: "Test payment",
  stripe: "Card (Stripe)",
  cash: "Cash",
  etransfer: "E-transfer",
  card_terminal: "Card terminal",
};
