"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireStaff, AuthError } from "@/lib/auth/session";
import { getSettings } from "@/lib/settings";
import {
  createBookingPause,
  endBookingPause,
  localDateTimeToUtc,
  PauseError,
  presetWindow,
} from "@/lib/booking/pauses";

export type ActionResult = { ok: true } | { ok: false; error: string };

const LOCAL_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

const pauseInput = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("preset"),
    preset: z.enum(["rest_of_today", "tomorrow"]),
    reason: z.string().trim().max(500).optional(),
  }),
  z.object({
    kind: z.literal("custom"),
    startsLocal: z.string().regex(LOCAL_DATE_TIME),
    endsLocal: z.string().regex(LOCAL_DATE_TIME),
    reason: z.string().trim().max(500).optional(),
  }),
]);

function refresh() {
  revalidatePath("/admin/appointments/pause");
  revalidatePath("/admin/appointments");
}

export async function createBookingPauseAction(raw: unknown): Promise<ActionResult> {
  try {
    const staff = await requireStaff("manage_bookings");
    const parsed = pauseInput.safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Choose when the pause starts and ends." };
    const input = parsed.data;
    const { timezone } = await getSettings();
    const window =
      input.kind === "preset"
        ? presetWindow(input.preset, timezone)
        : {
            startsAt: localDateTimeToUtc(input.startsLocal, timezone),
            endsAt: localDateTimeToUtc(input.endsLocal, timezone),
          };
    await createBookingPause({ ...window, reason: input.reason, staffId: staff.id });
    refresh();
    return { ok: true };
  } catch (err) {
    if (err instanceof AuthError || err instanceof PauseError) return { ok: false, error: err.message };
    console.error("createBookingPauseAction failed", err);
    return { ok: false, error: "Something went wrong" };
  }
}

export async function endBookingPauseAction(raw: unknown): Promise<ActionResult> {
  try {
    const staff = await requireStaff("manage_bookings");
    const parsed = z.object({ pauseId: z.string().min(1) }).safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Invalid pause" };
    await endBookingPause({ pauseId: parsed.data.pauseId, staffId: staff.id });
    refresh();
    return { ok: true };
  } catch (err) {
    if (err instanceof AuthError || err instanceof PauseError) return { ok: false, error: err.message };
    console.error("endBookingPauseAction failed", err);
    return { ok: false, error: "Something went wrong" };
  }
}
