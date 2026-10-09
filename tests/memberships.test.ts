import { createHash } from "crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";

const helcim = vi.hoisted(() => {
  const transactions = new Map<string, Record<string, unknown>>();
  let nextId = 500000;
  return {
    transactions,
    add(fields: Record<string, unknown>) {
      const id = String(++nextId);
      const tx = { transactionId: id, status: "APPROVED", type: "purchase", currency: "CAD", cardNumber: "5413330089", cardType: "MC", ...fields };
      transactions.set(id, tx);
      return tx;
    },
    /** What the next saved-card charge does: approve it, or decline it. */
    nextCharge: "approve" as "approve" | "decline",
    initialize: vi.fn(),
    purchase: vi.fn(),
    createCustomer: vi.fn(),
  };
});

vi.mock("@/lib/helcim/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/helcim/client")>();
  return {
    ...actual,
    initializeCheckout: helcim.initialize,
    getCardTransaction: async (id: string) => {
      const tx = helcim.transactions.get(id);
      return tx ? actual.normalizeTransaction(tx) : null;
    },
    findCardTransactionsByInvoiceNumber: async (invoiceNumber: string) =>
      [...helcim.transactions.values()].filter((t) => t.invoiceNumber === invoiceNumber).map(actual.normalizeTransaction),
    purchaseWithCardToken: helcim.purchase,
    createHelcimCustomer: helcim.createCustomer,
  };
});

import { db, getPool, schema } from "../src/db";
import { newId } from "../src/lib/id";
import { normalizeTransaction } from "../src/lib/helcim/client";
import { recalculateInvoiceStatus } from "../src/lib/invoices";
import { confirmOnlineCheckout } from "../src/lib/payments";
import { setSetting } from "../src/lib/settings";
import { MEMBERSHIP_SETTINGS_DEFAULTS } from "../src/lib/memberships/config";
import { memberAllocation } from "../src/lib/memberships/pricing";
import { runMembershipBilling } from "../src/lib/memberships/billing";
import { sellWinterPassAtCounter } from "../src/lib/memberships/passes";
import {
  addMonthsClamped,
  beginMembershipSignup,
  cancelMembership,
  getVehicleEntitlements,
  reserveMembershipBenefit,
  reservePassWash,
  upgradeMembership,
  voidEntitlementsForAppointment,
} from "../src/lib/memberships/service";

const CLUB = "mpl_winterclub";
const COMPLETE = "mpl_wintercomplete";

async function resetDb() {
  await db().execute(sql`
    TRUNCATE membership_redemptions, membership_periods, memberships, winter_pass_redemptions, winter_passes,
             payment_checkouts, payments, invoice_line_items, invoices, appointments, vehicles, customers,
             communications, business_settings, audit_log, staff_users, invoice_counters CASCADE
  `);
  await db().insert(schema.invoiceCounters).values({ id: "default", nextNumber: 5000 });
  // The plans ship in migration 0033; re-assert the flyer values for each test.
  await db().execute(sql`DELETE FROM membership_plans`);
  await db().insert(schema.membershipPlans).values([
    { id: CLUB, slug: "winter-shield-club", name: "Winter Shield Club", monthlyPriceCents: 4900, discountBp: 1500, includedBenefits: ["wash"], rank: 1 },
    { id: COMPLETE, slug: "winter-shield-complete", name: "Winter Shield Complete", monthlyPriceCents: 6900, discountBp: 2000, includedBenefits: ["wash", "interior"], rank: 2 },
  ]);
  await setSetting("memberships", { ...MEMBERSHIP_SETTINGS_DEFAULTS, salesOpen: true, passSalesOpen: true });
  helcim.transactions.clear();
  helcim.nextCharge = "approve";
  helcim.initialize.mockReset();
  helcim.purchase.mockReset();
  helcim.createCustomer.mockReset();
  helcim.initialize.mockResolvedValue({ checkoutToken: "checkout_token", secretToken: "secret_token" });
  helcim.createCustomer.mockImplementation(async (input: { customerCode: string }) => ({ customerCode: input.customerCode }));
  helcim.purchase.mockImplementation(async (input: { invoiceNumber: string; amountCents: number }) =>
    normalizeTransaction(
      helcim.add({
        amount: (input.amountCents / 100).toFixed(2),
        invoiceNumber: input.invoiceNumber,
        status: helcim.nextCharge === "approve" ? "APPROVED" : "DECLINED",
      }),
    ),
  );
}

