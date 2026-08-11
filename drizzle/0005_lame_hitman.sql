ALTER TABLE "appointments" ADD COLUMN "discount_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "promo_code" text;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "promo_label" text;