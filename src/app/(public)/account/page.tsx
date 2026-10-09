import Link from "next/link";
import { Container } from "@/components/ui";
import { InvoicePicker } from "@/components/invoice-picker";
import { accountCustomers, getAccountSession } from "@/lib/accounts/session";
import { loadAccountOverview } from "@/lib/accounts/overview";
import { formatPhone } from "@/lib/phone";
import { getSettings } from "@/lib/settings";
import { confirmAccountPaymentAction, signOutAction, startAccountInvoicesPaymentAction } from "./actions";
import { MembershipCard } from "./membership-card";
import { SignIn } from "./sign-in";

export const metadata = { title: "My Account", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

const focusRing = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-400";

export default async function AccountPage() {
  const session = await getAccountSession();
  const settings = await getSettings();
  if (!session) {
    return (
      <Container className="py-12 sm:py-16">
        <SignIn />
        <p className="mx-auto mt-6 max-w-md text-center text-sm text-ink-400">
          Members manage their plan, book their monthly wash and pay invoices here.{" "}
          <Link href="/winter" className="text-accent-300 underline-offset-4 hover:underline">
            See the winter plans
          </Link>
        </p>
      </Container>
    );
  }

  const customers = await accountCustomers(session);
  const overview = await loadAccountOverview(
    customers.map((c) => c.id),
    settings,
  );
  const name = customers[0]?.firstName;
  const contactLabel = session.channel === "email" ? session.contact : formatPhone(session.contact);

  return (
    <Container className="max-w-5xl py-10 sm:py-14">
      <header className="flex flex-wrap items-end justify-between gap-4 rounded-[2rem] border border-accent-500/25 bg-gradient-to-br from-[#0B2A4A] via-[#0B2A4A]/80 to-ink-950 p-6 shadow-2xl shadow-black/25 sm:p-9">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-accent-300">{settings.businessName}</p>
          <h1 className="mt-3 text-3xl font-bold tracking-tight text-white sm:text-4xl">{name ? `Hi, ${name}` : "Your account"}</h1>
          <p className="mt-2 text-sm text-ink-300">Signed in as {contactLabel}</p>
        </div>
        <form action={signOutAction}>
          <button type="submit" className={`min-h-11 rounded-xl border border-ink-600 px-4 text-sm text-ink-200 hover:bg-ink-800 ${focusRing}`}>
            Sign out
          </button>
        </form>
      </header>

      <section aria-labelledby="account-memberships" className="mt-10">
        <h2 id="account-memberships" className="text-xl font-semibold text-white">Memberships</h2>
        <div className="mt-4 space-y-4">
          {overview.memberships.map((membership) => (
            <MembershipCard key={membership.id} membership={membership} />
          ))}
          {overview.memberships.length === 0 && (
            <div className="rounded-2xl border border-dashed border-ink-700 bg-ink-900/25 p-6 text-sm text-ink-300">
              <p>You don&apos;t have a membership yet.</p>
              <Link href="/winter" className="mt-3 inline-flex min-h-11 items-center font-semibold text-accent-300 underline-offset-4 hover:underline">
                See Winter Shield plans →
              </Link>
            </div>
          )}
        </div>
      </section>

      <section aria-labelledby="account-passes" className="mt-10">
        <h2 id="account-passes" className="text-xl font-semibold text-white">Winter Pass</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          {overview.passes.map((pass) => (
            <article key={pass.id} className="rounded-2xl border border-ink-700/70 bg-ink-900/60 p-5 shadow-lg shadow-black/10">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-accent-300">Winter Pass</p>
              <h3 className="mt-1 font-semibold text-white">{pass.vehicleLabel}</h3>
              <p className="mt-3 text-3xl font-bold text-white">
                {pass.washesLeft}
                <span className="text-base font-medium text-ink-400"> of {pass.washesTotal} washes left</span>
              </p>
              <p className="mt-1 text-xs text-ink-400">Valid {pass.validLabel} · free underbody salt flush every wash</p>
              {pass.washesLeft > 0 && (
                <a
                  href={`/account/book?vehicle=${pass.vehicleId}&use=pass`}
                  className={`mt-4 inline-flex min-h-11 items-center rounded-xl bg-accent-400 px-5 text-sm font-semibold text-ink-950 hover:bg-accent-300 ${focusRing}`}
                >
                  Book a pass wash
                </a>
              )}
            </article>
          ))}
          {overview.passes.length === 0 && (
            <p className="rounded-2xl border border-dashed border-ink-700 bg-ink-900/25 p-5 text-sm text-ink-300 sm:col-span-2">
              No Winter Pass on file.{" "}
              <Link href="/account/winter-pass" className="font-semibold text-accent-300 underline-offset-4 hover:underline">
                Get 4 winter hand washes →
              </Link>
            </p>
          )}
        </div>
      </section>

      <section aria-labelledby="account-appointments" className="mt-10">
        <h2 id="account-appointments" className="text-xl font-semibold text-white">Upcoming visits</h2>
        <div className="mt-4 space-y-2">
          {overview.appointments.map((appointment) => (
            <div key={appointment.id} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-ink-700/70 bg-ink-900/60 p-4 text-sm">
              <span>
                <span className="block font-medium text-white">{appointment.whenLabel}</span>
                <span className="text-xs text-ink-400">{appointment.vehicleLabel}</span>
              </span>
              <span className="text-ink-300">
                {appointment.totalLabel}
                <span className="ml-3 rounded-full border border-accent-500/25 px-2.5 py-1 text-xs capitalize text-ink-200">
                  {appointment.status.replaceAll("_", " ")}
                </span>
              </span>
            </div>
          ))}
          {overview.appointments.length === 0 && (
            <p className="rounded-2xl border border-dashed border-ink-700 bg-ink-900/25 p-5 text-sm text-ink-400">No upcoming visits.</p>
          )}
          <p className="text-xs text-ink-500">
            To change or cancel a visit, call {settings.phone} or reply to your confirmation message.
          </p>
        </div>
      </section>

      <section aria-labelledby="account-invoices" className="mt-10">
        <h2 id="account-invoices" className="text-xl font-semibold text-white">Invoices</h2>
        <div className="mt-4">
          <InvoicePicker
            invoices={overview.invoices}
            currency={settings.currency}
            viewHref="/account/invoices/{id}"
            startPayment={startAccountInvoicesPaymentAction}
            confirmPayment={confirmAccountPaymentAction}
          />
        </div>
      </section>
    </Container>
  );
}
