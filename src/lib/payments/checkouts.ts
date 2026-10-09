import { randomBytes } from "crypto";
import { and, asc, desc, eq, inArray, lt, or } from "drizzle-orm";
import { db, schema, type Db } from "@/db";
import { audit } from "@/lib/audit";
import { newId } from "@/lib/id";
import { recalculateInvoiceStatus, summarizePayments } from "@/lib/invoices";
import { getIntegrationSecret } from "@/lib/integrations";
import {
  cardLabelFor,
  findCardTransactionsByInvoiceNumber,
  getCardTransaction,
  HelcimApiError,
  idempotencyKeyFor,
  initializeCheckout,
  purchaseWithCardToken,
  startTerminalPurchase,
  type CheckoutLineItem,
  type HelcimTransaction,
} from "@/lib/helcim/client";
import { isValidCheckoutHash } from "@/lib/helcim/verify";
import { sendCheckoutFollowUps } from "@/lib/payments/follow-ups";
import { applyPaidUpgrade } from "@/lib/memberships/settle";
import type { CheckoutSubject } from "@/db/schema";

/**
 * The Helcim checkout engine. One row in `payment_checkouts` per attempt to
 * take a card payment, whatever the channel:
 *
 *  - online        HelcimPay.js in the customer's browser, on our page
 *  - terminal      an amount pushed to the counter's Smart Terminal
 *  - card_on_file  a saved card charged by us (membership months, upgrades)
 *
 * The rule every path keeps: NOTHING is marked paid on anyone's word but
 * Helcim's API. The browser's success message, a webhook and the hourly
 * reconciliation all end the same way — fetch the transaction from Helcim,
 * check it is approved, for exactly this amount, under this checkout's own
 * reference — and only then move the ledger, inside one transaction that
 * locks the checkout row so two of them arriving together settle it once.
 */

export type CheckoutRow = typeof schema.paymentCheckouts.$inferSelect;
export type CheckoutKind =
  | "invoices"
  | "appointment_deposit"
  | "appointment_prepay"
  | "winter_pass"
  | "membership_signup"
  | "membership_charge"
  | "membership_upgrade"
  | "card_update"
  | "terminal";
export type CheckoutChannel = "online" | "terminal" | "card_on_file";

/** Helcim's sessions last 60 minutes; we stop offering one at 55. */
const SESSION_LIFETIME_MS = 55 * 60_000;
/** An unpaid online session is given this long after expiry before we give up on it. */
const ONLINE_EXPIRY_GRACE_MS = 10 * 60_000;
/** A terminal that has not answered in this long is not going to. */
const TERMINAL_TIMEOUT_MS = 10 * 60_000;
/** An ambiguous saved-card charge with no transaction at Helcim after this long failed. */
const CARD_ON_FILE_TIMEOUT_MS = 30 * 60_000;

const REFERENCE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Our reference for one checkout, sent to Helcim as the invoice number. */
export function newCheckoutReference(): string {
  const bytes = randomBytes(12);
  let out = "PTC";
  for (const byte of bytes) out += REFERENCE_ALPHABET[byte % 32];
  return out;
}

export class CheckoutError extends Error {}

/* ------------------------------------------------------------------ */
/* Creating checkouts                                                   */
/* ------------------------------------------------------------------ */

type PendingPayment = {
  customerId: string;
  invoiceId?: string;
  appointmentId?: string;
  kind: "payment" | "deposit";
  amountCents: number;
};

/**
 * Inserts a checkout and the pending ledger rows it will settle. Pending rows
 * never count towards a balance (summarizePayments reads only succeeded ones);
 * they exist so the amounts are fixed by the server before the customer sees
 * a card form, and so a finalizer can never invent an allocation.
 */
export async function insertCheckout(
  tx: Pick<Db, "insert">,
  input: {
    kind: CheckoutKind;
    channel: CheckoutChannel;
    customerId: string;
    amountCents: number;
    currency: string;
    subject: CheckoutSubject;
    payments: PendingPayment[];
    helcimCustomerCode?: string | null;
    deviceCode?: string | null;
    createdByStaffId?: string | null;
  },
): Promise<CheckoutRow> {
  const paymentTotal = input.payments.reduce((sum, p) => sum + p.amountCents, 0);
  if (input.payments.length > 0 && paymentTotal !== input.amountCents) {
    throw new CheckoutError("Checkout allocations do not add up to its amount");
  }
  const id = newId("chk");
  const [checkout] = await tx
    .insert(schema.paymentCheckouts)
    .values({
      id,
      kind: input.kind,
      channel: input.channel,
      customerId: input.customerId,
      reference: newCheckoutReference(),
      amountCents: input.amountCents,
      currency: input.currency.toUpperCase(),
      subject: input.subject,
      helcimCustomerCode: input.helcimCustomerCode ?? null,
      deviceCode: input.deviceCode ?? null,
      createdByStaffId: input.createdByStaffId ?? null,
    })
    .returning();
  const provider = input.channel === "terminal" ? "helcim_terminal" : "helcim";
  for (const [index, payment] of input.payments.entries()) {
    await tx.insert(schema.payments).values({
      id: newId("pay"),
      invoiceId: payment.invoiceId ?? null,
      appointmentId: payment.appointmentId ?? null,
      customerId: payment.customerId,
      provider,
      idempotencyKey: `checkout_${id}_${index}`,
      kind: payment.kind,
      amountCents: payment.amountCents,
      status: "pending",
      checkoutId: id,
      recordedByStaffId: input.createdByStaffId ?? null,
    });
  }
  return checkout;
}

/**
 * Opens (or resumes) the HelcimPay.js session for an online checkout. A
 * session still comfortably inside its hour is reused, so reloading the page
 * never opens a second payment for the same bill.
 */
