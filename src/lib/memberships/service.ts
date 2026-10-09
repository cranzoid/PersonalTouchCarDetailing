import { and, asc, desc, eq, gt, inArray, isNull, lte, ne, sql } from "drizzle-orm";
import { db, schema, type Db } from "@/db";
import { audit } from "@/lib/audit";
import { newId } from "@/lib/id";
import { computeInvoiceTotals, nextInvoiceNumber } from "@/lib/invoices";
import { normalizePhone } from "@/lib/phone";
import { getSettings, type BusinessSettings } from "@/lib/settings";
import { formatInZone } from "@/lib/tz";
import { VEHICLE_CATEGORIES, type VehicleCategory } from "@/lib/types";
import { createHelcimCustomer, HelcimApiError } from "@/lib/helcim/client";
import {
  chargeCardOnFile,
  closeCheckout,
  ensureOnlineSession,
  insertCheckout,
  reconcileCheckout,
} from "@/lib/payments/checkouts";
import { membershipSettings, MEMBERSHIP_BENEFITS, isBenefit, type MembershipBenefit } from "./config";
import { sendMembershipCancelScheduled, sendMembershipEnded, sendMembershipUpgraded } from "./notify";

export class MembershipError extends Error {}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type MembershipRow = typeof schema.memberships.$inferSelect;
export type PlanRow = typeof schema.membershipPlans.$inferSelect;

/** Statuses that hold the car's one membership slot (see memberships_live_vehicle_uq). */
export const LIVE_MEMBERSHIP_STATUSES = ["pending", "active", "past_due"] as const;

/* ------------------------------------------------------------------ */
/* Dates                                                                 */
/* ------------------------------------------------------------------ */

/**
 * The same day next month, clamped to the month's end: a member who joined on
 * January 31 renews on February 28, then March 28 — the clamp sticks rather
 * than drifting back, which is the conventional behaviour members expect from
 * any monthly bill.
 */
export function addMonthsClamped(date: Date, months: number): Date {
  const result = new Date(date.getTime());
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}

function periodLabel(start: Date, end: Date, timeZone: string): string {
  const fmt = (d: Date) => formatInZone(d, timeZone, { month: "short", day: "numeric", year: "numeric" });
  return `${fmt(start)} – ${fmt(new Date(end.getTime() - 1))}`;
}

/* ------------------------------------------------------------------ */
/* Invoices for things the shop sells without a job                     */
/* ------------------------------------------------------------------ */

/**
 * Raises an issued ("sent") invoice for a membership month, an upgrade or a
 * Winter Pass. Tax is added like any other sale; the first payment settles
 * whether it stands (DECISIONS #18) — a card always keeps it.
 */
export async function createSaleInvoice(
  tx: Tx,
  input: {
    customerId: string;
    vehicleId: string | null;
    lines: { description: string; unitPriceCents: number; serviceId?: string | null }[];
    notes?: string | null;
    settings: BusinessSettings;
    staffId?: string | null;
  },
): Promise<typeof schema.invoices.$inferSelect> {
  const number = await nextInvoiceNumber(tx);
  const lines = input.lines.map((line) => ({ ...line, quantity: 1 }));
  const totals = computeInvoiceTotals(lines, 0, input.settings.taxRateBp);
  const now = new Date();
  const id = newId("inv");
  const [invoice] = await tx
    .insert(schema.invoices)
    .values({
      id,
      number,
      customerId: input.customerId,
      vehicleId: input.vehicleId,
      status: "sent",
      subtotalCents: totals.subtotalCents,
      discountCents: 0,
      taxRateBp: input.settings.taxRateBp,
      taxLabel: input.settings.taxLabel,
      taxRegistrationNumber: input.settings.taxRegistrationNumber || null,
      taxCents: totals.taxCents,
      taxTreatment: "added",
      totalCents: totals.totalCents,
      invoiceDate: now,
      sentAt: now,
      dueAt: now,
      createdByStaffId: input.staffId ?? null,
      notes: input.notes ?? null,
    })
    .returning();
  await tx.insert(schema.invoiceLineItems).values(
    lines.map((line, index) => ({
      id: newId("ili"),
      invoiceId: id,
      serviceId: line.serviceId ?? null,
      description: line.description,
      quantity: 1,
      unitPriceCents: line.unitPriceCents,
      sort: index,
    })),
  );
  return invoice;
}

/** Cancels an unpaid sale invoice — a sign-up abandoned, a month never collected. */
async function cancelUnpaidInvoice(tx: Tx, invoiceId: string, reason: string): Promise<void> {
  const [invoice] = await tx.select().from(schema.invoices).where(eq(schema.invoices.id, invoiceId)).for("update");
  if (!invoice || invoice.status === "cancelled" || invoice.status === "paid") return;
  const paid = await tx
    .select({ id: schema.payments.id })
    .from(schema.payments)
    .where(and(eq(schema.payments.invoiceId, invoiceId), eq(schema.payments.status, "succeeded")))
    .limit(1);
  if (paid.length > 0) return;
  await tx
    .update(schema.invoices)
    .set({ status: "cancelled", cancelledAt: new Date(), cancellationReason: reason, updatedAt: new Date() })
    .where(eq(schema.invoices.id, invoiceId));
}

/* ------------------------------------------------------------------ */
/* Plans                                                                 */
/* ------------------------------------------------------------------ */

export async function listPlans(options: { activeOnly?: boolean } = {}): Promise<PlanRow[]> {
  return db()
    .select()
    .from(schema.membershipPlans)
    .where(options.activeOnly ? eq(schema.membershipPlans.active, true) : undefined)
    .orderBy(asc(schema.membershipPlans.sort), asc(schema.membershipPlans.rank));
}

