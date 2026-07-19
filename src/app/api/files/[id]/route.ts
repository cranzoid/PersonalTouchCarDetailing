import { readFile } from "fs/promises";
import { join, normalize } from "path";
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { getStaff } from "@/lib/auth/session";

/**
 * Serves private customer files to authenticated STAFF only. Customer files
 * are never publicly reachable; future customer access goes through tokened
 * links with their own authorization (Phase 2+).
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const staff = await getStaff();
  if (!staff) return new NextResponse("Unauthorized", { status: 401 });

  const { id } = await params;
  const rows = await db().select().from(schema.files).where(eq(schema.files.id, id)).limit(1);
  const file = rows[0];
  if (!file) return new NextResponse("Not found", { status: 404 });

  const uploadsRoot = join(process.cwd(), "var", "uploads");
  const fullPath = normalize(join(uploadsRoot, file.storageKey));
  if (!fullPath.startsWith(uploadsRoot)) return new NextResponse("Not found", { status: 404 });

  try {
    const data = await readFile(fullPath);
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
