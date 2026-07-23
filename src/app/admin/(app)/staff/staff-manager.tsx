"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { STAFF_ROLES, type StaffRole } from "@/lib/types";
import { createStaffAction, resetStaffPasswordAction, updateStaffAction, updateStaffSchedulingAction } from "./actions";

type StaffSummary = {
  id: string;
  name: string;
  email: string;
  role: string;
  active: boolean;
  createdAt: string;
  skills: string[];
  shifts: Array<{ weekday: number; start: string; end: string }>;
};

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const inputClass = "w-full rounded-lg border border-ink-600 bg-ink-950 px-3 py-2 text-sm text-white";

export function StaffManager({
  currentStaffId,
  initialStaff,
}: {
  currentStaffId: string;
  initialStaff: StaffSummary[];
}) {
  const router = useRouter();
  const [form, setForm] = useState({ name: "", email: "", role: "reception" as StaffRole, password: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState(false);

  async function create() {
    setBusy(true);
    setError(null);
    setCreated(false);
    const result = await createStaffAction(form);
    setBusy(false);
    if (!result.ok) setError(result.error);
    else {
      setForm({ name: "", email: "", role: "reception", password: "" });
      setCreated(true);
      router.refresh();
    }
  }

  return (
    <div className="mt-8 space-y-8">
      <section className="rounded-xl border border-ink-800 p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-400">Create staff account</h2>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="text-xs text-ink-400">
            Name
            <input className={`${inputClass} mt-1`} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
          </label>
          <label className="text-xs text-ink-400">
            Email
            <input type="email" className={`${inputClass} mt-1`} value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} />
          </label>
          <label className="text-xs text-ink-400">
            Role
            <select className={`${inputClass} mt-1 capitalize`} value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value as StaffRole })}>
              {STAFF_ROLES.map((role) => <option key={role} value={role}>{role}</option>)}
            </select>
          </label>
          <label className="text-xs text-ink-400">
            Temporary password (12+ characters)
            <input type="password" minLength={12} maxLength={200} autoComplete="new-password" className={`${inputClass} mt-1`} value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} />
          </label>
        </div>
        {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
        {created && <p className="mt-3 text-sm text-emerald-300">Staff account created.</p>}
        <button onClick={() => void create()} disabled={busy} className="mt-4 rounded-lg bg-accent-400 px-5 py-2 text-sm font-semibold text-ink-950 hover:bg-accent-300 disabled:opacity-40">
          {busy ? "Creating…" : "Create Account"}
        </button>
      </section>

      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-400">Accounts ({initialStaff.length})</h2>
        <p className="mt-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-800">
          Compatibility rule: until the first weekly shift is saved, bookings use bay-only capacity. Once any shift exists, on-shift skill-matched staffing is required for every booking.
        </p>
        <div className="mt-3 space-y-3">
          {initialStaff.map((user) => (
            <StaffRow key={user.id} user={user} isCurrent={user.id === currentStaffId} />
          ))}
        </div>
      </section>
    </div>
  );
}

