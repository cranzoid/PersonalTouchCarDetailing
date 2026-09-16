-- Hand-sent nudges for the new-customer wash offer (Outreach → First-wash
-- nudges): a per-channel counter and a last-sent stamp on each claim.
--
-- Additive only, by the rule every migration here follows: the staging slot
-- shares the production database and applies migrations at boot, while the
-- old production build is still serving the live ad. Drizzle selects columns
-- by name, so that build never sees these, and its inserts pick up the
-- defaults. ADD COLUMN with a constant default is a catalogue-only change on
-- Postgres 11+, so nothing is rewritten and no lock is held for long.
--
-- Kept apart from reminders_sent on purpose: that counter indexes the
-- automatic day-3/7/12 schedule, and a text sent by hand must not move it.
ALTER TABLE "offer_claims" ADD COLUMN IF NOT EXISTS "sms_nudges_sent" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "offer_claims" ADD COLUMN IF NOT EXISTS "email_nudges_sent" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "offer_claims" ADD COLUMN IF NOT EXISTS "last_sms_nudge_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "offer_claims" ADD COLUMN IF NOT EXISTS "last_email_nudge_at" timestamp with time zone;
