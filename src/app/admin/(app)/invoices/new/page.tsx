import { asc, eq, isNull } from "drizzle-orm";
import { db, schema } from "@/db";
import { requirePageStaff } from "@/lib/auth/page";
import { getSettings } from "@/lib/settings";
import { NewInvoiceBuilder } from "./builder";

export const dynamic = "force-dynamic";

export default async function NewInvoicePage() {
  await requirePageStaff("manage_invoices");
  const settings = await getSettings();
  const [customers, vehicles, services] = await Promise.all([
    db()
      .select()
      .from(schema.customers)
      .where(isNull(schema.customers.anonymizedAt))
      .orderBy(asc(schema.customers.firstName), asc(schema.customers.lastName)),
    db().select().from(schema.vehicles).orderBy(asc(schema.vehicles.make)),
    // Active services are offered as line-item shortcuts. Quote-only services
    // (null price) are still listed — staff type the agreed amount.
    db().select().from(schema.services).where(eq(schema.services.active, true)).orderBy(asc(schema.services.sort)),
  ]);

  return (
    <div className="max-w-6xl">
      <h1 className="text-2xl font-bold text-white">New invoice</h1>
      <p className="mt-1 text-sm text-ink-400">
        For walk-ins and work done outside a booked job. Invoices raised from a job keep their link to
        that job — create those from the job screen instead.
      </p>
      <NewInvoiceBuilder
        customers={customers.map((c) => ({
          id: c.id,
          label:
            c.customerType === "business" && c.companyName
              ? `${c.companyName} — ${c.firstName} ${c.lastName}`
              : `${c.firstName} ${c.lastName}`,
          contact: c.email ?? c.phone ?? "No contact method",
        }))}
        vehicles={vehicles.map((v) => ({
          id: v.id,
          customerId: v.customerId,
          label: [v.year, v.make, v.model, v.licencePlate && `(${v.licencePlate})`].filter(Boolean).join(" "),
        }))}
        services={services.map((s) => ({ id: s.id, name: s.name, basePriceCents: s.basePriceCents }))}
        taxRateBp={settings.taxRateBp}
        taxLabel={settings.taxLabel}
        currency={settings.currency}
        timezone={settings.timezone}
      />
    </div>
  );
}
