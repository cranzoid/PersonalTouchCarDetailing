"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireStaff, AuthError } from "@/lib/auth/session";
import { audit } from "@/lib/audit";
import { invalidatePublicCatalogCache } from "@/lib/public-catalog";
import { BOOKING_MODES } from "@/lib/types";
import { VEHICLE_CATEGORIES } from "@/lib/types";

const updateServiceInput = z.object({
  serviceId: z.string().min(1),
  name: z.string().trim().min(1).max(200),
  shortDescription: z.string().trim().max(500).optional(),
  basePriceCents: z.number().int().min(0).nullable(),
  baseDurationMin: z.number().int().min(5).max(24 * 60 * 7),
  bookingMode: z.enum(BOOKING_MODES),
  active: z.boolean(),
  featured: z.boolean(),
  depositType: z.enum(["none", "fixed", "percent"]),
  depositValue: z.number().int().min(0),
});

const updateAddonInput = z.object({
  addonId: z.string().min(1),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(500),
  priceCents: z.number().int().min(0),
  durationMin: z.number().int().min(0).max(24 * 60 * 7),
  active: z.boolean(),
});

const updateVehicleAdjustmentInput = z.object({
  adjustmentId: z.string().min(1),
  vehicleCategory: z.enum(VEHICLE_CATEGORIES),
  priceDeltaCents: z.number().int().min(0),
  durationDeltaMin: z.number().int().min(0).max(24 * 60 * 7),
});

export type ActionResult = { ok: true } | { ok: false; error: string };

export async function updateServiceAction(raw: unknown): Promise<ActionResult> {
  try {
    const staff = await requireStaff("manage_services");
    const parsed = updateServiceInput.safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Invalid values — check price and duration" };
    const input = parsed.data;
    if (input.bookingMode === "bookable" && input.basePriceCents === null) {
      return { ok: false, error: "Directly bookable services need a base price" };
    }

    return await db().transaction(async (tx) => {
      const rows = await tx.select().from(schema.services).where(eq(schema.services.id, input.serviceId)).for("update");
      const before = rows[0];
      if (!before) return { ok: false, error: "Service not found" };

      await tx
        .update(schema.services)
        .set({
          name: input.name,
          shortDescription: input.shortDescription ?? null,
          basePriceCents: input.basePriceCents,
          baseDurationMin: input.baseDurationMin,
          bookingMode: input.bookingMode,
          active: input.active,
          featured: input.featured,
          depositType: input.depositType,
          depositValue: input.depositValue,
          updatedAt: new Date(),
        })
        .where(eq(schema.services.id, input.serviceId));

      // Price/config changes are sensitive: always audited.
      await audit(tx, {
        actorType: "staff",
        actorId: staff.id,
        action: "service.updated",
        entityType: "service",
        entityId: input.serviceId,
        before: {
          name: before.name,
          basePriceCents: before.basePriceCents,
          baseDurationMin: before.baseDurationMin,
          bookingMode: before.bookingMode,
          active: before.active,
          depositType: before.depositType,
          depositValue: before.depositValue,
        },
        after: {
          name: input.name,
          basePriceCents: input.basePriceCents,
          baseDurationMin: input.baseDurationMin,
          bookingMode: input.bookingMode,
          active: input.active,
          depositType: input.depositType,
          depositValue: input.depositValue,
        },
      });

      revalidatePath("/admin/services");
      revalidatePath("/services");
      revalidatePath("/");
      invalidatePublicCatalogCache();
      return { ok: true };
    });
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, error: err.message };
    console.error("updateServiceAction failed", err);
    return { ok: false, error: "Something went wrong" };
  }
}

export async function updateAddonAction(raw: unknown): Promise<ActionResult> {
  try {
    const staff = await requireStaff("manage_services");
    const parsed = updateAddonInput.safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Invalid values — check price and duration" };
    const input = parsed.data;

    return await db().transaction(async (tx) => {
      const [before] = await tx
        .select()
        .from(schema.addons)
        .where(eq(schema.addons.id, input.addonId))
        .for("update");
      if (!before) return { ok: false, error: "Add-on not found" };

      const after = {
        name: input.name,
        description: input.description || null,
        priceCents: input.priceCents,
        durationMin: input.durationMin,
        active: input.active,
      };
      await tx
        .update(schema.addons)
        .set({ ...after, updatedAt: new Date() })
        .where(eq(schema.addons.id, input.addonId));
      await audit(tx, {
        actorType: "staff",
        actorId: staff.id,
        action: "addon.updated",
        entityType: "addon",
        entityId: input.addonId,
        before: {
          name: before.name,
          description: before.description,
          priceCents: before.priceCents,
          durationMin: before.durationMin,
          active: before.active,
        },
        after,
      });

      revalidatePath("/admin/services");
      revalidatePath("/services");
      revalidatePath("/book");
      invalidatePublicCatalogCache();
      return { ok: true };
    });
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, error: err.message };
    console.error("updateAddonAction failed", err);
    return { ok: false, error: "Something went wrong" };
  }
}

export async function updateVehicleAdjustmentAction(raw: unknown): Promise<ActionResult> {
  try {
    const staff = await requireStaff("manage_services");
    const parsed = updateVehicleAdjustmentInput.safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Invalid vehicle adjustment" };
    const input = parsed.data;

    return await db().transaction(async (tx) => {
      const [before] = await tx
        .select()
        .from(schema.serviceVehicleAdjustments)
        .where(eq(schema.serviceVehicleAdjustments.id, input.adjustmentId))
        .for("update");
      if (!before) return { ok: false, error: "Vehicle adjustment not found" };
      if (before.vehicleCategory !== input.vehicleCategory) {
        return { ok: false, error: "Vehicle category does not match this adjustment" };
      }

      const after = {
        priceDeltaCents: input.priceDeltaCents,
        durationDeltaMin: input.durationDeltaMin,
      };
      await tx
        .update(schema.serviceVehicleAdjustments)
        .set(after)
        .where(eq(schema.serviceVehicleAdjustments.id, input.adjustmentId));
      await audit(tx, {
        actorType: "staff",
        actorId: staff.id,
        action: "service_vehicle_adjustment.updated",
        entityType: "service_vehicle_adjustment",
        entityId: input.adjustmentId,
        before: {
          vehicleCategory: before.vehicleCategory,
          priceDeltaCents: before.priceDeltaCents,
          durationDeltaMin: before.durationDeltaMin,
        },
        after: { vehicleCategory: input.vehicleCategory, ...after },
      });

      revalidatePath("/admin/services");
      revalidatePath("/services");
      revalidatePath("/book");
      invalidatePublicCatalogCache();
      return { ok: true };
    });
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, error: err.message };
    console.error("updateVehicleAdjustmentAction failed", err);
    return { ok: false, error: "Something went wrong" };
  }
}
