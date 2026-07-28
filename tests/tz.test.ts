import { describe, expect, it } from "vitest";
import { formatHHMM12, formatInZone } from "../src/lib/tz";

describe("12-hour business time formatting", () => {
  it("formats stored local times with a.m. and p.m.", () => {
    expect(formatHHMM12("00:00")).toBe("12:00 a.m.");
    expect(formatHHMM12("09:00")).toBe("9:00 a.m.");
    expect(formatHHMM12("12:00")).toBe("12:00 p.m.");
    expect(formatHHMM12("17:00")).toBe("5:00 p.m.");
  });

  it("uses a 12-hour clock for timezone-aware appointment labels", () => {
    expect(
      formatInZone(new Date("2026-07-27T13:00:00.000Z"), "America/Toronto", {
        hour: "numeric",
        minute: "2-digit",
      }),
    ).toBe("9:00 a.m.");
  });
});
