"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { formatCents } from "@/lib/money";
import { PAY_TYPES, PAY_TYPE_LABELS, STAFF_ROLES, type PayType, type StaffRole } from "@/lib/types";
import {
  createStaffAction,
  removeStaffAction,
  resetStaffPasswordAction,
  updateStaffAction,
  updateStaffPayAction,
  updateStaffSchedulingAction,
} from "./actions";

type StaffSummary = {
  id: string;
  name: string;
  email: string;
  role: string;
  active: boolean;
  createdAt: string;
  skills: string[];
  payType: PayType;
  hourlyRateCents: number;
  dailyRateCents: number;
  monthlySalaryCents: number;
  shifts: Array<{ weekday: number; start: string; end: string }>;
};

type DetailTab = "access" | "pay" | "schedule";
type AccountFilter = "all" | "active" | "inactive";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const ROLE_LABELS: Record<StaffRole, string> = {
  owner: "Owner",
  manager: "Manager",
  reception: "Reception",
  technician: "Technician",
  accountant: "Accountant",
};
const ROLE_DESCRIPTIONS: Record<StaffRole, string> = {
  owner: "Full access, including staff, integrations and financial settings.",
  manager: "Runs customers, bookings, jobs, invoices, schedules and reports.",
  reception: "Handles customers, bookings, estimates and payments.",
  technician: "Works jobs and accesses private job files.",
  accountant: "Manages invoices, expenses and financial reports.",
};

const inputClass =
  "w-full rounded-lg border border-ink-600 bg-ink-950 px-3 py-2 text-sm text-white transition focus:border-accent-500 focus:outline-none";
const secondaryButton =
  "rounded-lg border border-ink-600 px-4 py-2 text-sm font-medium text-ink-200 transition hover:border-accent-500 hover:bg-ink-900 disabled:opacity-40";

function toCents(dollars: string): number {
  const value = Number(dollars);
  return Number.isFinite(value) && value > 0 ? Math.round(value * 100) : 0;
}
const toDollars = (cents: number) => (cents === 0 ? "" : (cents / 100).toFixed(2));

function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "?";
}

function paySummary(user: StaffSummary, currency: string): string {
  if (user.payType === "daily_fixed") return `${formatCents(user.dailyRateCents, currency)}/day`;
  if (user.payType === "monthly_fixed") return `${formatCents(user.monthlySalaryCents, currency)}/month`;
  return `${formatCents(user.hourlyRateCents, currency)}/hour`;
}

