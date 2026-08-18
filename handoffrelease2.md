# Handoff — Excel tracker retirement, after Release 2

**Read this file first and in full.** It is designed to be the only document you
need to start Release 3. The original build spec
(`Car_Detailing_Business_Tracker_PRO_empty.xlsx` → `car-detailing-crm-build-spec.md`)
is **not in this repository**, so every formula and requirement Release 3
depends on is reproduced here verbatim.

Written 2026-08-19, immediately after Release 2 was built. It supersedes the
Release 1 handoff, which it replaces in full.

---

## 1. What this project is

**Personal Touch Car Detailing** — a single-location detailing shop in Hamilton,
Ontario. This repository is their custom CRM, **live in production** at
`https://www.personaltouchcardetailing.ca`.

**Stack.** Next.js 15 App Router (one deployment: public site, admin, customer
portal, webhooks), PostgreSQL 16 + Drizzle with committed SQL migrations in
`drizzle/`, server actions for first-party forms, Zod at every boundary, Vitest.
Hosted on Azure App Service with a staging slot; infra is Terraform in
`infra/terraform/`.

**The customer journey it already implements:**

```
lead / quote / direct booking
  → customer + vehicle
  → estimate and approval when needed
  → staffed appointment and deposit
  → check-in → job → QC
  → individual or consolidated invoice
  → online/manual payment, receipt, refund
  → portal history, review request, maintenance reminder
```

