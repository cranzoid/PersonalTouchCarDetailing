"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { VEHICLE_CATEGORIES, VEHICLE_CATEGORY_LABELS } from "@/lib/types";
import {
  addCustomerVehicleAction,
  anonymizeCustomerAction,
  issueCustomerPortalLinkAction,
  updateCustomerAction,
} from "../actions";

const inputClass = "rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-sm text-white placeholder:text-ink-600";

export function CustomerActionPanels({
  customer,
}: {
  customer: {
    id: string;
    firstName: string;
    lastName: string;
    email: string | null;
    phone: string | null;
    preferredContact: string;
    customerType: string;
    companyName: string | null;
    tags: string[];
    notes: string | null;
    marketingConsent: boolean;
    anonymizedAt: string | null;
  };
}) {
  const customerId = customer.id;
  const router = useRouter();
  const [vehicleBusy, setVehicleBusy] = useState(false);
  const [vehicleMessage, setVehicleMessage] = useState<string | null>(null);
  const [portalBusy, setPortalBusy] = useState(false);
  const [portal, setPortal] = useState<{ link: string; delivery: string } | null>(null);
  const [portalError, setPortalError] = useState<string | null>(null);
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileMessage, setProfileMessage] = useState<string | null>(null);
  const [anonymizeBusy, setAnonymizeBusy] = useState(false);
  const [anonymizeMessage, setAnonymizeMessage] = useState<string | null>(null);

  if (customer.anonymizedAt) {
    return <p className="mt-6 rounded-xl border border-amber-800/50 p-4 text-sm text-amber-200">This customer record was anonymized on {new Date(customer.anonymizedAt).toLocaleDateString("en-CA")}.</p>;
  }

  async function updateProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setProfileBusy(true);
    setProfileMessage(null);
    const form = new FormData(event.currentTarget);
    const result = await updateCustomerAction({
      customerId,
      firstName: form.get("firstName"),
      lastName: form.get("lastName"),
      email: form.get("email"),
      phone: form.get("phone"),
      preferredContact: form.get("preferredContact"),
      customerType: form.get("customerType"),
      companyName: form.get("companyName"),
      tags: String(form.get("tags") ?? "").split(",").map((tag) => tag.trim()).filter(Boolean),
      notes: form.get("notes"),
      marketingConsent: form.get("marketingConsent") === "on",
    });
    setProfileBusy(false);
    setProfileMessage(result.ok ? "Customer updated." : result.error);
    if (result.ok) router.refresh();
  }

  async function anonymize(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAnonymizeBusy(true);
    setAnonymizeMessage(null);
    const form = new FormData(event.currentTarget);
    const result = await anonymizeCustomerAction({
      customerId,
      confirmation: form.get("confirmation"),
      reason: form.get("reason"),
    });
    setAnonymizeBusy(false);
    setAnonymizeMessage(result.ok ? "Customer anonymized." : result.error);
    if (result.ok) router.refresh();
  }

  async function addVehicle(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setVehicleBusy(true);
    setVehicleMessage(null);
    const form = new FormData(event.currentTarget);
    const year = String(form.get("year") ?? "").trim();
    const result = await addCustomerVehicleAction({
      customerId,
      year: year ? Number(year) : undefined,
      make: form.get("make"),
      model: form.get("model"),
      trim: form.get("trim"),
      category: form.get("category"),
      colour: form.get("colour"),
      licencePlate: form.get("licencePlate"),
    });
    setVehicleBusy(false);
    if (!result.ok) return setVehicleMessage(result.error);
    event.currentTarget.reset();
    setVehicleMessage("Vehicle added.");
    router.refresh();
  }

  async function issuePortal() {
    setPortalBusy(true);
    setPortalError(null);
    const result = await issueCustomerPortalLinkAction({ customerId, expiryDays: 90 });
    setPortalBusy(false);
    if (!result.ok) return setPortalError(result.error);
    setPortal({ link: result.link, delivery: result.delivery });
  }

  return (
    <div className="mt-8 grid gap-5 lg:grid-cols-2">
      <section className="rounded-xl border border-ink-800 p-5 lg:col-span-2">
        <h2 className="text-lg font-semibold text-white">Customer profile</h2>
        <form onSubmit={updateProfile} className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="text-xs text-ink-400">First name
            <input name="firstName" required defaultValue={customer.firstName} className={`${inputClass} mt-1 w-full`} />
          </label>
          <label className="text-xs text-ink-400">Last name
            <input name="lastName" defaultValue={customer.lastName} className={`${inputClass} mt-1 w-full`} />
          </label>
          <label className="text-xs text-ink-400">Email
            <input name="email" type="email" defaultValue={customer.email ?? ""} className={`${inputClass} mt-1 w-full`} />
          </label>
          <label className="text-xs text-ink-400">Phone
            <input name="phone" defaultValue={customer.phone ?? ""} className={`${inputClass} mt-1 w-full`} />
          </label>
          <label className="text-xs text-ink-400">Preferred contact
            <select name="preferredContact" defaultValue={customer.preferredContact} className={`${inputClass} mt-1 w-full`}>
              <option value="email">Email</option><option value="sms">SMS</option><option value="phone">Phone</option>
            </select>
          </label>
          <label className="text-xs text-ink-400">Customer type
            <select name="customerType" defaultValue={customer.customerType} className={`${inputClass} mt-1 w-full`}>
              <option value="individual">Individual</option><option value="business">Business / fleet</option>
            </select>
          </label>
          <label className="text-xs text-ink-400">Company
            <input name="companyName" defaultValue={customer.companyName ?? ""} className={`${inputClass} mt-1 w-full`} />
          </label>
          <label className="text-xs text-ink-400">Tags (comma-separated)
            <input name="tags" defaultValue={customer.tags.join(", ")} className={`${inputClass} mt-1 w-full`} />
          </label>
          <label className="text-xs text-ink-400 sm:col-span-2">Internal notes
            <textarea name="notes" rows={3} defaultValue={customer.notes ?? ""} className={`${inputClass} mt-1 w-full`} />
          </label>
          <label className="flex items-center gap-2 text-sm text-ink-300 sm:col-span-2">
            <input name="marketingConsent" type="checkbox" defaultChecked={customer.marketingConsent} />
            Explicit marketing consent is on file
          </label>
          <div className="sm:col-span-2">
            <button disabled={profileBusy} className="rounded-lg bg-accent-400 px-4 py-2 text-sm font-semibold text-ink-950 disabled:opacity-50">
              {profileBusy ? "Saving…" : "Save profile"}
            </button>
            {profileMessage && <span role="status" className="ml-3 text-sm text-ink-300">{profileMessage}</span>}
          </div>
        </form>
      </section>

      <section className="rounded-xl border border-ink-800 p-5">
        <h2 className="text-lg font-semibold text-white">Add vehicle</h2>
        <form onSubmit={addVehicle} className="mt-4 grid gap-3 sm:grid-cols-2">
          <input name="year" type="number" min="1900" max="2030" placeholder="Year" className={inputClass} />
          <select name="category" defaultValue="other" className={inputClass}>
            {VEHICLE_CATEGORIES.map((category) => <option key={category} value={category}>{VEHICLE_CATEGORY_LABELS[category]}</option>)}
          </select>
          <input name="make" required placeholder="Make" className={inputClass} />
          <input name="model" required placeholder="Model" className={inputClass} />
          <input name="trim" placeholder="Trim" className={inputClass} />
          <input name="colour" placeholder="Colour" className={inputClass} />
          <input name="licencePlate" placeholder="Licence plate" className={inputClass} />
          <button disabled={vehicleBusy} className="rounded-lg bg-accent-400 px-4 py-2 text-sm font-semibold text-ink-950 disabled:opacity-50">
            {vehicleBusy ? "Adding…" : "Add vehicle"}
          </button>
        </form>
        {vehicleMessage && <p className="mt-3 text-sm text-ink-300">{vehicleMessage}</p>}
      </section>

      <section className="rounded-xl border border-ink-800 p-5">
        <h2 className="text-lg font-semibold text-white">Customer portal</h2>
        <p className="mt-2 text-sm text-ink-400">Issue a new 90-day link. Any older portal link is revoked.</p>
        <button onClick={issuePortal} disabled={portalBusy} className="mt-4 rounded-lg bg-accent-400 px-4 py-2 text-sm font-semibold text-ink-950 disabled:opacity-50">
          {portalBusy ? "Issuing…" : "Issue & send portal link"}
        </button>
        {portalError && <p className="mt-3 text-sm text-red-300">{portalError}</p>}
        {portal && (
          <div className="mt-4 rounded-lg border border-ink-700 bg-ink-900 p-3 text-sm">
            <p className={portal.delivery === "copy_only" ? "text-amber-300" : "text-emerald-300"}>{portal.delivery === "copy_only" ? "Link created but was not sent. Copy it below." : `Link sent by ${portal.delivery}.`}</p>
            <input readOnly value={portal.link} onFocus={(event) => event.currentTarget.select()} className={`${inputClass} mt-2 w-full font-mono text-xs`} />
            <button type="button" onClick={() => navigator.clipboard.writeText(portal.link)} className="mt-2 text-xs font-medium text-accent-300 hover:underline">Copy link</button>
          </div>
        )}
      </section>

      <section className="rounded-xl border border-red-900/60 p-5 lg:col-span-2">
        <h2 className="text-lg font-semibold text-red-200">Privacy request</h2>
        <p className="mt-2 text-sm text-ink-400">Anonymization permanently removes contact details and message content while preserving required financial totals and operational history.</p>
        <form onSubmit={anonymize} className="mt-4 grid gap-3 sm:grid-cols-[180px_1fr_auto]">
          <input name="confirmation" required placeholder="Type ANONYMIZE" className={inputClass} />
          <input name="reason" required minLength={5} placeholder="Reason / request reference" className={inputClass} />
          <button disabled={anonymizeBusy} className="rounded-lg border border-red-700 px-4 py-2 text-sm font-semibold text-red-200 disabled:opacity-50">
            {anonymizeBusy ? "Working…" : "Anonymize"}
          </button>
        </form>
        {anonymizeMessage && <p role="status" className="mt-2 text-sm text-red-200">{anonymizeMessage}</p>}
      </section>
    </div>
  );
}