export async function ensureOnlineSession(
  checkout: CheckoutRow,
  options: {
    lineItems: CheckoutLineItem[];
    paymentType?: "purchase" | "verify";
    newCustomer?: { customerCode: string; contactName: string; cellPhone?: string; businessName?: string };
    saveCard?: boolean;
  },
): Promise<{ checkoutToken: string }> {
  const now = Date.now();
  if (checkout.checkoutToken && checkout.expiresAt && checkout.expiresAt.getTime() > now + 2 * 60_000) {
    return { checkoutToken: checkout.checkoutToken };
  }
  const session = await initializeCheckout({
    paymentType: options.paymentType ?? "purchase",
    amountCents: options.paymentType === "verify" ? 0 : checkout.amountCents,
    currency: checkout.currency,
    invoiceNumber: checkout.reference,
    lineItems: options.lineItems,
    customerCode: checkout.helcimCustomerCode ?? undefined,
    newCustomer: checkout.helcimCustomerCode ? undefined : options.newCustomer,
    setAsDefaultPaymentMethod: options.saveCard,
  });
  const [updated] = await db()
    .update(schema.paymentCheckouts)
    .set({
      checkoutToken: session.checkoutToken,
      secretToken: session.secretToken,
      expiresAt: new Date(now + SESSION_LIFETIME_MS),
      updatedAt: new Date(),
    })
    .where(and(eq(schema.paymentCheckouts.id, checkout.id), eq(schema.paymentCheckouts.status, "open")))
    .returning();
  if (!updated) throw new CheckoutError("This payment was already completed or closed.");
  return { checkoutToken: session.checkoutToken };
}

/* ------------------------------------------------------------------ */
/* Invoice checkouts (portal link, fleet workspace, customer account)  */
/* ------------------------------------------------------------------ */

export type InvoiceSelection = { invoiceIds: string[]; allowedCustomerIds: string[] };

/**
 * Why an invoice cannot be paid online right now, or null if it can. Shared by
 * the pages (to grey a checkbox out) and the claim (to refuse it), so the two
 * can never disagree about what is payable.
 */
export function onlinePayBlocker(
  invoice: Pick<typeof schema.invoices.$inferSelect, "status" | "taxTreatment" | "quotedPaymentMethod">,
  balanceCents: number,
): string | null {
  if (invoice.status === "draft") return "This invoice has not been issued yet.";
  if (invoice.status === "cancelled" || invoice.status === "refunded") return `This invoice was ${invoice.status}.`;
  if (balanceCents <= 0) return "This invoice is already paid in full.";
  // Card is a taxable method. An invoice priced for cash or e-transfer carries
  // no tax, so paying it online would settle a tax document that describes a
  // different sale (DECISIONS #18).
  if (invoice.taxTreatment === "none" && invoice.quotedPaymentMethod) {
    return "This invoice was priced for cash or e-transfer, so it is paid in person rather than by card online.";
  }
  return null;
}

function sameAllocations(
  a: { invoiceId: string; amountCents: number }[] | undefined,
  b: { invoiceId: string; amountCents: number }[],
): boolean {
  if (!a || a.length !== b.length) return false;
  const key = (list: { invoiceId: string; amountCents: number }[]) =>
    [...list].sort((x, y) => x.invoiceId.localeCompare(y.invoiceId)).map((x) => `${x.invoiceId}:${x.amountCents}`).join(",");
  return key(a) === key(b);
}

/**
 * Settles, with Helcim, every open online checkout that touches these
 * invoices, before a new one is allowed. Paid ones are finalized; unpaid ones
 * are left for the claim to reuse (same selection) or close (different one).
 */
async function reconcileOverlappingInvoiceCheckouts(invoiceIds: string[]): Promise<void> {
  if (invoiceIds.length === 0) return;
  const pending = await db()
    .selectDistinct({ checkoutId: schema.payments.checkoutId })
    .from(schema.payments)
    .where(
      and(
        inArray(schema.payments.invoiceId, invoiceIds),
        eq(schema.payments.status, "pending"),
        inArray(schema.payments.provider, ["helcim"]),
      ),
    );
  for (const { checkoutId } of pending) {
    if (checkoutId) await reconcileCheckout(checkoutId);
  }
}

/**
 * Starts (or resumes) one online payment for a set of invoice balances.
 * Every invoice is locked, checked against the caller's allowed customers and
 * against `onlinePayBlocker`, and its balance is read from the ledger — the
 * client chooses WHICH invoices, never how much.
 */
export async function beginInvoicesCheckout(
  input: InvoiceSelection & { createdByStaffId?: string | null },
): Promise<
  | { ok: true; checkoutId: string; checkoutToken: string; amountCents: number }
  | { ok: false; error: string }
