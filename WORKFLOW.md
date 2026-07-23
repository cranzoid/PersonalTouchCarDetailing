# WORKFLOW.md — Project State & Handoff

Last updated: 2026-07-23

Read `BUILD.md` first for the product specification. This document is the
authoritative state of the repository and replaces the older session-by-session
handoff.

## Current state

All seven implementation phases in `BUILD.md` are complete. The repository was
continued from a Phase 5 handoff, then Phase 6, Phase 7, the cross-cutting audit
findings, and the public/admin brand redesign were completed.

The implementation now covers the full customer journey:

```text
lead / quote / direct booking
  -> customer + vehicle
  -> estimate and approval when needed
  -> staffed appointment and deposit
  -> check-in, inspection, work approval, job, and QC
  -> individual or consolidated invoice
  -> online/manual payment, receipt, and refund
  -> portal history, review request, and maintenance reminder
```

There is no unfinished application phase in the agreed scope. The remaining
items are production configuration, real-provider acceptance tests, content or
legal approval, and deployment authorization; these require owner credentials
or decisions and are listed below.

## Final verification

Verified on 2026-07-23 against the dedicated local `ptcd_test` and seeded
`ptcd_dev` PostgreSQL databases:

- `npm test`: **135/135 tests passed** across 18 files.
- `./node_modules/.bin/tsc --noEmit`: passed.
- `npm run build`: passed with Next.js 15.5.20; all application routes built.
- `npm audit --offline --audit-level=moderate`: 0 known vulnerabilities in the
  installed/offline advisory data.
- `git diff --check`: passed.
- Source sweep found no deferred implementation markers or page-level legacy
  auth-gate remnants.
- Runtime smoke test: all public pages, legal pages, login, metadata routes,
  service details, and brand image assets returned 200; invalid portal and
  gallery resources returned 404; unauthenticated cron returned 401; and
  unauthenticated `/admin` returned a clean 307 to `/admin/login` without an
  auth exception.
- Security-header smoke test confirmed CSP, `nosniff`, frame denial, COOP,
  permissions policy, portal/admin no-index rules, private portal caching, and
  no `X-Powered-By` response header.

The local Chrome bridge had no available browser session, so screenshot-based
responsive/cross-browser QA could not be performed. The frontend was validated
through compilation, build output, route rendering, semantic/accessibility code
review, and HTTP smoke tests.

## Completed implementation

### Phase 1 — foundation, public intake, and booking

- Next.js App Router application, PostgreSQL/Drizzle schema, migrations, seed,
  staff sessions/RBAC, audit log, settings, and service catalog.
- Public service discovery, booking wizard, quote request, contact form,
  attribution capture, policy pages, and supporting marketing routes.
- Server-authoritative pricing and duration calculation; untrusted client totals
  are never accepted.
- Transactional availability and booking with resource locking and overlap
  revalidation.
- Durable PostgreSQL rate limiting for public mutation and checkout paths.

### Phase 2 — estimates and approvals

- Staff estimate builder, line-item pricing, issue/send/view lifecycle, and
  tokened customer approve/decline/change-request flow.
- Approval identity and request context are recorded; stale or cross-customer
  tokens fail closed.
- Approved estimates convert atomically into appointments using the same current
  availability, resource, skill, and staffing rules as direct booking.

### Phase 3 — job pipeline

- Appointment arrival/check-in, mobile-oriented inspection, findings, private
  file uploads, additional-work approval, job state machine, timers, notes,
  QC checklist, ready-for-pickup, and completion.
- Photos remain private unless explicit public gallery consent is recorded.
- S3-compatible SigV4 object storage is implemented for production; local disk
  is development-only and storage keys reject traversal.

### Phase 4 — invoices, deposits, payments, and refunds

- Individual and consolidated invoices, immutable financial history, sequential
  numbers, tax snapshots, PDF rendering, due dates, overdue automation, manual
  payment recording, receipts, cancellations, and refunds.
- Appointment deposit links use hashed, purpose-bound, expiring tokens. Deposit
  amount, payment ledger, appointment balance, and confirmation move atomically
  and idempotently.
- Stripe Checkout sessions embed and validate payment, subject, amount, and
  currency metadata. Signed webhook delivery is idempotent.
- Checkout retry handling is provider-authenticated: open sessions resume,
  delayed paid sessions finalize once, processing/ambiguous sessions remain
  reserved, and a replacement is allowed only after Stripe confirms expiry.
  Concurrent retries share one payment reservation and Stripe idempotency key.
- Stripe refunds reserve the ledger first, call the provider outside database
  locks, and are finalized from authenticated provider results/webhooks. Manual
  and provider refund capacity is tracked separately.
- Fake checkout is available only in development and is refused in production.

### Phase 5 — communications and automation

- Database-backed email/SMS templates with owner/manager editing and channel
  validation.
- Resend email and Twilio SMS adapters are implemented. Development has an
  explicit log transport; production never reports an unconfigured delivery as
  success.
- Booking confirmations, estimate/work approvals, invoices, receipts, deposit
  confirmations, appointment reminders, review requests, and maintenance
  reminders use recorded delivery outcomes.
- Marketing messages enforce consent; operational messages remain available.
- `/api/cron/tick` uses bearer authentication, a PostgreSQL advisory lock, and
  idempotent sent-at markers. `vercel.json` schedules it hourly.

