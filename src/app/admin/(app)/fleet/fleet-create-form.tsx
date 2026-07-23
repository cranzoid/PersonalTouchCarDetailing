"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { createFleetCustomerAction } from "../customers/actions";

const inputClass = "rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-sm text-white placeholder:text-ink-600";

export function FleetCreateForm() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const form = new FormData(event.currentTarget);
    const result = await createFleetCustomerAction({
      companyName: form.get("companyName"),
      firstName: form.get("firstName"),
      lastName: form.get("lastName"),
      email: form.get("email"),
      phone: form.get("phone"),
      preferredContact: form.get("preferredContact"),
    });
    setBusy(false);
    if (!result.ok) return setError(result.error);
    router.push(`/admin/fleet/${result.customerId}`);
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="mt-5 grid gap-3 rounded-xl border border-ink-800 p-5 sm:grid-cols-2 lg:grid-cols-3">
      <input name="companyName" required placeholder="Company name" className={inputClass} />
      <input name="firstName" required placeholder="Contact first name" className={inputClass} />
      <input name="lastName" placeholder="Contact last name" className={inputClass} />
      <input name="email" type="email" placeholder="Email" className={inputClass} />
      <input name="phone" placeholder="Phone" className={inputClass} />
      <select name="preferredContact" defaultValue="email" className={inputClass}>
        <option value="email">Email preferred</option>
        <option value="sms">SMS preferred</option>
        <option value="phone">Phone preferred</option>
      </select>
      <button disabled={busy} className="rounded-lg bg-accent-400 px-4 py-2 text-sm font-semibold text-ink-950 disabled:opacity-50">
        {busy ? "Creating…" : "Create fleet account"}
      </button>
      {error && <p className="self-center text-sm text-red-300 sm:col-span-2">{error}</p>}
    </form>
  );
}