> {
  const invoiceIds = [...new Set(input.invoiceIds)].sort();
  if (invoiceIds.length === 0) return { ok: false, error: "Choose at least one invoice to pay." };
  if (invoiceIds.length > 50) return { ok: false, error: "Please pay at most 50 invoices at a time." };

  await reconcileOverlappingInvoiceCheckouts(invoiceIds);

  const claim = await db().transaction(async (tx) => {
    // Sorted ids → a stable lock order, so two overlapping checkouts can
    // never deadlock on each other's invoices.
    const invoices = await tx
      .select()
      .from(schema.invoices)
      .where(inArray(schema.invoices.id, invoiceIds))
      .orderBy(asc(schema.invoices.id))
      .for("update");
    if (invoices.length !== invoiceIds.length) return { ok: false as const, error: "One of these invoices is no longer available." };
    const allowed = new Set(input.allowedCustomerIds);
    const allocations: { invoiceId: string; amountCents: number; customerId: string; number: number }[] = [];
    for (const invoice of invoices) {
      if (!allowed.has(invoice.customerId)) return { ok: false as const, error: "One of these invoices is no longer available." };
      const payments = await tx.select().from(schema.payments).where(eq(schema.payments.invoiceId, invoice.id));
      const { balanceCents } = summarizePayments(invoice.totalCents, invoice.depositAppliedCents, payments);
      const blocker = onlinePayBlocker(invoice, balanceCents);
      if (blocker) return { ok: false as const, error: invoices.length > 1 ? `INV-${invoice.number}: ${blocker}` : blocker };
      allocations.push({ invoiceId: invoice.id, amountCents: balanceCents, customerId: invoice.customerId, number: invoice.number });
    }
    const wanted = allocations.map(({ invoiceId, amountCents }) => ({ invoiceId, amountCents }));

    // Open checkouts still holding any of these invoices (reconciliation above
    // has already finalized the paid ones).
    const holders = await tx
      .selectDistinct({ checkoutId: schema.payments.checkoutId })
      .from(schema.payments)
      .where(and(inArray(schema.payments.invoiceId, invoiceIds), eq(schema.payments.status, "pending")));
    const holderIds = holders.map((h) => h.checkoutId).filter((id): id is string => Boolean(id));
    const openHolders = holderIds.length
      ? await tx
          .select()
          .from(schema.paymentCheckouts)
          .where(and(inArray(schema.paymentCheckouts.id, holderIds), eq(schema.paymentCheckouts.status, "open")))
          .for("update")
      : [];
    for (const holder of openHolders) {
      const reusable =
        holder.channel === "online" &&
        holder.kind === "invoices" &&
        sameAllocations(holder.subject.allocations, wanted) &&
        (!holder.expiresAt || holder.expiresAt.getTime() > Date.now() + 2 * 60_000);
      if (reusable) return { ok: true as const, checkout: holder, allocations };
      if (holder.channel === "terminal") {
        return { ok: false as const, error: "A card payment for this invoice is in progress at the shop's terminal." };
      }
      // A different selection, or a session about to lapse: close it. If the
      // customer still somehow completes it in another tab, the money is
      // recorded anyway (a late success is never thrown away) and staff see
      // the overpayment.
      await closeCheckout(tx, holder.id, "expired", "Replaced by a newer checkout before it was paid");
    }

    const total = allocations.reduce((sum, a) => sum + a.amountCents, 0);
    const checkout = await insertCheckout(tx, {
      kind: "invoices",
      channel: "online",
      customerId: allocations[0].customerId,
      amountCents: total,
      currency: "CAD",
      subject: { allocations: wanted },
      payments: allocations.map((a) => ({ customerId: a.customerId, invoiceId: a.invoiceId, kind: "payment", amountCents: a.amountCents })),
      createdByStaffId: input.createdByStaffId,
    });
    return { ok: true as const, checkout, allocations };
  });
  if (!claim.ok) return claim;

  try {
    const { checkoutToken } = await ensureOnlineSession(claim.checkout, {
      lineItems: claim.allocations.map((a) => ({
        description: `Invoice INV-${a.number}`,
        quantity: 1,
        unitPriceCents: a.amountCents,
      })),
    });
    return { ok: true, checkoutId: claim.checkout.id, checkoutToken, amountCents: claim.checkout.amountCents };
  } catch (error) {
    console.error("beginInvoicesCheckout could not open a Helcim session", error);
    return { ok: false, error: "Online payment is temporarily unavailable. Please try again shortly, or contact us." };
  }
}

/* ------------------------------------------------------------------ */
/* Appointment deposits and prepayments                                */
/* ------------------------------------------------------------------ */

/**
 * A visit that has started or finished is paid on its invoice instead: the
 * invoice applies booking payments only when it is raised, so money taken
 * against the appointment afterwards would never reach it.
 */
const UNPAYABLE_APPOINTMENT_STATUSES = new Set(["cancelled", "no_show", "completed", "converted", "arrived"]);

export async function beginAppointmentCheckout(input: {
  appointmentId: string;
  customerId: string;
  purpose: "deposit" | "prepay";
}): Promise<
  | { ok: true; checkoutId: string; checkoutToken: string; amountCents: number }
  | { ok: false; error: string }
