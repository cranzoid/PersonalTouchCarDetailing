# DECISIONS.md — Architecture Decision Log

Short log of consequential, potentially non-obvious decisions. Newest last.
Each is reversible unless noted; "revisit when" states the trigger.

## 1. Single Next.js app (no separate API service)
Public site, admin, customer access and API live in one Next.js App Router
deployment. Server actions for first-party forms; route handlers for webhooks
and file serving. Right-sized for a single-location business; avoids CORS,
auth duplication, and deploy orchestration.
**Revisit when:** a second client (mobile app, third-party integration) needs a
stable API surface → expose route-handler REST endpoints over the same libs.

## 2. PostgreSQL + Drizzle with committed SQL migrations
Real transactions are load-bearing (double-booking lock, financial writes).
Drizzle keeps the schema in TypeScript and generates reviewable SQL in
`drizzle/`. Local dev uses the Homebrew Postgres on socket `/tmp`.
**Revisit when:** choosing the production host (any managed Postgres ≥14 works).

## 3. Double-booking protection via bay-row `FOR UPDATE` locks
`createAppointment` locks all active bay rows, re-validates the slot from live
data, then inserts. This serializes bookings globally — deliberately coarse
and simple to reason about at 2-bay scale. UI availability is advisory only.
**Revisit when:** lock contention matters (many bays/locations) → move to an
exclusion constraint (`tstzrange` + GiST) or per-bay locking.

## 4. Text status columns + TypeScript unions instead of Postgres enums
Statuses/state machines live in `src/lib/types.ts` and are validated by Zod and
transition maps. Avoids ALTER TYPE migration friction while the model settles.
**Revisit when:** schema stabilizes post-launch; enums or CHECK constraints can
be added for DB-level integrity.

## 5. Prefixed app-generated ids (`cus_…`, `apt_…`)
Human-scannable in logs/URLs/support conversations; no DB sequence coupling;
generated via CSPRNG (100 bits).

## 6. Integer cents + basis-point rates; tax snapshotted at issue time
No floats in financial math. Estimates/invoices/appointments store the tax rate
used, so changing settings never rewrites history. **Not reversible cheaply —
treat as fixed.**

## 7. Sessions in the database, not JWTs
Staff sessions are hashed random tokens in `staff_sessions` — revocable
(deactivating staff kills access), auditable, no secret rotation dance.
Customer access uses the same pattern via `access_tokens` with narrow purposes.

## 8. Marketing-consent enforcement inside `sendMessage`
Callers cannot bypass consent by mistake: the messaging service checks
`customers.marketing_consent` for marketing-class kinds (incl. review requests
and maintenance reminders — conservative CASL-friendly reading) and records a
suppressed entry instead of sending. Operational messages always pass.

## 9. Photos private by default with a separate publication consent flag
`files.public_consent_at` + who recorded it. Gallery will only ever read files
where that consent exists. Serving goes through an authorized route handler.

## 10. Dev messaging/payment providers are in-process fakes
`sendMessage` logs to the communications table; payments table + webhook-event
dedupe are modelled but no provider is wired. Keeps dev free of credentials.
**Revisit when:** Phase 4/5 — add Stripe + Resend/Twilio adapters behind the
existing interfaces.

## 11. Availability = bay capacity (staff schedules modelled, not yet enforced)
Phase 1 availability is bay-count-based; staff schedules/skills tables exist
and the engine has the seam (`requiredSkills`) to add staff-shift filtering.
**Revisit when:** the business confirms staffing model (Phase 2/3).

## 12. Three-stage job pipeline; retired statuses mapped, never rewritten
Owner feedback: too many clicks between a vehicle arriving and leaving. The job
pipeline went from ten statuses to `checked_in → in_progress →
ready_for_pickup → completed`, and check-in now records arrival itself so a
confirmed appointment becomes a live job in one click. Inspection, QC and
additional-work approval keep their tables and screens but are optional side
activities, not stages — QC passes automatically at ready-for-pickup instead of
gating it behind ten checkboxes.

Because `jobs.status` is a text column (decision 4), the six retired values
(`inspection`, `awaiting_approval`, `ready`, `paused`, `quality_check`,
`correction_required`) needed no migration. Live rows are deliberately **not**
rewritten: `normalizeJobStatus` in `src/lib/job-status.ts` maps pre-work stages
to `checked_in` and mid-work stages to `in_progress` on read, so jobs that were
in flight when this shipped keep moving. A backfill is optional cleanup, not a
prerequisite.
**Revisit when:** no job row has held a retired status for a full service cycle
→ the backfill can run and `LEGACY_JOB_STATUS_MAP` can be deleted.

## 13. New-ownership content rule
No published years-in-business, inherited warranties, testimonials, or
historical claims anywhere. All such content is settings-driven or explicitly
marked as pending owner approval. **Fixed product rule, not a tech decision.**

## 14. Ad promotions: one offer, locked in cents, eligibility checked twice
The "10% off your first detail" ad applies itself — the code rides in the ad URL
(`/book?offer=CODE`), is captured by the existing attribution component so it
survives landing on the homepage first, and the customer never types anything.
Consequential choices:

- **One active promotion in `business_settings`** (jsonb, no migration), not a
  promotions table. Staff can change or kill the offer without a deploy.
- **Eligible services are an explicit opt-in list, failing closed.** An empty
  list discounts nothing. A category rule would have silently enrolled ceramic
  coating, tint and PPF the moment someone re-categorised a service.
- **The discount is locked in cents on `appointments.discount_cents`** and never
  recalculated; additional work approved at the shop is billed at full price.
  The percentage is deliberately *not* stored — storing a rate invites a later
  code path to recompute it. The label is snapshotted for the same reason
  `tax_label` is (decision 6).
