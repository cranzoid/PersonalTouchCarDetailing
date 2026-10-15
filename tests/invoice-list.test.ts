import { describe, expect, it } from "vitest";
import {
  invoiceNumberFromQuery,
  parseInvoiceListParams,
  statusesForFilter,
} from "../src/lib/invoice-list";

describe("invoice list params", () => {
  it("defaults to all, no query, page 1", () => {
    expect(parseInvoiceListParams({})).toEqual({ filter: "all", q: "", page: 1 });
  });

  it("accepts real statuses and the unpaid group, rejects junk", () => {
    expect(parseInvoiceListParams({ status: "paid" }).filter).toBe("paid");
    expect(parseInvoiceListParams({ status: "unpaid" }).filter).toBe("unpaid");
    expect(parseInvoiceListParams({ status: "'; drop" }).filter).toBe("all");
  });

  it("clamps bad pages to 1", () => {
    expect(parseInvoiceListParams({ page: "-3" }).page).toBe(1);
    expect(parseInvoiceListParams({ page: "abc" }).page).toBe(1);
    expect(parseInvoiceListParams({ page: "4" }).page).toBe(4);
  });

  it("maps filters to statuses", () => {
    expect(statusesForFilter("all")).toBeNull();
    expect(statusesForFilter("overdue")).toEqual(["overdue"]);
    expect(statusesForFilter("unpaid")).toEqual(["sent", "partially_paid", "overdue"]);
  });

  it("reads invoice numbers from the query", () => {
    expect(invoiceNumberFromQuery("1042")).toBe(1042);
    expect(invoiceNumberFromQuery("INV-1042")).toBe(1042);
    expect(invoiceNumberFromQuery("smith")).toBeNull();
  });
});
