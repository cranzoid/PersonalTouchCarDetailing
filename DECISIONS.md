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