> {
  const kind: CheckoutKind = input.purpose === "deposit" ? "appointment_deposit" : "appointment_prepay";
  const openForAppointment = await db()
    .selectDistinct({ checkoutId: schema.payments.checkoutId })
    .from(schema.payments)
    .where(and(eq(schema.payments.appointmentId, input.appointmentId), eq(schema.payments.status, "pending")));
  for (const { checkoutId } of openForAppointment) if (checkoutId) await reconcileCheckout(checkoutId);

  const claim = await db().transaction(async (tx) => {
    const [appointment] = await tx
      .select()
      .from(schema.appointments)
      .where(eq(schema.appointments.id, input.appointmentId))
      .for("update");
    if (!appointment || appointment.customerId !== input.customerId) {
      return { ok: false as const, error: "This payment link is no longer valid." };
    }
    if (UNPAYABLE_APPOINTMENT_STATUSES.has(appointment.status)) {
      return { ok: false as const, error: "This appointment can no longer be paid online." };
    }
    const amountCents =
      input.purpose === "deposit"
        ? Math.max(0, appointment.depositRequiredCents - appointment.depositPaidCents)
        : Math.max(0, appointment.totalCents - appointment.depositPaidCents);
    if (amountCents <= 0) {
      return {
        ok: false as const,
        error: input.purpose === "deposit" ? "This deposit has already been paid." : "This appointment is already paid in full.",
      };
    }
    if (input.purpose === "deposit" && appointment.status !== "deposit_required") {
      return { ok: false as const, error: "This appointment is not awaiting a deposit." };
    }

    const holders = await tx
      .selectDistinct({ checkoutId: schema.payments.checkoutId })
      .from(schema.payments)
      .where(and(eq(schema.payments.appointmentId, appointment.id), eq(schema.payments.status, "pending")));
    const holderIds = holders.map((h) => h.checkoutId).filter((id): id is string => Boolean(id));
    const openHolders = holderIds.length
      ? await tx
          .select()
          .from(schema.paymentCheckouts)
          .where(and(inArray(schema.paymentCheckouts.id, holderIds), eq(schema.paymentCheckouts.status, "open")))
          .for("update")
      : [];
    for (const holder of openHolders) {
      const reusable =
        holder.kind === kind &&
        holder.amountCents === amountCents &&
        (!holder.expiresAt || holder.expiresAt.getTime() > Date.now() + 2 * 60_000);
      if (reusable) return { ok: true as const, checkout: holder, appointment };
      await closeCheckout(tx, holder.id, "expired", "Replaced by a newer checkout before it was paid");
    }

    const checkout = await insertCheckout(tx, {
      kind,
      channel: "online",
      customerId: appointment.customerId,
      amountCents,
      currency: "CAD",
      subject: { appointmentId: appointment.id, appointmentPurpose: input.purpose },
      payments: [{ customerId: appointment.customerId, appointmentId: appointment.id, kind: "deposit", amountCents }],
    });
    return { ok: true as const, checkout, appointment };
  });
  if (!claim.ok) return claim;

  try {
    const { checkoutToken } = await ensureOnlineSession(claim.checkout, {
      lineItems: [
        {
          description: input.purpose === "deposit" ? "Appointment deposit" : "Appointment prepayment",
          quantity: 1,
          unitPriceCents: claim.checkout.amountCents,
        },
      ],
    });
    return { ok: true, checkoutId: claim.checkout.id, checkoutToken, amountCents: claim.checkout.amountCents };
  } catch (error) {
    console.error("beginAppointmentCheckout could not open a Helcim session", error);
    return { ok: false, error: "Online payment is temporarily unavailable. Please try again shortly, or contact us." };
  }
}

/* ------------------------------------------------------------------ */
/* Confirming, reconciling, finalizing                                  */
/* ------------------------------------------------------------------ */

export type CheckoutOutcome =
  | { status: "succeeded"; checkoutId: string; alreadyProcessed: boolean }
  | { status: "pending"; checkoutId: string }
  | { status: "failed"; checkoutId: string; reason: string };

/** Pulls `{ data, hash }` out of whatever shape the iframe's message took. */
export function parseCheckoutEventMessage(eventMessage: unknown): {
  data: Record<string, unknown> | null;
  hash: string | null;
} {
  let message: unknown = eventMessage;
  for (let depth = 0; depth < 3 && typeof message === "string"; depth++) {
    try {
      message = JSON.parse(message);
    } catch {
      return { data: null, hash: null };
    }
  }
  if (!message || typeof message !== "object") return { data: null, hash: null };
  const record = message as Record<string, unknown>;
  // Documented: { hash, data: {...} }. Seen wrapped once more as { data: { hash, data } }.
  const inner = record.data && typeof record.data === "object" ? (record.data as Record<string, unknown>) : null;
  if (inner && typeof inner.hash === "string" && inner.data && typeof inner.data === "object") {
    return { data: inner.data as Record<string, unknown>, hash: inner.hash };
  }
  if (typeof record.hash === "string" && inner) return { data: inner, hash: record.hash };
  if ("transactionId" in record) return { data: record, hash: null };
  return { data: null, hash: null };
}

/**
 * How sure we are that a transaction belongs to this checkout, beyond Helcim
 * saying it exists:
 *  - "reference": nothing extra — it must carry our reference as its invoice
 *    number (the webhook and reconciliation paths).
 *  - "session":  the HelcimPay.js response hash verified with THIS checkout's
 *    secret token, which only Helcim's iframe for this session can produce.
 *  - "direct":   the transaction is the response to our own API call.
 * The last two are proof enough on their own; the reference is then only
 * checked if Helcim echoed one, so a format difference in how Helcim stores
 * our number can never leave a real payment unrecorded.
 */
type MatchProof = "reference" | "session" | "direct";

function transactionMatches(
  checkout: CheckoutRow,
  transaction: HelcimTransaction,
  proof: MatchProof = "reference",
): string | null {
  if (transaction.status !== "APPROVED") return `Helcim reports the payment as ${transaction.status || "not approved"}`;
  if (transaction.currency && transaction.currency !== checkout.currency) return "Currency did not match";
  if (checkout.kind === "card_update") {
    if (transaction.type !== "verify") return "Expected a card verification";
    if (!checkout.helcimCustomerCode || transaction.customerCode !== checkout.helcimCustomerCode) {
      return "The card was saved to a different customer";
    }
    return null;
  }
  if (!["purchase", "sale"].includes(transaction.type)) return `Unexpected transaction type ${transaction.type}`;
  const referenceOk =
    transaction.invoiceNumber === checkout.reference ||
    (proof !== "reference" && !transaction.invoiceNumber);
  if (!referenceOk) return "The payment belongs to a different checkout";
  const amountOk =
    checkout.channel === "terminal"
      ? transaction.amountCents >= checkout.amountCents
      : transaction.amountCents === checkout.amountCents;
  if (!amountOk) return "The amount paid did not match";
  return null;
}

/**
 * The browser's half of an online payment: the iframe said SUCCESS. The hash
 * is checked, then the transaction is fetched from Helcim and matched to this
 * checkout before anything moves. A browser that lies gets nothing — the
 * reference link means only a real payment for THIS checkout can settle it.
 */
