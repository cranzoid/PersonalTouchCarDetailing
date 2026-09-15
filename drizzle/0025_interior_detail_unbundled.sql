-- Interior Detail is unbundled: seat shampoo comes out of the three detailing
-- packages and becomes a paid add-on, and every package price drops by what it
-- used to carry. Owner-directed on 2026-09-16.
--
--   sedan  -$40   (the $39.99 seat shampoo, rounded)
--   large  -$50   (the $49.99 seat shampoo, rounded)
--
--   slug                     sedan            large (SUV/truck/van)
--   complete-detail-engine   $200 -> $160     $250 -> $200
--   the-works                $175 -> $135     $225 -> $175
--   interior-detail          $150 ->  $99*    $175 -> $125
--
--   * Interior Detail is priced at a flat $99 rather than $110, an extra
--     promotional $11 the owner set deliberately as the headline price.
--
-- Additive-only by the rule that governs every migration here: the staging slot
-- shares the production database and applies migrations at boot, so this lands
-- on live data while the OLD production build is still serving traffic. Nothing
-- below drops or renames a column, and the old build keeps working throughout —
-- it simply renders the new prices, which is the intent.
--
-- WHY A MIGRATION RATHER THAN A SEED CHANGE: `runSeed` only writes the
-- catalogue when `service_categories` is empty (src/db/seed-runner.ts). On an
-- installation that already has a catalogue the seed is a no-op forever, so a
-- deploy alone would leave production on the old prices. The seed is updated in
-- the same commit so a fresh database starts here too.
--
-- Rows are addressed BY SLUG, never by name: the owners rename services in
-- Admin ("#1 - Ultimate Detail"), and a migration that wrote `name` would
-- overwrite their own wording. Text columns are updated only where they still
-- hold the exact seeded copy, so an owner edit is never clobbered.

-- --- package prices -------------------------------------------------------
UPDATE "services" SET "base_price_cents" = 16000, "updated_at" = now()
WHERE "slug" = 'complete-detail-engine';
--> statement-breakpoint

UPDATE "services" SET "base_price_cents" = 13500, "updated_at" = now()
WHERE "slug" = 'the-works';
--> statement-breakpoint

UPDATE "services" SET "base_price_cents" = 9900, "updated_at" = now()
WHERE "slug" = 'interior-detail';
--> statement-breakpoint

-- Large-vehicle uplift narrows because the larger seat shampoo ($49.99) came
-- off a price that was only $39.99 lower for a sedan. Interior Detail moves the
-- other way ($25 -> $26) because its sedan price was cut to a flat $99.
UPDATE "service_vehicle_adjustments" AS a
SET "price_delta_cents" = 4000, "updated_at" = now()
FROM "services" s
WHERE s."id" = a."service_id"
  AND s."slug" IN ('complete-detail-engine', 'the-works');
--> statement-breakpoint

UPDATE "service_vehicle_adjustments" AS a
SET "price_delta_cents" = 2600, "updated_at" = now()
FROM "services" s
WHERE s."id" = a."service_id"
  AND s."slug" = 'interior-detail';
--> statement-breakpoint

-- --- package descriptions -------------------------------------------------
-- "Deep-cleaned seats" now describes the paid add-on, not the package, so the
-- menu copy would be a promise we no longer keep. Guarded to the exact seeded
-- text: if an owner has reworded a description in Admin, theirs stands.
UPDATE "services"
SET "short_description" = 'Engine fine detail, rim clean and tire shine, detailed clean of seats, carpets and mats, full interior clean, buff and polish, hand wash and dry.',
    "updated_at" = now()
WHERE "slug" = 'complete-detail-engine'
  AND "short_description" = 'Engine fine detail, rim clean and tire shine, deep-cleaned seats and carpet, full interior clean and buff, hand wash and dry.';
--> statement-breakpoint

UPDATE "services"
SET "short_description" = 'Rim clean and tire shine, detailed clean of seats, carpets and mats, full interior clean, buff and polish, hand wash and dry.',
    "updated_at" = now()
WHERE "slug" = 'the-works'
  AND "short_description" = 'Rim clean and tire shine, deep-cleaned seats, carpet and mats, full interior clean and buff, hand wash and dry.';
--> statement-breakpoint

