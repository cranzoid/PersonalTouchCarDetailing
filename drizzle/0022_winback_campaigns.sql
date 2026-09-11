-- Win-back campaigns: message the people who cancelled or did not show up.
--
-- Additive only. The staging slot shares the production database and applies
-- migrations at boot, so every column here must be optional to the build that
-- is still serving traffic when this lands.

-- Why the appointment was missed. `cancellation_reason` already records the
-- cancelled case; a no-show had nowhere to put one, so the reason only ever
-- reached the audit log, which the campaign screens cannot practically join.
ALTER TABLE "appointments" ADD COLUMN "no_show_note" text;

-- An HTML email campaign. Kept BESIDE `body` rather than replacing it: `body`
-- stays the plain-text part of the same message, which is what non-HTML
-- clients render and what the communications history stays readable as.
ALTER TABLE "outreach_campaigns" ADD COLUMN "body_html" text;

-- How this campaign's list was built ('manual' when pasted). Informational —
-- the recipient rows below are the record of who was actually queued.
ALTER TABLE "outreach_campaigns" ADD COLUMN "audience" text;

-- The missed appointment this recipient came from, and the reason as it read
-- WHEN THEY WERE QUEUED. Snapshotted for the same reason the merge values are
-- (DECISIONS.md #20): editing the appointment later must not change what we
-- can show the campaign was built from.
ALTER TABLE "outreach_recipients" ADD COLUMN "appointment_id" text REFERENCES "appointments"("id");
ALTER TABLE "outreach_recipients" ADD COLUMN "context_note" text;
ALTER TABLE "outreach_recipients" ADD COLUMN "last_visit_label" text;

CREATE INDEX IF NOT EXISTS "outreach_recipients_appointment_idx"
  ON "outreach_recipients" ("appointment_id");

-- Finding everyone who cancelled or no-showed in a window is the core audience
-- query and runs on every load of the campaign builder.
CREATE INDEX IF NOT EXISTS "appointments_missed_idx"
  ON "appointments" ("status", "starts_at")
  WHERE "status" IN ('cancelled', 'no_show');
