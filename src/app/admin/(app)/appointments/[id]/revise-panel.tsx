"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { formatCents } from "@/lib/money";
import { reviseAppointmentLinesAction } from "../actions";

type ServiceOption = {
  id: string;
  name: string;
  categoryName: string;
  /**
   * What this package costs for THIS booking's vehicle — the catalogue base
   * price plus the size delta — not the sedan base price. See the panel's
   * doc comment.
   */
  priceCents: number;
  addonIds: string[];
};
/** Same rule for an add-on: priced for this vehicle's size, not from base. */
type AddonOption = { id: string; name: string; priceCents: number };

/**
 * A custom line while it is being edited. The price and the duration are held
 * as the raw strings staff are typing, NOT as cents.
 *
 * This matters: the price field used to be a controlled number input whose
 * value was re-derived as `(priceCents / 100).toFixed(2)` on every keystroke.
 * Typing "250" put the caret behind a freshly-inserted ".00" after the first
 * digit, so the field could only realistically be driven with the spinner
 * arrows — one cent at a time. Keeping the text staff typed and converting on
 * submit is the same pattern the invoice builder uses.
 */
type CustomLineDraft = { description: string; price: string; durationMin: string };

type CustomLine = { description: string; priceCents: number; durationMin: number };

function toCents(dollars: string): number {
  const value = Number(dollars);
  return Number.isFinite(value) && value > 0 ? Math.round(value * 100) : 0;
}

function toMinutes(value: string): number {
  const minutes = Number(value);
  return Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes) : 0;
}

/**
 * "Change packages" — the customer moved up or down after booking.
 *
 * Every price on this panel is the price for the vehicle on the booking. It
 * used to show catalogue base prices with a note explaining that the real
 * figure was worked out on save, which in practice meant staff re-pricing a
 * large SUV read sedan money on screen and had no way to check the change
 * before committing it. The server still re-prices from the catalogue on save —
 * it is the only authority — but it now arrives at the same numbers shown here.
 */