export function planBenefits(plan: Pick<PlanRow, "includedBenefits">): MembershipBenefit[] {
  return plan.includedBenefits.filter(isBenefit);
}

/* ------------------------------------------------------------------ */
/* What a car is entitled to right now                                   */
/* ------------------------------------------------------------------ */

export type MembershipEntitlement = {
  membershipId: string;
  customerId: string;
  planId: string;
  planName: string;
  status: string;
  discountBp: number;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: Date | null;
  /** The paid month covering now, or null when benefits are paused. */
  periodId: string | null;
  included: MembershipBenefit[];
  available: MembershipBenefit[];
};

export type PassEntitlement = {
  passId: string;
  customerId: string;
  washesTotal: number;
  washesUsed: number;
  validFrom: Date;
  validUntil: Date;
  usableNow: boolean;
};

/** Redemptions that still count: not voided, and not on a booking since cancelled. */
async function liveRedemptions(executor: Pick<Db, "select">, periodId: string) {
  const rows = await executor
    .select({ redemption: schema.membershipRedemptions, appointmentStatus: schema.appointments.status })
    .from(schema.membershipRedemptions)
    .leftJoin(schema.appointments, eq(schema.appointments.id, schema.membershipRedemptions.appointmentId))
    .where(and(eq(schema.membershipRedemptions.periodId, periodId), isNull(schema.membershipRedemptions.voidedAt)));
  return rows.filter((row) => row.appointmentStatus !== "cancelled").map((row) => row.redemption);
}

async function livePassWashes(executor: Pick<Db, "select">, passId: string) {
  const rows = await executor
    .select({ redemption: schema.winterPassRedemptions, appointmentStatus: schema.appointments.status })
    .from(schema.winterPassRedemptions)
    .leftJoin(schema.appointments, eq(schema.appointments.id, schema.winterPassRedemptions.appointmentId))
    .where(and(eq(schema.winterPassRedemptions.passId, passId), isNull(schema.winterPassRedemptions.voidedAt)));
  return rows.filter((row) => row.appointmentStatus !== "cancelled").map((row) => row.redemption);
}

/** Pass validity runs from the start of `validFrom` to the end of `validUntil`, business-local. */
export function passUsableAt(pass: { validFrom: Date; validUntil: Date }, at: Date): boolean {
  return at >= pass.validFrom && at <= pass.validUntil;
}

export async function getVehicleEntitlements(
  vehicleId: string,
  at = new Date(),
  executor: Pick<Db, "select"> = db(),
): Promise<{ membership: MembershipEntitlement | null; passes: PassEntitlement[] }> {
  const [row] = await executor
    .select({ membership: schema.memberships, plan: schema.membershipPlans })
    .from(schema.memberships)
    .innerJoin(schema.membershipPlans, eq(schema.membershipPlans.id, schema.memberships.planId))
    .where(and(eq(schema.memberships.vehicleId, vehicleId), inArray(schema.memberships.status, ["active", "past_due"])))
    .limit(1);

  let membership: MembershipEntitlement | null = null;
  if (row) {
    const included = planBenefits(row.plan);
    const [period] =
      row.membership.status === "active"
        ? await executor
            .select()
            .from(schema.membershipPeriods)
            .where(
              and(
                eq(schema.membershipPeriods.membershipId, row.membership.id),
                inArray(schema.membershipPeriods.status, ["paid", "waived"]),
                lte(schema.membershipPeriods.periodStart, at),
                gt(schema.membershipPeriods.periodEnd, at),
              ),
            )
            .orderBy(desc(schema.membershipPeriods.periodStart))
            .limit(1)
        : [];
    const used = period ? new Set((await liveRedemptions(executor, period.id)).map((r) => r.benefit)) : new Set<string>();
    membership = {
      membershipId: row.membership.id,
      customerId: row.membership.customerId,
      planId: row.plan.id,
      planName: row.plan.name,
      status: row.membership.status,
      discountBp: period ? row.plan.discountBp : 0,
      cancelAtPeriodEnd: row.membership.cancelAtPeriodEnd,
      currentPeriodEnd: row.membership.currentPeriodEnd,
      periodId: period?.id ?? null,
      included,
      available: period ? included.filter((benefit) => !used.has(benefit)) : [],
    };
  }

  const passRows = await executor
    .select()
    .from(schema.winterPasses)
    .where(and(eq(schema.winterPasses.vehicleId, vehicleId), eq(schema.winterPasses.status, "active")))
    .orderBy(asc(schema.winterPasses.validUntil));
  const passes: PassEntitlement[] = [];
  for (const pass of passRows) {
    const washesUsed = (await livePassWashes(executor, pass.id)).length;
    if (washesUsed >= pass.washesTotal || at > pass.validUntil) continue;
    passes.push({
      passId: pass.id,
      customerId: pass.customerId,
      washesTotal: pass.washesTotal,
      washesUsed,
      validFrom: pass.validFrom,
      validUntil: pass.validUntil,
      usableNow: passUsableAt(pass, at),
    });
  }
  return { membership, passes };
}

/* ------------------------------------------------------------------ */
/* Redeeming                                                             */
/* ------------------------------------------------------------------ */

/**
 * Uses this month's benefit. The unique index on (period, benefit) is the
 * guarantee; this function only turns the database's refusal into a sentence.
 */
