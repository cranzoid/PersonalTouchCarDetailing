"use server";

import { revalidatePath } from "next/cache";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { audit } from "@/lib/audit";
import { AuthError, requireStaff } from "@/lib/auth/session";
import { newId } from "@/lib/id";
import { BENEFIT_KEYS, membershipSettings, type MembershipSettings } from "@/lib/memberships/config";
import { sellWinterPassAtCounter } from "@/lib/memberships/passes";
import {
  cancelMembership,
  chargeMembershipPeriod,
  giftMembershipMonth,
  resumeMembership,
  scheduleMembershipPlanChange,
  voidWinterPass,
} from "@/lib/memberships/service";
import { requestIp } from "@/lib/request-ip";
import { getSettings, invalidatePublicSettingsCache, setSetting } from "@/lib/settings";
import { zonedToUtc } from "@/lib/tz";

type Result = { ok: true; message?: string } | { ok: false; error: string };

async function guard<T extends Result>(permission: Parameters<typeof requireStaff>[0], fn: (staffId: string) => Promise<T>): Promise<T | Result> {
  try {
    const staff = await requireStaff(permission);
    return await fn(staff.id);
  } catch (error) {
    if (error instanceof AuthError) return { ok: false, error: error.message };
    console.error("membership admin action failed", error);
    return { ok: false, error: "Something went wrong" };
  }
}

function refresh(membershipId?: string) {
  revalidatePath("/admin/memberships");
  if (membershipId) revalidatePath(`/admin/memberships/${membershipId}`);
}

export async function staffCancelMembershipAction(raw: unknown): Promise<Result> {
  return guard("manage_memberships", async (staffId) => {
    const parsed = z.object({ membershipId: z.string(), immediately: z.boolean(), reason: z.string().trim().min(1).max(500) }).safeParse(raw);
    if (!parsed.success) return { ok: false, error: "A reason is required." };
    const result = await cancelMembership({
      membershipId: parsed.data.membershipId,
      actor: { type: "staff", id: staffId },
      immediately: parsed.data.immediately,
      reason: parsed.data.reason,
    });
    refresh(parsed.data.membershipId);
    return result.ok ? { ok: true } : result;
  });
}

export async function staffResumeMembershipAction(membershipId: string): Promise<Result> {
  return guard("manage_memberships", async (staffId) => {
    const result = await resumeMembership({ membershipId, actor: { type: "staff", id: staffId } });
    refresh(membershipId);
    return result;
  });
}

export async function retryMembershipChargeAction(membershipId: string): Promise<Result> {
  return guard("manage_memberships", async () => {
    const [failed] = await db()
      .select()
      .from(schema.membershipPeriods)
      .where(and(eq(schema.membershipPeriods.membershipId, membershipId), inArray(schema.membershipPeriods.status, ["failed", "due"])))
      .orderBy(desc(schema.membershipPeriods.periodStart))
      .limit(1);
    if (!failed) return { ok: false, error: "There's no unpaid month to charge." };
    const outcome = await chargeMembershipPeriod(failed.id, await requestIp());
    refresh(membershipId);
    if (outcome === "approved") return { ok: true, message: "Charged — the membership is active again." };
    if (outcome === "pending") return { ok: true, message: "Sent to Helcim; the result will appear here within the hour." };
    return { ok: false, error: "The card was declined again. Ask the member to update their card in their account." };
  });
}

export async function giftMonthAction(membershipId: string): Promise<Result> {
  return guard("manage_memberships", async (staffId) => {
    const result = await giftMembershipMonth({ membershipId, staffId });
    refresh(membershipId);
    return result.ok ? { ok: true, message: "Month given." } : result;
  });
}

function startOfLocalDay(iso: string, timeZone: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return zonedToUtc(timeZone, y, m, d, 0, 0);
}

export async function schedulePlanChangeAction(raw: unknown): Promise<Result> {
  return guard("manage_memberships", async (staffId) => {
    const parsed = z
      .object({
        // Either one membership, or every live member of a plan.
        membershipId: z.string().optional(),
        fromPlanId: z.string().optional(),
        toPlanId: z.string().nullable(),
        fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
      })
      .safeParse(raw);
    if (!parsed.success || (!parsed.data.membershipId && !parsed.data.fromPlanId)) return { ok: false, error: "Invalid request" };
    const settings = await getSettings();
    const ids = parsed.data.membershipId
      ? [parsed.data.membershipId]
      : (
          await db()
            .select({ id: schema.memberships.id })
            .from(schema.memberships)
            .where(and(eq(schema.memberships.planId, parsed.data.fromPlanId!), inArray(schema.memberships.status, ["active", "past_due"])))
        ).map((r) => r.id);
    const result = await scheduleMembershipPlanChange({
      membershipIds: ids,
      toPlanId: parsed.data.toPlanId,
      from: parsed.data.fromDate ? startOfLocalDay(parsed.data.fromDate, settings.timezone) : null,
      staffId,
    });
    refresh(parsed.data.membershipId);
    revalidatePath("/admin/memberships/settings");
    if (!result.ok) return result;
    return {
      ok: true,
      message: parsed.data.toPlanId
        ? `Scheduled for ${result.updated} member${result.updated === 1 ? "" : "s"}. Each will be told ${membershipSettings(settings).planChangeNoticeDays} days before.`
        : `Cleared for ${result.updated} member${result.updated === 1 ? "" : "s"}.`,
    };
  });
}

/* --- plans and settings ---------------------------------------------------- */

