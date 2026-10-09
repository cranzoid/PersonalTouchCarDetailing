"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import {
  accountCustomers,
  getAccountSession,
  requestSignInCode,
  signOutAccount,
  verifySignInCode,
} from "@/lib/accounts/session";
import { BENEFIT_KEYS } from "@/lib/memberships/config";
import { bookMemberVisit, MemberBookingError, memberVisitSlots, type MemberVisitRequest } from "@/lib/memberships/booking";
import { beginWinterPassPurchase } from "@/lib/memberships/passes";
import {
  beginCardUpdate,
  beginMembershipSignup,
  cancelMembership,
  chargeMembershipPeriod,
  ensureAccountCustomer,
  MembershipError,
  resumeMembership,
  upgradeMembership,
} from "@/lib/memberships/service";
import { sendStaffBookingConfirmation } from "@/lib/booking/confirmation";
import { sendAppointmentDepositRequest } from "@/lib/appointment-deposits";
import { getAppBaseUrl } from "@/lib/urls";
import { notifyStaffOfNewAppointment } from "@/lib/staff-notifications";
import { beginInvoicesCheckout, confirmOnlineCheckout, toConfirmResult } from "@/lib/payments";
import { consumeRateLimit } from "@/lib/rate-limit";
import { requestIp } from "@/lib/request-ip";
import { getSettings } from "@/lib/settings";
import { VEHICLE_CATEGORIES } from "@/lib/types";
import type { CheckoutConfirmResult, CheckoutStartResult } from "@/components/helcim-checkout";

type Result = { ok: true; message?: string } | { ok: false; error: string };

async function account() {
  const session = await getAccountSession();
  if (!session) return null;
  const customers = await accountCustomers(session);
  return { session, customers, customerIds: customers.map((c) => c.id) };
}

/* --- signing in ---------------------------------------------------------- */

const contactInput = z.object({ channel: z.enum(["email", "sms"]), contact: z.string().trim().min(3).max(254) });

export async function requestCodeAction(raw: unknown): Promise<Result & { contact?: string }> {
  const parsed = contactInput.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Enter your email address or mobile number." };
  const result = await requestSignInCode(parsed.data);
  return result.ok ? { ok: true, contact: result.contact } : result;
}

export async function verifyCodeAction(raw: unknown): Promise<Result> {
  const parsed = contactInput.extend({ code: z.string().trim().min(6).max(12) }).safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Enter the 6-digit code we sent you." };
  const result = await verifySignInCode(parsed.data);
  if (result.ok) revalidatePath("/account");
  return result;
}

export async function signOutAction(): Promise<void> {
  await signOutAccount();
  redirect("/account");
}

/* --- paying ---------------------------------------------------------------- */

export async function startAccountInvoicesPaymentAction(invoiceIds: unknown): Promise<CheckoutStartResult> {
  const me = await account();
  if (!me) return { ok: false, error: "Please sign in again." };
  const ids = z.array(z.string().regex(/^inv_[a-z0-9]{20}$/)).min(1).max(50).safeParse(invoiceIds);
  if (!ids.success) return { ok: false, error: "Choose at least one invoice to pay." };
  return beginInvoicesCheckout({ invoiceIds: ids.data, allowedCustomerIds: me.customerIds });
}

/**
 * Confirms any checkout started from the account. A card update on a
 * membership whose month failed retries that month straight away — the
 * member fixed their card so their benefits can resume, not to wait for the
 * next scheduled retry.
 */
export async function confirmAccountPaymentAction(checkoutId: string, eventMessage: string): Promise<CheckoutConfirmResult> {
  const me = await account();
  if (!me) return { ok: false, error: "Please sign in again." };
  if (typeof checkoutId !== "string" || typeof eventMessage !== "string") return { ok: false, error: "Invalid request" };
  const outcome = await confirmOnlineCheckout({ checkoutId, eventMessage, allowedCustomerIds: me.customerIds });
  if (outcome.status === "succeeded") {
    const [checkout] = await db().select().from(schema.paymentCheckouts).where(eq(schema.paymentCheckouts.id, checkoutId)).limit(1);
    if (checkout?.kind === "card_update" && checkout.subject.membershipId) {
      const [membership] = await db()
        .select()
        .from(schema.memberships)
        .where(eq(schema.memberships.id, checkout.subject.membershipId))
        .limit(1);
      if (membership?.status === "past_due") {
        const [failed] = await db()
          .select()
          .from(schema.membershipPeriods)
          .where(and(eq(schema.membershipPeriods.membershipId, membership.id), eq(schema.membershipPeriods.status, "failed")))
          .orderBy(desc(schema.membershipPeriods.periodStart))
          .limit(1);
        if (failed) await chargeMembershipPeriod(failed.id, await requestIp()).catch((e) => console.error("retry after card update failed", e));
      }
    }
    revalidatePath("/account");
  }
  return toConfirmResult(outcome);
}

