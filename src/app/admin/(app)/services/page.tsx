import { asc } from "drizzle-orm";
import { db, schema } from "@/db";
import { ServiceEditor } from "./service-editor";
import { requirePageStaff } from "@/lib/auth/page";

export const dynamic = "force-dynamic";

export default async function ServicesAdminPage() {
  await requirePageStaff("manage_services");
  const categories = await db()
    .select()
    .from(schema.serviceCategories)
    .orderBy(asc(schema.serviceCategories.sort));
  const services = await db().select().from(schema.services).orderBy(asc(schema.services.sort));

  return (
    <div className="max-w-4xl">
      <h1 className="text-2xl font-bold text-white">Services</h1>
      <p className="mt-1 text-sm text-ink-400">
        Prices, durations, booking modes and deposits are fully configurable. Changes apply to the
        public site immediately and are audited.
      </p>
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
                  />
                ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