export async function reserveMembershipBenefit(
  tx: Pick<Db, "select" | "insert" | "update">,
  input: {
    membershipId: string;
    benefit: MembershipBenefit;
    appointmentId?: string | null;
    invoiceId?: string | null;
    staffId?: string | null;
    at?: Date;
  },
): Promise<string> {
  const at = input.at ?? new Date();
  const [membership] = await tx
    .select()
    .from(schema.memberships)
    .where(eq(schema.memberships.id, input.membershipId))
    .for("update");
  if (!membership || membership.status !== "active") throw new MembershipError("This membership isn't active right now.");
  const [plan] = await tx.select().from(schema.membershipPlans).where(eq(schema.membershipPlans.id, membership.planId));
  if (!plan || !planBenefits(plan).includes(input.benefit)) {
    throw new MembershipError(`${MEMBERSHIP_BENEFITS[input.benefit].label} isn't included in this plan.`);
  }
  const [period] = await tx
    .select()
    .from(schema.membershipPeriods)
    .where(
      and(
        eq(schema.membershipPeriods.membershipId, membership.id),
        inArray(schema.membershipPeriods.status, ["paid", "waived"]),
        lte(schema.membershipPeriods.periodStart, at),
        gt(schema.membershipPeriods.periodEnd, at),
      ),
    )
    .limit(1);
  if (!period) throw new MembershipError("This month isn't paid yet, so member benefits are paused.");

  // A redemption sitting on a booking that has since been cancelled frees the
  // month's benefit: void it so the unique index lets the new one in.
  const stale = await tx
    .select({ id: schema.membershipRedemptions.id })
    .from(schema.membershipRedemptions)
    .innerJoin(schema.appointments, eq(schema.appointments.id, schema.membershipRedemptions.appointmentId))
    .where(
      and(
        eq(schema.membershipRedemptions.periodId, period.id),
        eq(schema.membershipRedemptions.benefit, input.benefit),
        isNull(schema.membershipRedemptions.voidedAt),
        eq(schema.appointments.status, "cancelled"),
      ),
    );
  for (const s of stale) {
    await tx
      .update(schema.membershipRedemptions)
      .set({ voidedAt: at, voidReason: "Booking cancelled" })
      .where(eq(schema.membershipRedemptions.id, s.id));
  }

  const id = newId("mrd");
  const inserted = await tx
    .insert(schema.membershipRedemptions)
    .values({
      id,
      membershipId: membership.id,
      periodId: period.id,
      benefit: input.benefit,
      appointmentId: input.appointmentId ?? null,
      invoiceId: input.invoiceId ?? null,
      redeemedAt: at,
      redeemedByStaffId: input.staffId ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: schema.membershipRedemptions.id });
  if (inserted.length === 0) {
    throw new MembershipError(`This month's ${MEMBERSHIP_BENEFITS[input.benefit].label.toLowerCase()} has already been used.`);
  }
  await audit(tx, {
    actorType: input.staffId ? "staff" : "customer",
    actorId: input.staffId ?? null,
    action: "membership.benefit_redeemed",
    entityType: "membership",
    entityId: membership.id,
    after: { benefit: input.benefit, periodId: period.id, appointmentId: input.appointmentId ?? null, invoiceId: input.invoiceId ?? null },
  });
  return id;
}

/** Takes the next wash from a Winter Pass. */
export async function reservePassWash(
  tx: Pick<Db, "select" | "insert" | "update">,
  input: { passId: string; appointmentId?: string | null; invoiceId?: string | null; staffId?: string | null; at: Date },
): Promise<{ redemptionId: string; washNumber: number }> {
  const [pass] = await tx.select().from(schema.winterPasses).where(eq(schema.winterPasses.id, input.passId)).for("update");
  if (!pass || pass.status !== "active") throw new MembershipError("This Winter Pass isn't active.");
  if (!passUsableAt(pass, input.at)) {
    throw new MembershipError("Winter Pass washes can only be used between November and March.");
  }
  const used = await livePassWashes(tx, pass.id);
  if (used.length >= pass.washesTotal) throw new MembershipError("All the washes on this Winter Pass have been used.");
  const taken = new Set(used.map((r) => r.washNumber));
  let washNumber = 1;
  while (taken.has(washNumber)) washNumber++;
  // Free a number held by a cancelled booking, as reserveMembershipBenefit does.
  await tx
    .update(schema.winterPassRedemptions)
    .set({ voidedAt: input.at, voidReason: "Booking cancelled" })
    .where(
      and(
        eq(schema.winterPassRedemptions.passId, pass.id),
        eq(schema.winterPassRedemptions.washNumber, washNumber),
        isNull(schema.winterPassRedemptions.voidedAt),
      ),
    );
  const id = newId("wpr");
  await tx.insert(schema.winterPassRedemptions).values({
    id,
    passId: pass.id,
    washNumber,
    appointmentId: input.appointmentId ?? null,
    invoiceId: input.invoiceId ?? null,
    redeemedAt: input.at,
    redeemedByStaffId: input.staffId ?? null,
  });
  await audit(tx, {
    actorType: input.staffId ? "staff" : "customer",
    actorId: input.staffId ?? null,
    action: "winter_pass.wash_redeemed",
    entityType: "winter_pass",
    entityId: pass.id,
    after: { washNumber, appointmentId: input.appointmentId ?? null, invoiceId: input.invoiceId ?? null },
  });
  return { redemptionId: id, washNumber };
}

/** Frees benefits held by a booking that was cancelled. */
export async function voidEntitlementsForAppointment(tx: Pick<Db, "update">, appointmentId: string, reason: string): Promise<void> {
  const now = new Date();
  await tx
    .update(schema.membershipRedemptions)
    .set({ voidedAt: now, voidReason: reason })
    .where(and(eq(schema.membershipRedemptions.appointmentId, appointmentId), isNull(schema.membershipRedemptions.voidedAt)));
  await tx
    .update(schema.winterPassRedemptions)
    .set({ voidedAt: now, voidReason: reason })
    .where(and(eq(schema.winterPassRedemptions.appointmentId, appointmentId), isNull(schema.winterPassRedemptions.voidedAt)));
}

/* ------------------------------------------------------------------ */
/* Customer and vehicle for a sign-up                                    */
/* ------------------------------------------------------------------ */

