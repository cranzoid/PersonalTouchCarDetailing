CREATE TABLE "case_studies" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"challenge" text DEFAULT '' NOT NULL,
	"process" text DEFAULT '' NOT NULL,
	"outcome" text DEFAULT '' NOT NULL,
	"primary_service_id" text NOT NULL,
	"related_service_ids" text[] DEFAULT '{}' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"consent_confirmed_at" timestamp with time zone,
	"consent_confirmed_by_staff_id" text,
	"privacy_checked_at" timestamp with time zone,
	"privacy_checked_by_staff_id" text,
	"published_at" timestamp with time zone,
	"created_by_staff_id" text NOT NULL,
	"updated_by_staff_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "case_studies_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "case_study_media" (
	"id" text PRIMARY KEY NOT NULL,
	"case_study_id" text NOT NULL,
	"file_id" text NOT NULL,
	"role" text DEFAULT 'result' NOT NULL,
	"caption" text DEFAULT '' NOT NULL,
	"alt_text" text NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "case_studies" ADD CONSTRAINT "case_studies_primary_service_id_services_id_fk" FOREIGN KEY ("primary_service_id") REFERENCES "public"."services"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_studies" ADD CONSTRAINT "case_studies_consent_confirmed_by_staff_id_staff_users_id_fk" FOREIGN KEY ("consent_confirmed_by_staff_id") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_studies" ADD CONSTRAINT "case_studies_privacy_checked_by_staff_id_staff_users_id_fk" FOREIGN KEY ("privacy_checked_by_staff_id") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_studies" ADD CONSTRAINT "case_studies_created_by_staff_id_staff_users_id_fk" FOREIGN KEY ("created_by_staff_id") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_studies" ADD CONSTRAINT "case_studies_updated_by_staff_id_staff_users_id_fk" FOREIGN KEY ("updated_by_staff_id") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_study_media" ADD CONSTRAINT "case_study_media_case_study_id_case_studies_id_fk" FOREIGN KEY ("case_study_id") REFERENCES "public"."case_studies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_study_media" ADD CONSTRAINT "case_study_media_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "case_studies_status_idx" ON "case_studies" USING btree ("status","published_at");--> statement-breakpoint
CREATE INDEX "case_studies_primary_service_idx" ON "case_studies" USING btree ("primary_service_id");--> statement-breakpoint
CREATE UNIQUE INDEX "case_study_media_case_file_unique" ON "case_study_media" USING btree ("case_study_id","file_id");--> statement-breakpoint
CREATE INDEX "case_study_media_case_sort_idx" ON "case_study_media" USING btree ("case_study_id","sort");