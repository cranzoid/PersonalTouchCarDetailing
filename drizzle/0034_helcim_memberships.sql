-- Helcim payments, memberships, the Winter Pass and customer accounts.
--
-- Additive only, by the rule every migration here follows: the staging slot
-- shares the production database and applies migrations at boot, so this lands
-- while the OLD build is still serving live traffic. New tables are invisible
-- to that build, and every new column is nullable or defaulted.

-- --- columns on existing tables -------------------------------------------

ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "helcim_customer_code" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "customers_helcim_code_uq" ON "customers" USING btree ("helcim_customer_code") WHERE "helcim_customer_code" is not null;--> statement-breakpoint

ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "customer_pay_intent" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "customer_pay_intent_at" timestamp with time zone;--> statement-breakpoint

-- --- checkouts ----------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "payment_checkouts" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"channel" text NOT NULL,
	"customer_id" text NOT NULL REFERENCES "customers"("id"),
	"reference" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text DEFAULT 'CAD' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"subject" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"checkout_token" text,
	"secret_token" text,
	"expires_at" timestamp with time zone,
	"helcim_transaction_id" text,
	"helcim_customer_code" text,
	"card_token" text,
	"card_label" text,
	"device_code" text,
	"failure_reason" text,
	"transaction" jsonb,
	"completed_at" timestamp with time zone,
	"created_by_staff_id" text REFERENCES "staff_users"("id"),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_checkouts_reference_unique" UNIQUE("reference"),
	CONSTRAINT "payment_checkouts_helcim_transaction_id_unique" UNIQUE("helcim_transaction_id")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_checkouts_status_idx" ON "payment_checkouts" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_checkouts_customer_idx" ON "payment_checkouts" USING btree ("customer_id");--> statement-breakpoint

ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "checkout_id" text REFERENCES "payment_checkouts"("id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payments_checkout_idx" ON "payments" USING btree ("checkout_id");--> statement-breakpoint

-- --- memberships -------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "membership_plans" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"tagline" text,
	"features" text[] DEFAULT '{}' NOT NULL,
	"monthly_price_cents" integer NOT NULL,
	"discount_bp" integer DEFAULT 0 NOT NULL,
	"included_benefits" text[] DEFAULT '{}' NOT NULL,
	"rank" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "membership_plans_slug_unique" UNIQUE("slug")
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "memberships" (
	"id" text PRIMARY KEY NOT NULL,
	"customer_id" text NOT NULL REFERENCES "customers"("id"),
	"vehicle_id" text NOT NULL REFERENCES "vehicles"("id"),
	"plan_id" text NOT NULL REFERENCES "membership_plans"("id"),
	"status" text DEFAULT 'pending' NOT NULL,
	"price_cents" integer NOT NULL,
	"helcim_customer_code" text,
	"card_token" text,
	"card_label" text,
	"current_period_start" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"cancel_requested_at" timestamp with time zone,
	"canceled_at" timestamp with time zone,
	"cancel_reason" text,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"past_due_since" timestamp with time zone,
	"next_plan_id" text REFERENCES "membership_plans"("id"),
	"next_plan_from" timestamp with time zone,
	"next_plan_notice_sent_at" timestamp with time zone,
	"terms_version" text DEFAULT '' NOT NULL,
	"authorized_at" timestamp with time zone,
	"last_reminder_at" timestamp with time zone,
	"created_by_staff_id" text REFERENCES "staff_users"("id"),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
-- One live membership per car: the benefit belongs to the vehicle.
CREATE UNIQUE INDEX IF NOT EXISTS "memberships_live_vehicle_uq" ON "memberships" USING btree ("vehicle_id") WHERE "status" in ('pending', 'active', 'past_due');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memberships_customer_idx" ON "memberships" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memberships_due_idx" ON "memberships" USING btree ("status","current_period_end");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "membership_periods" (
	"id" text PRIMARY KEY NOT NULL,
	"membership_id" text NOT NULL REFERENCES "memberships"("id"),
	"plan_id" text NOT NULL REFERENCES "membership_plans"("id"),
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"amount_cents" integer NOT NULL,
	"invoice_id" text REFERENCES "invoices"("id"),
	"status" text DEFAULT 'due' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
-- The idempotency guarantee for monthly billing: one row per membership-month.
CREATE UNIQUE INDEX IF NOT EXISTS "membership_periods_start_uq" ON "membership_periods" USING btree ("membership_id","period_start");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "membership_periods_invoice_idx" ON "membership_periods" USING btree ("invoice_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "membership_redemptions" (
	"id" text PRIMARY KEY NOT NULL,
	"membership_id" text NOT NULL REFERENCES "memberships"("id"),
	"period_id" text NOT NULL REFERENCES "membership_periods"("id"),
	"benefit" text NOT NULL,
	"appointment_id" text REFERENCES "appointments"("id"),
	"invoice_id" text REFERENCES "invoices"("id"),
	"redeemed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"redeemed_by_staff_id" text REFERENCES "staff_users"("id"),
	"voided_at" timestamp with time zone,
	"void_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
-- One wash (and one interior clean) per paid month, no rollover.
CREATE UNIQUE INDEX IF NOT EXISTS "membership_redemptions_live_uq" ON "membership_redemptions" USING btree ("period_id","benefit") WHERE "voided_at" is null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "membership_redemptions_appointment_idx" ON "membership_redemptions" USING btree ("appointment_id");--> statement-breakpoint

-- --- Winter Pass -------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "winter_passes" (
	"id" text PRIMARY KEY NOT NULL,
	"customer_id" text NOT NULL REFERENCES "customers"("id"),
	"vehicle_id" text NOT NULL REFERENCES "vehicles"("id"),
	"sale_invoice_id" text REFERENCES "invoices"("id"),
	"status" text DEFAULT 'pending_payment' NOT NULL,
	"washes_total" integer NOT NULL,
	"price_cents" integer NOT NULL,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_until" timestamp with time zone NOT NULL,
	"terms_version" text DEFAULT '' NOT NULL,
	"activated_at" timestamp with time zone,
	"voided_at" timestamp with time zone,
	"void_reason" text,
	"created_by_staff_id" text REFERENCES "staff_users"("id"),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "winter_passes_customer_idx" ON "winter_passes" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "winter_passes_vehicle_idx" ON "winter_passes" USING btree ("vehicle_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "winter_passes_invoice_idx" ON "winter_passes" USING btree ("sale_invoice_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "winter_pass_redemptions" (
	"id" text PRIMARY KEY NOT NULL,
	"pass_id" text NOT NULL REFERENCES "winter_passes"("id"),
	"wash_number" integer NOT NULL,
	"appointment_id" text REFERENCES "appointments"("id"),
	"invoice_id" text REFERENCES "invoices"("id"),
	"redeemed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"redeemed_by_staff_id" text REFERENCES "staff_users"("id"),
	"voided_at" timestamp with time zone,
	"void_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "winter_pass_redemptions_live_uq" ON "winter_pass_redemptions" USING btree ("pass_id","wash_number") WHERE "voided_at" is null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "winter_pass_redemptions_appointment_idx" ON "winter_pass_redemptions" USING btree ("appointment_id");--> statement-breakpoint

-- --- customer accounts -------------------------------------------------------

CREATE TABLE IF NOT EXISTS "customer_login_codes" (
	"id" text PRIMARY KEY NOT NULL,
	"channel" text NOT NULL,
	"contact" text NOT NULL,
	"code_hash" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customer_login_codes_contact_idx" ON "customer_login_codes" USING btree ("channel","contact","created_at");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "customer_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"channel" text NOT NULL,
	"contact" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_sessions_token_hash_unique" UNIQUE("token_hash")
);--> statement-breakpoint

-- --- the two winter plans, as on the 2026-10-06 flyer -------------------------
-- Prices are before tax; HST is added on each monthly invoice. Both are
-- editable in Memberships → Settings, so these are starting values only and
-- ON CONFLICT leaves an owner's later edits alone.

INSERT INTO "membership_plans"
  ("id", "slug", "name", "tagline", "features", "monthly_price_cents", "discount_bp", "included_benefits", "rank", "active", "sort")
VALUES (
  'mpl_winterclub',
  'winter-shield-club',
  'Winter Shield Club',
  'A premium hand wash every month, all winter long.',
  ARRAY[
    '1 premium hand wash per month',
    'Wheels + tires cleaned',
    'Wheel wells flushed',
    'Underbody salt rinse',
    'Floor mats cleaned',
    'Hand dry',
    'Winter glass spray protection',
    'Priority booking',
    '15% off detailing / add-ons',
    'No rollover'
  ],
  4900, 1500, ARRAY['wash'], 1, true, 1
)
ON CONFLICT DO NOTHING;--> statement-breakpoint

INSERT INTO "membership_plans"
  ("id", "slug", "name", "tagline", "features", "monthly_price_cents", "discount_bp", "included_benefits", "rank", "active", "sort")
VALUES (
  'mpl_wintercomplete',
  'winter-shield-complete',
  'Winter Shield Complete',
  'The monthly wash plus a basic interior clean.',
  ARRAY[
    'Everything included in Winter Shield Club',
    'Basic Interior Clean: vacuum, dash and doors wiped, cup holders and interior glass cleaned',
    '20% off detailing / add-ons',
    'No rollover'
  ],
  6900, 2000, ARRAY['wash', 'interior'], 2, true, 2
)
ON CONFLICT DO NOTHING;--> statement-breakpoint

-- --- winter catalogue additions ----------------------------------------------

INSERT INTO "service_categories" ("id", "name", "slug", "description", "sort", "active")
VALUES (
  'cat_seasonal',
  'Seasonal Services',
  'seasonal-services',
  'Seasonal work for Hamilton winters — tire swaps and more.',
  6, true
)
ON CONFLICT DO NOTHING;--> statement-breakpoint

-- "From $49.99" on the flyer. One flat price to start; vehicle-size prices can
-- be added in Admin → Services without a deploy.
INSERT INTO "services"
  ("id", "category_id", "name", "slug", "short_description", "base_price_cents", "base_duration_min", "booking_mode", "active", "sort")
SELECT
  'svc_wintertireswap',
  c."id",
  'Winter Tire Swap',
  'winter-tire-swap',
  'Seasonal winter tire swap. Quick, professional, and easy to combine with another appointment.',
  4999, 45, 'bookable', true, 1
FROM "service_categories" c
WHERE c."slug" = 'seasonal-services'
ON CONFLICT DO NOTHING;--> statement-breakpoint

INSERT INTO "addons" ("id", "name", "slug", "description", "price_cents", "duration_min", "active", "sort")
VALUES (
  'add_winterglass',
  'Winter Glass Protection',
  'winter-glass-protection',
  'Exterior glass treatment for better water beading and easier winter driving and cleaning.',
  1499, 15, true, 6
)
ON CONFLICT DO NOTHING;--> statement-breakpoint

-- On every package with exterior work — the same four the wax is on.
INSERT INTO "service_addons" ("id", "service_id", "addon_id")
SELECT 'add_link_wglass_' || s."slug", s."id", 'add_winterglass'
FROM "services" s
WHERE s."slug" IN ('complete-detail-engine', 'the-works', 'wash-interior-refresh', 'basic-car-wash')
  AND EXISTS (SELECT 1 FROM "addons" WHERE "id" = 'add_winterglass')
ON CONFLICT DO NOTHING;