async function customerWithCar() {
  const customerId = newId("cus");
  const vehicleId = newId("veh");
  await db().insert(schema.customers).values({ id: customerId, firstName: "Mem", lastName: "Ber", email: `${customerId}@example.com` });
  await db().insert(schema.vehicles).values({ id: vehicleId, customerId, make: "Toyota", model: "RAV4", category: "suv_small" });
  const [customer] = await db().select().from(schema.customers).where(eq(schema.customers.id, customerId));
  return { customer, customerId, vehicleId };
}

/** Signs up and pays the first month the way the browser would. */
async function activeMember(planId = CLUB) {
  const { customer, customerId, vehicleId } = await customerWithCar();
  const started = await beginMembershipSignup({ customer, planId, vehicleId, termsAccepted: true });
  if (!started.ok) throw new Error(started.error);
  const [checkout] = await db().select().from(schema.paymentCheckouts).where(eq(schema.paymentCheckouts.id, started.checkoutId));
  const tx = helcim.add({
    amount: (checkout.amountCents / 100).toFixed(2),
    invoiceNumber: checkout.reference,
    cardToken: "card_on_file_1",
    customerCode: checkout.helcimCustomerCode,
  });
  const data = { ...tx };
  const hash = createHash("sha256").update(JSON.stringify(data) + "secret_token").digest("hex");
  const outcome = await confirmOnlineCheckout({ checkoutId: checkout.id, eventMessage: JSON.stringify({ hash, data }) });
  expect(outcome.status).toBe("succeeded");
  const [membership] = await db().select().from(schema.memberships).where(eq(schema.memberships.vehicleId, vehicleId));
  return { membership, customerId, vehicleId };
}

async function membershipRow(id: string) {
  return (await db().select().from(schema.memberships).where(eq(schema.memberships.id, id)))[0];
}

/** Moves a membership's paid month into the past so billing sees it as due. */
async function expireCurrentMonth(membershipId: string) {
  const end = new Date(Date.now() - 60_000);
  const start = addMonthsClamped(end, -1);
  await db().update(schema.memberships).set({ currentPeriodStart: start, currentPeriodEnd: end }).where(eq(schema.memberships.id, membershipId));
  await db()
    .update(schema.membershipPeriods)
    .set({ periodStart: start, periodEnd: end })
    .where(eq(schema.membershipPeriods.membershipId, membershipId));
}

beforeEach(resetDb);
afterAll(async () => {
  await getPool().end();
});

describe("monthly dates", () => {
  it("renews on the same day each month, clamped to short months", () => {
    expect(addMonthsClamped(new Date("2026-01-31T15:00:00Z"), 1).toISOString()).toBe("2026-02-28T15:00:00.000Z");
    expect(addMonthsClamped(new Date("2026-10-08T12:00:00Z"), 1).toISOString()).toBe("2026-11-08T12:00:00.000Z");
    expect(addMonthsClamped(new Date("2026-12-15T12:00:00Z"), 1).toISOString()).toBe("2027-01-15T12:00:00.000Z");
  });
});

describe("member pricing", () => {
  const member = {
    label: "Winter Shield Club member benefits",
    discountBp: 1500,
    discountServiceIds: ["svc_works"],
    discountAddons: true,
    free: [{ serviceId: "svc_wash", entitlement: { type: "membership_benefit" as const, membershipId: "mem_1", benefit: "wash" as const } }],
  };

  it("makes the included wash free, discounts packages, and add-ons only alongside a package", () => {
    const withPackage = memberAllocation(
      [
        { serviceId: "svc_wash", description: "Wash", priceCents: 3500, durationMin: 60 },
        { serviceId: "svc_works", description: "Signature", priceCents: 17500, durationMin: 120 },
        { addonId: "add_glass", description: "Glass", priceCents: 1499, durationMin: 15 },
        { serviceId: "svc_coating", description: "Ceramic coating", priceCents: 39900, durationMin: 300 },
      ],
      member,
    );
    expect(withPackage.allocation).toEqual([3500, 2625, 225, 0]);
    expect(withPackage.entitlements).toHaveLength(1);

    const washOnly = memberAllocation(
      [
        { serviceId: "svc_wash", description: "Wash", priceCents: 3500, durationMin: 60 },
        { addonId: "add_glass", description: "Glass", priceCents: 1499, durationMin: 15 },
      ],
      member,
    );
    expect(washOnly.allocation).toEqual([3500, 0]);
  });
});