- **A dedicated column, not a negative line item.** The estimate→appointment
  path uses a negative line, but a discount there would surface as *work* on the
  technician job sheet, the appointment services table and the deposit SMS.
- **"First-time" means first _fulfilled_ detail**: a prior appointment for an
  eligible service whose job reached ready-for-pickup/completed. A cancelled,
  no-show or still-upcoming booking does not consume the offer. A second guard
  blocks a customer who already holds an unfulfilled discounted booking, which
  is what stops three discounted bookings in one sitting.
- **Eligibility is re-checked inside the booking transaction**, after the
  existing bay/staff `FOR UPDATE` locks (decision 3). Those locks already
  serialize every booking, so the race needs no new lock. Losing the re-check
  rolls back the whole transaction — no appointment, no customer, no vehicle —
  and the customer confirms the corrected total on a second press.
- **No public "is this email a customer?" endpoint.** Warning a returning
  customer as they type would need an enumeration oracle; the two-phase confirm
  gives the same guarantee without one.
- **Codes are campaign-scoped** (`FIRST10AUG26`, never `FIRST10`). Claims persist
  in localStorage with no separate expiry, so changing the code is the real kill
  switch; re-using a retired one would honour stale claims.
- **The quote → estimate path enforces the same rules.** Staff may type any
  figure into the discount field, but the "Apply current offer" button re-checks
  eligibility server-side.

**Revisit when:** the business wants several offers at once, usage caps, or
per-campaign revenue reporting → promote the settings blob to a `promotions`
table and join `appointments.promo_code` for the breakdown.

## 15. Bookkeeping: expenses, monthly bills and a real P&L
The owners ran the shop's finances in an 11-tab Excel tracker alongside this
CRM. Revenue lived here; every cost lived there, so "what did I make this
month" could not be answered without the spreadsheet. `BUILD.md` §10 put
payroll and full bookkeeping out of scope; that call is now reversed for the
cost side, deliberately and in stages (expenses first, labour and payroll next).

- **`expenses` is a ledger, not a document.** Unlike invoices and payments,
  deleting an expense is a real `DELETE`. It is internal bookkeeping, not
  something issued to a customer, and the owners expect a mistyped row to
  disappear as it would in a spreadsheet. The whole row is written to
  `audit_log.before` first, so the ledger stays reconstructible.
- **Recurring bills become real expense rows.** In the sheet they were phantom
  formula cells you could not mark paid or reconcile. A generator inside the
  existing `/api/cron/tick` creates them, which is why the P&L never adds bills
  separately — they are already in the expense total.
- **Idempotency is a database guarantee, not a code convention.**
  `expenses_recurring_period_uq` on (`recurring_bill_id`, `period_month`) means
  the hourly tick creates a month's bills once and two racing app instances
  produce one row. Hand-entered expenses leave both columns NULL, and Postgres
  treats NULLs as distinct, so they never collide.
- **Seeded bills ship INACTIVE.** Their amounts came from the tracker and are
  samples. Generating real expense rows from an unconfirmed figure would invent
  financial history, so nothing is recorded until the owner confirms an amount
  and switches the bill on.
- **Months are business-local `YYYY-MM` text, not dates.** A bill belongs to a
  calendar month, not an instant, so there is no timezone to get wrong.
  Zero-padded keys also sort lexicographically in chronological order, which is
  what makes `dueRecurringBills` a string comparison with no date parsing.
- **Mixed basis, stated on the screen.** Sales accrue on invoices issued — the
  same set `summarizeTax` builds an HST return from, so the P&L and the tax
  report can never disagree. Expenses count on the date paid. This is what the
  spreadsheet did and how a small business actually files.
- **Calendar periods live beside the rolling windows.** `getReportWindow`
  (7/30/90 days) is unchanged; `getPeriodWindow` adds months, quarters and years
  because that is what a tax return and a bank statement are built from. Both
  ends stay true local midnight across a DST change.
- **Cost data is owner/manager/accountant only** via a new `manage_expenses`
  permission. Reception and technicians reach the dashboard, so the money strip
  and the bills card are gated inside the page, not merely hidden from the nav.

**Revisit when:** ~~Release 2 adds `timesheets` and staff pay rates~~ — done,
see #17. `expense_categories.is_payroll` now drives the payroll balance it was
added for.

## 16. Numbers are exempt from the CSV formula guard
`csvCell` prefixed anything starting with `-` with an apostrophe to defuse
spreadsheet formula injection. That also caught every negative money figure: a
refund exported as `'-30.00`, which Excel imports as **text**, so the
accountant's column silently stopped summing. Values matching `-?\d+(\.\d+)?`
now pass through unescaped — a plain decimal cannot be a formula — while
`-2+3+cmd` and `=cmd|calc` are still escaped. Both cases are pinned by tests in
`tests/reporting-export.test.ts`.

## 17. Labour: frozen per-day pay, and salary that accrues on the calendar
Release 2 folds the tracker's `Worker Hours` and `Payroll Payout` tabs into the
CRM. `BUILD.md` §10 had put payroll out of scope; that call is now reversed,
completing the reversal begun in #15.

- **Time is stored as integer minutes, not decimal hours.** The spec asked for
  `decimal(5,2)`, but #6 keeps floats out of financial math and the codebase
  already counts working time in minutes (`durationMin`). Hours are a display
  format; `formatMinutesAsHours` is the only place they exist.