export type NewVehicleInput = {
  year?: number;
  make: string;
  model: string;
  category: VehicleCategory;
  colour?: string;
  licencePlate?: string;
};

/**
 * Resolves (or creates) the customer record a signed-in visitor is buying
 * under. Only records carrying their proved contact are eligible; a visitor
 * with none gets a new record holding exactly that contact.
 */
export async function ensureAccountCustomer(input: {
  allowedCustomers: (typeof schema.customers.$inferSelect)[];
  customerId?: string;
  contact: { channel: "email" | "sms"; value: string };
  person?: { firstName: string; lastName: string };
}): Promise<typeof schema.customers.$inferSelect> {
  if (input.customerId) {
    const chosen = input.allowedCustomers.find((c) => c.id === input.customerId);
    if (!chosen) throw new MembershipError("That account record isn't available.");
    return chosen;
  }
  if (input.allowedCustomers[0]) return input.allowedCustomers[0];
  const firstName = input.person?.firstName.trim() ?? "";
  if (!firstName) throw new MembershipError("Please tell us your name.");
  const id = newId("cus");
  const [created] = await db()
    .insert(schema.customers)
    .values({
      id,
      firstName: firstName.slice(0, 80),
      lastName: (input.person?.lastName ?? "").trim().slice(0, 80),
      email: input.contact.channel === "email" ? input.contact.value : null,
      phone: input.contact.channel === "sms" ? input.contact.value : null,
      phoneNormalized: input.contact.channel === "sms" ? normalizePhone(input.contact.value) : null,
      preferredContact: input.contact.channel === "email" ? "email" : "sms",
    })
    .returning();
  return created;
}

async function resolveVehicle(
  tx: Tx,
  customerId: string,
  input: { vehicleId?: string; newVehicle?: NewVehicleInput },
): Promise<typeof schema.vehicles.$inferSelect> {
  if (input.vehicleId) {
    const [vehicle] = await tx.select().from(schema.vehicles).where(eq(schema.vehicles.id, input.vehicleId)).for("update");
    if (!vehicle || vehicle.customerId !== customerId) throw new MembershipError("Choose one of your vehicles.");
    return vehicle;
  }
  const v = input.newVehicle;
  if (!v || !v.make.trim() || !v.model.trim() || !VEHICLE_CATEGORIES.includes(v.category)) {
    throw new MembershipError("Tell us about your vehicle: make, model and type.");
  }
  const [vehicle] = await tx
    .insert(schema.vehicles)
    .values({
      id: newId("veh"),
      customerId,
      year: v.year ?? null,
      make: v.make.trim().slice(0, 60),
      model: v.model.trim().slice(0, 60),
      category: v.category,
      colour: v.colour?.trim().slice(0, 40) || null,
      licencePlate: v.licencePlate?.trim().toUpperCase().slice(0, 12) || null,
    })
    .returning();
  return vehicle;
}

/** Our customer's record in Helcim's vault, created on first need. */
export async function ensureHelcimCustomerCode(customer: typeof schema.customers.$inferSelect): Promise<string> {
  if (customer.helcimCustomerCode) return customer.helcimCustomerCode;
  const code = `PTC-${customer.id.replace(/^cus_/, "").toUpperCase()}`;
  try {
    await createHelcimCustomer({
      customerCode: code,
      contactName: `${customer.firstName} ${customer.lastName}`.trim() || "Customer",
      businessName: customer.companyName ?? undefined,
      cellPhone: normalizePhone(customer.phone) ?? undefined,
    });
  } catch (error) {
    // Created on an earlier attempt whose answer was lost: the code is ours
    // either way, because it is derived from our own customer id.
    if (!(error instanceof HelcimApiError) || !/exist|duplicate|taken/i.test(error.message)) throw error;
  }
  await db()
    .update(schema.customers)
    .set({ helcimCustomerCode: code, updatedAt: new Date() })
    .where(and(eq(schema.customers.id, customer.id), isNull(schema.customers.helcimCustomerCode)));
  return code;
}

/* ------------------------------------------------------------------ */
/* Sign-up                                                               */
/* ------------------------------------------------------------------ */

export type BeginCheckoutResult =
  | { ok: true; checkoutId: string; checkoutToken: string; amountCents: number }
  | { ok: false; error: string };

/**
 * Starts a membership: a pending membership, its first month, that month's
 * invoice and a HelcimPay.js checkout that takes the first payment AND saves
 * the card as the customer's default in Helcim's vault. Nothing becomes active
 * until Helcim confirms the payment (see settlePaidInvoice).
 */
