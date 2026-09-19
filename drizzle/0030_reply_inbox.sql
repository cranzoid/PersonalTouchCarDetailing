-- Replies inbox: one screen for everything customers text back.
--
-- Replies have always been recorded, but only ever displayed on the customer
-- or lead they matched — so seeing one meant already knowing it was there.
-- Everything below exists to make the same rows answerable as conversations.
--
-- Additive only, by the rule every migration here follows: the staging slot
-- shares the production database and applies migrations at boot, so this lands
-- while the OLD build is still serving live traffic. Drizzle selects columns by
-- name, so that build never sees these, and its inserts take the NULL default.
-- ADD COLUMN with no default is catalogue-only on Postgres 11+, so no table is
-- rewritten and no long lock is held.

-- Who the message was with, on the message itself. An inbound SMS from a number
-- we do not recognise used to record nothing identifying at all — customer_id
-- and lead_id both null, the sender's number surviving only inside
-- webhook_events.payload, which no screen joins.
ALTER TABLE "communications" ADD COLUMN IF NOT EXISTS "contact_address" text;--> statement-breakpoint
ALTER TABLE "communications" ADD COLUMN IF NOT EXISTS "contact_address_normalized" text;--> statement-breakpoint

-- When a staff member saw a reply, and who. Outbound rows keep both null.
ALTER TABLE "communications" ADD COLUMN IF NOT EXISTS "read_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "communications" ADD COLUMN IF NOT EXISTS "read_by_staff_id" text REFERENCES "staff_users"("id");--> statement-breakpoint

-- Pulling one contact's whole thread reads by lead as often as by customer;
-- only the customer side had an index.
CREATE INDEX IF NOT EXISTS "communications_lead_idx" ON "communications" ("lead_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "communications_contact_idx" ON "communications" ("contact_address_normalized");--> statement-breakpoint
-- The unread badge in the admin rail runs on every admin page load.
CREATE INDEX IF NOT EXISTS "communications_inbound_idx" ON "communications" ("direction", "read_at");--> statement-breakpoint

-- Recover the sender's number for replies that arrived before this column
-- existed, from the raw Twilio delivery they were recorded from. Without it
-- every historical reply from an unmatched number is an orphan row with no
-- way back to the person who sent it.
UPDATE "communications" AS c
SET "contact_address" = w."payload"->>'From'
FROM "webhook_events" AS w
WHERE c."direction" = 'inbound'
  AND c."contact_address" IS NULL
  AND c."provider_ref" IS NOT NULL
  AND w."provider" = 'twilio'
  AND w."event_id" = c."provider_ref"
  AND w."payload"->>'From' IS NOT NULL;--> statement-breakpoint

-- Bare digits, leading North American "1" dropped, matching 0008's customer
-- backfill. This MUST stay byte-identical to normalizePhone() in
-- src/lib/phone.ts, which is what normalizeDestination('sms', …) calls: a
-- number normalized one way here and another way in the app would thread a
-- reply into a conversation of its own and look, convincingly, like it worked.
UPDATE "communications"
SET "contact_address_normalized" = NULLIF(
  CASE
    WHEN length(regexp_replace("contact_address", '[^0-9]', '', 'g')) = 11
     AND left(regexp_replace("contact_address", '[^0-9]', '', 'g'), 1) = '1'
      THEN right(regexp_replace("contact_address", '[^0-9]', '', 'g'), 10)
    ELSE regexp_replace("contact_address", '[^0-9]', '', 'g')
  END,
  ''
)
WHERE "channel" = 'sms'
  AND "contact_address" IS NOT NULL
  AND "contact_address_normalized" IS NULL;
