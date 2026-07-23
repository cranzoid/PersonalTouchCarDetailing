import { NextResponse } from "next/server";
import { syncOverdueInvoices } from "@/lib/invoices";
import { sendDueAppointmentReminders, sendDueReviewRequests, sendDueMaintenanceReminders } from "@/lib/scheduling";
import { getPool } from "@/db";
import { pruneExpiredRateLimits } from "@/lib/rate-limit";

const CRON_ADVISORY_LOCK = 7_214_031;

/**
 * Single scheduled-task entry point. Point one external scheduler (system
 * cron, Vercel Cron, etc.) at this URL on a timer — e.g. hourly — with
 * `Authorization: Bearer $CRON_SECRET`. Runs every time-driven background
 * task the app needs: overdue invoice status flips, appointment reminders,
 * post-payment review requests, and maintenance reminders. The admin/portal
 * invoice pages also flip overdue status opportunistically on read, so that
 * one task is a robustness net for invoices nobody views — the other three
 * have no on-read equivalent and depend entirely on this endpoint running.
 */
async function runTick(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return new NextResponse("CRON_SECRET not configured", { status: 501 });

  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${secret}`) return new NextResponse("Unauthorized", { status: 401 });

  // Hold a Postgres session-level advisory lock for the full tick. This works
  // across app instances and prevents overlapping schedulers from selecting
  // and sending the same reminder before either one stamps its record.
  const client = await getPool().connect();
  try {
    const lock = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock($1) AS acquired",
      [CRON_ADVISORY_LOCK],
    );
    if (!lock.rows[0]?.acquired) {
      return NextResponse.json({ ok: true, skipped: "another tick is already running" });
    }

    const overdueInvoices = await syncOverdueInvoices();
    const appointmentReminders = await sendDueAppointmentReminders();
    const reviewRequests = await sendDueReviewRequests();
    const maintenanceReminders = await sendDueMaintenanceReminders();
    const expiredRateLimitBuckets = await pruneExpiredRateLimits();

    return NextResponse.json({
      ok: true,
      overdueInvoices: overdueInvoices.length,
      appointmentReminders,
      reviewRequests,
      maintenanceReminders,
      expiredRateLimitBuckets,
    });
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [CRON_ADVISORY_LOCK]).catch(() => undefined);
    client.release();
  }
}

/** Vercel Cron invokes GET; system cron/curl integrations may use POST. */
export const GET = runTick;
export const POST = runTick;
