"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { primaryButton, secondaryButton } from "../ui";
import { resendOfferClaimAction, voidOfferClaimAction } from "./actions";

/**
 * The two things staff do to a claim from the list: send the code again, and
 * release it.
 *
 * Releasing is the escape hatch for the one-per-person cap — a mistyped number,
 * a duplicate, a cancelled booking. It does not release a plate that has
 * already had the wash, and the button says so before it is pressed.
 */
export function ClaimRowActions({
  claimId,
  code,
  canResend,
  canRelease,
}: {
  claimId: string;
  code: string;
  canResend: boolean;
  canRelease: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex flex-wrap justify-end gap-1.5">
        {canResend && (
          <button
            type="button"
            disabled={pending}
            className={`${secondaryButton} min-h-9 px-3 text-xs`}
            onClick={() =>
              start(async () => {
                const res = await resendOfferClaimAction({ claimId });
                setMessage(res.ok ? { ok: true, text: res.message } : { ok: false, text: res.error });
              })
            }
          >
            Send again
          </button>
        )}
        {canRelease && !confirming && (
          <button
            type="button"
            className={`${secondaryButton} min-h-9 px-3 text-xs`}
            onClick={() => setConfirming(true)}
          >
            Release
          </button>
        )}
        {canRelease && confirming && (
          <>
            <button
              type="button"
              disabled={pending}
              className={`${primaryButton} min-h-9 px-3 text-xs`}
              onClick={() =>
                start(async () => {
                  const res = await voidOfferClaimAction({ claimId });
                  setMessage(res.ok ? { ok: true, text: res.message } : { ok: false, text: res.error });
                  setConfirming(false);
                  if (res.ok) router.refresh();
                })
              }
            >
              Release {code}
            </button>
            <button
              type="button"
              className={`${secondaryButton} min-h-9 px-3 text-xs`}
              onClick={() => setConfirming(false)}
            >
              Cancel
            </button>
          </>
        )}
      </div>
      {confirming && (
        <p className="max-w-[18rem] text-right text-[0.7rem] leading-4 text-[#8A681F]">
          This lets that phone number and email claim the offer again. A plate that has already had
          the wash stays used.
        </p>
      )}
      {message && (
        <p
          role="status"
          className={`max-w-[18rem] text-right text-[0.7rem] leading-4 ${message.ok ? "text-emerald-700" : "text-red-700"}`}
        >
          {message.text}
        </p>
      )}
    </div>
  );
}
