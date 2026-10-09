import Link from "next/link";
import { notFound } from "next/navigation";
import { asc, desc, eq, inArray } from "drizzle-orm";
import { StatusBadge } from "@/components/admin";
import { db, schema } from "@/db";
import { requirePageStaff } from "@/lib/auth/page";
import { MEMBERSHIP_BENEFITS, isBenefit } from "@/lib/memberships/config";
import { getVehicleEntitlements, listPlans } from "@/lib/memberships/service";
import { formatCents, taxCents } from "@/lib/money";
import { getSettings } from "@/lib/settings";
import { formatInZone, localDateISO } from "@/lib/tz";
import { MemberActions } from "./member-actions";

export const dynamic = "force-dynamic";

export default async function MembershipDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePageStaff("manage_memberships");
  const { id } = await params;
  const settings = await getSettings();
  const [row] = await db()
    .select({ membership: schema.memberships, plan: schema.membershipPlans, customer: schema.customers, vehicle: schema.vehicles })
    .from(schema.memberships)
    .innerJoin(schema.membershipPlans, eq(schema.membershipPlans.id, schema.memberships.planId))
    .innerJoin(schema.customers, eq(schema.customers.id, schema.memberships.customerId))
    .innerJoin(schema.vehicles, eq(schema.vehicles.id, schema.memberships.vehicleId))
    .where(eq(schema.memberships.id, id))
    .limit(1);
  if (!row) notFound();
  const { membership, plan, customer, vehicle } = row;
  const [periods, redemptions, plans, entitlements] = await Promise.all([
    db().select().from(schema.membershipPeriods).where(eq(schema.membershipPeriods.membershipId, id)).orderBy(desc(schema.membershipPeriods.periodStart)),
    db().select().from(schema.membershipRedemptions).where(eq(schema.membershipRedemptions.membershipId, id)).orderBy(desc(schema.membershipRedemptions.redeemedAt)).limit(50),
    listPlans(),
    getVehicleEntitlements(vehicle.id),
  ]);
  const invoiceIds = periods.map((p) => p.invoiceId).filter((v): v is string => Boolean(v));
  const invoices = invoiceIds.length ? await db().select().from(schema.invoices).where(inArray(schema.invoices.id, invoiceIds)) : [];
  const invoiceById = new Map(invoices.map((i) => [i.id, i]));
  const nextPlan = plans.find((p) => p.id === membership.nextPlanId);
  const day = (d: Date | null) => (d ? formatInZone(d, settings.timezone, { month: "short", day: "numeric", year: "numeric" }) : "—");
  const withTax = (cents: number) => formatCents(cents + taxCents(cents, settings.taxRateBp), settings.currency);

  return (
    <div className="max-w-5xl">
      <Link href="/admin/memberships" className="text-sm text-accent-300 hover:underline">← Memberships</Link>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold text-white">{plan.name}</h1>
        <StatusBadge status={membership.status} />
        {membership.cancelAtPeriodEnd && <span className="text-sm text-amber-300">Cancelled — ends {day(membership.currentPeriodEnd)}</span>}
      </div>
      <p className="mt-1 text-sm text-ink-300">
        <Link href={`/admin/customers/${customer.id}`} className="text-accent-300 hover:underline">
          {customer.firstName} {customer.lastName}
        </Link>{" "}
        · {[vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(" ")}
        {vehicle.licencePlate && <span className="font-mono"> · {vehicle.licencePlate}</span>}
      </p>

      <div className="mt-6 grid gap-4 sm:grid-cols-4">
        <Metric label="Monthly" value={`${withTax(membership.priceCents)} incl. tax`} />
        <Metric label="Paid through" value={day(membership.currentPeriodEnd)} />
        <Metric label="Card on file" value={membership.cardLabel ?? "None"} />
        <Metric
          label="This month"
          value={
            entitlements.membership?.periodId
              ? entitlements.membership.included.map((b) => `${MEMBERSHIP_BENEFITS[b].label}: ${entitlements.membership!.available.includes(b) ? "available" : "used"}`).join(" · ")
              : "Benefits paused"
          }
        />
      </div>
      {membership.status === "past_due" && (
        <p className="mt-4 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          The last charge failed {membership.failedAttempts} time{membership.failedAttempts === 1 ? "" : "s"}. Next automatic try: {day(membership.nextAttemptAt)}.
        </p>
      )}
      {nextPlan && (
        <p className="mt-4 rounded-lg border border-sky-500/30 bg-sky-500/10 px-3 py-2 text-sm text-sky-300">
          Moving to {nextPlan.name} from {day(membership.nextPlanFrom)}.{" "}
          {membership.nextPlanNoticeSentAt ? `Member notified ${day(membership.nextPlanNoticeSentAt)}.` : "Notice not sent yet."}
        </p>
      )}

      {membership.status !== "canceled" && (
        <MemberActions
          membershipId={membership.id}
          status={membership.status}
          cancelAtPeriodEnd={membership.cancelAtPeriodEnd}
          plans={plans.filter((p) => p.active && p.id !== membership.planId).map((p) => ({ id: p.id, name: p.name }))}
          defaultFromISO={localDateISO(settings.timezone, 14 * 86_400_000)}
        />
      )}

      <section className="mt-8">
        <h2 className="text-lg font-semibold text-white">Billing</h2>
        <div className="mt-3 overflow-x-auto rounded-xl border border-ink-800">
          <table className="w-full text-left text-sm">
            <thead className="bg-ink-900 text-ink-400">
              <tr><th className="px-4 py-3">Month</th><th className="px-4 py-3">Plan</th><th className="px-4 py-3">Amount</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">Invoice</th></tr>
            </thead>
            <tbody>
              {periods.map((period) => {
                const invoice = period.invoiceId ? invoiceById.get(period.invoiceId) : undefined;
                return (
                  <tr key={period.id} className="border-t border-ink-800">
                    <td className="px-4 py-3 text-ink-200">{day(period.periodStart)} – {day(new Date(period.periodEnd.getTime() - 1))}</td>
                    <td className="px-4 py-3 text-ink-300">{plans.find((p) => p.id === period.planId)?.name ?? "—"}</td>
                    <td className="px-4 py-3 text-ink-300">{invoice ? formatCents(invoice.totalCents, settings.currency) : formatCents(period.amountCents, settings.currency)}</td>
                    <td className="px-4 py-3">
                      <StatusBadge status={period.status} />
                      {period.lastError && period.status !== "paid" && <span className="block text-xs text-red-300">{period.lastError}</span>}
                    </td>
                    <td className="px-4 py-3">
                      {invoice && <Link href={`/admin/invoices/${invoice.id}`} className="text-accent-300 hover:underline">INV-{invoice.number}</Link>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mt-8">
        <h2 className="text-lg font-semibold text-white">Benefits used</h2>
        <ul className="mt-3 space-y-2 text-sm">
          {redemptions.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-ink-800 px-4 py-3">
              <span className="text-ink-200">{isBenefit(r.benefit) ? MEMBERSHIP_BENEFITS[r.benefit].label : r.benefit}</span>
              <span className="text-ink-400">
                {day(r.redeemedAt)}
                {r.appointmentId && <Link href={`/admin/appointments/${r.appointmentId}`} className="ml-3 text-accent-300 hover:underline">Appointment</Link>}
                {r.voidedAt && <span className="ml-3 text-amber-300">Voided — {r.voidReason}</span>}
              </span>
            </li>
          ))}
          {redemptions.length === 0 && <li className="text-ink-500">None yet.</li>}
        </ul>
      </section>
      <p className="mt-8 text-xs text-ink-500">
        Joined {day(membership.createdAt)} · terms {membership.termsVersion || "—"} · charges authorized {day(membership.authorizedAt)}
        {membership.cancelReason && <> · {membership.cancelReason}</>}
      </p>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-ink-800 p-4">
      <p className="text-xs uppercase tracking-wider text-ink-500">{label}</p>
      <p className="mt-1 text-sm font-semibold text-white">{value}</p>
    </div>
  );
}
