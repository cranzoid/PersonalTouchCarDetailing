import { createHash } from "crypto";
import { getIntegrationSecret } from "@/lib/integrations";

/**
 * The Helcim API, reduced to the calls this shop makes. Every function here is
 * a thin, typed wrapper: no database access and no business rules, so the
 * payment logic in src/lib/payments can be tested by mocking this one module.
 *
 * Amounts cross this boundary in cents and are converted to Helcim's decimal
 * dollars here and nowhere else.
 */

const BASE_URL = "https://api.helcim.com/v2";
const TIMEOUT_MS = 20_000;

export class HelcimNotConfiguredError extends Error {
  constructor() {
    super("Online card payments are not configured: the Helcim API token is missing.");
  }
}

/** A refusal from Helcim's API, with its own messages — safe to show staff. */
export class HelcimApiError extends Error {
  constructor(
    readonly status: number,
    readonly errors: string[],
  ) {
    super(errors.join("; ") || `Helcim returned HTTP ${status}`);
  }
}

export type HelcimTransaction = {
  transactionId: string;
  /** APPROVED | DECLINED (and other values Helcim may add). */
  status: string;
  /** purchase | refund | reverse | verify | preauth | capture … */
  type: string;
  amountCents: number;
  currency: string;
  cardToken: string | null;
  cardNumber: string | null;
  cardType: string | null;
  cardHolderName: string | null;
  customerCode: string | null;
  invoiceNumber: string | null;
  approvalCode: string | null;
  dateCreated: string | null;
  raw: Record<string, unknown>;
};

export function toHelcimAmount(cents: number): number {
  return Math.round(cents) / 100;
}

export function fromHelcimAmount(amount: unknown): number {
  const value = typeof amount === "number" ? amount : Number(String(amount ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(value) ? Math.round(value * 100) : NaN;
}

function text(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s.length > 0 ? s : null;
}

/** Normalizes the transaction shapes Helcim returns (strings vs numbers). */
export function normalizeTransaction(raw: Record<string, unknown>): HelcimTransaction {
  return {
    transactionId: String(raw.transactionId ?? raw.id ?? ""),
    status: String(raw.status ?? "").toUpperCase(),
    type: String(raw.type ?? "").toLowerCase(),
    amountCents: fromHelcimAmount(raw.amount),
    currency: String(raw.currency ?? "").toUpperCase(),
    cardToken: text(raw.cardToken),
    cardNumber: text(raw.cardNumber),
    cardType: text(raw.cardType),
    cardHolderName: text(raw.cardHolderName),
    customerCode: text(raw.customerCode),
    invoiceNumber: text(raw.invoiceNumber),
    approvalCode: text(raw.approvalCode),
    dateCreated: text(raw.dateCreated),
    raw,
  };
}

const CARD_BRANDS: Record<string, string> = {
  VI: "Visa",
  MC: "Mastercard",
  AX: "Amex",
  AM: "Amex",
  DI: "Discover",
  DS: "Discover",
};

/** "Visa •••• 9990" from a transaction, for showing a member their card. */
export function cardLabelFor(tx: Pick<HelcimTransaction, "cardType" | "cardNumber">): string | null {
  const last4 = tx.cardNumber?.replace(/\D/g, "").slice(-4);
  if (!last4) return null;
  const brand = (tx.cardType && CARD_BRANDS[tx.cardType.toUpperCase()]) ?? tx.cardType ?? "Card";
  return `${brand} •••• ${last4}`;
}

/**
 * Helcim's idempotency keys are 25–36 characters of [A-Za-z0-9_-]. Derived from
 * a stable seed so a retry of the same operation sends the same key.
 */
export function idempotencyKeyFor(seed: string): string {
  return createHash("sha256").update(seed).digest("hex").slice(0, 32);
}

function normalizeErrors(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") return [];
  const errors = (payload as { errors?: unknown }).errors;
  if (typeof errors === "string") return [errors];
  if (Array.isArray(errors)) return errors.map(String);
  if (errors && typeof errors === "object") {
    return Object.entries(errors).map(([field, message]) => `${field}: ${String(message)}`);
  }
  return [];
}

async function apiToken(): Promise<string> {
  const token = await getIntegrationSecret("helcimApiToken");
  if (!token) throw new HelcimNotConfiguredError();
  return token;
}

/** True when an API token is configured (stored or environment). */
export async function isHelcimConfigured(): Promise<boolean> {
  return Boolean(await getIntegrationSecret("helcimApiToken"));
}

async function request<T>(
  method: "GET" | "POST",
  path: string,
  options: { body?: unknown; idempotencyKey?: string; query?: Record<string, string | number | undefined> } = {},
): Promise<{ status: number; data: T | null }> {
  const token = await apiToken();
  const url = new URL(`${BASE_URL}${path}`);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
  }
  const headers: Record<string, string> = { "api-token": token, accept: "application/json" };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.idempotencyKey) headers["idempotency-key"] = options.idempotencyKey;

  const response = await fetch(url, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: "no-store",
  });
  const raw = await response.text();
  let payload: unknown = null;
  if (raw) {
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = null;
    }
  }
  if (!response.ok) {
    const errors = normalizeErrors(payload);
    throw new HelcimApiError(response.status, errors.length > 0 ? errors : [`HTTP ${response.status}`]);
  }
  return { status: response.status, data: payload as T | null };
}