const planInput = z.object({
  id: z.string().optional(),
  slug: z.string().trim().regex(/^[a-z0-9-]{3,60}$/, "Slug: lower-case letters, digits and dashes"),
  name: z.string().trim().min(2).max(80),
  tagline: z.string().trim().max(160).optional(),
  features: z.array(z.string().trim().min(1).max(160)).max(20),
  monthlyPriceCents: z.number().int().min(100).max(100_000),
  discountBp: z.number().int().min(0).max(5000),
  includedBenefits: z.array(z.enum(BENEFIT_KEYS as [string, ...string[]])),
  rank: z.number().int().min(0).max(100),
  active: z.boolean(),
  sort: z.number().int().min(0).max(100),
});

/**
 * Saves a plan. A price change applies to NEW members; existing members keep
 * the price they joined at (memberships.price_cents) until staff move them,
 * which is a scheduled plan change with notice.
 */
export async function savePlanAction(raw: unknown): Promise<Result> {
  return guard("manage_memberships", async (staffId) => {
    const parsed = planInput.safeParse(raw);
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Please check the plan." };
    const plan = parsed.data;
    const values = {
      slug: plan.slug,
      name: plan.name,
      tagline: plan.tagline || null,
      features: plan.features,
      monthlyPriceCents: plan.monthlyPriceCents,
      discountBp: plan.discountBp,
      includedBenefits: plan.includedBenefits,
      rank: plan.rank,
      active: plan.active,
      sort: plan.sort,
      updatedAt: new Date(),
    };
    try {
      if (plan.id) {
        const [before] = await db().select().from(schema.membershipPlans).where(eq(schema.membershipPlans.id, plan.id));
        if (!before) return { ok: false, error: "Plan not found." };
        await db().update(schema.membershipPlans).set(values).where(eq(schema.membershipPlans.id, plan.id));
        await audit(db(), { actorType: "staff", actorId: staffId, action: "membership_plan.updated", entityType: "membership_plan", entityId: plan.id, before, after: values });
      } else {
        const id = newId("mpl");
        await db().insert(schema.membershipPlans).values({ id, ...values });
        await audit(db(), { actorType: "staff", actorId: staffId, action: "membership_plan.created", entityType: "membership_plan", entityId: id, after: values });
      }
    } catch (error) {
      if (String(error).includes("membership_plans_slug_unique")) return { ok: false, error: "Another plan already uses that slug." };
      throw error;
    }
    revalidatePath("/admin/memberships/settings");
    revalidatePath("/winter");
    return { ok: true, message: "Plan saved." };
  });
}

const settingsInput = z.object({
  salesOpen: z.boolean(),
  passSalesOpen: z.boolean(),
  winterPass: z.object({
    name: z.string().trim().min(2).max(60),
    priceCents: z.number().int().min(100).max(100_000),
    washesTotal: z.number().int().min(1).max(20),
    validFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    validUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    features: z.array(z.string().trim().min(1).max(160)).max(12),
  }),
  discountServiceSlugs: z.array(z.string().trim().min(1)).max(20),
  discountAddons: z.boolean(),
  priorityBookingExtraDays: z.number().int().min(0).max(180),
  retryDays: z.array(z.number().int().min(1).max(60)).min(1).max(6),
  planChangeNoticeDays: z.number().int().min(0).max(90),
  termsVersion: z.string().trim().min(1).max(40),
});

export async function saveMembershipSettingsAction(raw: unknown): Promise<Result> {
  return guard("manage_memberships", async (staffId) => {
    const parsed = settingsInput.safeParse(raw);
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Please check the settings." };
    const value: MembershipSettings = parsed.data;
    if (value.winterPass.validUntil < value.winterPass.validFrom) return { ok: false, error: "The pass season ends before it starts." };
    if ([...value.retryDays].sort((a, b) => a - b).join() !== value.retryDays.join()) {
      return { ok: false, error: "Retry days must go up, e.g. 3, 5, 7." };
    }
    const before = membershipSettings(await getSettings());
    await setSetting("memberships", value, staffId);
    invalidatePublicSettingsCache();
    await audit(db(), { actorType: "staff", actorId: staffId, action: "membership_settings.updated", entityType: "business_settings", entityId: "memberships", before, after: value });
    revalidatePath("/admin/memberships/settings");
    revalidatePath("/winter");
    return { ok: true, message: "Settings saved." };
  });
}

/* --- Winter Pass at the counter ---------------------------------------------- */

export async function sellWinterPassAction(raw: unknown): Promise<Result & { invoiceId?: string }> {
  return guard("record_payments", async (staffId) => {
    const parsed = z.object({ customerId: z.string(), vehicleId: z.string() }).safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Choose a vehicle." };
    const result = await sellWinterPassAtCounter({ ...parsed.data, staffId });
    if (!result.ok) return result;
    revalidatePath(`/admin/customers/${parsed.data.customerId}`);
    return { ok: true, invoiceId: result.invoiceId, message: "Pass created — take the payment on its invoice." };
  });
}

export async function voidPassAction(raw: unknown): Promise<Result> {
  return guard("manage_memberships", async (staffId) => {
    const parsed = z.object({ passId: z.string(), reason: z.string().trim().min(1).max(300) }).safeParse(raw);
    if (!parsed.success) return { ok: false, error: "A reason is required." };
    const result = await voidWinterPass({ ...parsed.data, staffId });
    revalidatePath("/admin/memberships");
    return result;
  });
}
