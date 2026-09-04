import { asc, isNull } from "drizzle-orm";
import { db, schema } from "@/db";
import { requirePageStaff } from "@/lib/auth/page";
import { compareLabels } from "@/lib/option-search";
import { getSettings } from "@/lib/settings";
import { NewInvoiceBuilder } from "./builder";

export const dynamic = "force-dynamic";

export default async function NewInvoicePage({
  searchParams,
}: {
  searchParams: Promise<{ customerId?: string; vehicleId?: string }>;
}) {
  await requirePageStaff("manage_invoices");
  // Set when staff came back from adding the customer mid-invoice. Read on the
  // server so the client never needs a Suspense boundary for useSearchParams.
  const { customerId, vehicleId } = await searchParams;
  const settings = await getSettings();
  const [customers, vehicles, categories, services, adjustments, addonLinks, addons, addonAdjustments] =
    await Promise.all([
    db()
      .select()
      .from(schema.customers)
      .where(isNull(schema.customers.anonymizedAt))
      .orderBy(asc(schema.customers.firstName), asc(schema.customers.lastName)),
    db()
      .select()
      .from(schema.vehicles)
      .orderBy(asc(schema.vehicles.make), asc(schema.vehicles.model), asc(schema.vehicles.year)),
    db().select().from(schema.serviceCategories).orderBy(asc(schema.serviceCategories.sort)),
    // Inactive services are still offered here: an invoice records work that
    // has already happened, which may pre-date a service being retired.
    db().select().from(schema.services).orderBy(asc(schema.services.sort)),
    db().select().from(schema.serviceVehicleAdjustments),
    db().select().from(schema.serviceAddons),
    db().select().from(schema.addons).orderBy(asc(schema.addons.sort)),
    db().select().from(schema.addonVehicleAdjustments),
  ]);

  const categoryNames = new Map(categories.map((c) => [c.id, c.name]));

  // Ordered on the finished label rather than in SQL: a business is listed as
  // "Company — First Last", so ordering by `first_name` put every fleet account
  // at a position nothing on screen explained.
  const customerOptions = customers
    .map((c) => ({
      id: c.id,
      label:
        c.customerType === "business" && c.companyName
          ? `${c.companyName} — ${c.firstName} ${c.lastName}`
          : `${c.firstName} ${c.lastName}`,
      contact: c.email ?? c.phone ?? "No contact method",
      // Both contact details are searchable even though only one is shown, and
      // the normalized phone means the number is found however it was typed —
      // the same rule the customer list search uses.
      searchText: [c.companyName, c.email, c.phone, c.phoneNormalized].filter(Boolean).join(" "),
    }))
    .sort((a, b) => compareLabels(a.label, b.label));

  // Same reason, for vehicles: Postgres orders by byte, which files "CR-V"
  // before "Civic" and reads as no order at all next to the customer list.
  const orderedVehicles = [...vehicles].sort(
    (a, b) =>
      compareLabels(a.make, b.make) ||
      compareLabels(a.model, b.model) ||
      (a.year ?? 0) - (b.year ?? 0),
  );

  return (
    <div className="max-w-6xl">
      <h1 className="text-2xl font-bold text-white">New invoice</h1>
      <p className="mt-1 text-sm text-ink-400">
        For walk-ins and work done outside a booked job. Invoices raised from a job keep their link to
        that job — create those from the job screen instead.
      </p>
      <NewInvoiceBuilder
        customers={customerOptions}
        vehicles={orderedVehicles.map((v) => ({
          id: v.id,
          customerId: v.customerId,
          category: v.category,
          label: [v.year, v.make, v.model, v.licencePlate && `(${v.licencePlate})`].filter(Boolean).join(" "),
          searchText: [v.trim, v.colour].filter(Boolean).join(" "),
        }))}
        services={services.map((s) => ({
          id: s.id,
          name: s.name,
          categoryName: categoryNames.get(s.categoryId) ?? "Services",
          basePriceCents: s.basePriceCents,
          active: s.active,
          // Per-vehicle-category price deltas, so the grid can show the real
          // price for the selected vehicle before anything is submitted.
          priceDeltaByCategory: Object.fromEntries(
            adjustments
              .filter((a) => a.serviceId === s.id)
              .map((a) => [a.vehicleCategory, a.priceDeltaCents]),
          ),
          addonIds: addonLinks.filter((l) => l.serviceId === s.id).map((l) => l.addonId),
        }))}
        addons={addons.map((a) => ({
          id: a.id,
          name: a.name,
          priceCents: a.priceCents,
          active: a.active,
          // Add-ons take a vehicle-size delta exactly as services do above.
          // Without this the grid quoted the sedan price for every vehicle,
          // while the invoice the server built used the real one.
          priceDeltaByCategory: Object.fromEntries(
            addonAdjustments
              .filter((adj) => adj.addonId === a.id)
              .map((adj) => [adj.vehicleCategory, adj.priceDeltaCents]),
          ),
        }))}
        taxRateBp={settings.taxRateBp}
        taxLabel={settings.taxLabel}
        currency={settings.currency}
        timezone={settings.timezone}
        initialCustomerId={customers.some((c) => c.id === customerId) ? customerId : ""}
        initialVehicleId={vehicles.some((v) => v.id === vehicleId) ? vehicleId : ""}
      />
    </div>
  );
}