export async function confirmOnlineCheckout(input: {
  checkoutId: string;
  eventMessage: unknown;
  /** Customer records the caller is acting for; the checkout must be one of theirs. */
  allowedCustomerIds?: string[];
}): Promise<CheckoutOutcome | { status: "not_found" }> {
  const [checkout] = await db()
    .select()
    .from(schema.paymentCheckouts)
    .where(eq(schema.paymentCheckouts.id, input.checkoutId))
    .limit(1);
  if (!checkout || checkout.channel !== "online") return { status: "not_found" };
  if (input.allowedCustomerIds && !input.allowedCustomerIds.includes(checkout.customerId)) return { status: "not_found" };
  if (checkout.status === "succeeded") return { status: "succeeded", checkoutId: checkout.id, alreadyProcessed: true };

  const { data, hash } = parseCheckoutEventMessage(input.eventMessage);
  const transactionId = data?.transactionId != null ? String(data.transactionId) : null;
  const hashOk = Boolean(data && hash && checkout.secretToken && isValidCheckoutHash(data, checkout.secretToken, hash));
  if (data && hash && !hashOk) {
    console.warn(`[checkout ${checkout.id}] HelcimPay.js response hash did not verify; relying on Helcim's API`);
  }

  if (transactionId) {
    const transaction = await getCardTransaction(transactionId);
    if (transaction) {
      // A card verification has no reference to tie it to this checkout, so
      // for that one kind the signed hash is required as well.
      if (checkout.kind === "card_update" && !hashOk) {
        return { status: "failed", checkoutId: checkout.id, reason: "The card confirmation could not be verified" };
      }
      return settleWithTransaction(checkout.id, transaction, hashOk ? "session" : "reference");
    }
  }
  // No usable transaction id: ask Helcim by our reference instead.
  return reconcileCheckout(checkout.id);
}

/**
 * Asks Helcim whether this checkout was paid and settles it either way:
 * approved → finalized; long enough without a payment → closed. Safe to run
 * any number of times from any number of places.
 */
export async function reconcileCheckout(checkoutId: string, now = new Date()): Promise<CheckoutOutcome> {
  const [checkout] = await db()
    .select()
    .from(schema.paymentCheckouts)
    .where(eq(schema.paymentCheckouts.id, checkoutId))
    .limit(1);
  if (!checkout) return { status: "failed", checkoutId, reason: "Unknown checkout" };
  if (checkout.status === "succeeded") return { status: "succeeded", checkoutId, alreadyProcessed: true };

  if (checkout.kind !== "card_update") {
    let transactions: HelcimTransaction[] = [];
    try {
      transactions = await findCardTransactionsByInvoiceNumber(checkout.reference);
    } catch (error) {
      console.error(`[checkout ${checkout.id}] reconciliation lookup failed`, error);
      return { status: "pending", checkoutId };
    }
    const approved = transactions.find((t) => transactionMatches(checkout, t) === null);
    if (approved) return settleWithTransaction(checkout.id, approved);
    // A terminal decline is final for that attempt; the customer can tap again
    // only after staff send a new request.
    const declined = transactions.find((t) => t.status === "DECLINED" && t.invoiceNumber === checkout.reference);
    if (declined && checkout.status === "open" && checkout.channel !== "online") {
      await db().transaction((tx) => closeCheckout(tx, checkout.id, "failed", "The card was declined"));
      return { status: "failed", checkoutId, reason: "The card was declined" };
    }
  }

  if (checkout.status !== "open") {
    return { status: "failed", checkoutId, reason: checkout.failureReason ?? "Closed" };
  }
  const age = now.getTime() - checkout.createdAt.getTime();
  const expired =
    checkout.channel === "online"
      ? now.getTime() > (checkout.expiresAt?.getTime() ?? checkout.createdAt.getTime() + SESSION_LIFETIME_MS) + ONLINE_EXPIRY_GRACE_MS
      : checkout.channel === "terminal"
        ? age > TERMINAL_TIMEOUT_MS
        : age > CARD_ON_FILE_TIMEOUT_MS;
  if (expired) {
    const reason =
      checkout.channel === "terminal"
        ? "No answer from the terminal"
        : checkout.channel === "online"
          ? "The checkout expired unpaid"
          : "No charge was recorded at Helcim";
    await db().transaction((tx) => closeCheckout(tx, checkout.id, checkout.channel === "online" ? "expired" : "failed", reason));
    return { status: "failed", checkoutId, reason };
  }
  return { status: "pending", checkoutId };
}

/** Closes an unpaid checkout and fails its pending ledger rows. */
export async function closeCheckout(
  tx: Pick<Db, "update">,
  checkoutId: string,
  status: "failed" | "expired",
  reason: string,
): Promise<void> {
  const now = new Date();
  const closed = await tx
    .update(schema.paymentCheckouts)
    .set({ status, failureReason: reason, updatedAt: now })
    .where(and(eq(schema.paymentCheckouts.id, checkoutId), eq(schema.paymentCheckouts.status, "open")))
    .returning({ id: schema.paymentCheckouts.id });
  if (closed.length === 0) return;
  await tx
    .update(schema.payments)
    .set({ status: "failed", failureReason: reason, updatedAt: now })
    .where(and(eq(schema.payments.checkoutId, checkoutId), eq(schema.payments.status, "pending")));
}

/** Finalizes in one transaction, then sends receipts once it has committed. */
async function settleWithTransaction(
  checkoutId: string,
  transaction: HelcimTransaction,
  proof: MatchProof = "reference",
): Promise<CheckoutOutcome> {
  let outcome: Awaited<ReturnType<typeof finalizeCheckout>>;
  try {
    outcome = await db().transaction((tx) => finalizeCheckout(tx, checkoutId, transaction, proof));
  } catch (error) {
    // The transaction id is unique: losing that race to a webhook finalizing
    // the same payment means it is settled, not failed.
    const [row] = await db()
      .select()
      .from(schema.paymentCheckouts)
      .where(eq(schema.paymentCheckouts.id, checkoutId))
      .limit(1);
    if (row?.status === "succeeded") return { status: "succeeded", checkoutId, alreadyProcessed: true };
    throw error;
  }
  if (outcome.status === "succeeded" && !outcome.alreadyProcessed) {
    try {
      await sendCheckoutFollowUps(checkoutId);
    } catch (error) {
      // The money is recorded. A failed receipt must never make a settled
      // payment look failed to the customer, who might then pay again.
      console.error(`[checkout ${checkoutId}] follow-up messages failed`, error);
    }
  }
  return outcome;
}

