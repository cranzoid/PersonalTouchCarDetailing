CREATE TABLE "timesheets" (
	"id" text PRIMARY KEY NOT NULL,
	"work_date" timestamp with time zone NOT NULL,
	"staff_user_id" text NOT NULL,
	"minutes" integer DEFAULT 0 NOT NULL,
	"pay_earned_cents" integer DEFAULT 0 NOT NULL,
	"notes" text,
	"created_by_staff_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "staff_users" ADD COLUMN "pay_type" text DEFAULT 'hourly' NOT NULL;--> statement-breakpoint
ALTER TABLE "staff_users" ADD COLUMN "hourly_rate_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "staff_users" ADD COLUMN "daily_rate_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "staff_users" ADD COLUMN "monthly_salary_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "timesheets" ADD CONSTRAINT "timesheets_staff_user_id_staff_users_id_fk" FOREIGN KEY ("staff_user_id") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timesheets" ADD CONSTRAINT "timesheets_created_by_staff_id_staff_users_id_fk" FOREIGN KEY ("created_by_staff_id") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "timesheets_date_idx" ON "timesheets" USING btree ("work_date");--> statement-breakpoint
CREATE INDEX "timesheets_staff_idx" ON "timesheets" USING btree ("staff_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "timesheets_staff_day_uq" ON "timesheets" USING btree ("staff_user_id","work_date");