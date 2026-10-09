-- Quote follow-ups: when a quote (or callback) request was last chased, when
-- it is next due, and the comments and follow-ups staff record against it.
--
-- Additive only, by the rule every migration here follows: the staging slot
-- shares the production database and applies migrations at boot, so this lands
-- while the OLD build is still serving live traffic. Two nullable columns and a
-- new table are invisible to that build, which never reads them.

ALTER TABLE "quote_requests" ADD COLUMN IF NOT EXISTS "last_followed_up_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "quote_requests" ADD COLUMN IF NOT EXISTS "next_follow_up_at" timestamp with time zone;--> statement-breakpoint

-- The dashboard's "follow-ups due" card scans this on every load.
CREATE INDEX IF NOT EXISTS "quote_requests_next_follow_up_idx" ON "quote_requests" USING btree ("next_follow_up_at");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "quote_request_activities" (
	"id" text PRIMARY KEY NOT NULL,
	"quote_request_id" text NOT NULL REFERENCES "quote_requests"("id"),
	"kind" text NOT NULL,
	"method" text,
	"body" text,
	"communication_id" text REFERENCES "communications"("id"),
	"staff_id" text REFERENCES "staff_users"("id"),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "quote_request_activities_quote_idx" ON "quote_request_activities" USING btree ("quote_request_id","created_at");
--> statement-breakpoint

-- Leads from the public quote and contact forms were saved without a normalized
-- phone, so a reply to anything we text them matched no lead. The forms now
-- set it; this fills it in for the ones already here. Byte-identical to the
-- backfill in 0010 and to normalizePhone() in src/lib/phone.ts.
UPDATE "leads"
SET "phone_normalized" = NULLIF(
  CASE
    WHEN length(regexp_replace("phone", '[^0-9]', '', 'g')) = 11
     AND left(regexp_replace("phone", '[^0-9]', '', 'g'), 1) = '1'
      THEN right(regexp_replace("phone", '[^0-9]', '', 'g'), 10)
    ELSE regexp_replace("phone", '[^0-9]', '', 'g')
  END,
  ''
)
WHERE "phone" IS NOT NULL AND "phone_normalized" IS NULL;--> statement-breakpoint

-- Recent requests nobody has opened yet start out due, as new ones will. Older
-- ones are left unscheduled rather than flooding the dashboard with a backlog
-- nobody is going to chase; staff can set a date on any of them.
UPDATE "quote_requests"
SET "next_follow_up_at" = "created_at"
WHERE "status" = 'new'
  AND "next_follow_up_at" IS NULL
  AND "last_followed_up_at" IS NULL
  AND "created_at" > now() - interval '30 days';