UPDATE "services"
SET "short_description" = 'Detailed clean of seats, carpets and mats, interior surfaces cleaned, buffed and polished, interior glass cleaned, air vents disinfected, trunk vacuumed.',
    "updated_at" = now()
WHERE "slug" = 'interior-detail'
  AND "short_description" = 'Vacuum carpets and seats, clean mats and interior windows, deep-clean seats and carpets, clean and buff all interior surfaces.';
--> statement-breakpoint

-- --- existing add-on prices ----------------------------------------------
-- Salt stain removal $50 -> $39.99. It is already linked to all three detailing
-- packages, so no new link is needed.
UPDATE "addons" SET "price_cents" = 3999, "updated_at" = now()
WHERE "name" = 'Salt Stain Removal';
--> statement-breakpoint

-- The add-on has always been a wax; "Buff" in the name described work that is
-- not performed, so the name goes back to what is actually sold and the price
-- becomes $69. Renaming a row the owner can edit is normally forbidden, but
-- removing "Buff" is precisely what was asked for — and the guard means it only
-- fires while the name is still the seeded one.
UPDATE "addons"
SET "name" = 'Wax',
    "description" = 'Machine wax for added gloss and protection.',
    "updated_at" = now()
WHERE "name" = 'Wax / Buff';
--> statement-breakpoint

UPDATE "addons" SET "price_cents" = 6900, "updated_at" = now()
WHERE "name" IN ('Wax', 'Wax / Buff');
--> statement-breakpoint

-- --- seat shampoo add-on --------------------------------------------------
-- The work that just came out of the three packages, sold back at the price
-- that was deducted: $39.99 sedan, $49.99 for SUVs, trucks and vans. Same
-- base-plus-category-delta rule as every other price on the site.
INSERT INTO "addons" ("id", "name", "slug", "description", "price_cents", "duration_min", "active", "sort")
VALUES (
  'add_seatshampoo',
  'Seat Shampoo',
  'seat-shampoo',
  'Shampoo extraction of the seats, lifting staining that a detailed clean leaves behind.',
  3999, 45, true, 3
)
ON CONFLICT DO NOTHING;
--> statement-breakpoint

INSERT INTO "addon_vehicle_adjustments"
  ("id", "addon_id", "vehicle_category", "price_delta_cents", "duration_delta_min")
SELECT 'aja_seatshampoo_' || c."cat", 'add_seatshampoo', c."cat", 1000, 15
FROM (VALUES ('suv_small'), ('suv_large'), ('pickup'), ('van'), ('commercial')) AS c("cat")
WHERE EXISTS (SELECT 1 FROM "addons" WHERE "id" = 'add_seatshampoo')
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- Offered only on the three packages the price was taken out of. It is not
-- attached to Wash & Interior Refresh or Basic Interior Clean, where a $39.99
-- shampoo would cost more than half the package it sits under.
INSERT INTO "service_addons" ("id", "service_id", "addon_id")
SELECT 'add_link_seatshmp_' || s."slug", s."id", 'add_seatshampoo'
FROM "services" s
WHERE s."slug" IN ('complete-detail-engine', 'the-works', 'interior-detail')
  AND EXISTS (SELECT 1 FROM "addons" WHERE "id" = 'add_seatshampoo')
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- --- headlight restoration add-on ----------------------------------------
-- One flat price for every vehicle: the lenses are the same job on a sedan and
-- on a pickup, so there is no vehicle adjustment here.
INSERT INTO "addons" ("id", "name", "slug", "description", "price_cents", "duration_min", "active", "sort")
VALUES (
  'add_headlightrestore',
  'Headlight Restoration',
  'headlight-restoration',
  'Sanding, polishing and sealing of clouded or yellowed headlight lenses.',
  9900, 60, true, 4
)
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- Linked to every package with exterior work — the same four the wax is on.
-- Interior Detail is deliberately excluded: it never takes the vehicle outside.
INSERT INTO "service_addons" ("id", "service_id", "addon_id")
SELECT 'add_link_hdlight_' || s."slug", s."id", 'add_headlightrestore'
FROM "services" s
WHERE s."slug" IN ('complete-detail-engine', 'the-works', 'wash-interior-refresh', 'basic-car-wash')
  AND EXISTS (SELECT 1 FROM "addons" WHERE "id" = 'add_headlightrestore')
ON CONFLICT DO NOTHING;
