CREATE TABLE "marketing_suppressions" (
	"id" text PRIMARY KEY NOT NULL,
	"channel" text NOT NULL,
	"destination" text NOT NULL,
	"reason" text NOT NULL,
	"source" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outreach_campaigns" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"channel" text NOT NULL,
	"subject" text,
	"body" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"allow_recontact" boolean DEFAULT false NOT NULL,
	"created_by_staff_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outreach_recipients" (
	"id" text PRIMARY KEY NOT NULL,
	"campaign_id" text NOT NULL,
	"lead_id" text,
	"customer_id" text,
	"destination" text NOT NULL,
	"destination_normalized" text NOT NULL,
	"first_name" text DEFAULT '' NOT NULL,
	"company_name" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"skip_reason" text,
	"rendered_body" text,
	"communication_id" text,
	"claimed_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "company_name" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "phone_normalized" text;--> statement-breakpoint
ALTER TABLE "outreach_campaigns" ADD CONSTRAINT "outreach_campaigns_created_by_staff_id_staff_users_id_fk" FOREIGN KEY ("created_by_staff_id") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_recipients" ADD CONSTRAINT "outreach_recipients_campaign_id_outreach_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."outreach_campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_recipients" ADD CONSTRAINT "outreach_recipients_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_recipients" ADD CONSTRAINT "outreach_recipients_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_recipients" ADD CONSTRAINT "outreach_recipients_communication_id_communications_id_fk" FOREIGN KEY ("communication_id") REFERENCES "public"."communications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "marketing_suppressions_channel_dest_uq" ON "marketing_suppressions" USING btree ("channel","destination");--> statement-breakpoint
CREATE INDEX "outreach_recipients_campaign_idx" ON "outreach_recipients" USING btree ("campaign_id");--> statement-breakpoint
CREATE UNIQUE INDEX "outreach_recipients_campaign_dest_uq" ON "outreach_recipients" USING btree ("campaign_id","destination_normalized");--> statement-breakpoint
CREATE INDEX "outreach_recipients_dest_idx" ON "outreach_recipients" USING btree ("destination_normalized");--> statement-breakpoint
CREATE INDEX "leads_phone_normalized_idx" ON "leads" USING btree ("phone_normalized");--> statement-breakpoint
-- Backfill the normalized phone for leads that already exist, so an inbound SMS
-- can be matched back to a lead captured before this release. Byte-identical to
-- the customers backfill in 0008 and to normalizePhone() in src/lib/phone.ts.
UPDATE "leads"
SET "phone_normalized" = NULLIF(
  CASE
    WHEN length(regexp_replace("phone", '[^0-9]', '', 'g')) = 11
     AND left(regexp_replace("phone", '[^0-9]', '', 'g'), 1) = '1'
      THEN right(regexp_replace("phone", '[^0-9]', '', 'g'), 10)
    ELSE regexp_replace("phone", '[^0-9]', '', 'g')
  END,
  ''
)
WHERE "phone" IS NOT NULL AND "phone_normalized" IS NULL;
