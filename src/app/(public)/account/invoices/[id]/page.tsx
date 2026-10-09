import { notFound, redirect } from "next/navigation";
import { and, eq, inArray, ne } from "drizzle-orm";
import { db, schema } from "@/db";
import { InvoiceDetail } from "@/components/invoice-detail";
import { accountCustomers, getAccountSession } from "@/lib/accounts/session";
import { getSettings } from "@/lib/settings";

export const metadata = { title: "Invoice", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

export default async function AccountInvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getAccountSession();
  if (!session) redirect("/account");
  const { id } = await params;
  const ids = (await accountCustomers(session)).map((c) => c.id);
  if (ids.length === 0) notFound();
  const [invoice] = await db()
    .select()
    .from(schema.invoices)
    .where(and(eq(schema.invoices.id, id), inArray(schema.invoices.customerId, ids), ne(schema.invoices.status, "draft")))
    .limit(1);
  if (!invoice) notFound();
  return (
    <InvoiceDetail
      invoice={invoice}
      settings={await getSettings()}
      backHref="/account"
      backLabel="My account"
      pdfHref={`/account/invoices/${invoice.id}/pdf`}
      footer="To pay, tick this invoice in the Invoices list on your account page."
    />
  );
}
