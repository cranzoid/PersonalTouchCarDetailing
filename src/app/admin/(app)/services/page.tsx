import { asc } from "drizzle-orm";
import { db, schema } from "@/db";
import { AddonEditor, ServiceEditor } from "./service-editor";
import { NewAddonForm, NewCategoryForm, NewServiceForm } from "./service-creators";
import { requirePageStaff } from "@/lib/auth/page";

export const dynamic = "force-dynamic";

export default async function ServicesAdminPage() {
  await requirePageStaff("manage_services");
  const categories = await db()
    .select()
    .from(schema.serviceCategories)
    .orderBy(asc(schema.serviceCategories.sort));
  const [services, adjustments, addons] = await Promise.all([
    db().select().from(schema.services).orderBy(asc(schema.services.sort)),
    db().select().from(schema.serviceVehicleAdjustments),
    db().select().from(schema.addons).orderBy(asc(schema.addons.sort)),
  ]);

  return (
    <div className="max-w-4xl">
      <h1 className="text-2xl font-bold text-white">Services</h1>
      <p className="mt-1 text-sm text-ink-400">
        Prices, durations, vehicle adjustments, add-ons, booking modes and deposits are fully
        configurable. Changes apply to the public site immediately and are audited.
      </p>
      <div className="mt-6 flex flex-wrap gap-3">
        <NewServiceForm categories={categories.map((cat) => ({ id: cat.id, name: cat.name }))} />
        <NewAddonForm services={services.map((s) => ({ id: s.id, name: s.name }))} />
        <NewCategoryForm />
      </div>
      <div className="mt-8 space-y-10">
        {categories.map((cat) => (
          <section key={cat.id}>
            <h2 className="mb-3 text-lg font-semibold text-white">{cat.name}</h2>
            <div className="space-y-3">
              {services
                .filter((s) => s.categoryId === cat.id)
                .map((s) => (
                  <ServiceEditor
                    key={s.id}
                    service={{
                      id: s.id,
                      name: s.name,
                      shortDescription: s.shortDescription ?? "",
                      basePriceCents: s.basePriceCents,
                      baseDurationMin: s.baseDurationMin,
                      bookingMode: s.bookingMode,
                      active: s.active,
                      featured: s.featured,
                      depositType: s.depositType,
                      depositValue: s.depositValue,
                    }}
                    adjustments={adjustments
                      .filter((adjustment) => adjustment.serviceId === s.id)
                      .map((adjustment) => ({
                        id: adjustment.id,
                        vehicleCategory: adjustment.vehicleCategory,
                        priceDeltaCents: adjustment.priceDeltaCents,
                        durationDeltaMin: adjustment.durationDeltaMin,
                      }))}
                  />
                ))}
            </div>
          </section>
        ))}
        <section>
          <h2 className="mb-1 text-lg font-semibold text-white">Add-on services</h2>
          <p className="mb-3 text-sm text-ink-400">
            Add-on prices and extra booking time are included in customer totals and availability.
          </p>
          <div className="space-y-3">
            {addons.map((addon) => (
              <AddonEditor
                key={addon.id}
                addon={{
                  id: addon.id,
                  name: addon.name,
                  description: addon.description ?? "",
                  priceCents: addon.priceCents,
                  durationMin: addon.durationMin,
                  active: addon.active,
                }}
              />
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
