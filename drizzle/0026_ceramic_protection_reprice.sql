-- Ceramic protection comes down, on both of the ways it is sold.
-- Owner-directed on 2026-09-16.
--
--                              sedan          SUV / truck / van
--   standalone service    $199 -> $149       $229 -> $199
--   Ultimate Detail add-on $120 ->  $99      $199 -> $129
--
-- Note what changed in shape, not just in amount: the add-on's large-vehicle
-- price used to land exactly on the standalone sedan-plus-delta figure ($199),
-- so a customer with an SUV paid the same either way and the "cheaper with a
-- detail" promise quietly stopped being true for them. At $129 against $199 the
-- add-on is now cheaper for every vehicle category, which is what
-- /services/ceramic-protection has always told people.
--
-- Additive-only, for the reason given in 0025: the staging slot shares the
-- production database and migrates at boot, so this lands while the previous
-- build still serves traffic. Only price and duration columns move.
--
-- Rows are addressed by slug and by the add-on's fixed id from 0014, never by
-- name — the owners rename catalogue rows in Admin.

-- --- standalone: $149 sedan, $199 large ----------------------------------
UPDATE "services" SET "base_price_cents" = 14900, "updated_at" = now()
WHERE "slug" = 'ceramic-protection';
--> statement-breakpoint

UPDATE "service_vehicle_adjustments" AS a
SET "price_delta_cents" = 5000, "updated_at" = now()
FROM "services" s
WHERE s."id" = a."service_id"
  AND s."slug" = 'ceramic-protection';
--> statement-breakpoint

-- --- Ultimate Detail add-on: $99 sedan, $129 large -----------------------
UPDATE "addons" SET "price_cents" = 9900, "updated_at" = now()
WHERE "id" = 'add_ceramicprotectionult';
--> statement-breakpoint

UPDATE "addon_vehicle_adjustments"
SET "price_delta_cents" = 3000, "updated_at" = now()
WHERE "addon_id" = 'add_ceramicprotectionult';
