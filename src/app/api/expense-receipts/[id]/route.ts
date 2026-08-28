import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { RECEIPT_ENTITY_TYPE } from "@/app/admin/(app)/expenses/receipts";
import { getStaff } from "@/lib/auth/session";
import { roleHas } from "@/lib/auth/permissions";
import { getPrivateFile } from "@/lib/storage";

/**
 * Serves expense receipts, gated on `manage_expenses`.
 *
 * Deliberately NOT /api/files/[id]. That route gates on `view_private_files`,
 * which is the wrong permission in both directions here: it would show cost
 * data to reception and technicians — who are excluded from `manage_expenses`
 * precisely so they cannot see what the business pays — and it would lock out
 * the accountant, who can enter the expense but holds no private-files right.
 *
 * The entity_type filter is the other half of the boundary: this route can only
 * ever return a receipt, never a customer photo that happens to share the id
 * space.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const staff = await getStaff();
  if (!staff) return new NextResponse("Unauthorized", { status: 401 });
  if (!roleHas(staff.role, "manage_expenses")) return new NextResponse("Forbidden", { status: 403 });

  const { id } = await params;
  const [file] = await db()
    .select()
    .from(schema.files)
    .where(and(eq(schema.files.id, id), eq(schema.files.entityType, RECEIPT_ENTITY_TYPE)))
    .limit(1);
  if (!file) return new NextResponse("Not found", { status: 404 });

  try {
    const data = await getPrivateFile(file.storageKey);
    return new NextResponse(new Uint8Array(data), {
      headers: {
        "Content-Type": file.contentType,
        // inline so a PDF bill opens in the browser's viewer rather than
        // landing in the downloads folder.
        "Content-Disposition": "inline",
        "Cache-Control": "private, max-age=300",
      },
    });
  } catch {
    return new NextResponse("Not found", { status: 404 });
  }
}