- **Per-day pay is computed at save time and frozen** into
  `timesheets.pay_earned_cents`, the same discipline invoices use for prices
  (#6). A raise in October cannot rewrite what someone earned in September, and
  the week grid deliberately submits only the cells that changed so re-saving a
  week never re-freezes settled days at today's rate.
- **A monthly salary accrues per calendar month, independent of activity.** The
  spreadsheet's `Monthly Summary!B36` posted the whole salary if any single row
  existed for the month, so one job logged on the 2nd accrued $3,000 and a
  month with nothing written down accrued nothing. A salary is owed for the
  month either way. This is one of the two divergences the parallel run should
  expect, and the CRM is the one that is right.
- **Earned and paid stay two independent records.** Earned comes from
  timesheets and salaries; paid comes from `expenses` in a category flagged
  `is_payroll`. Nothing writes one from the other — the report exists precisely
  to show where they disagree. "Record payout" therefore calls the ordinary
  `createExpenseAction` rather than opening a second expense-insert path, so a
  payout is audited, exportable and inside the P&L like any other payment.
- **Payroll is matched on `staff_user_id`, never on a name.** The sheet matched
  a name typed into "Paid To", where one typo silently broke the balance. A
  payroll expense that names nobody is surfaced as an explicit
  `unassignedPaidCents` warning rather than being dropped from the total.
- **`computePayroll` returns lines and derives the totals from them**, instead
  of extending `computeProfitAndLoss` as the handoff sketched. Salary accrual
  needs the staff table and the period's month count, neither of which that
  function receives, and summing the lines makes it impossible for the per-person
  table and the variance under the P&L to disagree.
- **A work day is noon business-local**, matching `expenses.expense_date`. That
  makes the day deterministic, which is what lets
  `UNIQUE (staff_user_id, work_date)` actually mean "one row per person per
  day" — a week grid saved twice from two phones upserts instead of
  double-counting. Bare calendar arithmetic (`addDaysISO`) stays in UTC so a
  week does not gain or lose a day at a DST change.
- **Hours entry is `manage_timesheets` (owner, manager)**, not `manage_expenses`.
  The grid displays what everyone earned, so it is pay data; but entering hours
  is a daily shop-floor task and an accountant has no reason to do it. Letting a
  technician log *their own* hours needs an own-row-only gate and is deliberately
  not built — hiding a button is never the security boundary (#4 of the
  conventions in BUILD.md).

**Revisit when:** a technician needs to log their own hours, or the owners want
overtime rules, statutory holiday pay or source deductions — none of which the
tracker had and none of which are modelled here.

## 18. Payment-method tax: the shop's rule, implemented literally and recorded

**Context.** The owners' tracker prices every package tax-exclusive and adds tax
only for some payment methods: cash and Interac e-transfer are recorded with no
tax; credit and cheque add HST. Package #2 on a sedan is therefore $175.00 cash
and $197.75 card. Confirmed with the owner on 2026-08-18, along with the reading
that "Interac" means e-transfer, **not** Interac debit at the terminal — a card
terminal is credit.

**Decision.** Implemented exactly as written, with the disagreement recorded
rather than resolved in code.

- **This understates HST collected, and we said so.** The business is an HST
  registrant (`707187431RT0001`), and a registrant owes HST on every taxable
  supply regardless of how the customer pays. That was raised with the owner
  explicitly; they chose the literal reading of the tracker. It is their call
  and their filing. Nobody should quietly "fix" `PAYMENT_METHOD_TAXABLE` to
  tax-inclusive later — raise it with the owner instead. The tax report carries
  the spec's §4.5 footnote for whoever files the return, and that footnote is
  not decoration.
- **`invoices.tax_treatment` + `quoted_payment_method` make a restatement a
  query.** `tax_treatment` says what the document did (`added` | `none`);
  `quoted_payment_method` says whether a payment method is *why*. The sales to
  restate are `tax_treatment = 'none' AND quoted_payment_method IS NOT NULL` —
  a `WHERE` clause, not a year of re-entry, and it does not collide with the
  ordinary staff exemptions (out-of-province, exempt organisation) that leave
  `quoted_payment_method` NULL.
- **The choice lands where the shop actually learns the answer: recording the
  payment.** It shipped on invoice creation first — a required "How will they
  pay?" selector on all three paths — and that was wrong, because *the shop does
  not know*. The owners raise an invoice, send it, and find out how it is being
  settled when the customer settles it. Asking at creation forced staff to guess,
  and a guess written into a tax document is worse than no answer at all. So the
  invoice is raised **with tax**, and `resolvePaymentTax` in `recordPaymentAction`
  lets the **first payment** settle it: cash or e-transfer strips the tax and
  re-prices the document, card or cheque leaves it as issued, and either way the
  method is stamped so `paymentMethodConflict` can hold it steady afterwards.
- **The re-price is `total − tax`, not a recomputation from line items.** The two
  agree on every invoice the app can raise, but only subtraction is safe on one
  whose lines are missing — recomputing there would write a $0.00 total onto a
  real financial document. A test pins it.
- **The balance is checked against the re-priced total, before anything is
  written.** Tendering the taxed figure in cash is refused outright rather than
  stripping the tax and then rejecting the payment that caused it, which would
  leave the invoice re-priced by a payment that never happened.
- **A staff exemption outranks the payment-method rule.** An out-of-province
  customer paying by card is exempt for a reason that has nothing to do with
  payment; `resolveInvoiceTax` keeps their reason and leaves
  `quoted_payment_method` NULL.
- **A second payment cannot flip the answer.** Once one payment has settled the
  treatment, the opposite method is refused: the customer has already paid part
  of a total computed the other way, and re-pricing underneath them is worse
  than the inconsistency it fixes. Online card checkout is likewise refused on
  an invoice a cash payment has already stripped — in `claimInvoiceCheckout`,
  inside the row lock, because hiding the pay button is never the boundary.
- **An invoice already part-paid is never re-priced**, which is also what makes
  this safe for anything caught mid-payment by the release: those rows have
  `quoted_payment_method` NULL and a payment against them, so they simply carry
  on under the rate they were issued at.
- **The customer's copy does NOT show the cash price**, and briefly did, which
  was wrong. A cash sale is invoiced for the shop's records and **never sent**;
  every invoice that reaches a customer is therefore one being settled by card,
  cheque or online. Telling that customer they could have had 13% off is an odd
  thing for a bill to say, and it would invite a renegotiation at the moment of
  payment. The two prices belong on the public service pages, where quoting
  happens. The invoice is the bill for the method already agreed.
- **This deliberately breaks the appointment↔invoice reconciliation of #14.** An
  appointment snapshots a tax-added total at booking, and a cash job now invoices
  for less than the appointment quoted. That is the price of the rule, not a
  bug. The booking wizard still quotes tax-added as the conservative default and
  shows the cash figure alongside it; the invoice remains the tax document.
- **A staff exemption still outranks all of it** and binds no method, so
  `quoted_payment_method` stays NULL and the restatement query keeps pointing at
  payment-method sales only.
- **`setInvoiceTaxExemptAction` keeps the two columns honest**, moving
  `tax_treatment` with the exemption and clearing `quoted_payment_method` — a
  manual exemption is a different reason, and leaving the old method there would
  go on blocking payments under a rule that no longer applies.

**Also in this release, and much smaller:** an optional `discount_reason` shown
on the invoice when staff fill it in, and a "needs attention" card on Home
listing cars handed back but never invoiced. The card links to the record and
empties as the work is done, and nothing is ever auto-corrected.

**The discount reason was required for about an hour, and that was wrong.** Spec
§5 asked for it and the handoff repeated it, so it shipped as a blocking field
plus an attention rule for discounts that lacked one. The owner's answer on
seeing it was immediate: *we don't need a reason for a discount.* Two things
were wrong with it.

- **It blocked the counter on a fact nobody records.** The shop discounts for
  reasons that live in the conversation, not the ledger. Making an invoice
  un-raisable until someone types a story is a tax on the till, and staff under
  pressure would have typed "discount".
- **The attention rule could not be emptied.** It was bounded to 90 days, and I
  wrote in the code that this stopped it filling with pre-Release-3 invoices.
  That reasoning was simply wrong: the bound excludes rows *older* than 90 days,
  so every discounted invoice from the previous quarter qualified — ten of them,
  none of which could ever have carried a reason, because the column did not
  exist when they were raised. **A queue that cannot be emptied teaches people to
  ignore the queue**, which costs more than the rule was ever worth. The
  uninvoiced-car rule is kept because it *can* be cleared, by invoicing the car.

The column stays — it is written when someone chooses to fill it in, the
job-derived paths still record the promo that produced the discount, and
`summarizeDiscounts` already reports the totals for anyone who wants to look.

**Phone normalization is staff-side only.** `customers.phone_normalized` is bare
digits with a leading North American `1` dropped, written on every customer
write path and backfilled in `0008`. The index is **non-unique** on purpose:
live data already contains duplicates, and a unique constraint would have failed
the migration against production. Staff search matches it, and the customer list
flags numbers held by more than one record as a prompt for a human to merge.
`createBooking` writes it and deliberately does **not** read it — matching a
public booking to an existing customer by phone number is the customer
enumeration oracle #14 already refused, and Release 3 does not reopen it.
Deduplication and any unique constraint are a separate, owner-reviewed exercise.

**Revisit when:** the owner's accountant rules on the cash/Interac treatment (the
restatement query above is the first step), or the shop wants to dedupe the
customer table for real.

