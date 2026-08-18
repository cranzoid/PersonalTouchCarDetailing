CREATE TABLE "expense_categories" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"is_payroll" boolean DEFAULT false NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "expenses" (
	"id" text PRIMARY KEY NOT NULL,
	"expense_date" timestamp with time zone NOT NULL,
	"category_id" text NOT NULL,
	"paid_to" text,
	"staff_user_id" text,
	"description" text,
	"amount_cents" integer NOT NULL,
	"tax_paid_cents" integer DEFAULT 0 NOT NULL,
	"paid_by" text DEFAULT 'other' NOT NULL,
	"reference" text,
	"auto_generated" boolean DEFAULT false NOT NULL,
	"recurring_bill_id" text,
	"period_month" text,
	"confirmed_at" timestamp with time zone,
	"confirmed_by_staff_id" text,
	"notes" text,
	"created_by_staff_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recurring_bills" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"category_id" text NOT NULL,
	"amount_cents" integer DEFAULT 0 NOT NULL,
	"start_month" text NOT NULL,
	"end_month" text,
	"paid_by" text DEFAULT 'preauthorized' NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_category_id_expense_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."expense_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_staff_user_id_staff_users_id_fk" FOREIGN KEY ("staff_user_id") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_recurring_bill_id_recurring_bills_id_fk" FOREIGN KEY ("recurring_bill_id") REFERENCES "public"."recurring_bills"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_confirmed_by_staff_id_staff_users_id_fk" FOREIGN KEY ("confirmed_by_staff_id") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_created_by_staff_id_staff_users_id_fk" FOREIGN KEY ("created_by_staff_id") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_bills" ADD CONSTRAINT "recurring_bills_category_id_expense_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."expense_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "expenses_date_idx" ON "expenses" USING btree ("expense_date");--> statement-breakpoint
CREATE INDEX "expenses_category_idx" ON "expenses" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "expenses_staff_idx" ON "expenses" USING btree ("staff_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "expenses_recurring_period_uq" ON "expenses" USING btree ("recurring_bill_id","period_month");--> statement-breakpoint
CREATE INDEX "recurring_bills_active_idx" ON "recurring_bills" USING btree ("active");