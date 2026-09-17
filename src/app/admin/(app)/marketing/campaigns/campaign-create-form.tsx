"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { createCampaignAction } from "../actions";
import { card, heading, input, label, primaryButton, subtle, textarea } from "../ui";

/**
 * A starting point, not finished copy — the owner edits before anything sends.
 * It carries the opt-out line the compliance check requires, so the default
 * state of a new campaign is a compliant one.
 *
 * There used to be a win-back starter here too. Win-backs moved to the Outreach
 * screen, where the people are already in the system and the message is written
 * beside the list it is going to; what is left is the case this screen is for —
 * a list of strangers somebody pasted in.
 */
const FLEET_TEMPLATES = {
  sms: `Hi {{FirstName}}, it's [your name] from Personal Touch Car Detailing in Hamilton. Great meeting you. We're under new ownership and would love to work with {{Company}} — we offer preferred fleet pricing. Reply here if you'd like a quote. Reply STOP to opt out.`,
  email: `Hi {{FirstName}},

It was great meeting you. I'm [your name] from Personal Touch Car Detailing here in Hamilton.

We're under new ownership and would love to work with {{Company}}. We offer preferred fleet and commercial detailing rates, and we can come to you.

If you'd like a quote, just reply to this email and I'll put one together.

Thanks,
[your name]`,
} as const;

/** True while the box still holds an untouched starter, on either channel. */
function isUntouched(body: string): boolean {
  if (body.trim().length === 0) return true;
  return body === FLEET_TEMPLATES.sms || body === FLEET_TEMPLATES.email;
}

export function CampaignCreateForm() {
  const router = useRouter();
  const [channel, setChannel] = useState<"sms" | "email">("sms");
  const [body, setBody] = useState<string>(FLEET_TEMPLATES.sms);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Only ever replaces copy that is still an untouched starter, so switching
  // channel by accident cannot discard something the owner wrote.
  function switchChannel(next: "sms" | "email") {
    setChannel(next);
    if (isUntouched(body)) setBody(FLEET_TEMPLATES[next]);
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
        Write the message first. You paste the contacts in, test it on your own phone, and send in
        batches on the next screen.
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
                    ? "border-[#0B2A4A] bg-[#0B2A4A] text-white admin-on-dark"
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
          {"{{FirstName}}"}, {"{{Company}}"} and {"{{LastVisit}}"} are filled in for each contact.
          {channel === "email"
            ? " Your business name, address and an unsubscribe link are added to the bottom of every email automatically. You can paste a designed HTML template on the next screen."
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