## 19. Custom appointment lines: staff price the work the catalog cannot
A booking may now carry hand-typed lines — a ceramic coating, paint correction,
anything quoted at the counter — instead of, or alongside, catalog packages.
`priceBooking` gained an optional `customLines` argument and its "select at
least one service" rule became "at least one line", so a coating-only booking is
possible with no package attached.

- **No migration.** `appointment_services` already allows a null `service_id`
  with a free-text description and its own price and duration; approved-estimate
  conversion has written lines that way since Phase 2. Custom lines therefore
  reach the invoice for free — `createInvoiceFromJobAction` copies those rows
  without caring where they came from.
- **The price is trusted because staff typed it.** That is the whole point, and
  it matches the custom lines the manual invoice builder already accepts. The
  guard is the actor, not the value: `customLines` is only ever passed from
  behind `manage_bookings`, and the public booking schema is a plain `z.object`
  that strips the key and still requires `serviceIds.min(1)`.
- **Duration is per line and mandatory in effect.** The scheduler books real
  chair time, so a coating that takes four hours must hold the bay for four
  hours. A catalog service brings its own duration; an all-custom booking has
  one only if staff type it, and both the slot lookup and the create action
  refuse a zero-length booking rather than reserving nothing.
- **Add-ons stay tied to a catalog service.** An all-custom booking gets no
  add-ons; the extra goes in a second custom line with its own price. The
  alternative — unlocking every add-on whenever a custom line exists — was
  considered and rejected by the owner as a needless second way to do the same
  thing. Custom lines are unlimited, so nothing is unreachable.
- **Custom lines carry no deposit and no promotion.** Deposits are a per-service
  catalog setting, so a booking made only of custom lines is confirmed outright
  rather than sitting in `deposit_required`. They are appended after the catalog
  lines so the deposit loop still walks only real services, and a promotion —
  which matches on `service_id` — can never reach a hand-priced line.