describe("signing up", () => {
  it("activates only once the first month is paid, with the card saved for renewals", async () => {
    const { customer, vehicleId } = await customerWithCar();
    const started = await beginMembershipSignup({ customer, planId: CLUB, vehicleId, termsAccepted: true });
    if (!started.ok) throw new Error(started.error);
    expect(started.amountCents).toBe(5537); // $49 + 13% HST
    expect(helcim.initialize).toHaveBeenCalledWith(expect.objectContaining({ setAsDefaultPaymentMethod: true, customerCode: expect.stringMatching(/^PTC-/) }));
    const [pending] = await db().select().from(schema.memberships).where(eq(schema.memberships.vehicleId, vehicleId));
    expect(pending.status).toBe("pending");
    expect((await getVehicleEntitlements(vehicleId)).membership).toBeNull();

    const { membership } = await activeMemberFromExisting(started.checkoutId);
    expect(membership).toMatchObject({ status: "active", cardToken: "card_on_file_1", cardLabel: "Mastercard •••• 0089" });
    expect(membership.currentPeriodEnd!.getTime()).toBeGreaterThan(Date.now() + 27 * 86_400_000);
    const entitlements = await getVehicleEntitlements(vehicleId);
    expect(entitlements.membership).toMatchObject({ planName: "Winter Shield Club", available: ["wash"], discountBp: 1500 });
  });

  it("refuses a second membership on the same car and sales that are closed", async () => {
    const { vehicleId, customerId } = await activeMember();
    const [customer] = await db().select().from(schema.customers).where(eq(schema.customers.id, customerId));
    expect(await beginMembershipSignup({ customer, planId: COMPLETE, vehicleId, termsAccepted: true })).toMatchObject({
      ok: false,
      error: expect.stringContaining("already has a membership"),
    });
    await setSetting("memberships", { ...MEMBERSHIP_SETTINGS_DEFAULTS, salesOpen: false });
    const other = await customerWithCar();
    expect(await beginMembershipSignup({ customer: other.customer, planId: CLUB, vehicleId: other.vehicleId, termsAccepted: true })).toMatchObject({ ok: false });
  });
});

async function activeMemberFromExisting(checkoutId: string) {
  const [checkout] = await db().select().from(schema.paymentCheckouts).where(eq(schema.paymentCheckouts.id, checkoutId));
  const tx = helcim.add({ amount: (checkout.amountCents / 100).toFixed(2), invoiceNumber: checkout.reference, cardToken: "card_on_file_1" });
  await confirmOnlineCheckout({ checkoutId, eventMessage: JSON.stringify({ data: tx }) });
  const membershipId = checkout.subject.membershipId!;
  return { membership: await membershipRow(membershipId) };
}

