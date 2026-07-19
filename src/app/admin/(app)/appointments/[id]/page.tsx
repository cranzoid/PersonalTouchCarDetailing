import Link from "next/link";
import { notFound } from "next/navigation";
import { asc, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { StatusBadge } from "@/components/admin";
import { formatCents } from "@/lib/money";
import { formatInZone } from "@/lib/tz";
import { getSettings } from "@/lib/settings";
import { TransitionButtons } from "./transition-buttons";

export const dynamic = "force-dynamic";

export default async function AppointmentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const settings = await getSettings();

  const rows = await db().select().from(schema.appointments).where(eq(schema.appointments.id, id)).limit(1);
  const appt = rows[0];
  if (!appt) notFound();

  const [customer] = await db().select().from(schema.customers).where(eq(schema.customers.id, appt.customerId)).limit(1);
  const [vehicle] = await db().select().from(schema.vehicles).where(eq(schema.vehicles.id, appt.vehicleId)).limit(1);
  const lines = await db()
    .select()
    .from(schema.appointmentServices)
    .where(eq(schema.appointmentServices.appointmentId, id))
    .orderBy(asc(schema.appointmentServices.sort));
  const resource = appt.resourceId
    ? (await db().select().from(schema.resources).where(eq(schema.resources.id, appt.resourceId)).limit(1))[0]
    : null;

  const attr = appt.attribution as Record<string, unknown> | null;

  return (
    <div className="max-w-3xl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="font-mono text-xs text-ink-500">{appt.id}</p>
          <h1 className="text-2xl font-bold text-white">
            {formatInZone(appt.startsAt, settings.timezone, {
              weekday: "long",
              month: "long",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
            })}
          </h1>
          <p className="mt-1 text-sm text-ink-400">
            Until {formatInZone(appt.endsAt, settings.timezone, { hour: "numeric", minute: "2-digit" })}
            {resource ? ` · ${resource.name}` : ""} · {appt.durationMin} min work
          </p>
        </div>
        <StatusBadge status={appt.status} />
      </div>

      <TransitionButtons appointmentId={appt.id} status={appt.status} />

      <div className="mt-8 grid gap-6 sm:grid-cols-2">
        <section className="rounded-xl border border-ink-800 p-5">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-400">Customer</h2>
          {customer ? (
            <div className="mt-2 text-sm">
              <Link href={`/admin/customers/${customer.id}`} className="font-medium text-accent-300 hover:underline">
                {customer.firstName} {customer.lastName}
              </Link>
              {customer.email && <p className="text-ink-300">{customer.email}</p>}
              {customer.phone && <p className="text-ink-300">{customer.phone}</p>}
            </div>
          ) : (
            <p className="mt-2 text-sm text-ink-500">Missing customer record</p>
          )}
        </section>
        <section className="rounded-xl border border-ink-800 p-5">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-400">Vehicle</h2>
          {vehicle ? (
            <p className="mt-2 text-sm text-ink-300">
              {vehicle.year ?? ""} {vehicle.make} {vehicle.model}
              {vehicle.colour ? ` · ${vehicle.colour}` : ""} · {vehicle.category}
            </p>
          ) : (
            <p className="mt-2 text-sm text-ink-500">Missing vehicle record</p>
          )}
        </section>
      </div>

      <section className="mt-6 rounded-xl border border-ink-800 p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-400">Services</h2>
        <table className="mt-3 w-full text-sm">
          <tbody>
            {lines.map((l) => (
              <tr key={l.id} className="border-t border-ink-800/60 first:border-0">
                <td className="py-2 text-ink-200">{l.description}</td>
                <td className="py-2 text-right text-ink-400">{l.durationMin} min</td>
                <td className="py-2 text-right text-ink-200">{formatCents(l.priceCents)}</td>
              </tr>
            ))}
            <tr className="border-t border-ink-700">
              <td className="py-2 text-ink-400">Subtotal</td>
              <td />
              <td className="py-2 text-right text-ink-200">{formatCents(appt.subtotalCents)}</td>
            </tr>
            <tr>
              <td className="py-1 text-ink-400">Tax ({(appt.taxRateBp / 100).toFixed(2)}%)</td>
              <td />
              <td className="py-1 text-right text-ink-200">{formatCents(appt.taxCents)}</td>
            </tr>
            <tr>
              <td className="py-2 font-semibold text-white">Total</td>
              <td />
              <td className="py-2 text-right font-semibold text-accent-300">{formatCents(appt.totalCents)}</td>
            </tr>
          </tbody>
        </table>
        {appt.depositRequiredCents > 0 && (
          <p className="mt-2 text-sm text-amber-300">
            Deposit required: {formatCents(appt.depositRequiredCents)} (paid:{" "}
            {formatCents(appt.depositPaidCents)})
          </p>
        )}
      </section>

      {appt.customerNotes && (
        <section className="mt-6 rounded-xl border border-ink-800 p-5">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-400">Customer notes</h2>
          <p className="mt-2 whitespace-pre-wrap text-sm text-ink-300">{appt.customerNotes}</p>
        </section>
      )}

      {appt.cancellationReason && (
        <section className="mt-6 rounded-xl border border-red-900/50 p-5">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-red-400">Cancellation</h2>
          <p className="mt-2 text-sm text-ink-300">{appt.cancellationReason}</p>
        </section>
      )}

      {attr && Object.keys(attr).length > 0 && (
        <section className="mt-6 rounded-xl border border-ink-800 p-5">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-400">Marketing attribution</h2>
          <dl className="mt-2 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
            {Object.entries(attr)
              .filter(([, v]) => typeof v === "string" && v)
              .map(([k, v]) => (
                <div key={k} className="flex justify-between gap-4">
                  <dt className="text-ink-500">{k}</dt>
                  <dd className="truncate text-ink-300">{String(v)}</dd>
                </div>
              ))}
          </dl>
        </section>
      )}
    </div>
  );
}