**Revisit when:** the shop wants a deposit on coating work. That needs a deposit
field on the custom line itself, since there is no catalog row to configure.

## 20. Marketing outreach is a campaign engine, not a second messaging system
Fleet prospecting (SMS and email) runs through the same `sendMessage` as every
other message, so the consent gate in #8 covers it by construction. What is new
is a campaign around it: `outreach_campaigns` holds the wording, and
`outreach_recipients` holds the list with the destination and merge values
**snapshotted at queue time** — editing a lead later must not change what we can
show was sent.

The decisions inside it that would not be obvious from the code alone:

- **Contacts are leads, not customers.** A card collected at a depot is somebody
  we might do business with, and the existing lead → customer conversion is
  already the path for when they say yes. This is why #8's gate was widened to
  accept a consented **lead**, which it previously rejected outright.
- **Opt-outs are keyed on the destination, not the person.** A consent flag on a
  lead cannot stop the next campaign when the same number comes back through the
  booking form as a fresh record. `marketing_suppressions` is keyed on the
  normalized destination, so an opt-out survives re-entry, duplicate records, and
  conversion — and binds the *other* channel too. Both the send path and the
  inbound webhook normalize through one function, because a mismatch there would
  file an opt-out that never matches anything and looks like it worked.
- **Never twice, across campaigns.** A unique index on
  `(campaign_id, destination_normalized)` collapses the same number entered
  twice; a send-time check against `sent` rows in *other* campaigns is what makes
  "don't text the same person twice" hold account-wide. `allow_recontact` opts
  out of the second check deliberately and is off by default.
- **Claim, then send.** Rows are flipped to `claimed` in a short transaction with
  `SKIP LOCKED`, and the provider calls happen outside it. Holding row locks
  across ten HTTP calls would pin a production connection for seconds, and a
  rollback *after* Twilio accepted a message would lose the record of a text
  already on its way. A row stuck in `claimed` means a crash mid-batch and is
  never retried automatically.
- **Batches, with no "send all" button.** `MAX_BATCH_SIZE` is 25 and the default
  is 5, so a mistake in the wording costs five messages you can read and stop.
- **CASL is enforced by the system, not by the person typing.** The email
  identity block and unsubscribe link are appended at send time rather than
  trusted to the campaign body; SMS bodies are rejected without an opt-out
  instruction. Sending is blocked outside 9am–8pm business-local.
- **The unsubscribe link acts on POST only.** Mail scanners and link-preview
  bots follow every URL in an email; a GET that unsubscribes would opt people out
  who never clicked. The token is an HMAC over the recipient row id, so no
  address appears in a URL and there is no expiry to get wrong.
- **START lifts the block but does not restore consent.** "You may text me
  again" is not "I consent to marketing"; a person has to re-record a basis.

**Revisit when:** volume outgrows hand-driven batches. The next step is a queue
worker over the same `pending` rows — the claim/send split already supports it —
plus Twilio delivery-status callbacks, which would replace "accepted by the
provider" with "delivered to the handset".

## 21. Counter revisions: rewrite the booking, not the invoice
A customer who books Package 2 online and takes Package 3 at the shop had no
path through the system. `appointment_services` was written by
`createAppointment` and by nothing else, so an upgrade had to be billed as a
bolt-on "additional work" line and a downgrade had no path at all short of
cancelling the invoice and hand-typing a new one — which silently dropped the
job link, the deposit and the promo provenance.

- **The booking is rewritten, not adjusted.** The invoice should read
  "Package 3", not "Package 2 + upgrade to Package 3". An adjustment layer would
  have produced a second source of truth about what the customer bought and left
  the technician's job sheet disagreeing with the bill.
- **What was booked survives in two places.** The audit log holds the full
  before/after lines; `appointments.original_subtotal_cents` holds the first
  subtotal, because reporting cannot practically join the audit log and "the ad
  sold a $175 package — what did the counter actually sell?" is the entire point
  of storing `promo_code`. Both columns are nullable and unbackfilled.
- **The discount is re-applied by default — a narrow exception to #14.** That
  rule stops *incidental* code paths from recomputing a stored figure. Here a
  staff member is knowingly re-pricing a sale that changed, and their choice
  (re-apply / keep as goodwill / remove) plus a mandatory reason is written to
  `invoices.discount_reason` and the audit log. Re-applying gives the same
  percentage of the new price; a package that is not on the offer drops to nil
  rather than silently carrying a discount the ad never promised.
- **Promotion eligibility is deliberately NOT re-checked.**
  `isFirstTimeDetailCustomer` fails anyone already holding an unfulfilled
  discounted booking — which this customer does, because of the very booking
  being revised. Re-running it would strip the discount from every revision.
- **A longer job warns, it does not block.** Whether to take the money and run
  late is the shop's call. A downgrade shortens the job and is applied silently.
- **`isJobOpenForRepricing`, not `isJobOpenForSideWork`.** Side work closes at
  `in_progress`, but an invoice only exists from `ready_for_pickup`. Reusing the
  side-work gate made the draft-invoice rebuild unreachable — caught by a test,
  not by review.
- **The appointment gate is `converted`, and that is the whole point.** Checking
  a car in stamps the appointment `converted`, so every customer at the counter
  is in that state. The first cut of the set was written from the status list
  rather than from `checkInAppointmentAction` and left it out, which shipped a
  feature that refused the exact case it existed for. Every test set the status
  by hand, so nothing caught it; there is now one that goes through check-in.
