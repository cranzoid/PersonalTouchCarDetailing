import Link from "next/link";
import { desc, ilike, or } from "drizzle-orm";
import { db, schema } from "@/db";
import { requirePageStaff } from "@/lib/auth/page";

export const dynamic = "force-dynamic";

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  await requirePageStaff("manage_customers");
  const { q } = await searchParams;
  const query = q?.trim();

  const base = db().select().from(schema.customers);
  const customers = await (query
    ? base.where(
        or(
          ilike(schema.customers.firstName, `%${query}%`),
          ilike(schema.customers.lastName, `%${query}%`),
          ilike(schema.customers.email, `%${query}%`),
          ilike(schema.customers.phone, `%${query}%`),
        ),
      )
    : base
  )
    .orderBy(desc(schema.customers.createdAt))
    .limit(100);

  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-white">Customers</h1>
        <Link href="/admin/fleet" className="text-sm font-medium text-accent-300 hover:underline">Fleet accounts →</Link>
      </div>
      <form className="mt-4 max-w-sm">
        <input
          name="q"
          defaultValue={query ?? ""}
          placeholder="Search name, email or phone…"
          className="w-full rounded-lg border border-ink-600 bg-ink-900 px-4 py-2 text-sm text-white placeholder:text-ink-600"
        />
      </form>
      <div className="mt-6 overflow-x-auto rounded-xl border border-ink-800">
        <table className="w-full text-sm">
          <thead className="bg-ink-900 text-left text-ink-400">
            <tr>
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Contact</th>
              <th className="px-4 py-3">Type</th>
              <th className="px-4 py-3">Marketing consent</th>
              <th className="px-4 py-3">Since</th>
            </tr>
          </thead>
          <tbody>
            {customers.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-ink-500">No customers found.</td></tr>
            )}
            {customers.map((c) => (
              <tr key={c.id} className="border-t border-ink-800 hover:bg-ink-900/40">
                <td className="px-4 py-3">
                  <Link href={`/admin/customers/${c.id}`} className="font-medium text-accent-300 hover:underline">
                    {c.firstName} {c.lastName}
                  </Link>
                </td>
                <td className="px-4 py-3 text-ink-300">
                  {c.email && <p>{c.email}</p>}
                  {c.phone && <p>{c.phone}</p>}
                </td>
                <td className="px-4 py-3 capitalize text-ink-400">{c.customerType}</td>
                <td className="px-4 py-3 text-ink-400">{c.marketingConsent ? "Yes" : "No"}</td>
                <td className="px-4 py-3 text-ink-400">{c.createdAt.toISOString().slice(0, 10)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
