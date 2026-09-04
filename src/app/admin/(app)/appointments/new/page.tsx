import { and, asc, eq, isNotNull, isNull } from "drizzle-orm";
import { db, schema } from "@/db";
import { requirePageStaff } from "@/lib/auth/page";
import { compareLabels } from "@/lib/option-search";
import { getSettings } from "@/lib/settings";
import { NewAppointmentBuilder } from "./builder";

export const dynamic = "force-dynamic";

export default async function NewAppointmentPage() {
  await requirePageStaff("manage_bookings");
  const settings = await getSettings();
  const [customers, vehicles, services, categories, addonLinks, addons] = await Promise.all([
    db().select().from(schema.customers).where(isNull(schema.customers.anonymizedAt)).orderBy(asc(schema.customers.firstName), asc(schema.customers.lastName)),
    db().select().from(schema.vehicles).orderBy(asc(schema.vehicles.make), asc(schema.vehicles.model), asc(schema.vehicles.year)),
    db().select().from(schema.services).where(and(
      eq(schema.services.active, true),
      eq(schema.services.bookingMode, "bookable"),
      isNotNull(schema.services.basePriceCents),
    )).orderBy(asc(schema.services.sort)),
    db().select().from(schema.serviceCategories).orderBy(asc(schema.serviceCategories.sort)),
    db().select().from(schema.serviceAddons),
    db().select().from(schema.addons).where(eq(schema.addons.active, true)).orderBy(asc(schema.addons.sort)),
  ]);
  const categoryNames = new Map(categories.map((category) => [category.id, category.name]));

  // Ordered on the finished label, not in SQL — a business reads as
  // "Company — First Last", so ordering by `first_name` scattered the fleet
  // accounts through the list for no reason a human could see.
  const customerOptions = customers
    .map((customer) => ({
      id: customer.id,
      label: customer.customerType === "business" && customer.companyName
        ? `${customer.companyName} — ${customer.firstName} ${customer.lastName}`
        : `${customer.firstName} ${customer.lastName}`,
      contact: customer.email ?? customer.phone ?? "No contact method",
      searchText: [customer.companyName, customer.email, customer.phone, customer.phoneNormalized]
        .filter(Boolean)
        .join(" "),
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
    <div className="max-w-5xl">
      <h1 className="text-2xl font-bold text-white">New appointment</h1>
      <p className="mt-1 text-sm text-ink-400">Create a staff-assisted booking for an existing CRM customer and vehicle.</p>
      <NewAppointmentBuilder
        customers={customerOptions}
        vehicles={orderedVehicles.map((vehicle) => ({
          id: vehicle.id,
          customerId: vehicle.customerId,
          label: [vehicle.year, vehicle.make, vehicle.model, vehicle.licencePlate && `(${vehicle.licencePlate})`].filter(Boolean).join(" "),
          category: vehicle.category,
          searchText: [vehicle.trim, vehicle.colour].filter(Boolean).join(" "),
        }))}
        services={services.map((service) => ({
          id: service.id,
          name: service.name,
          categoryName: categoryNames.get(service.categoryId) ?? "Services",
          basePriceCents: service.basePriceCents!,
          addonIds: addonLinks.filter((link) => link.serviceId === service.id).map((link) => link.addonId),
        }))}
        addons={addons.map((addon) => ({
          id: addon.id,
          name: addon.name,
          priceCents: addon.priceCents,
        }))}
        maxBookingWindowDays={settings.maxBookingWindowDays}
        timezone={settings.timezone}
      />
    </div>
  );
}