export function RevisePanel({
  appointmentId,
  services,
  addons,
  initialServiceIds,
  initialAddonIds,
  initialCustomLines,
  currentDiscountCents,
  promoLabel,
  vehicleLabel,
  currency,
}: {
  appointmentId: string;
  services: ServiceOption[];
  addons: AddonOption[];
  initialServiceIds: string[];
  initialAddonIds: string[];
  initialCustomLines: CustomLine[];
  currentDiscountCents: number;
  promoLabel: string | null;
  /** Size the prices are for, e.g. "Large SUV". Null when no vehicle is on file. */
  vehicleLabel: string | null;
  currency: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [serviceIds, setServiceIds] = useState<string[]>(initialServiceIds);
  const [addonIds, setAddonIds] = useState<string[]>(initialAddonIds);
  const [customLines, setCustomLines] = useState<CustomLineDraft[]>(() =>
    initialCustomLines.map((line) => ({
      description: line.description,
      price: (line.priceCents / 100).toFixed(2),
      durationMin: String(line.durationMin),
    })),
  );
  const [discountMode, setDiscountMode] = useState<"reapply" | "keep" | "remove">("reapply");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [overlapWarnings, setOverlapWarnings] = useState<string[] | null>(null);
  const [done, setDone] = useState<string[] | null>(null);

  // Add-ons are only offered by the services actually selected, mirroring the
  // rule priceBooking enforces server-side.
  const availableAddons = useMemo(() => {
    const allowed = new Set(services.filter((s) => serviceIds.includes(s.id)).flatMap((s) => s.addonIds));
    return addons.filter((addon) => allowed.has(addon.id));
  }, [services, addons, serviceIds]);

  const grouped = useMemo(() => {
    const map = new Map<string, ServiceOption[]>();
    for (const service of services) {
      map.set(service.categoryName, [...(map.get(service.categoryName) ?? []), service]);
    }
    return [...map.entries()];
  }, [services]);

  /**
   * The custom lines as the server will see them. A row that is still entirely
   * blank is dropped rather than sent: staff press "Add custom line", change
   * their mind, and an empty description is rejected by the action with a
   * message about the packages that explains nothing.
   */
  const submittedCustomLines = useMemo(
    () =>
      customLines
        .map((line) => ({
          description: line.description.trim(),
          priceCents: toCents(line.price),
          durationMin: toMinutes(line.durationMin),
        }))
        .filter((line) => line.description !== "" || line.priceCents > 0),
    [customLines],
  );

  /**
   * What the selection adds up to, before the discount and tax the server
   * settles. Shown because the whole point of a counter re-price is that staff
   * can see what they are about to bill — and because an SUV total that reads
   * as sedan money is exactly the mistake this panel used to invite.
   */
  const newSubtotalCents = useMemo(() => {
    const selected = [
      ...services.filter((service) => serviceIds.includes(service.id)),
      ...addons.filter((addon) => addonIds.includes(addon.id)),
    ].reduce((sum, item) => sum + item.priceCents, 0);
    return submittedCustomLines.reduce((sum, line) => sum + line.priceCents, selected);
  }, [services, addons, serviceIds, addonIds, submittedCustomLines]);

  function toggleService(id: string) {
    setServiceIds((prev) => {
      const next = prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id].slice(0, 5);
      // Drop add-ons whose parent service just left the cart, so the form can
      // never submit a combination the server will reject.
      const allowed = new Set(services.filter((s) => next.includes(s.id)).flatMap((s) => s.addonIds));
      setAddonIds((current) => current.filter((addonId) => allowed.has(addonId)));
      return next;
    });
  }

  async function submit(confirmOverlap: boolean) {
    setBusy(true);
    setError(null);
    setOverlapWarnings(null);
    const result = await reviseAppointmentLinesAction({
      appointmentId,
      serviceIds,
      addonIds,
      customLines: submittedCustomLines,
      discountMode,
      reason,
      confirmOverlap,
    });
    setBusy(false);
    if (!result.ok) {
      if ("needsOverlapConfirm" in result) return setOverlapWarnings(result.warnings);
      return setError(result.error);
    }
    setDone(result.warnings);
    router.refresh();
  }

  const canSubmit =
    reason.trim().length > 0 && serviceIds.length + submittedCustomLines.length > 0;

  return (
    <section className="mt-4 rounded-xl border border-ink-800 p-4">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="text-sm font-medium text-accent-300 hover:underline"
      >
        {open ? "Close package change" : "Change packages"}
      </button>
      {open && (
        <div className="mt-4">
          <p className="text-xs text-ink-500">
            For a customer who moved up or down a package after booking.{" "}
            {vehicleLabel
              ? `Prices are for this ${vehicleLabel} — the size on the booking.`
              : "No vehicle is on the booking, so prices are the base ones; add the vehicle to price for its size."}
          </p>

          {grouped.map(([category, options]) => (
            <div key={category} className="mt-4">
              <p className="text-xs font-semibold uppercase tracking-wider text-ink-500">{category}</p>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {options.map((service) => (
                  <label
                    key={service.id}
                    className="flex items-center justify-between gap-3 rounded-lg border border-ink-700 px-3 py-2 text-sm text-ink-200"
                  >
                    <span className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={serviceIds.includes(service.id)}
                        onChange={() => toggleService(service.id)}
                        className="accent-accent-400"
                      />
                      {service.name}
                    </span>
                    <span className="text-ink-400">{formatCents(service.priceCents, currency)}</span>
                  </label>
                ))}
              </div>
            </div>
          ))}

          {availableAddons.length > 0 && (
            <div className="mt-4">
              <p className="text-xs font-semibold uppercase tracking-wider text-ink-500">Add-ons</p>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {availableAddons.map((addon) => (
                  <label
                    key={addon.id}
                    className="flex items-center justify-between gap-3 rounded-lg border border-ink-700 px-3 py-2 text-sm text-ink-200"
                  >
                    <span className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={addonIds.includes(addon.id)}
                        onChange={() =>
                          setAddonIds((prev) =>
                            prev.includes(addon.id)
                              ? prev.filter((a) => a !== addon.id)
                              : [...prev, addon.id],
                          )
                        }
                        className="accent-accent-400"
                      />
                      {addon.name}
                    </span>
                    <span className="text-ink-400">{formatCents(addon.priceCents, currency)}</span>
                  </label>
                ))}
              </div>
            </div>
          )}

          {/*
            Custom lines are prefilled from the booking. A coating quoted at the
            counter has no catalog row, so if this panel did not carry them
            forward a revision would silently delete work the shop is doing.
          */}
          <div className="mt-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-ink-500">
              Custom lines (quote-only work)
            </p>
            {customLines.map((line, i) => (
              <div key={i} className="mt-2 flex flex-wrap items-end gap-2">
                <input
                  value={line.description}
                  onChange={(e) =>
                    setCustomLines((prev) =>
                      prev.map((l, j) => (j === i ? { ...l, description: e.target.value } : l)),
                    )
                  }
                  placeholder="Description"
                  className="min-w-[12rem] flex-1 rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-sm text-white"
                />
                <label className="block">
                  <span className="mb-1 block text-[0.7rem] text-ink-500">Price ($)</span>
                  <input
                    inputMode="decimal"
                    value={line.price}
                    onChange={(e) =>
                      setCustomLines((prev) =>
                        prev.map((l, j) => (j === i ? { ...l, price: e.target.value } : l)),
                      )
                    }
                    placeholder="0.00"
                    className="w-28 rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-sm text-white"
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-[0.7rem] text-ink-500">Minutes</span>
                  <input
                    inputMode="numeric"
                    value={line.durationMin}
                    onChange={(e) =>
                      setCustomLines((prev) =>
                        prev.map((l, j) => (j === i ? { ...l, durationMin: e.target.value } : l)),
                      )
                    }
                    placeholder="60"
                    className="w-24 rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-sm text-white"
                  />
                </label>
                <button
                  type="button"
                  onClick={() => setCustomLines((prev) => prev.filter((_, j) => j !== i))}
                  className="rounded-lg border border-ink-700 px-3 py-2 text-sm text-ink-300"
                >
                  Remove
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() =>
                setCustomLines((prev) => [...prev, { description: "", price: "", durationMin: "60" }])
              }
              className="mt-2 rounded-lg border border-ink-700 px-3 py-2 text-xs text-ink-200"
            >
              Add custom line
            </button>
          </div>

          <p className="mt-4 text-sm text-ink-300">
            New subtotal:{" "}
            <span className="font-semibold text-white">{formatCents(newSubtotalCents, currency)}</span>
            <span className="text-ink-500"> — before discount and tax</span>
          </p>

          {currentDiscountCents > 0 && (
            <div className="mt-4 rounded-lg border border-emerald-900/50 p-3">
              <p className="text-xs font-semibold uppercase tracking-wider text-emerald-300">
                {promoLabel ?? "Discount"} — {formatCents(currentDiscountCents, currency)} locked at booking
              </p>
              <div className="mt-2 grid gap-1 text-sm text-ink-200">
                {(
                  [
                    ["reapply", "Re-apply the offer to the new package"],
                    ["keep", `Keep ${formatCents(currentDiscountCents, currency)} as goodwill`],
                    ["remove", "Remove the discount"],
                  ] as const
                ).map(([mode, label]) => (
                  <label key={mode} className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="discountMode"
                      checked={discountMode === mode}
                      onChange={() => setDiscountMode(mode)}
                      className="accent-accent-400"
                    />
                    {label}
                  </label>
                ))}
              </div>
              <p className="mt-2 text-xs text-ink-500">
                Re-applying gives the same percentage of the new price. If the new package is not on
                the offer, the discount becomes nil.
              </p>
            </div>
          )}

          <label className="mt-4 block text-sm text-ink-300">
            Reason (recorded on the invoice and in the audit log)
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Customer upgraded at the counter"
              className="mt-1 block w-full rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-sm text-white"
            />
          </label>

          {error && <p className="mt-3 text-sm text-red-300">{error}</p>}

          {overlapWarnings && (
            <div className="mt-3 rounded-lg border border-amber-800/60 p-3">
              {overlapWarnings.map((warning) => (
                <p key={warning} className="text-sm text-amber-300">
                  {warning}
                </p>
              ))}
              <button
                type="button"
                onClick={() => void submit(true)}
                disabled={busy}
                className="mt-2 rounded-lg border border-amber-500 px-4 py-2 text-sm font-semibold text-amber-200 disabled:opacity-40"
              >
                Change anyway
              </button>
            </div>
          )}

          {done && (
            <div className="mt-3 rounded-lg border border-emerald-800/60 p-3">
              <p className="text-sm text-emerald-300">Packages updated.</p>
              {done.map((warning) => (
                <p key={warning} className="mt-1 text-sm text-amber-300">
                  {warning}
                </p>
              ))}
            </div>
          )}

          <button
            type="button"
            onClick={() => void submit(false)}
            disabled={busy || !canSubmit}
            className="mt-4 rounded-lg bg-accent-400 px-4 py-2 text-sm font-semibold text-ink-950 disabled:opacity-40"
          >
            {busy ? "Saving…" : "Save package change"}
          </button>
          <p className="mt-2 text-xs text-ink-500">
            Do this before recording payment. Once a payment lands the invoice is no longer a draft
            and the packages can no longer be changed.
          </p>
        </div>
      )}
    </section>
  );
}
