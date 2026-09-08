ALTER TABLE "service_bundle_offers" ADD COLUMN "perk_label" text;--> statement-breakpoint
ALTER TABLE "service_bundle_offers" ADD COLUMN "perk_note" text;--> statement-breakpoint

-- The paint touch-up rides on the two 50% pairings only, and it is opt-in:
-- pricing adds a zero-priced line when the customer asks for it, never
-- automatically. Crystal's 15% rows keep a null perk. Matching on the coating
-- slug keeps this independent of generated ids and of the owner's own naming.
UPDATE "service_bundle_offers"
SET "perk_label" = 'Free paint chip touch-up',
    "perk_note" = 'Bring your own colour-matched paint pen and we will apply it during the visit.',
    "updated_at" = now()
WHERE "primary_service_id" IN (
  SELECT "id" FROM "services"
  WHERE "slug" IN ('ceramic-coating-pro', 'ceramic-coating-max')
);
