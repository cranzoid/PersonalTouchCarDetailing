import { and, eq, isNotNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db, schema } from "@/db";
import { getPrivateFile } from "@/lib/storage";

/**
 * Crawlable marketing-media URL. The blob remains private and every request
 * repeats the explicit-consent check, so revocation takes effect immediately.
 * The descriptive filename is intentionally part of the public image URL.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; filename: string }> },
) {
  const { id, filename } = await params;
  const [file] = await db()
    .select()
    .from(schema.files)
    .where(and(eq(schema.files.id, id), isNotNull(schema.files.publicConsentAt)))
    .limit(1);

  if (!file || !file.contentType.startsWith("image/")) {
    return new NextResponse("Not found", { status: 404 });
  }

  try {
    const data = await getPrivateFile(file.storageKey);
    return new NextResponse(new Uint8Array(data), {
      headers: {
        "Content-Type": file.contentType,
        "Content-Disposition": `inline; filename="${filename.replace(/[^a-zA-Z0-9._-]/g, "-")}"`,
        "Cache-Control": "public, max-age=0, must-revalidate",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return new NextResponse("Not found", { status: 404 });
  }
}
