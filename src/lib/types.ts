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

/**
 * Every way an invoice can be settled, including the online checkout. This is
 * the list staff choose from when raising an invoice ("How will they pay?"),
 * because the answer decides whether the document charges tax.
 */
export const QUOTED_PAYMENT_METHODS = [
  "cash",
  "etransfer",
  "card_terminal",
  "stripe",
  "cheque",
] as const;
export type QuotedPaymentMethod = (typeof QUOTED_PAYMENT_METHODS)[number];

export const QUOTED_PAYMENT_METHOD_LABELS: Record<QuotedPaymentMethod, string> = {
  cash: "Cash",
  etransfer: "Interac e-transfer",
  card_terminal: "Credit / debit card",
  stripe: "Card online",
  cheque: "Cheque",
};

/**
 * Whether a payment method makes the sale taxable — the shop's pricing rule,
 * confirmed by the owner on 2026-08-18 and implemented literally.
 *
 * All listed prices are tax-exclusive. Cash and Interac e-transfer are recorded
 * with no tax charged; credit and cheque add HST. "Interac" here means
 * e-transfer, NOT Interac debit at the terminal — a card terminal is credit.
 *
 * NOTE, recorded deliberately: the business is an HST registrant, and a
 * registrant owes HST on every taxable supply regardless of how the customer
 * pays. Recording a cash sale with no tax therefore UNDERSTATES HST collected.
 * This was raised with the owner, who chose the literal reading of the tracker
 * anyway. `invoices.tax_treatment` exists so restating it later is a query.
 * Do not "improve" this map to tax-inclusive — raise it with the owner instead.
 */
export const PAYMENT_METHOD_TAXABLE: Record<QuotedPaymentMethod, boolean> = {
  cash: false,
  etransfer: false,
  card_terminal: true,
  stripe: true,
  cheque: true,
};

/** Whether an invoice document added tax, and (via quotedPaymentMethod) why. */
export const TAX_TREATMENTS = ["added", "none"] as const;
export type TaxTreatment = (typeof TAX_TREATMENTS)[number];

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

/* ------------------------------------------------------------------ */
/* Labour                                                              */
/* ------------------------------------------------------------------ */

/**
 * How a staff member is paid. Drives both the per-day figure a timesheet
 * freezes and how the payroll report accrues what is owed:
 *
 *   hourly        — minutes x hourly_rate, earned day by day
 *   daily_fixed   — a flat day rate for any day worked at all
 *   monthly_fixed — a salary that accrues per calendar month, not per day
 */
export const PAY_TYPES = ["hourly", "daily_fixed", "monthly_fixed"] as const;
export type PayType = (typeof PAY_TYPES)[number];

export const PAY_TYPE_LABELS: Record<PayType, string> = {
  hourly: "Hourly",
  daily_fixed: "Fixed daily rate",
  monthly_fixed: "Monthly salary",
};

/** Which rate field a pay type actually uses; the others stay hidden and unused. */
export const PAY_TYPE_RATE_FIELD: Record<PayType, "hourlyRateCents" | "dailyRateCents" | "monthlySalaryCents"> = {
  hourly: "hourlyRateCents",
  daily_fixed: "dailyRateCents",
  monthly_fixed: "monthlySalaryCents",
};

/* ------------------------------------------------------------------ */
/* Bookkeeping                                                         */
/* ------------------------------------------------------------------ */

/**
 * How an outgoing payment left the business. A superset of
 * MANUAL_PAYMENT_METHODS: recurring bills are usually on preauthorized debit,
 * which is not a way a customer ever pays us.
 */
export const EXPENSE_PAYMENT_METHODS = [
  "cash",
  "cheque",
  "etransfer",
  "card_terminal",
  "preauthorized",
  "other",
] as const;
export type ExpensePaymentMethod = (typeof EXPENSE_PAYMENT_METHODS)[number];

export const EXPENSE_PAYMENT_METHOD_LABELS: Record<ExpensePaymentMethod, string> = {
  cash: "Cash",
  cheque: "Cheque",
  etransfer: "E-transfer",
  card_terminal: "Debit / credit card",
  preauthorized: "Preauthorized debit",
  other: "Other",
};

/**
 * The expense categories the shop's tracker uses. Seeded on first run and
 * fully editable afterwards in Admin → Settings → Expense categories, so this
 * list is a starting point, never a hard-coded enum.
 *
 * `isPayroll` drives two things: the payroll balance in Reports, and the
 * blocking rule that an expense in one of these categories must name the staff
 * member it paid (matching on staff id, never a typed name).
 */
export const DEFAULT_EXPENSE_CATEGORIES = [
  { name: "Worker Pay", isPayroll: true },
  { name: "Manager Pay", isPayroll: true },
  { name: "Vendor / Supplies", isPayroll: false },
  { name: "Rent", isPayroll: false },
  { name: "Hydro", isPayroll: false },
  { name: "Electric", isPayroll: false },
  { name: "Gas", isPayroll: false },
  { name: "Phone / Internet", isPayroll: false },
  { name: "Insurance", isPayroll: false },
  { name: "Advertising", isPayroll: false },
  { name: "Repairs / Maintenance", isPayroll: false },
  { name: "Other", isPayroll: false },
] as const;
