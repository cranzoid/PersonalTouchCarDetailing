# WORKFLOW.md — Project State & Handoff

Last updated: 2026-07-19 (session 1 — initial build).
Read `BUILD.md` first for product scope and architecture; this file records the
repository's **actual current state** and the exact next action.

---

## Current phase

**Phase 1 — Foundation + booking vertical: COMPLETE (verified).**
Next up: Phase 2 — Estimates & approvals (see "Exact next action" below).

## Completed and verified (this session)

- **Scaffold**: Next.js 15 + React 19 + TypeScript + Tailwind v4, manual scaffold
  (create-next-app rejects the capitalized folder name). `npm run build` passes;
  all 27 routes compile.
- **Database**: PostgreSQL 14 (local, unix socket `/tmp`), Drizzle ORM.
  Migration `drizzle/0000_init.sql` applied to `ptcd_dev` and `ptcd_test`.
  ~30 tables covering identity/sessions/tokens/audit, CRM (customers, vehicles,
  leads + jsonb attribution), full service catalog, scheduling (bays, hours,
  blocks, appointments + line snapshots), quotes/estimates, jobs/inspections/QC,
  invoices/payments/webhook events, communications/templates, settings KV.
- **Seed** (`npm run db:seed`, idempotent): 6 categories / 24 services from the
  spec, vehicle-size adjustments, 6 add-ons, 2 bays, business hours, counters,
  message templates, dev owner login `owner@ptcd.local` / `detailing-dev-2026`
  (**dev only — replace before production**). All prices/durations are
  PLACEHOLDERS pending owner confirmation.
- **Core libraries** (`src/lib/`):
  - `auth/` — bcrypt passwords, DB-backed sessions (hashed tokens, revocable),
    `requireStaff(permission)` server gate + role permission map.
  - `pricing/` — server-authoritative price/duration/tax computation
    (vehicle-category adjustments, add-on eligibility, HST snapshot, deposits).
  - `booking/` — pure availability engine (hours, granularity, buffers, notice,
    window, bay capacity, global/bay blocks) + `createAppointment` transaction
    that locks bay rows `FOR UPDATE` and re-validates before insert.
  - `messaging/` — dev transport logging to `communications`; marketing-consent
    enforcement lives inside `sendMessage` (operational kinds always allowed).
  - `audit.ts`, `settings.ts` (typed KV with safe defaults), `tz.ts` (DST-safe
    America/Toronto ↔ UTC), `money.ts` (integer cents), `id.ts` (prefixed ids).
- **Public site** (dark premium theme, responsive, attribution capture on
  landing): Home, Services overview + per-service detail, **working booking
  wizard** (service → vehicle → add-ons → real availability → contact →
  policies → confirmation; server recomputes price + confirms in a locking
  transaction), **working quote request** (photos upload to private storage,
  lead + quote request created, ack message logged), Contact + Fleet (working
  lead forms), About / FAQ / Gallery / Reviews (no invented history or fake
  testimonials — placeholders marked), Privacy / Cancellation / Terms (drafts
  flagged for owner/legal review), Portal entry page (tokened-link model).
- **Admin app** (`/admin`, session-gated layout + per-action `requireStaff`):
  Login/logout, Dashboard (today's appointments, new leads/quotes, action
  counts), Appointments list + detail with audited status transitions
  (confirm/arrive/cancel(+reason)/no-show/complete), Leads + Quote-request
  review (private photo viewing via authorized `/api/files/[id]`), Customers
  list/detail (vehicles, appointment history, communication history),
  Services editor (price/duration/mode/deposit/active/featured — audited),
  Business settings editor (identity, HST rate, booking rules — audited).
- **Tests** (`npm test` — 22 passing):
  - Money/pricing math incl. HST rounding.
  - Availability slots: hours, notice, window, closures, bay capacity,
    unassigned-appointment capacity.
  - **DB concurrency**: 5 parallel bookings for one slot with 2 bays → exactly
    2 succeed on distinct bays; 1 bay → exactly 1; overlap rejected, adjacent
    slot allowed; out-of-hours rejected.
- **Smoke test**: production server boots; all public routes 200; `/admin`
  redirects unauthenticated → `/admin/login`.

## Implemented but not fully verified

- Booking wizard and quote form UI flows work through the same server actions
  the tests exercise, but were **not driven end-to-end in a browser** this
  session (server-action + DB layers are test-covered; routes render 200).
