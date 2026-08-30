-- Ceramic protection and ceramic coating become priced, bookable products.
--
-- Two DIFFERENT products, deliberately kept apart everywhere:
--   Ceramic Protection - one layer of ceramic protection, sold either as an
--     Ultimate Detail add-on (discounted) or standalone.
--   Ceramic Coating    - the premium service in three packages (Crystal, Pro,
--     Max), each its own bookable catalogue service.
--
-- Additive only: nothing is dropped or renamed. The owner has already renamed
-- packages in Admin ("#1 - Ultimate Detail"), so every reference below is by
-- SLUG, never by name, and no existing name is overwritten.
--
-- The DDL adds deep-link slugs for add-ons and vehicle-size pricing for
-- add-ons. The data statements below install the catalogue itself.

CREATE TABLE "addon_vehicle_adjustments" (
	"id" text PRIMARY KEY NOT NULL,
	"addon_id" text NOT NULL,
	"vehicle_category" text NOT NULL,
	"price_delta_cents" integer DEFAULT 0 NOT NULL,
	"duration_delta_min" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "addons" ADD COLUMN "slug" text;--> statement-breakpoint
ALTER TABLE "addon_vehicle_adjustments" ADD CONSTRAINT "addon_vehicle_adjustments_addon_id_addons_id_fk" FOREIGN KEY ("addon_id") REFERENCES "public"."addons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "addon_vehicle_adj_unique" ON "addon_vehicle_adjustments" USING btree ("addon_id","vehicle_category");--> statement-breakpoint
ALTER TABLE "addons" ADD CONSTRAINT "addons_slug_unique" UNIQUE("slug");
--> statement-breakpoint

-- Ceramic Protection (standalone) and the three coating packages, all inside
-- the existing Paint Protection category. Owner-confirmed prices:
--   Ceramic Protection  sedan $199   SUV/pickup $299
--   Crystal             sedan $399   SUV/pickup $419
--   Pro                 sedan $999   SUV/pickup $1,099
--   Max                 sedan $1,399 SUV/pickup $1,499
-- Durations are chosen to fit inside the 9-5 working day once the 15+15 minute
-- setup and cleanup buffers are added, otherwise the slot engine can never
-- offer the service at all.
INSERT INTO "services"
  ("id", "category_id", "name", "slug", "short_description", "base_price_cents",
   "base_duration_min", "booking_mode", "deposit_type", "deposit_value",
   "photos_required_for_quote", "active", "featured", "sort")
SELECT v."id", c."id", v."name", v."slug", v."short", v."price", v."duration",
       'bookable', 'none', 0, false, true, v."featured", v."sort"
FROM "service_categories" c
CROSS JOIN (VALUES
  ('svc_ceramicprotectionstd', 'Ceramic Protection - Standalone', 'ceramic-protection',
   'A single layer of ceramic protection applied on its own, without a detailing package.',
   19900, 120, false, 0),
  ('svc_ceramiccoatingcrystal', 'Ceramic Coating - Crystal', 'ceramic-coating-crystal',
   'Vehicle wash, paint preparation and ceramic coating application.',
   39900, 300, true, 1),
  ('svc_ceramiccoatingpro', 'Ceramic Coating - Pro', 'ceramic-coating-pro',
   'A higher-grade ceramic coating with a six-year warranty.',
   99900, 420, false, 2),
  ('svc_ceramiccoatingmax', 'Ceramic Coating - Max', 'ceramic-coating-max',
   'Our longest-lasting ceramic coating, with a premium top layer and a ten-year warranty.',
   139900, 450, false, 3)
) AS v("id", "name", "slug", "short", "price", "duration", "featured", "sort")
WHERE c."slug" = 'paint-protection'
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- SUV / truck / van deltas, stored the same way the flyer packages are: a
-- delta from the sedan price. Coupe, sedan and "other" pay the base price.
-- Duration deltas stay at zero for Pro and Max: both already sit at the top of
-- what one working day can hold, and adding time would remove every slot.
INSERT INTO "service_vehicle_adjustments"
  ("id", "service_id", "vehicle_category", "price_delta_cents", "duration_delta_min")
SELECT 'adj_' || s."key" || '_' || c."cat", s."service_id", c."cat", s."price_delta", s."duration_delta"
FROM (VALUES
  ('cerprot', 'svc_ceramicprotectionstd', 10000, 30),
  ('cercrys', 'svc_ceramiccoatingcrystal', 2000, 30),
  ('cerpro',  'svc_ceramiccoatingpro', 10000, 0),
  ('cermax',  'svc_ceramiccoatingmax', 10000, 0)
) AS s("key", "service_id", "price_delta", "duration_delta")
CROSS JOIN (VALUES ('suv_small'), ('suv_large'), ('pickup'), ('van'), ('commercial')) AS c("cat")
WHERE EXISTS (SELECT 1 FROM "services" WHERE "id" = s."service_id")
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- Ceramic protection as an Ultimate Detail add-on: $120 sedan, $199 SUV/pickup.
-- It is linked ONLY to Ultimate Detail, which is what makes the discounted
-- price unreachable on any other booking — price_booking refuses an add-on
-- that is not linked to a selected service, so the rule is enforced on the
-- server, not merely hidden in the UI.
INSERT INTO "addons" ("id", "name", "slug", "description", "price_cents", "duration_min", "active", "sort")
VALUES (
  'add_ceramicprotectionult',
  'Ceramic Protection - Ultimate Detail Add-On',
  'ceramic-protection-ultimate',
  'A single layer of ceramic protection, added to your Ultimate Detail.',
  12000, 45, true, 10
)
ON CONFLICT DO NOTHING;
--> statement-breakpoint

INSERT INTO "addon_vehicle_adjustments"
  ("id", "addon_id", "vehicle_category", "price_delta_cents", "duration_delta_min")
SELECT 'aja_cerprotult_' || c."cat", 'add_ceramicprotectionult', c."cat", 7900, 15
FROM (VALUES ('suv_small'), ('suv_large'), ('pickup'), ('van'), ('commercial')) AS c("cat")
WHERE EXISTS (SELECT 1 FROM "addons" WHERE "id" = 'add_ceramicprotectionult')
ON CONFLICT DO NOTHING;
--> statement-breakpoint

INSERT INTO "service_addons" ("id", "service_id", "addon_id")
SELECT 'add_link_cerprotult', s."id", 'add_ceramicprotectionult'
FROM "services" s
WHERE s."slug" = 'complete-detail-engine'
  AND EXISTS (SELECT 1 FROM "addons" WHERE "id" = 'add_ceramicprotectionult')
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- Ceramic services get no add-ons. The existing extras are interior work (pet
-- hair, salt stains) or a wax that a coating supersedes, so linking them would
-- offer the customer things that do not belong on a coating booking.

-- The old quote-only "Ceramic Coating" service is retired in favour of the
-- three packages. Deactivated rather than deleted: past appointments, invoices
-- and estimates reference it, and resolve_catalog_prices still reads inactive
-- services so that history keeps pricing correctly.
UPDATE "services"
SET "active" = false, "featured" = false, "sort" = 99, "updated_at" = now()
WHERE "slug" = 'ceramic-coating';
--> statement-breakpoint

-- Keep the remaining Paint Protection entries below the new ceramic ones.
UPDATE "services" SET "sort" = 10, "updated_at" = now() WHERE "slug" = 'paint-protection-film';
--> statement-breakpoint
UPDATE "services" SET "sort" = 11, "updated_at" = now() WHERE "slug" = 'wax-sealant';
