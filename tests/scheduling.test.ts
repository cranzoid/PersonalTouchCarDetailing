import { describe, expect, it } from "vitest";
import { isAppointmentReminderDue, isReviewRequestDue, isMaintenanceReminderDue } from "../src/lib/scheduling";
import { isTerminalTemplateDelivery, resolveTemplateDestination } from "../src/lib/messaging";

const now = new Date("2026-07-20T12:00:00Z");
const hoursFromNow = (h: number) => new Date(now.getTime() + h * 3600_000);

describe("isAppointmentReminderDue", () => {
  it("is due when a confirmed appointment starts within the lead window", () => {
    expect(
      isAppointmentReminderDue({ status: "confirmed", reminderSentAt: null, startsAt: hoursFromNow(12) }, now, 24),
    ).toBe(true);
  });

  it("is not due when the appointment starts further out than the lead window", () => {
    expect(
      isAppointmentReminderDue({ status: "confirmed", reminderSentAt: null, startsAt: hoursFromNow(48) }, now, 24),
    ).toBe(false);
  });

  it("is not due once a reminder has already been sent", () => {
    expect(
      isAppointmentReminderDue({ status: "confirmed", reminderSentAt: now, startsAt: hoursFromNow(12) }, now, 24),
    ).toBe(false);
  });

  it("is not due for a non-confirmed appointment", () => {
    expect(
      isAppointmentReminderDue({ status: "pending", reminderSentAt: null, startsAt: hoursFromNow(12) }, now, 24),
    ).toBe(false);
  });

  it("is not due once the appointment has already started", () => {
    expect(
      isAppointmentReminderDue({ status: "confirmed", reminderSentAt: null, startsAt: hoursFromNow(-1) }, now, 24),
    ).toBe(false);
  });
});

describe("isReviewRequestDue", () => {
  it("is due once the delay has elapsed on a paid invoice", () => {
    expect(isReviewRequestDue({ status: "paid", paidAt: hoursFromNow(-25), reviewRequestSentAt: null }, now, 24)).toBe(true);
  });

  it("is not due before the delay elapses", () => {
    expect(isReviewRequestDue({ status: "paid", paidAt: hoursFromNow(-1), reviewRequestSentAt: null }, now, 24)).toBe(false);
  });

  it("is not due for an unpaid invoice", () => {
    expect(isReviewRequestDue({ status: "sent", paidAt: null, reviewRequestSentAt: null }, now, 24)).toBe(false);
  });

  it("is not due once already sent", () => {
    expect(isReviewRequestDue({ status: "paid", paidAt: hoursFromNow(-25), reviewRequestSentAt: now }, now, 24)).toBe(false);
  });
});

describe("isMaintenanceReminderDue", () => {
  const monthsAgo = (m: number) => {
    const d = new Date(now);
    d.setMonth(d.getMonth() - m);
    return d;
  };

  it("is due once the interval has elapsed on a completed job", () => {
    expect(
      isMaintenanceReminderDue({ status: "completed", completedAt: monthsAgo(5), maintenanceReminderSentAt: null }, now, 4),
    ).toBe(true);
  });

  it("is not due before the interval elapses", () => {
    expect(
      isMaintenanceReminderDue({ status: "completed", completedAt: monthsAgo(1), maintenanceReminderSentAt: null }, now, 4),
    ).toBe(false);
  });

  it("is not due for a job that isn't completed", () => {
    expect(
      isMaintenanceReminderDue({ status: "in_progress", completedAt: monthsAgo(5), maintenanceReminderSentAt: null }, now, 4),
    ).toBe(false);
  });

  it("is not due once already sent", () => {
    expect(
      isMaintenanceReminderDue({ status: "completed", completedAt: monthsAgo(5), maintenanceReminderSentAt: now }, now, 4),
    ).toBe(false);
  });
});

describe("template delivery policy", () => {
  it("uses only the destination selected by the stored template channel", () => {
    expect(resolveTemplateDestination("email", { email: " owner@example.com ", phone: "+15551234567" })).toEqual({
      channel: "email",
      to: "owner@example.com",
    });
    expect(resolveTemplateDestination("sms", { email: "owner@example.com", phone: " +15551234567 " })).toEqual({
      channel: "sms",
      to: "+15551234567",
    });
    expect(resolveTemplateDestination("email", { phone: "+15551234567" })).toBeNull();
    expect(resolveTemplateDestination("sms", { email: "owner@example.com" })).toBeNull();
    expect(resolveTemplateDestination("push", { email: "owner@example.com" })).toBeNull();
  });

  it("retries provider failures but treats policy non-deliveries as handled", () => {
    expect(isTerminalTemplateDelivery({ sent: false, reason: "template_inactive" })).toBe(true);
    expect(isTerminalTemplateDelivery({ sent: false, reason: "no_destination", channel: "sms" })).toBe(true);
    expect(isTerminalTemplateDelivery({ sent: false, reason: "suppressed", channel: "email" })).toBe(true);
    expect(isTerminalTemplateDelivery({ sent: false, reason: "not_configured", channel: "email" })).toBe(false);
    expect(isTerminalTemplateDelivery({ sent: false, reason: "provider_error", channel: "sms" })).toBe(false);
  });
});
