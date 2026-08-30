-- Owner correction (2026-08-30): the Crystal ceramic coating for SUVs, pickups
-- and vans is $499, not $419. The sedan/coupe price of $399 is unchanged, so
-- only the delta moves — $100, which is what Pro and Max already use.
--
-- Data only. Written as a delta rather than an absolute price because that is
-- how every vehicle-size price in this schema is stored; setting a total here
-- would silently break if the base price is edited in Admin later.
UPDATE "service_vehicle_adjustments"
SET "price_delta_cents" = 10000
WHERE "service_id" = (SELECT "id" FROM "services" WHERE "slug" = 'ceramic-coating-crystal');
