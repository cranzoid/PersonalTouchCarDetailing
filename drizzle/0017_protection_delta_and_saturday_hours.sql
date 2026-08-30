-- Owner corrections (2026-08-30). Data only; no schema change.
--
-- 1. Standalone ceramic protection on an SUV, pickup or van is $229, not $299.
--    The sedan/coupe price of $199 is unchanged, so only the delta moves: $30.
--    Written as a delta rather than an absolute price because that is how every
--    vehicle-size price in this schema is stored — setting a total here would
--    silently break the moment the base price is edited in Admin.
UPDATE "service_vehicle_adjustments"
SET "price_delta_cents" = 3000
WHERE "service_id" = (SELECT "id" FROM "services" WHERE "slug" = 'ceramic-protection');
--> statement-breakpoint

-- 2. Saturday closes at 6pm, not 5pm. Only Saturday moves, and only if it is
--    open — a shop that has since closed Saturdays in Admin stays closed.
UPDATE "business_hours"
SET "close" = '18:00', "updated_at" = now()
WHERE "weekday" = 6 AND "closed" = false;
