-- Bring the public Google rating and review count up to date: 4.7 over 91
-- reviews, read from the public listing on 2026-10-22 (it was 4.7 over 73).
--
-- Data only, additive by the same rule as every other migration here: the
-- staging slot shares the production database and applies migrations at boot,
-- so nothing may alter or drop an object the running build still reads.
--
-- WHY A MIGRATION AT ALL: the defaults in src/lib/settings.ts only apply to a
-- key that has never been saved. Admin -> Settings writes every field when the
-- owners press save, so a deploy alone would leave the old 73 on screen on
-- exactly the installations that had already been configured.
--
-- The count only ever moves up: a number the owners entered by hand that is
-- already at or past 91 is left alone. The rating is set with it, but only when
-- the count was raised, so the two never disagree.
WITH "bumped" AS (
	INSERT INTO "business_settings" ("key", "value")
	VALUES ('googleReviewCount', '91'::jsonb)
	ON CONFLICT ("key") DO UPDATE
		SET "value" = '91'::jsonb, "updated_at" = now()
		WHERE jsonb_typeof("business_settings"."value") <> 'number'
			OR ("business_settings"."value")::numeric < 91
	RETURNING 1
)
INSERT INTO "business_settings" ("key", "value")
SELECT 'googleReviewRating', '4.7'::jsonb
WHERE EXISTS (SELECT 1 FROM "bumped")
ON CONFLICT ("key") DO UPDATE
	SET "value" = '4.7'::jsonb, "updated_at" = now();
