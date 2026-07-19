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

## 12. New-ownership content rule
No published years-in-business, inherited warranties, testimonials, or
historical claims anywhere. All such content is settings-driven or explicitly
marked as pending owner approval. **Fixed product rule, not a tech decision.**