/**
 * Moves the ledger for one approved Helcim transaction. Locks the checkout
 * first; every other lock (invoices, appointments) follows in a fixed order.
 */
export async function finalizeCheckout(
  tx: Db,
  checkoutId: string,
  transaction: HelcimTransaction,
  proof: MatchProof = "reference",
): Promise<CheckoutOutcome> {
  const [checkout] = await tx
    .select()
    .from(schema.paymentCheckouts)
    .where(eq(schema.paymentCheckouts.id, checkoutId))
    .for("update");
  if (!checkout) return { status: "failed", checkoutId, reason: "Unknown checkout" };
  if (checkout.status === "succeeded") {
    if (checkout.helcimTransactionId === transaction.transactionId) {
      return { status: "succeeded", checkoutId, alreadyProcessed: true };
    }
    // A second approved payment under one reference: the customer has paid
    // twice. Record nothing automatically — flag it for a refund.
    await audit(tx, {
      actorType: "system",
      action: "checkout.duplicate_payment",
      entityType: "payment_checkout",
      entityId: checkout.id,
      after: { firstTransactionId: checkout.helcimTransactionId, secondTransactionId: transaction.transactionId, amountCents: transaction.amountCents },
    });
    return { status: "succeeded", checkoutId, alreadyProcessed: true };
  }
  const mismatch = transactionMatches(checkout, transaction, proof);
  if (mismatch) return { status: "failed", checkoutId, reason: mismatch };

  const now = new Date();
  await tx
    .update(schema.paymentCheckouts)
    .set({
      status: "succeeded",
      helcimTransactionId: transaction.transactionId,
      transaction: transaction.raw,
      cardToken: transaction.cardToken ?? checkout.cardToken,
      cardLabel: cardLabelFor(transaction) ?? checkout.cardLabel,
      helcimCustomerCode: transaction.customerCode ?? checkout.helcimCustomerCode,
      failureReason: null,
      completedAt: now,
      updatedAt: now,
    })
    .where(eq(schema.paymentCheckouts.id, checkout.id));

  const subject = checkout.subject;

  // Card-saving checkouts store the card on the membership BEFORE the invoice
  // is recalculated, so the activation that follows sees a usable card.
  if (subject.membershipId && (checkout.kind === "membership_signup" || checkout.kind === "card_update")) {
    await tx
      .update(schema.memberships)
      .set({
        cardToken: transaction.cardToken,
        cardLabel: cardLabelFor(transaction),
        helcimCustomerCode: transaction.customerCode ?? checkout.helcimCustomerCode,
        updatedAt: now,
      })
      .where(eq(schema.memberships.id, subject.membershipId));
  }

  const rows = await tx
    .select()
    .from(schema.payments)
    .where(eq(schema.payments.checkoutId, checkout.id))
    .orderBy(asc(schema.payments.id))
    .for("update");

  // The terminal may come back with more than was asked for: the customer
  // added a tip on the device. It is a tip on the invoice — outside the
  // subtotal, so never taxed (DECISIONS #39) — not an overpayment.
  const surplus = checkout.channel === "terminal" ? transaction.amountCents - checkout.amountCents : 0;

  const invoiceIds = new Set<string>();
  for (const row of rows) {
    if (row.status === "succeeded") continue;
    let amountCents = row.amountCents;
    if (surplus > 0 && row.invoiceId && rows.length === 1) {
      const [invoice] = await tx.select().from(schema.invoices).where(eq(schema.invoices.id, row.invoiceId)).for("update");
      if (invoice) {
        await tx
          .update(schema.invoices)
          .set({
            tipCents: invoice.tipCents + surplus,
            tipBasisBp: null,
            totalCents: invoice.totalCents + surplus,
            updatedAt: now,
          })
          .where(eq(schema.invoices.id, invoice.id));
        amountCents += surplus;
      }
    }
    await tx
      .update(schema.payments)
      .set({
        status: "succeeded",
        amountCents,
        providerRef: transaction.transactionId,
        failureReason: null,
        receivedAt: now,
        updatedAt: now,
      })
      .where(eq(schema.payments.id, row.id));
    if (row.invoiceId) invoiceIds.add(row.invoiceId);
    if (row.appointmentId) {
      const [appointment] = await tx
        .select()
        .from(schema.appointments)
        .where(eq(schema.appointments.id, row.appointmentId))
        .for("update");
      if (appointment) {
        const depositPaidCents = appointment.depositPaidCents + amountCents;
        const confirms = appointment.status === "deposit_required" && depositPaidCents >= appointment.depositRequiredCents;
        await tx
          .update(schema.appointments)
          .set({ depositPaidCents, status: confirms ? "confirmed" : appointment.status, updatedAt: now })
          .where(eq(schema.appointments.id, appointment.id));
        await audit(tx, {
          actorType: "system",
          action: subject.appointmentPurpose === "prepay" ? "appointment.prepaid" : "appointment.deposit_payment_succeeded",
          entityType: "appointment",
          entityId: appointment.id,
          before: { status: appointment.status, depositPaidCents: appointment.depositPaidCents },
          after: { status: confirms ? "confirmed" : appointment.status, depositPaidCents, paymentId: row.id, provider: row.provider },
        });
      }
    }
  }
  for (const invoiceId of [...invoiceIds].sort()) {
    await recalculateInvoiceStatus(tx, invoiceId);
  }
  // An upgrade takes effect when its difference is paid — whichever path
  // (our own charge, a webhook, reconciliation) confirmed it.
  if (checkout.kind === "membership_upgrade" && subject.membershipId && subject.toPlanId) {
    await applyPaidUpgrade(tx, subject.membershipId, subject.toPlanId);
  }

  await audit(tx, {
    actorType: "system",
    action: "checkout.succeeded",
    entityType: "payment_checkout",
    entityId: checkout.id,
    after: {
      kind: checkout.kind,
      channel: checkout.channel,
      reference: checkout.reference,
      transactionId: transaction.transactionId,
      amountCents: transaction.amountCents,
      ...(surplus > 0 ? { tipCents: surplus } : {}),
    },
  });
  return { status: "succeeded", checkoutId, alreadyProcessed: false };
}

