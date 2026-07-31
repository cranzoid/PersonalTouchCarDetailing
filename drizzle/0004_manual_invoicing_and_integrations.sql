CREATE TABLE "integration_credentials" (
	"key" text PRIMARY KEY NOT NULL,
	"value_encrypted" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_staff_id" text
);
--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "tax_exempt" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "tax_exempt_reason" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "invoice_date" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "created_by_staff_id" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_created_by_staff_id_staff_users_id_fk" FOREIGN KEY ("created_by_staff_id") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Existing invoices were issued on the day they were created. Backfilling lets
-- queries order and filter on invoice_date directly instead of COALESCE-ing.
-- Every change in this migration is additive, so the production code running
-- during the staging boot (before the slot swap) is unaffected.
UPDATE "invoices" SET "invoice_date" = "created_at" WHERE "invoice_date" IS NULL;