import "server-only";

import { and, asc, desc, gt, inArray, notInArray } from "drizzle-orm";
import { db, schema } from "@/db";
import { appointmentWhenLabel } from "@/lib/appointment-time";
import { formatCents, taxCents } from "@/lib/money";
import { MEMBERSHIP_BENEFITS } from "@/lib/memberships/config";
import { getVehicleEntitlements, listPlans, planBenefits } from "@/lib/memberships/service";
import { loadPortalInvoices } from "@/lib/portal-invoices";
import type { BusinessSettings } from "@/lib/settings";
import { formatInZone } from "@/lib/tz";

export type AccountMembership = {
  id: string;
  vehicleId: string;
  vehicleLabel: string;
  planId: string;
  planName: string;
  status: string;
  priceLabel: string;
  cardLabel: string | null;
  cancelAtPeriodEnd: boolean;
  periodEndLabel: string | null;
  benefits: { key: string; label: string; available: boolean }[];
  discountPercent: number;
  upgrades: { planId: string; name: string; differenceLabel: string; priceLabel: string }[];
  nextPlanName: string | null;
  nextPlanFromLabel: string | null;
};

export type AccountPass = {
  id: string;
  vehicleId: string;
  vehicleLabel: string;
  status: string;
  washesTotal: number;
  washesLeft: number;
  validLabel: string;
  usableNow: boolean;
};

function vehicleLabel(v: { year: number | null; make: string; model: string; licencePlate: string | null }): string {
  return [v.year, v.make, v.model].filter(Boolean).join(" ") + (v.licencePlate ? ` (${v.licencePlate})` : "");
}

/** Everything the signed-in account page shows, for every record the contact owns. */
export async function loadAccountOverview(customerIds: string[], settings: BusinessSettings) {
  const ids = customerIds.length ? customerIds : ["-"];
  const withTax = (cents: number) => formatCents(cents + taxCents(cents, settings.taxRateBp), settings.currency);
  const day = (d: Date) => formatInZone(d, settings.timezone, { month: "long", day: "numeric", year: "numeric" });

  const [vehicles, memberships, passes, appointments, plans, invoices] = await Promise.all([
    db().select().from(schema.vehicles).where(inArray(schema.vehicles.customerId, ids)).orderBy(desc(schema.vehicles.createdAt)),
    db()
      .select()
      .from(schema.memberships)
      .where(and(inArray(schema.memberships.customerId, ids), inArray(schema.memberships.status, ["active", "past_due"])))
      .orderBy(desc(schema.memberships.createdAt)),
    db()
      .select()
      .from(schema.winterPasses)
      .where(and(inArray(schema.winterPasses.customerId, ids), inArray(schema.winterPasses.status, ["active"])))
      .orderBy(desc(schema.winterPasses.createdAt)),
    db()
      .select()
      .from(schema.appointments)
      .where(
        and(
          inArray(schema.appointments.customerId, ids),
          gt(schema.appointments.startsAt, new Date(Date.now() - 6 * 3_600_000)),
          notInArray(schema.appointments.status, ["cancelled", "no_show", "completed", "converted"]),
        ),
      )
      .orderBy(asc(schema.appointments.startsAt))
      .limit(20),
    listPlans({ activeOnly: true }),
    loadPortalInvoices(customerIds, settings),
  ]);
  const vehiclesById = new Map(vehicles.map((v) => [v.id, v]));
  const plansById = new Map((await listPlans()).map((p) => [p.id, p]));

  const accountMemberships: AccountMembership[] = [];
  for (const membership of memberships) {
    const plan = plansById.get(membership.planId);
    const vehicle = vehiclesById.get(membership.vehicleId);
    if (!plan || !vehicle) continue;
    const entitlement = (await getVehicleEntitlements(vehicle.id)).membership;
    const nextPlan = membership.nextPlanId ? plansById.get(membership.nextPlanId) : null;
    accountMemberships.push({
      id: membership.id,
      vehicleId: vehicle.id,
      vehicleLabel: vehicleLabel(vehicle),
      planId: plan.id,
      planName: plan.name,
      status: membership.status,
      priceLabel: withTax(membership.priceCents),
      cardLabel: membership.cardLabel,
      cancelAtPeriodEnd: membership.cancelAtPeriodEnd,
      periodEndLabel: membership.currentPeriodEnd ? day(membership.currentPeriodEnd) : null,
      benefits: planBenefits(plan).map((key) => ({
        key,
        label: MEMBERSHIP_BENEFITS[key].label,
        available: Boolean(entitlement?.available.includes(key)),
      })),
      discountPercent: plan.discountBp / 100,
      upgrades:
        membership.status === "active" && !membership.cancelAtPeriodEnd
          ? plans
              .filter((p) => p.rank > plan.rank && p.monthlyPriceCents > membership.priceCents)
              .map((p) => ({
                planId: p.id,
                name: p.name,
                differenceLabel: withTax(p.monthlyPriceCents - membership.priceCents),
                priceLabel: withTax(p.monthlyPriceCents),
              }))
          : [],
      nextPlanName: nextPlan?.name ?? null,
      nextPlanFromLabel: membership.nextPlanFrom ? day(membership.nextPlanFrom) : null,
    });
  }

  const accountPasses: AccountPass[] = [];
  for (const pass of passes) {
    const vehicle = vehiclesById.get(pass.vehicleId);
    if (!vehicle) continue;
    const entitlement = (await getVehicleEntitlements(vehicle.id)).passes.find((p) => p.passId === pass.id);
    accountPasses.push({
      id: pass.id,
      vehicleId: vehicle.id,
      vehicleLabel: vehicleLabel(vehicle),
      status: pass.status,
      washesTotal: pass.washesTotal,
      washesLeft: entitlement ? entitlement.washesTotal - entitlement.washesUsed : 0,
      validLabel: `${day(pass.validFrom)} – ${day(pass.validUntil)}`,
      usableNow: entitlement?.usableNow ?? false,
    });
  }

  return {
    vehicles: vehicles.map((v) => ({ id: v.id, label: vehicleLabel(v), category: v.category, customerId: v.customerId })),
    memberships: accountMemberships,
    passes: accountPasses,
    appointments: appointments.map((a) => ({
      id: a.id,
      whenLabel: appointmentWhenLabel(a, settings.timezone, { weekday: "long", month: "long", day: "numeric" }),
      status: a.status,
      vehicleLabel: vehiclesById.get(a.vehicleId) ? vehicleLabel(vehiclesById.get(a.vehicleId)!) : "Vehicle",
      totalLabel: formatCents(a.totalCents, settings.currency),
    })),
    invoices,
  };
}