/** Hourly: settle every checkout left open, oldest first. */
export async function reconcileOpenCheckouts(now = new Date()): Promise<{ checked: number; succeeded: number; closed: number }> {
  const open = await db()
    .select({ id: schema.paymentCheckouts.id })
    .from(schema.paymentCheckouts)
    .where(
      and(
        eq(schema.paymentCheckouts.status, "open"),
        lt(schema.paymentCheckouts.createdAt, new Date(now.getTime() - 2 * 60_000)),
      ),
    )
    .orderBy(asc(schema.paymentCheckouts.createdAt))
    .limit(100);
  let succeeded = 0;
  let closed = 0;
  for (const { id } of open) {
    const outcome = await reconcileCheckout(id, now);
    if (outcome.status === "succeeded") succeeded++;
    if (outcome.status === "failed") closed++;
  }
  return { checked: open.length, succeeded, closed };
}

/* ------------------------------------------------------------------ */
/* Webhooks                                                             */
/* ------------------------------------------------------------------ */

export async function handleCardTransactionEvent(transactionId: string): Promise<string> {
  const transaction = await getCardTransaction(transactionId);
  if (!transaction) return "unknown_transaction";
  if (!transaction.invoiceNumber) return "unrelated";
  const [checkout] = await db()
    .select()
    .from(schema.paymentCheckouts)
    .where(eq(schema.paymentCheckouts.reference, transaction.invoiceNumber))
    .limit(1);
  if (!checkout) return "unrelated";
  if (transaction.status === "APPROVED") {
    const outcome = await settleWithTransaction(checkout.id, transaction);
    return outcome.status;
  }
  if (checkout.status === "open" && checkout.channel === "terminal") {
    await db().transaction((tx) => closeCheckout(tx, checkout.id, "failed", "The card was declined on the terminal"));
    return "declined";
  }
  return "ignored";
}

export async function handleTerminalCancelEvent(data: {
  invoiceNumber?: string;
  deviceCode?: string;
  transactionAmount?: number | string;
}): Promise<string> {
  const amountCents = Math.round(Number(data.transactionAmount ?? NaN) * 100);
  const candidates = await db()
    .select()
    .from(schema.paymentCheckouts)
    .where(
      and(
        eq(schema.paymentCheckouts.status, "open"),
        eq(schema.paymentCheckouts.channel, "terminal"),
        data.invoiceNumber
          ? eq(schema.paymentCheckouts.reference, data.invoiceNumber)
          : or(eq(schema.paymentCheckouts.deviceCode, data.deviceCode ?? ""), eq(schema.paymentCheckouts.deviceCode, "")),
      ),
    )
    .orderBy(desc(schema.paymentCheckouts.createdAt))
    .limit(5);
  const match = candidates.find((c) => data.invoiceNumber || !Number.isFinite(amountCents) || c.amountCents === amountCents);
  if (!match) return "no_open_terminal_checkout";
  await db().transaction((tx) => closeCheckout(tx, match.id, "failed", "Cancelled on the terminal"));
  return "cancelled";
}

/* ------------------------------------------------------------------ */
/* Smart Terminal                                                       */
/* ------------------------------------------------------------------ */

export async function getTerminalDeviceCode(): Promise<string | null> {
  return (await getIntegrationSecret("helcimTerminalDeviceCode"))?.trim().toUpperCase() || null;
}

