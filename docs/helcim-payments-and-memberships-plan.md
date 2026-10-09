# Helcim payments, memberships and the winter offer — build plan

Drafted 2026-10-08 from the owner's answers and the final winter flyer
(`FINAL FLYER (1).pdf`, 2026-10-06).

**Status, 2026-10-08:** everything below is built on the branch
`helcim-payments-memberships`, except the two items listed under "Not yet
verified". The decisions behind it are DECISIONS.md #42. Billing runs from our
own cron, as recommended below. The owner confirmed the discount rule: Club 15%,
Complete 20%, on packages #1–#3 plus add-ons booked with them, best single
offer wins. A Winter Pass bought late still expires March 31.

### Not yet verified

1. **A real card payment through HelcimPay.js.** Helcim's form does not render
   on localhost. Everything up to it was exercised against the developer
   account on 2026-10-08:
   - customer creation;
   - checkout initialization with our reference and `setAsDefaultPaymentMethod`;
   - the iframe opening.

   The rest needs the site on a public https origin (a tunnel, or staging):
   - card entry;
   - Helcim's SUCCESS message shape;
   - whether the saved card's token can be charged for a renewal;
   - a refund.
2. **The Smart Terminal.** It needs the device in API mode; the developer
   account has no device.

## What we are building

1. **Online card payments through Helcim, on our own pages.** Card entry runs
   in Helcim's embedded checkout (HelcimPay.js), so card numbers never touch
   our server. It covers:
   - paying an invoice;
   - paying an appointment deposit;
   - optionally prepaying a whole appointment.
2. **Fleet workspace link.** One link per fleet account, with no login. It
   shows pending and paid invoices. The customer ticks the ones they want and
   pays them in one transaction, or tells us they will pay by cheque or in
   person.
3. **Smart Terminal.** A "Collect on terminal" button in admin pushes the exact
   amount to the Helcim Smart Terminal, and the payment records itself when the
   customer taps.
4. **Memberships.** Winter Shield Club ($49/mo) and Winter Shield Complete
   ($69/mo), charged automatically to the customer's card. One car per
   membership.
5. **Winter Pass.** $99 prepaid for 4 hand washes, tied to one car, sold online
   and at the counter.
6. **Customer account** at `/account`: plan, washes left, visit history,
   invoices, update card, upgrade, cancel.
