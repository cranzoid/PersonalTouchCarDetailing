import { asc, eq } from "drizzle-orm";
import { db, schema } from "@/db";

const PUBLIC_CATALOG_TTL_MS = 60_000;

async function loadPublicHomeCatalog() {
  const [featured, categories] = await Promise.all([
    db()
      .select()
      .from(schema.services)
      .where(eq(schema.services.featured, true))
      .orderBy(asc(schema.services.sort))
      .limit(3),
    db()
      .select()
      .from(schema.serviceCategories)
      .where(eq(schema.serviceCategories.active, true))
      .orderBy(asc(schema.serviceCategories.sort)),
  ]);
  return { featured, categories };
}

type PublicHomeCatalog = Awaited<ReturnType<typeof loadPublicHomeCatalog>>;

let publicHomeCatalogCache:
  | { expiresAt: number; value: Promise<PublicHomeCatalog> }
  | undefined;

/**
 * Public catalogue data is informational. Booking and quote actions continue
 * to load authoritative service rows and recompute prices on the server.
 */
export function getPublicHomeCatalog(): Promise<PublicHomeCatalog> {
  const now = Date.now();
  if (!publicHomeCatalogCache || publicHomeCatalogCache.expiresAt <= now) {
    const pending = loadPublicHomeCatalog();
    const cached = pending.catch((error) => {
      if (publicHomeCatalogCache?.value === cached) publicHomeCatalogCache = undefined;
      throw error;
    });
    publicHomeCatalogCache = {
      expiresAt: now + PUBLIC_CATALOG_TTL_MS,
      value: cached,
    };
  }
  return publicHomeCatalogCache.value;
}

export function invalidatePublicCatalogCache(): void {
  publicHomeCatalogCache = undefined;
}
