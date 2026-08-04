import { describe, expect, it } from "vitest";
import {
  canTransitionJob,
  defaultQcItems,
  isJobOpenForSideWork,
  isJobStatus,
  isQcComplete,
  jobStatusLabel,
  normalizeJobStatus,
} from "../src/lib/job-status";
import {
  JOB_STATUSES,
  JOB_TRANSITIONS,
  LEGACY_JOB_STATUS_MAP,
  QC_CHECKLIST_ITEMS,
  type JobStatus,
} from "../src/lib/types";

describe("job state machine", () => {
  it("runs three working stages plus the handover", () => {
    const path: JobStatus[] = ["checked_in", "in_progress", "ready_for_pickup", "completed"];
    expect(JOB_STATUSES).toEqual(path);
    for (let i = 0; i < path.length - 1; i++) {
      expect(canTransitionJob(path[i], path[i + 1]), `${path[i]} → ${path[i + 1]}`).toBe(true);
    }
  });

  it("allows a correction step back at each stage", () => {
    expect(canTransitionJob("in_progress", "checked_in")).toBe(true);
    expect(canTransitionJob("ready_for_pickup", "in_progress")).toBe(true);
  });

  it("rejects skipping stages", () => {
    expect(canTransitionJob("checked_in", "completed")).toBe(false);
    expect(canTransitionJob("checked_in", "ready_for_pickup")).toBe(false);
    expect(canTransitionJob("in_progress", "in_progress")).toBe(false);
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

describe("legacy job statuses", () => {
  it("keeps jobs stored under a retired status movable", () => {
    // These rows are never rewritten, so every retired value must map onto a
    // stage that still has somewhere to go.
    for (const [legacy, mapped] of Object.entries(LEGACY_JOB_STATUS_MAP)) {
      expect(isJobStatus(legacy), `${legacy} should no longer be a live status`).toBe(false);
      expect(normalizeJobStatus(legacy)).toBe(mapped);
      expect(JOB_TRANSITIONS[mapped].length).toBeGreaterThan(0);
    }
  });

  it("maps pre-work stages to checked in and mid-work stages to in progress", () => {
    expect(normalizeJobStatus("inspection")).toBe("checked_in");
    expect(normalizeJobStatus("awaiting_approval")).toBe("checked_in");
    expect(normalizeJobStatus("ready")).toBe("checked_in");
    expect(normalizeJobStatus("paused")).toBe("in_progress");
    expect(normalizeJobStatus("quality_check")).toBe("in_progress");
    expect(normalizeJobStatus("correction_required")).toBe("in_progress");
  });

  it("passes current statuses through untouched", () => {
    for (const status of JOB_STATUSES) expect(normalizeJobStatus(status)).toBe(status);
  });

  it("returns null for a value that was never a job status", () => {
    expect(normalizeJobStatus("detailing")).toBeNull();
    expect(normalizeJobStatus("")).toBeNull();
  });

  it("labels legacy and unknown values without crashing", () => {
    expect(jobStatusLabel("quality_check")).toBe("In progress");
    expect(jobStatusLabel("ready_for_pickup")).toBe("Ready for pickup");
    expect(jobStatusLabel("detailing")).toBe("detailing");
  });
});

describe("isJobOpenForSideWork", () => {
  it("allows inspection and additional work until the vehicle is handed back", () => {
    expect(isJobOpenForSideWork("checked_in")).toBe(true);
    expect(isJobOpenForSideWork("in_progress")).toBe(true);
    // Legacy rows resolve through the same rule.
    expect(isJobOpenForSideWork("quality_check")).toBe(true);
    expect(isJobOpenForSideWork("ready")).toBe(true);
  });

  it("closes once the job is ready for pickup or completed", () => {
    expect(isJobOpenForSideWork("ready_for_pickup")).toBe(false);
    expect(isJobOpenForSideWork("completed")).toBe(false);
    expect(isJobOpenForSideWork("detailing")).toBe(false);
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

  it("defaults every item to passed", () => {
    expect(isQcComplete(defaultQcItems())).toBe(true);
  });
});
