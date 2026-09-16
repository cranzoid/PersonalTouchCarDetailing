-- Booking confirmations quoted a price ("Estimated total: {{total}}"); the
-- owner wants customers to see what they booked, not a total, at
-- confirmation time. Requested 2026-09-17.
--
-- The message_templates row is only ever inserted once, on the first seed
-- run (onConflictDoNothing), and nothing has updated it since — so the live
-- body is whichever of these two shapes seeding wrote at the time:
--   - the original text, from before the first-detail-offer discount line
--     existed (no {{discountLine}})
--   - the text seed-runner.ts has carried since (with {{discountLine}})
-- Both are matched exactly so this never clobbers a body an owner has since
-- edited by hand in Admin -> Communications.
UPDATE "message_templates"
SET "body" = 'Hi {{firstName}},

Your appointment on {{date}} at {{time}} is confirmed.

Service: {{services}}
Vehicle: {{vehicle}}

If you need to reschedule, reply to this email or call us.

— {{businessName}}',
    "updated_at" = now()
WHERE "key" = 'booking_confirmation'
  AND "body" IN (
    'Hi {{firstName}},

Your appointment on {{date}} at {{time}} is confirmed.

Service: {{services}}
Vehicle: {{vehicle}}
Estimated total: {{total}}

If you need to reschedule, reply to this email or call us.

— {{businessName}}',
    'Hi {{firstName}},

Your appointment on {{date}} at {{time}} is confirmed.

Service: {{services}}
Vehicle: {{vehicle}}
{{discountLine}}Estimated total: {{total}}

If you need to reschedule, reply to this email or call us.

— {{businessName}}'
  );
--> statement-breakpoint

-- New SMS confirmation. This is a brand-new key, so the ordinary seed path
-- (onConflictDoNothing in seed-runner.ts) inserts it on every environment —
-- no migration needed for that half. This UPDATE is the only part that
-- needs a migration, because it touches a row that may already exist.