7. **`/winter` page** (the flyer's QR code target), for buying the pass and the
   plans.
8. **Catalogue additions:**
   - winter tire swap, from $49.99;
   - winter glass protection add-on, $14.99.

   PPF (from $1,199) and dash cams (from $99) stay pending.
9. **Remove Stripe completely.**

Memberships and the Winter Pass go on sale only once Helcim payments are live.
A "sales open" switch in Membership settings gates them.

## Owner decisions this plan follows

| Topic | Decision |
|---|---|
| Prices | Before tax. HST is added at checkout (card is taxable under DECISIONS #18). Club $55.37/mo, Complete $77.97/mo, Winter Pass $111.87 by card. |
| Vehicle size | $49 flat for every vehicle size. Prices are editable in admin. |
| Settings | Membership settings get their own admin page, not part of Admin → Settings. |
| Car per membership | One. |
| Season end | Billing does not stop. Members are moved to the next plan (e.g. a summer plan) with advance notice. No minimum commitment, but this is not stated on the site. |
| Premium hand wash | Our hand wash: catalogue `basic-car-wash`, with the winter extras (wheel wells, underbody salt rinse, glass spray) listed as included. |
| Discount scope | Detailing packages #1–#3 (`complete-detail-engine`, `the-works`, `interior-detail`) and add-ons. Not ceramic coatings, PPF, tint or dash cams. See the open question at the end. |
| Priority booking | Members can book further ahead. Nothing else changes. |
| Upgrade | Takes effect now. The $20 difference (+HST) is charged immediately and the new price applies from the next billing date. |
| Cancel | Effective at the end of the paid month, no refunds. The policy pages are updated to say so. |
| Winter Pass | Tied to one vehicle, sold online at `/winter`, valid November through March. |
| Dash cam, PPF | Pending: no bookable product yet. |
| Stripe | Not used. Remove it. |
| Helcim | Live account and developer (test) account both exist. |

## Billing approach: we charge the saved card ourselves

The 2026-09-30 sketch had Helcim's Recurring API running the monthly billing.
The owner's answers change that. I now recommend that **our app runs the
billing**: it charges the card saved in Helcim's vault through Helcim's Payment
API, from the hourly cron job.

Why:

- **Every charge has to become a paid invoice with HST in our books.** If we
  raise the invoice first and then charge it, the invoice always exists. With
  Helcim Recurring we would have to discover each charge afterwards, and
  Helcim's docs don't say whether a renewal fires a webhook.
- **Upgrades charge the difference immediately, and season changes move
  everyone to a new plan.** Both are plain database updates on our side.
  Helcim's docs don't say whether a subscription's plan can be changed through
  the API.
- **One source of truth for HST.** The tax is computed by our existing rules,
  not by a separate tax setting on a Helcim payment plan.

What this costs us:

- **We build the retries ourselves.** Defaults: 3, 5 and 7 days after a failed
  charge, editable. The customer gets a text and email with an "update card"
  link.
- **We send the card-expiry reminder ourselves.**
- **Billing depends on the cron job running.** The scheduler failed every run
  from 2026-08-21 to 2026-09-16, so this needs guards:
  - billing is idempotent and catches up on the next successful run;
  - the Memberships page shows "last billing run";
  - staff get an alert when billing hasn't run for 3 hours.

**Double-charge guard.** Helcim forgets idempotency keys after 5 minutes. So
every charge carries a unique reference of ours (Helcim's `invoiceNumber`),
and before any retry we look that reference up in Helcim's transaction list.
A retry never runs on a guess.

## Helcim pieces we use

| Need | Helcim API | Notes |
|---|---|---|
| Card entry on our pages | HelcimPay.js: `POST /v2/helcim-pay/initialize` (server) → `appendHelcimPayIframe(checkoutToken)` (browser) | `paymentType` `purchase` for payments; `verify` to save a card only (sign-up, update card) with `setAsDefaultPaymentMethod`. The checkout token lasts 60 minutes. |
| Trusting the result | The browser receives `SUCCESS` plus data with a `hash`. The server checks `sha256(JSON + secretToken)`, then fetches the transaction from Helcim by ID and checks amount, currency and our reference. | We never mark anything paid on the browser's word alone. |
| Saved card for monthly billing | Customer record (`customerCode`) + `cardToken`, charged with a Payment API `purchase` | `idempotency-key` header (25 characters, remembered for 5 minutes). |
| Smart Terminal | `POST /v2/devices/{deviceCode}/payment/purchase` → 202 Accepted. The result arrives by webhook. | A second request to a busy terminal is dropped, and a powered-off terminal returns 409. Accepts debit and credit. |
| Webhooks | `cardTransaction` (carries only the transaction ID, so we always fetch the transaction) and `terminalCancel`. HMAC-SHA256 over `id.timestamp.body` with the verifier token. Retried for up to 10 hours. | **The webhook URL cannot contain the word "helcim"**, so the route is `/api/webhooks/card-payments`. |
| Refunds | Payment API refund (and reverse, for a batch that hasn't settled yet) | Replaces the Stripe refund paths. |

### To confirm on the Helcim developer account before going live

1. Does `cardTransaction` fire for HelcimPay.js payments and for saved-card
   purchases, or only for the terminal? Each payment flow is designed to work
   without it: the browser result plus hourly reconciliation by reference.
2. What happens when `invoiceNumber` is passed to HelcimPay.js? Does it create
   a Helcim invoice, and is that harmless?
3. How does the Smart Terminal behave in API mode? Does it prompt for a tip,
   and does it still work standalone?
4. Refund vs reverse: which is needed for a same-day refund?
5. The exact script, iframe and API hosts to add to the Content-Security-Policy
   in `next.config.ts` (`secure.helcim.app`, `api.helcim.com`, to verify).

**Testing caution.** The staging slot shares the production database, and the
Helcim credentials live in that database. Staging therefore always runs on the
**live** Helcim account. Do the development testing locally against the Helcim
developer account. On staging, test with one real card payment and refund it.

## Data model

Every change is additive: new tables, plus new nullable or defaulted columns.

- **`payment_checkouts`**: one row per HelcimPay.js session, terminal request
  or saved-card charge.
  - Columns: `kind` (invoices | appointment_deposit | appointment_prepay |
    winter_pass | membership_signup | membership_charge | membership_upgrade |
    card_update | terminal), `channel` (online | terminal | card_on_file),
    `customer_id`, `amount_cents`, `reference` (unique, sent to Helcim as
    `invoiceNumber`), `status` (open | succeeded | failed | expired),
    `helcim_transaction_id` (unique), the secret token encrypted (it expires in
    60 minutes), `device_code`, the raw transaction, and timestamps.
  - One checkout can pay several invoices: one `payments` row per invoice,
    linked by **`payments.checkout_id`** (a new nullable column), with
    `provider` set to `helcim` or `helcim_terminal`.
- **`customers.helcim_customer_code`**: nullable, unique when set.
- **`invoices.customer_pay_intent`** (`cheque` | `in_person`) plus
  **`customer_pay_intent_at`**: the fleet "we'll pay by cheque" answer. It
  changes no status.
- **`membership_plans`**: `slug`, owner-editable `name`, `monthly_price_cents`,
  `discount_bp`, `included_service_slugs` (wash; wash plus interior), `active`,
  `sort`. Plans are data, so a summer plan is a new row and not new code.
- **`memberships`**:
  - Columns: `customer_id`, `vehicle_id`, `plan_id`, `status` (pending |
    active | past_due | canceling | canceled), price and discount snapshot,
    `card_token`, card brand/last 4/expiry for display,
    `current_period_start`, `current_period_end` (the next billing date),
    `cancel_at_period_end`, retry count and next retry date, `next_plan_id` and
    `next_plan_from` (for season changes), `terms_version`, `consent_at`.
  - A partial unique index allows only **one live membership per vehicle**.
- **`membership_periods`**: one row per billed month, unique on
  (membership, period start). Holds the invoice ID and a status (due | paid |
  failed | waived). The unique index is what makes billing idempotent.
- **`membership_redemptions`**: unique on (period, benefit). The database
  enforces "1 wash a month, no rollover". It links to the appointment or
  invoice where the benefit was used.
- **`winter_passes`**: customer, vehicle, sale invoice, `washes_total` (4),
  `valid_from`, `valid_until`, status, terms version.
  **`winter_pass_redemptions`**: unique on (pass, wash number).
- **`customer_login_codes`** and **`customer_sessions`**: account sign-in, set
  up like `staff_sessions`. Only hashes are stored.
- **Settings:**
  - a `memberships` key in `business_settings`: sales switch, pass season
    dates, extra booking days for members, retry schedule, discount-eligible
    service slugs, notice days for plan changes;
  - Helcim credentials in `integration_credentials`: API token, webhook
    verifier token, terminal device code(s).

## How the money flows

- **Invoices stay the tax document**:
  - every monthly charge creates an invoice (one line, "Winter Shield Club —
    Nov 8 to Dec 7", with HST), and the charge is recorded against it;
  - a Winter Pass sale is an invoice line, and the pass is issued when that
    invoice is paid in full. A pass sold over the counter for cash therefore
    follows DECISIONS #18 like any other sale, with no HST;
  - an upgrade is a one-line invoice for the difference.
- **Using a benefit costs $0.** The visit's invoice gets the wash line, then a
  matching "Included in Winter Shield Club" discount, and the redemption row is
  written. Revenue was recognised when the month was billed.
- **Member discounts are one more candidate in the existing best-offer logic**
  (`bestOfAllocations` in `src/lib/pricing`). They apply only to the eligible
  slugs, and the best single offer wins, as everywhere else in the app.
- **Online card is taxable.** The existing guard that refuses online payment of
  a cash-priced invoice stays in place. On the fleet workspace those invoices
  can't be ticked for card payment.

## Work packages

Everything can be built together. The payment pieces can go live before
memberships go on sale.

### A. Helcim foundation and Stripe removal
- `src/lib/payments`:
  - replace `StripeProvider` with a Helcim client (initialize, fetch
    transaction, purchase with card token, refund/reverse, terminal purchase,
    webhook verification);
  - keep a fake provider for local development and tests.
- Credentials: a Helcim section in Admin → Integrations (encrypted, rotatable
  without a deploy).
- `/api/webhooks/card-payments`: verifies the signature, ignores repeats via
  `webhook_events`, fetches the transaction, then finalises.
- Cron: reconcile any open checkout older than 15 minutes by looking up its
  reference in Helcim.
- Refund panels (invoice and deposit) use Helcim refunds.
- Delete the Stripe webhook route, the `stripe` package and the `STRIPE_*`
  environment variables. Keep the "Card (Stripe)" label so any historical rows
  still display. Generalise `getRefundAvailability` away from
  `provider === "stripe"`.
- CSP additions for the Helcim script and iframe.

### B. Online payments
- `/portal/invoices/[token]` and `/portal/deposits/[token]`: a pay button opens
  the Helcim checkout in the page, with a "Card details go straight to Helcim
  and never touch our servers" note.
- **Prepay:** the booking confirmation and the confirmation message offer an
  optional "Pay now". It is recorded as a deposit-kind payment for the full
  total and applied to the invoice through the existing `deposit_applied_cents`
  path.
- Receipts reuse `sendInvoiceReceipt` and the deposit confirmation.

### C. Fleet workspace
- `sendInvoiceAction`: for business customers, the message links to the
  account workspace (`/portal/[token]`) instead of a single invoice.
- **Token behaviour changes.** `createCustomerPortalToken` revokes earlier
  links today, which would break the link in last month's email. Fleet sends
  instead issue a fresh 180-day token and leave earlier ones alive. The fleet
  page gets a "revoke all links" action.
- The workspace shows:
  - outstanding and paid invoices, each viewable as a PDF;
  - checkboxes and a running total, then "Pay selected by card", which is one
    Helcim payment split across the invoices;
  - or "We'll pay by cheque / in person", which records the answer on each
    invoice and notifies staff. Invoices stay unpaid until staff record the
    payment.

### D. Smart Terminal
- Invoice page → "Collect on terminal":
  - creates a terminal checkout for the balance and sends it to the device;
  - shows a waiting screen that polls until it succeeds, is cancelled or
    times out;
  - offers "Retry" and "Record manually" as fallbacks.
- The webhook finalises the payment. A cancel on the device marks it failed.
- If the terminal returns more than was requested (a tip prompt), the extra is
  recorded as the invoice's tip, so it stays outside the tax base (DECISIONS
  #39).
- The existing manual "Card terminal" method stays as a fallback.

### E. Memberships and Winter Pass
- **Sign-up** (on `/winter` or in the account):
  1. pick a plan and the car;
  2. sign in or create an account;
  3. accept the terms and the recurring-charge authorisation;
  4. pay the first month in the Helcim checkout. This also saves the card as
     the default.

  The membership becomes active, period 1 is created and paid, and the first
  wash can be booked immediately. Monthly billing then runs on the sign-up
  date.
- **Billing engine** (cron): for each period that falls due, raise the
  invoice, charge the card with a unique reference, then record the payment.
  - On failure: `past_due`, benefits paused, customer notified, retry on the
    3/5/7-day schedule.
  - After the last retry: canceled, with staff notified.
- **Upgrade:** charge the difference now, then switch the plan. The Complete
  benefit (interior clean) is available for the current month.
- **Cancel:** sets `cancel_at_period_end`. Benefits run to the end of the paid
  month, then the membership is canceled. No refund.
- **Season change:** admin picks "move Winter Club members to Plan X from
  date". Members get a notice N days before, and the switch happens on their
  next billing date.
- **Redemption:**
  - The member books from the account. A "member wash" is priced at $0 and
    uses the extended booking window (priority booking).
  - At the counter, the appointment and invoice pages show the car's
    membership and what's left this month. Staff can apply it, and the unique
    index refuses a second wash in the same month.
- **Winter Pass:** the same pattern. Online sale or counter sale (counter sales
  go through an invoice), 4 numbered redemptions, and the free underbody salt
  flush noted on each wash line. Staff confirm the plate at first use, as with
  wash codes.

### F. Customer account and `/winter`
- **`/account` sign-in:** a 6-digit code sent by email or text (codes expire
  after 10 minutes and are rate-limited). Nothing is shown before the code is
  entered, which keeps DECISIONS #14's rule.
  - One verified contact can match several customer records (the CRM has
    duplicates). Show all records that share that verified email or phone.
  - SMS delivery depends on the owner's pending 10DLC registration; email
    codes work regardless.
- **`/account` dashboard:** plan and status, this month's wash/interior used or
  available, Winter Pass washes left, booking, visit history, invoices (pay
  online), update card, upgrade, cancel.
- **`/winter`:**
  - The flyer's front: Winter Pass, Club and Complete, with buy buttons once
    sales are open and "Coming soon" before that.
  - The flyer's back: interior detailing from $99, ceramic protection from
    $149, tire swap from $49.99 and glass protection $14.99 link to booking.
    PPF from $1,199 and dash cams from $99 say "Call to book" until they are
    products.
- **Policies:**
  - terms gain a Memberships section (recurring charge, cancel at the end of
    the paid month, no refunds, plan changes with notice);
  - the cancellation page links to it;
  - privacy names Helcim as the processor.
- **First-wash page:** remove the "No membership" claim from
  `src/app/(landing)/offers/first-wash/page.tsx`.

### G. Admin
- **Clients & money → Memberships**, with tabs:
  - members: status, car, plan, next billing, past-due queue;
  - Winter Passes;
  - billing health (last run, failures).
- **Member detail:** charges, redemptions, cancel, give a free month (a waived
  period), retry charge now, send update-card link.
- **Memberships → Settings** (its own page): plans (name, price, discount,
  what's included, active), Winter Pass (price, washes, valid dates), eligible
  discount services, extra booking days for members, retry schedule, notice
  days, sales open/closed.
- New permission `manage_memberships` (owner, manager). Reception can apply a
  redemption.

### H. Catalogue (can go now)
- New service `winter-tire-swap`: $49.99, vehicle-size deltas editable in
  Admin → Services. It can be booked on its own or alongside a package.
- New add-on `winter-glass-protection`: $14.99, linked to the wash and the
  detailing packages.
- Added by slug, additive only. No names are overwritten (see memory:
  catalogue names live in the DB).

## Tests (vitest, node-only)

- Hash validation (a known vector) and webhook signature verification.
- Splitting one checkout across invoices, and the cash-priced-invoice refusal
  online.
- Billing state machine:
  - idempotent period creation;
  - a lost response followed by a retry never double-charges;
  - retry schedule, then cancel;
  - cancel at period end;
  - upgrade charges the difference;
  - season change.
- Redemption caps: the second wash in a month is refused at the database
  level, and a pass is refused after 4 washes or after its end date.
- Member discount: only eligible slugs, best single offer wins, never on
  coatings or PPF.
- Terminal: success, cancel, tip surplus recorded as a tip.

## Owner setup (before going live)

1. In Helcim, create an API token with the needed permissions, for the live
   account and for the developer account. Enter the live token in Admin →
   Integrations.
2. In Helcim, add the webhook `https://www.personaltouchcardetailing.ca/api/webhooks/card-payments`
   for card transaction and terminal cancel events, and copy the verifier token
   into Integrations.
3. Turn on Smart Terminal API mode and note the device code.
4. Remove the Stripe environment variables and webhook from Azure and Stripe.
5. Approve the new policy wording.
6. Open sales in Memberships → Settings.