- **A visit that is over can still be corrected until the money settles.** The
  stage is not the guard — the invoice is. Repricing only ever rewrites a DRAFT
  invoice, and any payment moves an invoice off draft, so a settled sale is
  refused on those grounds. This matters because the most common correction of
  all is a car handed back, invoiced at end of day from stale booked lines, and
  only then noticed. Gating that on job stage left no way to fix an invoice
  nobody had paid. Bay-overlap checking is skipped once the job is complete:
  the car has left, so the bay time is history.
- **Cancelling an invoice releases its jobs.** `cancelInvoiceAction` used to
  update only the invoice row, leaving `jobs.invoice_id` set and the
  `invoice_jobs` row in place — and since `invoice_jobs_job_uq` is unique on
  `job_id` and `createInvoiceFromJobAction` refuses a job that already has an
  invoice, a cancelled job-derived invoice could never be replaced. "Cancel and
  re-issue" was a dead end that pushed staff into a manual invoice, dropping the
  job link, the deposit application and the promo provenance. Cancelling now
  clears both. The cancelled document keeps its number and its line items: it
  stays readable history, and only its CLAIM on the job is released.
- **A paid invoice is still refused, with different advice.** Cancelling is
  refused there too, so the message says to refund it or bill the difference
  separately rather than pointing at a cancel that will not work.
- **A draft invoice is rewritten in place, keeping its number**, its
  `invoice_jobs` row and its deposit. Anything already sent is refused: rewriting
  a document the customer has been emailed is not something to do quietly.
- **The deposit is never re-based, and the overhang is not silently swallowed.**
  A downgrade can leave the deposit larger than the new total;
  `createInvoiceFromJobAction` caps what it applies, so without surfacing it the
  difference would vanish from every screen. It is derived, shown on the
  appointment and the invoice, and joins the needs-attention queue.
- **The deposit refund goes against the APPOINTMENT, not the invoice.** A
  deposit payment row carries `appointment_id` with a null `invoice_id` and
  reaches the invoice only through `depositAppliedCents` inside
  `summarizePayments`. A refund row written against the invoice would push
  `netPaidCents` below the total and flip a fully-settled invoice back to
  `partially_paid`, chasing the customer for money they do not owe.
