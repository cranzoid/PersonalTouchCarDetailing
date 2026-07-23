CREATE TABLE "invoice_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"invoice_id" text NOT NULL,
	"job_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_limit_buckets" (
	"key" text PRIMARY KEY NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"reset_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "marketing_consent" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "marketing_consent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "marketing_consent_source" text;--> statement-breakpoint
ALTER TABLE "invoice_jobs" ADD CONSTRAINT "invoice_jobs_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_jobs" ADD CONSTRAINT "invoice_jobs_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invoice_jobs_invoice_idx" ON "invoice_jobs" USING btree ("invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_jobs_job_uq" ON "invoice_jobs" USING btree ("job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_jobs_invoice_job_uq" ON "invoice_jobs" USING btree ("invoice_id","job_id");--> statement-breakpoint
INSERT INTO "invoice_jobs" ("id", "invoice_id", "job_id", "created_at")
SELECT 'ij_' || md5("id" || ':' || "job_id"), "id", "job_id", "created_at"
FROM "invoices"
WHERE "job_id" IS NOT NULL
ON CONFLICT ("job_id") DO NOTHING;
