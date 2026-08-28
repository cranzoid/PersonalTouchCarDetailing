/**
 * The paper trail behind a number.
 *
 * Receipts reuse the `files` table rather than getting one of their own —
 * `entity_type` is free text by design (see the table's own note), so the only
 * thing a receipt needs is its own value there. That keeps one storage path,
 * one private-serving convention and one place where uploads are validated.
 *
 * `entity_type` is ALSO the access-control key: the serving route refuses to
 * hand back anything that is not this value, so nobody can reach a customer's
 * before-and-after photos through the expenses route or vice versa.
 *
 * These live outside actions.ts because a "use server" module may only export
 * async functions.
 */
export const RECEIPT_ENTITY_TYPE = "expense";

/**
 * PDFs are allowed alongside images: a hydro bill or a supplier invoice arrives
 * as a PDF far more often than as a photo, and a receipts feature that refused
 * them would send the owner back to a folder on the desktop.
 */
export const RECEIPT_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "application/pdf": "pdf",
};

export const RECEIPT_ACCEPT = Object.keys(RECEIPT_TYPES).join(",");
export const MAX_RECEIPT_BYTES = 10 * 1024 * 1024;
export const MAX_RECEIPTS_PER_UPLOAD = 10;

export type ExpenseReceipt = {
  id: string;
  contentType: string;
  sizeBytes: number;
  createdAt: string;
};

/** Where a receipt is fetched from. Gated on `manage_expenses`, not on
 * `view_private_files` — see the route for why the two must differ. */
export function receiptUrl(fileId: string): string {
  return `/api/expense-receipts/${fileId}`;
}

export function isReceiptImage(contentType: string): boolean {
  return contentType.startsWith("image/");
}
