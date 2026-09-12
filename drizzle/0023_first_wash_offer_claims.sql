-- New-customer wash offer: claims, and the two caps that make the offer honest.
--
-- Additive only. The staging slot shares the production database and applies
-- migrations at boot, so nothing here may alter or drop an existing object.
--
-- NOTE: drizzle-kit re-emitted migration 0022's statements into this file
-- because the committed snapshot had not caught up with that hand-written
-- migration. They are removed — re-adding an existing column aborts the whole
-- run. The regenerated 0023 snapshot fixes the drift for next time.

CREATE TABLE IF NOT EXISTS "offer_claims" (
	"id" text PRIMARY KEY NOT NULL,
	"offer_code" text NOT NULL,
	"code" text NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text DEFAULT '' NOT NULL,
	"email" text,
	"phone" text,
	"phone_normalized" text,
	"email_normalized" text,
	"vehicle_size" text DEFAULT 'car' NOT NULL,
	"marketing_consent" boolean DEFAULT false NOT NULL,
	"marketing_consent_at" timestamp with time zone,
	"terms_version" text DEFAULT '' NOT NULL,
	"attribution" jsonb,
	"status" text DEFAULT 'issued' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"lead_id" text REFERENCES "leads"("id"),
	"customer_id" text REFERENCES "customers"("id"),
	"appointment_id" text REFERENCES "appointments"("id"),
	"booked_at" timestamp with time zone,
	"redeemed_plate_normalized" text,
	"redeemed_at" timestamp with time zone,
	"redeemed_by_staff_id" text REFERENCES "staff_users"("id"),
	"reminders_sent" integer DEFAULT 0 NOT NULL,
	"last_reminder_at" timestamp with time zone,
	"void_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- The code the customer holds. One claim, one code, for the life of the table.
CREATE UNIQUE INDEX IF NOT EXISTS "offer_claims_code_uq"
  ON "offer_claims" ("code");

-- Cap one: one claim per person, per campaign. Keyed on the SAME normalized
-- forms the rest of the app uses (src/lib/phone.ts), so "(905) 679-0143" and
-- "9056790143" are one person rather than two claims.
--
-- Partial, excluding voided rows: staff releasing a claim taken in error — a
-- duplicate, or a number typed wrong — must let that person claim again.
CREATE UNIQUE INDEX IF NOT EXISTS "offer_claims_offer_phone_uq"
  ON "offer_claims" ("offer_code", "phone_normalized")
  WHERE "phone_normalized" IS NOT NULL AND "status" <> 'void';

CREATE UNIQUE INDEX IF NOT EXISTS "offer_claims_offer_email_uq"
  ON "offer_claims" ("offer_code", "email_normalized")
  WHERE "email_normalized" IS NOT NULL AND "status" <> 'void';

-- Cap two: one promotional wash per licence plate, for the whole campaign.
-- Not scoped by status — a plate that has had the wash stays spent even if the
-- claim behind it is voided afterwards. This is the index that actually keeps
-- the promise; a SELECT-then-INSERT check would lose the race.
CREATE UNIQUE INDEX IF NOT EXISTS "offer_claims_offer_plate_uq"
  ON "offer_claims" ("offer_code", "redeemed_plate_normalized")
  WHERE "redeemed_plate_normalized" IS NOT NULL;

-- Expiry sweeps and reminder selection both walk (status, expires_at).
CREATE INDEX IF NOT EXISTS "offer_claims_status_idx"
  ON "offer_claims" ("status", "expires_at");

CREATE INDEX IF NOT EXISTS "offer_claims_appointment_idx"
  ON "offer_claims" ("appointment_id");