/* ------------------------------------------------------------------ */
/* HelcimPay.js                                                         */
/* ------------------------------------------------------------------ */

export type CheckoutLineItem = { description: string; quantity: number; unitPriceCents: number };

export async function initializeCheckout(input: {
  paymentType: "purchase" | "verify";
  amountCents: number;
  currency: string;
  /** Our reference, created on Helcim as the invoice number of the payment. */
  invoiceNumber: string;
  lineItems: CheckoutLineItem[];
  customerCode?: string;
  /** Creates the Helcim customer with this code if `customerCode` is not given. */
  newCustomer?: { customerCode: string; contactName: string; cellPhone?: string; businessName?: string };
  setAsDefaultPaymentMethod?: boolean;
}): Promise<{ checkoutToken: string; secretToken: string }> {
  const body: Record<string, unknown> = {
    paymentType: input.paymentType,
    amount: toHelcimAmount(input.amountCents),
    currency: input.currency.toUpperCase(),
    paymentMethod: "cc",
    confirmationScreen: false,
    customStyling: { brandColor: "0B2A4A", cornerRadius: "rounded", appearance: "light" },
  };
  // A verify takes no money, so there is no invoice to record it against.
  if (input.paymentType === "purchase") {
    body.invoiceRequest = {
      invoiceNumber: input.invoiceNumber,
      lineItems: input.lineItems.map((line) => ({
        description: line.description.slice(0, 200),
        quantity: line.quantity,
        price: toHelcimAmount(line.unitPriceCents),
        total: toHelcimAmount(line.unitPriceCents * line.quantity),
      })),
    };
  }
  if (input.customerCode) body.customerCode = input.customerCode;
  else if (input.newCustomer) {
    body.customerRequest = {
      customerCode: input.newCustomer.customerCode,
      contactName: input.newCustomer.contactName.slice(0, 100) || "Customer",
      ...(input.newCustomer.businessName ? { businessName: input.newCustomer.businessName.slice(0, 100) } : {}),
      ...(input.newCustomer.cellPhone ? { cellPhone: input.newCustomer.cellPhone } : {}),
    };
  }
  if (input.setAsDefaultPaymentMethod) body.setAsDefaultPaymentMethod = 1;

  const { data } = await request<{ checkoutToken?: string; secretToken?: string }>("POST", "/helcim-pay/initialize", {
    body,
  });
  if (!data?.checkoutToken || !data.secretToken) throw new HelcimApiError(200, ["Helcim returned no checkout token"]);
  return { checkoutToken: data.checkoutToken, secretToken: data.secretToken };
}

/* ------------------------------------------------------------------ */
/* Transactions                                                          */
/* ------------------------------------------------------------------ */

export async function getCardTransaction(transactionId: string): Promise<HelcimTransaction | null> {
  if (!/^\d+$/.test(transactionId)) return null;
  try {
    const { data } = await request<Record<string, unknown>>("GET", `/card-transactions/${transactionId}`);
    return data ? normalizeTransaction(data) : null;
  } catch (error) {
    // Helcim answers an unknown id with 400 "Failed to retrieve card
    // transaction #n." rather than a 404 (seen on the developer account,
    // 2026-10-08), so both mean "no such transaction".
    if (error instanceof HelcimApiError && (error.status === 404 || error.status === 400)) return null;
    throw error;
  }
}

/** Every card transaction Helcim holds under one of our references. */
export async function findCardTransactionsByInvoiceNumber(invoiceNumber: string): Promise<HelcimTransaction[]> {
  const { data } = await request<unknown>("GET", "/card-transactions", { query: { invoiceNumber, limit: 100 } });
  return Array.isArray(data) ? data.map((row) => normalizeTransaction(row as Record<string, unknown>)) : [];
}

/**
 * Charges a card already in Helcim's vault — a membership's monthly fee. Our
 * reference becomes the Helcim invoice number, which is what the billing
 * engine looks up before ever retrying.
 */
