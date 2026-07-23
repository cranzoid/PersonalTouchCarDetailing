import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { getStaff } from "@/lib/auth/session";
import { renderInvoicePdf } from "@/lib/invoice-pdf";
import { roleHas } from "@/lib/auth/permissions";

/**
 * Staff-only invoice PDF download — mirrors the auth pattern in
 * /api/files/[id] (session-gated read, same as the admin invoice pages).
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const staff = await getStaff();
  if (!staff) return new NextResponse("Unauthorized", { status: 401 });
  if (!roleHas(staff.role, "record_payments")) return new NextResponse("Forbidden", { status: 403 });

  const { id } = await params;
  const [invoice] = await db()
    .select({ number: schema.invoices.number })
    .from(schema.invoices)
    .where(eq(schema.invoices.id, id))
    .limit(1);
  if (!invoice) return new NextResponse("Not found", { status: 404 });

  const pdf = await renderInvoicePdf(id);
  if (!pdf) return new NextResponse("Not found", { status: 404 });

  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="INV-${invoice.number}.pdf"`,
      "Cache-Control": "private, no-store",
    },
  });
}
