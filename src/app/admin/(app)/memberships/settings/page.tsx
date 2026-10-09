import Link from "next/link";
import { and, asc, count, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import { requirePageStaff } from "@/lib/auth/page";
import { membershipSettings } from "@/lib/memberships/config";
import { listPlans } from "@/lib/memberships/service";
import { getSettings } from "@/lib/settings";
import { localDateISO } from "@/lib/tz";
import { MembershipSettingsForm, PlanEditor, SeasonChange } from "./settings-forms";

export const dynamic = "force-dynamic";

/**
 * Memberships → Settings. Kept apart from Admin → Settings on purpose: the
 * owners asked for membership configuration not to be mixed into the general
 * business settings.
 */
export default async function MembershipSettingsPage() {
  await requirePageStaff("manage_memberships");
  const settings = await getSettings();
  const config = membershipSettings(settings);
  const plans = await listPlans();
  const memberCounts = await db()
    .select({ planId: schema.memberships.planId, n: count() })
    .from(schema.memberships)
    .where(inArray(schema.memberships.status, ["active", "past_due"]))
    .groupBy(schema.memberships.planId);
  const services = await db()
    .select({ slug: schema.services.slug, name: schema.services.name })
    .from(schema.services)
    .where(and(eq(schema.services.active, true), eq(schema.services.bookingMode, "bookable")))
    .orderBy(asc(schema.services.sort));

  return (
    <div className="max-w-5xl">
      <Link href="/admin/memberships" className="text-sm text-accent-300 hover:underline">← Memberships</Link>
      <h1 className="mt-4 text-2xl font-bold text-white">Membership settings</h1>
      <p className="mt-1 text-sm text-ink-400">
        Plans, the Winter Pass and how memberships behave. Prices are before tax. A plan&apos;s price change applies to new members;
        existing members keep the price they joined at until you move them with a scheduled change.
      </p>

      <section className="mt-8">
        <h2 className="text-lg font-semibold text-white">Plans</h2>
        <div className="mt-3 space-y-4">
          {plans.map((plan) => (
            <PlanEditor
              key={plan.id}
              plan={{
                id: plan.id,
                slug: plan.slug,
                name: plan.name,
                tagline: plan.tagline ?? "",
                features: plan.features,
                monthlyPriceCents: plan.monthlyPriceCents,
                discountBp: plan.discountBp,
                includedBenefits: plan.includedBenefits,
                rank: plan.rank,
                active: plan.active,
                sort: plan.sort,
              }}
              members={Number(memberCounts.find((c) => c.planId === plan.id)?.n ?? 0)}
            />
          ))}
          <PlanEditor plan={null} members={0} />
        </div>
      </section>

      <section className="mt-10">
        <h2 className="text-lg font-semibold text-white">Season change</h2>
        <p className="mt-1 text-sm text-ink-400">
          Move every member of one plan onto another from a date — for example Winter Shield to a summer plan. Each member is told{" "}
          {config.planChangeNoticeDays} days before, and moves at their first billing date on or after the start date.
        </p>
        <SeasonChange plans={plans.map((p) => ({ id: p.id, name: p.name, active: p.active }))} defaultFromISO={localDateISO(settings.timezone, 30 * 86_400_000)} />
      </section>

      <section className="mt-10">
        <h2 className="text-lg font-semibold text-white">Winter Pass, discounts and billing</h2>
        <MembershipSettingsForm initial={config} services={services} />
      </section>
    </div>
  );
}
