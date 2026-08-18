import Link from "next/link";
import { and, asc, count, eq, gte, inArray, lt, ne } from "drizzle-orm";
import { db, schema } from "@/db";
import { StatusBadge } from "@/components/admin";
import { requirePageStaff } from "@/lib/auth/page";
import { roleHas } from "@/lib/auth/permissions";
import { getBooksSnapshot, listUnconfirmedBills } from "@/lib/books";
import { getSettings } from "@/lib/settings";
import { formatCents } from "@/lib/money";
import { formatInZone, zonedToUtc } from "@/lib/tz";
import type { StaffRole } from "@/lib/types";
import { ConfirmBillsCard } from "./expenses/confirm-bills-card";

export const dynamic = "force-dynamic";

export default async function AdminDashboard() {
  const staff = await requirePageStaff("view_dashboard");
  const settings = await getSettings();
  const tz = settings.timezone;

  // Today's window in business-local time.
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const [y, m, d] = [get("year"), get("month"), get("day")];
  const dayStart = zonedToUtc(tz, y, m, d, 0, 0);
  const dayEnd = zonedToUtc(tz, y, m, d, 23, 59);

  const todaysAppointments = await db()
    .select()
    .from(schema.appointments)
    .where(
      and(
        gte(schema.appointments.startsAt, dayStart),
        lt(schema.appointments.startsAt, dayEnd),
        inArray(schema.appointments.status, ["pending", "deposit_required", "confirmed", "arrived"]),
      ),
    )
    .orderBy(asc(schema.appointments.startsAt));

  const customersById = new Map(
    todaysAppointments.length > 0
      ? (
          await db()
            .select()
            .from(schema.customers)
            .where(inArray(schema.customers.id, todaysAppointments.map((a) => a.customerId)))
        ).map((c) => [c.id, c])
      : [],
  );

  const [newLeads] = await db()
    .select({ n: count() })
    .from(schema.leads)
    .where(eq(schema.leads.status, "new"));
  const [newQuotes] = await db()
    .select({ n: count() })
    .from(schema.quoteRequests)
    .where(eq(schema.quoteRequests.status, "new"));
  const [pendingAppts] = await db()
    .select({ n: count() })
    .from(schema.appointments)
    .where(inArray(schema.appointments.status, ["pending", "deposit_required"]));
  // Anything not handed back is still in the shop — counting by exclusion also
  // covers jobs stored under a retired status.
  const [activeJobs] = await db()
    .select({ n: count() })
    .from(schema.jobs)
    .where(ne(schema.jobs.status, "completed"));

  // The money strip and the bills card are cost data — reception and
  // technicians reach this page too, and must not see either.
  const role = staff.role as StaffRole;
  const canSeeMoney = roleHas(role, "view_financial_reports");
  const canManageExpenses = roleHas(role, "manage_expenses");
  const books = canSeeMoney ? await getBooksSnapshot("month", y, m) : null;
  const billsToConfirm = canManageExpenses ? await listUnconfirmedBills(now) : [];

  const stats = [
    { label: "New leads", value: newLeads.n, href: "/admin/leads" },
    { label: "New quote requests", value: newQuotes.n, href: "/admin/leads?tab=quotes" },
    { label: "Bookings needing action", value: pendingAppts.n, href: "/admin/appointments?status=pending" },
    { label: "Vehicles in shop", value: activeJobs.n, href: "/admin/appointments" },
  ];

  return (
    <div>
      <h1 className="text-2xl font-bold text-white">Good day, {staff.name.split(" ")[0]}</h1>
      <p className="mt-1 text-sm text-ink-400">
        {formatInZone(now, tz, { weekday: "long", month: "long", day: "numeric" })}
      </p>

      <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map((s) => (
          <Link
            key={s.label}
            href={s.href}
            className="rounded-2xl border border-ink-700 bg-ink-900/50 p-5 transition-colors hover:border-accent-500/50"
          >
            <p className="text-3xl font-bold text-white">{s.value}</p>
            <p className="mt-1 text-sm text-ink-400">{s.label}</p>
          </Link>
        ))}
      </div>

      {books && (
        <section className="mt-8">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-lg font-semibold text-white">{books.period.label}</h2>
            <Link href="/admin/reports" className="text-sm text-accent-300 hover:underline">
              Full report →
            </Link>
          </div>
          <div className="mt-3 grid gap-4 sm:grid-cols-3">
            <div className="rounded-2xl border border-ink-700 bg-ink-900/50 p-5">
              <p className="text-sm text-ink-400">Net sales</p>
              <p className="mt-1 text-3xl font-bold text-white">
                {formatCents(books.pnl.netSalesCents, books.currency)}
              </p>
              <p className="mt-2 text-xs text-ink-400">Invoiced, before {settings.taxLabel}</p>
            </div>
            <div className="rounded-2xl border border-ink-700 bg-ink-900/50 p-5">
              <p className="text-sm text-ink-400">Expenses</p>
              <p className="mt-1 text-3xl font-bold text-white">
                {formatCents(books.pnl.expenses.totalCents, books.currency)}
              </p>
              <p className="mt-2 text-xs text-ink-400">
                {books.pnl.expenses.count} {books.pnl.expenses.count === 1 ? "payment" : "payments"}
              </p>
            </div>
            <div className="rounded-2xl border border-ink-700 bg-ink-900/50 p-5">
              <p className="text-sm text-ink-400">Net profit</p>
              <p
                className={`mt-1 text-3xl font-bold ${
                  books.pnl.netProfitCents < 0 ? "text-red-300" : "text-white"
                }`}
              >
                {formatCents(books.pnl.netProfitCents, books.currency)}
              </p>
              <p className="mt-2 text-xs text-ink-400">
                {books.pnl.profitMargin === null
                  ? "No sales yet this month"
                  : `${(books.pnl.profitMargin * 100).toFixed(1)}% margin`}
              </p>
            </div>
          </div>
        </section>
      )}

      {billsToConfirm.length > 0 && (
        <ConfirmBillsCard
          bills={billsToConfirm.map((bill) => ({
            id: bill.id,
            label: bill.description ?? bill.name,
            amountLabel: formatCents(bill.amountCents, settings.currency),
          }))}
        />
      )}

      <h2 className="mt-10 text-lg font-semibold text-white">Today&apos;s appointments</h2>
      {todaysAppointments.length === 0 ? (
        <p className="mt-3 text-ink-400">Nothing scheduled today.</p>
      ) : (
        <div className="mt-3 overflow-x-auto rounded-xl border border-ink-800">
          <table className="w-full text-sm">
            <thead className="bg-ink-900 text-left text-ink-400">
              <tr>
                <th className="px-4 py-3">Time</th>
                <th className="px-4 py-3">Customer</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3 text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {todaysAppointments.map((a) => {
                const cus = customersById.get(a.customerId);
                return (
                  <tr key={a.id} className="border-t border-ink-800 hover:bg-ink-900/40">
                    <td className="px-4 py-3 text-white">
                      {formatInZone(a.startsAt, tz, { hour: "numeric", minute: "2-digit" })}
                    </td>
                    <td className="px-4 py-3">
                      <Link href={`/admin/appointments/${a.id}`} className="text-accent-300 hover:underline">
                        {cus ? `${cus.firstName} ${cus.lastName}` : a.customerId}
                      </Link>
                    </td>
                    <td className="px-4 py-3"><StatusBadge status={a.status} /></td>
                    <td className="px-4 py-3 text-right text-ink-200">{formatCents(a.totalCents)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
