"use client";

import { useState } from "react";
import type { IntegrationFieldStatus, IntegrationKey } from "@/lib/integrations";
import {
  clearIntegrationCredentialAction,
  saveIntegrationCredentialsAction,
  sendTestMessageAction,
} from "./actions";

type Message = { ok: boolean; text: string } | null;

const EMPTY = {
  twilioAccountSid: "",
  twilioAuthToken: "",
  twilioFromNumber: "",
  resendApiKey: "",
  emailFrom: "",
};

export function IntegrationsForm({
  status,
  canStore,
}: {
  status: IntegrationFieldStatus[];
  canStore: boolean;
}) {
  const [form, setForm] = useState(EMPTY);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Message>(null);
  const [testTo, setTestTo] = useState({ sms: "", email: "" });
  const [testMsg, setTestMsg] = useState<{ sms: Message; email: Message }>({ sms: null, email: null });

  const byKey = new Map(status.map((s) => [s.key, s]));
  const input = "w-full rounded-lg border border-ink-600 bg-ink-950 px-3 py-2 text-sm text-white";
  const label = "mb-1 block text-xs text-ink-400";

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    const res = await saveIntegrationCredentialsAction(form);
    setBusy(false);
    if (res.ok) setForm(EMPTY);
    setMsg({ ok: res.ok, text: res.ok ? res.message ?? "Saved." : res.error });
  }

  async function clear(key: IntegrationKey) {
    setBusy(true);
    setMsg(null);
    const res = await clearIntegrationCredentialAction(key);
    setBusy(false);
    setMsg({ ok: res.ok, text: res.ok ? res.message ?? "Removed." : res.error });
  }

  async function test(channel: "sms" | "email") {
    setBusy(true);
    setTestMsg((prev) => ({ ...prev, [channel]: null }));
    const res = await sendTestMessageAction({ channel, to: testTo[channel] });
    setBusy(false);
    setTestMsg((prev) => ({
      ...prev,
      [channel]: { ok: res.ok, text: res.ok ? res.message ?? "Sent." : res.error },
    }));
  }

  function credentialField(key: IntegrationKey, title: string, placeholder: string, secret: boolean) {
    const current = byKey.get(key);
    return (
      <label className="block">
        <span className={label}>{title}</span>
        <input
          className={input}
          type={secret ? "password" : "text"}
          autoComplete="off"
          placeholder={current?.configured ? `Current: ${current.hint}` : placeholder}
          value={form[key as keyof typeof form]}
          onChange={(e) => setForm({ ...form, [key]: e.target.value })}
        />
        <span className="mt-1 flex items-center gap-2 text-xs">
          {current?.configured ? (
            <>
              <span className="text-emerald-300">
                Set{current.source === "environment" ? " via environment" : ""}
              </span>
              {current.source === "stored" && (
                <button
                  type="button"
                  onClick={() => clear(key)}
                  disabled={busy}
                  className="text-ink-400 underline hover:text-white disabled:opacity-50"
                >
                  Remove
                </button>
              )}
            </>
          ) : (
            <span className="text-amber-300">Not configured</span>
          )}
        </span>
      </label>
    );
  }

  function testRow(channel: "sms" | "email", placeholder: string) {
    const result = testMsg[channel];
    return (
      <div className="mt-3 flex flex-wrap items-start gap-2">
        <input
          className={`${input} max-w-xs`}
          placeholder={placeholder}
          value={testTo[channel]}
          onChange={(e) => setTestTo({ ...testTo, [channel]: e.target.value })}
        />
        <button
          type="button"
          onClick={() => test(channel)}
          disabled={busy || !testTo[channel].trim()}
          className="rounded-lg border border-ink-600 px-4 py-2 text-sm font-medium text-ink-200 hover:bg-ink-800 disabled:opacity-40"
        >
          Send test {channel === "sms" ? "SMS" : "email"}
        </button>
        {result && (
          <p className={`w-full text-xs ${result.ok ? "text-emerald-300" : "text-red-300"}`}>{result.text}</p>
        )}
      </div>
    );
  }

  return (
    <form onSubmit={save} className="mt-8 space-y-8">
      {!canStore && (
        <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
          SETTINGS_ENCRYPTION_KEY is not configured on this environment, so new credentials cannot be
          saved here. Any values already supplied as environment variables still work.
        </p>
      )}

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-ink-300">SMS — Twilio</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          {credentialField("twilioAccountSid", "Account SID", "AC…", true)}
          {credentialField("twilioAuthToken", "Auth token", "Your Twilio auth token", true)}
          {credentialField("twilioFromNumber", "From number", "+1 905 555 0143", false)}
        </div>
        {testRow("sms", "+1 905 555 0143")}
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-ink-300">Email — Resend</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          {credentialField("resendApiKey", "API key", "re_…", true)}
          {credentialField("emailFrom", "From address", "bookings@personaltouchcardetailing.ca", false)}
        </div>
        <p className="mt-2 text-xs text-ink-500">
          The from address must be on a domain you have verified in Resend, or every send will be
          rejected.
        </p>
        {testRow("email", "you@example.com")}
      </section>

      {msg && <p className={msg.ok ? "text-sm text-emerald-300" : "text-sm text-red-300"}>{msg.text}</p>}
      <button
        type="submit"
        disabled={busy || !canStore}
        className="rounded-lg bg-accent-400 px-6 py-3 text-sm font-semibold text-ink-950 hover:bg-accent-300 disabled:opacity-40"
      >
        {busy ? "Saving…" : "Save credentials"}
      </button>
    </form>
  );
}