### Phase 6 — reporting and attribution

- Admin reports cover cash-basis revenue, conversion funnel, appointment/bay
  utilization, and source-to-revenue attribution.
- Reporting calculations have dedicated unit tests and do not treat unpaid
  invoice face value as collected revenue.

### Phase 7 — customer portal and fleet

- Hashed, revocable, expiring portal links provide customer-scoped access to
  vehicles, appointments, estimates, work approvals/history, invoices, PDFs,
  and deposits without requiring an account.
- Business/fleet customer records, vehicle management, per-fleet history, and
  consolidated multi-job invoicing are available to staff.
- All portal subject/customer relationships are verified server-side.

### Cross-cutting CRM and scheduling audit

- Staff management is owner-only: create/update/deactivate, role and skill
  management, password reset, session revocation, and last-active-owner guards.
- Lead CRM includes assignment, notes, status changes, quote linkage, consent,
  attribution, and atomic conversion without duplicate customers.
- Customer records support correction and audited anonymization while preserving
  required financial history.
- Staff weekly shifts and normalized skills are editable by owners. Managers and
  owners can manage whole-business closures, bay maintenance, and staff time off.
- Availability unions all selected services' required skills, requires complete
  shift coverage, accounts for staff/resource conflicts and time off, and assigns
  both resource and staff inside deterministic locks during create/reschedule.
- Compatibility rule: an installation with zero `staff_schedules` rows uses
  bay-only availability. As soon as schedules exist, staffing is authoritative.
- Manual staff bookings, public bookings, approved-estimate conversions, and
  rescheduling share the same scheduling invariants.

## Brand and frontend redesign

The public site and admin workspace now share a deliberate design system based
on the owner-provided palette:

- deep navy `#0B2A4A` for primary surfaces and structure;
- gold `#E0A93B` as a restrained accent;
- charcoal `#1C2026` for text;
- cool off-white `#F4F6FA` for supporting surfaces.

The redesign includes responsive public navigation/footer, a new premium home
page and hero, service and informational pages, booking/quote/contact forms,
portal screens, legal pages, admin shell/navigation, admin login, consistent
cards/buttons/status treatments, visible focus states, reduced-motion support,
44px interactive targets, labels, captions, empty states, and mobile table/form
handling.

SEO/application assets now include page metadata, Open Graph image, application
icon, web manifest, robots rules, sitemap, and a branded not-found page. The
generated hero is stored at `public/images/detailing-studio-hero.png`; its
Open Graph crop is `public/og.png`.

## Database and migrations

Repository migrations, in order:

1. `drizzle/0000_flaky_freak.sql` — base platform schema.
2. `drizzle/0001_clammy_mole_man.sql` — automation sent-at timestamps.
3. `drizzle/0002_absurd_monster_badoon.sql` — consolidated invoice/job links,
   durable rate-limit buckets, and lead marketing consent.

All three have been applied locally to `ptcd_dev` and `ptcd_test`. Tests refuse
to run destructive setup unless the URL database name is exactly `ptcd_test`.

## Production launch checklist

These are external acceptance/configuration tasks, not missing application
features:

1. Choose the production Node host and managed PostgreSQL service. Deployment
   has not been performed because `BUILD.md` requires an explicit owner decision
   about cost and credentials.
2. Configure `DATABASE_URL`, a strong `SESSION_SECRET`, HTTPS `APP_BASE_URL`, and
   production-only `SEED_ADMIN_NAME`, `SEED_ADMIN_EMAIL`, and
   `SEED_ADMIN_PASSWORD`; run migrations, then the idempotent seed.
3. Configure Stripe keys and the `/api/webhooks/stripe` endpoint, then exercise
   invoice checkout, appointment deposit, delayed webhook reconciliation, and a
   real Stripe test-mode refund. These paths are code- and test-verified but were
   not called against the owner's Stripe account.
4. Configure Resend/`EMAIL_FROM` and Twilio, then verify real email/SMS delivery
   and sender-domain/number status. No provider credentials were available in
   this session.
5. Configure and test the S3-compatible private bucket. Production intentionally
   refuses local-disk customer uploads.
6. Configure `CRON_SECRET` and verify the host scheduler calls
   `POST /api/cron/tick` with `Authorization: Bearer ...`.
7. Have the owner/counsel approve privacy, terms, cancellation, and the public
   location-history wording. Confirm the HST registration number, estimated
   service durations, reminder/review/maintenance cadence defaults, and any
   service-specific deposit settings.
8. Populate gallery/review content only from real customer material with the
   required consent. Run responsive visual QA in current Safari, Chrome, and
   mobile devices once a browser session is available.

## Local operation

```bash
cp .env.example .env.local
npm install
npm run db:migrate
npm run db:seed
npm run dev
```

Quality gate:

```bash
npm test
./node_modules/.bin/tsc --noEmit
npm run build
npm audit --offline --audit-level=moderate
```

The development seed creates `owner@ptcd.local` with password
`detailing-dev-2026` only when no staff exists and `NODE_ENV` is not production.
Production seeding refuses those defaults.

## Repository handoff note

The completion work is present in the working tree and has not been committed,
pushed, or deployed. Preserve the current changes when creating the release
commit. The exact next action is production configuration and external-provider
acceptance testing, followed by deployment only after the owner supplies the
required authorization and credentials.
