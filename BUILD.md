# BUILD.md — Personal Touch Car Detailing Platform

This document is the primary product and implementation specification for the
Personal Touch Car Detailing website and business-management platform. It is
written so that any future developer or AI model can continue the project
without access to earlier conversations. Read `WORKFLOW.md` next for the
repository's *current* state and the exact next action.

---

## 1. Product overview

Personal Touch Car Detailing is a car detailing business in Hamilton, Ontario,
Canada, recently under **new ownership**. This platform is both the public
marketing website and the central operating system for the business.

The intended operational journey:

```
Website visitor
  → lead or booking
  → customer + vehicle record
  → estimate (where required)
  → appointment
  → vehicle check-in and inspection
  → active job
  → quality control
  → invoice
  → payment
  → review request, maintenance reminder, repeat booking
```

### New-ownership content rule (IMPORTANT)

The business has recently changed ownership. **Never publish or hard-code
unconfirmed historical claims**: years in business, prior staff, prior
warranties, prior guarantees, prior pricing or membership commitments.
Anything of that nature must come from the `business_settings` table (staff
configurable) or be recorded in `WORKFLOW.md` under "Business questions
requiring confirmation". Placeholder copy in the public site must be neutral
("locally owned and operated in Hamilton") — not invented history.

---

## 2. Technology stack (decided)

| Concern | Choice | Rationale |
|---|---|---|
| Framework | Next.js 15 (App Router) + React 19 + TypeScript | One deployable app hosts the public site, admin, customer access, and API route handlers. Server components + server actions minimize API boilerplate while still allowing explicit REST-ish route handlers for webhooks and tokened customer links. |
| Database | PostgreSQL (dev: local Postgres 14 via unix socket `/tmp`; prod: any managed Postgres ≥14) | Real transactional guarantees for double-booking protection, financial integrity, and audit history. |
| ORM / migrations | Drizzle ORM + drizzle-kit SQL migrations (`src/db/`, `drizzle/` migrations dir) | Typed schema colocated with code; plain-SQL migration files reviewable in PRs. |
| Styling | Tailwind CSS v4 | Fast, consistent, no runtime CSS. |
| Validation | Zod at every untrusted boundary (forms, route handlers, webhooks) | |
| Auth (staff) | Database-backed sessions: random 256-bit token in httpOnly/secure/SameSite=Lax cookie → `staff_sessions` table; passwords hashed with bcryptjs (cost 12) | Revocable, auditable, no external dependency. |
| Auth (customers) | No accounts required. Secure single-purpose token links (estimate approval, invoice payment, portal access) stored hashed in `access_tokens` with purpose, expiry, and usage audit. A future password-based portal can layer on top. |
| Payments | Provider abstraction in `src/lib/payments/` shaped around Stripe Checkout. Development can use a `FakePaymentProvider`; production refuses fake checkout and requires Stripe configuration. **No live keys in repo.** Webhook routes verify signatures before trusting events. |
| Email/SMS | Provider abstraction in `src/lib/messaging/` (development transport records delivery attempts in `communications`; production uses Resend/Twilio and records missing configuration as failure rather than simulated success). |
| Tests | Vitest. Unit tests for pricing/availability/state machines; DB integration tests against `ptcd_test` database (each test file runs in a transaction-per-test or truncates). |
| IDs | Prefixed random IDs (`cus_…`, `veh_…`, `apt_…`, `job_…`, `est_…`, `inv_…`) generated in `src/lib/id.ts`. Human-scannable in logs and URLs. |
| Money | Integer **cents** everywhere (`_cents` column suffix). Tax rates in basis points (13% HST = 1300). Never floats. |
| Time | UTC timestamps in DB (`timestamptz`); business timezone `America/Toronto` from settings; all availability math is done in business-local time then stored UTC. |

### Environment

- `DATABASE_URL` — e.g. `postgres://cranzoid@/ptcd_dev?host=/tmp` (dev). Secrets live in `.env.local` (gitignored); `.env.example` documents every variable.
- `SESSION_SECRET` — HMAC key for cookie signing.
- Dev DBs already created locally: `ptcd_dev`, `ptcd_test`.

### Commands

