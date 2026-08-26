import {
  JOB_TRANSITIONS,
  JOB_STATUSES,
  JOB_STATUS_LABELS,
  LEGACY_JOB_STATUS_MAP,
  QC_CHECKLIST_ITEMS,
  type JobStatus,
} from "@/lib/types";

/**
 * Pure job-status rules, shared by the admin pipeline, its client components
 * and the customer additional-work portal. Deliberately free of database
 * imports so client components can use it; anything needing the database
 * lives in `@/lib/jobs`.
 *
 * Status changes always go through canTransitionJob — the state machine in
 * JOB_TRANSITIONS is the single source of truth, enforced server-side.
 */

export function isJobStatus(value: string): value is JobStatus {
  return (JOB_STATUSES as readonly string[]).includes(value);
}

/**
 * Reads a stored status as one of the current stages, translating any of the
 * retired values still sitting on live rows. Returns null only for a value
 * that was never a job status at all.
 */
export function normalizeJobStatus(value: string): JobStatus | null {
  if (isJobStatus(value)) return value;
  return LEGACY_JOB_STATUS_MAP[value] ?? null;
}

/** Display label for a stored status, legacy values included. */
export function jobStatusLabel(value: string): string {
  const status = normalizeJobStatus(value);
  return status ? JOB_STATUS_LABELS[status] : value.replaceAll("_", " ");
}

export function canTransitionJob(from: JobStatus, to: JobStatus): boolean {
  return JOB_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Inspection and additional work are optional side activities on an open job
 * rather than pipeline stages, so both are available right up until the
 * vehicle is handed back.
 */
const OPEN_JOB_STATUSES: JobStatus[] = ["checked_in", "in_progress"];

export function isJobOpenForSideWork(storedStatus: string): boolean {
  const status = normalizeJobStatus(storedStatus);
  return status !== null && OPEN_JOB_STATUSES.includes(status);
}

/**
 * Stages at which the booked packages may still be re-priced.
 *
 * Deliberately wider than OPEN_JOB_STATUSES, and the difference matters: an
 * invoice is only raised from `ready_for_pickup` onwards, so gating a revision
 * on side-work openness would mean a booking could never be re-priced at the
 * exact moment an invoice exists to correct. The counter conversation — "make
 * it the full package" — usually happens over the finished car.
 *
 * `completed` is excluded: the vehicle has been handed back and the money
 * settled, which is a credit note, not a revision.
 */
const REPRICEABLE_JOB_STATUSES: JobStatus[] = ["checked_in", "in_progress", "ready_for_pickup"];

export function isJobOpenForRepricing(storedStatus: string): boolean {
  const status = normalizeJobStatus(storedStatus);
  return status !== null && REPRICEABLE_JOB_STATUSES.includes(status);
}

/** True when every QC checklist item has been ticked. */
export function isQcComplete(items: Record<string, boolean>): boolean {
  return QC_CHECKLIST_ITEMS.every((item) => items[item.key] === true);
}

/**
 * QC is passed by default: the checklist is a record staff can correct, not a
 * gate they have to clear. Used to stamp a job that reaches pickup without
 * anyone having opened the checklist.
 */
export function defaultQcItems(): Record<string, boolean> {
  return Object.fromEntries(QC_CHECKLIST_ITEMS.map((item) => [item.key, true]));
}
