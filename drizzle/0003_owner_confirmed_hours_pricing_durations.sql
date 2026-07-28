-- Owner-confirmed hours for every currently open day. Closed weekdays remain closed.
UPDATE "business_hours"
SET "open" = '09:00', "close" = '17:00', "updated_at" = now()
WHERE "closed" = false;
--> statement-breakpoint

-- Flyer packages use the upper end of each printed price range.
-- Durations are the owner-confirmed booking times.
UPDATE "services"
SET "base_price_cents" = 20000, "base_duration_min" = 150, "updated_at" = now()
WHERE "slug" = 'complete-detail-engine';
--> statement-breakpoint
UPDATE "services"
SET "base_price_cents" = 17500, "base_duration_min" = 120, "updated_at" = now()
WHERE "slug" = 'the-works';
--> statement-breakpoint
UPDATE "services"
SET "base_price_cents" = 15000, "base_duration_min" = 90, "updated_at" = now()
WHERE "slug" = 'interior-detail';
--> statement-breakpoint
UPDATE "services"
SET "base_price_cents" = 7000, "base_duration_min" = 90, "updated_at" = now()
WHERE "slug" = 'wash-interior-refresh';
--> statement-breakpoint
UPDATE "services"
SET "base_price_cents" = 5000, "base_duration_min" = 30, "updated_at" = now()
WHERE "slug" = 'basic-interior-clean';
--> statement-breakpoint
UPDATE "services"
SET "base_price_cents" = 2500, "base_duration_min" = 60, "updated_at" = now()
WHERE "slug" = 'basic-car-wash';
--> statement-breakpoint

-- SUV / truck / van prices are stored as deltas from the sedan base price.
UPDATE "service_vehicle_adjustments"
SET "price_delta_cents" = 5000, "duration_delta_min" = 0
WHERE "service_id" = (SELECT "id" FROM "services" WHERE "slug" = 'complete-detail-engine');
--> statement-breakpoint
UPDATE "service_vehicle_adjustments"
SET "price_delta_cents" = 5000, "duration_delta_min" = 0
WHERE "service_id" = (SELECT "id" FROM "services" WHERE "slug" = 'the-works');
--> statement-breakpoint
UPDATE "service_vehicle_adjustments"
SET "price_delta_cents" = 2500, "duration_delta_min" = 0
WHERE "service_id" = (SELECT "id" FROM "services" WHERE "slug" = 'interior-detail');
--> statement-breakpoint
UPDATE "service_vehicle_adjustments"
SET "price_delta_cents" = 2000, "duration_delta_min" = 0
WHERE "service_id" = (SELECT "id" FROM "services" WHERE "slug" = 'wash-interior-refresh');
--> statement-breakpoint
UPDATE "service_vehicle_adjustments"
SET "price_delta_cents" = 2000, "duration_delta_min" = 0
WHERE "service_id" = (SELECT "id" FROM "services" WHERE "slug" = 'basic-interior-clean');
--> statement-breakpoint
UPDATE "service_vehicle_adjustments"
SET "price_delta_cents" = 500, "duration_delta_min" = 0
WHERE "service_id" = (SELECT "id" FROM "services" WHERE "slug" = 'basic-car-wash');
--> statement-breakpoint

-- Extra services add 30 minutes, except Wax / Buff, which adds two hours.
UPDATE "addons"
SET "duration_min" = 30, "updated_at" = now()
WHERE "name" IN ('Dog Hair Clean', 'Salt Stain Removal');
--> statement-breakpoint
UPDATE "addons"
SET "duration_min" = 120, "updated_at" = now()
WHERE "name" = 'Wax / Buff';
