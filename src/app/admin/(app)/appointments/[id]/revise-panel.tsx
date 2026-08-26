"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { formatCents } from "@/lib/money";
import { reviseAppointmentLinesAction } from "../actions";

type ServiceOption = {
  id: string;
  name: string;
  categoryName: string;
  basePriceCents: number;
  addonIds: string[];
};
type AddonOption = { id: string; name: string; priceCents: number };
type CustomLine = { description: string; priceCents: number; durationMin: number };

/**
 * "Change packages" — the customer moved up or down after booking.
 *
 * The prices shown here are catalog base prices, NOT what the customer will be
 * charged: the server re-prices every line for this vehicle's size when the
 * revision is saved. The panel says so rather than showing a figure that
 * quietly disagrees with the invoice.
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
  currency: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [serviceIds, setServiceIds] = useState<string[]>(initialServiceIds);
  const [addonIds, setAddonIds] = useState<string[]>(initialAddonIds);
  const [customLines, setCustomLines] = useState<CustomLine[]>(initialCustomLines);
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
      customLines,
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

  const canSubmit = reason.trim().length > 0 && serviceIds.length + customLines.length > 0;

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
            For a customer who moved up or down a package after booking. Prices below are catalog
            base prices — the final amount is re-calculated for this vehicle&rsquo;s size on save.
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
                    <span className="text-ink-400">{formatCents(service.basePriceCents, currency)}</span>
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
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  value={(line.priceCents / 100).toFixed(2)}
                  onChange={(e) =>
                    setCustomLines((prev) =>
                      prev.map((l, j) =>
                        j === i ? { ...l, priceCents: Math.round(Number(e.target.value) * 100) || 0 } : l,
                      ),
                    )
                  }
                  className="w-28 rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-sm text-white"
                />
                <input
                  type="number"
                  min={0}
                  value={line.durationMin}
                  onChange={(e) =>
                    setCustomLines((prev) =>
                      prev.map((l, j) => (j === i ? { ...l, durationMin: Number(e.target.value) || 0 } : l)),
                    )
                  }
                  className="w-24 rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-sm text-white"
                  title="Minutes"
                />
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
                setCustomLines((prev) => [...prev, { description: "", priceCents: 0, durationMin: 60 }])
              }
              className="mt-2 rounded-lg border border-ink-700 px-3 py-2 text-xs text-ink-200"
            >
              Add custom line
            </button>
          </div>

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