**Read these before writing code:** `BUILD.md` (product spec), `DECISIONS.md`
(architecture decision log — §15 and §16 are Release 1, §17 is Release 2),
`WORKFLOW.md` (state and operations, including the "Bookkeeping" and "Labour and
payroll" sections for the owners).

---

## 2. The background: why this work exists

The owners ran the **cost** side of the business in an 11-tab Excel tracker
alongside this CRM. Revenue lived in the CRM; every expense, hour worked and
payroll payment lived in the spreadsheet. "What did I make this month" could not
be answered without opening Excel.

A build spec was written to fold the tracker into "the existing CRM". That spec
was written **without sight of this codebase**, and about **60% of it was already
built, and built better** — including six of the seven "deliberate deviations"
it listed as the whole point of the exercise (frozen prices, no tips, no row
caps, multi-year, per-vehicle-tier pricing, plus attribution, photos, booking
state and payment status from its own "feature gaps" section).

The genuinely missing part is what `BUILD.md` §10 had explicitly placed out of
scope: **bookkeeping and payroll**. Releases 1 and 2 have now delivered both.
Release 3 is the remainder.

### Two things in the spec that must NOT be built as written

1. **The spec's `jobs` table is a flat spreadsheet row carrying its own
   pricing.** This CRM deliberately splits that across `appointments` → `jobs` →
   `invoices` → `payments`. Porting the spec's shape would create a second,
   conflicting source of revenue truth on a live financial database.
   **Money keeps flowing through `invoices`/`payments`. Never write prices onto
   `jobs`.**
2. **The spec's phone-dedup rule, applied to the public booking path, would build
   a customer enumeration oracle** — a stranger typing someone else's phone
   number would attach to their record. `DECISIONS.md` §14 already refused to
   build exactly this. Phone matching in Release 3 is **staff-side only**.

---

## 3. Hard constraints — violating these breaks production

### 3.1 The database is hot and staging shares it

`.github/workflows/azure-release.yml` deploys to a staging slot, then swaps. The
workflow's own comment says it plainly: **the staging slot shares the production
database and applies migrations at boot** (`src/instrumentation.ts` →
`bootstrapDatabase()` → migrations + seed, before accepting traffic).

So a migration lands on **live production data before the swap**, while the
**old production build is still serving traffic**. Therefore every migration
must be:

- **New tables only**, or new columns that are **nullable or defaulted**.
- **No** renames, drops, type changes, or `NOT NULL` without a default.
- **No** unique constraint over existing rows in the same migration that
  backfills them.
- Readable by the **currently deployed** build, which knows nothing about it.

`drizzle/0006_bookkeeping.sql` (three `CREATE TABLE`s) and
`drizzle/0007_labour.sql` (one `CREATE TABLE` plus four defaulted `ADD COLUMN`s
on `staff_users`) are the reference examples. Defaulted column adds do not
rewrite the table in PG11+, and Drizzle emits explicit column lists, so the
running production build never sees the new columns.

### 3.2 Never migrate money

No backfill, recompute, or rewrite of `invoices`, `payments`, `estimates`, or
`appointments`. Frozen financial history is the product (`DECISIONS.md` §6, marked
*not reversible cheaply*). Release 2 extends the same rule to
`timesheets.pay_earned_cents`.

### 3.3 Backups

35-day point-in-time restore, geo-redundancy disabled. **The Burstable tier
cannot take on-demand backups**, and the server has `public_network_access =
false`, so there is no local `pg_dump` either. PITR to a *new* server is the only
recovery path. The `stage` job prints the restore timestamp into its run summary
— capture it before swapping.

```bash
az postgres flexible-server restore \
  --resource-group rg-ptcd-prod --name psql-ptcd-restored \
  --source-server psql-ptcd-prod-7mutra \
  --restore-time <TIMESTAMP FROM THE STAGE RUN SUMMARY>
```

### 3.4 Codebase conventions

- **Money is integer cents** (`*_cents`); **rates are basis points** (`*_bp`,
  13% HST = 1300). No floats in financial math ever. See `src/lib/money.ts`.
- **Time is stored `timestamptz` (UTC); business-local math happens in code** via
  `src/lib/tz.ts` (`zonedToUtc`, `formatInZone`, `localDateISO`). Never use
  `toISOString().slice(0,10)` for a business date — after ~8pm Toronto it reports
  tomorrow.
- **Ids are app-generated and prefixed** — `newId("exp")` in `src/lib/id.ts`. Add
  the prefix to the `IdPrefix` union first.
- **Enum-ish columns are `text`**; allowed values live in `src/lib/types.ts` and
  are enforced by Zod at boundaries (`DECISIONS.md` §4).
- **Pure math is extracted and unit-tested**, with database work confined to
  loaders. Follow `src/lib/books.ts` / `src/lib/payroll.ts` and their tests.
- **Every server action calls `requireStaff(permission)`** and writes `audit()`
  in the same transaction as the mutation. Hiding a button is never the security
  boundary.
- Financial rows are never deleted; cancellation is a status + audit entry.
  (Expenses are the one deliberate exception — see §5.3.)

---

## 4. Owner decisions — settled, do not relitigate

Confirmed by the owner on 2026-08-18:

| Question | Decision |
|---|---|
| Tax on cash/Interac (spec §2) | **Implement the spec literally.** Cash/Interac record `tax = 0`; credit/cheque add HST. |
| What "Interac" means | **e-Transfer** (`etransfer`), *not* Interac debit at the card terminal. |
| A fast counter-sale "Add Job" screen | **Not being built.** The appointment → check-in → job → invoice path stays. |
| Customer changes payment method after invoicing | **Cancel and re-issue** the invoice. Do not allow a taxability mismatch. |
| Scope and order | **Phased: bookkeeping → labour → tax.** |

### The tax decision, with its caveat recorded

The business is an HST registrant (`707187431RT0001` in `SETTINGS_DEFAULTS`). A
registrant owes HST on **every taxable supply regardless of how the customer
pays**, so recording a cash sale as `tax_amount = 0` **understates HST
collected**. This was raised explicitly with the owner, who chose the literal
reading of the spec anyway. That is their call and Release 3 carries it.

**Your obligations because of that decision:**

- Store `tax_treatment` on the invoice so a later restatement is a *query*, not a
  year of re-entry.
- Do not silently "improve" the rule to tax-inclusive. If you think it should
  change, raise it — do not implement something different.
- Keep the spec's §4.5 footnote on the tax report: *cash and Interac sales are
  recorded with no tax charged; confirm treatment with your accountant before
  filing.*

**Consequence of "no counter-sale screen":** the payment-method choice has no
"Add Job" flow to live in, so in Release 3 it lands on **invoice creation** —
the step that actually produces the tax document.

---

## 5. Release 1 — SHIPPED and LIVE (2026-08-18)

PR #12, squashed to `30eaf25`. Deployed via stage → verify → swap; restore point
`2026-08-18T11:40:47Z`. Production verified healthy after swap with the service
catalog byte-identical to the pre-deploy baseline.

### 5.1 What it delivers

- **`/admin/expenses`** — one row per outgoing payment, with month/quarter/year
  navigation, category breakdown, and CSV export.
- **`/admin/settings/bookkeeping`** — owner-editable expense categories and
  recurring monthly bills.
- **Profit & loss in `/admin/reports`** — net sales, expenses by category, net
  profit, margin, year-over-year comparison, and HST input credits.
- **Home (`/admin`)** — this month's net sales / expenses / net profit, plus a
  card prompting the owner to confirm auto-generated bills.
- **CSV exports** — `pnl` and `expenses` kinds, in the tracker's layout.

### 5.2 Tables added (`drizzle/0006_bookkeeping.sql`)

```
expense_categories  id, name, is_payroll, sort, active, timestamps
recurring_bills     id, name, category_id→expense_categories, amount_cents,
                    start_month TEXT 'YYYY-MM', end_month TEXT|null, paid_by,
                    active, notes, timestamps
expenses            id, expense_date timestamptz, category_id→expense_categories,
                    paid_to, staff_user_id→staff_users|null, description,
                    amount_cents, tax_paid_cents, paid_by, reference,
                    auto_generated, recurring_bill_id→recurring_bills|null,
                    period_month TEXT|null, confirmed_at, confirmed_by_staff_id,
                    notes, created_by_staff_id, timestamps
```

Indexes: `expenses_date_idx`, `expenses_category_idx`, `expenses_staff_idx`, and
**`expenses_recurring_period_uq` UNIQUE on (`recurring_bill_id`, `period_month`)**.

### 5.3 Design decisions that still bind

- **Months are business-local `YYYY-MM` text, not dates.** A bill belongs to a
  calendar month, not an instant, so there is no timezone to get wrong.
  Zero-padded keys sort lexicographically in chronological order, which is why
  `dueRecurringBills` is a string comparison with no date parsing.
- **Idempotency is a database guarantee, not a flag.** The unique index means the
  hourly cron creates a month's bills once, and two racing app instances produce
  one row. There is a concurrency test for this.
- **Seeded bills ship INACTIVE.** Their amounts are samples from the tracker;
  generating expense rows from an unconfirmed figure would invent financial
  history. **This is still an outstanding owner task — see §8.**
- **Expenses are hard-`DELETE`d**, unlike invoices/payments. An expense is
  internal bookkeeping, not a document issued to a customer, and the owners
  expect a mistyped row to vanish as it would in a spreadsheet. The whole row is
  written to `audit_log.before` first, so the ledger stays reconstructible.
- **Payroll expenses are keyed by `staff_user_id`, never by a name string.**
  Release 2's payroll report depends on this — never match on name.
- **Accounting basis, stated on the report screen:** sales accrue on **invoices
  issued** (the same set `summarizeTax` builds an HST return from, so the P&L and
  the tax report can never disagree); expenses count on the **date paid**.
- **Cost data is gated *inside* the page**, not merely hidden from the nav —
  `view_dashboard` includes technicians.

### 5.4 The code Release 3 builds on

**`src/lib/books.ts`** — all pure and unit-tested except the loaders at the
bottom. Reuse these rather than writing new ones:

| Export | Use |
|---|---|
| `getPeriodWindow(kind, year, index, tz)` | Whole calendar month/quarter/year as a half-open UTC range. DST-safe. |
| `priorYearPeriod(period, tz)` | Same period one year earlier, for YoY. |
| `monthKey(date, tz)` | Business-local `"YYYY-MM"` for an instant. |
| `monthKeysInPeriod(period)` | Every `"YYYY-MM"` a period touches. |
| `monthStartDate(month, tz)` | First business-local day of a `"YYYY-MM"`. |
| `summarizeExpenses(rows, categories)` | Totals by category + input tax credits. |
| `computeProfitAndLoss(invoices, expenseSummary)` | The P&L. |
| `computeTaxPosition(pnl)` | Collected − input credits = net owing. |
| `validateExpenseInput(input, category)` | Blocking rules, owner-facing wording. |
| `taxIncludedInCents(amountCents, taxRateBp)` | HST *within* a tax-inclusive total. |
| `getBooksSnapshot(kind, year, index)` | Full P&L + tax + YoY for a period. |
| `listExpenses(period, categoryId?)` | Ledger rows with category and staff resolved. |
| `generateRecurringBills(now)` | The idempotent monthly generator. |

**Other files from Release 1:**

- `src/app/admin/(app)/expenses/{page,expense-manager,actions,confirm-bills-card}.tsx`
- `src/app/admin/(app)/settings/bookkeeping/{page,bookkeeping-manager,actions}.tsx`
- `src/components/period-nav.tsx` — the shared month/quarter/year stepper. **Reuse it.**
- `src/lib/reporting-csv.ts` — `pnl` + `expenses` export kinds; `BOOKS_EXPORT_KINDS`, `parsePeriodKind`.
- `src/app/api/cron/tick/route.ts` — generator wired in.
- `src/lib/auth/permissions.ts` — `manage_expenses: ["owner","manager","accountant"]`.
- `src/lib/types.ts` — `EXPENSE_PAYMENT_METHODS`, `EXPENSE_PAYMENT_METHOD_LABELS`, `DEFAULT_EXPENSE_CATEGORIES`.
- `tests/books.test.ts` (24), `tests/recurring-bills.test.ts` (10).

### 5.5 Bug fixed in passing

`csvCell` in `src/lib/reporting-csv.ts` escaped any value starting with `-` to
defuse CSV formula injection — which also caught every negative money figure. A
refund exported as `'-30.00`, which **Excel imports as text**, so the
accountant's column silently stopped summing. Plain decimals matching
`-?\d+(\.\d+)?` now pass through; `-2+3+cmd` and `=cmd|calc` are still escaped.
Both halves are pinned by tests.

---

## 6. Release 2 — Labour and payroll (BUILT, NOT YET DEPLOYED)

Branch `release-2-labour-payroll`. Retires the tracker's `Worker Hours` and
`Payroll Payout` tabs. **Not yet staged or swapped — see §10.**

### 6.1 Migration `drizzle/0007_labour.sql` — additive only, verified

Four defaulted columns on `staff_users`:

```
pay_type             text    NOT NULL DEFAULT 'hourly'   -- hourly | daily_fixed | monthly_fixed
hourly_rate_cents    integer NOT NULL DEFAULT 0
daily_rate_cents     integer NOT NULL DEFAULT 0
monthly_salary_cents integer NOT NULL DEFAULT 0
```

Everyone therefore starts hourly at a **zero** rate, which earns nothing — the
defaults cannot invent payroll for staff whose terms nobody has entered yet.

New `timesheets` table, one row per staff member per day:

```
id, work_date timestamptz, staff_user_id → staff_users,
minutes integer, pay_earned_cents integer, notes,
created_by_staff_id, created_at, updated_at
UNIQUE (staff_user_id, work_date)   -- timesheets_staff_day_uq
```

Plus `timesheets_date_idx` and `timesheets_staff_idx`. The unique index is on a
brand-new empty table, so it cannot fail against production rows.

`PAY_TYPES`, `PAY_TYPE_LABELS` and `PAY_TYPE_RATE_FIELD` are in
`src/lib/types.ts`; `"tsh"` was added to `IdPrefix`.

`staff_schedules` is **not** this table — it is a weekly *shift template* used by
the availability engine and carries no money. It was left alone.

### 6.2 `src/lib/payroll.ts` — pure, unit-tested

Same shape as `books.ts`: everything above the loaders is pure.

| Export | Use |
|---|---|
| `computeDayPayCents(terms, minutes)` | What one day earned (spec §4.3). |
| `computePayroll({staff, timesheets, payments, monthsSpanned})` | Lines per person + totals. |
| `validatePayTerms(input)` / `validateTimesheetMinutes(m)` | Blocking rules, owner-facing wording. |
| `workDateToUtc(day, tz)` | A calendar day as the stored instant (noon business-local). |
| `addDaysISO` / `weekDays` / `weekStartISO` / `weekLabel` | Bare calendar arithmetic, UTC, DST-proof. |
| `formatMinutesAsHours(minutes)` | Display only. |
| `getPayrollSnapshot(period)` | Loader: the payroll position for a calendar period. |
| `getTimesheetWeek(mondayISO)` | Loader: one week of the grid. |
| `listPayrollStaff()` | Loader: staff with pay terms, inactive included. |

Per-day pay, exactly as the spec's §4.3 table:

```
hourly:        pay = round(minutes / 60 × hourly_rate_cents)
daily_fixed:   pay = minutes > 0 ? daily_rate_cents : 0
monthly_fixed: pay = 0                    # nothing accrues per day
```

Reconciliation, per person and summed into the totals:

```
variable_earned = Σ timesheets.pay_earned in period
fixed_accrued   = monthly_salary × months_spanned, for ACTIVE monthly_fixed staff
earned          = variable_earned + fixed_accrued
paid            = Σ expenses.amount WHERE category.is_payroll AND staff_id matches
balance         = earned − paid          # > 0 means still owed
```

**The spreadsheet's accrual bug is fixed.** `Monthly Summary!B36` posted the
entire monthly salary if any single row existed for that month. Here a salary
accrues for **every month the staff member is active, independent of activity**;
a month with zero timesheet rows is pinned by a test.

Three decisions worth knowing before you extend this:

- **Pay is frozen at save time.** `saveTimesheetWeekAction` computes
  `pay_earned_cents` from the rate as it stands and stores it, the way an
  invoice snapshots prices. The week grid submits **only changed cells**, so
  re-saving a week never re-freezes settled days at a newer rate.
- **`computePayroll` derives its totals by summing its lines**, rather than
  extending `computeProfitAndLoss` as the Release 1 handoff sketched. Salary
  accrual needs the staff table and the period's month count, neither of which
  that function receives; summing the lines makes the per-person table and the
  variance under the P&L incapable of disagreeing.
- **A payroll expense naming nobody** is reported as `unassignedPaidCents` with
  a visible warning, not silently dropped from the total paid.

### 6.3 UI

- **`/admin/staff`** — pay type + the one rate that type uses, owner-only
  (`manage_staff`), audited as `staff.pay_updated`. All three rate columns are
  stored whatever the type is, so switching to salaried and back does not erase
  an hourly rate.
- **`/admin/timesheets`** — the week grid. A card per staff member, seven day
  boxes (2 cols on a phone, 7 on a laptop), hours in / minutes stored, live pay
  preview, sticky save bar. Deactivated staff are hidden unless they already
  have hours that week. Zero minutes deletes the day rather than storing an
  empty shift — a zero row would still read as a day worked and a day rate pays
  by the day.
- **`/admin/reports/payroll`** — per person for a month/quarter/year: hours,
  days, earned, paid, balance, with the shared `PeriodNav`.
- **"Record payout"** on any row with a balance — a dialog prefilled with the
  payroll category, the staff member, the balance and today's date. It calls
  **`createExpenseAction`** from `src/app/admin/(app)/expenses/actions.ts`.
  There is deliberately no second expense-insert path. Wages record
  `taxPaidCents: 0` — a payout claims no input tax credit.
- **`/admin/reports`** — payroll earned / paid out / variance under the P&L,
  linking through to the full report.

**Permissions:** new `manage_timesheets: ["owner", "manager"]` for hours entry —
narrower than `manage_expenses` because the grid shows what everyone earned, and
an accountant has no reason to enter hours. The payroll report is
`view_financial_reports`; recording a payout additionally needs
`manage_expenses`; rates are `manage_staff`. **A technician logging their own
hours is deliberately NOT built** — it needs an own-row-only gate, not a
widened permission.

### 6.4 Tests — 41 added, 320 passing

`tests/payroll.test.ts` (33) and `tests/timesheet-actions.test.ts` (8) cover:
all three pay types; `daily_fixed` paying a full day for any `minutes > 0`;
`monthly_fixed` accruing nothing per day; salary accrual in a month with **zero**
timesheet rows; salary × months for quarters and years; balance returning to
zero after a payout; the `UNIQUE (staff_user_id, work_date)` constraint
rejecting a duplicate day; the upsert converging instead of double-counting;
frozen `pay_earned_cents` surviving a later rate change; matching by id when two
staff share a name; totals equalling the sum of the lines; and DST-safe week
arithmetic.

### 6.5 Verified in a running production build

`npm run build && PORT=3131 npm run start`, owner session minted per §9.2:

- `/admin/timesheets` and `/admin/reports/payroll` return 200 for an owner,
  307 anonymous.
- **Gating:** technician → 404 on Hours, Payroll, Reports, Expenses and Staff.
  Accountant → 200 on Payroll/Reports/Expenses, **404 on Hours and Staff**.
- **Arithmetic end to end:** an hourly owner at $22.00/h with 8h + 7.5h logged
  and a $100.00 payout reported 15.5h, 2 days, $341.00 earned, $100.00 paid,
  $241.00 balance; a salaried technician with **no timesheet rows at all**
  accrued the full $3,000.00. Totals $3,341.00 / $100.00 / $3,241.00, matching
  on the payroll report and in the Reports variance block.

---

## 7. Release 3 — Payment-method tax and hygiene (NOT STARTED)

Independent of Release 2. **This is the only release that touches live financial
write paths.** Treat it with more care than the other two.

### 7.1 The pricing rule (spec §2)

All listed prices are **tax-exclusive**. Tax is added for some payment methods
only:

| Payment method | Tax added |
|---|---|
| Cash | No |
| Interac (= `etransfer`) | No |
| Credit (= `card_terminal`, `stripe`) | Yes |
| Cheque | Yes |

Every package therefore has two customer-facing prices — Package #2 on a sedan is
**$175.00** cash/Interac, **$197.75** credit/cheque.

**Exact algorithm (spec §4.1)** — note the existing `computeInvoiceTotals` in
`src/lib/invoices.ts` already does the discount-before-tax half correctly:

```
gross    = package_price + addons_total + extra_charge
discount = round(gross × discount_pct, 2) + discount_flat
subtotal = max(0, gross − discount)
taxable  = payment_method.taxable
tax      = taxable ? round(subtotal × tax_rate, 2) : 0
total    = subtotal + tax
```

**Worked example to use as an acceptance test** — Sedan, Package #2 ($175),
Wax/Buff add-on ($120), 10% discount, paid Credit:

```
gross 295.00 → discount 29.50 → subtotal 265.50 → tax 34.52 → total 300.02
The same job paid Cash:                                        total 265.50
```

*(Release 1 already verified the 265.50 / 34.52 / 300.02 figures end to end
through the P&L, so the arithmetic side is known good.)*

### 7.2 Migration `drizzle/0008_tax_treatment.sql` — additive only

```
invoices  += tax_treatment          text NOT NULL DEFAULT 'added'   -- 'added' | 'none'
          += quoted_payment_method  text NULL
          += discount_reason        text NULL
customers += phone_normalized       text NULL   + NON-UNIQUE index, backfilled
```

- Existing invoices default to `'added'`, which is exactly what they were.
- A restatement then becomes `WHERE tax_treatment = 'none'` — a query, not a
  fragile match on a reason string.
- **The phone index must be non-unique.** Live data already contains duplicates
  (see 7.4), so a unique constraint would fail the migration against production.
  Backfilling contact data is fine; it is not money.

### 7.3 Code

- **`PAYMENT_METHOD_TAXABLE`** map in `src/lib/types.ts`:
  `cash: false, etransfer: false, cheque: true, card_terminal: true, stripe: true`.
- **A required "How will they pay?" selector on both invoice-creation paths** —
  `createManualInvoiceAction` (line ~896) and `createInvoiceFromJobAction`
  (line ~42) in `src/app/admin/(app)/invoices/actions.ts` — driving
  `tax_treatment`, `tax_rate_bp` and `tax_cents` through the existing
  `computeInvoiceTotals`.
- For a non-taxable method, **also set the existing `tax_exempt` +
  `tax_exempt_reason`**. `summarizeTax` and the invoice PDF already handle that
  pair correctly, so they need no change.
- **`recordPaymentAction`** (line ~460) must **block** a payment whose method's
  taxability contradicts the invoice's `tax_treatment`, with a message directing
  staff to cancel and re-issue (`cancelInvoiceAction` exists at line ~778). This
  is the owner's explicit decision.
- **Display both prices** (`$175 cash · $197.75 card`) on the booking wizard,
  service pages and invoice builder. Keep `priceBooking` quoting tax-added as the
  conservative default; the invoice remains the tax document.
- **Note in `DECISIONS.md`** that this deliberately breaks the
  appointment↔invoice reconciliation promised in §14 — an appointment will now
  snapshot tax that the eventual invoice may not charge.
- **Tax report footnote** (spec §4.5): *cash and Interac sales are recorded with
  no tax charged; confirm treatment with your accountant before filing.*

### 7.4 Phone normalization — staff-side only

`customers.phone` is raw text with **no dedup at all**: `createBooking`
(`src/lib/booking/create.ts`, ~line 173) inserts a new customer on **every**
public booking. Duplicates already exist in production.

- Normalize to digits only (`5551234567`), store in `phone_normalized`, display
  the formatted version.
- **Match on it in admin paths only.** Do **not** add it to `createBooking` — see
  §2 item 2.
- Ship the index non-unique. Deduplication and any unique constraint are a
  separate, later, owner-reviewed exercise.

### 7.5 Also in Release 3

- **`discount_reason`** — required when a discount > 0 in the staff builders.
- **"Needs attention" card on Home** (spec §5, soft rules): discount applied with
  no reason; job at ready-for-pickup never invoiced. Tappable, lists the affected
  records, clears as they are fixed.

---

## 8. Outstanding owner tasks

1. **Switch on the recurring bills.** Six bills are live but **inactive**, holding
   the tracker's sample amounts (Shop Rent $2,500, Business Insurance $350, Hydro
   $220, Electric $180, Natural Gas $120, Phone & Internet $145). The owner must
   open **Admin → Settings → Categories & bills**, check each against a real
   invoice, and turn it on. Until then the generator creates nothing — by design.
