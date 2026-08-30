-- Keep customer-facing extras contextual. Interior cleanup should never be
-- offered beside an exterior-only wash, and paint wax/buff should never be
-- offered beside interior-only packages. Existing bookings are untouched;
-- these rows control only which add-ons can be selected going forward.
DELETE FROM "service_addons"
WHERE "addon_id" IN (
  SELECT "id" FROM "addons" WHERE "name" IN ('Dog Hair Clean', 'Salt Stain Removal')
)
AND "service_id" = (
  SELECT "id" FROM "services" WHERE "slug" = 'basic-car-wash'
);

DELETE FROM "service_addons"
WHERE "addon_id" = (SELECT "id" FROM "addons" WHERE "name" = 'Wax / Buff')
AND "service_id" IN (
  SELECT "id" FROM "services" WHERE "slug" IN ('interior-detail', 'basic-interior-clean')
);

-- New tint installation is no longer offered publicly. Historical services,
-- jobs and invoice lines remain intact because the catalogue row is disabled,
-- not deleted. Tint removal and tint replacement stay active.
UPDATE "services" SET "active" = false WHERE "slug" = 'vehicle-tinting';

UPDATE "service_categories"
SET
  "name" = 'Tint Removal & Replacement',
  "description" = 'Removal of old or damaged window film, with replacement available by quote.'
WHERE "slug" = 'window-tinting';
