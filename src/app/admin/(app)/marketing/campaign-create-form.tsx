"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { createCampaignAction } from "./actions";
import { card, heading, input, label, primaryButton, subtle, textarea } from "./ui";

/**
 * Starting points, not finished copy — the owner edits before anything sends.
 * All of them carry the opt-out line the compliance check requires, so the
 * default state of a new campaign is a compliant one.
 */
const TEMPLATES = {
  fleet: {
    sms: `Hi {{FirstName}}, it's [your name] from Personal Touch Car Detailing in Hamilton. Great meeting you. We're under new ownership and would love to work with {{Company}} — we offer preferred fleet pricing. Reply here if you'd like a quote. Reply STOP to opt out.`,
    email: `Hi {{FirstName}},

It was great meeting you. I'm [your name] from Personal Touch Car Detailing here in Hamilton.

We're under new ownership and would love to work with {{Company}}. We offer preferred fleet and commercial detailing rates, and we can come to you.

If you'd like a quote, just reply to this email and I'll put one together.

Thanks,
[your name]`,
  },
  winback: {
    sms: `Hi {{FirstName}}, it's Personal Touch Car Detailing in Hamilton. We had you booked in on {{LastVisit}} and never got you back in — happy to find you a new slot whenever suits. Reply here or call us. Reply STOP to opt out.`,
    email: `Hi {{FirstName}},

We had you booked in with us on {{LastVisit}} and it didn't end up going ahead — no problem at all.

If you'd still like the work done, just reply to this email and we'll find a time that suits you better. We can usually fit something in within the week.

Thanks,
Personal Touch Car Detailing`,
  },
} as const;

const PURPOSES = [
  { value: "winback", label: "Win back a no-show or cancellation" },
  { value: "fleet", label: "New fleet or commercial prospect" },
] as const;

type Purpose = (typeof PURPOSES)[number]["value"];

/** True while the box still holds an untouched starter, in any combination. */
function isUntouched(body: string): boolean {
  if (body.trim().length === 0) return true;
  return PURPOSES.some((p) => body === TEMPLATES[p.value].sms || body === TEMPLATES[p.value].email);
}

export function CampaignCreateForm() {
  const router = useRouter();
  const [channel, setChannel] = useState<"sms" | "email">("sms");
  const [purpose, setPurpose] = useState<Purpose>("winback");
  const [body, setBody] = useState<string>(TEMPLATES.winback.sms);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Only ever replaces copy that is still an untouched starter, so switching
  // channel or purpose by accident cannot discard something the owner wrote.
  function switchChannel(next: "sms" | "email") {
    setChannel(next);
    if (isUntouched(body)) setBody(TEMPLATES[purpose][next]);
  }

  function switchPurpose(next: Purpose) {
    setPurpose(next);
    if (isUntouched(body)) setBody(TEMPLATES[next][channel]);
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

      <fieldset className="mt-4">
        <legend className={label}>What is this for?</legend>
        <div className="mt-1.5 flex flex-wrap gap-2">
          {PURPOSES.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => switchPurpose(option.value)}
              className={`min-h-10 rounded-xl border px-3.5 text-xs font-semibold transition ${
                purpose === option.value
                  ? "border-[#0B2A4A] bg-[#0B2A4A] text-white admin-on-dark"
                  : "border-[#D5DEE7] bg-white text-[#42536A] hover:border-[#0B2A4A]/30"
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
        <span className="mt-1.5 block text-[11px] text-[#5A6B7D]">
          Only changes the starting wording. You pick who it goes to on the next screen.
        </span>
      </fieldset>

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
