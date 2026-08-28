import Link from "next/link";
import { desc, ilike, or } from "drizzle-orm";
import { db, schema } from "@/db";
import { requirePageStaff } from "@/lib/auth/page";
import { duplicatePhoneNumbers, normalizePhone } from "@/lib/phone";
import { NewCustomerForm } from "./new-customer-form";

export const dynamic = "force-dynamic";

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; new?: string; next?: string }>;
}) {
  await requirePageStaff("manage_customers");
  const { q, new: openNew, next } = await searchParams;
  const query = q?.trim();

  // "(905) 555-1234", "905-555-1234" and "9055551234" are one number, and the
  // raw `phone` column holds whichever form the customer happened to give.
  // Searching the normalized column as well means staff find the record however
  // they type it. Staff-side only, by design — see src/lib/phone.ts.
  const queryPhone = query ? normalizePhone(query) : null;
  const base = db().select().from(schema.customers);
  const customers = await (query
    ? base.where(
        or(
          ilike(schema.customers.firstName, `%${query}%`),
          ilike(schema.customers.lastName, `%${query}%`),
          ilike(schema.customers.email, `%${query}%`),
          ilike(schema.customers.phone, `%${query}%`),
          ...(queryPhone ? [ilike(schema.customers.phoneNormalized, `%${queryPhone}%`)] : []),
        ),
      )
    : base
  )
    .orderBy(desc(schema.customers.createdAt))
    .limit(100);

  // Live data already contains duplicates — the public booking form creates a
  // new customer every time, and deliberately does not match on phone. Flagging
  // them here is the staff-side half of that trade-off: a prompt for a human to
  // look, never an automatic merge.
  const duplicatePhones = duplicatePhoneNumbers(
    await db()
      .select({
        phoneNormalized: schema.customers.phoneNormalized,
        anonymizedAt: schema.customers.anonymizedAt,
      })
      .from(schema.customers),
  );

  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-white">Customers</h1>
        <Link href="/admin/fleet" className="text-sm font-medium text-accent-300 hover:underline">Fleet accounts →</Link>
      </div>
      {/* Collapsed this renders just a button; expanded it becomes the form.
          `?new=1` opens it straight away for the screens that link here
          mid-task, and `?next=` walks the staff member back afterwards. */}
      <div className="mt-4">
        <NewCustomerForm defaultOpen={openNew === "1"} next={next} />
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
                  {c.phoneNormalized && duplicatePhones.has(c.phoneNormalized) && !c.anonymizedAt && (
                    <Link
                      href={`/admin/customers?q=${encodeURIComponent(c.phoneNormalized)}`}
                      className="mt-1 inline-block text-xs text-amber-300 hover:underline"
                    >
                      Shares this number with another customer →
                    </Link>
                  )}
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
