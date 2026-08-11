"use client";

import { useState } from "react";
import type { BusinessSettings } from "@/lib/settings";
import { formatHHMM12 } from "@/lib/tz";
import { updateSettingsAction, updateBusinessHoursAction } from "./actions";

export type DayHours = {
  weekday: number;
  closed: boolean;
  open: string | null;
  close: string | null;
};

const WEEKDAY_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Comma or newline separated recipients -> trimmed, de-duplicated list. */
function splitList(raw: string): string[] {
  return [...new Set(raw.split(/[,\n]/).map((part) => part.trim()).filter(Boolean))];
}
const CLOCK_OPTIONS = Array.from({ length: 96 }, (_, index) => {
  const minutes = index * 15;
  const value = `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  return { value, label: formatHHMM12(value) };
});

export type PromotableService = { id: string; name: string; categoryName: string };

export function SettingsForm({
  initial,
  promotableServices = [],
}: {
  initial: BusinessSettings;
  promotableServices?: PromotableService[];
}) {
  const [form, setForm] = useState({
    businessName: initial.businessName,
    legalEntityName: initial.legalEntityName,
    addressLine1: initial.addressLine1,
    city: initial.city,
    province: initial.province,
    postalCode: initial.postalCode,
    phone: initial.phone,
    email: initial.email,
    googleReviewUrl: initial.googleReviewUrl,
    taxRatePct: (initial.taxRateBp / 100).toFixed(2),
    taxRegistrationNumber: initial.taxRegistrationNumber,
    slotGranularityMin: String(initial.slotGranularityMin),
    setupBufferMin: String(initial.setupBufferMin),
    cleanupBufferMin: String(initial.cleanupBufferMin),
    minBookingNoticeHours: String(initial.minBookingNoticeHours),
    maxBookingWindowDays: String(initial.maxBookingWindowDays),
    cancellationNoticeHours: String(initial.cancellationNoticeHours),
    reminderLeadHours: String(initial.reminderLeadHours),
    reviewRequestDelayHours: String(initial.reviewRequestDelayHours),
    maintenanceReminderMonths: String(initial.maintenanceReminderMonths),
    // Comma-separated in the UI, split into arrays on save.
    staffNotifyPhones: initial.staffNotifyPhones.join(", "),
    staffNotifyEmails: initial.staffNotifyEmails.join(", "),
    // Percent in the UI, basis points on save — same convention as the tax rate.
    promoPercent: (initial.promotion.percentOffBp / 100).toFixed(2),
    promoCode: initial.promotion.code,
    promoLabel: initial.promotion.label,
    promoExpiresOn: initial.promotion.expiresOn,
  });
  const [notifyOnNewAppointment, setNotifyOnNewAppointment] = useState(initial.notifyOnNewAppointment);
  const [promoEnabled, setPromoEnabled] = useState(initial.promotion.enabled);
  const [promoFirstTimeOnly, setPromoFirstTimeOnly] = useState(initial.promotion.firstTimeOnly);
  const [promoServiceIds, setPromoServiceIds] = useState<string[]>(initial.promotion.eligibleServiceIds);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    const res = await updateSettingsAction({
      businessName: form.businessName,
      legalEntityName: form.legalEntityName,
      addressLine1: form.addressLine1,
      city: form.city,
      province: form.province,
      postalCode: form.postalCode,
      phone: form.phone,
      email: form.email,
      googleReviewUrl: form.googleReviewUrl,
      taxRateBp: Math.round(Number(form.taxRatePct) * 100),
      taxRegistrationNumber: form.taxRegistrationNumber,
      slotGranularityMin: Number(form.slotGranularityMin),
      setupBufferMin: Number(form.setupBufferMin),
      cleanupBufferMin: Number(form.cleanupBufferMin),
      minBookingNoticeHours: Number(form.minBookingNoticeHours),
      maxBookingWindowDays: Number(form.maxBookingWindowDays),
      cancellationNoticeHours: Number(form.cancellationNoticeHours),
      reminderLeadHours: Number(form.reminderLeadHours),
      reviewRequestDelayHours: Number(form.reviewRequestDelayHours),
      maintenanceReminderMonths: Number(form.maintenanceReminderMonths),
      notifyOnNewAppointment,
      staffNotifyPhones: splitList(form.staffNotifyPhones),
      staffNotifyEmails: splitList(form.staffNotifyEmails),
      promotion: {
        enabled: promoEnabled,
        code: form.promoCode.trim().toUpperCase(),
        label: form.promoLabel.trim(),
        percentOffBp: Math.round(Number(form.promoPercent) * 100),
        expiresOn: form.promoExpiresOn,
        firstTimeOnly: promoFirstTimeOnly,
        eligibleServiceIds: promoServiceIds,
      },
    });
    setBusy(false);
    setMsg(res.ok ? { ok: true, text: "Settings saved." } : { ok: false, text: res.error });
  }

  const input = "w-full rounded-lg border border-ink-600 bg-ink-950 px-3 py-2 text-sm text-white";
  const label = "mb-1 block text-xs text-ink-400";

  function field(key: keyof typeof form, title: string, props: Record<string, unknown> = {}) {
    return (
      <label className="block">
        <span className={label}>{title}</span>
        <input
          className={input}
          value={form[key]}
          onChange={(e) => setForm({ ...form, [key]: e.target.value })}
          {...props}
        />
      </label>
    );
  }

  return (
    <form onSubmit={save} className="mt-8 space-y-8">
      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-ink-300">Identity</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          {field("businessName", "Business name")}
          {field("legalEntityName", "Legal entity (appears on invoices)")}
          {field("phone", "Phone *")}
          {field("email", "Email *")}
          {field("addressLine1", "Street address")}
          {field("city", "City")}
          {field("province", "Province")}
          {field("postalCode", "Postal code")}
          {field("googleReviewUrl", "Google review link")}
        </div>
      </section>
      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-ink-300">Tax</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          {field("taxRatePct", "Tax rate % (Ontario HST = 13)")}
          {field("taxRegistrationNumber", "HST registration number *")}
        </div>
      </section>
      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-ink-300">Promotion</h2>
        <label className="flex items-center gap-2 text-sm text-ink-200">
          <input
            type="checkbox"
            checked={promoEnabled}
            onChange={(e) => setPromoEnabled(e.target.checked)}
          />
          Run an automatic offer for visitors arriving from an ad
        </label>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {field("promoLabel", "Customer-facing label", { placeholder: "First Detail Offer" })}
          {field("promoPercent", "Percent off (10 = 10%)")}
          {field("promoCode", "Offer code for the ad URL", { placeholder: "FIRST10AUG26" })}
          {field("promoExpiresOn", "Expires on (blank = no expiry)", { type: "date" })}
        </div>
        <label className="mt-3 flex items-center gap-2 text-sm text-ink-200">
          <input
            type="checkbox"
            checked={promoFirstTimeOnly}
            onChange={(e) => setPromoFirstTimeOnly(e.target.checked)}
          />
          First-time customers only (no completed detail with us yet)
        </label>

        <fieldset className="mt-4">
          <legend className="mb-2 text-xs text-ink-400">
            Services the offer applies to — nothing is discounted until you tick something
          </legend>
          {promotableServices.length === 0 ? (
            <p className="text-xs text-ink-500">No bookable services found.</p>
          ) : (
            <div className="grid gap-1.5 sm:grid-cols-2">
              {promotableServices.map((service) => {
                const on = promoServiceIds.includes(service.id);
                return (
                  <label key={service.id} className="flex items-start gap-2 text-sm text-ink-200">
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={on}
                      onChange={() =>
                        setPromoServiceIds(
                          on
                            ? promoServiceIds.filter((id) => id !== service.id)
                            : [...promoServiceIds, service.id],
                        )
                      }
                    />
                    <span>
                      {service.name}
                      <span className="block text-xs text-ink-500">{service.categoryName}</span>
                    </span>
                  </label>
                );
              })}
            </div>
          )}
        </fieldset>

        {promoEnabled && (
          <div className="mt-4 rounded-lg border border-ink-700 bg-ink-950/60 p-3 text-xs text-ink-300">
            <p>
              Point the ad at{" "}
              <code className="text-accent-300">
                /book?offer={form.promoCode.trim().toUpperCase() || "CODE"}
              </code>
              . Customers never type it — the discount applies by itself.
            </p>
            {promoServiceIds.length > 0 && (
              <p className="mt-1">
                Customers will see <span className="text-emerald-300">
                  {form.promoLabel || "the offer"} −{form.promoPercent || "0"}%
                </span>{" "}
                on {promoServiceIds.length} service{promoServiceIds.length === 1 ? "" : "s"}.
              </p>
            )}
            {Number(form.promoPercent) > 25 && (
              <p className="mt-1 text-amber-300">
                {Number(form.promoPercent) >= 100
                  ? "At 100% the total is zero, which also removes any deposit requirement."
                  : "That is a steep discount — double-check the percentage."}
              </p>
            )}
            {form.promoExpiresOn && (
              <p className="mt-1 text-amber-300">
                Meta and Google will keep running the ad after {form.promoExpiresOn}. Pause the ad set
                the same day you let this expire.
              </p>
            )}
          </div>
        )}
        <p className="mt-2 text-xs text-ink-500">
          Only ticked services get the discount — a service added later is never included
          automatically. Changing any of this never affects bookings already taken: every booking
          locks its discount amount at the time it was made. Use a campaign-specific code
          (FIRST10AUG26, not FIRST10) and never re-use a retired one — changing the code is what
          stops old ad links from being honoured.
        </p>
      </section>
      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-ink-300">Booking rules</h2>
        <div className="grid gap-3 sm:grid-cols-3">
          {field("slotGranularityMin", "Slot granularity (min)")}
          {field("setupBufferMin", "Setup buffer (min)")}
          {field("cleanupBufferMin", "Cleanup buffer (min)")}
          {field("minBookingNoticeHours", "Min notice (hours)")}
          {field("maxBookingWindowDays", "Booking window (days)")}
          {field("cancellationNoticeHours", "Cancellation notice (hours)")}
        </div>
      </section>
      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-ink-300">Staff alerts</h2>
        <label className="flex items-center gap-2 text-sm text-ink-200">
          <input
            type="checkbox"
            checked={notifyOnNewAppointment}
            onChange={(e) => setNotifyOnNewAppointment(e.target.checked)}
          />
          Text and email us whenever a new appointment is booked
        </label>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {field("staffNotifyPhones", "Alert phone numbers (comma separated)", {
            placeholder: "+19055550143, +19055550144",
          })}
          {field("staffNotifyEmails", "Alert email addresses (comma separated)", {
            placeholder: "owner@example.com, manager@example.com",
          })}
        </div>
        <p className="mt-2 text-xs text-ink-500">
          Add one entry per person — the manager account is often shared, so each phone listed here
          gets its own text. Delivery needs SMS or email credentials set up under Integrations.
        </p>
      </section>
      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-ink-300">Automated messages</h2>
        <div className="grid gap-3 sm:grid-cols-3">
          {field("reminderLeadHours", "Appointment reminder lead time (hours)")}
          {field("reviewRequestDelayHours", "Review request delay after payment (hours)")}
          {field("maintenanceReminderMonths", "Maintenance reminder interval (months)")}
        </div>
        <p className="mt-2 text-xs text-ink-500">
          These sends only fire from the scheduled task (see /api/cron/tick) — there&apos;s no
          on-page trigger, so a scheduler must call that endpoint periodically for them to go out.
          Review requests and maintenance reminders only go to customers who&apos;ve given
          marketing consent.
        </p>
      </section>
      {msg && <p className={msg.ok ? "text-sm text-emerald-300" : "text-sm text-red-400"}>{msg.text}</p>}
      <button
        type="submit"
        disabled={busy}
        className="rounded-lg bg-accent-400 px-6 py-3 text-sm font-semibold text-ink-950 hover:bg-accent-300 disabled:opacity-40"
      >
        {busy ? "Saving…" : "Save Settings"}
      </button>
    </form>
  );
}

export function BusinessHoursForm({ initialHours }: { initialHours: DayHours[] }) {
  const [hours, setHours] = useState<DayHours[]>(
    [...initialHours].sort((a, b) => a.weekday - b.weekday),
  );
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  function setDay(weekday: number, patch: Partial<DayHours>) {
    setHours((prev) => prev.map((d) => (d.weekday === weekday ? { ...d, ...patch } : d)));
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    const res = await updateBusinessHoursAction(
      hours.map((d) => ({
        weekday: d.weekday,
        closed: d.closed,
        open: d.closed ? null : d.open,
        close: d.closed ? null : d.close,
      })),
    );
    setBusy(false);
    setMsg(res.ok ? { ok: true, text: "Hours saved." } : { ok: false, text: res.error });
  }

  const input = "rounded-lg border border-ink-600 bg-ink-950 px-2 py-1.5 text-sm text-white";

  return (
    <form onSubmit={save} className="mt-10 space-y-4">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-300">Business hours</h2>
      <div className="space-y-2">
        {hours.map((d) => (
          <div key={d.weekday} className="flex items-center gap-3 text-sm">
            <span className="w-24 text-ink-300">{WEEKDAY_LABELS[d.weekday]}</span>
            <label className="flex items-center gap-1.5 text-xs text-ink-400">
              <input
                type="checkbox"
                checked={d.closed}
                onChange={(e) => setDay(d.weekday, { closed: e.target.checked })}
              />
              Closed
            </label>
            {!d.closed && (
              <>
                <select
                  aria-label={`${WEEKDAY_LABELS[d.weekday]} opening time`}
                  className={input}
                  value={d.open ?? "09:00"}
                  onChange={(e) => setDay(d.weekday, { open: e.target.value })}
                >
                  {CLOCK_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
                <span className="text-ink-500">to</span>
                <select
                  aria-label={`${WEEKDAY_LABELS[d.weekday]} closing time`}
                  className={input}
                  value={d.close ?? "17:00"}
                  onChange={(e) => setDay(d.weekday, { close: e.target.value })}
                >
                  {CLOCK_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </>
            )}
          </div>
        ))}
      </div>
      {msg && <p className={msg.ok ? "text-sm text-emerald-300" : "text-sm text-red-400"}>{msg.text}</p>}
      <button
        type="submit"
        disabled={busy}
        className="rounded-lg bg-accent-400 px-6 py-3 text-sm font-semibold text-ink-950 hover:bg-accent-300 disabled:opacity-40"
      >
        {busy ? "Saving…" : "Save Hours"}
      </button>
    </form>
  );
}
