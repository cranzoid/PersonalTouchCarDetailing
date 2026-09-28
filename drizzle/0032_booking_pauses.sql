-- Booking pauses: stop taking online bookings for a stretch of time.
--
-- A whole-business closure already stops bookings, but it is refused whenever
-- an appointment sits inside it — which is exactly the day the shop wants to
-- stop: full of bookings, and wanting no more. A pause refuses only NEW
-- customer bookings, so appointments already in it are left alone.
--
-- Additive only, by the rule every migration here follows: the staging slot
-- shares the production database and applies migrations at boot, so this lands
-- while the OLD build is still serving live traffic. A new table is invisible
-- to that build, which never reads it.

CREATE TABLE IF NOT EXISTS "booking_pauses" (
	"id" text PRIMARY KEY NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"reason" text,
	"created_by_staff_id" text REFERENCES "staff_users"("id"),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

-- Every customer availability check reads the pauses overlapping its day.
CREATE INDEX IF NOT EXISTS "booking_pauses_time_idx" ON "booking_pauses" USING btree ("starts_at","ends_at");
