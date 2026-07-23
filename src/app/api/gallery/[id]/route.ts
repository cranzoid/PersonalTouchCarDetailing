import { and, eq, isNotNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db, schema } from "@/db";
import { getPrivateFile } from "@/lib/storage";

/** Serves only images with separately recorded public-marketing consent. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
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
        "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return new NextResponse("Not found", { status: 404 });
  }
}

