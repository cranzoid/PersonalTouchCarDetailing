import { NextResponse } from "next/server";
import { and, eq, ne } from "drizzle-orm";
import { db, schema } from "@/db";
import { renderInvoicePdf } from "@/lib/invoice-pdf";
import { resolveCustomerPortalToken } from "@/lib/portal";

/** An invoice PDF from the account workspace, scoped to the link's customer. */
export async function GET(_req: Request, { params }: { params: Promise<{ token: string; id: string }> }) {
  const { token, id } = await params;
  const resolved = await resolveCustomerPortalToken(token);
  if (!resolved) return new NextResponse("Not found", { status: 404 });
  const [invoice] = await db()
    .select({ id: schema.invoices.id, number: schema.invoices.number })
    .from(schema.invoices)
    .where(and(eq(schema.invoices.id, id), eq(schema.invoices.customerId, resolved.customer.id), ne(schema.invoices.status, "draft")))
    .limit(1);
  if (!invoice) return new NextResponse("Not found", { status: 404 });
  const pdf = await renderInvoicePdf(invoice.id);
  if (!pdf) return new NextResponse("Not found", { status: 404 });
  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="INV-${invoice.number}.pdf"`,
      "Cache-Control": "private, no-store",
    },
  });
}