describe("monthly billing", () => {
  it("bills each month once, on the card on file, even if the run repeats", async () => {
    const { membership } = await activeMember();
    await expireCurrentMonth(membership.id);
    const first = await runMembershipBilling();
    const second = await runMembershipBilling();
    expect(first.renewed).toBe(1);
    expect(second.renewed).toBe(0);
    expect(helcim.purchase).toHaveBeenCalledTimes(1);
    expect(helcim.purchase).toHaveBeenCalledWith(expect.objectContaining({ cardToken: "card_on_file_1", amountCents: 5537 }));
    const after = await membershipRow(membership.id);
    expect(after.status).toBe("active");
    expect(after.currentPeriodEnd!.getTime()).toBeGreaterThan(Date.now());
    const periods = await db().select().from(schema.membershipPeriods).where(eq(schema.membershipPeriods.membershipId, membership.id));
    expect(periods.map((p) => p.status).sort()).toEqual(["paid", "paid"]);
  });

  it("pauses benefits on a decline, retries on schedule, and recovers", async () => {
    const { membership, vehicleId } = await activeMember();
    await expireCurrentMonth(membership.id);
    helcim.nextCharge = "decline";
    expect(await runMembershipBilling()).toMatchObject({ declined: 1 });
    let row = await membershipRow(membership.id);
    expect(row).toMatchObject({ status: "past_due", failedAttempts: 1 });
    expect((await getVehicleEntitlements(vehicleId)).membership?.available).toEqual([]);

    // The retry date arrives and the card now works.
    helcim.nextCharge = "approve";
    await db().update(schema.memberships).set({ nextAttemptAt: new Date(Date.now() - 1000) }).where(eq(schema.memberships.id, membership.id));
    expect(await runMembershipBilling()).toMatchObject({ retried: 1 });
    row = await membershipRow(membership.id);
    expect(row).toMatchObject({ status: "active", failedAttempts: 0, nextAttemptAt: null });
    expect((await getVehicleEntitlements(vehicleId)).membership?.available).toEqual(["wash"]);
  });

  it("ends the membership after the last retry and cancels the uncollected month", async () => {
    const { membership } = await activeMember();
    await expireCurrentMonth(membership.id);
    helcim.nextCharge = "decline";
    await runMembershipBilling();
    for (let attempt = 0; attempt < 3; attempt++) {
      await db().update(schema.memberships).set({ nextAttemptAt: new Date(Date.now() - 1000) }).where(eq(schema.memberships.id, membership.id));
      await runMembershipBilling();
    }
    const row = await membershipRow(membership.id);
    expect(row.status).toBe("canceled");
    const [failed] = await db()
      .select()
      .from(schema.membershipPeriods)
      .where(and(eq(schema.membershipPeriods.membershipId, membership.id), eq(schema.membershipPeriods.status, "failed")));
    const [invoice] = await db().select().from(schema.invoices).where(eq(schema.invoices.id, failed.invoiceId!));
    expect(invoice.status).toBe("cancelled");
  });

  it("ends a cancelled membership at the end of the paid month without charging again", async () => {
    const { membership, vehicleId } = await activeMember();
    expect(await cancelMembership({ membershipId: membership.id, actor: { type: "customer" } })).toMatchObject({ ok: true });
    // Benefits continue for the rest of the paid month.
    expect((await getVehicleEntitlements(vehicleId)).membership?.available).toEqual(["wash"]);
    await expireCurrentMonth(membership.id);
    expect(await runMembershipBilling()).toMatchObject({ ended: 1, renewed: 0 });
    expect(helcim.purchase).not.toHaveBeenCalled();
    expect((await membershipRow(membership.id)).status).toBe("canceled");
  });

  it("moves members onto the next season's plan when that month is paid", async () => {
    const { membership } = await activeMember();
    const summerId = newId("mpl");
    await db().insert(schema.membershipPlans).values({ id: summerId, slug: "summer-shine", name: "Summer Shine", monthlyPriceCents: 3900, rank: 1 });
    await expireCurrentMonth(membership.id);
    await db()
      .update(schema.memberships)
      .set({ nextPlanId: summerId, nextPlanFrom: new Date(Date.now() - 86_400_000) })
      .where(eq(schema.memberships.id, membership.id));
    await runMembershipBilling();
    expect(helcim.purchase).toHaveBeenCalledWith(expect.objectContaining({ amountCents: 4407 })); // $39 + HST
    expect(await membershipRow(membership.id)).toMatchObject({ planId: summerId, priceCents: 3900, nextPlanId: null });
  });
});

