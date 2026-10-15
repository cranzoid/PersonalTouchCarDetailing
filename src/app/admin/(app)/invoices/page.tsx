import Link from "next/link";
import { and, count, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { formatCents } from "@/lib/money";
import { summarizePayments, syncOverdueInvoices } from "@/lib/invoices";
import { getSettings } from "@/lib/settings";
import { StatusBadge } from "@/components/admin";
import { requirePageStaff } from "@/lib/auth/page";
import { INVOICE_STATUSES } from "@/lib/types";
import {
  INVOICE_PAGE_SIZE,
  invoiceNumberFromQuery,
  parseInvoiceListParams,
  statusesForFilter,
} from "@/lib/invoice-list";

export const dynamic = "force-dynamic";

const label = (s: string) => s.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

export default async function InvoicesPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; q?: string; page?: string }>;
}) {
  await requirePageStaff("record_payments");
  const { filter, q, page: requestedPage } = parseInvoiceListParams(await searchParams);
  await syncOverdueInvoices();
  const settings = await getSettings();
  const statuses = statusesForFilter(filter);
  const number = q ? invoiceNumberFromQuery(q) : null;
  const where = and(
    statuses ? inArray(schema.invoices.status, statuses) : undefined,
    q
      ? or(
          number !== null ? eq(schema.invoices.number, number) : undefined,
          ilike(schema.customers.firstName, `%${q}%`),
          ilike(schema.customers.lastName, `%${q}%`),
          ilike(sql`${schema.customers.firstName} || ' ' || ${schema.customers.lastName}`, `%${q}%`),
          ilike(schema.customers.email, `%${q}%`),
        )
      : undefined,
  );
  const [{ total }] = await db()
    .select({ total: count() })
    .from(schema.invoices)
    .innerJoin(schema.customers, eq(schema.invoices.customerId, schema.customers.id))
    .where(where);
  const pageCount = Math.max(1, Math.ceil(total / INVOICE_PAGE_SIZE));
  const page = Math.min(requestedPage, pageCount);
  const href = (over: { status?: string; page?: number }) => {
    const params = new URLSearchParams();
    const status = over.status ?? filter;
    if (status !== "all") params.set("status", status);
    if (q) params.set("q", q);
    if ((over.page ?? 1) > 1) params.set("page", String(over.page));
    const qs = params.toString();
    return qs ? `/admin/invoices?${qs}` : "/admin/invoices";
  };
  const invoices = await db()
    .select({
      invoice: schema.invoices,
      customer: schema.customers,
    })
    .from(schema.invoices)
    .innerJoin(schema.customers, eq(schema.invoices.customerId, schema.customers.id))
    .where(where)
    .orderBy(desc(schema.invoices.createdAt), desc(schema.invoices.number))
    .limit(INVOICE_PAGE_SIZE)
    .offset((page - 1) * INVOICE_PAGE_SIZE);

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
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-white">Invoices</h1>
        <Link
          href="/admin/invoices/new"
          className="rounded-lg bg-accent-400 px-4 py-2 text-sm font-semibold text-ink-950 hover:bg-accent-300"
        >
          New invoice
        </Link>
      </div>
      <p className="mt-1 text-sm text-ink-400">
        Invoices are created automatically from a job once it&apos;s ready for pickup or completed.
        Use <span className="text-ink-200">New invoice</span> for walk-ins and work done outside a
        booked job.
      </p>
      <form action="/admin/invoices" role="search" className="mt-4 flex max-w-md gap-2">
        {filter !== "all" && <input type="hidden" name="status" value={filter} />}
        <input
          name="q"
          type="search"
          defaultValue={q}
          autoComplete="off"
          placeholder="Search invoice #, name or email…"
          aria-label="Search invoices"
          className="w-full rounded-lg border border-ink-600 bg-ink-900 px-4 py-2 text-sm text-white placeholder:text-ink-600"
        />
        <button className="rounded-lg border border-ink-600 px-4 py-2 text-sm text-ink-200 hover:bg-ink-800">
          Search
        </button>
      </form>
      <nav aria-label="Filter by status" className="mt-3 flex flex-wrap gap-2 text-sm">
        {(["all", "unpaid", ...INVOICE_STATUSES] as const).map((s) => (
          <Link
            key={s}
            href={href({ status: s })}
            aria-current={filter === s ? "page" : undefined}
            className={`rounded-full border px-3 py-1 ${
              filter === s
                ? "border-accent-400 bg-accent-400 font-semibold text-ink-950"
                : "border-ink-700 text-ink-300 hover:bg-ink-800"
            }`}
          >
            {label(s)}
          </Link>
        ))}
      </nav>
      <p className="mt-3 text-xs text-ink-500">
        {total} {total === 1 ? "invoice" : "invoices"}
        {pageCount > 1 ? ` · page ${page} of ${pageCount}` : ""}
      </p>
      <div className="mt-3 overflow-x-auto rounded-xl border border-ink-800">
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
                  {filter === "all" && !q ? "No invoices yet. Create one from a ready-for-pickup or completed job." : "No invoices match."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {pageCount > 1 && (
        <div className="mt-4 flex items-center justify-between text-sm">
          {page > 1 ? (
            <Link href={href({ page: page - 1 })} className="text-accent-300 hover:underline">← Newer</Link>
          ) : <span />}
          {page < pageCount ? (
            <Link href={href({ page: page + 1 })} className="text-accent-300 hover:underline">Older →</Link>
          ) : <span />}
        </div>
      )}
    </div>
  );
}
