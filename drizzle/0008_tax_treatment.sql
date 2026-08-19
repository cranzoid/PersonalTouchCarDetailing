ALTER TABLE "customers" ADD COLUMN "phone_normalized" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "tax_treatment" text DEFAULT 'added' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "quoted_payment_method" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "discount_reason" text;--> statement-breakpoint
CREATE INDEX "customers_phone_normalized_idx" ON "customers" USING btree ("phone_normalized");--> statement-breakpoint
-- Backfill the normalized phone for customers that already exist. Contact data
-- is not money, so unlike invoices/payments it may be derived after the fact
-- (DECISIONS.md #6 covers only financial history). Bare digits, with a leading
-- North American "1" dropped so +1 905… and 905… find each other. This MUST
-- stay byte-identical to normalizePhone() in src/lib/phone.ts.
UPDATE "customers"
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