2. **Set every staff member's pay type and rate** in **Admin → Staff**. Release 2
   ships everyone as hourly at $0.00, which earns nothing, so payroll stays
   empty and correct until the real terms are entered. Do this **before** anyone
   logs hours — pay is frozen at save time, so days entered against a $0.00 rate
   stay at $0.00 and have to be re-entered.
3. **Package prices** were confirmed correct against the live site on 2026-08-18
   (#1 $200, #2 $175, #3 $150, #4 $70, #5 $50, #6 $30 sedan). No action.

---

## 9. How to develop and verify

### 9.1 `npm run dev` is broken — do not chase it

Every route 500s with `Module not found: Can't resolve 'fs'` from
`pg-connection-string`, pulled in via `src/instrumentation.ts`. **This is
pre-existing and unrelated to any change** — confirmed by stashing all work and
reproducing on a clean `main`. Verify against a production build instead:

```bash
npm run build && PORT=3100 npm run start
```

> A stale `next-server` from an earlier session can still be holding the port,
> in which case the new build silently never starts and every new route 404s
> against the *old* one. Check `npm run start`'s own log for `EADDRINUSE` before
> believing a 404, or just pick a fresh port.

### 9.2 Getting an authenticated admin session

Server-action login over curl does not work. Mint a session directly. The cookie
is `ptcd_session`; the stored value is the SHA-256 hex of the raw token.

```bash
TOKEN=$(openssl rand -hex 32)
HASH=$(printf '%s' "$TOKEN" | openssl dgst -sha256 -hex | awk '{print $NF}')
psql "postgres://localhost/ptcd_dev?host=/tmp" -c \
  "INSERT INTO staff_sessions (id, token_hash, staff_user_id, expires_at)
   SELECT 'ses_$(openssl rand -hex 10)', '$HASH', id, now() + interval '2 hours'
   FROM staff_users WHERE role='owner' LIMIT 1;"
curl -H "Cookie: ptcd_session=$TOKEN" http://localhost:3100/admin/expenses
```

To check permission gating, insert further `staff_users` rows with
`role='technician'` and `role='accountant'` and confirm the matrix in §6.5.

### 9.3 Local setup and the quality gate

```bash
cp .env.example .env.local     # already present; points at local ptcd_dev / ptcd_test
npm install
npm run db:migrate
npm run db:seed
```

```bash
TEST=1 npm run db:migrate       # tests refuse any database not named exactly ptcd_test
TEST=1 npm test                 # 320 passing as of Release 2
./node_modules/.bin/tsc --noEmit
npm run build
npm audit --omit=dev --audit-level=high    # the CI gate; 2 moderate postcss advisories
                                           # are pre-existing and need a Next major
git diff --check
```

Dev seed owner: `owner@ptcd.local` / `detailing-dev-2026` (non-production only).

### 9.4 Testing the cron

```bash
CRON=$(grep '^CRON_SECRET=' .env.local | cut -d= -f2-)
curl -s -X POST -H "Authorization: Bearer $CRON" http://localhost:3100/api/cron/tick
```

Run it **twice** and assert the second run is a no-op — that is how Release 1's
generator idempotency was verified in a real running build.

---

## 10. How to release

Work on a branch, open a PR, let CI pass, squash-merge to `main` (matches PRs
#9–#12), then:

```bash
gh workflow run "Azure release" -f operation=stage --ref main
# wait for success, then capture the restore point:
gh run view <RUN_ID> --log | grep "Pre-deploy restore point"
```

**Before swapping, verify all three:**

1. Staging is healthy — `https://app-ptcd-prod-7mutra-staging.azurewebsites.net/api/health`.
2. **Production is still healthy on the already-migrated database**, while it is
   still running the *old* build. This is the additive-migration guarantee being
   tested for real, and it is the check most worth doing. For `0007` this
   specifically means production keeps serving with four unknown columns on
   `staff_users`.
3. The public catalog is unchanged from a baseline captured before staging.

```bash
gh workflow run "Azure release" -f operation=swap --ref main
```

Then re-verify production pages, health, catalog, and that new admin routes
(`/admin/timesheets`, `/admin/reports/payroll`) return `307` (auth redirect)
rather than `404`.

Both operations require `main`. The workflow is `workflow_dispatch` only.

---

## 11. Rollout to the owners (spec §9)

Release 2 is built, so this can start once it is deployed and §8.2 is done.

1. **Parallel run for two weeks** — both sheet and CRM.
2. **Reconcile a full month end to end.**
3. **Acceptance test:** enter the same 20 jobs and 10 expenses in both systems.
   Net sales, total expenses, net profit, tax owing and payroll balance must
   match **to the cent**.

Expect exactly two divergences, and confirm each is the CRM being right:

- **The sheet's tip field.** `Daily Jobs!AA` folds tips into "Net Sales",
  inflating revenue, average-per-car and margin. The CRM has no tip field
  anywhere and never will.
- **The sheet's monthly-salary accrual bug** (§6.2). A month where a salaried
  person logged no hours will show $0 in the sheet and the full salary in the
  CRM. The CRM is right.

Training assets the spec asks for: a one-page cheat sheet for the shop wall (add
a job · print a receipt · where this month's profit is · logging hours), and a
3-minute screen recording for whoever does entry when the owner is away.

---

## 12. Start here

1. Read `DECISIONS.md` §15–§17, then `src/lib/books.ts` and `src/lib/payroll.ts`
   with their tests — they are the template for Release 3's shape.
2. **Deploy Release 2 first** (§10) unless the owner wants counter pricing
   pulled forward; the two releases are independent.
3. Build Release 3 per §7, keeping migration `0008` additive-only (§3.1), and
   remember it is the only release that touches live financial write paths.
4. Release per §10, verifying production on the migrated database *before* the
   swap.
