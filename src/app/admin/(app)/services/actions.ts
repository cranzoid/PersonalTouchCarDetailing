"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireStaff, AuthError } from "@/lib/auth/session";
import { audit } from "@/lib/audit";
import { BOOKING_MODES } from "@/lib/types";

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
      return { ok: true };
    });
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, error: err.message };
    console.error("updateServiceAction failed", err);
    return { ok: false, error: "Something went wrong" };
  }
}