/* --- joining and buying ---------------------------------------------------- */

const vehicleInput = z.object({
  year: z.number().int().min(1950).max(2100).optional(),
  make: z.string().trim().min(1).max(60),
  model: z.string().trim().min(1).max(60),
  category: z.enum(VEHICLE_CATEGORIES),
  colour: z.string().trim().max(40).optional(),
  licencePlate: z.string().trim().max(12).optional(),
});
const purchaseInput = z.object({
  customerId: z.string().optional(),
  vehicleId: z.string().optional(),
  newVehicle: vehicleInput.optional(),
  person: z.object({ firstName: z.string().trim().max(80), lastName: z.string().trim().max(80) }).optional(),
  termsAccepted: z.boolean(),
});

async function buyer(raw: z.infer<typeof purchaseInput>) {
  const me = await account();
  if (!me) throw new MembershipError("Please sign in again.");
  const customer = await ensureAccountCustomer({
    allowedCustomers: me.customers,
    customerId: raw.customerId,
    contact: { channel: me.session.channel, value: me.session.contact },
    person: raw.person,
  });
  return customer;
}

export async function startJoinAction(raw: unknown): Promise<CheckoutStartResult> {
  const rate = await consumeRateLimit("account-join", { limit: 10, windowMs: 15 * 60_000 });
  if (!rate.allowed) return { ok: false, error: "Too many attempts. Please wait and try again." };
  const parsed = purchaseInput.extend({ planId: z.string().min(1) }).safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Please check your details." };
  try {
    const customer = await buyer(parsed.data);
    return await beginMembershipSignup({
      customer,
      planId: parsed.data.planId,
      vehicleId: parsed.data.vehicleId,
      newVehicle: parsed.data.newVehicle,
      termsAccepted: parsed.data.termsAccepted,
    });
  } catch (error) {
    if (error instanceof MembershipError) return { ok: false, error: error.message };
    console.error("startJoinAction failed", error);
    return { ok: false, error: "Something went wrong. Please try again." };
  }
}

export async function startWinterPassAction(raw: unknown): Promise<CheckoutStartResult> {
  const rate = await consumeRateLimit("account-pass", { limit: 10, windowMs: 15 * 60_000 });
  if (!rate.allowed) return { ok: false, error: "Too many attempts. Please wait and try again." };
  const parsed = purchaseInput.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Please check your details." };
  try {
    const customer = await buyer(parsed.data);
    return await beginWinterPassPurchase({
      customer,
      vehicleId: parsed.data.vehicleId,
      newVehicle: parsed.data.newVehicle,
      termsAccepted: parsed.data.termsAccepted,
    });
  } catch (error) {
    if (error instanceof MembershipError) return { ok: false, error: error.message };
    console.error("startWinterPassAction failed", error);
    return { ok: false, error: "Something went wrong. Please try again." };
  }
}

/* --- managing a membership ------------------------------------------------- */

async function ownMembership(membershipId: unknown) {
  const me = await account();
  if (!me || typeof membershipId !== "string") return null;
  const [membership] = await db()
    .select()
    .from(schema.memberships)
    .where(and(eq(schema.memberships.id, membershipId), inArray(schema.memberships.customerId, me.customerIds.length ? me.customerIds : ["-"])))
    .limit(1);
  return membership ?? null;
}

export async function cancelMembershipAction(membershipId: unknown): Promise<Result> {
  const membership = await ownMembership(membershipId);
  if (!membership) return { ok: false, error: "This membership isn't available." };
  const result = await cancelMembership({ membershipId: membership.id, actor: { type: "customer" } });
  revalidatePath("/account");
  return result.ok ? { ok: true } : result;
}

