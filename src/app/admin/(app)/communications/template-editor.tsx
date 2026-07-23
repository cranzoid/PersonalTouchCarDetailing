"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { updateMessageTemplateAction } from "./actions";

export type EditableMessageTemplate = {
  id: string;
  key: string;
  channel: string;
  subject: string | null;
  body: string;
  active: boolean;
  updatedAt: string;
};

export function TemplateEditor({
  template,
  supportedVariables,
  detectedVariables,
}: {
  template: EditableMessageTemplate;
  supportedVariables: readonly string[] | null;
  detectedVariables: readonly string[];
}) {
  const router = useRouter();
  const [form, setForm] = useState({
    channel: template.channel === "sms" ? "sms" : "email",
    subject: template.subject ?? "",
    body: template.body,
    active: template.active,
  });
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setResult(null);
    const response = await updateMessageTemplateAction({
      templateId: template.id,
      ...form,
    });
    setBusy(false);
    if (!response.ok) {
      setResult({ ok: false, text: response.error });
      return;
    }
    setResult({ ok: true, text: "Template saved." });
    router.refresh();
  }

  const input =
    "w-full rounded-lg border border-ink-600 bg-ink-950 px-3 py-2 text-sm text-white placeholder:text-ink-600";

  return (
    <form onSubmit={save} className="rounded-xl border border-ink-800 bg-ink-900/40 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-mono text-sm font-semibold text-white">{template.key}</h2>
          <p className="mt-1 text-xs text-ink-400">
            Last updated {new Date(template.updatedAt).toLocaleString("en-CA")}
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm text-ink-300">
          <input
            type="checkbox"
            checked={form.active}
            onChange={(event) => setForm({ ...form, active: event.target.checked })}
          />
          Active
        </label>
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-[10rem_1fr]">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-ink-400">Channel</span>
          <select
            value={form.channel}
            onChange={(event) => setForm({ ...form, channel: event.target.value })}
            className={input}
          >
            <option value="email">Email</option>
            <option value="sms">SMS</option>
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-ink-400">Subject</span>
          <input
            value={form.subject}
            onChange={(event) => setForm({ ...form, subject: event.target.value })}
            disabled={form.channel === "sms"}
            required={form.channel === "email"}
            maxLength={300}
            placeholder={form.channel === "sms" ? "SMS messages do not use a subject" : "Message subject"}
            className={`${input} disabled:cursor-not-allowed disabled:opacity-50`}
          />
        </label>
      </div>

      <label className="mt-4 block">
        <span className="mb-1 block text-xs font-medium text-ink-400">Body</span>
        <textarea
          value={form.body}
          onChange={(event) => setForm({ ...form, body: event.target.value })}
          required
          maxLength={20_000}
          rows={10}
          className={`${input} font-mono leading-relaxed`}
        />
      </label>

      <div className="mt-4 rounded-lg border border-ink-800 bg-ink-950/50 p-3">
        {supportedVariables ? (
          <>
            <p className="text-xs font-medium text-ink-300">Variables supplied by this workflow</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {supportedVariables.map((variable) => (
                <code key={variable} className="rounded bg-ink-800 px-2 py-1 text-xs text-accent-300">
                  {`{{${variable}}}`}
                </code>
              ))}
            </div>
            <p className="mt-2 text-xs text-ink-400">
              Other variable names are rejected because the renderer would replace them with blank text.
            </p>
          </>
        ) : (
          <>
            <p className="text-xs font-medium text-ink-300">No documented variable contract</p>
            <p className="mt-1 text-xs text-ink-400">
              This existing template key has no known call-site contract. Keep its current variables
              unless the sending workflow is reviewed too.
            </p>
            {detectedVariables.length > 0 && (
              <p className="mt-2 text-xs text-ink-300">
                Currently used: {detectedVariables.map((variable) => `{{${variable}}}`).join(", ")}
              </p>
            )}
          </>
        )}
      </div>

      {result && (
        <p
          role="status"
          aria-live="polite"
          className={`mt-3 text-sm ${result.ok ? "text-emerald-300" : "text-red-400"}`}
        >
          {result.text}
        </p>
      )}
      <button
        type="submit"
        disabled={busy}
        className="mt-4 rounded-lg bg-accent-400 px-5 py-2.5 text-sm font-semibold text-ink-950 hover:bg-accent-300 disabled:opacity-40"
      >
        {busy ? "Saving…" : "Save Template"}
      </button>
    </form>
  );
}
