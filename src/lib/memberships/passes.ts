import { and, eq } from "drizzle-orm";
import { db, schema, type Db } from "@/db";
import { audit } from "@/lib/audit";
import { newId } from "@/lib/id";
import { getSettings, type BusinessSettings } from "@/lib/settings";
import { zonedToUtc } from "@/lib/tz";
import { ensureOnlineSession, insertCheckout } from "@/lib/payments/checkouts";
import { membershipSettings, type MembershipSettings } from "./config";
import { createSaleInvoice, MembershipError, type BeginCheckoutResult, type NewVehicleInput } from "./service";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * The season a pass covers, as instants: from the start of `validFrom` to the
 * end of `validUntil`, both business-local days.
 */
export function passValidityWindow(
  config: MembershipSettings["winterPass"],
  timeZone: string,
): { validFrom: Date; validUntil: Date } {
  const startOf = (iso: string) => {
    const [y, m, d] = iso.split("-").map(Number);
    return zonedToUtc(timeZone, y, m, d, 0, 0);
  };
  const [ey, em, ed] = config.validUntil.split("-").map(Number);
  // End of the last day = start of the next business-local day, minus 1 ms.
  const dayAfter = new Date(Date.UTC(ey, em - 1, ed + 1));
  return {
    validFrom: startOf(config.validFrom),
    validUntil: new Date(
      zonedToUtc(timeZone, dayAfter.getUTCFullYear(), dayAfter.getUTCMonth() + 1, dayAfter.getUTCDate(), 0, 0).getTime() - 1,
    ),
  };
}

async function createPendingPass(
  tx: Tx,
  input: {
    customerId: string;
    vehicleId: string;
    settings: BusinessSettings;
    staffId?: string | null;
  },
) {
  const config = membershipSettings(input.settings);
  const { validFrom, validUntil } = passValidityWindow(config.winterPass, input.settings.timezone);
  if (Date.now() > validUntil.getTime()) throw new MembershipError("The Winter Pass season is over.");
  const invoice = await createSaleInvoice(tx, {
    customerId: input.customerId,
    vehicleId: input.vehicleId,
    lines: [
      {
        description: `${config.winterPass.name} — ${config.winterPass.washesTotal} winter hand washes`,
        unitPriceCents: config.winterPass.priceCents,
      },
    ],
    notes: `Prepaid. Valid ${config.winterPass.validFrom} to ${config.winterPass.validUntil}. Free underbody salt flush with every Winter Pass wash.`,
    settings: input.settings,
    staffId: input.staffId,
  });
  const passId = newId("wpa");
  await tx.insert(schema.winterPasses).values({
    id: passId,
    customerId: input.customerId,
    vehicleId: input.vehicleId,
    saleInvoiceId: invoice.id,
    status: "pending_payment",
    washesTotal: config.winterPass.washesTotal,
    priceCents: config.winterPass.priceCents,
    validFrom,
    validUntil,
    termsVersion: config.termsVersion,
    createdByStaffId: input.staffId ?? null,
  });
  await audit(tx, {
    actorType: input.staffId ? "staff" : "customer",
    actorId: input.staffId ?? null,
    action: "winter_pass.sale_started",
    entityType: "winter_pass",
    entityId: passId,
    after: { invoiceId: invoice.id, vehicleId: input.vehicleId, priceCents: config.winterPass.priceCents },
  });
  return { passId, invoice };
}