export async function beginMembershipSignup(input: {
  customer: typeof schema.customers.$inferSelect;
  planId: string;
  vehicleId?: string;
  newVehicle?: NewVehicleInput;
  termsAccepted: boolean;
}): Promise<BeginCheckoutResult> {
  const settings = await getSettings();
  const config = membershipSettings(settings);
  if (!config.salesOpen) return { ok: false, error: "Memberships aren't on sale online yet. Call us to join." };
  if (!input.termsAccepted) return { ok: false, error: "Please accept the membership terms and the monthly charge to continue." };
  const [plan] = await db().select().from(schema.membershipPlans).where(eq(schema.membershipPlans.id, input.planId)).limit(1);
  if (!plan || !plan.active) return { ok: false, error: "That plan isn't available." };

  let helcimCustomerCode: string;
  try {
    helcimCustomerCode = await ensureHelcimCustomerCode(input.customer);
  } catch (error) {
    console.error("beginMembershipSignup could not create the Helcim customer", error);
    return { ok: false, error: "Online sign-up is temporarily unavailable. Please try again shortly." };
  }

  const now = new Date();
  let claim: { checkout: typeof schema.paymentCheckouts.$inferSelect; invoiceNumber: number; description: string };
  try {
    claim = await db().transaction(async (tx) => {
      const vehicle = await resolveVehicle(tx, input.customer.id, input);
      const live = await tx
        .select()
        .from(schema.memberships)
        .where(and(eq(schema.memberships.vehicleId, vehicle.id), inArray(schema.memberships.status, [...LIVE_MEMBERSHIP_STATUSES])))
        .for("update");
      for (const existing of live) {
        if (existing.status !== "pending") {
          throw new MembershipError("This vehicle already has a membership. Manage it from your account.");
        }
        // An earlier sign-up that never got paid: replace it.
        await abandonPendingMembership(tx, existing.id, "Replaced by a new sign-up");
      }

      const membershipId = newId("mem");
      await tx.insert(schema.memberships).values({
        id: membershipId,
        customerId: input.customer.id,
        vehicleId: vehicle.id,
        planId: plan.id,
        status: "pending",
        priceCents: plan.monthlyPriceCents,
        helcimCustomerCode,
        termsVersion: config.termsVersion,
        authorizedAt: now,
      });
      const periodEnd = addMonthsClamped(now, 1);
      const description = `${plan.name} — ${periodLabel(now, periodEnd, settings.timezone)}`;
      const invoice = await createSaleInvoice(tx, {
        customerId: input.customer.id,
        vehicleId: vehicle.id,
        lines: [{ description, unitPriceCents: plan.monthlyPriceCents }],
        notes: "Monthly membership. Renews automatically each month until cancelled.",
        settings,
      });
      const periodId = newId("mpd");
      await tx.insert(schema.membershipPeriods).values({
        id: periodId,
        membershipId,
        planId: plan.id,
        periodStart: now,
        periodEnd,
        amountCents: plan.monthlyPriceCents,
        invoiceId: invoice.id,
      });
      const checkout = await insertCheckout(tx, {
        kind: "membership_signup",
        channel: "online",
        customerId: input.customer.id,
        amountCents: invoice.totalCents,
        currency: settings.currency,
        subject: { membershipId, periodId, allocations: [{ invoiceId: invoice.id, amountCents: invoice.totalCents }] },
        payments: [{ customerId: input.customer.id, invoiceId: invoice.id, kind: "payment", amountCents: invoice.totalCents }],
        helcimCustomerCode,
      });
      await audit(tx, {
        actorType: "customer",
        action: "membership.signup_started",
        entityType: "membership",
        entityId: membershipId,
        after: { planId: plan.id, vehicleId: vehicle.id, invoiceId: invoice.id, termsVersion: config.termsVersion },
      });
      return { checkout, invoiceNumber: invoice.number, description };
    });
  } catch (error) {
    if (error instanceof MembershipError) return { ok: false, error: error.message };
    throw error;
  }

  try {
    const { checkoutToken } = await ensureOnlineSession(claim.checkout, {
      lineItems: [{ description: `${claim.description} (incl. tax)`, quantity: 1, unitPriceCents: claim.checkout.amountCents }],
      saveCard: true,
    });
    return { ok: true, checkoutId: claim.checkout.id, checkoutToken, amountCents: claim.checkout.amountCents };
  } catch (error) {
    console.error("beginMembershipSignup could not open a Helcim session", error);
    return { ok: false, error: "Online sign-up is temporarily unavailable. Please try again shortly." };
  }
}

/** Retires an unpaid sign-up: membership canceled, invoice cancelled, checkout closed. */
async function abandonPendingMembership(tx: Tx, membershipId: string, reason: string): Promise<void> {
  const [membership] = await tx.select().from(schema.memberships).where(eq(schema.memberships.id, membershipId)).for("update");
  if (!membership || membership.status !== "pending") return;
  const periods = await tx.select().from(schema.membershipPeriods).where(eq(schema.membershipPeriods.membershipId, membershipId));
  for (const period of periods) {
    if (!period.invoiceId) continue;
    const pending = await tx
      .selectDistinct({ checkoutId: schema.payments.checkoutId })
      .from(schema.payments)
      .where(and(eq(schema.payments.invoiceId, period.invoiceId), eq(schema.payments.status, "pending")));
    for (const { checkoutId } of pending) if (checkoutId) await closeCheckout(tx, checkoutId, "expired", reason);
    await cancelUnpaidInvoice(tx, period.invoiceId, reason);
    await tx
      .update(schema.membershipPeriods)
      .set({ status: "failed", lastError: reason, updatedAt: new Date() })
      .where(eq(schema.membershipPeriods.id, period.id));
  }
  await tx
    .update(schema.memberships)
    .set({ status: "canceled", canceledAt: new Date(), cancelReason: reason, updatedAt: new Date() })
    .where(eq(schema.memberships.id, membershipId));
}

/* ------------------------------------------------------------------ */
/* Changes members make                                                  */
/* ------------------------------------------------------------------ */

/**
 * Cancels at the end of the paid month — no refund, benefits until then. A
 * membership whose current month was never paid has nothing left to run out,
 * so it ends now.
 */
