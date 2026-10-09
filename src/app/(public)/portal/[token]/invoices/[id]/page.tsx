import { notFound } from "next/navigation";
import { and, eq, ne } from "drizzle-orm";
import { db, schema } from "@/db";
import { InvoiceDetail } from "@/components/invoice-detail";
import { portalOwnsCustomer, resolveCustomerPortalToken } from "@/lib/portal";
import { getSettings } from "@/lib/settings";

export const metadata = { title: "Invoice Details" };
export const dynamic = "force-dynamic";

export default async function PortalInvoiceDetailPage({ params }: { params: Promise<{ token: string; id: string }> }) {
  const { token, id } = await params;
  const resolved = await resolveCustomerPortalToken(token);
  if (!resolved) notFound();
  const [invoice] = await db()
    .select()
    .from(schema.invoices)
    .where(and(eq(schema.invoices.id, id), eq(schema.invoices.customerId, resolved.customer.id), ne(schema.invoices.status, "draft")))
    .limit(1);
  if (!invoice || !portalOwnsCustomer(resolved.customer.id, invoice.customerId)) notFound();
  return (
    <InvoiceDetail
      invoice={invoice}
      settings={await getSettings()}
      backHref={`/portal/${token}`}
      backLabel="Your account"
      pdfHref={`/portal/${token}/invoices/${invoice.id}/pdf`}
      footer="To pay, tick this invoice in the Invoices list on your account page — you can pay several at once."
    />
  );
}
