import { INVOICE_STATUSES, type InvoiceStatus } from "@/lib/types";

export const INVOICE_PAGE_SIZE = 50;

/** Invoices still waiting on money — the view staff chase. */
export const UNPAID_STATUSES: InvoiceStatus[] = ["sent", "partially_paid", "overdue"];

export type InvoiceFilter = "all" | "unpaid" | InvoiceStatus;

export interface InvoiceListParams {
  filter: InvoiceFilter;
  q: string;
  page: number;
}

/** Turns raw URL params into safe values; anything unrecognised falls back to the default. */
export function parseInvoiceListParams(raw: {
  status?: string;
  q?: string;
  page?: string;
}): InvoiceListParams {
  const status = raw.status ?? "all";
  const filter: InvoiceFilter =
    status === "unpaid" || (INVOICE_STATUSES as readonly string[]).includes(status)
      ? (status as InvoiceFilter)
      : "all";
  const page = Number.parseInt(raw.page ?? "1", 10);
  return {
    filter,
    q: (raw.q ?? "").trim().slice(0, 100),
    page: Number.isFinite(page) && page > 0 ? page : 1,
  };
}

/** Statuses a filter matches, or null for "all". */
export function statusesForFilter(filter: InvoiceFilter): InvoiceStatus[] | null {
  if (filter === "all") return null;
  if (filter === "unpaid") return UNPAID_STATUSES;
  return [filter];
}

/** Digits in the query ("INV-1042", "1042") as an invoice number, else null. */
export function invoiceNumberFromQuery(q: string): number | null {
  const m = /^(?:inv[-\s]?)?(\d{1,9})$/i.exec(q.trim());
  return m ? Number.parseInt(m[1], 10) : null;
}
