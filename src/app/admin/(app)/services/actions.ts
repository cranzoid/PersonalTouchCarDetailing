"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import { db, schema, type Db } from "@/db";
import { requireStaff, AuthError } from "@/lib/auth/session";
import { audit } from "@/lib/audit";
import { newId } from "@/lib/id";
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
export type CreateResult = { ok: true; id: string } | { ok: false; error: string };

const createServiceInput = updateServiceInput.omit({ serviceId: true }).extend({
  categoryId: z.string().min(1),
});

const createAddonInput = updateAddonInput.omit({ addonId: true });

const createCategoryInput = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(500).optional(),
});

/** URL-safe slug from a display name; `services.slug` and `service_categories.slug` are unique. */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/**
 * Appends a numeric suffix until the slug is free. Runs inside the caller's
 * transaction so a concurrent insert cannot slip in between the check and the
 * write — the unique index is still the final authority.
 */
async function uniqueSlug(
  tx: Pick<Db, "select">,
  table: typeof schema.services | typeof schema.serviceCategories,
  base: string,
): Promise<string> {
  const seed = base || "item";
  for (let attempt = 0; attempt < 50; attempt++) {
    const candidate = attempt === 0 ? seed : `${seed}-${attempt + 1}`;
    const existing = await tx.select({ slug: table.slug }).from(table).where(eq(table.slug, candidate)).limit(1);
    if (existing.length === 0) return candidate;
  }
  throw new Error("Could not derive a unique slug");
}

/**
 * Adds a service to the catalogue. Created inactive on purpose: the owner sets
 * the price and wording first, then flips it live from the same screen, so a
 * half-configured service never appears on the public site.
 */
export async function createServiceAction(raw: unknown): Promise<CreateResult> {
  try {
    const staff = await requireStaff("manage_services");
    const parsed = createServiceInput.safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Invalid values — check price and duration" };
    const input = parsed.data;
    if (input.bookingMode === "bookable" && input.basePriceCents === null) {
      return { ok: false, error: "Directly bookable services need a base price" };
    }

    return await db().transaction(async (tx) => {
      const [category] = await tx
        .select({ id: schema.serviceCategories.id })
        .from(schema.serviceCategories)
        .where(eq(schema.serviceCategories.id, input.categoryId))
        .limit(1);
      if (!category) return { ok: false, error: "Category not found" };

      const serviceId = newId("svc");
      await tx.insert(schema.services).values({
        id: serviceId,
        categoryId: input.categoryId,
        name: input.name,
        slug: await uniqueSlug(tx, schema.services, slugify(input.name)),
        shortDescription: input.shortDescription ?? null,
        basePriceCents: input.basePriceCents,
        baseDurationMin: input.baseDurationMin,
        bookingMode: input.bookingMode,
        active: input.active,
        featured: input.featured,
        depositType: input.depositType,
        depositValue: input.depositValue,
      });
      await audit(tx, {
        actorType: "staff",
        actorId: staff.id,
        action: "service.created",
        entityType: "service",
        entityId: serviceId,
        after: {
          name: input.name,
          categoryId: input.categoryId,
          basePriceCents: input.basePriceCents,
          baseDurationMin: input.baseDurationMin,
          bookingMode: input.bookingMode,
          active: input.active,
        },
      });

      revalidatePath("/admin/services");
      revalidatePath("/services");
      revalidatePath("/");
      invalidatePublicCatalogCache();
      return { ok: true, id: serviceId };
    });
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, error: err.message };
    console.error("createServiceAction failed", err);
    return { ok: false, error: "Something went wrong" };
  }
}

/**
 * Adds an add-on and links it to every service that is eligible for it.
 * An add-on with no service links can never be selected during booking —
 * `priceBooking` rejects add-ons that are not linked to a chosen service.
 */
export async function createAddonAction(raw: unknown): Promise<CreateResult> {
  try {
    const staff = await requireStaff("manage_services");
    const parsed = createAddonInput
      .extend({ serviceIds: z.array(z.string().min(1)).default([]) })
      .safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Invalid values — check price and duration" };
    const input = parsed.data;

    return await db().transaction(async (tx) => {
      const addonId = newId("add");
      const [{ nextSort } = { nextSort: 0 }] = await tx
        .select({ nextSort: sql<number>`coalesce(max(${schema.addons.sort}), -1) + 1` })
        .from(schema.addons);
      await tx.insert(schema.addons).values({
        id: addonId,
        name: input.name,
        description: input.description,
        priceCents: input.priceCents,
        durationMin: input.durationMin,
        active: input.active,
        sort: nextSort,
      });
      if (input.serviceIds.length > 0) {
        await tx.insert(schema.serviceAddons).values(
          input.serviceIds.map((serviceId) => ({ id: newId("add"), serviceId, addonId })),
        );
      }
      await audit(tx, {
        actorType: "staff",
        actorId: staff.id,
        action: "addon.created",
        entityType: "addon",
        entityId: addonId,
        after: {
          name: input.name,
          priceCents: input.priceCents,
          durationMin: input.durationMin,
          active: input.active,
          linkedServices: input.serviceIds.length,
        },
      });

      revalidatePath("/admin/services");
      revalidatePath("/services");
      revalidatePath("/book");
      invalidatePublicCatalogCache();
      return { ok: true, id: addonId };
    });
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, error: err.message };
    console.error("createAddonAction failed", err);
    return { ok: false, error: "Something went wrong" };
  }
}

export async function createServiceCategoryAction(raw: unknown): Promise<CreateResult> {
  try {
    const staff = await requireStaff("manage_services");
    const parsed = createCategoryInput.safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Enter a category name" };
    const input = parsed.data;

    return await db().transaction(async (tx) => {
      const categoryId = newId("cat");
      const [{ nextSort } = { nextSort: 0 }] = await tx
        .select({ nextSort: sql<number>`coalesce(max(${schema.serviceCategories.sort}), -1) + 1` })
        .from(schema.serviceCategories);
      await tx.insert(schema.serviceCategories).values({
        id: categoryId,
        name: input.name,
        slug: await uniqueSlug(tx, schema.serviceCategories, slugify(input.name)),
        description: input.description,
        sort: nextSort,
      });
      await audit(tx, {
        actorType: "staff",
        actorId: staff.id,
        action: "service_category.created",
        entityType: "service_category",
        entityId: categoryId,
        after: { name: input.name },
      });

      revalidatePath("/admin/services");
      revalidatePath("/services");
      invalidatePublicCatalogCache();
      return { ok: true, id: categoryId };
    });
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, error: err.message };
    console.error("createServiceCategoryAction failed", err);
    return { ok: false, error: "Something went wrong" };
  }
}

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
