"use client";

import Link from "next/link";
import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { getStoredAttribution } from "@/components/attribution";
import { trackMetaLead } from "@/components/meta-pixel";
import { trackBookAppointmentConversion } from "@/components/google-tag";
import { DATE_ONLY_BOOKING_NOTICE, DATE_ONLY_BOOKING_NOTICE_SHORT } from "@/lib/ceramic";
import { formatCents } from "@/lib/money";
import { localDateISO } from "@/lib/tz";
import { SERVICE_PRESENTATION } from "@/lib/public-content";
import { bestOfAllocations, bundleDiscountAllocations, bundlePerkFor } from "@/lib/bundle-offers";
import { washOfferAllocation } from "@/lib/wash-offer";
import {
  VEHICLE_CATEGORIES,
  VEHICLE_CATEGORY_LABELS,
  isQuoteOnlyVehicleCategory,
  type VehicleCategory,
} from "@/lib/types";
import { getSlotsAction, submitBookingAction, type BookingResult } from "./actions";

export type WizardService = {
  id: string;
  slug: string;
  name: string;
  categoryName: string;
  shortDescription: string;
  basePriceCents: number;
  compareAtPriceCents: number | null;
  baseDurationMin: number;
  adjustments: Record<string, { priceDeltaCents: number; durationDeltaMin: number }>;
  addonIds: string[];
  /**
   * Condition caveat shown beside the estimate for services whose displayed
   * price covers the work itself but not condition-dependent preparation.
   * Null for services where the price is the whole story.
   */
  conditionNotice: string | null;
  /**
   * The shop schedules this service by hand, so the customer picks a date and
   * we call them about the time. Resolved on the server from the catalogue
   * slug; the wizard only decides what to render, never what is allowed.
   */
  dateOnly: boolean;
  /**
   * Suppresses the "approx. Xh of work" line in the estimate. A coating is
   * sequenced by hand across the day, so its hours describe the shop's
   * schedule, not a collection time the customer can plan around.
   */
  hideDuration: boolean;
};

export type WizardAddon = {
  id: string;
  /** Deep-link key, so an ad can preselect this add-on. Null for most. */
  slug: string | null;
  name: string;
  description: string;
  priceCents: number;
  durationMin: number;
  /** Vehicle-size deltas, same shape and meaning as a service's. */
  adjustments: Record<string, { priceDeltaCents: number; durationDeltaMin: number }>;
  /**
   * Condition attached to this add-on's price — shown wherever the price is,
   * never separated from it.
   */
  qualifier: string | null;
};

/** An add-on's price and time for a vehicle category: base plus its delta. */
function addonFor(addon: WizardAddon, vehicleCategory: string) {
  const adj = addon.adjustments[vehicleCategory];
  return {
    priceCents: addon.priceCents + (adj?.priceDeltaCents ?? 0),
    durationMin: addon.durationMin + (adj?.durationDeltaMin ?? 0),
  };
}

export type WizardPromo = {
  code: string;
  label: string;
  percentOffBp: number;
  eligibleServiceIds: string[];
};

/**
 * A new-customer wash code the visitor arrived holding, already resolved
 * server-side. Advisory here exactly as every other price is: the wizard shows
 * what this claim is worth, and the server settles it again at submit.
 */
export type WizardWashClaim = {
  /** Canonical code, sent back with the booking. */
  code: string;
  offerLabel: string;
  /** The one catalogue service this claim buys. */
  serviceSlug: string;
  /** Promo price per vehicle category. A category absent from this is not covered. */
  priceCentsByCategory: Partial<Record<VehicleCategory, number>>;
  expiresLabel: string;
  /** Prefill, so the booking carries the same contact the claim was issued to. */
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  vehicleCategory: VehicleCategory;
};

export type WizardBundleOffer = {
  primaryServiceId: string;
  bundledServiceId: string;
  discountPercentBp: number;
  label: string;
  /** Zero-priced extra this pairing unlocks. Opt-in; the server re-checks it. */
  perkLabel: string | null;
  perkNote: string | null;
};

const STEPS = ["Service", "Vehicle", "Package", "Time", "Details"] as const;
/** Same five steps; the fourth asks for a date alone. */
const DATE_ONLY_STEPS = ["Service", "Vehicle", "Package", "Date", "Details"] as const;
const focusRing = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-400 focus-visible:ring-offset-2 focus-visible:ring-offset-ink-950";