```bash
npm run dev            # start dev server
npm run build          # production build
npm run db:generate    # drizzle-kit generate migrations from schema changes
npm run db:migrate     # apply migrations
npm run db:seed        # seed service catalog + demo staff
npm test               # vitest
```

---

## 3. Repository structure

```
src/
  app/
    (public)/            # public marketing site + booking + quote
      page.tsx           # Home
      services/          # overview + [slug] detail pages
      book/              # booking flow
      quote/             # quote request flow
      gallery/ about/ reviews/ faq/ contact/ fleet/
      policies/          # privacy, cancellation, terms
    (public)/portal/     # customer tokened access (estimates, invoices, deposits, work)
    admin/               # staff app (session-gated layout + per-action server checks)
      login/
      (app)/             # dashboard, appointments, leads/quotes, customers, services,
                         # estimates, jobs, invoices, fleet, reports, communications,
                         # staff, schedules, and settings
    api/                 # route handlers: webhooks, uploads, availability
  db/
    schema.ts            # Drizzle schema (single source of truth)
    index.ts             # connection
    seed.ts
  lib/
    auth/                # sessions, password hashing, permissions
    booking/             # availability engine, slot locking
    pricing/             # price/duration computation (vehicle-size adjustments, add-ons, tax)
    estimates.ts invoices.ts jobs.ts reporting.ts scheduling.ts
                         # domain state machines, reporting, and automation
    payments/ messaging/ # provider abstractions
    audit.ts  id.ts  money.ts  settings.ts
  components/            # shared UI
drizzle/                 # generated SQL migrations (committed)
tests/                   # vitest unit + db integration tests
BUILD.md  WORKFLOW.md  DECISIONS.md
```

---

## 4. Domain model (database schema)

All tables have `id` (text, prefixed), `created_at`, `updated_at`. Soft-delete
(`deleted_at`) only where noted; financial records are **never** deleted.

### Identity & access
- **staff_users** — name, email (unique), password_hash, role (`owner|manager|reception|technician|accountant`), active, skills (text[]).
- **staff_sessions** — token_hash, staff_user_id, expires_at, ip, user_agent.
- **access_tokens** — customer-facing tokened links: token_hash, purpose (`estimate_view|invoice_pay|portal|approval`), subject id, customer_id, expires_at, used_at, revoked_at.
- **audit_log** — actor (staff id / customer token / system), action, entity_type, entity_id, before/after JSON, reason, ip, created_at. Written for all sensitive mutations (role changes, price/tax changes, overrides, refunds, cancellations, deletions/anonymization, integration changes).

### CRM
- **customers** — first/last name, email, phone, preferred_contact (`email|sms|phone`), customer_type (`individual|business`), company_name, tags (text[]), notes, marketing_consent (bool + timestamp + source), total ‑ derived not stored where possible, source_lead_id, anonymized_at.
- **vehicles** — customer_id, year, make, model, trim, category (`coupe|sedan|suv_small|suv_large|pickup|van|commercial|other`), colour, licence_plate, condition_notes. One customer → many vehicles.
- **leads** — contact fields (may precede customer), status (`new|contacted|qualified|converted|lost`), source fields (below), converted_customer_id, assigned_staff_id, notes.
- **attribution** (embedded on leads and echoed to bookings/quotes) — source, medium, campaign, ad, keyword, landing_page, referrer, utm_* , gclid, fbclid/fbc/fbp, first_touch JSON, last_touch JSON, manual_source, referred_by_customer_id.

### Service catalog (all staff-configurable; nothing hard-coded)
- **service_categories** — name, slug, description, sort.
- **services** — category_id, name, slug, description, long_description, base_price_cents (nullable for quote-only), base_duration_min, booking_mode (`bookable|quote_required|inspection_required|approval_required|contact_only`), deposit rule (none|fixed|percent + value), active, featured, sort.
- **service_vehicle_adjustments** — service_id, vehicle_category, price_delta_cents or price_multiplier_bp, duration_delta_min.
- **addons** — name, price_cents, duration_min, active.
- **service_addons** — join: which add-ons are eligible per service.