/** Pushes an invoice's balance to the counter terminal. */
export async function startInvoiceTerminalCheckout(input: {
  invoiceId: string;
  staffId: string;
}): Promise<{ ok: true; checkoutId: string; amountCents: number } | { ok: false; error: string }> {
  const deviceCode = await getTerminalDeviceCode();
  if (!deviceCode) {
    return { ok: false, error: "No Smart Terminal is set up. Add its device code in Admin → Integrations." };
  }
  const openHolders = await db()
    .selectDistinct({ checkoutId: schema.payments.checkoutId })
    .from(schema.payments)
    .where(and(eq(schema.payments.invoiceId, input.invoiceId), eq(schema.payments.status, "pending")));
  for (const { checkoutId } of openHolders) if (checkoutId) await reconcileCheckout(checkoutId);

  const claim = await db().transaction(async (tx) => {
    const [invoice] = await tx.select().from(schema.invoices).where(eq(schema.invoices.id, input.invoiceId)).for("update");
    if (!invoice) return { ok: false as const, error: "Invoice not found" };
    if (invoice.status === "cancelled" || invoice.status === "refunded" || invoice.status === "draft") {
      return { ok: false as const, error: `A ${invoice.status} invoice cannot take a payment` };
    }
    const payments = await tx.select().from(schema.payments).where(eq(schema.payments.invoiceId, invoice.id));
    const { balanceCents } = summarizePayments(invoice.totalCents, invoice.depositAppliedCents, payments);
    if (balanceCents <= 0) return { ok: false as const, error: "This invoice is already paid in full." };
    if (invoice.taxTreatment === "none" && invoice.quotedPaymentMethod) {
      return {
        ok: false as const,
        error: "This invoice was settled as a cash or e-transfer sale, so its balance can't be taken by card.",
      };
    }
    const pending = payments.filter((p) => p.status === "pending" && p.checkoutId);
    if (pending.length > 0) {
      return { ok: false as const, error: "Another card payment for this invoice is still open. Wait for it to finish, then try again." };
    }
    const checkout = await insertCheckout(tx, {
      kind: "terminal",
      channel: "terminal",
      customerId: invoice.customerId,
      amountCents: balanceCents,
      currency: "CAD",
      subject: { allocations: [{ invoiceId: invoice.id, amountCents: balanceCents }] },
      payments: [{ customerId: invoice.customerId, invoiceId: invoice.id, kind: "payment", amountCents: balanceCents }],
      deviceCode,
      createdByStaffId: input.staffId,
    });
    await audit(tx, {
      actorType: "staff",
      actorId: input.staffId,
      action: "invoice.terminal_payment_requested",
      entityType: "invoice",
      entityId: invoice.id,
      after: { checkoutId: checkout.id, amountCents: balanceCents, deviceCode },
    });
    return { ok: true as const, checkout };
  });
  if (!claim.ok) return claim;

  try {
    await startTerminalPurchase({
      deviceCode,
      amountCents: claim.checkout.amountCents,
      currency: claim.checkout.currency,
      invoiceNumber: claim.checkout.reference,
    });
  } catch (error) {
    const reason =
      error instanceof HelcimApiError && error.status === 409
        ? "The terminal isn't listening — check it is on, signed in and in API mode."
        : error instanceof HelcimApiError && error.status === 404
          ? "Helcim doesn't recognise that terminal device code."
          : error instanceof HelcimApiError
            ? `Helcim refused the request: ${error.message}`
            : "Could not reach Helcim. Check the connection and try again.";
    await db().transaction((tx) => closeCheckout(tx, claim.checkout.id, "failed", reason));
    return { ok: false, error: reason };
  }
  return { ok: true, checkoutId: claim.checkout.id, amountCents: claim.checkout.amountCents };
}

/* ------------------------------------------------------------------ */
/* Cards on file                                                        */
/* ------------------------------------------------------------------ */

/**
 * Charges a saved card for one invoice. Synchronous when Helcim answers;
 * when it does not (timeout, 5xx) the checkout is left open and the hourly
 * reconciliation finds the outcome by our reference. Nothing ever re-sends a
 * charge without first asking Helcim about the previous one.
 */
export async function chargeCardOnFile(input: {
  kind: "membership_charge" | "membership_upgrade";
  customerId: string;
  invoiceId: string;
  amountCents: number;
  cardToken: string;
  helcimCustomerCode: string;
  description: string;
  subject: CheckoutSubject;
  ipAddress: string;
  createdByStaffId?: string | null;
}): Promise<{ status: "approved" | "declined" | "pending"; checkoutId: string; message?: string }> {
  const checkout = await db().transaction((tx) =>
    insertCheckout(tx, {
      kind: input.kind,
      channel: "card_on_file",
      customerId: input.customerId,
      amountCents: input.amountCents,
      currency: "CAD",
      subject: { ...input.subject, allocations: [{ invoiceId: input.invoiceId, amountCents: input.amountCents }] },
      payments: [{ customerId: input.customerId, invoiceId: input.invoiceId, kind: "payment", amountCents: input.amountCents }],
      helcimCustomerCode: input.helcimCustomerCode,
      createdByStaffId: input.createdByStaffId,
    }),
  );

  let transaction: HelcimTransaction;
  try {
    transaction = await purchaseWithCardToken({
      cardToken: input.cardToken,
      customerCode: input.helcimCustomerCode,
      amountCents: input.amountCents,
      currency: "CAD",
      invoiceNumber: checkout.reference,
      lineItems: [{ description: input.description, quantity: 1, unitPriceCents: input.amountCents }],
      idempotencyKey: idempotencyKeyFor(`checkout:${checkout.id}`),
      ipAddress: input.ipAddress,
    });
  } catch (error) {
    if (error instanceof HelcimApiError && error.status >= 400 && error.status < 500) {
      // A definitive refusal — the card token is gone, the request was
      // rejected. No money moved.
      await db().transaction((tx) => closeCheckout(tx, checkout.id, "failed", error.message));
      return { status: "declined", checkoutId: checkout.id, message: error.message };
    }
    console.error(`[checkout ${checkout.id}] card-on-file charge outcome unknown`, error);
    return { status: "pending", checkoutId: checkout.id };
  }

  if (transaction.status !== "APPROVED") {
    const message = `Declined${transaction.approvalCode ? ` (${transaction.approvalCode})` : ""}`;
    await db().transaction((tx) => closeCheckout(tx, checkout.id, "failed", message));
    return { status: "declined", checkoutId: checkout.id, message };
  }
  const outcome = await settleWithTransaction(checkout.id, transaction, "direct");
  if (outcome.status === "succeeded") return { status: "approved", checkoutId: checkout.id };
  return { status: "pending", checkoutId: checkout.id, message: outcome.status === "failed" ? outcome.reason : undefined };
}

/** What a customer-facing confirm action returns to HelcimCheckoutButton. */
export function toConfirmResult(
  outcome: CheckoutOutcome | { status: "not_found" },
): { ok: true; status: "succeeded" | "pending" } | { ok: false; error: string } {
  if (outcome.status === "succeeded") return { ok: true, status: "succeeded" };
  if (outcome.status === "pending") return { ok: true, status: "pending" };
  if (outcome.status === "not_found") return { ok: false, error: "This payment could not be found" };
  return { ok: false, error: outcome.reason };
}