export function BookingWizard({
  services,
  addons,
  taxRateBp,
  taxLabel,
  preselectSlug,
  maxBookingWindowDays,
  timezone,
  promo = null,
  bundleOffers,
  offerFromUrl,
  preselectAddonSlug,
  preselectBundleSlug,
  washClaim = null,
}: {
  services: WizardService[];
  addons: WizardAddon[];
  taxRateBp: number;
  taxLabel: string;
  preselectSlug?: string;
  maxBookingWindowDays: number;
  timezone: string;
  /** The offer currently running, resolved server-side. */
  promo?: WizardPromo | null;
  /** Server-authored relationships that unlock an automatic service discount. */
  bundleOffers: WizardBundleOffer[];
  offerFromUrl?: string;
  /** Add-on an ad asked to preselect. Honoured only if the chosen service offers it. */
  preselectAddonSlug?: string;
  /** Optional detailing package to add to an ad-driven ceramic cart. */
  preselectBundleSlug?: string;
  /** A live new-customer wash claim, resolved on the server from ?claim=. */
  washClaim?: WizardWashClaim | null;
}) {
  const idPrefix = useId();
  const preselected = services.find((s) => s.slug === preselectSlug);
  // A campaign can arrive with both halves of the cart. The add-on is applied
  // only when the preselected service actually offers it, so a stale ad URL
  // lands on a valid cart instead of one the server would reject.
  const preselectedBundle = services.find((candidate) =>
    !!preselected &&
    candidate.slug === preselectBundleSlug &&
    bundleOffers.some((offer) =>
      offer.primaryServiceId === preselected.id && offer.bundledServiceId === candidate.id,
    ),
  );
  const preselectedAddon = addons.find(
    (a) =>
      !!preselectAddonSlug &&
      a.slug === preselectAddonSlug &&
      [preselected, preselectedBundle].some((candidate) => candidate?.addonIds.includes(a.id)),
  );
  const [step, setStep] = useState(preselected ? 1 : 0);
  const [serviceId, setServiceId] = useState<string | null>(preselected?.id ?? null);
  const [bundleServiceId, setBundleServiceId] = useState<string | null>(preselectedBundle?.id ?? null);
  // The bundle extra is something the customer asks for, not something we add
  // for them — it costs them nothing but it commits them to bringing a pen.
  const [perkOptIn, setPerkOptIn] = useState(false);
  // Seeded from the claim so the size the customer told us on the landing page
  // is already selected — they can still change it, and the price follows the
  // category they actually pick rather than the one they guessed.
  const [vehicleCategory, setVehicleCategory] = useState<VehicleCategory>(
    washClaim?.vehicleCategory ?? "sedan",
  );
  const [vehicle, setVehicle] = useState({ year: "", make: "", model: "", colour: "" });
  const [selectedAddons, setSelectedAddons] = useState<string[]>(
    preselectedAddon ? [preselectedAddon.id] : [],
  );
  // Add-ons dropped because the customer changed service. Announced rather
  // than silently removed — a ceramic protection selection disappearing from
  // the total without a word is exactly the surprise we are avoiding.
  const [droppedAddons, setDroppedAddons] = useState<string[]>([]);
  const [dateISO, setDateISO] = useState("");
  const [slots, setSlots] = useState<{ startMs: number; label: string }[] | null>(null);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [slotsError, setSlotsError] = useState<string | null>(null);
  const [startMs, setStartMs] = useState<number | null>(null);
  const [contact, setContact] = useState({
    firstName: washClaim?.firstName ?? "",
    lastName: washClaim?.lastName ?? "",
    email: washClaim?.email ?? "",
    // The claim is bound to this number, so pre-filling it is not merely
    // convenience: a typo here silently costs the customer their offer.
    phone: washClaim?.phone ?? "",
    notes: "",
  });
  const [policiesAccepted, setPoliciesAccepted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<BookingResult | null>(null);
  // Set once the server has told us the offer does not apply after all, so the
  // preview stops promising a discount the booking will not honour.
  const [offerWithdrawn, setOfferWithdrawn] = useState(false);
  // The visitor's claim: from this URL, or stored when they landed on an
  // earlier page from the same ad. localStorage is only readable after mount.
  const [claimedCode, setClaimedCode] = useState<string | undefined>(offerFromUrl);
  useEffect(() => {
    if (claimedCode) return;
    const stored = getStoredAttribution().offerCode;
    if (stored) setClaimedCode(stored);
  }, [claimedCode]);

  const service = services.find((s) => s.id === serviceId) ?? null;
  const bundleService = services.find((s) => s.id === bundleServiceId) ?? null;
  // Commercial vehicles are quoted, never priced from the catalogue — the
  // public price tables say so, and the booking flow has to agree rather than
  // quietly charging a sedan price plus a delta.
  const quoteOnlyVehicle = isQuoteOnlyVehicleCategory(vehicleCategory);
  // A coating takes most of a working day and the shop arranges the drop-off
  // by phone, so this customer chooses a date and never sees a slot picker.
  const dateOnly = !!service?.dateOnly;
  // A claim is worth something only against the offer the server is running.
  const claimsOffer =
    !!promo && !!claimedCode && claimedCode.trim().toUpperCase() === promo.code && !offerWithdrawn;
  // What this claim is worth against the vehicle currently selected. Null when
  // the wash is not in the cart, the size is not covered (commercial), or the
  // server has already told us the claim no longer applies.
  const washPriceCents =
    washClaim && !offerWithdrawn && service?.slug === washClaim.serviceSlug
      ? washClaim.priceCentsByCategory[vehicleCategory] ?? null
      : null;
  const selectedServiceIds = useMemo(
    () => service ? [service.id, ...(bundleService ? [bundleService.id] : [])] : [],
    [service, bundleService],
  );
  const serviceQualifies = !!promo && selectedServiceIds.some((id) => promo.eligibleServiceIds.includes(id));
  // Same rule the server applies, so the wizard can never offer an extra the
  // booking would refuse to honour.
  const availablePerk = useMemo(
    () => bundlePerkFor(selectedServiceIds, bundleOffers),
    [selectedServiceIds, bundleOffers],
  );
  // A perk that stops being available takes its opt-in with it, so a stale
  // tick cannot travel to the server with a cart that no longer earns it.
  useEffect(() => {
    if (!availablePerk && perkOptIn) setPerkOptIn(false);
  }, [availablePerk, perkOptIn]);
  // Ordered by the catalogue, like the service list above it: the offer rows
  // come back in whatever order the database holds them, which put the
  // cheapest package first and contradicted the copy naming them #1 to #3.
  const eligibleBundleOffers = useMemo(
    () => service
      ? bundleOffers
          .filter((offer) => offer.primaryServiceId === service.id)
          .sort((left, right) =>
            services.findIndex((s) => s.id === left.bundledServiceId) -
            services.findIndex((s) => s.id === right.bundledServiceId),
          )
      : [],
    [service, bundleOffers, services],
  );
  const eligibleAddons = useMemo(
    () => addons.filter((addon) =>
      [service, bundleService].some((candidate) => candidate?.addonIds.includes(addon.id)),
    ),
    [service, bundleService, addons],
  );
  /**
   * The service list, cut into its catalogue categories.
   *
   * The step used to be one undifferentiated stack of nine cards in catalogue
   * order, so a $399 coating sat between two detailing packages and the
   * customer had to read every card to find the group they came for. The
   * server hands the services over already sorted by category, so consecutive
   * runs are the groups — no second source of ordering to keep in step.
   */
  const serviceGroups = useMemo(() => {
    const groups: { name: string; services: WizardService[] }[] = [];
    for (const s of services) {
      const current = groups[groups.length - 1];
      if (current && current.name === s.categoryName) current.services.push(s);
      else groups.push({ name: s.categoryName, services: [s] });
    }
    return groups;
  }, [services]);

  /** Advisory preview only — the server recomputes authoritative pricing. */
  const preview = useMemo(() => {
    if (!service || isQuoteOnlyVehicleCategory(vehicleCategory)) return null;
    const selectedServices = [service, bundleService].filter((item): item is WizardService => !!item);
    const serviceLines = selectedServices.map((item) => {
      const adj = item.adjustments[vehicleCategory];
      return {
        serviceId: item.id,
        priceCents: item.basePriceCents + (adj?.priceDeltaCents ?? 0),
        durationMin: item.baseDurationMin + (adj?.durationDeltaMin ?? 0),
      };
    });
    let subtotal = serviceLines.reduce((sum, line) => sum + line.priceCents, 0);
    let duration = serviceLines.reduce((sum, line) => sum + line.durationMin, 0);
    for (const id of selectedAddons) {
      const a = addons.find((x) => x.id === id);
      if (a) {
        const priced = addonFor(a, vehicleCategory);
        subtotal += priced.priceCents;
        duration += priced.durationMin;
      }
    }
    // Mirrors the server: an automatic bundle and a claimed campaign promotion
    // never stack on the same line. The larger saving wins, before tax.
    const bundle = bundleDiscountAllocations(serviceLines, bundleOffers);
    const campaignAllocation = serviceLines.map((line) =>
      claimsOffer && promo!.eligibleServiceIds.includes(line.serviceId)
        ? Math.min(line.priceCents, Math.round((line.priceCents * promo!.percentOffBp) / 10000))
        : 0,
    );
    // The wash claim, priced the same way the server prices it: the catalogue
    // price for this vehicle, less the promo price for its size.
    const washAllocation = washPriceCents !== null
      ? washOfferAllocation(serviceLines, {
          serviceId: serviceLines[0].serviceId,
          promoPriceCents: washPriceCents,
        }).allocation
      : new Array(serviceLines.length).fill(0);
    // Same precedence, and the same "never stack" rule, as priceBooking.
    const resolved = bestOfAllocations([
      { key: "wash", allocation: washAllocation },
      { key: "bundle", allocation: bundle.allocation },
      { key: "campaign", allocation: campaignAllocation },
    ]);
    const washApplied = resolved.contributing.has("wash");
    const bundleApplied = resolved.contributing.has("bundle");
    const discount = resolved.allocation.reduce((sum, cents) => sum + cents, 0);
    const discountLabel = washApplied
      ? washClaim?.offerLabel
      : bundleApplied
        ? bundle.labels[0]
        : resolved.contributing.has("campaign")
          ? promo?.label
          : null;
    const taxable = subtotal - discount;
    const tax = Math.round((taxable * taxRateBp) / 10000);
    return { subtotal, discount, discountLabel, bundleApplied, washApplied, tax, total: taxable + tax, duration, serviceLines };
  }, [service, bundleService, vehicleCategory, selectedAddons, addons, taxRateBp, claimsOffer, promo, bundleOffers, washPriceCents, washClaim]);

  async function loadSlots(date: string) {
    if (!service || !date) return;
    setSlotsLoading(true);
    setSlotsError(null);
    setSlots(null);
    setStartMs(null);
    const res = await getSlotsAction({
      dateISO: date,
      serviceIds: selectedServiceIds,
      addonIds: selectedAddons,
      vehicleCategory,
    });
    setSlotsLoading(false);
    if (res.ok) setSlots(res.slots);
    else setSlotsError(res.error);
  }

  async function submit() {
    if (!service || !dateISO || (!dateOnly && !startMs)) return;
    setSubmitting(true);
    const res = await submitBookingAction({
      serviceIds: selectedServiceIds,
      addonIds: selectedAddons,
      vehicleCategory,
      perkOptIn: perkOptIn && !!availablePerk,
      dateISO,
      // Omitted for a date-only service. The server does not take the wizard's
      // word for it either way — it re-reads the catalogue.
      startMs: dateOnly ? undefined : startMs,
      customer: {
        firstName: contact.firstName,
        lastName: contact.lastName,
        email: contact.email || undefined,
        phone: contact.phone || undefined,
        preferredContact: contact.email ? "email" : "phone",
      },
      vehicle: {
        year: vehicle.year ? Number(vehicle.year) : undefined,
        make: vehicle.make,
        model: vehicle.model,
        category: vehicleCategory,
        colour: vehicle.colour || undefined,
      },
      customerNotes: contact.notes || undefined,
      policiesAccepted: true as const,
      attribution: getStoredAttribution(),
      promoCode: claimsOffer ? claimedCode : undefined,
      // Sent whenever we hold one. The server decides what it is worth — and
      // whether it belongs to the phone number on this booking.
      washClaimCode: washClaim?.code,
      // What the customer is looking at right now. If the server disagrees it
      // books nothing and returns the corrected total for them to confirm.
      expectedDiscountCents: preview?.discount ?? 0,
    });
    setSubmitting(false);
    // Nothing was booked: drop the discount from the preview so the button and
    // the summary show the real price before they press confirm again.
    if (!res.ok && res.kind === "offer_changed") {
      setOfferWithdrawn(true);
      setResult(res);
      return;
    }
    setResult(res);
    // Conversion: the appointment was created server-side and has a reference.
    // Fired once per successful booking, not on step navigation or errors.
    if (res.ok) {
      trackMetaLead({ content_name: "Booking", content_category: service.name });
      trackBookAppointmentConversion();
    }
  }

  if (result?.ok) {
    return (
      <div role="status" aria-live="polite" className="mx-auto max-w-xl rounded-[2rem] border border-accent-500/40 bg-gradient-to-br from-ink-900 to-ink-950 p-8 text-center shadow-2xl shadow-black/20 sm:p-10">
        <div aria-hidden="true" className="mx-auto grid size-14 place-items-center rounded-full bg-accent-400 text-2xl font-bold text-ink-950">✓</div>
        <h2 className="mt-4 text-2xl font-bold text-white">
          {result.depositUrl ? "Your appointment time is on hold" : "You’re booked!"}
        </h2>
        <p className="mt-3 text-ink-300">
          {result.whenLabel} — estimated total {result.totalLabel} (incl. {taxLabel}).
        </p>
        {result.timeToBeConfirmed && (
          <p className="mt-3 rounded-2xl border border-accent-500/25 bg-[#0B2A4A]/55 p-4 text-sm leading-6 text-ink-200">
            {DATE_ONLY_BOOKING_NOTICE_SHORT}
          </p>
        )}
        {result.depositLabel && result.depositUrl && (
          <div className="mt-5 rounded-2xl border border-accent-500/25 bg-[#0B2A4A]/55 p-5">
            <p className="text-sm text-ink-200">
              Your appointment is not confirmed until the {result.depositLabel} deposit is paid.
            </p>
            <a
              href={result.depositUrl}
              className={`mt-4 inline-flex min-h-11 items-center justify-center rounded-xl bg-accent-400 px-6 py-3 text-sm font-semibold text-ink-950 hover:bg-accent-300 ${focusRing}`}
            >
              Pay Deposit Securely
            </a>
          </div>
        )}
        <p className="mt-4 text-sm text-ink-400">
          {result.confirmationDelivery
            ? result.depositUrl
              ? `The secure payment link was also sent by ${result.confirmationDelivery}. `
              : `A confirmation was sent by ${result.confirmationDelivery}. `
            : result.depositUrl
              ? "Please use the secure payment button above and save this reference. "
              : "We could not send a confirmation, so please save this reference. "}
          Reference:{" "}
          <span className="font-mono text-ink-300">{result.appointmentId}</span>
        </p>
      </div>
    );
  }

  // Business-local calendar dates. toISOString() gives the UTC day, which after
  // ~8pm in America/Toronto had already rolled over and pushed the earliest
  // bookable date a full day further out than the notice rule requires.
  const minDate = localDateISO(timezone, 86_400_000);
  const maxDate = localDateISO(timezone, maxBookingWindowDays * 86_400_000);

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,2fr)_minmax(17rem,1fr)] lg:items-start">
      <section aria-labelledby={`${idPrefix}-booking-step`} className="min-w-0 rounded-[2rem] border border-ink-700/70 bg-gradient-to-br from-ink-900/95 via-ink-900/75 to-[#0B2A4A]/25 p-5 shadow-2xl shadow-black/20 sm:p-8">
        {/* Step indicator */}
        <ol aria-label="Booking progress" className="mb-8 grid grid-cols-2 gap-2 text-xs sm:grid-cols-5">
          {(dateOnly ? DATE_ONLY_STEPS : STEPS).map((label, i) => (
            <li
              key={label}
              aria-current={i === step ? "step" : undefined}
              className={`flex min-h-11 items-center justify-center rounded-xl border px-3 py-2 text-center transition-colors ${
                i === step
                  ? "border-accent-400 bg-accent-400 font-semibold text-ink-950 shadow-lg shadow-accent-500/15"
                  : i < step
                    ? "border-[#0B2A4A] bg-[#0B2A4A] text-ink-100"
                    : "border-ink-700 bg-ink-950/50 text-ink-400"
              }`}
            >
              {i + 1}. {label}
            </li>
          ))}
        </ol>

        {step === 0 && (
          <div className="space-y-8">
            <h2 id={`${idPrefix}-booking-step`} className="text-xl font-semibold text-white">Choose your service</h2>
            {serviceGroups.map((group) => (
              <section key={group.name} aria-label={group.name || undefined} className="space-y-3">
                {group.name && (
                  <h3 className="text-xs font-semibold uppercase tracking-[0.18em] text-accent-300">
                    {group.name}
                  </h3>
                )}
                {group.services.map((s) => (
                  <button
                    type="button"
                    key={s.id}
                    aria-pressed={serviceId === s.id}
                    onClick={() => {
                      setServiceId(s.id);
                      // Carry over only what this service actually offers. The
                      // discounted ceramic protection price is linked to one
                      // package, so switching away from it must remove — and say
                      // that it removed — the selection rather than reprice it
                      // silently.
                      const keepsBundle = !!bundleService && bundleOffers.some((offer) =>
                        offer.primaryServiceId === s.id && offer.bundledServiceId === bundleService.id,
                      );
                      const nextBundle = keepsBundle ? bundleService : null;
                      const allowedAddonIds = new Set([
                        ...s.addonIds,
                        ...(nextBundle?.addonIds ?? []),
                      ]);
                      const kept = selectedAddons.filter((id) => allowedAddonIds.has(id));
                      setDroppedAddons([
                        ...selectedAddons
                          .filter((id) => !allowedAddonIds.has(id))
                          .map((id) => addons.find((a) => a.id === id)?.name)
                          .filter((name): name is string => !!name),
                        ...(!keepsBundle && bundleService ? [bundleService.name] : []),
                      ]);
                      setBundleServiceId(nextBundle?.id ?? null);
                      setSelectedAddons(kept);
                      setSlots(null);
                      setStartMs(null);
                      setStep(1);
                    }}
                    className={`min-h-11 w-full rounded-2xl border p-5 text-left transition-all ${focusRing} ${
                      serviceId === s.id
                        ? "border-accent-400 bg-[#0B2A4A]/80 shadow-lg shadow-black/20"
                        : "border-ink-700 bg-ink-950/45 hover:-translate-y-0.5 hover:border-accent-500/60 hover:bg-[#0B2A4A]/35"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-4">
                      {/* The category is the group heading now, so the card carries
                          the service and nothing that repeats above it. */}
                      <div>
                        <p className="font-semibold text-white">{s.name}</p>
                        <p className="mt-1 text-sm text-ink-400">{s.shortDescription}</p>
                      </div>
                      <span className="shrink-0 text-right text-accent-300">
                        {s.compareAtPriceCents !== null && (
                          <span className="mr-2 text-xs text-ink-500 line-through">{formatCents(s.compareAtPriceCents)}</span>
                        )}
                        From {formatCents(s.basePriceCents)}
                      </span>
                    </div>
                  </button>
                ))}
              </section>
            ))}
          </div>
        )}

        {step === 1 && (
          <div className="max-w-lg space-y-4">
            <h2 id={`${idPrefix}-booking-step`} className="text-xl font-semibold text-white">Tell us about your vehicle</h2>
            <fieldset>
              <legend className="mb-2 block text-sm font-medium text-ink-200">Vehicle type</legend>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {VEHICLE_CATEGORIES.map((cat) => (
                  <button
                    type="button"
                    key={cat}
                    aria-pressed={vehicleCategory === cat}
                    onClick={() => {
                      setVehicleCategory(cat);
                      setSlots(null);
                      setStartMs(null);
                    }}
                    className={`min-h-11 rounded-xl border px-3 py-2 text-sm transition-colors ${focusRing} ${
                      vehicleCategory === cat
                        ? "border-accent-400 bg-[#0B2A4A] font-medium text-white"
                        : "border-ink-700 bg-ink-950/40 text-ink-300 hover:border-accent-500/60"
                    }`}
                  >
                    {VEHICLE_CATEGORY_LABELS[cat]}
                  </button>
                ))}
              </div>
            </fieldset>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field id={`${idPrefix}-year`} label="Year" value={vehicle.year} onChange={(v) => setVehicle({ ...vehicle, year: v })} placeholder="2021" inputMode="numeric" />
              <Field id={`${idPrefix}-colour`} label="Colour" value={vehicle.colour} onChange={(v) => setVehicle({ ...vehicle, colour: v })} placeholder="Black" />
              <Field id={`${idPrefix}-make`} label="Make" required value={vehicle.make} onChange={(v) => setVehicle({ ...vehicle, make: v })} placeholder="Honda" />
              <Field id={`${idPrefix}-model`} label="Model" required value={vehicle.model} onChange={(v) => setVehicle({ ...vehicle, model: v })} placeholder="Civic" />
            </div>
            {quoteOnlyVehicle && (
              <p role="status" className="rounded-xl border border-amber-400/30 bg-amber-950/20 p-4 text-sm leading-6 text-amber-200">
                Commercial vehicles are quoted individually — size, fit-out and access vary too much for
                a list price.{" "}
                <Link className="font-semibold underline hover:text-amber-100" href="/quote">
                  Request a quote
                </Link>{" "}
                and we will come back with a price and a time.
              </p>
            )}
            <StepNav
              onBack={() => setStep(0)}
              onNext={() => setStep(2)}
              nextDisabled={quoteOnlyVehicle || !vehicle.make.trim() || !vehicle.model.trim()}
            />
          </div>
        )}

        {step === 2 && (
          <div className="max-w-lg space-y-3">
            <h2 id={`${idPrefix}-booking-step`} className="mb-5 text-xl font-semibold text-white">Complete your package</h2>
            {eligibleBundleOffers.length > 0 && (
              <section className="mb-6 rounded-2xl border border-accent-400/40 bg-accent-400/[0.07] p-4" aria-labelledby={`${idPrefix}-bundle-heading`}>
                <p className="text-[0.68rem] font-bold uppercase tracking-[0.18em] text-accent-300">Package-only saving</p>
                <h3 id={`${idPrefix}-bundle-heading`} className="mt-2 text-lg font-semibold text-white">
                  Add one detailing package and save {eligibleBundleOffers[0].discountPercentBp / 100}%
                </h3>
                <p className="mt-1 text-sm leading-6 text-ink-300">
                  Choose Ultimate Detail, Signature Detail or Interior Detail. The saving is applied automatically below.
                </p>
                <div className="mt-4 space-y-2">
                  {eligibleBundleOffers.map((offer) => {
                    const option = services.find((candidate) => candidate.id === offer.bundledServiceId);
                    if (!option) return null;
                    const adj = option.adjustments[vehicleCategory];
                    const fullPrice = option.basePriceCents + (adj?.priceDeltaCents ?? 0);
                    const saving = Math.round((fullPrice * offer.discountPercentBp) / 10000);
                    const checked = bundleServiceId === option.id;
                    return (
                      <button
                        type="button"
                        key={offer.bundledServiceId}
                        aria-pressed={checked}
                        onClick={() => {
                          const nextId = checked ? null : option.id;
                          setBundleServiceId(nextId);
                          const nextService = checked ? null : option;
                          const allowed = new Set([
                            ...(service?.addonIds ?? []),
                            ...(nextService?.addonIds ?? []),
                          ]);
                          const removed = selectedAddons.filter((id) => !allowed.has(id));
                          setSelectedAddons(selectedAddons.filter((id) => allowed.has(id)));
                          setDroppedAddons(removed.map((id) => addons.find((addon) => addon.id === id)?.name).filter((name): name is string => !!name));
                          setSlots(null);
                          setStartMs(null);
                        }}
                        className={`flex min-h-11 w-full items-center justify-between gap-4 rounded-xl border px-4 py-3 text-left transition ${focusRing} ${
                          checked ? "border-accent-400 bg-[#0B2A4A]" : "border-white/10 bg-ink-950/35 hover:border-accent-400/60"
                        }`}
                      >
                        <span>
                          <span className="block font-medium text-white">{publicServiceName(option)}</span>
                          <span className="mt-0.5 block text-xs text-ink-400">{option.shortDescription}</span>
                        </span>
                        <span className="shrink-0 text-right">
                          <span className="block text-xs text-ink-500 line-through">{formatCents(fullPrice)}</span>
                          <span className="block font-semibold text-emerald-300">{formatCents(fullPrice - saving)}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>
                {availablePerk && (
                  <button
                    type="button"
                    aria-pressed={perkOptIn}
                    onClick={() => setPerkOptIn(!perkOptIn)}
                    className={`mt-4 flex w-full items-start gap-3 rounded-xl border px-4 py-3 text-left transition ${focusRing} ${
                      perkOptIn ? "border-emerald-400/60 bg-emerald-950/25" : "border-white/10 bg-ink-950/35 hover:border-emerald-400/50"
                    }`}
                  >
                    <span
                      aria-hidden="true"
                      className={`mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-md border text-xs font-bold ${
                        perkOptIn ? "border-emerald-400 bg-emerald-400 text-ink-950" : "border-ink-600 text-transparent"
                      }`}
                    >
                      ✓
                    </span>
                    <span>
                      <span className="block text-sm font-semibold text-white">
                        {availablePerk.label} — <span className="text-emerald-300">included free</span>
                      </span>
                      {availablePerk.note && (
                        <span className="mt-0.5 block text-xs leading-5 text-ink-400">{availablePerk.note}</span>
                      )}
                    </span>
                  </button>
                )}
                {bundleService && (
                  <button
                    type="button"
                    onClick={() => {
                      setBundleServiceId(null);
                      const allowed = new Set(service?.addonIds ?? []);
                      setSelectedAddons(selectedAddons.filter((id) => allowed.has(id)));
                      setSlots(null);
                      setStartMs(null);
                    }}
                    className="mt-3 text-xs font-semibold text-ink-300 underline hover:text-white"
                  >
                    Remove detailing package
                  </button>
                )}
              </section>
            )}
            {eligibleAddons.length === 0 && eligibleBundleOffers.length === 0 && (
              <p className="text-ink-400">No add-ons available for this service.</p>
            )}
            {eligibleAddons.length > 0 && <h3 className="pb-1 text-sm font-semibold text-white">Optional extras</h3>}
            {eligibleAddons.map((a) => {
              const checked = selectedAddons.includes(a.id);
              const priced = addonFor(a, vehicleCategory);
              return (
                <button
                  type="button"
                  key={a.id}
                  aria-pressed={checked}
                  onClick={() => {
                    setSelectedAddons(
                      checked ? selectedAddons.filter((x) => x !== a.id) : [...selectedAddons, a.id],
                    );
                    setDroppedAddons([]);
                    setSlots(null);
                    setStartMs(null);
                  }}
                  className={`flex min-h-11 w-full items-center justify-between gap-4 rounded-2xl border p-4 text-left transition-colors ${focusRing} ${
                    checked ? "border-accent-400 bg-[#0B2A4A]/80" : "border-ink-700 bg-ink-950/40 hover:border-accent-500/60"
                  }`}
                >
                  <div>
                    <p className="font-medium text-white">{a.name}</p>
                    <p className="text-sm text-ink-400">{a.description}</p>
                    {a.qualifier && (
                      <p className="mt-1 text-xs text-ink-500">{a.qualifier}</p>
                    )}
                  </div>
                  <span className="shrink-0 text-accent-300">+{formatCents(priced.priceCents)}</span>
                </button>
              );
            })}
            {/* Nothing on this step is required. "Continue" beside an empty
                selection read as though one had to be made, so the button
                says what it will actually do until something is chosen. */}
            <StepNav
              onBack={() => setStep(1)}
              onNext={() => setStep(3)}
              nextLabel={bundleServiceId || selectedAddons.length > 0 ? "Continue" : "Skip"}
            />
          </div>
        )}

        {step === 3 && (
          <div className="max-w-lg space-y-4">
            <h2 id={`${idPrefix}-booking-step`} className="text-xl font-semibold text-white">
              {dateOnly ? "Choose your appointment date" : "Choose your appointment time"}
            </h2>
            {dateOnly && (
              <p className="rounded-xl border border-accent-500/25 bg-[#0B2A4A]/45 p-4 text-sm leading-6 text-ink-200">
                {DATE_ONLY_BOOKING_NOTICE}
              </p>
            )}
            <div>
              <label htmlFor={`${idPrefix}-date`} className="mb-2 block text-sm font-medium text-ink-200">Choose a date</label>
              <input
                id={`${idPrefix}-date`}
                type="date"
                min={minDate}
                max={maxDate}
                value={dateISO}
                onChange={(e) => {
                  setDateISO(e.target.value);
                  // Nothing to look up when the shop sets the time by hand:
                  // the date carries no capacity, so there are no slots.
                  if (!dateOnly) void loadSlots(e.target.value);
                }}
                className={`min-h-11 w-full rounded-xl border border-ink-600 bg-ink-950/60 px-4 py-2 text-white [color-scheme:dark] sm:w-auto ${focusRing}`}
              />
            </div>
            {!dateOnly && (
            <div aria-live="polite" aria-atomic="true">
            {slotsLoading && <p className="text-ink-300">Checking availability…</p>}
            {slotsError && <p role="alert" className="rounded-xl border border-red-400/30 bg-red-950/30 p-3 text-red-300">{slotsError}</p>}
            {slots && slots.length === 0 && (
              <p className="text-ink-400">
                No openings that day — please try another date.
              </p>
            )}
            {slots && slots.length > 0 && (
              <div role="group" aria-label="Available appointment times" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {slots.map((s) => (
                  <button
                    type="button"
                    key={s.startMs}
                    aria-pressed={startMs === s.startMs}
                    onClick={() => setStartMs(s.startMs)}
                    className={`min-h-11 rounded-xl border px-3 py-2 text-sm transition-colors ${focusRing} ${
                      startMs === s.startMs
                        ? "border-accent-400 bg-accent-400 font-semibold text-ink-950"
                        : "border-ink-700 bg-ink-950/40 text-ink-200 hover:border-accent-500/60"
                    }`}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            )}
            </div>
            )}
            <StepNav
              onBack={() => setStep(2)}
              onNext={() => setStep(4)}
              nextDisabled={dateOnly ? !dateISO : !startMs}
            />
          </div>
        )}

        {step === 4 && (
          <div className="max-w-lg space-y-4">
            <h2 id={`${idPrefix}-booking-step`} className="text-xl font-semibold text-white">Your contact details</h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field id={`${idPrefix}-first-name`} label="First name" required autoComplete="given-name" value={contact.firstName} onChange={(v) => setContact({ ...contact, firstName: v })} />
              <Field id={`${idPrefix}-last-name`} label="Last name" required autoComplete="family-name" value={contact.lastName} onChange={(v) => setContact({ ...contact, lastName: v })} />
              <Field id={`${idPrefix}-email`} label="Email" type="email" autoComplete="email" value={contact.email} onChange={(v) => setContact({ ...contact, email: v })} />
              <Field id={`${idPrefix}-phone`} label="Phone" type="tel" autoComplete="tel" value={contact.phone} onChange={(v) => setContact({ ...contact, phone: v })} />
            </div>
            <div>
              <label htmlFor={`${idPrefix}-notes`} className="mb-2 block text-sm font-medium text-ink-200">Anything we should know?</label>
              <textarea
                id={`${idPrefix}-notes`}
                value={contact.notes}
                onChange={(e) => setContact({ ...contact, notes: e.target.value })}
                rows={3}
                className={`w-full rounded-xl border border-ink-600 bg-ink-950/60 px-4 py-3 text-white placeholder:text-ink-500 ${focusRing}`}
                placeholder="Pet hair, stains, areas of focus…"
              />
            </div>
            <label className={`flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border border-ink-700 bg-ink-950/35 p-3 text-sm text-ink-200 ${focusRing}`}>
              <input
                type="checkbox"
                checked={policiesAccepted}
                onChange={(e) => setPoliciesAccepted(e.target.checked)}
                className="mt-0.5 size-5 shrink-0 accent-[#E0A93B]"
              />
              <span>
                I agree to the{" "}
                <a href="/policies/terms" target="_blank" className="text-accent-300 underline">
                  service terms
                </a>{" "}
                and{" "}
                <a href="/policies/cancellation" target="_blank" className="text-accent-300 underline">
                  cancellation policy
                </a>
                .
              </span>
            </label>
            {result && !result.ok && <p role="alert" aria-live="assertive" className="rounded-xl border border-red-400/30 bg-red-950/30 p-3 text-red-300">{result.error}</p>}
            <div className="flex flex-col gap-3 sm:flex-row">
              <button type="button" onClick={() => setStep(3)} className={`min-h-11 rounded-xl border border-ink-600 px-5 py-3 text-sm text-ink-200 hover:border-accent-400 ${focusRing}`}>
                Back
              </button>
              <button
                onClick={() => void submit()}
                disabled={
                  submitting ||
                  !contact.firstName.trim() ||
                  !contact.lastName.trim() ||
                  (!contact.email.trim() && !contact.phone.trim()) ||
                  !policiesAccepted
                }
                className={`min-h-11 rounded-xl bg-accent-400 px-6 py-3 text-sm font-semibold text-ink-950 shadow-lg shadow-accent-500/15 hover:bg-accent-300 disabled:cursor-not-allowed disabled:opacity-40 ${focusRing}`}
              >
                {submitting
                  ? "Booking…"
                  : offerWithdrawn && preview
                    ? `Confirm at ${formatCents(preview.total)}`
                    : "Confirm Booking"}
              </button>
            </div>
            <p className="text-xs text-ink-500">
              Provide at least an email or phone number so we can confirm your appointment.
            </p>
          </div>
        )}
      </section>

      {/* Summary sidebar */}
      <aside className="lg:sticky lg:top-24 lg:self-start">
        <div className="overflow-hidden rounded-[2rem] border border-accent-500/25 bg-gradient-to-br from-[#0B2A4A] to-ink-950 p-6 shadow-2xl shadow-black/25">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-accent-300">Live estimate</p>
          <h3 className="mt-2 text-xl font-semibold text-white">Your booking</h3>
          {preview?.washApplied && washClaim && (
            <p className="mt-3 rounded-xl border border-emerald-400/40 bg-emerald-950/30 px-3 py-2 text-xs font-semibold text-emerald-200">
              {washClaim.offerLabel} applied — code {washClaim.code}. Book by {washClaim.expiresLabel}.
            </p>
          )}
          {washClaim && !preview?.washApplied && !offerWithdrawn && service && (
            <p className="mt-3 rounded-xl border border-amber-400/30 bg-amber-950/20 px-3 py-2 text-xs text-amber-200">
              {service.slug === washClaim.serviceSlug
                ? "Your offer does not cover this vehicle type, so the regular price is shown."
                : `Your ${washClaim.offerLabel} applies to the basic wash, so it does not come off this service.`}
            </p>
          )}
          {claimsOffer && serviceQualifies && (
            <p className="mt-3 rounded-xl border border-emerald-400/30 bg-emerald-950/25 px-3 py-2 text-xs font-medium text-emerald-200">
              Your {promo!.percentOffBp / 100}% campaign offer is active. We always apply the better saving if a bundle offer also qualifies.
            </p>
          )}
          {bundleService && preview?.bundleApplied && (
            <p className="mt-3 rounded-xl border border-accent-400/35 bg-accent-400/10 px-3 py-2 text-xs font-semibold text-accent-200">
              {preview.discountLabel} applied automatically.
            </p>
          )}
          {droppedAddons.length > 0 && (
            <p role="status" className="mt-3 rounded-xl border border-amber-400/30 bg-amber-950/20 px-3 py-2 text-xs text-amber-200">
              {droppedAddons.join(", ")} {droppedAddons.length === 1 ? "was" : "were"} removed because
              {droppedAddons.length === 1 ? " it is" : " they are"} tied to your previous selection.
              Nothing has been booked — the total below is up to date.
            </p>
          )}
          {!service && <p className="mt-3 text-sm text-ink-500">Select a service to begin.</p>}
          {service && quoteOnlyVehicle && (
            <p className="mt-3 text-sm leading-6 text-ink-400">
              Commercial vehicles are priced by quote, so there is no online estimate for one.
            </p>
          )}
          {service && preview && (
            <div className="mt-4 space-y-2 text-sm">
              <Row
                label={service.name}
                value={
                  <PricePair
                    currentCents={preview.serviceLines[0].priceCents}
                    compareAtCents={
                      service.compareAtPriceCents === null
                        ? null
                        : service.compareAtPriceCents + (service.adjustments[vehicleCategory]?.priceDeltaCents ?? 0)
                    }
                  />
                }
              />
              {bundleService && preview.serviceLines[1] && (
                <Row
                  label={publicServiceName(bundleService)}
                  value={formatCents(preview.serviceLines[1].priceCents)}
                />
              )}
              {selectedAddons.map((id) => {
                const a = addons.find((x) => x.id === id);
                if (!a) return null;
                return (
                  <Row
                    key={id}
                    label={a.name}
                    value={`+${formatCents(addonFor(a, vehicleCategory).priceCents)}`}
                  />
                );
              })}
              <div className="my-2 border-t border-ink-700" />
              {perkOptIn && availablePerk && (
                <Row label={availablePerk.label} value="Included" tone="saving" />
              )}
              <Row label="Subtotal" value={formatCents(preview.subtotal)} />
              {preview.discount > 0 && (
                <Row
                  label={preview.discountLabel ?? "Offer saving"}
                  value={`−${formatCents(preview.discount)}`}
                  tone="saving"
                />
              )}
              <Row label={taxLabel} value={formatCents(preview.tax)} />
              <div aria-live="polite" className="flex justify-between font-semibold text-white">
                <span>Estimated total</span>
                <span className="text-accent-300">{formatCents(preview.total)}</span>
              </div>
              {claimsOffer && !serviceQualifies && (
                <p className="rounded-xl border border-ink-700 bg-ink-950/50 p-3 text-xs text-ink-300">
                  The {promo!.label} applies to our detailing packages, so it doesn&apos;t come off
                  this service.
                </p>
              )}
              {offerWithdrawn && (
                <p className="rounded-xl border border-amber-400/30 bg-amber-950/20 p-3 text-xs text-amber-200">
                  {result && !result.ok && result.kind === "offer_changed"
                    ? result.error
                    : `The ${promo?.label ?? "offer"} is for first-time customers, so it doesn't apply to this booking.`}{" "}
                  Nothing has been booked yet — the total above is what you&apos;ll pay.
                </p>
              )}
              {selectedAddons
                .map((id) => addons.find((a) => a.id === id))
                .filter((a): a is WizardAddon => !!a?.qualifier)
                .map((a) => (
                  <p key={a.id} className="rounded-xl border border-ink-700 bg-ink-950/50 p-3 text-xs text-ink-300">
                    {a.qualifier}
                  </p>
                ))}
              {service.conditionNotice && (
                <p className="rounded-xl border border-ink-700 bg-ink-950/50 p-3 text-xs text-ink-300">
                  {service.conditionNotice}
                </p>
              )}
              {/* Hours of work read like a collection time, which is a promise
                  a hand-sequenced coating day cannot keep — so a coating shows
                  the price line alone and the arrangement promise below it. */}
              <p className="pt-2 text-xs text-ink-500">
                {!service.hideDuration &&
                  `Approx. ${Math.floor(preview.duration / 60)}h${preview.duration % 60 ? ` ${preview.duration % 60}m` : ""} of work. `}
                Final price confirmed at drop-off.
              </p>
              {dateOnly && (
                <p className="text-xs text-ink-500">{DATE_ONLY_BOOKING_NOTICE_SHORT}</p>
              )}
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}

function Field({
  id,
  label,
  value,
  onChange,
  placeholder,
  type = "text",
  required = false,
  autoComplete,
  inputMode,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  required?: boolean;
  autoComplete?: string;
  inputMode?: React.HTMLAttributes<HTMLInputElement>["inputMode"];
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-2 block text-sm font-medium text-ink-200">{label}{required ? " *" : ""}</label>
      <input
        id={id}
        type={type}
        required={required}
        autoComplete={autoComplete}
        inputMode={inputMode}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className={`min-h-11 w-full rounded-xl border border-ink-600 bg-ink-950/60 px-4 py-2.5 text-white placeholder:text-ink-500 ${focusRing}`}
      />
    </div>
  );
}

function StepNav({
  onBack,
  onNext,
  nextDisabled,
  nextLabel = "Continue",
}: {
  onBack: () => void;
  onNext: () => void;
  nextDisabled?: boolean;
  /** "Continue" everywhere the step is required; see the optional package step. */
  nextLabel?: string;
}) {
  return (
    <div className="flex flex-col gap-3 pt-3 sm:flex-row">
      <button type="button" onClick={onBack} className={`min-h-11 rounded-xl border border-ink-600 px-5 py-3 text-sm text-ink-200 hover:border-accent-400 ${focusRing}`}>
        Back
      </button>
      <button
        type="button"
        onClick={onNext}
        disabled={nextDisabled}
        className={`min-h-11 rounded-xl bg-accent-400 px-6 py-3 text-sm font-semibold text-ink-950 shadow-lg shadow-accent-500/15 hover:bg-accent-300 disabled:cursor-not-allowed disabled:opacity-40 ${focusRing}`}
      >
        {nextLabel}
      </button>
    </div>
  );
}

function Row({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: ReactNode;
  tone?: "default" | "saving";
}) {
  return (
    <div className={`flex justify-between ${tone === "saving" ? "text-emerald-300" : "text-ink-300"}`}>
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}

function PricePair({ currentCents, compareAtCents }: { currentCents: number; compareAtCents: number | null }) {
  return (
    <span className="text-right">
      {compareAtCents !== null && (
        <span className="mr-2 text-xs text-ink-500 line-through">{formatCents(compareAtCents)}</span>
      )}
      <span>{formatCents(currentCents)}</span>
    </span>
  );
}

/**
 * The same customer-facing name the rest of the public site uses, so a bundle
 * option is never labelled differently here than it is on /services. Falls
 * back to the catalogue row, which the owners edit in Admin.
 */
function publicServiceName(service: WizardService): string {
  return SERVICE_PRESENTATION[service.slug]?.publicName ?? service.name;
}