- **Nothing here touches the payment-method tax path** (#18). Revision and
  payment-method settlement stay independent: the invoice is still raised with
  tax and the first payment still settles it. The order at the counter is
  revise, then take payment — once a payment lands the invoice is no longer a
  draft and the packages can no longer be changed.

**Revisit when:** the shop needs to correct an invoice that has already been
PAID. That needs a real credit note — a negative document referencing the
original number, so HST already reported is reversed on the record rather than
by editing history — and, given the payment-method rule above, the accountant's
view on how that reversal is reported. Deliberately not improvised here.

## 22. Invoicing a visit that was never checked in: record the job, don't re-parent the invoice
The shop finishes cars two ways. "Check In Vehicle" creates a job and stamps the
appointment `converted`, and the job screen invoices from it. But the path
actually used in production — "Mark Arrived", then "Mark Completed" — creates no
job at all, and since an invoice hangs off `jobs`, that path could not bill
anyone. Staff were pushed into `/admin/invoices/new`, a blank form that drops the
deposit, the promo provenance and any link back to the booking: exactly the
failure mode #21 was written to close, reached through a different door.

- **The missing job is written, rather than teaching invoices about
  appointments.** Adding `invoices.appointment_id` would have meant a second
  parent for an invoice, a second uniqueness rule to keep "one invoice per
  visit" true, and a second copy of the deposit/discount/promo/tax logic. The
  car really was detailed, so the job row is not a fiction — it is the record
  nobody wrote. `invoice_jobs_job_uq` then keeps enforcing one invoice per visit
  for free.
- **Everything downstream starts seeing these visits, which is the point.** The
  needs-attention "handed back but never invoiced" card, the lead funnel's
  completed-job count, and maintenance reminders all key off `jobs`, and all of
  them were blind to half the shop's work.
- **`buildInvoiceForJob` is shared, not copied.** Both entry points run the same
  money path; the audit row records which one raised it. A second copy is
  precisely the drift that once re-billed a discounted booking at full price.
- **The job is dated to the visit, not to the paperwork.** `completed_at` is the
  appointment's `ends_at`, because maintenance reminders count months from the
  visit. Stamping it `now` would push every future reminder late by however long
  the invoice sat unraised.
- **Back-filling old paperwork must not send mail.** A visit older than
  `maintenanceReminderMonths` would be due the instant its job row appears, and
  the next cron tick would text the customer "time for your next detail?" about
  a car they brought in months ago. Such a job is created with
  `maintenance_reminder_sent_at` already stamped, and the audit row records the
  suppression.
- **The appointment stays `completed`.** It is not moved to `converted`: the
  status describes the visit, and the visit is over. Only `jobs.id` is written
  onto it, which is how the screen finds the invoice it produced.
- **Nothing here asks about tax or payment method** (#18). The invoice is raised
  with tax and the first payment settles it. A tax choice on this screen would
  be a second way to zero HST that does not populate `quoted_payment_method`,
  and `tax_treatment = 'none' AND quoted_payment_method IS NOT NULL` would
  quietly stop being the complete restatement.
- **Changing what is billed still happens on the appointment** (#21). The panel
  has no line editor: "Change packages" rewrites the booking and its draft
  invoice together, so the two can never disagree. An editor inside the invoice
  flow would be a second source of truth about what the customer bought, and
  would have to re-derive duration, bay overlap and the deposit overhang that
  `reviseAppointmentLines` already handles. The appointment screen's revise gate
  had also drifted out of step with the server's `REVISABLE` set, hiding the
  panel on exactly the `completed` visits #21 widened it for; the two now match.

**Revisit when:** the shop wants to invoice a walk-in that never had an
appointment at all. That is still the manual builder, and it still drops the
deposit and promo columns because there was never a booking to carry them from.

## 23. Expense receipts reuse `files`, but not `/api/files/[id]`
An expense had a number and no paper. Receipts now hang off the existing `files`
table with `entity_type = 'expense'` — that column is free text by design (see
the table's own note), so a new kind of attachment needs no migration, which
matters because staging shares the production database and only additive
changes are safe there.

- **A separate serving route, gated on `manage_expenses`.** Reusing
  `/api/files/[id]` was the obvious move and the wrong one: it gates on
  `view_private_files`, which is held by reception and technicians — the two
  roles deliberately excluded from `manage_expenses` so they cannot see what the
  business pays — and is NOT held by the accountant, who enters expenses for a
  living. The same route would have leaked cost data downward and locked out the
  one person who needs it. `/api/expense-receipts/[id]` also filters on
  `entity_type`, so it can only ever return a receipt, never a customer's
  before-and-after photos.
- **PDFs are receipts too.** A hydro bill or supplier invoice arrives as a PDF
  far more often than as a photo. An images-only feature would have sent the
  owner back to a folder on the desktop, which is the failure this replaces.
- **Deleting an expense takes its receipts with it,** storage keys recorded in
  `audit_log.before` first. An expense is a real DELETE (#15); leaving the
  paperwork orphaned would have made that deletion only half true. `files` rows
  are always deleted through an `entity_type = 'expense'` filter, and
  `deletePrivateFile` only ever receives keys read out of those rows, so this
  path structurally cannot reach a customer's job photos.
- **A failed upload never rolls back the expense.** The row saves first and the
  files attach after, so a flaky connection loses an attachment, not the entry.
  The form keeps the staged files so the owner can simply press save again.

**Revisit when:** a receipt needs to be readable by the customer, or expenses
need to be entered from a phone camera in one tap. Both mean a real upload
pipeline (thumbnails, OCR, direct-to-storage) rather than a form post.

## 24. Correcting the vehicle a booking was priced from
The public booking form asks the customer to pick their own vehicle size, and
they get it wrong — a large SUV booked as a sedan is *priced* as a sedan,
because package prices come from `service_vehicle_adjustments` keyed on that
category. The only fix was to edit the vehicle on the customer record, which
corrected the CRM and left the booking priced at the old size.

- **One action does both halves.** `updateAppointmentVehicleAction` fixes the
  car (or points the booking at a different one of the customer's cars) and, if
  that changes the pricing size, re-prices the SAME selection through
  `priceBooking` → `reviseAppointmentLines`. Which packages the customer chose
  is untouched; changing that is still "Change packages" (#21). One re-pricing
  path, not a second copy of the money logic.
- **The re-price runs BEFORE the vehicle row is written.** The bay-overlap
  warning is a two-press flow. Had the vehicle been saved on the first press,
  the second press would have compared the new size against itself, found
  nothing changed, and skipped the very re-pricing being confirmed.
- **A settled sale is corrected but not re-priced.** If the invoice has been
  sent or paid, the vehicle still saves — the car really is an SUV — and the
  prices are left alone with a message naming the invoice. Silently rewriting a
  document the customer has seen is the thing #21 refuses to do; the
  alternative, refusing the correction outright, would leave "Sedan" on an SUV
  forever. The same applies when a package has since been retired and can no
  longer be quoted: the correction lands, the money does not move, and the
  reason is shown rather than swallowed.
- **A vehicle swap drags the job and the DRAFT invoice with it.** Both carry
  their own `vehicle_id`; left behind, an invoice would go out describing a car
  that was never here. A non-draft invoice is deliberately not touched.
- **`REVISABLE` is exported rather than copied.** Three screens were about to
  hold their own copy of the re-pricing gate, and the last time that happened
  the lists drifted and hid the panel on exactly the visits the server had been
  widened to allow (#22). `isRevisableAppointmentStatus` is the one list.

### Adding a customer or a vehicle without leaving the screen
The invoice builder's "add the customer first" was a link to a list with a
button on it, and then a manual walk back to the half-built invoice. It now
opens the form directly (`?new=1`) and returns with the customer selected
(`?next=`, restricted to `/admin/` paths so it cannot become an open redirect).
The vehicle dropdown grew an "Add vehicle" dialog that goes through the existing
`addCustomerVehicleAction` — so the gate stays `manage_customers`, and an
accountant raising an invoice is told they cannot edit the CRM rather than
having this screen quietly widen what their role can do.

**Revisit when:** the shop wants to correct the vehicle on a sale that has
already been paid and have the money follow. That is a credit note (#21), not an
edit.

## 25. Ceramic protection and ceramic coating are two products, priced by the ordinary catalogue
Ceramic coating was quote-only (`inspection_required`, no price), so every
enquiry became a manual quote. It is now priced and bookable — but the owner
sells *two* ceramic things, and the expensive way to get this wrong is to blur
them. **Ceramic protection** is a single layer of ceramic protection.
**Ceramic coating** is the premium service, in three packages. They are never
described, priced or labelled interchangeably, and the $120 figure is never
allowed to read as the price of a coating.

- **No second pricing system.** All five products are ordinary `services` /
  `addons` rows with `service_vehicle_adjustments`, priced by `priceBooking`
  like every other package. `src/lib/ceramic.ts` holds only what a price column
  cannot: which slugs are ceramic, the editorial content, and the disclaimer.
  Every price on the ceramic pages is read from the catalogue per request, so
  Admin → Services still moves them without a deploy.
- **The $120 rule is a foreign key, not a UI rule.** Ceramic protection at the
  discounted price is an add-on linked *only* to Ultimate Detail. `priceBooking`
  already refuses an add-on that is not linked to a selected service, so the
  qualification is enforced server-side and a hand-written URL cannot buy it
  alone. The standalone service is a separate row at its own higher price.
  Changing service in the wizard keeps the add-ons the new service still offers
  and *announces* the ones it dropped, rather than silently shrinking the total.
- **Add-ons gained vehicle-size pricing** (`addon_vehicle_adjustments`), because
  ceramic protection costs more on an SUV whether or not it is bought with a
  detail. Deliberately the same shape as `service_vehicle_adjustments` so one
  rule — base plus category delta — still explains every price on the site, and
  editable in the same admin control.
- **Durations are capped by the working day, not by the work.** The slot engine
  requires setup + work + cleanup to fit between opening and closing, so a
  service over 450 minutes is offered *no times at all* — which reads to a
  customer as "never available". Crystal 300, Pro 420, Max 450: Max therefore
  offers exactly one start per day, which is the honest answer for a full-day
  job. This is why the retired 480-minute ceramic coating could never have been
  booked even if it had carried a price.
- **Paint correction is never folded into a coating price.** The displayed price
  covers the coating for the chosen vehicle category; condition-dependent prep
  goes through the existing additional-work approval flow. The disclaimer sits
  next to the estimate in the booking summary, not buried in an FAQ.
- **Only ceramic-relevant extras.** The interior extras (pet hair, salt stains)
  and Wax / Buff are linked to the detailing packages only. The seed used to
  link every add-on to every bookable service, which would have offered pet-hair
  removal on a $1,399 coating.
- **The old `ceramic-coating` service row is deactivated, not deleted** — past
  appointments and invoices reference it, and `resolveCatalogPrices` reads
  inactive services so that history still prices. `/services/ceramic-coating` is
  now a hand-written hub comparing the three packages, and static routes win
  over `/services/[slug]`.
- **Ads deep-link into a configured cart.** `/book?service=…&addon=…` (add-ons
  gained a `slug` for this) lands a campaign on a ready-made booking. It is only
  a suggestion — the add-on is applied only if the chosen service offers it — so
  a stale ad URL lands on a valid cart instead of one the server would reject.

**Revisit when:** a coating genuinely needs to occupy the bay for more than one
working day. That is multi-day scheduling, not a longer `base_duration_min`.

## 26. Listed prices are tax-exclusive, and a page that has nothing to show is absent
A round of owner corrections that mostly pull in one direction: the site should
state the price the shop actually quotes, and should not fill space with
scaffolding for content that does not exist yet.

- **Every public price is now tax-exclusive.** `withTaxCents` has left the
  public pages entirely — the home page, `/services`, both ceramic pages and
  `/services/[slug]`, including their `schema.org` `Offer` prices. Tax is added
  once, in the cart: the booking wizard's live estimate already showed
  subtotal → tax → total, and that is now the only place the customer sees a
  tax-added figure. The reason is not cosmetic — cash and Interac sales charge
  no tax at all (#8), so a tax-inclusive list price was wrong for a large share
  of sales and right for none of them. `withTaxCents` itself stays, because
  `dualPriceLabel` still needs it.
- **Commercial vehicles are quoted, never priced.** `QUOTE_ONLY_VEHICLE_CATEGORIES`
  in `src/lib/types.ts` is read by both the public price tables (which render
  "By quote" for that row) and the public booking actions (which refuse the
  category outright). It lives in `types.ts` rather than in a page because the
  failure we are avoiding is the two disagreeing: a table saying "By quote"
  beside a wizard happily charging sedan-plus-a-delta. Staff booking and
  invoicing are untouched — pricing commercial work by hand is the point.
- **Ceramic protection's large-vehicle delta is $30, not $100** — $199 sedan,
  $229 SUV/truck/van. Corrected by migration as a delta, for the same reason as
  #25's Crystal correction. The standalone price still sits above the qualified
  add-on price ($199 on a large vehicle), so the Ultimate Detail condition keeps
  meaning something.
- **Pro is the recommended coating package**, flagged once in `COATING_PACKAGES`
  and rendered as a lifted, outlined card rather than a bare badge — a badge
  beside two visually identical cards reads as decoration. Pro and Max both
  list Carfax vehicle history registration. A test pins that exactly one package
  is flagged and that it is the middle one, because the highlight is positional.
- **The Results surface only exists once something is published.** No published
  case study means no nav link, no `/results` page (it 404s), no sitemap entry,
  and no "View real results" chips on the service pages; the home page's results
  band is gated on there being consent-approved photos. Publishing in
  Admin → Results IS the switch — there is no separate flag to forget to flip —
  and `hasPublishedResults()` asks the same question the page's own query asks,
  so a story that would not render can never light up the link. The three-step
  "here is how publishing will work" placeholder is gone: that was a note to
  ourselves rendered at customers, and it made a working site look unfinished.
- **The services dropdown closes like a menu.** It was a bare `<details>`, which
  only closes when you click the summary a second time, so the panel followed
  the customer around the page. It is now a small client component that closes
  on pointer leave, outside click, Escape, blur-out and navigation.
- **Saturday is 9am–6pm**, corrected by migration for open Saturdays only, so a
  shop that has since closed Saturdays in Admin stays closed. Both ends are set
  rather than the one that looked wrong in the seed: the live row had already
  been edited in Admin, so a migration written against the seed's values moved
  nothing. Check the row, not the seed, before writing a data migration.

**Revisit when:** the shop starts quoting commercial work from a rate card. That
is a second price list keyed by vehicle class, not a delta on the sedan price.