- Login UI flow (session creation code is exercised; form not browser-tested).
- Attribution capture (localStorage first/last-touch) — code reviewed, not
  browser-tested.

## In progress / not started

- Estimates builder & customer tokened approval (schema + access_tokens ready).
- Jobs pipeline UI (check-in, inspections, additional work, QC) — schema ready.
- Invoicing/payments (schema + idempotency/webhook tables ready; no provider).
- Automated reminders/scheduled sends; reports; customer portal pages; fleet
  company accounts.

## Important decisions (see also DECISIONS.md)

1. Single Next.js app for public site + admin + API; Postgres + Drizzle.
2. Double-booking safety = `FOR UPDATE` lock on bay rows inside the booking
   transaction + live re-validation; UI slot lists are advisory only.
3. Money = integer cents; tax rates = basis points; tax snapshotted onto
   financial rows at issue time.
4. Customers need no accounts; customer access will use single-purpose hashed
   tokens (`access_tokens`), already modelled.
5. Marketing consent enforced inside the messaging service, not at call sites;
   review/maintenance reminders classified as marketing-consent-required.
6. Photos private by default (`files.public_consent_at` is a separate explicit
   grant); staff-only file serving route.
7. Seed prices/hours/policies are configurable placeholders, not commitments.

## Files & systems changed

Everything is new this session: see repository tree (`src/`, `drizzle/`,
`tests/`, `BUILD.md`, `WORKFLOW.md`, `DECISIONS.md`). Databases `ptcd_dev` and
`ptcd_test` created locally with migration 0000 applied; dev DB seeded.

## Database / API changes

- Migration `drizzle/0000_init.sql` (initial schema).
- Server actions: booking slots + submit, quote submit, contact submit, admin
  login/logout, appointment transition, lead/quote status, service update,
  settings update. Route handler: `GET /api/files/[id]` (staff-only private
  files).

## Known limitations

- No rate limiting on public forms yet (spam risk) — add before launch.
- Uploads stored on local disk `var/uploads/` (fine in dev; use S3-compatible
  storage in production).
- Staff skills/schedules modelled but not yet enforced in availability (bay
  capacity governs; seed services require no skills).
- Static-rendered public pages (e.g. home) revalidate via `revalidatePath` on
  service/settings edits; verify revalidation behaviour on the chosen host.
- `next start` requires Node ≥ 18; built with Node 26. ESLint not configured
  (deliberate scope cut; add before team development).
- Admin appointment cancel prompt uses `window.prompt` (fine for staff use;
  replace with a proper dialog later).
- Dev seed password is public in this file — rotate/replace before deploy.

## Business questions requiring confirmation (blocking content, not code)

1. Real street address, postal code, phone, public email (Settings → currently
   placeholders; footer/contact render what's configured).
2. Confirmed service list, prices, durations, deposit rules (seeded values are
   market-plausible placeholders).
3. Business hours (seeded Mon–Fri 8–18, Sat 9–17, Sun closed).
4. Cancellation notice window + deposit forfeiture policy (48h placeholder).
5. HST registration number for invoices.
6. Bay count/names (seeded: Bay 1, Bay 2) and staff roster.
7. Owner-approved About copy; any warranty language for coatings/PPF (none
   published — new ownership, no inherited claims).
8. Google Business Profile / review destination link for the Reviews page.
9. Payment provider choice (Stripe assumed for Phase 4) and deposit amounts.

## Exact next implementation action

**Phase 2, step 1:** Build the estimate builder in admin
(`/admin/estimates/new` from a quote request: line items from services +
custom lines, optional items, discount, tax snapshot, expiry) and the customer
approval page at `/portal/estimates/[token]` using `access_tokens`
(purpose `estimate_view`, hashed token, expiry, audit on approve/decline with
name+IP). Wire "Create estimate" from the quote-request detail page, then a
"convert approved estimate → appointment" action reusing
`createAppointment`.

## How to run

```bash
npm install                 # deps (allowScripts already configured)
createdb -h /tmp ptcd_dev ptcd_test   # if missing
cp .env.example .env.local  # fill SESSION_SECRET (openssl rand -hex 32)
npm run db:migrate && npm run db:seed
npm run dev                 # http://localhost:3000  (admin: /admin/login)
npm test                    # 22 tests (uses TEST_DATABASE_URL)
```
