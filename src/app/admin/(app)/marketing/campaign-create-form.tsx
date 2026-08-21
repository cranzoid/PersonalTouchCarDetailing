"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { createCampaignAction } from "./actions";
import { card, heading, input, label, primaryButton, subtle, textarea } from "./ui";

/**
 * Starting points, not finished copy — the owner edits before anything sends.
 * Both carry the opt-out line the compliance check requires, so the default
 * state of a new campaign is a compliant one.
 */
const TEMPLATES = {
  sms: `Hi {{FirstName}}, it's [your name] from Personal Touch Car Detailing in Hamilton. Great meeting you. We're under new ownership and would love to work with {{Company}} — we offer preferred fleet pricing. Reply here if you'd like a quote. Reply STOP to opt out.`,
  email: `Hi {{FirstName}},

It was great meeting you. I'm [your name] from Personal Touch Car Detailing here in Hamilton.

We're under new ownership and would love to work with {{Company}}. We offer preferred fleet and commercial detailing rates, and we can come to you.

If you'd like a quote, just reply to this email and I'll put one together.

Thanks,
[your name]`,
};

export function CampaignCreateForm() {
  const router = useRouter();
  const [channel, setChannel] = useState<"sms" | "email">("sms");
  const [body, setBody] = useState(TEMPLATES.sms);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function switchChannel(next: "sms" | "email") {
    setChannel(next);
    // Only replace copy that is still the untouched template, so switching
    // channel by accident cannot discard something the owner wrote.
    if (body === TEMPLATES.sms || body === TEMPLATES.email || body.trim().length === 0) {
      setBody(TEMPLATES[next]);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const form = new FormData(event.currentTarget);
    const result = await createCampaignAction({
      name: form.get("name"),
      channel,
      subject: form.get("subject") ?? undefined,
      body,
    });
    setBusy(false);
    if (!result.ok) return setError(result.error);
    router.push(`/admin/marketing/${result.campaignId}`);
    router.refresh();
  }

  return (
    <form onSubmit={submit} className={card}>
      <h2 className={heading}>New campaign</h2>
      <p className={`mt-1 ${subtle}`}>
        Write the message first. You add contacts, test it on your own phone, and send in batches on
        the next screen.
      </p>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <label className={label}>
          Campaign name
          <input name="name" required maxLength={120} placeholder="Fleet outreach — August" className={input} />
          <span className="mt-1 block text-[11px] font-normal text-[#8494A5]">Internal only. Contacts never see this.</span>
        </label>

        <fieldset>
          <legend className={label}>Channel</legend>
          <div className="mt-1.5 flex gap-2">
            {(["sms", "email"] as const).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => switchChannel(option)}
                className={`min-h-11 flex-1 rounded-xl border px-4 text-sm font-semibold transition ${
                  channel === option
                    ? "border-[#0B2A4A] bg-[#0B2A4A] text-white"
                    : "border-[#D5DEE7] bg-white text-[#42536A] hover:border-[#0B2A4A]/30"
                }`}
              >
                {option === "sms" ? "Text message" : "Email"}
              </button>
            ))}
          </div>
        </fieldset>
      </div>

      {channel === "email" && (
        <label className={`mt-4 block ${label}`}>
          Subject line
          <input name="subject" maxLength={200} placeholder="Fleet detailing for {{Company}}" className={input} />
        </label>
      )}

      <label className={`mt-4 block ${label}`}>
        Message
        <textarea
          name="body"
          required
          rows={channel === "sms" ? 5 : 12}
          value={body}
          onChange={(event) => setBody(event.target.value)}
          className={textarea}
        />
        <span className="mt-1 block text-[11px] font-normal text-[#8494A5]">
          {"{{FirstName}}"} and {"{{Company}}"} are filled in for each contact.
          {channel === "email"
            ? " Your business name, address and an unsubscribe link are added to the bottom of every email automatically."
            : " Texts must tell people how to opt out — keep the STOP line."}
        </span>
      </label>

      <div className="mt-5 flex items-center gap-3">
        <button disabled={busy} className={primaryButton}>
          {busy ? "Creating…" : "Create campaign"}
        </button>
        {error && <p className="text-sm text-[#8B3F3F]">{error}</p>}
      </div>
    </form>
  );
}
