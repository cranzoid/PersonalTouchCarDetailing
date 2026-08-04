/** Canonical enum values for text columns in src/db/schema.ts. */

export const STAFF_ROLES = [
  "owner",
  "manager",
  "reception",
  "technician",
  "accountant",
] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

export const VEHICLE_CATEGORIES = [
  "coupe",
  "sedan",
  "suv_small",
  "suv_large",
  "pickup",
  "van",
  "commercial",
  "other",
] as const;
export type VehicleCategory = (typeof VEHICLE_CATEGORIES)[number];

export const VEHICLE_CATEGORY_LABELS: Record<VehicleCategory, string> = {
  coupe: "Coupe",
  sedan: "Sedan",
  suv_small: "Small SUV",
  suv_large: "Large SUV",
  pickup: "Pickup Truck",
  van: "Van / Minivan",
  commercial: "Commercial Vehicle",
  other: "Other",
};

/**
 * Payment methods staff record by hand, i.e. money that arrived outside the
 * online checkout. Single source of truth for the Zod enums and the UI selects
 * — these values were previously repeated inline in five places, so adding one
 * meant finding all of them.
 *
 * `payments.provider` also accepts "stripe" (online checkout) and "fake"
 * (development), neither of which staff can select.
 */
export const MANUAL_PAYMENT_METHODS = ["cash", "cheque", "etransfer", "card_terminal"] as const;
export type ManualPaymentMethod = (typeof MANUAL_PAYMENT_METHODS)[number];

export const BOOKING_MODES = [
  "bookable",
  "quote_required",
  "inspection_required",
  "approval_required",
  "contact_only",
] as const;
export type BookingMode = (typeof BOOKING_MODES)[number];

export const APPOINTMENT_STATUSES = [
  "pending",
  "deposit_required",
  "confirmed",
  "arrived",
  "rescheduled",
  "cancelled",
  "no_show",
  "converted",
  "completed",
] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

/** Statuses that occupy calendar time (block availability). */
export const APPOINTMENT_BLOCKING_STATUSES: AppointmentStatus[] = [
  "pending",
  "deposit_required",
  "confirmed",
  "arrived",
  "converted",
];

/**
 * The shop floor runs on three working stages plus the handover. Inspection,
 * QC and additional-work approval still exist as records — they are optional
 * side activities on a job, not statuses everyone has to click through.
 */
export const JOB_STATUSES = [
  "checked_in",
  "in_progress",
  "ready_for_pickup",
  "completed",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const JOB_STATUS_LABELS: Record<JobStatus, string> = {
  checked_in: "Checked in",
  in_progress: "In progress",
  ready_for_pickup: "Ready for pickup",
  completed: "Completed",
};

/**
 * Statuses retired when the pipeline was cut down to three stages. Live rows
 * are deliberately NOT rewritten — a job that was sitting in `quality_check`
 * when this shipped keeps its stored value and is read through this map, so
 * it still renders and can still be moved forward. Normalize with
 * `normalizeJobStatus` before touching the state machine.
 */
export const LEGACY_JOB_STATUS_MAP: Record<string, JobStatus> = {
  // Pre-work stages all collapse into "checked in".
  inspection: "checked_in",
  awaiting_approval: "checked_in",
  ready: "checked_in",
  // Anything mid-work or being reworked reads as "in progress".
  paused: "in_progress",
  quality_check: "in_progress",
  correction_required: "in_progress",
};

/** Legal job status transitions (state machine, enforced server-side). */
export const JOB_TRANSITIONS: Record<JobStatus, JobStatus[]> = {
  checked_in: ["in_progress"],
  // Back to checked_in undoes a premature start; ready_for_pickup is the
  // normal exit and no longer waits on a QC checklist.
  in_progress: ["ready_for_pickup", "checked_in"],
  // Reopening a pickup-ready job replaces the old correction_required stage.
  ready_for_pickup: ["completed", "in_progress"],
  completed: [],
};

export const ESTIMATE_STATUSES = [
  "draft",
  "sent",
  "viewed",
  "changes_requested",
  "approved",
  "declined",
  "expired",
  "converted",
] as const;
export type EstimateStatus = (typeof ESTIMATE_STATUSES)[number];

export const INVOICE_STATUSES = [
  "draft",
  "sent",
  "partially_paid",
  "paid",
  "overdue",
  "cancelled",
  "refunded",
] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export const QC_CHECKLIST_ITEMS = [
  { key: "exterior_complete", label: "Exterior complete" },
  { key: "interior_complete", label: "Interior complete" },
  { key: "glass_checked", label: "Glass checked" },
  { key: "wheels_tyres_checked", label: "Wheels and tyres checked" },
  { key: "door_jambs_checked", label: "Door jambs checked" },
  { key: "no_product_residue", label: "No product residue" },
  { key: "customer_requests_completed", label: "Customer requests completed" },
  { key: "belongings_returned", label: "Personal belongings returned" },
  { key: "final_photos_taken", label: "Final photographs taken" },
  { key: "invoice_reviewed", label: "Invoice reviewed" },
] as const;
