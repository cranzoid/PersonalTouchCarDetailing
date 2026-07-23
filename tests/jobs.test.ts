import { describe, expect, it } from "vitest";
import { canTransitionJob, isJobStatus, isQcComplete } from "../src/lib/jobs";
import { JOB_STATUSES, JOB_TRANSITIONS, QC_CHECKLIST_ITEMS, type JobStatus } from "../src/lib/types";

describe("job state machine", () => {
  it("allows the happy path through the shop", () => {
    const path: JobStatus[] = [
      "checked_in",
      "inspection",
      "awaiting_approval",
      "ready",
      "in_progress",
      "quality_check",
      "ready_for_pickup",
      "completed",
    ];
    for (let i = 0; i < path.length - 1; i++) {
      expect(canTransitionJob(path[i], path[i + 1]), `${path[i]} → ${path[i + 1]}`).toBe(true);
    }
  });

  it("allows pause/resume and QC correction loops", () => {
    expect(canTransitionJob("in_progress", "paused")).toBe(true);
    expect(canTransitionJob("paused", "in_progress")).toBe(true);
    expect(canTransitionJob("quality_check", "correction_required")).toBe(true);
    expect(canTransitionJob("correction_required", "in_progress")).toBe(true);
  });

  it("rejects skipping stages and moving backwards illegally", () => {
    expect(canTransitionJob("checked_in", "completed")).toBe(false);
    expect(canTransitionJob("checked_in", "quality_check")).toBe(false);
    expect(canTransitionJob("in_progress", "ready_for_pickup")).toBe(false);
    expect(canTransitionJob("ready_for_pickup", "in_progress")).toBe(false);
    expect(canTransitionJob("ready", "ready")).toBe(false);
  });

  it("treats completed as terminal", () => {
    for (const to of JOB_STATUSES) {
      expect(canTransitionJob("completed", to)).toBe(false);
    }
  });

  it("only references valid statuses in the transition map", () => {
    for (const [from, targets] of Object.entries(JOB_TRANSITIONS)) {
      expect(isJobStatus(from)).toBe(true);
      for (const to of targets) expect(isJobStatus(to)).toBe(true);
    }
  });

  it("recognises unknown statuses", () => {
    expect(isJobStatus("detailing")).toBe(false);
    expect(isJobStatus("")).toBe(false);
  });
});

describe("isQcComplete", () => {
  const allChecked = Object.fromEntries(QC_CHECKLIST_ITEMS.map((i) => [i.key, true]));

  it("passes only when every checklist item is ticked", () => {
    expect(isQcComplete(allChecked)).toBe(true);
    expect(isQcComplete({})).toBe(false);
    expect(isQcComplete({ ...allChecked, [QC_CHECKLIST_ITEMS[0].key]: false })).toBe(false);
  });

  it("ignores a missing single item", () => {
    const missingOne = { ...allChecked };
    delete missingOne[QC_CHECKLIST_ITEMS[QC_CHECKLIST_ITEMS.length - 1].key];
    expect(isQcComplete(missingOne)).toBe(false);
  });

  it("ignores unknown extra keys", () => {
    expect(isQcComplete({ ...allChecked, made_up_item: false })).toBe(true);
  });
});
