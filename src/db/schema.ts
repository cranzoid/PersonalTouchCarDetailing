import {
  pgTable,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Conventions
 * - ids: app-generated prefixed text ids (src/lib/id.ts)
 * - money: integer cents (`*_cents`); rates: basis points (`*_bp`)
 * - enum-ish columns are text; the allowed values live in src/lib/types.ts and
 *   are enforced by Zod at boundaries and by domain state machines.
 * - timestamps are timestamptz (UTC). Business-local math happens in code.
 * - financial rows are never deleted; cancellation is a status + audit entry.
 */

const id = () => text("id").primaryKey();
const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

/* ------------------------------------------------------------------ */
/* Identity & access                                                   */
/* ------------------------------------------------------------------ */

export const staffUsers = pgTable("staff_users", {
  id: id(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: text("role").notNull(), // owner | manager | reception | technician | accountant
  skills: text("skills").array().notNull().default([]),
  active: boolean("active").notNull().default(true),
  /**
   * How this person is paid — hourly | daily_fixed | monthly_fixed (PAY_TYPES).
   * Everyone starts `hourly` at a zero rate, which earns nothing, so the
   * defaults cannot invent payroll for staff whose terms nobody has entered.
   */
  payType: text("pay_type").notNull().default("hourly"),
  hourlyRateCents: integer("hourly_rate_cents").notNull().default(0),
  dailyRateCents: integer("daily_rate_cents").notNull().default(0),
  monthlySalaryCents: integer("monthly_salary_cents").notNull().default(0),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const staffSessions = pgTable(
  "staff_sessions",
  {
    id: id(),
    tokenHash: text("token_hash").notNull().unique(),
    staffUserId: text("staff_user_id")
      .notNull()
      .references(() => staffUsers.id),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ip: text("ip"),
    userAgent: text("user_agent"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("staff_sessions_user_idx").on(t.staffUserId)],
);

/** Customer-facing tokened links (estimate view/approval, invoice pay, portal). */
export const accessTokens = pgTable(
  "access_tokens",
  {
    id: id(),
    tokenHash: text("token_hash").notNull().unique(),
    purpose: text("purpose").notNull(), // estimate_view | invoice_pay | appointment_deposit | portal | additional_work
    subjectType: text("subject_type").notNull(), // estimate | invoice | customer | additional_work_request
    subjectId: text("subject_id").notNull(),
    customerId: text("customer_id").references(() => customers.id),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("access_tokens_subject_idx").on(t.subjectType, t.subjectId)],
);

export const auditLog = pgTable(
  "audit_log",
  {
    id: id(),
    actorType: text("actor_type").notNull(), // staff | customer | system
    actorId: text("actor_id"),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    before: jsonb("before"),
    after: jsonb("after"),
    reason: text("reason"),
    ip: text("ip"),
    createdAt: createdAt(),
  },
  (t) => [index("audit_entity_idx").on(t.entityType, t.entityId)],
);

/** Persistent fixed-window counters used by public endpoint rate limiting. */
export const rateLimitBuckets = pgTable("rate_limit_buckets", {
  key: text("key").primaryKey(),
  count: integer("count").notNull().default(0),
  resetAt: timestamp("reset_at", { withTimezone: true }).notNull(),
  updatedAt: updatedAt(),
});

/* ------------------------------------------------------------------ */
/* CRM                                                                 */
/* ------------------------------------------------------------------ */

export const customers = pgTable(
  "customers",
  {
    id: id(),
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull().default(""),
    email: text("email"),
    phone: text("phone"),
    preferredContact: text("preferred_contact").notNull().default("email"), // email | sms | phone
    customerType: text("customer_type").notNull().default("individual"), // individual | business
    companyName: text("company_name"),
    tags: text("tags").array().notNull().default([]),
    notes: text("notes"),
    marketingConsent: boolean("marketing_consent").notNull().default(false),
    marketingConsentAt: timestamp("marketing_consent_at", { withTimezone: true }),
    marketingConsentSource: text("marketing_consent_source"),
    sourceLeadId: text("source_lead_id"),
    referredByCustomerId: text("referred_by_customer_id"),
    anonymizedAt: timestamp("anonymized_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("customers_email_idx").on(t.email), index("customers_phone_idx").on(t.phone)],
);

export const vehicles = pgTable(
  "vehicles",
  {
    id: id(),
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.id),
    year: integer("year"),
    make: text("make").notNull(),
    model: text("model").notNull(),
    trim: text("trim"),
    category: text("category").notNull(), // coupe | sedan | suv_small | suv_large | pickup | van | commercial | other
    colour: text("colour"),
    licencePlate: text("licence_plate"),
    conditionNotes: text("condition_notes"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("vehicles_customer_idx").on(t.customerId)],
);

/** Marketing attribution captured once and stored as jsonb on leads/appointments/quotes. */
export type Attribution = {
  source?: string; // google_ads | meta_ads | gbp | organic | phone | walk_in | referral | fleet | manual
  medium?: string;
  campaign?: string;
  ad?: string;
  keyword?: string;
  landingPage?: string;
  referrer?: string;
  utm?: Record<string, string>;
  gclid?: string;
  fbclid?: string;
  firstTouch?: Record<string, string>;
  lastTouch?: Record<string, string>;
  manualSource?: string;
  /** Raw ?offer= code the visitor arrived on, before it is validated. */
  offerCode?: string;
  offerCapturedAt?: string;
  /**
   * The offer once the server has resolved it against settings. Recorded on
   * leads (which have no prices, so no amount) and on appointments alongside
   * the locked discount columns.
   */
  promo?: { code: string; label: string; percentOffBp: number; at: string };
};

export const leads = pgTable(
  "leads",
  {
    id: id(),
    name: text("name").notNull(),
    email: text("email"),
    phone: text("phone"),
    message: text("message"),
    kind: text("kind").notNull().default("general"), // general | quote | booking | fleet | contact
    status: text("status").notNull().default("new"), // new | contacted | qualified | converted | lost
    attribution: jsonb("attribution").$type<Attribution>(),
    convertedCustomerId: text("converted_customer_id").references(() => customers.id),
    assignedStaffId: text("assigned_staff_id").references(() => staffUsers.id),
    notes: text("notes"),
    marketingConsent: boolean("marketing_consent").notNull().default(false),
    marketingConsentAt: timestamp("marketing_consent_at", { withTimezone: true }),
    marketingConsentSource: text("marketing_consent_source"),
    anonymizedAt: timestamp("anonymized_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("leads_status_idx").on(t.status)],
);

/* ------------------------------------------------------------------ */
/* Service catalog (fully staff-configurable)                          */
/* ------------------------------------------------------------------ */

export const serviceCategories = pgTable("service_categories", {
  id: id(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  description: text("description"),
  sort: integer("sort").notNull().default(0),
  active: boolean("active").notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const services = pgTable(
  "services",
  {
    id: id(),
    categoryId: text("category_id")
      .notNull()
      .references(() => serviceCategories.id),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    shortDescription: text("short_description"),
    longDescription: text("long_description"),
    /** Null when price is quote-only. */
    basePriceCents: integer("base_price_cents"),
    baseDurationMin: integer("base_duration_min").notNull().default(60),
    bookingMode: text("booking_mode").notNull().default("bookable"), // bookable | quote_required | inspection_required | approval_required | contact_only
    depositType: text("deposit_type").notNull().default("none"), // none | fixed | percent
    depositValue: integer("deposit_value").notNull().default(0), // cents when fixed, bp when percent
    requiredSkills: text("required_skills").array().notNull().default([]),
    photosRequiredForQuote: boolean("photos_required_for_quote").notNull().default(false),
    active: boolean("active").notNull().default(true),
    featured: boolean("featured").notNull().default(false),
    sort: integer("sort").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("services_category_idx").on(t.categoryId)],
);

export const serviceVehicleAdjustments = pgTable(
  "service_vehicle_adjustments",
  {
    id: id(),
    serviceId: text("service_id")
      .notNull()
      .references(() => services.id),
    vehicleCategory: text("vehicle_category").notNull(),
    priceDeltaCents: integer("price_delta_cents").notNull().default(0),
    durationDeltaMin: integer("duration_delta_min").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("svc_vehicle_adj_unique").on(t.serviceId, t.vehicleCategory),
  ],
);

export const addons = pgTable("addons", {
  id: id(),
  name: text("name").notNull(),
  description: text("description"),
  priceCents: integer("price_cents").notNull().default(0),
  durationMin: integer("duration_min").notNull().default(0),
  active: boolean("active").notNull().default(true),
  sort: integer("sort").notNull().default(0),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const serviceAddons = pgTable(
  "service_addons",
  {
    id: id(),
    serviceId: text("service_id")
      .notNull()
      .references(() => services.id),
    addonId: text("addon_id")
      .notNull()
      .references(() => addons.id),
  },
  (t) => [uniqueIndex("service_addons_unique").on(t.serviceId, t.addonId)],
);

/* ------------------------------------------------------------------ */
/* Scheduling                                                          */
/* ------------------------------------------------------------------ */

export const resources = pgTable("resources", {
  id: id(),
  name: text("name").notNull(),
  type: text("type").notNull().default("bay"), // bay | equipment
  active: boolean("active").notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** Business-local times, "HH:MM". closed=true means no open/close. */
export const businessHours = pgTable(
  "business_hours",
  {
    id: id(),
    weekday: integer("weekday").notNull(), // 0=Sunday … 6=Saturday
    open: text("open"),
    close: text("close"),
    closed: boolean("closed").notNull().default(false),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("business_hours_weekday_unique").on(t.weekday)],
);

export const staffSchedules = pgTable(
  "staff_schedules",
  {
    id: id(),
    staffUserId: text("staff_user_id")
      .notNull()
      .references(() => staffUsers.id),
    weekday: integer("weekday").notNull(),
    start: text("start").notNull(), // "HH:MM" business-local
    end: text("end").notNull(),
  },
  (t) => [index("staff_schedules_user_idx").on(t.staffUserId)],
);

/** Holidays, closures, staff time-off, bay maintenance. */
export const scheduleBlocks = pgTable(
  "schedule_blocks",
  {
    id: id(),
    staffUserId: text("staff_user_id").references(() => staffUsers.id), // null = whole business
    resourceId: text("resource_id").references(() => resources.id), // null = all resources
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    reason: text("reason"),
    createdAt: createdAt(),
  },
  (t) => [index("schedule_blocks_time_idx").on(t.startsAt, t.endsAt)],
);

export const appointments = pgTable(
  "appointments",
  {
    id: id(),
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.id),
    vehicleId: text("vehicle_id")
      .notNull()
      .references(() => vehicles.id),
    status: text("status").notNull().default("pending"),
    // pending | deposit_required | confirmed | arrived | rescheduled | cancelled | no_show | converted | completed
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    /** Includes setup + cleanup buffers. */
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    assignedStaffId: text("assigned_staff_id").references(() => staffUsers.id),
    resourceId: text("resource_id").references(() => resources.id),
    /** Price/duration snapshot at booking time. */
    subtotalCents: integer("subtotal_cents").notNull().default(0),
    taxCents: integer("tax_cents").notNull().default(0),
    taxRateBp: integer("tax_rate_bp").notNull().default(0),
    totalCents: integer("total_cents").notNull().default(0),
    depositRequiredCents: integer("deposit_required_cents").notNull().default(0),
    depositPaidCents: integer("deposit_paid_cents").notNull().default(0),
    /**
     * Promotional discount locked at booking. Subtracted from the subtotal
     * BEFORE tax, exactly as computeInvoiceTotals does, so this row reconciles
     * with the invoice it later produces:
     *   subtotal_cents = sum of appointment_services (always gross)
     *   tax_cents      = tax(subtotal_cents - discount_cents, tax_rate_bp)
     *   total_cents    = subtotal_cents - discount_cents + tax_cents
     * Never recalculated — additional work approved at the shop is billed at
     * full price. Deliberately stores cents, not a rate: a stored percentage
     * would invite some later code path to recompute and break that promise.
     */
    discountCents: integer("discount_cents").notNull().default(0),
    /** Offer code applied at booking, for campaign reporting and support. */
    promoCode: text("promo_code"),
    /**
     * Customer-facing label as shown at booking, snapshotted for the same
     * reason tax_label/tax_rate_bp are (DECISIONS.md #6): editing the offer
     * later must not rewrite what this customer was shown.
     */
    promoLabel: text("promo_label"),
    durationMin: integer("duration_min").notNull(),
    customerNotes: text("customer_notes"),
    internalNotes: text("internal_notes"),
    attribution: jsonb("attribution").$type<Attribution>(),
    policiesAcceptedAt: timestamp("policies_accepted_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelledBy: text("cancelled_by"),
    cancellationReason: text("cancellation_reason"),
    jobId: text("job_id"),
    estimateId: text("estimate_id"),
    /** Stamped once the pre-appointment SMS reminder goes out — prevents duplicate sends. */
    reminderSentAt: timestamp("reminder_sent_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("appointments_time_idx").on(t.startsAt, t.endsAt),
    index("appointments_resource_idx").on(t.resourceId),
    index("appointments_staff_idx").on(t.assignedStaffId),
    index("appointments_customer_idx").on(t.customerId),
    index("appointments_status_idx").on(t.status),
  ],
);

/** Line-item snapshot of what was booked (services + addons). */
export const appointmentServices = pgTable(
  "appointment_services",
  {
    id: id(),
    appointmentId: text("appointment_id")
      .notNull()
      .references(() => appointments.id),
    serviceId: text("service_id").references(() => services.id),
    addonId: text("addon_id").references(() => addons.id),
    description: text("description").notNull(),
    priceCents: integer("price_cents").notNull(),
    durationMin: integer("duration_min").notNull(),
    sort: integer("sort").notNull().default(0),
  },
  (t) => [index("appointment_services_apt_idx").on(t.appointmentId)],
);

/* ------------------------------------------------------------------ */
/* Quotes & estimates                                                  */
/* ------------------------------------------------------------------ */

export const quoteRequests = pgTable(
  "quote_requests",
  {
    id: id(),
    leadId: text("lead_id").references(() => leads.id),
    customerId: text("customer_id").references(() => customers.id),
    vehicleId: text("vehicle_id").references(() => vehicles.id),
    /** Free-form vehicle info when no vehicle record exists yet. */
    vehicleInfo: jsonb("vehicle_info").$type<{
      year?: number;
      make?: string;
      model?: string;
      category?: string;
      colour?: string;
    }>(),
    requestedServiceIds: text("requested_service_ids").array().notNull().default([]),
    conditionDescription: text("condition_description"),
    status: text("status").notNull().default("new"), // new | reviewing | estimated | closed
    estimateId: text("estimate_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("quote_requests_status_idx").on(t.status)],
);

export const estimateCounters = pgTable("estimate_counters", {
  id: text("id").primaryKey(), // "default"
  nextNumber: integer("next_number").notNull().default(1000),
});

export const estimates = pgTable(
  "estimates",
  {
    id: id(),
    number: integer("number").notNull().unique(),
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.id),
    vehicleId: text("vehicle_id").references(() => vehicles.id),
    quoteRequestId: text("quote_request_id").references(() => quoteRequests.id),
    status: text("status").notNull().default("draft"),
    // draft | sent | viewed | changes_requested | approved | declined | expired | converted
    discountCents: integer("discount_cents").notNull().default(0),
    taxRateBp: integer("tax_rate_bp").notNull(),
    taxLabel: text("tax_label").notNull().default("HST"),
    depositRequiredCents: integer("deposit_required_cents").notNull().default(0),
    customerMessage: text("customer_message"),
    internalNotes: text("internal_notes"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    viewedAt: timestamp("viewed_at", { withTimezone: true }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    approvalName: text("approval_name"),
    approvalIp: text("approval_ip"),
    approvalUserAgent: text("approval_user_agent"),
    changeRequestMessage: text("change_request_message"),
    convertedToType: text("converted_to_type"), // appointment | job | invoice
    convertedToId: text("converted_to_id"),
    createdByStaffId: text("created_by_staff_id").references(() => staffUsers.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("estimates_customer_idx").on(t.customerId),
    index("estimates_status_idx").on(t.status),
  ],
);

export const estimateLineItems = pgTable(
  "estimate_line_items",
  {
    id: id(),
    estimateId: text("estimate_id")
      .notNull()
      .references(() => estimates.id),
    serviceId: text("service_id").references(() => services.id),
    description: text("description").notNull(),
    quantity: integer("quantity").notNull().default(1),
    unitPriceCents: integer("unit_price_cents").notNull(),
    isOptional: boolean("is_optional").notNull().default(false),
    isSelected: boolean("is_selected").notNull().default(true),
    sort: integer("sort").notNull().default(0),
  },
  (t) => [index("estimate_line_items_est_idx").on(t.estimateId)],
);

/* ------------------------------------------------------------------ */
/* Jobs, inspections, QC                                               */
/* ------------------------------------------------------------------ */

export const jobs = pgTable(
  "jobs",
  {
    id: id(),
    appointmentId: text("appointment_id").references(() => appointments.id),
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.id),
    vehicleId: text("vehicle_id")
      .notNull()
      .references(() => vehicles.id),
    status: text("status").notNull().default("checked_in"),
    // checked_in | in_progress | ready_for_pickup | completed
    // Existing rows may still hold a status retired in the three-stage
    // pipeline change (inspection, awaiting_approval, ready, paused,
    // quality_check, correction_required). They are never rewritten — read
    // them through normalizeJobStatus in src/lib/job-status.ts.
    assignedStaffId: text("assigned_staff_id").references(() => staffUsers.id),
    resourceId: text("resource_id").references(() => resources.id),
    mileageIn: integer("mileage_in"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    expectedReadyAt: timestamp("expected_ready_at", { withTimezone: true }),
    internalNotes: text("internal_notes"),
    invoiceId: text("invoice_id"),
    /** Stamped once the "time for your next detail?" reminder goes out — prevents duplicate sends. */
    maintenanceReminderSentAt: timestamp("maintenance_reminder_sent_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("jobs_status_idx").on(t.status),
    index("jobs_customer_idx").on(t.customerId),
  ],
);

export const inspections = pgTable("inspections", {
  id: id(),
  jobId: text("job_id")
    .notNull()
    .references(() => jobs.id),
  mileage: integer("mileage"),
  customerConcerns: text("customer_concerns"),
  personalBelongings: text("personal_belongings"),
  additionalWorkIdentified: text("additional_work_identified"),
  signatureFileId: text("signature_file_id"),
  completedByStaffId: text("completed_by_staff_id").references(() => staffUsers.id),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const inspectionFindings = pgTable(
  "inspection_findings",
  {
    id: id(),
    inspectionId: text("inspection_id")
      .notNull()
      .references(() => inspections.id),
    area: text("area").notNull(), // e.g. front_bumper, driver_seat
    type: text("type").notNull(), // scratch | dent | chip | stain | pet_hair | odour | dirt | other
    severity: text("severity").notNull().default("minor"), // minor | moderate | severe
    description: text("description"),
  },
  (t) => [index("inspection_findings_insp_idx").on(t.inspectionId)],
);

/**
 * Customer files & photos. PRIVATE BY DEFAULT.
 * publicConsentAt is a separate, explicit marketing-consent record — photos
 * never become gallery content automatically.
 */
export const files = pgTable(
  "files",
  {
    id: id(),
    entityType: text("entity_type").notNull(), // job | inspection | quote_request | estimate | vehicle | additional_work_request
    entityId: text("entity_id").notNull(),
    kind: text("kind").notNull().default("other"), // checkin | before | progress | after | damage | quote | signature | other
    storageKey: text("storage_key").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: integer("size_bytes").notNull().default(0),
    uploadedByType: text("uploaded_by_type").notNull(), // staff | customer | system
    uploadedById: text("uploaded_by_id"),
    publicConsentAt: timestamp("public_consent_at", { withTimezone: true }),
    publicConsentRecordedBy: text("public_consent_recorded_by"),
    createdAt: createdAt(),
  },
  (t) => [index("files_entity_idx").on(t.entityType, t.entityId)],
);

export const additionalWorkRequests = pgTable(
  "additional_work_requests",
  {
    id: id(),
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id),
    description: text("description").notNull(),
    priceCents: integer("price_cents").notNull(),
    extraMinutes: integer("extra_minutes").notNull().default(0),
    status: text("status").notNull().default("pending"), // pending | approved | declined | override_approved
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decidedVia: text("decided_via"), // customer_link | staff_override
    overrideStaffId: text("override_staff_id").references(() => staffUsers.id),
    overrideReason: text("override_reason"),
    createdByStaffId: text("created_by_staff_id").references(() => staffUsers.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("awr_job_idx").on(t.jobId)],
);

export const qcChecklists = pgTable("qc_checklists", {
  id: id(),
  jobId: text("job_id")
    .notNull()
    .references(() => jobs.id)
    .unique(),
  items: jsonb("items")
    .$type<Record<string, boolean>>()
    .notNull()
    .default({}),
  notes: text("notes"),
  completedByStaffId: text("completed_by_staff_id").references(() => staffUsers.id),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/* ------------------------------------------------------------------ */
/* Invoicing & payments                                                */
/* ------------------------------------------------------------------ */

export const invoiceCounters = pgTable("invoice_counters", {
  id: text("id").primaryKey(), // "default"
  nextNumber: integer("next_number").notNull().default(1000),
});

export const invoices = pgTable(
  "invoices",
  {
    id: id(),
    number: integer("number").notNull().unique(),
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.id),
    vehicleId: text("vehicle_id").references(() => vehicles.id),
    jobId: text("job_id").references(() => jobs.id),
    status: text("status").notNull().default("draft"),
    // draft | sent | partially_paid | paid | overdue | cancelled | refunded
    subtotalCents: integer("subtotal_cents").notNull().default(0),
    discountCents: integer("discount_cents").notNull().default(0),
    taxRateBp: integer("tax_rate_bp").notNull(),
    taxLabel: text("tax_label").notNull().default("HST"),
    taxRegistrationNumber: text("tax_registration_number"),
    taxCents: integer("tax_cents").notNull().default(0),
    /**
     * Set when no tax was charged. `taxRateBp`/`taxCents` are still snapshotted
     * as 0 so historical documents stay self-describing; this flag plus the
     * reason are what make the exemption auditable and reportable.
     */
    taxExempt: boolean("tax_exempt").notNull().default(false),
    taxExemptReason: text("tax_exempt_reason"),
    totalCents: integer("total_cents").notNull().default(0),
    depositAppliedCents: integer("deposit_applied_cents").notNull().default(0),
    /**
     * The date the invoice is issued for, which may be backdated for work
     * already performed. Reads fall back to `createdAt` for rows predating
     * this column.
     */
    invoiceDate: timestamp("invoice_date", { withTimezone: true }),
    /** Set for invoices raised by hand rather than derived from a job. */
    createdByStaffId: text("created_by_staff_id").references(() => staffUsers.id),
    dueAt: timestamp("due_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelledByStaffId: text("cancelled_by_staff_id").references(() => staffUsers.id),
    cancellationReason: text("cancellation_reason"),
    notes: text("notes"),
    /** Stamped once the post-payment review-request send fires — prevents duplicate sends. */
    reviewRequestSentAt: timestamp("review_request_sent_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("invoices_customer_idx").on(t.customerId),
    index("invoices_status_idx").on(t.status),
  ],
);

export const invoiceLineItems = pgTable(
  "invoice_line_items",
  {
    id: id(),
    invoiceId: text("invoice_id")
      .notNull()
      .references(() => invoices.id),
    serviceId: text("service_id").references(() => services.id),
    description: text("description").notNull(),
    quantity: integer("quantity").notNull().default(1),
    unitPriceCents: integer("unit_price_cents").notNull(),
    sort: integer("sort").notNull().default(0),
  },
  (t) => [index("invoice_line_items_inv_idx").on(t.invoiceId)],
);

/**
 * A single invoice may cover several fleet jobs. `invoices.jobId` remains the
 * convenient legacy pointer for normal one-job invoices; this join is the
 * authoritative multi-job relationship and enforces one invoice per job.
 */
export const invoiceJobs = pgTable(
  "invoice_jobs",
  {
    id: id(),
    invoiceId: text("invoice_id")
      .notNull()
      .references(() => invoices.id),
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id),
    createdAt: createdAt(),
  },
  (t) => [
    index("invoice_jobs_invoice_idx").on(t.invoiceId),
    uniqueIndex("invoice_jobs_job_uq").on(t.jobId),
    uniqueIndex("invoice_jobs_invoice_job_uq").on(t.invoiceId, t.jobId),
  ],
);

export const payments = pgTable(
  "payments",
  {
    id: id(),
    invoiceId: text("invoice_id").references(() => invoices.id),
    appointmentId: text("appointment_id").references(() => appointments.id),
    customerId: text("customer_id").references(() => customers.id),
    provider: text("provider").notNull(), // see MANUAL_PAYMENT_METHODS in src/lib/types.ts, plus "stripe" and "fake"
    providerRef: text("provider_ref"),
    /** Client- or system-supplied key; unique constraint makes retries no-ops. */
    idempotencyKey: text("idempotency_key").notNull().unique(),
    kind: text("kind").notNull(), // deposit | payment | refund
    amountCents: integer("amount_cents").notNull(),
    status: text("status").notNull().default("pending"), // pending | succeeded | failed
    failureReason: text("failure_reason"),
    receivedAt: timestamp("received_at", { withTimezone: true }),
    recordedByStaffId: text("recorded_by_staff_id").references(() => staffUsers.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("payments_invoice_idx").on(t.invoiceId)],
);

/** Raw provider webhook events; unique event id = duplicate deliveries are no-ops. */
export const webhookEvents = pgTable("webhook_events", {
  id: id(),
  provider: text("provider").notNull(),
  eventId: text("event_id").notNull().unique(),
  eventType: text("event_type").notNull(),
  payload: jsonb("payload").notNull(),
  processedAt: timestamp("processed_at", { withTimezone: true }),
  error: text("error"),
  createdAt: createdAt(),
});

/* ------------------------------------------------------------------ */
/* Communications                                                      */
/* ------------------------------------------------------------------ */

export const communications = pgTable(
  "communications",
  {
    id: id(),
    customerId: text("customer_id").references(() => customers.id),
    leadId: text("lead_id").references(() => leads.id),
    direction: text("direction").notNull().default("outbound"), // outbound | inbound | internal
    channel: text("channel").notNull(), // email | sms | phone | internal
    kind: text("kind").notNull(), // confirmation | reminder | estimate | approval_request | deposit_reminder |
    // delay | ready | invoice | receipt | review_request | maintenance | marketing | manual | note | lead_ack
    subject: text("subject"),
    body: text("body").notNull(),
    relatedEntityType: text("related_entity_type"),
    relatedEntityId: text("related_entity_id"),
    status: text("status").notNull().default("logged"), // queued | sent | failed | logged
    providerRef: text("provider_ref"),
    createdByStaffId: text("created_by_staff_id").references(() => staffUsers.id),
    createdAt: createdAt(),
  },
  (t) => [index("communications_customer_idx").on(t.customerId)],
);

export const messageTemplates = pgTable("message_templates", {
  id: id(),
  key: text("key").notNull().unique(), // booking_confirmation, appointment_reminder, …
  channel: text("channel").notNull(), // email | sms
  subject: text("subject"),
  body: text("body").notNull(),
  active: boolean("active").notNull().default(true),
  updatedAt: updatedAt(),
});

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

/** Key/value JSON settings store. See src/lib/settings.ts for typed access + defaults. */
export const businessSettings = pgTable("business_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: updatedAt(),
  updatedByStaffId: text("updated_by_staff_id"),
});

/**
 * Provider API credentials (Twilio, Resend), encrypted at rest.
 *
 * Deliberately NOT part of business_settings: getPublicSettings() loads that
 * whole table into public server components, so a secret stored there would be
 * one careless prop away from the browser. Nothing here is ever returned to a
 * client — see src/lib/integrations.ts for the only accessor.
 */
export const integrationCredentials = pgTable("integration_credentials", {
  key: text("key").primaryKey(),
  /** AES-256-GCM ciphertext, `v1:<iv>:<authTag>:<payload>`, all base64url. */
  valueEncrypted: text("value_encrypted").notNull(),
  updatedAt: updatedAt(),
  updatedByStaffId: text("updated_by_staff_id"),
});

/* ------------------------------------------------------------------ */
/* Bookkeeping                                                         */
/* ------------------------------------------------------------------ */

/**
 * Where the money goes. Seeded from DEFAULT_EXPENSE_CATEGORIES on first run and
 * editable afterwards — the owners rename and add to these, so nothing in the
 * code may match on a category name.
 */
export const expenseCategories = pgTable("expense_categories", {
  id: id(),
  name: text("name").notNull(),
  /** Worker/Manager pay. Expenses here must name the staff member they paid. */
  isPayroll: boolean("is_payroll").notNull().default(false),
  sort: integer("sort").notNull().default(0),
  active: boolean("active").notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * A bill that arrives every month (rent, hydro, insurance).
 *
 * In the spreadsheet these were phantom formula cells — you could not mark one
 * paid, attach an invoice number, or reconcile it. Here the monthly generator
 * turns each active bill into a REAL `expenses` row, which is why the P&L never
 * adds recurring bills separately: they are already in the expense total.
 *
 * Months are business-local "YYYY-MM" text rather than dates. A bill belongs to
 * a calendar month, not an instant, so there is no timezone to get wrong.
 */
export const recurringBills = pgTable(
  "recurring_bills",
  {
    id: id(),
    name: text("name").notNull(),
    categoryId: text("category_id")
      .notNull()
      .references(() => expenseCategories.id),
    amountCents: integer("amount_cents").notNull().default(0),
    startMonth: text("start_month").notNull(),
    /** Null means "until further notice". */
    endMonth: text("end_month"),
    paidBy: text("paid_by").notNull().default("preauthorized"),
    /**
     * Seeded bills ship INACTIVE. Their amounts are starting points taken from
     * the tracker, and generating real expense rows from an unconfirmed figure
     * would invent financial history. The owner confirms each amount and turns
     * the bill on.
     */
    active: boolean("active").notNull().default(false),
    notes: text("notes"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("recurring_bills_active_idx").on(t.active)],
);

/**
 * One row per outgoing payment. `amount_cents` is what left the bank
 * (tax-inclusive); `tax_paid_cents` is the HST portion of it, which is what
 * feeds input tax credits on the tax report.
 *
 * Deleting an expense is a real DELETE, unlike the invoice/payment tables —
 * this is internal bookkeeping, not a document issued to a customer, and the
 * owners expect a mistyped row to disappear the way a spreadsheet row does. The
 * full row is written to `audit_log.before` first, so the ledger stays
 * reconstructible.
 */
export const expenses = pgTable(
  "expenses",
  {
    id: id(),
    expenseDate: timestamp("expense_date", { withTimezone: true }).notNull(),
    categoryId: text("category_id")
      .notNull()
      .references(() => expenseCategories.id),
    paidTo: text("paid_to"),
    /** Required when the category is a payroll one — see validateExpenseInput. */
    staffUserId: text("staff_user_id").references(() => staffUsers.id),
    description: text("description"),
    amountCents: integer("amount_cents").notNull(),
    taxPaidCents: integer("tax_paid_cents").notNull().default(0),
    paidBy: text("paid_by").notNull().default("other"),
    /** Invoice or cheque number. */
    reference: text("reference"),
    autoGenerated: boolean("auto_generated").notNull().default(false),
    recurringBillId: text("recurring_bill_id").references(() => recurringBills.id),
    /** Business-local "YYYY-MM" the generator created this row for. */
    periodMonth: text("period_month"),
    /** Stamped when the owner ticks a generated bill off on the Home card. */
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    confirmedByStaffId: text("confirmed_by_staff_id").references(() => staffUsers.id),
    notes: text("notes"),
    createdByStaffId: text("created_by_staff_id").references(() => staffUsers.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("expenses_date_idx").on(t.expenseDate),
    index("expenses_category_idx").on(t.categoryId),
    index("expenses_staff_idx").on(t.staffUserId),
    /**
     * Makes "never create a second row for the same bill and month" a database
     * guarantee rather than a code convention, the same way invoice_jobs_job_uq
     * and payments.idempotency_key work. Hand-entered expenses leave both
     * columns NULL, and Postgres treats NULLs as distinct, so they never
     * collide with each other.
     */
    uniqueIndex("expenses_recurring_period_uq").on(t.recurringBillId, t.periodMonth),
  ],
);

/* ------------------------------------------------------------------ */
/* Labour                                                              */
/* ------------------------------------------------------------------ */

/**
 * One row per staff member per working day — the tracker's "Worker Hours" tab.
 *
 * `minutes` is an integer, not the spec's decimal(5,2) hours: this codebase has
 * a no-floats rule in financial math and already counts working time in minutes
 * (`durationMin`) everywhere else. Hours are a display format, not a stored one.
 *
 * `pay_earned_cents` is computed at save time from the staff member's rate and
 * then FROZEN, exactly the way an invoice snapshots its prices. A raise in
 * October must never rewrite what someone earned in September.
 *
 * `work_date` is noon business-local stored as UTC, the same convention as
 * `expenses.expense_date`: a calendar day the shop worked, pinned to an instant
 * that cannot drift into the neighbouring day — and therefore deterministic
 * enough for the unique index below to mean "one row per person per day".
 */
export const timesheets = pgTable(
  "timesheets",
  {
    id: id(),
    workDate: timestamp("work_date", { withTimezone: true }).notNull(),
    staffUserId: text("staff_user_id")
      .notNull()
      .references(() => staffUsers.id),
    minutes: integer("minutes").notNull().default(0),
    payEarnedCents: integer("pay_earned_cents").notNull().default(0),
    notes: text("notes"),
    createdByStaffId: text("created_by_staff_id").references(() => staffUsers.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("timesheets_date_idx").on(t.workDate),
    index("timesheets_staff_idx").on(t.staffUserId),
    /**
     * The week grid saves a whole week at once and the shop has more than one
     * phone. Making "one row per person per day" a database guarantee means a
     * double submission upserts rather than double-counting a day's pay.
     */
    uniqueIndex("timesheets_staff_day_uq").on(t.staffUserId, t.workDate),
  ],
);
