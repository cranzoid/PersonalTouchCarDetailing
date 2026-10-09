import Link from "next/link";
import { and, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { StatusBadge } from "@/components/admin";
import { db, schema } from "@/db";
import { requirePageStaff } from "@/lib/auth/page";
import { lastBillingRunAt } from "@/lib/memberships/billing";
import { formatCents, taxCents } from "@/lib/money";
import { getSettings } from "@/lib/settings";
import { formatInZone } from "@/lib/tz";

export const dynamic = "force-dynamic";

const TABS = ["members", "passes"] as const;
const STATUS_FILTERS = ["live", "active", "past_due", "canceling", "canceled", "pending"] as const;

export default async function MembershipsPage({ searchParams }: { searchParams: Promise<{ tab?: string; status?: string }> }) {
  await requirePageStaff("manage_memberships");
  const query = await searchParams;
  const tab = TABS.includes(query.tab as (typeof TABS)[number]) ? (query.tab as (typeof TABS)[number]) : "members";
  const filter = STATUS_FILTERS.includes(query.status as (typeof STATUS_FILTERS)[number]) ? (query.status as (typeof STATUS_FILTERS)[number]) : "live";
  const settings = await getSettings();
  const day = (d: Date | null) => (d ? formatInZone(d, settings.timezone, { month: "short", day: "numeric", year: "numeric" }) : "—");
  const withTax = (cents: number) => formatCents(cents + taxCents(cents, settings.taxRateBp), settings.currency);

  const [lastRun, counts] = await Promise.all([
    lastBillingRunAt(),
    db()
      .select({ status: schema.memberships.status, n: count() })
      .from(schema.memberships)
      .groupBy(schema.memberships.status),
  ]);
  const byStatus = new Map(counts.map((c) => [c.status, Number(c.n)]));
  const liveCount = (byStatus.get("active") ?? 0) + (byStatus.get("past_due") ?? 0);
  const billingStale = liveCount > 0 && (!lastRun || Date.now() - lastRun.getTime() > 3 * 3_600_000);
  const monthlyRevenue = await db()
    .select({ total: sql<number>`coalesce(sum(${schema.memberships.priceCents}), 0)` })
    .from(schema.memberships)
    .where(and(eq(schema.memberships.status, "active"), eq(schema.memberships.cancelAtPeriodEnd, false)));

  const where =
    filter === "live"
      ? inArray(schema.memberships.status, ["active", "past_due"])
      : filter === "canceling"
        ? and(eq(schema.memberships.status, "active"), eq(schema.memberships.cancelAtPeriodEnd, true))
        : eq(schema.memberships.status, filter);
  const members =
    tab === "members"
      ? await db()
          .select({ membership: schema.memberships, plan: schema.membershipPlans, customer: schema.customers, vehicle: schema.vehicles })
          .from(schema.memberships)
          .innerJoin(schema.membershipPlans, eq(schema.membershipPlans.id, schema.memberships.planId))
          .innerJoin(schema.customers, eq(schema.customers.id, schema.memberships.customerId))
          .innerJoin(schema.vehicles, eq(schema.vehicles.id, schema.memberships.vehicleId))
          .where(where)
          .orderBy(desc(schema.memberships.createdAt))
          .limit(300)
      : [];
  const passes =
    tab === "passes"
      ? await db()
          .select({
            pass: schema.winterPasses,
            customer: schema.customers,
            vehicle: schema.vehicles,
            used: sql<number>`(select count(*) from ${schema.winterPassRedemptions} r where r.pass_id = ${schema.winterPasses.id} and r.voided_at is null)`,
          })
          .from(schema.winterPasses)
          .innerJoin(schema.customers, eq(schema.customers.id, schema.winterPasses.customerId))
          .innerJoin(schema.vehicles, eq(schema.vehicles.id, schema.winterPasses.vehicleId))
          .where(inArray(schema.winterPasses.status, ["active", "pending_payment"]))
          .orderBy(desc(schema.winterPasses.createdAt))
          .limit(300)
      : [];
  const openCheckouts = await db()
    .select({ n: count() })
    .from(schema.paymentCheckouts)
    .where(and(eq(schema.paymentCheckouts.status, "open"), isNull(schema.paymentCheckouts.completedAt)));

  const pill = (active: boolean) =>
    `rounded-full border px-3 py-1.5 text-xs font-medium ${active ? "border-accent-400 bg-accent-400 text-ink-950" : "border-ink-700 text-ink-300 hover:border-ink-500"}`;

  return (
    <div className="max-w-6xl">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white">Memberships</h1>
          <p className="mt-1 text-sm text-ink-400">Winter Shield members, Winter Passes and monthly billing.</p>
        </div>
        <Link href="/admin/memberships/settings" className="text-sm text-accent-300 hover:underline">Plans &amp; settings →</Link>
      </div>

      <div className="mt-6 grid gap-4 sm:grid-cols-4">
        <Metric label="Live members" value={String(liveCount)} />
        <Metric label="Past due" value={String(byStatus.get("past_due") ?? 0)} tone={(byStatus.get("past_due") ?? 0) > 0 ? "warn" : undefined} />
        <Metric label="Monthly billing (incl. tax)" value={withTax(Number(monthlyRevenue[0]?.total ?? 0))} />
        <Metric
          label="Last billing run"
          value={lastRun ? formatInZone(lastRun, settings.timezone, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "Never"}
          tone={billingStale ? "warn" : undefined}
        />
      </div>
      {billingStale && (
        <p className="mt-4 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          Membership billing has not run in over three hours. The hourly scheduler may be down — renewals will catch up when it
          runs again, but check it now.
        </p>
      )}
      {Number(openCheckouts[0]?.n ?? 0) > 0 && (
        <p className="mt-3 text-xs text-ink-500">
          {openCheckouts[0].n} card payment{Number(openCheckouts[0].n) === 1 ? "" : "s"} in progress or awaiting confirmation from Helcim.
        </p>
      )}

      <div className="mt-6 flex flex-wrap gap-2">
        <Link href="/admin/memberships?tab=members" className={pill(tab === "members")}>Members</Link>
        <Link href="/admin/memberships?tab=passes" className={pill(tab === "passes")}>Winter Passes</Link>
      </div>

      {tab === "members" && (
        <>
          <div className="mt-4 flex flex-wrap gap-2 text-xs">
            {STATUS_FILTERS.map((status) => (
              <Link key={status} href={`/admin/memberships?tab=members&status=${status}`} className={pill(filter === status)}>
                {status === "live" ? "Active + past due" : status === "canceling" ? "Cancelling" : status.replaceAll("_", " ")}
              </Link>
            ))}
          </div>
          <div className="mt-4 overflow-x-auto rounded-xl border border-ink-800">
            <table className="w-full text-left text-sm">
              <thead className="bg-ink-900 text-ink-400">
                <tr>
                  <th className="px-4 py-3">Member</th>
                  <th className="px-4 py-3">Car</th>
                  <th className="px-4 py-3">Plan</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Next billing</th>
                  <th className="px-4 py-3">Card</th>
                </tr>
              </thead>
              <tbody>
                {members.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-4 py-8 text-center text-ink-500">No memberships here.</td>
                  </tr>
                )}
                {members.map(({ membership, plan, customer, vehicle }) => (
                  <tr key={membership.id} className="border-t border-ink-800">
                    <td className="px-4 py-3">
                      <Link href={`/admin/memberships/${membership.id}`} className="font-medium text-accent-300 hover:underline">
                        {customer.firstName} {customer.lastName}
                      </Link>
                      <p className="text-xs text-ink-500">{customer.email ?? customer.phone}</p>
                    </td>
                    <td className="px-4 py-3 text-ink-300">
                      {[vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(" ")}
                      {vehicle.licencePlate && <span className="block font-mono text-xs text-ink-500">{vehicle.licencePlate}</span>}
                    </td>
                    <td className="px-4 py-3 text-ink-300">{plan.name}</td>
                    <td className="px-4 py-3">
                      <StatusBadge status={membership.status} />
                      {membership.cancelAtPeriodEnd && <span className="ml-2 text-xs text-amber-300">ends {day(membership.currentPeriodEnd)}</span>}
                    </td>
                    <td className="px-4 py-3 text-ink-300">
                      {membership.status === "past_due" ? `Retry ${day(membership.nextAttemptAt)}` : membership.cancelAtPeriodEnd ? "—" : day(membership.currentPeriodEnd)}
                    </td>
                    <td className="px-4 py-3 text-ink-400">{membership.cardLabel ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {tab === "passes" && (
        <div className="mt-4 overflow-x-auto rounded-xl border border-ink-800">
          <table className="w-full text-left text-sm">
            <thead className="bg-ink-900 text-ink-400">
              <tr>
                <th className="px-4 py-3">Customer</th>
                <th className="px-4 py-3">Car</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Washes used</th>
                <th className="px-4 py-3">Valid until</th>
                <th className="px-4 py-3">Invoice</th>
              </tr>
            </thead>
            <tbody>
              {passes.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-ink-500">No Winter Passes yet.</td>
                </tr>
              )}
              {passes.map(({ pass, customer, vehicle, used }) => (
                <tr key={pass.id} className="border-t border-ink-800">
                  <td className="px-4 py-3">
                    <Link href={`/admin/customers/${customer.id}`} className="text-accent-300 hover:underline">
                      {customer.firstName} {customer.lastName}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-ink-300">{[vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(" ")}</td>
                  <td className="px-4 py-3"><StatusBadge status={pass.status} /></td>
                  <td className="px-4 py-3 text-ink-300">{Number(used)} / {pass.washesTotal}</td>
                  <td className="px-4 py-3 text-ink-300">{day(pass.validUntil)}</td>
                  <td className="px-4 py-3">
                    {pass.saleInvoiceId && (
                      <Link href={`/admin/invoices/${pass.saleInvoiceId}`} className="text-accent-300 hover:underline">View</Link>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: "warn" }) {
  return (
    <div className={`rounded-xl border p-4 ${tone === "warn" ? "border-red-500/40" : "border-ink-800"}`}>
      <p className="text-xs uppercase tracking-wider text-ink-500">{label}</p>
      <p className={`mt-1 text-lg font-semibold ${tone === "warn" ? "text-red-300" : "text-white"}`}>{value}</p>
    </div>
  );
}
