import { beforeEach, describe, expect, it, vi } from "vitest";

const { queryMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
}));

vi.mock("@/db", () => ({
  getPool: () => ({ query: queryMock }),
}));

import { GET } from "@/app/api/health/route";

describe("GET /api/health", () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  it("reports ready only after a bounded database check succeeds", async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ "?column?": 1 }] });

    const response = await GET();
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(payload).toMatchObject({
      status: "ok",
      checks: { application: "ok", database: "ok" },
    });
    expect(queryMock).toHaveBeenCalledWith({
      text: "SELECT 1",
      query_timeout: 2_500,
    });
  });

  it("returns 503 without exposing database error details", async () => {
    queryMock.mockRejectedValueOnce(new Error("secret database hostname"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await GET();
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(body).toContain('"database":"unhealthy"');
    expect(body).not.toContain("secret database hostname");
    expect(errorSpy).toHaveBeenCalledWith("[health] database readiness check failed");
    errorSpy.mockRestore();
  });
});