async function resolveOwnedVehicle(tx: Tx, customerId: string, input: { vehicleId?: string; newVehicle?: NewVehicleInput }) {
  if (input.vehicleId) {
    const [vehicle] = await tx.select().from(schema.vehicles).where(eq(schema.vehicles.id, input.vehicleId)).for("update");
    if (!vehicle || vehicle.customerId !== customerId) throw new MembershipError("Choose one of your vehicles.");
    return vehicle;
  }
  const v = input.newVehicle;
  if (!v || !v.make.trim() || !v.model.trim()) throw new MembershipError("Tell us about your vehicle: make, model and type.");
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

/** Online purchase from the customer's account: pass + invoice + HelcimPay.js checkout. */
export async function beginWinterPassPurchase(input: {
  customer: typeof schema.customers.$inferSelect;
  vehicleId?: string;
  newVehicle?: NewVehicleInput;
  termsAccepted: boolean;
}): Promise<BeginCheckoutResult> {
  const settings = await getSettings();
  const config = membershipSettings(settings);
  if (!config.passSalesOpen) return { ok: false, error: "The Winter Pass isn't on sale online yet. Call us to buy one." };
  if (!input.termsAccepted) return { ok: false, error: "Please accept the Winter Pass terms to continue." };

  let claim: { checkout: typeof schema.paymentCheckouts.$inferSelect; description: string };
  try {
    claim = await db().transaction(async (tx) => {
      const vehicle = await resolveOwnedVehicle(tx, input.customer.id, input);
      // An earlier unpaid attempt for the same car is replaced, not stacked.
      const stale = await tx
        .select()
        .from(schema.winterPasses)
        .where(and(eq(schema.winterPasses.vehicleId, vehicle.id), eq(schema.winterPasses.status, "pending_payment")))
        .for("update");
      for (const pass of stale) {
        await tx
          .update(schema.winterPasses)
          .set({ status: "void", voidedAt: new Date(), voidReason: "Replaced by a new purchase", updatedAt: new Date() })
          .where(eq(schema.winterPasses.id, pass.id));
        if (pass.saleInvoiceId) {
          await tx
            .update(schema.invoices)
            .set({ status: "cancelled", cancelledAt: new Date(), cancellationReason: "Replaced by a new purchase", updatedAt: new Date() })
            .where(and(eq(schema.invoices.id, pass.saleInvoiceId), eq(schema.invoices.status, "sent")));
          await tx
            .update(schema.payments)
            .set({ status: "failed", failureReason: "Replaced by a new purchase", updatedAt: new Date() })
            .where(and(eq(schema.payments.invoiceId, pass.saleInvoiceId), eq(schema.payments.status, "pending")));
        }
      }
      const { passId, invoice } = await createPendingPass(tx, { customerId: input.customer.id, vehicleId: vehicle.id, settings });
      const checkout = await insertCheckout(tx, {
        kind: "winter_pass",
        channel: "online",
        customerId: input.customer.id,
        amountCents: invoice.totalCents,
        currency: settings.currency,
        subject: { passId, allocations: [{ invoiceId: invoice.id, amountCents: invoice.totalCents }] },
        payments: [{ customerId: input.customer.id, invoiceId: invoice.id, kind: "payment", amountCents: invoice.totalCents }],
      });
      return { checkout, description: `${config.winterPass.name} (incl. tax)` };
    });
  } catch (error) {
    if (error instanceof MembershipError) return { ok: false, error: error.message };
    throw error;
  }
  try {
    const { checkoutToken } = await ensureOnlineSession(claim.checkout, {
      lineItems: [{ description: claim.description, quantity: 1, unitPriceCents: claim.checkout.amountCents }],
    });
    return { ok: true, checkoutId: claim.checkout.id, checkoutToken, amountCents: claim.checkout.amountCents };
  } catch (error) {
    console.error("beginWinterPassPurchase could not open a Helcim session", error);
    return { ok: false, error: "Online purchase is temporarily unavailable. Please try again shortly." };
  }
}

/**
 * Sold at the counter: the pass and its invoice are created here, and staff
 * take the payment on the invoice like any other — cash, terminal, anything.
 * The pass activates when that invoice is paid in full.
 */
export async function sellWinterPassAtCounter(input: {
  customerId: string;
  vehicleId: string;
  staffId: string;
}): Promise<{ ok: true; invoiceId: string; passId: string } | { ok: false; error: string }> {
  const settings = await getSettings();
  try {
    return await db().transaction(async (tx) => {
      const [vehicle] = await tx.select().from(schema.vehicles).where(eq(schema.vehicles.id, input.vehicleId)).for("update");
      if (!vehicle || vehicle.customerId !== input.customerId) throw new MembershipError("That vehicle isn't on this customer's record.");
      const { passId, invoice } = await createPendingPass(tx, {
        customerId: input.customerId,
        vehicleId: vehicle.id,
        settings,
        staffId: input.staffId,
      });
      return { ok: true as const, invoiceId: invoice.id, passId };
    });
  } catch (error) {
    if (error instanceof MembershipError) return { ok: false, error: error.message };
    throw error;
  }
}
