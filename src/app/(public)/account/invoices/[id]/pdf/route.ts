import { NextResponse } from "next/server";
import { and, eq, inArray, ne } from "drizzle-orm";
import { db, schema } from "@/db";
import { accountCustomers, getAccountSession } from "@/lib/accounts/session";
import { renderInvoicePdf } from "@/lib/invoice-pdf";

/** Invoice PDF for a signed-in customer, scoped to the records their contact owns. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getAccountSession();
  if (!session) return new NextResponse("Not found", { status: 404 });
  const { id } = await params;
  const ids = (await accountCustomers(session)).map((c) => c.id);
  if (ids.length === 0) return new NextResponse("Not found", { status: 404 });
  const [invoice] = await db()
    .select({ id: schema.invoices.id, number: schema.invoices.number })
    .from(schema.invoices)
    .where(and(eq(schema.invoices.id, id), inArray(schema.invoices.customerId, ids), ne(schema.invoices.status, "draft")))
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
