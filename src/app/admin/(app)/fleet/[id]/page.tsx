import Link from "next/link";
import { notFound } from "next/navigation";
import { desc, eq } from "drizzle-orm";
import { StatusBadge } from "@/components/admin";
import { db, schema } from "@/db";
import { roleHas } from "@/lib/auth/permissions";
import { getStaff } from "@/lib/auth/session";
import { formatCents } from "@/lib/money";
import { getSettings } from "@/lib/settings";
import { formatInZone } from "@/lib/tz";
import { CustomerActionPanels } from "../../customers/[id]/customer-actions";
import { ConsolidatedInvoiceBuilder } from "../consolidated-invoice-builder";

export const dynamic = "force-dynamic";

export default async function FleetDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const staff = await getStaff();
  if (!staff || !roleHas(staff.role, "manage_customers")) notFound();
  const { id } = await params;
  const settings = await getSettings();
  const [customer] = await db().select().from(schema.customers).where(eq(schema.customers.id, id)).limit(1);
  if (!customer || customer.customerType !== "business") notFound();

  const [vehicles, jobs, invoices, appointments] = await Promise.all([
    db().select().from(schema.vehicles).where(eq(schema.vehicles.customerId, id)).orderBy(desc(schema.vehicles.createdAt)),
    db().select().from(schema.jobs).where(eq(schema.jobs.customerId, id)).orderBy(desc(schema.jobs.createdAt)).limit(100),
    db().select().from(schema.invoices).where(eq(schema.invoices.customerId, id)).orderBy(desc(schema.invoices.createdAt)).limit(100),
    db().select().from(schema.appointments).where(eq(schema.appointments.customerId, id)).orderBy(desc(schema.appointments.startsAt)).limit(20),
  ]);
  const vehiclesById = new Map(vehicles.map((vehicle) => [vehicle.id, vehicle]));
  const eligibleJobs = jobs.filter((job) => !job.invoiceId && ["ready_for_pickup", "completed"].includes(job.status)).map((job) => {
    const vehicle = vehiclesById.get(job.vehicleId);
    return {
      id: job.id,
      status: job.status,
      vehicleLabel: vehicle ? [vehicle.year, vehicle.make, vehicle.model, vehicle.licencePlate && `(${vehicle.licencePlate})`].filter(Boolean).join(" ") : job.vehicleId,
      completedLabel: job.completedAt ? formatInZone(job.completedAt, settings.timezone, { month: "short", day: "numeric", year: "numeric" }) : "Not completed",
    };
  });

  return (
    <div className="max-w-5xl">
      <Link href="/admin/fleet" className="text-sm text-accent-300 hover:underline">← Fleet accounts</Link>
      <p className="mt-4 font-mono text-xs text-ink-500">{customer.id}</p>
      <h1 className="text-2xl font-bold text-white">{customer.companyName ?? `${customer.firstName} ${customer.lastName}`}</h1>
      <p className="mt-1 text-sm text-ink-300">Contact: {customer.firstName} {customer.lastName} · {customer.email ?? customer.phone ?? "No contact method"}</p>

      <div className="mt-6 grid gap-4 sm:grid-cols-4">
        <Metric label="Vehicles" value={String(vehicles.length)} />
        <Metric label="Jobs" value={String(jobs.length)} />
        <Metric label="Invoices" value={String(invoices.length)} />
        <Metric label="Invoiced value" value={formatCents(invoices.filter((invoice) => invoice.status !== "cancelled").reduce((sum, invoice) => sum + invoice.totalCents, 0), settings.currency)} />
      </div>

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
        <h2 className="text-lg font-semibold text-white">Fleet vehicles ({vehicles.length})</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {vehicles.map((vehicle) => (
            <div key={vehicle.id} className="rounded-xl border border-ink-800 p-4 text-sm">
              <p className="font-medium text-white">{[vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(" ")}</p>
              <p className="mt-1 capitalize text-ink-400">{vehicle.category.replaceAll("_", " ")}{vehicle.colour ? ` · ${vehicle.colour}` : ""}</p>
              {vehicle.licencePlate && <p className="mt-1 font-mono text-xs text-ink-500">{vehicle.licencePlate}</p>}
            </div>
          ))}
          {vehicles.length === 0 && <p className="text-sm text-ink-500">No fleet vehicles yet.</p>}
        </div>
      </section>

      {roleHas(staff.role, "manage_invoices") && <ConsolidatedInvoiceBuilder customerId={customer.id} jobs={eligibleJobs} />}

      <section className="mt-8">
        <h2 className="text-lg font-semibold text-white">Invoices ({invoices.length})</h2>
        <div className="mt-3 space-y-2">
          {invoices.map((invoice) => (
            <Link key={invoice.id} href={`/admin/invoices/${invoice.id}`} className="flex items-center justify-between rounded-xl border border-ink-800 p-4 text-sm hover:border-accent-500/50">
              <span className="font-medium text-white">INV-{invoice.number}</span>
              <span className="flex items-center gap-3"><span className="text-ink-300">{formatCents(invoice.totalCents, settings.currency)}</span><StatusBadge status={invoice.status} /></span>
            </Link>
          ))}
          {invoices.length === 0 && <p className="text-sm text-ink-500">No invoices yet.</p>}
        </div>
      </section>

      <section className="mt-8">
        <h2 className="text-lg font-semibold text-white">Recent appointments ({appointments.length})</h2>
        <div className="mt-3 space-y-2">
          {appointments.map((appointment) => (
            <Link key={appointment.id} href={`/admin/appointments/${appointment.id}`} className="flex items-center justify-between rounded-xl border border-ink-800 p-4 text-sm hover:border-accent-500/50">
              <span className="text-white">{formatInZone(appointment.startsAt, settings.timezone, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })}</span>
              <StatusBadge status={appointment.status} />
            </Link>
          ))}
          {appointments.length === 0 && <p className="text-sm text-ink-500">No appointments yet.</p>}
        </div>
      </section>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-xl border border-ink-800 p-4"><p className="text-xs uppercase tracking-wider text-ink-500">{label}</p><p className="mt-1 text-lg font-semibold text-white">{value}</p></div>;
}