### Scheduling
- **resources** — detailing bays / equipment: name, type (`bay|equipment`), active.
- **business_hours** — weekday, open, close (business-local times).
- **schedule_blocks** — closed periods, holidays, staff time-off (staff_id nullable ⇒ whole business), resource_id nullable, reason.
- **staff_schedules** — staff_id, weekday, start, end.
- **appointments** — customer_id, vehicle_id, status (`pending|deposit_required|confirmed|arrived|rescheduled|cancelled|no_show|converted|completed`), starts_at, ends_at (includes setup/cleanup buffers), assigned_staff_id, resource_id, services snapshot (line items with price/duration as booked), notes, source attribution, cancellation fields, job_id.
  - **Double-booking protection**: appointment creation runs in a single serializable-ish transaction that takes `SELECT … FOR UPDATE` on the target resource row, re-checks overlap (`starts_at < other.ends_at AND ends_at > other.starts_at` on non-cancelled statuses), then inserts. A DB overlap check is the source of truth; UI availability is advisory only.

### Quotes / estimates
- **quote_requests** — lead/customer link, vehicle info, requested services, condition description, photo refs, status (`new|reviewing|estimated|closed`).
- **estimates** — number (seq), customer_id, vehicle_id, status (`draft|sent|viewed|changes_requested|approved|declined|expired|converted`), line items (own table), discount, tax snapshot, deposit_required_cents, expires_at, sent_at, viewed_at, decided_at, approval record (name, ip, user-agent, timestamp, signature ref), converted_to (appointment/job/invoice id).
- **estimate_line_items** — estimate_id, service_id nullable, description, qty, unit_price_cents, is_optional, is_selected, sort.

### Jobs & inspections
- **jobs** — appointment_id, customer_id, vehicle_id, status (`checked_in|inspection|awaiting_approval|ready|in_progress|paused|quality_check|correction_required|ready_for_pickup|completed`), assigned staff, resource, mileage_in, timers (started/paused accumulations), notes.
- **inspections** — job_id, mileage, condition flags (damage/stains/pet hair/odour), customer_concerns, belongings, signature ref, completed_by, completed_at.
- **inspection_findings** — inspection_id, area, type (`scratch|dent|chip|stain|odour|other`), severity, description, photo refs.
- **job_photos / files** — private by default: entity refs, kind (`checkin|before|progress|after|damage|estimate|other`), storage_key, **public_consent** (separate explicit flag + consent record) — photos never become gallery content automatically.
- **additional_work_requests** — job_id, description, price_cents, extra_minutes, photos, status (`pending|approved|declined|override`), decided via customer token OR staff override (requires staff id + reason, audited).
- **qc_checklists** — job_id, items JSON (exterior/interior/glass/wheels/jambs/residue/requests/belongings/photos/invoice), completed_by, completed_at.

### Money
- **invoices** — number (sequential via `invoice_counters` row lock), customer_id, vehicle_id, job_id, status (`draft|sent|partially_paid|paid|overdue|cancelled|refunded`), line items table, subtotal/discount/tax(with rate snapshot)/total/deposit_applied/balance cents, due_at, pdf ref, cancelled (by/reason, audited — **never deleted**).
- **invoice_line_items**
- **payments** — invoice_id, provider (`fake|stripe|cash|etransfer|card_terminal`), provider_ref, **idempotency_key (unique)**, amount_cents, kind (`deposit|payment|refund`), status (`pending|succeeded|failed`), received_at. Webhook events recorded in **webhook_events** (provider, event_id unique, payload, processed_at) → duplicate provider events are no-ops.
- **tax snapshot** — every estimate/invoice stores the tax rate + registration label used at issue time; changing settings never rewrites history.

### Communications
- **communications** — customer_id, direction, channel (`email|sms|phone|internal`), kind (confirmation, reminder, estimate, approval_request, ready, invoice, receipt, review_request, maintenance, manual, note), subject/body, related entity, status (`queued|sent|failed|logged`), provider ref. Operational messages are always allowed; **marketing kinds require `marketing_consent`** — enforced in the messaging service, not the caller.
- **message_templates** — key, channel, subject, body (settings-editable).

### Settings
- **business_settings** — single-row-per-key JSON store: business identity (name, address, phone, registration), tax rate bp (default 1300 = 13% Ontario HST), booking min notice / max window, cancellation rules, deposit defaults, timezone, hours are their own table.

