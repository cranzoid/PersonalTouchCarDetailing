import { describe, expect, it } from "vitest";
import {
  computeLeadFunnel,
  computeResourceUtilization,
  getReportWindow,
  groupRevenueBySource,
  resolvePaymentSource,
  summarizeRevenue,
} from "../src/lib/reporting";

describe("summarizeRevenue", () => {
  it("counts succeeded cash in and subtracts succeeded refunds", () => {
    const result = summarizeRevenue([
      { kind: "payment", amountCents: 10_000, status: "succeeded" },
      { kind: "deposit", amountCents: 2_500, status: "succeeded" },
      { kind: "refund", amountCents: 3_000, status: "succeeded" },
      { kind: "payment", amountCents: 9_999, status: "failed" },
      { kind: "refund", amountCents: 500, status: "pending" },
    ]);

    expect(result).toEqual({
      grossCents: 12_500,
      refundCents: 3_000,
      netCents: 9_500,
      paymentCount: 2,
      refundCount: 1,
    });
  });

  it("groups source revenue after normalizing source names", () => {
    const grouped = groupRevenueBySource([
      { kind: "payment", amountCents: 8_000, status: "succeeded", source: "Google Ads" },
      { kind: "refund", amountCents: 1_000, status: "succeeded", source: "google-ads" },
      { kind: "payment", amountCents: 2_000, status: "succeeded", source: null },
    ]);

    expect(grouped).toEqual([
      {
        source: "google_ads",
        grossCents: 8_000,
        refundCents: 1_000,
        netCents: 7_000,
        paymentCount: 1,
        refundCount: 1,
      },
      {
        source: "unattributed",
        grossCents: 2_000,
        refundCents: 0,
        netCents: 2_000,
        paymentCount: 1,
        refundCount: 0,
      },
    ]);
  });
});

describe("resolvePaymentSource", () => {
  const context = {
    appointmentsById: new Map([
      ["apt_direct", { customerId: "cus_1", attribution: { source: "google_ads" } }],
      ["apt_invoice", { customerId: "cus_2", attribution: { source: "meta_ads" } }],
    ]),
    invoicesById: new Map([
      ["inv_1", { jobId: "job_1", customerId: "cus_2" }],
      ["inv_2", { jobId: null, customerId: "cus_3" }],
    ]),
    jobsById: new Map([
      ["job_1", { appointmentId: "apt_invoice", customerId: "cus_2" }],
    ]),
    customersById: new Map([
      ["cus_1", { sourceLeadId: "lead_1" }],
      ["cus_2", { sourceLeadId: null }],
      ["cus_3", { sourceLeadId: "lead_3" }],
    ]),
    leadsById: new Map([
      ["lead_1", { attribution: { source: "referral" } }],
      ["lead_3", { attribution: { utm: { utm_source: "newsletter" } } }],
    ]),
  };

  it("prefers appointment attribution, including invoice → job → appointment", () => {
    expect(
      resolvePaymentSource(
        { appointmentId: "apt_direct", invoiceId: null, customerId: "cus_1" },
        context,
      ),
    ).toBe("google_ads");
    expect(
      resolvePaymentSource(
        { appointmentId: null, invoiceId: "inv_1", customerId: null },
        context,
      ),
    ).toBe("meta_ads");
  });

  it("falls back to the originating lead through the customer", () => {
    expect(
      resolvePaymentSource(
        { appointmentId: null, invoiceId: "inv_2", customerId: null },
        context,
      ),
    ).toBe("newsletter");
  });
});