export async function keepMembershipAction(membershipId: unknown): Promise<Result> {
  const membership = await ownMembership(membershipId);
  if (!membership) return { ok: false, error: "This membership isn't available." };
  const result = await resumeMembership({ membershipId: membership.id, actor: { type: "customer" } });
  revalidatePath("/account");
  return result;
}

export async function upgradeMembershipAction(membershipId: unknown, planId: unknown): Promise<Result> {
  const membership = await ownMembership(membershipId);
  if (!membership || typeof planId !== "string") return { ok: false, error: "This membership isn't available." };
  const result = await upgradeMembership({ membershipId: membership.id, toPlanId: planId, ipAddress: await requestIp(), actor: { type: "customer" } });
  revalidatePath("/account");
  if (!result.ok) return result;
  return {
    ok: true,
    message:
      result.status === "approved"
        ? "Upgraded! Your new benefits are available now."
        : "Your upgrade is being processed — this page will update shortly.",
  };
}

export async function startCardUpdateAction(membershipId: string): Promise<CheckoutStartResult> {
  const membership = await ownMembership(membershipId);
  if (!membership) return { ok: false, error: "This membership isn't available." };
  return beginCardUpdate({ membershipId: membership.id, customerId: membership.customerId });
}

/* --- booking --------------------------------------------------------------- */

const visitInput = z.object({
  vehicleId: z.string().min(1),
  use: z.enum(["member", "pass", "package"]),
  benefits: z.array(z.enum(BENEFIT_KEYS as [string, ...string[]])).max(2).optional(),
  packageServiceId: z.string().optional(),
  addonIds: z.array(z.string()).max(6).optional(),
});

export async function memberSlotsAction(raw: unknown): Promise<
  | { ok: true; totalLabel: string; discountLabel: string | null; slots: { startMs: number; label: string }[] }
  | { ok: false; error: string }
> {
  const me = await account();
  if (!me) return { ok: false, error: "Please sign in again." };
  const parsed = visitInput.extend({ dateISO: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Choose a day." };
  try {
    const result = await memberVisitSlots(parsed.data as MemberVisitRequest, me.customerIds, parsed.data.dateISO);
    const settings = await getSettings();
    return {
      ok: true,
      totalLabel: new Intl.NumberFormat("en-CA", { style: "currency", currency: settings.currency }).format(result.pricing.totalCents / 100),
      discountLabel: result.pricing.discountCents > 0 ? result.pricing.promoLabel : null,
      slots: result.slots,
    };
  } catch (error) {
    if (error instanceof MemberBookingError) return { ok: false, error: error.message };
    console.error("memberSlotsAction failed", error);
    return { ok: false, error: "Could not load times. Please try again." };
  }
}

export async function bookMemberVisitAction(raw: unknown): Promise<Result & { depositRequired?: boolean }> {
  const me = await account();
  if (!me) return { ok: false, error: "Please sign in again." };
  const rate = await consumeRateLimit("account-book", { limit: 10, windowMs: 15 * 60_000 });
  if (!rate.allowed) return { ok: false, error: "Too many attempts. Please wait and try again." };
  const parsed = visitInput
    .extend({
      dateISO: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      startMs: z.number().int().positive(),
      notes: z.string().trim().max(1000).optional(),
    })
    .safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Choose a time." };
  try {
    const created = await bookMemberVisit({
      request: parsed.data as MemberVisitRequest,
      allowedCustomerIds: me.customerIds,
      dateISO: parsed.data.dateISO,
      startMs: parsed.data.startMs,
      notes: parsed.data.notes,
    });
    const settings = await getSettings();
    if (created.status === "deposit_required" && created.depositAccessToken) {
      await sendAppointmentDepositRequest(created.appointmentId, `${getAppBaseUrl()}/portal/deposits/${created.depositAccessToken}`).catch(
        () => undefined,
      );
    } else {
      await sendStaffBookingConfirmation(created.appointmentId, settings).catch(() => []);
    }
    await notifyStaffOfNewAppointment(created.appointmentId).catch(() => undefined);
    revalidatePath("/account");
    return { ok: true, depositRequired: created.status === "deposit_required" };
  } catch (error) {
    if (error instanceof MemberBookingError) return { ok: false, error: error.message };
    console.error("bookMemberVisitAction failed", error);
    return { ok: false, error: "Could not book that time. Please try another." };
  }
}
