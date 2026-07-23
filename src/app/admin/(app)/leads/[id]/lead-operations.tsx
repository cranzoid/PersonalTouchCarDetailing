"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { assignLeadAction, convertLeadAction, updateLeadNotesAction } from "../actions";

type StaffOption = { id: string; name: string; role: string; active: boolean };
type ConversionForm = {
  firstName: string;
  lastName: string;
  customerType: "individual" | "business";
  companyName: string;
  preferredContact: "email" | "phone" | "sms";
  marketingConsent: boolean;
};

const inputClass = "w-full rounded-lg border border-ink-600 bg-ink-950 px-3 py-2 text-sm text-white";

export function LeadOperations({
  lead,
  staff,
  conversionDefaults,
}: {
  lead: {
    id: string;
    email: string | null;
    phone: string | null;
    notes: string | null;
    assignedStaffId: string | null;
    convertedCustomerId: string | null;
    marketingConsent: boolean;
  };
  staff: StaffOption[];
  conversionDefaults: {
    firstName: string;
    lastName: string;
    customerType: "individual" | "business";
    companyName: string;
    preferredContact: "email" | "phone";
  };
}) {
  const router = useRouter();
  const [assignment, setAssignment] = useState(lead.assignedStaffId ?? "");
  const [notes, setNotes] = useState(lead.notes ?? "");
  const [conversion, setConversion] = useState<ConversionForm>({
    ...conversionDefaults,
    marketingConsent: lead.marketingConsent,
  });
  const [busy, setBusy] = useState<"assignment" | "notes" | "conversion" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function assign() {
    setBusy("assignment");
    setError(null);
    setMessage(null);
    const result = await assignLeadAction({ leadId: lead.id, assignedStaffId: assignment || null });
    setBusy(null);
    if (!result.ok) setError(result.error);
    else {
      setMessage("Assignment saved.");
      router.refresh();
    }
  }

  async function saveNotes() {
    setBusy("notes");
    setError(null);
    setMessage(null);
    const result = await updateLeadNotesAction({ leadId: lead.id, notes });
    setBusy(null);
    if (!result.ok) setError(result.error);
    else {
      setMessage("Internal notes saved.");
      router.refresh();
    }
  }

  async function convert() {
    setBusy("conversion");
    setError(null);
    setMessage(null);
    const result = await convertLeadAction({ leadId: lead.id, ...conversion });
    setBusy(null);
    if (!result.ok) setError(result.error);
    else router.push(`/admin/customers/${result.customerId}`);
  }

  return (
    <section className="mt-8 rounded-xl border border-ink-800 p-5">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-ink-400">Lead operations</h2>
      <div className="mt-4 grid gap-6 md:grid-cols-2">
        <div>
          <label className="text-xs text-ink-400">
            Assigned staff
            <select className={`${inputClass} mt-1`} value={assignment} onChange={(event) => setAssignment(event.target.value)}>
              <option value="">Unassigned</option>
              {staff.map((user) => (
                <option key={user.id} value={user.id} disabled={!user.active}>
                  {user.name} · {user.role}{user.active ? "" : " (inactive)"}
                </option>
              ))}
            </select>
          </label>
          <button onClick={() => void assign()} disabled={busy !== null} className="mt-3 rounded-lg border border-ink-600 px-4 py-2 text-sm text-ink-200 hover:border-accent-500 disabled:opacity-40">
            {busy === "assignment" ? "Saving…" : "Save assignment"}
          </button>
        </div>
        <div>
          <label className="text-xs text-ink-400">
            Internal notes
            <textarea rows={4} maxLength={4000} className={`${inputClass} mt-1`} value={notes} onChange={(event) => setNotes(event.target.value)} />
          </label>
          <button onClick={() => void saveNotes()} disabled={busy !== null} className="mt-3 rounded-lg border border-ink-600 px-4 py-2 text-sm text-ink-200 hover:border-accent-500 disabled:opacity-40">
            {busy === "notes" ? "Saving…" : "Save notes"}
          </button>
        </div>
      </div>

      {!lead.convertedCustomerId && (
        <div className="mt-7 border-t border-ink-800 pt-6">
          <h3 className="font-medium text-white">Convert to customer</h3>
          <p className="mt-1 text-xs text-ink-500">Review these explicit CRM fields before creating the customer record.</p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <label className="text-xs text-ink-400">First name
              <input className={`${inputClass} mt-1`} value={conversion.firstName} onChange={(event) => setConversion({ ...conversion, firstName: event.target.value })} />
            </label>
            <label className="text-xs text-ink-400">Last name
              <input className={`${inputClass} mt-1`} value={conversion.lastName} onChange={(event) => setConversion({ ...conversion, lastName: event.target.value })} />
            </label>
            <label className="text-xs text-ink-400">Customer type
              <select className={`${inputClass} mt-1`} value={conversion.customerType} onChange={(event) => setConversion({ ...conversion, customerType: event.target.value as "individual" | "business" })}>
                <option value="individual">Individual</option>
                <option value="business">Business</option>
              </select>
            </label>
            <label className="text-xs text-ink-400">Company name
              <input disabled={conversion.customerType !== "business"} className={`${inputClass} mt-1 disabled:opacity-40`} value={conversion.companyName} onChange={(event) => setConversion({ ...conversion, companyName: event.target.value })} />
            </label>
            <label className="text-xs text-ink-400">Preferred contact
              <select className={`${inputClass} mt-1`} value={conversion.preferredContact} onChange={(event) => setConversion({ ...conversion, preferredContact: event.target.value as "email" | "phone" | "sms" })}>
                <option value="email" disabled={!lead.email}>Email{lead.email ? "" : " (unavailable)"}</option>
                <option value="phone" disabled={!lead.phone}>Phone{lead.phone ? "" : " (unavailable)"}</option>
                <option value="sms" disabled={!lead.phone}>SMS{lead.phone ? "" : " (unavailable)"}</option>
              </select>
            </label>
            <label className="flex items-center gap-2 pt-5 text-sm text-ink-300">
              <input type="checkbox" checked={conversion.marketingConsent} onChange={(event) => setConversion({ ...conversion, marketingConsent: event.target.checked })} />
              Explicit marketing consent recorded
            </label>
          </div>
          <button onClick={() => void convert()} disabled={busy !== null} className="mt-4 rounded-lg bg-accent-400 px-5 py-2 text-sm font-semibold text-ink-950 hover:bg-accent-300 disabled:opacity-40">
            {busy === "conversion" ? "Converting…" : "Create Customer"}
          </button>
        </div>
      )}

      {error && <p className="mt-4 text-sm text-red-400">{error}</p>}
      {message && <p className="mt-4 text-sm text-emerald-300">{message}</p>}
    </section>
  );
}