export async function cancelMembership(input: {
  membershipId: string;
  actor: { type: "customer" } | { type: "system" } | { type: "staff"; id: string };
  immediately?: boolean;
  reason?: string;
  /** Skip the member notice — the caller sends its own, or there is no member to tell. */
  silent?: boolean;
}): Promise<{ ok: true; endsAt: Date | null } | { ok: false; error: string }> {
  const outcome = await db().transaction(async (tx) => {
    const [membership] = await tx
      .select()
      .from(schema.memberships)
      .where(eq(schema.memberships.id, input.membershipId))
      .for("update");
    if (!membership || membership.status === "canceled") return { ok: false as const, error: "This membership has already ended." };
    const now = new Date();
    const reason =
      input.reason?.trim() ||
      (input.actor.type === "customer" ? "Cancelled by the member" : input.actor.type === "staff" ? "Cancelled by staff" : "Ended");
    if (membership.status === "pending") {
      await abandonPendingMembership(tx, membership.id, reason);
      return { ok: true as const, endsAt: now, ended: true };
    }
    const endNow = input.immediately === true || membership.status === "past_due";
    if (endNow) {
      if (input.immediately && input.actor.type !== "staff") return { ok: false as const, error: "Not allowed" };
      // An uncollected month is not owed for a membership that is ending.
      const unpaid = await tx
        .select()
        .from(schema.membershipPeriods)
        .where(and(eq(schema.membershipPeriods.membershipId, membership.id), inArray(schema.membershipPeriods.status, ["due", "failed"])));
      for (const period of unpaid) {
        if (period.invoiceId) await cancelUnpaidInvoice(tx, period.invoiceId, reason);
      }
      await tx
        .update(schema.memberships)
        .set({
          status: "canceled",
          canceledAt: now,
          cancelRequestedAt: membership.cancelRequestedAt ?? now,
          cancelReason: reason,
          nextAttemptAt: null,
          updatedAt: now,
        })
        .where(eq(schema.memberships.id, membership.id));
    } else {
      await tx
        .update(schema.memberships)
        .set({ cancelAtPeriodEnd: true, cancelRequestedAt: now, cancelReason: reason, updatedAt: now })
        .where(eq(schema.memberships.id, membership.id));
    }
    await audit(tx, {
      actorType: input.actor.type,
      actorId: input.actor.type === "staff" ? input.actor.id : null,
      action: endNow ? "membership.canceled" : "membership.cancel_scheduled",
      entityType: "membership",
      entityId: membership.id,
      before: { status: membership.status },
      after: { endsAt: endNow ? now.toISOString() : membership.currentPeriodEnd?.toISOString() ?? null },
      reason,
    });
    return { ok: true as const, endsAt: endNow ? now : membership.currentPeriodEnd, ended: endNow };
  });
  if (!outcome.ok) return outcome;
  if (input.silent) return { ok: true, endsAt: outcome.endsAt };
  try {
    if (outcome.ended) await sendMembershipEnded(input.membershipId, "canceled");
    else await sendMembershipCancelScheduled(input.membershipId);
  } catch (error) {
    console.error("cancelMembership notice failed", error);
  }
  return { ok: true, endsAt: outcome.endsAt };
}

/** Undoes a scheduled cancellation while the paid month is still running. */
export async function resumeMembership(input: {
  membershipId: string;
  actor: { type: "customer" } | { type: "staff"; id: string };
}): Promise<{ ok: true } | { ok: false; error: string }> {
  return db().transaction(async (tx) => {
    const [membership] = await tx
      .select()
      .from(schema.memberships)
      .where(eq(schema.memberships.id, input.membershipId))
      .for("update");
    if (!membership || membership.status !== "active" || !membership.cancelAtPeriodEnd) {
      return { ok: false as const, error: "There's no cancellation to undo." };
    }
    await tx
      .update(schema.memberships)
      .set({ cancelAtPeriodEnd: false, cancelRequestedAt: null, cancelReason: null, updatedAt: new Date() })
      .where(eq(schema.memberships.id, membership.id));
    await audit(tx, {
      actorType: input.actor.type,
      actorId: input.actor.type === "staff" ? input.actor.id : null,
      action: "membership.cancel_withdrawn",
      entityType: "membership",
      entityId: membership.id,
    });
    return { ok: true as const };
  });
}

/**
 * Moves a member up a plan now: the monthly difference is charged to the card
 * on file today (owner's rule — no proration), the new plan's benefits apply
 * this month, and the new price from the next billing date. The plan switch
 * itself happens when the charge settles (finalizeCheckout), so a charge that
 * is only confirmed later by reconciliation still upgrades the member.
 */
export async function upgradeMembership(input: {
  membershipId: string;
  toPlanId: string;
  ipAddress: string;
  actor: { type: "customer" } | { type: "staff"; id: string };
}): Promise<{ ok: true; status: "approved" | "pending" } | { ok: false; error: string }> {
  const settings = await getSettings();
  const prepared = await db().transaction(async (tx) => {
    const [membership] = await tx
      .select()
      .from(schema.memberships)
      .where(eq(schema.memberships.id, input.membershipId))
      .for("update");
    if (!membership || membership.status !== "active") {
      return { ok: false as const, error: "Only an active membership can be upgraded." };
    }
    if (!membership.cardToken || !membership.helcimCustomerCode) {
      return { ok: false as const, error: "There's no card on file. Update your card first." };
    }
    const [current] = await tx.select().from(schema.membershipPlans).where(eq(schema.membershipPlans.id, membership.planId));
    const [target] = await tx.select().from(schema.membershipPlans).where(eq(schema.membershipPlans.id, input.toPlanId));
    if (!current || !target || !target.active) return { ok: false as const, error: "That plan isn't available." };
    if (target.rank <= current.rank) return { ok: false as const, error: `${target.name} isn't an upgrade from ${current.name}.` };
    const difference = target.monthlyPriceCents - membership.priceCents;
    if (difference <= 0) return { ok: false as const, error: "There's nothing to charge for that change." };
    const openUpgrade = await tx
      .select({ id: schema.paymentCheckouts.id })
      .from(schema.paymentCheckouts)
      .where(
        and(
          eq(schema.paymentCheckouts.kind, "membership_upgrade"),
          eq(schema.paymentCheckouts.status, "open"),
          sql`${schema.paymentCheckouts.subject}->>'membershipId' = ${membership.id}`,
        ),
      )
      .limit(1);
    if (openUpgrade.length > 0) return { ok: false as const, error: "An upgrade is already being processed." };
    const invoice = await createSaleInvoice(tx, {
      customerId: membership.customerId,
      vehicleId: membership.vehicleId,
      lines: [{ description: `Upgrade to ${target.name} — difference for the current month`, unitPriceCents: difference }],
      settings,
      staffId: input.actor.type === "staff" ? input.actor.id : null,
    });
    return {
      ok: true as const,
      membership,
      target,
      invoice,
      difference,
    };
  });
  if (!prepared.ok) return prepared;

  const charge = await chargeCardOnFile({
    kind: "membership_upgrade",
    customerId: prepared.membership.customerId,
    invoiceId: prepared.invoice.id,
    amountCents: prepared.invoice.totalCents,
    cardToken: prepared.membership.cardToken!,
    helcimCustomerCode: prepared.membership.helcimCustomerCode!,
    description: `Upgrade to ${prepared.target.name}`,
    subject: { membershipId: prepared.membership.id, toPlanId: prepared.target.id },
    ipAddress: input.ipAddress,
    createdByStaffId: input.actor.type === "staff" ? input.actor.id : null,
  });
  if (charge.status === "declined") {
    await db().transaction((tx) => cancelUnpaidInvoice(tx, prepared.invoice.id, "Upgrade charge declined"));
    return { ok: false, error: `Your card was declined (${charge.message ?? "no reason given"}). Update your card and try again.` };
  }
  if (charge.status === "approved") {
    try {
      await sendMembershipUpgraded(prepared.membership.id, prepared.difference);
    } catch (error) {
      console.error("upgrade notice failed", error);
    }
  }
  return { ok: true, status: charge.status };
}

