import Link from "next/link";
import { notFound } from "next/navigation";
import { desc, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { StatusBadge } from "@/components/admin";
import { formatCents } from "@/lib/money";
import { formatInZone } from "@/lib/tz";
import { getSettings } from "@/lib/settings";
import { CustomerActionPanels } from "./customer-actions";
import { requirePageStaff } from "@/lib/auth/page";
import { summarizeRevenue } from "@/lib/reporting";

export const dynamic = "force-dynamic";

export default async function CustomerDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePageStaff("manage_customers");
  const { id } = await params;
  const settings = await getSettings();
  const rows = await db().select().from(schema.customers).where(eq(schema.customers.id, id)).limit(1);
  const customer = rows[0];
  if (!customer) notFound();

  const vehicles = await db().select().from(schema.vehicles).where(eq(schema.vehicles.customerId, id));
  const appointments = await db()
    .select()
    .from(schema.appointments)
    .where(eq(schema.appointments.customerId, id))
    .orderBy(desc(schema.appointments.startsAt))
    .limit(50);
  const comms = await db()
    .select()
    .from(schema.communications)
    .where(eq(schema.communications.customerId, id))
    .orderBy(desc(schema.communications.createdAt))
    .limit(50);
  const paymentRows = await db().select().from(schema.payments).where(eq(schema.payments.customerId, id));
  const lifetimeRevenue = summarizeRevenue(paymentRows);

  return (
    <div className="max-w-3xl">
      <p className="font-mono text-xs text-ink-500">{customer.id}</p>
      <h1 className="text-2xl font-bold text-white">
        {customer.customerType === "business" && customer.companyName ? customer.companyName : `${customer.firstName} ${customer.lastName}`}
      </h1>
      {customer.customerType === "business" && (
        <p className="mt-1 text-sm text-ink-300">
          Fleet contact: {customer.firstName} {customer.lastName} · <Link href={`/admin/fleet/${customer.id}`} className="text-accent-300 hover:underline">Open fleet workspace →</Link>
        </p>
      )}
      <div className="mt-1 flex flex-wrap gap-4 text-sm text-ink-300">
        {customer.email && <span>{customer.email}</span>}
        {customer.phone && <span>{customer.phone}</span>}
        <span className="capitalize text-ink-500">prefers {customer.preferredContact}</span>
        <span className={customer.marketingConsent ? "text-emerald-300" : "text-ink-500"}>
          {customer.marketingConsent ? "Marketing consent ✓" : "No marketing consent"}
        </span>
      </div>
      <p className="mt-2 text-sm text-ink-400">
        Net revenue received: <span className="text-accent-300">{formatCents(lifetimeRevenue.netCents)}</span>
      </p>

      <CustomerActionPanels customer={{
        id: customer.id,
        firstName: customer.firstName,
        lastName: customer.lastName,
        email: customer.email,
        phone: customer.phone,
        preferredContact: customer.preferredContact,
        customerType: customer.customerType,
        companyName: customer.companyName,
        tags: customer.tags,
        notes: customer.notes,
        marketingConsent: customer.marketingConsent,
        anonymizedAt: customer.anonymizedAt?.toISOString() ?? null,
      }} />

      <section className="mt-8">
        <h2 className="text-lg font-semibold text-white">Vehicles ({vehicles.length})</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {vehicles.map((v) => (
            <div key={v.id} className="rounded-xl border border-ink-800 p-4 text-sm">
              <p className="font-medium text-white">
                {v.year ?? ""} {v.make} {v.model}
              </p>
              <p className="mt-1 text-ink-400 capitalize">
                {v.category}
                {v.colour ? ` · ${v.colour}` : ""}
                {v.licencePlate ? ` · ${v.licencePlate}` : ""}
              </p>
              {v.conditionNotes && <p className="mt-1 text-xs text-ink-500">{v.conditionNotes}</p>}
            </div>
          ))}
          {vehicles.length === 0 && <p className="text-sm text-ink-500">No vehicles on file.</p>}
        </div>
      </section>

      <section className="mt-8">
        <h2 className="text-lg font-semibold text-white">Appointments ({appointments.length})</h2>
        <div className="mt-3 space-y-2">
          {appointments.map((a) => (
            <Link
              key={a.id}
              href={`/admin/appointments/${a.id}`}
              className="flex items-center justify-between rounded-xl border border-ink-800 p-4 text-sm hover:border-accent-500/50"
            >
              <span className="text-white">
                {formatInZone(a.startsAt, settings.timezone, {
                  year: "numeric",
                  month: "short",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                })}
              </span>
              <span className="flex items-center gap-3">
                <span className="text-ink-300">{formatCents(a.totalCents)}</span>
                <StatusBadge status={a.status} />
              </span>
            </Link>
          ))}
          {appointments.length === 0 && <p className="text-sm text-ink-500">No appointments yet.</p>}
        </div>
      </section>

      <section className="mt-8">
        <h2 className="text-lg font-semibold text-white">Communication history ({comms.length})</h2>
        <div className="mt-3 space-y-2">
          {comms.map((c) => (
            <div key={c.id} className="rounded-xl border border-ink-800 p-4 text-sm">
              <div className="flex flex-wrap justify-between gap-2 text-xs text-ink-500">
                <span className="capitalize">
                  {c.channel} · {c.kind.replaceAll("_", " ")} · {c.status}
                </span>
                <span>{c.createdAt.toISOString().replace("T", " ").slice(0, 16)}</span>
              </div>
              {c.subject && <p className="mt-1 font-medium text-ink-200">{c.subject}</p>}
              <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-ink-400">{c.body}</p>
            </div>
          ))}
          {comms.length === 0 && <p className="text-sm text-ink-500">No messages logged.</p>}
        </div>
      </section>
    </div>
  );
}
