import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { getStaff } from "@/lib/auth/session";
import { getPrivateFile } from "@/lib/storage";
import { roleHas } from "@/lib/auth/permissions";

/**
 * Serves private customer files to authenticated STAFF only. Customer files
 * are never publicly reachable; customer access uses separate token-gated
 * portal routes that verify ownership before serving a document.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const staff = await getStaff();
  if (!staff) return new NextResponse("Unauthorized", { status: 401 });
  if (!roleHas(staff.role, "view_private_files")) return new NextResponse("Forbidden", { status: 403 });

  const { id } = await params;
  const rows = await db().select().from(schema.files).where(eq(schema.files.id, id)).limit(1);
  const file = rows[0];
  if (!file) return new NextResponse("Not found", { status: 404 });

  try {
    const data = await getPrivateFile(file.storageKey);
    return new NextResponse(new Uint8Array(data), {
      headers: {
        "Content-Type": file.contentType,
        "Cache-Control": "private, max-age=300",
      },
    });
  } catch {
    return new NextResponse("Not found", { status: 404 });
  }
}
