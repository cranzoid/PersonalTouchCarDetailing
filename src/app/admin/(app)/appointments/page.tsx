import Link from "next/link";
import { desc, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import { StatusBadge } from "@/components/admin";
import { formatCents } from "@/lib/money";
import { formatInZone } from "@/lib/tz";
import { getSettings } from "@/lib/settings";
import { requirePageStaff } from "@/lib/auth/page";

export const dynamic = "force-dynamic";

const FILTERS = ["all", "pending", "confirmed", "arrived", "cancelled", "completed"] as const;

export default async function AppointmentsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  await requirePageStaff("manage_bookings");
  const { status } = await searchParams;
  const settings = await getSettings();
  const filter = FILTERS.includes((status ?? "all") as (typeof FILTERS)[number])
    ? (status ?? "all")
    : "all";

  const base = db().select().from(schema.appointments);
  const appts = await (filter === "all"
    ? base
    : filter === "pending"
      ? base.where(inArray(schema.appointments.status, ["pending", "deposit_required"]))
      : base.where(eq(schema.appointments.status, filter))
  )
    .orderBy(desc(schema.appointments.startsAt))
    .limit(100);

  const customers =
    appts.length > 0
      ? await db()
          .select()
          .from(schema.customers)
          .where(inArray(schema.customers.id, [...new Set(appts.map((a) => a.customerId))]))
      : [];
  const customerById = new Map(customers.map((c) => [c.id, c]));

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-white">Appointments</h1>
        <Link href="/admin/appointments/new" className="rounded-lg bg-accent-400 px-4 py-2 text-sm font-semibold text-ink-950">New appointment</Link>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <Link
            key={f}
            href={f === "all" ? "/admin/appointments" : `/admin/appointments?status=${f}`}
            className={`rounded-full px-4 py-1.5 text-sm capitalize ${
              filter === f ? "bg-accent-400 font-semibold text-ink-950" : "bg-ink-800 text-ink-300"
            }`}
          >
            {f}
          </Link>
        ))}
      </div>
      <div className="mt-6 overflow-x-auto rounded-xl border border-ink-800">
        <table className="w-full text-sm">
          <thead className="bg-ink-900 text-left text-ink-400">
            <tr>
              <th className="px-4 py-3">When</th>
              <th className="px-4 py-3">Customer</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3 text-right">Total</th>
            </tr>
          </thead>
          <tbody>
            {appts.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-ink-500">
                  No appointments found.
                </td>
              </tr>
            )}
            {appts.map((a) => {
              const cus = customerById.get(a.customerId);
              return (
                <tr key={a.id} className="border-t border-ink-800 hover:bg-ink-900/40">
                  <td className="px-4 py-3 text-white">
                    {formatInZone(a.startsAt, settings.timezone, {
                      month: "short",
                      day: "numeric",
                      hour: "numeric",
                      minute: "2-digit",
                    })}
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
    </div>
  );
}
