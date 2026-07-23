import { describe, expect, it } from "vitest";
import {
  computeDaySlots,
  pickFreeBay,
  pickFreeStaff,
  type DayContext,
} from "../src/lib/booking/availability";

const HOUR = 3600_000;
const DAY = 24 * HOUR;

/** Baseline: open 9:00–17:00 (as epoch ms), 2 bays, no busy time, booking 7 days out. */
function ctx(overrides: Partial<DayContext> = {}): DayContext {
  const open = 7 * DAY; // arbitrary epoch anchor
  return {
    openMs: open,
    closeMs: open + 8 * HOUR,
    granularityMin: 30,
    totalDurationMin: 120, // 90 min work + buffers
    nowMs: open - 7 * DAY,
    minNoticeHours: 24,
    maxBookingWindowDays: 60,
    busyByBay: [[], []],
    unassignedBusy: [],
    globalBlocks: [],
    staffingConfigured: false,
    staffCapacity: [],
    unassignedStaffBusy: [],
    requiredSkills: [],
    ...overrides,
  };
}

describe("computeDaySlots", () => {
  it("returns stepped slots that fit before close", () => {
    const slots = computeDaySlots(ctx());
    // 8h day, 2h appointment, 30-min steps → starts 9:00..15:00 = 13 slots
    expect(slots).toHaveLength(13);
    expect(slots[0].start).toBe(ctx().openMs);
    expect(slots.at(-1)!.end).toBe(ctx().closeMs);
  });

  it("returns nothing on closed days", () => {
    expect(computeDaySlots(ctx({ openMs: null, closeMs: null }))).toHaveLength(0);
  });

  it("enforces minimum booking notice", () => {
    const c = ctx();
    // "now" 1 hour before open with 24h notice → whole day excluded
    expect(computeDaySlots({ ...c, nowMs: c.openMs! - HOUR })).toHaveLength(0);
  });

  it("enforces the maximum booking window", () => {
    const c = ctx();
    expect(computeDaySlots({ ...c, nowMs: c.openMs! - 90 * DAY })).toHaveLength(0);
  });

  it("removes slots blocked by whole-business closures", () => {
    const c = ctx();
    const lunchStart = c.openMs! + 3 * HOUR;
    const slots = computeDaySlots({
      ...c,
      globalBlocks: [{ start: lunchStart, end: lunchStart + HOUR }],
    });
    for (const s of slots) {
      expect(s.start >= lunchStart + HOUR || s.end <= lunchStart).toBe(true);
    }
    expect(slots.length).toBeLessThan(13);
  });

  it("offers a slot while at least one bay is free, none when all bays busy", () => {
    const c = ctx();
    const window = { start: c.openMs!, end: c.openMs! + 2 * HOUR };
    const oneBusy = computeDaySlots({ ...c, busyByBay: [[window], []] });
    expect(oneBusy.some((s) => s.start === c.openMs)).toBe(true);
    const bothBusy = computeDaySlots({ ...c, busyByBay: [[window], [window]] });
    expect(bothBusy.some((s) => s.start === c.openMs)).toBe(false);
  });

  it("counts unassigned appointments against capacity", () => {
    const c = ctx();
    const window = { start: c.openMs!, end: c.openMs! + 2 * HOUR };
    const slots = computeDaySlots({ ...c, unassignedBusy: [window, window] });
    expect(slots.some((s) => s.start === c.openMs)).toBe(false);
    // Later, non-overlapping slots still offered
    expect(slots.some((s) => s.start === c.openMs! + 2 * HOUR)).toBe(true);
  });

  it("preserves bay-only availability when no weekly staff schedules exist", () => {
    const c = ctx();
    const window = { start: c.openMs!, end: c.openMs! + 2 * HOUR };
    expect(pickFreeStaff(c, window)).toBeUndefined();
    expect(computeDaySlots(c).some((slot) => slot.start === c.openMs)).toBe(true);
  });

  it("requires configured staff capacity for the complete buffered window", () => {
    const c = ctx({ staffingConfigured: true });
    expect(computeDaySlots(c)).toHaveLength(0);

    const fullShift = { start: c.openMs!, end: c.closeMs! };
    const staffed = ctx({
      staffingConfigured: true,
      staffCapacity: [{ id: "staff_1", skills: [], shifts: [fullShift], busy: [] }],
    });
    expect(computeDaySlots(staffed).some((slot) => slot.start === c.openMs)).toBe(true);
  });

  it("requires every service skill and excludes busy or off-shift staff", () => {
    const c = ctx({
      staffingConfigured: true,
      requiredSkills: ["Ceramic", "polishing"],
      staffCapacity: [
        { id: "partial", skills: ["ceramic"], shifts: [{ start: 0, end: 20 * DAY }], busy: [] },
        {
          id: "eligible",
          skills: [" POLISHING ", "CERAMIC"],
          shifts: [{ start: 0, end: 20 * DAY }],
          busy: [],
        },
      ],
    });
    const window = { start: c.openMs!, end: c.openMs! + 2 * HOUR };
    expect(pickFreeStaff(c, window)).toBe("eligible");

    c.staffCapacity[1].busy.push(window);
    expect(pickFreeStaff(c, window)).toBeNull();
    expect(computeDaySlots(c).some((slot) => slot.start === window.start)).toBe(false);
  });

  it("reserves configured staff capacity for legacy unassigned appointments", () => {
    const c = ctx({
      staffingConfigured: true,
      staffCapacity: [{
        id: "staff_1",
        skills: [],
        shifts: [{ start: 0, end: 20 * DAY }],
        busy: [],
      }],
    });
    const window = { start: c.openMs!, end: c.openMs! + 2 * HOUR };
    c.unassignedStaffBusy.push(window);
    expect(pickFreeStaff(c, window)).toBeNull();
  });
});

describe("pickFreeBay", () => {
  const window = { start: 0, end: HOUR };
  it("returns null when every bay overlaps", () => {
    expect(pickFreeBay({ busyByBay: [[window], [window]], unassignedBusy: [] }, window)).toBeNull();
  });
  it("picks a free bay", () => {
    const bay = pickFreeBay({ busyByBay: [[window], []], unassignedBusy: [] }, window);
    expect(bay).toBe(1);
  });
  it("reserves capacity for unassigned appointments", () => {
    expect(
      pickFreeBay({ busyByBay: [[], [window]], unassignedBusy: [window] }, window),
    ).toBeNull();
  });
});