function StaffRow({ user, isCurrent }: { user: StaffSummary; isCurrent: boolean }) {
  const router = useRouter();
  const [role, setRole] = useState(user.role as StaffRole);
  const [active, setActive] = useState(user.active);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [skills, setSkills] = useState(user.skills.join(", "));
  const [shifts, setShifts] = useState(WEEKDAYS.map((_, weekday) => {
    const existing = user.shifts.find((shift) => shift.weekday === weekday);
    return { weekday, enabled: Boolean(existing), start: existing?.start ?? "09:00", end: existing?.end ?? "17:00" };
  }));

  async function saveAccess() {
    setBusy(true);
    setError(null);
    setMessage(null);
    const result = await updateStaffAction({ staffUserId: user.id, role, active });
    setBusy(false);
    if (!result.ok) setError(result.error);
    else {
      setMessage("Access updated.");
      router.refresh();
    }
  }

  async function resetPassword() {
    setBusy(true);
    setError(null);
    setMessage(null);
    const result = await resetStaffPasswordAction({ staffUserId: user.id, password });
    setBusy(false);
    if (!result.ok) setError(result.error);
    else {
      setPassword("");
      setMessage(isCurrent ? "Password updated. Your sessions were revoked; sign in again." : "Password updated and sessions revoked.");
      router.refresh();
    }
  }

  async function saveScheduling() {
    setBusy(true);
    setError(null);
    setMessage(null);
    const result = await updateStaffSchedulingAction({
      staffUserId: user.id,
      skills: skills.split(",").map((skill) => skill.trim()).filter(Boolean),
      shifts: shifts.filter((shift) => shift.enabled).map(({ weekday, start, end }) => ({ weekday, start, end })),
    });
    setBusy(false);
    if (!result.ok) setError(result.error);
    else {
      setMessage("Skills and weekly shifts updated.");
      router.refresh();
    }
  }

  return (
    <article className={`rounded-xl border p-4 ${user.active ? "border-ink-800" : "border-ink-900 opacity-70"}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-medium text-white">{user.name} {isCurrent && <span className="text-xs text-accent-300">(you)</span>}</p>
          <p className="text-sm text-ink-400">{user.email}</p>
          <p className="mt-1 text-xs text-ink-600">Added {new Date(user.createdAt).toLocaleDateString("en-CA")}</p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs text-ink-400">
            Role
            <select value={role} onChange={(event) => setRole(event.target.value as StaffRole)} disabled={busy} className={`${inputClass} mt-1 capitalize`}>
              {STAFF_ROLES.map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
          </label>
          <label className="flex items-center gap-2 pb-2 text-sm text-ink-300">
            <input type="checkbox" checked={active} onChange={(event) => setActive(event.target.checked)} disabled={busy || isCurrent} />
            Active
          </label>
          <button onClick={() => void saveAccess()} disabled={busy} className="rounded-lg border border-ink-600 px-4 py-2 text-sm text-ink-200 hover:border-accent-500 disabled:opacity-40">Save access</button>
        </div>
      </div>
      <div className="mt-4 flex flex-wrap items-end gap-2 border-t border-ink-800 pt-4">
        <label className="min-w-64 flex-1 text-xs text-ink-400">
          New password (12+ characters)
          <input type="password" minLength={12} maxLength={200} autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} className={`${inputClass} mt-1`} />
        </label>
        <button onClick={() => void resetPassword()} disabled={busy || password.length < 12} className="rounded-lg border border-amber-800 px-4 py-2 text-sm text-amber-300 hover:bg-amber-950/30 disabled:opacity-40">Reset password</button>
      </div>
      <div className="mt-4 border-t border-ink-800 pt-4">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-400">Skills &amp; weekly shifts</h3>
        <label className="mt-3 block text-xs text-ink-400">
          Skills (comma separated; match service-required skills)
          <input value={skills} onChange={(event) => setSkills(event.target.value)} placeholder="interior, polishing, ceramic" className={`${inputClass} mt-1`} />
        </label>
        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {shifts.map((shift) => (
            <div key={shift.weekday} className="rounded-lg border border-ink-800 p-2.5">
              <label className="flex items-center gap-2 text-xs font-medium text-ink-300">
                <input type="checkbox" checked={shift.enabled} onChange={(event) => setShifts((current) => current.map((item) => item.weekday === shift.weekday ? { ...item, enabled: event.target.checked } : item))} />
                {WEEKDAYS[shift.weekday]}
              </label>
              {shift.enabled && <div className="mt-2 flex items-center gap-1.5"><input type="time" value={shift.start} onChange={(event) => setShifts((current) => current.map((item) => item.weekday === shift.weekday ? { ...item, start: event.target.value } : item))} className={`${inputClass} min-w-0 px-2 py-1.5`} /><span className="text-xs text-ink-500">–</span><input type="time" value={shift.end} onChange={(event) => setShifts((current) => current.map((item) => item.weekday === shift.weekday ? { ...item, end: event.target.value } : item))} className={`${inputClass} min-w-0 px-2 py-1.5`} /></div>}
            </div>
          ))}
        </div>
        <button onClick={() => void saveScheduling()} disabled={busy} className="mt-3 rounded-lg border border-ink-600 px-4 py-2 text-sm font-medium text-ink-200 hover:border-accent-500 disabled:opacity-40">Save skills &amp; shifts</button>
      </div>
      {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
      {message && <p className="mt-3 text-sm text-emerald-300">{message}</p>}
    </article>
  );
}
