-- Tips: a gratuity on the invoice, after tax and outside the tax base.
--
-- Additive only, by the rule every migration here follows: the staging slot
-- shares the production database and applies migrations at boot, so this lands
-- while the OLD build is still serving live traffic. Drizzle selects columns by
-- name, so that build never sees these two. ADD COLUMN with a constant default
-- is catalogue-only on Postgres 11+, so no table is rewritten and no long lock
-- is held — and the NOT NULL DEFAULT 0 means every existing invoice reads back
-- as "no tip", which is exactly what it was.

-- The gratuity itself. Part of total_cents, never part of subtotal_cents: a tip
-- is not consideration for a taxable supply, so it must stay out of the HST
-- base. Keeping it outside the subtotal is what enforces that, because the tax
-- and P&L reports build their base from subtotal_cents - discount_cents.
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "tip_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint

-- How the tip was expressed, when it was a percentage (1500 = 15%). NULL means
-- a flat dollar amount was typed. Provenance for the document to print; the
-- cents above stay authoritative.
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "tip_basis_bp" integer;
