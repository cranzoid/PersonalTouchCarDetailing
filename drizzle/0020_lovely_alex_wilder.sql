CREATE TABLE "blog_posts" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"excerpt" text DEFAULT '' NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"seo_title" text,
	"seo_description" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"published_at" timestamp with time zone,
	"created_by_staff_id" text NOT NULL,
	"updated_by_staff_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "blog_posts_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "service_bundle_offers" (
	"id" text PRIMARY KEY NOT NULL,
	"primary_service_id" text NOT NULL,
	"bundled_service_id" text NOT NULL,
	"discount_percent_bp" integer NOT NULL,
	"label" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "compare_at_price_cents" integer;--> statement-breakpoint
ALTER TABLE "blog_posts" ADD CONSTRAINT "blog_posts_created_by_staff_id_staff_users_id_fk" FOREIGN KEY ("created_by_staff_id") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blog_posts" ADD CONSTRAINT "blog_posts_updated_by_staff_id_staff_users_id_fk" FOREIGN KEY ("updated_by_staff_id") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_bundle_offers" ADD CONSTRAINT "service_bundle_offers_primary_service_id_services_id_fk" FOREIGN KEY ("primary_service_id") REFERENCES "public"."services"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_bundle_offers" ADD CONSTRAINT "service_bundle_offers_bundled_service_id_services_id_fk" FOREIGN KEY ("bundled_service_id") REFERENCES "public"."services"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "blog_posts_status_idx" ON "blog_posts" USING btree ("status","published_at");--> statement-breakpoint
CREATE INDEX "blog_posts_updated_idx" ON "blog_posts" USING btree ("updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "service_bundle_offers_pair_uq" ON "service_bundle_offers" USING btree ("primary_service_id","bundled_service_id");--> statement-breakpoint
CREATE INDEX "service_bundle_offers_primary_idx" ON "service_bundle_offers" USING btree ("primary_service_id","active");--> statement-breakpoint

-- The public current price becomes the amount actually charged. The former
-- catalogue price is retained separately for the crossed-out comparison.
UPDATE "services"
SET "compare_at_price_cents" = "base_price_cents",
    "base_price_cents" = GREATEST(0, "base_price_cents" - 10000),
    "updated_at" = now()
WHERE "slug" = 'ceramic-coating-pro'
  AND "base_price_cents" IS NOT NULL
  AND "compare_at_price_cents" IS NULL;--> statement-breakpoint

UPDATE "services"
SET "compare_at_price_cents" = "base_price_cents",
    "base_price_cents" = GREATEST(0, "base_price_cents" - 15000),
    "updated_at" = now()
WHERE "slug" = 'ceramic-coating-max'
  AND "base_price_cents" IS NOT NULL
  AND "compare_at_price_cents" IS NULL;--> statement-breakpoint

-- Crystal unlocks 15% off any of the three main detailing packages. Pro and
-- Max unlock 50%. Subqueries keep the migration independent of generated IDs.
INSERT INTO "service_bundle_offers"
  ("id", "primary_service_id", "bundled_service_id", "discount_percent_bp", "label")
SELECT
  'bof_crystal_' || detail."slug",
  coating."id",
  detail."id",
  1500,
  'Crystal detailing bundle — 15% off'
FROM "services" coating
CROSS JOIN "services" detail
WHERE coating."slug" = 'ceramic-coating-crystal'
  AND detail."slug" IN ('complete-detail-engine', 'the-works', 'interior-detail')
ON CONFLICT ("primary_service_id", "bundled_service_id") DO NOTHING;--> statement-breakpoint

INSERT INTO "service_bundle_offers"
  ("id", "primary_service_id", "bundled_service_id", "discount_percent_bp", "label")
SELECT
  'bof_pro_' || detail."slug",
  coating."id",
  detail."id",
  5000,
  'Pro detailing bundle — 50% off'
FROM "services" coating
CROSS JOIN "services" detail
WHERE coating."slug" = 'ceramic-coating-pro'
  AND detail."slug" IN ('complete-detail-engine', 'the-works', 'interior-detail')
ON CONFLICT ("primary_service_id", "bundled_service_id") DO NOTHING;--> statement-breakpoint

INSERT INTO "service_bundle_offers"
  ("id", "primary_service_id", "bundled_service_id", "discount_percent_bp", "label")
SELECT
  'bof_max_' || detail."slug",
  coating."id",
  detail."id",
  5000,
  'Max detailing bundle — 50% off'
FROM "services" coating
CROSS JOIN "services" detail
WHERE coating."slug" = 'ceramic-coating-max'
  AND detail."slug" IN ('complete-detail-engine', 'the-works', 'interior-detail')
ON CONFLICT ("primary_service_id", "bundled_service_id") DO NOTHING;