export async function purchaseWithCardToken(input: {
  cardToken: string;
  customerCode: string;
  amountCents: number;
  currency: string;
  invoiceNumber: string;
  lineItems: CheckoutLineItem[];
  idempotencyKey: string;
  ipAddress: string;
}): Promise<HelcimTransaction> {
  const { data } = await request<Record<string, unknown>>("POST", "/payment/purchase", {
    idempotencyKey: input.idempotencyKey,
    body: {
      ipAddress: input.ipAddress,
      ecommerce: true,
      currency: input.currency.toUpperCase(),
      amount: toHelcimAmount(input.amountCents),
      customerCode: input.customerCode,
      invoice: {
        invoiceNumber: input.invoiceNumber,
        lineItems: input.lineItems.map((line) => ({
          description: line.description.slice(0, 200),
          quantity: line.quantity,
          price: toHelcimAmount(line.unitPriceCents),
          total: toHelcimAmount(line.unitPriceCents * line.quantity),
        })),
      },
      cardData: { cardToken: input.cardToken },
    },
  });
  if (!data) throw new HelcimApiError(200, ["Helcim returned an empty purchase response"]);
  return normalizeTransaction(data);
}

export async function refundCardTransaction(input: {
  originalTransactionId: string;
  amountCents: number;
  idempotencyKey: string;
  ipAddress: string;
}): Promise<HelcimTransaction> {
  const { data } = await request<Record<string, unknown>>("POST", "/payment/refund", {
    idempotencyKey: input.idempotencyKey,
    body: {
      originalTransactionId: Number(input.originalTransactionId),
      amount: toHelcimAmount(input.amountCents),
      ipAddress: input.ipAddress,
      ecommerce: true,
    },
  });
  if (!data) throw new HelcimApiError(200, ["Helcim returned an empty refund response"]);
  return normalizeTransaction(data);
}

/**
 * Voids a transaction whose batch has not settled yet. A full reversal only —
 * Helcim's refund endpoint is what takes a partial amount.
 */
export async function reverseCardTransaction(input: {
  transactionId: string;
  idempotencyKey: string;
  ipAddress: string;
}): Promise<HelcimTransaction> {
  const { data } = await request<Record<string, unknown>>("POST", "/payment/reverse", {
    idempotencyKey: input.idempotencyKey,
    body: { cardTransactionId: Number(input.transactionId), ipAddress: input.ipAddress, ecommerce: true },
  });
  if (!data) throw new HelcimApiError(200, ["Helcim returned an empty reverse response"]);
  return normalizeTransaction(data);
}

/* ------------------------------------------------------------------ */
/* Customers                                                             */
/* ------------------------------------------------------------------ */

export async function createHelcimCustomer(input: {
  customerCode: string;
  contactName: string;
  businessName?: string;
  cellPhone?: string;
}): Promise<{ customerCode: string }> {
  const { data } = await request<{ customerCode?: string }>("POST", "/customers", {
    body: {
      customerCode: input.customerCode,
      contactName: input.contactName.slice(0, 100) || "Customer",
      ...(input.businessName ? { businessName: input.businessName.slice(0, 100) } : {}),
      ...(input.cellPhone ? { cellPhone: input.cellPhone } : {}),
    },
  });
  return { customerCode: data?.customerCode ?? input.customerCode };
}

/* ------------------------------------------------------------------ */
/* Smart Terminal                                                        */
/* ------------------------------------------------------------------ */

export async function listTerminalDevices(): Promise<{ code: string; dateCreated: string | null }[]> {
  const { data } = await request<unknown>("GET", "/devices");
  if (!Array.isArray(data)) return [];
  return data.map((row) => ({
    code: String((row as { code?: unknown }).code ?? ""),
    dateCreated: text((row as { dateCreated?: unknown }).dateCreated),
  }));
}

/**
 * Pushes an amount to a Smart Terminal. A 202 only means the device accepted
 * the request; the outcome arrives later as a `cardTransaction` (paid or
 * declined) or `terminalCancel` webhook. A busy device silently drops a second
 * request, and a powered-off one answers 409.
 */
export async function startTerminalPurchase(input: {
  deviceCode: string;
  amountCents: number;
  currency: string;
  invoiceNumber: string;
  customerCode?: string;
}): Promise<void> {
  if (!/^[A-Za-z0-9]{1,4}$/.test(input.deviceCode)) {
    throw new HelcimApiError(400, ["The terminal device code must be up to four letters or digits"]);
  }
  await request("POST", `/devices/${input.deviceCode}/payment/purchase`, {
    body: {
      currency: input.currency.toUpperCase(),
      transactionAmount: toHelcimAmount(input.amountCents),
      invoiceNumber: input.invoiceNumber,
      ...(input.customerCode ? { customerCode: input.customerCode } : {}),
    },
  });
}

export async function testHelcimConnection(): Promise<boolean> {
  const { data } = await request<{ message?: string }>("GET", "/connection-test");
  return /connected/i.test(data?.message ?? "");
}
