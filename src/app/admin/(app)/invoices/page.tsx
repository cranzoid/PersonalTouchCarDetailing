import Link from "next/link";
import { desc, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import { formatCents } from "@/lib/money";
import { summarizePayments, syncOverdueInvoices } from "@/lib/invoices";
import { getSettings } from "@/lib/settings";
import { StatusBadge } from "@/components/admin";
import { requirePageStaff } from "@/lib/auth/page";

export const dynamic = "force-dynamic";

export default async function InvoicesPage() {
  await requirePageStaff("record_payments");
  await syncOverdueInvoices();
  const settings = await getSettings();
  const invoices = await db()
    .select({
      invoice: schema.invoices,
      customer: schema.customers,
    })
    .from(schema.invoices)
    .innerJoin(schema.customers, eq(schema.invoices.customerId, schema.customers.id))
    .orderBy(desc(schema.invoices.createdAt))
    .limit(100);

  const paymentRows = invoices.length
    ? await db()
        .select()
        .from(schema.payments)
        .where(inArray(schema.payments.invoiceId, invoices.map((i) => i.invoice.id)))
    : [];
  const paymentsByInvoice = new Map<string, typeof paymentRows>();
  for (const p of paymentRows) {
    if (!p.invoiceId) continue;
    const list = paymentsByInvoice.get(p.invoiceId) ?? [];
    list.push(p);
    paymentsByInvoice.set(p.invoiceId, list);
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-white">Invoices</h1>
      </div>
      <p className="mt-1 text-sm text-ink-400">
        Invoices are created from a job once it&apos;s ready for pickup or completed.
      </p>
      <div className="mt-6 overflow-x-auto rounded-xl border border-ink-800">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-ink-800 text-xs uppercase tracking-wider text-ink-400">
            <tr>
              <th className="px-4 py-3">#</th>
              <th className="px-4 py-3">Customer</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Total</th>
              <th className="px-4 py-3">Balance</th>
              <th className="px-4 py-3">Created</th>
            </tr>
          </thead>
          <tbody>
            {invoices.map(({ invoice, customer }) => {
              const { balanceCents } = summarizePayments(
                invoice.totalCents,
                invoice.depositAppliedCents,
                paymentsByInvoice.get(invoice.id) ?? [],
              );
              return (
                <tr key={invoice.id} className="border-b border-ink-800/60 hover:bg-ink-900/40">
                  <td className="px-4 py-3">
                    <Link href={`/admin/invoices/${invoice.id}`} className="font-medium text-accent-300">
                      INV-{invoice.number}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-ink-200">
                    {customer.firstName} {customer.lastName}
                  </td>
                  <td className="px-4 py-3"><StatusBadge status={invoice.status} /></td>
                  <td className="px-4 py-3 text-ink-200">{formatCents(invoice.totalCents, settings.currency)}</td>
                  <td className="px-4 py-3 text-ink-200">
                    {balanceCents > 0 ? formatCents(balanceCents, settings.currency) : "—"}
                  </td>
                  <td className="px-4 py-3 text-ink-400">{invoice.createdAt.toLocaleDateString("en-CA")}</td>
                </tr>
              );
            })}
            {invoices.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-ink-500">
                  No invoices yet. Create one from a ready-for-pickup or completed job.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
