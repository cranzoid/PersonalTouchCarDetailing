import Link from "next/link";
import { notFound } from "next/navigation";
import { desc, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { getStaff } from "@/lib/auth/session";
import { roleHas } from "@/lib/auth/permissions";
import { FleetCreateForm } from "./fleet-create-form";

export const dynamic = "force-dynamic";

export default async function FleetPage() {
  const staff = await getStaff();
  if (!staff || !roleHas(staff.role, "manage_customers")) notFound();
  const companies = await db().select().from(schema.customers)
    .where(eq(schema.customers.customerType, "business"))
    .orderBy(desc(schema.customers.createdAt));
  const allVehicles = companies.length > 0 ? await db().select({ id: schema.vehicles.id, customerId: schema.vehicles.customerId }).from(schema.vehicles) : [];
  const vehicleCounts = new Map<string, number>();
  for (const vehicle of allVehicles) vehicleCounts.set(vehicle.customerId, (vehicleCounts.get(vehicle.customerId) ?? 0) + 1);

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white">Fleet accounts</h1>
          <p className="mt-1 text-sm text-ink-400">Company contacts, multi-vehicle records and consolidated billing.</p>
        </div>
        <Link href="/admin/customers" className="text-sm text-accent-300 hover:underline">All customers →</Link>
      </div>
      <FleetCreateForm />
      <div className="mt-6 overflow-x-auto rounded-xl border border-ink-800">
        <table className="w-full text-left text-sm">
          <thead className="bg-ink-900 text-ink-400"><tr><th className="px-4 py-3">Company</th><th className="px-4 py-3">Contact</th><th className="px-4 py-3">Vehicles</th><th className="px-4 py-3">Since</th></tr></thead>
          <tbody>
            {companies.length === 0 && <tr><td colSpan={4} className="px-4 py-8 text-center text-ink-500">No fleet accounts yet.</td></tr>}
            {companies.map((company) => (
              <tr key={company.id} className="border-t border-ink-800">
                <td className="px-4 py-3"><Link href={`/admin/fleet/${company.id}`} className="font-medium text-accent-300 hover:underline">{company.companyName ?? `${company.firstName} ${company.lastName}`}</Link></td>
                <td className="px-4 py-3 text-ink-300"><p>{company.firstName} {company.lastName}</p><p className="text-xs text-ink-500">{company.email ?? company.phone ?? "No contact method"}</p></td>
                <td className="px-4 py-3 text-ink-300">{vehicleCounts.get(company.id) ?? 0}</td>
                <td className="px-4 py-3 text-ink-400">{company.createdAt.toISOString().slice(0, 10)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
