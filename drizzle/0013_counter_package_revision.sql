ALTER TABLE "appointments" ADD COLUMN "revised_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "original_subtotal_cents" integer;