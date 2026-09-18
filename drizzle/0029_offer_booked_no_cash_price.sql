-- The first-wash booking confirmation quoted a cheaper price for cash and
-- Interac e-transfer. The owner wants that off everything a customer sees: the
-- shop's payment-method tax treatment (DECISIONS.md #18) is its own
-- arrangement, not a discount being advertised. One price, tax on top.
-- Requested 2026-09-18.
--
-- WHY A MIGRATION: this template key was created by the seed earlier the same
-- day, so the row already exists on every environment. seed-runner.ts inserts
-- with onConflictDoNothing and therefore never rewrites an existing body —
-- editing the seed alone fixes a fresh installation and leaves this one as it
-- was.
--
-- The old body is matched in full, so this cannot clobber a body an owner has
-- since edited by hand in Admin -> Communications. No customer has received
-- this template: it is only sent by the book-first flow, which shipped
-- switched off.
UPDATE "message_templates"
SET "body" = 'Hi {{firstName}},

You''re booked in for your {{offerLabel}}.

  When: {{when}}
  Where: {{address}}
  Price: {{price}} plus tax — {{priceWithTax}} in total
  Your code: {{code}}

Show the code when you arrive — it is what applies the offer to your bill. There is nothing to pay in advance.

Need a different time, or can''t make it? Call or text us on {{phone}} and we will move it.

One promotional wash per customer and per vehicle. Full terms are on the offer page.

— {{businessName}}
{{address}}
{{phone}} · {{email}}

Don''t want emails from us? Unsubscribe here: {{unsubscribe}}',
    "updated_at" = now()
WHERE "key" = 'offer_claim_booked_email'
  AND "body" = 'Hi {{firstName}},

You''re booked in for your {{offerLabel}}.

  When: {{when}}
  Where: {{address}}
  Price: {{price}} with cash or Interac e-transfer, {{priceWithTax}} on card or cheque
  Your code: {{code}}

Show the code when you arrive — it is what applies the offer to your bill. There is nothing to pay in advance.

Need a different time, or can''t make it? Call or text us on {{phone}} and we will move it.

One promotional wash per customer and per vehicle. Full terms are on the offer page.

— {{businessName}}
{{address}}
{{phone}} · {{email}}

Don''t want emails from us? Unsubscribe here: {{unsubscribe}}';
