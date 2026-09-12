-- One first-wash price for every vehicle, instead of a car price and a
-- larger-vehicle price.
--
-- Data only, additive by the same rule as every other migration here: the
-- staging slot shares the production database and applies migrations at boot,
-- so nothing may alter or drop an object the running build still reads.
--
-- WHY A MIGRATION AT ALL: the defaults in src/lib/settings.ts only apply to a
-- key that has never been saved. The moment an owner opens Admin → Settings and
-- presses save, the whole `washOffer` blob is written to this table and the
-- code default stops being consulted — so a deploy alone would leave the old
-- $17.99 SUV price in place on exactly the installations where somebody had
-- already configured the offer.
--
-- Every covered size is flattened to the price the car carried. Sizes left
-- blank stay blank: an absent category means "not covered", which is what keeps
-- commercial vehicles — quoted individually — out of a fixed-price offer.
-- Guarded to rows that actually hold more than one price, so a flat map that is
-- already correct is not rewritten.
UPDATE "business_settings" AS s
SET "value" = jsonb_set(
      s."value",
      '{priceCentsByCategory}',
      (
        SELECT jsonb_object_agg(
                 e.key,
                 to_jsonb(COALESCE(
                   (s."value" #>> '{priceCentsByCategory,sedan}')::int,
                   (s."value" #>> '{priceCentsByCategory,coupe}')::int,
                   1599
                 ))
               )
        FROM jsonb_each(s."value" -> 'priceCentsByCategory') AS e
      )
    )
WHERE s."key" = 'washOffer'
  AND jsonb_typeof(s."value" -> 'priceCentsByCategory') = 'object'
  AND (
    SELECT count(DISTINCT e.value) > 1
    FROM jsonb_each(s."value" -> 'priceCentsByCategory') AS e
  );