describe("benefits", () => {
  it("allows one wash per paid month, and a cancelled booking gives it back", async () => {
    const { membership, customerId, vehicleId } = await activeMember();
    const appointmentId = newId("apt");
    await db().insert(schema.appointments).values({
      id: appointmentId,
      customerId,
      vehicleId,
      status: "confirmed",
      startsAt: new Date(Date.now() + 86_400_000),
      endsAt: new Date(Date.now() + 90_000_000),
      durationMin: 60,
    });
    await db().transaction((tx) => reserveMembershipBenefit(tx, { membershipId: membership.id, benefit: "wash", appointmentId }));
    await expect(
      db().transaction((tx) => reserveMembershipBenefit(tx, { membershipId: membership.id, benefit: "wash" })),
    ).rejects.toThrow(/already been used/);
    await expect(
      db().transaction((tx) => reserveMembershipBenefit(tx, { membershipId: membership.id, benefit: "interior" })),
    ).rejects.toThrow(/isn't included/);

    await db().update(schema.appointments).set({ status: "cancelled" }).where(eq(schema.appointments.id, appointmentId));
    await db().transaction((tx) => voidEntitlementsForAppointment(tx, appointmentId, "Booking cancelled"));
    expect((await getVehicleEntitlements(vehicleId)).membership?.available).toEqual(["wash"]);
    await db().transaction((tx) => reserveMembershipBenefit(tx, { membershipId: membership.id, benefit: "wash" }));
  });

  it("upgrades now: charges the difference and unlocks the interior clean this month", async () => {
    const { membership, vehicleId } = await activeMember(CLUB);
    const result = await upgradeMembership({ membershipId: membership.id, toPlanId: COMPLETE, ipAddress: "127.0.0.1", actor: { type: "customer" } });
    expect(result).toEqual({ ok: true, status: "approved" });
    expect(helcim.purchase).toHaveBeenCalledWith(expect.objectContaining({ amountCents: 2260 })); // $20 + HST
    expect(await membershipRow(membership.id)).toMatchObject({ planId: COMPLETE, priceCents: 6900 });
    expect((await getVehicleEntitlements(vehicleId)).membership?.available.sort()).toEqual(["interior", "wash"]);
    expect(
      await upgradeMembership({ membershipId: membership.id, toPlanId: CLUB, ipAddress: "127.0.0.1", actor: { type: "customer" } }),
    ).toMatchObject({ ok: false });
  });
});

describe("Winter Pass", () => {
  it("activates when its invoice is paid at the counter, then allows exactly its washes in season", async () => {
    const { customerId, vehicleId } = await customerWithCar();
    const staffId = newId("usr");
    await db().insert(schema.staffUsers).values({ id: staffId, name: "Front", email: `${staffId}@example.com`, passwordHash: "x", role: "owner" });
    const sold = await sellWinterPassAtCounter({ customerId, vehicleId, staffId });
    if (!sold.ok) throw new Error(sold.error);
    const [invoice] = await db().select().from(schema.invoices).where(eq(schema.invoices.id, sold.invoiceId));
    expect(invoice).toMatchObject({ subtotalCents: 9900, taxCents: 1287, totalCents: 11187, status: "sent" });
    expect((await getVehicleEntitlements(vehicleId)).passes).toHaveLength(0);

    // Staff take the payment the ordinary way.
    await db().insert(schema.payments).values({
      id: newId("pay"),
      invoiceId: invoice.id,
      customerId,
      provider: "card_terminal",
      idempotencyKey: `counter_${invoice.id}`,
      kind: "payment",
      amountCents: invoice.totalCents,
      status: "succeeded",
      receivedAt: new Date(),
    });
    await db().transaction((tx) => recalculateInvoiceStatus(tx, invoice.id));
    const [pass] = await db().select().from(schema.winterPasses).where(eq(schema.winterPasses.id, sold.passId));
    expect(pass.status).toBe("active");

    const inSeason = new Date(pass.validFrom.getTime() + 86_400_000);
    for (let wash = 1; wash <= 4; wash++) {
      const { washNumber } = await db().transaction((tx) => reservePassWash(tx, { passId: pass.id, at: inSeason }));
      expect(washNumber).toBe(wash);
    }
    await expect(db().transaction((tx) => reservePassWash(tx, { passId: pass.id, at: inSeason }))).rejects.toThrow(/All the washes/);
  });

  it("refuses a pass wash outside November–March", async () => {
    const { customerId, vehicleId } = await customerWithCar();
    const staffId = newId("usr");
    await db().insert(schema.staffUsers).values({ id: staffId, name: "Front", email: `${staffId}@example.com`, passwordHash: "x", role: "owner" });
    const sold = await sellWinterPassAtCounter({ customerId, vehicleId, staffId });
    if (!sold.ok) throw new Error(sold.error);
    await db().update(schema.winterPasses).set({ status: "active" }).where(eq(schema.winterPasses.id, sold.passId));
    const [pass] = await db().select().from(schema.winterPasses).where(eq(schema.winterPasses.id, sold.passId));
    const beforeSeason = new Date(pass.validFrom.getTime() - 86_400_000);
    await expect(db().transaction((tx) => reservePassWash(tx, { passId: pass.id, at: beforeSeason }))).rejects.toThrow(/November and March/);
  });
});