export function StaffManager({
  currentStaffId,
  currency,
  initialStaff,
}: {
  currentStaffId: string;
  currency: string;
  initialStaff: StaffSummary[];
}) {
  const [selectedId, setSelectedId] = useState(currentStaffId);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<AccountFilter>("all");

  const visibleStaff = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return initialStaff.filter((user) => {
      if (filter === "active" && !user.active) return false;
      if (filter === "inactive" && user.active) return false;
      return !needle || user.name.toLowerCase().includes(needle) || user.email.toLowerCase().includes(needle) || user.role.toLowerCase().includes(needle);
    });
  }, [filter, initialStaff, query]);
  const selected = initialStaff.find((user) => user.id === selectedId) ?? initialStaff[0];
  const activeCount = initialStaff.filter((user) => user.active).length;

  return (
    <div className="mt-8 space-y-6">
      <div className="grid gap-3 sm:grid-cols-3">
        <SummaryMetric label="Total users" value={initialStaff.length} />
        <SummaryMetric label="Active access" value={activeCount} tone="success" />
        <SummaryMetric label="Inactive" value={initialStaff.length - activeCount} />
      </div>

      <CreateAccount />

      <section className="overflow-hidden rounded-2xl border border-ink-800 bg-ink-900 shadow-sm">
        <div className="grid min-h-[620px] lg:grid-cols-[320px_minmax(0,1fr)]">
          <aside className="border-b border-ink-800 bg-ink-950/50 lg:border-b-0 lg:border-r">
            <div className="border-b border-ink-800 p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h2 className="font-semibold text-white">People</h2>
                  <p className="text-xs text-ink-500">Select a user to manage them</p>
                </div>
                <span className="rounded-full bg-ink-800 px-2.5 py-1 text-xs font-semibold text-ink-300">{initialStaff.length}</span>
              </div>
              <label className="mt-4 block">
                <span className="sr-only">Search users</span>
                <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search name, email or role" className={inputClass} />
              </label>
              <div className="mt-3 flex gap-1 rounded-lg bg-ink-800 p-1" aria-label="Filter staff accounts">
                {(["all", "active", "inactive"] as const).map((item) => (
                  <button key={item} type="button" onClick={() => setFilter(item)} aria-pressed={filter === item} className={`flex-1 rounded-md px-2 py-1.5 text-xs font-medium capitalize transition ${filter === item ? "bg-ink-900 text-white shadow-sm" : "text-ink-400 hover:text-ink-200"}`}>
                    {item}
                  </button>
                ))}
              </div>
            </div>

            <div className="max-h-[520px] overflow-y-auto p-2 lg:max-h-none">
              {visibleStaff.map((user) => {
                const isSelected = selected?.id === user.id;
                return (
                  <button key={user.id} type="button" onClick={() => setSelectedId(user.id)} aria-current={isSelected ? "true" : undefined} className={`flex w-full items-center gap-3 rounded-xl border px-3 py-3 text-left transition ${isSelected ? "border-accent-500/50 bg-accent-400/10 shadow-sm" : "border-transparent hover:border-ink-800 hover:bg-ink-900"}`}>
                    <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-full text-xs font-bold ${user.active ? "bg-ink-800 text-accent-500" : "bg-ink-800 text-ink-500"}`}>
                      {initials(user.name)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="truncate text-sm font-semibold text-white">{user.name}</span>
                        {user.id === currentStaffId && <span className="text-[10px] font-semibold uppercase tracking-wide text-accent-500">You</span>}
                      </span>
                      <span className="mt-0.5 flex items-center gap-2 text-xs text-ink-500">
                        <span>{ROLE_LABELS[user.role as StaffRole]}</span>
                        <span aria-hidden="true">·</span>
                        <span className={user.active ? "text-emerald-300" : "text-ink-500"}>{user.active ? "Active" : "Inactive"}</span>
                      </span>
                    </span>
                    <span aria-hidden="true" className="text-lg text-ink-500">›</span>
                  </button>
                );
              })}
              {visibleStaff.length === 0 && <p className="px-3 py-10 text-center text-sm text-ink-500">No users match this filter.</p>}
            </div>
          </aside>

          <main className="min-w-0 p-4 sm:p-6">
            {selected ? <StaffDetails key={selected.id} user={selected} currency={currency} isCurrent={selected.id === currentStaffId} /> : <div className="grid h-full place-items-center text-sm text-ink-500">Create a user to get started.</div>}
          </main>
        </div>
      </section>

      <p className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs text-amber-800">
        Scheduling note: until the first weekly shift is saved, bookings use bay-only capacity. Once any shift exists, every booking requires on-shift, skill-matched staff.
      </p>
    </div>
  );
}

function SummaryMetric({ label, value, tone }: { label: string; value: number; tone?: "success" }) {
  return <div className="rounded-xl border border-ink-800 bg-ink-900 px-4 py-3"><p className="text-xs font-medium text-ink-500">{label}</p><p className={`mt-1 text-2xl font-bold ${tone === "success" ? "text-emerald-300" : "text-white"}`}>{value}</p></div>;
}

function CreateAccount() {
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
    if (!result.ok) return setError(result.error);
    setForm({ name: "", email: "", role: "reception", password: "" });
    setCreated(true);
    router.refresh();
  }

  return (
    <details className="group rounded-xl border border-ink-800 bg-ink-900">
      <summary className="flex cursor-pointer items-center justify-between gap-3 px-5 py-4 text-sm font-semibold text-white">
        <span className="flex items-center gap-3"><span className="grid h-8 w-8 place-items-center rounded-full bg-accent-400 text-lg text-ink-950">+</span>Add a staff user</span>
        <span className="text-xl font-normal text-ink-500 transition group-open:rotate-90" aria-hidden="true">›</span>
      </summary>
      <div className="border-t border-ink-800 px-5 pb-5 pt-4">
        <p className="text-sm text-ink-400">Create sign-in access now; pay and scheduling can be configured after selecting the user.</p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="text-xs text-ink-400">Name<input className={`${inputClass} mt-1`} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
          <label className="text-xs text-ink-400">Email<input type="email" className={`${inputClass} mt-1`} value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} /></label>
          <label className="text-xs text-ink-400">Role<select className={`${inputClass} mt-1`} value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value as StaffRole })}>{STAFF_ROLES.map((role) => <option key={role} value={role}>{ROLE_LABELS[role]}</option>)}</select></label>
          <label className="text-xs text-ink-400">Temporary password (12+ characters)<input type="password" minLength={12} maxLength={200} autoComplete="new-password" className={`${inputClass} mt-1`} value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} /></label>
        </div>
        {error && <p role="alert" className="mt-3 text-sm text-red-400">{error}</p>}
        {created && <p role="status" className="mt-3 text-sm text-emerald-300">Staff account created.</p>}
        <button type="button" onClick={() => void create()} disabled={busy} className="mt-4 rounded-lg bg-accent-400 px-5 py-2 text-sm font-semibold text-ink-950 hover:bg-accent-300 disabled:opacity-40">{busy ? "Creating…" : "Create account"}</button>
      </div>
    </details>
  );
}

function StaffDetails({ user, currency, isCurrent }: { user: StaffSummary; currency: string; isCurrent: boolean }) {
  const router = useRouter();
  const [tab, setTab] = useState<DetailTab>("access");
  const [role, setRole] = useState(user.role as StaffRole);
  const [active, setActive] = useState(user.active);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [skills, setSkills] = useState(user.skills.join(", "));
  const [payType, setPayType] = useState<PayType>(user.payType);
  const [rate, setRate] = useState({ hourly: toDollars(user.hourlyRateCents), daily: toDollars(user.dailyRateCents), monthly: toDollars(user.monthlySalaryCents) });
  const [shifts, setShifts] = useState(WEEKDAYS.map((_, weekday) => {
    const existing = user.shifts.find((shift) => shift.weekday === weekday);
    return { weekday, enabled: Boolean(existing), start: existing?.start ?? "09:00", end: existing?.end ?? "17:00" };
  }));

  function startAction() {
    setBusy(true);
    setError(null);
    setMessage(null);
  }

  async function saveAccess() {
    startAction();
    const result = await updateStaffAction({ staffUserId: user.id, role, active });
    setBusy(false);
    if (!result.ok) return setError(result.error);
    setMessage("Access updated.");
    router.refresh();
  }

  async function resetPassword() {
    startAction();
    const result = await resetStaffPasswordAction({ staffUserId: user.id, password });
    setBusy(false);
    if (!result.ok) return setError(result.error);
    setPassword("");
    setMessage(isCurrent ? "Password updated. Your sessions were revoked; sign in again." : "Password updated and sessions revoked.");
    router.refresh();
  }

  async function savePay() {
    startAction();
    const result = await updateStaffPayAction({ staffUserId: user.id, payType, hourlyRateCents: toCents(rate.hourly), dailyRateCents: toCents(rate.daily), monthlySalaryCents: toCents(rate.monthly) });
    setBusy(false);
    if (!result.ok) return setError(result.error);
    setMessage("Pay updated. Previously logged hours keep their saved rate.");
    router.refresh();
  }

  async function saveScheduling() {
    startAction();
    const result = await updateStaffSchedulingAction({ staffUserId: user.id, skills: skills.split(",").map((skill) => skill.trim()).filter(Boolean), shifts: shifts.filter((shift) => shift.enabled).map(({ weekday, start, end }) => ({ weekday, start, end })) });
    setBusy(false);
    if (!result.ok) return setError(result.error);
    setMessage("Skills and weekly shifts updated.");
    router.refresh();
  }

  async function removeUser() {
    startAction();
    const result = await removeStaffAction({ staffUserId: user.id, confirmation: "REMOVE" });
    setBusy(false);
    if (!result.ok) return setError(result.error);
    setMessage("User removed.");
    router.refresh();
  }

  return (
    <div>
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-4">
          <span className="grid h-14 w-14 shrink-0 place-items-center rounded-full bg-ink-800 text-base font-bold text-accent-500">{initials(user.name)}</span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2"><h2 className="truncate text-xl font-bold text-white">{user.name}</h2>{isCurrent && <span className="rounded-full bg-accent-400/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-accent-500">You</span>}</div>
            <p className="truncate text-sm text-ink-400">{user.email}</p>
            <p className="mt-1 text-xs text-ink-500">Added {new Date(user.createdAt).toLocaleDateString("en-CA", { year: "numeric", month: "short", day: "numeric" })}</p>
          </div>
        </div>
        <span className={`rounded-full px-3 py-1 text-xs font-semibold ${user.active ? "bg-emerald-50 text-emerald-700" : "bg-ink-800 text-ink-500"}`}>{user.active ? "Active access" : "Inactive"}</span>
      </header>

      <div className="mt-6 grid gap-3 sm:grid-cols-3">
        <MiniDetail label="Role" value={ROLE_LABELS[user.role as StaffRole]} />
        <MiniDetail label="Pay" value={paySummary(user, currency)} />
        <MiniDetail label="Weekly shifts" value={String(user.shifts.length)} />
      </div>

      <div className="mt-6 flex gap-1 overflow-x-auto border-b border-ink-800" role="tablist" aria-label="User settings">
        {(["access", "pay", "schedule"] as const).map((item) => (
          <button key={item} type="button" role="tab" aria-selected={tab === item} onClick={() => { setTab(item); setError(null); setMessage(null); }} className={`border-b-2 px-4 py-3 text-sm font-semibold capitalize transition ${tab === item ? "border-accent-500 text-white" : "border-transparent text-ink-500 hover:text-ink-300"}`}>
            {item === "schedule" ? "Skills & schedule" : item}
          </button>
        ))}
      </div>

      <div className="pt-6">
        {tab === "access" && (
          <div className="space-y-6">
            <section>
              <h3 className="font-semibold text-white">Role and sign-in</h3>
              <p className="mt-1 text-sm text-ink-500">Choose what this person can access and whether they can sign in.</p>
              <div className="mt-4 grid gap-4 sm:grid-cols-[minmax(0,240px)_1fr]">
                <label className="text-xs text-ink-400">Role<select value={role} onChange={(event) => setRole(event.target.value as StaffRole)} disabled={busy} className={`${inputClass} mt-1`}>{STAFF_ROLES.map((item) => <option key={item} value={item}>{ROLE_LABELS[item]}</option>)}</select></label>
                <div className="rounded-lg border border-ink-800 bg-ink-950/50 p-3 text-sm text-ink-400">{ROLE_DESCRIPTIONS[role]}</div>
              </div>
              <label className="mt-4 flex items-start gap-3 rounded-lg border border-ink-800 p-3">
                <input type="checkbox" checked={active} onChange={(event) => setActive(event.target.checked)} disabled={busy || isCurrent} className="mt-0.5" />
                <span><span className="block text-sm font-medium text-white">Allow sign-in</span><span className="block text-xs text-ink-500">Turning this off revokes this user&apos;s active sessions. You cannot deactivate yourself.</span></span>
              </label>
              <button type="button" onClick={() => void saveAccess()} disabled={busy} className="mt-4 rounded-lg bg-accent-400 px-5 py-2 text-sm font-semibold text-ink-950 hover:bg-accent-300 disabled:opacity-40">Save access</button>
            </section>

            <section className="border-t border-ink-800 pt-6">
              <h3 className="font-semibold text-white">Reset password</h3>
              <p className="mt-1 text-sm text-ink-500">All current sessions for this user will be signed out.</p>
              <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end">
                <label className="flex-1 text-xs text-ink-400">New password (12+ characters)<input type="password" minLength={12} maxLength={200} autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} className={`${inputClass} mt-1`} /></label>
                <button type="button" onClick={() => void resetPassword()} disabled={busy || password.length < 12} className={secondaryButton}>Reset password</button>
              </div>
            </section>

            {!isCurrent && (
              <section className="border-t border-red-200 pt-6">
                <h3 className="font-semibold text-red-700">Remove user</h3>
                <p className="mt-1 text-sm text-ink-500">This immediately revokes sign-in access and removes the user from this page. Historical appointments, payroll and audit records keep their attribution.</p>
                {!confirmRemove ? <button type="button" onClick={() => setConfirmRemove(true)} className="mt-4 rounded-lg border border-red-300 px-4 py-2 text-sm font-semibold text-red-700 hover:bg-red-50">Remove user</button> : (
                  <div className="mt-4 rounded-lg border border-red-300 bg-red-50 p-4">
                    <p className="text-sm font-semibold text-red-800">Remove {user.name}?</p>
                    <p className="mt-1 text-xs text-red-700">This person will be signed out immediately. Their email can be used for a new account.</p>
                    <div className="mt-3 flex gap-2">
                      <button type="button" onClick={() => void removeUser()} disabled={busy} className="rounded-lg bg-red-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40">{busy ? "Removing…" : "Yes, remove user"}</button>
                      <button type="button" onClick={() => setConfirmRemove(false)} disabled={busy} className="rounded-lg border border-red-300 px-4 py-2 text-sm font-medium text-red-700">Cancel</button>
                    </div>
                  </div>
                )}
              </section>
            )}
          </div>
        )}

        {tab === "pay" && (
          <section>
            <h3 className="font-semibold text-white">Pay terms</h3>
            <p className="mt-1 text-sm text-ink-500">Rate changes apply only to newly logged hours; saved payroll history never changes.</p>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <label className="text-xs text-ink-400">Pay type<select value={payType} onChange={(event) => setPayType(event.target.value as PayType)} disabled={busy} className={`${inputClass} mt-1`}>{PAY_TYPES.map((item) => <option key={item} value={item}>{PAY_TYPE_LABELS[item]}</option>)}</select></label>
              <label className="text-xs text-ink-400">
                {payType === "hourly" ? "Rate per hour" : payType === "daily_fixed" ? "Rate per day worked" : "Salary per month"}
                <input type="number" step="0.01" min="0" inputMode="decimal" value={payType === "hourly" ? rate.hourly : payType === "daily_fixed" ? rate.daily : rate.monthly} onChange={(event) => setRate((current) => ({ ...current, [payType === "hourly" ? "hourly" : payType === "daily_fixed" ? "daily" : "monthly"]: event.target.value }))} disabled={busy} className={`${inputClass} mt-1`} />
              </label>
            </div>
            <div className="mt-4 rounded-lg border border-ink-800 bg-ink-950/50 p-3 text-sm text-ink-400">
              {payType === "monthly_fixed" ? `${formatCents(toCents(rate.monthly), currency)} accrues each active month, whether or not hours are logged.` : payType === "daily_fixed" ? `${formatCents(toCents(rate.daily), currency)} for each day with logged hours.` : `${formatCents(toCents(rate.hourly), currency)} for each hour logged.`}
            </div>
            <button type="button" onClick={() => void savePay()} disabled={busy} className="mt-4 rounded-lg bg-accent-400 px-5 py-2 text-sm font-semibold text-ink-950 hover:bg-accent-300 disabled:opacity-40">Save pay</button>
          </section>
        )}

        {tab === "schedule" && (
          <section>
            <h3 className="font-semibold text-white">Skills and weekly shifts</h3>
            <p className="mt-1 text-sm text-ink-500">Skills must match the skills required by services for automatic booking capacity.</p>
            <label className="mt-4 block text-xs text-ink-400">Skills (comma separated)<input value={skills} onChange={(event) => setSkills(event.target.value)} placeholder="interior, polishing, ceramic" className={`${inputClass} mt-1`} /></label>
            <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {shifts.map((shift) => (
                <div key={shift.weekday} className={`rounded-lg border p-3 transition ${shift.enabled ? "border-accent-500/40 bg-accent-400/5" : "border-ink-800"}`}>
                  <label className="flex items-center gap-2 text-xs font-semibold text-ink-300"><input type="checkbox" checked={shift.enabled} onChange={(event) => setShifts((current) => current.map((item) => item.weekday === shift.weekday ? { ...item, enabled: event.target.checked } : item))} />{WEEKDAYS[shift.weekday]}</label>
                  {shift.enabled && <div className="mt-2 flex items-center gap-1.5"><input aria-label={`${WEEKDAYS[shift.weekday]} start`} type="time" value={shift.start} onChange={(event) => setShifts((current) => current.map((item) => item.weekday === shift.weekday ? { ...item, start: event.target.value } : item))} className={`${inputClass} min-w-0 px-2 py-1.5`} /><span className="text-xs text-ink-500">–</span><input aria-label={`${WEEKDAYS[shift.weekday]} end`} type="time" value={shift.end} onChange={(event) => setShifts((current) => current.map((item) => item.weekday === shift.weekday ? { ...item, end: event.target.value } : item))} className={`${inputClass} min-w-0 px-2 py-1.5`} /></div>}
                </div>
              ))}
            </div>
            <button type="button" onClick={() => void saveScheduling()} disabled={busy} className="mt-4 rounded-lg bg-accent-400 px-5 py-2 text-sm font-semibold text-ink-950 hover:bg-accent-300 disabled:opacity-40">Save skills &amp; shifts</button>
          </section>
        )}
      </div>

      {error && <p role="alert" className="mt-5 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      {message && <p role="status" className="mt-5 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-700">{message}</p>}
    </div>
  );
}

function MiniDetail({ label, value }: { label: string; value: string }) {
  return <div className="rounded-lg border border-ink-800 bg-ink-950/40 p-3"><p className="text-[11px] font-semibold uppercase tracking-wider text-ink-500">{label}</p><p className="mt-1 truncate text-sm font-semibold text-white">{value}</p></div>;
}