/** A HelcimPay.js "verify" session that replaces the card on file. */
export async function beginCardUpdate(input: { membershipId: string; customerId: string }): Promise<BeginCheckoutResult> {
  const [membership] = await db().select().from(schema.memberships).where(eq(schema.memberships.id, input.membershipId)).limit(1);
  if (!membership || membership.customerId !== input.customerId || membership.status === "canceled") {
    return { ok: false, error: "This membership isn't available." };
  }
  const [customer] = await db().select().from(schema.customers).where(eq(schema.customers.id, membership.customerId)).limit(1);
  if (!customer) return { ok: false, error: "This membership isn't available." };
  let code: string;
  try {
    code = membership.helcimCustomerCode ?? (await ensureHelcimCustomerCode(customer));
  } catch {
    return { ok: false, error: "Card updates are temporarily unavailable. Please try again shortly." };
  }
  const checkout = await db().transaction((tx) =>
    insertCheckout(tx, {
      kind: "card_update",
      channel: "online",
      customerId: membership.customerId,
      amountCents: 0,
      currency: "CAD",
      subject: { membershipId: membership.id },
      payments: [],
      helcimCustomerCode: code,
    }),
  );
  try {
    const { checkoutToken } = await ensureOnlineSession(checkout, {
      paymentType: "verify",
      lineItems: [],
      saveCard: true,
    });
    return { ok: true, checkoutId: checkout.id, checkoutToken, amountCents: 0 };
  } catch (error) {
    console.error("beginCardUpdate could not open a Helcim session", error);
    return { ok: false, error: "Card updates are temporarily unavailable. Please try again shortly." };
  }
}

/* ------------------------------------------------------------------ */
/* Monthly billing                                                       */
/* ------------------------------------------------------------------ */

type ChargeOutcome = "approved" | "declined" | "pending" | "skipped";

/**
 * Charges one month that is due (or due again). Before ever sending a charge,
 * any earlier attempt still open for the same invoice is settled with Helcim —
 * the guard that stops a lost answer becoming a double charge.
 */
export async function chargeMembershipPeriod(periodId: string, ipAddress = "127.0.0.1"): Promise<ChargeOutcome> {
  const [period] = await db().select().from(schema.membershipPeriods).where(eq(schema.membershipPeriods.id, periodId)).limit(1);
  if (!period?.invoiceId || period.status === "paid" || period.status === "waived") return "skipped";
  const open = await db()
    .selectDistinct({ checkoutId: schema.payments.checkoutId })
    .from(schema.payments)
    .where(and(eq(schema.payments.invoiceId, period.invoiceId), eq(schema.payments.status, "pending")));
  for (const { checkoutId } of open) {
    if (!checkoutId) continue;
    const outcome = await reconcileCheckout(checkoutId);
    if (outcome.status === "succeeded") return "approved";
    if (outcome.status === "pending") return "pending";
  }

  const [membership] = await db().select().from(schema.memberships).where(eq(schema.memberships.id, period.membershipId)).limit(1);
  const [invoice] = await db().select().from(schema.invoices).where(eq(schema.invoices.id, period.invoiceId)).limit(1);
  if (!membership || !invoice || invoice.status === "paid" || invoice.status === "cancelled") return "skipped";
  if (!membership.cardToken || !membership.helcimCustomerCode) return "declined";
  const [plan] = await db().select().from(schema.membershipPlans).where(eq(schema.membershipPlans.id, period.planId)).limit(1);

  await db()
    .update(schema.membershipPeriods)
    .set({ attempts: period.attempts + 1, lastAttemptAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.membershipPeriods.id, period.id));
  const charge = await chargeCardOnFile({
    kind: "membership_charge",
    customerId: membership.customerId,
    invoiceId: invoice.id,
    amountCents: invoice.totalCents,
    cardToken: membership.cardToken,
    helcimCustomerCode: membership.helcimCustomerCode,
    description: `${plan?.name ?? "Membership"} — monthly`,
    subject: { membershipId: membership.id, periodId: period.id },
    ipAddress,
  });
  if (charge.status === "declined") {
    await db()
      .update(schema.membershipPeriods)
      .set({ status: "failed", lastError: charge.message ?? "Declined", updatedAt: new Date() })
      .where(eq(schema.membershipPeriods.id, period.id));
  }
  return charge.status;
}

