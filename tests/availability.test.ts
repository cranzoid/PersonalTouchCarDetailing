import { describe, expect, it } from "vitest";
import {
  assessOverrideWindow,
  computeDaySlots,
  overrideStartMs,
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

  it("hides slots inside the minimum notice window", () => {
    // "Now" is one hour before opening, so a 24h notice rule blocks the day.
    const sameDay = computeDaySlots(ctx({ nowMs: 7 * DAY - HOUR }));
    expect(sameDay).toHaveLength(0);
  });

  it("offers same-day and past slots for staff who opt out of the booking window", () => {
    // Same guard as above, plus the staff override.
    const sameDay = computeDaySlots(
      ctx({ nowMs: 7 * DAY - HOUR, allowOutsideBookingWindow: true }),
    );
    expect(sameDay).toHaveLength(13);

    // A day that has already finished — recording a walk-in after the fact.
    const past = computeDaySlots(ctx({ nowMs: 7 * DAY + 30 * DAY, allowOutsideBookingWindow: true }));
    expect(past).toHaveLength(13);

    // ...and beyond the forward booking window.
    const farFuture = computeDaySlots(
      ctx({ nowMs: 7 * DAY - 400 * DAY, allowOutsideBookingWindow: true }),
    );
    expect(farFuture).toHaveLength(13);
  });

  it("still refuses conflicting slots when staff override the booking window", () => {
    const open = 7 * DAY;
    // Both bays busy for the whole day: the override must not create capacity.
    const busy = [{ start: open, end: open + 8 * HOUR }];
    const slots = computeDaySlots(
      ctx({
        nowMs: open - HOUR,
        allowOutsideBookingWindow: true,
        busyByBay: [busy, busy],
      }),
    );
    expect(slots).toHaveLength(0);
  });

  it("still honours whole-business closures when staff override the window", () => {
    const open = 7 * DAY;
    const slots = computeDaySlots(
      ctx({
        nowMs: open - HOUR,
        allowOutsideBookingWindow: true,
        globalBlocks: [{ start: open, end: open + 8 * HOUR }],
      }),
    );
    expect(slots).toHaveLength(0);
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

describe("assessOverrideWindow", () => {
  // Labels in hours from the epoch anchor, so assertions read as clock times.
  const label = (ms: number) => `${(ms - 7 * DAY) / HOUR + 9}h`;

  it("reports why an ordinary slot would not have been offered: a 4h job at 5pm runs past a 5pm close", () => {
    const c = ctx({ totalDurationMin: 240 });
    // The reported case: nothing offered after 2pm for a 210-minute job, and
    // here the whole job would end 4h after closing.
    const window = { start: c.closeMs!, end: c.closeMs! + 4 * HOUR };
    const result = assessOverrideWindow(c, window, label);
    expect(result.warnings).toEqual(["It runs until 21h, past closing (17h)."]);
    expect(result.bayIdx).toBe(1);
  });

  it("finds nothing to confirm for a time that is an ordinary open slot", () => {
    const c = ctx();
    const window = { start: c.openMs!, end: c.openMs! + 2 * HOUR };
    expect(assessOverrideWindow(c, window, label).warnings).toEqual([]);
  });

  it("names a closed day, a closure, a taken bay and a missing technician", () => {
    const window = { start: 7 * DAY, end: 7 * DAY + 2 * HOUR };
    const result = assessOverrideWindow(
      ctx({
        openMs: null,
        closeMs: null,
        busyByBay: [[window], [window]],
        globalBlocks: [window],
        staffingConfigured: true,
      }),
      window,
      label,
    );
    expect(result.warnings).toHaveLength(4);
    expect(result.warnings[0]).toMatch(/closed that day/);
    expect(result.bayIdx).toBeNull();
    expect(result.staffId).toBeNull();
  });

  it("flags a start before opening", () => {
    const c = ctx();
    const window = { start: c.openMs! - HOUR, end: c.openMs! + HOUR };
    expect(assessOverrideWindow(c, window, label).warnings).toEqual(["It starts before opening (9h)."]);
  });
});

describe("overrideStartMs", () => {
  it("reads the typed wall time in the business timezone, across DST", () => {
    // 5pm in Toronto is 21:00 UTC in summer (EDT) and 22:00 UTC in winter (EST).
    expect(new Date(overrideStartMs("America/Toronto", "2026-07-15", "17:00")).toISOString()).toBe("2026-07-15T21:00:00.000Z");
    expect(new Date(overrideStartMs("America/Toronto", "2026-12-15", "17:00")).toISOString()).toBe("2026-12-15T22:00:00.000Z");
  });
});