---

## 5. Booking & availability engine (`src/lib/booking/`)

Availability for a requested date is computed as:

1. Total duration = Σ service base durations + vehicle-category adjustments + add-ons + setup buffer + cleanup buffer (settings).
2. Candidate slots = business hours ∩ (staff with required skills on shift) ∩ open resource (bay) windows, stepped by slot granularity (settings, default 30 min).
3. Remove overlaps with existing non-cancelled appointments and schedule_blocks.
4. Enforce min booking notice and max booking window.
5. Return advisory slots. Final creation re-validates inside the locking transaction (see appointments above) — the transaction is the only authority.

Pricing (`src/lib/pricing/`): base + vehicle adjustment + add-ons − discount, tax computed at checkout with the current settings snapshot; deposit per service rule.

---

## 6. Conversion paths

Per-service `booking_mode` drives the public UX:
- **bookable** → full online booking (service → vehicle → add-ons → price/duration review → slot → contact → policies → optional deposit → confirmation).
- **quote_required / inspection_required** → quote request form (photos optional/required), creates lead + quote_request, staff builds estimate, customer approves via tokened link, staff/customer schedules.
- **approval_required** → booking request goes to `pending` until staff confirm.
- **contact_only** → contact CTA only.

No customer account is ever required for the first booking or quote.

---

## 7. Security requirements (non-negotiable)

- Every admin server action / route handler calls `requireStaff(role…)` on the server; UI hiding is cosmetic only.
- Zod-validate all untrusted input. Never trust client-computed prices — always recompute server-side.
- Secrets only in env; `.env*` gitignored; `.env.example` documents keys.
- Customer files/photos private by default; served via authorized, expiring URLs; separate marketing-use consent flag.
- Financial mutations idempotent (idempotency keys, unique webhook event ids). Invoices cancel — never delete. Audit log on all sensitive actions (list in §4).
- No card data ever stored; provider tokens only.
- Logs must not contain secrets, tokens, or full customer PII.
- Customer data correction/anonymization: `anonymize_customer` workflow scrubs PII on customers/leads/communications but preserves financial totals (audited).

---

## 8. Implementation phases

**Phase 1 — Foundation + booking vertical — complete**
Scaffold, schema + migrations + seed, staff auth + roles, availability engine + transactional booking, public site core pages (home, services, service detail, booking, quote request, contact, policies, FAQ, about, gallery/fleet/reviews placeholders with real routes), admin (login, dashboard, appointments, leads, customers, services settings), booking-concurrency + pricing tests.

**Phase 2 — Estimates & approvals — complete** — estimate builder, tokened customer approval, quote-request review UI, conversion to appointment.

**Phase 3 — Jobs pipeline — complete** — check-in + inspections (mobile-first), job states, additional-work approval, QC checklist, photo handling.

**Phase 4 — Invoicing & payments — complete** — invoice lifecycle, PDF, provider-authenticated checkout and webhooks, appointment deposits, receipts, and refunds.

**Phase 5 — Communications & automation — complete** — template-driven reminders, review requests, maintenance reminders, scheduling of sends, and editable channel-aware templates.

**Phase 6 — Reporting & marketing attribution — complete** — cash-basis revenue, conversion funnel, utilization, and source-to-revenue attribution reports.

**Phase 7 — Customer portal & fleet — complete** — portal pages over access tokens, company/fleet accounts, work history, and consolidated invoicing.

A smaller feature working end-to-end (UI → server → DB → tests) always beats
more placeholder screens.

---

## 9. Deployment approach

Target: any Node host with managed Postgres (Vercel + Neon/Supabase, or a VPS
with PM2/systemd + local Postgres). Requirements: run `npm run db:migrate` on
deploy, set env vars, put uploads on S3-compatible storage in production
(dev uses local `var/uploads/`, gitignored). No deployment is performed
without an explicit owner decision (cost + credentials).

---

## 10. Explicitly out of scope

Zoho integration (business may use Zoho; do not design around it), native
mobile apps, payroll, full bookkeeping, AI chatbot, complex inventory,
franchise/multi-location management.