/* ------------------------------------------------------------------ */
/* Staff tools                                                           */
/* ------------------------------------------------------------------ */

/**
 * Gives a member a month on the house. On a past-due membership it forgives
 * the failed month (its invoice is cancelled) and restores benefits; on an
 * active one it adds a free month after the paid one, pushing the next charge
 * back. Recorded as a `waived` period so the history shows what happened.
 */
export async function giftMembershipMonth(input: { membershipId: string; staffId: string }): Promise<{ ok: true } | { ok: false; error: string }> {
  return db().transaction(async (tx) => {
    const [membership] = await tx.select().from(schema.memberships).where(eq(schema.memberships.id, input.membershipId)).for("update");
    if (!membership || (membership.status !== "active" && membership.status !== "past_due")) {
      return { ok: false as const, error: "Only an active or past-due membership can be given a month." };
    }
    const now = new Date();
    if (membership.status === "past_due") {
      const [failed] = await tx
        .select()
        .from(schema.membershipPeriods)
        .where(and(eq(schema.membershipPeriods.membershipId, membership.id), eq(schema.membershipPeriods.status, "failed")))
        .orderBy(desc(schema.membershipPeriods.periodStart))
        .limit(1);
      if (!failed) return { ok: false as const, error: "There's no unpaid month to forgive." };
      if (failed.invoiceId) await cancelUnpaidInvoice(tx, failed.invoiceId, "Month given free by staff");
      await tx.update(schema.membershipPeriods).set({ status: "waived", updatedAt: now }).where(eq(schema.membershipPeriods.id, failed.id));
      await tx
        .update(schema.memberships)
        .set({
          status: "active",
          currentPeriodStart: failed.periodStart,
          currentPeriodEnd: failed.periodEnd,
          failedAttempts: 0,
          nextAttemptAt: null,
          pastDueSince: null,
          updatedAt: now,
        })
        .where(eq(schema.memberships.id, membership.id));
    } else {
      const start = membership.currentPeriodEnd ?? now;
      const end = addMonthsClamped(start, 1);
      await tx.insert(schema.membershipPeriods).values({
        id: newId("mpd"),
        membershipId: membership.id,
        planId: membership.planId,
        periodStart: start,
        periodEnd: end,
        amountCents: 0,
        status: "waived",
      });
      await tx
        .update(schema.memberships)
        .set({ currentPeriodEnd: end, updatedAt: now })
        .where(eq(schema.memberships.id, membership.id));
    }
    await audit(tx, {
      actorType: "staff",
      actorId: input.staffId,
      action: "membership.month_gifted",
      entityType: "membership",
      entityId: membership.id,
      before: { status: membership.status, currentPeriodEnd: membership.currentPeriodEnd?.toISOString() ?? null },
    });
    return { ok: true as const };
  });
}

/**
 * Schedules a move to another plan from a date — or clears one. Members are
 * told `planChangeNoticeDays` before by the billing run, and moved at their
 * first billing date on or after `from`.
 */
export async function scheduleMembershipPlanChange(input: {
  membershipIds: string[];
  toPlanId: string | null;
  from: Date | null;
  staffId: string;
}): Promise<{ ok: true; updated: number } | { ok: false; error: string }> {
  if (input.toPlanId) {
    const [plan] = await db().select().from(schema.membershipPlans).where(eq(schema.membershipPlans.id, input.toPlanId)).limit(1);
    if (!plan) return { ok: false, error: "That plan doesn't exist." };
    if (!input.from) return { ok: false, error: "Choose the date the change starts." };
  }
  if (input.membershipIds.length === 0) return { ok: true, updated: 0 };
  return db().transaction(async (tx) => {
    const updated = await tx
      .update(schema.memberships)
      .set({
        nextPlanId: input.toPlanId,
        nextPlanFrom: input.toPlanId ? input.from : null,
        nextPlanNoticeSentAt: null,
        updatedAt: new Date(),
      })
      .where(and(inArray(schema.memberships.id, input.membershipIds), inArray(schema.memberships.status, ["active", "past_due"])))
      .returning({ id: schema.memberships.id });
    for (const row of updated) {
      await audit(tx, {
        actorType: "staff",
        actorId: input.staffId,
        action: input.toPlanId ? "membership.plan_change_scheduled" : "membership.plan_change_cleared",
        entityType: "membership",
        entityId: row.id,
        after: { toPlanId: input.toPlanId, from: input.from?.toISOString() ?? null },
      });
    }
    return { ok: true as const, updated: updated.length };
  });
}

/** Voids a Winter Pass (sold in error, refunded). Washes already taken stay recorded. */
export async function voidWinterPass(input: { passId: string; staffId: string; reason: string }): Promise<{ ok: true } | { ok: false; error: string }> {
  return db().transaction(async (tx) => {
    const [pass] = await tx.select().from(schema.winterPasses).where(eq(schema.winterPasses.id, input.passId)).for("update");
    if (!pass || pass.status === "void") return { ok: false as const, error: "This pass is already void." };
    const now = new Date();
    await tx
      .update(schema.winterPasses)
      .set({ status: "void", voidedAt: now, voidReason: input.reason, updatedAt: now })
      .where(eq(schema.winterPasses.id, pass.id));
    if (pass.status === "pending_payment" && pass.saleInvoiceId) await cancelUnpaidInvoice(tx, pass.saleInvoiceId, input.reason);
    await audit(tx, {
      actorType: "staff",
      actorId: input.staffId,
      action: "winter_pass.voided",
      entityType: "winter_pass",
      entityId: pass.id,
      reason: input.reason,
    });
    return { ok: true as const };
  });
}
