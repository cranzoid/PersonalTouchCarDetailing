import { getPool } from "@/db";
import type { QueryConfig } from "pg";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, max-age=0",
  "Content-Type": "application/json; charset=utf-8",
};

type TimedQueryConfig = QueryConfig & { query_timeout: number };

export async function GET() {
  const startedAt = Date.now();
  try {
    const readinessQuery: TimedQueryConfig = {
      text: "SELECT 1",
      query_timeout: 2_500,
    };
    await getPool().query(readinessQuery);
    return new Response(
      JSON.stringify({
        status: "ok",
        checks: { application: "ok", database: "ok" },
        durationMs: Date.now() - startedAt,
      }),
      { status: 200, headers: NO_STORE_HEADERS },
    );
  } catch {
    console.error("[health] database readiness check failed");
    return new Response(
      JSON.stringify({
        status: "unhealthy",
        checks: { application: "ok", database: "unhealthy" },
        durationMs: Date.now() - startedAt,
      }),
      { status: 503, headers: NO_STORE_HEADERS },
    );
  }
}
