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

export const JOB_STATUSES = [
  "checked_in",
  "inspection",
  "awaiting_approval",
  "ready",
  "in_progress",
  "paused",
  "quality_check",
  "correction_required",
  "ready_for_pickup",
  "completed",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** Legal job status transitions (state machine, enforced server-side). */
export const JOB_TRANSITIONS: Record<JobStatus, JobStatus[]> = {
  checked_in: ["inspection", "ready", "in_progress"],
  inspection: ["awaiting_approval", "ready", "in_progress"],
  awaiting_approval: ["ready", "in_progress", "inspection"],
  ready: ["in_progress"],
  in_progress: ["paused", "quality_check"],
  paused: ["in_progress"],
  quality_check: ["correction_required", "ready_for_pickup"],
  correction_required: ["in_progress"],
  ready_for_pickup: ["completed"],
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