describe("computeLeadFunnel", () => {
  it("counts unique lead outcomes instead of repeat entities", () => {
    const funnel = computeLeadFunnel({
      leads: [
        { id: "lead_1", status: "qualified", convertedCustomerId: "cus_1" },
        { id: "lead_2", status: "qualified", convertedCustomerId: null },
        { id: "lead_3", status: "new", convertedCustomerId: null },
        { id: "lead_4", status: "lost", convertedCustomerId: null },
      ],
      quotes: [
        { id: "quote_1", leadId: "lead_1" },
        { id: "quote_2", leadId: "lead_2" },
      ],
      estimates: [
        { id: "estimate_1", quoteRequestId: "quote_1" },
        { id: "estimate_2", quoteRequestId: "quote_2" },
      ],
      customers: [
        { id: "cus_1", sourceLeadId: "lead_1" },
        { id: "cus_2", sourceLeadId: "lead_2" },
      ],
      appointments: [
        { id: "apt_1", customerId: "cus_1", estimateId: "estimate_1", status: "converted" },
        { id: "apt_1_repeat", customerId: "cus_1", estimateId: null, status: "confirmed" },
        { id: "apt_2", customerId: "cus_2", estimateId: "estimate_2", status: "completed" },
      ],
      jobs: [
        { appointmentId: "apt_1", status: "completed" },
        { appointmentId: "apt_2", status: "in_progress" },
      ],
    });

    expect(funnel.stages.map((stage) => stage.count)).toEqual([4, 2, 2, 2]);
    expect(funnel.quoteLeadCount).toBe(2);
    expect(funnel.estimatedLeadCount).toBe(2);
    expect(funnel.leadToBookingRate).toBe(0.5);
    expect(funnel.leadToCompletionRate).toBe(0.5);
  });
});

describe("computeResourceUtilization", () => {
  it("subtracts closures, ignores cancelled bookings, and reports unassigned time", () => {
    const window = {
      days: 1,
      start: new Date("2026-07-20T00:00:00.000Z"),
      end: new Date("2026-07-21T00:00:00.000Z"),
    };
    const result = computeResourceUtilization({
      window,
      timeZone: "UTC",
      resources: [
        { id: "bay_1", name: "Bay 1", type: "bay", active: true },
        { id: "bay_2", name: "Bay 2", type: "bay", active: true },
        { id: "old", name: "Old bay", type: "bay", active: false },
      ],
      businessHours: [
        { weekday: 1, open: "09:00", close: "17:00", closed: false },
      ],
      blocks: [
        {
          resourceId: "bay_1",
          staffUserId: null,
          startsAt: new Date("2026-07-20T12:00:00.000Z"),
          endsAt: new Date("2026-07-20T13:00:00.000Z"),
        },
      ],
      appointments: [
        {
          resourceId: "bay_1",
          status: "confirmed",
          startsAt: new Date("2026-07-20T10:00:00.000Z"),
          endsAt: new Date("2026-07-20T12:00:00.000Z"),
        },
        {
          resourceId: "bay_1",
          status: "cancelled",
          startsAt: new Date("2026-07-20T13:00:00.000Z"),
          endsAt: new Date("2026-07-20T15:00:00.000Z"),
        },
        {
          resourceId: "bay_2",
          status: "completed",
          startsAt: new Date("2026-07-20T09:00:00.000Z"),
          endsAt: new Date("2026-07-20T13:00:00.000Z"),
        },
        {
          resourceId: null,
          status: "pending",
          startsAt: new Date("2026-07-20T15:00:00.000Z"),
          endsAt: new Date("2026-07-20T16:00:00.000Z"),
        },
        {
          resourceId: null,
          status: "confirmed",
          startsAt: new Date("2026-07-20T15:30:00.000Z"),
          endsAt: new Date("2026-07-20T16:30:00.000Z"),
        },
      ],
    });

    expect(result.resources).toHaveLength(2);
    expect(result.resources[0]).toMatchObject({
      resourceId: "bay_2",
      bookedMinutes: 240,
      availableMinutes: 480,
      utilizationRate: 0.5,
    });
    expect(result.resources[1]).toMatchObject({
      resourceId: "bay_1",
      bookedMinutes: 120,
      availableMinutes: 420,
    });
    expect(result.bookedMinutes).toBe(360);
    expect(result.availableMinutes).toBe(900);
    expect(result.utilizationRate).toBe(0.4);
    expect(result.unassignedBookedMinutes).toBe(120);
  });
});

describe("getReportWindow", () => {
  it("uses whole business-local days", () => {
    const window = getReportWindow(
      7,
      "America/Toronto",
      new Date("2026-07-23T15:00:00.000Z"),
    );
    expect(window.start.toISOString()).toBe("2026-07-17T04:00:00.000Z");
    expect(window.end.toISOString()).toBe("2026-07-24T04:00:00.000Z");
  });
});
