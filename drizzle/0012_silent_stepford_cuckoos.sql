ALTER TABLE "communications" ADD COLUMN "cc" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "cc_emails" text[] DEFAULT '{}' NOT NULL;