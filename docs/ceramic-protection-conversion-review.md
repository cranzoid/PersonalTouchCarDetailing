# Ceramic protection landing-page review — 16 September 2026

Destination: `/services/ceramic-protection`. Traffic source: Meta, confirmed by the owner. Campaign dates, spend, objective, targeting, landing-page views and historical conversion reports were not available in this session. No numerical drop-off rate or causal attribution can be established from this review.

## Observed friction

- On the published page, the first service-specific booking CTA was at approximately y=1,419px at a 390×844 viewport and y=1,446px at 1440×1000. The header's generic booking link was a different entry point and did not preselect ceramic protection.
- The headline contained neither the price nor a next action. Introductory copy, a large image and a review strip came before the purchase options.
- The discounted Ultimate Detail add-on was presented before standalone protection. The current catalogue migration sets standalone sedan protection to $149 and larger vehicles to $199; the add-on is $99/$129 and requires an additional Ultimate Detail purchase. An ad about standalone protection should lead with standalone pricing.
- The preselected booking journey collects vehicle information, then presents package extras, then availability, then contact details. Abandonment before the last step leaves no contact to follow up.
- The general quote page asks for substantially more detail than a callback needs, including service selection, vehicle fields and a required condition description.
- The old pricing table has a 30rem minimum width and requires horizontal scrolling on narrow phones.
- Existing tracking records service-to-booking clicks and successful bookings/quotes, but not the intermediate ceramic booking stages or empty availability results. GA4 ID G-JGYHFZP519 was present in the public HTML; the source includes a Meta pixel. Inclusion is not proof of receipt in either reporting platform.

## Hypotheses to validate

The delayed CTA, mixed offer hierarchy and commitment required before contact capture may lose interested visitors. Meta campaign objective, audience geography, creative expectations, bot/accidental clicks, page speed on real mobile connections and actual appointment availability may also contribute. Design alone cannot establish or fix these causes. Differences between ad clicks, page views and recorded leads can also reflect attribution windows, repeat visits, blockers or consent—not necessarily broken tracking.

Keep the ad accurate: “Ceramic protection from $149” with “Coupe/sedan, before HST” is consistent with this destination. A multi-year ceramic coating or warranty promise would describe a different service. The site continues to make this distinction visible.

## Implemented approach

- Standalone offer and qualification in the hero, with warm white form, navy structure and gold CTAs.
- Vehicle-specific catalogue prices shown immediately; commercial vehicles remain by quote. No pricing migration or change to the server pricing authority.
- Three-field callback path: vehicle category, name and phone. It reuses the existing rate-limited, validated quote action and saves a lead plus a quote request. Attribution is preserved. Marketing consent remains false.
- Confirmation explains that no appointment has been reserved. Network/server errors retain the form and provide a phone fallback. Analytics conversion events occur only on successful server responses.
- Online booking remains accessible with ceramic protection preselected. A sticky mobile CTA returns to the form.
- The add-on and premium coatings remain secondary. Compact FAQ content explains inclusions, scope, extra preparation, aftercare and the next step.
- No synthetic reviews, scarcity claims, warranty or durability guarantees added. Existing review settings and existing imagery are reused.

## Measurement after release

GA4 diagnostic events: `ceramic_landing_view`, `ceramic_enquiry_start`, `ceramic_vehicle_selected`, `ceramic_enquiry_submit`, `ceramic_enquiry_error`, `ceramic_enquiry_success`, `ceramic_booking_step`, `ceramic_availability_result`, `ceramic_booking_success`, `ceramic_booking_error`. Existing `service_to_booking_click`, `phone_click`, `quote_submitted` and `booking_completed` remain. No names, phone numbers or free-text customer content are added to event parameters.

Meta `Lead` and the existing Google Ads quote conversion fire after callback persistence. These represent requests, not paid bookings or revenue. Direct booking keeps its existing conversion behaviour. A visitor who enquires and later books can produce multiple funnel conversion events; use CRM follow-up and distinct lead/customer counts to assess business results.

Use matching dates, geography, attribution windows and device breakdowns. In Meta, compare spend → landing-page views → requests → qualified leads → appointments → completed/paid jobs. In GA4, use a session/user-based funnel rather than subtracting raw event counts; step revisits and retries can create repeated events. Check `no_slots`/`error` availability outcomes before blaming page copy. Confirm test events in GA4/Meta tools when account access is available. Keep campaign conditions stable while comparing the new page; no conversion uplift is claimed before measurement.

## Release / rollback

Use `.github/workflows/azure-release.yml`: stage the committed main branch, verify the page on staging, then swap. No database schema or pricing migration is introduced by this release.

Immediate rollback, while staging still contains the previous production release:

```sh
gh workflow run azure-release.yml --ref main -f operation=swap
```

A later staging deployment replaces that rollback target. For a durable source rollback, revert the landing-page release commit, push main, stage the reverted build, verify it, then swap.

## Validation

- Existing suite: 667 tests passed. Added phone-only callback integration test: all 6 lead tests passed.
- Production build and TypeScript checks passed.
- Browser inspection at 320, 390, 768, 1024 and 1440 pixels: no horizontal overflow or JavaScript errors.
- Local production-build form test, with messaging restricted to logs: sedan/large SUV/commercial pricing, failed-request input retention, successful persistence, one Meta Lead on success and none on failure, and service-preselected online booking all passed.
- At 390×844, the new enquiry CTA is visible in the first viewport, supported by a fixed mobile action bar. Screenshots inspected for desktop and mobile. Existing business review settings and local seeded business settings may differ; staging verification checks published data separately.
