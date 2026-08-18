"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { formatCents } from "@/lib/money";
import {
  EXPENSE_PAYMENT_METHODS,
  EXPENSE_PAYMENT_METHOD_LABELS,
  type ExpensePaymentMethod,
} from "@/lib/types";
import {
  createExpenseCategoryAction,
  createRecurringBillAction,
  stopRecurringBillAction,
  updateExpenseCategoryAction,
  updateRecurringBillAction,
} from "./actions";

type Category = { id: string; name: string; isPayroll: boolean; active: boolean };
type Bill = {
  id: string;
  name: string;
  categoryId: string;
  amountCents: number;
  startMonth: string;
  endMonth: string | null;
  paidBy: string;
  active: boolean;
  notes: string | null;
};

const input =
  "w-full rounded-lg border border-ink-600 bg-ink-950 px-3 py-2 text-sm text-white placeholder:text-ink-500 focus:border-accent-500 focus:outline-none";
const label = "block text-xs font-medium text-ink-400";

const toCents = (dollars: string) => {
  const value = Number(dollars);
  return Number.isFinite(value) ? Math.round(value * 100) : 0;
};
const toDollars = (cents: number) => (cents / 100).toFixed(2);

/** "2026-08" as "August 2026". */
function monthLabel(month: string): string {
  const [year, index] = month.split("-").map(Number);
  return new Date(Date.UTC(year, index - 1, 1)).toLocaleDateString("en-CA", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function BookkeepingManager({
  currency,
  thisMonth,
  categories,
  bills,
}: {
  currency: string;
  thisMonth: string;
  categories: Category[];
  bills: Bill[];
}) {
  const unconfirmed = bills.filter((bill) => !bill.active && bill.endMonth === null);

  return (
    <div className="mt-8 space-y-10">
      {unconfirmed.length > 0 && (
        <p className="rounded-xl border border-accent-500/40 bg-accent-400/5 p-4 text-sm text-ink-200">
          <strong className="font-semibold text-accent-300">
            {unconfirmed.length} {unconfirmed.length === 1 ? "bill is" : "bills are"} switched off.
          </strong>{" "}
          These arrived with starting amounts taken from your tracker. Nothing is recorded against
          your books until you check the amount and turn a bill on.
        </p>
      )}

      <RecurringBills
        bills={bills}
        categories={categories}
        currency={currency}
        thisMonth={thisMonth}
      />
      <Categories categories={categories} />
    </div>
  );
}

function RecurringBills({
  bills,
  categories,
  currency,
  thisMonth,
}: {
  bills: Bill[];
  categories: Category[];
  currency: string;
  thisMonth: string;
}) {
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({
    name: "",
    categoryId: categories.find((category) => category.active)?.id ?? "",
    amount: "",
    startMonth: thisMonth,
    paidBy: "preauthorized" as ExpensePaymentMethod,
    active: true,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setBusy(true);
    setError(null);
    const result = await createRecurringBillAction({
      name: form.name,
      categoryId: form.categoryId,
      amountCents: toCents(form.amount),
      startMonth: form.startMonth,
      endMonth: null,
      paidBy: form.paidBy,
      active: form.active,
    });
    setBusy(false);
    if (!result.ok) return setError(result.error);
    setForm({ ...form, name: "", amount: "" });
    setAdding(false);
    router.refresh();
  }

  return (
    <section>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-400">
            Monthly bills
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-ink-400">
            On the 1st of each month these are added to Expenses automatically, ready for you to
            check off. An amount that varies — hydro, gas — can be corrected on the Expenses screen
            once the real bill arrives.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setAdding((value) => !value)}
          className="rounded-lg border border-ink-600 px-4 py-2 text-sm text-ink-200 hover:border-accent-500"
        >
          {adding ? "Cancel" : "Add a bill"}
        </button>
      </div>

      {adding && (
        <div className="mt-4 rounded-2xl border border-ink-700 bg-ink-900/50 p-5">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <label className={label}>
              Name
              <input
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                placeholder="Shop rent"
                className={`${input} mt-1`}
              />
            </label>
            <label className={label}>
              Category
              <select
                value={form.categoryId}
                onChange={(event) => setForm({ ...form, categoryId: event.target.value })}
                className={`${input} mt-1`}
              >
                {categories
                  .filter((category) => category.active)
                  .map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.name}
                    </option>
                  ))}
              </select>
            </label>
            <label className={label}>
              Amount each month
              <input
                type="number"
                step="0.01"
                min="0"
                inputMode="decimal"
                value={form.amount}
                onChange={(event) => setForm({ ...form, amount: event.target.value })}
                placeholder="0.00"
                className={`${input} mt-1`}
              />
            </label>
            <label className={label}>
              Starting from
              <input
                type="month"
                value={form.startMonth}
                onChange={(event) => setForm({ ...form, startMonth: event.target.value })}
                className={`${input} mt-1`}
              />
            </label>
            <label className={label}>
              Paid by
              <select
                value={form.paidBy}
                onChange={(event) =>
                  setForm({ ...form, paidBy: event.target.value as ExpensePaymentMethod })
                }
                className={`${input} mt-1`}
              >
                {EXPENSE_PAYMENT_METHODS.map((method) => (
                  <option key={method} value={method}>
                    {EXPENSE_PAYMENT_METHOD_LABELS[method]}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-end gap-2 pb-2 text-sm text-ink-300">
              <input
                type="checkbox"
                checked={form.active}
                onChange={(event) => setForm({ ...form, active: event.target.checked })}
              />
              Start adding it now
            </label>
          </div>
          {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
          <button
            type="button"
            onClick={() => void create()}
            disabled={busy || !form.name.trim()}
            className="mt-4 rounded-lg bg-accent-400 px-5 py-2 text-sm font-semibold text-ink-950 hover:bg-accent-300 disabled:opacity-40"
          >
            {busy ? "Adding…" : "Add bill"}
          </button>
        </div>
      )}

      <div className="mt-4 space-y-2">
        {bills.length === 0 ? (
          <p className="rounded-xl border border-dashed border-ink-700 p-8 text-center text-sm text-ink-400">
            No monthly bills set up yet.
          </p>
        ) : (
          bills.map((bill) => (
            <BillRow
              key={bill.id}
              bill={bill}
              categories={categories}
              currency={currency}
              thisMonth={thisMonth}
            />
          ))
        )}
      </div>
    </section>
  );
}

function BillRow({
  bill,
  categories,
  currency,
  thisMonth,
}: {
  bill: Bill;
  categories: Category[];
  currency: string;
  thisMonth: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: bill.name,
    categoryId: bill.categoryId,
    amount: toDollars(bill.amountCents),
    startMonth: bill.startMonth,
    endMonth: bill.endMonth ?? "",
    paidBy: bill.paidBy as ExpensePaymentMethod,
    active: bill.active,
    notes: bill.notes ?? "",
  });

  const categoryName = categories.find((category) => category.id === bill.categoryId)?.name ?? "—";
  const ended = bill.endMonth !== null && bill.endMonth < thisMonth;

  async function save() {
    setBusy(true);
    setError(null);
    const result = await updateRecurringBillAction({
      billId: bill.id,
      name: form.name,
      categoryId: form.categoryId,
      amountCents: toCents(form.amount),
      startMonth: form.startMonth,
      endMonth: form.endMonth || null,
      paidBy: form.paidBy,
      active: form.active,
      notes: form.notes,
    });
    setBusy(false);
    if (!result.ok) return setError(result.error);
    setOpen(false);
    router.refresh();
  }

  async function stop() {
    setBusy(true);
    setError(null);
    const result = await stopRecurringBillAction({ billId: bill.id, endMonth: thisMonth });
    setBusy(false);
    if (!result.ok) return setError(result.error);
    router.refresh();
  }

  /** Turning a bill on or off without opening the editor — the common action. */
  async function toggleActive(active: boolean) {
    setBusy(true);
    setError(null);
    const result = await updateRecurringBillAction({
      billId: bill.id,
      name: bill.name,
      categoryId: bill.categoryId,
      amountCents: bill.amountCents,
      startMonth: bill.startMonth,
      endMonth: bill.endMonth,
      paidBy: bill.paidBy as ExpensePaymentMethod,
      active,
      notes: bill.notes ?? "",
    });
    setBusy(false);
    if (!result.ok) return setError(result.error);
    router.refresh();
  }

  return (
    <article
      className={`rounded-xl border ${
        bill.active ? "border-ink-800" : "border-ink-900 bg-ink-950/40"
      }`}
    >
      <div className="flex flex-wrap items-center gap-3 p-4">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-white">
            {bill.name}
            {ended && <span className="ml-2 text-xs text-ink-500">ended</span>}
          </p>
          <p className="mt-0.5 truncate text-xs text-ink-400">
            {categoryName} · from {monthLabel(bill.startMonth)}
            {bill.endMonth ? ` to ${monthLabel(bill.endMonth)}` : ""}
          </p>
        </div>
        <span className="text-sm font-semibold text-white">
          {formatCents(bill.amountCents, currency)}
        </span>
        <label className="flex items-center gap-2 text-xs text-ink-300">
          <input
            type="checkbox"
            checked={bill.active}
            disabled={busy || ended}
            onChange={(event) => void toggleActive(event.target.checked)}
          />
          On
        </label>
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="rounded-lg border border-ink-600 px-3 py-1.5 text-xs text-ink-200 hover:border-accent-500"
        >
          {open ? "Close" : "Edit"}
        </button>
      </div>

      {open && (
        <div className="border-t border-ink-800 p-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <label className={label}>
              Name
              <input
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                className={`${input} mt-1`}
              />
            </label>
            <label className={label}>
              Category
              <select
                value={form.categoryId}
                onChange={(event) => setForm({ ...form, categoryId: event.target.value })}
                className={`${input} mt-1`}
              >
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </select>
            </label>
            <label className={label}>
              Amount each month
              <input
                type="number"
                step="0.01"
                min="0"
                inputMode="decimal"
                value={form.amount}
                onChange={(event) => setForm({ ...form, amount: event.target.value })}
                className={`${input} mt-1`}
              />
            </label>
            <label className={label}>
              Starting from
              <input
                type="month"
                value={form.startMonth}
                onChange={(event) => setForm({ ...form, startMonth: event.target.value })}
                className={`${input} mt-1`}
              />
            </label>
            <label className={label}>
              Last month to bill (optional)
              <input
                type="month"
                value={form.endMonth}
                onChange={(event) => setForm({ ...form, endMonth: event.target.value })}
                className={`${input} mt-1`}
              />
            </label>
            <label className={label}>
              Paid by
              <select
                value={form.paidBy}
                onChange={(event) =>
                  setForm({ ...form, paidBy: event.target.value as ExpensePaymentMethod })
                }
                className={`${input} mt-1`}
              >
                {EXPENSE_PAYMENT_METHODS.map((method) => (
                  <option key={method} value={method}>
                    {EXPENSE_PAYMENT_METHOD_LABELS[method]}
                  </option>
                ))}
              </select>
            </label>
            <label className={`${label} sm:col-span-2 lg:col-span-3`}>
              Note
              <input
                value={form.notes}
                onChange={(event) => setForm({ ...form, notes: event.target.value })}
                placeholder="Optional"
                className={`${input} mt-1`}
              />
            </label>
          </div>

          {error && <p className="mt-3 text-sm text-red-400">{error}</p>}

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void save()}
              disabled={busy}
              className="rounded-lg bg-accent-400 px-4 py-2 text-sm font-semibold text-ink-950 hover:bg-accent-300 disabled:opacity-40"
            >
              {busy ? "Saving…" : "Save changes"}
            </button>
            <span className="flex-1" />
            {!ended && (
              <button
                type="button"
                onClick={() => void stop()}
                disabled={busy}
                className="rounded-lg border border-ink-600 px-4 py-2 text-sm text-ink-300 hover:border-red-800 hover:text-red-300 disabled:opacity-40"
              >
                Stop after this month
              </button>
            )}
          </div>
        </div>
      )}
    </article>
  );
}

function Categories({ categories }: { categories: Category[] }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [isPayroll, setIsPayroll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setBusy(true);
    setError(null);
    const result = await createExpenseCategoryAction({ name, isPayroll });
    setBusy(false);
    if (!result.ok) return setError(result.error);
    setName("");
    setIsPayroll(false);
    router.refresh();
  }

  return (
    <section>
      <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-400">
        Expense categories
      </h2>
      <p className="mt-1 max-w-2xl text-sm text-ink-400">
        Categories are never deleted, because past expenses are filed under them. Switch one off and
        it disappears from the picker while your history keeps reporting correctly.
      </p>

      <div className="mt-4 space-y-2">
        {categories.map((category) => (
          <CategoryRow key={category.id} category={category} />
        ))}
      </div>

      <div className="mt-4 flex flex-wrap items-end gap-3 rounded-xl border border-ink-800 p-4">
        <label className={`${label} min-w-56 flex-1`}>
          New category
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. Uniforms"
            className={`${input} mt-1`}
          />
        </label>
        <label className="flex items-center gap-2 pb-2 text-sm text-ink-300">
          <input
            type="checkbox"
            checked={isPayroll}
            onChange={(event) => setIsPayroll(event.target.checked)}
          />
          This is staff pay
        </label>
        <button
          type="button"
          onClick={() => void create()}
          disabled={busy || !name.trim()}
          className="rounded-lg border border-ink-600 px-4 py-2 text-sm text-ink-200 hover:border-accent-500 disabled:opacity-40"
        >
          {busy ? "Adding…" : "Add category"}
        </button>
      </div>
      {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
    </section>
  );
}

function CategoryRow({ category }: { category: Category }) {
  const router = useRouter();
  const [name, setName] = useState(category.name);
  const [isPayroll, setIsPayroll] = useState(category.isPayroll);
  const [active, setActive] = useState(category.active);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty =
    name !== category.name || isPayroll !== category.isPayroll || active !== category.active;

  async function save() {
    setBusy(true);
    setError(null);
    const result = await updateExpenseCategoryAction({
      categoryId: category.id,
      name,
      isPayroll,
      active,
    });
    setBusy(false);
    if (!result.ok) return setError(result.error);
    router.refresh();
  }

  return (
    <div
      className={`flex flex-wrap items-center gap-3 rounded-xl border p-3 ${
        active ? "border-ink-800" : "border-ink-900 bg-ink-950/40"
      }`}
    >
      <input
        value={name}
        onChange={(event) => setName(event.target.value)}
        className={`${input} min-w-48 flex-1`}
      />
      <label className="flex items-center gap-2 text-xs text-ink-300">
        <input
          type="checkbox"
          checked={isPayroll}
          onChange={(event) => setIsPayroll(event.target.checked)}
        />
        Staff pay
      </label>
      <label className="flex items-center gap-2 text-xs text-ink-300">
        <input
          type="checkbox"
          checked={active}
          onChange={(event) => setActive(event.target.checked)}
        />
        In use
      </label>
      <button
        type="button"
        onClick={() => void save()}
        disabled={busy || !dirty}
        className="rounded-lg border border-ink-600 px-3 py-1.5 text-xs text-ink-200 hover:border-accent-500 disabled:opacity-30"
      >
        {busy ? "Saving…" : "Save"}
      </button>
      {error && <p className="w-full text-sm text-red-400">{error}</p>}
    </div>
  );
}
