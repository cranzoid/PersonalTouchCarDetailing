import { NextResponse } from "next/server";
import { resolveInvoiceToken } from "@/lib/invoices";
import { renderInvoicePdf } from "@/lib/invoice-pdf";

/**
 * Customer-facing invoice PDF download — authorized the same way as the
 * portal page itself (single-purpose hashed token), not by staff session.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const resolved = await resolveInvoiceToken(token);
  if (!resolved) return new NextResponse("Not found", { status: 404 });

  const pdf = await renderInvoicePdf(resolved.invoice.id);
  if (!pdf) return new NextResponse("Not found", { status: 404 });

  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="INV-${resolved.invoice.number}.pdf"`,
      "Cache-Control": "private, no-store",
    },
  });
}
