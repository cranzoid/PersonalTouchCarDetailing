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
- **The customer's copy shows the cash price.** The invoice goes out with tax on
  it, so the portal names the other figure — *"Paying in cash or by Interac
  e-transfer? $175.00"* — rather than quietly asking for more than the counter
  will charge.
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
